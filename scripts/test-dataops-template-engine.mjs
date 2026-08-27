import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const engine = require('../dataops/template-engine.js');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

assert.equal(engine.CONTRACT_VERSION, 'DATAOPS_TEMPLATE_V1');
assert.equal(engine.DEFAULT_TEMPLATE_ID, 'DATAOPS_DEFAULT_V1');

const defaultTemplate = engine.makeDefaultTemplate();
assert.equal(defaultTemplate.id, 'DATAOPS_DEFAULT_V1');
assert.equal(defaultTemplate.purpose, engine.PURPOSES.STOCK_LEDGER);
assert.equal(defaultTemplate.includeOrderInBalance, false, '재고수불부에서는 주문을 잔량에 포함하지 않아야 한다.');

const customDraft = engine.sanitizeTemplate({
  ...defaultTemplate,
  id: '',
  name: '거래처 미출고 양식',
  builtIn: false,
  purpose: engine.PURPOSES.UNSHIPPED_STATUS,
  includeOrderInBalance: true,
  requiredFieldsByRole: { order: ['code', 'name', 'quantity'] },
  roleMappings: {
    order: {
      code: '상품 번호',
      name: '상품 명칭',
      quantity: '출고 예정 수량',
      price: '계약 단가'
    }
  }
});

const rows = [
  ['2026년 8월 미출고 현황'],
  ['상품 번호', '상품 명칭', '출고 예정 수량', '계약 단가', '전산상 오차'],
  ['A-100', '사과 10kg', 12, 32000, 0]
];
const analysis = engine.analyzeRows(rows, customDraft, 'order', {});
assert.equal(analysis.headerRowIndex, 1);
assert.equal(analysis.blocking, false);
assert.equal(analysis.mappings.find(item => item.fieldKey === 'code').sourceHeader, '상품 번호');
assert.equal(analysis.mappings.find(item => item.fieldKey === 'quantity').sourceHeader, '출고 예정 수량');
assert.deepEqual(analysis.ignoredSystemFields.map(item => item.sourceHeader), ['전산상 오차']);

const missingRequired = engine.analyzeRows([
  ['상품 번호', '상품 명칭'],
  ['A-100', '사과 10kg']
], customDraft, 'order', {});
assert.equal(missingRequired.blocking, true);
assert.equal(missingRequired.errorCode, 'TEMPLATE_REQUIRED_FIELD_MISSING');
assert.deepEqual(missingRequired.missingRequired.map(item => item.fieldKey), ['quantity']);

const legacy = engine.applyAnalysisToLegacyMappings({ code: '품목코드', qty: '수량' }, analysis);
assert.match(legacy.code, /^상품 번호,/);
assert.match(legacy.qty, /^출고 예정 수량,/);

const storage = new MemoryStorage();
const saved = engine.saveTemplate(customDraft, { storage, saveAs: true, activate: true });
assert.notEqual(saved.id, engine.DEFAULT_TEMPLATE_ID);
assert.equal(saved.revision, 1);
assert.equal(engine.getActiveTemplate(storage).id, saved.id);
const updated = engine.saveTemplate({ ...saved, description: '수정본' }, { storage, expectedRevision: 1 });
assert.equal(updated.revision, 2);
assert.throws(
  () => engine.saveTemplate({ ...saved, description: '오래된 화면' }, { storage, expectedRevision: 1 }),
  error => error && error.code === 'TEMPLATE_VERSION_CONFLICT'
);

const reordered = engine.reorderColumns(updated, 'quantity', 'up');
assert.equal(reordered.columnOrder.indexOf('quantity'), updated.columnOrder.indexOf('quantity') - 1);

const codeResult = engine.validateProductCodes([
  { code: 'BAD-999', name: '사과 10kg' },
  { code: '', name: '배 5kg' }
], [
  { code: 'A-100', name: '사과 10kg' },
  { code: 'P-200', name: '배 5kg' }
], updated);
assert.equal(codeResult.blocking, true);
assert.equal(codeResult.errors[0].code, 'UNREGISTERED_PRODUCT_CODE');
assert.equal(codeResult.accepted[0].code, 'P-200', '코드가 없고 품명이 정확히 일치하면 등록 코드를 채워야 한다.');

const html = fs.readFileSync(new URL('../DataOps.html', import.meta.url), 'utf8');
assert.match(html, /dataops\/template-engine\.js\?v=1\.0\.0/);
assert.match(html, /DATAOPS_DEFAULT_V1|DEFAULT_TEMPLATE_ID/);
assert.match(html, /TEMPLATE_REQUIRED_FIELD_MISSING/);
assert.match(html, /TEMPLATE_VERSION_CONFLICT/);
assert.match(html, /UNREGISTERED_PRODUCT_CODE/);
assert.match(html, /IMMUTABLE_FIELD/);
assert.match(html, /예상잔량/);
assert.match(html, /showOrderColumns/);

const gateway = fs.readFileSync(new URL('../nexus/server/nexus-auth-gateway.gs', import.meta.url), 'utf8');
assert.match(gateway, /writableFields = \['기초', '주문', '입고', '출고', '실사', '단가'\]/);
assert.match(gateway, /serverComputedFields = \['전산잔량', '예상잔량', '로스', 'savedAt', 'revision'\]/);

console.log('PASS test-dataops-template-engine');
