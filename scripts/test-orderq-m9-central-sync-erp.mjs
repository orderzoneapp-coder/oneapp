import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  OFFICIAL_COMMAND_TYPE,
  abortCentralCommand,
  centralInventoryProjection,
  commitCentralCommand,
  createCentralAuthorityState,
  migrateCentralDrafts,
  prepareCentralCommand,
  pullCentralChanges
} from '../orderq/central-authority.js';
import {
  ERP_MATCH_STATUS,
  buildErpExportRows,
  createErpWorkbookBuffer,
  evaluateErpDocumentMatches,
  reconcileErpImportRows,
  transitionErpPostingStatus
} from '../orderq/erp-exchange.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const key = (type, id) => `${type}\u001f${id}`;

const state = createCentralAuthorityState();
const migrationEntities = [
  { entityType:'ORDER', entityId:'O-1', payload:{ orderId:'O-1', revision:1, localOnly:true } },
  { entityType:'ORDER_ITEM', entityId:'OI-1', payload:{ orderItemId:'OI-1', orderId:'O-1', productId:'P-1', finalQuantity:10, revision:1, localOnly:true } },
  { entityType:'PRODUCT', entityId:'P-1', payload:{ productId:'P-1', revision:1, localOnly:true } },
  { entityType:'WAREHOUSE', entityId:'W-1', payload:{ warehouseId:'W-1', revision:1, localOnly:true } },
  { entityType:'INVENTORY_SNAPSHOT', entityId:'IS-1', payload:{ inventorySnapshotId:'IS-1', importBatchId:'IB-1', basisDate:'2026-08-14', snapshotLastSequence:0, status:'ACTIVE', localOnly:true } },
  { entityType:'INVENTORY_LINE', entityId:'IL-1', payload:{ inventoryLineId:'IL-1', inventorySnapshotId:'IS-1', productId:'P-1', warehouseId:'W-1', inventoryQuantity:10, status:'ACTIVE', localOnly:true } },
  { entityType:'DISPATCH_DECISION', entityId:'D-1', revision:1, payload:{ dispatchId:'D-1', status:'DRAFT', revision:1, localOnly:true } },
  { entityType:'DISPATCH_LINE', entityId:'DL-1', payload:{ dispatchLineId:'DL-1', dispatchId:'D-1', orderItemId:'OI-1', actualProductId:'P-1', plannedBaseQuantity:6, localOnly:true } },
  { entityType:'DISPATCH_STOCK_ALLOCATION', entityId:'DA-1', payload:{ allocationId:'DA-1', dispatchId:'D-1', dispatchLineId:'DL-1', warehouseId:'W-1', plannedBaseQuantity:6, localOnly:true } }
];
const migrated = migrateCentralDrafts(state, { idempotencyKey:'MIGRATE-D-1', deviceId:'PC-A', entities:migrationEntities });
assert.equal(migrated.duplicate, false);
assert.equal(state.entities[key('DISPATCH_DECISION','D-1')].payload.localOnly, false);
assert.equal(state.entities[key('DISPATCH_DECISION','D-1')].payload.centralRevision, 1);
assert.equal(migrateCentralDrafts(state, { idempotencyKey:'MIGRATE-D-1', deviceId:'PC-A', entities:migrationEntities }).duplicate, true);
assert.throws(() => migrateCentralDrafts(state, {
  idempotencyKey:'MIGRATE-CONFIRMED', entities:[{ entityType:'DISPATCH_DECISION', entityId:'D-X', payload:{ dispatchId:'D-X', status:'CONFIRMED', localOnly:true } }]
}), /DISPATCH_DRAFT_ONLY/);
assert.throws(() => migrateCentralDrafts(state, {
  idempotencyKey:'MIGRATE-MOVEMENT', entities:[{ entityType:'INVENTORY_MOVEMENT', entityId:'IM-X', payload:{ movementId:'IM-X', localOnly:true } }]
}), /MIGRATION_ENTITY_INVALID/);
assert.throws(() => migrateCentralDrafts(state, {
  idempotencyKey:'MIGRATE-CENTRAL-EVIDENCE', entities:[{ entityType:'ORDER', entityId:'O-X', payload:{ orderId:'O-X', localOnly:false, centralRevision:1 } }]
}), /MIGRATION_EVIDENCE_INVALID/);

for (const failureAt of ['ENTITIES_WRITTEN','CHANGES_WRITTEN','COMMAND_WRITTEN']) {
  const migrationFailureState = createCentralAuthorityState();
  const before = JSON.stringify(migrationFailureState);
  assert.throws(() => migrateCentralDrafts(migrationFailureState, {
    idempotencyKey:`MIGRATE-FAIL-${failureAt}`, deviceId:'PC-A',
    entities:[{ entityType:'ORDER', entityId:`O-${failureAt}`, payload:{ orderId:`O-${failureAt}`, revision:1, localOnly:true } }]
  }, { failureAt }), /MIGRATION_FAILURE_INJECTED/);
  assert.equal(JSON.stringify(migrationFailureState), before);
  const recovered = migrateCentralDrafts(migrationFailureState, {
    idempotencyKey:`MIGRATE-FAIL-${failureAt}`, deviceId:'PC-A',
    entities:[{ entityType:'ORDER', entityId:`O-${failureAt}`, payload:{ orderId:`O-${failureAt}`, revision:1, localOnly:true } }]
  });
  assert.equal(recovered.changes.length, 1);
}

const leaseState = createCentralAuthorityState({ entities:{
  [key('DISPATCH_DECISION','D-LEASE')]:{ entityType:'DISPATCH_DECISION', entityId:'D-LEASE', revision:1, status:'DRAFT', payload:{ dispatchId:'D-LEASE', status:'DRAFT', revision:1 } }
} });
const leaseAt = '2026-08-15T00:00:00.000Z';
const expiredLease = prepareCentralCommand(leaseState, { commandType:'RELEASE_DISPATCH', aggregateId:'D-LEASE', expectedRevision:1, idempotencyKey:'LEASE-OLD', now:leaseAt });
const reacquiredLease = prepareCentralCommand(leaseState, { commandType:'RELEASE_DISPATCH', aggregateId:'D-LEASE', expectedRevision:1, idempotencyKey:'LEASE-NEW', now:'2026-08-16T00:00:00.000Z' });
assert.equal(leaseState.commands['LEASE-OLD'].status, 'EXPIRED');
assert.notEqual(reacquiredLease.leaseToken, expiredLease.leaseToken);
assert.throws(() => commitCentralCommand(leaseState, {
  idempotencyKey:'LEASE-OLD', leaseToken:expiredLease.leaseToken, fingerprint:expiredLease.fingerprint, mutations:[], now:'2026-08-16T00:00:00.000Z'
}), /COMMAND_TERMINAL/);
abortCentralCommand(leaseState, { idempotencyKey:'LEASE-NEW', leaseToken:reacquiredLease.leaseToken, reason:'cancel', now:'2026-08-16T00:01:00.000Z' });
assert.equal(leaseState.commands['LEASE-NEW'].status, 'ABORTED');
assert.throws(() => commitCentralCommand(leaseState, {
  idempotencyKey:'LEASE-NEW', leaseToken:reacquiredLease.leaseToken, fingerprint:reacquiredLease.fingerprint, mutations:[], now:'2026-08-16T00:01:01.000Z'
}), /COMMAND_TERMINAL/);
assert.throws(() => prepareCentralCommand(leaseState, {
  commandType:'RELEASE_DISPATCH', aggregateId:'D-LEASE', expectedRevision:1, idempotencyKey:'LEASE-NEW', now:'2026-08-16T00:01:02.000Z'
}), /COMMAND_TERMINAL/);

const releaseCommand = { commandType:OFFICIAL_COMMAND_TYPE.RELEASE_DISPATCH, aggregateId:'D-1', expectedRevision:1, idempotencyKey:'REL-A', deviceId:'PC-A' };
const releaseLease = prepareCentralCommand(state, releaseCommand);
assert.throws(() => prepareCentralCommand(state, { ...releaseCommand, idempotencyKey:'REL-B', deviceId:'PC-B' }), /AGGREGATE_LOCKED/);
const release = commitCentralCommand(state, {
  idempotencyKey:'REL-A', leaseToken:releaseLease.leaseToken, fingerprint:releaseLease.fingerprint,
  mutations:[
    { entityType:'DISPATCH_DECISION', entityId:'D-1', revision:2, payload:{ dispatchId:'D-1', status:'RELEASED', revision:2, localOnly:true } },
    { entityType:'INVENTORY_RESERVATION', entityId:'IR-1', revision:2, payload:{ reservationId:'IR-1', dispatchId:'D-1', allocationId:'DA-1', productId:'P-1', warehouseId:'W-1', reservedBaseQuantity:6, status:'ACTIVE', localOnly:true } }
  ]
});
assert.equal(release.serverRevision, 2);
assert.equal(centralInventoryProjection(state)[0].availableQuantity, 4);

const staleLease = prepareCentralCommand(state, { commandType:OFFICIAL_COMMAND_TYPE.UPDATE_DISPATCH, aggregateId:'D-1', expectedRevision:2, idempotencyKey:'ACTUAL-STALE', deviceId:'PC-A' });
state.entities[key('INVENTORY_LINE', 'IL-1')].payload.inventoryQuantity = 9;
assert.throws(() => commitCentralCommand(state, {
  idempotencyKey:'ACTUAL-STALE', leaseToken:staleLease.leaseToken, fingerprint:staleLease.fingerprint, mutations:[]
}), /INVENTORY_REVISION_CONFLICT/);
abortCentralCommand(state, { idempotencyKey:'ACTUAL-STALE', leaseToken:staleLease.leaseToken, reason:'stale resource' });

const actualLease = prepareCentralCommand(state, { commandType:OFFICIAL_COMMAND_TYPE.UPDATE_DISPATCH, aggregateId:'D-1', expectedRevision:2, idempotencyKey:'ACTUAL-OK', deviceId:'PC-A' });
commitCentralCommand(state, {
  idempotencyKey:'ACTUAL-OK', leaseToken:actualLease.leaseToken, fingerprint:actualLease.fingerprint,
  mutations:[
    { entityType:'DISPATCH_DECISION', entityId:'D-1', revision:3, payload:{ dispatchId:'D-1', status:'READY_TO_CONFIRM', revision:3, localOnly:true } },
    { entityType:'DISPATCH_LINE', entityId:'DL-1', revision:3, payload:{ dispatchLineId:'DL-1', dispatchId:'D-1', orderItemId:'OI-1', actualProductId:'P-1', actualQuantity:6, actualBaseQuantity:6, recognizedOrderQuantity:6, localOnly:true } },
    { entityType:'DISPATCH_STOCK_ALLOCATION', entityId:'DA-1', revision:3, payload:{ allocationId:'DA-1', dispatchId:'D-1', dispatchLineId:'DL-1', warehouseId:'W-1', reservationId:'IR-1', actualBaseQuantity:6, localOnly:true } }
  ]
});

const confirmSource = { commandType:OFFICIAL_COMMAND_TYPE.CONFIRM_DISPATCH, aggregateId:'D-1', expectedRevision:3, idempotencyKey:'CONFIRM-A', deviceId:'PC-A' };
const confirmLease = prepareCentralCommand(state, confirmSource);
const confirmMutations = [
  { entityType:'DISPATCH_DECISION', entityId:'D-1', revision:4, payload:{ dispatchId:'D-1', status:'CONFIRMED', revision:4, localOnly:true } },
  { entityType:'SALES_DOCUMENT', entityId:'SD-1', revision:4, payload:{ salesDocumentId:'SD-1', dispatchId:'D-1', status:'CONFIRMED', erpPostingStatus:'READY', localOnly:true } },
  { entityType:'SALES_LINE', entityId:'SL-1', revision:4, payload:{ salesLineId:'SL-1', salesDocumentId:'SD-1', dispatchLineId:'DL-1', orderItemId:'OI-1', productId:'P-1', warehouseId:'W-1', actualQuantity:6, actualBaseQuantity:6, recognizedOrderQuantity:6, supplyAmountWon:0, vatAmountWon:'', localOnly:true } },
  { entityType:'INVENTORY_MOVEMENT', entityId:'IM-1', revision:4, payload:{ movementId:'IM-1', dispatchId:'D-1', dispatchLineId:'DL-1', sourceLineId:'DA-1', productId:'P-1', warehouseId:'W-1', movementType:'SALE_ISSUE', signedBaseQuantity:-6, ledgerSequence:999, occurredAt:'2026-08-14', localOnly:true } },
  { entityType:'ORDER_EVENT', entityId:'OE-1', revision:4, payload:{ eventId:'OE-1', orderId:'O-1', eventType:'SALES_TRANSFER_ALLOCATED', detail:{ orderItemId:'OI-1', salesLineId:'SL-1', transferredQty:6 }, localOnly:true } },
  { entityType:'INVENTORY_RESERVATION', entityId:'IR-1', revision:4, payload:{ reservationId:'IR-1', dispatchId:'D-1', allocationId:'DA-1', productId:'P-1', warehouseId:'W-1', reservedBaseQuantity:6, consumedBaseQuantity:6, status:'CONSUMED', localOnly:true } }
];
const beforeFailure = JSON.stringify(state);
assert.throws(() => commitCentralCommand(state, {
  idempotencyKey:'CONFIRM-A', leaseToken:confirmLease.leaseToken, fingerprint:confirmLease.fingerprint,
  mutations:confirmMutations.map(row => row.entityId === 'IM-1' ? { ...row, payload:{ ...row.payload, signedBaseQuantity:-999 } } : row)
}), /CONFIRM_MOVEMENT_QUANTITY_MISMATCH/);
assert.equal(JSON.stringify(state), beforeFailure);
assert.throws(() => commitCentralCommand(state, {
  idempotencyKey:'CONFIRM-A', leaseToken:confirmLease.leaseToken, fingerprint:confirmLease.fingerprint, mutations:confirmMutations
}, { failureAt:'ENTITIES_WRITTEN' }), /FAILURE_INJECTED/);
assert.equal(JSON.stringify(state), beforeFailure);
const confirmed = commitCentralCommand(state, {
  idempotencyKey:'CONFIRM-A', leaseToken:confirmLease.leaseToken, fingerprint:confirmLease.fingerprint, mutations:confirmMutations
});
assert.equal(confirmed.ledgerSequence, 1);
assert.equal(confirmed.changes.find(row => row.entityId === 'IM-1').payload.ledgerSequence, 1);
const confirmedRetry = commitCentralCommand(state, {
  idempotencyKey:'CONFIRM-A', leaseToken:confirmLease.leaseToken, fingerprint:confirmLease.fingerprint, mutations:confirmMutations
});
assert.equal(confirmedRetry.duplicate, true);
assert.equal(state.ledgerSequence, 1);
assert.throws(() => commitCentralCommand(state, {
  idempotencyKey:'CONFIRM-A', leaseToken:confirmLease.leaseToken, fingerprint:confirmLease.fingerprint,
  mutations:confirmMutations.map(row => row.entityId === 'SL-1'
    ? { ...row, payload:{ ...row.payload, actualQuantity:5 } }
    : row)
}), /MUTATION_IDEMPOTENCY_CONFLICT/);
assert.equal(state.ledgerSequence, 1);

const dispatchReverseState = createCentralAuthorityState(state);
const dispatchReverseLease = prepareCentralCommand(dispatchReverseState, {
  commandType:OFFICIAL_COMMAND_TYPE.REVERSE_DISPATCH, aggregateId:'D-1', expectedRevision:4,
  idempotencyKey:'REVERSE-D-1', deviceId:'PC-A', intent:{ quantity:6 }
});
const dispatchReversed = commitCentralCommand(dispatchReverseState, {
  idempotencyKey:'REVERSE-D-1', leaseToken:dispatchReverseLease.leaseToken, fingerprint:dispatchReverseLease.fingerprint,
  mutations:[
    { entityType:'DISPATCH_DECISION', entityId:'D-1-R', revision:1, payload:{ dispatchId:'D-1-R', status:'CONFIRMED', reversalOf:'D-1', revision:1, localOnly:true } },
    { entityType:'SALES_DOCUMENT', entityId:'SD-1-R', revision:1, payload:{ salesDocumentId:'SD-1-R', dispatchId:'D-1-R', status:'REVERSED', reversalOf:'SD-1', erpPostingStatus:'READY', localOnly:true } },
    { entityType:'SALES_LINE', entityId:'SL-1-R', revision:1, payload:{ salesLineId:'SL-1-R', salesDocumentId:'SD-1-R', dispatchLineId:'DL-1-R', status:'REVERSED', reversalOf:'SL-1', actualQuantity:-6, actualBaseQuantity:-6, recognizedOrderQuantity:-6, localOnly:true } },
    { entityType:'INVENTORY_MOVEMENT', entityId:'IM-1-R', revision:1, payload:{ movementId:'IM-1-R', dispatchLineId:'DL-1-R', productId:'P-1', warehouseId:'W-1', movementType:'REVERSAL', signedBaseQuantity:6, reversalOf:'IM-1', localOnly:true } },
    { entityType:'ORDER_EVENT', entityId:'OE-1-R', revision:1, payload:{ eventId:'OE-1-R', orderId:'O-1', eventType:'SALES_TRANSFER_REVERSED', detail:{ orderItemId:'OI-1', salesLineId:'SL-1-R', transferredQty:6 }, localOnly:true } }
  ]
});
assert.equal(dispatchReversed.ledgerSequence, 2);
assert.equal(dispatchReversed.changes.find(row => row.entityId === 'IM-1-R').payload.signedBaseQuantity, 6);

const purchaseReverseState = createCentralAuthorityState({ ledgerSequence:3, entities:{
  [key('PURCHASE_DOCUMENT','PD-R')]:{ entityType:'PURCHASE_DOCUMENT', entityId:'PD-R', revision:2, status:'CONFIRMED', payload:{ purchaseDocumentId:'PD-R', status:'CONFIRMED', revision:2, erpPostingStatus:'READY' } },
  [key('PURCHASE_LINE','PL-R')]:{ entityType:'PURCHASE_LINE', entityId:'PL-R', revision:2, status:'CONFIRMED', payload:{ purchaseLineId:'PL-R', purchaseDocumentId:'PD-R', productId:'P-1', warehouseId:'W-1', quantity:5, baseQuantity:5, amountWon:0, movementId:'PIM-1', status:'CONFIRMED' } },
  [key('INVENTORY_MOVEMENT','PIM-1')]:{ entityType:'INVENTORY_MOVEMENT', entityId:'PIM-1', revision:3, status:'ACTIVE', payload:{ movementId:'PIM-1', productId:'P-1', warehouseId:'W-1', movementType:'PURCHASE_RECEIPT', signedBaseQuantity:5, ledgerSequence:3 } }
} });
const purchaseReverseLease = prepareCentralCommand(purchaseReverseState, {
  commandType:OFFICIAL_COMMAND_TYPE.REVERSE_PURCHASE, aggregateId:'PD-R', expectedRevision:2,
  idempotencyKey:'REVERSE-PD-R', deviceId:'PC-B', intent:{ quantity:5 }
});
const purchaseReversed = commitCentralCommand(purchaseReverseState, {
  idempotencyKey:'REVERSE-PD-R', leaseToken:purchaseReverseLease.leaseToken, fingerprint:purchaseReverseLease.fingerprint,
  mutations:[
    { entityType:'PURCHASE_DOCUMENT', entityId:'PD-R-R', revision:1, payload:{ purchaseDocumentId:'PD-R-R', status:'REVERSED', reversalOf:'PD-R', erpPostingStatus:'READY', revision:1, localOnly:true } },
    { entityType:'PURCHASE_LINE', entityId:'PL-R-R', revision:1, payload:{ purchaseLineId:'PL-R-R', purchaseDocumentId:'PD-R-R', status:'REVERSED', reversalOf:'PL-R', productId:'P-1', warehouseId:'W-1', quantity:-5, baseQuantity:-5, amountWon:0, movementId:'PIM-1-R', localOnly:true } },
    { entityType:'INVENTORY_MOVEMENT', entityId:'PIM-1-R', revision:1, payload:{ movementId:'PIM-1-R', sourceLineId:'PL-R-R', productId:'P-1', warehouseId:'W-1', movementType:'REVERSAL', signedBaseQuantity:-5, reversalOf:'PIM-1', localOnly:true } }
  ]
});
assert.equal(purchaseReversed.ledgerSequence, 4);
assert.equal(purchaseReversed.changes.find(row => row.entityId === 'PIM-1-R').payload.signedBaseQuantity, -5);

const erpLease = prepareCentralCommand(state, {
  commandType:OFFICIAL_COMMAND_TYPE.ERP_TRANSITION, aggregateId:'ERP-BATCH-1', expectedRevision:1,
  idempotencyKey:'ERP-EXPORT-1', deviceId:'PC-A', intent:{ documentIds:['SD-1'], nextStatus:'EXPORTED' }
});
const erpCommitted = commitCentralCommand(state, {
  idempotencyKey:'ERP-EXPORT-1', leaseToken:erpLease.leaseToken, fingerprint:erpLease.fingerprint,
  mutations:[{ entityType:'SALES_DOCUMENT', entityId:'SD-1', revision:5, payload:{
    ...state.entities[key('SALES_DOCUMENT','SD-1')].payload,
    erpPostingStatus:'EXPORTED', baseRevision:4, revision:5, erpExportBatchId:'ERP-BATCH-1'
  } }]
});
assert.equal(erpCommitted.changes[0].payload.erpPostingStatus, 'EXPORTED');
const staleErpLease = prepareCentralCommand(state, {
  commandType:OFFICIAL_COMMAND_TYPE.ERP_TRANSITION, aggregateId:'ERP-BATCH-STALE', expectedRevision:1,
  idempotencyKey:'ERP-POST-STALE', deviceId:'PC-B', intent:{ documentIds:['SD-1'], nextStatus:'POSTED' }
});
assert.throws(() => commitCentralCommand(state, {
  idempotencyKey:'ERP-POST-STALE', leaseToken:staleErpLease.leaseToken, fingerprint:staleErpLease.fingerprint,
  mutations:[{ entityType:'SALES_DOCUMENT', entityId:'SD-1', revision:6, payload:{
    ...state.entities[key('SALES_DOCUMENT','SD-1')].payload,
    erpPostingStatus:'POSTED', baseRevision:4, revision:6, erpDocumentNo:'ERP-77'
  } }]
}), /ERP_TRANSITION_INVALID/);
abortCentralCommand(state, { idempotencyKey:'ERP-POST-STALE', leaseToken:staleErpLease.leaseToken, reason:'stale ERP revision' });

const projectionState = createCentralAuthorityState({ entities:{
  [key('INVENTORY_SNAPSHOT','IS-W')]:{ entityType:'INVENTORY_SNAPSHOT', entityId:'IS-W', payload:{ inventorySnapshotId:'IS-W', importBatchId:'IB-W', basisDate:'2026-08-15', snapshotLastSequence:5, status:'ACTIVE' } },
  [key('INVENTORY_LINE','IL-W')]:{ entityType:'INVENTORY_LINE', entityId:'IL-W', payload:{ inventoryLineId:'IL-W', inventorySnapshotId:'IS-W', productId:'P-W', warehouseId:'W-W', inventoryQuantity:5, status:'ACTIVE' } },
  [key('INVENTORY_MOVEMENT','IM-OLD')]:{ entityType:'INVENTORY_MOVEMENT', entityId:'IM-OLD', payload:{ movementId:'IM-OLD', productId:'P-W', warehouseId:'W-W', signedBaseQuantity:100, ledgerSequence:5, status:'ACTIVE' } },
  [key('INVENTORY_MOVEMENT','IM-NEW')]:{ entityType:'INVENTORY_MOVEMENT', entityId:'IM-NEW', payload:{ movementId:'IM-NEW', productId:'P-W', warehouseId:'W-W', signedBaseQuantity:-8, ledgerSequence:6, status:'ACTIVE' } }
} });
const watermarkProjection = centralInventoryProjection(projectionState)[0];
assert.equal(watermarkProjection.onHandQuantity, -3);
assert.equal(watermarkProjection.negativeOnHand, true);
assert.deepEqual(watermarkProjection.movementEvidence.map(row => row.movementId), ['IM-NEW']);

const pulled = pullCentralChanges(state, 0, 1000);
assert.equal(pulled.ledgerSequence, 1);
assert.equal(new Set(pulled.changes.map(row => row.sequence)).size, pulled.changes.length);

const salesDocument = { ...state.entities[key('SALES_DOCUMENT','SD-1')].payload, erpPostingStatus:'READY' };
const salesLine = state.entities[key('SALES_LINE','SL-1')].payload;
const rows = buildErpExportRows({ salesDocuments:[salesDocument], salesLines:[salesLine] });
assert.equal(rows.sales[0].supplyAmountWon, 0);
assert.equal(rows.sales[0].vatAmountWon, '');
assert.equal(rows.sales[0].externalLineNo, '');
assert.equal(rows.sales[0].actualBaseQuantity, 6);
assert.equal(rows.sales[0].recognizedOrderQuantity, 6);
const workbookNames = createErpWorkbookBuffer(rows, {
  utils:{ book_new:()=>({ names:[] }), json_to_sheet:value=>value, book_append_sheet:(book, _sheet, name)=>book.names.push(name) },
  write:book=>book.names
});
assert.deepEqual(workbookNames, ['판매','구매']);
const candidate = { ...rows.sales[0], externalDocumentNo:'ERP-77', externalLineNo:'0' };
assert.equal(reconcileErpImportRows([{ ...candidate }], [candidate])[0].status, ERP_MATCH_STATUS.EXACT);
assert.equal(reconcileErpImportRows([{ ...candidate, erpPostingStatus:'READY' }], [{ ...candidate, erpPostingStatus:'EXPORTED' }])[0].status, ERP_MATCH_STATUS.EXACT);
for (const field of ['recognizedOrderQuantity','supplyAmountWon','vatAmountWon','totalAmountWon']) {
  const changed = { ...candidate, [field]:Number(candidate[field] || 0) + 999 };
  assert.equal(reconcileErpImportRows([changed], [candidate])[0].status, ERP_MATCH_STATUS.CONTENT_CONFLICT, field);
}
assert.equal(reconcileErpImportRows([{ ...candidate, orderqDocumentId:'', orderqLineId:'', originTransactionId:'', originLineId:'', externalDocumentNo:'', externalLineNo:'' }], [candidate])[0].status, ERP_MATCH_STATUS.REVIEW_REQUIRED);
const twoLineCandidates = [candidate, { ...candidate, orderqLineId:'SL-2', originLineId:'SL-2', externalLineNo:'1', productId:'P-2' }];
const exactTwoRows = twoLineCandidates.map(row => ({ ...row, externalDocumentNo:'ERP-TWO' }));
const exactTwoMatches = reconcileErpImportRows(exactTwoRows, twoLineCandidates);
assert.equal(evaluateErpDocumentMatches(exactTwoMatches, twoLineCandidates)[0].status, ERP_MATCH_STATUS.EXACT);
const conflictingTwoRows = [exactTwoRows[0], { ...exactTwoRows[1], recognizedOrderQuantity:999 }];
assert.equal(evaluateErpDocumentMatches(reconcileErpImportRows(conflictingTwoRows, twoLineCandidates), twoLineCandidates)[0].status, ERP_MATCH_STATUS.REVIEW_REQUIRED);
assert.equal(evaluateErpDocumentMatches(reconcileErpImportRows([exactTwoRows[0]], twoLineCandidates), twoLineCandidates)[0].status, ERP_MATCH_STATUS.REVIEW_REQUIRED);
assert.equal(evaluateErpDocumentMatches(reconcileErpImportRows([...exactTwoRows, exactTwoRows[0]], twoLineCandidates), twoLineCandidates)[0].status, ERP_MATCH_STATUS.REVIEW_REQUIRED);
const exported = transitionErpPostingStatus(salesDocument, 'EXPORTED', { erpExportBatchId:'B-1', at:'2026-08-15T00:00:00Z', actorId:'ADMIN' });
const posted = transitionErpPostingStatus(exported, 'POSTED', { erpDocumentNo:'ERP-77', at:'2026-08-15T01:00:00Z', actorId:'ADMIN' });
const reconciled = transitionErpPostingStatus(posted, 'RECONCILED', { erpDocumentNo:'ERP-77', at:'2026-08-15T02:00:00Z', actorId:'ADMIN' });
const correction = transitionErpPostingStatus(reconciled, 'CORRECTION_REQUIRED', { erpDocumentNo:'ERP-77' });
assert.equal(correction.originalErpDocumentNo, 'ERP-77');
assert.equal(correction.erpAutoCancelRequested, false);
assert.equal(correction.erpAutoRetransmitRequested, false);
assert.deepEqual(correction.history.map(row => row.eventType), ['ERP_EXPORTED','ERP_POSTED','ERP_RECONCILED','ERP_CORRECTION_REQUIRED']);

const [codeGs, cloudGs, gateway, adapter, policy, erpUi, dispatchUi, purchaseUi, reconciliationUi] = await Promise.all([
  read('code.gs'), read('orderq-cloud.gs'), read('orderq/central-command-gateway.js'),
  read('orderq/orderq-cloud-adapter.js'), read('orderq/official-command-policy.js'), read('orderq/erp-ui.js'),
  read('orderq/dispatch-ui.js'), read('orderq/purchase-ui.js'), read('orderq/reconciliation-ui.js')
]);
new vm.Script(codeGs, { filename:'code.gs' });
new vm.Script(cloudGs, { filename:'orderq-cloud.gs' });
for (const action of ['orderq_m9_ping','orderq_m9_migrate','orderq_m9_command_prepare','orderq_m9_command_commit','orderq_m9_command_abort','orderq_m9_pull']) {
  assert.ok(codeGs.includes(`action === '${action}'`), `missing M9 server route: ${action}`);
  assert.ok(adapter.includes(`'${action}'`), `missing M9 client action: ${action}`);
}
assert.match(codeGs, /withScriptLock\(\(\) => jsonResponse/);
assert.match(cloudGs, /inventoryResourceFingerprint/);
assert.match(cloudGs, /delete row\.payload\.ledgerSequence/);
assert.match(cloudGs, /ORDERQ_CENTRAL_INVENTORY_REVISION_CONFLICT/);
assert.match(cloudGs, /leaseExpiresAt/);
assert.match(cloudGs, /ORDERQ_CENTRAL_COMMAND_TERMINAL/);
assert.match(cloudGs, /ORDERQ_CENTRAL_CONFIRM_MOVEMENT_QUANTITY_MISMATCH/);
assert.match(gateway, /ORDERQ_CENTRAL_OFFLINE_OFFICIAL_COMMAND_BLOCKED/);
assert.match(gateway, /await pullCentralOfficialState\(\)/);
assert.match(gateway, /row\?\.localOnly === false/);
assert.match(gateway, /restoreStores\(before\)/);
assert.match(erpUi, /reconciliation\.documents\.filter\(row => row\.status === 'EXACT'\)/);
assert.match(erpUi, /flatMap\(row => row\.exactRows\.map/);
assert.match(policy, /ORDERQ_CENTRAL_AUTHORITY_REQUIRED/);
assert.match(policy, /typeof window !== 'undefined'/);
assert.doesNotMatch(erpUi, /auto.*merge/i);
for (const source of [dispatchUi, purchaseUi, reconciliationUi]) {
  assert.match(source, /\['127\.0\.0\.1', 'localhost'\]\.includes\(location\.hostname\)/, 'legacy local test bypass must be localhost-only');
  assert.match(source, /runOfficialCommand/);
}

console.log('ORDER Q M9 central authority, multi-client convergence and ERP boundary contract tests passed');
