import { deepFreeze, sha256Hex } from '../reference-data/change-request-contract.js';

export const INPUT_MATCHING_SNAPSHOT_SCHEMA = 'ONEAPP_ORDERQ_INPUT_MATCHING_SNAPSHOT_V1';
const DATABASE = 'oneapp-orderq-pre-m1-v6';
const STORES = ['products', 'productMappings', 'orders', 'orderItems'];
const text = value => String(value ?? '').trim();
const shapeFields = ['productId', 'itemCode', 'productCode', 'itemName', 'productName', 'specification', 'unit', 'finalUnit'];
const select = (row, fields) => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]));

// Do not use openOrderQDb: its open may upgrade/migrate the owner database.
async function readExistingRecords() {
  if (!globalThis.indexedDB) throw new Error('INPUT_MATCHING_IDB_UNAVAILABLE');
  let missing = false;
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE);
    request.onupgradeneeded = () => { missing = true; request.transaction.abort(); };
    request.onerror = () => missing && request.error?.name === 'AbortError'
      ? resolve(null) : reject(request.error || new Error('INPUT_MATCHING_DB_OPEN_FAILED'));
    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => reject(new Error('INPUT_MATCHING_DB_BLOCKED'));
  });
  if (!db) return { sourceVersion: null, records: Object.fromEntries(STORES.map(store => [store, []])) };
  try {
    if (STORES.some(store => !db.objectStoreNames.contains(store))) throw new Error('INPUT_MATCHING_STORE_UNAVAILABLE');
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, 'readonly');
      const records = {};
      tx.oncomplete = () => resolve({ sourceVersion: db.version, records });
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('INPUT_MATCHING_READ_FAILED'));
      for (const store of STORES) {
        const request = tx.objectStore(store).getAll();
        request.onsuccess = () => { records[store] = request.result; };
        request.onerror = () => reject(request.error || new Error('INPUT_MATCHING_READ_FAILED'));
      }
    });
  } finally { db.close(); }
}

export async function readInputMatchingSnapshot({ companyId, actorId } = {}, { readRecords = readExistingRecords } = {}) {
  try {
    const company = text(companyId), actor = text(actorId);
    if (!company || !actor) throw new Error('INPUT_MATCHING_SCOPE_REQUIRED');
    const { records, sourceVersion } = await readRecords();
    if (STORES.some(store => !Array.isArray(records?.[store]))) throw new Error('INPUT_MATCHING_RECORDS_INCOMPLETE');
    // Match the existing owner Read Adapter's default-company compatibility rule.
    // Unscoped legacy records never become records of an arbitrary signed-in company.
    const inScope = row => row && (text(row.companyId) || 'ONEAPP') === company;
    const products = records.products.filter(inScope).map(row => ({ ...select(row, shapeFields), companyId: company }));
    const mappings = records.productMappings.filter(inScope).map(row => ({
      ...select(row, [...shapeFields, 'mappingId', 'customerId', 'sourceId', 'rawText', 'normalizedText', 'status']), companyId: company
    }));
    const orders = new Map(records.orders.filter(inScope).map(row => [row.orderId, row]));
    // Preserve getAll order, the customer join, and all existing history rows.
    // The old candidate rule has no date/cancellation filter and no frequency policy.
    const history = records.orderItems.filter(item => orders.has(item?.orderId)
      && (!text(item.companyId) || text(item.companyId) === company)).map(item => ({
      ...select(item, [...shapeFields, 'orderItemId', 'orderId']),
      customerId: orders.get(item.orderId).customerId || '', companyId: company
    }));
    const snapshot = {
      schemaVersion: INPUT_MATCHING_SNAPSHOT_SCHEMA, ownerAppId: 'orderq-vnext',
      companyId: company, actorId: actor, sourceDatabase: DATABASE, sourceVersion,
      legacyDefaultCompanyId: 'ONEAPP', products, mappings, history,
      counts: { products: products.length, mappings: mappings.length, history: history.length }
    };
    snapshot.contentHash = await sha256Hex(snapshot);
    snapshot.readAt = new Date().toISOString();
    return { status: products.length || mappings.length || history.length ? 'READY' : 'EMPTY', snapshot: deepFreeze(snapshot) };
  } catch (error) {
    return { status: 'ERROR', error: { code: 'INPUT_MATCHING_READ_FAILED', message: error?.message || String(error) } };
  }
}
