import { onMount, onCleanup } from "solid-js";
import { initGPU, resizeCanvas, GPUInitError } from "../gpu/device";
import { createDigitalRenderer } from "../gpu/digital";
import { renderFrame } from "../gpu/frame";
import { createColorBuffer, writeRowColors } from "../gpu/colors";
import { MOCK_CLOCK_TICK_NS } from "../gpu/data";
import { createTextRenderer, MAX_GLYPHS, ATLAS_MIDDLE_DOT } from "../gpu/text";
import { createLabelRenderer } from "../gpu/labels";
import { createLineRenderer } from "../gpu/lines";
import { createRectRenderer } from "../gpu/rect";
import { createGpuTimer } from "../gpu/timing";
import { RESET_HELD_TICKS, TRACE_END, buildPackSpecs, packSpecsFor, type ActiveSignalRef } from "../hier/scene";
import { getMockSegments } from "../native";
import * as perf from "../perf";
import { useAppStore } from "../store/store";
import { view } from "./viewport";
import { drainCaptures } from "./capture";
import {
  ROW_HEIGHT_CSS, LINE_THICKNESS_CSS, LINE_HALF_CSS, NOTCH_HEIGHT, BOTTOM_RULER_HEIGHT,
  MAX_MARKERS, MARKER_GRAB_PX, ZOOM_PER_DELTA_Y, ZOOM_OUT_FACTOR, WINDOW_SHRINK_FACTOR,
} from "./constants";
import * as P from "./palette";
import { dynamicRulerTicks, clockRulerTicks, rulerSpacing, formatTime, formatClockWhole, clockEdgesBetween, snapToClockEdge, CLOCK_PERIOD_NS } from "./format";

type RectMut = { x: number; y: number; w: number; h: number; color: number; crosshatch?: boolean; rounded?: boolean; caret?: boolean; caretRight?: boolean; squareBottomLeft?: boolean; squareBottomRight?: boolean };
type LineMut = { x: number; color: number; dashed?: boolean; fullHeight?: boolean };

// The waveform canvas. Owns the imperative WebGPU pipeline + the rAF render
// loop. Reads document state synchronously via useAppStore.getState() (cursor,
// markers, snap/clock, hover) and the viewport controller; writes back via store
// actions (cursor/marker drag, viewRange report, hover). It never subscribes
// reactively for rendering — the loop pulls fresh state each frame — so the
// component mounts once and the canvas never re-renders.
export function WaveCanvas() {
  let host!: HTMLDivElement;
  let canvasEl!: HTMLCanvasElement;

  onMount(() => {
    let raf = 0;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    perf.stamp("gpu:start");

    initGPU(canvasEl).then(async ({ device, ctx, format }) => {
      if (disposed) return;
      const gpuCtx = { device, ctx, format };
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
      // The active list the label buffer currently reflects — lets a pure-append
      // add (new rows at the end) upload only the new glyphs (setLabels reusePrefix).
      let lastLabelActive: ActiveSignalRef[] = useAppStore.getState().activeSignals;

      // Row dim/select state, derived from the store's active rows. Read by the
      // frame loop (selectedRow → vp.selected_row) and applyDim (hiddenRows).
      let hiddenRows = new Set<number>();
      let selectedRow = -1;
      const syncRowState = (rows: ActiveSignalRef[]) => {
        const h = new Set<number>();
        for (const r of rows) if (r.hidden) h.add(r.row);
        hiddenRows = h;
        selectedRow = rows.find((r) => r.selected)?.row ?? -1;
      };
      syncRowState(useAppStore.getState().activeSignals);
      const applyDim = () => renderer.setDimFlags(scene, (row) => hiddenRows.has(row));
      applyDim();
      // Per-row vertical layout (resize): write each row's y/height into rowInfo.
      // Rows stack from the ruler band (ROW_HEIGHT_CSS); a row without an explicit
      // height falls back to the default. No repack — same fast path as applyDim.
      const rowHeightOf = (row: number) =>
        useAppStore.getState().activeSignals.find((r) => r.row === row)?.height ?? ROW_HEIGHT_CSS;
      const applyRowLayout = () => renderer.setRowLayout(scene, rowHeightOf, ROW_HEIGHT_CSS);
      applyRowLayout();

      // Repack GPU buffers + pill labels for a new active list (add/remove/radix)
      // over a tick window [qStart, qEnd] (the visible viewport plus over-fetch).
      const rebuildScene = (active: ActiveSignalRef[], qStart: number, qEnd: number) => {
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
        const isAppend = active.length > prev.length &&
          prev.every((r, i) => {
            const n = active[i];
            return n != null && n.signalId === r.signalId && n.row === r.row && n.radix === r.radix && n.role === r.role;
          });
        labelBatch.setLabels(packed.multi, packed.multiCount, packed.labelBytes, packed.labelOffsets, scene.rowInfo, isAppend);
        lastLabelActive = active;
        perf.addMark("rebuild value labels");
        applyDim(); // fresh rowInfo starts with flags=0 — re-apply the dim set
        applyRowLayout(); // fresh rowInfo starts with y/height=0 — re-apply layout
      };

      const linesBg = lineRenderer.createBatch();
      const linesFg = lineRenderer.createBatch();
      const rectsBg = rectRenderer.createBatch();
      const textBody = textRenderer.createBatch();
      const markerPills = Array.from({ length: MAX_MARKERS }, () => ({
        rects: rectRenderer.createBatch(),
        text: textRenderer.createBatch(),
      }));
      const pillCursor = { rects: rectRenderer.createBatch(), text: textRenderer.createBatch() };
      const allPills = [...markerPills, pillCursor];

      // Pooled scratch — reused across frames, never shrunk.
      const rectsBgScratch: RectMut[] = [];
      const linesBgScratch: LineMut[] = [];
      const linesFgScratch: LineMut[] = [];
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
        row_height: 0, dpr: 1, selected_row: -1, wave_y_offset: 0,
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

      const ro = new ResizeObserver(() => { resizeCanvas(canvasEl); });
      ro.observe(canvasEl);
      resizeCanvas(canvasEl);
      // DPR-only changes (dragging between displays) don't fire ResizeObserver;
      // watch via matchMedia and re-arm each fire.
      let dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const onDprChange = () => {
        resizeCanvas(canvasEl);
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
        if (timelinePx <= 0) { raf = requestAnimationFrame(frame); return; }

        view.timelinePx = timelinePx;
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
        const clockAnchor = st.clockAnchor;
        const xForTick = (tick: number) => (tick - startTicks) / ticksPerPixel;
        vp.ticks_per_pixel = ticksPerPixel;
        vp.start_ticks = startTicks;
        vp.width = canvasW;
        vp.height = canvasH;
        vp.row_height = rowHeightCSS;
        vp.dpr = dpr;
        vp.selected_row = selectedRow;
        vp.wave_y_offset = rulerHeightCSS;

        const dataEndPx = xForTick(TRACE_END);
        const deadStartPx = Math.min(timelinePx, dataEndPx);
        const notchY = rulerHeightCSS - NOTCH_HEIGHT;
        const bottomRulerH = BOTTOM_RULER_HEIGHT;
        const bottomRulerTop = canvasH - bottomRulerH;
        const { ticks: rulerTicks, labels: rulerLabels } = clockAnchor
          ? clockRulerTicks(startTicks, visibleTicks)
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
          const drawSpanArrow = (leftX: number, rightX: number, label: string, color: number) => {
            const headW = 12, headH = 10, shaftH = 2, gap = 6;
            const cellSm = textRenderer.cellSm;
            const textW = label.length * cellSm.widthPx;
            const labelPad = 5;
            const labelY = Math.round(arrowY - cellSm.midlinePx);
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
            const minShaftClear = 2;
            if (insideRoom - headW >= minShaftClear) {
              const midX = (leftApex + rightApex) * 0.5;
              const splitL = midX - textW * 0.5 - labelPad;
              const splitR = midX + textW * 0.5 + labelPad;
              const labelFits = splitL > leftApex + 2 && splitR < rightApex - 2;
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
          };

          {
            const rx0 = xForTick(RESET_HELD_TICKS.tStart);
            const rx1 = xForTick(RESET_HELD_TICKS.tEnd);
            const rc = getRect(rectsBgScratch, bgRectN++);
            rc.x = rx0; rc.y = bottomRulerTop; rc.w = rx1 - rx0; rc.h = bottomRulerH;
            rc.color = P.RESET_RED; rc.crosshatch = true;
            const cellSm = textRenderer.cellSm;
            const label = "RESET";
            const textW = label.length * cellSm.widthPx;
            if (rx1 - rx0 > textW + 4) {
              rulerArrowLabels.push({
                x: Math.round((rx0 + rx1) * 0.5 - textW * 0.5),
                y: Math.round(arrowY - cellSm.midlinePx),
                text: label,
                color: P.RESET_TEXT,
              });
            }
          }

          const arrowMarker = st.markers.find((m) => m.id === st.selectedMarkerId);
          if (arrowMarker) {
            const mX = xForTick(arrowMarker.tick) + LINE_HALF_CSS;
            const cX = xForTick(cursor) + LINE_HALF_CSS;
            const spanLabel = clockAnchor
              ? `${clockEdgesBetween(arrowMarker.tick, cursor)} clks`
              : `${formatTime(Math.abs(cursor - arrowMarker.tick))} ns`;
            drawSpanArrow(Math.min(mX, cX), Math.max(mX, cX), spanLabel, arrowMarker.color);
          }
        }
        rectsBg.setRects(rectsBgScratch, bgRectN);

        // Dashed clock-edge grid, decimated like the ruler.
        const gridEdge0 = MOCK_CLOCK_TICK_NS;
        const gridStepTicks = Math.max(1, Math.round(rulerSpacing(visibleTicks / CLOCK_PERIOD_NS))) * CLOCK_PERIOD_NS;
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
        for (const m of markers) {
          if (fgLineN >= MAX_MARKERS) break;
          const l = getLine(linesFgScratch, fgLineN++);
          l.x = xForTick(m.tick); l.color = m.color; l.dashed = m.id !== selId;
        }
        const hov = st.hover;
        if (hov && fgLineN < MAX_MARKERS) {
          const lh = getLine(linesFgScratch, fgLineN++);
          lh.x = xForTick(hov.tick); lh.color = P.GRID_GRAY; lh.dashed = true; lh.fullHeight = true;
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
        const addFlag = (x: number, text: string, color: number, pill: { rects: typeof rectsBg; text: typeof textBody }) => {
          const pillW = text.length * cellSm.widthPx + padX * 2;
          const flipStart = canvasW - pillW;
          const t = Math.max(0, Math.min(1, (x - flipStart) / pillW));
          const anchor = x + t * LINE_THICKNESS_CSS;
          const pillX = Math.max(0, Math.min(canvasW - pillW, anchor - t * pillW));
          const pillY = 0;
          const r = getRect(pillRectScratch, 0);
          const lineOnRight = t >= 0.5;
          r.x = pillX; r.y = pillY; r.w = pillW; r.h = pillH; r.color = color; r.rounded = true;
          r.squareBottomLeft = !lineOnRight;
          r.squareBottomRight = lineOnRight;
          pill.rects.setRects(pillRectScratch, 1);
          const glyphs = writeText(
            pill.text, 0, Math.round(pillX + padX),
            Math.round(pillY + pillH * 0.5 - cellSm.midlinePx), text, P.ON_ACCENT, true,
          );
          pill.text.setGlyphs(glyphs);
          return { x0: pillX, x1: pillX + pillW };
        };
        markerHits = [];
        const ordered = selId == null ? markers : [...markers].sort((a, b) => Number(a.id === selId) - Number(b.id === selId));
        let mi = 0;
        for (const m of ordered) {
          if (mi >= markerPills.length) break;
          const lineX = xForTick(m.tick);
          const mLabel = clockAnchor ? formatClockWhole(m.tick) : `${formatTime(m.tick)} ns`;
          const box = addFlag(lineX, `${m.name} · ${mLabel}`, m.color, markerPills[mi]);
          markerHits.push({ id: m.id, x0: box.x0, x1: box.x1, lineX: lineX + LINE_HALF_CSS });
          mi++;
        }
        for (; mi < markerPills.length; mi++) {
          markerPills[mi].rects.setRects(pillRectScratch, 0);
          markerPills[mi].text.setGlyphs(0);
        }
        const cursorLabel = clockAnchor ? formatClockWhole(cursor) : `${formatTime(cursor)} ns`;
        addFlag(xForTick(cursor), cursorLabel, P.HOT, pillCursor);

        const encodeStart = performance.now();
        renderFrame(gpuCtx, renderer, [multiBit, singleBit], { linesBg, rectsBg, labels: labelBatch, linesFg, textBody, pills: allPills }, vp, gpuTimer);
        drainCaptures(canvasEl); // snapshot requests, while the front buffer holds this frame
        const frameDone = performance.now();
        perf.frameEnd(frameDone - encodeStart, frameDone - cpuStart);
        perf.markFirstFrame();
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      // ---- pointer / wheel / keyboard --------------------------------------
      const tickAtClientX = (clientX: number): number => {
        const rect = host.getBoundingClientRect();
        const px = Math.max(0, Math.min(rect.width, clientX - rect.left)) - LINE_HALF_CSS;
        let tick = view.startTicks + px * view.ticksPerPixel;
        if (useAppStore.getState().snapCursor) tick = snapToClockEdge(tick);
        return tick;
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
        const tick = view.startTicks + px * view.ticksPerPixel;
        // Walk the per-row stacked heights (rows can be individually resized) to
        // find which row contains py. Live rows, not SCENE's stale initial set.
        const rows = useAppStore.getState().activeSignals;
        let row = -1;
        let y = rulerH;
        for (let i = 0; i < rows.length; i++) {
          const h = rows[i].height ?? ROW_HEIGHT_CSS;
          if (py >= y && py < y + h) { row = i; break; }
          y += h;
        }
        useAppStore.getState().setHover({ tick, row });
      };

      let dragging = false;
      let draggingMarker: number | null = null;

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        view.beginInteract();
        const rect = host.getBoundingClientRect();
        view.timelinePx = rect.width;
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

      // ---- store-driven GPU sync -------------------------------------------
      // A (cosmetic, runs on any active-set change): row colors + dim/select +
      // apply dim. Registered first so hiddenRows is fresh before B's repack
      // re-applies dim.
      const unsubCosmetic = useAppStore.subscribe(
        (s) => s.activeSignals,
        (rows) => { writeRowColors(device, colorBuf, rows); syncRowState(rows); applyDim(); applyRowLayout(); },
      );
      // B (structural): membership or format change → flag a repack. The key must
      // cover everything that changes the native pack: signal/row, radix (single vs
      // multi pipeline + label format), role (clk kind/shade, e.g. bin↔clock keeps
      // radix bin), and the enum table (multi pill label content). The frame loop is
      // the single packer, so it repacks at the live viewport window (markAddRebuilt
      // fires there once the new buffers present).
      const unsubStructural = useAppStore.subscribe(
        (s) => s.activeSignals.map((r) =>
          `${r.signalId}:${r.row}:${r.radix}:${r.role ?? ""}:${r.enumTable?.map((e) => `${e.value}=${e.label}`).join(",") ?? ""}`,
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
          rebuildScene(rows, 0, TRACE_END);
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
        unsubStructural,
        unsubTrace,
      );
    }).catch((e) => {
      if (e instanceof GPUInitError) console.error("GPU init failed:", e.message);
      else throw e;
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
    </div>
  );
}
