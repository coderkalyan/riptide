// napi_build::setup() emits the per-platform link configuration the addon needs:
// `-undefined dynamic_lookup` on macOS (the napi_* symbols are exported by the
// Electron host executable, not a dylib) and `-Wl,-z,nodelete` on glibc Linux.
// Windows needs nothing at link time — napi-sys resolves every symbol at module
// init through the running electron.exe image.
fn main() {
    napi_build::setup();
}
