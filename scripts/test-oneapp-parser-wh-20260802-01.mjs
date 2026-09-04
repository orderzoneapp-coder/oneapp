#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n');
const coreSource = read('coreEngine.js');
const smartSource = read('SmartParser.html');
const merchSource = read('MerchOps.html');
const settingsSource = read('settings.html');
const settingsOwnerSource = read('reference-data/settings-config-owner-adapter.js');
const dataOpsSource = read('DataOps.html');

for (const [label, html] of [['SmartParser', smartSource], ['MerchOps', merchSource], ['settings', settingsSource], ['DataOps', dataOpsSource]]) {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).filter((source) => source.trim());
  assert.ok(scripts.length > 0, `${label} inline scripts not found`);
  scripts.forEach((source, index) => new vm.Script(source, { filename: `${label}-inline-${index + 1}.js` }));
}
new vm.Script(coreSource, { filename: 'coreEngine.js' });

const values = new Map();
const localStorage = {
  getItem: (key) => values.get(String(key)) ?? null,
  setItem: (key, value) => values.set(String(key), String(value)),
  removeItem: (key) => values.delete(String(key)),
};
const window = { localStorage, console, crypto: { randomUUID: () => 'uuid-test' }, setTimeout, clearTimeout };
window.window = window;
vm.runInNewContext(coreSource, {
  window, console, Date, Object, Array, String, Number, Boolean, Math, JSON, Set, Map, Promise, Error, DOMException, setTimeout, clearTimeout,
}, { filename: 'coreEngine.js' });

const pricing = window.ONEAPP.PRICING;
const config = window.ONEAPP.CONFIG;
const rules = [
  { id: 'exact-first', whCode: '01', unit: 'BOX, 박스', rate: 10, type: 'divide' },
  { id: 'partial-wh', whCode: '01', unit: '*', rate: 1, type: 'multiply' },
  { id: 'default-first', whCode: '*', unit: '*', rate: 20, type: 'divide' },
  { id: 'default-duplicate', whCode: '*', unit: '*', rate: 30, type: 'divide' },
];
const sanitized = pricing.sanitizeMerchMarginRules(rules);
assert.equal(sanitized.filter((rule) => rule.whCode === '*' && rule.unit === '*').length, 1);
assert.equal(pricing.selectMerchMarginRule(rules, { _calcWarehouse: '01', _calcUnit: 'BOX' }).ruleId, 'exact-first');
assert.equal(pricing.selectMerchMarginRule(rules, { _calcWarehouse: '01', _calcUnit: 'EA' }).ruleId, 'default-first', 'partial wildcard must not override the shared default');
assert.equal(pricing.selectMerchMarginRule(rules, { _calcWarehouse: '', _calcUnit: 'BOX' }).ruleId, 'default-first');

const bundle = pricing.calculatePriceBundle(10000, { 외주비: 2000, 노무비: 1000, '1종연산': 4, 경비: 50 }, {
  _calcWarehouse: '01', _calcUnit: 'BOX',
}, rules);
assert.equal(bundle.출고가, 14400);
assert.equal(bundle.시중가, 14400);
assert.equal(bundle['1입고'], 3000);
assert.equal(bundle['1출고'], 3650);
assert.equal(bundle.pricingEvidence.marginRuleId, 'exact-first');
assert.equal(bundle.pricingEvidence.inputWarehouse, '01');
assert.equal(bundle.pricingEvidence.inputUnit, 'BOX');

const legacySentinel = JSON.stringify({ Preserve: { marginRate: 17 } });
localStorage.setItem('parserListMarginRules_v1', legacySentinel);
config.writeParserCatalogWarehouseMap({ ' Cat A ': ' 01 ', Blank: '' });
assert.equal(config.readParserCatalogWarehouseMap()['Cat A'], '01');
assert.equal(localStorage.getItem('parserListMarginRules_v1'), legacySentinel, 'unrelated legacy data must remain byte-for-byte unchanged');

assert.match(smartSource, /getParserPriceSelection\(catalogWarehouse, finalUnit, marginRules\)/);
assert.match(smartSource, /ruleEvidence/);
assert.match(smartSource, /catalogWarehouse/);
assert.match(smartSource, /originalKind/);
assert.match(smartSource, /ZERO_PRICE/);
assert.match(smartSource, /stopRecommendation:\s*zeroPrice \|\| row\._isSoldOut === true/);
assert.match(smartSource, /proposedChanges:\s*zeroPrice \? proposals\.filter/);
assert.doesNotMatch(smartSource, /zeroPrice[\s\S]{0,300}commitSmartParserStopManagement/);

assert.match(merchSource, /v2\.1\.195_ProductRegistration/);
assert.doesNotMatch(merchSource, /v2\.1\.178_CIBaselineContractRestore/);
assert.match(merchSource, /installMerchOpsOwnerBoundary/);
assert.match(merchSource, /F8\uC740 \uB9C8\uC2A4\uD130\u00B7\uD788\uC2A4\uD1A0\uB9AC\uB97C \uBCC0\uACBD\uD558\uC9C0 \uC54A\uB294\uB2E4/);
assert.match(merchSource, /F9 \uCD9C\uB825\uAC80\uC99D/);
assert.match(merchSource, /product-master-command-adapter\.js/);

assert.match(settingsOwnerSource, /parserCatalogWarehouseMap_v1/);
assert.match(settingsSource, /navigateToOwner\('SmartParser\.html'\)/);
assert.doesNotMatch(settingsSource, /writeParserCatalogWarehouseMap/);
assert.match(settingsSource, /addEventListener\('storage'/);
assert.match(dataOpsSource, /masterAddUpdate\.js/);
assert.doesNotMatch(dataOpsSource, /SmartParserStopManagement/);

console.log('PASS test-oneapp-parser-wh-20260802-01');
