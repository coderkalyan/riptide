// Sample design for the Riptide SDI schema (see docs/sdi.md).
// Two lanes of a small packet gate. Deliberately exercises every axis the
// schema exists for: an enum, a packed struct, an unpacked memory, a
// parameterized module, a generate loop, a black box, control dependence,
// a dynamic index, and a read-only assertion.

package pkt_pkg;
  // Lane state. VCD would report this as a plain 2-bit reg.
  typedef enum logic [1:0] {
    IDLE = 2'd0,
    BUSY = 2'd1,
    DONE = 2'd3
  } state_e;

  // Packed header. VCD would report this as one 12-bit vector.
  typedef struct packed {
    logic [7:0] payload;
    logic [2:0] len;
    logic       last;
  } pkt_t;
endpackage

module lane
  import pkt_pkg::*;
#(
  parameter int unsigned W = 8
) (
  input  logic         clk,
  input  logic         rst_n,   // active-low reset
  input  logic         start,
  input  logic [W-1:0] din,
  output state_e       state,
  output logic [W-1:0] dout
);
  state_e       nxt;
  logic [W-1:0] acc;

  always_comb begin
    nxt = state;
    if (state == IDLE && start) nxt = BUSY;
    else if (state == BUSY)     nxt = DONE;
    else if (state == DONE)     nxt = IDLE;
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) state <= IDLE;
    else        state <= nxt;
  end

  always_ff @(posedge clk) begin
    if (state == BUSY) acc <= acc + din;
  end

  assign dout = acc;
endmodule

module gate
  import pkt_pkg::*;
(
  input  logic        clk,
  input  logic        rst_n,
  input  logic        start,
  input  logic [7:0]  din,
  input  logic [1:0]  wptr,
  output logic [15:0] sum,
  output logic [11:0] hdr_out
);
  state_e     st       [2];
  logic [7:0] lane_out [2];
  pkt_t       hdr;
  logic [7:0] mem      [0:3];
  logic [7:0] crc;

  for (genvar i = 0; i < 2; i++) begin : g_lane
    lane #(.W(8)) u_lane (
      .clk   (clk),
      .rst_n (rst_n),
      .start (start),
      .din   (din),
      .state (st[i]),
      .dout  (lane_out[i])
    );
  end

  crc8 u_crc (.data(lane_out[0]), .crc(crc));

  always_ff @(posedge clk) begin
    if (st[0] == DONE) mem[wptr] <= lane_out[0];
  end

  assign hdr.payload = mem[0];
  assign hdr.len     = 3'd4;
  assign hdr.last    = (st[1] == DONE);
  assign hdr_out     = hdr;
  assign sum         = {8'h00, lane_out[0]} + {8'h00, lane_out[1]} + {8'h00, crc};

  assert property (@(posedge clk) disable iff (!rst_n) !$isunknown(st[0]));
endmodule
