import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOfficialSaleEditCommand, mergeOfficialSaleConflictEdits, normalizeOfficialSaleEditLines, officialSaleEvidence } from '../orderq/sale-official-editor.js';
const line={salesLineId:'L',lineIdentityId:'I',actualQuantity:2,actualToBaseFactor:10,actualToRecognizedFactor:2,unitPrice:100,orderLinkMode:'ORDER_Q'};
assert.deepEqual(normalizeOfficialSaleEditLines([line]).map(row=>[row.baseQuantity,row.recognizedOrderQuantity,row.supplyAmount]),[[20,4,200]]);
assert.throws(()=>normalizeOfficialSaleEditLines([{...line,actualQuantity:''}]),/QUANTITY_REQUIRED/);
const document={salesDocumentId:'SD',revision:2,billingCustomerId:'B',sourceType:'ORDER_Q'};
assert.equal(buildOfficialSaleEditCommand({action:'correct',document,lines:[line],reason:'정정',occurredAt:'2026-08-25T00:00:00Z'}).commandType,'CORRECT_SALE');
assert.equal(buildOfficialSaleEditCommand({action:'reverse',document,lines:[line],reason:'취소',occurredAt:'2026-08-25T00:00:00Z'}).commandType,'REVERSE_SALE');
const merged=mergeOfficialSaleConflictEdits({document:{billingCustomerId:'B2'},lines:[{...line,actualQuantity:3}]},{document,activeLines:[line]});assert.equal(merged.document.billingCustomerId,'B2');assert.equal(merged.activeLines[0].actualQuantity,3);
const evidence=officialSaleEvidence({document:{commandId:'C',centralTransactionId:'TX',resultDigest:'RD',projectionStatus:'LOCAL_PROJECTED'},activeLines:[{...line,suggestedActualQuantity:1}],
 movements:[{movementId:'M',movementType:'SALE',quantity:-20,reversalOf:''}],receivableEntries:[{entryId:'AR',entryType:'RECEIVABLE_SALE',amount:200,reversalOf:''}],
 orderEvents:[{eventId:'E',eventType:'SALES_TRANSFER_ALLOCATED',quantity:4,detail:{allocationEventId:'A'}}],voucherEvents:[{eventId:'V',eventType:'SALE_POSTED',revision:1}]});
assert.deepEqual(evidence.lines[0],{lineIdentityId:'I',suggestedActualQuantity:1,actualQuantity:2,baseQuantity:undefined,recognizedOrderQuantity:undefined});
assert.deepEqual(evidence.movements[0],{movementId:'M',movementType:'SALE',quantity:-20,reversalOf:''});
assert.deepEqual(evidence.receivableEntries[0],{entryId:'AR',entryType:'RECEIVABLE_SALE',amount:200,reversalOf:''});
assert.equal(evidence.orderEvents[0].allocationEventId,'A'); assert.equal(evidence.voucherEvents[0].revision,1);
assert.deepEqual(evidence.command,{commandId:'C',centralTransactionId:'TX',resultDigest:'RD',projectionStatus:'LOCAL_PROJECTED'});
const saleUi=readFileSync(new URL('../orderq/sale-ui.js',import.meta.url),'utf8');
const saleHtml=readFileSync(new URL('../orderq/sale.html',import.meta.url),'utf8');
assert.match(saleUi,/listOfficialSales/); assert.match(saleUi,/listLegacySales/); assert.match(saleUi,/loadOfficialSaleAggregate/); assert.match(saleUi,/loadLegacySaleAggregate/);
assert.match(saleUi,/buildOfficialSaleEditCommand/); assert.match(saleUi,/ORDERQ_SALE_STAGE4_CAPABILITY_UNAVAILABLE/);
assert.match(saleHtml,/sale-ui\.js/); assert.match(saleHtml,/공식·기존 판매전표/);
console.log('ORDER Q stage4 sale query/correction tests passed');
