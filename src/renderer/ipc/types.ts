// TS mirror of crates/riptide-contract (the Tauri IPC contract). Keep in
// lockstep with the Rust types — serde uses camelCase field names and
// internally-tagged ("type") enums.

// ---- spec.rs --------------------------------------------------------------

export type Radix = "bin" | "hex" | "dec" | "sdec" | "enum" | "boolean";
export type PackKind = "data" | "clk";
export type ClockPolarity = "rising" | "falling" | "both";

export interface EnumEntry {
  value: number;
  label: string;
}

export interface ClockGrid {
  period: number;
  phase: number;
  valid: boolean;
}

export interface RowSpec {
  row: number;
  handle: string;
  path: string;
  kind: PackKind;
  polarity: ClockPolarity;
  shaded: boolean;
  muteHandle: string | null;
  radix: Radix;
  enums: EnumEntry[];
  color: number;
  hidden: boolean;
  selected: boolean;
  height: number | null;
  dividerBelow: boolean;
  dividerHeight: number | null;
  bitWidth: number;
}

// ---- doc.rs ---------------------------------------------------------------

export interface MarkerDto {
  id: number;
  name: string;
  tick: number;
  color: number;
}

export interface TimebaseOverride {
  period: number;
  phase: number;
}

export interface DocSync {
  rows: RowSpec[];
  markers: MarkerDto[];
  selectedMarker: number | null;
  cursor: number;
  snapCursor: boolean;
  clockAnchor: boolean;
  timebaseClock: string | null;
  timebaseOverride: TimebaseOverride | null;
  generation: number;
}

// ---- hier.rs --------------------------------------------------------------

export interface TimescaleDto {
  value: number;
  unit: string;
}

export type NodeDto =
  | {
      kind: "scope";
      id: number;
      parent: number | null;
      name: string;
      scopeType: string;
      children: number[];
    }
  | {
      kind: "signal";
      id: number;
      parent: number | null;
      name: string;
      varType: string;
      direction: string;
      bitWidth: number;
      handle: string;
    };

export interface HierarchyDto {
  rootIds: number[];
  nodes: NodeDto[];
  timescale: TimescaleDto;
  endTicks: number;
}

// ---- ipc.rs ---------------------------------------------------------------

export type KeyCode =
  | "addMarker"
  | "prevMarker"
  | "nextMarker"
  | "deleteMarker"
  | "zoomIn"
  | "zoomOut"
  | "zoomFit"
  | "undoView";

export type InputEvent =
  | { type: "pointerDown"; x: number; y: number; button: number; buttons: number; ctrl: boolean; shift: boolean }
  | { type: "pointerMove"; x: number; y: number; buttons: number }
  | { type: "pointerUp"; x: number; y: number; button: number; buttons: number }
  | { type: "pointerLeave" }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number; ctrl: boolean; shift: boolean }
  | { type: "key"; code: KeyCode; ctrl: boolean; shift: boolean; alt: boolean };

export interface RowValue {
  row: number;
  text: string;
}

export interface BootInfo {
  vcdPath: string | null;
  sidecarPath: string | null;
  perf: boolean;
}

export interface TraceSummary {
  path: string;
  endTicks: number;
  timescale: TimescaleDto | null;
  diagnostics: string[];
}

export interface PerfSample {
  fps: number;
  cpuEncodeMs: number;
  gpuPassMs: number | null;
  packMs: number;
  geometryMs: number;
  frameCount: number;
}

export type UiEvent =
  | { type: "viewportChanged"; start: number; end: number; settled: boolean }
  | { type: "hoverChanged"; tick: number; row: number; timeLabel: string; valueText: string }
  | { type: "hoverCleared" }
  | { type: "cursorMoved"; tick: number; label: string; rowValues: RowValue[] }
  | { type: "markerMoved"; id: number; tick: number }
  | { type: "markerSelected"; id: number | null }
  | { type: "clockGridChanged"; grid: ClockGrid | null }
  | { type: "traceLoaded"; summary: TraceSummary }
  | { type: "perf"; sample: PerfSample };
