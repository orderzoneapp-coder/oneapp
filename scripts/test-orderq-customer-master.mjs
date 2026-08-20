#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { ORDERQ_DB_VERSION, V9_STORE_DEFINITIONS } from '../orderq/orderq-v9-contracts.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  db, service, picker, ui, html, css, intakeEngine, intakeWorkbench,
  directInput, collectorRepository, collectorUi, cloud
] = await Promise.all([
  read('orderq/orderq-db.js'),
  read('orderq/customer-master.js'),
  read('orderq/customer-picker.js'),
  read('orderq/customer-master-ui.js'),
  read('orderq/customers.html'),
  read('orderq/customer-master.css'),
  read('orderq/intake-engine.js'),
  read('orderq/intake-workbench.js'),
  read('orderq/order-intake-engine.js'),
  read('orderq/history-collector/history-repository.js'),
  read('orderq/collector-ui.js'),
  read('orderq-cloud.gs')
]);

new vm.Script(cloud, { filename: 'orderq-cloud.gs' });
assert.equal(ORDERQ_DB_VERSION, 9);
assert.deepEqual(V9_STORE_DEFINITIONS.map(store => store.name), ['customerEvents']);
assert.match(db, /oldVersion < 9/);
assert.doesNotMatch(db, /const customerStore = tx\.objectStore/, 'v9 upgrade must use the provided upgrade transaction');
for (const index of ['byCanonicalCustomerId', 'byCustomerCode', 'byStatusQuality']) assert.match(db, new RegExp(index));

assert.match(service, /qualityStatus === CUSTOMER_QUALITY\.SUPERSEDED/);
assert.match(service, /const canonicalCustomerId = qualityStatus === CUSTOMER_QUALITY\.SUPERSEDED/);
assert.match(service, /export async function mergeCustomers/);
assert.match(service, /export async function unmergeCustomer/);
assert.match(service, /export async function getCustomerFamilyIds/);
assert.match(service, /export async function getUnifiedCustomerLedger/);
assert.match(service, /REVISION_CONFLICT/);
assert.match(service, /hasUnsyncedCustomerChanges/);
assert.match(service, /await pullRemote\(\)/);
assert.match(service, /CUSTOMER_IMPORT_STATUS\.CHANGED/);
assert.match(service, /fieldDecisions/);
assert.match(service, /canApplyCustomerImport/);

assert.match(picker, /등록 후 계속/);
assert.match(picker, /그래도 새로 등록/);
assert.match(picker, /customer\.status !== CUSTOMER_STATUS\.ACTIVE/);
assert.match(ui, /ROW_HEIGHT/);
assert.match(ui, /state\.filtered\.slice\(start, end\)/);
assert.match(ui, /canApplyCustomerImport\(state\.importRecords\)/);
assert.match(html, /customerExcelFile/);
assert.match(html, /거래처 Master/);
assert.match(html, /customer-master-ui\.js\?v=0\.12\.1/, 'Customer Master entry module must invalidate the deployed cache');
assert.match(service, /orderq-db\.js\?v=0\.12\.1/, 'Customer Master must load the fixed DB upgrade module URL');
assert.match(css, /\.cm-viewport/);

assert.doesNotMatch(intakeEngine, /if \(!customer\) throw new Error\('ORDERQ_INTAKE_CUSTOMER_REQUIRED'\)/);
assert.match(intakeEngine, /rematchExtractedLinesForCustomer/);
assert.match(intakeWorkbench, /source: 'ORDER_IN_QUICK_CREATE'/);
assert.match(intakeWorkbench, /customerOverride: customer \?/);

assert.doesNotMatch(directInput, /customerStore\.add\(customer\)/);
assert.match(directInput, /미등록 거래처입니다/);
assert.doesNotMatch(collectorRepository, /customer = candidate;\s*customerStore?\.put/);
assert.match(collectorRepository, /미등록 거래처입니다/);
assert.match(collectorUi, /resolvePreparedCustomers/);
assert.match(collectorUi, /openCustomerPicker/);

assert.doesNotMatch(cloud, /source: 'ORDER_SYNC'/);
assert.match(cloud, /ORDERQ_CUSTOMER_NOT_FOUND/);
assert.match(cloud, /ORDERQ_CUSTOMER_SUPERSEDED/);

console.log('ORDER Q Customer Master contracts: PASS');
console.log(JSON.stringify({
  schemaVersion: ORDERQ_DB_VERSION,
  customerEventStore: V9_STORE_DEFINITIONS[0].name,
  canonicalCustomer: 'PASS',
  mergeUnmerge: 'PASS',
  pickerQuickCreate: 'PASS',
  cloudAutoCreateBlocked: 'PASS',
  virtualizedImportWorkbench: 'PASS'
}, null, 2));
