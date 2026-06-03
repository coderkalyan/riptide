// Packed-rgba color constants + text-color helpers used by the wave canvas and
// the DOM marker pills. packRgba packs 0xAABBGGRR (LE channels) — see gpu/text.
import { packRgba } from "../../renderer/gpu/text";

export const TEXT_WHITE = packRgba(0xff, 0xff, 0xff, 0xff);
export const TEXT_DARK = packRgba(0x14, 0x15, 0x17, 0xff); // matches --bg
export const TEXT_SECONDARY = packRgba(0xc4, 0xc3, 0xbb, 0xff);
export const ON_ACCENT = packRgba(0x0f, 0x1a, 0x09, 0xff);
export const PANEL_2 = packRgba(0x22, 0x25, 0x2a, 0xff);
export const BORDER = packRgba(0x2f, 0x33, 0x3a, 0xff);
export const HOT = packRgba(0xf0, 0x6b, 0x5b, 0xff);
export const MARKER = packRgba(0x4f, 0xd2, 0xbd, 0xff);

// Cycled per new marker so adjacent markers read apart. Avoids HOT (cursor red).
export const MARKER_PALETTE = [
  MARKER,                            // teal
  packRgba(0xe8, 0xb3, 0x4f, 0xff),  // amber
  packRgba(0xb4, 0x8c, 0xff, 0xff),  // purple
  packRgba(0x72, 0xf5, 0xb4, 0xff),  // green
  packRgba(0x72, 0x7b, 0xf5, 0xff),  // blue
];

export const GRID_GRAY = packRgba(0x86, 0x8c, 0x96, 0x70);
export const DEAD_ZONE_GRAY = packRgba(0x78, 0x7c, 0x86, 0x70);
export const RESET_RED = packRgba(0xe8, 0x6a, 0x5a, 0x60);
export const RESET_TEXT = packRgba(0xf0, 0x6b, 0x5b, 0xff); // solid, for the "RESET" label
export const NOTCH_COLOR = packRgba(0x86, 0x8c, 0x96, 0xff);

// Pick the higher-contrast text color (white vs near-black bg) against a pill's
// effective fill. Pills render at ~70% color over the dark bg when not selected,
// so pre-blend before measuring luminance.
const PILL_BLEND = 0.7;
const BG_LUM = 0.2126 * 0.106 + 0.7152 * 0.114 + 0.0722 * 0.129;
export function pickTextColor(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const colorLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fillLum = (1 - PILL_BLEND) * BG_LUM + PILL_BLEND * colorLum;
  return fillLum > 0.5 ? TEXT_DARK : TEXT_WHITE;
}

// Unpack a packRgba color (r in LSB) back to a CSS hex string for DOM pills, so
// marker pills in the toolbar match the marker flags drawn on the canvas.
export function markerColorCss(packed: number): string {
  const r = packed & 0xff, g = (packed >> 8) & 0xff, b = (packed >> 16) & 0xff;
  return `#${(0x1000000 | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
