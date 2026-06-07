import { GPUContext } from "./device";
import { DigitalRenderer, SignalPipeline } from "./digital";
import { LineBatch } from "./lines";
import { RectBatch } from "./rect";
import { TextBatch } from "./text";
import { LabelBatch } from "./labels";
import { Viewport } from "./data";
import { GpuTimer } from "./timing";

// One pill's slice of the shared pill rect/text buffers. Per-pill *draws* (not
// buffers) preserve the painter's-order occlusion — each pill's rect draws
// before, and so under, the next pill's rect, covering earlier pills' text.
export interface PillRange {
  rectStart: number; rectCount: number;
  textStart: number; textCount: number;
}

export interface FrameLayers {
  linesBg: LineBatch;
  rectsBg: RectBatch;
  // Multi-bit value labels — instanced, GPU-positioned + culled. Drawn on top of
  // the digital pipelines (inside the pills).
  labels: LabelBatch;
  // Single-pipeline value labels — the boolean format's true/false text, drawn
  // over the high/low line (same renderer, separate instance buffer + segments).
  labelsSingle: LabelBatch;
  linesFg: LineBatch;
  textBody: TextBatch;
  // All pills (markers + cursor) share one rect buffer + one text buffer (filled
  // in one writeBuffer each per frame); pillRanges[i] addresses pill i's slice,
  // drawn individually via firstInstance to keep the per-pill occlusion order.
  pillRects: RectBatch;
  pillText: TextBatch;
  pillRanges: PillRange[];
  pillRangeCount: number;
}

function drawLines(pass: GPURenderPassEncoder, b: LineBatch): void {
  if (b.lineCount === 0) return;
  pass.setPipeline(b.pipeline);
  pass.setBindGroup(0, b.bindGroup);
  pass.draw(4, b.lineCount);
}
function drawRects(pass: GPURenderPassEncoder, b: RectBatch): void {
  if (b.rectCount === 0) return;
  pass.setPipeline(b.pipeline);
  pass.setBindGroup(0, b.bindGroup);
  pass.draw(4, b.rectCount);
}
function drawText(pass: GPURenderPassEncoder, b: TextBatch): void {
  if (b.glyphCount === 0) return;
  pass.setPipeline(b.pipeline);
  pass.setBindGroup(0, b.bindGroup);
  pass.draw(4, b.glyphCount);
}
function drawLabels(pass: GPURenderPassEncoder, b: LabelBatch): void {
  if (b.glyphCount === 0 || !b.bindGroup) return;
  pass.setPipeline(b.pipeline);
  pass.setBindGroup(0, b.bindGroup);
  pass.draw(4, b.glyphCount);
}

const CLEAR_VALUE = { r: 0.106, g: 0.114, b: 0.129, a: 1 };

export function renderFrame(
  { device, ctx }: GPUContext,
  renderer: DigitalRenderer,
  pipelines: SignalPipeline[],
  layers: FrameLayers,
  vp: Viewport,
  gpuTimer?: GpuTimer,
): void {
  renderer.writeViewport(vp);

  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: ctx.getCurrentTexture().createView(),
      loadOp: "clear",
      clearValue: CLEAR_VALUE,
      storeOp: "store",
    }],
    timestampWrites: gpuTimer?.begin(),
  });

  drawLines(pass, layers.linesBg);
  drawRects(pass, layers.rectsBg);

  for (const pipeline of pipelines) {
    pass.setPipeline(pipeline.pipeline);
    pass.setBindGroup(0, pipeline.bindGroup);
    pass.draw(4, pipeline.segmentCount);
  }

  // Value labels sit inside the multi-bit pills → draw after the digital pass.
  drawLabels(pass, layers.labels);
  // Boolean true/false labels over the single-bit lines.
  drawLabels(pass, layers.labelsSingle);

  drawText(pass, layers.textBody);
  drawLines(pass, layers.linesFg);

  // Pill overlays draw last — opaque, on top of everything else. One draw per
  // pill (rect then text) into the shared buffers via firstInstance, so each
  // pill's rect fully occludes earlier pills on overlap.
  const { pillRects, pillText, pillRanges } = layers;
  for (let i = 0; i < layers.pillRangeCount; i++) {
    const pr = pillRanges[i];
    if (pr.rectCount > 0) {
      pass.setPipeline(pillRects.pipeline);
      pass.setBindGroup(0, pillRects.bindGroup);
      pass.draw(4, pr.rectCount, 0, pr.rectStart);
    }
    if (pr.textCount > 0) {
      pass.setPipeline(pillText.pipeline);
      pass.setBindGroup(0, pillText.bindGroup);
      pass.draw(4, pr.textCount, 0, pr.textStart);
    }
  }

  pass.end();
  gpuTimer?.resolve(enc);

  device.queue.submit([enc.finish()]);
  gpuTimer?.readback();
}
