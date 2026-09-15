// Source for the generated master-app.js. Edit this file, then run pnpm build:master.
if (!window.React || !window.ReactDOM) {
  throw new Error('React/ReactDOM 라이브러리 로드 실패');
}
const {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  Fragment
} = React;

// ==========================================
// 🔑 Global Storage Keys & Constants
// ==========================================
const STORAGE_KEYS = {
  // MerchOps 공통 클라우드/마스터 저장키
  MASTER_DB: 'merchMaster_v870',
  MASTER_STORE: 'master_products',
  CLOUD_URL: 'oneapp_cloud_sync_url_v1',
  LEGACY_CLOUD_URL: 'merchCloudUrl_v870',
  OLD_CLOUD_URL: 'skuSyncCloudUrl_v6',
  SYNC_TRIGGER: 'merchMaster_sync_trigger',
  CONFIG_TRIGGER: 'config_sync_trigger'
};
const LEGACY_ITEMMASTER_DB = Object.freeze({
  NAME: 'oneapp-itemmaster-isolated-v1',
  PRODUCTS_STORE: 'products',
  STATE_STORE: 'store',
  REVISION_KEY: 'itemMasterRevision_v1'
});
const ONEAPP_DEFAULT_CLOUD_SYNC_URL = 'https://script.google.com/macros/s/AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw/exec';
const normalizeOneAppCloudSyncUrl = (url = '') => {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return raw.replace(/\?action=[^&#]*/g, '').replace(/&action=[^&#]*/g, '').replace(/\?sheet=[^&#]*/g, '').replace(/&sheet=[^&#]*/g, '');
};
const getOneAppCloudSyncUrl = (fallback = '') => {
  try {
    const keys = [STORAGE_KEYS.CLOUD_URL, STORAGE_KEYS.LEGACY_CLOUD_URL, STORAGE_KEYS.OLD_CLOUD_URL];
    for (const key of keys) {
      const v = normalizeOneAppCloudSyncUrl(localStorage.getItem(key) || '');
      if (v) return v;
    }
    const fb = normalizeOneAppCloudSyncUrl(fallback || '');
    if (fb) return fb;
    return ONEAPP_DEFAULT_CLOUD_SYNC_URL;
  } catch (e) {
    return normalizeOneAppCloudSyncUrl(fallback || '') || ONEAPP_DEFAULT_CLOUD_SYNC_URL;
  }
};
const setOneAppCloudSyncUrl = (url = '') => {
  const safeUrl = normalizeOneAppCloudSyncUrl(url || ONEAPP_DEFAULT_CLOUD_SYNC_URL);
  if (!safeUrl) throw new Error('클라우드 URL이 비어 있습니다.');
  try {
    localStorage.setItem(STORAGE_KEYS.CLOUD_URL, safeUrl);
    localStorage.setItem(STORAGE_KEYS.LEGACY_CLOUD_URL, safeUrl);
    // 기존 NEXES/마스터 앱 호환키에도 같은 URL을 남긴다.
    localStorage.setItem(STORAGE_KEYS.OLD_CLOUD_URL, safeUrl);
    localStorage.setItem(STORAGE_KEYS.CONFIG_TRIGGER, Date.now().toString());
  } catch (e) {}
  return safeUrl;
};
const buildCloudUrl = (url = '', params = {}) => {
  const base = normalizeOneAppCloudSyncUrl(url || getOneAppCloudSyncUrl());
  const query = Object.entries(params).filter(([_, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  if (!query) return base;
  return base.includes('?') ? `${base}&${query}` : `${base}?${query}`;
};
window.ONEAPP_DEFAULT_CLOUD_SYNC_URL = window.ONEAPP_DEFAULT_CLOUD_SYNC_URL || ONEAPP_DEFAULT_CLOUD_SYNC_URL;
window.getOneAppCloudSyncUrl = window.getOneAppCloudSyncUrl || getOneAppCloudSyncUrl;
window.setOneAppCloudSyncUrl = window.setOneAppCloudSyncUrl || setOneAppCloudSyncUrl;
try {
  setOneAppCloudSyncUrl(getOneAppCloudSyncUrl());
} catch (e) {}
const NUMERIC_HEADERS = ["안전재고", "출고가", "입고가", "입고B", "도매A", "도매B", "상장가", "최종전송", "최종입고", "단가H", "단가I", "시중가", "행사가", "1종연산", "1당수량", "2종연산", "외주비", "노무비", "경비"];

// ==========================================
// 🛠 Utility Functions
// ==========================================
const initIDB = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('MerchOpsDB', 2);
  request.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('store')) db.createObjectStore('store');
    if (!db.objectStoreNames.contains(STORAGE_KEYS.MASTER_STORE)) db.createObjectStore(STORAGE_KEYS.MASTER_STORE, {
      keyPath: '코드'
    });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const setIDB = async (key, val) => {
  if ([STORAGE_KEYS.MASTER_DB, 'merchMaster_revision_v870'].includes(key)) {
    throw new Error(`${key}는 공통 원자 저장 경로만 사용할 수 있습니다.`);
  }
  const db = await initIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('store', 'readwrite');
    tx.objectStore('store').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};
const getIDB = async key => {
  const db = await initIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('store', 'readonly');
    const req = tx.objectStore('store').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(tx.error);
  });
};
const getAllMasterIDB = async () => {
  const db = await initIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORAGE_KEYS.MASTER_STORE, 'readonly');
    const req = tx.objectStore(STORAGE_KEYS.MASTER_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(tx.error);
  });
};
let masterPageRevision = undefined;
const normalizeMasterItem = (item = {}, fallbackCode = '') => {
  const code = safeStr(item['코드'] || item['품목코드'] || fallbackCode).trim();
  const themeValue = normalizePromotionThemeValue(item);
  const next = {
    ...item,
    코드: code,
    품목코드: safeStr(item['품목코드'] || code).trim(),
    행사테마: themeValue
  };
  [1, 2, 3, 4, 5].forEach(n => {
    next[`테마${n}`] = themeValue.split(',').includes(String(n)) ? '1' : '';
  });
  return next;
};
const masterArrayToMap = (items = []) => {
  const map = {};
  const entries = Array.isArray(items) ? items.map((item, idx) => [String(idx + 1), item, '']) : Object.entries(items || {}).map(([key, item], idx) => [String(idx + 1), item, key]);
  entries.forEach(([rowNumber, item, objectKey]) => {
    const normalized = normalizeMasterItem(item, objectKey);
    if (!normalized.코드) {
      throw new Error(`마스터 ${rowNumber}행에 코드가 없습니다.`);
    }
    if (map[normalized.코드]) {
      throw new Error(`마스터 중복 코드가 있습니다: ${normalized.코드}`);
    }
    map[normalized.코드] = normalized;
  });
  return map;
};
const saveMasterLocal = async (masterMap = {}) => {
  const safeMap = masterArrayToMap(masterMap);
  if (!window.ONEAPP?.STORAGE?.commitMasterStateOrThrow) {
    throw new Error('공통 마스터 저장 엔진을 불러오지 못했습니다.');
  }
  const result = await window.ONEAPP.STORAGE.commitMasterStateOrThrow(safeMap, {
    expectedRevision: masterPageRevision
  });
  masterPageRevision = result.revision;
  try {
    localStorage.setItem(STORAGE_KEYS.SYNC_TRIGGER, Date.now().toString());
  } catch (e) {}
  return safeMap;
};
const loadMasterLocal = async () => {
  const state = await window.ONEAPP.STORAGE.readMasterSnapshotState();
  masterPageRevision = state.revision;
  const items = state.items;
  if (items && items.length > 0) return masterArrayToMap(items);
  const legacy = await getIDB(STORAGE_KEYS.MASTER_DB).catch(() => null);
  if (legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0) {
    const safeMap = await saveMasterLocal(legacy);
    return safeMap;
  }
  return {};
};
const readLegacyItemMasterSnapshot = async () => {
  if (!window.indexedDB || typeof window.indexedDB.databases !== 'function') {
    return {
      status: 'unsupported',
      exists: false,
      masterMap: {},
      revision: null
    };
  }
  const databases = await window.indexedDB.databases();
  const exists = databases.some(entry => entry && entry.name === LEGACY_ITEMMASTER_DB.NAME);
  if (!exists) return {
    status: 'absent',
    exists: false,
    masterMap: {},
    revision: null
  };
  const db = await new Promise((resolve, reject) => {
    const request = window.indexedDB.open(LEGACY_ITEMMASTER_DB.NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('레거시 ItemMaster DB를 열지 못했습니다.'));
  });
  try {
    if (!db.objectStoreNames.contains(LEGACY_ITEMMASTER_DB.PRODUCTS_STORE)) {
      return {
        status: 'error',
        exists: true,
        masterMap: {},
        revision: null,
        error: '레거시 상품 Store를 찾지 못했습니다.'
      };
    }
    const storeNames = [LEGACY_ITEMMASTER_DB.PRODUCTS_STORE];
    if (db.objectStoreNames.contains(LEGACY_ITEMMASTER_DB.STATE_STORE)) storeNames.push(LEGACY_ITEMMASTER_DB.STATE_STORE);
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, 'readonly');
      const productsRequest = tx.objectStore(LEGACY_ITEMMASTER_DB.PRODUCTS_STORE).getAll();
      const revisionRequest = storeNames.includes(LEGACY_ITEMMASTER_DB.STATE_STORE) ? tx.objectStore(LEGACY_ITEMMASTER_DB.STATE_STORE).get(LEGACY_ITEMMASTER_DB.REVISION_KEY) : null;
      const snapshotRequest = storeNames.includes(LEGACY_ITEMMASTER_DB.STATE_STORE) ? tx.objectStore(LEGACY_ITEMMASTER_DB.STATE_STORE).get('itemMasterSnapshot_v1') : null;
      tx.oncomplete = () => resolve({
        items: productsRequest.result || [],
        revision: revisionRequest ? revisionRequest.result : null,
        snapshot: snapshotRequest ? snapshotRequest.result : null
      });
      tx.onerror = () => reject(tx.error || new Error('레거시 ItemMaster DB를 읽지 못했습니다.'));
      tx.onabort = () => reject(tx.error || new Error('레거시 ItemMaster DB 읽기가 중단되었습니다.'));
    });
    const rawItems = result.items.length > 0 ? result.items : Object.values(result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : {});
    const masterMap = masterArrayToMap(rawItems);
    return {
      status: Object.keys(masterMap).length > 0 ? 'ready' : 'empty',
      exists: true,
      masterMap,
      rawItems,
      revision: result.revision ?? null
    };
  } catch (error) {
    return {
      status: 'error',
      exists: true,
      masterMap: {},
      revision: null,
      error: error.message
    };
  } finally {
    db.close();
  }
};
const extractMasterFromCloudResult = (result = {}) => {
  if (!result) return {};
  if (result.status === 'success' && result.data) {
    if (result.data.master) return masterArrayToMap(result.data.master);
    if (Array.isArray(result.data)) return masterArrayToMap(result.data);
  }
  if (Array.isArray(result.data)) return masterArrayToMap(result.data);
  if (Array.isArray(result)) return masterArrayToMap(result);
  return {};
};
const readCloudFullPayload = async cloudUrl => {
  const targetUrl = setOneAppCloudSyncUrl(cloudUrl || getOneAppCloudSyncUrl());
  const res = await fetch(targetUrl, {
    method: 'GET'
  });
  if (!res.ok) throw new Error('MerchOps 클라우드 수신 실패');
  return await res.json();
};
const pullMerchOpsCloudMaster = async cloudUrl => {
  const targetUrl = setOneAppCloudSyncUrl(cloudUrl || getOneAppCloudSyncUrl());
  const candidates = [targetUrl, buildCloudUrl(targetUrl, {
    action: 'master_only'
  }), buildCloudUrl(targetUrl, {
    action: 'pull',
    sheet: '마스터'
  })];
  let lastError = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: 'GET'
      });
      if (!res.ok) throw new Error('Network Error');
      const result = await res.json();
      const masterMap = extractMasterFromCloudResult(result);
      if (Object.keys(masterMap).length > 0) {
        await saveMasterLocal(masterMap);
        return {
          masterMap,
          count: Object.keys(masterMap).length,
          result
        };
      }
      lastError = new Error('마스터 데이터 없음');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('MerchOps 클라우드 응답 형식 오류');
};
const safeJSONParseRaw = (raw, defaultVal) => {
  try {
    if (!raw || raw === 'undefined' || raw === 'null') return defaultVal;
    const parsed = JSON.parse(raw);
    return parsed === undefined || parsed === null ? defaultVal : parsed;
  } catch (e) {
    return defaultVal;
  }
};
const chunkUploadCloud = async ({
  url,
  action,
  data = [],
  chunkSize = 500,
  onProgress
}) => {
  const items = Array.isArray(data) ? data : Object.values(data || {});
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    if (typeof onProgress === 'function') onProgress({
      sent: Math.min(i + chunkSize, items.length),
      total: items.length
    });
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        action,
        data: chunk
      })
    });
    const json = await res.json();
    if (!json || json.status !== 'success') throw new Error(json?.message || `${action} 업로드 실패`);
  }
  return {
    total: items.length
  };
};
const pushMerchOpsCloudMaster = async (masterMap = {}, {
  cloudUrl,
  onProgress
} = {}) => {
  const targetUrl = setOneAppCloudSyncUrl(cloudUrl || getOneAppCloudSyncUrl());
  const safeMaster = await saveMasterLocal(masterMap);
  const previous = await readCloudFullPayload(targetUrl).catch(() => null);
  const previousData = previous && previous.data ? previous.data : {};
  const localHistory = safeJSONParseRaw(localStorage.getItem('merchHistory_v870'), []);
  const historyItems = Array.isArray(localHistory) && localHistory.length > 0 ? localHistory : Array.isArray(previousData.history) ? previousData.history : [];
  const previousConfig = previousData.appConfig || {};
  if (typeof onProgress === 'function') onProgress('서버 초기화 중...');
  const initRes = await fetch(targetUrl, {
    method: 'POST',
    body: JSON.stringify({
      action: 'initSync'
    })
  });
  const initJson = await initRes.json();
  if (!initJson || initJson.status !== 'success') throw new Error(initJson?.message || '초기화 실패');
  const masterItems = Object.values(safeMaster);
  await chunkUploadCloud({
    url: targetUrl,
    action: 'chunk_master',
    data: masterItems,
    onProgress: p => onProgress && onProgress(`마스터 업로드 중... (${p.sent} / ${p.total}건)`)
  });
  await chunkUploadCloud({
    url: targetUrl,
    action: 'chunk_history',
    data: historyItems,
    onProgress: p => onProgress && onProgress(`히스토리 유지 업로드 중... (${p.sent} / ${p.total}건)`)
  });
  if (typeof onProgress === 'function') onProgress('환경설정 보존 중...');
  const configPayload = {
    action: 'config',
    data: {
      dict: safeJSONParseRaw(localStorage.getItem('parserDict_v870'), previousData.dict || {}),
      rules: previousData.rules || [],
      appConfig: {
        ...previousConfig,
        cloudUrl: targetUrl
      }
    }
  };
  const configRes = await fetch(targetUrl, {
    method: 'POST',
    body: JSON.stringify(configPayload)
  });
  const configJson = await configRes.json();
  if (!configJson || configJson.status !== 'success') throw new Error(configJson?.message || '설정 업로드 실패');
  try {
    localStorage.setItem(STORAGE_KEYS.SYNC_TRIGGER, Date.now().toString());
  } catch (e) {}
  return {
    count: masterItems.length,
    historyCount: historyItems.length
  };
};

// 💡 하얀 화면(크래시) 방지용 강제 문자열 변환 유틸리티
const safeStr = (val, def = '') => val !== undefined && val !== null && val !== '' ? String(val) : def;
const PROMOTION_THEMES = [{
  code: '1',
  label: '오늘의행사',
  type: '탭'
}, {
  code: '2',
  label: '매장행사',
  type: '탭'
}, {
  code: '3',
  label: '특가상품',
  type: '탭'
}, {
  code: '4',
  label: '실사진',
  type: '뱃지'
}, {
  code: '5',
  label: '행사',
  type: '뱃지'
}];
const normalizePromotionThemeValue = (item = {}) => {
  const out = [];
  const push = v => {
    const s = String(v ?? '').trim();
    if (!s) return;
    s.split(/[,/|\s]+/).forEach(part => {
      const n = String(part || '').replace(/[^1-5]/g, '');
      if (n && /^[1-5]$/.test(n) && !out.includes(n)) out.push(n);
    });
  };
  push(item['행사테마']);
  push(item['테마']);
  push(item['promoTheme']);
  push(item['_theme']);
  [1, 2, 3, 4, 5].forEach(n => {
    const raw = item[`테마${n}`];
    const s = String(raw ?? '').trim();
    if (s && s !== '0' && s !== 'false' && s !== 'FALSE' && !out.includes(String(n))) out.push(String(n));
  });
  return out.sort((a, b) => Number(a) - Number(b)).join(',');
};
const parseMasterAddUpdateWorkbook = arrayBuffer => {
  const api = window.ONEAPP_MASTER_ADD_UPDATE;
  if (!api || typeof api.parseWorkbook !== 'function') {
    throw new Error('Master 추가·갱신 Excel 분석 모듈을 불러오지 못했습니다.');
  }
  return api.parseWorkbook(arrayBuffer, window.XLSX);
};
const buildInitialMasterImport = (parsed = {}, fileName = '') => {
  const api = window.ONEAPP_MASTER_ADD_UPDATE;
  if (!api) throw new Error('Master Excel 검증 모듈을 불러오지 못했습니다.');
  const headers = Array.isArray(parsed.headers) ? parsed.headers : [];
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const masterMap = {};
  const errors = [];
  rows.forEach((row, index) => {
    const item = {};
    headers.forEach(header => {
      item[header] = row[header];
    });
    const code = api.getRowCode(row);
    if (!code) {
      errors.push(`Excel ${row.__rowNumber || index + 2}행: 상품코드 없음`);
      return;
    }
    item.코드 = code;
    item.품목코드 = safeStr(item.품목코드 || code).trim();
    const normalized = normalizeMasterItem(item, code);
    const missing = api.REQUIRED_NEW_FIELDS.filter(field => !safeStr(normalized[field]).trim());
    if (missing.length > 0) {
      errors.push(`Excel ${row.__rowNumber || index + 2}행 ${code}: ${missing.join(', ')} 누락`);
      return;
    }
    if (masterMap[normalized.코드]) {
      errors.push(`Excel ${row.__rowNumber || index + 2}행: 중복 상품코드 ${normalized.코드}`);
      return;
    }
    masterMap[normalized.코드] = normalized;
  });
  if (errors.length > 0) {
    const preview = errors.slice(0, 10).join('\n');
    const suffix = errors.length > 10 ? `\n외 ${errors.length - 10}건` : '';
    throw new Error(`최초 등록 검증 실패 (${errors.length}건)\n${preview}${suffix}`);
  }
  if (Object.keys(masterMap).length === 0) throw new Error('최초 등록할 상품이 없습니다.');
  return {
    fileName,
    masterMap,
    count: Object.keys(masterMap).length,
    baseRevision: masterPageRevision
  };
};

// ==========================================
// 🧩 [아이콘 시스템] SafeIcon
// ==========================================
const SafeIcon = React.memo(function SafeIconComponent({
  name,
  size = 18,
  className = ""
}) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    const renderIcon = () => {
      if (window.lucide && window.lucide.icons) {
        const kebabName = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
        const possibleNames = [kebabName, name, name === 'cloud-download' ? 'download-cloud' : name, name === 'cloud-upload' ? 'upload-cloud' : name, name === 'bar-chart-3' ? 'bar-chart' : name];
        for (const pName of possibleNames) {
          if (window.lucide.icons[pName]) {
            setSvg(window.lucide.icons[pName].toSvg({
              width: size,
              height: size,
              class: className,
              'stroke-width': 2.5
            }));
            return;
          }
        }
      }
    };
    renderIcon();
  }, [name, size, className]);
  if (!svg) {
    const faMap = {
      'cloud-download': 'fa-cloud-download-alt',
      'cloud-upload': 'fa-cloud-upload-alt',
      'settings': 'fa-cogs',
      'layout-dashboard': 'fa-th-large',
      'package-search': 'fa-box-open',
      'file-spreadsheet': 'fa-table',
      'zap': 'fa-bolt',
      'truck': 'fa-truck',
      'boxes': 'fa-boxes',
      'bar-chart-3': 'fa-chart-bar',
      'check-circle-2': 'fa-check-circle',
      'x': 'fa-times',
      'database': 'fa-database',
      'upload': 'fa-upload',
      'pie-chart': 'fa-chart-pie',
      'shopping-cart': 'fa-shopping-cart',
      'users': 'fa-users',
      'megaphone': 'fa-bullhorn',
      'book-open': 'fa-address-book',
      'shopping-bag': 'fa-shopping-bag',
      'credit-card': 'fa-credit-card',
      'line-chart': 'fa-chart-line',
      'printer': 'fa-print',
      'search': 'fa-search',
      'plus': 'fa-plus',
      'trash-alt': 'fa-trash-alt',
      'edit': 'fa-edit',
      'save': 'fa-save',
      'file-excel': 'fa-file-excel',
      'link': 'fa-link',
      'ban': 'fa-ban',
      'layer-group': 'fa-layer-group',
      'desktop': 'fa-desktop',
      'sign-in-alt': 'fa-sign-in-alt',
      'calculator': 'fa-calculator',
      'tags': 'fa-tags',
      'broom': 'fa-broom',
      'info-circle': 'fa-info-circle',
      'lock': 'fa-lock',
      'key': 'fa-key',
      'folder-open': 'fa-folder-open',
      'file-invoice': 'fa-file-invoice',
      'history': 'fa-history',
      'redo-alt': 'fa-redo-alt'
    };
    const faName = faMap[name] || `fa-${name}`;
    return /*#__PURE__*/React.createElement("i", {
      className: `fas ${faName} ${className}`,
      style: {
        fontSize: size
      }
    });
  }
  return /*#__PURE__*/React.createElement("span", {
    className: "inline-flex shrink-0 items-center justify-center",
    dangerouslySetInnerHTML: {
      __html: svg
    }
  });
});

// ==========================================
// Master 앱 작업헤더: 앱 이동은 NEXUS 공통헤더가 전담한다.
// ==========================================
const AppHeader = ({
  itemCount,
  isProcessing,
  processMsg,
  onOpenSettings
}) => /*#__PURE__*/React.createElement("div", {
  className: "nexus-app-header shrink-0 z-40 w-full bg-white border-b border-slate-200 shadow-sm",
  "data-nexus-app-header": "master-lookup"
}, /*#__PURE__*/React.createElement("header", {
  className: "min-h-[56px] w-full px-3 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2"
}, /*#__PURE__*/React.createElement("div", {
  className: "min-w-0 flex items-center gap-3",
  "data-nexus-app-identity": true
}, /*#__PURE__*/React.createElement("span", {
  className: "w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100",
  "aria-hidden": "true"
}, /*#__PURE__*/React.createElement(SafeIcon, {
  name: "database",
  size: 17
})), /*#__PURE__*/React.createElement("div", {
  className: "min-w-0"
}, /*#__PURE__*/React.createElement("div", {
  className: "flex items-center gap-2"
}, /*#__PURE__*/React.createElement("h1", {
  className: "text-[15px] font-black text-slate-800 whitespace-nowrap",
  "data-nexus-app-title": true
}, "\uC0C1\uD488\uAD00\uB9AC"), /*#__PURE__*/React.createElement("span", {
  className: "h-7 px-3 rounded-md bg-slate-100 text-slate-700 text-[11px] font-bold hidden sm:flex items-center",
  "aria-current": "page"
}, "\uC870\uD68C")), /*#__PURE__*/React.createElement("p", {
  className: "hidden sm:block text-[10px] text-slate-500 mt-0.5 truncate"
}, "\uC0C1\uD488 \uC870\uD68C\xB7\uAD00\uB9AC\uC790 \uAC80\uD1A0"))), /*#__PURE__*/React.createElement("div", {
  className: "flex items-center gap-2"
}, /*#__PURE__*/React.createElement("div", {
  className: "h-9 px-3 rounded-lg bg-slate-50 border border-slate-200 flex items-center gap-2",
  title: isProcessing ? processMsg : '상품관리 준비'
}, isProcessing ? /*#__PURE__*/React.createElement("i", {
  className: "fas fa-circle-notch fa-spin text-amber-500 text-[11px]"
}) : /*#__PURE__*/React.createElement("span", {
  className: "inline-flex rounded-full h-2 w-2 bg-emerald-500"
}), /*#__PURE__*/React.createElement("span", {
  className: "text-[11px] font-mono font-bold text-slate-600"
}, itemCount.toLocaleString(), "\uAC74")), /*#__PURE__*/React.createElement("button", {
  type: "button",
  onClick: onOpenSettings,
  className: "w-9 h-9 rounded-lg bg-white hover:bg-slate-50 flex items-center justify-center border border-slate-300 text-slate-600",
  title: "\uD658\uACBD\uC124\uC815 \uC5F4\uAE30",
  "aria-label": "\uD658\uACBD\uC124\uC815 \uC5F4\uAE30"
}, /*#__PURE__*/React.createElement(SafeIcon, {
  name: "settings",
  size: 16
})))));
const IframeSettingsModal = ({
  isOpen,
  onClose
}) => {
  if (!isOpen) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[500] flex bg-slate-900/60 backdrop-blur-sm fade-in"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-[1400px] h-full bg-white shadow-[-10px_0_40px_rgba(0,0,0,0.3)] flex flex-col slide-in-right border-l border-slate-300 relative overflow-hidden ml-auto"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-[#0f172a] px-6 py-4 flex justify-between items-center text-white shrink-0 border-b border-slate-700 shadow-md relative z-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-3"
  }, /*#__PURE__*/React.createElement(SafeIcon, {
    name: "settings",
    size: 20,
    className: "text-indigo-400"
  }), /*#__PURE__*/React.createElement("h2", {
    className: "font-black text-[17px] tracking-wide"
  }, "\uD1B5\uD569 \uD658\uACBD\uC124\uC815 \uC13C\uD130"), /*#__PURE__*/React.createElement("span", {
    className: "bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded text-[10px] font-bold border border-indigo-500/30 ml-2"
  }, "Wide Overlay")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-4"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[12px] text-slate-400 font-medium hidden md:inline-block"
  }, "\uC124\uC815\uC744 \uBCC0\uACBD\uD558\uACE0 \uCC3D\uC744 \uB2EB\uC73C\uBA74 \uC791\uC5C5 \uD654\uBA74\uC5D0 \uC989\uC2DC \uBC18\uC601\uB429\uB2C8\uB2E4."), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    className: "text-slate-300 hover:text-white transition-colors bg-slate-800 hover:bg-rose-500 w-8 h-8 rounded-lg flex items-center justify-center shadow-sm border border-slate-700 hover:border-rose-400"
  }, /*#__PURE__*/React.createElement(SafeIcon, {
    name: "x",
    size: 18
  })))), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 w-full bg-slate-100 relative"
  }, /*#__PURE__*/React.createElement("div", {
    className: "absolute inset-0 flex items-center justify-center pointer-events-none"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-slate-300 flex flex-col items-center"
  }, /*#__PURE__*/React.createElement("i", {
    className: "fas fa-circle-notch fa-spin text-3xl mb-3"
  }), /*#__PURE__*/React.createElement("span", {
    className: "font-bold text-sm"
  }, "\uC124\uC815 \uBAA8\uB4C8\uC744 \uBD88\uB7EC\uC624\uB294 \uC911\uC785\uB2C8\uB2E4..."))), /*#__PURE__*/React.createElement("iframe", {
    src: "settings.html?mode=iframe&returnApp=master-lookup",
    className: "absolute inset-0 w-full h-full border-0 bg-white relative z-10",
    title: "Settings Center"
  }))));
};

// ==========================================
// 🧩 Read-Only 설정 훅
// ==========================================
const useMerchConfig = () => {
  const loadConfig = () => {
    const cloudUrl = getOneAppCloudSyncUrl();
    let visibleMasterColsRaw = localStorage.getItem('merchVisMaster_v870');
    let visibleMasterCols = {
      estimate: ['카탈로그', '견적서', '입고가', '출고가', '입고B', '도매A']
    };
    try {
      if (visibleMasterColsRaw) {
        const parsed = JSON.parse(visibleMasterColsRaw);
        if (parsed && parsed.estimate) visibleMasterCols = parsed;
      }
    } catch (e) {
      console.warn("Config Load Fail", e);
    }
    return {
      cloudUrl,
      visibleMasterCols
    };
  };
  const [config, setConfig] = useState(loadConfig());
  useEffect(() => {
    const handleStorageChange = () => setConfig(loadConfig());
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);
  return config;
};
const InitialImportConfirmModal = ({
  draft,
  onSave,
  onCancel,
  isSaving
}) => {
  if (!draft) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[130] bg-slate-950/60 flex items-center justify-center p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "px-6 py-5 bg-indigo-50 border-b border-indigo-200"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-lg font-black text-indigo-900"
  }, "\uC0C1\uD488\uAD00\uB9AC \uCD5C\uCD08 Excel \uB4F1\uB85D"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-indigo-700 mt-1"
  }, "\uACF5\uC2DD \uC0C1\uD488 DB\uAC00 0\uAC74\uC77C \uB54C\uB9CC \uC2E4\uD589\uB418\uBA70 revision\uACFC \uACF5\uC2DD history\uB97C \uD568\uAED8 \uAE30\uB85D\uD569\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("div", {
    className: "p-6 space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rounded-xl bg-slate-50 border border-slate-200 p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-bold text-slate-500"
  }, "\uD30C\uC77C"), /*#__PURE__*/React.createElement("div", {
    className: "mt-1 text-sm font-bold text-slate-800 break-all"
  }, draft.fileName)), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 gap-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rounded-xl bg-slate-50 border border-slate-200 p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-bold text-slate-500"
  }, "\uAC80\uC99D \uC644\uB8CC \uC0C1\uD488"), /*#__PURE__*/React.createElement("div", {
    className: "mt-1 text-2xl font-black text-indigo-700"
  }, draft.count.toLocaleString(), "\uAC74")), /*#__PURE__*/React.createElement("div", {
    className: "rounded-xl bg-slate-50 border border-slate-200 p-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-bold text-slate-500"
  }, "\uC800\uC7A5 \uAE30\uC900 Revision"), /*#__PURE__*/React.createElement("div", {
    className: "mt-1 text-sm font-black text-slate-800 break-all"
  }, safeStr(draft.baseRevision, '초기 상태')))), /*#__PURE__*/React.createElement("p", {
    className: "text-xs leading-5 text-slate-600"
  }, "\uC0C1\uD488\uCF54\uB4DC \uC911\uBCF5\uACFC \uD488\uBAA9\uBA85\xB7\uADDC\uACA9\xB7\uB2E8\uC704 \uB204\uB77D \uAC80\uC0AC\uB97C \uD1B5\uACFC\uD588\uC2B5\uB2C8\uB2E4. \uC800\uC7A5 \uC9C1\uC804 DB\uAC00 \uC5EC\uC804\uD788 \uBE44\uC5B4 \uC788\uACE0 revision\uC774 \uAC19\uC740\uC9C0 \uB2E4\uC2DC \uD655\uC778\uD569\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("div", {
    className: "px-6 pb-6 flex justify-end gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    disabled: isSaving,
    className: "px-4 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs font-bold disabled:opacity-50"
  }, "\uCDE8\uC18C"), /*#__PURE__*/React.createElement("button", {
    onClick: onSave,
    disabled: isSaving,
    className: "px-5 py-2 rounded-lg bg-indigo-600 text-white text-xs font-black disabled:bg-slate-400"
  }, isSaving ? '저장 중...' : `${draft.count.toLocaleString()}건 최초 저장`))));
};
const PRODUCT_FORM_FIELDS = [{
  key: '코드',
  label: '상품코드',
  required: true
}, {
  key: '품목명',
  label: '품목명',
  required: true
}, {
  key: '규격',
  label: '규격',
  required: true
}, {
  key: '단위',
  label: '단위',
  required: true
}, {
  key: '1코드',
  label: '대분류 코드'
}, {
  key: '1그룹명',
  label: '대분류명'
}, {
  key: '2코드',
  label: '중분류 코드'
}, {
  key: '2그룹명',
  label: '중분류명'
}, {
  key: '3코드',
  label: '소분류 코드'
}, {
  key: '3그룹명',
  label: '소분류명'
}, {
  key: '오더즈',
  label: '오더즈분류3'
}, {
  key: '구매처',
  label: '구매처'
}, {
  key: '브랜드',
  label: '브랜드'
}, {
  key: '상품설명',
  label: '상품설명'
}, {
  key: '검색명',
  label: '검색명'
}, {
  key: '구분',
  label: '구분'
}, {
  key: '입고가',
  label: '입고가',
  type: 'number'
}, {
  key: '출고가',
  label: '출고가',
  type: 'number'
}, {
  key: '도매A',
  label: '도매A',
  type: 'number'
}, {
  key: '최종입고',
  label: '최종입고',
  type: 'number'
}, {
  key: '행사가',
  label: '행사가',
  type: 'number'
}, {
  key: '준비기간',
  label: '준비기간'
}, {
  key: '주문마감시간',
  label: '주문마감시간'
}, {
  key: '외주비단가',
  label: '외주비단가',
  type: 'number'
}, {
  key: '표준노무시간',
  label: '표준노무시간',
  type: 'number'
}, {
  key: '경비가중치',
  label: '경비가중치',
  type: 'number'
}, {
  key: '1종',
  label: '1종 관련 정보'
}, {
  key: '2종',
  label: '2종 관련 정보'
}, {
  key: '비과세',
  label: '비과세'
}];
const DETAIL_PRODUCT_FIELDS = [{
  category: '품목정보',
  key: '바코드',
  label: '바코드'
}, {
  category: '품목정보',
  key: '원산지',
  label: '원산지'
}, {
  category: '수량',
  key: '최소주문수량',
  label: '최소주문수량',
  type: 'number'
}, {
  category: '수량',
  key: '최대주문수량',
  label: '최대주문수량',
  type: 'number'
}, {
  category: '단가',
  key: '입고B',
  label: '입고B',
  type: 'number'
}, {
  category: '단가',
  key: '도매B',
  label: '도매B',
  type: 'number'
}, {
  category: '원가',
  key: '표준원가',
  label: '표준원가',
  type: 'number'
}, {
  category: '부가정보',
  key: '보관방법',
  label: '보관방법'
}, {
  category: '관리대상',
  key: '관리대상',
  label: '관리대상'
}, {
  category: '관리대상',
  key: '사용여부',
  label: '사용여부'
}];
const PRODUCT_EDITOR_FIELD_LAYOUT_KEY = 'oneapp.master.product-editor-field-layout.v1';
const isDerivedGroupCodeField = (field, productCode) => {
  const requiredLength = {
    '1코드': 2,
    '2코드': 4,
    '3코드': 6
  }[field];
  const code = safeStr(productCode).trim();
  return Boolean(requiredLength && /^\d+$/.test(code) && code.length >= requiredLength);
};
const defaultProductEditorFieldKeys = () => PRODUCT_FORM_FIELDS.map(field => field.key);
const loadProductEditorFieldKeys = () => {
  const defaults = defaultProductEditorFieldKeys();
  try {
    const saved = JSON.parse(localStorage.getItem(PRODUCT_EDITOR_FIELD_LAYOUT_KEY) || '[]');
    if (!Array.isArray(saved)) return defaults;
    const unique = saved.map(safeStr).filter((key, index, rows) => key && rows.indexOf(key) === index);
    return [...unique, ...defaults.filter(key => !unique.includes(key))];
  } catch {
    return defaults;
  }
};
const ProductEditorModal = ({
  item,
  masterProducts,
  onCancel,
  onSave,
  isSaving
}) => {
  const [form, setForm] = useState({});
  const [errorMessage, setErrorMessage] = useState('');
  const [fieldKeys, setFieldKeys] = useState(defaultProductEditorFieldKeys);
  const [detailSelection, setDetailSelection] = useState('');
  const isOpen = item !== null;
  const isEditing = Boolean(item && safeStr(item.코드 || item.품목코드).trim());
  useEffect(() => {
    if (!isOpen) return;
    const source = item ? {
      ...item,
      코드: safeStr(item.코드 || item.품목코드)
    } : {};
    setForm(isEditing ? source : window.ONEAPP_MASTER_ADD_UPDATE.deriveProductCategoryFields(source, masterProducts));
    setFieldKeys(loadProductEditorFieldKeys());
    setDetailSelection('');
    setErrorMessage('');
  }, [item, isOpen]);
  if (!isOpen) return null;
  const moveField = (key, direction) => {
    setFieldKeys(current => {
      const index = current.indexOf(key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = current.slice();
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const handleSubmit = async () => {
    try {
      const normalized = window.ONEAPP_MASTER_ADD_UPDATE.validateSingleProductInput(form);
      PRODUCT_FORM_FIELDS.concat(DETAIL_PRODUCT_FIELDS).filter(field => field.type === 'number').forEach(({
        key: field
      }) => {
        if (safeStr(normalized[field]).trim() !== '') normalized[field] = Number(normalized[field]);
      });
      await onSave(normalized, {
        isEditing
      });
      try {
        localStorage.setItem(PRODUCT_EDITOR_FIELD_LAYOUT_KEY, JSON.stringify(fieldKeys));
      } catch {}
    } catch (error) {
      setErrorMessage(error.message);
    }
  };
  const visibleFields = fieldKeys.map(key => PRODUCT_FORM_FIELDS.find(field => field.key === key) || DETAIL_PRODUCT_FIELDS.find(field => field.key === key) || {
    key,
    label: key
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[135] bg-slate-950/60 flex items-center justify-center p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-3xl max-h-[92vh] bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "px-6 py-5 bg-slate-900 text-white"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-lg font-black"
  }, isEditing ? '상품 수정' : '상품 단건 등록'), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-slate-300 mt-1"
  }, "\uACF5\uC2DD master\xB7revision\xB7history \uACC4\uC57D\uC73C\uB85C \uC800\uC7A5\uB429\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("div", {
    className: "p-6 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-4"
  }, visibleFields.map((field, index) => /*#__PURE__*/React.createElement("div", {
    key: field.key,
    className: "relative"
  }, /*#__PURE__*/React.createElement("label", {
    className: "block"
  }, /*#__PURE__*/React.createElement("span", {
    className: "min-h-6 flex items-center pr-24 text-[11px] font-bold text-slate-600"
  }, field.label, field.required ? ' *' : ''), /*#__PURE__*/React.createElement("input", {
    "aria-label": field.label,
    type: field.type || 'text',
    value: form[field.key] ?? '',
    disabled: isEditing && field.key === '코드' || !isEditing && isDerivedGroupCodeField(field.key, form.코드 || form.품목코드),
    onChange: event => setForm(current => {
      const next = field.key === '코드' ? {
        ...current,
        코드: event.target.value,
        품목코드: event.target.value
      } : {
        ...current,
        [field.key]: event.target.value
      };
      return !isEditing && field.key === '코드' ? window.ONEAPP_MASTER_ADD_UPDATE.deriveProductCategoryFields(next, masterProducts) : next;
    }),
    className: "mt-1 w-full h-10 px-3 rounded-lg border border-slate-300 text-sm outline-none focus:border-indigo-500 disabled:bg-slate-100 disabled:text-slate-500"
  })), /*#__PURE__*/React.createElement("span", {
    className: "absolute top-0 right-0 flex items-center gap-1"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => moveField(field.key, -1),
    disabled: index === 0,
    className: "w-6 h-6 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 disabled:opacity-30",
    "aria-label": `${field.label} 앞으로 이동`
  }, "\u2191"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => moveField(field.key, 1),
    disabled: index === visibleFields.length - 1,
    className: "w-6 h-6 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 disabled:opacity-30",
    "aria-label": `${field.label} 뒤로 이동`
  }, "\u2193"), !PRODUCT_FORM_FIELDS.some(baseField => baseField.key === field.key) && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setFieldKeys(current => current.filter(key => key !== field.key)),
    className: "w-6 h-6 rounded border border-rose-200 bg-white text-rose-600 hover:bg-rose-50",
    "aria-label": `${field.label} 기본항목에서 제외`
  }, "\xD7")))), /*#__PURE__*/React.createElement("div", {
    className: "md:col-span-2 border-t border-slate-200 pt-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col sm:flex-row sm:items-center gap-2"
  }, /*#__PURE__*/React.createElement("select", {
    value: detailSelection,
    onChange: event => setDetailSelection(event.target.value),
    className: "h-10 flex-1 px-3 rounded-lg border border-slate-300 text-sm bg-white"
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "\uC0C1\uC138\uD56D\uBAA9 \uC120\uD0DD"), DETAIL_PRODUCT_FIELDS.filter(field => !fieldKeys.includes(field.key)).map(field => /*#__PURE__*/React.createElement("option", {
    key: field.key,
    value: field.key
  }, field.category, " \xB7 ", field.label)), Object.keys(form).filter(key => !PRODUCT_FORM_FIELDS.some(field => field.key === key) && !DETAIL_PRODUCT_FIELDS.some(field => field.key === key) && !fieldKeys.includes(key)).map(key => /*#__PURE__*/React.createElement("option", {
    key: key,
    value: key
  }, "\uB4F1\uB85D\uB418\uC9C0 \uC54A\uC740 \uD56D\uBAA9 \xB7 ", key))), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      if (detailSelection) setFieldKeys(current => [...current, detailSelection]);
      setDetailSelection('');
    },
    disabled: !detailSelection,
    className: "h-10 px-4 rounded-lg border border-indigo-300 text-indigo-700 text-xs font-black disabled:opacity-40"
  }, "+ \uAE30\uBCF8\uD56D\uBAA9 \uCD94\uAC00")), /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-slate-500 mt-2"
  }, "\uCD94\uAC00\uD55C \uD56D\uBAA9\uACFC \uD45C\uC2DC \uC21C\uC11C\uB294 \uC0C1\uD488 \uC800\uC7A5 \uD6C4 \uB2E4\uC74C \uC218\uC815\uCC3D\uC5D0\uB3C4 \uC720\uC9C0\uB429\uB2C8\uB2E4. \uD654\uBA74\uC5D0\uC11C \uC81C\uC678\uD55C \uAE30\uC874 \uD544\uB4DC\uAC12\uC740 \uC0AD\uC81C\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."))), errorMessage && /*#__PURE__*/React.createElement("div", {
    className: "mx-6 mb-4 px-4 py-3 rounded-lg bg-rose-50 border border-rose-200 text-xs font-bold text-rose-700"
  }, errorMessage), /*#__PURE__*/React.createElement("div", {
    className: "px-6 pb-6 flex justify-end gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    disabled: isSaving,
    className: "px-4 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs font-bold disabled:opacity-50"
  }, "\uCDE8\uC18C"), /*#__PURE__*/React.createElement("button", {
    onClick: handleSubmit,
    disabled: isSaving,
    className: "px-5 py-2 rounded-lg bg-indigo-600 text-white text-xs font-black disabled:bg-slate-400"
  }, isSaving ? '저장 중...' : isEditing ? '수정 저장' : '상품 등록'))));
};
const requestTypeLabel = entry => entry?.request?.operation === 'CREATE' ? '신규 상품 등록 요청' : '상품정보 수정 요청';
const requestSourceLabel = entry => [entry?.request?.source?.appId, entry?.request?.source?.workflow].filter(Boolean).join(' · ') || '알 수 없는 업무';
const requestProposedItem = (entry, masterProducts = {}) => {
  const request = entry?.request || {};
  if (entry?.review?.applyTarget?.targetProduct) {
    const prepared = {
      ...entry.review.applyTarget.targetProduct
    };
    return request.operation === 'CREATE' ? window.ONEAPP_MASTER_ADD_UPDATE.deriveProductCategoryFields(prepared, masterProducts) : prepared;
  }
  const base = request.operation === 'CREATE' ? {} : masterProducts[request.entityId] || {};
  const item = {
    ...base,
    코드: safeStr(base.코드 || request.entityId),
    품목코드: safeStr(base.품목코드 || request.entityId)
  };
  (request.changes || []).forEach(change => {
    item[change.field] = change.proposedValue;
  });
  return request.operation === 'CREATE' ? window.ONEAPP_MASTER_ADD_UPDATE.deriveProductCategoryFields(item, masterProducts) : item;
};
const ProductRequestReviewModal = ({
  entry,
  masterProducts,
  onClose,
  onApply,
  onLink,
  onReject,
  isProcessing
}) => {
  const proposed = useMemo(() => requestProposedItem(entry, masterProducts), [entry, masterProducts]);
  const [form, setForm] = useState(proposed);
  const [linkCode, setLinkCode] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setForm(proposed);
    setLinkCode('');
    setReason('');
  }, [proposed]);
  const similarProducts = useMemo(() => {
    const target = safeStr(proposed.품목명).toLowerCase().replace(/\s+/g, '');
    if (!target) return [];
    return Object.values(masterProducts || {}).filter(item => {
      const name = safeStr(item.품목명).toLowerCase().replace(/\s+/g, '');
      return name && (name.includes(target) || target.includes(name));
    }).slice(0, 5);
  }, [proposed, masterProducts]);
  if (!entry) return null;
  const request = entry.request || {};
  const original = request.source?.original || request.changes?.map(change => ({
    field: change.field,
    value: change.beforeValue
  })) || {};
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-x-0 bottom-0 z-[145] bg-slate-950/65 flex items-center justify-center p-3 sm:p-5",
    style: {
      top: 'var(--nexus-ui-header-height, 64px)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-6xl max-h-full bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "px-5 sm:px-6 py-4 bg-slate-900 text-white flex items-start justify-between gap-4"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "text-lg font-black"
  }, requestTypeLabel(entry)), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-slate-300 mt-1"
  }, requestSourceLabel(entry), " \xB7 ", request.actor?.actorName || '요청자 미확인', " \xB7 ", new Date(request.requestedAt || entry.receivedAt).toLocaleString('ko-KR'))), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onClose,
    disabled: isProcessing,
    className: "w-9 h-9 rounded-lg border border-slate-600 text-slate-200"
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 overflow-y-auto p-5 sm:p-6 grid grid-cols-1 lg:grid-cols-2 gap-5"
  }, /*#__PURE__*/React.createElement("section", {
    className: "space-y-3"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-800"
  }, "\uC791\uC5C5\uC790 \uC6D0\uBCF8 \xB7 \uC77D\uAE30 \uC804\uC6A9"), /*#__PURE__*/React.createElement("pre", {
    className: "min-h-32 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-slate-200 bg-slate-50 p-4 text-[11px] text-slate-700"
  }, JSON.stringify(original, null, 2)), /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-800"
  }, "\uB3D9\uC77C\xB7\uC720\uC0AC \uC0C1\uD488 \uD6C4\uBCF4"), /*#__PURE__*/React.createElement("div", {
    className: "rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden"
  }, similarProducts.length ? similarProducts.map(item => {
    const code = safeStr(item.코드 || item.품목코드);
    return /*#__PURE__*/React.createElement("button", {
      type: "button",
      key: code,
      onClick: () => setLinkCode(code),
      className: `w-full p-3 text-left text-xs hover:bg-indigo-50 ${linkCode === code ? 'bg-indigo-50 text-indigo-800' : ''}`
    }, /*#__PURE__*/React.createElement("strong", null, safeStr(item.품목명, '-')), " \xB7 ", safeStr(item.규격, '-'), " \xB7 ", code);
  }) : /*#__PURE__*/React.createElement("div", {
    className: "p-4 text-xs text-slate-500"
  }, "\uB3D9\uC77C\xB7\uC720\uC0AC \uC0C1\uD488 \uD6C4\uBCF4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("input", {
    value: linkCode,
    onChange: event => setLinkCode(event.target.value),
    placeholder: "\uC5F0\uACB0\uD560 \uAE30\uC874 \uC0C1\uD488\uCF54\uB4DC",
    className: "w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
  })), /*#__PURE__*/React.createElement("section", null, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-800 mb-3"
  }, "\uACF5\uC2DD \uC0C1\uD488 \uBC18\uC601 \uC608\uC815\uAC12"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 gap-3"
  }, PRODUCT_FORM_FIELDS.map(field => /*#__PURE__*/React.createElement("label", {
    key: field.key,
    className: "block"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold text-slate-600"
  }, field.label, field.required ? ' *' : ''), /*#__PURE__*/React.createElement("input", {
    type: field.type || 'text',
    value: form[field.key] ?? '',
    disabled: request.operation !== 'CREATE' && field.key === '코드' || request.operation === 'CREATE' && isDerivedGroupCodeField(field.key, form.코드 || form.품목코드),
    onChange: event => setForm(current => {
      const next = field.key === '코드' ? {
        ...current,
        코드: event.target.value,
        품목코드: event.target.value
      } : {
        ...current,
        [field.key]: event.target.value
      };
      return request.operation === 'CREATE' && field.key === '코드' ? window.ONEAPP_MASTER_ADD_UPDATE.deriveProductCategoryFields(next, masterProducts) : next;
    }),
    className: "mt-1 w-full h-9 px-3 rounded-lg border border-slate-300 text-xs disabled:bg-slate-100"
  })))))), /*#__PURE__*/React.createElement("div", {
    className: "px-5 sm:px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-col lg:flex-row gap-2 lg:items-center"
  }, /*#__PURE__*/React.createElement("input", {
    value: reason,
    onChange: event => setReason(event.target.value),
    placeholder: "\uBC18\uB824 \uC0AC\uC720 \uB610\uB294 \uCC98\uB9AC \uBA54\uBAA8",
    className: "h-10 flex-1 px-3 rounded-lg border border-slate-300 text-xs"
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => onReject(reason),
    disabled: isProcessing || !reason.trim(),
    className: "h-10 px-4 rounded-lg border border-rose-300 text-rose-700 text-xs font-black disabled:opacity-40"
  }, "\uBC18\uB824"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => onLink(linkCode, reason),
    disabled: isProcessing || !linkCode.trim(),
    className: "h-10 px-4 rounded-lg border border-indigo-300 text-indigo-700 text-xs font-black disabled:opacity-40"
  }, "\uAE30\uC874 \uC0C1\uD488 \uC5F0\uACB0"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => onApply(form, reason),
    disabled: isProcessing,
    className: "h-10 px-5 rounded-lg bg-indigo-600 text-white text-xs font-black disabled:bg-slate-400"
  }, request.operation === 'CREATE' ? '확인 및 등록' : '확인 및 반영'))));
};
const formatReviewValue = (value, present = true) => {
  if (!present) return '(업로드 컬럼 없음)';
  if (value === '') return '(공란)';
  if (value === 0) return '0 (숫자)';
  if (value === undefined) return '(없음)';
  if (value === null) return '(null)';
  return safeStr(value);
};
const MasterAddUpdateConfirmModal = ({
  analysis,
  onReview,
  onCancel,
  onDiscard
}) => {
  if (!analysis) return null;
  const summary = analysis.summary;
  const rows = [['신규 상품', summary.newCount], ['기존 상품 변경', summary.changedCount], ['누락 상품 · 기존 유지', summary.missingCount], ['필수값 누락', summary.requiredMissingCount], ['중복코드', summary.duplicateCount], ['품명 불일치', summary.nameMismatchCount], ['규격 변경', summary.specChangeCount], ['단위 변경·누락', summary.unitChangeMissingCount], ['기타 주요 필드 변경', summary.otherImportantCount], ['저장 차단 이슈', summary.blockingCount]];
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[120] bg-slate-950/55 flex items-center justify-center p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "px-6 py-5 bg-amber-50 border-b border-amber-200"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-lg font-black text-amber-900"
  }, "2. \uC815\uBCF4\uC218\uC815 Excel \uBE44\uAD50 \uACB0\uACFC \uC694\uC57D"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-amber-800 mt-1"
  }, "\uC544\uC9C1 master\uC5D0\uB294 \uC544\uBB34 \uAC12\uB3C4 \uC800\uC7A5\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC774\uC288 \uD654\uBA74\uC5D0\uC11C \uC608\uC678 \uC0C1\uD488\uC744 \uD655\uC778\uD558\uC138\uC694.")), /*#__PURE__*/React.createElement("div", {
    className: "p-6 grid grid-cols-3 gap-3"
  }, rows.map(([label, count]) => /*#__PURE__*/React.createElement("div", {
    key: label,
    className: `rounded-xl border p-3 ${label === '저장 차단 이슈' && count > 0 ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-bold text-slate-500"
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "text-xl font-black text-slate-900 mt-1"
  }, count.toLocaleString(), "\uAC74")))), /*#__PURE__*/React.createElement("div", {
    className: "px-6 pb-6 flex justify-end gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onDiscard,
    className: "px-4 py-2 rounded-lg border border-rose-200 text-rose-700 text-xs font-bold hover:bg-rose-50"
  }, "\uBE44\uAD50 \uACB0\uACFC \uD3D0\uAE30"), /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    className: "px-4 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs font-bold hover:bg-slate-50"
  }, "\uC5C5\uB85C\uB4DC \uCDE8\uC18C"), /*#__PURE__*/React.createElement("button", {
    onClick: onReview,
    className: "px-5 py-2 rounded-lg bg-indigo-600 text-white text-xs font-black hover:bg-indigo-700"
  }, "3. \uC774\uC288 \uD655\uC778\uC73C\uB85C \uC774\uB3D9"))));
};
const MasterAddUpdatePreviewModal = ({
  preview,
  onBack,
  onSave,
  isSaving
}) => {
  if (!preview) return null;
  const counts = preview.counts;
  const rows = [['일괄 승인 준비', counts.approvedCount], ['신규 적용 예정', counts.createCount], ['기존 상품 수정 예정', counts.updateCount], ['적용 예정 변경 필드', counts.appliedFieldCount], ['상품 전체 제외', counts.excludedCount], ['필드 반영 제외', counts.fieldExcludedCount], ['미승인', counts.unapprovedCount], ['저장 차단', counts.blockedCount], ['반영 필드 없음', counts.noAppliedFieldProductCount], ['누락 상품 · 기존 유지', counts.missingRetainedCount]];
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[124] bg-slate-950/55 flex items-center justify-center p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-3xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "px-6 py-5 bg-indigo-50 border-b border-indigo-200"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-lg font-black text-indigo-900"
  }, "6. \uC801\uC6A9 \uC608\uC815 \uACB0\uACFC \uD655\uC778"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-indigo-800 mt-1"
  }, "\uD604\uC7AC \uC2B9\uC778 \uACB0\uC815\uC744 \uAE30\uC874 master\uC5D0 \uC801\uC6A9\uD55C\uB2E4\uACE0 \uAC00\uC815\uD574 \uACC4\uC0B0\uD55C \uC77D\uAE30 \uC804\uC6A9 \uACB0\uACFC\uC785\uB2C8\uB2E4. \uC544\uC9C1 master\uC5D0\uB294 \uC800\uC7A5\uD558\uC9C0 \uC54A\uC558\uC73C\uBA70 history\uB3C4 \uAE30\uB85D\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("div", {
    className: "p-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-2 sm:grid-cols-5 gap-3"
  }, rows.map(([label, count]) => /*#__PURE__*/React.createElement("div", {
    key: label,
    className: `rounded-xl border p-3 ${label === '저장 차단' && count > 0 ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200'}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-bold text-slate-500"
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "text-lg font-black text-slate-900 mt-1"
  }, count.toLocaleString(), "\uAC74")))), /*#__PURE__*/React.createElement("div", {
    className: "mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs font-bold text-amber-900"
  }, "\uC774 \uD654\uBA74\uC758 \uC218\uCE58\uB294 \uC800\uC7A5 \uC804 \uBBF8\uB9AC\uBCF4\uAE30\uC785\uB2C8\uB2E4. \uC544\uB798 \uC800\uC7A5 \uBC84\uD2BC\uC744 \uB204\uB974\uAE30 \uC804\uC5D0\uB294 \uC0C1\uD488 master\xB7revision\xB7history\uAC00 \uBCC0\uACBD\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("div", {
    className: "px-6 pb-6 flex justify-end gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onBack,
    disabled: isSaving,
    className: "px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-xs font-bold disabled:opacity-40"
  }, "\uC774\uC288 \uD655\uC778\uC73C\uB85C \uB3CC\uC544\uAC00\uAE30"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onSave,
    disabled: isSaving || counts.savedProductCount === 0,
    className: "px-5 py-2 rounded-lg bg-emerald-600 text-white text-xs font-black disabled:bg-slate-400"
  }, isSaving ? '저장·검증 중...' : '7. 승인 항목 저장'))));
};
const MasterAddUpdateResultModal = ({
  result,
  onClose
}) => {
  if (!result) return null;
  const counts = result.counts;
  const rows = [['신규 생성', counts.createCount], ['기존 상품 갱신', counts.updateCount], ['실제 반영 필드', counts.appliedFieldCount], ['동일하여 미변경', counts.sameCount], ['관리자 제외', counts.excludedCount], ['누락되어 기존 master 유지', counts.missingRetainedCount], ['저장 차단', counts.blockedCount], ['저장 실패', counts.failedCount]];
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[125] bg-slate-950/55 flex items-center justify-center p-5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "px-6 py-5 bg-emerald-50 border-b border-emerald-200"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-lg font-black text-emerald-900"
  }, "\uC815\uBCF4\uC218\uC815 Excel \uC800\uC7A5\xB7\uAC80\uC99D \uC644\uB8CC"), /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-emerald-800 mt-1"
  }, "master\uC640 \uACF5\uC2DD history\uB97C \uC800\uC7A5\uD55C \uB4A4 \uB2E4\uC2DC \uC77D\uC5B4 \uC77C\uCE58 \uC5EC\uBD80\uB97C \uD655\uC778\uD588\uC2B5\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("div", {
    className: "p-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-4 gap-3"
  }, rows.map(([label, count]) => /*#__PURE__*/React.createElement("div", {
    key: label,
    className: "rounded-xl bg-slate-50 border border-slate-200 p-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] font-bold text-slate-500"
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "text-lg font-black text-slate-900 mt-1"
  }, count.toLocaleString(), "\uAC74")))), /*#__PURE__*/React.createElement("div", {
    className: "mt-4 rounded-lg bg-slate-900 text-slate-100 px-4 py-3 text-[11px] font-mono break-all"
  }, "\uC2E4\uD589 ID: ", result.executionId), result.actorStatus === 'identity-system-unavailable' && /*#__PURE__*/React.createElement("div", {
    className: "mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3"
  }, "\uAD00\uB9AC\uC790 \uC2DD\uBCC4\uCCB4\uACC4\uAC00 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC544 \uC2E4\uD589\uC790\uB294 \uC784\uC758 \uAC12 \uC5C6\uC774 \uBBF8\uC2DD\uBCC4 \uC0C1\uD0DC\uB85C \uAE30\uB85D\uD588\uC2B5\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("div", {
    className: "px-6 pb-6 text-right"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    className: "px-5 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold"
  }, "\uD655\uC778"))));
};
const MasterAddUpdateReview = ({
  analysis,
  onChange,
  onClose,
  onDiscard,
  onBulkApply,
  isSaving,
  errorMessage
}) => {
  const api = window.ONEAPP_MASTER_ADD_UPDATE;
  const [selectedTags, setSelectedTags] = useState([]);
  const [includeSame, setIncludeSame] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const REVIEW_PAGE_SIZE = api?.DEFAULT_REVIEW_PAGE_SIZE || 50;
  const visible = analysis && api ? api.filterCandidates(analysis, selectedTags, {
    includeSame
  }) : [];
  const page = api ? api.paginateCandidates(visible, pageIndex, REVIEW_PAGE_SIZE) : {
    items: [],
    totalCount: 0,
    pageIndex: 0,
    pageCount: 1,
    startIndex: 0,
    endIndex: 0,
    hasPrevious: false,
    hasNext: false
  };
  useEffect(() => {
    if (pageIndex !== page.pageIndex) setPageIndex(page.pageIndex);
  }, [pageIndex, page.pageIndex]);
  if (!analysis || !api) return null;
  const tags = [api.ISSUE_TAGS.NEW, api.ISSUE_TAGS.CHANGED, api.ISSUE_TAGS.NAME, api.ISSUE_TAGS.SPEC_CHANGED, api.ISSUE_TAGS.SPEC_MISSING, api.ISSUE_TAGS.UNIT_CHANGED, api.ISSUE_TAGS.UNIT_MISSING, api.ISSUE_TAGS.DUPLICATE_SAME, api.ISSUE_TAGS.DUPLICATE_DIFFERENT, api.ISSUE_TAGS.BLANK, api.ISSUE_TAGS.ZERO, api.ISSUE_TAGS.SALE, api.ISSUE_TAGS.INTEGRATION, api.ISSUE_TAGS.SPOT, api.ISSUE_TAGS.TAX, api.ISSUE_TAGS.MASTER_MISMATCH, api.ISSUE_TAGS.BLOCKING, api.ISSUE_TAGS.MISSING];
  const toggleTag = tag => {
    setSelectedTags(current => current.includes(tag) ? current.filter(item => item !== tag) : [...current, tag]);
    setPageIndex(0);
  };
  const updateField = (candidateId, field, decision) => {
    onChange(api.setFieldDecision(analysis, candidateId, field, decision));
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[110] bg-slate-100 flex flex-col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-16 px-6 bg-slate-900 text-white flex items-center justify-between shrink-0 shadow-lg"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    className: "text-lg font-black"
  }, "3. \uC774\uC288 \uD655\uC778 \xB7 4. \uC608\uC678 \uC0C1\uD488 \uBC18\uC601 \uC81C\uC678"), /*#__PURE__*/React.createElement("p", {
    className: "text-[11px] text-slate-300"
  }, analysis.fileName, " \xB7 \uC608\uC678\uB9CC \uC81C\uC678\uD55C \uB4A4 \uC804\uCCB4 \uC77C\uAD04 \uC801\uC6A9\uC73C\uB85C \uC800\uC7A5 \uC804 \uACB0\uACFC\uB97C \uD655\uC778\uD569\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onDiscard,
    disabled: isSaving,
    className: "px-3 py-2 rounded-lg border border-rose-400/60 text-rose-200 text-xs font-bold"
  }, "\uBE44\uAD50 \uD3D0\uAE30"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    disabled: isSaving,
    className: "px-3 py-2 rounded-lg border border-slate-500 text-slate-200 text-xs font-bold"
  }, "\uC870\uD68C \uD654\uBA74\uC73C\uB85C"), /*#__PURE__*/React.createElement("button", {
    onClick: onBulkApply,
    disabled: isSaving || analysis.masterMismatch,
    className: "px-5 py-2 rounded-lg bg-indigo-500 disabled:bg-slate-600 text-white text-xs font-black"
  }, "5. \uC804\uCCB4 \uC77C\uAD04 \uC801\uC6A9"))), /*#__PURE__*/React.createElement("div", {
    className: "px-5 py-3 bg-white border-b border-slate-200 shrink-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center gap-2"
  }, tags.map(tag => {
    const count = analysis.candidates.filter(candidate => (candidate.issueTags || []).includes(tag)).length;
    return /*#__PURE__*/React.createElement("button", {
      key: tag,
      onClick: () => toggleTag(tag),
      className: `px-2.5 py-1.5 rounded-full border text-[11px] font-bold ${selectedTags.includes(tag) ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-300 text-slate-600'}`
    }, tag, " ", count);
  }), /*#__PURE__*/React.createElement("label", {
    className: "ml-auto flex items-center gap-2 text-[11px] font-bold text-slate-600"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: includeSame,
    onChange: e => {
      setIncludeSame(e.target.checked);
      setPageIndex(0);
    }
  }), "\uB3D9\uC77C \uC0C1\uD488 \uD45C\uC2DC"))), analysis.masterMismatch && /*#__PURE__*/React.createElement("div", {
    className: "px-5 py-3 bg-rose-50 border-b border-rose-200 flex items-center justify-between shrink-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold text-rose-800"
  }, "\uBE44\uAD50 \uD6C4 master revision\uC774 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uCD5C\uC2E0 master\uB85C \uBE44\uAD50\uB97C \uB2E4\uC2DC \uC0DD\uC131\uD588\uC73C\uBA70 \uC774\uC804 \uC2B9\uC778\uC740 \uBAA8\uB450 \uD3D0\uAE30\uD588\uC2B5\uB2C8\uB2E4."), /*#__PURE__*/React.createElement("button", {
    onClick: () => onChange(api.clearMasterMismatch(analysis)),
    className: "px-4 py-2 rounded-lg bg-rose-700 text-white text-xs font-black"
  }, "\uCD5C\uC2E0 \uBE44\uAD50 \uACB0\uACFC \uC7AC\uAC80\uD1A0 \uC2DC\uC791")), errorMessage && /*#__PURE__*/React.createElement("div", {
    className: "px-5 py-3 bg-rose-100 border-b border-rose-300 text-xs font-bold text-rose-900 shrink-0"
  }, errorMessage), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 overflow-y-auto p-5 space-y-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap items-center justify-between gap-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-bold text-slate-500"
  }, "\uD45C\uC2DC ", page.totalCount === 0 ? '0' : `${(page.startIndex + 1).toLocaleString()}-${page.endIndex.toLocaleString()}`, " / \uD544\uD130 \uACB0\uACFC ", page.totalCount.toLocaleString(), "\uAC74 / \uC804\uCCB4 \uBE44\uAD50 ", analysis.summary.compareCount.toLocaleString(), "\uAC74 / \uB204\uB77D \uC720\uC9C0 ", analysis.summary.missingCount.toLocaleString(), "\uAC74"), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2 text-[11px] font-bold text-slate-600"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    disabled: !page.hasPrevious,
    onClick: () => setPageIndex(current => Math.max(0, current - 1)),
    className: "px-3 py-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-40"
  }, "\uC774\uC804"), /*#__PURE__*/React.createElement("span", null, page.pageIndex + 1, " / ", page.pageCount, " \uD398\uC774\uC9C0"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    disabled: !page.hasNext,
    onClick: () => setPageIndex(current => current + 1),
    className: "px-3 py-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-40"
  }, "\uB2E4\uC74C"))), page.items.map(candidate => {
    const fieldRows = Object.values(candidate.fields || {}).filter(field => candidate.status === 'new' || field.changed || field.issueTags.length > 0);
    const hardBlocked = candidate.blockingReasons.some(reason => !['new_required_value_missing', 'new_required_approval_incomplete'].includes(reason));
    const requiredValueMissing = candidate.blockingReasons.includes('new_required_value_missing');
    return /*#__PURE__*/React.createElement("section", {
      key: candidate.id,
      className: `bg-white rounded-xl border shadow-sm overflow-hidden ${candidate.blockingReasons.length > 0 ? 'border-rose-300' : 'border-slate-200'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-start gap-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "min-w-[150px]"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] font-bold text-slate-400"
    }, "\uC0C1\uD488\uCF54\uB4DC \xB7 \uC77D\uAE30 \uC804\uC6A9"), /*#__PURE__*/React.createElement("div", {
      className: "text-sm font-black text-slate-900"
    }, candidate.code || `(공란 / ${candidate.rowNumber}행)`)), /*#__PURE__*/React.createElement("div", {
      className: "flex-1 flex flex-wrap gap-1"
    }, candidate.issueTags.map(tag => /*#__PURE__*/React.createElement("span", {
      key: tag,
      className: `px-2 py-1 rounded text-[10px] font-bold ${tag === api.ISSUE_TAGS.BLOCKING ? 'bg-rose-100 text-rose-800' : 'bg-indigo-50 text-indigo-700'}`
    }, tag))), !['same', 'missing', 'blocked'].includes(candidate.status) && /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-2"
    }, /*#__PURE__*/React.createElement("button", {
      disabled: hardBlocked || requiredValueMissing,
      onClick: () => onChange(api.setProductApproved(analysis, candidate.id, !candidate.productApproved)),
      className: `px-3 py-1.5 rounded-lg text-[11px] font-bold disabled:opacity-40 ${candidate.productApproved ? 'bg-emerald-600 text-white' : 'border border-emerald-300 text-emerald-700'}`
    }, "\uC0C1\uD488 \uC804\uCCB4 \uC2B9\uC778"), /*#__PURE__*/React.createElement("button", {
      disabled: hardBlocked,
      onClick: () => onChange(api.setProductExcluded(analysis, candidate.id, !candidate.productExcluded)),
      className: `px-3 py-1.5 rounded-lg text-[11px] font-bold disabled:opacity-40 ${candidate.productExcluded ? 'bg-slate-700 text-white' : 'border border-slate-300 text-slate-600'}`
    }, "\uC0C1\uD488 \uC804\uCCB4 \uC81C\uC678"), /*#__PURE__*/React.createElement("label", {
      className: "flex items-center gap-1.5 text-[11px] font-bold text-slate-700"
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: candidate.adminComplete,
      disabled: candidate.blockingReasons.length > 0,
      onChange: e => onChange(api.setAdminComplete(analysis, candidate.id, e.target.checked))
    }), "\uAD00\uB9AC\uC790 \uD655\uC778 \uC644\uB8CC"))), candidate.status === 'new' && candidate.blockingReasons.some(reason => reason.startsWith('new_required_')) && !candidate.productExcluded && /*#__PURE__*/React.createElement("div", {
      className: "px-4 py-3 bg-rose-50 border-b border-rose-200 text-[11px] font-bold text-rose-900"
    }, "\uC2E0\uADDC \uC0C1\uD488\uC740 \uD488\uBAA9\uBA85\xB7\uADDC\uACA9\xB7\uB2E8\uC704\uC758 \uCD5C\uC885\uAC12\uC774 \uBAA8\uB450 \uC788\uC5B4\uC57C \uD558\uBA70, \uC138 \uD544\uB4DC\uAC00 \uC0C1\uD488 \uC2B9\uC778 \uB610\uB294 \uD544\uB4DC\uBCC4 \uC2B9\uC778 \uBC94\uC704\uC5D0 \uD3EC\uD568\uB418\uC5B4\uC57C \uC800\uC7A5\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."), candidate.duplicateRows.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "p-4 bg-amber-50 border-b border-amber-200"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-xs font-black text-amber-900 mb-2"
    }, "\uC911\uBCF5 \uD589\uC744 \uC790\uB3D9 \uBCD1\uD569\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uAD00\uB9AC\uC790\uAC00 \uC0AC\uC6A9\uD560 \uD55C \uD589\uC744 \uBA85\uC2DC\uC801\uC73C\uB85C \uC120\uD0DD\uD558\uC138\uC694."), /*#__PURE__*/React.createElement("div", {
      className: "grid grid-cols-2 gap-2"
    }, candidate.duplicateRows.map(entry => /*#__PURE__*/React.createElement("button", {
      key: entry.rowNumber,
      onClick: () => onChange(api.resolveDuplicate(analysis, candidate.id, entry.rowNumber)),
      className: `text-left rounded-lg border p-3 ${candidate.selectedDuplicateRowNumber === entry.rowNumber ? 'bg-emerald-50 border-emerald-400' : 'bg-white border-amber-200'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-[11px] font-black text-slate-800"
    }, "Excel ", entry.rowNumber, "\uD589 ", candidate.selectedDuplicateRowNumber === entry.rowNumber ? '· 선택됨' : '· 이 행 선택'), /*#__PURE__*/React.createElement("div", {
      className: "mt-1 text-[10px] text-slate-600 break-all"
    }, analysis.headers.filter(header => !api.CODE_FIELDS.includes(header)).map(header => `${header}: ${formatReviewValue(entry.row[header], Object.prototype.hasOwnProperty.call(entry.row, header))}`).join(' / ')))))), candidate.status === 'missing' ? /*#__PURE__*/React.createElement("div", {
      className: "p-4 text-xs font-bold text-slate-600"
    }, "\uC5C5\uB85C\uB4DC \uD30C\uC77C\uC5D0 \uC5C6\uC9C0\uB9CC \uC0AD\uC81C\xB7\uC218\uC815\uD558\uC9C0 \uC54A\uACE0 \uAE30\uC874 master\uB97C \uC720\uC9C0\uD569\uB2C8\uB2E4.") : fieldRows.length === 0 ? /*#__PURE__*/React.createElement("div", {
      className: "p-4 text-xs text-slate-500"
    }, "\uBCC0\uACBD\uB41C \uD544\uB4DC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.") : /*#__PURE__*/React.createElement("div", {
      className: "overflow-x-auto"
    }, /*#__PURE__*/React.createElement("table", {
      className: "w-full text-[11px]"
    }, /*#__PURE__*/React.createElement("thead", {
      className: "bg-slate-100 text-slate-500"
    }, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
      className: "px-3 py-2 text-left min-w-[110px]"
    }, "\uD544\uB4DC"), /*#__PURE__*/React.createElement("th", {
      className: "px-3 py-2 text-left min-w-[150px]"
    }, "\uAE30\uC874 master"), /*#__PURE__*/React.createElement("th", {
      className: "px-3 py-2 text-left min-w-[150px]"
    }, "\uC5C5\uB85C\uB4DC \uC6D0\uBCF8"), /*#__PURE__*/React.createElement("th", {
      className: "px-3 py-2 text-left min-w-[180px]"
    }, "\uAD00\uB9AC\uC790 \uAC12 / \uC120\uD0DD"), /*#__PURE__*/React.createElement("th", {
      className: "px-3 py-2 text-left min-w-[140px]"
    }, "\uCD5C\uC885 \uBC18\uC601\uAC12"), /*#__PURE__*/React.createElement("th", {
      className: "px-3 py-2 text-left min-w-[170px]"
    }, "\uC2B9\uC778\xB7\uC81C\uC678"))), /*#__PURE__*/React.createElement("tbody", null, fieldRows.map(field => {
      const finalValue = api.getFieldFinalValue(field);
      const canDirectEdit = api.EDITABLE_FIELDS.includes(field.field);
      return /*#__PURE__*/React.createElement("tr", {
        key: field.field,
        className: `border-t border-slate-100 ${field.excluded ? 'bg-slate-100 opacity-70' : ''}`
      }, /*#__PURE__*/React.createElement("td", {
        className: "px-3 py-3 align-top"
      }, /*#__PURE__*/React.createElement("div", {
        className: "font-black text-slate-800"
      }, field.field), (field.sourceHeader !== field.field || field.sourceCellAddress) && /*#__PURE__*/React.createElement("div", {
        className: "mt-0.5 text-[9px] text-slate-500"
      }, "\uC6D0\uBCF8 ", field.sourceHeader, field.sourceCellAddress ? ` · ${field.sourceCellAddress}` : ''), /*#__PURE__*/React.createElement("div", {
        className: "mt-1 flex flex-wrap gap-1"
      }, field.issueTags.map(tag => /*#__PURE__*/React.createElement("span", {
        key: tag,
        className: "px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-bold"
      }, tag)))), /*#__PURE__*/React.createElement("td", {
        className: "px-3 py-3 align-top break-all"
      }, formatReviewValue(field.oldValue, Object.prototype.hasOwnProperty.call(candidate.existing, field.field))), /*#__PURE__*/React.createElement("td", {
        className: "px-3 py-3 align-top break-all"
      }, formatReviewValue(field.uploadDisplay, field.uploadPresent)), /*#__PURE__*/React.createElement("td", {
        className: "px-3 py-3 align-top"
      }, canDirectEdit && /*#__PURE__*/React.createElement("input", {
        type: "text",
        value: field.adminEdited ? safeStr(field.adminValue) : '',
        placeholder: "\uC9C1\uC811 \uC785\uB825",
        disabled: hardBlocked,
        onChange: e => updateField(candidate.id, field.field, {
          adminValue: e.target.value
        }),
        className: "w-full border border-slate-300 rounded px-2 py-1.5 mb-2 outline-none focus:border-indigo-500 disabled:bg-slate-100"
      }), /*#__PURE__*/React.createElement("div", {
        className: "flex flex-wrap gap-1"
      }, /*#__PURE__*/React.createElement("button", {
        disabled: !field.uploadPresent || hardBlocked,
        onClick: () => updateField(candidate.id, field.field, {
          source: 'upload'
        }),
        className: "px-2 py-1 rounded border border-slate-300 disabled:opacity-30"
      }, "\uC5C5\uB85C\uB4DC\uAC12"), /*#__PURE__*/React.createElement("button", {
        disabled: hardBlocked,
        onClick: () => updateField(candidate.id, field.field, {
          source: 'old'
        }),
        className: "px-2 py-1 rounded border border-slate-300 disabled:opacity-30"
      }, "\uAE30\uC874\uAC12"), /*#__PURE__*/React.createElement("button", {
        disabled: hardBlocked,
        onClick: () => updateField(candidate.id, field.field, {
          source: 'blank'
        }),
        className: "px-2 py-1 rounded border border-slate-300 disabled:opacity-30"
      }, "\uACF5\uB780"))), /*#__PURE__*/React.createElement("td", {
        className: "px-3 py-3 align-top font-bold break-all"
      }, formatReviewValue(finalValue, finalValue !== undefined)), /*#__PURE__*/React.createElement("td", {
        className: "px-3 py-3 align-top"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex gap-1"
      }, /*#__PURE__*/React.createElement("button", {
        disabled: hardBlocked,
        onClick: () => updateField(candidate.id, field.field, {
          approved: !field.approved,
          excluded: false
        }),
        className: `px-2.5 py-1.5 rounded font-bold disabled:opacity-40 ${field.approved ? 'bg-emerald-600 text-white' : 'border border-emerald-300 text-emerald-700'}`
      }, "\uD544\uB4DC \uC2B9\uC778"), /*#__PURE__*/React.createElement("button", {
        disabled: hardBlocked,
        onClick: () => updateField(candidate.id, field.field, {
          excluded: !field.excluded
        }),
        className: `px-2.5 py-1.5 rounded font-bold disabled:opacity-40 ${field.excluded ? 'bg-slate-700 text-white' : 'border border-slate-300 text-slate-600'}`
      }, "\uBC18\uC601 \uC81C\uC678")), candidate.productApproved && !field.excluded && /*#__PURE__*/React.createElement("div", {
        className: "mt-1 text-[9px] font-bold text-emerald-700"
      }, "\uC0C1\uD488 \uC2B9\uC778 \uC801\uC6A9"), candidate.productApproved && field.excluded && /*#__PURE__*/React.createElement("div", {
        className: "mt-1 text-[9px] font-bold text-slate-600"
      }, "\uD544\uB4DC \uC81C\uC678 \uC6B0\uC120")));
    })))));
  })));
};

// ==========================================
// 🚨 Error Boundary (하얀 화면 방지 시스템)
// ==========================================
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null
    };
  }
  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error
    };
  }
  render() {
    if (this.state.hasError) {
      return /*#__PURE__*/React.createElement("div", {
        className: "h-screen w-full flex flex-col items-center justify-center bg-slate-50 p-6"
      }, /*#__PURE__*/React.createElement("i", {
        className: "fas fa-exclamation-triangle text-rose-500 text-6xl mb-6"
      }), /*#__PURE__*/React.createElement("h1", {
        className: "text-2xl font-black text-slate-800 mb-2"
      }, "\uD654\uBA74 \uB80C\uB354\uB9C1 \uC624\uB958 \uBC1C\uC0DD (Crash)"), /*#__PURE__*/React.createElement("p", {
        className: "text-slate-500 mb-6 text-center"
      }, "\uBD88\uB7EC\uC628 \uC5D1\uC140 \uB370\uC774\uD130 \uC911 \uBB38\uC790(\uAE00\uC790)\uAC00 \uC544\uB2CC \uD615\uC2DD(\uC22B\uC790 \uB4F1)\uC774 \uC11E\uC5EC\uC788\uC5B4 \uD654\uBA74\uC774 \uC911\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", /*#__PURE__*/React.createElement("br", null), "\uC544\uB798 [\uCD08\uAE30\uD654] \uBC84\uD2BC\uC744 \uB20C\uB7EC \uBCF5\uAD6C\uD574 \uC8FC\uC138\uC694."), /*#__PURE__*/React.createElement("div", {
        className: "bg-white border border-rose-200 p-4 rounded-lg text-xs font-mono text-rose-600 w-full max-w-2xl overflow-auto mb-8 shadow-sm"
      }, this.state.error && this.state.error.toString()), /*#__PURE__*/React.createElement("button", {
        onClick: () => {
          indexedDB.deleteDatabase('MerchOpsDB');
          localStorage.removeItem('merchMaster_v870');
          window.location.reload();
        },
        className: "px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold transition-colors shadow-lg flex items-center gap-2"
      }, /*#__PURE__*/React.createElement("i", {
        className: "fas fa-redo-alt"
      }), " \uB85C\uCEEC \uB370\uC774\uD130 \uCD08\uAE30\uD654 \uBC0F \uBCF5\uAD6C\uD558\uAE30"));
    }
    return this.props.children;
  }
}

// ==========================================
// 📊 Main App Container
// ==========================================
function App() {
  const [masterProducts, setMasterProducts] = useState({});
  const config = useMerchConfig();
  const [toastMsg, setToastMsg] = useState("");
  const visMasterCols = useMemo(() => {
    const cols = config?.visibleMasterCols?.estimate || [];
    return cols.filter(h => !['품목코드', '품목명', '규격'].includes(h));
  }, [config.visibleMasterCols]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processMsg, setProcessMsg] = useState('');
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const [addUpdateAnalysis, setAddUpdateAnalysis] = useState(null);
  const [showAddUpdateConfirm, setShowAddUpdateConfirm] = useState(false);
  const [showAddUpdateReview, setShowAddUpdateReview] = useState(false);
  const [addUpdateError, setAddUpdateError] = useState('');
  const [addUpdatePreview, setAddUpdatePreview] = useState(null);
  const [addUpdateResult, setAddUpdateResult] = useState(null);
  const [initialImportDraft, setInitialImportDraft] = useState(null);
  const [editingProduct, setEditingProduct] = useState(null);
  const [legacyState, setLegacyState] = useState({
    status: 'checking',
    exists: false,
    masterMap: {},
    rawItems: [],
    revision: null
  });
  const [changeRequestInbox, setChangeRequestInbox] = useState({
    status: 'LOADING',
    requests: [],
    error: null
  });
  const [selectedChangeRequest, setSelectedChangeRequest] = useState(null);
  const [selectedProductCode, setSelectedProductCode] = useState('');
  const [productResultOpen, setProductResultOpen] = useState(() => {
    try {
      return sessionStorage.getItem('nexus:master:right-panel:v1') !== 'closed';
    } catch {
      return true;
    }
  });
  const productTableScrollRef = useRef(null);
  const [activeC1, setActiveC1] = useState('');
  const [activeC2, setActiveC2] = useState('');
  const [activeC3, setActiveC3] = useState('');
  const showToast = useCallback(msg => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3000);
  }, []);
  const workspaceLifecycleStateRef = useRef(null);
  workspaceLifecycleStateRef.current = {
    isProcessing,
    toastMsg,
    editingOpen: Boolean(editingProduct),
    reviewOpen: Boolean(selectedChangeRequest || showAddUpdateConfirm || showAddUpdateReview || addUpdatePreview || initialImportDraft),
    settingsOpen: showSettingsModal
  };
  useEffect(() => {
    let unregister = null;
    const register = () => {
      const bridge = window.ONEAPP_NEXUS_WORKSPACE_CHILD;
      if (!bridge?.registerAdapter || unregister) return;
      unregister = bridge.registerAdapter({
        beforeLeave: async () => {
          const wasProcessing = Boolean(workspaceLifecycleStateRef.current?.isProcessing);
          const startedAt = Date.now();
          while (workspaceLifecycleStateRef.current?.isProcessing) {
            if (Date.now() - startedAt >= 10000) throw new Error('진행 중인 상품관리 저장 결과 확인 시간이 초과되었습니다.');
            await new Promise(resolve => window.setTimeout(resolve, 50));
          }
          if (wasProcessing && /실패|오류|❌/.test(workspaceLifecycleStateRef.current?.toastMsg || '')) {
            throw new Error('상품관리 저장이 실패하여 현재 화면을 유지합니다.');
          }
          if (workspaceLifecycleStateRef.current?.editingOpen || workspaceLifecycleStateRef.current?.reviewOpen || workspaceLifecycleStateRef.current?.settingsOpen) {
            return {
              result: 'BLOCKED',
              message: '열려 있는 상품 편집·검토 화면을 저장하거나 닫은 뒤 이동해 주세요.'
            };
          }
          return {
            result: 'READY'
          };
        },
        print: () => window.print()
      });
    };
    register();
    window.addEventListener('nexus-ui:ready', register);
    return () => {
      window.removeEventListener('nexus-ui:ready', register);
      unregister?.();
    };
  }, []);
  const refreshChangeRequestInbox = useCallback(async () => {
    try {
      const module = await window.__loadProductChangeRequestAdapter();
      const result = await module.productMasterChangeRequestAdapter.listChangeRequests({
        status: ['PENDING', 'IN_REVIEW'],
        limit: 200,
        collapseDuplicates: true
      });
      setChangeRequestInbox(result);
    } catch (error) {
      setChangeRequestInbox({
        status: 'ERROR',
        requests: [],
        error: {
          code: error.message || String(error)
        }
      });
    }
  }, []);
  useEffect(() => {
    loadMasterLocal().then(data => {
      if (data && typeof data === 'object') {
        setMasterProducts(data);
        try {
          const saved = JSON.parse(sessionStorage.getItem('oneapp.master.sku-return-state.v1') || 'null');
          if (saved) {
            setGlobalSearch(saved.globalSearch || '');
            setActiveC1(saved.activeC1 || '');
            setActiveC2(saved.activeC2 || '');
            setActiveC3(saved.activeC3 || '');
            if (saved.editingCode && data[saved.editingCode]) setEditingProduct(data[saved.editingCode]);
            setTimeout(() => {
              if (productTableScrollRef.current) productTableScrollRef.current.scrollTop = Number(saved.scrollTop || 0);
            }, 0);
            sessionStorage.removeItem('oneapp.master.sku-return-state.v1');
          }
        } catch {}
      }
    }).catch(error => {
      console.error(error);
      showToast(`❌ 마스터 불러오기 실패: ${error.message}`);
    });
    readLegacyItemMasterSnapshot().then(setLegacyState).catch(error => {
      setLegacyState({
        status: 'error',
        exists: true,
        masterMap: {},
        revision: null,
        error: error.message
      });
    });
    refreshChangeRequestInbox();
    const handleMessage = e => {
      const sameOrigin = e.origin === window.location.origin || window.location.origin === 'null' && e.origin === 'null';
      if (sameOrigin && e.source !== window && e.data && e.data.type === 'ONEAPP_SETTINGS_PANEL_CLOSE_V1') {
        setShowSettingsModal(false);
        loadMasterLocal().then(data => {
          if (data && typeof data === 'object') setMasterProducts(data);
        }).catch(error => {
          console.error(error);
          showToast(`❌ 마스터 다시 불러오기 실패: ${error.message}`);
        });
      }
    };
    const handleRequestChange = () => refreshChangeRequestInbox();
    window.addEventListener('message', handleMessage);
    window.addEventListener('oneapp:product-change-request-change', handleRequestChange);
    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('oneapp:product-change-request-change', handleRequestChange);
    };
  }, []);
  const openSkuManagement = () => {
    try {
      sessionStorage.setItem('oneapp.master.sku-return-state.v1', JSON.stringify({
        globalSearch,
        activeC1,
        activeC2,
        activeC3,
        editingCode: safeStr(editingProduct?.코드 || editingProduct?.품목코드),
        scrollTop: productTableScrollRef.current?.scrollTop || 0
      }));
    } catch {}
    window.ONEAPP_NEXUS_NAVIGATE_ROUTE('Item_manager.html', 'master-lookup');
  };
  const openChangeRequest = async entry => {
    setSelectedChangeRequest(entry);
    try {
      const module = await window.__loadProductChangeRequestAdapter();
      const result = await module.productMasterChangeRequestAdapter.beginReview({
        requestId: entry.request?.requestId,
        actor: null
      });
      if (result.entry) setSelectedChangeRequest({
        ...result.entry,
        duplicateRequestIds: entry.duplicateRequestIds || [],
        repeatedRequestCount: entry.repeatedRequestCount || 1
      });
      await refreshChangeRequestInbox();
    } catch (error) {
      console.error(error);
      showToast(`❌ 요청 상세조회 실패: ${error.message}`);
    }
  };
  const completeSelectedRequest = async ({
    resolution,
    productCode = '',
    reason = '',
    result = null
  }) => {
    const module = await window.__loadProductChangeRequestAdapter();
    const completed = await module.productMasterChangeRequestAdapter.completeChangeRequest({
      requestId: selectedChangeRequest?.request?.requestId,
      resolution,
      productCode,
      reason,
      actor: null,
      result
    });
    if (!['APPLIED', 'LINKED', 'REJECTED'].includes(completed.status)) throw new Error(completed.error?.code || '요청 완료 처리 실패');
    const duplicateResolution = resolution === 'APPLIED' ? 'LINKED' : resolution;
    for (const requestId of selectedChangeRequest?.duplicateRequestIds || []) {
      const duplicateCompleted = await module.productMasterChangeRequestAdapter.completeChangeRequest({
        requestId,
        resolution: duplicateResolution,
        productCode,
        reason: [reason, '동일 요청 통합 처리'].filter(Boolean).join(' · '),
        actor: null,
        result
      });
      if (!['APPLIED', 'LINKED', 'REJECTED'].includes(duplicateCompleted.status)) console.warn('동일 상품 중복 요청 정리 실패', requestId, duplicateCompleted.error?.code);
    }
    setSelectedChangeRequest(null);
    await refreshChangeRequestInbox();
    return completed;
  };
  const handleApplyChangeRequest = async (input, reason) => {
    if (!selectedChangeRequest) return;
    const request = selectedChangeRequest.request || {};
    setIsProcessing(true);
    setProcessMsg(request.operation === 'CREATE' ? '요청 상품을 공식 마스터에 등록 중...' : '요청 수정값을 공식 마스터에 반영 중...');
    try {
      const normalized = window.ONEAPP_MASTER_ADD_UPDATE.validateSingleProductInput(request.operation === 'CREATE' ? window.ONEAPP_MASTER_ADD_UPDATE.deriveProductCategoryFields(input, masterProducts) : input);
      PRODUCT_FORM_FIELDS.concat(DETAIL_PRODUCT_FIELDS).filter(field => field.type === 'number').forEach(({
        key
      }) => {
        if (safeStr(normalized[key]).trim() !== '') normalized[key] = Number(normalized[key]);
      });
      const code = safeStr(normalized.코드 || normalized.품목코드).trim();
      const existing = masterProducts[code];
      const preparedTarget = selectedChangeRequest.review?.applyTarget?.targetProduct;
      const preparedAlreadyApplied = Boolean(existing && preparedTarget && Object.entries(preparedTarget).every(([key, value]) => Object.is(existing[key] ?? '', value ?? '')));
      let commitResult = null;
      if (preparedAlreadyApplied) {
        commitResult = null;
      } else if (request.operation === 'CREATE' && existing) {
        throw new Error('같은 상품코드가 이미 존재합니다. 기존 상품 연결 또는 다른 코드를 선택하세요.');
      } else {
        if (request.operation !== 'CREATE' && !existing) throw new Error('수정할 기존 상품을 찾지 못했습니다. 최신 상품정보를 확인하세요.');
        const module = await window.__loadProductChangeRequestAdapter();
        const prepared = await module.productMasterChangeRequestAdapter.prepareApply({
          requestId: request.requestId,
          productCode: code,
          targetProduct: normalized,
          actor: null
        });
        if (prepared.status !== 'IN_REVIEW') throw new Error(prepared.error?.code || '요청 반영 준비 기록 실패');
        setSelectedChangeRequest(prepared.entry);
        commitResult = await window.ONEAPP_MASTER_ADD_UPDATE.commitSingleProductChange({
          item: normalized,
          isEditing: request.operation !== 'CREATE',
          expectedRevision: masterPageRevision,
          storage: window.ONEAPP?.STORAGE,
          historyApi: window.ONEAPP?.HISTORY,
          localStorageRef: window.localStorage,
          actor: null
        });
        masterPageRevision = commitResult.revision;
        setMasterProducts(commitResult.masterMap);
      }
      await completeSelectedRequest({
        resolution: 'APPLIED',
        productCode: code,
        reason,
        result: {
          revision: commitResult?.revision ?? masterPageRevision
        }
      });
      showToast(`✅ [${safeStr(normalized.품목명, code)}] 요청 처리가 완료되었습니다.`);
    } catch (error) {
      console.error(error);
      if (error?.code === 'MERCH_MASTER_REVISION_CONFLICT') {
        const latestMaster = await loadMasterLocal().catch(() => masterProducts);
        setMasterProducts(latestMaster);
      }
      showToast(`❌ 요청 처리 실패: ${error.message}`);
    } finally {
      setIsProcessing(false);
      setProcessMsg('');
    }
  };
  const handleRegisterAllCreateRequests = async () => {
    const targets = (changeRequestInbox.requests || []).filter(entry => entry.request?.operation === 'CREATE');
    if (targets.length === 0 || isProcessing) return;
    if (!window.confirm(`신규 상품 등록 요청 ${targets.length.toLocaleString()}건을 전체 등록하시겠습니까?\n중복 코드 또는 필수값 오류가 있는 요청은 등록하지 않고 목록에 남깁니다.`)) return;
    setIsProcessing(true);
    setProcessMsg(`신규 상품 전체 등록 준비 중... (0/${targets.length})`);
    let workingMaster = masterProducts;
    let successCount = 0;
    const failures = [];
    try {
      const module = await window.__loadProductChangeRequestAdapter();
      for (let index = 0; index < targets.length; index += 1) {
        const entry = targets[index];
        const request = entry.request || {};
        const displayName = request.changes?.find(change => change.field === '품목명')?.proposedValue || request.entityId || `요청 ${index + 1}`;
        setProcessMsg(`신규 상품 전체 등록 중... (${index + 1}/${targets.length}) ${displayName}`);
        try {
          const normalized = window.ONEAPP_MASTER_ADD_UPDATE.validateSingleProductInput(requestProposedItem(entry, workingMaster));
          PRODUCT_FORM_FIELDS.concat(DETAIL_PRODUCT_FIELDS).filter(field => field.type === 'number').forEach(({
            key
          }) => {
            if (safeStr(normalized[key]).trim() !== '') normalized[key] = Number(normalized[key]);
          });
          const code = safeStr(normalized.코드 || normalized.품목코드).trim();
          const existing = workingMaster[code];
          const preparedTarget = entry.review?.applyTarget?.targetProduct;
          const preparedAlreadyApplied = Boolean(existing && preparedTarget && Object.entries(preparedTarget).every(([key, value]) => Object.is(existing[key] ?? '', value ?? '')));
          let commitResult = null;
          if (!preparedAlreadyApplied) {
            if (existing) throw new Error('같은 상품코드가 이미 존재합니다. 개별 수정에서 기존 상품 연결 또는 다른 코드를 선택하세요.');
            const prepared = await module.productMasterChangeRequestAdapter.prepareApply({
              requestId: request.requestId,
              productCode: code,
              targetProduct: normalized,
              actor: null
            });
            if (prepared.status !== 'IN_REVIEW') throw new Error(prepared.error?.code || '요청 반영 준비 기록 실패');
            commitResult = await window.ONEAPP_MASTER_ADD_UPDATE.commitSingleProductChange({
              item: normalized,
              isEditing: false,
              expectedRevision: masterPageRevision,
              storage: window.ONEAPP?.STORAGE,
              historyApi: window.ONEAPP?.HISTORY,
              localStorageRef: window.localStorage,
              actor: null
            });
            masterPageRevision = commitResult.revision;
            workingMaster = commitResult.masterMap;
          }
          const completed = await module.productMasterChangeRequestAdapter.completeChangeRequest({
            requestId: request.requestId,
            resolution: 'APPLIED',
            productCode: code,
            reason: '신규 상품 전체 등록',
            actor: null,
            result: {
              revision: commitResult?.revision ?? masterPageRevision
            }
          });
          if (completed.status !== 'APPLIED') throw new Error(completed.error?.code || '요청 완료 처리 실패');
          for (const requestId of entry.duplicateRequestIds || []) {
            const duplicateCompleted = await module.productMasterChangeRequestAdapter.completeChangeRequest({
              requestId,
              resolution: 'LINKED',
              productCode: code,
              reason: '신규 상품 전체 등록 · 동일 요청 통합 처리',
              actor: null,
              result: {
                revision: commitResult?.revision ?? masterPageRevision
              }
            });
            if (duplicateCompleted.status !== 'LINKED') console.warn('동일 상품 중복 요청 정리 실패', requestId, duplicateCompleted.error?.code);
          }
          successCount += 1;
        } catch (error) {
          console.error(error);
          failures.push({
            name: displayName,
            reason: error.message || String(error)
          });
          if (error?.code === 'MERCH_MASTER_REVISION_CONFLICT') {
            workingMaster = await loadMasterLocal().catch(() => workingMaster);
          }
        }
      }
      setMasterProducts(workingMaster);
      await refreshChangeRequestInbox();
      if (failures.length > 0) {
        showToast(`⚠️ 전체 등록 결과: 성공 ${successCount}건 · 확인 필요 ${failures.length}건`);
      } else {
        showToast(`✅ 신규 상품 ${successCount}건 전체 등록 완료`);
      }
    } catch (error) {
      console.error(error);
      showToast(`❌ 전체 등록 실패: ${error.message}`);
    } finally {
      setIsProcessing(false);
      setProcessMsg('');
    }
  };
  const handleLinkChangeRequest = async (productCode, reason) => {
    if (!masterProducts[productCode]) return showToast('❌ 연결할 기존 상품코드를 확인하세요.');
    setIsProcessing(true);
    try {
      await completeSelectedRequest({
        resolution: 'LINKED',
        productCode,
        reason
      });
      showToast(`✅ 기존 상품 [${productCode}]에 연결했습니다.`);
    } catch (error) {
      showToast(`❌ 기존 상품 연결 실패: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  };
  const handleRejectChangeRequest = async reason => {
    setIsProcessing(true);
    try {
      await completeSelectedRequest({
        resolution: 'REJECTED',
        reason
      });
      showToast('✅ 요청을 반려하고 사유를 기록했습니다.');
    } catch (error) {
      showToast(`❌ 반려 처리 실패: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  };
  const discardAddUpdateAnalysis = () => {
    setAddUpdateAnalysis(null);
    setAddUpdatePreview(null);
    setShowAddUpdateConfirm(false);
    setShowAddUpdateReview(false);
    setAddUpdateError('');
  };
  const legacySummary = useMemo(() => {
    const legacyMap = legacyState.status === 'ready' ? legacyState.masterMap : {};
    const stableSerialize = window.ONEAPP_MASTER_ADD_UPDATE?.stableSerialize || JSON.stringify;
    let newCount = 0;
    let sameCount = 0;
    let conflictCount = 0;
    Object.entries(legacyMap).forEach(([code, item]) => {
      const current = masterProducts[code];
      if (!current) newCount += 1;else if (stableSerialize(current) === stableSerialize(item)) sameCount += 1;else conflictCount += 1;
    });
    return {
      total: Object.keys(legacyMap).length,
      newCount,
      sameCount,
      conflictCount
    };
  }, [legacyState, masterProducts]);
  const downloadLegacyBackup = () => {
    if (legacyState.status !== 'ready') return;
    const payload = {
      schemaVersion: 'ONEAPP_ITEMMASTER_LEGACY_BACKUP_V1',
      sourceDatabase: LEGACY_ITEMMASTER_DB.NAME,
      exportedAt: new Date().toISOString(),
      revision: legacyState.revision,
      productCount: legacySummary.total,
      products: Array.isArray(legacyState.rawItems) ? legacyState.rawItems : Object.values(legacyState.masterMap)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ItemMaster-legacy-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`✅ 레거시 격리 DB ${legacySummary.total.toLocaleString()}건 백업 파일 생성`);
  };
  const startLegacyReview = () => {
    if (legacyState.status !== 'ready' || !window.ONEAPP_MASTER_ADD_UPDATE) return;
    try {
      const values = Object.values(legacyState.masterMap);
      const allHeaders = new Set();
      values.forEach(item => Object.keys(item || {}).forEach(field => {
        if (!field.startsWith('__')) allHeaders.add(field);
      }));
      const headers = ['코드', ...[...allHeaders].filter(field => field !== '코드')];
      const rows = values.map((item, index) => ({
        ...item,
        __rowNumber: index + 1,
        __display: Object.fromEntries(headers.map(field => [field, item[field]])),
        __masterMapped: true
      }));
      const analysis = window.ONEAPP_MASTER_ADD_UPDATE.analyzeUploadRows({
        headers,
        rows,
        currentMaster: masterProducts,
        revision: masterPageRevision,
        fileName: `레거시 ${LEGACY_ITEMMASTER_DB.NAME}`,
        allowEmptyMaster: true
      });
      analysis.sourceType = 'legacy-itemmaster-isolated';
      setAddUpdateAnalysis(analysis);
      setAddUpdatePreview(null);
      setAddUpdateError('레거시 원본은 읽기 전용으로 유지됩니다. 신규·변경 항목을 검토해 명시적으로 승인한 값만 공식 master에 저장하세요.');
      setShowAddUpdateReview(false);
      setShowAddUpdateConfirm(true);
    } catch (error) {
      showToast(`❌ 레거시 검토 준비 실패: ${error.message}`);
    }
  };
  const handleExcelUpload = event => {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';
    const extension = safeStr(file.name).toLowerCase().split('.').pop();
    if (!['xlsx', 'xls'].includes(extension)) {
      showToast('❌ 정보수정 Excel은 xlsx 또는 xls 파일만 사용할 수 있습니다.');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      showToast('❌ Excel 파일은 25MB를 초과할 수 없습니다.');
      return;
    }
    if (!window.ONEAPP_MASTER_ADD_UPDATE) {
      showToast('❌ 정보수정 Excel 검토 모듈을 불러오지 못했습니다.');
      return;
    }
    setIsProcessing(true);
    setProcessMsg("분석 중...");
    const reader = new FileReader();
    reader.onload = async loadEvent => {
      try {
        const parsed = parseMasterAddUpdateWorkbook(loadEvent.target.result);
        if (Object.keys(masterProducts || {}).length === 0) {
          setInitialImportDraft(buildInitialMasterImport(parsed, file.name));
          return;
        }
        const analysis = window.ONEAPP_MASTER_ADD_UPDATE.analyzeUploadRows({
          ...parsed,
          currentMaster: masterProducts,
          revision: masterPageRevision,
          fileName: file.name
        });
        const hasReviewIssue = analysis.summary.newCount > 0 || analysis.summary.changedCount > 0 || analysis.summary.missingCount > 0 || analysis.summary.duplicateCount > 0 || analysis.summary.blockingCount > 0;
        if (!hasReviewIssue) {
          showToast(`ℹ️ 업로드 ${analysis.summary.sameCount.toLocaleString()}건이 현재 master와 동일하여 저장 대상이 없습니다.`);
          return;
        }
        setAddUpdateAnalysis(analysis);
        setAddUpdatePreview(null);
        setAddUpdateError('');
        setShowAddUpdateReview(false);
        setShowAddUpdateConfirm(true);
      } catch (err) {
        showToast("❌ 분석 실패: " + err.message);
      } finally {
        setIsProcessing(false);
        setProcessMsg("");
      }
    };
    reader.onerror = () => {
      setIsProcessing(false);
      setProcessMsg('');
      showToast('❌ Excel 파일 읽기에 실패했습니다.');
    };
    reader.readAsArrayBuffer(file);
  };
  const handleSaveInitialImport = async () => {
    if (!initialImportDraft || !window.ONEAPP_MASTER_ADD_UPDATE?.commitInitialRegistration) return;
    setIsProcessing(true);
    setProcessMsg('공식 master·revision·history에 최초 상품을 저장 중...');
    try {
      const result = await window.ONEAPP_MASTER_ADD_UPDATE.commitInitialRegistration({
        masterMap: initialImportDraft.masterMap,
        fileName: initialImportDraft.fileName,
        expectedRevision: initialImportDraft.baseRevision,
        storage: window.ONEAPP?.STORAGE,
        historyApi: window.ONEAPP?.HISTORY,
        localStorageRef: window.localStorage,
        actor: null
      });
      masterPageRevision = result.revision;
      setMasterProducts(result.masterMap);
      setInitialImportDraft(null);
      setAddUpdateResult(result);
      showToast(`✅ 상품관리 최초 등록 ${result.counts.createCount.toLocaleString()}건 완료`);
    } catch (error) {
      console.error(error);
      const latestMaster = await loadMasterLocal().catch(() => ({}));
      setMasterProducts(latestMaster);
      setInitialImportDraft(null);
      showToast(`❌ 최초 등록 실패: ${error.message}`);
    } finally {
      setIsProcessing(false);
      setProcessMsg('');
    }
  };
  const handleSaveProduct = async (input, {
    isEditing
  } = {}) => {
    setIsProcessing(true);
    setProcessMsg(isEditing ? '상품 수정 내용을 공식 이력과 함께 저장 중...' : '신규 상품을 공식 이력과 함께 저장 중...');
    try {
      const result = await window.ONEAPP_MASTER_ADD_UPDATE.commitSingleProductChange({
        item: input,
        isEditing,
        expectedRevision: masterPageRevision,
        storage: window.ONEAPP?.STORAGE,
        historyApi: window.ONEAPP?.HISTORY,
        localStorageRef: window.localStorage,
        actor: null
      });
      masterPageRevision = result.revision;
      setMasterProducts(result.masterMap);
      setEditingProduct(null);
      setAddUpdateResult(result);
      showToast(`✅ [${result.item.품목명}] ${isEditing ? '수정' : '등록'} 완료`);
    } catch (error) {
      console.error(error);
      if (error?.code === 'MERCH_MASTER_REVISION_CONFLICT') {
        const latestMaster = await loadMasterLocal();
        setMasterProducts(latestMaster);
        throw new Error('입력 중 master가 변경되어 저장을 중단했습니다. 최신 데이터에서 다시 시도하세요.');
      }
      throw error;
    } finally {
      setIsProcessing(false);
      setProcessMsg('');
    }
  };
  const handleChangeAddUpdateAnalysis = nextAnalysis => {
    setAddUpdateAnalysis(nextAnalysis);
    setAddUpdatePreview(null);
  };
  const handlePrepareBulkApply = async () => {
    if (!addUpdateAnalysis || !window.ONEAPP_MASTER_ADD_UPDATE) return;
    setIsProcessing(true);
    setProcessMsg('저장 전 일괄 승인과 적용 예정 결과를 계산 중...');
    setAddUpdateError('');
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const prepared = window.ONEAPP_MASTER_ADD_UPDATE.prepareBulkApproval(addUpdateAnalysis);
      const preview = window.ONEAPP_MASTER_ADD_UPDATE.buildExecutionPreview(prepared.analysis, masterProducts);
      setAddUpdateAnalysis(prepared.analysis);
      setAddUpdatePreview({
        counts: preview.counts,
        analysis: prepared.analysis
      });
      showToast(`✅ 일괄 승인 준비 ${prepared.counts.approvedCount.toLocaleString()}건 · 상품 제외 ${prepared.counts.excludedCount.toLocaleString()}건 · 차단 ${prepared.counts.blockedCount.toLocaleString()}건`);
    } catch (error) {
      setAddUpdatePreview(null);
      setAddUpdateError(`전체 일괄 적용 준비 실패: ${error.message}`);
    } finally {
      setIsProcessing(false);
      setProcessMsg('');
    }
  };
  const handleSaveAddUpdate = async (analysisToSave = addUpdateAnalysis) => {
    if (!analysisToSave || !window.ONEAPP_MASTER_ADD_UPDATE) return;
    setIsProcessing(true);
    setProcessMsg('7단계 승인 항목을 master·history에 저장하고 재검증 중...');
    setAddUpdateError('');
    try {
      const result = await window.ONEAPP_MASTER_ADD_UPDATE.commitApprovedChanges({
        analysis: analysisToSave,
        currentMaster: masterProducts,
        expectedRevision: analysisToSave.baseRevision,
        storage: window.ONEAPP?.STORAGE,
        historyApi: window.ONEAPP?.HISTORY,
        localStorageRef: window.localStorage,
        actor: null,
        allowEmptyMaster: analysisToSave.allowEmptyMaster === true
      });
      masterPageRevision = result.revision;
      setMasterProducts(result.masterMap);
      try {
        localStorage.setItem(STORAGE_KEYS.SYNC_TRIGGER, Date.now().toString());
      } catch (e) {}
      setAddUpdateResult(result);
      setAddUpdateAnalysis(null);
      setAddUpdatePreview(null);
      setShowAddUpdateReview(false);
      setShowAddUpdateConfirm(false);
    } catch (error) {
      console.error(error);
      if (error?.code === 'MERCH_MASTER_REVISION_CONFLICT') {
        try {
          const latest = await window.ONEAPP.STORAGE.readMasterSnapshotState();
          masterPageRevision = latest.revision;
          setMasterProducts(latest.masterMap);
          const refreshed = window.ONEAPP_MASTER_ADD_UPDATE.analyzeUploadRows({
            headers: analysisToSave.headers,
            rows: analysisToSave.rows,
            currentMaster: latest.masterMap,
            revision: latest.revision,
            fileName: analysisToSave.fileName,
            masterMismatch: true,
            allowEmptyMaster: analysisToSave.allowEmptyMaster === true
          });
          setAddUpdateAnalysis(refreshed);
          setAddUpdatePreview(null);
          setShowAddUpdateReview(true);
          setAddUpdateError('비교 이후 master가 변경되어 저장을 차단했습니다. 최신 master 기준으로 비교를 다시 만들었고 이전 승인 상태는 모두 폐기했습니다.');
        } catch (reloadError) {
          if (reloadError?.code === 'MASTER_ADD_UPDATE_INITIAL_REGISTRATION_REQUIRED') {
            setAddUpdateAnalysis(null);
            setShowAddUpdateReview(false);
            setShowAddUpdateConfirm(false);
            setAddUpdateError(`revision 충돌 후 최신 master가 0건으로 확인되어 추가·갱신을 중단했습니다. ${reloadError.message}`);
          } else {
            setAddUpdateError(`revision 충돌 후 최신 master 재조회에도 실패했습니다: ${reloadError.message}`);
          }
        }
      } else if (error?.code === 'MASTER_ADD_UPDATE_INITIAL_REGISTRATION_REQUIRED') {
        setAddUpdateAnalysis(null);
        setAddUpdatePreview(null);
        setShowAddUpdateReview(false);
        setShowAddUpdateConfirm(false);
        setAddUpdateError(error.message);
        try {
          const restored = await loadMasterLocal();
          setMasterProducts(restored);
        } catch (reloadError) {
          setAddUpdateError(`${error.message} / master 상태 재조회 실패: ${reloadError.message}`);
        }
      } else {
        setAddUpdateError(error.message);
        try {
          const restored = await loadMasterLocal();
          setMasterProducts(restored);
        } catch (reloadError) {
          setAddUpdateError(`${error.message} / rollback 상태 재조회 실패: ${reloadError.message}`);
        }
      }
    } finally {
      setIsProcessing(false);
      setProcessMsg('');
    }
  };

  // [M-CLOUD-01] MerchOps 공통 클라우드 Push
  const handlePush = async () => {
    const targetUrl = getOneAppCloudSyncUrl(config.cloudUrl);
    if (!targetUrl) return showToast("⚠️ 클라우드 URL 설정 필요");
    setIsProcessing(true);
    setProcessMsg("MerchOps 클라우드 전송 중...");
    try {
      const result = await pushMerchOpsCloudMaster(masterProducts, {
        cloudUrl: targetUrl,
        onProgress: msg => setProcessMsg(msg)
      });
      showToast(`✅ MerchOps 클라우드 백업 완료! 마스터 ${result.count.toLocaleString()}건`);
    } catch (e) {
      console.error(e);
      showToast("❌ 실패: " + e.message);
    } finally {
      setIsProcessing(false);
      setProcessMsg("");
    }
  };

  // [M-CLOUD-02] MerchOps 공통 클라우드 Pull
  const handlePull = async () => {
    const targetUrl = getOneAppCloudSyncUrl(config.cloudUrl);
    if (!targetUrl) return showToast("⚠️ 클라우드 URL 설정 필요");
    setIsProcessing(true);
    setProcessMsg("MerchOps 클라우드 수신 중...");
    try {
      const result = await pullMerchOpsCloudMaster(targetUrl);
      setMasterProducts(result.masterMap);
      showToast(`✅ MerchOps 클라우드 동기화 완료: ${result.count.toLocaleString()}건`);
    } catch (e) {
      console.error(e);
      showToast("❌ 실패: " + e.message);
    } finally {
      setIsProcessing(false);
      setProcessMsg("");
    }
  };

  // 💡 safeStr을 적용하여 숫자 데이터로 인한 에러 방어 및 카테고리 로직 복구
  const c1List = useMemo(() => {
    const map = new Map();
    Object.values(masterProducts || {}).forEach(p => {
      if (!p) return;
      const code = safeStr(p['1코드'], 'etc');
      const name = safeStr(p['1그룹명'], '미분류');
      if (!map.has(code)) map.set(code, name);
    });
    return Array.from(map.entries()).map(([code, name]) => ({
      code,
      name
    })).sort((a, b) => a.code.localeCompare(b.code));
  }, [masterProducts]);
  const c2List = useMemo(() => {
    if (!activeC1) return [];
    const map = new Map();
    Object.values(masterProducts || {}).forEach(p => {
      if (!p) return;
      if (safeStr(p['1코드'], 'etc') === activeC1) {
        const code = safeStr(p['2코드'], 'etc');
        const name = safeStr(p['2그룹명'], '미분류');
        if (!map.has(code)) map.set(code, name);
      }
    });
    return Array.from(map.entries()).map(([code, name]) => ({
      code,
      name
    })).sort((a, b) => a.code.localeCompare(b.code));
  }, [masterProducts, activeC1]);
  const c3List = useMemo(() => {
    if (!activeC1 || !activeC2) return [];
    const map = new Map();
    Object.values(masterProducts || {}).forEach(p => {
      if (!p) return;
      if (safeStr(p['1코드'], 'etc') === activeC1 && safeStr(p['2코드'], 'etc') === activeC2) {
        const code = safeStr(p['3코드'] || p['오더즈'], 'etc');
        const name = safeStr(p['3그룹명'], '미분류');
        if (!map.has(code)) map.set(code, {
          code,
          name,
          count: 0
        });
        map.get(code).count++;
      }
    });
    return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [masterProducts, activeC1, activeC2]);

  // 💡 [핵심] 하위 카테고리 자동 선택 로직 (이게 없으면 상품이 안 나옴)
  useEffect(() => {
    if (c1List.length > 0 && !c1List.find(c => c.code === activeC1)) setActiveC1(c1List[0].code);
  }, [c1List, activeC1]);
  useEffect(() => {
    if (c2List.length > 0 && !c2List.find(c => c.code === activeC2)) setActiveC2(c2List[0].code);else if (c2List.length === 0) setActiveC2('');
  }, [c2List, activeC2]);
  useEffect(() => {
    if (c3List.length > 0 && !c3List.find(c => c.code === activeC3)) setActiveC3(c3List[0].code);else if (c3List.length === 0) setActiveC3('');
  }, [c3List, activeC3]);
  const displayRows = useMemo(() => {
    const arr = Object.values(masterProducts || {}).filter(p => p);
    if (globalSearch.trim()) {
      const kw = globalSearch.toLowerCase().replace(/\s+/g, '');
      return arr.filter(item => {
        const target = (safeStr(item['코드']) + safeStr(item['품목코드']) + safeStr(item['품목명']) + safeStr(item['규격']) + safeStr(item['행사테마'])).toLowerCase();
        return target.includes(kw);
      }).slice(0, 500);
    }
    if (activeC3) {
      return arr.filter(p => safeStr(p['1코드'], 'etc') === activeC1 && safeStr(p['2코드'], 'etc') === activeC2 && safeStr(p['3코드'] || p['오더즈'], 'etc') === activeC3).slice(0, 500);
    }
    return [];
  }, [masterProducts, globalSearch, activeC1, activeC2, activeC3]);
  const selectedProduct = useMemo(() => {
    if (!selectedProductCode) return null;
    return Object.values(masterProducts || {}).find(item => safeStr(item?.코드 || item?.품목코드) === selectedProductCode) || null;
  }, [masterProducts, selectedProductCode]);
  const setProductResultVisibility = useCallback(open => {
    setProductResultOpen(open);
    try {
      sessionStorage.setItem('nexus:master:right-panel:v1', open ? 'open' : 'closed');
    } catch {}
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "w-full flex flex-col font-sans overflow-hidden bg-slate-100 relative select-none",
    style: {
      height: 'calc(100vh - var(--nexus-ui-header-height, 64px))'
    }
  }, /*#__PURE__*/React.createElement(AppHeader, {
    itemCount: Object.keys(masterProducts).length,
    isProcessing: isProcessing,
    processMsg: processMsg,
    onOpenSettings: () => setShowSettingsModal(true)
  }), toastMsg && /*#__PURE__*/React.createElement("div", {
    className: "fixed bottom-10 right-10 z-[100] bg-slate-900 text-white px-6 py-3 rounded-xl shadow-2xl flex items-center gap-3 fade-in border border-slate-700"
  }, /*#__PURE__*/React.createElement(SafeIcon, {
    name: "check-circle-2",
    size: 18,
    className: "text-emerald-400"
  }), /*#__PURE__*/React.createElement("span", {
    className: "text-sm font-bold tracking-tight"
  }, toastMsg)), /*#__PURE__*/React.createElement(InitialImportConfirmModal, {
    draft: initialImportDraft,
    onSave: handleSaveInitialImport,
    onCancel: () => setInitialImportDraft(null),
    isSaving: isProcessing
  }), /*#__PURE__*/React.createElement(ProductEditorModal, {
    item: editingProduct,
    masterProducts: masterProducts,
    onCancel: () => setEditingProduct(null),
    onSave: handleSaveProduct,
    isSaving: isProcessing
  }), /*#__PURE__*/React.createElement(ProductRequestReviewModal, {
    entry: selectedChangeRequest,
    masterProducts: masterProducts,
    onClose: () => setSelectedChangeRequest(null),
    onApply: handleApplyChangeRequest,
    onLink: handleLinkChangeRequest,
    onReject: handleRejectChangeRequest,
    isProcessing: isProcessing
  }), showAddUpdateConfirm && /*#__PURE__*/React.createElement(MasterAddUpdateConfirmModal, {
    analysis: addUpdateAnalysis,
    onReview: () => {
      setShowAddUpdateConfirm(false);
      setShowAddUpdateReview(true);
    },
    onCancel: discardAddUpdateAnalysis,
    onDiscard: discardAddUpdateAnalysis
  }), showAddUpdateReview && /*#__PURE__*/React.createElement(MasterAddUpdateReview, {
    analysis: addUpdateAnalysis,
    onChange: handleChangeAddUpdateAnalysis,
    onClose: () => setShowAddUpdateReview(false),
    onDiscard: discardAddUpdateAnalysis,
    onBulkApply: handlePrepareBulkApply,
    isSaving: isProcessing,
    errorMessage: addUpdateError
  }), /*#__PURE__*/React.createElement(MasterAddUpdatePreviewModal, {
    preview: addUpdatePreview,
    onBack: () => setAddUpdatePreview(null),
    onSave: () => handleSaveAddUpdate(addUpdatePreview?.analysis),
    isSaving: isProcessing
  }), /*#__PURE__*/React.createElement(MasterAddUpdateResultModal, {
    result: addUpdateResult,
    onClose: () => setAddUpdateResult(null)
  }), /*#__PURE__*/React.createElement("main", {
    className: "w-full max-w-[1440px] mx-auto flex-1 flex flex-col overflow-hidden bg-slate-50 border-x border-slate-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "min-h-[50px] px-3 sm:px-6 py-2 bg-white border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 shrink-0 z-10 shadow-sm"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-full lg:w-auto flex flex-wrap items-center gap-2 sm:gap-4"
  }, /*#__PURE__*/React.createElement("strong", {
    className: "text-[12px] text-slate-700"
  }, "\uC0C1\uD488 \uC870\uD68C"), Object.keys(masterProducts).length === 0 && /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5"
  }, "\uC0C1\uD488 DB\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4. Excel \uCD5C\uCD08 \uB4F1\uB85D \uB610\uB294 \uC0C1\uD488 \uB2E8\uAC74 \uB4F1\uB85D\uC73C\uB85C \uC2DC\uC791\uD558\uC138\uC694")), /*#__PURE__*/React.createElement("div", {
    className: "w-full lg:w-auto grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 min-w-0"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setEditingProduct({}),
    disabled: isProcessing,
    className: "w-full sm:w-auto h-9 px-3 sm:px-4 rounded-lg text-[12px] font-bold bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-300 shadow-sm flex items-center justify-center"
  }, /*#__PURE__*/React.createElement(SafeIcon, {
    name: "plus",
    size: 13,
    className: "mr-2"
  }), " \uC0C1\uD488 \uB4F1\uB85D"), /*#__PURE__*/React.createElement("label", {
    className: `w-full sm:w-auto h-9 px-3 sm:px-4 rounded-lg text-[12px] font-bold border transition-colors flex items-center justify-center shadow-sm ${isProcessing ? 'cursor-not-allowed bg-slate-100 text-slate-400 border-slate-200' : 'cursor-pointer bg-white text-slate-700 hover:bg-slate-100 border-slate-300'}`
  }, /*#__PURE__*/React.createElement(SafeIcon, {
    name: "upload",
    size: 14,
    className: "mr-2 text-slate-500"
  }), " ", Object.keys(masterProducts).length === 0 ? '최초 등록 Excel' : '1. 정보수정 Excel', /*#__PURE__*/React.createElement("input", {
    type: "file",
    className: "hidden",
    accept: ".xlsx,.xls",
    onChange: handleExcelUpload,
    disabled: isProcessing
  })), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: openSkuManagement,
    disabled: isProcessing,
    className: "w-full sm:w-auto h-9 px-3 sm:px-4 rounded-lg text-[12px] font-bold border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
  }, "SKU \uAD00\uB9AC"), addUpdateAnalysis && !showAddUpdateConfirm && !showAddUpdateReview && /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowAddUpdateReview(true),
    className: "h-9 px-4 rounded-lg text-[12px] font-black bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm"
  }, "\uAC80\uD1A0 \uC774\uC5B4\uBCF4\uAE30"), /*#__PURE__*/React.createElement("div", {
    className: "relative col-span-2 w-full sm:w-64 h-9 sm:ml-2"
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    placeholder: "\uB9C8\uC2A4\uD130 DB \uAC80\uC0C9...",
    value: globalSearch,
    onChange: e => setGlobalSearch(e.target.value),
    className: "w-full h-full pl-9 pr-4 bg-slate-100 border-none rounded-lg text-[13px] outline-none focus:ring-1 focus:ring-indigo-400 transition-all shadow-inner"
  }), /*#__PURE__*/React.createElement(SafeIcon, {
    name: "search",
    size: 14,
    className: "absolute left-3 top-2.5 text-slate-400 pointer-events-none"
  })))), legacyState.status === 'ready' && legacySummary.total > 0 && /*#__PURE__*/React.createElement("div", {
    className: "px-3 sm:px-6 py-3 bg-amber-50 border-b border-amber-200 flex flex-col lg:flex-row lg:items-center gap-3 shrink-0",
    "data-legacy-itemmaster-notice": "ready"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex-1 min-w-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-xs font-black text-amber-900"
  }, "\uC774 \uBE0C\uB77C\uC6B0\uC800\uC5D0\uC11C \uD3D0\uAE30\uB41C ItemMaster \uACA9\uB9AC DB \uB370\uC774\uD130 ", legacySummary.total.toLocaleString(), "\uAC74\uC744 \uCC3E\uC558\uC2B5\uB2C8\uB2E4."), /*#__PURE__*/React.createElement("div", {
    className: "text-[11px] text-amber-800 mt-1"
  }, "\uC2E0\uADDC ", legacySummary.newCount.toLocaleString(), "\uAC74 \xB7 \uB3D9\uC77C ", legacySummary.sameCount.toLocaleString(), "\uAC74 \xB7 \uCDA9\uB3CC ", legacySummary.conflictCount.toLocaleString(), "\uAC74. \uC790\uB3D9 \uBC18\uC601\xB7\uB36E\uC5B4\uC4F0\uAE30\xB7\uC0AD\uC81C\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: downloadLegacyBackup,
    className: "h-8 px-3 rounded-lg border border-amber-300 bg-white text-amber-900 text-[11px] font-bold hover:bg-amber-100"
  }, "JSON \uBC31\uC5C5"), /*#__PURE__*/React.createElement("button", {
    onClick: startLegacyReview,
    disabled: isProcessing,
    className: "h-8 px-3 rounded-lg bg-amber-700 text-white text-[11px] font-black hover:bg-amber-800 disabled:bg-slate-400"
  }, "\uC815\uBCF4\uC218\uC815 Excel \uAC80\uD1A0"))), legacyState.status === 'error' && legacyState.exists && /*#__PURE__*/React.createElement("div", {
    className: "px-3 sm:px-6 py-2 bg-rose-50 border-b border-rose-200 text-[11px] font-bold text-rose-800 shrink-0",
    "data-legacy-itemmaster-notice": "error"
  }, "\uB808\uAC70\uC2DC ItemMaster \uACA9\uB9AC DB\uAC00 \uC874\uC7AC\uD558\uC9C0\uB9CC \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uC6D0\uBCF8\uC740 \uBCC0\uACBD\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: ", legacyState.error), /*#__PURE__*/React.createElement("section", {
    className: "px-3 sm:px-6 py-3 bg-white border-b border-slate-200 shrink-0",
    "data-product-change-request-inbox": changeRequestInbox.status
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col sm:flex-row sm:items-center gap-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex-1 min-w-0"
  }, /*#__PURE__*/React.createElement("div", {
    className: "text-[12px] font-black text-slate-800"
  }, "\uC2E0\uADDC \uC0C1\uD488 \uB4F1\uB85D \uC694\uCCAD ", (changeRequestInbox.requests || []).filter(entry => entry.request?.operation === 'CREATE').length.toLocaleString(), "\uAC74 \xB7 \uC0C1\uD488\uC815\uBCF4 \uC218\uC815 \uC694\uCCAD ", (changeRequestInbox.requests || []).filter(entry => entry.request?.operation !== 'CREATE').length.toLocaleString(), "\uAC74"), /*#__PURE__*/React.createElement("div", {
    className: `text-[10px] mt-0.5 ${changeRequestInbox.status === 'ERROR' || changeRequestInbox.status === 'NOT_AVAILABLE' ? 'text-rose-700' : 'text-slate-500'}`
  }, changeRequestInbox.status === 'READY' ? '관리자가 원본과 반영 예정값을 확인한 뒤 처리합니다.' : changeRequestInbox.status === 'EMPTY' ? '접수된 요청이 없습니다.' : changeRequestInbox.status === 'LOADING' ? '요청 확인 중' : `요청함 확인 실패: ${changeRequestInbox.error?.code || changeRequestInbox.status}`)), (changeRequestInbox.requests || []).some(entry => entry.request?.operation === 'CREATE') && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: handleRegisterAllCreateRequests,
    disabled: isProcessing,
    className: "h-9 px-5 rounded-lg bg-indigo-600 text-white text-[11px] font-black shadow-md hover:bg-indigo-700 disabled:bg-slate-400 whitespace-nowrap"
  }, "\uC804\uCCB4 \uB4F1\uB85D")), (changeRequestInbox.requests || []).length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "mt-3 max-h-52 overflow-auto rounded-lg border border-slate-200",
    "aria-label": "\uC0C1\uD488 \uB4F1\uB85D\xB7\uC218\uC815 \uC694\uCCAD \uBAA9\uB85D"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full min-w-[860px] text-[11px] text-left"
  }, /*#__PURE__*/React.createElement("thead", {
    className: "sticky top-0 z-10 bg-slate-100 text-slate-600 border-b border-slate-200"
  }, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 font-black w-36"
  }, "\uC694\uCCAD \uAD6C\uBD84"), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 font-black"
  }, "\uD488\uBAA9\uBA85"), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 font-black w-32"
  }, "\uADDC\uACA9"), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 font-black w-24"
  }, "\uB2E8\uC704"), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 font-black w-44"
  }, "\uC694\uCCAD\uC790\xB7\uCD9C\uCC98"), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 font-black w-24"
  }, "\uC0C1\uD0DC"), /*#__PURE__*/React.createElement("th", {
    className: "px-3 py-2 font-black text-center w-20"
  }, "\uAD00\uB9AC"))), /*#__PURE__*/React.createElement("tbody", {
    className: "divide-y divide-slate-100 bg-white"
  }, changeRequestInbox.requests.map(entry => /*#__PURE__*/React.createElement("tr", {
    key: `${entry.request?.requestId}-${entry.receivedAt}`,
    className: "hover:bg-amber-50/60"
  }, /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-black text-amber-900"
  }, requestTypeLabel(entry)), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 font-bold text-slate-800"
  }, entry.request?.changes?.find(change => change.field === '품목명')?.proposedValue || entry.request?.entityId || '-', entry.repeatedRequestCount > 1 && /*#__PURE__*/React.createElement("span", {
    className: "ml-2 inline-flex px-2 py-0.5 rounded-full bg-slate-100 text-[10px] text-slate-600"
  }, "\uB3D9\uC77C \uC694\uCCAD ", entry.repeatedRequestCount, "\uD68C")), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 text-slate-600"
  }, entry.request?.changes?.find(change => change.field === '규격')?.proposedValue || '-'), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 text-slate-600"
  }, entry.request?.changes?.find(change => change.field === '단위')?.proposedValue || '-'), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 text-slate-600"
  }, /*#__PURE__*/React.createElement("div", {
    className: "truncate"
  }, entry.request?.actor?.actorName || '요청자 미확인', " \xB7 ", requestSourceLabel(entry))), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: `inline-flex px-2 py-1 rounded-full font-black ${entry.status === 'IN_REVIEW' ? 'bg-indigo-50 text-indigo-700' : 'bg-amber-50 text-amber-800'}`
  }, entry.status === 'IN_REVIEW' ? '검토 중' : '검토 대기')), /*#__PURE__*/React.createElement("td", {
    className: "px-3 py-2 text-center"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => openChangeRequest(entry),
    className: "h-7 px-3 rounded-md bg-white border border-indigo-300 text-indigo-700 font-black hover:bg-indigo-50"
  }, "\uC218\uC815")))))))), /*#__PURE__*/React.createElement("div", {
    className: "flex items-end px-4 pt-3 border-b border-slate-200 bg-slate-200/50 shrink-0 h-[50px]"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex overflow-x-auto custom-scrollbar h-full items-end w-full gap-1"
  }, c1List.map(c1 => /*#__PURE__*/React.createElement("button", {
    key: c1.code,
    onClick: () => {
      setActiveC1(c1.code);
      setActiveC2('');
      setActiveC3('');
      setGlobalSearch('');
    },
    className: `px-5 py-2.5 text-[13px] font-bold rounded-t-lg transition-colors border-b-[3px] ${activeC1 === c1.code ? 'border-indigo-600 text-indigo-700 bg-white shadow-[0_-2px_5px_rgba(0,0,0,0.02)] z-10' : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-300/50'}`
  }, c1.name)))), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 flex overflow-hidden relative",
    "data-nexus-workspace": "master-lookup"
  }, /*#__PURE__*/React.createElement("aside", {
    className: "min-w-0 flex shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white p-3",
    "data-nexus-pane": "reference",
    "aria-label": "\uC120\uD0DD \uC0C1\uD488 \uAE30\uC900\uC815\uBCF4"
  }, /*#__PURE__*/React.createElement("span", {
    className: "text-[9px] font-black tracking-[0.16em] text-indigo-600"
  }, "REFERENCE"), /*#__PURE__*/React.createElement("h2", {
    className: "mt-1 text-[13px] font-black text-slate-800"
  }, "\uC120\uD0DD \uC0C1\uD488 \uCC38\uACE0"), /*#__PURE__*/React.createElement("div", {
    className: "mt-3 space-y-2",
    "data-nexus-selection-reference": true
  }, /*#__PURE__*/React.createElement("p", {
    className: "rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-500"
  }, "\uC911\uC559 \uBAA9\uB85D\uC5D0\uC11C \uC0C1\uD488\uC744 \uC120\uD0DD\uD558\uBA74 \uD575\uC2EC \uAE30\uC900\uC815\uBCF4\uAC00 \uACE0\uC815 \uD45C\uC2DC\uB429\uB2C8\uB2E4."))), /*#__PURE__*/React.createElement("section", {
    className: "flex-1 min-w-0 bg-white flex flex-col overflow-hidden relative z-0",
    "data-nexus-pane": "work",
    "aria-label": "\uC0C1\uD488 \uBAA9\uB85D \uC791\uC5C5\uD45C"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid max-h-[190px] shrink-0 grid-cols-[180px_minmax(220px,1fr)] overflow-hidden border-b border-slate-200 bg-slate-50"
  }, /*#__PURE__*/React.createElement("div", {
    className: "overflow-y-auto border-r border-slate-200 bg-white py-2 custom-scrollbar"
  }, c2List.map(c2 => /*#__PURE__*/React.createElement("button", {
    key: c2.code,
    onClick: () => {
      setActiveC2(c2.code);
      setActiveC3('');
      setGlobalSearch('');
    },
    className: `w-full text-left px-5 py-2.5 text-[12px] font-bold transition-all border-l-4 ${activeC2 === c2.code ? 'bg-indigo-50/50 text-indigo-700 border-indigo-600' : 'border-transparent text-slate-600 hover:bg-slate-50'}`
  }, c2.name))), /*#__PURE__*/React.createElement("div", {
    className: "flex min-w-0 flex-col overflow-hidden"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 shrink-0"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-[12px] font-black text-slate-800"
  }, "\uC18C\uBD84\uB958 (3\uCC28)"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: handlePull,
    className: "h-8 rounded-lg border border-indigo-200 bg-indigo-50 px-3 text-[11px] font-black text-indigo-700 hover:bg-indigo-100"
  }, /*#__PURE__*/React.createElement(SafeIcon, {
    name: "cloud-download",
    size: 12,
    className: "mr-1"
  }), " \uB370\uC774\uD130 \uBD88\uB7EC\uC624\uAE30")), /*#__PURE__*/React.createElement("div", {
    className: "grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1 overflow-y-auto p-2 custom-scrollbar"
  }, c3List.map(c3 => /*#__PURE__*/React.createElement("button", {
    key: c3.code,
    onClick: () => {
      setActiveC3(c3.code);
      setGlobalSearch('');
    },
    className: `min-w-0 text-left px-3 py-2 rounded-md text-[12px] font-bold transition-all flex justify-between items-center ${activeC3 === c3.code ? 'bg-white text-indigo-700 border border-indigo-200 shadow-sm' : 'border border-transparent text-slate-600 hover:bg-white hover:border-slate-200'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "truncate pr-2"
  }, c3.name), /*#__PURE__*/React.createElement("span", {
    className: `text-[10px] px-1.5 py-0.5 rounded-full ${activeC3 === c3.code ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200 text-slate-500'}`
  }, c3.count)))))), globalSearch ? /*#__PURE__*/React.createElement("div", {
    className: "px-4 py-2 bg-amber-50 border-b border-amber-200 text-[12px] font-bold text-amber-800 flex items-center shrink-0"
  }, /*#__PURE__*/React.createElement("i", {
    className: "fas fa-search mr-2 text-amber-500"
  }), " \uC804\uCCB4 \uAC80\uC0C9 \uACB0\uACFC\uC785\uB2C8\uB2E4.") : /*#__PURE__*/React.createElement("div", {
    className: "px-4 py-2 bg-indigo-50/50 border-b border-indigo-100 text-[12px] font-bold text-indigo-800 flex justify-between items-center shrink-0"
  }, /*#__PURE__*/React.createElement("span", null, c1List.find(c => c.code === activeC1)?.name || '선택안됨', " ", /*#__PURE__*/React.createElement("i", {
    className: "fas fa-chevron-right mx-1 text-[10px] text-indigo-300"
  }), c2List.find(c => c.code === activeC2)?.name || '선택안됨', " ", /*#__PURE__*/React.createElement("i", {
    className: "fas fa-chevron-right mx-1 text-[10px] text-indigo-300"
  }), c3List.find(c => c.code === activeC3)?.name || '선택안됨'), /*#__PURE__*/React.createElement("span", {
    className: "text-slate-500 font-medium"
  }, "\uCD1D ", displayRows.length, "\uAC74 \uD45C\uC2DC\uB428")), /*#__PURE__*/React.createElement("div", {
    ref: productTableScrollRef,
    className: "flex-1 overflow-auto custom-scrollbar relative"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-max min-w-full text-left text-[11px] whitespace-nowrap border-separate border-spacing-0",
    "aria-label": "\uC0C1\uD488\uAD00\uB9AC Excel\uD615 \uBAA9\uB85D"
  }, /*#__PURE__*/React.createElement("thead", {
    className: "bg-slate-50 sticky top-0 z-10 border-b border-slate-200 shadow-sm"
  }, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    className: "sticky left-0 z-20 py-2 px-2 w-12 min-w-[48px] text-center text-slate-500 bg-slate-100 border-r border-b border-slate-200"
  }, "\uD589"), /*#__PURE__*/React.createElement("th", {
    className: "py-2.5 px-4 w-20 text-slate-600"
  }, "\uCF54\uB4DC"), /*#__PURE__*/React.createElement("th", {
    className: "py-2.5 px-4 text-slate-600"
  }, "\uD488\uBAA9\uBA85"), /*#__PURE__*/React.createElement("th", {
    className: "py-2.5 px-3 text-slate-600"
  }, "\uADDC\uACA9"), visMasterCols.map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    className: "py-2.5 px-3 text-slate-600"
  }, h)), /*#__PURE__*/React.createElement("th", {
    className: "py-2.5 px-3 text-slate-600 w-20"
  }, "\uAD00\uB9AC"))), /*#__PURE__*/React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, displayRows.length > 0 ? displayRows.map((row, idx) => {
    const code = safeStr(row['코드'] || row['품목코드'], `key-${idx}`);
    return /*#__PURE__*/React.createElement("tr", {
      key: code,
      onClick: () => setSelectedProductCode(code),
      className: `cursor-pointer transition-colors ${selectedProductCode === code ? 'bg-indigo-50' : 'hover:bg-slate-50'}`
    }, /*#__PURE__*/React.createElement("td", {
      className: "sticky left-0 z-[1] py-2 px-2 text-center text-slate-500 bg-slate-50 border-r border-b border-slate-200"
    }, idx + 1), /*#__PURE__*/React.createElement("td", {
      className: "py-2 px-4 font-mono text-slate-400"
    }, safeStr(row['코드'] || row['품목코드'], '-')), /*#__PURE__*/React.createElement("td", {
      className: "py-2 px-4 font-bold"
    }, safeStr(row['품목명'], '-')), /*#__PURE__*/React.createElement("td", {
      className: "py-2 px-3 text-slate-500"
    }, safeStr(row['규격'], '-')), visMasterCols.map(h => /*#__PURE__*/React.createElement("td", {
      key: h,
      className: "py-2 px-3 text-slate-500"
    }, safeStr(row[h], '-'))), /*#__PURE__*/React.createElement("td", {
      className: "py-2 px-3"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingProduct(row),
      className: "h-7 px-3 rounded-md border border-slate-300 text-[11px] font-bold text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-300"
    }, /*#__PURE__*/React.createElement(SafeIcon, {
      name: "edit",
      size: 11,
      className: "mr-1"
    }), " \uC218\uC815")));
  }) : /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: visMasterCols.length + 5,
    className: "py-20 text-center text-slate-400"
  }, Object.keys(masterProducts).length === 0 ? '상품 DB가 비어 있습니다. 상단의 Excel 최초 등록 또는 상품 등록을 사용하세요.' : '해당 카테고리에 데이터가 없거나 검색 결과가 없습니다.'))))), /*#__PURE__*/React.createElement("div", {
    className: "shrink-0 flex items-center justify-center gap-2 px-4 py-3 border-t-2 border-slate-300 bg-white shadow-[0_-8px_18px_rgba(15,23,42,0.08)]",
    "data-nexus-completion-bar": "master-lookup"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: handlePush,
    disabled: isProcessing || Object.keys(masterProducts).length === 0,
    className: "h-9 px-4 rounded-lg bg-indigo-600 text-white text-[11px] font-black hover:bg-indigo-700 disabled:opacity-40"
  }, /*#__PURE__*/React.createElement(SafeIcon, {
    name: "cloud-upload",
    size: 12,
    className: "mr-1"
  }), " \uB370\uC774\uD130 \uBC31\uC5C5"))), productResultOpen ? /*#__PURE__*/React.createElement("aside", {
    className: "flex min-w-0 shrink-0 bg-white border-l border-slate-200 flex-col overflow-hidden",
    "data-nexus-pane": "result",
    "aria-label": "\uC120\uD0DD \uC0C1\uD488 \uACB0\uACFC"
  }, /*#__PURE__*/React.createElement("div", {
    className: "h-11 px-3 flex items-center justify-between border-b border-slate-200 bg-slate-50 shrink-0"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "block text-[9px] font-black tracking-widest text-indigo-600"
  }, "RESULT"), /*#__PURE__*/React.createElement("strong", {
    className: "block text-[12px] text-slate-800"
  }, "\uCC98\uB9AC \uACB0\uACFC\xB7\uB2E4\uC74C \uB2E8\uACC4")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setProductResultVisibility(false),
    className: "w-7 h-7 rounded-md border border-slate-300 bg-white text-slate-500",
    "aria-label": "\uC120\uD0DD \uC0C1\uD488 \uACB0\uACFC \uB2EB\uAE30"
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    className: "flex-1 overflow-y-auto p-3 space-y-2 text-[11px]"
  }, selectedProduct ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "p-3 rounded-lg border border-slate-200 bg-slate-50"
  }, /*#__PURE__*/React.createElement("span", {
    className: "block text-[9px] font-bold text-slate-400 mb-1"
  }, "\uC0C1\uD488"), /*#__PURE__*/React.createElement("strong", {
    className: "block text-[13px] text-slate-800 break-words"
  }, safeStr(selectedProduct['품목명'], '-')), /*#__PURE__*/React.createElement("span", {
    className: "font-mono text-slate-500"
  }, safeStr(selectedProduct['코드'] || selectedProduct['품목코드'], '-'))), /*#__PURE__*/React.createElement("div", {
    className: "p-3 rounded-lg border border-slate-200 bg-slate-50"
  }, /*#__PURE__*/React.createElement("span", {
    className: "block text-[9px] font-bold text-slate-400 mb-1"
  }, "\uADDC\uACA9\xB7\uB2E8\uC704"), /*#__PURE__*/React.createElement("strong", null, safeStr(selectedProduct['규격'], '-'), " \xB7 ", safeStr(selectedProduct['단위'], '-'))), /*#__PURE__*/React.createElement("div", {
    className: "p-3 rounded-lg border border-slate-200 bg-slate-50"
  }, /*#__PURE__*/React.createElement("span", {
    className: "block text-[9px] font-bold text-slate-400 mb-1"
  }, "\uB2E8\uAC00"), /*#__PURE__*/React.createElement("strong", null, "\uC785\uACE0 ", Number(selectedProduct['입고가'] || 0).toLocaleString(), " \xB7 \uCD9C\uACE0 ", Number(selectedProduct['출고가'] || 0).toLocaleString())), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => window.ONEAPP_NEXUS_NAVIGATE_ROUTE(`history_viewer.html?code=${encodeURIComponent(safeStr(selectedProduct['코드'] || selectedProduct['품목코드']))}&returnApp=master-lookup`, 'master-lookup'),
    className: "w-full h-9 rounded-lg border border-slate-300 bg-white text-slate-700 font-bold"
  }, "\uBCC0\uACBD\uC774\uB825 \uBCF4\uAE30")) : /*#__PURE__*/React.createElement("div", {
    className: "p-4 text-center text-slate-400 leading-relaxed"
  }, "\uC911\uC559 \uBAA9\uB85D\uC5D0\uC11C \uC0C1\uD488\uC744 \uC120\uD0DD\uD558\uBA74 \uC0C1\uC138 \uACB0\uACFC\uAC00 \uD45C\uC2DC\uB429\uB2C8\uB2E4.")), /*#__PURE__*/React.createElement("div", {
    className: "p-3 border-t border-slate-200"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: openSkuManagement,
    className: "w-full h-9 rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 font-black"
  }, "SKU \uAD00\uB9AC"))) : /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => setProductResultVisibility(true),
    className: "absolute right-3 top-3 z-20 h-9 px-3 rounded-lg border border-slate-300 bg-white text-[11px] font-black text-slate-700 shadow-lg",
    "data-nexus-result-reopen": "master-lookup"
  }, "\uC120\uD0DD \uC0C1\uD488 \uACB0\uACFC \uC5F4\uAE30"))), /*#__PURE__*/React.createElement(IframeSettingsModal, {
    isOpen: showSettingsModal,
    onClose: () => setShowSettingsModal(false)
  }));
}
try {
  const mountNode = document.getElementById('root');
  if (!mountNode) throw new Error('#root 요소를 찾을 수 없습니다.');
  const root = ReactDOM.createRoot(mountNode);
  // 💡 전체 앱을 ErrorBoundary로 감싸서 하얀 화면 완전 차단
  root.render(/*#__PURE__*/React.createElement(ErrorBoundary, null, /*#__PURE__*/React.createElement(App, null)));
} catch (err) {
  if (window.__showBootError) window.__showBootError('React 렌더링 초기화 실패', err && err.stack ? err.stack : String(err));else throw err;
}
