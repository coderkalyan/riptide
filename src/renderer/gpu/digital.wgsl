struct Viewport {
    ticks_per_pixel: f32,
    // start_ticks split into integer + fractional parts. Subtraction happens
    // in integer domain (preserves precision for tick values > 2^24) and the
    // fractional part is added back as f32 for sub-pixel pan smoothness.
    start_ticks_int: i32,
    start_ticks_frac: f32,
    width: f32,
    height: f32,
    row_height: f32,
    dpr: f32,
    selected_row: i32,
    wave_y_offset: f32,
    // Slot 9: pad. (Row dimming moved to RowInfo.flags bit 0 so it scales past
    // the 32-row limit of the old dim_mask bitfield.)
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
}

struct Segment {
    // Start tick.
    t_start: u32,
    // End tick.
    t_end: u32,
    // Packed flags and row information.
    // [15:0] = row index
    // [  16] = enable shading
    // [  17] = enable right edge
    // [  18] = rising edge arrow (caret left arm, at right boundary)
    // [  19] = falling edge arrow
    // [  20] = mute segment
    // [  21] = rising edge left (caret right arm, at left boundary)
    row_flags: u32,
}

// Per-row metadata: where this row's samples live in the shared x0/x1 pools
// (BYTE offsets), plus its bytes-per-sample (ceil(bit_width / 8) = tide's native
// stride; each sample is that many consecutive bytes, memcpy'd straight from tide).
struct RowInfo {
    x0_offset: u32,
    x1_offset: u32,
    bytes_per_sample: u32,
    // First instance index for this row in its pipeline. Sample index for an
    // instance ii of this row is `ii - segment_start`.
    segment_start: u32,
    // Per-row render flags (bit 0 = dim). Written directly into the rowInfo
    // buffer by the renderer on eye toggle (no repack). See ROW_FLAG_DIM.
    flags: u32,
    // Per-row vertical placement in CSS px, stored as f32 bits (bitcast below).
    // y_offset = row top in canvas space, height = drawn height. Written by the
    // renderer (row resize) directly into the buffer — no repack.
    y_offset: u32,
    height: u32,
}

// RowInfo.flags bits (distinct from the VertexData F_* flags below). Must match
// ROW_FLAG_DIM in segments.zig / digital.ts.
const ROW_FLAG_DIM: u32 = 1u << 0u;

// Pipeline-creation constant: 0 = single-bit, 1 = multi-bit. Folded at
// pipeline-compile time so per-variant branches have no runtime cost.
const VARIANT_SINGLE: u32 = 0u;
const VARIANT_MULTI: u32 = 1u;
override VARIANT: u32 = 0u;

// VertexData.flags layout (single source of truth — vs and fs both read these).
// Bits [0..7] mirror segment.row_flags[16..23] (shade/edge/rising/falling/mute).
// Bits [8..15] are per-sample decoded state. F_DRAW_LINE_HIGH is single-only.
const F_SHADE: u32 = 1u << 0u;
const F_RIGHT_EDGE: u32 = 1u << 1u;
const F_RISING_EDGE: u32 = 1u << 2u;
const F_FALLING_EDGE: u32 = 1u << 3u;
const F_MUTE: u32 = 1u << 4u;
const F_RISING_EDGE_LEFT: u32 = 1u << 5u; // companion: rising edge at left boundary
const F_CROSSHATCH: u32 = 1u << 8u;
const F_HATCH_COLOR: u32 = 1u << 9u;
const F_DRAW_LINE: u32 = 1u << 10u;
const F_DRAW_LINE_HIGH: u32 = 1u << 11u; // single-bit variant only
const F_HIGHLIGHT: u32 = 1u << 12u;
const F_DIM: u32 = 1u << 13u; // row's eye toggled off → 50% output opacity

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;
@group(0) @binding(2) var<storage, read> row_colors: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> rows: array<RowInfo>;
@group(0) @binding(4) var<storage, read> x0_pool: array<u32>;
@group(0) @binding(5) var<storage, read> x1_pool: array<u32>;

// Decode a segment's sample into OR-reduced (lsb, msb). A sample spans
// bytes_per_sample consecutive bytes (tide's native byte run, memcpy'd into the
// pools); the renderer only needs whole-sample non-zeroness (any defined-1 bit,
// any unknown bit) to pick line/crosshatch/color, so OR-folding every byte is
// exact for that purpose and width-agnostic. The pools are bound as array<u32>
// (WGSL can't bind byte storage), so each byte is extracted from its word; bytes
// that spill past a sample are masked off per byte (`& 0xff`), so reading into a
// neighbouring sample's word is harmless.
fn decodeSample(row: u32, instance_index: u32) -> vec2<u32> {
    let info = rows[row];
    let bps = info.bytes_per_sample;
    let sample_index = instance_index - info.segment_start;
    let x0_base = info.x0_offset + sample_index * bps;
    let x1_base = info.x1_offset + sample_index * bps;
    var lsb: u32 = 0u;
    var msb: u32 = 0u;
    for (var b: u32 = 0u; b < bps; b = b + 1u) {
        let bi = x0_base + b;
        let bj = x1_base + b;
        lsb = lsb | ((x0_pool[bi >> 2u] >> ((bi & 3u) * 8u)) & 0xffu);
        msb = msb | ((x1_pool[bj >> 2u] >> ((bj & 3u) * 8u)) & 0xffu);
    }
    return vec2<u32>(lsb, msb);
}

fn corner_sdf(point: vec2f, half_size: vec2f, radius: f32) -> f32 {
    let q = abs(point) - half_size + radius;
    return length(max(q, vec2f(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

fn hatch(pill_local_px: vec2f, dir: f32, hatch_spacing_px: f32) -> f32 {
    let hatch_thickness = 1.0 / 3.0;

    let hatch_coord = (pill_local_px.x + pill_local_px.y * dir) / hatch_spacing_px;
    let stripe = abs(fract(hatch_coord) - 0.5) * 2.0;
    let aa = fwidth(stripe);
    let stripe_mask = 1.0 - smoothstep(hatch_thickness - aa, hatch_thickness + aa, stripe);
    return stripe_mask;
}

fn segment_sdf(point: vec2f, a: vec2f, b: vec2f) -> f32 {
    let pa = point - a;
    let ba = b - a;
    let t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * t);
}

fn caret_sdf(point: vec2f, apex: vec2f) -> f32 {
    let arm_length_px = 8.0;
    let half_angle_rad = radians(40.0);
    let half_thickness_px = 1.0;

    // Vertical caret (apex up): mirror across x, no rotation. The horizontal
    // span-arrows in rect.wgsl take a rotation arg; this one never does.
    var q = point - apex;
    q.x = abs(q.x);

    let e = arm_length_px * vec2f(sin(half_angle_rad), cos(half_angle_rad));
    return segment_sdf(q, vec2f(0.0), e) - half_thickness_px;
}

struct VertexData {
    @builtin(position) pos: vec4f,
    @location(0) pill_local_px: vec2f,
    @location(1) @interpolate(flat) half_size_px: vec2f,
    @location(2) @interpolate(flat) flags: u32,
    @location(3) @interpolate(flat) primary_color: vec4f,
}

// Shared vertex shader. Branches on VARIANT (override constant) for the only
// two real differences between single- and multi-bit: a 2 CSS px right-edge
// inset, and packing F_DRAW_LINE_HIGH (single-only).
// All size literals here are CSS px (dpr-independent); the CSS→clip→framebuffer
// transform already scales by dpr, so sizes must NOT be multiplied by dpr.
@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexData {
    let xgap_px = select(0.0, 2.0, VARIANT == VARIANT_MULTI);
    let ygap_px = 4.0;

    let segment = segments[ii];
    let row = segment.row_flags & 0xffffu;
    let value = decodeSample(row, ii);
    let lsb_nonzero = value.x != 0u;
    let msb_nonzero = value.y != 0u;
    let highlight = i32(row) == viewport.selected_row;
    let dimmed = (rows[row].flags & ROW_FLAG_DIM) != 0u;

    // Synthesize vertices for a triangle strip rect in [0, 1]^2.
    let corner_x = f32(vi & 1u);
    let corner_y = f32((vi >> 1u) & 1u);

    // Transform from timeline (tick) space into pixel space. Subtract in i32
    // before f32 cast so values > 2^24 don't lose integer precision.
    let dt = vec2f(
        f32(i32(segment.t_start) - viewport.start_ticks_int),
        f32(i32(segment.t_end) - viewport.start_ticks_int),
    ) - viewport.start_ticks_frac;
    var pixel_bounds = dt / viewport.ticks_per_pixel;

    // Asymmetric inset: shift only the right edge inward (multi only; for
    // single, xgap_px is 0).
    pixel_bounds += vec2f(0.0, -xgap_px);

    // Compute the pill's center and half-size in pixels. Vertical placement comes
    // from the per-row layout (RowInfo.y_offset / .height, f32 bits), so rows of
    // any height position + size correctly.
    let row_y = bitcast<f32>(rows[row].y_offset);
    let row_h = bitcast<f32>(rows[row].height);
    let center_px = vec2f((pixel_bounds[0] + pixel_bounds[1]) * 0.5, row_y + row_h * 0.5);
    let half_size_px = vec2f((pixel_bounds[1] - pixel_bounds[0]) * 0.5, (row_h - ygap_px) * 0.5);

    // Compute the vertex position in pixel space.
    let corner = vec2f(corner_x, corner_y);
    let vertex_local_px = (corner * 2.0 - 1.0) * half_size_px;
    let vertex_px = center_px + vertex_local_px;

    // Convert vertex position to clip space.
    let clip_x = vertex_px.x / viewport.width * 2.0 - 1.0;
    let clip_y = 1.0 - vertex_px.y / viewport.height * 2.0;

    // Pack flags. Per-sample bits use the same semantics in both variants;
    // F_DRAW_LINE_HIGH is single-only (multi's fs ignores it but we gate the
    // write anyway to keep the bit-layout intent explicit).
    var flags = (segment.row_flags >> 16u) & 0xffu;
    flags |= select(0u, F_CROSSHATCH, msb_nonzero);
    flags |= select(0u, F_HATCH_COLOR, lsb_nonzero);
    flags |= select(0u, F_DRAW_LINE, !msb_nonzero);
    flags |= select(0u, F_DRAW_LINE_HIGH, lsb_nonzero && VARIANT == VARIANT_SINGLE);
    flags |= select(0u, F_HIGHLIGHT, highlight);
    flags |= select(0u, F_DIM, dimmed);

    return VertexData(vec4f(clip_x, clip_y, 0.0, 1.0), vertex_local_px, half_size_px, flags, row_colors[row]);
}

@fragment
fn fs_single(in: VertexData) -> @location(0) vec4f {
    let line_thickness_px = 2.0;
    let primary_color = in.primary_color;
    let hi_alpha = 0.7;
    let lo_alpha = 0.2;
    let x_color = vec4f(0.9608, 0.4471, 0.4471, 1.0);
    let z_color = vec4f(1.0, 0.863, 0.0, 1.0);
    let mute_color = vec4f(0.47, 0.47, 0.47, 0.6);

    let enable_fill = (in.flags & F_SHADE) != 0u;
    let draw_edge = (in.flags & F_RIGHT_EDGE) != 0u;
    let mute = (in.flags & F_MUTE) != 0u;
    let enable_crosshatch = (in.flags & F_CROSSHATCH) != 0u;
    let crosshatch_color = (in.flags & F_HATCH_COLOR) != 0u;
    let draw_line = (in.flags & F_DRAW_LINE) != 0u;
    let draw_line_high = (in.flags & F_DRAW_LINE_HIGH) != 0u;
    let highlight = (in.flags & F_HIGHLIGHT) != 0u;
    let rising = (in.flags & F_RISING_EDGE) != 0u;
    let rising_left = (in.flags & F_RISING_EDGE_LEFT) != 0u;

    // Horizontal line mask.
    let line_lo_px = in.half_size_px.y - (line_thickness_px * 0.5);
    let line_hi_px = -in.half_size_px.y + (line_thickness_px * 0.5);
    let line_px = select(line_lo_px, line_hi_px, draw_line_high);
    let dist_y = abs(in.pill_local_px.y - line_px);
    let aa_y = fwidth(dist_y);
    let line_mask = 1.0 - smoothstep(line_thickness_px * 0.5 - aa_y, line_thickness_px * 0.5 + aa_y, dist_y);

    // Left vertical edge: hard step (rasterizer clips the right side).
    let edge_left_x = in.half_size_px.x - line_thickness_px;
    let edge_mask_raw = select(0.0, 1.0, in.pill_local_px.x >= edge_left_x);
    let edge_mask = select(0.0, edge_mask_raw, draw_edge);

    // Rising-edge caret: a downward chevron centered on the top of the rising
    // edge. The edge straddles two segments, so each draws one half clipped to
    // its quad — the low segment (F_RISING_EDGE) renders the left arm at its
    // top-right corner, the high segment (F_RISING_EDGE_LEFT) the right arm at
    // its top-left corner. apex.x is the shared edge x, apex.y the row top.
    // The visible edge line is the low segment's right edge, occupying
    // [T - line_thickness, T]; bias the tip left by half a line width so it
    // centers on the line rather than on the boundary tick T.
    let caret = rising || rising_left;
    // The caret SDF's derivative (fwidth) must be evaluated in UNIFORM control
    // flow. `caret` is per-instance-coherent at runtime, but it derives from
    // in.flags (a varying), so WGSL's static uniformity analysis treats a branch
    // on it as non-uniform and Tint rejects fwidth inside it. Compute the chevron
    // for every fragment and gate the result with select instead of an `if`.
    let apex_x = select(-in.half_size_px.x, in.half_size_px.x, rising) - line_thickness_px * 0.5;
    let caret_apex = vec2f(apex_x, -in.half_size_px.y);
    let caret_d = caret_sdf(in.pill_local_px, caret_apex);
    // 1px-wide coverage: feather over a single pixel centered on the zero
    // crossing (smoothstep(-aa, aa, …) spreads over 2px and reads as blur).
    let caret_aa = fwidth(caret_d);
    let caret_mask = select(0.0, clamp(0.5 - caret_d / caret_aa, 0.0, 1.0), caret);

    let stroke_mask = max(max(line_mask * f32(draw_line), edge_mask), caret_mask);

    // Calculate shading.
    let hatch_primary = select(select(x_color, z_color, crosshatch_color), mute_color, mute);
    let line_color = select(primary_color, mute_color, mute);
    let shade_alpha = select(lo_alpha, select(hi_alpha, 0.8, highlight), draw_line_high);
    var shade_color = select(primary_color, mute_color, mute);
    shade_color = vec4f(shade_color.rgb, shade_color.a * shade_alpha);

    // hatch() calls fwidth, which must run in UNIFORM control flow. Guarding it
    // behind enable_crosshatch (a branch on the in.flags varying) is a uniformity
    // violation Tint rejects, so compute the hatch unconditionally and select it
    // in. The extra fract+smoothstep per non-hatched fragment is negligible.
    let stripe_mask = hatch(in.pill_local_px, 1.0, 8.0);
    let hatched = vec4f(hatch_primary.rgb, hatch_primary.a * stripe_mask);
    let fill_color = select(shade_color, hatched, enable_crosshatch);
    let fill_alpha = select(0.0, fill_color.a, enable_fill);
    let fill = vec4f(fill_color.rgb, fill_alpha);

    let color = mix(fill, line_color, stroke_mask);
    // Composite against the canvas clear color so background draws (grid lines)
    // don't show through signals; output stays opaque. A dimmed row (eye off)
    // is blended 50% toward bg in RGB rather than made transparent — so the
    // grid underneath never reappears.
    let bg = vec3f(0.106, 0.114, 0.129);
    var rgb = mix(bg, color.rgb, color.a);
    rgb = select(rgb, mix(bg, rgb, 0.5), (in.flags & F_DIM) != 0u);
    return vec4f(rgb, 1.0);
}

@fragment
fn fs_multi(in: VertexData) -> @location(0) vec4f {
    let radius = 4.0;
    let border_width = 2.0;
    let primary_color = in.primary_color;
    let x_color = vec4f(0.9608, 0.4471, 0.4471, 0.7);
    let z_color = vec4f(1.0, 0.863, 0.0, 0.7);
    let mute_color = vec4f(0.47, 0.47, 0.47, 0.6);

    let enable_fill = (in.flags & F_SHADE) != 0u;
    let mute = (in.flags & F_MUTE) != 0u;
    let enable_crosshatch = (in.flags & F_CROSSHATCH) != 0u;
    let crosshatch_color = (in.flags & F_HATCH_COLOR) != 0u;
    let highlight = (in.flags & F_HIGHLIGHT) != 0u;

    // Calculate masks for rounded corner, edge, fill based on corner_sdf.
    let d_px = corner_sdf(in.pill_local_px, in.half_size_px, radius);
    let aa = fwidth(d_px);
    let border_mask = smoothstep(-border_width - aa, -border_width, d_px) * (1.0 - smoothstep(-aa, 0.0, d_px));
    let fill_mask = 1.0 - smoothstep(-border_width - aa, -border_width, d_px);

    // Calculate shading.
    let hatch_primary = select(select(x_color, z_color, crosshatch_color), mute_color, mute);
    let line_color = select(select(primary_color, hatch_primary, enable_crosshatch), mute_color, mute);
    let shade_alpha = select(0.7, 1.0, highlight);
    let shade_color = vec4f(line_color.rgb, line_color.a * shade_alpha);

    // hatch() calls fwidth → must run in UNIFORM control flow. Branching on the
    // in.flags-derived enable_crosshatch is a uniformity violation (Tint), so
    // compute the hatch unconditionally and select it in.
    let stripe_mask = hatch(in.pill_local_px, 1.0, 8.0);
    let hatched = vec4f(hatch_primary.rgb, hatch_primary.a * stripe_mask);
    let fill_color = select(shade_color, hatched, enable_crosshatch);
    let fill_alpha = select(0.0, fill_color.a, enable_fill);
    let fill = vec4f(fill_color.rgb, fill_alpha);

    let final_color = line_color * border_mask + fill * fill_mask;
    let final_alpha = border_mask + fill_color.a * fill_mask;
    // Composite against the canvas clear color so background draws (grid lines)
    // don't show through signals; output stays opaque. A dimmed row (eye off)
    // is blended 50% toward bg in RGB rather than made transparent — so the
    // grid underneath never reappears.
    let bg = vec3f(0.106, 0.114, 0.129);
    var rgb = mix(bg, final_color.rgb, final_alpha);
    rgb = select(rgb, mix(bg, rgb, 0.5), (in.flags & F_DIM) != 0u);
    return vec4f(rgb, 1.0);
}
