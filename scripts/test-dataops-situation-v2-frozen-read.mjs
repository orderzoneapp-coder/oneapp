import assert from 'node:assert/strict';
import { baseEntities, configureAuthority, makeAuthority, snapshotEnvelope } from './dataops-situation-v2-test-harness.mjs';

const authority = makeAuthority({ entities: baseEntities() });
const credentials = configureAuthority(authority);
const publish = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_publish', { ...credentials, ...snapshotEnvelope(authority.context) });
assert.equal(publish.manifest.status, 'PUBLISHED');
const begin = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_begin', credentials);
assert.equal(begin.status, 'OPEN');
assert.equal((new Date(begin.expiresAt) - new Date(begin.issuedAt)) / 1000, 120);
assert.ok(!JSON.stringify(begin).includes(credentials.token));
const request = { ...credentials, readSessionId: begin.readSessionId, tokenDigest: begin.tokenDigest, scope: credentials.scope };
const page = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', { ...request, pageIndex: 0 });
assert.equal(page.rows.length, 1);
assert.throws(() => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', { ...request, actorId: 'OTHER', pageIndex: 0 }), /DATAOPS_SITUATION_ACCESS_DENIED/);
assert.throws(() => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', { ...request, scope: { companyId: 'OTHER' }, pageIndex: 0 }), /DATAOPS_SITUATION_SCOPE_NOT_ALLOWED/);
assert.throws(() => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', { ...request, tokenDigest: '0'.repeat(64), pageIndex: 0 }), /SITUATION_READ_TOKEN_INVALID/);
const head = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_head', request);
assert.equal(head.beginHeadRevision, head.currentHeadRevision);
assert.equal(authority.context.dataOpsSituationReadSessions(authority.ss).rows.find(row => row.readSessionId === begin.readSessionId).status, 'CONSUMED');

const expiring = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_begin', credentials);
const expiringRequest = { ...credentials, readSessionId: expiring.readSessionId, tokenDigest: expiring.tokenDigest, scope: credentials.scope };
const stored = authority.context.dataOpsSituationReadSessions(authority.ss).rows.find(row => row.readSessionId === expiring.readSessionId).payload;
const expiredStored = { ...stored, expiresAt: new Date(Date.now() - 1).toISOString() };
expiredStored.tokenDigest = authority.context.dataOpsSituationSessionToken(expiredStored, authority.properties);
authority.context.dataOpsSituationSaveSession(authority.ss, expiredStored);
expiringRequest.tokenDigest = expiredStored.tokenDigest;
assert.throws(() => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', { ...expiringRequest, pageIndex: 0 }), /SITUATION_READ_TOKEN_EXPIRED/);

for (const mutate of [
  session => { session.expiresAt = new Date(Date.now() + 999999).toISOString(); },
  session => { session.scopeDigest = '0'.repeat(64); },
  session => { session.pageManifest[0].rowCount += 1; },
  session => { session.tombstoneManifest.count += 1; },
  session => { session.snapshotRevision += 1; },
  session => { session.slot = session.slot === 'A' ? 'B' : 'A'; },
  session => { session.deploymentVersion = 'tampered'; }
]) {
  const attack = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_begin', credentials);
  const attackStored = structuredClone(authority.context.dataOpsSituationReadSessions(authority.ss).rows.find(row => row.readSessionId === attack.readSessionId).payload);
  mutate(attackStored);
  authority.context.dataOpsSituationSaveSession(authority.ss, attackStored);
  assert.throws(() => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', {
    ...credentials, readSessionId: attack.readSessionId, tokenDigest: attack.tokenDigest, pageIndex: 0
  }), /SITUATION_READ_TOKEN_INVALID/, 'stored session payload tamper invalidates HMAC');
}
assert.ok(!JSON.stringify([...authority.ss.sheets.values()].map(sheet => sheet.rows)).includes(credentials.token), 'raw auth token never reaches Sheets/audit/session');
const auditRows = authority.ss.getSheetByName('DataOpsSituationV2_Audit').rows;
assert.ok(auditRows.some(row => row.includes('DEVICE-1') && row.includes('TEST')), 'audit preserves actor device and environment context');

const pageTamper = makeAuthority({ entities: baseEntities() });
const pageTamperCredentials = configureAuthority(pageTamper);
pageTamper.context.dataOpsSituationHandleAction(pageTamper.ss, 'situation_dataops_publish', { ...pageTamperCredentials, ...snapshotEnvelope(pageTamper.context) });
const pageTamperSession = pageTamper.context.dataOpsSituationHandleAction(pageTamper.ss, 'situation_dataops_begin', pageTamperCredentials);
const storedSnapshot = pageTamper.context.dataOpsSituationCurrentSnapshot(pageTamper.ss, pageTamper.properties).snapshot;
storedSnapshot.rows[0].signedBaseQuantity = 999;
pageTamper.context.dataOpsSituationWriteSlot(pageTamper.ss, 'DataOpsSituationV2_A', storedSnapshot);
assert.throws(() => pageTamper.context.dataOpsSituationHandleAction(pageTamper.ss, 'situation_dataops_page', {
  ...pageTamperCredentials, readSessionId: pageTamperSession.readSessionId, tokenDigest: pageTamperSession.tokenDigest, pageIndex: 0
}), /DATAOPS_V2_MANIFEST_MISMATCH/, 'pinned page digest rejects slot data tamper');
console.log('DataOps Situation V2 frozen read tests passed');
