#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const navigationFiles = ["Master.html", "dashboard.html"];

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
assert.match(master, /<title>기초등록<\/title>/);
assert.match(master, />v3\.6<\/span>/);
assert.match(itemManager, /<title>상품 기초정보 관리<\/title>/);
assert.match(itemManager, /<nexus-top app-id="item-manager">[\s\S]*?<\/nexus-top>/);
assert.match(itemManager, /\/nexus\/common\/apps-config\.js\?v=1\.1\.0/);
assert.match(itemManager, /\/nexus\/common\/nexus-top\.js\?v=1\.1\.0/);
assert.doesNotMatch(itemManager, /\{ id: 'pipeline'|\{ id: 'parser'|\{ id: 'inventory'/, "Item Manager must use the shared NEXUS header instead of a duplicate app shortcut menu");
assert.match(dashboard, /Dashboard \[v2\.1 AppRoutes\]/);
assert.match(dashboard, />v2\.1<\/span>/);

const publicOrderQ = read("orders.html");
const compatibilityOrderQ = read("orderops_list.html");
const canonicalOrderQ = read("orderops/list.html");
assert.equal(publicOrderQ, compatibilityOrderQ, "public ORDER Q entry points must remain byte-identical");
for (const [name, source] of [
  ["orders.html", publicOrderQ],
  ["orderops_list.html", compatibilityOrderQ],
  ["orderops/list.html", canonicalOrderQ],
]) {
  assert.match(source, /<nexus-top app-id="orderq">[\s\S]*?<\/nexus-top>/, `${name} must load NEXUS TOP`);
  assert.match(source, /\/nexus\/common\/nexus-top\.js\?v=1\.1\.0/, `${name} must use the shared NEXUS TOP component`);
  assert.match(source, /NEXUS 메뉴를 불러오지 못했습니다/, `${name} must reserve a failure-isolated NEXUS fallback`);
  assert.match(source, /brand-badge">v1\.63</, `${name} must show the current ORDER Q version`);
}

const nexusApps = [
  ["Master.html", "master"],
  ["Item_manager.html", "item-manager"],
  ["MerchOps.html", "merchops"],
  ["SmartParser.html", "smart-parser"],
  ["DataOps.html", "dataops"],
];
for (const [name, appId] of nexusApps) {
  const source = read(name);
  assert.match(source, new RegExp(`<nexus-top app-id="${appId}">[\\s\\S]*?<\\/nexus-top>`), `${name} must declare its app-id`);
  assert.match(source, /\/nexus\/common\/apps-config\.js\?v=1\.1\.0/, `${name} must load shared app configuration`);
  assert.match(source, /\/nexus\/common\/nexus-top\.js\?v=1\.1\.0/, `${name} must load NEXUS TOP`);
  assert.match(source, /NEXUS 메뉴를 불러오지 못했습니다/, `${name} must keep working when the common header fails`);
}

const nexusConfig = read("nexus/common/apps-config.js");
const context = { window: {} };
vm.runInNewContext(nexusConfig, context);
const groups = Array.from(context.window.NEXUS_GROUPS, (group) => ({ ...group }));
const apps = Array.from(context.window.NEXUS_APPS, (app) => ({ ...app }));
assert.deepEqual(groups.map((group) => group.id), ["shipping", "inventory", "pricing", "foundation"], "NEXUS work groups must use the approved default order");
assert.deepEqual(groups.map((group) => group.name), ["출고관리", "재고관리", "시세관리", "기초등록"]);
assert.deepEqual(apps.filter((app) => app.groupId === "shipping").map((app) => app.id), ["orderq", "orderops", "orderin"]);
assert.deepEqual(apps.filter((app) => app.groupId === "inventory").map((app) => app.id), ["dataops"]);
assert.deepEqual(apps.filter((app) => app.groupId === "pricing").map((app) => app.id), ["merchops", "smart-parser"]);
assert.deepEqual(apps.filter((app) => app.groupId === "foundation").map((app) => app.id), ["master", "item-manager", "customer-manager"]);

const nexusTop = read("nexus/common/nexus-top.js");
assert.match(nexusTop, /normal: 0, progress: 1, warning: 2, error: 3/, "status priority must be error > warning > progress > normal");
assert.match(nexusTop, /nexus:before-navigate/, "app navigation must provide the current app's leave-guard contract");
assert.match(nexusTop, /이 기기에만 적용됨/, "failed preference persistence must keep the local visual state and offer retry");
assert.match(nexusTop, /!hiddenGroups\.includes\(group\.id\) \|\| group\.id === this\.currentGroupId/, "a hidden current group must remain temporarily visible");
assert.match(nexusTop, /현재 앱이 전달한 저장·동기화 상태만 실시간으로 표시합니다/, "the header must not infer other apps' live status");

console.log("NEXES application routing tests passed.");
