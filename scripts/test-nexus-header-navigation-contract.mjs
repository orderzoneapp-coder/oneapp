import assert from 'node:assert/strict';
import vm from 'node:vm';
import { access, readFile } from 'node:fs/promises';

const uiSource = await readFile('nexus/common/nexus-ui.js', 'utf8');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.className = '';
    this.id = '';
    this.style = { setProperty() {} };
    this.classList = { add: (...tokens) => {
      const current = new Set(this.className.split(/\s+/).filter(Boolean));
      tokens.forEach(token => current.add(token));
      this.className = [...current].join(' ');
    } };
    this.clientWidth = 960;
    this.scrollWidth = 960;
    this.scrollLeft = 0;
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  prepend(node) { this.children.unshift(node); }
  addEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  getBoundingClientRect() { return { left: 0, width: 96 }; }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (!attribute) return false;
    const [, name, expected] = attribute;
    let actual = this.attributes.get(name);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      actual = this.dataset[key];
    }
    return expected === undefined ? actual !== undefined : String(actual) === expected;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => {
      node.children.forEach(child => {
        if (child.matches?.(selector)) result.push(child);
        visit(child);
      });
    };
    visit(this);
    return result;
  }
}

function renderHeader(rawProjection, appId = 'master-lookup') {
  const root = new FakeElement('html');
  root.dataset.nexusUiApp = appId;
  const body = new FakeElement('body');
  const document = {
    documentElement: root,
    body,
    currentScript: { src: 'https://example.test/nexus/common/nexus-ui.js' },
    readyState: 'complete',
    createElement: tag => new FakeElement(tag),
    getElementById: id => body.querySelectorAll(`[id="${id}"]`)[0] || null,
    addEventListener() {},
  };
  const sessionStorage = { getItem: key => key === 'oneapp.nexus.ui.visibility.v1' ? rawProjection : null };
  const window = {
    sessionStorage,
    location: new URL('https://example.test/Master.html'),
    ONEAPP_NEXUS_UI_THEME: { apply: value => value },
    addEventListener() {},
    dispatchEvent() {},
  };
  const context = {
    window,
    document,
    location: window.location,
    URL,
    Set,
    Map,
    Object,
    Math,
    Number,
    String,
    JSON,
    performance: { now: () => 1 },
    requestAnimationFrame: callback => callback(),
    getComputedStyle: () => ({ paddingTop: '0px' }),
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
  };
  vm.runInNewContext(uiSource, context);
  const header = body.children[0];
  return header.querySelectorAll('[data-nexus-ui-app-target]').map(link => ({
    id: link.dataset.nexusUiAppTarget,
    label: link.textContent,
    current: link.getAttribute('aria-current') === 'page',
  }));
}

const schema = 'NEXUS_UI_VISIBILITY_V1';
const projection = visibleAppIds => JSON.stringify({ schemaVersion: schema, configured: true, visibleAppIds });
const canonical = ['master-lookup', 'customer-master', 'smart-input', 'smart-parser', 'merchops', 'orderops', 'dataops'];
const allKnown = ['master-lookup', 'customer-master', 'merchops', 'smart-input', 'orderops', 'dataops', 'smart-parser', 'export-center', 'settings', 'item-manager', 'history-viewer', 'orderq-vnext'];

assert.deepEqual(renderHeader(null).map(app => app.id), canonical, 'missing projection must recover to all seven global apps');
assert.deepEqual(renderHeader(projection(allKnown)).map(app => app.id), canonical, 'all enabled IDs must project to the seven global apps in canonical order');
assert.deepEqual(renderHeader(projection(['dataops', 'item-manager', 'smart-parser'])).map(app => app.id), ['master-lookup', 'smart-parser', 'dataops'], 'valid subset must preserve canonical order and the SKU alias');
assert.deepEqual(renderHeader(projection([])).map(app => app.id), [], 'a valid all-disabled projection must render zero tabs');
assert.deepEqual(renderHeader('{bad-json').map(app => app.id), canonical, 'invalid JSON must recover to seven tabs');
assert.deepEqual(renderHeader(projection(['unknown-app'])).map(app => app.id), canonical, 'unknown IDs must recover to seven tabs');
assert.deepEqual(renderHeader(projection(['dataops', 'dataops'])).map(app => app.id), canonical, 'duplicate IDs must recover to seven tabs');
assert.deepEqual(renderHeader(projection(['item-manager', 'master-lookup'])).map(app => app.id), ['master-lookup'], 'compatibility and canonical IDs together must still render one product tab');
assert.equal(renderHeader(projection(allKnown), 'item-manager').find(app => app.id === 'master-lookup')?.current, true, 'direct SKU entry must activate the product tab');

const files = Object.fromEntries(await Promise.all([
  'orderops/list.html', 'SmartParser.html', 'guide_Merch.html', 'nexus/nexus.js', 'nexus/admin/admin.js',
  'settings.html', 'Master.html', 'MerchOps.html', 'DataOps.html', 'export_center.html',
  'orderq/index.html', 'orderq/voucher-query.js', 'orderq/voucher-activity-read-adapter.js',
  'smartinput/smartinput.js', 'trend_report.html', 'guide_data.html',
].map(async file => [file, await readFile(file, 'utf8')])));

assert.match(files['orderops/list.html'], /id="smartInputButton" href="\.\.\/smartinput\/index\.html"/, 'F01: F4 must target the official SmartInput entry');
assert.match(files['SmartParser.html'], /href: "guide_Merch\.html#part2-2"/, 'F02: SmartParser guide must target a verified section');
assert.match(files['guide_Merch.html'], /id="part2-2"[\s\S]*업무 플로우 A : 스마트 파서/, 'F02: the target guide section must exist and identify the SmartParser workflow');
assert.match(files['nexus/nexus.js'], /id: 'item-manager', label: 'SKU 관리'/, 'F03: NEXUS home must identify the compatibility tool accurately');
assert.match(files['nexus/admin/admin.js'], /id: 'item-manager', label: 'SKU 관리'/, 'F03: admin visibility must identify the compatibility tool accurately');
assert.match(files['settings.html'], /SETTINGS_RETURN_TARGETS/, 'F04: Settings must use an allowlisted return target');
assert.match(files['settings.html'], /settingsIframeMode[\s\S]*설정 패널 닫기[\s\S]*NEXUS 홈/, 'F04/F06: Settings must distinguish iframe close, app return, and NEXUS home');
assert.match(files['MerchOps.html'], /settings\.html\?returnApp=merchops/, 'F04: MerchOps must identify itself when opening Settings');
assert.match(files['DataOps.html'], /settings\.html\?returnApp=dataops/, 'F04: DataOps must identify itself when opening Settings');
assert.match(files['MerchOps.html'], /target\.searchParams\.set\('returnTo', window\.getMerchOpsReturnUrl\(\)\)/, 'F05: Export Center entry must carry current-route evidence');
assert.doesNotMatch(files['export_center.html'], /window\.history\.back\s*\(/, 'F05: Export Center must never follow unrelated browser history');
assert.doesNotMatch(files['export_center.html'], /getStoredMerchReturnUrl/, 'F05: stale stored return URLs must not drive navigation');
assert.match(files['Master.html'], /settings\.html\?mode=iframe&returnApp=master-lookup/, 'F06: Master must open Settings in explicit iframe mode');
assert.match(files['Master.html'], /ONEAPP_SETTINGS_PANEL_CLOSE_V1/, 'F06: Master must handle the dedicated close message');
assert.match(files['settings.html'], /window\.parent\.postMessage\(\{ type: 'ONEAPP_SETTINGS_PANEL_CLOSE_V1' \}/, 'F06: iframe Settings must request parent close without top navigation');
assert.doesNotMatch(files['orderq/voucher-query.js'], /전표 상세 열기/, 'F07: an already-open voucher card must not link back to the same page');
assert.match(files['orderq/voucher-query.js'], /companyContextMismatch[\s\S]*readVoucherActivity\(\{ mode: modeInput\.value, date: dateInput\.value, companyId \}\)/, 'F08: voucher query must validate and pass the app company context');
assert.match(files['orderq/voucher-activity-read-adapter.js'], /companyId=\$\{encodeURIComponent\(companyId/, 'F08: voucher links must carry scope for mismatch detection');
assert.match(files['trend_report.html'], /href="MerchOps\.html"/, 'F09: trend report must use the official relative MerchOps path');
assert.match(files['guide_data.html'], /href="DataOps\.html"/, 'F10: DataOps guide must use the official DataOps path');
assert.match(files['orderq/index.html'], /target\.searchParams\.set\('returnTo', currentOrderQueryHref\(orderId\)\)/, 'G03: ORDER Q must attach its current filtered return route');
assert.match(files['orderops/list.html'], /function orderQReturnHref[\s\S]*target\.searchParams\.set\("view", "query"\)/, 'G03: OrderOps must validate and restore the ORDER Q route');

for (const path of ['Master.html', 'customer-master/index.html', 'SmartParser.html', 'MerchOps.html', 'smartinput/index.html', 'orderops/list.html', 'DataOps.html']) {
  await access(path);
}

console.log('NEXUS seven-app header and F01-F10 navigation contracts passed.');
