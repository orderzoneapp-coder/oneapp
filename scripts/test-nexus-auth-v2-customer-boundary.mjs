#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const gatewaySource = read('nexus/server/nexus-auth-gateway.gs');
const cloudSource = read('orderq-cloud.gs');
const adapterSource = read('orderq/orderq-cloud-adapter.js');
const oneappSource = read('code.gs');

const gateway = vm.createContext({});
new vm.Script(gatewaySource, { filename: 'nexus-auth-gateway.gs' }).runInContext(gateway);
const registry = gateway.nexusAuthGatewayRegistry_();
const pull = registry['customer.master.pull'];
const push = registry['customer.master.push'];

assert.deepEqual(Array.from(pull.allowedApps), ['customer-manager']);
assert.deepEqual(Array.from(push.allowedApps), ['customer-manager']);
assert.deepEqual(Array.from(pull.requiredUserPermissions), ['customer.read']);
assert.deepEqual(Array.from(push.requiredUserPermissions), ['customer.write']);
assert.equal(pull.serviceBoundary, 'ORDERQ');
assert.equal(push.serviceBoundary, 'ORDERQ');
assert.equal(pull.serviceCredentialMode, 'READ');
assert.equal(push.serviceCredentialMode, 'WRITE');
assert(!pull.requiredUserPermissions.some(permission => permission.startsWith('orderq.')));
assert(!push.requiredUserPermissions.some(permission => permission.startsWith('orderq.')),
  'Customer Manager users must not need ORDER Q app permissions');

const cloud = vm.createContext({});
new vm.Script(cloudSource, { filename: 'orderq-cloud.gs' }).runInContext(cloud);
let pushedPayload = null;
cloud.orderQSyncPush = (_ss, payload) => { pushedPayload = payload; return { results: [{ status: 'applied' }] }; };
const allowedChanges = [
  { entityType: 'CUSTOMER' },
  { entityType: 'CUSTOMER_ALIAS' },
  { entityType: 'CUSTOMER_SOURCE_LINK' },
  { entityType: 'CUSTOMER_SOURCE_LINK_EVENT' },
  { entityType: 'CUSTOMER_HEADER_MAPPING' },
  { entityType: 'CUSTOMER_USER_FIELD_DEFINITION' },
  { entityType: 'IMPORT_BATCH' }
];
assert.equal(cloud.orderQCustomerMasterPush({}, { changes: allowedChanges }).results[0].status, 'applied');
assert.equal(pushedPayload.changes.length, allowedChanges.length);
assert.throws(() => cloud.orderQCustomerMasterPush({}, { changes: [{ entityType: 'ORDER' }] }), /ORDERQ_CUSTOMER_BOUNDARY_DENIED/);
assert.throws(() => cloud.orderQCustomerMasterPush({}, { changes: [{ entityType: 'PRODUCT' }] }), /ORDERQ_CUSTOMER_BOUNDARY_DENIED/);

cloud.orderQSyncPull = () => ({
  schemaVersion: 'ONEAPP_ORDERQ_SYNC_V1',
  changes: [
    { sequence: 10, entityType: 'ORDER' },
    { sequence: 11, entityType: 'CUSTOMER' },
    { sequence: 12, entityType: 'CUSTOMER_HEADER_MAPPING' }
  ],
  nextCursor: 12,
  hasMore: true
});
const customerPull = cloud.orderQCustomerMasterPull({}, {});
assert.deepEqual(Array.from(customerPull.changes, change => change.entityType), ['CUSTOMER', 'CUSTOMER_HEADER_MAPPING']);
assert.equal(customerPull.nextCursor, 12);
assert.equal(customerPull.hasMore, true);

assert.match(adapterSource, /ONEAPP_AUTH\?\.appId === 'customer-manager'/);
assert.match(adapterSource, /action === 'orderq_sync_push'\) return 'customer\.master\.push'/);
assert.match(adapterSource, /action === 'orderq_sync_pull'\) return 'customer\.master\.pull'/);
assert.match(oneappSource, /action === 'orderq_customer_master_push'/);
assert.match(oneappSource, /orderQCustomerMasterPush\(ss, payload\)/);
assert.match(oneappSource, /action === 'orderq_customer_master_pull'/);
assert.match(oneappSource, /orderQCustomerMasterPull\(ss, payload\)/);

console.log('NEXUS_AUTH_V2 Customer Manager boundary passed (ORDER Q service, customer-only data, no ORDER Q user permission).');
