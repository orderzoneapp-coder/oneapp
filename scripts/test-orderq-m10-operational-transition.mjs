import assert from 'node:assert/strict';
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
  normalizeLegacyShadowRows,
  normalizeOrderQShadowRows
} from '../orderq/shadow-comparison.js';

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
  sourceRowId: 'LEGACY-ROW-1'
}, {
  productCode: '0002', productName: '상품 2', stockQuantity: 0,
  inboundQuantity: 0, orderQuantity: 2, salesQuantity: 1,
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

const report = compareShadowFacts({ legacyRows, orderQRows });
const matched = report.rows.find(row => row.productKey === '0001');
const requestDifference = report.rows.find(row => row.productKey === '0002');
assert.equal(matched.matched, true);
assert.deepEqual(matched.axes.actualSale, { legacy: 2, orderq: 2 });
assert.deepEqual(matched.axes.onHand, { legacy: 10, orderq: 10 });
assert.deepEqual(matched.axes.available, { legacy: 6, orderq: 6 });
assert.deepEqual(matched.evidenceIds.orderq, ['DA1', 'DL1', 'DLR1', 'IL1', 'IR1', 'IS1', 'PL1', 'PM1', 'RM1', 'SM1']);
assert.equal(requestDifference.matched, false);
assert.ok(requestDifference.reasonCodes.includes('REQUEST_RESERVATION_DIFFERENCE'));
assert.ok(requestDifference.reasonCodes.includes('ORDER_REQUEST_NOT_SALE'));
assert.deepEqual(requestDifference.axes.onHand, { legacy: -1, orderq: -1 });
assert.deepEqual(requestDifference.axes.available, { legacy: -3, orderq: -1 });
assert.equal(report.summary.total, 2);
assert.equal(report.summary.matched, 1);
assert.equal(report.summary.differences, 1);

const missing = compareShadowFacts({ legacyRows, orderQRows: orderQRows.slice(0, 1) });
assert.ok(missing.rows.find(row => row.productKey === '0002').reasonCodes.includes('MAPPING_MISSING'));

console.log('PASS ORDER Q M10 operational transition contracts');
