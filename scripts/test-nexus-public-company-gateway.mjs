#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('nexus/server/nexus-auth-gateway.gs', 'utf8');
const cacheValues = new Map();
const forwardedRequests = [];
let serverData = {
  status: 'READY',
  revision: 3,
  snapshot: {
    companyName: '원앱',
    businessNumber: '380-14-01523',
    representativeName: '이무철',
    companyPhone: '',
    businessAddress: '서울특별시 송파구 양재대로 932, 9층 19호 (가락동, 가락동 농수산물도매시장)',
    homepage: '',
    revision: 3,
  },
};

const content = value => ({
  value,
  setMimeType() { return this; },
});

const context = vm.createContext({
  console,
  Date,
  JSON,
  Math,
  Object,
  Array,
  String,
  Number,
  RegExp,
  Error,
  Promise,
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: value => content(value),
  },
  CacheService: {
    getScriptCache: () => ({
      get: key => cacheValues.get(key) || null,
      put: (key, value) => cacheValues.set(key, value),
      remove: key => cacheValues.delete(key),
    }),
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: key => key === 'NEXUS_AUTH_SECRET_FOUNDATION_READ' ? 'foundation-read-secret' : '',
    }),
  },
  Utilities: {
    getUuid: () => '00000000-0000-4000-8000-000000000001',
  },
  UrlFetchApp: {
    fetch: (_url, options) => {
      forwardedRequests.push(JSON.parse(options.payload));
      return { getContentText: () => JSON.stringify({ status: 'success', data: serverData }) };
    },
  },
});

vm.runInContext(source, context, { filename: 'nexus-auth-gateway.gs' });

const call = payload => JSON.parse(context.nexusAuthPublicCompanySnapshot_(payload).value);
const snapshotKeys = ['businessAddress', 'businessNumber', 'companyName', 'companyPhone', 'homepage', 'representativeName', 'revision'];

const cold = call({ action: 'nexus_public_company_snapshot', knownRevision: 1 });
assert.equal(cold.status, 'success');
assert.equal(cold.action, 'nexus_public_company_snapshot');
assert.equal(cold.data.status, 'READY');
assert.deepEqual(Object.keys(cold.data.snapshot).sort(), snapshotKeys);
assert.equal(forwardedRequests.length, 1, 'cache miss must call upstream once');
assert.equal(forwardedRequests[0].action, 'nexus_gateway_company_public_profile_get');
assert.equal(forwardedRequests[0].knownRevision, 1);
assert.equal(forwardedRequests[0].actorId, 'NEXUS_GATEWAY');
assert.deepEqual(forwardedRequests[0].scope, { companyId: 'ONEAPP' });
assert.equal(forwardedRequests[0].nexusRequest.operationId, 'company.public_profile_read');
assert(!JSON.stringify(cold).includes('foundation-read-secret'), 'the service credential must never enter the public response');

const unchanged = call({ action: 'nexus_public_company_snapshot', knownRevision: 3 });
assert.deepEqual(unchanged.data, { status: 'UNCHANGED', revision: 3 });
assert.equal(forwardedRequests.length, 1, 'same revision must resolve from ScriptCache');

const cachedReady = call({ action: 'nexus_public_company_snapshot', knownRevision: 2 });
assert.equal(cachedReady.data.status, 'READY');
assert.equal(cachedReady.data.snapshot.revision, 3);
assert.equal(forwardedRequests.length, 1, 'lower known revision must receive the cached exact projection');

for (let index = 0; index < 5; index += 1) {
  const ahead = call({ action: 'nexus_public_company_snapshot', knownRevision: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(ahead.data, { status: 'STALE_SERVER', revision: 3 });
}
assert.equal(forwardedRequests.length, 1,
  'a warm cache must never call upstream when a client repeatedly claims a much higher revision');

for (const invalidRevision of ['3', Number.MAX_SAFE_INTEGER + 1, -1, 1.5]) {
  assert.throws(() => call({ action: 'nexus_public_company_snapshot', knownRevision: invalidRevision }),
    /NEXUS_PUBLIC_COMPANY_REVISION_INVALID/);
}

for (const injected of [
  { targetUrl: 'https://attacker.invalid' },
  { operationId: 'company.profile_write' },
  { token: 'attacker-token' },
  { payload: { action: 'nexus_gateway_company_profile_get' } },
]) {
  const before = forwardedRequests.length;
  const response = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ action: 'nexus_public_company_snapshot', knownRevision: 3, ...injected }) } }).value);
  assert.equal(response.status, 'error');
  assert.equal(forwardedRequests.length, before, 'invalid public payload must be rejected before upstream access');
}

const writeSnapshot = { ...serverData.snapshot, companyPhone: '02-1234-5678', revision: 4 };
assert.equal(context.nexusAuthPublicCompanyCacheAfterGateway_('company.profile_write', { publicSnapshot: writeSnapshot }), true);
const afterWrite = call({ action: 'nexus_public_company_snapshot', knownRevision: 4 });
assert.deepEqual(afterWrite.data, { status: 'UNCHANGED', revision: 4 });
assert.equal(forwardedRequests.length, 1, 'verified administrator write response must refresh public cache without another read');

cacheValues.set('NEXUS_PUBLIC_COMPANY_SNAPSHOT_ONEAPP_V1', '{corrupt');
serverData = { status: 'UNCHANGED', revision: 4 };
const corruptCache = call({ action: 'nexus_public_company_snapshot', knownRevision: 4 });
assert.deepEqual(corruptCache.data, { status: 'UNCHANGED', revision: 4 });
assert.equal(forwardedRequests.length, 2, 'corrupt cache must be removed and revalidated upstream once');

context.nexusAuthPublicCompanyCacheAfterGateway_('company.accounting_period_write', {});
assert.equal(context.nexusAuthPublicCompanyCacheRead_(), null, 'a revision-changing administrator operation must invalidate the public cache');

console.log('NEXUS public company gateway passed (exact projection, cache-only warm reads, strict knownRevision, injection denial, admin-write refresh).');
