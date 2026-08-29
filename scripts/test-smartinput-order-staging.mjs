#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseStructuredSheet } from '../smartinput/structured-sheet-parser.js';
import {
  buildOrderGroupPayload,
  decorateStructuredRows,
  groupVoucherRows,
  structuredFieldsForMode
} from '../smartinput/multivoucher-stage1.js';
import {
  TEMPLATE_MODES,
  createTemplateRecord,
  loadTemplateLibrary,
  saveTemplateLibrary,
  templateFieldDefinitions
} from '../smartinput/input-template-core.js';
import {
  applyStaging,
  createStaging,
  normalizedSourceHash
} from '../smartinput/source-staging.js';
import { saveOrderLocal } from '../smartinput/integration-adapter.js';
import { executeVoucherGroups, rowsForFailedGroups } from '../smartinput/workflow-core.js';

const contractSource = fs.readFileSync(new URL('../smartinput/smartinput-contract.js', import.meta.url), 'utf8');
const context = { window: {}, globalThis: {}, Date, Math, String, Number, Boolean, Object, Array, Map, Set };
vm.runInNewContext(contractSource, context);
const contract = context.window.SMART_INPUT_CONTRACT;

const headers = ['일자', '담당', '창고코드', '단위', '품목코드', '품목명', '규격', '수량', '재고', '단가', '적요', '적요1', '거래처', '그룹'];
const dataRows = Array.from({ length: 93 }, (_, index) => {
  const quantity = index === 92 ? 0.5 : 2;
  const price = index === 0 ? 171675 : 10000;
  return [
    '2026/08/29', '담당', '88', index === 0 ? 'bOX' : (index % 3 ? 'EA' : 'BOX'),
    `ITEM-${String(index + 1).padStart(3, '0')}`, `상품 ${index + 1}`, `규격 ${index + 1}`,
    quantity, '', price, index === 1 ? '메모' : '', '', `거래처 ${index % 18 + 1}`, '그룹'
  ];
});
const matrix = [
  ['회사명 : 원앱 / 주문 / 2025/08/29 ~ 2026/08/29'],
  headers,
  ...dataRows,
  ['2026/08/29 (토) 오전 3:42:29']
];

const fields = structuredFieldsForMode('order', contract.PRODUCT_FIELD_DEFINITIONS);
const parsed = parseStructuredSheet(matrix, { fieldDefinitions: fields, numberParser: contract.numberOrNull });
assert.equal(parsed.headerRowNumber, 2, 'A1 제목이 아니라 A2 실제 헤더를 선택해야 한다.');
assert.equal(parsed.rows.length, 93, '마지막 출력시각 행은 제외해야 한다.');
assert.deepEqual(parsed.sourceColumns.map(column => column.label), headers, '원본 A2:N2 열 제목과 순서를 모두 보존해야 한다.');
assert.equal(Object.keys(parsed.rows[0].sourceValues).length, 14);
assert.deepEqual(parsed.sourceColumns.map(column => parsed.rows[0].sourceValues[column.sourceValueKey]), dataRows[0].map(value => String(value ?? '')),
  '대표 행의 원본 14개 값을 독립적으로 보존해야 한다.');
assert.equal(parsed.mappings.find(mapping => mapping.sourceHeader === '단위')?.fieldId, 'unit');
assert.equal(parsed.mappings.find(mapping => mapping.sourceHeader === '규격')?.fieldId, 'specification');

const sourceHash = await normalizedSourceHash(parsed, { mode: 'order', cryptoImpl: webcrypto });
assert.match(sourceHash, /^[a-f0-9]{64}$/);
const preparedRows = decorateStructuredRows(parsed.rows, {
  sourceBatchId: 'BATCH-93',
  sourceSheetName: '미판매현황',
  sourceFingerprint: sourceHash
});
assert.equal(preparedRows[0].rawUnit, 'bOX');
assert.equal(preparedRows[0].unit, 'BOX');
assert.equal(preparedRows[0].warnings[0].code, 'UNIT_CASE_NORMALIZED');
const normalizedRows = preparedRows.map(contract.normalizeRow);
assert.equal(normalizedRows[92].quantity, 0.5);
assert.equal(normalizedRows.reduce((sum, row) => sum + row.quantity, 0), 184.5);
assert.equal(normalizedRows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0), 2168350);

const groups = groupVoucherRows('order', normalizedRows);
assert.equal(groups.length, 18, '주문 그룹키는 거래처+일자+창고코드 기준이어야 한다.');
assert.equal(new Set(groups.map(group => group.idempotencyKey)).size, 18);
assert.ok(groups.every(group => group.businessKey === group.voucherGroupKey));
const payload = buildOrderGroupPayload(groups[0], { sourceColumns: parsed.sourceColumns });
assert.equal(payload.sourceId, sourceHash);
assert.equal(payload.sourceMessageKey, groups[0].idempotencyKey);
assert.match(payload.items[0].rawText, /^SMART_INPUT_SOURCE_ROW_V1\t/);
const sourceEnvelope = JSON.parse(payload.items[0].rawText.split('\t', 2)[1]);
assert.equal(sourceEnvelope.columns.length, 14);
assert.equal(Object.keys(sourceEnvelope.values).length, 14);

const tableFieldIds = ['itemCode', 'itemName', 'specification', 'quantity', 'unit', 'unitPrice', 'memo'];
const template = createTemplateRecord({ mode: 'order', name: '미출고 주문', mappings: parsed.mappings, columns: parsed.sourceColumns, tableFieldIds }, {
  templateId: 'SITPL-1', now: '2026-08-29T00:00:00.000Z'
});
assert.notEqual(template.mappings.find(mapping => mapping.fieldId === 'unit')?.fieldId,
  template.mappings.find(mapping => mapping.fieldId === 'specification')?.fieldId);
assert.deepEqual(template.columns.map(column => column.label), headers);
assert.equal(template.columns.length, 14);
assert.equal(template.columns.find(column => column.label === '단위')?.targetFieldId, 'unit');
assert.equal(template.columns.find(column => column.label === '규격')?.targetFieldId, 'specification');
assert.notEqual(template.columns.find(column => column.label === '적요')?.sourceValueKey,
  template.columns.find(column => column.label === '적요1')?.sourceValueKey);
const existingFields = templateFieldDefinitions(template, fields);
const existingParsed = parseStructuredSheet(matrix, { fieldDefinitions: existingFields, numberParser: contract.numberOrNull });
assert.equal(existingParsed.rows.length, 93, '기존 양식은 저장 구조를 다시 만들지 않고 값만 읽어야 한다.');

const storageData = new Map([['settings', JSON.stringify({ unrelated: 'keep' })]]);
const storage = { getItem: key => storageData.get(key) || null, setItem: (key, value) => storageData.set(key, value) };
saveTemplateLibrary(storage, 'settings', [template]);
const reloaded = loadTemplateLibrary(storage, 'settings');
assert.equal(reloaded.root.unrelated, 'keep', '기존 설정은 보존해야 한다.');
assert.equal(reloaded.records[0].name, '미출고 주문');

const modeDraft = contract.createDraft().modes.order;
const existingWork = contract.normalizeRow({ itemCode: 'KEEP', itemName: '기존 작업', quantity: 1, unit: 'EA' });
modeDraft.rows = [existingWork];
const batch = contract.createBatch({ batchId: 'BATCH-93', method: 'excel', contentHash: sourceHash });
modeDraft.staging = createStaging({
  sourceHash, rows: normalizedRows, batch, mappings: parsed.mappings, columns: parsed.sourceColumns,
  templateMode: TEMPLATE_MODES.CREATE, templateName: template.name
}, contract.normalizeRow);
const applied = applyStaging(modeDraft, contract);
assert.equal(applied.rows.length, 93);
assert.equal(modeDraft.rows.length, 94);
assert.equal(modeDraft.rows[0].rowId, existingWork.rowId, '기존 작업행을 덮어쓰면 안 된다.');
assert.equal(Object.keys(modeDraft.rows[1].sourceValues).length, 14);

const partial = await executeVoucherGroups(groups, async group => {
  if (group.deliveryCustomerName === '거래처 3') throw Object.assign(new Error('GROUP_FAILED'), { code: 'GROUP_FAILED' });
  return { orderId: group.voucherGroupKey };
});
assert.equal(partial.filter(result => result.ok).length, 17);
assert.equal(partial.filter(result => !result.ok).length, 1);
const failedRows = rowsForFailedGroups(normalizedRows, partial);
assert.ok(failedRows.length > 0);
assert.ok(failedRows.every(row => row.rowCustomerName === '거래처 3'));
const retryGroups = groupVoucherRows('order', failedRows);
assert.equal(retryGroups.length, 1, '부분 실패 후 실패 그룹만 재실행해야 한다.');

globalThis.__SMARTINPUT_INTEGRATION_BRIDGE__ = {
  createOrder: async incoming => {
    throw Object.assign(new Error('duplicate'), {
      code: 'ORDER_SOURCE_MESSAGE_DUPLICATE',
      existingOrder: { orderId: 'ORD-1', sourceId: incoming.sourceId }
    });
  }
};
const duplicate = await saveOrderLocal(payload);
assert.equal(duplicate.idempotent, true, '같은 업무키+같은 source hash는 중복 0 성공이어야 한다.');
globalThis.__SMARTINPUT_INTEGRATION_BRIDGE__.createOrder = async () => {
  throw Object.assign(new Error('duplicate'), {
    code: 'ORDER_SOURCE_MESSAGE_DUPLICATE',
    existingOrder: { orderId: 'ORD-1', sourceId: 'different-source-hash' }
  });
};
await assert.rejects(() => saveOrderLocal(payload), error => error.code === 'ORDER_BUSINESS_KEY_CONFLICT');
delete globalThis.__SMARTINPUT_INTEGRATION_BRIDGE__;

console.log('SmartInput order staging/template/idempotency PASS');
