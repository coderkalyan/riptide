import { GPUContext } from "./device";
import { DigitalRenderer, SignalPipeline } from "./digital";
import { TextRenderer } from "./text";
import { Viewport } from "./data";

export function renderFrame(
  { device, ctx }: GPUContext,
  renderer: DigitalRenderer,
  pipelines: SignalPipeline[],
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

  for (const pipeline of pipelines) {
    pass.setPipeline(pipeline.pipeline);
    pass.setBindGroup(0, pipeline.bindGroup);
    pass.draw(4, pipeline.segmentCount);
  }

  if (text.glyphCount > 0) {
    pass.setPipeline(text.pipeline);
    pass.setBindGroup(0, text.bindGroup);
    pass.draw(4, text.glyphCount);
  }

  pass.end();

  device.queue.submit([enc.finish()]);
}
