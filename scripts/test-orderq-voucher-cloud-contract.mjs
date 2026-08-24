import assert from 'node:assert/strict'; import vm from 'node:vm'; import { readFileSync } from 'node:fs';
import { planOfficialVoucherCommand } from '../orderq/official-voucher-core.js';
const source=readFileSync(new URL('../orderq-cloud.gs',import.meta.url),'utf8');
function declaration(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0);const brace=source.indexOf('{',start);let depth=0;for(let index=brace;index<source.length;index+=1){if(source[index]==='{')depth+=1;else if(source[index]==='}'&&--depth===0)return source.slice(start,index+1);}throw new Error(name);}
const context={};vm.createContext(context);vm.runInContext(['orderQM9Text','orderQM9RoundOfficialWon','orderQM9ValidateOfficialVoucher'].map(declaration).join('\n'),context);
const doc={purchaseDocumentId:'CLOUD-P',supplierCustomerId:'SUP',warehouseId:'W',documentContract:'VOUCHER_CORE_V1',sourceDocumentKey:'CLOUD-SRC',sourceType:'DIRECT',businessStatus:'DRAFT',status:'DRAFT',revision:1};
const line={purchaseLineId:'CLOUD-L',lineIdentityId:'CLOUD-LI',sourceLineKey:'1',productId:'P',warehouseId:'W',quantity:0,baseQuantity:0,unitPrice:10};
const plan=planOfficialVoucherCommand({document:doc,lines:[line],command:{commandType:'POST_PURCHASE',commandContract:'VOUCHER_CORE_V1',commandId:'CLOUD-C',idempotencyKey:'CLOUD-C',expectedRevision:1,actor:'A',occurredAt:'2026-08-25T00:00:00Z',document:doc,lines:[line]}});
const command={commandType:'POST_PURCHASE',aggregateId:'CLOUD-P',idempotencyKey:'CLOUD-C',expectedRevision:1,intent:{commandContract:'VOUCHER_CORE_V1',commandId:'CLOUD-C',actor:'A',occurredAt:'2026-08-25T00:00:00Z'}};
const mutations=[{entityType:'PURCHASE_DOCUMENT',entityId:'CLOUD-P',revision:2,payload:plan.document},...plan.lines.map(payload=>({entityType:'PURCHASE_LINE',entityId:payload.purchaseLineId,revision:2,payload})),...plan.movements.map(payload=>({entityType:'INVENTORY_MOVEMENT',entityId:payload.movementId,revision:2,payload})),{entityType:'VOUCHER_EVENT',entityId:plan.voucherEvent.eventId,revision:2,payload:plan.voucherEvent},...plan.entries.map(payload=>({entityType:'PAYABLE_ENTRY',entityId:payload.entryId,revision:2,payload}))];
assert.doesNotThrow(()=>context.orderQM9ValidateOfficialVoucher(command,mutations,[]),'Cloud validator must execute the zero-effect official fixture');
assert.throws(()=>context.orderQM9ValidateOfficialVoucher(command,[...mutations,{entityType:'ORDER_EVENT',entityId:'BAD',revision:2,payload:{}}],[]),/MUTATION_SCOPE_INVALID/);
console.log('ORDER Q voucher cloud contract tests passed');
