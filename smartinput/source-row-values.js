const SOURCE_WHITESPACE = /[\s\u00a0\u200b\u200c\u200d\u2060\ufeff]+/gu;

export function hasMeaningfulSourceValue(value) {
  if (value === null || value === undefined) return false;
  return String(value).replace(SOURCE_WHITESPACE, '') !== '';
}

export function sourceRowHasMeaningfulValue(row = []) {
  return (Array.isArray(row) ? row : [row]).some(hasMeaningfulSourceValue);
}
