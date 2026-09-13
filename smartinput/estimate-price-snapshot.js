const text = value => String(value ?? '').trim();

const numeric = value => {
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

function priceKey(row = {}, index = 0) {
  const masterId = text(row.masterProductId);
  if (masterId) return `MASTER:${masterId}`;
  const code = text(row.itemCode);
  return code ? `CODE:${code}` : `ROW:${index}`;
}

export function buildCatalogPriceSnapshot(rows = [], priceFieldId = 'noticePrice') {
  return Object.fromEntries((Array.isArray(rows) ? rows : []).map((row, index) => [
    priceKey(row, index),
    numeric(row?.[priceFieldId]) ?? 0
  ]));
}

export function priceSnapshotsEqual(left = {}, right = {}) {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && Number(left[key]) === Number(right[key]));
}
