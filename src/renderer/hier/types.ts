export type NodeId = number;

export type HierNode = Scope | Signal;

export interface Scope {
  kind: "scope";
  id: NodeId;
  parent: NodeId | null;
  name: string;
  scopeType: ScopeType;
  children: NodeId[];
  declSourceLoc?: SourceLoc;
  instSourceLoc?: SourceLoc;
  comment?: string;
}

export interface Signal {
  kind: "signal";
  id: NodeId;
  parent: NodeId;
  name: string;
  varType: VarType;
  vhdlVarType?: VhdlVarType;
  vhdlDataType?: VhdlDataType;
  direction: Direction;
  bitWidth: number;
  handle: string;
  // False when tide ingested no renderable samples for this signal (real / string
  // / never-assigned). Such signals appear in the tree but can't be added — the
  // pack path would panic on the missing db handle. Set natively (see main.zig).
  supported: boolean;
  enumTypeId?: number;
  sourceLoc?: SourceLoc;
  comment?: string;
}

export interface SourceLoc {
  file: string;
  line: number;
}

export type Direction =
  | "implicit"
  | "input"
  | "output"
  | "inout"
  | "buffer"
  | "linkage";

export type ScopeType =
  | "module"
  | "task"
  | "function"
  | "begin"
  | "fork"
  | "generate"
  | "struct"
  | "union"
  | "class"
  | "interface"
  | "package"
  | "program"
  | "vhdl_architecture"
  | "vhdl_procedure"
  | "vhdl_function"
  | "vhdl_record"
  | "vhdl_process"
  | "vhdl_block"
  | "vhdl_for_generate"
  | "vhdl_if_generate"
  | "vhdl_generate"
  | "vhdl_package";

export type VarType =
  | "vcd_event"
  | "vcd_integer"
  | "vcd_parameter"
  | "vcd_real"
  | "vcd_real_parameter"
  | "vcd_reg"
  | "vcd_supply0"
  | "vcd_supply1"
  | "vcd_time"
  | "vcd_tri"
  | "vcd_triand"
  | "vcd_trior"
  | "vcd_trireg"
  | "vcd_tri0"
  | "vcd_tri1"
  | "vcd_wand"
  | "vcd_wire"
  | "vcd_wor"
  | "vcd_port"
  | "vcd_sparray"
  | "vcd_realtime"
  | "gen_string"
  | "sv_bit"
  | "sv_logic"
  | "sv_int"
  | "sv_shortint"
  | "sv_longint"
  | "sv_byte"
  | "sv_enum"
  | "sv_shortreal";

export type VhdlVarType =
  | "vhdl_signal"
  | "vhdl_variable"
  | "vhdl_constant"
  | "vhdl_file"
  | "vhdl_memory";

export type VhdlDataType =
  | "vhdl_boolean"
  | "vhdl_bit"
  | "vhdl_bit_vector"
  | "vhdl_std_ulogic"
  | "vhdl_std_ulogic_vector"
  | "vhdl_std_logic"
  | "vhdl_std_logic_vector"
  | "vhdl_unsigned"
  | "vhdl_signed"
  | "vhdl_integer"
  | "vhdl_real"
  | "vhdl_natural"
  | "vhdl_positive"
  | "vhdl_time"
  | "vhdl_character"
  | "vhdl_string";

export interface EnumType {
  id: number;
  name: string;
  members: { raw: string; label: string }[];
}

export interface Hierarchy {
  nodes: Map<NodeId, HierNode>;
  rootIds: NodeId[];
  byHandle: Map<string, NodeId[]>;
  enumTypes: Map<number, EnumType>;
  timescale: Timescale;
  // The trace's true end tick (last ingested timestamp, from native). Source of
  // truth for the fit window / viewport clamps / zoom-out dead-zone.
  endTicks: number;
}

export type TimeUnit = "s" | "ms" | "us" | "ns" | "ps" | "fs";

export interface Timescale {
  value: number;
  unit: TimeUnit;
  // Verilog `timescale` carries two magnitudes: the time unit (above) and the
  // time precision (rounding granularity). Optional — VCD/FST dumps may omit it.
  precision?: { value: number; unit: TimeUnit };
}

// ---- derivations -------------------------------------------------------

// 2-state: sv_bit, sv_int/sv_shortint/sv_longint/sv_byte, VHDL bit/boolean/integer/natural/positive.
// 9-state: VHDL std_(u)logic(_vector).
// Everything else VCD/SV is 4-state.
export function stateCount(sig: Signal): 2 | 4 | 9 {
  if (sig.vhdlDataType) {
    switch (sig.vhdlDataType) {
      case "vhdl_std_logic":
      case "vhdl_std_logic_vector":
      case "vhdl_std_ulogic":
      case "vhdl_std_ulogic_vector":
        return 9;
      case "vhdl_bit":
      case "vhdl_bit_vector":
      case "vhdl_boolean":
      case "vhdl_integer":
      case "vhdl_natural":
      case "vhdl_positive":
      case "vhdl_unsigned":
      case "vhdl_signed":
        return 2;
    }
  }
  switch (sig.varType) {
    case "sv_bit":
    case "sv_int":
    case "sv_shortint":
    case "sv_longint":
    case "sv_byte":
      return 2;
    default:
      return 4;
  }
}

export function isSigned(sig: Signal): boolean {
  if (sig.vhdlDataType === "vhdl_signed" || sig.vhdlDataType === "vhdl_integer") return true;
  if (sig.vhdlDataType === "vhdl_unsigned" || sig.vhdlDataType === "vhdl_natural" || sig.vhdlDataType === "vhdl_positive") return false;
  return sig.varType === "sv_int" || sig.varType === "sv_shortint" || sig.varType === "sv_longint" || sig.varType === "sv_byte" || sig.varType === "vcd_integer";
}

// Parse "[7:0]" / "[msb:lsb]" from signal name. Returns null if absent.
export function declaredRange(sig: Signal): { msb: number; lsb: number } | null {
  const m = sig.name.match(/\[(\d+):(\d+)\]\s*$/);
  return m ? { msb: +m[1], lsb: +m[2] } : null;
}

export function pathOf(h: Hierarchy, id: NodeId): string {
  const parts: string[] = [];
  let cur: HierNode | undefined = h.nodes.get(id);
  while (cur) {
    parts.push(cur.name);
    cur = cur.parent == null ? undefined : h.nodes.get(cur.parent);
  }
  return parts.reverse().join(".");
}
