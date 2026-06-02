// GPU frame timing via the WebGPU `timestamp-query` feature. Writes a timestamp
// at the start + end of the render pass, resolves them into a readback buffer,
// and reports the elapsed GPU ms asynchronously (a frame or two late — fine for
// rolling averages). Degrades to a no-op when the feature is unavailable so the
// frame loop stays branch-free.

export interface GpuTimer {
  supported: boolean;
  // For beginRenderPass({ timestampWrites }). undefined when timing can't run
  // this frame (feature off, or every readback buffer still mapped in flight).
  begin(): GPURenderPassTimestampWrites | undefined;
  // After pass.end(), before submit: resolve the query set into a readback buffer.
  resolve(enc: GPUCommandEncoder): void;
  // After submit: map the readback buffer and report the elapsed ms.
  readback(): void;
  destroy(): void;
}

const NOOP: GpuTimer = {
  supported: false,
  begin: () => undefined,
  resolve: () => { /* no-op */ },
  readback: () => { /* no-op */ },
  destroy: () => { /* no-op */ },
};

export function createGpuTimer(device: GPUDevice, onResult: (ms: number) => void): GpuTimer {
  if (!device.features.has("timestamp-query")) return NOOP;

  const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
  const resolveBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  // A small pool: mapAsync keeps a buffer checked out until its readback lands,
  // so a single buffer would stall timing every frame. 3 covers the in-flight
  // depth; if all are busy we simply skip timing that frame.
  const pool = Array.from({ length: 3 }, () =>
    device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
  const free: GPUBuffer[] = [...pool];

  let active = false;            // begin() ran + claimed a buffer this frame
  let current: GPUBuffer | null = null;

  return {
    supported: true,
    begin() {
      if (free.length === 0) { active = false; return undefined; }
      active = true;
      return { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    },
    resolve(enc) {
      if (!active) return;
      current = free.pop()!;
      enc.resolveQuerySet(querySet, 0, 2, resolveBuf, 0);
      enc.copyBufferToBuffer(resolveBuf, 0, current, 0, 16);
    },
    readback() {
      if (!active || !current) return;
      const buf = current;
      current = null;
      active = false;
      buf.mapAsync(GPUMapMode.READ).then(() => {
        const ts = new BigUint64Array(buf.getMappedRange().slice(0));
        buf.unmap();
        const ns = Number(ts[1] - ts[0]);
        if (ns >= 0 && Number.isFinite(ns)) onResult(ns / 1e6);
        free.push(buf);
      }).catch(() => { free.push(buf); });
    },
    destroy() {
      querySet.destroy();
      resolveBuf.destroy();
      for (const b of pool) b.destroy();
    },
  };
}
