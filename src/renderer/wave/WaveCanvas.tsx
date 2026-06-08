import { onMount, onCleanup, createSignal, Show } from "solid-js";
import { initGPU, resizeCanvas, GPUInitError } from "../gpu/device";
import { createDigitalRenderer } from "../gpu/digital";
import { renderFrame, PillRange } from "../gpu/frame";
import { createColorBuffer, writeRowColors } from "../gpu/colors";
import { createTextRenderer, MAX_GLYPHS, ATLAS_MIDDLE_DOT } from "../gpu/text";
import { createLabelRenderer } from "../gpu/labels";
import { createLineRenderer } from "../gpu/lines";
import { createRectRenderer } from "../gpu/rect";
import { createGpuTimer } from "../gpu/timing";
import { TRACE_END, buildPackSpecs, packSpecsFor, handleForPath, type ActiveSignalRef } from "../hier/scene";
import { getMockSegments, hasTrace } from "../native";
import { hexToPacked } from "../hier/sidecar";
import { resetHighSpans } from "./clock";
import * as perf from "../perf";
import { useAppStore } from "../store/store";
import { view } from "./viewport";
import { drainCaptures, hasPendingCaptures } from "./capture";
import {
  ROW_HEIGHT_CSS, LINE_THICKNESS_CSS, LINE_HALF_CSS, NOTCH_HEIGHT, BOTTOM_RULER_HEIGHT,
  MAX_MARKERS, MARKER_GRAB_PX, SNAP_RADIUS_CSS, ZOOM_PER_DELTA_Y, ZOOM_OUT_FACTOR, WINDOW_SHRINK_FACTOR,
  DIVIDER_HEIGHT_CSS,
} from "./constants";
import * as P from "./palette";
import { dynamicRulerTicks, clockRulerTicks, rulerSpacing, formatTime, formatClockWhole, clockEdgesBetween, snapToClockEdge } from "./format";

type RectMut = { x: number; y: number; w: number; h: number; color: number; crosshatch?: boolean; rounded?: boolean; caret?: boolean; caretRight?: boolean; squareBottomLeft?: boolean; squareBottomRight?: boolean };
type LineMut = { x: number; color: number; dashed?: boolean; fullHeight?: boolean };

// Alpha for reset crosshatch bands — translucent so the ruler notches + dashed
// grid read through.
const RESET_BAND_ALPHA = 0x60;
// Blend the colors of the reset signals covering one sub-interval into a single
// translucent packed rgba (0xAABBGGRR). One signal → its own color; several
// overlapping → their average, so a merged band reads as a mix, not a glitch.
function resetBandColor(cols: number[]): number {
  let r = 0, g = 0, b = 0;
  for (const c of cols) { r += c & 0xff; g += (c >> 8) & 0xff; b += (c >> 16) & 0xff; }
  const n = cols.length;
  r = (r / n) | 0; g = (g / n) | 0; b = (b / n) | 0;
  return ((RESET_BAND_ALPHA << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

// The waveform canvas. Owns the imperative WebGPU pipeline + the rAF render
// loop. Reads document state synchronously via useAppStore.getState() (cursor,
// markers, snap/clock, hover) and the viewport controller; writes back via store
// actions (cursor/marker drag, viewRange report, hover). It never subscribes
// reactively for rendering — the loop pulls fresh state each frame — so the
// component mounts once and the canvas never re-renders.
export function WaveCanvas() {
  let host!: HTMLDivElement;
  let canvasEl!: HTMLCanvasElement;
  // Surfaced when WebGPU can't initialize or the device is lost — renders a DOM
  // overlay over the (blank) canvas instead of leaving a silent white area.
  const [gpuError, setGpuError] = createSignal<string | null>(null);

  onMount(() => {
    let raf = 0;
    let disposed = false;
    let lost = false; // set on GPUDevice loss — stops the frame loop (see device.lost below)
    // Optimized rendering: the rAF loop polls every frame but only does the
    // (expensive) geometry build + encode + GPU submit when something changed.
    // `needsRender` is the dirty flag; requestRender() arms it for non-store
    // triggers (resize/DPR). Store changes arm it via a broad subscription
    // below; in-flight zoom animation / pending repack / queued capture are
    // checked directly in the frame gate. The perf "force render" toggle
    // bypasses all of this to draw every frame. Starts true → first frame draws.
    let needsRender = true;
    const requestRender = () => { needsRender = true; };
    const cleanups: Array<() => void> = [];
    perf.stamp("gpu:start");

    initGPU(canvasEl).then(async ({ device, ctx, format }) => {
      if (disposed) return;
      const gpuCtx = { device, ctx, format };
      // Stop the loop + show a recovery message if the GPU device is lost (driver
      // reset / TDR / GPU switch). Without this the rAF loop keeps submitting to a
      // dead device and the canvas just freezes blank. reason "destroyed" = our own
      // teardown, not a real loss — ignore it.
      device.lost.then((info) => {
        if (disposed || info.reason === "destroyed") return;
        lost = true;
        setGpuError(`GPU device lost (${info.reason || "unknown"})${info.message ? `: ${info.message}` : ""}.`);
      });
      const gpuTimer = createGpuTimer(device, perf.pushGpu);
      perf.setGpuSupported(gpuTimer.supported);
      const colorBuf = createColorBuffer(device);
      writeRowColors(device, colorBuf, useAppStore.getState().activeSignals);
      const renderer = createDigitalRenderer(gpuCtx);

      perf.stamp("pack:start");
      // Initial pack covers the full trace [0, TRACE_END] to seed the GPU buffers;
      // the rAF loop re-windows to the viewport (+ over-fetch) on the first frame.
      const NATIVE = getMockSegments(buildPackSpecs(), 0, TRACE_END);
      perf.stamp("pack:end");

      let scene = renderer.createSceneBuffers(NATIVE.rowInfo, NATIVE.x0Pool, NATIVE.x1Pool);
      const [multiBitInit, singleBitInit, textRenderer, lineRenderer, rectRenderer] = await Promise.all([
        renderer.buildPipelineFromPacked("multi", NATIVE.multi, NATIVE.multiCount, colorBuf, scene),
        renderer.buildPipelineFromPacked("single", NATIVE.single, NATIVE.singleCount, colorBuf, scene),
        createTextRenderer(gpuCtx, renderer.uniformBuf),
        createLineRenderer(gpuCtx, renderer.uniformBuf),
        createRectRenderer(gpuCtx, renderer.uniformBuf),
      ]);
      if (disposed) return;
      let multiBit = multiBitInit;
      let singleBit = singleBitInit;

      const labelRenderer = await createLabelRenderer(
        gpuCtx, renderer.uniformBuf, textRenderer.atlasLgView, textRenderer.sampler, textRenderer.cellLg,
      );
      if (disposed) return;
      const labelBatch = labelRenderer.createBatch();
      labelBatch.setLabels(NATIVE.multi, NATIVE.multiCount, NATIVE.labelBytes, NATIVE.labelOffsets, scene.rowInfo, false);
      // Boolean true/false labels over the single-bit lines — same label renderer,
      // its own instance buffer, fed the single segment buffer + single-label blob.
      const singleLabelBatch = labelRenderer.createBatch();
      singleLabelBatch.setLabels(NATIVE.single, NATIVE.singleCount, NATIVE.singleLabelBytes, NATIVE.singleLabelOffsets, scene.rowInfo, false);
      // The active list the label buffer currently reflects — lets a pure-append
      // add (new rows at the end) upload only the new glyphs (setLabels reusePrefix).
      let lastLabelActive: ActiveSignalRef[] = useAppStore.getState().activeSignals;

      // Row dim/select state, derived from the store's active rows. Read by
      // applyRowFlags (hidden → dim, selected → highlight, both in RowInfo.flags).
      let hiddenRows = new Set<number>();
      let selectedRows = new Set<number>();
      // The open context menu's row, highlighted transiently while the menu is up
      // (a lone right-click shows the row as active without a persistent selection).
      let menuRow = -1;
      const syncRowState = (rows: ActiveSignalRef[]) => {
        const h = new Set<number>();
        const sel = new Set<number>();
        for (const r of rows) {
          if (r.hidden) h.add(r.row);
          if (r.selected) sel.add(r.row);
        }
        hiddenRows = h;
        selectedRows = sel;
      };
      syncRowState(useAppStore.getState().activeSignals);
      const applyDim = () => renderer.setRowFlags(scene, (row) => hiddenRows.has(row), (row) => selectedRows.has(row) || row === menuRow);
      applyDim();
      // Per-row vertical layout (resize): write each row's y/height into rowInfo.
      // Rows stack from the ruler band (ROW_HEIGHT_CSS); a row without an explicit
      // height falls back to the default. No repack — same fast path as applyDim.
      const rowHeightOf = (row: number) =>
        useAppStore.getState().activeSignals.find((r) => r.row === row)?.height ?? ROW_HEIGHT_CSS;
      // Extra gap below a row carrying a divider (matches the .s-divider DOM
      // height — the row's resized dividerHeight, else the default).
      const gapBelowOf = (row: number) => {
        const r = useAppStore.getState().activeSignals.find((x) => x.row === row);
        return r?.dividerBelow ? (r.dividerHeight ?? DIVIDER_HEIGHT_CSS) : 0;
      };
      const applyRowLayout = () => renderer.setRowLayout(scene, rowHeightOf, ROW_HEIGHT_CSS, gapBelowOf);
      applyRowLayout();

      // Repack GPU buffers + pill labels for a new active list (add/remove/radix)
      // over a tick window [qStart, qEnd] (the visible viewport plus over-fetch).
      const rebuildScene = (active: ActiveSignalRef[], qStart: number, qEnd: number, forceFullLabels = false) => {
        const packed = getMockSegments(packSpecsFor(active), qStart, qEnd);
        perf.addMark("native repack (getMockSegments)");
        const nextScene = renderer.createSceneBuffers(packed.rowInfo, packed.x0Pool, packed.x1Pool);
        const nextMulti = renderer.rebindPipeline(multiBit, packed.multi, packed.multiCount, colorBuf, nextScene);
        const nextSingle = renderer.rebindPipeline(singleBit, packed.single, packed.singleCount, colorBuf, nextScene);
        multiBit.segmentBuf.destroy();
        singleBit.segmentBuf.destroy();
        scene.rowInfo.destroy();
        scene.x0Pool.destroy();
        scene.x1Pool.destroy();
        scene = nextScene;
        multiBit = nextMulti;
        singleBit = nextSingle;
        perf.addMark("GPU buffer rebuild (scene + rebind)");
        // Pure append (add-from-tree): existing rows unchanged + new rows at the
        // end → label buffer prefix is identical, so only upload the new glyphs.
        // Any other change (reorder/remove/radix) → full label rebuild.
        const prev = lastLabelActive;
        // On a trace swap nodeIds restart from 0, so a prefix key-match can spuriously
        // succeed against the OLD trace's resident label buffer (different glyphs, same
        // ids) — the swap caller forces a full rebuild to avoid stale pill text.
        const isAppend = !forceFullLabels && active.length > prev.length &&
          prev.every((r, i) => {
            const n = active[i];
            return n != null && n.signalId === r.signalId && n.row === r.row && n.radix === r.radix && n.role === r.role;
          });
        labelBatch.setLabels(packed.multi, packed.multiCount, packed.labelBytes, packed.labelOffsets, scene.rowInfo, isAppend);
        // Single labels (boolean): full rebuild each repack — the append fast path
        // is keyed to the multi label set; single's blob is tiny so this is cheap.
        singleLabelBatch.setLabels(packed.single, packed.singleCount, packed.singleLabelBytes, packed.singleLabelOffsets, scene.rowInfo, false);
        lastLabelActive = active;
        perf.addMark("rebuild value labels");
        applyDim(); // fresh rowInfo starts with flags=0 — re-apply the dim set
        applyRowLayout(); // fresh rowInfo starts with y/height=0 — re-apply layout
      };

      const linesBg = lineRenderer.createBatch();
      const linesFg = lineRenderer.createBatch();
      const rectsBg = rectRenderer.createBatch();
      const textBody = textRenderer.createBatch();
      // All pills (≤ MAX_MARKERS markers + cursor) share one rect buffer + one
      // text buffer, filled in a single writeBuffer each per frame; pillRanges
      // record each pill's slice, drawn individually (firstInstance) to keep the
      // per-pill occlusion order. See frame.ts.
      const pillRects = rectRenderer.createBatch();
      const pillText = textRenderer.createBatch();
      const pillRanges: PillRange[] = [];

      // Pooled scratch — reused across frames, never shrunk.
      const rectsBgScratch: RectMut[] = [];
      const linesBgScratch: LineMut[] = [];
      const linesFgScratch: LineMut[] = [];
      // Accumulator for all pills' rects this frame (one rect per pill); written
      // to the shared pillRects buffer in a single setRects after all pills.
      const pillRectScratch: RectMut[] = [];
      const getRect = (arr: RectMut[], i: number): RectMut => {
        let r = arr[i];
        if (!r) { r = { x: 0, y: 0, w: 0, h: 0, color: 0 }; arr[i] = r; }
        r.crosshatch = undefined; r.rounded = undefined; r.caret = undefined;
        r.caretRight = undefined; r.squareBottomLeft = undefined; r.squareBottomRight = undefined;
        return r;
      };
      const getLine = (arr: LineMut[], i: number): LineMut => {
        let l = arr[i];
        if (!l) { l = { x: 0, color: 0 }; arr[i] = l; }
        l.dashed = undefined; l.fullHeight = undefined;
        return l;
      };

      const vp = {
        ticks_per_pixel: 0, start_ticks: 0, width: 0, height: 0,
        row_height: 0, dpr: 1, wave_y_offset: 0,
      };

      const writeText = (
        batch: typeof textBody, startGlyph: number, x: number, y: number,
        text: string, color: number, small = false,
      ): number => {
        const cell = small ? textRenderer.cellSm : textRenderer.cellLg;
        let gi = startGlyph;
        for (let k = 0; k < text.length && gi < MAX_GLYPHS; k++) {
          const code = text.charCodeAt(k);
          if ((code < 0x20 || code > 0x7e) && code !== ATLAS_MIDDLE_DOT) continue;
          batch.writeGlyph(gi++, x + k * cell.widthPx, y, code, color, small);
        }
        return gi;
      };

      // Per-frame marker hit boxes (CSS px), populated below, read by markerAt.
      let markerHits: { id: number; x0: number; x1: number; lineX: number }[] = [];

      const ro = new ResizeObserver(() => { resizeCanvas(canvasEl); requestRender(); });
      ro.observe(canvasEl);
      resizeCanvas(canvasEl);
      // DPR-only changes (dragging between displays) don't fire ResizeObserver;
      // watch via matchMedia and re-arm each fire.
      let dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const onDprChange = () => {
        resizeCanvas(canvasEl);
        requestRender();
        dprMql.removeEventListener("change", onDprChange);
        dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        dprMql.addEventListener("change", onDprChange);
      };
      dprMql.addEventListener("change", onDprChange);

      let viewReported = { start: -1, end: -1 };
      // Viewport-windowed packing state. `packedRange` is the tick window the GPU
      // buffers currently hold (null forces a full repack — initial frame + swap);
      // `specsDirty` flags an active-set change so the next frame repacks at the
      // current window regardless of viewport movement.
      let packedRange: { start: number; end: number; tpp: number } | null = null;
      let specsDirty = false;
      perf.stamp("gpu:ready");

      const frame = (now: number) => {
        if (lost) return; // device gone — stop drawing (overlay shown); reload to recover
        // Optimized-render gate: skip the whole frame (no metering) unless there's
        // a reason to draw — a dirty flag (input/store/resize), an in-flight zoom
        // animation, a pending repack, or a queued canvas capture. The perf
        // "force render" toggle draws every frame for steady-state measurement.
        if (!perf.isForceRender() && !needsRender && view.zoomAnim == null && !specsDirty && !hasPendingCaptures()) {
          raf = requestAnimationFrame(frame);
          return;
        }
        needsRender = false;
        perf.frameStart(now);
        const cpuStart = performance.now();
        const st = useAppStore.getState();
        const dpr = window.devicePixelRatio || 1;
        const canvasW = canvasEl.clientWidth;
        const canvasH = canvasEl.clientHeight;
        const rowHeightCSS = ROW_HEIGHT_CSS;
        const rulerHeightCSS = rowHeightCSS;
        const waveHeightCSS = Math.max(0, canvasH - rulerHeightCSS);

        const timelinePx = canvasW;
        // Skip the frame when there's nothing to draw into. timelinePx<=0 covers a
        // collapsed CSS width; the canvas.width/height check covers the startup/
        // resize race where clientWidth just became >0 but the ResizeObserver hasn't
        // re-run resizeCanvas yet, so the backing store (and thus the swapchain
        // texture from getCurrentTexture) is still 0 — Dawn rejects a 0-size texture.
        if (timelinePx <= 0 || canvasEl.width === 0 || canvasEl.height === 0) {
          needsRender = true; // retry once the backing store is sized
          raf = requestAnimationFrame(frame);
          return;
        }

        // No trace loaded: keep the canvas idle — clear it (so no stale pixels),
        // but run no tick math (TRACE_END is 0 → divide-by-zero), no native
        // queries, no viewport seeding. The dirty-render gate then leaves it
        // alone until a trace swaps in (traceNonce → requestRender). All draw
        // batches are still empty (fresh) so the pass just clears to background.
        if (!hasTrace()) {
          vp.ticks_per_pixel = 1; vp.start_ticks = 0;
          vp.width = canvasW; vp.height = canvasH; vp.row_height = rowHeightCSS;
          vp.dpr = dpr; vp.wave_y_offset = rulerHeightCSS;
          const encStart = performance.now();
          renderFrame(gpuCtx, renderer, [multiBit, singleBit], { linesBg, rectsBg, labels: labelBatch, labelsSingle: singleLabelBatch, linesFg, textBody, pillRects, pillText, pillRanges, pillRangeCount: 0 }, vp, gpuTimer);
          drainCaptures(canvasEl);
          const done = performance.now();
          perf.frameEnd(done - encStart, done - cpuStart);
          perf.markFirstFrame();
          raf = requestAnimationFrame(frame);
          return;
        }

        view.setWidth(timelinePx);
        view.ensureInit();
        if (view.advance(now)) st.bumpViewSave(); // zoom/fit animation landed

        const ticksPerPixel = view.ticksPerPixel;
        const startTicks = view.startTicks;
        const visibleTicks = timelinePx * ticksPerPixel;
        const viewEnd = startTicks + visibleTicks;
        if (Math.abs(viewReported.start - startTicks) > 1e-6 || Math.abs(viewReported.end - viewEnd) > 1e-6) {
          viewReported = { start: startTicks, end: viewEnd };
          st.setViewRange(startTicks, viewEnd);
        }

        // Viewport-windowed repack (the single packer). Pack the active signals
        // over the visible window plus an over-fetch margin, but only when the
        // active set changed (specsDirty) OR the visible range entered the
        // hysteresis guard band at either packed edge OR the user zoomed out far
        // enough that the packed window is too narrow in ticks. Pan and zoom-IN
        // within the margin stay pure uniform updates — the shader transforms the
        // already-packed segments — so they're cheap at any zoom. The margin also
        // keeps the visible right edge interior to the packed window, so its
        // t_end / clock-caret / single-bit edge render identically to a full pack.
        {
          const M = visibleTicks; // over-fetch one screen of ticks each side
          const G = M * 0.5; // guard band: repack at halfway into the margin
          const pr = packedRange;
          // Edge clauses are gated on there being room beyond the trace bounds —
          // at the trace start/end the packed window is clamped to 0 / TRACE_END,
          // so the visible edge sitting on it must NOT keep retriggering.
          const needRepack =
            specsDirty ||
            pr == null ||
            (pr.start > 0 && startTicks < pr.start + G) ||
            (pr.end < TRACE_END && viewEnd > pr.end - G) ||
            ticksPerPixel > pr.tpp * ZOOM_OUT_FACTOR ||
            pr.end - pr.start > visibleTicks * WINDOW_SHRINK_FACTOR;
          if (needRepack) {
            const qStart = Math.max(0, Math.floor(startTicks - M));
            const qEnd = Math.min(TRACE_END, Math.ceil(viewEnd + M));
            // Skip the GPU work when the clamped window is unchanged (e.g. zooming
            // further out while already covering the whole trace); still refresh
            // packedRange.tpp so the zoom-out clause doesn't fire every frame. A
            // specs-dirty repack never skips — the active set changed.
            if (specsDirty || pr == null || qStart !== pr.start || qEnd !== pr.end) {
              rebuildScene(useAppStore.getState().activeSignals, qStart, qEnd);
            }
            packedRange = { start: qStart, end: qEnd, tpp: ticksPerPixel };
            if (specsDirty) {
              specsDirty = false;
              perf.markAddRebuilt(useAppStore.getState().activeSignals.length);
            }
          }
        }

        const cursor = st.cursorTicks;
        // Clock-aligned mode is on only when a valid detected/overridden grid
        // exists; otherwise everything falls back to absolute time.
        const grid = st.clockGrid;
        const clockMode = st.clockAnchor && grid != null && grid.valid;
        const xForTick = (tick: number) => (tick - startTicks) / ticksPerPixel;
        vp.ticks_per_pixel = ticksPerPixel;
        vp.start_ticks = startTicks;
        vp.width = canvasW;
        vp.height = canvasH;
        vp.row_height = rowHeightCSS;
        vp.dpr = dpr;
        vp.wave_y_offset = rulerHeightCSS;

        const dataEndPx = xForTick(TRACE_END);
        const deadStartPx = Math.min(timelinePx, dataEndPx);
        const notchY = rulerHeightCSS - NOTCH_HEIGHT;
        const bottomRulerH = BOTTOM_RULER_HEIGHT;
        const bottomRulerTop = canvasH - bottomRulerH;
        const { ticks: rulerTicks, labels: rulerLabels } = clockMode
          ? clockRulerTicks(startTicks, visibleTicks, grid!)
          : dynamicRulerTicks(startTicks, visibleTicks);
        const rulerArrowLabels: { x: number; y: number; text: string; color: number }[] = [];
        let bgRectN = 0;
        {
          const r0 = getRect(rectsBgScratch, bgRectN++);
          r0.x = 0; r0.y = 0; r0.w = canvasW; r0.h = rulerHeightCSS; r0.color = P.PANEL_2;
          const r1 = getRect(rectsBgScratch, bgRectN++);
          r1.x = 0; r1.y = rulerHeightCSS - 1; r1.w = canvasW; r1.h = 1; r1.color = P.BORDER;
          for (const t of rulerTicks) {
            const r = getRect(rectsBgScratch, bgRectN++);
            r.x = xForTick(t); r.y = notchY; r.w = LINE_THICKNESS_CSS; r.h = NOTCH_HEIGHT; r.color = P.NOTCH_COLOR;
          }
          const rd = getRect(rectsBgScratch, bgRectN++);
          rd.x = deadStartPx; rd.y = rulerHeightCSS;
          rd.w = canvasW - deadStartPx; rd.h = waveHeightCSS;
          rd.color = P.DEAD_ZONE_GRAY; rd.crosshatch = true;
          const br0 = getRect(rectsBgScratch, bgRectN++);
          br0.x = 0; br0.y = bottomRulerTop; br0.w = canvasW; br0.h = bottomRulerH; br0.color = P.PANEL_2;
          const br1 = getRect(rectsBgScratch, bgRectN++);
          br1.x = 0; br1.y = bottomRulerTop; br1.w = canvasW; br1.h = 1; br1.color = P.BORDER;
          for (const t of rulerTicks) {
            const r = getRect(rectsBgScratch, bgRectN++);
            r.x = xForTick(t); r.y = canvasH - NOTCH_HEIGHT; r.w = LINE_THICKNESS_CSS; r.h = NOTCH_HEIGHT; r.color = P.NOTCH_COLOR;
          }
          const arrowY = bottomRulerTop + (bottomRulerH - NOTCH_HEIGHT) * 0.5;
          const drawSpanArrow = (leftX: number, rightX: number, label: string, color: number, leftName: string, rightName: string) => {
            const headW = 12, headH = 10, shaftH = 2, gap = 6;
            const cellSm = textRenderer.cellSm;
            const textW = label.length * cellSm.widthPx;
            const labelPad = 5;
            const labelY = Math.round(arrowY - cellSm.midlinePx);
            // When an endpoint is scrolled off-screen, name what the arrow points
            // to (the marker name or "cursor") tucked against the edge it exits,
            // so the off-screen target is still identifiable.
            const pushEndName = (name: string, side: "left" | "right") => {
              const w = name.length * cellSm.widthPx;
              const x = side === "left" ? labelPad : canvasW - w - labelPad;
              rulerArrowLabels.push({ x: Math.round(x), y: labelY, text: name, color });
            };
            const drawShaft = (x0: number, x1: number) => {
              if (x1 <= x0) return;
              const sh = getRect(rectsBgScratch, bgRectN++);
              sh.x = x0; sh.y = arrowY - shaftH * 0.5; sh.w = x1 - x0; sh.h = shaftH; sh.color = color;
            };
            const drawHead = (centerX: number, pointsRight: boolean) => {
              const h = getRect(rectsBgScratch, bgRectN++);
              h.x = centerX - headW * 0.5; h.y = arrowY - headH * 0.5;
              h.w = headW; h.h = headH; h.color = color; h.caret = true; h.caretRight = pointsRight;
            };
            const pushLabel = (x: number) => {
              rulerArrowLabels.push({ x: Math.round(x), y: labelY, text: label, color });
            };
            const pushSideLabel = (xR: number, xL: number) => {
              const right = xR + labelPad;
              pushLabel(right + textW <= canvasW - 2 ? right : xL - labelPad - textW);
            };
            const leftApex = leftX + gap;
            const rightApex = rightX - gap;
            const insideRoom = rightApex - leftApex;
            const span = rightX - leftX;
            // Three layouts by gap width:
            //  1. label inside the arrow (split shaft) — widest spans,
            //  2. arrow inside, label to the side (full shaft) — medium spans,
            //  3. chevrons outside pointing in, label to the side — narrowest.
            // 1↔2 is governed by the on-screen gap from the mock sidecar's manually
            // placed cursor/marker (Δ≈7.143 ticks over the 0–90 view on a 1076px
            // canvas ≈ 85 CSS px) plus a geometric check so a long label never spills.
            // 2↔3 stays a much smaller threshold: just enough that the chevrons + a
            // sliver of shaft still fit between the apexes.
            const INSIDE_LABEL_MIN_SPAN_PX = 85;
            const minShaftClear = 2;
            if (insideRoom - headW >= minShaftClear) {
              // Center on the *visible* portion of the shaft, not its true span:
              // when the arrow runs off the left/right edge the label stays
              // centered in the on-screen sliver (clamped to [0, canvasW]) rather
              // than drifting off with the geometric midpoint — same trick the
              // pill labels use in labels.wgsl.
              const midX = (Math.max(leftApex, 0) + Math.min(rightApex, canvasW)) * 0.5;
              const splitL = midX - textW * 0.5 - labelPad;
              const splitR = midX + textW * 0.5 + labelPad;
              const labelFits = span >= INSIDE_LABEL_MIN_SPAN_PX && splitL > leftApex + 2 && splitR < rightApex - 2;
              if (labelFits) {
                drawShaft(leftApex, splitL);
                drawShaft(splitR, rightApex);
                pushLabel(midX - textW * 0.5);
              } else {
                drawShaft(leftApex, rightApex);
                pushSideLabel(rightApex + headW * 0.5, leftApex - headW * 0.5);
              }
              drawHead(leftApex, false);
              drawHead(rightApex, true);
            } else {
              drawHead(leftX - gap, true);
              drawHead(rightX + gap, false);
              pushSideLabel(rightX + gap + headW * 0.5, leftX - gap - headW * 0.5);
            }
            if (leftX < 0) pushEndName(leftName, "left");
            if (rightX > canvasW) pushEndName(rightName, "right");
          };

          // Reset bands — rebuilt every frame from every active signal in reset
          // format. Each signal contributes a band over each visible interval it
          // is held HIGH, in its own color. To stay glitch-free when resets
          // overlap, all spans are merged on a boundary sweep into DISJOINT
          // sub-intervals: each screen column draws exactly one crosshatch rect
          // (no translucent stacking, no moiré). A sub-interval covered by one
          // signal takes its color; where several overlap, their colors average.
          // RESET labels are coalesced to one per contiguous covered run, so a
          // pile-up of overlapping resets shows a single label, not a stack.
          {
            const winStart = Math.max(0, Math.floor(startTicks));
            const winEnd = Math.min(TRACE_END, Math.ceil(viewEnd));
            type ResetEv = { t: number; d: number; color: number };
            const events: ResetEv[] = [];
            for (const r of st.activeSignals) {
              if (r.role !== "reset") continue;
              const h = handleForPath(r.path);
              if (h == null) continue;
              const col = hexToPacked(r.color);
              for (const s of resetHighSpans(h, winStart, winEnd)) {
                if (s.tEnd <= s.tStart) continue;
                events.push({ t: s.tStart, d: 1, color: col });
                events.push({ t: s.tEnd, d: -1, color: col });
              }
            }
            if (events.length) {
              // Process starts before ends at the same tick so abutting spans of
              // the same signal merge into one cluster rather than blinking off.
              events.sort((a, b) => a.t - b.t || b.d - a.d);
              const activeCols: number[] = []; // colors currently held high (multiset)
              const clusters: { x0: number; x1: number }[] = [];
              let runStart = -1, runEnd = -1; // contiguous covered run, in ticks
              const flushRun = () => {
                if (runStart >= 0) { clusters.push({ x0: xForTick(runStart), x1: xForTick(runEnd) }); runStart = -1; }
              };
              let prevT = events[0].t;
              let i = 0;
              while (i < events.length) {
                const t = events[i].t;
                if (activeCols.length && t > prevT) {
                  const x0 = xForTick(prevT), x1 = xForTick(t);
                  const rc = getRect(rectsBgScratch, bgRectN++);
                  rc.x = x0; rc.y = bottomRulerTop; rc.w = x1 - x0; rc.h = bottomRulerH;
                  rc.color = resetBandColor(activeCols); rc.crosshatch = true;
                  if (runStart < 0) runStart = prevT;
                  else if (prevT !== runEnd) { flushRun(); runStart = prevT; }
                  runEnd = t;
                }
                while (i < events.length && events[i].t === t) {
                  const ev = events[i++];
                  if (ev.d === 1) activeCols.push(ev.color);
                  else { const idx = activeCols.indexOf(ev.color); if (idx >= 0) activeCols.splice(idx, 1); }
                }
                prevT = t;
              }
              flushRun();
              const cellSm = textRenderer.cellSm;
              const label = "RESET";
              const textW = label.length * cellSm.widthPx;
              const labelY = Math.round(arrowY - cellSm.midlinePx);
              for (const c of clusters) {
                if (c.x1 - c.x0 > textW + 4) {
                  rulerArrowLabels.push({
                    x: Math.round((c.x0 + c.x1) * 0.5 - textW * 0.5),
                    y: labelY, text: label, color: P.RESET_TEXT,
                  });
                }
              }
            }
          }

          const arrowMarker = st.markers.find((m) => m.id === st.selectedMarkerId);
          if (arrowMarker) {
            const mX = xForTick(arrowMarker.tick) + LINE_HALF_CSS;
            const cX = xForTick(cursor) + LINE_HALF_CSS;
            const spanLabel = clockMode
              ? `${clockEdgesBetween(arrowMarker.tick, cursor, grid!)} clks`
              : `${formatTime(Math.abs(cursor - arrowMarker.tick))} ns`;
            const markerLeft = mX <= cX;
            const leftName = markerLeft ? arrowMarker.name : "cursor";
            const rightName = markerLeft ? "cursor" : arrowMarker.name;
            drawSpanArrow(Math.min(mX, cX), Math.max(mX, cX), spanLabel, arrowMarker.color, leftName, rightName);
          }
        }
        rectsBg.setRects(rectsBgScratch, bgRectN);

        // Dashed grid, decimated like the ruler. In clock mode it lands on the
        // detected cycle edges (phase + k·period); in absolute mode it's a plain
        // time grid on "nice" ns spacing.
        const gridEdge0 = clockMode ? grid!.phase : 0;
        const gridStepTicks = clockMode
          ? Math.max(1, Math.round(rulerSpacing(visibleTicks / grid!.period))) * grid!.period
          : rulerSpacing(visibleTicks);
        const gridVisEnd = startTicks + visibleTicks;
        const gridEps = gridStepTicks * 1e-6;
        let bgLineN = 0;
        for (let gk = Math.max(0, Math.floor((startTicks - gridEdge0) / gridStepTicks)); ; gk++) {
          const t = gridEdge0 + gk * gridStepTicks;
          if (t > gridVisEnd + gridEps) break;
          const l = getLine(linesBgScratch, bgLineN++);
          l.x = xForTick(t); l.color = P.GRID_GRAY; l.dashed = true;
        }
        linesBg.setLines(linesBgScratch, bgLineN);

        const markers = st.markers;
        const selId = st.selectedMarkerId;
        let fgLineN = 0;
        // Hover guide first so markers (and the cursor) paint over it — the hover
        // line is a transient pointer aid, markers/cursor are the meaningful marks.
        const hov = st.hover;
        if (hov) {
          const lh = getLine(linesFgScratch, fgLineN++);
          lh.x = xForTick(hov.tick); lh.color = P.GRID_GRAY; lh.dashed = true; lh.fullHeight = true;
        }
        for (const m of markers) {
          if (fgLineN >= MAX_MARKERS) break;
          const l = getLine(linesFgScratch, fgLineN++);
          l.x = xForTick(m.tick); l.color = m.color; l.dashed = m.id !== selId;
        }
        const lcur = getLine(linesFgScratch, fgLineN++);
        lcur.x = xForTick(cursor); lcur.color = P.HOT;
        linesFg.setLines(linesFgScratch, fgLineN);

        let gi = 0;
        const rulerLabelY = Math.round(rulerHeightCSS * 0.5 + 2);
        const bottomLabelY = Math.round(bottomRulerTop + bottomRulerH * 0.5 + 2);
        for (let i = 0; i < rulerTicks.length; i++) {
          const lx = Math.round(xForTick(rulerTicks[i]) + 5);
          const label = rulerLabels[i];
          gi = writeText(textBody, gi, lx, rulerLabelY, label, P.TEXT_SECONDARY, true);
          gi = writeText(textBody, gi, lx, bottomLabelY, label, P.TEXT_SECONDARY, true);
        }
        for (const al of rulerArrowLabels) {
          gi = writeText(textBody, gi, al.x, al.y, al.text, al.color, true);
        }
        textBody.setGlyphs(gi);

        const cellSm = textRenderer.cellSm;
        const padX = 5;
        const pillH = 14;
        // Append one pill (rect + glyphs) into the shared accumulators and record
        // its slice as a PillRange; flushed once after all pills.
        let pillRectN = 0;
        let pillGlyphN = 0;
        let pillRangeN = 0;
        const addFlag = (x: number, text: string, color: number) => {
          const pillW = text.length * cellSm.widthPx + padX * 2;
          const flipStart = canvasW - pillW;
          const t = Math.max(0, Math.min(1, (x - flipStart) / pillW));
          const anchor = x + t * LINE_THICKNESS_CSS;
          const pillX = Math.max(0, Math.min(canvasW - pillW, anchor - t * pillW));
          const pillY = 0;
          const rectStart = pillRectN;
          const r = getRect(pillRectScratch, pillRectN++);
          const lineOnRight = t >= 0.5;
          r.x = pillX; r.y = pillY; r.w = pillW; r.h = pillH; r.color = color; r.rounded = true;
          r.squareBottomLeft = !lineOnRight;
          r.squareBottomRight = lineOnRight;
          const textStart = pillGlyphN;
          pillGlyphN = writeText(
            pillText, pillGlyphN, Math.round(pillX + padX),
            Math.round(pillY + pillH * 0.5 - cellSm.midlinePx), text, P.ON_ACCENT, true,
          );
          let range = pillRanges[pillRangeN];
          if (!range) { range = { rectStart: 0, rectCount: 0, textStart: 0, textCount: 0 }; pillRanges[pillRangeN] = range; }
          range.rectStart = rectStart; range.rectCount = 1;
          range.textStart = textStart; range.textCount = pillGlyphN - textStart;
          pillRangeN++;
          return { x0: pillX, x1: pillX + pillW };
        };
        markerHits = [];
        const ordered = selId == null ? markers : [...markers].sort((a, b) => Number(a.id === selId) - Number(b.id === selId));
        let mi = 0;
        for (const m of ordered) {
          if (mi >= MAX_MARKERS) break;
          const lineX = xForTick(m.tick);
          const mLabel = clockMode ? formatClockWhole(m.tick, grid!) : `${formatTime(m.tick)} ns`;
          const box = addFlag(lineX, `${m.name} · ${mLabel}`, m.color);
          markerHits.push({ id: m.id, x0: box.x0, x1: box.x1, lineX: lineX + LINE_HALF_CSS });
          mi++;
        }
        const cursorLabel = clockMode ? formatClockWhole(cursor, grid!) : `${formatTime(cursor)} ns`;
        addFlag(xForTick(cursor), cursorLabel, P.HOT);
        pillRects.setRects(pillRectScratch, pillRectN);
        pillText.setGlyphs(pillGlyphN);

        const encodeStart = performance.now();
        renderFrame(gpuCtx, renderer, [multiBit, singleBit], { linesBg, rectsBg, labels: labelBatch, labelsSingle: singleLabelBatch, linesFg, textBody, pillRects, pillText, pillRanges, pillRangeCount: pillRangeN }, vp, gpuTimer);
        drainCaptures(canvasEl); // snapshot requests, while the front buffer holds this frame
        const frameDone = performance.now();
        perf.frameEnd(frameDone - encodeStart, frameDone - cpuStart);
        perf.markFirstFrame();
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      // ---- pointer / wheel / keyboard --------------------------------------
      // Magnetic snap: drag smoothly, but pull to a clock edge when the pointer is
      // within SNAP_RADIUS_CSS px of one. Distance is measured in pixels so the
      // vicinity is constant on screen regardless of zoom. No-op when snap is off
      // or there's no clock grid. Shared by cursor placement + the hover guide so
      // the guide visibly magnetizes to where a click will land.
      const magneticSnap = (tick: number): number => {
        const st = useAppStore.getState();
        if (!st.snapCursor || !st.clockGrid) return tick;
        const snapped = snapToClockEdge(tick, st.clockGrid);
        return Math.abs(snapped - tick) / view.ticksPerPixel <= SNAP_RADIUS_CSS ? snapped : tick;
      };
      const tickAtClientX = (clientX: number): number => {
        const rect = host.getBoundingClientRect();
        const px = Math.max(0, Math.min(rect.width, clientX - rect.left)) - LINE_HALF_CSS;
        return magneticSnap(view.startTicks + px * view.ticksPerPixel);
      };
      const setCursorAtClientX = (clientX: number) => useAppStore.getState().setCursor(tickAtClientX(clientX));
      const markerAt = (clientX: number, clientY: number): number | null => {
        const rect = host.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        for (const h of markerHits) {
          const inPill = py <= ROW_HEIGHT_CSS && px >= h.x0 && px <= h.x1;
          const onLine = Math.abs(px - h.lineX) <= MARKER_GRAB_PX;
          if (inPill || onLine) return h.id;
        }
        return null;
      };
      const updateHover = (clientX: number, clientY: number) => {
        const rect = host.getBoundingClientRect();
        const rulerH = ROW_HEIGHT_CSS;
        const py = clientY - rect.top;
        const px = Math.max(0, Math.min(rect.width, clientX - rect.left)) - LINE_HALF_CSS;
        const tick = magneticSnap(view.startTicks + px * view.ticksPerPixel);
        // Walk the per-row stacked heights (rows can be individually resized) to
        // find which row contains py. Live rows, not SCENE's stale initial set.
        const rows = useAppStore.getState().activeSignals;
        let row = -1;
        let y = rulerH;
        for (let i = 0; i < rows.length; i++) {
          const h = rows[i].height ?? ROW_HEIGHT_CSS;
          if (py >= y && py < y + h) { row = i; break; }
          // Skip the row's height plus any divider gap below it (no row there).
          y += h + (rows[i].dividerBelow ? (rows[i].dividerHeight ?? DIVIDER_HEIGHT_CSS) : 0);
        }
        useAppStore.getState().setHover({ tick, row });
      };

      let dragging = false;
      let draggingMarker: number | null = null;

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        view.beginInteract();
        const rect = host.getBoundingClientRect();
        view.setWidth(rect.width);
        if (e.ctrlKey) {
          const mouseX = e.clientX - rect.left;
          view.zoomAtPixel(mouseX, Math.exp(e.deltaY * ZOOM_PER_DELTA_Y));
        } else {
          const visibleTicks = view.timelinePx * view.ticksPerPixel;
          if (visibleTicks >= TRACE_END) return;
          const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
          view.panByPixels(dx);
        }
        useAppStore.getState().bumpViewSave();
      };
      const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        host.setPointerCapture(e.pointerId);
        const grabbed = markerAt(e.clientX, e.clientY);
        if (grabbed != null) {
          draggingMarker = grabbed;
          useAppStore.getState().selectMarker(grabbed);
          host.style.cursor = "col-resize";
        } else {
          dragging = true;
          setCursorAtClientX(e.clientX);
        }
      };
      const onPointerMove = (e: PointerEvent) => {
        updateHover(e.clientX, e.clientY);
        if (draggingMarker != null) {
          useAppStore.getState().moveMarker(draggingMarker, tickAtClientX(e.clientX));
          return;
        }
        if (dragging) {
          setCursorAtClientX(e.clientX);
          return;
        }
        host.style.cursor = markerAt(e.clientX, e.clientY) != null ? "col-resize" : "";
      };
      const onPointerUp = (e: PointerEvent) => {
        if (draggingMarker == null && !dragging) return;
        const wasMarker = draggingMarker != null;
        draggingMarker = null;
        dragging = false;
        host.releasePointerCapture(e.pointerId);
        if (wasMarker) host.style.cursor = markerAt(e.clientX, e.clientY) != null ? "col-resize" : "";
      };
      const onPointerLeave = () => useAppStore.getState().setHover(null);
      const onKey = (e: KeyboardEvent) => {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
        if (e.key === "m" || e.key === "M") {
          useAppStore.getState().addMarkerAtCursor();
        } else if (e.key === "Delete" || e.key === "Backspace") {
          const sel = useAppStore.getState().selectedMarkerId;
          if (sel != null) useAppStore.getState().deleteMarker(sel);
        } else if (e.key === "]") {
          useAppStore.getState().cycleMarker(1);
        } else if (e.key === "[") {
          useAppStore.getState().cycleMarker(-1);
        }
      };

      host.addEventListener("wheel", onWheel, { passive: false });
      host.addEventListener("pointerdown", onPointerDown);
      host.addEventListener("pointermove", onPointerMove);
      host.addEventListener("pointerup", onPointerUp);
      host.addEventListener("pointercancel", onPointerUp);
      host.addEventListener("pointerleave", onPointerLeave);
      window.addEventListener("keydown", onKey);

      // Any document-state change (cursor, markers, hover, viewport report, active
      // signals, panels, …) arms the dirty flag so the next rAF draws. Covers all
      // store-driven triggers in one place; resize/DPR (above) cover the rest.
      const unsubRender = useAppStore.subscribe(requestRender);
      // Toggling the perf "force render" checkbox draws immediately rather than
      // waiting for the next incidental change.
      const unsubForce = perf.onForceRenderChange(requestRender);

      // ---- store-driven GPU sync -------------------------------------------
      // A (cosmetic, runs on any active-set change): row colors + dim/select +
      // apply dim. Registered first so hiddenRows is fresh before B's repack
      // re-applies dim.
      const unsubCosmetic = useAppStore.subscribe(
        (s) => s.activeSignals,
        (rows) => { writeRowColors(device, colorBuf, rows); syncRowState(rows); applyDim(); applyRowLayout(); },
      );
      // Transient highlight for the open context menu's row (cleared when it closes).
      const unsubCtxRow = useAppStore.subscribe(
        (s) => s.ctxMenu?.row ?? -1,
        (row) => { menuRow = row; applyDim(); },
      );
      // B (structural): membership or format change → flag a repack. The key must
      // cover everything that changes the native pack: signal/row, radix (single vs
      // multi pipeline + label format), role (clk kind/shade, e.g. bin↔clock keeps
      // radix bin), clock polarity (which edges get a chevron), the enum table
      // (multi pill label content), and the mute signal (which enable mutes this
      // row, so its edges add segment boundaries). The frame loop is the single
      // packer, so it repacks at the live viewport window (markAddRebuilt fires
      // there once the new buffers present).
      const unsubStructural = useAppStore.subscribe(
        (s) => s.activeSignals.map((r) =>
          `${r.signalId}:${r.row}:${r.radix}:${r.role ?? ""}:${r.clock?.polarity ?? ""}:${r.enumTable?.map((e) => `${e.value}=${e.label}`).join(",") ?? ""}:${r.mute ?? ""}`,
        ).join("|"),
        () => {
          perf.addMark("solid render + commit + paint");
          specsDirty = true;
        },
      );
      // C (trace swap): reset the viewport and repack the new trace synchronously
      // (full range, so the swap perf marks measure the real GPU cost instead of
      // it bleeding into the next frame's add path). The frame loop then re-windows
      // to the viewport: tpp 0 trips its zoom-out clause on the next frame. B also
      // set specsDirty for this atomic set — clear it, this repack already covers
      // it. Registered last → runs after A/B on the swap's set.
      const unsubTrace = useAppStore.subscribe(
        (s) => s.traceNonce,
        () => {
          view.resetForTrace();
          const rows = useAppStore.getState().activeSignals;
          rebuildScene(rows, 0, TRACE_END, true);
          packedRange = { start: 0, end: TRACE_END, tpp: 0 };
          specsDirty = false;
          perf.swapMark("GPU repack");
          perf.markSwapRebuilt(rows.length);
        },
      );

      cleanups.push(
        () => ro.disconnect(),
        () => dprMql.removeEventListener("change", onDprChange),
        () => host.removeEventListener("wheel", onWheel),
        () => host.removeEventListener("pointerdown", onPointerDown),
        () => host.removeEventListener("pointermove", onPointerMove),
        () => host.removeEventListener("pointerup", onPointerUp),
        () => host.removeEventListener("pointercancel", onPointerUp),
        () => host.removeEventListener("pointerleave", onPointerLeave),
        () => window.removeEventListener("keydown", onKey),
        unsubCosmetic,
        unsubCtxRow,
        unsubStructural,
        unsubTrace,
        unsubRender,
        unsubForce,
        // Free all GPU resources on unmount (HMR / remount): device.destroy()
        // releases every child buffer/pipeline/texture at once; gpuTimer owns a
        // query set + readback buffer pool. Without this each remount leaks the
        // full GPU resource set + a device.lost handler. (destroy() resolves
        // device.lost with reason "destroyed", which the handler above ignores.)
        () => { gpuTimer.destroy(); device.destroy(); },
      );
    }).catch((e) => {
      // Surface init failure as a DOM overlay instead of a silent blank canvas —
      // the single most likely thing a tester on bad/absent GPU drivers hits.
      const msg = e instanceof GPUInitError ? e.message : `GPU initialization error: ${e?.message ?? e}`;
      console.error("GPU init failed:", msg);
      if (!disposed) setGpuError(msg);
    });

    onCleanup(() => {
      disposed = true;
      cancelAnimationFrame(raf);
      for (const c of cleanups) c();
    });
  });

  return (
    <div class="gpu-host" ref={host}>
      <canvas id="gpu" ref={canvasEl} />
      <Show when={gpuError()}>{(msg) => (
        <div
          style={{
            position: "absolute", inset: "0", display: "flex", "flex-direction": "column",
            "align-items": "center", "justify-content": "center", gap: "10px", padding: "24px",
            "text-align": "center", background: "var(--panel, #1b1d21)", cursor: "default",
            font: "13px 'IBM Plex Sans', system-ui, sans-serif", color: "var(--text-2, #c4c3bb)",
          }}
        >
          <div style={{ "font-weight": "600", "font-size": "14px", color: "var(--hot, #f06b5b)" }}>WebGPU unavailable</div>
          <div style={{ "max-width": "440px", "line-height": "1.5" }}>{msg()}</div>
          <div style={{ "font-size": "11px", color: "var(--muted, #989ea8)", "line-height": "1.5" }}>
            Check that GPU drivers / hardware acceleration are enabled, then reload the window.
          </div>
        </div>
      )}</Show>
    </div>
  );
}
