import { Activity, ListChevronsUpDown, CircleCheck, Clock, EqualApproximately, RotateCcw } from "lucide-react";

export type ActiveSignalKind = "clock" | "reset" | "valid" | "derived" | "signal";

export interface ActiveSignalProps {
  name: string;
  value: string;
  kind: ActiveSignalKind;
  radix: string;
  color: string;
  pinned?: boolean;
  selected?: boolean;
  nested?: boolean;
  onPinClick?: (e: React.MouseEvent<HTMLElement>) => void;
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
  const cls = ["s-row", props.selected ? "sel" : "", props.nested ? "nested" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} onClick={props.onClick}>
      <span
        className="pin"
        style={{ background: props.color }}
        data-tip="change color"
        onClick={(e) => { e.stopPropagation(); props.onPinClick?.(e); }}
      />
      <span className={"s-icon " + props.kind} data-tip={KIND_TIP[props.kind]}>{ICON[props.kind]}</span>
      <span className="n">{props.name}</span>
      <span className="v">{props.value}</span>
      <span className="kebab" data-tip="drag to reorder"><ListChevronsUpDown size={12} /></span>
    </div>
  );
}
