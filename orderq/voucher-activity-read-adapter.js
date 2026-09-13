import { requestToPromise, transactionDone, STORE } from './orderq-db.js?v=0.8.0';

export const ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER = 'ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER_V1';
export const ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT = 'ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT_V1';

const DB_NAME = 'oneapp-orderq-pre-m1-v6';
const MODE_CONFIG = Object.freeze({
  order: Object.freeze({ documentStore: STORE.ORDERS, lineStore: STORE.ORDER_ITEMS, dateIndex: 'byOrderDate', lineIndex: 'byOrderId', dateField: 'orderDate', idField: 'orderId' }),
  purchase: Object.freeze({ documentStore: STORE.PURCHASE_DOCUMENTS, lineStore: STORE.PURCHASE_LINES, dateIndex: 'byPurchaseDate', lineIndex: 'byDocumentId', dateField: 'purchaseDate', idField: 'purchaseDocumentId' }),
  sale: Object.freeze({ documentStore: STORE.SALES_DOCUMENTS, lineStore: STORE.SALES_LINES, dateIndex: 'bySalesDate', lineIndex: 'byDocumentId', dateField: 'salesDate', idField: 'salesDocumentId' })
});

function validDate(value) {
  const candidate = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate;
}

function isoDates(fromDate, toDate, maxDays) {
  if (!validDate(fromDate) || !validDate(toDate) || fromDate > toDate) throw new Error('VOUCHER_ACTIVITY_RANGE_INVALID');
  const dates = [];
  const cursor = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  while (cursor <= end && dates.length < maxDays) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { dates, truncated: cursor <= end };
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

export async function readVoucherActivity({ mode, date, companyId = '' }) {
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
    const datedDocuments = documents.filter(document => document[config.dateField] === date
      && (!companyId || String(document.companyId || 'ONEAPP') === String(companyId)));
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
        companyId: document.companyId || 'ONEAPP',
        voucherMode: mode,
        voucherNo: document.orderNo || document.externalDocumentNo || document.voucherNo || id,
        date: document[config.dateField] || date,
        savedAt,
        revision: Number(document.revision || document.documentRevision || document.orderRevision) || 0,
        hash: document.hash || document.snapshotHash || document.documentHash || '',
        customerName: customerName(mode, document) || '거래처 미지정',
        customerId: document.supplierCustomerId || document.salesCustomerId || document.customerId || document.deliveryCustomerId || '',
        customerCode: document.supplierCustomerCode || document.salesCustomerCode || document.customerCode || document.deliveryCustomerCode || '',
        warehouseId: document.warehouseId || '',
        warehouseCode: document.warehouseCode || '',
        warehouseName: document.warehouseName || '',
        itemCount: lines.length || number(document.lineCount || document.itemCount),
        totalAmount: amount(mode, document, lines),
        status: status(mode, document),
        items: lines.map((line, lineIndex) => ({
          lineId: line.lineId || line.orderItemId || line.purchaseLineId || line.salesLineId || `${id}:${lineIndex + 1}`,
          productId: line.productId || '',
          masterProductId: line.masterProductId || line.productId || '',
          code: line.productCode || line.itemCode || '',
          name: line.productName || line.itemName || line.rawExpression || '',
          specification: line.specification || '',
          quantity: line.actualQuantity ?? line.finalQuantity ?? line.quantity ?? line.rawQuantity ?? '',
          quantityDisplay: String(line.sourceQuantityDisplay ?? line.actualQuantity ?? line.finalQuantity ?? line.quantity ?? line.rawQuantity ?? ''),
          unit: line.actualUnit || line.finalUnit || line.unit || line.rawUnit || '',
          unitPrice: line.unitPrice ?? line.price ?? '',
          unitPriceDisplay: String(line.sourceUnitPrice ?? line.unitPrice ?? line.price ?? ''),
          amount: line.totalAmount ?? line.supplyAmount ?? ''
        })),
        detailHref: mode === 'order'
          ? `../orderq/index.html?view=query&focus=${encodeURIComponent(id)}`
          : `../orderq/voucher-query.html?mode=${encodeURIComponent(mode)}&date=${encodeURIComponent(date)}&companyId=${encodeURIComponent(companyId || document.companyId || 'ONEAPP')}&focus=${encodeURIComponent(id)}`
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

export async function readVoucherActivityRange({ mode, fromDate, toDate, companyId = '', maxDays = 31, concurrency = 4 }) {
  const boundedDays = Math.max(1, Math.min(62, Number(maxDays) || 31));
  const boundedConcurrency = Math.max(1, Math.min(4, Number(concurrency) || 4));
  const range = isoDates(fromDate, toDate, boundedDays);
  const results = [];
  for (let offset = 0; offset < range.dates.length; offset += boundedConcurrency) {
    const batch = range.dates.slice(offset, offset + boundedConcurrency);
    results.push(...await Promise.all(batch.map(date => readVoucherActivity({ mode, date, companyId }))));
  }
  const failures = results.filter(result => result.status === 'ERROR');
  const rows = results.flatMap(result => result.status === 'READY' ? result.rows : []);
  const seen = new Set();
  const deduplicated = rows.filter(row => {
    const key = [row.companyId, row.voucherMode, row.id, row.revision, row.hash].join('\u001f');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const partial = range.truncated || failures.length > 0;
  return {
    schema: ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT,
    adapter: ONEAPP_VOUCHER_ACTIVITY_READ_ADAPTER,
    status: partial ? 'PARTIAL' : (deduplicated.length ? 'READY' : 'EMPTY'),
    mode,
    fromDate,
    toDate,
    companyId,
    count: deduplicated.length,
    rows: deduplicated,
    checkedAt: new Date().toISOString(),
    source: 'ORDER Q 공식 전표 Read Adapter',
    coverage: {
      requestedFromDate: fromDate,
      requestedToDate: toDate,
      readDates: range.dates,
      maxDays: boundedDays,
      truncated: range.truncated,
      failureDates: failures.map(result => result.date),
    },
    error: partial ? {
      code: 'VOUCHER_ACTIVITY_RANGE_PARTIAL',
      message: [range.truncated ? `${boundedDays}일 제한으로 일부 기간만 읽었습니다.` : '', failures.length ? `${failures.length}개 일자를 읽지 못했습니다.` : ''].filter(Boolean).join(' '),
    } : null,
  };
}
