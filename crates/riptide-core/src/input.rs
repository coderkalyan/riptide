//! Pointer/wheel/key → cursor placement, marker drag, hover, pan/zoom.
//! Port of the `WaveCanvas.tsx` event handlers: `tickAtClientX` with the
//! LINE_HALF_CSS centering bias, clock-edge snap, marker grab via [`MarkerHit`]
//! boxes (built by the geometry builder), the hover row walk over per-row
//! heights/dividers, and the wheel pan/zoom routing.
//!
//! OWNED BY UNIT U4 (with `viewport.rs`). Consumes
//! `riptide_contract::ipc::InputEvent`, drives the [`Viewport`], and emits
//! `UiEvent`s rather than mutating any store. Text payloads (`CursorMoved`
//! labels, `HoverChanged` time/value text, `CursorMoved` row values) are left
//! empty — integration (U15) fills them via the format/value layers.

use riptide_contract::doc::MarkerDto;
use riptide_contract::geometry::MarkerHit;
use riptide_contract::ipc::{InputEvent, KeyCode, UiEvent};
use riptide_contract::spec::{ClockGrid, RowSpec};

use crate::viewport::{LINE_HALF_CSS, Viewport, ZOOM_PER_DELTA_Y, ZOOM_STEP};

// --- constants (mirrors src/renderer/wave/constants.ts) ----------------------

/// Active-signal / ruler row height (default; rows can be resized per-row).
pub const ROW_HEIGHT_CSS: f64 = 28.0;
/// Extra vertical gap below a row carrying `divider_below` (default).
pub const DIVIDER_HEIGHT_CSS: f64 = 16.0;
/// Pointer slop for grabbing a marker line.
pub const MARKER_GRAB_PX: f64 = 5.0;

/// Per-event read-only context: the doc/geometry state the handlers consult.
/// All references point at engine-owned state; nothing here is mutated.
pub struct InputCtx<'a> {
    /// Injected time (for the viewport's history coalescing / animations).
    pub now_ms: f64,
    /// Active rows in list order (the hover walk uses heights/dividers).
    pub rows: &'a [RowSpec],
    /// Markers from the doc mirror (cycle keys).
    pub markers: &'a [MarkerDto],
    pub selected_marker: Option<u32>,
    /// Last frame's marker pill/line hit boxes from the geometry builder.
    pub marker_hits: &'a [MarkerHit],
    /// Snap the cursor (and marker drags) to the clock grid.
    pub snap_cursor: bool,
    /// The detected/overridden timebase grid (provided by the caller; this
    /// module never runs detection).
    pub clock_grid: Option<ClockGrid>,
}

/// Transient drag state across pointer events (the `dragging` /
/// `draggingMarker` locals in WaveCanvas).
#[derive(Debug, Default)]
pub struct InputState {
    dragging_cursor: bool,
    dragging_marker: Option<u32>,
}

// --- pure helpers (exposed for the geometry builder / tests) -----------------

/// `snapToClockEdge` (wave/format.ts): nearest `phase + k·period`. Uses
/// `floor(x + 0.5)` to match JS `Math.round` (half-up) exactly.
pub fn snap_to_clock_edge(tick: f64, grid: &ClockGrid) -> f64 {
    ((tick - grid.phase) / grid.period + 0.5).floor() * grid.period + grid.phase
}

/// `tickAtClientX`: canvas-relative x → logical tick, with the LINE_HALF_CSS
/// centering bias (the hover guide is centered on the pointer while lines are
/// left-aligned; the same bias here makes click-to-place land exactly where
/// the centered hover line sat — see the alignment contract in CLAUDE.md).
/// Snaps to the clock grid when enabled.
pub fn tick_at_x(vp: &Viewport, x: f64, snap_cursor: bool, grid: Option<&ClockGrid>) -> f64 {
    let px = x.clamp(0.0, vp.timeline_px()) - LINE_HALF_CSS;
    let tick = vp.start_ticks() + px * vp.ticks_per_pixel();
    match grid {
        Some(g) if snap_cursor && g.period > 0.0 => snap_to_clock_edge(tick, g),
        _ => tick,
    }
}

/// The hover tick: same bias as [`tick_at_x`] but never snapped (`updateHover`
/// reports the raw pointer time).
pub fn hover_tick(vp: &Viewport, x: f64) -> f64 {
    let px = x.clamp(0.0, vp.timeline_px()) - LINE_HALF_CSS;
    vp.start_ticks() + px * vp.ticks_per_pixel()
}

/// Marker grab test (`markerAt`): inside the flag pill (top ruler band) or
/// within MARKER_GRAB_PX of the line's visual center
/// (`line_x + LINE_HALF_CSS` — `line_x` is the left edge).
pub fn marker_at(hits: &[MarkerHit], x: f64, y: f64) -> Option<u32> {
    for h in hits {
        let in_pill = y <= ROW_HEIGHT_CSS && x >= f64::from(h.x0) && x <= f64::from(h.x1);
        let on_line = (x - (f64::from(h.line_x) + LINE_HALF_CSS)).abs() <= MARKER_GRAB_PX;
        if in_pill || on_line {
            return Some(h.id);
        }
    }
    None
}

/// The hover row walk (`updateHover`): rows stack below the ruler band; each
/// row contributes its own height (default ROW_HEIGHT_CSS) plus any divider
/// gap below it (no row there). Returns the row's list index, or -1 (ruler,
/// divider gap, or below the last row).
pub fn hover_row(rows: &[RowSpec], py: f64) -> i32 {
    let mut y = ROW_HEIGHT_CSS; // the ruler band
    for (i, r) in rows.iter().enumerate() {
        let h = r.height.map_or(ROW_HEIGHT_CSS, f64::from);
        if py >= y && py < y + h {
            return i as i32;
        }
        let gap = if r.divider_below {
            r.divider_height.map_or(DIVIDER_HEIGHT_CSS, f64::from)
        } else {
            0.0
        };
        y += h + gap;
    }
    -1
}

fn cursor_moved(tick: f64) -> UiEvent {
    // label + row_values are filled at integration (format/value layers).
    UiEvent::CursorMoved { tick, label: String::new(), row_values: Vec::new() }
}

fn viewport_changed(vp: &Viewport, settled: bool) -> UiEvent {
    UiEvent::ViewportChanged { start: vp.start_ticks(), end: vp.view_end(), settled }
}

impl InputState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Route one raw input event: drive the viewport, return the UI events to
    /// push. Mirrors the WaveCanvas listeners one-to-one.
    pub fn on_event(&mut self, ev: &InputEvent, vp: &mut Viewport, ctx: &InputCtx) -> Vec<UiEvent> {
        match *ev {
            InputEvent::PointerDown { x, y, button, .. } => {
                self.pointer_down(f64::from(x), f64::from(y), button, vp, ctx)
            }
            InputEvent::PointerMove { x, y, .. } => {
                self.pointer_move(f64::from(x), f64::from(y), vp, ctx)
            }
            InputEvent::PointerUp { .. } => {
                self.dragging_marker = None;
                self.dragging_cursor = false;
                Vec::new()
            }
            InputEvent::PointerLeave => vec![UiEvent::HoverCleared],
            InputEvent::Wheel { x, dx, dy, ctrl, .. } => {
                self.wheel(f64::from(x), f64::from(dx), f64::from(dy), ctrl, vp, ctx)
            }
            InputEvent::Key { code, .. } => self.key(code, vp, ctx),
        }
    }

    /// Left button only: grab a marker (select it, start its drag) or place
    /// the cursor and start a cursor drag.
    fn pointer_down(
        &mut self,
        x: f64,
        y: f64,
        button: i16,
        vp: &Viewport,
        ctx: &InputCtx,
    ) -> Vec<UiEvent> {
        if button != 0 {
            return Vec::new();
        }
        if let Some(id) = marker_at(ctx.marker_hits, x, y) {
            self.dragging_marker = Some(id);
            vec![UiEvent::MarkerSelected { id: Some(id) }]
        } else {
            self.dragging_cursor = true;
            vec![cursor_moved(tick_at_x(vp, x, ctx.snap_cursor, ctx.clock_grid.as_ref()))]
        }
    }

    /// Hover always updates (even mid-drag, like the TS handler); then the
    /// active drag (marker beats cursor) emits its move.
    fn pointer_move(&mut self, x: f64, y: f64, vp: &Viewport, ctx: &InputCtx) -> Vec<UiEvent> {
        let mut out = vec![UiEvent::HoverChanged {
            tick: hover_tick(vp, x),
            row: hover_row(ctx.rows, y),
            time_label: String::new(), // filled at integration
            value_text: String::new(), // filled at integration
        }];
        if let Some(id) = self.dragging_marker {
            out.push(UiEvent::MarkerMoved {
                id,
                tick: tick_at_x(vp, x, ctx.snap_cursor, ctx.clock_grid.as_ref()),
            });
        } else if self.dragging_cursor {
            out.push(cursor_moved(tick_at_x(vp, x, ctx.snap_cursor, ctx.clock_grid.as_ref())));
        }
        out
    }

    /// Wheel routing (matches WaveCanvas `onWheel`): ctrl → zoom anchored at
    /// the pointer; plain wheel → pan (deltaX wins when present — shift-wheel
    /// arrives as deltaX from the webview), gated off at full-fit. Each wheel
    /// event reports a settled window (the TS handler bumps the view save).
    fn wheel(
        &mut self,
        x: f64,
        dx: f64,
        dy: f64,
        ctrl: bool,
        vp: &mut Viewport,
        ctx: &InputCtx,
    ) -> Vec<UiEvent> {
        vp.begin_interact(ctx.now_ms);
        if ctrl {
            vp.zoom_at_pixel(x, (dy * ZOOM_PER_DELTA_Y).exp());
        } else {
            let visible_ticks = vp.timeline_px() * vp.ticks_per_pixel();
            if visible_ticks >= vp.end_ticks() {
                return Vec::new();
            }
            let d = if dx != 0.0 { dx } else { dy };
            vp.pan_by_pixels(d);
        }
        vec![viewport_changed(vp, true)]
    }

    /// Canvas key set. Zoom/fit/undo start viewport animations (the per-frame
    /// `Viewport::tick` reports their progress; no immediate event). Cycle
    /// keys mirror the store's `cycleMarker`: select the next/prev marker in
    /// time order (wrapping) and park the cursor on it. AddMarker /
    /// DeleteMarker stay JS-owned (id/name/color allocation lives in the
    /// store and the frozen UiEvent set carries no add/delete event).
    fn key(&mut self, code: KeyCode, vp: &mut Viewport, ctx: &InputCtx) -> Vec<UiEvent> {
        match code {
            KeyCode::ZoomIn => {
                vp.zoom_by(1.0 / ZOOM_STEP, ctx.now_ms);
                Vec::new()
            }
            KeyCode::ZoomOut => {
                vp.zoom_by(ZOOM_STEP, ctx.now_ms);
                Vec::new()
            }
            KeyCode::ZoomFit => {
                vp.fit_view(ctx.now_ms);
                Vec::new()
            }
            KeyCode::UndoView => {
                vp.undo(ctx.now_ms);
                Vec::new()
            }
            KeyCode::NextMarker => cycle_marker(ctx, 1),
            KeyCode::PrevMarker => cycle_marker(ctx, -1),
            KeyCode::AddMarker | KeyCode::DeleteMarker => Vec::new(),
        }
    }
}

/// Port of the store's `cycleMarker`: with nothing selected, dir>0 starts at
/// the earliest marker, dir<0 at the latest; otherwise step through the
/// time-sorted list, wrapping.
fn cycle_marker(ctx: &InputCtx, dir: i64) -> Vec<UiEvent> {
    if ctx.markers.is_empty() {
        return Vec::new();
    }
    let mut sorted: Vec<&MarkerDto> = ctx.markers.iter().collect();
    sorted.sort_by(|a, b| a.tick.partial_cmp(&b.tick).unwrap_or(std::cmp::Ordering::Equal));
    let pos = ctx.selected_marker.and_then(|sel| sorted.iter().position(|m| m.id == sel));
    let next = match pos {
        None => {
            if dir > 0 {
                sorted[0]
            } else {
                sorted[sorted.len() - 1]
            }
        }
        Some(i) => sorted[(i as i64 + dir).rem_euclid(sorted.len() as i64) as usize],
    };
    vec![UiEvent::MarkerSelected { id: Some(next.id) }, cursor_moved(next.tick)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use riptide_contract::spec::{ClockPolarity, PackKind, Radix};

    const EPS: f64 = 1e-9;

    fn assert_close(a: f64, b: f64) {
        assert!((a - b).abs() < EPS, "{a} != {b}");
    }

    /// end=1000 over 100 px, auto-fit (tpp 10).
    fn vp() -> Viewport {
        let mut v = Viewport::new();
        v.reset_for_trace(1000, None);
        v.set_width(100.0);
        v.tick(0.0);
        v
    }

    fn row(height: Option<f32>, divider_below: bool, divider_height: Option<f32>) -> RowSpec {
        RowSpec {
            row: 0,
            handle: String::new(),
            path: String::new(),
            kind: PackKind::Data,
            polarity: ClockPolarity::Rising,
            shaded: false,
            mute_handle: None,
            radix: Radix::Bin,
            enums: Vec::new(),
            color: 0,
            hidden: false,
            selected: false,
            height,
            divider_below,
            divider_height,
            bit_width: 1,
        }
    }

    fn marker(id: u32, tick: f64) -> MarkerDto {
        MarkerDto { id, tick, ..Default::default() }
    }

    fn ctx<'a>(
        rows: &'a [RowSpec],
        hits: &'a [MarkerHit],
        snap: bool,
        grid: Option<ClockGrid>,
    ) -> InputCtx<'a> {
        InputCtx {
            now_ms: 1000.0,
            rows,
            markers: &[],
            selected_marker: None,
            marker_hits: hits,
            snap_cursor: snap,
            clock_grid: grid,
        }
    }

    fn down(x: f32, y: f32) -> InputEvent {
        InputEvent::PointerDown { x, y, button: 0, buttons: 1, ctrl: false, shift: false }
    }

    fn mv(x: f32, y: f32) -> InputEvent {
        InputEvent::PointerMove { x, y, buttons: 1 }
    }

    fn up(x: f32, y: f32) -> InputEvent {
        InputEvent::PointerUp { x, y, button: 0, buttons: 0 }
    }

    // --- tickAtClientX bias ---------------------------------------------------

    #[test]
    fn click_lands_where_the_hover_guide_was() {
        // The hover guide is centered via the same LINE_HALF_CSS bias as
        // tickAtClientX, so a click reports exactly the hovered tick.
        let mut v = vp();
        let mut st = InputState::new();
        let c = ctx(&[], &[], false, None);
        let x = 40.0_f32;
        let hover = match &st.on_event(&mv(x, 50.0), &mut v, &c)[0] {
            UiEvent::HoverChanged { tick, .. } => *tick,
            e => panic!("unexpected {e:?}"),
        };
        assert_close(hover, (40.0 - LINE_HALF_CSS) * 10.0); // 387.5
        let click = match &st.on_event(&down(x, 50.0), &mut v, &c)[0] {
            UiEvent::CursorMoved { tick, .. } => *tick,
            e => panic!("unexpected {e:?}"),
        };
        assert_close(click, hover);
    }

    #[test]
    fn tick_at_x_clamps_to_canvas_and_snaps_to_clock_grid() {
        let v = vp();
        // Clamp: past the right edge → width-LINE_HALF px worth of ticks.
        assert_close(tick_at_x(&v, 500.0, false, None), (100.0 - LINE_HALF_CSS) * 10.0);
        // Snap to the 10 ns grid with first edge at 5 (mock VCD timebase).
        let g = ClockGrid { period: 10.0, phase: 5.0, valid: true };
        // raw = (40 - 1.25) * 10 = 387.5 → (387.5-5)/10 = 38.25 → 38 → 385.
        assert_close(tick_at_x(&v, 40.0, true, Some(&g)), 385.0);
        // Snap off → raw tick.
        assert_close(tick_at_x(&v, 40.0, false, Some(&g)), 387.5);
        // Snap on but no grid → raw tick (the TS gate needs both).
        assert_close(tick_at_x(&v, 40.0, true, None), 387.5);
    }

    #[test]
    fn snap_rounds_half_up_like_js() {
        let g = ClockGrid { period: 10.0, phase: 0.0, valid: true };
        assert_close(snap_to_clock_edge(15.0, &g), 20.0); // Math.round(1.5) = 2
        assert_close(snap_to_clock_edge(14.999, &g), 10.0);
        let g5 = ClockGrid { period: 10.0, phase: 5.0, valid: true };
        assert_close(snap_to_clock_edge(0.0, &g5), 5.0); // k = round(-0.5) = 0
    }

    // --- marker grab ----------------------------------------------------------

    #[test]
    fn marker_grab_inside_pill_on_line_and_outside() {
        let hits = [MarkerHit { id: 3, x0: 100.0, x1: 150.0, line_x: 200.0 }];
        // Inside the pill box (ruler band only).
        assert_eq!(marker_at(&hits, 120.0, 10.0), Some(3));
        assert_eq!(marker_at(&hits, 120.0, ROW_HEIGHT_CSS), Some(3)); // inclusive
        assert_eq!(marker_at(&hits, 120.0, 30.0), None); // below the band
        assert_eq!(marker_at(&hits, 99.0, 10.0), None); // left of the pill
        // On the line: center = line_x + LINE_HALF = 201.25, slop ±5.
        assert_eq!(marker_at(&hits, 205.0, 300.0), Some(3));
        assert_eq!(marker_at(&hits, 196.5, 300.0), Some(3));
        assert_eq!(marker_at(&hits, 207.0, 300.0), None);
    }

    #[test]
    fn marker_drag_selects_then_moves_then_releases() {
        let mut v = vp();
        let mut st = InputState::new();
        let hits = [MarkerHit { id: 7, x0: 10.0, x1: 60.0, line_x: 30.0 }];
        let c = ctx(&[], &hits, false, None);

        let ev = st.on_event(&down(20.0, 5.0), &mut v, &c);
        assert_eq!(ev, vec![UiEvent::MarkerSelected { id: Some(7) }]);

        let ev = st.on_event(&mv(60.0, 50.0), &mut v, &c);
        assert_eq!(ev.len(), 2); // hover + marker move
        match &ev[1] {
            UiEvent::MarkerMoved { id, tick } => {
                assert_eq!(*id, 7);
                assert_close(*tick, (60.0 - LINE_HALF_CSS) * 10.0);
            }
            e => panic!("unexpected {e:?}"),
        }

        assert!(st.on_event(&up(60.0, 50.0), &mut v, &c).is_empty());
        // After release, moves are hover-only.
        let ev = st.on_event(&mv(70.0, 50.0), &mut v, &c);
        assert_eq!(ev.len(), 1);
        assert!(matches!(ev[0], UiEvent::HoverChanged { .. }));
    }

    #[test]
    fn cursor_drag_emits_cursor_moves_until_release() {
        let mut v = vp();
        let mut st = InputState::new();
        let c = ctx(&[], &[], false, None);
        let ev = st.on_event(&down(10.0, 50.0), &mut v, &c);
        assert!(matches!(ev[0], UiEvent::CursorMoved { .. }));
        let ev = st.on_event(&mv(20.0, 50.0), &mut v, &c);
        assert_eq!(ev.len(), 2);
        match &ev[1] {
            UiEvent::CursorMoved { tick, .. } => assert_close(*tick, (20.0 - LINE_HALF_CSS) * 10.0),
            e => panic!("unexpected {e:?}"),
        }
        st.on_event(&up(20.0, 50.0), &mut v, &c);
        assert_eq!(st.on_event(&mv(30.0, 50.0), &mut v, &c).len(), 1);
    }

    #[test]
    fn non_left_button_is_ignored() {
        let mut v = vp();
        let mut st = InputState::new();
        let c = ctx(&[], &[], false, None);
        let ev = st.on_event(
            &InputEvent::PointerDown { x: 10.0, y: 5.0, button: 2, buttons: 2, ctrl: false, shift: false },
            &mut v,
            &c,
        );
        assert!(ev.is_empty());
        assert_eq!(st.on_event(&mv(20.0, 50.0), &mut v, &c).len(), 1); // no drag started
    }

    #[test]
    fn pointer_leave_clears_hover() {
        let mut v = vp();
        let mut st = InputState::new();
        let c = ctx(&[], &[], false, None);
        assert_eq!(st.on_event(&InputEvent::PointerLeave, &mut v, &c), vec![UiEvent::HoverCleared]);
    }

    // --- hover row walk -------------------------------------------------------

    #[test]
    fn hover_row_walk_with_custom_heights_and_dividers() {
        // ruler [0,28) | row0 default [28,56) | row1 h=50 [56,106) |
        // divider 16 [106,122) | row2 default [122,150)
        let rows =
            [row(None, false, None), row(Some(50.0), true, None), row(None, false, None)];
        assert_eq!(hover_row(&rows, 10.0), -1); // ruler band
        assert_eq!(hover_row(&rows, 28.0), 0);
        assert_eq!(hover_row(&rows, 55.9), 0);
        assert_eq!(hover_row(&rows, 56.0), 1);
        assert_eq!(hover_row(&rows, 105.9), 1);
        assert_eq!(hover_row(&rows, 110.0), -1); // divider gap
        assert_eq!(hover_row(&rows, 122.0), 2);
        assert_eq!(hover_row(&rows, 149.9), 2);
        assert_eq!(hover_row(&rows, 150.0), -1); // below the last row
        // A resized divider shifts the rows below it.
        let rows2 = [row(None, true, Some(40.0)), row(None, false, None)];
        assert_eq!(hover_row(&rows2, 60.0), -1); // inside the 40px divider
        assert_eq!(hover_row(&rows2, 96.0), 1); // 28 + 28 + 40
    }

    #[test]
    fn hover_event_carries_tick_and_row() {
        let mut v = vp();
        let mut st = InputState::new();
        let rows = [row(None, false, None)];
        let c = ctx(&rows, &[], false, None);
        let ev = st.on_event(&mv(40.0, 30.0), &mut v, &c);
        match &ev[0] {
            UiEvent::HoverChanged { tick, row, time_label, value_text } => {
                assert_close(*tick, 387.5);
                assert_eq!(*row, 0);
                assert!(time_label.is_empty() && value_text.is_empty());
            }
            e => panic!("unexpected {e:?}"),
        }
    }

    #[test]
    fn hover_is_never_snapped_but_cursor_is() {
        let mut v = vp();
        let mut st = InputState::new();
        let g = ClockGrid { period: 10.0, phase: 5.0, valid: true };
        let c = ctx(&[], &[], true, Some(g));
        let ev = st.on_event(&down(40.0, 50.0), &mut v, &c);
        // Down emits a snapped cursor; the next move's hover stays raw.
        match &ev[0] {
            UiEvent::CursorMoved { tick, .. } => assert_close(*tick, 385.0),
            e => panic!("unexpected {e:?}"),
        }
        let ev = st.on_event(&mv(40.0, 50.0), &mut v, &c);
        match &ev[0] {
            UiEvent::HoverChanged { tick, .. } => assert_close(*tick, 387.5),
            e => panic!("unexpected {e:?}"),
        }
        match &ev[1] {
            UiEvent::CursorMoved { tick, .. } => assert_close(*tick, 385.0),
            e => panic!("unexpected {e:?}"),
        }
    }

    // --- wheel routing --------------------------------------------------------

    fn wheel(x: f32, dx: f32, dy: f32, ctrl: bool) -> InputEvent {
        InputEvent::Wheel { x, y: 50.0, dx, dy, ctrl, shift: false }
    }

    #[test]
    fn ctrl_wheel_zooms_at_pointer_and_reports_settled_viewport() {
        let mut v = vp();
        let mut st = InputState::new();
        let c = ctx(&[], &[], false, None);
        let anchor = v.start_ticks() + 30.0 * v.ticks_per_pixel();
        let ev = st.on_event(&wheel(30.0, 0.0, -100.0, true), &mut v, &c);
        let factor = (-100.0_f64 * ZOOM_PER_DELTA_Y).exp();
        assert_close(v.ticks_per_pixel(), 10.0 * factor);
        assert_close(v.start_ticks() + 30.0 * v.ticks_per_pixel(), anchor);
        assert_eq!(
            ev,
            vec![UiEvent::ViewportChanged { start: v.start_ticks(), end: v.view_end(), settled: true }]
        );
    }

    #[test]
    fn plain_wheel_pans_when_zoomed_in() {
        let mut v = vp();
        assert!(v.apply_range(200.0, 400.0, 0.0)); // tpp 2
        let mut st = InputState::new();
        let c = ctx(&[], &[], false, None);
        let ev = st.on_event(&wheel(30.0, 0.0, 10.0, false), &mut v, &c);
        assert_close(v.start_ticks(), 220.0); // 200 + 10px × 2
        assert_eq!(ev.len(), 1);
        // deltaX wins over deltaY when present (shift-wheel arrives as dx).
        st.on_event(&wheel(30.0, -5.0, 10.0, false), &mut v, &c);
        assert_close(v.start_ticks(), 210.0);
    }

    #[test]
    fn plain_wheel_at_full_fit_is_a_no_op() {
        let mut v = vp(); // visible == end
        let mut st = InputState::new();
        let c = ctx(&[], &[], false, None);
        let ev = st.on_event(&wheel(30.0, 0.0, 10.0, false), &mut v, &c);
        assert!(ev.is_empty());
        assert_close(v.start_ticks(), 0.0);
    }

    // --- keys -----------------------------------------------------------------

    fn key(code: KeyCode) -> InputEvent {
        InputEvent::Key { code, ctrl: false, shift: false, alt: false }
    }

    #[test]
    fn zoom_keys_start_animations() {
        let mut v = vp();
        let mut st = InputState::new();
        let c = ctx(&[], &[], false, None);
        assert!(st.on_event(&key(KeyCode::ZoomIn), &mut v, &c).is_empty());
        assert!(v.animating());
        let t = v.tick(1000.0 + crate::viewport::ZOOM_ANIM_MS);
        assert!(t.settled);
        assert_close(v.ticks_per_pixel(), 10.0 / ZOOM_STEP);
        // Fit returns to full range.
        assert!(st.on_event(&key(KeyCode::ZoomFit), &mut v, &c).is_empty());
        v.tick(1000.0 + crate::viewport::ZOOM_ANIM_MS);
        assert_close(v.ticks_per_pixel(), 10.0);
        // UndoView restores the pre-zoom-in window.
        assert!(st.on_event(&key(KeyCode::UndoView), &mut v, &c).is_empty());
        v.tick(1000.0 + crate::viewport::ZOOM_ANIM_MS);
        assert_close(v.ticks_per_pixel(), 10.0 / ZOOM_STEP);
    }

    #[test]
    fn marker_cycle_wraps_in_time_order_and_parks_cursor() {
        let mut v = vp();
        let mut st = InputState::new();
        let markers = [marker(1, 50.0), marker(2, 10.0), marker(3, 30.0)];
        let mut c = ctx(&[], &[], false, None);
        c.markers = &markers;

        // Nothing selected: next starts at the earliest.
        let ev = st.on_event(&key(KeyCode::NextMarker), &mut v, &c);
        assert_eq!(ev[0], UiEvent::MarkerSelected { id: Some(2) });
        assert!(matches!(ev[1], UiEvent::CursorMoved { tick, .. } if tick == 10.0));

        c.selected_marker = Some(2);
        let ev = st.on_event(&key(KeyCode::NextMarker), &mut v, &c);
        assert_eq!(ev[0], UiEvent::MarkerSelected { id: Some(3) });

        // Wrap forward from the latest.
        c.selected_marker = Some(1);
        let ev = st.on_event(&key(KeyCode::NextMarker), &mut v, &c);
        assert_eq!(ev[0], UiEvent::MarkerSelected { id: Some(2) });

        // Nothing selected: prev starts at the latest; wrap backward.
        c.selected_marker = None;
        let ev = st.on_event(&key(KeyCode::PrevMarker), &mut v, &c);
        assert_eq!(ev[0], UiEvent::MarkerSelected { id: Some(1) });
        c.selected_marker = Some(2);
        let ev = st.on_event(&key(KeyCode::PrevMarker), &mut v, &c);
        assert_eq!(ev[0], UiEvent::MarkerSelected { id: Some(1) });
    }

    #[test]
    fn cycle_with_no_markers_is_a_no_op() {
        let mut v = vp();
        let mut st = InputState::new();
        let c = ctx(&[], &[], false, None);
        assert!(st.on_event(&key(KeyCode::NextMarker), &mut v, &c).is_empty());
        assert!(st.on_event(&key(KeyCode::AddMarker), &mut v, &c).is_empty());
        assert!(st.on_event(&key(KeyCode::DeleteMarker), &mut v, &c).is_empty());
    }
}
