// Text overlay. Instanced quad per glyph. Samples a pre-built ASCII atlas
// (single row, 95 cells for codepoints 0x20..0x7E) and alpha-blends on top
// of whatever was previously rendered in the pass.

struct Viewport {
    ticks_per_pixel: f32,
    start_ticks: u32,
    width: f32,
    height: f32,
    row_height: f32,
    dpr: f32,
    selected_row: i32,
}

struct Glyph {
    pos_x: f32,        // CSS px, top-left of the glyph cell
    pos_y: f32,        // CSS px
    char_code: u32,    // ascii codepoint; shader maps to atlas column
    color_rgba: u32,   // 8-bit packed rgba
}

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<storage, read> glyphs: array<Glyph>;
@group(0) @binding(2) var atlas_tex: texture_2d<f32>;
@group(0) @binding(3) var atlas_samp: sampler;

override cell_w_px: f32 = 7.0;
override cell_h_px: f32 = 14.0;
override atlas_first: f32 = 32.0;   // 0x20
override atlas_count: f32 = 95.0;   // 0x7E - 0x20 + 1

struct VertexData {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) color: vec4f,
}

fn unpack_rgba(p: u32) -> vec4f {
    return vec4f(
        f32((p >>  0u) & 0xffu),
        f32((p >>  8u) & 0xffu),
        f32((p >> 16u) & 0xffu),
        f32((p >> 24u) & 0xffu),
    ) / 255.0;
}

@vertex
fn vs_text(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexData {
    let g = glyphs[ii];

    // Triangle-strip quad corners in [0,1]^2.
    let corner_x = f32(vi & 1u);
    let corner_y = f32((vi >> 1u) & 1u);

    // Vertex position in CSS pixels (clip-space mapping same as digital.wgsl).
    let vertex_px = vec2f(g.pos_x + corner_x * cell_w_px, g.pos_y + corner_y * cell_h_px);
    let clip_x = vertex_px.x / viewport.width * 2.0 - 1.0;
    let clip_y = 1.0 - vertex_px.y / viewport.height * 2.0;

    // Atlas is one row of atlas_count cells. U = (col + corner_x) / atlas_count.
    let col = f32(g.char_code) - atlas_first;
    let u = (col + corner_x) / atlas_count;
    let v = corner_y;

    return VertexData(vec4f(clip_x, clip_y, 0.0, 1.0), vec2f(u, v), unpack_rgba(g.color_rgba));
}

@fragment
fn fs_text(in: VertexData) -> @location(0) vec4f {
    let sample = textureSample(atlas_tex, atlas_samp, in.uv);
    // Atlas stores white glyphs on transparent background (non-premultiplied).
    // Coverage lives in .a; multiply by the per-glyph tint.
    let coverage = sample.a;
    return vec4f(in.color.rgb, in.color.a * coverage);
}
