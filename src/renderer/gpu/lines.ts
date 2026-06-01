import { GPUContext } from "./device";
import WGSL from "./lines.wgsl";

export const MAX_LINES = 1024;
const LINE_U32 = 4; // 16 B per line (pos + color + flags + pad)
const LINE_BYTES = LINE_U32 * 4;

export interface LineSpec {
  x: number;      // CSS px, center of the line
  color: number;  // packed rgba (see packRgba in text.ts)
  dashed?: boolean;
  // Extend to the very top (y=0) instead of starting inside the flag pill.
  // Used by the hover guide, which has no pill to anchor into.
  fullHeight?: boolean;
}

export interface LineBatch {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  lineCount: number;
  // count overrides lines.length (useful when callers reuse a pooled scratch
  // array longer than the live region).
  setLines(lines: LineSpec[], count?: number): void;
}

export interface LineRenderer {
  pipeline: GPURenderPipeline;
  createBatch(): LineBatch;
}

export async function createLineRenderer(
  ctx: GPUContext,
  viewportUniform: GPUBuffer,
): Promise<LineRenderer> {
  const { device, format } = ctx;

  const module = device.createShaderModule({ code: WGSL });

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const pipeline = await device.createRenderPipelineAsync({
    layout,
    vertex: { module, entryPoint: "vs_line" },
    fragment: {
      module,
      entryPoint: "fs_line",
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

  function createBatch(): LineBatch {
    const instanceBuf = device.createBuffer({
      size: MAX_LINES * LINE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const scratch = new Uint32Array(MAX_LINES * LINE_U32);
    const scratchF32 = new Float32Array(scratch.buffer);

    const bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: viewportUniform } },
        { binding: 1, resource: { buffer: instanceBuf } },
      ],
    });

    const batch: LineBatch = {
      pipeline,
      bindGroup,
      lineCount: 0,
      setLines(lines, countArg) {
        const requested = countArg ?? lines.length;
        const count = Math.min(requested, MAX_LINES);
        batch.lineCount = count;
        if (count === 0) return;
        for (let i = 0; i < count; i++) {
          const off = i * LINE_U32;
          const l = lines[i];
          scratchF32[off + 0] = l.x;
          scratch[off + 1] = l.color >>> 0;
          scratch[off + 2] = (l.dashed ? 1 : 0) | (l.fullHeight ? 2 : 0);
          scratch[off + 3] = 0;
        }
        device.queue.writeBuffer(instanceBuf, 0, scratch, 0, count * LINE_U32);
      },
    };
    return batch;
  }

  return { pipeline, createBatch };
}
