#!/usr/bin/env node
// SI-MO-F8-UPLOAD-FIX-01: actual module and XLSX round-trip regression.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildEstimateF8Data, buildEstimateDuplicateGroups, resolveEstimateDuplicateRows, validateEstimateRows } from '../smartinput/report.js';
import { runStage5Compute } from '../smartinput/report.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = vm.createContext({ console, Date, Math, Number, String, Object, Array, Map, Set, Uint8Array, ArrayBuffer, setTimeout, clearTimeout });
context.window = context; context.self = context; context.globalThis = context;
vm.runInContext(fs.readFileSync(path.join(root, 'customer-master/vendor/xlsx.full.min.js'), 'utf8'), context);
const XLSX = context.XLSX;
const evidenceDir = process.env.SMARTINPUT_F8_EVIDENCE_DIR;
if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });
const results = [];
const base = (code, extra = {}) => ({ rowId: `R-${code}`, itemCode: code, itemName: `상품 ${code}`, specification: 'EA', inboundPrice: 1000, outPrice: 1500, marketPrice: 1500, ...extra });
const blank = () => ({ rowId: 'BLANK', itemCode: ' ', itemName: '\t', outPrice: 0, quantity: 0 });
const parent = base('104022113', { inboundPrice: 44000, outPrice: 55000, marketPrice: 55000, type1Code: '104022114', type1Operation: 10, type1Specification: '100g' });
const sub = base('104022114', { itemName: '파세리_100g', inboundPrice: 0, outPrice: 0, marketPrice: 0, wholesaleA: 0, brand: '보존브랜드', productDescription: '보존설명', theme2: '1', searchInfo: '보존태그', purchasePriceB: 0, wholesaleB: 4300 });

function roundTrip(label, output) {
  const wb = XLSX.utils.book_new();
  for (const [name, data] of [['쇼핑몰업로드', output.shopData], ['ERP업데이트', output.erpData], ['견적서 업로드', output.estimateUploadData]]) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), name);
  }
  const bytes = Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
  if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, `${label}.xlsx`), bytes);
  const reopened = XLSX.read(new Uint8Array(bytes), { type: 'array' });
  const shop = reopened.Sheets['쇼핑몰업로드'];
  const erp = reopened.Sheets['ERP업데이트'];
  const matrix = sheet => JSON.parse(JSON.stringify(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })));
  assert.deepEqual(matrix(shop), output.shopData, `${label}: shop values and types`);
  assert.deepEqual(matrix(erp), output.erpData, `${label}: ERP values and types`);
  assert.ok(matrix(erp).every(row => row.length === 11), `${label}: every ERP row is 11 columns`);
  assert.equal(XLSX.utils.decode_range(erp['!ref']).e.c, 10);
  assert.ok(Object.keys(erp).filter(key => !key.startsWith('!')).every(key => XLSX.utils.decode_cell(key).c < 11));
  return { shop, erp };
}

async function verify(label, run) {
  await run(); results.push(label); console.log(`PASS ${label}`);
}

await verify('S01-existing-subdivision', () => {
  const rows = [parent, sub]; const original = structuredClone(rows);
  const output = buildEstimateF8Data(rows);
  assert.equal(output.ok, true);
  assert.equal(output.shopData.length, 3);
  assert.deepEqual(output.shopData[2].slice(3, 6), [5500, 5500, 5500]);
  assert.equal(output.shopData[2][14], '1'); assert.equal(output.shopData[2][15], 999);
  assert.deepEqual([output.erpData[2][1], output.erpData[2][3]], [4400, 5500]);
  const untouched = buildEstimateF8Data([sub]).shopData[1];
  for (const index of [0, 1, 2, 6, 7, 12, 13, 16, 17, 18, 19, 20, 21]) assert.equal(output.shopData[2][index], untouched[index]);
  assert.equal(output.erpData[2][5], 0); assert.equal(output.erpData[2][9], 4300);
  assert.deepEqual(rows, original, 'output must not mutate the draft');
  const reopened = roundTrip('S01-existing-subdivision', output);
  assert.equal(reopened.shop.O3.t, 's'); assert.equal(reopened.shop.O3.v, '1');
  assert.equal(reopened.shop.P3.t, 'n'); assert.equal(reopened.shop.P3.v, 999);
  assert.equal(reopened.shop.R3.t, 's'); assert.equal(reopened.shop.R3.v, '1');
});

await verify('S02-new-subdivision', () => {
  const catalog = [{ itemCode: '104022114', itemName: '파세리_100g', specification: '100g' }];
  const saved = structuredClone(catalog);
  const output = buildEstimateF8Data([parent], { productCatalog: catalog });
  assert.equal(output.ok, true); assert.equal(output.shopData[2][14], '1');
  assert.equal(output.shopData[2][15], 999); assert.deepEqual(catalog, saved);
  roundTrip('S02-new-subdivision', output);
});

await verify('S03-nonpositive-subdivision', () => {
  for (const change of [{ inboundPrice: 0 }, { outPrice: 0 }, { type1Operation: 0 }, { inboundPrice: -1 }]) {
    const output = buildEstimateF8Data([{ ...parent, ...change }, sub]);
    assert.equal(output.ok, true); assert.equal(output.shopData[2][14], '0');
    assert.equal(output.shopData[2][3], 0); assert.equal(output.shopData.length, 3);
  }
});

await verify('B01-blank-first-middle-last', () => {
  for (const rows of [[blank(), base('0007')], [base('0007'), blank()], [blank(), base('0007'), blank()]]) {
    const original = structuredClone(rows); const output = buildEstimateF8Data(rows);
    assert.equal(output.ok, true); assert.equal(output.shopData.length, 2); assert.equal(output.erpData.length, 2);
    assert.equal(output.estimateUploadData.length, 2); assert.deepEqual(rows, original);
  }
  roundTrip('B01-blank-first-middle-last', buildEstimateF8Data([blank(), base('0007'), blank()]));
});

await verify('B02-code-required-and-B04-empty', () => {
  const named = buildEstimateF8Data([blank(), base('', { itemName: '코드 미지정' })]);
  assert.equal(named.ok, false); assert.ok(named.errors.some(error => error.code === 'ITEM_CODE_REQUIRED' && error.rowIndex === 1));
  for (const rows of [[], [blank()], [blank(), blank()]]) {
    const output = buildEstimateF8Data(rows); assert.equal(output.ok, false);
    assert.ok(output.errors.some(error => error.code === 'EMPTY')); assert.equal(output.outputRowCount, 0);
    assert.equal(output.erpData.length, 1);
  }
});

await verify('B03-B05-duplicate-original-identity', () => {
  const rows = [blank(), base('0007', { rowId: 'FIRST', rowCustomerName: 'A', inboundPrice: 1000 }), blank(), base('0007', { rowId: 'SELECTED', rowCustomerName: 'B', inboundPrice: 3000, estimateF8SourceRowNumber: 88 }), blank()];
  const frozen = structuredClone(rows);
  const groups = buildEstimateDuplicateGroups(rows);
  assert.deepEqual(groups[0].candidates.map(candidate => candidate.rowIndex), [1, 3]);
  assert.equal(groups[0].candidates[1].candidateId, '0007:3'); assert.equal(groups[0].candidates[1].sourceRowNumber, 88);
  const options = { duplicateResolutions: new Map([['0007', { rowIndex: 3, inboundPrice: 4000 }]]), marginRules: [{ id: 'test', whCode: '*', unit: '*', rate: 20, type: 'divide' }] };
  const resolved = resolveEstimateDuplicateRows(rows, options.duplicateResolutions);
  assert.equal(resolved.rows.length, 1); assert.equal(resolved.rows[0].rowId, 'SELECTED');
  assert.ok(resolved.selectedRowsByIndex.has(3)); assert.ok(!resolved.selectedRowsByIndex.has(1));
  assert.deepEqual(validateEstimateRows(rows).entries.map(entry => entry.rowIndex), [1, 3]);
  const output = buildEstimateF8Data(rows, options); assert.equal(output.ok, true);
  assert.equal(output.erpData.length, 2); assert.equal(output.erpData[1][1], 4000); assert.equal(output.erpData[1][3], 5000);
  assert.equal(output.estimateUploadData.length, 3, 'both customer transactions survive');
  assert.deepEqual(output.estimateUploadData.slice(1).map(row => row[3]), ['A', 'B']);
  assert.deepEqual(rows, frozen); roundTrip('B03-duplicate-original-index', output);
});

await verify('B06-source-owned-blank-and-code', () => {
  const emptySource = { ...base('STALE'), estimateF8SourceOnly: true, estimateF8SourceFields: { '품목코드': { currentDisplayValue: '' }, '품목명': { currentDisplayValue: '' } } };
  const realSource = { ...emptySource, estimateF8SourceFields: { '품목코드': { currentDisplayValue: '0009' }, '품목명': { currentDisplayValue: '원본상품' }, '출고가': { currentDisplayValue: '0', parsedValue: 0 } } };
  const output = buildEstimateF8Data([emptySource, realSource]);
  assert.equal(output.ok, true); assert.equal(output.shopData.length, 2); assert.equal(output.shopData[1][0], '0009');
});

await verify('E01-E04-E06-ERP11-promo-zero-blank', () => {
  const output = buildEstimateF8Data([base('0007', { inboundPrice: 0, purchasePriceB: '', wholesaleA: 0, wholesaleB: '', promoPrice: 1200 })]);
  assert.equal(output.shopData[1][3], 1200); assert.equal(output.erpData[1][3], 1500);
  const { erp } = roundTrip('E01-ERP11-promo-zero-blank', output);
  assert.equal(erp.A2.t, 's'); assert.equal(erp.A2.v, '0007'); assert.equal(erp.B2.t, 'n'); assert.equal(erp.B2.v, 0);
  assert.equal(erp.F2.v, ''); assert.equal(erp.C2.t, 's'); assert.equal(erp.C2.v, '0');
});

await verify('W01-real-worker-and-fallback-parity', async () => {
  const previousSelf = globalThis.self; const scope = { postMessage() {} }; globalThis.self = scope;
  try {
    await import('../smartinput/stage5-compute-worker.js');
    const rows = [blank(), parent, blank(), sub, ...Array.from({ length: 510 }, (_, index) => base(`W-${index}`)), blank()];
    const handler = scope.onmessage;
    class InlineWorker {
      postMessage(message) { scope.postMessage = data => queueMicrotask(() => this.onmessage?.({ data })); queueMicrotask(() => handler({ data: message })); }
      terminate() {}
    }
    const expected = buildEstimateF8Data(rows); const metrics = [];
    for (const workerFactory of [() => new InlineWorker(), () => { throw new Error('simulated worker startup failure'); }]) {
      const output = await runStage5Compute({ feature: 'estimate-report', phase: 'ESTIMATE_F8_BUILD', rowCount: rows.length, payload: { rows, options: {}, duplicateResolutionEntries: [] }, direct: () => buildEstimateF8Data(rows), workerFactory, onMetric: metric => metrics.push(metric) });
      assert.deepEqual(output, expected);
    }
    assert.deepEqual(metrics.map(metric => metric.path), ['worker', 'fallback-direct']);
    roundTrip('W01-large-output', expected);
  } finally { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; }
});

if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, 'results.json'), JSON.stringify({ passed: results, failed: [], source: 'actual report.js and actual worker module', scope: 'synthetic regressions, not user 344-product replay' }, null, 2));
console.log(`SmartInput F8 upload contract passed (${results.length} cases).`);
