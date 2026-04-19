import { GPUContext } from "../device";
import { Segment, Viewport, packSegments, packViewport } from "../data";

// Matches the packed layout from packSegments / packViewport exactly.
const WGSL = /* wgsl */`
struct Viewport {
  t0:          f32,
  t1:          f32,
  width:       f32,
  height:      f32,
  row_height:  f32,
  row_padding: f32,
  // 2 padding floats to reach 32-byte alignment
}

struct Segment {
  t_start: f32,
  t_end:   f32,
  value:   f32,
  row:     f32,
}

@group(0) @binding(0) var<uniform>          vp:       Viewport;
@group(0) @binding(1) var<storage, read>    segments: array<Segment>;

struct VertOut {
  @builtin(position) pos:   vec4f,
  @location(0)       value: f32,
}

@vertex
fn vs(
  @builtin(vertex_index)   vi: u32,
  @builtin(instance_index) ii: u32,
) -> VertOut {
  // Two triangles forming a quad. c.x in [0,1] = left→right, c.y in [0,1] = top→bottom.
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );
  let c   = corners[vi];
  let seg = segments[ii];

  // Time → x pixel
  let t_range = vp.t1 - vp.t0;
  let x0 = (seg.t_start - vp.t0) / t_range * vp.width;
  let x1 = (seg.t_end   - vp.t0) / t_range * vp.width;

  // Row → y pixel (y grows downward in pixel space)
  let y0 = seg.row * vp.row_height + vp.row_padding;
  let y1 = (seg.row + 1.0) * vp.row_height - vp.row_padding;

  let px = mix(x0, x1, c.x);
  let py = mix(y0, y1, c.y);

  // Pixel → clip space.  x: [0,W]→[-1,1]   y: [0,H]→[1,-1]  (y-flip because pixel 0 = top)
  let cx =  px / vp.width  * 2.0 - 1.0;
  let cy = -py / vp.height * 2.0 + 1.0;

  return VertOut(vec4f(cx, cy, 0.0, 1.0), seg.value);
}

@fragment
fn fs(in: VertOut) -> @location(0) vec4f {
  // value=1 → accent green (#a6d189), value=0 → near panel-2 (#22252A)
  let hi = vec4f(0.651, 0.820, 0.537, 1.0);
  let lo = vec4f(0.133, 0.145, 0.165, 1.0);
  return mix(lo, hi, in.value);
}
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
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });

  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex:   { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  // Uniform buffer: 8 × f32 = 32 bytes
  const uniformBuf = device.createBuffer({
    size:  32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Storage buffer: N × 4 × f32 = N × 16 bytes
  const packed = packSegments(segments);
  const segmentBuf = device.createBuffer({
    size:  packed.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(segmentBuf, 0, packed);

  const bindGroup = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: uniformBuf } },
      { binding: 1, resource: { buffer: segmentBuf } },
    ],
  });

  const updateViewport = (vp: Viewport) => {
    device.queue.writeBuffer(uniformBuf, 0, packViewport(vp));
  };

  return {
    pipeline,
    uniformBuf,
    segmentBuf,
    bindGroup,
    segmentCount: segments.length,
    updateViewport,
  };
}
