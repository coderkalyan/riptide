// Multi-bit value labels, instanced + GPU-culled. One instance per glyph; the
// label glyph buffer is built ONCE per repack (static), so per-frame CPU cost for
// labels is zero. The vertex shader positions each glyph from tick-space + the
// viewport uniform and self-culls — a guard collapses the quad to degenerate when
// its pill is too narrow to fit the text (the old CPU width check) or off-screen.
// See PERFORMANCE.md "Multi-bit value labels (loop 1.1)".

struct Viewport {
    ticks_per_pixel: f32,
    start_ticks_int: i32,
    start_ticks_frac: f32,
    width: f32,
    height: f32,
    row_height: f32,
    dpr: f32,
    _pad_sel: i32,
    wave_y_offset: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
}

// Mirrors segments.zig / digital.wgsl RowInfo (7×u32). `flags` (bit 0 = dim) and
// the per-row vertical placement (y_offset / height, f32 bits) are read here.
struct RowInfo {
    x0_offset: u32,
    x1_offset: u32,
    bytes_per_sample: u32,
    segment_start: u32,
    flags: u32,
    y_offset: u32,
    height: u32,
}
const ROW_FLAG_DIM: u32 = 1u << 0u;
// Bit 1 is highlight (digital.wgsl); labels ignore it.
const ROW_FLAG_LABEL_SM: u32 = 1u << 2u;

// One glyph of a label. t_start/t_end = the owning pill's tick span (for pixel
// width + center); packed = char_code[7:0] | glyph_index[15:8] | text_len[23:16].
// glyph_index is the character's column in the (monospace) label; text_len is the
// full label length (for centering). row indexes RowInfo for the dim flag + y.
struct LabelGlyph {
    t_start: u32,
    t_end: u32,
    row: u32,
    packed: u32,
}

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<storage, read> labels: array<LabelGlyph>;
@group(0) @binding(2) var<storage, read> rows: array<RowInfo>;
@group(0) @binding(3) var atlas_lg: texture_2d<f32>;
@group(0) @binding(4) var atlas_samp: sampler;
@group(0) @binding(5) var atlas_sm: texture_2d<f32>;

// Atlas/cell metrics (CSS px), supplied at pipeline build from both atlases. A row
// steps down to the small set when its typical pill stops fitting the large one —
// see labels.ts `retier`. Both atlases hold ATLAS_COUNT cells in the same order,
// so the UV is the same either way; only the cell size and the sampled texture
// differ.
override cell_w: f32 = 7.0;
override cell_h: f32 = 14.0;
override midline: f32 = 5.0;       // cap-height midline offset from cell top
override cell_w_sm: f32 = 6.0;
override cell_h_sm: f32 = 12.0;
override midline_sm: f32 = 4.0;
override cull_pad: f32 = 4.0;      // room a pill needs beyond its text, both ends
override atlas_first: f32 = 32.0;  // first codepoint in the atlas
override atlas_count: f32 = 95.0;  // atlas cell count

struct VertexData {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) color: vec3f,
    @location(2) @interpolate(flat) small: u32,
}

// All 4 strip verts return this coincident, z-clipped point → zero-area + culled.
const CULLED = vec4f(0.0, 0.0, 2.0, 1.0);

// Match CPU Math.round (round half up), not WGSL round() (half-to-even).
fn snap(x: f32) -> f32 { return floor(x + 0.5); }

@vertex
fn vs_label(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexData {
    let g = labels[ii];
    let char_code = g.packed & 0xffu;
    let glyph_index = (g.packed >> 8u) & 0xffu;
    let text_len = (g.packed >> 16u) & 0xffu;

    // tick-space → CSS px (same int/frac split as digital.wgsl, full precision
    // for tick values > 2^24).
    let start_px = (f32(i32(g.t_start) - viewport.start_ticks_int) - viewport.start_ticks_frac) / viewport.ticks_per_pixel;
    let end_px = (f32(i32(g.t_end) - viewport.start_ticks_int) - viewport.start_ticks_frac) / viewport.ticks_per_pixel;
    // The drawn pill body is inset on the right (digital.wgsl's xgap_px, itself
    // capped at a third of the segment), so its visible span is
    // [start_px, end_px - right_inset_px]. Cull and center against that drawn
    // width, not the full tick span.
    let right_inset_px = min(2.0, max(0.0, end_px - start_px) * (1.0 / 3.0));
    let body_end_px = end_px - right_inset_px;

    // Glyph size for this row. Uniform per row by construction (labels.ts decides
    // it from the row's mean pill span), so neighbouring pills never disagree.
    let small = (rows[g.row].flags & ROW_FLAG_LABEL_SM) != 0u;
    let cw = select(cell_w, cell_w_sm, small);
    let ch = select(cell_h, cell_h_sm, small);
    let ml = select(midline, midline_sm, small);
    let text_w = f32(text_len) * cw;

    // Center on the *visible* portion of the pill, not the full tick span: a
    // segment that runs off the left/right edge keeps its label centered in the
    // on-screen sliver (clamped to [0, width]) so it stays readable while
    // scrolling, instead of drifting off with the segment's true midpoint.
    let vis_start = max(start_px, 0.0);
    let vis_end = min(body_end_px, viewport.width);
    let vis_w = vis_end - vis_start;

    // Narrow-pill cull (was the CPU `widthPx < textWidthPx + 6` skip) — against
    // the visible width, so a too-thin on-screen sliver drops the label.
    if (vis_w < text_w + cull_pad) {
        return VertexData(CULLED, vec2f(0.0), vec3f(0.0), 0u);
    }

    let label_x0 = snap((vis_start + vis_end) * 0.5 - text_w * 0.5);
    let glyph_x = label_x0 + f32(glyph_index) * cw;

    // Off-screen cull (the CPU loop never did this — wide off-screen pills used to
    // emit glyphs the rasterizer then clipped).
    if (glyph_x + cw < 0.0 || glyph_x > viewport.width) {
        return VertexData(CULLED, vec2f(0.0), vec3f(0.0), 0u);
    }

    // Vertical center from the per-row layout (RowInfo.y_offset / .height).
    let row_y = bitcast<f32>(rows[g.row].y_offset);
    let row_h = bitcast<f32>(rows[g.row].height);
    let y0 = snap(row_y + row_h * 0.5 - ml);

    let corner_x = f32(vi & 1u);
    let corner_y = f32((vi >> 1u) & 1u);
    let vertex_px = vec2f(glyph_x + corner_x * cw, y0 + corner_y * ch);
    let clip_x = vertex_px.x / viewport.width * 2.0 - 1.0;
    let clip_y = 1.0 - vertex_px.y / viewport.height * 2.0;

    let col = f32(char_code) - atlas_first;
    let u = (col + corner_x) / atlas_count;
    let v = corner_y;

    // White, dimmed 50% toward the waveform bg when the row's eye is off (matches
    // CPU dimToBg). Read live from RowInfo.flags so the eye toggle needs no rebuild.
    let dimmed = (rows[g.row].flags & ROW_FLAG_DIM) != 0u;
    let bg = vec3f(0.106, 0.114, 0.129);
    let rgb = select(vec3f(1.0), mix(vec3f(1.0), bg, 0.5), dimmed);

    return VertexData(vec4f(clip_x, clip_y, 0.0, 1.0), vec2f(u, v), rgb, select(0u, 1u, small));
}

@fragment
fn fs_label(in: VertexData) -> @location(0) vec4f {
    // Both atlases are sampled and one selected: WGSL cannot index a texture
    // binding dynamically, and the choice varies per row inside a single draw.
    let lg = textureSample(atlas_lg, atlas_samp, in.uv);
    let sm = textureSample(atlas_sm, atlas_samp, in.uv);
    let s = select(lg, sm, in.small != 0u);
    return vec4f(in.color, s.a);
}
