import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const engine = require('../orderFulfillmentEngine.js');
const workbook = require('../orderFulfillmentWorkbook.js');
const response = await fetch('https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js');
assert.equal(response.ok, true);
const source = await response.text();
assert.equal(crypto.createHash('sha256').update(source).digest('hex'), '1c7abf2993ff2cd61e508f9268e9acda0098c9796f3925d2ba0d2579072653e2');
const sandbox = vm.createContext({ console, setTimeout, clearTimeout });
vm.runInContext(source, sandbox);
const XLSX = sandbox.XLSX;
const baselineSource=execFileSync('git',['show','a5eeb19ca3ae104f66c86dc5b6b9b63df501d41c:orderFulfillmentWorkbook.js'],{encoding:'utf8'});
const baselineContext=vm.createContext({module:{exports:{}},require:()=>engine});
vm.runInContext(baselineSource,baselineContext);
const baselineWorkbook=baselineContext.module.exports;

function fixture(stock, { missing = false, unit = 'EA', purchase = '공급처' } = {}) {
  const ordersMatrix = [
    ['일자', '창고', '담당', '단위', '품목코드', '품목명', '규격', '수량', '적요', '적요1', '거래처', '그룹'],
    ['2026-09-12', '3서울', '담당', 'EA', '0001', '합성상품', '규격', 10, ' 일반 ', ' 직원 ', '합성거래처', '주문1'],
  ];
  const inventoryMatrix = [
    ['품목코드', '품목명', '규격', '단위', '수량', '1창고', '3서울', '4전송'],
    [missing ? 'OTHER' : '0001', '합성상품', '규격', unit, stock, stock, 0, 0],
  ];
  const orders = engine.parseOrderWorkbook({ fileName: 'orders.xlsx', sheetName: 'orders', rawMatrix: ordersMatrix, displayMatrix: ordersMatrix });
  const inventory = engine.parseInventoryWorkbook({ fileName: 'inventory.xlsx', sheetName: 'inventory', rawMatrix: inventoryMatrix, displayMatrix: inventoryMatrix });
  const workspace = engine.analyze(orders, inventory, { sourceFingerprint: 'a'.repeat(64) });
  // Model an old calculation persisted in a previously saved workspace. This
  // must never be fixed by mutating the user's active purchaseManagement rows.
  const row = workspace.purchaseManagement.find(item => item.productCode === '0001');
  const legacy = { ...(row || {}), rowType: 'main', productCode: '0001', productName: '합성상품', specification: '규격', inventoryShadow: false, inventoryMatched: !missing, purchaseNeed: 10, purchase };
  workspace.purchaseManagement = [...workspace.purchaseManagement.filter(item => item.productCode !== '0001'), legacy];
  return workspace;
}

for (const [stock, expected] of [[20, []], [4, [6]]]) {
  const workspace = fixture(stock);
  const original = JSON.stringify(workspace);
  const selected = engine.getFinalPurchaseUploadSelection(workspace);
  assert.deepEqual(selected.included.map(row => row.purchaseNeed), expected);
  assert.deepEqual(workbook.getPurchaseUploadRows(workspace).map(row => row.purchaseNeed), expected);
  const sheet = workbook.buildPurchaseUploadSheet(workspace, XLSX);
  const values = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  assert.deepEqual(Array.from(values.slice(1), row => row[11]), expected, 'actual purchase worksheet quantities');
  const full = workbook.buildWorkbook(structuredClone(workspace), XLSX);
  const previous = baselineWorkbook.buildWorkbook(structuredClone(workspace), XLSX);
  assert.equal(JSON.stringify(full.SheetNames),JSON.stringify(previous.SheetNames),'U06-d sheet names/order');
  for(const name of full.SheetNames.filter(name=>name!=='구매업로드')) assert.equal(JSON.stringify(full.Sheets[name]),JSON.stringify(previous.Sheets[name]),'U06-d unchanged non-purchase sheet '+name);
  const beforeSheet=previous.Sheets['구매업로드'];
  for(const key of Object.keys(beforeSheet).filter(key=>/^[A-Z]+1$/.test(key)||['!cols','!margins','!pageSetup'].includes(key))) assert.equal(JSON.stringify(full.Sheets['구매업로드'][key]),JSON.stringify(beforeSheet[key]),'purchase form/header/style '+key);
  if(expected.length) for(const key of Object.keys(beforeSheet).filter(key=>/^[A-Z]+2$/.test(key)&&key!=='L2')) assert.equal(JSON.stringify(full.Sheets['구매업로드'][key]),JSON.stringify(beforeSheet[key]),'purchase other field '+key);
  assert.deepEqual(Array.from(XLSX.utils.sheet_to_json(full.Sheets['구매업로드'], { header: 1, raw: true }).slice(1), row => row[11]), expected);
  assert.deepEqual(Array.from(full.SheetNames), ['전달사항(적요보기)', '주문현황', '재고수불부', '창고별재고', '구매업로드', '판매업로드']);
  assert.equal(JSON.stringify(workspace), original, 'selection and worksheet generation must not mutate input');
}
for (const options of [{ missing: true }, { unit: 'BOX' }, { purchase: '대체' }, { purchase: '소분' }]) {
  const workspace = fixture(4, options);
  const original = JSON.stringify(workspace);
  assert.equal(engine.getFinalPurchaseUploadSelection(workspace).included.length, 0, JSON.stringify(options));
  assert.equal(workbook.getPurchaseUploadRows(workspace).length, 0);
  assert.equal(XLSX.utils.sheet_to_json(workbook.buildPurchaseUploadSheet(workspace, XLSX), { header: 1 }).length, 1);
  assert.equal(JSON.stringify(workspace), original);
}
const missing = engine.getFinalPurchaseUploadSelection(fixture(4, { missing: true }));
assert.ok(missing.excluded.some(row => /미확인/.test(row.reason)));
const total = fixture(4);
total.inventoryApplicationMode = 'TOTAL_ONLY';
assert.equal(engine.getFinalPurchaseUploadSelection(total).included.length, 0);
const preview=fixture(4);preview.workspaceMode=engine.PREVIEW_WORKSPACE_MODE;assert.equal(engine.getFinalPurchaseUploadSelection(preview).included.length,0,'U06-c preview');
const undated=fixture(4);undated.basisDateStatus='missing';assert.equal(engine.getFinalPurchaseUploadSelection(undated).included.length,0,'U06-c basis date');
console.log('PASS U06: final purchase selection, actual F10 sheet, missing inventory, units, exclusions and 0-write');
