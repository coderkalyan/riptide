// Thin typed wrappers over the Tauri IPC surface (commands registered in
// src-tauri/src/main.rs). One-liners only — no logic here. The Electron entry
// never imports this module; it's pulled in by the Tauri entry (U13).

import { invoke, Channel } from "@tauri-apps/api/core";

import type {
  BootInfo,
  DocSync,
  HierarchyDto,
  InputEvent,
  TraceSummary,
  UiEvent,
} from "./types";

// ---- cold -----------------------------------------------------------------

/** Open a VCD; path = undefined shows the native dialog. Null on cancel. */
export const openVcd = (path?: string): Promise<TraceSummary | null> =>
  invoke("open_vcd", { path: path ?? null });

export const getHierarchy = (): Promise<HierarchyDto> => invoke("get_hierarchy");

export const bootInfo = (): Promise<BootInfo> => invoke("boot_info");

export const recentVcds = (): Promise<string[]> => invoke("recent_vcds");

export const addRecent = (path: string): Promise<void> => invoke("add_recent", { path });

export const exportSidecar = (text: string): Promise<void> => invoke("export_sidecar", { text });

export const saveCanvas = (): Promise<void> => invoke("save_canvas");

export const closeWindow = (): Promise<void> => invoke("close_window");

export const perfControl = (opts: { enable?: boolean; reset?: boolean }): Promise<void> =>
  invoke("perf_control", { enable: opts.enable ?? null, reset: opts.reset ?? null });

// ---- warm -----------------------------------------------------------------

export const syncDoc = (doc: DocSync): Promise<void> => invoke("sync_doc", { doc });

export const readSidecar = (path: string): Promise<string | null> =>
  invoke("read_sidecar", { path });

export const writeSidecar = (path: string, text: string): Promise<void> =>
  invoke("write_sidecar", { path, text });

export const resize = (width: number, height: number, dpr: number): Promise<void> =>
  invoke("resize", { width, height, dpr });

// ---- hot ------------------------------------------------------------------

/** Raw canvas input, forwarded at event rate. */
export const input = (ev: InputEvent): Promise<void> => invoke("input", { ev });

/** Subscribe the one Rust→JS event channel. */
export function subscribeEvents(onEvent: (ev: UiEvent) => void): Promise<void> {
  const channel = new Channel<UiEvent>();
  channel.onmessage = onEvent;
  return invoke("subscribe_events", { channel });
}
