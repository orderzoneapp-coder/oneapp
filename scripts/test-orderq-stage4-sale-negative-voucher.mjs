import assert from 'node:assert/strict';
import { planOfficialVoucherCommand } from '../orderq/official-voucher-core.js';
import { commitCentralCommand, createCentralAuthorityState, migrateCentralDrafts, prepareCentralCommand } from '../orderq/central-authority.js';
const prior=[{eventId:'A1',eventType:'SALES_TRANSFER_ALLOCATED',orderId:'O',createdAt:'2026-08-25T00:00:00Z',detail:{orderItemId:'OI',productId:'P',warehouseId:'W',salesDocumentId:'OLD',salesLineId:'OLD-L',lineIdentityId:'OLD-I',transferredQty:2}},{eventId:'A2',eventType:'SALES_TRANSFER_ALLOCATED',orderId:'O',createdAt:'2026-08-25T00:01:00Z',detail:{orderItemId:'OI',productId:'P',warehouseId:'W',salesDocumentId:'OLD2',salesLineId:'OLD-L2',lineIdentityId:'OLD-I2',transferredQty:3}}];
const doc={salesDocumentId:'NEG',salesCustomerId:'C',deliveryCustomerId:'C',billingCustomerId:'C',documentContract:'VOUCHER_CORE_V1',sourceType:'ORDER_Q',sourceDocumentKey:'S-',status:'DRAFT',businessStatus:'DRAFT',revision:1};
const refs=prior.map(row=>({allocationEventId:row.eventId,reversalQuantity:Number(row.detail.transferredQty),sourceSalesDocumentId:row.detail.salesDocumentId,sourceSalesLineId:row.detail.salesLineId,sourceLineIdentityId:row.detail.lineIdentityId,orderId:'O',orderItemId:'OI',productId:'P',warehouseId:'W'}));
const line={salesLineId:'NEG-L',lineIdentityId:'NEG-I',sourceLineKey:'N',productId:'P',warehouseId:'W',actualQuantity:-5,baseQuantity:-5,recognizedOrderQuantity:-5,unitPrice:10,orderLinkMode:'ORDER_Q',sourceOrderId:'O',sourceOrderItemId:'OI',reversalSourceAllocations:refs};
const cmd=(type,id,revision,document,lines,reason='')=>({commandType:type,commandContract:'VOUCHER_CORE_V1',commandId:id,idempotencyKey:id,expectedRevision:revision,actor:'A',occurredAt:`2026-08-25T0${revision}:00:00Z`,reason,document,lines});
const post=planOfficialVoucherCommand({document:doc,lines:[line],orderEvents:prior,command:cmd('POST_SALE','N1',1,doc,[line])});
assert.equal(post.orderEvents.length,2);assert.ok(post.orderEvents.every(row=>row.detail.reversalKind==='NEGATIVE_SALE'));assert.notEqual(post.lines[0].lineIdentityId,'OLD-I');
const correctedLine={...post.lines[0],actualQuantity:-2,baseQuantity:-2,recognizedOrderQuantity:-2,restorationSourceReversals:post.orderEvents.map(row=>({reversalEventId:row.eventId}))};
const corrected=planOfficialVoucherCommand({document:post.document,lines:post.lines,movements:post.movements,entries:post.entries,orderEvents:[...prior,...post.orderEvents],command:cmd('CORRECT_SALE','N2',2,post.document,[correctedLine],'감소')});
assert.equal(corrected.orderEvents.reduce((sum,row)=>sum+row.detail.transferredQty,0),3);assert.ok(corrected.orderEvents.every(row=>row.detail.allocationKind==='REVERSAL_RESTORE'));
const reversed=planOfficialVoucherCommand({document:corrected.document,lines:corrected.lines,movements:[...post.movements,...corrected.movements],entries:[...post.entries,...corrected.entries],orderEvents:[...prior,...post.orderEvents,...corrected.orderEvents],command:cmd('REVERSE_SALE','N3',3,corrected.document,[],'취소')});
assert.equal(reversed.orderEvents.reduce((sum,row)=>sum+row.detail.transferredQty,0),2);assert.ok(reversed.orderEvents.every(row=>row.detail.allocationKind==='REVERSAL_RESTORE'));

const central=createCentralAuthorityState();
migrateCentralDrafts(central,{idempotencyKey:'NEG-MIG',deviceId:'PC',entities:[
  {entityType:'ORDER',entityId:'O',revision:1,payload:{orderId:'O',status:'ORDER',localOnly:true}},
  {entityType:'ORDER_ITEM',entityId:'OI',revision:1,payload:{orderItemId:'OI',orderId:'O',finalQuantity:20,productId:'P',localOnly:true}},
  {entityType:'SALES_DOCUMENT',entityId:'NEG',revision:1,payload:{...doc,localOnly:true}},
  {entityType:'SALES_LINE',entityId:'NEG-L',revision:1,payload:{...line,salesDocumentId:'NEG',status:'DRAFT',localOnly:true}}
]});
for(const event of prior) central.entities[`ORDER_EVENT\u001f${event.eventId}`]={entityType:'ORDER_EVENT',entityId:event.eventId,revision:1,status:'CONFIRMED',payload:event};
const mutations=(planned,revision,projection=planned.lines)=>[
  {entityType:'SALES_DOCUMENT',entityId:'NEG',revision,payload:planned.document},
  ...projection.map(payload=>({entityType:'SALES_LINE',entityId:payload.salesLineId,revision,payload})),
  ...planned.movements.map(payload=>({entityType:'INVENTORY_MOVEMENT',entityId:payload.movementId,revision,payload})),
  {entityType:'VOUCHER_EVENT',entityId:planned.voucherEvent.eventId,revision,payload:planned.voucherEvent},
  ...planned.orderEvents.map(payload=>({entityType:'ORDER_EVENT',entityId:payload.eventId,revision,payload})),
  ...planned.entries.map(payload=>({entityType:'RECEIVABLE_ENTRY',entityId:payload.entryId,revision,payload}))
];
const centralCommit=(command,planned,revision,projection)=>{const prepared=prepareCentralCommand(central,{commandType:command.commandType,aggregateId:'NEG',idempotencyKey:command.idempotencyKey,expectedRevision:command.expectedRevision,deviceId:'PC',intent:{commandContract:'VOUCHER_CORE_V1',commandId:command.commandId,actor:'A',occurredAt:command.occurredAt,reason:command.reason,lines:command.lines}});return commitCentralCommand(central,{idempotencyKey:command.idempotencyKey,leaseToken:prepared.leaseToken,fingerprint:prepared.fingerprint,mutations:mutations(planned,revision,projection)});};
const postCommand=cmd('POST_SALE','N1',1,doc,[line]);
assert.doesNotThrow(()=>centralCommit(postCommand,post,2),'central negative POST must commit exact split reversals');
const correctionCommand=cmd('CORRECT_SALE','N2',2,post.document,[correctedLine],'감소');
assert.doesNotThrow(()=>centralCommit(correctionCommand,corrected,3),'central negative correction must commit exact restoration effects');
const reverseCommand=cmd('REVERSE_SALE','N3',3,corrected.document,[],'취소');
assert.doesNotThrow(()=>centralCommit(reverseCommand,reversed,4,[{...corrected.lines[0],status:'REVERSED',revision:4}]),'central negative reversal must restore every remaining reversal residual');
console.log('ORDER Q stage4 negative sale voucher tests passed');
