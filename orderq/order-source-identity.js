import { canonicalShoppingJson, sha256Text } from './shopping-order-dedupe-core.js?v=0.8.0';

export const ORDER_SOURCE_IDENTITY_SCHEMA = 'ONEAPP_ORDER_SOURCE_IDENTITY_V1';

const text = value => String(value ?? '').trim();
const numberOrNull = value => {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? (Object.is(number, -0) ? 0 : number) : null;
};

function itemBasis(item = {}, index = 0) {
  return {
    lineNo: Number(item.lineNo) || index + 1,
    sourceLineKey: text(item.sourceLineKey),
    productId: text(item.productId),
    masterProductId: text(item.masterProductId),
    itemCode: text(item.itemCode),
    itemName: text(item.itemName),
    specification: text(item.specification),
    rawText: text(item.rawText),
    quantity: numberOrNull(item.quantity ?? item.finalQuantity ?? item.rawQuantity),
    unit: text(item.unit ?? item.finalUnit ?? item.rawUnit),
    unitPrice: numberOrNull(item.unitPrice ?? item.price),
    supplyAmount: numberOrNull(item.supplyAmount),
    vatAmount: numberOrNull(item.vatAmount),
    memo: text(item.memo),
    description: text(item.description),
    noticePrice: numberOrNull(item.noticePrice)
  };
}

export function orderSourcePayloadBasis(payload = {}) {
  return {
    schema: ORDER_SOURCE_IDENTITY_SCHEMA,
    sourceDocumentKey: text(payload.sourceDocumentKey),
    sourceId: text(payload.sourceId),
    intakeSessionId: text(payload.intakeSessionId),
    intakeDocumentId: text(payload.intakeDocumentId),
    rawFingerprint: text(payload.rawFingerprint),
    orderDate: text(payload.orderDate),
    deliveryExpectedDate: text(payload.deliveryExpectedDate),
    customerId: text(payload.customerId),
    customerName: text(payload.customerName),
    warehouseId: text(payload.warehouseId),
    warehouseCode: text(payload.warehouseCode),
    warehouseName: text(payload.warehouseName),
    transactionType: text(payload.transactionType),
    externalOrderNo: text(payload.externalOrderNo),
    orderMessage: text(payload.orderMessage),
    assigneeId: text(payload.assigneeId),
    assigneeName: text(payload.assigneeName),
    items: (payload.items || []).map(itemBasis)
  };
}

export function orderSourcePayloadHash(payload = {}) {
  return sha256Text(canonicalShoppingJson(orderSourcePayloadBasis(payload)));
}
