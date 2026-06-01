import { Activity, Eye, EyeOff, CircleCheck, Clock, EqualApproximately, RotateCcw } from "lucide-react";

export type ActiveSignalKind = "clock" | "reset" | "valid" | "derived" | "signal";

export interface ActiveSignalProps {
  name: string;
  value: string;
  kind: ActiveSignalKind;
  radix: string;
  color: string;
  tip?: string;            // row tooltip: full path · vcd type
  pinned?: boolean;
  selected?: boolean;
  nested?: boolean;
  hidden?: boolean;        // eye toggled off (cosmetic; no canvas effect yet)
  collapsed?: boolean;     // narrow strip: color dot + truncated name only
  sliding?: boolean;       // during the collapse anim: slide the name leftward into place
  onPinClick?: (e: React.MouseEvent<HTMLElement>) => void;
  onToggleVisible?: (e: React.MouseEvent<HTMLElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
}

const ICON = {
  clock: <Clock size={12} />,
  reset: <RotateCcw size={12} />,
  valid: <CircleCheck size={12} />,
  derived: <EqualApproximately size={12} />,
  signal: <Activity size={12} />,
} as const;

// Human-readable label for the type icon's tooltip.
const KIND_TIP: Record<ActiveSignalKind, string> = {
  clock: "clock",
  reset: "reset",
  valid: "valid",
  derived: "derived",
  signal: "data",
};

export function ActiveSignal(props: ActiveSignalProps) {
  const cls = ["s-row", props.collapsed ? "collapsed" : "", props.sliding ? "sliding" : "", props.selected ? "sel" : "", props.nested ? "nested" : ""]
    .filter(Boolean)
    .join(" ");
  // Compact strip: just the name (no swatch). Name·value moves to the row
  // tooltip so value + identity stay recoverable on hover.
  if (props.collapsed) {
    return (
      <div className={cls} onClick={props.onClick} data-tip={`${props.name} · ${props.value}`}>
        <span className="n">{props.name}</span>
      </div>
    );
  }
  return (
    <div className={cls} onClick={props.onClick} data-tip={props.tip}>
      <span
        className="pin"
        style={{ background: props.color }}
        data-tip="change color"
        onClick={(e) => { e.stopPropagation(); props.onPinClick?.(e); }}
      />
      <span className={"s-icon " + props.kind} data-tip={KIND_TIP[props.kind]}>{ICON[props.kind]}</span>
      <span className="n">{props.name}</span>
      <span className="v">{props.value}</span>
      <span
        className={"eye" + (props.hidden ? " off" : "")}
        data-tip={props.hidden ? "show signal" : "dim signal"}
        onClick={(e) => { e.stopPropagation(); props.onToggleVisible?.(e); }}
      >{props.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</span>
    </div>
  );
}
