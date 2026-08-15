import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { CAPABILITY, requireActor, requireCapability } from './orderq-v7-contracts.js?v=0.8.0';
import {
  QUICK_PRODUCT_EVENT,
  QUICK_PRODUCT_STATUS,
  isTemporaryProductId,
  normalizeMasterLinkCommand,
  normalizeMasterUnlinkCommand,
  normalizeQuickProductDraft
} from './quick-product.js?v=0.8.0';

const STORES = Object.freeze([STORE.PRODUCTS, STORE.MAPPING_EVENTS, STORE.SYNC_QUEUE]);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requestAll(source, query = undefined) {
  return requestToPromise(source.getAll(query));
}

function queueLocal(tx, entityType, entityId, payload, revision = 1, baseRevision = 0) {
  const timestamp = nowIso();
  const row = {
    queueId: newId('SQ'), entityType, entityId, operation: 'UPSERT', revision, baseRevision,
    payload: clone(payload), status: 'LOCAL_ONLY', localOnly: true, createdAt: timestamp, updatedAt: timestamp
  };
  tx.objectStore(STORE.SYNC_QUEUE).add(row);
  return row;
}

function eventRow({ eventType, product, masterProductId = '', actorId, reason, before = null, after = null, timestamp }) {
  return {
    eventId: newId('ME'), eventType, productId: product.productId,
    masterProductId: text(masterProductId), actorId, reason,
    revision: Number(product.revision || 0), before: clone(before), after: clone(after),
    createdAt: timestamp, localOnly: true
  };
}

function quickSnapshot(product = {}) {
  return {
    registrationStatus: product.registrationStatus || QUICK_PRODUCT_STATUS.UNLINKED,
    masterProductId: text(product.masterProductId),
    masterItemCode: text(product.masterItemCode),
    masterItemName: text(product.masterItemName)
  };
}

export async function listQuickProducts() {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.PRODUCTS, 'readonly');
  const rows = await requestAll(tx.objectStore(STORE.PRODUCTS));
  await transactionDone(tx);
  return rows.filter(row => isTemporaryProductId(row.productId) && row.productIdentityType === 'TEMPORARY')
    .sort((left, right) => text(right.updatedAt).localeCompare(text(left.updatedAt)));
}

export async function loadQuickProduct(quickProductId) {
  const id = text(quickProductId);
  if (!isTemporaryProductId(id)) throw new Error('ORDERQ_QUICK_PRODUCT_ID_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.PRODUCTS, STORE.MAPPING_EVENTS], 'readonly');
  const [product, events] = await Promise.all([
    requestToPromise(tx.objectStore(STORE.PRODUCTS).get(id)),
    requestAll(tx.objectStore(STORE.MAPPING_EVENTS).index('byProductId'), id)
  ]);
  await transactionDone(tx);
  if (!product || product.productIdentityType !== 'TEMPORARY') throw new Error('ORDERQ_QUICK_PRODUCT_NOT_FOUND');
  return {
    product,
    events: events.filter(row => Object.values(QUICK_PRODUCT_EVENT).includes(row.eventType))
      .sort((left, right) => text(left.createdAt).localeCompare(text(right.createdAt))
        || Number(left.revision || 0) - Number(right.revision || 0)
        || text(left.eventId).localeCompare(text(right.eventId)))
  };
}

export async function createQuickProduct(source = {}, actor = 'ADMIN') {
  const context = requireActor(actor);
  const draft = normalizeQuickProductDraft(source);
  if (draft.boxQuantity !== null && (!Number.isFinite(draft.boxQuantity) || draft.boxQuantity < 0)) {
    throw new Error('ORDERQ_QUICK_PRODUCT_BOX_QUANTITY_INVALID');
  }
  const db = await openOrderQDb();
  const tx = db.transaction(STORES, 'readwrite');
  try {
    const timestamp = nowIso();
    const product = {
      ...draft,
      productId: newId('TMP'),
      productIdentityType: 'TEMPORARY',
      registrationStatus: QUICK_PRODUCT_STATUS.UNLINKED,
      masterProductId: '', masterItemCode: '', masterItemName: '',
      source: 'ORDERQ_QUICK', status: 'ACTIVE', active: true,
      revision: 1, baseRevision: 0,
      createdAt: timestamp, createdBy: context.actorId, updatedAt: timestamp, updatedBy: context.actorId,
      localOnly: true
    };
    const event = eventRow({
      eventType: QUICK_PRODUCT_EVENT.CREATED, product, actorId: context.actorId,
      reason: draft.reason, after: quickSnapshot(product), timestamp
    });
    tx.objectStore(STORE.PRODUCTS).add(product);
    tx.objectStore(STORE.MAPPING_EVENTS).add(event);
    queueLocal(tx, 'PRODUCT', product.productId, product, 1, 0);
    queueLocal(tx, 'MAPPING_EVENT', event.eventId, event, 1, 0);
    await transactionDone(tx);
    return { product, event };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function linkQuickProductToMaster(source = {}, actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.MASTER_LINK);
  const command = normalizeMasterLinkCommand(source);
  const db = await openOrderQDb();
  const tx = db.transaction(STORES, 'readwrite');
  try {
    const store = tx.objectStore(STORE.PRODUCTS);
    const quick = await requestToPromise(store.get(command.quickProductId));
    if (!quick || quick.productIdentityType !== 'TEMPORARY') throw new Error('ORDERQ_QUICK_PRODUCT_NOT_FOUND');
    if (Number(quick.revision || 0) !== command.expectedRevision) throw new Error(`ORDERQ_QUICK_PRODUCT_REVISION_CONFLICT:${quick.revision}`);
    if (quick.registrationStatus !== QUICK_PRODUCT_STATUS.UNLINKED || text(quick.masterProductId)) {
      throw new Error('ORDERQ_QUICK_PRODUCT_ALREADY_LINKED');
    }
    let master = await requestToPromise(store.get(command.masterProduct.productId));
    if (master && (isTemporaryProductId(master.productId) || master.productIdentityType === 'TEMPORARY')) {
      throw new Error('ORDERQ_QUICK_PRODUCT_MASTER_ID_INVALID');
    }
    const timestamp = nowIso();
    let masterCreated = false;
    if (!master) {
      masterCreated = true;
      master = {
        ...command.masterProduct,
        productIdentityType: 'MASTER_REFERENCE', registrationStatus: 'MASTER',
        status: 'ACTIVE', active: true, revision: 1, baseRevision: 0,
        createdAt: timestamp, createdBy: context.actorId, updatedAt: timestamp, updatedBy: context.actorId,
        localOnly: true
      };
      store.add(master);
      queueLocal(tx, 'PRODUCT', master.productId, master, 1, 0);
    }
    if (master.active === false || text(master.status).toUpperCase() === 'INACTIVE') throw new Error('ORDERQ_QUICK_PRODUCT_MASTER_INACTIVE');
    const before = quickSnapshot(quick);
    const next = {
      ...quick,
      registrationStatus: QUICK_PRODUCT_STATUS.LINKED,
      masterProductId: master.productId,
      masterItemCode: text(master.itemCode ?? master.productCode),
      masterItemName: text(master.itemName || master.productName),
      linkedAt: timestamp, linkedBy: context.actorId, linkReason: command.reason,
      revision: Number(quick.revision || 0) + 1, baseRevision: Number(quick.revision || 0),
      updatedAt: timestamp, updatedBy: context.actorId
    };
    const event = eventRow({
      eventType: QUICK_PRODUCT_EVENT.MASTER_LINKED, product: next, masterProductId: master.productId,
      actorId: context.actorId, reason: command.reason, before, after: quickSnapshot(next), timestamp
    });
    store.put(next);
    tx.objectStore(STORE.MAPPING_EVENTS).add(event);
    queueLocal(tx, 'PRODUCT', next.productId, next, next.revision, quick.revision);
    queueLocal(tx, 'MAPPING_EVENT', event.eventId, event, 1, 0);
    await transactionDone(tx);
    return { product: next, masterProduct: master, masterCreated, event };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function unlinkQuickProductFromMaster(source = {}, actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.MASTER_LINK);
  const command = normalizeMasterUnlinkCommand(source);
  const db = await openOrderQDb();
  const tx = db.transaction(STORES, 'readwrite');
  try {
    const store = tx.objectStore(STORE.PRODUCTS);
    const quick = await requestToPromise(store.get(command.quickProductId));
    if (!quick || quick.productIdentityType !== 'TEMPORARY') throw new Error('ORDERQ_QUICK_PRODUCT_NOT_FOUND');
    if (Number(quick.revision || 0) !== command.expectedRevision) throw new Error(`ORDERQ_QUICK_PRODUCT_REVISION_CONFLICT:${quick.revision}`);
    if (quick.registrationStatus !== QUICK_PRODUCT_STATUS.LINKED || !text(quick.masterProductId)) {
      throw new Error('ORDERQ_QUICK_PRODUCT_NOT_LINKED');
    }
    const timestamp = nowIso();
    const before = quickSnapshot(quick);
    const priorMasterProductId = quick.masterProductId;
    const next = {
      ...quick,
      registrationStatus: QUICK_PRODUCT_STATUS.UNLINKED,
      masterProductId: '', masterItemCode: '', masterItemName: '',
      lastMasterProductId: priorMasterProductId,
      linkedAt: '', linkedBy: '', linkReason: '',
      unlinkedAt: timestamp, unlinkedBy: context.actorId, unlinkReason: command.reason,
      revision: Number(quick.revision || 0) + 1, baseRevision: Number(quick.revision || 0),
      updatedAt: timestamp, updatedBy: context.actorId
    };
    const event = eventRow({
      eventType: QUICK_PRODUCT_EVENT.MASTER_UNLINKED, product: next, masterProductId: priorMasterProductId,
      actorId: context.actorId, reason: command.reason, before, after: quickSnapshot(next), timestamp
    });
    store.put(next);
    tx.objectStore(STORE.MAPPING_EVENTS).add(event);
    queueLocal(tx, 'PRODUCT', next.productId, next, next.revision, quick.revision);
    queueLocal(tx, 'MAPPING_EVENT', event.eventId, event, 1, 0);
    await transactionDone(tx);
    return { product: next, event };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}
