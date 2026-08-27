#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const gatewaySource = read('nexus/server/nexus-auth-gateway.gs');
const oneappSource = read('code.gs');
const dataOpsSource = read('DataOps.html');

const gateway = vm.createContext({});
new vm.Script(gatewaySource, { filename: 'nexus-auth-gateway.gs' }).runInContext(gateway);
const registry = gateway.nexusAuthGatewayRegistry_();
const commit = registry['dataops.snapshot.commit'];

assert.deepEqual(Array.from(commit.requiredUserPermissions), [], 'ordinary DataOps save must not require dataops.write');
assert.deepEqual(Array.from(commit.requiredPurposePermissions), [], 'ordinary DataOps save has no purpose permission');
assert.deepEqual(Array.from(commit.writableFields), ['기초', '주문', '입고', '출고', '실사', '단가'], 'all direct-edit fields, including phase-2 order and price, remain writable');
assert.deepEqual(Array.from(commit.serverComputedFields), ['전산잔량', '예상잔량', '로스', 'savedAt', 'revision']);
assert.deepEqual(Array.from(commit.preconditionFields), ['hash'], 'hash is a precondition, not a writable business field');
assert.equal(commit.serviceCredentialMode, 'WRITE');

const checkedPermissions = [];
gateway.nexusAuthRequirePermission_ = (user, permission) => {
  checkedPermissions.push(permission);
  const permissions = JSON.parse(user.permissionsJson || '[]');
  if (!permissions.includes(permission)) throw new Error('NEXUS_AUTH_PERMISSION_DENIED');
  return true;
};
const custom = permissions => ({ user: { role: 'CUSTOM', permissionsJson: JSON.stringify(permissions) } });
const viewer = permissions => ({ user: { role: 'VIEWER', permissionsJson: JSON.stringify(permissions) } });

assert.doesNotThrow(() => gateway.nexusAuthRequireOperationAccess_(custom(['dataops.read']), commit));
assert.deepEqual(checkedPermissions.splice(0), [], 'ordinary save must not check a hidden detail permission');
assert.throws(() => gateway.nexusAuthRequireOperationAccess_(viewer(['dataops.read']), commit), /NEXUS_AUTH_VIEWER_READ_ONLY/);

const publish = registry['dataops.situation.publish'];
assert.doesNotThrow(() => gateway.nexusAuthRequireOperationAccess_(custom(['dataops.read']), publish));
assert.deepEqual(Array.from(publish.requiredPurposePermissions), []);

const close = registry['dataops.close.commit'];
assert.doesNotThrow(() => gateway.nexusAuthRequireOperationAccess_(custom(['dataops.read']), close));
assert.deepEqual(Array.from(close.requiredPurposePermissions), []);
assert(!close.requiredPurposePermissions.includes('dataops.write'), 'close must not redundantly require dataops.write');

assert.doesNotThrow(() => gateway.nexusAuthGatewayValidatePayload_(commit, { snapshot: { hash: 'a'.repeat(64) } }));
for (const immutable of ['전산잔량', '예상잔량', '로스', 'savedAt', 'revision']) {
  assert.throws(
    () => gateway.nexusAuthGatewayValidatePayload_(commit, { snapshot: { rows: [{ [immutable]: 1 }] } }),
    /IMMUTABLE_FIELD/,
    `${immutable} must be rejected by Gateway`
  );
}
for (const immutable of ['actorId', 'appId', 'credentialMode', 'credential', 'token', 'requestId']) {
  assert.throws(
    () => gateway.nexusAuthGatewayValidatePayload_(commit, { snapshot: { metadata: { [immutable]: 'forged' } } }),
    /IMMUTABLE_FIELD/,
    `${immutable} must be rejected recursively`
  );
}
assert.equal(gateway.nexusAuthPublicError_(new Error('IMMUTABLE_FIELD')), 'IMMUTABLE_FIELD',
  'the browser must receive the safe immutable-field error code');
assert.equal(gateway.nexusAuthPublicError_(new Error('CLOSE_SOURCE_DIGEST_INVALID')), 'CLOSE_SOURCE_DIGEST_INVALID',
  'safe uppercase DataOps/close errors must remain actionable without exposing raw upstream responses');
assert.equal(gateway.nexusAuthPublicError_(new Error('private detail: token=secret')), 'NEXUS_AUTH_REQUEST_FAILED',
  'unstructured upstream details must remain hidden');
assert.equal(gateway.nexusAuthGatewayUpstreamError_({ message: 'DATAOPS_V2_OPERATIONAL_MASTER_REQUIRED:PRODUCT:101020114' }),
  'DATAOPS_V2_OPERATIONAL_MASTER_REQUIRED', 'structured business details must be reduced to the safe code prefix');
assert.equal(gateway.nexusAuthGatewayUpstreamError_({ message: 'failure included token=secret' }), 'NEXUS_GATEWAY_UPSTREAM_DENIED',
  'unstructured upstream details must never cross the Gateway boundary');

const properties = new Map();
const oneapp = vm.createContext({
  PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || '', setProperty: (key, value) => properties.set(key, String(value)) }) },
  Utilities: {}
});
new vm.Script(oneappSource, { filename: 'code.gs' }).runInContext(oneapp);
assert.doesNotThrow(() => oneapp.oneappNexusRejectDataOpsSnapshotImmutableFields({ hash: 'a'.repeat(64), rows: [[1, 2, 3]] }));
for (const immutable of ['전산잔량', '예상잔량', '로스', 'savedAt', 'revision']) {
  assert.throws(() => oneapp.oneappNexusRejectDataOpsSnapshotImmutableFields({ nested: { [immutable]: 1 } }), /IMMUTABLE_FIELD/,
    `${immutable} must also be rejected by ONEAPP`);
}

assert.match(dataOpsSource, /const DATAOPS_ACCESS_POLICY_MODULE = Object\.freeze/);
assert.match(dataOpsSource, /role === 'VIEWER'/);
for (const field of ['price-input', 'base-prev', 'base-in', 'base-out', 'base-order', 'actual-input']) {
  const inputPattern = new RegExp(`data-field": "${field}"[^>\n]*disabled: DATAOPS_ACCESS_POLICY_MODULE\\.isViewer\\(\\)`);
  assert.match(dataOpsSource, inputPattern, `${field} must be disabled for VIEWER`);
}
assert.match(dataOpsSource, /item\.로스 !== 0 && React\.createElement\("div"/);
assert.doesNotMatch(dataOpsSource, /data-field": "(?:loss|로스)/, 'computed loss is displayed without an edit field');

const buildSnapshotBlock = dataOpsSource.slice(
  dataOpsSource.indexOf('buildSnapshot: async ({ productData'),
  dataOpsSource.indexOf('mapCommitError:', dataOpsSource.indexOf('buildSnapshot: async ({ productData'))
);
assert.doesNotMatch(buildSnapshotBlock, /savedAt\s*:/, 'browser snapshot must not submit server-generated savedAt');

console.log('NEXUS_AUTH_V2 DataOps policy passed (existing edits/publish/close, VIEWER read-only, immutable fields).');
