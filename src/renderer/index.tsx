import { render } from "solid-js/web";
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
