// Layout + interaction constants shared by the wave canvas (and later the
// active-signal rows / toolbar). CSS px — see the DPR contract in CLAUDE.md;
// these are NOT multiplied by dpr.

// Active-signal / ruler row height. Mirrors the --row-h CSS var so canvas rows
// line up with the DOM .s-row / .s-head rows. This is the per-row DEFAULT; rows
// can be individually resized (ActiveSignalRef.height) — double-click the row
// resize handle to return to this.
export const ROW_HEIGHT_CSS = 28;
// Clamp for per-row vertical resizing (drag handle on each .s-row).
export const ROW_MIN_HEIGHT_CSS = 18;
export const ROW_MAX_HEIGHT_CSS = 200;

// Extra vertical space inserted below a row that carries `dividerBelow`. Mirrors
// the .s-divider element height so the canvas gap stays aligned with the DOM list.
// This is the DEFAULT; a divider can be individually resized (dividerHeight).
export const DIVIDER_HEIGHT_CSS = 16;
// Clamp for dragging a divider's resize handle.
export const DIVIDER_MIN_HEIGHT_CSS = 6;
export const DIVIDER_MAX_HEIGHT_CSS = 200;

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

// Viewport-windowed repack hysteresis (see WaveCanvas frame loop): repack once a
// zoom-OUT widens the visible tick span past ZOOM_OUT_FACTOR× the packed density,
// or a zoom-IN leaves the packed window more than WINDOW_SHRINK_FACTOR× wider than
// the visible span.
export const ZOOM_OUT_FACTOR = 1.5; // repack once the view is this much more zoomed out
export const WINDOW_SHRINK_FACTOR = 6; // re-window when packed span exceeds this × visible
