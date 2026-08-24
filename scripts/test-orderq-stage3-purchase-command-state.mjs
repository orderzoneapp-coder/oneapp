import assert from 'node:assert/strict';
import { buildFrozenPurchaseIntent } from '../orderq/official-voucher-repository.js';
import { centralCommandFingerprint } from '../orderq/central-authority.js';
import { buildPurchasePostDraft, resolvePersistedPurchaseRetry } from '../smartinput/purchase-official-stage3.js';

const base={commandType:'POST_PURCHASE',aggregateId:'PD1',expectedRevision:1,commandId:'CMD1',idempotencyKey:'CMD1',sourceType:'DIRECT',contractKind:'PURCHASE_STAGE3_V1',sourceDocumentKey:'DOC1',originSystem:'SMARTINPUT_MANUAL',originTransactionId:'RUN1',actorId:'ADMIN',occurredAt:'2026-08-25T00:00:00.000Z',document:{supplierCustomerId:'C1',purchaseDate:'2026-08-25',warehouseId:'W1',taxType:'VAT_INCLUDED_IN_SUPPLY',currency:'KRW'},lines:[{sourceLineKey:'L1',lineIdentityId:'LI1',lineSequence:1,productId:'P1',warehouseId:'W1',actualQuantity:0,unit:'EA',conversionFactor:1,baseQuantity:0,baseUnit:'EA',unitPrice:10,supplyAmount:0,totalAmount:0,taxType:'VAT_INCLUDED_IN_SUPPLY',currency:'KRW'}]};
const frozen=buildFrozenPurchaseIntent({...base,uiState:{selected:true},retryCount:7});
const changedUi=buildFrozenPurchaseIntent({...base,uiState:{selected:false},retryCount:99});
assert.equal(frozen.draftIntentDigest,changedUi.draftIntentDigest);
assert.equal(frozen.commandId,'CMD1');
assert.equal(frozen.commandState,'COMMAND_FROZEN');
assert.equal(frozen.commandEnvelope.uiState,undefined);
assert.equal(frozen.commandFingerprint,centralCommandFingerprint({commandType:'POST_PURCHASE',aggregateId:'PD1',expectedRevision:1,idempotencyKey:'CMD1',intent:{...frozen.commandEnvelope,actor:frozen.commandEnvelope.actorId}}));
assert.notEqual(buildFrozenPurchaseIntent({...base,lines:[{...base.lines[0],actualQuantity:1,baseQuantity:1,supplyAmount:10,totalAmount:10}]}).draftIntentDigest,frozen.draftIntentDigest);

const purchaseGroup={sourceType:'DIRECT',originSystem:'SMARTINPUT_MANUAL',originTransactionId:'SESSION1',sourceVoucherIndex:1,supplierCustomerId:'C1',supplierCustomerCode:'S1',supplierCustomerName:'남경',voucherDate:'2026-08-25',warehouseId:'W1',warehouseCode:'01',rows:[{sourceSheetName:'직접입력',sourceRowNo:1,productId:'P1',itemCode:'A',itemName:'상품A',warehouseId:'W1',warehouseCode:'01',quantity:2,unit:'EA',unitPrice:100,conversionFactor:1,baseQuantity:2,baseUnit:'EA',productMasterRevision:2,warehouseMasterRevision:1}]};
const saved=buildPurchasePostDraft(purchaseGroup,{actor:'ACTOR-1',occurredAt:'2026-08-25T01:00:00.000Z'});
const aggregate={document:{status:'DRAFT',draftIntentDigest:saved.draftIntentDigest,commandEnvelope:structuredClone(saved.commandEnvelope)}};
assert.equal(saved.commandEnvelope.lines[0].productMasterRevision,2);
assert.equal(saved.commandEnvelope.lines[0].warehouseMasterRevision,1);
const retry=resolvePersistedPurchaseRetry(purchaseGroup,{actor:'ACTOR-2',occurredAt:'2026-08-25T09:00:00.000Z'},aggregate);
assert.deepEqual(retry.envelope,saved.commandEnvelope);
assert.equal(retry.draft.commandId,saved.commandId);
assert.equal(retry.draft.commandFingerprint,saved.commandFingerprint);
assert.equal(retry.draft.draftIntentDigest,saved.draftIntentDigest);
assert.throws(()=>resolvePersistedPurchaseRetry({...purchaseGroup,rows:[{...purchaseGroup.rows[0],quantity:3,baseQuantity:3}]},{occurredAt:'2026-08-25T09:00:00.000Z'},aggregate),/ORDERQ_PURCHASE_DRAFT_IDENTITY_CONFLICT/);
console.log('ORDER Q stage3 purchase immutable command tests passed');
