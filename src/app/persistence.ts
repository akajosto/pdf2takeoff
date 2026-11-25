let saveTimer: number | undefined;

/** Cancel a pending write before a document replacement becomes tentative. */
export function cancelScheduledSave(): void {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = undefined;
}

/** Debounced autosave — call on any state change while a document is open. */