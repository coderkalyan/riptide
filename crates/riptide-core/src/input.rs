//! Pointer/wheel/key → cursor placement, marker drag, hover, pan/zoom.
//! Port of the `WaveCanvas.tsx` event handlers (tickAtClientX bias, snap,
//! marker grab via `MarkerHit` boxes, hover row walk over per-row heights).
//!
//! OWNED BY UNIT U4. The unit owns this API; `Engine` wires it at integration
//! (U15). Emits `UiEvent`s (CursorMoved/MarkerMoved/HoverChanged/…) rather
//! than mutating any store.

#[derive(Default)]
pub struct InputState {
    _private: (),
}
