function positiveOrder(value) {
  const order = Number(value);
  return Number.isInteger(order) && order > 0 ? order : null;
}

function text(value) {
  return String(value ?? '').trim();
}

function compareText(left, right) {
  return text(left).localeCompare(text(right));
}

export function compareEstimateOrder(left = {}, right = {}) {
  const leftOrder = positiveOrder(left.sortOrder);
  const rightOrder = positiveOrder(right.sortOrder);
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) return leftOrder - rightOrder;
  if ((leftOrder !== null) !== (rightOrder !== null)) return leftOrder !== null ? -1 : 1;

  for (const field of ['createdAt', 'updatedAt', 'estimateId', 'catalogName']) {
    const compared = compareText(left[field], right[field]);
    if (compared) return compared;
  }
  return 0;
}

export function normalizeEstimateSequence(records = []) {
  return [...records].map((record, index) => ({ ...record, sortOrder: index + 1 }));
}

export function normalizeEstimateOrder(records = []) {
  return normalizeEstimateSequence([...records].sort(compareEstimateOrder));
}

export function reorderEstimateRecords(records = [], estimateId = '', targetIndex = 0) {
  const ordered = normalizeEstimateOrder(records);
  const sourceIndex = ordered.findIndex(record => record.estimateId === estimateId);
  if (sourceIndex < 0) return ordered;

  const [moved] = ordered.splice(sourceIndex, 1);
  const requestedIndex = Number(targetIndex);
  const nextIndex = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.min(ordered.length, Math.trunc(requestedIndex)))
    : sourceIndex;
  ordered.splice(nextIndex, 0, moved);
  return normalizeEstimateSequence(ordered);
}
