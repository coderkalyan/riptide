export interface GPUContext {
  device: GPUDevice;
  ctx: GPUCanvasContext;
  format: GPUTextureFormat;
}

export class GPUInitError extends Error {}

export async function initGPU(canvas: HTMLCanvasElement): Promise<GPUContext> {
  if (!navigator.gpu) {
    throw new GPUInitError("WebGPU not supported in this browser/environment");
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    throw new GPUInitError("No WebGPU adapter found — check that hardware acceleration is enabled");
  }

  const device = await adapter.requestDevice();

  device.lost.then((info) => {
    console.error(`WebGPU device lost: ${info.message} (reason: ${info.reason})`);
  });

  const ctx = canvas.getContext("webgpu");
  if (!ctx) {
    throw new GPUInitError("Failed to get WebGPU context from canvas");
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });

  return { device, ctx, format };
}

// Call on every resize — keeps the canvas backing store in sync with CSS size.
// Assigning canvas.width/height resizes the swapchain; no reconfigure needed.
export function resizeCanvas(canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
}
