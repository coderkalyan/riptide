// Testbench for the SDI sample. Exists to produce `gate.vcd`, whose scope and
// leaf names the SDI binding rules are checked against.
module tb;
  logic        clk = 1'b0;
  logic        rst_n = 1'b0;
  logic        start = 1'b0;
  logic [7:0]  din = 8'h00;
  logic [1:0]  wptr = 2'd0;
  logic [15:0] sum;
  logic [11:0] hdr_out;

  gate dut (
    .clk (clk), .rst_n (rst_n), .start (start), .din (din),
    .wptr (wptr), .sum (sum), .hdr_out (hdr_out)
  );

  always #5 clk = ~clk;

  initial begin
    $dumpfile("gate.vcd");
    $dumpvars(0, tb);
    #12 rst_n = 1'b1;
    din = 8'h21;
    for (int c = 0; c < 8; c++) begin
      @(posedge clk);
      start <= (c % 3 == 0);
      wptr  <= c[1:0];
      din   <= din + 8'h11;
    end
    #20 $finish;
  end
endmodule
