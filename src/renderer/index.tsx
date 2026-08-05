import { render } from "solid-js/web";
import "./index.css";
import { App } from "./App";
import { stamp } from "./perf";
import { startAutosave } from "./store/store";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// Solid's render is synchronous, so this brackets reconcile+commit tightly.
stamp("render:start");
render(() => <App />, root);
stamp("render:committed");
startAutosave();

// Dismiss the boot splash (index.html) now that the real UI is committed. This is the
// right seam: everything before it is a blank document, everything after is the full app
// chrome — the canvas filling in a moment later reads as loading, not as breakage.
//
// Removal is on a timer, NOT transitionend: a transitionend that never fires (background
// tab, reduced motion collapsing the transition) would strand a full-screen overlay over
// the app. `is-done` already sets pointer-events: none and opacity 0, so the worst case
// if this timer is somehow missed is an invisible, inert node.
const splash = document.getElementById("splash");
if (splash) {
  splash.classList.add("is-done");
  setTimeout(() => splash.remove(), 200);
}
