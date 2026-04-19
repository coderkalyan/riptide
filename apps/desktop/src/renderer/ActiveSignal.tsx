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
  return (
    <div className={cls}>
      <span className={"pin" + (props.pinned ? " on" : "")}>●</span>
      <span className="s-name">
        <span className="n">{props.name}</span>
        <span className="v">{props.value}</span>
      </span>
      <span className={"tag " + props.type}>{props.type}</span>
      <span className="radix">{props.radix} ▾</span>
      <span className="kebab">⋯</span>
    </div>
  );
}
