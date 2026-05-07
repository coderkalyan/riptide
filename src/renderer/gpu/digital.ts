import { GPUContext } from "./device";
import { Viewport, writeViewportInto, VIEWPORT_BYTES } from "./data";
import WGSL from "./digital.wgsl";

type ShaderVariant = "multi" | "single";

export interface SignalPipeline {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  segmentCount: number;
}

// Shared per-scene buffers consumed by both single/multi pipelines.
export interface SceneBuffers {
  rowInfo: GPUBuffer;
  x0Pool: GPUBuffer;
  x1Pool: GPUBuffer;
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

  function writeStorage(bytes: ArrayBuffer): GPUBuffer {
    // WebGPU requires storage buffer size > 0; pad empty pools to 4 bytes.
    const size = Math.max(4, bytes.byteLength);
    const buf = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    if (bytes.byteLength > 0) device.queue.writeBuffer(buf, 0, bytes);
    return buf;
  }

  function createSceneBuffers(rowInfo: ArrayBuffer, x0Pool: ArrayBuffer, x1Pool: ArrayBuffer): SceneBuffers {
    return {
      rowInfo: writeStorage(rowInfo),
      x0Pool: writeStorage(x0Pool),
      x1Pool: writeStorage(x1Pool),
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

    const segmentBuf = device.createBuffer({
      size: Math.max(16, packed.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (packed.byteLength > 0) device.queue.writeBuffer(segmentBuf, 0, packed);

    const bindGroup = device.createBindGroup({
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

    return { pipeline, bindGroup, segmentCount };
  }

  function writeViewport(vp: Viewport): void {
    writeViewportInto(viewportScratch, viewportScratchI32, vp);
    device.queue.writeBuffer(uniformBuf, 0, viewportScratch);
  }

  return { ctx, module, bgl, layout, uniformBuf, viewportScratch, writeViewport, createSceneBuffers, buildPipelineFromPacked };
}
