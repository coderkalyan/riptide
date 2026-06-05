// Canvas snapshot bridge. A WebGPU canvas's drawing buffer is invalidated after
// present, so `toBlob` is only reliable in the same task as a render. Callers
// queue a request; the rAF loop drains it right after `renderFrame` (see
// WaveCanvas), guaranteeing the front buffer still holds the frame.
let pending: Array<(blob: Blob | null) => void> = [];

// Request a PNG snapshot of the next rendered frame. Resolves null if encoding
// fails or no canvas is mounted (drain never runs).
export function requestCanvasCapture(): Promise<Blob | null> {
  return new Promise((resolve) => pending.push(resolve));
}

// True when a snapshot is queued — the (optimized) frame loop must render even if
// nothing else changed so drainCaptures has a fresh front buffer to read.
export function hasPendingCaptures(): boolean {
  return pending.length > 0;
}

// Called by the frame loop after renderFrame. No-op when nothing is queued.
export function drainCaptures(canvas: HTMLCanvasElement): void {
  if (pending.length === 0) return;
  const resolvers = pending;
  pending = [];
  canvas.toBlob((blob) => { for (const r of resolvers) r(blob); }, "image/png");
}
