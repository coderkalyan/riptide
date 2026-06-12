// Rust-pushed display text for the DOM chrome in the Tauri build. Rust owns the
// value formatting at the cursor (UiEvent cursorMoved.rowValues) and under the
// pointer (hoverChanged.timeLabel/valueText); tauri/storeBridge.ts writes them
// here, and ActiveSignals.tsx / HoverReadout.tsx read them (IS_TAURI path)
// instead of calling valueAtTick/formatSegmentValue.
//
// Deliberately bridge-free (only solid-js), so importing it from shared
// components costs the Electron bundle nothing but these few lines.

import { createSignal } from "solid-js";

export interface TauriHover {
  tick: number;
  row: number;
  timeLabel: string;
  valueText: string;
}

const [rowValues, setRowValuesSignal] = createSignal<ReadonlyMap<number, string>>(new Map());
const [hover, setHoverSignal] = createSignal<TauriHover | null>(null);

/** Reactive read of one row's cursor-value text ("-" until Rust pushes). */
export function rowValueText(row: number): string {
  return rowValues().get(row) ?? "-";
}

export const tauriHover = hover;

export function setTauriRowValues(values: { row: number; text: string }[]): void {
  const m = new Map<number, string>();
  for (const v of values) m.set(v.row, v.text);
  setRowValuesSignal(m);
}

export function setTauriHover(h: TauriHover | null): void {
  setHoverSignal(h);
}
