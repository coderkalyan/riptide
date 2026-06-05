import { GPUContext } from "./device";
import { Viewport, writeViewportInto, VIEWPORT_BYTES } from "./data";
import WGSL from "./digital.wgsl";

type ShaderVariant = "multi" | "single";

// RowInfo is 7×u32 (see segments.zig / digital.wgsl): x0_offset, x1_offset,
// bytes_per_sample, segment_start, flags, y_offset, height. Word 4 is the per-row
// flags (bit 0 = dim); words 5/6 are the vertical layout (CSS px as f32 bits),
// both patched directly by the renderer (no repack). ROW_FLAG_DIM must match
// digital.wgsl's ROW_FLAG_DIM.
const ROW_INFO_WORDS = 7;
const ROW_FLAG_DIM = 1 << 0;
const ROW_WORD_FLAGS = 4;
const ROW_WORD_Y = 5;
const ROW_WORD_H = 6;

export interface SignalPipeline {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  segmentCount: number;
  // The per-variant segment storage buffer backing this pipeline's bind group.
  // Tracked so a scene rebuild (add/remove active signal) can destroy it.
  segmentBuf: GPUBuffer;
}

// Shared per-scene buffers consumed by both single/multi pipelines.
export interface SceneBuffers {
  rowInfo: GPUBuffer;
  x0Pool: GPUBuffer;
  x1Pool: GPUBuffer;
  // CPU-side copy of the rowInfo records, retained so setDimFlags can patch the
  // per-row flags word and re-upload without a repack.
  rowInfoCpu: Uint32Array<ArrayBuffer>;
}

export interface DigitalRenderer {
  ctx: GPUContext;
  module: GPUShaderModule;
  bgl: GPUBindGroupLayout;
  layout: GPUPipelineLayout;
  uniformBuf: GPUBuffer;
  viewportScratch: Float32Array;
  writeViewport(vp: Viewport): void;
  createSceneBuffers(rowInfo: ArrayBuffer, x0Pool: ArrayBuffer, x1Pool: ArrayBuffer): SceneBuffers;
  buildPipelineFromPacked(
    variant: ShaderVariant,
    packed: Uint32Array<ArrayBuffer>,
    segmentCount: number,
    colorBuf: GPUBuffer,
    scene: SceneBuffers,
  ): Promise<SignalPipeline>;
  // Reuse an already-compiled pipeline with a fresh segment buffer + scene
  // (rebound bind group). Synchronous — no pipeline recompile — so an active
  // signal add/remove can repack on the spot. Caller owns destroying the old
  // SignalPipeline.segmentBuf and SceneBuffers.
  rebindPipeline(
    prev: SignalPipeline,
    packed: Uint32Array<ArrayBuffer>,
    segmentCount: number,
    colorBuf: GPUBuffer,
    scene: SceneBuffers,
  ): SignalPipeline;
  // Set the per-row dim flag (eye toggle) by patching the rowInfo buffer's flags
  // column and re-uploading it. One small writeBuffer, no repack — call after a
  // scene (re)build and whenever the hidden set changes.
  setDimFlags(scene: SceneBuffers, isHidden: (row: number) => boolean): void;
  // Write the per-row vertical layout (y_offset/height as f32 bits) into the
  // rowInfo buffer. `top` is the first row's y (below the ruler); heights stack.
  // `gapBelowOf` adds empty space after a row (divider) without growing its drawn
  // height. One writeBuffer, no repack — call after a scene (re)build / row resize.
  setRowLayout(scene: SceneBuffers, heightOf: (row: number) => number, top: number, gapBelowOf?: (row: number) => number): void;
}

export function createDigitalRenderer(ctx: GPUContext): DigitalRenderer {
  const { device, format } = ctx;

  const module = device.createShaderModule({ code: WGSL });

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const uniformBuf = device.createBuffer({ size: VIEWPORT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const viewportScratch = new Float32Array(VIEWPORT_BYTES / 4);
  const viewportScratchI32 = new Int32Array(viewportScratch.buffer);

  const blend = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  } as const;

  function writeStorage(bytes: ArrayBuffer, minSize = 16): GPUBuffer {
    // WebGPU validates each binding against the pipeline's required size even
    // for a 0-instance draw. An empty scene (fresh trace, nothing active) yields
    // an empty rowInfo buffer; binding 3 is array<RowInfo> (20 B stride), so it
    // must pad to one stride (minSize = 20) or validation rejects it as "too
    // small". The u32 pools use the default minSize 16 (harmless).
    const size = Math.max(minSize, bytes.byteLength);
    const buf = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    if (bytes.byteLength > 0) device.queue.writeBuffer(buf, 0, bytes);
    return buf;
  }

  function createSceneBuffers(rowInfo: ArrayBuffer, x0Pool: ArrayBuffer, x1Pool: ArrayBuffer): SceneBuffers {
    return {
      rowInfo: writeStorage(rowInfo, ROW_INFO_WORDS * 4),
      x0Pool: writeStorage(x0Pool),
      x1Pool: writeStorage(x1Pool),
      rowInfoCpu: new Uint32Array(rowInfo),
    };
  }

  async function buildPipelineFromPacked(
    variant: ShaderVariant,
    packed: Uint32Array<ArrayBuffer>,
    segmentCount: number,
    colorBuf: GPUBuffer,
    scene: SceneBuffers,
  ): Promise<SignalPipeline> {
    const fragmentEntryPoint = variant === "single" ? "fs_single" : "fs_multi";
    const variantConst = variant === "single" ? 0 : 1;

    const pipeline = await device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: "vs_main", constants: { VARIANT: variantConst } },
      fragment: {
        module,
        entryPoint: fragmentEntryPoint,
        constants: { VARIANT: variantConst },
        targets: [{ format, blend }],
      },
      primitive: { topology: "triangle-strip" },
    });

    return bindSegments(pipeline, packed, segmentCount, colorBuf, scene);
  }

  // Build the segment storage buffer + bind group for a (re)used pipeline.
  function bindSegments(
    pipeline: GPURenderPipeline,
    packed: Uint32Array<ArrayBuffer>,
    segmentCount: number,
    colorBuf: GPUBuffer,
    scene: SceneBuffers,
  ): SignalPipeline {
    const segmentBuf = device.createBuffer({
      size: Math.max(16, packed.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (packed.byteLength > 0) device.queue.writeBuffer(segmentBuf, 0, packed);

    const bindGroup = device.createBindGroup({
      label: "digital-bindgroup",
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: { buffer: segmentBuf } },
        { binding: 2, resource: { buffer: colorBuf } },
        { binding: 3, resource: { buffer: scene.rowInfo } },
        { binding: 4, resource: { buffer: scene.x0Pool } },
        { binding: 5, resource: { buffer: scene.x1Pool } },
      ],
    });

    return { pipeline, bindGroup, segmentCount, segmentBuf };
  }

  function rebindPipeline(
    prev: SignalPipeline,
    packed: Uint32Array<ArrayBuffer>,
    segmentCount: number,
    colorBuf: GPUBuffer,
    scene: SceneBuffers,
  ): SignalPipeline {
    return bindSegments(prev.pipeline, packed, segmentCount, colorBuf, scene);
  }

  function writeViewport(vp: Viewport): void {
    writeViewportInto(viewportScratch, viewportScratchI32, vp);
    device.queue.writeBuffer(uniformBuf, 0, viewportScratch);
  }

  function setDimFlags(scene: SceneBuffers, isHidden: (row: number) => boolean): void {
    const cpu = scene.rowInfoCpu;
    const rows = cpu.length / ROW_INFO_WORDS;
    for (let r = 0; r < rows; r++) {
      cpu[r * ROW_INFO_WORDS + ROW_WORD_FLAGS] = isHidden(r) ? ROW_FLAG_DIM : 0;
    }
    if (cpu.byteLength > 0) device.queue.writeBuffer(scene.rowInfo, 0, cpu);
  }

  function setRowLayout(scene: SceneBuffers, heightOf: (row: number) => number, top: number, gapBelowOf?: (row: number) => number): void {
    const cpu = scene.rowInfoCpu;
    const rows = cpu.length / ROW_INFO_WORDS;
    // Same backing buffer, viewed as f32 to write the y_offset/height words.
    const f = new Float32Array(cpu.buffer, cpu.byteOffset, cpu.length);
    let y = top;
    for (let r = 0; r < rows; r++) {
      const h = heightOf(r);
      f[r * ROW_INFO_WORDS + ROW_WORD_Y] = y;
      f[r * ROW_INFO_WORDS + ROW_WORD_H] = h;
      y += h + (gapBelowOf ? gapBelowOf(r) : 0);
    }
    if (cpu.byteLength > 0) device.queue.writeBuffer(scene.rowInfo, 0, cpu);
  }

  return { ctx, module, bgl, layout, uniformBuf, viewportScratch, writeViewport, createSceneBuffers, buildPipelineFromPacked, rebindPipeline, setDimFlags, setRowLayout };
}
