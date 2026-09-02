#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const before = JSON.parse(readFileSync(new URL('../evidence/smartinput-v2-phase5/browser-after.json', import.meta.url)));
const after = JSON.parse(readFileSync(new URL('../evidence/smartinput-v2-phase6a/browser-after.json', import.meta.url)));

assert.deepEqual(after.dom, before.dom, 'DOM tabs, buttons, columns, footer order, and measured regions must stay identical');
assert.deepEqual(after.keyboardContractsExercised, before.keyboardContractsExercised,
  'keyboard and shortcut contracts must stay identical');

for (const flow of ['directInput', 'excelTablePaste', 'autosave', 'autosaveRestore']) {
  assert.equal(after.flows[flow].clicks, before.flows[flow].clicks, `${flow} click count must stay identical`);
  assert.equal(after.flows[flow].clickDefinition, before.flows[flow].clickDefinition,
    `${flow} click definition must stay identical`);
}

const stableOfficialEntry = entry => ({
  mode: entry.mode,
  clickCount: entry.clickCount,
  clickDefinition: entry.clickDefinition,
  currentResult: entry.currentResult,
  feedback: entry.feedback,
  dateDeleteEvidence: entry.dateDeleteEvidence || null,
  dom: entry.dom
});
assert.deepEqual(after.flows.currentOfficialSaveEntry.map(stableOfficialEntry),
  before.flows.currentOfficialSaveEntry.map(stableOfficialEntry),
  'purchase/sale save click counts, fields, result, and layout must stay identical');

for (const contract of ['successBaseline', 'injectedFailure', 'gatewayInjectedFailure', 'stage3V2', 'stage4V2', 'stage5V2']) {
  assert.deepEqual(after.officialTransaction[contract], before.officialTransaction[contract],
    `official ${contract} regression evidence must stay identical`);
}
assert.equal(after.officialTransaction.expectedFinalizeTransactionCount,
  before.officialTransaction.expectedFinalizeTransactionCount);
assert.equal(after.officialTransaction.partialFinalizeWritesAfterFailure,
  before.officialTransaction.partialFinalizeWritesAfterFailure);

const stableStocktakeUi = evidence => ({
  contract: evidence.contract,
  cancelStateBefore: evidence.cancelStateBefore,
  cancelStateAfter: evidence.cancelStateAfter,
  sequentialMixed: evidence.sequentialMixed.map(row => ({
    conflictKey: row.conflictKey,
    decisionType: row.decisionType
  })),
  themes: evidence.themes,
  mobileViewport: evidence.mobileViewport,
  normalFlowPopupCount: evidence.normalFlowPopupCount
});
assert.deepEqual(stableStocktakeUi(after.stocktakeConflictUi), stableStocktakeUi(before.stocktakeConflictUi),
  'existing stocktake popup contract and UI state must stay identical');

assert.deepEqual({
  productionIndexedDbWrites: after.isolation.productionIndexedDbWrites,
  actualExternalMutatingRequests: after.isolation.actualExternalMutatingRequests,
  localFixtureServerWrites: after.isolation.localFixtureServerWrites
}, {
  productionIndexedDbWrites: 0,
  actualExternalMutatingRequests: 0,
  localFixtureServerWrites: 0
});

const phase6A = after.officialTransaction.phase6AReadModel;
assert.ok(phase6A, 'browser evidence must include the Phase 6A owner read operation');
assert.deepEqual(phase6A.observed.writes, []);
assert.equal(phase6A.observed.transactionModes.every(mode => mode === 'readonly'), true);
assert.equal(phase6A.countsUnchanged, true);

console.log(JSON.stringify({
  taskId: 'NEXUS-SI-V2-06A',
  status: 'PASS',
  unchanged: {
    modeTabs: after.dom.modeTabs.length,
    actionButtons: after.dom.actionButtons.length,
    tableColumns: after.dom.tableColumns.length,
    footerActions: after.dom.footerOrder.length,
    keyboardContracts: after.keyboardContractsExercised.length,
    purchaseSaveClicks: after.flows.currentOfficialSaveEntry.find(row => row.mode === 'purchase').clickCount,
    saleSaveClicks: after.flows.currentOfficialSaveEntry.find(row => row.mode === 'sale').clickCount
  },
  phase6AOwnerRead: {
    reviewCount: phase6A.reviewCount,
    linkCounts: phase6A.linkCounts,
    indexedDbWrites: phase6A.observed.writes.length,
    countsUnchanged: phase6A.countsUnchanged
  }
}, null, 2));
