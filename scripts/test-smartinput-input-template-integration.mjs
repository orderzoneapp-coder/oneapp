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
  planTemplateStructureUpdate,
  templateColumnsFromMappings
} from '../smartinput/input-template-core.js';
import { replaceLiveTemplateImport } from '../smartinput/input-template-draft-adapter.js';
import {
  analyzeImportMatrices,
  clipboardToImportMatrix,
  createImportMatrix,
  parseMappedMatrix
} from '../smartinput/structured-sheet-parser.js';
import {
  buildOrderGroupPayload,
  decorateStructuredRows,
  groupVoucherRows,
  structuredFieldsForMode
} from '../smartinput/multivoucher-stage1.js';

const contractSource = fs.readFileSync(new URL('../smartinput/smartinput-contract.js', import.meta.url), 'utf8');
const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;

const fixtures = {
  order: {
    headers: ['거래처명', '배송일자', '품목코드', '품목명', '수량', '단가', '미매핑 열'],
    values: ['주문 행 거래처', '2026-08-29', 'ORD-1', '주문 상품', '0', '0', '무시'],
    customerField: 'deliveryCustomerName'
  },
  purchase: {
    headers: ['구매처명', '구매일자', '품목코드', '품목명', '수량', '입고가', '미매핑 열'],
    values: ['구매 행 거래처', '2026-08-29', 'PUR-1', '구매 상품', '2', '1200', '무시'],
    customerField: 'supplierCustomerName'
  },
  sale: {
    headers: ['판매처명', '판매일자', '품목코드', '품목명', '수량', '판매가', '미매핑 열'],
    values: ['판매 행 거래처', '2026-08-29', 'SAL-1', '판매 상품', '3', '2200', '무시'],
    customerField: 'salesCustomerName'
  },
  estimate: {
    headers: ['품목코드', '품목명', '수량', '단가', '메모', '미매핑 열'],
    values: ['EST-1', '견적 상품', '4', '3200', '견적 메모', '무시'],
    customerField: 'deliveryCustomerName'
  }
};

const matrixResults = [];
for (const [mode, fixture] of Object.entries(fixtures)) {
  const registry = buildTemplateFieldRegistry(
    mode,
    structuredFieldsForMode(mode, Array.from(contract.PRODUCT_FIELD_DEFINITIONS))
  );
  const fileMatrix = await createImportMatrix({
    sourceKind: 'FILE', sourceName: `${mode}.xlsx`, sheetName: `${mode}-sheet`,
    matrix: [fixture.headers, fixture.values], contentHash: `${mode}-content`
  });
  const createPlan = analyzeImportMatrices([fileMatrix], {
    sessionMode: TEMPLATE_SESSION_MODES.CREATE, fieldRegistry: registry
  }).best;
  assert.ok(createPlan, `${mode}: CREATE_TEMPLATE candidate`);
  const mappings = createPlan.mappingPlan.mappings.filter(mapping => mapping.targetFieldKey).map(mapping => {
    const field = registry.find(item => item.fieldKey === mapping.targetFieldKey);
    return {
      sourceHeader: mapping.sourceHeader,
      normalizedSourceHeader: mapping.normalizedSourceHeader,
      targetFieldKey: mapping.targetFieldKey,
      valueType: field.valueType,
      ...(field.requiredRole ? { requiredRole: field.requiredRole } : {})
    };
  });
  const created = createTemplateRecord({
    mode, name: `${mode} 통합 양식`, mappings,
    columns: templateColumnsFromMappings(mappings, registry)
  }, {
    templateId: `tpl:integration:${mode}`,
    sessionMode: TEMPLATE_SESSION_MODES.CREATE,
    now: '2026-08-27T01:00:00.000Z'
  });
  const reordered = [...created.columns].reverse().map((column, order) => ({
    ...column,
    order,
    displayLabel: column.fieldKey === 'itemName' ? `${mode} 표시 품목명` : column.displayLabel
  }));
  const changed = planTemplateStructureUpdate(created, { columns: reordered }, {
    expectedRevision: 1,
    sessionMode: TEMPLATE_SESSION_MODES.CREATE,
    now: '2026-08-27T01:00:01.000Z'
  });
  assert.equal(changed.changed, true, `${mode}: label/order structure change`);
  assert.equal(changed.record.revision, 2, `${mode}: changed structure increments revision once`);
  const template = changed.record;
  const frozenBytes = JSON.stringify(template);

  const pasteMatrix = await clipboardToImportMatrix({
    text: `${fixture.headers.join('\t')}\n${fixture.values.join('\t')}`,
    sourceName: `${mode} 붙여넣기`
  });
  for (const importMatrix of [fileMatrix, pasteMatrix]) {
    const analysis = analyzeImportMatrices([importMatrix], {
      sessionMode: TEMPLATE_SESSION_MODES.FILL,
      template,
      fieldRegistry: registry
    });
    assert.ok(analysis.best, `${mode}/${importMatrix.sourceKind}: existing-template candidate`);
    assert.equal(analysis.best.mappingPlan.valid, true);
    assert.deepEqual(analysis.best.mappingPlan.unmappedHeaders, ['미매핑 열']);
    const parsed = parseMappedMatrix(importMatrix.matrix, {
      headerRowIndex: analysis.best.headerRowIndex,
      mappings: analysis.best.mappingPlan.mappings,
      numberParser: contract.numberOrNull,
      sheetName: importMatrix.sheetName
    });
    assert.equal(parsed.rows.length, 1);
    assert.equal(Object.hasOwn(parsed.rows[0], '미매핑 열'), false, `${mode}: unmapped columns are not added`);
    const idempotencyKey = buildImportIdempotencyKey({
      mode,
      templateId: template.templateId,
      templateRevision: template.revision,
      importContentHash: importMatrix.contentHash,
      sheetName: importMatrix.sheetName
    });
    const batch = contract.createBatch({
      batchId: `${mode}-${importMatrix.sourceKind}-batch-1`,
      method: 'excel-template',
      sourceType: importMatrix.sourceKind === 'FILE' ? 'STRUCTURED_FILE' : 'CLIPBOARD',
      sourceRole: 'LIVE_SOURCE',
      importIdempotencyKey: idempotencyKey,
      templateId: template.templateId,
      templateRevision: template.revision,
      templateStructureHash: template.structureHash,
      importContentHash: importMatrix.contentHash,
      mappingDigest: mappingDigest(template.mappings),
      importSourceKind: importMatrix.sourceKind
    });
    const decorated = decorateStructuredRows(parsed.rows, {
      sourceBatchId: batch.batchId,
      sourceSheetName: importMatrix.sheetName,
      sourceFingerprint: importMatrix.contentHash,
      sourceDocumentKey: idempotencyKey
    }).map((row, index) => ({
      ...row,
      sourceLineKey: `${idempotencyKey}:sheet:${row.sourceLineNo || index + 1}`
    }));
    const manualBatch = contract.createBatch({
      batchId: `${mode}-manual`, method: 'direct', sourceType: 'MANUAL', sourceRole: 'MANUAL_WORKTABLE'
    });
    const manualRow = contract.applyParserResults([], manualBatch, [{
      sourceLineKey: `${mode}-manual:1`, itemCode: `${mode}-MANUAL`, itemName: '수동 유지', quantity: 1
    }])[0];
    const draft = { batches: [manualBatch], rows: [manualRow] };
    const first = replaceLiveTemplateImport(draft, { batch, rows: decorated, contract });
    assert.equal(first.alreadyApplied, false);
    assert.equal(first.rows.length, 2, `${mode}: manual plus imported row`);
    assert.equal(first.rows.some(row => row.itemCode === `${mode}-MANUAL`), true, `${mode}: manual row preserved`);
    const imported = first.importedRows[0];
    imported.itemName = `${imported.itemName} · 관리자 수정`;
    imported.editedFields = { ...(imported.editedFields || {}), itemName: true };
    const secondBatch = contract.createBatch({ ...batch, batchId: `${mode}-${importMatrix.sourceKind}-batch-2` });
    const secondRows = decorated.map(row => ({ ...row, sourceBatchId: secondBatch.batchId }));
    const reapplied = replaceLiveTemplateImport({ batches: first.batches, rows: first.rows }, {
      batch: secondBatch, rows: secondRows, contract
    });
    assert.equal(reapplied.alreadyApplied, true, `${mode}: identical import recognized`);
    assert.equal(reapplied.rows.length, 2, `${mode}: identical import replaces instead of appending`);
    assert.equal(reapplied.importedRows[0].itemName.endsWith('관리자 수정'), true, `${mode}: administrator edit preserved`);
    assert.equal(reapplied.batches.filter(item => item.sourceRole === 'LIVE_SOURCE').length, 1);

    const groups = groupVoucherRows(mode, reapplied.importedRows, {
      customerName: '상단 기본 거래처',
      deliveryDate: '2099-01-01',
      voucherDate: '2099-01-01'
    });
    assert.equal(groups.length, 1);
    if (mode !== 'estimate') {
      assert.equal(groups[0][fixture.customerField], fixture.values[0], `${mode}: row customer overrides header`);
      assert.equal(mode === 'order' ? groups[0].deliveryDate : groups[0].voucherDate,
        '2026-08-29', `${mode}: row date overrides header`);
    }
    if (mode === 'order') {
      const payload = buildOrderGroupPayload(groups[0], { orderDate: '2099-01-01' });
      assert.equal(payload.items[0].finalQuantity, 0, 'order writer payload retains numeric zero');
      assert.equal(payload.items[0].unitPrice, 0, 'order writer payload retains zero unit price');
    }
    assert.equal(JSON.stringify(template), frozenBytes, `${mode}/${importMatrix.sourceKind}: template bytes unchanged`);
    matrixResults.push(`${mode}/${importMatrix.sourceKind}`);
  }
}

assert.deepEqual(matrixResults, [
  'order/FILE', 'order/CLIPBOARD',
  'purchase/FILE', 'purchase/CLIPBOARD',
  'sale/FILE', 'sale/CLIPBOARD',
  'estimate/FILE', 'estimate/CLIPBOARD'
]);

console.log('SmartInput template integration PASS: 4 modes × file/clipboard, structure revision, byte lock, idempotency, and WorkTable grouping.');
