import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const master = readFileSync(resolve(root, 'Master.html'), 'utf8');
const compatibility = readFileSync(resolve(root, 'ItemMaster.html'), 'utf8');
const itemManager = readFileSync(resolve(root, 'Item_manager.html'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(root, 'app-manifest.json'), 'utf8'));
const nexusHome = readFileSync(resolve(root, 'nexus', 'nexus.js'), 'utf8');
const nexusUi = readFileSync(resolve(root, 'nexus', 'common', 'nexus-ui.js'), 'utf8');
const dashboard = readFileSync(resolve(root, 'dashboard.html'), 'utf8');

for (const [label, value] of [
  ['official app id', 'data-nexus-app-id="master-lookup"'],
  ['official operating DB', "indexedDB.open('MerchOpsDB'"],
  ['shared storage API', 'commitInitialRegistration'],
  ['initial Excel builder', 'buildInitialMasterImport'],
  ['initial confirmation', '상품관리 최초 Excel 등록'],
  ['single-product editor', 'ProductEditorModal'],
  ['single-product commit', 'commitSingleProductChange'],
  ['single-product edit action', 'setEditingProduct(row)'],
  ['empty-state guidance', '상품 DB가 비어 있습니다. Excel 최초 등록 또는 상품 단건 등록으로 시작하세요'],
  ['legacy database existence check', 'indexedDB.databases'],
  ['legacy backup', 'ONEAPP_ITEMMASTER_LEGACY_BACKUP_V1'],
  ['legacy review', "allowEmptyMaster: true"],
  ['legacy non-destructive notice', '자동 반영·덮어쓰기·삭제하지 않습니다.']
]) {
  assert.ok(master.includes(value), `${label} contract is missing from Master.html`);
}

assert.doesNotMatch(master, /indexedDB\.deleteDatabase\(['"]oneapp-itemmaster-isolated-v1/);

for (const [label, value] of [
  ['compatibility title', '<title>상품관리 주소 안내 - NEXUS</title>'],
  ['deprecation notice', '상품관리 주소가 하나로 통합되었습니다.'],
  ['official link', '<a href="Master.html">공식 상품관리로 이동</a>'],
  ['legacy preservation notice', '자동으로 삭제하거나 덮어쓰지 않습니다.']
]) {
  assert.ok(compatibility.includes(value), `${label} is missing from ItemMaster.html`);
}

for (const [label, pattern] of [
  ['script execution', /<script\b/i],
  ['IndexedDB access', /\bindexedDB\b/],
  ['isolated database runtime', /oneapp-itemmaster-isolated-v1/],
  ['React application', /\bReact(?:DOM)?\b/],
  ['Excel parser', /\bXLSX\b|masterAddUpdate\.js/],
  ['write controls', /상품 단건 등록|수정 저장|추가·갱신 Excel/]
]) {
  assert.equal(pattern.test(compatibility), false, `${label} must not remain in the compatibility page`);
}

const official = manifest.applications.find(application => application.id === 'master-lookup');
assert.equal(official?.path, 'Master.html');
assert.equal(manifest.applications.some(application => application.path === 'ItemMaster.html'), false);
assert.equal(manifest.applications.find(application => application.id === 'item-manager')?.path, 'Item_manager.html');
assert.match(nexusHome, /path:\s*['"]\/Master\.html['"]/);
assert.match(nexusUi, /id:\s*['"]master-lookup['"][\s\S]*?path:\s*['"]Master\.html['"]/);
assert.match(dashboard, /label:\s*['"]상품관리['"][\s\S]*?path:\s*['"]Master\.html['"]/);

for (const feature of ['카탈로그', 'SKU 후보', 'BOM', '상품 등록 요청']) {
  assert.ok(itemManager.includes(feature), `Item_manager ${feature} feature must remain`);
}
assert.match(itemManager, /SKU_MANAGEMENT_MASTER_WRITE_BLOCKED/, 'SKU management must block direct product-master writes');
assert.match(itemManager, /submitChangeRequest/, 'SKU management must submit product-owner requests');
assert.doesNotMatch(itemManager, /id: 'theme', label: '행사테마'/, 'promotion-theme management must not remain in SKU navigation');

console.log('PASS Master consolidation and ItemMaster compatibility source contracts');
