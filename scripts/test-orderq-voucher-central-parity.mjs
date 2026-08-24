import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { centralCommandFingerprint } from '../orderq/central-authority.js';
import { canonicalSha256 } from '../orderq/official-voucher-core.js';
const cloud=readFileSync(new URL('../orderq-cloud.gs',import.meta.url),'utf8');
function declaration(name){
  const start=cloud.indexOf(`function ${name}(`); assert.ok(start>=0,`${name} exists`);
  const brace=cloud.indexOf('{',start); let depth=0;
  for(let index=brace;index<cloud.length;index+=1){if(cloud[index]==='{')depth+=1;else if(cloud[index]==='}'&&--depth===0)return cloud.slice(start,index+1);}
  throw new Error(`unterminated ${name}`);
}
const context={sha256Hex:value=>crypto.createHash('sha256').update(value).digest('hex')};
vm.createContext(context);
vm.runInContext(['orderQM9Text','orderQM9Stable','orderQM9StableJson','orderQM9Digest','orderQM9CommandFingerprint'].map(declaration).join('\n'),context);
const fixture={commandType:'POST_SALE',aggregateId:'SD-PARITY',idempotencyKey:'CMD-PARITY',expectedRevision:1,intent:{commandContract:'VOUCHER_CORE_V1',commandId:'CMD-PARITY',sourceType:'ORDER_Q',document:{sourceDocumentKey:'SRC',billingCustomerId:'B'},lines:[{sourceLineKey:'1',quantity:2}]}};
assert.equal(context.orderQM9CommandFingerprint(fixture),centralCommandFingerprint(fixture),'browser and Cloud canonical SHA-256 fingerprints must match');
assert.notEqual(centralCommandFingerprint(fixture),centralCommandFingerprint({...fixture,intent:{...fixture.intent,lines:[{sourceLineKey:'1',quantity:3}]}}));
const resultFixture={changes:[{entityType:'INVENTORY_MOVEMENT',entityId:'M1',revision:2,payload:{ledgerSequence:1,signedBaseQuantity:-10}}],cursor:7,ledgerSequence:1,serverRevision:2};
assert.equal(context.orderQM9Digest(resultFixture),canonicalSha256(resultFixture),'browser and Cloud resultDigest must ignore environment-specific transaction IDs and match directly');
console.log('ORDER Q voucher browser/cloud parity tests passed');
