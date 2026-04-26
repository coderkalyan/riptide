import { GPUContext } from "./device";
import { Segment, Viewport, packSegments, writeViewportInto } from "./data";
import WGSL from "./digital.wgsl";

type ShaderVariant = "multi" | "single";

export interface SignalPipeline {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  segmentCount: number;
}

export interface DigitalRenderer {
  ctx: GPUContext;
  module: GPUShaderModule;
  bgl: GPUBindGroupLayout;
  layout: GPUPipelineLayout;
  uniformBuf: GPUBuffer;
  viewportScratch: Float32Array;
  writeViewport(vp: Viewport): void;
  buildPipeline(variant: ShaderVariant, segments: Segment[], colorBuf: GPUBuffer): Promise<SignalPipeline>;
  buildPipelineFromPacked(variant: ShaderVariant, packed: Uint32Array<ArrayBuffer>, segmentCount: number, colorBuf: GPUBuffer): Promise<SignalPipeline>;
}

export function createDigitalRenderer(ctx: GPUContext): DigitalRenderer {
  const { device, format } = ctx;

  const module = device.createShaderModule({ code: WGSL });

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const uniformBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const viewportScratch = new Float32Array(8);
  const viewportScratchI32 = new Int32Array(viewportScratch.buffer);

  const blend = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  } as const;

  async function pipelineWithSegmentBuf(variant: ShaderVariant, segmentBuf: GPUBuffer, segmentCount: number, colorBuf: GPUBuffer): Promise<SignalPipeline> {
    const vertexEntryPoint = variant === "single" ? "vs_single" : "vs_multi";
    const fragmentEntryPoint = variant === "single" ? "fs_single" : "fs_multi";

    const pipeline = await device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: vertexEntryPoint },
      fragment: {
        module,
        entryPoint: fragmentEntryPoint,
        targets: [{ format, blend }],
      },
      primitive: { topology: "triangle-strip" },
    });

    const bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: { buffer: segmentBuf } },
        { binding: 2, resource: { buffer: colorBuf } },
      ],
    });

    return { pipeline, bindGroup, segmentCount };
  }

  async function buildPipeline(variant: ShaderVariant, segments: Segment[], colorBuf: GPUBuffer): Promise<SignalPipeline> {
    const packed = packSegments(segments);
    const segmentBuf = device.createBuffer({ size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(segmentBuf, 0, packed);
    return pipelineWithSegmentBuf(variant, segmentBuf, segments.length, colorBuf);
  }

  async function buildPipelineFromPacked(variant: ShaderVariant, packed: Uint32Array<ArrayBuffer>, segmentCount: number, colorBuf: GPUBuffer): Promise<SignalPipeline> {
    const segmentBuf = device.createBuffer({ size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(segmentBuf, 0, packed);
    return pipelineWithSegmentBuf(variant, segmentBuf, segmentCount, colorBuf);
  }

  function writeViewport(vp: Viewport): void {
    writeViewportInto(viewportScratch, viewportScratchI32, vp);
    device.queue.writeBuffer(uniformBuf, 0, viewportScratch);
  }

  return { ctx, module, bgl, layout, uniformBuf, viewportScratch, writeViewport, buildPipeline, buildPipelineFromPacked };
}
