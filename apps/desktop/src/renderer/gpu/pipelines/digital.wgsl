struct Viewport {
    t0: f32,
    t1: f32,
    width: f32,
    height: f32,
    row_height: f32,
    row_padding: f32,
    offset_y: f32,
    line_px: f32,
}

struct Segment {
    t_start: u32,
    t_end: u32,
    value: u32,
    row: u32,
    // TODO: these can be packed into a single u32
    flags: u32,
}

@group(0) @binding(0) var<uniform> vp: Viewport;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;

struct VertOut {
    @builtin(position) pos: vec4f,
    @location(0) color: vec4f,
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
    let seg = segments[ii];
    let accent = vec3f(0.651, 0.820, 0.537);

    let x0 = (f32(seg.t_start) - vp.t0) / (vp.t1 - vp.t0) * vp.width;
    let x1 = (f32(seg.t_end) - vp.t0) / (vp.t1 - vp.t0) * vp.width;

    let row_top = vp.offset_y + f32(seg.row) * vp.row_height + vp.row_padding;
    let row_bot = vp.offset_y + (f32(seg.row) + 1.0) * vp.row_height - vp.row_padding;
    let inner = row_bot - row_top;

    // Signal line: 20% from top when high, 80% when low
    let line_y = row_top + inner * select(0.95, 0.05, f32(seg.value) > 0.5);

    let uv = QUAD[vi % 6u];
    let px = mix(x0, x1, uv.x);

    if vi < 6u {
        // Fill: full inner-row height, alpha encodes level (line already shows position)
        let alpha = select(0.20, 0.70, f32(seg.value) > 0.5);
        return VertOut(clip(px, mix(row_top, row_bot, uv.y)), vec4f(accent, alpha));
    } else {
        // Line: LINE_PX thick bar centered on line_y
        let half = vp.line_px * 0.5;
        return VertOut(clip(px, mix(line_y - half, line_y + half, uv.y)), vec4f(accent, 1.0));
    }
}

@fragment
fn fs(in: VertOut) -> @location(0) vec4f {
    return in.color;
}
