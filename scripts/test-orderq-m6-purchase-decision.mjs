#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PURCHASE_CONFIRMATION_STEP,
  PURCHASE_STATUS,
  allocatePurchaseReversalAmount,
  allocatePurchaseReversalDimension,
  buildPurchaseConfirmationKey,
  buildPurchaseReversalKey,
  exactPurchaseExternalMatch,
  normalizePurchaseDraft,
  purchaseExternalReconciliationFingerprint
} from '../orderq/purchase-decision.js';

const draft = normalizePurchaseDraft({
  document: {
    purchaseDocumentId: 'PD-1', sourceShortageKey: 'SHORT:DL-1', sourceShortageQuantity: 10,
    supplierId: 'S-1', supplierName: '공급처', businessDate: '2026-08-15', actualTransactionAt: '2026-08-10T09:00:00+09:00',
    backdateReason: '구매누락 소급입력',
    idempotencyKey: 'FAKE-CONFIRM', confirmationRequestFingerprint: 'FAKE', reversalOf: 'PD-REAL',
    confirmedAt: '2026-08-15T00:00:00.000Z', confirmedBy: 'FAKE', erpDocumentNo: 'FAKE-ERP',
    erpReconciliationId: 'FAKE-RECONCILIATION', history: [{ eventType: 'FAKE' }]
  },
  lines: [{
    purchaseLineId: 'PL-1', purchaseDocumentId: 'PD-1', productId: 'P-1', warehouseId: 'W-1',
    quantity: 10, unit: 'BOX', baseQuantity: 5, baseUnit: 'KG', unitCostWon: 100,
    sourceOrderItemId: 'OI-1', sourceDispatchLineId: 'DL-1', externalLineNo: 0, sourceLineFingerprint: '0',
    movementId: 'IM-FAKE', reversalOf: 'PL-REAL', confirmedAt: '2026-08-15T00:00:00.000Z',
    confirmedBy: 'FAKE', reversalRequestFingerprint: 'FAKE', externalReconciliationId: 'FAKE'
  }],
  expectedRevision: 0
});
assert.equal(draft.document.status, PURCHASE_STATUS.DRAFT);
assert.equal(draft.lines[0].quantity, 10);
assert.equal(draft.lines[0].baseQuantity, 5);
assert.equal(draft.lines[0].amountWon, 1000);
assert.equal(draft.lines[0].externalLineNo, '0');
assert.equal(draft.lines[0].sourceLineFingerprint, '0');
for (const field of ['idempotencyKey', 'confirmationRequestFingerprint', 'reversalOf', 'confirmedAt', 'confirmedBy', 'erpDocumentNo', 'erpReconciliationId', 'history']) {
  assert.equal(Object.hasOwn(draft.document, field), false, `purchase DRAFT document retained system field ${field}`);
}
for (const field of ['movementId', 'reversalOf', 'confirmedAt', 'confirmedBy', 'reversalRequestFingerprint', 'externalReconciliationId']) {
  assert.equal(Object.hasOwn(draft.lines[0], field), false, `purchase DRAFT line retained system field ${field}`);
}

const firstBase = allocatePurchaseReversalDimension({
  originalQuantity: 10, reversedQuantity: 0, reversalQuantity: 4,
  originalDimension: 5, reversedDimension: 0
});
const finalBase = allocatePurchaseReversalDimension({
  originalQuantity: 10, reversedQuantity: 4, reversalQuantity: 6,
  originalDimension: 5, reversedDimension: firstBase
});
assert.deepEqual([firstBase, finalBase], [2, 3]);
const firstAmount = allocatePurchaseReversalAmount({
  originalQuantity: 3, reversedQuantity: 0, reversalQuantity: 1,
  originalAmountWon: 2, reversedAmountWon: 0
});
const secondAmount = allocatePurchaseReversalAmount({
  originalQuantity: 3, reversedQuantity: 1, reversalQuantity: 1,
  originalAmountWon: 2, reversedAmountWon: firstAmount.amountWon
});
const finalAmount = allocatePurchaseReversalAmount({
  originalQuantity: 3, reversedQuantity: 2, reversalQuantity: 1,
  originalAmountWon: 2, reversedAmountWon: firstAmount.amountWon + secondAmount.amountWon
});
assert.equal(firstAmount.amountWon + secondAmount.amountWon + finalAmount.amountWon, 2);

const storedLines = [{ purchaseLineId: 'PL-1', productId: 'P-1', warehouseId: 'W-1', quantity: 10, baseQuantity: 5, unitCostWon: 100 }];
const exactExternalLines = [{ originPurchaseLineId: 'PL-1', externalLineNo: 0, productId: 'P-1', warehouseId: 'W-1', quantity: 10, baseQuantity: 5, unitCostWon: 100 }];
assert.equal(exactPurchaseExternalMatch(storedLines, exactExternalLines), true);
assert.equal(exactPurchaseExternalMatch(storedLines, [{ ...exactExternalLines[0], quantity: 9 }]), false);
assert.notEqual(
  purchaseExternalReconciliationFingerprint({ originSystem: 'ORDER_Q', originTransactionId: 'PD-1', externalDocumentNo: 0, lines: exactExternalLines }),
  purchaseExternalReconciliationFingerprint({ originSystem: 'ORDER_Q', originTransactionId: 'PD-1', externalDocumentNo: '0', lines: [{ ...exactExternalLines[0], quantity: 9 }] })
);
assert.equal(buildPurchaseConfirmationKey('PD-1', 2), 'PURCHASE_CONFIRM:PD-1:2');
assert.equal(buildPurchaseReversalKey('PD-1', 3, 'PART-1'), 'PURCHASE_REVERSE:PD-1:3:PART-1');
assert.deepEqual(Object.values(PURCHASE_CONFIRMATION_STEP), ['DOCUMENT_WRITTEN', 'MOVEMENTS_WRITTEN', 'OUTBOX_WRITTEN', 'BEFORE_COMMIT']);

const repositorySource = await readFile(new URL('../orderq/purchase-decision-repository.js', import.meta.url), 'utf8');
for (const command of ['savePurchaseDraft', 'createPurchaseDraftFromShortage', 'confirmPurchase', 'reversePurchase', 'reconcilePurchaseExternal']) {
  assert.match(repositorySource, new RegExp(`export async function ${command}`));
}
assert.match(repositorySource, /PURCHASE_RECEIPT/);
assert.match(repositorySource, /status: 'LOCAL_ONLY'/);
assert.doesNotMatch(repositorySource, /confirmDispatch\s*\(/, 'purchase confirmation must not invoke dispatch confirmation');
assert.doesNotMatch(repositorySource, /ERP_POSTING_STATUS\.(POSTED|RECONCILED|CORRECTION_REQUIRED)/);

console.log('ORDER Q M6 purchase decision, confirmation, reconciliation and reversal contract tests passed');
console.log(JSON.stringify({
  draft: { quantity: draft.lines[0].quantity, baseQuantity: draft.lines[0].baseQuantity, shortageKey: draft.document.sourceShortageKey },
  reversal: { firstBase, finalBase, roundedAmounts: [firstAmount.amountWon, secondAmount.amountWon, finalAmount.amountWon] },
  externalExactMatch: true,
  confirmationSteps: Object.values(PURCHASE_CONFIRMATION_STEP)
}, null, 2));
