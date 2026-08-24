import assert from 'node:assert/strict';
import { buildSalePostDraft } from '../smartinput/sale-official-stage4.js';
const group={sourceType:'DIRECT',originSystem:'SMARTINPUT_MANUAL',originTransactionId:'SESSION',sourceVoucherIndex:1,salesCustomerId:'C',salesCustomerRevision:1,deliveryCustomerId:'C',deliveryCustomerRevision:1,billingCustomerId:'C',billingCustomerRevision:1,saleDate:'2026-08-25',rows:[{sourceRowKey:'R',productId:'P',productMasterRevision:1,warehouseId:'W',warehouseMasterRevision:1,quantity:1,unit:'EA',unitPrice:100,actualToBaseFactor:1,orderLinkMode:'DIRECT'}]};
const saved=buildSalePostDraft(group,{actor:'A',occurredAt:'2026-08-25T01:00:00Z'});
const retry=buildSalePostDraft(group,{actor:saved.commandEnvelope.actorId,occurredAt:saved.commandEnvelope.occurredAt});
assert.deepEqual(retry.commandEnvelope,saved.commandEnvelope);assert.equal(retry.commandFingerprint,saved.commandFingerprint);
assert.notEqual(buildSalePostDraft({...group,rows:[{...group.rows[0],quantity:2}]},{actor:'A',occurredAt:'2026-08-25T01:00:00Z'}).draftIntentDigest,saved.draftIntentDigest);
console.log('ORDER Q stage4 sale command recovery tests passed');
