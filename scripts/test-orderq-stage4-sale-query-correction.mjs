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
const evidence=officialSaleEvidence({document:{documentContract:'VOUCHER_CORE_V1',contractKind:'SALE_STAGE4_V1',commandId:'C',centralTransactionId:'TX',resultDigest:'RD',projectionStatus:'LOCAL_PROJECTED'},activeLines:[{...line,suggestedActualQuantity:1,baseQuantity:20,recognizedOrderQuantity:4,supplyAmount:200,totalAmount:200}],
 movements:[{movementId:'M',movementType:'SALE',productId:'P',warehouseId:'W',signedBaseQuantity:-20,effectKind:'APPLY_NEW',reversalOf:'',effectOrdinal:1}],receivableEntries:[{entryId:'AR',entryType:'RECEIVABLE_SALE',partnerId:'B',supplyAmount:200,totalAmount:200,reversalOf:'',effectOrdinal:1}],
 orderEvents:[{eventId:'E',eventType:'SALES_TRANSFER_ALLOCATED',orderId:'O',effectOrdinal:1,detail:{orderItemId:'OI',transferredQty:4,allocationEventId:'A'}}],voucherEvents:[{eventId:'V',eventType:'SALE_POSTED',sourceDocumentRevision:1,beforeSnapshot:{},afterSnapshot:{},commandId:'C'}]});
assert.equal(evidence.lines[0].baseQuantity,20);assert.equal(evidence.lines[0].recognizedOrderQuantity,4);
assert.equal(evidence.movements[0].signedBaseQuantity,-20);assert.equal(evidence.movements[0].effectKind,'APPLY_NEW');
assert.equal(evidence.receivableEntries[0].partnerId,'B');assert.equal(evidence.receivableEntries[0].totalAmount,200);
assert.equal(evidence.orderEvents[0].allocationEventId,'A'); assert.equal(evidence.voucherEvents[0].sourceDocumentRevision,1);
assert.equal(evidence.command.commandId,'C');assert.equal(evidence.command.projectionStatus,'LOCAL_PROJECTED');
const saleUi=readFileSync(new URL('../orderq/sale-ui.js',import.meta.url),'utf8');
const saleHtml=readFileSync(new URL('../orderq/sale.html',import.meta.url),'utf8');
assert.match(saleUi,/listOfficialSales/); assert.match(saleUi,/listLegacySales/); assert.match(saleUi,/loadOfficialSaleAggregate/); assert.match(saleUi,/loadLegacySaleAggregate/);
assert.match(saleUi,/buildOfficialSaleEditCommand/); assert.match(saleUi,/ORDERQ_SALE_STAGE4_CAPABILITY_UNAVAILABLE/);
assert.match(saleUi,/await pullCentralOfficialState\(\)/);assert.match(saleUi,/loadOfficialSaleAggregate\(selectedId\)/);assert.match(saleUi,/ORDERQ_SALE_REVISION_CONFLICT/);
assert.match(saleUi,/class="product"[^>]*readonly/);assert.match(saleUi,/class="warehouse"[^>]*readonly/);assert.match(saleUi,/id="billingCustomer"[^>]*readonly/);
assert.match(saleHtml,/sale-ui\.js/); assert.match(saleHtml,/공식·기존 판매전표/);
console.log('ORDER Q stage4 sale query/correction tests passed');
