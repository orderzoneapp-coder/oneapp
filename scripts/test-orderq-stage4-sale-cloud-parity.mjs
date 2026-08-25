import assert from 'node:assert/strict';import vm from 'node:vm';import { readFileSync } from 'node:fs';
import { deriveSaleSourceClaims } from '../orderq/central-source-claims.js';import { effectiveOrderQuantity } from '../orderq/order-fulfillment-lifecycle.js';
const source=readFileSync(new URL('../orderq-cloud.gs',import.meta.url),'utf8');function declaration(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,name);const brace=source.indexOf('{',start);let depth=0;for(let i=brace;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);}throw new Error(name);}
const context={};vm.createContext(context);vm.runInContext(['orderQM9Text','orderQM9CanonicalText','orderQM9CodePointCompare','orderQM9SaleSourceClaimKeys','orderQM9EffectiveOrderQuantity'].map(declaration).join('\n'),context);
const command={commandType:'POST_SALE',aggregateId:'SD',idempotencyKey:'C',intent:{commandContract:'VOUCHER_CORE_V1',contractKind:'SALE_STAGE4_V1',sourceDocumentKey:'S',originSystem:'ORDER_Q',originTransactionId:'P',sourceVoucherIndex:1,lines:[{sourceDispatchId:'D',sourceDispatchLineId:'DL',reversalSourceAllocations:[{allocationEventId:'A'}],restorationSourceReversals:[{reversalEventId:'R'}]}]}};
assert.deepEqual([...context.orderQM9SaleSourceClaimKeys(command)],[...deriveSaleSourceClaims(command)]);
for (const [originSystem, originTransactionId] of [['SMARTINPUT_FILE','FILE-DIGEST'],['SMARTINPUT_CLIPBOARD','RAW-DIGEST'],['SMARTINPUT_MANUAL','MANUAL-SESSION']]) {
  const direct={...command,intent:{...command.intent,sourceDocumentKey:`SALE:${originSystem}`,originSystem,originTransactionId,lines:[{orderLinkMode:'DIRECT'}]}};
  const browser=[...deriveSaleSourceClaims(direct)], cloud=[...context.orderQM9SaleSourceClaimKeys(direct)];
  assert.deepEqual(cloud,browser); assert.deepEqual(browser,[`SALE:SOURCE:SALE:${originSystem}`,`SALE:TX:${originSystem}:${originTransactionId}:1`]);
}
for (const missing of [{sourceDocumentKey:''},{originSystem:''},{originTransactionId:''},{sourceVoucherIndex:0}]) {
  const invalid={...command,intent:{...command.intent,...missing}};
  assert.throws(()=>deriveSaleSourceClaims(invalid),/ORDERQ_SALE_ORIGIN_IDENTITY_REQUIRED/);
  assert.throws(()=>context.orderQM9SaleSourceClaimKeys(invalid),/ORDERQ_SALE_ORIGIN_IDENTITY_REQUIRED/);
}
for(const fixture of [{order:{},item:{finalQuantity:10,cancelledQuantity:2},expected:8},{order:{orderStatus:'FULL_CANCEL'},item:{finalQuantity:10},expected:0},{order:{},item:{finalQuantity:-5},expected:0}]){assert.equal(context.orderQM9EffectiveOrderQuantity(fixture.order,fixture.item),fixture.expected);assert.equal(effectiveOrderQuantity(fixture.order,fixture.item),fixture.expected);}
console.log('ORDER Q stage4 sale Cloud parity tests passed');
