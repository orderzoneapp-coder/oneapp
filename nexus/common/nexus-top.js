(() => {
  const VERSION = '1.1.0';
  const STORAGE = Object.freeze({
    colorMode: 'oneapp.nexus.v1.colorMode',
    density: 'oneapp.nexus.v1.density',
    groupOrder: 'oneapp.nexus.v1.groupOrder',
    hiddenGroups: 'oneapp.nexus.v1.hiddenGroups',
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
  const STATUS_PRIORITY = Object.freeze({ normal: 0, progress: 1, warning: 2, error: 3 });
  const STATUS_LABEL = Object.freeze({ normal: '정상', progress: '진행 중', warning: '주의', error: '오류' });
  const LIFECYCLE_LABEL = Object.freeze({ operational: '운영', development: '개발 중', retired: '사용 중지' });
  const base = new URL('.', document.currentScript?.src || '/nexus/common/nexus-top.js');

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const asArray = (value) => Array.isArray(value) ? value : [];
  const unique = (values) => [...new Set(values)];
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
        this.aliases = window.NEXUS_APP_ALIASES || {};
        if (!this.groups.length || !this.apps.length) throw new Error('NEXUS app configuration is unavailable.');

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
        this.currentGroupId = this.currentApp?.groupId || this.resolveLegacyGroup(this.declaredAppId);

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
      this.colorSchemeMedia?.removeEventListener?.('change', this.onSystemThemeChange);
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
      return `
        <link rel="stylesheet" href="${stylesheet}">
        <header class="top" aria-label="NEXUS 공통 헤더">
          <a class="brand" href="https://oneapp.orderz.co.kr/nexus/" aria-label="NEXUS 홈" data-navigate data-target-app="">
            <img src="/nexus/assets/brand/oneapp-nexus-dark.svg" alt="ONEAPP NEXUS">
          </a>
          <nav class="nav" aria-label="업무군 메뉴"><div class="track"></div></nav>
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
          <div class="heading"><div><span class="eyebrow">NEXUS</span><h2>공통헤더 설정</h2><p>업무군 메뉴와 개인 화면환경을 설정합니다.</p></div><button class="close" type="button" aria-label="설정 닫기">×</button></div>
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
        return raw == null ? undefined : JSON.parse(raw);
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
      const legacyOrder = asArray(this.readValue(LEGACY.groupOrder)).map((id) => LEGACY_GROUP_IDS[id]).filter(Boolean);
      const savedOrder = asArray(this.readValue(STORAGE.groupOrder));
      const requestedOrder = savedOrder.length ? savedOrder : legacyOrder;
      const groupOrder = unique([
        ...requestedOrder.filter((id) => groupIds.includes(id)),
        ...groupIds,
      ]);
      const legacyHidden = asArray(this.readValue(LEGACY.hiddenGroups)).map((id) => LEGACY_GROUP_IDS[id]).filter(Boolean);
      const savedHiddenGroups = this.readValue(STORAGE.hiddenGroups);
      const hiddenGroups = asArray(savedHiddenGroups === undefined ? legacyHidden : savedHiddenGroups).filter((id) => groupIds.includes(id));
      const defaultHiddenApps = this.apps.filter((app) => app.defaultHidden).map((app) => app.id);
      const hiddenApps = asArray(this.readPreference(STORAGE.hiddenApps, defaultHiddenApps)).filter((id) => appIds.includes(id));
      const favoriteApps = asArray(this.readPreference(STORAGE.favoriteApps, [])).filter((id) => appIds.includes(id));
      const legacyTheme = this.readValue(LEGACY.colorMode);
      const colorMode = ['system', 'light', 'dark'].includes(this.readValue(STORAGE.colorMode))
        ? this.readValue(STORAGE.colorMode)
        : (['system', 'light', 'dark'].includes(legacyTheme) ? legacyTheme : 'system');
      const density = ['standard', 'compact'].includes(this.readValue(STORAGE.density)) ? this.readValue(STORAGE.density) : 'standard';
      return { groupOrder, hiddenGroups, hiddenApps, favoriteApps, colorMode, density };
    }

    orderedGroups() {
      const { groupOrder } = this.preferences();
      const groupsById = Object.fromEntries(this.groups.map((group) => [group.id, group]));
      return groupOrder.map((id) => groupsById[id]).filter(Boolean);
    }

    renderAll() {
      this.renderNavigation();
      this.renderStatus();
      this.renderApps();
      this.renderSettings();
    }

    renderNavigation() {
      const { hiddenGroups } = this.preferences();
      const groups = this.orderedGroups();
      const visibleGroups = groups.filter((group) => !hiddenGroups.includes(group.id) || group.id === this.currentGroupId);
      this.root.querySelector('.track').innerHTML = visibleGroups.map((group) => {
        const active = group.id === this.currentGroupId;
        const temporary = active && hiddenGroups.includes(group.id);
        return `<a class="tab${temporary ? ' temporary' : ''}" href="${escapeHtml(group.url)}" data-navigate data-target-group="${escapeHtml(group.id)}" ${active ? 'aria-current="page"' : ''}>
          <span>${escapeHtml(group.name)}</span>${temporary ? '<small>현재 위치</small>' : ''}
        </a>`;
      }).join('');
      requestAnimationFrame(() => this.root.querySelector('.tab[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
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
      this.root.querySelector('.apps-content').innerHTML = `${favoriteSection}${groupSections}<p class="apps-note">즐겨찾기·숨김은 개별 앱 설정이며, 업무군 메뉴 설정과 별도로 저장됩니다.</p>`;
    }

    renderSettings() {
      const preferences = this.preferences();
      const groups = this.orderedGroups();
      const colorOptions = [['system', '시스템'], ['light', '일반'], ['dark', '다크']];
      const densityOptions = [['standard', '표준'], ['compact', '압축']];
      this.root.querySelector('.settings-content').innerHTML = `
        <section class="settings-section"><h3>색상 모드</h3><div class="segments" role="group" aria-label="색상 모드">${colorOptions.map(([id, label]) => `<button type="button" data-color-mode="${id}" aria-pressed="${preferences.colorMode === id}">${label}</button>`).join('')}</div></section>
        <section class="settings-section"><h3>화면 밀도</h3><div class="segments two" role="group" aria-label="화면 밀도">${densityOptions.map(([id, label]) => `<button type="button" data-density="${id}" aria-pressed="${preferences.density === id}">${label}</button>`).join('')}</div><p class="section-note">헤더와 지원 앱의 작업영역 밀도를 변경합니다.</p></section>
        <section class="settings-section"><div class="section-title"><div><h3>업무군 메뉴</h3><p>노출과 순서를 업무군 단위로 관리합니다.</p></div><button type="button" class="reset" data-reset-groups>초기화</button></div>
          <div class="group-settings">${groups.map((group, index) => `<div class="group-setting">
            <div class="move-buttons"><button type="button" data-group-move="-1" data-group-id="${group.id}" aria-label="${escapeHtml(group.name)} 위로" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-group-move="1" data-group-id="${group.id}" aria-label="${escapeHtml(group.name)} 아래로" ${index === groups.length - 1 ? 'disabled' : ''}>↓</button></div>
            <strong>${escapeHtml(group.name)}</strong>
            <label class="switch"><input type="checkbox" data-group-visible="${group.id}" ${preferences.hiddenGroups.includes(group.id) ? '' : 'checked'}><span aria-hidden="true"></span><b>${preferences.hiddenGroups.includes(group.id) ? '숨김' : '노출'}</b></label>
          </div>`).join('')}</div>
        </section>
        <div class="storage-warning" role="status" aria-live="polite" ${this.pendingWrites.size ? '' : 'hidden'}><strong>이 기기에만 적용됨</strong><span>개인 설정을 영구 저장하지 못했습니다.</span><button type="button" data-retry-storage>저장 재시도</button></div>
        <p class="settings-note">개별 앱의 즐겨찾기·숨김은 <strong>전체 앱</strong>에서 설정합니다.</p>`;
    }

    applyEnvironment() {
      const { colorMode, density } = this.preferences();
      const root = document.documentElement;
      root.dataset.nexusColorMode = colorMode;
      root.dataset.nexusTheme = colorMode;
      root.dataset.nexusDensity = density;
      root.style.colorScheme = colorMode === 'system' ? 'light dark' : colorMode;
      root.style.setProperty('--nexus-top-height', density === 'compact' ? '36px' : '44px');
      root.style.setProperty('--nexus-content-gutter', density === 'compact' ? '12px' : '24px');
      window.dispatchEvent(new CustomEvent('nexus-theme-change', { detail: { theme: colorMode, colorMode } }));
      window.dispatchEvent(new CustomEvent('nexus-density-change', { detail: { density } }));
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
      this.onSystemThemeChange = () => {
        if (this.preferences().colorMode === 'system') window.dispatchEvent(new CustomEvent('nexus-theme-change', { detail: { theme: 'system', colorMode: 'system' } }));
      };
      document.addEventListener('click', this.onDocumentClick);
      document.addEventListener('keydown', this.onDocumentKeydown);
      window.addEventListener('storage', this.onStorage);
      this.colorSchemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)');
      this.colorSchemeMedia?.addEventListener?.('change', this.onSystemThemeChange);
      window.addEventListener('nexus:app-status', (event) => this.receiveStatus(event.detail));
      window.addEventListener('nexus:global-error', (event) => this.receiveGlobalError(event.detail));
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
        this.writePreference(STORAGE.colorMode, colorButton.dataset.colorMode);
        this.applyEnvironment();
        this.renderSettings();
        return;
      }
      const densityButton = event.target.closest('[data-density]');
      if (densityButton) {
        this.writePreference(STORAGE.density, densityButton.dataset.density);
        this.applyEnvironment();
        this.renderAll();
        return;
      }
      const moveButton = event.target.closest('[data-group-move]');
      if (moveButton) {
        const preferences = this.preferences();
        const index = preferences.groupOrder.indexOf(moveButton.dataset.groupId);
        const target = index + Number(moveButton.dataset.groupMove);
        if (index >= 0 && target >= 0 && target < preferences.groupOrder.length) {
          [preferences.groupOrder[index], preferences.groupOrder[target]] = [preferences.groupOrder[target], preferences.groupOrder[index]];
          this.writePreference(STORAGE.groupOrder, preferences.groupOrder);
          this.renderAll();
        }
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
        this.renderAll();
        return;
      }
      if (event.target.closest('[data-retry-storage]')) this.retryStorage();
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
      window.location.assign(link.href);
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
