declare const require: (m: string) => unknown;

interface NativeModule {
  getMockSegments(): {
    multi: ArrayBuffer;
    multiCount: number;
    single: ArrayBuffer;
    singleCount: number;
  };
}

const native = require("../native/riptide.node") as NativeModule;

export interface NativeMockSegments {
  multi: Uint32Array<ArrayBuffer>;
  multiCount: number;
  single: Uint32Array<ArrayBuffer>;
  singleCount: number;
}

export function getMockSegments(): NativeMockSegments {
  const r = native.getMockSegments();
  return {
    multi: new Uint32Array(r.multi),
    multiCount: r.multiCount,
    single: new Uint32Array(r.single),
    singleCount: r.singleCount,
  };
}
