import { Show, createMemo } from "solid-js";
import { getSignal } from "./hier/hierarchy";
import { SCENE } from "./hier/scene";
import { useAppStore } from "./store/store";
import { valueAtTick, formatSegmentValue } from "./wave/value";
import { formatTime } from "./wave/format";

// Status-bar live readout under the pointer. Reads store.hover reactively — a
// pointer move re-runs only this component's value cell (fine-grained), never
// the whole app. (In React this needed a hand-rolled external store +
// useSyncExternalStore; here a plain store read gives the same isolation.)
export function HoverReadout(props: { enumLabels: () => Map<number, Map<number, string>> }) {
  const s = useAppStore();
  const muted = <span class="muted st-item st-val">hover over a signal to inspect</span>;
  return (
    <Show when={s.hover} fallback={muted}>
      {(hover) => {
        const ref = createMemo(() => (hover().row >= 0 ? s.activeSignals.find((r) => r.row === hover().row) ?? null : null));
        const sig = createMemo(() => { const r = ref(); return r ? getSignal(SCENE.hierarchy, r.signalId) : null; });
        return (
          <>
            <span class="st-item"><span class="lbl-t">time </span><b>{formatTime(hover().tick)}</b><span class="unit"> ns</span></span>
            <span class="sep">·</span>
            <Show when={sig() && ref()} fallback={muted}>
              <span class="st-item st-val">
                <span class="lbl-v">{sig()!.name} = </span>
                <b>{formatSegmentValue(valueAtTick(sig()!.handle, hover().tick), sig()!.bitWidth, ref()!.radix, props.enumLabels().get(ref()!.row))}</b>
              </span>
            </Show>
          </>
        );
      }}
    </Show>
  );
}
