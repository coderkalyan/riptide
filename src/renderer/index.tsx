import { createRoot } from "react-dom/client";
import { App } from "./App";
import { stamp } from "./perf";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// createRoot's initial render commits synchronously (React 18/19), so
// render:committed lands after the DOM is built but before the browser paints —
// splitting React's reconcile+commit from the subsequent layout/paint.
stamp("render:start");
createRoot(root).render(<App />);
stamp("render:committed");
