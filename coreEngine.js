/**
 * ONEAPP MerchOps - coreEngine.js
 * v1.0.8 / Pricing Policy Sync
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
 * v1.0.8_PricingPolicySync:
 * - computeFinalData를 최신 MerchOps 정책에 맞게 정리한다. 엑셀 source에 없는 입고가는 마스터값으로 자동 대체하지 않는다.
 * - 구매/재고 작업의 시중가는 마스터 시중가를 참조하고, 구매/재고 원가로 시중가를 자동 산출하거나 갱신하지 않는다.
 * - 룰적용(forceRecalc)은 명시 액션으로만 출고가를 계산한다. 견적 작업만 출고가/시중가 동시 계산을 허용하고, 구매/재고는 출고가만 계산한다.
 * - 작업 source 역할(estimate/purchase/inventory/info)을 판정하는 PRICING helper를 추가한다.
 */

(function initOneAppCore(global) {
  'use strict';

  const ONEAPP = global.ONEAPP = global.ONEAPP || {};
  ONEAPP.VERSION = ONEAPP.VERSION || 'coreEngine-v1.0.8 PricingPolicySync';

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

  STORAGE.initIDB = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DEFAULT_DB_NAME, DEFAULT_DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_MASTER)) db.createObjectStore(STORE_MASTER, { keyPath: '코드' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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
      tx.objectStore(STORE_KV).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
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
    const db = await STORAGE.initIDB();
    return new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(storeName)) return reject(new Error(`ObjectStore not found: ${storeName}`));
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      (items || []).forEach(item => {
        if (item) store.put(item);
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  };

  STORAGE.safeJSONParse = safeJSONParse;
  STORAGE.safeJSONParseRaw = safeJSONParseRaw;
  STORAGE.generateUUID = generateUUID;

  // ============================================================
  // PRICING ENGINE
  // ============================================================
  const PRICING = ONEAPP.PRICING = ONEAPP.PRICING || {};

  PRICING.parseNum = parseNum;
  PRICING.findBestMarginRule = findBestMarginRule;
  PRICING.getDefaultMerchMarginRules = getDefaultMerchMarginRules;
  PRICING.sanitizeMerchMarginRules = sanitizeMerchMarginRules;
  PRICING.normalizeMerchWarehouseForRule = normalizeMerchWarehouseForRule;
  PRICING.getMerchUnitRuleCandidates = getMerchUnitRuleCandidates;

  PRICING.calculatePricesEngine = (baseInPrice, providedOutPrice = 0, mItem = {}, currentFinalData = {}, marginRules = [], forceRecalc = false) => {
    const ROUND_UNIT = 100;
    const inPrice = parseNum(baseInPrice);
    const outsrc = (!currentFinalData?.['외주비'] && currentFinalData?.['외주비'] !== 0)
      ? parseNum(mItem?.['외주비'])
      : parseNum(currentFinalData?.['외주비']);

    const labor = (!currentFinalData?.['노무비'] && currentFinalData?.['노무비'] !== 0)
      ? parseNum(mItem?.['노무비'])
      : parseNum(currentFinalData?.['노무비']);

    const totalCost = inPrice + outsrc + labor;
    const appliedRule = findBestMarginRule(marginRules, {
      // 계산용 창고/단위는 원본값을 덮어쓰지 않는 보조 컨텍스트다.
      // 재고 불러오기 상품이 창고 각인이 없을 때만 _calcWarehouse=01이 전달된다.
      창고: currentFinalData?.['_calcWarehouse'] ?? currentFinalData?.['창고'] ?? mItem?.['창고'] ?? '',
      단위: currentFinalData?.['_calcUnit'] ?? currentFinalData?.['단위'] ?? mItem?.['단위'] ?? ''
    });

    let calcOutPrice = 0;
    if (inPrice > 0) {
      const rate = parseNum(appliedRule.rate);
      if (appliedRule.type === 'divide') {
        calcOutPrice = totalCost / (1 - (rate / 100));
      } else {
        calcOutPrice = totalCost * (1 + (rate / 100));
      }
      calcOutPrice = Math.round(calcOutPrice / ROUND_UNIT) * ROUND_UNIT;
    }

    if (inPrice === 0) return 0;
    if (forceRecalc) return calcOutPrice;
    if (parseNum(providedOutPrice) > 0) return parseNum(providedOutPrice);
    return calcOutPrice;
  };

  PRICING.getWorkingSourceRole = (sources = {}) => {
    const explicit = String(sources?._activeRole || sources?.activeRole || sources?.sourceRole || '').trim();
    const known = ['estimate', 'purchase', 'inventory', 'info', 'catalog', 'sales'];
    if (known.includes(explicit)) return explicit;
    // 현재 작업파일이 하나인 구조를 우선한다. 복수 source가 있으면 구매/재고 병합을 자동 추정하지 않고, 명확한 작업군을 우선 판정한다.
    const priority = ['info', 'purchase', 'inventory', 'estimate', 'catalog', 'sales'];
    return priority.find(role => isNonEmptySource(sources?.[role])) || '';
  };

  PRICING.shouldUseMasterMarketPriceForRole = (role = '') => ['purchase', 'inventory'].includes(String(role || '').trim());
  PRICING.shouldAllowMarketPriceRecalcForRole = (role = '') => String(role || '').trim() === 'estimate';

  PRICING.computeFinalData = (mItem = {}, sources = {}, marginRules = [], forceRecalc = false) => {
    const activeRole = PRICING.getWorkingSourceRole(sources || {});
    const hasUploadSource = !!activeRole && isNonEmptySource((sources || {})[activeRole]);
    const source = hasUploadSource ? { ...((sources || {})[activeRole] || {}) } : { ...(mItem || {}) };
    const working = { ...source };

    // v1.0.8 정책:
    // - 업로드 source가 있으면 해당 파일에 있는 값만 작업값으로 사용한다.
    // - 입고가가 파일에 없으면 마스터 입고가로 자동 대체하지 않는다.
    // - 계산값은 메타 정보에만 보관하고, forceRecalc일 때만 출고가를 실제 작업값으로 반영한다.
    const sourceHasInPrice = hasOwnField(source, '입고가');
    const sourceHasOutPrice = hasOwnField(source, '출고가');
    const sourceHasMarketPrice = hasOwnField(source, '시중가');
    const masterMarketPrice = getExplicitValue(mItem, '시중가', '');

    const baseInRaw = hasUploadSource
      ? (sourceHasInPrice ? source['입고가'] : '')
      : getExplicitValue(mItem, '입고가', '');
    const baseInPrice = parseNum(baseInRaw);
    const providedOutPrice = sourceHasOutPrice ? parseNum(source['출고가']) : 0;
    const calculatedOutPrice = baseInPrice > 0
      ? PRICING.calculatePricesEngine(baseInPrice, 0, mItem, working, marginRules, true)
      : 0;

    if (hasUploadSource && !sourceHasInPrice) {
      delete working['입고가'];
      working._missingInPrice = true;
    }

    if (forceRecalc && baseInPrice > 0 && activeRole !== 'info') {
      working['출고가'] = calculatedOutPrice;
      working._ruleAppliedAt = getNowISO();
    } else if (hasUploadSource && !sourceHasOutPrice) {
      // 자동 불러오기 단계에서는 출고가를 임의 계산값으로 채우지 않는다.
      delete working['출고가'];
    }

    if (PRICING.shouldUseMasterMarketPriceForRole(activeRole)) {
      working['시중가'] = masterMarketPrice;
      working._marketPricePolicy = 'master_reference_for_purchase_inventory';
    } else if (PRICING.shouldAllowMarketPriceRecalcForRole(activeRole)) {
      if (forceRecalc && calculatedOutPrice > 0) {
        working['시중가'] = calculatedOutPrice;
        working._marketPricePolicy = 'estimate_rule_recalc_allowed';
      } else if (sourceHasMarketPrice) {
        working['시중가'] = source['시중가'];
        working._marketPricePolicy = 'estimate_source_market_price';
      } else if (hasUploadSource) {
        // 견적 파일에 시중가가 없으면 마스터 시중가로 자동 대체하지 않는다.
        delete working['시중가'];
        working._marketPricePolicy = 'estimate_market_price_missing';
      } else {
        working['시중가'] = masterMarketPrice;
        working._marketPricePolicy = 'master_reference';
      }
    } else if (activeRole === 'info') {
      // 정보파일은 쇼핑몰 원본값 보존이 원칙이며, 가격 룰 계산 대상이 아니다.
      if (sourceHasMarketPrice) working['시중가'] = source['시중가'];
      working._marketPricePolicy = 'info_original_preserved';
    } else if (!hasUploadSource) {
      working['시중가'] = masterMarketPrice;
      working._marketPricePolicy = 'master_reference';
    } else if (!sourceHasMarketPrice) {
      delete working['시중가'];
      working._marketPricePolicy = 'source_market_price_missing';
    }

    const themeValue = normalizePromotionThemeValue(working, hasUploadSource ? {} : (mItem || {}));
    if (themeValue) {
      working['행사테마'] = themeValue;
      [1, 2, 3, 4, 5].forEach(n => { working[`테마${n}`] = themeValue.split(',').includes(String(n)) ? '1' : ''; });
    }

    const actualOutPrice = hasOwnField(working, '출고가') ? parseNum(working['출고가']) : 0;
    working._activeSourceRole = activeRole || 'master';
    working._sourcePolicy = hasUploadSource ? 'source_value_only_no_master_fallback' : 'master_reference';
    working._isRuleApplied = !!forceRecalc;
    working._calculatedOutPrice = calculatedOutPrice || 0;
    working._sourceOutPrice = providedOutPrice || 0;
    working._normalPrice = actualOutPrice || calculatedOutPrice || 0;
    working._isPromo = parseNum(working['행사가']) > 0;
    working._pricingPolicyVersion = 'v1.0.8_PricingPolicySync';

    if (sourceHasOutPrice && calculatedOutPrice > 0 && providedOutPrice > 0 && providedOutPrice !== calculatedOutPrice) {
      working._outPriceRuleDiff = true;
      working._outPriceRuleDiffAmount = calculatedOutPrice - providedOutPrice;
      working._outPriceRuleDiffRate = providedOutPrice > 0 ? Math.round(((calculatedOutPrice - providedOutPrice) / providedOutPrice) * 1000) / 10 : 0;
    } else {
      working._outPriceRuleDiff = false;
      working._outPriceRuleDiffAmount = 0;
      working._outPriceRuleDiffRate = 0;
    }

    return working;
  };

  PRICING.calculateReviewOutPrice = (baseInPrice, context = {}, marginRules = []) => {
    return PRICING.calculatePricesEngine(
      parseNum(baseInPrice),
      0,
      context,
      context,
      marginRules,
      true
    );
  };

  PRICING.isValidSubItemCode = (code) => {
    if (!code) return false;
    const s = String(code).trim();
    return s !== '' && s !== '0' && s !== '00' && s !== '-' && s.toLowerCase() !== 'undefined' && s.toLowerCase() !== 'null';
  };

  // 1종연산은 원가/가격 산출용 계수다. 재고수량 환산은 1당수량을 사용한다.
  PRICING.calculateSubPriceInfo = (row = {}) => {
    const costFactor1 = parseNum(row['1종연산']);
    if (!PRICING.isValidSubItemCode(row['1종코드']) || costFactor1 <= 0) return null;

    const inPrice = parseNum(row.입고가);
    const outPrice = parseNum(row.출고가); // 확정 정책: 원물 기본 출고가 기준
    const outsrc = parseNum(row['외주비']);
    const extraCost = parseNum(row['경비']);
    const stockFactor1 = parseNum(row['1당수량']);

    const subIn = inPrice > 0 ? Math.round(((inPrice + outsrc) / costFactor1) / 100) * 100 : 0;
    const rawSubOut = outPrice > 0 ? Math.round((outPrice / costFactor1) + extraCost) : 0;
    const subOut = rawSubOut > 0 ? Math.round(rawSubOut / 10) * 10 : 0;

    return {
      code: String(row['1종코드']).trim(),
      spec: row['1종규격'] || '',
      div1: costFactor1,
      costFactor1,
      stockFactor1,
      oneQty: stockFactor1,
      subIn,
      subOut
    };
  };

  // 원물 재고수량을 1종품목 재고 가능수량으로 환산한다.
  // 정책: 재고수량 산출에는 1종연산을 쓰지 않고 1당수량만 사용한다.
  PRICING.calculateSubStockInfo = (row = {}, rawStockQty = undefined) => {
    if (!PRICING.isValidSubItemCode(row['1종코드'])) return null;
    const stockFactor1 = parseNum(row['1당수량']);
    if (stockFactor1 <= 0) return null;

    const rawStock = rawStockQty !== undefined ? parseNum(rawStockQty) : parseNum(row['재고수량']);
    const subStockQty = rawStock * stockFactor1;

    return {
      code: String(row['1종코드']).trim(),
      spec: row['1종규격'] || '',
      rawStockQty: rawStock,
      stockFactor1,
      oneQty: stockFactor1,
      subStockQty
    };
  };

  PRICING.getMasterSalesState = (item = {}) => {
    const rawStatus = item['판매여부'];
    const statusStr = rawStatus !== undefined && rawStatus !== null ? String(rawStatus).trim() : '';
    const hasStatusValue = statusStr !== '';
    const outPrice = parseNum(item['출고가']);
    const promoPrice = parseNum(item['행사가']);
    const stockQty = item['재고수량'] !== undefined && item['재고수량'] !== '' ? parseNum(item['재고수량']) : 999;
    const hasSalePrice = outPrice > 0 || promoPrice > 0;

    if (!hasStatusValue && !hasSalePrice) {
      return { code: '-', label: '-', text: '-', tone: 'muted', className: 'text-slate-400 font-bold' };
    }

    if (statusStr === '0' || statusStr === '정지' || statusStr === '정지중' || statusStr === '판매중단' || (!hasSalePrice && hasStatusValue)) {
      return { code: '0', label: '정지', text: '정지', tone: 'stopped', className: 'text-rose-600 font-black' };
    }

    if (hasSalePrice) {
      if (stockQty === 0) return { code: '1', label: '품절', text: '품절', tone: 'soldout', className: 'text-orange-600 font-black' };
      if (promoPrice > 0) return { code: '1', label: '행사', text: '행사', tone: 'promo', className: 'text-purple-700 font-black' };
      return { code: '1', label: '판매', text: '판매', tone: 'selling', className: 'text-emerald-700 font-black' };
    }

    return { code: '-', label: '-', text: '-', tone: 'muted', className: 'text-slate-400 font-bold' };
  };

  // ============================================================
  // HISTORY ENGINE
  // ============================================================
  const HISTORY = ONEAPP.HISTORY = ONEAPP.HISTORY || {};
  const HISTORY_KEY = 'merchHistory_v870';

  HISTORY.calcDiffRate = calcDiffRate;
  HISTORY.getNowISO = getNowISO;

  HISTORY.normalizeHistoryLog = (log = {}) => {
    const oldVal = log.oldVal ?? log.beforeVal ?? '';
    const newVal = log.newVal ?? log.afterVal ?? '';
    const oldNum = parseNum(oldVal);
    const newNum = parseNum(newVal);
    const hasNumeric = String(oldVal).match(/[0-9]/) || String(newVal).match(/[0-9]/);
    const diff = log.diff !== undefined ? Number(log.diff) : (hasNumeric ? newNum - oldNum : 0);
    const diffRate = log.diffRate !== undefined ? log.diffRate : calcDiffRate(oldVal, newVal);

    return {
      id: log.id || generateUUID(),
      timestamp: log.timestamp || new Date().toLocaleString('ko-KR'),
      timestampISO: log.timestampISO || log.createdAtISO || log.savedAtISO || getNowISO(),
      source: String(log.source || log.origin || log.sourceRole || 'unknown'),
      sourceRole: String(log.sourceRole || log.role || log.source || log.origin || 'unknown'),
      sourceLabel: String(log.sourceLabel || ''),
      actionType: String(log.actionType || log.action || 'change'),
      applyMode: String(log.applyMode || ''),
      path: String(log.path || log.route || ''),
      route: String(log.route || log.path || ''),
      catalog: String(log.catalog || log.catalogName || ''),
      catalogName: String(log.catalogName || log.catalog || ''),
      estimate: String(log.estimate || log.quoteName || log.quote || log.견적서 || ''),
      quoteName: String(log.quoteName || log.estimate || log.quote || log.견적서 || ''),
      code: String(log.code || ''),
      name: String(log.name || ''),
      spec: String(log.spec || ''),
      unit: String(log.unit || ''),
      parsedName: String(log.parsedName || ''),
      parsedSpec: String(log.parsedSpec || ''),
      parsedUnit: String(log.parsedUnit || ''),
      parsedInPrice: log.parsedInPrice !== undefined ? parseNum(log.parsedInPrice) : undefined,
      parsedSoldOut: !!log.parsedSoldOut,
      matchStatus: String(log.matchStatus || ''),
      field: String(log.field || ''),
      oldVal,
      newVal,
      diff,
      diffRate,
      oldOutPrice: log.oldOutPrice,
      newOutPrice: log.newOutPrice,
      oldSalePrice: log.oldSalePrice,
      newSalePrice: log.newSalePrice,
      oldInPrice: log.oldInPrice,
      stockQty: log.stockQty,
      safeStock: log.safeStock,
      marginRate: log.marginRate,
      memo: String(log.memo || log.note || '')
    };
  };

  HISTORY.buildHistoryLog = (payload = {}) => {
    return HISTORY.normalizeHistoryLog({
      id: generateUUID(),
      timestamp: new Date().toLocaleString('ko-KR'),
      timestampISO: getNowISO(),
      ...payload
    });
  };

  HISTORY.addHistoryLogs = (newLogs = [], options = {}) => {
    const limit = options.limit || 5000;
    const logs = Array.isArray(newLogs) ? newLogs : [newLogs];
    const normalized = logs.filter(Boolean).map(HISTORY.normalizeHistoryLog);

    let current = [];
    try { current = JSON.parse(global.localStorage.getItem(HISTORY_KEY) || '[]') || []; } catch (e) { current = []; }

    const merged = [...normalized, ...current].slice(0, limit);
    global.localStorage.setItem(HISTORY_KEY, JSON.stringify(merged));
    return merged;
  };

  HISTORY.verifyHistorySaved = (newLogs = []) => {
    const logs = Array.isArray(newLogs) ? newLogs : [newLogs];
    if (logs.length === 0) return true;

    let current = [];
    try { current = JSON.parse(global.localStorage.getItem(HISTORY_KEY) || '[]') || []; } catch (e) { return false; }

    const ids = new Set(current.map(log => log && log.id));
    return logs.every(log => log && log.id && ids.has(log.id));
  };

  HISTORY.assertHistoryForMutation = (mutationCount, logs = []) => {
    if (mutationCount > 0 && (!Array.isArray(logs) || logs.length === 0)) {
      throw new Error('마스터 변경 항목이 있으나 히스토리 로그가 생성되지 않았습니다.');
    }
    return true;
  };

  // ============================================================
  // EXPORT DRAFT ENGINE
  // ============================================================
  const EXPORT = ONEAPP.EXPORT = ONEAPP.EXPORT || {};

  const getValueFromRow = (row = {}, master = {}, key, defaultValue = '') => {
    const finalData = row.finalData || {};
    const sources = row.sources || {};
    const inventory = sources.inventory || {};
    const estimate = sources.estimate || {};
    const purchase = sources.purchase || {};
    const sales = sources.sales || {};

    if (finalData[key] !== undefined && finalData[key] !== '') return finalData[key];
    if (inventory[key] !== undefined && inventory[key] !== '') return inventory[key];
    if (estimate[key] !== undefined && estimate[key] !== '') return estimate[key];
    if (purchase[key] !== undefined && purchase[key] !== '') return purchase[key];
    if (sales[key] !== undefined && sales[key] !== '') return sales[key];
    if (master[key] !== undefined && master[key] !== '') return master[key];
    return defaultValue;
  };

  EXPORT.buildWorkingPayload = (row = {}, master = {}) => {
    const finalData = row.finalData || {};
    const getValue = (key, defaultValue = '') => getValueFromRow(row, master, key, defaultValue);
    const getNum = (key, defaultValue = 0) => parseNum(getValue(key, defaultValue));
    const getStr = (key, defaultValue = '') => {
      const val = getValue(key, defaultValue);
      return val !== undefined && val !== null ? String(val) : defaultValue;
    };

    const inventory = row.sources?.inventory || {};
    const estimate = row.sources?.estimate || {};
    const purchase = row.sources?.purchase || {};
    const sales = row.sources?.sales || {};
    const info = row.sources?.info || {};
    const stockRaw = finalData['재고수량'] ?? info['재고수량'] ?? info['재고'] ?? inventory['재고수량'] ?? inventory['안전재고'] ?? estimate['재고수량'];
    const stockQty = stockRaw !== undefined && stockRaw !== null && stockRaw !== '' ? parseNum(stockRaw) : 999;
    const promoThemeCodes = parsePromotionThemeCodes(finalData, info, inventory, estimate, purchase, sales, master);
    const hasPromoTheme = (n) => promoThemeCodes.includes(String(n));

    return {
      품목명: getStr('품목명'),
      규격: getStr('규격'),
      브랜드: getStr('브랜드'),
      간단설명: getStr('간단설명'),
      창고: getStr('창고'),
      단위: getStr('단위'),
      _calcWarehouse: getStr('_calcWarehouse'),
      _calcWarehouseReason: getStr('_calcWarehouseReason'),
      입고가: getNum('입고가'),
      출고가: getNum('출고가'),
      행사가: getNum('행사가'),
      도매A: getNum('도매A'),
      도매B: getNum('도매B'),
      시중가: getNum('시중가'),
      입고B: getNum('입고B'),
      판매여부: finalData._salesStopRequested === true ? 0 : (finalData['판매여부'] !== undefined ? finalData['판매여부'] : ''),
      '1종코드': getStr('1종코드'),
      '1종규격': getStr('1종규격'),
      '1종연산': getNum('1종연산'),
      '1당수량': getNum('1당수량'),
      '경비': getNum('경비'),
      '외주비': getNum('외주비'),
      '노무비': getNum('노무비'),
      재고수량: stockQty,
      행사테마: promoThemeCodes.join(','),
      테마1: hasPromoTheme(1) ? '1' : '',
      테마2: hasPromoTheme(2) ? '1' : '',
      테마3: hasPromoTheme(3) ? '1' : '',
      테마4: hasPromoTheme(4) ? '1' : '',
      테마5: hasPromoTheme(5) ? '1' : '',
      카테고리: getStr('견적서') || getStr('카테고리'),
      검색어등록: getStr('검색어등록')
    };
  };

  EXPORT.buildBaselineSnapshot = (master = {}) => {
    const salesState = PRICING.getMasterSalesState(master);
    return {
      기준입고가: parseNum(master['입고가']),
      기준출고가: parseNum(master['출고가']),
      기준행사가: parseNum(master['행사가']),
      기준시중가: parseNum(master['시중가']),
      기준판매여부: master['판매여부'] !== undefined && master['판매여부'] !== '' ? master['판매여부'] : salesState.text,
      기준상태코드: salesState.code,
      기준상태명: salesState.label
    };
  };

  EXPORT.buildSourceSummary = (row = {}) => {
    const sources = row.sources || {};
    const inventory = sources.inventory || {};
    const estimate = sources.estimate || {};
    const purchase = sources.purchase || {};
    const sales = sources.sales || {};
    const tags = row._tags ? Array.from(row._tags) : [];

    return {
      hasInventory: Object.keys(inventory).length > 0,
      hasEstimate: Object.keys(estimate).length > 0,
      hasPurchase: Object.keys(purchase).length > 0,
      hasSales: Object.keys(sales).length > 0,
      tags,
      sourceType: tags.join(', '),
      inventoryKeys: Object.keys(inventory),
      estimateKeys: Object.keys(estimate),
      purchaseKeys: Object.keys(purchase),
      salesKeys: Object.keys(sales)
    };
  };

  EXPORT.buildExportDraft = ({ targetRows = [], masterProducts = {} } = {}) => {
    const rows = Array.isArray(targetRows) ? targetRows : [];
    return rows
      .filter(row => row && row.코드)
      .map(row => {
        const code = row.코드;
        const master = masterProducts[code] || {};
        return {
          코드: code,
          working: EXPORT.buildWorkingPayload(row, master),
          baselineSnapshot: EXPORT.buildBaselineSnapshot(master),
          source: EXPORT.buildSourceSummary(row)
        };
      });
  };

  EXPORT.validateExportDraft = (exportDraft = []) => {
    if (!Array.isArray(exportDraft)) return { ok: false, message: 'exportDraft가 배열이 아닙니다.' };
    const invalid = exportDraft.filter(item => !item || !item.코드 || !item.working);
    if (invalid.length > 0) return { ok: false, message: `유효하지 않은 draft ${invalid.length}건이 있습니다.` };
    return { ok: true, message: 'OK', count: exportDraft.length };
  };

  // ============================================================
  // CLOUD ENGINE
  // ============================================================
  const CLOUD = ONEAPP.CLOUD = ONEAPP.CLOUD || {};

  // ============================================================
  // CLOUD URL / DATAOPS MASTER SYNC SETTINGS
  // - URL은 고정 하드코딩이 아니라 사용자가 설정값으로 변경 가능해야 한다.
  // - 기본 URL은 최초 실행/복원용 fallback으로만 사용한다.
  // ============================================================
  const ONEAPP_CLOUD_URL_KEY = 'oneapp_cloud_sync_url_v1';
  const ONEAPP_DEFAULT_CLOUD_SYNC_URL = 'https://script.google.com/macros/s/AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw/exec';
  const DATAOPS_MASTER_CACHE_KEY = 'dataops_merch_master_cache_v1';
  const DATAOPS_MASTER_SUMMARY_KEY = 'dataops_merch_master_summary_v1';
  const DATAOPS_RAW_SUBDIVISION_KEY = 'dataops_raw_subdivision_cache_v1';

  const appendQueryParam = (url, key, value) => {
    const safeUrl = String(url || '').trim();
    if (!safeUrl) return '';
    const sep = safeUrl.includes('?') ? '&' : '?';
    return `${safeUrl}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  };

  CLOUD.getDefaultCloudSyncUrl = () => ONEAPP_DEFAULT_CLOUD_SYNC_URL;

  CLOUD.getCloudSyncUrl = () => {
    try {
      const saved = String(global.localStorage.getItem(ONEAPP_CLOUD_URL_KEY) || '').trim();
      return saved || ONEAPP_DEFAULT_CLOUD_SYNC_URL;
    } catch (e) {
      return ONEAPP_DEFAULT_CLOUD_SYNC_URL;
    }
  };

  CLOUD.setCloudSyncUrl = (url) => {
    const safeUrl = String(url || '').trim();
    if (!safeUrl) throw new Error('클라우드 URL이 비어 있습니다.');
    try {
      global.localStorage.setItem(ONEAPP_CLOUD_URL_KEY, safeUrl);
    } catch (e) {
      throw new Error('클라우드 URL 저장에 실패했습니다.');
    }
    return safeUrl;
  };

  CLOUD.ensureDefaultCloudSyncUrl = () => {
    try {
      const current = String(global.localStorage.getItem(ONEAPP_CLOUD_URL_KEY) || '').trim();
      if (!current) global.localStorage.setItem(ONEAPP_CLOUD_URL_KEY, ONEAPP_DEFAULT_CLOUD_SYNC_URL);
    } catch (e) {}
    return CLOUD.getCloudSyncUrl();
  };

  CLOUD.buildMasterOnlyUrl = (url) => appendQueryParam(url || CLOUD.getCloudSyncUrl(), 'action', 'master_only');

  CLOUD.buildCloudConfigPayload = async (config = {}) => {
    const pendingShopStatus = await STORAGE.getIDB('pending_shop_status').catch(() => []);
    const dict = safeJSONParse('parserDict_v870', {});

    return {
      dict,
      rules: config.marginRules || config.rules || [],
      pendingShopStatus: pendingShopStatus || [],
      appConfig: {
        mappings: config.mappings || {},
        masterLinks: config.masterLinks || {},
        visibleUploadCols: config.visibleUploadCols || {},
        visibleMasterCols: config.visibleMasterCols || {},
        uploadColumnMeta: config.uploadColumnMeta || {}
      }
    };
  };

  CLOUD.normalizeMasterItemForDataOps = (item = {}, fallbackCode = '') => {
    const code = String(item.코드 || item['품목코드'] || fallbackCode || '').trim();
    return {
      ...item,
      코드: code,
      품목코드: String(item['품목코드'] || code).trim(),
      품목명: String(item['품목명'] || '').trim(),
      규격: String(item['규격'] || '').trim(),
      단위: String(item['단위'] || '').trim(),
      창고: String(item['창고'] || '').trim(),
      기본: item['기본'],
      입고가: parseNum(item['입고가']),
      출고가: parseNum(item['출고가']),
      도매A: parseNum(item['도매A']),
      도매B: parseNum(item['도매B']),
      상장가: parseNum(item['상장가']),
      행사가: parseNum(item['행사가']),
      판매여부: item['판매여부'],
      '1종코드': String(item['1종코드'] || '').trim(),
      '1종규격': String(item['1종규격'] || '').trim(),
      '1종연산': parseNum(item['1종연산']),
      '1당수량': parseNum(item['1당수량']),
      '2종코드': String(item['2종코드'] || '').trim(),
      '2종규격': String(item['2종규격'] || '').trim(),
      '2종연산': parseNum(item['2종연산']),
      외주비: parseNum(item['외주비']),
      노무비: parseNum(item['노무비']),
      경비: parseNum(item['경비'])
    };
  };

  CLOUD.buildRawSubdivisionFromMaster = (masterMap = {}) => {
    const items = Object.entries(masterMap || {}).map(([code, item]) => CLOUD.normalizeMasterItemForDataOps(item, code));
    const relations = [];
    const issues = [];

    const isValidSubCode = (code) => {
      const s = String(code || '').trim();
      return s !== '' && s !== '0' && s !== '00' && s !== '-' && s.toLowerCase() !== 'undefined' && s.toLowerCase() !== 'null';
    };

    items.forEach(item => {
      const rawCode = String(item.코드 || item['품목코드'] || '').trim();
      const subCode = String(item['1종코드'] || '').trim();
      const subSpec = String(item['1종규격'] || '').trim();
      const costRate = parseNum(item['1종연산']);
      const stockRate = parseNum(item['1당수량']);

      if (!rawCode) {
        issues.push({ type: 'NO_RAW_CODE', message: '원물 품목코드 없음', item });
        return;
      }

      if (!isValidSubCode(subCode)) return;

      if (costRate <= 0) {
        issues.push({ type: 'NO_SUB_COST_RATE', message: '1종코드는 있으나 원가계수(1종연산) 없음', rawCode, subCode, item });
      }

      if (stockRate <= 0) {
        issues.push({ type: 'NO_SUB_STOCK_RATE', message: '1종코드는 있으나 재고수량계수(1당수량) 없음', rawCode, subCode, item });
      }

      if (costRate <= 0 && stockRate <= 0) return;

      relations.push({
        source: 'MerchOpsMasterDB',
        rawCode,
        rawName: item['품목명'] || '',
        rawSpec: item['규격'] || '',
        rawUnit: item['단위'] || '',
        subCode,
        subNameSpec: subSpec,
        subSpec,
        subUnit: '',
        // 기존 DataOps 호환값: 원가 산출용 1종연산을 conversionRate로 유지한다.
        conversionRate: costRate,
        costConversionRate: costRate,
        stockConversionRate: stockRate,
        stockQtyPerRaw: stockRate,
        costMethod: 'raw_cost_divide_1종연산',
        stockMethod: 'raw_stock_multiply_1당수량',
        rawDeductMethod: 'ceil',
        active: true,
        createdFrom: '1종코드',
        memo: ''
      });
    });

    const bySubCode = {};
    const byRawCode = {};

    relations.forEach(rel => {
      if (rel.subCode) bySubCode[rel.subCode] = rel;
      if (rel.rawCode) {
        if (!byRawCode[rel.rawCode]) byRawCode[rel.rawCode] = [];
        byRawCode[rel.rawCode].push(rel);
      }
    });

    return {
      relations,
      bySubCode,
      byRawCode,
      issues,
      summary: {
        relationCount: relations.length,
        issueCount: issues.length
      }
    };
  };

  CLOUD.pullMerchMasterForDataOps = async ({ url, onProgress } = {}) => {
    const targetUrl = String(url || CLOUD.getCloudSyncUrl() || '').trim();
    if (!targetUrl) throw new Error('클라우드 URL이 없습니다.');

    if (typeof onProgress === 'function') {
      onProgress({ step: 'download', message: 'MerchOps MasterDB 수신 중...' });
    }

    const requestUrl = CLOUD.buildMasterOnlyUrl(targetUrl);
    const res = await fetch(requestUrl, { method: 'GET' });
    if (!res.ok) throw new Error('MerchOps MasterDB 다운로드 실패');

    const result = await res.json();
    if (!result || result.status !== 'success' || !result.data) {
      throw new Error(result?.message || 'MerchOps MasterDB 응답 형식 오류');
    }

    const rawMaster = result.data.master || {};
    const normalizedMaster = {};

    Object.entries(rawMaster).forEach(([code, item]) => {
      const normalized = CLOUD.normalizeMasterItemForDataOps(item, code);
      if (normalized.코드) normalizedMaster[normalized.코드] = normalized;
    });

    const masterItems = Object.values(normalizedMaster);
    const rawSubdivision = CLOUD.buildRawSubdivisionFromMaster(normalizedMaster);

    await STORAGE.bulkPutIDB(STORE_MASTER, masterItems).catch(() => false);
    await STORAGE.setIDB(DATAOPS_MASTER_CACHE_KEY, normalizedMaster).catch(() => false);
    await STORAGE.setIDB(DATAOPS_RAW_SUBDIVISION_KEY, rawSubdivision).catch(() => false);

    const summary = {
      ...(result.data.summary || {}),
      normalizedCount: masterItems.length,
      rawSubdivisionCount: rawSubdivision.relations.length,
      rawSubdivisionIssueCount: rawSubdivision.issues.length,
      syncedAt: new Date().toISOString(),
      url: targetUrl
    };

    try {
      global.localStorage.setItem(DATAOPS_MASTER_SUMMARY_KEY, JSON.stringify(summary));
      global.localStorage.setItem('dataops_master_sync_trigger', Date.now().toString());
    } catch (e) {}

    if (typeof onProgress === 'function') {
      onProgress({
        step: 'done',
        message: `마스터 ${summary.normalizedCount || 0}건 / 소분관계 ${summary.rawSubdivisionCount || 0}건 불러오기 완료`
      });
    }

    return { status: 'success', master: normalizedMaster, rawSubdivision, summary };
  };

  CLOUD.getCachedMerchMasterForDataOps = async () => {
    const master = await STORAGE.getIDB(DATAOPS_MASTER_CACHE_KEY).catch(() => null);
    const rawSubdivision = await STORAGE.getIDB(DATAOPS_RAW_SUBDIVISION_KEY).catch(() => null);
    const summary = safeJSONParse(DATAOPS_MASTER_SUMMARY_KEY, {});

    return {
      master: master || {},
      rawSubdivision: rawSubdivision || { relations: [], bySubCode: {}, byRawCode: {}, issues: [], summary: {} },
      summary
    };
  };

  CLOUD.chunkUpload = async ({ url, action, data = [], chunkSize = 500, onProgress }) => {
    if (!url) throw new Error('클라우드 URL이 없습니다.');
    const items = Array.isArray(data) ? data : [];

    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      if (typeof onProgress === 'function') onProgress({ action, sent: Math.min(i + chunkSize, items.length), total: items.length });
      const res = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ action, data: chunk })
      });
      const json = await res.json();
      if (!json || json.status !== 'success') throw new Error(json?.message || `${action} 업로드 실패`);
    }

    return { status: 'success', total: items.length };
  };

  CLOUD.pushCloudBackup = async ({ url, masterProducts = {}, historyLogs = [], config = {}, chunkSize = 500, onProgress }) => {
    const targetUrl = String(url || CLOUD.getCloudSyncUrl() || '').trim();
    if (!targetUrl) throw new Error('클라우드 URL이 없습니다.');

    if (typeof onProgress === 'function') onProgress({ step: 'init', message: '서버 초기화 중...' });
    const initRes = await fetch(targetUrl, { method: 'POST', body: JSON.stringify({ action: 'initSync' }) });
    const initJson = await initRes.json();
    if (!initJson || initJson.status !== 'success') throw new Error(initJson?.message || '초기화 실패');

    const masterItems = Array.isArray(masterProducts) ? masterProducts : Object.values(masterProducts || {});
    await CLOUD.chunkUpload({
      url: targetUrl,
      action: 'chunk_master',
      data: masterItems,
      chunkSize,
      onProgress: p => onProgress && onProgress({ ...p, step: 'master', message: `마스터 데이터 업로드 중... (${p.sent} / ${p.total}건)` })
    });

    const safeHistory = Array.isArray(historyLogs) ? historyLogs : [];
    await CLOUD.chunkUpload({
      url: targetUrl,
      action: 'chunk_history',
      data: safeHistory,
      chunkSize,
      onProgress: p => onProgress && onProgress({ ...p, step: 'history', message: `히스토리 업로드 중... (${p.sent} / ${p.total}건)` })
    });

    if (typeof onProgress === 'function') onProgress({ step: 'config', message: '환경설정 및 대기열 업로드 중...' });
    const configPayload = await CLOUD.buildCloudConfigPayload(config);
    const configRes = await fetch(targetUrl, {
      method: 'POST',
      body: JSON.stringify({ action: 'config', data: configPayload })
    });
    const configJson = await configRes.json();
    if (!configJson || configJson.status !== 'success') throw new Error(configJson?.message || '설정 업로드 실패');

    return { status: 'success', masterCount: masterItems.length, historyCount: safeHistory.length };
  };

  CLOUD.restoreCloudData = async (result = {}, hooks = {}) => {
    if (!result || result.status !== 'success' || !result.data) throw new Error('복구 데이터 형식이 올바르지 않습니다.');
    const data = result.data;

    if (data.master && Object.keys(data.master).length > 0) {
      const safeData = Object.values(data.master).filter(item => item && item.코드);
      await STORAGE.bulkPutIDB(STORE_MASTER, safeData);
      global.localStorage.setItem('merchMaster_sync_trigger', Date.now().toString());
      if (typeof hooks.setMasterProducts === 'function') hooks.setMasterProducts(data.master);
    }

    if (data.history && Array.isArray(data.history)) {
      global.localStorage.setItem(HISTORY_KEY, JSON.stringify(data.history));
      if (typeof hooks.setHistoryLogs === 'function') hooks.setHistoryLogs(data.history);
    }

    if (data.dict && Object.keys(data.dict).length > 0) {
      global.localStorage.setItem('parserDict_v870', JSON.stringify(data.dict));
    }

    if (data.pendingShopStatus) {
      await STORAGE.setIDB('pending_shop_status', data.pendingShopStatus);
    }

    const appConfig = data.appConfig || {};
    if (data.rules && data.rules.length > 0) {
      global.localStorage.setItem('merchMarginRules_v878', JSON.stringify(data.rules));
      if (typeof hooks.setMarginRules === 'function') hooks.setMarginRules(data.rules);
    }

    const configKeyMap = {
      mappings: ['merchMappings_v870', 'setMappings'],
      masterLinks: ['merchMasterLinks_v870', 'setMasterLinks'],
      visibleUploadCols: ['merchVisUpload_v870', 'setVisibleUploadCols'],
      visibleMasterCols: ['merchVisMaster_v870', 'setVisibleMasterCols'],
      uploadColumnMeta: ['merchUploadColumnMeta_v870', 'setUploadColumnMeta']
    };

    Object.keys(configKeyMap).forEach(key => {
      if (appConfig[key]) {
        const [storageKey, hookName] = configKeyMap[key];
        global.localStorage.setItem(storageKey, JSON.stringify(appConfig[key]));
        if (typeof hooks[hookName] === 'function') hooks[hookName](appConfig[key]);
      }
    });

    global.localStorage.setItem('config_sync_trigger', Date.now().toString());
    return data;
  };

  CLOUD.pullCloudBackup = async ({ url, hooks = {}, onProgress }) => {
    const targetUrl = String(url || CLOUD.getCloudSyncUrl() || '').trim();
    if (!targetUrl) throw new Error('클라우드 URL이 없습니다.');
    if (typeof onProgress === 'function') onProgress({ step: 'download', message: '클라우드 데이터 수신 중...' });

    const res = await fetch(targetUrl, { method: 'GET' });
    if (!res.ok) throw new Error('Network Error');
    const result = await res.json();
    const data = await CLOUD.restoreCloudData(result, hooks);
    return { status: 'success', data };
  };



  // ============================================================
  // MASTER EXCEL UPLOAD ENGINE
  // 목적: 환경설정에서 마스터 엑셀 원장을 품목코드 기준으로 비교하고,
  //       엑셀에 있는 컬럼만 안전하게 master_products에 병합 적용한다.
  // 정책:
  // - 기준키: 품목코드 우선, 없으면 코드/상품코드/바코드 후보
  // - 컬럼 없음: 기존값 유지
  // - 컬럼 있음 + 공란: 공란으로 반영
  // - 엑셀에 없는 기존 마스터: 삭제/정지하지 않고 유지
  // - 적용 전 자동 백업, 변경된 항목만 히스토리 기록
  // ============================================================
  const MASTER = ONEAPP.MASTER = ONEAPP.MASTER || {};
  const MASTER_BACKUP_KEY = 'merchMasterBackups_v1';

  const MASTER_FIELD_ALIASES = {
    '상품코드': '품목코드',
    '바코드': '품목코드',
    '상품번호': '품목코드',
    '상품명': '품목명',
    '품명': '품목명',
    '상품이름': '품목명',
    '규격명': '규격',
    '사이즈': '규격',
    '단량': '규격',
    'A판매': '도매A',
    'A판매가': '도매A',
    'B판매': '도매B',
    'B판매가': '도매B',
    'B도매가': '도매B',
    '매입가': '입고가',
    '구매단가': '입고가',
    '매입단가': '입고가',
    '판매가': '출고가',
    '판매단가': '출고가',
    '행사': '행사가',
    '특가': '행사가',
    '테마': '행사테마',
    '프로모션테마': '행사테마',
    '행사 테마': '행사테마',
    '테마번호': '행사테마',
    '포장단위': '단위',
    '판매단위': '단위',
    '매입단위': '단위',
    'UNIT': '단위',
    'unit': '단위',
    '카테고리': '견적서',
    '템플릿': '견적서',
    '견적분류': '견적서',
    // 쇼핑몰 정보(info) 파일 컬럼 매핑
    '판매가격': '출고가',
    '시중가격': '시중가',
    '판매': '판매여부',
    '재고': '재고수량',
    '기본설명': '간단설명',
    '상품태그': '검색어등록',
    '테마1': '행사테마',
    '테마2': '행사테마',
    '테마3': '행사테마',
    '테마4': '행사테마',
    '테마5': '행사테마',
    '기본여부': '기본',
    '관리구분': '기본'
  };

  MASTER.canonicalMasterFieldName = (field = '') => {
    const clean = String(field ?? '').trim();
    if (!clean) return '';
    // 오더즈판매가/오더즈구매가는 입점사 전용 노출가격이므로 MerchOps 표준 가격 필드로 연결하지 않는다.
    if (INFO_EXCLUDED_MASTER_FIELDS.includes(clean)) return '';
    return MASTER_FIELD_ALIASES[clean] || clean;
  };

  MASTER.normalizeMasterCode = (v) => String(v ?? '').trim().replace(/\s/g, '');

  MASTER.getMasterCode = (item = {}) => {
    const direct = item['품목코드'] ?? item['상품코드'] ?? item['바코드'] ?? item['상품번호'] ?? item['코드'];
    return MASTER.normalizeMasterCode(direct);
  };

  MASTER.getMasterStorageKey = (item = {}) => {
    const code = MASTER.getMasterCode(item);
    return code || MASTER.normalizeMasterCode(item['코드']);
  };

  MASTER.normalizeMasterCellValue = (field, value) => {
    if (value === undefined || value === null) return '';
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

    return {
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
    await STORAGE.bulkPutIDB(STORE_MASTER, items);
    global.localStorage.setItem('merchMaster_sync_trigger', Date.now().toString());
    return backup;
  };

  MASTER.applyMasterExcelUpload = async ({ analysis, currentMaster = {}, label = '마스터엑셀업로드' } = {}) => {
    if (!analysis || !Array.isArray(analysis.candidates)) throw new Error('적용할 마스터 업로드 분석 결과가 없습니다.');
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
    await STORAGE.bulkPutIDB(STORE_MASTER, items);
    if (historyLogs.length > 0) HISTORY.addHistoryLogs(historyLogs);
    global.localStorage.setItem('merchMaster_sync_trigger', Date.now().toString());
    global.localStorage.setItem('config_sync_trigger', Date.now().toString());

    return {
      status: 'success',
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
  global.analyzeMasterExcelUpload = global.analyzeMasterExcelUpload || MASTER.analyzeMasterExcelUpload;
  global.applyMasterExcelUpload = global.applyMasterExcelUpload || MASTER.applyMasterExcelUpload;
  global.getMasterBackups = global.getMasterBackups || MASTER.getMasterBackups;
  global.restoreMasterBackup = global.restoreMasterBackup || MASTER.restoreMasterBackup;

})(window);
