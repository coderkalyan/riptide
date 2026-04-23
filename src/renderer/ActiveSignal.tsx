import { Activity, CircleCheck, Clock, Ellipsis, Equal, RotateCcw } from "lucide-react";

export type ActiveSignalKind = "clock" | "reset" | "valid" | "derived" | "signal";

export interface ActiveSignalProps {
  name: string;
  value: string;
  kind: ActiveSignalKind;
  radix: string;
  pinned?: boolean;
  selected?: boolean;
  nested?: boolean;
}

const ICON = {
  clock: <Clock size={12} />,
  reset: <RotateCcw size={12} />,
  valid: <CircleCheck size={12} />,
  derived: <Equal size={12} />,
  signal: <Activity size={12} />,
} as const;

export function ActiveSignal(props: ActiveSignalProps) {
  const cls = ["s-row", props.selected ? "sel" : "", props.nested ? "nested" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <span className={"pin" + (props.pinned ? " on" : "")}>●</span>
      <span className={"s-icon " + props.kind}>{ICON[props.kind]}</span>
      <span className="n">{props.name}</span>
      <span className="v">{props.value}</span>
      <span className="kebab"><Ellipsis size={12} /></span>
    </div>
  );
}
