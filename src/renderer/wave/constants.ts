// Layout + interaction constants shared by the wave canvas (and later the
// active-signal rows / toolbar). CSS px — see the DPR contract in CLAUDE.md;
// these are NOT multiplied by dpr.

// Active-signal / ruler row height. Mirrors the --row-h CSS var so canvas rows
// line up with the DOM .s-row / .s-head rows.
export const ROW_HEIGHT_CSS = 28;

// Vertical-line thickness — MUST match the `thickness` literal in lines.wgsl.
export const LINE_THICKNESS_CSS = 2.5;
export const LINE_HALF_CSS = LINE_THICKNESS_CSS * 0.5;

export const NOTCH_HEIGHT = 12;
// Bottom ruler band height (matches index.html `.status { height: 24px }`).
export const BOTTOM_RULER_HEIGHT = 24;

// Pre-allocated marker pill/line pool size; pointer slop for grabbing a line.
export const MAX_MARKERS = 16;
export const MARKER_GRAB_PX = 5;

// Zoom: Math.exp() factor per wheel deltaY unit; button-zoom step + anim.
export const ZOOM_PER_DELTA_Y = 0.001;
export const ZOOM_STEP = 1.25;
export const ZOOM_ANIM_MS = 120;
