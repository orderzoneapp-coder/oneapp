#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  TEMPLATE_SESSION_MODES,
  buildImportIdempotencyKey,
  buildTemplateFieldRegistry,
  createTemplateRecord,
  mappingDigest,
  planExistingTemplateMappings,
  planTemplateStructureUpdate,
  recommendTemplateMappings,
  systemInputTemplate,
  templateColumnsFromMappings,
  templateStructureHash,
  validateTemplateMappings
} from '../smartinput/input-template-core.js';
import {
  analyzeImportMatrices,
  clipboardToImportMatrix,
  createImportMatrix,
  parseMappedMatrix,
  workbookToImportMatrices
} from '../smartinput/structured-sheet-parser.js';
import { structuredFieldsForMode } from '../smartinput/multivoucher-stage1.js';

const contractSource = fs.readFileSync(new URL('../smartinput/smartinput-contract.js', import.meta.url), 'utf8');
const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;

const modeCases = {
  order: {
    headers: ['거래처명', '배송일자', '품목코드', '품목명', '수량', '단가'],
    row: ['남경', '2026-08-28', 'O-1', '주문품', '0', '0']
  },
  purchase: {
    headers: ['구매처명', '구매일자', '품목코드', '품목명', '수량', '입고가'],
    row: ['구매처', '2026-08-28', 'P-1', '구매품', '2', '1500']
  },
  sale: {
    headers: ['판매처명', '판매일자', '품목코드', '품목명', '수량', '판매가'],
    row: ['판매처', '2026-08-28', 'S-1', '판매품', '3', '2500']
  },
  estimate: {
    headers: ['품목코드', '품목명', '수량', '단가', '메모'],
    row: ['E-1', '견적품', '', '0', '확인']
  }
};

for (const [mode, fixture] of Object.entries(modeCases)) {
  const definitions = structuredFieldsForMode(mode, Array.from(contract.PRODUCT_FIELD_DEFINITIONS));
  const registry = buildTemplateFieldRegistry(mode, definitions);
  const importMatrix = await createImportMatrix({
    sourceKind: 'FILE', sourceName: `${mode}.xlsx`, sheetName: mode,
    matrix: [fixture.headers, fixture.row], contentHash: `${mode}-hash`
  });
  const createAnalysis = analyzeImportMatrices([importMatrix], {
    sessionMode: TEMPLATE_SESSION_MODES.CREATE, fieldRegistry: registry
  });
  assert.ok(createAnalysis.best, `${mode}: new-template header must be detected`);
  const recommendations = createAnalysis.best.mappingPlan.mappings.filter(mapping => mapping.targetFieldKey);
  const mappings = recommendations.map(mapping => {
    const field = registry.find(item => item.fieldKey === mapping.targetFieldKey);
    return {
      sourceHeader: mapping.sourceHeader,
      normalizedSourceHeader: mapping.normalizedSourceHeader,
      sourceAliases: [mapping.normalizedSourceHeader],
      targetFieldKey: mapping.targetFieldKey,
      valueType: field.valueType,
      ...(field.requiredRole ? { requiredRole: field.requiredRole } : {})
    };
  });
  const columns = templateColumnsFromMappings(mappings, registry);
  const template = createTemplateRecord({ mode, name: `${mode} 양식`, mappings, columns }, {
    templateId: `tpl:${mode}`, sessionMode: TEMPLATE_SESSION_MODES.CREATE, now: '2026-08-27T00:00:00.000Z'
  });
  assert.equal(template.revision, 1);
  assert.equal(template.structureHash, templateStructureHash(template));
  const beforeBytes = JSON.stringify(template);
  const existingAnalysis = analyzeImportMatrices([importMatrix], {
    sessionMode: TEMPLATE_SESSION_MODES.FILL, template, fieldRegistry: registry
  });
  assert.ok(existingAnalysis.best, `${mode}: existing-template exact mapping must be detected`);
  const parsed = parseMappedMatrix(importMatrix.matrix, {
    headerRowIndex: existingAnalysis.best.headerRowIndex,
    mappings: existingAnalysis.best.mappingPlan.mappings,
    numberParser: contract.numberOrNull,
    sheetName: mode
  });
  assert.equal(parsed.rows.length, 1);
  assert.equal(JSON.stringify(template), beforeBytes, `${mode}: planning/import must not mutate template bytes`);
  const reapplied = parseMappedMatrix(importMatrix.matrix, {
    headerRowIndex: existingAnalysis.best.headerRowIndex,
    mappings: existingAnalysis.best.mappingPlan.mappings,
    numberParser: contract.numberOrNull,
    sheetName: mode
  });
  assert.deepEqual(reapplied.rows, parsed.rows, `${mode}: reapply calculation must be stable`);
}

const orderRegistry = buildTemplateFieldRegistry('order', structuredFieldsForMode('order', Array.from(contract.PRODUCT_FIELD_DEFINITIONS)));
const recommended = recommendTemplateMappings(['품목코드', '품목명', '수량', '단가'], orderRegistry);
assert.equal(recommended.mappedCount, 4);
assert.equal(recommended.identityCount, 2);
assert.deepEqual(recommendTemplateMappings(['품목코드', '상품코드'], orderRegistry).duplicateSourceHeaders, []);
assert.equal(validateTemplateMappings([
  { sourceHeader: '품목코드', targetFieldKey: 'itemCode' },
  { sourceHeader: '상품코드', targetFieldKey: 'itemCode' }
]).errors[0].code, 'DUPLICATE_TARGET_FIELD');

const systemTemplate = systemInputTemplate('order', orderRegistry);
const exact = planExistingTemplateMappings(['거래처명', '품목코드', '품목명', '수량', '알 수 없는 열'], systemTemplate);
assert.equal(exact.valid, true);
assert.deepEqual(exact.unmappedHeaders, ['알 수 없는 열']);
assert.equal(systemTemplate.mappings.some(mapping => mapping.targetFieldKey === '알 수 없는 열'), false);

const duplicateSource = planExistingTemplateMappings(['품목코드', '품목코드', '품목명'], systemTemplate);
assert.equal(duplicateSource.blockingErrors[0].code, 'DUPLICATE_SOURCE_HEADER');
const oneSourceMultipleTargets = planExistingTemplateMappings(['품목'], {
  mappings: [
    { sourceHeader: '품목', targetFieldKey: 'itemCode' },
    { sourceHeader: '품목', targetFieldKey: 'itemName' }
  ]
});
assert.equal(oneSourceMultipleTargets.blockingErrors[0].code, 'DUPLICATE_SOURCE_HEADER');

assert.throws(() => planTemplateStructureUpdate(systemInputTemplate('purchase', buildTemplateFieldRegistry(
  'purchase', structuredFieldsForMode('purchase', Array.from(contract.PRODUCT_FIELD_DEFINITIONS))
)), {}, { expectedRevision: 1, sessionMode: TEMPLATE_SESSION_MODES.CREATE }), error => error.code === 'TEMPLATE_STRUCTURE_LOCKED');

const editableMappings = recommended.mappings.filter(mapping => mapping.targetFieldKey).map(mapping => ({
  sourceHeader: mapping.sourceHeader,
  normalizedSourceHeader: mapping.normalizedSourceHeader,
  targetFieldKey: mapping.targetFieldKey,
  valueType: orderRegistry.find(field => field.fieldKey === mapping.targetFieldKey).valueType
}));
const editableTemplate = createTemplateRecord({
  mode: 'order', name: '수정 테스트', mappings: editableMappings,
  columns: templateColumnsFromMappings(editableMappings, orderRegistry)
}, { templateId: 'tpl:update', sessionMode: TEMPLATE_SESSION_MODES.CREATE, now: '2026-08-27T00:00:00.000Z' });
const noChange = planTemplateStructureUpdate(editableTemplate, editableTemplate, {
  expectedRevision: 1, sessionMode: TEMPLATE_SESSION_MODES.CREATE
});
assert.equal(noChange.changed, false);
assert.equal(noChange.record.revision, 1);
const changedColumns = editableTemplate.columns.map(column => column.fieldKey === 'itemName'
  ? { ...column, displayLabel: '상품 표시명' }
  : column);
const changed = planTemplateStructureUpdate(editableTemplate, { columns: changedColumns }, {
  expectedRevision: 1, sessionMode: TEMPLATE_SESSION_MODES.CREATE, now: '2026-08-27T00:00:01.000Z'
});
assert.equal(changed.changed, true);
assert.equal(changed.record.revision, 2);
assert.throws(() => planTemplateStructureUpdate(editableTemplate, { columns: changedColumns }, {
  expectedRevision: 1, sessionMode: TEMPLATE_SESSION_MODES.FILL
}), error => error.code === 'TEMPLATE_STRUCTURE_LOCKED');

const idempotencyA = buildImportIdempotencyKey({
  mode: 'order', templateId: editableTemplate.templateId, templateRevision: 1,
  importContentHash: 'file-hash', sheetName: 'Sheet1'
});
const idempotencyB = buildImportIdempotencyKey({
  mode: 'order', templateId: editableTemplate.templateId, templateRevision: 1,
  importContentHash: 'file-hash', sheetName: 'Sheet1'
});
assert.equal(idempotencyA, idempotencyB);
assert.equal(mappingDigest(editableMappings), mappingDigest([...editableMappings]));

const tsv = '품목코드\t품목명\t수량\t단가\nA-1\t상품\t0\t0';
const tsvMatrix = await clipboardToImportMatrix({ text: tsv });
const htmlMatrix = await clipboardToImportMatrix({ html: '<table><tr><th>품목코드</th><th>품목명</th><th>수량</th><th>단가</th></tr><tr><td>A-1</td><td>상품</td><td>0</td><td>0</td></tr></table>' });
assert.deepEqual(htmlMatrix.matrix, tsvMatrix.matrix, 'HTML table and TSV paste must produce the same ImportMatrix values');
const pastePlan = analyzeImportMatrices([htmlMatrix], {
  sessionMode: TEMPLATE_SESSION_MODES.CREATE, fieldRegistry: orderRegistry
}).best;
const pasteRows = parseMappedMatrix(htmlMatrix.matrix, {
  headerRowIndex: pastePlan.headerRowIndex,
  mappings: pastePlan.mappingPlan.mappings,
  numberParser: contract.numberOrNull
}).rows;
assert.equal(pasteRows[0].quantity, 0);
assert.equal(pasteRows[0].unitPrice, 0);

const workbookMatrix = [
  ['보고서'],
  ['품목코드', '품목명', '수량', '단가'],
  ['WB-1', '워크북 상품', '4', '900']
];
const fakeWorkbook = {
  SheetNames: ['빈 시트', '데이터'],
  Sheets: {
    '빈 시트': {},
    '데이터': { '!ref': 'A1:D3', matrix: workbookMatrix }
  }
};
const fakeXlsx = { utils: { sheet_to_json: sheet => sheet.matrix } };
for (const extension of ['xlsx', 'xls', 'csv', 'tsv']) {
  const matrices = await workbookToImportMatrices(fakeWorkbook, fakeXlsx, {
    sourceName: `fixture.${extension}`, contentHash: `hash-${extension}`
  });
  assert.equal(matrices.length, 1, `${extension}: empty worksheets must be ignored`);
  assert.deepEqual(matrices[0].matrix, workbookMatrix, `${extension}: file formats must share the matrix adapter`);
  assert.equal(matrices[0].sourceKind, 'FILE');
}

const tieA = await createImportMatrix({
  sourceKind: 'FILE', sourceName: 'tie.xlsx', sheetName: 'A', matrix: [modeCases.order.headers, modeCases.order.row]
});
const tieB = await createImportMatrix({
  sourceKind: 'FILE', sourceName: 'tie.xlsx', sheetName: 'B', matrix: [modeCases.order.headers, modeCases.order.row]
});
const tied = analyzeImportMatrices([tieA, tieB], {
  sessionMode: TEMPLATE_SESSION_MODES.CREATE, fieldRegistry: orderRegistry
});
assert.equal(tied.requiresSelection, true, 'equal multi-sheet candidates require an explicit selection');
assert.equal(tied.tiedBest.length, 2);
const selectedTie = analyzeImportMatrices([tieA, tieB], {
  sessionMode: TEMPLATE_SESSION_MODES.CREATE, fieldRegistry: orderRegistry, selectedSheetName: 'B'
});
assert.equal(selectedTie.best.sheetName, 'B');
assert.equal(selectedTie.requiresSelection, false);

const row80Matrix = Array.from({ length: 79 }, (_, index) => [`안내 ${index + 1}`]);
row80Matrix.push(['품목코드', '품목명', '수량'], ['ROW-80', '80행 상품', '1']);
const row80Import = await createImportMatrix({
  sourceKind: 'FILE', sourceName: 'row80.xlsx', sheetName: '80행', matrix: row80Matrix
});
const row80 = analyzeImportMatrices([row80Import], {
  sessionMode: TEMPLATE_SESSION_MODES.CREATE, fieldRegistry: orderRegistry
});
assert.equal(row80.best.headerRowNumber, 80, 'automatic header scanning must include row 80');
const directHeader = analyzeImportMatrices([row80Import], {
  sessionMode: TEMPLATE_SESSION_MODES.CREATE, fieldRegistry: orderRegistry,
  selectedSheetName: '80행', selectedHeaderRowIndex: 79
});
assert.equal(directHeader.best.headerRowIndex, 79);

for (const meta of [
  { sheetName: '_NEXUS_META', schema: 'ORDERQ_PURCHASE_META_V2' },
  { sheetName: '_NEXUS_SALES_META', schema: 'ORDERQ_SALES_META_V1' }
]) {
  const matrix = await createImportMatrix({
    sourceKind: 'FILE', sourceName: 'meta.xlsx', sheetName: meta.sheetName,
    matrix: [['schemaVersion', '품목코드'], [meta.schema, 'META-1']]
  });
  const analysis = analyzeImportMatrices([matrix], {
    sessionMode: TEMPLATE_SESSION_MODES.CREATE, fieldRegistry: orderRegistry
  });
  assert.equal(analysis.best, null, `${meta.sheetName}: metadata sheets must not become import candidates`);
}

const errorHeaders = ['주문일자', '품목코드', '품목명', '수량', '단가'];
const errorPlan = recommendTemplateMappings(errorHeaders, orderRegistry);
const errorParsed = parseMappedMatrix([
  errorHeaders,
  ['잘못된 날짜', 'ERR-1', '오류 상품', '문자 수량', '0'],
  errorHeaders,
  ['2026-08-28', 'OK-1', '정상 상품', '0', '1,000'],
  ['합계', '', '', '1', '1,000'],
  ['2026-08-27 (목) 오전 9:25:08', '', '', '', '']
], {
  headerRowIndex: 0,
  mappings: errorPlan.mappings,
  numberParser: contract.numberOrNull
});
assert.equal(errorParsed.rows.length, 2);
assert.equal(errorParsed.rows[0].quantity, null);
assert.equal(errorParsed.rows[0].rawText.includes('문자 수량'), true, 'invalid cells must retain original row text');
assert.equal(errorParsed.rows[1].quantity, 0);
assert.deepEqual(errorParsed.invalidCells.map(cell => cell.valueType).sort(), ['DATE', 'NUMBER']);
assert.deepEqual(errorParsed.excludedRows.map(row => row.reason), ['REPEATED_HEADER', 'FOOTER', 'FOOTER']);
assert.equal(errorParsed.rows[1].sourceVoucherIndex, 2, 'repeated headers must preserve multi-voucher boundaries');

console.log('SmartInput input-template core and matrix adapter tests passed.');
