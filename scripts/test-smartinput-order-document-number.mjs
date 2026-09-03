import assert from 'node:assert/strict';

import {
  applyOrderDocumentNumberDerivation,
  parseOrderDocumentNumber
} from '../smartinput/order-document-number.js';
import {
  createTemplateRecord,
  createMappingSession,
  DECISION,
  projectMappedRows,
  setColumnDecision
} from '../smartinput/input-template-mapper.js';
import {
  buildOrderGroupPayload,
  groupVoucherRows,
  structuredFieldsForMode
} from '../smartinput/multivoucher-stage1.js';
import { externalOrderSnapshot } from '../orderq/order-document-model.js';

const baseFields = [
  { id: 'itemCode', label: '품목코드', projectionFieldId: 'itemCode', valueType: 'TEXT' },
  { id: 'itemName', label: '품목명', projectionFieldId: 'itemName', valueType: 'TEXT', aliases: ['품명'] },
  { id: 'specification', label: '규격', projectionFieldId: 'specification', valueType: 'TEXT' },
  { id: 'quantity', label: '수량', projectionFieldId: 'quantity', valueType: 'NUMBER' },
  { id: 'unitPrice', label: '단가', projectionFieldId: 'unitPrice', valueType: 'NUMBER' }
];
const definitions = structuredFieldsForMode('order', baseFields).map(field => ({
  ...field,
  projectionFieldId: field.projectionFieldId || field.id,
  aliases: field.inputAliases || field.aliases || []
}));

assert.deepEqual(parseOrderDocumentNumber('2026/09/04-35'), {
  valid: true,
  originalValue: '2026/09/04-35',
  date: '2026-09-04'
});
assert.equal(parseOrderDocumentNumber('2026.09.04-7').date, '2026-09-04');
assert.equal(parseOrderDocumentNumber('2026-09-04-35').date, '2026-09-04');
assert.equal(parseOrderDocumentNumber('2026/02/30-1').code, 'ORDER_DOCUMENT_NO_DATE_INVALID');
assert.equal(parseOrderDocumentNumber('2026/09/04-').code, 'ORDER_DOCUMENT_NO_NUMBER_REQUIRED');
assert.equal(parseOrderDocumentNumber('2026/09/04-A').code, 'ORDER_DOCUMENT_NO_NUMBER_INVALID');
assert.equal(Object.hasOwn(parseOrderDocumentNumber('2026/09/04-35'), 'sequence'), false,
  'the validated trailing number must never become a stored internal sequence');

function mappedRows(matrix, sourceCellMatrix = []) {
  let session = createMappingSession({
    matrix,
    sourceCellMatrix,
    headerRowIndex: 0,
    targetDefinitions: definitions,
    companyId: 'ONEAPP',
    voucherMode: 'order',
    fileName: '미출고현황.xlsx',
    sheetName: '미판매현황',
    fileFingerprint: 'ORDER-DOCNO-FIXTURE'
  });
  const documentRecommendation = session.mappings.find(mapping => mapping.sourceHeader === '일자-No.');
  assert.equal(documentRecommendation?.state, DECISION.RECOMMENDED,
    'the exact one-column source header must remain a recommendation until the user confirms it');
  for (const mapping of session.mappings) {
    session = mapping.state === DECISION.RECOMMENDED
      ? setColumnDecision(session, mapping.columnIndex, DECISION.MAPPED, mapping.targetFieldId, definitions)
      : setColumnDecision(session, mapping.columnIndex, DECISION.UNMAPPED, '', definitions);
  }
  const template = createTemplateRecord(session, '일자-No. 주문서 양식', definitions);
  assert.equal(template.signature, session.signature, 'manual mapping must preserve the positional template signature');
  assert.equal(template.headerSignature, session.headerSignature);
  assert.equal(template.mappings.find(mapping => mapping.sourceHeader === '일자-No.')?.state, DECISION.MAPPED);
  const protectedSource = JSON.stringify({
    sourceMatrix: session.sourceMatrix,
    sourceCellMatrix: session.sourceCellMatrix,
    signature: session.signature,
    headerSignature: session.headerSignature,
    workingRows: session.workingRows
  });
  const rows = applyOrderDocumentNumberDerivation({
    rows: projectMappedRows(session, definitions),
    session,
    targetDefinitions: definitions
  });
  assert.equal(JSON.stringify({
    sourceMatrix: session.sourceMatrix,
    sourceCellMatrix: session.sourceCellMatrix,
    signature: session.signature,
    headerSignature: session.headerSignature,
    workingRows: session.workingRows
  }), protectedSource, 'date derivation must not mutate mapping/source evidence');
  assert.deepEqual(rows.map(row => row.rowId), session.workingRows.map(row => row.rowId),
    'source and input views must project the same working-row identity set');
  return { session, rows };
}

const evidenceMatrix = [
  ['일자-No.', '품목코드', '품목명', '규격', '수량', '단가'],
  ['2026/09/04-35', '00125', '햇무우', '', '0', '16100'],
  ['', '', '', '', '', ''],
  ['2026/09/04-35', '00126', '대파', 'EA', '-2', '2600']
];
const sourceCellMatrix = evidenceMatrix.map((row, rowIndex) => row.map((displayValue, columnIndex) => ({
  address: `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`,
  rowIndex,
  columnIndex,
  displayValue,
  rawValue: displayValue,
  formula: '',
  numberFormat: '@',
  cellType: 's',
  blank: displayValue === ''
})));
const repeated = mappedRows(evidenceMatrix, sourceCellMatrix);
assert.equal(repeated.rows.length, 2, 'repeated document numbers must preserve every item row');
assert.equal(repeated.session.sourceMatrix.length, 4, 'the immutable source matrix must retain the blank source row');
assert.equal(repeated.session.workingRows.length, 2, 'a fully blank source row must not become a work row');
assert.deepEqual(repeated.rows.map(row => row.rowVoucherNo), ['2026/09/04-35', '2026/09/04-35']);
assert.deepEqual(repeated.rows.map(row => row.rowVoucherDate), ['2026-09-04', '2026-09-04']);
assert.deepEqual(repeated.rows.map(row => row.rowDeliveryDate), ['2026-09-04', '2026-09-04']);
assert.deepEqual(repeated.rows.map(row => row.quantity), [0, -2], 'zero and negative quantities must survive');
assert.equal(repeated.rows[0].specification, '', 'an internal blank cell must remain blank');

const documentNumberField = Object.values(repeated.rows[0].fieldValues)
  .find(field => field.currentDisplayValue === '2026/09/04-35');
const derivedDateFields = Object.values(repeated.rows[0].fieldValues)
  .filter(field => field.evidence?.derivation === 'ORDER_DOCUMENT_NUMBER_DATE');
assert.equal(documentNumberField.evidence.address, 'A2');
assert.equal(derivedDateFields.length, 2, 'one source value must provide order date and due date projections');
assert.ok(derivedDateFields.every(field => field.evidence.address === 'A2'));

const groups = groupVoucherRows('order', repeated.rows, {
  customerName: '숙임이네감자탕',
  warehouseCode: '88',
  transactionType: '기타'
});
assert.equal(groups.length, 1);
assert.equal(groups[0].rows.length, 2);
assert.equal(groups[0].validationStatus, 'READY');
const payload = buildOrderGroupPayload(groups[0], {});
assert.equal(payload.orderDate, '2026-09-04');
assert.equal(payload.deliveryExpectedDate, '2026-09-04');
assert.equal(payload.externalOrderNo, '2026/09/04-35');
assert.equal(Object.hasOwn(payload, 'orderNo'), false,
  'the external original must not replace ORDER Q\'s internally allocated manager order number');
assert.equal(payload.items.length, 2);
assert.equal(Object.hasOwn(payload, 'orderSequence'), false);
assert.equal(Object.hasOwn(payload, 'documentOrdinal'), false);
assert.equal(JSON.stringify(payload).includes('"sequence":35'), false,
  'the validated suffix must not be materialized as an internal field');
assert.equal(externalOrderSnapshot(payload).externalOrderNo, '2026/09/04-35',
  'the ORDER Q storage boundary must preserve the complete source document number');

const matchingSeparateDate = mappedRows([
  ['일자', '일자-No.', '품목코드', '품목명', '수량'],
  ['2026/09/04', '2026-09-04-35', 'A', '상품A', '1']
]);
assert.equal(matchingSeparateDate.rows[0].rowVoucherDate, '2026-09-04');
assert.equal(matchingSeparateDate.rows[0].rowDeliveryDate, '2026-09-04');
assert.equal(matchingSeparateDate.rows[0].orderDocumentNoError, undefined);

const conflictingSeparateDate = mappedRows([
  ['일자', '일자-No.', '품목코드', '품목명', '수량'],
  ['2026/09/05', '2026/09/04-35', 'A', '상품A', '1']
]);
assert.match(conflictingSeparateDate.rows[0].orderDocumentNoError, /별도 주문일자.*다릅니다/);
assert.equal(groupVoucherRows('order', conflictingSeparateDate.rows, {}).at(0).validationStatus, 'REVIEW_REQUIRED');

const conflictingDueDate = mappedRows([
  ['납품일자', '일자-No.', '품목코드', '품목명', '수량'],
  ['2026/09/05', '2026/09/04-35', 'A', '상품A', '1']
]);
assert.match(conflictingDueDate.rows[0].orderDocumentNoError, /별도 납기일자.*다릅니다/);
assert.equal(groupVoucherRows('order', conflictingDueDate.rows, {}).at(0).validationStatus, 'REVIEW_REQUIRED');

for (const value of ['2026/02/30-1', '2026/09/04-', '2026/09/04-A']) {
  const invalid = mappedRows([
    ['일자-No.', '품목코드', '품목명', '수량'],
    [value, 'A', '상품A', '1']
  ]).rows[0];
  assert.ok(invalid.orderDocumentNoError, `${value} must produce an actionable error`);
  assert.equal(groupVoucherRows('order', [invalid], {}).at(0).validationStatus, 'REVIEW_REQUIRED');
}

const saleSession = createMappingSession({
  matrix: [['일자-No.', '품목명', '수량'], ['2026/09/04-35', '상품A', '1']],
  headerRowIndex: 0,
  targetDefinitions: definitions,
  companyId: 'ONEAPP',
  voucherMode: 'sale'
});
const saleRows = projectMappedRows(saleSession, definitions);
assert.deepEqual(applyOrderDocumentNumberDerivation({ rows: saleRows, session: saleSession, targetDefinitions: definitions }), saleRows,
  'non-order voucher modes must remain unchanged');

console.log('SmartInput order document-number date derivation contracts PASS');
