import { GPUContext } from "./device";
import WGSL from "./text.wgsl";

export const ATLAS_FIRST = 0x20;
export const ATLAS_LAST = 0x7e;
export const ATLAS_COUNT = ATLAS_LAST - ATLAS_FIRST + 1; // 95

export const MAX_GLYPHS = 4096;
const GLYPH_U32 = 4; // 16 B per glyph
const GLYPH_BYTES = GLYPH_U32 * 4;

export interface GlyphCell {
  widthPx: number;    // CSS px cell width
  heightPx: number;   // CSS px cell height
  ascentPx: number;   // baseline offset from the top of the cell in CSS px
  midlinePx: number;  // cap-height midline offset from cell top in CSS px
}

export interface TextRenderer {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  atlasTexture: GPUTexture;
  cell: GlyphCell;
  setGlyphs(count: number): void;
  writeGlyph(i: number, xPx: number, yPx: number, charCode: number, rgba: number): void;
  glyphCount: number;
}

const FONT_FAMILY = "'JetBrains Mono', ui-monospace, monospace";

async function ensureFontLoaded(fontSpec: string): Promise<void> {
  const fonts = (globalThis as { document?: { fonts?: FontFaceSet } }).document?.fonts;
  if (!fonts) return;
  try {
    await fonts.load(fontSpec);
  } catch {
    // Font fetch failed — fall back to system monospace. Atlas will still build.
  }
}

interface AtlasBuild {
  canvas: OffscreenCanvas;
  cellWCSS: number;
  cellHCSS: number;
  ascentCSS: number;
  midlineCSS: number;
}

function buildAtlasCanvas(displayPx: number, dpr: number): AtlasBuild {
  // Render the atlas at 4x device resolution. Bilinear sampling aliases at
  // this ratio (ideal would be mipmaps or 2x), but in practice the softness
  // is preferable to the pixel-hinting artifacts Canvas 2D produces at
  // small sizes.
  const scale = 2 * dpr;
  const fontPx = displayPx * scale;
  const fontSpec = `700 ${fontPx}px ${FONT_FAMILY}`;

  const probe = new OffscreenCanvas(64, 64);
  const pc = probe.getContext("2d");
  if (!pc) throw new Error("OffscreenCanvas 2D context unavailable");
  pc.font = fontSpec;
  const advance = Math.ceil(pc.measureText("M").width);
  const cap = pc.measureText("M");
  const capAscent = Math.ceil(cap.actualBoundingBoxAscent || fontPx * 0.72);
  // Tall probe to reserve descender space for e.g. "g", "p".
  const tall = pc.measureText("Mgy");
  const descent = Math.ceil(tall.actualBoundingBoxDescent || fontPx * 0.2);

  const padTop = 2;
  const padBottom = 2;
  const cellW = advance + 2;
  const cellH = capAscent + descent + padTop + padBottom;
  const baselineY = padTop + capAscent;
  const midlineY = padTop + capAscent * 0.5;

  const canvas = new OffscreenCanvas(cellW * ATLAS_COUNT, cellH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
  ctx.font = fontSpec;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < ATLAS_COUNT; i++) {
    const ch = String.fromCharCode(ATLAS_FIRST + i);
    ctx.fillText(ch, i * cellW + 1, baselineY);
  }

  return {
    canvas,
    cellWCSS: cellW / scale,
    cellHCSS: cellH / scale,
    ascentCSS: baselineY / scale,
    midlineCSS: midlineY / scale,
  };
}

export async function createTextRenderer(
  ctx: GPUContext,
  viewportUniform: GPUBuffer,
  opts?: { displayPx?: number; dpr?: number },
): Promise<TextRenderer> {
  const { device, format } = ctx;
  const displayPx = opts?.displayPx ?? 12;
  const dpr = opts?.dpr ?? (globalThis.devicePixelRatio || 1);

  // Ensure the web font is resident before Canvas 2D rasterizes glyphs.
  // Without this, small atlases render in the system fallback font, which
  // produces ugly pixel-hinted output at 11 px — and at 1:1 sampling there's
  // no oversample average to hide it, so it reads as noise.
  const fontPx = displayPx * dpr;
  await ensureFontLoaded(`700 ${fontPx}px ${FONT_FAMILY}`);

  const atlas = buildAtlasCanvas(displayPx, dpr);

  const atlasTexture = device.createTexture({
    size: [atlas.canvas.width, atlas.canvas.height, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: atlas.canvas, flipY: false },
    { texture: atlasTexture, premultipliedAlpha: false },
    [atlas.canvas.width, atlas.canvas.height, 1],
  );

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "nearest",
  });

  const module = device.createShaderModule({ code: WGSL });

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });

  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const constants = {
    cell_w_px: atlas.cellWCSS,
    cell_h_px: atlas.cellHCSS,
    atlas_first: ATLAS_FIRST,
    atlas_count: ATLAS_COUNT,
  };

  const pipeline = await device.createRenderPipelineAsync({
    layout,
    vertex: { module, entryPoint: "vs_text", constants },
    fragment: {
      module,
      entryPoint: "fs_text",
      constants,
      targets: [{
        format,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }],
    },
    primitive: { topology: "triangle-strip" },
  });

  const instanceBuf = device.createBuffer({
    size: MAX_GLYPHS * GLYPH_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const scratch = new Uint32Array(MAX_GLYPHS * GLYPH_U32);
  const scratchF32 = new Float32Array(scratch.buffer);

  const bindGroup = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: viewportUniform } },
      { binding: 1, resource: { buffer: instanceBuf } },
      { binding: 2, resource: atlasTexture.createView() },
      { binding: 3, resource: sampler },
    ],
  });

  const renderer: TextRenderer = {
    pipeline,
    bindGroup,
    atlasTexture,
    cell: { widthPx: atlas.cellWCSS, heightPx: atlas.cellHCSS, ascentPx: atlas.ascentCSS, midlinePx: atlas.midlineCSS },
    glyphCount: 0,
    writeGlyph(i, xPx, yPx, charCode, rgba) {
      const off = i * GLYPH_U32;
      scratchF32[off + 0] = xPx;
      scratchF32[off + 1] = yPx;
      scratch[off + 2] = charCode;
      scratch[off + 3] = rgba >>> 0;
    },
    setGlyphs(count) {
      if (count > MAX_GLYPHS) count = MAX_GLYPHS;
      renderer.glyphCount = count;
      if (count === 0) return;
      // Pass the Uint32Array + element count: size/offset semantics are
      // unambiguous this way (element units, not bytes).
      device.queue.writeBuffer(instanceBuf, 0, scratch, 0, count * GLYPH_U32);
    },
  };

  return renderer;
}

// Pack 0..255 channels little-endian to match WGSL byte extraction.
export function packRgba(r: number, g: number, b: number, a: number): number {
  return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}
