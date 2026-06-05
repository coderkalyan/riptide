import { createSignal, onMount, onCleanup, createEffect } from "solid-js";
import { Portal } from "solid-js/web";

// Single delegated tooltip for every [data-tip] element. Rendered through a
// Portal at <body> so it escapes overflow/scroll ancestors and the WebGPU
// canvas. Kept mounted so opacity transitions on enter + exit; `show` drives the
// fade, `tip` holds the last text/position (frozen during fade-out).
export function GlobalTooltip() {
  const [tip, setTip] = createSignal<{ text: string; x: number; y: number }>({ text: "", x: 0, y: 0 });
  const [show, setShow] = createSignal(false);
  // Flip below the anchor when there's no room above (e.g. titlebar elements at the
  // top of the screen) — otherwise the bubble translates off-screen and is invisible.
  const [below, setBelow] = createSignal(false);
  const [left, setLeft] = createSignal(0);
  let ref: HTMLDivElement | undefined;

  // Clamp the (centered) tooltip so it never spills off either screen edge.
  createEffect(() => {
    const t = tip(); // track text + x
    const el = ref;
    if (!el) return;
    const halfW = el.offsetWidth / 2;
    const m = 4;
    const min = halfW + m;
    const max = window.innerWidth - halfW - m;
    setLeft(max < min ? min : Math.max(min, Math.min(max, t.x)));
  });

  onMount(() => {
    let current: HTMLElement | null = null;
    // Watch `current`'s data-tip so a button that flips its tip on click updates
    // the open tooltip without the cursor leaving.
    const attrObs = new MutationObserver(() => {
      if (!current) return;
      const text = current.getAttribute("data-tip") ?? "";
      if (text === "") { setShow(false); return; }
      setTip((p) => ({ ...p, text }));
      setShow(true);
    });
    const watch = (el: HTMLElement | null) => {
      attrObs.disconnect();
      if (el) attrObs.observe(el, { attributes: true, attributeFilter: ["data-tip"] });
    };
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest("[data-tip]") as HTMLElement | null;
      if (el === current) return;
      current = el;
      watch(el);
      const text = el?.getAttribute("data-tip") ?? "";
      if (!el || text === "") { setShow(false); return; }
      const r = el.getBoundingClientRect();
      // ~26px = bubble height + gap; if the anchor's too near the top, drop below it.
      const flip = r.top < 26;
      setBelow(flip);
      setTip({ text, x: r.left + r.width / 2, y: flip ? r.bottom : r.top });
      setShow(true);
    };
    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as Node | null;
      if (current && (!to || !current.contains(to))) {
        current = null;
        watch(null);
        setShow(false);
      }
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    onCleanup(() => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      attrObs.disconnect();
    });
  });

  return (
    <Portal>
      <div ref={ref} class={`tip-pop${show() ? " show" : ""}${below() ? " below" : ""}`} style={{ left: `${left()}px`, top: `${tip().y}px` }}>{tip().text}</div>
    </Portal>
  );
}
