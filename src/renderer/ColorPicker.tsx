import { onMount, onCleanup } from "solid-js";
import Coloris from "@melloware/coloris";

// `el` is required on Coloris's option type, but a no-`el` call is the supported
// way to set global defaults (theme/format/swatches). Cast around the type.
const configure = Coloris as unknown as (opts: Record<string, unknown>) => void;

const PRESETS = [
  "#72F5DF", "#F06B5B", "#E6B14E", "#B48CFF", "#57C88A",
  "#727BF5", "#4FD2BD", "#72F5B4", "#E86A5A", "#F4A698",
];

// Coloris (coloris.js.org) is a single shared dialog appended to <body>; it
// opens against whichever bound input was clicked. We init it once, with the
// app's dark palette + our preset swatches.
let inited = false;
function ensureColoris() {
  if (inited) return;
  inited = true;
  Coloris.init();
  configure({
    themeMode: "dark",
    theme: "default",
    format: "hex",
    formatToggle: false,
    alpha: false,
    focusInput: false,
    swatches: PRESETS,
    wrap: false, // bind directly to our anchor input, no thumbnail wrapper
  });
}

// Same imperative contract as before: mount → open a dialog anchored at the
// pin/click point, stream picks via onChange, dismiss (outside click / Esc) via
// onClose. Backed by Coloris instead of the hand-rolled swatch popup.
export function ColorPicker(props: {
  color: string;
  onChange: (c: string) => void;
  onClose: () => void;
  anchorRect: DOMRect;
}) {
  let input!: HTMLInputElement;
  onMount(() => {
    ensureColoris();
    Coloris({ el: input, swatches: PRESETS });
    input.value = props.color;

    // Coloris dispatches `input` on the bound field for every pick (live) and a
    // `close` when the dialog dismisses. Esc reverts + still fires both.
    const onInput = () => props.onChange(input.value);
    const onCloseEv = () => props.onClose();
    input.addEventListener("input", onInput);
    input.addEventListener("close", onCloseEv);

    // Open immediately: a click on a bound field is what Coloris opens on, and
    // it positions the dialog against this input's rect (set via style below).
    const raf = requestAnimationFrame(() => input.click());

    onCleanup(() => {
      cancelAnimationFrame(raf);
      input.removeEventListener("input", onInput);
      input.removeEventListener("close", onCloseEv);
    });
  });

  return (
    <input
      ref={input}
      class="clr-anchor"
      type="text"
      style={{ left: `${props.anchorRect.left}px`, top: `${props.anchorRect.top}px` }}
    />
  );
}
