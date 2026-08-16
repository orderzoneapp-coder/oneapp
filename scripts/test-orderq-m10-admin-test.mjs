import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_TEST_DB_PREFIX,
  ADMIN_TEST_BUILD_ID,
  adminTestDatabaseName,
  isAdminTestRuntime,
  runtimeStorageKey,
  validateAdminTestBuildId
} from '../orderq/admin-test-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const page = read('orderq/admin-test.html');
const guide = read('orderq/admin-test-guide.html');
const source = read('orderq/admin-test.js');
const dbSource = read('orderq/orderq-db.js');
const cloudSource = read('orderq/orderq-cloud-adapter.js');
const cutoverSource = read('orderq/cutover-control.js');
const syncSource = read('orderq/orderq-sync-engine.js');

const publicLocation = {
  pathname:'/orderq/admin-test.html',
  hostname:'oneapp.orderz.co.kr',
  search:`?orderqTestDb=${ADMIN_TEST_DB_PREFIX}approved-a`
};
assert.equal(isAdminTestRuntime(publicLocation), true);
assert.equal(adminTestDatabaseName(publicLocation), `${ADMIN_TEST_DB_PREFIX}approved-a`);
assert.equal(adminTestDatabaseName({ ...publicLocation, search:'?orderqTestDb=oneapp-orderq-vnext' }), '');
assert.equal(adminTestDatabaseName({ ...publicLocation, search:'?orderqTestDb=../unsafe' }), '');
assert.equal(isAdminTestRuntime({ pathname:'/orderq/dispatch.html' }), false);
assert.equal(runtimeStorageKey('oneapp.orderq.device-id.v1', 'oneapp.orderq.admin-test.device-id.v1', publicLocation), 'oneapp.orderq.admin-test.device-id.v1');
assert.equal(runtimeStorageKey('oneapp.orderq.device-id.v1', 'oneapp.orderq.admin-test.device-id.v1', { pathname:'/orderq/dispatch.html' }), 'oneapp.orderq.device-id.v1');
assert.equal(ADMIN_TEST_BUILD_ID, '782d908816ca4445f2b17d45437e360ddc494537');
assert.equal(validateAdminTestBuildId(ADMIN_TEST_BUILD_ID), ADMIN_TEST_BUILD_ID);
assert.throws(() => validateAdminTestBuildId('477e023dc408a29a0db8a079134cfdf4a7b7cf5b'), /승인된 TEST 빌드/);
assert.throws(() => validateAdminTestBuildId(''), /승인된 TEST 빌드/);
assert.throws(() => validateAdminTestBuildId('different-build'), /승인된 TEST 빌드/);

assert.match(page, /TEST/);
for (const label of ['주문 확인', '출고 준비', '실제 출고수량 입력', '출고 확정', '결과 확인']) assert.match(page, new RegExp(label));
for (const label of ['판매 기록', '재고 차감 기록', '주문 처리 결과', '오류 없음', '다시 시작']) assert.match(page, new RegExp(label));
assert.match(guide, /실제 출고수량[^\n]*2/);
assert.match(guide, /판매 2개/);

assert.match(source, /validateAdminTestBuildId\(value\.buildId\)/);
assert.doesNotMatch(source, /value\.mainSha|EXPECTED_MAIN_SHA/);
assert.match(source, /TEST_QUANTITY = 2/);
assert.match(source, /OPENING_QUANTITY = 10/);
assert.match(source, /commandType:'RELEASE_DISPATCH'/);
assert.match(source, /recordDispatchActual/);
assert.match(source, /commandType:'CONFIRM_DISPATCH'/);
assert.match(source, /buildDispatchConfirmationKey/);
assert.match(source, /retryDuplicates/);
assert.match(source, /diagnosticCount/);
assert.match(source, /config\.profile !== 'A'/);
assert.match(source, /config\.profile === 'B'/);
assert.match(source, /commandType:'REVERSE_DISPATCH'/);
assert.match(source, /관리자 TEST 다시 시작/);
assert.doesNotMatch(source, /ERP_POSTED|erpPostingStatus\s*=\s*['"]POSTED/);

assert.match(dbSource, /adminTestDatabaseName/);
assert.match(cloudSource, /ADMIN_TEST_CLOUD_URL_KEY/);
assert.match(cloudSource, /sessionStorage/);
assert.match(cutoverSource, /runtimeStorageKey/);
assert.match(syncSource, /runtimeStorageKey/);

console.log('ORDER Q M10 administrator test contracts: PASS');
