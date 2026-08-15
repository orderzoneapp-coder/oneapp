/*
 * ORDER Q vNext cloud sync helpers
 * Contract: ONEAPP_ORDERQ_SYNC_V1
 *
 * This file is loaded by the same bound Apps Script project as code.gs.
 * code.gs routes orderq_sync_push / orderq_sync_pull / orderq_order_head here.
 */

const ORDERQ_SYNC_SCHEMA = 'ONEAPP_ORDERQ_SYNC_V1';
const ORDERQ_SYNC_MAX_PUSH = 100;
const ORDERQ_SYNC_MAX_PULL = 500;
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
  M9_ENTITY: 'ORDERQ_M9_ENTITY',
  M9_COMMAND: 'ORDERQ_M9_COMMAND',
  M9_META: 'ORDERQ_M9_META',
  M9_CHANGE: 'ORDERQ_M9_CHANGE',
  M9_TXN_LOG: 'ORDERQ_M9_TXN_LOG'
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
  M9_ENTITY: ['entityKey', 'entityType', 'entityId', 'revision', 'status', 'updatedAt', 'payloadJson'],
  M9_COMMAND: ['idempotencyKey', 'commandType', 'aggregateId', 'expectedRevision', 'fingerprint', 'status', 'leaseToken', 'deviceId', 'resultJson', 'updatedAt', 'payloadJson'],
  M9_META: ['key', 'value', 'updatedAt', 'payloadJson'],
  M9_CHANGE: ['sequence', 'deviceId', 'commandId', 'entityType', 'entityId', 'revision', 'payloadJson', 'appliedAt'],
  M9_TXN_LOG: ['txnId', 'idempotencyKey', 'status', 'previousJson', 'nextJson', 'error', 'updatedAt']
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

/* ORDER Q M9 central-authority command boundary. Apps Script lock is acquired by code.gs. */
const ORDERQ_M9_SCHEMA = 'ONEAPP_ORDERQ_CENTRAL_V1';
const ORDERQ_M9_LEASE_DURATION_MS = 5 * 60 * 1000;
const ORDERQ_M9_MIGRATION_TYPES = Object.freeze([
  'ORDER', 'ORDER_ITEM', 'PRODUCT', 'WAREHOUSE', 'INVENTORY_SNAPSHOT', 'INVENTORY_LINE',
  'DISPATCH_DECISION', 'DISPATCH_LINE', 'DISPATCH_STOCK_ALLOCATION', 'PURCHASE_DOCUMENT', 'PURCHASE_LINE'
]);
const ORDERQ_M9_OFFICIAL_TYPES = Object.freeze(ORDERQ_M9_MIGRATION_TYPES.concat([
  'DISPATCH_APPROVAL', 'INVENTORY_RESERVATION', 'INVENTORY_MOVEMENT', 'DISPATCH_RECONCILIATION',
  'SALES_DOCUMENT', 'SALES_LINE', 'ORDER_EVENT'
]));

function orderQM9Text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function orderQM9Stable(value) {
  if (Array.isArray(value)) return value.map(orderQM9Stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => {
    result[key] = orderQM9Stable(value[key]);
    return result;
  }, {});
  return value;
}

function orderQM9StableJson(value) {
  return JSON.stringify(orderQM9Stable(value));
}

function orderQM9RequireSchema(payload) {
  if (orderQM9Text(payload && payload.schemaVersion) !== ORDERQ_M9_SCHEMA) throw new Error('ORDERQ_CENTRAL_SCHEMA_INVALID');
}

function orderQM9EntityKey(entityType, entityId) {
  return `${orderQM9Text(entityType).toUpperCase()}\u001f${orderQM9Text(entityId)}`;
}

function orderQM9ReadEntity(ss, entityType, entityId) {
  return orderQReadPayloadById(orderQEnsureSheet(ss, 'M9_ENTITY'), orderQM9EntityKey(entityType, entityId));
}

function orderQM9WriteEntity(ss, row) {
  const payload = row.payload || {};
  const entityType = orderQM9Text(row.entityType).toUpperCase();
  const entityId = orderQM9Text(row.entityId);
  const revision = Number(row.revision || payload.revision || payload.dispatchRevision || 0);
  const status = orderQM9Text(payload.status || payload.erpPostingStatus).toUpperCase();
  const timestamp = new Date().toISOString();
  const stored = { entityType, entityId, revision, status, payload };
  orderQWriteRow(orderQEnsureSheet(ss, 'M9_ENTITY'), orderQM9EntityKey(entityType, entityId), [
    orderQM9EntityKey(entityType, entityId), entityType, entityId, revision, status, timestamp, JSON.stringify(stored)
  ]);
  return stored;
}

function orderQM9ReadCommand(ss, idempotencyKey) {
  return orderQReadPayloadById(orderQEnsureSheet(ss, 'M9_COMMAND'), orderQM9Text(idempotencyKey));
}

function orderQM9WriteCommand(ss, command) {
  const timestamp = new Date().toISOString();
  orderQWriteRow(orderQEnsureSheet(ss, 'M9_COMMAND'), command.idempotencyKey, [
    command.idempotencyKey, command.commandType || '', command.aggregateId || '', Number(command.expectedRevision || 0),
    command.fingerprint || '', command.status || '', command.leaseToken || '', command.deviceId || '',
    JSON.stringify(command.result || null), timestamp, JSON.stringify(command)
  ]);
  return command;
}

function orderQM9MetaNumber(ss, key) {
  const row = orderQReadPayloadById(orderQEnsureSheet(ss, 'M9_META'), key);
  return Number(row && row.value || 0);
}

function orderQM9SetMetaNumber(ss, key, value) {
  const payload = { key, value: Number(value || 0), updatedAt: new Date().toISOString() };
  orderQWriteRow(orderQEnsureSheet(ss, 'M9_META'), key, [key, payload.value, payload.updatedAt, JSON.stringify(payload)]);
  return payload.value;
}

function orderQM9AppendChange(ss, deviceId, commandId, row) {
  const sequence = orderQM9MetaNumber(ss, 'syncSequence') + 1;
  orderQM9SetMetaNumber(ss, 'syncSequence', sequence);
  const timestamp = new Date().toISOString();
  orderQEnsureSheet(ss, 'M9_CHANGE').appendRow([
    sequence, orderQM9Text(deviceId), orderQM9Text(commandId), row.entityType, row.entityId,
    Number(row.revision || 0), JSON.stringify(row.payload), timestamp
  ]);
  return sequence;
}

function orderQM9CommandFingerprint(payload) {
  const commandType = orderQM9Text(payload.commandType).toUpperCase();
  const aggregateId = orderQM9Text(payload.aggregateId);
  const idempotencyKey = orderQM9Text(payload.idempotencyKey);
  const expectedRevision = Number(payload.expectedRevision);
  if (!commandType || !aggregateId || !idempotencyKey || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('ORDERQ_CENTRAL_COMMAND_INVALID');
  }
  return orderQM9StableJson({ commandType, aggregateId, expectedRevision, intent: payload.intent || null });
}

function orderQM9TargetType(commandType) {
  if (String(commandType).indexOf('PURCHASE') >= 0) return 'PURCHASE_DOCUMENT';
  if (commandType === 'ERP_TRANSITION') return '';
  return 'DISPATCH_DECISION';
}

function orderQM9AllowedState(commandType, status) {
  const states = {
    RELEASE_DISPATCH: ['DRAFT'], UPDATE_DISPATCH: ['RELEASED', 'READY_TO_CONFIRM'],
    RECALL_DISPATCH: ['RELEASED', 'READY_TO_CONFIRM'], CONFIRM_DISPATCH: ['READY_TO_CONFIRM'],
    REVERSE_DISPATCH: ['CONFIRMED'], ADJUST_DISPATCH: ['CONFIRMED'],
    CONFIRM_PURCHASE: ['DRAFT'], REVERSE_PURCHASE: ['CONFIRMED'],
    RECONCILE_PURCHASE_EXTERNAL: ['CONFIRMED'],
    ERP_TRANSITION: ['READY', 'EXPORTED', 'POSTED', 'RECONCILED', 'CORRECTION_REQUIRED']
  }[commandType] || [];
  return states.indexOf(status) >= 0;
}

function orderQM9ErpTransitionAllowed(current, next) {
  const states = {
    READY: ['EXPORTED', 'CORRECTION_REQUIRED'],
    EXPORTED: ['POSTED', 'CORRECTION_REQUIRED'],
    POSTED: ['RECONCILED', 'CORRECTION_REQUIRED'],
    RECONCILED: ['CORRECTION_REQUIRED'],
    CORRECTION_REQUIRED: ['EXPORTED']
  };
  return (states[orderQM9Text(current).toUpperCase()] || []).indexOf(orderQM9Text(next).toUpperCase()) >= 0;
}

function orderQM9InventoryResourceFingerprint(ss) {
  const sheet = orderQEnsureSheet(ss, 'M9_ENTITY');
  if (sheet.getLastRow() < 2) return '[]';
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDERQ_HEADERS.M9_ENTITY.length).getValues()
    .map(values => {
      try { return JSON.parse(String(values[6] || '{}')); } catch (error) { return null; }
    })
    .filter(row => row && ['INVENTORY_LINE', 'INVENTORY_MOVEMENT', 'INVENTORY_RESERVATION'].indexOf(row.entityType) >= 0)
    .map(row => ({
      entityType: row.entityType,
      entityId: row.entityId,
      revision: Number(row.revision || 0),
      status: orderQM9Text(row.status).toUpperCase(),
      productId: orderQM9Text(row.payload && row.payload.productId),
      warehouseId: orderQM9Text(row.payload && row.payload.warehouseId),
      inventoryQuantity: row.payload && row.payload.inventoryQuantity,
      signedBaseQuantity: row.payload && row.payload.signedBaseQuantity,
      reservedBaseQuantity: row.payload && row.payload.reservedBaseQuantity
    }))
    .sort((a, b) => orderQM9EntityKey(a.entityType, a.entityId).localeCompare(orderQM9EntityKey(b.entityType, b.entityId)));
  return orderQM9StableJson(rows);
}

function orderQM9Migrate(ss, payload) {
  orderQM9RequireSchema(payload);
  orderQEnsureAllSheets(ss);
  const idempotencyKey = orderQM9Text(payload.idempotencyKey);
  const entities = Array.isArray(payload.entities) ? payload.entities : [];
  if (!idempotencyKey) throw new Error('ORDERQ_CENTRAL_MIGRATION_KEY_REQUIRED');
  const normalized = entities.map(row => ({
    entityType: orderQM9Text(row.entityType).toUpperCase(), entityId: orderQM9Text(row.entityId),
    revision: Number(row.revision || 0), payload: row.payload
  })).sort((a, b) => orderQM9EntityKey(a.entityType, a.entityId).localeCompare(orderQM9EntityKey(b.entityType, b.entityId)));
  const fingerprint = orderQM9StableJson(normalized.map(row => ({ entityType: row.entityType, entityId: row.entityId, payload: row.payload })));
  const prior = orderQM9ReadCommand(ss, idempotencyKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error(`ORDERQ_CENTRAL_MIGRATION_IDEMPOTENCY_CONFLICT:${idempotencyKey}`);
    return { duplicate: true, changes: prior.result && prior.result.changes || [], cursor: orderQM9MetaNumber(ss, 'syncSequence') };
  }
  const changes = [];
  const pending = new Map();
  normalized.forEach(row => {
    if (ORDERQ_M9_MIGRATION_TYPES.indexOf(row.entityType) < 0 || !row.entityId || !row.payload) {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_ENTITY_INVALID:${row.entityType}:${row.entityId}`);
    }
    if (row.entityType === 'DISPATCH_DECISION' && orderQM9Text(row.payload.status).toUpperCase() !== 'DRAFT') {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_DISPATCH_DRAFT_ONLY:${row.entityId}`);
    }
    if (row.entityType === 'PURCHASE_DOCUMENT' && orderQM9Text(row.payload.status).toUpperCase() !== 'DRAFT') {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_PURCHASE_DRAFT_ONLY:${row.entityId}`);
    }
    if (row.payload.localOnly === false || row.payload.centralRevision || row.payload.ledgerSequence) {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_EVIDENCE_INVALID:${row.entityType}:${row.entityId}`);
    }
    row.payload = JSON.parse(JSON.stringify(row.payload));
    row.payload.localOnly = false;
    row.payload.centralRevision = row.revision;
    const entityKey = orderQM9EntityKey(row.entityType, row.entityId);
    const pendingRow = pending.get(entityKey);
    if (pendingRow) {
      if (orderQM9StableJson(pendingRow.payload) !== orderQM9StableJson(row.payload)) {
        throw new Error(`ORDERQ_CENTRAL_MIGRATION_CONFLICT:${row.entityType}:${row.entityId}`);
      }
      return;
    }
    const existing = orderQM9ReadEntity(ss, row.entityType, row.entityId);
    if (existing && orderQM9StableJson(existing.payload) !== orderQM9StableJson(row.payload)) {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_CONFLICT:${row.entityType}:${row.entityId}`);
    }
    if (!existing) pending.set(entityKey, row);
  });
  const previous = [...pending.values()].map(row => ({
    entityType: row.entityType, entityId: row.entityId, value: orderQM9ReadEntity(ss, row.entityType, row.entityId)
  }));
  const previousSync = orderQM9MetaNumber(ss, 'syncSequence');
  const changeSheet = orderQEnsureSheet(ss, 'M9_CHANGE');
  const previousChangeLastRow = changeSheet.getLastRow();
  const commandSheet = orderQEnsureSheet(ss, 'M9_COMMAND');
  const txnId = `OQM9MIG-${Utilities.getUuid()}`;
  const txnSheet = orderQEnsureSheet(ss, 'M9_TXN_LOG');
  orderQWriteRow(txnSheet, txnId, [txnId, idempotencyKey, 'PREPARED', JSON.stringify(previous), JSON.stringify([...pending.values()]), '', new Date().toISOString()]);
  try {
    [...pending.values()].forEach(row => changes.push(orderQM9WriteEntity(ss, row)));
    if (orderQM9Text(payload.testFailureAt).toUpperCase() === 'ENTITIES_WRITTEN') {
      throw new Error('ORDERQ_CENTRAL_MIGRATION_FAILURE_INJECTED:ENTITIES_WRITTEN');
    }
    changes.forEach(row => orderQM9AppendChange(ss, payload.deviceId, idempotencyKey, row));
    if (orderQM9Text(payload.testFailureAt).toUpperCase() === 'CHANGES_WRITTEN') {
      throw new Error('ORDERQ_CENTRAL_MIGRATION_FAILURE_INJECTED:CHANGES_WRITTEN');
    }
    orderQM9WriteCommand(ss, {
      idempotencyKey, commandType: 'MIGRATION', fingerprint, status: 'COMMITTED',
      deviceId: orderQM9Text(payload.deviceId), result: { changes }
    });
    if (orderQM9Text(payload.testFailureAt).toUpperCase() === 'COMMAND_WRITTEN') {
      throw new Error('ORDERQ_CENTRAL_MIGRATION_FAILURE_INJECTED:COMMAND_WRITTEN');
    }
    orderQWriteRow(txnSheet, txnId, [txnId, idempotencyKey, 'COMMITTED', JSON.stringify(previous), JSON.stringify(changes), '', new Date().toISOString()]);
    return { duplicate: false, changes, cursor: orderQM9MetaNumber(ss, 'syncSequence') };
  } catch (error) {
    previous.forEach(entry => {
      const key = orderQM9EntityKey(entry.entityType, entry.entityId);
      const sheet = orderQEnsureSheet(ss, 'M9_ENTITY');
      if (entry.value) orderQM9WriteEntity(ss, entry.value);
      else orderQDeleteEntityRow(sheet, key);
    });
    orderQM9SetMetaNumber(ss, 'syncSequence', previousSync);
    while (changeSheet.getLastRow() > previousChangeLastRow) changeSheet.deleteRow(changeSheet.getLastRow());
    orderQDeleteEntityRow(commandSheet, idempotencyKey);
    orderQWriteRow(txnSheet, txnId, [txnId, idempotencyKey, 'ROLLED_BACK', JSON.stringify(previous), JSON.stringify(changes), String(error.message || error), new Date().toISOString()]);
    throw error;
  }
}

function orderQM9LeaseExpired(command, nowMillis) {
  const expiresAt = Date.parse(orderQM9Text(command && command.leaseExpiresAt));
  return !Number.isFinite(expiresAt) || expiresAt <= nowMillis;
}

function orderQM9ExpireStaleLeases(ss, nowMillis) {
  const sheet = orderQEnsureSheet(ss, 'M9_COMMAND');
  if (sheet.getLastRow() < 2) return;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDERQ_HEADERS.M9_COMMAND.length).getValues();
  rows.forEach(values => {
    try {
      const command = JSON.parse(String(values[10] || '{}'));
      if (command.status === 'PREPARED' && orderQM9LeaseExpired(command, nowMillis)) {
        command.status = 'EXPIRED';
        command.expiredAt = new Date(nowMillis).toISOString();
        orderQM9WriteCommand(ss, command);
      }
    } catch (error) {}
  });
}

function orderQM9Prepare(ss, payload) {
  orderQM9RequireSchema(payload);
  orderQEnsureAllSheets(ss);
  const preparedAtMillis = Date.now();
  orderQM9ExpireStaleLeases(ss, preparedAtMillis);
  const fingerprint = orderQM9CommandFingerprint(payload);
  const idempotencyKey = orderQM9Text(payload.idempotencyKey);
  const prior = orderQM9ReadCommand(ss, idempotencyKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error(`ORDERQ_CENTRAL_IDEMPOTENCY_CONFLICT:${idempotencyKey}`);
    if (prior.status === 'COMMITTED') return { duplicate: true, committed: true, result: prior.result };
    if (prior.status !== 'PREPARED') throw new Error(`ORDERQ_CENTRAL_COMMAND_TERMINAL:${idempotencyKey}:${prior.status}`);
    return { duplicate: true, committed: false, leaseToken: prior.leaseToken, leaseExpiresAt: prior.leaseExpiresAt, fingerprint };
  }
  const commandType = orderQM9Text(payload.commandType).toUpperCase();
  const aggregateId = orderQM9Text(payload.aggregateId);
  const expectedRevision = Number(payload.expectedRevision);
  const targetType = orderQM9TargetType(commandType);
  if (targetType) {
    const target = orderQM9ReadEntity(ss, targetType, aggregateId);
    if (!target) throw new Error(`ORDERQ_CENTRAL_TARGET_NOT_FOUND:${targetType}:${aggregateId}`);
    if (Number(target.revision || 0) !== expectedRevision) throw new Error(`ORDERQ_CENTRAL_REVISION_CONFLICT:${target.revision}`);
    if (!orderQM9AllowedState(commandType, orderQM9Text(target.status).toUpperCase())) {
      throw new Error(`ORDERQ_CENTRAL_STATE_CONFLICT:${target.status}`);
    }
  }
  const commandSheet = orderQEnsureSheet(ss, 'M9_COMMAND');
  if (commandSheet.getLastRow() >= 2) {
    const rows = commandSheet.getRange(2, 1, commandSheet.getLastRow() - 1, ORDERQ_HEADERS.M9_COMMAND.length).getValues();
    rows.forEach(values => {
      try {
        const row = JSON.parse(String(values[10] || '{}'));
        if (row.status === 'PREPARED' && row.aggregateId === aggregateId && row.idempotencyKey !== idempotencyKey) {
          throw new Error(`ORDERQ_CENTRAL_AGGREGATE_LOCKED:${aggregateId}`);
        }
      } catch (error) {
        if (String(error.message || error).indexOf('ORDERQ_CENTRAL_AGGREGATE_LOCKED') === 0) throw error;
      }
    });
  }
  const leaseToken = `LEASE-${Utilities.getUuid()}`;
  const preparedAt = new Date(preparedAtMillis).toISOString();
  const leaseExpiresAt = new Date(preparedAtMillis + ORDERQ_M9_LEASE_DURATION_MS).toISOString();
  orderQM9WriteCommand(ss, {
    idempotencyKey, commandType, aggregateId, expectedRevision, fingerprint,
    status: 'PREPARED', leaseToken, deviceId: orderQM9Text(payload.deviceId), intent: payload.intent || null,
    preparedAt, leaseExpiresAt,
    inventoryResourceFingerprint: orderQM9InventoryResourceFingerprint(ss)
  });
  return { duplicate: false, committed: false, leaseToken, leaseExpiresAt, fingerprint, serverRevision: expectedRevision };
}

function orderQM9ReadAllEntities(ss) {
  const sheet = orderQEnsureSheet(ss, 'M9_ENTITY');
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDERQ_HEADERS.M9_ENTITY.length).getValues().map(values => {
    try { return JSON.parse(String(values[6] || '{}')); } catch (error) { return null; }
  }).filter(Boolean);
}

function orderQM9RowsWithMutations(existingRows, mutations, entityType) {
  const rows = new Map(existingRows.filter(row => row.entityType === entityType).map(row => [row.entityId, row]));
  mutations.filter(row => row.entityType === entityType).forEach(row => rows.set(row.entityId, row));
  return [...rows.values()];
}

function orderQM9SameNumber(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= 1e-9;
}

function orderQM9RequireSameNumber(left, right, code, detail) {
  if (!orderQM9SameNumber(left, right)) throw new Error(`${code}${detail ? `:${detail}` : ''}`);
}

function orderQM9ValidateMutationEntityKeys(mutations) {
  const keys = new Set();
  mutations.forEach(row => {
    const key = orderQM9EntityKey(row.entityType, row.entityId);
    if (!orderQM9Text(row.entityType) || !orderQM9Text(row.entityId)) throw new Error(`ORDERQ_CENTRAL_MUTATION_INVALID:${row.entityType}:${row.entityId}`);
    if (keys.has(key)) throw new Error(`ORDERQ_CENTRAL_MUTATION_ENTITY_DUPLICATE:${row.entityType}:${row.entityId}`);
    keys.add(key);
  });
}

function orderQM9RequireExactIds(actualValues, expectedValues, code) {
  const actual = actualValues.map(orderQM9Text);
  const expected = expectedValues.map(orderQM9Text);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actual.some(value => !value) || expected.some(value => !value)
    || actualSet.size !== actual.length || expectedSet.size !== expected.length
    || actualSet.size !== expectedSet.size || [...expectedSet].some(value => !actualSet.has(value))) {
    throw new Error(code);
  }
}

function orderQM9ValidateDispatchConfirmation(existingRows, command, mutations) {
  const rows = type => mutations.filter(row => row.entityType === type);
  const all = type => orderQM9RowsWithMutations(existingRows, mutations, type);
  const documents = rows('SALES_DOCUMENT');
  const salesLines = rows('SALES_LINE');
  const movements = rows('INVENTORY_MOVEMENT');
  const events = rows('ORDER_EVENT').filter(row => orderQM9Text(row.payload.eventType).toUpperCase() === 'SALES_TRANSFER_ALLOCATED');
  const reservations = rows('INVENTORY_RESERVATION');
  const existingDispatchLines = existingRows.filter(row => row.entityType === 'DISPATCH_LINE'
    && orderQM9Text(row.payload.dispatchId) === command.aggregateId);
  const targetLineIds = existingDispatchLines.map(row => row.entityId);
  const targetLineIdSet = new Set(targetLineIds);
  const existingAllocations = existingRows.filter(row => row.entityType === 'DISPATCH_STOCK_ALLOCATION'
    && (orderQM9Text(row.payload.dispatchId) === command.aggregateId || targetLineIdSet.has(orderQM9Text(row.payload.dispatchLineId))));
  const targetAllocationIds = existingAllocations.map(row => row.entityId);
  const targetAllocationIdSet = new Set(targetAllocationIds);
  const changedDispatchLines = rows('DISPATCH_LINE').filter(row => orderQM9Text(row.payload.dispatchId) === command.aggregateId);
  const changedAllocations = rows('DISPATCH_STOCK_ALLOCATION').filter(row => orderQM9Text(row.payload.dispatchId) === command.aggregateId
    || targetAllocationIdSet.has(row.entityId));
  if (documents.length !== 1 || !salesLines.length || !movements.length || !events.length || !reservations.length) {
    throw new Error('ORDERQ_CENTRAL_CONFIRM_RESULT_INCOMPLETE');
  }
  if (!targetLineIds.length || !targetAllocationIds.length) throw new Error('ORDERQ_CENTRAL_CONFIRM_TARGET_INCOMPLETE');
  orderQM9RequireExactIds(salesLines.map(row => row.payload.dispatchLineId), targetLineIds, 'ORDERQ_CENTRAL_CONFIRM_LINE_SET_MISMATCH');
  orderQM9RequireExactIds(changedDispatchLines.map(row => row.entityId), targetLineIds, 'ORDERQ_CENTRAL_CONFIRM_LINE_STATE_SET_MISMATCH');
  orderQM9RequireExactIds(movements.map(row => row.payload.sourceLineId), targetAllocationIds, 'ORDERQ_CENTRAL_CONFIRM_ALLOCATION_MOVEMENT_SET_MISMATCH');
  orderQM9RequireExactIds(changedAllocations.map(row => row.entityId), targetAllocationIds, 'ORDERQ_CENTRAL_CONFIRM_ALLOCATION_STATE_SET_MISMATCH');
  orderQM9RequireExactIds(reservations.map(row => row.payload.allocationId), targetAllocationIds, 'ORDERQ_CENTRAL_CONFIRM_RESERVATION_SET_MISMATCH');
  orderQM9RequireExactIds(events.map(row => row.payload.detail && row.payload.detail.salesLineId), salesLines.map(row => row.entityId), 'ORDERQ_CENTRAL_CONFIRM_FULFILLMENT_SET_MISMATCH');
  if (changedDispatchLines.some(row => orderQM9Text(row.payload.status).toUpperCase() !== 'CONFIRMED')
    || changedAllocations.some(row => orderQM9Text(row.payload.status).toUpperCase() !== 'CONFIRMED')) {
    throw new Error('ORDERQ_CENTRAL_CONFIRM_TARGET_STATE_INVALID');
  }
  const document = documents[0].payload;
  if (orderQM9Text(document.dispatchId) !== command.aggregateId || orderQM9Text(document.erpPostingStatus).toUpperCase() !== 'READY') {
    throw new Error('ORDERQ_CENTRAL_CONFIRM_RESULT_INVALID');
  }
  const dispatchLineById = new Map(all('DISPATCH_LINE').map(row => [row.entityId, row.payload]));
  const allocationById = new Map(all('DISPATCH_STOCK_ALLOCATION').map(row => [row.entityId, row.payload]));
  const reservationByAllocation = new Map(reservations.map(row => [orderQM9Text(row.payload.allocationId), row.payload]));
  const salesLineIds = new Set(salesLines.map(row => row.entityId));
  salesLines.forEach(salesRow => {
    const line = salesRow.payload;
    const dispatchLine = dispatchLineById.get(orderQM9Text(line.dispatchLineId));
    if (!dispatchLine || orderQM9Text(line.salesDocumentId) !== orderQM9Text(document.salesDocumentId)
      || orderQM9Text(dispatchLine.dispatchId) !== command.aggregateId
      || orderQM9Text(line.productId || line.actualProductId) !== orderQM9Text(dispatchLine.actualProductId || dispatchLine.productId)) {
      throw new Error(`ORDERQ_CENTRAL_CONFIRM_SALES_LINK_INVALID:${salesRow.entityId}`);
    }
    orderQM9RequireSameNumber(line.actualQuantity !== undefined ? line.actualQuantity : line.quantity, dispatchLine.actualQuantity, 'ORDERQ_CENTRAL_CONFIRM_ACTUAL_QUANTITY_MISMATCH', salesRow.entityId);
    orderQM9RequireSameNumber(line.actualBaseQuantity, dispatchLine.actualBaseQuantity, 'ORDERQ_CENTRAL_CONFIRM_BASE_QUANTITY_MISMATCH', salesRow.entityId);
    orderQM9RequireSameNumber(line.recognizedOrderQuantity, dispatchLine.recognizedOrderQuantity, 'ORDERQ_CENTRAL_CONFIRM_RECOGNIZED_QUANTITY_MISMATCH', salesRow.entityId);
    const lineMovements = movements.filter(row => orderQM9Text(row.payload.dispatchLineId) === orderQM9Text(line.dispatchLineId));
    if (!lineMovements.length) throw new Error(`ORDERQ_CENTRAL_CONFIRM_MOVEMENT_LINK_REQUIRED:${salesRow.entityId}`);
    orderQM9RequireSameNumber(lineMovements.reduce((sum, row) => sum + Number(row.payload.signedBaseQuantity || 0), 0), -Number(line.actualBaseQuantity || 0), 'ORDERQ_CENTRAL_CONFIRM_MOVEMENT_QUANTITY_MISMATCH', salesRow.entityId);
    lineMovements.forEach(movementRow => {
      const movement = movementRow.payload;
      const allocation = allocationById.get(orderQM9Text(movement.sourceLineId));
      const reservation = reservationByAllocation.get(orderQM9Text(movement.sourceLineId));
      if (orderQM9Text(movement.movementType).toUpperCase() !== 'SALE_ISSUE' || !(Number(movement.signedBaseQuantity || 0) < 0)
        || orderQM9Text(movement.dispatchId) !== command.aggregateId
        || orderQM9Text(movement.productId) !== orderQM9Text(line.productId || line.actualProductId)
        || !allocation || orderQM9Text(allocation.dispatchLineId) !== orderQM9Text(line.dispatchLineId)
        || orderQM9Text(allocation.warehouseId) !== orderQM9Text(movement.warehouseId)
        || !reservation || orderQM9Text(reservation.status).toUpperCase() !== 'CONSUMED') {
        throw new Error(`ORDERQ_CENTRAL_CONFIRM_MOVEMENT_LINK_INVALID:${movementRow.entityId}`);
      }
      orderQM9RequireSameNumber(Math.abs(Number(movement.signedBaseQuantity || 0)), allocation.actualBaseQuantity, 'ORDERQ_CENTRAL_CONFIRM_ALLOCATION_QUANTITY_MISMATCH', movementRow.entityId);
      orderQM9RequireSameNumber(Math.abs(Number(movement.signedBaseQuantity || 0)), reservation.consumedBaseQuantity !== undefined ? reservation.consumedBaseQuantity : reservation.reservedBaseQuantity, 'ORDERQ_CENTRAL_CONFIRM_RESERVATION_QUANTITY_MISMATCH', movementRow.entityId);
    });
    const allocationEvent = events.find(row => orderQM9Text(row.payload.detail && row.payload.detail.salesLineId) === salesRow.entityId);
    if (!allocationEvent || orderQM9Text(allocationEvent.payload.eventType).toUpperCase() !== 'SALES_TRANSFER_ALLOCATED'
      || orderQM9Text(allocationEvent.payload.detail && allocationEvent.payload.detail.orderItemId) !== orderQM9Text(line.orderItemId || dispatchLine.orderItemId)) {
      throw new Error(`ORDERQ_CENTRAL_CONFIRM_FULFILLMENT_LINK_INVALID:${salesRow.entityId}`);
    }
    orderQM9RequireSameNumber(allocationEvent.payload.detail && allocationEvent.payload.detail.transferredQty, line.recognizedOrderQuantity, 'ORDERQ_CENTRAL_CONFIRM_FULFILLMENT_QUANTITY_MISMATCH', salesRow.entityId);
  });
  if (movements.some(row => !salesLines.some(line => orderQM9Text(line.payload.dispatchLineId) === orderQM9Text(row.payload.dispatchLineId)))
    || events.some(row => !salesLineIds.has(orderQM9Text(row.payload.detail && row.payload.detail.salesLineId)))) {
    throw new Error('ORDERQ_CENTRAL_CONFIRM_ORPHAN_RESULT');
  }
  const postDispatchLines = all('DISPATCH_LINE').filter(row => targetLineIdSet.has(row.entityId));
  const postAllocations = all('DISPATCH_STOCK_ALLOCATION').filter(row => targetAllocationIdSet.has(row.entityId));
  const postReservations = all('INVENTORY_RESERVATION').filter(row => orderQM9Text(row.payload.dispatchId) === command.aggregateId
    || targetAllocationIdSet.has(orderQM9Text(row.payload.allocationId)));
  if (postDispatchLines.length !== targetLineIds.length || postDispatchLines.some(row => orderQM9Text(row.payload.status).toUpperCase() !== 'CONFIRMED')
    || postAllocations.length !== targetAllocationIds.length || postAllocations.some(row => orderQM9Text(row.payload.status).toUpperCase() !== 'CONFIRMED')
    || postReservations.some(row => orderQM9Text(row.payload.status).toUpperCase() === 'ACTIVE')) {
    throw new Error('ORDERQ_CENTRAL_CONFIRM_POST_STATE_INCOMPLETE');
  }
  orderQM9RequireSameNumber(document.supplyAmountWon, salesLines.reduce((sum, row) => sum + Number(row.payload.supplyAmountWon || 0), 0), 'ORDERQ_CENTRAL_CONFIRM_SUPPLY_AMOUNT_MISMATCH');
  orderQM9RequireSameNumber(document.vatAmountWon, salesLines.reduce((sum, row) => sum + Number(row.payload.vatAmountWon || 0), 0), 'ORDERQ_CENTRAL_CONFIRM_VAT_AMOUNT_MISMATCH');
  orderQM9RequireSameNumber(document.totalAmountWon, salesLines.reduce((sum, row) => sum + Number(row.payload.totalAmountWon || 0), 0), 'ORDERQ_CENTRAL_CONFIRM_TOTAL_AMOUNT_MISMATCH');
}

function orderQM9ValidatePurchaseConfirmation(existingRows, command, mutations) {
  const rows = type => mutations.filter(row => row.entityType === type);
  const all = type => orderQM9RowsWithMutations(existingRows, mutations, type);
  const purchase = rows('PURCHASE_DOCUMENT').find(row => row.entityId === command.aggregateId);
  const lines = rows('PURCHASE_LINE').filter(row => orderQM9Text(row.payload.purchaseDocumentId) === command.aggregateId);
  const movements = rows('INVENTORY_MOVEMENT');
  const existingLines = existingRows.filter(row => row.entityType === 'PURCHASE_LINE'
    && orderQM9Text(row.payload.purchaseDocumentId) === command.aggregateId);
  const targetLineIds = existingLines.map(row => row.entityId);
  if (!purchase || orderQM9Text(purchase.payload.status).toUpperCase() !== 'CONFIRMED'
    || orderQM9Text(purchase.payload.erpPostingStatus).toUpperCase() !== 'READY'
    || !lines.length || movements.length !== lines.length) throw new Error('ORDERQ_CENTRAL_PURCHASE_RESULT_INVALID');
  if (!targetLineIds.length) throw new Error('ORDERQ_CENTRAL_PURCHASE_TARGET_INCOMPLETE');
  orderQM9RequireExactIds(lines.map(row => row.entityId), targetLineIds, 'ORDERQ_CENTRAL_PURCHASE_LINE_SET_MISMATCH');
  orderQM9RequireExactIds(movements.map(row => row.payload.sourceLineId), targetLineIds, 'ORDERQ_CENTRAL_PURCHASE_MOVEMENT_SET_MISMATCH');
  if (lines.some(row => orderQM9Text(row.payload.status).toUpperCase() !== 'CONFIRMED')) throw new Error('ORDERQ_CENTRAL_PURCHASE_LINE_STATE_INVALID');
  const movementByLine = new Map(movements.map(row => [orderQM9Text(row.payload.sourceLineId), row]));
  lines.forEach(lineRow => {
    const line = lineRow.payload;
    const movementRow = movementByLine.get(lineRow.entityId);
    const movement = movementRow && movementRow.payload;
    if (!movement || orderQM9Text(movement.movementType).toUpperCase() !== 'PURCHASE_RECEIPT'
      || orderQM9Text(movement.sourceDocumentId) !== command.aggregateId
      || orderQM9Text(movement.productId) !== orderQM9Text(line.productId)
      || orderQM9Text(movement.warehouseId) !== orderQM9Text(line.warehouseId)
      || orderQM9Text(line.movementId) !== movementRow.entityId
      || !(Number(movement.signedBaseQuantity || 0) > 0)) {
      throw new Error(`ORDERQ_CENTRAL_PURCHASE_LINE_LINK_INVALID:${lineRow.entityId}`);
    }
    orderQM9RequireSameNumber(movement.signedBaseQuantity, line.baseQuantity, 'ORDERQ_CENTRAL_PURCHASE_QUANTITY_MISMATCH', lineRow.entityId);
  });
  const targetLineIdSet = new Set(targetLineIds);
  const postLines = all('PURCHASE_LINE').filter(row => targetLineIdSet.has(row.entityId));
  if (postLines.length !== targetLineIds.length || postLines.some(row => orderQM9Text(row.payload.status).toUpperCase() !== 'CONFIRMED')) {
    throw new Error('ORDERQ_CENTRAL_PURCHASE_POST_STATE_INCOMPLETE');
  }
  orderQM9RequireSameNumber(purchase.payload.amountWon, lines.reduce((sum, row) => sum + Number(row.payload.amountWon || 0), 0), 'ORDERQ_CENTRAL_PURCHASE_AMOUNT_MISMATCH');
}

function orderQM9ValidateDispatchReversal(existingRows, command, mutations) {
  const rows = type => mutations.filter(row => row.entityType === type);
  const originalDocuments = existingRows.filter(row => row.entityType === 'SALES_DOCUMENT' && orderQM9Text(row.payload.dispatchId) === command.aggregateId);
  const originalLines = existingRows.filter(row => row.entityType === 'SALES_LINE' && originalDocuments.some(document => orderQM9Text(row.payload.salesDocumentId) === document.entityId));
  const allLines = existingRows.filter(row => row.entityType === 'SALES_LINE');
  const originalMovements = existingRows.filter(row => row.entityType === 'INVENTORY_MOVEMENT'
    && orderQM9Text(row.payload.dispatchId) === command.aggregateId && orderQM9Text(row.payload.movementType).toUpperCase() === 'SALE_ISSUE');
  const allMovements = existingRows.filter(row => row.entityType === 'INVENTORY_MOVEMENT');
  const reversalLines = rows('SALES_LINE');
  const reversalMovements = rows('INVENTORY_MOVEMENT');
  const events = rows('ORDER_EVENT').filter(row => orderQM9Text(row.payload.eventType).toUpperCase() === 'SALES_TRANSFER_REVERSED');
  if (!reversalLines.length || !reversalMovements.length || !events.length) throw new Error('ORDERQ_CENTRAL_DISPATCH_REVERSAL_RESULT_INVALID');
  reversalLines.forEach(row => {
    const original = originalLines.find(candidate => candidate.entityId === orderQM9Text(row.payload.reversalOf));
    if (!original || Number(row.payload.actualQuantity || 0) >= 0 || Number(row.payload.actualBaseQuantity || 0) >= 0 || Number(row.payload.recognizedOrderQuantity || 0) >= 0) {
      throw new Error(`ORDERQ_CENTRAL_DISPATCH_REVERSAL_LINE_INVALID:${row.entityId}`);
    }
    ['actualQuantity','actualBaseQuantity','recognizedOrderQuantity','supplyAmountWon','vatAmountWon','totalAmountWon'].forEach(field => {
      const previous = allLines.filter(candidate => orderQM9Text(candidate.payload.reversalOf) === original.entityId)
        .reduce((sum, candidate) => sum + Math.abs(Number(candidate.payload[field] || 0)), 0);
      if (previous + Math.abs(Number(row.payload[field] || 0)) > Math.abs(Number(original.payload[field] || 0)) + 1e-9) {
        throw new Error(`ORDERQ_CENTRAL_DISPATCH_REVERSAL_EXCEEDS_ORIGINAL:${row.entityId}:${field}`);
      }
    });
    const movementTotal = reversalMovements.filter(candidate => orderQM9Text(candidate.payload.dispatchLineId) === orderQM9Text(row.payload.dispatchLineId))
      .reduce((sum, candidate) => sum + Number(candidate.payload.signedBaseQuantity || 0), 0);
    orderQM9RequireSameNumber(movementTotal, Math.abs(Number(row.payload.actualBaseQuantity || 0)), 'ORDERQ_CENTRAL_DISPATCH_REVERSAL_MOVEMENT_MISMATCH', row.entityId);
    const event = events.find(candidate => orderQM9Text(candidate.payload.detail && candidate.payload.detail.salesLineId) === row.entityId);
    if (!event) throw new Error(`ORDERQ_CENTRAL_DISPATCH_REVERSAL_EVENT_REQUIRED:${row.entityId}`);
    orderQM9RequireSameNumber(event.payload.detail && event.payload.detail.transferredQty, Math.abs(Number(row.payload.recognizedOrderQuantity || 0)), 'ORDERQ_CENTRAL_DISPATCH_REVERSAL_EVENT_MISMATCH', row.entityId);
  });
  reversalMovements.forEach(row => {
    const original = originalMovements.find(candidate => candidate.entityId === orderQM9Text(row.payload.reversalOf));
    const previous = allMovements.filter(candidate => orderQM9Text(candidate.payload.reversalOf) === orderQM9Text(row.payload.reversalOf))
      .reduce((sum, candidate) => sum + Math.abs(Number(candidate.payload.signedBaseQuantity || 0)), 0);
    if (!original || orderQM9Text(row.payload.movementType).toUpperCase() !== 'REVERSAL' || !(Number(row.payload.signedBaseQuantity || 0) > 0)
      || orderQM9Text(row.payload.productId) !== orderQM9Text(original.payload.productId)
      || orderQM9Text(row.payload.warehouseId) !== orderQM9Text(original.payload.warehouseId)
      || previous + Number(row.payload.signedBaseQuantity || 0) > Math.abs(Number(original.payload.signedBaseQuantity || 0)) + 1e-9) {
      throw new Error(`ORDERQ_CENTRAL_DISPATCH_REVERSAL_MOVEMENT_INVALID:${row.entityId}`);
    }
  });
}

function orderQM9ValidatePurchaseReversal(existingRows, command, mutations) {
  const rows = type => mutations.filter(row => row.entityType === type);
  const originalLines = existingRows.filter(row => row.entityType === 'PURCHASE_LINE' && orderQM9Text(row.payload.purchaseDocumentId) === command.aggregateId);
  const allLines = existingRows.filter(row => row.entityType === 'PURCHASE_LINE');
  const allMovements = existingRows.filter(row => row.entityType === 'INVENTORY_MOVEMENT');
  const reversalLines = rows('PURCHASE_LINE');
  const reversalMovements = rows('INVENTORY_MOVEMENT');
  if (!reversalLines.length || reversalMovements.length !== reversalLines.length) throw new Error('ORDERQ_CENTRAL_PURCHASE_REVERSAL_RESULT_INVALID');
  const movementByLine = new Map(reversalMovements.map(row => [orderQM9Text(row.payload.sourceLineId), row]));
  reversalLines.forEach(row => {
    const original = originalLines.find(candidate => candidate.entityId === orderQM9Text(row.payload.reversalOf));
    const movementRow = movementByLine.get(row.entityId);
    const movement = movementRow && movementRow.payload;
    if (!original || Number(row.payload.quantity || 0) >= 0 || Number(row.payload.baseQuantity || 0) >= 0 || Number(row.payload.amountWon || 0) > 0
      || !movement || orderQM9Text(row.payload.movementId) !== movementRow.entityId
      || orderQM9Text(movement.reversalOf) !== orderQM9Text(original.payload.movementId)
      || orderQM9Text(movement.movementType).toUpperCase() !== 'REVERSAL' || !(Number(movement.signedBaseQuantity || 0) < 0)
      || orderQM9Text(movement.productId) !== orderQM9Text(original.payload.productId)
      || orderQM9Text(movement.warehouseId) !== orderQM9Text(original.payload.warehouseId)) {
      throw new Error(`ORDERQ_CENTRAL_PURCHASE_REVERSAL_LINE_INVALID:${row.entityId}`);
    }
    orderQM9RequireSameNumber(movement.signedBaseQuantity, row.payload.baseQuantity, 'ORDERQ_CENTRAL_PURCHASE_REVERSAL_MOVEMENT_MISMATCH', row.entityId);
    ['quantity','baseQuantity','amountWon'].forEach(field => {
      const previous = allLines.filter(candidate => orderQM9Text(candidate.payload.reversalOf) === original.entityId)
        .reduce((sum, candidate) => sum + Math.abs(Number(candidate.payload[field] || 0)), 0);
      if (previous + Math.abs(Number(row.payload[field] || 0)) > Math.abs(Number(original.payload[field] || 0)) + 1e-9) {
        throw new Error(`ORDERQ_CENTRAL_PURCHASE_REVERSAL_EXCEEDS_ORIGINAL:${row.entityId}:${field}`);
      }
    });
    const originalMovement = allMovements.find(candidate => candidate.entityId === orderQM9Text(original.payload.movementId));
    const previousMovement = allMovements.filter(candidate => orderQM9Text(candidate.payload.reversalOf) === orderQM9Text(original.payload.movementId))
      .reduce((sum, candidate) => sum + Math.abs(Number(candidate.payload.signedBaseQuantity || 0)), 0);
    if (!originalMovement || previousMovement + Math.abs(Number(movement.signedBaseQuantity || 0)) > Math.abs(Number(originalMovement.payload.signedBaseQuantity || 0)) + 1e-9) {
      throw new Error(`ORDERQ_CENTRAL_PURCHASE_REVERSAL_MOVEMENT_EXCEEDS_ORIGINAL:${row.entityId}`);
    }
  });
}

function orderQM9ValidateCommit(ss, command, mutations) {
  const existingRows = orderQM9ReadAllEntities(ss);
  const rows = type => mutations.filter(row => row.entityType === type);
  const decision = rows('DISPATCH_DECISION').find(row => row.entityId === command.aggregateId);
  const purchase = rows('PURCHASE_DOCUMENT').find(row => row.entityId === command.aggregateId);
  if (command.commandType === 'RELEASE_DISPATCH') {
    if (!decision || orderQM9Text(decision.payload.status).toUpperCase() !== 'RELEASED' || !rows('INVENTORY_RESERVATION').length) {
      throw new Error('ORDERQ_CENTRAL_RELEASE_RESULT_INVALID');
    }
    if (rows('INVENTORY_MOVEMENT').length || rows('SALES_DOCUMENT').length || rows('ORDER_EVENT').length) {
      throw new Error('ORDERQ_CENTRAL_RELEASE_SIDE_EFFECT_FORBIDDEN');
    }
  }
  if (command.commandType === 'CONFIRM_DISPATCH') {
    const documents = rows('SALES_DOCUMENT');
    const movements = rows('INVENTORY_MOVEMENT');
    const events = rows('ORDER_EVENT').filter(row => orderQM9Text(row.payload.eventType).toUpperCase() === 'SALES_TRANSFER_ALLOCATED');
    if (!decision || orderQM9Text(decision.payload.status).toUpperCase() !== 'CONFIRMED'
      || documents.length !== 1 || !movements.length || !events.length) throw new Error('ORDERQ_CENTRAL_CONFIRM_RESULT_INCOMPLETE');
    if (orderQM9Text(documents[0].payload.erpPostingStatus).toUpperCase() !== 'READY'
      || movements.some(row => row.payload.movementType !== 'SALE_ISSUE' || Number(row.payload.signedBaseQuantity || 0) > 0)
      || rows('INVENTORY_RESERVATION').some(row => orderQM9Text(row.payload.status).toUpperCase() !== 'CONSUMED')) {
      throw new Error('ORDERQ_CENTRAL_CONFIRM_RESULT_INVALID');
    }
    orderQM9ValidateDispatchConfirmation(existingRows, command, mutations);
  }
  if (command.commandType === 'CONFIRM_PURCHASE') {
    const movements = rows('INVENTORY_MOVEMENT');
    if (!purchase || orderQM9Text(purchase.payload.status).toUpperCase() !== 'CONFIRMED'
      || orderQM9Text(purchase.payload.erpPostingStatus).toUpperCase() !== 'READY'
      || !movements.length || movements.some(row => row.payload.movementType !== 'PURCHASE_RECEIPT'
        || Number(row.payload.signedBaseQuantity || 0) < 0)) throw new Error('ORDERQ_CENTRAL_PURCHASE_RESULT_INVALID');
    orderQM9ValidatePurchaseConfirmation(existingRows, command, mutations);
  }
  if (command.commandType === 'REVERSE_DISPATCH') {
    const reversalDecision = rows('DISPATCH_DECISION').find(row => row.payload.reversalOf === command.aggregateId);
    const salesDocument = rows('SALES_DOCUMENT').find(row => row.payload.reversalOf);
    const movements = rows('INVENTORY_MOVEMENT');
    const events = rows('ORDER_EVENT').filter(row => row.payload.eventType === 'SALES_TRANSFER_REVERSED');
    if (!reversalDecision || orderQM9Text(reversalDecision.payload.status).toUpperCase() !== 'CONFIRMED'
      || !salesDocument || orderQM9Text(salesDocument.payload.status).toUpperCase() !== 'REVERSED'
      || !movements.length || movements.some(row => row.payload.movementType !== 'REVERSAL')
      || !events.length) throw new Error('ORDERQ_CENTRAL_DISPATCH_REVERSAL_RESULT_INVALID');
    orderQM9ValidateDispatchReversal(existingRows, command, mutations);
  }
  if (command.commandType === 'REVERSE_PURCHASE') {
    const reversalDocument = rows('PURCHASE_DOCUMENT').find(row => row.payload.reversalOf === command.aggregateId);
    const movements = rows('INVENTORY_MOVEMENT');
    if (!reversalDocument || orderQM9Text(reversalDocument.payload.status).toUpperCase() !== 'REVERSED'
      || !movements.length || movements.some(row => row.payload.movementType !== 'REVERSAL'
        || Number(row.payload.signedBaseQuantity || 0) > 0)) {
      throw new Error('ORDERQ_CENTRAL_PURCHASE_REVERSAL_RESULT_INVALID');
    }
    orderQM9ValidatePurchaseReversal(existingRows, command, mutations);
  }
  if (command.commandType === 'ADJUST_DISPATCH') {
    if (!rows('DISPATCH_RECONCILIATION').length
      || rows('INVENTORY_MOVEMENT').some(row => row.payload.movementType !== 'REVERSAL')
      || rows('DISPATCH_DECISION').some(row => row.entityId === command.aggregateId)) {
      throw new Error('ORDERQ_CENTRAL_DISPATCH_ADJUSTMENT_RESULT_INVALID');
    }
  }
  if (['UPDATE_DISPATCH', 'RECALL_DISPATCH'].indexOf(command.commandType) >= 0
    && (rows('INVENTORY_MOVEMENT').length || rows('SALES_DOCUMENT').length
      || rows('PURCHASE_DOCUMENT').length || rows('ORDER_EVENT').length)) {
    throw new Error('ORDERQ_CENTRAL_UPDATE_MOVEMENT_FORBIDDEN');
  }
  if (command.commandType === 'RECONCILE_PURCHASE_EXTERNAL' && rows('INVENTORY_MOVEMENT').length) {
    throw new Error('ORDERQ_CENTRAL_PURCHASE_RECONCILIATION_MOVEMENT_FORBIDDEN');
  }
}

function orderQM9Commit(ss, payload) {
  orderQM9RequireSchema(payload);
  orderQEnsureAllSheets(ss);
  const idempotencyKey = orderQM9Text(payload.idempotencyKey);
  const command = orderQM9ReadCommand(ss, idempotencyKey);
  if (!command) throw new Error(`ORDERQ_CENTRAL_COMMAND_NOT_PREPARED:${idempotencyKey}`);
  if (command.leaseToken !== orderQM9Text(payload.leaseToken)) throw new Error(`ORDERQ_CENTRAL_LEASE_INVALID:${idempotencyKey}`);
  if (command.fingerprint !== orderQM9Text(payload.fingerprint)) throw new Error(`ORDERQ_CENTRAL_IDEMPOTENCY_CONFLICT:${idempotencyKey}`);
  const commitAtMillis = Date.now();
  const mutations = (Array.isArray(payload.mutations) ? payload.mutations : []).map(row => ({
    entityType: orderQM9Text(row.entityType).toUpperCase(), entityId: orderQM9Text(row.entityId),
    revision: Number(row.revision || 0), payload: JSON.parse(JSON.stringify(row.payload || null))
  }));
  mutations.forEach(row => {
    if (ORDERQ_M9_OFFICIAL_TYPES.indexOf(row.entityType) < 0 || !row.entityId || !row.payload) {
      throw new Error(`ORDERQ_CENTRAL_MUTATION_INVALID:${row.entityType}:${row.entityId}`);
    }
  });
  orderQM9ValidateMutationEntityKeys(mutations);
  const mutationFingerprint = orderQM9StableJson(mutations.map(row => ({
    entityType: row.entityType, entityId: row.entityId, revision: row.revision, payload: row.payload
  })).sort((a, b) => orderQM9EntityKey(a.entityType, a.entityId).localeCompare(orderQM9EntityKey(b.entityType, b.entityId))));
  if (command.status === 'COMMITTED') {
    if (command.mutationFingerprint !== mutationFingerprint) {
      throw new Error(`ORDERQ_CENTRAL_MUTATION_IDEMPOTENCY_CONFLICT:${idempotencyKey}`);
    }
    return Object.assign({ duplicate: true }, command.result || {});
  }
  if (command.status !== 'PREPARED') throw new Error(`ORDERQ_CENTRAL_COMMAND_TERMINAL:${idempotencyKey}:${command.status}`);
  if (orderQM9LeaseExpired(command, commitAtMillis)) {
    command.status = 'EXPIRED';
    command.expiredAt = new Date(commitAtMillis).toISOString();
    orderQM9WriteCommand(ss, command);
    throw new Error(`ORDERQ_CENTRAL_LEASE_EXPIRED:${idempotencyKey}`);
  }
  if (command.inventoryResourceFingerprint !== orderQM9InventoryResourceFingerprint(ss)) {
    throw new Error(`ORDERQ_CENTRAL_INVENTORY_REVISION_CONFLICT:${command.aggregateId}`);
  }
  const previousCommand = JSON.parse(JSON.stringify(command));
  orderQM9ValidateCommit(ss, command, mutations);
  const targetType = orderQM9TargetType(command.commandType);
  if (targetType) {
    const current = orderQM9ReadEntity(ss, targetType, command.aggregateId);
    if (!current || Number(current.revision || 0) !== Number(command.expectedRevision || 0)) {
      throw new Error(`ORDERQ_CENTRAL_REVISION_CONFLICT:${current && current.revision || 0}`);
    }
  }
  const previous = mutations.map(row => ({
    entityType: row.entityType, entityId: row.entityId, value: orderQM9ReadEntity(ss, row.entityType, row.entityId)
  }));
  previous.forEach((entry, index) => {
    const row = mutations[index];
    if (command.commandType === 'ERP_TRANSITION') {
      if (!entry.value || ['SALES_DOCUMENT', 'PURCHASE_DOCUMENT'].indexOf(row.entityType) < 0
        || row.payload.baseRevision === undefined
        || Number(row.payload.baseRevision) !== Number(entry.value.revision || 0)
        || !orderQM9ErpTransitionAllowed(entry.value.payload && entry.value.payload.erpPostingStatus, row.payload.erpPostingStatus)) {
        throw new Error(`ORDERQ_CENTRAL_ERP_TRANSITION_INVALID:${row.entityType}:${row.entityId}:${entry.value && entry.value.revision || 0}`);
      }
    }
  });
  const previousLedger = orderQM9MetaNumber(ss, 'ledgerSequence');
  const previousSync = orderQM9MetaNumber(ss, 'syncSequence');
  const changeSheet = orderQEnsureSheet(ss, 'M9_CHANGE');
  const previousChangeLastRow = changeSheet.getLastRow();
  let ledgerSequence = previousLedger;
  mutations.forEach(row => {
    if (row.entityType === 'INVENTORY_MOVEMENT') {
      delete row.payload.ledgerSequence;
      ledgerSequence += 1;
      row.payload.ledgerSequence = ledgerSequence;
      row.revision = Math.max(row.revision, ledgerSequence);
    }
    row.payload.centralRevision = row.revision;
    row.payload.localOnly = false;
  });
  const txnId = `OQM9TX-${Utilities.getUuid()}`;
  const txnSheet = orderQEnsureSheet(ss, 'M9_TXN_LOG');
  orderQWriteRow(txnSheet, txnId, [txnId, idempotencyKey, 'PREPARED', JSON.stringify(previous), JSON.stringify(mutations), '', new Date().toISOString()]);
  try {
    mutations.forEach(row => orderQM9WriteEntity(ss, row));
    orderQM9SetMetaNumber(ss, 'ledgerSequence', ledgerSequence);
    if (orderQM9Text(payload.testFailureAt).toUpperCase() === 'ENTITIES_WRITTEN') throw new Error('ORDERQ_CENTRAL_FAILURE_INJECTED:ENTITIES_WRITTEN');
    let cursor = orderQM9MetaNumber(ss, 'syncSequence');
    mutations.forEach(row => { cursor = orderQM9AppendChange(ss, command.deviceId, idempotencyKey, row); });
    const result = { changes: mutations, cursor, ledgerSequence, serverRevision: Math.max(command.expectedRevision, ...mutations.filter(row => row.entityId === command.aggregateId).map(row => row.revision)) };
    command.status = 'COMMITTED';
    command.mutationFingerprint = mutationFingerprint;
    command.committedAt = new Date().toISOString();
    command.result = result;
    orderQM9WriteCommand(ss, command);
    if (orderQM9Text(payload.testFailureAt).toUpperCase() === 'COMMAND_WRITTEN') throw new Error('ORDERQ_CENTRAL_FAILURE_INJECTED:COMMAND_WRITTEN');
    orderQWriteRow(txnSheet, txnId, [txnId, idempotencyKey, 'COMMITTED', JSON.stringify(previous), JSON.stringify(mutations), '', new Date().toISOString()]);
    return Object.assign({ duplicate: false }, result);
  } catch (error) {
    previous.forEach(entry => {
      const key = orderQM9EntityKey(entry.entityType, entry.entityId);
      const sheet = orderQEnsureSheet(ss, 'M9_ENTITY');
      if (entry.value) orderQM9WriteEntity(ss, entry.value);
      else orderQDeleteEntityRow(sheet, key);
    });
    orderQM9SetMetaNumber(ss, 'ledgerSequence', previousLedger);
    orderQM9SetMetaNumber(ss, 'syncSequence', previousSync);
    while (changeSheet.getLastRow() > previousChangeLastRow) changeSheet.deleteRow(changeSheet.getLastRow());
    orderQM9WriteCommand(ss, previousCommand);
    orderQWriteRow(txnSheet, txnId, [txnId, idempotencyKey, 'ROLLED_BACK', JSON.stringify(previous), JSON.stringify(mutations), String(error.message || error), new Date().toISOString()]);
    throw error;
  }
}

function orderQM9Abort(ss, payload) {
  orderQM9RequireSchema(payload);
  const command = orderQM9ReadCommand(ss, payload.idempotencyKey);
  if (!command || command.status === 'COMMITTED') return { aborted: false };
  if (command.leaseToken !== orderQM9Text(payload.leaseToken)) throw new Error('ORDERQ_CENTRAL_LEASE_INVALID');
  if (command.status !== 'PREPARED') return { aborted: false, status: command.status };
  const abortedAtMillis = Date.now();
  if (orderQM9LeaseExpired(command, abortedAtMillis)) {
    command.status = 'EXPIRED';
    command.expiredAt = new Date(abortedAtMillis).toISOString();
    orderQM9WriteCommand(ss, command);
    return { aborted: false, status: 'EXPIRED' };
  }
  command.status = 'ABORTED';
  command.abortReason = orderQM9Text(payload.reason);
  command.abortedAt = new Date(abortedAtMillis).toISOString();
  orderQM9WriteCommand(ss, command);
  return { aborted: true };
}

function orderQM9Pull(ss, payload) {
  orderQM9RequireSchema(payload);
  orderQEnsureAllSheets(ss);
  const after = Math.max(0, Number(payload.afterSequence || 0));
  const limit = Math.min(500, Math.max(1, Number(payload.limit || 500)));
  const sheet = orderQEnsureSheet(ss, 'M9_CHANGE');
  if (sheet.getLastRow() < 2) return { changes: [], nextCursor: after, hasMore: false, ledgerSequence: orderQM9MetaNumber(ss, 'ledgerSequence') };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDERQ_HEADERS.M9_CHANGE.length).getValues()
    .filter(row => Number(row[0] || 0) > after);
  const selected = rows.slice(0, limit);
  const changes = selected.map(row => ({
    sequence: Number(row[0] || 0), deviceId: String(row[1] || ''), commandId: String(row[2] || ''),
    entityType: String(row[3] || ''), entityId: String(row[4] || ''), revision: Number(row[5] || 0),
    payload: JSON.parse(String(row[6] || '{}')), appliedAt: String(row[7] || '')
  }));
  return {
    changes,
    nextCursor: changes.length ? changes[changes.length - 1].sequence : after,
    hasMore: rows.length > selected.length,
    ledgerSequence: orderQM9MetaNumber(ss, 'ledgerSequence')
  };
}

function orderQM9Ping(ss, payload) {
  orderQM9RequireSchema(payload);
  orderQEnsureAllSheets(ss);
  return {
    schemaVersion: ORDERQ_M9_SCHEMA,
    serverTime: new Date().toISOString(),
    cursor: orderQM9MetaNumber(ss, 'syncSequence'),
    ledgerSequence: orderQM9MetaNumber(ss, 'ledgerSequence')
  };
}
