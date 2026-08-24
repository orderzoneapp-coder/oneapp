import assert from 'node:assert/strict';
import { planOfficialVoucherCommand } from '../orderq/official-voucher-core.js';
const doc={purchaseDocumentId:'P0',supplierCustomerId:'S',warehouseId:'W',documentContract:'VOUCHER_CORE_V1',sourceDocumentKey:'Z',sourceType:'DIRECT',businessStatus:'DRAFT',status:'DRAFT',revision:1,supplyAmount:0,totalAmount:0};
const line={purchaseLineId:'L0',lineIdentityId:'LI0',sourceLineKey:'1',productId:'X',warehouseId:'W',actualQuantity:0,quantity:0,baseQuantity:0,unitPrice:100};
const post=planOfficialVoucherCommand({document:doc,lines:[line],command:{commandContract:'VOUCHER_CORE_V1',commandType:'POST_PURCHASE',commandId:'Z1',idempotencyKey:'Z1',expectedRevision:1,actor:'A',occurredAt:'2026-08-25T00:00:00Z',document:doc,lines:[line]}});
assert.equal(post.movements[0].signedBaseQuantity,0); assert.equal(post.entries[0].totalAmount,0); assert.equal(post.document.businessStatus,'CONFIRMED');
const rev=planOfficialVoucherCommand({document:post.document,lines:post.lines,command:{commandContract:'VOUCHER_CORE_V1',commandType:'REVERSE_PURCHASE',commandId:'Z2',idempotencyKey:'Z2',expectedRevision:2,actor:'A',reason:'취소',occurredAt:'2026-08-25T01:00:00Z'}});
assert.equal(rev.movements[0].signedBaseQuantity,0); assert.equal(rev.movements[0].movementType,'DIRECT_PURCHASE_REVERSAL');
console.log('ORDER Q voucher zero/negative tests passed');
