import { GPUContext } from "./device";
import { DigitalPipeline } from "./pipelines/digital";
import { Viewport } from "./data";

export function renderFrame(
  { device, ctx }: GPUContext,
  digital: DigitalPipeline,
  vp: Viewport,
): void {
  digital.updateViewport(vp);

  const enc  = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view:       ctx.getCurrentTexture().createView(),
      loadOp:     "clear",
      clearValue: { r: 0.106, g: 0.114, b: 0.129, a: 1 },
      storeOp:    "store",
    }],
  });

  pass.setPipeline(digital.pipeline);
  pass.setBindGroup(0, digital.bindGroup);
  pass.draw(12, digital.segmentCount);  // 12 verts × N instances (fill + line)
  pass.end();

  device.queue.submit([enc.finish()]);
}
