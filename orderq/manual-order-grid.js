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

export function shiftIsoDate(value, deltaDays) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return '';
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  const delta = Number(deltaDays);
  if (!Number.isFinite(delta)) return '';
  date.setUTCDate(date.getUTCDate() + Math.trunc(delta));
  return date.toISOString().slice(0, 10);
}

const PRICE_TYPE_LABELS = Object.freeze({
  salePrice: '판매가',
  outPrice: '출고가',
  wholesaleA: '도매A',
  wholesaleB: '도매B',
  listingPrice: '상장가',
  marketPrice: '시중가',
  promoPrice: '행사가',
  MANUAL: '직접입력'
});

export function cycleManualPriceOption(options = [], currentKey = '', direction = 1) {
  const usable = options.filter(option => option && option.key && numberOrNull(option.value) !== null);
  if (!usable.length) return null;
  const step = direction < 0 ? -1 : 1;
  const currentIndex = usable.findIndex(option => option.key === currentKey);
  const baseIndex = currentIndex >= 0 ? currentIndex : (step > 0 ? -1 : 0);
  return usable[(baseIndex + step + usable.length) % usable.length];
}

export function manualPriceTypeLabel(priceType = '', options = [], hasPrice = false) {
  return options.find(option => option?.key === priceType)?.label
    || PRICE_TYPE_LABELS[priceType]
    || (hasPrice ? PRICE_TYPE_LABELS.MANUAL : '단가선택');
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
