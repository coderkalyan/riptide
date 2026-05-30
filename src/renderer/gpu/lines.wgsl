// Vertical lines for timeline grid + cursors/markers. Start partway down
// into the flag pill (so the line visually anchors the pill) but not at
// y=0, which would leave AA slivers above the pill's rounded corners.
// Instanced quad per line: 2*dpr CSS px wide. x_px is the LEFT edge.

struct Viewport {
    ticks_per_pixel: f32,
    start_ticks_int: i32,
    start_ticks_frac: f32,
    width: f32,
    height: f32,
    row_height: f32,
    dpr: f32,
    selected_row: i32,
    wave_y_offset: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
}

struct Line {
    x_px: f32,       // CSS px, left edge of the line
    color_rgba: u32, // 8-bit packed rgba
    flags: u32,      // bit 0 = dashed, bit 1 = full height (top at y=0)
    _pad: u32,
}

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<storage, read> lines: array<Line>;

struct VertexData {
    @builtin(position) pos: vec4f,
    @location(0) y_px: f32,
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
fn vs_line(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexData {
    let line = lines[ii];
    let thickness = 1.25 * viewport.dpr;

    let corner_x = f32(vi & 1u);
    let corner_y = f32((vi >> 1u) & 1u);

    // Line is left-aligned, anchored at x_px. Top starts inside the flag pill
    // (8 CSS px = pill_h/2 in App.tsx) so the line appears to enter the pill.
    let x_px = line.x_px + corner_x * thickness;
    let y_top = select(8.0, 0.0, (line.flags & 2u) != 0u);
    let y_px = y_top + corner_y * (viewport.height - y_top);

    let clip_x = x_px / viewport.width * 2.0 - 1.0;
    let clip_y = 1.0 - y_px / viewport.height * 2.0;

    return VertexData(vec4f(clip_x, clip_y, 0.0, 1.0), y_px, unpack_rgba(line.color_rgba), line.flags);
}

@fragment
fn fs_line(in: VertexData) -> @location(0) vec4f {
    let dashed = (in.flags & 1u) != 0u;
    let period = 8.0;
    let on_frac = 0.6;
    var a = in.color.a;

    let t = fract(in.y_px / period);
    let aa = fwidth(t);
    a *= 1.0 - f32(dashed) * smoothstep(on_frac - aa, on_frac + aa, t);

    return vec4f(in.color.rgb, a);
}
