import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const html = readFileSync(path.join(root, "Item_manager.html"), "utf8");
const js = readFileSync(path.join(root, "Item_manager.js"), "utf8");
const css = readFileSync(path.join(root, "Item_manager.css"), "utf8");
const master = readFileSync(path.join(root, "Master.html"), "utf8");

assert.match(html, /id="nexus-common-header"\s+data-app-id="master"/);
assert.match(html, /<nexus-top app-id="item-manager">[\s\S]*?<\/nexus-top>/);
assert.match(html, /상품 기초정보 관리/);
assert.match(html, /목록·조회/);
assert.match(html, /기초정보 관리/);
assert.doesNotMatch(html, /SKU FORGE|카탈로그 소싱|행사테마|BOM 조립|수기등록/);

for (const sharedStyle of [
  "oneapp-design-tokens.css",
  "oneapp-layout.css",
  "oneapp-components.css"
]) {
  assert.ok(html.includes(sharedStyle), sharedStyle + " must be loaded");
}

for (const field of [
  '"코드"', '"품목명"', '"규격"', '"단위"', '"1그룹명"', '"3그룹명"',
  '"안전재고"', '"입고가"', '"외주비"', '"경비"', '"비과세"', '"판매여부"'
]) {
  assert.ok(js.includes(field), field + " field must stay connected");
}

for (const excluded of ["판매가", "행사가", "마진율", "가격변동", "행사테마"]) {
  assert.ok(!html.includes(excluded), excluded + " must not be exposed in the management UI");
}

assert.match(js, /commitMasterStateOrThrow/);
assert.match(js, /expectedRevision:\s*state\.revision/);
assert.match(js, /plan\.valid/);
assert.match(js, /plan\.invalid/);
assert.match(js, /정상 상품은 저장했고, 오류 상품은 현재 표에 유지했습니다/);
assert.match(js, /document\.addEventListener\("paste"/);
assert.match(js, /event\.key === "F2"/);
assert.match(js, /event\.key === "Enter"/);
assert.match(js, /event\.key === "Tab"/);
assert.match(js, /event\.key === "ArrowDown"/);
assert.match(js, /event\.key\.toLowerCase\(\) === "z"/);
assert.match(js, /event\.key\.toLowerCase\(\) === "y"/);
assert.match(js, /event\.key\.toLowerCase\(\) === "s"/);
assert.match(js, /BATCH_FIELDS = \["1그룹명", "3그룹명", "안전재고", "외주비", "경비", "비과세", "판매여부"\]/);
assert.match(js, /beforeunload/);

assert.match(css, /\.product-grid th[\s\S]*height:\s*40px/);
assert.match(css, /\.product-grid th,[\s\S]*\.product-grid td[\s\S]*height:\s*42px/);
assert.match(css, /\.grid-code[\s\S]*position:\s*sticky/);
assert.match(css, /\.grid-name[\s\S]*position:\s*sticky/);
assert.match(css, /\.cell-modified/);
assert.match(css, /\.cell-error/);
assert.match(css, /@media \(max-width: 760px\)/);
assert.match(css, /\.mobile-editor[\s\S]*display:\s*none/);

assert.match(master, /params\.get\('mode'\) === 'manage'/);
assert.match(master, /window\.location\.replace\(new URL\('Item_manager\.html'/);
assert.match(master, /\['manage', '기초정보 관리'\]/);

console.log("Item manager UI contract tests passed.");
