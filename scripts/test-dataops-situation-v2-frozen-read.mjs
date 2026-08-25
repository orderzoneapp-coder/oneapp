import assert from 'node:assert/strict';
import { baseEntities, configureAuthority, makeAuthority, snapshotInput } from './dataops-situation-v2-test-harness.mjs';

const authority = makeAuthority({ entities: baseEntities() });
const credentials = configureAuthority(authority);
const publish = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_publish', { ...credentials, snapshot: snapshotInput(authority.context) });
assert.equal(publish.status, 'PUBLISHED');
const begin = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_begin', credentials);
assert.equal(begin.status, 'OPEN');
assert.equal((new Date(begin.expiresAt) - new Date(begin.issuedAt)) / 1000, 120);
assert.ok(!JSON.stringify(begin).includes(credentials.token));
const request = { ...credentials, readSessionId: begin.readSessionId, tokenDigest: begin.tokenDigest, scope: credentials.scope };
const page = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', { ...request, pageIndex: 0 });
assert.equal(page.rows.length, 1);
assert.throws(() => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', { ...request, actorId: 'OTHER', pageIndex: 0 }), /DATAOPS_SITUATION_ACCESS_DENIED/);
assert.throws(() => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', { ...request, scope: { companyId: 'OTHER' }, pageIndex: 0 }), /SITUATION_READ_SCOPE_MISMATCH/);
assert.throws(() => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', { ...request, tokenDigest: '0'.repeat(64), pageIndex: 0 }), /SITUATION_READ_TOKEN_INVALID/);
const head = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_head', request);
assert.equal(head.beginHeadRevision, head.currentHeadRevision);
assert.equal(authority.context.dataOpsSituationReadSessions(authority.ss).rows.find(row => row.readSessionId === begin.readSessionId).status, 'CONSUMED');

const expiring = authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_begin', credentials);
const expiringRequest = { ...credentials, readSessionId: expiring.readSessionId, tokenDigest: expiring.tokenDigest, scope: credentials.scope };
const stored = authority.context.dataOpsSituationReadSessions(authority.ss).rows.find(row => row.readSessionId === expiring.readSessionId).payload;
authority.context.dataOpsSituationSaveSession(authority.ss, { ...stored, expiresAt: new Date(Date.now() - 1).toISOString() });
assert.throws(() => authority.context.dataOpsSituationHandleAction(authority.ss, 'situation_dataops_page', { ...expiringRequest, pageIndex: 0 }), /SITUATION_READ_TOKEN_EXPIRED/);
assert.ok(!JSON.stringify([...authority.ss.sheets.values()].map(sheet => sheet.rows)).includes(credentials.token), 'raw auth token never reaches Sheets/audit/session');
console.log('DataOps Situation V2 frozen read tests passed');
