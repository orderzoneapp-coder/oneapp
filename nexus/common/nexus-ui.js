(() => {
  'use strict';

  const VERSION = '1.7.0';
  const WORKSPACE_SCHEMA_VERSION = 'nexus-workspace-message/v1';
  const WORKSPACE_MESSAGE_TYPES = Object.freeze({
    HOST_READY: 'NEXUS_WORKSPACE_HOST_READY_V1',
    APP_READY: 'NEXUS_WORKSPACE_APP_READY_V1',
    NAVIGATE: 'NEXUS_WORKSPACE_NAVIGATE_V1',
    ROUTE_CHANGED: 'NEXUS_WORKSPACE_ROUTE_CHANGED_V1',
    BEFORE_LEAVE: 'NEXUS_WORKSPACE_BEFORE_LEAVE_V1',
    LEAVE_RESULT: 'NEXUS_WORKSPACE_LEAVE_RESULT_V1',
    THEME: 'NEXUS_WORKSPACE_THEME_V1',
    PRINT: 'NEXUS_WORKSPACE_PRINT_V1',
  });
  const VISIBILITY_STORAGE_KEY = 'oneapp.nexus.ui.visibility.v1';
  const VISIBILITY_SCHEMA = 'NEXUS_UI_VISIBILITY_V1';
  const root = document.documentElement;
  const controller = window.ONEAPP_NEXUS_UI_THEME;
  const scriptUrl = new URL(document.currentScript?.src || '/nexus/common/nexus-ui.js', location.href);
  const siteRoot = new URL('../../', scriptUrl);
  const asset = (path) => new URL(path, siteRoot).href;
  const installWorkbenchStyles = () => {
    if (!document.head || document.getElementById('nexusWorkbenchStyles')) return;
    const link = document.createElement('link');
    link.id = 'nexusWorkbenchStyles';
    link.rel = 'stylesheet';
    link.href = asset('nexus/common/nexus-workbench.css?v=1.0.0');
    document.head.appendChild(link);
  };
  const GLOBAL_HEADER_APPS = Object.freeze([
    Object.freeze({ id: 'master-lookup', label: '상품관리', path: 'Master.html' }),
    Object.freeze({ id: 'customer-master', label: '거래처관리', path: 'customer-master/index.html' }),
    Object.freeze({ id: 'smart-input', label: '스마트입력', path: 'smartinput/index.html' }),
    Object.freeze({ id: 'smart-parser', label: '스마트파서', path: 'SmartParser.html' }),
    Object.freeze({ id: 'merchops', label: 'MerchOps', path: 'MerchOps.html' }),
    Object.freeze({ id: 'orderops', label: '출고관리', path: 'orderops/list.html' }),
    Object.freeze({ id: 'dataops', label: 'DataOps', path: 'DataOps.html' }),
  ]);
  const KNOWN_VISIBILITY_APP_IDS = new Set([
    'master-lookup', 'customer-master', 'merchops', 'smart-input', 'orderops', 'dataops',
    'smart-parser', 'export-center', 'settings', 'item-manager', 'history-viewer', 'orderq-vnext',
  ]);
  const CURRENT_APP_ALIASES = Object.freeze({ 'item-manager': 'master-lookup' });
  const WORKSPACE_APP_PATHS = Object.freeze({
    'master-lookup': Object.freeze(['Master.html', 'Item_manager.html', 'history_viewer.html', 'settings.html']),
    'customer-master': Object.freeze(['customer-master/index.html', 'history_viewer.html', 'settings.html']),
    'smart-input': Object.freeze(['smartinput/index.html', 'history_viewer.html', 'settings.html', 'orderq/index.html']),
    'smart-parser': Object.freeze(['SmartParser.html', 'history_viewer.html', 'settings.html']),
    merchops: Object.freeze(['MerchOps.html', 'history_viewer.html', 'settings.html', 'export_center.html']),
    orderops: Object.freeze(['orderops/list.html', 'orderq/index.html']),
    dataops: Object.freeze(['DataOps.html', 'history_viewer.html', 'settings.html', 'export_center.html']),
  });
  const DEFAULT_APP_BY_PATH = new Map(GLOBAL_HEADER_APPS.map((app) => [app.path, app.id]));

  const workspaceEmbedded = (() => {
    if (root.dataset.nexusWorkspaceEmbedded === 'true') return true;
    if (window.parent === window) return false;
    try {
      const parentUrl = new URL(window.parent.location.href);
      if (parentUrl.origin === window.location.origin && /\/nexus\/workspace\.html$/.test(parentUrl.pathname)) return true;
    } catch {}
    try {
      const referrer = new URL(document.referrer || '', window.location.href);
      return referrer.origin === window.location.origin && /\/nexus\/workspace\.html$/.test(referrer.pathname);
    } catch {
      return false;
    }
  })();
  if (workspaceEmbedded) root.dataset.nexusWorkspaceEmbedded = 'true';

  const routeFromUrl = (value) => {
    const target = value instanceof URL ? value : new URL(value, siteRoot);
    if (target.origin !== location.origin || !target.pathname.startsWith(siteRoot.pathname)) return '';
    return `${target.pathname.slice(siteRoot.pathname.length)}${target.search}${target.hash}`;
  };

  const appForWorkspaceRoute = (route, currentAppId = '') => {
    let target;
    try { target = new URL(route, siteRoot); } catch { return ''; }
    if (target.origin !== location.origin || !target.pathname.startsWith(siteRoot.pathname)) return '';
    const path = target.pathname.slice(siteRoot.pathname.length);
    const directOwner = DEFAULT_APP_BY_PATH.get(path);
    if (directOwner) return directOwner;
    const current = CURRENT_APP_ALIASES[currentAppId] || currentAppId;
    return WORKSPACE_APP_PATHS[current]?.includes(path) ? current : '';
  };

  const createWorkspaceChildBridge = () => {
    let hostState = null;
    let adapter = null;
    let leaveSequence = Promise.resolve();

    const normalizeLeaveResult = (value) => {
      if (value === false) return { result: 'BLOCKED', message: '현재 앱의 미저장 작업을 먼저 완료해 주세요.' };
      if (typeof value === 'string') return { result: 'BLOCKED', message: value.slice(0, 500) };
      const result = value?.result;
      if (['READY', 'BLOCKED', 'ERROR'].includes(result)) {
        return { result, message: String(value?.message || '').slice(0, 500) };
      }
      return { result: 'READY', message: '' };
    };

    const post = (type, transitionId, appId, route, extra = {}) => {
      if (!workspaceEmbedded || window.parent === window) return false;
      window.parent.postMessage(Object.assign({
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        type,
        transitionId,
        appId,
        route,
      }, extra), location.origin);
      return true;
    };

    const currentRoute = () => routeFromUrl(location.href);

    const applyHostTheme = (value) => {
      const theme = value === 'dark' ? 'dark' : 'light';
      if (controller?.apply) controller.apply(theme, { persist: false, emit: true, source: 'workspace-host' });
      else {
        root.dataset.nexusUiTheme = theme;
        root.dataset.nexusTheme = theme;
        root.style.colorScheme = theme;
      }
    };

    const sendReady = async (message) => {
      try {
        if (typeof adapter?.ready === 'function') await adapter.ready();
        post(WORKSPACE_MESSAGE_TYPES.APP_READY, message.transitionId, message.appId, currentRoute());
      } catch (error) {
        root.dataset.nexusWorkspaceReadyError = String(error?.message || error || '앱 준비에 실패했습니다.').slice(0, 500);
      }
    };

    const handleBeforeLeave = (message) => {
      const request = async () => {
        try {
          const value = typeof adapter?.beforeLeave === 'function'
            ? await adapter.beforeLeave({ appId: message.appId, route: currentRoute() })
            : { result: 'READY' };
          return normalizeLeaveResult(value);
        } catch (error) {
          return { result: 'ERROR', message: String(error?.message || error || '현재 작업을 저장하지 못했습니다.').slice(0, 500) };
        }
      };
      const queued = leaveSequence.then(request, request);
      leaveSequence = queued.catch(() => undefined);
      queued.then((result) => {
        post(WORKSPACE_MESSAGE_TYPES.LEAVE_RESULT, message.transitionId, message.appId, currentRoute(), result);
      });
    };

    const onMessage = (event) => {
      if (!workspaceEmbedded || event.origin !== location.origin || event.source !== window.parent) return;
      const message = event.data;
      if (!message || typeof message !== 'object' || message.schemaVersion !== WORKSPACE_SCHEMA_VERSION) return;
      if (!GLOBAL_HEADER_APPS.some((app) => app.id === message.appId) || typeof message.transitionId !== 'string') return;
      if (message.type === WORKSPACE_MESSAGE_TYPES.HOST_READY) {
        const owner = appForWorkspaceRoute(currentRoute(), message.appId);
        if (!owner || owner !== message.appId) return;
        hostState = { transitionId: message.transitionId, appId: message.appId };
        root.dataset.nexusWorkspaceHostApp = message.appId;
        applyHostTheme(message.theme);
        void sendReady(message);
        return;
      }
      if (!hostState || message.appId !== hostState.appId) return;
      if (message.type === WORKSPACE_MESSAGE_TYPES.BEFORE_LEAVE) {
        handleBeforeLeave(message);
      } else if (message.type === WORKSPACE_MESSAGE_TYPES.THEME) {
        if (message.transitionId !== hostState.transitionId) return;
        applyHostTheme(message.theme);
      } else if (message.type === WORKSPACE_MESSAGE_TYPES.PRINT) {
        if (message.transitionId !== hostState.transitionId) return;
        if (typeof adapter?.print === 'function') adapter.print();
        else window.print();
      }
    };

    const navigate = (appId, route) => {
      const canonicalAppId = CURRENT_APP_ALIASES[String(appId || '')] || String(appId || '');
      const targetRoute = routeFromUrl(route || GLOBAL_HEADER_APPS.find((app) => app.id === canonicalAppId)?.path || '');
      if (!canonicalAppId || !targetRoute || appForWorkspaceRoute(targetRoute, canonicalAppId) !== canonicalAppId) return false;
      if (workspaceEmbedded && hostState) {
        return post(WORKSPACE_MESSAGE_TYPES.NAVIGATE, hostState.transitionId, canonicalAppId, targetRoute);
      }
      location.assign(new URL(targetRoute, siteRoot).href);
      return true;
    };

    const notifyRouteChanged = () => {
      if (!workspaceEmbedded || !hostState) return false;
      const route = currentRoute();
      if (!appForWorkspaceRoute(route, hostState.appId)) return false;
      return post(WORKSPACE_MESSAGE_TYPES.ROUTE_CHANGED, hostState.transitionId, hostState.appId, route);
    };

    const navigateRoute = (route, appId = '') => {
      const targetRoute = routeFromUrl(route);
      const requestedAppId = CURRENT_APP_ALIASES[String(appId || '')] || String(appId || '');
      const owner = requestedAppId || appForWorkspaceRoute(targetRoute, hostState?.appId || root.dataset.nexusUiApp || '');
      return Boolean(owner && navigate(owner, targetRoute));
    };

    const registerAdapter = (value = {}) => {
      adapter = value && typeof value === 'object' ? value : null;
      return () => { if (adapter === value) adapter = null; };
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('popstate', notifyRouteChanged);
    window.addEventListener('hashchange', notifyRouteChanged);
    document.addEventListener('click', (event) => {
      if (!workspaceEmbedded || !hostState || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target?.closest?.('a[href]');
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      let target;
      try { target = new URL(anchor.href, location.href); } catch { return; }
      if (target.origin !== location.origin) return;
      if (target.pathname === location.pathname && target.search === location.search && target.hash !== location.hash) return;
      const route = routeFromUrl(target);
      const targetAppId = appForWorkspaceRoute(route, hostState.appId);
      if (!targetAppId) return;
      event.preventDefault();
      navigate(targetAppId, route);
    }, true);

    return Object.freeze({
      VERSION: '1.0.0',
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      isEmbedded: workspaceEmbedded,
      registerAdapter,
      navigate,
      navigateRoute,
      notifyRouteChanged,
      currentRoute,
      get appId() { return hostState?.appId || ''; },
      get connected() { return Boolean(hostState); },
    });
  };

  window.ONEAPP_NEXUS_WORKSPACE_CHILD = createWorkspaceChildBridge();
  window.ONEAPP_NEXUS_NAVIGATE_ROUTE = (route, appId = '') => {
    if (window.ONEAPP_NEXUS_WORKSPACE_CHILD.navigateRoute(route, appId)) return true;
    try { location.assign(new URL(route, siteRoot).href); }
    catch { location.assign(String(route || '')); }
    return true;
  };

  const visibleApps = () => {
    try {
      const projection = JSON.parse(window.sessionStorage.getItem(VISIBILITY_STORAGE_KEY) || 'null');
      if (!projection || projection.schemaVersion !== VISIBILITY_SCHEMA || projection.configured !== true) return GLOBAL_HEADER_APPS;
      if (!Array.isArray(projection.visibleAppIds)) return GLOBAL_HEADER_APPS;
      const ids = projection.visibleAppIds;
      const valid = ids.every((id, index) => typeof id === 'string'
        && KNOWN_VISIBILITY_APP_IDS.has(id)
        && ids.indexOf(id) === index);
      const visibleIds = new Set(ids.map((id) => CURRENT_APP_ALIASES[id] || id));
      return valid ? GLOBAL_HEADER_APPS.filter((app) => visibleIds.has(app.id)) : GLOBAL_HEADER_APPS;
    } catch {
      return GLOBAL_HEADER_APPS;
    }
  };

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const updateThemeControl = (header, theme) => {
    const toggle = header.querySelector('[data-nexus-ui-theme-toggle]');
    if (!toggle) return;
    const dark = theme === 'dark';
    toggle.setAttribute('aria-checked', String(dark));
    toggle.setAttribute('aria-label', '다크모드');
    toggle.title = dark ? '일반모드로 전환' : '다크모드로 전환';
    header.querySelectorAll('[data-nexus-ui-theme-set]').forEach((button) => {
      const active = button.dataset.nexusUiThemeSet === (dark ? 'dark' : 'light');
      button.setAttribute('aria-pressed', String(active));
    });
  };

  const applyTheme = (header, value, source) => {
    const nextTheme = value === 'dark' ? 'dark' : 'light';
    const applied = controller?.apply
      ? controller.apply(nextTheme, { persist: true, emit: true, source })
      : nextTheme;
    if (!controller?.apply) {
      root.dataset.nexusUiTheme = applied;
      root.dataset.nexusTheme = applied;
      root.style.colorScheme = applied;
    }
    updateThemeControl(header, applied);
  };

  const revealCurrentApp = (header) => {
    const nav = header.querySelector('.nexus-ui-nav');
    const currentLink = nav?.querySelector('[aria-current="page"]');
    if (!nav || !currentLink) return;
    const reveal = () => {
      const navRect = nav.getBoundingClientRect();
      const currentRect = currentLink.getBoundingClientRect();
      const currentCenter = nav.scrollLeft + (currentRect.left - navRect.left) + (currentRect.width / 2);
      const centered = currentCenter - (nav.clientWidth / 2);
      nav.scrollLeft = Math.max(0, Math.min(centered, nav.scrollWidth - nav.clientWidth));
    };
    requestAnimationFrame(reveal);
    window.addEventListener('resize', reveal, { passive: true });
  };

  const buildHeader = () => {
    const rawCurrentAppId = String(root.dataset.nexusUiApp || '').trim();
    const currentAppId = CURRENT_APP_ALIASES[rawCurrentAppId] || rawCurrentAppId;
    const currentApp = GLOBAL_HEADER_APPS.find((app) => app.id === currentAppId);
    const header = element('header', 'nexus-ui-header');
    header.id = 'nexusUiHeader';
    header.dataset.nexusUiVersion = VERSION;
    header.setAttribute('aria-label', 'NEXUS 공통헤더');

    const brand = element('div', 'nexus-ui-brand');
    const logoFrame = element('a', 'nexus-ui-brand__logo');
    logoFrame.href = asset('nexus/');
    logoFrame.setAttribute('aria-label', 'NEXUS 홈');
    logoFrame.title = 'NEXUS 홈';
    const lightLogo = element('img', 'nexus-ui-logo nexus-ui-logo--light');
    lightLogo.src = asset('nexus/assets/brand/oneapp-nexus-light.svg');
    lightLogo.alt = 'ONEAPP NEXUS';
    const darkLogo = element('img', 'nexus-ui-logo nexus-ui-logo--dark');
    darkLogo.src = asset('nexus/assets/brand/oneapp-nexus-dark.svg');
    darkLogo.alt = '';
    darkLogo.setAttribute('aria-hidden', 'true');
    logoFrame.append(lightLogo, darkLogo);
    const current = element('span', 'nexus-ui-brand__current', currentApp?.label || 'ONEAPP');
    current.title = currentApp?.label || '현재 앱';
    brand.append(logoFrame, current);

    const nav = element('nav', 'nexus-ui-nav');
    nav.setAttribute('aria-label', '앱 이동');
    const navTrack = element('div', 'nexus-ui-nav__track');
    visibleApps().forEach((app) => {
      const link = element('a', 'nexus-ui-nav__link', app.label);
      link.href = asset(app.path);
      link.dataset.nexusUiAppTarget = app.id;
      if (app.id === currentAppId) {
        link.classList.add('is-current');
        link.setAttribute('aria-current', 'page');
      }
      navTrack.appendChild(link);
    });
    nav.appendChild(navTrack);

    const themeGroup = element('div', 'nexus-ui-theme');
    themeGroup.setAttribute('role', 'group');
    themeGroup.setAttribute('aria-label', '화면 모드');
    const lightIcon = element('button', 'nexus-ui-theme__icon', '☼');
    lightIcon.type = 'button';
    lightIcon.dataset.nexusUiThemeSet = 'light';
    lightIcon.setAttribute('aria-label', '일반모드 적용');
    lightIcon.title = '일반모드 적용';
    const toggle = element('button', 'nexus-ui-theme__switch');
    toggle.type = 'button';
    toggle.dataset.nexusUiThemeToggle = '';
    toggle.setAttribute('role', 'switch');
    const darkIcon = element('button', 'nexus-ui-theme__icon', '☾');
    darkIcon.type = 'button';
    darkIcon.dataset.nexusUiThemeSet = 'dark';
    darkIcon.setAttribute('aria-label', '다크모드 적용');
    darkIcon.title = '다크모드 적용';
    toggle.addEventListener('click', () => {
      const nextTheme = root.dataset.nexusUiTheme === 'dark' ? 'light' : 'dark';
      applyTheme(header, nextTheme, 'header-switch');
    });
    lightIcon.addEventListener('click', () => applyTheme(header, 'light', 'header-icon'));
    darkIcon.addEventListener('click', () => applyTheme(header, 'dark', 'header-icon'));
    themeGroup.append(lightIcon, toggle, darkIcon);

    header.append(brand, nav, themeGroup);
    updateThemeControl(header, root.dataset.nexusUiTheme === 'dark' ? 'dark' : 'light');
    return header;
  };

  const mount = () => {
    if (!document.body) return;
    installWorkbenchStyles();
    if (document.getElementById('nexusUiHeader')) return;
    const bodyStyle = getComputedStyle(document.body);
    document.body.style.setProperty('--nexus-ui-original-padding-top', bodyStyle.paddingTop || '0px');
    document.body.classList.add('nexus-ui-mounted');
    if (workspaceEmbedded) {
      const startedAt = Number(root.dataset.nexusUiInitStartedAt || 0);
      const readyMs = startedAt > 0 && typeof performance !== 'undefined'
        ? Math.max(0, performance.now() - startedAt)
        : 0;
      root.dataset.nexusUiReady = 'true';
      root.dataset.nexusUiReadyMs = readyMs.toFixed(2);
      window.dispatchEvent(new CustomEvent('nexus-ui:ready', {
        detail: Object.freeze({ appId: root.dataset.nexusUiApp || '', readyMs, embedded: true }),
      }));
      return;
    }
    const header = buildHeader();
    document.body.prepend(header);
    revealCurrentApp(header);
    window.addEventListener('nexus-ui:theme-change', (event) => {
      updateThemeControl(header, event.detail?.theme === 'dark' ? 'dark' : 'light');
    });
    const startedAt = Number(root.dataset.nexusUiInitStartedAt || 0);
    const readyMs = startedAt > 0 && typeof performance !== 'undefined'
      ? Math.max(0, performance.now() - startedAt)
      : 0;
    root.dataset.nexusUiReady = 'true';
    root.dataset.nexusUiReadyMs = readyMs.toFixed(2);
    window.dispatchEvent(new CustomEvent('nexus-ui:ready', {
      detail: Object.freeze({ appId: root.dataset.nexusUiApp || '', readyMs }),
    }));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
