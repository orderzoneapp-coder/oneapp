#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOfficialCommandAdapter } from '../orderq/official-command-adapter.js';
import { createOfficialCommandGateway } from '../orderq/official-command-gateway.js';
import { createPurchaseFinalizeService } from '../smartinput/purchase-finalize-service.js';
import { createSaleFinalizeService } from '../smartinput/sale-finalize-service.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = relative => readFileSync(join(root, relative), 'utf8');
const productionSmartInputModules = readdirSync(join(root, 'smartinput'))
  .filter(name => name.endsWith('.js'))
  .map(name => ({ name, body: source(`smartinput/${name}`) }));

const repositoryImports = productionSmartInputModules.filter(({ body }) =>
  /(?:from\s*|import\s*\()['"][^'"]*official-voucher-repository\.js/.test(body));
assert.deepEqual(repositoryImports.map(({ name }) => name), [],
  'SmartInput production modules must have zero direct OfficialVoucherRepository imports');

const smartInputUi = source('smartinput/smartinput.js');
const saleHandler = smartInputUi.slice(
  smartInputUi.indexOf('async function completeSaleOfficial()'),
  smartInputUi.indexOf('async function completePurchaseOfficial()')
);
const purchaseHandler = smartInputUi.slice(
  smartInputUi.indexOf('async function completePurchaseOfficial()'),
  smartInputUi.indexOf('function orderGroupErrors(')
);
assert.match(saleHandler, /SaleFinalizeService\.finalize\s*\(/);
assert.match(purchaseHandler, /PurchaseFinalizeService\.finalize\s*\(/);
assert.doesNotMatch(saleHandler, /postSaleGroup|commitSaleCommand|beginSaleCommand|official-voucher-repository/);
assert.doesNotMatch(purchaseHandler, /postPurchaseGroup|commitPurchaseCommand|beginPurchaseCommand|official-voucher-repository/);

for (const stageModule of ['smartinput/purchase-official-stage3.js', 'smartinput/sale-official-stage4.js']) {
  assert.match(source(stageModule), /from ['"]\.\.\/orderq\/official-command-adapter\.js/,
    `${stageModule} must consume the ORDER Q command Adapter`);
  assert.doesNotMatch(source(stageModule), /official-voucher-repository\.js/);
}
assert.match(source('orderq/official-command-adapter.js'), /from ['"]\.\/official-command-gateway\.js/);
assert.match(source('orderq/official-command-gateway.js'), /from ['"]\.\/official-voucher-repository\.js/);
assert.match(source('orderq/official-voucher-sync.js'), /from ['"]\.\/official-voucher-repository\.js/,
  'Cloud replay remains an explicitly recorded follow-up owner path in phase 2');

const repositoryCalls = [];
const gateway = createOfficialCommandGateway({
  buildFrozenPurchaseIntent(input) { repositoryCalls.push('freezePurchase'); return { commandEnvelope: input }; },
  buildFrozenSaleIntent(input) { repositoryCalls.push('freezeSale'); return { commandEnvelope: input }; },
  async findOfficialPurchaseBySource() { repositoryCalls.push('findPurchase'); return { purchaseDocumentId: 'PD-1' }; },
  async findOfficialSaleBySource() { repositoryCalls.push('findSale'); return { salesDocumentId: 'SD-1' }; },
  async loadOfficialPurchaseAggregate() { repositoryCalls.push('loadPurchase'); return { document: { purchaseDocumentId: 'PD-1' } }; },
  async loadOfficialSaleAggregate() { repositoryCalls.push('loadSale'); return { document: { salesDocumentId: 'SD-1' } }; },
  async saveOfficialVoucherDraft(input) { repositoryCalls.push(`save:${input.kind}`); return input; },
  async runCentralOfficialVoucherCommand(input) { repositoryCalls.push('execute'); return input; }
});
const adapter = createOfficialCommandAdapter(gateway);
assert.equal(adapter.freezePurchaseIntent({ commandId: 'P' }).commandEnvelope.commandId, 'P');
assert.equal(adapter.freezeSaleIntent({ commandId: 'S' }).commandEnvelope.commandId, 'S');
assert.equal((await adapter.findPurchaseCommandContext({ companyId: 'A' })).aggregate.document.purchaseDocumentId, 'PD-1');
assert.equal((await adapter.findSaleCommandContext({ companyId: 'A' })).aggregate.document.salesDocumentId, 'SD-1');
await adapter.beginPurchaseCommand({ purchaseDocumentId: 'PD-2' }, 'ACTOR');
await adapter.beginSaleCommand({ salesDocumentId: 'SD-2' }, 'ACTOR');
await adapter.commitPurchaseCommand({ commandId: 'PC' });
await adapter.commitSaleCommand({ commandId: 'SC' });
assert.deepEqual(repositoryCalls, [
  'freezePurchase', 'freezeSale', 'findPurchase', 'loadPurchase', 'findSale', 'loadSale',
  'save:PURCHASE', 'save:SALE', 'execute', 'execute'
], 'Adapter calls must pass through the Gateway repository port');

const purchaseSubmissions = [];
const purchaseService = createPurchaseFinalizeService({
  validateGroup(group) {
    if (group.fail) throw new Error('CURRENT_PURCHASE_VALIDATION');
  },
  async submitGroup(group, context) {
    purchaseSubmissions.push({ group, context });
    return { purchaseDocumentId: `PD-${group.key}`, commandId: `PC-${group.key}` };
  },
  now: () => '2026-09-02T09:00:00.000Z'
});
const purchaseResults = await purchaseService.finalize({
  groups: [{ key: 'OK' }, { key: 'FAIL', fail: true }],
  masters: { customers: [] }, companyId: 'COMPANY-A', activeMethod: 'excel', manualSessionId: 'DOC-A'
});
assert.deepEqual(purchaseResults.map(row => row.ok), [true, false]);
assert.equal(purchaseSubmissions[0].context.originSystem, 'SMARTINPUT_MANUAL',
  'current purchase Excel producer behavior must remain unchanged');
assert.equal(purchaseSubmissions[0].context.occurredAt, '2026-09-02T09:00:00.000Z');

let submittedSale;
const saleService = createSaleFinalizeService({
  async submitGroup(group, context) {
    submittedSale = { group, context };
    return { salesDocumentId: 'SD-OK', commandId: 'SC-OK' };
  },
  now: () => '2026-09-02T09:00:00.000Z'
});
const saleResults = await saleService.finalize({
  groups: [{
    salesCustomerId: 'CUSTOMER-A', deliveryCustomerId: 'CUSTOMER-A', billingCustomerId: 'CUSTOMER-A',
    warehouseId: 'WAREHOUSE-A', rows: [{ productId: 'PRODUCT-A', itemCode: 'ITEM-A', unit: 'EA', quantity: 2, unitPrice: 1000 }]
  }],
  companyId: 'COMPANY-A', activeMethod: 'excel', manualSessionId: 'DOC-A', lastBatchContentHash: 'BATCH-A',
  customers: [{ customerId: 'CUSTOMER-A', revision: 3 }],
  products: [{ productId: 'PRODUCT-A', itemCode: 'ITEM-A', revision: 4 }],
  warehouses: [{ warehouseId: 'WAREHOUSE-A', revision: 5 }]
});
assert.deepEqual(saleResults.map(row => row.ok), [true]);
assert.equal(submittedSale.context.originSystem, 'SMARTINPUT_FILE');
assert.equal(submittedSale.context.manualSessionId, 'BATCH-A');
assert.equal(submittedSale.group.salesCustomerRevision, 3);
assert.equal(submittedSale.group.rows[0].productId, 'PRODUCT-A');
assert.equal(submittedSale.group.rows[0].productMasterRevision, 4);
assert.equal(submittedSale.group.rows[0].warehouseMasterRevision, 5);
assert.equal(submittedSale.group.rows[0].actualToBaseFactor, 1);
assert.equal(submittedSale.group.rows[0].conversionSource, 'DIRECT_SAME_UNIT');

console.log(JSON.stringify({
  boundary: 'NEXUS-SI-V2-02',
  smartInputRepositoryDirectImports: 0,
  uiHandlers: ['PurchaseFinalizeService', 'SaleFinalizeService'],
  ownerFlow: ['OfficialCommandAdapter', 'OfficialCommandGateway', 'OfficialVoucherRepository'],
  preservedFollowUp: ['Cloud replay', 'unmatched-product rematch', 'correction', 'cancellation']
}, null, 2));
console.log('SmartInput official write boundary contract PASS');
