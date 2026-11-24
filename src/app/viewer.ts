// PDF rendering with pdf.js: document lifecycle, page canvas, zoom/pan, and
// the SVG overlay that carries all markups. The overlay viewBox is the page
// viewport at scale 1, so markup geometry in PDF-point space never changes
// with zoom — only the canvas re-rasterises.

import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { state, emit } from './state';
import { awaitPdfRenderTask, cancelAndSettleRenderTask, loadValidatedPdfCandidate, openPdfTask } from './pdf-candidate';
import { vectorize, type VecPage } from '../engine/vector';
import { parseImagePages, parseScales, PAPER_KEY, SCALE_KEY } from '../engine/inputs';
import { METERS_PER_PT } from '../engine/units';
import { layersToHideForFill, isWallLayer, type LayerRole } from '../engine/cad-layers';

/**
 * Where pdf.js finds its WebAssembly decoders (CCITT fax, JBIG2, JPEG 2000:
 * without them a scanned PDF's images come out blank) and the standard-14
 * fonts; both ship with the site under /pdfjs/ (vite.config.ts).
 */
export const PDFJS_ASSET_URLS = {
  wasmUrl: new URL(`${import.meta.env.BASE_URL}pdfjs/wasm/`, location.href).href,
  standardFontDataUrl: new URL(`${import.meta.env.BASE_URL}pdfjs/standard_fonts/`, location.href).href,
};

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export type ViewPt = { x: number; y: number }; // viewport@1 space (top-left origin)

let doc: PDFDocumentProxy | null = null;
let viewport1: PageViewport | null = null;
let renderTask: RenderTask | null = null;
let renderSeq = 0;

let scrollEl: HTMLElement;
let pageEl: HTMLElement;
let canvas: HTMLCanvasElement;
let svg: SVGSVGElement;
export let markupsLayer: SVGGElement;
export let previewLayer: SVGGElement;

export let onFirstRender: (() => void) | null = null;

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const MAX_CANVAS_PIXELS = 2.5e7;

let zoomChangeHandler: ((zoom: number) => void) | null = null;

export function setZoomChangeHandler(handler: ((zoom: number) => void) | null): void {
  zoomChangeHandler = handler;
}

export function initViewer(
  scroll: HTMLElement,
  page: HTMLElement,
  cnv: HTMLCanvasElement,
  overlay: SVGSVGElement,
  ml: SVGGElement,
  pl: SVGGElement,
): void {
  scrollEl = scroll;
  // Keep the drawing workspace as the only scroll/zoom surface. Disable
  // browser scroll anchoring: resizing a centred page across the overflow
  // threshold must not let the browser independently rewrite scroll offsets.
  scrollEl.style.overscrollBehavior = 'none';
  scrollEl.style.overflowAnchor = 'none';
  scrollEl.style.touchAction = 'none';
  pageEl = page;
  canvas = cnv;
  svg = overlay;
  markupsLayer = ml;
  previewLayer = pl;
  window.addEventListener('keydown', (event) => {
    if (replacementInProgress) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('click', (event) => {
    if (replacementInProgress) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  bindWheel();
  bindPan();
}

export function hasDoc(): boolean {
  return doc !== null;
}

/** The loaded document, for engine modules (scan, export) that need their own renders. */
export function getPdfDoc(): PDFDocumentProxy | null {
  return doc;
}

export interface PdfLoadLifecycle {
  captureRollback?(): void;
  validatePageCount?(pageCount: number): void;
  initialize?(): void | Promise<void>;
  prepareOverlay?(): void | Promise<void>;
  beforeCommit?(): void | Promise<void>;
  rollback?(): void | Promise<void>;
  finalize?(): void | Promise<void>;
  onCleanupError?(errors: unknown[]): void;
}
export interface PdfLoadOptions { pageNum?: number; lifecycle?: PdfLoadLifecycle; }
let replacementInProgress = false;
let workspaceWasInert = false;
export function isPdfReplacementInProgress(): boolean { return replacementInProgress; }
function lockWorkspace(): void {
  workspaceWasInert = scrollEl.inert;
  scrollEl.inert = true;
  scrollEl.setAttribute('aria-busy', 'true');
  scrollEl.classList.add('pdf-replacing');
}
function unlockWorkspace(): void {
  scrollEl.inert = workspaceWasInert;
  scrollEl.removeAttribute('aria-busy');
  scrollEl.classList.remove('pdf-replacing');
}
async function cancelActiveRender(): Promise<unknown[]> {
  const active = renderTask;
  renderTask = null;
  return (await cancelAndSettleRenderTask(active)).errors;
}
export async function loadPdf(bytes: Uint8Array, name: string, options: PdfLoadOptions = {}): Promise<void> {
  if (replacementInProgress) throw new Error('A PDF replacement is already in progress.');
  replacementInProgress = true;
  const lifecycle = options.lifecycle ?? {};
  const requestedPage = options.pageNum ?? 1;
  try {
    const result = await loadValidatedPdfCandidate(
      async () => openPdfTask(pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_ASSET_URLS })),
      async (candidate) => {
        if (!Number.isInteger(candidate.numPages) || candidate.numPages < 1) throw new Error('The PDF contains no pages.');
        if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > candidate.numPages) throw new Error('Requested page is outside the PDF page range.');
        lifecycle.validatePageCount?.(candidate.numPages);
        const metadata = await candidate.getMetadata().catch(() => null);
        const custom = (metadata?.info as { Custom?: Record<string, unknown> } | undefined)?.Custom;
        const imagePages = parseImagePages(custom?.[PAPER_KEY]);
        const calibrations = [...parseScales(custom?.[SCALE_KEY]).entries()].map(([page, scale]) => [page, {
          metersPerPt: METERS_PER_PT * scale.ratio,
          source: 'drawing units (' + scale.unit + (scale.assumed ? ', assumed' : '') + ') at 1:' + scale.ratio,
        }] as const);
        const page = await candidate.getPage(requestedPage);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(0.12, 96 / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const preview = document.createElement('canvas');
        preview.width = Math.max(1, Math.ceil(viewport.width));
        preview.height = Math.max(1, Math.ceil(viewport.height));
        const context = preview.getContext('2d');
        if (!context) throw new Error('Could not create the PDF validation canvas.');
        await awaitPdfRenderTask(page.render({ canvas: preview, canvasContext: context, viewport }), () => { preview.width = 0; preview.height = 0; });
        return { pageCount: candidate.numPages, imagePages, calibrations };
      },
      (candidate, prepared) => {
        const previousDoc = doc;
        const previousViewport = viewport1;
        const previousState = structuredClone(state);
        const previousScroll = { left: scrollEl.scrollLeft, top: scrollEl.scrollTop };
        const previousPageStyle = { width: pageEl.style.width, height: pageEl.style.height };
        const previousCanvasStyle = { width: canvas.style.width, height: canvas.style.height };
        const previousCanvas = document.createElement('canvas');
        previousCanvas.width = canvas.width; previousCanvas.height = canvas.height;
        if (canvas.width && canvas.height) {
          const copyContext = previousCanvas.getContext('2d');
          if (!copyContext) throw new Error('Could not preserve the current PDF canvas.');
          copyContext.drawImage(canvas, 0, 0);
        }
        const previousSvg = { viewBox: svg.getAttribute('viewBox'), width: svg.getAttribute('width'), height: svg.getAttribute('height') };
        const previousFirstRender = onFirstRender;
        lifecycle.captureRollback?.();
        lockWorkspace();
        doc = candidate; viewport1 = null;
        state.fileName = name; state.fileBytes = bytes.slice(); state.pageCount = prepared.pageCount; state.pageNum = requestedPage;
        state.markups = []; state.selectedId = null; state.calibrations = new Map(prepared.calibrations);
        state.imagePages = new Map(prepared.imagePages); state.scaleChecks = new Map(); state.focusLabel = null;
        state.lastAction = null; state.zoom = 1; state.fit = 'width';
        return {
          rollback: async () => {
            const errors: unknown[] = await cancelActiveRender();
            renderSeq++; doc = previousDoc; viewport1 = previousViewport; onFirstRender = previousFirstRender;
            try {
              Object.assign(state, previousState);
              pageEl.style.width = previousPageStyle.width; pageEl.style.height = previousPageStyle.height;
              canvas.style.width = previousCanvasStyle.width; canvas.style.height = previousCanvasStyle.height;
              canvas.width = previousCanvas.width; canvas.height = previousCanvas.height;
              if (canvas.width && canvas.height) {
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Could not restore the previous PDF canvas context.');
                context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(previousCanvas, 0, 0);
              }
              if (previousSvg.viewBox === null) svg.removeAttribute('viewBox'); else svg.setAttribute('viewBox', previousSvg.viewBox);
              if (previousSvg.width === null) svg.removeAttribute('width'); else svg.setAttribute('width', previousSvg.width);
              if (previousSvg.height === null) svg.removeAttribute('height'); else svg.setAttribute('height', previousSvg.height);
              scrollEl.scrollLeft = previousScroll.left; scrollEl.scrollTop = previousScroll.top;
            } catch (error) { errors.push(error); }
            try { await lifecycle.rollback?.(); } catch (error) { errors.push(error); }
            const candidateDetached = doc !== candidate;
            unlockWorkspace(); emit();
            return { candidateDetached, rollbackComplete: errors.length === 0, errors };
          },
          finalize: async () => {
            const errors: unknown[] = [];
            try { await lifecycle.finalize?.(); } catch (error) { errors.push(error); }
            if (previousDoc) { try { await previousDoc.destroy(); } catch (error) { errors.push(error); } }
            unlockWorkspace(); emit();
            if (errors.length) throw new AggregateError(errors, 'PDF replacement committed, but cleanup reported errors.');
          },
        };
      },
      async () => {
        await lifecycle.initialize?.();
        await lifecycle.prepareOverlay?.();
        await renderPage({ strict: true });
        await lifecycle.beforeCommit?.();
      },
      async (candidate) => { await candidate.destroy(); },
    );
    if (result.cleanupErrors.length) {
      if (lifecycle.onCleanupError) lifecycle.onCleanupError(result.cleanupErrors);
      else console.error('PDF replacement cleanup errors:', result.cleanupErrors);
    }
  } finally {
    replacementInProgress = false;
    if (scrollEl.classList.contains('pdf-replacing')) unlockWorkspace();
  }
}
export async function closePdf(): Promise<void> {
  if (replacementInProgress) throw new Error('Cannot close a PDF while replacement is in progress.');
  const errors = await cancelActiveRender();
  const previous = doc; doc = null; viewport1 = null;
  if (previous) { try { await previous.destroy(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'PDF close completed with cleanup errors.');
}
// per-page caches for the open document (geometry and text never change
// while it is open); keyed by the document so a new load starts fresh
type TextItems = { str?: string; transform?: number[]; width?: number; height?: number }[];
const vectorCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<VecPage>>>();
const textCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<TextItems>>>();
const cleanVectorCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<VecPage>>>();

/** pdf.js's layer (optional-content) configuration. */
export type LayerConfig = Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>;
const fillLayerCache = new WeakMap<PDFDocumentProxy, Promise<{ config: LayerConfig; hidden: { name: string; role: LayerRole }[] } | null>>();

/**
 * The document's layers with Magic Fill's clutter hidden (furniture, finish
 * hatching, annotation, services, structure above; see cad-layers.ts). Null
 * when the document has no such layers. What the person sees is unchanged:
 * only the fill renders with this.
 */
export function getFillLayers(): Promise<{ config: LayerConfig; hidden: { name: string; role: LayerRole }[] } | null> {
  const d = doc;
  if (!d) return Promise.resolve(null);
  let p = fillLayerCache.get(d);
  if (!p) {
    p = d
      .getOptionalContentConfig()
      .then((config) => {
        const groups = [...(config as unknown as Iterable<[string, { name: string | null }]>)].map(([id, g]) => ({ id, name: g.name }));
        const hide = layersToHideForFill(groups);
        if (!hide.length) return null;
        for (const h of hide) config.setVisibility(h.id, false);
        return { config, hidden: hide.map(({ name, role }) => ({ name, role })) };
      })
      .catch(() => null);
    fillLayerCache.set(d, p);
  }
  return p;
}
function cached<T>(store: WeakMap<PDFDocumentProxy, Map<number, Promise<T>>>, d: PDFDocumentProxy, pageNum: number, make: () => Promise<T>): Promise<T> {
  let byPage = store.get(d);
  if (!byPage) store.set(d, (byPage = new Map()));
  let p = byPage.get(pageNum);
  if (!p) {
    p = make();
    p.catch(() => byPage!.delete(pageNum)); // don't cache failures
    byPage.set(pageNum, p);
  }
  return p;
}

const wallVectorCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<VecPage | null>>>();

/**
 * The page's geometry on its CAD wall layers only (null when the PDF has no
 * wall layers), for reading wall runs.
 */
export async function getWallVector(pageNum: number): Promise<VecPage | null> {
  const d = doc;
  if (!d) return null;
  return cached(wallVectorCache, d, pageNum, async () => {
    const config = await d.getOptionalContentConfig();
    const groups = [...(config as unknown as Iterable<[string, { name: string | null }]>)].map(([id, g]) => ({ id, name: g.name ?? '' }));
    const walls = new Set(groups.filter((g) => isWallLayer(g.name)).map((g) => g.id));
    if (!walls.size) return null;
    for (const g of groups) config.setVisibility(g.id, walls.has(g.id));
    const page = await d.getPage(pageNum);
    return vectorize(await page.getOperatorList(), pdfjsLib.OPS, { isVisible: (g) => config.isVisible(g as never) });
  });
}

/**
 * The page's vector geometry from its drawing operators (null before a
 * document loads). `clean`: as Magic Fill sees it, without the clutter layers.
 */
export async function getPageVector(pageNum: number, clean = false): Promise<VecPage | null> {
  const d = doc;
  if (!d) return null;
  return cached(clean ? cleanVectorCache : vectorCache, d, pageNum, async () => {
    const fill = clean ? await getFillLayers() : null;
    const [page, layers] = await Promise.all([d.getPage(pageNum), fill ? fill.config : d.getOptionalContentConfig()]);
    return vectorize(await page.getOperatorList(), pdfjsLib.OPS, { isVisible: (g) => layers.isVisible(g as never) });
  });
}

/** The page's text-layer items (empty for scans or before a document loads). */
export async function getPageTextItems(pageNum: number): Promise<TextItems> {
  const d = doc;
  if (!d) return [];
  return cached(textCache, d, pageNum, async () => (await (await d.getPage(pageNum)).getTextContent()).items as TextItems);
}

/** Load annotations written by pdf2takeoff (or any tool) back into the state. */
export async function getPageAnnotations(pageNum: number) {
  if (!doc) return [];
  const page = await doc.getPage(pageNum);
  return page.getAnnotations({ intent: 'display' });
}

export async function renderPage(options: { strict?: boolean } = {}): Promise<void> {
  const currentDoc = doc;
  if (!currentDoc) return;
  const mySeq = ++renderSeq;
  const cancelErrors = await cancelActiveRender();
  if (options.strict && cancelErrors.length) throw new AggregateError(cancelErrors, 'Previous PDF render did not settle cleanly.');
  if (mySeq !== renderSeq || doc !== currentDoc) return;
  const page = await currentDoc.getPage(state.pageNum);
  if (mySeq !== renderSeq || doc !== currentDoc) return;
  viewport1 = page.getViewport({ scale: 1 });
  svg.setAttribute('viewBox', '0 0 ' + viewport1.width + ' ' + viewport1.height);
  applyLayoutSize();
  await paintCanvas(page, mySeq, options.strict ?? false);
}
function fitWidthZoom(): number {
  if (!viewport1) return 1;
  const available = scrollEl.clientWidth - 64;
  return clampZoom(available / viewport1.width);
}

export function fitWidth(): void {
  if (!viewport1) return;
  state.zoom = fitWidthZoom();
  emit();
}

export function setZoom(z: number): void {
  state.zoom = clampZoom(z);
  emit();
}

export function zoomAt(clientX: number, clientY: number, factor: number): void {
  const z1 = state.zoom;
  const z2 = clampZoom(z1 * factor);
  if (z2 === z1) return;

  // Anchor against the actual page box, not the scrollport origin. The page
  // is centred with auto margins while it is narrower than the workspace, so
  // its left edge can move when zoom changes.
  const before = pageEl.getBoundingClientRect();
  const scrollRect = scrollEl.getBoundingClientRect();
  const localX = clientX - before.left;
  const localY = clientY - before.top;
  const pointerX = clientX - scrollRect.left;
  const pointerY = clientY - scrollRect.top;
  const pageX = localX / z1;
  const pageY = localY / z1;
  state.zoom = z2;
  previewResize();

  // Compute the required scroll offsets from the page-space anchor rather
  // than adding a delta to the previous offsets. This is stable when the
  // page changes from auto-centred to horizontally/vertically overflowing.
  const after = pageEl.getBoundingClientRect();
  const afterOriginX = after.left - scrollRect.left + scrollEl.scrollLeft;
  const afterOriginY = after.top - scrollRect.top + scrollEl.scrollTop;
  const desiredLeft = afterOriginX + pageX * z2 - pointerX;
  const desiredTop = afterOriginY + pageY * z2 - pointerY;
  scrollEl.scrollLeft = Math.max(0, desiredLeft);
  scrollEl.scrollTop = Math.max(0, desiredTop);
  // Wheel gestures can fire dozens of times per second. Avoid broadcasting a
  // full application state update (tables, layers, library and persistence)
  // for each tick; the host updates the zoom readout and debounces the raster.
  if (zoomChangeHandler) zoomChangeHandler(state.zoom);
  else emit();
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function applyLayoutSize(): void {
  if (!viewport1) return;
  const w = viewport1.width * state.zoom;
  const h = viewport1.height * state.zoom;
  pageEl.style.width = `${w}px`;
  pageEl.style.height = `${h}px`;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

/** Immediately stretch existing raster to the new zoom so interaction feels live,
 *  then the debounced render re-rasterises crisply. */
function previewResize(): void {
  applyLayoutSize();
}

async function paintCanvas(page: pdfjsLib.PDFPageProxy, mySeq: number, strict = false): Promise<void> {
  const viewport = page.getViewport({ scale: state.zoom });
  let dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (viewport.width * dpr * viewport.height * dpr > MAX_CANVAS_PIXELS) dpr = Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
  const nextCanvas = document.createElement('canvas');
  nextCanvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  nextCanvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  const context = nextCanvas.getContext('2d');
  if (!context) throw new Error('Could not create the PDF render canvas.');
  const task = page.render({ canvas: nextCanvas, canvasContext: context, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
  renderTask = task;
  try { await task.promise; }
  catch (error) {
    if (renderTask === task) renderTask = null;
    if (mySeq !== renderSeq) return;
    if (strict) throw error;
    return;
  }
  if (mySeq !== renderSeq || !doc) { if (renderTask === task) renderTask = null; return; }
  if (renderTask === task) renderTask = null;
  canvas.width = nextCanvas.width; canvas.height = nextCanvas.height;
  const visible = canvas.getContext('2d');
  if (!visible) throw new Error('Could not access the visible PDF canvas.');
  visible.drawImage(nextCanvas, 0, 0); applyLayoutSize();
  if (onFirstRender) { onFirstRender(); onFirstRender = null; }
}
export function viewSize(): { w: number; h: number } {
  return viewport1 ? { w: viewport1.width, h: viewport1.height } : { w: 0, h: 0 };
}

/** Event position → viewport@1 coordinates (the SVG viewBox space). */
export function eventToView(e: { clientX: number; clientY: number }): ViewPt | null {
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((e.clientX - rect.left) / rect.width) * (viewport1?.width ?? 0),
    y: ((e.clientY - rect.top) / rect.height) * (viewport1?.height ?? 0),
  };
}

export function viewToPdf(v: ViewPt) {
  if (!viewport1) return { x: 0, y: 0 };
  const [x, y] = viewport1.convertToPdfPoint(v.x, v.y);
  return { x, y };
}

export function pdfToView(p: { x: number; y: number }): ViewPt {
  if (!viewport1) return { x: 0, y: 0 };
  const [x, y] = viewport1.convertToViewportPoint(p.x, p.y);
  return { x, y };
}

// --- interaction: wheel zoom, drag pan ---

function bindWheel(): void {
  // Capture at window level so the browser never gets a chance to chain a
  // wheel gesture to the document when the sheet starts overflowing or a
  // canvas/SVG redraw changes the event target. Only intercept gestures that
  // originate inside this drawing workspace.
  window.addEventListener(
    'wheel',
    (e) => {
      if (replacementInProgress && e.target instanceof Node && scrollEl.contains(e.target)) {
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      if (!doc || !(e.target instanceof Node) || !scrollEl.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const delta =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? e.deltaY * 16
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? e.deltaY * Math.max(1, scrollEl.clientHeight)
            : e.deltaY;
      // Smooth exponential scaling works for both detented wheels and
      // high-resolution trackpads. At either zoom limit the event remains
      // consumed, rather than falling through to page scrolling.
      const factor = Math.exp(-Math.max(-2400, Math.min(2400, delta)) * 0.0012);
      zoomAt(e.clientX, e.clientY, factor);
    },
    { passive: false, capture: true },
  );

  // Double-click zoom is navigation-only. Measurement tools retain their
  // existing double-click-to-finish gesture.
  svg.addEventListener('dblclick', (e) => {
    if (replacementInProgress || !doc || state.tool !== 'pan') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    zoomAt(e.clientX, e.clientY, 1.5);
  });
}

let spaceDown = false;

function bindPan(): void {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTypingTarget(e.target)) {
      e.preventDefault(); // Space is a temporary navigation modifier, not page-scroll.
      spaceDown = true;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceDown = false;
  });

  svg.addEventListener('pointerdown', (e) => {
    if (replacementInProgress || !doc) return;
    const middlePan = e.button === 1;
    const spacePan = e.button === 0 && spaceDown;
    const toolPan = e.button === 0 && state.tool === 'pan';
    if (!middlePan && !spacePan && !toolPan) return;

    // In selection mode a markup drag belongs to the markup, not the canvas.
    if (toolPan && e.target instanceof Element && e.target.closest('[data-id]')) return;

    e.preventDefault();
    // Navigation gestures must never reach the measurement state machine.
    if (middlePan || spacePan) e.stopImmediatePropagation();

    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // The pointer may already have been cancelled by the browser.
    }

    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev: PointerEvent) => {
      scrollEl.scrollLeft -= ev.clientX - lastX;
      scrollEl.scrollTop -= ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
    };
    const finish = () => {
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', finish);
      svg.removeEventListener('pointercancel', finish);
      svg.removeEventListener('lostpointercapture', finish);
      if (svg.hasPointerCapture(e.pointerId)) {
        try {
          svg.releasePointerCapture(e.pointerId);
        } catch {
          // Capture may already have been released by the browser.
        }
      }
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', finish);
    svg.addEventListener('lostpointercapture', finish);
  });
}

export function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
  );
}
