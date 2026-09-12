#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  const stageSource = source(stageModule);
  assert.match(stageSource, /from ['"]\.\.\/orderq\/official-command-adapter\.js/,
    `${stageModule} must consume the ORDER Q command Adapter`);
  assert.doesNotMatch(stageSource, /official-voucher-repository\.js/);
  assert.match(stageSource, /createWriteResultTracker\(\)/,
    `${stageModule} must bound the public wait without changing the immutable command identity`);
  assert.match(stageSource, /load(?:Purchase|Sale)CommandAggregate\([\s\S]*known:\s*false,\s*safeToRetry:\s*true/,
    `${stageModule} must look up the original command receipt before a retry`);
  assert.match(stageSource, /resolveUnknown\([\s\S]*commandId:\s*envelope\.commandId/,
    `${stageModule} must resolve an unknown result under the original command ID`);
  assert.match(stageSource, /submit\([\s\S]*commandId:\s*envelope\.commandId[\s\S]*execute:\s*\(\)\s*=>\s*commit(?:Purchase|Sale)Command\(command\)/,
    `${stageModule} must retry only the byte-identical command envelope and command ID`);
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

const dataModuleUrl = body => `data:text/javascript;base64,${Buffer.from(body).toString('base64')}`;
const fakeOfficialCommandAdapterUrl = dataModuleUrl(`
const active = () => globalThis.__smartinputOfficialWriteBoundaryHarness;
export const freezePurchaseCommandIntent = source => active().freeze(source);
export const freezeSaleCommandIntent = source => active().freeze(source);
export const findPurchaseCommandContext = identity => active().find(identity);
export const findSaleCommandContext = identity => active().find(identity);
export const beginPurchaseCommand = (draft, actor) => active().begin(draft, actor);
export const beginSaleCommand = (draft, actor) => active().begin(draft, actor);
export const commitPurchaseCommand = command => active().commit(command);
export const commitSaleCommand = command => active().commit(command);
export const loadPurchaseCommandAggregate = documentId => active().load(documentId);
export const loadSaleCommandAggregate = documentId => active().load(documentId);
export const inspectOfficialStocktakeConflicts = async () => ({ conflicts: [] });
`);
const runtimeDependencyUrls = new Map([
  ['../orderq/official-command-adapter.js?v=0.6.0', fakeOfficialCommandAdapterUrl],
  ['../orderq/official-voucher-core.js?v=0.24.0', pathToFileURL(join(root, 'orderq', 'official-voucher-core.js')).href],
  ['../orderq/official-voucher-v2-contract.js?v=0.5.0', pathToFileURL(join(root, 'orderq', 'official-voucher-v2-contract.js')).href],
  ['./optional-operation-loader.js?v=0.1.0', pathToFileURL(join(root, 'smartinput', 'optional-operation-loader.js')).href]
]);
const runtimeStageUrl = relativePath => dataModuleUrl([...runtimeDependencyUrls].reduce(
  (body, [specifier, replacement]) => body.replace(specifier, replacement),
  source(relativePath)
));

function createManualTimerHarness() {
  let sequence = 0;
  const callbacks = new Map();
  return {
    schedule(callback) {
      const id = ++sequence;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) { callbacks.delete(id); },
    fireNext() {
      const entry = callbacks.entries().next().value;
      assert.ok(entry, 'an official write must register its public timeout');
      callbacks.delete(entry[0]);
      entry[1]();
    }
  };
}

const writeTimers = createManualTimerHarness();
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
let purchaseStageRuntime;
let saleStageRuntime;
try {
  globalThis.setTimeout = writeTimers.schedule;
  globalThis.clearTimeout = writeTimers.cancel;
  [purchaseStageRuntime, saleStageRuntime] = await Promise.all([
    import(runtimeStageUrl('smartinput/purchase-official-stage3.js')),
    import(runtimeStageUrl('smartinput/sale-official-stage4.js'))
  ]);
} finally {
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
}

const deferred = () => {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};
const clone = input => structuredClone(input);

function createOfficialWriteHarness(kind) {
  let aggregate = null;
  let lookup = { status: 'ABSENT' };
  const commits = [];
  const pendingCommits = [];
  return {
    commits,
    pendingCommits,
    freeze(command) {
      const commandEnvelope = clone(command);
      return {
        commandEnvelope,
        draftIntentDigest: `${kind}:${commandEnvelope.commandId}`
      };
    },
    async find() {
      return { document: aggregate?.document || null, aggregate };
    },
    async begin(draft) {
      aggregate = {
        document: clone(draft),
        lines: clone(draft.lines || []),
        commands: []
      };
      return aggregate;
    },
    commit(command) {
      commits.push(clone(command));
      const pending = deferred();
      pendingCommits.push(pending);
      return pending.promise;
    },
    async load() {
      if (lookup.status === 'ERROR') throw lookup.error;
      const commands = lookup.status === 'KNOWN'
        ? [{ commandId: commits[0].commandId, status: 'COMMITTED', result: clone(lookup.result) }]
        : [];
      return { ...aggregate, commands };
    },
    setLookup(next) { lookup = next; }
  };
}

const purchaseGroup = suffix => ({
  sourceType: 'DIRECT',
  originSystem: 'SMARTINPUT_MANUAL',
  originTransactionId: `BOUNDARY-P-${suffix}`,
  sourceVoucherIndex: 1,
  supplierCustomerId: 'SUPPLIER-A',
  supplierCustomerName: '구매처 A',
  voucherDate: '2026-09-12',
  warehouseId: 'WAREHOUSE-A',
  warehouseCode: 'WH-A',
  rows: [{
    rowId: `PURCHASE-ROW-${suffix}`,
    productId: 'PRODUCT-A',
    itemCode: 'ITEM-A',
    itemName: '상품 A',
    quantity: 2,
    unit: 'EA',
    unitPrice: 1000,
    warehouseId: 'WAREHOUSE-A',
    warehouseCode: 'WH-A',
    sourceRowNo: 1
  }]
});
const saleGroup = suffix => ({
  sourceType: 'DIRECT',
  originSystem: 'SMARTINPUT_FILE',
  originTransactionId: `BOUNDARY-S-${suffix}`,
  sourceVoucherIndex: 1,
  salesCustomerId: 'CUSTOMER-A',
  deliveryCustomerId: 'CUSTOMER-A',
  billingCustomerId: 'CUSTOMER-A',
  salesCustomerRevision: 1,
  deliveryCustomerRevision: 1,
  billingCustomerRevision: 1,
  voucherDate: '2026-09-12',
  warehouseId: 'WAREHOUSE-A',
  warehouseCode: 'WH-A',
  rows: [{
    rowId: `SALE-ROW-${suffix}`,
    productId: 'PRODUCT-A',
    itemCode: 'ITEM-A',
    itemName: '상품 A',
    quantity: 2,
    unit: 'EA',
    unitPrice: 1000,
    warehouseId: 'WAREHOUSE-A',
    warehouseCode: 'WH-A',
    sourceRowNo: 1,
    orderLinkMode: 'DIRECT',
    actualToBaseFactor: 1,
    conversionSource: 'DIRECT_SAME_UNIT',
    conversionRuleVersion: 'DIRECT_1_TO_1_V1'
  }]
});

async function waitForCommitCount(harness, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (harness.commits.length >= expected) return;
    await Promise.resolve();
  }
  assert.fail(`expected ${expected} official commit attempt(s), received ${harness.commits.length}`);
}

async function forceUnknownResult({ post, group, context, harness }) {
  globalThis.__smartinputOfficialWriteBoundaryHarness = harness;
  const submitted = post(group, context);
  await waitForCommitCount(harness, 1);
  const commandId = harness.commits[0].commandId;
  const rejected = assert.rejects(
    submitted,
    error => error.code === 'RESULT_UNKNOWN' && error.commandId === commandId,
    'the production stage must preserve RESULT_UNKNOWN with the original command ID'
  );
  writeTimers.fireNext();
  await rejected;
  return commandId;
}

async function verifyOfficialStageWriteBoundary({ kind, stage, groupFor }) {
  const post = kind === 'PURCHASE' ? stage.postPurchaseGroup : stage.postSaleGroup;
  const contextFor = suffix => ({
    companyId: 'COMPANY-A',
    manualSessionId: `BOUNDARY-${kind}-${suffix}`,
    originSystem: kind === 'PURCHASE' ? 'SMARTINPUT_MANUAL' : 'SMARTINPUT_FILE',
    occurredAt: '2026-09-12T12:00:00+09:00'
  });

  const knownHarness = createOfficialWriteHarness(`${kind}:KNOWN`);
  const knownGroup = groupFor('KNOWN');
  const knownContext = contextFor('KNOWN');
  const knownCommandId = await forceUnknownResult({ post, group: knownGroup, context: knownContext, harness: knownHarness });
  const receiptResult = { receipt: `${kind}-KNOWN` };
  knownHarness.setLookup({ status: 'KNOWN', result: receiptResult });
  globalThis.__smartinputOfficialWriteBoundaryHarness = knownHarness;
  const knownRetry = await post(knownGroup, knownContext);
  assert.equal(knownRetry.receipt, receiptResult.receipt, `${kind} must return the committed receipt found after timeout`);
  assert.equal(knownRetry.commandId, knownCommandId);
  assert.equal(knownHarness.commits.length, 1, `${kind} must not resubmit a command whose receipt is committed`);
  knownHarness.pendingCommits[0].resolve(receiptResult);
  await Promise.resolve();

  const absentHarness = createOfficialWriteHarness(`${kind}:ABSENT`);
  const absentGroup = groupFor('ABSENT');
  const absentContext = contextFor('ABSENT');
  const absentCommandId = await forceUnknownResult({ post, group: absentGroup, context: absentContext, harness: absentHarness });
  absentHarness.setLookup({ status: 'ABSENT' });
  globalThis.__smartinputOfficialWriteBoundaryHarness = absentHarness;
  const absentRetry = post(absentGroup, absentContext);
  await waitForCommitCount(absentHarness, 2);
  assert.equal(absentHarness.commits[1].commandId, absentCommandId, `${kind} retry must reuse the original command ID`);
  assert.deepEqual(absentHarness.commits[1], absentHarness.commits[0], `${kind} retry must reuse the immutable command envelope`);
  absentHarness.pendingCommits[1].resolve({ committed: `${kind}-RETRIED` });
  assert.equal((await absentRetry).committed, `${kind}-RETRIED`);
  absentHarness.pendingCommits[0].resolve({ committed: `${kind}-LATE` });
  await Promise.resolve();

  const lookupFailureHarness = createOfficialWriteHarness(`${kind}:LOOKUP-FAILURE`);
  const lookupFailureGroup = groupFor('LOOKUP-FAILURE');
  const lookupFailureContext = contextFor('LOOKUP-FAILURE');
  const lookupFailureCommandId = await forceUnknownResult({
    post,
    group: lookupFailureGroup,
    context: lookupFailureContext,
    harness: lookupFailureHarness
  });
  lookupFailureHarness.setLookup({ status: 'ERROR', error: new Error(`${kind} receipt lookup failed`) });
  globalThis.__smartinputOfficialWriteBoundaryHarness = lookupFailureHarness;
  await assert.rejects(
    post(lookupFailureGroup, lookupFailureContext),
    error => error.code === 'RESULT_LOOKUP_FAILED' && error.commandId === lookupFailureCommandId,
    `${kind} must preserve RESULT_LOOKUP_FAILED instead of submitting a new command`
  );
  assert.equal(lookupFailureHarness.commits.length, 1, `${kind} lookup failure must not submit another command`);
  lookupFailureHarness.pendingCommits[0].resolve({ committed: `${kind}-LATE-AFTER-LOOKUP-FAILURE` });
  await Promise.resolve();
}

try {
  await verifyOfficialStageWriteBoundary({ kind: 'PURCHASE', stage: purchaseStageRuntime, groupFor: purchaseGroup });
  await verifyOfficialStageWriteBoundary({ kind: 'SALE', stage: saleStageRuntime, groupFor: saleGroup });
} finally {
  delete globalThis.__smartinputOfficialWriteBoundaryHarness;
}

console.log(JSON.stringify({
  boundary: 'NEXUS-SI-V2-02',
  smartInputRepositoryDirectImports: 0,
  uiHandlers: ['PurchaseFinalizeService', 'SaleFinalizeService'],
  ownerFlow: ['OfficialCommandAdapter', 'OfficialCommandGateway', 'OfficialVoucherRepository'],
  preservedFollowUp: ['Cloud replay', 'unmatched-product rematch', 'correction', 'cancellation']
}, null, 2));
console.log('SmartInput official write boundary contract PASS');
