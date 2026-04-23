import { GPUContext } from "./device";
import { Segment, Viewport, packSegments, packViewport } from "./data";
import WGSL from "./digital.wgsl";

type ShaderVariant = "multi" | "single";

export interface SignalPipeline {
  pipeline: GPURenderPipeline;
  uniformBuf: GPUBuffer;
  segmentBuf: GPUBuffer;
  bindGroup: GPUBindGroup;
  segmentCount: number;
  updateViewport(vp: Viewport): void;
}

function buildVariantPipeline(
  { device, format }: GPUContext,
  segments: Segment[],
  colorBuf: GPUBuffer,
  variant: ShaderVariant,
): SignalPipeline {
  const module = device.createShaderModule({ code: WGSL });
  const vertexEntryPoint = variant === "single" ? "vs_single" : "vs_multi";
  const fragmentEntryPoint = variant === "single" ? "fs_single" : "fs_multi";

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module, entryPoint: vertexEntryPoint },
    fragment: {
      module,
      entryPoint: fragmentEntryPoint,
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

  const uniformBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const packed = packSegments(segments);
  const segmentBuf = device.createBuffer({ size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(segmentBuf, 0, packed);

  const bindGroup = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: uniformBuf } },
      { binding: 1, resource: { buffer: segmentBuf } },
      { binding: 2, resource: { buffer: colorBuf } },
    ],
  });

  return {
    pipeline, uniformBuf, segmentBuf, bindGroup,
    segmentCount: segments.length,
    updateViewport: (vp: Viewport) => { device.queue.writeBuffer(uniformBuf, 0, packViewport(vp)); },
  };
}

export function buildMultiBitPipeline(
  gpuCtx: GPUContext,
  segments: Segment[],
  colorBuf: GPUBuffer,
): SignalPipeline {
  return buildVariantPipeline(gpuCtx, segments, colorBuf, "multi");
}

export function buildSingleBitPipeline(
  gpuCtx: GPUContext,
  segments: Segment[],
  colorBuf: GPUBuffer,
): SignalPipeline {
  return buildVariantPipeline(gpuCtx, segments, colorBuf, "single");
}
