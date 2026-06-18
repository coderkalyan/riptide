import { Dynamic } from "solid-js/web";
import { Activity, Eye, EyeOff, Clock, RotateCcw } from "lucide-solid";
import { createMemo, type JSX } from "solid-js";
import { makeHoverArm } from "./hoverArm";

export type ActiveSignalKind = "clock" | "reset" | "signal";

// Split a signal name into its base and a trailing bit-range suffix (e.g.
// "in_data[7:0]" → "in_data" + "[7:0]") so the range can be tinted apart from the
// name. Pattern-based (last bracketed group), so it works for any VCD; names
// without a trailing "[…]" render unchanged.
function SignalName(props: { name: string }) {
  const parts = createMemo(() => {
    const m = props.name.match(/^(.*?)(\[[^\]]*\])$/);
    return m ? { base: m[1], bits: m[2] } : { base: props.name, bits: "" };
  });
  return <>{parts().base}{parts().bits && <span class="s-bits">{parts().bits}</span>}</>;
}

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
  height?: number;         // per-row height (CSS px); undefined → default --row-h
  onPinClick?: (e: MouseEvent) => void;
  onToggleVisible?: (e: MouseEvent) => void;
  onClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  onResizeStart?: (e: PointerEvent) => void; // drag the bottom handle to resize
  onResizeReset?: () => void;                // double-click handle → default height
}

const KIND_ICON: Record<ActiveSignalKind, (p: { size: number }) => JSX.Element> = {
  clock: Clock, reset: RotateCcw, signal: Activity,
};
const KIND_TIP: Record<ActiveSignalKind, string> = {
  clock: "clock", reset: "reset", signal: "data",
};

// Presentational row. Reads props.* directly (no destructuring) so Solid keeps
// each access reactive — selected/hidden/color/value toggles patch in place.
export function ActiveSignal(props: ActiveSignalProps) {
  const cls = () => ["s-row", props.collapsed ? "collapsed" : "", props.sliding ? "sliding" : "", props.selected ? "sel" : ""]
    .filter(Boolean).join(" ");
  // Reveal the resize cursor/bar only after a hover dwell (arms on press).
  const arm = makeHoverArm((e) => { e.stopPropagation(); props.onResizeStart?.(e); });
  return (
    <div
      class={cls()}
      style={props.height ? { height: `${props.height}px` } : undefined}
      // Shift-click extends the browser's text selection by default — suppress that
      // (range-select highlights signal-row text) while keeping the click itself.
      onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
      onClick={(e) => props.onClick?.(e)}
      onContextMenu={(e) => props.onContextMenu?.(e)}
      data-tip={props.collapsed ? `${props.name} · ${props.value}` : props.tip}
    >
      {props.collapsed ? (
        <span class="n"><SignalName name={props.name} /></span>
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
          <span class="n"><SignalName name={props.name} /></span>
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
      {/* Bottom edge resize handle: drag to set this row's height, double-click
          to reset to the default. stopPropagation so it doesn't select the row. */}
      <span
        class="s-resize"
        onPointerEnter={arm.onPointerEnter}
        onPointerLeave={arm.onPointerLeave}
        onPointerDown={arm.onPointerDown}
        onDblClick={(e) => { e.stopPropagation(); props.onResizeReset?.(); }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
