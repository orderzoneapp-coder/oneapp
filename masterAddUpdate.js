(function (global) {
  'use strict';

  const HISTORY_KEY = 'merchHistory_v870';
  const MASTER_SYNC_TRIGGER_KEY = 'merchMaster_sync_trigger';
  const STOPPED_PRODUCTS_KEY = 'merchStoppedProducts_v2';
  const PENDING_SHOP_STATUS_KEY = 'pending_shop_status';
  const PENDING_SHOP_STATUS_LOCAL_KEY = 'pendingShopStatus';
  const STOP_MANAGER_SYNC_TRIGGER_KEY = 'merchStopManager_sync_trigger';
  const MODE = '추가·갱신';
  const CODE_FIELDS = ['코드', '품목코드', '상품코드'];
  const EDITABLE_FIELDS = ['품목명', '규격', '단위'];
  const REQUIRED_NEW_FIELDS = ['품목명', '규격', '단위'];
  const HISTORY_DEFAULT_LIMIT = 5000;
  const ERROR_CODES = {
    INITIAL_REGISTRATION_REQUIRED: 'MASTER_ADD_UPDATE_INITIAL_REGISTRATION_REQUIRED',
    NEW_REQUIRED_MISSING: 'MASTER_ADD_UPDATE_NEW_REQUIRED_MISSING',
    BLOCKED_CANDIDATE: 'MASTER_ADD_UPDATE_BLOCKED_CANDIDATE',
    HISTORY_CAPACITY_EXCEEDED: 'MASTER_ADD_UPDATE_HISTORY_CAPACITY_EXCEEDED'
  };
  const REQUIRED_BLOCKING_REASONS = [
    'new_required_value_missing',
    'new_required_approval_incomplete'
  ];
  const ISSUE_TAGS = {
    NEW: '신규 상품',
    CHANGED: '기존 상품 변경',
    SAME: '동일 상품',
    MISSING: '누락 상품',
    NAME: '품명 불일치',
    SPEC_CHANGED: '규격 변경',
    SPEC_MISSING: '규격 누락',
    UNIT_CHANGED: '단위 변경',
    UNIT_MISSING: '단위 누락',
    DUPLICATE_SAME: '동일 중복코드',
    DUPLICATE_DIFFERENT: '상이 중복코드',
    BLANK: '공란 변경',
    ZERO: '숫자 0 변경',
    SALE: '판매여부 변경',
    INTEGRATION: '연동 상태 변경',
    SPOT: '싯가 변경',
    TAX: '과세 변경',
    MASTER_MISMATCH: 'master 불일치',
    OTHER: '기타 주요 필드 변경',
    BLOCKING: '저장 차단'
  };

  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

  const cloneValue = (value) => {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach(key => { out[key] = cloneValue(value[key]); });
      return out;
    }
    return value;
  };

  const stableSerialize = (value) => {
    const normalize = (input) => {
      if (Array.isArray(input)) return input.map(normalize);
      if (input && typeof input === 'object') {
        const result = {};
        Object.keys(input).sort().forEach(key => {
          if (input[key] !== undefined) result[key] = normalize(input[key]);
        });
        return result;
      }
      return input;
    };
    return JSON.stringify(normalize(value));
  };

  const normalizeCode = (value) => String(value === undefined || value === null ? '' : value).trim();
  const normalizeSharedProductCode = (value) => normalizeCode(value).replace(/\s/g, '');
  const isBlankValue = (value) => (
    value === null
    || value === undefined
    || (typeof value === 'string' && value.trim() === '')
  );
  const valuesEqual = (left, right) => Object.is(left, right);

  const getDisplayValue = (row, field) => {
    if (row && row.__display && hasOwn(row.__display, field)) return row.__display[field];
    return row ? row[field] : undefined;
  };

  const getRowCode = (row = {}) => {
    for (const field of CODE_FIELDS) {
      if (!hasOwn(row, field)) continue;
      const code = normalizeCode(getDisplayValue(row, field));
      if (code) return code;
    }
    return '';
  };

  const getMasterCode = (item = {}, fallbackCode = '') => {
    for (const field of CODE_FIELDS) {
      if (!hasOwn(item, field)) continue;
      const code = normalizeCode(item[field]);
      if (code) return code;
    }
    return normalizeCode(fallbackCode);
  };

  const buildMasterIndex = (master = {}) => {
    const out = {};
    const entries = Array.isArray(master)
      ? master.map((item, index) => [String(index + 1), item])
      : Object.entries(master || {});
    entries.forEach(([fallbackCode, item]) => {
      const code = getMasterCode(item || {}, fallbackCode);
      if (!code) throw new Error(`현재 master에 상품코드가 없는 항목이 있습니다: ${fallbackCode}`);
      if (out[code]) throw new Error(`현재 master에 중복 상품코드가 있습니다: ${code}`);
      out[code] = cloneValue(item || {});
      out[code].코드 = code;
    });
    return out;
  };

  const createOperationalError = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
  };

  const assertExistingMaster = (currentMaster, stage = '추가·갱신') => {
    const master = buildMasterIndex(currentMaster);
    if (Object.keys(master).length === 0) {
      throw createOperationalError(
        ERROR_CODES.INITIAL_REGISTRATION_REQUIRED,
        `현재 master가 0건이므로 ${stage}을(를) 실행할 수 없습니다. 최초 등록 승인 절차를 사용해야 합니다.`,
        { stage }
      );
    }
    return master;
  };

  const parseWorkbook = (arrayBuffer, XLSXRef = global.XLSX) => {
    if (!XLSXRef) throw new Error('Excel 라이브러리를 불러오지 못했습니다.');
    const wb = XLSXRef.read(new Uint8Array(arrayBuffer), { type: 'array', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error('첫 번째 Excel 시트를 읽을 수 없습니다.');
    const rawRows = XLSXRef.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    const displayRows = XLSXRef.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    let headerRowIndex = -1;
    for (let index = 0; index < Math.min(15, displayRows.length); index++) {
      const labels = (displayRows[index] || []).map(value => String(value ?? '').trim());
      if (labels.some(label => CODE_FIELDS.includes(label))) {
        headerRowIndex = index;
        break;
      }
    }
    if (headerRowIndex < 0) {
      throw new Error('Excel 상단 15행 안에서 코드·품목코드·상품코드 헤더를 찾지 못했습니다.');
    }
    const headers = (displayRows[headerRowIndex] || []).map(value => String(value ?? '').trim());
    const duplicateHeaders = headers.filter((header, index) => header && headers.indexOf(header) !== index);
    if (duplicateHeaders.length > 0) {
      throw new Error(`중복 Excel 컬럼명이 있습니다: ${[...new Set(duplicateHeaders)].join(', ')}`);
    }
    const rows = [];
    for (let rowIndex = headerRowIndex + 1; rowIndex < rawRows.length; rowIndex++) {
      const rawRow = rawRows[rowIndex] || [];
      const displayRow = displayRows[rowIndex] || [];
      const hasAnyValue = headers.some((header, columnIndex) => (
        header && String(displayRow[columnIndex] ?? rawRow[columnIndex] ?? '').trim() !== ''
      ));
      if (!hasAnyValue) continue;
      const row = { __rowNumber: rowIndex + 1, __display: {} };
      headers.forEach((header, columnIndex) => {
        if (!header) return;
        row[header] = rawRow[columnIndex] === undefined ? '' : rawRow[columnIndex];
        row.__display[header] = displayRow[columnIndex];
      });
      rows.push(row);
      if (rows.length > 100000) throw new Error('Excel 데이터 행은 100,000건을 초과할 수 없습니다.');
    }
    if (rows.length === 0) throw new Error('비교할 상품 행이 없습니다.');
    return { headers: headers.filter(Boolean), rows };
  };

  const getSourceFields = (row = {}, headers = []) => {
    const source = Array.isArray(headers) && headers.length > 0 ? headers : Object.keys(row || {});
    const seen = new Set();
    return source
      .map(field => String(field || '').trim())
      .filter(field => field && !field.startsWith('__') && !CODE_FIELDS.includes(field))
      .filter(field => {
        if (seen.has(field)) return false;
        seen.add(field);
        return hasOwn(row, field);
      });
  };

  const duplicateSignature = (row, headers) => {
    const fields = getSourceFields(row, headers).sort();
    return stableSerialize(fields.map(field => ({
      field,
      present: hasOwn(row, field),
      value: row[field]
    })));
  };

  const addTag = (tags, tag) => {
    if (tag && !tags.includes(tag)) tags.push(tag);
  };

  const fieldIssueTags = ({ field, oldValue, uploadValue, isNew, uploadPresent }) => {
    const tags = [];
    const changed = isNew ? uploadPresent : (uploadPresent && !valuesEqual(oldValue, uploadValue));
    if (!changed && !(isNew && REQUIRED_NEW_FIELDS.includes(field) && (!uploadPresent || isBlankValue(uploadValue)))) {
      return tags;
    }
    if (field === '품목명' && changed && !isNew) addTag(tags, ISSUE_TAGS.NAME);
    if (field === '규격') {
      if (!uploadPresent || isBlankValue(uploadValue)) addTag(tags, ISSUE_TAGS.SPEC_MISSING);
      else if (!isNew && changed) addTag(tags, ISSUE_TAGS.SPEC_CHANGED);
    }
    if (field === '단위') {
      if (!uploadPresent || isBlankValue(uploadValue)) addTag(tags, ISSUE_TAGS.UNIT_MISSING);
      else if (!isNew && changed) addTag(tags, ISSUE_TAGS.UNIT_CHANGED);
    }
    if (uploadPresent && isBlankValue(uploadValue) && (isNew || !isBlankValue(oldValue))) addTag(tags, ISSUE_TAGS.BLANK);
    if (uploadPresent && uploadValue === 0 && !valuesEqual(oldValue, uploadValue)) addTag(tags, ISSUE_TAGS.ZERO);
    if (['판매여부', '판매상태'].includes(field) && changed) addTag(tags, ISSUE_TAGS.SALE);
    if (['연동상태', '연동 상태', '판매 및 연동 상태'].includes(field) && changed) addTag(tags, ISSUE_TAGS.INTEGRATION);
    if (['싯가', '시중가'].includes(field) && changed) addTag(tags, ISSUE_TAGS.SPOT);
    if (['과세', '과세여부', '과세 여부'].includes(field) && changed) addTag(tags, ISSUE_TAGS.TAX);
    return tags;
  };

  const getFieldFinalValue = (fieldState) => {
    if (!fieldState) return undefined;
    if (fieldState.source === 'admin') return fieldState.adminValue;
    if (fieldState.source === 'blank') return '';
    if (fieldState.source === 'old') return fieldState.oldValue;
    return fieldState.uploadPresent ? fieldState.uploadRaw : undefined;
  };

  const syncCandidateBlocking = (candidate) => {
    if (!candidate) return candidate;
    candidate.blockingReasons = (candidate.blockingReasons || [])
      .filter(reason => !REQUIRED_BLOCKING_REASONS.includes(reason));
    if (candidate.status === 'new' && !candidate.productExcluded) {
      const requiredStates = REQUIRED_NEW_FIELDS.map(field => candidate.fields && candidate.fields[field]);
      const valueMissing = requiredStates.some(state => (
        !state || state.excluded || isBlankValue(getFieldFinalValue(state))
      ));
      if (valueMissing) addTag(candidate.blockingReasons, 'new_required_value_missing');

      const approvalStarted = candidate.productApproved
        || candidate.adminComplete
        || Object.values(candidate.fields || {}).some(field => field.approved || field.excluded);
      const approvalIncomplete = approvalStarted && requiredStates.some(state => (
        !state
        || state.excluded
        || isBlankValue(getFieldFinalValue(state))
        || (!candidate.productApproved && !state.approved)
      ));
      if (approvalIncomplete) addTag(candidate.blockingReasons, 'new_required_approval_incomplete');
    }
    candidate.issueTags = (candidate.issueTags || []).filter(tag => tag !== ISSUE_TAGS.BLOCKING);
    if (candidate.blockingReasons.length > 0) addTag(candidate.issueTags, ISSUE_TAGS.BLOCKING);
    return candidate;
  };

  const createFieldState = ({ field, row, existing, isNew, synthetic = false }) => {
    const uploadPresent = !synthetic && hasOwn(row, field);
    const uploadRaw = uploadPresent ? row[field] : undefined;
    const uploadDisplay = uploadPresent && row.__display && hasOwn(row.__display, field)
      ? row.__display[field]
      : uploadRaw;
    const oldValue = hasOwn(existing, field) ? existing[field] : undefined;
    const changed = isNew ? uploadPresent : (uploadPresent && !valuesEqual(oldValue, uploadRaw));
    const issueTags = fieldIssueTags({ field, oldValue, uploadValue: uploadRaw, isNew, uploadPresent });
    return {
      field,
      oldValue,
      uploadPresent,
      uploadRaw,
      uploadDisplay,
      adminValue: undefined,
      adminEdited: false,
      source: 'upload',
      approved: false,
      excluded: false,
      changed,
      issueTags
    };
  };

  const buildCandidate = ({
    id,
    code,
    row,
    headers,
    existing,
    duplicateKind = '',
    duplicateRows = [],
    duplicateResolved = true,
    rowNumber
  }) => {
    const isNew = !existing;
    const base = existing ? cloneValue(existing) : {};
    const fields = {};
    getSourceFields(row, headers).forEach(field => {
      fields[field] = createFieldState({ field, row, existing: base, isNew });
    });
    if (isNew) {
      REQUIRED_NEW_FIELDS.forEach(field => {
        if (!fields[field]) fields[field] = createFieldState({ field, row, existing: base, isNew, synthetic: true });
      });
    }
    const changedFields = Object.values(fields).filter(field => field.changed);
    const status = isNew ? 'new' : (changedFields.length > 0 ? 'changed' : 'same');
    const tags = [];
    if (status === 'new') addTag(tags, ISSUE_TAGS.NEW);
    if (status === 'changed') addTag(tags, ISSUE_TAGS.CHANGED);
    if (status === 'same') addTag(tags, ISSUE_TAGS.SAME);
    Object.values(fields).forEach(field => field.issueTags.forEach(tag => addTag(tags, tag)));
    if (changedFields.some(field => !EDITABLE_FIELDS.includes(field.field))) addTag(tags, ISSUE_TAGS.OTHER);
    if (duplicateKind === 'same') addTag(tags, ISSUE_TAGS.DUPLICATE_SAME);
    if (duplicateKind === 'different') addTag(tags, ISSUE_TAGS.DUPLICATE_DIFFERENT);
    const blockingReasons = [];
    if (duplicateKind && !duplicateResolved) blockingReasons.push('duplicate_unresolved');
    if (blockingReasons.length > 0) addTag(tags, ISSUE_TAGS.BLOCKING);
    return syncCandidateBlocking({
      id,
      code,
      status,
      rowNumber,
      sourceHeaders: getSourceFields(row, headers),
      uploadRow: cloneValue(row),
      existing: base,
      fields,
      issueTags: tags,
      blockingReasons,
      duplicateKind,
      duplicateRows: cloneValue(duplicateRows),
      duplicateResolved,
      selectedDuplicateRowNumber: duplicateResolved ? rowNumber : null,
      productApproved: false,
      productExcluded: false,
      adminComplete: false
    });
  };

  const createBlankCodeCandidate = (row, headers, index) => {
    const fields = {};
    getSourceFields(row, headers).forEach(field => {
      fields[field] = createFieldState({ field, row, existing: {}, isNew: true });
    });
    return {
      id: `blank-row-${row.__rowNumber || index + 1}`,
      code: '',
      status: 'blocked',
      rowNumber: row.__rowNumber || index + 1,
      sourceHeaders: getSourceFields(row, headers),
      uploadRow: cloneValue(row),
      existing: {},
      fields,
      issueTags: [ISSUE_TAGS.BLOCKING],
      blockingReasons: ['blank_code'],
      duplicateKind: '',
      duplicateRows: [],
      duplicateResolved: true,
      selectedDuplicateRowNumber: null,
      productApproved: false,
      productExcluded: false,
      adminComplete: false
    };
  };

  const matchesTag = (candidate, tag) => (candidate.issueTags || []).includes(tag);

  const summarize = (candidates = []) => {
    const countTag = tag => candidates.filter(candidate => matchesTag(candidate, tag)).length;
    const requiredMissingCount = candidates.filter(candidate => (
      candidate.blockingReasons.includes('blank_code')
      || candidate.blockingReasons.includes('new_required_value_missing')
    )).length;
    return {
      compareCount: candidates.filter(candidate => candidate.status !== 'missing').length,
      newCount: candidates.filter(candidate => candidate.status === 'new').length,
      changedCount: candidates.filter(candidate => candidate.status === 'changed').length,
      sameCount: candidates.filter(candidate => candidate.status === 'same').length,
      missingCount: candidates.filter(candidate => candidate.status === 'missing').length,
      requiredMissingCount,
      duplicateCount: candidates.filter(candidate => (
        matchesTag(candidate, ISSUE_TAGS.DUPLICATE_SAME)
        || matchesTag(candidate, ISSUE_TAGS.DUPLICATE_DIFFERENT)
      )).length,
      nameMismatchCount: countTag(ISSUE_TAGS.NAME),
      specChangeCount: countTag(ISSUE_TAGS.SPEC_CHANGED),
      unitChangeMissingCount: candidates.filter(candidate => (
        matchesTag(candidate, ISSUE_TAGS.UNIT_CHANGED)
        || matchesTag(candidate, ISSUE_TAGS.UNIT_MISSING)
      )).length,
      otherImportantCount: countTag(ISSUE_TAGS.OTHER),
      blockingCount: candidates.filter(candidate => (candidate.blockingReasons || []).length > 0).length
    };
  };

  const analyzeUploadRows = ({
    headers = [],
    rows = [],
    currentMaster = {},
    revision,
    fileName = '',
    masterMismatch = false
  } = {}) => {
    const master = assertExistingMaster(currentMaster, '추가·갱신 비교 분석');
    const groups = new Map();
    const candidates = [];
    rows.forEach((row, index) => {
      const code = getRowCode(row);
      if (!code) {
        candidates.push(createBlankCodeCandidate(row, headers, index));
        return;
      }
      if (!groups.has(code)) groups.set(code, []);
      groups.get(code).push({ row, index, rowNumber: row.__rowNumber || index + 1 });
    });

    groups.forEach((entries, code) => {
      const duplicateKind = entries.length > 1
        ? (new Set(entries.map(entry => duplicateSignature(entry.row, headers))).size === 1 ? 'same' : 'different')
        : '';
      const duplicateRows = entries.map(entry => ({
        rowNumber: entry.rowNumber,
        row: cloneValue(entry.row)
      }));
      const selected = entries[0];
      candidates.push(buildCandidate({
        id: `product-${code}`,
        code,
        row: selected.row,
        headers,
        existing: master[code],
        duplicateKind,
        duplicateRows,
        duplicateResolved: !duplicateKind,
        rowNumber: selected.rowNumber
      }));
    });

    const uploadCodes = new Set(groups.keys());
    Object.entries(master).forEach(([code, item]) => {
      if (uploadCodes.has(code)) return;
      candidates.push({
        id: `missing-${code}`,
        code,
        status: 'missing',
        rowNumber: null,
        sourceHeaders: [],
        uploadRow: {},
        existing: cloneValue(item),
        fields: {},
        issueTags: [ISSUE_TAGS.MISSING],
        blockingReasons: [],
        duplicateKind: '',
        duplicateRows: [],
        duplicateResolved: true,
        selectedDuplicateRowNumber: null,
        productApproved: false,
        productExcluded: false,
        adminComplete: false
      });
    });

    if (masterMismatch) {
      candidates.forEach(candidate => {
        if (candidate.status === 'same' || candidate.status === 'missing') return;
        addTag(candidate.issueTags, ISSUE_TAGS.MASTER_MISMATCH);
        addTag(candidate.issueTags, ISSUE_TAGS.BLOCKING);
        addTag(candidate.blockingReasons, 'master_mismatch');
      });
    }
    const analysis = {
      mode: MODE,
      fileName,
      headers: headers.slice(),
      rows: cloneValue(rows),
      baseRevision: revision,
      baseMaster: master,
      masterMismatch,
      candidates
    };
    analysis.summary = summarize(candidates);
    return analysis;
  };

  const updateCandidate = (analysis, candidateId, updater) => {
    const next = cloneValue(analysis);
    const index = next.candidates.findIndex(candidate => candidate.id === candidateId);
    if (index < 0) return next;
    updater(next.candidates[index]);
    syncCandidateBlocking(next.candidates[index]);
    next.summary = summarize(next.candidates);
    return next;
  };

  const setProductApproved = (analysis, candidateId, approved) => updateCandidate(analysis, candidateId, candidate => {
    candidate.productApproved = approved === true;
    if (approved) candidate.productExcluded = false;
  });

  const setProductExcluded = (analysis, candidateId, excluded) => updateCandidate(analysis, candidateId, candidate => {
    candidate.productExcluded = excluded === true;
    if (excluded) candidate.productApproved = false;
  });

  const setAdminComplete = (analysis, candidateId, complete) => updateCandidate(analysis, candidateId, candidate => {
    candidate.adminComplete = complete === true;
  });

  const setFieldDecision = (analysis, candidateId, fieldName, decision = {}) => updateCandidate(analysis, candidateId, candidate => {
    const field = candidate.fields[fieldName];
    if (!field) return;
    if (decision.source) {
      field.source = decision.source;
      if (decision.source !== 'admin') {
        field.adminEdited = false;
        field.adminValue = undefined;
      }
    }
    if (hasOwn(decision, 'adminValue')) {
      field.source = 'admin';
      field.adminEdited = true;
      field.adminValue = decision.adminValue;
    }
    if (hasOwn(decision, 'approved')) {
      field.approved = decision.approved === true;
      if (field.approved) field.excluded = false;
    }
    if (hasOwn(decision, 'excluded')) {
      field.excluded = decision.excluded === true;
      if (field.excluded) field.approved = false;
    }
  });

  const resolveDuplicate = (analysis, candidateId, rowNumber) => updateCandidate(analysis, candidateId, candidate => {
    const selected = candidate.duplicateRows.find(entry => entry.rowNumber === rowNumber);
    if (!selected) return;
    const rebuilt = buildCandidate({
      id: candidate.id,
      code: candidate.code,
      row: selected.row,
      headers: analysis.headers,
      existing: candidate.existing,
      duplicateKind: candidate.duplicateKind,
      duplicateRows: candidate.duplicateRows,
      duplicateResolved: true,
      rowNumber: selected.rowNumber
    });
    Object.assign(candidate, rebuilt);
  });

  const clearMasterMismatch = (analysis) => {
    const next = cloneValue(analysis);
    next.masterMismatch = false;
    next.candidates.forEach(candidate => {
      candidate.issueTags = candidate.issueTags.filter(tag => tag !== ISSUE_TAGS.MASTER_MISMATCH);
      candidate.blockingReasons = candidate.blockingReasons.filter(reason => reason !== 'master_mismatch');
      if (candidate.blockingReasons.length === 0) {
        candidate.issueTags = candidate.issueTags.filter(tag => tag !== ISSUE_TAGS.BLOCKING);
      }
      candidate.productApproved = false;
      candidate.productExcluded = false;
      candidate.adminComplete = false;
      Object.values(candidate.fields || {}).forEach(field => {
        field.approved = false;
        field.excluded = false;
      });
      syncCandidateBlocking(candidate);
    });
    next.summary = summarize(next.candidates);
    return next;
  };

  const filterCandidates = (analysis, selectedTags = [], options = {}) => {
    const includeSame = options.includeSame === true;
    const tags = Array.isArray(selectedTags) ? selectedTags.filter(Boolean) : [];
    return (analysis?.candidates || []).filter(candidate => {
      if (!includeSame && candidate.status === 'same' && candidate.issueTags.length === 1) return false;
      if (tags.length === 0) return true;
      return tags.every(tag => matchesTag(candidate, tag));
    });
  };

  const assertNewProductsComplete = (plan, stage = '실행계획') => {
    const createdCodes = (plan && plan.details || [])
      .filter(detail => detail.executionField === '코드')
      .map(detail => detail.code);
    createdCodes.forEach(code => {
      const item = plan.nextMaster && plan.nextMaster[code];
      const missingRequiredFields = REQUIRED_NEW_FIELDS.filter(field => !item || isBlankValue(item[field]));
      if (missingRequiredFields.length > 0) {
        throw createOperationalError(
          ERROR_CODES.NEW_REQUIRED_MISSING,
          `${stage}에서 ${code} 신규 상품의 필수 최종값이 확인되지 않았습니다: ${missingRequiredFields.join(', ')}`,
          { stage, productCode: code, missingRequiredFields }
        );
      }
    });
    return true;
  };

  const buildExecutionPlan = (analysis, currentMaster = {}) => {
    if (!analysis || analysis.mode !== MODE) throw new Error('추가·갱신 비교 결과가 없습니다.');
    if (analysis.masterMismatch) {
      const error = new Error('master 불일치가 해소되지 않아 저장할 수 없습니다.');
      error.code = 'MASTER_ADD_UPDATE_MASTER_MISMATCH';
      throw error;
    }
    const nextMaster = assertExistingMaster(currentMaster, '추가·갱신 실행계획 생성');
    const details = [];
    const savedProducts = new Set();
    let createCount = 0;
    let updateCount = 0;
    let appliedFieldCount = 0;

    analysis.candidates.forEach(candidate => {
      if (!candidate || ['same', 'missing', 'blocked'].includes(candidate.status)) return;
      if (candidate.productExcluded || !candidate.adminComplete) return;
      const normalizedCandidate = syncCandidateBlocking(cloneValue(candidate));
      if (normalizedCandidate.blockingReasons.length > 0) {
        throw createOperationalError(
          normalizedCandidate.blockingReasons.includes('new_required_value_missing')
            || normalizedCandidate.blockingReasons.includes('new_required_approval_incomplete')
            ? ERROR_CODES.NEW_REQUIRED_MISSING
            : ERROR_CODES.BLOCKED_CANDIDATE,
          `${candidate.code || `${candidate.rowNumber}행`} 상품의 저장 차단 이슈를 먼저 해결해야 합니다.`,
          { productCode: candidate.code, blockingReasons: normalizedCandidate.blockingReasons.slice() }
        );
      }
      const isNew = candidate.status === 'new';
      const before = isNew ? null : nextMaster[candidate.code];
      if (!isNew && !before) return;
      const target = isNew ? { 코드: candidate.code } : cloneValue(before);
      const acceptedFields = [];

      Object.values(candidate.fields || {}).forEach(field => {
        if (field.excluded) return;
        const approved = field.approved || candidate.productApproved;
        if (!approved) return;
        const finalValue = getFieldFinalValue(field);
        if (finalValue === undefined) return;
        const changed = isNew ? true : !valuesEqual(field.oldValue, finalValue);
        if (!changed) return;
        target[field.field] = cloneValue(finalValue);
        acceptedFields.push({
          executionField: field.field,
          oldValue: field.oldValue,
          uploadPresent: field.uploadPresent,
          uploadRaw: field.uploadPresent ? cloneValue(field.uploadRaw) : null,
          uploadRawType: field.uploadPresent
            ? (field.uploadRaw === '' ? 'blank' : typeof field.uploadRaw)
            : 'missing',
          adminEdited: field.adminEdited,
          adminValue: field.adminEdited ? cloneValue(field.adminValue) : null,
          finalValue: cloneValue(finalValue),
          approvalStatus: field.approved ? '필드 승인' : '상품 승인',
          exclusionStatus: '반영',
          changePath: field.source
        });
      });

      if (isNew) {
        if (!candidate.productApproved && acceptedFields.length === 0) return;
        const missingRequiredFields = REQUIRED_NEW_FIELDS.filter(field => isBlankValue(target[field]));
        if (missingRequiredFields.length > 0) {
          throw createOperationalError(
            ERROR_CODES.NEW_REQUIRED_MISSING,
            `${candidate.code} 신규 상품의 최종 반영값에 필수값이 없습니다: ${missingRequiredFields.join(', ')}`,
            { productCode: candidate.code, missingRequiredFields }
          );
        }
        target.코드 = candidate.code;
        nextMaster[candidate.code] = target;
        createCount++;
        savedProducts.add(candidate.code);
        details.push({
          executionField: '코드',
          code: candidate.code,
          oldValue: null,
          uploadPresent: true,
          uploadRaw: candidate.code,
          uploadRawType: 'string',
          adminEdited: false,
          adminValue: null,
          finalValue: candidate.code,
          approvalStatus: candidate.productApproved ? '상품 승인' : '필드 승인',
          exclusionStatus: '반영',
          changePath: '상품 생성'
        });
      } else if (acceptedFields.length > 0) {
        nextMaster[candidate.code] = target;
        updateCount++;
        savedProducts.add(candidate.code);
      } else {
        return;
      }

      acceptedFields.forEach(detail => details.push({ ...detail, code: candidate.code }));
      appliedFieldCount += acceptedFields.length;
    });

    const counts = {
      compareCount: analysis.summary.compareCount,
      createCount,
      updateCount,
      appliedFieldCount,
      sameCount: analysis.summary.sameCount,
      excludedCount: analysis.candidates.filter(candidate => candidate.productExcluded).length,
      missingRetainedCount: analysis.summary.missingCount,
      blockedCount: analysis.summary.blockingCount,
      failedCount: 0,
      savedProductCount: savedProducts.size
    };
    const plan = { nextMaster, details, counts };
    assertNewProductsComplete(plan, '추가·갱신 실행계획');
    return plan;
  };

  const createExecutionId = () => {
    const uuid = global.crypto && typeof global.crypto.randomUUID === 'function'
      ? global.crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    return `master-add-update-${Date.now()}-${uuid}`;
  };

  const buildOfficialLogs = ({
    executionId,
    actor,
    fileName,
    plan,
    historyApi,
    timestampISO
  }) => {
    const normalize = payload => {
      const standard = historyApi && typeof historyApi.normalizeHistoryLog === 'function'
        ? historyApi.normalizeHistoryLog(payload)
        : payload;
      return { ...standard, ...payload };
    };
    const job = normalize({
      id: `${executionId}-job`,
      recordType: 'master_add_update_job',
      executionId,
      mode: MODE,
      actor: actor || null,
      actorStatus: actor ? 'identified' : 'identity-system-unavailable',
      timestampISO,
      source: 'master_add_update',
      sourceRole: 'master',
      actionType: 'master_add_update_job',
      path: 'Master > 추가·갱신',
      field: '작업',
      oldVal: '',
      newVal: '성공',
      fileName,
      compareCount: plan.counts.compareCount,
      createCount: plan.counts.createCount,
      updateCount: plan.counts.updateCount,
      excludedCount: plan.counts.excludedCount,
      blockedCount: plan.counts.blockedCount,
      failedCount: 0,
      status: 'success',
      memo: `${MODE} 실행 ${executionId}`
    });
    const details = plan.details.map((detail, index) => normalize({
      id: `${executionId}-detail-${index + 1}`,
      recordType: 'master_add_update_detail',
      executionId,
      mode: MODE,
      actor: actor || null,
      actorStatus: actor ? 'identified' : 'identity-system-unavailable',
      timestampISO,
      source: 'master_add_update',
      sourceRole: 'master',
      actionType: detail.executionField === '코드' ? 'master_create' : 'master_update',
      path: 'Master > 추가·갱신',
      code: detail.code,
      field: detail.executionField,
      oldVal: detail.oldValue === undefined ? '' : detail.oldValue,
      newVal: detail.finalValue,
      oldMasterPresent: detail.oldValue !== undefined && detail.oldValue !== null,
      oldMasterValue: detail.oldValue === undefined ? null : detail.oldValue,
      uploadPresent: detail.uploadPresent,
      uploadRaw: detail.uploadRaw,
      uploadRawType: detail.uploadRawType,
      uploadOriginalValue: detail.uploadRaw,
      adminEdited: detail.adminEdited,
      adminValue: detail.adminValue,
      adminModifiedValue: detail.adminValue,
      finalValue: detail.finalValue,
      finalAppliedValue: detail.finalValue,
      approvalStatus: detail.approvalStatus,
      approvalState: detail.approvalStatus,
      exclusionStatus: detail.exclusionStatus,
      exclusionState: detail.exclusionStatus,
      changePath: detail.changePath,
      failureReason: '',
      memo: `${MODE} ${detail.approvalStatus} / ${detail.changePath}`
    }));
    return [job, ...details];
  };

  const readHistory = (localStorageRef) => {
    const raw = localStorageRef.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('공식 history 형식이 배열이 아닙니다.');
    return parsed;
  };

  const prepareHistoryAppend = (localStorageRef, logs, historyApi) => {
    const current = readHistory(localStorageRef);
    const configuredLimit = Number(historyApi && historyApi.DEFAULT_LIMIT);
    const limit = Number.isInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : HISTORY_DEFAULT_LIMIT;
    const nextLogs = Array.isArray(logs) ? logs : [];
    if (nextLogs.length > limit || current.length + nextLogs.length > limit) {
      throw createOperationalError(
        ERROR_CODES.HISTORY_CAPACITY_EXCEEDED,
        `공식 history 보관 한도(${limit.toLocaleString()}건)를 초과하므로 master 저장을 시작하지 않았습니다. 기존 감사 이력을 보존한 뒤 관리자가 보관 정책을 결정해야 합니다.`,
        { historyLimit: limit, existingHistoryCount: current.length, newHistoryCount: nextLogs.length }
      );
    }
    const merged = [...nextLogs, ...current];
    JSON.stringify(merged);
    return { merged, limit, existingHistoryCount: current.length, newHistoryCount: nextLogs.length };
  };

  const restoreHistory = (storage, localStorageRef, raw, executionLogs = []) => {
    if (localStorageRef.getItem(HISTORY_KEY) === raw) return;
    const executionIds = new Set(executionLogs.map(log => log && log.id).filter(Boolean));
    let previous = [];
    let current = [];
    let canCompare = true;
    try {
      previous = raw ? JSON.parse(raw) : [];
      current = readHistory(localStorageRef);
      if (!Array.isArray(previous)) canCompare = false;
    } catch (error) {
      canCompare = false;
    }
    if (canCompare) {
      const filtered = current.filter(log => !executionIds.has(log && log.id));
      if (stableSerialize(filtered) !== stableSerialize(previous)) {
        if (storage && typeof storage.writeLocalJSON === 'function') {
          storage.writeLocalJSON(HISTORY_KEY, filtered, { label: 'Master 추가·갱신 history 실행분 rollback' });
        } else {
          localStorageRef.setItem(HISTORY_KEY, JSON.stringify(filtered));
        }
        const verified = readHistory(localStorageRef);
        if (verified.some(log => executionIds.has(log && log.id))) {
          throw new Error('history rollback 후 실패 실행 이력이 남아 있습니다.');
        }
        return;
      }
    }
    if (storage && typeof storage.restoreLocalValue === 'function') {
      storage.restoreLocalValue(HISTORY_KEY, raw, { label: 'Master 추가·갱신 history rollback' });
    } else if (raw === null) {
      localStorageRef.removeItem(HISTORY_KEY);
    } else {
      localStorageRef.setItem(HISTORY_KEY, raw);
    }
    if (localStorageRef.getItem(HISTORY_KEY) !== raw) {
      throw new Error('history rollback 후 원본 확인에 실패했습니다.');
    }
  };

  const writeAndVerifyHistory = (storage, localStorageRef, logs, preparedHistory) => {
    const merged = preparedHistory && Array.isArray(preparedHistory.merged)
      ? preparedHistory.merged
      : prepareHistoryAppend(localStorageRef, logs).merged;
    if (storage && typeof storage.writeLocalJSON === 'function') {
      storage.writeLocalJSON(HISTORY_KEY, merged, { label: 'Master 추가·갱신 공식 history 저장' });
    } else {
      localStorageRef.setItem(HISTORY_KEY, JSON.stringify(merged));
    }
    const saved = readHistory(localStorageRef);
    const savedIds = new Set(saved.map(log => log && log.id));
    if (!logs.every(log => savedIds.has(log.id))) {
      throw new Error('공식 history 저장 후 실행 이력을 찾지 못했습니다.');
    }
    return saved;
  };

  const verifyMasterAndHistory = async ({ storage, localStorageRef, nextMaster, logs }) => {
    const state = await storage.readMasterSnapshotState();
    if (stableSerialize(state.masterMap) !== stableSerialize(nextMaster)) {
      throw new Error('저장 후 master 재조회 값이 실행 대상과 일치하지 않습니다.');
    }
    const history = readHistory(localStorageRef);
    const byId = new Map(history.map(log => [log && log.id, log]));
    for (const log of logs) {
      if (!byId.has(log.id)) throw new Error(`저장 후 history 재조회 실패: ${log.id}`);
      if (log.recordType !== 'master_add_update_detail') continue;
      const item = state.masterMap[log.code];
      const actual = log.field === '코드' ? (item && item.코드) : (item && item[log.field]);
      if (!valuesEqual(actual, log.finalValue)) {
        throw new Error(`master와 history 최종값 불일치: ${log.code} / ${log.field}`);
      }
    }
    return state;
  };

  const normalizeOfficialLog = (historyApi, payload = {}) => {
    const normalized = historyApi && typeof historyApi.normalizeHistoryLog === 'function'
      ? historyApi.normalizeHistoryLog(payload)
      : payload;
    return { ...normalized, ...payload };
  };

  const readLocalJSON = (localStorageRef, key, fallback) => {
    const raw = localStorageRef.getItem(key);
    if (!raw) return cloneValue(fallback);
    const parsed = JSON.parse(raw);
    return parsed === undefined || parsed === null ? cloneValue(fallback) : parsed;
  };

  const writeAndVerifyLocalEntries = (storage, localStorageRef, entries = {}, label = '공유상태') => {
    Object.entries(entries || {}).forEach(([key, value]) => {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      if (storage && typeof storage.writeLocalValue === 'function') {
        storage.writeLocalValue(key, serialized, { label: `${label} ${key} 저장` });
      } else {
        localStorageRef.setItem(key, serialized);
      }
      if (localStorageRef.getItem(key) !== serialized) {
        throw new Error(`${label} ${key} 저장 후 검증에 실패했습니다.`);
      }
    });
  };

  const restoreLocalEntries = (storage, localStorageRef, previous = {}, label = '공유상태') => {
    Object.entries(previous || {}).forEach(([key, raw]) => {
      if (storage && typeof storage.restoreLocalValue === 'function') {
        storage.restoreLocalValue(key, raw, { label: `${label} ${key} rollback` });
      } else if (raw === null || raw === undefined) {
        localStorageRef.removeItem(key);
      } else {
        localStorageRef.setItem(key, raw);
      }
      if (localStorageRef.getItem(key) !== raw) {
        throw new Error(`${label} ${key} rollback 후 원본 확인에 실패했습니다.`);
      }
    });
  };

  const commitNarrowMasterMutation = async ({
    storage,
    historyApi,
    localStorageRef,
    currentState,
    nextMaster,
    expectedRevision,
    logs = [],
    extraStoreEntries = {},
    localWrites = {},
    label = 'Master 단건 변경'
  } = {}) => {
    const previousHistoryRaw = localStorageRef.getItem(HISTORY_KEY);
    const preparedHistory = logs.length > 0
      ? prepareHistoryAppend(localStorageRef, logs, historyApi)
      : null;
    const previousLocalValues = Object.fromEntries(
      Object.keys(localWrites || {}).map(key => [key, localStorageRef.getItem(key)])
    );
    const baseMaster = buildMasterIndex(currentState.masterMap);
    let commitResult;
    try {
      commitResult = await storage.commitMasterStateOrThrow(nextMaster, {
        expectedRevision,
        ...(Object.keys(extraStoreEntries || {}).length > 0 ? { extraStoreEntries } : {}),
        afterVerified: async () => {
          if (logs.length > 0) {
            writeAndVerifyHistory(storage, localStorageRef, logs, preparedHistory);
          }
          writeAndVerifyLocalEntries(storage, localStorageRef, localWrites, label);
          await verifyMasterAndHistory({ storage, localStorageRef, nextMaster, logs });
          return true;
        },
        afterVerifiedError: `${label} master/history/공유상태 검증 실패`
      });
    } catch (error) {
      if (error?.code === 'MERCH_MASTER_REVISION_CONFLICT') {
        throw error;
      }
      const rollbackErrors = [];
      if (logs.length > 0) {
        try {
          restoreHistory(storage, localStorageRef, previousHistoryRaw, logs);
        } catch (historyRollbackError) {
          rollbackErrors.push(historyRollbackError.message);
        }
      }
      try {
        restoreLocalEntries(storage, localStorageRef, previousLocalValues, label);
      } catch (localRollbackError) {
        rollbackErrors.push(localRollbackError.message);
      }
      try {
        const rollbackState = await storage.readMasterSnapshotState(Object.keys(extraStoreEntries || {}));
        if (stableSerialize(rollbackState.masterMap) !== stableSerialize(baseMaster)) {
          rollbackErrors.push('master rollback 후 기존 master 값과 일치하지 않습니다.');
        }
      } catch (masterRollbackError) {
        rollbackErrors.push(masterRollbackError.message);
      }
      if (rollbackErrors.length > 0) {
        const wrapped = new Error(`${error.message} / rollback 확인 실패: ${rollbackErrors.join(' / ')}`);
        wrapped.code = 'MASTER_ADD_UPDATE_ROLLBACK_FAILED';
        wrapped.cause = error;
        throw wrapped;
      }
      error.message = `${error.message} 변경 전 master, history와 공유상태를 유지했습니다.`;
      throw error;
    }
    return commitResult;
  };

  const normalizeSingleProductInput = (input = {}) => {
    const code = normalizeSharedProductCode(input['ERP 품목코드'] || input['품목코드'] || input['코드']);
    return {
      ...cloneValue(input),
      코드: code,
      품목코드: code,
      품목명: normalizeCode(input['품목명'] || input['상품명']),
      규격: normalizeCode(input['규격']),
      단위: normalizeCode(input['단위'])
    };
  };

  const validateSingleProductInput = (input = {}) => {
    const item = normalizeSingleProductInput(input);
    const missingFields = [
      ['ERP 품목코드', item.코드],
      ['상품명', item.품목명],
      ['규격', item.규격],
      ['단위', item.단위]
    ].filter(([, value]) => isBlankValue(value)).map(([field]) => field);
    if (missingFields.length > 0) {
      throw createOperationalError(
        'MASTER_SINGLE_PRODUCT_REQUIRED_MISSING',
        `마스터 신규등록 필수값을 입력하세요: ${missingFields.join(', ')}`,
        { missingFields }
      );
    }
    return item;
  };

  const commitSingleProductRegistration = async ({
    item,
    expectedRevision,
    storage,
    historyApi,
    localStorageRef,
    actor = null
  } = {}) => {
    if (!storage || typeof storage.commitMasterStateOrThrow !== 'function' || typeof storage.readMasterSnapshotState !== 'function') {
      throw new Error('공통 master 저장 엔진을 사용할 수 없습니다.');
    }
    if (!localStorageRef) throw new Error('공식 history 저장소를 사용할 수 없습니다.');
    const normalizedItem = validateSingleProductInput(item);
    const currentState = await storage.readMasterSnapshotState();
    const currentMaster = assertExistingMaster(currentState.masterMap, 'DataOps 마스터 단건 신규등록');
    if (currentState.revision !== expectedRevision) {
      const error = new Error('신규등록 입력 중 master가 변경되었습니다. 최신 master에서 품목코드를 다시 확인하세요.');
      error.code = 'MERCH_MASTER_REVISION_CONFLICT';
      throw error;
    }
    const normalizedCode = normalizeSharedProductCode(normalizedItem.코드);
    const duplicate = Object.entries(currentMaster).find(([masterKey, masterItem]) => (
      normalizeSharedProductCode(getMasterCode(masterItem, masterKey)) === normalizedCode
    ));
    if (duplicate) {
      throw createOperationalError(
        'MASTER_SINGLE_PRODUCT_DUPLICATE_CODE',
        `이미 등록된 ERP 품목코드입니다: ${normalizedItem.코드}`,
        { productCode: normalizedItem.코드 }
      );
    }

    const nextMaster = cloneValue(currentMaster);
    nextMaster[normalizedItem.코드] = normalizedItem;
    const executionId = `dataops-master-register-${Date.now()}-${global.crypto && typeof global.crypto.randomUUID === 'function' ? global.crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
    const timestampISO = new Date().toISOString();
    const basePayload = {
      executionId,
      mode: '단건 신규등록',
      actor: actor || null,
      actorStatus: actor ? 'identified' : 'identity-system-unavailable',
      timestampISO,
      source: 'dataops_inventory',
      sourceRole: 'dataops',
      sourceLabel: 'DataOps 재고실사',
      applyMode: 'direct_master_apply',
      path: 'DataOps > 재고실사 > 마스터 신규등록',
      route: 'DataOps/재고실사/마스터신규등록',
      code: normalizedItem.코드,
      name: normalizedItem.품목명,
      spec: normalizedItem.규격,
      unit: normalizedItem.단위
    };
    const logs = [
      normalizeOfficialLog(historyApi, {
        ...basePayload,
        id: `${executionId}-job`,
        recordType: 'master_add_update_job',
        actionType: 'dataops_inventory_master_create_job',
        field: '작업',
        oldVal: '',
        newVal: '성공',
        memo: 'DataOps 재고실사 목록 외 상품 단건 신규등록'
      }),
      ...['코드', '품목명', '규격', '단위'].map((field, index) => normalizeOfficialLog(historyApi, {
        ...basePayload,
        id: `${executionId}-detail-${index + 1}`,
        recordType: 'master_add_update_detail',
        actionType: 'master_create',
        field,
        oldVal: '',
        newVal: normalizedItem[field],
        finalValue: normalizedItem[field],
        memo: 'DataOps 재고실사 관리자 확인 신규등록'
      }))
    ];
    const trigger = timestampISO;
    const commitResult = await commitNarrowMasterMutation({
      storage,
      historyApi,
      localStorageRef,
      currentState,
      nextMaster,
      expectedRevision,
      logs,
      localWrites: { [MASTER_SYNC_TRIGGER_KEY]: trigger },
      label: 'DataOps 마스터 단건 신규등록'
    });
    return {
      status: 'success',
      executionId,
      revision: commitResult.revision,
      item: cloneValue(normalizedItem),
      masterMap: nextMaster,
      historyCount: logs.length
    };
  };

  const normalizeStoppedProducts = (input = {}) => {
    const out = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
    Object.entries(input).forEach(([fallbackCode, value]) => {
      const item = value && typeof value === 'object' ? cloneValue(value) : {};
      const code = normalizeSharedProductCode(item.productCode || item.code || fallbackCode);
      if (!code) return;
      out[code] = { ...item, productCode: code };
    });
    return out;
  };

  const normalizePendingShopStatus = (input = []) => {
    const out = [];
    const positions = new Map();
    (Array.isArray(input) ? input : []).forEach(value => {
      const item = value && typeof value === 'object' ? cloneValue(value) : {};
      const code = normalizeSharedProductCode(item.code || item.productCode);
      if (!code) return;
      const normalized = { ...item, code };
      if (positions.has(code)) out[positions.get(code)] = normalized;
      else {
        positions.set(code, out.length);
        out.push(normalized);
      }
    });
    return out;
  };

  const commitSalesStatusChanges = async ({
    codes = [],
    expectedRevision,
    storage,
    historyApi,
    localStorageRef,
    actor = null,
    reason = '재고실사 양수 재고 발견'
  } = {}) => {
    if (!storage || typeof storage.commitMasterStateOrThrow !== 'function' || typeof storage.readMasterSnapshotState !== 'function') {
      throw new Error('공통 master 저장 엔진을 사용할 수 없습니다.');
    }
    if (!localStorageRef) throw new Error('공식 history 저장소를 사용할 수 없습니다.');
    const targetCodes = Array.from(new Set((Array.isArray(codes) ? codes : []).map(normalizeSharedProductCode).filter(Boolean)));
    if (targetCodes.length === 0) {
      throw createOperationalError('MASTER_SALES_STATUS_TARGET_REQUIRED', '판매재개 대상 품목코드가 없습니다.');
    }
    const currentState = await storage.readMasterSnapshotState([STOPPED_PRODUCTS_KEY, PENDING_SHOP_STATUS_KEY]);
    const currentMaster = assertExistingMaster(currentState.masterMap, 'DataOps 판매재개');
    if (currentState.revision !== expectedRevision) {
      const error = new Error('재고 마감 이후 master가 변경되었습니다. 최신 상태를 다시 읽고 판매재개를 재시도하세요.');
      error.code = 'MERCH_MASTER_REVISION_CONFLICT';
      throw error;
    }
    const resolver = new Map();
    Object.entries(currentMaster).forEach(([masterKey, masterItem]) => {
      const code = normalizeSharedProductCode(getMasterCode(masterItem, masterKey));
      if (code && !resolver.has(code)) resolver.set(code, { masterKey, item: masterItem });
    });
    const missingCodes = targetCodes.filter(code => !resolver.has(code));
    if (missingCodes.length > 0) {
      throw createOperationalError(
        'MASTER_SALES_STATUS_TARGET_MISSING',
        `마스터에서 판매재개 대상 품목코드를 찾지 못했습니다: ${missingCodes.join(', ')}`,
        { missingCodes }
      );
    }

    const nextMaster = cloneValue(currentMaster);
    const nextStoppedProducts = normalizeStoppedProducts(
      currentState.extraStoreEntries && currentState.extraStoreEntries[STOPPED_PRODUCTS_KEY] !== undefined
        ? currentState.extraStoreEntries[STOPPED_PRODUCTS_KEY]
        : readLocalJSON(localStorageRef, STOPPED_PRODUCTS_KEY, {})
    );
    let nextPendingShopStatus = normalizePendingShopStatus(
      currentState.extraStoreEntries && currentState.extraStoreEntries[PENDING_SHOP_STATUS_KEY] !== undefined
        ? currentState.extraStoreEntries[PENDING_SHOP_STATUS_KEY]
        : readLocalJSON(localStorageRef, PENDING_SHOP_STATUS_LOCAL_KEY, [])
    );
    const timestampISO = new Date().toISOString();
    const timestamp = new Date().toLocaleString('ko-KR');
    const executionId = `dataops-sales-resume-${Date.now()}-${global.crypto && typeof global.crypto.randomUUID === 'function' ? global.crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
    const logs = [];
    const changedCodes = [];
    let sharedStateChanged = false;

    targetCodes.forEach(code => {
      const resolved = resolver.get(code);
      const oldItem = cloneValue(resolved.item || {});
      const oldSaleValue = oldItem['판매여부'] ?? '';
      if (String(oldSaleValue).trim() !== '1') {
        nextMaster[resolved.masterKey] = { ...oldItem, 판매여부: 1 };
        changedCodes.push(code);
        logs.push(normalizeOfficialLog(historyApi, {
          id: `${executionId}-detail-${logs.length + 1}`,
          recordType: 'master_add_update_detail',
          executionId,
          mode: '판매재개',
          actor: actor || null,
          actorStatus: actor ? 'identified' : 'identity-system-unavailable',
          timestamp,
          timestampISO,
          source: 'dataops_inventory',
          sourceRole: 'dataops',
          sourceLabel: 'DataOps 재고실사',
          actionType: 'dataops_inventory_sales_resume',
          historyType: '판매재개',
          changeType: '판매재개',
          applyMode: 'direct_master_apply',
          path: 'DataOps > 재고실사 > 마감 후 판매재개',
          route: 'DataOps/재고실사/마감후판매재개',
          code,
          name: oldItem['품목명'] || '',
          spec: oldItem['규격'] || '',
          unit: oldItem['단위'] || '',
          field: '판매여부',
          oldVal: oldSaleValue,
          newVal: 1,
          diff: '',
          diffRate: null,
          reason,
          memo: 'DataOps 재고실사 마감에서 양수 재고가 확인되어 판매 재개',
          finalValue: 1,
          version: 'dataops-inventory-master-add-v1'
        }));
      }
      if (Object.prototype.hasOwnProperty.call(nextStoppedProducts, code)) {
        delete nextStoppedProducts[code];
        sharedStateChanged = true;
      }
      const pendingIndex = nextPendingShopStatus.findIndex(entry => normalizeSharedProductCode(entry && entry.code) === code);
      const pendingEntry = {
        code,
        type: 'resume',
        name: oldItem['품목명'] || '',
        source: 'DataOps',
        reason,
        memo: '재고실사 마감 양수 재고 판매재개',
        updatedAt: timestampISO
      };
      if (pendingIndex < 0) {
        nextPendingShopStatus.push(pendingEntry);
        sharedStateChanged = true;
      } else if (String(nextPendingShopStatus[pendingIndex] && nextPendingShopStatus[pendingIndex].type || '').trim() !== 'resume') {
        nextPendingShopStatus[pendingIndex] = pendingEntry;
        sharedStateChanged = true;
      }
    });

    if (changedCodes.length === 0 && !sharedStateChanged) {
      return {
        status: 'noop',
        revision: currentState.revision,
        changedCodes: [],
        processedCodes: targetCodes,
        historyCount: 0,
        masterMap: currentMaster
      };
    }

    const trigger = timestampISO;
    const extraStoreEntries = {
      [STOPPED_PRODUCTS_KEY]: nextStoppedProducts,
      [PENDING_SHOP_STATUS_KEY]: nextPendingShopStatus
    };
    const localWrites = {
      [STOPPED_PRODUCTS_KEY]: nextStoppedProducts,
      [PENDING_SHOP_STATUS_LOCAL_KEY]: nextPendingShopStatus,
      [MASTER_SYNC_TRIGGER_KEY]: trigger,
      [STOP_MANAGER_SYNC_TRIGGER_KEY]: trigger
    };
    const commitResult = await commitNarrowMasterMutation({
      storage,
      historyApi,
      localStorageRef,
      currentState,
      nextMaster,
      expectedRevision,
      logs,
      extraStoreEntries,
      localWrites,
      label: 'DataOps 판매재개'
    });
    return {
      status: 'success',
      executionId,
      revision: commitResult.revision,
      changedCodes,
      processedCodes: targetCodes,
      historyCount: logs.length,
      masterMap: nextMaster,
      stoppedProducts: nextStoppedProducts,
      pendingShopStatus: nextPendingShopStatus
    };
  };

  const commitApprovedChanges = async ({
    analysis,
    currentMaster,
    expectedRevision,
    storage,
    historyApi,
    localStorageRef,
    actor = null
  } = {}) => {
    if (!storage || typeof storage.commitMasterStateOrThrow !== 'function' || typeof storage.readMasterSnapshotState !== 'function') {
      throw new Error('공통 master 저장 엔진을 사용할 수 없습니다.');
    }
    if (!localStorageRef) throw new Error('공식 history 저장소를 사용할 수 없습니다.');
    const currentState = await storage.readMasterSnapshotState();
    assertExistingMaster(currentState.masterMap, '추가·갱신 저장');
    if (currentState.revision !== expectedRevision) {
      const error = new Error('비교 이후 master가 변경되었습니다. 최신 master로 비교를 다시 생성해야 합니다.');
      error.code = 'MERCH_MASTER_REVISION_CONFLICT';
      throw error;
    }
    const plan = buildExecutionPlan(analysis, currentState.masterMap);
    assertNewProductsComplete(plan, '추가·갱신 최종 저장 경계');
    if (plan.counts.savedProductCount === 0 || plan.details.length === 0) {
      const error = new Error('관리자 확인·승인을 마친 저장 대상이 없습니다.');
      error.code = 'MASTER_ADD_UPDATE_NOTHING_APPROVED';
      throw error;
    }

    const executionId = createExecutionId();
    const timestampISO = new Date().toISOString();
    const logs = buildOfficialLogs({
      executionId,
      actor,
      fileName: analysis.fileName,
      plan,
      historyApi,
      timestampISO
    });
    const previousHistoryRaw = localStorageRef.getItem(HISTORY_KEY);
    const preparedHistory = prepareHistoryAppend(localStorageRef, logs, historyApi);
    const baseMaster = buildMasterIndex(currentState.masterMap);
    let commitResult;
    try {
      commitResult = await storage.commitMasterStateOrThrow(plan.nextMaster, {
        expectedRevision,
        afterVerified: async () => {
          writeAndVerifyHistory(storage, localStorageRef, logs, preparedHistory);
          await verifyMasterAndHistory({
            storage,
            localStorageRef,
            nextMaster: plan.nextMaster,
            logs
          });
          return true;
        },
        afterVerifiedError: 'Master 추가·갱신 master/history 검증 실패'
      });
    } catch (error) {
      const rollbackErrors = [];
      try {
        restoreHistory(storage, localStorageRef, previousHistoryRaw, logs);
      } catch (historyRollbackError) {
        rollbackErrors.push(historyRollbackError.message);
      }
      try {
        let rollbackState = await storage.readMasterSnapshotState();
        if (stableSerialize(rollbackState.masterMap) !== stableSerialize(baseMaster)) {
          const attemptedRevision = error && error.result && error.result.revision;
          if (attemptedRevision && rollbackState.revision === attemptedRevision) {
            await storage.commitMasterStateOrThrow(baseMaster, {
              expectedRevision: rollbackState.revision,
              allowEmpty: Object.keys(baseMaster).length === 0
            });
            rollbackState = await storage.readMasterSnapshotState();
          }
        }
        if (stableSerialize(rollbackState.masterMap) !== stableSerialize(baseMaster)) {
          rollbackErrors.push('master rollback 후 기존 master 값과 일치하지 않습니다.');
        }
      } catch (masterRollbackError) {
        rollbackErrors.push(masterRollbackError.message);
      }
      if (rollbackErrors.length > 0) {
        const wrapped = new Error(`${error.message} / rollback 확인 실패: ${rollbackErrors.join(' / ')}`);
        wrapped.code = 'MASTER_ADD_UPDATE_ROLLBACK_FAILED';
        wrapped.cause = error;
        throw wrapped;
      }
      error.message = `${error.message} 변경 전 master와 history를 유지했습니다.`;
      throw error;
    }

    return {
      status: 'success',
      executionId,
      revision: commitResult.revision,
      masterMap: plan.nextMaster,
      counts: plan.counts,
      historyCount: logs.length,
      actor: actor || null,
      actorStatus: actor ? 'identified' : 'identity-system-unavailable'
    };
  };

  global.ONEAPP_MASTER_ADD_UPDATE = {
    HISTORY_KEY,
    MODE,
    CODE_FIELDS,
    EDITABLE_FIELDS,
    REQUIRED_NEW_FIELDS,
    HISTORY_DEFAULT_LIMIT,
    ERROR_CODES,
    ISSUE_TAGS,
    normalizeCode,
    normalizeSharedProductCode,
    getRowCode,
    getMasterCode,
    buildMasterIndex,
    assertExistingMaster,
    parseWorkbook,
    analyzeUploadRows,
    summarize,
    filterCandidates,
    setProductApproved,
    setProductExcluded,
    setAdminComplete,
    setFieldDecision,
    resolveDuplicate,
    clearMasterMismatch,
    getFieldFinalValue,
    assertNewProductsComplete,
    buildExecutionPlan,
    buildOfficialLogs,
    prepareHistoryAppend,
    verifyMasterAndHistory,
    commitApprovedChanges,
    normalizeSingleProductInput,
    validateSingleProductInput,
    commitSingleProductRegistration,
    commitSalesStatusChanges,
    stableSerialize
  };
})(window);
