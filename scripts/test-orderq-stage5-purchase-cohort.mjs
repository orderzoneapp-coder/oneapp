import assert from 'node:assert/strict';
import { calculateAlreadyPurchased,inventoryKey } from '../orderq/situation-analysis.js';

const documents=[{documentId:'D1',businessDate:'2026-08-25',commandContract:'VOUCHER_CORE_V1'},{documentId:'OUT',businessDate:'2026-08-23',commandContract:'VOUCHER_CORE_V1'}];
const movement=(movementId,warehouseId,qty,sourceType='ORDER_Q',ledgerSequence=1)=>({documentId:'D1',movementId,effectKey:`E-${movementId}`,productId:'P1',warehouseId,baseUnit:'EA',signedBaseQuantity:qty,sourceType,ledgerSequence});
const totals=calculateAlreadyPurchased({documents,movements:[movement('POST','W1',10),movement('OLD','W1',-10,'ORDER_Q',5),movement('NEW','W2',10,'DIRECT',5)],window:{from:'2026-08-24',to:'2026-08-25'},ledgerUpperBound:5});
assert.equal(totals.find(row=>row.key===inventoryKey('P1','W1','EA')).alreadyPurchasedBaseQuantity,0);
const w2=totals.find(row=>row.key===inventoryKey('P1','W2','EA'));
assert.equal(w2.directPurchasedBaseQuantity,10);
assert.deepEqual(w2.issues,['DIRECT_PURCHASE_REASON_REVIEW']);
console.log('PASS stage5 already purchased cohort');
