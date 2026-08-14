export function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(number) ? number : null;
}

export function calculateLineTotal(quantity, price) {
  const normalizedQuantity = numberOrNull(quantity);
  const normalizedPrice = numberOrNull(price);
  if (normalizedQuantity === null || normalizedPrice === null) return null;
  return normalizedQuantity * normalizedPrice;
}

export function calculateVatAmount(total) {
  const normalizedTotal = numberOrNull(total);
  if (normalizedTotal === null) return null;
  return Math.round(normalizedTotal * 0.1);
}

function compareText(left, right) {
  return String(left || '').trim().localeCompare(String(right || '').trim(), 'ko', {
    numeric: true,
    sensitivity: 'base'
  });
}

export function compareManualRows(left = {}, right = {}, sortKey = 'input') {
  const leftEmpty = Boolean(left.empty);
  const rightEmpty = Boolean(right.empty);
  if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;

  let compared = 0;
  if (sortKey === 'code') compared = compareText(left.itemCode, right.itemCode);
  else if (sortKey === 'name') compared = compareText(left.itemName, right.itemName);
  else if (sortKey === 'unit') compared = compareText(left.finalUnit, right.finalUnit);
  if (compared) return compared;
  return Number(left.inputSequence || 0) - Number(right.inputSequence || 0);
}
