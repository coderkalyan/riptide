import { GPUContext } from "./device";
import WGSL from "./rect.wgsl";

export const MAX_RECTS = 1024;
const RECT_U32 = 6; // 24 B per rect: x, y, w, h, color, flags
const RECT_BYTES = RECT_U32 * 4;

export interface RectSpec {
  x: number; y: number; w: number; h: number;
  color: number;         // packed rgba
  crosshatch?: boolean;
}

export interface RectBatch {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  rectCount: number;
  setRects(rects: RectSpec[]): void;
}

export interface RectRenderer {
  pipeline: GPURenderPipeline;
  createBatch(): RectBatch;
}

export async function createRectRenderer(
  ctx: GPUContext,
  viewportUniform: GPUBuffer,
): Promise<RectRenderer> {
  const { device, format } = ctx;

  const module = device.createShaderModule({ code: WGSL });

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const pipeline = await device.createRenderPipelineAsync({
    layout,
    vertex: { module, entryPoint: "vs_rect" },
    fragment: {
      module,
      entryPoint: "fs_rect",
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

  function createBatch(): RectBatch {
    const instanceBuf = device.createBuffer({
      size: MAX_RECTS * RECT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const scratch = new Uint32Array(MAX_RECTS * RECT_U32);
    const scratchF32 = new Float32Array(scratch.buffer);

    const bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: viewportUniform } },
        { binding: 1, resource: { buffer: instanceBuf } },
      ],
    });

    const batch: RectBatch = {
      pipeline,
      bindGroup,
      rectCount: 0,
      setRects(rects) {
        const count = Math.min(rects.length, MAX_RECTS);
        batch.rectCount = count;
        if (count === 0) return;
        for (let i = 0; i < count; i++) {
          const off = i * RECT_U32;
          const r = rects[i];
          scratchF32[off + 0] = r.x;
          scratchF32[off + 1] = r.y;
          scratchF32[off + 2] = r.w;
          scratchF32[off + 3] = r.h;
          scratch[off + 4] = r.color >>> 0;
          scratch[off + 5] = r.crosshatch ? 1 : 0;
        }
        device.queue.writeBuffer(instanceBuf, 0, scratch, 0, count * RECT_U32);
      },
    };
    return batch;
  }

  return { pipeline, createBatch };
}
