import { Ellipsis, Equal } from "lucide-react";
import { ReactNode } from "react";

export function DerivedSignals({ children }: { children?: ReactNode }) {
  return <div className="derived">{children}</div>;
}

export interface DerivedSignalProps {
  name: string;
  expr: string;
}

export function DerivedSignal({ name, expr }: DerivedSignalProps) {
  return (
    <div className="d-row">
      <div className="d-row-top">
        <span className="icon drv"><Equal size={12} /></span>
        <span className="lbl">{name}</span>
        <span className="kebab"><Ellipsis size={12} /></span>
      </div>
      {/* <div className="d-expr mono" title={expr}>{expr}</div> */}
    </div>
  );
}
