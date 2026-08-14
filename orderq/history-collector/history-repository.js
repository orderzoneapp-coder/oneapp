import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone,
  getAll,
  getByKey,
  newId,
  nowIso,
  normalizeText
} from '../orderq-db.js?v=0.5.1';
import { resolveWarehouseInTransaction, warehouseSnapshot } from '../warehouse-master.js?v=0.5.1';
import { COLLECTOR_SOURCE } from './collector-schema.js?v=0.5.1';
import { buildFulfillmentLinks } from './fulfillment-matcher.js?v=0.5.1';
import { buildParserEvidence } from './parser-evidence.js?v=0.5.1';
import { deactivateEvidenceMapping, reconcileEvidenceMappings } from './mapping-lifecycle.js?v=0.5.1';

const DEFAULT_SETTINGS = Object.freeze({
  key: 'ACTIVE',
  cutoffHour: 12,
  cutoffMinute: 0,
  holidays: [],
  updatedAt: ''
});

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableId(prefix, parts) {
  return `${prefix}-${stableHash(parts.join('|'))}`;
}

function queueRow(entityType, entityId, payload, revision = 1) {
  const timestamp = nowIso();
  return {
    queueId: newId('SQ'), entityType, entityId, operation: 'UPSERT', revision,
    baseRevision: 0, payload, status: 'PENDING', createdAt: timestamp, updatedAt: timestamp
  };
}

function rowFingerprint(sourceType, normalized, rowNo) {
  const values = [
    sourceType,
    normalized.orderDate || normalized.salesDate || normalized.purchaseDate || normalized.basisDate || normalized.transactionDate || '',
    normalized.documentNo || '',
    normalized.customerName || normalized.supplierName || '',
    normalized.productCode || '',
    normalized.productName || '',
    normalized.warehouseId || normalized.warehouseCode || normalized.warehouseName || '',
    normalized.quantity ?? normalized.inventoryQuantity ?? '',
    normalized.unitPrice ?? normalized.unitCost ?? '',
    rowNo
  ];
  return stableHash(values.join('|'));
}

function customerShape(name, role, timestamp) {
  const normalizedName = normalizeText(name);
  return {
    customerId: stableId('CUS-HIST', [normalizedName]),
    customerName: String(name || '').trim(),
    normalizedName,
    erpCustomerCode: '',
    roles: [role],
    status: 'ACTIVE',
    source: 'HISTORY_COLLECTOR',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function productShape(row, timestamp) {
  const productCode = String(row.productCode || '').trim();
  const productName = String(row.productName || row.rawExpression || '').trim();
  return {
    productId: productCode ? `PRD-${productCode}` : stableId('PRD-HIST', [normalizeText(productName), normalizeText(row.specification)]),
    itemCode: productCode,
    itemName: productName,
    normalizedName: normalizeText(productName),
    specification: String(row.specification || '').trim(),
    unit: String(row.unit || row.rawUnit || '').trim(),
    source: 'HISTORY_COLLECTOR',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function existingActiveBatchByHash(fileHash) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.IMPORT_BATCHES, 'readonly');
  const rows = await requestToPromise(tx.objectStore(STORE.IMPORT_BATCHES).index('byFileHash').getAll(fileHash));
  await transactionDone(tx);
  return rows.find(row => row.status === 'COMMITTED') || null;
}

async function putCustomerAndProduct(tx, row, role, timestamp) {
  const customerName = String(row.customerName || row.supplierName || '').trim();
  let customer = null;
  if (customerName) {
    const store = tx.objectStore(STORE.CUSTOMERS);
    const candidate = customerShape(customerName, role, timestamp);
    customer = await requestToPromise(store.index('byName').get(candidate.normalizedName));
    if (customer) {
      const roles = [...new Set([...(customer.roles || []), role])];
      customer = { ...customer, roles, updatedAt: timestamp };
      store.put(customer);
    } else {
      customer = candidate;
      store.put(customer);
    }
  }
  let product = null;
  if (row.productCode || row.productName || row.rawExpression) {
    const store = tx.objectStore(STORE.PRODUCTS);
    const candidate = productShape(row, timestamp);
    product = row.productCode ? await requestToPromise(store.index('byCode').get(String(row.productCode))) : null;
    if (!product && candidate.normalizedName) product = await requestToPromise(store.index('byName').get(candidate.normalizedName));
    if (!product) {
      product = candidate;
      store.put(product);
    }
  }
  return { customer, product };
}

function groupKey(row, fields) {
  return fields.map(field => String(row[field] ?? '').trim()).join('|');
}

export async function commitPreparedImport(prepared, importedBy = 'administrator') {
  if (!prepared?.fileHash || !prepared?.sourceType || !Array.isArray(prepared.rows)) throw new Error('수집 확정 자료가 올바르지 않습니다.');
  const duplicate = await existingActiveBatchByHash(prepared.fileHash);
  if (duplicate) return { duplicate: true, importBatch: duplicate, inserted: 0, skipped: prepared.rows.length };

  const timestamp = nowIso();
  const importBatchId = newId('IB');
  const batch = {
    importBatchId,
    sourceType: prepared.sourceType,
    fileName: String(prepared.fileName || ''),
    fileHash: prepared.fileHash,
    fileSize: Number(prepared.fileSize || 0),
    sheetName: String(prepared.sheetName || ''),
    headerRowNo: Number(prepared.headerRowNo || 0),
    rowCount: prepared.rows.length,
    importedAt: timestamp,
    importedBy,
    status: 'COMMITTED',
    warnings: prepared.warnings || [],
    version: 1,
    updatedAt: timestamp
  };

  const stores = [
    STORE.IMPORT_BATCHES, STORE.SOURCE_RECORDS, STORE.CUSTOMERS, STORE.PRODUCTS,
    STORE.WAREHOUSES, STORE.WAREHOUSE_ALIASES,
    STORE.SALES_DOCUMENTS, STORE.SALES_LINES, STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES,
    STORE.LEDGER_DOCUMENTS, STORE.LEDGER_LINES, STORE.INVENTORY_SNAPSHOTS, STORE.INVENTORY_LINES,
    STORE.HISTORICAL_ORDER_GROUPS, STORE.HISTORICAL_ORDER_LINES, STORE.SYNC_QUEUE
  ];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readwrite');
  tx.objectStore(STORE.IMPORT_BATCHES).put(batch);
  const existingFingerprints = new Set((await requestToPromise(tx.objectStore(STORE.SOURCE_RECORDS).getAll())).filter(row => !row.disabledAt).map(row => row.rowFingerprint));
  const documentCache = new Map();
  const queuedReferences = new Set();
  const enqueueOnce = (entityType, entityId, payload) => {
    const key = `${entityType}:${entityId}`;
    if (queuedReferences.has(key)) return;
    queuedReferences.add(key);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow(entityType, entityId, payload));
  };
  let inserted = 0;
  let skipped = 0;

  for (const sourceRow of prepared.rows) {
    const row = { ...(sourceRow.normalizedRecord || {}) };
    const fingerprint = rowFingerprint(prepared.sourceType, row, sourceRow.rowNo);
    if (existingFingerprints.has(fingerprint)) { skipped += 1; continue; }
    existingFingerprints.add(fingerprint);
    const sourceRecordId = newId('SRC');
    const sourceRecord = {
      sourceRecordId, importBatchId, sourceType: prepared.sourceType,
      fileName: batch.fileName, fileHash: batch.fileHash, sheetName: batch.sheetName,
      rowNo: sourceRow.rowNo, sourceRowNo: sourceRow.sourceRowNo || sourceRow.rowNo,
      warehouseColumnIndex: sourceRow.warehouseColumnIndex ?? null, rowFingerprint: fingerprint,
      rawRecord: sourceRow.rawRecord || {}, normalizedRecord: row,
      status: 'ACTIVE', importedAt: timestamp, importedBy
    };
    tx.objectStore(STORE.SOURCE_RECORDS).put(sourceRecord);
    enqueueOnce('SOURCE_RECORD', sourceRecordId, sourceRecord);
    inserted += 1;

    const warehouseInput = {
      warehouseId: row.warehouseId || '',
      warehouseCode: row.warehouseCode || prepared.defaultWarehouseCode || '',
      warehouseName: row.warehouseName || ((prepared.sourceType === COLLECTOR_SOURCE.ORDER) ? row.groupName : '') || '',
      warehouse: row.warehouse || ''
    };
    const warehouse = await resolveWarehouseInTransaction(tx, warehouseInput, {
      sourceType: prepared.sourceType,
      sourceId: sourceRecordId
    });
    const warehouseFields = warehouse ? warehouseSnapshot(warehouseInput, warehouse) : {};

    if (prepared.sourceType === COLLECTOR_SOURCE.SALES) {
      const { customer, product } = await putCustomerAndProduct(tx, row, 'CUSTOMER', timestamp);
      if (customer) enqueueOnce('CUSTOMER', customer.customerId, customer);
      if (product) enqueueOnce('PRODUCT', product.productId, product);
      const key = groupKey(row, ['salesDate', 'customerName', 'documentNo', 'warehouseCode']);
      let document = documentCache.get(key);
      if (!document) {
        document = {
          salesDocumentId: stableId('SD', [importBatchId, key]), importBatchId,
          salesDate: row.salesDate || prepared.defaultDate || '', salesTime: row.salesTime || '',
          customerId: customer?.customerId || '', customerName: row.customerName || '',
          normalizedCustomerName: normalizeText(row.customerName), documentNo: row.documentNo || '',
          ...warehouseFields, sourceRecordIds: [], status: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp
        };
        documentCache.set(key, document);
      }
      document.sourceRecordIds.push(sourceRecordId);
      tx.objectStore(STORE.SALES_DOCUMENTS).put(document);
      const line = {
        salesLineId: stableId('SL', [importBatchId, sourceRow.rowNo]), salesDocumentId: document.salesDocumentId, importBatchId, sourceRecordId,
        productId: product?.productId || '', productCode: row.productCode || '', productName: row.productName || '', specification: row.specification || '',
        quantity: Number(row.quantity || 0), unitPrice: row.unitPrice, amount: row.amount, note: row.note || '', shippingInstruction: row.shippingInstruction || '',
        purchasePlace: row.purchasePlace || '', status: Number(row.quantity || 0) < 0 ? 'REVERSAL' : 'ACTIVE', createdAt: timestamp, updatedAt: timestamp
      };
      tx.objectStore(STORE.SALES_LINES).put(line);
      enqueueOnce('SALES_LINE', line.salesLineId, line);
    } else if (prepared.sourceType === COLLECTOR_SOURCE.PURCHASE) {
      const { customer: supplier, product } = await putCustomerAndProduct(tx, row, 'SUPPLIER', timestamp);
      if (supplier) enqueueOnce('CUSTOMER', supplier.customerId, supplier);
      if (product) enqueueOnce('PRODUCT', product.productId, product);
      const key = groupKey(row, ['purchaseDate', 'supplierName', 'documentNo', 'warehouseCode', 'purchaseFor']);
      let document = documentCache.get(key);
      if (!document) {
        document = {
          purchaseDocumentId: stableId('PD', [importBatchId, key]), importBatchId,
          purchaseDate: row.purchaseDate || prepared.defaultDate || '', purchaseTime: row.purchaseTime || '',
          supplierId: supplier?.customerId || '', supplierName: row.supplierName || '', normalizedSupplierName: normalizeText(row.supplierName),
          documentNo: row.documentNo || '', ...warehouseFields, purchaseFor: row.purchaseFor || '',
          sourceRecordIds: [], status: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp
        };
        documentCache.set(key, document);
      }
      document.sourceRecordIds.push(sourceRecordId);
      tx.objectStore(STORE.PURCHASE_DOCUMENTS).put(document);
      const line = {
        purchaseLineId: stableId('PL', [importBatchId, sourceRow.rowNo]), purchaseDocumentId: document.purchaseDocumentId, importBatchId, sourceRecordId,
        productId: product?.productId || '', productCode: row.productCode || '', productName: row.productName || '', specification: row.specification || '',
        quantity: Number(row.quantity || 0), unitPrice: row.unitPrice, amount: row.amount, note: row.note || '',
        status: Number(row.quantity || 0) < 0 ? 'REVERSAL' : 'ACTIVE', createdAt: timestamp, updatedAt: timestamp
      };
      tx.objectStore(STORE.PURCHASE_LINES).put(line);
      enqueueOnce('PURCHASE_LINE', line.purchaseLineId, line);
    } else if (prepared.sourceType === COLLECTOR_SOURCE.INVENTORY) {
      const { product } = await putCustomerAndProduct(tx, row, 'SUPPLIER', timestamp);
      if (product) enqueueOnce('PRODUCT', product.productId, product);
      const basisDate = row.basisDate || prepared.defaultDate || '';
      const key = groupKey({ basisDate, warehouseId: warehouse?.warehouseId || '', warehouseCode: row.warehouseCode || prepared.defaultWarehouseCode || '' }, ['basisDate', 'warehouseId', 'warehouseCode']);
      let snapshot = documentCache.get(key);
      if (!snapshot) {
        snapshot = {
          inventorySnapshotId: stableId('IS', [importBatchId, key]), importBatchId, basisDate,
          ...warehouseFields, sourceRecordIds: [], status: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp
        };
        documentCache.set(key, snapshot);
      }
      snapshot.sourceRecordIds.push(sourceRecordId);
      tx.objectStore(STORE.INVENTORY_SNAPSHOTS).put(snapshot);
      const line = {
        inventoryLineId: stableId('IL', [importBatchId, sourceRow.rowNo, warehouse?.warehouseId || '']), inventorySnapshotId: snapshot.inventorySnapshotId, importBatchId, sourceRecordId,
        productId: product?.productId || '', productCode: row.productCode || '', productName: row.productName || '', specification: row.specification || '', unit: row.unit || '',
        ...warehouseFields, inventoryQuantity: Number(row.inventoryQuantity || 0), inventoryTotal: row.inventoryTotal,
        warehouseSourceHeader: row.warehouseSourceHeader || '', warehouseSourceBlank: Boolean(row.warehouseSourceBlank),
        recordedDate: row.recordedDate || '', supplierName: row.supplierName || '', unitCost: row.unitCost,
        note: row.note || '', status: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp
      };
      tx.objectStore(STORE.INVENTORY_LINES).put(line);
      enqueueOnce('INVENTORY_LINE', line.inventoryLineId, line);
    } else if (prepared.sourceType === COLLECTOR_SOURCE.CUSTOMER_LEDGER) {
      const { customer, product } = await putCustomerAndProduct(tx, row, 'BOTH', timestamp);
      if (customer) enqueueOnce('CUSTOMER', customer.customerId, customer);
      if (product) enqueueOnce('PRODUCT', product.productId, product);
      const key = groupKey(row, ['transactionDate', 'customerName', 'documentNo', 'transactionType']);
      let document = documentCache.get(key);
      if (!document) {
        document = {
          ledgerDocumentId: stableId('LD', [importBatchId, key]), importBatchId, transactionDate: row.transactionDate || prepared.defaultDate || '',
          customerId: customer?.customerId || '', customerName: row.customerName || '', normalizedCustomerName: normalizeText(row.customerName),
          transactionType: row.transactionType || 'UNKNOWN', documentNo: row.documentNo || '', sourceRecordIds: [], status: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp
        };
        documentCache.set(key, document);
      }
      document.sourceRecordIds.push(sourceRecordId);
      tx.objectStore(STORE.LEDGER_DOCUMENTS).put(document);
      const line = {
        ledgerLineId: stableId('LL', [importBatchId, sourceRow.rowNo]), ledgerDocumentId: document.ledgerDocumentId, importBatchId, sourceRecordId,
        productId: product?.productId || '', productCode: row.productCode || '', productName: row.productName || '', specification: row.specification || '',
        quantity: Number(row.quantity || 0), unitPrice: row.unitPrice, amount: row.amount, note: row.note || '', status: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp
      };
      tx.objectStore(STORE.LEDGER_LINES).put(line);
      enqueueOnce('LEDGER_LINE', line.ledgerLineId, line);
    } else if (prepared.sourceType === COLLECTOR_SOURCE.ORDER || prepared.sourceType === COLLECTOR_SOURCE.KAKAO) {
      const { customer, product } = await putCustomerAndProduct(tx, row, 'CUSTOMER', timestamp);
      if (customer) enqueueOnce('CUSTOMER', customer.customerId, customer);
      if (product) enqueueOnce('PRODUCT', product.productId, product);
      const orderDate = row.orderDate || prepared.defaultDate || '';
      const key = groupKey({ ...row, orderDate }, ['orderDate', 'customerName', 'documentNo', 'groupName', 'sourceMessageKey']);
      let group = documentCache.get(key);
      if (!group) {
        group = {
          historicalOrderGroupId: stableId('HOG', [importBatchId, key]), importBatchId, sourceType: prepared.sourceType,
          orderDate, orderTime: row.orderTime || '', customerId: customer?.customerId || '', customerName: row.customerName || '',
          normalizedCustomerName: normalizeText(row.customerName), documentNo: row.documentNo || '', groupName: row.groupName || '',
          ...warehouseFields,
          sourceMessageKey: row.sourceMessageKey || '', sourceRecordIds: [], status: 'ACTIVE', createdAt: row.createdAt || timestamp, updatedAt: timestamp
        };
        documentCache.set(key, group);
      }
      group.sourceRecordIds.push(sourceRecordId);
      tx.objectStore(STORE.HISTORICAL_ORDER_GROUPS).put(group);
      const line = {
        historicalOrderLineId: stableId('HOL', [importBatchId, sourceRow.rowNo]), historicalOrderGroupId: group.historicalOrderGroupId, importBatchId, sourceRecordId,
        sourceType: prepared.sourceType, customerId: customer?.customerId || '', customerName: row.customerName || '', orderDate,
        productId: product?.productId || '', productCode: row.productCode || '', productName: row.productName || '', specification: row.specification || '',
        rawExpression: row.rawExpression || row.productName || '', rawUnit: row.rawUnit || row.unit || '', unit: row.unit || '', quantity: Number(row.quantity || 0),
        unitPrice: row.unitPrice, note: [row.note, row.note2].filter(Boolean).join(' / '), matchStatus: row.productCode ? 'MATCHED' : 'MATCH_FAILED',
        status: 'ACTIVE', createdAt: timestamp, updatedAt: timestamp
      };
      tx.objectStore(STORE.HISTORICAL_ORDER_LINES).put(line);
      enqueueOnce('HISTORICAL_ORDER_LINE', line.historicalOrderLineId, line);
    }
  }

  const documentQueueSpec = {
    [COLLECTOR_SOURCE.SALES]: ['SALES_DOCUMENT', 'salesDocumentId'],
    [COLLECTOR_SOURCE.PURCHASE]: ['PURCHASE_DOCUMENT', 'purchaseDocumentId'],
    [COLLECTOR_SOURCE.INVENTORY]: ['INVENTORY_SNAPSHOT', 'inventorySnapshotId'],
    [COLLECTOR_SOURCE.CUSTOMER_LEDGER]: ['LEDGER_DOCUMENT', 'ledgerDocumentId'],
    [COLLECTOR_SOURCE.ORDER]: ['HISTORICAL_ORDER_GROUP', 'historicalOrderGroupId'],
    [COLLECTOR_SOURCE.KAKAO]: ['HISTORICAL_ORDER_GROUP', 'historicalOrderGroupId']
  }[prepared.sourceType];
  if (documentQueueSpec) {
    documentCache.forEach(document => {
      enqueueOnce(documentQueueSpec[0], document[documentQueueSpec[1]], document);
    });
  }

  batch.insertedRowCount = inserted;
  batch.skippedRowCount = skipped;
  tx.objectStore(STORE.IMPORT_BATCHES).put(batch);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('IMPORT_BATCH', batch.importBatchId, batch));
  await transactionDone(tx);
  return { duplicate: false, importBatch: batch, inserted, skipped };
}

export async function getCollectorSettings() {
  const value = await getByKey(STORE.COLLECTOR_SETTINGS, 'ACTIVE');
  return { ...DEFAULT_SETTINGS, ...(value || {}) };
}

export async function saveCollectorSettings(input) {
  const value = {
    ...DEFAULT_SETTINGS,
    ...input,
    key: 'ACTIVE',
    cutoffHour: Math.max(0, Math.min(23, Number(input.cutoffHour ?? 12))),
    cutoffMinute: Math.max(0, Math.min(59, Number(input.cutoffMinute ?? 0))),
    holidays: [...new Set((input.holidays || []).map(value => String(value).slice(0, 10)).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort(),
    updatedAt: nowIso()
  };
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.COLLECTOR_SETTINGS, STORE.SYNC_QUEUE], 'readwrite');
  tx.objectStore(STORE.COLLECTOR_SETTINGS).put(value);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('COLLECTOR_SETTING', value.key, value));
  await transactionDone(tx);
  return value;
}

export async function rebuildFulfillmentEvidence() {
  const [orderGroups, orderLines, salesDocuments, salesLines, oldLinks, oldBalances, oldEvidence, mappings, settings] = await Promise.all([
    getAll(STORE.HISTORICAL_ORDER_GROUPS), getAll(STORE.HISTORICAL_ORDER_LINES), getAll(STORE.SALES_DOCUMENTS), getAll(STORE.SALES_LINES),
    getAll(STORE.FULFILLMENT_LINKS), getAll(STORE.FULFILLMENT_BALANCES), getAll(STORE.PARSER_EVIDENCE), getAll(STORE.PRODUCT_MAPPINGS), getCollectorSettings()
  ]);
  const manualLinks = oldLinks.filter(row => row.active !== false && ['CONFIRM', 'BLOCK'].includes(row.manualAction));
  const result = buildFulfillmentLinks({ orderGroups, orderLines, salesDocuments, salesLines, settings, manualLinks });
  const createdAt = nowIso();
  result.links = result.links.map(link => ({ ...link, active: true, createdAt, updatedAt: createdAt }));
  result.balances = result.balances.map(balance => ({ ...balance, active: true, calculatedAt: createdAt, updatedAt: createdAt }));
  const evidence = buildParserEvidence({ links: result.links, orderLines, salesLines }).map(row => {
    const previous = row.status === 'READY_FOR_ADMIN_CONFIRMATION'
      ? oldEvidence.find(item => item.parserEvidenceId === row.parserEvidenceId && item.status === 'ADMIN_CONFIRMED' && item.active !== false)
      : null;
    return previous
      ? { ...row, status: 'ADMIN_CONFIRMED', confirmedAt: previous.confirmedAt, confirmedBy: previous.confirmedBy, active: true, createdAt: previous.createdAt || createdAt, updatedAt: createdAt }
      : { ...row, active: true, createdAt, updatedAt: createdAt };
  });
  const activeLinkIds = new Set(result.links.map(row => row.fulfillmentLinkId));
  const activeBalanceIds = new Set(result.balances.map(row => row.fulfillmentBalanceId));
  const activeEvidenceIds = new Set(evidence.map(row => row.parserEvidenceId));
  const mappingUpdates = reconcileEvidenceMappings({ mappings, evidence, timestamp: createdAt });
  const db = await openOrderQDb();
  const tx = db.transaction([
    STORE.FULFILLMENT_LINKS, STORE.FULFILLMENT_BALANCES, STORE.PARSER_EVIDENCE,
    STORE.PRODUCT_MAPPINGS, STORE.MAPPING_EVENTS, STORE.SYNC_QUEUE
  ], 'readwrite');
  oldLinks.filter(row => row.active !== false && !activeLinkIds.has(row.fulfillmentLinkId)).forEach(row => {
    const next = { ...row, active: false, invalidatedAt: createdAt, updatedAt: createdAt };
    tx.objectStore(STORE.FULFILLMENT_LINKS).put(next);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('FULFILLMENT_LINK', next.fulfillmentLinkId, next));
  });
  oldBalances.filter(row => row.active !== false && !activeBalanceIds.has(row.fulfillmentBalanceId)).forEach(row => {
    const next = { ...row, active: false, invalidatedAt: createdAt, updatedAt: createdAt };
    tx.objectStore(STORE.FULFILLMENT_BALANCES).put(next);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('FULFILLMENT_BALANCE', next.fulfillmentBalanceId, next));
  });
  oldEvidence.filter(row => row.active !== false && !activeEvidenceIds.has(row.parserEvidenceId)).forEach(row => {
    const next = { ...row, active: false, invalidatedAt: createdAt, updatedAt: createdAt };
    tx.objectStore(STORE.PARSER_EVIDENCE).put(next);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('PARSER_EVIDENCE', next.parserEvidenceId, next));
  });
  result.links.forEach(row => {
    tx.objectStore(STORE.FULFILLMENT_LINKS).put(row);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('FULFILLMENT_LINK', row.fulfillmentLinkId, row));
  });
  result.balances.forEach(row => {
    tx.objectStore(STORE.FULFILLMENT_BALANCES).put(row);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('FULFILLMENT_BALANCE', row.fulfillmentBalanceId, row));
  });
  evidence.forEach(row => {
    tx.objectStore(STORE.PARSER_EVIDENCE).put(row);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('PARSER_EVIDENCE', row.parserEvidenceId, row));
  });
  mappingUpdates.forEach(mapping => {
    tx.objectStore(STORE.PRODUCT_MAPPINGS).put(mapping);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('PRODUCT_MAPPING', mapping.mappingId, mapping));
    const event = {
      eventId: newId('ME'), eventType: 'EVIDENCE_REVIEW_REQUIRED', customerId: mapping.customerId || '', productId: mapping.productId || '',
      mappingId: mapping.mappingId, parserEvidenceId: mapping.evidenceId || '', before: 'ACTIVE', after: 'REVIEW_REQUIRED',
      reason: mapping.reviewReason, createdAt, createdBy: 'system'
    };
    tx.objectStore(STORE.MAPPING_EVENTS).put(event);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('MAPPING_EVENT', event.eventId, event));
  });
  await transactionDone(tx);
  return { ...result, evidence, mappingUpdates };
}

export async function confirmFulfillmentLink(fulfillmentLinkId, confirmedBy = 'administrator') {
  const link = await getByKey(STORE.FULFILLMENT_LINKS, fulfillmentLinkId);
  if (!link?.historicalOrderLineId || !link?.salesLineId) throw new Error('확정할 주문·판매 연결이 없습니다.');
  const timestamp = nowIso();
  const next = {
    ...link,
    status: 'CONFIRMED', manualAction: 'CONFIRM', requiresReview: false,
    requestedQuantity: Math.abs(Number(link.allocatedQuantity || 0)), confirmedAt: timestamp, confirmedBy, active: true, updatedAt: timestamp
  };
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.FULFILLMENT_LINKS, STORE.SYNC_QUEUE], 'readwrite');
  tx.objectStore(STORE.FULFILLMENT_LINKS).put(next);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('FULFILLMENT_LINK', next.fulfillmentLinkId, next));
  await transactionDone(tx);
  return rebuildFulfillmentEvidence();
}

export async function replaceFulfillmentLink(fulfillmentLinkId, salesLineId, confirmedBy = 'administrator') {
  const [link, salesLine] = await Promise.all([
    getByKey(STORE.FULFILLMENT_LINKS, fulfillmentLinkId),
    getByKey(STORE.SALES_LINES, salesLineId)
  ]);
  if (!link?.historicalOrderLineId || !link?.salesLineId) throw new Error('변경할 기존 연결이 없습니다.');
  if (!salesLine || Number(salesLine.quantity || 0) <= 0) throw new Error('선택한 판매행은 양수 판매자료가 아닙니다.');
  const orderLine = await getByKey(STORE.HISTORICAL_ORDER_LINES, link.historicalOrderLineId);
  if (!orderLine) throw new Error('연결할 주문행이 없습니다.');
  const timestamp = nowIso();
  const blocked = {
    ...link, status: 'UNLINKED', method: 'ADMIN_UNLINKED', manualAction: 'BLOCK', manualReason: 'REPLACED_BY_ADMIN',
    requestedQuantity: 0, allocatedQuantity: 0, requiresReview: false, confirmedAt: '', confirmedBy: '', active: true, updatedAt: timestamp
  };
  const replacementId = stableId('FL-MANUAL', [link.historicalOrderLineId, salesLineId]);
  const replacement = {
    fulfillmentLinkId: replacementId,
    historicalOrderGroupId: orderLine.historicalOrderGroupId,
    historicalOrderLineId: link.historicalOrderLineId,
    salesDocumentId: salesLine.salesDocumentId,
    salesLineId,
    allocatedQuantity: Math.min(Number(orderLine.quantity || 0), Number(salesLine.quantity || 0)),
    requestedQuantity: Math.min(Number(orderLine.quantity || 0), Number(salesLine.quantity || 0)),
    status: 'CONFIRMED', method: 'ADMIN_CONFIRMED', confidence: 100, evidence: ['ADMIN_CONFIRMED', 'REPLACED_BY_ADMIN'],
    customerId: link.customerId || orderLine.customerId || '', customerName: link.customerName || orderLine.customerName || '',
    productCode: salesLine.productCode || '', productName: salesLine.productName || '',
    manualAction: 'CONFIRM', requiresReview: false, confirmedAt: timestamp, confirmedBy, active: true, createdAt: timestamp, updatedAt: timestamp
  };
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.FULFILLMENT_LINKS, STORE.SYNC_QUEUE], 'readwrite');
  [blocked, replacement].forEach(row => {
    tx.objectStore(STORE.FULFILLMENT_LINKS).put(row);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('FULFILLMENT_LINK', row.fulfillmentLinkId, row));
  });
  await transactionDone(tx);
  return rebuildFulfillmentEvidence();
}

export async function unlinkFulfillmentLink(fulfillmentLinkId, unlinkedBy = 'administrator') {
  const link = await getByKey(STORE.FULFILLMENT_LINKS, fulfillmentLinkId);
  if (!link?.historicalOrderLineId || !link?.salesLineId) throw new Error('해제할 주문·판매 연결이 없습니다.');
  const timestamp = nowIso();
  const next = {
    ...link, status: 'UNLINKED', method: 'ADMIN_UNLINKED', manualAction: 'BLOCK', manualReason: 'UNLINKED_BY_ADMIN',
    requestedQuantity: 0, allocatedQuantity: 0, requiresReview: false, unlinkedAt: timestamp, unlinkedBy, active: true, updatedAt: timestamp
  };
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.FULFILLMENT_LINKS, STORE.SYNC_QUEUE], 'readwrite');
  tx.objectStore(STORE.FULFILLMENT_LINKS).put(next);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('FULFILLMENT_LINK', next.fulfillmentLinkId, next));
  await transactionDone(tx);
  return rebuildFulfillmentEvidence();
}

export async function confirmParserEvidence(parserEvidenceId, confirmedBy = 'administrator') {
  const evidence = await getByKey(STORE.PARSER_EVIDENCE, parserEvidenceId);
  if (!evidence || evidence.active === false) throw new Error('확정할 파서근거가 없습니다.');
  if (!evidence.productCode || evidence.status === 'CONFLICT') throw new Error('충돌 또는 상품 미확정 근거는 사전으로 확정할 수 없습니다.');
  if (evidence.status !== 'READY_FOR_ADMIN_CONFIRMATION') throw new Error('서로 다른 주문일 3회 이상의 판매근거가 있어야 관리자 확정할 수 있습니다.');
  const products = await getAll(STORE.PRODUCTS, 'byCode', evidence.productCode);
  const product = products[0];
  if (!product) throw new Error('연결할 상품 마스터가 없습니다.');
  const timestamp = nowIso();
  const mappingId = stableId('PM', [evidence.customerId || evidence.customerName, evidence.normalizedExpression, product.productId]);
  const mapping = {
    mappingId, scope: 'CUSTOMER', customerId: evidence.customerId || '', sourceId: '', normalizedText: evidence.normalizedExpression,
    rawText: evidence.rawExpressions?.[0] || '', productId: product.productId, itemCode: product.itemCode || evidence.productCode,
    itemName: product.itemName || evidence.productNames?.[0] || '', specification: product.specification || '', finalUnit: product.unit || '',
    status: 'ACTIVE', evidenceType: 'ADMIN_CONFIRMED', evidenceId: parserEvidenceId, createdAt: timestamp, updatedAt: timestamp
  };
  const nextEvidence = { ...evidence, status: 'ADMIN_CONFIRMED', confirmedAt: timestamp, confirmedBy, updatedAt: timestamp };
  const event = {
    eventId: newId('ME'), eventType: 'ADMIN_CONFIRMED', customerId: mapping.customerId, productId: mapping.productId,
    mappingId, parserEvidenceId, before: evidence.status, after: 'ADMIN_CONFIRMED', createdAt: timestamp, createdBy: confirmedBy
  };
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.PARSER_EVIDENCE, STORE.PRODUCT_MAPPINGS, STORE.MAPPING_EVENTS, STORE.SYNC_QUEUE], 'readwrite');
  tx.objectStore(STORE.PARSER_EVIDENCE).put(nextEvidence);
  tx.objectStore(STORE.PRODUCT_MAPPINGS).put(mapping);
  tx.objectStore(STORE.MAPPING_EVENTS).put(event);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('PARSER_EVIDENCE', parserEvidenceId, nextEvidence));
  tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('PRODUCT_MAPPING', mappingId, mapping));
  tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('MAPPING_EVENT', event.eventId, event));
  await transactionDone(tx);
  return { evidence: nextEvidence, mapping, event };
}

export async function cancelParserEvidenceConfirmation(parserEvidenceId, cancelledBy = 'administrator') {
  const evidence = await getByKey(STORE.PARSER_EVIDENCE, parserEvidenceId);
  if (!evidence || evidence.active === false || evidence.status !== 'ADMIN_CONFIRMED') {
    throw new Error('확정 취소할 파서근거가 없습니다.');
  }
  const mappings = (await getAll(STORE.PRODUCT_MAPPINGS))
    .filter(row => row.evidenceId === parserEvidenceId && row.evidenceType === 'ADMIN_CONFIRMED' && row.status !== 'INACTIVE');
  const timestamp = nowIso();
  const nextEvidence = {
    ...evidence,
    status: 'READY_FOR_ADMIN_CONFIRMATION',
    confirmationCancelledAt: timestamp,
    confirmationCancelledBy: cancelledBy,
    confirmedAt: '',
    confirmedBy: '',
    updatedAt: timestamp
  };
  const deactivatedMappings = mappings.map(mapping => deactivateEvidenceMapping(mapping, timestamp, cancelledBy));
  const events = deactivatedMappings.map(mapping => ({
    eventId: newId('ME'), eventType: 'ADMIN_CONFIRMATION_CANCELLED', customerId: mapping.customerId || '', productId: mapping.productId || '',
    mappingId: mapping.mappingId, parserEvidenceId, before: 'ACTIVE', after: 'INACTIVE', createdAt: timestamp, createdBy: cancelledBy
  }));
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.PARSER_EVIDENCE, STORE.PRODUCT_MAPPINGS, STORE.MAPPING_EVENTS, STORE.SYNC_QUEUE], 'readwrite');
  tx.objectStore(STORE.PARSER_EVIDENCE).put(nextEvidence);
  tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('PARSER_EVIDENCE', parserEvidenceId, nextEvidence));
  deactivatedMappings.forEach(mapping => {
    tx.objectStore(STORE.PRODUCT_MAPPINGS).put(mapping);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('PRODUCT_MAPPING', mapping.mappingId, mapping));
  });
  events.forEach(event => {
    tx.objectStore(STORE.MAPPING_EVENTS).put(event);
    tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('MAPPING_EVENT', event.eventId, event));
  });
  await transactionDone(tx);
  return { evidence: nextEvidence, mappings: deactivatedMappings, events };
}

export async function rollbackImportBatch(importBatchId, rolledBackBy = 'administrator') {
  const batch = await getByKey(STORE.IMPORT_BATCHES, importBatchId);
  if (!batch || batch.status !== 'COMMITTED') throw new Error('롤백할 활성 수집 배치가 없습니다.');
  const timestamp = nowIso();
  const storeNames = [
    STORE.IMPORT_BATCHES, STORE.SOURCE_RECORDS, STORE.SALES_DOCUMENTS, STORE.SALES_LINES,
    STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES, STORE.LEDGER_DOCUMENTS, STORE.LEDGER_LINES,
    STORE.INVENTORY_SNAPSHOTS, STORE.INVENTORY_LINES, STORE.HISTORICAL_ORDER_GROUPS, STORE.HISTORICAL_ORDER_LINES,
    STORE.SYNC_QUEUE
  ];
  const db = await openOrderQDb();
  const tx = db.transaction(storeNames, 'readwrite');
  const nextBatch = { ...batch, status: 'ROLLED_BACK', rolledBackAt: timestamp, rolledBackBy, updatedAt: timestamp };
  tx.objectStore(STORE.IMPORT_BATCHES).put(nextBatch);
  const entityByStore = {
    [STORE.SOURCE_RECORDS]: ['SOURCE_RECORD', 'sourceRecordId'],
    [STORE.SALES_DOCUMENTS]: ['SALES_DOCUMENT', 'salesDocumentId'], [STORE.SALES_LINES]: ['SALES_LINE', 'salesLineId'],
    [STORE.PURCHASE_DOCUMENTS]: ['PURCHASE_DOCUMENT', 'purchaseDocumentId'], [STORE.PURCHASE_LINES]: ['PURCHASE_LINE', 'purchaseLineId'],
    [STORE.LEDGER_DOCUMENTS]: ['LEDGER_DOCUMENT', 'ledgerDocumentId'], [STORE.LEDGER_LINES]: ['LEDGER_LINE', 'ledgerLineId'],
    [STORE.INVENTORY_SNAPSHOTS]: ['INVENTORY_SNAPSHOT', 'inventorySnapshotId'], [STORE.INVENTORY_LINES]: ['INVENTORY_LINE', 'inventoryLineId'],
    [STORE.HISTORICAL_ORDER_GROUPS]: ['HISTORICAL_ORDER_GROUP', 'historicalOrderGroupId'], [STORE.HISTORICAL_ORDER_LINES]: ['HISTORICAL_ORDER_LINE', 'historicalOrderLineId']
  };
  for (const storeName of storeNames.filter(name => ![STORE.IMPORT_BATCHES, STORE.SYNC_QUEUE].includes(name))) {
    const store = tx.objectStore(storeName);
    if (!store.indexNames.contains('byBatchId')) continue;
    const rows = await requestToPromise(store.index('byBatchId').getAll(importBatchId));
    rows.forEach(row => {
      const next = { ...row, disabledAt: timestamp, disabledReason: 'IMPORT_BATCH_ROLLBACK', updatedAt: timestamp };
      store.put(next);
      const mapping = entityByStore[storeName];
      if (mapping) tx.objectStore(STORE.SYNC_QUEUE).put(queueRow(mapping[0], next[mapping[1]], next));
    });
  }
  tx.objectStore(STORE.SYNC_QUEUE).put(queueRow('IMPORT_BATCH', importBatchId, nextBatch));
  await transactionDone(tx);
  const rebuilt = await rebuildFulfillmentEvidence();
  return { importBatch: nextBatch, rebuilt };
}

export async function getCollectorSnapshot() {
  const [batches, sourceRecords, salesDocuments, salesLines, purchaseDocuments, purchaseLines, inventorySnapshots, inventoryLines, orderGroups, orderLines, links, balances, evidence, settings] = await Promise.all([
    getAll(STORE.IMPORT_BATCHES), getAll(STORE.SOURCE_RECORDS), getAll(STORE.SALES_DOCUMENTS), getAll(STORE.SALES_LINES),
    getAll(STORE.PURCHASE_DOCUMENTS), getAll(STORE.PURCHASE_LINES), getAll(STORE.INVENTORY_SNAPSHOTS), getAll(STORE.INVENTORY_LINES),
    getAll(STORE.HISTORICAL_ORDER_GROUPS), getAll(STORE.HISTORICAL_ORDER_LINES), getAll(STORE.FULFILLMENT_LINKS), getAll(STORE.FULFILLMENT_BALANCES), getAll(STORE.PARSER_EVIDENCE), getCollectorSettings()
  ]);
  const active = rows => rows.filter(row => !row.disabledAt && row.active !== false);
  return {
    batches: batches.sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt))),
    sourceRecords: active(sourceRecords), salesDocuments: active(salesDocuments), salesLines: active(salesLines),
    purchaseDocuments: active(purchaseDocuments), purchaseLines: active(purchaseLines), inventorySnapshots: active(inventorySnapshots), inventoryLines: active(inventoryLines),
    orderGroups: active(orderGroups), orderLines: active(orderLines), links: active(links), balances: active(balances), evidence: active(evidence), settings
  };
}
