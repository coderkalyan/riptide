import { Activity, Ellipsis, Equal } from "lucide-react";

export type SignalType = "clk" | "bool" | "bus" | "enum" | "drv";

export interface ActiveSignalProps {
  name: string;
  value: string;
  type: SignalType;
  radix: string;
  pinned?: boolean;
  selected?: boolean;
  nested?: boolean;
}

export function ActiveSignal(props: ActiveSignalProps) {
  const cls = ["s-row", props.selected ? "sel" : "", props.nested ? "nested" : ""]
    .filter(Boolean)
    .join(" ");
  const isDrv = props.type === "drv";
  return (
    <div className={cls}>
      <span className={"pin" + (props.pinned ? " on" : "")}>●</span>
      <span className={"s-icon " + props.type}>
        {isDrv ? <Equal size={12} /> : <Activity size={12} />}
      </span>
      <span className="n">{props.name}</span>
      <span className="v">{props.value}</span>
      <span className="kebab"><Ellipsis size={12} /></span>
    </div>
  );
}
