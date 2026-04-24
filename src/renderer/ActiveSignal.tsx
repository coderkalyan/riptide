import { Activity, CircleCheck, Clock, Ellipsis, EqualApproximately, RotateCcw } from "lucide-react";

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
}

const ICON = {
  clock: <Clock size={12} />,
  reset: <RotateCcw size={12} />,
  valid: <CircleCheck size={12} />,
  derived: <EqualApproximately size={12} />,
  signal: <Activity size={12} />,
} as const;

export function ActiveSignal(props: ActiveSignalProps) {
  const cls = ["s-row", props.selected ? "sel" : "", props.nested ? "nested" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <span
        className="pin"
        style={{ background: props.color }}
        title="Click to change color"
        onClick={props.onPinClick}
      />
      <span className={"s-icon " + props.kind}>{ICON[props.kind]}</span>
      <span className="n">{props.name}</span>
      <span className="v">{props.value}</span>
      <span className="kebab"><Ellipsis size={12} /></span>
    </div>
  );
}
