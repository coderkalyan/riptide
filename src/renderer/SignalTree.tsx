import { createContext, useContext, ReactNode } from "react";
import { Box, ChevronRight, ChevronDown, Clock, Minus, Layers, LayoutGrid, Plus, Equal, Activity } from "lucide-react";

const DepthContext = createContext(0);

export function SignalTree({ children }: { children: ReactNode }) {
  return <div className="tree">{children}</div>;
}

export interface ScopeProps {
  name: string;
  badge?: string;
  expanded?: boolean;
  children?: ReactNode;
}

export function Scope({ name, badge, expanded, children }: ScopeProps) {
  const depth = useContext(DepthContext);
  const cls = ["t-row", depth > 0 ? `indent-${depth}` : ""].filter(Boolean).join(" ");
  return (
    <>
      <div className={cls}>
        <span className="chev">
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        <span className="icon module"><Box size={12} /></span>
        <span className="lbl">{name}</span>
        {/* {badge && <span className="count">{badge}</span>} */}
      </div>
      {expanded && (
        <DepthContext.Provider value={depth + 1}>
          {children}
        </DepthContext.Provider>
      )}
    </>
  );
}

export type SignalIconKind = "clk" | "bus" | "bus2" | "state" | "drv" | "";

const KIND_ICON: Record<SignalIconKind, ReactNode> = {
  clk: <Clock size={12} />,
  bus: <Activity size={12} />,
  bus2: <Activity size={12} />,
  state: <LayoutGrid size={12} />,
  drv: <Equal size={12} />,
  "": <Minus size={12} />,
};

export interface SignalNodeProps {
  name: string;
  iconKind?: SignalIconKind;
  count?: string;
  plus?: boolean;
  selected?: boolean;
}

export function SignalNode({ name, iconKind = "", count, plus, selected }: SignalNodeProps) {
  const depth = useContext(DepthContext);
  const cls = ["t-row", depth > 0 ? `indent-${depth}` : "", selected ? "sel" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <span className="chev" />
      <span className={"icon" + (iconKind ? ` ${iconKind}` : "")}>{KIND_ICON[iconKind]}</span>
      <span className="lbl">{name}</span>
      {/* {count && <span className="count">{count}</span>} */}
      {plus && <span className="plus"><Plus size={12} /></span>}
    </div>
  );
}
