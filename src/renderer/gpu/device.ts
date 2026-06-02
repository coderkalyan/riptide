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

  // Opt into timestamp-query when the adapter exposes it, so the perf overlay
  // can measure real GPU pass time. Absent on some backends — the GpuTimer
  // no-ops in that case.
  const requiredFeatures: GPUFeatureName[] = [];
  if (adapter.features.has("timestamp-query")) requiredFeatures.push("timestamp-query");
  // The default limits are conservative (maxStorageBufferBindingSize 128 MiB,
  // maxBufferSize 256 MiB) — too small for large traces' storage buffers (sample
  // pools, segment buffers, the value-label instance buffer). Request the
  // adapter's actual maximums so big VCDs fit. Requesting the adapter's own
  // reported limits is always valid.
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });

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
