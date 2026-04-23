import { HierarchyBuilder } from "./hierarchy";
import type { Hierarchy, NodeId } from "./types";

export interface ActiveSignalRef {
  signalId: NodeId;
  row: number;
  radix: "bin" | "hex" | "dec";
  pinned?: boolean;
  selected?: boolean;
}

export interface MockScene {
  hierarchy: Hierarchy;
  activeSignals: ActiveSignalRef[];
  initialExpanded: Set<NodeId>;
}

function buildMock(): MockScene {
  const b = new HierarchyBuilder().setFormat("fst").setTimescale({ value: 1, unit: "ns" });
  const expanded: NodeId[] = [];
  let handleCounter = 0;
  const h = () => `!${(handleCounter++).toString(36)}`;
  const wire = (name: string, bitWidth: number, extra?: { enumTypeId?: number }) =>
    b.addSignal({ name, varType: "vcd_wire", bitWidth, handle: h(), direction: "implicit", ...extra });

  b.addEnumType({
    id: 1,
    name: "state_t",
    members: [
      { raw: "00", label: "IDLE" },
      { raw: "01", label: "SEND" },
      { raw: "10", label: "RECV" },
    ],
  });

  const top = b.openScope("top", "module"); expanded.push(top);

  b.openScope("des", "module"); b.closeScope();

  const keysched = b.openScope("keysched", "module"); expanded.push(keysched);
  wire("clk", 1);
  wire("rst_n", 1);
  wire("c[10:0]", 11);
  wire("load1[0:8]", 9);
  wire("load2[0:8]", 9);
  wire("load3[0:8]", 9);
  wire("data[31:0]", 32);
  wire("state[1:0]", 2, { enumTypeId: 1 });
  b.openScope("fsm", "module"); b.closeScope();
  b.openScope("xbar", "module"); b.closeScope();

  const waves = b.openScope("waves", "module"); expanded.push(waves);
  const ids = {
    single_clk_posedge: wire("single_clk_posedge", 1),
    single_data_mix_a: wire("single_data_mix_a", 1),
    single_data_mix_b: wire("single_data_mix_b", 1),
    single_data_mix_c: wire("single_data_mix_c", 1),
    multi_data_2b: wire("multi_data_2b", 2),
    multi_data_4b: wire("multi_data_4b", 4),
    multi_data_8b: wire("multi_data_8b", 8),
    multi_data_12b: wire("multi_data_12b", 12),
    valid: wire("valid", 1),
    data_7_0: wire("data[7:0]", 8),
    bit_muted: wire("bit_muted", 1),
  };
  b.closeScope(); // waves

  b.closeScope(); // keysched

  b.openScope("mem_ctrl", "module"); b.closeScope();
  b.openScope("dma", "module"); b.closeScope();
  b.openScope("uart", "module"); b.closeScope();

  b.closeScope(); // top

  const activeSignals: ActiveSignalRef[] = [
    { signalId: ids.single_clk_posedge, row: 0, radix: "bin", pinned: true },
    { signalId: ids.single_data_mix_a, row: 1, radix: "bin" },
    { signalId: ids.single_data_mix_b, row: 2, radix: "bin" },
    { signalId: ids.single_data_mix_c, row: 3, radix: "bin" },
    { signalId: ids.multi_data_2b, row: 4, radix: "bin", selected: true },
    { signalId: ids.multi_data_4b, row: 5, radix: "bin" },
    { signalId: ids.multi_data_8b, row: 6, radix: "bin" },
    { signalId: ids.multi_data_12b, row: 7, radix: "bin" },
    { signalId: ids.valid, row: 8, radix: "bin" },
    { signalId: ids.data_7_0, row: 9, radix: "hex" },
    { signalId: ids.bit_muted, row: 10, radix: "bin" },
  ];

  return {
    hierarchy: b.build(),
    activeSignals,
    initialExpanded: new Set(expanded),
  };
}

export const MOCK_SCENE = buildMock();
