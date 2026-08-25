import assert from 'node:assert/strict';
import { buildOfficialPurchaseEditCommand, mergeOfficialPurchaseConflictEdits, normalizeOfficialPurchaseEditLines, officialPurchaseEvidence } from '../orderq/purchase-official-editor.js';
import { planOfficialVoucherCommand } from '../orderq/official-voucher-core.js';

const baseLine={purchaseLineId:'PL1',lineIdentityId:'LI1',sourceLineKey:'L1',lineSequence:1,productId:'P1',productCode:'A',productName:'상품A',warehouseId:'W1',warehouseCode:'01',actualQuantity:2,unit:'BOX',conversionFactor:10,baseQuantity:20,baseUnit:'EA',unitPrice:100,supplyAmount:200,totalAmount:200,productMasterRevision:2,warehouseMasterRevision:1};
assert.deepEqual(normalizeOfficialPurchaseEditLines([{...baseLine,actualQuantity:3}]).map(row=>[row.baseQuantity,row.supplyAmount]),[[30,300]]);
assert.throws(()=>normalizeOfficialPurchaseEditLines([{...baseLine,actualQuantity:''}]),/ORDERQ_PURCHASE_QUANTITY_REQUIRED/);
assert.throws(()=>normalizeOfficialPurchaseEditLines([{...baseLine,unitPrice:''}]),/ORDERQ_PURCHASE_UNIT_PRICE_REQUIRED/);
assert.throws(()=>normalizeOfficialPurchaseEditLines([{...baseLine,conversionFactor:0}]),/ORDERQ_PURCHASE_CONVERSION_REQUIRED/);

const document={purchaseDocumentId:'PD1',supplierCustomerId:'SUP1',purchaseDate:'2026-08-25',warehouseId:'W1',documentContract:'VOUCHER_CORE_V1',contractKind:'PURCHASE_STAGE3_V1',sourceDocumentKey:'SRC1',sourceType:'DIRECT',businessStatus:'DRAFT',status:'DRAFT',revision:1};
const postCommand={commandType:'POST_PURCHASE',commandContract:'VOUCHER_CORE_V1',commandId:'POST1',idempotencyKey:'POST1',expectedRevision:1,actor:'A',occurredAt:'2026-08-25T00:00:00Z',document,lines:[baseLine]};
const posted=planOfficialVoucherCommand({document,lines:[baseLine],command:postCommand});
const correction=buildOfficialPurchaseEditCommand({action:'correct',document:posted.document,lines:[{...posted.lines[0],actualQuantity:3,conversionFactor:10}],reason:'수량 수정',occurredAt:'2026-08-25T01:00:00Z'});
const corrected=planOfficialVoucherCommand({document:posted.document,lines:posted.lines,movements:posted.movements,entries:posted.entries,command:correction});
assert.equal(corrected.movements.reduce((sum,row)=>sum+row.signedBaseQuantity,0),10,'BOX 2→3 adds 10 EA');
const zeroCommand=buildOfficialPurchaseEditCommand({action:'correct',document:posted.document,lines:[{...posted.lines[0],actualQuantity:0,conversionFactor:10}],reason:'0 수정',occurredAt:'2026-08-25T01:00:00Z'});
const zero=planOfficialVoucherCommand({document:posted.document,lines:posted.lines,movements:posted.movements,entries:posted.entries,command:zeroCommand});
assert.equal(zero.movements.reduce((sum,row)=>sum+row.signedBaseQuantity,0),-20,'BOX 2→0 removes 20 EA');
const negativeCommand=buildOfficialPurchaseEditCommand({action:'correct',document:posted.document,lines:[{...posted.lines[0],actualQuantity:-1,conversionFactor:10}],reason:'음수 수정',occurredAt:'2026-08-25T01:00:00Z'});
const negative=planOfficialVoucherCommand({document:posted.document,lines:posted.lines,movements:posted.movements,entries:posted.entries,command:negativeCommand});
assert.equal(negative.lines[0].baseQuantity,-10); assert.equal(negative.document.totalAmount,-100);

const movedCommand=buildOfficialPurchaseEditCommand({action:'correct',document:{...posted.document,supplierCustomerId:'SUP2',purchaseDate:'2026-08-26',warehouseId:'W2'},lines:[{...posted.lines[0],productId:'P2',warehouseId:'W2',productMasterRevision:3,warehouseMasterRevision:2}],reason:'공급처 상품 창고 수정',occurredAt:'2026-08-25T01:00:00Z'});
const moved=planOfficialVoucherCommand({document:posted.document,lines:posted.lines,movements:posted.movements,entries:posted.entries,command:movedCommand});
assert.ok(moved.movements.some(row=>row.effectKind==='REVERSE_OLD')); assert.ok(moved.movements.some(row=>row.effectKind==='APPLY_NEW'));
assert.equal(moved.entries.filter(row=>row.partnerId==='SUP1').reduce((sum,row)=>sum+row.totalAmount,0),-200);
assert.equal(moved.entries.filter(row=>row.partnerId==='SUP2').reduce((sum,row)=>sum+row.totalAmount,0),200);

const added={...posted.lines[0],purchaseLineId:'PL2',lineIdentityId:'LI2',sourceLineKey:'L2',productId:'P3'};
const addDelete=buildOfficialPurchaseEditCommand({action:'correct',document:posted.document,lines:[added],reason:'행 추가 삭제',occurredAt:'2026-08-25T01:00:00Z'});
const addDeletePlan=planOfficialVoucherCommand({document:posted.document,lines:posted.lines,movements:posted.movements,entries:posted.entries,command:addDelete});
assert.equal(addDeletePlan.voucherEvent.afterSnapshot.lines.find(row=>row.lineIdentityId==='LI1').lineStatus,'DELETED'); assert.ok(addDeletePlan.lines.some(row=>row.lineIdentityId==='LI2'));

const edited={document:{supplierCustomerId:'SUP-EDIT',purchaseDate:'2026-08-30',correctionReason:'편집 유지'},lines:[{...baseLine,actualQuantity:7},added]};
const merged=mergeOfficialPurchaseConflictEdits(edited,{document:{...posted.document,revision:3},activeLines:[posted.lines[0]]});
assert.equal(merged.document.revision,3); assert.equal(merged.document.supplierCustomerId,'SUP-EDIT'); assert.deepEqual(merged.activeLines.map(row=>row.lineIdentityId),['LI1','LI2']); assert.equal(merged.activeLines[0].actualQuantity,7);

const reverse=buildOfficialPurchaseEditCommand({action:'reverse',document:posted.document,lines:posted.lines,reason:'전체 취소',occurredAt:'2026-08-25T02:00:00Z'});
const reversed=planOfficialVoucherCommand({document:posted.document,lines:posted.lines,movements:posted.movements,entries:posted.entries,command:reverse});
assert.equal(reversed.movements.reduce((sum,row)=>sum+row.signedBaseQuantity,0),-20); assert.equal(reversed.entries.reduce((sum,row)=>sum+row.totalAmount,0),-200);
const negativePostCommand={...postCommand,commandId:'POST-NEG',idempotencyKey:'POST-NEG',lines:[{...baseLine,actualQuantity:-1,baseQuantity:-10,supplyAmount:-100,totalAmount:-100}]};
const negativePost=planOfficialVoucherCommand({document:{...document,purchaseDocumentId:'PD-NEG',sourceDocumentKey:'SRC-NEG'},lines:negativePostCommand.lines,command:{...negativePostCommand,document:{...document,purchaseDocumentId:'PD-NEG',sourceDocumentKey:'SRC-NEG'}}});
const negativeReverse=buildOfficialPurchaseEditCommand({action:'reverse',document:negativePost.document,lines:negativePost.lines,reason:'음수 전체 취소',occurredAt:'2026-08-25T02:00:00Z'});
const negativeReversed=planOfficialVoucherCommand({document:negativePost.document,lines:negativePost.lines,movements:negativePost.movements,entries:negativePost.entries,command:negativeReverse});
assert.equal(negativeReversed.movements.reduce((sum,row)=>sum+row.signedBaseQuantity,0),10); assert.equal(negativeReversed.entries.reduce((sum,row)=>sum+row.totalAmount,0),100);
const evidence=officialPurchaseEvidence({document:posted.document,activeLines:posted.lines,movements:posted.movements,payableEntries:posted.entries,voucherEvents:[posted.voucherEvent]});
assert.equal(evidence.lines[0].actualQuantity,2); assert.equal(evidence.movements.length,1); assert.equal(evidence.payableEntries.length,1); assert.equal(evidence.voucherEvents.length,1); assert.ok('commandId' in evidence.command);
console.log('ORDER Q stage3 purchase correction/detail tests passed');
