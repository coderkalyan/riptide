import type {
  Direction,
  EnumType,
  Hierarchy,
  HierNode,
  NodeId,
  Scope,
  ScopeType,
  Signal,
  Timescale,
  VarType,
  VhdlDataType,
  VhdlVarType,
} from "./types";

// Incremental builder — mirrors the streaming nature of VCD / FST hierarchy
// blocks (scope-open, var, attr, upscope).
export class HierarchyBuilder {
  private nodes = new Map<NodeId, HierNode>();
  private rootIds: NodeId[] = [];
  private byHandle = new Map<string, NodeId[]>();
  private enumTypes = new Map<number, EnumType>();
  private stack: NodeId[] = [];
  private nextId = 0;
  private format: Hierarchy["format"] = "unknown";
  private timescale: Timescale = { value: 1, unit: "ns" };

  setFormat(format: Hierarchy["format"]): this {
    this.format = format;
    return this;
  }

  setTimescale(timescale: Timescale): this {
    this.timescale = timescale;
    return this;
  }

  addEnumType(t: EnumType): this {
    this.enumTypes.set(t.id, t);
    return this;
  }

  openScope(
    name: string,
    scopeType: ScopeType,
    extra?: Pick<Scope, "declSourceLoc" | "instSourceLoc" | "comment">,
  ): NodeId {
    const parent = this.stack.length ? this.stack[this.stack.length - 1] : null;
    const id = this.nextId++;
    const scope: Scope = { kind: "scope", id, parent, name, scopeType, children: [], ...extra };
    this.nodes.set(id, scope);
    if (parent == null) this.rootIds.push(id);
    else (this.nodes.get(parent) as Scope).children.push(id);
    this.stack.push(id);
    return id;
  }

  closeScope(): void {
    if (!this.stack.length) throw new Error("closeScope without openScope");
    this.stack.pop();
  }

  addSignal(params: {
    name: string;
    varType: VarType;
    direction?: Direction;
    bitWidth: number;
    handle: string;
    vhdlVarType?: VhdlVarType;
    vhdlDataType?: VhdlDataType;
    enumTypeId?: number;
    sourceLoc?: Signal["sourceLoc"];
    comment?: string;
  }): NodeId {
    if (!this.stack.length) throw new Error("addSignal outside any scope");
    const parent = this.stack[this.stack.length - 1];
    const id = this.nextId++;
    const sig: Signal = {
      kind: "signal",
      id,
      parent,
      direction: params.direction ?? "implicit",
      ...params,
    };
    this.nodes.set(id, sig);
    (this.nodes.get(parent) as Scope).children.push(id);
    const aliases = this.byHandle.get(sig.handle);
    if (aliases) aliases.push(id);
    else this.byHandle.set(sig.handle, [id]);
    return id;
  }

  build(): Hierarchy {
    if (this.stack.length) throw new Error(`Unclosed scopes: depth=${this.stack.length}`);
    return {
      nodes: this.nodes,
      rootIds: this.rootIds,
      byHandle: this.byHandle,
      enumTypes: this.enumTypes,
      format: this.format,
      timescale: this.timescale,
    };
  }
}

export function getScope(h: Hierarchy, id: NodeId): Scope {
  const n = h.nodes.get(id);
  if (!n || n.kind !== "scope") throw new Error(`Node ${id} is not a scope`);
  return n;
}

export function getSignal(h: Hierarchy, id: NodeId): Signal {
  const n = h.nodes.get(id);
  if (!n || n.kind !== "signal") throw new Error(`Node ${id} is not a signal`);
  return n;
}
