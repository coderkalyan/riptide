struct Viewport {
    ticks_per_pixel: f32,
    start_ticks: u32,
    width: f32,
    height: f32,
    row_height: f32,
    dpr: f32,
}

struct Segment {
    // Start tick.
    t_start: u32,
    // End tick.
    t_end: u32,
    // LSBs of the segment value bitstring (0/1).
    value_lsb: u32,
    // MSBs of the segment value bitstring (x/z).
    value_msb: u32,
    // Packed flags and row information.
    // [15:0] = row index
    // [  16] = enable shading
    // [  17] = enable right edge
    // [  18] = rising edge arrow
    // [  19] = falling edge arrow
    row_flags: u32,
}

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;

fn sdf(point: vec2f, half_size: vec2f, radius: f32) -> f32 {
    let q = abs(point) - half_size + radius;
    return length(max(q, vec2f(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

fn hatch(pill_local_px: vec2f) -> f32 {
    let hatch_spacing_px = 4.0 * viewport.dpr;
    let hatch_thickness = 0.5;

    let hatch_coord = (pill_local_px.x + pill_local_px.y) / hatch_spacing_px;
    let stripe = abs(fract(hatch_coord) - 0.5) * 2.0;
    let aa = fwidth(stripe);
    let stripe_mask = 1.0 - smoothstep(hatch_thickness - aa, hatch_thickness + aa, stripe);
    return stripe_mask;
}

struct VertexData {
    @builtin(position) pos: vec4f,
    @location(0) pill_local_px: vec2f,
    @location(1) @interpolate(flat) half_size_px: vec2f,
    // [ 0] = enabling shading
    // [ 1] = enable right edge
    // [ 2] = rising edge arrow
    // [ 3] = falling edge arrow
    // [ 4] = draw line high
    // [ 5] = enable crosshatch
    // [ 6] = red/gray crosshatch color
    @location(2) @interpolate(flat) flags: u32,
}

@vertex
fn vs_single(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexData {
    let gap_px = 4.0 * viewport.dpr;

    let segment = segments[ii];
    let row = segment.row_flags & 0xffffu;
    let draw_line_high = (segment.value_msb | segment.value_lsb) != 0u;
    let enable_crosshatch = (segment.value_msb) != 0u;
    let crosshatch_color = (segment.value_lsb) != 0u;

    // Synthesize vertices for a triangle strip rect in [0, 1]^2.
    let corner_x = f32(vi & 1u);
    let corner_y = f32((vi >> 1u) & 1u);

    // Transform from timeline (tick) space into pixel space.
    let local_ticks = vec2i(i32(segment.t_start), i32(segment.t_end)) - i32(viewport.start_ticks);
    var pixel_bounds = vec2f(local_ticks) / viewport.ticks_per_pixel;

    // Compute the pill's center and half-size in pixels.
    let center_px = vec2f((pixel_bounds[0] + pixel_bounds[1]) * 0.5, viewport.row_height * (f32(row) + 0.5));
    let half_size_px = vec2f((pixel_bounds[1] - pixel_bounds[0]) * 0.5, (viewport.row_height - gap_px) * 0.5);

    // Compute the vertex position in pixel space.
    let corner = vec2f(corner_x, corner_y);
    let signed_corner = corner * 2.0 - 1.0;
    let vertex_local_px = (corner * 2.0 - 1.0) * half_size_px;
    let vertex_px = center_px + vertex_local_px;

    // Convert vertex position to clip space.
    let clip_x = vertex_px.x / viewport.width * 2.0 - 1.0;
    let clip_y = 1.0 - vertex_px.y / viewport.height * 2.0;

    // Shader (instance uniform) rendering flags.
    var flags = 0u;
    flags |= (segment.row_flags >> 16u) & 0xfu;
    flags |= u32(draw_line_high) << 4u;
    flags |= u32(enable_crosshatch) << 5u;
    flags |= u32(crosshatch_color) << 6u;

    return VertexData(vec4f(clip_x, clip_y, 0.0, 1.0), vertex_local_px, half_size_px, flags);
}

@fragment
fn fs_single(in: VertexData) -> @location(0) vec4f {
    let line_thickness_px = 1.0 * viewport.dpr;
    let primary_color = vec4f(0.651, 0.820, 0.537, 1.0);
    let hi_color = vec4f(primary_color.rgb, primary_color.a * 0.7);
    let lo_color = vec4f(primary_color.rgb, primary_color.a * 0.2);
    let x_color = vec4f(0.9608, 0.4471, 0.4471, 1.0);
    let z_color = vec4f(0.47, 0.47, 0.47, 1.0);

    let enable_fill = (in.flags & (1u << 0u)) != 0u;
    let draw_edge = (in.flags & (1u << 1u)) != 0u;
    let draw_line_high = (in.flags & (1u << 4u)) != 0u;
    let enable_crosshatch = (in.flags & (1u << 5u)) != 0u;
    let crosshatch_color = (in.flags & (1u << 6u)) != 0u;

    // Horizontal line mask.
    let line_lo_px = in.half_size_px.y - (line_thickness_px * 0.5);
    let line_hi_px = -in.half_size_px.y + (line_thickness_px * 0.5);
    let line_px = select(line_lo_px, line_hi_px, draw_line_high);
    let dist_y = abs(in.pill_local_px.y - line_px);
    let aa_y = fwidth(dist_y);
    let line_mask = 1.0 - smoothstep(line_thickness_px * 0.5 - aa_y, line_thickness_px * 0.5 + aa_y, dist_y);

    // Vertical edge mask.
    let edge_x = in.half_size_px.x - (line_thickness_px * 0.5);
    let dist_x = abs(in.pill_local_px.x - edge_x);
    let aa_x = fwidth(dist_x);
    let edge_mask_raw = 1.0 - smoothstep(line_thickness_px * 0.5 - aa_x, line_thickness_px * 0.5 + aa_x, dist_x);
    let edge_mask = select(0.0, edge_mask_raw, draw_edge);
    let stroke_mask = max(line_mask, edge_mask);

    // Calculate shading.
    let hatch_primary = select(x_color, z_color, crosshatch_color);
    let line_color = primary_color; // select(primary_color, hatch_primary, enable_crosshatch);
    let shade_color = select(lo_color, hi_color, draw_line_high);

    let stripe_mask = hatch(in.pill_local_px);
    let hatch_alpha = hatch_primary.a * stripe_mask;
    let hatch_color = vec4f(hatch_primary.rgb, hatch_alpha);
    let fill_color = select(shade_color, hatch_color, enable_crosshatch);
    let fill = vec4f(fill_color.rgb, fill_color.a * f32(enable_fill));

    let color = mix(fill, line_color, stroke_mask);
    return color;
}

@vertex
fn vs_multi(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexData {
    let gap_px = 2.0 * viewport.dpr;

    let segment = segments[ii];
    let row = segment.row_flags & 0xffffu;
    let enable_crosshatch = (segment.value_msb) != 0u;
    let crosshatch_color = (segment.value_lsb) != 0u;

    // Synthesize vertices for a triangle strip rect in [0, 1]^2.
    let corner_x = f32(vi & 1u);
    let corner_y = f32((vi >> 1u) & 1u);

    // Transform from timeline (tick) space into pixel space.
    let local_ticks = vec2i(i32(segment.t_start), i32(segment.t_end)) - i32(viewport.start_ticks);
    var pixel_bounds = vec2f(local_ticks) / viewport.ticks_per_pixel;

    // Apply the inset gap for pills.
    pixel_bounds += vec2f(gap_px * 0.5, -gap_px * 0.5);

    // Compute the pill's center and half-size in pixels.
    let center_px = vec2f((pixel_bounds[0] + pixel_bounds[1]) * 0.5, viewport.row_height * (f32(row) + 0.5));
    let half_size_px = vec2f((pixel_bounds[1] - pixel_bounds[0]) * 0.5, (viewport.row_height - gap_px) * 0.5);

    // Compute the vertex position in pixel space.
    let corner = vec2f(corner_x, corner_y);
    let signed_corner = corner * 2.0 - 1.0;
    let vertex_local_px = (corner * 2.0 - 1.0) * half_size_px;
    let vertex_px = center_px + vertex_local_px;

    // Convert vertex position to clip space.
    let clip_x = vertex_px.x / viewport.width * 2.0 - 1.0;
    let clip_y = 1.0 - vertex_px.y / viewport.height * 2.0;

    // Shader (instance uniform) rendering flags.
    var flags = 0u;
    flags |= (segment.row_flags >> 16u) & 0xfu;
    flags |= u32(enable_crosshatch) << 5u;
    flags |= u32(crosshatch_color) << 6u;

    return VertexData(vec4f(clip_x, clip_y, 0.0, 1.0), vertex_local_px, half_size_px, flags);
}

@fragment
fn fs_multi(in: VertexData) -> @location(0) vec4f {
    let radius = 2.0 * viewport.dpr;
    let border_width = 1.0 * viewport.dpr;
    let primary_color = vec4f(0.447, 0.482, 0.961, 1.0);
    let x_color = vec4f(0.9608, 0.4471, 0.4471, 1.0);
    let z_color = vec4f(0.47, 0.47, 0.47, 1.0);

    let enable_fill = (in.flags & (1u << 0u)) != 0u;
    let enable_crosshatch = (in.flags & (1u << 5u)) != 0u;
    let crosshatch_color = (in.flags & (1u << 6u)) != 0u;

    // Calculate masks for rounded corner, edge, fill based on SDF.
    let d_px = sdf(in.pill_local_px, in.half_size_px, radius);
    let aa = fwidth(d_px);
    let inside_mask = 1.0 - smoothstep(-aa, 0.0, d_px);
    let border_mask = smoothstep(-border_width - aa, -border_width, d_px) * (1.0 - smoothstep(-aa, 0.0, d_px));
    let fill_mask = 1.0 - smoothstep(-border_width - aa, -border_width, d_px);

    // Calculate shading.
    let line_color = primary_color;
    let shade_color = vec4f(line_color.rgb, line_color.a * 0.7);

    let stripe_mask = hatch(in.pill_local_px);
    let hatch_primary = select(x_color, z_color, crosshatch_color);
    let hatch_alpha = hatch_primary.a * stripe_mask;
    let hatch_color = vec4f(hatch_primary.rgb, hatch_alpha);
    let fill_color = select(shade_color, hatch_color, enable_crosshatch);
    let fill = vec4f(fill_color.rgb, fill_color.a * f32(enable_fill));

    let final_color = line_color * border_mask + fill * fill_mask;
    let final_alpha = border_mask + fill_color.a * fill_mask;
    return vec4f(final_color.r, final_color.g, final_color.b, final_alpha);
}
