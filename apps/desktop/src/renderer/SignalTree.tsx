import { createContext, useContext, ReactNode } from "react";

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
        <span className="chev">{expanded ? "▾" : "▸"}</span>
        <span className="icon">{expanded ? "▣" : "▢"}</span>
        <span className="lbl">{name}</span>
        {badge && <span className="count">{badge}</span>}
      </div>
      {expanded && (
        <DepthContext.Provider value={depth + 1}>
          {children}
        </DepthContext.Provider>
      )}
    </>
  );
}

export type SignalIconKind = "clk" | "bus" | "bus2" | "drv" | "";

export interface SignalNodeProps {
  name: string;
  icon: string;
  iconKind?: SignalIconKind;
  count?: string;
  plus?: boolean;
  selected?: boolean;
}

export function SignalNode({ name, icon, iconKind, count, plus, selected }: SignalNodeProps) {
  const depth = useContext(DepthContext);
  const cls = ["t-row", depth > 0 ? `indent-${depth}` : "", selected ? "sel" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <span className="chev" />
      <span className={"icon" + (iconKind ? ` ${iconKind}` : "")}>{icon}</span>
      <span className="lbl">{name}</span>
      {count && <span className="count">{count}</span>}
      {plus && <span className="plus">＋</span>}
    </div>
  );
}

