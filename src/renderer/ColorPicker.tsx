import { For, onMount, onCleanup } from "solid-js";

const PRESETS = [
  "#72F5DF", "#F06B5B", "#E6B14E", "#B48CFF", "#57C88A",
  "#727BF5", "#4FD2BD", "#72F5B4", "#E86A5A", "#F4A698",
];

// Color popup anchored beside the row's pin. position:fixed via .color-picker;
// closes on outside-click or Escape. Renders inline (no portal needed).
export function ColorPicker(props: {
  color: string;
  onChange: (c: string) => void;
  onClose: () => void;
  anchorRect: DOMRect;
}) {
  let ref!: HTMLDivElement;
  onMount(() => {
    const onDoc = (e: MouseEvent) => { if (ref && !ref.contains(e.target as Node)) props.onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div
      class="color-picker"
      ref={ref}
      style={{ left: `${props.anchorRect.right + 6}px`, top: `${props.anchorRect.top - 4}px` }}
    >
      <div class="swatches">
        <For each={PRESETS}>{(c) => (
          <span
            classList={{ sw: true, on: c.toLowerCase() === props.color.toLowerCase() }}
            style={{ background: c }}
            onClick={() => { props.onChange(c); props.onClose(); }}
          />
        )}</For>
      </div>
      <input type="color" value={props.color} onInput={(e) => props.onChange(e.currentTarget.value)} />
    </div>
  );
}
