import { SHIPMENT_RESULT_SCHEMA, SHIPMENT_STATUS } from './shipment-result-core.js?v=1.0.0';

export const SHIPMENT_RESULT_DB_NAME = 'ONEAPPShippingResultDB';
export const SHIPMENT_RESULT_DB_VERSION = 1;
export const SHIPMENT_RESULT_STORE = Object.freeze({
  DOCUMENTS: 'shipmentDocuments',
  LINES: 'shipmentLines',
  EVENTS: 'shipmentEvents',
  RECEIPTS: 'shipmentCommandReceipts'
});

let dbPromise = null;
const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
});
const transactionDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
});
const clone = value => structuredClone(value);
const round = value => Math.round((Number(value || 0) + Number.EPSILON) * 1e9) / 1e9;

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

export function openShipmentResultDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(SHIPMENT_RESULT_DB_NAME, SHIPMENT_RESULT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      let store = db.createObjectStore(SHIPMENT_RESULT_STORE.DOCUMENTS, { keyPath: 'shipmentDocumentId' });
      ensureIndex(store, 'byOrderId', 'orderId');
      ensureIndex(store, 'byStatus', 'status');
      ensureIndex(store, 'byUpdatedAt', 'updatedAt');
      store = db.createObjectStore(SHIPMENT_RESULT_STORE.LINES, { keyPath: 'shipmentLineId' });
      ensureIndex(store, 'byShipmentDocumentId', 'shipmentDocumentId');
      ensureIndex(store, 'byOrderId', 'orderId');
      ensureIndex(store, 'byOrderItemId', 'orderItemId');
      store = db.createObjectStore(SHIPMENT_RESULT_STORE.EVENTS, { keyPath: 'shipmentEventId' });
      ensureIndex(store, 'byShipmentDocumentId', 'shipmentDocumentId');
      ensureIndex(store, 'byOrderId', 'orderId');
      ensureIndex(store, 'byCreatedAt', 'createdAt');
      store = db.createObjectStore(SHIPMENT_RESULT_STORE.RECEIPTS, { keyPath: 'commandId' });
      ensureIndex(store, 'byOrderId', 'orderId');
      ensureIndex(store, 'byShipmentDocumentId', 'shipmentDocumentId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error || new Error('출고결과 저장소를 열지 못했습니다.')); };
    request.onblocked = () => { dbPromise = null; reject(new Error('다른 화면이 출고결과 저장소 갱신을 막고 있습니다.')); };
  });
  return dbPromise;
}

export async function readShipmentDocument(shipmentDocumentId) {
  const db = await openShipmentResultDb();
  const tx = db.transaction([SHIPMENT_RESULT_STORE.DOCUMENTS, SHIPMENT_RESULT_STORE.LINES, SHIPMENT_RESULT_STORE.EVENTS], 'readonly');
  const [document, lines, events] = await Promise.all([
    requestResult(tx.objectStore(SHIPMENT_RESULT_STORE.DOCUMENTS).get(shipmentDocumentId)),
    requestResult(tx.objectStore(SHIPMENT_RESULT_STORE.LINES).index('byShipmentDocumentId').getAll(shipmentDocumentId)),
    requestResult(tx.objectStore(SHIPMENT_RESULT_STORE.EVENTS).index('byShipmentDocumentId').getAll(shipmentDocumentId))
  ]);
  await transactionDone(tx);
  return document ? clone({ document, lines, events }) : null;
}

export async function listShipmentDocumentsByOrder(orderId) {
  const db = await openShipmentResultDb();
  const tx = db.transaction([SHIPMENT_RESULT_STORE.DOCUMENTS, SHIPMENT_RESULT_STORE.LINES, SHIPMENT_RESULT_STORE.EVENTS], 'readonly');
  const [documents, lines, events] = await Promise.all([
    requestResult(tx.objectStore(SHIPMENT_RESULT_STORE.DOCUMENTS).index('byOrderId').getAll(orderId)),
    requestResult(tx.objectStore(SHIPMENT_RESULT_STORE.LINES).index('byOrderId').getAll(orderId)),
    requestResult(tx.objectStore(SHIPMENT_RESULT_STORE.EVENTS).index('byOrderId').getAll(orderId))
  ]);
  await transactionDone(tx);
  const linesByDocument = new Map();
  const eventsByDocument = new Map();
  lines.forEach(line => linesByDocument.set(line.shipmentDocumentId, [...(linesByDocument.get(line.shipmentDocumentId) || []), line]));
  events.forEach(event => eventsByDocument.set(event.shipmentDocumentId, [...(eventsByDocument.get(event.shipmentDocumentId) || []), event]));
  return documents
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
    .map(document => clone({ document, lines: linesByDocument.get(document.shipmentDocumentId) || [], events: eventsByDocument.get(document.shipmentDocumentId) || [] }));
}

export async function commitShipmentBundle(bundle) {
  if (bundle?.schemaVersion !== SHIPMENT_RESULT_SCHEMA || !bundle.document || !bundle.receipt) throw new Error('지원하지 않는 출고결과 형식입니다.');
  const db = await openShipmentResultDb();
  const tx = db.transaction(Object.values(SHIPMENT_RESULT_STORE), 'readwrite');
  const completed = transactionDone(tx);
  const receipts = tx.objectStore(SHIPMENT_RESULT_STORE.RECEIPTS);
  const existing = await requestResult(receipts.get(bundle.receipt.commandId));
  if (existing) {
    await completed;
    if (existing.payloadHash !== bundle.receipt.payloadHash) {
      const error = new Error('같은 출고 명령 ID에 다른 내용이 요청되었습니다.');
      error.code = 'SHIPMENT_COMMAND_CONFLICT';
      throw error;
    }
    const saved = await readShipmentDocument(existing.shipmentDocumentId);
    return { ...saved, duplicate: true, receipt: clone(existing) };
  }
  const [existingDocuments, existingLines] = await Promise.all([
    requestResult(tx.objectStore(SHIPMENT_RESULT_STORE.DOCUMENTS).index('byOrderId').getAll(bundle.document.orderId)),
    requestResult(tx.objectStore(SHIPMENT_RESULT_STORE.LINES).index('byOrderId').getAll(bundle.document.orderId))
  ]);
  let conflictMessage = '';
  if (bundle.document.status === SHIPMENT_STATUS.CONFIRMED) {
    const statusByDocument = new Map(existingDocuments.map(document => [document.shipmentDocumentId, document.status]));
    const currentNet = new Map();
    existingLines.forEach(line => {
      const status = statusByDocument.get(line.shipmentDocumentId);
      const sign = status === SHIPMENT_STATUS.CONFIRMED ? 1 : status === SHIPMENT_STATUS.REVERSED ? -1 : 0;
      if (!sign || !line.orderItemId) return;
      currentNet.set(line.orderItemId, round((currentNet.get(line.orderItemId) || 0) + sign * Math.abs(Number(line.shippedQuantity || 0))));
    });
    const overLine = bundle.lines.find(line => Number(line.shippedQuantity || 0) > Math.max(0, round(Number(line.shippableQuantity || 0) - Math.max(0, Number(currentNet.get(line.orderItemId) || 0)))));
    if (overLine) conflictMessage = '다른 화면의 출고 확정으로 남은 주문수량이 변경되었습니다. 출고결과를 새로고침한 뒤 다시 확인하세요.';
  }
  if (bundle.document.status === SHIPMENT_STATUS.REVERSED
    && existingDocuments.some(document => document.reversesShipmentDocumentId === bundle.document.reversesShipmentDocumentId)) {
    conflictMessage = '다른 화면에서 이미 이 출고결과를 취소했습니다.';
  }
  if (conflictMessage) {
    try { tx.abort(); } catch (_) {}
    try { await completed; } catch (_) {}
    const error = new Error(conflictMessage);
    error.code = 'SHIPMENT_RESULT_CONFLICT';
    throw error;
  }
  tx.objectStore(SHIPMENT_RESULT_STORE.DOCUMENTS).add(clone(bundle.document));
  bundle.lines.forEach(line => tx.objectStore(SHIPMENT_RESULT_STORE.LINES).add(clone(line)));
  bundle.events.forEach(event => tx.objectStore(SHIPMENT_RESULT_STORE.EVENTS).add(clone(event)));
  receipts.add(clone(bundle.receipt));
  await completed;
  try {
    const channel = new BroadcastChannel('oneapp-orderops-shipment-results');
    channel.postMessage({ type: 'SHIPMENT_RESULT_COMMITTED', orderId: bundle.document.orderId });
    channel.close();
  } catch (_) {}
  return { document: clone(bundle.document), lines: clone(bundle.lines), events: clone(bundle.events), receipt: clone(bundle.receipt), duplicate: false };
}
