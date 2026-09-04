#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const mutations = [];
globalThis.fetch = async (url, options = {}) => {
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) mutations.push({ url: String(url), method });
  throw new Error('PHASE6B_TEST_NETWORK_DISABLED');
};
globalThis.indexedDB = {
  open() { throw new Error('PHASE6B_UI_MUST_NOT_OPEN_RAW_ORDERQ_DB'); }
};

const ui = await import('../orderops/unresolved-review-ui.js');
const listHtml = readFileSync(new URL('../orderops/list.html', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../orderops/unresolved-review-ui.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../app-manifest.json', import.meta.url), 'utf8'));

const sessionStorageStub = {
  getItem(key) {
    assert.equal(key, 'oneapp.nexus.home.session.v1');
    return JSON.stringify({ session: { companyId: 'COMPANY-A' } });
  }
};
assert.equal(ui.resolveOrderOpsCompanyId(sessionStorageStub), 'COMPANY-A');
assert.equal(ui.resolveOrderOpsCompanyId({ getItem: () => '{broken' }), 'ONEAPP');

const candidates = [
  {
    productId: 'PRODUCT-EXACT', productCode: '0007', productName: '정확상품', specification: '10kg', unit: 'BOX',
    matchBasis: 'EXACT_COMPANY_PRODUCT_CODE', exactCandidate: true, selectable: true, automaticConfirmation: false
  },
  {
    productId: 'PRODUCT-NAME', productCode: 'NAME-7', productName: '품명만 상품', specification: '1kg', unit: 'EA',
    matchBasis: 'EXACT_PRODUCT_NAME_REFERENCE_ONLY', exactCandidate: false, selectable: true, automaticConfirmation: false
  }
];

function link({ id, code = '', name = '', inputQuantity = 0, signedQuantity = 0, mode = 'purchase', ready = true }) {
  return {
    pendingEffectId: id,
    originalProductCode: code,
    originalProductName: name,
    specification: '10kg',
    unit: 'BOX',
    warehouseId: 'WAREHOUSE-A',
    businessDate: '2026-09-03',
    inputQuantity,
    signedQuantity,
    officialInventory: { status: 'NOT_APPLIED', label: '미반영', officialQuantity: null, unappliedSignedQuantity: signedQuantity },
    sourceVoucher: {
      voucherMode: mode,
      documentId: `DOC-${id}`,
      lineId: `LINE-${id}`,
      documentRevision: 2,
      revisionId: `REV-${id}`,
      detailHref: 'https://external.example/COMPANY-B-SECRET'
    },
    integrity: ready ? { status: 'READY', issues: [] }
      : { status: 'REVIEW_REQUIRED', issues: [{ code: 'SOURCE_LINE_MISSING', detail: 'COMPANY-B-SECRET' }] }
  };
}

function item({ id, code = '', name = '', quantities = [0], ready = true }) {
  const links = quantities.map((quantity, index) => link({
    id: `${id}-${index + 1}`,
    code,
    name,
    inputQuantity: quantity,
    signedQuantity: index % 2 ? -quantity : quantity,
    mode: index % 2 ? 'sale' : 'purchase',
    ready
  }));
  return {
    unresolvedProductId: id,
    companyId: 'COMPANY-A',
    originalProductCode: code,
    originalProductName: name,
    specification: '10kg',
    unit: 'BOX',
    officialInventory: {
      status: 'NOT_APPLIED', label: '미반영', officialQuantity: null,
      unappliedSignedQuantity: links.reduce((sum, row) => sum + row.signedQuantity, 0)
    },
    aggregate: {
      documentCount: links.length, lineCount: links.length,
      inputQuantityTotal: links.reduce((sum, row) => sum + row.inputQuantity, 0),
      signedQuantityTotal: links.reduce((sum, row) => sum + row.signedQuantity, 0),
      warehouseIds: ['WAREHOUSE-A'], businessDates: ['2026-09-03']
    },
    links,
    candidates,
    integrity: ready ? { status: 'READY', issues: [] }
      : { status: 'REVIEW_REQUIRED', issues: [{ code: 'SOURCE_LINE_MISSING', detail: 'COMPANY-B-SECRET' }] }
  };
}

const review = {
  status: 'READY',
  items: [
    item({ id: 'UP-CODE', code: '0007', quantities: [0] }),
    item({ id: 'UP-NAME', name: '품명만 상품', quantities: [3] }),
    item({ id: 'UP-BOTH', code: 'BOTH', name: '코드와 품명', quantities: [5, 2], ready: false })
  ]
};
const preview = ui.buildUnresolvedListPreview(review);
assert.equal(preview.rows.length, 3);
assert.equal(preview.rows[0][0], '0007', 'code-only rows must remain visible');
assert.equal(preview.rows[1][1], '품명만 상품', 'name-only rows must remain visible');
assert.equal(preview.rows[0][6], 0, 'input quantity zero must remain a numeric zero');
assert.equal(preview.rows[2][7], 3, 'purchase/sale signed quantities must remain signed');
assert.equal(preview.rows[0][8], '미반영', 'official inventory must stay NOT_APPLIED');

const secondPage = { ...review, page: { number: 2, limit: 200, totalItems: 201, totalPages: 2, returnedItems: 1 } };
assert.deepEqual(ui.unresolvedPagePresentation(secondPage), {
  number: 2, limit: 200, totalItems: 201, totalPages: 2, returnedItems: 1, hasPrevious: true, hasNext: false
});
const secondPageNavigation = ui.renderUnresolvedPagination(secondPage, { visibleItems: 1 });
assert.match(secondPageNavigation, /2\/2페이지/);
assert.match(secondPageNavigation, /현재 페이지 1건 · 전체 201건/);
assert.match(secondPageNavigation, /검색·정렬·열조건은 현재 페이지 자료에만 적용됩니다/);
assert.match(secondPageNavigation, /data-unresolved-page="1"[^>]*>이전/);
assert.match(secondPageNavigation, /data-unresolved-page="3" disabled>다음/);
const firstPageNavigation = ui.renderUnresolvedPagination({ ...review, page: { number: 1, limit: 200, totalItems: 201, totalPages: 2, returnedItems: 200 } });
assert.match(firstPageNavigation, /data-unresolved-page="0" disabled>이전/);
assert.match(firstPageNavigation, /data-unresolved-page="2" >다음/);

const detail = ui.renderUnresolvedDetail({ item: review.items[2] });
for (const text of ['원전표 추적', '문서 Revision·Revision ID', '— · 미반영', '정확 상품코드 후보', '품명 참고 후보']) {
  assert.match(detail, new RegExp(text));
}
assert.equal((detail.match(/자동확정 아님/g) || []).length >= 3, true);
assert.doesNotMatch(detail, /COMPANY-B-SECRET|forbidden=/, 'raw issue details and owner query URLs must not leak');

const impact = ui.renderUnresolvedDetail({
  item: review.items[0],
  selectedProductId: 'PRODUCT-EXACT',
  impactState: {
    result: {
      status: 'REVIEW_REQUIRED',
      summary: {
        affectedDocumentCount: 3, affectedLineCount: 3, inputQuantityTotal: 4, signedQuantityTotal: 0,
        decisionRequiredCount: 1, reviewRequiredCount: 1
      },
      impacts: [
        { status: 'APPLY_READY', sourceVoucher: { voucherMode: 'purchase', documentId: 'D1', lineId: 'L1' }, warehouseId: 'W1', businessDate: '2026-09-03', inputQuantity: 1, signedQuantity: 1, checkpoint: null },
        { status: 'DECISION_REQUIRED', sourceVoucher: { voucherMode: 'sale', documentId: 'D2', lineId: 'L2' }, warehouseId: 'W2', businessDate: '2026-09-02', inputQuantity: 2, signedQuantity: -2, checkpoint: { effectiveAt: '2026-09-03', checkpointId: 'CP-1' } },
        { status: 'REVIEW_REQUIRED', sourceVoucher: { voucherMode: 'sale', documentId: 'D3', lineId: 'L3' }, warehouseId: 'W3', businessDate: '2026-09-01', inputQuantity: 1, signedQuantity: -1, checkpoint: null }
      ]
    }
  }
});
for (const text of ['적용 가능', '실사 판단 필요', '원자료 확인 필요', '최신 실사 checkpoint', '읽기 전용 미리보기']) {
  assert.match(impact, new RegExp(text));
}
assert.doesNotMatch(impact, /data-(?:apply|confirm)|확정 버튼|적용 버튼/);

assert.match(uiSource, /^import \{ unresolvedReviewReadAdapter \} from '\.\.\/orderq\/unresolved-review-read-adapter\.js\?v=0\.1\.0';/);
assert.doesNotMatch(uiSource, /indexedDB|official-voucher-repository|unresolved-review-repository|runCentralOfficialVoucherCommand/);
assert.match(listHtml, /id="unresolvedReviewToggle"/);
assert.match(listHtml, /getReviewResult\(\{ companyId, page: requestedPage, limit: 200 \}\)/);
assert.match(listHtml, /\.table-wrap\.unresolved-review-surface[^}]*contain:[^;}]*inline-size/);
assert.doesNotMatch(listHtml, /data-preview="unresolved"[^>]*role="tab"/);
assert.doesNotMatch(listHtml, /from\s+["'][^"']*(?:official-voucher-repository|unresolved-review-repository)/);

const orderops = manifest.applications.find(app => app.id === 'orderops');
const contract = manifest.sharedDataContracts.find(entry => entry.id === 'orderq-unresolved-review-read-model');
assert.deepEqual(orderops.consumedContracts, ['orderq-unresolved-review-read-model']);
assert.deepEqual(contract.consumers, ['orderops']);

const smartInputProductUiHashes = new Map([
  ['../smartinput/index.html', '734e9e52f5ba9c18489e89facb6bac076d27149bb1470be22a6acb8893eca411'],
  ['../smartinput/smartinput.css', '82ee90f8658d69aa1c126d247795a532dc0c695dc6c2f34235a4c7f466654cf7'],
  ['../smartinput/smartinput.js', '3f37a67f33370515377493df02c73d2838eae4a677395f4199abe8f5a53f623e']
]);
for (const [relativePath, expectedHash] of smartInputProductUiHashes) {
  const normalizedSource = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/nexus-ui\.css\?v=[^"']+/g, 'nexus-ui.css?v=1.3.4')
    .replace(/nexus-ui-app-themes\.css\?v=[^"']+/g, 'nexus-ui-app-themes.css?v=1.3.5')
    .replace(/nexus-ui\.js\?v=[^"']+/g, 'nexus-ui.js?v=1.4.1');
  assert.equal(createHash('sha256').update(normalizedSource).digest('hex'), expectedHash,
    `${relativePath} must match approved SmartInput product UI NEXUS-SMARTINPUT-ERP-ORDER-BUSINESS-KEY-20260905 apart from the shared theme cache token`);
}
assert.deepEqual(mutations, []);

console.log(JSON.stringify({
  taskId: 'NEXUS-SI-V2-06B',
  status: 'PASS',
  rows: { codeOnly: true, nameOnly: true, zero: true, positive: true, negative: true, multipleLinks: 2 },
  candidatePolicy: { exactSeparated: true, nameReferenceOnly: true, automaticConfirmation: false },
  officialInventory: { value: null, label: '미반영' },
  rawOrderQStoreAccessFromProductUi: 0,
  externalMutatingRequests: mutations.length,
  smartInputUiBaseline: 'NEXUS-SMARTINPUT-ERP-ORDER-BUSINESS-KEY-20260905',
  smartInputUiChanged: false
}, null, 2));
