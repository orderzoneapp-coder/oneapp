#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const navigationFiles = ["Master.html", "Item_manager.html", "dashboard.html"];

const expectedRoutes = [
  {
    id: "pipeline",
    label: "시세 관리",
    target: "MerchOps.html",
  },
  {
    id: "parser",
    label: "스마트 파서",
    target: "SmartParser.html",
  },
  {
    id: "inventory",
    label: "재고 관리",
    target: "DataOps.html",
  },
];

for (const target of expectedRoutes.map((route) => route.target)) {
  assert.ok(fs.existsSync(path.join(ROOT, target)), `${target} must exist before a NEXES tab links to it`);
}

for (const name of navigationFiles) {
  const source = read(name);
  for (const route of expectedRoutes) {
    const expression = new RegExp(
      `\\{ id: '${route.id}', label: '${route.label}',[^\\n]+path: '${route.target}'`,
    );
    assert.match(source, expression, `${name} must route ${route.label} to ${route.target}`);
  }

  assert.doesNotMatch(source, /\{ id: 'pipeline'[^\n]+path: 'Pipeline\.html'/, `${name} must not use the missing Pipeline.html route`);
  assert.doesNotMatch(source, /\{ id: 'parser'[^\n]+path: 'Parser\.html'/, `${name} must not use the missing Parser.html route`);
  assert.doesNotMatch(source, /\{ id: 'inventory'[^\n]+path: 'inventory\.html'/, `${name} must not use the missing inventory.html route`);
  assert.doesNotMatch(source, /\{ id: 'inventory', label: '재고 마감'/, `${name} must display the requested 재고 관리 label`);
}

const master = read("Master.html");
const itemManager = read("Item_manager.html");
const dashboard = read("dashboard.html");
assert.match(master, /Master DB \[v3\.6 AppRoutes\]/);
assert.match(master, />v3\.6<\/span>/);
assert.match(itemManager, /Item Manager \[v3\.6 AppRoutes\]/);
assert.match(itemManager, />v3\.6<\/span>/);
assert.match(dashboard, /Dashboard \[v2\.1 AppRoutes\]/);
assert.match(dashboard, />v2\.1<\/span>/);
assert.doesNotMatch(itemManager, /handleNavigate\(null, 'Pipeline\.html'\)/, "Item Manager queue completion must return to MerchOps");
assert.equal((itemManager.match(/handleNavigate\(null, 'MerchOps\.html'\)/g) || []).length, 2);

const publicOrderQ = read("orders.html");
const compatibilityOrderQ = read("orderops_list.html");
const canonicalOrderQ = read("orderops/list.html");
assert.equal(publicOrderQ, compatibilityOrderQ, "public ORDER Q entry points must remain byte-identical");
for (const [name, source] of [
  ["orders.html", publicOrderQ],
  ["orderops_list.html", compatibilityOrderQ],
  ["orderops/list.html", canonicalOrderQ],
]) {
  assert.match(source, /master-brand-version">v3\.6</, `${name} must show the current NEXES version`);
  assert.match(source, /brand-badge">v1\.63</, `${name} must show the current ORDER Q version`);
}

console.log("NEXES application routing tests passed.");
