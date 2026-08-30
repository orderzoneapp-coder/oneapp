(function initDataOpsInventoryMasterBoundary(global) {
  'use strict';

  const clean = (value, fallback = '') => {
    if (value === null || value === undefined) return fallback;
    const text = String(value).trim();
    return text || fallback;
  };

  const unique = (values = []) => Array.from(new Set(values.filter(Boolean)));
  const RETRY_STORAGE_KEY = 'dataops_inventory_master_resume_v1';

  const api = {
    RETRY_STORAGE_KEY,

    normalizeCode(value) {
      return clean(value).replace(/\s/g, '');
    },

    normalizeSearchText(value) {
      return clean(value)
        .normalize('NFKC')
        .toLocaleLowerCase('ko-KR')
        .replace(/[\s\p{P}\p{S}_]+/gu, '');
    },

    tokenize(query) {
      return clean(query)
        .normalize('NFKC')
        .split(/\s+/)
        .map(value => api.normalizeSearchText(value))
        .filter(Boolean);
    },

    getMasterCode(item = {}, fallbackCode = '') {
      return api.normalizeCode(item.품목코드 || item.코드 || item.상품코드 || fallbackCode);
    },

    getSearchFields(item = {}, fallbackCode = '') {
      return [
        api.getMasterCode(item, fallbackCode),
        item.품목명 || item.상품명,
        item.규격,
        item.검색어등록,
      ].map(value => api.normalizeSearchText(value));
    },

    search(masterMap = {}, query = '') {
      const tokens = api.tokenize(query);
      const normalizedWholeQuery = api.normalizeSearchText(query);
      const entries = Object.entries(masterMap || {}).map(([fallbackCode, source]) => {
        const item = source && typeof source === 'object' ? source : {};
        const code = api.getMasterCode(item, fallbackCode);
        return {
          ...item,
          코드: clean(item.코드 || code),
          품목코드: clean(item.품목코드 || code),
          _dataopsMasterSearchCode: code,
          _dataopsMasterSearchFields: api.getSearchFields(item, fallbackCode),
        };
      }).filter(item => item._dataopsMasterSearchCode);
      const matches = tokens.length === 0 ? [] : entries.filter(item => (
        tokens.every(token => item._dataopsMasterSearchFields.some(field => field.includes(token)))
      )).sort((left, right) => (
        clean(left._dataopsMasterSearchCode).localeCompare(clean(right._dataopsMasterSearchCode), 'ko', { numeric: true, sensitivity: 'base' })
        || clean(left.품목명).localeCompare(clean(right.품목명), 'ko', { sensitivity: 'base' })
      ));
      const exactCode = matches.find(item => (
        api.normalizeSearchText(item._dataopsMasterSearchCode) === normalizedWholeQuery
      )) || null;
      const mode = exactCode || matches.length === 1
        ? 'immediate'
        : (matches.length > 1 ? 'choose' : 'register');
      return {
        query: clean(query),
        tokens,
        matches,
        exactCode,
        selected: exactCode || (matches.length === 1 ? matches[0] : null),
        mode,
      };
    },

    isSalesStopped(item = {}) {
      return String(item.판매여부 === undefined || item.판매여부 === null ? '' : item.판매여부).trim() === '0';
    },

    findExistingRow(productData = [], code = '') {
      const target = api.normalizeCode(code);
      if (!target) return null;
      return (productData || []).find(row => api.normalizeCode(row && row.코드) === target) || null;
    },

    buildInventoryRow(masterItem = {}, options = {}) {
      const code = api.getMasterCode(masterItem);
      if (!code) throw new Error('추가할 마스터 상품의 품목코드가 없습니다.');
      const name = clean(masterItem.품목명 || masterItem.상품명);
      const spec = clean(masterItem.규격);
      const unit = clean(masterItem.단위);
      const batchKey = clean(options.batchKey) || `DATAOPS_MASTER_ADD|${code}|${Date.now()}|${Math.random().toString(36).slice(2)}`;
      const wasStopped = api.isSalesStopped(masterItem);
      return {
        batchKey,
        코드: code,
        품명: name,
        규격: spec,
        단위: unit,
        단가: 0,
        행사가: '',
        일자: clean(options.targetDateStr),
        거래처: '목록 외 실사발견',
        기초: 0,
        입고: 0,
        출고: 0,
        대체입고: 0,
        대체출고: 0,
        전산잔량: 0,
        실사: '',
        로스: 0,
        매출액: 0,
        매출원가: 0,
        메모: '목록 외 실사발견',
        상태: '목록 외 실사발견',
        이슈: unique(['목록 외 실사발견', ...(wasStopped ? ['판매중단 · 양수 실사 시 재개대상'] : [])]),
        출고내역: {},
        _orig: { 기초: 0, 입고: 0, 출고: 0, 단가: 0 },
        _raw: { 품목코드: code, 품명: name, 상품명: name, 규격: spec, 단위: unit, 상태: '목록 외 실사발견' },
        isDummy: false,
        수기확인완료: false,
        _inventoryMasterAdded: true,
        _inventoryMasterWasStopped: wasStopped,
        _inventoryMasterResumeRequired: false,
        _inventoryMasterResumeState: wasStopped ? 'awaiting-positive-actual' : '',
        _manualDisplayAfterBatchKey: clean(options.anchorBatchKey),
        _manualDisplayAfterViewBatchKey: clean(options.displayAnchorBatchKey || options.anchorBatchKey),
      };
    },

    applyActual(row = {}, value) {
      const actual = value === '' || value === null || value === undefined ? '' : Number(value);
      if (actual !== '' && (!Number.isFinite(actual) || actual < 0)) {
        throw new Error('실사수량은 0 이상의 숫자로 입력하세요.');
      }
      if (actual === 0) return { action: 'exclude', row: null };
      const resumeRequired = Boolean(row._inventoryMasterWasStopped && actual !== '' && actual > 0);
      const issues = (Array.isArray(row.이슈) ? row.이슈 : [])
        .filter(message => !clean(message).includes('판매재개 대상'));
      if (resumeRequired) issues.push('판매재개 대상');
      return {
        action: 'update',
        row: {
          ...row,
          실사: actual,
          로스: actual === '' ? 0 : actual,
          상태: '목록 외 실사발견',
          이슈: unique(issues),
          _inventoryMasterResumeRequired: resumeRequired,
          _inventoryMasterResumeState: resumeRequired ? 'awaiting-close' : '',
        },
      };
    },

    pinAddedRows(rows = []) {
      const source = Array.isArray(rows) ? rows.slice() : [];
      const pinned = source.filter(row => row && row._inventoryMasterAdded && clean(row._manualDisplayAfterBatchKey));
      if (pinned.length === 0) return source;
      const pinnedKeys = new Set(pinned.map(row => clean(row.batchKey)));
      const result = source.filter(row => !pinnedKeys.has(clean(row && row.batchKey)));
      const unresolved = pinned.slice();
      let guard = unresolved.length + 1;
      while (unresolved.length > 0 && guard-- > 0) {
        let progressed = false;
        for (let index = 0; index < unresolved.length;) {
          const row = unresolved[index];
          const anchorKey = clean(row._manualDisplayAfterBatchKey);
          const anchorIndex = result.findIndex(candidate => clean(candidate && candidate.batchKey) === anchorKey);
          if (anchorIndex < 0) {
            index += 1;
            continue;
          }
          let insertIndex = anchorIndex + 1;
          while (insertIndex < result.length && clean(result[insertIndex] && result[insertIndex]._manualDisplayAfterBatchKey) === anchorKey) insertIndex += 1;
          result.splice(insertIndex, 0, row);
          unresolved.splice(index, 1);
          progressed = true;
        }
        if (!progressed) break;
      }
      unresolved.forEach(row => result.push(row));
      return result;
    },

    readRetryRecords(localStorageRef = global.localStorage) {
      try {
        const parsed = JSON.parse(localStorageRef.getItem(RETRY_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        return {};
      }
    },

    writeRetryRecords(records = {}, localStorageRef = global.localStorage) {
      const normalized = records && typeof records === 'object' && !Array.isArray(records) ? records : {};
      const serialized = JSON.stringify(normalized);
      localStorageRef.setItem(RETRY_STORAGE_KEY, serialized);
      if (localStorageRef.getItem(RETRY_STORAGE_KEY) !== serialized) {
        throw new Error('판매재개 재시도 상태 저장 검증에 실패했습니다.');
      }
      return normalized;
    },

    markRetry(records = {}, { codes = [], closingRevision = '', state = 'pending', error = '' } = {}) {
      const next = { ...(records || {}) };
      const now = new Date().toISOString();
      unique((codes || []).map(api.normalizeCode).filter(Boolean)).forEach(code => {
        next[code] = {
          ...(next[code] || {}),
          code,
          closingRevision: clean(closingRevision || (next[code] && next[code].closingRevision)),
          state,
          error: clean(error),
          updatedAt: now,
        };
      });
      return next;
    },

    clearRetry(records = {}, codes = []) {
      const next = { ...(records || {}) };
      (codes || []).map(api.normalizeCode).filter(Boolean).forEach(code => delete next[code]);
      return next;
    },

    getRetryCodes(records = {}) {
      return Object.values(records || {})
        .filter(record => record && ['pending', 'failed'].includes(record.state))
        .map(record => api.normalizeCode(record.code))
        .filter(Boolean);
    },
  };

  global.DATAOPS_INVENTORY_MASTER_ADD_MODULE = Object.freeze(api);
})(globalThis);
