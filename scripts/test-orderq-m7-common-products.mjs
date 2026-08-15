#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PRODUCT_LINE_CONTEXT,
  applyProductSelection,
  editProductLine,
  searchLineProducts
} from '../orderq/product-line-common.js';
import {
  QUICK_PRODUCT_EVENT,
  QUICK_PRODUCT_STATUS,
  isTemporaryProductId,
  normalizeMasterLinkCommand,
  normalizeMasterUnlinkCommand,
  normalizeQuickProductDraft
} from '../orderq/quick-product.js';
import { mergeProductCatalog } from '../orderq/product-master-search.js';

const quickDraft = normalizeQuickProductDraft({
  itemName: '간편 배추', itemCode: 0, finalUnit: 'BOX', boxQuantity: 0, reason: '현장 주문'
});
assert.equal(quickDraft.itemName, '간편 배추');
assert.equal(quickDraft.itemCode, '0');
assert.equal(quickDraft.boxQuantity, 0);
assert.equal(isTemporaryProductId('TMP-2e61d5d1-4d96-4f23-8731-0954397ed965'), true);
assert.equal(isTemporaryProductId('PRD-TMP-1'), false);
assert.deepEqual(Object.values(QUICK_PRODUCT_STATUS), ['UNLINKED', 'LINKED']);
assert.deepEqual(Object.values(QUICK_PRODUCT_EVENT), [
  'QUICK_PRODUCT_CREATED', 'QUICK_PRODUCT_MASTER_LINKED', 'QUICK_PRODUCT_MASTER_UNLINKED'
]);

const master = {
  productId: 'PRD-100', itemCode: '100', itemName: '정식 배추', specification: '10kg', finalUnit: 'BOX', source: 'COMMON_MASTER'
};
const link = normalizeMasterLinkCommand({
  quickProductId: 'TMP-1', expectedRevision: 1, masterProduct: master, reason: '상품 확인'
});
assert.equal(link.masterProduct.productId, 'PRD-100');
assert.equal(link.reason, '상품 확인');
assert.deepEqual(normalizeMasterUnlinkCommand({
  quickProductId: 'TMP-1', expectedRevision: 2, reason: '잘못 연결'
}), { quickProductId: 'TMP-1', expectedRevision: 2, reason: '잘못 연결' });
assert.throws(() => normalizeMasterLinkCommand({
  quickProductId: 'TMP-1', expectedRevision: 1, masterProduct: { productId: 'TMP-2' }, reason: '오류'
}), /MASTER_ID_INVALID/);
assert.throws(() => normalizeMasterLinkCommand({
  quickProductId: 'TMP-1', expectedRevision: 1, masterProduct: master, reason: ''
}), /LINK_REASON_REQUIRED/);

const injected = {
  status: 'CONFIRMED', revision: 999, confirmedBy: 'FAKE', idempotencyKey: 'FAKE',
  confirmationRequestFingerprint: 'FAKE', erpPostingStatus: 'POSTED'
};
const order = applyProductSelection(PRODUCT_LINE_CONTEXT.ORDER, { orderItemId: 'OI-1' }, master);
const dispatch = applyProductSelection(PRODUCT_LINE_CONTEXT.DISPATCH, { dispatchLineId: 'DL-1' }, master);
const purchase = applyProductSelection(PRODUCT_LINE_CONTEXT.PURCHASE, { purchaseLineId: 'PL-1' }, master);
const parser = applyProductSelection(PRODUCT_LINE_CONTEXT.SMARTPARSER, { lineId: 'SP-1' }, master);
assert.deepEqual(
  [order.productId, dispatch.actualProductId, purchase.productId, parser.confirmedProductId],
  ['PRD-100', 'PRD-100', 'PRD-100', 'PRD-100']
);
assert.equal(order.itemCode, '100');
assert.equal(dispatch.actualProductCode, '100');
assert.equal(purchase.productCode, '100');
assert.equal(parser.itemCode, '100');

for (const context of Object.values(PRODUCT_LINE_CONTEXT)) {
  const edited = editProductLine(context, { immutableEvidence: 'KEEP' }, { ...injected, quantity: 3, itemName: '수정' });
  assert.equal(edited.immutableEvidence, 'KEEP');
  for (const field of Object.keys(injected)) assert.equal(Object.hasOwn(edited, field), false, `${context} accepted ${field}`);
}
assert.equal(editProductLine(PRODUCT_LINE_CONTEXT.ORDER, {}, { itemName: '수정' }).itemName, '수정');
assert.equal(editProductLine(PRODUCT_LINE_CONTEXT.PURCHASE, {}, { quantity: 3 }).quantity, 3);

const catalog = mergeProductCatalog([master], [
  { productId: 'TMP-1', itemCode: 'TMP1', itemName: '미연결 배추', productIdentityType: 'TEMPORARY', registrationStatus: 'UNLINKED', status: 'ACTIVE' },
  { productId: 'TMP-2', itemCode: 'TMP2', itemName: '연결된 배추', productIdentityType: 'TEMPORARY', registrationStatus: 'LINKED', status: 'ACTIVE' }
]);
assert.equal(catalog.some(product => product.productId === 'TMP-1'), true);
assert.equal(catalog.some(product => product.productId === 'TMP-2'), false);
assert.equal(searchLineProducts('미연결', catalog, 8)[0].productId, 'TMP-1');

const repositorySource = await readFile(new URL('../orderq/quick-product-repository.js', import.meta.url), 'utf8');
const commonSource = await readFile(new URL('../orderq/product-line-common.js', import.meta.url), 'utf8');
const inputSource = await readFile(new URL('../orderq/input.html', import.meta.url), 'utf8');
const dispatchUiSource = await readFile(new URL('../orderq/dispatch-ui.js', import.meta.url), 'utf8');
const purchaseUiSource = await readFile(new URL('../orderq/purchase-ui.js', import.meta.url), 'utf8');
const parserSource = await readFile(new URL('../orderq/smartparser/matching-engine.js', import.meta.url), 'utf8');

for (const command of ['createQuickProduct', 'linkQuickProductToMaster', 'unlinkQuickProductFromMaster']) {
  assert.match(repositorySource, new RegExp(`export async function ${command}`));
}
assert.match(repositorySource, /status: 'LOCAL_ONLY'/);
assert.match(repositorySource, /localOnly: true/);
assert.match(repositorySource, /CAPABILITY\.MASTER_LINK/);
assert.doesNotMatch(repositorySource, /confirmDispatch\s*\(|confirmPurchase\s*\(|reverseDispatch\s*\(|reversePurchase\s*\(/);
assert.doesNotMatch(repositorySource, /STORE\.(ORDERS|ORDER_ITEMS|DISPATCH_DECISIONS|DISPATCH_LINES|PURCHASE_DOCUMENTS|PURCHASE_LINES|SALES_DOCUMENTS|SALES_LINES|INVENTORY_MOVEMENTS)/);
assert.doesNotMatch(commonSource, /status\s*:|confirmDispatch|confirmPurchase|saveOrder|saveDispatchDraft|savePurchaseDraft/);
assert.match(inputSource, /PRODUCT_LINE_CONTEXT\.ORDER/);
assert.match(dispatchUiSource, /PRODUCT_LINE_CONTEXT\.DISPATCH/);
assert.match(purchaseUiSource, /PRODUCT_LINE_CONTEXT\.PURCHASE/);
assert.match(parserSource, /PRODUCT_LINE_CONTEXT\.SMARTPARSER/);

console.log('ORDER Q M7 quick product and minimal common line contracts passed');
console.log(JSON.stringify({
  quickIdPrefix: 'TMP-',
  catalogIds: catalog.map(product => product.productId),
  contexts: Object.values(PRODUCT_LINE_CONTEXT),
  sharedBoundary: 'selection/search/edit only'
}, null, 2));
