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
const ORDERQ_SHEET_SCHEMA_VERSION = '8';
const ORDERQ_CUTOVER_MODE_PROPERTY = 'ONEAPP_ORDERQ_CUTOVER_MODE';
const ORDERQ_CUTOVER_SAFE_MODE = 'SHADOW';
const ORDERQ_CUTOVER_WRITE_MODES = Object.freeze(['PILOT_WRITE', 'VNEXT_PRIMARY']);
const ORDERQ_CUSTOMER_RESET_GENERATION_PROPERTY = 'ONEAPP_ORDERQ_CUSTOMER_RESET_GENERATION';
const ORDERQ_CUSTOMER_RESET_AT_PROPERTY = 'ONEAPP_ORDERQ_CUSTOMER_RESET_AT';
const ORDERQ_CUSTOMER_RESET_CONFIRMATION = 'RESET_CUSTOMER_MASTER_ONLY';
const ORDERQ_CUSTOMER_MUTABLE_TYPES = Object.freeze(['CUSTOMER', 'CUSTOMER_ALIAS', 'CUSTOMER_SOURCE_LINK']);
const ORDERQ_CUSTOMER_IMPORT_TYPES = Object.freeze(['CUSTOMER_EXCEL', 'CUSTOMER_CODE_UPSERT', 'CUSTOMER_SOURCE_IMPORT']);
const ORDERQ_CUSTOMER_INCOMPLETE_IMPORT_STATUSES = Object.freeze(['PREPARED', 'PARTIAL', 'PENDING', 'RETRY', 'FAILED', 'CONFLICT']);
const ORDERQ_STAGE3_DEPLOYMENT_ID_PROPERTY = 'ONEAPP_ORDERQ_STAGE3_DEPLOYMENT_ID';
const ORDERQ_STAGE3_DEPLOYMENT_VERSION_PROPERTY = 'ONEAPP_ORDERQ_STAGE3_DEPLOYMENT_VERSION';
const ORDERQ_STAGE3_GIT_COMMIT_PROPERTY = 'ONEAPP_ORDERQ_STAGE3_GIT_COMMIT';
const ORDERQ_STAGE4_DEPLOYMENT_ID_PROPERTY = 'ONEAPP_ORDERQ_STAGE4_DEPLOYMENT_ID';
const ORDERQ_STAGE4_DEPLOYMENT_VERSION_PROPERTY = 'ONEAPP_ORDERQ_STAGE4_DEPLOYMENT_VERSION';
const ORDERQ_STAGE4_GIT_COMMIT_PROPERTY = 'ONEAPP_ORDERQ_STAGE4_GIT_COMMIT';
const ORDERQ_STAGE5_DEPLOYMENT_ID_PROPERTY = 'ONEAPP_ORDERQ_STAGE5_DEPLOYMENT_ID';
const ORDERQ_STAGE5_DEPLOYMENT_VERSION_PROPERTY = 'ONEAPP_ORDERQ_STAGE5_DEPLOYMENT_VERSION';
const ORDERQ_STAGE5_GIT_COMMIT_PROPERTY = 'ONEAPP_ORDERQ_STAGE5_GIT_COMMIT';
const ORDERQ_SITUATION_SESSION_TTL_SECONDS = 120;

function orderQM10CutoverMode() {
  const properties = PropertiesService.getScriptProperties();
  const mode = String(properties.getProperty(ORDERQ_CUTOVER_MODE_PROPERTY) || ORDERQ_CUTOVER_SAFE_MODE).trim().toUpperCase();
  return ['LEGACY_PRIMARY', 'SHADOW', 'PILOT_WRITE', 'VNEXT_PRIMARY'].indexOf(mode) >= 0
    ? mode : ORDERQ_CUTOVER_SAFE_MODE;
}

function orderQM10AssertOfficialWriteEnabled(commandType) {
  const mode = orderQM10CutoverMode();
  if (ORDERQ_CUTOVER_WRITE_MODES.indexOf(mode) < 0) {
    throw new Error(`ORDERQ_CUTOVER_CENTRAL_WRITE_BLOCKED:${mode}:${String(commandType || '').trim().toUpperCase()}`);
  }
  return mode;
}

const ORDERQ_SHEETS = Object.freeze({
  ORDER: 'ORDER',
  ORDER_ITEM: 'ORDER_ITEM',
  ORDER_EVENT: 'ORDER_EVENT',
  CUSTOMER: 'CUSTOMER_MASTER',
  PRODUCT: 'PRODUCT_MASTER_ORDERQ',
  CUSTOMER_ALIAS: 'CUSTOMER_ALIAS_MAPPING',
  CUSTOMER_SOURCE_LINK: 'CUSTOMER_SOURCE_LINK',
  CUSTOMER_SOURCE_LINK_EVENT: 'CUSTOMER_SOURCE_LINK_EVENT',
  CUSTOMER_HEADER_MAPPING: 'CUSTOMER_HEADER_MAPPING',
  CUSTOMER_USER_FIELD_DEFINITION: 'CUSTOMER_USER_FIELD_DEFINITION',
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
  M9_TXN_LOG: 'ORDERQ_M9_TXN_LOG',
  M9_SOURCE_CLAIM: 'ORDERQ_M9_SOURCE_CLAIM'
});

const ORDERQ_HEADERS = Object.freeze({
  ORDER: ['orderId', 'revision', 'customerId', 'orderDate', 'status', 'updatedAt', 'payloadJson'],
  ORDER_ITEM: ['orderItemId', 'orderId', 'lineNo', 'productId', 'matchStatus', 'updatedAt', 'payloadJson'],
  ORDER_EVENT: ['eventId', 'orderId', 'revision', 'eventType', 'createdAt', 'payloadJson'],
  CUSTOMER: ['customerId', 'customerName', 'erpCustomerCode', 'updatedAt', 'payloadJson'],
  PRODUCT: ['productId', 'itemCode', 'itemName', 'updatedAt', 'payloadJson'],
  CUSTOMER_ALIAS: ['mappingId', 'customerId', 'normalizedText', 'sourceType', 'updatedAt', 'payloadJson'],
  CUSTOMER_SOURCE_LINK: ['linkId', 'customerId', 'sourceSystem', 'sourceCustomerCode', 'sourceLinkKey', 'linkStatus', 'updatedAt', 'payloadJson'],
  CUSTOMER_SOURCE_LINK_EVENT: ['eventId', 'linkId', 'eventType', 'beforeCustomerId', 'afterCustomerId', 'occurredAt', 'payloadJson'],
  CUSTOMER_HEADER_MAPPING: ['mappingId', 'sourceSystem', 'normalizedHeader', 'targetFieldKey', 'updatedAt', 'payloadJson'],
  CUSTOMER_USER_FIELD_DEFINITION: ['fieldKey', 'fieldType', 'displayName', 'enabled', 'updatedAt', 'payloadJson'],
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
  SYNC_META: ['sequence', 'queueId', 'deviceId', 'entityType', 'entityId', 'operation', 'revision', 'baseRevision', 'appliedAt', 'operationId', 'mutationId', 'parentMutationId', 'checksum', 'idempotencyKey', 'requestId'],
  M9_ENTITY: ['entityKey', 'entityType', 'entityId', 'revision', 'status', 'updatedAt', 'payloadJson'],
  M9_COMMAND: ['idempotencyKey', 'commandType', 'aggregateId', 'expectedRevision', 'fingerprint', 'status', 'leaseToken', 'deviceId', 'resultJson', 'updatedAt', 'payloadJson'],
  M9_META: ['key', 'value', 'updatedAt', 'payloadJson'],
  M9_CHANGE: ['sequence', 'deviceId', 'commandId', 'entityType', 'entityId', 'revision', 'payloadJson', 'appliedAt'],
  M9_TXN_LOG: ['txnId', 'idempotencyKey', 'status', 'previousJson', 'nextJson', 'error', 'updatedAt'],
  M9_SOURCE_CLAIM: ['claimKey', 'ownerCommandId', 'ownerContract', 'aggregateId', 'fingerprint', 'leaseToken',
    'leaseExpiresAt', 'status', 'preparedAt', 'committedAt', 'releasedAt', 'releaseReason', 'payloadJson']
});

function orderQEnsureSheet(ss, key) {
  const name = ORDERQ_SHEETS[key];
  const header = ORDERQ_HEADERS[key];
  const sheet = getOrCreateSheet(ss, name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    return sheet;
  }
  const existingWidth = Math.max(1, sheet.getLastColumn());
  const actual = sheet.getRange(1, 1, 1, existingWidth).getValues()[0].map(String);
  const expectedPrefix = header.slice(0, actual.length);
  if (JSON.stringify(actual) !== JSON.stringify(expectedPrefix)) throw new Error(`ORDERQ_HEADER_INVALID:${name}`);
  if (actual.length < header.length) sheet.getRange(1, actual.length + 1, 1, header.length - actual.length).setValues([header.slice(actual.length)]);
  return sheet;
}

function orderQEnsureAllSheets(ss) {
  const properties = PropertiesService.getScriptProperties();
  if (String(properties.getProperty(ORDERQ_SHEET_SCHEMA_PROPERTY) || '') === ORDERQ_SHEET_SCHEMA_VERSION) return;
  Object.keys(ORDERQ_SHEETS).forEach(key => orderQEnsureSheet(ss, key));
  properties.setProperty(ORDERQ_SHEET_SCHEMA_PROPERTY, ORDERQ_SHEET_SCHEMA_VERSION);
}

function orderQCustomerResetState() {
  const properties = PropertiesService.getScriptProperties();
  return {
    generation: Math.max(0, Number(properties.getProperty(ORDERQ_CUSTOMER_RESET_GENERATION_PROPERTY) || 0)),
    resetAt: String(properties.getProperty(ORDERQ_CUSTOMER_RESET_AT_PROPERTY) || '')
  };
}

function orderQSheetDataCount(ss, key) {
  return Math.max(0, orderQEnsureSheet(ss, key).getLastRow() - 1);
}

function orderQReadSheetPayloads(ss, key) {
  const sheet = orderQEnsureSheet(ss, key);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDERQ_HEADERS[key].length).getValues().map((row, index) => {
    let payload = null;
    try { payload = JSON.parse(String(row[row.length - 1] || 'null')); } catch (error) {}
    return { row: index + 2, values: row, payload };
  });
}

function orderQCustomerResetPlan(ss) {
  orderQEnsureAllSheets(ss);
  const batches = orderQReadSheetPayloads(ss, 'IMPORT_BATCH');
  const targetedBatchIds = new Set(batches.filter(item => {
    const sourceType = String(item.payload && item.payload.sourceType || item.values[1] || '').toUpperCase();
    const status = String(item.payload && item.payload.status || item.values[2] || '').toUpperCase();
    return ORDERQ_CUSTOMER_IMPORT_TYPES.indexOf(sourceType) >= 0 && ORDERQ_CUSTOMER_INCOMPLETE_IMPORT_STATUSES.indexOf(status) >= 0;
  }).map(item => String(item.payload && item.payload.importBatchId || item.values[0] || '')));
  const sourceRecords = orderQReadSheetPayloads(ss, 'SOURCE_RECORD');
  return {
    current: {
      CUSTOMER: orderQSheetDataCount(ss, 'CUSTOMER'),
      CUSTOMER_ALIAS: orderQSheetDataCount(ss, 'CUSTOMER_ALIAS'),
      CUSTOMER_SOURCE_LINK: orderQSheetDataCount(ss, 'CUSTOMER_SOURCE_LINK')
    },
    incompleteImportBatchIds: Array.from(targetedBatchIds),
    incompleteImportBatches: targetedBatchIds.size,
    incompleteSourceRecords: sourceRecords.filter(item => targetedBatchIds.has(String(item.payload && item.payload.importBatchId || item.values[1] || ''))).length,
    preserved: {
      ORDER: orderQSheetDataCount(ss, 'ORDER'), ORDER_ITEM: orderQSheetDataCount(ss, 'ORDER_ITEM'),
      CUSTOMER_SOURCE_LINK_EVENT: orderQSheetDataCount(ss, 'CUSTOMER_SOURCE_LINK_EVENT'), ORDER_EVENT: orderQSheetDataCount(ss, 'ORDER_EVENT'),
      SALES_DOCUMENT: orderQSheetDataCount(ss, 'SALES_DOCUMENT'), SALES_LINE: orderQSheetDataCount(ss, 'SALES_LINE'),
      PURCHASE_DOCUMENT: orderQSheetDataCount(ss, 'PURCHASE_DOCUMENT'), PURCHASE_LINE: orderQSheetDataCount(ss, 'PURCHASE_LINE'),
      LEDGER_DOCUMENT: orderQSheetDataCount(ss, 'LEDGER_DOCUMENT'), LEDGER_LINE: orderQSheetDataCount(ss, 'LEDGER_LINE'),
      INVENTORY_SNAPSHOT: orderQSheetDataCount(ss, 'INVENTORY_SNAPSHOT'), INVENTORY_LINE: orderQSheetDataCount(ss, 'INVENTORY_LINE'),
      SYNC_META: orderQSheetDataCount(ss, 'SYNC_META')
    },
    reset: orderQCustomerResetState()
  };
}

function orderQDeleteRowsByPredicate(ss, key, predicate) {
  const sheet = orderQEnsureSheet(ss, key);
  let deleted = 0;
  for (let row = sheet.getLastRow(); row >= 2; row--) {
    const values = sheet.getRange(row, 1, 1, ORDERQ_HEADERS[key].length).getValues()[0];
    let payload = null;
    try { payload = JSON.parse(String(values[values.length - 1] || 'null')); } catch (error) {}
    if (predicate(values, payload)) { sheet.deleteRow(row); deleted++; }
  }
  return deleted;
}

function orderQCustomerMasterReset(ss, payload) {
  if (String(payload.confirmation || '') !== ORDERQ_CUSTOMER_RESET_CONFIRMATION) throw new Error('ORDERQ_CUSTOMER_RESET_CONFIRMATION_REQUIRED');
  const before = orderQCustomerResetPlan(ss);
  const batchIds = new Set(before.incompleteImportBatchIds);
  const deleted = {
    CUSTOMER: orderQDeleteRowsByPredicate(ss, 'CUSTOMER', () => true),
    CUSTOMER_ALIAS: orderQDeleteRowsByPredicate(ss, 'CUSTOMER_ALIAS', () => true),
    CUSTOMER_SOURCE_LINK: orderQDeleteRowsByPredicate(ss, 'CUSTOMER_SOURCE_LINK', () => true),
    IMPORT_BATCH: orderQDeleteRowsByPredicate(ss, 'IMPORT_BATCH', (row, item) => batchIds.has(String(item && item.importBatchId || row[0] || ''))),
    SOURCE_RECORD: orderQDeleteRowsByPredicate(ss, 'SOURCE_RECORD', (row, item) => batchIds.has(String(item && item.importBatchId || row[1] || '')))
  };
  const properties = PropertiesService.getScriptProperties();
  const generation = before.reset.generation + 1;
  const resetAt = new Date().toISOString();
  properties.setProperty(ORDERQ_CUSTOMER_RESET_GENERATION_PROPERTY, String(generation));
  properties.setProperty(ORDERQ_CUSTOMER_RESET_AT_PROPERTY, resetAt);
  const after = orderQCustomerResetPlan(ss);
  if (Object.values(after.current).some(Number)) throw new Error('ORDERQ_CUSTOMER_RESET_VERIFY_FAILED');
  Object.keys(before.preserved).forEach(key => {
    if (before.preserved[key] !== after.preserved[key]) throw new Error(`ORDERQ_CUSTOMER_RESET_PRESERVED_COUNT_CHANGED:${key}`);
  });
  return { schemaVersion: ORDERQ_SYNC_SCHEMA, spreadsheet: { id: ss.getId(), name: ss.getName() }, before, deleted, after, generation, resetAt };
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
  if (!customerId) throw new Error('ORDERQ_CUSTOMER_REQUIRED');
  const sheet = orderQEnsureSheet(ss, 'CUSTOMER');
  if (!orderQFindDataRow(sheet, customerId)) throw new Error(`ORDERQ_CUSTOMER_NOT_FOUND:${customerId}`);
  const payload = orderQReadPayloadById(sheet, customerId) || {};
  if (String(payload.status || 'ACTIVE') !== 'ACTIVE') throw new Error(`ORDERQ_CUSTOMER_INACTIVE:${customerId}`);
  if (String(payload.qualityStatus || '') === 'SUPERSEDED') throw new Error(`ORDERQ_CUSTOMER_SUPERSEDED:${customerId}:${payload.canonicalCustomerId || ''}`);
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

const ORDERQ_SOURCE_DOCUMENT_CANONICAL_VERSION = 'ORDER_SOURCE_DOCUMENT_CANONICAL_V1';

function orderQCanonicalValueV1(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!isFinite(value)) throw new Error('ORDERQ_INTAKE_CANONICAL_NUMBER_INVALID');
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(orderQCanonicalValueV1);
  if (typeof value === 'object') {
    const result = {};
    Object.keys(value).sort().forEach(key => { result[key] = orderQCanonicalValueV1(value[key]); });
    return result;
  }
  return String(value);
}

function orderQCanonicalStringifyV1(value) {
  return JSON.stringify(orderQCanonicalValueV1(value));
}

function orderQCanonicalPickV1(source, keys) {
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) return orderQCanonicalValueV1(source[key]);
  }
  return null;
}

function orderQNormalizedIdentityTextV1(value) {
  let result = value === undefined || value === null ? '' : String(value).trim();
  try { result = result.normalize('NFKC'); } catch (error) {}
  return result.toLowerCase().replace(/\s+/g, '');
}

function orderQCanonicalIdentityOrNameV1(source, idKeys, nameKeys) {
  const idValue = orderQCanonicalPickV1(source, idKeys);
  const id = idValue === undefined || idValue === null ? '' : String(idValue).trim();
  return id ? { id } : { normalizedName: orderQNormalizedIdentityTextV1(orderQCanonicalPickV1(source, nameKeys)) };
}

function orderQCanonicalOrderItemV1(item, index) {
  const sourceLineKey = String(item && item.sourceLineKey || '').trim()
    || `LEGACY_LINE:${String(Number(item && item.lineNo || 0) || index + 1).padStart(6, '0')}`;
  return {
    sourceLineKey,
    productId: orderQCanonicalPickV1(item, ['productId']),
    masterProductId: orderQCanonicalPickV1(item, ['masterProductId']),
    itemCode: orderQCanonicalPickV1(item, ['itemCode', 'productCode']),
    itemName: orderQCanonicalPickV1(item, ['itemName', 'productName']),
    specification: orderQCanonicalPickV1(item, ['specification']),
    rawQuantity: orderQCanonicalPickV1(item, ['rawQuantity', 'quantity']),
    rawUnit: orderQCanonicalPickV1(item, ['rawUnit', 'unit']),
    finalQuantity: orderQCanonicalPickV1(item, ['finalQuantity', 'quantity']),
    finalUnit: orderQCanonicalPickV1(item, ['finalUnit', 'unit', 'rawUnit']),
    price: orderQCanonicalPickV1(item, ['price', 'unitPrice']),
    priceType: orderQCanonicalPickV1(item, ['priceType']),
    supplyAmount: orderQCanonicalPickV1(item, ['supplyAmount']),
    vatAmount: orderQCanonicalPickV1(item, ['vatAmount']),
    memo: orderQCanonicalPickV1(item, ['memo']),
    description: orderQCanonicalPickV1(item, ['description']),
    noticePrice: orderQCanonicalPickV1(item, ['noticePrice']),
    reviewStatus: orderQCanonicalPickV1(item, ['reviewStatus']),
    productIdentityStatus: orderQCanonicalPickV1(item, ['productIdentityStatus']),
    matchStatus: orderQCanonicalPickV1(item, ['matchStatus'])
  };
}

function orderQBuildOrderSourceDocumentCanonicalProjection(bundle) {
  const order = bundle && bundle.order || {};
  const items = Array.isArray(bundle && bundle.items) ? bundle.items : [];
  const canonicalItems = items.map(orderQCanonicalOrderItemV1)
    .sort((left, right) => String(left.sourceLineKey).localeCompare(String(right.sourceLineKey)));
  return orderQCanonicalValueV1({
    version: ORDERQ_SOURCE_DOCUMENT_CANONICAL_VERSION,
    header: {
      orderDate: orderQCanonicalPickV1(order, ['orderDate']),
      customer: orderQCanonicalIdentityOrNameV1(order, ['customerId'], ['customerName', 'normalizedCustomerName']),
      warehouse: orderQCanonicalIdentityOrNameV1(order, ['warehouseId', 'warehouseCode'], ['warehouseName', 'warehouse']),
      transactionType: orderQCanonicalPickV1(order, ['transactionType']),
      deliveryExpectedDate: orderQCanonicalPickV1(order, ['deliveryExpectedDate']),
      orderMessage: orderQCanonicalPickV1(order, ['orderMessage']),
      externalOrderNo: orderQCanonicalPickV1(order, ['externalOrderNo']),
      sourceType: orderQCanonicalPickV1(order, ['sourceType']),
      sourceId: orderQCanonicalPickV1(order, ['sourceId']),
      assigneeId: orderQCanonicalPickV1(order, ['assigneeId']),
      assigneeName: orderQCanonicalPickV1(order, ['assigneeName']),
      orderStatus: orderQCanonicalPickV1(order, ['orderStatus']),
      adminStatus: orderQCanonicalPickV1(order, ['adminStatus'])
    },
    items: canonicalItems
  });
}

function orderQComputeOrderSourceDocumentCanonicalHash(bundle) {
  return sha256Hex(orderQCanonicalStringifyV1(orderQBuildOrderSourceDocumentCanonicalProjection(bundle)));
}

function orderQFindOrderBundleBySourceDocumentKey(ss, sourceDocumentKey) {
  const key = String(sourceDocumentKey || '').trim();
  if (!key) return null;
  const sheet = orderQEnsureSheet(ss, 'ORDER');
  if (sheet.getLastRow() < 2) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ORDERQ_HEADERS.ORDER.length).getValues();
  for (let index = 0; index < rows.length; index++) {
    try {
      const order = JSON.parse(String(rows[index][6] || '{}'));
      if (String(order.sourceDocumentKey || '').trim() === key) return orderQReadOrderBundle(ss, order.orderId);
    } catch (error) {}
  }
  return null;
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

function orderQMetaByMutationId(ss, mutationId) {
  const sheet = orderQEnsureSheet(ss, 'SYNC_META');
  if (sheet.getLastRow() < 2 || !mutationId) return null;
  const found = sheet.getRange(2, 11, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(mutationId)).matchEntireCell(true).findNext();
  if (!found) return null;
  const values = sheet.getRange(found.getRow(), 1, 1, ORDERQ_HEADERS.SYNC_META.length).getValues()[0];
  return { sequence: Number(values[0] || 0), queueId: String(values[1] || ''), revision: Number(values[6] || 0), mutationId: String(values[10] || ''), checksum: String(values[12] || '') };
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
    new Date().toISOString(),
    String(change.operationId || change.queueId || ''),
    String(change.mutationId || change.queueId || ''),
    String(change.parentMutationId || ''),
    String(change.checksum || ''),
    String(change.idempotencyKey || change.queueId || ''),
    String(change.requestId || '')
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
  if (!existing && baseRevision === 0 && (order.sourceDocumentKey || order.sourceMessageKey)) {
    const sameSource = order.sourceDocumentKey
      ? orderQFindOrderBundleBySourceDocumentKey(ss, order.sourceDocumentKey)
      : orderQFindOrderBundleBySourceMessageKey(ss, order.sourceMessageKey);
    if (sameSource && sameSource.order && String(sameSource.order.orderId) !== String(order.orderId)) {
      if (order.sourceDocumentKey) {
        const existingHash = orderQComputeOrderSourceDocumentCanonicalHash(sameSource);
        const requestedHash = orderQComputeOrderSourceDocumentCanonicalHash({ order, items });
        if (existingHash !== requestedHash) throw new Error('ORDERQ_INTAKE_DOCUMENT_IDEMPOTENCY_CONFLICT');
      }
      return {
        status: 'source_duplicate',
        serverRevision: Number(sameSource.order.revision || 0),
        serverOrderId: String(sameSource.order.orderId || ''),
        serverPayload: sameSource,
        canonicalHash: order.sourceDocumentKey ? orderQComputeOrderSourceDocumentCanonicalHash(sameSource) : ''
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
    CUSTOMER_SOURCE_LINK: { key: 'CUSTOMER_SOURCE_LINK', id: 'linkId', row: p => [p.linkId, p.customerId || '', p.sourceSystem || '', p.sourceCustomerCode || '', p.sourceLinkKey || '', p.linkStatus || '', p.updatedAt || '', JSON.stringify(p)] },
    CUSTOMER_SOURCE_LINK_EVENT: { key: 'CUSTOMER_SOURCE_LINK_EVENT', id: 'eventId', row: p => [p.eventId, p.linkId || '', p.eventType || '', p.beforeCustomerId || '', p.afterCustomerId || '', p.occurredAt || '', JSON.stringify(p)] },
    CUSTOMER_HEADER_MAPPING: { key: 'CUSTOMER_HEADER_MAPPING', id: 'mappingId', row: p => [p.mappingId, p.sourceSystem || '', p.normalizedHeader || '', p.targetFieldKey || '', p.updatedAt || '', JSON.stringify(p)] },
    CUSTOMER_USER_FIELD_DEFINITION: { key: 'CUSTOMER_USER_FIELD_DEFINITION', id: 'fieldKey', row: p => [p.fieldKey, p.fieldType || '', p.displayName || '', p.enabled === false ? 'FALSE' : 'TRUE', p.updatedAt || '', JSON.stringify(p)] },
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
  if (String(change.entityType || '') === 'CUSTOMER_SOURCE_LINK') {
    const sourceLinkKey = String(payload.sourceLinkKey || '');
    if (!sourceLinkKey) throw new Error('ORDERQ_CUSTOMER_SOURCE_LINK_KEY_REQUIRED');
    if (sheet.getLastRow() >= 2) {
      const found = sheet.getRange(2, 5, sheet.getLastRow() - 1, 1).createTextFinder(sourceLinkKey).matchEntireCell(true).findNext();
      if (found && String(sheet.getRange(found.getRow(), 1).getValue() || '') !== id) {
        throw new Error(`ORDERQ_CUSTOMER_SOURCE_LINK_KEY_CONFLICT:${sourceLinkKey}`);
      }
    }
    const existingSourceLink = orderQReadPayloadById(sheet, id);
    const serverRevision = Number(existingSourceLink && existingSourceLink.revision || 0);
    const baseRevision = Number(change.baseRevision || 0);
    if (serverRevision !== baseRevision) {
      return {
        queueId: String(change.queueId || ''),
        status: 'conflict',
        serverRevision,
        serverPayload: existingSourceLink || null
      };
    }
  }
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
  const requestId = String(payload.requestId || '');
  if (!deviceId) throw new Error('ORDERQ_DEVICE_ID_REQUIRED');
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const reset = orderQCustomerResetState();
  if (reset.generation > 0 && changes.some(change => ORDERQ_CUSTOMER_MUTABLE_TYPES.indexOf(String(change && change.entityType || '')) >= 0)
      && Number(payload.customerResetGeneration || 0) !== reset.generation) {
    throw new Error(`ORDERQ_CUSTOMER_RESET_GENERATION_MISMATCH:${reset.generation}`);
  }
  if (changes.length > ORDERQ_SYNC_MAX_PUSH) throw new Error('ORDERQ_PUSH_LIMIT_EXCEEDED');
  const results = [];
  const duplicateOrderIds = {};

  changes.forEach(change => {
    change.requestId = requestId;
    const queueId = String(change && change.queueId || '');
    if (!queueId) {
      results.push({ queueId: '', status: 'error', message: 'ORDERQ_QUEUE_ID_REQUIRED' });
      return;
    }
    const mutationId = String(change.mutationId || queueId);
    const duplicate = orderQMetaByMutationId(ss, mutationId) || orderQMetaByQueueId(ss, queueId);
    if (duplicate) {
      if (duplicate.checksum && change.checksum && duplicate.checksum !== String(change.checksum)) {
        results.push({ queueId, status: 'error', message: 'ORDERQ_MUTATION_CHECKSUM_MISMATCH' });
        return;
      }
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
  return { schemaVersion: ORDERQ_SYNC_SCHEMA, results, cursor, customerReset: reset };
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
      operationId: String(row[9] || row[1] || ''),
      mutationId: String(row[10] || row[1] || ''),
      parentMutationId: String(row[11] || ''),
      checksum: String(row[12] || ''),
      idempotencyKey: String(row[13] || row[1] || ''),
      requestId: String(row[14] || ''),
      payload: orderQReadEntity(ss, entityType, entityId)
    };
  });
  const nextCursor = selected.length ? Number(selected[selected.length - 1][0] || after) : after;
  return {
    schemaVersion: ORDERQ_SYNC_SCHEMA,
    changes,
    nextCursor,
    hasMore: pending.length > selected.length,
    customerReset: orderQCustomerResetState()
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
const ORDERQ_M9_MIGRATION_TXN_SCHEMA = 'ORDERQ_M9_MIGRATION_TXN_V2';
const ORDERQ_M9_OFFICIAL_TXN_SCHEMA = 'ORDERQ_M9_OFFICIAL_TXN_V1';
const ORDERQ_M9_OFFICIAL_TXN_CHUNK_SCHEMA = 'ORDERQ_M9_OFFICIAL_TXN_CHUNK_V1';
const ORDERQ_M9_OFFICIAL_TXN_CHUNK_SIZE = 18000;
const ORDERQ_M9_TXN_CELL_SAFE_LIMIT = 45000;
const ORDERQ_M9_MIGRATION_TYPES = Object.freeze([
  'ORDER', 'ORDER_ITEM', 'PRODUCT', 'WAREHOUSE', 'INVENTORY_SNAPSHOT', 'INVENTORY_LINE',
  'DISPATCH_DECISION', 'DISPATCH_LINE', 'DISPATCH_STOCK_ALLOCATION',
  'PURCHASE_DOCUMENT', 'PURCHASE_LINE', 'SALES_DOCUMENT', 'SALES_LINE'
]);
const ORDERQ_M9_OFFICIAL_TYPES = Object.freeze(ORDERQ_M9_MIGRATION_TYPES.concat([
  'DISPATCH_APPROVAL', 'INVENTORY_RESERVATION', 'INVENTORY_MOVEMENT', 'DISPATCH_RECONCILIATION',
  'SALES_DOCUMENT', 'SALES_LINE', 'ORDER_EVENT',
  'VOUCHER_EVENT', 'RECEIVABLE_ENTRY', 'PAYABLE_ENTRY'
]));

function orderQM9Text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function orderQM9EffectiveOrderQuantity(order, item) {
  const status = orderQM9Text(order && (order.orderStatus || order.cancelType)).toUpperCase();
  const match = orderQM9Text(item && item.matchStatus).toUpperCase();
  if (status === 'FULL_CANCEL' || match === 'CANCELLED' || (item && item.active === false)) return 0;
  const raw = item && (item.finalQuantity != null ? item.finalQuantity : item.rawQuantity != null ? item.rawQuantity : item.quantity);
  const ordered = Number(raw || 0);
  const cancelled = Math.max(0, Number(item && item.cancelledQuantity || 0));
  return Math.max(0, (Number.isFinite(ordered) ? ordered : 0) - (Number.isFinite(cancelled) ? cancelled : 0));
}

function orderQM9CanonicalText(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

function orderQM9CodePointCompare(left, right) {
  const a = Array.from(orderQM9CanonicalText(left), char => char.codePointAt(0));
  const b = Array.from(orderQM9CanonicalText(right), char => char.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}

function orderQM9Stable(value) {
  const normalizeText = input => String(input === undefined || input === null ? '' : input).replace(/\r\n?/g, '\n').normalize('NFC').trim();
  const compare = (left, right) => {
    const a = Array.from(normalizeText(left), char => char.codePointAt(0));
    const b = Array.from(normalizeText(right), char => char.codePointAt(0));
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
    return a.length - b.length;
  };
  if (Array.isArray(value)) return value.map(orderQM9Stable);
  if (value && typeof value === 'object') return Object.keys(value).sort(compare).reduce((result, key) => {
    if (value[key] === undefined) return result;
    result[normalizeText(key)] = orderQM9Stable(value[key]);
    return result;
  }, {});
  if (typeof value === 'string') return normalizeText(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ORDERQ_CANONICAL_NUMBER_INVALID');
    return Object.is(value, -0) ? 0 : value;
  }
  return value;
}

function orderQM9StableJson(value) {
  return JSON.stringify(orderQM9Stable(value));
}

function orderQM9Digest(value) {
  return sha256Hex(orderQM9StableJson(value));
}

function orderQM9ParseJson(value, errorCode) {
  try { return JSON.parse(orderQM9Text(value) || '{}'); }
  catch (error) { throw new Error(errorCode); }
}

function orderQM9ReadRows(sheet, columnCount) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, columnCount).getValues();
}

function orderQM9AppendRows(sheet, rows) {
  if (!rows.length) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function orderQM9DeleteRowsByColumn(sheet, column, keysSource) {
  const keys = new Set((keysSource || []).map(orderQM9Text).filter(Boolean));
  if (!keys.size || sheet.getLastRow() < 2) return 0;
  const rows = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getValues();
  const targets = rows.map((row, index) => keys.has(orderQM9Text(row[0])) ? index + 2 : 0).filter(Boolean);
  if (!targets.length) return 0;
  const groups = [];
  targets.forEach(row => {
    const last = groups[groups.length - 1];
    if (last && last.start + last.count === row) last.count += 1;
    else groups.push({ start: row, count: 1 });
  });
  groups.reverse().forEach(group => sheet.deleteRows(group.start, group.count));
  return targets.length;
}

function orderQM9DeleteRowsByFirstColumn(sheet, keysSource) {
  return orderQM9DeleteRowsByColumn(sheet, 1, keysSource);
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

function orderQM9StoredEntity(row, timestamp) {
  const payload = row.payload || {};
  const entityType = orderQM9Text(row.entityType).toUpperCase();
  const entityId = orderQM9Text(row.entityId);
  const revision = Number(row.revision || payload.revision || payload.dispatchRevision || 0);
  const status = orderQM9Text(payload.status || payload.erpPostingStatus).toUpperCase();
  const stored = { entityType, entityId, revision, status, payload };
  return {
    entityKey: orderQM9EntityKey(entityType, entityId),
    stored,
    values: [orderQM9EntityKey(entityType, entityId), entityType, entityId, revision, status, timestamp, JSON.stringify(stored)]
  };
}

function orderQM9ReadEntityIndex(ss) {
  const sheet = orderQEnsureSheet(ss, 'M9_ENTITY');
  const rows = orderQM9ReadRows(sheet, ORDERQ_HEADERS.M9_ENTITY.length);
  const index = new Map();
  rows.forEach((values, offset) => {
    const entityKey = orderQM9Text(values[0]);
    if (!entityKey) return;
    index.set(entityKey, {
      rowNumber: offset + 2,
      values,
      stored: orderQM9ParseJson(values[6], `ORDERQ_CENTRAL_ENTITY_PAYLOAD_INVALID:${entityKey}`)
    });
  });
  return { sheet, rows, index };
}

function orderQM9WriteMigrationTransaction(ss, transaction) {
  const timestamp = new Date().toISOString();
  const row = [
    transaction.txnId,
    transaction.idempotencyKey,
    transaction.status,
    JSON.stringify(transaction.previous || {}),
    JSON.stringify(transaction.next || {}),
    orderQM9Text(transaction.error),
    timestamp
  ];
  orderQWriteRow(orderQEnsureSheet(ss, 'M9_TXN_LOG'), transaction.txnId, row);
  return { ...transaction, updatedAt: timestamp };
}

function orderQM9OfficialPayloadDigest(value) {
  return sha256Hex(JSON.stringify(value === undefined ? null : value));
}

function orderQM9OfficialMutationRows(rowsSource) {
  return (rowsSource || []).map(row => ({
    entityType: orderQM9Text(row.entityType).toUpperCase(),
    entityId: orderQM9Text(row.entityId),
    revision: Number(row.revision || 0),
    payload: row.payload || {}
  })).sort((a, b) => orderQM9EntityKey(a.entityType, a.entityId).localeCompare(orderQM9EntityKey(b.entityType, b.entityId)));
}

function orderQM9OfficialMutationDigest(rowsSource) {
  return orderQM9Digest(orderQM9OfficialMutationRows(rowsSource));
}

function orderQM9OfficialMutationKeyDigest(rowsSource) {
  return orderQM9Digest(orderQM9OfficialMutationRows(rowsSource).map(row => orderQM9EntityKey(row.entityType, row.entityId)));
}

function orderQM9BuildOfficialChunks(transactionId, idempotencyKey, kind, value) {
  const source = JSON.stringify(value === undefined ? null : value);
  const count = Math.max(1, Math.ceil(source.length / ORDERQ_M9_OFFICIAL_TXN_CHUNK_SIZE));
  const rows = [];
  const rowIds = [];
  const timestamp = new Date().toISOString();
  for (let index = 0; index < count; index += 1) {
    const rowId = `${transactionId}:CHUNK:${kind}:${String(index + 1).padStart(4, '0')}`;
    const wrapper = {
      schemaVersion: ORDERQ_M9_OFFICIAL_TXN_CHUNK_SCHEMA,
      transactionId,
      kind,
      index: index + 1,
      count,
      digest: sha256Hex(source),
      data: source.slice(index * ORDERQ_M9_OFFICIAL_TXN_CHUNK_SIZE, (index + 1) * ORDERQ_M9_OFFICIAL_TXN_CHUNK_SIZE)
    };
    const serialized = JSON.stringify(wrapper);
    if (serialized.length >= ORDERQ_M9_TXN_CELL_SAFE_LIMIT) {
      throw new Error(`ORDERQ_CENTRAL_OFFICIAL_TXN_CHUNK_TOO_LARGE:${transactionId}:${kind}:${index + 1}`);
    }
    rowIds.push(rowId);
    rows.push([rowId, idempotencyKey, 'CHUNK', serialized, '{}', '', timestamp]);
  }
  return {
    descriptor: { kind, count, digest: sha256Hex(source) },
    rowIds,
    rows
  };
}

function orderQM9WriteOfficialTransaction(ss, transaction) {
  const previousJson = JSON.stringify(transaction.previous || {});
  const nextJson = JSON.stringify(transaction.next || {});
  if (previousJson.length >= ORDERQ_M9_TXN_CELL_SAFE_LIMIT || nextJson.length >= ORDERQ_M9_TXN_CELL_SAFE_LIMIT) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_TXN_SUMMARY_TOO_LARGE:${transaction.txnId}`);
  }
  const timestamp = new Date().toISOString();
  orderQWriteRow(orderQEnsureSheet(ss, 'M9_TXN_LOG'), transaction.txnId, [
    transaction.txnId,
    transaction.idempotencyKey,
    transaction.status,
    previousJson,
    nextJson,
    orderQM9Text(transaction.error),
    timestamp
  ]);
  return { ...transaction, updatedAt: timestamp };
}

function orderQM9ReadOfficialTransactions(ss, statusesSource) {
  const statuses = statusesSource ? new Set(statusesSource.map(value => orderQM9Text(value).toUpperCase())) : null;
  const sheet = orderQEnsureSheet(ss, 'M9_TXN_LOG');
  return orderQM9ReadRows(sheet, ORDERQ_HEADERS.M9_TXN_LOG.length).map((values, offset) => {
    const previous = orderQM9ParseJson(values[3], `ORDERQ_CENTRAL_OFFICIAL_TXN_PREVIOUS_INVALID:${values[0]}`);
    const next = orderQM9ParseJson(values[4], `ORDERQ_CENTRAL_OFFICIAL_TXN_NEXT_INVALID:${values[0]}`);
    return {
      rowNumber: offset + 2,
      txnId: orderQM9Text(values[0]),
      idempotencyKey: orderQM9Text(values[1]),
      status: orderQM9Text(values[2]).toUpperCase(),
      previous,
      next,
      officialTransaction: previous.schemaVersion === ORDERQ_M9_OFFICIAL_TXN_SCHEMA
        || next.schemaVersion === ORDERQ_M9_OFFICIAL_TXN_SCHEMA,
      error: orderQM9Text(values[5]),
      updatedAt: orderQM9Text(values[6])
    };
  }).filter(row => row.officialTransaction && (!statuses || statuses.has(row.status)));
}

function orderQM9ReadOfficialChunkPayload(ss, transaction, descriptor) {
  if (!descriptor || !descriptor.kind || !Number.isInteger(Number(descriptor.count)) || Number(descriptor.count) < 1) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_TXN_CHUNK_DESCRIPTOR_INVALID:${transaction.txnId}`);
  }
  const count = Number(descriptor.count);
  const prefix = `${transaction.txnId}:CHUNK:${descriptor.kind}:`;
  const chunks = orderQM9ReadRows(orderQEnsureSheet(ss, 'M9_TXN_LOG'), ORDERQ_HEADERS.M9_TXN_LOG.length)
    .filter(values => orderQM9Text(values[0]).indexOf(prefix) === 0)
    .map(values => orderQM9ParseJson(values[3], `ORDERQ_CENTRAL_OFFICIAL_TXN_CHUNK_INVALID:${values[0]}`));
  if (chunks.length !== count) throw new Error(`ORDERQ_CENTRAL_OFFICIAL_TXN_CHUNK_COUNT_MISMATCH:${transaction.txnId}:${descriptor.kind}`);
  const indexes = new Set(chunks.map(chunk => Number(chunk.index || 0)));
  if (indexes.size !== count || chunks.some(chunk => chunk.schemaVersion !== ORDERQ_M9_OFFICIAL_TXN_CHUNK_SCHEMA
    || chunk.transactionId !== transaction.txnId || chunk.kind !== descriptor.kind
    || Number(chunk.count || 0) !== count || chunk.digest !== descriptor.digest)) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_TXN_CHUNK_SET_MISMATCH:${transaction.txnId}:${descriptor.kind}`);
  }
  const source = chunks.sort((a, b) => Number(a.index) - Number(b.index))
    .map(chunk => chunk.data === undefined || chunk.data === null ? '' : String(chunk.data))
    .join('');
  if (sha256Hex(source) !== descriptor.digest) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_TXN_CHUNK_DIGEST_MISMATCH:${transaction.txnId}:${descriptor.kind}`);
  }
  try { return JSON.parse(source); }
  catch (error) { throw new Error(`ORDERQ_CENTRAL_OFFICIAL_TXN_CHUNK_PAYLOAD_INVALID:${transaction.txnId}:${descriptor.kind}`); }
}

function orderQM9DeleteOfficialChunks(ss, transaction) {
  const descriptors = [transaction.previous && transaction.previous.previousChunks, transaction.next && transaction.next.mutationChunks].filter(Boolean);
  const rowIds = [];
  descriptors.forEach(descriptor => {
    for (let index = 1; index <= Number(descriptor.count || 0); index += 1) {
      rowIds.push(`${transaction.txnId}:CHUNK:${descriptor.kind}:${String(index).padStart(4, '0')}`);
    }
  });
  orderQM9DeleteRowsByFirstColumn(orderQEnsureSheet(ss, 'M9_TXN_LOG'), rowIds);
}

function orderQM9ReadMigrationTransactions(ss, statusesSource) {
  const statuses = statusesSource ? new Set(statusesSource.map(value => orderQM9Text(value).toUpperCase())) : null;
  const sheet = orderQEnsureSheet(ss, 'M9_TXN_LOG');
  return orderQM9ReadRows(sheet, ORDERQ_HEADERS.M9_TXN_LOG.length).map((values, offset) => {
    const previous = orderQM9ParseJson(values[3], `ORDERQ_CENTRAL_TXN_PREVIOUS_INVALID:${values[0]}`);
    const next = orderQM9ParseJson(values[4], `ORDERQ_CENTRAL_TXN_NEXT_INVALID:${values[0]}`);
    return {
      rowNumber: offset + 2,
      txnId: orderQM9Text(values[0]),
      idempotencyKey: orderQM9Text(values[1]),
      status: orderQM9Text(values[2]).toUpperCase(),
      previous,
      next,
      migrationTransaction: previous.schemaVersion === ORDERQ_M9_MIGRATION_TXN_SCHEMA
        || next.schemaVersion === ORDERQ_M9_MIGRATION_TXN_SCHEMA,
      error: orderQM9Text(values[5]),
      updatedAt: orderQM9Text(values[6])
    };
  }).filter(row => row.migrationTransaction && (!statuses || statuses.has(row.status)));
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

function orderQM9SaleClaimOwner(command) {
  const intent = command && command.intent || {};
  return {
    ownerCommandId: orderQM9Text(command && command.idempotencyKey),
    ownerContract: `${orderQM9Text(intent.commandContract).toUpperCase()}:${orderQM9Text(intent.contractKind || intent.document && intent.document.contractKind).toUpperCase()}`,
    aggregateId: orderQM9Text(command && command.aggregateId),
    fingerprint: orderQM9Text(command && command.fingerprint),
    leaseToken: orderQM9Text(command && command.leaseToken),
    leaseExpiresAt: orderQM9Text(command && command.leaseExpiresAt)
  };
}

function orderQM9SaleSourceClaimKeys(command) {
  const commandType = orderQM9Text(command && command.commandType).toUpperCase();
  const intent = command && command.intent || {};
  const document = intent.document || {};
  const keys = [];
  const add = value => { const key = orderQM9Text(value); if (key) keys.push(key); };
  if (commandType === 'CONFIRM_DISPATCH') {
    const dispatchId = orderQM9Text(intent.dispatchId || document.dispatchId || command.aggregateId);
    (intent.lines || document.lines || []).forEach(line => add(`SALE:DISPATCH:${dispatchId}:${orderQM9Text(line.dispatchLineId || line.sourceDispatchLineId)}`));
  } else if (['POST_SALE', 'CORRECT_SALE', 'REVERSE_SALE'].indexOf(commandType) >= 0
    && orderQM9Text(intent.contractKind || document.contractKind) === 'SALE_STAGE4_V1') {
    const sourceDocumentKey = orderQM9Text(intent.sourceDocumentKey || document.sourceDocumentKey);
    const originSystem = orderQM9Text(intent.originSystem || document.originSystem).toUpperCase();
    const originTransactionId = orderQM9Text(intent.originTransactionId || document.originTransactionId);
    const sourceVoucherIndex = Number(intent.sourceVoucherIndex || document.sourceVoucherIndex || 0);
    if (!sourceDocumentKey || !originSystem || !originTransactionId || !Number.isInteger(sourceVoucherIndex) || sourceVoucherIndex < 1) {
      throw new Error('ORDERQ_SALE_ORIGIN_IDENTITY_REQUIRED');
    }
    add(`SALE:SOURCE:${sourceDocumentKey}`);
    add(`SALE:TX:${originSystem}:${originTransactionId}:${sourceVoucherIndex}`);
    (intent.lines || []).forEach(line => {
      const dispatchId = orderQM9Text(line.sourceDispatchId);
      const dispatchLineId = orderQM9Text(line.sourceDispatchLineId);
      if (dispatchId && dispatchLineId) add(`SALE:DISPATCH:${dispatchId}:${dispatchLineId}`);
      (line.reversalSourceAllocations || []).forEach(ref => add(`SALE:ALLOCATION:${orderQM9Text(ref.allocationEventId)}`));
      (line.restorationSourceReversals || []).forEach(ref => add(`SALE:REVERSAL:${orderQM9Text(ref.reversalEventId)}`));
    });
  }
  return Array.from(new Set(keys.filter(key => !/:$/.test(key)))).sort(orderQM9CodePointCompare);
}

function orderQM9ReadSourceClaim(ss, claimKey) {
  return orderQReadPayloadById(orderQEnsureSheet(ss, 'M9_SOURCE_CLAIM'), orderQM9Text(claimKey));
}

function orderQM9WriteSourceClaim(ss, claim) {
  orderQWriteRow(orderQEnsureSheet(ss, 'M9_SOURCE_CLAIM'), claim.claimKey, [
    claim.claimKey, claim.ownerCommandId || '', claim.ownerContract || '', claim.aggregateId || '', claim.fingerprint || '',
    claim.leaseToken || '', claim.leaseExpiresAt || '', claim.status || '', claim.preparedAt || '', claim.committedAt || '',
    claim.releasedAt || '', claim.releaseReason || '', JSON.stringify(claim)
  ]);
  return claim;
}

function orderQM9PrepareSourceClaims(ss, command, nowMillis) {
  const keys = orderQM9SaleSourceClaimKeys(command);
  if (!keys.length) return [];
  const owner = orderQM9SaleClaimOwner(command);
  const occurrence = key => key.indexOf('SALE:SOURCE:') === 0 || key.indexOf('SALE:TX:') === 0 || key.indexOf('SALE:DISPATCH:') === 0;
  const inspected = keys.map(key => ({ key, prior: orderQM9ReadSourceClaim(ss, key) }));
  inspected.forEach(({ key, prior }) => {
    if (!prior || prior.status === 'RELEASED') return;
    const sameLineage = prior.ownerContract === owner.ownerContract && prior.aggregateId === owner.aggregateId;
    if (prior.status === 'COMMITTED' && occurrence(key) && sameLineage) return;
    if (prior.status === 'PREPARED' && Date.parse(prior.leaseExpiresAt) <= nowMillis) return;
    if (prior.ownerCommandId === owner.ownerCommandId && prior.fingerprint !== owner.fingerprint) {
      throw new Error(`ORDERQ_CENTRAL_IDEMPOTENCY_CONFLICT:${owner.ownerCommandId}`);
    }
    if (prior.ownerCommandId === owner.ownerCommandId && prior.fingerprint === owner.fingerprint) return;
    throw new Error(`ORDERQ_CENTRAL_SOURCE_CLAIM_CONFLICT:${key}`);
  });
  const preparedAt = new Date(nowMillis).toISOString();
  keys.forEach(key => {
    const prior = orderQM9ReadSourceClaim(ss, key);
    if (prior && prior.status === 'COMMITTED' && occurrence(key)
      && prior.ownerContract === owner.ownerContract && prior.aggregateId === owner.aggregateId) return;
    orderQM9WriteSourceClaim(ss, { claimKey: key, ...owner, status: 'PREPARED', preparedAt,
      committedAt: '', releasedAt: '', releaseReason: '', resourceClaim: !occurrence(key) });
  });
  return keys;
}

function orderQM9ReleaseSourceClaims(ss, command, reason, atMillis) {
  orderQM9SaleSourceClaimKeys(command).forEach(key => {
    const claim = orderQM9ReadSourceClaim(ss, key);
    if (claim && claim.status === 'PREPARED' && claim.ownerCommandId === command.idempotencyKey) {
      orderQM9WriteSourceClaim(ss, { ...claim, status: 'RELEASED', releasedAt: new Date(atMillis).toISOString(), releaseReason: reason });
    }
  });
}

function orderQM9VerifyAndCommitSourceClaims(ss, command, atMillis) {
  const owner = orderQM9SaleClaimOwner(command);
  orderQM9SaleSourceClaimKeys(command).forEach(key => {
    const claim = orderQM9ReadSourceClaim(ss, key);
    const occurrence = key.indexOf('SALE:SOURCE:') === 0 || key.indexOf('SALE:TX:') === 0 || key.indexOf('SALE:DISPATCH:') === 0;
    const lineageCommitted = claim && claim.status === 'COMMITTED' && occurrence
      && claim.ownerContract === owner.ownerContract && claim.aggregateId === owner.aggregateId;
    if (!lineageCommitted && (!claim || claim.status !== 'PREPARED' || claim.ownerCommandId !== owner.ownerCommandId
      || claim.fingerprint !== owner.fingerprint || claim.leaseToken !== owner.leaseToken)) {
      throw new Error(`ORDERQ_CENTRAL_SOURCE_CLAIM_CONFLICT:${key}`);
    }
  });
  orderQM9SaleSourceClaimKeys(command).forEach(key => {
    const claim = orderQM9ReadSourceClaim(ss, key);
    if (!claim || claim.status === 'COMMITTED') return;
    const occurrence = key.indexOf('SALE:SOURCE:') === 0 || key.indexOf('SALE:TX:') === 0 || key.indexOf('SALE:DISPATCH:') === 0;
    orderQM9WriteSourceClaim(ss, occurrence
      ? { ...claim, status: 'COMMITTED', committedAt: new Date(atMillis).toISOString() }
      : { ...claim, status: 'RELEASED', releasedAt: new Date(atMillis).toISOString(), releaseReason: 'COMMITTED' });
  });
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

function orderQM9EntityDigest(rowsSource) {
  const rows = (rowsSource || []).map(row => ({
    entityKey: orderQM9EntityKey(row.entityType, row.entityId),
    entityType: orderQM9Text(row.entityType).toUpperCase(),
    entityId: orderQM9Text(row.entityId),
    revision: Number(row.revision || 0),
    status: orderQM9Text(row.status).toUpperCase(),
    payload: row.payload || {}
  })).sort((a, b) => a.entityKey.localeCompare(b.entityKey));
  return orderQM9Digest(rows);
}

function orderQM9ChangeDigest(rowsSource) {
  const rows = (rowsSource || []).map(row => ({
    sequence: Number(row.sequence || 0),
    deviceId: orderQM9Text(row.deviceId),
    commandId: orderQM9Text(row.commandId),
    entityType: orderQM9Text(row.entityType).toUpperCase(),
    entityId: orderQM9Text(row.entityId),
    revision: Number(row.revision || 0),
    payload: row.payload || {}
  })).sort((a, b) => a.sequence - b.sequence);
  return orderQM9Digest(rows);
}

function orderQM9ReadChanges(ss) {
  const sheet = orderQEnsureSheet(ss, 'M9_CHANGE');
  const rows = orderQM9ReadRows(sheet, ORDERQ_HEADERS.M9_CHANGE.length).map((values, offset) => ({
    rowNumber: offset + 2,
    sequence: Number(values[0] || 0),
    deviceId: orderQM9Text(values[1]),
    commandId: orderQM9Text(values[2]),
    entityType: orderQM9Text(values[3]).toUpperCase(),
    entityId: orderQM9Text(values[4]),
    revision: Number(values[5] || 0),
    payload: orderQM9ParseJson(values[6], `ORDERQ_CENTRAL_CHANGE_PAYLOAD_INVALID:${values[0]}`),
    appliedAt: orderQM9Text(values[7])
  }));
  return { sheet, rows };
}

function orderQM9VerifyMigrationData(ss, idempotencyKey, summary) {
  if (!summary || summary.schemaVersion !== ORDERQ_M9_MIGRATION_TXN_SCHEMA) return { complete: false, changes: [] };
  const targetKeys = Array.isArray(summary.targetEntityKeys) ? summary.targetEntityKeys : [];
  const entityIndex = orderQM9ReadEntityIndex(ss).index;
  const targetRows = targetKeys.map(key => entityIndex.get(key) && entityIndex.get(key).stored).filter(Boolean);
  if (targetRows.length !== Number(summary.targetEntityCount || 0)) return { complete: false, changes: [] };
  if (orderQM9EntityDigest(targetRows) !== summary.targetEntityDigest) return { complete: false, changes: [] };

  const allChanges = orderQM9ReadChanges(ss).rows;
  const changes = allChanges.filter(row => row.commandId === idempotencyKey);
  if (changes.length !== Number(summary.changeCount || 0)) return { complete: false, changes };
  if (orderQM9ChangeDigest(changes) !== summary.changeDigest) return { complete: false, changes };
  if (Number(orderQM9MetaNumber(ss, 'syncSequence')) < Number(summary.endCursor || 0)) return { complete: false, changes };

  return { complete: true, changes };
}

function orderQM9VerifyMigrationComplete(ss, idempotencyKey, summary) {
  const data = orderQM9VerifyMigrationData(ss, idempotencyKey, summary);
  if (!data.complete) return data;
  const command = orderQM9ReadCommand(ss, idempotencyKey);
  const result = command && command.result || {};
  const commandMatches = command
    && command.commandType === 'MIGRATION'
    && command.status === 'COMMITTED'
    && command.fingerprint === summary.fingerprint
    && result.transactionId === summary.transactionId
    && Number(result.targetEntityCount || 0) === Number(summary.targetEntityCount || 0)
    && result.targetEntityDigest === summary.targetEntityDigest
    && Number(result.changeCount || 0) === Number(summary.changeCount || 0)
    && result.changeDigest === summary.changeDigest
    && Number(result.endCursor || 0) === Number(summary.endCursor || 0);
  return { complete: Boolean(commandMatches), changes: data.changes };
}

function orderQM9RollbackMigration(ss, transaction, options) {
  const previous = transaction.previous || {};
  const summary = transaction.next || {};
  if (previous.schemaVersion !== ORDERQ_M9_MIGRATION_TXN_SCHEMA || summary.schemaVersion !== ORDERQ_M9_MIGRATION_TXN_SCHEMA) {
    throw new Error(`ORDERQ_CENTRAL_MIGRATION_RECOVERY_SCHEMA_INVALID:${transaction.txnId}`);
  }
  orderQM9DeleteRowsByFirstColumn(orderQEnsureSheet(ss, 'M9_ENTITY'), previous.pendingEntityKeys || []);
  if (orderQM9Text(options && options.failureAt).toUpperCase() === 'ENTITIES_RESTORED') {
    throw new Error('ORDERQ_CENTRAL_MIGRATION_ROLLBACK_INTERRUPTED:ENTITIES_RESTORED');
  }
  orderQM9DeleteRowsByColumn(orderQEnsureSheet(ss, 'M9_CHANGE'), 3, [transaction.idempotencyKey]);
  orderQM9SetMetaNumber(ss, 'syncSequence', Number(previous.previousSyncSequence || 0));
  orderQM9DeleteRowsByFirstColumn(orderQEnsureSheet(ss, 'M9_COMMAND'), [transaction.idempotencyKey]);
  if (orderQM9Text(options && options.failureAt).toUpperCase() === 'STATE_RESTORED') {
    throw new Error('ORDERQ_CENTRAL_MIGRATION_ROLLBACK_INTERRUPTED:STATE_RESTORED');
  }
  orderQM9WriteMigrationTransaction(ss, {
    ...transaction,
    status: 'ROLLED_BACK',
    error: orderQM9Text(options && options.error || transaction.error)
  });
  return 'ROLLED_BACK';
}

function orderQM9RecoverIncompleteMigrations(ss) {
  const incomplete = orderQM9ReadMigrationTransactions(ss, ['PREPARED', 'RECOVERY_REQUIRED']);
  const outcomes = [];
  incomplete.forEach(transaction => {
    try {
      const verified = orderQM9VerifyMigrationComplete(ss, transaction.idempotencyKey, transaction.next);
      if (verified.complete) {
        orderQM9WriteMigrationTransaction(ss, { ...transaction, status: 'COMMITTED', error: '' });
        outcomes.push({ txnId: transaction.txnId, status: 'COMMITTED' });
      } else {
        orderQM9RollbackMigration(ss, transaction, { error: transaction.error || 'RECOVERED_INCOMPLETE_MIGRATION' });
        outcomes.push({ txnId: transaction.txnId, status: 'ROLLED_BACK' });
      }
    } catch (error) {
      try {
        orderQM9WriteMigrationTransaction(ss, { ...transaction, status: 'RECOVERY_REQUIRED', error: String(error.message || error) });
      } catch (ignored) {}
      throw error;
    }
  });
  return outcomes;
}

function orderQM9OfficialChanges(ss, idempotencyKey) {
  return orderQM9ReadChanges(ss).rows
    .filter(row => row.commandId === idempotencyKey)
    .sort((a, b) => a.sequence - b.sequence);
}

function orderQM9VerifyOfficialChanges(ss, transaction) {
  const summary = transaction.next || {};
  if (summary.schemaVersion !== ORDERQ_M9_OFFICIAL_TXN_SCHEMA) return { complete: false, changes: [] };
  const changes = orderQM9OfficialChanges(ss, transaction.idempotencyKey);
  const expectedCount = Number(summary.changeCount || 0);
  if (changes.length !== expectedCount || orderQM9ChangeDigest(changes) !== summary.changeDigest) {
    return { complete: false, changes };
  }
  const startCursor = Number(summary.startCursor || 0);
  if (changes.some((row, index) => row.sequence !== startCursor + index + 1)) return { complete: false, changes };
  return { complete: true, changes };
}

function orderQM9VerifyOfficialAudit(ss, transaction, command) {
  const summary = transaction && transaction.next || {};
  if (!transaction || transaction.status !== 'COMMITTED' || summary.schemaVersion !== ORDERQ_M9_OFFICIAL_TXN_SCHEMA) {
    return { complete: false, changes: [] };
  }
  const verifiedChanges = orderQM9VerifyOfficialChanges(ss, transaction);
  const result = command && command.result || {};
  const complete = verifiedChanges.complete
    && command && command.status === 'COMMITTED'
    && command.mutationFingerprint === summary.mutationFingerprint
    && result.transactionId === transaction.txnId
    && Number(result.changeCount || 0) === Number(summary.changeCount || 0)
    && result.changeDigest === summary.changeDigest
    && result.mutationKeyDigest === summary.mutationKeyDigest
    && Number(result.cursor || 0) === Number(summary.endCursor || 0)
    && Number(result.ledgerSequence || 0) === Number(summary.endLedgerSequence || 0)
    && Number(orderQM9MetaNumber(ss, 'syncSequence')) >= Number(summary.endCursor || 0)
    && Number(orderQM9MetaNumber(ss, 'ledgerSequence')) >= Number(summary.endLedgerSequence || 0);
  return { complete: Boolean(complete), changes: verifiedChanges.changes };
}

function orderQM9VerifyOfficialCommitState(ss, transaction) {
  const summary = transaction.next || {};
  const mutations = orderQM9ReadOfficialChunkPayload(ss, transaction, summary.mutationChunks);
  if (!Array.isArray(mutations) || mutations.length !== Number(summary.mutationCount || 0)
    || orderQM9OfficialMutationDigest(mutations) !== summary.mutationDigest
    || orderQM9OfficialMutationKeyDigest(mutations) !== summary.mutationKeyDigest) {
    return { complete: false, changes: [] };
  }
  const currentRows = mutations.map(row => orderQM9ReadEntity(ss, row.entityType, row.entityId)).filter(Boolean);
  if (currentRows.length !== mutations.length
    || orderQM9OfficialMutationDigest(currentRows) !== summary.mutationDigest
    || Number(orderQM9MetaNumber(ss, 'syncSequence')) !== Number(summary.endCursor || 0)
    || Number(orderQM9MetaNumber(ss, 'ledgerSequence')) !== Number(summary.endLedgerSequence || 0)) {
    return { complete: false, changes: [] };
  }
  const command = orderQM9ReadCommand(ss, transaction.idempotencyKey);
  const claimsComplete = orderQM9SaleSourceClaimKeys(command || {}).every(key => {
    const claim = orderQM9ReadSourceClaim(ss, key);
    const occurrence = key.indexOf('SALE:SOURCE:') === 0 || key.indexOf('SALE:TX:') === 0 || key.indexOf('SALE:DISPATCH:') === 0;
    return claim && (occurrence
      ? claim.status === 'COMMITTED' && claim.aggregateId === command.aggregateId
      : claim.status === 'RELEASED' && claim.releaseReason === 'COMMITTED');
  });
  if (!claimsComplete) return { complete: false, changes: [] };
  const audit = orderQM9VerifyOfficialAudit(ss, { ...transaction, status: 'COMMITTED' }, command);
  return { complete: audit.complete, changes: audit.changes };
}

function orderQM9RollbackOfficialTransaction(ss, transaction, options) {
  const previousSummary = transaction.previous || {};
  const nextSummary = transaction.next || {};
  if (previousSummary.schemaVersion !== ORDERQ_M9_OFFICIAL_TXN_SCHEMA
    || nextSummary.schemaVersion !== ORDERQ_M9_OFFICIAL_TXN_SCHEMA) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_RECOVERY_SCHEMA_INVALID:${transaction.txnId}`);
  }
  const bundle = orderQM9ReadOfficialChunkPayload(ss, transaction, previousSummary.previousChunks);
  const previous = Array.isArray(bundle && bundle.entities) ? bundle.entities : [];
  const previousCommand = bundle && bundle.command;
  const previousSourceClaims = Array.isArray(bundle && bundle.sourceClaims) ? bundle.sourceClaims : [];
  if (previous.length !== Number(previousSummary.previousEntityCount || 0)
    || orderQM9OfficialMutationKeyDigest(previous.map(row => ({
      entityType: row.entityType,
      entityId: row.entityId,
      revision: row.value && row.value.revision || 0,
      payload: row.value && row.value.payload || {}
    }))) !== previousSummary.previousEntityKeyDigest
    || orderQM9OfficialPayloadDigest(previous) !== previousSummary.previousEntityDigest
    || orderQM9OfficialPayloadDigest(previousCommand) !== previousSummary.previousCommandDigest
    || (previousSummary.previousSourceClaimDigest
      && orderQM9OfficialPayloadDigest(previousSourceClaims) !== previousSummary.previousSourceClaimDigest)) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_RECOVERY_PREVIOUS_INVALID:${transaction.txnId}`);
  }
  previous.forEach(entry => {
    const key = orderQM9EntityKey(entry.entityType, entry.entityId);
    const entitySheet = orderQEnsureSheet(ss, 'M9_ENTITY');
    if (entry.value) orderQM9WriteEntity(ss, entry.value);
    else orderQDeleteEntityRow(entitySheet, key);
  });
  if (orderQM9Text(options && options.failureAt).toUpperCase() === 'ENTITIES_RESTORED') {
    throw new Error('ORDERQ_CENTRAL_OFFICIAL_ROLLBACK_INTERRUPTED:ENTITIES_RESTORED');
  }
  orderQM9SetMetaNumber(ss, 'ledgerSequence', Number(previousSummary.previousLedgerSequence || 0));
  orderQM9SetMetaNumber(ss, 'syncSequence', Number(previousSummary.previousSyncSequence || 0));
  const changeSheet = orderQEnsureSheet(ss, 'M9_CHANGE');
  while (changeSheet.getLastRow() > Number(previousSummary.previousChangeLastRow || 1)) {
    changeSheet.deleteRow(changeSheet.getLastRow());
  }
  if (previousCommand) orderQM9WriteCommand(ss, previousCommand);
  else orderQM9DeleteRowsByFirstColumn(orderQEnsureSheet(ss, 'M9_COMMAND'), [transaction.idempotencyKey]);
  previousSourceClaims.forEach(entry => {
    if (entry.value) orderQM9WriteSourceClaim(ss, entry.value);
    else orderQM9DeleteRowsByFirstColumn(orderQEnsureSheet(ss, 'M9_SOURCE_CLAIM'), [entry.claimKey]);
  });
  if (orderQM9Text(options && options.failureAt).toUpperCase() === 'STATE_RESTORED') {
    throw new Error('ORDERQ_CENTRAL_OFFICIAL_ROLLBACK_INTERRUPTED:STATE_RESTORED');
  }
  orderQM9WriteOfficialTransaction(ss, {
    ...transaction,
    status: 'ROLLED_BACK',
    error: orderQM9Text(options && options.error || transaction.error)
  });
  orderQM9DeleteOfficialChunks(ss, transaction);
  return 'ROLLED_BACK';
}

function orderQM9RecoverIncompleteOfficialTransactions(ss) {
  const incomplete = orderQM9ReadOfficialTransactions(ss, ['PREPARED', 'RECOVERY_REQUIRED']);
  const outcomes = [];
  incomplete.forEach(transaction => {
    try {
      const verified = orderQM9VerifyOfficialCommitState(ss, transaction);
      if (verified.complete) {
        orderQM9WriteOfficialTransaction(ss, { ...transaction, status: 'COMMITTED', error: '' });
        orderQM9DeleteOfficialChunks(ss, transaction);
        outcomes.push({ txnId: transaction.txnId, status: 'COMMITTED' });
      } else {
        orderQM9RollbackOfficialTransaction(ss, transaction, { error: transaction.error || 'RECOVERED_INCOMPLETE_OFFICIAL_COMMAND' });
        outcomes.push({ txnId: transaction.txnId, status: 'ROLLED_BACK' });
      }
    } catch (error) {
      try {
        orderQM9WriteOfficialTransaction(ss, { ...transaction, status: 'RECOVERY_REQUIRED', error: String(error.message || error) });
      } catch (ignored) {}
      throw error;
    }
  });
  return outcomes;
}

function orderQM9OfficialResultForCommand(ss, command) {
  const transactionId = command && command.result && command.result.transactionId;
  const transaction = orderQM9ReadOfficialTransactions(ss).find(row => row.txnId === transactionId);
  const verified = orderQM9VerifyOfficialAudit(ss, transaction, command);
  if (!verified.complete) throw new Error(`ORDERQ_CENTRAL_OFFICIAL_IDEMPOTENCY_STATE_MISMATCH:${command && command.idempotencyKey || ''}`);
  return {
    transactionId,
    changes: verified.changes.map(row => ({
      entityType: row.entityType,
      entityId: row.entityId,
      revision: row.revision,
      payload: row.payload
    })),
    cursor: Number(transaction.next.endCursor || 0),
    ledgerSequence: Number(transaction.next.endLedgerSequence || 0),
    serverRevision: Number(command.result.serverRevision || 0),
    resultDigest: orderQM9Text(command.result.resultDigest)
  };
}

function orderQM9EnforceTransactionBoundary(ss) {
  const incompleteMigrations = orderQM9ReadMigrationTransactions(ss, ['PREPARED', 'RECOVERY_REQUIRED']);
  if (incompleteMigrations.length) {
    const outcomes = orderQM9RecoverIncompleteMigrations(ss);
    throw new Error(`ORDERQ_CENTRAL_MIGRATION_RECOVERY_COMPLETED_RETRY:${outcomes.map(row => `${row.txnId}:${row.status}`).join(',')}`);
  }
  const incompleteOfficial = orderQM9ReadOfficialTransactions(ss, ['PREPARED', 'RECOVERY_REQUIRED']);
  if (incompleteOfficial.length) {
    const outcomes = orderQM9RecoverIncompleteOfficialTransactions(ss);
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_RECOVERY_COMPLETED_RETRY:${outcomes.map(row => `${row.txnId}:${row.status}`).join(',')}`);
  }
}

function orderQM9ValidateSaleCanonicalIntent(payload) {
  const commandType = orderQM9Text(payload && payload.commandType).toUpperCase();
  const intent = payload && payload.intent || {};
  const intentDocument = intent.document && typeof intent.document === 'object' ? intent.document : {};
  const sourceDocument = payload.document && typeof payload.document === 'object' ? payload.document : {};
  const stage4 = [intent.contractKind, payload.contractKind, intentDocument.contractKind, sourceDocument.contractKind]
    .some(value => orderQM9Text(value) === 'SALE_STAGE4_V1');
  if (!stage4 || ['POST_SALE', 'CORRECT_SALE', 'REVERSE_SALE'].indexOf(commandType) < 0) return;
  const fields = ['contractKind','normalizedOriginVersion','sourceDocumentKey','originSystem','originTransactionId','sourceVoucherIndex','externalDocumentNo','sourceClaimKeys'];
  const normalize = (field, value) => {
    if (field === 'sourceVoucherIndex') return value === '' || value === null || value === undefined ? '' : Number(value);
    if (field === 'sourceClaimKeys') return Array.isArray(value) ? value.map(orderQM9Text) : [];
    const result = orderQM9Text(value); return field === 'originSystem' ? result.toUpperCase() : result;
  };
  const present = value => Array.isArray(value) ? value.length > 0 : value !== '';
  const identity = {};
  fields.forEach(field => {
    const values = [intent[field], payload[field], intentDocument[field], sourceDocument[field]].map(value => normalize(field, value)).filter(present);
    if (values.length > 1 && values.slice(1).some(value => orderQM9StableJson(value) !== orderQM9StableJson(values[0]))) {
      throw new Error(`ORDERQ_OFFICIAL_INTENT_MISMATCH:${field}`);
    }
    identity[field] = values.length ? values[0] : field === 'sourceClaimKeys' ? [] : '';
  });
  if (!identity.normalizedOriginVersion || !identity.sourceDocumentKey || !identity.originSystem || !identity.originTransactionId
    || !Number.isInteger(identity.sourceVoucherIndex) || identity.sourceVoucherIndex < 1 || !identity.sourceClaimKeys.length) {
    throw new Error('ORDERQ_SALE_ORIGIN_IDENTITY_REQUIRED');
  }
}

function orderQM9CommandFingerprint(payload) {
  const commandType = orderQM9Text(payload.commandType).toUpperCase();
  const aggregateId = orderQM9Text(payload.aggregateId);
  const idempotencyKey = orderQM9Text(payload.idempotencyKey);
  const expectedRevision = Number(payload.expectedRevision);
  if (!commandType || !aggregateId || !idempotencyKey || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('ORDERQ_CENTRAL_COMMAND_INVALID');
  }
  const voucherCommands = ['POST_PURCHASE', 'CORRECT_PURCHASE', 'POST_SALE', 'CORRECT_SALE', 'REVERSE_SALE'];
  const commandContract = orderQM9Text(payload.intent && payload.intent.commandContract).toUpperCase();
  if (voucherCommands.indexOf(commandType) >= 0 && commandContract !== 'VOUCHER_CORE_V1') {
    throw new Error(`ORDERQ_CENTRAL_COMMAND_CONTRACT_REQUIRED:${commandType}`);
  }
  if (commandContract === 'VOUCHER_CORE_V1'
    && orderQM9Text(payload.intent && payload.intent.commandId) !== idempotencyKey) {
    throw new Error('ORDERQ_CENTRAL_COMMAND_IDEMPOTENCY_MISMATCH');
  }
  orderQM9ValidateSaleCanonicalIntent(payload);
  return orderQM9Digest({ commandType, aggregateId, expectedRevision, intent: payload.intent || null });
}

function orderQM9TargetType(commandType) {
  if (String(commandType).indexOf('PURCHASE') >= 0) return 'PURCHASE_DOCUMENT';
  if (String(commandType).indexOf('SALE') >= 0) return 'SALES_DOCUMENT';
  if (commandType === 'ERP_TRANSITION') return '';
  return 'DISPATCH_DECISION';
}

function orderQM9AllowedState(commandType, status) {
  const states = {
    RELEASE_DISPATCH: ['DRAFT'], UPDATE_DISPATCH: ['RELEASED', 'READY_TO_CONFIRM'],
    RECALL_DISPATCH: ['RELEASED', 'READY_TO_CONFIRM'], CONFIRM_DISPATCH: ['READY_TO_CONFIRM'],
    REVERSE_DISPATCH: ['CONFIRMED'], ADJUST_DISPATCH: ['CONFIRMED'],
    CONFIRM_PURCHASE: ['DRAFT'], REVERSE_PURCHASE: ['CONFIRMED'],
    POST_PURCHASE: ['DRAFT'], CORRECT_PURCHASE: ['CONFIRMED'],
    POST_SALE: ['DRAFT'], CORRECT_SALE: ['CONFIRMED'], REVERSE_SALE: ['CONFIRMED'],
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

function orderQM9NormalizedOriginKeys(documentRow, allRows) {
  if (!documentRow || ['PURCHASE_DOCUMENT', 'SALES_DOCUMENT'].indexOf(documentRow.entityType) < 0) return [];
  const payload = documentRow.payload || {};
  const kind = documentRow.entityType === 'PURCHASE_DOCUMENT' ? 'PURCHASE' : 'SALE';
  const documentIdField = kind === 'PURCHASE' ? 'purchaseDocumentId' : 'salesDocumentId';
  const lineType = kind === 'PURCHASE' ? 'PURCHASE_LINE' : 'SALES_LINE';
  const lines = (allRows || []).filter(row => row.entityType === lineType && orderQM9Text(row.payload && row.payload[documentIdField]) === documentRow.entityId);
  const keys = new Set();
  if (kind === 'SALE') {
    const pairs = lines.map(row => [orderQM9Text(row.payload && (row.payload.sourceDispatchId || row.payload.dispatchId)), orderQM9Text(row.payload && (row.payload.sourceDispatchLineId || row.payload.dispatchLineId))]).filter(pair => pair[0] || pair[1]);
    if (!pairs.length && orderQM9Text(payload.dispatchId || payload.sourceDispatchId)) pairs.push([orderQM9Text(payload.dispatchId || payload.sourceDispatchId), orderQM9Text(payload.dispatchLineId || payload.sourceDispatchLineId)]);
    pairs.forEach(pair => keys.add(`SALE:DISPATCH:${pair[0]}:${pair[1]}`));
    const salesOrigin = orderQM9Text(payload.salesOriginId || payload.sourceSalesDocumentId || payload.sourceSalesId);
    if (salesOrigin) keys.add(`SALE:ORIGIN:${salesOrigin}`);
  } else {
    const documentKey = orderQM9Text(payload.sourceDocumentKey);
    const originSystem = orderQM9Text(payload.originSystem).toUpperCase();
    const transactionId = orderQM9Text(payload.originTransactionId);
    const sourceVoucherIndex = orderQM9Text(payload.sourceVoucherIndex || payload.documentOrdinal || 1);
    const externalNo = orderQM9Text(payload.externalDocumentNo);
    const planId = orderQM9Text(payload.purchasePlanId);
    const shortageKey = orderQM9Text(payload.legacySourceShortageKey || payload.sourceShortageKey || payload.shortageId);
    const legacyDocumentId = orderQM9Text(payload.legacyPurchaseDocumentId);
    if (originSystem && transactionId && documentKey) keys.add(`PURCHASE:RUN_DOC:${originSystem}:${transactionId}:${documentKey}`);
    if (originSystem && transactionId) keys.add(`PURCHASE:TX:${originSystem}:${transactionId}:${sourceVoucherIndex}`);
    if (originSystem && externalNo) keys.add(`PURCHASE:DOCNO:${originSystem}:${externalNo}`);
    if (shortageKey) keys.add(`PURCHASE:SHORTAGE:${shortageKey}`);
    if (legacyDocumentId) keys.add(`PURCHASE:LEGACY:${legacyDocumentId}`);
    const purchaseOrigin = orderQM9Text(payload.purchaseOriginId || payload.sourcePurchaseId || payload.shortageId || payload.legacySourceShortageKey || payload.sourceShortageKey);
    if (purchaseOrigin) keys.add(`PURCHASE:ORIGIN:${purchaseOrigin}`);
  }
  const sourceKey = orderQM9Text(payload.sourceDocumentKey);
  if (sourceKey) keys.add(`${kind}:SOURCE:${sourceKey}`);
  return Array.from(keys).sort();
}

function orderQM9AssertNoOriginDuplicate(rows) {
  const owner = new Map();
  (rows || []).filter(row => ['PURCHASE_DOCUMENT', 'SALES_DOCUMENT'].indexOf(row.entityType) >= 0).forEach(document => {
    orderQM9NormalizedOriginKeys(document, rows).filter(key => key.indexOf('PURCHASE:DOCNO:') !== 0).forEach(key => {
      const prior = owner.get(key);
      if (prior && prior !== document.entityId) throw new Error(`ORDERQ_CENTRAL_SOURCE_ALREADY_POSTED:${key}`);
      owner.set(key, document.entityId);
    });
  });
}

function orderQM9Migrate(ss, payload) {
  orderQM9RequireSchema(payload);
  orderQEnsureAllSheets(ss);
  orderQM9EnforceTransactionBoundary(ss);
  const idempotencyKey = orderQM9Text(payload.idempotencyKey);
  const entities = Array.isArray(payload.entities) ? payload.entities : [];
  if (!idempotencyKey) throw new Error('ORDERQ_CENTRAL_MIGRATION_KEY_REQUIRED');
  const timestamp = new Date().toISOString();
  const normalizedByKey = new Map();
  entities.forEach(input => {
    const row = {
      entityType: orderQM9Text(input.entityType).toUpperCase(),
      entityId: orderQM9Text(input.entityId),
      revision: Number(input.revision || 0),
      payload: input.payload && JSON.parse(JSON.stringify(input.payload))
    };
    if (ORDERQ_M9_MIGRATION_TYPES.indexOf(row.entityType) < 0 || !row.entityId || !row.payload) {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_ENTITY_INVALID:${row.entityType}:${row.entityId}`);
    }
    if (row.entityType === 'DISPATCH_DECISION' && orderQM9Text(row.payload.status).toUpperCase() !== 'DRAFT') {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_DISPATCH_DRAFT_ONLY:${row.entityId}`);
    }
    if (row.entityType === 'PURCHASE_DOCUMENT' && orderQM9Text(row.payload.status).toUpperCase() !== 'DRAFT') {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_PURCHASE_DRAFT_ONLY:${row.entityId}`);
    }
    if (row.entityType === 'SALES_DOCUMENT' && orderQM9Text(row.payload.status).toUpperCase() !== 'DRAFT') {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_SALE_DRAFT_ONLY:${row.entityId}`);
    }
    if (row.payload.localOnly === false || row.payload.centralRevision || row.payload.ledgerSequence) {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_EVIDENCE_INVALID:${row.entityType}:${row.entityId}`);
    }
    row.payload.localOnly = false;
    row.payload.centralRevision = row.revision;
    const stored = orderQM9StoredEntity(row, timestamp);
    const existingInput = normalizedByKey.get(stored.entityKey);
    if (existingInput && orderQM9StableJson(existingInput.stored) !== orderQM9StableJson(stored.stored)) {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_CONFLICT:${row.entityType}:${row.entityId}`);
    }
    normalizedByKey.set(stored.entityKey, stored);
  });
  const normalized = [...normalizedByKey.values()].sort((a, b) => a.entityKey.localeCompare(b.entityKey));
  const combinedRows = new Map(orderQM9ReadAllEntities(ss).map(row => [orderQM9EntityKey(row.entityType, row.entityId), row]));
  normalized.forEach(row => combinedRows.set(row.entityKey, row.stored));
  orderQM9AssertNoOriginDuplicate(Array.from(combinedRows.values()));
  const fingerprint = orderQM9Digest(normalized.map(row => ({
    entityType: row.stored.entityType,
    entityId: row.stored.entityId,
    revision: row.stored.revision,
    payload: row.stored.payload
  })));
  const prior = orderQM9ReadCommand(ss, idempotencyKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error(`ORDERQ_CENTRAL_MIGRATION_IDEMPOTENCY_CONFLICT:${idempotencyKey}`);
    const transactionId = prior.result && prior.result.transactionId;
    const transaction = orderQM9ReadMigrationTransactions(ss).find(row => row.txnId === transactionId);
    if (!transaction || transaction.status !== 'COMMITTED') {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_IDEMPOTENCY_TXN_INVALID:${idempotencyKey}`);
    }
    const verified = orderQM9VerifyMigrationComplete(ss, idempotencyKey, transaction.next);
    if (!verified.complete) throw new Error(`ORDERQ_CENTRAL_MIGRATION_IDEMPOTENCY_STATE_MISMATCH:${idempotencyKey}`);
    return { duplicate: true, changes: verified.changes, cursor: orderQM9MetaNumber(ss, 'syncSequence') };
  }
  orderQM10AssertOfficialWriteEnabled('MIGRATION');
  const entityState = orderQM9ReadEntityIndex(ss);
  const pending = [];
  normalized.forEach(row => {
    const existing = entityState.index.get(row.entityKey);
    if (existing && orderQM9StableJson(existing.stored) !== orderQM9StableJson(row.stored)) {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_CONFLICT:${row.stored.entityType}:${row.stored.entityId}`);
    }
    if (!existing) pending.push(row);
  });

  const previousSync = orderQM9MetaNumber(ss, 'syncSequence');
  const changeSheet = orderQEnsureSheet(ss, 'M9_CHANGE');
  const previousChangeLastRow = changeSheet.getLastRow();
  const txnId = `OQM9MIG-${Utilities.getUuid()}`;
  const changes = pending.map((row, index) => ({
    sequence: previousSync + index + 1,
    deviceId: orderQM9Text(payload.deviceId),
    commandId: idempotencyKey,
    entityType: row.stored.entityType,
    entityId: row.stored.entityId,
    revision: row.stored.revision,
    payload: row.stored.payload,
    appliedAt: timestamp
  }));
  const endCursor = previousSync + changes.length;
  const summary = {
    schemaVersion: ORDERQ_M9_MIGRATION_TXN_SCHEMA,
    transactionId: txnId,
    fingerprint,
    targetEntityCount: normalized.length,
    targetEntityKeys: normalized.map(row => row.entityKey),
    targetEntityDigest: orderQM9EntityDigest(normalized.map(row => row.stored)),
    changeCount: changes.length,
    changeDigest: orderQM9ChangeDigest(changes),
    startCursor: previousSync,
    endCursor
  };
  const transaction = {
    txnId,
    idempotencyKey,
    status: 'PREPARED',
    previous: {
      schemaVersion: ORDERQ_M9_MIGRATION_TXN_SCHEMA,
      previousSyncSequence: previousSync,
      previousChangeLastRow,
      pendingEntityKeys: pending.map(row => row.entityKey)
    },
    next: summary,
    error: ''
  };
  orderQM9WriteMigrationTransaction(ss, transaction);
  try {
    orderQM9AppendRows(entityState.sheet, pending.map(row => row.values));
    if (orderQM9Text(payload.testFailureAt).toUpperCase() === 'ENTITIES_WRITTEN') {
      throw new Error('ORDERQ_CENTRAL_MIGRATION_FAILURE_INJECTED:ENTITIES_WRITTEN');
    }
    orderQM9AppendRows(changeSheet, changes.map(row => [
      row.sequence, row.deviceId, row.commandId, row.entityType, row.entityId,
      row.revision, JSON.stringify(row.payload), row.appliedAt
    ]));
    orderQM9SetMetaNumber(ss, 'syncSequence', endCursor);
    if (orderQM9Text(payload.testFailureAt).toUpperCase() === 'CHANGES_WRITTEN') {
      throw new Error('ORDERQ_CENTRAL_MIGRATION_FAILURE_INJECTED:CHANGES_WRITTEN');
    }
    if (!orderQM9VerifyMigrationData(ss, idempotencyKey, summary).complete) {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_COMPLETENESS_FAILED:${idempotencyKey}`);
    }
    orderQM9WriteCommand(ss, {
      idempotencyKey, commandType: 'MIGRATION', fingerprint, status: 'COMMITTED',
      deviceId: orderQM9Text(payload.deviceId), result: {
        transactionId: txnId,
        targetEntityCount: summary.targetEntityCount,
        targetEntityDigest: summary.targetEntityDigest,
        changeCount: summary.changeCount,
        changeDigest: summary.changeDigest,
        startCursor: summary.startCursor,
        endCursor: summary.endCursor
      }
    });
    if (orderQM9Text(payload.testFailureAt).toUpperCase() === 'COMMAND_WRITTEN') {
      throw new Error('ORDERQ_CENTRAL_MIGRATION_FAILURE_INJECTED:COMMAND_WRITTEN');
    }
    if (!orderQM9VerifyMigrationComplete(ss, idempotencyKey, summary).complete) {
      throw new Error(`ORDERQ_CENTRAL_MIGRATION_COMMAND_COMPLETENESS_FAILED:${idempotencyKey}`);
    }
    orderQM9WriteMigrationTransaction(ss, { ...transaction, status: 'COMMITTED', error: '' });
    return { duplicate: false, changes, cursor: endCursor };
  } catch (error) {
    if (orderQM9Text(payload.testRollbackFailureAt).toUpperCase() === 'BEFORE_ROLLBACK') throw error;
    orderQM9RollbackMigration(ss, transaction, {
      failureAt: payload.testRollbackFailureAt,
      error: String(error.message || error)
    });
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
        orderQM9ReleaseSourceClaims(ss, command, 'LEASE_EXPIRED', nowMillis);
      }
    } catch (error) {}
  });
}

function orderQM9Prepare(ss, payload) {
  orderQM9RequireSchema(payload);
  orderQEnsureAllSheets(ss);
  orderQM9EnforceTransactionBoundary(ss);
  const preparedAtMillis = Date.now();
  orderQM9ExpireStaleLeases(ss, preparedAtMillis);
  const fingerprint = orderQM9CommandFingerprint(payload);
  const idempotencyKey = orderQM9Text(payload.idempotencyKey);
  const prior = orderQM9ReadCommand(ss, idempotencyKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error(`ORDERQ_CENTRAL_IDEMPOTENCY_CONFLICT:${idempotencyKey}`);
    if (prior.status === 'COMMITTED') {
      const result = prior.result && prior.result.transactionId
        ? orderQM9OfficialResultForCommand(ss, prior)
        : prior.result;
      return { duplicate: true, committed: true, fingerprint, result };
    }
    orderQM10AssertOfficialWriteEnabled(prior.commandType || payload.commandType);
    if (prior.status !== 'PREPARED') throw new Error(`ORDERQ_CENTRAL_COMMAND_TERMINAL:${idempotencyKey}:${prior.status}`);
    return { duplicate: true, committed: false, leaseToken: prior.leaseToken, leaseExpiresAt: prior.leaseExpiresAt, fingerprint };
  }
  const commandType = orderQM9Text(payload.commandType).toUpperCase();
  orderQM10AssertOfficialWriteEnabled(commandType);
  orderQM9ValidatePurchaseMasters(ss, payload);
  orderQM9ValidateSaleMasters(ss, payload);
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
    if (orderQM9Text(payload.intent && payload.intent.commandContract).toUpperCase() === 'VOUCHER_CORE_V1'
      && orderQM9Text(target.payload && target.payload.documentContract).toUpperCase() !== 'VOUCHER_CORE_V1') {
      throw new Error(`ORDERQ_CENTRAL_COMMAND_CONTRACT_MISMATCH:${aggregateId}`);
    }
    if (orderQM9Text(payload.intent && payload.intent.commandContract).toUpperCase() === 'VOUCHER_CORE_V1'
      && commandType.indexOf('POST_') === 0) {
      const allRows = orderQM9ReadAllEntities(ss);
      const duplicateKey = orderQM9NormalizedOriginKeys(target, allRows).filter(key => key.indexOf('PURCHASE:DOCNO:') !== 0).find(key => allRows.some(row => row.entityId !== aggregateId
        && ['PURCHASE_DOCUMENT', 'SALES_DOCUMENT'].indexOf(row.entityType) >= 0
        && orderQM9NormalizedOriginKeys(row, allRows).indexOf(key) >= 0));
      const stage3Purchase = targetType === 'PURCHASE_DOCUMENT'
        && (orderQM9Text(target.payload && target.payload.contractKind) === 'PURCHASE_STAGE3_V1'
          || orderQM9Text(target.payload && target.payload.normalizedOriginVersion) === 'PURCHASE_V2');
      if (duplicateKey) throw new Error(`${stage3Purchase ? 'ORDERQ_PURCHASE_ORIGIN_DUPLICATE' : 'ORDERQ_CENTRAL_SOURCE_ALREADY_POSTED'}:${duplicateKey}`);
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
  const preparedCommand = {
    idempotencyKey, commandType, aggregateId, expectedRevision, fingerprint,
    status: 'PREPARED', leaseToken, deviceId: orderQM9Text(payload.deviceId), intent: payload.intent || null,
    preparedAt, leaseExpiresAt,
    inventoryResourceFingerprint: orderQM9InventoryResourceFingerprint(ss)
  };
  orderQM9WriteCommand(ss, preparedCommand);
  try { orderQM9PrepareSourceClaims(ss, preparedCommand, preparedAtMillis); }
  catch (error) {
    orderQM9ReleaseSourceClaims(ss, preparedCommand, 'PREPARE_FAILED', preparedAtMillis);
    orderQM9WriteCommand(ss, { ...preparedCommand, status: 'ABORTED', abortReason: String(error.message || error), abortedAt: preparedAt });
    throw error;
  }
  return { duplicate: false, committed: false, leaseToken, leaseExpiresAt, fingerprint, serverRevision: expectedRevision };
}

function orderQM9ValidatePurchaseMasters(ss, payload) {
  const commandType = orderQM9Text(payload && payload.commandType).toUpperCase();
  if (['POST_PURCHASE', 'CORRECT_PURCHASE'].indexOf(commandType) < 0) return;
  const intent = payload && payload.intent || {};
  const document = intent.document || {};
  if (orderQM9Text(intent.contractKind || document.contractKind) !== 'PURCHASE_STAGE3_V1'
    && orderQM9Text(intent.normalizedOriginVersion || document.normalizedOriginVersion) !== 'PURCHASE_V2') return;
  const supplierId = orderQM9Text(document.supplierCustomerId);
  const supplier = supplierId ? orderQReadPayloadById(orderQEnsureSheet(ss, 'CUSTOMER'), supplierId) : null;
  if (!supplier || orderQM9Text(supplier.status || 'ACTIVE').toUpperCase() !== 'ACTIVE'
    || orderQM9Text(supplier.qualityStatus).toUpperCase() === 'SUPERSEDED') {
    throw new Error(`ORDERQ_PURCHASE_SUPPLIER_MASTER_INVALID:${supplierId}`);
  }
  (Array.isArray(intent.lines) ? intent.lines : []).forEach(line => {
    const productId = orderQM9Text(line.productId);
    const product = productId ? orderQM9ReadEntity(ss, 'PRODUCT', productId) : null;
    if (!product || orderQM9Text(product.status || product.payload && product.payload.status || 'ACTIVE').toUpperCase() !== 'ACTIVE'
      || product.payload && product.payload.active === false
      || orderQM9Text(product.payload && product.payload.productIdentityType).toUpperCase() === 'TEMPORARY') {
      throw new Error(`ORDERQ_PURCHASE_PRODUCT_MASTER_INVALID:${productId}`);
    }
    const warehouseId = orderQM9Text(line.warehouseId);
    const warehouse = warehouseId ? orderQM9ReadEntity(ss, 'WAREHOUSE', warehouseId) : null;
    if (!warehouse || orderQM9Text(warehouse.status || warehouse.payload && warehouse.payload.status || 'ACTIVE').toUpperCase() !== 'ACTIVE'
      || warehouse.payload && warehouse.payload.active === false) {
      throw new Error(`ORDERQ_PURCHASE_WAREHOUSE_MASTER_INVALID:${warehouseId}`);
    }
    const productRevision = Number(line.productMasterRevision || 0);
    const warehouseRevision = Number(line.warehouseMasterRevision || 0);
    if (!Number.isSafeInteger(productRevision) || productRevision <= 0
      || !Number.isSafeInteger(warehouseRevision) || warehouseRevision <= 0
      || productRevision < Number(product.revision || 0) || warehouseRevision < Number(warehouse.revision || 0)) {
      throw new Error(`ORDERQ_PURCHASE_MASTER_REVISION_STALE:${orderQM9Text(line.sourceLineKey)}`);
    }
  });
}

function orderQM9ValidateSaleMasters(ss, payload) {
  const commandType = orderQM9Text(payload && payload.commandType).toUpperCase();
  const intent = payload && payload.intent || {};
  const document = intent.document || {};
  if (['POST_SALE', 'CORRECT_SALE'].indexOf(commandType) < 0
    || orderQM9Text(intent.contractKind || document.contractKind) !== 'SALE_STAGE4_V1') return;
  ['sales', 'delivery', 'billing'].forEach(role => {
    const id = orderQM9Text(document[`${role}CustomerId`]);
    const master = id ? orderQReadPayloadById(orderQEnsureSheet(ss, 'CUSTOMER'), id) : null;
    if (!master || orderQM9Text(master.status || 'ACTIVE').toUpperCase() !== 'ACTIVE'
      || orderQM9Text(master.qualityStatus).toUpperCase() === 'SUPERSEDED') throw new Error(`ORDERQ_SALE_CUSTOMER_MASTER_INVALID:${id}`);
    if (Number(document[`${role}CustomerRevision`] || 0) !== Number(master.revision || master.masterRevision || 0)) {
      throw new Error(`ORDERQ_SALE_SOURCE_REVISION_STALE:${role}CustomerId`);
    }
  });
  (intent.lines || []).forEach(line => {
    const product = orderQM9ReadEntity(ss, 'PRODUCT', orderQM9Text(line.productId));
    const warehouse = orderQM9ReadEntity(ss, 'WAREHOUSE', orderQM9Text(line.warehouseId));
    if (!product || product.payload && product.payload.active === false
      || orderQM9Text(product.status || product.payload && product.payload.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') throw new Error(`ORDERQ_SALE_PRODUCT_MASTER_INVALID:${orderQM9Text(line.productId)}`);
    if (!warehouse || warehouse.payload && warehouse.payload.active === false
      || orderQM9Text(warehouse.status || warehouse.payload && warehouse.payload.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') throw new Error(`ORDERQ_SALE_WAREHOUSE_MASTER_INVALID:${orderQM9Text(line.warehouseId)}`);
    if (Number(line.productMasterRevision || 0) !== Number(product.revision || 0)
      || Number(line.warehouseMasterRevision || 0) !== Number(warehouse.revision || 0)) throw new Error(`ORDERQ_SALE_SOURCE_REVISION_STALE:${orderQM9Text(line.sourceLineKey)}`);
    const mode = orderQM9Text(line.orderLinkMode || 'DIRECT').toUpperCase();
    if (mode === 'DIRECT') {
      if (orderQM9Text(line.sourceOrderId || line.sourceOrderItemId || line.sourceDispatchId || line.sourceDispatchLineId)
        || !orderQM9SameNumber(line.recognizedOrderQuantity, 0)) throw new Error(`ORDERQ_SALE_DIRECT_ORDER_LINK_FORBIDDEN:${orderQM9Text(line.sourceLineKey)}`);
      return;
    }
    const order = orderQM9ReadEntity(ss, 'ORDER', orderQM9Text(line.sourceOrderId));
    const item = orderQM9ReadEntity(ss, 'ORDER_ITEM', orderQM9Text(line.sourceOrderItemId));
    if (!order || !item || item.payload && orderQM9Text(item.payload.orderId) !== orderQM9Text(line.sourceOrderId)
      || orderQM9Text(item.payload && (item.payload.productId || item.payload.productCode)) !== orderQM9Text(line.productId || line.productCode)) {
      throw new Error(`ORDERQ_SALE_ORDER_LINK_INVALID:${orderQM9Text(line.sourceLineKey)}`);
    }
    if (orderQM9Text(order.payload && order.payload.customerId) !== orderQM9Text(document.deliveryCustomerId)) throw new Error(`ORDERQ_SALE_DELIVERY_ORDER_CUSTOMER_MISMATCH:${orderQM9Text(line.sourceLineKey)}`);
    if (Number(line.sourceOrderRevision || 0) !== Number(order.revision || 0)
      || Number(line.sourceOrderItemRevision || 0) !== Number(item.revision || 0)) throw new Error(`ORDERQ_SALE_SOURCE_REVISION_STALE:${orderQM9Text(line.sourceLineKey)}`);
    const dispatchId = orderQM9Text(line.sourceDispatchId); const dispatchLineId = orderQM9Text(line.sourceDispatchLineId);
    if (!!dispatchId !== !!dispatchLineId) throw new Error(`ORDERQ_SALE_DISPATCH_LINK_INVALID:${orderQM9Text(line.sourceLineKey)}`);
    if (dispatchId) {
      const dispatch = orderQM9ReadEntity(ss, 'DISPATCH_DECISION', dispatchId);
      const dispatchLine = orderQM9ReadEntity(ss, 'DISPATCH_LINE', dispatchLineId);
      if (!dispatch || !dispatchLine || orderQM9Text(dispatchLine.payload && dispatchLine.payload.dispatchId) !== dispatchId
        || orderQM9Text(dispatchLine.payload && dispatchLine.payload.orderItemId) !== orderQM9Text(line.sourceOrderItemId)
        || Number(line.sourceDispatchRevision || 0) !== Number(dispatch.revision || 0)
        || Number(line.sourceDispatchLineRevision || 0) !== Number(dispatchLine.revision || 0)) throw new Error(`ORDERQ_SALE_DISPATCH_LINK_INVALID:${orderQM9Text(line.sourceLineKey)}`);
    }
  });
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

function orderQM9RoundOfficialWon(value) {
  const number = Number(value || 0);
  return Math.sign(number) * Math.floor(Math.abs(number) + 0.5);
}

function orderQM9ResidualOfficialMovements(existingRows, documentId, lineIdentityId) {
  const rows = (existingRows || []).filter(row => row.entityType === 'INVENTORY_MOVEMENT'
    && orderQM9Text(row.payload && row.payload.sourceDocumentId) === documentId
    && orderQM9Text(row.payload && row.payload.lineIdentityId) === lineIdentityId);
  const reversals = new Map(); const reversedIds = new Set();
  rows.filter(row => orderQM9Text(row.payload && row.payload.effectKind) === 'REVERSE_OLD'
    || /_REVERSAL$/.test(orderQM9Text(row.payload && row.payload.movementType))).forEach(row => {
    const target = orderQM9Text(row.payload && row.payload.reversalOf); reversedIds.add(target);
    reversals.set(target, Number(reversals.get(target) || 0) + Number(row.payload.signedBaseQuantity || 0));
  });
  return rows.filter(row => orderQM9Text(row.payload && row.payload.effectKind) !== 'REVERSE_OLD'
    && !/_REVERSAL$/.test(orderQM9Text(row.payload && row.payload.movementType))).map(row => ({
    entityId: row.entityId,
    signedBaseQuantity: Number(row.payload.signedBaseQuantity || 0),
    remaining: Number(row.payload.signedBaseQuantity || 0) + Number(reversals.get(row.entityId) || 0)
  })).filter(row => Math.abs(row.remaining) > 1e-9 || (row.signedBaseQuantity === 0 && !reversedIds.has(row.entityId)));
}

function orderQM9StrictOfficialNumber(value, code) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) throw new Error(code);
  return Number(value);
}

function orderQM9ValidateOfficialVoucher(command, mutations, existingRows) {
  const commandType = orderQM9Text(command && command.commandType).toUpperCase();
  const idempotencyKey = orderQM9Text(command && command.idempotencyKey);
  const payload = command || {};
  const purchase = String(command.commandType || '').indexOf('PURCHASE') >= 0;
  const reverse = String(command.commandType || '').indexOf('REVERSE_') === 0;
  const documentType = purchase ? 'PURCHASE_DOCUMENT' : 'SALES_DOCUMENT';
  const lineType = purchase ? 'PURCHASE_LINE' : 'SALES_LINE';
  const entryType = purchase ? 'PAYABLE_ENTRY' : 'RECEIVABLE_ENTRY';
  const documentIdField = purchase ? 'purchaseDocumentId' : 'salesDocumentId';
  const lineIdField = purchase ? 'purchaseLineId' : 'salesLineId';
  const rows = type => mutations.filter(row => row.entityType === type);
  const documentRow = rows(documentType).find(row => row.entityId === command.aggregateId);
  const document = documentRow && documentRow.payload;
  const lines = rows(lineType).filter(row => orderQM9Text(row.payload[documentIdField]) === command.aggregateId
    && orderQM9Text(row.payload.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED'
    && orderQM9Text(row.payload.status).toUpperCase() === 'CONFIRMED');
  const movements = rows('INVENTORY_MOVEMENT');
  const events = rows('VOUCHER_EVENT');
  const entries = rows(entryType);
  const orderEvents = rows('ORDER_EVENT');
  const existingCurrentLines = (existingRows || []).filter(row => row.entityType === lineType
    && orderQM9Text(row.payload && row.payload[documentIdField]) === command.aggregateId
    && orderQM9Text(row.payload && row.payload.status).toUpperCase() !== 'REVERSED');
  const existingProjectionLines = existingCurrentLines.filter(row => row.entityType === lineType
    && orderQM9Text(row.payload && row.payload[documentIdField]) === command.aggregateId
    && orderQM9Text(row.payload && (row.payload.lineStatus || 'ACTIVE')).toUpperCase() !== 'DELETED');
  const allowedTypes = new Set([documentType, lineType, 'INVENTORY_MOVEMENT', 'VOUCHER_EVENT', entryType]);
  if (!purchase) allowedTypes.add('ORDER_EVENT');
  if (mutations.some(row => !allowedTypes.has(row.entityType))) throw new Error(`ORDERQ_CENTRAL_OFFICIAL_MUTATION_SCOPE_INVALID:${command.aggregateId}`);
  const intent = command.intent || {};
  if (!document || rows(documentType).length !== 1 || orderQM9Text(document.status).toUpperCase() !== (reverse ? 'REVERSED' : 'CONFIRMED')
    || Number(documentRow.revision || 0) !== Number(command.expectedRevision || 0) + 1
    || events.length !== 1 || !entries.length || !orderQM9Text(intent.commandId)
    || !orderQM9Text(intent.actor) || !orderQM9Text(intent.occurredAt)
    || (String(command.commandType || '').indexOf('POST_') !== 0 && !orderQM9Text(intent.reason))) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_VOUCHER_RESULT_INVALID:${command.aggregateId}`);
  }
  const projectionLines = rows(lineType).filter(row => orderQM9Text(row.payload && row.payload[documentIdField]) === command.aggregateId);
  const existingIdentities = (reverse ? existingCurrentLines : existingProjectionLines).map(row => orderQM9Text(row.payload && row.payload.lineIdentityId));
  const intendedIdentities = Array.isArray(intent.lines) ? intent.lines.map(row => orderQM9Text(row.lineIdentityId)) : [];
  const expectedIdentities = new Set(reverse ? existingIdentities
    : String(command.commandType || '').indexOf('POST_') === 0 ? (intendedIdentities.length ? intendedIdentities : existingIdentities)
      : [].concat(existingIdentities, intendedIdentities));
  const projectedIdentities = projectionLines.map(row => orderQM9Text(row.payload && row.payload.lineIdentityId));
  if (Array.from(expectedIdentities).some(identity => !identity) || projectedIdentities.some(identity => !identity)
    || new Set(projectedIdentities).size !== projectedIdentities.length
    || projectionLines.length !== expectedIdentities.size || projectedIdentities.some(identity => !expectedIdentities.has(identity))) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_LINE_CARDINALITY_INVALID:${command.aggregateId}`);
  }
  if (reverse && projectionLines.some(row => orderQM9Text(row.payload.status).toUpperCase() !== 'REVERSED')) throw new Error(`ORDERQ_CENTRAL_OFFICIAL_REVERSE_TOMBSTONE_INVALID:${command.aggregateId}`);
  if (String(command.commandType || '').indexOf('POST_') === 0 && movements.length !== lines.length) throw new Error(`ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_CARDINALITY_INVALID:${command.aggregateId}`);
  if (String(command.commandType || '').indexOf('CORRECT_') === 0) {
    const beforeByIdentity = new Map(existingProjectionLines.map(row => [orderQM9Text(row.payload.lineIdentityId), row.payload]));
    const afterActive = projectionLines.filter(row => orderQM9Text(row.payload.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED');
    const afterByIdentity = new Map(afterActive.map(row => [orderQM9Text(row.payload.lineIdentityId), row.payload]));
    const expectedEffects = [];
    new Set([].concat(Array.from(beforeByIdentity.keys()), Array.from(afterByIdentity.keys()))).forEach(identity => {
      const beforeLine = beforeByIdentity.get(identity); const afterLine = afterByIdentity.get(identity);
      const sameInventory = beforeLine && afterLine && orderQM9Text(beforeLine.productId) === orderQM9Text(afterLine.productId) && orderQM9Text(beforeLine.warehouseId) === orderQM9Text(afterLine.warehouseId);
      if (sameInventory) expectedEffects.push({ identity, effectKind:'DELTA', reversalOf:'' });
      else {
        if (beforeLine) {
          const residuals = orderQM9ResidualOfficialMovements(existingRows, command.aggregateId, identity);
          const reversalTargets = residuals.length ? residuals.map(row => row.entityId) : [orderQM9Text(beforeLine.movementId)];
          reversalTargets.forEach(reversalOf => expectedEffects.push({ identity, effectKind:'REVERSE_OLD', reversalOf }));
        }
        if (afterLine) expectedEffects.push({ identity, effectKind:'APPLY_NEW', reversalOf:'' });
      }
      if (beforeLine && !afterLine && !projectionLines.some(row => orderQM9Text(row.payload.lineIdentityId) === identity && orderQM9Text(row.payload.lineStatus).toUpperCase() === 'DELETED')) throw new Error(`ORDERQ_CENTRAL_OFFICIAL_LINE_TOMBSTONE_REQUIRED:${identity}`);
    });
    const effectKey = row => `${row.identity}\u001f${row.effectKind}\u001f${row.reversalOf}`;
    const actualKeys = movements.map(row => effectKey({ identity:orderQM9Text(row.payload.lineIdentityId), effectKind:orderQM9Text(row.payload.effectKind), reversalOf:orderQM9Text(row.payload.reversalOf) }));
    const expectedKeys = expectedEffects.map(effectKey);
    if (new Set(actualKeys).size !== actualKeys.length || new Set(expectedKeys).size !== expectedKeys.length
      || actualKeys.length !== expectedKeys.length || actualKeys.some(key => expectedKeys.indexOf(key) < 0)) throw new Error(`ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_CARDINALITY_INVALID:${command.aggregateId}`);
  }
  if (reverse) {
    const expectedReversalIds = existingCurrentLines.flatMap(row => orderQM9ResidualOfficialMovements(existingRows, command.aggregateId, orderQM9Text(row.payload.lineIdentityId)).map(effect => effect.entityId));
    const actualReversalIds = movements.map(row => orderQM9Text(row.payload.reversalOf));
    if (movements.some(row => orderQM9Text(row.payload.effectKind) !== 'REVERSE_OLD')
      || new Set(actualReversalIds).size !== actualReversalIds.length || new Set(expectedReversalIds).size !== expectedReversalIds.length
      || actualReversalIds.length !== expectedReversalIds.length || actualReversalIds.some(id => expectedReversalIds.indexOf(id) < 0)) {
      throw new Error(`ORDERQ_CENTRAL_OFFICIAL_REVERSE_MOVEMENT_CARDINALITY_INVALID:${command.aggregateId}`);
    }
  }
  const voucherCommands = ['POST_PURCHASE', 'CORRECT_PURCHASE', 'REVERSE_PURCHASE', 'POST_SALE', 'CORRECT_SALE', 'REVERSE_SALE'];
  if (voucherCommands.indexOf(commandType) >= 0 && orderQM9Text(payload.intent && payload.intent.commandContract).toUpperCase() !== 'VOUCHER_CORE_V1') {
    throw new Error(`ORDERQ_CENTRAL_COMMAND_CONTRACT_REQUIRED:${commandType}`);
  }
  if (orderQM9Text(payload.intent && payload.intent.commandContract).toUpperCase() === 'VOUCHER_CORE_V1'
    && orderQM9Text(payload.intent && payload.intent.commandId) !== idempotencyKey) {
    throw new Error('ORDERQ_CENTRAL_COMMAND_IDEMPOTENCY_MISMATCH');
  }
  const event = events[0].payload;
  const expectedEventType = `${purchase ? 'PURCHASE' : 'SALE'}_${String(command.commandType || '').indexOf('POST_') === 0 ? 'POSTED' : String(command.commandType || '').indexOf('CORRECT_') === 0 ? 'CORRECTED' : 'REVERSED'}`;
  if (orderQM9Text(event.documentId) !== command.aggregateId
    || orderQM9Text(event.eventType).toUpperCase() !== expectedEventType
    || orderQM9Text(event.commandId) !== orderQM9Text(intent.commandId)
    || Number(event.sourceDocumentRevision || 0) !== Number(command.expectedRevision || 0) + 1) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_VOUCHER_EVENT_INVALID:${command.aggregateId}`);
  }
  const declaredEffects = new Set((event.lineEffects || []).map(row => `${orderQM9Text(row.entityType).toUpperCase()}:${orderQM9Text(row.entityId)}`));
  const actualEffects = [].concat(
    movements.map(row => `INVENTORY_MOVEMENT:${row.entityId}`),
    orderEvents.map(row => `ORDER_EVENT:${row.entityId}`),
    entries.map(row => `${entryType}:${row.entityId}`)
  );
  if (declaredEffects.size !== actualEffects.length || actualEffects.some(key => !declaredEffects.has(key))) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_EFFECT_CARDINALITY_INVALID:${command.aggregateId}`);
  }
  if (!purchase && orderQM9Text(document.sourceType).toUpperCase() === 'DIRECT' && orderEvents.length) {
    throw new Error(`ORDERQ_CENTRAL_DIRECT_ORDER_EVENT_FORBIDDEN:${command.aggregateId}`);
  }
  if (!purchase && orderQM9Text(document.sourceType).toUpperCase() === 'DIRECT' && projectionLines.some(row => {
    const line = row.payload || {};
    return orderQM9Text(line.orderLinkMode).toUpperCase() === 'ORDER_Q' || orderQM9Text(line.sourceOrderId)
      || orderQM9Text(line.sourceOrderItemId) || orderQM9Text(line.sourceDispatchId)
      || orderQM9Text(line.sourceDispatchLineId) || orderQM9Text(line.allocationEventId)
      || (Array.isArray(line.allocationEventIds) && line.allocationEventIds.some(orderQM9Text));
  })) throw new Error(`ORDERQ_CENTRAL_DIRECT_ORDER_LINK_FORBIDDEN:${command.aggregateId}`);
  if (!purchase && orderQM9Text(document.sourceType).toUpperCase() === 'ORDER_Q') {
    projectionLines.forEach(row => {
      const line = row.payload;
      const order = (existingRows || []).find(candidate => candidate.entityType === 'ORDER'
        && candidate.entityId === orderQM9Text(line.sourceOrderId));
      const item = (existingRows || []).find(candidate => candidate.entityType === 'ORDER_ITEM'
        && candidate.entityId === orderQM9Text(line.sourceOrderItemId));
      const dispatchId = orderQM9Text(line.sourceDispatchId); const dispatchLineId = orderQM9Text(line.sourceDispatchLineId);
      const hasDispatch = Boolean(dispatchId);
      const dispatchLine = hasDispatch ? (existingRows || []).find(candidate => candidate.entityType === 'DISPATCH_LINE'
        && candidate.entityId === dispatchLineId) : null;
      if (orderQM9Text(line.orderLinkMode).toUpperCase() !== 'ORDER_Q' || !order || !item
        || orderQM9Text(item.payload && item.payload.orderId) !== order.entityId
        || hasDispatch !== Boolean(dispatchLineId)
        || (hasDispatch && (!dispatchLine || orderQM9Text(dispatchLine.payload && dispatchLine.payload.dispatchId) !== dispatchId
          || orderQM9Text(dispatchLine.payload && dispatchLine.payload.orderItemId) !== item.entityId
          || orderQM9Text(dispatchLine.payload && (dispatchLine.payload.actualProductId || dispatchLine.payload.productId || dispatchLine.payload.requestedProductId)) !== orderQM9Text(line.productId)
          || orderQM9Text(dispatchLine.payload && dispatchLine.payload.warehouseId) !== orderQM9Text(line.warehouseId)))) {
        throw new Error(`ORDERQ_CENTRAL_ORDER_LINK_INVALID:${row.entityId}`);
      }
    });
    orderEvents.forEach(row => {
      const detail = row.payload.detail || {};
      const item = (existingRows || []).find(candidate => candidate.entityType === 'ORDER_ITEM' && candidate.entityId === orderQM9Text(detail.orderItemId));
      const dispatchId = orderQM9Text(detail.sourceDispatchId); const dispatchLineId = orderQM9Text(detail.sourceDispatchLineId);
      const hasDispatch = Boolean(dispatchId);
      const dispatchLine = hasDispatch ? (existingRows || []).find(candidate => candidate.entityType === 'DISPATCH_LINE' && candidate.entityId === dispatchLineId) : null;
      const eventLine = projectionLines.find(candidate => orderQM9Text(candidate.payload.salesLineId) === orderQM9Text(detail.salesLineId));
      const eventType = orderQM9Text(row.payload.eventType).toUpperCase();
      const allocatedLineInvalid = eventType === 'SALES_TRANSFER_ALLOCATED' && (orderQM9Text(eventLine && eventLine.payload && eventLine.payload.sourceOrderId) !== orderQM9Text(row.payload.orderId)
        || orderQM9Text(eventLine && eventLine.payload && eventLine.payload.sourceOrderItemId) !== orderQM9Text(item && item.entityId)
        || orderQM9Text(eventLine && eventLine.payload && eventLine.payload.sourceDispatchId) !== orderQM9Text(detail.sourceDispatchId)
        || orderQM9Text(eventLine && eventLine.payload && eventLine.payload.sourceDispatchLineId) !== orderQM9Text(detail.sourceDispatchLineId));
      if (!item || orderQM9Text(item.payload && item.payload.orderId) !== orderQM9Text(row.payload.orderId)
        || hasDispatch !== Boolean(dispatchLineId)
        || (hasDispatch && (!dispatchLine || orderQM9Text(dispatchLine.payload && dispatchLine.payload.orderItemId) !== item.entityId)) || !eventLine
        || orderQM9Text(detail.salesDocumentId) !== command.aggregateId
        || allocatedLineInvalid) {
        throw new Error(`ORDERQ_CENTRAL_ORDER_EVENT_LINK_INVALID:${row.entityId}`);
      }
      if (orderQM9Text(row.payload.eventType).toUpperCase() === 'SALES_TRANSFER_REVERSED') {
        const allocationId = orderQM9Text(detail.allocationEventId);
        const allocation = (existingRows || []).find(candidate => candidate.entityType === 'ORDER_EVENT' && candidate.entityId === allocationId);
        const prior = (existingRows || []).filter(candidate => candidate.entityType === 'ORDER_EVENT'
          && orderQM9Text(candidate.payload && candidate.payload.eventType).toUpperCase() === 'SALES_TRANSFER_REVERSED'
          && orderQM9Text(candidate.payload && candidate.payload.detail && candidate.payload.detail.allocationEventId) === allocationId)
          .reduce((sum, candidate) => sum + Number(candidate.payload.detail.transferredQty || 0), 0);
        const negativePost = command.commandType === 'POST_SALE';
        const richRef = (Array.isArray(eventLine.payload.reversalSourceAllocations) ? eventLine.payload.reversalSourceAllocations : [])
          .find(ref => orderQM9Text(ref.allocationEventId) === allocationId);
        const allocationLinkInvalid = negativePost
          ? orderQM9Text(allocation && allocation.payload && allocation.payload.detail && allocation.payload.detail.productId) !== orderQM9Text(eventLine.payload.productId)
            || (orderQM9Text(allocation && allocation.payload && allocation.payload.detail && allocation.payload.detail.warehouseId)
              && orderQM9Text(allocation.payload.detail.warehouseId) !== orderQM9Text(eventLine.payload.warehouseId))
            || (richRef && (orderQM9Text(richRef.sourceSalesDocumentId) !== orderQM9Text(allocation && allocation.payload && allocation.payload.detail && allocation.payload.detail.salesDocumentId)
              || orderQM9Text(richRef.sourceSalesLineId) !== orderQM9Text(allocation && allocation.payload && allocation.payload.detail && allocation.payload.detail.salesLineId)
              || orderQM9Text(richRef.sourceLineIdentityId) !== orderQM9Text(allocation && allocation.payload && allocation.payload.detail && allocation.payload.detail.lineIdentityId)))
          : orderQM9Text(allocation && allocation.payload && allocation.payload.detail && allocation.payload.detail.salesDocumentId) !== command.aggregateId
            || orderQM9Text(allocation && allocation.payload && allocation.payload.detail && allocation.payload.detail.salesLineId) !== orderQM9Text(detail.salesLineId);
        if (!allocation || orderQM9Text(allocation.payload && allocation.payload.eventType).toUpperCase() !== 'SALES_TRANSFER_ALLOCATED'
          || orderQM9Text(allocation.payload && allocation.payload.orderId) !== orderQM9Text(row.payload.orderId)
          || orderQM9Text(allocation.payload && allocation.payload.detail && allocation.payload.detail.orderItemId) !== orderQM9Text(detail.orderItemId)
          || allocationLinkInvalid
          || prior + Number(detail.transferredQty || 0) > Number(allocation.payload.detail.transferredQty || 0) + 1e-9) {
          throw new Error(`ORDERQ_CENTRAL_ORDER_ALLOCATION_REVERSAL_INVALID:${row.entityId}`);
        }
      }
    });
    new Set(orderEvents.map(row => orderQM9Text(row.payload && row.payload.detail && row.payload.detail.orderItemId))).forEach(itemId => {
      const item = (existingRows || []).find(candidate => candidate.entityType === 'ORDER_ITEM' && candidate.entityId === itemId);
      const existingAllocated = (existingRows || []).filter(candidate => candidate.entityType === 'ORDER_EVENT'
        && orderQM9Text(candidate.payload && candidate.payload.detail && candidate.payload.detail.orderItemId) === itemId
        && ['SALES_TRANSFER_ALLOCATED', 'SALES_TRANSFER_REVERSED'].indexOf(orderQM9Text(candidate.payload && candidate.payload.eventType).toUpperCase()) >= 0)
        .reduce((sum, candidate) => sum + (orderQM9Text(candidate.payload.eventType).toUpperCase() === 'SALES_TRANSFER_REVERSED' ? -1 : 1) * Number(candidate.payload.detail.transferredQty || 0), 0);
      const commandAllocated = orderEvents.filter(candidate => orderQM9Text(candidate.payload.detail && candidate.payload.detail.orderItemId) === itemId)
        .reduce((sum, candidate) => sum + (orderQM9Text(candidate.payload.eventType).toUpperCase() === 'SALES_TRANSFER_REVERSED' ? -1 : 1) * Number(candidate.payload.detail.transferredQty || 0), 0);
      const order = (existingRows || []).find(candidate => candidate.entityType === 'ORDER'
        && candidate.entityId === orderQM9Text(item && item.payload && item.payload.orderId));
      const orderPayload = order && order.payload || {};
      const itemPayload = item && item.payload || {};
      const cancelled = Math.max(0, Number(itemPayload.cancelledQuantity || 0));
      const rawOrdered = Number(itemPayload.finalQuantity ?? itemPayload.rawQuantity ?? itemPayload.quantity ?? 0);
      const ordered = (orderQM9Text(orderPayload.orderStatus || orderPayload.cancelType).toUpperCase() === 'FULL_CANCEL'
        || orderQM9Text(itemPayload.status).toUpperCase() === 'CANCELLED' || itemPayload.active === false)
        ? 0 : Math.max(0, (Number.isFinite(rawOrdered) ? rawOrdered : 0) - (Number.isFinite(cancelled) ? cancelled : 0));
      if (!item || existingAllocated + commandAllocated > ordered + 1e-9 || existingAllocated + commandAllocated < -1e-9) {
        throw new Error(`ORDERQ_CENTRAL_ORDER_ALLOCATION_LIMIT:${itemId}`);
      }
    });
  }
  if (!reverse) {
    if (!lines.length || !movements.length) throw new Error(`ORDERQ_CENTRAL_OFFICIAL_LINES_REQUIRED:${command.aggregateId}`);
    lines.forEach(row => {
      const line = row.payload;
      const supply = orderQM9RoundOfficialWon(Number(line.quantity || 0) * Number(line.unitPrice || 0));
      if (Number(line.supplyAmount || 0) !== supply || Number(line.totalAmount || 0) !== supply
        || line.vatAmount !== null || orderQM9Text(line.taxType) !== 'VAT_INCLUDED_IN_SUPPLY') {
        throw new Error(`ORDERQ_CENTRAL_OFFICIAL_LINE_AMOUNT_INVALID:${line[lineIdField]}`);
      }
    });
    const supply = lines.reduce((sum, row) => sum + Number(row.payload.supplyAmount || 0), 0);
    if (Number(document.supplyAmount || 0) !== supply || Number(document.totalAmount || 0) !== supply
      || document.vatAmount !== null || orderQM9Text(document.taxType) !== 'VAT_INCLUDED_IN_SUPPLY') {
      throw new Error(`ORDERQ_CENTRAL_OFFICIAL_DOCUMENT_AMOUNT_INVALID:${command.aggregateId}`);
    }
  }
  const operationType = String(command.commandType || '').indexOf('POST_') === 0 ? 'POST'
    : String(command.commandType || '').indexOf('CORRECT_') === 0 ? 'CORRECTION' : 'REVERSAL';
  const expectedMovementType = `${orderQM9Text(document.sourceType).toUpperCase()}_${purchase ? 'PURCHASE' : 'SALE'}_${operationType}`;
  const reversalType = `${orderQM9Text(document.sourceType).toUpperCase()}_${purchase ? 'PURCHASE' : 'SALE'}_REVERSAL`;
  if (movements.some(row => [expectedMovementType, reversalType].indexOf(orderQM9Text(row.payload.movementType).toUpperCase()) < 0)) {
    throw new Error(`ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_TYPE_INVALID:${command.aggregateId}`);
  }
  movements.forEach(row => {
    if (orderQM9Text(row.payload.commandId) !== orderQM9Text(intent.commandId)
      || row.payload.officialCommandProofRequired !== true
      || orderQM9Text(row.payload.sourceDocumentId) !== command.aggregateId) {
      throw new Error(`ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_PROOF_INVALID:${row.entityId}`);
    }
    if (orderQM9Text(row.payload.reversalOf)) {
      const original = (existingRows || []).find(candidate => candidate.entityType === 'INVENTORY_MOVEMENT'
        && candidate.entityId === orderQM9Text(row.payload.reversalOf));
      if (!original || original.payload.officialCommandProofRequired !== true
        || orderQM9Text(original.payload.sourceDocumentId) !== command.aggregateId
        || !/^(DIRECT|ORDER_Q)_(PURCHASE|SALE)$/.test(orderQM9Text(original.payload.sourceDocumentType).toUpperCase())) {
        throw new Error(`ORDERQ_CENTRAL_OFFICIAL_REVERSAL_PROOF_INVALID:${row.entityId}`);
      }
    }
  });
  entries.forEach(row => {
    const entry = row.payload;
    if (orderQM9Text(entry[documentIdField]) !== command.aggregateId
      || Number(entry.sourceDocumentRevision || 0) !== Number(command.expectedRevision || 0) + 1
      || entry.vatAmount !== null || orderQM9Text(entry.taxType) !== 'VAT_INCLUDED_IN_SUPPLY'
      || Number(entry.supplyAmount || 0) !== Number(entry.totalAmount || 0)
      || orderQM9Text(entry.commandId) !== orderQM9Text(intent.commandId)) {
      throw new Error(`ORDERQ_CENTRAL_OFFICIAL_LEDGER_ENTRY_INVALID:${row.entityId}`);
    }
  });
  const previousDocumentRow = (existingRows || []).find(row => row.entityType === documentType && row.entityId === command.aggregateId);
  const previousDocument = previousDocumentRow && previousDocumentRow.payload || {};
  const previousTotal = String(command.commandType || '').indexOf('POST_') === 0 ? 0 : Number(previousDocument.totalAmount || previousDocument.totalAmountWon || previousDocument.amountWon || 0);
  const nextTotal = reverse ? 0 : Number(document.totalAmount || 0);
  const entryDelta = entries.reduce((sum, row) => sum + Number(row.payload.totalAmount || 0), 0);
  orderQM9RequireSameNumber(entryDelta, nextTotal - previousTotal, 'ORDERQ_CENTRAL_OFFICIAL_ENTRY_DELTA_INVALID', command.aggregateId);
  const partnerField = purchase ? 'supplierCustomerId' : 'billingCustomerId';
  const oldPartner = orderQM9Text(previousDocument[partnerField]);
  const nextPartner = orderQM9Text(document[partnerField]);
  const oldBalance = (existingRows || []).filter(row => row.entityType === entryType
    && orderQM9Text(row.payload && row.payload[documentIdField]) === command.aggregateId
    && orderQM9Text(row.payload && row.payload.partnerId) === oldPartner)
    .reduce((sum, row) => sum + Number(row.payload.totalAmount || 0), 0);
  if (reverse) {
    if (entries.some(row => orderQM9Text(row.payload.partnerId) !== oldPartner)) throw new Error('ORDERQ_CENTRAL_OFFICIAL_REVERSE_PARTNER_INVALID');
    orderQM9RequireSameNumber(entryDelta, -oldBalance, 'ORDERQ_CENTRAL_OFFICIAL_REVERSE_BALANCE_INVALID', command.aggregateId);
  } else if (String(command.commandType || '').indexOf('POST_') !== 0 && oldPartner !== nextPartner) {
    orderQM9RequireSameNumber(entries.filter(row => orderQM9Text(row.payload.partnerId) === oldPartner).reduce((sum, row) => sum + Number(row.payload.totalAmount || 0), 0), -oldBalance, 'ORDERQ_CENTRAL_OFFICIAL_PARTNER_RELEASE_INVALID', command.aggregateId);
    orderQM9RequireSameNumber(entries.filter(row => orderQM9Text(row.payload.partnerId) === nextPartner).reduce((sum, row) => sum + Number(row.payload.totalAmount || 0), 0), nextTotal, 'ORDERQ_CENTRAL_OFFICIAL_PARTNER_ASSIGN_INVALID', command.aggregateId);
  }
  const exactSet = (actual, expected, code) => {
    const actualKeys = actual.map(orderQM9StableJson); const expectedKeys = expected.map(orderQM9StableJson);
    if (new Set(actualKeys).size !== actualKeys.length || new Set(expectedKeys).size !== expectedKeys.length
      || actualKeys.length !== expectedKeys.length || actualKeys.some(key => expectedKeys.indexOf(key) < 0)) throw new Error(`${code}:${command.aggregateId}`);
  };
  (Array.isArray(intent.lines)?intent.lines:[]).filter(row=>orderQM9Text(row&&row.lineStatus||'ACTIVE').toUpperCase()!=='DELETED').forEach(row=>{
    orderQM9StrictOfficialNumber(row.quantity!==undefined?row.quantity:row.actualQuantity,'ORDERQ_CENTRAL_OFFICIAL_QUANTITY_REQUIRED');
    orderQM9StrictOfficialNumber(row.unitPrice,'ORDERQ_CENTRAL_OFFICIAL_UNIT_PRICE_REQUIRED');
    orderQM9StrictOfficialNumber(row.baseQuantity,'ORDERQ_CENTRAL_OFFICIAL_BASE_QUANTITY_REQUIRED');
  });
  projectionLines.filter(row => orderQM9Text(row.payload.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED').forEach(row => {
    orderQM9StrictOfficialNumber(row.payload.quantity, 'ORDERQ_CENTRAL_OFFICIAL_QUANTITY_REQUIRED');
    orderQM9StrictOfficialNumber(row.payload.unitPrice, 'ORDERQ_CENTRAL_OFFICIAL_UNIT_PRICE_REQUIRED');
    orderQM9StrictOfficialNumber(row.payload.baseQuantity, 'ORDERQ_CENTRAL_OFFICIAL_BASE_QUANTITY_REQUIRED');
  });
  const beforeByIdentity = new Map(existingProjectionLines.map(row => [orderQM9Text(row.payload.lineIdentityId), row.payload]));
  const afterByIdentity = new Map(projectionLines.filter(row => orderQM9Text(row.payload.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED').map(row => [orderQM9Text(row.payload.lineIdentityId), row.payload]));
  const quantityEffect = value => purchase ? Number(value) : -Number(value);
  const movementOperation = String(command.commandType || '').indexOf('POST_') === 0 ? 'POST' : reverse ? 'REVERSAL' : 'CORRECTION';
  const expectedMovementEffects = [];
  const movementIdentities = reverse ? existingCurrentLines.map(row => orderQM9Text(row.payload.lineIdentityId))
    : Array.from(new Set([].concat(Array.from(beforeByIdentity.keys()), Array.from(afterByIdentity.keys()))));
  movementIdentities.forEach(identity => {
    const beforeLine = beforeByIdentity.get(identity) || (existingCurrentLines.find(row => orderQM9Text(row.payload.lineIdentityId) === identity) || {}).payload;
    const afterLine = afterByIdentity.get(identity);
    if (String(command.commandType || '').indexOf('POST_') === 0) {
      expectedMovementEffects.push({lineIdentityId:identity,movementType:`${orderQM9Text(document.sourceType).toUpperCase()}_${purchase?'PURCHASE':'SALE'}_POST`,signedBaseQuantity:quantityEffect(afterLine.baseQuantity),effectKind:'APPLY_NEW',effectOrdinal:1,reversalOf:'',productId:orderQM9Text(afterLine.productId),warehouseId:orderQM9Text(afterLine.warehouseId)});return;
    }
    const sameInventory = beforeLine && afterLine && orderQM9Text(beforeLine.productId) === orderQM9Text(afterLine.productId) && orderQM9Text(beforeLine.warehouseId) === orderQM9Text(afterLine.warehouseId);
    if (!reverse && sameInventory) {
      expectedMovementEffects.push({lineIdentityId:identity,movementType:`${orderQM9Text(document.sourceType).toUpperCase()}_${purchase?'PURCHASE':'SALE'}_CORRECTION`,signedBaseQuantity:quantityEffect(afterLine.baseQuantity)-quantityEffect(beforeLine.baseQuantity),effectKind:'DELTA',effectOrdinal:1,reversalOf:'',productId:orderQM9Text(afterLine.productId),warehouseId:orderQM9Text(afterLine.warehouseId)});return;
    }
    const residuals = beforeLine ? orderQM9ResidualOfficialMovements(existingRows, command.aggregateId, identity) : [];
    residuals.forEach((effect,index)=>expectedMovementEffects.push({lineIdentityId:identity,movementType:`${orderQM9Text(document.sourceType).toUpperCase()}_${purchase?'PURCHASE':'SALE'}_${movementOperation}`,signedBaseQuantity:-effect.remaining,effectKind:'REVERSE_OLD',effectOrdinal:index+1,reversalOf:effect.entityId,productId:orderQM9Text(beforeLine.productId),warehouseId:orderQM9Text(beforeLine.warehouseId)}));
    if (!reverse && afterLine) expectedMovementEffects.push({lineIdentityId:identity,movementType:`${orderQM9Text(document.sourceType).toUpperCase()}_${purchase?'PURCHASE':'SALE'}_CORRECTION`,signedBaseQuantity:quantityEffect(afterLine.baseQuantity),effectKind:'APPLY_NEW',effectOrdinal:residuals.length+1,reversalOf:'',productId:orderQM9Text(afterLine.productId),warehouseId:orderQM9Text(afterLine.warehouseId)});
  });
  exactSet(movements.map(row=>({lineIdentityId:orderQM9Text(row.payload.lineIdentityId),movementType:orderQM9Text(row.payload.movementType),signedBaseQuantity:orderQM9StrictOfficialNumber(row.payload.signedBaseQuantity,'ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_QUANTITY_REQUIRED'),effectKind:orderQM9Text(row.payload.effectKind),effectOrdinal:Number(row.payload.effectOrdinal||0),reversalOf:orderQM9Text(row.payload.reversalOf),productId:orderQM9Text(row.payload.productId),warehouseId:orderQM9Text(row.payload.warehouseId)})),expectedMovementEffects,'ORDERQ_CENTRAL_OFFICIAL_MOVEMENT_EFFECT_MISMATCH');
  const priorEntries=(existingRows||[]).filter(row=>row.entityType===entryType&&orderQM9Text(row.payload&&row.payload[documentIdField])===command.aggregateId).map(row=>row.payload);
  const activeEntries=priorEntries.filter(entry=>orderQM9Text(entry.partnerId)===oldPartner).map(entry=>({entry,balance:Number(entry.totalAmount||0)+priorEntries.filter(candidate=>orderQM9Text(candidate.reversalOf)===orderQM9Text(entry.entryId)).reduce((sum,row)=>sum+Number(row.totalAmount||0),0)})).filter(row=>Math.abs(row.balance)>1e-9||Number(row.entry.totalAmount||0)===0);
  const prefix=purchase?'PAYABLE':'RECEIVABLE';const expectedEntries=[];
  if(String(command.commandType||'').indexOf('POST_')===0) expectedEntries.push({entryType:`${prefix}_POST`,partnerId:nextPartner,supplyAmount:nextTotal,totalAmount:nextTotal,effectOrdinal:1,reversalOf:''});
  else if(reverse) activeEntries.forEach((row,index)=>expectedEntries.push({entryType:`${prefix}_REVERSAL`,partnerId:oldPartner,supplyAmount:-row.balance,totalAmount:-row.balance,effectOrdinal:index+1,reversalOf:orderQM9Text(row.entry.entryId)}));
  else if(oldPartner!==nextPartner){activeEntries.forEach((row,index)=>expectedEntries.push({entryType:`${prefix}_PARTNER_RELEASE`,partnerId:oldPartner,supplyAmount:-row.balance,totalAmount:-row.balance,effectOrdinal:index+1,reversalOf:orderQM9Text(row.entry.entryId)}));expectedEntries.push({entryType:`${prefix}_PARTNER_ASSIGN`,partnerId:nextPartner,supplyAmount:nextTotal,totalAmount:nextTotal,effectOrdinal:expectedEntries.length+1,reversalOf:''});}
  else expectedEntries.push({entryType:`${prefix}_CORRECTION`,partnerId:nextPartner,supplyAmount:nextTotal-previousTotal,totalAmount:nextTotal-previousTotal,effectOrdinal:1,reversalOf:''});
  exactSet(entries.map(row=>({entryType:orderQM9Text(row.payload.entryType),partnerId:orderQM9Text(row.payload.partnerId),supplyAmount:orderQM9StrictOfficialNumber(row.payload.supplyAmount,'ORDERQ_CENTRAL_OFFICIAL_ENTRY_AMOUNT_REQUIRED'),totalAmount:orderQM9StrictOfficialNumber(row.payload.totalAmount,'ORDERQ_CENTRAL_OFFICIAL_ENTRY_AMOUNT_REQUIRED'),effectOrdinal:Number(row.payload.effectOrdinal||0),reversalOf:orderQM9Text(row.payload.reversalOf)})),expectedEntries,'ORDERQ_CENTRAL_OFFICIAL_ENTRY_EFFECT_MISMATCH');
  const expectedOrderEffects=[];
  if(!purchase&&orderQM9Text(document.sourceType).toUpperCase()==='ORDER_Q'){
    const priorOrderEvents=(existingRows||[]).filter(row=>row.entityType==='ORDER_EVENT').map(row=>row.payload);
    const allocations=priorOrderEvents.filter(row=>orderQM9Text(row.eventType).toUpperCase()==='SALES_TRANSFER_ALLOCATED');
    const priorReversals=priorOrderEvents.filter(row=>orderQM9Text(row.eventType).toUpperCase()==='SALES_TRANSFER_REVERSED');
    const restorationEvents=allocations.filter(row=>orderQM9Text(row.detail&&row.detail.restoresReversalEventId));
    const descriptor=(source,qty,ordinal,allocationEventId,subtype,restoresReversalEventId)=>({eventType:qty>0?'SALES_TRANSFER_ALLOCATED':'SALES_TRANSFER_REVERSED',orderId:orderQM9Text(source.sourceOrderId),orderItemId:orderQM9Text(source.sourceOrderItemId),salesLineId:orderQM9Text(source.salesLineId),transferredQty:Math.abs(Number(qty)),allocationEventId:orderQM9Text(allocationEventId),allocationKind:qty>0?orderQM9Text(subtype||'ORDINARY'):'',reversalKind:qty<0?orderQM9Text(subtype||'CORRECTION'):'',restoresReversalEventId:orderQM9Text(restoresReversalEventId),effectOrdinal:ordinal});
    const reverseQuantity=(source,qty,ordinalStart,explicitOnly)=>{
      let remaining=Math.abs(Number(qty||0));const effects=[];
      const rich=Array.isArray(source.reversalSourceAllocations)?source.reversalSourceAllocations:[];
      const explicitIds=new Set([].concat(rich.map(row=>row.allocationEventId),Array.isArray(source.allocationEventIds)?source.allocationEventIds:[],source.allocationEventId||[]).map(orderQM9Text).filter(Boolean));
      const candidates=allocations.filter(row=>{
        const detail=row.detail||{};
        if(explicitOnly)return explicitIds.has(orderQM9Text(row.eventId));
        return orderQM9Text(row.orderId)===orderQM9Text(source.sourceOrderId)&&orderQM9Text(detail.orderItemId)===orderQM9Text(source.sourceOrderItemId)
          &&orderQM9Text(detail.salesDocumentId)===command.aggregateId&&orderQM9Text(detail.salesLineId)===orderQM9Text(source.salesLineId);
      }).map(row=>({row,remaining:Number(row.detail&&row.detail.transferredQty||0)-priorReversals.filter(reversal=>orderQM9Text(reversal.detail&&reversal.detail.allocationEventId)===orderQM9Text(row.eventId)).reduce((sum,reversal)=>sum+Number(reversal.detail&&reversal.detail.transferredQty||0),0)+restorationEvents.filter(restore=>priorReversals.some(reversal=>orderQM9Text(reversal.eventId)===orderQM9Text(restore.detail&&restore.detail.restoresReversalEventId)&&orderQM9Text(reversal.detail&&reversal.detail.allocationEventId)===orderQM9Text(row.eventId))).reduce((sum,restore)=>sum+Number(restore.detail&&restore.detail.transferredQty||0),0)}))
        .filter(row=>row.remaining>1e-9).sort((a,b)=>orderQM9Text(b.row.createdAt).localeCompare(orderQM9Text(a.row.createdAt))||orderQM9Text(b.row.eventId).localeCompare(orderQM9Text(a.row.eventId)));
      candidates.forEach(candidate=>{if(remaining<=1e-9)return;const detail=candidate.row.detail||{};const ref=rich.find(row=>orderQM9Text(row.allocationEventId)===orderQM9Text(candidate.row.eventId));if(orderQM9Text(candidate.row.orderId)!==orderQM9Text(source.sourceOrderId)||orderQM9Text(detail.orderItemId)!==orderQM9Text(source.sourceOrderItemId)||(orderQM9Text(detail.productId)&&orderQM9Text(detail.productId)!==orderQM9Text(source.productId))||(orderQM9Text(detail.warehouseId)&&orderQM9Text(detail.warehouseId)!==orderQM9Text(source.warehouseId))||(ref&&(orderQM9Text(ref.sourceSalesDocumentId)!==orderQM9Text(detail.salesDocumentId)||orderQM9Text(ref.sourceSalesLineId)!==orderQM9Text(detail.salesLineId)||orderQM9Text(ref.sourceLineIdentityId)!==orderQM9Text(detail.lineIdentityId))))throw new Error(`ORDERQ_CENTRAL_ORDER_ALLOCATION_LINK_INVALID:${command.aggregateId}`);const requested=ref?Number(ref.reversalQuantity||ref.residualQuantity||0):remaining;const amount=Math.min(remaining,candidate.remaining,requested>0?requested:remaining);effects.push(descriptor(source,-amount,ordinalStart+effects.length,candidate.row.eventId,explicitOnly?'NEGATIVE_SALE':'CORRECTION',''));remaining-=amount;});
      if(remaining>1e-9)throw new Error(`ORDERQ_CENTRAL_ORDER_ALLOCATION_BALANCE_INSUFFICIENT:${command.aggregateId}`);
      return effects;
    };
    const restorationResiduals=source=>{const refs=Array.isArray(source.restorationSourceReversals)?source.restorationSourceReversals:[];return priorReversals.filter(row=>orderQM9Text(row.detail&&row.detail.reversalKind)==='NEGATIVE_SALE'&&orderQM9Text(row.detail&&row.detail.salesDocumentId)===command.aggregateId&&orderQM9Text(row.detail&&row.detail.salesLineId)===orderQM9Text(source.salesLineId)).filter(row=>!refs.length||refs.some(ref=>orderQM9Text(ref.reversalEventId)===orderQM9Text(row.eventId))).map(row=>({row,remaining:Number(row.detail&&row.detail.transferredQty||0)-restorationEvents.filter(restore=>orderQM9Text(restore.detail&&restore.detail.restoresReversalEventId)===orderQM9Text(row.eventId)).reduce((sum,restore)=>sum+Number(restore.detail&&restore.detail.transferredQty||0),0)})).filter(row=>row.remaining>1e-9).sort((a,b)=>orderQM9Text(a.row.eventId).localeCompare(orderQM9Text(b.row.eventId)));};
    const restoreQuantity=(source,qty,ordinalStart)=>{let remaining=Math.abs(Number(qty||0));const effects=[];restorationResiduals(source).forEach(candidate=>{if(remaining<=1e-9)return;const amount=Math.min(remaining,candidate.remaining);effects.push(descriptor(source,amount,ordinalStart+effects.length,'','REVERSAL_RESTORE',candidate.row.eventId));remaining-=amount;});if(remaining>1e-9)throw new Error(`ORDERQ_CENTRAL_ORDER_RESTORATION_BALANCE_INSUFFICIENT:${command.aggregateId}`);return effects;};
    const applyQuantity=(source,qty,ordinal)=>Number(qty||0)<0?reverseQuantity(source,qty,ordinal,true):(Number(qty||0)?[descriptor(source,qty,ordinal,'','ORDINARY','')]:[]);
    const undoQuantity=(source,qty,ordinal)=>Number(qty||0)<0?restoreQuantity(source,qty,ordinal):reverseQuantity(source,qty,ordinal,false);
    const identities=new Set([].concat(Array.from(beforeByIdentity.keys()),Array.from(afterByIdentity.keys())));
    identities.forEach(identity=>{
      const beforeLine=beforeByIdentity.get(identity);const afterLine=afterByIdentity.get(identity);
      if(String(command.commandType||'').indexOf('POST_')===0){expectedOrderEffects.push(...applyQuantity(afterLine,Number(afterLine.recognizedOrderQuantity||0),1));return;}
      if(reverse){expectedOrderEffects.push(...undoQuantity(beforeLine,Number(beforeLine.recognizedOrderQuantity||0),1));return;}
      const sameLink=beforeLine&&afterLine&&orderQM9Text(beforeLine.orderLinkMode).toUpperCase()===orderQM9Text(afterLine.orderLinkMode).toUpperCase()&&orderQM9Text(beforeLine.sourceOrderId)===orderQM9Text(afterLine.sourceOrderId)&&orderQM9Text(beforeLine.sourceOrderItemId)===orderQM9Text(afterLine.sourceOrderItemId);
      if(!sameLink){const oldEffects=beforeLine&&orderQM9Text(beforeLine.orderLinkMode).toUpperCase()==='ORDER_Q'?undoQuantity(beforeLine,Number(beforeLine.recognizedOrderQuantity||0),1):[];expectedOrderEffects.push(...oldEffects);if(afterLine&&orderQM9Text(afterLine.orderLinkMode).toUpperCase()==='ORDER_Q')expectedOrderEffects.push(...applyQuantity(afterLine,Number(afterLine.recognizedOrderQuantity||0),oldEffects.length+1));return;}
      const before=Number(beforeLine&&beforeLine.recognizedOrderQuantity||0),after=Number(afterLine&&afterLine.recognizedOrderQuantity||0);
      if(before<0&&after<=0){expectedOrderEffects.push(...(Math.abs(after)<Math.abs(before)?restoreQuantity(beforeLine,Math.abs(before)-Math.abs(after),1):reverseQuantity(afterLine||beforeLine,Math.abs(after)-Math.abs(before),1,true)));return;}
      if(before<0&&after>0){const restored=restoreQuantity(beforeLine,before,1);expectedOrderEffects.push(...restored,...applyQuantity(afterLine,after,restored.length+1));return;}
      if(before>=0&&after<0){const undone=undoQuantity(beforeLine,before,1);expectedOrderEffects.push(...undone,...applyQuantity(afterLine,after,undone.length+1));return;}
      const delta=after-before;expectedOrderEffects.push(...(delta<0?reverseQuantity(beforeLine,delta,1,false):delta?[descriptor(afterLine||beforeLine,delta,1,'','ORDINARY','')]:[]));
    });
  }
  exactSet(orderEvents.map(row=>({eventType:orderQM9Text(row.payload.eventType),orderId:orderQM9Text(row.payload.orderId),orderItemId:orderQM9Text(row.payload.detail&&row.payload.detail.orderItemId),salesLineId:orderQM9Text(row.payload.detail&&row.payload.detail.salesLineId),transferredQty:orderQM9StrictOfficialNumber(row.payload.detail&&row.payload.detail.transferredQty,'ORDERQ_CENTRAL_ORDER_EVENT_QUANTITY_REQUIRED'),allocationEventId:orderQM9Text(row.payload.detail&&row.payload.detail.allocationEventId),allocationKind:orderQM9Text(row.payload.detail&&row.payload.detail.allocationKind),reversalKind:orderQM9Text(row.payload.detail&&row.payload.detail.reversalKind),restoresReversalEventId:orderQM9Text(row.payload.detail&&row.payload.detail.restoresReversalEventId),effectOrdinal:Number(row.payload.effectOrdinal||0)})),expectedOrderEffects,'ORDERQ_CENTRAL_ORDER_EVENT_EFFECT_MISMATCH');
}

function orderQM9ValidateCommit(ss, command, mutations) {
  const existingRows = orderQM9ReadAllEntities(ss);
  const rows = type => mutations.filter(row => row.entityType === type);
  const decision = rows('DISPATCH_DECISION').find(row => row.entityId === command.aggregateId);
  const purchase = rows('PURCHASE_DOCUMENT').find(row => row.entityId === command.aggregateId);
  const officialVoucherCommand = orderQM9Text(command.intent && command.intent.commandContract).toUpperCase() === 'VOUCHER_CORE_V1';
  if (officialVoucherCommand && ['POST_PURCHASE', 'CORRECT_PURCHASE', 'REVERSE_PURCHASE', 'POST_SALE', 'CORRECT_SALE', 'REVERSE_SALE'].indexOf(command.commandType) >= 0) {
    orderQM9ValidateOfficialVoucher(command, mutations, existingRows);
    return;
  }
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
  orderQM9EnforceTransactionBoundary(ss);
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
  const mutationFingerprint = orderQM9Digest(mutations.map(row => ({
    entityType: row.entityType, entityId: row.entityId, revision: row.revision, payload: row.payload
  })).sort((a, b) => orderQM9EntityKey(a.entityType, a.entityId).localeCompare(orderQM9EntityKey(b.entityType, b.entityId))));
  if (command.status === 'COMMITTED') {
    if (command.mutationFingerprint !== mutationFingerprint) {
      throw new Error(`ORDERQ_CENTRAL_MUTATION_IDEMPOTENCY_CONFLICT:${idempotencyKey}`);
    }
    return Object.assign({ duplicate: true }, orderQM9OfficialResultForCommand(ss, command));
  }
  orderQM10AssertOfficialWriteEnabled(command.commandType);
  if (command.status !== 'PREPARED') throw new Error(`ORDERQ_CENTRAL_COMMAND_TERMINAL:${idempotencyKey}:${command.status}`);
  if (orderQM9LeaseExpired(command, commitAtMillis)) {
    command.status = 'EXPIRED';
    command.expiredAt = new Date(commitAtMillis).toISOString();
    orderQM9WriteCommand(ss, command);
    orderQM9ReleaseSourceClaims(ss, command, 'LEASE_EXPIRED', commitAtMillis);
    throw new Error(`ORDERQ_CENTRAL_LEASE_EXPIRED:${idempotencyKey}`);
  }
  if (command.inventoryResourceFingerprint !== orderQM9InventoryResourceFingerprint(ss)) {
    throw new Error(`ORDERQ_CENTRAL_INVENTORY_REVISION_CONFLICT:${command.aggregateId}`);
  }
  const previousCommand = JSON.parse(JSON.stringify(command));
  const previousSourceClaims = orderQM9SaleSourceClaimKeys(command).map(claimKey => ({
    claimKey, value: orderQM9ReadSourceClaim(ss, claimKey)
  }));
  orderQM9SaleSourceClaimKeys(command).forEach(claimKey => {
    const claim = orderQM9ReadSourceClaim(ss, claimKey);
    const occurrence = claimKey.indexOf('SALE:SOURCE:') === 0 || claimKey.indexOf('SALE:TX:') === 0 || claimKey.indexOf('SALE:DISPATCH:') === 0;
    const lineageCommitted = claim && claim.status === 'COMMITTED' && occurrence
      && claim.ownerContract === orderQM9SaleClaimOwner(command).ownerContract && claim.aggregateId === command.aggregateId;
    if (!lineageCommitted && (!claim || claim.status !== 'PREPARED' || claim.ownerCommandId !== command.idempotencyKey
      || claim.leaseToken !== command.leaseToken || claim.fingerprint !== command.fingerprint)) {
      throw new Error(`ORDERQ_CENTRAL_SOURCE_CLAIM_CONFLICT:${claimKey}`);
    }
  });
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
    row.payload.centralRevision = row.revision;
    row.payload.localOnly = false;
    if (['PURCHASE_DOCUMENT', 'SALES_DOCUMENT'].indexOf(row.entityType) >= 0 && row.payload.documentContract === 'VOUCHER_CORE_V1') {
      row.payload.projectionStatus = 'CENTRAL_COMMITTED';
    }
  });
  const voucherCore = orderQM9Text(command.intent && command.intent.commandContract).toUpperCase() === 'VOUCHER_CORE_V1';
  const ledgerRank = voucherCore
    ? { VOUCHER_EVENT: 1, INVENTORY_MOVEMENT: 2, ORDER_EVENT: 3, PAYABLE_ENTRY: 4, RECEIVABLE_ENTRY: 4 }
    : { INVENTORY_MOVEMENT: 2 };
  const effectRank = { REVERSE_OLD: 1, DELTA: 2, APPLY_NEW: 3 };
  const eventRank = { SALES_TRANSFER_REVERSED: 1, SALES_TRANSFER_ALLOCATED: 2 };
  const compareLedger = (left, right) => {
    const typeRank = ledgerRank[left.entityType] - ledgerRank[right.entityType];
    if (typeRank) return typeRank;
    if (left.entityType === 'INVENTORY_MOVEMENT') return orderQM9Text(left.payload.lineIdentityId).localeCompare(orderQM9Text(right.payload.lineIdentityId))
      || (effectRank[orderQM9Text(left.payload.effectKind).toUpperCase()] || 9) - (effectRank[orderQM9Text(right.payload.effectKind).toUpperCase()] || 9)
      || Number(left.payload.effectOrdinal || 0) - Number(right.payload.effectOrdinal || 0) || left.entityId.localeCompare(right.entityId);
    if (left.entityType === 'ORDER_EVENT') return orderQM9Text(left.payload.orderId).localeCompare(orderQM9Text(right.payload.orderId))
      || orderQM9Text(left.payload.detail && left.payload.detail.orderItemId).localeCompare(orderQM9Text(right.payload.detail && right.payload.detail.orderItemId))
      || orderQM9Text(left.payload.detail && left.payload.detail.salesLineId).localeCompare(orderQM9Text(right.payload.detail && right.payload.detail.salesLineId))
      || (eventRank[orderQM9Text(left.payload.eventType).toUpperCase()] || 9) - (eventRank[orderQM9Text(right.payload.eventType).toUpperCase()] || 9)
      || Number(left.payload.effectOrdinal || 0) - Number(right.payload.effectOrdinal || 0) || left.entityId.localeCompare(right.entityId);
    if (left.entityType === 'PAYABLE_ENTRY' || left.entityType === 'RECEIVABLE_ENTRY') return orderQM9Text(left.payload.partnerId).localeCompare(orderQM9Text(right.payload.partnerId))
      || orderQM9Text(left.payload.entryType).localeCompare(orderQM9Text(right.payload.entryType))
      || orderQM9Text(left.payload.reversalOf).localeCompare(orderQM9Text(right.payload.reversalOf))
      || Number(left.payload.effectOrdinal || 0) - Number(right.payload.effectOrdinal || 0) || left.entityId.localeCompare(right.entityId);
    return left.entityId.localeCompare(right.entityId);
  };
  mutations.filter(row => ledgerRank[row.entityType]).sort(compareLedger).forEach(row => {
    delete row.payload.ledgerSequence;
    ledgerSequence += 1;
    row.payload.ledgerSequence = ledgerSequence;
    if (row.entityType === 'INVENTORY_MOVEMENT') row.revision = Math.max(row.revision, ledgerSequence);
  });
  const txnId = `OQM9TX-${Utilities.getUuid()}`;
  const txnSheet = orderQEnsureSheet(ss, 'M9_TXN_LOG');
  const previousBundle = { entities: previous, command: previousCommand, sourceClaims: previousSourceClaims };
  const previousChunks = orderQM9BuildOfficialChunks(txnId, idempotencyKey, 'PREVIOUS', previousBundle);
  const mutationChunks = orderQM9BuildOfficialChunks(txnId, idempotencyKey, 'MUTATIONS', mutations);
  orderQM9AppendRows(txnSheet, previousChunks.rows.concat(mutationChunks.rows));
  const previousRowsForKeys = previous.map(entry => ({
    entityType: entry.entityType,
    entityId: entry.entityId,
    revision: entry.value && entry.value.revision || 0,
    payload: entry.value && entry.value.payload || {}
  }));
  const expectedChanges = mutations.map((row, index) => ({
    sequence: previousSync + index + 1,
    deviceId: command.deviceId,
    commandId: idempotencyKey,
    entityType: row.entityType,
    entityId: row.entityId,
    revision: row.revision,
    payload: row.payload
  }));
  const serverRevision = Math.max(command.expectedRevision, ...mutations.filter(row => row.entityId === command.aggregateId).map(row => row.revision));
  const transaction = {
    txnId,
    idempotencyKey,
    status: 'PREPARED',
    previous: {
      schemaVersion: ORDERQ_M9_OFFICIAL_TXN_SCHEMA,
      previousEntityCount: previous.length,
      previousEntityKeyDigest: orderQM9OfficialMutationKeyDigest(previousRowsForKeys),
      previousEntityDigest: orderQM9OfficialPayloadDigest(previous),
      previousCommandDigest: orderQM9OfficialPayloadDigest(previousCommand),
      previousSourceClaimDigest: orderQM9OfficialPayloadDigest(previousSourceClaims),
      previousLedgerSequence: previousLedger,
      previousSyncSequence: previousSync,
      previousChangeLastRow,
      previousChunks: previousChunks.descriptor
    },
    next: {
      schemaVersion: ORDERQ_M9_OFFICIAL_TXN_SCHEMA,
      transactionId: txnId,
      mutationFingerprint,
      mutationCount: mutations.length,
      mutationKeyDigest: orderQM9OfficialMutationKeyDigest(mutations),
      mutationDigest: orderQM9OfficialMutationDigest(mutations),
      changeCount: expectedChanges.length,
      changeDigest: orderQM9ChangeDigest(expectedChanges),
      startCursor: previousSync,
      endCursor: previousSync + expectedChanges.length,
      startLedgerSequence: previousLedger,
      endLedgerSequence: ledgerSequence,
      serverRevision,
      mutationChunks: mutationChunks.descriptor
    },
    error: ''
  };
  orderQM9WriteOfficialTransaction(ss, transaction);
  try {
    mutations.forEach(row => orderQM9WriteEntity(ss, row));
    orderQM9SetMetaNumber(ss, 'ledgerSequence', ledgerSequence);
    if (orderQM9Text(payload.testFailureAt).toUpperCase() === 'ENTITIES_WRITTEN') throw new Error('ORDERQ_CENTRAL_FAILURE_INJECTED:ENTITIES_WRITTEN');
    let cursor = orderQM9MetaNumber(ss, 'syncSequence');
    mutations.forEach(row => { cursor = orderQM9AppendChange(ss, command.deviceId, idempotencyKey, row); });
    const result = { transactionId: txnId, changes: mutations, cursor, ledgerSequence, serverRevision };
    result.resultDigest = orderQM9Digest({ changes: mutations, cursor, ledgerSequence, serverRevision });
    command.status = 'COMMITTED';
    command.mutationFingerprint = mutationFingerprint;
    command.committedAt = new Date().toISOString();
    command.result = {
      transactionId: txnId,
      cursor,
      ledgerSequence,
      serverRevision,
      changeCount: transaction.next.changeCount,
      changeDigest: transaction.next.changeDigest,
      mutationKeyDigest: transaction.next.mutationKeyDigest,
      resultDigest: result.resultDigest
    };
    orderQM9WriteCommand(ss, command);
    if (orderQM9Text(payload.testFailureAt).toUpperCase() === 'COMMAND_WRITTEN') throw new Error('ORDERQ_CENTRAL_FAILURE_INJECTED:COMMAND_WRITTEN');
    orderQM9VerifyAndCommitSourceClaims(ss, command, commitAtMillis);
    if (!orderQM9VerifyOfficialCommitState(ss, transaction).complete) {
      throw new Error(`ORDERQ_CENTRAL_OFFICIAL_COMPLETENESS_FAILED:${idempotencyKey}`);
    }
    orderQM9WriteOfficialTransaction(ss, { ...transaction, status: 'COMMITTED', error: '' });
    orderQM9DeleteOfficialChunks(ss, transaction);
    return Object.assign({ duplicate: false }, result);
  } catch (error) {
    if (orderQM9Text(payload.testRollbackFailureAt).toUpperCase() === 'BEFORE_ROLLBACK') throw error;
    try {
      orderQM9RollbackOfficialTransaction(ss, transaction, {
        failureAt: payload.testRollbackFailureAt,
        error: String(error.message || error)
      });
    } catch (rollbackError) {
      try {
        orderQM9WriteOfficialTransaction(ss, {
          ...transaction,
          status: 'RECOVERY_REQUIRED',
          error: `${String(error.message || error)} | ${String(rollbackError.message || rollbackError)}`
        });
      } catch (ignored) {}
    }
    throw error;
  }
}

function orderQM9Abort(ss, payload) {
  orderQM9RequireSchema(payload);
  orderQEnsureAllSheets(ss);
  orderQM9EnforceTransactionBoundary(ss);
  const command = orderQM9ReadCommand(ss, payload.idempotencyKey);
  if (!command || command.status === 'COMMITTED') return { aborted: false };
  if (command.leaseToken !== orderQM9Text(payload.leaseToken)) throw new Error('ORDERQ_CENTRAL_LEASE_INVALID');
  if (command.status !== 'PREPARED') return { aborted: false, status: command.status };
  const abortedAtMillis = Date.now();
  if (orderQM9LeaseExpired(command, abortedAtMillis)) {
    command.status = 'EXPIRED';
    command.expiredAt = new Date(abortedAtMillis).toISOString();
    orderQM9WriteCommand(ss, command);
    orderQM9ReleaseSourceClaims(ss, command, 'LEASE_EXPIRED', abortedAtMillis);
    return { aborted: false, status: 'EXPIRED' };
  }
  command.status = 'ABORTED';
  command.abortReason = orderQM9Text(payload.reason);
  command.abortedAt = new Date(abortedAtMillis).toISOString();
  orderQM9WriteCommand(ss, command);
  orderQM9ReleaseSourceClaims(ss, command, 'ABORTED', abortedAtMillis);
  return { aborted: true };
}

function orderQM9Pull(ss, payload) {
  orderQM9RequireSchema(payload);
  orderQEnsureAllSheets(ss);
  orderQM9EnforceTransactionBoundary(ss);
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
  const properties = PropertiesService.getScriptProperties();
  return {
    schemaVersion: ORDERQ_M9_SCHEMA,
    serverTime: new Date().toISOString(),
    cutoverMode: orderQM10CutoverMode(),
    cursor: orderQM9MetaNumber(ss, 'syncSequence'),
    ledgerSequence: orderQM9MetaNumber(ss, 'ledgerSequence'),
    officialPurchaseStage3: 'V1',
    normalizedOriginVersion: 'PURCHASE_V2',
    commandContract: 'VOUCHER_CORE_V1',
    metaSchema: 'ORDERQ_PURCHASE_META_V2',
    officialSaleStage4: 'V1',
    normalizedSaleOriginVersion: 'SALE_V2',
    salesMetaSchema: 'ORDERQ_SALES_META_V1',
    dbSchemaVersion: '14',
    deploymentId: String(properties.getProperty(ORDERQ_STAGE3_DEPLOYMENT_ID_PROPERTY) || ''),
    deploymentVersion: String(properties.getProperty(ORDERQ_STAGE3_DEPLOYMENT_VERSION_PROPERTY) || ''),
    gitCommit: String(properties.getProperty(ORDERQ_STAGE3_GIT_COMMIT_PROPERTY) || ''),
    saleDeploymentId: String(properties.getProperty(ORDERQ_STAGE4_DEPLOYMENT_ID_PROPERTY) || ''),
    saleDeploymentVersion: String(properties.getProperty(ORDERQ_STAGE4_DEPLOYMENT_VERSION_PROPERTY) || ''),
    saleGitCommit: String(properties.getProperty(ORDERQ_STAGE4_GIT_COMMIT_PROPERTY) || ''),
    situationSchemaVersion: 'ORDERQ_SITUATION_READ_V1',
    situationCapabilityVersion: 'ORDERQ_SITUATION_V1',
    situationDbSchemaVersion: '15',
    situationActions: ['situation_orderq_begin','situation_orderq_page','situation_orderq_head'],
    situationDeploymentId: String(properties.getProperty(ORDERQ_STAGE5_DEPLOYMENT_ID_PROPERTY) || ''),
    situationDeploymentVersion: String(properties.getProperty(ORDERQ_STAGE5_DEPLOYMENT_VERSION_PROPERTY) || ''),
    situationGitCommit: String(properties.getProperty(ORDERQ_STAGE5_GIT_COMMIT_PROPERTY) || '')
  };
}

function orderQM9SituationCacheKey(kind, readSessionId, pageIndex) {
  return ['ORDERQ_SITUATION_V1', kind, orderQM9Text(readSessionId), pageIndex === undefined ? '' : Number(pageIndex)].join(':');
}

function orderQM9SituationReadCached(kind, readSessionId, pageIndex) {
  const value = CacheService.getScriptCache().get(orderQM9SituationCacheKey(kind, readSessionId, pageIndex));
  if (!value) throw new Error('SITUATION_READ_TOKEN_EXPIRED');
  return orderQM9ParseJson(value, 'SITUATION_READ_TOKEN_INVALID');
}

function orderQM9SituationHeadState(ss) {
  const rows = orderQM9ReadAllEntities(ss);
  return { revision: orderQM9MetaNumber(ss, 'ledgerSequence'), digest: orderQM9EntityDigest(rows), rows: rows };
}

function orderQM9SituationBegin(ss, payload) {
  orderQM9RequireSchema(payload);
  const actorId = orderQM9Text(payload.actorId), device = orderQM9Text(payload.device), environment = orderQM9Text(payload.environment), companyId = orderQM9Text(payload.scope && payload.scope.companyId);
  if (!actorId || !device || !environment || companyId !== 'ONEAPP') throw new Error('ORDERQ_SITUATION_ACCESS_DENIED');
  const dataOpsTokenDigest = orderQM9Text(payload.dataOpsTokenDigest);
  const inventoryKeyDigest = orderQM9Text(payload.inventoryKeyDigest);
  const perKeyCutoffDigest = orderQM9Text(payload.perKeyCutoffDigest);
  if (!dataOpsTokenDigest || !inventoryKeyDigest || !perKeyCutoffDigest) throw new Error('SITUATION_DATAOPS_HANDSHAKE_REQUIRED');
  const properties = PropertiesService.getScriptProperties();
  const head = orderQM9SituationHeadState(ss);
  const readSessionId = `OQS-${Utilities.getUuid()}`;
  const allowed = { ORDER:true, ORDER_ITEM:true, ORDER_EVENT:true, INVENTORY_MOVEMENT:true, PURCHASE_DOCUMENT:true, PRODUCT:true, WAREHOUSE:true };
  const rows = head.rows.filter(row => allowed[orderQM9Text(row.entityType).toUpperCase()]).sort((a,b) => orderQM9Text(a.entityType).localeCompare(orderQM9Text(b.entityType)) || orderQM9Text(a.entityId).localeCompare(orderQM9Text(b.entityId)));
  const movements = rows.filter(row => orderQM9Text(row.entityType).toUpperCase() === 'INVENTORY_MOVEMENT').map(row => row.payload || {}).filter(row => Number(row.ledgerSequence || 0) <= head.revision);
  const movementIds = movements.map(row => orderQM9Text(row.movementId)).sort();
  const effectKeys = movements.map(row => orderQM9Text(row.effectKey)).filter(Boolean).sort();
  const chunks = [];
  for (let index=0; index<rows.length; index+=25) chunks.push(rows.slice(index,index+25));
  if (!chunks.length) chunks.push([]);
  const pages = chunks.map((chunk,pageIndex) => ({ pageIndex:pageIndex, rowCount:chunk.length, pageDigest:orderQM9Digest(chunk) }));
  const movementManifest = { manifestVersion:'SITUATION_MOVEMENT_MANIFEST_V1', ledgerUpperBound:head.revision, movementCount:movementIds.length, movementIds:movementIds, effectKeys:effectKeys, tombstoneIds:[], pageCount:pages.length, pages:pages, manifestDigest:orderQM9Digest({movementIds:movementIds,effectKeys:effectKeys,ledgerUpperBound:head.revision}) };
  const issuedAt = new Date();
  const token = { readSessionId:readSessionId, authority:'ORDERQ', tokenVersion:'ORDERQ_SITUATION_TOKEN_V1', deploymentId:String(properties.getProperty(ORDERQ_STAGE5_DEPLOYMENT_ID_PROPERTY)||''), deploymentVersion:String(properties.getProperty(ORDERQ_STAGE5_DEPLOYMENT_VERSION_PROPERTY)||''), gitCommit:String(properties.getProperty(ORDERQ_STAGE5_GIT_COMMIT_PROPERTY)||''), capabilityVersion:'ORDERQ_SITUATION_V1', actorId:actorId, device:device, environment:environment, roleIds:['ORDERQ_SITUATION_READ'], scopeDigest:orderQM9Digest({companyId:companyId}), issuedAt:issuedAt.toISOString(), expiresAt:new Date(issuedAt.getTime()+ORDERQ_SITUATION_SESSION_TTL_SECONDS*1000).toISOString(), headRevision:head.revision, headDigest:head.digest, pageManifest:{pages:pages}, entityManifest:{movementManifest:movementManifest,ledgerUpperBound:head.revision}, movementManifestDigest:movementManifest.manifestDigest, ledgerUpperBound:head.revision, status:'OPEN' };
  token.tokenDigest = orderQM9Digest(token);
  token.crossAuthorityHandshakeDigest = orderQM9Digest([dataOpsTokenDigest,inventoryKeyDigest,perKeyCutoffDigest,token.tokenDigest,movementManifest.manifestDigest,head.revision]);
  const cache = CacheService.getScriptCache();
  cache.put(orderQM9SituationCacheKey('SESSION',readSessionId),JSON.stringify(token),ORDERQ_SITUATION_SESSION_TTL_SECONDS);
  chunks.forEach((chunk,index) => cache.put(orderQM9SituationCacheKey('PAGE',readSessionId,index),JSON.stringify({pageIndex:index,rowCount:chunk.length,pageDigest:pages[index].pageDigest,entities:chunk,movements:chunk.filter(row=>orderQM9Text(row.entityType).toUpperCase()==='INVENTORY_MOVEMENT').map(row=>row.payload||{})}),ORDERQ_SITUATION_SESSION_TTL_SECONDS));
  console.info(JSON.stringify({event:'ORDERQ_SITUATION_BEGIN',actorId:actorId,device:device,environment:environment,readSessionDigest:orderQM9Digest(readSessionId),tokenDigest:token.tokenDigest,rowCount:rows.length,pageCount:pages.length,issuedAt:token.issuedAt,expiresAt:token.expiresAt}));
  return token;
}

function orderQM9SituationRequireIdentity(session,payload) {
  if (orderQM9Text(payload.actorId)!==session.actorId || orderQM9Text(payload.device)!==session.device || orderQM9Text(payload.environment)!==session.environment || orderQM9Digest({companyId:orderQM9Text(payload.scope&&payload.scope.companyId)})!==session.scopeDigest) throw new Error('ORDERQ_SITUATION_ACCESS_DENIED');
}

function orderQM9SituationPage(ss, payload) {
  orderQM9RequireSchema(payload);
  const session = orderQM9SituationReadCached('SESSION',payload.readSessionId);
  orderQM9SituationRequireIdentity(session,payload);
  if (orderQM9Text(payload.tokenDigest) !== session.tokenDigest || new Date(session.expiresAt).getTime() <= Date.now()) throw new Error('SITUATION_READ_TOKEN_EXPIRED');
  return orderQM9SituationReadCached('PAGE',payload.readSessionId,payload.pageIndex);
}

function orderQM9SituationHead(ss, payload) {
  orderQM9RequireSchema(payload);
  const session = orderQM9SituationReadCached('SESSION',payload.readSessionId);
  orderQM9SituationRequireIdentity(session,payload);
  if (orderQM9Text(payload.tokenDigest) !== session.tokenDigest || new Date(session.expiresAt).getTime() <= Date.now()) throw new Error('SITUATION_READ_TOKEN_EXPIRED');
  const head = orderQM9SituationHeadState(ss);
  return { frozenTokenDigest:session.tokenDigest, currentHeadRevision:head.revision, currentHeadDigest:head.digest };
}
