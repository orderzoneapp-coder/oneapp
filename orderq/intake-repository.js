import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.11.0';
import { requireActor } from './orderq-v7-contracts.js?v=0.8.0';
import {
  INTAKE_CONTRACT_VERSION,
  INTAKE_REVIEW_STATUS,
  INTAKE_SESSION_STATUS,
  INTAKE_STAGE,
  PRODUCT_IDENTITY_STATUS
} from './orderq-v8-contracts.js?v=0.11.0';
import { canonicalStringify } from './intake-identity.js?v=0.11.0';

const SESSION_STATUS = new Set(Object.values(INTAKE_SESSION_STATUS));
const STAGES = Object.values(INTAKE_STAGE);
const REVIEW_STATUS = new Set(Object.values(INTAKE_REVIEW_STATUS));
const PRODUCT_IDENTITY = new Set(Object.values(PRODUCT_IDENTITY_STATUS));
const MATCH_STATUS = new Set(['MATCHED', 'MATCH_FAILED', 'EXCLUDED', 'CANCELLED']);

function text(value) {
  return value === undefined || value === null ? '' : String(value).normalize('NFKC').trim();
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function actorContext(actor) {
  return requireActor(typeof actor === 'string' ? actor : actor?.actorId || actor);
}

function audit(actor, timestamp = nowIso()) {
  const context = actorContext(actor);
  return { createdBy: context.actorId, createdAt: timestamp, updatedBy: context.actorId, updatedAt: timestamp };
}

function eventRecord(actor, input = {}, timestamp = nowIso()) {
  const context = actorContext(actor);
  return {
    eventId: newId('IEV'),
    intakeSessionId: text(input.intakeSessionId),
    intakeDocumentId: text(input.intakeDocumentId),
    intakeLineId: text(input.intakeLineId),
    eventType: text(input.eventType) || 'INTAKE_CHANGED',
    before: clone(input.before ?? null),
    after: clone(input.after ?? null),
    reasonCode: text(input.reasonCode),
    actorId: context.actorId,
    occurredAt: timestamp
  };
}

function normalizeSession(command, actor, timestamp) {
  const sourceOccurrenceKey = text(command.sourceOccurrenceKey);
  const rawFingerprint = text(command.rawFingerprint);
  if (!sourceOccurrenceKey) throw new Error('ORDERQ_INTAKE_SOURCE_OCCURRENCE_KEY_REQUIRED');
  if (!rawFingerprint) throw new Error('ORDERQ_INTAKE_RAW_FINGERPRINT_REQUIRED');
  const status = text(command.status || INTAKE_SESSION_STATUS.ACTIVE).toUpperCase();
  const stage = text(command.stage || INTAKE_STAGE.CAPTURED).toUpperCase();
  if (!SESSION_STATUS.has(status)) throw new Error(`ORDERQ_INTAKE_SESSION_STATUS_INVALID:${status}`);
  if (!STAGES.includes(stage)) throw new Error(`ORDERQ_INTAKE_STAGE_INVALID:${stage}`);
  return {
    intakeSessionId: text(command.intakeSessionId) || newId('INTAKE'),
    documentType: text(command.documentType || 'ORDER').toUpperCase(),
    sourceMode: text(command.sourceMode),
    sourceType: text(command.sourceType),
    sourceId: text(command.sourceId),
    sourceOccurrenceKey,
    captureOccurrenceId: text(command.captureOccurrenceId),
    rawFingerprint,
    stage,
    status,
    revision: 1,
    intakeContractVersion: INTAKE_CONTRACT_VERSION,
    ...audit(actor, timestamp)
  };
}

function normalizeLine(input, document, actor, timestamp, previous = null) {
  const reviewStatus = text(input.reviewStatus || previous?.reviewStatus || INTAKE_REVIEW_STATUS.PENDING).toUpperCase();
  const productIdentityStatus = text(input.productIdentityStatus || previous?.productIdentityStatus || PRODUCT_IDENTITY_STATUS.UNRESOLVED).toUpperCase();
  const matchStatus = text(input.matchStatus || previous?.matchStatus || 'MATCH_FAILED').toUpperCase();
  if (!REVIEW_STATUS.has(reviewStatus)) throw new Error(`ORDERQ_INTAKE_REVIEW_STATUS_INVALID:${reviewStatus}`);
  if (!PRODUCT_IDENTITY.has(productIdentityStatus)) throw new Error(`ORDERQ_INTAKE_PRODUCT_IDENTITY_INVALID:${productIdentityStatus}`);
  if (!MATCH_STATUS.has(matchStatus)) throw new Error(`ORDERQ_INTAKE_MATCH_STATUS_INVALID:${matchStatus}`);
  const productId = text(input.productId ?? previous?.productId) || null;
  const itemCode = text(input.itemCode ?? previous?.itemCode);
  const itemName = text(input.itemName ?? previous?.itemName);
  if (productIdentityStatus === PRODUCT_IDENTITY_STATUS.TEMPORARY_CONFIRMED) {
    if (!itemName) throw new Error('ORDERQ_INTAKE_TEMPORARY_NAME_REQUIRED');
    if (productId || itemCode) throw new Error('ORDERQ_INTAKE_TEMPORARY_MASTER_IDENTITY_FORBIDDEN');
    if (reviewStatus !== INTAKE_REVIEW_STATUS.CONFIRMED) throw new Error('ORDERQ_INTAKE_TEMPORARY_REVIEW_REQUIRED');
  }
  return {
    intakeLineId: text(input.intakeLineId) || previous?.intakeLineId || newId('ILN'),
    intakeSessionId: document.intakeSessionId,
    intakeDocumentId: document.intakeDocumentId,
    sourcePartId: text(input.sourcePartId ?? previous?.sourcePartId),
    sourceRange: clone(input.sourceRange ?? previous?.sourceRange ?? null),
    sourceLineKey: text(input.sourceLineKey ?? previous?.sourceLineKey),
    rawExpression: text(input.rawExpression ?? previous?.rawExpression),
    productText: text(input.productText ?? previous?.productText),
    specification: text(input.specification ?? previous?.specification),
    quantity: input.quantity ?? previous?.quantity ?? null,
    unit: text(input.unit ?? previous?.unit),
    unitPrice: input.unitPrice ?? previous?.unitPrice ?? null,
    candidateProducts: clone(input.candidateProducts ?? previous?.candidateProducts ?? []),
    recommendedProductId: text(input.recommendedProductId ?? previous?.recommendedProductId),
    productId,
    itemCode,
    itemName,
    matchStatus,
    reviewStatus,
    productIdentityStatus,
    reviewReasonCodes: clone(input.reviewReasonCodes ?? previous?.reviewReasonCodes ?? []),
    revision: Number(previous?.revision || 0) + 1,
    createdBy: previous?.createdBy || actorContext(actor).actorId,
    createdAt: previous?.createdAt || timestamp,
    updatedBy: actorContext(actor).actorId,
    updatedAt: timestamp
  };
}

function assertDocumentReady(lines) {
  const active = lines.filter(line => line.reviewStatus !== INTAKE_REVIEW_STATUS.EXCLUDED && line.matchStatus !== 'EXCLUDED');
  if (!active.length || active.some(line => line.reviewStatus !== INTAKE_REVIEW_STATUS.CONFIRMED
    || ![PRODUCT_IDENTITY_STATUS.MASTER_LINKED, PRODUCT_IDENTITY_STATUS.TEMPORARY_CONFIRMED].includes(line.productIdentityStatus))) {
    throw new Error('ORDERQ_INTAKE_REVIEW_INCOMPLETE');
  }
}

async function readBundleWithTransaction(tx, intakeSessionId) {
  const sessions = tx.objectStore(STORE.INTAKE_SESSIONS);
  const sourceParts = tx.objectStore(STORE.INTAKE_SOURCE_PARTS);
  const documents = tx.objectStore(STORE.INTAKE_DOCUMENTS);
  const lines = tx.objectStore(STORE.INTAKE_LINES);
  const events = tx.objectStore(STORE.INTAKE_EVENTS);
  const session = await requestToPromise(sessions.get(intakeSessionId));
  if (!session) return null;
  const [partRows, documentRows, eventRows] = await Promise.all([
    requestToPromise(sourceParts.index('bySession').getAll(intakeSessionId)),
    requestToPromise(documents.index('bySession').getAll(intakeSessionId)),
    requestToPromise(events.index('bySession').getAll(intakeSessionId))
  ]);
  const lineRows = [];
  for (const document of documentRows) {
    lineRows.push(...await requestToPromise(lines.index('byDocument').getAll(document.intakeDocumentId)));
  }
  return { session, sourceParts: partRows, documents: documentRows, lines: lineRows, events: eventRows };
}

export async function createOrOpenIntakeSession(command) {
  const actor = command.actor;
  const timestamp = nowIso();
  const next = normalizeSession(command, actor, timestamp);
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.INTAKE_SESSIONS, STORE.INTAKE_EVENTS], 'readwrite');
  try {
    const sessionStore = tx.objectStore(STORE.INTAKE_SESSIONS);
    const existing = await requestToPromise(sessionStore.index('bySourceOccurrenceKey').get(next.sourceOccurrenceKey));
    if (existing) {
      if (existing.rawFingerprint !== next.rawFingerprint) throw new Error('ORDERQ_INTAKE_OCCURRENCE_CONTENT_CONFLICT');
      await transactionDone(tx);
      return { session: existing, duplicate: true };
    }
    await requestToPromise(sessionStore.add(next));
    const event = eventRecord(actor, {
      intakeSessionId: next.intakeSessionId,
      eventType: 'INTAKE_SESSION_CREATED',
      after: next,
      reasonCode: 'SOURCE_OCCURRENCE_CAPTURED'
    }, timestamp);
    await requestToPromise(tx.objectStore(STORE.INTAKE_EVENTS).add(event));
    await transactionDone(tx);
    return { session: next, event, duplicate: false };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function appendIntakeSourcePart(command) {
  const actor = command.actor;
  const timestamp = nowIso();
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.INTAKE_SESSIONS, STORE.INTAKE_SOURCE_PARTS, STORE.INTAKE_EVENTS], 'readwrite');
  try {
    const session = await requestToPromise(tx.objectStore(STORE.INTAKE_SESSIONS).get(text(command.intakeSessionId)));
    if (!session) throw new Error('ORDERQ_INTAKE_SESSION_NOT_FOUND');
    const part = {
      sourcePartId: text(command.sourcePartId) || newId('ISP'),
      intakeSessionId: session.intakeSessionId,
      partType: text(command.partType || 'TEXT').toUpperCase(),
      contextIndex: Number(command.contextIndex || 0),
      rawText: text(command.rawText),
      mimeType: text(command.mimeType),
      binaryBase64: text(command.binaryBase64),
      byteLength: Number(command.byteLength || 0),
      contentHash: text(command.contentHash),
      ocrText: text(command.ocrText),
      sourceMessageKey: text(command.sourceMessageKey),
      senderRaw: text(command.senderRaw),
      timestampRaw: text(command.timestampRaw),
      ...audit(actor, timestamp)
    };
    await requestToPromise(tx.objectStore(STORE.INTAKE_SOURCE_PARTS).add(part));
    const event = eventRecord(actor, {
      intakeSessionId: session.intakeSessionId,
      eventType: 'INTAKE_SOURCE_PART_ADDED',
      after: { sourcePartId: part.sourcePartId, contentHash: part.contentHash },
      reasonCode: 'SOURCE_PART_PRESERVED'
    }, timestamp);
    await requestToPromise(tx.objectStore(STORE.INTAKE_EVENTS).add(event));
    await transactionDone(tx);
    return { part, event };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function createIntakeDocument(command) {
  const actor = command.actor;
  const timestamp = nowIso();
  const sourceDocumentKey = text(command.sourceDocumentKey);
  if (!sourceDocumentKey) throw new Error('ORDERQ_INTAKE_SOURCE_DOCUMENT_KEY_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.INTAKE_SESSIONS, STORE.INTAKE_DOCUMENTS, STORE.INTAKE_EVENTS], 'readwrite');
  try {
    const documentStore = tx.objectStore(STORE.INTAKE_DOCUMENTS);
    const existing = await requestToPromise(documentStore.index('bySourceDocumentKey').get(sourceDocumentKey));
    if (existing) {
      const sameFact = existing.intakeSessionId === text(command.intakeSessionId)
        && existing.documentType === text(command.documentType || 'ORDER').toUpperCase();
      if (!sameFact) throw new Error('ORDERQ_INTAKE_DOCUMENT_IDEMPOTENCY_CONFLICT');
      await transactionDone(tx);
      return { document: existing, duplicate: true };
    }
    const session = await requestToPromise(tx.objectStore(STORE.INTAKE_SESSIONS).get(text(command.intakeSessionId)));
    if (!session) throw new Error('ORDERQ_INTAKE_SESSION_NOT_FOUND');
    const document = {
      intakeDocumentId: text(command.intakeDocumentId) || newId('IDOC'),
      intakeSessionId: session.intakeSessionId,
      documentType: text(command.documentType || session.documentType || 'ORDER').toUpperCase(),
      sourceDocumentKey,
      sourceMessageKeys: clone(command.sourceMessageKeys || []),
      documentIndex: Number(command.documentIndex || 0),
      segmentationVersion: text(command.segmentationVersion),
      senderEvidence: clone(command.senderEvidence || []),
      customerCandidate: clone(command.customerCandidate || null),
      confirmedCustomerId: text(command.confirmedCustomerId),
      confirmedCustomerName: text(command.confirmedCustomerName),
      headerDraft: clone(command.headerDraft || {}),
      stage: text(command.stage || INTAKE_STAGE.CAPTURED).toUpperCase(),
      reviewStatus: text(command.reviewStatus || INTAKE_REVIEW_STATUS.PENDING).toUpperCase(),
      orderId: '',
      revision: 1,
      intakeContractVersion: INTAKE_CONTRACT_VERSION,
      ...audit(actor, timestamp)
    };
    await requestToPromise(documentStore.add(document));
    const event = eventRecord(actor, {
      intakeSessionId: session.intakeSessionId,
      intakeDocumentId: document.intakeDocumentId,
      eventType: 'INTAKE_DOCUMENT_CREATED',
      after: document,
      reasonCode: 'DOCUMENT_FIXTURE_CREATED'
    }, timestamp);
    await requestToPromise(tx.objectStore(STORE.INTAKE_EVENTS).add(event));
    await transactionDone(tx);
    return { document, event, duplicate: false };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function replaceIntakeLines(command) {
  const actor = command.actor;
  const timestamp = nowIso();
  const documentId = text(command.intakeDocumentId);
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.INTAKE_DOCUMENTS, STORE.INTAKE_LINES, STORE.INTAKE_EVENTS], 'readwrite');
  try {
    const documentStore = tx.objectStore(STORE.INTAKE_DOCUMENTS);
    const lineStore = tx.objectStore(STORE.INTAKE_LINES);
    const document = await requestToPromise(documentStore.get(documentId));
    if (!document) throw new Error('ORDERQ_INTAKE_DOCUMENT_NOT_FOUND');
    if (Number(document.revision || 0) !== Number(command.expectedRevision || 0)) throw new Error('ORDERQ_INTAKE_REVISION_CONFLICT');
    const previousLines = await requestToPromise(lineStore.index('byDocument').getAll(documentId));
    const previousById = new Map(previousLines.map(line => [line.intakeLineId, line]));
    const lines = (command.lines || []).map(input => normalizeLine(input, document, actor, timestamp, previousById.get(text(input.intakeLineId))));
    if (command.nextStage === INTAKE_STAGE.DOCUMENT_REVIEW || command.nextStage === INTAKE_STAGE.COMMITTED) assertDocumentReady(lines);
    previousLines.forEach(line => lineStore.delete(line.intakeLineId));
    lines.forEach(line => lineStore.put(line));
    if (command.injectFailureAt === 'LINES_WRITTEN') throw new Error('ORDERQ_INTAKE_INJECTED_FAILURE:LINES_WRITTEN');
    const nextDocument = {
      ...document,
      stage: text(command.nextStage || document.stage).toUpperCase(),
      revision: Number(document.revision || 0) + 1,
      updatedBy: actorContext(actor).actorId,
      updatedAt: timestamp
    };
    documentStore.put(nextDocument);
    const event = eventRecord(actor, {
      intakeSessionId: document.intakeSessionId,
      intakeDocumentId: documentId,
      eventType: 'INTAKE_LINES_REPLACED',
      before: previousLines,
      after: lines,
      reasonCode: text(command.reasonCode || 'ADMIN_REVIEW')
    }, timestamp);
    await requestToPromise(tx.objectStore(STORE.INTAKE_EVENTS).add(event));
    await transactionDone(tx);
    return { document: nextDocument, lines, event };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function updateIntakeLine(command) {
  const actor = command.actor;
  const timestamp = nowIso();
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.INTAKE_DOCUMENTS, STORE.INTAKE_LINES, STORE.INTAKE_EVENTS], 'readwrite');
  try {
    const lineStore = tx.objectStore(STORE.INTAKE_LINES);
    const existing = await requestToPromise(lineStore.get(text(command.intakeLineId)));
    if (!existing) throw new Error('ORDERQ_INTAKE_LINE_NOT_FOUND');
    if (Number(existing.revision || 0) !== Number(command.expectedRevision || 0)) throw new Error('ORDERQ_INTAKE_REVISION_CONFLICT');
    const document = await requestToPromise(tx.objectStore(STORE.INTAKE_DOCUMENTS).get(existing.intakeDocumentId));
    const next = normalizeLine({ ...existing, ...(command.patch || {}), intakeLineId: existing.intakeLineId }, document, actor, timestamp, existing);
    lineStore.put(next);
    const event = eventRecord(actor, {
      intakeSessionId: existing.intakeSessionId,
      intakeDocumentId: existing.intakeDocumentId,
      intakeLineId: existing.intakeLineId,
      eventType: 'INTAKE_LINE_UPDATED',
      before: existing,
      after: next,
      reasonCode: text(command.reasonCode || 'ADMIN_EDIT')
    }, timestamp);
    await requestToPromise(tx.objectStore(STORE.INTAKE_EVENTS).add(event));
    await transactionDone(tx);
    return { line: next, event };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function appendIntakeEvent(input) {
  const event = eventRecord(input.actor, input, nowIso());
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.INTAKE_EVENTS, 'readwrite');
  try {
    await requestToPromise(tx.objectStore(STORE.INTAKE_EVENTS).add(event));
    await transactionDone(tx);
    return event;
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function getIntakeSessionBundle(intakeSessionId) {
  const db = await openOrderQDb();
  const stores = [STORE.INTAKE_SESSIONS, STORE.INTAKE_SOURCE_PARTS, STORE.INTAKE_DOCUMENTS, STORE.INTAKE_LINES, STORE.INTAKE_EVENTS];
  const tx = db.transaction(stores, 'readonly');
  const bundle = await readBundleWithTransaction(tx, text(intakeSessionId));
  await transactionDone(tx);
  return bundle;
}

export async function findIntakeDocumentBySourceDocumentKey(sourceDocumentKey) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.INTAKE_DOCUMENTS, 'readonly');
  const document = await requestToPromise(tx.objectStore(STORE.INTAKE_DOCUMENTS).index('bySourceDocumentKey').get(text(sourceDocumentKey)));
  await transactionDone(tx);
  return document || null;
}

export function intakeBundleCanonicalDigest(bundle) {
  return canonicalStringify(bundle);
}
