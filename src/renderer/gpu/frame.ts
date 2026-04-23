import { GPUContext } from "./device";
import { SignalPipeline } from "./digital";
import { Viewport } from "./data";

export function renderFrame(
  { device, ctx }: GPUContext,
  pipelines: SignalPipeline[],
  vp: Viewport,
): void {
  for (const pipeline of pipelines) {
    pipeline.updateViewport(vp);
  }

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
    pass.draw(4, pipeline.segmentCount);  // 4 verts × N instances (triangle strip rect)
  }
  pass.end();

  device.queue.submit([enc.finish()]);
}
