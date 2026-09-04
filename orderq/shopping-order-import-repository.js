import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { formatOrderNo, orderDateKey, orderSequenceFromNo } from './order-document-model.js?v=0.7.1';
import {
  SHOPPING_ORDER_DEDUPE_SCHEMA,
  SHOPPING_ORDER_SOURCE_SCHEMA,
  canonicalShoppingOrderBasis,
  canonicalShoppingOrderSignature,
  cloneShoppingEvidence,
  findInvalidExistingLedgerConflicts,
  orderBundleToShoppingCandidate,
  planShoppingOrderDuplicates,
  shoppingSourceMessageKey,
  validateShoppingOrderCandidate
} from './shopping-order-dedupe-core.js?v=0.2.0';

export const SHOPPING_ORDER_IMPORT_REPOSITORY_VERSION = 'ONEAPP_ORDERQ_SHOPPING_ORDER_IMPORT_REPOSITORY_V1';

const text = value => String(value ?? '').trim();
const numberOrNull = value => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (Object.is(parsed, -0) ? 0 : parsed) : null;
};

function transactionStores() {
  return [STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS, STORE.SYNC_QUEUE, STORE.META];
}

async function bundlesInTransaction(tx) {
  const [orders, items] = await Promise.all([
    requestToPromise(tx.objectStore(STORE.ORDERS).getAll()),
    requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).getAll())
  ]);
  const itemsByOrder = new Map();
  items.forEach(item => {
    const rows = itemsByOrder.get(item.orderId) || [];
    rows.push(item);
    itemsByOrder.set(item.orderId, rows);
  });
  return orders.map(order => ({ order, items: itemsByOrder.get(order.orderId) || [] }));
}

export async function loadActualOrderBundles() {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS], 'readonly');
  const bundles = await bundlesInTransaction(tx);
  await transactionDone(tx);
  return bundles;
}

export async function inspectShoppingOrderCandidates(candidates = [], options = {}) {
  const bundles = await loadActualOrderBundles();
  return planShoppingOrderDuplicates(candidates, bundles, options);
}

function comparableExistingBundles(bundles, signature, defaultCompanyId) {
  return bundles.flatMap(bundle => {
    try {
      const comparable = orderBundleToShoppingCandidate(bundle, defaultCompanyId);
      return canonicalShoppingOrderSignature(comparable) === signature ? [bundle] : [];
    } catch (_) {
      return [];
    }
  }).sort((left, right) =>
    String(left.order?.createdAt || '').localeCompare(String(right.order?.createdAt || ''))
    || String(left.order?.orderId || '').localeCompare(String(right.order?.orderId || '')));
}

async function allocateOrderNo(tx, orderDate) {
  const dateKey = orderDateKey(orderDate);
  const counterKey = `orderNoSequence:${dateKey}`;
  const metaStore = tx.objectStore(STORE.META);
  const orderStore = tx.objectStore(STORE.ORDERS);
  const [counter, existing] = await Promise.all([
    requestToPromise(metaStore.get(counterKey)),
    requestToPromise(orderStore.index('byOrderNo').getAll())
  ]);
  const highestExisting = existing.reduce((highest, order) =>
    Math.max(highest, orderSequenceFromNo(order.orderNo, dateKey)), 0);
  const sequence = Math.max(Number(counter?.value) || 0, highestExisting) + 1;
  metaStore.put({ key: counterKey, value: sequence, updatedAt: nowIso() });
  return formatOrderNo(dateKey, sequence);
}

function mappedOrderStatus(candidate) {
  const statuses = new Set((candidate.sourceStatuses || []).map(value => text(value).normalize('NFKC').toLowerCase()));
  if ([...statuses].some(value => /취소|cancel/.test(value))) return 'FULL_CANCEL';
  if ([...statuses].some(value => /완료|complete/.test(value))) return 'COMPLETED';
  if ([...statuses].some(value => /배송|shipping/.test(value))) return 'SHIPPING';
  if ([...statuses].some(value => /준비|prepar/.test(value))) return 'PREPARING';
  if ([...statuses].some(value => /입금|paid/.test(value))) return 'PAID';
  return 'ORDER';
}

function orderItems(candidate, orderId, timestamp) {
  return (candidate.items || []).map((source, index) => {
    const quantity = numberOrNull(source.quantity ?? source.finalQuantity ?? source.rawQuantity);
    const unitPrice = numberOrNull(source.unitPrice ?? source.price);
    const amount = numberOrNull(source.amount ?? source.supplyAmount);
    const productId = text(source.productId || source.masterProductId) || null;
    const itemCode = text(source.itemCode || source.productCode || source.sourceProductCode);
    const itemName = text(source.itemName || source.productName);
    return {
      orderItemId: newId('OI'),
      orderId,
      lineNo: index + 1,
      productId,
      itemCode,
      sourceProductCode: text(source.sourceProductCode || source.itemCode || source.productCode),
      itemName,
      specification: text(source.specification),
      rawText: text(source.rawText || itemName),
      rawQuantity: quantity,
      rawUnit: text(source.rawUnit ?? source.unit ?? source.finalUnit),
      finalQuantity: quantity,
      finalUnit: text(source.unit ?? source.finalUnit ?? source.rawUnit),
      boxQuantity: numberOrNull(source.boxQuantity),
      price: unitPrice,
      priceType: text(source.priceType || 'SHOPPING_SOURCE'),
      supplyAmount: amount,
      vatAmount: numberOrNull(source.vatAmount),
      memo: text(source.memo),
      description: text(source.description),
      noticePrice: numberOrNull(source.noticePrice),
      matchStatus: productId && itemCode && itemName ? 'MATCHED' : 'MATCH_FAILED',
      matchSource: productId ? 'SHOPPING_SOURCE_PRODUCT_MATCH' : 'SHOPPING_SOURCE_UNRESOLVED',
      sourceLineKey: `${candidate.candidateId || 'SHOPPING'}:${index + 1}`,
      shoppingSourceEvidence: cloneShoppingEvidence(candidate.sourceRows?.[index] || null),
      updatedAt: timestamp,
      createdAt: timestamp
    };
  });
}

function sumAmounts(items) {
  const supplyAmountTotal = items.reduce((sum, item) => sum + Number(item.supplyAmount ?? 0), 0);
  const vatAmountTotal = items.reduce((sum, item) => sum + Number(item.vatAmount ?? 0), 0);
  return { supplyAmountTotal, vatAmountTotal, orderAmount: supplyAmountTotal + vatAmountTotal };
}

function addQueue(tx, entityType, entityId, revision, payload, timestamp) {
  const record = {
    queueId: newId('SQ'),
    entityType,
    entityId,
    operation: 'UPSERT',
    revision,
    baseRevision: 0,
    payload,
    status: 'PENDING',
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return requestToPromise(tx.objectStore(STORE.SYNC_QUEUE).add(record));
}

function repositoryIssue(code, message, detail = {}) {
  return { code, message, ...detail };
}

function candidateSaveIssues(candidate) {
  return validateShoppingOrderCandidate(candidate);
}

function duplicateResult(decision, existingBundle, existingCount, reason = 'ACTUAL_LEDGER_COUNT') {
  return {
    candidateId: decision.candidateId,
    status: 'DUPLICATE',
    isDuplicate: true,
    canonicalSignature: decision.canonicalSignature,
    occurrenceNo: decision.occurrenceNo,
    existingCount,
    existingOrderId: existingBundle?.order?.orderId || '',
    existingOrderNo: existingBundle?.order?.orderNo || '',
    reason,
    writes: 0
  };
}

async function findSourceOrder(sourceMessageKey) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.ORDERS, STORE.ORDER_ITEMS], 'readonly');
  const order = await requestToPromise(tx.objectStore(STORE.ORDERS).index('bySourceMessageKey').get(sourceMessageKey));
  const items = order
    ? await requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).index('byOrderId').getAll(order.orderId))
    : [];
  await transactionDone(tx);
  return order ? { order, items } : null;
}

export async function commitShoppingOrderCandidate(decision, options = {}) {
  const candidate = decision?.candidate || {};
  const saveIssues = candidateSaveIssues(candidate);
  if (decision?.status === 'REVIEW_REQUIRED' || decision?.isDuplicate === null || saveIssues.length) {
    return {
      candidateId: decision?.candidateId || candidate.candidateId || '',
      status: 'REVIEW_REQUIRED',
      isDuplicate: null,
      issues: saveIssues,
      writes: 0
    };
  }
  const signature = canonicalShoppingOrderSignature(candidate);
  if (signature !== decision.canonicalSignature) {
    return {
      candidateId: decision.candidateId,
      status: 'REVIEW_REQUIRED',
      isDuplicate: null,
      issues: [repositoryIssue('SHOPPING_CANDIDATE_CHANGED', '분석 후 주문 후보 내용이 변경되었습니다.')],
      writes: 0
    };
  }
  const occurrenceNo = Number(decision.occurrenceNo);
  const sourceMessageKey = shoppingSourceMessageKey(signature, occurrenceNo);
  const defaultCompanyId = text(options.defaultCompanyId || 'ONEAPP');
  const db = await openOrderQDb();
  const tx = db.transaction(transactionStores(), 'readwrite');
  try {
    const orderStore = tx.objectStore(STORE.ORDERS);
    const bySource = await requestToPromise(orderStore.index('bySourceMessageKey').get(sourceMessageKey));
    const bundles = await bundlesInTransaction(tx);
    const invalidLedgerConflicts = findInvalidExistingLedgerConflicts(candidate, bundles, defaultCompanyId);
    if (invalidLedgerConflicts.length) {
      await transactionDone(tx);
      return {
        candidateId: decision.candidateId,
        status: 'REVIEW_REQUIRED',
        isDuplicate: null,
        canonicalSignature: signature,
        occurrenceNo,
        issues: [repositoryIssue(
          'EXISTING_LEDGER_BUNDLE_INVALID',
          '같은 주문일 가능성이 있는 기존 ORDER Q 주문·품목을 안전하게 판정할 수 없습니다.',
          { existingOrderIds: invalidLedgerConflicts.map(conflict => conflict.orderId).filter(Boolean) }
        )],
        writes: 0
      };
    }
    const matching = comparableExistingBundles(bundles, signature, defaultCompanyId);
    if (bySource) {
      const linked = bundles.find(bundle => bundle.order.orderId === bySource.orderId) || { order: bySource, items: [] };
      if (canonicalShoppingOrderSignature(orderBundleToShoppingCandidate(linked, defaultCompanyId)) !== signature) {
        throw new Error('SHOPPING_SOURCE_KEY_SIGNATURE_CONFLICT');
      }
      await transactionDone(tx);
      return duplicateResult(decision, linked, matching.length, 'SOURCE_MESSAGE_KEY');
    }
    if (occurrenceNo <= matching.length) {
      const existing = matching[occurrenceNo - 1] || matching[matching.length - 1];
      await transactionDone(tx);
      return duplicateResult(decision, existing, matching.length);
    }
    if (occurrenceNo !== matching.length + 1) {
      await transactionDone(tx);
      return {
        candidateId: decision.candidateId,
        status: 'REVIEW_REQUIRED',
        isDuplicate: null,
        canonicalSignature: signature,
        occurrenceNo,
        existingCount: matching.length,
        issues: [repositoryIssue(
          'SHOPPING_OCCURRENCE_GAP',
          '같은 주문 내용의 앞선 occurrence 저장 결과를 확인해야 합니다.',
          { expectedOccurrenceNo: matching.length + 1, actualOccurrenceNo: occurrenceNo }
        )],
        writes: 0
      };
    }

    const timestamp = nowIso();
    const orderId = newId('ORD');
    const orderDate = text(candidate.orderDate || candidate.deliveryDate || candidate.deliveryExpectedDate);
    const orderNo = await allocateOrderNo(tx, orderDate);
    const items = orderItems(candidate, orderId, timestamp);
    const orderStatus = mappedOrderStatus(candidate);
    const matchedCount = items.filter(item => item.matchStatus === 'MATCHED').length;
    const matchingStatus = matchedCount === items.length ? 'CONFIRMED' : (matchedCount ? 'PARTIAL' : 'MATCH_FAILED');
    const sourceEvidence = cloneShoppingEvidence(candidate.sourceEvidence || {
      schemaVersion: SHOPPING_ORDER_SOURCE_SCHEMA,
      headers: [],
      rows: candidate.sourceRows || []
    });
    const order = {
      orderId,
      orderNo,
      revision: 1,
      companyId: text(candidate.companyId || defaultCompanyId),
      orderDate,
      deliveryExpectedDate: text(candidate.deliveryDate || candidate.deliveryExpectedDate),
      customerId: text(candidate.customerId),
      customerName: text(candidate.customerName),
      customerCode: text(candidate.customerCode),
      warehouseId: text(candidate.warehouseId),
      warehouseCode: text(candidate.warehouseCode),
      warehouseName: text(candidate.warehouseName),
      warehouse: text(candidate.warehouseName || candidate.warehouseCode),
      orderMessage: '',
      transactionType: text(candidate.transactionType),
      sourceType: 'SHOPPING_MALL_ORIGINAL',
      sourceId: text(candidate.sourceId || sourceEvidence.fileName),
      sourceMessageKey,
      sourceDocumentKey: '',
      externalOrderNo: '',
      externalOriginalStatus: (candidate.sourceStatuses || []).join(' / '),
      orderStatus,
      adminStatus: 'UNCHECKED',
      opsStatus: 'ACTIVE',
      inputChannel: 'SHOPPING_MALL',
      assigneeId: '',
      assigneeName: '',
      status: orderStatus === 'FULL_CANCEL' ? 'CANCELLED' : matchingStatus,
      matchingStatus: orderStatus === 'FULL_CANCEL' ? 'CANCELLED' : matchingStatus,
      ...sumAmounts(items),
      matchedCount,
      matchFailedCount: items.length - matchedCount,
      shoppingOrderDedupe: {
        schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA,
        canonicalSignature: signature,
        canonicalBasis: canonicalShoppingOrderBasis(candidate),
        occurrenceNo,
        existingCountAtCommit: matching.length
      },
      shoppingSourceEvidence: sourceEvidence,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const event = {
      eventId: newId('OE'),
      orderId,
      revision: 1,
      eventType: 'ORDER_CREATED',
      actor: text(options.actor || candidate.actor || 'SMART_INPUT_ADMIN'),
      detail: {
        sourceType: order.sourceType,
        inputChannel: order.inputChannel,
        orderNo,
        itemCount: items.length,
        canonicalSignature: signature,
        occurrenceNo,
        existingCountAtCommit: matching.length,
        sourceEvidence: {
          schemaVersion: sourceEvidence.schemaVersion,
          fileName: sourceEvidence.fileName || '',
          sheetName: sourceEvidence.sheetName || '',
          sourceRowNumbers: (sourceEvidence.rows || []).map(row => row.sourceRowNumber)
        }
      },
      createdAt: timestamp
    };

    await requestToPromise(orderStore.add(order));
    for (const item of items) await requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).add(item));
    await requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).add(event));
    await addQueue(tx, 'ORDER', orderId, 1, { order, items }, timestamp);
    await addQueue(tx, 'ORDER_EVENT', event.eventId, 1, event, timestamp);
    await transactionDone(tx);
    return {
      candidateId: decision.candidateId,
      status: 'CREATED',
      isDuplicate: false,
      canonicalSignature: signature,
      occurrenceNo,
      existingCount: matching.length,
      order,
      items,
      event,
      writes: 1 + items.length + 1 + 2
    };
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    if (error?.name === 'ConstraintError' || /constraint/i.test(String(error?.message || error))) {
      const linked = await findSourceOrder(sourceMessageKey);
      if (linked && canonicalShoppingOrderSignature(orderBundleToShoppingCandidate(linked, defaultCompanyId)) === signature) {
        return duplicateResult(decision, linked, occurrenceNo, 'DUPLICATE_KEY_RACE');
      }
    }
    throw error;
  }
}

export async function commitShoppingOrderCandidates(candidates = [], options = {}) {
  const initialPlan = await inspectShoppingOrderCandidates(candidates, options);
  const results = [];
  for (const decision of initialPlan.results) {
    try {
      results.push(await commitShoppingOrderCandidate(decision, options));
    } catch (error) {
      results.push({
        candidateId: decision.candidateId,
        status: 'FAILED',
        isDuplicate: null,
        code: text(error?.code || error?.name || 'SHOPPING_ORDER_COMMIT_FAILED'),
        message: text(error?.message || error),
        writes: 0
      });
    }
  }
  return {
    schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA,
    repositoryVersion: SHOPPING_ORDER_IMPORT_REPOSITORY_VERSION,
    results,
    summary: {
      candidateCount: results.length,
      createdCount: results.filter(result => result.status === 'CREATED').length,
      duplicateCount: results.filter(result => result.isDuplicate === true).length,
      reviewRequiredCount: results.filter(result => result.status === 'REVIEW_REQUIRED').length,
      failedCount: results.filter(result => result.status === 'FAILED').length
    }
  };
}
