import { GPUContext } from "../device";
import { Segment, Viewport, packSegments, packViewport } from "../data";
import WGSL from "./digital.wgsl";

export const LINE_PX = 2.5;

export interface DigitalPipeline {
  pipeline: GPURenderPipeline;
  uniformBuf: GPUBuffer;
  segmentBuf: GPUBuffer;
  bindGroup: GPUBindGroup;
  segmentCount: number;
  updateViewport(vp: Viewport): void;
}

export function buildDigitalPipeline(
  { device, format }: GPUContext,
  segments: Segment[],
): DigitalPipeline {
  const module = device.createShaderModule({ code: WGSL });

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module, entryPoint: "vs" },
    fragment: {
      module,
      entryPoint: "fs",
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
    ],
  });

  return {
    pipeline, uniformBuf, segmentBuf, bindGroup,
    segmentCount: segments.length,
    updateViewport: (vp: Viewport) => { device.queue.writeBuffer(uniformBuf, 0, packViewport(vp)); },
  };
}
