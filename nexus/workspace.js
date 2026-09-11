(function bootstrapWorkspace(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  root.ONEAPP_NEXUS_WORKSPACE = Object.freeze(api);
  api.mount();
})(typeof window === 'object' ? window : globalThis, () => {
  'use strict';

  const VERSION = '1.0.0';
  const SCHEMA_VERSION = 'nexus-workspace-message/v1';
  const HANDSHAKE_TIMEOUT_MS = 8000;
  const LEAVE_TIMEOUT_MS = 12000;
  const MESSAGE_TYPES = Object.freeze({
    HOST_READY: 'NEXUS_WORKSPACE_HOST_READY_V1',
    APP_READY: 'NEXUS_WORKSPACE_APP_READY_V1',
    NAVIGATE: 'NEXUS_WORKSPACE_NAVIGATE_V1',
    ROUTE_CHANGED: 'NEXUS_WORKSPACE_ROUTE_CHANGED_V1',
    BEFORE_LEAVE: 'NEXUS_WORKSPACE_BEFORE_LEAVE_V1',
    LEAVE_RESULT: 'NEXUS_WORKSPACE_LEAVE_RESULT_V1',
    THEME: 'NEXUS_WORKSPACE_THEME_V1',
    PRINT: 'NEXUS_WORKSPACE_PRINT_V1',
  });
  const INBOUND_TYPES = new Set([
    MESSAGE_TYPES.APP_READY,
    MESSAGE_TYPES.NAVIGATE,
    MESSAGE_TYPES.ROUTE_CHANGED,
    MESSAGE_TYPES.LEAVE_RESULT,
  ]);
  const APPS = Object.freeze([
    Object.freeze({ id: 'master-lookup', label: '상품관리', path: 'Master.html' }),
    Object.freeze({ id: 'customer-master', label: '거래처관리', path: 'customer-master/index.html' }),
    Object.freeze({ id: 'smart-input', label: '스마트입력', path: 'smartinput/index.html' }),
    Object.freeze({ id: 'smart-parser', label: '스마트파서', path: 'SmartParser.html' }),
    Object.freeze({ id: 'merchops', label: 'MerchOps', path: 'MerchOps.html' }),
    Object.freeze({ id: 'orderops', label: '출고관리', path: 'orderops/list.html' }),
    Object.freeze({ id: 'dataops', label: 'DataOps', path: 'DataOps.html' }),
  ]);
  const APP_BY_ID = new Map(APPS.map((app) => [app.id, app]));

  const appForId = (value) => APP_BY_ID.get(String(value || '').trim()) || null;
  const routeText = (url, siteRoot) => `${url.pathname.slice(siteRoot.pathname.length)}${url.search}${url.hash}`;
  const siteRootFromWorkspace = (workspaceHref) => new URL('../', new URL(workspaceHref));

  const validateRoute = (appId, rawRoute, siteRootHref, expectedOrigin) => {
    const app = appForId(appId);
    const siteRoot = new URL(siteRootHref);
    const origin = String(expectedOrigin || siteRoot.origin);
    if (!app) return Object.freeze({ ok: false, code: 'UNKNOWN_APP', message: '등록되지 않은 앱입니다.' });
    if (siteRoot.origin !== origin) return Object.freeze({ ok: false, code: 'INVALID_HOST_ORIGIN', message: '호스트 Origin이 일치하지 않습니다.' });

    let target;
    try {
      target = new URL(rawRoute == null || rawRoute === '' ? app.path : String(rawRoute), siteRoot);
    } catch {
      return Object.freeze({ ok: false, code: 'INVALID_ROUTE', message: '앱 주소 형식이 올바르지 않습니다.' });
    }

    const allowed = new URL(app.path, siteRoot);
    if (target.origin !== origin || target.username || target.password || target.pathname !== allowed.pathname) {
      return Object.freeze({ ok: false, code: 'ROUTE_NOT_ALLOWED', message: '허용되지 않은 앱 주소입니다.' });
    }

    return Object.freeze({
      ok: true,
      app,
      url: target.href,
      route: routeText(target, siteRoot),
    });
  };

  const parseHostRequest = (search, workspaceHref) => {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const appId = params.get('app') || APPS[0].id;
    const app = appForId(appId);
    if (!app) {
      return Object.freeze({ ok: false, code: 'UNKNOWN_APP', message: '등록되지 않은 앱입니다.', fallbackApp: APPS[0] });
    }
    return validateRoute(app.id, params.get('route'), siteRootFromWorkspace(workspaceHref), new URL(workspaceHref).origin);
  };

  const workspaceUrlFor = (target, workspaceHref) => {
    const url = new URL(workspaceHref);
    url.search = '';
    url.hash = '';
    url.searchParams.set('app', target.app.id);
    url.searchParams.set('route', target.route);
    return url.href;
  };

  const validateMessageEvent = (event, options) => {
    if (!event || event.origin !== options.origin || event.source !== options.source) return false;
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (data.schemaVersion !== SCHEMA_VERSION || !INBOUND_TYPES.has(data.type)) return false;
    if (typeof data.transitionId !== 'string' || data.transitionId !== options.transitionId) return false;
    if (!appForId(data.appId)) return false;
    return true;
  };

  const createTransitionId = (cryptoObject) => {
    if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID();
    const values = new Uint32Array(4);
    cryptoObject?.getRandomValues?.(values);
    const random = [...values].map((value) => value.toString(16).padStart(8, '0')).join('');
    return `nexus-${Date.now().toString(36)}-${random || Math.random().toString(36).slice(2)}`;
  };

  class WorkspaceHost {
    constructor(windowObject, documentObject) {
      this.window = windowObject;
      this.document = documentObject;
      this.origin = windowObject.location.origin;
      this.workspaceHref = windowObject.location.href;
      this.siteRoot = siteRootFromWorkspace(this.workspaceHref);
      this.frame = documentObject.getElementById('nexusWorkspaceFrame');
      this.loading = documentObject.getElementById('nexusWorkspaceLoading');
      this.loadingText = documentObject.getElementById('nexusWorkspaceLoadingText');
      this.error = documentObject.getElementById('nexusWorkspaceError');
      this.errorMessage = documentObject.getElementById('nexusWorkspaceErrorMessage');
      this.retry = documentObject.getElementById('nexusWorkspaceRetry');
      this.standalone = documentObject.getElementById('nexusWorkspaceStandalone');
      this.notice = documentObject.getElementById('nexusWorkspaceNotice');
      this.currentTarget = null;
      this.loadingTarget = null;
      this.retryTarget = null;
      this.loadTransitionId = '';
      this.frameReady = false;
      this.frameDocumentLoaded = false;
      this.transitionRunning = false;
      this.queuedNavigation = null;
      this.pendingLeave = null;
      this.pendingLoad = null;
      this.noticeTimer = 0;
    }

    start() {
      if (!this.frame || !this.loading || !this.error || !this.retry || !this.standalone || !this.notice) return;
      this.document.addEventListener('click', (event) => this.onDocumentClick(event), true);
      this.window.addEventListener('message', (event) => this.onMessage(event));
      this.window.addEventListener('popstate', () => this.onPopState());
      this.window.addEventListener('nexus-ui:theme-change', (event) => this.sendTheme(event.detail?.theme));
      this.window.addEventListener('keydown', (event) => this.onKeyDown(event), true);
      this.frame.addEventListener('load', () => this.onFrameLoad());
      this.frame.addEventListener('error', () => this.failLoad('업무 앱 문서를 불러오지 못했습니다.'));
      this.retry.addEventListener('click', () => this.retryCurrentTarget());

      const initial = parseHostRequest(this.window.location.search, this.workspaceHref);
      if (!initial.ok) {
        const fallback = validateRoute(initial.fallbackApp?.id || APPS[0].id, '', this.siteRoot, this.origin);
        this.loading.hidden = true;
        this.showLoadError(initial.message, fallback.ok ? fallback : null);
        return;
      }
      this.loadTarget(initial, { historyMode: 'replace' });
    }

    theme() {
      return this.document.documentElement.dataset.nexusUiTheme === 'dark' ? 'dark' : 'light';
    }

    envelope(type, transitionId, target, extra = {}) {
      return Object.assign({
        schemaVersion: SCHEMA_VERSION,
        type,
        transitionId,
        appId: target.app.id,
        route: target.route,
      }, extra);
    }

    post(type, transitionId, target, extra) {
      const destination = this.frame?.contentWindow;
      if (!destination) return false;
      destination.postMessage(this.envelope(type, transitionId, target, extra), this.origin);
      return true;
    }

    onFrameLoad() {
      if (!this.loadingTarget) return;
      this.frameDocumentLoaded = true;
      this.frame.classList.add('is-document-loaded');
      this.post(MESSAGE_TYPES.HOST_READY, this.loadTransitionId, this.loadingTarget, {
        theme: this.theme(),
        hostVersion: VERSION,
      });
    }

    onMessage(event) {
      const data = event?.data;
      const expectedTransitionId = data?.type === MESSAGE_TYPES.LEAVE_RESULT
        ? this.pendingLeave?.id
        : this.loadTransitionId;
      if (!expectedTransitionId || !validateMessageEvent(event, {
        origin: this.origin,
        source: this.frame.contentWindow,
        transitionId: expectedTransitionId,
      })) return;

      if (data.type === MESSAGE_TYPES.APP_READY) {
        if (!this.loadingTarget || data.appId !== this.loadingTarget.app.id) return;
        this.completeLoad();
        return;
      }

      if (data.type === MESSAGE_TYPES.LEAVE_RESULT) {
        if (!this.currentTarget || data.appId !== this.currentTarget.app.id) return;
        const result = ['READY', 'BLOCKED', 'ERROR'].includes(data.result) ? data.result : 'ERROR';
        this.resolveLeave({ result, message: typeof data.message === 'string' ? data.message.slice(0, 500) : '' });
        return;
      }

      if (!this.currentTarget || data.transitionId !== this.loadTransitionId) return;
      if (data.type === MESSAGE_TYPES.ROUTE_CHANGED) {
        if (data.appId !== this.currentTarget.app.id) return;
        const next = validateRoute(data.appId, data.route, this.siteRoot, this.origin);
        if (!next.ok) return;
        this.currentTarget = next;
        this.commitHistory(next, 'replace');
        this.updateStandalone(next);
        return;
      }

      if (data.type === MESSAGE_TYPES.NAVIGATE) {
        const next = validateRoute(data.appId, data.route, this.siteRoot, this.origin);
        if (next.ok) this.requestNavigation(next, 'push');
      }
    }

    onDocumentClick(event) {
      const anchor = event.target?.closest?.('a');
      if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const appId = anchor.dataset?.nexusUiAppTarget;
      if (appId) {
        const next = validateRoute(appId, '', this.siteRoot, this.origin);
        if (!next.ok) return;
        event.preventDefault();
        this.requestNavigation(next, 'push');
        return;
      }

      if (anchor.classList?.contains('nexus-ui-brand__logo')) {
        event.preventDefault();
        this.requestExit(new URL('nexus/', this.siteRoot).href);
      }
    }

    onKeyDown(event) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || String(event.key).toLowerCase() !== 'p') return;
      if (!this.currentTarget || !this.frameReady) return;
      event.preventDefault();
      this.post(MESSAGE_TYPES.PRINT, this.loadTransitionId, this.currentTarget);
    }

    onPopState() {
      const next = parseHostRequest(this.window.location.search, this.window.location.href);
      if (!next.ok) {
        if (this.currentTarget) this.commitHistory(this.currentTarget, 'replace');
        this.showNotice(next.message);
        return;
      }
      if (this.currentTarget?.url === next.url) return;
      this.requestNavigation(next, 'none');
    }

    async requestExit(href) {
      if (this.transitionRunning) return;
      this.transitionRunning = true;
      const leave = await this.beforeLeave();
      this.transitionRunning = false;
      if (leave.result === 'READY') {
        this.window.location.assign(href);
      } else {
        this.showNotice(leave.message || '현재 작업을 보존하지 못해 화면 이동을 취소했습니다.');
      }
    }

    async requestNavigation(target, historyMode) {
      if (this.currentTarget?.url === target.url && this.frameReady) {
        this.frame.focus();
        return;
      }
      this.queuedNavigation = { target, historyMode };
      if (this.transitionRunning) return;
      this.transitionRunning = true;

      const leave = await this.beforeLeave();
      if (leave.result !== 'READY') {
        this.transitionRunning = false;
        this.queuedNavigation = null;
        if (historyMode === 'none' && this.currentTarget) this.commitHistory(this.currentTarget, 'replace');
        this.showNotice(leave.message || (leave.result === 'BLOCKED'
          ? '현재 작업이 완료되지 않아 화면 이동을 취소했습니다.'
          : '현재 작업을 저장하지 못해 화면 이동을 취소했습니다.'));
        return;
      }

      const queued = this.queuedNavigation;
      this.queuedNavigation = null;
      if (!queued) {
        this.transitionRunning = false;
        return;
      }
      try {
        await this.loadTarget(queued.target, { historyMode: queued.historyMode });
      } finally {
        this.transitionRunning = false;
      }
      if (this.queuedNavigation) {
        const final = this.queuedNavigation;
        this.queuedNavigation = null;
        this.requestNavigation(final.target, final.historyMode);
      }
    }

    beforeLeave() {
      if (!this.currentTarget) return Promise.resolve({ result: 'READY' });
      if (!this.frameReady) return Promise.resolve({ result: 'ERROR', message: '현재 앱의 저장 연결을 확인할 수 없습니다.' });
      const id = createTransitionId(this.window.crypto);
      return new Promise((resolve) => {
        const timer = this.window.setTimeout(() => {
          if (this.pendingLeave?.id !== id) return;
          this.pendingLeave = null;
          resolve({ result: 'ERROR', message: '저장 확인 시간이 초과되어 화면 이동을 취소했습니다.' });
        }, LEAVE_TIMEOUT_MS);
        this.pendingLeave = { id, timer, resolve };
        this.loadingText.textContent = '현재 입력을 저장하고 검산하고 있습니다.';
        this.post(MESSAGE_TYPES.BEFORE_LEAVE, id, this.currentTarget);
      });
    }

    resolveLeave(result) {
      const pending = this.pendingLeave;
      if (!pending) return;
      this.window.clearTimeout(pending.timer);
      this.pendingLeave = null;
      pending.resolve(result);
    }

    loadTarget(target, options = {}) {
      if (this.pendingLoad?.timer) this.window.clearTimeout(this.pendingLoad.timer);
      this.loadingTarget = target;
      this.retryTarget = target;
      this.loadTransitionId = createTransitionId(this.window.crypto);
      this.frameReady = false;
      this.frameDocumentLoaded = false;
      this.frame.classList.remove('is-document-loaded');
      this.loading.hidden = false;
      this.loadingText.textContent = `${target.app.label} 앱을 준비하고 있습니다.`;
      this.error.hidden = true;
      this.notice.hidden = true;
      this.updateStandalone(target);
      this.document.documentElement.dataset.nexusUiApp = target.app.id;
      this.document.documentElement.dataset.nexusApp = target.app.id;

      return new Promise((resolve) => {
        const timer = this.window.setTimeout(() => {
          if (this.pendingLoad?.transitionId !== this.loadTransitionId) return;
          this.pendingLoad = null;
          this.failLoad('앱 연결 신호를 받지 못했습니다. 현재 앱은 독립 주소로 열 수 있습니다.');
          resolve(false);
        }, HANDSHAKE_TIMEOUT_MS);
        this.pendingLoad = {
          transitionId: this.loadTransitionId,
          historyMode: options.historyMode || 'push',
          timer,
          resolve,
        };
      if (this.frame.hasAttribute('src') && this.frame.contentWindow) {
        this.frame.contentWindow.location.replace(target.url);
      } else {
        this.frame.src = target.url;
      }
      });
    }

    completeLoad() {
      const pending = this.pendingLoad;
      if (!pending || !this.loadingTarget) return;
      this.window.clearTimeout(pending.timer);
      this.currentTarget = this.loadingTarget;
      this.loadingTarget = null;
      this.retryTarget = this.currentTarget;
      this.frameReady = true;
      this.loading.hidden = true;
      this.error.hidden = true;
      this.setActiveHeader(this.currentTarget);
      this.commitHistory(this.currentTarget, pending.historyMode);
      this.updateStandalone(this.currentTarget);
      this.post(MESSAGE_TYPES.THEME, this.loadTransitionId, this.currentTarget, { theme: this.theme() });
      this.pendingLoad = null;
      pending.resolve(true);
      this.frame.focus();
    }

    failLoad(message) {
      if (this.pendingLoad?.timer) this.window.clearTimeout(this.pendingLoad.timer);
      const pending = this.pendingLoad;
      this.pendingLoad = null;
      this.loading.hidden = true;
      this.showLoadError(message, this.loadingTarget || this.currentTarget);
      pending?.resolve?.(false);
    }

    retryCurrentTarget() {
      const target = this.retryTarget || this.loadingTarget || this.currentTarget;
      if (!target) return;
      this.transitionRunning = true;
      this.loadTarget(target, { historyMode: this.currentTarget ? 'replace' : 'replace' })
        .finally(() => { this.transitionRunning = false; });
    }

    sendTheme(value) {
      if (!this.currentTarget || !this.frameReady) return;
      const theme = value === 'dark' ? 'dark' : 'light';
      this.post(MESSAGE_TYPES.THEME, this.loadTransitionId, this.currentTarget, { theme });
    }

    commitHistory(target, mode) {
      if (mode === 'none') return;
      const href = workspaceUrlFor(target, this.workspaceHref);
      const state = { nexusWorkspace: true, appId: target.app.id, route: target.route };
      if (mode === 'replace') this.window.history.replaceState(state, '', href);
      else this.window.history.pushState(state, '', href);
    }

    setActiveHeader(target) {
      const current = this.document.querySelector('.nexus-ui-brand__current');
      if (current) {
        current.textContent = target.app.label;
        current.title = target.app.label;
      }
      this.document.querySelectorAll('[data-nexus-ui-app-target]').forEach((link) => {
        const active = link.dataset.nexusUiAppTarget === target.app.id;
        link.classList.toggle('is-current', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
      const nav = this.document.querySelector('.nexus-ui-nav');
      const active = nav?.querySelector('[aria-current="page"]');
      if (!nav || !active) return;
      const navRect = nav.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      if (activeRect.left < navRect.left) nav.scrollLeft -= navRect.left - activeRect.left;
      else if (activeRect.right > navRect.right) nav.scrollLeft += activeRect.right - navRect.right;
    }

    updateStandalone(target) {
      if (target?.url) this.standalone.href = target.url;
    }

    showLoadError(message, target) {
      if (target) this.retryTarget = target;
      this.errorMessage.textContent = message;
      this.updateStandalone(target);
      this.error.hidden = false;
    }

    showNotice(message) {
      this.notice.textContent = message;
      this.notice.hidden = false;
      if (this.noticeTimer) this.window.clearTimeout(this.noticeTimer);
      this.noticeTimer = this.window.setTimeout(() => { this.notice.hidden = true; }, 8000);
    }
  }

  const mount = () => {
    if (typeof window !== 'object' || typeof document !== 'object') return null;
    const start = () => {
      const host = new WorkspaceHost(window, document);
      host.start();
      return host;
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return null;
    }
    return start();
  };

  return Object.freeze({
    VERSION,
    SCHEMA_VERSION,
    MESSAGE_TYPES,
    APPS,
    validateRoute,
    parseHostRequest,
    workspaceUrlFor,
    validateMessageEvent,
    WorkspaceHost,
    mount,
  });
});
