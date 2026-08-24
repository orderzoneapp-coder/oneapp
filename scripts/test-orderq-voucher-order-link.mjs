import assert from 'node:assert/strict';
import { planOfficialVoucherCommand } from '../orderq/official-voucher-core.js';
import { commitCentralCommand, createCentralAuthorityState, migrateCentralDrafts, prepareCentralCommand } from '../orderq/central-authority.js';
const doc={salesDocumentId:'SO',salesCustomerId:'S',deliveryCustomerId:'D',billingCustomerId:'B',warehouseId:'W',documentContract:'VOUCHER_CORE_V1',sourceDocumentKey:'O',sourceType:'ORDER_Q',businessStatus:'DRAFT',status:'DRAFT',revision:1,supplyAmount:0,totalAmount:0};
const line={salesLineId:'SL',lineIdentityId:'LI',sourceLineKey:'1',productId:'P',warehouseId:'W',actualQuantity:5,baseQuantity:10,recognizedOrderQuantity:4,unitPrice:100,orderLinkMode:'ORDER_Q',sourceOrderId:'O1',sourceOrderItemId:'OI1'};
const plan=planOfficialVoucherCommand({document:doc,lines:[line],command:{commandContract:'VOUCHER_CORE_V1',commandType:'POST_SALE',commandId:'O-C',idempotencyKey:'O-C',expectedRevision:1,actor:'A',occurredAt:'2026-08-25T00:00:00Z',document:doc,lines:[line]}});
assert.equal(plan.movements[0].signedBaseQuantity,-10); assert.equal(plan.document.totalAmount,500); assert.equal(plan.orderEvents[0].detail.transferredQty,4);
const moved={...plan.lines[0],sourceOrderId:'O2',sourceOrderItemId:'OI2'};
const correction=planOfficialVoucherCommand({document:plan.document,lines:plan.lines,movements:plan.movements,entries:plan.entries,command:{commandContract:'VOUCHER_CORE_V1',commandType:'CORRECT_SALE',commandId:'O-C2',idempotencyKey:'O-C2',expectedRevision:2,actor:'A',occurredAt:'2026-08-25T01:00:00Z',reason:'주문 연결 변경',document:plan.document,lines:[moved]}});
assert.deepEqual(correction.orderEvents.map(row=>[row.eventType,row.orderId,row.detail.transferredQty]),[
  ['SALES_TRANSFER_REVERSED','O1',4],['SALES_TRANSFER_ALLOCATED','O2',4]
]);
const central=createCentralAuthorityState();
migrateCentralDrafts(central,{idempotencyKey:'O-MIG',deviceId:'PC',entities:[
  {entityType:'ORDER',entityId:'O1',revision:1,payload:{orderId:'O1',status:'ORDER',localOnly:true}},
  {entityType:'ORDER_ITEM',entityId:'OI1',revision:1,payload:{orderItemId:'OI1',orderId:'O1',finalQuantity:10,localOnly:true}},
  {entityType:'SALES_DOCUMENT',entityId:'SO',revision:1,payload:{...doc,localOnly:true}},
  {entityType:'SALES_LINE',entityId:'SL',revision:1,payload:{...line,salesDocumentId:'SO',status:'DRAFT',revision:1,localOnly:true}}
]});
const source={commandType:'POST_SALE',aggregateId:'SO',idempotencyKey:'O-C',expectedRevision:1,deviceId:'PC',intent:{commandContract:'VOUCHER_CORE_V1',commandId:'O-C',actor:'A',occurredAt:'2026-08-25T00:00:00Z'}};
const lease=prepareCentralCommand(central,source);
const mutations=[{entityType:'SALES_DOCUMENT',entityId:'SO',revision:2,payload:plan.document},...plan.lines.map(payload=>({entityType:'SALES_LINE',entityId:payload.salesLineId,revision:2,payload})),...plan.movements.map(payload=>({entityType:'INVENTORY_MOVEMENT',entityId:payload.movementId,revision:2,payload})),{entityType:'VOUCHER_EVENT',entityId:plan.voucherEvent.eventId,revision:2,payload:plan.voucherEvent},...plan.orderEvents.map(payload=>({entityType:'ORDER_EVENT',entityId:payload.eventId,revision:2,payload})),...plan.entries.map(payload=>({entityType:'RECEIVABLE_ENTRY',entityId:payload.entryId,revision:2,payload}))];
assert.doesNotThrow(()=>commitCentralCommand(central,{idempotencyKey:'O-C',leaseToken:lease.leaseToken,fingerprint:lease.fingerprint,mutations}));
console.log('ORDER Q voucher order-link tests passed');
