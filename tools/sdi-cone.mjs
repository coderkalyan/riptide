#!/usr/bin/env node
// Reference consumer for the Riptide SDI format (docs/sdi.md, docs/sdi.schema.json).
//
// Not part of the app. It exists to prove the schema carries enough information to
// (a) elaborate a typed signal tree and bind it to a trace, (b) list every site that
// writes or reads a signal, and (c) compute a static cone of influence. If a future
// schema change breaks one of those, this tool breaks first.
//
//   node tools/sdi-cone.mjs <file.sdi.json> tree
//   node tools/sdi-cone.mjs <file.sdi.json> check [trace.vcd]
//   node tools/sdi-cone.mjs <file.sdi.json> info     <path>
//   node tools/sdi-cone.mjs <file.sdi.json> drivers  <path>
//   node tools/sdi-cone.mjs <file.sdi.json> readers  <path>
//   node tools/sdi-cone.mjs <file.sdi.json> cone     <path> [--data] [--cross-seq] [--depth N]
//   node tools/sdi-cone.mjs <file.sdi.json> fanout   <path> [--data] [--cross-seq] [--depth N]
//
// `path` is a trace path (`tb.dut.g_lane[0].u_lane.state`) or a design path without
// the root prefix (`dut.g_lane[0].u_lane.state`).

import { readFileSync } from "node:fs";
import { basename } from "node:path";

// ---------------------------------------------------------------- model helpers

const BLOCK_KINDS = new Set([
  "genBlock", "block", "function", "task", "structScope", "arrayScope",
]);

function loadSdi(path) {
  const sdi = JSON.parse(readFileSync(path, "utf8"));
  if (sdi.version !== 1) throw new Error(`unsupported SDI version ${sdi.version}`);
  return sdi;
}

const unitOf = (sdi, i) => sdi.units[i];
const typeOf = (sdi, i) => sdi.types[i];

/** Total flattened bit width of a type, or null when it has none. */
function widthOf(sdi, typeIdx) {
  const t = typeOf(sdi, typeIdx);
  if (t.width !== undefined) return t.width;
  if (t.kind === "alias") return widthOf(sdi, t.target);
  return null;
}

/** Declared packed range of a type, for the `name[msb:lsb]` trace spelling. */
function declRange(sdi, typeIdx) {
  const t = typeOf(sdi, typeIdx);
  if (t.range) return t.range;
  if (t.kind === "alias") return declRange(sdi, t.target);
  const w = widthOf(sdi, typeIdx);
  return w !== null && w > 1 ? [w - 1, 0] : null;
}

function typeSpelling(sdi, typeIdx) {
  const t = typeOf(sdi, typeIdx);
  return t.spelling ?? t.name ?? t.keyword ?? t.kind;
}

function spanText(sdi, span) {
  if (!span) return "?";
  const file = sdi.files[span[0]];
  const name = file ? basename(file.path) : `file${span[0]}`;
  const [, line, col] = span;
  return col ? `${name}:${line}:${col}` : `${name}:${line}`;
}

// ------------------------------------------------------------ bit-range algebra
// A slice is [lsb, width]; `null` means the whole variable. A zero-width slice is
// legal — a void- or unit-typed signal carries no bits but still participates in
// dataflow — so it constrains nothing and matches like a whole-variable reference.
// Dropping such an edge would silently delete a real dependency.

function overlaps(a, b) {
  if (!a || !b) return true;
  if (a[1] === 0 || b[1] === 0) return true;
  return a[0] < b[0] + b[1] && b[0] < a[0] + a[1];
}

function sliceKey(s) {
  return s ? `${s[0]}:${s[1]}` : "*";
}

// -------------------------------------------------------------- elaboration
// A scope is one node of the elaborated tree. Scopes are built lazily from the
// unit graph, so file size tracks design source while the tree tracks instances.

function elaborate(sdi) {
  const prefix = sdi.trace?.rootPrefix ? [sdi.trace.rootPrefix] : [];
  const sep = sdi.trace?.separator ?? ".";
  const scopes = new Map(); // path string -> scope
  const roots = [];

  const mkScope = (name, unit, parent, inst, pathParts) => {
    const scope = {
      name,
      unit,                       // unit index, or null for a black box
      parent,                     // parent scope, or null
      inst,                       // the `instance` record that created it, or null
      pathParts,                  // trace path components (inlined scopes contribute none)
      path: pathParts.join(sep),
      children: [],
      kind: unit !== null ? unitOf(sdi, unit).kind : "blackBox",
    };
    scopes.set(scope.path + sep + name, scope);
    return scope;
  };

  const build = (name, unitIdx, parent, inst, parentParts) => {
    const parts = inst?.inlined ? parentParts.slice() : [...parentParts, name];
    const scope = {
      name, unit: unitIdx, parent, inst,
      pathParts: parts,
      path: parts.join(sep),
      children: [],
      kind: unitIdx !== null ? unitOf(sdi, unitIdx).kind : "blackBox",
    };
    // An inlined scope shares its parent's path; key it uniquely so lookups still work.
    const key = inst?.inlined ? `${scope.path}${sep}<${name}>` : scope.path;
    scopes.set(key, scope);
    if (!inst?.inlined) scopes.set(scope.path, scope);
    if (unitIdx !== null) {
      for (const child of unitOf(sdi, unitIdx).instances ?? []) {
        const kids = child.array
          ? rangeIndices(child.array).map((i) => `${child.name}[${i}]`)
          : [child.name];
        for (const kidName of kids) {
          scope.children.push(build(kidName, child.unit ?? null, scope, child, parts));
        }
      }
    }
    return scope;
  };

  for (const root of sdi.design.roots) {
    roots.push(build(root.name, root.unit, null, null, prefix));
  }
  return { roots, scopes, sep };
}

function rangeIndices([l, r]) {
  const out = [];
  const step = l <= r ? 1 : -1;
  for (let i = l; ; i += step) { out.push(i); if (i === r) break; }
  return out;
}

/** Walk up `up` block-like scopes. Returns null when a module boundary blocks it. */
function upScope(scope, up) {
  let s = scope;
  for (let i = 0; i < (up ?? 0); i++) {
    if (!BLOCK_KINDS.has(s.kind) || !s.parent) return null;
    s = s.parent;
  }
  return s;
}

// -------------------------------------------------------------- trace binding
// Resolution order, per docs/sdi.md: explicit traceName, then the bare name, then
// the two `name[msb:lsb]` spellings a VCD writer may produce.

function traceCandidates(sdi, v) {
  if (v.traceName) return [v.traceName];
  const out = [v.name];
  if (sdi.trace?.rangeInName) {
    const r = declRange(sdi, v.type);
    if (r) out.push(`${v.name}[${r[0]}:${r[1]}]`, `${v.name} [${r[0]}:${r[1]}]`);
  }
  return out;
}

function tracePaths(sdi, scope, v) {
  const sep = sdi.trace?.separator ?? ".";
  const base = scope.pathParts.join(sep);
  const pfx = scope.inst?.inlined ? (scope.inst.tracePrefix ?? "") : "";
  if (v.traceSignals) {
    return v.traceSignals.map((ts) => ({
      path: base + sep + pfx + ts.path, bits: ts.bits ?? null, member: ts.member,
    }));
  }
  return traceCandidates(sdi, v).map((leaf) => ({ path: base + sep + pfx + leaf, bits: null }));
}

// -------------------------------------------------------------- signal lookup

/** Find (scope, varIdx) for a path, tolerating a missing root prefix. */
function findSignal(sdi, el, query) {
  const sep = el.sep;
  const attempts = [query];
  if (sdi.trace?.rootPrefix && !query.startsWith(sdi.trace.rootPrefix + sep)) {
    attempts.push(sdi.trace.rootPrefix + sep + query);
  }
  for (const q of attempts) {
    const cut = q.lastIndexOf(sep);
    if (cut < 0) continue;
    const scopePath = q.slice(0, cut);
    const leaf = q.slice(cut + 1);
    const scope = el.scopes.get(scopePath);
    if (!scope || scope.unit === null) continue;
    const vars = unitOf(sdi, scope.unit).vars ?? [];
    for (let i = 0; i < vars.length; i++) {
      if (vars[i].name === leaf || traceCandidates(sdi, vars[i]).includes(leaf)) {
        return { scope, varIdx: i, var: vars[i] };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ ref resolve

/** Resolve a `ref` in the context of `scope` to a concrete signal node. */
function resolveRef(sdi, el, scope, ref) {
  if (ref.xmr !== undefined) {
    const abs = ref.xmr.startsWith(".")
      ? scope.pathParts.join(el.sep) + ref.xmr
      : (sdi.trace?.rootPrefix ? sdi.trace.rootPrefix + el.sep + ref.xmr : ref.xmr);
    const hit = findSignal(sdi, el, abs);
    if (!hit) return { unresolved: ref.xmr };
    return { scope: hit.scope, varIdx: hit.varIdx, bits: ref.bits ?? null, role: ref.role, dynamic: ref.dynamic };
  }
  const home = upScope(scope, ref.up);
  if (!home || home.unit === null) return { unresolved: `up:${ref.up ?? 0}` };
  if (ref.inst !== undefined) {
    const inst = (unitOf(sdi, home.unit).instances ?? [])[ref.inst];
    const child = home.children.find((c) => c.inst === inst);
    if (!child || child.unit === null) return { unresolved: `inst:${ref.inst}` };
    const portVar = (unitOf(sdi, child.unit).ports ?? [])[ref.port];
    if (portVar === undefined) return { unresolved: `port:${ref.port}` };
    return { scope: child, varIdx: portVar, bits: ref.bits ?? null, role: ref.role, dynamic: ref.dynamic };
  }
  return { scope: home, varIdx: ref.var, bits: ref.bits ?? null, role: ref.role, dynamic: ref.dynamic };
}

const nodeKey = (n) => `${n.scope.path}#${n.varIdx}#${sliceKey(n.bits)}`;
const nodeName = (sdi, n) => {
  const v = unitOf(sdi, n.scope.unit).vars[n.varIdx];
  const bits = !n.bits ? "" : n.bits[1] === 0 ? "[]" : `[${n.bits[0] + n.bits[1] - 1}:${n.bits[0]}]`;
  return `${n.scope.path}.${v.name}${bits}`;
};

// ------------------------------------------------------- writers, readers, edges
// Built once over the whole elaborated tree. A per-scope search would be wrong:
// a reference inside a generate or named block reaches up into the module around
// it (`up`), so the site that writes `gate.lane_out` lives in `gate.g_lane[0]`.
// Resolving every ref to its home node and indexing by that node is both correct
// and the shape a viewer wants — one pass at load, O(1) per query afterwards.

function isSequential(proc) {
  if (proc.kind === "alwaysFF" || proc.kind === "alwaysLatch") return true;
  return (proc.sense ?? []).some((s) => s.edge === "pos" || s.edge === "neg");
}

const siteKey = (n) => `${n.scope.path}#${n.varIdx}`;

function buildSites(sdi, el) {
  const writes = new Map(); // "scope#var" -> [site]
  const reads = new Map();
  const push = (map, node, site) => {
    if (!node || node.unresolved || node.scope.unit === null) return;
    const key = siteKey(node);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ ...site, at: node });
  };

  for (const [key, scope] of el.scopes) {
    if (scope.unit === null || key !== scope.path) continue; // one visit per scope
    const unit = unitOf(sdi, scope.unit);
    const rr = (ref) => ({ ...resolveRef(sdi, el, scope, ref), role: ref.role ?? "data" });

    for (const proc of unit.processes ?? []) {
      const seqProc = isSequential(proc);
      const sense = (proc.sense ?? []).map((s) => ({ ...rr(s.ref), role: s.role ?? "data", via: "sense" }));

      for (const asg of proc.assigns ?? []) {
        const seq = seqProc || !!asg.delay;
        const targets = asg.targets.map((t) => ({ ...rr(t), dynamic: !!t.dynamic }));
        const sources = [
          ...(asg.sources ?? []).map((s) => ({ ...rr(s), via: "source" })),
          ...(seq ? sense : []),
        ];
        const base = {
          kind: proc.kind, seq, loc: asg.loc ?? proc.loc, text: asg.text,
          guarded: !!asg.guarded, scope,
        };
        for (const t of targets) {
          push(writes, t, { ...base, approx: t.dynamic, sources, targets });
        }
        for (const s of sources) {
          push(reads, s, { ...base, role: s.role, targets, sources });
        }
      }

      if (!(proc.assigns ?? []).length) for (const s of sense) {
        push(reads, s, { kind: proc.kind, seq: true, role: s.role, loc: proc.loc,
          text: `@(${proc.kind}) ${proc.label ?? ""}`.trim(), scope, targets: [] });
      }
      for (const r of proc.reads ?? []) {
        push(reads, rr(r), { kind: proc.kind, seq: false, role: r.role ?? "data", loc: proc.loc,
          text: proc.label ? `${proc.kind} ${proc.label}` : proc.kind, scope, targets: [] });
      }
    }

    for (const inst of unit.instances ?? []) {
      const child = scope.children.find((c) => c.inst === inst);
      const portNode = (conn) => {
        if (!child || child.unit === null || conn.port === undefined) return null;
        const pv = (unitOf(sdi, child.unit).ports ?? [])[conn.port];
        return pv === undefined ? null : { scope: child, varIdx: pv, bits: conn.bits ?? null };
      };
      // A cell with no body: every input reaches every output.
      const blackBoxIn = inst.blackBox || !child || child.unit === null
        ? (inst.conns ?? []).flatMap((c) => (c.reads ?? []).map((r) => ({ ...rr(r), via: "blackBox" })))
        : null;

      for (const conn of inst.conns ?? []) {
        const port = portNode(conn);
        const label = conn.text ?? `.${conn.name ?? conn.port}(…)`;
        const kindIn = inst.blackBox ? "blackBox" : "portIn";
        const kindOut = inst.blackBox ? "blackBox" : "portOut";

        for (const r of conn.reads ?? []) {
          const src = { ...rr(r), via: "conn" };
          // The parent-side variable is read here, feeding the formal port.
          push(reads, src, { kind: kindIn, seq: false, role: src.role, loc: conn.loc ?? inst.decl,
            text: label, scope, targets: port ? [port] : [] });
          // And the formal port is driven from outside.
          if (port) {
            push(writes, port, { kind: kindIn, seq: false, loc: conn.loc ?? inst.decl, text: label,
              scope, sources: (conn.reads ?? []).map((x) => ({ ...rr(x), via: "conn" })) });
          }
        }

        for (const w of conn.writes ?? []) {
          const dst = { ...rr(w), via: "conn" };
          const sources = blackBoxIn ?? (port ? [{ ...port, via: "port", role: "data" }] : []);
          push(writes, dst, { kind: kindOut, seq: false, loc: conn.loc ?? inst.decl, text: label,
            approx: !!blackBoxIn, scope, sources });
          if (port) {
            push(reads, port, { kind: kindOut, seq: false, role: "data", loc: conn.loc ?? inst.decl,
              text: label, scope, targets: (conn.writes ?? []).map((x) => rr(x)) });
          }
        }
      }
    }
  }
  return { writes, reads };
}

/** Sites that write `node`, filtered to those touching its bits. */
function writersOf(sdi, el, node) {
  return (el.sites.writes.get(siteKey(node)) ?? [])
    .filter((s) => s.approx || overlaps(s.at.bits, node.bits));
}

/** Sites that read `node`, filtered to those touching its bits. */
function readersOf(sdi, el, node) {
  return (el.sites.reads.get(siteKey(node)) ?? [])
    .filter((s) => s.approx || overlaps(s.at.bits, node.bits));
}

// ------------------------------------------------------------ cone of influence

function cone(sdi, el, start, { forward = false, dataOnly = false, crossSeq = false, depth = 32 } = {}) {
  const seen = new Map();
  const edges = [];
  const queue = [{ node: start, level: 0 }];
  seen.set(nodeKey(start), 0);

  while (queue.length) {
    const { node, level } = queue.shift();
    if (level >= depth) continue;
    const sites = forward ? readersOf(sdi, el, node) : writersOf(sdi, el, node);
    for (const site of sites) {
      const others = forward ? site.targets : site.sources;
      for (const other of others ?? []) {
        if (other.unresolved) {
          edges.push({ from: node, to: null, site, unresolved: other.unresolved, level });
          continue;
        }
        const role = other.role ?? "data";
        if (dataOnly && role !== "data") continue;
        if (other.scope.unit === null) continue;
        const next = { scope: other.scope, varIdx: other.varIdx, bits: other.bits ?? null };
        edges.push({ from: node, to: next, site, role, level, via: other.via });
        const seq = site.seq;
        if (seq && !crossSeq) continue;          // stop at a flop: same-cycle cone
        const key = nodeKey(next);
        if (seen.has(key)) continue;
        seen.set(key, level + 1);
        queue.push({ node: next, level: level + 1 });
      }
    }
  }
  return { edges, seen };
}

// ------------------------------------------------------------------ VCD binding

function vcdPaths(file) {
  const text = readFileSync(file, "utf8");
  const head = text.split("$enddefinitions")[0];
  const toks = head.split(/\s+/);
  const stack = [];
  const paths = new Set();
  const scopes = new Set();
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === "$scope") { stack.push(toks[i + 2]); scopes.add(stack.join(".")); i += 2; }
    else if (toks[i] === "$upscope") stack.pop();
    else if (toks[i] === "$var") {
      // <kind> <size> <id> <reference> [<bit-range>] — tide keeps only <reference>,
      // so a space-separated range is dropped and a glued one stays in the name.
      const name = toks[i + 4];
      paths.add([...stack, name].join("."));
      i += 4;
    }
  }
  return { paths, scopes };
}

// ----------------------------------------------------------------- commands

function cmdTree(sdi, el) {
  const line = (scope, indent) => {
    const unit = scope.unit !== null ? unitOf(sdi, scope.unit) : null;
    const tag = unit ? `${unit.kind} ${unit.name}` : "blackBox";
    const label = scope.parent ? scope.name : scope.path;
    console.log(`${indent}${label}  ${dim(`[${tag}]`)}`);
    for (const v of unit?.vars ?? []) {
      const w = widthOf(sdi, v.type);
      const t = typeOf(sdi, v.type);
      const bits = w === null ? "" : `${w}b`;
      const enums = t.kind === "enum" ? ` {${t.values.map((e) => e.name).join(",")}}` : "";
      const dir = v.direction && v.direction !== "internal" ? ` ${v.direction}` : "";
      const flags = [
        v.kind && v.kind !== "var" ? v.kind : null,
        v.traceOmitted ? "not-in-trace" : null,
        v.hints?.role,
      ].filter(Boolean).join(" ");
      console.log(
        `${indent}  ${v.name.padEnd(10)} ${dim(bits.padStart(4))} ${typeSpelling(sdi, v.type)}${enums}` +
        `${dim(dir)}${flags ? dim(`  (${flags})`) : ""}  ${dim(spanText(sdi, v.decl))}`,
      );
    }
    for (const c of scope.children) line(c, indent + "    ");
  };
  for (const r of el.roots) line(r, "");
}

function cmdCheck(sdi, el, trace) {
  let problems = 0;
  const bad = (msg) => { problems++; console.log(`  ${red("✗")} ${msg}`); };

  // Structural invariants the JSON Schema cannot express.
  sdi.units.forEach((u, ui) => {
    (u.ports ?? []).forEach((p, k) => {
      if (!(u.vars ?? [])[p]) bad(`units[${ui}].ports[${k}] -> vars[${p}] missing`);
      else if (!u.vars[p].direction || u.vars[p].direction === "internal") {
        bad(`units[${ui}].ports[${k}] (${u.vars[p].name}) has no direction`);
      }
    });
    (u.vars ?? []).forEach((v, vi) => {
      if (!sdi.types[v.type]) bad(`units[${ui}].vars[${vi}] (${v.name}) -> types[${v.type}] missing`);
    });
    (u.instances ?? []).forEach((inst, ii) => {
      if (inst.unit === undefined && !inst.blackBox) bad(`units[${ui}].instances[${ii}] has neither unit nor blackBox`);
      if (inst.unit !== undefined && !sdi.units[inst.unit]) bad(`units[${ui}].instances[${ii}] -> units[${inst.unit}] missing`);
      (inst.conns ?? []).forEach((c, ci) => {
        if (inst.unit !== undefined && c.port !== undefined) {
          const child = sdi.units[inst.unit];
          if ((child.ports ?? [])[c.port] === undefined) {
            bad(`units[${ui}].instances[${ii}].conns[${ci}] -> port ordinal ${c.port} out of range`);
          }
        }
      });
    });
  });
  sdi.types.forEach((t, ti) => {
    if (t.kind === "struct" && t.packed) {
      for (const m of t.members) {
        const mw = widthOf(sdi, m.type);
        if (m.lsb === undefined) bad(`types[${ti}].members ${m.name} has no lsb in a packed struct`);
        else if (mw !== null && t.width !== undefined && m.lsb + mw > t.width) {
          bad(`types[${ti}] member ${m.name} at lsb ${m.lsb} + ${mw}b exceeds width ${t.width}`);
        }
      }
    }
  });

  // Every ref must resolve, and every slice must sit inside its variable.
  let refs = 0, unresolved = 0;
  for (const [, scope] of el.scopes) {
    if (scope.unit === null) continue;
    const u = unitOf(sdi, scope.unit);
    const check = (ref, where) => {
      refs++;
      const r = resolveRef(sdi, el, scope, ref);
      if (r.unresolved) { unresolved++; bad(`${scope.path}: unresolved ref (${r.unresolved}) in ${where}`); return; }
      const w = widthOf(sdi, unitOf(sdi, r.scope.unit).vars[r.varIdx].type);
      if (r.bits && w !== null && r.bits[0] + r.bits[1] > w) {
        bad(`${scope.path}: ${where} slice [${r.bits}] exceeds ${w}b variable`);
      }
    };
    for (const p of u.processes ?? []) {
      for (const s of p.sense ?? []) check(s.ref, "sense");
      for (const r of p.reads ?? []) check(r, "reads");
      for (const a of p.assigns ?? []) {
        for (const t of a.targets) check(t, "target");
        for (const s of a.sources ?? []) check(s, "source");
      }
    }
    for (const inst of u.instances ?? []) {
      for (const c of inst.conns ?? []) {
        for (const r of c.reads ?? []) check(r, `conn ${c.name}.reads`);
        for (const w of c.writes ?? []) check(w, `conn ${c.name}.writes`);
      }
    }
  }
  console.log(`  refs resolved: ${refs - unresolved}/${refs}`);

  // Binding: do the computed trace paths exist in a real trace?
  if (trace) {
    const { paths, scopes } = vcdPaths(trace);
    let matched = 0, omitted = 0, missing = 0;
    for (const [key, scope] of el.scopes) {
      if (scope.unit === null || key !== scope.path) continue;
      if (!scopes.has(scope.path)) console.log(`  ${yellow("!")} scope not in trace: ${scope.path}`);
      for (const v of unitOf(sdi, scope.unit).vars ?? []) {
        const cands = tracePaths(sdi, scope, v);
        const hit = cands.find((c) => paths.has(c.path));
        if (hit) matched++;
        else if (v.traceOmitted) omitted++;
        else { missing++; bad(`no trace signal for ${scope.path}.${v.name} (tried ${cands.map((c) => c.path).join(", ")})`); }
      }
    }
    console.log(`  trace binding: ${matched} matched, ${omitted} declared-omitted, ${missing} unexplained` +
      `  (${paths.size} signals in ${basename(trace)})`);
  }

  console.log(problems ? red(`\n${problems} problem(s)`) : green("\nall checks passed"));
  return problems;
}

function cmdInfo(sdi, el, hit) {
  const { scope, var: v } = hit;
  const t = typeOf(sdi, v.type);
  const w = widthOf(sdi, v.type);
  console.log(`${bold(scope.path + "." + v.name)}`);
  console.log(`  type       ${typeSpelling(sdi, v.type)}  (${t.kind}, ${w}b, ${t.states ?? "?"}-state${t.signed ? ", signed" : ""})`);
  console.log(`  kind       ${v.kind ?? "var"}${v.direction && v.direction !== "internal" ? `, ${v.direction}` : ""}`);
  console.log(`  declared   ${spanText(sdi, v.decl)}`);
  if (v.comment) console.log(`  comment    ${v.comment}`);
  if (v.value !== undefined) console.log(`  value      ${v.value}`);
  if (v.hints) console.log(`  hints      ${JSON.stringify(v.hints)}`);
  if (t.kind === "enum") {
    console.log(`  enum       ${t.name} (base ${typeSpelling(sdi, t.base)})`);
    for (const e of t.values) console.log(`    ${String(e.value).padEnd(6)} ${e.name.padEnd(8)} ${dim(spanText(sdi, e.decl))}`);
  }
  if (t.kind === "struct") {
    console.log(`  members    ${t.packed ? "packed" : "unpacked"}`);
    for (const m of t.members) {
      const mw = widthOf(sdi, m.type);
      console.log(`    ${m.name.padEnd(8)} bits [${m.lsb + mw - 1}:${m.lsb}]  ${typeSpelling(sdi, m.type)}  ${dim(spanText(sdi, m.decl))}`);
    }
  }
  if (t.kind === "unpackedArray") {
    console.log(`  elements   [${t.range?.join(":")}] of ${typeSpelling(sdi, t.elem)} (${widthOf(sdi, t.elem)}b each)`);
  }
  const paths = tracePaths(sdi, scope, v);
  console.log(`  trace      ${v.traceOmitted ? yellow("not dumped") : paths.map((p) => p.path).join(" | ")}`);
  const unit = unitOf(sdi, scope.unit);
  console.log(`  in         ${unit.kind} ${unit.name}  ${dim(spanText(sdi, unit.decl))}`);
}

function cmdSites(sdi, el, node, forward) {
  const sites = forward ? readersOf(sdi, el, node) : writersOf(sdi, el, node);
  console.log(bold(`${forward ? "readers" : "drivers"} of ${nodeName(sdi, node)}`));
  if (!sites.length) console.log("  (none)");
  for (const s of sites) {
    const others = (forward ? s.targets : s.sources) ?? [];
    const names = others.filter((o) => !o.unresolved && o.scope.unit !== null)
      .map((o) => `${nodeName(sdi, o)}${o.role && o.role !== "data" ? dim(`:${o.role}`) : ""}`);
    const tag = [s.kind, s.seq ? "seq" : "comb", s.guarded ? "guarded" : null, s.approx ? "approx" : null]
      .filter(Boolean).join(" ");
    console.log(`  ${spanText(sdi, s.loc).padEnd(18)} ${dim(`(${tag})`)}`);
    if (s.text) console.log(`    ${s.text}`);
    if (names.length) console.log(`    ${forward ? "→" : "←"} ${names.join(", ")}`);
  }
}

function cmdCone(sdi, el, node, opts, forward) {
  const { edges, seen } = cone(sdi, el, node, { ...opts, forward });
  const label = forward ? "fan-out cone" : "cone of influence";
  const mode = [
    opts.dataOnly ? "data only" : "data + control",
    opts.crossSeq ? "across sequential edges" : "same cycle (stops at flops)",
  ].join(", ");
  console.log(bold(`${label} of ${nodeName(sdi, node)}`) + dim(`  — ${mode}`));
  const byLevel = new Map();
  for (const e of edges) {
    if (!byLevel.has(e.level)) byLevel.set(e.level, []);
    byLevel.get(e.level).push(e);
  }
  for (const lvl of [...byLevel.keys()].sort((a, b) => a - b)) {
    console.log(`  ${dim(`level ${lvl + 1}`)}`);
    const rows = new Map();
    for (const e of byLevel.get(lvl)) {
      const to = e.to ? nodeName(sdi, e.to) : `${yellow("unresolved")} ${e.unresolved}`;
      const key = `${nodeName(sdi, e.from)}|${to}|${spanText(sdi, e.site.loc)}`;
      if (!rows.has(key)) {
        rows.set(key, { from: nodeName(sdi, e.from), to, e });
      }
    }
    for (const { from, to, e } of rows.values()) {
      const arrow = forward ? "→" : "←";
      const tag = [e.site.seq ? "seq" : "comb", e.role !== "data" ? e.role : null,
        e.via === "blackBox" ? "blackBox" : null, e.site.approx ? "approx" : null].filter(Boolean).join(" ");
      console.log(`    ${from} ${arrow} ${to}  ${dim(`(${tag}) ${spanText(sdi, e.site.loc)}`)}`);
    }
  }
  const total = new Set([...seen.keys()]).size;
  console.log(`  ${dim(`${total} node(s), ${edges.length} edge(s)`)}`);
}

// ---------------------------------------------------------------------- output

const tty = process.stdout.isTTY;
const wrap = (c) => (s) => (tty ? `\u001b[${c}m${s}\u001b[0m` : s);
const dim = wrap(90), bold = wrap(1), red = wrap(31), green = wrap(32), yellow = wrap(33);

// ------------------------------------------------------------------------ main

function main(argv) {
  const [file, cmd, ...rest] = argv;
  if (!file || !cmd) {
    console.error(readFileSync(new URL(import.meta.url)).toString().split("\n")
      .filter((l) => l.startsWith("//")).slice(6, 16).map((l) => l.slice(3)).join("\n"));
    process.exit(2);
  }
  const sdi = loadSdi(file);
  const el = elaborate(sdi);
  el.sites = buildSites(sdi, el);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a) => !a.startsWith("--"));
  const depthArg = [...flags].find((f) => f.startsWith("--depth="));
  const opts = {
    dataOnly: flags.has("--data"),
    crossSeq: flags.has("--cross-seq"),
    depth: depthArg ? Number(depthArg.slice(8)) : 32,
  };

  if (cmd === "tree") return void cmdTree(sdi, el);
  if (cmd === "check") return void process.exit(cmdCheck(sdi, el, args[0]) ? 1 : 0);

  const hit = findSignal(sdi, el, args[0] ?? "");
  if (!hit) {
    console.error(`no such signal: ${args[0]}`);
    process.exit(1);
  }
  const node = { scope: hit.scope, varIdx: hit.varIdx, bits: null };
  if (cmd === "info") return void cmdInfo(sdi, el, hit);
  if (cmd === "drivers") return void cmdSites(sdi, el, node, false);
  if (cmd === "readers") return void cmdSites(sdi, el, node, true);
  if (cmd === "cone") return void cmdCone(sdi, el, node, opts, false);
  if (cmd === "fanout") return void cmdCone(sdi, el, node, opts, true);
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

main(process.argv.slice(2));
