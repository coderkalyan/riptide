import { GPUContext } from "../device";
import { Segment, Viewport, packSegments, packViewport } from "../data";

export const LINE_PX = 2.5;

// Per instance: 12 vertices = 2 quads.
//   vi 0– 5  fill rect  (value=1 → accent 70%, value=0 → accent 20%)
//   vi 6–11  line rect  (LINE_PX thick, accent 100%)
const WGSL = /* wgsl */`
struct Viewport {
  t0: f32, t1: f32,
  width: f32, height: f32,
  row_height: f32, row_padding: f32,
  offset_y: f32, line_px: f32,
}

struct Segment {
  t_start: f32, t_end: f32,
  value: f32, row: f32,
}

@group(0) @binding(0) var<uniform>       vp:       Viewport;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;

struct VertOut {
  @builtin(position) pos:   vec4f,
  @location(0)       color: vec4f,
}

var<private> QUAD: array<vec2f, 6> = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
  vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
);

fn clip(px: f32, py: f32) -> vec4f {
  return vec4f(px / vp.width * 2.0 - 1.0, -py / vp.height * 2.0 + 1.0, 0.0, 1.0);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertOut {
  let seg    = segments[ii];
  let accent = vec3f(0.651, 0.820, 0.537);

  let x0 = (seg.t_start - vp.t0) / (vp.t1 - vp.t0) * vp.width;
  let x1 = (seg.t_end   - vp.t0) / (vp.t1 - vp.t0) * vp.width;

  let row_top = vp.offset_y + seg.row * vp.row_height + vp.row_padding;
  let row_bot = vp.offset_y + (seg.row + 1.0) * vp.row_height - vp.row_padding;
  let inner   = row_bot - row_top;

  // Signal line: 20% from top when high, 80% when low
  let line_y = row_top + inner * select(0.80, 0.20, seg.value > 0.5);

  let uv = QUAD[vi % 6u];
  let px = mix(x0, x1, uv.x);

  if (vi < 6u) {
    // Fill: full inner-row height, alpha encodes level (line already shows position)
    let alpha = select(0.20, 0.70, seg.value > 0.5);
    return VertOut(clip(px, mix(row_top, row_bot, uv.y)), vec4f(accent, alpha));
  } else {
    // Line: LINE_PX thick bar centered on line_y
    let half = vp.line_px * 0.5;
    return VertOut(clip(px, mix(line_y - half, line_y + half, uv.y)), vec4f(accent, 1.0));
  }
}

@fragment
fn fs(in: VertOut) -> @location(0) vec4f { return in.color; }
`;

export interface DigitalPipeline {
  pipeline:     GPURenderPipeline;
  uniformBuf:   GPUBuffer;
  segmentBuf:   GPUBuffer;
  bindGroup:    GPUBindGroup;
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
    vertex:   { module, entryPoint: "vs" },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [{
        format,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one",       dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
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
