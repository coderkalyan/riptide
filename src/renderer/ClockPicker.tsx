import { For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { ChevronDown } from "lucide-solid";
import { Portal } from "solid-js/web";
import { useAppStore } from "./store/store";
import { EditableNum } from "./EditableNum";

// Timebase clock selector. Picks WHICH clock-format signal drives clock-aligned
// cycle math + the grid; the on/off is a separate toolbar toggle (clockAnchor),
// so this control is disabled (greyed, but visible) when clock alignment is off.
// Also exposes the detected period/phase as editable override fields. Mirrors
// MenuBar's click-to-open + Portal popup pattern.
const baseName = (p: string) => p.split(".").pop() || p;

export function ClockPicker() {
  const s = useAppStore();
  const [open, setOpen] = createSignal<DOMRect | null>(null);

  const clocks = () => s.activeSignals.filter((r) => r.role === "clock");
  const disabled = () => !s.clockAnchor;
  const isCustom = () => s.timebaseOverride != null;
  const triggerLabel = () => (isCustom() ? "custom" : s.timebaseClock ? baseName(s.timebaseClock) : "—");
  // Values shown in the custom editor: the override if set, else the currently
  // detected grid (so the fields are populated even when custom isn't active).
  const customSrc = () => s.timebaseOverride ?? s.clockGrid;
  const customPhase = () => customSrc()?.phase ?? 0;
  const customPeriod = () => { const p = customSrc()?.period; return p && p > 0 ? p : 10; };
  // Selecting a detected clock clears any custom override and closes the menu.
  const select = (path: string) => { s.setTimebaseClock(path); setOpen(null); };
  // "Custom" seeds the override from the current grid (or a sane default) and
  // stays open so the inline period/phase can be edited.
  const selectCustom = () => {
    if (isCustom()) return;
    const g = s.clockGrid;
    s.setTimebaseOverride(g && g.period > 0 ? g.period : 10, g ? g.phase : 0);
  };

  createEffect(() => {
    if (!open()) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".clock-picker") && !t.closest(".menu-pop")) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <span class="clock-picker">
      <span
        class="btn clock-trigger"
        classList={{ disabled: disabled() }}
        data-tip={disabled() ? "enable clock alignment to choose a clock" : "timebase clock"}
        onClick={(e) => {
          if (disabled()) return;
          const r = e.currentTarget.getBoundingClientRect();
          setOpen((o) => (o ? null : r));
        }}
      >
        <span class="clock-trig-label mono">{triggerLabel()}</span>
        <ChevronDown class="clock-chevron" size={12} />
      </span>
      <Portal>
        <div
          class={`menu-pop${open() ? " show" : ""}`}
          // Right-anchored to the trigger (toolbar sits at the screen's right edge),
          // so the popup grows leftward and never clips off-screen.
          style={{ right: `${window.innerWidth - (open()?.right ?? window.innerWidth)}px`, top: `${(open()?.bottom ?? 0) + 4}px` }}
        >
          <For each={clocks()}>{(r) => (
            <div class="menu-item clock-opt" onClick={() => select(r.path)}>
              <span class="clock-tick">{!isCustom() && s.timebaseClock === r.path ? "✓" : ""}</span>
              <span>{r.path}</span>
            </div>
          )}</For>
          <Show when={clocks().length === 0}>
            <div class="menu-item disabled"><span>No clock-format signals</span></div>
          </Show>
          <div class="menu-sep" />
          {/* Custom timebase: leading ✓ + label, with an inline [phase] + [period] ns
              editor (unit non-editable) once selected, mirroring the Clock format item. */}
          <div class="menu-item clock-opt" onClick={selectCustom}>
            <span class="clock-tick">{isCustom() ? "✓" : ""}</span>
            <span>custom</span>
            <span class="menu-clock-info clock-custom" onClick={(e) => e.stopPropagation()}>
              <span data-tip="phase — first clock edge offset (ns)">
                <EditableNum
                  value={customPhase()}
                  format={(n) => `${n}`}
                  onCommit={(n) => { if (!(n >= 0)) return false; s.setTimebaseOverride(customPeriod(), n); return true; }}
                />
              </span>
              <span class="clock-custom-op">+</span>
              <span data-tip="period — full clock cycle (ns)">
                <EditableNum
                  value={customPeriod()}
                  format={(n) => `${n}`}
                  onCommit={(n) => { if (!(n > 0)) return false; s.setTimebaseOverride(n, customPhase()); return true; }}
                />
              </span>
              <span class="menu-clock-unit">ns</span>
            </span>
          </div>
        </div>
      </Portal>
    </span>
  );
}
