// Stand-in for the opaque cell `gate.u_crc`. The sample SDI models u_crc as a
// black box (no `unit`, `blackBox: true`) — this file exists only so the sample
// can be simulated to produce a trace.
module crc8 (
  input  logic [7:0] data,
  output logic [7:0] crc
);
  assign crc = {data[6:0], 1'b0} ^ (data[7] ? 8'h07 : 8'h00);
endmodule
