import { Activity, Ellipsis, LayoutGrid, Minus } from "lucide-react";

export type SignalKind = "enum" | "bus" | "scalar";

export interface ActiveSignalProps {
  name: string;
  value: string;
  kind: SignalKind;
  radix: string;
  pinned?: boolean;
  selected?: boolean;
  nested?: boolean;
}

const ICON = {
  enum: <LayoutGrid size={12} />,
  bus: <Activity size={12} />,
  scalar: <Minus size={12} />,
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
