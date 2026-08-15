import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { CAPABILITY, requireCapability } from './orderq-v7-contracts.js?v=0.8.0';
import { normalizedOrderView } from './order-document-model.js?v=0.8.0';
import { assertOfficialCommandAuthority } from './official-command-policy.js?v=0.9.0';
import {
  TRANSFER_EVENT_TYPE,
  createReversalEvent,
  deriveOrderLifecycle,
  effectiveOrderQuantity,
  effectiveTransferredQuantity
} from './order-fulfillment-lifecycle.js?v=0.8.0';
import {
  DISPATCH_APPROVAL_STATUS,
  DISPATCH_APPROVAL_TYPE,
  DISPATCH_CONFIRMATION_STEP,
  confirmationCheckpoint,
  dispatchActualFingerprint,
  dispatchActualSetFingerprint,
  dispatchPriceFingerprint,
  isDispatchApprovalEffectivelyActive
} from './dispatch-confirmation.js?v=0.8.0';

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function allFrom(tx, storeName, indexName = '', query = undefined) {
  const store = tx.objectStore(storeName);
  return requestToPromise((indexName ? store.index(indexName) : store).getAll(query));
}

function queueLocalEntity(tx, { entityType, entityId, payload, revision = 1, baseRevision = 0, idempotencyKey = '' }) {
  const timestamp = nowIso();
  const row = {
    queueId: newId('SQ'), entityType, entityId, operation: 'UPSERT',
    revision: Number(revision || 0), baseRevision: Number(baseRevision || 0),
    payload: clone(payload), status: 'LOCAL_ONLY', localOnly: true,
    confirmationIdempotencyKey: idempotencyKey,
    createdAt: timestamp, updatedAt: timestamp
  };
  tx.objectStore(STORE.SYNC_QUEUE).add(row);
  return row;
}

function historyEvent(eventType, actorId, detail, timestamp) {
  return { eventId: newId('DH'), eventType, actorId, detail: clone(detail), createdAt: timestamp };
}

async function approveLine({ source, actor, capability, approvalType, buildDetail }) {
  const context = requireCapability(actor, capability);
  const dispatchId = text(source.dispatchId);
  const dispatchLineId = text(source.dispatchLineId);
  const expectedRevision = Number(source.expectedRevision);
  const reasonCode = text(source.reasonCode).toUpperCase() || 'MANUAL_OVERRIDE';
  const reasonNote = text(source.reasonNote || source.reason);
  if (!dispatchId || !dispatchLineId || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_APPROVAL_SOURCE_REQUIRED');
  if (!reasonNote) throw new Error('ORDERQ_APPROVAL_REASON_REQUIRED');
  const stores = [
    STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES, STORE.DISPATCH_APPROVALS,
    STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS, STORE.SYNC_QUEUE
  ];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readwrite');
  try {
    const decisionStore = tx.objectStore(STORE.DISPATCH_DECISIONS);
    const decision = await requestToPromise(decisionStore.get(dispatchId));
    if (!decision || decision.status !== 'READY_TO_CONFIRM') throw new Error('ORDERQ_APPROVAL_READY_STATE_REQUIRED');
    if (Number(decision.revision || 0) !== expectedRevision) throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${decision.revision}`);
    const line = await requestToPromise(tx.objectStore(STORE.DISPATCH_LINES).get(dispatchLineId));
    if (!line || line.dispatchId !== dispatchId || !(Number(line.actualRevision || 0) > 0)) throw new Error('ORDERQ_APPROVAL_ACTUAL_LINE_REQUIRED');
    const detail = await buildDetail({ tx, decision, line });
    const approvalId = `DAP-${approvalType}-${dispatchId}-${dispatchLineId}-${line.actualRevision}`;
    const approvalStore = tx.objectStore(STORE.DISPATCH_APPROVALS);
    const existing = await requestToPromise(approvalStore.get(approvalId));
    const approvedActualFingerprint = dispatchActualFingerprint(line);
    if (existing) {
      if (existing.approvedActualFingerprint !== approvedActualFingerprint
        || existing.reasonCode !== reasonCode || existing.reasonNote !== reasonNote) {
        throw new Error(`ORDERQ_APPROVAL_IDEMPOTENCY_CONFLICT:${approvalId}`);
      }
      await transactionDone(tx);
      return { duplicate: true, approval: existing, decision };
    }
    const timestamp = nowIso();
    const nextRevision = Number(decision.revision || 0) + 1;
    const approval = {
      approvalId, approvalType, status: DISPATCH_APPROVAL_STATUS.ACTIVE,
      dispatchId, dispatchLineId, orderId: line.orderId, orderItemId: line.orderItemId,
      requestedProductId: line.requestedProductId, actualProductId: line.actualProductId,
      approvedActualRevision: Number(line.actualRevision), approvedActualFingerprint,
      revision: nextRevision, dispatchRevision: nextRevision,
      reasonCode, reasonNote, reason: reasonNote,
      ...detail,
      approvedAt: timestamp, approvedBy: context.actorId,
      createdAt: timestamp, createdBy: context.actorId, updatedAt: timestamp, updatedBy: context.actorId,
      localOnly: true
    };
    approvalStore.add(approval);
    const nextDecision = {
      ...decision, revision: nextRevision, baseRevision: Number(decision.revision || 0),
      updatedAt: timestamp, updatedBy: context.actorId,
      history: [...(Array.isArray(decision.history) ? decision.history : []), historyEvent(`${approvalType}_APPROVED`, context.actorId, { approvalId, dispatchLineId, reasonCode, reasonNote }, timestamp)]
    };
    decisionStore.put(nextDecision);
    queueLocalEntity(tx, { entityType: 'DISPATCH_APPROVAL', entityId: approvalId, payload: approval, revision: nextRevision, baseRevision: decision.revision });
    queueLocalEntity(tx, { entityType: 'DISPATCH_DECISION', entityId: dispatchId, payload: nextDecision, revision: nextRevision, baseRevision: decision.revision });
    await transactionDone(tx);
    return { duplicate: false, approval, decision: nextDecision };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function approveSubstitution(source = {}, actor = 'ADMIN') {
  assertOfficialCommandAuthority('UPDATE_DISPATCH');
  return approveLine({
    source,
    actor,
    capability: CAPABILITY.SUBSTITUTE_APPROVE,
    approvalType: DISPATCH_APPROVAL_TYPE.SUBSTITUTE,
    buildDetail: async ({ line }) => {
      if (text(line.fulfillmentType).toUpperCase() !== 'SUBSTITUTE' || text(line.requestedProductId) === text(line.actualProductId)) {
        throw new Error('ORDERQ_SUBSTITUTE_APPROVAL_LINE_INVALID');
      }
      return { substitutionReason: text(source.reason) };
    }
  });
}

export async function approveOverDispatch(source = {}, actor = 'ADMIN') {
  assertOfficialCommandAuthority('UPDATE_DISPATCH');
  return approveLine({
    source,
    actor,
    capability: CAPABILITY.OVER_DISPATCH_APPROVE,
    approvalType: DISPATCH_APPROVAL_TYPE.OVER_DISPATCH,
    buildDetail: async ({ tx, line }) => {
      const [orderSource, item, events, dispatchLines] = await Promise.all([
        requestToPromise(tx.objectStore(STORE.ORDERS).get(line.orderId)),
        requestToPromise(tx.objectStore(STORE.ORDER_ITEMS).get(line.orderItemId)),
        allFrom(tx, STORE.ORDER_EVENTS, 'byOrderId', line.orderId),
        allFrom(tx, STORE.DISPATCH_LINES, 'byDispatchId', line.dispatchId)
      ]);
      const order = normalizedOrderView(orderSource);
      if (!orderSource || !item || item.orderId !== line.orderId) throw new Error('ORDERQ_OVER_APPROVAL_ORDER_ITEM_REQUIRED');
      const effectiveQuantity = effectiveOrderQuantity(order, item);
      const currentRecognizedQuantity = effectiveTransferredQuantity(line.orderItemId, events);
      const participatingLines = dispatchLines
        .filter(row => row.orderItemId === line.orderItemId && Number(row.actualRevision || 0) > 0)
        .sort((left, right) => text(left.dispatchLineId).localeCompare(text(right.dispatchLineId)));
      if (!participatingLines.length) throw new Error('ORDERQ_OVER_APPROVAL_ACTUAL_LINE_REQUIRED');
      const attemptedRecognizedQuantity = participatingLines.reduce((sum, row) => sum + finite(row.recognizedOrderQuantity), 0);
      const approvedOverQuantity = currentRecognizedQuantity + attemptedRecognizedQuantity - effectiveQuantity;
      if (!(approvedOverQuantity > 1e-9)) throw new Error('ORDERQ_OVER_APPROVAL_NOT_REQUIRED');
      return {
        effectiveOrderQuantity: effectiveQuantity,
        currentRecognizedQuantity,
        existingRecognizedQuantity: currentRecognizedQuantity,
        attemptedRecognizedQuantity,
        approvedOverQuantity,
        overQuantity: approvedOverQuantity,
        participatingDispatchLineIds: participatingLines.map(row => row.dispatchLineId),
        participatingActualRevisions: participatingLines.map(row => ({
          dispatchLineId: row.dispatchLineId,
          actualRevision: Number(row.actualRevision || 0)
        })),
        approvedActualSetFingerprint: dispatchActualSetFingerprint(participatingLines)
      };
    }
  });
}

export async function recordCustomerNotice(source = {}, actor = 'ADMIN') {
  assertOfficialCommandAuthority('UPDATE_DISPATCH');
  const context = requireCapability(actor, CAPABILITY.DISPATCH_EDIT);
  const dispatchId = text(source.dispatchId);
  const dispatchLineId = text(source.dispatchLineId);
  const expectedRevision = Number(source.expectedRevision);
  const status = text(source.customerNoticeStatus).toUpperCase();
  const memo = text(source.memo);
  if (!dispatchId || !dispatchLineId || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('ORDERQ_NOTICE_SOURCE_REQUIRED');
  if (!['NOTIFIED', 'WAIVED'].includes(status) || !memo) throw new Error('ORDERQ_NOTICE_EVIDENCE_REQUIRED');
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES, STORE.SYNC_QUEUE], 'readwrite');
  try {
    const decisionStore = tx.objectStore(STORE.DISPATCH_DECISIONS);
    const decision = await requestToPromise(decisionStore.get(dispatchId));
    if (!decision || !['RELEASED', 'READY_TO_CONFIRM'].includes(decision.status)) throw new Error('ORDERQ_NOTICE_STATE_INVALID');
    if (Number(decision.revision || 0) !== expectedRevision) throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${decision.revision}`);
    const lineStore = tx.objectStore(STORE.DISPATCH_LINES);
    const line = await requestToPromise(lineStore.get(dispatchLineId));
    if (!line || line.dispatchId !== dispatchId || !line.customerNoticeRequired) throw new Error('ORDERQ_NOTICE_LINE_REQUIRED');
    const timestamp = nowIso();
    const nextRevision = Number(decision.revision || 0) + 1;
    const nextLine = {
      ...line,
      customerNoticeStatus: status,
      customerNotifiedBy: context.actorId,
      customerNotifiedAt: timestamp,
      customerNoticeActorId: context.actorId,
      customerNoticeAt: timestamp,
      customerNoticeMemo: memo,
      customerNoticePriceFingerprint: dispatchPriceFingerprint(line),
      updatedAt: timestamp,
      updatedBy: context.actorId
    };
    const nextDecision = {
      ...decision, revision: nextRevision, baseRevision: Number(decision.revision || 0),
      updatedAt: timestamp, updatedBy: context.actorId,
      history: [...(Array.isArray(decision.history) ? decision.history : []), historyEvent('CUSTOMER_NOTICE_RECORDED', context.actorId, { dispatchLineId, status, memo }, timestamp)]
    };
    lineStore.put(nextLine);
    decisionStore.put(nextDecision);
    queueLocalEntity(tx, { entityType: 'DISPATCH_LINE', entityId: dispatchLineId, payload: nextLine, revision: nextRevision, baseRevision: decision.revision });
    queueLocalEntity(tx, { entityType: 'DISPATCH_DECISION', entityId: dispatchId, payload: nextDecision, revision: nextRevision, baseRevision: decision.revision });
    await transactionDone(tx);
    return { line: nextLine, decision: nextDecision };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

function decisionReversalFingerprint(source, line) {
  return JSON.stringify({
    dispatchId: text(source.dispatchId),
    dispatchLineId: text(source.dispatchLineId),
    expectedRevision: Number(source.expectedRevision),
    idempotencyKey: text(source.idempotencyKey),
    reason: text(source.reason),
    actualFingerprint: dispatchActualFingerprint(line)
  });
}

export async function reverseSubstitutionDecision(source = {}, actor = 'ADMIN', options = {}) {
  assertOfficialCommandAuthority('REVERSE_DISPATCH');
  const context = requireCapability(actor, CAPABILITY.SUBSTITUTE_APPROVE);
  const dispatchId = text(source.dispatchId);
  const dispatchLineId = text(source.dispatchLineId);
  const expectedRevision = Number(source.expectedRevision);
  const idempotencyKey = text(source.idempotencyKey);
  const reason = text(source.reason);
  if (!dispatchId || !dispatchLineId || !Number.isInteger(expectedRevision) || expectedRevision < 1 || !idempotencyKey || !reason) {
    throw new Error('ORDERQ_SUBSTITUTE_REVERSAL_SOURCE_REQUIRED');
  }
  const stores = [
    STORE.DISPATCH_DECISIONS, STORE.DISPATCH_LINES, STORE.DISPATCH_APPROVALS,
    STORE.SALES_LINES, STORE.ORDERS, STORE.ORDER_ITEMS, STORE.ORDER_EVENTS, STORE.SYNC_QUEUE
  ];
  const db = await openOrderQDb();
  const tx = db.transaction(stores, 'readwrite');
  try {
    const decision = await requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(dispatchId));
    if (!decision || decision.status !== 'CONFIRMED') throw new Error('ORDERQ_SUBSTITUTE_REVERSAL_CONFIRMED_REQUIRED');
    if (Number(decision.revision || 0) !== expectedRevision) throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${decision.revision}`);
    const line = await requestToPromise(tx.objectStore(STORE.DISPATCH_LINES).get(dispatchLineId));
    if (!line || line.dispatchId !== dispatchId || text(line.fulfillmentType).toUpperCase() !== 'SUBSTITUTE') {
      throw new Error('ORDERQ_SUBSTITUTE_REVERSAL_LINE_REQUIRED');
    }
    const [salesLines, approvals] = await Promise.all([
      allFrom(tx, STORE.SALES_LINES, 'byDispatchLineId', dispatchLineId),
      allFrom(tx, STORE.DISPATCH_APPROVALS, 'byDispatchId', dispatchId)
    ]);
    const salesLine = salesLines.find(row => row.status === 'CONFIRMED');
    if (!salesLine) throw new Error('ORDERQ_SUBSTITUTE_REVERSAL_SALES_LINE_REQUIRED');
    const events = await allFrom(tx, STORE.ORDER_EVENTS, 'byOrderId', line.orderId);
    const allocationEvent = events.find(row => row.eventType === TRANSFER_EVENT_TYPE.ALLOCATED && row.detail?.salesLineId === salesLine.salesLineId);
    if (!allocationEvent) throw new Error('ORDERQ_SUBSTITUTE_REVERSAL_ALLOCATION_EVENT_REQUIRED');
    const event = createReversalEvent({
      allocationEventId: allocationEvent.eventId,
      idempotencyKey,
      orderId: line.orderId,
      orderItemId: line.orderItemId,
      salesDocumentId: salesLine.salesDocumentId,
      salesLineId: salesLine.salesLineId,
      quantity: finite(line.recognizedOrderQuantity),
      revision: allocationEvent.revision,
      actor: context.actorId,
      reason,
      createdAt: nowIso()
    });
    const fingerprint = decisionReversalFingerprint(source, line);
    const existing = await requestToPromise(tx.objectStore(STORE.ORDER_EVENTS).get(event.eventId));
    if (existing) {
      if (existing.detail?.decisionReversalFingerprint !== fingerprint) throw new Error(`ORDERQ_SUBSTITUTE_REVERSAL_IDEMPOTENCY_CONFLICT:${idempotencyKey}`);
      await transactionDone(tx);
      return { duplicate: true, orderEvents: [existing], outbox: [] };
    }
    if (events.some(row => row.eventType === TRANSFER_EVENT_TYPE.REVERSED
      && row.detail?.allocationEventId === allocationEvent.eventId)) {
      throw new Error('ORDERQ_SUBSTITUTE_ALLOCATION_ALREADY_REVERSED');
    }
    const timestamp = nowIso();
    const reversedApprovalIds = approvals
      .filter(row => row.approvalType === DISPATCH_APPROVAL_TYPE.SUBSTITUTE
        && row.dispatchLineId === dispatchLineId
        && isDispatchApprovalEffectivelyActive(row, approvals))
      .map(row => row.approvalId)
      .sort();
    event.detail.reversalScope = 'SUBSTITUTE_DECISION_ONLY';
    event.detail.sourceDispatchId = dispatchId;
    event.detail.sourceDispatchLineId = dispatchLineId;
    event.detail.decisionReversalFingerprint = fingerprint;
    tx.objectStore(STORE.ORDER_EVENTS).add(event);
    const newEvents = [event];
    const [orderSource, items] = await Promise.all([
      requestToPromise(tx.objectStore(STORE.ORDERS).get(line.orderId)),
      allFrom(tx, STORE.ORDER_ITEMS, 'byOrderId', line.orderId)
    ]);
    const order = normalizedOrderView(orderSource);
    const before = deriveOrderLifecycle(order, items, events);
    const after = deriveOrderLifecycle(order, items, [...events, event]);
    if (before.operationStatus !== after.operationStatus) {
      const transition = {
        eventId: `OE-REOPEN-SUB-${event.eventId}`,
        orderId: line.orderId,
        revision: Number(order.revision || 0),
        eventType: TRANSFER_EVENT_TYPE.REOPENED,
        actor: context.actorId,
        detail: {
          dispatchId,
          dispatchLineId,
          reason: '대체판단 역분개로 원주문 미출고 복원',
          causeEventId: event.eventId,
          beforeStatus: before.operationStatus,
          afterStatus: after.operationStatus
        },
        createdAt: timestamp
      };
      tx.objectStore(STORE.ORDER_EVENTS).add(transition);
      newEvents.push(transition);
    }
    const approval = {
      approvalId: `DAP-${event.eventId}`,
      approvalType: DISPATCH_APPROVAL_TYPE.SUBSTITUTE_DECISION_REVERSAL,
      status: DISPATCH_APPROVAL_STATUS.REVERSED,
      revision: Number(decision.revision || 0),
      dispatchId,
      dispatchLineId,
      orderId: line.orderId,
      orderItemId: line.orderItemId,
      idempotencyKey,
      reasonCode: text(source.reasonCode).toUpperCase() || 'SUBSTITUTE_DECISION_REVERSAL',
      reasonNote: reason,
      reason,
      sourceAllocationEventId: allocationEvent.eventId,
      reversalOfApprovalIds: reversedApprovalIds,
      sourceSubstitutionApprovalId: reversedApprovalIds[0] || '',
      reversalEventId: event.eventId,
      reversedAt: timestamp,
      reversedBy: context.actorId,
      createdAt: timestamp,
      createdBy: context.actorId,
      localOnly: true
    };
    tx.objectStore(STORE.DISPATCH_APPROVALS).add(approval);
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.FULFILLMENT_WRITTEN);
    const outbox = [];
    newEvents.forEach(row => outbox.push(queueLocalEntity(tx, { entityType: 'ORDER_EVENT', entityId: row.eventId, payload: row, revision: row.revision, idempotencyKey })));
    outbox.push(queueLocalEntity(tx, { entityType: 'DISPATCH_APPROVAL', entityId: approval.approvalId, payload: approval, idempotencyKey }));
    confirmationCheckpoint(options, DISPATCH_CONFIRMATION_STEP.BEFORE_COMMIT);
    await transactionDone(tx);
    return { duplicate: false, approval, orderEvents: newEvents, outbox };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}
