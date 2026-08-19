import {
  ORDER_SOURCE_DOCUMENT_CANONICAL_VERSION,
  SOURCE_DOCUMENT_KEY_VERSION,
  SOURCE_LINE_KEY_VERSION,
  SOURCE_OCCURRENCE_KEY_VERSION
} from './orderq-v8-contracts.js?v=0.11.0';

const encoder = new TextEncoder();

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function canonicalValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ORDERQ_INTAKE_CANONICAL_NUMBER_INVALID');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value instanceof Uint8Array) return Array.from(value);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return String(value);
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalizeIntakeSource(input) {
  return encoder.encode(canonicalStringify(input));
}

async function sha256HexBytes(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('ORDERQ_INTAKE_SHA256_UNAVAILABLE');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function computeCanonicalHash(value) {
  return sha256HexBytes(encoder.encode(typeof value === 'string' ? value : canonicalStringify(value)));
}

export function computeRawFingerprint(input) {
  return sha256HexBytes(canonicalizeIntakeSource(input));
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).normalize('NFKC').trim();
}

function normalizedIdentityText(value) {
  return text(value).toLowerCase().replace(/\s+/g, '');
}

function requireText(value, code) {
  const result = text(value);
  if (!result) throw new Error(code);
  return result;
}

export async function buildSourceOccurrenceKey(evidence = {}) {
  const sourceSystem = requireText(evidence.sourceSystem || evidence.sourceType, 'ORDERQ_INTAKE_SOURCE_SYSTEM_REQUIRED');
  const sourceContainerId = requireText(evidence.sourceContainerId || evidence.sourceId, 'ORDERQ_INTAKE_SOURCE_CONTAINER_REQUIRED');
  const nativeId = text(evidence.sourceNativeId || evidence.captureOccurrenceId);
  const identity = nativeId
    ? {
        version: SOURCE_OCCURRENCE_KEY_VERSION,
        mode: 'NATIVE',
        sourceSystem,
        sourceContainerId,
        sourceNativeId: nativeId
      }
    : {
        version: SOURCE_OCCURRENCE_KEY_VERSION,
        mode: 'FALLBACK',
        sourceSystem,
        sourceContainerId,
        senderEvidence: requireText(evidence.senderEvidence, 'ORDERQ_INTAKE_SENDER_EVIDENCE_REQUIRED'),
        normalizedOccurredAt: requireText(evidence.normalizedOccurredAt, 'ORDERQ_INTAKE_OCCURRED_AT_REQUIRED'),
        occurrenceOrdinal: requireText(evidence.occurrenceOrdinal, 'ORDERQ_INTAKE_OCCURRENCE_ORDINAL_REQUIRED')
      };
  return computeCanonicalHash(identity);
}

export function buildAutomaticSourceDocumentKey({ sourceOccurrenceKey, documentType = 'ORDER', stableSegmentIdentity } = {}) {
  return computeCanonicalHash({
    version: SOURCE_DOCUMENT_KEY_VERSION,
    mode: 'AUTO',
    sourceOccurrenceKey: requireText(sourceOccurrenceKey, 'ORDERQ_INTAKE_SOURCE_OCCURRENCE_KEY_REQUIRED'),
    documentType: requireText(documentType, 'ORDERQ_INTAKE_DOCUMENT_TYPE_REQUIRED').toUpperCase(),
    stableSegmentIdentity: canonicalValue(stableSegmentIdentity)
  });
}

export function buildSplitSourceDocumentKey({ parentSourceDocumentKey, immutableBoundary } = {}) {
  return computeCanonicalHash({
    version: SOURCE_DOCUMENT_KEY_VERSION,
    mode: 'SPLIT',
    parentSourceDocumentKey: requireText(parentSourceDocumentKey, 'ORDERQ_INTAKE_PARENT_DOCUMENT_KEY_REQUIRED'),
    immutableBoundary: canonicalValue(immutableBoundary)
  });
}

export function buildMergeSourceDocumentKey(sourceDocumentKeys = []) {
  const keys = [...new Set(sourceDocumentKeys.map(text).filter(Boolean))].sort();
  if (keys.length < 2) throw new Error('ORDERQ_INTAKE_MERGE_DOCUMENT_KEYS_REQUIRED');
  return computeCanonicalHash({ version: SOURCE_DOCUMENT_KEY_VERSION, mode: 'MERGE', sourceDocumentKeys: keys });
}

export function buildSourceLineKey({ sourceDocumentKey, externalLineId, sourceRange } = {}) {
  const identity = hasOwn({ externalLineId }, 'externalLineId') && externalLineId !== undefined && externalLineId !== null && text(externalLineId) !== ''
    ? { mode: 'EXTERNAL_LINE', externalLineId: text(externalLineId) }
    : { mode: 'SOURCE_RANGE', sourceRange: canonicalValue(sourceRange) };
  if (identity.mode === 'SOURCE_RANGE' && (sourceRange === undefined || sourceRange === null)) {
    throw new Error('ORDERQ_INTAKE_SOURCE_LINE_EVIDENCE_REQUIRED');
  }
  return computeCanonicalHash({
    version: SOURCE_LINE_KEY_VERSION,
    sourceDocumentKey: requireText(sourceDocumentKey, 'ORDERQ_INTAKE_SOURCE_DOCUMENT_KEY_REQUIRED'),
    ...identity
  });
}

function pick(source, keys) {
  for (const key of keys) if (hasOwn(source, key)) return canonicalValue(source[key]);
  return null;
}

function identityOrName(source, idKeys, nameKeys) {
  const id = text(pick(source, idKeys));
  if (id) return { id };
  return { normalizedName: normalizedIdentityText(pick(source, nameKeys)) };
}

function canonicalOrderItem(item = {}, index = 0) {
  const sourceLineKey = text(item.sourceLineKey) || `LEGACY_LINE:${String(Number(item.lineNo) || index + 1).padStart(6, '0')}`;
  return {
    sourceLineKey,
    productId: pick(item, ['productId']),
    itemCode: pick(item, ['itemCode', 'productCode']),
    itemName: pick(item, ['itemName', 'productName']),
    specification: pick(item, ['specification']),
    rawQuantity: pick(item, ['rawQuantity', 'quantity']),
    rawUnit: pick(item, ['rawUnit', 'unit']),
    finalQuantity: pick(item, ['finalQuantity', 'quantity']),
    finalUnit: pick(item, ['finalUnit', 'unit', 'rawUnit']),
    price: pick(item, ['price', 'unitPrice']),
    priceType: pick(item, ['priceType']),
    supplyAmount: pick(item, ['supplyAmount']),
    vatAmount: pick(item, ['vatAmount']),
    memo: pick(item, ['memo']),
    description: pick(item, ['description']),
    noticePrice: pick(item, ['noticePrice']),
    reviewStatus: pick(item, ['reviewStatus']),
    productIdentityStatus: pick(item, ['productIdentityStatus']),
    matchStatus: pick(item, ['matchStatus'])
  };
}

export function buildOrderSourceDocumentCanonicalProjection({ order = {}, items = [] } = {}) {
  const canonicalItems = items.map(canonicalOrderItem).sort((left, right) => left.sourceLineKey.localeCompare(right.sourceLineKey));
  return canonicalValue({
    version: ORDER_SOURCE_DOCUMENT_CANONICAL_VERSION,
    header: {
      orderDate: pick(order, ['orderDate']),
      customer: identityOrName(order, ['customerId'], ['customerName', 'normalizedCustomerName']),
      warehouse: identityOrName(order, ['warehouseId', 'warehouseCode'], ['warehouseName', 'warehouse']),
      transactionType: pick(order, ['transactionType']),
      deliveryExpectedDate: pick(order, ['deliveryExpectedDate']),
      orderMessage: pick(order, ['orderMessage']),
      externalOrderNo: pick(order, ['externalOrderNo']),
      sourceType: pick(order, ['sourceType']),
      sourceId: pick(order, ['sourceId']),
      assigneeId: pick(order, ['assigneeId']),
      assigneeName: pick(order, ['assigneeName']),
      orderStatus: pick(order, ['orderStatus']),
      adminStatus: pick(order, ['adminStatus'])
    },
    items: canonicalItems
  });
}

export function computeOrderSourceDocumentCanonicalHash(bundle) {
  return computeCanonicalHash(buildOrderSourceDocumentCanonicalProjection(bundle));
}
