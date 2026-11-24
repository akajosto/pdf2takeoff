import assert from 'node:assert/strict';
import {
  awaitPdfRenderTask,
  cancelAndSettleRenderTask,
  loadValidatedPdfCandidate,
  openPdfTask,
} from '../src/app/pdf-candidate.ts';
import { decodeProjectFile, validateProjectPageReferences } from '../src/app/project-file.ts';

const pdfBytes = Buffer.from('%PDF-1.7\nminimal fixture').toString('base64');
const validProject = {
  format: 'pdf2takeoff-project',
  version: 1,
  name: 'fixture.pdf',
  drawing: pdfBytes,
  pageNum: 1,
  markups: [],
};
const decoded = decodeProjectFile(JSON.stringify(validProject));
assert.equal(decoded.name, 'fixture.pdf');
assert.equal(decoded.pageNum, 1);
assert.equal(new TextDecoder().decode(decoded.bytes).slice(0, 5), '%PDF-');
validateProjectPageReferences(decoded.project, 1);

assert.throws(() => decodeProjectFile('{bad json'), /not valid JSON/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, drawing: '%%%=' })), /invalid embedded PDF/);
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, drawing: Buffer.from('not a PDF').toString('base64') })), /does not contain a PDF/);
assert.throws(() => validateProjectPageReferences({ ...decoded.project, pageNum: 2 }, 1), /refers to page 2/);

const duplicateMarkup = { id: 'm1', page: 1, type: 'count', label: 'Door', points: [{ x: 1, y: 2 }], createdAt: 1 };
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, markups: [duplicateMarkup, duplicateMarkup] })), /duplicate ids/);
const cyclicA = { ...duplicateMarkup, id: 'a', parentId: 'b' };
const cyclicB = { ...duplicateMarkup, id: 'b', parentId: 'a' };
assert.throws(() => decodeProjectFile(JSON.stringify({ ...validProject, markups: [cyclicA, cyclicB] })), /parent hierarchy/);

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
  const promise = new Promise((_, reject) => {
    // The cancellation rejection is the normal PDF.js settlement signal.
    setTimeout(() => reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })), 0);
  });
  const settled = await cancelAndSettleRenderTask({ promise, cancel: () => { cancelled = true; } });
  assert.equal(cancelled, true);
  assert.deepEqual(settled.errors, []);
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
  ), /ownership is unresolved/);
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
  const task = {
    promise: Promise.reject(new Error('render failed')),
    cancel() {},
  };
  await assert.rejects(() => awaitPdfRenderTask(task, () => { released = true; }), /render failed/);
  assert.equal(released, true);
}

console.log('PASS: project validation and PDF candidate transaction checks');
