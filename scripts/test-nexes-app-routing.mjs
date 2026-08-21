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
  assert.match(source, /<nexus-top app-id="orderq"><\/nexus-top>/, `${name} must load NEXUS TOP`);
  assert.match(source, /\/nexus\/common\/nexus-top\.js\?v=1\.0\.0/, `${name} must use the shared NEXUS TOP component`);
  assert.match(source, /brand-badge">v1\.63</, `${name} must show the current ORDER Q version`);
}

const nexusApps = [
  ["Master.html", "master"],
  ["MerchOps.html", "merchops"],
  ["SmartParser.html", "orderin"],
  ["DataOps.html", "dataops"],
];
for (const [name, appId] of nexusApps) {
  const source = read(name);
  assert.match(source, new RegExp(`<nexus-top app-id="${appId}"></nexus-top>`), `${name} must declare its app-id`);
  assert.match(source, /\/nexus\/common\/apps-config\.js\?v=1\.0\.0/, `${name} must load shared app configuration`);
  assert.match(source, /\/nexus\/common\/nexus-top\.js\?v=1\.0\.0/, `${name} must load NEXUS TOP`);
}

const nexusConfig = read("nexus/common/apps-config.js");
const defaultOrder = [...nexusConfig.matchAll(/id:'([^']+)'/g)].map((match) => match[1]);
assert.deepEqual(defaultOrder, ["orderq", "dataops", "merchops", "master"], "NEXUS TOP must expose only the four parent applications in operating order");
assert.match(nexusConfig, /name:'재고관리'/);
assert.doesNotMatch(nexusConfig, /id:'orderin'|name:'주문입력'|SmartParser\.html/, "SmartParser must not appear as a parent NEXUS TOP application");
assert.match(read("nexus/common/nexus-top.js"), /declared==='orderin'\?'merchops':declared/, "SmartParser must activate its parent MerchOps menu");

console.log("NEXES application routing tests passed.");
