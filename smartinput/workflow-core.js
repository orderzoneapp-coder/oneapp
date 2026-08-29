export async function executeVoucherGroups(groups = [], writer) {
  if (typeof writer !== 'function') throw new TypeError('VOUCHER_WRITER_REQUIRED');
  const results = [];
  for (const group of groups) {
    try {
      results.push({ ok: true, group, result: await writer(group) });
    } catch (error) {
      results.push({ ok: false, group, error });
    }
  }
  return results;
}

export function rowsForFailedGroups(originalRows = [], results = []) {
  const failedRowIds = new Set(results
    .filter(result => !result.ok)
    .flatMap(result => result.group?.rows || [])
    .map(row => row.rowId));
  return originalRows.filter(row => failedRowIds.has(row.rowId));
}

export function deliveryState(results = []) {
  const succeeded = results.filter(result => result.ok).length;
  const failed = results.length - succeeded;
  if (!failed) return 'SAVED';
  return succeeded ? 'PARTIAL' : 'FAILED';
}
