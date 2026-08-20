import {
  CAPABILITY,
  DISPATCH_STAGE_POLICY,
  MVP_ACTOR_ID,
  V7_EXISTING_STORE_INDEXES,
  V7_STORE,
  V7_STORE_DEFINITIONS
} from './orderq-v7-contracts.js?v=0.8.0';
import { V8_STORE, V8_STORE_DEFINITIONS } from './orderq-v8-contracts.js?v=0.11.0';
import {
  ORDERQ_DB_VERSION,
  V9_STORE,
  V9_STORE_DEFINITIONS
} from './orderq-v9-contracts.js?v=0.12.0';
import { adminTestDatabaseName } from './admin-test-runtime.js?v=0.10.2';

function databaseNameForRuntime() {
  const location = globalThis.location;
  const adminTestName = adminTestDatabaseName(location);
  if (adminTestName) return adminTestName;
  const localTestName = location && ['127.0.0.1', 'localhost'].includes(String(location.hostname || '').toLowerCase())
    ? new URLSearchParams(location.search || '').get('orderqTestDb')
    : '';
  return localTestName && /^[a-z0-9._-]{1,100}$/i.test(localTestName) ? localTestName : 'oneapp-orderq-vnext';
}

export const DB_NAME = databaseNameForRuntime();
export const DB_VERSION = ORDERQ_DB_VERSION;

export const STORE = Object.freeze({
  CUSTOMERS: 'customers',
  PRODUCTS: 'products',
  WAREHOUSES: 'warehouses',
  WAREHOUSE_ALIASES: 'warehouseAliases',
  CUSTOMER_ALIASES: 'customerAliases',
  CUSTOMER_EVENTS: V9_STORE.CUSTOMER_EVENTS,
  PRODUCT_MAPPINGS: 'productMappings',
  UNIT_MAPPINGS: 'unitMappings',
  RAW_INPUTS: 'rawInputs',
  PARSE_RESULTS: 'parseResults',
  MAPPING_EVENTS: 'mappingEvents',
  ORDERS: 'orders',
  ORDER_ITEMS: 'orderItems',
  ORDER_EVENTS: 'orderEvents',
  IMPORT_BATCHES: 'importBatches',
  SOURCE_RECORDS: 'sourceRecords',
  SALES_DOCUMENTS: 'salesDocuments',
  SALES_LINES: 'salesLines',
  PURCHASE_DOCUMENTS: 'purchaseDocuments',
  PURCHASE_LINES: 'purchaseLines',
  LEDGER_DOCUMENTS: 'ledgerDocuments',
  LEDGER_LINES: 'ledgerLines',
  INVENTORY_SNAPSHOTS: 'inventorySnapshots',
  INVENTORY_LINES: 'inventoryLines',
  HISTORICAL_ORDER_GROUPS: 'historicalOrderGroups',
  HISTORICAL_ORDER_LINES: 'historicalOrderLines',
  FULFILLMENT_LINKS: 'fulfillmentLinks',
  FULFILLMENT_BALANCES: 'fulfillmentBalances',
  PARSER_EVIDENCE: 'parserEvidence',
  COLLECTOR_SETTINGS: 'collectorSettings',
  SYNC_QUEUE: 'syncQueue',
  META: 'meta',
  ...V7_STORE,
  ...V8_STORE
});

let dbPromise = null;

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

export function upgradeOrderQDbSchema(db, transaction, oldVersion = 0) {
  const ensureStore = (name, options) => {
    if (!db.objectStoreNames.contains(name)) return db.createObjectStore(name, options);
    return transaction.objectStore(name);
  };

      let store = ensureStore(STORE.CUSTOMERS, { keyPath: 'customerId' });
      ensureIndex(store, 'byName', 'normalizedName');
      ensureIndex(store, 'byErpCode', 'erpCustomerCode');
      ensureIndex(store, 'byUpdatedAt', 'updatedAt');
      ensureIndex(store, 'byCanonicalCustomerId', 'canonicalCustomerId');
      ensureIndex(store, 'byCustomerCode', 'normalizedCustomerCode');
      ensureIndex(store, 'byStatusQuality', ['status', 'qualityStatus']);

  store = ensureStore(STORE.PRODUCTS, { keyPath: 'productId' });
  ensureIndex(store, 'byCode', 'itemCode', { unique: false });
  ensureIndex(store, 'byName', 'normalizedName');

  store = ensureStore(STORE.WAREHOUSES, { keyPath: 'warehouseId' });
  ensureIndex(store, 'byCode', 'warehouseCode');
  ensureIndex(store, 'byNormalizedName', 'normalizedName');
  ensureIndex(store, 'byStatus', 'status');
  ensureIndex(store, 'byUpdatedAt', 'updatedAt');

  store = ensureStore(STORE.WAREHOUSE_ALIASES, { keyPath: 'mappingId' });
  ensureIndex(store, 'byNormalizedText', 'normalizedText');
  ensureIndex(store, 'byWarehouseText', ['warehouseId', 'normalizedText']);
  ensureIndex(store, 'byWarehouseId', 'warehouseId');

  store = ensureStore(STORE.CUSTOMER_ALIASES, { keyPath: 'mappingId' });
  ensureIndex(store, 'byNormalizedText', 'normalizedText');
  ensureIndex(store, 'byCustomerText', ['customerId', 'normalizedText']);
  ensureIndex(store, 'bySourceText', ['sourceId', 'normalizedText']);
  ensureIndex(store, 'byCustomerId', 'customerId');

  store = ensureStore(STORE.PRODUCT_MAPPINGS, { keyPath: 'mappingId' });
  ensureIndex(store, 'byCustomerText', ['customerId', 'normalizedText']);
  ensureIndex(store, 'bySourceText', ['sourceId', 'normalizedText']);
  ensureIndex(store, 'byNormalizedText', 'normalizedText');
  ensureIndex(store, 'byProductId', 'productId');

  store = ensureStore(STORE.UNIT_MAPPINGS, { keyPath: 'mappingId' });
  ensureIndex(store, 'byProductRawUnit', ['productId', 'rawUnit']);
  ensureIndex(store, 'byGroupRawUnit', ['productGroup', 'rawUnit']);

  store = ensureStore(STORE.RAW_INPUTS, { keyPath: 'rawInputId' });
  ensureIndex(store, 'bySource', ['sourceType', 'sourceId']);
  ensureIndex(store, 'byFingerprint', 'fingerprint', { unique: true });
  ensureIndex(store, 'byCreatedAt', 'createdAt');

  store = ensureStore(STORE.PARSE_RESULTS, { keyPath: 'parseResultId' });
  ensureIndex(store, 'byRawInputId', 'rawInputId');
  ensureIndex(store, 'bySourceMessageKey', 'sourceMessageKey', { unique: true });
  ensureIndex(store, 'byOrderId', 'orderId');
  ensureIndex(store, 'byCreatedAt', 'createdAt');

  store = ensureStore(STORE.MAPPING_EVENTS, { keyPath: 'eventId' });
  ensureIndex(store, 'byCustomerId', 'customerId');
  ensureIndex(store, 'byProductId', 'productId');
  ensureIndex(store, 'byCreatedAt', 'createdAt');

  store = ensureStore(STORE.ORDERS, { keyPath: 'orderId' });
  ensureIndex(store, 'byCustomerId', 'customerId');
  ensureIndex(store, 'byWarehouseId', 'warehouseId');
  ensureIndex(store, 'byOrderNo', 'orderNo');
  ensureIndex(store, 'byExternalOrderNo', ['sourceType', 'externalOrderNo']);
  ensureIndex(store, 'byOrderStatus', 'orderStatus');
  ensureIndex(store, 'byAdminStatus', 'adminStatus');
  ensureIndex(store, 'byOpsStatus', 'opsStatus');
  ensureIndex(store, 'byAssigneeId', 'assigneeId');
  ensureIndex(store, 'byInputChannel', 'inputChannel');
  ensureIndex(store, 'bySourceMessageKey', 'sourceMessageKey', { unique: true });
  ensureIndex(store, 'byOrderDate', 'orderDate');
  ensureIndex(store, 'byUpdatedAt', 'updatedAt');
  ensureIndex(store, 'byStatus', 'status');

  store = ensureStore(STORE.ORDER_ITEMS, { keyPath: 'orderItemId' });
  ensureIndex(store, 'byOrderId', 'orderId');
  ensureIndex(store, 'byOrderStatus', ['orderId', 'matchStatus']);
  ensureIndex(store, 'byProductId', 'productId');

  store = ensureStore(STORE.ORDER_EVENTS, { keyPath: 'eventId' });
  ensureIndex(store, 'byOrderId', 'orderId');
  ensureIndex(store, 'byOrderRevision', ['orderId', 'revision']);
  ensureIndex(store, 'byCreatedAt', 'createdAt');

  store = ensureStore(STORE.IMPORT_BATCHES, { keyPath: 'importBatchId' });
  ensureIndex(store, 'byFileHash', 'fileHash');
  ensureIndex(store, 'byStatusImportedAt', ['status', 'importedAt']);
  ensureIndex(store, 'byImportedAt', 'importedAt');

  store = ensureStore(STORE.SOURCE_RECORDS, { keyPath: 'sourceRecordId' });
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'byFingerprint', 'rowFingerprint');
  ensureIndex(store, 'bySourceType', 'sourceType');

  store = ensureStore(STORE.SALES_DOCUMENTS, { keyPath: 'salesDocumentId' });
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'bySalesDate', 'salesDate');
  ensureIndex(store, 'byCustomerDate', ['normalizedCustomerName', 'salesDate']);
  ensureIndex(store, 'byWarehouseId', 'warehouseId');
  ensureIndex(store, 'byAssigneeId', 'assigneeId');

  store = ensureStore(STORE.SALES_LINES, { keyPath: 'salesLineId' });
  ensureIndex(store, 'byDocumentId', 'salesDocumentId');
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'byProductCode', 'productCode');

  store = ensureStore(STORE.PURCHASE_DOCUMENTS, { keyPath: 'purchaseDocumentId' });
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'byPurchaseDate', 'purchaseDate');
  ensureIndex(store, 'bySupplierDate', ['normalizedSupplierName', 'purchaseDate']);
  ensureIndex(store, 'byWarehouseId', 'warehouseId');

  store = ensureStore(STORE.PURCHASE_LINES, { keyPath: 'purchaseLineId' });
  ensureIndex(store, 'byDocumentId', 'purchaseDocumentId');
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'byProductCode', 'productCode');

  store = ensureStore(STORE.LEDGER_DOCUMENTS, { keyPath: 'ledgerDocumentId' });
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'byTransactionDate', 'transactionDate');
  ensureIndex(store, 'byCustomerDate', ['normalizedCustomerName', 'transactionDate']);

  store = ensureStore(STORE.LEDGER_LINES, { keyPath: 'ledgerLineId' });
  ensureIndex(store, 'byDocumentId', 'ledgerDocumentId');
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'byProductCode', 'productCode');

  store = ensureStore(STORE.INVENTORY_SNAPSHOTS, { keyPath: 'inventorySnapshotId' });
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'byBasisDate', 'basisDate');
  ensureIndex(store, 'byWarehouseId', 'warehouseId');

  store = ensureStore(STORE.INVENTORY_LINES, { keyPath: 'inventoryLineId' });
  ensureIndex(store, 'bySnapshotId', 'inventorySnapshotId');
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'byProductCode', 'productCode');
  ensureIndex(store, 'byWarehouseId', 'warehouseId');

  store = ensureStore(STORE.HISTORICAL_ORDER_GROUPS, { keyPath: 'historicalOrderGroupId' });
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'byOrderDate', 'orderDate');
  ensureIndex(store, 'byCustomerDate', ['normalizedCustomerName', 'orderDate']);
  ensureIndex(store, 'byWarehouseId', 'warehouseId');

  store = ensureStore(STORE.HISTORICAL_ORDER_LINES, { keyPath: 'historicalOrderLineId' });
  ensureIndex(store, 'byGroupId', 'historicalOrderGroupId');
  ensureIndex(store, 'byBatchId', 'importBatchId');
  ensureIndex(store, 'byProductCode', 'productCode');

  store = ensureStore(STORE.FULFILLMENT_LINKS, { keyPath: 'fulfillmentLinkId' });
  ensureIndex(store, 'byOrderLineId', 'historicalOrderLineId');
  ensureIndex(store, 'bySalesLineId', 'salesLineId');
  ensureIndex(store, 'byStatus', 'status');
  ensureIndex(store, 'byCreatedAt', 'createdAt');

  store = ensureStore(STORE.FULFILLMENT_BALANCES, { keyPath: 'fulfillmentBalanceId' });
  ensureIndex(store, 'byOrderLineId', 'historicalOrderLineId', { unique: true });
  ensureIndex(store, 'byStatus', 'status');
  ensureIndex(store, 'byUpdatedAt', 'updatedAt');

  store = ensureStore(STORE.PARSER_EVIDENCE, { keyPath: 'parserEvidenceId' });
  ensureIndex(store, 'byCustomerExpression', ['customerId', 'normalizedExpression']);
  ensureIndex(store, 'byProductCode', 'productCode');
  ensureIndex(store, 'byStatus', 'status');
  ensureIndex(store, 'byCreatedAt', 'createdAt');

  ensureStore(STORE.COLLECTOR_SETTINGS, { keyPath: 'key' });

  store = ensureStore(STORE.SYNC_QUEUE, { keyPath: 'queueId' });
  ensureIndex(store, 'byStatusCreatedAt', ['status', 'createdAt']);
  ensureIndex(store, 'byEntity', ['entityType', 'entityId']);

  const metaStore = ensureStore(STORE.META, { keyPath: 'key' });

    if (oldVersion < 9) {
      V9_STORE_DEFINITIONS.forEach(definition => {
        const store = ensureStore(definition.name, definition.options);
        definition.indexes.forEach(index => ensureIndex(store, index.name, index.keyPath, index.options || {}));
      });

      const customerStore = tx.objectStore(STORE.CUSTOMERS);
      ensureIndex(customerStore, 'byCanonicalCustomerId', 'canonicalCustomerId');
      ensureIndex(customerStore, 'byCustomerCode', 'normalizedCustomerCode');
      ensureIndex(customerStore, 'byStatusQuality', ['status', 'qualityStatus']);
      const cursorRequest = customerStore.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const customer = cursor.value || {};
        const customerId = String(customer.customerId || '').trim();
        const qualityStatus = customer.qualityStatus || 'UNVERIFIED';
        const customerCode = String(customer.customerCode || customer.erpCustomerCode || '').trim();
        const normalizedName = customer.normalizedName || normalizeText(customer.customerName);
        cursor.update({
          ...customer,
          customerId,
          customerCode,
          normalizedCustomerCode: normalizeText(customerCode),
          normalizedName,
          looseNormalizedName: normalizeText(normalizedName).replace(/[()주식회사유한회사\s]/g, ''),
          status: customer.status || 'ACTIVE',
          qualityStatus,
          canonicalCustomerId: qualityStatus === 'SUPERSEDED'
            ? String(customer.canonicalCustomerId || customer.supersededByCustomerId || '')
            : customerId,
          revision: Math.max(1, Number(customer.revision || 1)),
          updatedAt: customer.updatedAt || nowIso()
        });
        cursor.continue();
      };

      metaStore.put({ key: 'schemaVersion', value: 9, updatedAt: nowIso() });
    }

    if (oldVersion < 8) {
    for (const definition of V8_STORE_DEFINITIONS) {
      const v8Store = ensureStore(definition.name, { keyPath: definition.keyPath });
      for (const entry of definition.indexes) {
        ensureIndex(v8Store, entry.name, entry.keyPath, entry.options);
      }
    }

    const orderStore = transaction.objectStore(STORE.ORDERS);
    if (orderStore.indexNames.contains('bySourceMessageKey')) orderStore.deleteIndex('bySourceMessageKey');
    orderStore.createIndex('bySourceMessageKey', 'sourceMessageKey', { unique: false });
    ensureIndex(orderStore, 'bySourceDocumentKey', 'sourceDocumentKey', { unique: true });

    const cursorRequest = orderStore.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const order = cursor.value;
      const sourceMessageKey = String(order.sourceMessageKey || '').trim();
      if (!String(order.sourceDocumentKey || '').trim() && sourceMessageKey) {
        cursor.update({ ...order, sourceDocumentKey: `LEGACY:${sourceMessageKey}` });
      }
      cursor.continue();
    };
    metaStore.put({ key: 'schemaVersion', value: ORDERQ_DB_VERSION, updatedAt: new Date().toISOString() });
  }

  if (oldVersion < 7) {
    for (const definition of V7_STORE_DEFINITIONS) {
      const v7Store = ensureStore(definition.name, { keyPath: definition.keyPath });
      for (const entry of definition.indexes) {
        ensureIndex(v7Store, entry.name, entry.keyPath, entry.options);
      }
    }
    for (const [storeName, indexes] of Object.entries(V7_EXISTING_STORE_INDEXES)) {
      const existingStore = transaction.objectStore(storeName);
      for (const entry of indexes) {
        ensureIndex(existingStore, entry.name, entry.keyPath, entry.options);
      }
    }
    const updatedAt = new Date().toISOString();
    metaStore.put({ key: 'schemaVersion', value: ORDERQ_DB_VERSION, updatedAt });
    metaStore.put({ key: 'dispatchStagePolicyCatalog', value: DISPATCH_STAGE_POLICY, updatedAt });
    metaStore.put({
      key: 'mvpActorCapabilityContract',
      value: { defaultActorId: MVP_ACTOR_ID, capabilities: Object.values(CAPABILITY) },
      updatedAt
    });
  }

  if (oldVersion < 6) {
    const orderStore = transaction.objectStore(STORE.ORDERS);
    const orderRequest = orderStore.getAll();
    const itemRequest = transaction.objectStore(STORE.ORDER_ITEMS).getAll();
    let migrationOrders = null;
    let migrationItems = null;
    const migrate = () => {
      if (!migrationOrders || !migrationItems) return;
      const counters = new Map();
      const itemsByOrder = new Map();
      migrationItems.forEach(item => {
        if (!itemsByOrder.has(item.orderId)) itemsByOrder.set(item.orderId, []);
        itemsByOrder.get(item.orderId).push(item);
      });
      const orders = migrationOrders.sort((a, b) => {
        const timeOrder = String(a.createdAt || a.orderDate || '').localeCompare(String(b.createdAt || b.orderDate || ''));
        return timeOrder || String(a.orderId || '').localeCompare(String(b.orderId || ''));
      });
      orders.forEach(order => {
        const dateMatch = String(order.orderDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const dateKey = dateMatch ? `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}` : String(order.createdAt || '').slice(0, 10).replace(/\D/g, '') || '00000000';
        const existingMatch = String(order.orderNo || '').match(/^(\d{8})-(\d+)$/);
        const current = counters.get(dateKey) || 0;
        const sequence = existingMatch?.[1] === dateKey ? Math.max(current, Number(existingMatch[2]) || 0) : current + 1;
        counters.set(dateKey, sequence);
        const orderNo = order.orderNo || `${dateKey}-${String(sequence).padStart(3, '0')}`;
        const cancelled = String(order.status || '').toUpperCase() === 'CANCELLED';
        const orderItems = itemsByOrder.get(order.orderId) || [];
        const supplyAmountTotal = orderItems.reduce((sum, item) => sum + (item.supplyAmount != null
          ? Number(item.supplyAmount || 0)
          : Number(item.finalQuantity || item.rawQuantity || 0) * Number(item.price || 0)), 0);
        const vatAmountTotal = orderItems.reduce((sum, item) => sum + Number(item.vatAmount || 0), 0);
        orderStore.put({
          ...order,
          orderNo,
          sourceMessageKey: String(order.sourceMessageKey || '').trim() || undefined,
          orderStatus: order.orderStatus || (cancelled ? 'FULL_CANCEL' : 'ORDER'),
          adminStatus: order.adminStatus || 'UNCHECKED',
          opsStatus: order.opsStatus || 'ACTIVE',
          inputChannel: order.inputChannel || (/KAKAO|SMART|ORDER_IN/i.test(order.sourceType || '') ? 'ORDER_IN' : 'DIRECT'),
          assigneeId: order.assigneeId || '',
          assigneeName: order.assigneeName || '',
          matchingStatus: order.matchingStatus || order.status || '',
          supplyAmountTotal: order.supplyAmountTotal ?? supplyAmountTotal,
          vatAmountTotal: order.vatAmountTotal ?? vatAmountTotal,
          orderAmount: order.orderAmount ?? (supplyAmountTotal + vatAmountTotal)
        });
      });
      counters.forEach((sequence, dateKey) => metaStore.put({ key: `orderNoSequence:${dateKey}`, value: sequence, updatedAt: new Date().toISOString() }));
    };
    orderRequest.onsuccess = () => { migrationOrders = orderRequest.result || []; migrate(); };
    itemRequest.onsuccess = () => { migrationItems = itemRequest.result || []; migrate(); };
  }
}

export function openOrderQDb() {
  if (dbPromise) return dbPromise;
  const pending = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => upgradeOrderQDbSchema(request.result, request.transaction, event.oldVersion);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('ORDER Q DB 업그레이드가 다른 탭에 의해 차단되었습니다. 다른 ORDER Q 탭을 닫고 다시 시도하세요.'));
  });
  dbPromise = pending.catch(error => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

export function closeOrderQDb() {
  if (!dbPromise) return;
  dbPromise.then(db => db.close()).catch(() => {});
  dbPromise = null;
}

export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${token}`;
}

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '');
}

export async function getAll(storeName, indexName = null, query = null) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const source = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
  const result = await requestToPromise(source.getAll(query));
  await transactionDone(tx);
  return result;
}

export async function getByKey(storeName, key) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestToPromise(tx.objectStore(storeName).get(key));
  await transactionDone(tx);
  return result;
}
