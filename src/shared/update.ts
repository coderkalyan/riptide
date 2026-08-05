// The update-check contract, shared by the main process (src/main/updater.ts, which owns
// the state machine) and the renderer (AboutDialog, which draws it). Type-only, so nothing
// crosses the process boundary at runtime except the plain object sent over IPC.
//
// Two terminal "there is a new version" states, because not every Riptide build can update
// itself in place:
//   available — electron-updater can do it; the user consents and we download.
//   manual    — macOS (ad-hoc signed) and the Windows portable exe. We found the version
//               but can only send the user to the releases page. See src/main/updater.ts
//               for why each platform lands where it does.
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "manual"; version: string; url: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string; installOnQuit: boolean }
  | { kind: "error"; message: string };

// A newer version was found, whichever way it has to be installed. Drives the Help-menu
// label and the About card's call to action.
export function pendingVersion(s: UpdateStatus): string | null {
  switch (s.kind) {
    case "available":
    case "manual":
    case "downloading":
    case "ready":
      return s.version;
    default:
      return null;
  }
}
