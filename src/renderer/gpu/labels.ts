import { GPUContext } from "./device";
import { ATLAS_FIRST, ATLAS_COUNT, GlyphCell } from "./text";
import WGSL from "./labels.wgsl";

// 16 B per glyph instance: t_start, t_end, row, packed.
const LABEL_U32 = 4;

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
}

export interface LabelRenderer {
  pipeline: GPURenderPipeline;
  createBatch(): LabelBatch;
}

export async function createLabelRenderer(
  ctx: GPUContext,
  viewportUniform: GPUBuffer,
  atlasLgView: GPUTextureView,
  sampler: GPUSampler,
  cell: GlyphCell,
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
    ],
  });

  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const constants = {
    cell_w: cell.widthPx,
    cell_h: cell.heightPx,
    midline: cell.midlinePx,
    atlas_first: ATLAS_FIRST,
    atlas_count: ATLAS_COUNT,
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
          // Full rebuild.
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
          ],
        });
      },
    };
    return batch;
  }

  return { pipeline, createBatch };
}
