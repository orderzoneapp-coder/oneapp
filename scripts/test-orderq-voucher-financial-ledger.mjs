import assert from 'node:assert/strict';
import { calculateOfficialLineAmount, planOfficialVoucherCommand, roundWon } from '../orderq/official-voucher-core.js';
import { validateVoucherCoreReversal } from '../orderq/inventory-ledger.js';
assert.deepEqual([.5,-.5,1.49,-1.49,1.5,-1.5].map(roundWon),[1,-1,1,-1,2,-2]);
const row=calculateOfficialLineAmount(-2,100); assert.equal(row.supplyAmount,-200); assert.equal(row.totalAmount,-200); assert.equal(row.vatAmount,null);
const draft={purchaseDocumentId:'PF',supplierCustomerId:'SUP',warehouseId:'W',documentContract:'VOUCHER_CORE_V1',sourceDocumentKey:'PF-SRC',sourceType:'DIRECT',businessStatus:'DRAFT',status:'DRAFT',revision:1};
const line={purchaseLineId:'PFL',lineIdentityId:'PFLI',sourceLineKey:'1',productId:'P',warehouseId:'W',quantity:1,baseQuantity:1,unitPrice:10};
const command=(commandType,commandId,expectedRevision,document,lines)=>({commandType,commandContract:'VOUCHER_CORE_V1',commandId,idempotencyKey:commandId,expectedRevision,actor:'ADMIN',occurredAt:`2026-08-25T0${expectedRevision}:00:00Z`,reason:commandType.startsWith('POST_')?'':'검증',document,lines});
const posted=planOfficialVoucherCommand({document:draft,lines:[line],command:command('POST_PURCHASE','PF-1',1,draft,[line])});
const correctedLine={...posted.lines[0],quantity:2,actualQuantity:2,baseQuantity:2};
const corrected=planOfficialVoucherCommand({document:posted.document,lines:posted.lines,movements:posted.movements,entries:posted.entries,command:command('CORRECT_PURCHASE','PF-2',2,posted.document,[correctedLine])});
const reversed=planOfficialVoucherCommand({document:corrected.document,lines:corrected.lines,movements:[...posted.movements,...corrected.movements],entries:[...posted.entries,...corrected.entries],command:command('REVERSE_PURCHASE','PF-3',3,corrected.document,[])});
assert.deepEqual(reversed.movements.map(item=>item.signedBaseQuantity),[-1,-1],'reverse must clear every residual movement effect');
assert.equal(reversed.entries.reduce((sum,item)=>sum+item.totalAmount,0),-20,'reverse must clear the active payable balance');
assert.equal([...posted.entries,...corrected.entries,...reversed.entries].reduce((sum,item)=>sum+item.totalAmount,0),0);
for(const movement of reversed.movements) assert.doesNotThrow(()=>validateVoucherCoreReversal(
  [...posted.movements,...corrected.movements].find(item=>item.movementId===movement.reversalOf),movement));
console.log('ORDER Q voucher financial ledger tests passed');
