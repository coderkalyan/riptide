// Shaded rect overlay. Used for background tints, post-timeline crosshatch,
// and pill backgrounds. Instanced quad per rect with a configurable solid
// color and optional crosshatch fill / rounded-corner mask.

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

struct Rect {
    x: f32,          // CSS px, top-left
    y: f32,
    w: f32,
    h: f32,
    color_rgba: u32,
    flags: u32,      // bit 0 = crosshatch, bit 1 = rounded corners
}

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<storage, read> rects: array<Rect>;

const ROUND_RADIUS_PX: f32 = 3.0; // CSS px; matches DOM .flag border-radius

struct VertexData {
    @builtin(position) pos: vec4f,
    @location(0) local_px: vec2f,
    @location(1) @interpolate(flat) half_size_px: vec2f,
    @location(2) @interpolate(flat) color: vec4f,
    @location(3) @interpolate(flat) flags: u32,
}

fn unpack_rgba(p: u32) -> vec4f {
    return vec4f(
        f32((p >>  0u) & 0xffu),
        f32((p >>  8u) & 0xffu),
        f32((p >> 16u) & 0xffu),
        f32((p >> 24u) & 0xffu),
    ) / 255.0;
}

fn sdf_rounded(point: vec2f, half_size: vec2f, radius: f32) -> f32 {
    let q = abs(point) - half_size + radius;
    return length(max(q, vec2f(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

// Copied from digital.wgsl, extended with a rotation arg so the same chevron
// can serve as a horizontal arrowhead (±90°) here.
fn segment_sdf(point: vec2f, a: vec2f, b: vec2f) -> f32 {
    let pa = point - a;
    let ba = b - a;
    let t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * t);
}

fn caret_sdf(point: vec2f, apex: vec2f, rotation: f32) -> f32 {
    let arm_length_px = 5.0;
    let half_angle_rad = radians(40.0);
    let half_thickness_px = 1.0;

    var q = point - apex;
    let c = cos(rotation);
    let s = sin(rotation);
    q = mat2x2f(c, -s, s, c) * q;
    q.x = abs(q.x);

    let e = arm_length_px * vec2f(sin(half_angle_rad), cos(half_angle_rad));
    return segment_sdf(q, vec2f(0.0), e) - half_thickness_px;
}

@vertex
fn vs_rect(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexData {
    let r = rects[ii];

    let corner_x = f32(vi & 1u);
    let corner_y = f32((vi >> 1u) & 1u);

    let vertex_px = vec2f(r.x + corner_x * r.w, r.y + corner_y * r.h);
    let local_px = vec2f(corner_x * r.w, corner_y * r.h);
    let half_size_px = vec2f(r.w * 0.5, r.h * 0.5);

    let clip_x = vertex_px.x / viewport.width * 2.0 - 1.0;
    let clip_y = 1.0 - vertex_px.y / viewport.height * 2.0;

    return VertexData(vec4f(clip_x, clip_y, 0.0, 1.0), local_px, half_size_px, unpack_rgba(r.color_rgba), r.flags);
}

@fragment
fn fs_rect(in: VertexData) -> @location(0) vec4f {
    // Caret/arrowhead mode (bit 2). Rotate the chevron to point horizontally:
    // +90° = "<" (points left), -90° = ">" (points right, bit 3). apex at the
    // rect center; 1px-wide coverage like the digital caret.
    let caret = (in.flags & 4u) != 0u;
    // Compute the caret coverage unconditionally: fwidth requires uniform
    // control flow, so it cannot live inside the `if (caret)` branch.
    let rot = select(radians(-90.0), radians(90.0), (in.flags & 8u) != 0u);
    let caret_centered = in.local_px - in.half_size_px;
    let caret_d = caret_sdf(caret_centered, vec2f(0.0, 0.0), rot);
    let caret_aa = fwidth(caret_d);
    let caret_cov = clamp(0.5 - caret_d / caret_aa, 0.0, 1.0);

    let crosshatch = (in.flags & 1u) != 0u;
    let rounded = (in.flags & 2u) != 0u;
    var a = in.color.a;

    // Crosshatch — same diagonal pattern as digital, with a lower on-threshold
    // for thinner stripes. Branch is uniform per primitive (flat flags).
    let spacing = 4.0 * viewport.dpr;
    let thickness = 0.2;
    let coord = (in.local_px.x + in.local_px.y) / spacing;
    let stripe = abs(fract(coord) - 0.5) * 2.0;
    let aa_s = fwidth(stripe);
    let stripe_mask = 1.0 - f32(crosshatch) * smoothstep(thickness - aa_s, thickness + aa_s, stripe);
    a *= stripe_mask;

    // Rounded-corner mask — only AA inside the corner zones (where both
    // q.x>0 and q.y>0); straight edges stay sharp so adjacent pixels
    // (e.g. a cursor line abutting the pill) don't pick up sub-pixel
    // transparency.
    let centered = in.local_px - in.half_size_px;
    let q = abs(centered) - in.half_size_px + ROUND_RADIUS_PX;
    let in_corner = q.x > 0.0 && q.y > 0.0;
    let d = length(max(q, vec2f(0.0, 0.0))) - ROUND_RADIUS_PX;
    let aa_d = fwidth(d);
    let corner_mask = 1.0 - smoothstep(-aa_d, 0.0, d);
    let round_mask = select(1.0, corner_mask, in_corner);
    a *= select(1.0, round_mask, rounded);

    // Select the caret alpha for caret instances; the normal rect alpha
    // otherwise. Both paths computed unconditionally (uniform fwidth).
    let out_a = select(a, in.color.a * caret_cov, caret);
    return vec4f(in.color.rgb, out_a);
}
