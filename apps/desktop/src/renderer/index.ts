async function init(): Promise<void> {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("canvas#gpu missing");

  if (!navigator.gpu) {
    document.body.innerText = "WebGPU not available";
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    document.body.innerText = "no GPU adapter";
    return;
  }
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu") as GPUCanvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  console.log("riptide: adapter", adapter.info ?? "(no info)");
  console.log("riptide: format", format);

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
  };
  resize();
  window.addEventListener("resize", resize);

  const frame = (): void => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.063, g: 0.071, b: 0.086, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

init().catch((e) => {
  console.error(e);
  document.body.innerText = String(e);
});
