import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  CUTOVER_MODE,
  assertLocalOfficialWriteEnabled,
  cutoverRoute,
  evaluateCutoverBoundary,
  readCutoverControl,
  setCutoverMode
} from '../orderq/cutover-control.js';
import {
  compareShadowFacts,
  normalizeDataOpsShadowRows,
  normalizeLegacyShadowRows,
  normalizeOrderQShadowRows
} from '../orderq/shadow-comparison.js';
import { validateAndSelectLegacyWorkspaceRows } from '../orderq/transition-repository.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = require(path.join(ROOT, 'orderFulfillmentEngine.js'));

function recoveryV2({ recordId, sourceFingerprint, updatedAt, basisDate = '2026-08-16' }) {
  const workspace = {
    schemaVersion: engine.WORKSPACE_SCHEMA_VERSION,
    sourceFingerprint,
    basisDate,
    sourceFiles: {}, inventory: [], orders: [], orderOpsInputs: { purchases:{ rows:[] }, sales:{ rows:[] } }
  };
  const payload = {
    schemaVersion: 'shipping-local-recovery-payload/v2',
    sourceFingerprint,
    workspaceSchemaVersion: workspace.schemaVersion,
    updatedAt,
    workspace,
    ui: { activePreview:'validation' },
    settings: { cloudUrl:'', savedBy:'ADMIN' }
  };
  return {
    schemaVersion: 'shipping-local-recovery/v2', recordId, sourceFingerprint, updatedAt,
    hashAlgorithm: 'SHA-256',
    payloadSha256: crypto.createHash('sha256').update(engine.canonicalStringify(payload)).digest('hex'),
    payload
  };
}

const validRecovery = recoveryV2({
  recordId:'RECOVERY-VALID', sourceFingerprint:'a'.repeat(64), updatedAt:'2026-08-16T08:00:00.000Z'
});
const corruptStructure = structuredClone(validRecovery);
Object.assign(corruptStructure, { recordId:'RECOVERY-CORRUPT-STRUCTURE', updatedAt:'2099-03-01T00:00:00.000Z', schemaVersion:'wrong/v2' });
corruptStructure.payload.updatedAt = corruptStructure.updatedAt;
const corruptHash = structuredClone(validRecovery);
Object.assign(corruptHash, { recordId:'RECOVERY-CORRUPT-HASH', updatedAt:'2099-02-01T00:00:00.000Z' });
corruptHash.payload.updatedAt = corruptHash.updatedAt;
corruptHash.payload.workspace.basisDate = '2099-02-01';
const corruptFingerprint = structuredClone(validRecovery);
Object.assign(corruptFingerprint, { recordId:'RECOVERY-CORRUPT-FINGERPRINT', sourceFingerprint:'b'.repeat(64), updatedAt:'2099-01-01T00:00:00.000Z' });
corruptFingerprint.payload.updatedAt = corruptFingerprint.updatedAt;
corruptFingerprint.payloadSha256 = crypto.createHash('sha256').update(engine.canonicalStringify(corruptFingerprint.payload)).digest('hex');
const validLegacy = {
  schemaVersion:'shipping-local-recovery/v1', sourceFingerprint:'c'.repeat(64),
  workspaceSchemaVersion:engine.WORKSPACE_SCHEMA_VERSION, updatedAt:'2026-08-15T08:00:00.000Z',
  workspace:{ schemaVersion:engine.WORKSPACE_SCHEMA_VERSION, sourceFingerprint:'c'.repeat(64), basisDate:'2026-08-15' }
};
const recoverySelection = await validateAndSelectLegacyWorkspaceRows({
  recoveryRows:[validRecovery, corruptStructure, corruptHash, corruptFingerprint],
  legacyRows:[validLegacy], engine
});
assert.equal(recoverySelection.selected.recordId, 'RECOVERY-VALID', 'latest corrupt recovery must not replace the latest valid recovery');
assert.equal(recoverySelection.validation.corruptionCount, 3);
assert.deepEqual(new Set(recoverySelection.validation.corruptions.map(row => row.reason)), new Set([
  'V2_SCHEMA_INVALID', 'V2_PAYLOAD_HASH_MISMATCH', 'V2_SOURCE_FINGERPRINT_MISMATCH'
]));
const noValidRecovery = await validateAndSelectLegacyWorkspaceRows({ recoveryRows:[corruptHash], legacyRows:[], engine });
assert.equal(noValidRecovery.selected, null, 'corrupt-only recovery input must fail closed');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const storage = new MemoryStorage();
assert.equal(readCutoverControl(storage).mode, CUTOVER_MODE.SHADOW);
assert.throws(
  () => assertLocalOfficialWriteEnabled('CONFIRM_DISPATCH', storage),
  /ORDERQ_CUTOVER_LOCAL_WRITE_BLOCKED:SHADOW:CONFIRM_DISPATCH/
);

const pilot = setCutoverMode({
  mode: CUTOVER_MODE.PILOT_WRITE,
  actorId: 'ADMIN',
  reasonCode: 'M10_PILOT',
  reasonNote: '관리자 감독형',
  expectedRevision: 0,
  changedAt: '2026-08-16T08:00:00.000Z',
  storage
});
assert.equal(pilot.mode, CUTOVER_MODE.PILOT_WRITE);
assert.equal(pilot.revision, 1);
assert.equal(pilot.history.length, 1);
assert.equal(assertLocalOfficialWriteEnabled('CONFIRM_DISPATCH', storage).mode, CUTOVER_MODE.PILOT_WRITE);
assert.throws(() => setCutoverMode({
  mode: CUTOVER_MODE.SHADOW,
  actorId: 'ADMIN', reasonCode: 'ROLLBACK', expectedRevision: 0, storage
}), /ORDERQ_CUTOVER_REVISION_CONFLICT:1/);

const rolledBack = setCutoverMode({
  mode: CUTOVER_MODE.LEGACY_PRIMARY,
  actorId: 'ADMIN', reasonCode: 'IMMEDIATE_ROLLBACK', expectedRevision: 1,
  changedAt: '2026-08-16T08:01:00.000Z', storage
});
assert.equal(rolledBack.mode, CUTOVER_MODE.LEGACY_PRIMARY);
assert.equal(rolledBack.history[1].fromMode, CUTOVER_MODE.PILOT_WRITE);
assert.equal(cutoverRoute(rolledBack.mode), '../orderops/list.html');
assert.deepEqual(evaluateCutoverBoundary('PILOT_WRITE', 'SHADOW'), {
  localMode: 'PILOT_WRITE', centralMode: 'SHADOW', writeAllowed: false,
  mismatch: true, reasonCode: 'CENTRAL_MODE_BLOCKED'
});
assert.equal(evaluateCutoverBoundary('PILOT_WRITE', 'PILOT_WRITE').writeAllowed, true);

const legacyRows = normalizeLegacyShadowRows([{
  productCode: '0001', productName: '상품 1', stockQuantity: 10,
  inboundQuantity: 2, orderQuantity: 4, salesQuantity: 2,
  remainingQuantity: 6,
  sourceRowId: 'LEGACY-ROW-1'
}, {
  productCode: '0002', productName: '상품 2', stockQuantity: 0,
  inboundQuantity: 0, orderQuantity: 2, salesQuantity: 1,
  remainingQuantity: -2,
  sourceRowId: 'LEGACY-ROW-2'
}], { basisDate: '2026-08-16', sourceFingerprint: 'LEGACY-SOURCE' });

const orderQRows = normalizeOrderQShadowRows({
  basis: { basisDate: '2026-08-16' },
  rows: [{
    productCode: '0001', productId: 'P1', snapshotQuantity: 10,
    snapshotLastSequence: 0, reservedQuantity: 4, onHandQuantity: 10, availableQuantity: 6,
    snapshotEvidence: [{ inventorySnapshotId: 'IS1', inventoryLineId: 'IL1' }],
    movementEvidence: [
      { movementId: 'PM1', movementType: 'PURCHASE_RECEIPT', signedBaseQuantity: 2, sourceLineId: 'PL1' },
      { movementId: 'SM1', movementType: 'SALE_ISSUE', signedBaseQuantity: -3, sourceLineId: 'DL1' },
      { movementId: 'RM1', movementType: 'REVERSAL', sourceDocumentType: 'DISPATCH_REVERSAL', signedBaseQuantity: 1, sourceLineId: 'DLR1', reversalOf: 'SM1' }
    ],
    reservationEvidence: [{ reservationId: 'IR1', allocationId: 'DA1' }]
  }, {
    productCode: '0002', productId: 'P2', snapshotQuantity: 0,
    snapshotLastSequence: 0, reservedQuantity: 0, onHandQuantity: -1, availableQuantity: -1,
    snapshotEvidence: [{ inventorySnapshotId: 'IS1', inventoryLineId: 'IL2' }],
    movementEvidence: [{ movementId: 'SM2', movementType: 'SALE_ISSUE', signedBaseQuantity: -1 }]
  }]
});

const dataOpsRows = normalizeDataOpsShadowRows([{
  batchKey:'DATAOPS-ROW-1', 코드:'0001', 품명:'상품 1',
  기초:10, 입고:2, 출고:2, 대체입고:0, 대체출고:0, 실사:10, 로스:0, 이슈:[]
}, {
  batchKey:'DATAOPS-ROW-2', 코드:'0002', 품명:'상품 2',
  기초:0, 입고:0, 출고:1, 대체입고:0, 대체출고:0, 실사:-1, 로스:0, 이슈:[]
}], { savedAt:'2026-08-16T08:00:00.000Z', sourceFingerprint:'DATAOPS-SOURCE', substHistory:[] });

const report = compareShadowFacts({ legacyRows, orderQRows, dataOpsRows, requireDataOpsEvidence:true });
const matched = report.rows.find(row => row.productKey === '0001');
const requestDifference = report.rows.find(row => row.productKey === '0002');
assert.equal(matched.matched, true);
assert.deepEqual(matched.axes.actualSale, { legacy: 2, orderq: 2 });
assert.deepEqual(matched.axes.onHand, { legacy: 10, orderq: 10 });
assert.deepEqual(matched.axes.available, { legacy: 6, orderq: 6 });
assert.deepEqual(matched.axes.orderOpsCurrentAvailable, { legacy: 6, orderq: 6 });
assert.deepEqual(matched.axes.dataOpsCurrentOnHand, { legacy: 10, orderq: 10 });
assert.deepEqual(matched.axes.adjustment, { legacy: 0, orderq: 0 });
assert.equal(matched.evidenceIds.dataops.includes('DATAOPS-ROW-1'), true);
assert.deepEqual(matched.evidenceIds.orderq, ['DA1', 'DL1', 'DLR1', 'IL1', 'IR1', 'IS1', 'PL1', 'PM1', 'RM1', 'SM1']);
assert.equal(requestDifference.matched, false);
assert.ok(requestDifference.reasonCodes.includes('REQUEST_RESERVATION_DIFFERENCE'));
assert.ok(requestDifference.reasonCodes.includes('ORDER_REQUEST_NOT_SALE'));
assert.deepEqual(requestDifference.axes.onHand, { legacy: -1, orderq: -1 });
assert.deepEqual(requestDifference.axes.available, { legacy: -3, orderq: -1 });
assert.equal(report.summary.total, 2);
assert.equal(report.summary.matched, 1);
assert.equal(report.summary.differences, 1);

const dataOpsOnlyRows = normalizeDataOpsShadowRows([{
  batchKey:'DATAOPS-ONLY', 코드:'DATAOPS-ONLY', 품명:'DataOps 전용', 기초:1, 실사:1
}], { savedAt:'2026-08-16T08:00:00.000Z', sourceFingerprint:'DATAOPS-ONLY-SOURCE' });
const boundedPopulation = compareShadowFacts({
  legacyRows,
  orderQRows,
  dataOpsRows:[...dataOpsRows, ...dataOpsOnlyRows],
  requireDataOpsEvidence:true
});
assert.equal(boundedPopulation.summary.total, 2, 'DataOps-only rows must not expand the cutover population');
assert.equal(boundedPopulation.rows.some(row => row.productKey === 'DATAOPS-ONLY'), false);

const missing = compareShadowFacts({ legacyRows, orderQRows: orderQRows.slice(0, 1) });
assert.ok(missing.rows.find(row => row.productKey === '0002').reasonCodes.includes('MAPPING_MISSING'));

const legacyWithoutCurrentRemaining = normalizeLegacyShadowRows([{
  productCode:'0001', stockQuantity:10, inboundQuantity:2, salesQuantity:2, orderQuantity:4
}], { basisDate:'2026-08-16', sourceFingerprint:'LEGACY-NO-CURRENT' });
const withoutCurrentReport = compareShadowFacts({
  legacyRows:legacyWithoutCurrentRemaining,
  orderQRows:orderQRows.slice(0, 1)
});
assert.equal(withoutCurrentReport.rows[0].axes.orderOpsCurrentAvailable.legacy, null);
assert.equal(withoutCurrentReport.rows[0].reasonCodes.includes('ORDEROPS_CURRENT_AVAILABLE_DIFFERENCE'), false);

const manualAdjustmentLegacy = normalizeLegacyShadowRows([{
  productCode:'101018136', productName:'양파_kg', stockQuantity:10,
  inboundQuantity:0, orderQuantity:0, salesQuantity:0, remainingQuantity:10,
  sourceRowId:'ORDEROPS-101018136'
}], { basisDate:'2026-08-14', sourceFingerprint:'ORDEROPS-ACTUAL' });
const manualAdjustmentDataOps = normalizeDataOpsShadowRows([{
  batchKey:'DATAOPS-LOT-101018136', 코드:'101018136', 품명:'양파_kg',
  기초:10, 입고:0, 출고:0, 대체입고:0, 대체출고:0,
  전산잔량:10, 실사:0, 로스:-10,
  _manualSubstitutionResolved:true,
  이슈:['🔄수기치환오차(-10)'], 메모:'[수기치환/오차] 실제출고 -10'
}], {
  savedAt:'2026-08-17T08:00:00.000Z',
  sourceFingerprint:'DATAOPS-ACTUAL',
  substHistory:[{
    id:'SUB-101018136', type:'MANUAL_LOSS_LINK',
    sourceKey:'DATAOPS-LOT-101018136', targetKey:'DATAOPS-LOT-TARGET', sQty:10, tQty:10
  }]
});
const manualAdjustmentOrderQ = normalizeOrderQShadowRows({
  basis:{ basisDate:'2026-08-16' },
  rows:[{
    productCode:'101018136', productId:'P-101018136', snapshotQuantity:10,
    snapshotLastSequence:0, reservedQuantity:0, onHandQuantity:10, availableQuantity:10,
    snapshotEvidence:[{ inventorySnapshotId:'IS-OPENING', inventoryLineId:'IL-101018136' }],
    movementEvidence:[], reservationEvidence:[]
  }]
});
const adjustmentReport = compareShadowFacts({
  legacyRows:manualAdjustmentLegacy,
  orderQRows:manualAdjustmentOrderQ,
  dataOpsRows:manualAdjustmentDataOps,
  requireDataOpsEvidence:true
});
const adjustmentRow = adjustmentReport.rows[0];
assert.deepEqual(adjustmentRow.axes.dataOpsCurrentOnHand, { legacy:0, orderq:10 });
assert.deepEqual(adjustmentRow.axes.manualSubstitution, { legacy:-10, orderq:null });
assert.deepEqual(adjustmentRow.axes.loss, { legacy:-10, orderq:null });
assert.ok(adjustmentRow.reasonCodes.includes('DATAOPS_CURRENT_REMAINING_DIFFERENCE'));
assert.ok(adjustmentRow.reasonCodes.includes('MANUAL_SUBSTITUTION_ADJUSTMENT_PRESENT'));
assert.ok(adjustmentRow.reasonCodes.includes('INVENTORY_ADJUSTMENT_PRESENT'));
assert.ok(adjustmentRow.reasonCodes.includes('LOSS_ADJUSTMENT_PRESENT'));
assert.ok(adjustmentRow.reasonCodes.includes('ADJUSTMENT_MOVEMENT_DIFFERENCE'));
assert.ok(adjustmentRow.evidenceIds.dataops.includes('DATAOPS_HISTORY:SUB-101018136'));

console.log('PASS ORDER Q M10 operational transition contracts');
