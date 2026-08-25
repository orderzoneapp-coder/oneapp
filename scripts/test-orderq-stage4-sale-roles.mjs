import assert from 'node:assert/strict';
import { buildFrozenSaleIntent } from '../orderq/official-voucher-repository.js';
const source={commandType:'POST_SALE',aggregateId:'SD1',expectedRevision:1,sourceType:'ORDER_Q',sourceDocumentKey:'SALE:S',originSystem:'ORDER_Q',originTransactionId:'P',sourceVoucherIndex:1,actor:'A',occurredAt:'2026-08-25T00:00:00Z',document:{salesCustomerId:'S1',salesCustomerRevision:2,deliveryCustomerId:'D1',deliveryCustomerRevision:3,billingCustomerId:'B1',billingCustomerRevision:4,saleDate:'2026-08-25'},lines:[{sourceLineKey:'L',lineIdentityId:'LI',lineSequence:1,productId:'P',warehouseId:'W',actualQuantity:1,actualToBaseFactor:1,baseQuantity:1,actualToRecognizedFactor:1,recognizedOrderQuantity:1,unitPrice:1}]};
const frozen=buildFrozenSaleIntent(source).commandEnvelope;
assert.deepEqual([frozen.document.salesCustomerId,frozen.document.deliveryCustomerId,frozen.document.billingCustomerId],['S1','D1','B1']);
assert.deepEqual([frozen.document.salesCustomerRevision,frozen.document.deliveryCustomerRevision,frozen.document.billingCustomerRevision],[2,3,4]);
console.log('ORDER Q stage4 sale role tests passed');
