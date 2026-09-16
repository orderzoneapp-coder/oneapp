#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const host = require('../nexus/workspace.js');
const workspaceHref = 'https://example.test/nexus/workspace.html';
const siteRoot = 'https://example.test/';

assert.equal(host.VERSION, '1.2.2');
assert.equal(host.SCHEMA_VERSION, 'nexus-workspace-message/v1');
assert.deepEqual(host.APPS.map(({ id, label, path }) => ({ id, label, path })), [
  { id: 'master-lookup', label: '상품관리', path: 'Master.html' },
  { id: 'customer-master', label: '거래처관리', path: 'customer-master/index.html' },
  { id: 'smart-input', label: '스마트입력', path: 'smartinput/index.html' },
  { id: 'smart-parser', label: '스마트파서', path: 'SmartParser.html' },
  { id: 'merchops', label: 'MerchOps', path: 'MerchOps.html' },
  { id: 'orderops', label: '출고관리', path: 'orderops/list.html' },
  { id: 'dataops', label: 'DataOps', path: 'DataOps.html' },
]);

for (const app of host.APPS) {
  const target = host.headerTargetFromAnchor({
    href: new URL(app.path, siteRoot).href,
    dataset: { nexusUiAppTarget: app.id, nexusUiRoute: app.path },
  }, siteRoot, 'https://example.test');
  assert.equal(target.ok, true, `${app.label}: the visible header button must resolve from its own canonical href`);
  assert.equal(target.app.id, app.id);
  assert.equal(target.route, app.path);
}
assert.deepEqual(
  host.headerTargetFromAnchor({
    href: 'https://example.test/smartinput/index.html',
    dataset: { nexusUiAppTarget: 'orderops', nexusUiRoute: 'orderops/list.html' },
  }, siteRoot, 'https://example.test'),
  { ok: false, code: 'HEADER_ROUTE_MISMATCH', message: '헤더 버튼 경로가 등록 정보와 일치하지 않습니다.' },
  'a displayed OrderOps control must never fall through to the SmartInput href',
);
assert.deepEqual(
  host.headerTargetFromAnchor({
    href: 'https://example.test/orderops/list.html',
    dataset: { nexusUiAppTarget: 'orderops', nexusUiRoute: 'smartinput/index.html' },
  }, siteRoot, 'https://example.test'),
  { ok: false, code: 'HEADER_ROUTE_MISMATCH', message: '헤더 버튼 경로가 등록 정보와 일치하지 않습니다.' },
  'a stale or mismatched declared header route must be rejected',
);

const empty = host.parseHostRequest('', workspaceHref);
assert.equal(empty.ok, true, 'an empty host route must use the product-management entry');
assert.equal(empty.route, 'Master.html');

const order = host.parseHostRequest('?app=orderops&route=orderops%2Flist.html%3ForderId%3DORDER-1%26focus%3Dnote', workspaceHref);
assert.equal(order.ok, true);
assert.equal(order.url, 'https://example.test/orderops/list.html?orderId=ORDER-1&focus=note');
assert.equal(order.route, 'orderops/list.html?orderId=ORDER-1&focus=note');

for (const [appId, route] of [
  ['master-lookup', 'Item_manager.html?itemId=SKU-1'],
  ['customer-master', 'history_viewer.html?scope=customer'],
  ['smart-input', 'orderq/index.html?focus=ORDER-1'],
  ['smart-parser', 'settings.html?tab=parser'],
  ['merchops', 'export_center.html?source=merchops'],
  ['orderops', 'orderq/index.html?orderId=ORDER-1'],
  ['dataops', 'export_center.html?source=dataops'],
]) {
  const result = host.validateRoute(appId, route, siteRoot, 'https://example.test');
  assert.equal(result.ok, true, `${appId}/${route} must be approved`);
}

for (const [appId, route, code] of [
  ['unknown', 'Master.html', 'UNKNOWN_APP'],
  ['master-lookup', 'https://attacker.test/Master.html', 'ROUTE_NOT_ALLOWED'],
  ['master-lookup', 'javascript:alert(1)', 'ROUTE_NOT_ALLOWED'],
  ['master-lookup', 'data:text/html,hello', 'ROUTE_NOT_ALLOWED'],
  ['master-lookup', 'customer-master/index.html', 'ROUTE_NOT_ALLOWED'],
  ['master-lookup', 'nexus/../customer-master/index.html', 'ROUTE_NOT_ALLOWED'],
  ['dataops', 'MerchOps.html', 'ROUTE_NOT_ALLOWED'],
  ['orderops', 'history_viewer.html', 'ROUTE_NOT_ALLOWED'],
]) {
  const result = appId === 'unknown'
    ? host.parseHostRequest(`?app=${appId}&route=${encodeURIComponent(route)}`, workspaceHref)
    : host.validateRoute(appId, route, siteRoot, 'https://example.test');
  assert.equal(result.ok, false, `${appId}/${route} must be rejected`);
  assert.equal(result.code, code);
}

const workspaceUrl = new URL(host.workspaceUrlFor(order, workspaceHref));
assert.equal(workspaceUrl.pathname, '/nexus/workspace.html');
assert.equal(workspaceUrl.searchParams.get('app'), 'orderops');
assert.equal(workspaceUrl.searchParams.get('route'), 'orderops/list.html?orderId=ORDER-1&focus=note');

const projectPages = host.parseHostRequest('?app=dataops&route=DataOps.html%3Fview%3Dstock', 'https://example.test/oneapp/nexus/workspace.html');
assert.equal(projectPages.ok, true, 'a project-site base path must remain inside its site root');
assert.equal(projectPages.url, 'https://example.test/oneapp/DataOps.html?view=stock');
assert.equal(projectPages.route, 'DataOps.html?view=stock', 'the parent route must stay relative to the project-site root');

const source = {};
const validEvent = {
  origin: 'https://example.test',
  source,
  data: {
    schemaVersion: host.SCHEMA_VERSION,
    type: host.MESSAGE_TYPES.APP_READY,
    transitionId: 'transition-1',
    appId: 'master-lookup',
  },
};
const messageOptions = { origin: 'https://example.test', source, transitionId: 'transition-1' };
assert.equal(host.validateMessageEvent(validEvent, messageOptions), true);
assert.equal(host.validateMessageEvent({ ...validEvent, origin: 'https://attacker.test' }, messageOptions), false, 'foreign origin must be ignored');
assert.equal(host.validateMessageEvent({ ...validEvent, source: {} }, messageOptions), false, 'foreign window must be ignored');
assert.equal(host.validateMessageEvent({ ...validEvent, data: { ...validEvent.data, transitionId: 'stale' } }, messageOptions), false, 'stale transitions must be ignored');
assert.equal(host.validateMessageEvent({ ...validEvent, data: { ...validEvent.data, type: 'UNKNOWN' } }, messageOptions), false, 'unknown message types must be ignored');
assert.equal(host.validateMessageEvent({ ...validEvent, data: { ...validEvent.data, appId: 'unknown' } }, messageOptions), false, 'unknown message app IDs must be ignored');

const [html, css, js, commonUi, architecture] = await Promise.all([
  readFile('nexus/workspace.html', 'utf8'),
  readFile('nexus/workspace.css', 'utf8'),
  readFile('nexus/workspace.js', 'utf8'),
  readFile('nexus/common/nexus-ui.js', 'utf8'),
  readFile('APP_ARCHITECTURE.md', 'utf8'),
]);

assert.match(html, /id="nexusWorkspaceFrame"/);
assert.match(html, /common\/nexus-ui-theme-init\.js\?v=1\.3\.0/);
assert.match(html, /common\/nexus-ui\.js\?v=1\.8\.0/);
assert.equal((html.match(/<iframe\b/g) || []).length, 1, 'the host must own exactly one iframe');
assert.match(html, /독립 앱으로 열기/);
assert.match(html, /다시 시도/);
assert.match(html, /이전 앱으로 돌아가기/);
assert.match(css, /height:\s*calc\(100dvh - var\(--nexus-ui-header-height/);
assert.match(js, /event\.origin !== options\.origin/);
assert.match(js, /event\.source !== options\.source/);
assert.match(js, /data\.transitionId !== options\.transitionId/);
assert.match(js, /history\.replaceState/);
assert.match(js, /history\.pushState/);
assert.match(js, /NEXUS_WORKSPACE_BEFORE_LEAVE_V1/);
assert.match(js, /NEXUS_WORKSPACE_BRIDGE_READY_V1/);
assert.match(js, /NEXUS_WORKSPACE_CANCEL_V1/);
assert.match(js, /NEXUS_WORKSPACE_PRINT_V1/);
assert.doesNotMatch(js, /\bfetch\s*\(|indexedDB|localStorage\.setItem|sessionStorage\.setItem|google\.script/, 'the host must not read or write business/runtime data');
assert.match(commonUi, /id:\s*'master-lookup'[\s\S]*id:\s*'customer-master'[\s\S]*id:\s*'smart-input'[\s\S]*id:\s*'smart-parser'[\s\S]*id:\s*'merchops'[\s\S]*id:\s*'orderops'[\s\S]*id:\s*'dataops'/);
assert.match(architecture, /글로벌 탭은 상품관리·거래처관리·스마트입력·스마트파서·MerchOps·출고관리·DataOps로 고정/);

const createRecoveryHost = ({ historyMode = 'push', restoreTarget = empty, popstate = null } = {}) => {
  const instance = Object.create(host.WorkspaceHost.prototype);
  const historyCalls = [];
  const goCalls = [];
  instance.window = {
    clearTimeout() {},
    setTimeout(callback) { instance.timeoutCallback = callback; return 1; },
    crypto: { randomUUID: () => 'unit-transition' },
    history: { go: (delta) => goCalls.push(delta) },
  };
  instance.document = {
    documentElement: { dataset: {} },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  instance.loading = { hidden: true };
  instance.loadingText = { textContent: '' };
  instance.error = { hidden: true };
  instance.errorMessage = { textContent: '' };
  instance.notice = { hidden: true, textContent: '' };
  instance.standalone = { href: '' };
  instance.frame = { contentWindow: { postMessage() {} }, focus() {} };
  instance.currentTarget = restoreTarget;
  instance.loadingTarget = order;
  instance.retryTarget = order;
  instance.failedLoad = null;
  instance.frameReady = false;
  instance.transitionRunning = false;
  instance.pendingExit = null;
  instance.queuedNavigation = null;
  instance.pendingLeave = null;
  instance.pendingLoad = { historyMode, restoreTarget, popstate, timer: 1, resolve() {} };
  instance.historyIndex = popstate?.fromIndex || 0;
  instance.historyRestore = null;
  instance.historyRetry = null;
  instance.commitHistory = (target, mode) => historyCalls.push({ target, mode });
  instance.setActiveHeader = () => {};
  instance.showLoadError = (message, target) => { instance.lastLoadError = { message, target }; };
  return { instance, historyCalls, goCalls };
};

{
  const { instance, historyCalls } = createRecoveryHost({ historyMode: 'push' });
  instance.failLoad('push failed');
  assert.equal(instance.failedLoad.historyMode, 'push', 'a failed pushed navigation must retain push for retry');
  assert.equal(instance.failedLoad.target, order);
  assert.equal(instance.failedLoad.restoreTarget, empty);
  assert.deepEqual(historyCalls, [], 'a failed pushed navigation must keep the previous parent URL');
  let retried;
  instance.loadTarget = (target, options) => { retried = { target, options }; return Promise.resolve(true); };
  instance.retryCurrentTarget();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retried.target, order);
  assert.equal(retried.options.historyMode, 'push', 'retry must not downgrade a pushed navigation to replace');
  assert.equal(retried.options.popstate, null);
}

{
  const popstate = { fromIndex: 2, toIndex: 1 };
  const { instance, historyCalls, goCalls } = createRecoveryHost({ historyMode: 'none', popstate });
  instance.failLoad('popstate failed');
  assert.deepEqual(historyCalls, [], 'a failed indexed popstate load must not replace either history entry');
  assert.deepEqual(goCalls, [1], 'a failed popstate load must return to the exact previous history index');
  instance.onPopState({ state: { nexusWorkspaceIndex: 2 } });
  assert.equal(instance.historyIndex, 2);
  let retried;
  instance.loadTarget = (target, options) => { retried = { target, options }; return Promise.resolve(true); };
  instance.retryCurrentTarget();
  assert.deepEqual(goCalls, [1, -1], 'popstate retry must revisit the original target entry');
  instance.onPopState({ state: { nexusWorkspaceIndex: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retried.options.historyMode, 'none', 'popstate retry must retain its original no-new-entry mode');
  assert.deepEqual(retried.options.popstate, popstate);
}

{
  const { instance } = createRecoveryHost({ historyMode: 'push' });
  instance.failLoad('target failed');
  let selected;
  instance.loadTarget = (target, options) => { selected = { target, options }; return Promise.resolve(true); };
  const dataOps = host.validateRoute('dataops', '', siteRoot, 'https://example.test');
  await instance.requestNavigation(dataOps, 'push');
  assert.equal(selected.target, dataOps, 'a different app selection must recover from a failed target without another before-leave request');
  assert.equal(selected.options.historyMode, 'push');
}

{
  const { instance, historyCalls } = createRecoveryHost({ historyMode: 'push' });
  instance.loadingTarget = null;
  instance.pendingLoad = null;
  instance.failedLoad = null;
  instance.frameReady = true;
  instance.historyRestore = null;
  instance.historyRetry = null;
  let postCount = 0;
  instance.post = () => { postCount += 1; return true; };
  instance.loading.hidden = true;
  const leave = instance.beforeLeave();
  assert.equal(postCount, 1, 'before-leave must issue one request');
  assert.equal(instance.loading.hidden, true, 'before-leave must keep the current app visible while it saves');
  instance.timeoutCallback();
  assert.deepEqual(await leave, { result: 'ERROR', message: '저장 확인 시간이 초과되어 화면 이동을 취소했습니다.' });
  assert.equal(instance.currentTarget, empty, 'leave timeout must preserve the current target');
  assert.deepEqual(historyCalls, [], 'leave timeout alone must not alter the current parent URL');
}

{
  const { instance, historyCalls } = createRecoveryHost({ historyMode: 'push' });
  instance.loadingTarget = null;
  instance.pendingLoad = null;
  instance.frameReady = true;
  instance.historyRestore = null;
  instance.historyRetry = null;
  instance.beforeLeave = () => Promise.resolve({ result: 'ERROR', message: 'save failed' });
  instance.showNotice = (message) => { instance.lastNotice = message; };
  let loadCount = 0;
  instance.loadTarget = () => { loadCount += 1; return Promise.resolve(true); };
  await instance.requestNavigation(order, 'push');
  assert.equal(loadCount, 0, 'leave ERROR must not replace the current iframe');
  assert.equal(instance.currentTarget, empty, 'leave ERROR must preserve the current target');
  assert.deepEqual(historyCalls, [], 'leave ERROR on a pushed request must preserve the current URL');
  assert.equal(instance.loading.hidden, true, 'leave ERROR must dismiss the saving progress overlay');
  assert.equal(instance.lastNotice, 'save failed');
}

{
  const { instance } = createRecoveryHost({ historyMode: 'push' });
  instance.loadingTarget = null;
  instance.pendingLoad = null;
  instance.frameReady = true;
  instance.setPendingHeader = () => {};
  let finishLeave;
  let leaveCount = 0;
  instance.beforeLeave = () => {
    leaveCount += 1;
    return new Promise((resolve) => { finishLeave = resolve; });
  };
  let assigned = '';
  instance.window.location = { assign: (href) => { assigned = href; } };
  let selected = null;
  instance.loadTarget = (target) => { selected = target; return Promise.resolve('ready'); };

  const exit = instance.requestExit('https://example.test/nexus/');
  await instance.requestNavigation(order, 'push');
  finishLeave({ result: 'READY' });
  await exit;

  assert.equal(assigned, '', 'a later app selection must supersede an exit that is still waiting for save');
  assert.equal(selected, order, 'the last selected app must load after the pending save completes');
  assert.equal(leaveCount, 1, 'an approved leave must not be repeated when the exit is replaced by an app selection');
}

{
  const { instance } = createRecoveryHost({ historyMode: 'push' });
  instance.loadingTarget = null;
  instance.pendingLoad = null;
  instance.frameReady = true;
  instance.setPendingHeader = () => {};
  let finishLeave;
  instance.beforeLeave = () => new Promise((resolve) => { finishLeave = resolve; });
  let assigned = '';
  instance.window.location = { assign: (href) => { assigned = href; } };

  const exit = instance.requestExit('https://example.test/nexus/');
  await instance.requestNavigation(empty, 'push');
  finishLeave({ result: 'READY' });
  await exit;

  assert.equal(assigned, '', 'reselecting the current app must cancel an exit that is still waiting for save');
  assert.equal(instance.currentTarget, empty);
}

// Exercise the real class through the failed-popstate/reconnect interleaving.
// Timers and browser history are driven explicitly; no elapsed-time race is needed.
const createReconnectHost = () => {
  const merch = host.validateRoute('merchops', '', siteRoot, 'https://example.test');
  const data = host.validateRoute('dataops', '', siteRoot, 'https://example.test');
  const elements = new Map();
  const timers = new Map();
  const messages = [];
  const historyCalls = [];
  const goCalls = [];
  let sequence = 0;
  const windowObject = {
    location: new URL(host.workspaceUrlFor(merch, workspaceHref)),
    crypto: { randomUUID: () => `reconnect-${++sequence}` },
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    history: {
      state: { nexusWorkspaceIndex: 2 },
      go(delta) { goCalls.push(delta); },
      replaceState(state, _, url) { historyCalls.push({ mode: 'replace', state, url }); windowObject.location = new URL(url); },
      pushState(state, _, url) { historyCalls.push({ mode: 'push', state, url }); windowObject.location = new URL(url); },
    },
  };
  const documentObject = {
    documentElement: { dataset: {} },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', href: '' });
      return elements.get(id);
    },
  };
  const instance = new host.WorkspaceHost(windowObject, documentObject);
  instance.frame.classList = { add() {}, remove() {} };
  instance.frame.focus = () => {};
  instance.frame.hasAttribute = () => true;
  instance.frame.contentWindow = {
    location: { href: merch.url, replace(url) { commitFrameDocument(url); } },
    postMessage(message) { messages.push(message); },
  };
  const commitFrameDocument = (url) => {
    const frameDocument = { URL: url };
    instance.frame.contentWindow.location.href = url;
    instance.frame.contentWindow.document = frameDocument;
    instance.frame.contentDocument = frameDocument;
    return frameDocument;
  };
  commitFrameDocument(merch.url);
  instance.currentTarget = merch;
  instance.frameReady = true;
  const receive = (type, transitionId, target = merch) => instance.onMessage({
    origin: 'https://example.test', source: instance.frame.contentWindow,
    data: { schemaVersion: host.SCHEMA_VERSION, type, transitionId, appId: target.app.id, route: target.route },
  });
  const failAndReconnect = () => {
    windowObject.location = new URL(host.workspaceUrlFor(data, workspaceHref));
    instance.beginHandshake(data, { historyMode: 'none', restoreTarget: merch, popstate: { fromIndex: 2, toIndex: 1 } });
    instance.failLoad('DataOps failed');
    const recovery = instance.failedLoad;
    instance.retryCurrentTarget();
    assert.deepEqual(goCalls, [1], 'early retry must not race the history restoration');
    assert.equal(instance.historyRetry, null);
    windowObject.location = new URL(host.workspaceUrlFor(merch, workspaceHref));
    instance.onPopState({ state: { nexusWorkspaceIndex: 2 } });
    instance.onFrameLoad();
    assert.equal(instance.pendingLoad.preserveFailedLoad, recovery);
    assert.equal(instance.error.hidden, false);
    assert.equal(instance.transitionRunning, false, 'the reconnect is not a queued navigation');
    return recovery;
  };
  return { instance, merch, data, windowObject, timers, messages, historyCalls, goCalls, receive, failAndReconnect, commitFrameDocument };
};

{
  const { instance, data, windowObject, timers, historyCalls, goCalls, receive, failAndReconnect } = createReconnectHost();
  const recovery = failAndReconnect();
  const reconnectId = instance.loadTransitionId;
  const staleTimeout = timers.get(instance.pendingLoad.timer);
  assert.equal(instance.failedLoad, recovery, 'reconnect must keep the failed DataOps target available throughout the handshake');
  assert.equal(instance.standalone.href, data.url, 'the error fallback must still address the failed app');
  instance.retryCurrentTarget();
  assert.deepEqual(goCalls, [1, -1], 'early reconnect retry must revisit the original failed history entry');
  assert.equal(instance.pendingLoad, null, 'retry must cancel the restored-app handshake before moving browser history');
  assert.equal(instance.historyRetry, recovery);
  receive(host.MESSAGE_TYPES.APP_READY, reconnectId);
  receive(host.MESSAGE_TYPES.ROUTE_CHANGED, reconnectId);
  assert.deepEqual(historyCalls, [], 'late reconnect signals must not replace the entry being retried');
  instance.retryCurrentTarget();
  assert.deepEqual(goCalls, [1, -1], 'double retry must not issue a competing history traversal');
  windowObject.location = new URL(host.workspaceUrlFor(data, workspaceHref));
  instance.onPopState({ state: { nexusWorkspaceIndex: 1 } });
  assert.equal(instance.loadingTarget, data);
  assert.equal(instance.pendingLoad.historyMode, 'none');
  staleTimeout();
  receive(host.MESSAGE_TYPES.APP_ERROR, reconnectId);
  receive(host.MESSAGE_TYPES.APP_READY, reconnectId);
  assert.equal(instance.loadingTarget, data, 'stale reconnect timeout/error/ready must not alter the new retry');
  instance.onFrameLoad();
  receive(host.MESSAGE_TYPES.APP_READY, instance.loadTransitionId, data);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instance.currentTarget, data);
  assert.equal(instance.historyIndex, 1);
  assert.equal(instance.failedLoad, null);
  assert.equal(instance.error.hidden, true);
  assert.deepEqual(historyCalls, [], 'retry success must preserve the original history entries');
}

{
  const { instance, data, failAndReconnect } = createReconnectHost();
  const recovery = failAndReconnect();
  instance.failLoad('restored app reconnect failed');
  assert.equal(instance.failedLoad, recovery, 'a reconnect failure must not replace the original failed target/history');
  assert.equal(instance.standalone.href, data.url);
}

{
  const { instance, receive, historyCalls, failAndReconnect } = createReconnectHost();
  failAndReconnect();
  const reconnectId = instance.loadTransitionId;
  const navigation = instance.requestNavigation(order, 'push');
  await Promise.resolve();
  assert.equal(instance.loadingTarget, order, 'a competing tab selection must drain the queue after cancelling an unowned reconnect');
  const newId = instance.loadTransitionId;
  instance.retryCurrentTarget();
  assert.equal(instance.loadTransitionId, newId, 'a stale retry click must not supersede the newer app selection');
  receive(host.MESSAGE_TYPES.APP_READY, reconnectId);
  assert.deepEqual(historyCalls, []);
  instance.onFrameLoad();
  receive(host.MESSAGE_TYPES.APP_READY, newId, order);
  await navigation;
  assert.equal(instance.currentTarget, order);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].mode, 'push');
}

{
  const { instance, merch, data, windowObject, historyCalls, goCalls, receive, failAndReconnect, commitFrameDocument } = createReconnectHost();
  failAndReconnect();
  const deliveries = [];
  const requestedUrls = [];
  // A browser navigation request does not synchronously replace the active
  // document. Keep restored MerchOps alive until DataOps actually commits.
  instance.frame.contentWindow.location.replace = (url) => { requestedUrls.push(url); };
  instance.frame.contentWindow.postMessage = (message) => {
    deliveries.push({ message, documentUrl: instance.frame.contentWindow.location.href });
  };
  instance.retryCurrentTarget();
  windowObject.location = new URL(host.workspaceUrlFor(data, workspaceHref));
  instance.onPopState({ state: { nexusWorkspaceIndex: 1 } });
  const retryId = instance.loadTransitionId;
  assert.deepEqual(goCalls, [1, -1]);
  assert.deepEqual(requestedUrls, [data.url]);
  assert.equal(instance.loadingTarget, data);
  assert.equal(instance.frame.contentWindow.location.href, merch.url);

  // The restored document's late load arrives after retry has started. The
  // child bridge rejects HOST_READY addressed to another app, so this load
  // must not consume the DataOps transition's one permitted HOST_READY.
  instance.onFrameLoad();
  assert.equal(instance.frameDocumentLoaded, false, 'a stale load from another URL must not mark the retry document loaded');
  assert.equal(deliveries.some(({ message }) => message.type === host.MESSAGE_TYPES.HOST_READY), false);
  assert.equal(instance.loadingTarget, data);
  assert.deepEqual(historyCalls, []);
  commitFrameDocument(data.url);
  receive(host.MESSAGE_TYPES.BRIDGE_READY, '', data);
  instance.onFrameLoad();
  receive(host.MESSAGE_TYPES.BRIDGE_READY, '', data);
  const readyDeliveries = deliveries.filter(({ message }) => message.type === host.MESSAGE_TYPES.HOST_READY);
  assert.deepEqual(
    readyDeliveries.map(({ message, documentUrl }) => ({ appId: message.appId, transitionId: message.transitionId, documentUrl })),
    [{ appId: 'dataops', transitionId: retryId, documentUrl: data.url }],
    'a stale restored-frame load must not consume HOST_READY before the actual retry target document connects',
  );
  receive(host.MESSAGE_TYPES.APP_READY, retryId, data);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instance.currentTarget, data);
  assert.equal(instance.frameReady, true);
  assert.equal(instance.loading.hidden, true);
  assert.equal(instance.error.hidden, true);
  assert.equal(instance.historyIndex, 1);
  assert.deepEqual(historyCalls, [], 'the recovered handshake must retain both original parent history entries');
}

{
  const { instance, merch, data, windowObject, messages, historyCalls, receive } = createReconnectHost();
  const previousParentUrl = windowObject.location.href;
  let handshakeCount = 0;
  const beginHandshake = instance.beginHandshake.bind(instance);
  instance.beginHandshake = (...args) => { handshakeCount += 1; return beginHandshake(...args); };
  const loading = instance.loadTarget(data, { historyMode: 'push' });
  const transitionId = instance.loadTransitionId;
  const targetDocument = instance.frame.contentDocument;
  receive(host.MESSAGE_TYPES.BRIDGE_READY, '', data);
  assert.equal(instance.frameDocumentLoaded, false, 'bridge execution must not stand in for the native document load');
  receive(host.MESSAGE_TYPES.APP_READY, transitionId, data);
  assert.equal(instance.currentTarget, merch, 'APP_READY before native load must not commit the app transition');
  assert.equal(instance.loadingTarget, data);
  assert.equal(instance.frameReady, false);
  assert.equal(instance.loading.hidden, false);
  assert.equal(windowObject.location.href, previousParentUrl);
  assert.deepEqual(historyCalls, [], 'early APP_READY must not push or replace parent history');

  instance.onFrameLoad();
  assert.equal(await loading, 'ready');
  assert.equal(instance.currentTarget, data);
  assert.equal(instance.frame.contentDocument, targetDocument);
  assert.equal(instance.frameReady, true);
  assert.equal(instance.loading.hidden, true);
  assert.equal(instance.pendingLoad, null);
  assert.equal(historyCalls.length, 1, 'matching native load and APP_READY must complete exactly once');
  assert.equal(historyCalls[0].mode, 'push');
  assert.equal(new URL(historyCalls[0].url).searchParams.get('app'), 'dataops');

  instance.onFrameLoad();
  instance.onFrameLoad();
  receive(host.MESSAGE_TYPES.BRIDGE_READY, '', data);
  receive(host.MESSAGE_TYPES.APP_READY, transitionId, data);
  assert.equal(handshakeCount, 1, 'late native load for the already-ready Document must not reconnect');
  assert.equal(instance.loadTransitionId, transitionId);
  assert.equal(instance.pendingLoad, null);
  assert.equal(instance.loadingTarget, null);
  assert.equal(instance.frameReady, true);
  assert.equal(instance.loading.hidden, true);
  assert.equal(historyCalls.length, 1, 'duplicate same-document signals must not change parent history again');
  assert.equal(messages.filter((message) => message.type === host.MESSAGE_TYPES.HOST_READY).length, 1);
  assert.equal(messages.filter((message) => message.type === host.MESSAGE_TYPES.THEME).length, 1);
}

for (const readyBeforeNativeLoad of [true, false]) {
  const { instance, merch, data, timers, messages, historyCalls, receive, commitFrameDocument } = createReconnectHost();
  const loading = instance.loadTarget(data, { historyMode: 'push' });
  const previousTransitionId = instance.loadTransitionId;
  const previousTimerId = instance.pendingLoad.timer;
  const previousTimeout = timers.get(previousTimerId);
  const firstDocument = instance.frame.contentDocument;
  instance.onFrameLoad();
  assert.equal(instance.currentTarget, merch, 'native load alone must still wait for app readiness');
  assert.deepEqual(historyCalls, []);

  const replacementDocument = commitFrameDocument(data.url);
  assert.notEqual(replacementDocument, firstDocument, 'a same-URL reload creates a distinct Document');
  receive(host.MESSAGE_TYPES.BRIDGE_READY, '', data);
  const replacementTransitionId = instance.loadTransitionId;
  assert.notEqual(replacementTransitionId, previousTransitionId, 'a replacement Document needs its own transition ID despite the shared WindowProxy');
  assert.equal(instance.pendingLoad.transitionId, replacementTransitionId);
  assert.equal(timers.has(previousTimerId), false, 'the superseded Document timer must be cleared');
  assert.notEqual(instance.pendingLoad.timer, previousTimerId);
  assert.equal(timers.has(instance.pendingLoad.timer), true, 'the replacement Document must retain an active timeout');
  const replayPreviousSignals = () => {
    receive(host.MESSAGE_TYPES.APP_READY, previousTransitionId, data);
    receive(host.MESSAGE_TYPES.APP_ERROR, previousTransitionId, data);
    previousTimeout();
    assert.equal(instance.loadingTarget, data, 'old Document READY, ERROR and timeout must not complete or fail the replacement');
    assert.equal(instance.loadTransitionId, replacementTransitionId);
    assert.equal(instance.pendingLoad.transitionId, replacementTransitionId);
    assert.equal(instance.currentTarget, merch);
    assert.equal(instance.failedLoad, null);
    assert.equal(instance.error.hidden, true);
    assert.deepEqual(historyCalls, []);
  };
  replayPreviousSignals();
  if (readyBeforeNativeLoad) receive(host.MESSAGE_TYPES.APP_READY, replacementTransitionId, data);
  assert.equal(instance.currentTarget, merch, 'a prior Document load must not satisfy the replacement Document readiness');
  assert.equal(instance.loadingTarget, data);
  assert.equal(instance.frameReady, false);
  assert.equal(instance.loading.hidden, false);
  assert.deepEqual(historyCalls, [], 'signals from different Documents must not commit parent history');

  instance.onFrameLoad();
  if (!readyBeforeNativeLoad) {
    replayPreviousSignals();
    receive(host.MESSAGE_TYPES.APP_READY, replacementTransitionId, data);
  }
  assert.equal(await loading, 'ready');
  assert.equal(instance.currentTarget, data);
  assert.equal(instance.frame.contentDocument, replacementDocument);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].mode, 'push');
  instance.onFrameLoad();
  assert.equal(instance.loadingTarget, null);
  assert.equal(historyCalls.length, 1);
  assert.deepEqual(
    messages.filter((message) => message.type === host.MESSAGE_TYPES.HOST_READY).map((message) => message.transitionId),
    [previousTransitionId, replacementTransitionId],
    'each Document must receive exactly one HOST_READY with its own transition',
  );
}

console.log('PASS NEXUS workspace host contracts: one iframe, canonical routes, same-origin messaging, indexed history recovery, deterministic reconnect/early retry, native-load readiness ordering and stale-document safety.');
