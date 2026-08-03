#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const marker = '<script type="text/javascript">';
const start = source.indexOf(marker);
const end = source.lastIndexOf("</script>");
assert.ok(start >= 0 && end > start, "DataOps main script block must exist");
new vm.Script(source.slice(start + marker.length, end), { filename: "DataOps.inline.js" });

assert.match(source, /const manageMode = 'LOT_DETAIL';/, "inventory management mode must be fixed to LOT_DETAIL");
assert.match(source, /getSavedViewMode: \(\) => 'LOT_DETAIL'/, "saved legacy view mode must not restore CODE_SUMMARY");
assert.doesNotMatch(source, /\[\['CODE_SUMMARY', '코드 통합형'\], \['LOT_DETAIL', 'Lot 상세형'\]\]/, "global view toggle buttons must be removed");
assert.doesNotMatch(source, /\[\['PURCHASE_BALANCE', '구매잔량'\], \['OTHER_STOCK', '기타상품'\]\]/, "stock list filter buttons must be removed");
assert.doesNotMatch(source, /if \(filters\.stockListType === 'PURCHASE_BALANCE'\)/, "purchase-balance screen constraint must be removed");

assert.match(source, /const purchaseRemark = \(role === 'in' \|\| isClosingRestoreRow\)[\s\S]*?getExactRawVal\(rowObj, \['적요'\]\)[\s\S]*?: '';/, "only purchase and closing-restore rows may preserve the exact source 적요 column");
assert.match(source, /const purchaseRemark = \(role === 'in' \|\| isClosingRestoreRow\)[\s\S]*?: '';/, "sales-role 적요 must fall through to an empty purchase remark");
assert.match(source, /_purchaseRemark: candidate \? safeStr\(candidate\.remark, ''\)/, "cost-extracted lot must preserve its candidate remark");
assert.match(source, /_purchaseRemark: safeStr\(lot\._purchaseRemark, ''\)/, "restored closing lots must preserve the original remark");
assert.match(source, /displayPurchaseRemark \|\| '-'/, "blank purchase remarks must render as a dash");

const headerOrder = [
  'colSpan: "2"',
  'w-[350px] min-w-[350px]',
  '}, "단가")',
  '}, "기초 재고")',
  '}, "입고")',
  '}, "출고")',
  '}, "잔량")',
  '}, "오차")',
  'null, "이슈/결과 및 메모")',
];
let cursor = source.indexOf('React.createElement("thead"');
assert.ok(cursor >= 0, "inventory table header must exist");
for (const token of headerOrder) {
  const next = source.indexOf(token, cursor);
  assert.ok(next >= cursor, `table header order missing token: ${token}`);
  cursor = next;
}
assert.doesNotMatch(source, /React\.createElement\("th", \{ className: "[^"]*w-\[140px\][^"]*" \}, "적요"\)/, "remark header must be unified with product search");
assert.match(source, /w-\[100px\] min-w-\[100px\] max-w-\[100px\]/, "remark column must stay compact");
assert.match(source, /w-\[80px\] min-w-\[80px\]/, "price column must stay compact");
assert.doesNotMatch(source, /text-slate-400 font-semibold text-\[10px\] mr-1" }, "\\u20A9"/, "price input must not have a won-symbol prefix");
assert.doesNotMatch(source, /이 기준 통합/, "candidate action label must be shortened to 통합");
assert.doesNotMatch(source, /LOT 복원 불가 · 통합 유지/, "unavailable restore warning must not be rendered");
assert.match(source, /현재 단위: \$\{displayUnit\}/, "product name must expose the current unit badge");
assert.doesNotMatch(source, /코드통합형은 같은 품목을 1행으로 합치는 운영\/출력 기준입니다/, "settings guidance must describe the fixed Lot-detail policy");
assert.doesNotMatch(source, /기존 구매잔량\/기타상품·BOX\/EA\/소분·검색 필터와 교차 적용됩니다/, "category guidance must not mention removed stock-list filters");
assert.equal((source.match(/colSpan: "9"/g) || []).length, 3, "all table spanning rows must cover the new nine-column layout");

console.log("DataOps fixed Lot-detail layout contract passed.");
