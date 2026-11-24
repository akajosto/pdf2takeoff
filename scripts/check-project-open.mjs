import assert from 'node:assert/strict';
import {
  awaitPdfRenderTask,
  cancelAndSettleRenderTask,
  loadValidatedPdfCandidate,
  openPdfTask,
} from '../src/app/pdf-candidate.ts';
import { decodeProjectFile, openProjectText, validateProjectPageReferences } from '../src/app/project-file.ts';

const pdfBytes = Buffer.from('%PDF-1.7\nminimal fixture').toString('base64');
const markup = { id: 'm1', page: 1, type: 'count', label: 'Door', points: [{ x: 1, y: 2 }], createdAt: 1 };
const annotation = { id: 'a1', page: 1, kind: 'text', points: [{ x: 1, y: 2 }], text: 'Note' };
const validProject = {
  format: 'pdf2takeoff-project',
  version: 1,
  name: 'fixture.pdf',
  drawing: pdfBytes,
  pageNum: 1,
  markups: [markup],
  annotations: [annotation],
  layerState: {
    activeLayer: 'Structure',
    hidden: [],
    layers: [{ name: 'Default' }, { name: 'Structure', color: '#123456', locked: false, order: 1 }],
  },
};
const decoded = decodeProjectFile(JSON.stringify(validProject));
assert.equal(decoded.name, 'fixture.pdf');
assert.equal(decoded.pageNum, 1);
assert.equal(new TextDecoder().decode(decoded.bytes).slice(0, 5), '%PDF-');
assert.equal(decoded.project.annotations?.length, 1);
validateProjectPageReferences(decoded.project, 1);

assert.throws(() => decodeProjectFile('{bad json'), /not valid JSON/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, drawing: '%%%=' })), /invalid embedded PDF/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, drawing: Buffer.from('not a PDF').toString('base64') })), /does not contain a PDF/);
assert.throws(() => validateProjectPageReferences({ ...decoded.project, pageNum: 2 }, 1), /refers to page 2/);
assert.throws(() => validateProjectPageReferences({ ...decoded.project, annotations: [{ ...annotation, page: 2 }] }, 1), /refers to page 2/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, markups: [{ ...markup, timesing: 0 }] })), /invalid measurements/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, markups: [{ ...markup, strokeOpacity: 1.1 }] })), /invalid measurements/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, markups: [{ ...markup, depth: 0 }] })), /invalid measurements/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, annotations: [{ ...annotation, opacity: -0.1 }] })), /invalid annotations/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, annotations: [{ ...annotation, strokeWidth: 0 }] })), /invalid annotations/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, calibrations: [[1, { metersPerPt: 0, source: 'bad' }]] })), /invalid calibrations/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, viewports: [{ id: 'v1', page: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], metersPerPt: 0, source: 'bad' }] })), /invalid viewports/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, columns: [{ name: '  ', formula: 'value', unit: 'm' }] })), /invalid quantity columns/);

{
  const order = [];
  await openProjectText(JSON.stringify(validProject), {
    loadDrawing: async (_bytes, _name, _page, lifecycle) => {
      order.push('load');
      lifecycle.validatePageCount(1);
      await lifecycle.initialize();
      order.push('drawing-ready');
      await lifecycle.beforeCommit?.();
      order.push('committed');
    },
    applyProject: () => { order.push('apply-project'); },
    notifyOpened: () => { order.push('notify-opened'); },
  });
  assert.deepEqual(order, ['load', 'apply-project', 'drawing-ready', 'notify-opened', 'committed']);
}
{
  await assert.rejects(() => openProjectText(JSON.stringify(validProject), {
    loadDrawing: async (_bytes, _name, _page, lifecycle) => {
      await lifecycle.initialize();
      await lifecycle.beforeCommit?.();
    },
    applyProject: () => undefined,
    notifyOpened: () => { throw new Error('commit notification failed'); },
  }), /commit notification failed/);
}
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, markups: [markup, markup] })), /duplicate ids/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, annotations: [annotation, annotation] })), /duplicate ids/);
const cyclicA = { ...markup, id: 'a', parentId: 'b' };
const cyclicB = { ...markup, id: 'b', parentId: 'a' };
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, markups: [cyclicA, cyclicB] })), /parent hierarchy/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, layerState: { activeLayer: 'Missing', layers: [{ name: 'Default' }] } })), /active layer reference/);

{
  let destroyed = false;
  await assert.rejects(() => openPdfTask({
    promise: Promise.reject(new Error('load failed')),
    destroy: async () => { destroyed = true; },
  }), /load failed/);
  assert.equal(destroyed, true);
}
{
  let cancelled = false;
  let rejectRender;
  const promise = new Promise((_, reject) => { rejectRender = reject; });
  const settled = await cancelAndSettleRenderTask({
    promise,
    cancel: () => { cancelled = true; rejectRender(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })); },
  });
  assert.equal(cancelled, true);
  assert.deepEqual(settled, []);
}
{
  let disposed = false;
  await assert.rejects(() => loadValidatedPdfCandidate(
    async () => ({ id: 'candidate' }),
    async () => { throw new Error('validation failed'); },
    () => { throw new Error('must not activate'); },
    async () => undefined,
    async () => { disposed = true; },
  ), /validation failed/);
  assert.equal(disposed, true);
}
{
  let disposed = false;
  let rolledBack = false;
  await assert.rejects(() => loadValidatedPdfCandidate(
    async () => ({ id: 'candidate' }),
    async () => 'prepared',
    () => ({
      rollback: async () => { rolledBack = true; return { candidateDetached: true, rollbackComplete: true, errors: [] }; },
      finalize: async () => undefined,
    }),
    async () => { throw new Error('first render failed'); },
    async () => { disposed = true; },
  ), /first render failed/);
  assert.equal(rolledBack, true);
  assert.equal(disposed, true);
}
{
  let disposed = false;
  await assert.rejects(() => loadValidatedPdfCandidate(
    async () => ({ id: 'candidate' }),
    async () => 'prepared',
    () => ({
      rollback: async () => ({ candidateDetached: false, rollbackComplete: false, errors: [new Error('rollback failed')] }),
      finalize: async () => undefined,
    }),
    async () => { throw new Error('activation work failed'); },
    async () => { disposed = true; },
  ), (error) => error instanceof AggregateError && error.errors.some((item) => String(item).includes('ownership is unresolved')));
  assert.equal(disposed, false);
}
{
  const result = await loadValidatedPdfCandidate(
    async () => ({ id: 'candidate' }),
    async () => 'prepared',
    () => ({
      rollback: async () => ({ candidateDetached: true, rollbackComplete: true, errors: [] }),
      finalize: async () => { throw new Error('old document destroy failed'); },
    }),
    async () => 42,
    async () => undefined,
  );
  assert.equal(result.value, 42);
  assert.equal(result.cleanupErrors.length, 1);
}
{
  let released = false;
  const task = { promise: Promise.reject(new Error('render failed')), cancel() {} };
  await assert.rejects(() => awaitPdfRenderTask(task, () => { released = true; }), /render failed/);
  assert.equal(released, true);
}
console.log('PASS: project validation and PDF candidate transaction checks');
