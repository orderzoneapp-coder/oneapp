/**
 * ONEAPP MerchOps - coreEngine.js
 * v1.0.0 / 1단계 공통 엔진 초안
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
 */

(function initOneAppCore(global) {
  'use strict';

  const ONEAPP = global.ONEAPP = global.ONEAPP || {};
  ONEAPP.VERSION = ONEAPP.VERSION || 'coreEngine-v1.0.0';

  const DEFAULT_DB_NAME = 'MerchOpsDB';
  const DEFAULT_DB_VERSION = 2;
  const STORE_KV = 'store';
  const STORE_MASTER = 'master_products';

  const MASTER_HEADERS = global.MASTER_HEADERS || [
    "창고", "1코드", "1그룹명", "2코드", "2그룹명", "3코드", "3그룹명", "오더즈", "구매처", "브랜드",
    "품목코드", "품목명", "규격", "안전재고", "간단설명", "카탈로그", "견적서", "출고가", "입고가",
    "입고B", "도매A", "도매B", "상장가", "최종전송", "최종입고", "단가H", "단가I", "시중가",
    "행사가", "판매여부", "1종코드", "1종규격", "1종연산", "2종코드", "2종규격", "2종연산",
    "외주비", "노무비", "경비", "비과세", "기본", "연동", "싯가", "단위", "준비기간", "마감시간", "검색어등록"
  ];

  const NUMERIC_HEADERS = global.NUMERIC_HEADERS || [
    "안전재고", "출고가", "입고가", "입고B", "도매A", "도매B", "상장가", "최종전송", "최종입고",
    "단가H", "단가I", "시중가", "행사가", "1종연산", "2종연산", "외주비", "노무비", "경비",
    "1구매", "1출고", "2구매", "2출고", "1입고", "2입고", "재고수량"
  ];

  global.MASTER_HEADERS = global.MASTER_HEADERS || MASTER_HEADERS;
  global.NUMERIC_HEADERS = global.NUMERIC_HEADERS || NUMERIC_HEADERS;

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

  const matchWh = (ruleWh, targetWh) => {
    if (!ruleWh || ruleWh === '*') return true;
    const target = String(targetWh || '').trim();
    const targets = String(ruleWh).split(/[,./|\s]+/).map(s => s.trim()).filter(Boolean);
    return targets.some(s => s === target || (target !== '' && !isNaN(s) && !isNaN(target) && Number(s) === Number(target)));
  };

  const matchUnit = (ruleUnit, targetUnit) => {
    if (!ruleUnit || ruleUnit === '*') return true;
    const target = String(targetUnit || '').trim().toLowerCase();
    const targets = String(ruleUnit).toLowerCase().split(/[,./|\s]+/).map(s => s.trim()).filter(Boolean);
    return targets.some(s => target === s || target.includes(s));
  };

  const findBestMarginRule = (marginRules = [], context = {}) => {
    const whCode = String(context['창고'] ?? context.whCode ?? '').trim();
    const unitStr = String(context['단위'] ?? context.unit ?? '').trim().toLowerCase();
    let bestRule = null;
    let bestScore = -1;
    const safeRules = Array.isArray(marginRules) ? marginRules : [];

    safeRules.forEach(rule => {
      if (matchWh(rule.whCode, whCode) && matchUnit(rule.unit, unitStr)) {
        let score = 0;
        if (rule.whCode && rule.whCode !== '*') score += 2;
        if (rule.unit && rule.unit !== '*') score += 1;
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
      창고: currentFinalData?.['창고'] ?? mItem?.['창고'] ?? '',
      단위: currentFinalData?.['단위'] ?? mItem?.['단위'] ?? ''
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

  PRICING.computeFinalData = (mItem = {}, sources = {}, marginRules = [], forceRecalc = false) => {
    const inv = sources.inventory || {};
    const est = sources.estimate || {};

    const invStock = inv['재고수량'] !== undefined ? parseNum(inv['재고수량']) : (inv['안전재고'] !== undefined ? parseNum(inv['안전재고']) : 999);
    const hasInv = Object.keys(inv).length > 0;
    const hasEst = Object.keys(est).length > 0;

    const invPromo = parseNum(inv['행사가']);
    const estPromo = parseNum(est['행사가']);

    const invInPrice = inv['입고가'] !== undefined ? parseNum(inv['입고가']) : parseNum(mItem['입고가']);
    const estInPrice = est['입고가'] !== undefined ? parseNum(est['입고가']) : parseNum(mItem['입고가']);
    const masterInPrice = parseNum(mItem['입고가']);

    const invProvidedOut = parseNum(inv['출고가']);
    const estProvidedOut = parseNum(est['출고가']);
    const masterProvidedOut = parseNum(mItem['출고가']);
    const masterProvidedMarket = parseNum(mItem['시중가']);

    const invTargetOut = PRICING.calculatePricesEngine(invInPrice, invProvidedOut, mItem, inv, marginRules, forceRecalc);
    const estTargetOut = PRICING.calculatePricesEngine(estInPrice, estProvidedOut, mItem, est, marginRules, forceRecalc);
    const masterTargetOut = PRICING.calculatePricesEngine(masterInPrice, masterProvidedOut, mItem, {}, marginRules, forceRecalc);

    const finalMarketPrice = forceRecalc ? masterTargetOut : (masterProvidedMarket > 0 ? masterProvidedMarket : masterTargetOut);

    let targetSource = {};
    let theme = 0;
    let isPromo = false;
    let normalPrice = 0;

    if (hasInv && invStock > 0 && invPromo > 0 && !forceRecalc) {
      targetSource = { ...inv, 입고가: invInPrice, 출고가: invTargetOut, 행사가: invPromo };
      theme = 2;
      isPromo = true;
      normalPrice = invTargetOut;
    } else if (hasEst && estPromo > 0 && !forceRecalc) {
      targetSource = { ...est, 입고가: estInPrice, 출고가: estTargetOut, 행사가: estPromo };
      theme = 1;
      isPromo = true;
      normalPrice = estTargetOut;
    } else if (hasInv && invStock > 0) {
      targetSource = { ...inv, 입고가: invInPrice, 출고가: invTargetOut };
      theme = 0;
      normalPrice = invTargetOut;
    } else if (hasEst) {
      targetSource = { ...est, 입고가: estInPrice, 출고가: estTargetOut };
      theme = 0;
      normalPrice = estTargetOut;
    } else {
      targetSource = { 입고가: masterInPrice, 출고가: masterTargetOut };
      theme = 0;
      normalPrice = masterTargetOut;
    }

    if (targetSource['입고가'] === 0) targetSource['출고가'] = 0;
    targetSource['시중가'] = finalMarketPrice;
    targetSource._theme = theme;
    targetSource._isPromo = isPromo;
    targetSource._normalPrice = normalPrice;

    return targetSource;
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

  PRICING.calculateSubPriceInfo = (row = {}) => {
    const div1 = parseNum(row['1종연산']);
    if (!PRICING.isValidSubItemCode(row['1종코드']) || div1 <= 0) return null;

    const inPrice = parseNum(row.입고가);
    const outPrice = parseNum(row.출고가); // 확정 정책: 원물 기본 출고가 기준
    const outsrc = parseNum(row['외주비']);
    const extraCost = parseNum(row['경비']);

    const subIn = inPrice > 0 ? Math.round(((inPrice + outsrc) / div1) / 100) * 100 : 0;
    const rawSubOut = outPrice > 0 ? Math.round((outPrice / div1) + extraCost) : 0;
    const subOut = rawSubOut > 0 ? Math.round(rawSubOut / 10) * 10 : 0;

    return {
      code: String(row['1종코드']).trim(),
      spec: row['1종규격'] || '',
      div1,
      subIn,
      subOut
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

    if (statusStr === '0' || statusStr === '정지중' || statusStr === '판매중단' || (!hasSalePrice && hasStatusValue)) {
      return { code: '0', label: '정지중', text: '0 정지중', tone: 'stopped', className: 'text-rose-600 font-black' };
    }

    if (hasSalePrice) {
      if (stockQty === 0) return { code: '1', label: '품절', text: '1 품절', tone: 'soldout', className: 'text-orange-600 font-black' };
      if (promoPrice > 0) return { code: '1', label: '행사중', text: '1 행사중', tone: 'promo', className: 'text-purple-700 font-black' };
      return { code: '1', label: '판매중', text: '1 판매중', tone: 'selling', className: 'text-emerald-700 font-black' };
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
      source: String(log.source || log.origin || 'unknown'),
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

    if (finalData[key] !== undefined && finalData[key] !== '') return finalData[key];
    if (inventory[key] !== undefined && inventory[key] !== '') return inventory[key];
    if (estimate[key] !== undefined && estimate[key] !== '') return estimate[key];
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
    const stockRaw = finalData['재고수량'] ?? inventory['재고수량'] ?? inventory['안전재고'] ?? estimate['재고수량'];
    const stockQty = stockRaw !== undefined && stockRaw !== null && stockRaw !== '' ? parseNum(stockRaw) : 999;

    return {
      품목명: getStr('품목명'),
      규격: getStr('규격'),
      브랜드: getStr('브랜드'),
      간단설명: getStr('간단설명'),
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
      '경비': getNum('경비'),
      '외주비': getNum('외주비'),
      '노무비': getNum('노무비'),
      재고수량: stockQty,
      테마1: finalData._theme === 1 ? '1' : (master['테마1'] || ''),
      테마2: finalData._theme === 2 ? '1' : (master['테마2'] || ''),
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
    const tags = row._tags ? Array.from(row._tags) : [];

    return {
      hasInventory: Object.keys(inventory).length > 0,
      hasEstimate: Object.keys(estimate).length > 0,
      tags,
      sourceType: tags.join(', '),
      inventoryKeys: Object.keys(inventory),
      estimateKeys: Object.keys(estimate)
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
    if (!url) throw new Error('클라우드 URL이 없습니다.');

    if (typeof onProgress === 'function') onProgress({ step: 'init', message: '서버 초기화 중...' });
    const initRes = await fetch(url, { method: 'POST', body: JSON.stringify({ action: 'initSync' }) });
    const initJson = await initRes.json();
    if (!initJson || initJson.status !== 'success') throw new Error(initJson?.message || '초기화 실패');

    const masterItems = Array.isArray(masterProducts) ? masterProducts : Object.values(masterProducts || {});
    await CLOUD.chunkUpload({
      url,
      action: 'chunk_master',
      data: masterItems,
      chunkSize,
      onProgress: p => onProgress && onProgress({ ...p, step: 'master', message: `마스터 데이터 업로드 중... (${p.sent} / ${p.total}건)` })
    });

    const safeHistory = Array.isArray(historyLogs) ? historyLogs : [];
    await CLOUD.chunkUpload({
      url,
      action: 'chunk_history',
      data: safeHistory,
      chunkSize,
      onProgress: p => onProgress && onProgress({ ...p, step: 'history', message: `히스토리 업로드 중... (${p.sent} / ${p.total}건)` })
    });

    if (typeof onProgress === 'function') onProgress({ step: 'config', message: '환경설정 및 대기열 업로드 중...' });
    const configPayload = await CLOUD.buildCloudConfigPayload(config);
    const configRes = await fetch(url, {
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
    if (!url) throw new Error('클라우드 URL이 없습니다.');
    if (typeof onProgress === 'function') onProgress({ step: 'download', message: '클라우드 데이터 수신 중...' });

    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error('Network Error');
    const result = await res.json();
    const data = await CLOUD.restoreCloudData(result, hooks);
    return { status: 'success', data };
  };

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
  global.calculatePricesEngine = global.calculatePricesEngine || PRICING.calculatePricesEngine;
  global.computeFinalData = global.computeFinalData || PRICING.computeFinalData;
  global.getMasterSalesState = global.getMasterSalesState || PRICING.getMasterSalesState;

})(window);
