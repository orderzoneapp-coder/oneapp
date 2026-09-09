#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { coreFieldByProjection } from '../smartinput/field-definition-contract.js';
import { stage1RowFieldDefinitions, structuredFieldsForMode } from '../smartinput/multivoucher-stage1.js';
import {
  DECISION,
  SESSION_STATUS,
  createMappingSession,
  createTemplateRecord,
  projectMappedRows,
  recommendMappings,
  setColumnDecision,
  validateTemplateDraft
} from '../smartinput/input-template-mapper.js';

const plain = value => JSON.parse(JSON.stringify(value));
const source = readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8');
const context = { window: {}, coreFieldByProjection, stage1RowFieldDefinitions, structuredFieldsForMode };
vm.createContext(context);
vm.runInContext(readFileSync(new URL('../smartinput/smartinput-contract.js', import.meta.url), 'utf8'), context);
const contract = context.window.SMART_INPUT_CONTRACT;
const seed = JSON.parse(readFileSync(new URL('../smartinput/field-catalog-seed.v2.json', import.meta.url), 'utf8'));
context.contract = contract;
context.state = {
  draft: { activeMode: 'estimate' },
  settings: contract.normalizeSettings(),
  fieldRegistries: Object.fromEntries(Object.keys(contract.MODES).map(mode => [mode, {
    catalog: seed.definitions.filter(field => field.voucherModes.includes(mode))
  }]))
};

// Execute the actual UI target builder without the application's DOM/bootstrap.
for (const name of [
  'headerFieldsForMode', 'voucherColumnsForMode', 'layoutDefinitions',
  'availableRegistryFields', 'normalizedMappingSearch', 'inputMappingTargets'
]) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'));
  assert.ok(match, `actual application function ${name} must be extractable`);
  vm.runInContext(match[0], context, { filename: `smartinput.js:${name}` });
}

const expected = {
  estimate: [
    ['품목코드', 'itemCode', '001'], ['품목명', 'itemName', '사과'],
    ['규격', 'specification', '10kg'], ['수량', 'quantity', 2],
    ['단가', 'unitPrice', 10000], ['B단가', 'purchasePriceB', 9000],
    ['A판매', 'wholesaleA', 12000], ['B판매', 'wholesaleB', 11000],
    ['적요', 'memo', '납품할 상품'], ['행사가', 'promoPrice', 8000],
    ['적요2', 'memo2', '두 번째 적요']
  ],
  order: [
    ['품목코드', 'itemCode', '002'], ['품목명', 'itemName', '배'],
    ['규격', 'specification', '5kg'], ['수량', 'quantity', 0],
    ['단가', 'unitPrice', 12000], ['공급가액', 'supplyAmount', 0],
    ['메모', 'memo', '고객 요청'], ['적요(직원)', 'description', '직원 확인'],
    ['공지단가', 'noticePrice', 13500]
  ],
  purchase: [
    ['코드', 'itemCode', '003'], ['품명', 'itemName', '감자'],
    ['규격(기본)', 'specification', '20kg'], ['수량', 'quantity', -1.5],
    ['단가', 'unitPrice', 10000], ['공급가', 'supplyAmount', -15000],
    ['간단설명(품위)', 'productDescription', '특품'], ['지시사항', 'memo', '분리 보관'],
    ['출고가 (공지)', 'noticePrice', 12500], ['판매no.', 'rowVoucherNo', 'S-0003']
  ]
};

function approvedSession(mode, fields, targets, templates = []) {
  const matrix = [
    fields.map(([label]) => label),
    fields.map(([, , value]) => typeof value === 'number' ? value.toLocaleString('en-US') : value)
  ];
  const session = createMappingSession({
    matrix, headerRowIndex: 0, companyId: 'ONEAPP', voucherMode: mode,
    targetDefinitions: targets, templates
  });
  if (!templates.length) {
    assert.equal(session.mappings.every(mapping => mapping.state === DECISION.RECOMMENDED), true,
      `${mode}: every exact approved label must have one recommendation: ${JSON.stringify(session.mappings)}`);
  }
  const approved = session.mappings.reduce((current, mapping) => mapping.state === DECISION.RECOMMENDED
    ? setColumnDecision(current, mapping.columnIndex, DECISION.MAPPED, mapping.targetFieldId, targets)
    : current, session);
  assert.equal(validateTemplateDraft(approved, targets).valid, true,
    `${mode}: distinct approved fields must not collide on one projection`);
  assert.deepEqual(approved.sourceMatrix, matrix, 'mapping must preserve the source data');
  return approved;
}

for (const [mode, fields] of Object.entries(expected)) {
  const targets = plain(context.inputMappingTargets(mode, { includeRegistry: true }));
  const byId = new Map(targets.map(target => [target.id, target]));
  const session = approvedSession(mode, fields, targets);
  assert.deepEqual(session.mappings.map(mapping => byId.get(mapping.targetFieldId).projectionFieldId),
    fields.map(([, projection]) => projection), `${mode}: field labels must select the intended data properties`);
  const rows = projectMappedRows(session, targets);
  assert.equal(rows.length, 1);
  for (const [label, projection, value] of fields) {
    assert.equal(rows[0][projection], value, `${mode} ${label}: numeric/text values must reach the correct field`);
    const expectedTargetId = coreFieldByProjection(mode, projection)?.fieldId
      || (mode === 'estimate' && projection === 'memo2' ? 'erp.estimate.current_line.line.memo_2' : projection);
    assert.equal(targets.find(target => target.projectionFieldId === projection && !target.registryField).id,
      expectedTargetId, `${mode} ${label}: display labels must not replace persistent mapping target IDs`);
  }
  const saved = createTemplateRecord(session, `${mode} 초기 항목 검증`, targets);
  const savedIds = saved.mappings.map(mapping => mapping.targetFieldId);
  const previousSettings = context.state.settings;
  context.state.settings = contract.normalizeSettings({
    ...plain(previousSettings),
    voucherColumnsByMode: { ...plain(previousSettings.voucherColumnsByMode), [mode]: fields.map(([, id]) => id).reverse() }
  });
  const reorderedTargets = plain(context.inputMappingTargets(mode, { enabledOnly: false, includeRegistry: true }));
  const reapplied = approvedSession(mode, fields, reorderedTargets, [saved]);
  assert.equal(reapplied.status, SESSION_STATUS.TEMPLATE_APPLIED,
    `${mode}: changing display order must not invalidate a saved mapping template`);
  assert.deepEqual(reapplied.mappings.map(mapping => mapping.targetFieldId), savedIds);
  const reloaded = projectMappedRows(reapplied, reorderedTargets)[0];
  for (const [label, projection, value] of fields) assert.equal(reloaded[projection], value, `${mode} ${label}: saved mapping roundtrip`);
  context.state.settings = previousSettings;
}

// Both fields can be enabled by a user; inherited global aliases must not cross-wire them.
for (const [mode, labels] of Object.entries({
  estimate: ['적요', '지시사항'], order: ['메모', '적요(직원)'], purchase: ['지시사항', '적요(직원)']
})) {
  context.state.settings = contract.normalizeSettings({
    voucherColumnsByMode: { [mode]: [...expected[mode].map(([, id]) => id), 'description'] }
  });
  const targets = plain(context.inputMappingTargets(mode, { includeRegistry: true }));
  const byId = new Map(targets.map(target => [target.id, target]));
  const mappings = recommendMappings(labels, targets);
  assert.deepEqual(mappings.map(mapping => mapping.state), [DECISION.RECOMMENDED, DECISION.RECOMMENDED],
    `${mode}: memo and description must remain individually selectable with both enabled`);
  assert.deepEqual(mappings.map(mapping => byId.get(mapping.targetFieldId).projectionFieldId), ['memo', 'description']);
}

context.state.settings = contract.normalizeSettings();
const estimateTargets = plain(context.inputMappingTargets('estimate', { enabledOnly: false, includeRegistry: true }));
const memo2Targets = estimateTargets.filter(target => target.id === 'erp.estimate.current_line.line.memo_2');
assert.equal(memo2Targets.length, 1, 'the existing ERP memo2 ID must not appear twice as separate registry/core fields');
assert.equal(memo2Targets[0].projectionFieldId, 'memo2');
assert.equal(memo2Targets[0].custom, false,
  'newly entered memo2 values must use the row property read by the existing estimate exporter');

console.log('SmartInput actual mapping targets: approved labels, distinct price/note projections, source preservation, registry deduplication and saved template identities PASS');
