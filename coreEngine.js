/**
 * ONEAPP MerchOps - coreEngine.js
 * v1.1.0 / Client Safety
 *
 * 목적:
 * - HTML 화면 파일에서 중복되는 저장소, 가격계산, 히스토리, F9 전달, 클라우드 로직을 중앙화한다.
 * - 이 파일은 업무 판단 UI가 아니라 공통 로직 엔진이다.
 *
 * 네임스페이스:
 * - window.ONEAPP.STORAGE
 * - window.ONEAPP.PRICING
 * - window.ONEAPP.HISTORY
 * - window.ONEAPP.EXPORT
 * - window.ONEAPP.CLOUD
 *
 * v1.0.7_InfoMappingFix:
 * - 쇼핑몰 정보(info) 파일 매핑 보강: 상품코드→품목코드, 판매가격→출고가, 시중가격→시중가, 판매→판매여부, 재고→재고수량.
 * - 테마1~테마5를 내부 행사테마 값으로 정규화한다.
 * - 오더즈판매가/오더즈구매가는 입점사 전용 필드이므로 마스터 가격 필드 연결에서 제외한다.
 * - EXPORT.buildWorkingPayload의 purchase/sales 참조 누락을 수정한다.
 *
 * v1.0.9_CloudConfigSyncFix:
 * - 환경설정 전용 config_only 복원과 엄격한 JSON 응답 검증을 추가한다.
 * - AppConfig 대용량 저장을 백스크립트 분할 저장 형식과 연동하고 settingsKeys를 복구한다.
 * - 클라우드 URL 공통키와 구형키를 함께 유지해 MerchOps/환경설정/DataOps의 URL 불일치를 방지한다.
 *
 * v1.1.0_ClientSafety:
 * - 마스터 엑셀 적용 전 차단 검증을 수행하고 오류 행/중복코드가 있으면 적용하지 않는다.
 * - localStorage/IndexedDB 쓰기를 검증하며 마스터 적용 실패 시 변경 전 데이터로 자동 복구한다.
 * - 저장공간 부족, 브라우저 차단, IndexedDB 중단 오류를 사용자가 조치할 수 있는 문구로 변환한다.
 *
 * v1.0.8_PricingPolicySync:
 * - computeFinalData를 최신 MerchOps 정책에 맞게 정리한다. 엑셀 source에 없는 입고가는 마스터값으로 자동 대체하지 않는다.
 * - 구매/재고 작업의 시중가는 마스터 시중가를 참조하고, 구매/재고 원가로 시중가를 자동 산출하거나 갱신하지 않는다.
 * - 룰적용(forceRecalc)은 명시 액션으로만 출고가를 계산한다. 견적 작업만 출고가/시중가 동시 계산을 허용하고, 구매/재고는 출고가만 계산한다.
 * - 작업 source 역할(estimate/purchase/inventory/info)을 판정하는 PRICING helper를 추가한다.
 */

(function initOneAppCore(global) {
  'use strict';

  const ONEAPP = global.ONEAPP = global.ONEAPP || {};
  ONEAPP.VERSION = ONEAPP.VERSION || 'coreEngine-v1.1.0 ClientSafety';

  const DEFAULT_DB_NAME = 'MerchOpsDB';
  const DEFAULT_DB_VERSION = 2;
  const STORE_KV = 'store';
  const STORE_MASTER = 'master_products';

  const ensureHeaderAfter = (headers = [], header, afterHeader = '') => {
    const result = Array.isArray(headers) ? [...headers] : [];
    if (!header || result.includes(header)) return result;
    const afterIdx = afterHeader ? result.indexOf(afterHeader) : -1;
    if (afterIdx >= 0) result.splice(afterIdx + 1, 0, header);
    else result.push(header);
    return result;
  };

  const BASE_MASTER_HEADERS = global.MASTER_HEADERS || [
    "창고", "1코드", "1그룹명", "2코드", "2그룹명", "3코드", "3그룹명", "오더즈", "구매처", "브랜드",
    "품목코드", "품목명", "규격", "안전재고", "간단설명", "카탈로그", "견적서", "출고가", "입고가",
    "입고B", "도매A", "도매B", "상장가", "최종전송", "최종입고", "단가H", "단가I", "시중가",
    "행사가", "행사테마", "판매여부", "1종코드", "1종규격", "1종연산", "1당수량", "2종코드", "2종규격", "2종연산",
    "외주비", "노무비", "경비", "비과세", "기본", "연동", "싯가", "단위", "준비기간", "마감시간", "검색어등록"
  ];

  const BASE_NUMERIC_HEADERS = global.NUMERIC_HEADERS || [
    "안전재고", "출고가", "입고가", "입고B", "도매A", "도매B", "상장가", "최종전송", "최종입고",
    "단가H", "단가I", "시중가", "행사가", "1종연산", "1당수량", "2종연산", "외주비", "노무비", "경비",
    "1구매", "1출고", "2구매", "2출고", "1입고", "2입고", "재고수량"
  ];

  const MASTER_HEADERS = ensureHeaderAfter(ensureHeaderAfter(BASE_MASTER_HEADERS, "행사테마", "행사가"), "1당수량", "1종연산");
  const NUMERIC_HEADERS = ensureHeaderAfter(BASE_NUMERIC_HEADERS, "1당수량", "1종연산");

  global.MASTER_HEADERS = MASTER_HEADERS;
  global.NUMERIC_HEADERS = NUMERIC_HEADERS;

  const generateUUID = () => {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  };

  const parseNum = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    return Number(String(v).replace(/,/g, '').replace(/[^\d.-]/g, '')) || 0;
  };


  const PROMOTION_THEMES = [
    { code: '1', label: '오늘의행사', type: '탭' },
    { code: '2', label: '매장행사', type: '탭' },
    { code: '3', label: '특가상품', type: '탭' },
    { code: '4', label: '실사진', type: '뱃지' },
    { code: '5', label: '행사', type: '뱃지' }
  ];
  global.PROMOTION_THEMES = global.PROMOTION_THEMES || PROMOTION_THEMES;

  const parsePromotionThemeCodes = (...items) => {
    const out = [];
    const push = (v) => {
      const s = String(v ?? '').trim();
      if (!s) return;
      s.split(/[,/|\s]+/).forEach(part => {
        const n = String(part || '').replace(/[^1-5]/g, '');
        if (n && /^[1-5]$/.test(n) && !out.includes(n)) out.push(n);
      });
    };
    items.forEach(item => {
      if (!item) return;
      if (typeof item === 'object') {
        push(item['행사테마']);
        push(item['테마']);
        push(item['promoTheme']);
        push(item['_theme']);
        [1, 2, 3, 4, 5].forEach(n => {
          const raw = item[`테마${n}`];
          const s = String(raw ?? '').trim();
          if (s && s !== '0' && s !== 'false' && s !== 'FALSE' && !out.includes(String(n))) out.push(String(n));
        });
      } else {
        push(item);
      }
    });
    return out.sort((a, b) => Number(a) - Number(b));
  };

  const normalizePromotionThemeValue = (...items) => parsePromotionThemeCodes(...items).join(',');
  global.normalizePromotionThemeValue = global.normalizePromotionThemeValue || ((...items) => normalizePromotionThemeValue(...items));

  // 쇼핑몰 정보(info) 파일 전용 보조 정규화.
  // 판매: 1=판매, 0=정지. 그 외 값은 원문을 유지한다.
  const normalizeShopSaleValue = (value) => {
    const raw = String(value ?? '').trim();
    if (raw === '') return '';
    if (raw === '1' || raw === '판매' || raw === '판매중' || raw.toLowerCase() === 'true') return '1';
    if (raw === '0' || raw === '정지' || raw === '정지중' || raw === '판매중단' || raw.toLowerCase() === 'false') return '0';
    return value;
  };

  const INFO_EXCLUDED_MASTER_FIELDS = ['오더즈판매가', '오더즈구매가'];


  const hasOwnField = (obj = {}, field = '') => Object.prototype.hasOwnProperty.call(obj || {}, field);
  const isNonEmptySource = (obj = {}) => !!(obj && typeof obj === 'object' && Object.keys(obj).length > 0);
  const isBlankValue = (v) => v === undefined || v === null || String(v).trim() === '';
  const getExplicitValue = (obj = {}, field = '', fallback = '') => hasOwnField(obj, field) ? (obj[field] ?? '') : fallback;

  const safeJSONParseRaw = (raw, defaultVal) => {
    try {
      if (!raw || raw === 'undefined' || raw === 'null') return defaultVal;
      const parsed = JSON.parse(raw);
      return parsed === undefined || parsed === null ? defaultVal : parsed;
    } catch (e) {
      return defaultVal;
    }
  };

  const safeJSONParse = (key, defaultVal) => {
    try {
      return safeJSONParseRaw(global.localStorage.getItem(key), defaultVal);
    } catch (e) {
      return defaultVal;
    }
  };

  const getNowISO = () => {
    try { return new Date().toISOString(); } catch (e) { return ''; }
  };

  const ERRORS = ONEAPP.ERRORS = ONEAPP.ERRORS || {};

  ERRORS.toActionableMessage = (error, context = '작업') => {
    const name = String(error?.name || '');
    const detail = String(error?.message || error || '').trim();
    if (name === 'QuotaExceededError' || /quota|storage.*full|disk.*full/i.test(detail)) {
      return `${context} 실패: 브라우저 저장공간이 부족합니다. 불필요한 사이트 데이터를 정리한 뒤 다시 시도하세요.`;
    }
    if (name === 'SecurityError' || /access.*denied|not allowed|blocked/i.test(detail)) {
      return `${context} 실패: 브라우저가 저장소 접근을 차단했습니다. 시크릿 모드·사이트 권한을 확인한 뒤 다시 시도하세요.`;
    }
    if (name === 'AbortError' || name === 'TransactionInactiveError') {
      return `${context} 실패: 브라우저 데이터베이스 작업이 중단되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요.`;
    }
    if (name === 'NotFoundError' || /ObjectStore not found/i.test(detail)) {
      return `${context} 실패: 필요한 브라우저 데이터 저장소를 찾지 못했습니다. 페이지를 새로고침해 저장소를 다시 초기화하세요.`;
    }
    return `${context} 실패${detail ? `: ${detail}` : '했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.'}`;
  };

  ERRORS.create = (error, context) => {
    const wrapped = new Error(ERRORS.toActionableMessage(error, context));
    wrapped.name = 'OneAppClientError';
    try { wrapped.cause = error; } catch (e) {}
    return wrapped;
  };

  const calcDiffRate = (oldVal, newVal) => {
    const oldNum = parseNum(oldVal);
    const newNum = parseNum(newVal);
    if (!oldNum) return null;
    return Math.round(((newNum - oldNum) / oldNum) * 1000) / 10;
  };

  // ============================================================
  // MARGIN RULE ENGINE
  // MerchOps / ControlTower 공통 기본 마진룰.
  // 핵심 정책: 01창고 BOX는 10%가 우선이며, 과거 단일 기본룰(*/*/20%)만 남아 있으면 자동 복구한다.
  // ============================================================
  const getDefaultMerchMarginRules = () => ([
    { id: 'rule_1', whCode: '01', unit: 'box, 박스, BOX', rate: 10, type: 'divide' },
    { id: 'rule_2', whCode: '01', unit: 'ea, 개, 낱개, EA, kg, 단', rate: 15, type: 'divide' },
    { id: 'rule_3', whCode: '03,05', unit: 'box, 박스, BOX', rate: 15, type: 'divide' },
    { id: 'rule_4', whCode: '03,05', unit: 'ea, 개, 낱개, EA, kg, 단', rate: 10, type: 'divide' },
    { id: 'rule_5', whCode: '77,99', unit: 'box, 박스, BOX', rate: 10, type: 'divide' },
    { id: 'rule_6', whCode: '77,99', unit: 'ea, 개, 낱개, EA, kg, 단', rate: 15, type: 'divide' },
    { id: 'default', whCode: '*', unit: '*', rate: 20, type: 'divide' }
  ]);

  const normalizeMerchWarehouseForRule = (v) => {
    const raw = String(v ?? '').trim();
    if (!raw || raw === '*') return raw || '';
    const m = raw.match(/\d+/);
    return m ? String(Number(m[0])).padStart(2, '0') : raw;
  };

  const getMerchUnitRuleCandidates = (v) => {
    const raw = String(v ?? '').trim().toLowerCase();
    if (!raw || raw === '*') return raw === '*' ? ['*'] : [];
    const compact = raw.replace(/\s/g, '');
    const parts = [compact, ...raw.split(/[,./|\s()_\-]+/).map(s => s.trim()).filter(Boolean)];
    const cands = [];
    const push = (x) => { if (x && !cands.includes(x)) cands.push(x); };
    parts.forEach(part => {
      const p = String(part || '').toLowerCase().replace(/\s/g, '');
      if (!p) return;
      if (/box|박스|상자|bx/.test(p)) push('box');
      if (/소분|분할|절단|컷|소포장|묶음/.test(p)) push('sub');
      if (/ea|each|개|낱개|낱|kg|킬로|단|봉|포/.test(p)) push('ea');
      push(p);
    });
    return cands;
  };

  const isLegacyDefaultOnlyMarginRules = (rules = []) => {
    if (!Array.isArray(rules) || rules.length !== 1) return false;
    const r = rules[0] || {};
    return String(r.whCode ?? '*').trim() === '*'
      && String(r.unit ?? '*').trim() === '*'
      && parseNum(r.rate) === 20;
  };

  const sanitizeMerchMarginRules = (rules = []) => {
    const defaults = getDefaultMerchMarginRules();
    if (!Array.isArray(rules) || rules.length === 0 || isLegacyDefaultOnlyMarginRules(rules)) {
      return defaults.map(r => ({ ...r }));
    }
    const cleaned = rules
      .filter(r => r && typeof r === 'object')
      .map((r, idx) => ({
        id: r.id || `rule_${idx + 1}`,
        whCode: String(r.whCode ?? '*').trim() || '*',
        unit: String(r.unit ?? '*').trim() || '*',
        rate: parseNum(r.rate),
        type: r.type === 'multiply' ? 'multiply' : 'divide'
      }));
    const hasDefault = cleaned.some(r => String(r.whCode).trim() === '*' && String(r.unit).trim() === '*');
    if (!hasDefault) cleaned.push({ ...defaults[defaults.length - 1] });
    return cleaned;
  };

  const matchWh = (ruleWh, targetWh) => {
    if (!ruleWh || String(ruleWh).trim() === '*') return true;
    const target = normalizeMerchWarehouseForRule(targetWh);
    const targets = String(ruleWh).split(/[,./|\s]+/).map(s => normalizeMerchWarehouseForRule(s)).filter(Boolean);
    return targets.some(s => s !== '' && target !== '' && s === target);
  };

  const matchUnit = (ruleUnit, targetUnit) => {
    if (!ruleUnit || String(ruleUnit).trim() === '*') return true;
    const targetUnits = Array.isArray(targetUnit) ? targetUnit : getMerchUnitRuleCandidates(targetUnit);
    const targets = String(ruleUnit)
      .split(/[,./|\s]+/)
      .flatMap(s => getMerchUnitRuleCandidates(s))
      .filter(Boolean);
    return targets.some(ruleUnitNorm => targetUnits.some(targetUnitNorm => targetUnitNorm === ruleUnitNorm || targetUnitNorm.includes(ruleUnitNorm) || ruleUnitNorm.includes(targetUnitNorm)));
  };

  const findBestMarginRule = (marginRules = [], context = {}) => {
    const whCode = normalizeMerchWarehouseForRule(context['창고'] ?? context.whCode ?? '');
    const unitRaw = [context['단위'], context.unit, context['규격'], context.spec, context['품목명'], context.name]
      .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
      .join(' ');
    const unitCandidates = getMerchUnitRuleCandidates(unitRaw);
    let bestRule = null;
    let bestScore = -1;
    const safeRules = sanitizeMerchMarginRules(marginRules);

    safeRules.forEach((rule, ruleIdx) => {
      if (matchWh(rule.whCode, whCode) && matchUnit(rule.unit, unitCandidates)) {
        let score = 0;
        if (rule.whCode && String(rule.whCode).trim() !== '*') score += 20;
        if (rule.unit && String(rule.unit).trim() !== '*') score += 10;
        score -= ruleIdx / 1000;
        if (score > bestScore) {
          bestScore = score;
          bestRule = rule;
        }
      }
    });

    return bestRule || { id: 'default', whCode: '*', unit: '*', rate: 20, type: 'divide' };
  };

  // ============================================================
  // STORAGE ENGINE
  // ============================================================
  const STORAGE = ONEAPP.STORAGE = ONEAPP.STORAGE || {};

  STORAGE.writeLocalValue = (key, value, options = {}) => {
    const safeKey = String(key || '').trim();
    const label = options.label || `브라우저 저장(${safeKey || '키 없음'})`;
    if (!safeKey) throw new Error(`${label} 실패: 저장 키가 비어 있습니다.`);
    const serialized = String(value ?? '');
    try {
      global.localStorage.setItem(safeKey, serialized);
      if (options.verify !== false && global.localStorage.getItem(safeKey) !== serialized) {
        throw new Error('저장 후 검증값이 일치하지 않습니다.');
      }
      return serialized;
    } catch (error) {
      throw ERRORS.create(error, label);
    }
  };

  STORAGE.writeLocalJSON = (key, value, options = {}) => {
    const label = options.label || `브라우저 JSON 저장(${String(key || '').trim() || '키 없음'})`;
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      throw ERRORS.create(error, `${label} 직렬화`);
    }
    return STORAGE.writeLocalValue(key, serialized, { ...options, label });
  };

  STORAGE.restoreLocalValue = (key, previousValue, options = {}) => {
    const safeKey = String(key || '').trim();
    const label = options.label || `브라우저 저장 복구(${safeKey || '키 없음'})`;
    try {
      if (previousValue === null || previousValue === undefined) {
        global.localStorage.removeItem(safeKey);
        if (options.verify !== false && global.localStorage.getItem(safeKey) !== null) {
          throw new Error('삭제 후 검증값이 일치하지 않습니다.');
        }
        return null;
      }
      return STORAGE.writeLocalValue(safeKey, previousValue, { ...options, label });
    } catch (error) {
      if (error?.name === 'OneAppClientError') throw error;
      throw ERRORS.create(error, label);
    }
  };

  STORAGE.initIDB = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DEFAULT_DB_NAME, DEFAULT_DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_MASTER)) db.createObjectStore(STORE_MASTER, { keyPath: '코드' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(ERRORS.create(request.error, '브라우저 데이터베이스 열기'));
    request.onblocked = () => reject(new Error('브라우저 데이터베이스 열기 실패: 다른 탭에서 데이터베이스를 사용 중입니다. ONEAPP 탭을 닫고 다시 시도하세요.'));
  });

  STORAGE.getIDB = async (key) => {
    const db = await STORAGE.initIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readonly');
      const req = tx.objectStore(STORE_KV).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || tx.error);
    });
  };

  STORAGE.setIDB = async (key, val) => {
    const db = await STORAGE.initIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      try { tx.objectStore(STORE_KV).put(val, key); }
      catch (error) { reject(ERRORS.create(error, `브라우저 데이터 저장(${key})`)); return; }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(ERRORS.create(tx.error, `브라우저 데이터 저장(${key})`));
      tx.onabort = () => reject(ERRORS.create(tx.error || new DOMException('Transaction aborted', 'AbortError'), `브라우저 데이터 저장(${key})`));
    });
  };

  STORAGE.getAllIDB = async (storeName) => {
    const db = await STORAGE.initIDB();
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(storeName)) return resolve([]);
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || tx.error);
    });
  };

  STORAGE.bulkPutIDB = async (storeName, items = []) => {
    if (!Array.isArray(items)) throw new Error(`브라우저 일괄 저장(${storeName}) 실패: 저장 데이터가 배열이 아닙니다.`);
    const db = await STORAGE.initIDB();
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(storeName)) return reject(new Error(`ObjectStore not found: ${storeName}`));
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      try {
     …11464 tokens truncated…urn '';
    const raw = String(value).trim();
    if (raw === '') return '';
    if (field === '판매여부') return normalizeShopSaleValue(value);
    if ((global.NUMERIC_HEADERS || []).includes(field)) return parseNum(value);
    if (field === '품목코드' || field === '코드') return MASTER.normalizeMasterCode(value);
    return value;
  };

  MASTER.normalizeExcelRowForMaster = (row = {}, sourceHeaders = []) => {
    const headers = Array.isArray(sourceHeaders) && sourceHeaders.length > 0 ? sourceHeaders : Object.keys(row || {});
    const out = {};
    const sourceColumns = [];
    const themeSource = {};

    headers.forEach(header => {
      if (header === undefined || header === null || String(header).trim() === '') return;
      const cleanHeader = String(header).trim();
      const field = MASTER.canonicalMasterFieldName(cleanHeader);
      if (!field) return;

      // 테마1~테마5는 개별 컬럼값을 덮어쓰지 않고 내부 행사테마 코드로 합산한다.
      if (/^테마[1-5]$/.test(cleanHeader)) {
        themeSource[cleanHeader] = row[header];
        if (!sourceColumns.includes('행사테마')) sourceColumns.push('행사테마');
        return;
      }

      // 엑셀에 존재하는 컬럼만 sourceColumns에 넣는다. 값이 공란이어도 존재 컬럼이다.
      if (!sourceColumns.includes(field)) sourceColumns.push(field);
      out[field] = MASTER.normalizeMasterCellValue(field, row[header]);
    });

    if (Object.keys(themeSource).length > 0) {
      const normalizedTheme = normalizePromotionThemeValue(themeSource);
      // 테마 컬럼이 존재했으면 모두 공란인 경우도 행사테마 초기화 의도로 보존한다.
      out['행사테마'] = normalizedTheme;
    }

    const code = MASTER.getMasterCode(out);
    if (code) {
      out['품목코드'] = code;
      out['코드'] = code;
      if (!sourceColumns.includes('품목코드')) sourceColumns.unshift('품목코드');
    }
    return { item: out, sourceColumns };
  };

  MASTER.buildMasterIndex = (masterInput = {}) => {
    const map = {};
    const items = Array.isArray(masterInput) ? masterInput : Object.values(masterInput || {});
    items.forEach(item => {
      if (!item) return;
      const code = MASTER.getMasterStorageKey(item);
      if (!code) return;
      map[code] = { ...(item || {}), 코드: item['코드'] || code, 품목코드: item['품목코드'] || code };
    });
    return map;
  };

  MASTER.valuesEqual = (field, a, b) => {
    if ((global.NUMERIC_HEADERS || []).includes(field)) {
      const aBlank = a === undefined || a === null || String(a).trim?.() === '';
      const bBlank = b === undefined || b === null || String(b).trim?.() === '';
      if (aBlank && bBlank) return true;
      return parseNum(a) === parseNum(b);
    }
    return String(a ?? '') === String(b ?? '');
  };

  MASTER.validateMasterExcelAnalysis = (analysis = {}) => {
    const blockingErrors = [];
    const warnings = [];
    const summary = analysis && typeof analysis.summary === 'object' ? analysis.summary : {};
    const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
    const sourceColumns = Array.isArray(analysis?.sourceColumns) ? analysis.sourceColumns : [];
    const totalRows = Number(summary.totalRows ?? analysis?.totalRows ?? 0) || 0;
    const noCodeCount = Number(summary.noCodeCount ?? analysis?.errors?.length ?? 0) || 0;
    const duplicateCodeCount = Number(summary.duplicateCodeCount ?? analysis?.duplicateCodes?.length ?? 0) || 0;
    const updateCount = Number(summary.updateCount ?? 0) || 0;
    const createCount = Number(summary.createCount ?? 0) || 0;
    const changeCount = updateCount + createCount;

    if (!analysis || typeof analysis !== 'object' || !Array.isArray(analysis.candidates)) {
      blockingErrors.push('분석 결과 형식이 올바르지 않습니다. 엑셀을 다시 선택해 분석하세요.');
    }
    if (totalRows <= 0) blockingErrors.push('엑셀 데이터 행이 없습니다. 첫 번째 시트와 헤더를 확인하세요.');
    if (!sourceColumns.includes('품목코드')) {
      blockingErrors.push('품목코드 컬럼을 찾지 못했습니다. 헤더에 품목코드·상품코드·바코드 중 하나가 필요합니다.');
    }
    if (noCodeCount > 0) {
      const rows = (Array.isArray(analysis?.errors) ? analysis.errors : []).slice(0, 5).map(item => item?.rowNumber).filter(Boolean);
      blockingErrors.push(`품목코드가 없는 행이 ${noCodeCount.toLocaleString()}건 있습니다${rows.length ? ` (행 ${rows.join(', ')})` : ''}. 해당 행을 수정하거나 삭제하세요.`);
    }
    if (duplicateCodeCount > 0) {
      const codes = (Array.isArray(analysis?.duplicateCodes) ? analysis.duplicateCodes : []).slice(0, 5);
      blockingErrors.push(`중복 품목코드가 ${duplicateCodeCount.toLocaleString()}건 있습니다${codes.length ? ` (${codes.join(', ')})` : ''}. 코드별로 한 행만 남기세요.`);
    }

    const seenCodes = new Set();
    for (const candidate of candidates) {
      const code = String(candidate?.code || '').trim();
      if (!code) {
        blockingErrors.push('적용 후보에 품목코드가 없는 항목이 있습니다. 엑셀을 다시 분석하세요.');
        break;
      }
      if (seenCodes.has(code)) {
        blockingErrors.push(`적용 후보에 중복 품목코드 ${code}가 있습니다. 엑셀을 다시 분석하세요.`);
        break;
      }
      seenCodes.add(code);
      if (!['create', 'update', 'same'].includes(String(candidate?.status || ''))) {
        blockingErrors.push(`품목코드 ${code}의 적용 상태가 올바르지 않습니다. 엑셀을 다시 분석하세요.`);
        break;
      }
    }

    if (candidates.length === 0 && totalRows > 0) {
      blockingErrors.push('적용 가능한 품목을 찾지 못했습니다. 품목코드와 헤더 구성을 확인하세요.');
    }
    if (changeCount === 0 && blockingErrors.length === 0) {
      blockingErrors.push('변경하거나 추가할 품목이 없습니다. 현재 마스터와 동일한 파일인지 확인하세요.');
    }
    if ((Number(summary.missingInExcelCount) || 0) > 0) {
      warnings.push(`엑셀에 없는 기존 상품 ${(Number(summary.missingInExcelCount) || 0).toLocaleString()}건은 삭제하지 않고 유지합니다.`);
    }

    const uniqueBlockingErrors = [...new Set(blockingErrors)];
    return {
      ok: uniqueBlockingErrors.length === 0,
      blockingErrors: uniqueBlockingErrors,
      warnings,
      changeCount,
      message: uniqueBlockingErrors.length > 0
        ? `마스터 적용이 차단되었습니다. ${uniqueBlockingErrors.join(' ')}`
        : `검증 통과: 수정 ${updateCount.toLocaleString()}건, 신규 ${createCount.toLocaleString()}건을 적용할 수 있습니다.`
    };
  };

  MASTER.analyzeMasterExcelUpload = ({ excelRows = [], currentMaster = {}, sourceHeaders = [] } = {}) => {
    const rows = Array.isArray(excelRows) ? excelRows : [];
    const masterMap = MASTER.buildMasterIndex(currentMaster);
    const normalizedRows = [];
    const errors = [];
    const duplicateGroups = {};
    const seen = {};
    const sourceColumnSet = new Set();

    rows.forEach((row, rowIdx) => {
      const normalized = MASTER.normalizeExcelRowForMaster(row, sourceHeaders.length ? sourceHeaders : Object.keys(row || {}));
      normalized.sourceColumns.forEach(c => sourceColumnSet.add(c));
      const item = normalized.item;
      const code = MASTER.getMasterStorageKey(item);
      const payload = { rowNumber: rowIdx + 2, code, item, sourceColumns: normalized.sourceColumns, raw: row };
      if (!code) {
        errors.push({ rowNumber: rowIdx + 2, type: 'NO_CODE', message: '품목코드 없음', raw: row });
        return;
      }
      if (seen[code]) {
        duplicateGroups[code] = duplicateGroups[code] || [seen[code]];
        duplicateGroups[code].push(payload);
        return;
      }
      seen[code] = payload;
      normalizedRows.push(payload);
    });

    const duplicateCodes = Object.keys(duplicateGroups);
    const duplicateCodeSet = new Set(duplicateCodes);
    const candidates = [];
    const changeRows = [];
    const createRows = [];
    const sameRows = [];
    const fieldCounts = {};
    const updateColumns = Array.from(sourceColumnSet).filter(c => c && c !== '코드');

    normalizedRows.forEach(rowInfo => {
      if (duplicateCodeSet.has(rowInfo.code)) return;
      const existing = masterMap[rowInfo.code] || null;
      const sourceColsForRow = rowInfo.sourceColumns.filter(c => c && c !== '코드');
      if (!existing) {
        const newItem = { ...rowInfo.item, 코드: rowInfo.code, 품목코드: rowInfo.item['품목코드'] || rowInfo.code };
        const candidate = { status: 'create', code: rowInfo.code, name: newItem['품목명'] || '', item: newItem, sourceColumns: sourceColsForRow, changes: [] };
        createRows.push(candidate);
        candidates.push(candidate);
        return;
      }

      const changes = [];
      sourceColsForRow.forEach(field => {
        if (field === '품목코드') return;
        // 엑셀에 있는 컬럼만 반영한다. 값이 공란이어도 rowInfo.item[field]는 존재한다.
        if (!Object.prototype.hasOwnProperty.call(rowInfo.item, field)) return;
        const oldVal = existing[field] ?? '';
        const newVal = rowInfo.item[field] ?? '';
        if (!MASTER.valuesEqual(field, oldVal, newVal)) {
          changes.push({ code: rowInfo.code, name: existing['품목명'] || rowInfo.item['품목명'] || '', field, oldVal, newVal });
          fieldCounts[field] = (fieldCounts[field] || 0) + 1;
        }
      });
      const candidate = { status: changes.length > 0 ? 'update' : 'same', code: rowInfo.code, name: existing['품목명'] || rowInfo.item['품목명'] || '', existing, item: rowInfo.item, sourceColumns: sourceColsForRow, changes };
      if (changes.length > 0) changeRows.push(candidate); else sameRows.push(candidate);
      candidates.push(candidate);
    });

    const excelCodeSet = new Set(candidates.map(c => c.code));
    const missingInExcel = Object.keys(masterMap).filter(code => !excelCodeSet.has(code));

    const analysis = {
      analyzedAt: getNowISO(),
      totalRows: rows.length,
      validRows: normalizedRows.length - duplicateCodes.length,
      sourceColumns: updateColumns,
      summary: {
        totalRows: rows.length,
        validCodeRows: normalizedRows.length,
        noCodeCount: errors.length,
        duplicateCodeCount: duplicateCodes.length,
        updateCount: changeRows.length,
        createCount: createRows.length,
        sameCount: sameRows.length,
        missingInExcelCount: missingInExcel.length,
        fieldCounts
      },
      candidates,
      changeRows,
      createRows,
      sameRows,
      errors,
      duplicateCodes,
      duplicateGroups,
      missingInExcel
    };
    analysis.validation = MASTER.validateMasterExcelAnalysis(analysis);
    return analysis;
  };

  MASTER.createMasterBackup = async (masterInput = {}, label = '마스터엑셀업로드') => {
    const masterMap = MASTER.buildMasterIndex(masterInput);
    let backups = [];
    try { backups = await STORAGE.getIDB(MASTER_BACKUP_KEY) || []; } catch (e) { backups = []; }
    const backup = {
      id: `master_backup_${Date.now()}`,
      label,
      createdAt: getNowISO(),
      count: Object.keys(masterMap).length,
      data: masterMap
    };
    const next = [backup, ...(Array.isArray(backups) ? backups : [])].slice(0, 5);
    await STORAGE.setIDB(MASTER_BACKUP_KEY, next);
    return backup;
  };

  MASTER.getMasterBackups = async () => {
    try { return await STORAGE.getIDB(MASTER_BACKUP_KEY) || []; } catch (e) { return []; }
  };

  MASTER.restoreMasterBackup = async (backupId) => {
    const backups = await MASTER.getMasterBackups();
    const backup = backups.find(b => b && b.id === backupId);
    if (!backup) throw new Error('백업을 찾을 수 없습니다.');
    const items = Object.values(backup.data || {}).filter(item => item && (item.코드 || item.품목코드));
    await STORAGE.replaceAllIDB(STORE_MASTER, items);
    STORAGE.writeLocalValue('merchMaster_sync_trigger', Date.now().toString(), { label: '마스터 복구 알림 저장' });
    return backup;
  };

  MASTER.applyMasterExcelUpload = async ({ analysis, currentMaster = {}, label = '마스터엑셀업로드' } = {}) => {
    const validation = MASTER.validateMasterExcelAnalysis(analysis);
    if (!validation.ok) throw new Error(validation.message);
    const masterMap = MASTER.buildMasterIndex(currentMaster);
    const backup = await MASTER.createMasterBackup(masterMap, label);
    const historyLogs = [];
    let updateCount = 0;
    let createCount = 0;

    analysis.candidates.forEach(candidate => {
      if (!candidate || candidate.status === 'same') return;
      const code = candidate.code;
      if (!code) return;
      if (candidate.status === 'create') {
        masterMap[code] = { ...(candidate.item || {}), 코드: code, 품목코드: (candidate.item || {})['품목코드'] || code };
        createCount++;
        historyLogs.push(HISTORY.buildHistoryLog({
          source: 'master_excel_upload', actionType: 'master_create', code,
          name: masterMap[code]['품목명'] || '', field: '신규상품', oldVal: '', newVal: '추가', memo: label
        }));
        return;
      }
      if (candidate.status === 'update') {
        const existing = masterMap[code] || { 코드: code, 품목코드: code };
        const nextItem = { ...existing };
        (candidate.sourceColumns || []).forEach(field => {
          if (!field || field === '코드') return;
          if (!Object.prototype.hasOwnProperty.call(candidate.item || {}, field)) return;
          nextItem[field] = candidate.item[field];
        });
        nextItem['코드'] = code;
        nextItem['품목코드'] = nextItem['품목코드'] || code;
        masterMap[code] = nextItem;
        updateCount++;
        (candidate.changes || []).forEach(change => {
          historyLogs.push(HISTORY.buildHistoryLog({
            source: 'master_excel_upload', actionType: 'master_update', code,
            name: nextItem['품목명'] || change.name || '', field: change.field,
            oldVal: change.oldVal, newVal: change.newVal, memo: label
          }));
        });
      }
    });

    const items = Object.values(masterMap).filter(item => item && (item.코드 || item.품목코드));
    const previousItems = Object.values(backup.data || {}).filter(item => item && (item.코드 || item.품목코드));
    let previousHistory = null;
    try { previousHistory = global.localStorage.getItem(HISTORY_KEY); } catch (e) {}
    let masterWriteCompleted = false;

    HISTORY.assertHistoryForMutation(updateCount + createCount, historyLogs);
    try {
      await STORAGE.replaceAllIDB(STORE_MASTER, items);
      masterWriteCompleted = true;
      if (historyLogs.length > 0) HISTORY.addHistoryLogs(historyLogs);
      STORAGE.writeLocalValue('merchMaster_sync_trigger', Date.now().toString(), { label: '마스터 변경 알림 저장' });
      STORAGE.writeLocalValue('config_sync_trigger', Date.now().toString(), { label: '설정 변경 알림 저장' });
    } catch (error) {
      const rollbackFailures = [];
      if (masterWriteCompleted) {
        try { await STORAGE.replaceAllIDB(STORE_MASTER, previousItems); }
        catch (rollbackError) { rollbackFailures.push(ERRORS.toActionableMessage(rollbackError, '마스터 자동복구')); }
      }
      try { STORAGE.restoreLocalValue(HISTORY_KEY, previousHistory, { label: '변경 이력 자동복구' }); }
      catch (rollbackError) { rollbackFailures.push(ERRORS.toActionableMessage(rollbackError, '변경 이력 자동복구')); }

      const baseMessage = ERRORS.toActionableMessage(error, '마스터 적용');
      if (rollbackFailures.length > 0) {
        throw new Error(`${baseMessage} 자동복구에도 실패했습니다: ${rollbackFailures.join(' / ')}. 적용을 중단하고 백업 복구를 실행하세요.`);
      }
      throw new Error(`${baseMessage} 변경 전 데이터로 자동 복구했습니다.`);
    }

    return {
      status: 'success',
      validation,
      backup,
      masterMap,
      updateCount,
      createCount,
      historyCount: historyLogs.length,
      totalCount: items.length
    };
  };

  // Info workgroup helper aliases.
  global.normalizeShopSaleValue = global.normalizeShopSaleValue || normalizeShopSaleValue;

  // ============================================================
  // Backward-compatible aliases.
  // 기존 HTML 교체 중에도 단계적으로 사용할 수 있게, 없는 경우에만 전역 별칭을 제공한다.
  // ============================================================
  global.generateUUID = global.generateUUID || generateUUID;
  global.parseNum = global.parseNum || parseNum;
  global.safeJSONParse = global.safeJSONParse || safeJSONParse;
  global.initIDB = global.initIDB || STORAGE.initIDB;
  global.getIDB = global.getIDB || STORAGE.getIDB;
  global.setIDB = global.setIDB || STORAGE.setIDB;
  global.getAllIDB = global.getAllIDB || STORAGE.getAllIDB;
  global.bulkPutIDB = global.bulkPutIDB || STORAGE.bulkPutIDB;
  global.replaceAllIDB = global.replaceAllIDB || STORAGE.replaceAllIDB;
  global.getDefaultMerchMarginRules = global.getDefaultMerchMarginRules || getDefaultMerchMarginRules;
  global.sanitizeMerchMarginRules = global.sanitizeMerchMarginRules || sanitizeMerchMarginRules;
  global.normalizeMerchWarehouseForRule = global.normalizeMerchWarehouseForRule || normalizeMerchWarehouseForRule;
  global.getMerchUnitRuleCandidates = global.getMerchUnitRuleCandidates || getMerchUnitRuleCandidates;
  global.calculatePricesEngine = global.calculatePricesEngine || PRICING.calculatePricesEngine;
  global.getWorkingSourceRole = global.getWorkingSourceRole || PRICING.getWorkingSourceRole;
  global.shouldUseMasterMarketPriceForRole = global.shouldUseMasterMarketPriceForRole || PRICING.shouldUseMasterMarketPriceForRole;
  global.shouldAllowMarketPriceRecalcForRole = global.shouldAllowMarketPriceRecalcForRole || PRICING.shouldAllowMarketPriceRecalcForRole;
  global.computeFinalData = global.computeFinalData || PRICING.computeFinalData;
  global.calculateSubPriceInfo = global.calculateSubPriceInfo || PRICING.calculateSubPriceInfo;
  global.calculateSubStockInfo = global.calculateSubStockInfo || PRICING.calculateSubStockInfo;
  global.getMasterSalesState = global.getMasterSalesState || PRICING.getMasterSalesState;
  global.getOneAppCloudSyncUrl = global.getOneAppCloudSyncUrl || CLOUD.getCloudSyncUrl;
  global.setOneAppCloudSyncUrl = global.setOneAppCloudSyncUrl || CLOUD.setCloudSyncUrl;
  global.ensureDefaultCloudSyncUrl = global.ensureDefaultCloudSyncUrl || CLOUD.ensureDefaultCloudSyncUrl;
  global.pullMerchMasterForDataOps = global.pullMerchMasterForDataOps || CLOUD.pullMerchMasterForDataOps;
  global.getCachedMerchMasterForDataOps = global.getCachedMerchMasterForDataOps || CLOUD.getCachedMerchMasterForDataOps;
  global.pushCloudBackup = global.pushCloudBackup || CLOUD.pushCloudBackup;
  global.pullCloudBackup = global.pullCloudBackup || CLOUD.pullCloudBackup;
  global.pushConfigBackup = global.pushConfigBackup || CLOUD.pushConfigBackup;
  global.pullConfigBackup = global.pullConfigBackup || CLOUD.pullConfigBackup;
  global.analyzeMasterExcelUpload = global.analyzeMasterExcelUpload || MASTER.analyzeMasterExcelUpload;
  global.validateMasterExcelAnalysis = global.validateMasterExcelAnalysis || MASTER.validateMasterExcelAnalysis;
  global.applyMasterExcelUpload = global.applyMasterExcelUpload || MASTER.applyMasterExcelUpload;
  global.getMasterBackups = global.getMasterBackups || MASTER.getMasterBackups;
  global.restoreMasterBackup = global.restoreMasterBackup || MASTER.restoreMasterBackup;

})(window);
