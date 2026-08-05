//! The Node-API surface riptide's renderer talks to.
//!
//! Seven functions, one process-global trace. Every buffer handed to JS is copied
//! into a V8-owned `ArrayBuffer`: Electron's memory cage rejects a backing store
//! outside it, and the renderer keeps typed-array views alive well past the call
//! that produced them.

use std::cell::RefCell;
use std::path::Path;

use napi::ScopedTask;
use napi::bindgen_prelude::*;
use napi::sys;
use napi_derive::napi;
use tide_core::Samples;
use tide_core::metadata::{Id, Timestamp};

pub mod design;
pub mod hierarchy;
pub mod label;
pub mod pack;
pub mod search;
pub mod segments;
pub mod trace;

use hierarchy::Node;
use label::{EnumEntry, Radix};
use pack::{ClockPolarity, PackKind, PackOpts};
use segments::Scene;
use trace::Loaded;

// ---- the current trace ---------------------------------------------------

// Node-API callbacks all run on the JS thread, so the trace lives in thread
// local storage rather than behind a lock. Nothing borrowed from it escapes a
// call: every read is copied into the ArrayBuffer before returning.
thread_local! {
    static CURRENT: RefCell<Option<Loaded>> = const { RefCell::new(None) };
}

/// Runs `f` over the loaded trace, or reports that nothing is open yet.
fn with_trace<T>(f: impl FnOnce(&Loaded) -> Result<T>) -> Result<T> {
    CURRENT.with_borrow(|current| match current {
        Some(loaded) => f(loaded),
        None => Err(Error::new(
            Status::GenericFailure,
            "no trace is open: call loadVcd first",
        )),
    })
}

// ---- value marshalling ---------------------------------------------------

/// Copies `bytes` into a fresh V8-owned `ArrayBuffer`.
///
/// Deliberately the raw Node-API call rather than `ArrayBuffer::from_data`: that
/// one asks for an external buffer first and only copies because Electron
/// refuses, which would silently become zero-copy anywhere else. napi 3.12's
/// `ArrayBuffer::copy_from` allocates but never copies, so it is unusable.
fn array_buffer<'e>(env: &Env, bytes: &[u8]) -> Result<ArrayBuffer<'e>> {
    let mut data = std::ptr::null_mut();
    let mut value = std::ptr::null_mut();
    unsafe {
        let status = sys::napi_create_arraybuffer(env.raw(), bytes.len(), &mut data, &mut value);
        if status != sys::Status::napi_ok {
            return Err(Error::new(
                Status::GenericFailure,
                format!("could not allocate a {} byte ArrayBuffer", bytes.len()),
            ));
        }
        if !bytes.is_empty() {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), data.cast::<u8>(), bytes.len());
        }
        ArrayBuffer::from_napi_value(env.raw(), value)
    }
}

/// A JS number as a tick. Ticks are `u64` in tide and exact to 2^53 in JS, which
/// covers every realistic timestamp; a negative one clamps to the start.
fn tick(value: f64) -> Timestamp {
    if value <= 0.0 { 0 } else { value as Timestamp }
}

/// A signal handle as the renderer carries it. Ids exceed JS's exact integer
/// range, so they cross as decimal strings. Anything unparseable becomes the
/// reserved zero id, which no signal has, so it reads as an absent signal rather
/// than an error.
fn handle(text: &str) -> Id {
    Id(text.parse().unwrap_or(0))
}

// ---- loadVcd -------------------------------------------------------------

/// Parses `path` and makes it the current trace.
///
/// The swap happens only on success, so a bad open leaves the trace already on
/// screen intact and queryable.
#[napi(js_name = "loadVcd")]
pub fn load_vcd(path: String) -> Result<()> {
    let loaded = trace::open(Path::new(&path)).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("loadVcd failed for '{path}': {error}"),
        )
    })?;
    CURRENT.set(Some(loaded));
    Ok(())
}

// ---- getMockSegments -----------------------------------------------------

/// One row's worth of packing instructions, as `scene.ts` builds them.
///
/// The optional fields are doubly wrapped on purpose. `#[napi(object)]` reads an
/// `Option<T>` field with `Object::get::<T>`, which treats only a *missing or
/// undefined* property as absent and hands an explicit `null` straight to `T`'s
/// conversion — so `Option<String>` rejects `muteHandle: null`, which is exactly
/// what the renderer sends for an ungated row. The outer `Option` is "was the key
/// there", the inner one "was it non-null"; callers `.flatten()` and get the
/// tolerant behaviour the Zig addon had.
#[napi(object)]
pub struct PackSpec {
    pub row: u32,
    pub handle: String,
    /// `"clk"` draws a clock; anything else draws data.
    pub kind: String,
    pub shaded: bool,
    /// A signal gating this row, or null/absent for none.
    pub mute_handle: Option<Option<String>>,
    /// Which clock edges get a chevron. Defaults to rising.
    pub polarity: Option<Option<String>>,
    /// How to format the value label. Defaults to binary, which is unlabeled.
    pub radix: Option<Option<String>>,
    pub enums: Option<Option<Vec<EnumSpec>>>,
}

/// One entry of a row's integer to name table.
#[napi(object)]
pub struct EnumSpec {
    pub value: u32,
    pub label: String,
}

/// The GPU-ready scene. Every buffer is raw bytes; the renderer wraps them in
/// typed arrays and uploads them unchanged.
#[napi(object)]
pub struct MockSegments<'a> {
    /// `multi_count` records of 12 bytes: pill segments.
    pub multi: ArrayBuffer<'a>,
    pub multi_count: u32,
    /// `single_count` records of 12 bytes: line segments.
    pub single: ArrayBuffer<'a>,
    pub single_count: u32,
    /// `row_count` records of 28 bytes.
    pub row_info: ArrayBuffer<'a>,
    pub row_count: u32,
    /// Byte-strided sample planes, padded to a four-byte multiple.
    pub x0_pool: ArrayBuffer<'a>,
    pub x1_pool: ArrayBuffer<'a>,
    /// Pill labels: `multi_count + 1` prefix offsets into the byte blob.
    pub label_bytes: ArrayBuffer<'a>,
    pub label_offsets: ArrayBuffer<'a>,
    /// Line labels, `single_count + 1` offsets. Empty for every row but boolean.
    pub single_label_bytes: ArrayBuffer<'a>,
    pub single_label_offsets: ArrayBuffer<'a>,
    /// The trace's end, not the window's.
    pub end_ticks: f64,
}

/// Packs every active row over the tick window `[q_start, q_end]`.
///
/// The window is the visible viewport plus the renderer's over-fetch margin, and
/// the result is ephemeral: a pan that leaves the packed range repacks. Cost is
/// proportional to the window, since the query is a binary search that also
/// returns the sample active at its left edge, so the offscreen-left segment is
/// drawn exactly as a full-range pack would draw it.
#[napi(js_name = "getMockSegments")]
pub fn get_mock_segments(
    env: &Env,
    specs: Vec<PackSpec>,
    q_start: f64,
    q_end: f64,
) -> Result<MockSegments<'_>> {
    with_trace(|loaded| {
        let end_t = loaded.end_t;
        let q_end = tick(q_end).min(end_t);
        let q_start = tick(q_start).min(q_end);

        let mut scene = Scene::new();
        for spec in &specs {
            let enums: Vec<EnumEntry> = spec
                .enums
                .iter()
                .flatten()
                .flatten()
                .map(|entry| EnumEntry {
                    value: entry.value,
                    label: entry.label.clone(),
                })
                .collect();
            let text = |field: &Option<Option<String>>| field.clone().flatten();

            let opts = PackOpts {
                shaded: spec.shaded,
                end_t,
                kind: if spec.kind == "clk" {
                    PackKind::Clk
                } else {
                    PackKind::Data
                },
                polarity: text(&spec.polarity)
                    .map_or(ClockPolarity::Rising, |name| ClockPolarity::parse(&name)),
                mute: text(&spec.mute_handle).map(|name| handle(&name)),
                q_start,
                q_end,
                radix: text(&spec.radix).map_or(Radix::Bin, |name| Radix::parse(&name)),
                enums: &enums,
            };

            let packed = pack::pack_signal(&loaded.trace.db, handle(&spec.handle), &opts);
            scene.push_packed_signal(spec.row, &packed);
        }

        let finalized = scene.finalize();
        Ok(MockSegments {
            multi: array_buffer(env, segments::segment_bytes(&scene.multi))?,
            multi_count: scene.multi.len() as u32,
            single: array_buffer(env, segments::segment_bytes(&scene.single))?,
            single_count: scene.single.len() as u32,
            row_info: array_buffer(env, segments::row_info_bytes(&finalized.row_infos))?,
            row_count: finalized.row_infos.len() as u32,
            x0_pool: array_buffer(env, &finalized.x0_pool)?,
            x1_pool: array_buffer(env, &finalized.x1_pool)?,
            label_bytes: array_buffer(env, &scene.multi_label_bytes)?,
            label_offsets: array_buffer(env, segments::word_bytes(&scene.multi_label_offsets))?,
            single_label_bytes: array_buffer(env, &scene.single_label_bytes)?,
            single_label_offsets: array_buffer(
                env,
                segments::word_bytes(&scene.single_label_offsets),
            )?,
            end_ticks: end_t as f64,
        })
    })
}

// ---- getValueAt ----------------------------------------------------------

/// A value as little-endian 32-bit words, one array per plane.
///
/// `lsb` is the value with every unknown bit read as zero, `msb` marks the
/// unknown bits, and `z` says which of those are high impedance rather than x —
/// the same split the GPU pools carry, plus the third plane the GPU has no use
/// for. The field names predate the split and are kept so the renderer's
/// formatter and the differential harness keep addressing planes the same way.
#[napi(object)]
pub struct ValueWords {
    pub lsb: Vec<u32>,
    pub msb: Vec<u32>,
    pub z: Vec<u32>,
}

/// The value of `handle` at `tick`, or null when the signal is unknown or has no
/// sample at or before it.
///
/// The word-array shape is the CPU value path's own, independent of the GPU
/// pools: `wave/value.ts` formats from it for the active-signal value column.
#[napi(js_name = "getValueAt")]
pub fn get_value_at(handle_text: String, at: f64) -> Result<Option<ValueWords>> {
    with_trace(|loaded| {
        let words = pack::with_value_at(
            &loaded.trace.db,
            handle(&handle_text),
            tick(at),
            |sample, width| {
                let count = segments::words_per_sample(width) as usize;
                ValueWords {
                    lsb: to_words(sample.min, None, count),
                    // The unknown mask is min ^ max, folded into the word
                    // assembly rather than materialized: this runs once per row
                    // per cursor move, and millions of times in the differential.
                    msb: to_words(sample.min, Some(sample.max), count),
                    z: to_words(sample.z, None, count),
                }
            },
        );
        Ok(words)
    })
}

/// A byte plane as `count` little-endian words, zero-padded past its end and
/// optionally XOR'd with a second plane.
fn to_words(bytes: &[u8], xor_with: Option<&[u8]>, count: usize) -> Vec<u32> {
    let byte_at = |index: usize| {
        let left = bytes.get(index).copied().unwrap_or(0);
        let right = xor_with.map_or(0, |plane| plane.get(index).copied().unwrap_or(0));
        left ^ right
    };
    (0..count)
        .map(|word| {
            let mut value = 0;
            for byte in 0..4 {
                value |= u32::from(byte_at(word * 4 + byte)) << (byte * 8);
            }
            value
        })
        .collect()
}

// ---- getEdges ------------------------------------------------------------

/// Up to `count` transitions, as parallel arrays.
#[napi(object)]
pub struct Edges<'a> {
    /// One f64 per transition, exact over the whole realistic tick range.
    pub ticks: ArrayBuffer<'a>,
    /// The low byte of each transition's x0 plane.
    pub lsb: ArrayBuffer<'a>,
    /// The low byte of each transition's x1 plane.
    pub msb: ArrayBuffer<'a>,
    pub count: u32,
}

/// Up to `count` transitions of `handle` at or after `start`.
///
/// A cheap prefix read, for clock period and phase detection and for
/// transition-to-transition navigation. The first entry is the sample *active* at
/// `start`, so its tick may precede it — `WavesToolbar`'s previous-transition
/// jump is built on that. Only the low byte of the value plane and the unknown
/// mask comes back, which is all a one-bit clock or reset needs.
#[napi(js_name = "getEdges")]
pub fn get_edges(
    env: &Env,
    handle_text: String,
    start: f64,
    count: u32,
) -> Result<Option<Edges<'_>>> {
    with_trace(|loaded| {
        let Some(mut cursor) =
            loaded
                .trace
                .db
                .samples(handle(&handle_text), tick(start), Timestamp::MAX)
        else {
            return Ok(None);
        };
        let bytes = cursor.ty().bytes();
        let Some(chunk) = cursor.next_chunk() else {
            return Ok(None);
        };

        let n = chunk.len().min(count as usize);
        let (mins, maxes, _) = chunk.planes();
        let ticks: Vec<f64> = chunk.times()[..n].iter().map(|&t| t as f64).collect();
        let lsb: Vec<u8> = (0..n).map(|i| mins[i * bytes]).collect();
        let msb: Vec<u8> = (0..n).map(|i| mins[i * bytes] ^ maxes[i * bytes]).collect();

        Ok(Some(Edges {
            ticks: array_buffer(env, f64_bytes(&ticks))?,
            lsb: array_buffer(env, &lsb)?,
            msb: array_buffer(env, &msb)?,
            count: n as u32,
        }))
    })
}

fn f64_bytes(values: &[f64]) -> &[u8] {
    // SAFETY: f64 has no padding and every bit pattern is a valid u8.
    unsafe { std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), size_of_val(values)) }
}

// ---- getHierarchy --------------------------------------------------------

/// The scope tree, the timescale and the trace's end.
///
/// Built as a plain object rather than a typed struct because a node is a
/// discriminated union: a scope carries `scopeType` and `children`, a signal
/// carries `varType`, `bitWidth`, `handle` and `supported`, and the renderer
/// A `SourceLoc` as the renderer declares it: an absolute path plus a 1-based line.
fn source_loc<'a>(env: &'a Env, loc: &crate::design::Loc) -> Result<Object<'a>> {
    let mut object = Object::new(env)?;
    object.set("file", loc.file.as_str())?;
    object.set("line", loc.line)?;
    Ok(object)
}

/// switches on `kind`.
#[napi(js_name = "getHierarchy")]
pub fn get_hierarchy(env: &Env) -> Result<Object<'_>> {
    with_trace(|loaded| {
        let flat = &loaded.hierarchy;

        let mut nodes = Vec::with_capacity(flat.nodes.len());
        for (index, node) in flat.nodes.iter().enumerate() {
            let mut object = Object::new(env)?;
            object.set("id", index as u32)?;
            match node.parent() {
                Some(parent) => object.set("parent", parent)?,
                None => object.set("parent", Null)?,
            }
            object.set("name", node.name())?;
            match node {
                Node::Scope { kind, children, facts, .. } => {
                    object.set("kind", "scope")?;
                    object.set("scopeType", *kind)?;
                    object.set("children", children.clone())?;
                    if let Some(facts) = facts {
                        if let Some(loc) = &facts.decl {
                            object.set("declSourceLoc", source_loc(env, loc)?)?;
                        }
                        if let Some(loc) = &facts.inst {
                            object.set("instSourceLoc", source_loc(env, loc)?)?;
                        }
                        if let Some(comment) = &facts.comment {
                            object.set("comment", comment.as_str())?;
                        }
                    }
                }
                Node::Signal {
                    var_type,
                    bit_width,
                    handle,
                    supported,
                    facts,
                    ..
                } => {
                    object.set("kind", "signal")?;
                    object.set("varType", *var_type)?;
                    // VCD's $var lines carry no port direction, so without source
                    // debug info every signal reports the implicit one.
                    object.set(
                        "direction",
                        facts.as_ref().and_then(|f| f.direction).unwrap_or("implicit"),
                    )?;
                    object.set("bitWidth", *bit_width)?;
                    object.set("handle", handle.to_string())?;
                    object.set("supported", *supported)?;
                    if let Some(facts) = facts {
                        if let Some(name) = &facts.type_name {
                            object.set("typeName", name.as_str())?;
                        }
                        if let Some((msb, lsb)) = facts.range {
                            let mut range = Object::new(env)?;
                            range.set("msb", msb as i32)?;
                            range.set("lsb", lsb as i32)?;
                            object.set("range", range)?;
                        }
                        if let Some(id) = facts.enum_type {
                            object.set("enumTypeId", id)?;
                        }
                        if let Some(loc) = &facts.decl {
                            object.set("sourceLoc", source_loc(env, loc)?)?;
                        }
                        if let Some(comment) = &facts.comment {
                            object.set("comment", comment.as_str())?;
                        }
                        // Producer's suggestion, not a decision: the renderer applies
                        // it only where a view sidecar has not already spoken.
                        if let Some(role) = facts.role {
                            object.set("hintRole", role)?;
                        }
                    }
                }
            }
            nodes.push(object);
        }

        let mut timescale = Object::new(env)?;
        timescale.set("value", loaded.timescale_value)?;
        timescale.set("unit", loaded.timescale_unit)?;

        // Enum int->label tables, in the renderer's `EnumType` shape. Empty
        // without an SDI beside the trace, which is what the VCD alone can say.
        let mut enums = Vec::with_capacity(flat.enums.len());
        for table in &flat.enums {
            let mut object = Object::new(env)?;
            object.set("id", table.id)?;
            object.set("name", table.name.as_str())?;
            let mut members = Vec::with_capacity(table.members.len());
            for (raw, label) in &table.members {
                let mut member = Object::new(env)?;
                member.set("raw", raw.as_str())?;
                member.set("label", label.as_str())?;
                members.push(member);
            }
            object.set("members", members)?;
            enums.push(object);
        }

        let mut root = Object::new(env)?;
        root.set("rootIds", flat.root_ids.clone())?;
        root.set("nodes", nodes)?;
        root.set("enumTypes", enums)?;
        root.set("timescale", timescale)?;
        root.set("endTicks", loaded.end_t as f64)?;
        Ok(root)
    })
}

// ---- searchTree / markStrings ---------------------------------------------

/// The signal tree, pruned to what a query matched.
///
/// Parallel arrays, one entry per visible row, in tree order: everything that
/// matched plus the scopes above it, which the tree renders opened. Row `i` is
/// node `ids[i]`, nested `depths[i]` deep, and `matched[i]` says whether it
/// matched itself or is only a scope on the way to one.
#[napi(object)]
pub struct TreeRows<'a> {
    /// One u32 per row: a node id from the array `getHierarchy` returned.
    pub ids: ArrayBuffer<'a>,
    /// One u32 per row.
    pub depths: ArrayBuffer<'a>,
    /// One byte per row, 1 when the row matched the query itself.
    pub matched: ArrayBuffer<'a>,
    /// How many rows matched, for the "n matches" hint.
    pub total: u32,
}

/// Match flags and highlight offsets for a caller-supplied candidate list.
///
/// One entry per candidate, in the order they were handed over. `matched` is
/// every query term matching; `ranges` is a flat run of `(start, len)` pairs in
/// UTF-16 units for the terms that *did* match, grouped by `range_counts`;
/// `leaf_offsets` is where each candidate's last path segment begins, so a
/// consumer rendering only the leaf name keeps the ranges at or past it and
/// shifts them down by it.
#[napi(object)]
pub struct StringMarks<'a> {
    pub matched: ArrayBuffer<'a>,
    pub ranges: ArrayBuffer<'a>,
    pub range_counts: ArrayBuffer<'a>,
    pub leaf_offsets: ArrayBuffer<'a>,
}

fn u32_bytes(values: &[u32]) -> &[u8] {
    // SAFETY: u32 has no padding and every bit pattern is a valid u8.
    unsafe { std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), size_of_val(values)) }
}

/// The tree filter, off the JS thread.
///
/// Holds the flattened tree by `Arc`: it is immutable, so the worker needs no
/// lock, and an in-flight search survives a trace swap — it finishes against the
/// tree it started on and the renderer drops the result as stale.
pub struct SearchTask {
    tree: std::sync::Arc<hierarchy::Flat>,
    query: String,
}

impl<'task> ScopedTask<'task> for SearchTask {
    type Output = Vec<hierarchy::Row>;
    type JsValue = TreeRows<'task>;

    fn compute(&mut self) -> Result<Vec<hierarchy::Row>> {
        let matched = self.tree.search.matches(&self.query);
        Ok(self.tree.prune(&matched))
    }

    fn resolve(&mut self, env: &'task Env, rows: Vec<hierarchy::Row>) -> Result<TreeRows<'task>> {
        let ids: Vec<u32> = rows.iter().map(|row| row.id).collect();
        let depths: Vec<u32> = rows.iter().map(|row| row.depth).collect();
        let matched: Vec<u8> = rows.iter().map(|row| u8::from(row.matched)).collect();
        Ok(TreeRows {
            total: matched.iter().map(|&flag| u32::from(flag)).sum(),
            ids: array_buffer(env, u32_bytes(&ids))?,
            depths: array_buffer(env, u32_bytes(&depths))?,
            matched: array_buffer(env, &matched)?,
        })
    }
}

/// The hierarchy pruned to `query`: every node whose dot path matches, plus the
/// scopes above them.
///
/// Resolves a promise. The scan and the prune are each linear in the hierarchy,
/// which is unbounded, and they run on a keystroke — so they stay off the thread
/// driving the render loop. A blank query matches nothing, so the caller shows the
/// unfiltered tree rather than asking.
#[napi(js_name = "searchTree", ts_return_type = "Promise<TreeRows>")]
pub fn search_tree(query: String) -> Result<AsyncTask<SearchTask>> {
    let tree = with_trace(|loaded| Ok(loaded.hierarchy.clone()))?;
    Ok(AsyncTask::new(SearchTask { tree, query }))
}

/// The same matcher over a caller-supplied candidate list.
///
/// Synchronous on purpose: the caller bounds the list — the active rows, or the
/// handful of tree rows actually on screen — and a promise per keystroke would
/// only add latency to work measured in microseconds. It also takes strings
/// rather than node ids because not every candidate is a node: an active row may
/// be a derived signal, and a tree row is highlighted against its own name.
#[napi(js_name = "markStrings")]
pub fn mark_strings(env: &Env, candidates: Vec<String>, query: String) -> Result<StringMarks<'_>> {
    let marks = search::Index::of_strings(&candidates).marks(&query);
    Ok(StringMarks {
        matched: array_buffer(env, &marks.matched)?,
        ranges: array_buffer(env, u32_bytes(&marks.ranges))?,
        range_counts: array_buffer(env, u32_bytes(&marks.range_counts))?,
        leaf_offsets: array_buffer(env, u32_bytes(&marks.leaf_offsets))?,
    })
}
