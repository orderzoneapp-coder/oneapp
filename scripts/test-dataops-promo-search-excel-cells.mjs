#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("DataOps.html", "utf8");
const boundarySource = fs.readFileSync("dataops/inventory-master-boundary.js", "utf8");
const adapterSource = fs.readFileSync("reference-data/product-master-read-adapter.js", "utf8");
const marker = '<script type="text/javascript">';
const scriptStart = source.indexOf(marker);
const scriptEnd = source.indexOf("</script>", scriptStart);
new vm.Script(source.slice(scriptStart + marker.length, scriptEnd), { filename: "DataOps.inline.js" });

const context = vm.createContext({ console, Date, Math, JSON, Object, Array, Set, Map, String, Number, globalThis: null });
context.globalThis = context;
vm.runInContext(boundarySource, context);
const search = context.DATAOPS_INVENTORY_MASTER_ADD_MODULE;
const master = {
  A100: { 품목코드: "A100", 품목명: "빨간 사과", 규격: "10 kg", 단위: "BOX", 검색어등록: "fresh fruit", 창고: "SECRET" },
  A101: { 품목코드: "A101", 품목명: "빨간 배", 규격: "5kg", 단위: "EA", 검색어등록: "fresh fruit" },
  B200: { 품목코드: "B200", 품목명: "바나나", 규격: "10EA", 단위: "BOX", 검색어등록: "yellow" },
};
assert.equal(search.search(master, "a-100").selected.품목코드, "A100");
assert.equal(search.search(master, "빨간 10kg").selected.품목코드, "A100", "search tokens must AND across code/name/spec/keyword fields");
assert.equal(search.search(master, "fresh").mode, "choose");
assert.equal(search.search(master, "yellow").selected.품목코드, "B200");
assert.equal(search.search(master, "BOX").matches.length, 0, "unit is not an official F6 search field");
assert.equal(search.search(master, "SECRET").matches.length, 0, "warehouse data must not leak into F6 search");

assert.match(adapterSource, /status: 'ERROR'/);
assert.match(adapterSource, /status,\s*snapshot,\s*error: null/);
assert.match(adapterSource, /data\.products\.length > 0 \? 'READY' : 'EMPTY'/);
assert.doesNotMatch(adapterSource, /\bfetch\s*\(/, "official Product Snapshot read must stay local and network-free");
assert.match(source, /<script type="module" src="reference-data\/product-master-read-adapter\.js"><\/script>/);

const openStart = source.indexOf("const handleOpenInventoryMasterAdd =");
const openEnd = source.indexOf("const handleInventoryMasterRegistration =", openStart);
const f6 = source.slice(openStart, openEnd);
assert.ok(f6.indexOf("readOfficialProductSnapshot()") < f6.indexOf("DATAOPS_INVENTORY_MASTER_ADD_MODULE.search"), "F6 must reread the official snapshot immediately before search");
assert.doesNotMatch(f6, /fetch\s*\(/);
assert.match(source, /data-inventory-master-add-draft/);
assert.match(source, /inventoryMasterDraft\.displayAnchorBatchKey === item\.batchKey/);
assert.match(source, /품목코드 · 상품명 · 규격 · 검색어등록/);

assert.match(source, /const cellInputBase = "[^"]*bg-slate-50[^"]*focus:border-blue-500[^"]*rounded/);
assert.match(source, /const cols = \['price-input', 'base-prev', 'base-in', 'base-out', 'actual-input'\]/, "keyboard column order must preserve the current no-promotion boundary");
assert.doesNotMatch(source, /'promo-input'/, "DataOps must not expose promotion editing as a table input");
assert.match(source, /e\.key === 'ArrowDown' \|\| e\.key === 'Enter'/);
assert.match(source, /e\.key === 'ArrowRight'/);
assert.match(source, /e\.key === 'ArrowLeft'/);
assert.match(source, /__dataopsFlushNow = \(\) => flushPendingEdit\(type\)/);
assert.match(source, /React\.createElement\("thead", \{ className: "[^"]*sticky z-\[35\]/);
assert.match(source, /if \(e\.key === 'F9'\)[\s\S]*latestHandlers\.current\.handleCombinedExport\(\)/);

console.log("PASS test-dataops-promo-search-excel-cells");
