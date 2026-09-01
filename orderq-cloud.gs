/*
 * ORDER Q vNext cloud sync helpers
 * Contract: ONEAPP_ORDERQ_SYNC_V1
 *
 * This file is loaded by the same bound Apps Script project as code.gs.
 * code.gs routes orderq_sync_push / orderq_sync_pull / orderq_order_head here.
 */

const ORDERQ_SYNC_SCHEMA = 'ONEAPP_ORDERQ_SYNC_V1';
const ORDERQ_OFFICIAL_SYNC_SCHEMA = 'ONEAPP_ORDERQ_OFFICIAL_SYNC_V1';
const ORDERQ_SYNC_MAX_PUSH = 100;
const ORDERQ_SYNC_MAX_PULL = 500;
const ORDERQ_OFFICIAL_PAYLOAD_CHUNK_SIZE = 40000;
const ORDERQ_OFFICIAL_PAYLOAD_CHUNK_LIMIT = 100;
const ORDERQ_SHEET_SCHEMA_PROPERTY = 'ONEAPP_ORDERQ_SHEET_SCHEMA_VERSION';
const ORDERQ_SHEET_SCHEMA_VERSION = '4';

const ORDERQ_SHEETS = Object.freeze({
  ORDER: 'ORDER',
  ORDER_ITEM: 'ORDER_ITEM',
  ORDER_EVENT: 'ORDER_EVENT',
  CUSTOMER: 'CUSTOMER_MASTER',
  PRODUCT: 'PRODUCT_MASTER_ORDERQ',
  CUSTOMER_ALIAS: 'CUSTOMER_ALIAS_MAPPING',
  PRODUCT_MAPPING: 'PRODUCT_MAPPING',
  UNIT_MAPPING: 'UNIT_MAPPING',
  MAPPING_EVENT: 'MAPPING_EVENT',
  IMPORT_BATCH: 'IMPORT_BATCH',
  SOURCE_RECORD: 'SOURCE_RECORD',
  SALES_DOCUMENT: 'SALES_DOCUMENT',
  SALES_LINE: 'SALES_LINE',
  PURCHASE_DOCUMENT: 'PURCHASE_DOCUMENT',
  PURCHASE_LINE: 'PURCHASE_LINE',
  LEDGER_DOCUMENT: 'LEDGER_DOCUMENT',
  LEDGER_LINE: 'LEDGER_LINE',
  INVENTORY_SNAPSHOT: 'INVENTORY_SNAPSHOT',
  INVENTORY_LINE: 'INVENTORY_LINE',
  HISTORICAL_ORDER_GROUP: 'HISTORICAL_ORDER',
  HISTORICAL_ORDER_LINE: 'HISTORICAL_ORDER_LINE',
  FULFILLMENT_LINK: 'FULFILLMENT_LINK',
  FULFILLMENT_BALANCE: 'FULFILLMENT_BALANCE',
  PARSER_EVIDENCE: 'PARSER_EVIDENCE',
  COLLECTOR_SETTING: 'COLLECTOR_SETTING',
  ORDER_TXN_LOG: 'ORDER_TXN_LOG',
  SYNC_META: 'SYNC_META',
  OFFICIAL_COMMAND: 'OFFICIAL_VOUCHER_COMMAND',
  OFFICIAL_RESOLUTION: 'OFFICIAL_PRODUCT_RESOLUTION',
  OFFICIAL_HEAD: 'OFFICIAL_SYNC_HEAD',
  OFFICIAL_META: 'OFFICIAL_SYNC_META'
});

const ORDERQ_HEADERS = Object.freeze({
  ORDER: ['orderId', 'revision', 'customerId', 'orderDate', 'status', 'updatedAt', 'payloadJson'],
  ORDER_ITEM: ['orderItemId', 'orderId', 'lineNo', 'productId', 'matchStatus', 'updatedAt', 'payloadJson'],
  ORDER_EVENT: ['eventId', 'orderId', 'revision', 'eventType', 'createdAt', 'payloadJson'],
  CUSTOMER: ['customerId', 'customerName', 'erpCustomerCode', 'updatedAt', 'payloadJson'],
  PRODUCT: ['productId', 'itemCode', 'itemName', 'updatedAt', 'payloadJson'],
  CUSTOMER_ALIAS: ['mappingId', 'customerId', 'normalizedText', 'sourceType', 'updatedAt', 'payloadJson'],
  PRODUCT_MAPPING: ['mappingId', 'customerId', 'sourceId', 'normalizedText', 'productId', 'updatedAt', 'payloadJson'],
  UNIT_MAPPING: ['mappingId', 'productId', 'productGroup', 'rawUnit', 'finalUnit', 'updatedAt', 'payloadJson'],
  MAPPING_EVENT: ['eventId', 'customerId', 'productId', 'createdAt', 'payloadJson'],
  IMPORT_BATCH: ['importBatchId', 'sourceType', 'status', 'updatedAt', 'payloadJson'],
  SOURCE_RECORD: ['sourceRecordId', 'importBatchId', 'sourceType', 'updatedAt', 'payloadJson'],
  SALES_DOCUMENT: ['salesDocumentId', 'importBatchId', 'salesDate', 'updatedAt', 'payloadJson'],
  SALES_LINE: ['salesLineId', 'salesDocumentId', 'productCode', 'updatedAt', 'payloadJson'],
  PURCHASE_DOCUMENT: ['purchaseDocumentId', 'importBatchId', 'purchaseDate', 'updatedAt', 'payloadJson'],
  PURCHASE_LINE: ['purchaseLineId', 'purchaseDocumentId', 'productCode', 'updatedAt', 'payloadJson'],
  LEDGER_DOCUMENT: ['ledgerDocumentId', 'importBatchId', 'transactionDate', 'updatedAt', 'payloadJson'],
  LEDGER_LINE: ['ledgerLineId', 'ledgerDocumentId', 'productCode', 'updatedAt', 'payloadJson'],
  INVENTORY_SNAPSHOT: ['inventorySnapshotId', 'importBatchId', 'basisDate', 'updatedAt', 'payloadJson'],
  INVENTORY_LINE: ['inventoryLineId', 'inventorySnapshotId', 'productCode', 'updatedAt', 'payloadJson'],
  HISTORICAL_ORDER_GROUP: ['historicalOrderGroupId', 'importBatchId', 'orderDate', 'updatedAt', 'payloadJson'],
  HISTORICAL_ORDER_LINE: ['historicalOrderLineId', 'historicalOrderGroupId', 'productCode', 'updatedAt', 'payloadJson'],
  FULFILLMENT_LINK: ['fulfillmentLinkId', 'historicalOrderLineId', 'salesLineId', 'updatedAt', 'payloadJson'],
  FULFILLMENT_BALANCE: ['fulfillmentBalanceId', 'historicalOrderLineId', 'status', 'updatedAt', 'payloadJson'],
  PARSER_EVIDENCE: ['parserEvidenceId', 'customerId', 'productCode', 'updatedAt', 'payloadJson'],
  COLLECTOR_SETTING: ['key', 'cutoffTime', 'holidayCount', 'updatedAt', 'payloadJson'],
  ORDER_TXN_LOG: ['txnId', 'orderId', 'status', 'previous1', 'previous2', 'previous3', 'previous4', 'next1', 'next2', 'next3', 'next4', 'error', 'createdAt', 'updatedAt'],
  SYNC_META: ['sequence', 'queueId', 'deviceId', 'entityType', 'entityId', 'operation', 'revision', 'baseRevision', 'appliedAt'],
  OFFICIAL_COMMAND: ['storageKey', 'companyId', 'voucherMode', 'documentId', 'revision', 'commandType', 'occurredAt', 'payloadDigest', 'payloadChunkCount']
    .concat(Array.from({ length: ORDERQ_OFFICIAL_PAYLOAD_CHUNK_LIMIT }, (_, index) => `payload${index + 1}`)),
  OFFICIAL_RESOLUTION: ['storageKey', 'companyId', 'unresolvedProductId', 'productId', 'occurredAt', 'payloadDigest', 'payloadChunkCount']
    .concat(Array.from({ length: ORDERQ_OFFICIAL_PAYLOAD_CHUNK_LIMIT }, (_, index) => `payload${index + 1}`)),
  OFFICIAL_HEAD: ['headKey', 'companyId', 'headType', 'subjectId', 'revision', 'entityType', 'entityId', 'payloadDigest', 'updatedAt', 'payloadJson'],
  OFFICIAL_META: ['sequence', 'queueId', 'companyId', 'deviceId', 'entityType', 'entityId', 'revision', 'appliedAt']
});

function orderQEnsureSheet(ss, key) {
  const name = ORDERQ_SHEETS[key];
  const header = ORDERQ_HEADERS[key];
  const sheet = getOrCreateSheet(ss, name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    return sheet;
  }
  const actual = sheet.getRange(1, 1, 1, header.length).getValues()[0].map(String);
  if (JSON.stringify(actual) !== JSON.stringify(header)) throw new Error(`ORDERQ_HEADER_INVALID:${name}`);
  return sheet;
}

function orderQEnsureAllSheets(ss) {
  const properties = PropertiesService.getScriptProperties();
  if (String(properties.getProperty(ORDERQ_SHEET_SCHEMA_PROPERTY) || '') === ORDERQ_SHEET_SCHEMA_VERSION) return;
  Object.keys(ORDERQ_SHEETS).forEach(key => orderQEnsureSheet(ss, key));
  properties.setProperty(ORDERQ_SHEET_SCHEMA_PROPERTY, ORDERQ_SHEET_SCHEMA_VERSION);
}

function orderQFindDataRow(sheet, id) {
  if (!id || sheet.getLastRow() < 2) return 0;
  const range = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1);
  const found = range.createTextFinder(String(id)).matchEntireCell(true).findNext();
  return found ? found.getRow() : 0;
}

function orderQReadPayloadById(sheet, id) {
  const row = orderQFindDataRow(sheet, id);
  if (!row) return null;
  const lastColumn = sheet.getLastColumn();
  const json = String(sheet.getRange(row, lastColumn).getValue() || '');
  if (!json) return null;
  try { return JSON.parse(json); }
  catch (error) { throw new Error(`ORDERQ_PAYLOAD_INVALID:${sheet.getName()}:${id}`); }
}

function orderQWriteRow(sheet, id, rowValues) {
  const row = orderQFindDataRow(sheet, id);
  const target = row || sheet.getLastRow() + 1;
  sheet.getRange(target, 1, 1, rowValues.length).setValues([rowValues]);
  return target;
}

function orderQUpsertCustomerMinimal(ss, order) {
  const customerId = String(order && order.customerId || '');
  if (!customerId) return;
  const sheet = orderQEnsureSheet(ss, 'CUSTOMER');
  if (orderQFindDataRow(sheet, customerId)) return;
  const payload = {
    customerId,
    customerName: String(order.customerName || ''),
    normalizedName: '',
    erpCustomerCode: '',
    status: 'ACTIVE',
    source: 'ORDER_SYNC',
    createdAt: String(order.createdAt || order.updatedAt || ''),
    updatedAt: String(order.updatedAt || '')
  };
  orderQWriteRow(sheet, customerId, [customerId, payload.customerName, '', payload.updatedAt, JSON.stringify(payload)]);
}

function orderQReplaceItems(ss, orderId, items) {
  const sheet = orderQEnsureSheet(ss, 'ORDER_ITEM');
  for (let row = sheet.getLastRow(); row >= 2; row--) {
    if (String(sheet.getRange(row, 2).getValue() || '') === String(orderId)) sheet.deleteRow(row);
  }
  const rows = (Array.isArray(items) ? items : []).map(item => [
    String(item.orderItemId || ''),
    String(orderId || ''),
    Number(item.lineNo || 0),
    String(item.productId || ''),
    String(item.matchStatus || ''),
    String(item.updatedAt || ''),
    JSON.stringify(item)
  ]).filter(row => row[0]);
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ORDERQ_HEADERS.ORDER_ITEM.length).setValues(rows);
}

function orderQDeleteEntityRow(sheet, id) {
  const row = orderQFindDataRow(sheet, id);
  if (row) sheet.deleteRow(row);
}

function orderQDeleteItems(ss, orderId) {
  const sheet = orderQEnsureSheet(ss, 'ORDER_ITEM');
  for (let row = sheet.getLastRow(); row >= 2; row--) {
    if (String(sheet.getRange(row, 2).getValue() || '') === String(orderId)) sheet.deleteRow(row);
  }
}

function orderQTxnChunks(value) {
  const source = JSON.stringify(value === undefined ? null : value);
  const chunks = [];
  for (let index = 0; index < source.length; index += 40000) chunks.push(source.slice(index, index + 40000));
  if (chunks.length > 4) throw new Error('ORDERQ_ORDER_BUNDLE_TOO_LARGE');
  while (chunks.length < 4) chunks.push('');
  return chunks;
}

function orderQBeginTransaction(ss, orderId, previousState, nextState) {
  const sheet = orderQEnsureSheet(ss, 'ORDER_TXN_LOG');
  const txnId = `OQTX-${String(Utilities.getUuid()).replace(/-/g, '')}`;
  const timestamp = new Date().toISOString();
  const row = [txnId, String(orderId || ''), 'PREPARED']
    .concat(orderQTxnChunks(previousState), orderQTxnChunks(nextState), ['', timestamp, timestamp]);
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  return { txnId, row: sheet.getLastRow() };
}

function orderQSetTransactionStatus(ss, transaction, status, error) {
  const sheet = orderQEnsureSheet(ss, 'ORDER_TXN_LOG');
  const row = transaction.row || orderQFindDataRow(sheet, transaction.txnId);
  if (!row) throw new Error('ORDERQ_TXN_NOT_FOUND');
  sheet.getRange(row, 3).setValue(String(status || ''));
  sheet.getRange(row, 12).setValue(String(error || ''));
  sheet.getRange(row, 14).setValue(new Date().toISOString());
}

function orderQReadTransactionState(values, startColumnIndex) {
  const json = values.slice(startColumnIndex, startColumnIndex + 4).map(value => String(value || '')).join('');
  if (!json) return null;
  try { return JSON.parse(json); }
  catch (error) { throw new Error('ORDERQ_TXN_STATE_INVALID'); }
}

function orderQReadCustomer(ss, customerId) {
  if (!customerId) return null;
  return orderQReadPayloadById(orderQEnsureSheet(ss, 'CUSTOMER'), customerId);
}

function orderQRestoreState(ss, orderId, state) {
  const bundle = state && state.bundle;
  const orderSheet = orderQEnsureSheet(ss, 'ORDER');
  if (!bundle || !bundle.order) {
    orderQDeleteEntityRow(orderSheet, orderId);
    orderQDeleteItems(ss, orderId);
  } else {
    const order = bundle.order;
    orderQWriteRow(orderSheet, order.orderId, [
      String(order.orderId), Number(order.revision || 0), String(order.customerId || ''), String(order.orderDate || ''),
      String(order.status || ''), String(order.updatedAt || ''), JSON.stringify(order)
    ]);
    orderQReplaceItems(ss, order.orderId, bundle.items || []);
  }
  const customerId = String(state && state.customerId || '');
  if (customerId) {
    const customerSheet = orderQEnsureSheet(ss, 'CUSTOMER');
    if (state.customer) {
      const customer = state.customer;
      orderQWriteRow(customerSheet, customerId, [customerId, customer.customerName || '', customer.erpCustomerCode || '', customer.updatedAt || '', JSON.stringify(customer)]);
    } else {
      orderQDeleteEntityRow(customerSheet, customerId);
    }
  }
}

function orderQVerifyBundle(ss, expected) {
  const actual = orderQReadOrderBundle(ss, expected.order.orderId);
  if (!actual || Number(actual.order.revision || 0) !== Number(expected.order.revision || 0)) throw new Error('ORDERQ_ORDER_VERIFY_FAILED');
  const expectedItems = (expected.items || []).slice().sort((a, b) => String(a.orderItemId).localeCompare(String(b.orderItemId)));
  const actualItems = (actual.items || []).slice().sort((a, b) => String(a.orderItemId).localeCompare(String(b.orderItemId)));
  if (JSON.stringify(expectedItems) !== JSON.stringify(actualItems)) throw new Error('ORDERQ_ORDER_ITEMS_VERIFY_FAILED');
  return actual;
}

function orderQRecoverPendingTransactions(ss) {
  const sheet = orderQEnsureSheet(ss, 'ORDER_TXN_LOG');
  if (sheet.getLastRow() < 2) return 0;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDERQ_HEADERS.ORDER_TXN_LOG.length).getValues();
  let recovered = 0;
  rows.forEach((values, index) => {
    const status = String(values[2] || '');
    if (status !== 'PREPARED' && status !== 'RECOVERY_REQUIRED') return;
    const transaction = { txnId: String(values[0] || ''), row: index + 2 };
    try {
      const previousState = orderQReadTransactionState(values, 3);
      orderQRestoreState(ss, String(values[1] || ''), previousState);
      orderQSetTransactionStatus(ss, transaction, 'RECOVERED', '요청 시작 시 미완료 저장을 이전 상태로 복구');
      recovered += 1;
    } catch (error) {
      orderQSetTransactionStatus(ss, transaction, 'RECOVERY_REQUIRED', String(error && error.message ? error.message : error));
      throw new Error(`ORDERQ_RECOVERY_FAILED:${transaction.txnId}`);
    }
  });
  return recovered;
}

function orderQReadOrderBundle(ss, orderId) {
  const orderSheet = orderQEnsureSheet(ss, 'ORDER');
  const order = orderQReadPayloadById(orderSheet, orderId);
  if (!order) return null;
  const itemSheet = orderQEnsureSheet(ss, 'ORDER_ITEM');
  const items = [];
  if (itemSheet.getLastRow() >= 2) {
    const rows = itemSheet.getRange(2, 1, itemSheet.getLastRow() - 1, ORDERQ_HEADERS.ORDER_ITEM.length).getValues();
    rows.forEach(row => {
      if (String(row[1] || '') !== String(orderId)) return;
      try { items.push(JSON.parse(String(row[6] || '{}'))); } catch (error) {}
    });
  }
  items.sort((a, b) => Number(a.lineNo || 0) - Number(b.lineNo || 0));
  return { order, items };
}

function orderQFindOrderBundleBySourceMessageKey(ss, sourceMessageKey) {
  const key = String(sourceMessageKey || '');
  if (!key) return null;
  const sheet = orderQEnsureSheet(ss, 'ORDER');
  if (sheet.getLastRow() < 2) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDERQ_HEADERS.ORDER.length).getValues();
  for (let index = 0; index < rows.length; index++) {
    try {
      const order = JSON.parse(String(rows[index][6] || '{}'));
      if (String(order.sourceMessageKey || '') === key) return orderQReadOrderBundle(ss, order.orderId);
    } catch (error) {}
  }
  return null;
}

function orderQMetaByQueueId(ss, queueId) {
  const sheet = orderQEnsureSheet(ss, 'SYNC_META');
  const row = orderQFindDataRow(sheet, queueId); // first column is sequence, so search explicitly in B
  if (sheet.getLastRow() < 2 || !queueId) return null;
  const found = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(queueId)).matchEntireCell(true).findNext();
  if (!found) return null;
  const values = sheet.getRange(found.getRow(), 1, 1, ORDERQ_HEADERS.SYNC_META.length).getValues()[0];
  return {
    sequence: Number(values[0] || 0), queueId: String(values[1] || ''), deviceId: String(values[2] || ''),
    entityType: String(values[3] || ''), entityId: String(values[4] || ''), operation: String(values[5] || ''),
    revision: Number(values[6] || 0), baseRevision: Number(values[7] || 0), appliedAt: String(values[8] || '')
  };
}

function orderQAppendMeta(ss, change, deviceId) {
  const sheet = orderQEnsureSheet(ss, 'SYNC_META');
  const sequence = sheet.getLastRow() < 2 ? 1 : Number(sheet.getRange(sheet.getLastRow(), 1).getValue() || 0) + 1;
  const row = [
    sequence,
    String(change.queueId || ''),
    String(deviceId || ''),
    String(change.entityType || ''),
    String(change.entityId || ''),
    String(change.operation || 'UPSERT'),
    Number(change.revision || 0),
    Number(change.baseRevision || 0),
    new Date().toISOString()
  ];
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  return sequence;
}

function orderQConflict(change, bundle) {
  return {
    queueId: String(change.queueId || ''),
    entityType: String(change.entityType || ''),
    entityId: String(change.entityId || ''),
    status: 'conflict',
    serverRevision: Number(bundle && bundle.order && bundle.order.revision || 0),
    serverPayload: bundle || null
  };
}

function orderQApplyOrder(ss, change) {
  const bundle = change && change.payload;
  const order = bundle && bundle.order;
  const items = bundle && bundle.items;
  if (!order || !Array.isArray(items)) throw new Error('ORDERQ_ORDER_PAYLOAD_INVALID');
  if (String(order.orderId || '') !== String(change.entityId || '')) throw new Error('ORDERQ_ORDER_ID_MISMATCH');
  const revision = Number(change.revision || order.revision || 0);
  const baseRevision = Number(change.baseRevision !== undefined ? change.baseRevision : Math.max(0, revision - 1));
  if (!Number.isInteger(revision) || revision < 1 || Number(order.revision) !== revision) throw new Error('ORDERQ_ORDER_REVISION_INVALID');

  const existing = orderQReadOrderBundle(ss, order.orderId);
  if (!existing && baseRevision === 0 && order.sourceMessageKey) {
    const sameSource = orderQFindOrderBundleBySourceMessageKey(ss, order.sourceMessageKey);
    if (sameSource && sameSource.order && String(sameSource.order.orderId) !== String(order.orderId)) {
      return {
        status: 'source_duplicate',
        serverRevision: Number(sameSource.order.revision || 0),
        serverOrderId: String(sameSource.order.orderId || ''),
        serverPayload: sameSource
      };
    }
  }
  if (existing) {
    if (Number(existing.order.revision || 0) !== baseRevision) return orderQConflict(change, existing);
  } else if (baseRevision !== 0) {
    return orderQConflict(change, null);
  }

  const previousState = {
    bundle: existing,
    customerId: String(order.customerId || ''),
    customer: orderQReadCustomer(ss, order.customerId)
  };
  const nextState = { bundle: { order, items }, customerId: String(order.customerId || '') };
  const transaction = orderQBeginTransaction(ss, order.orderId, previousState, nextState);
  try {
    const sheet = orderQEnsureSheet(ss, 'ORDER');
    orderQWriteRow(sheet, order.orderId, [
      String(order.orderId), revision, String(order.customerId || ''), String(order.orderDate || ''),
      String(order.status || ''), String(order.updatedAt || ''), JSON.stringify(order)
    ]);
    orderQReplaceItems(ss, order.orderId, items);
    orderQVerifyBundle(ss, { order, items });
    orderQUpsertCustomerMinimal(ss, order);
    orderQSetTransactionStatus(ss, transaction, 'COMMITTED', '');
    return { status: 'applied', serverRevision: revision, transactionId: transaction.txnId };
  } catch (error) {
    try {
      orderQRestoreState(ss, order.orderId, previousState);
      if (existing) orderQVerifyBundle(ss, existing);
      orderQSetTransactionStatus(ss, transaction, 'ROLLED_BACK', String(error && error.message ? error.message : error));
    } catch (restoreError) {
      orderQSetTransactionStatus(ss, transaction, 'RECOVERY_REQUIRED', String(restoreError && restoreError.message ? restoreError.message : restoreError));
      throw new Error(`ORDERQ_ORDER_RECOVERY_REQUIRED:${transaction.txnId}`);
    }
    throw error;
  }
}

function orderQSimpleSpec(entityType) {
  return {
    CUSTOMER: { key: 'CUSTOMER', id: 'customerId', row: p => [p.customerId, p.customerName || '', p.erpCustomerCode || '', p.updatedAt || '', JSON.stringify(p)] },
    PRODUCT: { key: 'PRODUCT', id: 'productId', row: p => [p.productId, p.itemCode || '', p.itemName || '', p.updatedAt || '', JSON.stringify(p)] },
    CUSTOMER_ALIAS: { key: 'CUSTOMER_ALIAS', id: 'mappingId', row: p => [p.mappingId, p.customerId || '', p.normalizedText || '', p.sourceType || '', p.updatedAt || '', JSON.stringify(p)] },
    PRODUCT_MAPPING: { key: 'PRODUCT_MAPPING', id: 'mappingId', row: p => [p.mappingId, p.customerId || '', p.sourceId || '', p.normalizedText || '', p.productId || '', p.updatedAt || '', JSON.stringify(p)] },
    UNIT_MAPPING: { key: 'UNIT_MAPPING', id: 'mappingId', row: p => [p.mappingId, p.productId || '', p.productGroup || '', p.rawUnit || '', p.finalUnit || '', p.updatedAt || '', JSON.stringify(p)] },
    MAPPING_EVENT: { key: 'MAPPING_EVENT', id: 'eventId', row: p => [p.eventId, p.customerId || '', p.productId || '', p.createdAt || '', JSON.stringify(p)] },
    ORDER_EVENT: { key: 'ORDER_EVENT', id: 'eventId', row: p => [p.eventId, p.orderId || '', Number(p.revision || 0), p.eventType || '', p.createdAt || '', JSON.stringify(p)] },
    IMPORT_BATCH: { key: 'IMPORT_BATCH', id: 'importBatchId', row: p => [p.importBatchId, p.sourceType || '', p.status || '', p.updatedAt || '', JSON.stringify(p)] },
    SOURCE_RECORD: { key: 'SOURCE_RECORD', id: 'sourceRecordId', row: p => [p.sourceRecordId, p.importBatchId || '', p.sourceType || '', p.updatedAt || p.importedAt || '', JSON.stringify(p)] },
    SALES_DOCUMENT: { key: 'SALES_DOCUMENT', id: 'salesDocumentId', row: p => [p.salesDocumentId, p.importBatchId || '', p.salesDate || '', p.updatedAt || '', JSON.stringify(p)] },
    SALES_LINE: { key: 'SALES_LINE', id: 'salesLineId', row: p => [p.salesLineId, p.salesDocumentId || '', p.productCode || '', p.updatedAt || '', JSON.stringify(p)] },
    PURCHASE_DOCUMENT: { key: 'PURCHASE_DOCUMENT', id: 'purchaseDocumentId', row: p => [p.purchaseDocumentId, p.importBatchId || '', p.purchaseDate || '', p.updatedAt || '', JSON.stringify(p)] },
    PURCHASE_LINE: { key: 'PURCHASE_LINE', id: 'purchaseLineId', row: p => [p.purchaseLineId, p.purchaseDocumentId || '', p.productCode || '', p.updatedAt || '', JSON.stringify(p)] },
    LEDGER_DOCUMENT: { key: 'LEDGER_DOCUMENT', id: 'ledgerDocumentId', row: p => [p.ledgerDocumentId, p.importBatchId || '', p.transactionDate || '', p.updatedAt || '', JSON.stringify(p)] },
    LEDGER_LINE: { key: 'LEDGER_LINE', id: 'ledgerLineId', row: p => [p.ledgerLineId, p.ledgerDocumentId || '', p.productCode || '', p.updatedAt || '', JSON.stringify(p)] },
    INVENTORY_SNAPSHOT: { key: 'INVENTORY_SNAPSHOT', id: 'inventorySnapshotId', row: p => [p.inventorySnapshotId, p.importBatchId || '', p.basisDate || '', p.updatedAt || '', JSON.stringify(p)] },
    INVENTORY_LINE: { key: 'INVENTORY_LINE', id: 'inventoryLineId', row: p => [p.inventoryLineId, p.inventorySnapshotId || '', p.productCode || '', p.updatedAt || '', JSON.stringify(p)] },
    HISTORICAL_ORDER_GROUP: { key: 'HISTORICAL_ORDER_GROUP', id: 'historicalOrderGroupId', row: p => [p.historicalOrderGroupId, p.importBatchId || '', p.orderDate || '', p.updatedAt || '', JSON.stringify(p)] },
    HISTORICAL_ORDER_LINE: { key: 'HISTORICAL_ORDER_LINE', id: 'historicalOrderLineId', row: p => [p.historicalOrderLineId, p.historicalOrderGroupId || '', p.productCode || '', p.updatedAt || '', JSON.stringify(p)] },
    FULFILLMENT_LINK: { key: 'FULFILLMENT_LINK', id: 'fulfillmentLinkId', row: p => [p.fulfillmentLinkId, p.historicalOrderLineId || '', p.salesLineId || '', p.updatedAt || '', JSON.stringify(p)] },
    FULFILLMENT_BALANCE: { key: 'FULFILLMENT_BALANCE', id: 'fulfillmentBalanceId', row: p => [p.fulfillmentBalanceId, p.historicalOrderLineId || '', p.status || '', p.updatedAt || '', JSON.stringify(p)] },
    PARSER_EVIDENCE: { key: 'PARSER_EVIDENCE', id: 'parserEvidenceId', row: p => [p.parserEvidenceId, p.customerId || '', p.productCode || '', p.updatedAt || '', JSON.stringify(p)] },
    COLLECTOR_SETTING: { key: 'COLLECTOR_SETTING', id: 'key', row: p => [p.key, `${String(p.cutoffHour || 0).padStart(2, '0')}:${String(p.cutoffMinute || 0).padStart(2, '0')}`, (p.holidays || []).length, p.updatedAt || '', JSON.stringify(p)] }
  }[entityType] || null;
}

function orderQApplySimple(ss, change) {
  const spec = orderQSimpleSpec(String(change.entityType || ''));
  if (!spec) throw new Error(`ORDERQ_ENTITY_UNSUPPORTED:${change.entityType}`);
  const payload = change.payload;
  if (!payload || typeof payload !== 'object') throw new Error('ORDERQ_ENTITY_PAYLOAD_INVALID');
  const id = String(payload[spec.id] || '');
  if (!id || id !== String(change.entityId || '')) throw new Error('ORDERQ_ENTITY_ID_MISMATCH');
  if (String(change.entityType || '') === 'ORDER_EVENT' && payload.orderId && !orderQReadOrderBundle(ss, payload.orderId)) {
    throw new Error('ORDERQ_ORDER_EVENT_ORPHAN');
  }
  const sheet = orderQEnsureSheet(ss, spec.key);
  if (String(change.entityType || '') === 'ORDER_EVENT' && /^SALES_TRANSFER_(ALLOCATED|REVERSED)$/.test(String(payload.eventType || ''))) {
    const existing = orderQReadPayloadById(sheet, id);
    if (existing) {
      const signature = event => JSON.stringify({
        orderId: String(event.orderId || ''),
        eventType: String(event.eventType || ''),
        detail: {
          transferBusinessKey: String(event.detail && event.detail.transferBusinessKey || ''),
          allocationEventId: String(event.detail && event.detail.allocationEventId || ''),
          idempotencyKey: String(event.detail && event.detail.idempotencyKey || ''),
          orderItemId: String(event.detail && event.detail.orderItemId || ''),
          salesDocumentId: String(event.detail && event.detail.salesDocumentId || ''),
          salesLineId: String(event.detail && event.detail.salesLineId || ''),
          transferredQty: Number(event.detail && event.detail.transferredQty || 0)
        }
      });
      if (signature(existing) !== signature(payload)) throw new Error('ORDERQ_TRANSFER_EVENT_IMMUTABLE');
      return { status: 'duplicate', serverRevision: Number(change.revision || 0) };
    }
  }
  orderQWriteRow(sheet, id, spec.row(payload));
  return { status: 'applied', serverRevision: Number(change.revision || 0) };
}

function orderQReadEntity(ss, entityType, entityId) {
  if (entityType === 'ORDER') return orderQReadOrderBundle(ss, entityId);
  const spec = orderQSimpleSpec(entityType);
  if (!spec) return null;
  return orderQReadPayloadById(orderQEnsureSheet(ss, spec.key), entityId);
}

function orderQSyncPush(ss, payload) {
  orderQEnsureAllSheets(ss);
  orderQRecoverPendingTransactions(ss);
  if (String(payload.schemaVersion || '') !== ORDERQ_SYNC_SCHEMA) throw new Error('ORDERQ_SYNC_SCHEMA_INVALID');
  const deviceId = String(payload.deviceId || '');
  if (!deviceId) throw new Error('ORDERQ_DEVICE_ID_REQUIRED');
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  if (changes.length > ORDERQ_SYNC_MAX_PUSH) throw new Error('ORDERQ_PUSH_LIMIT_EXCEEDED');
  const results = [];
  const duplicateOrderIds = {};

  changes.forEach(change => {
    const queueId = String(change && change.queueId || '');
    if (!queueId) {
      results.push({ queueId: '', status: 'error', message: 'ORDERQ_QUEUE_ID_REQUIRED' });
      return;
    }
    const duplicate = orderQMetaByQueueId(ss, queueId);
    if (duplicate) {
      results.push({ queueId, status: 'duplicate', sequence: duplicate.sequence, serverRevision: duplicate.revision });
      return;
    }
    if (String(change.entityType || '') === 'ORDER_EVENT' && duplicateOrderIds[String(change.payload && change.payload.orderId || '')]) {
      results.push({
        queueId,
        status: 'source_duplicate_event',
        serverOrderId: duplicateOrderIds[String(change.payload.orderId)]
      });
      return;
    }
    try {
      const applied = String(change.entityType || '') === 'ORDER'
        ? orderQApplyOrder(ss, change)
        : orderQApplySimple(ss, change);
      if (applied.status === 'conflict') {
        results.push(applied);
        return;
      }
      if (applied.status === 'duplicate') {
        results.push({ queueId, status: 'duplicate', serverRevision: applied.serverRevision });
        return;
      }
      if (applied.status === 'source_duplicate') {
        duplicateOrderIds[String(change.entityId || '')] = applied.serverOrderId;
        results.push({
          queueId,
          status: 'source_duplicate',
          serverRevision: applied.serverRevision,
          serverOrderId: applied.serverOrderId,
          serverPayload: applied.serverPayload
        });
        return;
      }
      const sequence = orderQAppendMeta(ss, change, deviceId);
      results.push({ queueId, status: 'applied', sequence, serverRevision: applied.serverRevision });
    } catch (error) {
      results.push({ queueId, status: 'error', message: String(error && error.message ? error.message : error) });
    }
  });

  const meta = orderQEnsureSheet(ss, 'SYNC_META');
  const cursor = meta.getLastRow() < 2 ? 0 : Number(meta.getRange(meta.getLastRow(), 1).getValue() || 0);
  return { schemaVersion: ORDERQ_SYNC_SCHEMA, results, cursor };
}

function orderQSyncPull(ss, payload) {
  orderQEnsureAllSheets(ss);
  orderQRecoverPendingTransactions(ss);
  if (String(payload.schemaVersion || '') !== ORDERQ_SYNC_SCHEMA) throw new Error('ORDERQ_SYNC_SCHEMA_INVALID');
  const after = Math.max(0, Number(payload.afterSequence || 0));
  const limit = Math.min(ORDERQ_SYNC_MAX_PULL, Math.max(1, Number(payload.limit || 200)));
  const meta = orderQEnsureSheet(ss, 'SYNC_META');
  if (meta.getLastRow() < 2) return { schemaVersion: ORDERQ_SYNC_SCHEMA, changes: [], nextCursor: after, hasMore: false };
  const rows = meta.getRange(2, 1, meta.getLastRow() - 1, ORDERQ_HEADERS.SYNC_META.length).getValues();
  const pending = rows.filter(row => Number(row[0] || 0) > after);
  const selected = pending.slice(0, limit);
  const changes = selected.map(row => {
    const entityType = String(row[3] || '');
    const entityId = String(row[4] || '');
    return {
      sequence: Number(row[0] || 0),
      queueId: String(row[1] || ''),
      deviceId: String(row[2] || ''),
      entityType,
      entityId,
      operation: String(row[5] || ''),
      revision: Number(row[6] || 0),
      baseRevision: Number(row[7] || 0),
      appliedAt: String(row[8] || ''),
      payload: orderQReadEntity(ss, entityType, entityId)
    };
  });
  const nextCursor = selected.length ? Number(selected[selected.length - 1][0] || after) : after;
  return {
    schemaVersion: ORDERQ_SYNC_SCHEMA,
    changes,
    nextCursor,
    hasMore: pending.length > selected.length
  };
}

function orderQOrderHead(ss, payload) {
  orderQEnsureAllSheets(ss);
  orderQRecoverPendingTransactions(ss);
  const orderId = String(payload.orderId || '');
  if (!orderId) throw new Error('ORDERQ_ORDER_ID_REQUIRED');
  const bundle = orderQReadOrderBundle(ss, orderId);
  return {
    schemaVersion: ORDERQ_SYNC_SCHEMA,
    orderId,
    revision: Number(bundle && bundle.order && bundle.order.revision || 0),
    payload: bundle
  };
}

function orderQOfficialSpec(entityType) {
  const type = String(entityType || '');
  if (type === 'OFFICIAL_VOUCHER_COMMAND') {
    return { key: 'OFFICIAL_COMMAND', digestIndex: 7, countIndex: 8, payloadStart: 9 };
  }
  if (type === 'PENDING_INVENTORY_RESOLUTION') {
    return { key: 'OFFICIAL_RESOLUTION', digestIndex: 5, countIndex: 6, payloadStart: 7 };
  }
  return null;
}

function orderQOfficialDescriptor(entityType, payload) {
  const type = String(entityType || '');
  if (!payload || typeof payload !== 'object') throw new Error('ORDERQ_OFFICIAL_PAYLOAD_INVALID');
  if (type === 'OFFICIAL_VOUCHER_COMMAND') {
    if (String(payload.schemaVersion || '') !== 'ONEAPP_ORDERQ_OFFICIAL_COMMAND_PAYLOAD_V1'
      || !String(payload.projectionDigest || '')) throw new Error('ORDERQ_OFFICIAL_COMMAND_PAYLOAD_INVALID');
    const command = payload.command;
    if (!command || typeof command !== 'object') throw new Error('ORDERQ_OFFICIAL_COMMAND_REQUIRED');
    const companyId = String(payload.companyId || command.companyId || '');
    const commandType = String(command.commandType || '');
    const voucherMode = String(payload.voucherMode || (/PURCHASE$/.test(commandType) ? 'purchase' : /SALE$/.test(commandType) ? 'sale' : '')).toLowerCase();
    const documentId = String(payload.documentId || command.purchaseDocumentId || command.salesDocumentId || command.aggregateId || '');
    const entityId = String(command.commandId || '');
    const expectedRevision = Number(command.expectedRevision || 0);
    if (!companyId || !entityId || !documentId || !['purchase', 'sale'].includes(voucherMode)) throw new Error('ORDERQ_OFFICIAL_COMMAND_IDENTITY_INVALID');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_OFFICIAL_REVISION_REQUIRED');
    return {
      entityId, storageKey: `${companyId}|${entityId}`, companyId, voucherMode, documentId, commandType,
      revision: expectedRevision + 1,
      expectedRevision,
      occurredAt: String(command.occurredAt || ''),
      headKey: `${companyId}|VOUCHER|${voucherMode}|${documentId}`,
      headType: 'VOUCHER',
      subjectId: `${voucherMode}|${documentId}`,
      firstWrite: /^POST_/.test(commandType)
    };
  }
  if (type === 'PENDING_INVENTORY_RESOLUTION') {
    if (!String(payload.resolutionDigest || '')) throw new Error('ORDERQ_OFFICIAL_RESOLUTION_PAYLOAD_INVALID');
    const companyId = String(payload.companyId || payload.productResolution && payload.productResolution.companyId || '');
    const entityId = String(payload.resolutionId || '');
    const unresolvedProductId = String(payload.unresolvedProductId || payload.productResolution && payload.productResolution.unresolvedProductId || '');
    const productId = String(payload.productId || payload.productResolution && payload.productResolution.productId || '');
    if (!companyId || !entityId || !unresolvedProductId || !productId) throw new Error('ORDERQ_OFFICIAL_RESOLUTION_IDENTITY_INVALID');
    const resolution = payload.productResolution || {};
    if (String(resolution.companyId || '') !== companyId
      || String(resolution.unresolvedProductId || '') !== unresolvedProductId
      || String(resolution.productId || '') !== productId) throw new Error('ORDERQ_OFFICIAL_RESOLUTION_IDENTITY_INVALID');
    return {
      entityId, storageKey: `${companyId}|${entityId}`, companyId, unresolvedProductId, productId,
      revision: 1,
      occurredAt: String(payload.occurredAt || ''),
      headKey: `${companyId}|PRODUCT_RESOLUTION|${unresolvedProductId}`,
      headType: 'PRODUCT_RESOLUTION',
      subjectId: unresolvedProductId,
      firstWrite: true
    };
  }
  throw new Error(`ORDERQ_OFFICIAL_ENTITY_UNSUPPORTED:${type}`);
}

function orderQOfficialChunks(payload) {
  const json = JSON.stringify(payload);
  const chunks = [];
  for (let index = 0; index < json.length; index += ORDERQ_OFFICIAL_PAYLOAD_CHUNK_SIZE) {
    chunks.push(json.slice(index, index + ORDERQ_OFFICIAL_PAYLOAD_CHUNK_SIZE));
  }
  if (!chunks.length) chunks.push('{}');
  if (chunks.length > ORDERQ_OFFICIAL_PAYLOAD_CHUNK_LIMIT) throw new Error('ORDERQ_OFFICIAL_PAYLOAD_TOO_LARGE');
  return { json, digest: sha256Hex(json), chunks };
}

function orderQOfficialRow(entityType, descriptor, packed) {
  const padding = Array(ORDERQ_OFFICIAL_PAYLOAD_CHUNK_LIMIT - packed.chunks.length).fill('');
  if (String(entityType || '') === 'OFFICIAL_VOUCHER_COMMAND') {
    return [descriptor.storageKey, descriptor.companyId, descriptor.voucherMode, descriptor.documentId,
      descriptor.revision, descriptor.commandType, descriptor.occurredAt, packed.digest, packed.chunks.length]
      .concat(packed.chunks, padding);
  }
  return [descriptor.storageKey, descriptor.companyId, descriptor.unresolvedProductId, descriptor.productId,
    descriptor.occurredAt, packed.digest, packed.chunks.length].concat(packed.chunks, padding);
}

function orderQOfficialReadStored(ss, entityType, companyId, entityId) {
  const spec = orderQOfficialSpec(entityType);
  if (!spec) return null;
  const sheet = orderQEnsureSheet(ss, spec.key);
  const row = orderQFindDataRow(sheet, `${String(companyId || '')}|${String(entityId || '')}`);
  if (!row) return null;
  const values = sheet.getRange(row, 1, 1, ORDERQ_HEADERS[spec.key].length).getValues()[0];
  const count = Number(values[spec.countIndex] || 0);
  if (!Number.isInteger(count) || count < 1 || count > ORDERQ_OFFICIAL_PAYLOAD_CHUNK_LIMIT) throw new Error('ORDERQ_OFFICIAL_CHUNK_COUNT_INVALID');
  const json = values.slice(spec.payloadStart, spec.payloadStart + count).map(value => String(value || '')).join('');
  const digest = String(values[spec.digestIndex] || '');
  if (!json || sha256Hex(json) !== digest) throw new Error('ORDERQ_OFFICIAL_PAYLOAD_DIGEST_INVALID');
  try { return { payload: JSON.parse(json), digest, row }; }
  catch (error) { throw new Error('ORDERQ_OFFICIAL_PAYLOAD_JSON_INVALID'); }
}

function orderQOfficialMetaByQueueId(ss, queueId) {
  const sheet = orderQEnsureSheet(ss, 'OFFICIAL_META');
  if (!queueId || sheet.getLastRow() < 2) return null;
  const found = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).createTextFinder(String(queueId)).matchEntireCell(true).findNext();
  if (!found) return null;
  const values = sheet.getRange(found.getRow(), 1, 1, ORDERQ_HEADERS.OFFICIAL_META.length).getValues()[0];
  return { sequence: Number(values[0] || 0), queueId: String(values[1] || ''), companyId: String(values[2] || ''),
    deviceId: String(values[3] || ''), entityType: String(values[4] || ''), entityId: String(values[5] || ''),
    revision: Number(values[6] || 0), appliedAt: String(values[7] || '') };
}

function orderQOfficialMetaByEntity(ss, companyId, entityType, entityId) {
  const sheet = orderQEnsureSheet(ss, 'OFFICIAL_META');
  if (sheet.getLastRow() < 2) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDERQ_HEADERS.OFFICIAL_META.length).getValues();
  const match = rows.find(row => String(row[2] || '') === String(companyId)
    && String(row[4] || '') === String(entityType) && String(row[5] || '') === String(entityId));
  return match ? { sequence: Number(match[0] || 0), queueId: String(match[1] || ''), companyId: String(match[2] || ''),
    deviceId: String(match[3] || ''), entityType: String(match[4] || ''), entityId: String(match[5] || ''),
    revision: Number(match[6] || 0), appliedAt: String(match[7] || '') } : null;
}

function orderQOfficialAppendMeta(ss, change, deviceId, companyId, revision) {
  const sheet = orderQEnsureSheet(ss, 'OFFICIAL_META');
  const sequence = sheet.getLastRow() < 2 ? 1 : Number(sheet.getRange(sheet.getLastRow(), 1).getValue() || 0) + 1;
  const appliedAt = new Date().toISOString();
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, ORDERQ_HEADERS.OFFICIAL_META.length).setValues([[
    sequence, String(change.queueId || ''), String(companyId || ''), String(deviceId || ''),
    String(change.entityType || ''), String(change.entityId || ''), Number(revision || 0), appliedAt
  ]]);
  return { sequence, appliedAt };
}

function orderQOfficialReadHead(ss, headKey) {
  return orderQReadPayloadById(orderQEnsureSheet(ss, 'OFFICIAL_HEAD'), headKey);
}

function orderQOfficialWriteHead(ss, descriptor, entityType, digest) {
  const payload = { headKey: descriptor.headKey, companyId: descriptor.companyId, headType: descriptor.headType,
    subjectId: descriptor.subjectId, revision: descriptor.revision, entityType: String(entityType || ''),
    entityId: descriptor.entityId, payloadDigest: digest, updatedAt: new Date().toISOString() };
  orderQWriteRow(orderQEnsureSheet(ss, 'OFFICIAL_HEAD'), descriptor.headKey, [payload.headKey, payload.companyId,
    payload.headType, payload.subjectId, payload.revision, payload.entityType, payload.entityId,
    payload.payloadDigest, payload.updatedAt, JSON.stringify(payload)]);
  return payload;
}

function orderQOfficialRepairHeadMeta(ss, head) {
  if (!head || !head.entityId) return null;
  const existing = orderQOfficialMetaByEntity(ss, head.companyId, head.entityType, head.entityId);
  if (existing) return existing;
  const stored = orderQOfficialReadStored(ss, head.entityType, head.companyId, head.entityId);
  if (!stored || stored.digest !== String(head.payloadDigest || '')) throw new Error('ORDERQ_OFFICIAL_HEAD_PAYLOAD_MISSING');
  return orderQOfficialAppendMeta(ss, {
    queueId: `SERVER-RECOVERY:${head.entityId}`,
    entityType: head.entityType,
    entityId: head.entityId
  }, 'SERVER_RECOVERY', head.companyId, head.revision);
}

function orderQOfficialApply(ss, change, requestCompanyId, deviceId) {
  const entityType = String(change.entityType || '');
  if (!orderQOfficialSpec(entityType)) throw new Error(`ORDERQ_OFFICIAL_ENTITY_UNSUPPORTED:${entityType}`);
  const descriptor = orderQOfficialDescriptor(entityType, change.payload);
  if (descriptor.companyId !== String(requestCompanyId || '')) throw new Error('ORDERQ_OFFICIAL_COMPANY_MISMATCH');
  if (descriptor.entityId !== String(change.entityId || '')) throw new Error('ORDERQ_OFFICIAL_ENTITY_ID_MISMATCH');
  if (descriptor.revision !== Number(change.revision || 0)) throw new Error('ORDERQ_OFFICIAL_REVISION_MISMATCH');
  const packed = orderQOfficialChunks(change.payload);
  const head = orderQOfficialReadHead(ss, descriptor.headKey);
  orderQOfficialRepairHeadMeta(ss, head);

  const stored = orderQOfficialReadStored(ss, entityType, descriptor.companyId, descriptor.entityId);
  if (stored) {
    if (stored.digest !== packed.digest) throw new Error('ORDERQ_OFFICIAL_ENTITY_IMMUTABLE');
    const meta = orderQOfficialMetaByEntity(ss, descriptor.companyId, entityType, descriptor.entityId)
      || orderQOfficialAppendMeta(ss, change, deviceId, descriptor.companyId, descriptor.revision);
    return { status: 'duplicate', sequence: meta.sequence, serverRevision: descriptor.revision };
  }

  if (head) {
    const revisionConflict = descriptor.headType === 'VOUCHER'
      ? Number(head.revision || 0) !== descriptor.expectedRevision
      : String(head.entityId || '') !== descriptor.entityId;
    if (revisionConflict) {
      const current = orderQOfficialReadStored(ss, head.entityType, head.companyId, head.entityId);
      return { status: 'conflict', serverRevision: Number(head.revision || 0), serverPayload: current && current.payload || null };
    }
  } else if (descriptor.headType === 'VOUCHER' && (!descriptor.firstWrite || descriptor.expectedRevision !== 1)) {
    return { status: 'conflict', serverRevision: 0, serverPayload: null };
  }

  const sheet = orderQEnsureSheet(ss, orderQOfficialSpec(entityType).key);
  orderQWriteRow(sheet, descriptor.entityId, orderQOfficialRow(entityType, descriptor, packed));
  orderQOfficialWriteHead(ss, descriptor, entityType, packed.digest);
  const meta = orderQOfficialAppendMeta(ss, change, deviceId, descriptor.companyId, descriptor.revision);
  return { status: 'applied', sequence: meta.sequence, serverRevision: descriptor.revision };
}

function orderQOfficialSyncPush(ss, payload) {
  orderQEnsureAllSheets(ss);
  if (String(payload.schemaVersion || '') !== ORDERQ_OFFICIAL_SYNC_SCHEMA) throw new Error('ORDERQ_OFFICIAL_SYNC_SCHEMA_INVALID');
  const companyId = String(payload.companyId || '');
  const deviceId = String(payload.deviceId || '');
  if (!companyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  if (!deviceId) throw new Error('ORDERQ_DEVICE_ID_REQUIRED');
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  if (changes.length > ORDERQ_SYNC_MAX_PUSH) throw new Error('ORDERQ_OFFICIAL_PUSH_LIMIT_EXCEEDED');
  const results = changes.map(change => {
    const queueId = String(change && change.queueId || '');
    if (!queueId) return { queueId: '', status: 'error', message: 'ORDERQ_QUEUE_ID_REQUIRED' };
    const duplicate = orderQOfficialMetaByQueueId(ss, queueId);
    if (duplicate) return duplicate.companyId === companyId
      ? { queueId, status: 'duplicate', sequence: duplicate.sequence, serverRevision: duplicate.revision }
      : { queueId, status: 'error', message: 'ORDERQ_OFFICIAL_QUEUE_COMPANY_MISMATCH' };
    try {
      const applied = orderQOfficialApply(ss, change, companyId, deviceId);
      return { queueId, ...applied };
    } catch (error) {
      return { queueId, status: 'error', message: String(error && error.message ? error.message : error) };
    }
  });
  const meta = orderQEnsureSheet(ss, 'OFFICIAL_META');
  const cursor = meta.getLastRow() < 2 ? 0 : Number(meta.getRange(meta.getLastRow(), 1).getValue() || 0);
  return { schemaVersion: ORDERQ_OFFICIAL_SYNC_SCHEMA, companyId, results, cursor };
}

function orderQOfficialSyncPull(ss, payload) {
  orderQEnsureAllSheets(ss);
  if (String(payload.schemaVersion || '') !== ORDERQ_OFFICIAL_SYNC_SCHEMA) throw new Error('ORDERQ_OFFICIAL_SYNC_SCHEMA_INVALID');
  const companyId = String(payload.companyId || '');
  if (!companyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const after = Math.max(0, Number(payload.afterSequence || 0));
  const limit = Math.min(ORDERQ_SYNC_MAX_PULL, Math.max(1, Number(payload.limit || 200)));
  const sheet = orderQEnsureSheet(ss, 'OFFICIAL_META');
  if (sheet.getLastRow() < 2) return { schemaVersion: ORDERQ_OFFICIAL_SYNC_SCHEMA, companyId, changes: [], nextCursor: after, hasMore: false };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDERQ_HEADERS.OFFICIAL_META.length).getValues()
    .filter(row => Number(row[0] || 0) > after && String(row[2] || '') === companyId);
  const selected = rows.slice(0, limit);
  const changes = selected.map(row => {
    const entityType = String(row[4] || '');
    const entityId = String(row[5] || '');
    const stored = orderQOfficialReadStored(ss, entityType, companyId, entityId);
    if (!stored) throw new Error(`ORDERQ_OFFICIAL_META_PAYLOAD_MISSING:${entityId}`);
    return { sequence: Number(row[0] || 0), queueId: String(row[1] || ''), companyId: String(row[2] || ''),
      deviceId: String(row[3] || ''), entityType, entityId, revision: Number(row[6] || 0),
      appliedAt: String(row[7] || ''), payload: stored.payload };
  });
  const nextCursor = selected.length ? Number(selected[selected.length - 1][0] || after) : after;
  return { schemaVersion: ORDERQ_OFFICIAL_SYNC_SCHEMA, companyId, changes, nextCursor, hasMore: rows.length > selected.length };
}
