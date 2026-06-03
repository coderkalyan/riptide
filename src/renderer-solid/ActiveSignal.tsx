import { Dynamic } from "solid-js/web";
import { Activity, Eye, EyeOff, CircleCheck, Clock, EqualApproximately, RotateCcw } from "lucide-solid";
import type { JSX } from "solid-js";

export type ActiveSignalKind = "clock" | "reset" | "valid" | "derived" | "signal";

export interface ActiveSignalProps {
  name: string;
  value: string;
  kind: ActiveSignalKind;
  color: string;
  tip?: string;            // row tooltip: full path · vcd type
  selected?: boolean;
  hidden?: boolean;        // eye toggled off (cosmetic dim)
  collapsed?: boolean;     // narrow strip: name only
  sliding?: boolean;       // during the collapse anim: slide the name into place
  onPinClick?: (e: MouseEvent) => void;
  onToggleVisible?: (e: MouseEvent) => void;
  onClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
}

const KIND_ICON: Record<ActiveSignalKind, (p: { size: number }) => JSX.Element> = {
  clock: Clock, reset: RotateCcw, valid: CircleCheck, derived: EqualApproximately, signal: Activity,
};
const KIND_TIP: Record<ActiveSignalKind, string> = {
  clock: "clock", reset: "reset", valid: "valid", derived: "derived", signal: "data",
};

// Presentational row. Reads props.* directly (no destructuring) so Solid keeps
// each access reactive — selected/hidden/color/value toggles patch in place.
export function ActiveSignal(props: ActiveSignalProps) {
  const cls = () => ["s-row", props.collapsed ? "collapsed" : "", props.sliding ? "sliding" : "", props.selected ? "sel" : ""]
    .filter(Boolean).join(" ");
  return (
    <div
      class={cls()}
      onClick={(e) => props.onClick?.(e)}
      onContextMenu={(e) => props.onContextMenu?.(e)}
      data-tip={props.collapsed ? `${props.name} · ${props.value}` : props.tip}
    >
      {props.collapsed ? (
        <span class="n">{props.name}</span>
      ) : (
        <>
          <span
            class="pin"
            style={{ background: props.color }}
            data-tip="change color"
            onClick={(e) => { e.stopPropagation(); props.onPinClick?.(e); }}
          />
          <span class={"s-icon " + props.kind} data-tip={KIND_TIP[props.kind]}>
            <Dynamic component={KIND_ICON[props.kind]} size={12} />
          </span>
          <span class="n">{props.name}</span>
          <span class="v">{props.value}</span>
          <span
            class={"eye" + (props.hidden ? " off" : "")}
            data-tip={props.hidden ? "show signal" : "dim signal"}
            onClick={(e) => { e.stopPropagation(); props.onToggleVisible?.(e); }}
          >
            {props.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </span>
        </>
      )}
    </div>
  );
}
