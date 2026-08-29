#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { deliveryState, executeVoucherGroups, rowsForFailedGroups } from '../smartinput/workflow-core.js';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('smartinput/index.html');
const appSource = read('smartinput/smartinput.js');
const adapterSource = read('smartinput/integration-adapter.js');
const storeSource = read('smartinput/smartinput-data-store.js');
const commonUiSource = read('nexus/common/nexus-ui.js');
const architecture = read('APP_ARCHITECTURE.md');
const manifest = JSON.parse(read('app-manifest.json'));

assert.match(html, /nexus-ui-theme-init\.js\?v=1\.1\.0/);
assert.match(html, /nexus-ui\.css\?v=1\.2\.1/);
assert.match(html, /nexus-ui-app-themes\.css\?v=1\.2\.0/);
assert.match(html, /data-nexus-app-id="smart-input"/);
assert.doesNotMatch(html, /nexus-theme-init\.js|apps-config\.js|nexus-top\.js|customer-master\.css|<nexus-top/i);
assert.doesNotMatch(html, /<kbd|Alt\+[1234]/i);
assert.doesNotMatch(appSource, /\.altKey|Alt\+[1234]/i);
assert.doesNotMatch(appSource, /from\s+['"]\.\.\/orderq\//, 'SmartInput core must not statically import another app');
assert.match(adapterSource, /await import\(path\)/, 'external app modules must stay behind a dynamic boundary');
assert.doesNotMatch(adapterSource, /ensureCustomerMasterReady|65000|REFERENCE_(?:ERROR|NOT_READY)/);
assert.match(appSource, /renderAll\(\);[\s\S]*?void loadLocalData\(\);\s*refreshReferences\(\);/,
  'the local shell must render before optional reference work');
assert.match(appSource, /cdn\.jsdelivr\.net\/npm\/xlsx/);
assert.match(appSource, /cdn\.jsdelivr\.net\/npm\/tesseract\.js/);
assert.doesNotMatch(html, /cdn\.jsdelivr\.net|unpkg\.com/, 'optional libraries must not block initial HTML parsing');

assert.match(storeSource, /const DB_NAME = 'oneapp-smartinput'/);
assert.match(storeSource, /const DB_VERSION = 3/);
for (const store of ['settings', 'customerLinkGroups', 'temporaryCustomers', 'customerAliasMappings', 'estimates', 'sourceImages']) {
  assert.match(storeSource, new RegExp(`['"]${store}['"]`));
}
assert.doesNotMatch(storeSource, /deleteDatabase|\.clear\s*\(/, 'recovery must not erase existing SmartInput data');
assert.doesNotMatch(commonUiSource, /oneapp-smartinput|indexedDB/i, 'common UI must not read or initialize SmartInput business storage');

const contractSource = read('smartinput/smartinput-contract.js');
const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;
assert.equal(contract.DRAFT_STORAGE_KEY, 'oneapp.smartinput.draft.v1');
assert.equal(contract.DRAFT_LIST_STORAGE_KEY, 'oneapp.smartinput.drafts.v1');
assert.equal(contract.DELIVERY_HISTORY_KEY, 'oneapp.smartinput.delivery-history.v1');
assert.equal(contract.SETTINGS_STORAGE_KEY, 'oneapp.smartinput.settings.v1');
assert.deepEqual(Object.keys(contract.MODES), ['order', 'purchase', 'sale', 'estimate']);
assert.deepEqual(Array.from(contract.INPUT_METHODS, item => item.id), ['direct', 'excel', 'text', 'paste', 'photo', 'voice']);

const smartInput = manifest.applications.find(app => app.id === 'smart-input');
assert.equal(smartInput.path, 'smartinput/index.html');
assert.equal(smartInput.status, 'pilot');
assert.equal(smartInput.owner, 'voucher-input');
assert.equal(smartInput.dependencyMode.localDraftAndEstimate, 'LOCAL_OPERATION');
assert.equal(smartInput.dependencyMode.orderSaveThenSync, 'BACKGROUND_SYNC');
assert.equal(smartInput.dependencyMode.purchaseAndSaleFinalize, 'SERVER_FINALIZE');
const localContract = manifest.sharedDataContracts.find(item => item.id === 'smartinput-local-work');
assert.equal(localContract.localDatabase, 'oneapp-smartinput');
assert.equal(localContract.databaseVersion, 3);
assert.match(commonUiSource, /id: 'smart-input'.*path: 'smartinput\/index\.html'/);
assert.match(architecture, /SmartInput \(`smartinput\/index\.html`\) \| 파일럿/);

const rows = [{ rowId: 'R1' }, { rowId: 'R2' }, { rowId: 'R3' }];
const groups = [
  { voucherGroupKey: 'G1', rows: [rows[0], rows[1]] },
  { voucherGroupKey: 'G2', rows: [rows[2]] }
];
const results = await executeVoucherGroups(groups, async group => {
  if (group.voucherGroupKey === 'G2') throw Object.assign(new Error('SERVER_FINALIZE_FAILED'), { code: 'SERVER_FINALIZE_FAILED' });
  return { id: group.voucherGroupKey };
});
assert.deepEqual(results.map(result => result.ok), [true, false]);
assert.equal(deliveryState(results), 'PARTIAL');
assert.deepEqual(rowsForFailedGroups(rows, results).map(row => row.rowId), ['R3'], 'only failed voucher rows must remain');
assert.equal(deliveryState(await executeVoucherGroups(groups, async group => ({ id: group.voucherGroupKey }))), 'SAVED');
assert.deepEqual(rowsForFailedGroups(rows, await executeVoucherGroups(groups, async () => { throw new Error('offline'); })).map(row => row.rowId), ['R1', 'R2', 'R3'],
  'all source rows and edits must survive a total external failure');

globalThis.__SMARTINPUT_INTEGRATION_BRIDGE__ = {
  loadCustomers: async () => [{ customerId: 'C1' }],
  loadProducts: async () => ({ products: [{ productId: 'P1' }] }),
  loadWarehouses: async () => ({ warehouses: [{ warehouseId: 'W1' }] }),
  createOrder: async payload => ({ order: { orderId: 'O1' }, payload }),
  syncOrder: async () => { throw Object.assign(new Error('offline'), { code: 'ORDER_SYNC_OFFLINE' }); },
  finalizePurchase: async group => ({ purchaseDocumentId: group.voucherGroupKey }),
  finalizeSale: async group => ({ saleDocumentId: group.voucherGroupKey })
};
const adapter = await import('../smartinput/integration-adapter.js');
assert.equal((await adapter.loadCustomerReferences()).length, 1);
assert.equal((await adapter.loadProductReferences()).products.length, 1);
assert.equal((await adapter.loadWarehouseReferences()).warehouses.length, 1);
assert.equal((await adapter.saveOrderLocal({ sourceMessageKey: 'IDEMPOTENT-1' })).order.orderId, 'O1');
await assert.rejects(adapter.syncOrderInBackground('O1'), error => error.code === 'ORDER_SYNC_OFFLINE');
assert.equal((await adapter.finalizePurchase(groups[0])).purchaseDocumentId, 'G1');
assert.equal((await adapter.finalizeSale(groups[1])).saleDocumentId, 'G2');
delete globalThis.__SMARTINPUT_INTEGRATION_BRIDGE__;

console.log('SmartInput independent recovery contracts PASS');
