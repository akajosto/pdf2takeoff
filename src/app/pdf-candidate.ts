/** Transaction primitives for safely replacing a live PDF document. */
export interface PdfLoadingTask<T> { promise: Promise<T>; destroy(): Promise<void> | void; }
export interface PdfRenderTask { promise: Promise<unknown>; cancel(): void; }
export interface CandidateRollback {
  candidateDetached: boolean;
  rollbackComplete: boolean;
  errors: unknown[];
}
export interface CandidateTransaction {
  rollback(): Promise<CandidateRollback>;
  finalize(): Promise<void>;
}
export interface CandidateLoadResult<Result> { value: Result; cleanupErrors: unknown[]; }

function errorName(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name) : undefined;
}
function combineErrors(errors: unknown[], message: string): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}

export async function openPdfTask<T>(task: PdfLoadingTask<T>): Promise<T> {
  try { return await task.promise; }
  catch (error) {
    try { await task.destroy(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'PDF loading and task cleanup both failed.'); }
    throw error;
  }
}

/** Cancellation is asynchronous: the render promise must settle before its canvas/document is released. */
export async function cancelAndSettleRenderTask(task: PdfRenderTask | null): Promise<unknown[]> {
  if (!task) return [];
  const errors: unknown[] = [];
  try { task.cancel(); } catch { /* a just-completed PDF.js task may reject cancellation */ }
  try { await task.promise; }
  catch (error) {
    if (errorName(error) !== 'RenderingCancelledException' && errorName(error) !== 'AbortException') errors.push(error);
  }
  return errors;
}

export async function awaitPdfRenderTask(task: PdfRenderTask, release: () => void): Promise<void> {
  const errors: unknown[] = [];
  try { await task.promise; }
  catch (error) {
    errors.push(error);
    try { task.cancel(); } catch (cancelError) { errors.push(cancelError); }
    try { await task.promise; }
    catch (settleError) {
      if (errorName(settleError) !== 'RenderingCancelledException' &&
          errorName(settleError) !== 'AbortException' && settleError !== error) errors.push(settleError);
    }
  } finally {
    try { release(); } catch (releaseError) { errors.push(releaseError); }
  }
  if (errors.length) throw combineErrors(errors, 'PDF render and resource cleanup both failed.');
}

async function disposeAfterFailure<T>(candidate: T, dispose: (candidate: T) => Promise<void> | void, error: unknown): Promise<never> {
  try { await dispose(candidate); }
  catch (disposeError) { throw new AggregateError([error, disposeError], 'PDF candidate operation and cleanup both failed.'); }
  throw error;
}

/** activate() must return a transaction or throw before changing ownership. */
export async function loadValidatedPdfCandidate<T, Prepared, Result>(
  open: () => Promise<T>,
  validate: (candidate: T) => Promise<Prepared>,
  activate: (candidate: T, prepared: Prepared) => CandidateTransaction | Promise<CandidateTransaction>,
  run: () => Promise<Result>,
  dispose: (candidate: T) => Promise<void> | void,
): Promise<CandidateLoadResult<Result>> {
  const candidate = await open();
  let prepared: Prepared;
  try { prepared = await validate(candidate); }
  catch (error) { return disposeAfterFailure(candidate, dispose, error); }

  let transaction: CandidateTransaction;
  try { transaction = await activate(candidate, prepared); }
  catch (error) { return disposeAfterFailure(candidate, dispose, error); }

  let value: Result;
  try { value = await run(); }
  catch (error) {
    const errors = [error];
    let candidateDetached = false;
    let rollbackComplete = false;
    try {
      const rollback = await transaction.rollback();
      candidateDetached = rollback.candidateDetached;
      rollbackComplete = rollback.rollbackComplete;
      errors.push(...rollback.errors);
    } catch (rollbackError) { errors.push(rollbackError); }

    if (candidateDetached) {
      try { await dispose(candidate); } catch (disposeError) { errors.push(disposeError); }
    } else {
      errors.push(new Error('Candidate ownership is unresolved; it was not disposed because it may still be active.'));
    }
    if (!rollbackComplete) errors.push(new Error('Application rollback was incomplete.'));
    throw combineErrors(errors, 'PDF replacement failed and rollback reported additional errors.');
  }

  const cleanupErrors: unknown[] = [];
  try { await transaction.finalize(); } catch (error) { cleanupErrors.push(error); }
  return { value, cleanupErrors };
}
