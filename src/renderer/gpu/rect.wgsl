// Shaded rect overlay. Used for background tints and post-timeline crosshatch.
// Instanced quad per rect with a configurable solid color and optional
// crosshatch fill pattern.

struct Viewport {
    ticks_per_pixel: f32,
    start_ticks: u32,
    width: f32,
    height: f32,
    row_height: f32,
    dpr: f32,
    selected_row: i32,
}

struct Rect {
    x: f32,          // CSS px, top-left
    y: f32,
    w: f32,
    h: f32,
    color_rgba: u32, // 8-bit packed rgba
    flags: u32,      // bit 0 = crosshatch
}

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<storage, read> rects: array<Rect>;

struct VertexData {
    @builtin(position) pos: vec4f,
    @location(0) local_px: vec2f,
    @location(1) @interpolate(flat) color: vec4f,
    @location(2) @interpolate(flat) flags: u32,
}

fn unpack_rgba(p: u32) -> vec4f {
    return vec4f(
        f32((p >> 0u) & 0xffu),
        f32((p >> 8u) & 0xffu),
        f32((p >> 16u) & 0xffu),
        f32((p >> 24u) & 0xffu),
    ) / 255.0;
}

@vertex
fn vs_rect(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexData {
    let r = rects[ii];

    let corner_x = f32(vi & 1u);
    let corner_y = f32((vi >> 1u) & 1u);

    let vertex_px = vec2f(r.x + corner_x * r.w, r.y + corner_y * r.h);
    let local_px = vec2f(corner_x * r.w, corner_y * r.h);

    let clip_x = vertex_px.x / viewport.width * 2.0 - 1.0;
    let clip_y = 1.0 - vertex_px.y / viewport.height * 2.0;

    return VertexData(vec4f(clip_x, clip_y, 0.0, 1.0), local_px, unpack_rgba(r.color_rgba), r.flags);
}

@fragment
fn fs_rect(in: VertexData) -> @location(0) vec4f {
    let crosshatch = (in.flags & 1u) != 0u;
    var a = in.color.a;

    // Lower on-threshold than the digital hatch (1/3): thinner stripes,
    // more whitespace → reads as a gentler "dead zone" fill.
    let spacing = 4.0 * viewport.dpr;
    let thickness = 0.2;
    let coord = (in.local_px.x + in.local_px.y) / spacing;
    let stripe = abs(fract(coord) - 0.5) * 2.0;
    let aa = fwidth(stripe);
    let mask = 1.0 - f32(crosshatch) * smoothstep(thickness - aa, thickness + aa, stripe);
    a *= mask;

    return vec4f(in.color.rgb, a);
}
