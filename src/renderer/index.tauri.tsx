// Tauri entry — the parallel of index.tsx (Electron). Differences:
//   - boot parameters come from bridge.bootInfo(), not the window URL
//     (runtime.ts's IS_TAURI branch leaves VCD_PATH empty here),
//   - the hierarchy comes from bridge.getHierarchy() (Rust loaded the trace),
//     marshalled and installed into the aliased native stub so the shared
//     scene/store layers (hier/scene.ts swapTrace) hydrate unchanged,
//   - no GPU init: the waveform canvas is tauri/CanvasHost.tsx (App.tsx's
//     WaveCanvas import is aliased there by scripts/build-ui.mjs),
//   - the store syncs with Rust via tauri/storeBridge.ts,
//   - sidecar autosave (startAutosave) is NOT started — sidecar writes go
//     through U11's bridge-backed path at integration (TODO seam).
import "./tauri/webviewShims"; // FIRST: require()/process shims for node-flavored shared modules
import { render } from "solid-js/web";
import "./index.css";
import { App } from "./App";
import { stamp } from "./perf";
import { bootInfo, getHierarchy, readSidecar } from "./ipc/bridge";
import { marshalHierarchy } from "./tauri/hierarchy";
import { installHierarchy } from "./tauri/nativeStub";
import { primeFile } from "./tauri/webviewShims";
import { startStoreBridge } from "./tauri/storeBridge";
import { swapTrace } from "./hier/scene";
import { useAppStore } from "./store/store";

async function boot(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing");

  try {
    const info = await bootInfo();
    if (info.vcdPath) {
      // Rust already owns the trace db; fetch + install its hierarchy so the
      // scene layer (swapTrace → nativeStub.getHierarchy) can build SCENE.
      const dto = await getHierarchy();
      installHierarchy(marshalHierarchy(dto));
      // Sidecar: prefetch through the bridge and prime the fs shim so the
      // existing synchronous loadSidecar path finds it under the path
      // swapTrace will ask for. TODO(U11/U15): replace with the async
      // bridge-native sidecar path once hier/sidecar.ts is migrated.
      try {
        const text = await readSidecar(info.sidecarPath ?? `${info.vcdPath}.sidecar.json`);
        if (text != null) primeFile(`${info.vcdPath}.sidecar.json`, text);
      } catch (e) {
        console.warn("[tauri] readSidecar failed; starting with a fresh view", e);
      }
      swapTrace(info.vcdPath);
      useAppStore.getState().resetForTrace();
    }
  } catch (e) {
    // Boot must not white-screen on a bridge failure — fall through to the
    // idle (no trace) app.
    console.error("[tauri] boot failed; starting idle", e);
  }

  startStoreBridge();
  stamp("render:start");
  render(() => <App />, root);
  stamp("render:committed");
}

void boot();
