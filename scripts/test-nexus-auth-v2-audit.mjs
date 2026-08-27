#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'nexus/server/nexus-auth-gateway.gs'), 'utf8');
let uuid = 0;
const context = vm.createContext({ Utilities: { getUuid: () => `00000000-0000-0000-0000-${String(++uuid).padStart(12, '0')}` } });
new vm.Script(source).runInContext(context);

const audits = [];
const forwarded = [];
let currentUser = { userId: 'USR-1', loginId: 'alpha', role: 'OWNER_MASTER' };
context.nexusAuthJson_ = value => value;
context.nexusAuthGatewayAudit_ = (...args) => audits.push(args);
context.nexusAuthRequireSession_ = () => ({ user: currentUser, session: { expiresAt: '2099-01-01T00:00:00.000Z' } });
context.nexusAuthRequireAppContext_ = () => ({ appId: 'orderops' });
context.nexusAuthRequirePermission_ = () => true;
const routeSecrets = new Map();
context.nexusAuthGatewayCredential_ = (boundary, access) => { const key=`${boundary}-${access}`;if(!routeSecrets.has(key))routeSecrets.set(key,crypto.randomBytes(32).toString('hex'));return { token:routeSecrets.get(key),credentialId:key,version:'V2' }; };
context.nexusAuthGatewayFetch_ = envelope => { forwarded.push(envelope); return { status: 'success', data: { ok: true }, correlationId: 'ONEAPP-1' }; };

const invoke = (operationId = 'shipping.plan.list', payload = {}) => context.nexusAuthGateway_({ sessionToken: 'SESSION', operationId, payload });
const success = invoke();
assert.equal(success.status, 'success');
assert.equal(success.contractVersion, 'NEXUS_AUTH_V2');
assert.equal(forwarded[0].actorId, 'NEXUS_GATEWAY');
assert.equal(forwarded[0].nexusRequest.subjectUserId, 'USR-1');
assert.equal(forwarded[0].nexusRequest.appId, 'orderops');
assert.equal(audits.at(-1)[5], 'SUCCESS');

currentUser = { userId: 'USR-2', loginId: 'beta', role: 'OWNER_MASTER' };
invoke();
assert.equal(forwarded[1].token, forwarded[0].token, 'multiple users share the same server credential');
assert.equal(forwarded[1].actorId, 'NEXUS_GATEWAY');
assert.equal(forwarded[1].nexusRequest.subjectUserId, 'USR-2');

function failure(label, setup, expected, expectedResult = 'FAILURE') {
  const before = audits.length;
  const restore = setup();
  assert.throws(() => invoke(), expected, label);
  assert.equal(audits.length, before + 1, `${label} audit missing`);
  assert.equal(audits.at(-1)[5], expectedResult, `${label} audit result`);
  restore?.();
}

let before = audits.length;
assert.throws(() => invoke('unknown.operation'), /NEXUS_GATEWAY_OPERATION_DENIED/);
assert.equal(audits.length, before + 1, 'unknown operation audit');
assert.equal(audits.at(-1)[5], 'DENIED', 'unknown operation audit result');

failure('session failure', () => {
  const original = context.nexusAuthRequireSession_;
  context.nexusAuthRequireSession_ = () => { throw new Error('NEXUS_AUTH_SESSION_EXPIRED'); };
  return () => { context.nexusAuthRequireSession_ = original; };
}, /NEXUS_AUTH_SESSION_EXPIRED/, 'DENIED');

failure('app context failure', () => {
  const original = context.nexusAuthRequireAppContext_;
  context.nexusAuthRequireAppContext_ = () => { throw new Error('NEXUS_AUTH_APP_CONTEXT_DENIED'); };
  return () => { context.nexusAuthRequireAppContext_ = original; };
}, /NEXUS_AUTH_APP_CONTEXT_DENIED/, 'DENIED');

failure('permission failure', () => {
  const original = context.nexusAuthRequirePermission_;
  context.nexusAuthRequirePermission_ = () => { throw new Error('NEXUS_AUTH_PERMISSION_DENIED'); };
  return () => { context.nexusAuthRequirePermission_ = original; };
}, /NEXUS_AUTH_PERMISSION_DENIED/, 'DENIED');

before = audits.length;
assert.throws(() => context.nexusAuthGateway_({ sessionToken: 'SESSION', operationId: 'shipping.plan.get', payload: { appId: 'forged' } }), /NEXUS_GATEWAY_SCHEMA_DENIED/);
assert.equal(audits.length, before + 1, 'schema/forgery audit');
assert.equal(audits.at(-1)[5], 'DENIED', 'schema/forgery audit result');

failure('credential failure', () => {
  const original = context.nexusAuthGatewayCredential_;
  context.nexusAuthGatewayCredential_ = () => { throw new Error('NEXUS_AUTH_SERVICE_NOT_CONNECTED'); };
  return () => { context.nexusAuthGatewayCredential_ = original; };
}, /NEXUS_AUTH_SERVICE_NOT_CONNECTED/);

failure('network failure', () => {
  const original = context.nexusAuthGatewayFetch_;
  context.nexusAuthGatewayFetch_ = () => { throw new Error('NEXUS_GATEWAY_NETWORK_FAILED'); };
  return () => { context.nexusAuthGatewayFetch_ = original; };
}, /NEXUS_GATEWAY_NETWORK_FAILED/);

failure('response parse failure', () => {
  const original = context.nexusAuthGatewayFetch_;
  context.nexusAuthGatewayFetch_ = () => { throw new Error('NEXUS_GATEWAY_RESPONSE_INVALID'); };
  return () => { context.nexusAuthGatewayFetch_ = original; };
}, /NEXUS_GATEWAY_RESPONSE_INVALID/);

failure('ONEAPP credential denial', () => {
  const original = context.nexusAuthGatewayFetch_;
  context.nexusAuthGatewayFetch_ = () => ({ status: 'error', message: 'ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED' });
  return () => { context.nexusAuthGatewayFetch_ = original; };
}, /ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED/, 'DENIED');

assert.match(source, /protocol: NEXUS_AUTH_LEGACY_VERSION/);
assert.match(source, /NEXUS_AUTH_LEGACY_VERSION = 'LEGACY_V1'/);
assert.match(fs.readFileSync(path.join(process.cwd(), 'code.gs'), 'utf8'), /protocol: 'LEGACY_V1'/);

console.log(`NEXUS_AUTH_V2 audit paths passed (${audits.length} audited requests, success and all required failure classes).`);
