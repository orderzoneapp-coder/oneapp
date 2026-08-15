import { normalizeText } from './orderq-db.js?v=0.8.0';

export const QUICK_PRODUCT_STATUS = Object.freeze({
  UNLINKED: 'UNLINKED',
  LINKED: 'LINKED'
});

export const QUICK_PRODUCT_EVENT = Object.freeze({
  CREATED: 'QUICK_PRODUCT_CREATED',
  MASTER_LINKED: 'QUICK_PRODUCT_MASTER_LINKED',
  MASTER_UNLINKED: 'QUICK_PRODUCT_MASTER_UNLINKED'
});

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export function isTemporaryProductId(value) {
  return /^TMP-[A-Za-z0-9-]+$/.test(text(value));
}

export function normalizeQuickProductDraft(source = {}) {
  const itemName = text(source.itemName || source.productName);
  if (!itemName) throw new Error('ORDERQ_QUICK_PRODUCT_NAME_REQUIRED');
  return {
    itemCode: text(source.itemCode ?? source.productCode),
    itemName,
    normalizedName: normalizeText(itemName),
    specification: text(source.specification),
    finalUnit: text(source.finalUnit || source.unit),
    boxQuantity: source.boxQuantity === '' || source.boxQuantity === null || source.boxQuantity === undefined
      ? null
      : Number(source.boxQuantity),
    memo: text(source.memo),
    reason: text(source.reason || 'QUICK_PRODUCT_CREATED')
  };
}

export function normalizeMasterLinkCommand(source = {}) {
  const quickProductId = text(source.quickProductId);
  const reason = text(source.reason);
  const expectedRevision = Number(source.expectedRevision);
  const master = source.masterProduct || source.master || {};
  const masterProductId = text(master.productId || source.masterProductId);
  if (!isTemporaryProductId(quickProductId)) throw new Error('ORDERQ_QUICK_PRODUCT_ID_REQUIRED');
  if (!masterProductId || isTemporaryProductId(masterProductId) || masterProductId === quickProductId) {
    throw new Error('ORDERQ_QUICK_PRODUCT_MASTER_ID_INVALID');
  }
  if (!reason) throw new Error('ORDERQ_QUICK_PRODUCT_LINK_REASON_REQUIRED');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_QUICK_PRODUCT_REVISION_REQUIRED');
  return {
    quickProductId,
    expectedRevision,
    reason,
    masterProduct: {
      productId: masterProductId,
      itemCode: text(master.itemCode ?? master.productCode),
      itemName: text(master.itemName || master.productName),
      normalizedName: normalizeText(master.itemName || master.productName),
      specification: text(master.specification),
      finalUnit: text(master.finalUnit || master.unit),
      source: text(master.source || 'COMMON_MASTER')
    }
  };
}

export function normalizeMasterUnlinkCommand(source = {}) {
  const quickProductId = text(source.quickProductId);
  const reason = text(source.reason);
  const expectedRevision = Number(source.expectedRevision);
  if (!isTemporaryProductId(quickProductId)) throw new Error('ORDERQ_QUICK_PRODUCT_ID_REQUIRED');
  if (!reason) throw new Error('ORDERQ_QUICK_PRODUCT_UNLINK_REASON_REQUIRED');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_QUICK_PRODUCT_REVISION_REQUIRED');
  return { quickProductId, expectedRevision, reason };
}
