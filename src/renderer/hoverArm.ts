// Hover-intent for the thin bottom-edge resize handles (.s-resize). The cursor
// (ns-resize) and the accent bar are gated on an `.armed` class that's only added
// after a short dwell — so quickly swiping the mouse across a handle never flashes
// them. A pointerdown arms immediately (a press is intent) so the cursor/bar stay
// put during the drag. The class is toggled directly on the element (outside
// Solid's static `class` attr, which it never overwrites) — no per-row signal.
const ARM_DELAY_MS = 220;

export function makeHoverArm(onDown?: (e: PointerEvent) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (el: HTMLElement) => { clearTimeout(timer); el.classList.remove("armed"); };
  return {
    onPointerEnter: (e: PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.add("armed"), ARM_DELAY_MS);
    },
    onPointerLeave: (e: PointerEvent) => disarm(e.currentTarget as HTMLElement),
    onPointerDown: (e: PointerEvent) => {
      const el = e.currentTarget as HTMLElement;
      clearTimeout(timer);
      el.classList.add("armed");
      onDown?.(e);
    },
  };
}
