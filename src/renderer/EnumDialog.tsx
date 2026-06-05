import { For, createSignal, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { useAppStore } from "./store/store";
import { enumTableForRef } from "./hier/scene";

// Editable rows kept as strings so intermediate states (empty value field) are
// allowed; committed to the store as parsed {value, label} entries.
type Draft = { value: string; label: string };

// Modal dialog for the "Enum" format. Builds/edits the per-signal value→name
// table; changes persist via the sidecar autosave. Dismiss on backdrop / Esc.
export function EnumDialog(props: { row: number; onClose: () => void }) {
  const s = useAppStore();

  const seed = (): Draft[] => {
    const r = useAppStore.getState().activeSignals.find((x) => x.row === props.row);
    return r ? enumTableForRef(r).map((e) => ({ value: String(e.value), label: e.label })) : [];
  };
  const [rows, setRows] = createSignal<Draft[]>(seed());

  // Push the current drafts to the store as a clean enum table (drop blank rows,
  // require a finite integer value).
  const commit = (next: Draft[]) => {
    setRows(next);
    const table = next
      .filter((d) => d.value.trim() !== "" && d.label.trim() !== "")
      .map((d) => ({ value: parseInt(d.value, 10), label: d.label.trim() }))
      .filter((e) => Number.isFinite(e.value));
    s.setEnumTable(props.row, table);
  };

  const setAt = (i: number, p: Partial<Draft>) => commit(rows().map((d, j) => (j === i ? { ...d, ...p } : d)));
  const add = () => commit([...rows(), { value: "", label: "" }]);
  const remove = (i: number) => commit(rows().filter((_, j) => j !== i));

  onMount(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={props.onClose}>
        <div class="modal" onMouseDown={(e) => e.stopPropagation()}>
          <div class="modal-title">Enum Table</div>

          <div class="enum-head">
            <span>Value</span>
            <span>Name</span>
          </div>
          <div class="enum-list">
            <For each={rows()} fallback={<div class="enum-empty">No entries yet.</div>}>{(d, i) => (
              <div class="enum-row">
                <input
                  class="text-input enum-val"
                  type="text"
                  inputmode="numeric"
                  placeholder="0"
                  value={d.value}
                  onInput={(e) => setAt(i(), { value: e.currentTarget.value })}
                />
                <input
                  class="text-input enum-name"
                  type="text"
                  placeholder="NAME"
                  value={d.label}
                  onInput={(e) => setAt(i(), { label: e.currentTarget.value })}
                />
                <button class="enum-del" title="Remove entry" onClick={() => remove(i())}>✕</button>
              </div>
            )}</For>
          </div>

          <div class="modal-actions between">
            <button class="btn ghost" onClick={add}>+ Add Entry</button>
            <button class="btn primary" onClick={props.onClose}>Done</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
