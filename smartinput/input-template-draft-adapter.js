/**
 * Applies one mapped template import to a SmartInput mode draft.
 *
 * The adapter owns only live-source replacement, idempotency, insertion order,
 * and administrator-edit preservation. Catalog enrichment, reference matching,
 * voucher grouping, and official writers remain in smartinput.js.
 */

function text(value) {
  return String(value ?? '');
}

function previousRowFor(nextRow, previousRows = []) {
  return previousRows.find(row => row.sourceLineKey && row.sourceLineKey === nextRow.sourceLineKey)
    || previousRows.find(row => row.sourceLineNo === nextRow.sourceLineNo
      && text(row.rawText) === text(nextRow.rawText));
}

export function replaceLiveTemplateImport(draft, { batch, rows = [], contract } = {}) {
  if (!draft || !batch || !contract?.applyParserResults) {
    throw new Error('TEMPLATE_DRAFT_ADAPTER_INPUT_INVALID');
  }
  const currentRows = Array.isArray(draft.rows) ? draft.rows : [];
  const currentBatches = Array.isArray(draft.batches) ? draft.batches : [];
  const alreadyApplied = currentBatches.some(item => item.sourceRole === 'LIVE_SOURCE'
    && item.importIdempotencyKey
    && item.importIdempotencyKey === batch.importIdempotencyKey);
  const liveBatchIds = new Set(currentBatches
    .filter(item => item.sourceRole === 'LIVE_SOURCE')
    .map(item => item.batchId));
  const previousLiveRows = currentRows.filter(row => liveBatchIds.has(row.batchId));
  const firstLiveRowIndex = currentRows.findIndex(row => liveBatchIds.has(row.batchId));
  const insertionIndex = firstLiveRowIndex < 0 ? currentRows.length : Math.max(0, firstLiveRowIndex);
  const retainedRows = currentRows.filter(row => !liveBatchIds.has(row.batchId));
  const batches = [...currentBatches.filter(item => item.sourceRole !== 'LIVE_SOURCE'), batch];
  const appliedRows = contract.applyParserResults(retainedRows, batch, rows);
  const importedRows = appliedRows.filter(row => row.batchId === batch.batchId);
  importedRows.forEach(row => {
    const previous = previousRowFor(row, previousLiveRows);
    if (!previous) return;
    (contract.ROW_FIELDS || []).forEach(field => {
      if (previous.editedFields?.[field]) row[field] = previous[field];
    });
    row.editedFields = { ...(previous.editedFields || row.editedFields || {}) };
  });
  const otherRows = appliedRows.filter(row => row.batchId !== batch.batchId);
  return {
    alreadyApplied,
    batches,
    rows: [...otherRows.slice(0, insertionIndex), ...importedRows, ...otherRows.slice(insertionIndex)],
    importedRows,
    replacedLiveBatchIds: [...liveBatchIds]
  };
}
