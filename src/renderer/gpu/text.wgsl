// Text overlay. Instanced quad per glyph. Two pre-built atlases (ASCII
// 0x20..0x7E plus one middle-dot slot): one large, one small. Per-glyph flag picks
// which atlas + cell metrics to use.

struct Viewport {
    ticks_per_pixel: f32,
    start_ticks: f32,
    width: f32,
    height: f32,
    row_height: f32,
    dpr: f32,
    selected_row: i32,
    wave_y_offset: f32,
}

struct Glyph {
    pos_x: f32,        // CSS px, top-left of the glyph cell
    pos_y: f32,        // CSS px
    char_code: u32,    // [6:0] codepoint, [7] = use small atlas
    color_rgba: u32,
}

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<storage, read> glyphs: array<Glyph>;
@group(0) @binding(2) var atlas_lg: texture_2d<f32>;
@group(0) @binding(3) var atlas_sm: texture_2d<f32>;
@group(0) @binding(4) var atlas_samp: sampler;

override cell_w_lg: f32 = 7.0;
override cell_h_lg: f32 = 14.0;
override cell_w_sm: f32 = 6.0;
override cell_h_sm: f32 = 12.0;
override atlas_first: f32 = 32.0;
override atlas_count: f32 = 95.0;

struct VertexData {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) color: vec4f,
    @location(2) @interpolate(flat) small: u32,
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
fn vs_text(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexData {
    let g = glyphs[ii];
    let code = g.char_code & 0x7fu;
    let small = (g.char_code >> 7u) & 1u;

    let corner_x = f32(vi & 1u);
    let corner_y = f32((vi >> 1u) & 1u);

    let cell_w = select(cell_w_lg, cell_w_sm, small != 0u);
    let cell_h = select(cell_h_lg, cell_h_sm, small != 0u);

    let vertex_px = vec2f(g.pos_x + corner_x * cell_w, g.pos_y + corner_y * cell_h);
    let clip_x = vertex_px.x / viewport.width * 2.0 - 1.0;
    let clip_y = 1.0 - vertex_px.y / viewport.height * 2.0;

    let col = f32(code) - atlas_first;
    let u = (col + corner_x) / atlas_count;
    let v = corner_y;

    return VertexData(vec4f(clip_x, clip_y, 0.0, 1.0), vec2f(u, v), unpack_rgba(g.color_rgba), small);
}

@fragment
fn fs_text(in: VertexData) -> @location(0) vec4f {
    let s_lg = textureSample(atlas_lg, atlas_samp, in.uv);
    let s_sm = textureSample(atlas_sm, atlas_samp, in.uv);
    let sample = select(s_lg, s_sm, in.small != 0u);
    return vec4f(in.color.rgb, in.color.a * sample.a);
}
