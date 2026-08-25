import assert from 'node:assert/strict';
import { analyzeSituation } from '../orderq/situation-analysis.js';

const key='P1\u001fW1\u001fEA';
const input={businessDate:'2026-08-25',windowKey:'D',dataOps:{session:{tokenDigest:'D'},rows:[{productId:'P1',warehouseId:'W1',baseUnit:'EA',signedBaseQuantity:-5,includedOrderQLedgerSequence:100,productMasterRevision:3,warehouseMasterRevision:2,baseUnitRuleVersion:'R1'}]},orderQ:{session:{tokenDigest:'O'},ledgerUpperBound:103,movementManifest:{movementIds:[],movementCount:0,manifestDigest:'M'},movements:[],products:[{productId:'P1',revision:3,baseUnit:'EA',baseUnitRuleVersion:'R1'}],warehouses:[{warehouseId:'W1',revision:2}],orderLines:[{productId:'P1',warehouseId:'W1',baseUnit:'EA',remainingRecognizedQuantity:10,actualToBaseFactor:1,actualToRecognizedFactor:1,conversionSource:'PRODUCT_MASTER',conversionRuleId:'CR1',conversionRuleVersion:'R1',actualUnit:'EA',recognizedUnit:'EA',sourceLineId:'L1',sourceLineRevision:1}]}};
const analysis=await analyzeSituation(input),row=analysis.rows.find(item=>item.key===key);
assert.equal(row.inventoryRecoveryRequiredBaseQuantity,5);
assert.equal(row.orderFulfillmentRequiredBaseQuantity,10);
assert.equal(row.additionalPurchaseRequiredBaseQuantity,15);
const unassigned=await analyzeSituation({...input,orderQ:{...input.orderQ,orderLines:[{...input.orderQ.orderLines[0],warehouseId:null}]}});
assert.equal(unassigned.rows[0].status,'REVIEW_REQUIRED_WAREHOUSE_ASSIGNMENT');
assert.equal(unassigned.rows[0].additionalPurchaseRequiredBaseQuantity,0);
const missingFactor=await analyzeSituation({...input,orderQ:{...input.orderQ,orderLines:[{...input.orderQ.orderLines[0],actualToBaseFactor:undefined}]}});
assert.equal(missingFactor.rows[0].status,'REVIEW_REQUIRED_BASE_UNIT');
console.log('PASS stage5 demand conversion packaging');
