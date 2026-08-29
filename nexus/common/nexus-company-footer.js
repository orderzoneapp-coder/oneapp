(() => {
  'use strict';

  const VERSION = '1.1.0';
  const SCHEMA_VERSION = 'NEXUS_COMPANY_PUBLIC_FOOTER_V1';
  const COMPANY_ID = 'ONEAPP';
  const STORAGE_KEY_PREFIX = `oneapp.nexus.company-public.${COMPANY_ID}.${SCHEMA_VERSION}.`;
  const CHECK_KEY_PREFIX = `oneapp.nexus.company-public-check.${COMPANY_ID}.${SCHEMA_VERSION}.`;
  const CHECK_TTL_MS = 2 * 60 * 1000;
  const PUBLIC_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwIaouo6kzff1J3H3B0K5bWuAEJAcp4K21tyEkL2BuM-SiNsPDGGYVBEXIkBeUGwp4i/exec';
  const ELEMENT_NAME = 'nexus-company-footer';
  const LAYOUT_STYLE_ID = 'nexusCompanyFooterLayout';
  const PUBLIC_FIELDS = Object.freeze([
    'companyName', 'businessNumber', 'representativeName', 'companyPhone', 'businessAddress', 'homepage'
  ]);
  const SNAPSHOT_KEYS = Object.freeze([...PUBLIC_FIELDS, 'revision']);
  const ENVELOPE_KEYS = Object.freeze(['schemaVersion', 'companyId', 'userScope', 'snapshot']);
  const DEFAULT_SNAPSHOT = Object.freeze({
    companyName: '원앱',
    businessNumber: '380-14-01523',
    representativeName: '이무철',
    companyPhone: '',
    businessAddress: '서울특별시 송파구 양재대로 932, 9층 19호 (가락동, 가락동 농수산물도매시장)',
    homepage: '',
    revision: 1
  });

  let currentUserScope = '';
  let currentSnapshot = DEFAULT_SNAPSHOT;
  let refreshPromise = null;

  const text = value => String(value == null ? '' : value).normalize('NFKC').trim();
  const businessNumber = value => {
    const digits = text(value).replace(/\D/g, '');
    return /^\d{10}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : '';
  };
  const homepage = value => {
    const candidate = text(value);
    return /^https:\/\/[a-z0-9.-]+(?:[:/]|$)/i.test(candidate) ? candidate : '';
  };
  const normalizeSnapshot = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.keys(value).some(key => !SNAPSHOT_KEYS.includes(key))) return null;
    const revision = Number(value.revision);
    if (!Number.isInteger(revision) || revision < 1) return null;
    const normalized = {
      companyName: text(value.companyName),
      businessNumber: businessNumber(value.businessNumber),
      representativeName: text(value.representativeName),
      companyPhone: text(value.companyPhone),
      businessAddress: text(value.businessAddress),
      homepage: homepage(value.homepage),
      revision
    };
    if (!normalized.companyName || !normalized.businessNumber || !normalized.representativeName || !normalized.businessAddress) return null;
    return Object.freeze(normalized);
  };
  const sessionScope = session => text(session?.user?.userId) || 'PUBLIC';
  const storageKey = scope => scope ? `${STORAGE_KEY_PREFIX}${encodeURIComponent(scope)}` : '';
  const readStoredSnapshot = scope => {
    if (!scope) return DEFAULT_SNAPSHOT;
    try {
      const key = storageKey(scope);
      const envelope = JSON.parse(localStorage.getItem(key) || 'null');
      const validEnvelope = envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        && Object.keys(envelope).every(key => ENVELOPE_KEYS.includes(key))
        && text(envelope.schemaVersion) === SCHEMA_VERSION
        && text(envelope.companyId).toUpperCase() === COMPANY_ID
        && text(envelope.userScope) === scope;
      const stored = validEnvelope ? normalizeSnapshot(envelope.snapshot) : null;
      if (stored) return stored;
      localStorage.removeItem(key);
    } catch {
      try { localStorage.removeItem(storageKey(scope)); } catch {}
    }
    return DEFAULT_SNAPSHOT;
  };
  const projectGatewayResult = result => {
    const source = result && (result.publicSnapshot || result.snapshot || result.profile);
    if (!source) return null;
    const businessAddress = source.businessAddress !== undefined
      ? source.businessAddress
      : [source.address1, source.address2].map(text).filter(Boolean).join(' ');
    return normalizeSnapshot({
      companyName: source.companyName,
      businessNumber: source.businessNumber,
      representativeName: source.representativeName,
      companyPhone: source.companyPhone,
      businessAddress,
      homepage: source.homepage,
      revision: source.revision
    });
  };
  const broadcastSnapshot = source => {
    document.querySelectorAll(ELEMENT_NAME).forEach(element => element.render?.(currentSnapshot));
    window.dispatchEvent(new CustomEvent('nexus-company-public-change', {
      detail: { snapshot: currentSnapshot, source }
    }));
  };
  const commitSnapshot = (candidate, source = 'server') => {
    const next = normalizeSnapshot(candidate);
    if (!currentUserScope || !next || next.revision <= currentSnapshot.revision) return false;
    try {
      localStorage.setItem(storageKey(currentUserScope), JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        companyId: COMPANY_ID,
        userScope: currentUserScope,
        snapshot: next
      }));
    } catch {
      return false;
    }
    currentSnapshot = next;
    broadcastSnapshot(source);
    return true;
  };
  const acceptGatewayResult = (result, source = 'server') => {
    const next = projectGatewayResult(result);
    return next ? commitSnapshot(next, source) : false;
  };
  const applySessionScope = (session, source = 'auth') => {
    const nextScope = sessionScope(session);
    if (nextScope === currentUserScope) return false;
    currentUserScope = nextScope;
    currentSnapshot = readStoredSnapshot(nextScope);
    broadcastSnapshot(source);
    return true;
  };
  const checkKey = session => `${CHECK_KEY_PREFIX}${encodeURIComponent(sessionScope(session) || 'anonymous')}`;
  const recentlyChecked = session => {
    try {
      const checkedAt = Number(sessionStorage.getItem(checkKey(session)) || 0);
      return Number.isFinite(checkedAt) && Date.now() - checkedAt < CHECK_TTL_MS;
    } catch {
      return false;
    }
  };
  const markChecked = session => {
    try { sessionStorage.setItem(checkKey(session), String(Date.now())); } catch {}
  };
  const setSyncState = state => document.querySelectorAll(ELEMENT_NAME).forEach(element => {
    element.dataset.syncState = state;
    element.render?.(currentSnapshot);
  });
  const publicRead = knownRevision => fetch(PUBLIC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'nexus_public_company_snapshot', knownRevision })
  }).then(response => {
    if (!response.ok) throw new Error('NEXUS_PUBLIC_COMPANY_HTTP_ERROR');
    return response.json();
  }).then(response => {
    if (!response || response.status !== 'success' || response.action !== 'nexus_public_company_snapshot') {
      throw new Error('NEXUS_PUBLIC_COMPANY_RESPONSE_INVALID');
    }
    return response.data || {};
  });
  const revalidate = ({ force = false } = {}) => {
    if (refreshPromise) return refreshPromise;
    const session = window.ONEAPP_AUTH?.session || null;
    applySessionScope(session);
    if (!force && recentlyChecked(session)) return Promise.resolve(currentSnapshot);
    setSyncState('checking');
    refreshPromise = publicRead(currentSnapshot.revision)
      .then(result => {
        markChecked(session);
        acceptGatewayResult(result, 'server');
        setSyncState('ready');
        return currentSnapshot;
      })
      .catch(() => {
        setSyncState('error');
        return currentSnapshot;
      })
      .finally(() => { refreshPromise = null; });
    return refreshPromise;
  };

  currentUserScope = sessionScope(window.ONEAPP_AUTH?.session);
  currentSnapshot = readStoredSnapshot(currentUserScope);

  class NexusCompanyFooter extends HTMLElement {
    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
      this.root.innerHTML = `
        <style>
          :host{display:block;flex:0 0 auto;width:100%;margin-top:auto;color:#45556c;background:#f8fafc;border-top:1px solid #dce3eb;box-shadow:0 -8px 28px rgba(28,45,67,.08);font:11px/1.45 Inter,Pretendard,"Noto Sans KR",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
          .wrap{min-height:58px;padding:9px max(16px,calc((100vw - 1360px)/2));display:grid;gap:4px;align-content:center}
          .line{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px}.line strong{color:#17283e;font-size:13px}.item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.item b{color:#6b7b90;font-size:9px;letter-spacing:.04em}.address{min-width:0;white-space:normal}.address span{word-break:keep-all}.homepage{color:#315f91;text-decoration:none}.homepage:hover{text-decoration:underline}
          .sync{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
          :host-context(html[data-nexus-theme="dark"]),:host-context(html[data-nexus-color-mode="dark"]){color:#a7b5c5;background:#101722;border-top-color:#2b3747;box-shadow:0 -8px 28px rgba(0,0,0,.28)}
          :host-context(html[data-nexus-theme="dark"]) .line strong,:host-context(html[data-nexus-color-mode="dark"]) .line strong{color:#f2f6fb}
          :host-context(html[data-nexus-theme="dark"]) .item b,:host-context(html[data-nexus-color-mode="dark"]) .item b{color:#8f9aaa}
          :host-context(html[data-nexus-theme="dark"]) .homepage,:host-context(html[data-nexus-color-mode="dark"]) .homepage{color:#8bb9eb}
          @media(max-width:680px){.wrap{min-height:82px;padding:8px 12px;gap:5px}.line{gap:3px 10px}.line strong{font-size:12px}.address{flex-basis:100%}}
          @media print{:host{display:none!important}}
        </style>
        <footer class="wrap" role="contentinfo" aria-label="원앱 회사 기본정보">
          <div class="line primary"></div>
          <div class="line secondary"></div>
          <span class="sync" aria-live="polite"></span>
        </footer>`;
    }

    connectedCallback() {
      this.render(currentSnapshot);
    }

    render(snapshot) {
      if (!snapshot) return;
      this.dataset.revision = String(snapshot.revision);
      const primary = this.root.querySelector('.primary');
      const secondary = this.root.querySelector('.secondary');
      primary.replaceChildren();
      const name = document.createElement('strong');
      name.textContent = snapshot.companyName;
      primary.append(name, this.item('사업자등록번호', snapshot.businessNumber), this.item('대표자', snapshot.representativeName));
      if (snapshot.companyPhone) primary.append(this.item('회사전화', snapshot.companyPhone));
      if (snapshot.homepage) {
        const link = document.createElement('a');
        link.className = 'item homepage';
        link.href = snapshot.homepage;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '홈페이지';
        primary.append(link);
      }
      secondary.replaceChildren(this.item('사업장 주소', snapshot.businessAddress, 'address'));
      this.root.querySelector('.sync').textContent = this.dataset.syncState === 'error'
        ? '공개 회사정보 최신 확인이 지연되고 있습니다. 마지막 정상 정보를 표시합니다.'
        : '';
    }

    item(label, value, className = '') {
      const item = document.createElement('span');
      item.className = `item ${className}`.trim();
      const key = document.createElement('b');
      const content = document.createElement('span');
      key.textContent = label;
      content.textContent = value;
      item.append(key, content);
      return item;
    }
  }

  if (!customElements.get(ELEMENT_NAME)) customElements.define(ELEMENT_NAME, NexusCompanyFooter);

  window.addEventListener('nexus-auth-ready', event => {
    applySessionScope(event.detail);
    window.setTimeout(() => { void revalidate({ force: true }); }, 0);
  });

  const mount = () => {
    if (!document.body || document.querySelector(ELEMENT_NAME)) return;
    if (!document.getElementById(LAYOUT_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = LAYOUT_STYLE_ID;
      style.textContent = 'html{min-height:100%}:root{--nexus-company-footer-height:58px}body.nexus-company-footer-mounted{min-height:100vh;display:flex;flex-direction:column}body.nexus-company-footer-mounted>nexus-company-footer{margin-top:auto}body.nexus-company-footer-mounted>#root>.h-screen,body.nexus-company-footer-mounted>#root.h-screen{height:calc(100vh - var(--nexus-top-height,0px) - var(--nexus-company-footer-height))!important}@media(max-width:680px){:root{--nexus-company-footer-height:82px}}';
      (document.head || document.documentElement).appendChild(style);
    }
    document.body.classList.add('nexus-company-footer-mounted');
    document.body.append(document.createElement(ELEMENT_NAME));
    window.dispatchEvent(new CustomEvent('nexus-company-public-ready', { detail: { snapshot: currentSnapshot } }));
    window.setTimeout(() => { void revalidate(); }, 0);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  window.ONEAPP_COMPANY_PUBLIC = Object.freeze({
    version: VERSION,
    schemaVersion: SCHEMA_VERSION,
    companyId: COMPANY_ID,
    get storageKey() { return storageKey(currentUserScope); },
    get userScope() { return currentUserScope; },
    publicFields: PUBLIC_FIELDS,
    get snapshot() { return currentSnapshot; },
    acceptGatewayResult,
    revalidate
  });
})();
