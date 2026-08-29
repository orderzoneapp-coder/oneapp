export const REFERENCE_STATUS = Object.freeze({
  LOADING: 'LOADING',
  READY: 'READY',
  ERROR: 'REFERENCE_ERROR'
});

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function message(error, fallback) {
  return String(error?.message || error || fallback).trim();
}

export function evaluateReferenceReadiness({
  customers = [],
  customerError = null,
  productResult = null,
  productError = null
} = {}) {
  const customerRows = rows(customers);
  const productRows = rows(productResult?.products);
  const reportedCommonCount = Number(productResult?.commonCount);
  const productCount = Number.isFinite(reportedCommonCount) ? reportedCommonCount : productRows.length;
  const productErrors = rows(productResult?.errors).map(error => message(error, '상품 기준정보 로드 오류')).filter(Boolean);
  const issues = [];

  if (customerError) issues.push(message(customerError, '거래처 기준정보 로드 오류'));
  else if (!customerRows.length) issues.push('거래처 기준정보가 0건입니다.');

  if (productError) issues.push(message(productError, '상품 기준정보 로드 오류'));
  else {
    productErrors.forEach(error => issues.push(error));
    if (!productCount) issues.push('상품 기준정보가 0건입니다.');
  }

  const customerReady = !customerError && customerRows.length > 0;
  const productReady = !productError && !productErrors.length && productCount > 0;
  const ready = customerReady && productReady;
  return {
    status: ready ? REFERENCE_STATUS.READY : REFERENCE_STATUS.ERROR,
    ready,
    customerReady,
    productReady,
    issues,
    message: ready
      ? ''
      : `REFERENCE_ERROR · ${issues.join(' · ')} 기준정보를 다시 불러오세요.`
  };
}

export function preserveReferenceRows(currentRows = [], loadedRows = [], loadReady = false) {
  return loadReady ? rows(loadedRows) : currentRows;
}
