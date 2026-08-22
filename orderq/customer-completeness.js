export const CUSTOMER_COMPLETENESS_FIELDS = Object.freeze([
  ['customerName', '상호'],
  ['address', '주소'],
  ['mobile', '휴대폰 번호']
]);

export function isMissingCustomerValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized === '' || normalized === '-' || normalized === '없음';
}

export function missingCustomerFields(customer = {}) {
  return CUSTOMER_COMPLETENESS_FIELDS.filter(([field]) => isMissingCustomerValue(customer[field]));
}

export function customerDisplayStatus(customer = {}) {
  if (customer.status !== 'ACTIVE' || customer.qualityStatus === 'SUPERSEDED') return 'EXCLUDED';
  if (customer.qualityStatus === 'DUPLICATE_CANDIDATE') return 'DUPLICATE_CANDIDATE';
  return missingCustomerFields(customer).length ? 'INCOMPLETE' : 'COMPLETE';
}
