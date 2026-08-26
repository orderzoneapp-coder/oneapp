(() => {
  const VERSION = '1.6.0';
  const STORAGE = Object.freeze({
    colorMode: 'oneapp.nexus.v1.colorMode',
    groupOrder: 'oneapp.nexus.v1.groupOrder',
    hiddenGroups: 'oneapp.nexus.v1.hiddenGroups',
    hiddenGlobalActions: 'oneapp.nexus.v1.hiddenGlobalActions',
    favoriteApps: 'oneapp.nexus.v1.favoriteApps',
    hiddenApps: 'oneapp.nexus.v1.hiddenApps',
    statusPrefix: 'oneapp.nexus.v1.status.',
  });
  const LEGACY = Object.freeze({
    colorMode: 'oneapp.nexus.theme',
    groupOrder: 'oneapp.nexus.appOrder',
    hiddenGroups: 'oneapp.nexus.hiddenApps',
  });
  const LEGACY_GROUP_IDS = Object.freeze({
    orderq: 'shipping',
    dataops: 'inventory',
    merchops: 'pricing',
    master: 'foundation',
  });
  const LEGACY_DEFAULT_GROUP_ORDER = Object.freeze(['shipping', 'inventory', 'pricing', 'foundation']);
  const TAB_BUTTONS = Object.freeze({
    foundation: Object.freeze({
      active: '/nexus/assets/navigation-tabs/foundation-active.png',
      inactive: '/nexus/assets/navigation-tabs/foundation-inactive.png',
    }),
    pricing: Object.freeze({
      active: '/nexus/assets/navigation-tabs/pricing-active.png',
      inactive: '/nexus/assets/navigation-tabs/pricing-inactive.png',
    }),
    'smart-input': Object.freeze({
      active: '/nexus/assets/navigation-tabs/smart-input-active.png',
      inactive: '/nexus/assets/navigation-tabs/smart-input-inactive.png',
    }),
    shipping: Object.freeze({
      active: '/nexus/assets/navigation-tabs/shipping-active.png',
      inactive: '/nexus/assets/navigation-tabs/shipping-inactive.png',
    }),
    inventory: Object.freeze({
      active: '/nexus/assets/navigation-tabs/inventory-active.png',
      inactive: '/nexus/assets/navigation-tabs/inventory-inactive.png',
    }),
  });
  const SECTION_LABEL = Object.freeze({ management: '기준·관리', operations: '운영 흐름' });
  const STATUS_PRIORITY = Object.freeze({ normal: 0, progress: 1, warning: 2, error: 3 });
  const STATUS_LABEL = Object.freeze({ normal: '정상', progress: '진행 중', warning: '주의', error: '오류' });
  const base = new URL('.', document.currentScript?.src || '/nexus/common/nexus-top.js');
  const NAVIGATION_STORAGE_KEY = 'oneapp.nexus.v1.navigation';
  const NAVIGATION_COVER_ID = 'nexusNavigationCover';
  let navigationCoverShownAt = 0;

  const navigationCoverStyle = `
    #${NAVIGATION_COVER_ID}{--nexus-loading-text:#12233f;--nexus-loading-muted:#62728a;--nexus-loading-accent:#0baa91;--nexus-loading-grid:rgba(35,78,125,.1);--nexus-loading-track:rgba(53,79,111,.12);position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;overflow:hidden;color:var(--nexus-loading-text);background:radial-gradient(circle at 50% 36%,rgba(91,181,211,.2),transparent 34%),linear-gradient(145deg,#f7fbff,#eef5fb 56%,#e8f1f9);font-family:Inter,Pretendard,"Noto Sans KR",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:1;transition:opacity .22s ease}
    #${NAVIGATION_COVER_ID}[data-mode="dark"]{--nexus-loading-text:#f7fbff;--nexus-loading-muted:#9eb0c5;--nexus-loading-accent:#69d3bd;--nexus-loading-grid:rgba(105,211,189,.18);--nexus-loading-track:rgba(143,169,196,.13);background:radial-gradient(circle at 50% 38%,rgba(28,74,117,.34),transparent 34%),linear-gradient(145deg,#050b16,#0a1626 56%,#07111e)}
    #${NAVIGATION_COVER_ID}[hidden]{display:none}
    #${NAVIGATION_COVER_ID}.is-leaving{opacity:0;pointer-events:none}
    #${NAVIGATION_COVER_ID} .nexus-navigation-cover__grid{position:absolute;inset:-20%;opacity:.13;background-image:linear-gradient(var(--nexus-loading-grid) 1px,transparent 1px),linear-gradient(90deg,var(--nexus-loading-grid) 1px,transparent 1px);background-size:46px 46px;transform:perspective(560px) rotateX(62deg) translateY(26%);transform-origin:center}
    #${NAVIGATION_COVER_ID} .nexus-navigation-cover__card{position:relative;width:min(420px,calc(100vw - 40px));padding:30px 32px 26px;display:grid;justify-items:center;border:1px solid rgba(75,111,151,.16);border-radius:22px;background:rgba(255,255,255,.88);box-shadow:0 28px 90px rgba(48,76,108,.18),inset 0 1px rgba(255,255,255,.9);backdrop-filter:blur(18px);text-align:center}
    #${NAVIGATION_COVER_ID}[data-mode="dark"] .nexus-navigation-cover__card{border-color:rgba(151,189,222,.18);background:linear-gradient(145deg,rgba(17,37,61,.9),rgba(8,22,39,.94));box-shadow:0 28px 90px rgba(0,0,0,.42),inset 0 1px rgba(255,255,255,.05)}
    #${NAVIGATION_COVER_ID} .nexus-navigation-cover__mark{width:66px;height:66px;display:grid;place-items:center;border:1px solid rgba(11,170,145,.24);border-radius:18px;background:linear-gradient(145deg,#173b72,#091b49);box-shadow:0 14px 38px rgba(38,74,121,.24),0 0 28px rgba(11,170,145,.08)}
    #${NAVIGATION_COVER_ID}[data-mode="dark"] .nexus-navigation-cover__mark{border-color:rgba(105,211,189,.28);background:linear-gradient(145deg,rgba(20,49,84,.96),rgba(9,24,48,.96));box-shadow:0 14px 38px rgba(1,8,20,.42),0 0 28px rgba(105,211,189,.08)}
    #${NAVIGATION_COVER_ID} svg{width:39px;height:39px;overflow:visible}
    #${NAVIGATION_COVER_ID} .nexus-navigation-cover__eyebrow{margin-top:17px;color:var(--nexus-loading-accent);font-size:10px;font-weight:900;letter-spacing:.2em}
    #${NAVIGATION_COVER_ID} strong{max-width:100%;margin-top:5px;overflow:hidden;color:var(--nexus-loading-text);font-size:20px;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}
    #${NAVIGATION_COVER_ID} p{margin:7px 0 0;color:var(--nexus-loading-muted);font-size:12px}
    #${NAVIGATION_COVER_ID} .nexus-navigation-cover__progress{position:relative;width:100%;height:3px;margin-top:24px;overflow:hidden;border-radius:99px;background:var(--nexus-loading-track)}
    #${NAVIGATION_COVER_ID} .nexus-navigation-cover__progress i{position:absolute;inset:0 auto 0 0;width:42%;border-radius:inherit;background:linear-gradient(90deg,transparent,var(--nexus-loading-accent),#79aef7,transparent);animation:nexus-navigation-progress 1.15s cubic-bezier(.4,0,.2,1) infinite}
    @keyframes nexus-navigation-progress{0%{transform:translateX(-115%)}100%{transform:translateX(340%)}}
    @media (prefers-reduced-motion:reduce){#${NAVIGATION_COVER_ID} .nexus-navigation-cover__progress i{animation-duration:2.4s}}
  `;

  const readNavigationMarker = () => {
    try {
      const marker = JSON.parse(sessionStorage.getItem(NAVIGATION_STORAGE_KEY) || 'null');
      return marker && Date.now() - Number(marker.startedAt || 0) < 15000 ? marker : null;
    } catch {
      return null;
    }
  };

  const navigationMode = (requestedMode) => {
    if (requestedMode === 'dark' || requestedMode === 'light') return requestedMode;
    const rootMode = document.documentElement.dataset.nexusTheme || document.documentElement.dataset.nexusColorMode;
    return rootMode === 'dark' ? 'dark' : 'light';
  };

  const installNavigationCover = (label = 'NEXUS', requestedMode) => {
    let cover = document.getElementById(NAVIGATION_COVER_ID);
    if (!cover) {
      const style = document.createElement('style');
      style.dataset.nexusNavigationCover = 'true';
      style.textContent = navigationCoverStyle;
      cover = document.createElement('div');
      cover.id = NAVIGATION_COVER_ID;
      cover.setAttribute('role', 'status');
      cover.setAttribute('aria-live', 'polite');
      cover.innerHTML = `<div class="nexus-navigation-cover__grid" aria-hidden="true"></div><section class="nexus-navigation-cover__card"><div class="nexus-navigation-cover__mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M7 7l13 17L7 41" fill="none" stroke="#f7fbff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M41 7L28 24l13 17" fill="none" stroke="#39d1ae" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg></div><span class="nexus-navigation-cover__eyebrow">NEXUS WORKSPACE</span><strong></strong><p>업무 화면을 준비하고 있습니다.</p><div class="nexus-navigation-cover__progress" aria-hidden="true"><i></i></div></section>`;
      document.documentElement.append(style, cover);
    }
    cover.dataset.mode = navigationMode(requestedMode);
    cover.querySelector('strong').textContent = String(label || 'NEXUS');
    cover.classList.remove('is-leaving');
    cover.hidden = false;
    document.documentElement.dataset.nexusNavigating = 'true';
    navigationCoverShownAt = Date.now();
    return cover;
  };

  const clearNavigationCover = (immediate = false) => {
    const cover = document.getElementById(NAVIGATION_COVER_ID);
    if (!cover) return;
    const marker = readNavigationMarker();
    const minimumWait = immediate ? 0 : Math.max(0, 420 - (Date.now() - Number(marker?.startedAt || navigationCoverShownAt)));
    window.setTimeout(() => {
      cover.classList.add('is-leaving');
      window.setTimeout(() => {
        cover.hidden = true;
        cover.classList.remove('is-leaving');
        delete document.documentElement.dataset.nexusNavigating;
        try { sessionStorage.removeItem(NAVIGATION_STORAGE_KEY); } catch {}
      }, immediate ? 0 : 230);
    }, minimumWait);
  };

  const initialNavigationMarker = readNavigationMarker();
  if (initialNavigationMarker) {
    installNavigationCover(initialNavigationMarker.label, initialNavigationMarker.mode);
    window.addEventListener('load', () => clearNavigationCover(), { once: true });
    window.setTimeout(() => clearNavigationCover(true), 12000);
  }
  window.addEventListener('pageshow', (event) => { if (event.persisted) clearNavigationCover(true); });

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
  const asArray = (value) => Array.isArray(value) ? value : [];
  const unique = (values) => [...new Set(values)];
  const sameOrder = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
  const preloadTabButtonImages = () => {
    for (const asset of Object.values(TAB_BUTTONS).flatMap((states) => [states.active, states.inactive])) {
      const image = new Image();
      image.src = asset;
    }
  };
  const normalizeLevel = (value) => {
    const aliases = {
      ok: 'normal', success: 'normal', idle: 'normal',
      working: 'progress', syncing: 'progress', saving: 'progress',
      unsaved: 'warning', caution: 'warning',
      failed: 'error', failure: 'error',
    };
    const normalized = aliases[value] || value;
    return Object.hasOwn(STATUS_PRIORITY, normalized) ? normalized : 'normal';
  };

  const ensureThemeController = () => {
    const existing = window.ONEAPP_NEXUS_THEME_INIT;
    if (existing && typeof existing.normalize === 'function' && typeof existing.readMode === 'function' && typeof existing.apply === 'function') {
      return existing;
    }

    const parseStoredValue = (raw) => {
      if (raw == null) return '';
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'string' ? parsed : '';
      } catch {
        return String(raw);
      }
    };
    const normalize = (mode) => mode === 'dark' ? 'dark' : 'light';
    const persist = (mode) => {
      try {
        localStorage.setItem(STORAGE.colorMode, JSON.stringify(mode));
      } catch {
        // The header keeps the selected value in its existing in-memory retry queue.
      }
    };
    const readMode = () => {
      try {
        const saved = parseStoredValue(localStorage.getItem(STORAGE.colorMode));
        const legacy = parseStoredValue(localStorage.getItem(LEGACY.colorMode));
        const next = normalize(saved || legacy);
        if (saved !== next) persist(next);
        return next;
      } catch {
        return 'light';
      }
    };
    const apply = (mode, options = {}) => {
      const next = normalize(mode);
      const root = document.documentElement;
      root.dataset.nexusTheme = next;
      // Compatibility alias for the existing shadow-DOM header stylesheet.
      root.dataset.nexusColorMode = next;
      root.style.colorScheme = next;
      if (options.emit === true) {
        const detail = { theme: next, colorMode: next };
        if (options.source) detail.source = String(options.source);
        window.dispatchEvent(new CustomEvent('nexus-theme-change', { detail }));
      }
      return next;
    };
    const fallback = Object.freeze({ normalize, readMode, apply });
    window.ONEAPP_NEXUS_THEME_INIT = fallback;
    return fallback;
  };
  const themeController = ensureThemeController();

  const api = window.NEXUS_TOP && typeof window.NEXUS_TOP === 'object' ? window.NEXUS_TOP : {};
  api.version = VERSION;
  api._statusQueue = api._statusQueue || [];
  api._globalQueue = api._globalQueue || [];
  api.reportStatus = (detail = {}) => {
    if (api._instance) api._instance.receiveStatus(detail);
    else api._statusQueue.push(detail);
  };
  api.clearStatus = (taskId, appId) => api.reportStatus({ appId, taskId, active: false, level: 'normal' });
  api.reportGlobalError = (detail = {}) => {
    if (api._instance) api._instance.receiveGlobalError(detail);
    else api._globalQueue.push(detail);
  };
  api.clearGlobalError = (id = 'global') => api.reportGlobalError({ id, active: false });
  window.NEXUS_TOP = api;

  class NexusTop extends HTMLElement {
    connectedCallback() {
      if (this.initialized) return;
      this.initialized = true;
      try {
        this.groups = asArray(window.NEXUS_GROUPS);
        this.apps = asArray(window.NEXUS_APPS);
        this.globalActions = asArray(window.NEXUS_GLOBAL_ACTIONS);
        this.aliases = window.NEXUS_APP_ALIASES || {};
        if (!this.groups.length || !this.apps.length) throw new Error('NEXUS app configuration is unavailable.');
        preloadTabButtonImages();

        this.memory = new Map();
        this.pendingWrites = new Map();
        this.statusSignals = new Map();
        this.globalErrors = new Map();
        this.normalMessage = '대기 중인 작업이 없습니다.';
        this.openPanel = '';
        this.panelTrigger = null;
        this.declaredAppId = this.getAttribute('app-id') || '';
        this.currentAppId = this.canonicalAppId(this.declaredAppId);
        this.currentApp = this.apps.find((app) => app.id === this.currentAppId) || null;
        this.currentGlobalAction = this.globalActions.find((action) => action.appId === this.currentAppId) || null;
        this.currentGroupId = this.currentGlobalAction ? '' : (this.currentApp?.groupId || this.resolveLegacyGroup(this.declaredAppId));

        this.root = this.attachShadow({ mode: 'open' });
        this.root.innerHTML = this.shellMarkup();
        this.bind();
        this.renderAll();
        this.applyEnvironment();

        api._instance = this;
        api._statusQueue.splice(0).forEach((detail) => this.receiveStatus(detail));
        api._globalQueue.splice(0).forEach((detail) => this.receiveGlobalError(detail));
      } catch (error) {
        this.renderFailure(error);
      }
    }

    disconnectedCallback() {
      document.removeEventListener('click', this.onDocumentClick);
      document.removeEventListener('keydown', this.onDocumentKeydown);
      window.removeEventListener('storage', this.onStorage);
      window.removeEventListener('nexus:app-status', this.onAppStatus);
      window.removeEventListener('nexus:global-error', this.onGlobalError);
      window.removeEventListener('pageshow', this.onPageShow);
      if (api._instance === this) api._instance = null;
    }

    canonicalAppId(value) {
      return this.aliases[value] || value;
    }

    resolveLegacyGroup(value) {
      return LEGACY_GROUP_IDS[value] || (this.groups.some((group) => group.id === value) ? value : '');
    }

    shellMarkup() {
      const stylesheet = new URL(`nexus-top.css?v=${VERSION}`, base);
      const policyStylesheet = new URL(`nexus-top-navigation.css?v=${VERSION}`, base);
      return `
        <link rel="stylesheet" href="${stylesheet}">
        <link rel="stylesheet" href="${policyStylesheet}">
        <header class="top" aria-label="NEXUS 공통 헤더">
          <a class="brand" href="https://oneapp.orderz.co.kr/nexus/" aria-label="NEXUS 홈" data-navigate data-target-app="">
            <img src="/nexus/assets/brand/oneapp-nexus-dark.svg" alt="ONEAPP NEXUS">
          </a>
          <nav class="nav" aria-label="업무 메뉴">
            <div class="track">
              <div class="nav-section management-entries" aria-label="기준·관리"></div>
              <span class="workflow-divider" role="separator" aria-label="기준·관리와 운영 흐름 구분"></span>
              <div class="global-entries" aria-label="운영 흐름 시작"></div>
              <div class="nav-section operation-entries" aria-label="운영 흐름"></div>
            </div>
          </nav>
          <div class="actions">
            <button class="action global-alert" type="button" aria-label="NEXUS 전역 오류" hidden>
              <span class="alert-icon" aria-hidden="true">!</span><span class="action-label">전역 오류</span>
            </button>
            <button class="action status-action" type="button" data-open="status" aria-haspopup="dialog" aria-expanded="false">
              <span class="status-dot" aria-hidden="true"></span><span class="status-label">정상</span>
            </button>
            <button class="action" type="button" data-open="apps" aria-label="전체 앱" aria-haspopup="dialog" aria-expanded="false">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg><span class="action-label">전체 앱</span>
            </button>
            <button class="action" type="button" data-open="settings" aria-label="설정" aria-haspopup="dialog" aria-expanded="false">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M19 13v-2l2-2-2-3-3 1-2-1-1-3h-3L9 6 7 7 4 6 2 9l2 2v2l-2 2 2 3 3-1 2 1 1 3h3l1-3 2-1 3 1 2-3-2-2zm-7 2a3 3 0 110-6 3 3 0 010 6z"/></svg><span class="action-label">설정</span>
            </button>
          </div>
        </header>

        <section class="panel status-panel" data-panel="status" role="dialog" aria-label="현재 앱 상태" hidden>
          <div class="heading"><div><span class="eyebrow">CURRENT APP</span><h2>현재 앱 상태</h2></div><button class="close" type="button" aria-label="상태 닫기">×</button></div>
          <div class="current-status"></div>
        </section>

        <section class="panel apps-panel" data-panel="apps" role="dialog" aria-modal="true" aria-label="전체 앱" hidden>
          <div class="heading"><div><span class="eyebrow">NEXUS</span><h2>전체 앱</h2><p>숨긴 앱도 이 목록에서 다시 찾을 수 있습니다.</p></div><button class="close" type="button" aria-label="전체 앱 닫기">×</button></div>
          <div class="apps-content"></div>
        </section>

        <aside class="panel settings-panel" data-panel="settings" role="dialog" aria-modal="true" aria-label="공통헤더 설정" hidden>
          <div class="heading"><div><span class="eyebrow">NEXUS</span><h2>공통헤더 설정</h2><p>상단 메뉴와 화면 모드를 설정합니다.</p></div><button class="close" type="button" aria-label="설정 닫기">×</button></div>
          <div class="settings-content"></div>
        </aside>

        <div class="backdrop" hidden></div>
      `;
    }

    renderFailure(error) {
      console.error('[NEXUS TOP] initialization failed', error);
      const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>:host{display:block;height:44px;font-family:Pretendard,"Noto Sans KR",sans-serif}.fallback{height:44px;padding:0 14px;display:flex;align-items:center;gap:12px;background:#0b1021;color:#fff;font-size:12px}.fallback strong{letter-spacing:.08em}.fallback span{color:#cbd5e1}.fallback button{margin-left:auto;border:1px solid #64748b;border-radius:6px;padding:5px 9px;background:transparent;color:#fff;cursor:pointer}</style>
        <div class="fallback" role="status"><strong>NEXUS</strong><span>NEXUS 메뉴를 불러오지 못했습니다.</span><button type="button">재시도</button></div>`;
      root.querySelector('button').addEventListener('click', () => window.location.reload());
      document.documentElement.style.setProperty('--nexus-top-height', '44px');
    }

    readValue(key) {
      if (this.memory.has(key)) return this.memory.get(key);
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) return undefined;
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      } catch {
        return undefined;
      }
    }

    readPreference(key, fallback) {
      const value = this.readValue(key);
      return value === undefined ? fallback : value;
    }

    writePreference(key, value) {
      this.memory.set(key, value);
      try {
        localStorage.setItem(key, JSON.stringify(value));
        this.memory.delete(key);
        this.pendingWrites.delete(key);
        return true;
      } catch {
        this.pendingWrites.set(key, value);
        return false;
      }
    }

    preferences() {
      const groupIds = this.groups.map((group) => group.id);
      const appIds = this.apps.map((app) => app.id);
      const globalActionIds = this.globalActions.map((action) => action.id);
      const legacyOrder = asArray(this.readValue(LEGACY.groupOrder)).map((id) => LEGACY_GROUP_IDS[id]).filter(Boolean);
      const savedOrder = asArray(this.readValue(STORAGE.groupOrder));
      const storedOrder = savedOrder.length ? savedOrder : legacyOrder;
      const requestedOrder = !storedOrder.length || sameOrder(storedOrder, LEGACY_DEFAULT_GROUP_ORDER) ? groupIds : storedOrder;
      const groupOrder = unique([
        ...requestedOrder.filter((id) => groupIds.includes(id)),
        ...groupIds,
      ]);
      if (savedOrder.length && sameOrder(savedOrder, LEGACY_DEFAULT_GROUP_ORDER)) this.writePreference(STORAGE.groupOrder, groupIds);

      const legacyHidden = asArray(this.readValue(LEGACY.hiddenGroups)).map((id) => LEGACY_GROUP_IDS[id]).filter(Boolean);
      const savedHiddenGroups = this.readValue(STORAGE.hiddenGroups);
      const hiddenGroups = asArray(savedHiddenGroups === undefined ? legacyHidden : savedHiddenGroups).filter((id) => groupIds.includes(id));
      const hiddenGlobalActions = asArray(this.readPreference(STORAGE.hiddenGlobalActions, [])).filter((id) => globalActionIds.includes(id));
      const defaultHiddenApps = this.apps.filter((app) => app.defaultHidden).map((app) => app.id);
      const hiddenApps = asArray(this.readPreference(STORAGE.hiddenApps, defaultHiddenApps)).filter((id) => appIds.includes(id));
      const favoriteApps = asArray(this.readPreference(STORAGE.favoriteApps, [])).filter((id) => appIds.includes(id));

      const colorMode = this.memory.has(STORAGE.colorMode)
        ? themeController.normalize(this.memory.get(STORAGE.colorMode))
        : themeController.readMode();
      return { groupOrder, hiddenGroups, hiddenGlobalActions, hiddenApps, favoriteApps, colorMode };
    }

    orderedGroups() {
      const { groupOrder } = this.preferences();
      const groupsById = Object.fromEntries(this.groups.map((group) => [group.id, group]));
      return groupOrder.map((id) => groupsById[id]).filter(Boolean);
    }

    groupsForSection(section) {
      return this.orderedGroups().filter((group) => (group.section || 'operations') === section);
    }

    renderAll() {
      this.renderHeaderNavigation();
      this.renderStatus();
      this.renderApps();
      this.renderSettings();
    }

    logoPath(record, colorMode) {
      const logo = record?.logo;
      if (!logo || typeof logo !== 'object') return '';
      const preferred = colorMode === 'dark' ? logo.dark : logo.light;
      const fallback = colorMode === 'dark' ? logo.light : logo.dark;
      return String(preferred || fallback || '');
    }

    navigationLabel(record, active, colorMode) {
      const name = escapeHtml(record.name);
      const tabButton = TAB_BUTTONS[record?.id];
      if (tabButton) {
        const source = active ? tabButton.active : tabButton.inactive;
        return `<span class="nav-brand nav-tab-button has-logo"><img src="${source}" alt="" data-nav-logo data-tab-button data-active-src="${tabButton.active}" data-inactive-src="${tabButton.inactive}"><span class="nav-text">${name}</span></span>`;
      }
      const logoPath = this.logoPath(record, colorMode);
      if (!logoPath) return `<span class="nav-text">${name}</span>`;
      return `<span class="nav-brand has-logo"><img src="${escapeHtml(logoPath)}" alt="" data-nav-logo><span class="nav-text">${name}</span></span>`;
    }

    bindLogoFallback(container) {
      container.querySelectorAll('img[data-nav-logo]:not([data-fallback-bound])').forEach((image) => {
        image.dataset.fallbackBound = 'true';
        image.addEventListener('error', () => {
          image.hidden = true;
          image.closest('.nav-brand')?.classList.add('logo-missing');
        }, { once: true });
      });
    }

    renderHeaderNavigation() {
      this.renderNavigation();
      this.renderGlobalEntries();
      const hasManagement = Boolean(this.root.querySelector('.management-entries a'));
      const hasOperations = Boolean(this.root.querySelector('.global-entries a, .operation-entries a'));
      this.root.querySelector('.workflow-divider').hidden = !(hasManagement && hasOperations);
      this.bindLogoFallback(this.root.querySelector('.track'));
      requestAnimationFrame(() => this.root.querySelector('a[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
    }

    renderGlobalEntries() {
      const { hiddenGlobalActions, colorMode } = this.preferences();
      const actions = this.globalActions.filter((action) => !hiddenGlobalActions.includes(action.id) || action.appId === this.currentAppId);
      this.root.querySelector('.global-entries').innerHTML = actions.map((action) => {
        const active = action.appId === this.currentAppId;
        const temporary = active && hiddenGlobalActions.includes(action.id);
        return `<a class="tab global-entry${active ? ' is-current' : ''}${temporary ? ' temporary' : ''}" href="${escapeHtml(action.url)}" data-navigate data-target-app="${escapeHtml(action.appId)}" ${active ? 'aria-current="page"' : ''}>
          ${this.navigationLabel(action, active, colorMode)}${temporary ? '<small>현재 위치</small>' : ''}
        </a>`;
      }).join('');
    }

    renderNavigation() {
      const { hiddenGroups, colorMode } = this.preferences();
      for (const section of ['management', 'operations']) {
        const groups = this.groupsForSection(section);
        const visibleGroups = groups.filter((group) => !hiddenGroups.includes(group.id) || group.id === this.currentGroupId);
        const target = this.root.querySelector(section === 'management' ? '.management-entries' : '.operation-entries');
        target.innerHTML = visibleGroups.map((group) => {
          const active = group.id === this.currentGroupId;
          const temporary = active && hiddenGroups.includes(group.id);
          return `<a class="tab${temporary ? ' temporary' : ''}" href="${escapeHtml(group.url)}" data-navigate data-target-group="${escapeHtml(group.id)}" ${active ? 'aria-current="page"' : ''}>
            ${this.navigationLabel(group, active, colorMode)}${temporary ? '<small>현재 위치</small>' : ''}
          </a>`;
        }).join('');
      }
    }

    setPendingNavigationSelection(targetLink, appId, groupId) {
      const tabs = [...this.root.querySelectorAll('a.tab[data-navigate]')];
      const hasDirectAppTab = Boolean(appId && tabs.some((link) => link.dataset.targetApp === appId));
      let selectedTab = null;
      tabs.forEach((link) => {
        const selected = link === targetLink
          || (hasDirectAppTab ? link.dataset.targetApp === appId : Boolean(groupId && link.dataset.targetGroup === groupId));
        if (selected) selectedTab = link;
        link.classList.toggle('is-current', selected);
        if (selected) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
        const image = link.querySelector('img[data-tab-button]');
        if (image) image.src = selected ? image.dataset.activeSrc : image.dataset.inactiveSrc;
      });
      selectedTab?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    restoreCurrentNavigationSelection() {
      this.navigationPending = false;
      if (this.isConnected) this.renderHeaderNavigation();
    }

    representativeStatus() {
      const signals = [...this.statusSignals.values()].sort((a, b) => STATUS_PRIORITY[b.level] - STATUS_PRIORITY[a.level]);
      if (!signals.length) return { level: 'normal', message: this.normalMessage, checkedAt: Date.now() };
      return signals[0];
    }

    renderStatus() {
      const status = this.representativeStatus();
      const statusButton = this.root.querySelector('.status-action');
      statusButton.dataset.level = status.level;
      statusButton.setAttribute('aria-label', `현재 앱 상태: ${STATUS_LABEL[status.level]} — ${status.message}`);
      statusButton.querySelector('.status-label').textContent = STATUS_LABEL[status.level];

      const signals = [...this.statusSignals.values()].sort((a, b) => STATUS_PRIORITY[b.level] - STATUS_PRIORITY[a.level]);
      const items = signals.length ? signals : [{ level: 'normal', message: this.normalMessage }];
      this.root.querySelector('.current-status').innerHTML = `
        <div class="status-summary" data-level="${status.level}">
          <span class="status-dot" aria-hidden="true"></span>
          <div><strong>${escapeHtml(this.currentApp?.name || 'NEXUS 홈')}</strong><span>${escapeHtml(STATUS_LABEL[status.level])}</span></div>
        </div>
        <ul class="status-list">${items.map((item) => `<li data-level="${item.level}"><span aria-hidden="true"></span><div><strong>${escapeHtml(STATUS_LABEL[item.level])}</strong><p>${escapeHtml(item.message)}</p></div></li>`).join('')}</ul>
        <p class="status-help">현재 앱이 전달한 저장·동기화 상태만 실시간으로 표시합니다.</p>`;

      const globalButton = this.root.querySelector('.global-alert');
      globalButton.hidden = this.globalErrors.size === 0;
      if (this.globalErrors.size) {
        const message = [...this.globalErrors.values()][0];
        globalButton.setAttribute('aria-label', `NEXUS 전역 오류: ${message}`);
        globalButton.title = message;
      }
    }

    readStatusSnapshot(appId) {
      try {
        const snapshot = JSON.parse(localStorage.getItem(`${STORAGE.statusPrefix}${appId}`));
        return snapshot && Object.hasOwn(STATUS_PRIORITY, snapshot.level) ? snapshot : null;
      } catch {
        return null;
      }
    }

    statusMeta(app) {
      if (app.id === this.currentAppId) {
        const status = this.representativeStatus();
        return `<span class="app-status" data-level="${status.level}">${escapeHtml(STATUS_LABEL[status.level])}</span><span>현재 앱 · 실시간</span>`;
      }
      const snapshot = this.readStatusSnapshot(app.id);
      if (!snapshot) return '<span>최근 상태 없음</span>';
      const timestamp = Number(snapshot.checkedAt);
      if (!Number.isFinite(timestamp)) return `<span class="app-status" data-level="${snapshot.level}">${escapeHtml(STATUS_LABEL[snapshot.level])}</span><span>마지막 확인 시각 없음</span>`;
      const checkedAt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
      return `<span class="app-status" data-level="${snapshot.level}">${escapeHtml(STATUS_LABEL[snapshot.level])}</span><span>마지막 확인 ${escapeHtml(checkedAt)}</span>`;
    }

    appBadges(app, hiddenApps, favoriteApps) {
      const badges = [];
      if (favoriteApps.includes(app.id)) badges.push('<span class="badge favorite">즐겨찾기</span>');
      if (hiddenApps.includes(app.id)) badges.push('<span class="badge hidden">숨김</span>');
      if (app.lifecycle === 'development') badges.push('<span class="badge development">개발 중</span>');
      if (app.lifecycle === 'retired') badges.push('<span class="badge retired">사용 중지</span>');
      if (app.access === 'denied') badges.push('<span class="badge denied">🔒 권한 없음</span>');
      if (app.id === this.currentAppId) badges.push('<span class="badge current">현재 앱</span>');
      return badges.join('');
    }

    appMarkup(app, preferences) {
      const { hiddenApps, favoriteApps } = preferences;
      const favorite = favoriteApps.includes(app.id);
      const hidden = hiddenApps.includes(app.id);
      const unavailable = app.lifecycle === 'retired' || app.access === 'denied';
      const content = `<div class="app-copy"><div class="app-name"><strong>${escapeHtml(app.name)}</strong><span class="badges">${this.appBadges(app, hiddenApps, favoriteApps)}</span></div><small>${escapeHtml(app.description || '')}</small><div class="app-meta">${this.statusMeta(app)}</div>${app.lifecycle === 'retired' && app.retiredReason ? `<p class="stop-reason">${escapeHtml(app.retiredReason)}</p>` : ''}</div>`;
      const launch = unavailable
        ? `<div class="app-link disabled" aria-disabled="true">${content}</div>`
        : `<a class="app-link" href="${escapeHtml(app.url)}" data-navigate data-target-app="${escapeHtml(app.id)}">${content}</a>`;
      return `<article class="app-item${hidden ? ' is-hidden' : ''}${app.id === this.currentAppId ? ' is-current' : ''}">
        ${launch}
        <div class="app-preferences" aria-label="${escapeHtml(app.name)} 설정">
          <button type="button" data-app-favorite="${escapeHtml(app.id)}" aria-pressed="${favorite}" aria-label="${escapeHtml(app.name)} ${favorite ? '즐겨찾기 해제' : '즐겨찾기 설정'}">${favorite ? '★' : '☆'}</button>
          <button type="button" data-app-hidden="${escapeHtml(app.id)}" aria-pressed="${hidden}" aria-label="${escapeHtml(app.name)} ${hidden ? '메뉴에 표시' : '메뉴에서 숨김'}">${hidden ? '표시' : '숨김'}</button>
        </div>
      </article>`;
    }

    renderApps() {
      const preferences = this.preferences();
      const groups = this.orderedGroups();
      const favorites = preferences.favoriteApps.map((id) => this.apps.find((app) => app.id === id)).filter(Boolean);
      const favoriteIds = new Set(favorites.map((app) => app.id));
      const favoriteSection = favorites.length
        ? `<section class="app-group favorites"><h3>즐겨찾기</h3><div class="app-list">${favorites.map((app) => this.appMarkup(app, preferences)).join('')}</div></section>`
        : '';
      const groupSections = groups.map((group) => {
        const apps = this.apps.filter((app) => app.groupId === group.id && !favoriteIds.has(app.id));
        if (!apps.length) return '';
        return `<section class="app-group"><h3>${escapeHtml(group.name)}<span>${apps.length}</span></h3><div class="app-list">${apps.map((app) => this.appMarkup(app, preferences)).join('')}</div></section>`;
      }).join('');
      this.root.querySelector('.apps-content').innerHTML = `${favoriteSection}${groupSections}<p class="apps-note">즐겨찾기·숨김은 개별 앱 설정이며, 상단 업무 메뉴 설정과 별도로 저장됩니다.</p>`;
    }

    settingsRows(section, preferences) {
      const groups = this.groupsForSection(section);
      const globalRows = section === 'operations' ? this.globalActions.map((action) => `<div class="group-setting global-action-setting">
        <span class="fixed-menu-label">고정</span>
        <strong>${escapeHtml(action.name)}</strong>
        <label class="switch"><input type="checkbox" data-global-visible="${escapeHtml(action.id)}" ${preferences.hiddenGlobalActions.includes(action.id) ? '' : 'checked'}><span aria-hidden="true"></span><b>${preferences.hiddenGlobalActions.includes(action.id) ? '숨김' : '노출'}</b></label>
      </div>`).join('') : '';
      const groupRows = groups.map((group, index) => `<div class="group-setting">
        <div class="move-buttons"><button type="button" data-group-move="-1" data-group-id="${group.id}" aria-label="${escapeHtml(group.name)} 위로" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-group-move="1" data-group-id="${group.id}" aria-label="${escapeHtml(group.name)} 아래로" ${index === groups.length - 1 ? 'disabled' : ''}>↓</button></div>
        <strong>${escapeHtml(group.name)}</strong>
        <label class="switch"><input type="checkbox" data-group-visible="${group.id}" ${preferences.hiddenGroups.includes(group.id) ? '' : 'checked'}><span aria-hidden="true"></span><b>${preferences.hiddenGroups.includes(group.id) ? '숨김' : '노출'}</b></label>
      </div>`).join('');
      return `<div class="settings-menu-group"><h4>${SECTION_LABEL[section]}</h4>${globalRows}${groupRows}</div>`;
    }

    renderSettings() {
      const preferences = this.preferences();
      const colorOptions = [['light', '일반'], ['dark', '다크']];
      this.root.querySelector('.settings-content').innerHTML = `
        <section class="settings-section"><h3>화면 모드</h3><div class="segments two" role="group" aria-label="화면 모드">${colorOptions.map(([id, label]) => `<button type="button" data-color-mode="${id}" aria-pressed="${preferences.colorMode === id}">${label}</button>`).join('')}</div></section>
        <section class="settings-section"><div class="section-title"><div><h3>상단 메뉴</h3><p>기준·관리와 운영 흐름의 노출·순서를 관리합니다.</p></div><button type="button" class="reset" data-reset-groups>초기화</button></div>
          <div class="group-settings">${this.settingsRows('management', preferences)}${this.settingsRows('operations', preferences)}</div>
        </section>
        <div class="storage-warning" role="status" aria-live="polite" ${this.pendingWrites.size ? '' : 'hidden'}><strong>이 기기에만 적용됨</strong><span>개인 설정을 영구 저장하지 못했습니다.</span><button type="button" data-retry-storage>저장 재시도</button></div>
        <p class="settings-note">개별 앱의 즐겨찾기·숨김은 <strong>전체 앱</strong>에서 설정합니다.</p>`;
    }

    applyEnvironment() {
      const { colorMode } = this.preferences();
      const root = document.documentElement;
      themeController.apply(colorMode, { emit: true, source: 'header' });
      root.style.setProperty('--nexus-top-height', '44px');
      root.style.setProperty('--nexus-content-gutter', '24px');
    }

    bind() {
      this.root.addEventListener('click', (event) => this.handleClick(event));
      this.onDocumentClick = (event) => {
        if (this.openPanel === 'status' && !event.composedPath().includes(this)) this.closePanel();
      };
      this.onDocumentKeydown = (event) => {
        if (event.key === 'Escape' && this.openPanel) {
          event.preventDefault();
          this.closePanel();
          return;
        }
        if (event.key === 'Tab') this.trapFocus(event);
      };
      this.onStorage = (event) => {
        const preferenceKeys = Object.values(STORAGE).filter((key) => key !== STORAGE.statusPrefix);
        if (preferenceKeys.includes(event.key) || event.key?.startsWith(STORAGE.statusPrefix)) {
          if (!this.pendingWrites.has(event.key)) this.memory.delete(event.key);
          this.renderAll();
          this.applyEnvironment();
        }
      };
      this.onAppStatus = (event) => this.receiveStatus(event.detail);
      this.onGlobalError = (event) => this.receiveGlobalError(event.detail);
      this.onPageShow = () => this.restoreCurrentNavigationSelection();
      document.addEventListener('click', this.onDocumentClick);
      document.addEventListener('keydown', this.onDocumentKeydown);
      window.addEventListener('storage', this.onStorage);
      window.addEventListener('nexus:app-status', this.onAppStatus);
      window.addEventListener('nexus:global-error', this.onGlobalError);
      window.addEventListener('pageshow', this.onPageShow);
    }

    handleClick(event) {
      const openButton = event.target.closest('[data-open]');
      if (openButton) {
        this.togglePanel(openButton.dataset.open, openButton);
        return;
      }
      if (event.target.closest('.close') || event.target.classList.contains('backdrop')) {
        this.closePanel();
        return;
      }
      const link = event.target.closest('a[data-navigate]');
      if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
        event.preventDefault();
        this.navigate(link);
        return;
      }
      const colorButton = event.target.closest('[data-color-mode]');
      if (colorButton) {
        const colorMode = colorButton.dataset.colorMode === 'dark' ? 'dark' : 'light';
        this.writePreference(STORAGE.colorMode, colorMode);
        this.applyEnvironment();
        this.renderHeaderNavigation();
        this.renderSettings();
        return;
      }
      const globalVisibility = event.target.closest('[data-global-visible]');
      if (globalVisibility) {
        const preferences = this.preferences();
        const id = globalVisibility.dataset.globalVisible;
        const hiddenGlobalActions = globalVisibility.checked
          ? preferences.hiddenGlobalActions.filter((actionId) => actionId !== id)
          : unique([...preferences.hiddenGlobalActions, id]);
        this.writePreference(STORAGE.hiddenGlobalActions, hiddenGlobalActions);
        this.renderAll();
        return;
      }
      const moveButton = event.target.closest('[data-group-move]');
      if (moveButton) {
        this.moveGroup(moveButton.dataset.groupId, Number(moveButton.dataset.groupMove));
        return;
      }
      const groupVisibility = event.target.closest('[data-group-visible]');
      if (groupVisibility) {
        const preferences = this.preferences();
        const id = groupVisibility.dataset.groupVisible;
        const hiddenGroups = groupVisibility.checked
          ? preferences.hiddenGroups.filter((groupId) => groupId !== id)
          : unique([...preferences.hiddenGroups, id]);
        this.writePreference(STORAGE.hiddenGroups, hiddenGroups);
        this.renderAll();
        return;
      }
      const favoriteButton = event.target.closest('[data-app-favorite]');
      if (favoriteButton) {
        const preferences = this.preferences();
        const id = favoriteButton.dataset.appFavorite;
        const favorites = preferences.favoriteApps.includes(id)
          ? preferences.favoriteApps.filter((appId) => appId !== id)
          : [...preferences.favoriteApps, id];
        this.writePreference(STORAGE.favoriteApps, favorites);
        this.renderApps();
        this.renderSettings();
        return;
      }
      const hiddenButton = event.target.closest('[data-app-hidden]');
      if (hiddenButton) {
        const preferences = this.preferences();
        const id = hiddenButton.dataset.appHidden;
        const hiddenApps = preferences.hiddenApps.includes(id)
          ? preferences.hiddenApps.filter((appId) => appId !== id)
          : [...preferences.hiddenApps, id];
        this.writePreference(STORAGE.hiddenApps, hiddenApps);
        this.renderApps();
        this.renderSettings();
        return;
      }
      if (event.target.closest('[data-reset-groups]')) {
        this.writePreference(STORAGE.groupOrder, this.groups.map((group) => group.id));
        this.writePreference(STORAGE.hiddenGroups, []);
        this.writePreference(STORAGE.hiddenGlobalActions, []);
        this.renderAll();
        return;
      }
      if (event.target.closest('[data-retry-storage]')) this.retryStorage();
    }

    moveGroup(groupId, direction) {
      const preferences = this.preferences();
      const group = this.groups.find((item) => item.id === groupId);
      if (!group) return;
      const section = group.section || 'operations';
      const peers = preferences.groupOrder.filter((id) => (this.groups.find((item) => item.id === id)?.section || 'operations') === section);
      const peerIndex = peers.indexOf(groupId);
      const targetPeer = peers[peerIndex + direction];
      if (!targetPeer) return;
      const currentIndex = preferences.groupOrder.indexOf(groupId);
      const targetIndex = preferences.groupOrder.indexOf(targetPeer);
      [preferences.groupOrder[currentIndex], preferences.groupOrder[targetIndex]] = [preferences.groupOrder[targetIndex], preferences.groupOrder[currentIndex]];
      this.writePreference(STORAGE.groupOrder, preferences.groupOrder);
      this.renderAll();
    }

    navigate(link) {
      const appId = link.dataset.targetApp || '';
      const groupId = link.dataset.targetGroup || this.apps.find((app) => app.id === appId)?.groupId || '';
      const navigationEvent = new CustomEvent('nexus:before-navigate', {
        cancelable: true,
        detail: { appId, groupId, url: link.href },
      });
      if (!window.dispatchEvent(navigationEvent)) return;
      this.closePanel({ restoreFocus: false });
      if (this.navigationPending) return;
      this.navigationPending = true;
      this.setPendingNavigationSelection(link, appId, groupId);
      const label = this.apps.find((app) => app.id === appId)?.name
        || this.groups.find((group) => group.id === groupId)?.name
        || link.getAttribute('aria-label')
        || link.textContent.trim()
        || 'NEXUS';
      const mode = navigationMode();
      const marker = { label, mode, startedAt: Date.now(), url: link.href };
      try { sessionStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(marker)); } catch {}
      installNavigationCover(label, mode);
      window.setTimeout(() => {
        if (!this.navigationPending) return;
        this.restoreCurrentNavigationSelection();
        clearNavigationCover(true);
      }, 12000);
      window.setTimeout(() => {
        try {
          window.location.assign(link.href);
        } catch {
          this.restoreCurrentNavigationSelection();
          clearNavigationCover(true);
        }
      }, 80);
    }

    togglePanel(name, trigger) {
      if (this.openPanel === name) {
        this.closePanel();
        return;
      }
      this.closePanel({ restoreFocus: false });
      this.openPanel = name;
      this.panelTrigger = trigger;
      const panel = this.root.querySelector(`[data-panel="${name}"]`);
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      const modal = name === 'apps' || name === 'settings';
      this.root.querySelector('.backdrop').hidden = !modal;
      requestAnimationFrame(() => this.focusable(panel)[0]?.focus());
    }

    closePanel({ restoreFocus = true } = {}) {
      if (!this.openPanel) return;
      this.root.querySelector(`[data-panel="${this.openPanel}"]`).hidden = true;
      this.root.querySelector(`[data-open="${this.openPanel}"]`)?.setAttribute('aria-expanded', 'false');
      this.root.querySelector('.backdrop').hidden = true;
      const trigger = this.panelTrigger;
      this.openPanel = '';
      this.panelTrigger = null;
      if (restoreFocus) trigger?.focus();
    }

    focusable(container) {
      return [...container.querySelectorAll('a[href],button:not([disabled]),input:not([disabled])')].filter((element) => !element.hidden && element.getAttribute('aria-disabled') !== 'true');
    }

    trapFocus(event) {
      if (!['apps', 'settings'].includes(this.openPanel)) return;
      const panel = this.root.querySelector(`[data-panel="${this.openPanel}"]`);
      const elements = this.focusable(panel);
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && this.root.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && this.root.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    retryStorage() {
      for (const [key, value] of [...this.pendingWrites]) {
        try {
          localStorage.setItem(key, JSON.stringify(value));
          this.pendingWrites.delete(key);
          this.memory.delete(key);
        } catch {
          // Keep the current visual state and pending value for another retry.
        }
      }
      this.renderSettings();
    }

    receiveStatus(detail = {}) {
      const eventAppId = detail.appId ? this.canonicalAppId(detail.appId) : this.currentAppId;
      if (!this.currentAppId || eventAppId !== this.currentAppId) return;
      const level = normalizeLevel(detail.level || detail.status || 'normal');
      const taskId = String(detail.taskId || 'current');
      if (detail.active === false || level === 'normal') {
        if (detail.taskId) this.statusSignals.delete(taskId);
        else this.statusSignals.clear();
        this.normalMessage = String(detail.message || '대기 중인 작업이 없습니다.');
      } else {
        this.statusSignals.set(taskId, {
          level,
          message: String(detail.message || STATUS_LABEL[level]),
          taskId,
          checkedAt: Date.now(),
        });
      }
      const representative = this.representativeStatus();
      try {
        localStorage.setItem(`${STORAGE.statusPrefix}${this.currentAppId}`, JSON.stringify({
          level: representative.level,
          message: representative.message,
          checkedAt: Date.now(),
        }));
      } catch {
        // Status history is optional and must never block the current application.
      }
      this.renderStatus();
      this.renderApps();
    }

    receiveGlobalError(detail = {}) {
      const id = String(detail.id || 'global');
      if (detail.active === false || detail.clear === true) this.globalErrors.delete(id);
      else this.globalErrors.set(id, String(detail.message || 'NEXUS 공통 서비스에 문제가 있습니다.'));
      this.renderStatus();
    }
  }

  if (!customElements.get('nexus-top')) customElements.define('nexus-top', NexusTop);
})();
