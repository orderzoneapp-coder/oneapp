#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const contractSource = read('smartinput/smartinput-contract.js');
const appSource = read('smartinput/smartinput.js');
const dataStoreSource = read('smartinput/smartinput-data-store.js');
const html = read('smartinput/index.html');
const css = read('smartinput/smartinput.css');
const readme = read('smartinput/README.md');
const architecture = read('APP_ARCHITECTURE.md');
const manifest = JSON.parse(read('app-manifest.json'));

const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;

assert.equal(contract.APP_ID, 'smart-input');
assert.equal(contract.SCHEMA_VERSION, 'ONEAPP_SMART_INPUT_DRAFT_V1');
assert.equal(contract.DRAFT_STORAGE_KEY, 'oneapp.smartinput.draft.v1');
assert.equal(contract.DRAFT_LIST_STORAGE_KEY, 'oneapp.smartinput.drafts.v1');
assert.equal(contract.DELIVERY_HISTORY_KEY, 'oneapp.smartinput.delivery-history.v1');
assert.equal(contract.SETTINGS_STORAGE_KEY, 'oneapp.smartinput.settings.v1');
assert.deepEqual(Array.from(contract.INPUT_METHODS, item => item.id), ['direct', 'excel', 'text', 'paste', 'photo', 'voice']);
assert.deepEqual(Array.from(contract.STAGES), ['capture', 'extract', 'match', 'review', 'complete']);

const draft = contract.createDraft({ date: '2026-08-23', now: 1, random: 0.1 });
assert.equal(draft.activeMode, 'order');
assert.equal(draft.modes.order.header.orderDate, '2026-08-23');
assert.ok(draft.modes.order.documentId);
assert.notEqual(draft.modes.order, draft.modes.purchase);
draft.modes.order.sourceText = '주문 원문';
assert.equal(draft.modes.purchase.sourceText, '');

const rawText = '  행복상회\n계란  2판\n';
const firstBatch = contract.createBatch({ batchId: 'B1', sequence: 1, method: 'text', sourceType: 'GENERAL_TEXT', rawText, now: 1 });
assert.equal(firstBatch.rawText, rawText, 'source whitespace and line breaks must be preserved');
let rows = contract.applyParserResults([], firstBatch, [{
  sourceLineKey: 'L1', intakeLineId: 'IL1', rawText: '계란  2판', productId: 'P1', itemCode: 'A001', itemName: '계란', quantity: 2, unit: '판'
}]);
assert.equal(rows.length, 1);
assert.equal(rows[0].matchStatus, 'MATCHED');
rows[0] = contract.markUserEdit(rows[0], 'itemName', '관리자 확정 계란');
rows = contract.applyParserResults(rows, firstBatch, [{
  sourceLineKey: 'L1', intakeLineId: 'IL1', rawText: '계란  2판', productId: 'P1', itemCode: 'A001', itemName: '파서 덮어쓰기', quantity: 3, unit: '판'
}]);
assert.equal(rows.length, 1, 're-analysis of the same source line must update, not append');
assert.equal(rows[0].itemName, '관리자 확정 계란', 'administrator edits must survive re-analysis');
assert.equal(rows[0].quantity, 3, 'parser-owned fields may refresh');

const secondBatch = contract.createBatch({ batchId: 'B2', sequence: 2, method: 'paste', sourceType: 'CLIPBOARD', rawText: '계란 1판', now: 2 });
rows = contract.applyParserResults(rows, secondBatch, [{
  sourceLineKey: 'L2', rawText: '계란 1판', productId: 'P1', itemCode: 'A001', itemName: '계란', quantity: 1, unit: '판'
}]);
assert.equal(rows.length, 2, 'later batches must append below existing rows');
assert.equal(rows.filter(row => row.duplicatePossible).length, 2, 'duplicate products must be marked, not summed');

const orderDraft = draft.modes.order;
orderDraft.header = {
  ...orderDraft.header,
  customerId: 'C1', customerName: '행복상회', orderDate: '2026-08-23', warehouseName: '본사'
};
orderDraft.rows = rows;
assert.deepEqual(Array.from(contract.validateOrderDraft(orderDraft)), []);
orderDraft.header.customerId = '';
assert.equal(contract.validateOrderDraft(orderDraft)[0].field, 'customer');

const cutoffSettings = contract.normalizeSettings({
  orderCutoffTime: '12:00',
  allowSameDayDelivery: true,
  defaultDeliveryWeekdays: [0],
  timezone: 'Asia/Seoul'
});
assert.equal(contract.validateDeliveryDate({
  orderDate: '2026-08-23', deliveryDate: '2026-08-23', settings: cutoffSettings,
  now: new Date('2026-08-23T01:00:00.000Z')
}).valid, true, 'same-day delivery must remain available before cutoff');
assert.equal(contract.validateDeliveryDate({
  orderDate: '2026-08-23', deliveryDate: '2026-08-23', settings: cutoffSettings,
  now: new Date('2026-08-23T04:00:00.000Z')
}).code, 'CUTOFF_PASSED', 'same-day delivery must be blocked after cutoff');

const scheduleSettings = contract.normalizeSettings({
  defaultDeliveryWeekdays: [1, 3],
  deliveryCustomerWeekdays: { C1: [2] },
  holidayDates: ['2026-08-24'],
  timezone: 'Asia/Seoul'
});
assert.equal(contract.nextDeliveryDate({ orderDate: '2026-08-23', settings: scheduleSettings }).date, '2026-08-26');
assert.equal(contract.nextDeliveryDate({ orderDate: '2026-08-23', customerId: 'C1', settings: scheduleSettings }).date, '2026-08-25');

for (const mode of ['order', 'purchase', 'sale']) assert.match(html, new RegExp(`data-mode="${mode}"`));
for (const method of ['direct', 'excel', 'text', 'paste', 'photo', 'voice']) assert.match(html, new RegExp(`data-method="${method}"`));
assert.match(html, /Alt\+1/);
assert.match(html, /Alt\+2/);
assert.match(html, /Alt\+3/);
assert.match(html, /href="\.\.\/orderq\/index\.html" target="_blank" rel="noopener"/);
assert.match(html, /href="\.\.\/orders\.html" target="_blank" rel="noopener"/);
assert.match(html, /<nexus-top app-id="smart-input">/);
assert.match(html, /nexus\/common\/apps-config\.js/);
assert.match(html, /nexus\/common\/nexus-top\.js/);
assert.match(html, /id="draftListButton"/);
assert.match(html, /id="settingsButton"/);
assert.match(html, /id="taxCustomerInput"/);

assert.match(css, /grid-template-columns: 180px minmax\(0, 1fr\) 220px/);
assert.match(css, /@media \(max-width: 1180px\)/);
assert.match(css, /@media \(max-width: 820px\)/);
assert.match(css, /prefers-color-scheme: dark/);
assert.match(css, /prefers-reduced-motion: reduce/);

for (const required of [
  'captureTextIntake',
  'analyzeSingleOrderDocument',
  'rematchExtractedLinesForCustomer',
  'createOrder',
  'syncAfterLocalMutation',
  'loadProductCatalog',
  'createLiveCustomer',
  'loadSmartInputData',
  'saveLinkGroup',
  'saveAliasMapping',
  'orderCutoffTime',
  'deliveryCustomerWeekdays',
  'window.Tesseract',
  'SpeechRecognition',
  'captureOccurrenceId',
  'appendDeliveryHistory'
]) assert.match(appSource, new RegExp(required));
assert.match(appSource, /customerInput'\)\.focus\(\)/);
assert.match(appSource, /SMART_INPUT:\$\{current\.batches\[0\]/);
assert.match(appSource, /editedFields/);
assert.match(appSource, /다음 가능일은 \$\{nextAvailable\.date\}입니다/);
assert.match(appSource, /mappingSource: 'PARSER_CONFIRMED', learnAlias: false/);
assert.doesNotMatch(appSource, /data-order-customer/);
assert.match(dataStoreSource, /oneapp-smartinput/);
assert.match(dataStoreSource, /customerLinkGroups/);
assert.match(dataStoreSource, /temporaryCustomers/);
assert.match(dataStoreSource, /customerAliasMappings/);

const app = manifest.applications.find(item => item.id === 'smart-input');
assert.ok(app, 'smart-input must be registered in the manifest');
assert.equal(app.path, 'smartinput/index.html');
assert.equal(app.status, 'pilot');
assert.ok(app.sharedContracts.includes('nexus-header'), 'SmartInput must display the existing NEXUS header');
assert.ok(app.sharedContracts.includes('orderq-vnext-sync'));
assert.ok(app.sharedContracts.includes('product-master'));
const orderLedger = manifest.sharedDataContracts.find(item => item.id === 'orderq-vnext-sync');
assert.ok(orderLedger.consumers.includes('smartinput/index.html'));
const nexusHeader = manifest.sharedDataContracts.find(item => item.id === 'nexus-header');
assert.ok(nexusHeader.consumers.includes('smartinput/index.html'));

assert.match(readme, /\/smartinput\//);
assert.match(readme, /orders\.html.*별도 전달 어댑터/);
assert.match(architecture, /### 6\.7 Standalone SmartInput intake/);
assert.match(architecture, /does not claim direct `orders\.html` delivery/);
assert.match(architecture, /Customer linking is relational, never canonical merging/);
assert.match(architecture, /same-day cutoff/);

console.log('SmartInput standalone contract PASS');
