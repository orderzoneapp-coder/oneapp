import {
  captureTextIntake,
  analyzeSingleOrderDocument,
  rematchExtractedLinesForCustomer,
  extractOrderProductLines,
  createOrder,
  syncAfterLocalMutation,
  isSelectableMasterProduct,
  loadWarehouseCatalog,
  matchWarehouseInput,
  warehouseDisplayName,
  loadPurchaseStage3Capability,
  postPurchaseGroup,
  SMARTINPUT_PURCHASE_ACTOR_ID,
  validatePurchaseGroup,
  loadSaleStage4Capability,
  postSaleGroup,
  SMARTINPUT_SALE_ACTOR_ID
} from './legacy-integration-adapter.js?v=0.1.0';
import { recognizeOcrDocument, verifiedRowsToParserLines } from './ocr-document-parser.js?v=0.1.1';
import { parseStructuredSheet } from './structured-sheet-parser.js?v=0.1.1';
import { buildGridPastePlan } from './grid-clipboard.js?v=0.1.0';
import {
  isPurchaseMetaSheet,
  joinPurchaseMeta,
  readPurchaseMeta,
  stableDirectDocumentKey,
  detachOrderQPurchaseLink
} from './purchase-stage3.js?v=0.1.0';
import { isSalesMetaSheet, joinSalesMeta, readSalesMeta } from './sale-stage4.js?v=0.1.0';
import {
  buildOrderGroupPayload,
  decorateStructuredRows,
  filterVoucherRows,
  groupVoucherRows,
  structuredFieldsForMode,
  summarizeVoucherGroups
} from './multivoucher-stage1.js?v=0.1.0';
import {
  buildCatalogPriceSnapshot,
  priceSnapshotsEqual,
  buildKakaoNoticeRows,
  buildEstimateF8Data,
  renderKakaoNoticeCanvases,
  KAKAO_NOTICE_ROWS_PER_PAGE
} from './estimate-output.js?v=0.1.5';
import {
  createRecordId,
  loadSmartInputData,
  normalizeAliasName,
  deleteEstimate,
  saveAliasMapping,
  saveEstimate,
  saveLinkGroup,
  saveReferenceCache,
  saveSettings,
  saveSourceImage,
  saveTemporaryCustomer,
  loadLatestAutosave,
  saveLatestAutosave
} from './smartinput-data-store.js?v=0.4.0';
import {
  REFERENCE_CACHE_SCHEMA,
  REFERENCE_DOMAIN_STATUS,
  buildRegistrationChangeRequest,
  classifyProductMatch,
  createProductMatchIndex,
  diffReferenceSnapshots,
  loadReferenceDomain,
  normalizeCachedReference,
  ownerAppHref,
  referenceSourceLabel,
  sameReferenceRevision,
  searchProductMatchIndex,
  submitRegistrationChangeRequest
} from './reference-data-controller.js?v=0.1.1';

const contract = window.SMART_INPUT_CONTRACT;
if (!contract) throw new Error('SMART_INPUT_CONTRACT_NOT_LOADED');

const externalScripts = new Map();
function loadOptionalScript(url, globalName, unavailableMessage) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (externalScripts.has(globalName)) return externalScripts.get(globalName);
  const pending = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error(unavailableMessage));
    script.onerror = () => reject(new Error(unavailableMessage));
    document.head.append(script);
  });
  externalScripts.set(globalName, pending);
  return pending;
}

const ensureXlsx = () => loadOptionalScript(
  'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
  'XLSX',
  'Excel 처리 모듈을 불러오지 못했습니다. 텍스트·CSV·TSV 입력은 계속 사용할 수 있습니다.'
);
const ensureTesseract = () => loadOptionalScript(
  'https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js',
  'Tesseract',
  '사진 OCR 모듈을 불러오지 못했습니다. 원본 사진 확인과 직접 입력은 계속 사용할 수 있습니다.'
);

const $ = id => document.getElementById(id);
const modeTabs = document.querySelector('.mode-tabs');
const tabs = [...modeTabs.querySelectorAll('.mode-tab[data-mode]')];
const methodButtons = [...document.querySelectorAll('[data-method]')];
const sourceTextInput = $('sourceTextInput');
const inputRows = $('inputRows');
const parserCard = document.querySelector('.parser-card');
const state = {
  draft: loadDraft(),
  customers: [],
  products: [],
  productMatchIndex: createProductMatchIndex([]),
  catalogStatus: 'LOADING',
  customerStatus: 'LOADING',
  referenceStatus: REFERENCE_DOMAIN_STATUS.LOADING,
  referenceMessage: '상품·거래처 기준정보를 불러오고 있습니다.',
  references: {
    product: { status: REFERENCE_DOMAIN_STATUS.LOADING, active: null, pending: null, error: null },
    customer: { status: REFERENCE_DOMAIN_STATUS.LOADING, active: null, pending: null, error: null }
  },
  catalogSummary: { commonCount: 0, orderQCount: 0, errors: [] },
  warehouseCatalog: { warehouses: [], aliases: [] },
  settings: contract.normalizeSettings(),
  linkGroups: [],
  temporaryCustomers: [],
  aliasMappings: [],
  estimates: [],
  noticeEstimateIds: [],
  smartDataReady: false,
  pendingImageEvidence: null,
  photoCaptureSequence: 0,
  pendingOcrReview: null,
  pendingSourceName: '',
  pendingStructuredImport: null,
  gridSearch: '',
  sourceImages: { order: null, purchase: null, sale: null, estimate: null },
  sourceImageRecords: new Map(),
  selectedRowIds: new Set(),
  photoView: { zoom: 1, rotation: 0, activeRegion: null, detailColumns: false, ocrOpen: false },
  saveTimer: null,
  linkedWriteTimer: null,
  draftDirty: false,
  autosaveAvailable: false,
  autosaveUpdatedAt: '',
  autosaveLoading: true,
  toastTimer: null,
  recognition: null,
  listening: false,
  busy: false,
  activeActivity: '',
  autoAnalyzeTimer: null,
  analysisRequestId: 0,
  sourceComposing: false,
  columnResize: null,
  columnDrag: null,
  gridPasteUndo: null,
  applyingGridPaste: false,
  estimateLibraryKind: 'individual',
  estimateWorkingCopies: new Map(),
  estimateSelectionReturnDraft: null,
  estimateDragSuppressed: false,
  estimateTouchDrag: null,
  estimateSelectionQueue: Promise.resolve(),
  purchaseCapability: { ready: false, code: 'ORDERQ_PURCHASE_STAGE3_CAPABILITY_UNAVAILABLE', detail: 'loading' },
  saleCapability: { ready: false, code: 'ORDERQ_SALE_STAGE4_CAPABILITY_UNAVAILABLE', detail: 'loading' }
};

const ACTIVITY_LABELS = {
  direct: '직접입력',
  excel: 'Excel·파일',
  text: '텍스트',
  paste: 'Ctrl+V',
  photo: '사진 OCR',
  voice: '음성 STT'
};

const DEFAULT_INPUT_ROW_ID = '__SMARTINPUT_DEFAULT_ROW__';

const MEANINGFUL_ROW_FIELDS = Object.freeze([
  'productId', 'masterProductId', 'itemCode', 'itemName', 'secondaryName', 'searchInfo',
  'unregisteredProductQuery', 'specification', 'boxQuantity', 'quantity', 'unit', 'unitPrice',
  'sourceUnitPrice', 'outPrice', 'wholesaleA', 'wholesaleB', 'listingPrice', 'marketPrice',
  'promoPrice', 'purchasePriceB', 'priceD', 'lastPurchasePrice', 'priceH', 'priceI',
  'memo', 'description', 'rowCustomerCode', 'rowCustomerId', 'rowCustomerName',
  'deliveryCustomerId', 'deliveryCustomerCode', 'deliveryCustomerName', 'billingCustomerId',
  'billingCustomerCode', 'billingCustomerName', 'supplierCustomerId', 'supplierCustomerCode',
  'supplierCustomerName', 'salesCustomerId', 'salesCustomerCode', 'salesCustomerName',
  'rowVoucherDate', 'rowDeliveryDate', 'rowWarehouseId', 'rowWarehouseCode', 'rowVoucherNo'
]);

function hasEnteredValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (typeof value === 'number') return Number.isFinite(value);
  return Boolean(value);
}

function rowHasMeaningfulInput(row = {}) {
  return MEANINGFUL_ROW_FIELDS.some(field => hasEnteredValue(row[field]))
    || hasEnteredValue(row.rawText)
    || Object.values(row.customValues || {}).some(hasEnteredValue);
}

function rowHasLinkedSource(row = {}) {
  return Boolean(row.linkedSourceRefs?.length || (row.linkedSourceEstimateId && row.linkedSourceRowId));
}

function compactRowBlankValues(row) {
  if (!row?.customValues || typeof row.customValues !== 'object') return row;
  row.customValues = Object.fromEntries(Object.entries(row.customValues).filter(([, value]) => hasEnteredValue(value)));
  return row;
}

function pruneEmptyWorkRows(current) {
  if (!current?.rows) return false;
  const before = current.rows.length;
  current.rows = current.rows.filter(rowHasMeaningfulInput).map(compactRowBlankValues);
  return before !== current.rows.length;
}

function manualLinkedRows(rows = []) {
  return rows.filter(row => !rowHasLinkedSource(row) && rowHasMeaningfulInput(row));
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function loadDraft() {
  try {
    return contract.normalizeDraft(JSON.parse(localStorage.getItem(contract.DRAFT_STORAGE_KEY) || 'null'));
  } catch (_) {
    return contract.createDraft();
  }
}

function hasMeaningfulDraftContent(draft) {
  const header = draft?.header || {};
  return Boolean(
    String(draft?.sourceText || '').trim()
    || Number(draft?.rows?.length || 0)
    || Number(draft?.batches?.length || 0)
    || String(header.customerId || header.customerName || '').trim()
    || String(header.taxCustomerId || header.taxCustomerName || '').trim()
    || String(header.warehouseId || header.warehouseName || '').trim()
  );
}

function modeDraft() {
  return state.draft.modes[state.draft.activeMode];
}

function modeUi() {
  state.draft.ui.modes ||= {};
  state.draft.ui.modes[state.draft.activeMode] ||= { scrollTop: 0, scrollLeft: 0, activeCellId: '' };
  return state.draft.ui.modes[state.draft.activeMode];
}

function setAppStatus(message, tone = 'normal') {
  $('appStatus').dataset.tone = tone;
  $('appStatusMessage').textContent = message;
}

function toast(message, tone = 'normal') {
  const element = $('toast');
  element.textContent = message;
  element.dataset.tone = tone;
  element.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => { element.hidden = true; }, 3800);
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function setSaveState(message = '', stateName = 'idle') {
  const element = $('saveState');
  element.textContent = message;
  element.dataset.state = stateName;
}

function hasMeaningfulWorkspaceDraft(draft) {
  return Object.values(draft?.modes || {}).some(hasMeaningfulDraftContent);
}

function updateAutosaveButton() {
  const button = $('restoreAutosaveButton');
  if (!button) return;
  button.disabled = state.autosaveLoading || !state.autosaveAvailable || state.busy;
  button.title = state.autosaveAvailable && state.autosaveUpdatedAt
    ? `최근 자동저장 ${new Date(state.autosaveUpdatedAt).toLocaleString('ko-KR')}`
    : '복구할 자동저장이 없습니다.';
}

let autosaveWriteQueue = Promise.resolve();

function queueAutosaveSnapshot(draft) {
  const snapshot = JSON.parse(JSON.stringify(draft));
  const write = () => saveLatestAutosave(snapshot);
  const queued = autosaveWriteQueue.then(write, write);
  autosaveWriteQueue = queued.catch(() => undefined);
  queued.then(record => {
    state.autosaveLoading = false;
    state.autosaveAvailable = hasMeaningfulWorkspaceDraft(snapshot);
    state.autosaveUpdatedAt = record?.updatedAt || snapshot.updatedAt || new Date().toISOString();
    updateAutosaveButton();
    setSaveState('자동저장됨', 'saved');
  }).catch(() => {
    state.autosaveLoading = false;
    updateAutosaveButton();
    setSaveState('자동저장 실패', 'error');
    setAppStatus('자동저장 DB에 기록하지 못했습니다. 입력 내용은 현재 화면과 호환 저장소에 유지됩니다.', 'warn');
  });
  return queued;
}

function saveDraftNow({ writeAutosave = true } = {}) {
  clearTimeout(state.saveTimer);
  Object.values(state.draft.modes || {}).forEach(pruneEmptyWorkRows);
  if (state.draft.activeMode !== 'estimate') {
    modeDraft().voucherGroups = groupVoucherRows(state.draft.activeMode, modeDraft().rows, modeDraft().header)
      .map(({ rows, ...group }) => group);
  }
  state.draft.updatedAt = new Date().toISOString();
  modeDraft().updatedAt = state.draft.updatedAt;
  let compatibilitySaved = true;
  try {
    localStorage.setItem(contract.DRAFT_STORAGE_KEY, JSON.stringify(state.draft));
    state.draftDirty = false;
  } catch (_) {
    compatibilitySaved = false;
    setAppStatus('호환 저장소에 기록하지 못했습니다. 입력 내용은 현재 화면에 유지됩니다.', 'warn');
  }
  if (writeAutosave) {
    setSaveState('자동저장 중…', 'saving');
    queueAutosaveSnapshot(state.draft);
  } else {
    setSaveState(state.autosaveAvailable ? '복구 가능' : '', 'saved');
    updateAutosaveButton();
  }
  return compatibilitySaved;
}

function scheduleSave() {
  state.draftDirty = true;
  setSaveState('자동저장 중…', 'saving');
  queueLinkedRowsWriteThrough();
  clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(saveDraftNow, 160);
}

async function initializeAutosave() {
  try {
    const record = await loadLatestAutosave();
    if (record?.draft && hasMeaningfulWorkspaceDraft(record.draft)) {
      state.autosaveAvailable = true;
      state.autosaveUpdatedAt = record.updatedAt || record.draft.updatedAt || '';
    } else if (hasMeaningfulWorkspaceDraft(state.draft)) {
      const migrated = await saveLatestAutosave(state.draft);
      state.autosaveAvailable = true;
      state.autosaveUpdatedAt = migrated?.updatedAt || state.draft.updatedAt || '';
    }
  } catch (_) {
    setSaveState('복구 확인 실패', 'error');
  } finally {
    state.autosaveLoading = false;
    updateAutosaveButton();
  }
}

async function restoreLatestAutosave() {
  if (state.autosaveLoading || state.busy) return;
  state.busy = true;
  updateAutosaveButton();
  try {
    await autosaveWriteQueue;
    const record = await loadLatestAutosave();
    if (!record?.draft || !hasMeaningfulWorkspaceDraft(record.draft)) {
      state.autosaveAvailable = false;
      state.autosaveUpdatedAt = '';
      return toast('복구할 자동저장이 없습니다.', 'error');
    }
    if (activeWorkspaceHasContent() && !window.confirm('현재 입력을 최근 자동저장 상태로 복구하시겠습니까? 현재 화면의 저장되지 않은 변경은 바뀔 수 있습니다.')) return;
    clearTimeout(state.saveTimer);
    state.draftDirty = false;
    state.draft = contract.normalizeDraft(record.draft);
    state.selectedRowIds.clear();
    state.gridPasteUndo = null;
    state.pendingImageEvidence = null;
    state.pendingOcrReview = null;
    state.pendingSourceName = '';
    state.pendingStructuredImport = null;
    Object.keys(state.sourceImages).forEach(restoreSourceImageForMode);
    try { localStorage.setItem(contract.DRAFT_STORAGE_KEY, JSON.stringify(state.draft)); } catch (_) {}
    state.autosaveAvailable = true;
    state.autosaveUpdatedAt = record.updatedAt || state.draft.updatedAt || '';
    renderMode();
    setAppStatus(`최근 자동저장을 복구했습니다${state.autosaveUpdatedAt ? ` · ${new Date(state.autosaveUpdatedAt).toLocaleString('ko-KR')}` : ''}.`);
    toast('최근 자동저장을 복구했습니다.', 'success');
  } catch (error) {
    setAppStatus('자동저장을 복구하지 못했습니다. 현재 입력은 유지됩니다.', 'error');
    toast(error.message || '자동저장 복구에 실패했습니다.', 'error');
  } finally {
    state.busy = false;
    updateAutosaveButton();
    renderDelivery();
  }
}

function referencesReady() {
  return state.referenceStatus === REFERENCE_DOMAIN_STATUS.READY;
}

function referenceStatusMessage() {
  return state.referenceMessage || (state.referenceStatus === REFERENCE_DOMAIN_STATUS.LOADING
    ? '상품·거래처 기준정보를 불러오고 있습니다.'
    : '일부 기준정보를 사용할 수 없습니다. 수동 입력과 자동저장은 계속할 수 있습니다.');
}

function referenceDomainLabel(domain) {
  return domain === 'product' ? '상품' : '거래처';
}

function activeWorkspaceHasContent() {
  return Object.values(state.draft.modes || {}).some(hasMeaningfulDraftContent);
}

function referenceCacheEnvelope(domain) {
  const reference = state.references[domain];
  return {
    cacheSchemaVersion: REFERENCE_CACHE_SCHEMA,
    applied: reference.active,
    pending: reference.pending,
    updatedAt: new Date().toISOString()
  };
}

function persistReferenceState(domain) {
  return saveReferenceCache(domain, referenceCacheEnvelope(domain)).catch(() => {
    setAppStatus(`${referenceDomainLabel(domain)} 기준정보 캐시를 저장하지 못했습니다. 현재 작업은 유지됩니다.`, 'warn');
  });
}

function applyReferenceSnapshot(domain, snapshot, { clearPending = true } = {}) {
  if (!snapshot || ![REFERENCE_DOMAIN_STATUS.READY, REFERENCE_DOMAIN_STATUS.EMPTY].includes(snapshot.status)) return false;
  const reference = state.references[domain];
  reference.active = snapshot;
  if (clearPending) reference.pending = null;
  reference.error = null;
  reference.status = snapshot.status;
  if (domain === 'product') {
    state.products = snapshot.rows;
    state.productMatchIndex = createProductMatchIndex(state.products);
    state.catalogSummary = {
      products: state.products,
      commonCount: state.products.length,
      orderQCount: 0,
      source: snapshot.source,
      errors: []
    };
  } else {
    state.customers = normalizedCustomerCandidates(snapshot.rows);
  }
  return true;
}

function restoreCachedReferences(referenceCache = {}) {
  ['product', 'customer'].forEach(domain => {
    const cachedState = referenceCache?.[domain] || null;
    const storedApplied = normalizeCachedReference(cachedState?.applied || cachedState, domain);
    const storedPending = normalizeCachedReference(cachedState?.pending, domain);
    const applied = storedApplied ? { ...storedApplied, source: `CACHE:${String(storedApplied.source || '').replace(/^CACHE:/, '')}`, loadedFromCache: true } : null;
    const pending = storedPending ? { ...storedPending, source: `CACHE:${String(storedPending.source || '').replace(/^CACHE:/, '')}`, loadedFromCache: true } : null;
    if (applied) applyReferenceSnapshot(domain, applied, { clearPending: false });
    if (pending && !sameReferenceRevision(applied, pending)) {
      state.references[domain].pending = pending;
      state.references[domain].status = REFERENCE_DOMAIN_STATUS.STALE;
    }
  });
}

function refreshReferenceAggregate() {
  const domains = ['product', 'customer'];
  const unavailable = domains.filter(domain => state.references[domain].status === REFERENCE_DOMAIN_STATUS.ERROR && !state.references[domain].active);
  const pending = domains.filter(domain => state.references[domain].pending);
  const degraded = domains.filter(domain => state.references[domain].error && state.references[domain].active);
  const waiting = domains.filter(domain => state.references[domain].status === REFERENCE_DOMAIN_STATUS.LOADING && !state.references[domain].active);
  if (unavailable.length) state.referenceStatus = REFERENCE_DOMAIN_STATUS.ERROR;
  else if (pending.length || degraded.length) state.referenceStatus = REFERENCE_DOMAIN_STATUS.STALE;
  else if (waiting.length) state.referenceStatus = REFERENCE_DOMAIN_STATUS.LOADING;
  else state.referenceStatus = REFERENCE_DOMAIN_STATUS.READY;
  state.catalogStatus = state.references.product.status;
  state.customerStatus = state.references.customer.status;
  const productCount = state.references.product.active?.count;
  const customerCount = state.references.customer.active?.count;
  if (unavailable.length) {
    state.referenceMessage = `${unavailable.map(referenceDomainLabel).join('·')} 기준정보 로드 실패 · 수동 입력과 자동저장은 계속할 수 있습니다.`;
  } else if (pending.length) {
    state.referenceMessage = `${pending.map(referenceDomainLabel).join('·')} 새 revision 보류 · 기본은 다음 작업부터 적용`;
  } else if (degraded.length) {
    state.referenceMessage = `${degraded.map(referenceDomainLabel).join('·')} 최신 확인 실패 · 저장된 Snapshot 사용 중`;
  } else if (waiting.length) {
    state.referenceMessage = `${waiting.map(referenceDomainLabel).join('·')} 기준정보를 불러오고 있습니다.`;
  } else {
    state.referenceMessage = `상품 ${Number(productCount || 0).toLocaleString('ko-KR')}건 · 거래처 ${Number(customerCount || 0).toLocaleString('ko-KR')}건`;
  }
}

function referenceTimeText(value) {
  if (!value) return '확인 전';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

function renderReferenceDomain(domain) {
  const reference = state.references[domain];
  const active = reference.active;
  const statusElement = $(`${domain}ReferenceStatus`);
  if (!statusElement) return;
  statusElement.textContent = reference.status;
  statusElement.dataset.status = reference.status;
  $(`${domain}ReferenceSource`).textContent = active ? referenceSourceLabel(active) : '사용 가능 Snapshot 없음';
  $(`${domain}ReferenceCount`).textContent = active?.count == null ? '—' : `${Number(active.count).toLocaleString('ko-KR')}건`;
  $(`${domain}ReferenceRevision`).textContent = active?.revision === '' || active?.revision == null ? '—' : String(active.revision);
  $(`${domain}ReferenceUpdated`).textContent = referenceTimeText(active?.checkedAt || active?.snapshotCreatedAt);
  const reload = $(`${domain}ReferenceReload`);
  reload.disabled = state.busy || Boolean(reference.loading);
  reload.textContent = reference.loading ? '불러오는 중…' : '다시 불러오기';
}

function renderReferenceControls() {
  $('analyzeButton').disabled = state.busy;
  $('customerSearchButton').disabled = state.busy || ['LINKED_GROUP', 'COMPOSITION_PREVIEW'].includes(modeDraft().estimateKind);
  $('estimateNoticeButton').disabled = state.busy;
  $('estimateExcelButton').disabled = state.busy;
  $('estimateCreateButton').disabled = state.busy || state.noticeEstimateIds.length < 1;
  $('estimateRenameButton').disabled = state.busy || state.noticeEstimateIds.length !== 1;
  $('selectedEstimateDeleteButton').disabled = state.busy || state.noticeEstimateIds.length < 1;
  updateAutosaveButton();
  refreshReferenceAggregate();
  renderReferenceDomain('product');
  renderReferenceDomain('customer');
  const overview = $('referenceOverviewSummary');
  if (overview) overview.textContent = state.referenceMessage;
  const pendingApply = $('referencePendingApply');
  if (pendingApply) {
    const count = ['product', 'customer'].filter(domain => state.references[domain].pending).length;
    pendingApply.hidden = count === 0;
    pendingApply.textContent = count ? `현재 작업에 적용 (${count})` : '현재 작업에 적용';
  }
}

function ingestLatestReference(domain, latest, { allowCurrent = false } = {}) {
  const reference = state.references[domain];
  reference.loading = false;
  if (!latest || latest.status === REFERENCE_DOMAIN_STATUS.ERROR) {
    reference.error = latest?.error || { code: `${domain.toUpperCase()}_REFERENCE_LOAD_FAILED`, message: '로드 실패' };
    reference.status = reference.active ? REFERENCE_DOMAIN_STATUS.STALE : REFERENCE_DOMAIN_STATUS.ERROR;
    renderReferenceControls();
    return false;
  }
  if (reference.active && sameReferenceRevision(reference.active, latest)) {
    applyReferenceSnapshot(domain, latest);
    void persistReferenceState(domain);
    renderReferenceControls();
    return true;
  }
  if (reference.active && activeWorkspaceHasContent() && !allowCurrent) {
    reference.pending = latest;
    reference.error = null;
    reference.status = REFERENCE_DOMAIN_STATUS.STALE;
    void persistReferenceState(domain);
    renderReferenceControls();
    return true;
  }
  applyReferenceSnapshot(domain, latest);
  void persistReferenceState(domain);
  renderReferenceControls();
  return true;
}

async function reloadReferenceDomain(domain, { quiet = false } = {}) {
  const reference = state.references[domain];
  if (reference.loading) return;
  reference.loading = true;
  if (!reference.active) reference.status = REFERENCE_DOMAIN_STATUS.LOADING;
  renderReferenceControls();
  const latest = await loadReferenceDomain(domain);
  ingestLatestReference(domain, latest);
  if (!quiet) {
    const suffix = latest.status === REFERENCE_DOMAIN_STATUS.ERROR
      ? '로드 실패 · 현재 작업은 유지됩니다.'
      : `${latest.count.toLocaleString('ko-KR')}건 확인`;
    toast(`${referenceDomainLabel(domain)} 기준정보 ${suffix}`, latest.status === REFERENCE_DOMAIN_STATUS.ERROR ? 'error' : 'success');
  }
}

function appendDeliveryHistory(record) {
  try {
    const previous = JSON.parse(localStorage.getItem(contract.DELIVERY_HISTORY_KEY) || '[]');
    const history = Array.isArray(previous) ? previous : [];
    const withoutDuplicate = history.filter(item => item.targetRecordId !== record.targetRecordId);
    localStorage.setItem(contract.DELIVERY_HISTORY_KEY, JSON.stringify([record, ...withoutDuplicate].slice(0, 30)));
  } catch (_) {}
}

function resizeSource() {
  $('sourceLength').textContent = `${sourceTextInput.value.length.toLocaleString('ko-KR')}자`;
}

function renderSourceAnalysis() {
  const source = sourceTextInput.value;
  const highlight = $('sourceHighlight');
  if (!highlight) return;
  if (!source) {
    highlight.textContent = '';
    return;
  }
  const marks = new Array(source.length).fill(null);
  const paint = (start, end, className, priority) => {
    for (let index = Math.max(0, start); index < Math.min(source.length, end); index += 1) {
      if (!marks[index] || marks[index].priority <= priority) marks[index] = { className, priority };
    }
  };
  const kakaoHeader = /^[ \t]*\[([^\]\r\n]+)\]\s*\[((?:오전|오후)?\s*\d{1,2}:\d{2})\]/gm;
  for (const match of source.matchAll(kakaoHeader)) {
    const lineStart = Number(match.index || 0);
    const userStart = lineStart + match[0].indexOf('[') + 1;
    const timeToken = match[2];
    const timeBracketStart = lineStart + match[0].lastIndexOf(`[${timeToken}]`);
    paint(userStart, userStart + match[1].length, 'source-token--user', 5);
    paint(timeBracketStart + 1, timeBracketStart + 1 + timeToken.length, 'source-token--time', 5);
  }
  const occupied = [];
  modeDraft().rows.forEach(row => {
    const token = String(row.rawText || '').trim();
    if (!token) return;
    let start = source.indexOf(token);
    while (start >= 0 && occupied.some(range => start < range.end && start + token.length > range.start)) {
      start = source.indexOf(token, start + 1);
    }
    if (start < 0) return;
    occupied.push({ start, end: start + token.length });
    paint(
      start,
      start + token.length,
      row.matchStatus === 'MATCHED' ? 'source-token--collected' : 'source-token--unmatched',
      row.matchStatus === 'MATCHED' ? 2 : 3
    );
  });
  const ocrReview = state.pendingOcrReview;
  if (ocrReview?.rawText === source && ocrReview.status !== 'VERIFIED') {
    ocrReview.validRows.forEach(row => {
      const start = source.indexOf(String(row.rawText || '').trim());
      if (start >= 0) paint(start, start + row.rawText.length, 'source-token--collected', 3);
    });
    ocrReview.invalidRows.forEach(row => {
      const start = source.indexOf(String(row.rawText || '').trim());
      if (start >= 0) paint(start, start + row.rawText.length, 'source-token--unmatched', 4);
    });
  }
  let html = '';
  let segmentStart = 0;
  for (let index = 1; index <= source.length; index += 1) {
    const previous = marks[index - 1]?.className || '';
    const next = marks[index]?.className || '';
    if (index < source.length && previous === next) continue;
    const content = esc(source.slice(segmentStart, index));
    html += previous ? `<mark class="${previous}">${content}</mark>` : content;
    segmentStart = index;
  }
  highlight.innerHTML = html;
  highlight.scrollTop = sourceTextInput.scrollTop;
  highlight.scrollLeft = sourceTextInput.scrollLeft;
}

function customFieldsFor(scope) {
  return (state.settings.customFields || []).filter(field => field.scope === scope);
}

function headerFieldsForMode(mode = state.draft.activeMode) {
  return state.settings.headerFieldsByMode?.[mode]
    || state.settings.headerFields
    || contract.DEFAULT_SETTINGS.headerFieldsByMode?.[mode]
    || contract.DEFAULT_SETTINGS.headerFields;
}

function voucherColumnsForMode(mode = state.draft.activeMode) {
  return state.settings.voucherColumnsByMode?.[mode]
    || state.settings.voucherColumns
    || contract.DEFAULT_SETTINGS.voucherColumnsByMode?.[mode]
    || contract.DEFAULT_SETTINGS.voucherColumns;
}

function optionalProductFields() {
  const baseIds = new Set(contract.VOUCHER_COLUMN_DEFINITIONS.map(field => field.id));
  const selectedIds = new Set(voucherColumnsForMode());
  const modeFields = new Map(structuredFieldsForMode(state.draft.activeMode, []).map(field => [field.id, field]));
  return contract.PRODUCT_FIELD_DEFINITIONS
    .filter(field => !baseIds.has(field.id) && selectedIds.has(field.id))
    .map(field => modeFields.has(field.id) ? { ...field, label: modeFields.get(field.id).label } : field);
}

function layoutDefinitions(scope, customFields = state.settings.customFields || []) {
  const builtIn = scope === 'header' ? contract.HEADER_FIELD_DEFINITIONS : contract.PRODUCT_FIELD_DEFINITIONS;
  const modeFields = scope === 'voucher'
    ? new Map(structuredFieldsForMode(state.draft.activeMode, []).map(field => [field.id, field]))
    : new Map();
  return [
    ...builtIn.map(field => modeFields.has(field.id) ? { ...field, label: modeFields.get(field.id).label } : field),
    ...customFields.filter(field => field.scope === scope).map(field => ({
      ...field,
      group: scope === 'voucher' ? 'ADDITIONAL' : field.group,
      custom: true,
      required: false
    }))
  ];
}

function estimateNoticePriceDefinitions(fieldIds = contract.ESTIMATE_NOTICE_PRICE_FIELD_IDS) {
  const fieldById = new Map(contract.PRODUCT_FIELD_DEFINITIONS.map(field => [field.id, field]));
  return (fieldIds || []).map(fieldId => fieldById.get(fieldId)).filter(Boolean);
}

function renderCustomLayoutFields() {
  document.querySelectorAll('[data-custom-header-field]').forEach(element => element.remove());
  const headerFieldsContainer = document.querySelector('.header-fields');
  customFieldsFor('header').forEach(field => {
    const label = document.createElement('label');
    label.className = 'field field--custom';
    label.dataset.headerField = field.id;
    label.dataset.customHeaderField = field.id;
    const inputType = field.valueType === 'NUMBER' ? 'number' : 'text';
    const step = inputType === 'number' ? ' step="any"' : '';
    label.innerHTML = `<span>${esc(field.label)} <em>${field.valueType === 'NUMBER' ? '숫자형' : '문자형'}</em></span><input type="${inputType}"${step} data-custom-header-input="${esc(field.id)}" value="${esc(modeDraft().header.customValues?.[field.id] || '')}"><small>주문서별 사용자 입력 항목</small>`;
    headerFieldsContainer.append(label);
  });

  const table = document.querySelector('#tableScroll table');
  table.querySelectorAll('[data-dynamic-product-column], [data-custom-column]').forEach(element => element.remove());
  const actionCol = table.querySelector('colgroup col[data-column="status"]') || table.querySelector('colgroup col:last-child');
  const actionHead = table.querySelector('thead th[data-column="status"]') || table.querySelector('thead th:last-child');
  const actionFoot = table.querySelector('tfoot td[data-column="status"]') || table.querySelector('tfoot td:last-child');
  optionalProductFields().forEach(field => {
    const col = document.createElement('col');
    col.dataset.column = field.id;
    col.dataset.dynamicProductColumn = field.id;
    col.className = 'col-product-extra';
    actionCol.before(col);
    const th = document.createElement('th');
    th.dataset.column = field.id;
    th.dataset.dynamicProductColumn = field.id;
    th.textContent = field.label;
    actionHead.before(th);
    const td = document.createElement('td');
    td.dataset.column = field.id;
    td.dataset.dynamicProductColumn = field.id;
    actionFoot.before(td);
  });
  customFieldsFor('voucher').forEach(field => {
    const col = document.createElement('col');
    col.dataset.column = field.id;
    col.dataset.customColumn = field.id;
    col.className = 'col-custom';
    actionCol.before(col);
    const th = document.createElement('th');
    th.dataset.column = field.id;
    th.dataset.customColumn = field.id;
    th.textContent = field.label;
    actionHead.before(th);
    const td = document.createElement('td');
    td.dataset.column = field.id;
    td.dataset.customColumn = field.id;
    actionFoot.before(td);
  });
  ensureColumnResizeHandles();
}

const DEFAULT_COLUMN_WIDTHS = Object.freeze({
  productSearch: 210,
  itemCode: 112, itemName: 190, specification: 100, quantity: 72, unit: 70,
  unitPrice: 90, supplyAmount: 102, memo: 112, description: 118, noticePrice: 90,
  secondaryName: 150, searchInfo: 180, boxQuantity: 72, outPrice: 90,
  wholesaleA: 90, wholesaleB: 90, listingPrice: 90, marketPrice: 90, promoPrice: 90,
  purchasePriceB: 90, priceD: 90, lastPurchasePrice: 96, priceH: 90, priceI: 90,
  status: 74
});

function columnWidth(fieldId) {
  return Number(
    state.settings.columnWidthsByMode?.[state.draft.activeMode]?.[fieldId]
    || state.settings.columnWidths?.[fieldId]
    || DEFAULT_COLUMN_WIDTHS[fieldId]
    || 120
  );
}

function ensureColumnResizeHandles() {
  document.querySelectorAll('#tableScroll thead th[data-column]').forEach(th => {
    th.classList.add('column-resizable');
    if (th.dataset.column === 'productSearch') {
      th.classList.add('column-fixed');
      th.classList.remove('column-draggable');
      th.draggable = false;
      delete th.dataset.columnDrag;
    } else if (th.dataset.column !== 'status') {
      th.classList.remove('column-fixed');
      th.classList.add('column-draggable');
      th.draggable = true;
      th.dataset.columnDrag = th.dataset.column;
    }
    if (th.querySelector('.column-resize-handle')) return;
    const handle = document.createElement('span');
    handle.className = 'column-resize-handle';
    handle.dataset.resizeColumn = th.dataset.column;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-label', `${th.textContent.trim()} 열 너비 조정`);
    handle.setAttribute('aria-orientation', 'vertical');
    th.append(handle);
  });
}

function applyColumnWidths() {
  document.querySelectorAll('#tableScroll col[data-column]').forEach(col => {
    col.style.width = `${columnWidth(col.dataset.column)}px`;
  });
  document.querySelectorAll('#tableScroll .column-resize-handle').forEach(handle => {
    handle.setAttribute('aria-valuenow', String(columnWidth(handle.dataset.resizeColumn)));
  });
}

function updateTableWidth(visibleColumns) {
  const total = visibleColumns.reduce((sum, fieldId) => sum + columnWidth(fieldId), 84);
  document.querySelector('#tableScroll table')?.style.setProperty('--table-render-width', `${total}px`);
}

function applyVoucherColumnOrder() {
  const configured = voucherColumnsForMode();
  const allFields = layoutDefinitions('voucher').map(field => field.id);
  const ordered = [...new Set([...configured, ...allFields])];
  const containers = [
    document.querySelector('#tableScroll colgroup'),
    document.querySelector('#tableScroll thead tr'),
    ...document.querySelectorAll('#tableScroll tbody tr'),
    document.querySelector('#tableScroll tfoot tr')
  ].filter(Boolean);
  containers.forEach(container => {
    const status = [...container.children].find(child => child.dataset.column === 'status');
    if (!status) return;
    ordered.forEach(fieldId => {
      const cell = [...container.children].find(child => child.dataset.column === fieldId);
      if (cell) container.insertBefore(cell, status);
    });
  });
}

function clearColumnDragMarkers() {
  document.querySelectorAll('#tableScroll .column-dragging, #tableScroll .column-drop-before, #tableScroll .column-drop-after')
    .forEach(element => element.classList.remove('column-dragging', 'column-drop-before', 'column-drop-after'));
}

function beginColumnDrag(event) {
  const header = event.target.closest('th[data-column-drag]');
  if (!header || event.target.closest('.column-resize-handle') || header.classList.contains('is-column-hidden')) {
    event.preventDefault();
    return;
  }
  state.columnDrag = { mode: state.draft.activeMode, fieldId: header.dataset.columnDrag };
  header.classList.add('column-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', header.dataset.columnDrag);
}

function moveColumnDrag(event) {
  const header = event.target.closest('th[data-column-drag]');
  if (!header || !state.columnDrag || state.columnDrag.mode !== state.draft.activeMode || header.classList.contains('is-column-hidden')) return;
  event.preventDefault();
  document.querySelectorAll('#tableScroll .column-drop-before, #tableScroll .column-drop-after')
    .forEach(element => element.classList.remove('column-drop-before', 'column-drop-after'));
  const bounds = header.getBoundingClientRect();
  header.classList.add(event.clientX >= bounds.left + bounds.width / 2 ? 'column-drop-after' : 'column-drop-before');
  event.dataTransfer.dropEffect = 'move';
}

async function finishColumnDrop(event) {
  const header = event.target.closest('th[data-column-drag]');
  const drag = state.columnDrag;
  if (!header || !drag || drag.mode !== state.draft.activeMode) return;
  event.preventDefault();
  const sourceId = drag.fieldId;
  const targetId = header.dataset.columnDrag;
  const order = [...voucherColumnsForMode()];
  if (sourceId === targetId || !order.includes(sourceId) || !order.includes(targetId)) {
    clearColumnDragMarkers();
    state.columnDrag = null;
    return;
  }
  order.splice(order.indexOf(sourceId), 1);
  const bounds = header.getBoundingClientRect();
  const after = event.clientX >= bounds.left + bounds.width / 2;
  order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, sourceId);
  const voucherColumnsByMode = { ...(state.settings.voucherColumnsByMode || {}), [state.draft.activeMode]: order };
  state.settings = contract.normalizeSettings({
    ...state.settings,
    voucherColumns: state.draft.activeMode === 'order' ? order : state.settings.voucherColumns,
    voucherColumnsByMode
  });
  state.columnDrag = null;
  clearColumnDragMarkers();
  applyFormLayout();
  try {
    await saveSettings(state.settings);
    setSaveState('저장됨', 'saved');
    toast('열 순서를 저장했습니다.', 'success');
  } catch (_) {
    toast('열 순서를 저장하지 못했습니다.', 'error');
  }
}

function finishColumnDrag() {
  clearColumnDragMarkers();
  state.columnDrag = null;
}

function visibleVoucherColumnIds() {
  return [...document.querySelectorAll('#tableScroll thead th[data-column]')]
    .filter(element => !element.classList.contains('is-column-hidden'))
    .map(element => element.dataset.column);
}

function setVoucherColumnWidth(fieldId, width) {
  const nextWidth = Math.max(56, Math.min(480, Math.round(Number(width) || columnWidth(fieldId))));
  state.settings.columnWidthsByMode ||= {};
  state.settings.columnWidthsByMode[state.draft.activeMode] ||= {};
  state.settings.columnWidthsByMode[state.draft.activeMode][fieldId] = nextWidth;
  const col = document.querySelector(`#tableScroll col[data-column="${CSS.escape(fieldId)}"]`);
  if (col) col.style.width = `${nextWidth}px`;
  const handle = document.querySelector(`#tableScroll .column-resize-handle[data-resize-column="${CSS.escape(fieldId)}"]`);
  handle?.setAttribute('aria-valuenow', String(nextWidth));
  updateTableWidth(visibleVoucherColumnIds());
  return nextWidth;
}

async function persistVoucherColumnWidths() {
  state.settings = contract.normalizeSettings({
    ...state.settings,
    columnWidths: { ...(state.settings.columnWidths || {}) },
    columnWidthsByMode: Object.fromEntries(Object.keys(contract.MODES).map(mode => [
      mode,
      { ...(state.settings.columnWidthsByMode?.[mode] || {}) }
    ]))
  });
  try {
    await saveSettings(state.settings);
    setSaveState('저장됨', 'saved');
  } catch (_) {
    toast('열 너비를 저장하지 못했습니다.', 'error');
  }
}

function finishColumnResize(event) {
  const resize = state.columnResize;
  if (!resize || (event?.pointerId !== undefined && event.pointerId !== resize.pointerId)) return;
  try { resize.handle.releasePointerCapture?.(resize.pointerId); } catch (_) {}
  document.removeEventListener('pointermove', moveColumnResize);
  document.removeEventListener('pointerup', finishColumnResize);
  document.removeEventListener('pointercancel', finishColumnResize);
  window.removeEventListener('blur', finishColumnResize);
  document.documentElement.classList.remove('smartinput-column-resizing');
  state.columnResize = null;
  void persistVoucherColumnWidths();
}

function moveColumnResize(event) {
  const resize = state.columnResize;
  if (!resize || event.pointerId !== resize.pointerId) return;
  event.preventDefault();
  setVoucherColumnWidth(resize.fieldId, resize.startWidth + event.clientX - resize.startX);
}

function beginColumnResize(event) {
  const handle = event.target.closest('.column-resize-handle');
  if (!handle || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  const fieldId = handle.dataset.resizeColumn;
  state.columnResize = {
    fieldId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: columnWidth(fieldId),
    handle
  };
  try { handle.setPointerCapture?.(event.pointerId); } catch (_) {}
  document.documentElement.classList.add('smartinput-column-resizing');
  document.addEventListener('pointermove', moveColumnResize, { passive: false });
  document.addEventListener('pointerup', finishColumnResize);
  document.addEventListener('pointercancel', finishColumnResize);
  window.addEventListener('blur', finishColumnResize);
}

function resizeColumnWithKeyboard(event) {
  const handle = event.target.closest('.column-resize-handle');
  if (!handle || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  setVoucherColumnWidth(handle.dataset.resizeColumn, columnWidth(handle.dataset.resizeColumn) + direction * (event.shiftKey ? 24 : 8));
  void persistVoucherColumnWidths();
}

function applyFormLayout() {
  renderCustomLayoutFields();
  applyVoucherColumnOrder();
  const headerFields = new Set(headerFieldsForMode());
  if (state.draft.activeMode === 'estimate') {
    headerFields.add('deliveryDate');
    headerFields.add('warehouse');
    headerFields.add('transactionType');
  }
  document.querySelectorAll('[data-header-field]').forEach(element => {
    element.hidden = !headerFields.has(element.dataset.headerField);
  });
  const voucherColumns = new Set(voucherColumnsForMode());
  const photoActive = modeDraft().activeMethod === 'photo' && Boolean(currentSourceImage()?.dataUrl);
  const photoBasicColumns = new Set(['itemCode', 'itemName', 'specification', 'quantity', 'unit', 'unitPrice', 'supplyAmount']
    .filter(fieldId => fieldId === 'itemCode' || voucherColumns.has(fieldId)));
  const visibleVoucherColumns = photoActive && !state.photoView.detailColumns ? photoBasicColumns : voucherColumns;
  document.querySelectorAll('[data-column]').forEach(element => {
    const column = element.dataset.column;
    const visible = column === 'productSearch' || (column === 'status' ? photoActive : visibleVoucherColumns.has(column));
    element.classList.toggle('is-column-hidden', !visible);
  });
  const visibleColumns = [...document.querySelectorAll('thead th[data-column]')]
    .filter(element => !element.classList.contains('is-column-hidden')).length;
  const visibleColumnIds = [...document.querySelectorAll('thead th[data-column]')]
    .filter(element => !element.classList.contains('is-column-hidden'))
    .map(element => element.dataset.column);
  applyColumnWidths();
  updateTableWidth(visibleColumnIds);
  inputRows.querySelector('.empty-row td')?.setAttribute('colspan', String(visibleColumns + 3));
  $('detailColumnsButton').hidden = !photoActive;
  $('detailColumnsButton').textContent = state.photoView.detailColumns ? '기본 열' : '상세 열';
  $('detailColumnsButton').setAttribute('aria-pressed', String(state.photoView.detailColumns));
}

function updateMethod(method, { persist = true } = {}) {
  const selected = contract.INPUT_METHODS.find(item => item.id === method) || contract.INPUT_METHODS[2];
  const changed = modeDraft().activeMethod !== selected.id;
  modeDraft().activeMethod = selected.id;
  methodButtons.forEach(button => button.classList.toggle('is-active', button.dataset.method === selected.id));
  renderSourceSurface();
  if (persist && changed) scheduleSave();
  return selected;
}

function currentSourceImage() {
  return state.sourceImages[state.draft.activeMode] || null;
}

function resetPhotoView() {
  state.photoView.zoom = 1;
  state.photoView.rotation = 0;
  state.photoView.activeRegion = null;
  state.photoView.detailColumns = Boolean(modeUi().detailColumns);
  state.photoView.ocrOpen = false;
}

function renderPhotoRegion() {
  const region = state.photoView.activeRegion;
  const marker = $('photoRegion');
  marker.hidden = !region;
  if (!region) return;
  marker.style.left = `${region.left * 100}%`;
  marker.style.top = `${region.top * 100}%`;
  marker.style.width = `${region.width * 100}%`;
  marker.style.height = `${region.height * 100}%`;
}

function renderPhotoTransform() {
  const image = $('photoPreview');
  const viewport = $('photoViewport');
  const stage = $('photoStage');
  const layer = $('photoLayer');
  if (!image?.naturalWidth || !image.naturalHeight || $('photoViewer').hidden) return;
  const rotation = ((Number(state.photoView.rotation || 0) % 360) + 360) % 360;
  const quarterTurn = rotation === 90 || rotation === 270;
  const rotatedWidth = quarterTurn ? image.naturalHeight : image.naturalWidth;
  const rotatedHeight = quarterTurn ? image.naturalWidth : image.naturalHeight;
  const availableWidth = Math.max(80, viewport.clientWidth - 28);
  const availableHeight = Math.max(80, viewport.clientHeight - 28);
  const fitScale = Math.min(availableWidth / rotatedWidth, availableHeight / rotatedHeight);
  const scale = Math.max(.05, fitScale * Number(state.photoView.zoom || 1));
  const layerWidth = image.naturalWidth * scale;
  const layerHeight = image.naturalHeight * scale;
  const stageWidth = Math.max(viewport.clientWidth, rotatedWidth * scale + 28);
  const stageHeight = Math.max(viewport.clientHeight, rotatedHeight * scale + 28);
  stage.style.width = `${stageWidth}px`;
  stage.style.height = `${stageHeight}px`;
  layer.style.width = `${layerWidth}px`;
  layer.style.height = `${layerHeight}px`;
  layer.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
  $('photoZoomLabel').textContent = state.photoView.zoom === 1 ? '맞춤 100%' : `${Math.round(state.photoView.zoom * 100)}%`;
  renderPhotoRegion();
}

function renderSourceSurface() {
  const evidence = currentSourceImage();
  const photoMode = modeDraft().activeMethod === 'photo';
  const showPhoto = photoMode && Boolean(evidence?.dataUrl);
  const workspace = document.querySelector('.workspace');
  const photoViewer = $('photoViewer');
  const photoStateChanged = workspace.classList.contains('has-photo-source') !== photoMode;
  workspace.classList.toggle('has-photo-source', photoMode);
  const savedWidth = Number(state.draft.ui.parserPaneWidth || state.draft.ui.photoPaneWidth || 0);
  if (savedWidth > 0) workspace.style.setProperty('--parser-pane-width', `${savedWidth}px`);
  $('sourceEditor').hidden = photoMode;
  photoViewer.hidden = !photoMode;
  photoViewer.classList.toggle('has-image', showPhoto);
  $('photoViewerToolbar').hidden = !showPhoto;
  $('photoEmptyState').hidden = showPhoto;
  $('photoStage').hidden = !showPhoto;
  $('photoViewerMeta').hidden = !showPhoto;
  $('analyzeButton').hidden = photoMode && !showPhoto;
  if (photoStateChanged) window.requestAnimationFrame(applyFormLayout);
  if (!showPhoto) {
    $('photoOcrPanel').hidden = true;
    $('photoOcrToggle').setAttribute('aria-expanded', 'false');
    $('photoOcrToggle').disabled = true;
    const image = $('photoPreview');
    image.removeAttribute('src');
    image.hidden = true;
    image.dataset.sourceImageId = '';
    $('photoFileName').textContent = '원본 사진 없음';
    $('photoViewerNotice').textContent = state.smartDataReady
      ? '사진을 선택하면 원본을 이 영역에 그대로 표시합니다.'
      : '저장된 원본 사진을 불러오고 있습니다.';
    return;
  }
  $('photoOcrToggle').disabled = false;
  const image = $('photoPreview');
  image.hidden = false;
  if (image.dataset.sourceImageId !== evidence.sourceImageId) {
    image.dataset.sourceImageId = evidence.sourceImageId;
    image.src = evidence.dataUrl;
    resetPhotoView();
  }
  $('photoOcrPanel').hidden = !state.photoView.ocrOpen;
  $('photoOcrToggle').setAttribute('aria-expanded', String(state.photoView.ocrOpen));
  $('photoFileName').textContent = evidence.fileName || '원본 사진';
  $('photoOcrText').textContent = sourceTextInput.value || '사진 분석 후 인식된 문자가 표시됩니다.';
  $('photoViewerNotice').textContent = state.photoView.activeRegion
    ? '선택한 상품의 원본 위치입니다.'
    : (evidence.notice || '원본 사진을 기준으로 입력값을 확인하세요.');
  window.requestAnimationFrame(renderPhotoTransform);
}

function showPhotoRegion(region) {
  state.photoView.activeRegion = region && typeof region === 'object' ? { ...region } : null;
  renderPhotoRegion();
  $('photoViewerNotice').textContent = state.photoView.activeRegion
    ? '선택한 상품의 원본 위치입니다.'
    : '이 행은 신뢰할 수 있는 사진 좌표가 없어 원본 전체를 표시합니다.';
}

function rowStatusText(status, row = null) {
  if (status === 'EMPTY') return '입력 대기';
  if (status === 'ANALYZING') return '분석 중';
  if (status === 'MATCHED') return '일치';
  if (status === 'SIMILAR') return '확인 필요';
  if (row?.referenceResolution === 'MISSING') return '미등록 상품';
  if (row?.referenceResolution === 'REFERENCE_ERROR') return '기준정보 오류';
  if (row?.referenceResolution === 'STALE_SELECTION') return '갱신 확인';
  return '불일치';
}

function activityLabel(method) {
  return ACTIVITY_LABELS[method] || contract.INPUT_METHODS.find(item => item.id === method)?.label || '입력';
}

function visibleActivityBatches(current = modeDraft()) {
  return (current.batches || []).filter(batch => batch.sourceType !== 'MANUAL' && batch.method !== 'direct');
}

function renderActivityTrail() {
  const batches = visibleActivityBatches();
  const trail = $('activityTrail');
  const current = $('activityCurrent');
  trail.hidden = !state.activeActivity && batches.length === 0;
  current.hidden = !state.activeActivity;
  $('activityCurrentText').textContent = state.activeActivity;
  $('activityItems').innerHTML = batches.map((batch, index) => (
    `<li><strong>${index + 1}.</strong> ${esc(activityLabel(batch.method))}</li>`
  )).join('');
}

function setActiveActivity(message = '') {
  state.activeActivity = message;
  renderActivityTrail();
}

function customerName(customer) {
  return String(customer?.customerName || customer?.name || '').trim();
}

function customerCode(customer) {
  return String(customer?.customerCode || customer?.erpCustomerCode || '').trim();
}

function customerIdentityLabel(customer) {
  return customerCode(customer)
    || String(customer?.businessNumber || '').trim()
    || (temporaryMeta(customer?.customerId) ? '임시 배송처' : '코드 미등록');
}

function customerLocationKey(customer) {
  return normalizedKey([
    customer?.address,
    customer?.addressDetail,
    customer?.phone || customer?.contactPhone || customer?.mobile
  ].filter(Boolean).join('|'));
}

function normalizedKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s()[\]{}<>,.:;·_-]+/g, '');
}

function extractOrdererName(rawText) {
  const lines = String(rawText || '').replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/^[-•·*]+\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const bracketed = lines.map(line => line.match(/^\[([^\]]+)\]/)?.[1]?.trim()).find(Boolean);
  if (bracketed) return bracketed;
  return lines.find(line => !/\d+(?:\.\d+)?\s*(개|박스|box|kg|g|판|봉|팩|ea|세트)?\s*$/i.test(line)) || lines[0] || '';
}

function looksLikeKakaoText(rawText) {
  return /^\s*\[[^\]\r\n]+\]\s*\[(?:오전|오후)?\s*\d{1,2}:\d{2}\]/m.test(String(rawText || ''));
}

function aliasContextKey(sourceType = '') {
  return `SMART_INPUT|${String(sourceType || 'GENERAL_TEXT').toUpperCase()}`;
}

function temporaryMeta(customerId) {
  return state.temporaryCustomers.find(item => item.customerId === customerId && item.status !== 'INACTIVE') || null;
}

function normalizedCustomerCandidates(customers = []) {
  const uniqueById = new Map();
  customers.forEach(customer => {
    const customerId = String(customer?.customerId || '').trim();
    if (!customerId || !customerName(customer)) return;
    if ((customer.status || 'ACTIVE') !== 'ACTIVE' || customer.qualityStatus === 'SUPERSEDED') return;
    const previous = uniqueById.get(customerId);
    if (!previous || (!customerCode(previous) && customerCode(customer))) uniqueById.set(customerId, customer);
  });
  const active = [...uniqueById.values()];
  const identifiedByName = new Map();
  active.filter(customer => customerCode(customer) || String(customer.businessNumber || '').trim() || temporaryMeta(customer.customerId))
    .forEach(customer => {
      const nameKey = normalizedKey(customerName(customer));
      if (!nameKey) return;
      const locations = identifiedByName.get(nameKey) || new Set();
      const locationKey = customerLocationKey(customer);
      if (locationKey) locations.add(locationKey);
      identifiedByName.set(nameKey, locations);
    });
  return active.filter(customer => {
    if (customerCode(customer) || String(customer.businessNumber || '').trim() || temporaryMeta(customer.customerId)) return true;
    const identifiedLocations = identifiedByName.get(normalizedKey(customerName(customer)));
    if (!identifiedLocations) return true;
    const locationKey = customerLocationKey(customer);
    if (!locationKey) return false;
    return !identifiedLocations.has(locationKey);
  });
}

function groupForCustomer(customerId) {
  return state.linkGroups.find(group => group.status !== 'INACTIVE' && group.memberCustomerIds?.includes(customerId)) || null;
}

function customerById(customerId) {
  return state.customers.find(customer => customer.customerId === customerId) || null;
}

function applyCustomerRelationship(header = modeDraft().header) {
  const group = groupForCustomer(header.customerId);
  const taxCustomer = group?.taxCustomerId ? customerById(group.taxCustomerId) : null;
  const deliveryCustomerIds = group?.deliveryCustomerIds?.length ? group.deliveryCustomerIds : (group?.memberCustomerIds || []);
  header.customerLinkGroupId = group?.linkGroupId || '';
  header.taxCustomerId = taxCustomer?.customerId || '';
  header.taxCustomerName = customerName(taxCustomer);
  header.isTemporaryCustomer = Boolean(temporaryMeta(header.customerId));
  $('taxCustomerInput').value = header.taxCustomerName;
  $('customerRelationHint').textContent = group
    ? (taxCustomer ? `배송처 ${deliveryCustomerIds.length}곳 · 세무거래처 1곳` : `배송처 ${deliveryCustomerIds.length}곳 · 세무거래처 지정 필요`)
    : '연결되지 않은 배송 거래처입니다.';
  $('customerRelationHint').dataset.tone = group && !taxCustomer ? 'warn' : '';
}

function effectiveAliasMappings(rawOrdererName, sourceType) {
  const normalizedName = normalizeAliasName(rawOrdererName);
  if (!normalizedName) return [];
  const confirmed = state.aliasMappings.filter(mapping => mapping.status === 'CONFIRMED' && mapping.normalizedName === normalizedName);
  const exactContext = confirmed.filter(mapping => mapping.contextKey === aliasContextKey(sourceType));
  return exactContext.length ? exactContext : confirmed;
}

function resolveAliasCustomer(rawOrdererName, sourceType) {
  const mappings = effectiveAliasMappings(rawOrdererName, sourceType);
  const customerIds = [...new Set(mappings.map(mapping => mapping.deliveryCustomerId).filter(Boolean))];
  if (customerIds.length !== 1) return null;
  const customer = customerById(customerIds[0]);
  if (!customer) return null;
  return { customer, mapping: mappings.find(item => item.deliveryCustomerId === customer.customerId) };
}

async function confirmCustomerAlias(rawOrdererName, customer, sourceType = 'GENERAL_TEXT') {
  const normalizedName = normalizeAliasName(rawOrdererName);
  if (!normalizedName || !customer?.customerId) return null;
  const contextKey = aliasContextKey(sourceType);
  const timestamp = new Date().toISOString();
  const existing = state.aliasMappings.find(mapping => mapping.normalizedName === normalizedName && mapping.contextKey === contextKey);
  const mapping = {
    aliasMappingId: existing?.aliasMappingId || createRecordId('SIALIAS'),
    rawOrdererName: String(rawOrdererName).trim(),
    normalizedName,
    sourceType,
    contextKey,
    deliveryCustomerId: customer.customerId,
    status: 'CONFIRMED',
    confirmedBy: 'SMART_INPUT_ADMIN',
    confirmedAt: existing?.confirmedAt || timestamp,
    useCount: Number(existing?.useCount || 0) + 1,
    lastUsedAt: timestamp,
    updatedAt: timestamp
  };
  await saveAliasMapping(mapping);
  const index = state.aliasMappings.findIndex(item => item.aliasMappingId === mapping.aliasMappingId);
  if (index >= 0) state.aliasMappings[index] = mapping;
  else state.aliasMappings.push(mapping);
  modeDraft().header.aliasMappingId = mapping.aliasMappingId;
  modeDraft().header.customerMappingSource = 'MANUAL_CONFIRMED_ALIAS';
  return mapping;
}

function updateDeliveryPolicy({ force = false } = {}) {
  const header = modeDraft().header;
  if (!header.orderDate) return;
  if (force || !header.manualDeliveryOverride || !header.deliveryDate) {
    const next = contract.nextDeliveryDate({
      orderDate: header.orderDate,
      customerId: header.customerId,
      settings: state.settings
    });
    if (next.date) header.deliveryDate = next.date;
  }
  $('deliveryDateInput').value = header.deliveryDate;
  const decision = contract.validateDeliveryDate({
    deliveryDate: header.deliveryDate,
    orderDate: header.orderDate,
    customerId: header.customerId,
    settings: state.settings
  });
  const weekdays = contract.deliveryWeekdayLabel(state.settings, header.customerId);
  const cutoff = state.settings.orderCutoffTime ? ` · 당일 마감 ${state.settings.orderCutoffTime}` : '';
  const nextAvailable = decision.valid ? null : contract.nextDeliveryDate({
    orderDate: header.orderDate,
    customerId: header.customerId,
    settings: state.settings
  });
  const nextMessage = nextAvailable?.date ? ` 다음 가능일은 ${nextAvailable.date}입니다.` : ' 다음 가능일을 찾지 못했습니다.';
  $('deliveryPolicyHint').textContent = decision.valid ? `배송 ${weekdays}요일${cutoff}` : `${decision.message}${nextMessage}`;
  $('deliveryPolicyHint').dataset.tone = decision.valid ? '' : 'error';
  header.deliveryPolicySnapshot = {
    orderCutoffTime: state.settings.orderCutoffTime,
    allowSameDayDelivery: state.settings.allowSameDayDelivery,
    deliveryWeekdays: contract.effectiveDeliveryWeekdays(state.settings, header.customerId),
    holidayWeekdays: [...state.settings.holidayWeekdays],
    holidayDates: [...state.settings.holidayDates],
    timezone: state.settings.timezone,
    evaluatedAt: new Date().toISOString(),
    validationCode: decision.code
  };
  return decision;
}

function applyCustomer(customer, { rematch = true, mappingSource = 'MANUAL', learnAlias = true } = {}) {
  if (!customer) return;
  if (customer.customerId && !state.customers.some(item => item.customerId === customer.customerId)) state.customers.push(customer);
  const header = modeDraft().header;
  header.customerId = String(customer.customerId || '').trim();
  header.customerCode = customerCode(customer);
  header.customerName = customerName(customer);
  header.customerMappingSource = mappingSource;
  $('customerInput').value = header.customerName;
  $('customerInput').dataset.customerId = header.customerId;
  $('customerHint').textContent = `${customerCode(customer) || (temporaryMeta(header.customerId) ? '임시 배송처' : '등록 거래처')} · ${mappingSource === 'CONFIRMED_ALIAS' ? '주문자명 자동 지정' : '마스터 연결됨'}`;
  applyCustomerRelationship(header);
  updateDeliveryPolicy();
  renderCatalogControls();
  renderVoucherContext();
  scheduleSave();
  if (learnAlias && header.rawOrdererName) {
    void confirmCustomerAlias(header.rawOrdererName, customer, currentSourceType())
      .then(() => { $('customerHint').textContent = `${customerCode(customer) || '등록 거래처'} · 다음 동일 주문자명 자동 지정`; saveDraftNow(); })
      .catch(() => toast('거래처는 선택했지만 주문자명 매핑은 저장하지 못했습니다.', 'error'));
  }
  if (mappingSource === 'MANUAL') armItemCodeEntry();
  if (rematch && state.draft.activeMode === 'order' && modeDraft().rows.length) rematchRowsForCustomer(customer);
}

function armItemCodeEntry() {
  const targetRow = modeDraft().rows.find(row => !String(row.itemCode || '').trim()) || modeDraft().rows[0] || null;
  const rowId = targetRow?.rowId || DEFAULT_INPUT_ROW_ID;
  modeUi().activeCellId = `${rowId}|productSearch`;
  state.draft.ui.selectedRowId = rowId;
  window.requestAnimationFrame(() => {
    const input = inputRows.querySelector(`[data-row-id="${CSS.escape(rowId)}"] [data-product-search]`);
    if (!input) return;
    input.focus({ preventScroll: true });
    if (typeof input.setSelectionRange === 'function') input.setSelectionRange(input.value.length, input.value.length);
  });
}

function inferCustomer(rawText) {
  const candidates = String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/^[-•·*]+\s*/, '').replace(/^\[([^\]]+)\].*$/, '$1').trim())
    .filter(Boolean)
    .slice(0, 6);
  for (const candidate of candidates) {
    const key = normalizedKey(candidate);
    const found = state.customers.find(customer => normalizedKey(customerName(customer)) === key
      || (customerCode(customer) && normalizedKey(customerCode(customer)) === key));
    if (found) return found;
  }
  return null;
}

function resolveStage1RowReferences(rows = modeDraft().rows) {
  const resolveRole = (row, prefix) => {
    const idField = `${prefix}CustomerId`;
    const codeField = `${prefix}CustomerCode`;
    const nameField = `${prefix}CustomerName`;
    const idKey = normalizedKey(row[idField]);
    const codeKey = normalizedKey(row[codeField]);
    const nameKey = normalizedKey(row[nameField]);
    if (!idKey && !codeKey && !nameKey) return;
    const customer = state.customers.find(candidate => (idKey && normalizedKey(candidate.customerId) === idKey)
      || (codeKey && normalizedKey(customerCode(candidate)) === codeKey)
      || (!idKey && !codeKey && nameKey && normalizedKey(customerName(candidate)) === nameKey));
    if (!customer) return;
    row[idField] = String(customer.customerId || '').trim();
    row[codeField] = customerCode(customer);
    row[nameField] = customerName(customer);
  };
  rows.forEach(row => {
    resolveRole(row, 'row');
    ['delivery', 'billing', 'supplier', 'sales'].forEach(prefix => resolveRole(row, prefix));
  });
  return rows;
}

function currentSourceType() {
  const batches = modeDraft().batches;
  return batches[batches.length - 1]?.sourceType
    || contract.INPUT_METHODS.find(method => method.id === modeDraft().activeMethod)?.sourceType
    || 'GENERAL_TEXT';
}

async function refreshCustomers() {
  await reloadReferenceDomain('customer');
  if (!state.references.customer.active) throw new Error('거래처 기준정보를 불러오지 못했습니다.');
  return state.customers;
}

function customerSearchText(customer) {
  return [customerName(customer), customerCode(customer), customer.address, customer.businessNumber, customer.searchText]
    .filter(Boolean).join(' ');
}

async function registerCustomerProfile({ temporary = false } = {}) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'smart-dialog smart-dialog--compact';
    dialog.innerHTML = `<form method="dialog" class="smart-dialog__shell">
      <header><div><small>${temporary ? 'Temporary Delivery' : 'Tax Customer'}</small><h2>${temporary ? '임시 배송처 등록' : '세무 거래처 등록'}</h2></div><button type="button" data-cancel aria-label="닫기">×</button></header>
      <div class="smart-form">
        <label><span>거래처명 <em>필수</em></span><input name="customerName" autocomplete="organization"></label>
        ${temporary ? '<label><span>창고·지점명</span><input name="warehouseName"></label>' : '<label><span>사업자등록번호</span><input name="businessNumber" inputmode="numeric"></label><label><span>대표자명</span><input name="representativeName"></label>'}
        <label class="smart-form--wide"><span>주소</span><input name="address" autocomplete="street-address"></label>
        <label><span>연락처</span><input name="contactPhone" inputmode="tel"></label>
      </div>
      <p class="smart-dialog__message">${temporary ? '주문·배송에만 사용하며 세무 거래처로 지정할 수 없습니다.' : '결제·세금계산서를 관리할 공식 거래처만 등록하세요.'}</p>
      <footer><button type="button" class="button button--quiet" data-cancel>취소</button><button type="button" class="button button--primary" data-save>${temporary ? '임시 등록' : '세무 등록'}</button></footer>
    </form>`;
    document.body.append(dialog);
    const message = dialog.querySelector('.smart-dialog__message');
    const finish = customer => {
      resolve(customer || null);
      dialog.close();
      dialog.remove();
    };
    dialog.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', () => finish(null)));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.querySelector('[data-save]').addEventListener('click', async () => {
      const form = new FormData(dialog.querySelector('form'));
      const customerNameValue = String(form.get('customerName') || '').trim();
      if (!customerNameValue) {
        message.textContent = '거래처명을 입력하세요.';
        return;
      }
      try {
        const customerFields = {
          customerName: customerNameValue,
          customerCode: '',
          businessNumber: String(form.get('businessNumber') || '').trim(),
          representativeName: String(form.get('representativeName') || '').trim(),
          address: String(form.get('address') || '').trim(),
          phone: String(form.get('contactPhone') || '').trim()
        };
        if (!temporary) {
          window.open(ownerAppHref('customer'), '_blank', 'noopener');
          const request = buildRegistrationChangeRequest('customer', customerFields, {
            mode: state.draft.activeMode,
            documentId: modeDraft().documentId
          });
          const result = await submitRegistrationChangeRequest('customer', request);
          message.textContent = result.accepted
            ? '거래처관리 변경요청함에 접수했습니다. 등록을 마친 뒤 거래처 기준정보만 다시 불러오세요.'
            : '거래처관리 화면을 열었습니다. 현재 입력은 유지되며 직접 등록 후 다시 불러올 수 있습니다.';
          return;
        }
        const timestamp = new Date().toISOString();
        const customer = {
          customerId: createRecordId('SITEMP'),
          customerName: customerNameValue,
          customerCode: '',
          address: customerFields.address,
          contactPhone: customerFields.phone,
          status: 'ACTIVE',
          qualityStatus: 'TEMPORARY',
          createdAt: timestamp,
          updatedAt: timestamp
        };
        if (temporary) {
          const metadata = {
            customerId: customer.customerId,
            warehouseName: String(form.get('warehouseName') || '').trim(),
            address: String(form.get('address') || '').trim(),
            contact: String(form.get('contactPhone') || '').trim(),
            linkGroupId: '',
            status: 'TEMPORARY',
            createdAt: timestamp,
            updatedAt: timestamp
          };
          await saveTemporaryCustomer(metadata);
          state.temporaryCustomers.push(metadata);
        }
        state.customers.push(customer);
        finish(customer);
      } catch (error) {
        message.textContent = error.code === 'CUSTOMER_DUPLICATE_CANDIDATE'
          ? '유사하거나 같은 거래처가 있습니다. 신규 등록 대신 기존 거래처를 선택하세요.'
          : (error.message || '거래처를 등록하지 못했습니다.');
      }
    });
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      dialog.querySelector('[data-save]').click();
    });
    dialog.showModal();
    dialog.querySelector('[name="customerName"]').focus();
  });
}

async function persistLinkGroup(group) {
  await saveLinkGroup(group);
  const index = state.linkGroups.findIndex(item => item.linkGroupId === group.linkGroupId);
  if (index >= 0) state.linkGroups[index] = group;
  else state.linkGroups.push(group);
  for (const customerId of group.memberCustomerIds) {
    const metadata = temporaryMeta(customerId);
    if (!metadata || metadata.linkGroupId === group.linkGroupId) continue;
    const next = { ...metadata, linkGroupId: group.linkGroupId, updatedAt: new Date().toISOString() };
    await saveTemporaryCustomer(next);
    state.temporaryCustomers[state.temporaryCustomers.findIndex(item => item.customerId === customerId)] = next;
  }
  applyCustomerRelationship();
  saveDraftNow();
}

async function chooseCustomer() {
  try {
    const customer = await new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'smart-dialog smart-customer-dialog';
      dialog.innerHTML = `<div class="smart-dialog__shell">
        <header><div><small>Customer Master</small><h2>스마트입력 거래처 찾기</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
        <div class="smart-dialog__toolbar"><button type="button" class="button button--quiet" data-link-mode>거래처 관계 설정</button><button type="button" class="button button--quiet" data-temp-create>임시 배송처</button></div>
        <label class="smart-dialog__search">거래처명 또는 코드<input type="search" value="${esc($('customerInput').value)}" autocomplete="off"></label>
        <div class="smart-dialog__message">거래처 앞 체크박스를 선택한 뒤 용도를 지정하세요.</div>
        <div class="smart-customer-results"></div>
        <footer class="smart-customer-action-footer"><span data-customer-selection>선택된 거래처가 없습니다.</span><button type="button" class="button button--quiet" data-customer-use>배송 거래처 선택</button><button type="button" class="button button--primary" data-tax-register>세무 거래처 등록</button></footer>
        <footer class="smart-link-footer" hidden><span>배송처 1곳 이상과 세무거래처 1곳을 지정하세요.</span><button type="button" class="button button--quiet" data-link-cancel>취소</button><button type="button" class="button button--primary" data-link-save>관계 저장</button></footer>
      </div>`;
      document.body.append(dialog);
      const input = dialog.querySelector('input[type="search"]');
      const results = dialog.querySelector('.smart-customer-results');
      const message = dialog.querySelector('.smart-dialog__message');
      const actionFooter = dialog.querySelector('.smart-customer-action-footer');
      const linkFooter = dialog.querySelector('.smart-link-footer');
      const selectionText = dialog.querySelector('[data-customer-selection]');
      const selected = new Set();
      let selectedTaxCustomerId = '';
      let linkMode = false;
      let customerLoading = Boolean(state.references.customer.loading || state.references.customer.status === REFERENCE_DOMAIN_STATUS.LOADING);
      let visibleCustomers = [];
      const finish = value => {
        resolve(value || null);
        dialog.close();
        dialog.remove();
      };
      const render = () => {
        const query = input.value.trim();
        visibleCustomers = normalizedCustomerCandidates(state.customers)
          .filter(customerItem => !query || normalizedKey(customerSearchText(customerItem)).includes(normalizedKey(query)))
            .sort((left, right) => customerName(left).localeCompare(customerName(right), 'ko'))
            .slice(0, 80);
        if (linkMode && visibleCustomers.length === 1 && !selected.size && !selectedTaxCustomerId) {
          const onlyCustomer = visibleCustomers[0];
          selected.add(onlyCustomer.customerId);
          if (!temporaryMeta(onlyCustomer.customerId)) selectedTaxCustomerId = onlyCustomer.customerId;
        }
        const emptyState = query
          ? '검색 결과 0건'
          : (state.references.customer.status === REFERENCE_DOMAIN_STATUS.ERROR
            ? '거래처 기준정보 로드 실패'
            : (state.references.customer.active?.status === REFERENCE_DOMAIN_STATUS.EMPTY ? '등록 거래처 0건' : '표시할 거래처가 없습니다.'));
        results.innerHTML = visibleCustomers.map(customerItem => {
          const group = groupForCustomer(customerItem.customerId);
          const deliveryCustomerIds = group?.deliveryCustomerIds?.length ? group.deliveryCustomerIds : (group?.memberCustomerIds || []);
          const hasRelationship = Number(group?.memberCustomerIds?.length || 0) >= 1;
          const isDelivery = hasRelationship && deliveryCustomerIds.includes(customerItem.customerId);
          const isTax = hasRelationship && group?.taxCustomerId === customerItem.customerId;
          const isTemporary = Boolean(temporaryMeta(customerItem.customerId));
          return `<article class="smart-customer-row ${selected.has(customerItem.customerId) ? 'is-selected' : ''}" data-customer-id="${esc(customerItem.customerId)}">
            <label class="smart-customer-check"><input type="checkbox" ${selected.has(customerItem.customerId) ? 'checked' : ''}><span class="sr-only">${esc(customerName(customerItem))} ${linkMode ? '배송처' : ''} 선택</span></label>
            <div class="smart-customer-select"><strong>${esc(customerName(customerItem))}</strong><span>${esc(customerIdentityLabel(customerItem))}</span><small>${esc(customerItem.address || temporaryMeta(customerItem.customerId)?.warehouseName || '')}</small></div>
            <div class="smart-customer-badges">${isTemporary ? '<span class="is-temp">임시 배송처</span>' : ''}${hasRelationship ? `<span>관계 ${group.memberCustomerIds.length}</span>` : ''}${isDelivery ? '<span class="is-delivery">배송처</span>' : ''}${isTax ? '<span class="is-tax">세무거래처</span>' : ''}${linkMode ? `<label class="smart-tax-role ${isTemporary ? 'is-disabled' : ''}"><input type="radio" name="taxCustomerRole" value="${esc(customerItem.customerId)}" ${selectedTaxCustomerId === customerItem.customerId ? 'checked' : ''} ${isTemporary ? 'disabled' : ''}><span>세무</span></label>` : ''}</div>
          </article>`;
        }).join('') || `<div class="smart-dialog__empty"><strong>${esc(emptyState)}</strong></div>`;
        results.querySelectorAll('.smart-customer-row').forEach(row => {
          const customerId = row.dataset.customerId;
          row.querySelector('input[type="checkbox"]')?.addEventListener('change', event => {
            if (!linkMode) selected.clear();
            if (event.target.checked) selected.add(customerId);
            else {
              selected.delete(customerId);
              if (!linkMode && selectedTaxCustomerId === customerId) selectedTaxCustomerId = '';
            }
            render();
          });
        });
        results.querySelectorAll('input[name="taxCustomerRole"]').forEach(radio => radio.addEventListener('change', event => {
          selectedTaxCustomerId = event.target.value;
          render();
        }));
        const selectedCustomer = !linkMode && selected.size === 1 ? customerById([...selected][0]) : null;
        const selectedIsTemporary = Boolean(selectedCustomer && temporaryMeta(selectedCustomer.customerId));
        if (selectionText) {
          selectionText.textContent = selectedCustomer
            ? `${customerName(selectedCustomer)} 선택됨${selectedIsTemporary ? ' · 임시 배송처는 세무 등록 불가' : ''}`
            : '선택된 거래처가 없습니다.';
        }
        dialog.querySelector('[data-customer-use]').disabled = !selectedCustomer;
        dialog.querySelector('[data-tax-register]').disabled = !selectedCustomer || selectedIsTemporary;
        message.textContent = linkMode
          ? `배송처 ${selected.size}곳 · 세무거래처 ${selectedTaxCustomerId ? '1곳 지정' : '미지정'}`
          : (customerLoading && !visibleCustomers.length
            ? '거래처 목록을 불러오는 중입니다. 창은 그대로 두고 잠시 기다려 주세요.'
            : (!visibleCustomers.length ? emptyState : `${visibleCustomers.length}개 거래처 · 한 곳만 체크할 수 있습니다.`));
      };
      const setLinkMode = value => {
        linkMode = value;
        if (linkMode) {
          const anchorCustomerId = selected.size === 1 ? [...selected][0] : '';
          const existingGroup = anchorCustomerId ? groupForCustomer(anchorCustomerId) : null;
          if (existingGroup) {
            const deliveryCustomerIds = existingGroup.deliveryCustomerIds?.length
              ? existingGroup.deliveryCustomerIds
              : existingGroup.memberCustomerIds || [];
            selected.clear();
            deliveryCustomerIds.forEach(customerId => selected.add(customerId));
            selectedTaxCustomerId = existingGroup.taxCustomerId || '';
          } else if (anchorCustomerId && !temporaryMeta(anchorCustomerId)) {
            selectedTaxCustomerId = anchorCustomerId;
          }
        } else {
          selected.clear();
          selectedTaxCustomerId = '';
        }
        actionFooter.hidden = linkMode;
        linkFooter.hidden = !linkMode;
        dialog.querySelector('[data-link-mode]').classList.toggle('button--primary', linkMode);
        render();
      };
      dialog.querySelector('[data-close]').addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      dialog.querySelector('[data-link-mode]').addEventListener('click', () => setLinkMode(!linkMode));
      dialog.querySelector('[data-link-cancel]').addEventListener('click', () => setLinkMode(false));
      dialog.querySelector('[data-customer-use]').addEventListener('click', () => {
        const customerId = [...selected][0];
        if (!customerId) {
          message.textContent = '배송 거래처로 사용할 곳을 먼저 체크하세요.';
          return;
        }
        finish(customerById(customerId));
      });
      dialog.querySelector('[data-tax-register]').addEventListener('click', async () => {
        const customerId = [...selected][0];
        if (!customerId) {
          message.textContent = '세무 거래처로 등록할 곳을 먼저 체크하세요.';
          return;
        }
        const customerItem = customerById(customerId);
        if (temporaryMeta(customerId)) {
          message.textContent = '임시 배송처는 세무 거래처로 등록할 수 없습니다.';
          return;
        }
        const group = groupForCustomer(customerId);
        const timestamp = new Date().toISOString();
        const next = group
          ? {
              ...group,
              memberCustomerIds: [...new Set([...(group.memberCustomerIds || []), customerId])],
              deliveryCustomerIds: [...new Set([...(group.deliveryCustomerIds?.length ? group.deliveryCustomerIds : group.memberCustomerIds || []), customerId])],
              taxCustomerId: customerId,
              status: 'CONFIRMED',
              revision: Number(group.revision || 0) + 1,
              updatedAt: timestamp
            }
          : {
              linkGroupId: createRecordId('SILINK'),
              memberCustomerIds: [customerId],
              deliveryCustomerIds: [customerId],
              taxCustomerId: customerId,
              status: 'CONFIRMED',
              revision: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
              updatedBy: 'SMART_INPUT_ADMIN'
            };
        try {
          await persistLinkGroup(next);
          render();
          message.textContent = `${customerName(customerItem)}을 세무 거래처로 등록했습니다.`;
        } catch (error) {
          message.textContent = error.message || '세무 거래처를 등록하지 못했습니다.';
        }
      });
      dialog.querySelector('[data-link-save]').addEventListener('click', async () => {
        if (selected.size < 1) {
          message.textContent = '배송처를 1곳 이상 선택하세요.';
          return;
        }
        if (!selectedTaxCustomerId) {
          message.textContent = '세무거래처를 정확히 1곳 지정하세요.';
          return;
        }
        if (temporaryMeta(selectedTaxCustomerId)) {
          message.textContent = '임시 배송처는 세무거래처로 지정할 수 없습니다.';
          return;
        }
        const groupIds = [...new Set([...selected, selectedTaxCustomerId].map(id => groupForCustomer(id)?.linkGroupId).filter(Boolean))];
        if (groupIds.length > 1) {
          message.textContent = '서로 다른 관계 그룹은 한 번에 합칠 수 없습니다. 그룹별로 처리하세요.';
          return;
        }
        const existing = groupIds.length ? state.linkGroups.find(group => group.linkGroupId === groupIds[0]) : null;
        const deliveryCustomerIds = [...selected];
        const memberCustomerIds = [...new Set([...deliveryCustomerIds, selectedTaxCustomerId])];
        const timestamp = new Date().toISOString();
        const group = {
          linkGroupId: existing?.linkGroupId || createRecordId('SILINK'),
          memberCustomerIds,
          deliveryCustomerIds,
          taxCustomerId: selectedTaxCustomerId,
          status: 'CONFIRMED',
          revision: Number(existing?.revision || 0) + 1,
          createdAt: existing?.createdAt || timestamp,
          updatedAt: timestamp,
          updatedBy: 'SMART_INPUT_ADMIN'
        };
        const currentCustomerId = modeDraft().header.customerId;
        const deliveryCustomerId = deliveryCustomerIds.includes(currentCustomerId)
          ? currentCustomerId
          : (visibleCustomers.find(customerItem => deliveryCustomerIds.includes(customerItem.customerId))?.customerId || deliveryCustomerIds[0]);
        const deliveryCustomer = customerById(deliveryCustomerId);
        if (!deliveryCustomer) {
          message.textContent = '현재 전표에 지정할 배송처를 불러오지 못했습니다.';
          return;
        }
        await persistLinkGroup(group);
        finish(deliveryCustomer);
      });
      dialog.querySelector('[data-temp-create]').addEventListener('click', async () => {
        const created = await registerCustomerProfile({ temporary: true });
        if (!created) return;
        if (!linkMode) selected.clear();
        selected.add(created.customerId);
        input.value = created.customerName;
        render();
      });
      let timer = null;
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 100); });
      dialog.showModal();
      input.focus();
      render();
      void refreshCustomers()
        .then(() => {
          customerLoading = false;
          render();
        })
        .catch(error => {
          customerLoading = false;
          render();
          message.textContent = error.message || '거래처 목록을 불러오지 못했습니다.';
        });
    });
    if (customer) applyCustomer(customer);
  } catch (error) {
    toast(error.message || '거래처 목록을 열지 못했습니다.', 'error');
  }
}

function weekdayChecks(name, selected = []) {
  return contract.WEEKDAY_LABELS.map((label, day) => `<label class="weekday-check"><input type="checkbox" name="${name}" value="${day}" ${selected.includes(day) ? 'checked' : ''}><span>${label}</span></label>`).join('');
}

function selectedWeekdays(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(input => Number(input.value)).sort((a, b) => a - b);
}

function layoutCheckItems(name, definitions, selected = [], inputOrders = null) {
  const selectedSet = new Set(selected);
  return definitions.map(field => {
    const orderControl = inputOrders
      ? `<span class="layout-input-order"><b>입력</b><input type="number" min="0" max="999" step="1" inputmode="numeric" data-input-order-field="${esc(field.id)}" value="${Number(inputOrders[field.id] || 0)}" aria-label="${esc(field.label)} Enter 입력 순서" ${field.editable === false ? 'disabled' : ''}></span>`
      : '';
    return `<div class="layout-check"><label class="layout-check__toggle"><input type="checkbox" name="${name}" value="${esc(field.id)}" ${selectedSet.has(field.id) || field.required ? 'checked' : ''} ${field.required ? 'disabled' : ''}><span>${esc(field.label)}</span></label>${field.required ? '<small>필수</small>' : (field.custom ? `<small>${field.valueType === 'NUMBER' ? '숫자형' : '문자형'}</small><button type="button" data-remove-custom-field="${esc(field.id)}" aria-label="${esc(field.label)} 삭제">×</button>` : '')}${orderControl}</div>`;
  }).join('');
}

function layoutChecks(name, definitions, selected = [], grouped = false, inputOrders = null) {
  if (!grouped) return layoutCheckItems(name, definitions, selected, inputOrders);
  return contract.PRODUCT_FIELD_GROUPS.map(group => {
    const fields = definitions.filter(field => (field.group || 'ADDITIONAL') === group.id);
    if (!fields.length) return '';
    return `<section class="layout-field-group" data-product-field-group="${esc(group.id)}"><h4>${esc(group.label)}</h4><div>${layoutCheckItems(name, fields, selected, inputOrders)}</div></section>`;
  }).join('');
}

function selectedLayoutFields(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value);
}

function openLayoutFieldDialog(scope, customFields, onAdd) {
  const isHeader = scope === 'header';
  const fieldDialog = document.createElement('dialog');
  fieldDialog.className = 'smart-dialog smart-field-dialog';
  const definitions = isHeader ? contract.HEADER_FIELD_DEFINITIONS : contract.PRODUCT_FIELD_DEFINITIONS;
  const categoryDefinitions = isHeader
    ? {
        CUSTOMER: definitions.filter(field => ['customer', 'taxCustomer'].includes(field.id)),
        ORDER: definitions.filter(field => !['customer', 'taxCustomer'].includes(field.id))
      }
    : Object.fromEntries(contract.PRODUCT_FIELD_GROUPS.map(group => [
        group.id,
        definitions.filter(field => field.group === group.id)
      ]));
  const productCategoryOptions = contract.PRODUCT_FIELD_GROUPS
    .map(group => `<option value="${esc(group.id)}">${esc(group.label)}</option>`).join('');
  fieldDialog.innerHTML = `<form method="dialog" class="smart-dialog__shell">
    <header><div><small>Form Field Library</small><h2>${isHeader ? '상단 정보열' : '전표 열'} 항목 추가</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-form">
      <label><span>항목 분류</span><select name="category">${isHeader ? '<option value="CUSTOMER">거래처정보</option><option value="ORDER">주문정보</option>' : productCategoryOptions}<option value="CUSTOM">${isHeader ? '사용자지정' : '부가정보 · 사용자지정'}</option></select></label>
      <label data-library-field><span>추가할 항목</span><select name="libraryField"></select></label>
      <label data-custom-type hidden><span>사용자지정 형식</span><select name="customType"><option value="TEXT">문자형 · 최대 10개</option><option value="NUMBER">숫자형 · 최대 10개</option></select></label>
      <label data-custom-label hidden><span>사용자지정 항목명</span><input name="customLabel" maxlength="30" placeholder="예: 배송 요청사항"></label>
    </div>
    <p class="smart-dialog__message">기존 정보 항목을 다시 표시하거나 새 사용자지정 항목을 만들 수 있습니다.</p>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-add>항목 추가</button></footer>
  </form>`;
  document.body.append(fieldDialog);
  const form = fieldDialog.querySelector('form');
  const finish = () => { fieldDialog.close(); fieldDialog.remove(); };
  const syncCategory = () => {
    const custom = form.elements.category.value === 'CUSTOM';
    fieldDialog.querySelector('[data-library-field]').hidden = custom;
    fieldDialog.querySelector('[data-custom-type]').hidden = !custom;
    fieldDialog.querySelector('[data-custom-label]').hidden = !custom;
    if (!custom) {
      form.elements.libraryField.innerHTML = (categoryDefinitions[form.elements.category.value] || [])
        .map(field => `<option value="${esc(field.id)}">${esc(field.label)}</option>`).join('');
    }
    if (custom) form.elements.customLabel.focus();
  };
  form.elements.category.addEventListener('change', syncCategory);
  fieldDialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  fieldDialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  fieldDialog.querySelector('[data-add]').addEventListener('click', () => {
    if (form.elements.category.value !== 'CUSTOM') {
      onAdd({ id: form.elements.libraryField.value, builtIn: true });
      finish();
      return;
    }
    const label = form.elements.customLabel.value.trim();
    if (!label) {
      fieldDialog.querySelector('.smart-dialog__message').textContent = '사용자지정 항목명을 입력하세요.';
      form.elements.customLabel.focus();
      return;
    }
    const valueType = form.elements.customType.value === 'NUMBER' ? 'NUMBER' : 'TEXT';
    const used = customFields.filter(field => field.category === 'CUSTOM' && (field.valueType === 'NUMBER' ? 'NUMBER' : 'TEXT') === valueType).length;
    if (used >= 10) {
      fieldDialog.querySelector('.smart-dialog__message').textContent = `${valueType === 'NUMBER' ? '숫자형' : '문자형'} 사용자지정 항목은 최대 10개까지 만들 수 있습니다.`;
      return;
    }
    onAdd({
      id: `custom-${valueType.toLowerCase()}-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`,
      label,
      scope,
      category: 'CUSTOM',
      sourceField: '',
      valueType
    });
    finish();
  });
  form.addEventListener('submit', event => { event.preventDefault(); fieldDialog.querySelector('[data-add]').click(); });
  fieldDialog.showModal();
  syncCategory();
}

async function openSettingsDialog() {
  const customerId = modeDraft().header.customerId;
  const hasCustomerOverride = customerId && Object.prototype.hasOwnProperty.call(state.settings.deliveryCustomerWeekdays, customerId);
  const customerWeekdays = hasCustomerOverride
    ? state.settings.deliveryCustomerWeekdays[customerId]
    : state.settings.defaultDeliveryWeekdays;
  let workingCustomFields = (state.settings.customFields || []).map(field => ({ ...field }));
  const settingsModeIds = Object.keys(contract.MODES);
  const workingHeaderFieldsByMode = Object.fromEntries(settingsModeIds.map(mode => [mode, [...headerFieldsForMode(mode)]]));
  const workingVoucherColumnsByMode = Object.fromEntries(settingsModeIds.map(mode => [mode, [...voucherColumnsForMode(mode)]]));
  const workingInputOrderByMode = Object.fromEntries(settingsModeIds.map(mode => [
    mode,
    { ...(state.settings.inputOrderByMode?.[mode] || {}) }
  ]));
  let settingsLayoutMode = state.draft.activeMode;
  const settingsModeButtons = scope => settingsModeIds.map(mode => `<button type="button" data-settings-layout-mode="${esc(mode)}" data-settings-layout-scope="${esc(scope)}" class="${mode === settingsLayoutMode ? 'is-active' : ''}" aria-pressed="${mode === settingsLayoutMode}">${esc(contract.MODES[mode].label)}</button>`).join('');
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog smart-settings-dialog';
  dialog.innerHTML = `<form method="dialog" class="smart-dialog__shell">
    <header><div><small>SmartInput Preferences</small><h2>환경설정</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-settings-grid">
      <details class="settings-group" data-settings-group="delivery">
        <summary><span><strong>배송 정책</strong><small>마감시간·배송 요일·휴무일</small></span><i aria-hidden="true"></i></summary>
        <div class="settings-group__body">
          <label><span>당일 주문 마감시간</span><input type="time" name="orderCutoffTime" value="${esc(state.settings.orderCutoffTime)}"><small>미설정이면 마감 제한을 적용하지 않습니다.</small></label>
          <label class="toggle-setting"><input type="checkbox" name="allowSameDayDelivery" ${state.settings.allowSameDayDelivery ? 'checked' : ''}><span>마감시간 전 당일 배송 선택 허용</span></label>
          <fieldset><legend>앱 기본 배송 가능 요일</legend><div class="weekday-grid">${weekdayChecks('defaultDeliveryWeekdays', state.settings.defaultDeliveryWeekdays)}</div></fieldset>
          <fieldset><legend>반복 휴무 요일</legend><div class="weekday-grid">${weekdayChecks('holidayWeekdays', state.settings.holidayWeekdays)}</div></fieldset>
          <label class="smart-settings--wide"><span>지정 휴무일</span><textarea name="holidayDates" rows="3" placeholder="2026-08-24&#10;2026-09-01">${esc(state.settings.holidayDates.join('\n'))}</textarea><small>날짜를 줄바꿈·쉼표로 구분합니다.</small></label>
          <fieldset class="smart-settings--wide" ${customerId ? '' : 'disabled'}><legend>현재 배송처 요일 · ${esc(modeDraft().header.customerName || '거래처 미선택')}</legend>
            <label class="toggle-setting"><input type="checkbox" name="useDefaultCustomerWeekdays" ${hasCustomerOverride ? '' : 'checked'}><span>앱 기본 배송 요일 사용</span></label>
            <div class="weekday-grid" data-customer-weekdays>${weekdayChecks('customerDeliveryWeekdays', customerWeekdays)}</div>
          </fieldset>
        </div>
      </details>
      <details class="settings-group">
        <summary><span><strong>전표별 상단 정보 열</strong><small>전표마다 거래처·배송일·창고 구성을 별도 저장</small></span><i aria-hidden="true"></i></summary>
        <div class="settings-group__body settings-group__body--single"><div class="settings-layout-modes" data-settings-layout-modes="header" aria-label="상단 정보 열을 편집할 전표">${settingsModeButtons('header')}</div><div class="settings-group__actions"><span><b data-settings-layout-label="header">${esc(contract.MODES[settingsLayoutMode].label)}</b> 상단 정보 열을 편집합니다.</span><button type="button" class="button button--quiet button--small" data-add-layout-field="header">항목 추가</button></div><div class="layout-check-grid" data-layout-fields="header"></div></div>
      </details>
      <details class="settings-group">
        <summary><span><strong>전표별 표시 열</strong><small>전표마다 품목·수량·단가 구성을 별도 저장</small></span><i aria-hidden="true"></i></summary>
        <div class="settings-group__body settings-group__body--single"><div class="settings-layout-modes" data-settings-layout-modes="voucher" aria-label="표시 열을 편집할 전표">${settingsModeButtons('voucher')}</div><div class="settings-group__actions"><span><b data-settings-layout-label="voucher">${esc(contract.MODES[settingsLayoutMode].label)}</b> 표시 열을 편집합니다.</span><button type="button" class="button button--quiet button--small" data-add-layout-field="voucher">항목 추가</button></div><div class="layout-check-grid" data-layout-fields="voucher"></div></div>
      </details>
    </div>
    <p class="smart-dialog__message">선택 불가 날짜에는 사유와 다음 배송 가능일을 표시합니다.</p>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-save>설정 저장</button></footer>
  </form>`;
  document.body.append(dialog);
  const deliverySettingsGroup = dialog.querySelector('[data-settings-group="delivery"]');
  if (deliverySettingsGroup) dialog.querySelector('.smart-settings-grid').append(deliverySettingsGroup);
  const form = dialog.querySelector('form');
  const message = dialog.querySelector('.smart-dialog__message');
  const selectedFieldsByScope = scope => scope === 'header'
    ? workingHeaderFieldsByMode
    : workingVoucherColumnsByMode;
  const inputNameByScope = scope => scope === 'header' ? 'headerFields' : 'voucherColumns';
  const captureLayoutSelection = scope => {
    const container = form.querySelector(`[data-layout-fields="${scope}"]`);
    if (!container?.querySelector('input')) return;
    const checked = selectedLayoutFields(form, inputNameByScope(scope));
    const checkedSet = new Set(checked);
    const previous = selectedFieldsByScope(scope)[settingsLayoutMode];
    selectedFieldsByScope(scope)[settingsLayoutMode] = [
      ...previous.filter(fieldId => checkedSet.has(fieldId)),
      ...checked.filter(fieldId => !previous.includes(fieldId))
    ];
  };
  const captureInputOrder = () => {
    const next = { ...(workingInputOrderByMode[settingsLayoutMode] || {}) };
    form.querySelectorAll('[data-layout-fields="voucher"] [data-input-order-field]').forEach(input => {
      next[input.dataset.inputOrderField] = Math.max(0, Math.min(999, Math.round(Number(input.value) || 0)));
    });
    workingInputOrderByMode[settingsLayoutMode] = next;
  };
  const renderLayoutGroup = (scope, selected = null) => {
    const name = inputNameByScope(scope);
    const previous = selected || selectedFieldsByScope(scope)[settingsLayoutMode];
    const sourceDefinitions = layoutDefinitions(scope, workingCustomFields);
    const definitions = scope === 'voucher' ? sourceDefinitions : (() => {
      const priorIndex = new Map(previous.map((fieldId, index) => [fieldId, index]));
      return sourceDefinitions.sort((left, right) => {
        const leftIndex = priorIndex.has(left.id) ? priorIndex.get(left.id) : Number.MAX_SAFE_INTEGER;
        const rightIndex = priorIndex.has(right.id) ? priorIndex.get(right.id) : Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });
    })();
    form.querySelector(`[data-layout-fields="${scope}"]`).innerHTML = layoutChecks(
      name,
      definitions,
      previous,
      scope === 'voucher',
      scope === 'voucher' ? workingInputOrderByMode[settingsLayoutMode] : null
    );
    dialog.querySelector(`[data-settings-layout-label="${scope}"]`).textContent = contract.MODES[settingsLayoutMode].label;
    dialog.querySelectorAll(`[data-settings-layout-modes="${scope}"] [data-settings-layout-mode]`).forEach(button => {
      const active = button.dataset.settingsLayoutMode === settingsLayoutMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };
  const switchSettingsLayoutMode = mode => {
    if (!settingsModeIds.includes(mode) || mode === settingsLayoutMode) return;
    captureLayoutSelection('header');
    captureLayoutSelection('voucher');
    captureInputOrder();
    settingsLayoutMode = mode;
    renderLayoutGroup('header');
    renderLayoutGroup('voucher');
  };
  renderLayoutGroup('header');
  renderLayoutGroup('voucher');
  dialog.querySelectorAll('[data-settings-layout-mode]').forEach(button => button.addEventListener('click', () => {
    switchSettingsLayoutMode(button.dataset.settingsLayoutMode);
  }));
  dialog.querySelectorAll('[data-add-layout-field]').forEach(button => button.addEventListener('click', () => {
    const scope = button.dataset.addLayoutField;
    captureLayoutSelection(scope);
    openLayoutFieldDialog(scope, workingCustomFields, field => {
      const selected = selectedFieldsByScope(scope)[settingsLayoutMode];
      if (!field.builtIn) workingCustomFields.push(field);
      selectedFieldsByScope(scope)[settingsLayoutMode] = [...new Set([...selected, field.id])];
      if (scope === 'voucher' && !Number(workingInputOrderByMode[settingsLayoutMode]?.[field.id])) {
        const nextOrder = Math.max(0, ...Object.values(workingInputOrderByMode[settingsLayoutMode] || {}).map(Number).filter(Number.isFinite)) + 1;
        workingInputOrderByMode[settingsLayoutMode][field.id] = nextOrder;
      }
      renderLayoutGroup(scope);
    });
  }));
  dialog.querySelector('.smart-settings-grid').addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-custom-field]');
    if (!remove) return;
    event.preventDefault();
    const fieldId = remove.dataset.removeCustomField;
    const field = workingCustomFields.find(item => item.id === fieldId);
    if (!field) return;
    captureLayoutSelection(field.scope);
    settingsModeIds.forEach(mode => {
      selectedFieldsByScope(field.scope)[mode] = selectedFieldsByScope(field.scope)[mode].filter(id => id !== fieldId);
      if (field.scope === 'voucher') delete workingInputOrderByMode[mode][fieldId];
    });
    workingCustomFields = workingCustomFields.filter(item => item.id !== fieldId);
    renderLayoutGroup(field.scope);
  });
  const defaultToggle = form.elements.useDefaultCustomerWeekdays;
  const customerWeekdaysElement = dialog.querySelector('[data-customer-weekdays]');
  const syncCustomerWeekdaysState = () => {
    customerWeekdaysElement?.querySelectorAll('input').forEach(input => { input.disabled = !customerId || defaultToggle.checked; });
    customerWeekdaysElement?.classList.toggle('is-disabled', !customerId || defaultToggle.checked);
  };
  defaultToggle?.addEventListener('change', syncCustomerWeekdaysState);
  syncCustomerWeekdaysState();
  const settingGroups = [...dialog.querySelectorAll('.settings-group')];
  settingGroups.forEach(group => group.addEventListener('toggle', () => {
    if (!group.open) return;
    settingGroups.filter(other => other !== group).forEach(other => { other.open = false; });
  }));
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.querySelector('[data-save]').addEventListener('click', async () => {
    const defaultDeliveryWeekdays = selectedWeekdays(form, 'defaultDeliveryWeekdays');
    if (!defaultDeliveryWeekdays.length) {
      message.textContent = '앱 기본 배송 가능 요일을 1개 이상 선택하세요.';
      return;
    }
    const deliveryCustomerWeekdays = { ...state.settings.deliveryCustomerWeekdays };
    if (customerId) {
      if (defaultToggle.checked) delete deliveryCustomerWeekdays[customerId];
      else {
        const customerDays = selectedWeekdays(form, 'customerDeliveryWeekdays');
        if (!customerDays.length) {
          message.textContent = '현재 배송처의 배송 가능 요일을 1개 이상 선택하세요.';
          return;
        }
        deliveryCustomerWeekdays[customerId] = customerDays;
      }
    }
    const holidayDates = String(form.elements.holidayDates.value || '').split(/[\s,;]+/).map(value => value.trim()).filter(Boolean);
    captureLayoutSelection('header');
    captureLayoutSelection('voucher');
    captureInputOrder();
    const next = contract.normalizeSettings({
      ...state.settings,
      orderCutoffTime: form.elements.orderCutoffTime.value,
      allowSameDayDelivery: form.elements.allowSameDayDelivery.checked,
      defaultDeliveryWeekdays,
      deliveryCustomerWeekdays,
      holidayWeekdays: selectedWeekdays(form, 'holidayWeekdays'),
      holidayDates,
      headerFields: workingHeaderFieldsByMode.order,
      voucherColumns: workingVoucherColumnsByMode.order,
      headerFieldsByMode: workingHeaderFieldsByMode,
      voucherColumnsByMode: workingVoucherColumnsByMode,
      inputOrderByMode: workingInputOrderByMode,
      customFields: workingCustomFields,
      columnWidths: { ...(state.settings.columnWidths || {}) },
      columnWidthsByMode: Object.fromEntries(settingsModeIds.map(mode => [
        mode,
        { ...(state.settings.columnWidthsByMode?.[mode] || {}) }
      ]))
    });
    if (holidayDates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
      message.textContent = '지정 휴무일은 YYYY-MM-DD 형식으로 입력하세요.';
      return;
    }
    try {
      await saveSettings(next);
      state.settings = next;
      updateDeliveryPolicy();
      renderRows({ restoreFocus: false });
      saveDraftNow();
      finish();
      toast('환경설정을 저장했습니다.', 'success');
    } catch (error) {
      message.textContent = error.message || '설정을 저장하지 못했습니다.';
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    dialog.querySelector('[data-save]').click();
  });
  dialog.showModal();
}

function estimateTitle(record) {
  return String(record?.catalogName || '').trim() || catalogCustomerName(record) || '견적서명 미지정';
}

function formatEstimateDate(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' }).format(timestamp);
}

function catalogCustomerId(record) {
  return String(record?.customerId || record?.draft?.header?.customerId || '').trim();
}

function catalogCustomerName(record) {
  return String(record?.customerName || record?.draft?.header?.customerName || '').trim();
}

function normalizeEstimateOrder(records = state.estimates) {
  return [...records]
    .sort((left, right) => {
      const leftOrder = Number(left.sortOrder);
      const rightOrder = Number(right.sortOrder);
      if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
      if (Number.isFinite(leftOrder) !== Number.isFinite(rightOrder)) return Number.isFinite(leftOrder) ? -1 : 1;
      return String(left.createdAt || left.updatedAt || '').localeCompare(String(right.createdAt || right.updatedAt || ''));
    })
    .map((record, index) => ({ ...record, sortOrder: index + 1 }));
}

function availableCatalogs() {
  return normalizeEstimateOrder();
}

function individualEstimateRecords() {
  return availableCatalogs().filter(record => record.estimateKind !== 'LINKED_GROUP');
}

function linkedEstimateRecords() {
  return availableCatalogs().filter(record => record.estimateKind === 'LINKED_GROUP');
}

function individualEstimateLinkCount(estimateId) {
  return linkedEstimateRecords().filter(group => (group.linkedEstimateSources || []).some(source => source.estimateId === estimateId)).length;
}

function estimateRecordsForKind(kind = state.estimateLibraryKind) {
  return kind === 'linked' ? linkedEstimateRecords() : individualEstimateRecords();
}

function selectedEstimateRecords(kind = state.estimateLibraryKind) {
  const selectedIds = new Set(state.noticeEstimateIds);
  return estimateRecordsForKind(kind).filter(record => selectedIds.has(record.estimateId));
}

function rememberActiveEstimateWork() {
  if (state.draft.activeMode !== 'estimate') return;
  const current = modeDraft();
  if (!current.catalogRecordId || current.estimateKind === 'COMPOSITION_PREVIEW') return;
  state.estimateWorkingCopies.set(current.catalogRecordId, JSON.parse(JSON.stringify(current)));
}

function estimateRecordDraft(record) {
  return state.estimateWorkingCopies.get(record?.estimateId) || record?.draft || null;
}

function estimateRecordRows(record) {
  return estimateRecordDraft(record)?.rows || [];
}

function estimateProductKey(row) {
  const code = normalizedKey(row?.itemCode);
  if (code) return `CODE:${code}`;
  return `NAME:${normalizedKey(row?.itemName)}|${normalizedKey(row?.specification)}|${normalizedKey(row?.unit)}`;
}

function combinedEstimateRows(records = selectedEstimateRecords()) {
  const seen = new Set();
  const rows = [];
  records.forEach(record => estimateRecordRows(record).forEach(sourceRow => {
    const key = estimateProductKey(sourceRow);
    if (!key || seen.has(key)) return;
    seen.add(key);
    rows.push(contract.normalizeRow({
      ...sourceRow,
      rowId: '',
      batchId: '',
      batchSequence: 0,
      sourceLineNo: 0,
      sourceLineKey: '',
      intakeLineId: '',
      sourceRegion: null,
      rawText: '',
      inputOwnership: 'USER',
      candidateProducts: [],
      editedFields: {}
    }));
  }));
  return rows;
}

function materializeLinkedEstimateRows(records = selectedEstimateRecords('individual')) {
  const uniqueRows = new Map();
  const conflictFields = ['quantity', 'unit', 'unitPrice', 'memo', 'description', 'noticePrice'];
  records.forEach(record => estimateRecordRows(record).forEach(sourceRow => {
    const key = estimateProductKey(sourceRow);
    if (!key) return;
    const ref = { estimateId: record.estimateId, estimateName: estimateTitle(record), rowId: sourceRow.rowId };
    const existing = uniqueRows.get(key);
    if (existing) {
      const detected = conflictFields.filter(field => String(existing[field] ?? '') !== String(sourceRow[field] ?? ''));
      existing.linkedFieldConflicts = [...new Set([...(existing.linkedFieldConflicts || []), ...detected])];
      existing.linkedPriceConflict = existing.linkedFieldConflicts.includes('unitPrice');
      existing.linkedSourceRefs.push(ref);
      existing.linkedSourceEstimateIds.push(record.estimateId);
      existing.linkedSourceEstimateName = `${existing.linkedSourceRefs.length}개 견적서`;
      return;
    }
    uniqueRows.set(key, contract.normalizeRow({
      ...sourceRow,
      rowId: `LINKED:${record.estimateId}:${sourceRow.rowId}`,
      linkedSourceEstimateId: record.estimateId,
      linkedSourceEstimateName: estimateTitle(record),
      linkedSourceRowId: sourceRow.rowId,
      linkedSourceEstimateIds: [record.estimateId],
      linkedSourceRefs: [ref],
      inputOwnership: 'SOURCE',
      editedFields: {},
      linkedFieldConflicts: [],
      linkedConflictResolvedFields: []
    }));
  }));
  return [...uniqueRows.values()];
}

async function flushLinkedRowsToSources() {
  clearTimeout(state.linkedWriteTimer);
  state.linkedWriteTimer = null;
  const current = modeDraft();
  if (state.draft.activeMode !== 'estimate' || current.estimateKind !== 'LINKED_GROUP') return;
  const changedRecords = new Map();
  current.rows.forEach(linkedRow => {
    const synchronizedFields = [...new Set([
      ...Object.keys(linkedRow.editedFields || {}).filter(field => linkedRow.editedFields[field]),
      ...(linkedRow.linkedSyncFields || [])
    ])];
    if (!synchronizedFields.length) return;
    const refs = linkedRow.linkedSourceRefs?.length ? linkedRow.linkedSourceRefs : [{ estimateId: linkedRow.linkedSourceEstimateId, rowId: linkedRow.linkedSourceRowId }];
    refs.forEach(ref => {
      if (!ref.estimateId || !ref.rowId) return;
      const record = changedRecords.get(ref.estimateId)
        || state.estimates.find(item => item.estimateId === ref.estimateId && item.estimateKind !== 'LINKED_GROUP');
      if (!record?.draft?.rows) return;
      const sourceIndex = record.draft.rows.findIndex(row => row.rowId === ref.rowId);
      if (sourceIndex < 0) return;
      const sourceRow = record.draft.rows[sourceIndex];
      const synchronized = { ...sourceRow };
      synchronizedFields.forEach(field => {
        synchronized[field] = field === 'customValues' ? { ...(linkedRow.customValues || {}) } : linkedRow[field];
      });
      record.draft.rows[sourceIndex] = contract.normalizeRow({
        ...synchronized,
        rowId: sourceRow.rowId,
        linkedSourceEstimateId: '', linkedSourceEstimateName: '', linkedSourceRowId: '', linkedSourceEstimateIds: [], linkedSourceRefs: []
      });
      const workingDraft = state.estimateWorkingCopies.get(record.estimateId);
      const workingIndex = workingDraft?.rows?.findIndex(row => row.rowId === ref.rowId) ?? -1;
      if (workingIndex >= 0) {
        const workingRow = workingDraft.rows[workingIndex];
        const workingSynchronized = { ...workingRow };
        synchronizedFields.forEach(field => {
          workingSynchronized[field] = field === 'customValues' ? { ...(linkedRow.customValues || {}) } : linkedRow[field];
        });
        workingDraft.rows[workingIndex] = contract.normalizeRow({
          ...workingSynchronized,
          rowId: workingRow.rowId,
          linkedSourceEstimateId: '', linkedSourceEstimateName: '', linkedSourceRowId: '', linkedSourceEstimateIds: [], linkedSourceRefs: []
        });
      }
      changedRecords.set(record.estimateId, record);
    });
  });
  if (!changedRecords.size) return;
  const timestamp = new Date().toISOString();
  for (const record of changedRecords.values()) {
    const summary = contract.summarizeRows(record.draft.rows);
    record.rowCount = summary.total;
    record.amount = summary.amount;
    record.updatedAt = timestamp;
    record.draft.updatedAt = timestamp;
    await saveEstimate(record);
  }
  current.linkedEstimateSources = (current.linkedEstimateSources || []).map(source => (
    changedRecords.has(source.estimateId) ? { ...source, updatedAt: timestamp } : source
  ));
  state.estimates = normalizeEstimateOrder(state.estimates.map(record => changedRecords.get(record.estimateId) || record));
}

async function flushLinkedIndividualToLibrary() {
  clearTimeout(state.linkedWriteTimer);
  state.linkedWriteTimer = null;
  const current = modeDraft();
  if (state.draft.activeMode !== 'estimate' || current.estimateKind === 'LINKED_GROUP' || !current.catalogRecordId) return;
  if (!individualEstimateLinkCount(current.catalogRecordId)) return;
  const record = state.estimates.find(item => item.estimateId === current.catalogRecordId && item.estimateKind !== 'LINKED_GROUP');
  if (!record) return;
  const timestamp = new Date().toISOString();
  const summary = contract.summarizeRows(current.rows);
  const synchronized = {
    ...record,
    customerId: current.header.customerId,
    customerName: current.header.customerName,
    rowCount: summary.total,
    amount: summary.amount,
    updatedAt: timestamp,
    draft: JSON.parse(JSON.stringify(createCatalogOnlyDraft({ ...current, updatedAt: timestamp }, record.estimateId)))
  };
  synchronized.draft.updatedAt = timestamp;
  await saveEstimate(synchronized);
  state.estimates = normalizeEstimateOrder(state.estimates.map(item => item.estimateId === synchronized.estimateId ? synchronized : item));
}

function queueLinkedRowsWriteThrough() {
  const current = state.draft?.modes?.[state.draft.activeMode];
  if (state.draft.activeMode !== 'estimate') return;
  const linkedGroup = current?.estimateKind === 'LINKED_GROUP';
  const linkedIndividual = !linkedGroup && current?.catalogRecordId && individualEstimateLinkCount(current.catalogRecordId);
  if (!linkedGroup && !linkedIndividual) return;
  clearTimeout(state.linkedWriteTimer);
  state.linkedWriteTimer = window.setTimeout(() => {
    const write = linkedGroup ? flushLinkedRowsToSources() : flushLinkedIndividualToLibrary();
    write.catch(error => {
      setAppStatus('연동 견적서의 원본 반영에 실패했습니다. 현재 입력은 자동저장에 유지됩니다.', 'warn');
      toast(error.message || '연동 원본 반영에 실패했습니다.', 'error');
    });
  }, 220);
}

const VOUCHER_CONTEXT_COPY = Object.freeze({
  order: Object.freeze({ eyebrow: 'LIVE ORDER', title: '주문서 점검', customer: '거래처', date: '배송일자', warehouse: '출하창고', target: 'ORDER Q 주문서 원장' }),
  purchase: Object.freeze({ eyebrow: 'LIVE PURCHASE', title: '구매전표 점검', customer: '구매처', date: '구매일자', warehouse: '입고창고', target: '공식 구매전표 원장' }),
  sale: Object.freeze({ eyebrow: 'LIVE SALE', title: '판매전표 점검', customer: '판매처', date: '판매일자', warehouse: '출하창고', target: '공식 판매전표 원장' })
});

function voucherContextDate(mode, header) {
  const value = mode === 'order' ? header.deliveryDate : (header.voucherDate || header.deliveryDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    return { ready: false, detail: `${VOUCHER_CONTEXT_COPY[mode].date}를 입력하세요.` };
  }
  if (mode !== 'order') return { ready: true, detail: value };
  const decision = contract.validateDeliveryDate({
    deliveryDate: value,
    orderDate: header.orderDate,
    customerId: header.customerId,
    settings: state.settings
  });
  return { ready: decision.valid, detail: decision.valid ? value : decision.message };
}

function voucherConnectionState(mode, delivery = {}) {
  const failed = ['FAILED', 'PARTIAL'].includes(delivery.status);
  if (failed) return { ready: false, error: true, detail: delivery.status === 'PARTIAL' ? '일부 저장 실패 · 남은 전표 유지' : '저장 실패 · 현재 작업 유지' };
  if (mode === 'purchase' && !state.purchaseCapability.ready) return { ready: false, detail: '구매 원장 연결 확인 중 · 자동저장은 유지' };
  if (mode === 'sale' && !state.saleCapability.ready) return { ready: false, detail: '판매 원장 연결 확인 중 · 자동저장은 유지' };
  return { ready: true, detail: VOUCHER_CONTEXT_COPY[mode].target };
}

function voucherContextItem({ target, label, detail, ready, error = false }) {
  const stateLabel = ready ? '완료' : (error ? '오류' : '필요');
  const tone = ready ? 'is-ready' : (error ? 'is-error' : 'is-warning');
  return `<button class="voucher-context-item ${tone}" type="button" data-voucher-focus="${esc(target)}" aria-label="${esc(label)}: ${esc(detail)}">
    <span class="voucher-context-item__dot" aria-hidden="true"></span>
    <span class="voucher-context-item__copy"><strong>${esc(label)}</strong><small>${esc(detail)}</small></span>
    <em class="voucher-context-item__state">${stateLabel}</em><span class="voucher-context-item__arrow" aria-hidden="true">›</span>
  </button>`;
}

function renderVoucherContext(precomputedSummary = null) {
  if (state.draft.activeMode === 'estimate') return;
  const mode = state.draft.activeMode;
  const copy = VOUCHER_CONTEXT_COPY[mode];
  if (!copy) return;
  const current = modeDraft();
  const header = current.header || {};
  const rows = (current.rows || []).filter(rowHasMeaningfulInput);
  const summary = precomputedSummary || contract.summarizeRows(rows);
  const date = voucherContextDate(mode, header);
  const customerReady = Boolean(header.customerId && header.customerName);
  const customerDetail = customerReady
    ? [header.customerCode, header.customerName].filter(Boolean).join(' · ')
    : (header.customerName ? `${header.customerName} · 등록 ${copy.customer} 선택 필요` : `${copy.customer}를 선택하세요.`);
  const warehouseReady = Boolean((header.warehouseId || header.warehouseCode) && header.warehouseName);
  const warehouseDetail = warehouseReady
    ? [header.warehouseCode, header.warehouseName].filter(Boolean).join(' · ')
    : (header.warehouseName ? `${header.warehouseName} · 기준정보 선택 필요` : `${copy.warehouse}를 선택하세요.`);
  const rowsReady = rows.length > 0;
  const unresolved = summary.unresolved;
  const needsReview = summary.similar + unresolved + summary.duplicate;
  const reviewReady = rowsReady && needsReview === 0;
  const reviewDetail = rowsReady
    ? `일치 ${summary.matched} · 확인 ${summary.similar} · 미등록 ${unresolved} · 중복 ${summary.duplicate}`
    : '상품 입력 후 자동 점검합니다.';
  const connection = voucherConnectionState(mode, current.delivery || {});
  const checks = [
    { target: 'customer', label: copy.customer, detail: customerDetail, ready: customerReady },
    { target: 'date', label: copy.date, detail: date.detail, ready: date.ready },
    { target: 'warehouse', label: copy.warehouse, detail: warehouseDetail, ready: warehouseReady },
    { target: 'rows', label: '입력 상품', detail: rowsReady ? `${rows.length.toLocaleString('ko-KR')}개 품목 · 수량 ${summary.quantity.toLocaleString('ko-KR')}` : '상품을 1개 이상 입력하세요.', ready: rowsReady },
    { target: 'review', label: '상품 검토', detail: reviewDetail, ready: reviewReady, error: unresolved > 0 },
    { target: 'save', label: '저장소 연결', detail: connection.detail, ready: connection.ready, error: connection.error }
  ];
  const completed = checks.filter(check => check.ready).length;
  const ready = completed === checks.length;
  const progress = Math.round((completed / checks.length) * 100);
  $('voucherContextEyebrow').textContent = copy.eyebrow;
  $('voucherContextTitle').textContent = copy.title;
  $('voucherContextSummary').textContent = rows.length
    ? `${header.transactionType || '기타'} · ${rows.length.toLocaleString('ko-KR')}개 품목`
    : '입력과 동시에 저장 준비 상태를 확인합니다.';
  const progressElement = document.querySelector('.voucher-context-progress');
  progressElement.classList.toggle('is-ready', ready);
  $('voucherReadyState').textContent = ready ? '저장 가능' : `${completed}/${checks.length} 완료`;
  $('voucherReadyProgress').style.width = `${progress}%`;
  $('voucherContextList').innerHTML = checks.map(voucherContextItem).join('');
  $('voucherContextAmount').textContent = `${summary.amount.toLocaleString('ko-KR')}원`;
  $('voucherContextDelivery').textContent = $('deliveryState').textContent || '전달 전';
}

function relatedPanelButtonLabel(open = false) {
  const label = state.draft.activeMode === 'estimate'
    ? '견적서 목록'
    : `${contract.MODES[state.draft.activeMode].label} 점검`;
  return `${label} ${open ? '닫기' : '열기'}`;
}

function focusVoucherContextTarget(target) {
  if (target === 'customer') return $('customerInput').focus();
  if (target === 'date') return $('deliveryDateInput').focus();
  if (target === 'warehouse') return $('warehouseInput').focus();
  if (target === 'save') return $('completeButton').focus();
  const rows = modeDraft().rows.filter(rowHasMeaningfulInput);
  const row = target === 'review'
    ? rows.find(item => item.matchStatus !== 'MATCHED' || item.duplicatePossible)
    : rows[0];
  const rowId = row?.rowId || DEFAULT_INPUT_ROW_ID;
  state.gridSearch = '';
  $('gridSearchInput').value = '';
  renderRows({ restoreFocus: false });
  window.requestAnimationFrame(() => {
    const input = gridInput(rowId, 'productSearch');
    if (!input) return;
    modeUi().activeCellId = `${rowId}|productSearch`;
    input.focus({ preventScroll: true });
    revealGridInput(input);
  });
}

function renderEstimateWorkspace() {
  const estimateMode = state.draft.activeMode === 'estimate';
  const library = $('estimateLibraryView');
  library.hidden = false;
  library.setAttribute('aria-label', estimateMode ? '견적서 목록' : `${contract.MODES[state.draft.activeMode].label} 작업 점검`);
  $('voucherContextView').hidden = estimateMode;
  $('estimateLibraryHeading').hidden = !estimateMode;
  $('catalogComposeArea').hidden = !estimateMode;
  $('estimateEditorView').hidden = false;
  const linkedList = state.estimateLibraryKind === 'linked';
  $('catalogPickerList').hidden = !estimateMode || linkedList;
  $('linkedEstimateList').hidden = !estimateMode || !linkedList;
  $('estimateLibrarySwitchButton').hidden = !estimateMode;
  $('estimateLibrarySwitchButton').classList.toggle('is-linked', linkedList);
  $('estimateLibrarySwitchButton').setAttribute('aria-label', linkedList ? '견적서 목록으로 전환' : '연동견적서 목록으로 전환');
  $('estimateLibrarySwitchButton').setAttribute('aria-pressed', String(linkedList));
  $('estimateLibrarySummary').textContent = linkedList
    ? '연결된 원본 견적서를 유지하며 수정값을 양방향으로 반영합니다. 카드 본문은 선택, 이동 핸들은 순서 변경입니다.'
    : '카드 본문을 터치하면 즉시 선택·합성되고, 이동 핸들로 목록 순서를 변경합니다.';
  parserCard.hidden = false;
}

function estimateCardMarkup(record) {
  const selected = state.noticeEstimateIds.includes(record.estimateId);
  const linked = record.estimateKind === 'LINKED_GROUP';
  const linkedCount = linked ? (record.linkedEstimateSources?.length || 0) : individualEstimateLinkCount(record.estimateId);
  const linkedBadge = linkedCount ? `<em class="linked-estimate-badge">연동 ${linkedCount}</em>` : '';
  return `<article class="catalog-picker__row estimate-card ${selected ? 'is-selected' : ''}" data-estimate-kind="${linked ? 'LINKED_GROUP' : 'INDIVIDUAL'}" data-estimate-id="${esc(record.estimateId)}">
    <button class="catalog-picker__load" type="button" data-select-estimate-card aria-pressed="${selected}" title="${esc(estimateTitle(record))} · 터치해 ${selected ? '선택 해제' : '선택 및 표시'}"><strong>${esc(estimateTitle(record))}${linkedBadge}</strong><small>작성 ${esc(formatEstimateDate(record.createdAt))} · 수정 ${esc(formatEstimateDate(record.updatedAt))}</small></button>
    <button class="estimate-card__drag-handle" type="button" draggable="true" data-estimate-drag-handle aria-label="${esc(estimateTitle(record))} 순서 이동" title="끌어서 순서 이동"><span aria-hidden="true">⠿</span></button>
  </article>`;
}

function renderCatalogControls() {
  const visible = state.draft.activeMode === 'estimate';
  if (!visible) {
    $('catalogPickerList').innerHTML = '<div class="smart-dialog__empty">견적서 모드에서 개별 견적서를 관리합니다.</div>';
    $('linkedEstimateList').innerHTML = '';
    return;
  }
  state.estimates = normalizeEstimateOrder();
  const records = individualEstimateRecords();
  const linkedRecords = linkedEstimateRecords();
  const availableIds = new Set(estimateRecordsForKind().map(record => record.estimateId));
  state.noticeEstimateIds = state.noticeEstimateIds.filter(estimateId => availableIds.has(estimateId));
  const selectedCount = state.noticeEstimateIds.length;
  $('catalogPickerList').innerHTML = records.length ? records.map(estimateCardMarkup).join('') : '<div class="smart-dialog__empty">저장된 견적서가 없습니다. 입력표를 작성하고 저장하면 자동 생성됩니다.</div>';
  $('linkedEstimateList').innerHTML = linkedRecords.length ? linkedRecords.map(estimateCardMarkup).join('') : '<div class="smart-dialog__empty">생성된 연동견적서가 없습니다.</div>';
  $('estimateSelectionSummary').textContent = `${selectedCount.toLocaleString('ko-KR')}개 선택`;
  $('estimateRenameButton').disabled = state.busy || selectedCount !== 1;
  $('estimateCreateButton').hidden = state.estimateLibraryKind === 'linked';
  $('estimateCreateButton').disabled = state.busy || selectedCount < 1;
  $('selectedEstimateDeleteButton').disabled = state.busy || selectedCount < 1;
  $('selectedEstimateDeleteButton').textContent = selectedCount ? `선택 삭제 (${selectedCount})` : '선택 삭제';
  renderEstimateWorkspace();
}

function prepareGeneratedEstimateDraft(kind) {
  const records = selectedEstimateRecords('individual');
  if (!records.length) return toast('생성에 사용할 견적서를 선택하세요.', 'error');
  const rows = kind === 'LINKED_GROUP' ? materializeLinkedEstimateRows(records) : combinedEstimateRows(records);
  if (!rows.length) return toast('선택한 견적서에 생성할 상품이 없습니다.', 'error');
  const fallback = contract.createDraft().modes.estimate;
  fallback.activeMethod = 'direct';
  fallback.rows = rows;
  fallback.catalogRecordId = '';
  fallback.catalogBaselinePrices = {};
  fallback.catalogPreviousPrices = {};
  fallback.estimateKind = kind;
  fallback.linkedEstimateSources = kind === 'LINKED_GROUP' ? records.map(record => ({
    estimateId: record.estimateId,
    catalogName: estimateTitle(record),
    updatedAt: record.updatedAt || ''
  })) : [];
  if (records.length === 1 && kind === 'INDIVIDUAL') {
    fallback.header = { ...fallback.header, ...(estimateRecordDraft(records[0])?.header || {}), submittedAt: '' };
  } else {
    clearCustomerAfterSave(fallback.header);
  }
  state.draft.modes.estimate = fallback;
  state.noticeEstimateIds = [];
  state.estimateSelectionReturnDraft = null;
  state.selectedRowIds.clear();
  saveDraftNow();
  renderMode();
  openEstimateSaveDialog();
}

function openEstimateCreateChoiceDialog() {
  const records = selectedEstimateRecords('individual');
  if (!records.length) return toast('생성에 사용할 견적서를 선택하세요.', 'error');
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog estimate-create-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Estimate Create</small><h2>견적서 생성 방식</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="estimate-create-options">
      <button type="button" data-create-kind="INDIVIDUAL"><strong>개별 견적서</strong><span>선택한 내용을 독립된 새 견적서로 복사합니다.</span></button>
      <button type="button" data-create-kind="LINKED_GROUP"><strong>연동 견적서</strong><span>${records.length === 1 ? '원본 한 개의 연동 사본을 만들고' : `${records.length}개 원본을 묶고`} 이후 수정값을 양방향 반영합니다.</span></button>
    </div>
    <footer><button type="button" class="button button--quiet" data-close>취소</button></footer>
  </div>`;
  document.body.append(dialog);
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.querySelectorAll('[data-create-kind]').forEach(button => button.addEventListener('click', () => {
    const kind = button.dataset.createKind;
    finish();
    prepareGeneratedEstimateDraft(kind);
  }));
  dialog.showModal();
  dialog.querySelector('[data-create-kind]')?.focus();
}

function previewSelectedEstimates() {
  const records = selectedEstimateRecords();
  if (!records.length) {
    const returnDraft = state.estimateSelectionReturnDraft;
    state.estimateSelectionReturnDraft = null;
    if (returnDraft) state.draft.modes.estimate = contract.normalizeModeDraft('estimate', returnDraft);
    else state.draft.modes.estimate = contract.createDraft().modes.estimate;
    state.selectedRowIds.clear();
    saveDraftNow();
    renderMode();
    return;
  }
  if (records.length === 1) {
    loadCatalogRecord(records[0], { preserveSelection: true });
    return;
  }
  const fallback = contract.createDraft().modes.estimate;
  fallback.activeMethod = 'direct';
  fallback.estimateKind = 'COMPOSITION_PREVIEW';
  fallback.linkedEstimateSources = records.map(record => ({ estimateId: record.estimateId, catalogName: estimateTitle(record), updatedAt: record.updatedAt || '' }));
  fallback.rows = state.estimateLibraryKind === 'linked' ? combinedEstimateRows(records) : materializeLinkedEstimateRows(records);
  clearCustomerAfterSave(fallback.header);
  state.draft.modes.estimate = fallback;
  state.selectedRowIds.clear();
  saveDraftNow();
  renderMode();
  toast(`${records.length}개 견적서 · 중복 제거 ${fallback.rows.length}개 상품을 표시합니다.`, 'success');
}

async function deleteSelectedEstimates() {
  const records = selectedEstimateRecords();
  if (!records.length) return toast('삭제할 견적서를 선택하세요.', 'error');
  const selectedIds = new Set(records.map(record => record.estimateId));
  const linkedUsage = state.estimateLibraryKind === 'individual'
    ? linkedEstimateRecords().filter(group => (group.linkedEstimateSources || []).some(source => selectedIds.has(source.estimateId)))
    : [];
  if (linkedUsage.length) {
    return toast(`선택한 견적서는 ${linkedUsage.length}개 연동견적서에서 사용 중입니다. 연동 구성을 먼저 변경하세요.`, 'error');
  }
  if (records.length > 1 && !window.confirm(`선택한 견적서 ${records.length}개를 삭제하시겠습니까?`)) return;
  const results = await Promise.allSettled(records.map(record => deleteEstimate(record.estimateId)));
  const deletedIds = new Set(records.filter((_, index) => results[index].status === 'fulfilled').map(record => record.estimateId));
  const failedIds = records.filter(record => !deletedIds.has(record.estimateId)).map(record => record.estimateId);
  if (deletedIds.size) {
    try {
      await persistEstimateLibrary(state.estimates.filter(record => !deletedIds.has(record.estimateId)));
    } catch (error) {
      toast(error.message || '삭제 후 견적서 목록을 갱신하지 못했습니다.', 'error');
      return;
    }
    state.noticeEstimateIds = failedIds;
    deletedIds.forEach(estimateId => state.estimateWorkingCopies.delete(estimateId));
    if (deletedIds.has(modeDraft().catalogRecordId)) startNewCatalog();
    else renderCatalogControls();
  }
  if (failedIds.length) {
    toast(`${deletedIds.size}개 삭제 · ${failedIds.length}개 실패. 실패한 견적서는 선택 상태로 유지됩니다.`, 'error');
    return;
  }
  toast(`견적서 ${deletedIds.size}개를 삭제했습니다.`, 'success');
}

async function persistEstimateLibrary(records = state.estimates) {
  state.estimates = records.map((record, index) => ({ ...record, sortOrder: index + 1 }));
  await Promise.all(state.estimates.map(record => saveEstimate(record)));
}

function estimateCardId(card) {
  return card?.dataset.estimateId || card?.dataset.linkedEstimateId || '';
}

function beginEstimateCardDrag(event) {
  const handle = event.target.closest('[data-estimate-drag-handle]');
  const card = handle?.closest('.estimate-card');
  if (!card) return event.preventDefault();
  const payload = { estimateId: estimateCardId(card), kind: card.dataset.estimateKind };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/json', JSON.stringify(payload));
  card.classList.add('is-dragging');
}

function moveEstimateCardDrag(event) {
  const card = event.target.closest('.estimate-card');
  if (!card || card.classList.contains('is-dragging')) return;
  event.preventDefault();
  state.estimateDragSuppressed = true;
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.estimate-card.is-drop-target').forEach(item => item.classList.remove('is-drop-target'));
  card.classList.add('is-drop-target');
}

async function finishEstimateCardDrop(event) {
  const target = event.target.closest('.estimate-card');
  if (!target) return;
  event.preventDefault();
  let payload;
  try { payload = JSON.parse(event.dataTransfer.getData('application/json')); } catch (_) { return; }
  await persistEstimateCardOrder(payload, target);
}

async function persistEstimateCardOrder(payload, target) {
  const targetId = estimateCardId(target);
  if (!payload?.estimateId || payload.estimateId === targetId || payload.kind !== target.dataset.estimateKind) return false;
  const sourceRecords = payload.kind === 'LINKED_GROUP' ? linkedEstimateRecords() : individualEstimateRecords();
  const from = sourceRecords.findIndex(record => record.estimateId === payload.estimateId);
  const to = sourceRecords.findIndex(record => record.estimateId === targetId);
  if (from < 0 || to < 0) return false;
  const reordered = [...sourceRecords];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  const next = payload.kind === 'LINKED_GROUP'
    ? [...individualEstimateRecords(), ...reordered]
    : [...reordered, ...linkedEstimateRecords()];
  await persistEstimateLibrary(next);
  renderCatalogControls();
  toast('견적서 카드 순서를 변경했습니다.', 'success');
  return true;
}

function clearEstimateCardDrag() {
  document.querySelectorAll('.estimate-card.is-dragging, .estimate-card.is-drop-target').forEach(card => card.classList.remove('is-dragging', 'is-drop-target'));
  state.estimateDragSuppressed = false;
}

function beginEstimateTouchDrag(event) {
  if (event.touches?.length !== 1) return;
  const handle = event.target.closest('[data-estimate-drag-handle]');
  const card = handle?.closest('.estimate-card');
  if (!card) return;
  const touch = event.touches[0];
  const drag = {
    card,
    estimateId: estimateCardId(card),
    kind: card.dataset.estimateKind,
    startX: touch.clientX,
    startY: touch.clientY,
    lastX: touch.clientX,
    lastY: touch.clientY,
    active: false,
    timer: null
  };
  drag.timer = window.setTimeout(() => {
    if (state.estimateTouchDrag !== drag) return;
    drag.active = true;
    state.estimateDragSuppressed = true;
    drag.card.classList.add('is-dragging');
    drag.card.setAttribute('aria-grabbed', 'true');
  }, 260);
  state.estimateTouchDrag = drag;
}

function moveEstimateTouchDrag(event) {
  const drag = state.estimateTouchDrag;
  const touch = event.touches?.[0];
  if (!drag || !touch) return;
  drag.lastX = touch.clientX;
  drag.lastY = touch.clientY;
  if (!drag.active) {
    if (Math.hypot(touch.clientX - drag.startX, touch.clientY - drag.startY) > 9) {
      clearTimeout(drag.timer);
      state.estimateTouchDrag = null;
    }
    return;
  }
  event.preventDefault();
  const target = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.estimate-card');
  document.querySelectorAll('.estimate-card.is-drop-target').forEach(item => item.classList.remove('is-drop-target'));
  if (target && target !== drag.card && target.dataset.estimateKind === drag.kind) target.classList.add('is-drop-target');
}

async function finishEstimateTouchDrag(event) {
  const drag = state.estimateTouchDrag;
  if (!drag) return;
  clearTimeout(drag.timer);
  state.estimateTouchDrag = null;
  if (!drag.active) return;
  event.preventDefault();
  const touch = event.changedTouches?.[0];
  const target = touch && document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.estimate-card');
  try {
    if (target) await persistEstimateCardOrder({ estimateId: drag.estimateId, kind: drag.kind }, target);
  } finally {
    drag.card.removeAttribute('aria-grabbed');
    document.querySelectorAll('.estimate-card.is-dragging, .estimate-card.is-drop-target').forEach(card => card.classList.remove('is-dragging', 'is-drop-target'));
    window.setTimeout(() => { state.estimateDragSuppressed = false; }, 120);
  }
}

function cancelEstimateTouchDrag() {
  const drag = state.estimateTouchDrag;
  if (!drag) return;
  clearTimeout(drag.timer);
  state.estimateTouchDrag = null;
  drag.card.removeAttribute('aria-grabbed');
  drag.card.classList.remove('is-dragging');
  document.querySelectorAll('.estimate-card.is-drop-target').forEach(card => card.classList.remove('is-drop-target'));
  state.estimateDragSuppressed = false;
}

function openSelectedEstimateRenameDialog() {
  const [record] = selectedEstimateRecords();
  if (!record) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog estimate-rename-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Estimate Rename</small><h2>견적서명 변경</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-dialog__message">선택한 견적서의 이름만 변경합니다. 내용과 연동 관계는 그대로 유지됩니다.</div>
    <div class="estimate-dialog-form">
      <label><span>견적서명</span><input type="text" data-estimate-name maxlength="80" value="${esc(estimateTitle(record))}"></label>
    </div>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-save-estimate>변경</button></footer>
  </div>`;
  document.body.append(dialog);
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.querySelector('[data-save-estimate]').addEventListener('click', async () => {
    const catalogName = dialog.querySelector('[data-estimate-name]').value.trim();
    if (!catalogName) {
      dialog.querySelector('[data-estimate-name]').focus();
      return toast('견적서명을 입력하세요.', 'error');
    }
    const duplicate = state.estimates.find(item => item.estimateId !== record.estimateId && estimateTitle(item) === catalogName);
    if (duplicate) return toast('같은 이름의 견적서가 있습니다. 다른 이름을 입력하세요.', 'error');
    const timestamp = new Date().toISOString();
    const next = state.estimates.map(item => {
      if (item.estimateId === record.estimateId) return { ...item, catalogName, updatedAt: timestamp };
      if (item.estimateKind !== 'LINKED_GROUP') return item;
      const linkedEstimateSources = (item.linkedEstimateSources || []).map(source => source.estimateId === record.estimateId ? { ...source, catalogName } : source);
      return { ...item, linkedEstimateSources };
    });
    try {
      await persistEstimateLibrary(next);
      finish();
      renderCatalogControls();
      renderEstimateHeaderFields();
      toast('견적서명을 변경했습니다.', 'success');
    } catch (error) {
      toast(error.message || '견적서명을 변경하지 못했습니다.', 'error');
    }
  });
  dialog.showModal();
  dialog.querySelector('[data-estimate-name]').focus();
  dialog.querySelector('[data-estimate-name]').select();
}

function restoreSourceImageForMode(mode) {
  const documentId = state.draft.modes[mode]?.documentId;
  state.sourceImages[mode] = state.sourceImageRecords.get(documentId) || null;
}

function createCatalogOnlyDraft(source = {}, catalogRecordId = '') {
  const fallback = contract.createDraft().modes.estimate;
  const rows = (source.rows || []).map(row => contract.normalizeRow({
    ...row,
    batchId: '',
    batchSequence: 0,
    sourceLineNo: 0,
    sourceLineKey: '',
    intakeLineId: '',
    sourceRegion: null,
    rawText: '',
    candidateProducts: [],
    editedFields: {}
  }));
  return contract.normalizeModeDraft('estimate', {
    ...source,
    documentId: fallback.documentId,
    catalogRecordId,
    header: {
      ...(source.header || {}),
      submittedAt: '',
      rawOrdererName: '',
      aliasMappingId: '',
      customerMappingSource: 'CATALOG'
    },
    sourceText: '',
    activeMethod: 'direct',
    batches: [],
    rows,
    delivery: { ...fallback.delivery }
  });
}

function loadCatalogRecord(record, { preserveSelection = false } = {}) {
  if (!record?.draft) return;
  syncSourceText();
  state.draft.activeMode = 'estimate';
  const recordDraft = estimateRecordDraft(record);
  const linkedRecords = record.estimateKind === 'LINKED_GROUP'
    ? (record.linkedEstimateSources || []).map(source => state.estimates.find(item => item.estimateId === source.estimateId)).filter(Boolean)
    : [];
  const draftSource = record.estimateKind === 'LINKED_GROUP'
    ? { ...recordDraft, estimateKind: 'LINKED_GROUP', linkedEstimateSources: record.linkedEstimateSources || [], rows: [...materializeLinkedEstimateRows(linkedRecords), ...manualLinkedRows(recordDraft?.rows)] }
    : recordDraft;
  const catalogDraft = createCatalogOnlyDraft(draftSource, record.estimateId);
  catalogDraft.catalogBaselinePrices = buildCatalogPriceSnapshot(catalogDraft.rows);
  catalogDraft.catalogPreviousPrices = record.previousPrices && typeof record.previousPrices === 'object'
    ? { ...record.previousPrices }
    : { ...(catalogDraft.catalogPreviousPrices || {}) };
  const linkedCustomer = record.estimateKind === 'LINKED_GROUP' ? null : customerById(catalogCustomerId(record));
  catalogDraft.header.customerId = linkedCustomer?.customerId || (record.estimateKind === 'LINKED_GROUP' ? '' : catalogCustomerId(record));
  catalogDraft.header.customerName = customerName(linkedCustomer) || (record.estimateKind === 'LINKED_GROUP' ? '' : catalogCustomerName(record));
  catalogDraft.header.customerMappingSource = 'CATALOG';
  state.draft.modes.estimate = catalogDraft;
  state.sourceImages.estimate = null;
  state.selectedRowIds.clear();
  if (!preserveSelection) state.noticeEstimateIds = [];
  clearTimeout(state.autoAnalyzeTimer);
  state.analysisRequestId += 1;
  state.pendingImageEvidence = null;
  state.pendingOcrReview = null;
  state.pendingSourceName = '';
  state.pendingStructuredImport = null;
  setActiveActivity('');
  resetPhotoView();
  saveDraftNow();
  renderMode();
  if (record.estimateKind === 'LINKED_GROUP') {
    $('customerHint').textContent = '연동견적서는 각 개별 견적서의 거래처를 유지합니다.';
  } else if (catalogDraft.header.customerId) {
    $('customerHint').textContent = '견적서에 연결된 배송 거래처가 자동 지정되었습니다.';
  }
  toast(record.estimateKind === 'LINKED_GROUP'
    ? `${estimateTitle(record)} 연동견적서를 불러왔습니다.`
    : `${estimateTitle(record)}과 배송 거래처를 불러왔습니다.`, 'success');
}

function startNewCatalog() {
  const current = modeDraft();
  const fallback = contract.createDraft().modes.estimate;
  fallback.header = { ...fallback.header, ...current.header, customValues: { ...(current.header.customValues || {}) } };
  fallback.activeMethod = 'direct';
  fallback.catalogBaselinePrices = {};
  fallback.catalogPreviousPrices = {};
  fallback.estimateKind = 'INDIVIDUAL';
  fallback.linkedEstimateSources = [];
  state.draft.modes.estimate = fallback;
  state.noticeEstimateIds = [];
  state.estimateSelectionReturnDraft = null;
  state.sourceImages.estimate = null;
  state.selectedRowIds.clear();
  resetPhotoView();
  activatePendingReferences({ explicit: false, render: false });
  saveDraftNow();
  renderMode();
  window.requestAnimationFrame(() => inputRows.querySelector('[data-product-search]')?.focus());
}

async function rematchRowsForCustomer(customer) {
  const current = modeDraft();
  const before = current.rows.map(row => ({ ...row, editedFields: { ...(row.editedFields || {}) } }));
  try {
    setAppStatus(`${customerName(customer)} 기준으로 상품을 다시 매칭하고 있습니다.`);
    const matched = await rematchExtractedLinesForCustomer(before, customer, 'SMART_INPUT');
    current.rows = matched.map((line, index) => {
      const previous = before[index];
      const next = contract.normalizeRow({ ...previous, ...line, rowId: previous.rowId, editedFields: previous.editedFields });
      contract.ROW_FIELDS.forEach(field => {
        if (previous.editedFields?.[field]) next[field] = previous[field];
      });
      return enrichRowFromUnifiedCatalog(next);
    });
    current.rows = contract.markDuplicatePossibilities(current.rows);
    renderRows();
    saveDraftNow();
    const summary = contract.summarizeRows(current.rows);
    setAppStatus(`${customerName(customer)} 재매칭 완료 · 일치 ${summary.matched} · 확인 ${summary.similar} · 미인식 ${summary.unresolved}`);
  } catch (error) {
    setAppStatus('상품 재매칭을 완료하지 못했습니다. 현재 수정값은 유지됩니다.', 'warn');
    toast(error.message || '상품 재매칭에 실패했습니다.', 'error');
  }
}

function renderWarehouseOptions() {
  $('warehouseOptions').innerHTML = state.warehouseCatalog.warehouses.map(warehouse => {
    const label = [warehouse.warehouseCode, warehouse.warehouseName].filter(Boolean).join(' · ');
    return `<option value="${esc(warehouseDisplayName(warehouse))}" label="${esc(label)}"></option>`;
  }).join('');
}

function applyWarehouseMatch() {
  const value = $('warehouseInput').value;
  const match = matchWarehouseInput({ warehouse: value }, state.warehouseCatalog.warehouses, state.warehouseCatalog.aliases);
  const header = modeDraft().header;
  header.warehouseId = match?.warehouseId || '';
  header.warehouseCode = match?.warehouseCode || '';
  header.warehouseName = match ? warehouseDisplayName(match) : value.trim();
  renderVoucherContext();
  scheduleSave();
}

function hydrateHeader() {
  const header = modeDraft().header;
  $('customerInput').value = header.customerName;
  $('customerInput').dataset.customerId = header.customerId;
  $('deliveryDateInput').value = state.draft.activeMode === 'order' || state.draft.activeMode === 'estimate'
    ? header.deliveryDate
    : (header.voucherDate || header.deliveryDate);
  $('warehouseInput').value = header.warehouseName;
  $('transactionTypeInput').value = header.transactionType || '기타';
  $('customerHint').textContent = header.customerId ? '등록 거래처 · 마스터 연결됨' : '거래처가 인식되지 않으면 이 입력란으로 이동합니다.';
  applyCustomerRelationship(header);
  updateDeliveryPolicy();
}

function renderEstimateHeaderFields() {
  const estimateMode = state.draft.activeMode === 'estimate';
  const warehouseField = document.querySelector('[data-header-field="warehouse"]');
  const transactionField = document.querySelector('[data-header-field="transactionType"]');
  const warehouseInput = $('warehouseInput');
  const transactionInput = $('transactionTypeInput');
  warehouseField.hidden = false;
  transactionField.hidden = false;
  transactionField.classList.toggle('is-layout-placeholder', estimateMode);
  transactionField.setAttribute('aria-hidden', String(estimateMode));
  warehouseInput.readOnly = estimateMode;
  warehouseInput.disabled = estimateMode;
  transactionInput.disabled = estimateMode;
  if (!estimateMode) {
    warehouseInput.setAttribute('list', 'warehouseOptions');
    warehouseInput.placeholder = '창고명·코드';
    return;
  }
  const record = state.estimates.find(item => item.estimateId === modeDraft().catalogRecordId);
  warehouseField.querySelector('span').textContent = '최종수정일';
  warehouseInput.removeAttribute('list');
  warehouseInput.placeholder = '저장 전';
  warehouseInput.value = record?.updatedAt ? referenceTimeText(record.updatedAt) : '저장 전';
}

function cloneGridValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function syncGridPasteUndoButton() {
  const button = $('undoGridPasteButton');
  if (!button) return;
  button.disabled = state.gridPasteUndo?.mode !== state.draft.activeMode;
}

function invalidateGridPasteUndo() {
  if (state.applyingGridPaste || !state.gridPasteUndo) return;
  state.gridPasteUndo = null;
  syncGridPasteUndoButton();
}

function captureGridPasteUndo() {
  const current = modeDraft();
  state.gridPasteUndo = {
    mode: state.draft.activeMode,
    rows: cloneGridValue(current.rows),
    batches: cloneGridValue(current.batches),
    selectedRowIds: [...state.selectedRowIds],
    activeCellId: modeUi().activeCellId || ''
  };
  syncGridPasteUndoButton();
}

function undoGridPaste() {
  const snapshot = state.gridPasteUndo;
  if (!snapshot || snapshot.mode !== state.draft.activeMode) return;
  const current = modeDraft();
  current.rows = snapshot.rows.map(row => contract.normalizeRow(row));
  current.batches = cloneGridValue(snapshot.batches);
  state.selectedRowIds = new Set(snapshot.selectedRowIds);
  modeUi().activeCellId = snapshot.activeCellId;
  state.gridPasteUndo = null;
  renderRows();
  saveDraftNow();
  syncGridPasteUndoButton();
  toast('Excel 붙여넣기를 취소했습니다.', 'success');
}

function syncRowSelectionControls() {
  const rowIds = modeDraft().rows.map(row => row.rowId);
  state.selectedRowIds = new Set([...state.selectedRowIds].filter(rowId => rowIds.includes(rowId)));
  const selectedCount = state.selectedRowIds.size;
  const selectAll = $('selectAllRows');
  selectAll.checked = Boolean(rowIds.length && selectedCount === rowIds.length);
  selectAll.indeterminate = selectedCount > 0 && selectedCount < rowIds.length;
  selectAll.disabled = !rowIds.length;
  $('deleteSelectedRows').disabled = !selectedCount;
}

async function deleteSelectedGridRows() {
  if (!state.selectedRowIds.size) return;
  invalidateGridPasteUndo();
  const linkedRows = modeDraft().rows.filter(row => state.selectedRowIds.has(row.rowId) && (row.linkedSourceRefs?.length || (row.linkedSourceEstimateId && row.linkedSourceRowId)));
  if (linkedRows.length) {
    const removals = new Map();
    linkedRows.forEach(row => (row.linkedSourceRefs?.length ? row.linkedSourceRefs : [{ estimateId: row.linkedSourceEstimateId, rowId: row.linkedSourceRowId }]).forEach(ref => {
      removals.set(ref.estimateId, new Set([...(removals.get(ref.estimateId) || []), ref.rowId]));
    }));
    const timestamp = new Date().toISOString();
    for (const [estimateId, rowIds] of removals) {
      const record = state.estimates.find(item => item.estimateId === estimateId && item.estimateKind !== 'LINKED_GROUP');
      if (!record?.draft?.rows) continue;
      record.draft.rows = record.draft.rows.filter(row => !rowIds.has(row.rowId));
      const summary = contract.summarizeRows(record.draft.rows);
      record.rowCount = summary.total;
      record.amount = summary.amount;
      record.updatedAt = timestamp;
      record.draft.updatedAt = timestamp;
      await saveEstimate(record);
    }
  }
  modeDraft().rows = modeDraft().rows.filter(row => !state.selectedRowIds.has(row.rowId));
  modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
  state.selectedRowIds.clear();
  renderRows();
  saveDraftNow();
  toast(linkedRows.length ? '선택한 연동 행을 원본 견적서에서도 삭제했습니다.' : '선택한 품목을 삭제했습니다.', 'success');
}

function renderRows({ restoreFocus = true } = {}) {
  pruneEmptyWorkRows(modeDraft());
  const rows = modeDraft().rows;
  const visibleRows = filterVoucherRows(rows, state.gridSearch);
  const defaultRow = {
    rowId: DEFAULT_INPUT_ROW_ID,
    itemCode: '', itemName: '', secondaryName: '', searchInfo: '', specification: '', boxQuantity: '',
    quantity: '', unit: '', unitPrice: '', outPrice: '', wholesaleA: '', wholesaleB: '', listingPrice: '',
    marketPrice: '', promoPrice: '', purchasePriceB: '', priceD: '', lastPurchasePrice: '', priceH: '', priceI: '',
    memo: '', description: '', noticePrice: '', customValues: {}, duplicatePossible: false,
    matchStatus: state.busy && modeDraft().activeMethod === 'photo' ? 'ANALYZING' : 'EMPTY'
  };
  const renderedRows = [...visibleRows, defaultRow];
  inputRows.innerHTML = renderedRows.map(row => {
    const isDefault = row.rowId === DEFAULT_INPUT_ROW_ID;
    const sequence = isDefault ? rows.length + 1 : Math.max(1, rows.findIndex(item => item.rowId === row.rowId) + 1);
    const orderQProductMismatch = row.sourceType === 'ORDER_Q' && (
      (row.metaProductId && row.productId && row.metaProductId !== row.productId)
      || (row.metaProductCode && row.itemCode && row.metaProductCode.toUpperCase() !== row.itemCode.toUpperCase())
    );
    const hasAmountInputs = hasEnteredValue(row.quantity) && hasEnteredValue(row.unitPrice);
    const amount = hasAmountInputs ? Number(row.quantity) * Number(row.unitPrice) : null;
    const productCells = optionalProductFields().map(field => {
      const excelNumber = field.valueType === 'NUMBER' && ['PRICE', 'COST'].includes(field.group);
      const inputType = field.valueType === 'NUMBER' && !excelNumber ? 'number' : 'text';
      const numericAttributes = excelNumber ? ' inputmode="decimal"' : (inputType === 'number' ? ' step="any"' : '');
      return `<td data-column="${esc(field.id)}"><input data-field="${esc(field.id)}" type="${inputType}"${numericAttributes} value="${esc(row[field.id] ?? '')}" aria-label="${esc(field.label)}"></td>`;
    }).join('');
    const customCells = customFieldsFor('voucher').map(field => (
      `<td data-column="${esc(field.id)}"><input data-custom-row-field="${esc(field.id)}" type="${field.valueType === 'NUMBER' ? 'number' : 'text'}"${field.valueType === 'NUMBER' ? ' step="any"' : ''} value="${esc(row.customValues?.[field.id] || '')}" aria-label="${esc(field.label)}"></td>`
    )).join('');
    return `<tr data-row-id="${esc(row.rowId)}" ${isDefault ? 'data-default-row="true"' : ''} data-status="${esc(row.matchStatus)}" class="${row.duplicatePossible ? 'is-duplicate' : ''}">
      <td class="row-sequence-cell">${sequence}</td>
      <td class="row-select-cell"><input type="checkbox" data-select-row="${isDefault ? '' : esc(row.rowId)}" aria-label="행 선택" ${isDefault ? 'disabled' : (state.selectedRowIds.has(row.rowId) ? 'checked' : '')}></td>
      <td data-column="productSearch" class="product-search-cell"><input data-product-search type="text" enterkeyhint="search" value="${esc(row.unregisteredProductQuery || row.itemName || row.itemCode || '')}" placeholder="코드·품명·검색어" aria-label="상품 검색" title="상품코드, 품명 또는 검색어 입력 후 Enter"></td>
      <td data-column="itemCode"><input data-field="itemCode" type="text" enterkeyhint="search" value="${esc(row.itemCode)}" aria-label="품목코드" title="입력 후 Enter로 상품 검색"></td>
      <td data-column="itemName"><input data-field="itemName" type="text" enterkeyhint="search" value="${esc(row.itemName)}" aria-label="품목명" title="입력 후 Enter로 상품 검색"></td>
      <td data-column="specification"><input data-field="specification" value="${esc(row.specification)}" aria-label="규격"></td>
      <td data-column="quantity"><input data-field="quantity" type="number" step="any" value="${esc(row.quantity ?? '')}" aria-label="수량"></td>
      <td data-column="unit"><input data-field="unit" value="${esc(row.unit)}" aria-label="단위"></td>
      <td data-column="unitPrice" class="price-cell${row.unitPriceReviewStatus === 'PENDING' ? ' is-price-review-pending' : ''}"><input data-field="unitPrice" type="text" inputmode="decimal" value="${esc(row.sourceUnitPrice ?? row.unitPrice ?? '')}" aria-label="단가"></td>
      <td data-column="supplyAmount"><input data-supply-amount value="${amount === null ? '' : amount.toLocaleString('ko-KR')}" aria-label="공급가액" readonly tabindex="-1"></td>
      <td data-column="memo"><input data-field="memo" value="${esc(row.memo)}" aria-label="메모"></td>
      <td data-column="description"><input data-field="description" value="${esc(row.description)}" aria-label="적요(직원)"></td>
      <td data-column="noticePrice"><input data-field="noticePrice" type="text" inputmode="decimal" value="${row.noticePrice === 0 && !row.editedFields?.noticePrice ? '' : esc(row.noticePrice ?? '')}" aria-label="공지단가"></td>
      ${productCells}
      ${customCells}
      <td data-column="status"><div class="row-status">${row.linkedSourceEstimateId ? `<em class="linked-row-badge" title="${esc(row.linkedSourceEstimateName)} 원본과 양방향 연동">연동 · ${esc(row.linkedSourceEstimateName)}</em>` : ''}${row.linkedFieldConflicts?.length ? `<em class="linked-value-conflict" title="원본별 값이 다릅니다. 해당 셀을 수정하면 동일 적용 여부를 확인합니다.">값 다름</em>` : ''}<span>${orderQProductMismatch ? 'ORDER Q 상품 불일치' : rowStatusText(row.matchStatus, row)}</span>${orderQProductMismatch ? `<button type="button" data-detach-orderq="${esc(row.rowId)}" title="ORDER Q 연결을 해제한 뒤 새 상품을 직접 선택합니다.">DIRECT로 연결 해제</button>` : ''}${row.referenceResolution === 'MISSING' ? `<a class="row-owner-register" data-product-register="${esc(row.rowId)}" href="${ownerAppHref('product')}" target="_blank" rel="noopener">상품관리에서 등록</a>` : ''}</div></td>
    </tr>`;
  }).join('');
  syncRowSelectionControls();
  syncGridPasteUndoButton();
  updateSummaries();
  applyFormLayout();
  renderSourceAnalysis();
  const selectedRow = rows.find(row => row.rowId === state.draft.ui.selectedRowId);
  if (modeDraft().activeMethod === 'photo') {
    if (selectedRow) showPhotoRegion(selectedRow.sourceRegion || null);
    else {
      state.photoView.activeRegion = null;
      renderSourceSurface();
    }
  }
  window.requestAnimationFrame(() => {
    $('tableScroll').scrollTop = Number(modeUi().scrollTop || 0);
    $('tableScroll').scrollLeft = Number(modeUi().scrollLeft || 0);
    if (!restoreFocus) return;
    const active = modeUi().activeCellId;
    if (!active) return;
    const [rowId, field] = active.split('|');
    gridInput(rowId, field)?.focus({ preventScroll: true });
  });
}

function updateSummaries() {
  const summary = contract.summarizeRows(modeDraft().rows);
  const visibleRows = filterVoucherRows(modeDraft().rows, state.gridSearch);
  const groups = groupVoucherRows(state.draft.activeMode, modeDraft().rows, modeDraft().header);
  const groupSummary = summarizeVoucherGroups(groups);
  $('gridRowCount').textContent = `${summary.total.toLocaleString('ko-KR')}행`;
  $('gridSearchCount').hidden = !state.gridSearch;
  $('gridSearchCount').textContent = `검색 ${visibleRows.length.toLocaleString('ko-KR')}행`;
  $('voucherGroupSummary').textContent = state.draft.activeMode === 'estimate' || !modeDraft().rows.length ? '' : groupSummary.label;
  $('matchedCount').textContent = `일치 ${summary.matched.toLocaleString('ko-KR')}`;
  $('similarCount').textContent = `확인 ${summary.similar.toLocaleString('ko-KR')}`;
  $('failedCount').textContent = `미인식 ${summary.unresolved.toLocaleString('ko-KR')}`;
  $('duplicateCount').textContent = `중복 가능 ${summary.duplicate.toLocaleString('ko-KR')}`;
  $('totalQuantity').textContent = summary.quantity.toLocaleString('ko-KR');
  $('totalAmount').textContent = `${summary.amount.toLocaleString('ko-KR')}원`;
  renderActivityTrail();
  renderVoucherContext(summary);
}

function renderDelivery() {
  const isOrder = state.draft.activeMode === 'order';
  const isPurchase = state.draft.activeMode === 'purchase';
  const isSale = state.draft.activeMode === 'sale';
  const isEstimate = state.draft.activeMode === 'estimate';
  const delivery = modeDraft().delivery;
  const lastDelivery = isOrder ? state.draft.ui.lastDelivery : null;
  $('deliveryTarget').textContent = isOrder ? '공통 주문서 원장' : (isEstimate ? '저장 견적서' : (isPurchase ? '공식 구매전표 원장' : (isSale ? '공식 판매전표 원장' : `${contract.MODES[state.draft.activeMode].label} 전달 계약 준비 중`)));
  $('deliveryDescription').textContent = isOrder
    ? 'ORDER Q vNext 저장소에 먼저 기록합니다.'
    : (isEstimate ? '견적서 저장·불러오기·삭제를 관리합니다.' : (isPurchase
      ? (state.purchaseCapability.ready ? '중앙 공식 구매전표로 저장합니다.' : '중앙 배포 계약 확인 후 활성화됩니다.')
      : (isSale ? (state.saleCapability.ready ? '중앙 공식 판매전표로 저장합니다.' : '중앙 배포 계약 확인 후 활성화됩니다.')
        : '확정된 DataOps 연결만 이후 단계에서 활성화합니다.')));
  const visibleDelivery = delivery.status === 'SAVED' ? delivery : lastDelivery;
  $('deliveryState').textContent = visibleDelivery
    ? `최근 ${visibleDelivery.orderNo || visibleDelivery.targetRecordId || '저장 완료'}${visibleDelivery.deliveredAt ? ` · ${new Date(visibleDelivery.deliveredAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : ''}`
    : '전달 전';
  document.querySelector('.delivery-state span').style.background = visibleDelivery ? '#5eead4' : '#fbbf24';
  $('completeButton').disabled = state.busy || modeDraft().estimateKind === 'COMPOSITION_PREVIEW';
  $('completeButton').hidden = false;
  $('completeButton').textContent = '저장';
  $('estimateRenameButton').disabled = state.busy || state.noticeEstimateIds.length !== 1;
  $('estimateCreateButton').disabled = state.busy || state.noticeEstimateIds.length < 1;
  $('selectedEstimateDeleteButton').disabled = state.busy || state.noticeEstimateIds.length < 1;
  $('estimateLibrarySwitchButton').disabled = state.busy;
  updateAutosaveButton();
  renderVoucherContext();
}

function renderMode() {
  const selected = contract.MODES[state.draft.activeMode];
  tabs.forEach(tab => {
    const active = tab.dataset.mode === selected.id;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  const estimateMode = selected.id === 'estimate';
  const modeLabels = selected.id === 'purchase'
    ? { customer: '구매처 ', date: '구매일자', warehouse: '입고창고 ' }
    : (selected.id === 'sale'
      ? { customer: '판매처 ', date: '판매일자', warehouse: '출하창고 ' }
      : { customer: '거래처명 ', date: estimateMode ? '견적 작성일' : '배송일자', warehouse: '출하창고 ' });
  $('customerFieldLabel').firstChild.nodeValue = modeLabels.customer;
  document.querySelector('[data-header-field="deliveryDate"] > span').textContent = modeLabels.date;
  const warehouseLabel = document.querySelector('[data-header-field="warehouse"] > span');
  if (warehouseLabel) warehouseLabel.innerHTML = `${modeLabels.warehouse}<em>필수</em>`;
  $('customerRequiredMark').hidden = estimateMode;
  $('customerInput').placeholder = estimateMode ? '선택 입력' : '거래처명 또는 코드';
  $('customerHint').textContent = estimateMode
    ? '견적서는 거래처 없이 저장하고 여러 업체에 공통 발송할 수 있습니다.'
    : '거래처가 인식되지 않으면 이 입력란으로 이동합니다.';
  $('estimateOutputActions').hidden = false;
  $('estimateNoticeButton').textContent = '카톡 공유';
  $('estimateExcelButton').textContent = selected.id === 'estimate' ? '견적 Excel' : 'Excel 다운로드';
  const linkedEstimate = estimateMode && ['LINKED_GROUP', 'COMPOSITION_PREVIEW'].includes(modeDraft().estimateKind);
  $('customerInput').disabled = linkedEstimate;
  $('addRowButton').disabled = false;
  $('addRowButton').title = '항상 유지되는 마지막 수기입력 행으로 이동합니다.';
  hydrateHeader();
  renderEstimateHeaderFields();
  $('gridSearchInput').value = state.gridSearch;
  if (removeParserArtifactRows(modeDraft())) scheduleSave();
  sourceTextInput.value = modeDraft().sourceText;
  state.photoView.detailColumns = Boolean(modeUi().detailColumns);
  updateMethod(modeDraft().activeMethod, { persist: false });
  renderRows();
  renderCatalogControls();
  renderEstimateWorkspace();
  renderDelivery();
  renderReferenceControls();
  resizeSource();
  renderSourceAnalysis();
  applyFormLayout();
  const relatedOpen = Boolean(state.draft.ui.relatedOpen);
  $('estimateLibraryView').classList.toggle('is-open', relatedOpen);
  $('relatedCollapseButton').setAttribute('aria-expanded', String(relatedOpen));
  $('relatedCollapseButton').textContent = relatedPanelButtonLabel(relatedOpen);
  if (!referencesReady()) {
    setAppStatus(referenceStatusMessage(), 'warn');
  } else {
    setAppStatus(selected.id === 'order'
      ? '주문서 입력을 시작할 수 있습니다.'
      : (selected.id === 'estimate' ? (modeDraft().estimateKind === 'COMPOSITION_PREVIEW' ? '선택한 견적서를 중복 제거해 함께 표시합니다. 원본은 견적서 생성 전까지 변경되지 않습니다.' : (linkedEstimate ? '연동견적서 행은 개별 견적서와 양방향으로 반영됩니다.' : '개별 견적서를 작성하거나 연동견적서를 선택할 수 있습니다.')) : `${selected.label} 입력 화면입니다. 전달 연결은 준비 중입니다.`));
  }
  if (sourceTextInput.value.trim()) scheduleAutoAnalysis(650);
}

function setMode(mode) {
  if (!contract.MODES[mode] || mode === state.draft.activeMode) return false;
  const previousMode = state.draft.activeMode;
  clearTimeout(state.autoAnalyzeTimer);
  if (state.pendingStructuredImport?.rawText !== sourceTextInput.value) state.pendingStructuredImport = null;
  modeDraft().sourceText = sourceTextInput.value;
  state.gridPasteUndo = null;
  state.draft.activeMode = mode;
  try {
    restoreSourceImageForMode(mode);
    state.selectedRowIds.clear();
    state.activeActivity = '';
    state.pendingImageEvidence = null;
    state.pendingOcrReview = null;
    state.pendingSourceName = '';
    state.pendingStructuredImport = null;
    state.gridSearch = '';
    if (mode === 'estimate') {
      state.estimateLibraryKind = 'individual';
      state.noticeEstimateIds = [];
      state.estimateSelectionReturnDraft = null;
    }
    saveDraftNow();
    renderMode();
    return true;
  } catch (error) {
    state.draft.activeMode = previousMode;
    restoreSourceImageForMode(previousMode);
    renderMode();
    setAppStatus('전표 화면을 변경하지 못했습니다. 현재 입력은 유지됩니다.', 'error');
    toast(error.message || '전표 화면을 변경하지 못했습니다.', 'error');
    return false;
  }
}

function syncSourceText() {
  if (state.pendingStructuredImport?.rawText !== sourceTextInput.value) state.pendingStructuredImport = null;
  modeDraft().sourceText = sourceTextInput.value;
  scheduleSave();
  resizeSource();
  renderSourceAnalysis();
  scheduleAutoAnalysis();
}

function scheduleAutoAnalysis(delay = 320) {
  clearTimeout(state.autoAnalyzeTimer);
  if (state.sourceComposing || !sourceTextInput.value.trim()) return;
  state.autoAnalyzeTimer = window.setTimeout(() => analyzeSource({ automatic: true }), delay);
}

function appendDirectRow() {
  const current = modeDraft();
  const batch = contract.createBatch({
    sequence: current.batches.length + 1,
    method: 'direct',
    sourceType: 'MANUAL',
    sourceName: '직접입력'
  });
  current.batches.push(batch);
  current.rows = contract.applyParserResults(current.rows, batch, [{ rawText: '', itemName: '', quantity: null, inputOwnership: 'USER' }]);
  return current.rows[current.rows.length - 1];
}

function createTrailingDefaultRow(sourceRow) {
  const trailing = sourceRow.cloneNode(true);
  trailing.dataset.rowId = DEFAULT_INPUT_ROW_ID;
  trailing.dataset.defaultRow = 'true';
  trailing.dataset.status = state.busy && modeDraft().activeMethod === 'photo' ? 'ANALYZING' : 'EMPTY';
  trailing.className = '';
  const sequence = trailing.querySelector('.row-sequence-cell');
  if (sequence) sequence.textContent = String(modeDraft().rows.length + 1);
  const selector = trailing.querySelector('[data-select-row]');
  if (selector) {
    selector.dataset.selectRow = '';
    selector.checked = false;
    selector.disabled = true;
  }
  trailing.querySelectorAll('[data-product-search], [data-field], [data-custom-row-field], [data-supply-amount]').forEach(input => {
    input.value = '';
    delete input.dataset.matchSubmitted;
  });
  const status = trailing.querySelector('.row-status');
  if (status) status.innerHTML = `<span>${rowStatusText(trailing.dataset.status)}</span>`;
  return trailing;
}

function materializeDefaultRow(tr, sourceInput = document.activeElement) {
  if (!tr || tr.dataset.defaultRow !== 'true') return modeDraft().rows.find(row => row.rowId === tr?.dataset.rowId) || null;
  const row = appendDirectRow();
  const trailing = createTrailingDefaultRow(tr);
  const activeInput = tr.contains(sourceInput) ? sourceInput : [...tr.querySelectorAll('[data-product-search], [data-field], [data-custom-row-field]')].find(input => hasEnteredValue(input.value));
  const activeField = gridFieldId(activeInput);
  if (activeInput?.hasAttribute?.('data-product-search')) row.unregisteredProductQuery = activeInput.value;
  else if (activeInput?.hasAttribute?.('data-custom-row-field')) row.customValues[activeField] = activeInput.value;
  else if (activeField) Object.assign(row, contract.markProductEdit(row, activeField, activeInput.value));
  tr.dataset.rowId = row.rowId;
  tr.dataset.status = row.matchStatus;
  delete tr.dataset.defaultRow;
  const status = tr.querySelector('.row-status span');
  if (status) status.textContent = rowStatusText(row.matchStatus, row);
  const selector = tr.querySelector('[data-select-row]');
  if (selector) {
    selector.dataset.selectRow = row.rowId;
    selector.disabled = false;
  }
  modeUi().activeCellId = `${row.rowId}|${gridFieldId(activeInput) || 'productSearch'}`;
  state.draft.ui.selectedRowId = row.rowId;
  tr.after(trailing);
  syncRowSelectionControls();
  updateSummaries();
  scheduleSave();
  return row;
}

function addDirectRow() {
  invalidateGridPasteUndo();
  const last = inputRows.querySelector('tr[data-default-row="true"] input[data-product-search]');
  last?.focus();
}

function gridFieldId(input) {
  if (input?.hasAttribute?.('data-product-search')) return 'productSearch';
  return input?.dataset?.field || input?.dataset?.customRowField || '';
}

function visibleEditableGridFields() {
  return [...document.querySelectorAll('#tableScroll thead th[data-column]')]
    .filter(header => !header.classList.contains('is-column-hidden'))
    .map(header => header.dataset.column)
    .filter(field => field === 'productSearch'
      ? inputRows.querySelector('[data-product-search]')
      : inputRows.querySelector(`[data-field="${CSS.escape(field)}"], [data-custom-row-field="${CSS.escape(field)}"]`));
}

function enterGridFields() {
  const visible = visibleEditableGridFields();
  const inputOrder = state.settings.inputOrderByMode?.[state.draft.activeMode] || {};
  return visible
    .map((field, displayIndex) => ({ field, displayIndex, order: Number(inputOrder[field] ?? displayIndex + 1) }))
    .filter(item => Number.isFinite(item.order) && item.order > 0)
    .sort((left, right) => left.order - right.order || left.displayIndex - right.displayIndex)
    .map(item => item.field);
}

function gridInput(rowId, field) {
  if (field === 'productSearch') return inputRows.querySelector(`[data-row-id="${CSS.escape(rowId)}"] [data-product-search]`);
  return inputRows.querySelector(`[data-row-id="${CSS.escape(rowId)}"] [data-field="${CSS.escape(field)}"], [data-row-id="${CSS.escape(rowId)}"] [data-custom-row-field="${CSS.escape(field)}"]`);
}

function revealGridInput(input) {
  const scroll = $('tableScroll');
  const row = input?.closest('tr[data-row-id]');
  if (!scroll || !row) return;
  const scrollBounds = scroll.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  const headerHeight = scroll.querySelector('thead')?.getBoundingClientRect().height || 0;
  const footerHeight = scroll.querySelector('tfoot')?.getBoundingClientRect().height || 0;
  const visibleTop = scrollBounds.top + headerHeight + 4;
  const visibleBottom = scrollBounds.bottom - footerHeight - 4;
  if (rowBounds.bottom > visibleBottom) scroll.scrollTop += rowBounds.bottom - visibleBottom;
  else if (rowBounds.top < visibleTop) scroll.scrollTop -= visibleTop - rowBounds.top;

  const cellBounds = input.closest('td')?.getBoundingClientRect();
  if (!cellBounds) return;
  if (cellBounds.right > scrollBounds.right) scroll.scrollLeft += cellBounds.right - scrollBounds.right + 4;
  else if (cellBounds.left < scrollBounds.left) scroll.scrollLeft -= scrollBounds.left - cellBounds.left + 4;
}

function focusGridTarget(target) {
  if (!target) return;
  let rowId = target.rowId;
  if (target.append) {
    rowId = DEFAULT_INPUT_ROW_ID;
    modeUi().activeCellId = `${rowId}|${target.field}`;
    gridInput(rowId, target.field)?.focus({ preventScroll: true });
    return;
  }
  modeUi().activeCellId = `${rowId}|${target.field}`;
  const input = gridInput(rowId, target.field);
  input?.focus({ preventScroll: true });
  input?.select?.();
}

function sequentialGridTarget(rowId, field) {
  const visibleFields = visibleEditableGridFields();
  const fields = enterGridFields();
  const rows = [...inputRows.querySelectorAll('tr[data-row-id]')];
  const rowIndex = rows.findIndex(row => row.dataset.rowId === rowId);
  if (rowIndex < 0 || !fields.length) return null;
  const fieldIndex = fields.indexOf(field);
  if (fieldIndex >= 0 && fieldIndex < fields.length - 1) return { rowId, field: fields[fieldIndex + 1] };
  if (fieldIndex < 0) {
    const displayIndex = visibleFields.indexOf(field);
    const nextConfiguredField = visibleFields.slice(displayIndex + 1).find(candidate => fields.includes(candidate));
    if (nextConfiguredField) return { rowId, field: nextConfiguredField };
  }
  const nextRow = rows[rowIndex + 1];
  return nextRow ? { rowId: nextRow.dataset.rowId, field: fields[0] } : { append: true, field: fields[0] };
}

function directionalGridTarget(rowId, field, key) {
  const fields = visibleEditableGridFields();
  const rows = [...inputRows.querySelectorAll('tr[data-row-id]')];
  const rowIndex = rows.findIndex(row => row.dataset.rowId === rowId);
  const fieldIndex = fields.indexOf(field);
  if (rowIndex < 0 || fieldIndex < 0) return null;
  const rowOffset = key === 'ArrowDown' ? 1 : (key === 'ArrowUp' ? -1 : 0);
  const fieldOffset = key === 'ArrowRight' ? 1 : (key === 'ArrowLeft' ? -1 : 0);
  const targetRow = rows[rowIndex + rowOffset];
  const targetField = fields[fieldIndex + fieldOffset];
  if (!targetRow || !targetField) return null;
  return { rowId: targetRow.dataset.rowId, field: targetField };
}

function nextRowEntryTarget(rowId, backwards = false) {
  const rows = [...inputRows.querySelectorAll('tr[data-row-id]')];
  const rowIndex = rows.findIndex(row => row.dataset.rowId === rowId);
  if (rowIndex < 0) return null;
  const targetRow = rows[rowIndex + (backwards ? -1 : 1)];
  if (targetRow) return { rowId: targetRow.dataset.rowId, field: 'productSearch' };
  return backwards ? null : { append: true, field: 'productSearch' };
}

function gridPasteFieldDefinitions() {
  return layoutDefinitions('voucher').filter(field => field.editable !== false);
}

function visibleGridPasteFields() {
  return visibleEditableGridFields().filter(fieldId => fieldId !== 'productSearch');
}

function applyGridPaste(rawText, startRowId, startFieldId) {
  const current = modeDraft();
  const startRowIndex = startRowId === DEFAULT_INPUT_ROW_ID
    ? current.rows.length
    : current.rows.findIndex(row => row.rowId === startRowId);
  if (startRowIndex < 0 || startFieldId === 'productSearch') return false;
  const definitions = gridPasteFieldDefinitions();
  const definitionById = new Map(definitions.map(field => [field.id, field]));
  const plan = buildGridPastePlan(rawText, {
    fieldDefinitions: definitions,
    visibleFieldIds: visibleGridPasteFields(),
    startFieldId,
    numberParser: contract.numberOrNull,
    requireHeaders: true
  });
  if (!plan.valid) {
    const fields = (plan.headerErrors || []).slice(0, 3).map(error => {
      if (error.reason === 'EMPTY_HEADER') return `${error.columnIndex + 1}열(빈 필드명)`;
      if (error.reason === 'DUPLICATE_FIELD') return `${error.columnIndex + 1}열(${error.header} 중복)`;
      return `${error.columnIndex + 1}열(${error.header || '알 수 없음'})`;
    }).join(', ');
    const rows = (plan.rowErrors || []).slice(0, 3).map(error => `${error.rowNumber}행(${error.actualColumnCount}/${error.expectedColumnCount}열)`).join(', ');
    toast(rows
      ? `행별 열 수가 필드명과 일치하지 않아 붙여넣기를 중단했습니다. ${rows}`
      : `필드명이 일치하지 않아 붙여넣기를 중단했습니다.${fields ? ` ${fields}` : ''}`, 'error');
    return false;
  }
  if (plan.invalidCells.length) {
    const cells = plan.invalidCells.slice(0, 3).map(cell => `${cell.rowNumber}행 ${cell.fieldId}`).join(', ');
    toast(`숫자 필드 값을 확인하세요. 붙여넣기를 중단했습니다. ${cells}`, 'error');
    return false;
  }
  if (!plan.rows.length || plan.rows.every(row => !row.cells.length)) {
    toast('필드명 아래에 입력할 값이 없습니다.', 'error');
    return false;
  }

  captureGridPasteUndo();
  state.applyingGridPaste = true;
  try {
    const batch = contract.createBatch({
      sequence: current.batches.length + 1,
      method: 'grid-paste',
      sourceType: 'MANUAL',
      sourceName: 'Excel 범위 붙여넣기',
      sourceRole: 'USER_ENTRY',
      rawText
    });
    current.batches.push(batch);
    const requiredRowCount = startRowIndex + plan.rows.length;
    const additionalRowCount = Math.max(0, requiredRowCount - current.rows.length);
    if (additionalRowCount) {
      current.rows = contract.applyParserResults(current.rows, batch, Array.from({ length: additionalRowCount }, (_, index) => ({
        rawText: '',
        itemName: '',
        quantity: null,
        sourceLineNo: index + 1,
        inputOwnership: 'USER'
      })));
    }

    const identityRows = new Set();
    let pastedCellCount = 0;
    plan.rows.forEach((pasteRow, rowOffset) => {
      const rowIndex = startRowIndex + rowOffset;
      let row = contract.normalizeRow({
        ...current.rows[rowIndex],
        batchId: batch.batchId,
        batchSequence: batch.sequence,
        sourceLineNo: rowOffset + 1,
        sourceLineKey: '',
        intakeLineId: '',
        sourceRegion: null,
        rawText: pasteRow.rawText,
        inputOwnership: 'USER'
      }, batch.batchId);
      pasteRow.cells.forEach(cell => {
        const definition = definitionById.get(cell.fieldId);
        if (!definition) return;
        if (!hasEnteredValue(cell.value)) return;
        pastedCellCount += 1;
        if (definition.custom) {
          row.customValues = { ...(row.customValues || {}), [cell.fieldId]: cell.value };
          return;
        }
        row = contract.markProductEdit(row, cell.fieldId, cell.value);
        if (cell.fieldId === 'itemCode' || cell.fieldId === 'itemName') identityRows.add(rowIndex);
      });
      current.rows[rowIndex] = contract.normalizeRow(row, batch.batchId);
    });
    identityRows.forEach(rowIndex => {
      current.rows[rowIndex] = matchGridPasteRow(current.rows[rowIndex]);
    });
    pruneEmptyWorkRows(current);
    current.rows = contract.markDuplicatePossibilities(current.rows);
    const firstRow = current.rows[startRowIndex];
    modeUi().activeCellId = firstRow ? `${firstRow.rowId}|${startFieldId}` : '';
    state.draft.ui.selectedRowId = firstRow?.rowId || '';
    renderRows();
    saveDraftNow();
    const message = `${plan.rows.length.toLocaleString('ko-KR')}행 · ${pastedCellCount.toLocaleString('ko-KR')}셀을 입력했습니다.`;
    if (plan.invalidCells.length || plan.ignoredColumnCount) {
      const details = [
        plan.invalidCells.length ? `숫자 확인 ${plan.invalidCells.length}셀` : '',
        plan.ignoredColumnCount ? `범위 밖 ${plan.ignoredColumnCount}열 제외` : ''
      ].filter(Boolean).join(' · ');
      toast(`${message} ${details}`, 'warn');
    } else {
      toast(`${message}${plan.kind === 'HEADER' ? ' 필드명으로 열을 매칭했습니다.' : ''}`, 'success');
    }
    return true;
  } catch (error) {
    const snapshot = state.gridPasteUndo;
    if (snapshot?.mode === state.draft.activeMode) {
      current.rows = snapshot.rows.map(row => contract.normalizeRow(row));
      current.batches = cloneGridValue(snapshot.batches);
      state.selectedRowIds = new Set(snapshot.selectedRowIds);
      modeUi().activeCellId = snapshot.activeCellId;
    }
    state.gridPasteUndo = null;
    renderRows();
    toast(error.message || 'Excel 범위를 붙여넣지 못했습니다.', 'error');
    return false;
  } finally {
    state.applyingGridPaste = false;
    syncGridPasteUndoButton();
  }
}

function confirmUnitPriceReview(tr) {
  const row = modeDraft().rows.find(item => item.rowId === tr?.dataset.rowId);
  if (!row || row.unitPriceReviewStatus !== 'PENDING') return false;
  row.unitPriceReviewStatus = 'CONFIRMED';
  tr.querySelector('[data-column="unitPrice"]')?.classList.remove('is-price-review-pending');
  scheduleSave();
  return true;
}

const PARSER_ARTIFACT_TERMS = /(품목코드|품목명|품목|품명|상품명|규격|수량|단가|공급가액|금액|합계|총계|소계)/g;
const PARSER_ERROR_LABEL = /^[\[(【<{]\s*(?:오류|에러|미인식|확인|error|err|[가-힣A-Za-z]{1,2})\s*[\])】>}]$/i;

function isParserArtifactLine(line) {
  const productText = String(line?.productText || line?.itemName || '').normalize('NFKC').trim();
  const rawText = String(line?.rawText || '').normalize('NFKC').trim();
  if (PARSER_ERROR_LABEL.test(productText)) return true;
  if (/^(?:합계|총계|소계)(?:\s|[:：|]|$)/.test(productText || rawText)) return true;
  const terms = productText.match(PARSER_ARTIFACT_TERMS) || [];
  if (terms.length < 2) return false;
  const residue = productText
    .replace(PARSER_ARTIFACT_TERMS, '')
    .replace(/[|:;·•_\-\s\d,.원₩()[\]{}<>]/g, '')
    .trim();
  return residue.length <= 2;
}

function removeParserArtifactRows(current) {
  const previousLength = Number(current?.rows?.length || 0);
  const parserBatchIds = new Set((current?.batches || [])
    .filter(batch => batch.sourceType !== 'MANUAL')
    .map(batch => batch.batchId));
  current.rows = (current?.rows || []).filter(row => {
    if (!rowHasMeaningfulInput(row)) return false;
    if (!parserBatchIds.has(row.batchId)) return true;
    if (row.editedFields?.itemCode || row.editedFields?.itemName) return true;
    return !isParserArtifactLine({ productText: row.itemName, rawText: row.rawText });
  });
  return current.rows.length !== previousLength;
}

function clearParserWorkspace() {
  invalidateGridPasteUndo();
  const current = modeDraft();
  const parserBatchIds = new Set((current.batches || [])
    .filter(batch => batch.sourceType !== 'MANUAL')
    .map(batch => batch.batchId));
  const removedRows = (current.rows || []).filter(row => parserBatchIds.has(row.batchId)).length;
  clearTimeout(state.autoAnalyzeTimer);
  state.analysisRequestId += 1;
  state.photoCaptureSequence += 1;
  state.busy = false;
  if (state.listening && state.recognition) {
    const recognition = state.recognition;
    recognition.onend = null;
    state.recognition = null;
    state.listening = false;
    try {
      recognition.stop();
    } catch (_) {
      // 이미 종료된 음성 세션은 파서 초기화를 막지 않는다.
    }
  }
  current.batches = (current.batches || []).filter(batch => batch.sourceType === 'MANUAL');
  current.rows = contract.markDuplicatePossibilities((current.rows || []).filter(row => !parserBatchIds.has(row.batchId)));
  current.sourceText = '';
  current.delivery = { status: 'DRAFT', targetId: '', targetRecordId: '', deliveredAt: '' };
  sourceTextInput.value = '';
  $('fileInput').value = '';
  $('photoInput').value = '';
  state.sourceImages[state.draft.activeMode] = null;
  state.selectedRowIds.clear();
  state.pendingImageEvidence = null;
  state.pendingOcrReview = null;
  state.pendingSourceName = '';
  state.pendingStructuredImport = null;
  state.activeActivity = '';
  state.draft.ui.selectedRowId = '';
  modeUi().scrollTop = 0;
  modeUi().scrollLeft = 0;
  modeUi().activeCellId = '';
  resetPhotoView();
  updateMethod('text', { persist: false });
  setActiveActivity('');
  renderReferenceControls();
  $('parserProgress').hidden = true;
  $('parserProgress').querySelector('strong').textContent = '자료를 분석하고 있습니다.';
  $('sourceNotice').textContent = '직접 입력과 Ctrl+V도 지원합니다.';
  saveDraftNow();
  renderMode();
  if (!referencesReady()) setAppStatus(referenceStatusMessage(), 'warn');
  else setAppStatus(removedRows ? `파서 원문과 분석 결과 ${removedRows}행을 지웠습니다.` : '파서 입력창을 비웠습니다.');
  if (modeDraft().activeMethod === 'photo') $('photoEmptySelectButton').focus();
  else sourceTextInput.focus();
  toast(removedRows ? `파서 원문과 분석 결과 ${removedRows}행을 지웠습니다.` : '파서 입력창을 비웠습니다.', 'success');
}

async function sha256Text(value) {
  if (!crypto?.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value ?? '')));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function fallbackLines(rawText, batch) {
  const customerKey = normalizedKey(modeDraft().header.customerName);
  return extractOrderProductLines({ sourceType: batch.sourceType, sourceId: 'SMART_INPUT', rawText })
    .filter(line => normalizedKey(line.productText) !== customerKey)
    .map(line => ({
      rawText: line.rawText,
      productText: line.productText,
      itemName: line.productText,
      quantity: line.quantity,
      unit: line.finalUnit || line.rawUnit || '',
      sourceLineKey: `${batch.batchId}:${line.sourceMessageKey}:${line.sourceLineNo}`,
      matchStatus: 'UNRESOLVED'
    }));
}

async function analyzeSource({ automatic = false } = {}) {
  if (!automatic) clearTimeout(state.autoAnalyzeTimer);
  invalidateGridPasteUndo();
  if (state.busy) {
    if (automatic) scheduleAutoAnalysis(600);
    return;
  }
  const modeId = state.draft.activeMode;
  const current = modeDraft();
  const rawText = sourceTextInput.value;
  if (!rawText.trim()) {
    if (automatic) return;
    sourceTextInput.focus();
    return toast('분석할 원문을 입력하세요.', 'error');
  }
  const contentHash = await sha256Text(rawText);
  if (state.busy || state.draft.activeMode !== modeId || sourceTextInput.value !== rawText) {
    if (automatic && sourceTextInput.value.trim()) scheduleAutoAnalysis(420);
    return;
  }
  let existingLiveBatch = current.batches.find(batch => batch.sourceRole === 'LIVE_SOURCE');
  if (!existingLiveBatch && current.sourceText === rawText) {
    existingLiveBatch = [...current.batches].reverse().find(batch => batch.rawText === rawText) || null;
    if (existingLiveBatch) existingLiveBatch.sourceRole = 'LIVE_SOURCE';
  }
  if (existingLiveBatch?.contentHash && existingLiveBatch.contentHash === contentHash) {
    renderSourceAnalysis();
    return;
  }
  const requestId = ++state.analysisRequestId;
  const method = contract.INPUT_METHODS.find(item => item.id === current.activeMethod) || contract.INPUT_METHODS[2];
  const pendingOcr = method.sourceType === 'IMAGE_OCR' && state.pendingOcrReview?.rawText === rawText
    ? state.pendingOcrReview
    : null;
  const structuredImport = method.id === 'excel'
    && state.pendingStructuredImport?.modeId === modeId
    && state.pendingStructuredImport?.rawText === rawText
    ? state.pendingStructuredImport
    : null;
  if (pendingOcr && pendingOcr.status !== 'VERIFIED') {
    const reason = pendingOcr.warnings.includes('TOTAL_NOT_FOUND')
      ? '합계 수량·금액을 인식하지 못했습니다.'
      : '행 산식 또는 합계 검증이 일치하지 않습니다.';
    setAppStatus(`OCR 확인 필요 · ${reason}`, 'error');
    $('sourceNotice').textContent = `OCR 확인 필요 · 검증 ${pendingOcr.validRows.length}행 · 오류 ${pendingOcr.invalidRows.length}행`;
    if (!automatic) toast('OCR 검증이 끝나지 않아 상품행을 생성하지 않았습니다.', 'error');
    renderSourceAnalysis();
    return;
  }
  const detectedSourceType = structuredImport
    ? 'STRUCTURED_FILE'
    : (looksLikeKakaoText(rawText)
    ? 'KAKAO_TEXT'
    : (pendingOcr?.status === 'VERIFIED'
      ? 'IMAGE_OCR'
      : (['CLIPBOARD', 'IMAGE_OCR'].includes(method.sourceType) ? 'GENERAL_TEXT' : method.sourceType)));
  const batch = contract.createBatch({
    sequence: visibleActivityBatches(current).length + 1,
    method: method.id,
    sourceType: detectedSourceType,
    sourceName: state.pendingSourceName || currentSourceImage()?.fileName,
    sourceRole: 'LIVE_SOURCE',
    automatic,
    rawText,
    contentHash
  });
  if (pendingOcr?.status === 'VERIFIED') {
    batch.ocrStatus = pendingOcr.status;
    batch.ocrConfidence = pendingOcr.confidence;
    batch.ocrVariant = pendingOcr.variant;
    batch.ocrTotals = { ...pendingOcr.calculatedTotal };
  }
  state.busy = true;
  $('analyzeButton').disabled = true;
  $('parserProgress').hidden = false;
  setActiveActivity(`${batch.sequence}. ${activityLabel(method.id)} 분석 중`);
  setAppStatus(`${batch.sequence}차 입력을 분석하고 있습니다.`);
  try {
    let lines = [];
    let analyzedDocument = null;
    const rawOrdererName = structuredImport ? '' : extractOrdererName(rawText);
    current.header.rawOrdererName = rawOrdererName;
    if (!structuredImport) {
      const aliasResolution = resolveAliasCustomer(rawOrdererName, batch.sourceType);
      if (current.header.customerId && aliasResolution?.customer?.customerId && aliasResolution.customer.customerId !== current.header.customerId) {
        throw new Error(`현재 배송처와 다른 주문자명입니다. 주문을 합치지 않고 새로 작성으로 분리하세요: ${customerName(aliasResolution.customer)}`);
      }
      if (!current.header.customerId && aliasResolution) {
        current.header.aliasMappingId = aliasResolution.mapping.aliasMappingId;
        applyCustomer(aliasResolution.customer, { rematch: false, mappingSource: 'CONFIRMED_ALIAS', learnAlias: false });
      } else if (!current.header.customerId) {
        const inferred = inferCustomer(rawText);
        if (inferred) applyCustomer(inferred, { rematch: false, mappingSource: 'MASTER_EXACT', learnAlias: false });
      }
    }

    if (structuredImport) {
      batch.sourceSheetName = structuredImport.sheetName;
      batch.sourceDocumentKey = `${structuredImport.fileName || batch.batchId}:${structuredImport.sheetName}`;
      lines = decorateStructuredRows(structuredImport.rows, {
        sourceBatchId: batch.batchId,
        sourceSheetName: structuredImport.sheetName,
        sourceFingerprint: batch.contentHash
      }).map((row, index) => ({
        ...row,
        sourceLineKey: row.sourceLineKey || `${batch.batchId}:sheet:${row.sourceLineNo || index + 1}`
      }));
      if (state.draft.activeMode === 'order') {
        try {
          const captured = await captureTextIntake({
            sourceType: batch.sourceType,
            sourceId: 'SMART_INPUT',
            captureOccurrenceId: `${state.draft.draftId}:${state.draft.activeMode}:${batch.sequence}`,
            rawText
          });
          batch.intakeSessionId = captured.session.intakeSessionId;
        } catch (_) {
          // 구조화 행은 원본 표에서 이미 검증했으므로 수집 이력 실패가 입력표 생성을 막지 않는다.
        }
      }
    } else if (pendingOcr?.status === 'VERIFIED') {
      lines = verifiedRowsToParserLines(pendingOcr, batch.batchId);
      if (state.draft.activeMode === 'order') {
        const captured = await captureTextIntake({
          sourceType: batch.sourceType,
          sourceId: 'SMART_INPUT',
          captureOccurrenceId: `${state.draft.draftId}:${state.draft.activeMode}:${batch.sequence}`,
          rawText,
          imageEvidence: state.pendingImageEvidence || state.sourceImages[modeId]
        });
        batch.intakeSessionId = captured.session.intakeSessionId;
        batch.sourceImageId = captured.imagePart?.sourcePartId || state.sourceImages[modeId]?.sourceImageId || '';
        batch.sourceImageHash = state.sourceImages[modeId]?.contentHash || '';
      }
    } else if (state.draft.activeMode === 'order') {
      try {
        const captured = await captureTextIntake({
          sourceType: batch.sourceType,
          sourceId: 'SMART_INPUT',
          captureOccurrenceId: `${state.draft.draftId}:${state.draft.activeMode}:${batch.sequence}`,
          rawText,
          imageEvidence: state.pendingImageEvidence || state.sourceImages[modeId]
        });
        const selectedCustomer = current.header.customerId && current.header.customerName
          ? { customerId: current.header.customerId, customerName: current.header.customerName }
          : null;
        const analyzed = await analyzeSingleOrderDocument({
          session: captured.session,
          sourcePart: captured.sourcePart,
          rawText,
          customerOverride: selectedCustomer,
          headerDraft: {
            orderDate: current.header.orderDate,
            deliveryExpectedDate: current.header.deliveryDate,
            warehouseName: current.header.warehouseName
          }
        });
        batch.intakeSessionId = captured.session.intakeSessionId;
        batch.sourceImageId = captured.imagePart?.sourcePartId || state.sourceImages[modeId]?.sourceImageId || '';
        batch.sourceImageHash = state.sourceImages[modeId]?.contentHash || '';
        batch.intakeDocumentId = analyzed.document.intakeDocumentId;
        analyzedDocument = analyzed.document;
        lines = analyzed.lines;
      } catch (error) {
        lines = fallbackLines(rawText, batch);
        if (!lines.length) throw error;
        if (!automatic) toast('자동 파서가 인식하지 못한 원문은 직접 확인할 행으로 추가했습니다.', 'error');
      }
    } else {
      lines = fallbackLines(rawText, batch);
    }

    lines = lines.filter(line => !isParserArtifactLine(line));
    if (['purchase','sale'].includes(state.draft.activeMode) && !structuredImport && method.id === 'paste') {
      const sale = state.draft.activeMode === 'sale';
      lines = lines.map(line => ({ ...line, sourceType: 'DIRECT', contractKind: sale ? 'SALE_STAGE4_V1' : 'PURCHASE_STAGE3_V1',
        originSystem: 'SMARTINPUT_CLIPBOARD', originTransactionId: contentHash, sourceFingerprint: contentHash,
        ...(sale ? { actualToBaseFactor:1, actualToRecognizedFactor:0, actualUnit:line.unit || '', baseUnit:line.unit || '', recognizedUnit:line.unit || '',
          conversionSource:'DIRECT_SAME_UNIT', conversionRuleId:'DIRECT_1_TO_1', conversionRuleVersion:'DIRECT_1_TO_1_V1' } : {}), metaStatus: 'DIRECT' }));
    }
    if (!lines.length) throw new Error('상품 행을 인식하지 못했습니다. 상품명과 수량을 확인해 주세요.');
    if (requestId !== state.analysisRequestId || state.draft.activeMode !== modeId || sourceTextInput.value !== rawText) return;
    const liveBatchIds = new Set(current.batches.filter(item => item.sourceRole === 'LIVE_SOURCE').map(item => item.batchId));
    const previousLiveRows = current.rows.filter(row => liveBatchIds.has(row.batchId));
    const firstLiveRowIndex = current.rows.findIndex(row => liveBatchIds.has(row.batchId));
    const insertionIndex = firstLiveRowIndex < 0
      ? current.rows.length
      : current.rows.slice(0, firstLiveRowIndex).filter(row => !liveBatchIds.has(row.batchId)).length;
    current.batches = current.batches.filter(item => item.sourceRole !== 'LIVE_SOURCE');
    current.rows = current.rows.filter(row => !liveBatchIds.has(row.batchId));
    current.batches.push(batch);
    current.rows = contract.applyParserResults(current.rows, batch, lines);
    current.rows.filter(row => row.batchId === batch.batchId).forEach(row => {
      const previous = previousLiveRows.find(item => String(item.rawText || '').trim() === String(row.rawText || '').trim());
      if (!previous) return;
      contract.ROW_FIELDS.forEach(field => {
        if (previous.editedFields?.[field]) row[field] = previous[field];
      });
      if (previous.editedFields?.unitPrice) row.sourceUnitPrice = previous.sourceUnitPrice;
      row.editedFields = { ...(previous.editedFields || {}) };
      if (previous.unitPriceReviewStatus === 'CONFIRMED' && Number(previous.unitPrice) === Number(row.unitPrice)) {
        row.unitPriceReviewStatus = 'CONFIRMED';
      }
    });
    const liveRows = current.rows.filter(row => row.batchId === batch.batchId);
    const otherRows = current.rows.filter(row => row.batchId !== batch.batchId);
    current.rows = [...otherRows.slice(0, insertionIndex), ...liveRows, ...otherRows.slice(insertionIndex)];
    current.rows.forEach(row => enrichRowFromUnifiedCatalog(row));
    resolveStage1RowReferences(current.rows);
    current.rows = contract.markDuplicatePossibilities(current.rows);
    current.sourceText = rawText;
    current.delivery = { status: 'DRAFT', targetId: '', targetRecordId: '', deliveredAt: '' };
    state.pendingImageEvidence = null;
    state.pendingOcrReview = null;
    state.pendingSourceName = '';
    state.pendingStructuredImport = null;
    resizeSource();
    if (!current.header.customerId && analyzedDocument?.confirmedCustomerId) {
      applyCustomer(
        { customerId: analyzedDocument.confirmedCustomerId, customerName: analyzedDocument.confirmedCustomerName },
        { rematch: false, mappingSource: 'PARSER_CONFIRMED', learnAlias: false }
      );
    }
    renderRows();
    renderDelivery();
    saveDraftNow();
    const summary = contract.summarizeRows(current.rows);
    const structuredSummary = structuredImport
      ? ` · 헤더 ${structuredImport.headerRowNumber}행 · 필드 ${structuredImport.mappings.length}개`
      : '';
    setAppStatus(`${activityLabel(method.id)} 분석 완료 · ${lines.length}행${structuredSummary} · 일치 ${summary.matched} · 확인 ${summary.similar} · 미인식 ${summary.unresolved}`);
    $('sourceNotice').textContent = structuredImport
      ? `${structuredImport.sheetName} · ${structuredImport.mappings.map(mapping => mapping.sourceHeader).join(' · ')} 필드를 입력표에 반영했습니다.`
      : '노랑: 수집된 상품 · 빨강: 마스터 미확정 · 주문자명/시간: 고정 구분색';
    if (!current.header.customerId) {
      $('customerHint').textContent = '거래처를 인식하지 못했습니다. 등록 거래처를 선택하세요.';
      if (!automatic) {
        $('customerInput').focus();
        toast('거래처를 인식하지 못해 거래처 입력란으로 이동했습니다.', 'error');
      }
    }
  } catch (error) {
    if (!automatic) {
      setAppStatus('분석을 완료하지 못했습니다. 원문은 그대로 유지됩니다.', 'error');
      toast(error.message || '자료 분석에 실패했습니다.', 'error');
    } else {
      $('sourceNotice').textContent = '상품명과 수량을 입력하면 자동으로 다시 분석합니다.';
    }
  } finally {
    state.busy = false;
    setActiveActivity('');
    renderReferenceControls();
    $('parserProgress').hidden = true;
    renderDelivery();
    renderSourceAnalysis();
    if (sourceTextInput.value !== rawText) scheduleAutoAnalysis(420);
  }
}

async function handleFile(file) {
  if (!file) return;
  invalidateGridPasteUndo();
  state.pendingStructuredImport = null;
  try {
    updateMethod('excel');
    setActiveActivity('Excel·파일 불러오는 중');
    setAppStatus(`${file.name} 파일을 읽고 있습니다.`);
    let rawText = '';
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      await ensureXlsx();
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const fileHashBuffer = await crypto.subtle.digest('SHA-256', fileBytes);
      const fileDigest = [...new Uint8Array(fileHashBuffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const workbook = window.XLSX.read(fileBytes, { type: 'array', cellDates: false, cellText: true });
      let firstReadable = null;
      let structured = null;
      let purchaseMetaRows = null;
      let salesMetaRows = null;
      workbook.SheetNames.forEach(sheetName => {
        if (!workbook.Sheets[sheetName]?.['!ref']) return;
        const matrix = window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: true });
        if (isPurchaseMetaSheet(sheetName, matrix)) {
          if (state.draft.activeMode === 'purchase') purchaseMetaRows = readPurchaseMeta(matrix);
          return;
        }
        if (isSalesMetaSheet(sheetName, matrix)) {
          if (state.draft.activeMode === 'sale') salesMetaRows = readSalesMeta(matrix);
          return;
        }
        const parsed = parseStructuredSheet(matrix, {
          fieldDefinitions: structuredFieldsForMode(state.draft.activeMode, contract.PRODUCT_FIELD_DEFINITIONS),
          numberParser: contract.numberOrNull,
          sheetName
        });
        const candidate = { ...parsed, sheetName };
        if (!firstReadable) firstReadable = candidate;
        if (!candidate.structured) return;
        if (!structured || candidate.score > structured.score
          || (candidate.score === structured.score && candidate.rows.length > structured.rows.length)) structured = candidate;
      });
      const selected = structured || firstReadable;
      if (!selected) throw new Error('읽을 수 있는 Excel 시트가 없습니다.');
      if (structured && state.draft.activeMode === 'purchase' && purchaseMetaRows) {
        structured = {
          ...structured,
          rows: joinPurchaseMeta({
            visibleSheetName: structured.sheetName,
            visibleRows: structured.rows.map(row => ({
              ...row, directOriginSystem: 'SMARTINPUT_FILE', directOriginTransactionId: fileDigest
            })),
            metaRows: purchaseMetaRows
          }),
          purchaseMetaStatus: 'VERIFIED'
        };
      } else if (structured && state.draft.activeMode === 'purchase') {
        structured = {
          ...structured,
          rows: structured.rows.map(row => ({
            ...row,
            sourceType: 'DIRECT',
            contractKind: 'PURCHASE_STAGE3_V1',
            originSystem: 'SMARTINPUT_FILE',
            originTransactionId: fileDigest,
            sourceFingerprint: fileDigest,
            sourceDocumentKey: row.sourceDocumentKey || stableDirectDocumentKey({
              originSystem: 'SMARTINPUT_FILE', originTransactionId: fileDigest,
              externalDocumentNo: row.rowVoucherNo, sourceVoucherIndex: row.sourceVoucherIndex
            }),
            metaStatus: 'DIRECT_NO_META'
          }))
        };
      } else if (structured && state.draft.activeMode === 'sale' && salesMetaRows) {
        structured = {
          ...structured,
          rows: joinSalesMeta({ visibleSheetName: structured.sheetName,
            visibleRows: structured.rows.map(row => ({ ...row, directOriginSystem: 'SMARTINPUT_FILE', directOriginTransactionId: fileDigest })),
            metaRows: salesMetaRows }),
          salesMetaStatus: 'VERIFIED'
        };
      } else if (structured && state.draft.activeMode === 'sale') {
        structured = { ...structured, rows: structured.rows.map(row => ({ ...row,
          sourceType:'DIRECT', contractKind:'SALE_STAGE4_V1', originSystem:'SMARTINPUT_FILE', originTransactionId:fileDigest,
          sourceFingerprint:fileDigest, actualToBaseFactor:1, actualToRecognizedFactor:0,
          actualUnit:row.unit || '', baseUnit:row.unit || '', recognizedUnit:row.unit || '',
          conversionSource:'DIRECT_SAME_UNIT', conversionRuleId:'DIRECT_1_TO_1', conversionRuleVersion:'DIRECT_1_TO_1_V1', metaStatus:'DIRECT_NO_META' })) };
      }
      rawText = selected.rawText;
      state.pendingSourceName = `${file.name} · ${selected.sheetName}`;
      state.pendingStructuredImport = structured
        ? { ...structured, rawText, modeId: state.draft.activeMode, fileName: file.name }
        : null;
    } else {
      rawText = await file.text();
      state.pendingSourceName = file.name;
      state.pendingStructuredImport = null;
    }
    sourceTextInput.value = rawText;
    syncSourceText();
    if (state.pendingStructuredImport) {
      const imported = state.pendingStructuredImport;
      const warning = imported.invalidCells.length ? ` · 숫자 확인 ${imported.invalidCells.length}셀` : '';
      setAppStatus(`${file.name} · ${imported.sheetName} ${imported.headerRowNumber}행에서 필드 ${imported.mappings.length}개를 찾았습니다${warning}.`);
      toast(`필드명을 찾아 상품 ${imported.rows.length}행을 자동 입력합니다.`, 'success');
    } else {
      setAppStatus(`${file.name}을 불러왔습니다. 자동 분석을 시작합니다.`);
      toast('표 필드를 찾지 못해 기존 텍스트 방식으로 자동 분석합니다.', 'success');
    }
  } catch (error) {
    toast(error.message || '파일을 읽지 못했습니다.', 'error');
    setAppStatus('파일을 읽지 못했습니다.', 'error');
  } finally {
    setActiveActivity('');
    $('fileInput').value = '';
  }
}

function isImageFile(file) {
  return Boolean(file) && (String(file.type || '').startsWith('image/') || /\.(?:jpe?g|png|webp|gif|bmp)$/i.test(file.name || ''));
}

function isParserDocumentFile(file) {
  return Boolean(file) && /\.(?:xlsx?|csv|tsv|txt)$/i.test(file.name || '');
}

function appendParserText(text, method = 'text') {
  if (!text) return;
  updateMethod(method);
  const separator = sourceTextInput.value && !sourceTextInput.value.endsWith('\n') ? '\n' : '';
  sourceTextInput.value += `${separator}${text}`;
  syncSourceText();
}

async function acceptParserDrop(event) {
  event.preventDefault();
  const file = [...(event.dataTransfer?.files || [])][0];
  if (file) {
    if (isImageFile(file)) await recognizeImage(file);
    else if (isParserDocumentFile(file)) await handleFile(file);
    else toast('지원하지 않는 파일 형식입니다.', 'error');
    return;
  }
  const droppedText = event.dataTransfer?.getData('text/plain') || '';
  appendParserText(droppedText);
}

async function fileToImageEvidence(file) {
  const buffer = await file.arrayBuffer();
  const digest = crypto?.subtle ? await crypto.subtle.digest('SHA-256', buffer) : null;
  const contentHash = digest ? [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') : '';
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('이미지를 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
  return {
    sourceImageId: contentHash ? `SIIMG-${contentHash}` : createRecordId('SIIMG'),
    fileName: file.name || '붙여넣은 이미지',
    mimeType: file.type || 'image/png',
    byteLength: file.size || buffer.byteLength,
    contentHash,
    dataUrl,
    binaryBase64: dataUrl.split(',')[1] || ''
  };
}

async function persistSourceImageForMode(mode = state.draft.activeMode) {
  const sourceImage = state.sourceImages[mode];
  const documentId = state.draft.modes[mode]?.documentId;
  if (!sourceImage?.dataUrl || !documentId) return;
  const record = {
    ...sourceImage,
    documentId,
    mode,
    updatedAt: new Date().toISOString()
  };
  state.sourceImages[mode] = record;
  state.sourceImageRecords.set(documentId, record);
  try {
    await saveSourceImage(record);
    return true;
  } catch (_) {
    return false;
  }
}

async function recognizeImage(file) {
  if (!isImageFile(file)) return;
  invalidateGridPasteUndo();
  const captureSequence = ++state.photoCaptureSequence;
  updateMethod('photo');
  let imageEvidence;
  try {
    imageEvidence = await fileToImageEvidence(file);
  } catch (error) {
    if (captureSequence === state.photoCaptureSequence) {
      toast(error.message || '원본 사진을 불러오지 못했습니다.', 'error');
      setAppStatus('원본 사진을 불러오지 못했습니다.', 'error');
    }
    $('photoInput').value = '';
    return;
  }
  if (captureSequence !== state.photoCaptureSequence) return;
  state.pendingImageEvidence = imageEvidence;
  state.sourceImages[state.draft.activeMode] = imageEvidence;
  state.pendingSourceName = imageEvidence.fileName;
  imageEvidence.notice = '원본 사진을 유지한 채 상품표를 분석하고 있습니다.';
  renderSourceSurface();
  void persistSourceImageForMode();
  $('photoInput').value = '';
  if (!modeDraft().rows.length) renderRows({ restoreFocus: false });
  if (state.busy) {
    setAppStatus('원본 사진을 불러왔습니다. 진행 중인 분석이 끝나면 사진 분석을 시작합니다.');
    while (state.busy && currentSourceImage()?.sourceImageId === imageEvidence.sourceImageId) {
      await new Promise(resolve => window.setTimeout(resolve, 120));
    }
  }
  if (captureSequence !== state.photoCaptureSequence || currentSourceImage()?.sourceImageId !== imageEvidence.sourceImageId) return;
  state.pendingImageEvidence = imageEvidence;
  state.busy = true;
  $('analyzeButton').disabled = true;
  $('parserProgress').hidden = false;
  $('parserProgress').querySelector('strong').textContent = '사진에서 문자를 추출하고 있습니다.';
  setActiveActivity('사진 OCR 처리 중');
  let shouldAnalyze = false;
  try {
    await persistSourceImageForMode();
    renderSourceSurface();
    await ensureTesseract();
    const analysis = await recognizeOcrDocument(file, {
      Tesseract: window.Tesseract,
      onProgress: progress => {
        const percent = Math.round(Number(progress.progress || 0) * 100);
        if (progress.status === 'preprocessing') {
          $('parserProgress').querySelector('strong').textContent = `${progress.variant || '사진'} 전처리 중`;
        } else if (progress.status === 'table-region') {
          $('parserProgress').querySelector('strong').textContent = '상품표 영역을 다시 인식하고 있습니다.';
        } else if (progress.status === 'recognizing text') {
          $('parserProgress').querySelector('strong').textContent = `사진 문자 추출 ${percent}%`;
        }
      }
    });
    const text = String(analysis.rawText || '').replace(/\r/g, '');
    if (!text.trim()) throw new Error('사진에서 문자를 찾지 못했습니다.');
    state.pendingOcrReview = { ...analysis, rawText: text };
    sourceTextInput.value = text;
    modeDraft().sourceText = text;
    scheduleSave();
    resizeSource();
    renderSourceAnalysis();
    if (analysis.status === 'VERIFIED') {
      shouldAnalyze = true;
      const totals = analysis.calculatedTotal;
      $('sourceNotice').textContent = `OCR 검증 완료 · ${analysis.validRows.length}행 · 수량 ${totals.quantity.toLocaleString('ko-KR')} · 금액 ${totals.amount.toLocaleString('ko-KR')}원`;
      state.sourceImages[state.draft.activeMode].notice = `검증 완료 · ${analysis.validRows.length}행 · 수량 ${totals.quantity.toLocaleString('ko-KR')} · 금액 ${totals.amount.toLocaleString('ko-KR')}원`;
      await persistSourceImageForMode();
      renderSourceSurface();
      setAppStatus('사진의 행 산식과 합계가 일치했습니다. 검증된 상품만 자동 분석합니다.');
      toast('OCR 검증을 통과한 상품행만 입력합니다.', 'success');
    } else {
      const current = modeDraft();
      const liveBatchIds = new Set(current.batches.filter(batch => batch.sourceRole === 'LIVE_SOURCE').map(batch => batch.batchId));
      current.batches = current.batches.filter(batch => batch.sourceRole !== 'LIVE_SOURCE');
      current.rows = current.rows.filter(row => !liveBatchIds.has(row.batchId));
      renderRows();
      const totals = analysis.calculatedTotal;
      $('sourceNotice').textContent = `OCR 확인 필요 · 검증 ${analysis.validRows.length}행 · 오류 ${analysis.invalidRows.length}행 · 계산 ${totals.amount.toLocaleString('ko-KR')}원`;
      state.sourceImages[state.draft.activeMode].notice = `확인 필요 · 검증 ${analysis.validRows.length}행 · 오류 ${analysis.invalidRows.length}행`;
      await persistSourceImageForMode();
      renderSourceSurface();
      setAppStatus('OCR 산식·합계 검증이 일치하지 않아 상품행을 생성하지 않았습니다.', 'error');
      toast('OCR 확인이 필요합니다. 원문은 유지되고 상품행은 생성하지 않았습니다.', 'error');
    }
  } catch (error) {
    state.pendingOcrReview = null;
    if (state.sourceImages[state.draft.activeMode]) {
      state.sourceImages[state.draft.activeMode].notice = '자동 인식에 실패했습니다. 원본 사진을 보면서 직접 입력할 수 있습니다.';
      void persistSourceImageForMode();
      renderSourceSurface();
    }
    toast(error.message || '사진 문자를 추출하지 못했습니다.', 'error');
    setAppStatus('사진 OCR을 완료하지 못했습니다. 직접 입력할 수 있습니다.', 'warn');
  } finally {
    state.busy = false;
    setActiveActivity('');
    $('photoInput').value = '';
    renderReferenceControls();
    $('parserProgress').hidden = true;
    $('parserProgress').querySelector('strong').textContent = '자료를 분석하고 있습니다.';
    if (!modeDraft().rows.length) renderRows({ restoreFocus: false });
    if (shouldAnalyze) scheduleAutoAnalysis(80);
  }
}

function toggleVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    toast('이 브라우저는 음성 입력을 지원하지 않습니다.', 'error');
    return;
  }
  if (state.listening && state.recognition) {
    state.recognition.stop();
    return;
  }
  const recognition = new Recognition();
  recognition.lang = 'ko-KR';
  recognition.continuous = true;
  recognition.interimResults = true;
  state.recognition = recognition;
  recognition.onstart = () => {
    state.listening = true;
    updateMethod('voice');
    setActiveActivity('음성 STT 인식 중');
    $('sourceNotice').textContent = '음성을 듣고 있습니다. 다시 누르면 종료됩니다.';
    setAppStatus('음성 입력 중입니다.');
  };
  recognition.onresult = event => {
    let finalText = '';
    let interimText = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || '';
      if (event.results[index].isFinal) finalText += transcript;
      else interimText += transcript;
    }
    if (finalText.trim()) {
      sourceTextInput.value += `${sourceTextInput.value && !sourceTextInput.value.endsWith('\n') ? '\n' : ''}${finalText.trim()}`;
      syncSourceText();
    }
    $('sourceNotice').textContent = interimText ? `인식 중: ${interimText}` : '음성을 듣고 있습니다.';
  };
  recognition.onerror = event => {
    toast(event.error === 'not-allowed' ? '마이크 사용 권한이 필요합니다.' : '음성 인식을 완료하지 못했습니다.', 'error');
  };
  recognition.onend = () => {
    state.listening = false;
    state.recognition = null;
    setActiveActivity('');
    $('sourceNotice').textContent = '음성 입력이 종료되었습니다. 내용을 확인하세요.';
    setAppStatus('음성 입력 내용을 확인할 수 있습니다.');
  };
  recognition.start();
}

function exactProduct(query) {
  const result = classifyProductMatch(state.productMatchIndex, query);
  return result.autoConfirm ? result.product : null;
}

function commonMasterProducts() {
  return state.products.filter(isSelectableMasterProduct);
}

function hasMasterProductIdentity(row) {
  return Boolean(String(row?.masterProductId || '').trim() && String(row?.productId || '').trim() && String(row?.itemCode || '').trim());
}

function priceFromProduct(product) {
  const price = product.priceOptions?.find(option => option.key === 'salePrice')
    || product.priceOptions?.find(option => Number.isFinite(Number(option.value)));
  return price ? Number(price.value) : null;
}

function masterFieldValue(product, field) {
  const sources = [product, product?.raw].filter(source => source && typeof source === 'object');
  const keys = [...new Set([field.id, ...(field.masterAliases || [])])];
  for (const source of sources) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      if (value === undefined || value === null || String(value).trim() === '') continue;
      return field.valueType === 'NUMBER' ? contract.numberOrNull(value) : String(value).trim();
    }
  }
  return undefined;
}

function applyProduct(row, product, { forceIdentityFields = false, preserveIdentityField = '' } = {}) {
  if (!row || !isSelectableMasterProduct(product)) return false;
  const protect = field => Boolean(row.editedFields?.[field]);
  const preserveIdentity = field => !forceIdentityFields
    && (preserveIdentityField ? field === preserveIdentityField : protect(field));
  row.masterProductId = String(product.masterProductId || '').trim();
  row.productId = row.masterProductId ? product.productId || '' : '';
  if (!preserveIdentity('itemCode')) row.itemCode = product.itemCode || '';
  if (!preserveIdentity('itemName')) row.itemName = product.itemName || '';
  if (!protect('secondaryName')) row.secondaryName = product.secondaryName || '';
  if (!protect('searchInfo')) row.searchInfo = product.searchInfo || '';
  if (!protect('specification')) row.specification = product.specification || '';
  if (!protect('boxQuantity')) row.boxQuantity = product.boxQuantity;
  if (!protect('unit')) row.unit = product.finalUnit || product.unit || '';
  if (!protect('unitPrice') && row.unitPrice == null) row.unitPrice = priceFromProduct(product);
  const priceOptions = new Map((product.priceOptions || []).map(option => [option.key, option.value]));
  ['outPrice', 'wholesaleA', 'wholesaleB', 'listingPrice', 'marketPrice', 'promoPrice',
    'purchasePriceB', 'priceD', 'lastPurchasePrice', 'priceH', 'priceI'].forEach(field => {
    if (!protect(field)) row[field] = priceOptions.get(field) ?? product[field] ?? null;
  });
  const identityFields = new Set(['itemCode', 'itemName', 'specification', 'unit', 'secondaryName', 'searchInfo', 'boxQuantity']);
  contract.PRODUCT_FIELD_DEFINITIONS.forEach(field => {
    if (identityFields.has(field.id) || protect(field.id)) return;
    const value = masterFieldValue(product, field);
    if (value !== undefined) row[field.id] = value;
  });
  row.matchStatus = hasMasterProductIdentity(row) ? 'MATCHED' : 'UNRESOLVED';
  row.reviewStatus = row.matchStatus === 'MATCHED' ? 'CONFIRMED' : 'PENDING';
  row.productIdentityStatus = row.matchStatus === 'MATCHED' ? 'MASTER_LINKED' : 'UNRESOLVED';
  row.matchSource = row.matchStatus === 'MATCHED' ? 'SMART_INPUT_PRODUCT_SNAPSHOT_V1' : '';
  row.candidateProducts = [];
  row.referenceResolution = row.matchStatus === 'MATCHED' ? 'MATCHED' : 'MISSING';
  row.unregisteredProductQuery = '';
  return row.matchStatus === 'MATCHED';
}

function referenceQueryForRow(row) {
  if (row?.editedFields?.itemCode) return row.itemCode;
  if (row?.editedFields?.itemName) return row.itemName;
  return row?.externalItemCode
    || row?.productText
    || row?.rawExpression
    || row?.unregisteredProductQuery
    || row?.itemCode
    || row?.itemName
    || row?.rawText
    || '';
}

function reconcileProductRowsAfterRevision() {
  Object.values(state.draft.modes || {}).forEach(current => {
    current.rows = (current.rows || []).map(row => {
      const identity = state.products.find(product => (
        row.masterProductId && product.masterProductId === row.masterProductId
      ) || (row.itemCode && normalizedKey(product.itemCode) === normalizedKey(row.itemCode)));
      if (identity) {
        applyProduct(row, identity, { forceIdentityFields: false });
        return row;
      }
      const query = row.itemCode || row.itemName || row.unregisteredProductQuery || row.rawText;
      if (!query) return row;
      const match = classifyProductMatch(state.productMatchIndex, query, { limit: 5 });
      if (match.autoConfirm) {
        applyProduct(row, match.product, { forceIdentityFields: false });
        return row;
      }
      row.productId = '';
      row.masterProductId = '';
      row.matchSource = '';
      row.candidateProducts = match.candidates;
      row.matchStatus = match.candidates.length ? 'SIMILAR' : 'UNRESOLVED';
      row.reviewStatus = 'PENDING';
      row.productIdentityStatus = match.candidates.length ? 'UNRESOLVED' : 'STALE_SELECTION';
      row.referenceResolution = match.candidates.length ? 'FUZZY_CONFIRMATION_REQUIRED' : 'STALE_SELECTION';
      return row;
    });
    current.rows = contract.markDuplicatePossibilities(current.rows);
  });
}

function activatePendingReferences({ explicit = true, render = true } = {}) {
  const domains = ['product', 'customer'].filter(domain => state.references[domain].pending);
  if (!domains.length) return false;
  const diffs = domains.map(domain => diffReferenceSnapshots(
    domain,
    state.references[domain].active,
    state.references[domain].pending
  ));
  if (explicit) {
    const detail = diffs.map(diff => `${referenceDomainLabel(diff.domain)} ${diff.fromRevision || '없음'} → ${diff.toRevision || '없음'} · +${diff.added} / -${diff.removed} / 변경 ${diff.changed}`).join('\n');
    if (!window.confirm(`보류 중인 기준정보를 현재 작업에 적용하시겠습니까?\n${detail}\n관리자가 편집한 필드와 현재 입력·행 선택은 유지됩니다.`)) return false;
  }
  domains.forEach(domain => {
    const pending = state.references[domain].pending;
    applyReferenceSnapshot(domain, pending);
    if (domain === 'product' && explicit) reconcileProductRowsAfterRevision();
    void persistReferenceState(domain);
  });
  refreshReferenceAggregate();
  if (explicit) saveDraftNow();
  if (render) renderMode();
  if (explicit) toast('새 기준정보를 현재 작업에 적용했습니다. 관리자 편집값과 행 선택은 유지했습니다.', 'success');
  return true;
}

async function queueOwnerRegistration(domain, prefill, context = {}) {
  const request = buildRegistrationChangeRequest(domain, prefill, {
    mode: state.draft.activeMode,
    documentId: modeDraft().documentId,
    ...context
  });
  const result = await submitRegistrationChangeRequest(domain, request);
  toast(result.accepted
    ? `${referenceDomainLabel(domain)} 등록 변경요청을 소유 앱에 접수했습니다.`
    : `${referenceDomainLabel(domain)}관리 화면을 열었습니다. 변경요청 ${result.status || '실패'} · 등록 후 해당 기준정보만 다시 불러오세요.`, result.accepted ? 'success' : 'warn');
  return result;
}

function enrichRowFromUnifiedCatalog(row) {
  if (!row || (row.matchStatus === 'MATCHED' && row.matchSource === 'SMART_INPUT_PRODUCT_SNAPSHOT_V1')) return row;
  const query = referenceQueryForRow(row);
  if (!query) return row;
  row.productId = '';
  row.masterProductId = '';
  row.matchSource = '';
  const match = classifyProductMatch(state.productMatchIndex, query, { limit: 5 });
  if (match.autoConfirm) {
    applyProduct(row, match.product);
    return row;
  }
  if (match.candidates.length) {
    row.candidateProducts = match.candidates;
    row.matchStatus = 'SIMILAR';
    row.reviewStatus = 'PENDING';
    row.productIdentityStatus = 'UNRESOLVED';
    row.referenceResolution = 'FUZZY_CONFIRMATION_REQUIRED';
  } else {
    row.referenceResolution = state.references.product.active ? 'MISSING' : 'REFERENCE_ERROR';
  }
  return row;
}

function rematchQuery(row, changedField = '') {
  if (changedField === 'itemName') return row.itemName || row.itemCode;
  return row.itemCode || row.itemName;
}

function tryMatchRow(row, changedField = '', { focusTarget = null } = {}) {
  const query = rematchQuery(row, changedField);
  row.productId = '';
  row.masterProductId = '';
  row.matchSource = '';
  row.reviewStatus = 'PENDING';
  row.productIdentityStatus = 'UNRESOLVED';
  const match = classifyProductMatch(state.productMatchIndex, query, { limit: 5 });
  let openCandidates = false;
  if (match.autoConfirm) {
    applyProduct(row, match.product, { forceIdentityFields: false });
  } else if (query) {
    row.candidateProducts = match.candidates;
    row.matchStatus = row.candidateProducts.length ? 'SIMILAR' : 'UNRESOLVED';
    row.referenceResolution = row.candidateProducts.length
      ? 'FUZZY_CONFIRMATION_REQUIRED'
      : (state.references.product.active ? 'MISSING' : 'REFERENCE_ERROR');
    row.unregisteredProductQuery = row.candidateProducts.length ? '' : query;
    openCandidates = row.candidateProducts.length > 0;
  } else {
    row.candidateProducts = [];
    row.matchStatus = 'UNRESOLVED';
    row.referenceResolution = '';
  }
  modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
  if (openCandidates) modeUi().activeCellId = '';
  renderRows({ restoreFocus: !openCandidates && !focusTarget });
  saveDraftNow();
  const liveRow = modeDraft().rows.find(item => item.rowId === row.rowId) || row;
  if (openCandidates) openProductDialog(liveRow, { query, focusTarget, returnField: changedField });
  else if (focusTarget) focusGridTarget(focusTarget);
}

function trySearchProductRow(row, query = '', { focusTarget = null } = {}) {
  const searchText = String(query || '').trim();
  if (!row || !searchText) return;
  invalidateGridPasteUndo();
  const match = classifyProductMatch(state.productMatchIndex, searchText, { limit: 12 });
  if (match.autoConfirm) {
    applyProduct(row, match.product, { forceIdentityFields: false });
    modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
    renderRows({ restoreFocus: false });
    saveDraftNow();
    if (focusTarget) focusGridTarget(focusTarget);
    return;
  }
  if (!match.candidates.length) {
    row.candidateProducts = [];
    row.matchStatus = 'UNRESOLVED';
    row.reviewStatus = 'PENDING';
    row.productIdentityStatus = 'UNRESOLVED';
    row.referenceResolution = state.references.product.active ? 'MISSING' : 'REFERENCE_ERROR';
    row.unregisteredProductQuery = searchText;
    renderRows({ restoreFocus: false });
    saveDraftNow();
    toast(state.references.product.active ? '미등록 상품입니다. 현재 행과 입력값은 유지됩니다.' : '상품 기준정보 로드 실패입니다. 현재 행과 입력값은 유지됩니다.', 'error');
    gridInput(row.rowId, 'productSearch')?.focus();
    return;
  }
  openProductDialog(row, { query: searchText, focusTarget, returnField: 'productSearch' });
}

function matchGridPasteRow(row) {
  if (!row) return row;
  const query = row.itemCode || row.itemName;
  const match = classifyProductMatch(state.productMatchIndex, query, { limit: 5 });
  if (match.autoConfirm) {
    applyProduct(row, match.product, { forceIdentityFields: false });
    return row;
  }
  if (!query) {
    row.candidateProducts = [];
    row.matchStatus = 'UNRESOLVED';
    row.reviewStatus = 'PENDING';
    row.productIdentityStatus = 'UNRESOLVED';
    row.referenceResolution = '';
    return row;
  }
  row.candidateProducts = match.candidates;
  row.matchStatus = match.candidates.length ? 'SIMILAR' : 'UNRESOLVED';
  row.reviewStatus = 'PENDING';
  row.productIdentityStatus = 'UNRESOLVED';
  row.referenceResolution = match.candidates.length
    ? 'FUZZY_CONFIRMATION_REQUIRED'
    : (state.references.product.active ? 'MISSING' : 'REFERENCE_ERROR');
  row.unregisteredProductQuery = match.candidates.length ? '' : query;
  return row;
}

function openProductDialog(row, { query = '', focusTarget = null, returnField = '' } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'customer-picker-dialog';
  const shell = document.createElement('div');
  shell.className = 'customer-picker-shell';
  const header = document.createElement('header');
  const heading = document.createElement('div');
  const small = document.createElement('small');
  small.textContent = 'Product Master';
  const title = document.createElement('h2');
  title.textContent = '상품 후보 선택';
  heading.append(small, title);
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', '닫기');
  close.textContent = '×';
  header.append(heading, close);
  const label = document.createElement('label');
  label.className = 'customer-picker-search';
  label.append('상품명 또는 코드');
  const search = document.createElement('input');
  search.type = 'search';
  search.value = query || row.itemCode || row.itemName || '';
  label.append(search);
  const message = document.createElement('div');
  message.className = 'customer-picker-message';
  const results = document.createElement('div');
  results.className = 'customer-picker-results';
  shell.append(header, label, message, results);
  dialog.append(shell);
  document.body.append(dialog);

  const finish = product => {
    const liveRow = modeDraft().rows.find(item => item.rowId === row.rowId) || row;
    if (product) {
      const before = { ...liveRow, customValues: { ...(liveRow.customValues || {}) } };
      if (!applyProduct(liveRow, product, { forceIdentityFields: true })) {
        message.textContent = '공통 상품 마스터에 등록된 정상 상품만 선택할 수 있습니다.';
        return;
      }
      if (isLinkedRow(liveRow)) {
        const productSyncFields = ['masterProductId', 'productId', 'itemCode', 'itemName', 'secondaryName', 'searchInfo',
          'specification', 'boxQuantity', 'unit', 'unitPrice', 'sourceUnitPrice', 'outPrice', 'wholesaleA', 'wholesaleB',
          'listingPrice', 'marketPrice', 'promoPrice', 'purchasePriceB', 'priceD', 'lastPurchasePrice', 'priceH', 'priceI',
          'matchStatus', 'reviewStatus', 'productIdentityStatus', 'matchSource', 'referenceResolution'];
        liveRow.linkedSyncFields = [...new Set([...(liveRow.linkedSyncFields || []), ...productSyncFields.filter(field => String(before[field] ?? '') !== String(liveRow[field] ?? ''))])];
      }
      modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
      renderRows({ restoreFocus: false });
      if (isLinkedRow(liveRow)) scheduleSave();
      else saveDraftNow();
    }
    dialog.close();
    dialog.remove();
    window.requestAnimationFrame(() => {
      if (product && focusTarget) focusGridTarget(focusTarget);
      else if (!product) gridInput(liveRow.rowId, returnField)?.focus();
    });
  };
  let foundProducts = [];
  let selectedIndex = 0;
  const updateSelection = (nextIndex, { scroll = true } = {}) => {
    if (!foundProducts.length) {
      selectedIndex = 0;
      search.removeAttribute('aria-activedescendant');
      return;
    }
    selectedIndex = Math.max(0, Math.min(nextIndex, foundProducts.length - 1));
    const buttons = [...results.querySelectorAll('.customer-picker-result')];
    buttons.forEach((button, index) => {
      const selected = index === selectedIndex;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-selected', String(selected));
      if (selected) {
        search.setAttribute('aria-activedescendant', button.id);
        if (scroll) button.scrollIntoView({ block: 'nearest' });
      }
    });
    message.textContent = `${foundProducts.length}개 후보 · ${selectedIndex + 1}번째 항목 선택 · ↑↓ 이동 · Enter 확정`;
  };
  const render = () => {
    foundProducts = searchProductMatchIndex(state.productMatchIndex, search.value, 12);
    selectedIndex = 0;
    results.innerHTML = '';
    message.textContent = foundProducts.length ? `${foundProducts.length}개 후보 · 자동 확정되지 않습니다. 확인 후 선택하세요.` : '일치하는 상품 후보가 없습니다. 현재 행은 유지됩니다.';
    foundProducts.forEach((product, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `product-candidate-${index}`;
      button.className = `customer-picker-result${index === 0 ? ' is-selected' : ''}`;
      button.setAttribute('aria-selected', String(index === 0));
      const strong = document.createElement('strong');
      strong.textContent = product.itemName || '상품명 없음';
      const code = document.createElement('span');
      code.textContent = product.itemCode || '코드 없음';
      const detail = document.createElement('small');
      detail.textContent = [product.specification, product.finalUnit].filter(Boolean).join(' · ') || '추가 정보 없음';
      button.append(strong, code, detail);
      button.addEventListener('click', () => finish(product));
      results.append(button);
    });
    updateSelection(0, { scroll: false });
  };
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 90);
  });
  search.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      updateSelection(selectedIndex + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      updateSelection(selectedIndex - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (foundProducts[selectedIndex]) finish(foundProducts[selectedIndex]);
    }
  });
  close.addEventListener('click', () => finish(null));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
  dialog.showModal();
  search.focus();
  render();
}

function estimateComparisonPrices(current = modeDraft()) {
  const currentPrices = buildCatalogPriceSnapshot(current.rows);
  const baselinePrices = current.catalogBaselinePrices || {};
  return priceSnapshotsEqual(currentPrices, baselinePrices)
    ? (current.catalogPreviousPrices || {})
    : baselinePrices;
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error('공지 이미지를 생성하지 못했습니다.'));
  }, 'image/png'));
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyNoticeCanvas(canvas, fileName) {
  const blob = await canvasBlob(canvas);
  if (navigator.clipboard?.write && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
      toast('카톡 공지 이미지를 클립보드에 복사했습니다.', 'success');
      return;
    } catch (_) {}
  }
  downloadBlob(blob, fileName);
  toast('이미지 복사를 지원하지 않아 PNG로 저장했습니다.', 'warn');
}

function openEstimateNoticePreview() {
  const current = modeDraft();
  const availablePriceFields = estimateNoticePriceDefinitions();
  const availablePriceFieldIds = new Set(availablePriceFields.map(field => field.id));
  let selectedPriceFieldIds = [...new Set(state.settings.estimateNoticePriceFields || [])]
    .filter(fieldId => availablePriceFieldIds.has(fieldId))
    .slice(0, 2);
  if (!selectedPriceFieldIds.length) selectedPriceFieldIds = [availablePriceFields[0]?.id || 'noticePrice'];
  const selectedRecords = selectedEstimateRecords();
  if (!selectedRecords.length) return toast('카톡으로 만들 견적서를 선택하세요.', 'error');
  const noticeSources = selectedRecords.map(record => {
    const useCurrent = record.estimateId === current.catalogRecordId;
    return {
      estimateId: record.estimateId,
      estimateName: estimateTitle(record),
      rows: useCurrent ? current.rows : (record.draft?.rows || []),
      previousPrices: useCurrent ? estimateComparisonPrices(current) : (record.previousPrices || {})
    };
  });
  if (!noticeSources.some(source => buildKakaoNoticeRows(source.rows, source.previousPrices, estimateNoticePriceDefinitions(selectedPriceFieldIds)).length)) {
    return toast('공지로 출력할 견적 품목이 없습니다.', 'error');
  }
  const dateStamp = new Date().toLocaleDateString('sv-SE');
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog estimate-notice-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Kakao Notice</small><h2>카톡 공지 미리보기</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-dialog__message">선택한 ${noticeSources.length}개 견적서를 현재 정렬 순서대로 표시합니다. 상단 단가 필터는 전체 견적서에 함께 적용되며 PNG에는 포함되지 않습니다.</div>
    <div class="estimate-notice-pages" data-notice-pages></div>
    <footer><button type="button" class="button button--quiet" data-close>닫기</button></footer>
  </div>`;
  document.body.append(dialog);
  const pagesElement = dialog.querySelector('[data-notice-pages]');
  let priceSettingsSave = Promise.resolve();
  const priceOptions = (selectedId, excludedId = '', allowEmpty = false) => [
    allowEmpty ? '<option value="">사용 안 함</option>' : '',
    ...availablePriceFields.map(field => `<option value="${esc(field.id)}" ${field.id === selectedId ? 'selected' : ''} ${field.id === excludedId ? 'disabled' : ''}>${esc(field.label)}</option>`)
  ].join('');
  const persistPriceFields = () => {
    const next = contract.normalizeSettings({ ...state.settings, estimateNoticePriceFields: selectedPriceFieldIds });
    state.settings = next;
    priceSettingsSave = priceSettingsSave
      .then(() => saveSettings(next))
      .catch(error => toast(error.message || '단가 필터를 저장하지 못했습니다.', 'error'));
  };
  const renderPreview = () => {
    const priceFields = estimateNoticePriceDefinitions(selectedPriceFieldIds);
    const pages = noticeSources.flatMap((source, companyIndex) => {
      const rows = buildKakaoNoticeRows(source.rows, source.previousPrices, priceFields);
      const canvases = renderKakaoNoticeCanvases(rows, { title: `${source.estimateName} 단가 안내`, rowsPerPage: KAKAO_NOTICE_ROWS_PER_PAGE });
      return canvases.map((canvas, pageIndex) => ({ canvas, companyIndex, companyName: source.estimateName, pageIndex, pageCount: canvases.length }));
    });
    const primaryId = selectedPriceFieldIds[0];
    const secondaryId = selectedPriceFieldIds[1] || '';
    pagesElement.innerHTML = pages.map((page, index) => `<article class="estimate-notice-page" data-notice-page="${index}">
      <div class="estimate-notice-company"><strong>${page.companyIndex + 1}. ${esc(page.companyName)}</strong><span>${page.pageIndex + 1}/${page.pageCount} 페이지</span></div>
      <div class="estimate-notice-image-wrap">
        <img src="${page.canvas.toDataURL('image/png')}" alt="${esc(page.companyName)} 카톡 공지 ${page.pageIndex + 1}페이지 미리보기">
        ${index === 0 ? `<div class="estimate-notice-filters" aria-label="공지 단가 필터">
          <label><span class="sr-only">단가 1</span><select data-notice-price-primary aria-label="단가 1">${priceOptions(primaryId, secondaryId)}</select></label>
          <label><span class="sr-only">단가 2</span><select data-notice-price-secondary aria-label="단가 2">${priceOptions(secondaryId, primaryId, true)}</select></label>
        </div>` : ''}
      </div>
      <footer><button type="button" class="button button--quiet" data-download-notice>PNG 저장</button><button type="button" class="button button--primary" data-copy-notice>이미지 복사</button></footer>
    </article>`).join('');
    pagesElement.querySelectorAll('[data-notice-page]').forEach(page => {
      const index = Number(page.dataset.noticePage);
      const noticePage = pages[index];
      const safeCompanyName = noticePage.companyName.replace(/[\\/:*?"<>|]/g, '_');
      const fileName = `카톡공지_${String(noticePage.companyIndex + 1).padStart(2, '0')}_${safeCompanyName}_${dateStamp}_${String(noticePage.pageIndex + 1).padStart(2, '0')}.png`;
      page.querySelector('[data-copy-notice]').addEventListener('click', () => void copyNoticeCanvas(noticePage.canvas, fileName));
      page.querySelector('[data-download-notice]').addEventListener('click', async () => {
        downloadBlob(await canvasBlob(noticePage.canvas), fileName);
        toast(`${noticePage.companyName} ${noticePage.pageIndex + 1}페이지 PNG를 저장했습니다.`, 'success');
      });
    });
    pagesElement.querySelector('[data-notice-price-primary]')?.addEventListener('change', event => {
      selectedPriceFieldIds = [event.target.value, secondaryId].filter(Boolean);
      persistPriceFields();
      renderPreview();
    });
    pagesElement.querySelector('[data-notice-price-secondary]')?.addEventListener('change', event => {
      selectedPriceFieldIds = [primaryId, event.target.value].filter(Boolean);
      persistPriceFields();
      renderPreview();
    });
  };
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  renderPreview();
  dialog.showModal();
}

async function exportEstimateExcel() {
  const selectedRecords = selectedEstimateRecords();
  const sourceRows = selectedRecords.length ? combinedEstimateRows(selectedRecords) : modeDraft().rows;
  const output = buildEstimateF8Data(sourceRows);
  try { await ensureXlsx(); }
  catch (error) { return toast(error.message, 'error'); }
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.aoa_to_sheet(output.errorData), '오류정보');
  window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.aoa_to_sheet(output.shopData), '쇼핑몰업로드');
  window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.aoa_to_sheet(output.erpData), 'ERP업데이트');
  const dateStamp = new Date().toLocaleDateString('sv-SE');
  const selectionLabel = selectedRecords.length ? `선택견적_${selectedRecords.length}개_` : '';
  window.XLSX.writeFile(workbook, `통합업로드용_${selectionLabel}견적F8_${dateStamp}.xlsx`);
  setAppStatus(`견적 Excel 생성 완료 · ${selectedRecords.length || 1}개 견적 · ${output.rows.length}품목 · 확인 ${output.errorData.length - 1}건`);
  toast(selectedRecords.length ? '선택한 견적서의 상품을 합쳐 Excel로 생성했습니다.' : '현재 견적서를 Excel로 생성했습니다.', 'success');
}

function voucherOutputRows(current = modeDraft()) {
  return (current.rows || []).filter(rowHasMeaningfulInput);
}

function voucherOutputDate(mode, header = {}) {
  return ['purchase', 'sale'].includes(mode)
    ? (header.voucherDate || header.deliveryDate || '')
    : (header.deliveryDate || '');
}

function voucherOutputFieldValue(row, field) {
  if (field.id === 'supplyAmount') {
    return hasEnteredValue(row.quantity) && hasEnteredValue(row.unitPrice)
      ? Number(row.quantity) * Number(row.unitPrice)
      : '';
  }
  return field.custom ? (row.customValues?.[field.id] ?? '') : (row[field.id] ?? '');
}

function buildVoucherOutputMatrix(mode = state.draft.activeMode, current = modeDraft()) {
  const selectedFields = new Set(voucherColumnsForMode(mode));
  const fieldById = new Map(layoutDefinitions('voucher').map(field => [field.id, field]));
  const fields = [...selectedFields].map(fieldId => fieldById.get(fieldId)).filter(Boolean);
  const header = current.header || {};
  const rows = voucherOutputRows(current);
  const dateLabel = mode === 'purchase' ? '구매일자' : (mode === 'sale' ? '판매일자' : '배송일자');
  return [
    [`${contract.MODES[mode].label} 출력`],
    [dateLabel, voucherOutputDate(mode, header), '거래처', header.customerName || header.customerCode || '', '창고', header.warehouseName || header.warehouseCode || ''],
    ['거래유형', header.transactionType || ''],
    [],
    ['No.', ...fields.map(field => field.label)],
    ...rows.map((row, index) => [index + 1, ...fields.map(field => voucherOutputFieldValue(row, field))])
  ];
}

function buildVoucherShareText(mode = state.draft.activeMode, current = modeDraft()) {
  const rows = voucherOutputRows(current);
  const header = current.header || {};
  const dateLabel = mode === 'purchase' ? '구매일자' : (mode === 'sale' ? '판매일자' : '배송일자');
  const summary = contract.summarizeRows(rows);
  const lines = [
    `[${contract.MODES[mode].label}]`,
    `${dateLabel}: ${voucherOutputDate(mode, header) || '-'}`,
    `거래처: ${header.customerName || header.customerCode || '-'}`
  ];
  if (header.warehouseName || header.warehouseCode) lines.push(`창고: ${header.warehouseName || header.warehouseCode}`);
  lines.push('');
  rows.forEach((row, index) => {
    const identity = [row.itemCode, row.itemName, row.specification].filter(hasEnteredValue).join(' · ');
    const quantity = [row.quantity, row.unit].filter(hasEnteredValue).join('');
    const unitPrice = contract.numberOrNull(row.unitPrice);
    const rowQuantity = contract.numberOrNull(row.quantity);
    const price = unitPrice !== null ? `단가 ${unitPrice.toLocaleString('ko-KR')}원` : '';
    const amount = rowQuantity !== null && unitPrice !== null
      ? `공급 ${Number(rowQuantity * unitPrice).toLocaleString('ko-KR')}원`
      : '';
    lines.push(`${index + 1}. ${[identity, quantity, price, amount, row.memo].filter(hasEnteredValue).join(' | ')}`);
  });
  lines.push('', `합계: 수량 ${summary.quantity.toLocaleString('ko-KR')} · ${summary.amount.toLocaleString('ko-KR')}원`);
  return lines.join('\n');
}

async function copyVoucherText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('클립보드 복사를 지원하지 않습니다.');
}

async function shareCurrentVoucher() {
  if (state.draft.activeMode === 'estimate') return openEstimateNoticePreview();
  const rows = voucherOutputRows();
  if (!rows.length) return toast('공유할 전표 품목이 없습니다.', 'error');
  const title = `${contract.MODES[state.draft.activeMode].label} 공유`;
  const text = buildVoucherShareText();
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return toast('전표 공유 화면을 열었습니다.', 'success');
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  try {
    await copyVoucherText(text);
    toast('전표 내용을 복사했습니다. 카톡에 붙여넣으세요.', 'success');
  } catch (error) {
    toast(error.message || '전표 내용을 공유하지 못했습니다.', 'error');
  }
}

async function exportCurrentVoucherExcel() {
  if (state.draft.activeMode === 'estimate') return exportEstimateExcel();
  const rows = voucherOutputRows();
  if (!rows.length) return toast('Excel로 출력할 전표 품목이 없습니다.', 'error');
  try { await ensureXlsx(); }
  catch (error) { return toast(error.message, 'error'); }
  const mode = state.draft.activeMode;
  const workbook = window.XLSX.utils.book_new();
  const sheet = window.XLSX.utils.aoa_to_sheet(buildVoucherOutputMatrix(mode));
  window.XLSX.utils.book_append_sheet(workbook, sheet, contract.MODES[mode].label);
  const dateStamp = voucherOutputDate(mode, modeDraft().header) || new Date().toLocaleDateString('sv-SE');
  window.XLSX.writeFile(workbook, `스마트입력_${contract.MODES[mode].label}_${dateStamp}.xlsx`);
  toast(`${contract.MODES[mode].label} Excel을 생성했습니다.`, 'success');
}

function validateEstimateDocument() {
  const current = modeDraft();
  if (!current.rows.length) {
    toast('견적 품목을 1개 이상 입력하세요.', 'error');
    return false;
  }
  const invalidIndex = current.rows.findIndex(row => !row.itemCode && !row.itemName);
  if (invalidIndex >= 0) {
    const rowElement = inputRows.querySelectorAll('tr')[invalidIndex];
    rowElement?.querySelector('[data-field="itemName"]')?.focus();
    toast(`${invalidIndex + 1}행의 품목을 확인하세요.`, 'error');
    return false;
  }
  return true;
}

function openEstimateSaveDialog() {
  if (!validateEstimateDocument()) return;
  const current = modeDraft();
  const loadedRecord = state.estimates.find(record => record.estimateId === current.catalogRecordId);
  const defaultName = loadedRecord ? estimateTitle(loadedRecord) : (current.estimateKind === 'LINKED_GROUP' ? '새 연동견적서' : (current.header.customerName || '새 견적서'));
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog estimate-save-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Estimate Save</small><h2>견적서 저장</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-dialog__message">현재 이름을 유지하면 같은 견적서를 수정하고, 다른 이름으로 저장하면 새 견적서를 목록 최하단에 생성합니다.</div>
    <div class="estimate-dialog-form"><label><span>견적서명</span><input type="text" data-estimate-name maxlength="80" value="${esc(defaultName)}"></label></div>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-confirm-save>저장</button></footer>
  </div>`;
  document.body.append(dialog);
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  const submit = async () => {
    const catalogName = dialog.querySelector('[data-estimate-name]').value.trim();
    if (!catalogName) {
      dialog.querySelector('[data-estimate-name]').focus();
      return toast('견적서명을 입력하세요.', 'error');
    }
    dialog.querySelector('[data-confirm-save]').disabled = true;
    const saved = await saveEstimateDocument(catalogName);
    if (saved) finish();
    else dialog.querySelector('[data-confirm-save]').disabled = false;
  };
  dialog.querySelector('[data-confirm-save]').addEventListener('click', submit);
  dialog.querySelector('[data-estimate-name]').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submit();
  });
  dialog.showModal();
  dialog.querySelector('[data-estimate-name]').focus();
  dialog.querySelector('[data-estimate-name]').select();
}

async function saveEstimateDocument(catalogName) {
  if (!validateEstimateDocument()) return false;
  const current = modeDraft();
  const requestedName = String(catalogName || '').trim();
  if (!requestedName) return false;
  const loadedRecord = state.estimates.find(item => item.estimateId === current.catalogRecordId);
  const sameLoadedRecord = loadedRecord && requestedName === estimateTitle(loadedRecord) ? loadedRecord : null;
  const nameCollision = state.estimates.find(item => item.estimateId !== loadedRecord?.estimateId && requestedName === estimateTitle(item));
  if (nameCollision) {
    const linkedWarning = nameCollision.estimateKind === 'LINKED_GROUP'
      ? '\n이 이름은 연동견적서입니다. 덮어쓰면 기존 연동견적서 내용이 현재 입력값으로 교체됩니다.'
      : '';
    const overwrite = window.confirm(`이미 “${requestedName}” 견적서가 있습니다. 기존 저장분을 덮어쓸까요?${linkedWarning}`);
    if (!overwrite) return false;
  }
  const overwriteRecord = sameLoadedRecord || nameCollision || null;
  state.busy = true;
  renderDelivery();
  setAppStatus('견적서를 저장하고 있습니다.');
  try {
    if (current.estimateKind === 'LINKED_GROUP') await flushLinkedRowsToSources();
    const timestamp = new Date().toISOString();
    const updateExistingRecord = Boolean(overwriteRecord);
    const estimateId = updateExistingRecord ? overwriteRecord.estimateId : createRecordId('SIEST');
    const storedPrices = buildCatalogPriceSnapshot(overwriteRecord?.draft?.rows || []);
    const priorPrices = Object.keys(current.catalogBaselinePrices || {}).length
      ? { ...current.catalogBaselinePrices }
      : storedPrices;
    current.catalogPreviousPrices = { ...priorPrices };
    current.catalogBaselinePrices = buildCatalogPriceSnapshot(current.rows);
    current.catalogRecordId = estimateId;
    current.updatedAt = timestamp;
    current.delivery = { status: 'SAVED', targetId: 'smart-input-estimates', targetRecordId: estimateId, deliveredAt: timestamp };
    const summary = contract.summarizeRows(current.rows);
    const record = {
      estimateId,
      catalogName: requestedName,
      estimateKind: current.estimateKind === 'LINKED_GROUP' ? 'LINKED_GROUP' : 'INDIVIDUAL',
      linkedEstimateSources: current.estimateKind === 'LINKED_GROUP' ? current.linkedEstimateSources.map(source => ({ ...source })) : [],
      customerId: current.estimateKind === 'LINKED_GROUP' ? '' : current.header.customerId,
      customerName: current.estimateKind === 'LINKED_GROUP' ? '' : current.header.customerName,
      rowCount: summary.total,
      amount: summary.amount,
      previousPrices: priorPrices,
      sortOrder: updateExistingRecord ? Number(overwriteRecord.sortOrder || 1) : state.estimates.length + 1,
      createdAt: updateExistingRecord ? (overwriteRecord.createdAt || timestamp) : timestamp,
      updatedAt: timestamp,
      draft: JSON.parse(JSON.stringify(createCatalogOnlyDraft(current, estimateId)))
    };
    await saveEstimate(record);
    state.estimates = normalizeEstimateOrder(updateExistingRecord
      ? state.estimates.map(item => item.estimateId === estimateId ? record : item)
      : [...state.estimates, record]);
    state.estimateWorkingCopies.delete(estimateId);
    state.estimateLibraryKind = record.estimateKind === 'LINKED_GROUP' ? 'linked' : 'individual';
    state.noticeEstimateIds = [estimateId];
    state.estimateSelectionReturnDraft = null;
    clearCustomerAfterSave(current.header);
    saveDraftNow();
    hydrateHeader();
    renderEstimateHeaderFields();
    renderCatalogControls();
    renderDelivery();
    setAppStatus(`${estimateTitle(record)} · ${summary.total}품목 견적 저장 완료`);
    toast(updateExistingRecord ? '기존 견적서를 덮어썼습니다.' : '새 견적서를 목록 최하단에 저장했습니다.', 'success');
    return true;
  } catch (error) {
    setAppStatus('견적서를 저장하지 못했습니다. 입력 내용은 유지됩니다.', 'error');
    toast(error.message || '견적서 저장에 실패했습니다.', 'error');
    return false;
  } finally {
    state.busy = false;
    renderDelivery();
  }
}

function clearCustomerAfterSave(header) {
  header.customerId = '';
  header.customerCode = '';
  header.customerName = '';
  header.customerLinkGroupId = '';
  header.taxCustomerId = '';
  header.taxCustomerName = '';
  header.isTemporaryCustomer = false;
  header.rawOrdererName = '';
  header.aliasMappingId = '';
  header.customerMappingSource = '';
}

async function completeOrder() {
  if (state.draft.activeMode === 'estimate') {
    if (modeDraft().estimateKind === 'COMPOSITION_PREVIEW') return toast('우측의 견적서 생성에서 개별 또는 연동 방식을 선택하세요.', 'warn');
    if (!validateEstimateDocument()) return;
    const loadedRecord = state.estimates.find(record => record.estimateId === modeDraft().catalogRecordId);
    const assignedName = String(loadedRecord?.catalogName || '').trim();
    return assignedName ? saveEstimateDocument(assignedName) : openEstimateSaveDialog();
  }
  if (state.draft.activeMode === 'purchase') return completePurchaseOfficial();
  if (state.draft.activeMode === 'sale') return completeSaleOfficial();
  return completeOrderLegacy();
}

async function completeSaleOfficial() {
  const current = modeDraft();
  if (!state.saleCapability.ready) {
    setAppStatus('공식 판매전표 중앙 배포 계약을 확인할 수 없어 저장이 비활성화되었습니다.', 'warn');
    return toast('판매 원장 연결을 사용할 수 없습니다. 현재 작업과 자동저장은 유지됩니다.', 'error');
  }
  applyWarehouseMatch();
  resolveStage1RowReferences(current.rows);
  const groups = groupVoucherRows('sale', current.rows, current.header);
  const results = [];
  state.busy = true;
  renderDelivery();
  try {
    for (const group of groups) {
      try {
        const producer = String(group.originSystem || group.rows?.[0]?.originSystem
          || (current.activeMethod === 'paste' ? 'SMARTINPUT_CLIPBOARD' : current.activeMethod === 'excel' ? 'SMARTINPUT_FILE' : 'SMARTINPUT_MANUAL')).toUpperCase();
        const producerTransactionId = String(group.originTransactionId || group.rows?.[0]?.originTransactionId
          || current.batches?.at(-1)?.contentHash || current.documentId);
        const customerRevision = customerId => Number(state.customers.find(row => String(row.customerId) === String(customerId))?.revision || 0);
        const hydratedGroup = { ...group,
          salesCustomerRevision: Number(group.salesCustomerRevision || group.rows?.[0]?.salesCustomerRevision || customerRevision(group.salesCustomerId)),
          deliveryCustomerRevision: Number(group.deliveryCustomerRevision || group.rows?.[0]?.deliveryCustomerRevision || customerRevision(group.deliveryCustomerId)),
          billingCustomerRevision: Number(group.billingCustomerRevision || group.rows?.[0]?.billingCustomerRevision || customerRevision(group.billingCustomerId)),
          rows: group.rows.map(row => {
            const product = state.products.find(item => String(item.productId || item.itemCode) === String(row.productId || row.itemCode));
            const warehouse = (state.warehouseCatalog.warehouses || []).find(item => String(item.warehouseId || item.warehouseCode) === String(row.warehouseId || group.warehouseId || row.rowWarehouseCode));
            const sourceType = String(row.sourceType || group.sourceType || 'DIRECT').toUpperCase();
            return { ...row, sourceType, orderLinkMode: sourceType === 'ORDER_Q' ? 'ORDER_Q' : 'DIRECT',
              productId: row.productId || product?.productId || '', productMasterRevision: Number(row.productMasterRevision || product?.revision || 0),
              warehouseId: row.warehouseId || group.warehouseId || warehouse?.warehouseId || '', warehouseMasterRevision: Number(row.warehouseMasterRevision || warehouse?.revision || 0),
              actualToBaseFactor: sourceType === 'ORDER_Q' ? Number(row.actualToBaseFactor) : 1,
              actualToRecognizedFactor: sourceType === 'ORDER_Q' ? Number(row.actualToRecognizedFactor) : 0,
              actualUnit:row.actualUnit || row.unit || '', baseUnit:sourceType === 'ORDER_Q' ? row.baseUnit : (row.actualUnit || row.unit || ''),
              recognizedUnit:row.recognizedUnit || row.unit || '',
              conversionSource:sourceType === 'ORDER_Q' ? row.conversionSource : 'DIRECT_SAME_UNIT',
              conversionRuleId:sourceType === 'ORDER_Q' ? row.conversionRuleId : 'DIRECT_1_TO_1',
              conversionRuleVersion:sourceType === 'ORDER_Q' ? row.conversionRuleVersion : 'DIRECT_1_TO_1_V1' };
          }) };
        const result = await postSaleGroup(hydratedGroup, { actor: SMARTINPUT_SALE_ACTOR_ID, originSystem: producer,
          manualSessionId: producerTransactionId, occurredAt: new Date().toISOString() });
        const documentId = result.salesDocumentId || result.document?.salesDocumentId || '';
        const commandId = result.commandId || '';
        current.saleSubmissions = (current.saleSubmissions || []).filter(pointer => pointer.voucherGroupKey !== group.voucherGroupKey);
        current.saleSubmissions.push({ salesDocumentId: documentId, commandId,
          state: result.projectionPending ? 'PROJECTION_PENDING' : 'LOCAL_PROJECTED',
          receiptKey: commandId ? `centralProjection:${commandId}` : '', voucherGroupKey: group.voucherGroupKey, lastErrorCode: '' });
        results.push({ ok: true, group, result });
      } catch (error) { results.push({ ok: false, group, error }); }
    }
    const failed = results.filter(row => !row.ok); const succeeded = results.filter(row => row.ok);
    if (failed.length) {
      const failedKeys = new Set(failed.map(row => row.group.voucherGroupKey));
      current.rows = current.rows.filter(row => failedKeys.has(groupVoucherRows('sale', [row], current.header)[0]?.voucherGroupKey));
      current.voucherGroups = failed.map(row => row.group);
      current.delivery = { status: succeeded.length ? 'PARTIAL' : 'FAILED', targetId: 'official-sale-voucher', targetRecordId: '', deliveredAt: '' };
      saveDraftNow(); renderMode();
      setAppStatus(`판매 ${succeeded.length}건 저장 완료 · 실패 ${failed.length}건은 입력표에 유지됩니다.`, 'warn');
      return toast(failed[0].error?.message || '판매전표 저장 실패', 'error');
    }
    current.rows = []; current.voucherGroups = [];
    clearCustomerAfterSave(current.header);
    current.delivery = { status: 'SAVED', targetId: 'official-sale-voucher', targetRecordId: '', deliveredAt: new Date().toISOString() };
    saveDraftNow(); renderMode(); setAppStatus(`공식 판매전표 ${succeeded.length}건 저장 완료`);
    toast(`판매전표 ${succeeded.length}건을 저장했습니다.`, 'success');
  } finally { state.busy = false; renderDelivery(); }
}

async function completePurchaseOfficial() {
  const current = modeDraft();
  if (!state.purchaseCapability.ready) {
    setAppStatus('공식 구매전표 중앙 배포 계약을 확인할 수 없어 저장이 비활성화되었습니다.', 'warn');
    return toast('구매 원장 연결을 사용할 수 없습니다. 현재 작업과 자동저장은 유지됩니다.', 'error');
  }
  applyWarehouseMatch();
  resolveStage1RowReferences(current.rows);
  const groups = groupVoucherRows('purchase', current.rows, current.header);
  const masters = { customers: state.customers, products: state.products, warehouses: state.warehouseCatalog.warehouses || [] };
  const results = [];
  state.busy = true;
  renderDelivery();
  try {
    for (const group of groups) {
      try {
        validatePurchaseGroup(group, masters);
        const producer = current.activeMethod === 'paste' ? 'SMARTINPUT_CLIPBOARD' : 'SMARTINPUT_MANUAL';
        const result = await postPurchaseGroup(group, { actor: SMARTINPUT_PURCHASE_ACTOR_ID, originSystem: producer, manualSessionId: current.documentId, occurredAt: new Date().toISOString() });
        const documentId = result.purchaseDocumentId || result.document?.purchaseDocumentId || result.central?.changes?.find(row => row.entityType === 'PURCHASE_DOCUMENT')?.entityId || '';
        const commandId = result.commandId || result.central?.commandId || result.central?.result?.commandId || '';
        current.purchaseSubmissions = (current.purchaseSubmissions || []).filter(pointer => pointer.voucherGroupKey !== group.voucherGroupKey);
        current.purchaseSubmissions.push({ purchaseDocumentId: documentId, commandId, state: result.projectionPending ? 'PROJECTION_PENDING' : 'LOCAL_PROJECTED', receiptKey: commandId ? `centralProjection:${commandId}` : '', voucherGroupKey: group.voucherGroupKey, lastErrorCode: '' });
        results.push({ ok: true, group, result });
      } catch (error) {
        results.push({ ok: false, group, error });
      }
    }
    const failed = results.filter(row => !row.ok);
    const succeeded = results.filter(row => row.ok);
    if (failed.length) {
      const failedKeys = new Set(failed.map(row => row.group.voucherGroupKey));
      current.rows = current.rows.filter(row => failedKeys.has(groupVoucherRows('purchase', [row], current.header)[0]?.voucherGroupKey));
      current.voucherGroups = failed.map(row => row.group);
      current.delivery = { status: succeeded.length ? 'PARTIAL' : 'FAILED', targetId: 'official-purchase-voucher', targetRecordId: '', deliveredAt: '' };
      saveDraftNow();
      renderMode();
      setAppStatus(`구매 ${succeeded.length}건 저장 완료 · 실패 ${failed.length}건은 입력표에 유지됩니다.`, 'warn');
      return toast(failed[0].error?.message || '구매전표 저장 실패', 'error');
    }
    current.rows = [];
    current.voucherGroups = [];
    clearCustomerAfterSave(current.header);
    current.delivery = { status: 'SAVED', targetId: 'official-purchase-voucher', targetRecordId: '', deliveredAt: new Date().toISOString() };
    saveDraftNow();
    renderMode();
    setAppStatus(`공식 구매전표 ${succeeded.length}건 저장 완료`);
    toast(`구매전표 ${succeeded.length}건을 저장했습니다.`, 'success');
  } finally {
    state.busy = false;
    renderDelivery();
  }
}

function orderGroupErrors(groups = []) {
  const errors = [];
  groups.forEach((group, index) => {
    const label = `${index + 1}번 전표`;
    if (!group.deliveryCustomerName) errors.push(`${label} 등록 거래처`);
    if (!group.voucherDate) errors.push(`${label} 주문일자`);
    if (!group.deliveryDate) errors.push(`${label} 배송일자`);
    if (!group.warehouseId && !group.warehouseCode) errors.push(`${label} 출하창고`);
    if (!group.rows.length) errors.push(`${label} 상품`);
    group.rows.forEach((row, rowIndex) => {
      if (!row.itemCode && !row.itemName) errors.push(`${label} ${rowIndex + 1}행 상품`);
      if (row.quantity === null) errors.push(`${label} ${rowIndex + 1}행 수량`);
      if (row.unitConversionStatus === 'REVIEW_REQUIRED') errors.push(`${label} ${rowIndex + 1}행 단위 환산`);
    });
  });
  return errors;
}

function orderGroupCommonPayload(current, rawFingerprint) {
  return {
    orderDate: current.header.orderDate,
    deliveryExpectedDate: current.header.deliveryDate,
    customerId: current.header.customerId,
    customerName: current.header.customerName,
    warehouseId: current.header.warehouseId,
    warehouseCode: current.header.warehouseCode,
    warehouseName: current.header.warehouseName,
    transactionType: current.header.transactionType,
    customValues: { ...(current.header.customValues || {}) },
    formLayoutSnapshot: {
      customFields: (state.settings.customFields || []).map(field => ({ ...field })),
      headerFields: [...headerFieldsForMode(current.mode)],
      voucherColumns: [...voucherColumnsForMode(current.mode)],
      headerFieldsByMode: Object.fromEntries(Object.keys(contract.MODES).map(mode => [mode, [...headerFieldsForMode(mode)]])),
      voucherColumnsByMode: Object.fromEntries(Object.keys(contract.MODES).map(mode => [mode, [...voucherColumnsForMode(mode)]])),
      columnWidths: { ...(state.settings.columnWidths || {}) }
    },
    sourceType: 'SMART_INPUT',
    rawFingerprint,
    intakeContractVersion: 'SMART_INPUT_V1',
    inputChannel: 'SMART_INPUT',
    actorName: 'SMART INPUT 관리자'
  };
}

async function saveOrderGroups(current, groups, submittedAt) {
  const batchText = current.batches.map(batch => batch.rawText).join('\n\n--- SMART INPUT BATCH ---\n\n');
  const rawFingerprint = await sha256Text(batchText);
  const common = orderGroupCommonPayload(current, rawFingerprint);
  const results = [];
  for (const group of groups) {
    try {
      const payload = buildOrderGroupPayload(group, common);
      payload.items = payload.items.map((row, index) => {
        const masterLinked = hasMasterProductIdentity(row);
        return {
          ...row,
          lineNo: index + 1,
          productId: masterLinked ? row.productId : null,
          masterProductId: masterLinked ? row.masterProductId : null,
          rawQuantity: row.rawQuantity,
          rawUnit: row.rawUnit,
          finalQuantity: row.quantity,
          finalUnit: row.unit,
          price: row.unitPrice,
          supplyAmount: Number(row.quantity || 0) * Number(row.unitPrice || 0),
          matchStatus: masterLinked ? 'MATCHED' : 'MATCH_FAILED',
          matchSource: masterLinked ? 'SMART_INPUT_COMMON_MASTER' : 'SMART_INPUT_UNRESOLVED',
          sourceLineKey: row.sourceLineKey || `${row.sourceBatchId}:${row.sourceRowNo || index + 1}`,
          reviewStatus: masterLinked ? 'CONFIRMED' : 'PENDING',
          productIdentityStatus: masterLinked ? 'MASTER_LINKED' : 'UNRESOLVED'
        };
      });
      const result = await createOrder(payload);
      let online = false;
      try {
        const sync = await syncAfterLocalMutation(result.order.orderId);
        online = Boolean(sync?.online);
      } catch (_) {}
      results.push({ ok: true, group, result, online });
    } catch (error) {
      results.push({ ok: false, group, error });
    }
  }

  const succeeded = results.filter(result => result.ok);
  const failed = results.filter(result => !result.ok);
  current.header.submittedAt = submittedAt.toISOString();
  succeeded.forEach(({ group, result, online }) => appendDeliveryHistory({
    status: 'SAVED',
    targetId: 'orderq-vnext',
    targetRecordId: result.order.orderId,
    orderNo: result.order.orderNo,
    deliveredAt: new Date().toISOString(),
    online,
    draftId: state.draft.draftId,
    sourceBatchIds: [group.sourceBatchId],
    orderDate: group.voucherDate,
    customerId: group.deliveryCustomerId,
    customerName: group.deliveryCustomerName,
    rowCount: group.rows.length,
    voucherGroupKey: group.voucherGroupKey
  }));

  if (failed.length) {
    const failedKeys = new Set(failed.map(result => result.group.voucherGroupKey));
    current.rows = current.rows.filter(row => failedKeys.has(buildVoucherGroupKeyForCurrentRow(row)));
    current.voucherGroups = failed.map(result => result.group);
    current.delivery = { status: 'PARTIAL', targetId: 'orderq-vnext', targetRecordId: '', deliveredAt: '' };
    saveDraftNow();
    renderMode();
    const firstMessage = failed[0].error?.message || '저장 실패';
    setAppStatus(`주문 ${succeeded.length}건 저장 완료 · 실패 ${failed.length}건은 입력표에 유지됩니다.`, 'warn');
    toast(`${failed.length}건 저장 필요: ${firstMessage}`, 'error');
    return;
  }

  const last = succeeded[succeeded.length - 1];
  state.draft.ui.lastDelivery = last ? {
    status: 'SAVED',
    targetId: 'orderq-vnext',
    targetRecordId: last.result.order.orderId,
    orderNo: last.result.order.orderNo,
    deliveredAt: new Date().toISOString(),
    online: last.online
  } : null;
  const next = contract.createDraft().modes.order;
  next.header.warehouseId = current.header.warehouseId;
  next.header.warehouseCode = current.header.warehouseCode;
  next.header.warehouseName = current.header.warehouseName;
  next.header.transactionType = current.header.transactionType;
  state.draft.modes.order = next;
  state.gridPasteUndo = null;
  state.sourceImages.order = null;
  state.selectedRowIds.clear();
  resetPhotoView();
  state.pendingImageEvidence = null;
  state.pendingOcrReview = null;
  state.pendingSourceName = '';
  state.pendingStructuredImport = null;
  activatePendingReferences({ explicit: false, render: false });
  saveDraftNow();
  renderMode();
  setAppStatus(`주문 ${succeeded.length}건 저장 완료`);
  toast(`전표 그룹별 주문 ${succeeded.length}건을 중복 없이 저장했습니다.`, 'success');
}

function buildVoucherGroupKeyForCurrentRow(row) {
  return groupVoucherRows('order', [row], modeDraft().header)[0]?.voucherGroupKey || '';
}

async function completeOrderLegacy() {
  const current = modeDraft();
  if (state.draft.activeMode !== 'order') {
    toast('구매·판매 전달 대상은 확정 후 활성화합니다.', 'error');
    return;
  }
  const submittedAt = new Date();
  current.header.recordedAt ||= submittedAt.toISOString();
  current.header.orderDate = contract.businessDate(current.header.recordedAt, state.settings.timezone);
  current.header.voucherDate ||= current.header.orderDate;
  applyWarehouseMatch();
  resolveStage1RowReferences(current.rows);
  const groups = groupVoucherRows('order', current.rows, current.header);
  const groupedInput = groups.length > 1 || current.rows.some(row => row.sourceDocumentKey || row.manualSplitKey
    || row.rowCustomerCode || row.rowCustomerName || row.rowVoucherDate || row.rowDeliveryDate
    || row.rowWarehouseCode || row.rowVoucherNo);
  if (groupedInput) {
    const errors = orderGroupErrors(groups);
    if (errors.length) {
      setAppStatus('다중 전표 정보를 확인하세요.', 'error');
      return toast(`${errors[0]}을(를) 확인하세요.`, 'error');
    }
    if (!current.header.taxCustomerId && !current.header.customerName && !window.confirm('세무 거래처가 지정되지 않았습니다. 배송처별 주문은 유지한 채 ORDER Q에 저장하시겠습니까?')) return;
    state.busy = true;
    renderDelivery();
    setAppStatus(`전표 그룹 ${groups.length}건을 공통 주문서 원장에 저장하고 있습니다.`);
    try {
      await saveOrderGroups(current, groups, submittedAt);
    } finally {
      state.busy = false;
      renderDelivery();
    }
    return;
  }
  const deliveryDecision = updateDeliveryPolicy();
  if (!deliveryDecision?.valid) {
    $('deliveryDateInput').focus();
    return toast(deliveryDecision?.message || '배송일을 확인하세요.', 'error');
  }
  const errors = contract.validateOrderDraft(current);
  if (errors.length) {
    const first = errors[0];
    if (first.field === 'customer') $('customerInput').focus();
    else if (first.field === 'warehouse') $('warehouseInput').focus();
    else if (first.field.startsWith('row:')) {
      const [, index, field] = first.field.split(':');
      inputRows.querySelectorAll('tr')[Number(index)]?.querySelector(`[data-field="${field === 'item' ? 'itemName' : field}"]`)?.focus();
    }
    return toast(first.message, 'error');
  }
  if (!current.header.taxCustomerId && !current.header.customerName && !window.confirm('세무 거래처가 지정되지 않았습니다. 배송처별 주문은 유지한 채 ORDER Q에 저장하시겠습니까?')) return;
  state.busy = true;
  renderDelivery();
  setAppStatus('공통 주문서 원장에 저장하고 있습니다.');
  try {
    const batchText = current.batches.map(batch => batch.rawText).join('\n\n--- SMART INPUT BATCH ---\n\n');
    const rawFingerprint = await sha256Text(batchText);
    const sourceBatch = current.batches.find(batch => batch.intakeSessionId) || current.batches[0];
    const result = await createOrder({
      orderDate: current.header.orderDate,
      deliveryExpectedDate: current.header.deliveryDate,
      customerId: current.header.customerId,
      customerName: current.header.customerName,
      warehouseId: current.header.warehouseId,
      warehouseCode: current.header.warehouseCode,
      warehouseName: current.header.warehouseName,
      transactionType: current.header.transactionType,
      customValues: { ...(current.header.customValues || {}) },
      formLayoutSnapshot: {
        customFields: (state.settings.customFields || []).map(field => ({ ...field })),
        headerFields: [...headerFieldsForMode(current.mode)],
        voucherColumns: [...voucherColumnsForMode(current.mode)],
        headerFieldsByMode: Object.fromEntries(Object.keys(contract.MODES).map(mode => [mode, [...headerFieldsForMode(mode)]])),
        voucherColumnsByMode: Object.fromEntries(Object.keys(contract.MODES).map(mode => [mode, [...voucherColumnsForMode(mode)]])),
        columnWidths: { ...(state.settings.columnWidths || {}) }
      },
      sourceType: 'SMART_INPUT',
      sourceId: current.batches[0]?.batchId || state.draft.draftId,
      sourceDocumentKey: `SMART_INPUT:${current.batches[0]?.batchId || state.draft.draftId}:ORDER`,
      intakeSessionId: sourceBatch?.intakeSessionId || '',
      intakeDocumentId: sourceBatch?.intakeDocumentId || '',
      rawFingerprint,
      intakeContractVersion: 'SMART_INPUT_V1',
      inputChannel: 'SMART_INPUT',
      actorName: 'SMART INPUT 관리자',
      items: current.rows.map((row, index) => {
        const masterLinked = hasMasterProductIdentity(row);
        return {
          lineNo: index + 1,
          productId: masterLinked ? row.productId : null,
          masterProductId: masterLinked ? row.masterProductId : null,
          itemCode: row.itemCode,
          itemName: row.itemName,
          specification: row.specification,
          rawText: row.rawText,
          rawQuantity: row.quantity,
          rawUnit: row.unit,
          finalQuantity: row.quantity,
          finalUnit: row.unit,
          price: row.unitPrice,
          supplyAmount: Number(row.quantity || 0) * Number(row.unitPrice || 0),
          memo: row.memo,
          description: row.description,
          noticePrice: row.noticePrice,
          customValues: { ...(row.customValues || {}) },
          matchStatus: masterLinked ? 'MATCHED' : 'MATCH_FAILED',
          matchSource: masterLinked ? 'SMART_INPUT_COMMON_MASTER' : 'SMART_INPUT_UNRESOLVED',
          intakeLineId: row.intakeLineId,
          sourceLineKey: row.sourceLineKey || `${row.batchId}:${row.sourceLineNo || index + 1}`,
          reviewStatus: masterLinked ? 'CONFIRMED' : 'PENDING',
          productIdentityStatus: masterLinked ? 'MASTER_LINKED' : 'UNRESOLVED'
        };
      })
    });
    current.header.submittedAt = submittedAt.toISOString();
    let online = false;
    try {
      const sync = await syncAfterLocalMutation(result.order.orderId);
      online = Boolean(sync?.online);
    } catch (_) {}
    const delivery = {
      status: 'SAVED',
      targetId: 'orderq-vnext',
      targetRecordId: result.order.orderId,
      deliveredAt: new Date().toISOString(),
      online
    };
    state.draft.ui.lastDelivery = { ...delivery, orderNo: result.order.orderNo };
    appendDeliveryHistory({
      ...delivery,
      orderNo: result.order.orderNo,
      draftId: state.draft.draftId,
      sourceBatchIds: current.batches.map(batch => batch.batchId),
      recordedAt: current.header.recordedAt,
      submittedAt: current.header.submittedAt,
      orderDate: current.header.orderDate,
      customerId: current.header.customerId,
      customerName: current.header.customerName,
      customerLinkGroupId: current.header.customerLinkGroupId,
      taxCustomerId: current.header.taxCustomerId,
      taxCustomerName: current.header.taxCustomerName,
      deliveryPolicySnapshot: current.header.deliveryPolicySnapshot,
      rowCount: current.rows.length
    });
    const next = contract.createDraft().modes.order;
    next.header.warehouseId = current.header.warehouseId;
    next.header.warehouseCode = current.header.warehouseCode;
    next.header.warehouseName = current.header.warehouseName;
    next.header.transactionType = current.header.transactionType;
    state.draft.modes.order = next;
    state.gridPasteUndo = null;
    state.sourceImages.order = null;
    state.selectedRowIds.clear();
    resetPhotoView();
    state.pendingImageEvidence = null;
    state.pendingOcrReview = null;
    state.pendingSourceName = '';
    state.pendingStructuredImport = null;
    activatePendingReferences({ explicit: false, render: false });
    saveDraftNow();
    renderMode();
    setAppStatus(online ? `주문 ${result.order.orderNo} 저장·중앙 반영 완료` : `주문 ${result.order.orderNo} 로컬 저장 완료 · 중앙 반영 대기`, online ? 'normal' : 'warn');
    toast(`주문 ${result.order.orderNo}을 공통 주문서 원장에 저장했습니다.`, 'success');
  } catch (error) {
    setAppStatus('주문 저장을 완료하지 못했습니다. 입력 내용은 유지됩니다.', 'error');
    toast(error.message || '주문 저장에 실패했습니다.', 'error');
  } finally {
    state.busy = false;
    renderDelivery();
  }
}

function resetCurrentMode(requireConfirmation = true, successMessage = '새 입력을 시작합니다.') {
  const current = modeDraft();
  const hasData = current.rows.length || current.sourceText.trim();
  if (requireConfirmation && hasData && !window.confirm(`${contract.MODES[state.draft.activeMode].label} 입력 내용을 비우고 새로 작성하시겠습니까?`)) return;
  if (hasData) saveDraftNow();
  const fallback = contract.createDraft().modes[state.draft.activeMode];
  fallback.header.warehouseId = current.header.warehouseId;
  fallback.header.warehouseCode = current.header.warehouseCode;
  fallback.header.warehouseName = current.header.warehouseName;
  fallback.header.transactionType = current.header.transactionType;
  state.draft.modes[state.draft.activeMode] = fallback;
  if (state.draft.activeMode === 'estimate') {
    state.noticeEstimateIds = [];
    state.estimateSelectionReturnDraft = null;
  }
  state.gridPasteUndo = null;
  state.sourceImages[state.draft.activeMode] = null;
  state.selectedRowIds.clear();
  resetPhotoView();
  state.pendingImageEvidence = null;
  state.pendingOcrReview = null;
  state.pendingSourceName = '';
  state.pendingStructuredImport = null;
  activatePendingReferences({ explicit: false, render: false });
  saveDraftNow({ writeAutosave: false });
  renderMode();
  sourceTextInput.focus();
  toast(successMessage, 'success');
}

async function hydrateReferences() {
  state.catalogStatus = 'LOADING';
  state.customerStatus = 'LOADING';
  state.referenceStatus = REFERENCE_DOMAIN_STATUS.LOADING;
  state.referenceMessage = '상품·거래처·배송 설정을 불러오고 있습니다.';
  renderReferenceControls();
  setAppStatus(state.referenceMessage);
  const smartDataResult = await Promise.allSettled([
    withTimeout(loadSmartInputData(), 5000, '스마트입력 설정 로딩 시간 초과')
  ]);
  if (smartDataResult[0].status === 'fulfilled') {
    const data = smartDataResult[0].value;
    state.settings = contract.normalizeSettings(data.settings || {});
    state.linkGroups = data.linkGroups || [];
    state.temporaryCustomers = data.temporaryCustomers || [];
    state.aliasMappings = data.aliasMappings || [];
    state.estimates = normalizeEstimateOrder(data.estimates || []);
    state.sourceImageRecords = new Map((data.sourceImages || []).map(sourceImage => [sourceImage.documentId, sourceImage]));
    Object.keys(state.sourceImages).forEach(mode => restoreSourceImageForMode(mode));
    restoreCachedReferences(data.referenceCache || {});
    state.customers = normalizedCustomerCandidates(state.customers);
    state.smartDataReady = true;
    renderMode();
  }
  const results = await Promise.allSettled([
    withTimeout(loadReferenceDomain('product'), 7000, '상품 기준자료 로딩 시간 초과'),
    withTimeout(loadReferenceDomain('customer'), 7000, '거래처 기준자료 로딩 시간 초과'),
    withTimeout(loadWarehouseCatalog(), 5000, '창고 기준자료 로딩 시간 초과'),
    withTimeout(loadPurchaseStage3Capability(), 5000, '구매 저장 계약 확인 시간 초과'),
    withTimeout(loadSaleStage4Capability(), 5000, '판매 저장 계약 확인 시간 초과')
  ]);
  ingestLatestReference('product', results[0].status === 'fulfilled' ? results[0].value : {
    status: REFERENCE_DOMAIN_STATUS.ERROR,
    error: { code: 'PRODUCT_REFERENCE_TIMEOUT', message: results[0].reason?.message || '상품 기준자료 로드 실패' }
  });
  ingestLatestReference('customer', results[1].status === 'fulfilled' ? results[1].value : {
    status: REFERENCE_DOMAIN_STATUS.ERROR,
    error: { code: 'CUSTOMER_REFERENCE_TIMEOUT', message: results[1].reason?.message || '거래처 기준자료 로드 실패' }
  });
  if (results[2].status === 'fulfilled') {
    state.warehouseCatalog = results[2].value;
    renderWarehouseOptions();
  }
  state.purchaseCapability = results[3].status === 'fulfilled'
    ? results[3].value
    : { ready: false, code: 'ORDERQ_PURCHASE_STAGE3_CAPABILITY_UNAVAILABLE', detail: results[3].reason?.message || 'ping failed' };
  state.saleCapability = results[4].status === 'fulfilled'
    ? results[4].value
    : { ready: false, code: 'ORDERQ_SALE_STAGE4_CAPABILITY_UNAVAILABLE', detail: results[4].reason?.message || 'ping failed' };
  refreshReferenceAggregate();
  renderMode();
  setAppStatus(referencesReady() ? '기준정보 준비됨' : state.referenceMessage, referencesReady() ? '' : 'warn');
  if (referencesReady() && [results[2], smartDataResult[0]].some(result => result.status === 'rejected')) {
    setAppStatus('기준정보 준비됨 · 배송 또는 설정 자료 일부를 불러오지 못했습니다.', 'warn');
  }
}

modeTabs.addEventListener('click', event => {
  const tab = event.target.closest('.mode-tab[data-mode]');
  if (!tab || !modeTabs.contains(tab)) return;
  event.preventDefault();
  setMode(tab.dataset.mode);
});
methodButtons.forEach(button => button.addEventListener('click', () => {
  const method = updateMethod(button.dataset.method);
  if (method.id === 'direct') addDirectRow();
  else if (method.id === 'excel') $('fileInput').click();
  else if (method.id === 'photo') $('photoInput').click();
  else if (method.id === 'voice') toggleVoice();
  else {
    sourceTextInput.focus();
    $('sourceNotice').textContent = method.id === 'paste'
      ? '텍스트 또는 이미지를 Ctrl+V로 붙여넣으세요.'
      : '공백과 줄바꿈을 유지해 입력합니다.';
  }
}));

$('productReferenceReload').addEventListener('click', () => { void reloadReferenceDomain('product'); });
$('customerReferenceReload').addEventListener('click', () => { void reloadReferenceDomain('customer'); });
$('referencePendingApply').addEventListener('click', () => { activatePendingReferences({ explicit: true }); });
const referenceOverview = $('referenceOverview');
const referenceOverviewSummary = referenceOverview.querySelector('summary');
referenceOverviewSummary.addEventListener('keydown', event => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  referenceOverview.open = !referenceOverview.open;
});
referenceOverviewSummary.addEventListener('keyup', event => {
  if (['Enter', ' '].includes(event.key)) event.preventDefault();
});
referenceOverview.addEventListener('toggle', () => {
  referenceOverviewSummary.setAttribute('aria-expanded', String(referenceOverview.open));
  referenceOverviewSummary.setAttribute('aria-label', referenceOverview.open ? '기준정보 상태 닫기' : '기준정보 상태 열기');
});
sourceTextInput.addEventListener('input', syncSourceText);
sourceTextInput.addEventListener('compositionstart', () => { state.sourceComposing = true; });
sourceTextInput.addEventListener('compositionend', () => { state.sourceComposing = false; syncSourceText(); });
sourceTextInput.addEventListener('scroll', () => {
  const highlight = $('sourceHighlight');
  if (!highlight) return;
  highlight.scrollTop = sourceTextInput.scrollTop;
  highlight.scrollLeft = sourceTextInput.scrollLeft;
}, { passive: true });
$('fileInput').addEventListener('change', event => handleFile(event.target.files?.[0]));
$('photoInput').addEventListener('change', event => recognizeImage(event.target.files?.[0]));
parserCard.addEventListener('dragover', event => {
  if (![...(event.dataTransfer?.types || [])].some(type => type === 'Files' || type === 'text/plain')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
parserCard.addEventListener('drop', event => { void acceptParserDrop(event); });
$('photoPreview').addEventListener('load', renderPhotoTransform);
$('photoZoomOut').addEventListener('click', () => {
  state.photoView.zoom = Math.max(.5, Number(state.photoView.zoom || 1) - .25);
  renderPhotoTransform();
});
$('photoZoomIn').addEventListener('click', () => {
  state.photoView.zoom = Math.min(4, Number(state.photoView.zoom || 1) + .25);
  renderPhotoTransform();
});
$('photoFit').addEventListener('click', () => {
  state.photoView.zoom = 1;
  renderPhotoTransform();
  $('photoViewport').scrollTo({ left: 0, top: 0 });
});
$('photoRotateLeft').addEventListener('click', () => {
  state.photoView.rotation = Number(state.photoView.rotation || 0) - 90;
  renderPhotoTransform();
});
$('photoRotateRight').addEventListener('click', () => {
  state.photoView.rotation = Number(state.photoView.rotation || 0) + 90;
  renderPhotoTransform();
});
$('photoOcrToggle').addEventListener('click', () => {
  state.photoView.ocrOpen = !state.photoView.ocrOpen;
  renderSourceSurface();
});
$('photoOcrClose').addEventListener('click', () => {
  state.photoView.ocrOpen = false;
  renderSourceSurface();
  $('photoOcrToggle').focus();
});
$('photoEmptySelectButton').addEventListener('click', () => $('photoInput').click());
$('detailColumnsButton').addEventListener('click', () => {
  state.photoView.detailColumns = !state.photoView.detailColumns;
  modeUi().detailColumns = state.photoView.detailColumns;
  scheduleSave();
  applyFormLayout();
});
const photoResizer = $('photoResizer');
function applyParserPaneWidth(requestedWidth) {
  const workspace = document.querySelector('.workspace');
  const bounds = workspace.getBoundingClientRect();
  const relatedWidth = window.innerWidth > 1480 ? 244 : 0;
  const maximum = Math.max(330, bounds.width - relatedWidth - 8 - 520 - 24);
  const width = Math.round(Math.max(330, Math.min(maximum, requestedWidth)));
  state.draft.ui.parserPaneWidth = width;
  workspace.style.setProperty('--parser-pane-width', `${width}px`);
  window.requestAnimationFrame(renderPhotoTransform);
  return width;
}
photoResizer.addEventListener('pointerdown', event => {
  if (window.innerWidth <= 1240) return;
  event.preventDefault();
  photoResizer.classList.add('is-dragging');
  photoResizer.setPointerCapture(event.pointerId);
});
photoResizer.addEventListener('pointermove', event => {
  if (!photoResizer.hasPointerCapture(event.pointerId)) return;
  const workspace = document.querySelector('.workspace');
  const bounds = workspace.getBoundingClientRect();
  applyParserPaneWidth(event.clientX - bounds.left);
});
const finishPhotoResize = event => {
  if (photoResizer.hasPointerCapture(event.pointerId)) photoResizer.releasePointerCapture(event.pointerId);
  photoResizer.classList.remove('is-dragging');
  scheduleSave();
};
photoResizer.addEventListener('pointerup', finishPhotoResize);
photoResizer.addEventListener('pointercancel', finishPhotoResize);
photoResizer.addEventListener('keydown', event => {
  if (window.innerWidth <= 1240 || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const currentWidth = document.querySelector('.parser-card').getBoundingClientRect().width;
  const step = event.shiftKey ? 40 : 12;
  applyParserPaneWidth(currentWidth + (event.key === 'ArrowRight' ? step : -step));
  scheduleSave();
});
$('analyzeButton').addEventListener('click', () => analyzeSource({ automatic: false }));
$('clearParserButton').addEventListener('click', clearParserWorkspace);
$('undoGridPasteButton').addEventListener('click', undoGridPaste);
$('gridSearchInput').addEventListener('input', event => {
  state.gridSearch = event.target.value;
  renderRows({ restoreFocus: false });
});
$('addRowButton').addEventListener('click', () => {
  if (modeDraft().activeMethod !== 'photo') updateMethod('direct');
  addDirectRow();
});
$('customerSearchButton').addEventListener('click', chooseCustomer);
$('customerInput').addEventListener('input', event => {
  const header = modeDraft().header;
  if (event.target.value.trim() !== header.customerName) {
    header.customerId = '';
    header.customerCode = '';
    header.customerName = event.target.value.trim();
    header.customerLinkGroupId = '';
    header.taxCustomerId = '';
    header.taxCustomerName = '';
    header.isTemporaryCustomer = false;
    header.customerMappingSource = '';
    event.target.dataset.customerId = '';
    applyCustomerRelationship(header);
    updateDeliveryPolicy();
    renderCatalogControls();
    renderVoucherContext();
    $('customerHint').textContent = '등록 거래처를 선택해야 주문서 원장에 저장할 수 있습니다.';
    scheduleSave();
  }
});
$('customerInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    chooseCustomer();
  }
});
$('deliveryDateInput').addEventListener('input', event => {
  const header = modeDraft().header;
  if (state.draft.activeMode === 'purchase' || state.draft.activeMode === 'sale') {
    header.voucherDate = event.target.value;
    header.deliveryDate = event.target.value;
  } else {
    header.deliveryDate = event.target.value;
  }
  modeDraft().header.manualDeliveryOverride = true;
  updateDeliveryPolicy();
  renderVoucherContext();
  scheduleSave();
});
$('warehouseInput').addEventListener('input', applyWarehouseMatch);
$('warehouseInput').addEventListener('change', applyWarehouseMatch);
$('transactionTypeInput').addEventListener('change', event => { modeDraft().header.transactionType = event.target.value; renderVoucherContext(); scheduleSave(); });
$('completeButton').addEventListener('click', completeOrder);
$('restoreAutosaveButton').addEventListener('click', restoreLatestAutosave);
$('estimateNoticeButton').addEventListener('click', shareCurrentVoucher);
$('estimateExcelButton').addEventListener('click', exportCurrentVoucherExcel);
$('selectedEstimateDeleteButton').addEventListener('click', () => { void deleteSelectedEstimates(); });
$('estimateRenameButton').addEventListener('click', openSelectedEstimateRenameDialog);
$('estimateCreateButton').addEventListener('click', openEstimateCreateChoiceDialog);
$('estimateLibrarySwitchButton').addEventListener('click', () => {
  rememberActiveEstimateWork();
  const returnDraft = state.estimateSelectionReturnDraft;
  state.noticeEstimateIds = [];
  state.estimateSelectionReturnDraft = null;
  if (returnDraft) state.draft.modes.estimate = contract.normalizeModeDraft('estimate', returnDraft);
  state.estimateLibraryKind = state.estimateLibraryKind === 'linked' ? 'individual' : 'linked';
  saveDraftNow();
  renderMode();
});

function handleEstimateCardSelection(event) {
  if (state.estimateDragSuppressed) return;
  if (event.target.closest('[data-estimate-drag-handle]')) return;
  const card = event.target.closest('.estimate-card[data-estimate-id]');
  if (!card) return;
  const record = state.estimates.find(item => item.estimateId === card.dataset.estimateId);
  if (!record) return;
  state.estimateSelectionQueue = state.estimateSelectionQueue.then(() => {
      if (!state.noticeEstimateIds.length) state.estimateSelectionReturnDraft = JSON.parse(JSON.stringify(modeDraft()));
      rememberActiveEstimateWork();
      const selected = new Set(state.noticeEstimateIds);
      if (selected.has(record.estimateId)) selected.delete(record.estimateId);
      else selected.add(record.estimateId);
      state.noticeEstimateIds = estimateRecordsForKind().filter(item => selected.has(item.estimateId)).map(item => item.estimateId);
      previewSelectedEstimates();
    }).catch(error => {
      toast(error.message || '견적서를 선택하지 못했습니다.', 'error');
    });
}

$('catalogPickerList').addEventListener('click', handleEstimateCardSelection);
$('linkedEstimateList').addEventListener('click', handleEstimateCardSelection);
[...[$('catalogPickerList'), $('linkedEstimateList')]].forEach(list => {
  list.addEventListener('dragstart', beginEstimateCardDrag);
  list.addEventListener('dragover', moveEstimateCardDrag);
  list.addEventListener('drop', event => { finishEstimateCardDrop(event).catch(error => toast(error.message || '견적서 순서를 변경하지 못했습니다.', 'error')); });
  list.addEventListener('dragend', clearEstimateCardDrag);
  list.addEventListener('dragleave', event => event.target.closest('.estimate-card')?.classList.remove('is-drop-target'));
  list.addEventListener('touchstart', beginEstimateTouchDrag, { passive: true });
  list.addEventListener('touchmove', moveEstimateTouchDrag, { passive: false });
  list.addEventListener('touchend', event => { finishEstimateTouchDrag(event).catch(error => toast(error.message || '견적서 순서를 변경하지 못했습니다.', 'error')); }, { passive: false });
  list.addEventListener('touchcancel', cancelEstimateTouchDrag, { passive: true });
  list.addEventListener('contextmenu', event => {
    if (event.target.closest('[data-estimate-drag-handle]')) event.preventDefault();
  });
});
$('settingsButton').addEventListener('click', openSettingsDialog);
$('voucherContextList').addEventListener('click', event => {
  const item = event.target.closest('[data-voucher-focus]');
  if (item) focusVoucherContextTarget(item.dataset.voucherFocus);
});
$('relatedCollapseButton').addEventListener('click', event => {
  const panel = $('estimateLibraryView');
  const open = panel.classList.toggle('is-open');
  state.draft.ui.relatedOpen = open;
  event.currentTarget.setAttribute('aria-expanded', String(open));
  event.currentTarget.textContent = relatedPanelButtonLabel(open);
  scheduleSave();
});
$('resetDraftButton').addEventListener('click', () => resetCurrentMode(false));

const voucherTableHead = document.querySelector('#tableScroll thead');
voucherTableHead.addEventListener('pointerdown', beginColumnResize);
voucherTableHead.addEventListener('keydown', resizeColumnWithKeyboard);
voucherTableHead.addEventListener('dragstart', beginColumnDrag);
voucherTableHead.addEventListener('dragover', moveColumnDrag);
voucherTableHead.addEventListener('drop', finishColumnDrop);
voucherTableHead.addEventListener('dragend', finishColumnDrag);

document.querySelector('.app-bar').addEventListener('input', event => {
  const input = event.target.closest('[data-custom-header-input]');
  if (!input) return;
  modeDraft().header.customValues ||= {};
  modeDraft().header.customValues[input.dataset.customHeaderInput] = input.value;
  scheduleSave();
});

inputRows.addEventListener('input', event => {
  invalidateGridPasteUndo();
  const targetRow = event.target.closest('[data-row-id]');
  if (targetRow?.dataset.defaultRow === 'true' && hasEnteredValue(event.target.value)) materializeDefaultRow(targetRow, event.target);
  if (event.target.closest('[data-product-search]')) return;
  const customInput = event.target.closest('[data-custom-row-field]');
  if (customInput) {
    const customRow = event.target.closest('[data-row-id]');
    const row = modeDraft().rows.find(item => item.rowId === customRow?.dataset.rowId);
    if (!row) return;
    row.customValues ||= {};
    row.customValues[customInput.dataset.customRowField] = customInput.value;
    if (isLinkedRow(row)) row.linkedSyncFields = [...new Set([...(row.linkedSyncFields || []), 'customValues'])];
    scheduleSave();
    return;
  }
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr) return;
  const index = modeDraft().rows.findIndex(row => row.rowId === tr.dataset.rowId);
  if (index < 0) return;
  const field = input.dataset.field;
  const previousRow = modeDraft().rows[index];
  if (previousRow.linkedFieldConflicts?.includes(field)) {
    const applyToAll = window.confirm(`연결된 견적서마다 ${input.getAttribute('aria-label') || '이 셀'} 값이 다릅니다. 현재 입력값을 연결된 견적서 모두에 동일 적용할까요?`);
    if (!applyToAll) {
      renderRows();
      return;
    }
    previousRow.linkedFieldConflicts = previousRow.linkedFieldConflicts.filter(item => item !== field);
    previousRow.linkedConflictResolvedFields = [...new Set([...(previousRow.linkedConflictResolvedFields || []), field])];
    previousRow.linkedPriceConflict = previousRow.linkedFieldConflicts.includes('unitPrice');
  }
  const row = contract.markProductEdit(modeDraft().rows[index], field, input.value);
  if (field === 'itemCode' || field === 'itemName') {
    tr.dataset.status = 'SIMILAR';
    const status = tr.querySelector('.row-status span');
    if (status) status.textContent = rowStatusText('SIMILAR');
  }
  modeDraft().rows[index] = row;
  if (field === 'quantity' || field === 'unitPrice') {
    const amount = Number(row.quantity || 0) * Number(row.unitPrice || 0);
    const amountInput = tr.querySelector('[data-supply-amount]');
    if (amountInput) amountInput.value = amount.toLocaleString('ko-KR');
  }
  updateSummaries();
  scheduleSave();
});
inputRows.addEventListener('keydown', event => {
  const input = event.target.closest('[data-product-search], [data-field], [data-custom-row-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr || event.isComposing) return;
  const field = gridFieldId(input);
  const rowTab = event.key === 'Tab';
  if (!rowTab && !['Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  if (tr.dataset.defaultRow === 'true' && input.value) materializeDefaultRow(tr, input);
  const rowId = tr.dataset.rowId;
  if (rowTab) {
    const rowTarget = nextRowEntryTarget(rowId, event.shiftKey);
    if (!rowTarget) return;
    event.preventDefault();
    focusGridTarget(rowTarget);
    return;
  }
  event.preventDefault();
  const focusTarget = event.key === 'Enter'
    ? sequentialGridTarget(rowId, field)
    : directionalGridTarget(rowId, field, event.key);
  if (event.key !== 'Enter') {
    focusGridTarget(focusTarget);
    return;
  }
  const row = modeDraft().rows.find(item => item.rowId === tr.dataset.rowId);
  if (row && field === 'productSearch') {
    trySearchProductRow(row, input.value, { focusTarget });
    return;
  }
  if (row && ['itemCode', 'itemName'].includes(field)) {
    input.dataset.matchSubmitted = 'true';
    tryMatchRow(row, field, { focusTarget });
    return;
  }
  focusGridTarget(focusTarget);
});
inputRows.addEventListener('focusin', event => {
  const input = event.target.closest('[data-product-search], [data-field], [data-custom-row-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr) return;
  window.requestAnimationFrame(() => {
    if (document.activeElement !== input) return;
    input.select?.();
    revealGridInput(input);
  });
  modeUi().activeCellId = `${tr.dataset.rowId}|${gridFieldId(input)}`;
  state.draft.ui.selectedRowId = tr.dataset.rowId;
  const row = modeDraft().rows.find(item => item.rowId === tr.dataset.rowId);
  if (modeDraft().activeMethod === 'photo') showPhotoRegion(row?.sourceRegion || null);
});
inputRows.addEventListener('focusout', event => {
  const input = event.target.closest('[data-field="unitPrice"]');
  if (!input) return;
  confirmUnitPriceReview(event.target.closest('[data-row-id]'));
});
inputRows.addEventListener('change', event => {
  const selector = event.target.closest('[data-select-row]');
  if (selector) {
    if (selector.checked) state.selectedRowIds.add(selector.dataset.selectRow);
    else state.selectedRowIds.delete(selector.dataset.selectRow);
    syncRowSelectionControls();
    return;
  }
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr || !['itemCode', 'itemName'].includes(input.dataset.field)) return;
  if (input.dataset.matchSubmitted === 'true') return;
  const row = modeDraft().rows.find(item => item.rowId === tr.dataset.rowId);
  if (row) tryMatchRow(row, input.dataset.field);
});
inputRows.addEventListener('click', event => {
  const registerProduct = event.target.closest('[data-product-register]');
  if (registerProduct) {
    const row = modeDraft().rows.find(item => item.rowId === registerProduct.dataset.productRegister);
    if (row) {
      void queueOwnerRegistration('product', {
        itemCode: row.itemCode,
        itemName: row.itemName || row.unregisteredProductQuery || row.rawText,
        specification: row.specification,
        unit: row.unit
      }, {
        rowId: row.rowId,
        idempotencyKey: `${modeDraft().documentId}:${row.rowId}:PRODUCT_CREATE`
      }).then(result => {
        registerProduct.dataset.requestStatus = result.status || 'ERROR';
        registerProduct.title = result.accepted ? '등록 변경요청 접수 완료' : `변경요청 ${result.status || '실패'} · 현재 작업은 유지됩니다.`;
      });
    }
  }
  const tr = event.target.closest('[data-row-id]');
  const editableInput = event.target.closest('[data-product-search], [data-field], [data-custom-row-field]');
  if (tr && !editableInput && modeDraft().activeMethod === 'photo') {
    const row = modeDraft().rows.find(item => item.rowId === tr.dataset.rowId);
    state.draft.ui.selectedRowId = tr.dataset.rowId;
    showPhotoRegion(row?.sourceRegion || null);
  }
  const detach = event.target.closest('[data-detach-orderq]');
  if (detach) {
    const index = modeDraft().rows.findIndex(row => row.rowId === detach.dataset.detachOrderq);
    if (index < 0) return;
    try {
      modeDraft().rows[index] = contract.normalizeRow(detachOrderQPurchaseLink(modeDraft().rows[index], {
        originSystem: modeDraft().rows[index].directOriginSystem || 'SMARTINPUT_FILE',
        originTransactionId: modeDraft().rows[index].directOriginTransactionId
      }));
      renderRows({ restoreFocus: false });
      saveDraftNow();
      toast('ORDER Q 연결을 해제했습니다. 새 상품을 명시적으로 선택하세요.', 'warn');
    } catch (error) {
      toast(error.message || 'ORDER Q 연결 해제에 실패했습니다.', 'error');
    }
  }
});

$('selectAllRows').addEventListener('change', event => {
  state.selectedRowIds = event.target.checked
    ? new Set(modeDraft().rows.map(row => row.rowId))
    : new Set();
  renderRows({ restoreFocus: false });
});
$('deleteSelectedRows').addEventListener('click', deleteSelectedGridRows);

inputRows.addEventListener('paste', event => {
  const searchInput = event.target.closest('[data-product-search]');
  if (searchInput) {
    event.preventDefault();
    event.stopPropagation();
    toast('상품 검색 열에는 붙여넣을 수 없습니다. 직접 검색어를 입력하세요.', 'error');
    return;
  }
  const input = event.target.closest('[data-field], [data-custom-row-field]');
  const tr = event.target.closest('[data-row-id]');
  const clipboardText = event.clipboardData?.getData('text/plain');
  if (!input || !tr || clipboardText === undefined || clipboardText === '') return;
  event.preventDefault();
  event.stopPropagation();
  applyGridPaste(clipboardText, tr.dataset.rowId, gridFieldId(input));
});

document.addEventListener('paste', event => {
  const image = [...(event.clipboardData?.items || [])]
    .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map(item => item.getAsFile())
    .find(Boolean);
  if (image) {
    event.preventDefault();
    recognizeImage(image);
    return;
  }
  const pastedText = event.clipboardData?.getData('text/plain') || '';
  if (event.target === sourceTextInput && pastedText) {
    updateMethod('paste');
    window.setTimeout(syncSourceText, 0);
  } else if (parserCard.contains(event.target) && pastedText) {
    event.preventDefault();
    appendParserText(pastedText, 'paste');
  }
});

window.addEventListener('resize', () => {
  window.requestAnimationFrame(renderPhotoTransform);
}, { passive: true });

$('tableScroll').addEventListener('scroll', event => {
  modeUi().scrollTop = event.currentTarget.scrollTop;
  modeUi().scrollLeft = event.currentTarget.scrollLeft;
}, { passive: true });

window.addEventListener('pagehide', () => {
  if (state.draftDirty) saveDraftNow();
});
renderMode();
initializeAutosave();
hydrateReferences();
