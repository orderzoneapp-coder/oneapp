#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DECISION,
  SESSION_STATUS,
  addManualRow,
  createMappingSession,
  createTemplateRecord,
  deleteWorkingRows,
  detectHeaderRow,
  projectMappedRows,
  recommendMappings,
  reassignHeaderRow,
  setColumnDecision,
  templateSignature,
  templateSignatureV2,
  updateWorkingCell,
  validateTemplateDraft
} from '../smartinput/input-template-mapper.js';

const targets = [
  { id: 'customer', label: '거래처명', scope: 'header', projectionFieldId: 'rowCustomerName', valueType: 'TEXT' },
  { id: 'itemCode', label: '품목코드', scope: 'voucher', valueType: 'TEXT' },
  { id: 'itemName', label: '품목명', scope: 'voucher', valueType: 'TEXT' },
  { id: 'quantity', label: '수량', scope: 'voucher', valueType: 'NUMBER' },
  { id: 'boxQuantity', label: '박스수량', scope: 'voucher', valueType: 'NUMBER' },
  { id: 'memo', label: '메모', scope: 'voucher', valueType: 'TEXT' }
];

function confirmRecommendations(session, definitions = targets) {
  return session.mappings.reduce((current, mapping) => mapping.state === DECISION.RECOMMENDED
    ? setColumnDecision(current, mapping.columnIndex, DECISION.MAPPED, mapping.targetFieldId, definitions)
    : current, session);
}

const raw = [
  ['행사 견적 자료', '', '', ''],
  ['품목코드', '품목명', '수량', '메모'],
  ['001', '취나물', '0', ''],
  ['002', '시금치', '-1.5', '확인']
];
assert.equal(detectHeaderRow(raw, targets).rowIndex, 1, 'the exact field-name row must be detected without changing source rows');

let fresh = createMappingSession({ matrix: raw, headerRowIndex: 1, targetDefinitions: targets });
assert.equal(fresh.status, SESSION_STATUS.NEW_TEMPLATE);
assert.deepEqual(fresh.sourceMatrix, raw, 'the immutable source matrix must preserve blank cells, values, rows and order');
assert.deepEqual(fresh.headers, raw[1]);
assert.equal(fresh.mappings.every(mapping => mapping.state === DECISION.RECOMMENDED), true,
  'unique exact source/setting labels may be recommendations before explicit template save');
assert.equal(validateTemplateDraft(fresh, targets).valid, false,
  'a changed or new workbook must require explicit review of every recommended column');
fresh = confirmRecommendations(fresh);
assert.equal(validateTemplateDraft(fresh, targets).valid, true);

const official = createTemplateRecord(fresh, '거래명세 기본', targets);
assert.equal(official.headerSignature, templateSignature(raw[1]));
assert.equal(official.signature, templateSignatureV2('', '', raw[1]));
assert.equal(official.mappings.every(mapping => [DECISION.MAPPED, DECISION.UNMAPPED].includes(mapping.state)), true);
const applied = createMappingSession({ matrix: raw, headerRowIndex: 1, templates: [official], targetDefinitions: targets });
assert.equal(applied.status, SESSION_STATUS.TEMPLATE_APPLIED);
assert.equal(applied.templateId, official.templateId);

let companyOrder = createMappingSession({ matrix: raw, headerRowIndex: 1, companyId: 'C1', voucherMode: 'order', targetDefinitions: targets });
companyOrder = confirmRecommendations(companyOrder);
const companyOrderTemplate = createTemplateRecord(companyOrder, 'C1 주문 양식', targets);
assert.equal(createMappingSession({ matrix: raw, headerRowIndex: 1, companyId: 'C1', voucherMode: 'order', templates: [companyOrderTemplate], targetDefinitions: targets }).status, SESSION_STATUS.TEMPLATE_APPLIED);
assert.equal(createMappingSession({ matrix: raw, headerRowIndex: 1, companyId: 'C1', voucherMode: 'sale', templates: [companyOrderTemplate], targetDefinitions: targets }).status, SESSION_STATUS.NEW_TEMPLATE,
  'the same headers in another voucher type must not reuse a template');
assert.equal(createMappingSession({ matrix: raw, headerRowIndex: 1, companyId: 'C2', voucherMode: 'order', templates: [companyOrderTemplate], targetDefinitions: targets }).status, SESSION_STATUS.NEW_TEMPLATE,
  'templates must be isolated by company');

for (const changed of [
  ['품목코드 ', '품목명', '수량', '메모'],
  ['품목명', '품목코드', '수량', '메모'],
  ['품목코드', '품목명', '수량'],
  ['품목코드', '품목명', '수량', '메모', '추가']
]) {
  const matrix = [changed, ['001', '취나물', '1', '']];
  assert.equal(createMappingSession({ matrix, templates: [official], targetDefinitions: targets }).status, SESSION_STATUS.NEW_TEMPLATE,
    'spacing, spelling, field count and order changes must never reuse an existing template');
}

const duplicateHeaders = ['품목명', '수량', '수량'];
const duplicateTemplate = {
  schemaVersion: 'ONEAPP_SMARTINPUT_INPUT_TEMPLATE_V2',
  templateId: 'SITPL-DUPLICATE',
  companyId: '',
  voucherMode: '',
  templateName: '수량 2열 공식 양식',
  revision: 3,
  signature: templateSignatureV2('', '', duplicateHeaders),
  headerSignature: templateSignature(duplicateHeaders),
  headers: duplicateHeaders,
  mappings: [
    { columnIndex: 0, sourceHeader: '품목명', state: DECISION.MAPPED, targetFieldId: 'itemName' },
    { columnIndex: 1, sourceHeader: '수량', state: DECISION.MAPPED, targetFieldId: 'quantity' },
    { columnIndex: 2, sourceHeader: '수량', state: DECISION.MAPPED, targetFieldId: 'boxQuantity' }
  ]
};
const duplicateApplied = createMappingSession({
  matrix: [duplicateHeaders, ['사과', '2', '5']],
  templates: [duplicateTemplate],
  targetDefinitions: targets
});
assert.equal(duplicateApplied.status, SESSION_STATUS.TEMPLATE_APPLIED);
assert.deepEqual(duplicateApplied.mappings.map(mapping => mapping.targetFieldId), ['itemName', 'quantity', 'boxQuantity'],
  'duplicate raw labels must use the saved positional mapping');
const duplicateNew = createMappingSession({ matrix: [duplicateHeaders, ['사과', '2', '5']], targetDefinitions: targets });
assert.equal(duplicateNew.mappings[1].state, DECISION.UNDECIDED);
assert.equal(duplicateNew.mappings[2].state, DECISION.UNDECIDED, 'duplicate source labels must not be recommended');

const duplicatedTargetLabels = [...targets, { id: 'quantity-alt', label: '수량', scope: 'voucher', valueType: 'NUMBER' }];
const ambiguousTarget = createMappingSession({ matrix: [['수량'], ['1']], targetDefinitions: duplicatedTargetLabels });
assert.equal(ambiguousTarget.mappings[0].state, DECISION.UNDECIDED, 'duplicate setting labels must not be recommended');

const manualOnlyCustomerTarget = {
  id: 'rowCustomerName',
  label: '거래처명',
  scope: 'voucher',
  projectionFieldId: 'rowCustomerName',
  valueType: 'TEXT',
  recommendable: false
};
assert.equal(
  recommendMappings(['거래처명'], [manualOnlyCustomerTarget])[0].state,
  DECISION.UNDECIDED,
  'manual-search registry and hidden fields must not widen the automatic recommendation contract'
);

let decisions = createMappingSession({ matrix: [['품목코드', '알 수 없는 열'], ['001', '보존']], targetDefinitions: targets });
decisions = setColumnDecision(decisions, 0, DECISION.MAPPED, 'itemCode', targets);
assert.throws(() => setColumnDecision(decisions, 1, DECISION.MAPPED, 'itemCode', targets), /MAPPING_TARGET_DUPLICATED/);
assert.equal(validateTemplateDraft(decisions, targets).valid, false);
decisions = setColumnDecision(decisions, 1, DECISION.UNMAPPED, '', targets);
assert.equal(validateTemplateDraft(decisions, targets).valid, true, 'every source column must be explicitly mapped or unmapped');
assert.deepEqual(projectMappedRows(decisions, targets)[0].itemCode, '001');
assert.equal(Object.hasOwn(projectMappedRows(decisions, targets)[0], '알 수 없는 열'), false,
  'unmapped source values stay in the working table but never enter voucher projection');

const missingTargetTemplate = {
  ...official,
  templateId: 'SITPL-MISSING',
  mappings: official.mappings.map((mapping, index) => index === 0 ? { ...mapping, targetFieldId: 'deleted-field' } : mapping)
};
assert.equal(createMappingSession({ matrix: raw, headerRowIndex: 1, templates: [missingTargetTemplate], targetDefinitions: targets }).status, SESSION_STATUS.INVALID_TEMPLATE,
  'a deleted target must invalidate the existing template instead of silently dropping data');
assert.equal(createMappingSession({ matrix: raw, headerRowIndex: 1, templates: [official, { ...official, templateId: 'SITPL-CONFLICT' }], targetDefinitions: targets }).status, SESSION_STATUS.TEMPLATE_CONFLICT,
  'duplicate official signatures must be surfaced as a conflict');

let edited = updateWorkingCell(applied, 'source-2', 2, '2.25');
edited = deleteWorkingRows(edited, ['source-3']);
edited = addManualRow(edited, ['003', '미나리', '4', '']);
const reassigned = reassignHeaderRow(edited, 1, [official], targets);
assert.equal(reassigned.sourceMatrix[2][2], '0', 'worktable edits must never mutate the source matrix');
assert.equal(reassigned.workingRows.find(row => row.rowId === 'source-2').cells[2], '2.25');
assert.equal(reassigned.workingRows.some(row => row.rowId === 'source-3'), false, 'deleted work rows must stay deleted after header reassignment');
assert.equal(reassigned.workingRows.some(row => row.manual), true, 'manual rows must survive header reassignment');
const projected = projectMappedRows(reassigned, targets);
assert.equal(projected[0].quantity, 2.25);
assert.equal(projected.at(-1).quantity, 4);

const blankNumeric = createMappingSession({ matrix: [['품목명', '수량'], ['공란수량', ''], ['영수량', '0'], ['음수량', '-2.5']], targetDefinitions: targets });
const blankTemplate = createTemplateRecord(confirmRecommendations(blankNumeric), '빈값 숫자 검증', targets);
const blankApplied = createMappingSession({ matrix: blankNumeric.sourceMatrix, templates: [blankTemplate], targetDefinitions: targets });
const numericRows = projectMappedRows(blankApplied, targets);
assert.equal(blankApplied.workingRows[0].cells[1], '', 'blank source cells must remain blank in the working table');
assert.equal(numericRows[0].quantity, null);
assert.equal(numericRows[1].quantity, 0);
assert.equal(numericRows[2].quantity, -2.5);

const evidenceMatrix = [
  [{ address: 'A1', displayValue: '품목코드', rawValue: '품목코드', cellType: 's' }, { address: 'B1', displayValue: '수량', rawValue: '수량', cellType: 's' }],
  [{ address: 'A2', displayValue: '00125', rawValue: 125, numberFormat: '00000', cellType: 'n' }, { address: 'B2', displayValue: '1,200', rawValue: 1200, numberFormat: '#,##0', cellType: 'n', formula: '600*2' }]
];
let evidenceSession = createMappingSession({
  matrix: [['품목코드', '수량'], ['00125', '1,200']],
  sourceCellMatrix: evidenceMatrix,
  targetDefinitions: targets
});
evidenceSession = confirmRecommendations(evidenceSession);
const evidenceProjection = projectMappedRows(evidenceSession, targets)[0];
assert.equal(evidenceProjection.itemCode, '00125');
assert.equal(evidenceProjection.quantity, 1200);
assert.equal(evidenceProjection.fieldValues.itemCode.currentDisplayValue, '00125');
assert.equal(evidenceProjection.fieldValues.itemCode.evidence.rawValue, 125);
assert.equal(evidenceProjection.fieldValues.quantity.currentDisplayValue, '1,200');
assert.equal(evidenceProjection.fieldValues.quantity.evidence.formula, '600*2');

const sourceWithBlankRows = [
  ['품목코드', '품목명', '메모'],
  ['001', '취나물', ''],
  ['', '', ''],
  [' ', '\u00a0', '\t'],
  ['002', '시금치', '확인']
];
const blankRowSession = createMappingSession({ matrix: sourceWithBlankRows, targetDefinitions: targets });
const blankRowTemplate = createTemplateRecord(confirmRecommendations(blankRowSession), '공백 행 제외 검증', targets);
const blankRowApplied = createMappingSession({ matrix: sourceWithBlankRows, templates: [blankRowTemplate], targetDefinitions: targets });
assert.deepEqual(blankRowApplied.sourceMatrix, sourceWithBlankRows,
  'source input must preserve completely blank rows without rewriting the original matrix');
assert.equal(blankRowApplied.workingRows.length, 2,
  'completely blank and whitespace-only source rows must not create working-table rows');
assert.equal(projectMappedRows(blankRowApplied, targets).length, 2,
  'completely blank source rows must never enter the voucher payload');

const largeTargets = Array.from({ length: 20 }, (_, index) => ({
  id: `field-${index}`,
  label: `필드 ${index}`,
  scope: 'voucher',
  valueType: index % 4 === 0 ? 'NUMBER' : 'TEXT'
}));
const largeMatrix = [
  largeTargets.map(target => target.label),
  ...Array.from({ length: 10_000 }, (_, rowIndex) => largeTargets.map((target, columnIndex) => (
    target.valueType === 'NUMBER' ? String(rowIndex + columnIndex) : `값-${rowIndex}-${columnIndex}`
  )))
];
const performanceStartedAt = performance.now();
const largeNew = createMappingSession({ matrix: largeMatrix, targetDefinitions: largeTargets });
const largeTemplate = createTemplateRecord(confirmRecommendations(largeNew, largeTargets), '대량 Snapshot 공식 양식', largeTargets);
const largeApplied = createMappingSession({ matrix: largeMatrix, templates: [largeTemplate], targetDefinitions: largeTargets });
const largeProjection = projectMappedRows(largeApplied, largeTargets);
const performanceElapsedMs = performance.now() - performanceStartedAt;
assert.equal(largeProjection.length, 10_000);
assert.equal(largeProjection[9_999]['field-0'], 9_999);
assert.ok(performanceElapsedMs < 5_000, `10,000 x 20 mapping must remain responsive; actual ${performanceElapsedMs.toFixed(1)}ms`);

const smartInputSource = readFileSync(fileURLToPath(new URL('../smartinput/smartinput.js', import.meta.url)), 'utf8');
assert.equal((smartInputSource.match(/\$\('mappingInputRows'\)\.addEventListener\('input'/g) || []).length, 1,
  'mapping-table input delegation must be registered once');
assert.match(smartInputSource, /scheduleMappingProjection\(\)/,
  'mapping edits must use the scheduled projection path instead of querying storage per cell');

console.log(`SmartInput input-template mapping tests passed (${largeProjection.length.toLocaleString('en-US')} rows in ${performanceElapsedMs.toFixed(1)}ms).`);
