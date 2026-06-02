import { GPUContext } from "./device";
import { DigitalRenderer, SignalPipeline } from "./digital";
import { LineBatch } from "./lines";
import { RectBatch } from "./rect";
import { TextBatch } from "./text";
import { Viewport } from "./data";
import { GpuTimer } from "./timing";

export interface PillLayer {
  rects: RectBatch;
  text: TextBatch;
}

export interface FrameLayers {
  linesBg: LineBatch;
  rectsBg: RectBatch;
  linesFg: LineBatch;
  textBody: TextBatch;
  // Each pill (marker, cursor, ...) gets its own rect+text pair so its rect
  // covers any earlier pill's text — opaque painter's algorithm, no z buffer.
  pills: PillLayer[];
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

  drawText(pass, layers.textBody);
  drawLines(pass, layers.linesFg);

  // Pill overlays draw last — opaque, on top of everything else. Per-pill
  // rect+text pairs so each pill fully occludes earlier ones on overlap.
  for (const pill of layers.pills) {
    drawRects(pass, pill.rects);
    drawText(pass, pill.text);
  }

  pass.end();
  gpuTimer?.resolve(enc);

  device.queue.submit([enc.finish()]);
  gpuTimer?.readback();
}
