export const ORDER_STATUS = Object.freeze({
  ORDER: 'ORDER',
  PAID: 'PAID',
  PREPARING: 'PREPARING',
  SHIPPING: 'SHIPPING',
  COMPLETED: 'COMPLETED',
  FULL_CANCEL: 'FULL_CANCEL',
  PARTIAL_CANCEL: 'PARTIAL_CANCEL'
});

export const ADMIN_STATUS = Object.freeze({
  UNCHECKED: 'UNCHECKED',
  CHECKED: 'CHECKED',
  HOLD: 'HOLD'
});

export const OPS_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED'
});

export const INPUT_CHANNEL = Object.freeze({
  DIRECT: 'DIRECT',
  ORDER_IN: 'ORDER_IN',
  EXCEL: 'EXCEL',
  SHOPPING_MALL: 'SHOPPING_MALL',
  EXTERNAL: 'EXTERNAL'
});

export const ORDER_STATUS_LABEL = Object.freeze({
  [ORDER_STATUS.ORDER]: '주문',
  [ORDER_STATUS.PAID]: '입금',
  [ORDER_STATUS.PREPARING]: '준비',
  [ORDER_STATUS.SHIPPING]: '배송',
  [ORDER_STATUS.COMPLETED]: '완료',
  [ORDER_STATUS.FULL_CANCEL]: '전체취소',
  [ORDER_STATUS.PARTIAL_CANCEL]: '부분취소'
});

export const ADMIN_STATUS_LABEL = Object.freeze({
  [ADMIN_STATUS.UNCHECKED]: '미확인',
  [ADMIN_STATUS.CHECKED]: '확인',
  [ADMIN_STATUS.HOLD]: '보류'
});

export const OPS_STATUS_LABEL = Object.freeze({
  [OPS_STATUS.ACTIVE]: '처리중',
  [OPS_STATUS.CLOSED]: '종결'
});

export const INPUT_CHANNEL_LABEL = Object.freeze({
  [INPUT_CHANNEL.DIRECT]: '직접입력',
  [INPUT_CHANNEL.ORDER_IN]: 'ORDER IN',
  [INPUT_CHANNEL.EXCEL]: 'Excel',
  [INPUT_CHANNEL.SHOPPING_MALL]: '쇼핑몰',
  [INPUT_CHANNEL.EXTERNAL]: '외부연동'
});

const VALID_ORDER_STATUS = new Set(Object.values(ORDER_STATUS));
const VALID_ADMIN_STATUS = new Set(Object.values(ADMIN_STATUS));
const VALID_OPS_STATUS = new Set(Object.values(OPS_STATUS));
const VALID_INPUT_CHANNEL = new Set(Object.values(INPUT_CHANNEL));
const VALID_REVIEW_STATUS = new Set(['PENDING', 'CONFIRMED', 'EXCLUDED']);
const VALID_PRODUCT_IDENTITY_STATUS = new Set(['MASTER_LINKED', 'TEMPORARY_CONFIRMED', 'UNRESOLVED']);

export function normalizeOrderStatus(value, legacyStatus = '') {
  const normalized = String(value || '').trim().toUpperCase();
  if (VALID_ORDER_STATUS.has(normalized)) return normalized;
  return String(legacyStatus || '').toUpperCase() === 'CANCELLED' ? ORDER_STATUS.FULL_CANCEL : ORDER_STATUS.ORDER;
}

export function normalizeAdminStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return VALID_ADMIN_STATUS.has(normalized) ? normalized : ADMIN_STATUS.UNCHECKED;
}

export function normalizeOpsStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return VALID_OPS_STATUS.has(normalized) ? normalized : OPS_STATUS.ACTIVE;
}

export function inferInputChannel(sourceType = '', requested = '') {
  const explicit = String(requested || '').trim().toUpperCase();
  if (VALID_INPUT_CHANNEL.has(explicit)) return explicit;
  const source = String(sourceType || '').trim().toUpperCase();
  if (source.includes('KAKAO') || source.includes('ORDER_IN') || source.includes('SMART')) return INPUT_CHANNEL.ORDER_IN;
  if (source.includes('EXCEL') || source.includes('XLS')) return INPUT_CHANNEL.EXCEL;
  if (source.includes('SHOP') || source.includes('MALL') || source.includes('YOUNGCART')) return INPUT_CHANNEL.SHOPPING_MALL;
  if (source.includes('EXTERNAL') || source.includes('API')) return INPUT_CHANNEL.EXTERNAL;
  return INPUT_CHANNEL.DIRECT;
}

export function initialAdminStatus(sourceType = '', requestedInputChannel = '') {
  return inferInputChannel(sourceType, requestedInputChannel) === INPUT_CHANNEL.DIRECT
    ? ADMIN_STATUS.CHECKED
    : ADMIN_STATUS.UNCHECKED;
}

export function orderDateKey(value, fallback = new Date()) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}${match[2]}${match[3]}`;
  const base = fallback instanceof Date && Number.isFinite(fallback.getTime()) ? fallback : new Date();
  const year = base.getFullYear();
  const month = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function formatOrderNo(dateKey, sequence) {
  return `${String(dateKey || '').replace(/\D/g, '').slice(0, 8)}-${String(Math.max(1, Number(sequence) || 1)).padStart(3, '0')}`;
}

export function orderSequenceFromNo(orderNo, dateKey) {
  const match = String(orderNo || '').match(/^(\d{8})-(\d+)$/);
  if (!match || match[1] !== dateKey) return 0;
  return Number(match[2]) || 0;
}

export function assigneeIdentity(name, requestedId = '', previous = null) {
  const assigneeName = String(name || '').trim();
  if (!assigneeName) return { assigneeId: '', assigneeName: '' };
  if (requestedId && (!previous || String(previous.assigneeName || '').trim() === assigneeName)) {
    return { assigneeId: String(requestedId).trim(), assigneeName };
  }
  if (previous?.assigneeId && String(previous.assigneeName || '').trim() === assigneeName) {
    return { assigneeId: previous.assigneeId, assigneeName };
  }
  const normalized = assigneeName.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  return { assigneeId: `MGR-${encodeURIComponent(normalized)}`, assigneeName };
}

export function inheritedAssigneeSnapshot(order = {}) {
  return {
    assigneeId: String(order.assigneeId || '').trim(),
    assigneeName: String(order.assigneeName || '').trim(),
    assigneeInheritedFromOrderId: String(order.orderId || '').trim()
  };
}

export function nullableNumber(value, fallback = null) {
  if (value === '' || value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function externalOrderSnapshot(payload = {}, previous = {}) {
  const pick = key => Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : previous[key];
  return {
    externalOrderNo: String(pick('externalOrderNo') || '').trim(),
    externalOriginalStatus: String(pick('externalOriginalStatus') || '').trim(),
    productAmount: nullableNumber(pick('productAmount')),
    couponDiscount: nullableNumber(pick('couponDiscount')),
    pointsUsed: nullableNumber(pick('pointsUsed')),
    shippingFee: nullableNumber(pick('shippingFee')),
    paymentAmount: nullableNumber(pick('paymentAmount'))
  };
}

export function orderIntakeProvenanceSnapshot(payload = {}, previous = {}) {
  const pick = key => Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : previous[key];
  const value = key => {
    const source = pick(key);
    const normalized = source === undefined || source === null ? '' : String(source).trim();
    return normalized || undefined;
  };
  return {
    intakeSessionId: value('intakeSessionId'),
    intakeDocumentId: value('intakeDocumentId'),
    sourceOccurrenceKey: value('sourceOccurrenceKey'),
    sourceDocumentKey: value('sourceDocumentKey'),
    rawFingerprint: value('rawFingerprint'),
    intakeContractVersion: value('intakeContractVersion')
  };
}

export function validateOrderItemIdentityState(input = {}) {
  const reviewStatus = String(input.reviewStatus || '').trim().toUpperCase();
  const productIdentityStatus = String(input.productIdentityStatus || '').trim().toUpperCase();
  if (!VALID_REVIEW_STATUS.has(reviewStatus)) throw new Error(`ORDERQ_INTAKE_REVIEW_STATUS_INVALID:${reviewStatus}`);
  if (!VALID_PRODUCT_IDENTITY_STATUS.has(productIdentityStatus)) throw new Error(`ORDERQ_INTAKE_PRODUCT_IDENTITY_INVALID:${productIdentityStatus}`);

  const productId = String(input.productId ?? '').trim();
  const itemCode = String(input.itemCode ?? '').trim();
  const itemName = String(input.itemName ?? '').trim();
  const completeMasterIdentity = Boolean(productId && !productId.startsWith('CODE:') && itemCode && itemName);

  if (productIdentityStatus === 'MASTER_LINKED' && !completeMasterIdentity) {
    throw new Error('ORDERQ_INTAKE_MASTER_IDENTITY_REQUIRED');
  }
  if (productIdentityStatus === 'TEMPORARY_CONFIRMED') {
    if (!itemName) throw new Error('ORDERQ_INTAKE_TEMPORARY_NAME_REQUIRED');
    if (productId || itemCode) throw new Error('ORDERQ_INTAKE_TEMPORARY_MASTER_IDENTITY_FORBIDDEN');
    if (!['CONFIRMED', 'EXCLUDED'].includes(reviewStatus)) throw new Error('ORDERQ_INTAKE_TEMPORARY_REVIEW_REQUIRED');
  }
  if (productIdentityStatus === 'UNRESOLVED' && reviewStatus === 'CONFIRMED') {
    throw new Error('ORDERQ_INTAKE_CONFIRMED_UNRESOLVED_FORBIDDEN');
  }
  return { reviewStatus, productIdentityStatus };
}

export function orderItemIdentitySnapshot(input = {}, hasMasterIdentity = false) {
  const requestedReview = String(input.reviewStatus || '').trim().toUpperCase();
  const requestedIdentity = String(input.productIdentityStatus || '').trim().toUpperCase();
  if (requestedReview && !VALID_REVIEW_STATUS.has(requestedReview)) throw new Error(`ORDERQ_INTAKE_REVIEW_STATUS_INVALID:${requestedReview}`);
  if (requestedIdentity && !VALID_PRODUCT_IDENTITY_STATUS.has(requestedIdentity)) throw new Error(`ORDERQ_INTAKE_PRODUCT_IDENTITY_INVALID:${requestedIdentity}`);
  const reviewStatus = requestedReview || (hasMasterIdentity ? 'CONFIRMED' : 'PENDING');
  const productIdentityStatus = requestedIdentity || (hasMasterIdentity ? 'MASTER_LINKED' : 'UNRESOLVED');
  validateOrderItemIdentityState({ ...input, reviewStatus, productIdentityStatus });
  return {
    intakeLineId: String(input.intakeLineId || '').trim(),
    sourceLineKey: String(input.sourceLineKey || '').trim(),
    reviewStatus,
    productIdentityStatus
  };
}

export function normalizedOrderView(order = {}) {
  const orderStatus = normalizeOrderStatus(order.orderStatus, order.status);
  const sourceType = String(order.sourceType || 'MANUAL').trim();
  return {
    ...order,
    sourceMessageKey: String(order.sourceMessageKey || '').trim() || undefined,
    orderNo: String(order.orderNo || '').trim(),
    orderStatus,
    adminStatus: normalizeAdminStatus(order.adminStatus),
    opsStatus: normalizeOpsStatus(order.opsStatus),
    inputChannel: inferInputChannel(sourceType, order.inputChannel),
    assigneeId: String(order.assigneeId || '').trim(),
    assigneeName: String(order.assigneeName || '').trim(),
    deliveryExpectedDate: String(order.deliveryExpectedDate || '').trim(),
    matchingStatus: String(order.matchingStatus || order.status || '').trim(),
    ...externalOrderSnapshot(order, order),
    ...orderIntakeProvenanceSnapshot(order, order)
  };
}

export function documentFieldChanges(before = {}, after = {}) {
  const labels = {
    orderDate: '주문일자', customerName: '거래처', warehouseName: '출하창고', transactionType: '거래유형',
    assigneeName: '담당자', orderStatus: '주문상태', adminStatus: '관리자상태', opsStatus: '운영상태',
    deliveryExpectedDate: '배송예정일', orderMessage: '전표메모', externalOrderNo: '외부주문번호', externalOriginalStatus: '쇼핑몰 원본상태',
    productAmount: '상품금액', couponDiscount: '쿠폰할인', pointsUsed: '포인트사용', shippingFee: '배송비', paymentAmount: '결제금액'
  };
  return Object.entries(labels).flatMap(([field, label]) => {
    const oldValue = before[field] ?? '';
    const newValue = after[field] ?? '';
    return String(oldValue) === String(newValue) ? [] : [{ field, label, before: oldValue, after: newValue }];
  });
}

const ITEM_CHANGE_FIELDS = Object.freeze({
  itemCode: '품목코드',
  itemName: '상품',
  specification: '규격',
  finalUnit: '단위',
  finalQuantity: '수량',
  price: '판매가',
  supplyAmount: '합계',
  memo: '메모'
});

function itemChangeValue(item, field) {
  if (field === 'finalQuantity') return item.finalQuantity ?? item.rawQuantity ?? '';
  if (field === 'finalUnit') return item.finalUnit ?? item.rawUnit ?? '';
  return item[field] ?? '';
}

function itemChangeLabel(item = {}) {
  const identity = String(item.itemName || item.itemCode || '').trim() || `상품 ${Number(item.lineNo || 0) || ''}`.trim();
  return Number(item.lineNo) ? `${Number(item.lineNo)}행 ${identity}` : identity;
}

export function orderItemChanges(beforeItems = [], afterItems = []) {
  const beforeById = new Map(beforeItems.map(item => [String(item.orderItemId || ''), item]));
  const afterById = new Map(afterItems.map(item => [String(item.orderItemId || ''), item]));
  const itemIds = [...new Set([...beforeById.keys(), ...afterById.keys()])].filter(Boolean);
  const changes = [];

  itemIds.forEach(orderItemId => {
    const before = beforeById.get(orderItemId);
    const after = afterById.get(orderItemId);
    if (!before && after) {
      changes.push({
        field: 'orderItems',
        itemField: 'added',
        orderItemId,
        label: `상품 추가 · ${itemChangeLabel(after)}`,
        before: '',
        after: `${after.itemCode || '-'} / ${after.itemName || '-'} / ${itemChangeValue(after, 'finalQuantity') || 0}`
      });
      return;
    }
    if (before && !after) {
      changes.push({
        field: 'orderItems',
        itemField: 'removed',
        orderItemId,
        label: `상품 삭제 · ${itemChangeLabel(before)}`,
        before: `${before.itemCode || '-'} / ${before.itemName || '-'} / ${itemChangeValue(before, 'finalQuantity') || 0}`,
        after: ''
      });
      return;
    }

    Object.entries(ITEM_CHANGE_FIELDS).forEach(([field, label]) => {
      const oldValue = itemChangeValue(before, field);
      const newValue = itemChangeValue(after, field);
      if (String(oldValue) === String(newValue)) return;
      changes.push({
        field: `orderItems.${field}`,
        itemField: field,
        orderItemId,
        label: `${itemChangeLabel(after || before)} · ${label}`,
        before: oldValue,
        after: newValue
      });
    });
  });

  return changes;
}
