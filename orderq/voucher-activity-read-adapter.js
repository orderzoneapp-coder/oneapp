import { requestToPromise, transactionDone, STORE } from './orderq-db.js?v=0.7.2';

export const ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER = 'ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER_V1';
export const ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT = 'ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT_V1';

const DB_NAME = 'oneapp-orderq-pre-m1-v6';
const MODE_CONFIG = Object.freeze({
  order: Object.freeze({ documentStore: STORE.ORDERS, lineStore: STORE.ORDER_ITEMS, dateIndex: 'byOrderDate', lineIndex: 'byOrderId', dateField: 'orderDate', idField: 'orderId' }),
  purchase: Object.freeze({ documentStore: STORE.PURCHASE_DOCUMENTS, lineStore: STORE.PURCHASE_LINES, dateIndex: 'byPurchaseDate', lineIndex: 'byDocumentId', dateField: 'purchaseDate', idField: 'purchaseDocumentId' }),
  sale: Object.freeze({ documentStore: STORE.SALES_DOCUMENTS, lineStore: STORE.SALES_LINES, dateIndex: 'bySalesDate', lineIndex: 'byDocumentId', dateField: 'salesDate', idField: 'salesDocumentId' })
});

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function customerName(mode, document) {
  if (mode === 'purchase') return document.supplierCustomerName || document.supplierName || '';
  if (mode === 'sale') return document.salesCustomerName || document.customerName || document.deliveryCustomerName || '';
  return document.customerName || '';
}

function status(mode, document) {
  if (mode === 'order') return document.orderStatus || document.status || document.adminStatus || '저장';
  return document.documentStatus || document.status || document.projectionStatus || '저장';
}

function amount(mode, document, lines) {
  const direct = mode === 'order'
    ? (document.orderAmount ?? document.supplyAmountTotal)
    : (document.totalAmount ?? document.supplyAmountTotal);
  if (direct !== undefined && direct !== null && Number.isFinite(Number(direct))) return Number(direct);
  return lines.reduce((sum, line) => sum + number(line.totalAmount ?? line.supplyAmount ?? (number(line.quantity ?? line.actualQuantity) * number(line.price ?? line.unitPrice))), 0);
}

function openExistingDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let missing = false;
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      if (missing && request.error?.name === 'AbortError') resolve(null);
      else reject(request.error || new Error('VOUCHER_ACTIVITY_DB_OPEN_FAILED'));
    };
    request.onblocked = () => reject(new Error('VOUCHER_ACTIVITY_DB_BLOCKED'));
  });
}

export async function readVoucherActivity({ mode, date }) {
  const config = MODE_CONFIG[mode];
  if (!config) throw new Error('VOUCHER_ACTIVITY_MODE_INVALID');
  if (!validDate(date)) throw new Error('VOUCHER_ACTIVITY_DATE_INVALID');
  const checkedAt = new Date().toISOString();
  let db = null;
  try {
    db = await openExistingDatabase();
    if (!db) return { schema: ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT, adapter: ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER, status: 'EMPTY', mode, date, count: 0, rows: [], checkedAt, source: 'ORDER Q 공식 전표 Read Adapter' };
    if (![config.documentStore, config.lineStore].every(store => db.objectStoreNames.contains(store))) throw new Error('VOUCHER_ACTIVITY_STORE_UNAVAILABLE');
    const transaction = db.transaction([config.documentStore, config.lineStore], 'readonly');
    const completed = transactionDone(transaction);
    const documentStore = transaction.objectStore(config.documentStore);
    const lineStore = transaction.objectStore(config.lineStore);
    if (!documentStore.indexNames.contains(config.dateIndex) || !lineStore.indexNames.contains(config.lineIndex)) throw new Error('VOUCHER_ACTIVITY_INDEX_UNAVAILABLE');
    const documents = await requestToPromise(documentStore.index(config.dateIndex).getAll(globalThis.IDBKeyRange.only(date)));
    const datedDocuments = documents.filter(document => document[config.dateField] === date);
    const linesByDocument = new Map(await Promise.all(datedDocuments.map(async document => {
      const id = document[config.idField];
      return [id, await requestToPromise(lineStore.index(config.lineIndex).getAll(id))];
    })));
    await completed;
    const rows = datedDocuments.map(document => {
      const id = document[config.idField];
      const lines = linesByDocument.get(id) || [];
      const savedAt = document.updatedAt || document.createdAt || document.postedAt || document.occurredAt || '';
      return {
        id,
        voucherNo: document.orderNo || document.externalDocumentNo || document.voucherNo || id,
        date: document[config.dateField] || date,
        savedAt,
        customerName: customerName(mode, document) || '거래처 미지정',
        itemCount: lines.length || number(document.lineCount || document.itemCount),
        totalAmount: amount(mode, document, lines),
        status: status(mode, document),
        items: lines.map(line => ({
          code: line.productCode || line.itemCode || '',
          name: line.productName || line.itemName || line.rawExpression || '',
          specification: line.specification || '',
          quantity: line.actualQuantity ?? line.finalQuantity ?? line.quantity ?? line.rawQuantity ?? '',
          unit: line.actualUnit || line.finalUnit || line.unit || line.rawUnit || '',
          unitPrice: line.unitPrice ?? line.price ?? '',
          amount: line.totalAmount ?? line.supplyAmount ?? ''
        })),
        detailHref: `../orderq/voucher-query.html?mode=${encodeURIComponent(mode)}&date=${encodeURIComponent(date)}&focus=${encodeURIComponent(id)}`
      };
    }).sort((left, right) => String(right.savedAt || '').localeCompare(String(left.savedAt || '')));
    return {
      schema: ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT,
      adapter: ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER,
      status: rows.length ? 'READY' : 'EMPTY',
      mode,
      date,
      count: rows.length,
      rows,
      checkedAt,
      source: 'ORDER Q 공식 전표 Read Adapter'
    };
  } catch (error) {
    return {
      schema: ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT,
      adapter: ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER,
      status: 'ERROR',
      mode,
      date,
      count: null,
      rows: [],
      checkedAt,
      source: 'ORDER Q 공식 전표 Read Adapter',
      error: { code: error?.message || 'VOUCHER_ACTIVITY_READ_FAILED', message: '전표 목록을 불러오지 못했습니다.' }
    };
  } finally {
    db?.close();
  }
}
