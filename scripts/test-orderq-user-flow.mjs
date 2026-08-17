import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  actionCodeLabel,
  dispatchStatusLabel,
  erpStatusLabel,
  purchaseStatusLabel
} from '../orderq/workflow-language.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

assert.equal(dispatchStatusLabel('DRAFT'), '검토 중');
assert.equal(dispatchStatusLabel('RELEASED'), '출고 준비');
assert.equal(dispatchStatusLabel('READY_TO_CONFIRM'), '확정 대기');
assert.equal(dispatchStatusLabel('CONFIRMED'), '출고 완료');
assert.equal(purchaseStatusLabel('CONFIRMED'), '입고 완료');
assert.equal(erpStatusLabel('READY'), 'ERP 자료 준비');
assert.equal(erpStatusLabel('CORRECTION_REQUIRED'), 'ERP 수정 필요');
assert.equal(actionCodeLabel('MEASURE_PENDING'), '실제 계량 필요');

const dailyPages = [
  'parser.html',
  'index.html',
  'input.html',
  'operations.html',
  'dispatch.html',
  'purchase.html',
  'erp.html',
  'reconciliation.html'
];

for (const page of dailyPages) {
  const html = read(`orderq/${page}`);
  assert.match(html, /workflow-guide\.js\?v=0\.11\.0/, `${page}: 공통 업무 진행표시가 필요합니다.`);
  assert.match(html, /orderq\.css\?v=0\.11\.0/, `${page}: 새 업무 진행표시 CSS 캐시를 갱신해야 합니다.`);
}

const guide = read('orderq/workflow-guide.js');
for (const step of ['주문 받기', '주문 확인', '출고 준비', '실제 수량', '출고 확정', 'ERP 자료']) {
  assert.ok(guide.includes(step), `업무 단계 누락: ${step}`);
}
assert.match(guide, /관리자 설정/);
assert.match(guide, /지금 동기화/);
assert.match(guide, /\.top-actions a/);
assert.match(guide, /append\(syncButton\)/);
assert.match(guide, /key:'prepare', label:'출고 준비', href:'\.\/operations\.html'/);
assert.match(guide, /'index\.html': \{[^\n]+next:'prepare'/);
assert.match(guide, /'operations\.html': \{[^\n]+next:'actual'/);
assert.match(guide, /기초자료 가져오기/);
assert.ok(!guide.includes('변경 이력 수집'));
assert.ok(!guide.includes('역분개'));

const indexHtml = read('orderq/index.html');
assert.match(indexHtml, /id="syncText" hidden/);
assert.match(indexHtml, /다른 곳에서 먼저 수정된 주문이 있습니다/);
assert.ok(!indexHtml.includes('클라우드 URL 미설정'));
assert.ok(!indexHtml.includes('변경번호 ${'));

const inputHtml = read('orderq/input.html');
assert.ok(!inputHtml.includes('변경번호 ${'));
assert.ok(!inputHtml.includes('시스템 변경번호'));

const dispatchUi = read('orderq/dispatch-ui.js');
for (const commandBoundary of ['saveDispatchDraft', 'releaseDispatch', 'recordDispatchActual', 'confirmDispatch', 'reverseDispatch', 'runCentralOfficialCommand']) {
  assert.ok(dispatchUi.includes(commandBoundary), `출고 명령 경계 누락: ${commandBoundary}`);
}
assert.ok(!dispatchUi.includes('변경번호 ${'));
assert.ok(!dispatchUi.includes('>대체판단만 역분개<'));
for (const userCopy of ['출고안 저장', '출고 준비 시작', '실제 수량 저장', '출고 확정', 'ERP 자료 확인']) {
  const source = userCopy === 'ERP 자료 확인' ? read('orderq/workflow-guide.js') : dispatchUi;
  assert.ok(source.includes(userCopy), `출고 사용자 문구 누락: ${userCopy}`);
}

const purchaseUi = read('orderq/purchase-ui.js');
for (const commandBoundary of ['savePurchaseDraft', 'confirmPurchase', 'reversePurchase', 'runCentralOfficialCommand']) {
  assert.ok(purchaseUi.includes(commandBoundary), `구매 명령 경계 누락: ${commandBoundary}`);
}
assert.ok(!purchaseUi.includes('<label>변경번호'));
for (const userCopy of ['구매안 저장', '구매 확정', '입력 수량 일부 취소']) {
  assert.ok(purchaseUi.includes(userCopy), `구매 사용자 문구 누락: ${userCopy}`);
}

const erpUi = read('orderq/erp-ui.js');
assert.ok(erpUi.includes('markErpDocumentsExported'));
assert.ok(erpUi.includes('transitionErpDocuments'));
assert.ok(erpUi.includes("'파일 생성 완료'"));

const reconciliationUi = read('orderq/reconciliation-ui.js');
assert.ok(reconciliationUi.includes('adjustDispatchAfterShipment'));
assert.ok(reconciliationUi.includes('completeDispatchReconciliation'));
assert.ok(reconciliationUi.includes('기존 확정 취소 후 수정 출고안 만들기'));
assert.ok(reconciliationUi.includes('재고 반영 기록 있음'));
assert.ok(reconciliationUi.includes('관리자 상세 이력'));
assert.ok(!reconciliationUi.includes('Movement ${'));
assert.ok(!reconciliationUi.includes('· 변경 ${'));

console.log('ORDER Q user flow contracts: PASS');
