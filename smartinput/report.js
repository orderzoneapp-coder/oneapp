// SmartInput role consolidation. No data migration or business-policy change.
// Edit implementations in the named sections below; former files are removed.
import * as estimatePriceSnapshotDependency0 from "./estimate-price-snapshot.js?v=0.1.0";

// ============================================================================
// stage5-compute-runner.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const stage5ComputeRunnerSection = (() => {


const DEFAULT_WORKER_THRESHOLD_ROWS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

const now = () => globalThis.performance?.now?.() ?? Date.now();

function abortError() {
  const error = new Error('계산 작업이 취소되었습니다.');
  error.name = 'AbortError';
  return error;
}

function runDirect({ feature, phase, direct, path = 'direct', onMetric }) {
  const startedAt = now();
  try {
    const value = direct();
    onMetric?.({ feature, phase, path, durationMs: now() - startedAt });
    return value;
  } catch (error) {
    onMetric?.({ feature, phase, path, status: 'ERROR', durationMs: now() - startedAt });
    throw error;
  }
}

async function runStage5Compute({
  feature,
  phase,
  payload,
  rowCount = 0,
  direct,
  signal = null,
  thresholdRows = DEFAULT_WORKER_THRESHOLD_ROWS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  workerFactory = null,
  onMetric = null
} = {}) {
  if (typeof direct !== 'function') throw new TypeError('direct 계산 함수가 필요합니다.');
  if (signal?.aborted) throw abortError();
  const WorkerConstructor = globalThis.Worker;
  if (Number(rowCount) < Number(thresholdRows)
    || (!workerFactory && typeof WorkerConstructor !== 'function')) {
    return runDirect({ feature, phase, direct, onMetric });
  }

  let worker;
  const jobId = globalThis.crypto?.randomUUID?.() || `stage5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const queuedAt = now();
  try {
    worker = workerFactory
      ? workerFactory()
      : new WorkerConstructor(new URL('./stage5-compute-worker.js?v=0.17.0', import.meta.url), { type: 'module', name: 'smartinput-stage5-compute' });
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = callback => value => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout?.(timer);
        signal?.removeEventListener?.('abort', onAbort);
        callback(value);
      };
      const onAbort = () => finish(reject)(abortError());
      const timer = globalThis.setTimeout?.(() => finish(reject)(new Error('계산 작업 시간이 초과되었습니다.')), timeoutMs);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      worker.onmessage = event => {
        const message = event.data || {};
        if (message.jobId !== jobId || message.status === 'PROGRESS') return;
        if (message.status === 'READY') finish(resolve)(message);
        else finish(reject)(new Error(message.message || 'Worker 계산에 실패했습니다.'));
      };
      worker.onerror = event => finish(reject)(event.error || new Error(event.message || 'Worker를 실행하지 못했습니다.'));
      worker.postMessage({ jobId, feature, phase, payload });
    });
    onMetric?.({ feature, phase, path: 'worker', durationMs: now() - queuedAt, computeMs: result.metrics?.computeMs ?? null });
    return result.payload;
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    return runDirect({ feature, phase, direct, path: 'fallback-direct', onMetric });
  } finally {
    worker?.terminate?.();
  }
}

return { runStage5Compute, DEFAULT_WORKER_THRESHOLD_ROWS };
})();

// ============================================================================
// estimate-output.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const estimateOutputSection = (() => {


const SHOP_HEADERS = Object.freeze([
  '상품코드\n코드', '상품명', '규격', '출고가', '도매A', '시중가', 'B판매가', '도매B',
  'C 판매가', 'C 도매가', 'D 판매가', 'D 도매가', '브랜드', '기본설명', '판매여부',
  '재고수량', '테마1', '테마2', '테마3', '테마4', '테마5', '상품태그'
]);
const ERP_HEADERS = Object.freeze([
  '품목코드', '입고가', '0', '출고가', '0', '입고B', 'n', '도매A', 'n', '도매B', 'n'
]);
const CONFIRM_HEADERS = Object.freeze([
  '확인구분', '상품코드', '상품명', '규격', '기준입고항목', '기준입고가', '도매항목', '도매가', '차이', '확인요청'
]);
const ESTIMATE_UPLOAD_HEADERS = Object.freeze([
  '일자', '순번', '거래처코드', '거래처명', '출하창고', '거래유형', '참조', '담당자',
  '품목코드', '품목명', '규격', '수량', '단가', 'B단가', 'A판매', 'B판매', '적요', '지시사항', '적요2'
]);
const MERCHOPS_DEFAULT_MARGIN_RULES = Object.freeze([
  Object.freeze({ id: 'rule_1', whCode: '01', unit: 'box, 박스, BOX', rate: 10, type: 'divide' }),
  Object.freeze({ id: 'rule_2', whCode: '01', unit: 'ea, 개, 낱개, EA, kg, 단', rate: 15, type: 'divide' }),
  Object.freeze({ id: 'rule_03_box', whCode: '03', unit: 'box, 박스, BOX', rate: 10, type: 'divide' }),
  Object.freeze({ id: 'rule_03_ea', whCode: '03', unit: 'ea, 개, 낱개, EA, kg, 단', rate: 15, type: 'divide' }),
  Object.freeze({ id: 'rule_3', whCode: '03,05', unit: 'box, 박스, BOX', rate: 15, type: 'divide' }),
  Object.freeze({ id: 'rule_4', whCode: '03,05', unit: 'ea, 개, 낱개, EA, kg, 단', rate: 10, type: 'divide' }),
  Object.freeze({ id: 'rule_5', whCode: '77,99', unit: 'box, 박스, BOX', rate: 10, type: 'divide' }),
  Object.freeze({ id: 'rule_6', whCode: '77,99', unit: 'ea, 개, 낱개, EA, kg, 단', rate: 15, type: 'divide' }),
  Object.freeze({ id: 'default', whCode: '*', unit: '*', rate: 20, type: 'divide' })
]);
const KAKAO_NOTICE_ROWS_PER_PAGE = 40;

function paginateKakaoNoticeRows(rows = [], maxRowsPerPage = KAKAO_NOTICE_ROWS_PER_PAGE) {
  const source = Array.isArray(rows) ? rows : [];
  if (!source.length) return [[]];
  const maximum = Math.max(1, Math.min(KAKAO_NOTICE_ROWS_PER_PAGE, Math.floor(Number(maxRowsPerPage)) || KAKAO_NOTICE_ROWS_PER_PAGE));
  return Array.from({ length: Math.ceil(source.length / maximum) }, (_, pageIndex) => source.slice(pageIndex * maximum, (pageIndex + 1) * maximum));
}

function splitKakaoNoticeColumns(rows = []) {
  const source = Array.isArray(rows) ? rows.slice(0, KAKAO_NOTICE_ROWS_PER_PAGE) : [];
  return source.length <= 20 ? [source] : [source.slice(0, 20), source.slice(20)];
}

function text(value) {
  return String(value ?? '').trim();
}

function numeric(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[,원₩]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceNumber(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  const parsed = numeric(value);
  return parsed === null ? 0 : parsed;
}

const own = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
const normalizedSourceHeader = value => text(value).normalize('NFKC').replace(/\s+/g, '');

function sourceFieldEntry(row = {}, aliases = []) {
  const fields = row.estimateF8SourceFields && typeof row.estimateF8SourceFields === 'object'
    ? row.estimateF8SourceFields
    : {};
  for (const alias of aliases) {
    const key = normalizedSourceHeader(alias);
    if (own(fields, key)) return fields[key];
  }
  return null;
}

function directValue(row = {}, keys = [], fallback = '') {
  for (const key of keys) {
    if (!own(row, key)) continue;
    if (row.estimateF8SourceOnly === true && !row.editedFields?.[key]) continue;
    const value = row[key];
    if (value === null || value === undefined) continue;
    return value;
  }
  return fallback;
}

function explicitDirectValue(row = {}, keys = []) {
  for (const key of keys) {
    if (!row.editedFields?.[key] || !own(row, key)) continue;
    const value = row[key];
    return { found: true, value: value === null || value === undefined ? '' : value };
  }
  return { found: false, value: '' };
}

function presentOutputValue(row = {}, aliases = [], directKeys = []) {
  const explicit = explicitDirectValue(row, directKeys);
  if (explicit.found) return explicit;
  const source = sourceFieldEntry(row, aliases);
  if (source) return { found: true, value: source.currentDisplayValue ?? source.displayValue ?? '' };
  for (const key of directKeys) {
    if (!own(row, key)) continue;
    if (row.estimateF8SourceOnly === true && !row.editedFields?.[key]) continue;
    return { found: true, value: row[key] ?? '' };
  }
  return { found: false, value: '' };
}

function outputNumber(row = {}, aliases = [], directKeys = [], fallback = '') {
  const explicit = explicitDirectValue(row, directKeys);
  if (explicit.found) return explicit.value === '' ? '' : sourceNumber(explicit.value);
  const source = sourceFieldEntry(row, aliases);
  if (source) {
    const displayValue = source.currentDisplayValue ?? source.displayValue ?? '';
    if (String(displayValue).trim() === '') return '';
    if (typeof source.parsedValue === 'number' && Number.isFinite(source.parsedValue)) return source.parsedValue;
    return sourceNumber(displayValue);
  }
  const value = directValue(row, directKeys, fallback);
  return value === '' ? '' : sourceNumber(value);
}

function outputText(row = {}, aliases = [], directKeys = [], fallback = '') {
  const explicit = explicitDirectValue(row, directKeys);
  if (explicit.found) return String(explicit.value);
  const source = sourceFieldEntry(row, aliases);
  if (source) return String(source.currentDisplayValue ?? source.displayValue ?? '');
  const value = directValue(row, directKeys, fallback);
  return value === null || value === undefined ? '' : String(value);
}

const normalizedCodeValue = value => String(value ?? '').replace(/\s/g, '');

function outputCode(row = {}) {
  return normalizedCodeValue(outputText(row, ['품목코드', '상품코드', '코드'], ['itemCode']));
}

function mappingSourceFields(row = {}, mappingSession = null) {
  if (!mappingSession) return {};
  const workingRow = (mappingSession.workingRows || []).find(candidate => text(candidate?.rowId) === text(row?.rowId));
  const fields = {};
  const headerRowIndex = Number(mappingSession.headerRowIndex || 0);
  const headers = Array.isArray(mappingSession.headers) && mappingSession.headers.length
    ? mappingSession.headers
    : (mappingSession.sourceMatrix?.[headerRowIndex] || []);
  const mappingsByColumn = new Map((mappingSession.mappings || [])
    .filter(mapping => ['MAPPED', 'RECOMMENDED'].includes(mapping?.state))
    .map(mapping => [Number(mapping.columnIndex), mapping]));
  headers.forEach((sourceHeader, columnIndex) => {
    const header = normalizedSourceHeader(sourceHeader);
    if (!header || own(fields, header)) return;
    const mapping = mappingsByColumn.get(columnIndex);
    const tracked = mapping ? row?.fieldValues?.[mapping.targetFieldId] : null;
    const workingValue = workingRow?.cells?.[columnIndex];
    const rawSourceRowIndex = workingRow?.sourceRowIndex;
    const sourceRowIndex = rawSourceRowIndex === null || rawSourceRowIndex === undefined || rawSourceRowIndex === ''
      ? Number.NaN
      : Number(rawSourceRowIndex);
    const sourceValue = Number.isInteger(sourceRowIndex) && sourceRowIndex >= 0
      ? mappingSession.sourceMatrix?.[sourceRowIndex]?.[columnIndex]
      : undefined;
    fields[header] = Object.freeze({
      currentDisplayValue: String(tracked?.currentDisplayValue ?? workingValue ?? sourceValue ?? ''),
      parsedValue: tracked?.parsedValue ?? null,
      targetFieldId: text(mapping?.targetFieldId)
    });
  });
  return fields;
}

function buildEstimateF8RowsFromDraft(draft = {}) {
  const rows = Array.isArray(draft?.rows) ? draft.rows : [];
  const header = draft?.header || {};
  const mappingBacked = Boolean(
    draft?.inputMapping
    && ((Array.isArray(draft.inputMapping.headers) && draft.inputMapping.headers.length)
      || (Array.isArray(draft.inputMapping.sourceMatrix) && draft.inputMapping.sourceMatrix.length))
  );
  const workingRowsById = mappingBacked
    ? new Map((draft.inputMapping.workingRows || []).map(row => [text(row?.rowId), row]))
    : new Map();
  return rows.map((row, rowIndex) => {
    const workingRow = mappingBacked
      ? workingRowsById.get(text(row?.rowId))
      : null;
    const sourceMatrixIndex = Number(workingRow?.sourceRowIndex);
    return {
      ...row,
      rowVoucherDate: row?.rowVoucherDate || header.voucherDate || header.deliveryDate || header.orderDate || '',
      rowCustomerCode: row?.rowCustomerCode || header.customerCode || '',
      rowCustomerName: row?.rowCustomerName || header.customerName || '',
      rowWarehouseCode: row?.rowWarehouseCode || header.warehouseCode || header.warehouseName || '',
      rowTransactionType: row?.rowTransactionType || header.transactionType || '',
      reference: row?.reference || header.reference || '',
      manager: row?.manager || header.managerName || header.manager || '',
      estimateF8SourceOnly: mappingBacked || row?.estimateF8SourceOnly === true,
      estimateF8SourceRowNumber: Number.isInteger(sourceMatrixIndex) && sourceMatrixIndex >= 0
        ? sourceMatrixIndex + 1
        : (row?.estimateF8SourceRowNumber || rowIndex + 1),
      estimateF8SourceFields: mappingBacked
        ? mappingSourceFields(row, draft?.inputMapping)
        : (row?.estimateF8SourceFields && typeof row.estimateF8SourceFields === 'object' ? row.estimateF8SourceFields : {})
    };
  });
}

function linkedRefSignature(row = {}) {
  const refs = Array.isArray(row.linkedSourceRefs) && row.linkedSourceRefs.length
    ? row.linkedSourceRefs
    : (row.linkedSourceEstimateId && row.linkedSourceRowId
      ? [{ estimateId: row.linkedSourceEstimateId, rowId: row.linkedSourceRowId }]
      : []);
  return refs.map(ref => `${text(ref?.estimateId)}:${text(ref?.rowId)}`).filter(value => value !== ':').sort().join('|');
}

function derivedPlanRows(entry = {}) {
  const sourceRows = [];
  (entry.sourceDrafts || []).forEach((draft, sourceIndex) => {
    const estimateId = text(entry.sourceIds?.[sourceIndex]);
    buildEstimateF8RowsFromDraft(draft).forEach((row, rowIndex) => {
      const sourceRowId = text(row.rowId) || `ROW-${rowIndex + 1}`;
      sourceRows.push({
        ...row,
        linkedSourceEstimateId: estimateId,
        linkedSourceRowId: sourceRowId,
        linkedSourceEstimateIds: estimateId ? [estimateId] : [],
        linkedSourceRefs: estimateId ? [{ estimateId, rowId: sourceRowId }] : []
      });
    });
  });

  const workingRows = Array.isArray(entry.workingDraft?.rows) ? entry.workingDraft.rows : [];
  const workingByRefs = new Map(workingRows
    .map(row => [linkedRefSignature(row), row])
    .filter(([signature]) => signature));
  const restored = sourceRows.map(row => {
    const working = workingByRefs.get(linkedRefSignature(row));
    if (!working) return row;
    const fields = [...new Set([
      ...Object.entries(working.editedFields || {}).filter(([, edited]) => edited).map(([field]) => field),
      ...(working.linkedSyncFields || [])
    ])];
    if (!fields.length) return row;
    const next = {
      ...row,
      editedFields: {
        ...(row.editedFields || {}),
        ...(working.editedFields || {}),
        ...Object.fromEntries(fields.map(field => [field, true]))
      }
    };
    fields.forEach(field => { next[field] = working[field]; });
    return next;
  });
  const manualRows = workingRows.filter(row => !linkedRefSignature(row));
  return [...restored, ...buildEstimateF8RowsFromDraft({ rows: manualRows })];
}

function buildEstimateF8RowsFromPlan(plan = {}) {
  return (plan.entries || []).flatMap(entry => (
    entry?.kind === 'DERIVED'
      ? derivedPlanRows(entry)
      : buildEstimateF8RowsFromDraft(entry?.draft || {})
  ));
}

function itemLabel(row = {}) {
  return [text(row.itemCode), text(row.itemName)].filter(Boolean).join(' · ') || '품목 확인 필요';
}

function estimateIssue(code, row, rowIndex, field, originalValue, message, guide) {
  return { code, rowIndex, item: itemLabel(row), field, originalValue, message, guide };
}

function priceKey(row = {}, index = 0) {
  const masterId = text(row.masterProductId);
  if (masterId) return `MASTER:${masterId}`;
  const code = text(row.itemCode);
  return code ? `CODE:${code}` : `ROW:${index}`;
}



function normalizeNoticePriceFields(priceFields = []) {
  const normalized = (Array.isArray(priceFields) ? priceFields : []).map(field => ({
    id: text(typeof field === 'string' ? field : field?.id),
    label: text(typeof field === 'string' ? field : field?.label)
  })).filter(field => field.id).filter((field, index, fields) => fields.findIndex(other => other.id === field.id) === index).slice(0, 2);
  return normalized.length ? normalized : [{ id: 'noticePrice', label: '공지단가' }];
}

function buildKakaoNoticeRows(rows = [], previousPrices = {}, priceFields = []) {
  const selectedPriceFields = normalizeNoticePriceFields(priceFields);
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const prices = selectedPriceFields.map(field => ({
      fieldId: field.id,
      label: field.label || field.id,
      value: numeric(row?.[field.id]) ?? 0
    }));
    const currentPrice = prices[0].value;
    const key = priceKey(row, index);
    const hasPrevious = Object.prototype.hasOwnProperty.call(previousPrices || {}, key);
    const previousPrice = hasPrevious ? numeric(previousPrices[key]) : null;
    return {
      key,
      itemCode: text(row.itemCode),
      nameSpec: [text(row.itemName), text(row.specification)].filter(Boolean).join(' · '),
      prices,
      price: currentPrice,
      change: previousPrice === null ? null : currentPrice - previousPrice,
      note: text(row.memo)
    };
  }).filter(row => row.itemCode || row.nameSpec);
}

function estimateOutputCandidates(rows = []) {
  // Keep original indices: duplicate selections belong to source rows, not the filtered list.
  return (Array.isArray(rows) ? rows : [])
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row }) => (
      text(outputCode(row))
      || text(outputText(row, ['품목명', '상품명'], ['itemName']))
    ));
}

function validateEstimateRows(rows = []) {
  const candidates = estimateOutputCandidates(rows);
  const errors = [];
  if (!candidates.length) errors.push({
    code: 'EMPTY', rowIndex: null, item: '', field: '품목', originalValue: '',
    message: '출력할 견적 품목이 없습니다.',
    guide: '견적 품목을 추가한 뒤 다시 출력하세요.'
  });
  const codeCounts = new Map();
  candidates.forEach(({ row, rowIndex }) => {
    const code = outputCode(row);
    if (!code) errors.push(estimateIssue(
      'ITEM_CODE_REQUIRED', row, rowIndex, '품목코드', row.itemCode ?? '', '품목코드가 없습니다.',
      '품목코드를 확인한 뒤 다시 출력하세요.'
    ));
    else codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
  });
  candidates.forEach(({ row, rowIndex }) => {
    const code = outputCode(row);
    if (code && codeCounts.get(code) > 1) errors.push(estimateIssue(
      'DUPLICATE_ITEM_CODE', row, rowIndex, '품목코드', code, `품목코드 ${code}가 중복되었습니다.`,
      '중복 품목 모아보기에서 대표 행과 입고가를 확정하세요.'
    ));
  });
  return { ok: errors.length === 0, errors, entries: candidates, rows: candidates.map(({ row }) => row) };
}

function resolutionForCode(resolutions, code) {
  if (resolutions instanceof Map) return resolutions.get(code) || null;
  return resolutions && typeof resolutions === 'object' ? resolutions[code] || null : null;
}

function duplicateCandidate(row, rowIndex, product, marginRules) {
  return {
    candidateId: `${outputCode(row)}:${rowIndex}`,
    rowIndex,
    sourceRowNumber: Number(row?.estimateF8SourceRowNumber) || rowIndex + 1,
    customerName: outputText(row, ['거래처명', '거래처'], ['rowCustomerName', 'customerName']),
    warehouseCode: outputText(row, ['출하창고', '창고', '창고코드'], ['rowWarehouseCode', 'warehouseCode']),
    itemName: outputText(row, ['품목명', '상품명'], ['itemName']),
    specification: outputText(row, ['규격', '단위'], ['specification', 'unit']),
    inboundPrice: outputNumber(row, ['입고가'], ['inboundPrice']),
    calculatedOutPrice: calculatedMerchOutPrice({ ...row, estimateF8InboundBasis: true }, product, marginRules),
    pricingProduct: product,
    row
  };
}

function buildEstimateDuplicateGroups(rows = [], { productCatalog = [], marginRules = [] } = {}) {
  const catalog = productCatalogIndex(productCatalog);
  const grouped = new Map();
  estimateOutputCandidates(rows).forEach(({ row, rowIndex }) => {
    const code = outputCode(row);
    if (!code) return;
    const entries = grouped.get(code) || [];
    entries.push(duplicateCandidate(row, rowIndex, catalog.get(code) || {}, marginRules));
    grouped.set(code, entries);
  });
  return [...grouped.entries()]
    .filter(([, candidates]) => candidates.length > 1)
    .map(([code, candidates]) => ({ code, candidates }));
}

function calculateEstimateResolvedPrice(row = {}, inboundPrice = '', {
  productCatalog = [], marginRules = [], pricingProduct = null
} = {}) {
  const code = outputCode(row);
  const product = pricingProduct && typeof pricingProduct === 'object'
    ? pricingProduct
    : (productCatalogIndex(productCatalog).get(code) || {});
  const parsedInbound = text(inboundPrice) === '' ? '' : numeric(inboundPrice);
  const resolvedRow = {
    ...row,
    inboundPrice: parsedInbound === null ? inboundPrice : parsedInbound,
    estimateF8InboundBasis: true,
    editedFields: { ...(row?.editedFields || {}), inboundPrice: true, outPrice: false }
  };
  return {
    inboundPrice: parsedInbound,
    outPrice: calculatedMerchOutPrice(resolvedRow, product, marginRules)
  };
}

function resolveEstimateDuplicateRows(rows = [], resolutions = new Map()) {
  const source = estimateOutputCandidates(rows);
  const grouped = new Map();
  source.forEach(({ row, rowIndex }) => {
    const code = outputCode(row);
    if (!code) return;
    const entries = grouped.get(code) || [];
    entries.push({ row, rowIndex });
    grouped.set(code, entries);
  });

  const duplicateCodes = new Set([...grouped.entries()].filter(([, entries]) => entries.length > 1).map(([code]) => code));
  const selectedByCode = new Map();
  const unresolvedCodes = [];
  duplicateCodes.forEach(code => {
    const resolution = resolutionForCode(resolutions, code);
    const entries = grouped.get(code) || [];
    const selected = entries.find(entry => entry.rowIndex === Number(resolution?.rowIndex));
    const rawInbound = resolution && Object.prototype.hasOwnProperty.call(resolution, 'inboundPrice')
      ? resolution.inboundPrice
      : (selected ? outputNumber(selected.row, ['입고가'], ['inboundPrice']) : '');
    const parsedInbound = text(rawInbound) === '' ? '' : numeric(rawInbound);
    if (!selected || (text(rawInbound) !== '' && (parsedInbound === null || parsedInbound < 0))) {
      unresolvedCodes.push(code);
      return;
    }
    selectedByCode.set(code, {
      rowIndex: selected.rowIndex,
      row: {
        ...selected.row,
        inboundPrice: parsedInbound,
        estimateF8InboundBasis: true,
        editedFields: { ...(selected.row?.editedFields || {}), inboundPrice: true, outPrice: false }
      }
    });
  });

  const resolvedRows = [];
  const selectedRowsByIndex = new Map();
  source.forEach(({ row, rowIndex }) => {
    const code = outputCode(row);
    if (!duplicateCodes.has(code)) {
      resolvedRows.push(row);
      return;
    }
    const selected = selectedByCode.get(code);
    if (selected?.rowIndex === rowIndex) {
      resolvedRows.push(selected.row);
      selectedRowsByIndex.set(rowIndex, selected.row);
    }
  });
  return { rows: resolvedRows, selectedRowsByIndex, unresolvedCodes, duplicateCodes: [...duplicateCodes] };
}

function saleCodeFromOutPrice(value) {
  return (numeric(value) || 0) > 0 ? '1' : '0';
}

function themeFlags(row = {}) {
  const explicit = [1, 2, 3, 4, 5].map(index => outputText(row, [`테마${index}`], [`theme${index}`]));
  if (explicit.some(value => text(value) !== '')) {
    return explicit.map(value => ['1', 'true'].includes(text(value).toLowerCase()) ? '1' : '');
  }
  const themeValue = outputText(row, ['행사테마'], ['promotionTheme', 'eventTheme']);
  const codes = new Set(String(themeValue || '').split(/[,/|\s]+/).map(text).filter(code => ['1', '2', '3', '4', '5'].includes(code)));
  return [1, 2, 3, 4, 5].map(index => codes.has(String(index)) ? '1' : '');
}

function collectWholesaleWarnings(rows = []) {
  const warnings = [];
  rows.forEach(row => {
    const code = outputCode(row);
    const name = outputText(row, ['품목명', '상품명'], ['itemName']);
    const specification = outputText(row, ['규격'], ['specification']);
    [
      { baseField: '입고가', baseAliases: ['입고가'], baseKeys: ['inboundPrice'], wholesaleField: '도매A', wholesaleAliases: ['도매A', 'A판매', 'A판매가'], wholesaleKeys: ['wholesaleA'] },
      { baseField: '입고B', baseAliases: ['입고B'], baseKeys: ['purchasePriceB'], wholesaleField: '도매B', wholesaleAliases: ['도매B', 'B도매', 'B도매가'], wholesaleKeys: ['wholesaleB'] }
    ].forEach(pair => {
      const basePrice = numeric(outputNumber(row, pair.baseAliases, pair.baseKeys));
      const wholesalePrice = numeric(outputNumber(row, pair.wholesaleAliases, pair.wholesaleKeys));
      if (!(basePrice > 0 && wholesalePrice > 0 && wholesalePrice < basePrice)) return;
      warnings.push([
        '매칭 도매가 낮음', code, name, specification, pair.baseField, basePrice,
        pair.wholesaleField, wholesalePrice, wholesalePrice - basePrice, `${pair.wholesaleField}가 ${pair.baseField}보다 낮음`
      ]);
    });
  });
  return warnings;
}

function productCatalogIndex(products = []) {
  const index = new Map();
  const source = Array.isArray(products) ? products : Object.values(products || {});
  source.forEach(product => {
    const code = normalizedCodeValue(product?.itemCode || product?.productCode || product?.code || product?.품목코드 || product?.상품코드 || product?.코드);
    if (code && !index.has(code)) index.set(code, product);
  });
  return index;
}

function catalogText(product = {}, keys = []) {
  for (const key of keys) {
    if (own(product, key) && text(product[key])) return String(product[key]);
    if (own(product?.raw, key) && text(product.raw[key])) return String(product.raw[key]);
  }
  return '';
}

function catalogValue(product = {}, keys = []) {
  for (const key of keys) {
    if (own(product, key)) return product[key];
    if (own(product?.raw, key)) return product.raw[key];
  }
  return '';
}

function normalizeMerchWarehouse(value) {
  const raw = text(value);
  if (!raw || raw === '*') return raw;
  return /^\d+$/.test(raw) ? String(Number(raw)).padStart(2, '0') : raw;
}

function merchUnitCandidates(value) {
  const raw = text(value).toLowerCase();
  if (!raw || raw === '*') return raw === '*' ? ['*'] : [];
  const normalized = raw.replace(/\s/g, '');
  return normalized ? [normalized] : [];
}

function isDefaultMarginRule(rule = {}) {
  return text(rule.whCode) === '*' && text(rule.unit) === '*';
}

function sanitizedMarginRules(rules = []) {
  const provided = Array.isArray(rules) ? rules.filter(rule => rule && typeof rule === 'object') : [];
  const legacyDefaultOnly = provided.length === 1
    && text(provided[0]?.whCode ?? '*') === '*'
    && text(provided[0]?.unit ?? '*') === '*'
    && (numeric(provided[0]?.rate) || 0) === 20;
  const source = provided.length && !legacyDefaultOnly ? provided : MERCHOPS_DEFAULT_MARGIN_RULES;
  const cleaned = source.map((rule, index) => ({
    id: text(rule.id) || `rule_${index + 1}`,
    whCode: text(rule.whCode),
    unit: text(rule.unit),
    rate: numeric(rule.rate) || 0,
    type: rule.type === 'multiply' ? 'multiply' : 'divide'
  }));
  let defaultSeen = false;
  const uniqueDefault = cleaned.filter(rule => {
    if (!isDefaultMarginRule(rule)) return true;
    if (defaultSeen) return false;
    defaultSeen = true;
    return true;
  });
  if (!defaultSeen) uniqueDefault.push({ ...MERCHOPS_DEFAULT_MARGIN_RULES[MERCHOPS_DEFAULT_MARGIN_RULES.length - 1] });
  return uniqueDefault;
}

function matchesMarginWarehouse(ruleWarehouse, warehouse) {
  const target = normalizeMerchWarehouse(warehouse);
  if (!target || text(ruleWarehouse) === '*') return false;
  return text(ruleWarehouse).split(/[,./|\s]+/).map(normalizeMerchWarehouse).filter(Boolean).includes(target);
}

function matchesMarginUnit(ruleUnit, unit) {
  const target = merchUnitCandidates(unit);
  if (!target.length || text(ruleUnit) === '*') return false;
  return text(ruleUnit).split(/[,./|\s]+/).flatMap(merchUnitCandidates).some(candidate => target.includes(candidate));
}

function selectedMarginRule(rules = [], warehouse = '', unit = '') {
  const safeRules = sanitizedMarginRules(rules);
  return safeRules.find(rule => !isDefaultMarginRule(rule)
    && matchesMarginWarehouse(rule.whCode, warehouse)
    && matchesMarginUnit(rule.unit, unit))
    || safeRules.find(isDefaultMarginRule)
    || MERCHOPS_DEFAULT_MARGIN_RULES[MERCHOPS_DEFAULT_MARGIN_RULES.length - 1];
}

function pricingNumber(row, aliases, directKeys, product, productKeys) {
  const current = presentOutputValue(row, aliases, directKeys);
  if (current.found && text(current.value) !== '') return numeric(current.value) || 0;
  return numeric(catalogValue(product, productKeys)) || 0;
}

function calculatedMerchOutPrice(row = {}, product = {}, marginRules = []) {
  const forceInboundBasis = row.estimateF8InboundBasis === true;
  const explicitOutPrice = explicitDirectValue(row, ['outPrice']);
  if (!forceInboundBasis && explicitOutPrice.found) return explicitOutPrice.value === '' ? '' : sourceNumber(explicitOutPrice.value);
  const sourceOutPrice = outputNumber(row, ['출고가', '판매가'], ['outPrice']);
  // MerchOps의 "불러오기 시 출고가 자동적용"과 같은 범위만 재계산한다.
  // 수기 견적과 불러온 뒤 사용자가 직접 수정한 출고가는 그대로 유지한다.
  if (!forceInboundBasis && row.estimateF8SourceOnly !== true) return sourceOutPrice;
  const inboundPrice = numeric(outputNumber(row, ['입고가'], ['inboundPrice']));
  if (!(inboundPrice > 0)) return forceInboundBasis ? '' : sourceOutPrice;
  const outsourcing = pricingNumber(
    row, ['외주비'], ['outsourcingStandardCost', 'outsourcingUnitPrice'], product,
    ['outsourcingStandardCost', 'outsourcingUnitPrice', '외주비']
  );
  const labor = pricingNumber(
    row, ['노무비'], ['laborStandardCost', 'laborUnitPrice'], product,
    ['laborStandardCost', 'laborUnitPrice', '노무비']
  );
  const warehouseState = presentOutputValue(row, ['창고', '창고코드'], ['rowWarehouseCode', 'warehouseCode']);
  const unitState = presentOutputValue(row, ['단위'], ['unit', 'finalUnit']);
  const warehouse = warehouseState.found ? warehouseState.value : catalogValue(product, ['warehouseCode', 'warehouse', '창고']);
  const unit = unitState.found ? unitState.value : catalogValue(product, ['finalUnit', 'unit', '단위']);
  const rule = selectedMarginRule(marginRules, warehouse, unit);
  const totalCost = inboundPrice + outsourcing + labor;
  const rate = numeric(rule.rate) || 0;
  const raw = rule.type === 'multiply'
    ? totalCost * (1 + (rate / 100))
    : totalCost / (1 - (rate / 100));
  return Math.round(raw / 100) * 100;
}

function estimateMappingOwnsField(estimateMappings = {}, field = '') {
  const mappings = estimateMappings?.estimate && typeof estimateMappings.estimate === 'object'
    ? estimateMappings.estimate
    : estimateMappings;
  return Boolean(mappings && typeof mappings === 'object' && text(mappings[field]));
}

function roundSubdivisionSalePrice(value) {
  const amount = Number(value) || 0;
  if (amount <= 0) return 0;
  const unit = amount >= 1000 ? 100 : 10;
  return Math.round(amount / unit) * unit;
}

function subdivisionCandidate(row = {}, effectiveOutPrice = '', estimateMappings = {}) {
  const code = outputCode(row);
  const subCode = normalizedCodeValue(outputText(row, ['1종코드'], ['type1Code']));
  const division = numeric(outputNumber(row, ['1종연산'], ['type1Operation']));
  if (!subCode || ['0', '00', '-'].includes(subCode) || !(division > 0)) return null;
  const inboundPrice = numeric(outputNumber(row, ['입고가'], ['inboundPrice'])) || 0;
  const outPrice = numeric(effectiveOutPrice) || 0;
  const outsourcing = numeric(outputNumber(row, ['외주비'], ['outsourcingStandardCost', 'outsourcingUnitPrice'])) || 0;
  // MerchOps QuickF8은 견적 source가 실제로 소유한 경비만 소분가에 더한다.
  const expense = row.estimateF8SourceOnly !== true || estimateMappingOwnsField(estimateMappings, '경비')
    ? (numeric(outputNumber(row, ['경비'], ['expenseStandardCost'])) || 0)
    : 0;
  const subInbound = inboundPrice > 0 ? Math.round(((inboundPrice + outsourcing) / division) / 100) * 100 : 0;
  const subSale = outPrice > 0 ? roundSubdivisionSalePrice((outPrice / division) + expense) : 0;
  if (subInbound <= 0 || subSale <= 0) return null;
  return {
    code: subCode,
    parentCode: code,
    parentInboundPrice: inboundPrice,
    subInbound,
    subSale,
    specification: outputText(row, ['1종규격'], ['type1Specification']),
    saleCode: '1',
    stock: 999,
    themes: themeFlags(row)
  };
}

function duplicateCodes(rows = []) {
  const counts = new Map();
  rows.slice(1).forEach(row => {
    const code = text(row?.[0]);
    if (code) counts.set(code, (counts.get(code) || 0) + 1);
  });
  return [...counts.entries()].filter(([, count]) => count > 1).map(([code]) => code);
}

function compareUploadText(left, right) {
  return text(left).localeCompare(text(right), 'ko-KR', { numeric: true, sensitivity: 'base' });
}

function sortEstimateUploadRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({ row, index }))
    .sort((left, right) => compareUploadText(left.row?.[3], right.row?.[3])
      || compareUploadText(left.row?.[8], right.row?.[8])
      || left.index - right.index)
    .map(entry => entry.row);
}

function buildEstimateF8Data(rows = [], {
  productCatalog = [], marginRules = [], estimateMappings = {}, duplicateResolutions = new Map()
} = {}) {
  const validation = validateEstimateRows(rows);
  const errors = validation.errors.filter(error => error.code !== 'DUPLICATE_ITEM_CODE');
  const duplicateResolution = resolveEstimateDuplicateRows(rows, duplicateResolutions);
  duplicateResolution.unresolvedCodes.forEach(code => errors.push({
    code: 'DUPLICATE_RESOLUTION_REQUIRED', item: code, field: '품목코드', originalValue: code,
    message: `품목코드 ${code}의 기준 입고가를 선택하거나 직접 입력하세요.`,
    guide: '중복 품목 모아보기에서 대표 행과 입고가를 확정하세요.'
  }));
  const shopData = [[...SHOP_HEADERS]];
  const erpData = [[...ERP_HEADERS]];
  const warnings = collectWholesaleWarnings(duplicateResolution.rows);
  const confirmData = [[...CONFIRM_HEADERS], ...warnings];
  const estimateUploadData = [[...ESTIMATE_UPLOAD_HEADERS]];
  const subdivisionByCode = new Map();
  const catalog = productCatalogIndex(productCatalog);

  validation.entries.forEach(({ row: originalRow, rowIndex }) => {
    const row = duplicateResolution.selectedRowsByIndex.get(rowIndex) || originalRow;
    const code = outputCode(row);
    const product = catalog.get(code) || {};
    const outPrice = calculatedMerchOutPrice(row, product, marginRules);
    const purchasePriceB = outputNumber(row, ['입고B'], ['purchasePriceB']);
    const wholesaleA = outputNumber(row, ['도매A', 'A판매', 'A판매가'], ['wholesaleA']);
    const wholesaleB = outputNumber(row, ['도매B', 'B도매', 'B도매가'], ['wholesaleB']);
    estimateUploadData.push([
      outputText(row, ['일자', '날짜', '견적일자'], ['rowVoucherDate']),
      outputText(row, ['순번', 'No.', '번호'], ['sequence']),
      outputText(row, ['거래처코드', '업체코드'], ['rowCustomerCode', 'customerCode']),
      outputText(row, ['거래처명', '거래처'], ['rowCustomerName', 'customerName']),
      outputText(row, ['출하창고', '창고', '창고코드'], ['rowWarehouseCode', 'warehouseCode']),
      outputText(row, ['거래유형'], ['rowTransactionType', 'transactionType']),
      outputText(row, ['참조'], ['reference']),
      outputText(row, ['담당자'], ['manager']),
      code,
      outputText(row, ['품목명', '상품명'], ['itemName']),
      outputText(row, ['규격', '단위'], ['specification', 'unit']),
      outputNumber(row, ['수량'], ['quantity']),
      row.estimateF8SourceOnly === true || row.estimateF8InboundBasis === true
        ? outPrice
        : outputNumber(row, ['단가', '출고가', '판매가'], ['unitPrice', 'outPrice']),
      purchasePriceB,
      wholesaleA,
      wholesaleB,
      outputText(row, ['적요'], ['memo']),
      outputText(row, ['지시사항', '간단설명'], ['description']),
      outputText(row, ['적요2'], ['memo2'])
    ]);
  });
  estimateUploadData.splice(1, estimateUploadData.length - 1, ...sortEstimateUploadRows(estimateUploadData.slice(1)));

  duplicateResolution.rows.forEach(row => {
    const code = outputCode(row);
    const product = catalog.get(code) || {};
    const inboundPrice = outputNumber(row, ['입고가'], ['inboundPrice']);
    const outPrice = calculatedMerchOutPrice(row, product, marginRules);
    const promoPrice = outputNumber(row, ['행사가'], ['promoPrice']);
    const shopSalePrice = (numeric(promoPrice) || 0) > 0 ? promoPrice : outPrice;
    const purchasePriceB = outputNumber(row, ['입고B'], ['purchasePriceB']);
    const wholesaleA = outputNumber(row, ['도매A', 'A판매', 'A판매가'], ['wholesaleA']);
    const wholesaleB = outputNumber(row, ['도매B', 'B도매', 'B도매가'], ['wholesaleB']);
    // MerchOps 가격 엔진은 입고가에서 계산한 출고가와 시중가를 같은 결과값으로 생성한다.
    // 불러온 견적서와 중복 해결행은 원본 시중가를 재사용하지 않고 동일 계산값을 출력한다.
    const marketPrice = (row.estimateF8SourceOnly === true || row.estimateF8InboundBasis === true)
      && !explicitDirectValue(row, ['marketPrice']).found
      ? outPrice
      : outputNumber(row, ['시중가', '시중단가'], ['marketPrice']);
    const themes = themeFlags(row);
    erpData.push([
      code, inboundPrice, '0', outPrice, '0', purchasePriceB, 'n', wholesaleA, 'n', wholesaleB, 'n'
    ]);
    shopData.push([
      code,
      outputText(row, ['품목명', '상품명'], ['itemName']),
      outputText(row, ['규격', '단위'], ['specification', 'unit']),
      shopSalePrice,
      wholesaleA,
      marketPrice,
      outputNumber(row, ['B판매가', 'B 판매가'], ['bSalePrice']),
      wholesaleB,
      0,
      0,
      0,
      0,
      outputText(row, ['브랜드'], ['brand']),
      outputText(row, ['간단설명', '기본설명'], ['productDescription']),
      saleCodeFromOutPrice(shopSalePrice),
      999,
      ...themes,
      outputText(row, ['검색어등록', '상품태그'], ['searchInfo', 'productTags'])
    ]);
    const subdivision = subdivisionCandidate(row, outPrice, estimateMappings);
    if (subdivision) subdivisionByCode.set(subdivision.code, [...(subdivisionByCode.get(subdivision.code) || []), subdivision]);
  });

  const selectedSubdivisions = new Map();
  subdivisionByCode.forEach((candidates, subCode) => {
    const byParent = new Map();
    candidates.forEach(candidate => {
      const previous = byParent.get(candidate.parentCode);
      if (previous && (previous.subInbound !== candidate.subInbound || previous.subSale !== candidate.subSale || previous.parentInboundPrice !== candidate.parentInboundPrice)) {
        errors.push({ code: 'SUBDIVISION_PRICE_CONFLICT', item: subCode, field: '1종코드', originalValue: subCode, message: `소분코드 ${subCode}의 계산 가격이 서로 다릅니다.`, guide: '원본 가격을 확인한 뒤 다시 출력하세요.' });
      } else if (!previous) byParent.set(candidate.parentCode, candidate);
    });
    if (byParent.size > 1) {
      errors.push({ code: 'SUBDIVISION_SOURCE_SELECTION_REQUIRED', item: subCode, field: '1종코드', originalValue: subCode, message: `소분코드 ${subCode}에 연결된 원물이 여러 개입니다.`, guide: 'MerchOps에서 원물을 선택하거나 한 원물만 남긴 뒤 다시 출력하세요.' });
      return;
    }
    if (byParent.size === 1) selectedSubdivisions.set(subCode, [...byParent.values()][0]);
  });

  selectedSubdivisions.forEach(subdivision => {
    const shopIndexes = shopData.map((row, index) => index > 0 && text(row[0]) === subdivision.code ? index : -1).filter(index => index > 0);
    const erpIndexes = erpData.map((row, index) => index > 0 && text(row[0]) === subdivision.code ? index : -1).filter(index => index > 0);
    if (shopIndexes.length > 1 || erpIndexes.length > 1) return;
    if (shopIndexes.length === 1 && erpIndexes.length === 1) {
      const shopRow = shopData[shopIndexes[0]];
      shopRow[3] = subdivision.subSale;
      shopRow[4] = subdivision.subSale;
      shopRow[5] = subdivision.subSale;
      // Existing and newly added subdivisions share the final sale/stock policy.
      shopRow[14] = subdivision.saleCode;
      shopRow[15] = subdivision.stock;
      const erpRow = erpData[erpIndexes[0]];
      erpRow[1] = subdivision.subInbound;
      erpRow[3] = subdivision.subSale;
      return;
    }
    const product = catalog.get(subdivision.code) || {};
    const name = catalogText(product, ['itemName', 'productName', '품목명', '상품명']);
    if (!name || shopIndexes.length !== erpIndexes.length) {
      errors.push({ code: 'SUBDIVISION_PRODUCT_REQUIRED', item: subdivision.code, field: '1종코드', originalValue: subdivision.code, message: `소분상품 ${subdivision.code}의 상품정보를 확인할 수 없습니다.`, guide: '상품 기준정보를 새로고침한 뒤 다시 출력하세요.' });
      return;
    }
    erpData.push([subdivision.code, subdivision.subInbound, '0', subdivision.subSale, '0', '', 'n', '', 'n', '', 'n']);
    shopData.push([
      subdivision.code,
      name,
      catalogText(product, ['specification', 'spec', '규격']) || subdivision.specification,
      subdivision.subSale,
      subdivision.subSale,
      subdivision.subSale,
      '', '', 0, 0, 0, 0,
      catalogText(product, ['brand', '브랜드']),
      catalogText(product, ['productDescription', '간단설명', '기본설명']),
      subdivision.saleCode,
      subdivision.stock,
      ...subdivision.themes,
      catalogText(product, ['searchInfo', 'productTags', '검색어등록', '상품태그'])
    ]);
  });

  const outputDuplicates = new Set([...duplicateCodes(shopData), ...duplicateCodes(erpData)]);
  outputDuplicates.forEach(code => {
    if (errors.some(error => error.code === 'DUPLICATE_ITEM_CODE' && text(error.originalValue) === code)) return;
    errors.push({ code: 'DUPLICATE_OUTPUT_CODE', item: code, field: '품목코드', originalValue: code, message: `품목코드 ${code}가 출력에서 중복되었습니다.`, guide: '중복 출력 행을 정리한 뒤 다시 출력하세요.' });
  });

  return {
    ok: errors.length === 0,
    validationOk: errors.length === 0,
    errors,
    warnings,
    rows: validation.rows,
    confirmData,
    estimateUploadData,
    errorData: confirmData,
    shopData,
    erpData,
    outputRowCount: Math.max(0, shopData.length - 1)
  };
}

function fitText(context, value, maxWidth) {
  const source = text(value);
  if (context.measureText(source).width <= maxWidth) return source;
  let output = source;
  while (output && context.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
  return `${output}…`;
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

function renderKakaoNoticeCanvases(noticeRows = [], { title = '견적 단가 안내', rowsPerPage = KAKAO_NOTICE_ROWS_PER_PAGE } = {}) {
  if (typeof document === 'undefined') return [];
  const rows = Array.isArray(noticeRows) ? noticeRows : [];
  const requestedPageSize = Math.floor(Number(rowsPerPage));
  const pageSize = Math.max(1, Math.min(KAKAO_NOTICE_ROWS_PER_PAGE, Number.isFinite(requestedPageSize) ? requestedPageSize : KAKAO_NOTICE_ROWS_PER_PAGE));
  const rowPages = paginateKakaoNoticeRows(rows, pageSize);
  const pages = [];
  const pageCount = rowPages.length;
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageRows = rowPages[pageIndex];
    const rowColumns = splitKakaoNoticeColumns(pageRows);
    const twoColumn = rowColumns.length === 2;
    const canvas = document.createElement('canvas');
    const width = twoColumn ? 1440 : 960;
    const headerHeight = 132;
    const tableHeaderHeight = 54;
    const rowHeight = 66;
    const footerHeight = 54;
    const visibleRowCount = Math.max(1, ...rowColumns.map(columnRows => columnRows.length));
    canvas.width = width;
    canvas.height = headerHeight + tableHeaderHeight + visibleRowCount * rowHeight + footerHeight;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fffaf4';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#10253f';
    context.fillRect(0, 0, width, headerHeight);
    context.fillStyle = '#f59e0b';
    context.fillRect(0, headerHeight - 7, width, 7);
    context.fillStyle = '#ffffff';
    context.font = '700 34px Pretendard, Arial, sans-serif';
    context.fillText(fitText(context, title, 700), 42, 58);
    context.fillStyle = '#cbd5e1';
    context.font = '500 19px Pretendard, Arial, sans-serif';
    context.fillText(new Date().toLocaleDateString('ko-KR'), 42, 96);
    context.textAlign = 'right';
    context.fillText(`${pageIndex + 1} / ${pageCount}`, width - 42, 96);
    context.textAlign = 'left';
    const selectedPriceFields = (pageRows[0]?.prices || rows[0]?.prices || [{ fieldId: 'noticePrice', label: '공지단가', value: 0 }]).slice(0, 2);
    const priceCount = Math.max(1, selectedPriceFields.length);
    const outerMargin = 24;
    const panelGap = twoColumn ? 20 : 0;
    const panelWidth = (width - (outerMargin * 2) - panelGap) / rowColumns.length;
    rowColumns.forEach((columnRows, panelIndex) => {
      const panelLeft = outerMargin + panelIndex * (panelWidth + panelGap);
      const nameWidth = twoColumn ? (priceCount === 2 ? 406 : 510) : (priceCount === 2 ? 552 : 650);
      const priceWidth = (panelWidth - nameWidth) / priceCount;
      const columns = [{ key: 'name', label: '품명·규격', left: panelLeft, width: nameWidth }];
      selectedPriceFields.forEach((field, index) => columns.push({ key: `price-${index}`, label: field.label, left: panelLeft + nameWidth + (priceWidth * index), width: priceWidth }));
      context.fillStyle = '#ffedd5';
      context.fillRect(panelLeft, headerHeight, panelWidth, tableHeaderHeight);
      context.fillStyle = '#9a4a08';
      context.font = `700 ${twoColumn ? 15 : 18}px Pretendard, Arial, sans-serif`;
      columns.forEach(column => context.fillText(fitText(context, column.label, column.width - 20), column.left + 10, headerHeight + 35));
      columnRows.forEach((row, rowIndex) => {
        const top = headerHeight + tableHeaderHeight + rowIndex * rowHeight;
        context.fillStyle = rowIndex % 2 ? '#fff7ed' : '#ffffff';
        context.fillRect(panelLeft, top, panelWidth, rowHeight);
        context.strokeStyle = '#fed7aa';
        context.beginPath();
        context.moveTo(panelLeft, top + rowHeight);
        context.lineTo(panelLeft + panelWidth, top + rowHeight);
        context.stroke();
        context.fillStyle = '#172033';
        context.font = `600 ${twoColumn ? 17 : 20}px Pretendard, Arial, sans-serif`;
        context.fillText(fitText(context, row.nameSpec, columns[0].width - 22), columns[0].left + 10, top + 40);
        context.textAlign = 'right';
        selectedPriceFields.forEach((field, priceIndex) => {
          const column = columns[priceIndex + 1];
          context.fillStyle = '#172033';
          context.fillText(formatAmount(row.prices?.[priceIndex]?.value ?? 0), column.left + column.width - 12, top + 40);
        });
        context.textAlign = 'left';
      });
    });
    if (!pageRows.length) {
      context.fillStyle = '#667085';
      context.font = '600 20px Pretendard, Arial, sans-serif';
      context.fillText('출력할 견적 품목이 없습니다.', 42, headerHeight + tableHeaderHeight + 42);
    }
    context.fillStyle = '#667085';
    context.font = '500 15px Pretendard, Arial, sans-serif';
    context.fillText(`SMART INPUT · ${selectedPriceFields.map(field => field.label).join(' · ')} 표시`, 42, canvas.height - 20);
    pages.push(canvas);
  }
  return pages;
}

const ESTIMATE_F8_HEADERS = Object.freeze({
  confirm: CONFIRM_HEADERS,
  error: CONFIRM_HEADERS,
  shop: SHOP_HEADERS,
  erp: ERP_HEADERS,
  upload: ESTIMATE_UPLOAD_HEADERS
});

return { runStage5Compute: stage5ComputeRunnerSection.runStage5Compute, DEFAULT_WORKER_THRESHOLD_ROWS: stage5ComputeRunnerSection.DEFAULT_WORKER_THRESHOLD_ROWS, KAKAO_NOTICE_ROWS_PER_PAGE, paginateKakaoNoticeRows, splitKakaoNoticeColumns, buildEstimateF8RowsFromDraft, buildEstimateF8RowsFromPlan, buildCatalogPriceSnapshot: estimatePriceSnapshotDependency0.buildCatalogPriceSnapshot, priceSnapshotsEqual: estimatePriceSnapshotDependency0.priceSnapshotsEqual, buildKakaoNoticeRows, validateEstimateRows, buildEstimateDuplicateGroups, calculateEstimateResolvedPrice, resolveEstimateDuplicateRows, sortEstimateUploadRows, buildEstimateF8Data, renderKakaoNoticeCanvases, ESTIMATE_F8_HEADERS };
})();

// ============================================================================
// purchase-sales-output.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const purchaseSalesOutputSection = (() => {


const CHECK_HEADERS = Object.freeze(['이슈', '그룹', '거래처', '품목코드', '품명', '수량', '확인사항']);
const SALES_HEADERS = Object.freeze([
  '일자', '순번', '거래처코드', '거래처명', '출하창고', '거래유형', '전잔액', '전달사항',
  '품목코드', '품목명', '규격', '수량', '단가', '외화금액', '공급가액', '적요', '출고지시',
  '공지', '구매처', '날짜', '구매'
]);
const OUTBOUND_HEADERS = Object.freeze(SALES_HEADERS.slice(0, 12));
const PURCHASE_HEADERS = Object.freeze(SALES_HEADERS.slice(0, 20));
const PREVIEW_HEADERS = Object.freeze([
  '일자', '거래처명', 'no.', '품목코드', '품명', '수량', '단가', '공급가', '적요',
  '출고지시', '출고가 (공지)', '구매처', '구매', '구매합계', '정리', '정산', '수수료'
]);
const SETTINGS_HEADERS = Object.freeze([
  '거래처명', '단가그룹', '단가적용순서', '수수료모드', '수익모드',
  '출력거래처명모드', '설정출처', '정확일치'
]);
const PURCHASE_UPLOAD_HEADERS = Object.freeze([
  '일자', '순번', '거래처코드', '거래처명', '입고창고', '거래유형', '전잔액', '전달사항',
  '코드', '품명', '규격(기본)', '수량', '단가', '외화금액', '공급가', '간단설명(품위)',
  '지시사항', '출고가 (공지)', '판매', 'no.'
]);

const SALES_WIDTHS = Object.freeze([10, 8, 12, 16, 8, 10, 10, 14, 14, 34, 14, 10, 12, 10, 14, 18, 18, 12, 18, 10, 12]);
const OUTBOUND_WIDTHS = Object.freeze([10, 8, 12, 16, 8, 10, 10, 20, 14, 34, 18, 10]);
const PURCHASE_WIDTHS = Object.freeze([10, 8, 12, 16, 8, 10, 10, 20, 14, 34, 18, 10, 12, 10, 14, 18, 18, 12, 18, 10]);
const PREVIEW_WIDTHS = Object.freeze([16, 14, 14, 14, 34, 9, 10, 12, 14, 14, 14, 18, 10, 12, 10, 12, 10]);
const CHECK_WIDTHS = Object.freeze([12, 14, 16, 14, 34, 10, 42]);
const PURCHASE_UPLOAD_WIDTHS = Object.freeze([10, 8, 14, 18, 10, 10, 12, 20, 14, 34, 16, 10, 12, 12, 14, 20, 18, 14, 10, 10]);

const GROUP_PRESETS = Object.freeze([
  Object.freeze({
    groupName: '청과상장',
    customers: Object.freeze(['1마산', '2중앙']),
    rule: Object.freeze(['출고가(공지)', '청과', '도매A/0.91', '상장가']),
    feeMode: 'LISTING_FEE', profitMode: 'NORMAL', outputCustomerMode: 'GROUP_NAME'
  }),
  Object.freeze({
    groupName: '식자재',
    customers: Object.freeze(['4연산', '5온산', '6진주', '7초전', '7남해', '8통영', '9구미']),
    rule: Object.freeze(['출고가(공지)', '식자재', '도매A', '출고(외노)']),
    feeMode: 'NONE', profitMode: 'NORMAL', outputCustomerMode: 'ORIGINAL_CUSTOMER'
  }),
  Object.freeze({
    groupName: '창고출고',
    customers: Object.freeze([
      '9부산', '금양', '상남식자재', '삼진', '진영상회',
      '농협114번', '농협123번', '농협12번', '농협15번', '농협19번', '농협30번', '농협33번',
      '농협35번', '농협37번', '농협38번', '농협44번', '농협45번', '농협62번', '농협65번',
      '농협666', '농협67', '농협67번', '농협69번', '농협6번', '농협70번', '농협77번',
      '농협78번', '농협81번', '농협888번', '농협89번', '창원100번', '창원118번', '창원153번',
      '창원24번', '창원38번', '창원39번', '창원48번', '창원56번', '창원59번', '창원88번',
      '대구구매', '마산구매', '부산현금', '현금구매', '현금판매'
    ]),
    rule: Object.freeze(['출고가(공지)', '도매A', '출고(외노)']),
    feeMode: 'NONE', profitMode: 'NORMAL', outputCustomerMode: 'ORIGINAL_CUSTOMER'
  }),
  Object.freeze({
    groupName: '내부이동',
    customers: Object.freeze(['3우리']),
    rule: Object.freeze(['단가']),
    feeMode: 'NONE', profitMode: 'ZERO_PROFIT', outputCustomerMode: 'GROUP_NAME'
  })
]);

const SUMMARY_TOKENS = Object.freeze(['총합계', '총계', '합계', '소계', '월계', '일계', 'subtotal', 'total']);

function text(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim() || fallback;
}

function normalizedHeader(value) {
  return text(value).normalize('NFKC').replace(/\s/g, '').toLowerCase();
}

function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const source = text(value).replace(/,/g, '');
  if (!source || !/^-?\d+(?:\.\d+)?$/.test(source)) return 0;
  const parsed = Number(source);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quantityValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const source = text(value).replace(/,/g, '');
  if (!source) return 0;
  const wrappedNegative = source.startsWith('(') && source.endsWith(')');
  const numericText = wrappedNegative ? source.slice(1, -1) : source;
  const parsed = Number(numericText);
  if (!Number.isFinite(parsed)) return 0;
  return wrappedNegative ? -parsed : parsed;
}

function rawCell(raw = {}, aliases = [], { allowBlank = false } = {}) {
  const keys = Object.keys(raw || {});
  for (const alias of aliases) {
    const target = normalizedHeader(alias);
    const found = keys.find(key => normalizedHeader(key) === target);
    if (found === undefined) continue;
    const value = raw[found];
    if (allowBlank || (value !== undefined && value !== null && text(value) !== '')) return value;
  }
  return null;
}

function transferRawValue(raw = {}, columnName = '') {
  const target = normalizedHeader(columnName);
  const keys = Object.keys(raw || {});
  if (!target) return null;
  if (target === normalizedHeader('청과')) {
    const duplicated = keys.find(key => ['청과_1', '청과.1'].includes(normalizedHeader(key)));
    if (duplicated !== undefined) return raw[duplicated];
    const exact = keys.find(key => normalizedHeader(key) === target);
    return exact !== undefined && strictNumber(raw[exact]) > 0 ? raw[exact] : null;
  }
  if (target === normalizedHeader('출고가(공지)')) {
    const found = keys.find(key => ['출고가(공지)', '출고가 （공지）'].some(alias => normalizedHeader(key) === normalizedHeader(alias)));
    return found === undefined ? null : raw[found];
  }
  const exact = keys.find(key => normalizedHeader(key) === target);
  return exact === undefined ? null : raw[exact];
}

function priceByKey(raw = {}, priceKey = '') {
  const aliases = {
    '출고가(공지)': ['출고가(공지)', '출고가 (공지)'],
    '청과': ['청과'],
    '상장가': ['상장가'],
    '출고(외노)': ['출고(외노)'],
    '식자재': ['식자재'],
    '도매A': ['도매A'],
    '단가': ['단가', '입고가', '매입단가']
  };
  for (const column of aliases[priceKey] || [priceKey]) {
    const price = strictNumber(transferRawValue(raw, column));
    if (price > 0) return { price, columnName: column };
  }
  return { price: 0, columnName: '' };
}

function priceGroups() {
  const groups = new Map();
  GROUP_PRESETS.forEach(preset => preset.customers.forEach(customer => groups.set(customer, {
    customer, groupName: preset.groupName, rule: [...preset.rule], feeMode: preset.feeMode,
    profitMode: preset.profitMode, outputCustomerMode: preset.outputCustomerMode
  })));
  return groups;
}

function baseFields(input = {}) {
  const raw = input?._raw && typeof input._raw === 'object' ? input._raw : input;
  const code = text(rawCell(raw, ['품목코드', '상품코드', '코드'])).replace(/\.0$/, '').trim();
  const name = text(rawCell(raw, ['품목명(규격)', '품명', '품목명', '상품명']));
  const groupCustomer = text(rawCell(raw, ['거래처', '거래처명']));
  let detailCustomer = text(rawCell(raw, ['거래처명']));
  if (!detailCustomer) {
    const legacyCheonggwa = rawCell(raw, ['청과']);
    if (legacyCheonggwa !== null && strictNumber(legacyCheonggwa) <= 0) detailCustomer = text(legacyCheonggwa);
  }
  const spec = text(rawCell(raw, ['거래처명', '규격', '규격명', '포장규격', '상품규격', '옵션', '사이즈'])) || detailCustomer;
  const quantityKeys = Object.keys(raw || {}).filter(key => ['수량', '입고수량', '구매수량', '매입수량'].some(alias => normalizedHeader(key) === normalizedHeader(alias)));
  const populatedQuantityKey = quantityKeys.find(key => raw[key] !== undefined && raw[key] !== null && text(raw[key]) !== '');
  const qtyRaw = populatedQuantityKey !== undefined ? raw[populatedQuantityKey] : (quantityKeys.length ? raw[quantityKeys[0]] : undefined);
  const qtyMissing = qtyRaw === undefined || qtyRaw === null || text(qtyRaw) === '';
  let qtyInvalid = false;
  if (!qtyMissing) {
    if (typeof qtyRaw === 'number') qtyInvalid = !Number.isFinite(qtyRaw);
    else {
      const source = text(qtyRaw).replace(/,/g, '');
      const wrappedNegative = source.startsWith('(') && source.endsWith(')');
      const numericText = wrappedNegative ? source.slice(1, -1) : source;
      qtyInvalid = (!wrappedNegative && (source.startsWith('(') || source.endsWith(')')))
        || !/^[+-]?\d+(?:\.\d+)?$/.test(numericText);
    }
  }
  const qty = qtyMissing || qtyInvalid ? 0 : quantityValue(qtyRaw);
  const cost = strictNumber(transferRawValue(raw, '단가'))
    || strictNumber(transferRawValue(raw, '입고가'))
    || strictNumber(rawCell(raw, ['매입단가']));
  return {
    raw, code, name, groupCustomer, detailCustomer, spec, qty, qtyRaw, qtyMissing, qtyInvalid,
    dateValue: text(rawCell(raw, ['일자', '날짜', '매입일자'])),
    purchaseVendor: text(rawCell(raw, ['구매처', '원구매처', '매입처'])),
    cost,
    wholesaleA: strictNumber(transferRawValue(raw, '도매A')),
    memo: text(rawCell(raw, ['적요', '비고'])),
    orderNote: text(rawCell(raw, ['출고지시'])),
    deliveryMessage: text(rawCell(raw, ['전달사항', '전달 사항', '메모', '비고'])),
    notice: transferRawValue(raw, '출고가(공지)')
  };
}

function exactSummaryToken(value) {
  return SUMMARY_TOKENS.includes(text(value).replace(/\s/g, '').toLowerCase());
}

function summaryLike(fields) {
  const { raw, code, name, groupCustomer, detailCustomer } = fields;
  const codeNormalized = text(code).replace(/\s/g, '').toLowerCase();
  const nameNormalized = text(name).replace(/\s/g, '').toLowerCase();
  const noRealCode = !codeNormalized || ['no_code', '-', '미상', '없음'].includes(codeNormalized);
  if ([groupCustomer, detailCustomer, code, name].some(exactSummaryToken)) return true;
  if (noRealCode && [rawCell(raw, ['거래처', '거래처명', '매입처', '구매처', '판매처'])].some(exactSummaryToken)) return true;
  if (noRealCode && (/^[+-]?[\d,.]+$/.test(nameNormalized) || ['', '이름없음', '미상', '기록없음'].includes(nameNormalized))) return true;
  return /^[+-]?[\d,.]+$/.test(nameNormalized) && codeNormalized && codeNormalized === nameNormalized;
}

function resolvePrice(fields, group) {
  if (!group) return { status: 'CUSTOMER_GROUP_MISSING', price: 0, priceKey: '', groupName: '', feeMode: 'NONE', profitMode: 'NORMAL', outputCustomerMode: 'GROUP_NAME' };
  if (group.groupName === '청과상장') {
    const notice = priceByKey(fields.raw, '출고가(공지)');
    if (notice.price > 0) return { status: 'MATCHED', ...notice, priceKey: '출고가(공지)', ...group };
    const cheonggwa = priceByKey(fields.raw, '청과');
    if (cheonggwa.price > 0) return { status: 'MATCHED', ...cheonggwa, priceKey: '청과', ...group };
    if (fields.wholesaleA > 0) return {
      status: 'MATCHED', price: Math.round((fields.wholesaleA / 0.91) / 100) * 100,
      priceKey: '도매A/0.91', columnName: '도매A / 0.91 / 100단위 반올림', ...group
    };
    const listing = priceByKey(fields.raw, '상장가');
    if (listing.price > 0) return { status: 'MATCHED', ...listing, priceKey: '상장가', ...group };
    return { status: 'PRICE_MISSING', price: 0, priceKey: '', columnName: '', ...group };
  }
  for (const priceKey of group.rule) {
    const found = priceByKey(fields.raw, priceKey);
    if (found.price > 0) return { status: 'MATCHED', ...found, priceKey, ...group };
  }
  return { status: 'PRICE_MISSING', price: 0, priceKey: '', columnName: '', ...group };
}

function missingPriceReason(groupName = '') {
  if (groupName === '청과상장') return '청과상장 판매단가 없음(청과/도매A/상장가)';
  if (groupName === '식자재') return '식자재 판매단가 없음(식자재/도매A/출고(외노))';
  if (groupName === '창고출고') return '창고출고 판매단가 없음(도매A/출고(외노))';
  if (groupName === '내부이동') return '내부이동 입고가 없음';
  return '판매단가 기준 없음';
}

function outputCustomer(fields, resolved) {
  return resolved.outputCustomerMode === 'ORIGINAL_CUSTOMER'
    ? text(fields.detailCustomer || fields.groupCustomer)
    : text(fields.groupCustomer || resolved.groupName);
}

function money(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

function rowValues(row, headers) {
  return headers.map(header => row?.[header] ?? '');
}

function wooriVendor(value) {
  return ['우리농산', '우리', '3우리'].includes(text(value).replace(/\s/g, ''));
}

function previewDate(value, now) {
  const source = text(value);
  const year = now.getFullYear();
  if (!source) return `${year}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const numbers = source.match(/\d+/g) || [];
  if (numbers.length >= 3) {
    const normalizedYear = numbers[0].length === 2 ? `20${numbers[0]}` : numbers[0];
    return `${normalizedYear}/${numbers[1].padStart(2, '0')}/${numbers[2].padStart(2, '0')}`;
  }
  if (numbers.length === 2) return `${year}/${numbers[0].padStart(2, '0')}/${numbers[1].padStart(2, '0')}`;
  return source;
}

function purchaseSequence(raw = {}) {
  const explicit = rawCell(raw, ['순번', 'No.', '번호']);
  if (explicit !== null) return explicit;
  const dateNo = text(rawCell(raw, ['일자-No.', '일자-No', '일자No']));
  const match = dateNo.match(/-\s*([^\s-]+)\s*$/);
  return match?.[1] || '';
}

function purchaseUploadRow(fields) {
  const raw = fields.raw || {};
  const rawSupply = rawCell(raw, ['공급가', '공급가액', '합계'], { allowBlank: true });
  const supply = rawSupply === null || text(rawSupply) === ''
    ? fields.qty * fields.cost
    : quantityValue(rawSupply);
  return [
    fields.dateValue,
    purchaseSequence(raw),
    rawCell(raw, ['거래처코드', '구매처코드'], { allowBlank: true }) ?? '',
    rawCell(raw, ['거래처명', '매입처명'], { allowBlank: true }) ?? fields.groupCustomer,
    rawCell(raw, ['입고창고', '창고코드', '창고'], { allowBlank: true }) ?? '',
    rawCell(raw, ['거래유형'], { allowBlank: true }) ?? '',
    rawCell(raw, ['전잔액'], { allowBlank: true }) ?? '',
    fields.deliveryMessage || fields.memo,
    fields.code,
    rawCell(raw, ['품명', '품목명', '상품명'], { allowBlank: true }) ?? fields.name,
    rawCell(raw, ['규격(기본)', '규격', '규격명', '포장규격', '상품규격'], { allowBlank: true }) ?? fields.spec,
    fields.qty,
    fields.cost,
    rawCell(raw, ['외화금액'], { allowBlank: true }) ?? '',
    supply,
    rawCell(raw, ['간단설명(품위)', '간단설명', '품위'], { allowBlank: true }) ?? '',
    rawCell(raw, ['지시사항', '출고지시'], { allowBlank: true }) ?? fields.orderNote,
    fields.notice ?? '',
    rawCell(raw, ['판매'], { allowBlank: true }) ?? '',
    rawCell(raw, ['no.', 'no', 'No.'], { allowBlank: true }) ?? ''
  ];
}

function sortPurchaseUploadRows(rows = []) {
  const compare = (left, right) => text(left).localeCompare(text(right), 'ko-KR', { numeric: true, sensitivity: 'base' });
  return rows.map((row, index) => ({ row, index }))
    .sort((left, right) => compare(left.row?.[3], right.row?.[3])
      || compare(left.row?.[8], right.row?.[8])
      || left.index - right.index)
    .map(entry => entry.row);
}

// Classify existing diagnostics only; never change price selection or validation policy.
function purchaseCheckIssue(reason = '') {
  if (reason.includes('역마진')) return '역마진';
  if (reason.includes('도매A과대의심')) return '도매A';
  if (reason.includes('수량')) return '수량';
  if (reason.includes('입고가 없음')) return '입고가';
  if (reason.includes('단가그룹')) return '단가그룹';
  if (reason.includes('판매단가')) return '판매단가';
  if (reason.includes('거래처명 없음')) return '거래처';
  if (reason.includes('품목코드 없음')) return '품목코드';
  if (reason.includes('품명 없음')) return '품명';
  return '기타';
}

function purchaseIssueRows(entry, fatal = false) {
  // Keep structured reasons: splitting a comma-delimited string would corrupt prices.
  const reasons = entry.reasons?.length ? entry.reasons : [entry.reason || '확인필요'];
  const byIssue = new Map();
  reasons.forEach(reason => {
    const issue = purchaseCheckIssue(reason);
    byIssue.set(issue, [...(byIssue.get(issue) || []), reason]);
  });
  return [...byIssue].map(([issue, details]) => ({
    '이슈': issue,
    '그룹': entry.customer || '', '거래처': entry.spec || entry.outputCustomer || '',
    '품목코드': entry.code || '', '품명': entry.name || '', '수량': entry.qty || 0,
    '확인사항': `${fatal ? '업로드불가: ' : ''}${details.join(', ')}`
  }));
}

function sortPurchaseIssueRows(rows) {
  const compare = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' }).compare;
  // Numeric collation equates 001 and 1; retain exact SKU identity before sorting customers.
  const compareCode = (left, right) => compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
  return rows.sort((left, right) => compare(left['이슈'], right['이슈'])
    || compareCode(left['품목코드'], right['품목코드'])
    || compare(left['그룹'], right['그룹'])
    || compare(left['거래처'], right['거래처']));
}

function buildPurchaseSalesUploadData(sourceRows = [], { now = new Date() } = {}) {
  const groups = priceGroups();
  const rows = [];
  const purchaseUploadRows = [];
  const fatalErrors = [];
  const warnings = [];

  (Array.isArray(sourceRows) ? sourceRows : []).forEach((input, index) => {
    const fields = baseFields(input);
    if (summaryLike(fields)) return;
    const rowBase = {
      rowNo: index + 1, customer: fields.groupCustomer, spec: fields.spec,
      outputCustomer: fields.detailCustomer || fields.groupCustomer,
      code: fields.code, name: fields.name, qty: fields.qty
    };
    const fatalReasons = [];
    if (!text(fields.groupCustomer || fields.detailCustomer)) fatalReasons.push('거래처명 없음');
    if (!fields.code) fatalReasons.push('품목코드 없음');
    if (fields.qtyInvalid) fatalReasons.push('수량 형식 확인');
    if (fatalReasons.length) {
      fatalErrors.push({ ...rowBase, reason: fatalReasons.join(', '), reasons: [...fatalReasons], level: '업로드불가' });
      return;
    }
    purchaseUploadRows.push(purchaseUploadRow(fields));

    const zeroQuantity = Number(fields.qty) === 0;
    const group = groups.get(fields.groupCustomer);
    const resolved = zeroQuantity
      ? {
        status: 'ZERO_QUANTITY', price: 0, priceKey: '', columnName: '',
        groupName: group?.groupName || '', feeMode: group?.feeMode || 'NONE',
        profitMode: group?.profitMode || 'NORMAL', outputCustomerMode: group?.outputCustomerMode || 'GROUP_NAME',
        rule: group?.rule || []
      }
      : resolvePrice(fields, group);
    const customer = outputCustomer(fields, resolved) || fields.detailCustomer || fields.groupCustomer;
    const reasons = [];
    if (zeroQuantity) reasons.push('수량 없음/0: 수량 0, 판매가 0으로 업로드');
    else {
      if (resolved.status === 'CUSTOMER_GROUP_MISSING') reasons.push('거래처 단가그룹 없음');
      if (resolved.status === 'PRICE_MISSING') reasons.push(missingPriceReason(resolved.groupName));
    }
    if (!fields.name) reasons.push('품명 없음');
    const price = zeroQuantity ? 0 : (resolved.status === 'MATCHED' ? strictNumber(resolved.price) : '');
    if (!zeroQuantity) {
      if (price !== '' && price > 0 && fields.cost > 0 && price < fields.cost) {
        reasons.push(`역마진/입고가초과: 입고가 ${money(fields.cost)} > 판매가 ${money(price)} (${resolved.priceKey || resolved.columnName || '판매가'})`);
      }
      if (fields.cost > 0 && fields.wholesaleA > 0) {
        if (fields.wholesaleA < fields.cost && !reasons.some(reason => reason.includes('역마진/입고가초과'))) {
          reasons.push(`역마진/입고가초과: 입고가 ${money(fields.cost)} > 도매A ${money(fields.wholesaleA)}`);
        }
        if (fields.wholesaleA >= fields.cost * 4) {
          reasons.push(`도매A과대의심: 입고가 ${money(fields.cost)} / 도매A ${money(fields.wholesaleA)} (${(fields.wholesaleA / fields.cost).toFixed(1)}배, 수기입력 오류 확인)`);
        }
      }
    }
    if (reasons.length) warnings.push({ ...rowBase, outputCustomer: customer, reason: reasons.join(', '), reasons: [...reasons], groupName: resolved.groupName || '' });
    const supply = zeroQuantity ? 0 : (price === '' ? '' : fields.qty * price);
    rows.push({
      '일자': '', '순번': '', '거래처코드': '', '거래처명': customer, '출하창고': '02',
      '거래유형': '', '전잔액': '', '전달사항': fields.deliveryMessage || '', '품목코드': fields.code,
      '품목명': fields.name, '규격': fields.spec, '수량': fields.qty, '단가': price, '외화금액': '',
      '공급가액': supply, '적요': fields.memo, '출고지시': fields.orderNote, '공지': text(fields.notice),
      '구매처': fields.purchaseVendor, '날짜': fields.dateValue, '구매': fields.cost,
      '_적용그룹': resolved.groupName || '', '_구매처보정전': fields.purchaseVendor
    });
  });

  rows.sort((left, right) => text(left['거래처명']).localeCompare(text(right['거래처명']), 'ko')
    || text(left['규격']).localeCompare(text(right['규격']), 'ko')
    || text(left['품목코드']).localeCompare(text(right['품목코드']), 'ko'));

  const outboundRows = rows.filter(row => wooriVendor(row['_구매처보정전'] || row['구매처'])).map(row => ({
    ...row, '일자': '', '순번': '', '거래처코드': '', '거래처명': '1전송', '출하창고': '40',
    '거래유형': '', '전잔액': ''
  }));
  const purchaseRows = rows.filter(row => text(row['거래처명']).replace(/\s/g, '') === '3우리').map(row => ({
    ...row, '일자': '', '순번': '', '거래처코드': '', '거래처명': '3우리', '출하창고': '03',
    '거래유형': '', '전잔액': '', '전달사항': '', '출고지시': '', '공지': ''
  }));
  const previewRows = rows.map(row => {
    const qty = strictNumber(row['수량']);
    const price = strictNumber(row['단가']);
    const cost = strictNumber(row['구매']);
    const supply = qty === 0 ? 0 : (strictNumber(row['공급가액']) || qty * price);
    const unitProfit = price - cost;
    const fee = row['_적용그룹'] === '청과상장' ? Math.round(supply * 0.09) : 0;
    return {
      '일자': previewDate(row['날짜'] || row['일자'], now), '거래처명': row['거래처명'] || '',
      'no.': row['규격'] || '', '품목코드': row['품목코드'] || '', '품명': row['품목명'] || '',
      '수량': qty, '단가': qty === 0 ? 0 : (price > 0 ? price : ''),
      '공급가': qty === 0 ? 0 : (supply !== 0 ? supply : ''), '적요': row['적요'] || '',
      '출고지시': row['출고지시'] || '', '출고가 (공지)': row['공지'] || '', '구매처': row['구매처'] || '',
      '구매': cost || '', '구매합계': cost ? qty * cost : '',
      '정리': qty === 0 ? 0 : (price && cost ? unitProfit : ''),
      '정산': qty === 0 ? 0 : (price && cost ? unitProfit * qty : ''),
      '수수료': qty === 0 ? 0 : (fee !== 0 ? fee : '')
    };
  });
  const checkRows = sortPurchaseIssueRows([
    ...fatalErrors.flatMap(error => purchaseIssueRows(error, true)),
    ...warnings.flatMap(warning => purchaseIssueRows(warning))
  ]);
  if (!checkRows.length) checkRows.push({ '이슈': '', '그룹': '', '거래처': '', '품목코드': '', '품명': '', '수량': '', '확인사항': '확인필요 항목 없음' });
  const settingRows = [...groups.values()].map(group => ({
    '거래처명': group.customer, '단가그룹': group.groupName, '단가적용순서': group.rule.join(' > '),
    '수수료모드': group.feeMode, '수익모드': group.profitMode,
    '출력거래처명모드': group.outputCustomerMode, '설정출처': '기본값', '정확일치': 'Y'
  }));

  const matrices = {
    '확인요청': [CHECK_HEADERS, ...checkRows.map(row => rowValues(row, CHECK_HEADERS))],
    '판매입력': [SALES_HEADERS, ...rows.map(row => rowValues(row, SALES_HEADERS))],
    '전송출고': [OUTBOUND_HEADERS, ...outboundRows.map(row => rowValues(row, OUTBOUND_HEADERS))],
    '전송구매': [PURCHASE_HEADERS, ...purchaseRows.map(row => rowValues(row, PURCHASE_HEADERS))],
    '거래처별': [PREVIEW_HEADERS, ...previewRows.map(row => rowValues(row, PREVIEW_HEADERS))],
    '단가설정': [SETTINGS_HEADERS, ...settingRows.map(row => rowValues(row, SETTINGS_HEADERS))],
    '구매 업로드': [PURCHASE_UPLOAD_HEADERS, ...sortPurchaseUploadRows(purchaseUploadRows)]
  };
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return {
    sheetNames: ['확인요청', '판매입력', '전송출고', '전송구매', '거래처별', '단가설정', '구매 업로드'],
    matrices,
    widths: {
      '확인요청': CHECK_WIDTHS, '판매입력': SALES_WIDTHS, '전송출고': OUTBOUND_WIDTHS,
      '전송구매': PURCHASE_WIDTHS, '거래처별': PREVIEW_WIDTHS, '단가설정': SETTINGS_HEADERS.map(() => 18),
      '구매 업로드': PURCHASE_UPLOAD_WIDTHS
    },
    fileName: `2전송_판매업로드_생성_${ymd}.xlsx`,
    stats: { outputRows: rows.length, fatalErrors: fatalErrors.length, warnings: warnings.length }
  };
}

const PURCHASE_SALES_UPLOAD_HEADERS = Object.freeze({
  check: CHECK_HEADERS, sales: SALES_HEADERS, outbound: OUTBOUND_HEADERS,
  purchase: PURCHASE_HEADERS, preview: PREVIEW_HEADERS, settings: SETTINGS_HEADERS,
  upload: PURCHASE_UPLOAD_HEADERS
});

const PURCHASE_SALES_UPLOAD_GROUPS = GROUP_PRESETS;

return { runStage5Compute: stage5ComputeRunnerSection.runStage5Compute, DEFAULT_WORKER_THRESHOLD_ROWS: stage5ComputeRunnerSection.DEFAULT_WORKER_THRESHOLD_ROWS, buildPurchaseSalesUploadData, PURCHASE_SALES_UPLOAD_HEADERS, PURCHASE_SALES_UPLOAD_GROUPS };
})();

// Public API (same functions and constants; no additional command layer).
export const runStage5Compute = stage5ComputeRunnerSection.runStage5Compute;
export const DEFAULT_WORKER_THRESHOLD_ROWS = stage5ComputeRunnerSection.DEFAULT_WORKER_THRESHOLD_ROWS;
export const KAKAO_NOTICE_ROWS_PER_PAGE = estimateOutputSection.KAKAO_NOTICE_ROWS_PER_PAGE;
export const paginateKakaoNoticeRows = estimateOutputSection.paginateKakaoNoticeRows;
export const splitKakaoNoticeColumns = estimateOutputSection.splitKakaoNoticeColumns;
export const buildEstimateF8RowsFromDraft = estimateOutputSection.buildEstimateF8RowsFromDraft;
export const buildEstimateF8RowsFromPlan = estimateOutputSection.buildEstimateF8RowsFromPlan;
export const buildCatalogPriceSnapshot = estimateOutputSection.buildCatalogPriceSnapshot;
export const priceSnapshotsEqual = estimateOutputSection.priceSnapshotsEqual;
export const buildKakaoNoticeRows = estimateOutputSection.buildKakaoNoticeRows;
export const validateEstimateRows = estimateOutputSection.validateEstimateRows;
export const buildEstimateDuplicateGroups = estimateOutputSection.buildEstimateDuplicateGroups;
export const calculateEstimateResolvedPrice = estimateOutputSection.calculateEstimateResolvedPrice;
export const resolveEstimateDuplicateRows = estimateOutputSection.resolveEstimateDuplicateRows;
export const sortEstimateUploadRows = estimateOutputSection.sortEstimateUploadRows;
export const buildEstimateF8Data = estimateOutputSection.buildEstimateF8Data;
export const renderKakaoNoticeCanvases = estimateOutputSection.renderKakaoNoticeCanvases;
export const ESTIMATE_F8_HEADERS = estimateOutputSection.ESTIMATE_F8_HEADERS;
export const buildPurchaseSalesUploadData = purchaseSalesOutputSection.buildPurchaseSalesUploadData;
export const PURCHASE_SALES_UPLOAD_HEADERS = purchaseSalesOutputSection.PURCHASE_SALES_UPLOAD_HEADERS;
export const PURCHASE_SALES_UPLOAD_GROUPS = purchaseSalesOutputSection.PURCHASE_SALES_UPLOAD_GROUPS;
