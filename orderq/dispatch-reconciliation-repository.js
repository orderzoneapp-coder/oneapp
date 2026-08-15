import {
  STORE,
  newId,
  nowIso,
  openOrderQDb,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.8.0';
import { CAPABILITY, ERP_POSTING_STATUS, requireCapability } from './orderq-v7-contracts.js?v=0.8.0';
import { DISPATCH_STATUS, validateDispatchDraftPlan } from './dispatch-workbench.js?v=0.8.0';
import {
  DISPATCH_CONFIRMATION_STORE_NAMES,
  reverseDispatchInTransaction
} from './dispatch-confirmation-repository.js?v=0.8.0';
import {
  DISPATCH_ADJUSTMENT_STEP,
  DISPATCH_RECONCILIATION_STATUS,
  dispatchAdjustmentFingerprint,
  normalizeDispatchAdjustmentCommand,
  normalizeReconciliationCompletionCommand,
  normalizeReconciliationIssueCommand,
  quantityDifference,
  reconciliationCheckpoint,
  reconciliationCompletionFingerprint,
  reconciliationIssueFingerprint
} from './dispatch-reconciliation.js?v=0.8.0';

const DISPATCH_SEQUENCE_PREFIX = 'dispatchNoSequence:';
const EPSILON = 1e-9;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function allFrom(tx, storeName, indexName = '', query = undefined) {
  const store = tx.objectStore(storeName);
  return requestToPromise((indexName ? store.index(indexName) : store).getAll(query));
}

function historyEvent(eventType, actorId, detail, timestamp = nowIso()) {
  return { eventId: newId('RH'), eventType, actorId, detail: clone(detail), createdAt: timestamp };
}

function queueLocalEntity(tx, { entityType, entityId, payload, revision = 1, baseRevision = 0, idempotencyKey }) {
  const timestamp = nowIso();
  const row = {
    queueId: newId('SQ'), entityType, entityId, operation: 'UPSERT',
    revision: Number(revision || 0), baseRevision: Number(baseRevision || 0),
    payload: clone(payload), status: 'LOCAL_ONLY', localOnly: true,
    reconciliationIdempotencyKey: idempotencyKey,
    createdAt: timestamp, updatedAt: timestamp
  };
  tx.objectStore(STORE.SYNC_QUEUE).add(row);
  return row;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + finite(row[field]), 0);
}

function differenceTotals(expected, actual) {
  return {
    actualQuantity: quantityDifference(expected.actualQuantity, actual.actualQuantity),
    actualBaseQuantity: quantityDifference(expected.actualBaseQuantity, actual.actualBaseQuantity),
    recognizedOrderQuantity: quantityDifference(expected.recognizedOrderQuantity, actual.recognizedOrderQuantity)
  };
}

function sameMembers(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function sameNumber(left, right) {
  return Math.abs(finite(left) - finite(right)) <= EPSILON;
}

function withoutKeys(source, keys) {
  const result = { ...(source || {}) };
  keys.forEach(key => delete result[key]);
  return result;
}

async function nextDispatchNo(tx, businessDate) {
  const dateKey = text(businessDate).replace(/\D/g, '').slice(0, 8) || nowIso().slice(0, 10).replace(/-/g, '');
  const key = `${DISPATCH_SEQUENCE_PREFIX}${dateKey}`;
  const metaStore = tx.objectStore(STORE.META);
  const current = await requestToPromise(metaStore.get(key));
  const sequence = Number(current?.value || 0) + 1;
  metaStore.put({ key, value: sequence, updatedAt: nowIso() });
  return `${dateKey}-D${String(sequence).padStart(3, '0')}`;
}

async function findByCommandKey(tx, field, key) {
  const rows = await allFrom(tx, STORE.DISPATCH_RECONCILIATIONS);
  return rows.find(row => text(row[field]) === key) || null;
}

async function sourceAggregate(tx, dispatchId) {
  const decision = await requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(dispatchId));
  if (!decision || decision.status !== DISPATCH_STATUS.CONFIRMED || decision.reversalOf) {
    throw new Error('ORDERQ_RECONCILIATION_SOURCE_NOT_CONFIRMED');
  }
  const salesDocument = await requestToPromise(tx.objectStore(STORE.SALES_DOCUMENTS).get(decision.salesDocumentId));
  if (!salesDocument || salesDocument.status !== 'CONFIRMED') throw new Error('ORDERQ_RECONCILIATION_SALES_DOCUMENT_REQUIRED');
  const [lines, allocations, salesLines, movements, allSalesDocuments] = await Promise.all([
    allFrom(tx, STORE.DISPATCH_LINES, 'byDispatchId', dispatchId),
    allFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', dispatchId),
    allFrom(tx, STORE.SALES_LINES, 'byDocumentId', salesDocument.salesDocumentId),
    allFrom(tx, STORE.INVENTORY_MOVEMENTS, 'byDispatchId', dispatchId),
    allFrom(tx, STORE.SALES_DOCUMENTS)
  ]);
  if (allSalesDocuments.some(row => row.reversalOf === salesDocument.salesDocumentId)) {
    throw new Error('ORDERQ_RECONCILIATION_SOURCE_ALREADY_REVERSED');
  }
  return { decision, salesDocument, lines, allocations, salesLines, movements };
}

function buildIssueLines(command, aggregate) {
  if (!sameMembers(command.lines.map(row => row.dispatchLineId), aggregate.lines.map(row => row.dispatchLineId))) {
    throw new Error('ORDERQ_RECONCILIATION_ALL_LINES_REQUIRED');
  }
  const salesByDispatchLine = new Map(aggregate.salesLines.map(row => [row.dispatchLineId, row]));
  const allocationById = new Map(aggregate.allocations.map(row => [row.allocationId, row]));
  const movementById = new Map(aggregate.movements.map(row => [row.movementId, row]));
  return command.lines.map(actual => {
    const original = aggregate.lines.find(row => row.dispatchLineId === actual.dispatchLineId);
    const salesLine = salesByDispatchLine.get(actual.dispatchLineId);
    if (!original || !salesLine) throw new Error(`ORDERQ_RECONCILIATION_SOURCE_LINE_REQUIRED:${actual.dispatchLineId}`);
    const sourceAllocations = aggregate.allocations.filter(row => row.dispatchLineId === actual.dispatchLineId);
    if (!sameMembers(actual.allocations.map(row => row.allocationId), sourceAllocations.map(row => row.allocationId))) {
      throw new Error(`ORDERQ_RECONCILIATION_ALL_ALLOCATIONS_REQUIRED:${actual.dispatchLineId}`);
    }
    const allocations = actual.allocations.map(verified => {
      const source = allocationById.get(verified.allocationId);
      const movement = movementById.get(source?.movementId);
      if (!source || !movement) throw new Error(`ORDERQ_RECONCILIATION_SOURCE_MOVEMENT_REQUIRED:${verified.allocationId}`);
      const expectedBaseQuantity = Math.abs(finite(movement.signedBaseQuantity));
      return {
        allocationId: source.allocationId,
        movementId: movement.movementId,
        warehouseId: source.warehouseId,
        productId: movement.productId,
        originalBaseQuantity: expectedBaseQuantity,
        expectedBaseQuantity,
        actualBaseQuantity: verified.actualBaseQuantity,
        differenceBaseQuantity: quantityDifference(expectedBaseQuantity, verified.actualBaseQuantity)
      };
    });
    if (Math.abs(sum(allocations, 'actualBaseQuantity') - actual.actualBaseQuantity) > EPSILON) {
      throw new Error(`ORDERQ_RECONCILIATION_ALLOCATION_SUM_MISMATCH:${actual.dispatchLineId}`);
    }
    const expectedActualQuantity = finite(salesLine.actualQuantity ?? salesLine.quantity);
    const expectedBaseQuantity = finite(salesLine.actualBaseQuantity ?? expectedActualQuantity);
    const expectedRecognizedOrderQuantity = finite(salesLine.recognizedOrderQuantity ?? expectedActualQuantity);
    return {
      reconciliationLineId: newId('RL'),
      dispatchLineId: original.dispatchLineId,
      salesLineId: salesLine.salesLineId,
      orderId: original.orderId,
      orderItemId: original.orderItemId,
      requestedProductId: original.requestedProductId,
      actualProductId: original.actualProductId,
      originalActualQuantity: expectedActualQuantity,
      originalBaseQuantity: expectedBaseQuantity,
      originalRecognizedOrderQuantity: expectedRecognizedOrderQuantity,
      expectedActualQuantity,
      expectedBaseQuantity,
      expectedRecognizedOrderQuantity,
      actualActualQuantity: actual.actualQuantity,
      actualBaseQuantity: actual.actualBaseQuantity,
      actualRecognizedOrderQuantity: actual.recognizedOrderQuantity,
      differenceActualQuantity: quantityDifference(expectedActualQuantity, actual.actualQuantity),
      differenceBaseQuantity: quantityDifference(expectedBaseQuantity, actual.actualBaseQuantity),
      differenceRecognizedOrderQuantity: quantityDifference(expectedRecognizedOrderQuantity, actual.recognizedOrderQuantity),
      allocations
    };
  });
}

function issueResult(issue, duplicate, outbox = []) {
  return { duplicate, reconciliation: issue, outbox };
}

export async function listDispatchReconciliationWorkspace() {
  const db = await openOrderQDb();
  const tx = db.transaction(DISPATCH_CONFIRMATION_STORE_NAMES, 'readonly');
  const [decisions, lines, allocations, salesDocuments, salesLines, movements, reconciliations] = await Promise.all([
    allFrom(tx, STORE.DISPATCH_DECISIONS),
    allFrom(tx, STORE.DISPATCH_LINES),
    allFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS),
    allFrom(tx, STORE.SALES_DOCUMENTS),
    allFrom(tx, STORE.SALES_LINES),
    allFrom(tx, STORE.INVENTORY_MOVEMENTS),
    allFrom(tx, STORE.DISPATCH_RECONCILIATIONS)
  ]);
  await transactionDone(tx);
  const reversedSalesIds = new Set(salesDocuments.map(row => row.reversalOf).filter(Boolean));
  const candidates = decisions
    .filter(row => row.status === DISPATCH_STATUS.CONFIRMED && !row.reversalOf && !reversedSalesIds.has(row.salesDocumentId))
    .map(decision => {
      const salesDocument = salesDocuments.find(row => row.salesDocumentId === decision.salesDocumentId) || null;
      return {
        decision,
        salesDocument,
        lines: lines.filter(row => row.dispatchId === decision.dispatchId).map(line => ({
          ...line,
          salesLine: salesLines.find(row => row.dispatchLineId === line.dispatchLineId) || null,
          allocations: allocations.filter(row => row.dispatchLineId === line.dispatchLineId).map(allocation => ({
            ...allocation,
            movement: movements.find(row => row.movementId === allocation.movementId) || null
          }))
        }))
      };
    })
    .sort((left, right) => text(right.decision.confirmedAt).localeCompare(text(left.decision.confirmedAt)));
  return {
    candidates,
    reconciliations: reconciliations.sort((left, right) => text(right.updatedAt).localeCompare(text(left.updatedAt)))
  };
}

export async function createDispatchReconciliationIssue(source = {}, actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_REVERSE);
  const command = normalizeReconciliationIssueCommand(source);
  const fingerprint = reconciliationIssueFingerprint(command);
  const db = await openOrderQDb();
  const tx = db.transaction(DISPATCH_CONFIRMATION_STORE_NAMES, 'readwrite');
  try {
    const existing = await findByCommandKey(tx, 'issueIdempotencyKey', command.idempotencyKey);
    if (existing) {
      if (existing.issueRequestFingerprint !== fingerprint) throw new Error(`ORDERQ_RECONCILIATION_IDEMPOTENCY_CONFLICT:${command.idempotencyKey}`);
      const result = issueResult(existing, true);
      await transactionDone(tx);
      return result;
    }
    const aggregate = await sourceAggregate(tx, command.dispatchId);
    if (Number(aggregate.decision.revision || 0) !== command.expectedRevision) {
      throw new Error(`ORDERQ_DISPATCH_REVISION_CONFLICT:${aggregate.decision.revision}`);
    }
    const lines = buildIssueLines(command, aggregate);
    const expectedTotals = {
      actualQuantity: sum(lines, 'expectedActualQuantity'),
      actualBaseQuantity: sum(lines, 'expectedBaseQuantity'),
      recognizedOrderQuantity: sum(lines, 'expectedRecognizedOrderQuantity')
    };
    const actualTotals = {
      actualQuantity: sum(lines, 'actualActualQuantity'),
      actualBaseQuantity: sum(lines, 'actualBaseQuantity'),
      recognizedOrderQuantity: sum(lines, 'actualRecognizedOrderQuantity')
    };
    const timestamp = nowIso();
    const reconciliationId = newId('DR');
    const issue = {
      reconciliationId,
      dispatchId: command.dispatchId,
      salesDocumentId: aggregate.salesDocument.salesDocumentId,
      dispatchLineId: lines.length === 1 ? lines[0].dispatchLineId : '',
      orderItemIds: [...new Set(lines.map(row => row.orderItemId))],
      movementIds: aggregate.movements.map(row => row.movementId),
      issueType: command.issueType,
      status: DISPATCH_RECONCILIATION_STATUS.REVIEW_REQUIRED,
      revision: 1,
      baseRevision: 0,
      sourceDispatchRevision: command.expectedRevision,
      issueIdempotencyKey: command.idempotencyKey,
      issueRequestFingerprint: fingerprint,
      originalValue: clone(expectedTotals),
      expectedValue: clone(expectedTotals),
      actualValue: clone(actualTotals),
      differenceQuantity: differenceTotals(expectedTotals, actualTotals),
      lines,
      reasonCode: command.reasonCode,
      reasonNote: command.reasonNote,
      erpPostingStatus: aggregate.salesDocument.erpPostingStatus,
      erpDocumentNo: text(aggregate.salesDocument.erpDocumentNo),
      createdAt: timestamp,
      createdBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId,
      localOnly: true,
      history: [historyEvent('RECONCILIATION_OPENED', context.actorId, {
        dispatchId: command.dispatchId,
        salesDocumentId: aggregate.salesDocument.salesDocumentId,
        expectedValue: expectedTotals,
        actualValue: actualTotals,
        differenceQuantity: differenceTotals(expectedTotals, actualTotals),
        reasonCode: command.reasonCode,
        reasonNote: command.reasonNote
      }, timestamp)]
    };
    tx.objectStore(STORE.DISPATCH_RECONCILIATIONS).add(issue);
    const outbox = [queueLocalEntity(tx, {
      entityType: 'DISPATCH_RECONCILIATION', entityId: reconciliationId,
      payload: issue, idempotencyKey: command.idempotencyKey
    })];
    await transactionDone(tx);
    return issueResult(issue, false, outbox);
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

function correctedDraftFromIssue({ tx, issue, aggregate, actorId, idempotencyKey, reason, timestamp }) {
  const dispatchId = newId('DSP-COR');
  const sourceLineById = new Map(aggregate.lines.map(row => [row.dispatchLineId, row]));
  const sourceAllocationById = new Map(aggregate.allocations.map(row => [row.allocationId, row]));
  const lines = issue.lines.map(issueLine => {
    const sourceLine = withoutKeys(sourceLineById.get(issueLine.dispatchLineId), [
      'actualQuantity', 'actualBaseQuantity', 'recognizedOrderQuantity', 'confirmedQuantity', 'confirmedBaseQuantity',
      'salesLineId', 'inventoryMovementId', 'movementId', 'confirmedAt', 'confirmedBy', 'reversedAt', 'reversedBy',
      'workerReportedQuantity', 'workerReportedProductId', 'workerExceptionCode', 'workerExceptionMemo',
      'workerReportedAt', 'workerReportedBy', 'measuredActualQuantity', 'measuredBaseQuantity',
      'measuredRecognizedOrderQuantity', 'measuredAt', 'measuredBy', 'actualRevision', 'actualRecordedAt',
      'actualRecordedBy', 'customerNoticeActorId', 'customerNoticeAt', 'customerNotifiedBy', 'customerNotifiedAt',
      'customerNoticeMemo', 'customerNoticePriceFingerprint'
    ]);
    return {
      ...sourceLine,
      dispatchId,
      dispatchLineId: newId('DL-COR'),
      status: 'PLANNED',
      executionStatus: 'PLANNED',
      workStatus: 'PENDING',
      plannedActualQuantity: issueLine.actualActualQuantity,
      plannedBaseQuantity: issueLine.actualBaseQuantity,
      plannedRecognizedOrderQuantity: issueLine.actualRecognizedOrderQuantity,
      correctionOfDispatchLineId: issueLine.dispatchLineId,
      reconciliationId: issue.reconciliationId,
      correctionReason: reason
    };
  });
  const correctionLineBySource = new Map(lines.map(row => [row.correctionOfDispatchLineId, row]));
  const allocations = issue.lines.flatMap(issueLine => issueLine.allocations.map(issueAllocation => {
    const sourceAllocation = withoutKeys(sourceAllocationById.get(issueAllocation.allocationId), [
      'actualBaseQuantity', 'movementId', 'confirmedAt', 'confirmedBy', 'reversedAt', 'reversedBy',
      'actualRecordedAt', 'actualRecordedBy', 'reservationId'
    ]);
    return {
      ...sourceAllocation,
      allocationId: newId('DA-COR'),
      dispatchId,
      dispatchLineId: correctionLineBySource.get(issueLine.dispatchLineId).dispatchLineId,
      status: 'PLANNED',
      reservationId: '',
      plannedBaseQuantity: issueAllocation.actualBaseQuantity,
      correctionOfAllocationId: issueAllocation.allocationId,
      reconciliationId: issue.reconciliationId
    };
  }));
  const normalized = validateDispatchDraftPlan({ lines, allocations, strict: true });
  return nextDispatchNo(tx, aggregate.decision.businessDate).then(dispatchNo => {
    const event = historyEvent('CORRECTION_DRAFT_CREATED', actorId, {
      reconciliationId: issue.reconciliationId,
      sourceDispatchId: issue.dispatchId,
      reason
    }, timestamp);
    const decision = {
      dispatchId,
      dispatchNo,
      customerId: aggregate.decision.customerId,
      customerName: aggregate.decision.customerName,
      sourceOrderIds: [...(aggregate.decision.sourceOrderIds || [])],
      dispatchStageCode: aggregate.decision.dispatchStageCode,
      businessDate: aggregate.decision.businessDate,
      status: DISPATCH_STATUS.DRAFT,
      revision: 1,
      baseRevision: 0,
      correctionOfDispatchId: issue.dispatchId,
      reconciliationId: issue.reconciliationId,
      correctionReason: reason,
      idempotencyKey,
      createdAt: timestamp,
      createdBy: actorId,
      updatedAt: timestamp,
      updatedBy: actorId,
      history: [event],
      localOnly: true
    };
    const storedLines = normalized.lines.map(row => ({
      ...row,
      status: 'PLANNED', executionStatus: 'PLANNED', workStatus: 'PENDING',
      revision: 1, createdAt: timestamp, createdBy: actorId, updatedAt: timestamp, updatedBy: actorId
    }));
    const storedAllocations = normalized.allocations.map(row => ({
      ...row, status: 'PLANNED', reservationId: '', revision: 1,
      createdAt: timestamp, createdBy: actorId, updatedAt: timestamp, updatedBy: actorId
    }));
    return { decision, lines: storedLines, allocations: storedAllocations };
  });
}

function completionMismatch(code) {
  throw new Error(`ORDERQ_RECONCILIATION_COMPLETION_MISMATCH:${code}`);
}

async function validateCorrectionCompletion(tx, issue, command) {
  const corrected = await requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(issue.correctionDispatchId));
  if (!corrected || corrected.status !== DISPATCH_STATUS.CONFIRMED) {
    throw new Error('ORDERQ_RECONCILIATION_CORRECTION_NOT_CONFIRMED');
  }
  if (corrected.dispatchId !== issue.correctionDispatchId
    || corrected.correctionOfDispatchId !== issue.dispatchId
    || corrected.reconciliationId !== issue.reconciliationId) {
    completionMismatch('DISPATCH_LINK');
  }
  const salesDocument = await requestToPromise(tx.objectStore(STORE.SALES_DOCUMENTS).get(corrected.salesDocumentId));
  if (!salesDocument || salesDocument.status !== 'CONFIRMED' || salesDocument.dispatchId !== corrected.dispatchId) {
    completionMismatch('SALES_DOCUMENT');
  }
  const [lines, allocations, salesLines, movements, events] = await Promise.all([
    allFrom(tx, STORE.DISPATCH_LINES, 'byDispatchId', corrected.dispatchId),
    allFrom(tx, STORE.DISPATCH_STOCK_ALLOCATIONS, 'byDispatchId', corrected.dispatchId),
    allFrom(tx, STORE.SALES_LINES, 'byDocumentId', salesDocument.salesDocumentId),
    allFrom(tx, STORE.INVENTORY_MOVEMENTS, 'byDispatchId', corrected.dispatchId),
    allFrom(tx, STORE.ORDER_EVENTS)
  ]);
  const expectedLineIds = issue.lines.map(row => row.dispatchLineId);
  const correctionSourceLineIds = lines.map(row => text(row.correctionOfDispatchLineId));
  if (!sameMembers(expectedLineIds, correctionSourceLineIds)
    || new Set(correctionSourceLineIds).size !== correctionSourceLineIds.length) {
    completionMismatch('LINE_SET');
  }
  if (salesLines.length !== lines.length) completionMismatch('SALES_LINE_SET');
  const allocationMovementIds = allocations.map(row => text(row.movementId));
  const movementIds = movements.map(row => text(row.movementId));
  if (!sameMembers(allocationMovementIds, movementIds)
    || new Set(allocationMovementIds).size !== allocationMovementIds.length) {
    completionMismatch('MOVEMENT_SET');
  }
  const salesByDispatchLine = new Map(salesLines.map(row => [row.dispatchLineId, row]));
  const movementById = new Map(movements.map(row => [row.movementId, row]));
  const fulfillmentIds = new Set(corrected.fulfillmentEventIds || []);
  const fulfillmentEvents = events.filter(row => fulfillmentIds.has(row.eventId));
  const actualTotals = { actualQuantity: 0, actualBaseQuantity: 0, recognizedOrderQuantity: 0 };
  for (const issueLine of issue.lines) {
    const line = lines.find(row => row.correctionOfDispatchLineId === issueLine.dispatchLineId);
    const salesLine = salesByDispatchLine.get(line?.dispatchLineId);
    if (!line || line.reconciliationId !== issue.reconciliationId || !salesLine || salesLine.status !== 'CONFIRMED') {
      completionMismatch(`LINE_LINK:${issueLine.dispatchLineId}`);
    }
    if (!sameNumber(salesLine.actualQuantity, issueLine.actualActualQuantity)
      || !sameNumber(salesLine.actualBaseQuantity, issueLine.actualBaseQuantity)
      || !sameNumber(salesLine.recognizedOrderQuantity, issueLine.actualRecognizedOrderQuantity)
      || !sameNumber(line.actualQuantity, issueLine.actualActualQuantity)
      || !sameNumber(line.actualBaseQuantity, issueLine.actualBaseQuantity)
      || !sameNumber(line.recognizedOrderQuantity, issueLine.actualRecognizedOrderQuantity)) {
      completionMismatch(`LINE_QUANTITY:${issueLine.dispatchLineId}`);
    }
    if (text(line.actualProductId) !== text(issueLine.actualProductId)
      || text(salesLine.productId || salesLine.actualProductId) !== text(issueLine.actualProductId)
      || text(line.orderItemId) !== text(issueLine.orderItemId)
      || text(salesLine.orderItemId) !== text(issueLine.orderItemId)) {
      completionMismatch(`LINE_IDENTITY:${issueLine.dispatchLineId}`);
    }
    const lineAllocations = allocations.filter(row => row.dispatchLineId === line.dispatchLineId);
    const expectedAllocationIds = issueLine.allocations.map(row => row.allocationId);
    const correctionSourceAllocationIds = lineAllocations.map(row => text(row.correctionOfAllocationId));
    if (!sameMembers(expectedAllocationIds, correctionSourceAllocationIds)
      || new Set(correctionSourceAllocationIds).size !== correctionSourceAllocationIds.length) {
      completionMismatch(`ALLOCATION_SET:${issueLine.dispatchLineId}`);
    }
    for (const issueAllocation of issueLine.allocations) {
      const allocation = lineAllocations.find(row => row.correctionOfAllocationId === issueAllocation.allocationId);
      const movement = movementById.get(allocation?.movementId);
      if (!allocation || allocation.reconciliationId !== issue.reconciliationId
        || text(allocation.warehouseId) !== text(issueAllocation.warehouseId)
        || !sameNumber(allocation.actualBaseQuantity, issueAllocation.actualBaseQuantity)) {
        completionMismatch(`ALLOCATION:${issueAllocation.allocationId}`);
      }
      if (!movement || movement.movementType !== 'SALE_ISSUE'
        || movement.dispatchId !== corrected.dispatchId
        || movement.dispatchLineId !== line.dispatchLineId
        || movement.sourceLineId !== allocation.allocationId
        || text(movement.productId) !== text(issueLine.actualProductId)
        || text(movement.warehouseId) !== text(issueAllocation.warehouseId)
        || !sameNumber(movement.signedBaseQuantity, -issueAllocation.actualBaseQuantity)) {
        completionMismatch(`MOVEMENT:${issueAllocation.allocationId}`);
      }
    }
    const fulfillment = fulfillmentEvents.find(row => row.detail?.salesLineId === salesLine.salesLineId);
    if (!fulfillment || fulfillment.eventType !== 'SALES_TRANSFER_ALLOCATED'
      || text(fulfillment.detail?.orderItemId) !== text(issueLine.orderItemId)
      || !sameNumber(fulfillment.detail?.transferredQty, issueLine.actualRecognizedOrderQuantity)) {
      completionMismatch(`FULFILLMENT:${issueLine.dispatchLineId}`);
    }
    actualTotals.actualQuantity += finite(salesLine.actualQuantity);
    actualTotals.actualBaseQuantity += finite(salesLine.actualBaseQuantity);
    actualTotals.recognizedOrderQuantity += finite(salesLine.recognizedOrderQuantity);
  }
  if (!sameNumber(actualTotals.actualQuantity, issue.actualValue?.actualQuantity)
    || !sameNumber(actualTotals.actualBaseQuantity, issue.actualValue?.actualBaseQuantity)
    || !sameNumber(actualTotals.recognizedOrderQuantity, issue.actualValue?.recognizedOrderQuantity)) {
    completionMismatch('TOTALS');
  }
  const evidence = {
    correctionDispatchId: corrected.dispatchId,
    correctionSalesDocumentId: salesDocument.salesDocumentId,
    correctionConfirmationFingerprint: text(salesDocument.confirmationRequestFingerprint)
  };
  if ((command.correctionDispatchId && command.correctionDispatchId !== evidence.correctionDispatchId)
    || (command.correctionSalesDocumentId && command.correctionSalesDocumentId !== evidence.correctionSalesDocumentId)
    || (command.correctionConfirmationFingerprint
      && command.correctionConfirmationFingerprint !== evidence.correctionConfirmationFingerprint)) {
    completionMismatch('CONFIRMED_EVIDENCE');
  }
  return { corrected, salesDocument, evidence };
}

async function loadAdjustmentResult(tx, issue, duplicate) {
  const [reversalDecision, correctionDecision, outbox] = await Promise.all([
    requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(issue.reversalDispatchId)),
    requestToPromise(tx.objectStore(STORE.DISPATCH_DECISIONS).get(issue.correctionDispatchId)),
    allFrom(tx, STORE.SYNC_QUEUE)
  ]);
  return {
    duplicate,
    reconciliation: issue,
    reversalDecision,
    correctionDecision,
    outbox: outbox.filter(row => row.reconciliationIdempotencyKey === issue.adjustmentIdempotencyKey
      || row.confirmationIdempotencyKey === `${issue.adjustmentIdempotencyKey}:REV`)
  };
}

export async function adjustDispatchAfterShipment(source = {}, actor = 'ADMIN', options = {}) {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_REVERSE);
  requireCapability(actor, CAPABILITY.DISPATCH_EDIT);
  const command = normalizeDispatchAdjustmentCommand(source);
  const fingerprint = dispatchAdjustmentFingerprint(command);
  const db = await openOrderQDb();
  const tx = db.transaction(DISPATCH_CONFIRMATION_STORE_NAMES, 'readwrite');
  try {
    const foreign = await findByCommandKey(tx, 'adjustmentIdempotencyKey', command.idempotencyKey);
    if (foreign && foreign.reconciliationId !== command.reconciliationId) {
      throw new Error(`ORDERQ_ADJUST_IDEMPOTENCY_CONFLICT:${command.idempotencyKey}`);
    }
    const issueStore = tx.objectStore(STORE.DISPATCH_RECONCILIATIONS);
    const issue = await requestToPromise(issueStore.get(command.reconciliationId));
    if (!issue) throw new Error('ORDERQ_ADJUST_RECONCILIATION_NOT_FOUND');
    if (issue.adjustmentIdempotencyKey) {
      if (issue.adjustmentIdempotencyKey !== command.idempotencyKey || issue.adjustmentRequestFingerprint !== fingerprint) {
        throw new Error(`ORDERQ_ADJUST_IDEMPOTENCY_CONFLICT:${command.idempotencyKey}`);
      }
      const result = await loadAdjustmentResult(tx, issue, true);
      await transactionDone(tx);
      return result;
    }
    if (issue.status !== DISPATCH_RECONCILIATION_STATUS.REVIEW_REQUIRED) throw new Error('ORDERQ_ADJUST_STATE_INVALID');
    if (Number(issue.revision || 0) !== command.expectedRevision) throw new Error(`ORDERQ_RECONCILIATION_REVISION_CONFLICT:${issue.revision}`);
    const aggregate = await sourceAggregate(tx, issue.dispatchId);
    if (Number(aggregate.decision.revision || 0) !== Number(issue.sourceDispatchRevision || 0)) {
      throw new Error(`ORDERQ_ADJUST_SOURCE_REVISION_STALE:${aggregate.decision.revision}`);
    }
    const erpStatus = text(aggregate.salesDocument.erpPostingStatus).toUpperCase();
    const posted = erpStatus === ERP_POSTING_STATUS.POSTED;
    if (![ERP_POSTING_STATUS.READY, ERP_POSTING_STATUS.NOT_READY, ERP_POSTING_STATUS.POSTED].includes(erpStatus)) {
      throw new Error(`ORDERQ_ADJUST_ERP_STATE_INVALID:${erpStatus}`);
    }
    if (posted && !text(aggregate.salesDocument.erpDocumentNo)) {
      throw new Error('ORDERQ_ADJUST_ERP_DOCUMENT_NO_REQUIRED');
    }
    const erpCorrection = posted ? {
      mode: 'M8_POSTED_CORRECTION',
      allowPostedCorrection: true,
      reversalErpPostingStatus: ERP_POSTING_STATUS.CORRECTION_REQUIRED,
      originalErpPostingStatus: ERP_POSTING_STATUS.POSTED,
      originalErpDocumentNo: text(aggregate.salesDocument.erpDocumentNo),
      reason: command.reason
    } : null;
    const reversal = await reverseDispatchInTransaction({
      tx,
      source: {
        dispatchId: issue.dispatchId,
        expectedRevision: issue.sourceDispatchRevision,
        idempotencyKey: `${command.idempotencyKey}:REV`,
        reason: command.reason,
        lines: []
      },
      actor,
      options,
      erpCorrection
    });
    reconciliationCheckpoint(options, DISPATCH_ADJUSTMENT_STEP.REVERSAL_WRITTEN);
    const timestamp = nowIso();
    const correction = await correctedDraftFromIssue({
      tx, issue, aggregate, actorId: context.actorId,
      idempotencyKey: command.idempotencyKey, reason: command.reason, timestamp
    });
    tx.objectStore(STORE.DISPATCH_DECISIONS).add(correction.decision);
    correction.lines.forEach(row => tx.objectStore(STORE.DISPATCH_LINES).add(row));
    correction.allocations.forEach(row => tx.objectStore(STORE.DISPATCH_STOCK_ALLOCATIONS).add(row));
    const correctionOutbox = [];
    const enqueue = entry => correctionOutbox.push(queueLocalEntity(tx, { ...entry, idempotencyKey: command.idempotencyKey }));
    enqueue({ entityType: 'DISPATCH_DECISION', entityId: correction.decision.dispatchId, payload: correction.decision });
    correction.lines.forEach(row => enqueue({ entityType: 'DISPATCH_LINE', entityId: row.dispatchLineId, payload: row }));
    correction.allocations.forEach(row => enqueue({ entityType: 'DISPATCH_STOCK_ALLOCATION', entityId: row.allocationId, payload: row }));
    reconciliationCheckpoint(options, DISPATCH_ADJUSTMENT_STEP.CORRECTION_DRAFT_WRITTEN);
    const next = {
      ...issue,
      status: DISPATCH_RECONCILIATION_STATUS.CORRECTION_DRAFT_CREATED,
      revision: issue.revision + 1,
      baseRevision: issue.revision,
      adjustmentIdempotencyKey: command.idempotencyKey,
      adjustmentRequestFingerprint: fingerprint,
      reversalDispatchId: reversal.decision.dispatchId,
      reversalSalesDocumentId: reversal.salesDocument.salesDocumentId,
      correctionDispatchId: correction.decision.dispatchId,
      erpPostingStatus: posted ? ERP_POSTING_STATUS.CORRECTION_REQUIRED : erpStatus,
      originalErpPostingStatus: erpStatus,
      originalErpDocumentNo: text(aggregate.salesDocument.erpDocumentNo),
      erpAutoCancelRequested: false,
      erpAutoRetransmitRequested: false,
      adjustedAt: timestamp,
      adjustedBy: context.actorId,
      adjustmentReason: command.reason,
      updatedAt: timestamp,
      updatedBy: context.actorId,
      history: [...(issue.history || []), historyEvent('CORRECTION_DRAFT_CREATED', context.actorId, {
        sourceDispatchId: issue.dispatchId,
        reversalDispatchId: reversal.decision.dispatchId,
        correctionDispatchId: correction.decision.dispatchId,
        erpPostingStatus: posted ? ERP_POSTING_STATUS.CORRECTION_REQUIRED : erpStatus,
        originalErpDocumentNo: text(aggregate.salesDocument.erpDocumentNo),
        erpAutoCancelRequested: false,
        reason: command.reason
      }, timestamp)]
    };
    issueStore.put(next);
    enqueue({ entityType: 'DISPATCH_RECONCILIATION', entityId: next.reconciliationId, payload: next, revision: next.revision, baseRevision: issue.revision });
    reconciliationCheckpoint(options, DISPATCH_ADJUSTMENT_STEP.ISSUE_UPDATED);
    reconciliationCheckpoint(options, DISPATCH_ADJUSTMENT_STEP.BEFORE_COMMIT);
    await transactionDone(tx);
    return {
      duplicate: false,
      reconciliation: next,
      reversalDecision: reversal.decision,
      reversalSalesDocument: reversal.salesDocument,
      correctionDecision: correction.decision,
      correctionLines: correction.lines,
      correctionAllocations: correction.allocations,
      outbox: [...reversal.outbox, ...correctionOutbox]
    };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}

export async function completeDispatchReconciliation(source = {}, actor = 'ADMIN') {
  const context = requireCapability(actor, CAPABILITY.DISPATCH_REVERSE);
  const command = normalizeReconciliationCompletionCommand(source);
  const db = await openOrderQDb();
  const tx = db.transaction(DISPATCH_CONFIRMATION_STORE_NAMES, 'readwrite');
  try {
    const foreign = await findByCommandKey(tx, 'completionIdempotencyKey', command.idempotencyKey);
    if (foreign && foreign.reconciliationId !== command.reconciliationId) {
      throw new Error(`ORDERQ_RECONCILIATION_COMPLETE_IDEMPOTENCY_CONFLICT:${command.idempotencyKey}`);
    }
    const store = tx.objectStore(STORE.DISPATCH_RECONCILIATIONS);
    const issue = await requestToPromise(store.get(command.reconciliationId));
    if (!issue) throw new Error('ORDERQ_RECONCILIATION_NOT_FOUND');
    if (issue.completionIdempotencyKey) {
      const completionFingerprint = reconciliationCompletionFingerprint(command, {
        correctionDispatchId: issue.correctionDispatchId,
        correctionSalesDocumentId: issue.correctionSalesDocumentId,
        correctionConfirmationFingerprint: issue.correctionConfirmationFingerprint
      });
      if (issue.completionIdempotencyKey !== command.idempotencyKey
        || issue.completionRequestFingerprint !== completionFingerprint) {
        throw new Error(`ORDERQ_RECONCILIATION_COMPLETE_IDEMPOTENCY_CONFLICT:${command.idempotencyKey}`);
      }
      await transactionDone(tx);
      return { duplicate: true, reconciliation: issue };
    }
    if (issue.status !== DISPATCH_RECONCILIATION_STATUS.CORRECTION_DRAFT_CREATED) throw new Error('ORDERQ_RECONCILIATION_COMPLETE_STATE_INVALID');
    if (Number(issue.revision || 0) !== command.expectedRevision) throw new Error(`ORDERQ_RECONCILIATION_REVISION_CONFLICT:${issue.revision}`);
    const completion = await validateCorrectionCompletion(tx, issue, command);
    const completionFingerprint = reconciliationCompletionFingerprint(command, completion.evidence);
    const corrected = completion.corrected;
    const timestamp = nowIso();
    const next = {
      ...issue,
      status: DISPATCH_RECONCILIATION_STATUS.CORRECTED,
      revision: issue.revision + 1,
      baseRevision: issue.revision,
      correctionSalesDocumentId: corrected.salesDocumentId,
      completionIdempotencyKey: command.idempotencyKey,
      completionRequestFingerprint: completionFingerprint,
      correctionConfirmationFingerprint: completion.evidence.correctionConfirmationFingerprint,
      completedAt: timestamp,
      completedBy: context.actorId,
      updatedAt: timestamp,
      updatedBy: context.actorId,
      history: [...(issue.history || []), historyEvent('RECONCILIATION_CORRECTED', context.actorId, {
        correctionDispatchId: corrected.dispatchId,
        correctionSalesDocumentId: corrected.salesDocumentId,
        correctionConfirmationFingerprint: completion.evidence.correctionConfirmationFingerprint,
        completionRequestFingerprint: completionFingerprint
      }, timestamp)]
    };
    store.put(next);
    queueLocalEntity(tx, {
      entityType: 'DISPATCH_RECONCILIATION', entityId: next.reconciliationId,
      payload: next, revision: next.revision, baseRevision: issue.revision, idempotencyKey: command.idempotencyKey
    });
    await transactionDone(tx);
    return { duplicate: false, reconciliation: next };
  } catch (error) {
    try { tx.abort(); } catch {}
    throw error;
  }
}
