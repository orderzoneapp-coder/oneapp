import assert from 'node:assert/strict';
import { calculateAlreadyPurchased,inventoryKey } from '../orderq/situation-analysis.js';

const documents=[{documentId:'D1',businessDate:'2026-08-25',commandContract:'VOUCHER_CORE_V1'},{documentId:'OUT',businessDate:'2026-08-23',commandContract:'VOUCHER_CORE_V1'}];
const movement=(movementId,warehouseId,qty,sourceType='ORDER_Q',ledgerSequence=1)=>({documentId:'D1',movementId,effectKey:`E-${movementId}`,productId:'P1',warehouseId,baseUnit:'EA',signedBaseQuantity:qty,sourceType,ledgerSequence});
const totals=calculateAlreadyPurchased({documents,movements:[movement('POST','W1',10),movement('OLD','W1',-10,'ORDER_Q',5),movement('NEW','W2',10,'DIRECT',5)],window:{from:'2026-08-24',to:'2026-08-25'},ledgerUpperBound:5});
assert.equal(totals.find(row=>row.key===inventoryKey('P1','W1','EA')).alreadyPurchasedBaseQuantity,0);
const w2=totals.find(row=>row.key===inventoryKey('P1','W2','EA'));
assert.equal(w2.directPurchasedBaseQuantity,10);
assert.deepEqual(w2.issues,['DIRECT_PURCHASE_REASON_REVIEW']);
const cohortDocuments=[
  {documentId:'Q1',businessDate:'2026-08-24',commandContract:'VOUCHER_CORE_V1',normalizedOriginKey:'ORDER-Q-1',sourceType:'ORDER_Q'},
  {documentId:'LEGACY-DUP',businessDate:'2026-08-24',commandContract:'VOUCHER_CORE_V1',normalizedOriginKey:'ORDER-Q-1',sourceType:'LEGACY_MIGRATED'},
  {documentId:'DIRECT-1',businessDate:'2026-08-25',commandContract:'VOUCHER_CORE_V1',normalizedOriginKey:'DIRECT-1',sourceType:'DIRECT',reasonCode:'EMERGENCY'},
  {documentId:'FUTURE',businessDate:'2026-08-26',commandContract:'VOUCHER_CORE_V1',normalizedOriginKey:'FUTURE',sourceType:'ORDER_Q'}
];
const effects=[
  {documentId:'Q1',movementId:'Q-POST',effectKey:'Q-POST',productId:'P1',warehouseId:'W1',baseUnit:'EA',signedBaseQuantity:10,ledgerSequence:1},
  {documentId:'Q1',movementId:'Q-REVERSE',effectKey:'Q-REVERSE',reversalOf:'Q-POST',productId:'P1',warehouseId:'W1',baseUnit:'EA',signedBaseQuantity:-10,ledgerSequence:2},
  {documentId:'Q1',movementId:'Q-MOVE',effectKey:'Q-MOVE',productId:'P1',warehouseId:'W2',baseUnit:'EA',signedBaseQuantity:10,ledgerSequence:3},
  {documentId:'LEGACY-DUP',movementId:'LEGACY',effectKey:'LEGACY',productId:'P1',warehouseId:'W1',baseUnit:'EA',signedBaseQuantity:99,ledgerSequence:3},
  {documentId:'DIRECT-1',movementId:'DIRECT',effectKey:'DIRECT',productId:'P1',warehouseId:'W2',baseUnit:'EA',signedBaseQuantity:2,ledgerSequence:4},
  {documentId:'FUTURE',movementId:'FUTURE',effectKey:'FUTURE',productId:'P1',warehouseId:'W2',baseUnit:'EA',signedBaseQuantity:50,ledgerSequence:4},
  {documentId:'DIRECT-1',movementId:'AFTER-UPPER',effectKey:'AFTER-UPPER',productId:'P1',warehouseId:'W2',baseUnit:'EA',signedBaseQuantity:5,ledgerSequence:6}
];
const cohort=calculateAlreadyPurchased({documents:cohortDocuments,movements:effects,window:{from:'2026-08-24',to:'2026-08-25'},ledgerUpperBound:5});
assert.equal(cohort.find(row=>row.key===inventoryKey('P1','W1','EA')).alreadyPurchasedBaseQuantity,0);
const moved=cohort.find(row=>row.key===inventoryKey('P1','W2','EA'));
assert.equal(moved.orderQPurchasedBaseQuantity,10);
assert.equal(moved.directPurchasedBaseQuantity,2);
assert.equal(moved.alreadyPurchasedBaseQuantity,12);
assert.equal(moved.evidence.some(item=>item.documentId==='LEGACY-DUP'),false);
console.log('PASS stage5 already purchased cohort');
