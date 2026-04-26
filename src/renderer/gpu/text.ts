import { GPUContext } from "./device";
import WGSL from "./text.wgsl";

export const ATLAS_FIRST = 0x20;
export const ATLAS_LAST = 0x7e;
export const ATLAS_MIDDLE_DOT = 0x00b7;
const ATLAS_EXTRA_CODE = 0x7f;
export const ATLAS_COUNT = ATLAS_LAST - ATLAS_FIRST + 2; // ASCII + middle dot

export const MAX_GLYPHS = 4096;
const GLYPH_U32 = 4; // 16 B per glyph
const GLYPH_BYTES = GLYPH_U32 * 4;

const SMALL_FLAG_BIT = 0x80; // packed into Glyph.char_code's high bit

export interface GlyphCell {
  widthPx: number;    // CSS px cell width
  heightPx: number;   // CSS px cell height
  ascentPx: number;   // baseline offset from cell top in CSS px
  midlinePx: number;  // cap-height midline offset from cell top in CSS px
}

export interface TextBatch {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  glyphCount: number;
  /** `small` selects the smaller atlas (cursor-flag font). */
  writeGlyph(i: number, xPx: number, yPx: number, charCode: number, rgba: number, small?: boolean): void;
  setGlyphs(count: number): void;
}

export interface TextRenderer {
  pipeline: GPURenderPipeline;
  cellLg: GlyphCell;
  cellSm: GlyphCell;
  createBatch(): TextBatch;
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

function buildAtlasCanvas(displayPx: number, dpr: number, fontWeight: string): AtlasBuild {
  // 2x device-pixel resolution: bilinear handles the 2:1 downsample cleanly,
  // and Canvas 2D has room to produce real grayscale AA.
  const scale = 2 * dpr;
  const fontPx = displayPx * scale;
  const fontSpec = `${fontWeight} ${fontPx}px ${FONT_FAMILY}`;

  // `willReadFrequently: true` forces a software-backed bitmap. The default
  // GPU-accelerated path can return uninitialized GPU memory for certain
  // size/weight combinations when read back via convertToBlob /
  // copyExternalImageToTexture — symptom is colored noise where text should
  // be. Software backing is deterministic.
  const probe = new OffscreenCanvas(64, 64);
  const pc = probe.getContext("2d", { willReadFrequently: true });
  if (!pc) throw new Error("OffscreenCanvas 2D context unavailable");
  pc.font = fontSpec;
  const advance = Math.ceil(pc.measureText("M").width);
  const capAscent = Math.ceil(pc.measureText("M").actualBoundingBoxAscent || fontPx * 0.72);
  const tall = pc.measureText("Mgy");
  const descent = Math.ceil(tall.actualBoundingBoxDescent || fontPx * 0.2);

  const padTop = 2;
  const padBottom = 2;
  const cellW = advance + 2;
  const cellH = capAscent + descent + padTop + padBottom;
  const baselineY = padTop + capAscent;
  const midlineY = padTop + capAscent * 0.5;

  const canvas = new OffscreenCanvas(cellW * ATLAS_COUNT, cellH);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");

  ctx.font = fontSpec;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < ATLAS_COUNT; i++) {
    const code = i <= ATLAS_LAST - ATLAS_FIRST ? ATLAS_FIRST + i : ATLAS_MIDDLE_DOT;
    const ch = String.fromCharCode(code);
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

function uploadAtlas(device: GPUDevice, atlas: AtlasBuild): GPUTexture {
  const tex = device.createTexture({
    size: [atlas.canvas.width, atlas.canvas.height, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: atlas.canvas, flipY: false },
    { texture: tex, premultipliedAlpha: false },
    [atlas.canvas.width, atlas.canvas.height, 1],
  );
  return tex;
}

function cellOf(a: AtlasBuild): GlyphCell {
  return { widthPx: a.cellWCSS, heightPx: a.cellHCSS, ascentPx: a.ascentCSS, midlinePx: a.midlineCSS };
}

export interface TextOptions {
  large?: { displayPx: number; weight: string };
  small?: { displayPx: number; weight: string };
  dpr?: number;
}

export async function createTextRenderer(
  ctx: GPUContext,
  viewportUniform: GPUBuffer,
  opts?: TextOptions,
): Promise<TextRenderer> {
  const { device, format } = ctx;
  const dpr = opts?.dpr ?? (globalThis.devicePixelRatio || 1);
  const lg = opts?.large ?? { displayPx: 12, weight: "700" };
  const sm = opts?.small ?? { displayPx: 10, weight: "400" };

  await Promise.all([
    ensureFontLoaded(`${lg.weight} ${lg.displayPx * dpr}px ${FONT_FAMILY}`),
    ensureFontLoaded(`${sm.weight} ${sm.displayPx * dpr}px ${FONT_FAMILY}`),
  ]);

  const atlasLg = buildAtlasCanvas(lg.displayPx, dpr, lg.weight);
  const atlasSm = buildAtlasCanvas(sm.displayPx, dpr, sm.weight);
  const texLg = uploadAtlas(device, atlasLg);
  const texSm = uploadAtlas(device, atlasSm);

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
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });

  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const constants = {
    cell_w_lg: atlasLg.cellWCSS,
    cell_h_lg: atlasLg.cellHCSS,
    cell_w_sm: atlasSm.cellWCSS,
    cell_h_sm: atlasSm.cellHCSS,
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

  const lgView = texLg.createView();
  const smView = texSm.createView();

  function createBatch(): TextBatch {
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
        { binding: 2, resource: lgView },
        { binding: 3, resource: smView },
        { binding: 4, resource: sampler },
      ],
    });

    const batch: TextBatch = {
      pipeline,
      bindGroup,
      glyphCount: 0,
      writeGlyph(i, xPx, yPx, charCode, rgba, small) {
        const off = i * GLYPH_U32;
        const atlasCode = charCode === ATLAS_MIDDLE_DOT ? ATLAS_EXTRA_CODE : charCode;
        scratchF32[off + 0] = xPx;
        scratchF32[off + 1] = yPx;
        scratch[off + 2] = (atlasCode & 0x7f) | (small ? SMALL_FLAG_BIT : 0);
        scratch[off + 3] = rgba >>> 0;
      },
      setGlyphs(count) {
        if (count > MAX_GLYPHS) count = MAX_GLYPHS;
        batch.glyphCount = count;
        if (count === 0) return;
        device.queue.writeBuffer(instanceBuf, 0, scratch, 0, count * GLYPH_U32);
      },
    };
    return batch;
  }

  return {
    pipeline,
    cellLg: cellOf(atlasLg),
    cellSm: cellOf(atlasSm),
    createBatch,
  };
}

// Pack 0..255 channels little-endian to match WGSL byte extraction.
export function packRgba(r: number, g: number, b: number, a: number): number {
  return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}
