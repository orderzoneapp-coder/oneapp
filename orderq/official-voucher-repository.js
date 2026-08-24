import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.17.0';
import { requireActor } from './orderq-v7-contracts.js?v=0.8.0';
import { appendInventoryMovementsInTransaction } from './inventory-ledger-repository.js?v=0.17.0';
import { assertOfficialCommandAuthority } from './official-command-policy.js?v=0.17.0';
import { runCentralOfficialCommand } from './central-command-gateway.js?v=0.17.0';
import { calculateOfficialDocumentAmount, planOfficialVoucherCommand, voucherStableId } from './official-voucher-core.js?v=0.17.0';

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function storesFor(kind) {
  return kind === 'PURCHASE'
    ? { document: STORE.PURCHASE_DOCUMENTS, lines: STORE.PURCHASE_LINES, idField: 'purchaseDocumentId', entry: STORE.PAYABLE_ENTRIES }
    : { document: STORE.SALES_DOCUMENTS, lines: STORE.SALES_LINES, idField: 'salesDocumentId', entry: STORE.RECEIVABLE_ENTRIES };
}

async function allByIndex(store, indexName, key) {
  return requestToPromise(store.index(indexName).getAll(key));
}

export async function saveOfficialVoucherDraft(source = {}, actor = 'ADMIN') {
  const context = requireActor(actor);
  const kind = text(source.kind).toUpperCase();
  if (!['PURCHASE', 'SALE'].includes(kind)) throw new Error('ORDERQ_OFFICIAL_DRAFT_KIND_INVALID');
  const contract = storesFor(kind);
  const timestamp = nowIso();
  const sourceType = text(source.sourceType).toUpperCase() || 'IMPORT';
  const sourceDocumentKey = text(source.sourceDocumentKey);
  if (!sourceDocumentKey) throw new Error('ORDERQ_OFFICIAL_SOURCE_DOCUMENT_KEY_REQUIRED');
  const id = text(source[contract.idField]) || voucherStableId(kind === 'PURCHASE' ? 'PD' : 'SD', 'VOUCHER_CORE_V1', sourceType, sourceDocumentKey);
  const draftDocument = {
    ...source,
    [contract.idField]: id,
    status: 'DRAFT',
    businessStatus: 'DRAFT',
    projectionStatus: 'LOCAL_PROJECTED',
    documentContract: 'VOUCHER_CORE_V1',
    sourceDocumentKey,
    revision: 1,
    sourceType,
    localOnly: true,
    createdAt: source.createdAt || timestamp,
    createdBy: source.createdBy || context.actorId,
    updatedAt: timestamp,
    updatedBy: context.actorId
  };
  const rawLines = Array.isArray(source.lines) ? source.lines : [];
  if (!rawLines.length) throw new Error('ORDERQ_OFFICIAL_LINES_REQUIRED');
  const amount = calculateOfficialDocumentAmount(rawLines);
  draftDocument.supplyAmount = amount.supplyAmount;
  draftDocument.totalAmount = amount.totalAmount;
  draftDocument.vatAmount = null;
  draftDocument.taxType = 'VAT_INCLUDED_IN_SUPPLY';
  draftDocument.currency = 'KRW';
  const lineIdField = kind === 'PURCHASE' ? 'purchaseLineId' : 'salesLineId';
  const lines = amount.lines.map((line, index) => {
    const sourceLineKey = text(line.sourceLineKey) || String(index + 1);
    const lineIdentityId = text(line.lineIdentityId) || voucherStableId('LI', id, sourceLineKey);
    return ({
    ...line,
    actualQuantity: Number(line.actualQuantity ?? line.quantity),
    sourceLineKey,
    lineIdentityId,
    [lineIdField]: text(line[lineIdField]) || voucherStableId(kind === 'PURCHASE' ? 'PL' : 'SL', id, lineIdentityId),
    [contract.idField]: id,
    status: 'DRAFT',
    revision: 1,
    lineSequence: Number(line.lineSequence || index + 1),
    localOnly: true,
    createdAt: line.createdAt || timestamp,
    createdBy: line.createdBy || context.actorId,
    updatedAt: timestamp,
    updatedBy: context.actorId
  }); });
  const db = await openOrderQDb();
  const tx = db.transaction([contract.document, contract.lines], 'readwrite');
  try {
    const documentStore = tx.objectStore(contract.document);
    if (await requestToPromise(documentStore.get(id))) throw new Error(`ORDERQ_OFFICIAL_DRAFT_EXISTS:${id}`);
    documentStore.add(draftDocument);
    lines.forEach(line => tx.objectStore(contract.lines).add(line));
    await transactionDone(tx);
    return { document: draftDocument, lines };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function applyOfficialVoucherCommand(source = {}) {
  const commandType = text(source.commandType).toUpperCase();
  assertOfficialCommandAuthority(commandType);
  const kind = commandType.endsWith('PURCHASE') ? 'PURCHASE' : 'SALE';
  const contract = storesFor(kind);
  const aggregateId = text(source.aggregateId || source[contract.idField]);
  if (!aggregateId) throw new Error('ORDERQ_OFFICIAL_AGGREGATE_ID_REQUIRED');
  const actor = requireActor(source.actor);
  const storeNames = [
    contract.document, contract.lines, contract.entry,
    STORE.VOUCHER_EVENTS, STORE.INVENTORY_MOVEMENTS, STORE.META, STORE.SYNC_QUEUE
  ];
  if (kind === 'SALE') storeNames.push(STORE.ORDER_EVENTS);
  if (kind === 'SALE' && text(source.sourceType || source.document?.sourceType || '').toUpperCase() === 'ORDER_Q') {
    storeNames.push(STORE.ORDERS, STORE.ORDER_ITEMS);
  }
  const db = await openOrderQDb();
  const tx = db.transaction(storeNames, 'readwrite');
  try {
    const eventStore = tx.objectStore(STORE.VOUCHER_EVENTS);
    const duplicate = await requestToPromise(eventStore.index('byIdempotencyKey').get(text(source.idempotencyKey)));
    if (duplicate) {
      const document = await requestToPromise(tx.objectStore(contract.document).get(aggregateId));
      const lines = await allByIndex(tx.objectStore(contract.lines), 'byDocumentId', aggregateId);
      await transactionDone(tx);
      return { duplicate: true, document, lines, voucherEvent: duplicate };
    }
    const document = await requestToPromise(tx.objectStore(contract.document).get(aggregateId));
    if (!document) throw new Error(`ORDERQ_OFFICIAL_DOCUMENT_NOT_FOUND:${aggregateId}`);
    const storedLines = await allByIndex(tx.objectStore(contract.lines), 'byDocumentId', aggregateId);
    const storedMovements = (await requestToPromise(tx.objectStore(STORE.INVENTORY_MOVEMENTS).getAll()))
      .filter(row => text(row.sourceDocumentId) === aggregateId);
    const storedEntries = (await requestToPromise(tx.objectStore(contract.entry).getAll()))
      .filter(entry => text(entry[contract.idField]) === aggregateId);
    const storedOrderEvents = kind === 'SALE' ? await requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).getAll()) : [];
    const activeLines = storedLines.filter(line => text(line.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED' && text(line.status).toUpperCase() !== 'REVERSED');
    const plan = planOfficialVoucherCommand({ command: { ...source, actor: actor.actorId }, document, lines: activeLines, snapshotLines: storedLines, movements: storedMovements, entries: storedEntries, orderEvents: storedOrderEvents });
    const documentStore = tx.objectStore(contract.document);
    const lineStore = tx.objectStore(contract.lines);
    documentStore.put(plan.document);
    const nextIds = new Set(plan.lines.map(line => text(line[kind === 'PURCHASE' ? 'purchaseLineId' : 'salesLineId'])));
    storedLines.forEach(line => {
      const id = text(line[kind === 'PURCHASE' ? 'purchaseLineId' : 'salesLineId']);
      const reversingCurrentLine = plan.document.status === 'REVERSED' && text(line.status).toUpperCase() !== 'REVERSED';
      const deletingActiveLine = !nextIds.has(id) && text(line.lineStatus || 'ACTIVE').toUpperCase() !== 'DELETED' && text(line.status).toUpperCase() !== 'REVERSED';
      if (reversingCurrentLine || deletingActiveLine) {
        lineStore.put({
          ...line,
          status: plan.document.status === 'REVERSED' ? 'REVERSED' : 'CONFIRMED',
          lineStatus: plan.document.status === 'REVERSED' ? line.lineStatus || 'ACTIVE' : 'DELETED',
          deletedRevision: plan.document.status === 'REVERSED' ? line.deletedRevision : plan.document.revision,
          revision: plan.document.revision,
          updatedAt: source.occurredAt,
          updatedBy: actor.actorId
        });
      }
    });
    plan.lines.forEach(line => lineStore.put(line));
    const movementResults = await appendInventoryMovementsInTransaction({ tx, actor, drafts: plan.movements, allocateLedgerSequence: false });
    movementResults.forEach(result => {
      const line = plan.lines.find(candidate => text(candidate[kind === 'PURCHASE' ? 'purchaseLineId' : 'salesLineId']) === text(result.movement.sourceLineId));
      if (line) {
        line.movementId = result.movement.movementId;
        lineStore.put(line);
      }
    });
    const entryStore = tx.objectStore(contract.entry);
    plan.entries.forEach(entry => entryStore.add(entry));
    eventStore.add(plan.voucherEvent);
    if (kind === 'SALE') plan.orderEvents.forEach(event => tx.objectStore(STORE.ORDER_EVENTS).add(event));
    await transactionDone(tx);
    return { ...plan, movements: movementResults.map(result => result.movement), duplicate: false };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function runCentralOfficialVoucherCommand(source = {}) {
  const commandType = text(source.commandType).toUpperCase();
  const kind = commandType.endsWith('PURCHASE') ? 'PURCHASE' : 'SALE';
  const idField = kind === 'PURCHASE' ? 'purchaseDocumentId' : 'salesDocumentId';
  const aggregateId = text(source.aggregateId || source[idField]);
  const command = {
    ...source,
    aggregateId,
    commandType,
    commandContract: 'VOUCHER_CORE_V1'
  };
  return runCentralOfficialCommand(command, () => applyOfficialVoucherCommand(command));
}
