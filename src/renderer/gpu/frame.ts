import { GPUContext } from "./device";
import { DigitalRenderer, SignalPipeline } from "./digital";
import { LineBatch } from "./lines";
import { RectBatch } from "./rect";
import { TextRenderer } from "./text";
import { Viewport } from "./data";

export function renderFrame(
  { device, ctx }: GPUContext,
  renderer: DigitalRenderer,
  pipelines: SignalPipeline[],
  linesBg: LineBatch,
  rects: RectBatch,
  linesFg: LineBatch,
  text: TextRenderer,
  vp: Viewport,
): void {
  renderer.writeViewport(vp);

  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: ctx.getCurrentTexture().createView(),
      loadOp: "clear",
      clearValue: { r: 0.106, g: 0.114, b: 0.129, a: 1 },
      storeOp: "store",
    }],
  });

  if (linesBg.lineCount > 0) {
    pass.setPipeline(linesBg.pipeline);
    pass.setBindGroup(0, linesBg.bindGroup);
    pass.draw(4, linesBg.lineCount);
  }

  if (rects.rectCount > 0) {
    pass.setPipeline(rects.pipeline);
    pass.setBindGroup(0, rects.bindGroup);
    pass.draw(4, rects.rectCount);
  }

  for (const pipeline of pipelines) {
    pass.setPipeline(pipeline.pipeline);
    pass.setBindGroup(0, pipeline.bindGroup);
    pass.draw(4, pipeline.segmentCount);
  }

  if (linesFg.lineCount > 0) {
    pass.setPipeline(linesFg.pipeline);
    pass.setBindGroup(0, linesFg.bindGroup);
    pass.draw(4, linesFg.lineCount);
  }

  if (text.glyphCount > 0) {
    pass.setPipeline(text.pipeline);
    pass.setBindGroup(0, text.bindGroup);
    pass.draw(4, text.glyphCount);
  }

  pass.end();

  device.queue.submit([enc.finish()]);
}
