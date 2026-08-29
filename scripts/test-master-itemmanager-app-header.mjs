import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = [
  {
    file: 'Master.html',
    appId: 'master-lookup',
    title: 'Master DB',
  },
  {
    file: 'Item_manager.html',
    appId: 'item-manager',
    title: '상품관리',
  },
];

for (const page of pages) {
  const html = await readFile(page.file, 'utf8');

  assert.match(html, new RegExp(`data-nexus-app-id="${page.appId}"`), `${page.file}: common header app id must remain`);
  assert.match(html, /nexus\/common\/nexus-ui\.js\?v=1\.2\.0/, `${page.file}: common header runtime must remain`);
  assert.match(html, /const AppHeader =/, `${page.file}: app work header is required`);
  assert.ok(html.includes(`>${page.title}<`), `${page.file}: app title is required`);
  assert.match(html, /min-h-\[56px\]/, `${page.file}: 56px app-header density is required`);
  assert.match(html, /max-w-\[1440px\]/, `${page.file}: centered 1440px work area is required`);
  assert.match(html, /calc\(100vh - var\(--nexus-ui-header-height, 64px\)\)/, `${page.file}: app height must exclude the common header`);
  assert.doesNotMatch(html, /const GlobalHeader =/, `${page.file}: legacy embedded global header is forbidden`);
  assert.doesNotMatch(html, />정보 관리<|>운영 관리<|>인사이트</, `${page.file}: legacy app-group navigation is forbidden`);
  assert.doesNotMatch(html, /15개 탭 완벽 매핑|통합 글로벌 헤더/, `${page.file}: legacy all-app navigation must not return`);
}

const commonUi = await readFile('nexus/common/nexus-ui.js', 'utf8');
for (const [label, path] of [
  ['가격·시세', 'MerchOps.html'],
  ['재고·정산', 'DataOps.html'],
  ['문서분석', 'SmartParser.html'],
  ['출력검증', 'export_center.html'],
  ['환경설정', 'settings.html'],
  ['기준정보', 'Master.html'],
  ['상품등록', 'Item_manager.html'],
  ['변경이력', 'history_viewer.html'],
  ['주문·출고', 'orderops/list.html'],
  ['주문현황', 'orderq/index.html'],
  ['스마트입력', 'smartinput/index.html'],
]) {
  assert.ok(commonUi.includes(`label: '${label}', path: '${path}'`), `common header must retain ${label}`);
}

console.log('PASS Master and Item Manager app-header contracts');
