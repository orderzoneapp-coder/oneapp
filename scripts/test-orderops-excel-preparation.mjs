#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const helper = require('../orderops/excel-preparation.js');
const engine = require('../orderFulfillmentEngine.js');
let checks = 0;
const test = (name, run) => { run(); checks += 1; console.log(`PASS ${name}`); };
const clone = (value) => structuredClone(value);
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const errorCode = (result, code) => {
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === code), `${code}: ${JSON.stringify(result.errors)}`);
};
const header = ['일자', '품목코드', '품목명', '규격', '단위', '수량', '단가', '공급가액', '적요', '적요1', '거래처', '그룹', '원본참고'];
const rawMatrix = freeze([
  ['일별 주문 원본'], header,
  ['2026-09-17', 7, '상품', '', 'EA', 0, 1200, 0, '', '', '거래처', 'G', '유지'],
  ['2026-09-17', '0008', '상품', '', 'EA', '0', 1200, '0', '', '', '거래처', 'G', '유지'],
  ['2026-09-17', '0009', '상품', '', 'EA', '', 1200, '', '', '', '거래처', 'G', '유지'],
  ['2026-09-17', '0010', '상품', '', 'EA', -0.5, 1200, -600, ' 메모 ', '', '거래처', 'G', '유지'],
]);
const displayed = clone(rawMatrix);
displayed[2][1] = '0007';
displayed[2][6] = '1,200';
const displayMatrix = freeze(displayed);
const parsed = engine.parseOrderWorkbook({ rawMatrix, displayMatrix, fileName: '원본.xlsx', sheetName: '주문', fileHash: 'source-hash' });
const draft = helper.createDraft({ kind: 'orders', sheetName: '주문', rawMatrix, displayMatrix, parsed });

test('UMD browser and Node exports share the supported local API', () => {
  assert.equal(helper.VERSION, '1.1.0');
  assert.deepEqual(helper.KINDS, ['orders', 'purchases', 'sales', 'inventory']);
  for (const kind of helper.KINDS) assert.ok(helper.FIELDS[kind].every((field) => typeof field === 'string'));
  assert.deepEqual(helper.REQUIRED_FIELDS.orders, engine.ORDER_REQUIRED_COLUMNS);
  assert.deepEqual(helper.REQUIRED_FIELDS.inventory, engine.INVENTORY_REQUIRED_COLUMNS);
});
const browserContext = vm.createContext({});
vm.runInContext(await readFile(new URL('../orderops/excel-preparation.js', import.meta.url), 'utf8'), browserContext);
test('UMD exposes OrderOpsExcelPreparation without CommonJS or browser services', () => {
  assert.equal(browserContext.OrderOpsExcelPreparation.VERSION, helper.VERSION);
  assert.equal(typeof browserContext.OrderOpsExcelPreparation.applyDraft, 'function');
});

test('draft honors engine header coordinates, canonical mappings and source metadata', () => {
  assert.equal(draft.headerRow, 2);
  assert.equal(draft.startRow, 3);
  assert.equal(draft.endRow, 6);
  assert.equal(draft.columns[1].sourceIndex, 1);
  assert.equal(draft.columns[1].target, '품목코드');
  assert.equal(draft.columns[12].enabled, false);
  assert.deepEqual(draft.sourceMetadata, { fileName: '원본.xlsx', fileHash: 'source-hash', sheetName: '주문' });
  assert.equal(helper.validateDraft({ draft, rawMatrix, displayMatrix }).ok, true);
});

test('apply preserves numeric zero, string zero, blank, negative decimal and formatted code separately', () => {
  const applied = helper.applyDraft({ rawMatrix, displayMatrix, draft });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.rawMatrix.slice(2).map((row) => row[5]), [0, '0', '', -0.5]);
  assert.equal(applied.rawMatrix[2][1], 7);
  assert.equal(applied.displayMatrix[2][1], '0007');
  assert.equal(applied.rawMatrix[2][6], 1200);
  assert.equal(applied.displayMatrix[2][6], '1,200');
  assert.equal(applied.rawMatrix[5][8], ' 메모 ');
  assert.equal(applied.rawMatrix[1][12], '');
  assert.equal(applied.originalRawMatrix[1][12], '원본참고');
  assert.equal(applied.rawMatrix[2][12], '유지', 'excluding a column must not delete its original cells');
  assert.deepEqual(applied.originalRawMatrix, rawMatrix);
  assert.deepEqual(applied.originalDisplayMatrix, displayMatrix);
  applied.rawMatrix[2][5] = 999;
  applied.originalRawMatrix[2][1] = 999;
  assert.equal(rawMatrix[2][5], 0);
  assert.equal(rawMatrix[2][1], 7);
  assert.equal(applied.originalDisplayMatrix[2][1], '0007');
});

test('range filtering keeps original row coordinates and all source evidence', () => {
  const selected = { ...clone(draft), startRow: 4, endRow: 5 };
  const applied = helper.applyDraft({ rawMatrix, displayMatrix, draft: selected });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.rawMatrix[0], []);
  assert.deepEqual(applied.rawMatrix[2], []);
  assert.deepEqual(applied.rawMatrix[5], []);
  assert.deepEqual(applied.rawMatrix[3], rawMatrix[3]);
  assert.deepEqual(applied.sourceMetadata.sourceRowNumbers, [4, 5]);
  assert.deepEqual(applied.originalRawMatrix, rawMatrix);
  assert.deepEqual(applied.sourceMetadata.columns, selected.columns);
});

for (const range of [{ headerRow: 0 }, { startRow: 2 }, { endRow: 7 }, { startRow: 6, endRow: 5 }, { startRow: 3.5 }]) {
  test(`invalid row range is rejected: ${JSON.stringify(range)}`, () => errorCode(helper.applyDraft({ rawMatrix, displayMatrix, draft: { ...clone(draft), ...range } }), 'INVALID_ROW_RANGE'));
}

test('header-row changes require re-deriving source columns, not silently reusing coordinates', () => {
  errorCode(helper.applyDraft({ rawMatrix, displayMatrix, draft: { ...clone(draft), headerRow: 1 } }), 'SOURCE_HEADER_CHANGED');
  const selected = helper.createDraft({ kind: 'orders', rawMatrix, displayMatrix, parsed: { headerRowIndex: 1 } });
  assert.equal(selected.columns[1].target, '품목코드');
});

test('missing required, duplicate target, invalid target and duplicate source positions fail closed', () => {
  const missing = clone(draft);
  missing.columns[1].enabled = false;
  errorCode(helper.validateDraft({ draft: missing }), 'MISSING_REQUIRED_FIELD');
  const duplicate = clone(draft);
  duplicate.columns[12] = { ...duplicate.columns[12], enabled: true, target: '수량' };
  errorCode(helper.validateDraft({ draft: duplicate }), 'DUPLICATE_TARGET');
  duplicate.columns[12].target = '지원하지않는필드';
  errorCode(helper.validateDraft({ draft: duplicate }), 'INVALID_TARGET');
  duplicate.columns[12].sourceIndex = 1;
  errorCode(helper.validateDraft({ draft: duplicate }), 'INVALID_SOURCE_COLUMN');
  duplicate.columns[12].sourceIndex = 1000000;
  errorCode(helper.validateDraft({ draft: duplicate }), 'INVALID_SOURCE_COLUMN');
});

test('raw/display coordinate mismatch and malformed matrices are rejected without source mutation', () => {
  errorCode(helper.applyDraft({ draft }), 'INVALID_MATRIX');
  errorCode(helper.applyDraft({ rawMatrix, displayMatrix: displayMatrix.slice(1), draft }), 'MATRIX_ROW_MISMATCH');
  errorCode(helper.applyDraft({ rawMatrix: ['not-a-row'], displayMatrix: [[]], draft }), 'INVALID_MATRIX');
  assert.throws(() => helper.createDraft({ kind: 'ledger', rawMatrix, displayMatrix }), TypeError);
});

const inventoryRaw = freeze([
  ['상품코드', '품명', '규격', '단위', '수량', '1창고', '신선A', '본사', '창고단가', '메모'],
  ['0007', '상품', '', 'EA', 12, 2, 4, 6, 1200, '유지'],
]);
const inventoryParsed = engine.parseInventoryWorkbook({ rawMatrix: inventoryRaw, displayMatrix: inventoryRaw });
const inventoryDraft = helper.createDraft({ kind: 'inventory', rawMatrix: inventoryRaw, parsed: inventoryParsed });
test('inventory uses engine warehouse descriptors rather than warehouse-name guessing', () => {
  assert.deepEqual(inventoryDraft.columns.filter((column) => column.target === helper.WAREHOUSE_TARGET).map((column) => column.sourceHeader), ['1창고', '신선A', '본사']);
  assert.notEqual(inventoryDraft.columns[8].target, helper.WAREHOUSE_TARGET);
  assert.notEqual(inventoryDraft.columns[9].target, helper.WAREHOUSE_TARGET);
  const applied = helper.applyDraft({ rawMatrix: inventoryRaw, draft: inventoryDraft });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.rawMatrix[1], inventoryRaw[1]);
  assert.deepEqual(applied.rawMatrix[0].slice(5, 8), ['1창고', '신선A', '본사']);
  assert.equal(applied.rawMatrix[1][4], 12);
  assert.equal(applied.rawMatrix[1][8], 1200);
});

test('explicit unnamed-pattern warehouse assignment is allowed; unnamed/duplicate warehouse labels are not', () => {
  const changed = clone(inventoryDraft);
  changed.columns[6].target = helper.WAREHOUSE_TARGET;
  changed.columns[6].warehouseName = '냉장실';
  assert.equal(helper.applyDraft({ rawMatrix: inventoryRaw, draft: changed }).rawMatrix[0][6], '냉장실');
  changed.columns[6].warehouseName = '1창고';
  errorCode(helper.validateDraft({ draft: changed }), 'AMBIGUOUS_WAREHOUSE');
  changed.columns[6].warehouseName = '';
  errorCode(helper.validateDraft({ draft: changed }), 'AMBIGUOUS_WAREHOUSE');
  changed.columns.forEach((column) => { if (column.target === helper.WAREHOUSE_TARGET) column.enabled = false; });
  errorCode(helper.validateDraft({ draft: changed }), 'MISSING_WAREHOUSE');
});

for (const [kind, partner, quantity] of [['purchases', '공급처', '구매수량'], ['sales', '판매처', '판매수량']]) {
  test(`${kind} generic parser aliases and optional unit/spec fields remain distinct`, () => {
    const matrix = [['상품코드', '품명', quantity, partner, 'spec', 'unit'], ['0001', '상품', -2, '거래상대', '', 'EA']];
    const generic = helper.createDraft({ kind, rawMatrix: matrix, parsed: { headerRowIndex: 0 } });
    assert.equal(helper.validateDraft({ draft: generic }).ok, true);
    assert.equal(generic.columns[3].target, kind === 'purchases' ? '구매처' : '거래처');
    assert.equal(generic.columns[4].target, '규격');
    assert.equal(generic.columns[5].target, '단위');
    assert.equal(helper.applyDraft({ rawMatrix: matrix, draft: generic }).rawMatrix[1][2], -2);
  });
}

test('custom aliases work but a conflicting alias is not silently assigned to the last field', () => {
  const matrix = [['식별값', '품명', '수량', '구매처'], ['0001', '상품', 0, '공급처']];
  const custom = { kind: 'purchases', rawMatrix: matrix, headerAliases: { '품목코드': ['식별값'] } };
  assert.equal(helper.createDraft(custom).columns[0].target, '품목코드');
  const ambiguous = helper.createDraft({ ...custom, headerAliases: { '품목코드': ['식별값'], '품목명': ['식별값'] } });
  assert.equal(ambiguous.columns[0].enabled, false);
  errorCode(helper.validateDraft({ draft: ambiguous }), 'MISSING_REQUIRED_FIELD');
});

const saved = helper.createTemplate({ name: '일일 주문 양식', draft });
test('template is configuration only and does not contain file data or overwrite the draft', () => {
  assert.equal(saved.ok, true);
  assert.equal(saved.template.schemaVersion, 'orderops-excel-template/v2');
  assert.equal(saved.template.rangePolicy.footerRowCount, 0, 'the default full-file range must remain full-file on the next date');
  assert.equal(saved.template.endRow, undefined, 'v2 must not persist an absolute end row');
  assert.equal(saved.template.fileName, undefined);
  assert.equal(saved.template.rawMatrix, undefined);
  assert.equal(saved.template.sourceMetadata, undefined);
  const separate = helper.createTemplate({ name: '분리', draft });
  separate.template.columns[1].target = '';
  assert.equal(draft.columns[1].target, '품목코드');
  errorCode(helper.createTemplate({ name: ' ', draft }), 'TEMPLATE_NAME_REQUIRED');
});

test('reordered columns and shifted title rows reuse a unique header structure, with new source evidence', () => {
  const permutation = header.map((_, index) => header.length - index - 1);
  const reordered = [[], ['다음 날짜'], permutation.map((index) => header[index]), ...rawMatrix.slice(2).map((row) => permutation.map((index) => row[index])), permutation.map((index) => rawMatrix[2][index])];
  const matched = helper.matchTemplate({ template: saved.template, kind: 'orders', sheetName: '다음주문', rawMatrix: reordered, parsed: { fileName: '다음날.xlsx', fileHash: 'next-hash' } });
  assert.equal(matched.ok, true);
  assert.equal(matched.draft.headerRow, 3);
  assert.equal(matched.draft.startRow, 4);
  assert.equal(matched.draft.endRow, reordered.length);
  assert.equal(matched.draft.columns.find((column) => column.target === '품목코드').sourceIndex, header.length - 2);
  assert.equal(matched.draft.sourceMetadata.fileHash, 'next-hash');
  assert.equal(matched.draft.sourceMetadata.sheetName, '다음주문');
  assert.equal(helper.applyDraft({ rawMatrix: reordered, draft: matched.draft }).ok, true);
});

test('104→103 is saved as one footer row and a 160-row file applies through row 159', () => {
  const makeDataRow = (index) => ['2026-09-17', String(index).padStart(4, '0'), `상품${index}`, '', 'EA', 1, 1200, 1200, '', '', '거래처', 'G', '유지'];
  const original = [['주문 원본'], header, ...Array.from({ length: 101 }, (_, index) => makeDataRow(index + 1)), ['생성일', '2026-09-18']];
  assert.equal(original.length, 104);
  const originalDraft = helper.createDraft({ kind: 'orders', rawMatrix: original, parsed: { headerRowIndex: 1 } });
  originalDraft.endRow = 103;
  const bounded = helper.createTemplate({ name: '하단 날짜 제외', draft: originalDraft, rawMatrix: original });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.template.rangePolicy.footerRowCount, 1);
  assert.equal(bounded.template.endRow, undefined);
  const next = [['다음 주문'], header, ...Array.from({ length: 157 }, (_, index) => makeDataRow(index + 1)), ['생성일', '2026-09-19']];
  assert.equal(next.length, 160);
  const matched = helper.matchTemplate({ template: bounded.template, kind: 'orders', rawMatrix: next });
  assert.equal(matched.ok, true);
  assert.equal(matched.draft.startRow, 3);
  assert.equal(matched.draft.endRow, 159);
  const applied = helper.applyDraft({ rawMatrix: next, draft: matched.draft });
  assert.equal(applied.ok, true);
  assert.equal(applied.sourceMetadata.sourceRowNumbers.length, 157);
  assert.equal(applied.sourceMetadata.sourceRowNumbers.at(-1), 159);
});

test('relative footer rules support shorter files, two footer rows, and ignore trailing formatted blanks', () => {
  const makeDataRow = (index) => ['2026-09-17', String(index).padStart(4, '0'), `상품${index}`, '', 'EA', 1, 1200, 1200, '', '', '거래처', 'G', '유지'];
  const original = [['주문 원본'], header, ...Array.from({ length: 5 }, (_, index) => makeDataRow(index + 1)), ['합계', 5], ['생성일', '2026-09-18']];
  const originalDraft = helper.createDraft({ kind: 'orders', rawMatrix: original, parsed: { headerRowIndex: 1 } });
  originalDraft.endRow = original.length - 2;
  const savedTwo = helper.createTemplate({ name: '하단 2행', draft: originalDraft, rawMatrix: original });
  assert.equal(savedTwo.template.rangePolicy.footerRowCount, 2);
  const shorterContent = [['다음 주문'], header, ...Array.from({ length: 2 }, (_, index) => makeDataRow(index + 1)), ['합계', 2], ['생성일', '2026-09-19']];
  const withTrailingBlanks = [...shorterContent, [], Array(header.length).fill(null)];
  assert.equal(helper.lastContentRow(withTrailingBlanks), shorterContent.length);
  const matched = helper.matchTemplate({ template: savedTwo.template, kind: 'orders', rawMatrix: withTrailingBlanks });
  assert.equal(matched.ok, true);
  assert.equal(matched.draft.endRow, 4);
});

test('orders, purchases, sales and inventory all retain every next-file data row before the verified footer', () => {
  const fixtures = {
    orders: {
      header,
      row: (index) => ['2026-09-17', String(index).padStart(4, '0'), `주문상품${index}`, '', 'EA', index, 100, index * 100, '', '', '주문처', 'G', ''],
      parsed: { headerRowIndex: 1 }, quantityIndex: 5,
    },
    purchases: {
      header: ['품목코드', '품목명', '수량', '구매처'], row: (index) => [String(index).padStart(4, '0'), `구매상품${index}`, index, '구매처'],
      parsed: { headerRowIndex: 1 }, quantityIndex: 2,
    },
    sales: {
      header: ['품목코드', '품목명', '수량', '거래처'], row: (index) => [String(index).padStart(4, '0'), `판매상품${index}`, index, '판매처'],
      parsed: { headerRowIndex: 1 }, quantityIndex: 2,
    },
    inventory: {
      header: ['품목코드', '품목명', '규격', '단위', '수량', '1창고'], row: (index) => [String(index).padStart(4, '0'), `재고상품${index}`, '', 'EA', index, index],
      quantityIndex: 4,
    },
  };
  for (const [kind, fixture] of Object.entries(fixtures)) {
    const original = [['보고서'], fixture.header, fixture.row(1), fixture.row(2), ['생성일', '2026-09-18']];
    const parsed = kind === 'inventory' ? engine.parseInventoryWorkbook({ rawMatrix: original, headerRowIndex: 1 }) : fixture.parsed;
    const originalDraft = helper.createDraft({ kind, rawMatrix: original, parsed });
    originalDraft.endRow = 4;
    const template = helper.createTemplate({ name: `${kind} 하단 제외`, draft: originalDraft, rawMatrix: original }).template;
    const next = [['다음 보고서'], fixture.header, fixture.row(1), fixture.row(2), fixture.row(3), ['생성일', '2026-09-19']];
    const matched = helper.matchTemplate({ template, kind, rawMatrix: next });
    assert.equal(matched.ok, true, kind);
    assert.equal(matched.draft.endRow, 5, kind);
    const applied = helper.applyDraft({ rawMatrix: next, draft: matched.draft });
    assert.deepEqual(applied.sourceMetadata.sourceRowNumbers, [3, 4, 5], kind);
    assert.equal(applied.rawMatrix.slice(2, 5).reduce((sum, row) => sum + Number(row[fixture.quantityIndex]), 0), 6, kind);
  }
});

test('changed, missing, extra or product-shaped footer rows require review instead of auto-apply', () => {
  const dataRow = ['2026-09-17', '0001', '상품', '', 'EA', 1, 1200, 1200, '', '', '거래처', 'G', '유지'];
  const original = [['주문 원본'], header, dataRow, ['생성일', '2026-09-18']];
  const originalDraft = helper.createDraft({ kind: 'orders', rawMatrix: original, parsed: { headerRowIndex: 1 } });
  originalDraft.endRow = 3;
  const template = helper.createTemplate({ name: '날짜행', draft: originalDraft, rawMatrix: original }).template;
  const changed = [['주문 원본'], header, dataRow, ['승인자', '관리자']];
  const missing = [['주문 원본'], header, dataRow];
  const extra = [['주문 원본'], header, dataRow, ['합계', 1], ['생성일', '2026-09-19']];
  const productAtEnd = [['주문 원본'], header, dataRow, [...dataRow]];
  for (const matrix of [changed, missing, extra, productAtEnd]) {
    const result = helper.matchTemplate({ template, kind: 'orders', rawMatrix: matrix });
    assert.equal(result.ok, false);
    assert.equal(result.requiresReview, true);
    assert.equal(result.draft.rangeReviewRequired, true);
  }
  const excludesProduct = helper.createDraft({ kind: 'orders', rawMatrix: productAtEnd, parsed: { headerRowIndex: 1 } });
  excludesProduct.endRow = 3;
  errorCode(helper.createTemplate({ name: '상품 누락 금지', draft: excludesProduct, rawMatrix: productAtEnd }), 'FOOTER_CONTAINS_BUSINESS_DATA');
});

test('legacy full-file templates remain usable but a numeric legacy end row requires one-time review', () => {
  const legacyFull = { ...clone(saved.template), schemaVersion: 'orderops-excel-template/v1', endRow: null };
  delete legacyFull.rangePolicy;
  assert.equal(helper.matchTemplate({ template: legacyFull, kind: 'orders', rawMatrix }).ok, true);
  const legacyBounded = { ...legacyFull, endRow: 5 };
  const review = helper.matchTemplate({ template: legacyBounded, kind: 'orders', rawMatrix });
  assert.equal(review.ok, false);
  assert.equal(review.requiresReview, true);
  assert.equal(review.draft.endRow, 5);
  errorCode(review, 'LEGACY_END_RANGE_REVIEW_REQUIRED');
});

test('templates reject kind mismatch, changed structure, duplicate header rows and malformed saved columns', () => {
  errorCode(helper.matchTemplate({ template: saved.template, kind: 'sales', rawMatrix }), 'TEMPLATE_KIND_MISMATCH');
  const changed = clone(rawMatrix); changed[1][1] = '다른코드';
  errorCode(helper.matchTemplate({ template: saved.template, kind: 'orders', rawMatrix: changed }), 'TEMPLATE_STRUCTURE_MISMATCH');
  errorCode(helper.matchTemplate({ template: saved.template, kind: 'orders', rawMatrix: [...clone(rawMatrix), [...header]] }), 'AMBIGUOUS_HEADER_ROWS');
  errorCode(helper.matchTemplate({ template: { ...saved.template, columns: [null] }, kind: 'orders', rawMatrix }), 'TEMPLATE_KIND_MISMATCH');
});

test('same-name source columns remain position-addressable in a draft but cannot auto-match a template', () => {
  const duplicate = clone(draft);
  duplicate.columns[12].sourceHeader = duplicate.columns[8].sourceHeader;
  assert.equal(helper.validateDraft({ draft: duplicate }).ok, true, 'excluded duplicate names can be edited independently by position');
  errorCode(helper.createTemplate({ name: '모호한 양식', draft: duplicate }), 'AMBIGUOUS_TEMPLATE_HEADERS');
  const invalidTemplate = { ...saved.template, columns: duplicate.columns };
  errorCode(helper.matchTemplate({ template: invalidTemplate, kind: 'orders', rawMatrix }), 'AMBIGUOUS_TEMPLATE_HEADERS');
});

const manualWarehouseRaw = freeze([
  ['품목코드', '품목명', '규격', '본사', '수량', '1창고', '창고단가', '신선A', '단위'],
  ['0007', '상품', '', 6, 12, 2, 1200, 4, 'EA'],
]);
const unmappedInventory = engine.parseInventoryWorkbook({ rawMatrix: manualWarehouseRaw });
const manualWarehouseDraft = helper.createDraft({ kind: 'inventory', rawMatrix: manualWarehouseRaw, parsed: unmappedInventory });
for (const sourceIndex of [3, 7]) Object.assign(manualWarehouseDraft.columns[sourceIndex], { target: helper.WAREHOUSE_TARGET, enabled: true });
const projectedWarehouse = helper.applyDraft({ rawMatrix: manualWarehouseRaw, draft: manualWarehouseDraft });
const manuallyParsedInventory = engine.parseInventoryWorkbook({ ...projectedWarehouse, columnMappings: projectedWarehouse.columns });

test('explicit warehouse quantities before total and after price use original names and positions', () => {
  assert.equal(projectedWarehouse.ok, true);
  assert.deepEqual(manuallyParsedInventory.errors, []);
  assert.equal(manuallyParsedInventory.rows[0].inventoryTotal, 12);
  assert.equal(manuallyParsedInventory.rows[0].wholeStockRaw, 2, 'new warehouses must not become the first allocation warehouse');
  assert.deepEqual(manuallyParsedInventory.columns.filter((column) => column.role === 'warehouseQuantity').map(({ sourceIndex, header }) => ({ sourceIndex, header })), [
    { sourceIndex: 3, header: '본사' }, { sourceIndex: 5, header: '1창고' }, { sourceIndex: 7, header: '신선A' },
  ]);
  assert.equal(manuallyParsedInventory.columns.find((column) => column.sourceIndex === 6).role, 'warehousePrice');
  assert.deepEqual(projectedWarehouse.originalRawMatrix, manualWarehouseRaw);
});

test('omitting mappings retains the existing default inference and total validation', () => {
  assert.ok(unmappedInventory.errors.some((error) => error.code === 'INVENTORY_TOTAL_MISMATCH'));
  assert.deepEqual(unmappedInventory.columns.filter((column) => column.role === 'warehouseQuantity').map((column) => column.header), ['1창고']);
  assert.deepEqual(engine.parseInventoryWorkbook({ rawMatrix: inventoryRaw, columnMappings: [] }), inventoryParsed);
});

for (const mappings of [
  'not-an-array',
  [{ sourceIndex: -1, target: 'warehouseQuantity', enabled: true }],
  [{ sourceIndex: 99, target: 'warehouseQuantity', enabled: true }],
  [{ sourceIndex: 3, target: 'warehouseQuantity', enabled: true }, { sourceIndex: 3, target: '', enabled: false }],
  [{ sourceIndex: 4, target: 'warehouseQuantity', enabled: true }],
  [{ sourceIndex: 0, target: 'warehouseQuantity', enabled: true }],
  [{ sourceIndex: 8, target: 'warehouseQuantity', enabled: true }],
  [{ sourceIndex: 3, target: '수량', enabled: true }, { sourceIndex: 7, target: '수량', enabled: true }],
  [{ sourceIndex: 3, target: 'unsupported', enabled: true }],
]) {
  test(`invalid inventory mappings reject rows: ${JSON.stringify(mappings)}`, () => {
    const rejected = engine.parseInventoryWorkbook({ rawMatrix: manualWarehouseRaw, columnMappings: mappings });
    assert.ok(rejected.errors.some((error) => error.code === 'INVENTORY_COLUMN_MAPPING_INVALID'));
    assert.deepEqual(rejected.rows, []);
  });
}

test('validated warehouse mapping survives analyze, repeated recalculation, descriptors and source evidence', () => {
  const orderMatrix = [[...header], [...displayMatrix[2]]];
  orderMatrix[1][5] = 2;
  const orders = engine.parseOrderWorkbook({ rawMatrix: orderMatrix });
  assert.deepEqual(orders.errors, []);
  const workspace = engine.analyze(orders, manuallyParsedInventory);
  // The intake UI attaches source evidence after the candidate analysis succeeds.
  const inventoryEvidence = { schemaVersion: 'orderops-intake-mapping/v1', draft: clone(manualWarehouseDraft),
    sourceMetadata: clone(projectedWarehouse.sourceMetadata), originalRawMatrix: clone(manualWarehouseRaw), originalDisplayMatrix: clone(manualWarehouseRaw) };
  const orderEvidence = { schemaVersion: 'orderops-intake-mapping/v1', draft: helper.createDraft({ kind: 'orders', rawMatrix: orderMatrix, parsed: orders }),
    originalRawMatrix: clone(orderMatrix), originalDisplayMatrix: clone(orderMatrix) };
  workspace.sourceFiles.orders.intakeMapping = orderEvidence;
  workspace.sourceFiles.inventory.intakeMapping = inventoryEvidence;
  const expectedWarehouses = ['본사', '1창고', '신선A'];
  assert.deepEqual(engine.getInventoryColumnDescriptors(workspace).filter((column) => column.role === 'warehouseQuantity').map((column) => column.header), expectedWarehouses);
  const recalculated = engine.recalculateWorkspace(engine.recalculateWorkspace(workspace));
  assert.deepEqual(engine.getInventoryColumnDescriptors(recalculated).filter((column) => column.role === 'warehouseQuantity').map((column) => column.header), expectedWarehouses);
  assert.deepEqual(recalculated.sourceFiles.orders.intakeMapping, orderEvidence);
  assert.deepEqual(recalculated.sourceFiles.inventory.intakeMapping, inventoryEvidence);
  assert.notEqual(recalculated.sourceFiles.inventory.intakeMapping, inventoryEvidence);
  assert.equal(engine.getInventoryViewRows(recalculated).rows[0].remainingQuantity, 10);
  assert.equal(recalculated.inventory[0].wholeStockRaw, 2);
  assert.deepEqual(recalculated.sourceFiles.inventory.matrix, manuallyParsedInventory.sourceMatrix);
});

test('stored descriptor roles alone and invalid mapping evidence cannot override canonical inference', () => {
  const source = { matrix: clone(manualWarehouseRaw), headerRowIndex: 0, columns: clone(manuallyParsedInventory.columns) };
  const workspace = { sourceFiles: { inventory: source } };
  assert.deepEqual(engine.getInventoryColumnDescriptors(workspace).filter((column) => column.role === 'warehouseQuantity').map((column) => column.header), ['1창고']);
  source.intakeMapping = { schemaVersion: 'orderops-intake-mapping/v1', draft: { schemaVersion: helper.DRAFT_SCHEMA, kind: 'inventory',
    columns: [{ sourceIndex: 4, target: 'warehouseQuantity', enabled: true }] } };
  assert.deepEqual(engine.getInventoryColumnDescriptors(workspace).filter((column) => column.role === 'warehouseQuantity').map((column) => column.header), ['1창고']);
});

const multiplePriceRaw = freeze([
  ['품목코드', '품목명', '규격', '단위', '수량', '1창고', '신선A', '본사', '1창고단가', '2창고단가'],
  ['0007', '상품', '', 'EA', 12, 2, 4, 6, 1200, '2400'],
]);
const multiplePriceParsed = engine.parseInventoryWorkbook({ rawMatrix: multiplePriceRaw });
const multiplePriceDraft = helper.createDraft({ kind: 'inventory', rawMatrix: multiplePriceRaw, parsed: multiplePriceParsed });

test('distinct warehouse price columns retain their labels and values without becoming quantities', () => {
  assert.equal(engine.ENGINE_VERSION, '3.19.5');
  assert.equal(helper.WAREHOUSE_PRICE_TARGET, 'warehousePrice');
  assert.equal(helper.FIELD_LABELS[helper.WAREHOUSE_PRICE_TARGET], '창고 단가');
  assert.equal(helper.FIELDS.orders.includes(helper.WAREHOUSE_PRICE_TARGET), false);
  assert.deepEqual(multiplePriceDraft.columns.filter((column) => column.target === helper.WAREHOUSE_PRICE_TARGET).map((column) => column.sourceHeader), ['1창고단가', '2창고단가']);
  const applied = helper.applyDraft({ rawMatrix: multiplePriceRaw, draft: multiplePriceDraft });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.rawMatrix[0].slice(8), ['1창고단가', '2창고단가']);
  assert.deepEqual(applied.rawMatrix[1].slice(8), [1200, '2400']);
  const result = engine.parseInventoryWorkbook({ ...applied, columnMappings: applied.columns });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].inventoryTotal, 12);
  assert.deepEqual(result.columns.filter((column) => column.role === 'warehousePrice').map((column) => column.header), ['1창고단가', '2창고단가']);
  assert.deepEqual(result.columns.filter((column) => column.role === 'warehouseQuantity').map((column) => column.header), ['1창고', '신선A', '본사']);
  assert.deepEqual(applied.originalRawMatrix, multiplePriceRaw);
});

test('two price columns can be saved and reused after reordering without changing warehouse totals', () => {
  const savedPrices = helper.createTemplate({ name: '복수 창고 단가', draft: multiplePriceDraft });
  assert.equal(savedPrices.ok, true);
  const reordered = multiplePriceRaw.map((row) => [...row].reverse());
  const matched = helper.matchTemplate({ template: savedPrices.template, kind: 'inventory', rawMatrix: reordered });
  assert.equal(matched.ok, true);
  const applied = helper.applyDraft({ rawMatrix: reordered, draft: matched.draft });
  const result = engine.parseInventoryWorkbook({ ...applied, columnMappings: applied.columns });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].inventoryTotal, 12);
  assert.equal(result.rows[0].wholeStockRaw, 2);
  const source = { matrix: result.sourceMatrix, headerRowIndex: result.headerRowIndex, columns: result.columns,
    intakeMapping: { schemaVersion: 'orderops-intake-mapping/v1', draft: matched.draft } };
  assert.deepEqual(engine.getInventoryColumnDescriptors({ sourceFiles: { inventory: source } })
    .filter((column) => column.role === 'warehousePrice').map((column) => column.header), ['2창고단가', '1창고단가']);
  assert.deepEqual(applied.rawMatrix[1].slice(0, 2), ['2400', 1200]);
});

test('duplicate price names and price roles on required fields are rejected; canonical 창고 remains compatible', () => {
  const duplicate = clone(multiplePriceDraft);
  duplicate.columns[9].sourceHeader = duplicate.columns[8].sourceHeader;
  errorCode(helper.validateDraft({ draft: duplicate }), 'AMBIGUOUS_WAREHOUSE_PRICE');
  const rejected = engine.parseInventoryWorkbook({ rawMatrix: multiplePriceRaw,
    columnMappings: [{ sourceIndex: 0, target: helper.WAREHOUSE_PRICE_TARGET, enabled: true }] });
  assert.ok(rejected.errors.some((error) => error.code === 'INVENTORY_COLUMN_MAPPING_INVALID'));
  assert.deepEqual(rejected.rows, []);
  const canonical = clone(multiplePriceRaw);
  canonical[0][8] = '창고';
  const canonicalDraft = helper.createDraft({ kind: 'inventory', rawMatrix: canonical,
    parsed: engine.parseInventoryWorkbook({ rawMatrix: canonical }) });
  assert.equal(canonicalDraft.columns[8].target, '창고');
  assert.equal(canonicalDraft.columns[9].target, helper.WAREHOUSE_PRICE_TARGET);
  assert.equal(helper.applyDraft({ rawMatrix: canonical, draft: canonicalDraft }).ok, true);
});

for (const [kind, parse, matrix] of [
  ['orders', engine.parseOrderWorkbook, [[...header], [...displayMatrix[2]]]],
  ['inventory', engine.parseInventoryWorkbook, inventoryRaw],
]) {
  test(`${kind} explicit header after row 30 works without changing automatic scan limits`, () => {
    const padded = [...Array.from({ length: 35 }, () => ['설명']), ...clone(matrix)];
    const automatic = parse({ rawMatrix: padded });
    assert.notEqual(automatic.headerRowIndex, 35);
    assert.ok(automatic.errors.length > 0);
    const selected = parse({ rawMatrix: padded, headerRowIndex: 35 });
    assert.equal(selected.headerRowIndex, 35);
    assert.equal(selected.headerRowNumber, 36);
    assert.deepEqual(selected.errors, []);
    assert.equal(selected.rows[0].sourceRowNumber, 37);
    assert.deepEqual(parse({ rawMatrix: matrix, headerRowIndex: 0 }), parse({ rawMatrix: matrix }));
    for (const invalid of [-1, 1.5, padded.length, '35', null, NaN]) {
      assert.throws(() => parse({ rawMatrix: padded, headerRowIndex: invalid }), RangeError);
    }
  });
}

// Exercise the real preparation controller and canonical generic parser without a browser.
const uiSource = await readFile(new URL('../orderops/excel-preparation-ui.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../orderops_list.html', import.meta.url), 'utf8');
const extractFunction = (start, end) => {
  const from = pageSource.indexOf(start);
  const to = pageSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `canonical function boundary: ${start}`);
  return pageSource.slice(from, to);
};
const genericParserSource = extractFunction('function parseGenericWorkbookSheet(', 'async function parseGenericExcelFile(');
const candidateValidatorSource = extractFunction('function validateFileCandidate(', 'async function commitInputCandidates(');
function mountPreparation({ workspace = null, templates = [] } = {}) {
  const nodes = new Map();
  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', innerHTML: '', textContent: '', dataset: {}, listeners: {}, attributes: {},
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelectorAll() { return []; },
    });
    return nodes.get(id);
  };
  const workbooks = new Map();
  const mapping = Object.fromEntries(helper.KINDS.map((kind) => [kind, {
    columns: Object.fromEntries(helper.FIELDS[kind].map((field) => [field, []])), sheetAliases: [],
  }]));
  const calls = { read: 0, apply: 0 };
  const context = vm.createContext({
    OrderOpsExcelPreparation: helper, engine, FILE_KIND_LABELS: helper.KIND_LABELS,
    state: { excelMappings: mapping }, DEFAULT_EXCEL_MAPPINGS: mapping,
    normalizeMappingText: (value) => String(value ?? '').replace(/[^\p{L}\p{N}]+/gu, '').toLocaleLowerCase('ko-KR'),
    document: { getElementById: getNode },
    localStorage: { getItem: () => JSON.stringify({ schemaVersion: 'orderops-excel-templates/v1', items: templates }) },
    XLSX: {
      read: (bytes) => workbooks.get(bytes[0]),
      utils: { sheet_to_json: (matrix, options) => options.raw ? clone(matrix) : matrix.map((row) => row.map((cell) => cell == null ? '' : String(cell))) },
    },
  });
  vm.runInContext(`${genericParserSource}\n${candidateValidatorSource}\n${uiSource}`, context);
  const controller = context.OrderOpsExcelPreparationUI.mount({
    isBusy: () => false, sha256: async (bytes) => `hash-${bytes[0]}`, getMappings: () => mapping,
    sheetAliasScore: (name) => name === 'preferred-invalid' ? 2 : 0,
    validate: context.validateFileCandidate, getWorkspace: () => workspace,
    parseSheet: (input) => input.kind === 'orders' ? engine.parseOrderWorkbook(input)
      : input.kind === 'inventory' ? engine.parseInventoryWorkbook(input) : context.parseGenericWorkbookSheet(input),
    applyCandidates: async () => { calls.apply += 1; }, toast() {}, preview() {},
  });
  const file = (name, sheets) => {
    const id = workbooks.size + 1;
    workbooks.set(id, { SheetNames: Object.keys(sheets), Sheets: sheets });
    return { name, async arrayBuffer() { calls.read += 1; return Uint8Array.of(id).buffer; } };
  };
  return { controller, nodes, calls, file, validate: context.validateFileCandidate };
}
const uiTest = async (name, run) => { await run(); checks += 1; console.log(`PASS ${name}`); };

await uiTest('numeric legacy end-row template is surfaced for one-time range review and never auto-applied', async () => {
  const legacy = { ...clone(saved.template), schemaVersion: 'orderops-excel-template/v1', endRow: 5 };
  delete legacy.rangePolicy;
  const fixture = mountPreparation({ templates: [legacy] });
  const file = fixture.file('legacy-bounded.xlsx', { 주문: clone(rawMatrix) });
  const parsed = await fixture.controller.parse(file, 'orders');
  const record = parsed.preparationRecord;
  assert.equal(record.status, 'review');
  assert.equal(record.drafts.주문.rangeReviewRequired, true);
  assert.match(record.error, /고정 끝 행/);
  assert.equal(fixture.nodes.get('prepApplyButton').disabled, true);
  assert.equal(fixture.nodes.get('prepSaveTemplateButton').disabled, true);
  assert.match(fixture.nodes.get('prepRangeRule').textContent, /범위 재확인 필요/);
  assert.equal(fixture.calls.apply, 0);
});

for (const [kind, partner, first, second] of [['purchases', '구매처', 2, 20], ['sales', '거래처', 1, 11]]) {
  await uiTest(`${kind} native duplicate quantities block auto-commit and keep both original columns for repair`, async () => {
    const fixture = mountPreparation();
    const matrix = [['품목코드', '품목명', '수량', '수량', partner], ['0007', '상품', first, second, '거래처A']];
    const file = fixture.file(`${kind}-ambiguous.xlsx`, { 업무: matrix });
    const parsed = await fixture.controller.parse(file, kind);
    assert.ok(parsed.errors.some((error) => error.code === 'DUPLICATE_TARGET' && error.target === '수량'));
    assert.throws(() => fixture.validate(kind, parsed), /수량/);
    const record = parsed.preparationRecord;
    assert.equal(record.status, 'review');
    assert.deepEqual(record.context.sheets.업무.rawMatrix, matrix);
    assert.deepEqual(Array.from(record.drafts.업무.columns.filter((column) => column.target === '수량'), (column) => column.sourceIndex), [2, 3]);
    assert.ok(fixture.nodes.get('prepFileList').innerHTML.includes(file.name));
    assert.equal(fixture.calls.apply, 0);
  });
}

await uiTest('mapping-invalid preferred sheet cannot outrank a valid native sheet or force it into manual review', async () => {
  const fixture = mountPreparation();
  const parsed = await fixture.controller.parse(fixture.file('mixed-sheets.xlsx', {
    'preferred-invalid': [['품목코드', '품목명', '수량', '수량', '구매처'], ['0007', '상품', 2, 20, '거래처A']],
    정상: [['품목코드', '품목명', '수량', '구매처'], ['0007', '상품', 2, '거래처A']],
  }), 'purchases');
  assert.equal(parsed.sheetName, '정상');
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.preparationRecord.status, 'ready');
  assert.equal(parsed.intakeMapping, undefined, 'normal native data must not be silently converted to a manual mapping');
  assert.equal(parsed.rows[0].quantity, 2);
  fixture.validate('purchases', parsed);
});

await uiTest('failed probes retain cached raw/display, selected sheet and draft edits without erasing another file', async () => {
  const fixture = mountPreparation();
  const matrix = [['품목코드', '품목명', '수량', '수량', '구매처'], ['0007', '상품', 0, '0', '거래처A']];
  const firstFile = fixture.file('same-name.xlsx', { 원본: matrix });
  const secondFile = fixture.file('same-name.xlsx', { 원본: matrix });
  const probed = await fixture.controller.parse(firstFile, 'purchases', { probe: true });
  assert.throws(() => fixture.validate('purchases', probed), /수량/);
  probed.preparationRecord.drafts.원본.columns[2].enabled = false;
  probed.preparationRecord.dirty = true;
  const retained = await fixture.controller.retainCandidate(firstFile, { kind: 'purchases', error: new Error('분류 확인 필요') });
  assert.equal(retained, probed.preparationRecord);
  assert.equal(retained.drafts.원본.columns[2].enabled, false);
  assert.equal(retained.context, probed.preparationRecord.context);
  assert.equal(retained.context.sheets.원본.rawMatrix[1][2], 0);
  assert.equal(retained.context.sheets.원본.displayMatrix[1][2], '0');
  const other = await fixture.controller.retainCandidate(secondFile, { kind: 'purchases', error: new Error('두 번째 후보') });
  assert.notEqual(other.id, retained.id);
  assert.equal(fixture.calls.read, 2, 'retain must reuse an already-read File even when probe failed validation');
  const list = fixture.nodes.get('prepFileList').innerHTML;
  assert.ok(list.includes(`data-prep-file="${retained.id}"`) && list.includes(`data-prep-file="${other.id}"`));
  assert.equal(fixture.calls.apply, 0);
});

await uiTest('a valid saved mapping resolves native alias ambiguity without blocking normal automatic readiness', async () => {
  const matrix = [['품목코드', '품목명', '수량', '구매수량', '구매처'], ['0007', '상품', 2, 20, '거래처A']];
  const mapped = helper.createDraft({ kind: 'purchases', sheetName: '구매', rawMatrix: matrix });
  mapped.columns[3].target = '';
  mapped.columns[3].enabled = false;
  const saved = helper.createTemplate({ name: '확정 수량 열', draft: mapped });
  assert.equal(saved.ok, true);
  const fixture = mountPreparation({ templates: [saved.template] });
  const parsed = await fixture.controller.parse(fixture.file('template.xlsx', { 구매: matrix }), 'purchases');
  fixture.validate('purchases', parsed);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.preparationRecord.status, 'ready');
  assert.equal(parsed.rows[0].quantity, 2);
  assert.equal(parsed.preparationRecord.templateName, '확정 수량 열');
  assert.equal(parsed.intakeMapping.originalRawMatrix[1][3], 20);
});

await uiTest('unclassified candidates use the current kind only as an editable initial choice and retain all sheets', async () => {
  const fixture = mountPreparation();
  await fixture.controller.retainCandidate(fixture.file('purchase-review.xlsx', { 후보: [['항목'], [0]] }), { kind: 'purchases' });
  const unclassified = fixture.file('unclassified.xlsx', { 설명: [['설명'], ['원문']], 자료: [['외부코드', '수량'], ['0007', -1]] });
  const retained = await fixture.controller.retainCandidate(unclassified, { error: new Error('종류 확인 필요') });
  assert.equal(retained.kind, 'purchases');
  assert.equal(retained.status, 'review');
  assert.equal(retained.error, '종류 확인 필요');
  assert.deepEqual(Object.keys(retained.drafts), ['설명', '자료']);
  assert.equal(fixture.nodes.get('prepKindSelect').disabled, false);
  assert.equal(fixture.nodes.get('prepSheetSelect').disabled, false);
  assert.equal(fixture.calls.apply, 0);
});

await uiTest('unreadable files remain failed review candidates without applying or hiding another pending file', async () => {
  const fixture = mountPreparation();
  const previous = await fixture.controller.retainCandidate(fixture.file('previous.xlsx', { 자료: [['원문'], [0]] }), { kind: 'orders' });
  const unreadable = { name: 'read-rejected.xlsx', async arrayBuffer() { throw new Error('read rejected'); } };
  const retained = await fixture.controller.retainCandidate(unreadable, { error: new Error('bundle failed') });
  assert.equal(retained.status, 'review');
  assert.equal(retained.context, null);
  assert.match(retained.error, /bundle failed.*read rejected/);
  const list = fixture.nodes.get('prepFileList').innerHTML;
  assert.ok(list.includes(`data-prep-file="${previous.id}"`) && list.includes('read-rejected.xlsx'));
  assert.equal(fixture.calls.apply, 0);
});

await uiTest('restored sources and multiple pending files coexist; only an applied record hides its own kind', async () => {
  const workspace = freeze({
    sourceFiles: { orders: { fileName: 'restored-orders.xlsx', rowCount: 1 }, inventory: { fileName: 'restored-inventory.xlsx', rowCount: 1 } },
    orderOpsInputs: { purchases: { fileName: 'restored-purchases.xlsx', rows: [{}] }, sales: { fileName: 'restored-sales.xlsx', rows: [{}] } },
  });
  const before = JSON.stringify(workspace);
  const fixture = mountPreparation({ workspace });
  const pending = await fixture.controller.retainCandidate(fixture.file('pending.xlsx', { 설명: [['확인'], [1]] }), { kind: 'purchases' });
  let list = fixture.nodes.get('prepFileList').innerHTML;
  for (const kind of helper.KINDS) assert.ok(list.includes(`data-prep-restored-kind="${kind}"`));
  assert.ok(list.includes(`data-prep-file="${pending.id}"`));
  const parsed = await fixture.controller.parse(fixture.file('new-purchases.xlsx', { 구매: [['품목코드', '품목명', '수량', '구매처'], ['0007', '상품', 2, 'A']] }), 'purchases');
  fixture.controller.markApplied(new Map([['purchases', parsed]]));
  list = fixture.nodes.get('prepFileList').innerHTML;
  assert.equal(list.includes('data-prep-restored-kind="purchases"'), false);
  for (const kind of ['orders', 'inventory', 'sales']) assert.ok(list.includes(`data-prep-restored-kind="${kind}"`));
  assert.ok(list.includes(`data-prep-file="${pending.id}"`) && list.includes('new-purchases.xlsx'));
  assert.equal(JSON.stringify(workspace), before);
});

console.log(`PASS ORDER Q Excel preparation: ${checks} deterministic source-preservation/mapping/template checks.`);
