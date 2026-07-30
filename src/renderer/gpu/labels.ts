import { GPUContext } from "./device";
import { ATLAS_FIRST, ATLAS_COUNT, GlyphCell } from "./text";
import WGSL from "./labels.wgsl";

// 16 B per glyph instance: t_start, t_end, row, packed.
const LABEL_U32 = 4;

// Breathing room a pill needs beyond its text before it will draw it, split
// between the two ends. Passed to the shader as an override so the cull there and
// the size decision here cannot disagree. Small on purpose: a pill only a few px
// wider than its text still reads fine, and anything larger blanks pills that
// visibly look big enough to hold their value.
const CULL_PAD_PX = 4;

// Pill spans retained per row to estimate what share of them fit a label. A
// sample, not the lot: the estimate needs the shape of the distribution, not
// every value.
const SPAN_SAMPLES = 256;

// How much more of a row's pills the small glyphs must label before the row steps
// down to them. Shrinking every label in a row to gain one or two is a bad trade;
// a tenth of the row is a visible one.
const MIN_TIER_GAIN = 0.1;

// Fraction of `sorted` (ascending) at or above `min`, by binary search.
function share(sorted: number[], min: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < min) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length === 0 ? 0 : (sorted.length - lo) / sorted.length;
}

export interface LabelBatch {
  pipeline: GPURenderPipeline;
  // (Re)built by setLabels — references the current instance + rowInfo buffers.
  bindGroup: GPUBindGroup | null;
  glyphCount: number;
  // Expand the native value labels → per-glyph instances built ONCE here (not per
  // frame), upload (growing the instance buffer as needed), and rebind against the
  // current rowInfo buffer (which changes on every scene rebuild). Call at repack.
  //
  // Labels come straight from the native pack (no JS formatting): `multi` is the
  // 3×u32 multi PackedSegment buffer (t_start, t_end, row_flags) and label i is the
  // ASCII byte range labelBytes[labelOffsets[i] .. labelOffsets[i+1]] — so segment
  // i's pill text is read directly from the blob, no per-segment JS string.
  //
  // `reusePrefix` is the add-signal fast path: when true, the caller guarantees the
  // first `glyphCount`/built segments are unchanged from the previous call (a pure
  // append — rows added at the end, multi segments appended after the prior ones),
  // so only the newly appended segments are expanded + uploaded and the existing
  // GPU buffer prefix is left in place. Any change that isn't a clean append
  // (reorder/remove/radix/first build) must pass false → full rebuild.
  setLabels(
    multi: Uint32Array,
    multiCount: number,
    labelBytes: Uint8Array,
    labelOffsets: Uint32Array,
    rowInfo: GPUBuffer,
    reusePrefix: boolean,
  ): void;
  // Re-pick each row's glyph size for the current zoom, and report whether any row
  // changed — the caller re-uploads the row flags only then.
  //
  // The decision is per ROW, never per pill: it reads the row's *mean* pill span
  // and its longest label, so every pill in a row that draws a label draws it at
  // the same size. Deciding per pill would make neighbours disagree, which is the
  // distraction this exists to avoid. A row only steps down in the band where the
  // small size fits its typical pill and the large one does not — outside that
  // band shrinking recovers no labels, so it does not happen.
  retier(ticksPerPixel: number): boolean;
  // Whether row `row` draws small, as of the last `retier`.
  isSmall(row: number): boolean;
}

export interface LabelRenderer {
  pipeline: GPURenderPipeline;
  createBatch(): LabelBatch;
}

export async function createLabelRenderer(
  ctx: GPUContext,
  viewportUniform: GPUBuffer,
  atlasLgView: GPUTextureView,
  atlasSmView: GPUTextureView,
  sampler: GPUSampler,
  cellLg: GlyphCell,
  cellSm: GlyphCell,
): Promise<LabelRenderer> {
  const { device, format } = ctx;

  const module = device.createShaderModule({ code: WGSL });

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    ],
  });

  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const constants = {
    cell_w: cellLg.widthPx,
    cell_h: cellLg.heightPx,
    midline: cellLg.midlinePx,
    cell_w_sm: cellSm.widthPx,
    cell_h_sm: cellSm.heightPx,
    midline_sm: cellSm.midlinePx,
    atlas_first: ATLAS_FIRST,
    atlas_count: ATLAS_COUNT,
    cull_pad: CULL_PAD_PX,
  };

  const pipeline = await device.createRenderPipelineAsync({
    layout,
    vertex: { module, entryPoint: "vs_label", constants },
    fragment: {
      module,
      entryPoint: "fs_label",
      constants,
      targets: [{
        format,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }],
    },
    primitive: { topology: "triangle-strip" },
  });

  function createBatch(): LabelBatch {
    let capacityGlyphs = 0;
    let instanceBuf: GPUBuffer | null = null;
    let scratch = new Uint32Array(0);
    // The multi-segment count and glyph count already resident in instanceBuf —
    // the reuse boundary for the append fast path.
    let builtSegs = 0;

    // Per-row label geometry, accumulated in the same pass that expands the
    // glyphs, so it costs nothing extra, and zoom-independent so `retier` can run
    // per frame off a per-repack measurement.
    //
    // `spans` is a *sample* of the row's pill spans in ticks, kept sorted for
    // `retier` to count how many clear a width by binary search. A sample because
    // a dense row holds hundreds of thousands of pills and the question is only
    // what share of them are wide enough. It has to be the distribution and not a
    // mean: labels land on the wide tail, so the typical pill says nothing about
    // how many labels a smaller glyph would buy.
    const maxLen: number[] = [];
    const spans: number[][] = [];
    const stride: number[] = [];
    const seen: number[] = [];
    const segs: number[] = [];
    let sorted = false;
    let small: boolean[] = [];

    // Keep at most SPAN_SAMPLES spans per row: take every `stride`-th, and when the
    // sample fills, drop every other one and double the stride. Deterministic (no
    // RNG — the same trace must render the same pixels) and single-pass, so a row
    // with a million pills costs the same as one with a hundred.
    const sampleSpan = (row: number, span: number) => {
      const bucket = spans[row] ?? (spans[row] = []);
      const step = stride[row] ?? (stride[row] = 1);
      const count = seen[row] = (seen[row] ?? 0) + 1;
      if ((count - 1) % step !== 0) return;
      bucket.push(span);
      if (bucket.length >= SPAN_SAMPLES) {
        for (let i = 0, j = 0; i < bucket.length; i += 2, j++) bucket[j] = bucket[i];
        bucket.length = Math.ceil(bucket.length / 2);
        stride[row] = step * 2;
      }
      sorted = false;
    };
    const batch: LabelBatch = {
      pipeline,
      bindGroup: null,
      glyphCount: 0,
      setLabels(multi, multiCount, labelBytes, labelOffsets, rowInfo, reusePrefix) {
        // The instance buffer is a storage buffer bound to the shader, so it can
        // never exceed maxStorageBufferBindingSize. A huge/wide trace (e.g. 64-bit
        // values × 500k cycles → ~16 glyphs/label × millions of labels) would
        // overflow it, so cap the glyph count to fit and log the drop. The real
        // fix at that scale is windowing labels to the visible range (see
        // PERFORMANCE.md "Multi-bit value labels") — until then, cap, don't crash.
        const maxGlyphs = Math.floor(device.limits.maxStorageBufferBindingSize / (LABEL_U32 * 4));

        // Expand multi segments [fromSeg, multiCount) into scratch starting at glyph
        // index `fromGlyph`, stopping at `cap` glyphs. Returns the new glyph count.
        const expand = (fromSeg: number, fromGlyph: number, cap: number): number => {
          let gi = fromGlyph;
          outer: for (let i = fromSeg; i < multiCount; i++) {
            const start = labelOffsets[i];
            const len = Math.min(labelOffsets[i + 1] - start, 255); // empty for muted segments
            if (len <= 0) continue;
            const ts = multi[i * 3] >>> 0;
            const te = multi[i * 3 + 1] >>> 0;
            const row = multi[i * 3 + 2] & 0xffff;
            maxLen[row] = Math.max(maxLen[row] ?? 0, len);
            segs[row] = (segs[row] ?? 0) + 1;
            sampleSpan(row, te - ts);
            for (let k = 0; k < len; k++) {
              const code = labelBytes[start + k];
              if (code < 0x20 || code > 0x7e) continue; // non-atlas — skip, keep column k
              if (gi >= cap) break outer; // cap to fit the storage binding
              const off = gi * LABEL_U32;
              scratch[off + 0] = ts;
              scratch[off + 1] = te;
              scratch[off + 2] = row;
              // char_code[7:0] | glyph_index(column k)[15:8] | text_len[23:16]
              scratch[off + 3] = ((code & 0xff) | ((k & 0xff) << 8) | ((len & 0xff) << 16)) >>> 0;
              gi++;
            }
          }
          return gi;
        };

        // Append fast path: the prefix [0, builtSegs) is unchanged and already in
        // instanceBuf, so expand + upload only the newly appended segments. Needs
        // an existing buffer, a real prefix, and room without a realloc (a realloc
        // would drop the resident prefix → fall through to a full rebuild).
        const appendBytes = labelBytes.length - (instanceBuf && builtSegs > 0 ? labelOffsets[builtSegs] : 0);
        const appendCap = batch.glyphCount + appendBytes; // upper bound on total glyphs
        if (reusePrefix && instanceBuf && builtSegs > 0 && builtSegs <= multiCount && appendCap <= Math.min(capacityGlyphs, maxGlyphs)) {
          const gi = expand(builtSegs, batch.glyphCount, capacityGlyphs);
          if (gi > batch.glyphCount) {
            device.queue.writeBuffer(instanceBuf, batch.glyphCount * LABEL_U32 * 4, scratch, batch.glyphCount * LABEL_U32, (gi - batch.glyphCount) * LABEL_U32);
          }
          batch.glyphCount = gi;
          builtSegs = multiCount;
        } else {
          // Full rebuild — the stats describe the previous segment set, so clear
          // them with it.
          maxLen.length = 0;
          spans.length = 0;
          stride.length = 0;
          seen.length = 0;
          segs.length = 0;
          const wanted = labelBytes.length; // upper bound (skips non-atlas, caps at 255/label)
          const total = Math.min(wanted, maxGlyphs);
          if (wanted > maxGlyphs) {
            console.warn(
              `[labels] glyph buffer capped at ${maxGlyphs} (~${wanted - maxGlyphs} dropped): ${wanted} ` +
              `glyphs exceeds maxStorageBufferBindingSize (${device.limits.maxStorageBufferBindingSize} B). ` +
              `Window labels to the visible range to avoid this.`,
            );
          }
          const need = Math.max(total, 1);
          if (!instanceBuf || need > capacityGlyphs) {
            capacityGlyphs = Math.min(maxGlyphs, Math.max(need, capacityGlyphs * 2, 256));
            instanceBuf?.destroy();
            instanceBuf = device.createBuffer({
              size: capacityGlyphs * LABEL_U32 * 4,
              usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            scratch = new Uint32Array(capacityGlyphs * LABEL_U32);
          }
          const gi = expand(0, 0, total);
          batch.glyphCount = gi;
          builtSegs = multiCount;
          if (gi > 0) device.queue.writeBuffer(instanceBuf, 0, scratch, 0, gi * LABEL_U32);
        }

        // Rebind: both the instance buffer (may have been recreated) and rowInfo
        // (new buffer every scene rebuild) can change.
        batch.bindGroup = device.createBindGroup({
          label: "labels-bindgroup",
          layout: bgl,
          entries: [
            { binding: 0, resource: { buffer: viewportUniform } },
            { binding: 1, resource: { buffer: instanceBuf } },
            { binding: 2, resource: { buffer: rowInfo } },
            { binding: 3, resource: atlasLgView },
            { binding: 4, resource: sampler },
            { binding: 5, resource: atlasSmView },
          ],
        });
      },
      retier(ticksPerPixel) {
        if (!sorted) {
          for (const bucket of spans) bucket?.sort((a, b) => a - b);
          sorted = true;
        }
        let changed = false;
        for (let row = 0; row < segs.length; row++) {
          const bucket = spans[row];
          const len = maxLen[row] ?? 0;
          // What share of this row's pills could hold its longest label at each
          // size. Shrinking is worth it only when it labels meaningfully more of
          // them: a row whose pills nearly all fit already gains nothing, and one
          // whose pills are far too narrow gains nothing either — in both cases the
          // text just gets smaller for free. Both measured on a real trace before
          // this rule replaced a mean-pill-width one that fired in both.
          //
          // The share is over the whole packed window — the viewport plus a screen
          // either side — not over what is on screen. Deliberately: panning inside
          // the packed window must not re-decide the size, or a bursty row would
          // flip glyph size as it scrolled past. The cost is that a step down is
          // occasionally repaid just off the edge rather than in front of you.
          const fitLg = bucket ? share(bucket, (len * cellLg.widthPx + CULL_PAD_PX) * ticksPerPixel) : 0;
          const fitSm = bucket ? share(bucket, (len * cellSm.widthPx + CULL_PAD_PX) * ticksPerPixel) : 0;
          const want = fitSm - fitLg >= MIN_TIER_GAIN;
          if (want !== (small[row] ?? false)) {
            small[row] = want;
            changed = true;
          }
        }
        if (small.length > segs.length) {
          small = small.slice(0, segs.length);
          changed = true;
        }
        return changed;
      },
      isSmall(row) {
        return small[row] ?? false;
      },
    };
    return batch;
  }

  return { pipeline, createBatch };
}
