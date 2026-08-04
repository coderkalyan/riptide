// Source for the bundled mock trace (`mock.vcd`).
//
// The trace is hand-written, so this is the design it *describes* rather than the
// design it was generated from: every module, instance and signal name here
// matches a `$scope`/`$var` in `mock.vcd` exactly, and no module declares a signal
// the trace does not carry. It exists so the bundled demo can show source
// integration — declarations, doc comments and Open Declaration — without shipping
// a simulator. `mock.vcd.sdi.json` holds the spans into this file.
//
// Structural on purpose: the sub-blocks are instantiated with their ports left
// unconnected, because the trace's `top` and `keysched` scopes carry no variables
// of their own. Lints clean under:
//
//   $ verilator --lint-only native/src/mock.sv --top-module top \
//       -Wno-DECLFILENAME -Wno-PINMISSING -Wno-UNDRIVEN -Wno-UNUSEDSIGNAL -Wno-ASCRANGE

package mock_pkg;
  // Pipeline state of the key schedule. The trace stores this as a bare 2-bit
  // reg; this enum is why the viewer can show IDLE/BUSY/WAIT instead of 0/1/2.
  typedef enum logic [1:0] {
    IDLE = 2'd0,
    BUSY = 2'd1,
    WAIT = 2'd2
  } state_e;

  // Arbiter phase.
  typedef enum logic [2:0] {
    P_IDLE  = 3'd0,
    P_FETCH = 3'd1,
    P_APPLY = 3'd4
  } phase_e;
endpackage

// Empty by design: the trace declares this scope with no variables in it.
module des ();
endmodule

// Next-phase logic for the key schedule.
module fsm (
  input  mock_pkg::phase_e cur,   // current phase
  output mock_pkg::phase_e nxt    // phase on the next clock
);
  assign nxt = (cur == mock_pkg::P_IDLE) ? mock_pkg::P_FETCH : mock_pkg::P_IDLE;
endmodule

// Four-requester round-robin arbiter.
module xbar (
  input  logic [3:0] req,   // one bit per requester
  output logic [3:0] gnt    // at most one bit set
);
  assign gnt = req & ~(req - 4'd1);
endmodule

// The signals the bundled view puts on screen.
module waves (
  input logic clk   // sample clock, 10 ns period
);
  logic              rst;          // reset, active high
  mock_pkg::state_e  state;        // pipeline state
  logic [7:0]        cycle_count;  // cycles since reset
  logic              in_valid;     // input beat is valid this cycle
  logic [7:0]        in_data;      // input payload
  logic [15:0]       in_addr;      // input address
  logic              out_valid;    // output beat is valid this cycle
  logic [31:0]       out_data;     // output payload
  logic [3:0]        fifo_level;   // occupancy, 0..8
  logic [63:0]       wide_data;    // widest row in the bundled view

  // Continuously assigned, so the trace records these two as wires.
  wire               fifo_empty = (fifo_level == 4'd0);  // no entries queued
  wire [7:0]         dbus = in_valid ? in_data : 8'h00;  // debug bus tap

  always_ff @(posedge clk) begin
    if (rst) begin
      state       <= mock_pkg::IDLE;
      cycle_count <= 8'h00;
    end else begin
      state       <= in_valid ? mock_pkg::BUSY : mock_pkg::IDLE;
      cycle_count <= cycle_count + 8'h01;
    end
  end
endmodule

// Key schedule: three load stages feeding a 32-bit working register.
module keysched (
  input  logic             clk,
  input  logic             rst_n,   // active-low reset
  input  logic [10:0]      c,       // round counter
  input  logic [0:8]       load1,   // stage 1 load, ascending range
  input  logic [0:8]       load2,   // stage 2 load
  input  logic [0:8]       load3,   // stage 3 load
  output logic [31:0]      data,    // working register
  output mock_pkg::state_e state    // schedule state
);
  fsm   fsm   ();
  xbar  xbar  ();
  waves waves (.clk(clk));

  assign data  = {load1[0:7], load2[0:7], load3[0:7], {5'h00, c[2:0]}};
  assign state = rst_n ? mock_pkg::BUSY : mock_pkg::IDLE;
endmodule

// Single-port memory interface.
module mem_ctrl (
  input  logic [7:0] addr,   // byte address
  input  logic       wen,    // write enable
  output logic [7:0] rdata   // read data, valid the cycle after addr
);
  assign rdata = addr ^ {7'h00, wen};
endmodule

// Descriptor-driven copy engine.
module dma (
  input  logic [15:0] src,     // source address
  input  logic [15:0] dst,     // destination address
  output logic        active   // high while a transfer is in flight
);
  assign active = (src != dst);
endmodule

// 8N1 serial port.
module uart (
  input  logic        rx,     // receive line
  input  logic [15:0] baud,   // divisor for the bit clock
  output logic        tx      // transmit line, idles high
);
  assign tx = (baud == 16'h0000) ? 1'b1 : rx;
endmodule

module top ();
  des      des      ();
  keysched keysched ();
  mem_ctrl mem_ctrl ();
  dma      dma      ();
  uart     uart     ();
endmodule
