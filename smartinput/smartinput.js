import {
  captureTextIntake,
  analyzeSingleOrderDocument,
  rematchExtractedLinesForCustomer,
  extractOrderProductLines,
  createOrder,
  syncAfterLocalMutation,
  syncOfficialAfterLocalMutation,
  syncOfficialVouchers,
  isSelectableMasterProduct,
  loadWarehouseCatalog,
  matchWarehouseInput,
  warehouseDisplayName,
  loadPurchaseStage3Capability,
  loadSaleStage4Capability
} from './legacy-integration-adapter.js?v=0.3.0';
import { PurchaseFinalizeService } from './purchase-finalize-service.js?v=0.6.0';
import { SaleFinalizeService } from './sale-finalize-service.js?v=0.6.0';
import { showStocktakeConflictDialog } from './stocktake-conflict-dialog.js?v=0.2.0';
import { recognizeOcrDocument, verifiedRowsToParserLines } from './ocr-document-parser.js?v=0.1.1';
import { buildGridPastePlan, parseClipboardMatrix } from './grid-clipboard.js?v=0.1.0';
import {
  DECISION as MAPPING_DECISION,
  SESSION_STATUS as MAPPING_SESSION_STATUS,
  addManualRow,
  createMappingSession,
  createTemplateRecord,
  deleteWorkingRows,
  detectHeaderRow,
  mappingSummary,
  projectMappedRows,
  reassignHeaderRow,
  setColumnDecision,
  updateWorkingCell,
  validateTemplateDraft
} from './input-template-mapper.js?v=0.2.0';
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
} from './multivoucher-stage1.js?v=0.2.0';
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
  commitEstimateBundle,
  loadSmartInputData,
  normalizeAliasName,
  saveAliasMapping,
  saveEstimate,
  saveEstimateBundle,
  saveLinkGroup,
  saveReferenceCache,
  saveSettings,
  saveSourceImage,
  saveTemporaryCustomer,
  loadLatestAutosave,
  saveLatestAutosave,
  loadInputTemplates,
  saveInputTemplates,
  saveMappingSessionV2
} from './smartinput-data-store.js?v=0.6.0';
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
import { readVoucherActivity } from '../orderq/voucher-activity-read-adapter.js?v=0.2.0';
import { coreFieldByProjection } from './field-definition-contract.js?v=0.1.0';
import {
  ensureFieldCatalogSeed,
  loadVoucherFieldRegistry,
  resolveSmartInputActor,
  resolveSmartInputCompanyId,
  updateVoucherFieldSettings
} from './field-registry.js?v=0.1.0';
import { refreshAllReferenceData } from './reference-refresh-controller.js?v=0.1.0';
import { readWorksheetSource } from './xlsx-source-reader.js?v=0.1.0';
import {
  applyRelatedVoucherImportPlan,
  createRelatedVoucherImportPlan,
  relatedImportConflicts
} from './related-voucher-import.js?v=0.1.0';
import { applyBulkUnitPrice } from './grid-bulk-edit.js?v=0.1.0';

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
  inputTemplates: [],
  inputTemplatesStatus: 'LOADING',
  inputTemplatesError: null,
  companyId: resolveSmartInputCompanyId(),
  actorId: resolveSmartInputActor(),
  fieldRegistries: {},
  fieldRegistryStatus: 'LOADING',
  fieldRegistryError: null,
  pendingGridPasteText: '',
  mappingPasteUndo: null,
  mappingProjectionTimer: null,
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
  estimateMultiSelectKind: '',
  estimateWorkingCopies: new Map(),
  estimateSelectionReturnDraft: null,
  lastEstimateSave: null,
  estimateDragSuppressed: false,
  estimateTouchDrag: null,
  estimateSelectionQueue: Promise.resolve(),
  voucherActivity: { requestId: 0, status: 'IDLE', mode: '', sourceMode: '', date: '', rows: [], error: null, checkedAt: '' },
  purchaseCapability: { ready: false, code: 'ORDERQ_PURCHASE_STAGE3_CAPABILITY_UNAVAILABLE', detail: 'loading' },
  saleCapability: { ready: false, code: 'ORDERQ_SALE_STAGE4_CAPABILITY_UNAVAILABLE', detail: 'loading' }
};
if (state.draft.ui.relatedPanelLayoutVersion !== 1) {
  state.draft.ui.relatedPanelLayoutVersion = 1;
  state.draft.ui.relatedOpen = true;
  state.draft.ui.relatedPaneWidth = 260;
}

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
  if (reload) {
    reload.disabled = state.busy || Boolean(reference.loading);
    reload.textContent = reference.loading ? '불러오는 중…' : '다시 불러오기';
  }
}

function renderReferenceControls() {
  $('analyzeButton').disabled = state.busy;
  $('customerSearchButton').disabled = state.busy || modeDraft().estimateKind === 'LINKED_GROUP' || estimateCreation()?.kind === 'LINKED_GROUP';
  $('estimateNoticeButton').disabled = state.busy;
  $('estimateExcelButton').disabled = state.busy;
  const creation = estimateCreation();
  $('estimateCreateButton').disabled = state.busy || !creation || creation.selectedIds.length < 2;
  $('selectedEstimateDeleteButton').disabled = state.busy || state.noticeEstimateIds.length < 1;
  $('estimateRenameButton').disabled = state.busy || state.noticeEstimateIds.length !== 1;
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
  const allReload = $('allReferenceReload');
  if (allReload) {
    allReload.disabled = state.busy;
    allReload.textContent = state.activeActivity === '기준정보 전체 새로고침' ? '전체 새로고침 중…' : '전체 기준정보 새로고침';
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
    ...builtIn.map(field => modeFields.has(field.id) ? {
      ...field,
      label: modeFields.get(field.id).label,
      inputAliases: [...new Set([...(field.inputAliases || []), ...(modeFields.get(field.id).inputAliases || [])])]
    } : field),
    ...customFields.filter(field => field.scope === scope).map(field => ({
      ...field,
      group: scope === 'voucher' ? 'ADDITIONAL' : field.group,
      custom: true,
      required: false
    }))
  ];
}

function availableRegistryFields(scope, mode = state.draft.activeMode) {
  const registry = state.fieldRegistries[mode];
  if (!registry) return [];
  const targetScope = scope === 'header' ? 'HEADER' : 'LINE';
  const existingIds = new Set([
    ...(scope === 'header' ? contract.HEADER_FIELD_DEFINITIONS : contract.PRODUCT_FIELD_DEFINITIONS).map(field => field.id),
    ...(state.settings.customFields || []).filter(field => field.scope === scope).map(field => field.id)
  ]);
  return registry.catalog
    .filter(field => field.status === 'ACTIVE'
      && field.voucherModes.includes(mode)
      && (field.scope === targetScope || (scope === 'voucher' && field.scope === 'REFERENCE'))
      && (field.writable || field.scope === 'REFERENCE')
      && !existingIds.has(field.fieldId))
    .map(field => ({
      id: field.fieldId,
      label: field.displayLabel,
      optionLabel: field.advancedLabel,
      advancedLabel: field.advancedLabel,
      scope,
      category: scope === 'header' ? 'CUSTOMER' : 'PRODUCT',
      sourceField: field.fieldId,
      valueType: field.valueType === 'DECIMAL' ? 'NUMBER' : 'TEXT',
      editable: field.writable,
      ownerDomain: field.ownerDomain,
      relationshipPath: field.relationshipPath,
      registryField: true
    }));
}

const MAPPING_DEFAULT_ROW_ID = '__SMARTINPUT_MAPPING_DEFAULT_ROW__';

function inputMappingSession(current = modeDraft()) {
  return current?.inputMapping?.schemaVersion === 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2'
    ? current.inputMapping
    : null;
}

function inputMappingTargets() {
  const headerProjection = {
    customer: 'rowCustomerName',
    deliveryDate: 'rowDeliveryDate',
    warehouse: 'rowWarehouseCode',
    transactionType: 'rowTransactionType'
  };
  const enabledHeaderIds = new Set(headerFieldsForMode());
  const enabledVoucherIds = new Set(voucherColumnsForMode());
  const headerTargets = layoutDefinitions('header').filter(field => enabledHeaderIds.has(field.id)).map(field => ({
    id: field.id,
    label: field.label,
    scope: 'header',
    valueType: field.valueType === 'NUMBER' ? 'NUMBER' : 'TEXT',
    projectionFieldId: headerProjection[field.id] || field.id,
    custom: Boolean(field.custom),
    aliases: [...new Set([...(field.inputAliases || []), ...(field.masterAliases || [])])]
  }));
  const voucherTargets = layoutDefinitions('voucher').filter(field => enabledVoucherIds.has(field.id)).map(field => {
    const canonical = coreFieldByProjection(state.draft.activeMode, field.id);
    return {
      id: canonical?.fieldId || field.id,
      label: canonical?.displayLabel || field.label,
      scope: 'voucher',
      group: field.group || 'ADDITIONAL',
      valueType: field.valueType === 'NUMBER' ? 'NUMBER' : 'TEXT',
      projectionFieldId: canonical?.projectionFieldId || field.id,
      custom: Boolean(field.custom),
      aliases: [...new Set([
        ...(field.inputAliases || []),
        ...(field.masterAliases || []),
        ...(canonical?.aliases || []),
        field.label
      ])]
    };
  });
  const unique = new Map();
  [...headerTargets, ...voucherTargets].forEach(target => {
    if (!unique.has(target.id)) unique.set(target.id, target);
  });
  return [...unique.values()];
}

function mappingTargetById(fieldId) {
  return inputMappingTargets().find(target => target.id === fieldId) || null;
}

function mappingTargetByProjection(projectionFieldId) {
  return inputMappingTargets().find(target => (target.projectionFieldId || target.id) === projectionFieldId) || null;
}

function rowFieldDisplayValue(row, projectionFieldId, fallback = '') {
  const target = mappingTargetByProjection(projectionFieldId);
  const tracked = target ? row?.fieldValues?.[target.id] : null;
  return tracked && !tracked.edited ? tracked.currentDisplayValue : fallback;
}

function markMappedFieldEdited(row, projectionFieldId, displayValue) {
  const target = mappingTargetByProjection(projectionFieldId);
  if (!target || !row?.fieldValues?.[target.id]) return row;
  return {
    ...row,
    fieldValues: {
      ...row.fieldValues,
      [target.id]: {
        ...row.fieldValues[target.id],
        currentDisplayValue: String(displayValue ?? ''),
        parsedValue: row[projectionFieldId] ?? null,
        edited: true
      }
    }
  };
}

function inputMappingTemplateReady(session = inputMappingSession()) {
  return Boolean(session?.templateId && session.status === MAPPING_SESSION_STATUS.TEMPLATE_APPLIED);
}

function mappingStateText(mapping) {
  if (mapping?.state === MAPPING_DECISION.MAPPED) return mappingTargetById(mapping.targetFieldId)?.label || '연결 대상 없음';
  if (mapping?.state === MAPPING_DECISION.RECOMMENDED) return `${mappingTargetById(mapping.targetFieldId)?.label || '확인 필요'} · 추천`;
  if (mapping?.state === MAPPING_DECISION.UNMAPPED) return '비매핑 · 전표 제외';
  return '매핑을 지정하세요';
}

function mappingSessionWithBatch(session) {
  if (session.batchId) return session;
  return {
    ...session,
    batchId: `SIBATCH-MAPPING-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  };
}

function projectInputMappingToVoucherRows({ preserveProductEdits = true } = {}) {
  const current = modeDraft();
  const session = inputMappingSession(current);
  if (!session) return;
  const priorRows = preserveProductEdits ? new Map((current.rows || []).map(row => [row.rowId, row])) : new Map();
  let projectedSources = projectMappedRows(session, inputMappingTargets());
  if (state.draft.activeMode === 'purchase' && session.purchaseMetaRows) {
    projectedSources = joinPurchaseMeta({
      visibleSheetName: session.sheetName,
      visibleRows: projectedSources.map(row => ({ ...row, directOriginSystem: 'SMARTINPUT_FILE', directOriginTransactionId: session.fileFingerprint })),
      metaRows: session.purchaseMetaRows
    });
  } else if (state.draft.activeMode === 'purchase') {
    projectedSources = projectedSources.map(row => ({
      ...row,
      sourceType: 'DIRECT',
      contractKind: 'PURCHASE_STAGE3_V1',
      originSystem: 'SMARTINPUT_FILE',
      originTransactionId: session.fileFingerprint,
      sourceFingerprint: session.fileFingerprint,
      sourceDocumentKey: row.sourceDocumentKey || stableDirectDocumentKey({
        originSystem: 'SMARTINPUT_FILE',
        originTransactionId: session.fileFingerprint,
        externalDocumentNo: row.rowVoucherNo,
        sourceVoucherIndex: row.sourceVoucherIndex
      }),
      metaStatus: 'DIRECT_NO_META'
    }));
  } else if (state.draft.activeMode === 'sale' && session.salesMetaRows) {
    projectedSources = joinSalesMeta({
      visibleSheetName: session.sheetName,
      visibleRows: projectedSources.map(row => ({ ...row, directOriginSystem: 'SMARTINPUT_FILE', directOriginTransactionId: session.fileFingerprint })),
      metaRows: session.salesMetaRows
    });
  } else if (state.draft.activeMode === 'sale') {
    projectedSources = projectedSources.map(row => ({
      ...row,
      sourceType: 'DIRECT',
      contractKind: 'SALE_STAGE4_V1',
      originSystem: 'SMARTINPUT_FILE',
      originTransactionId: session.fileFingerprint,
      sourceFingerprint: session.fileFingerprint,
      actualToBaseFactor: 1,
      actualToRecognizedFactor: 0,
      actualUnit: row.unit || '',
      baseUnit: row.unit || '',
      recognizedUnit: row.unit || '',
      conversionSource: 'DIRECT_SAME_UNIT',
      conversionRuleId: 'DIRECT_1_TO_1',
      conversionRuleVersion: 'DIRECT_1_TO_1_V1',
      metaStatus: 'DIRECT_NO_META'
    }));
  }
  const projected = projectedSources.map((source, index) => {
    const previous = priorRows.get(source.rowId);
    let row = contract.normalizeRow({
      ...source,
      batchId: session.batchId,
      sourceBatchId: session.batchId,
      sourceSheetName: session.sheetName,
      sourceFingerprint: session.fileFingerprint,
      sourceDocumentKey: `${session.fileFingerprint || session.fileName}:${session.sheetName || 'SHEET'}`,
      sourceType: 'STRUCTURED_FILE',
      sourceLineKey: `${session.batchId}:sheet:${source.sourceLineNo || index + 1}`,
      matchStatus: 'UNRESOLVED'
    }, session.batchId);
    if (previous) {
      ['productId', 'masterProductId', 'candidateProducts', 'referenceResolution', 'productMasterRevision', 'matchStatus']
        .forEach(field => { if (previous[field] !== undefined) row[field] = cloneGridValue(previous[field]); });
    }
    if (!row.productId || !row.masterProductId) row = matchGridPasteRow(row);
    return row;
  });
  current.rows = contract.markDuplicatePossibilities(projected);
  const mappingBatch = contract.createBatch({
    batchId: session.batchId,
    sequence: 1,
    method: 'excel',
    sourceType: 'STRUCTURED_FILE',
    sourceName: `${session.fileName}${session.sheetName ? ` · ${session.sheetName}` : ''}`,
    sourceRole: 'MAPPING_SOURCE',
    sourceSheetName: session.sheetName,
    rawText: current.sourceText,
    contentHash: session.fileFingerprint
  });
  current.batches = [...(current.batches || []).filter(batch => batch.sourceRole !== 'MAPPING_SOURCE'), mappingBatch];
  current.delivery = { status: 'DRAFT', targetId: '', targetRecordId: '', deliveredAt: '' };
}

function restoreInputMappingSession({ applyLatestTemplate = false } = {}) {
  const current = modeDraft();
  const existing = inputMappingSession(current);
  if (!existing) return null;
  let restored = createMappingSession({
    matrix: existing.sourceMatrix,
    headerRowIndex: existing.headerRowIndex,
    templates: state.inputTemplates,
    targetDefinitions: inputMappingTargets(),
    fileName: existing.fileName,
    sheetName: existing.sheetName,
    fileFingerprint: existing.fileFingerprint,
    editJournal: existing.editJournal,
    manualRows: existing.manualRows,
    hiddenColumns: existing.hiddenColumns,
    sourceCellMatrix: existing.sourceCellMatrix,
    companyId: state.companyId,
    voucherMode: state.draft.activeMode
  });
  if (!applyLatestTemplate && existing.status === MAPPING_SESSION_STATUS.NEW_TEMPLATE
    && existing.signature === restored.signature && Array.isArray(existing.mappings)) {
    restored = { ...restored, status: existing.status, mappings: existing.mappings.map(mapping => ({ ...mapping })), issues: [...(existing.issues || [])] };
  }
  restored.batchId = existing.batchId || mappingSessionWithBatch(restored).batchId;
  restored.purchaseMetaRows = existing.purchaseMetaRows || null;
  restored.salesMetaRows = existing.salesMetaRows || null;
  restored.deletedSourceRows = [...(existing.deletedSourceRows || [])];
  if (restored.deletedSourceRows.length) {
    restored.workingRows = restored.workingRows.filter(row => row.manual || !restored.deletedSourceRows.includes(row.sourceRowIndex));
  }
  current.inputMapping = restored;
  projectInputMappingToVoucherRows();
  return restored;
}

async function reloadInputTemplates({ applyCurrent = false, announce = true } = {}) {
  state.inputTemplatesStatus = 'LOADING';
  state.inputTemplatesError = null;
  renderInputMappingStatus();
  try {
    const templates = await loadInputTemplates(state.companyId, state.draft.activeMode);
    state.inputTemplates = Array.isArray(templates) ? templates : [];
    state.inputTemplatesStatus = state.inputTemplates.length ? 'READY' : 'EMPTY';
    if (applyCurrent) restoreInputMappingSession({ applyLatestTemplate: true });
    renderMode();
    saveDraftNow();
    if (announce) toast(applyCurrent ? '입력 양식을 다시 불러와 현재 원본에 적용했습니다.' : '입력 양식 목록을 다시 불러왔습니다.', 'success');
    return state.inputTemplates;
  } catch (error) {
    state.inputTemplatesStatus = 'ERROR';
    state.inputTemplatesError = error;
    renderInputMappingStatus();
    if (announce) toast(error.message || '입력 양식을 불러오지 못했습니다.', 'error');
    return null;
  }
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
  const total = visibleColumns.reduce((sum, fieldId) => sum + columnWidth(fieldId), 58);
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

function renderSourceSheet() {
  const session = inputMappingSession();
  const view = $('sourceSheetView');
  if (!session) {
    view.hidden = true;
    return;
  }
  const matrix = session.sourceMatrix || [];
  const width = Math.max(session.headers.length, ...matrix.map(row => row.length), 0);
  $('sourceSheetTitle').textContent = session.fileName || 'Excel 원본';
  $('sourceSheetMeta').textContent = `${session.sheetName || '시트'} · ${matrix.length.toLocaleString('ko-KR')}행 · ${width.toLocaleString('ko-KR')}열`;
  $('sourceHeaderRowStatus').textContent = `필드명 ${session.headerRowIndex + 1}행`;
  $('sourceSheetRows').innerHTML = matrix.map((row, rowIndex) => (
    `<tr class="${rowIndex === session.headerRowIndex ? 'is-header-row' : ''}" data-source-row-index="${rowIndex}">
      <th scope="row"><button type="button" data-use-header-row="${rowIndex}" aria-label="${rowIndex + 1}행을 필드명으로 사용">${rowIndex + 1}</button></th>
      ${Array.from({ length: width }, (_, columnIndex) => `<td title="${esc(row[columnIndex] ?? '')}">${esc(row[columnIndex] ?? '')}</td>`).join('')}
    </tr>`
  )).join('');
  window.requestAnimationFrame(() => {
    const selected = $('sourceSheetRows').querySelector('.is-header-row');
    selected?.scrollIntoView({ block: 'nearest' });
  });
}

function renderSourceSurface() {
  const evidence = currentSourceImage();
  const photoMode = modeDraft().activeMethod === 'photo';
  const sheetMode = modeDraft().activeMethod === 'excel' && Boolean(inputMappingSession());
  const showPhoto = photoMode && Boolean(evidence?.dataUrl);
  const workspace = document.querySelector('.workspace');
  const photoViewer = $('photoViewer');
  const expandedSource = photoMode || sheetMode;
  const photoStateChanged = workspace.classList.contains('has-photo-source') !== expandedSource;
  workspace.classList.toggle('has-photo-source', expandedSource);
  const savedWidth = Number(state.draft.ui.parserPaneWidth || state.draft.ui.photoPaneWidth || 0);
  if (savedWidth > 0) workspace.style.setProperty('--parser-pane-width', `${savedWidth}px`);
  $('sourceEditor').hidden = expandedSource;
  $('sourceSheetView').hidden = !sheetMode;
  photoViewer.hidden = !photoMode;
  photoViewer.classList.toggle('has-image', showPhoto);
  $('photoViewerToolbar').hidden = !showPhoto;
  $('photoEmptyState').hidden = showPhoto;
  $('photoStage').hidden = !showPhoto;
  $('photoViewerMeta').hidden = !showPhoto;
  $('analyzeButton').hidden = sheetMode || (photoMode && !showPhoto);
  if (sheetMode) renderSourceSheet();
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
  $('deliveryDateInput').value = state.draft.activeMode === 'order' ? (header.orderDate || header.voucherDate || header.deliveryDate) : header.deliveryDate;
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
  const registeredDefinitions = availableRegistryFields(scope);
  const categoryDefinitions = isHeader
    ? {
        CUSTOMER: definitions.filter(field => ['customer', 'taxCustomer'].includes(field.id)),
        ORDER: definitions.filter(field => !['customer', 'taxCustomer'].includes(field.id))
      }
    : Object.fromEntries(contract.PRODUCT_FIELD_GROUPS.map(group => [
        group.id,
        definitions.filter(field => field.group === group.id)
      ]));
  categoryDefinitions.REGISTERED = registeredDefinitions;
  const productCategoryOptions = contract.PRODUCT_FIELD_GROUPS
    .map(group => `<option value="${esc(group.id)}">${esc(group.label)}</option>`).join('');
  fieldDialog.innerHTML = `<form method="dialog" class="smart-dialog__shell">
    <header><div><small>Form Field Library</small><h2>${isHeader ? '상단 정보열' : '전표 열'} 항목 추가</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-form">
      <label><span>항목 분류</span><select name="category">${isHeader ? '<option value="CUSTOMER">거래처정보</option><option value="ORDER">주문정보</option>' : productCategoryOptions}<option value="REGISTERED">전체 등록 필드 (${registeredDefinitions.length.toLocaleString('ko-KR')})</option><option value="CUSTOM">${isHeader ? '사용자지정' : '부가정보 · 사용자지정'}</option></select></label>
      <label data-library-field><span>추가할 항목</span><input type="search" name="librarySearch" placeholder="항목명 검색" autocomplete="off"><select name="libraryField" size="8"></select></label>
      <label data-custom-type hidden><span>사용자지정 형식</span><select name="customType"><option value="TEXT">문자형 · 최대 10개</option><option value="NUMBER">숫자형 · 최대 10개</option></select></label>
      <label data-custom-label hidden><span>사용자지정 항목명</span><input name="customLabel" maxlength="30" placeholder="예: 배송 요청사항"></label>
    </div>
    <p class="smart-dialog__message">현재 전표에 적용 가능한 필드만 표시합니다. 전체 등록 필드는 경로로 구분합니다.</p>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-add>항목 추가</button></footer>
  </form>`;
  document.body.append(fieldDialog);
  const form = fieldDialog.querySelector('form');
  const finish = () => { fieldDialog.close(); fieldDialog.remove(); };
  const renderLibraryOptions = () => {
    const term = String(form.elements.librarySearch?.value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
    form.elements.libraryField.innerHTML = (categoryDefinitions[form.elements.category.value] || [])
      .filter(field => !term || `${field.optionLabel || field.label} ${field.id}`.normalize('NFKC').toLowerCase().replace(/\s+/g, '').includes(term))
      .slice(0, 500)
      .map(field => `<option value="${esc(field.id)}">${esc(field.optionLabel || field.label)}</option>`).join('');
  };
  const syncCategory = () => {
    const custom = form.elements.category.value === 'CUSTOM';
    fieldDialog.querySelector('[data-library-field]').hidden = custom;
    fieldDialog.querySelector('[data-custom-type]').hidden = !custom;
    fieldDialog.querySelector('[data-custom-label]').hidden = !custom;
    if (!custom) renderLibraryOptions();
    if (custom) form.elements.customLabel.focus();
  };
  form.elements.category.addEventListener('change', syncCategory);
  form.elements.librarySearch.addEventListener('input', renderLibraryOptions);
  fieldDialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  fieldDialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  fieldDialog.querySelector('[data-add]').addEventListener('click', () => {
    if (form.elements.category.value !== 'CUSTOM') {
      const selectedId = form.elements.libraryField.value;
      const selected = (categoryDefinitions[form.elements.category.value] || []).find(field => field.id === selectedId);
      if (!selected) {
        fieldDialog.querySelector('.smart-dialog__message').textContent = '추가할 항목을 선택하세요.';
        return;
      }
      onAdd(selected.registryField ? { ...selected, builtIn: false } : { id: selectedId, builtIn: true });
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
    const slotPrefix = valueType === 'NUMBER' ? 'custom.number.' : 'custom.text.';
    const usedIds = new Set(customFields.map(field => field.id));
    const slotId = Array.from({ length: 10 }, (_, index) => `${slotPrefix}${String(index + 1).padStart(2, '0')}`)
      .find(id => !usedIds.has(id));
    if (!slotId) {
      fieldDialog.querySelector('.smart-dialog__message').textContent = `${valueType === 'NUMBER' ? '숫자형' : '문자형'} 사용자지정 슬롯을 모두 사용 중입니다.`;
      return;
    }
    onAdd({
      id: slotId,
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

function openFieldMappingDialog(columnIndex) {
  const session = inputMappingSession();
  const mapping = session?.mappings?.[columnIndex];
  if (!session || !mapping) return;
  const editable = session.status === MAPPING_SESSION_STATUS.NEW_TEMPLATE;
  const targets = inputMappingTargets();
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog field-mapping-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Input Field Mapping</small><h2>필드명 매핑</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="field-mapping-current"><strong>${esc(mapping.sourceHeader || `(빈 필드명 · ${columnIndex + 1}열)`)}</strong><span>${columnIndex + 1}열</span><small>${esc(mappingStateText(mapping))}</small></div>
    ${editable ? '<label class="smart-dialog__search">환경설정 필드 검색<input type="search" data-mapping-search autocomplete="off" placeholder="상단·하단 필드명"></label><div class="field-mapping-results" data-mapping-results></div>' : `<div class="smart-dialog__empty"><strong>${esc(session.templateName || '기존 입력 양식')}</strong><br>기존 양식의 연결은 환경설정의 입력 양식 관리에서만 수정합니다.</div>`}
    <footer><button type="button" class="button button--quiet" data-hide-column>현재 열 숨기기</button>${editable ? '<button type="button" class="button button--danger" data-unmap>비매핑으로 확정</button>' : '<button type="button" class="button button--primary" data-manage-template>입력 양식 관리</button>'}</footer>
  </div>`;
  document.body.append(dialog);
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.querySelector('[data-hide-column]').addEventListener('click', () => {
    const current = inputMappingSession();
    current.hiddenColumns = [...new Set([...(current.hiddenColumns || []), columnIndex])];
    current.updatedAt = new Date().toISOString();
    renderRows({ restoreFocus: false });
    saveDraftNow();
    finish();
  });
  if (!editable) {
    dialog.querySelector('[data-manage-template]').addEventListener('click', () => {
      finish();
      openInputTemplateManager();
    });
    dialog.showModal();
    return;
  }
  const search = dialog.querySelector('[data-mapping-search]');
  const results = dialog.querySelector('[data-mapping-results]');
  const renderTargets = () => {
    const term = search.value.trim().toLowerCase();
    const used = new Map(session.mappings
      .filter(item => item.columnIndex !== columnIndex && [MAPPING_DECISION.MAPPED, MAPPING_DECISION.RECOMMENDED].includes(item.state) && item.targetFieldId)
      .map(item => [item.targetFieldId, item.columnIndex]));
    const filtered = targets.filter(target => !term || `${target.label} ${target.id}`.toLowerCase().includes(term));
    results.innerHTML = filtered.map(target => {
      const usedAt = used.get(target.id);
      return `<button type="button" class="field-mapping-option" data-mapping-target="${esc(target.id)}" ${usedAt !== undefined ? 'disabled' : ''}><span><strong>${esc(target.label)}</strong><small>${target.scope === 'header' ? '상단 정보' : '작업테이블'} · ${esc(target.id)}</small></span>${usedAt !== undefined ? `<em>${usedAt + 1}열에서 사용 중</em>` : ''}</button>`;
    }).join('') || '<div class="smart-dialog__empty">검색 결과가 없습니다.</div>';
  };
  search.addEventListener('input', renderTargets);
  results.addEventListener('click', event => {
    const button = event.target.closest('[data-mapping-target]');
    if (!button || button.disabled) return;
    try {
      modeDraft().inputMapping = setColumnDecision(inputMappingSession(), columnIndex, MAPPING_DECISION.MAPPED, button.dataset.mappingTarget, inputMappingTargets());
      projectInputMappingToVoucherRows();
      renderRows({ restoreFocus: false });
      saveDraftNow();
      finish();
    } catch (error) {
      toast(error.message === 'MAPPING_TARGET_DUPLICATED' ? '하나의 설정 필드에는 파일 열 하나만 연결할 수 있습니다.' : '필드를 연결하지 못했습니다.', 'error');
    }
  });
  dialog.querySelector('[data-unmap]').addEventListener('click', () => {
    modeDraft().inputMapping = setColumnDecision(inputMappingSession(), columnIndex, MAPPING_DECISION.UNMAPPED, '', inputMappingTargets());
    projectInputMappingToVoucherRows();
    renderRows({ restoreFocus: false });
    saveDraftNow();
    finish();
  });
  renderTargets();
  dialog.showModal();
  search.focus();
}

function openInputTemplateSaveDialog() {
  const session = inputMappingSession();
  if (!session || session.status !== MAPPING_SESSION_STATUS.NEW_TEMPLATE) return;
  if (!['READY', 'EMPTY'].includes(state.inputTemplatesStatus)) {
    toast('기존 양식 목록을 확인할 수 없어 신규 양식을 저장하지 않습니다. 양식을 다시 불러오세요.', 'error');
    return;
  }
  const validation = validateTemplateDraft(session, inputMappingTargets());
  if (!validation.valid) {
    const undecided = validation.issues.filter(issue => issue.code === 'UNDECIDED_COLUMN').map(issue => issue.columnIndex + 1);
    toast(undecided.length ? `매핑 또는 비매핑을 결정하지 않은 열이 있습니다: ${undecided.slice(0, 6).join(', ')}열` : '중복되거나 삭제된 연결 대상을 확인하세요.', 'error');
    return;
  }
  if (state.inputTemplates.some(template => template.signature === session.signature)) {
    toast('같은 구조의 공식 입력 양식이 이미 있습니다. 양식관리에서 수정하세요.', 'error');
    return;
  }
  const summary = mappingSummary(session);
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog smart-dialog--compact';
  dialog.innerHTML = `<form method="dialog" class="smart-dialog__shell">
    <header><div><small>New Input Template</small><h2>입력 양식 저장</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <label class="smart-dialog__search">양식명<input name="templateName" maxlength="80" autocomplete="off" placeholder="파일 구조를 구분할 이름" autofocus></label>
    <p class="smart-dialog__message">${session.headers.length}열 · 매핑 ${summary.mapped + summary.recommended} · 비매핑 ${summary.unmapped}. 추천 매핑을 포함한 현재 결정을 공식 양식으로 저장합니다.</p>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-save>양식 저장</button></footer>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const message = dialog.querySelector('.smart-dialog__message');
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  const submit = async () => {
    const name = form.elements.templateName.value.trim();
    if (!name) {
      message.textContent = '양식명을 입력하세요.';
      form.elements.templateName.focus();
      return;
    }
    if (state.inputTemplates.some(template => String(template.templateName || '').trim() === name)) {
      message.textContent = '같은 이름의 입력 양식이 있습니다. 다른 이름을 사용하세요.';
      form.elements.templateName.focus();
      form.elements.templateName.select();
      return;
    }
    const button = dialog.querySelector('[data-save]');
    button.disabled = true;
    try {
      const record = createTemplateRecord(inputMappingSession(), name, inputMappingTargets());
      const nextTemplates = [...state.inputTemplates, record];
      await saveInputTemplates(nextTemplates, { companyId: state.companyId, voucherMode: state.draft.activeMode });
      state.inputTemplates = nextTemplates;
      state.inputTemplatesStatus = 'READY';
      const existing = inputMappingSession();
      const applied = mappingSessionWithBatch(createMappingSession({
        matrix: existing.sourceMatrix,
        headerRowIndex: existing.headerRowIndex,
        templates: nextTemplates,
        targetDefinitions: inputMappingTargets(),
        fileName: existing.fileName,
        sheetName: existing.sheetName,
        fileFingerprint: existing.fileFingerprint,
        editJournal: existing.editJournal,
        manualRows: existing.manualRows,
        hiddenColumns: existing.hiddenColumns,
        sourceCellMatrix: existing.sourceCellMatrix,
        companyId: state.companyId,
        voucherMode: state.draft.activeMode
      }));
      applied.batchId = existing.batchId;
      applied.purchaseMetaRows = existing.purchaseMetaRows || null;
      applied.salesMetaRows = existing.salesMetaRows || null;
      applied.deletedSourceRows = [...(existing.deletedSourceRows || [])];
      if (applied.deletedSourceRows.length) applied.workingRows = applied.workingRows.filter(row => row.manual || !applied.deletedSourceRows.includes(row.sourceRowIndex));
      modeDraft().inputMapping = applied;
      projectInputMappingToVoucherRows();
      saveDraftNow();
      renderMode();
      finish();
      toast(`${record.templateName} 입력 양식을 저장하고 현재 파일에 적용했습니다.`, 'success');
    } catch (error) {
      button.disabled = false;
      message.textContent = error.message || '입력 양식을 저장하지 못했습니다.';
    }
  };
  dialog.querySelector('[data-save]').addEventListener('click', () => { void submit(); });
  form.addEventListener('submit', event => { event.preventDefault(); void submit(); });
  dialog.showModal();
  form.elements.templateName.focus();
}

function openInputTemplateEditor(template) {
  if (!template) return;
  const targets = inputMappingTargets();
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog field-mapping-dialog';
  const options = (selected = '') => [
    `<option value="" ${selected === '' ? 'selected' : ''}>연결 대상 없음</option>`,
    `<option value="__UNMAPPED__" ${selected === '__UNMAPPED__' ? 'selected' : ''}>비매핑 · 전표 제외</option>`,
    ...targets.map(target => `<option value="${esc(target.id)}" ${selected === target.id ? 'selected' : ''}>${esc(target.label)} · ${target.scope === 'header' ? '상단' : '작업테이블'}</option>`)
  ].join('');
  dialog.innerHTML = `<form method="dialog" class="smart-dialog__shell">
    <header><div><small>Input Template Management</small><h2>입력 양식 수정</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <label class="smart-dialog__search">양식명<input name="templateName" maxlength="80" value="${esc(template.templateName)}"></label>
    <div class="template-manager-list">${template.headers.map((header, columnIndex) => {
      const mapping = template.mappings.find(item => Number(item.columnIndex) === columnIndex);
      const selected = mapping?.state === MAPPING_DECISION.UNMAPPED ? '__UNMAPPED__' : (mapping?.targetFieldId || '');
      const missing = selected && selected !== '__UNMAPPED__' && !targets.some(target => target.id === selected);
      return `<label class="template-manager-row"><div><strong>${columnIndex + 1}열 · ${esc(header || '(빈 필드명)')}</strong><small>${missing ? `삭제된 연결 대상: ${esc(selected)}` : '열 위치는 변경할 수 없습니다.'}</small></div><select data-template-column="${columnIndex}">${missing ? `<option value="${esc(selected)}" selected>연결 대상 없음 · ${esc(selected)}</option>` : ''}${options(selected)}</select></label>`;
    }).join('')}</div>
    <p class="smart-dialog__message">기존 양식의 변경은 다음 파일부터 적용됩니다. 현재 파일은 양식 다시 불러오기를 실행하기 전까지 유지됩니다.</p>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-save>변경 저장</button></footer>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const message = dialog.querySelector('.smart-dialog__message');
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  const submit = async () => {
    const name = form.elements.templateName.value.trim();
    if (!name) {
      message.textContent = '양식명을 입력하세요.';
      return;
    }
    if (state.inputTemplates.some(record => record.templateId !== template.templateId && String(record.templateName || '').trim() === name)) {
      message.textContent = '같은 이름의 입력 양식이 있습니다. 다른 이름을 사용하세요.';
      return;
    }
    const mappings = [...form.querySelectorAll('[data-template-column]')].map(select => ({
      columnIndex: Number(select.dataset.templateColumn),
      sourceHeader: template.headers[Number(select.dataset.templateColumn)] || '',
      state: select.value === '__UNMAPPED__' ? MAPPING_DECISION.UNMAPPED : (select.value ? MAPPING_DECISION.MAPPED : MAPPING_DECISION.UNDECIDED),
      targetFieldId: select.value && select.value !== '__UNMAPPED__' ? select.value : '',
      reviewed: true
    }));
    try {
      const updated = createTemplateRecord({ companyId: state.companyId, voucherMode: state.draft.activeMode, signature: template.signature, headers: template.headers, mappings }, name, targets, template);
      const next = state.inputTemplates.map(record => record.templateId === template.templateId ? updated : record);
      await saveInputTemplates(next, { companyId: state.companyId, voucherMode: state.draft.activeMode });
      state.inputTemplates = next;
      state.inputTemplatesStatus = next.length ? 'READY' : 'EMPTY';
      finish();
      toast('입력 양식을 변경했습니다. 다음 파일부터 적용됩니다.', 'success');
    } catch (error) {
      message.textContent = error.message === 'TEMPLATE_MAPPING_INCOMPLETE'
        ? '모든 열을 매핑 또는 비매핑으로 결정하고 중복 연결을 제거하세요.'
        : (error.message || '입력 양식을 변경하지 못했습니다.');
    }
  };
  dialog.querySelector('[data-save]').addEventListener('click', () => { void submit(); });
  form.addEventListener('submit', event => { event.preventDefault(); void submit(); });
  dialog.showModal();
}

function openInputTemplateManager() {
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog field-mapping-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Input Template Management</small><h2>입력 양식 관리</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="template-manager-list" data-template-list></div>
    <p class="smart-dialog__message" data-template-message></p>
    <footer><button type="button" class="button button--quiet" data-reload>목록 다시 불러오기</button><button type="button" class="button button--primary" data-close>닫기</button></footer>
  </div>`;
  document.body.append(dialog);
  const list = dialog.querySelector('[data-template-list]');
  const message = dialog.querySelector('[data-template-message]');
  const finish = () => { dialog.close(); dialog.remove(); };
  const render = () => {
    if (state.inputTemplatesStatus === 'LOADING') {
      list.innerHTML = '<div class="smart-dialog__empty">입력 양식을 불러오는 중입니다.</div>';
      return;
    }
    if (state.inputTemplatesStatus === 'ERROR') {
      list.innerHTML = '<div class="smart-dialog__empty">입력 양식을 불러오지 못했습니다.</div>';
      message.textContent = state.inputTemplatesError?.message || '조회 오류';
      return;
    }
    list.innerHTML = state.inputTemplates.length ? state.inputTemplates.map(template => `<article class="template-manager-row" data-template-id="${esc(template.templateId)}"><div><strong>${esc(template.templateName)}</strong><small>${template.fieldCount || template.headers?.length || 0}열 · revision ${Number(template.revision || 1)} · ${esc(template.updatedAt || '')}</small></div><span><button type="button" class="button button--quiet button--small" data-edit-template>수정</button><button type="button" class="button button--danger button--small" data-delete-template>삭제</button></span></article>`).join('') : '<div class="smart-dialog__empty">저장된 입력 양식이 없습니다.</div>';
    message.textContent = state.inputTemplates.length ? '기존 양식의 변경은 다음 파일부터 적용됩니다.' : '신규 파일의 매핑을 확인하고 입력 양식으로 저장하세요.';
  };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.querySelector('[data-reload]').addEventListener('click', async () => {
    await reloadInputTemplates({ announce: false });
    render();
  });
  list.addEventListener('click', event => {
    const row = event.target.closest('[data-template-id]');
    const template = state.inputTemplates.find(record => record.templateId === row?.dataset.templateId);
    if (!template) return;
    if (event.target.closest('[data-edit-template]')) {
      finish();
      openInputTemplateEditor(template);
      return;
    }
    if (event.target.closest('[data-delete-template]')) {
      const confirmed = window.confirm(`${template.templateName} 입력 양식을 삭제하시겠습니까? 현재 작업과 과거 전표는 변경되지 않습니다.`);
      if (!confirmed) return;
      const next = state.inputTemplates.filter(record => record.templateId !== template.templateId);
      saveInputTemplates(next, { companyId: state.companyId, voucherMode: state.draft.activeMode }).then(() => {
        state.inputTemplates = next;
        state.inputTemplatesStatus = next.length ? 'READY' : 'EMPTY';
        render();
        toast('입력 양식을 삭제했습니다.', 'success');
      }).catch(error => { message.textContent = error.message || '입력 양식을 삭제하지 못했습니다.'; });
    }
  });
  render();
  dialog.showModal();
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
      <details class="settings-group">
        <summary><span><strong>입력 양식 관리</strong><small>Excel 필드명·열 순서·매핑 revision</small></span><i aria-hidden="true"></i></summary>
        <div class="settings-group__body settings-group__body--single"><div class="settings-group__actions"><span>기존 양식의 이름과 열별 연결은 여기에서만 수정합니다.</span><button type="button" class="button button--quiet button--small" data-open-input-template-manager>입력 양식 관리</button></div></div>
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
  dialog.querySelector('[data-open-input-template-manager]').addEventListener('click', () => {
    dialog.close();
    dialog.remove();
    openInputTemplateManager();
  });
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
      await persistFieldRegistryLayout(next);
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

function estimateSaveImpact(record) {
  if (!record) return 0;
  return record.estimateKind === 'LINKED_GROUP'
    ? (record.linkedEstimateSources?.length || 0)
    : individualEstimateLinkCount(record.estimateId);
}

function estimateRecordsForKind(kind = state.estimateLibraryKind) {
  return kind === 'linked' ? linkedEstimateRecords() : individualEstimateRecords();
}

function estimateCreation() {
  const value = state.draft.ui.estimateCreation;
  if (!value || !['MULTI_SELECT', 'COMPOSITION_PREVIEW', 'NAMING', 'SAVE_ERROR'].includes(value.status)) return null;
  value.kind = value.kind === 'LINKED_GROUP' ? 'LINKED_GROUP' : 'INDIVIDUAL';
  value.selectedIds = [...new Set((value.selectedIds || []).filter(Boolean))];
  return value;
}

function estimateCreationActive() {
  return Boolean(estimateCreation());
}

function estimateMultiSelectActive() {
  return Boolean(estimateCreationActive() || state.estimateMultiSelectKind);
}

function syncEstimateCreationSelection() {
  const creation = estimateCreation();
  if (!creation) return;
  const availableIds = new Set(individualEstimateRecords().map(record => record.estimateId));
  creation.selectedIds = creation.selectedIds.filter(estimateId => availableIds.has(estimateId));
  state.noticeEstimateIds = [...creation.selectedIds];
}

function setEstimateCreation(patch = null) {
  if (!patch) {
    delete state.draft.ui.estimateCreation;
    return;
  }
  state.draft.ui.estimateCreation = {
    status: 'MULTI_SELECT',
    kind: 'INDIVIDUAL',
    selectedIds: [],
    startedAt: new Date().toISOString(),
    lastAffectedCount: 0,
    ...patch
  };
  syncEstimateCreationSelection();
}

function beginEstimateMultiSelect({ deferPreview = false } = {}) {
  if (estimateMultiSelectActive()) return;
  const initialSelectedIds = state.noticeEstimateIds.filter(estimateId => (
    estimateRecordsForKind().some(record => record.estimateId === estimateId)
  ));
  state.estimateMultiSelectKind = state.estimateLibraryKind;
  if (state.estimateLibraryKind === 'individual') {
    startEstimateCreation('LINKED_GROUP', { deferPreview, initialSelectedIds });
    return;
  }
  state.noticeEstimateIds = [...initialSelectedIds];
  if (!deferPreview) {
    renderCatalogControls();
    renderDelivery();
    setAppStatus('연동견적서를 여러 개 선택할 수 있습니다.');
  }
}

function cancelEstimateMultiSelect({ silent = true } = {}) {
  if (estimateCreationActive()) cancelEstimateCreation({ silent });
  else {
    state.noticeEstimateIds = [];
    state.estimateMultiSelectKind = '';
    renderCatalogControls();
    renderDelivery();
  }
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

const VOUCHER_ACTIVITY_COPY = Object.freeze({
  estimate: Object.freeze({ label: '견적서' }),
  order: Object.freeze({ label: '주문서' }),
  purchase: Object.freeze({ label: '구매전표' }),
  sale: Object.freeze({ label: '판매전표' })
});

function voucherActivityDate(mode = state.draft.activeMode, header = modeDraft().header || {}) {
  const value = mode === 'order'
    ? (header.orderDate || header.voucherDate || header.deliveryDate)
    : (header.voucherDate || header.deliveryDate);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? value : new Date().toLocaleDateString('sv-SE');
}

function voucherActivityTitle(mode, date) {
  const label = VOUCHER_ACTIVITY_COPY[mode]?.label || '전표';
  const today = new Date().toLocaleDateString('sv-SE');
  if (date === today) return `오늘 ${label}`;
  const parsed = new Date(`${date}T00:00:00`);
  const display = Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
  return `${display} ${label}`;
}

function voucherActivityTime(value) {
  const parsed = new Date(value || '');
  return Number.isNaN(parsed.getTime()) ? '시간 미상' : parsed.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function voucherActivityCard(row) {
  const content = `
    <time>${esc(voucherActivityTime(row.savedAt))}</time>
    <span class="voucher-context-item__copy"><strong>${esc(row.customerName)}</strong><small>${Number(row.itemCount || 0).toLocaleString('ko-KR')}품목 · ${Number(row.totalAmount || 0).toLocaleString('ko-KR')}원</small></span>
    <em class="voucher-context-item__state">${esc(row.status || '저장')}</em><span class="voucher-context-item__arrow" aria-hidden="true">›</span>`;
  const source = row.detailHref
    ? `<a href="${esc(row.detailHref)}" target="_blank" rel="noopener" aria-label="${esc(row.customerName)} 전표 상세 열기">${content}</a>`
    : `<div class="voucher-activity-item__content">${content}</div>`;
  return `<article class="voucher-context-item voucher-activity-item" data-voucher-activity-id="${esc(row.id)}">${source}
    <button type="button" class="button button--quiet button--small" data-import-related-voucher="${esc(row.id)}">불러오기</button></article>`;
}

function readEstimateVoucherActivity(date) {
  const rows = individualEstimateRecords().map(record => {
    const draft = record.draft || {};
    const header = draft.header || {};
    const items = estimateRecordRows(record);
    const summary = contract.summarizeRows(items);
    return {
      id: record.estimateId,
      companyId: state.companyId,
      voucherMode: 'estimate',
      voucherNo: estimateTitle(record),
      date: String(record.updatedAt || record.createdAt || '').slice(0, 10),
      savedAt: record.updatedAt || record.createdAt || '',
      customerId: header.customerId || '',
      customerCode: header.customerCode || '',
      customerName: header.customerName || '거래처 미지정',
      warehouseId: header.warehouseId || '',
      warehouseCode: header.warehouseCode || '',
      warehouseName: header.warehouseName || '',
      itemCount: items.length,
      totalAmount: summary.amount,
      status: '저장',
      items: items.map((line, index) => ({
        lineId: line.rowId || `${record.estimateId}:${index + 1}`,
        productId: line.productId || line.masterProductId || '',
        masterProductId: line.masterProductId || line.productId || '',
        code: line.itemCode || '',
        name: line.itemName || '',
        specification: line.specification || '',
        quantity: line.quantity ?? '',
        quantityDisplay: String(line.fieldValues?.['voucher.estimate.line.quantity']?.currentDisplayValue ?? line.quantity ?? ''),
        unit: line.unit || '',
        unitPrice: line.unitPrice ?? '',
        unitPriceDisplay: String(line.fieldValues?.['voucher.estimate.line.unitPrice']?.currentDisplayValue ?? line.sourceUnitPrice ?? line.unitPrice ?? ''),
        memo: line.memo || ''
      })),
      detailHref: ''
    };
  }).sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt)));
  return {
    schema: 'ONEAPP_VOUCHER_ACTIVITY_SNAPSHOT_V1',
    adapter: 'ONEAPP_SMARTINPUT_ESTIMATE_READ_ADAPTER_V1',
    status: rows.length ? 'READY' : 'EMPTY',
    mode: 'estimate', date, count: rows.length, rows,
    checkedAt: new Date().toISOString(), source: 'SmartInput 견적서 Read Adapter'
  };
}

function renderVoucherActivitySnapshot() {
  const activity = state.voucherActivity;
  const mode = activity.sourceMode || state.draft.activeMode;
  const date = voucherActivityDate(state.draft.activeMode);
  $('voucherActivitySourceMode').value = mode;
  $('voucherContextEyebrow').textContent = 'VOUCHER ACTIVITY';
  $('voucherContextTitle').textContent = mode === 'estimate' ? '저장 견적서' : voucherActivityTitle(mode, date);
  $('voucherActivityOpenAll').dataset.href = `../orderq/voucher-query.html?mode=${encodeURIComponent(mode)}&date=${encodeURIComponent(date)}`;
  $('voucherActivityOpenAll').hidden = mode === 'estimate';
  if (activity.status === 'LOADING') {
    $('voucherContextSummary').textContent = `${date} 전표를 불러오는 중입니다.`;
    $('voucherContextList').innerHTML = '<div class="voucher-activity-state"><strong>불러오는 중</strong><span>현재 입력 작업은 계속할 수 있습니다.</span></div>';
    $('voucherContextDelivery').textContent = '조회 중';
    return;
  }
  if (activity.status === 'ERROR') {
    $('voucherContextSummary').textContent = '전표 조회에 실패했습니다. 0건으로 처리하지 않았습니다.';
    $('voucherContextList').innerHTML = `<div class="voucher-activity-state is-error"><strong>목록을 불러오지 못했습니다.</strong><span>${esc(activity.error?.message || '다시 불러오기를 실행하세요.')}</span></div>`;
    $('voucherContextDelivery').textContent = 'ERROR · 로컬 입력은 사용 가능';
    return;
  }
  if (activity.status === 'EMPTY') {
    $('voucherContextSummary').textContent = `${date} 전표 0건`;
    $('voucherContextList').innerHTML = '<div class="voucher-activity-state"><strong>저장된 전표가 없습니다.</strong><span>조회는 정상 완료되었습니다.</span></div>';
    $('voucherContextDelivery').textContent = 'EMPTY · 조회 정상';
    return;
  }
  $('voucherContextSummary').textContent = `${date} · ${activity.rows.length.toLocaleString('ko-KR')}건`;
  $('voucherContextList').innerHTML = activity.rows.map(voucherActivityCard).join('');
  $('voucherContextDelivery').textContent = `READY · ${activity.source || '공식 Read Adapter'}`;
}

async function loadVoucherActivity({ force = false } = {}) {
  const mode = state.voucherActivity.sourceMode || state.draft.activeMode;
  const date = voucherActivityDate(state.draft.activeMode);
  if (!force && state.voucherActivity.mode === mode && state.voucherActivity.date === date && ['LOADING', 'READY', 'EMPTY', 'ERROR'].includes(state.voucherActivity.status)) {
    return renderVoucherActivitySnapshot();
  }
  const requestId = ++state.voucherActivity.requestId;
  state.voucherActivity = { ...state.voucherActivity, requestId, status: 'LOADING', mode, sourceMode: mode, date, rows: [], error: null };
  renderVoucherActivitySnapshot();
  const snapshot = mode === 'estimate'
    ? readEstimateVoucherActivity(date)
    : await readVoucherActivity({ mode, date, companyId: state.companyId });
  if (requestId !== state.voucherActivity.requestId || mode !== state.voucherActivity.sourceMode || date !== voucherActivityDate(state.draft.activeMode)) return;
  state.voucherActivity = { ...state.voucherActivity, ...snapshot, requestId };
  renderVoucherActivitySnapshot();
}

function renderVoucherContext() {
  renderVoucherActivitySnapshot();
  void loadVoucherActivity();
}

function relatedPanelButtonLabel(open = false) {
  const label = state.draft.activeMode === 'estimate'
    ? '견적서 목록'
    : `${VOUCHER_ACTIVITY_COPY[state.draft.activeMode]?.label || '전표'} 목록`;
  return `${label} ${open ? '닫기' : '열기'}`;
}

function applyRelatedPanelWidth(requestedWidth = state.draft.ui.relatedPaneWidth || 260) {
  const maximum = Math.max(260, Math.min(440, Math.round(window.innerWidth * .36)));
  const width = Math.round(Math.max(230, Math.min(maximum, Number(requestedWidth) || 260)));
  state.draft.ui.relatedPaneWidth = width;
  $('smartInputWorkspace').style.setProperty('--related-pane-width', `${width}px`);
  return width;
}

function applyRelatedPanelState() {
  const open = Boolean(state.draft.ui.relatedOpen);
  const workspace = $('smartInputWorkspace');
  const panel = $('estimateLibraryView');
  const appBarBottom = Math.max(0, Math.round(document.querySelector('.app-bar')?.getBoundingClientRect().bottom || 0));
  workspace.style.setProperty('--related-panel-top', `${appBarBottom}px`);
  applyRelatedPanelWidth();
  workspace.classList.toggle('related-panel-open', open);
  panel.classList.toggle('is-open', open);
  panel.setAttribute('aria-hidden', String(!open));
  $('relatedPanelToggle').setAttribute('aria-expanded', String(open));
  $('relatedPanelToggle').title = relatedPanelButtonLabel(open);
  $('relatedPanelToggleLabel').textContent = state.draft.activeMode === 'estimate' ? '견적서 목록' : '전표 목록';
  $('relatedCollapseButton').setAttribute('aria-expanded', String(open));
  $('relatedCollapseButton').textContent = relatedPanelButtonLabel(open);
}

function setRelatedPanelOpen(open) {
  state.draft.ui.relatedOpen = Boolean(open);
  applyRelatedPanelState();
  scheduleSave();
}

function renderEstimateWorkspace() {
  const estimateMode = state.draft.activeMode === 'estimate';
  const library = $('estimateLibraryView');
  library.hidden = false;
  library.setAttribute('aria-label', estimateMode ? '견적서 목록' : `${contract.MODES[state.draft.activeMode].label} 목록`);
  $('voucherContextView').hidden = estimateMode;
  $('estimateLibraryHeading').hidden = !estimateMode;
  $('catalogComposeArea').hidden = !estimateMode;
  $('estimateEditorView').hidden = false;
  const linkedList = state.estimateLibraryKind === 'linked';
  $('catalogPickerList').hidden = !estimateMode || linkedList;
  $('linkedEstimateList').hidden = !estimateMode || !linkedList;
  const multiSelect = estimateMultiSelectActive();
  const individualButton = $('estimateLibraryIndividualButton');
  const linkedButton = $('estimateLibraryLinkedButton');
  const multiSelectButton = $('estimateMultiSelectButton');
  individualButton.classList.toggle('is-active', !linkedList);
  linkedButton.classList.toggle('is-active', linkedList);
  individualButton.setAttribute('aria-pressed', String(!linkedList));
  linkedButton.setAttribute('aria-pressed', String(linkedList));
  individualButton.disabled = state.busy || multiSelect;
  linkedButton.disabled = state.busy || multiSelect;
  multiSelectButton.disabled = state.busy;
  multiSelectButton.classList.toggle('is-active', multiSelect);
  multiSelectButton.setAttribute('aria-pressed', String(multiSelect));
  multiSelectButton.setAttribute('aria-label', multiSelect ? '견적서 다중 선택 종료' : '견적서 다중 선택');
  multiSelectButton.title = multiSelect ? '다중 선택 종료' : '다중 선택';
  $('estimateLibrarySummary').textContent = linkedList
    ? '연결된 원본을 유지하는 연동견적서입니다. 카드는 열기, 이동 핸들은 순서 변경입니다.'
    : (multiSelect ? '카드를 하나씩 터치하거나 Ctrl+클릭해 여러 견적서를 선택합니다.' : '카드를 터치하면 해당 견적서 하나를 바로 엽니다.');
  parserCard.hidden = false;
}

function estimateCardMarkup(record) {
  const selected = state.noticeEstimateIds.includes(record.estimateId);
  const selectionOrder = estimateMultiSelectActive() ? state.noticeEstimateIds.indexOf(record.estimateId) : -1;
  const linked = record.estimateKind === 'LINKED_GROUP';
  const linkedCount = linked ? (record.linkedEstimateSources?.length || 0) : individualEstimateLinkCount(record.estimateId);
  const linkedBadge = linkedCount ? `<em class="linked-estimate-badge">연동 ${linkedCount}</em>` : '';
  return `<article class="catalog-picker__row estimate-card ${selected ? 'is-selected' : ''}" data-estimate-kind="${linked ? 'LINKED_GROUP' : 'INDIVIDUAL'}" data-estimate-id="${esc(record.estimateId)}">
    <button class="catalog-picker__load" type="button" data-select-estimate-card aria-pressed="${selected}" title="${esc(estimateTitle(record))} · ${estimateMultiSelectActive() ? (selected ? '다중 선택 해제' : '다중 선택') : '견적서 열기'}">${selectionOrder >= 0 ? `<b class="estimate-card__selection-order" aria-label="${selectionOrder + 1}번째 선택">${selectionOrder + 1}</b>` : ''}<strong>${esc(estimateTitle(record))}${linkedBadge}</strong><small>작성 ${esc(formatEstimateDate(record.createdAt))} · 수정 ${esc(formatEstimateDate(record.updatedAt))}</small></button>
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
  syncEstimateCreationSelection();
  const creation = estimateCreation();
  if (creation && !state.estimateMultiSelectKind) state.estimateMultiSelectKind = 'individual';
  const records = individualEstimateRecords();
  const linkedRecords = linkedEstimateRecords();
  const availableIds = new Set((creation ? records : estimateRecordsForKind()).map(record => record.estimateId));
  state.noticeEstimateIds = state.noticeEstimateIds.filter(estimateId => availableIds.has(estimateId));
  const selectedCount = state.noticeEstimateIds.length;
  $('catalogPickerList').innerHTML = records.length ? records.map(estimateCardMarkup).join('') : '<div class="smart-dialog__empty">저장된 견적서가 없습니다. 입력표를 작성하고 저장하면 자동 생성됩니다.</div>';
  $('linkedEstimateList').innerHTML = linkedRecords.length ? linkedRecords.map(estimateCardMarkup).join('') : '<div class="smart-dialog__empty">생성된 연동견적서가 없습니다.</div>';
  const currentRecord = state.estimates.find(record => record.estimateId === modeDraft().catalogRecordId);
  const impactCount = estimateSaveImpact(currentRecord);
  const lastSave = state.lastEstimateSave?.estimateId === currentRecord?.estimateId ? state.lastEstimateSave : null;
  $('estimateSelectionSummary').textContent = creation
    ? `다중 선택 · ${selectedCount.toLocaleString('ko-KR')}개 선택${modeDraft().estimateKind === 'COMPOSITION_PREVIEW' ? ` · 미리보기 ${modeDraft().rows.filter(rowHasMeaningfulInput).length}품목` : ''}`
    : (selectedCount
      ? `${selectedCount.toLocaleString('ko-KR')}개 열림${lastSave ? ` · 저장 완료 · 연결 ${lastSave.linkCount}개${lastSave.affectedCount ? ` · 반영 ${lastSave.affectedCount}건` : ''}` : (impactCount ? ` · 저장하면 연결된 ${impactCount}개 견적서에 반영` : '')}`
      : '견적서를 선택하세요.');
  const deleteButton = $('selectedEstimateDeleteButton');
  deleteButton.disabled = state.busy || selectedCount < 1;
  deleteButton.textContent = '선택 삭제';
  deleteButton.classList.add('button--danger');
  deleteButton.classList.remove('button--quiet');
  $('estimateRenameButton').disabled = state.busy || selectedCount !== 1;
  const createButton = $('estimateCreateButton');
  createButton.disabled = state.busy || !creation || selectedCount < 2;
  createButton.textContent = '연동견적서 생성';
  createButton.title = creation ? `${selectedCount}개 선택` : '먼저 + 버튼이나 Ctrl+클릭으로 견적서를 다중 선택하세요.';
  $('estimateNoticeButton').textContent = '카톡 공유';
  $('estimateExcelButton').textContent = 'EXCEL';
  renderEstimateWorkspace();
}

function previewEstimateCreation() {
  const creation = estimateCreation();
  if (!creation) return;
  const selectedIds = new Set(creation.selectedIds);
  const records = individualEstimateRecords().filter(record => selectedIds.has(record.estimateId));
  const fallback = contract.createDraft().modes.estimate;
  fallback.activeMethod = 'direct';
  fallback.rows = creation.kind === 'LINKED_GROUP' ? materializeLinkedEstimateRows(records) : combinedEstimateRows(records);
  fallback.catalogRecordId = '';
  fallback.catalogBaselinePrices = {};
  fallback.catalogPreviousPrices = {};
  fallback.estimateKind = 'COMPOSITION_PREVIEW';
  fallback.linkedEstimateSources = records.map(record => ({
    estimateId: record.estimateId,
    catalogName: estimateTitle(record),
    updatedAt: record.updatedAt || ''
  }));
  if (records.length === 1 && creation.kind === 'INDIVIDUAL') {
    fallback.header = { ...fallback.header, ...(estimateRecordDraft(records[0])?.header || {}), submittedAt: '' };
  } else {
    clearCustomerAfterSave(fallback.header);
  }
  state.draft.modes.estimate = fallback;
  state.selectedRowIds.clear();
  creation.status = records.length ? 'COMPOSITION_PREVIEW' : 'MULTI_SELECT';
  saveDraftNow();
  renderMode();
}

function startEstimateCreation(kind, { deferPreview = false, initialSelectedIds = [] } = {}) {
  rememberActiveEstimateWork();
  state.lastEstimateSave = null;
  const returnDraft = JSON.parse(JSON.stringify(modeDraft()));
  state.estimateSelectionReturnDraft = returnDraft;
  state.estimateLibraryKind = 'individual';
  state.estimateMultiSelectKind = 'individual';
  state.noticeEstimateIds = [...new Set(initialSelectedIds)];
  setEstimateCreation({ kind, returnDraft, selectedIds: [...state.noticeEstimateIds] });
  if (!deferPreview) previewEstimateCreation();
  setAppStatus('견적서를 여러 개 선택한 뒤 연동견적서를 생성할 수 있습니다.');
}

function cancelEstimateCreation({ silent = false } = {}) {
  const creation = estimateCreation();
  if (!creation) return false;
  const returnDraft = creation.returnDraft || state.estimateSelectionReturnDraft;
  if (returnDraft) state.draft.modes.estimate = contract.normalizeModeDraft('estimate', returnDraft);
  const returnEstimateId = returnDraft?.catalogRecordId;
  state.noticeEstimateIds = returnEstimateId && individualEstimateRecords().some(record => record.estimateId === returnEstimateId)
    ? [returnEstimateId]
    : [];
  state.estimateSelectionReturnDraft = null;
  state.estimateMultiSelectKind = '';
  setEstimateCreation(null);
  state.selectedRowIds.clear();
  saveDraftNow();
  renderMode();
  if (!silent) toast('견적서 생성 선택을 취소했습니다.', 'success');
  return true;
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
  if (records.length > 1 && !window.confirm(`선택한 견적서 ${records.length}개를 삭제하시겠습니까? 삭제 후에는 자동 복구되지 않습니다.`)) return;
  const deletedIds = new Set(records.map(record => record.estimateId));
  const remaining = normalizeEstimateOrder(state.estimates.filter(record => !deletedIds.has(record.estimateId)));
  try {
    await commitEstimateBundle({ upserts: remaining, deletes: [...deletedIds] });
  } catch (error) {
    return toast(error.message || '견적서를 삭제하지 못했습니다. 기존 목록은 유지됩니다.', 'error');
  }
  state.estimates = remaining;
  state.noticeEstimateIds = [];
  deletedIds.forEach(estimateId => state.estimateWorkingCopies.delete(estimateId));
  if (estimateCreationActive()) previewEstimateCreation();
  else if (deletedIds.has(modeDraft().catalogRecordId)) startNewCatalog();
  else renderCatalogControls();
  toast(`견적서 ${deletedIds.size}개를 삭제했습니다.`, 'success');
}

function renameEstimateSourceMetadata(draft, estimateId, catalogName) {
  if (!draft) return draft;
  draft.linkedEstimateSources = (draft.linkedEstimateSources || []).map(source => (
    source.estimateId === estimateId ? { ...source, catalogName } : source
  ));
  (draft.rows || []).forEach(row => {
    const refs = (row.linkedSourceRefs || []).map(ref => (
      ref.estimateId === estimateId ? { ...ref, estimateName: catalogName } : ref
    ));
    if (refs.length) row.linkedSourceRefs = refs;
    const sourceCount = new Set(refs.map(ref => ref.estimateId).filter(Boolean)).size;
    if (row.linkedSourceEstimateId === estimateId && sourceCount <= 1) row.linkedSourceEstimateName = catalogName;
  });
  return draft;
}

function renamedEstimateBundle(record, catalogName, timestamp) {
  const target = JSON.parse(JSON.stringify(record));
  target.catalogName = catalogName;
  target.updatedAt = timestamp;
  const changed = new Map([[target.estimateId, target]]);
  if (target.estimateKind !== 'LINKED_GROUP') {
    linkedEstimateRecords().forEach(linkedRecord => {
      if (!(linkedRecord.linkedEstimateSources || []).some(source => source.estimateId === target.estimateId)) return;
      const linked = JSON.parse(JSON.stringify(linkedRecord));
      renameEstimateSourceMetadata(linked.draft, target.estimateId, catalogName);
      linked.linkedEstimateSources = (linked.linkedEstimateSources || []).map(source => (
        source.estimateId === target.estimateId ? { ...source, catalogName } : source
      ));
      linked.updatedAt = timestamp;
      if (linked.draft) linked.draft.updatedAt = timestamp;
      changed.set(linked.estimateId, linked);
    });
  }
  return [...changed.values()];
}

function openSelectedEstimateRenameDialog() {
  const records = selectedEstimateRecords();
  if (records.length !== 1) return toast('이름을 변경할 견적서 하나를 선택하세요.', 'warn');
  const record = records[0];
  const currentName = estimateTitle(record);
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog estimate-save-dialog estimate-rename-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Estimate Rename</small><h2>견적서 이름 변경</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-dialog__message">견적서 내용과 연결 관계는 유지하고 목록 이름만 변경합니다.</div>
    <div class="estimate-dialog-form"><label><span>견적서명</span><input type="text" data-estimate-rename maxlength="80" value="${esc(currentName)}" autocomplete="off" enterkeyhint="done" autofocus></label></div>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-confirm-rename>변경</button></footer>
  </div>`;
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  const submit = async () => {
    const input = dialog.querySelector('[data-estimate-rename]');
    const catalogName = input.value.trim();
    if (!catalogName) {
      input.focus();
      return;
    }
    if (catalogName === currentName) return close();
    const confirmButton = dialog.querySelector('[data-confirm-rename]');
    confirmButton.disabled = true;
    state.busy = true;
    renderCatalogControls();
    try {
      const timestamp = new Date().toISOString();
      const bundle = renamedEstimateBundle(record, catalogName, timestamp);
      await commitEstimateBundle({ upserts: bundle });
      const bundleById = new Map(bundle.map(item => [item.estimateId, item]));
      state.estimates = normalizeEstimateOrder(state.estimates.map(item => bundleById.get(item.estimateId) || item));
      renameEstimateSourceMetadata(modeDraft(), record.estimateId, catalogName);
      state.estimateWorkingCopies.forEach(draft => renameEstimateSourceMetadata(draft, record.estimateId, catalogName));
      saveDraftNow();
      close();
      if (estimateCreationActive()) previewEstimateCreation();
      else renderMode();
      setAppStatus(`“${catalogName}”으로 이름을 변경했습니다.`);
    } catch (error) {
      confirmButton.disabled = false;
      toast(error.message || '견적서 이름을 변경하지 못했습니다. 기존 이름은 유지됩니다.', 'error');
    } finally {
      state.busy = false;
      renderCatalogControls();
      renderDelivery();
    }
  };
  dialog.querySelector('[data-confirm-rename]').addEventListener('click', () => { void submit(); });
  dialog.querySelector('[data-estimate-rename]').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    void submit();
  });
  dialog.showModal();
  const input = dialog.querySelector('[data-estimate-rename]');
  const focusInput = () => { input.focus({ preventScroll: true }); input.select(); };
  focusInput();
  window.setTimeout(focusInput, 0);
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
  state.estimateMultiSelectKind = '';
  setEstimateCreation(null);
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
  $('deliveryDateInput').value = state.draft.activeMode === 'order'
    ? (header.orderDate || header.voucherDate || header.deliveryDate)
    : (state.draft.activeMode === 'estimate' ? header.deliveryDate : (header.voucherDate || header.deliveryDate));
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
    header: cloneGridValue(current.header),
    sourceText: current.sourceText,
    activeMethod: current.activeMethod,
    inputMapping: current.inputMapping ? cloneGridValue(current.inputMapping) : null,
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
  if (snapshot.header) current.header = cloneGridValue(snapshot.header);
  if (Object.prototype.hasOwnProperty.call(snapshot, 'sourceText')) current.sourceText = snapshot.sourceText;
  if (snapshot.activeMethod) current.activeMethod = snapshot.activeMethod;
  if (snapshot.inputMapping) current.inputMapping = cloneGridValue(snapshot.inputMapping);
  else delete current.inputMapping;
  state.selectedRowIds = new Set(snapshot.selectedRowIds);
  modeUi().activeCellId = snapshot.activeCellId;
  state.gridPasteUndo = null;
  renderMode();
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
  $('bulkUnitPriceInput').disabled = Boolean(inputMappingSession());
  $('applyBulkUnitPriceButton').disabled = !selectedCount || Boolean(inputMappingSession());
}

function applySelectedRowsUnitPrice() {
  if (inputMappingSession()) return toast('입력 양식을 저장한 뒤 전표 행에서 단가를 적용하세요.', 'error');
  if (!state.selectedRowIds.size) return toast('단가를 적용할 행을 선택하세요.', 'error');
  try {
    invalidateGridPasteUndo();
    const result = applyBulkUnitPrice(modeDraft().rows, [...state.selectedRowIds], $('bulkUnitPriceInput').value, {
      targetFieldId: mappingTargetByProjection('unitPrice')?.id || '',
      actor: resolveSmartInputActor()
    });
    modeDraft().rows = result.rows.map(row => contract.normalizeRow(row));
    renderRows({ restoreFocus: false });
    saveDraftNow();
    toast(`선택한 ${result.affectedCount.toLocaleString('ko-KR')}행에 단가를 적용했습니다.`, 'success');
  } catch (error) {
    toast(error.message === 'SMARTINPUT_BULK_PRICE_REQUIRED' ? '적용할 단가를 입력하세요.' : '단가는 숫자로 입력하세요.', 'error');
  }
}

async function deleteSelectedGridRows() {
  if (inputMappingSession()) {
    deleteSelectedMappingRows();
    return;
  }
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

function visibleMappingRows(session = inputMappingSession()) {
  if (!session) return [];
  const terms = String(state.gridSearch || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...(session.workingRows || [])];
  return (session.workingRows || []).filter(row => {
    const haystack = (row.cells || []).map(value => String(value ?? '').toLowerCase()).join('|');
    return terms.every(term => haystack.includes(term));
  });
}

function renderInputMappingStatus() {
  const session = inputMappingSession();
  const panel = $('inputMappingStatus');
  const saveButton = $('inputTemplateSaveButton');
  const reloadButton = $('inputTemplateReloadButton');
  const pendingPasteButton = $('pendingPasteToSourceButton');
  pendingPasteButton.hidden = !state.pendingGridPasteText;
  if (!session) {
    panel.hidden = true;
    saveButton.hidden = true;
    reloadButton.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.dataset.status = session.status;
  panel.dataset.templateStoreStatus = state.inputTemplatesStatus;
  const summary = mappingSummary(session);
  const title = session.status === MAPPING_SESSION_STATUS.TEMPLATE_APPLIED
    ? (session.templateName || '입력 양식 적용')
    : (session.status === MAPPING_SESSION_STATUS.NEW_TEMPLATE
      ? '신규 양식 설정'
      : (session.status === MAPPING_SESSION_STATUS.INVALID_TEMPLATE
        ? '양식 연결 오류'
        : (session.status === MAPPING_SESSION_STATUS.TEMPLATE_LOOKUP_ERROR ? '양식 조회 오류' : '양식 중복 오류')));
  $('inputMappingStatusTitle').textContent = title;
  $('inputMappingStatusSummary').textContent = state.inputTemplatesStatus === 'ERROR'
    ? '양식 조회 오류'
    : `매핑 ${summary.mapped} · 추천 ${summary.recommended} · 비매핑 ${summary.unmapped} · 미결정 ${summary.undecided}`;
  saveButton.hidden = session.status !== MAPPING_SESSION_STATUS.NEW_TEMPLATE;
  reloadButton.hidden = ![MAPPING_SESSION_STATUS.TEMPLATE_APPLIED, MAPPING_SESSION_STATUS.INVALID_TEMPLATE, MAPPING_SESSION_STATUS.TEMPLATE_CONFLICT, MAPPING_SESSION_STATUS.TEMPLATE_LOOKUP_ERROR].includes(session.status);
  reloadButton.textContent = session.status === MAPPING_SESSION_STATUS.TEMPLATE_APPLIED ? '최신 양식 확인' : '양식 다시 불러오기';
}

function mappingColumnTotals(session, visibleColumns) {
  const totals = new Map();
  visibleColumns.forEach(columnIndex => {
    const mapping = session.mappings[columnIndex];
    const target = mappingTargetById(mapping?.targetFieldId);
    if (!target || target.valueType !== 'NUMBER' || ![MAPPING_DECISION.MAPPED, MAPPING_DECISION.RECOMMENDED].includes(mapping.state)) return;
    const values = (session.workingRows || []).map(row => String(row.cells?.[columnIndex] ?? '').replace(/[,원₩\s]/g, '')).filter(value => value !== '');
    if (!values.length || values.some(value => !Number.isFinite(Number(value)))) return;
    totals.set(columnIndex, values.reduce((sum, value) => sum + Number(value), 0));
  });
  return totals;
}

function renderMappingRows() {
  const session = inputMappingSession();
  if (!session) return false;
  $('voucherInputTable').hidden = true;
  const table = $('mappingWorktable');
  table.hidden = false;
  const hidden = new Set(session.hiddenColumns || []);
  const visibleColumns = session.headers.map((_, index) => index).filter(index => !hidden.has(index));
  const tableWidth = 58 + visibleColumns.reduce((sum, index) => sum + Math.max(110, Math.min(240, (session.headers[index]?.length || 0) * 11 + 70)), 0);
  table.style.setProperty('--mapping-table-width', `${tableWidth}px`);
  $('mappingTableColumns').innerHTML = `<col style="width:58px">${visibleColumns.map(index => `<col style="width:${Math.max(110, Math.min(240, (session.headers[index]?.length || 0) * 11 + 70))}px">`).join('')}`;
  $('mappingTableHeaders').innerHTML = `<th class="sequence-column sequence-select-column" scope="col"><span>No.</span><input id="mappingSelectAllRows" type="checkbox" aria-label="전체 원본 행 선택"></th>${visibleColumns.map(columnIndex => {
    const mapping = session.mappings[columnIndex];
    const sourceHeader = session.headers[columnIndex] || `(빈 필드명 · ${columnIndex + 1}열)`;
    return `<th class="mapping-column-heading" data-mapping-state="${esc(mapping?.state || MAPPING_DECISION.UNDECIDED)}" data-mapping-column="${columnIndex}"><button class="mapping-header-button" type="button" data-open-field-mapping="${columnIndex}" title="${esc(sourceHeader)} 매핑 설정"><strong>${esc(sourceHeader)}</strong><small>${esc(mappingStateText(mapping))}</small></button></th>`;
  }).join('')}`;
  const rows = visibleMappingRows(session);
  const renderedRows = [...rows, { rowId: MAPPING_DEFAULT_ROW_ID, cells: Array(session.headers.length).fill(''), manual: true, defaultRow: true }];
  $('mappingInputRows').innerHTML = renderedRows.map((row, visibleIndex) => {
    const isDefault = row.rowId === MAPPING_DEFAULT_ROW_ID;
    const sequence = isDefault ? (session.workingRows || []).length + 1 : Math.max(1, (session.workingRows || []).findIndex(item => item.rowId === row.rowId) + 1);
    return `<tr data-mapping-row-id="${esc(row.rowId)}" ${isDefault ? 'data-mapping-default-row="true" class="mapping-blank-row"' : ''}>
      <td class="row-sequence-cell row-sequence-select-cell"><span class="row-sequence-number">${sequence}</span><input type="checkbox" data-mapping-select-row="${isDefault ? '' : esc(row.rowId)}" aria-label="${sequence}번 원본 행 선택" ${isDefault ? 'disabled' : (state.selectedRowIds.has(row.rowId) ? 'checked' : '')}></td>
      ${visibleColumns.map(columnIndex => {
        const mapping = session.mappings[columnIndex];
        const unmapped = mapping?.state === MAPPING_DECISION.UNMAPPED;
        return `<td class="${unmapped ? 'is-unmapped' : ''}" data-mapping-column="${columnIndex}"><input data-mapping-cell data-mapping-column="${columnIndex}" value="${esc(row.cells?.[columnIndex] ?? '')}" aria-label="${esc(session.headers[columnIndex] || `${columnIndex + 1}열`)}"></td>`;
      }).join('')}
    </tr>`;
  }).join('');
  const totals = mappingColumnTotals(session, visibleColumns);
  $('mappingTableTotals').innerHTML = `<td></td>${visibleColumns.map((columnIndex, index) => `<td>${index === 0 ? '<strong>합계</strong>' : (totals.has(columnIndex) ? totals.get(columnIndex).toLocaleString('ko-KR') : '')}</td>`).join('')}`;
  const summary = mappingSummary(session);
  $('gridRowCount').textContent = `${(session.workingRows || []).length.toLocaleString('ko-KR')}행`;
  $('gridSearchCount').hidden = !state.gridSearch;
  $('gridSearchCount').textContent = `검색 ${rows.length.toLocaleString('ko-KR')}행`;
  $('matchedCount').textContent = `매핑 ${summary.mapped + summary.recommended}`;
  $('similarCount').textContent = `추천 ${summary.recommended}`;
  $('failedCount').textContent = `미결정 ${summary.undecided}`;
  $('duplicateCount').textContent = `비매핑 ${summary.unmapped}`;
  $('gridSearchInput').placeholder = '원본 전체 열 검색';
  $('detailColumnsButton').hidden = hidden.size === 0;
  $('detailColumnsButton').textContent = `숨긴 열 ${hidden.size}개 표시`;
  $('deleteSelectedRows').disabled = state.selectedRowIds.size === 0;
  $('bulkUnitPriceInput').disabled = true;
  $('applyBulkUnitPriceButton').disabled = true;
  $('selectAllRows').checked = false;
  applyMappingHeaderLocks(session);
  renderInputMappingStatus();
  renderSourceSurface();
  renderInlineValidation();
  renderVoucherContext(contract.summarizeRows(modeDraft().rows));
  return true;
}

function mappingHasHeaderValue(session, targetFieldId) {
  const mapping = session?.mappings?.find(item => item.targetFieldId === targetFieldId
    && [MAPPING_DECISION.MAPPED, MAPPING_DECISION.RECOMMENDED].includes(item.state));
  return Boolean(mapping && (session.workingRows || []).some(row => hasEnteredValue(row.cells?.[mapping.columnIndex])));
}

function applyMappingHeaderLocks(session = null) {
  const estimateMode = state.draft.activeMode === 'estimate';
  const linkedEstimate = estimateMode && (modeDraft().estimateKind === 'LINKED_GROUP' || estimateCreation()?.kind === 'LINKED_GROUP');
  const controls = [
    { id: 'customerInput', target: 'customer', baseDisabled: linkedEstimate },
    { id: 'deliveryDateInput', target: 'deliveryDate', baseDisabled: false },
    { id: 'warehouseInput', target: 'warehouse', baseDisabled: estimateMode },
    { id: 'transactionTypeInput', target: 'transactionType', baseDisabled: estimateMode }
  ];
  controls.forEach(({ id, target, baseDisabled }) => {
    const control = $(id);
    const mappingLocked = Boolean(session) && mappingHasHeaderValue(session, target);
    control.disabled = baseDisabled || mappingLocked;
    control.dataset.mappingLocked = String(mappingLocked);
    control.title = mappingLocked ? '파일에 값이 있어 상단에서 덮어쓸 수 없습니다. 작업테이블에서 수정하세요.' : '';
  });
  const customerLocked = Boolean(session) && mappingHasHeaderValue(session, 'customer');
  $('customerSearchButton').disabled = state.busy || linkedEstimate || customerLocked;
  $('customerSearchButton').title = customerLocked ? '파일의 거래처 값은 작업테이블에서 수정하세요.' : '';
}

function scheduleMappingProjection({ render = false } = {}) {
  clearTimeout(state.mappingProjectionTimer);
  state.mappingProjectionTimer = window.setTimeout(() => {
    state.mappingProjectionTimer = null;
    projectInputMappingToVoucherRows();
    if (render) renderRows({ restoreFocus: false });
    else {
      updateSummaries();
      renderDelivery();
    }
    scheduleSave();
  }, 90);
}

function materializeMappingDefaultRow(input) {
  const session = inputMappingSession();
  const tr = input?.closest('[data-mapping-default-row="true"]');
  if (!session || !tr || !hasEnteredValue(input.value)) return null;
  const columnIndex = Number(input.dataset.mappingColumn);
  const values = Array(session.headers.length).fill('');
  values[columnIndex] = input.value;
  const next = addManualRow(session, values);
  modeDraft().inputMapping = next;
  const row = next.manualRows.at(-1);
  projectInputMappingToVoucherRows();
  modeUi().activeCellId = `${row.rowId}|mapping:${columnIndex}`;
  renderRows({ restoreFocus: false });
  const nextInput = document.querySelector(`[data-mapping-row-id="${CSS.escape(row.rowId)}"] [data-mapping-column="${columnIndex}"] input`);
  nextInput?.focus({ preventScroll: true });
  nextInput?.setSelectionRange?.(nextInput.value.length, nextInput.value.length);
  scheduleSave();
  return row;
}

function mappingVisibleColumns(session = inputMappingSession()) {
  const hidden = new Set(session?.hiddenColumns || []);
  return (session?.headers || []).map((_, index) => index).filter(index => !hidden.has(index));
}

function mappingCell(rowId, columnIndex) {
  return document.querySelector(`[data-mapping-row-id="${CSS.escape(rowId)}"] [data-mapping-cell][data-mapping-column="${columnIndex}"]`);
}

function moveMappingFocus(rowId, columnIndex, key, shiftKey = false) {
  const session = inputMappingSession();
  if (!session) return;
  const rows = [...(session.workingRows || []).map(row => row.rowId), MAPPING_DEFAULT_ROW_ID];
  const columns = mappingVisibleColumns(session);
  const rowIndex = rows.indexOf(rowId);
  const columnPosition = columns.indexOf(columnIndex);
  if (rowIndex < 0 || columnPosition < 0) return;
  let nextRow = rowIndex;
  let nextColumn = columnPosition;
  if (key === 'ArrowUp') nextRow -= 1;
  else if (key === 'ArrowDown') nextRow += 1;
  else if (key === 'ArrowLeft') nextColumn -= 1;
  else if (key === 'ArrowRight') nextColumn += 1;
  else if (key === 'Enter') {
    nextColumn += 1;
    if (nextColumn >= columns.length) { nextColumn = 0; nextRow += 1; }
  } else if (key === 'Tab') {
    nextColumn += shiftKey ? -1 : 1;
    if (nextColumn >= columns.length) { nextColumn = 0; nextRow += 1; }
    if (nextColumn < 0) { nextColumn = columns.length - 1; nextRow -= 1; }
  }
  if (nextRow < 0 || nextRow >= rows.length || nextColumn < 0 || nextColumn >= columns.length) return;
  const target = mappingCell(rows[nextRow], columns[nextColumn]);
  target?.focus({ preventScroll: true });
  target?.select?.();
}

function mappingHeadersMatch(matrix, headers) {
  const incoming = matrix?.[0] || [];
  return incoming.length === headers.length && headers.every((header, index) => String(incoming[index] ?? '') === String(header ?? ''));
}

function applyMappingGridPaste(rawText, startRowId) {
  const session = inputMappingSession();
  if (!session) return false;
  const matrix = parseClipboardMatrix(rawText);
  if (!mappingHeadersMatch(matrix, session.headers)) {
    state.pendingGridPasteText = rawText;
    renderInputMappingStatus();
    toast('현재 필드명·열 순서와 완전히 같지 않아 적용하지 않았습니다. 원본입력뷰에서 매핑할 수 있습니다.', 'error');
    return false;
  }
  const sourceRows = matrix.slice(1).filter(row => row.some(hasEnteredValue));
  if (!sourceRows.length) return toast('필드명 아래에 입력할 값이 없습니다.', 'error');
  if (sourceRows.some(row => row.length !== session.headers.length)) {
    state.pendingGridPasteText = rawText;
    renderInputMappingStatus();
    return toast('행별 열 수가 필드명과 달라 적용하지 않았습니다. 원본입력뷰에서 확인하세요.', 'error');
  }
  captureGridPasteUndo();
  let next = inputMappingSession();
  let startIndex = startRowId === MAPPING_DEFAULT_ROW_ID
    ? next.workingRows.length
    : next.workingRows.findIndex(row => row.rowId === startRowId);
  if (startIndex < 0) startIndex = next.workingRows.length;
  sourceRows.forEach((values, offset) => {
    const row = next.workingRows[startIndex + offset];
    if (!row) {
      next = addManualRow(next, values);
      return;
    }
    values.forEach((value, columnIndex) => {
      next = updateWorkingCell(next, row.rowId, columnIndex, value);
    });
  });
  modeDraft().inputMapping = next;
  state.pendingGridPasteText = '';
  projectInputMappingToVoucherRows();
  renderRows({ restoreFocus: false });
  saveDraftNow();
  toast(`${sourceRows.length.toLocaleString('ko-KR')}행을 현재 양식 구조로 입력했습니다.`, 'success');
  return true;
}

function clipboardTableMatrix(rawText) {
  const matrix = parseClipboardMatrix(rawText);
  if (matrix.length < 2 || Math.max(...matrix.map(row => row.length), 0) < 2) return null;
  return matrix;
}

function useClipboardTableAsSource(rawText, { sourceName = '클립보드 자료', announce = true } = {}) {
  if (!rawText) return false;
  const matrix = clipboardTableMatrix(rawText);
  if (!matrix || !matrix.some(row => row.some(hasEnteredValue))) return false;
  cancelPhotoAnalysisForNewInput();
  captureGridPasteUndo();
  const modeId = state.draft.activeMode;
  const current = modeDraft();
  const fresh = contract.createDraft({ activeMode: modeId }).modes[modeId];
  current.header = cloneGridValue(fresh.header);
  current.sourceText = rawText;
  current.activeMethod = 'excel';
  const detection = detectHeaderRow(matrix, inputMappingTargets());
  current.inputMapping = mappingSessionWithBatch(createMappingSession({
    matrix,
    headerRowIndex: detection.rowIndex,
    templates: ['READY', 'EMPTY'].includes(state.inputTemplatesStatus) ? state.inputTemplates : [],
    targetDefinitions: inputMappingTargets(),
    fileName: sourceName,
    sheetName: '붙여넣기',
    fileFingerprint: `clipboard-${Date.now().toString(36)}`,
    companyId: state.companyId,
    voucherMode: state.draft.activeMode
  }));
  if (!['READY', 'EMPTY'].includes(state.inputTemplatesStatus)) current.inputMapping.status = MAPPING_SESSION_STATUS.TEMPLATE_LOOKUP_ERROR;
  state.pendingGridPasteText = '';
  state.selectedRowIds.clear();
  sourceTextInput.value = rawText;
  projectInputMappingToVoucherRows({ preserveProductEdits: false });
  saveDraftNow();
  renderMode();
  if (announce) {
    const applied = inputMappingTemplateReady(current.inputMapping);
    toast(applied
      ? `${current.inputMapping.templateName} 양식을 적용했습니다.`
      : '붙여넣은 표를 원본입력뷰에 표시했습니다. 필드명 행과 신규 매핑을 확인하세요.', applied ? 'success' : 'warn');
  }
  return true;
}

function usePendingPasteAsSource() {
  useClipboardTableAsSource(state.pendingGridPasteText);
}

function deleteSelectedMappingRows() {
  const session = inputMappingSession();
  if (!session || !state.selectedRowIds.size) return;
  modeDraft().inputMapping = deleteWorkingRows(session, [...state.selectedRowIds]);
  state.selectedRowIds.clear();
  projectInputMappingToVoucherRows();
  renderRows({ restoreFocus: false });
  saveDraftNow();
  toast('선택한 원본 작업행을 삭제했습니다. 원본입력뷰는 변경되지 않습니다.', 'success');
}

function renderRows({ restoreFocus = true } = {}) {
  if (renderMappingRows()) return;
  applyMappingHeaderLocks(null);
  $('voucherInputTable').hidden = false;
  $('mappingWorktable').hidden = true;
  $('gridSearchInput').placeholder = '상품명·코드·규격·거래처 검색';
  $('detailColumnsButton').hidden = state.draft.activeMethod !== 'photo';
  renderInputMappingStatus();
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
      return `<td data-column="${esc(field.id)}"><input data-field="${esc(field.id)}" type="${inputType}"${numericAttributes} value="${esc(rowFieldDisplayValue(row, field.id, row[field.id] ?? ''))}" aria-label="${esc(field.label)}"></td>`;
    }).join('');
    const customCells = customFieldsFor('voucher').map(field => (
      `<td data-column="${esc(field.id)}"><input data-custom-row-field="${esc(field.id)}" type="text"${field.valueType === 'NUMBER' ? ' inputmode="decimal"' : ''} value="${esc(row.fieldValues?.[field.id]?.edited === false ? row.fieldValues[field.id].currentDisplayValue : (row.customValues?.[field.id] ?? ''))}" aria-label="${esc(field.label)}"></td>`
    )).join('');
    return `<tr data-row-id="${esc(row.rowId)}" ${isDefault ? 'data-default-row="true"' : ''} data-status="${esc(row.matchStatus)}" class="${row.duplicatePossible ? 'is-duplicate' : ''}">
      <td class="row-sequence-cell row-sequence-select-cell"><span class="row-sequence-number">${sequence}</span><input type="checkbox" data-select-row="${isDefault ? '' : esc(row.rowId)}" aria-label="${sequence}번 행 선택" ${isDefault ? 'disabled' : (state.selectedRowIds.has(row.rowId) ? 'checked' : '')}></td>
      <td data-column="productSearch" class="product-search-cell"><input data-product-search type="text" enterkeyhint="search" value="${esc(row.unregisteredProductQuery || row.itemName || row.itemCode || '')}" placeholder="코드·품명·검색어" aria-label="상품 검색" title="상품코드, 품명 또는 검색어 입력 후 Enter"></td>
      <td data-column="itemCode"><input data-field="itemCode" type="text" enterkeyhint="search" value="${esc(rowFieldDisplayValue(row, 'itemCode', row.itemCode))}" aria-label="품목코드" title="입력 후 Enter로 상품 검색"></td>
      <td data-column="itemName"><input data-field="itemName" type="text" enterkeyhint="search" value="${esc(rowFieldDisplayValue(row, 'itemName', row.itemName))}" aria-label="품목명" title="입력 후 Enter로 상품 검색"></td>
      <td data-column="specification"><input data-field="specification" value="${esc(rowFieldDisplayValue(row, 'specification', row.specification))}" aria-label="규격"></td>
      <td data-column="quantity"><input data-field="quantity" type="text" inputmode="decimal" value="${esc(rowFieldDisplayValue(row, 'quantity', row.quantity ?? ''))}" aria-label="수량"></td>
      <td data-column="unit"><input data-field="unit" value="${esc(rowFieldDisplayValue(row, 'unit', row.unit))}" aria-label="단위"></td>
      <td data-column="unitPrice" class="price-cell${row.unitPriceReviewStatus === 'PENDING' ? ' is-price-review-pending' : ''}"><input data-field="unitPrice" type="text" inputmode="decimal" value="${esc(rowFieldDisplayValue(row, 'unitPrice', row.sourceUnitPrice ?? row.unitPrice ?? ''))}" aria-label="단가"></td>
      <td data-column="supplyAmount"><input data-supply-amount value="${amount === null ? '' : amount.toLocaleString('ko-KR')}" aria-label="공급가액" readonly tabindex="-1"></td>
      <td data-column="memo"><input data-field="memo" value="${esc(rowFieldDisplayValue(row, 'memo', row.memo))}" aria-label="메모"></td>
      <td data-column="description"><input data-field="description" value="${esc(rowFieldDisplayValue(row, 'description', row.description))}" aria-label="적요(직원)"></td>
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
  renderInlineValidation(summary);
}

function renderInlineValidation(precomputedSummary = null) {
  const mode = state.draft.activeMode;
  const current = modeDraft();
  const estimateMode = mode === 'estimate';
  const summary = precomputedSummary || contract.summarizeRows((current.rows || []).filter(rowHasMeaningfulInput));
  const customerInvalid = !estimateMode && !(current.header.customerId && current.header.customerName);
  const dateValue = mode === 'order' ? (current.header.orderDate || current.header.voucherDate) : (current.header.voucherDate || current.header.deliveryDate);
  const dateInvalid = !estimateMode && !/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ''));
  const warehouseInvalid = !estimateMode && !((current.header.warehouseId || current.header.warehouseCode) && current.header.warehouseName);
  const rowCount = (current.rows || []).filter(rowHasMeaningfulInput).length;
  $('customerValidation').textContent = customerInvalid ? '등록 거래처를 선택하세요.' : '';
  $('dateValidation').textContent = dateInvalid ? '전표일자를 입력하세요.' : '';
  $('warehouseValidation').textContent = warehouseInvalid ? '등록 창고를 선택하세요.' : '';
  $('gridValidation').textContent = rowCount < 1 ? '상품을 1개 이상 입력하세요.' : (summary.unresolved ? `미등록 상품 ${summary.unresolved}건을 확인하세요.` : '');
  $('customerInput').setAttribute('aria-invalid', String(customerInvalid));
  $('deliveryDateInput').setAttribute('aria-invalid', String(dateInvalid));
  $('warehouseInput').setAttribute('aria-invalid', String(warehouseInvalid));
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
  const creation = estimateCreation();
  const creationCount = creation?.selectedIds.length || 0;
  const mappingBlocksVoucher = Boolean(inputMappingSession()) && !inputMappingTemplateReady();
  $('completeButton').disabled = state.busy || Boolean(creation) || mappingBlocksVoucher;
  $('completeButton').title = mappingBlocksVoucher ? '입력 양식을 확인하고 저장한 뒤 전표를 저장할 수 있습니다.' : '';
  $('completeButton').hidden = false;
  $('completeButton').textContent = '저장';
  const loadedEstimate = isEstimate && state.estimates.some(record => record.estimateId === modeDraft().catalogRecordId);
  $('saveEstimateAsButton').hidden = !isEstimate;
  $('saveEstimateAsButton').disabled = state.busy || !loadedEstimate || Boolean(creation);
  $('estimateCreateButton').hidden = !isEstimate;
  $('estimateCreateButton').disabled = state.busy || !creation || creationCount < 2;
  $('selectedEstimateDeleteButton').disabled = state.busy || state.noticeEstimateIds.length < 1;
  $('estimateRenameButton').disabled = state.busy || state.noticeEstimateIds.length !== 1;
  updateAutosaveButton();
  renderVoucherContext();
  renderInlineValidation();
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
      : { customer: '거래처명 ', date: estimateMode ? '견적 작성일' : '주문일자', warehouse: '출하창고 ' });
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
  $('estimateExcelButton').textContent = 'EXCEL';
  const linkedEstimate = estimateMode && (modeDraft().estimateKind === 'LINKED_GROUP' || estimateCreation()?.kind === 'LINKED_GROUP');
  $('customerInput').disabled = linkedEstimate;
  $('addRowButton').disabled = false;
  $('addRowButton').title = '항상 유지되는 마지막 수기입력 행으로 이동합니다.';
  hydrateHeader();
  renderEstimateHeaderFields();
  $('gridSearchInput').value = state.gridSearch;
  if (!inputMappingSession() && removeParserArtifactRows(modeDraft())) scheduleSave();
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
  applyRelatedPanelState();
  if (!referencesReady()) {
    setAppStatus(referenceStatusMessage(), 'warn');
  } else {
    setAppStatus(selected.id === 'order'
      ? '주문서 입력을 시작할 수 있습니다.'
      : (selected.id === 'estimate' ? (modeDraft().estimateKind === 'COMPOSITION_PREVIEW' ? '선택한 견적서를 중복 제거해 함께 표시합니다. 원본은 견적서 생성 전까지 변경되지 않습니다.' : (linkedEstimate ? '연동견적서 행은 개별 견적서와 양방향으로 반영됩니다.' : '개별 견적서를 작성하거나 연동견적서를 선택할 수 있습니다.')) : `${selected.label} 입력 화면입니다. 전달 연결은 준비 중입니다.`));
  }
  if (sourceTextInput.value.trim() && !inputMappingSession()) scheduleAutoAnalysis(650);
}

function setMode(mode) {
  if (!contract.MODES[mode] || mode === state.draft.activeMode) return false;
  const previousMode = state.draft.activeMode;
  if (previousMode === 'estimate' && estimateCreationActive()) {
    const keep = window.confirm('저장되지 않은 견적서 생성 작업이 있습니다. 선택과 미리보기를 유지한 채 다른 전표로 이동하시겠습니까?');
    if (!keep) {
      const discard = window.confirm('견적서 생성 작업을 폐기하고 이동하시겠습니까? 취소를 누르면 견적서 화면에 머뭅니다.');
      if (!discard) return false;
      const creation = estimateCreation();
      if (creation?.returnDraft) state.draft.modes.estimate = contract.normalizeModeDraft('estimate', creation.returnDraft);
      setEstimateCreation(null);
      state.noticeEstimateIds = [];
      state.estimateSelectionReturnDraft = null;
      state.estimateMultiSelectKind = '';
    }
  }
  clearTimeout(state.autoAnalyzeTimer);
  if (state.pendingStructuredImport?.rawText !== sourceTextInput.value) state.pendingStructuredImport = null;
  modeDraft().sourceText = sourceTextInput.value;
  state.gridPasteUndo = null;
  state.draft.activeMode = mode;
  state.voucherActivity = { ...state.voucherActivity, status: 'IDLE', mode: '', sourceMode: mode === 'estimate' ? 'order' : mode, date: '', rows: [], error: null };
  state.inputTemplates = [];
  state.inputTemplatesStatus = 'LOADING';
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
      if (estimateCreationActive()) {
        syncEstimateCreationSelection();
        state.estimateSelectionReturnDraft = estimateCreation()?.returnDraft || null;
      } else {
        state.noticeEstimateIds = [];
        state.estimateSelectionReturnDraft = null;
      }
    }
    saveDraftNow();
    renderMode();
    void reloadInputTemplates({ applyCurrent: true, announce: false });
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
  const sequence = trailing.querySelector('.row-sequence-number');
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
  const row = input?.closest('tr[data-row-id], tr[data-mapping-row-id]');
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
  const visibleFields = visibleGridPasteFields();
  const plan = buildGridPastePlan(rawText, {
    fieldDefinitions: definitions,
    visibleFieldIds: visibleFields,
    startFieldId,
    numberParser: contract.numberOrNull,
    requireHeaders: true
  });
  if (!plan.valid) {
    return useClipboardTableAsSource(rawText, { sourceName: '작업테이블 붙여넣기' });
  }
  if (plan.invalidCells.length) {
    const cells = plan.invalidCells.slice(0, 3).map(cell => `${cell.rowNumber}행 ${cell.fieldId}`).join(', ');
    toast(`숫자 필드 값을 확인하세요. 붙여넣기를 중단했습니다. ${cells}`, 'error');
    return false;
  }
  const pasteRows = plan.rows.filter(row => row.cells.some(cell => hasEnteredValue(cell.value)));
  if (!pasteRows.length) {
    toast('필드명 아래에 입력할 값이 없습니다.', 'error');
    return false;
  }

  cancelPhotoAnalysisForNewInput();
  captureGridPasteUndo();
  state.pendingGridPasteText = '';
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
    const requiredRowCount = startRowIndex + pasteRows.length;
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
    pasteRows.forEach((pasteRow, rowOffset) => {
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
    const message = `${pasteRows.length.toLocaleString('ko-KR')}행 · ${pastedCellCount.toLocaleString('ko-KR')}셀을 입력했습니다.`;
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
  delete current.inputMapping;
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
    if (/\.(xlsx|xls|csv|tsv)$/i.test(file.name)) {
      await ensureXlsx();
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const fileHashBuffer = await crypto.subtle.digest('SHA-256', fileBytes);
      const fileDigest = [...new Uint8Array(fileHashBuffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const workbook = window.XLSX.read(fileBytes, { type: 'array', cellDates: false, cellText: true });
      let selected = null;
      let purchaseMetaRows = null;
      let salesMetaRows = null;
      const targets = inputMappingTargets();
      workbook.SheetNames.forEach(sheetName => {
        if (!workbook.Sheets[sheetName]?.['!ref']) return;
        const worksheetSource = readWorksheetSource(window.XLSX, workbook.Sheets[sheetName]);
        const matrix = worksheetSource.displayMatrix;
        if (isPurchaseMetaSheet(sheetName, matrix)) {
          if (state.draft.activeMode === 'purchase') purchaseMetaRows = readPurchaseMeta(matrix);
          return;
        }
        if (isSalesMetaSheet(sheetName, matrix)) {
          if (state.draft.activeMode === 'sale') salesMetaRows = readSalesMeta(matrix);
          return;
        }
        const detection = detectHeaderRow(matrix, targets);
        const candidate = { matrix, sourceCellMatrix: worksheetSource.sourceCellMatrix, sheetName, detection };
        if (!selected || candidate.detection.score > selected.detection.score) selected = candidate;
      });
      if (!selected) throw new Error('읽을 수 있는 Excel 시트가 없습니다.');
      captureGridPasteUndo();
      const modeId = state.draft.activeMode;
      const current = modeDraft();
      const fresh = contract.createDraft({ activeMode: modeId }).modes[modeId];
      current.header = cloneGridValue(fresh.header);
      current.sourceText = selected.matrix.map(row => row.map(cell => String(cell ?? '')).join('\t')).join('\n');
      current.activeMethod = 'excel';
      let mapping = mappingSessionWithBatch(createMappingSession({
        matrix: selected.matrix,
        headerRowIndex: selected.detection.rowIndex,
        templates: state.inputTemplatesStatus === 'ERROR' ? [] : state.inputTemplates,
        targetDefinitions: targets,
        fileName: file.name,
        sheetName: selected.sheetName,
        fileFingerprint: fileDigest,
        sourceCellMatrix: selected.sourceCellMatrix,
        companyId: state.companyId,
        voucherMode: state.draft.activeMode
      }));
      if (state.inputTemplatesStatus === 'ERROR' || state.inputTemplatesStatus === 'LOADING') {
        mapping = {
          ...mapping,
          status: MAPPING_SESSION_STATUS.TEMPLATE_LOOKUP_ERROR,
          issues: [{ code: state.inputTemplatesStatus === 'LOADING' ? 'TEMPLATE_LOOKUP_PENDING' : 'TEMPLATE_LOOKUP_FAILED' }]
        };
      }
      mapping.purchaseMetaRows = purchaseMetaRows;
      mapping.salesMetaRows = salesMetaRows;
      current.inputMapping = mapping;
      void saveMappingSessionV2(mapping).catch(() => {});
      state.pendingSourceName = `${file.name} · ${selected.sheetName}`;
      state.pendingGridPasteText = '';
      state.selectedRowIds.clear();
      sourceTextInput.value = current.sourceText;
      projectInputMappingToVoucherRows({ preserveProductEdits: false });
      saveDraftNow();
      renderMode();
      const applied = mapping.status === MAPPING_SESSION_STATUS.TEMPLATE_APPLIED;
      setAppStatus(applied
        ? `${mapping.templateName} 양식을 적용했습니다. 원본과 매핑 결과를 확인하세요.`
        : `${file.name}의 ${mapping.headerRowIndex + 1}행을 필드명 후보로 표시했습니다. 신규 양식을 확인하세요.`, applied ? '' : 'warn');
      toast(applied ? `${mapping.templateName} 양식을 완벽 일치로 적용했습니다.` : '기존 양식과 완벽 일치하지 않아 신규 양식 설정을 시작합니다.', applied ? 'success' : 'warn');
      return;
    } else {
      const rawText = await file.text();
      state.pendingSourceName = file.name;
      state.pendingStructuredImport = null;
      sourceTextInput.value = rawText;
      syncSourceText();
      setAppStatus(`${file.name}을 불러왔습니다. 기존 텍스트 분석을 시작합니다.`);
      toast('텍스트 파일을 원본입력뷰에 불러왔습니다.', 'success');
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

function cancelPhotoAnalysisForNewInput() {
  state.photoCaptureSequence += 1;
  if (modeDraft().activeMethod !== 'photo') return;
  state.pendingImageEvidence = null;
  state.pendingOcrReview = null;
  state.busy = false;
  $('analyzeButton').disabled = false;
  $('parserProgress').hidden = true;
  setActiveActivity('');
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
  if (useClipboardTableAsSource(droppedText, { sourceName: '드래그한 표 자료' })) return;
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
        if (captureSequence !== state.photoCaptureSequence) return;
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
    if (captureSequence !== state.photoCaptureSequence || currentSourceImage()?.sourceImageId !== imageEvidence.sourceImageId) return;
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
    if (captureSequence !== state.photoCaptureSequence) return;
    state.pendingOcrReview = null;
    if (state.sourceImages[state.draft.activeMode]) {
      state.sourceImages[state.draft.activeMode].notice = '자동 인식에 실패했습니다. 원본 사진을 보면서 직접 입력할 수 있습니다.';
      void persistSourceImageForMode();
      renderSourceSurface();
    }
    toast(error.message || '사진 문자를 추출하지 못했습니다.', 'error');
    setAppStatus('사진 OCR을 완료하지 못했습니다. 직접 입력할 수 있습니다.', 'warn');
  } finally {
    if (captureSequence === state.photoCaptureSequence) {
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
  dialog.className = 'smart-dialog product-picker-dialog';
  dialog.setAttribute('aria-labelledby', 'productPickerTitle');
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Product Master</small><h2 id="productPickerTitle">상품 후보 선택</h2></div><button type="button" data-close aria-label="상품 후보창 닫기">×</button></header>
    <label class="smart-dialog__search product-picker-search"><span>상품명 또는 품목코드</span><input type="text" data-product-search autocomplete="off" placeholder="상품명·코드·규격으로 검색" role="combobox" aria-autocomplete="list" aria-controls="productCandidateResults" aria-expanded="true"></label>
    <div class="smart-dialog__message product-picker-message" data-product-message role="status" aria-live="polite"></div>
    <div class="product-picker-results" id="productCandidateResults" data-product-results role="listbox" aria-label="상품 후보"></div>
    <footer><small>↑↓ 이동 · Enter 선택 · Esc 닫기</small><button type="button" class="button button--quiet" data-close>취소</button></footer>
  </div>`;
  document.body.append(dialog);
  const search = dialog.querySelector('[data-product-search]');
  const message = dialog.querySelector('[data-product-message]');
  const results = dialog.querySelector('[data-product-results]');
  search.value = query || row.itemCode || row.itemName || '';

  let closed = false;
  const finish = product => {
    if (closed) return;
    closed = true;
    const liveRow = modeDraft().rows.find(item => item.rowId === row.rowId) || row;
    if (product) {
      const before = { ...liveRow, customValues: { ...(liveRow.customValues || {}) } };
      if (!applyProduct(liveRow, product, { forceIdentityFields: true })) {
        closed = false;
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
    search.setAttribute('aria-expanded', 'false');
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
    const buttons = [...results.querySelectorAll('.product-picker-result')];
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
    if (!foundProducts.length) {
      results.innerHTML = '<div class="product-picker-empty">검색 결과가 없습니다.<br>검색어를 바꾸거나 Esc로 닫으면 현재 입력값이 유지됩니다.</div>';
    }
    foundProducts.forEach((product, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `product-candidate-${index}`;
      button.className = `product-picker-result${index === 0 ? ' is-selected' : ''}`;
      button.setAttribute('role', 'option');
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
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => finish(null)));
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
  const creation = estimateCreation();
  const selectedRecords = selectedEstimateRecords();
  if (!creation && !selectedRecords.length) return toast('카톡으로 만들 견적서를 선택하세요.', 'error');
  const noticeSources = creation ? [{
    estimateId: 'COMPOSITION_PREVIEW',
    estimateName: `${creation.kind === 'LINKED_GROUP' ? '연동' : '개별'}견적서 미리보기`,
    rows: current.rows,
    previousPrices: estimateComparisonPrices(current)
  }] : selectedRecords.map(record => {
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
    <div class="smart-dialog__message">${creation ? `선택 ${creation.selectedIds.length}개를 중복 제거한 저장 전 미리보기입니다.` : `선택한 ${noticeSources.length}개 견적서를 표시합니다.`} 상단 단가 필터는 결과에 함께 적용되며 PNG에는 포함되지 않습니다.</div>
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
  const creation = estimateCreation();
  const selectedRecords = selectedEstimateRecords();
  const sourceRows = creation ? modeDraft().rows : (selectedRecords.length ? combinedEstimateRows(selectedRecords) : modeDraft().rows);
  const output = buildEstimateF8Data(sourceRows);
  try { await ensureXlsx(); }
  catch (error) { return toast(error.message, 'error'); }
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.aoa_to_sheet(output.shopData), '쇼핑몰업로드');
  window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.aoa_to_sheet(output.erpData), 'ERP업데이트');
  window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.aoa_to_sheet(output.errorData), '오류정보');
  const dateStamp = new Date().toLocaleDateString('sv-SE');
  const selectionCount = creation?.selectedIds.length || selectedRecords.length;
  const selectionLabel = selectionCount ? `선택견적_${selectionCount}개_` : '';
  window.XLSX.writeFile(workbook, `통합업로드용_${selectionLabel}견적F8_${dateStamp}.xlsx`);
  setAppStatus(`견적 Excel 생성 완료 · ${selectionCount || 1}개 견적 · ${output.rows.length}품목 · 확인 ${output.errorData.length - 1}건`);
  toast(selectionCount ? '현재 테이블 미리보기와 같은 상품을 Excel로 생성했습니다.' : '현재 견적서를 Excel로 생성했습니다.', 'success');
}

function voucherOutputRows(current = modeDraft()) {
  return (current.rows || []).filter(rowHasMeaningfulInput);
}

function voucherOutputDate(mode, header = {}) {
  return ['purchase', 'sale'].includes(mode)
    ? (header.voucherDate || header.deliveryDate || '')
    : (mode === 'order' ? (header.orderDate || header.voucherDate || header.deliveryDate || '') : (header.deliveryDate || ''));
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
  const dateLabel = mode === 'purchase' ? '구매일자' : (mode === 'sale' ? '판매일자' : '주문일자');
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
  const dateLabel = mode === 'purchase' ? '구매일자' : (mode === 'sale' ? '판매일자' : '주문일자');
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
  pruneEmptyWorkRows(current);
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

const LINKED_ESTIMATE_SYNC_FIELDS = Object.freeze([
  'itemCode', 'itemName', 'secondaryName', 'specification', 'quantity', 'unit', 'unitPrice',
  'memo', 'description', 'noticePrice', 'customValues'
]);

function summarizeEstimateRecord(record, timestamp) {
  const summary = contract.summarizeRows(record.draft?.rows || []);
  record.rowCount = summary.total;
  record.amount = summary.amount;
  record.updatedAt = timestamp;
  if (record.draft) record.draft.updatedAt = timestamp;
  return record;
}

function synchronizeLinkedEstimateRecords(targetRecord, currentDraft, timestamp) {
  const changed = new Map();
  const recordsById = new Map(state.estimates.map(record => [record.estimateId, JSON.parse(JSON.stringify(record))]));
  if (targetRecord.estimateKind === 'LINKED_GROUP') {
    currentDraft.rows.forEach(linkedRow => {
      const fields = [...new Set([
        ...Object.keys(linkedRow.editedFields || {}).filter(field => linkedRow.editedFields[field]),
        ...(linkedRow.linkedSyncFields || [])
      ])].filter(field => LINKED_ESTIMATE_SYNC_FIELDS.includes(field));
      if (!fields.length) return;
      const refs = linkedRow.linkedSourceRefs?.length
        ? linkedRow.linkedSourceRefs
        : [{ estimateId: linkedRow.linkedSourceEstimateId, rowId: linkedRow.linkedSourceRowId }];
      refs.forEach(ref => {
        const source = changed.get(ref.estimateId) || recordsById.get(ref.estimateId);
        if (!source || source.estimateKind === 'LINKED_GROUP') return;
        const sourceIndex = source.draft?.rows?.findIndex(row => row.rowId === ref.rowId) ?? -1;
        if (sourceIndex < 0) return;
        const original = source.draft.rows[sourceIndex];
        const next = { ...original };
        fields.forEach(field => { next[field] = field === 'customValues' ? { ...(linkedRow.customValues || {}) } : linkedRow[field]; });
        source.draft.rows[sourceIndex] = contract.normalizeRow({
          ...next,
          rowId: original.rowId,
          linkedSourceEstimateId: '', linkedSourceEstimateName: '', linkedSourceRowId: '', linkedSourceEstimateIds: [], linkedSourceRefs: []
        });
        changed.set(source.estimateId, summarizeEstimateRecord(source, timestamp));
      });
    });
    targetRecord.linkedEstimateSources = (targetRecord.linkedEstimateSources || []).map(source => (
      changed.has(source.estimateId) ? { ...source, updatedAt: timestamp } : source
    ));
  } else if (targetRecord.estimateId) {
    const sourceRows = new Map((targetRecord.draft?.rows || []).map(row => [row.rowId, row]));
    linkedEstimateRecords().forEach(groupRecord => {
      const group = recordsById.get(groupRecord.estimateId);
      let touched = false;
      group.draft.rows = group.draft.rows.map(groupRow => {
        const ref = (groupRow.linkedSourceRefs || []).find(item => item.estimateId === targetRecord.estimateId)
          || (groupRow.linkedSourceEstimateId === targetRecord.estimateId
            ? { estimateId: groupRow.linkedSourceEstimateId, rowId: groupRow.linkedSourceRowId }
            : null);
        const sourceRow = ref ? sourceRows.get(ref.rowId) : null;
        if (!sourceRow) return groupRow;
        const next = { ...groupRow };
        LINKED_ESTIMATE_SYNC_FIELDS.forEach(field => { next[field] = field === 'customValues' ? { ...(sourceRow.customValues || {}) } : sourceRow[field]; });
        touched = true;
        return contract.normalizeRow({ ...next, rowId: groupRow.rowId });
      });
      if (touched) changed.set(group.estimateId, summarizeEstimateRecord(group, timestamp));
    });
  }
  changed.set(targetRecord.estimateId, summarizeEstimateRecord(targetRecord, timestamp));
  return [...changed.values()];
}

function openEstimateSaveDialog({ saveAs = false } = {}) {
  if (!validateEstimateDocument()) return;
  const current = modeDraft();
  const creation = estimateCreation();
  if (creation) {
    creation.status = 'NAMING';
    saveDraftNow();
  }
  const loadedRecord = state.estimates.find(record => record.estimateId === current.catalogRecordId);
  if (saveAs && !loadedRecord) return toast('먼저 저장된 견적서를 선택하세요.', 'warn');
  const loadedName = loadedRecord ? estimateTitle(loadedRecord) : '';
  const defaultName = saveAs
    ? `${loadedName} 복사본`
    : (estimateCreation()?.kind === 'LINKED_GROUP' || current.estimateKind === 'LINKED_GROUP' ? '새 연동견적서' : (current.header.customerName || '새 견적서'));
  const dialogTitle = saveAs ? '새 견적서 저장' : '견적서 저장';
  const dialogMessage = saveAs
    ? '현재 내용으로 새 견적서를 만듭니다. 기존 견적서는 이름과 내용이 그대로 유지됩니다.'
    : '새 견적서명을 입력하면 견적서 목록에 저장됩니다.';
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog estimate-save-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>${saveAs ? 'Save As' : 'Estimate Save'}</small><h2>${dialogTitle}</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-dialog__message">${dialogMessage}</div>
    <div class="estimate-dialog-form"><label><span>견적서명</span><input type="text" data-estimate-name maxlength="80" value="${esc(defaultName)}" placeholder="견적서명을 입력하세요" autocomplete="off" enterkeyhint="done" autofocus></label></div>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-confirm-save>${saveAs ? '새 견적서 저장' : '저장'}</button></footer>
  </div>`;
  document.body.append(dialog);
  const finish = () => {
    const pendingCreation = estimateCreation();
    if (pendingCreation?.status === 'NAMING') {
      pendingCreation.status = 'COMPOSITION_PREVIEW';
      saveDraftNow();
      renderCatalogControls();
    }
    dialog.close();
    dialog.remove();
  };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  const submit = async () => {
    const catalogName = dialog.querySelector('[data-estimate-name]').value.trim();
    if (!catalogName) {
      dialog.querySelector('[data-estimate-name]').focus();
      return toast('견적서명을 입력하세요.', 'error');
    }
    if (saveAs && catalogName === loadedName) {
      dialog.querySelector('[data-estimate-name]').focus();
      dialog.querySelector('[data-estimate-name]').select();
      return toast('기존 견적서와 다른 새 양식명을 입력하세요.', 'warn');
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
  const nameInput = dialog.querySelector('[data-estimate-name]');
  const focusNameInput = () => {
    nameInput.focus({ preventScroll: true });
    if (nameInput.value) nameInput.select();
    else nameInput.setSelectionRange(0, 0);
  };
  focusNameInput();
  window.setTimeout(focusNameInput, 0);
}

async function saveEstimateDocument(catalogName) {
  if (!validateEstimateDocument()) return false;
  const current = modeDraft();
  const requestedName = String(catalogName || '').trim();
  if (!requestedName) return false;
  const creation = estimateCreation();
  const intendedKind = creation?.kind === 'LINKED_GROUP' || current.estimateKind === 'LINKED_GROUP' ? 'LINKED_GROUP' : 'INDIVIDUAL';
  if (creation?.kind === 'LINKED_GROUP' && creation.selectedIds.length < 2) {
    toast('연동견적서는 원본 견적서 두 개 이상을 선택해야 저장할 수 있습니다.', 'error');
    return false;
  }
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
    const timestamp = new Date().toISOString();
    const updateExistingRecord = Boolean(overwriteRecord);
    const estimateId = updateExistingRecord ? overwriteRecord.estimateId : createRecordId('SIEST');
    const storedPrices = buildCatalogPriceSnapshot(overwriteRecord?.draft?.rows || []);
    const priorPrices = Object.keys(current.catalogBaselinePrices || {}).length
      ? { ...current.catalogBaselinePrices }
      : storedPrices;
    const nextCurrent = contract.normalizeModeDraft('estimate', JSON.parse(JSON.stringify(current)));
    nextCurrent.catalogPreviousPrices = { ...priorPrices };
    nextCurrent.catalogBaselinePrices = buildCatalogPriceSnapshot(nextCurrent.rows);
    nextCurrent.catalogRecordId = estimateId;
    nextCurrent.estimateKind = intendedKind;
    nextCurrent.updatedAt = timestamp;
    nextCurrent.delivery = { status: 'SAVED', targetId: 'smart-input-estimates', targetRecordId: estimateId, deliveredAt: timestamp };
    const summary = contract.summarizeRows(nextCurrent.rows);
    const record = {
      estimateId,
      catalogName: requestedName,
      estimateKind: intendedKind,
      linkedEstimateSources: intendedKind === 'LINKED_GROUP' ? nextCurrent.linkedEstimateSources.map(source => ({ ...source })) : [],
      customerId: intendedKind === 'LINKED_GROUP' ? '' : nextCurrent.header.customerId,
      customerName: intendedKind === 'LINKED_GROUP' ? '' : nextCurrent.header.customerName,
      rowCount: summary.total,
      amount: summary.amount,
      previousPrices: priorPrices,
      sortOrder: updateExistingRecord ? Number(overwriteRecord.sortOrder || 1) : state.estimates.length + 1,
      createdAt: updateExistingRecord ? (overwriteRecord.createdAt || timestamp) : timestamp,
      updatedAt: timestamp,
      draft: JSON.parse(JSON.stringify(createCatalogOnlyDraft(nextCurrent, estimateId)))
    };
    const bundle = synchronizeLinkedEstimateRecords(record, nextCurrent, timestamp);
    await saveEstimateBundle(bundle);
    const bundleById = new Map(bundle.map(item => [item.estimateId, item]));
    state.estimates = normalizeEstimateOrder(updateExistingRecord
      ? state.estimates.map(item => bundleById.get(item.estimateId) || item)
      : [...state.estimates.map(item => bundleById.get(item.estimateId) || item), record]);
    state.draft.modes.estimate = nextCurrent;
    bundle.forEach(item => state.estimateWorkingCopies.delete(item.estimateId));
    state.estimateLibraryKind = record.estimateKind === 'LINKED_GROUP' ? 'linked' : 'individual';
    state.noticeEstimateIds = [estimateId];
    state.estimateSelectionReturnDraft = null;
    state.estimateMultiSelectKind = '';
    setEstimateCreation(null);
    clearCustomerAfterSave(nextCurrent.header);
    saveDraftNow();
    hydrateHeader();
    renderEstimateHeaderFields();
    const affectedCount = Math.max(0, bundle.length - 1);
    state.lastEstimateSave = { estimateId, linkCount: estimateSaveImpact(record), affectedCount };
    renderCatalogControls();
    renderDelivery();
    setAppStatus(`${estimateTitle(record)} · ${summary.total}품목 저장 완료${state.lastEstimateSave.linkCount ? ` · 연결 ${state.lastEstimateSave.linkCount}개` : ''}${affectedCount ? ` · 연동 ${affectedCount}건 반영` : ''}`);
    toast(updateExistingRecord ? '기존 견적서를 덮어썼습니다.' : '새 견적서를 목록 최하단에 저장했습니다.', 'success');
    return true;
  } catch (error) {
    if (creation) creation.status = 'SAVE_ERROR';
    setAppStatus('견적서를 저장하지 못했습니다. 입력 내용은 유지됩니다.', 'error');
    toast(error.message || '견적서 저장에 실패했습니다.', 'error');
    return false;
  } finally {
    state.busy = false;
    renderCatalogControls();
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

function importRelatedVoucher(voucherId) {
  const source = state.voucherActivity.rows.find(row => row.id === voucherId);
  if (!source) return toast('불러올 전표를 찾지 못했습니다.', 'error');
  const current = modeDraft();
  try {
    const plan = createRelatedVoucherImportPlan({
      companyId: state.companyId,
      targetVoucherMode: state.draft.activeMode,
      sourceVoucherMode: state.voucherActivity.sourceMode || state.voucherActivity.mode,
      sourceVoucher: source
    });
    const conflicts = relatedImportConflicts(plan, current.header);
    if (conflicts.length && !window.confirm(
      `현재 입력과 불러올 전표의 ${conflicts.map(item => item.kind === 'CUSTOMER' ? '거래처' : '창고').join('·')}가 다릅니다.\n`
      + '자동으로 합치지 않고 원본 행 구분을 유지한 채 불러오시겠습니까?'
    )) return;
    const before = current.rows.length;
    const applied = applyRelatedVoucherImportPlan(plan, current, { acceptConflicts: conflicts.length > 0 });
    current.header = contract.normalizeHeader(applied.header, current.header);
    current.rows = contract.markDuplicatePossibilities(applied.rows.map(row => {
      let normalized = contract.normalizeRow(row);
      if (!normalized.productId || !normalized.masterProductId) normalized = matchGridPasteRow(normalized);
      return normalized;
    }));
    current.relatedImportHistory = applied.relatedImportHistory;
    current.activeMethod = 'relatedVoucher';
    current.delivery = { status: 'DRAFT', targetId: '', targetRecordId: '', deliveredAt: '' };
    saveDraftNow();
    renderMode();
    const imported = current.rows.length - before;
    toast(imported ? `${source.voucherNo || source.id}에서 ${imported}개 품목을 불러왔습니다.` : '이미 불러온 전표입니다.', imported ? 'success' : 'warn');
  } catch (error) {
    toast(error.message || '관련 전표를 불러오지 못했습니다.', 'error');
  }
}

function confirmGroupedVoucherCreation(mode, groups = []) {
  if (groups.length <= 1) return true;
  const label = contract.MODES[mode]?.label || mode;
  const customerCount = new Set(groups.map(group => group.supplierCustomerId || group.supplierCustomerCode || group.supplierCustomerName
    || group.salesCustomerId || group.salesCustomerCode || group.salesCustomerName
    || group.deliveryCustomerId || group.deliveryCustomerCode || group.deliveryCustomerName).filter(Boolean)).size;
  const warehouseCount = new Set(groups.map(group => group.warehouseId || group.warehouseCode).filter(Boolean)).size;
  return window.confirm(
    `${label} 자료가 ${groups.length}개의 전표로 나뉩니다.\n`
    + `거래처 ${customerCount || '미확인'}곳 · 창고 ${warehouseCount || '미확인'}곳\n\n`
    + '거래처·창고·일자·원본 전표가 다른 행은 자동으로 합치지 않습니다. 이 구분대로 저장하시겠습니까?'
  );
}

async function completeOrder() {
  if (inputMappingSession() && !inputMappingTemplateReady()) {
    setAppStatus('입력 양식이 확정되지 않아 전표 저장을 중단했습니다. 현재 작업은 유지됩니다.', 'error');
    toast('모든 열을 매핑 또는 비매핑으로 결정하고 입력 양식을 저장하세요.', 'error');
    return;
  }
  const current = modeDraft();
  if (pruneEmptyWorkRows(current)) {
    renderRows({ restoreFocus: false });
    saveDraftNow();
  }
  if (state.draft.activeMode === 'estimate') {
    const creation = estimateCreation();
    if (creation?.kind === 'LINKED_GROUP' && creation.selectedIds.length < 2) return toast('연동견적서는 원본 두 개 이상을 선택하세요.', 'warn');
    if (creation && !creation.selectedIds.length) return toast('생성할 견적서를 선택하세요.', 'warn');
    if (!validateEstimateDocument()) return;
    const loadedRecord = state.estimates.find(record => record.estimateId === current.catalogRecordId);
    const assignedName = String(loadedRecord?.catalogName || '').trim();
    return assignedName ? saveEstimateDocument(assignedName) : openEstimateSaveDialog();
  }
  if (state.draft.activeMode === 'purchase') return completePurchaseOfficial();
  if (state.draft.activeMode === 'sale') return completeSaleOfficial();
  return completeOrderLegacy();
}

function scheduleOfficialVoucherSync(afterLocalMutation = false) {
  window.setTimeout(async () => {
    try {
      const result = afterLocalMutation
        ? await syncOfficialAfterLocalMutation(state.companyId)
        : await syncOfficialVouchers(state.companyId);
      const conflicts = Number(result?.push?.conflicts || 0)
        + (result?.pulls || []).reduce((sum, row) => sum + Number(row?.conflicts || 0), 0);
      if (conflicts) setAppStatus(`공식 전표 동기화에서 확인할 충돌 ${conflicts}건이 있습니다. 로컬 전표는 유지됩니다.`, 'warn');
    } catch (error) {
      console.warn('SmartInput official voucher background sync failed; local work is preserved.', error);
    }
  }, 0);
}

function stocktakeConflictsFromFinalizeResults(results = []) {
  const unique = new Map();
  results.forEach(row => {
    if (row.ok || row.error?.code !== 'ORDERQ_OFFICIAL_V2_STOCKTAKE_DECISION_REQUIRED') return;
    (row.error.conflicts || []).forEach(conflict => {
      const key = [conflict.companyId, conflict.documentId, conflict.sourceLineId, conflict.checkpointId].join('|');
      if (!unique.has(key)) unique.set(key, conflict);
    });
  });
  return [...unique.values()];
}

async function finalizeWithStocktakeDecision(service, request) {
  let results = await service.finalize(request);
  const conflicts = stocktakeConflictsFromFinalizeResults(results);
  if (!conflicts.length) return { cancelled: false, results };
  const stocktakeDecisions = await showStocktakeConflictDialog(conflicts);
  if (!stocktakeDecisions) return { cancelled: true, results: [] };
  results = await service.finalize({
    ...request,
    stocktakeDecisions
  });
  return { cancelled: false, results };
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
  if (!confirmGroupedVoucherCreation('sale', groups)) return;
  state.busy = true;
  renderDelivery();
  try {
    // SaleFinalizeService.finalize(...) runs inside the stocktake decision coordinator.
    const finalized = await finalizeWithStocktakeDecision(SaleFinalizeService, {
      groups,
      companyId: state.companyId,
      activeMethod: current.activeMethod,
      manualSessionId: current.documentId,
      lastBatchContentHash: current.batches?.at(-1)?.contentHash,
      customers: state.customers,
      products: state.products,
      warehouses: state.warehouseCatalog.warehouses || []
    });
    if (finalized.cancelled) return;
    const results = finalized.results;
    results.filter(row => row.ok).forEach(({ group, result }) => {
      const documentId = result.salesDocumentId || result.document?.salesDocumentId || '';
      const commandId = result.commandId || '';
      current.saleSubmissions = (current.saleSubmissions || []).filter(pointer => pointer.voucherGroupKey !== group.voucherGroupKey);
      current.saleSubmissions.push({ salesDocumentId: documentId, commandId,
        state: result.projectionPending ? 'PROJECTION_PENDING' : 'LOCAL_PROJECTED',
        receiptKey: commandId ? `centralProjection:${commandId}` : '', voucherGroupKey: group.voucherGroupKey, lastErrorCode: '' });
    });
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
    state.voucherActivity.status = 'IDLE';
    saveDraftNow(); renderMode(); setAppStatus(`공식 판매전표 ${succeeded.length}건 저장 완료`);
    toast(`판매전표 ${succeeded.length}건을 저장했습니다.`, 'success');
    scheduleOfficialVoucherSync(true);
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
  if (!confirmGroupedVoucherCreation('purchase', groups)) return;
  const masters = { customers: state.customers, products: state.products, warehouses: state.warehouseCatalog.warehouses || [] };
  state.busy = true;
  renderDelivery();
  try {
    // PurchaseFinalizeService.finalize(...) runs inside the stocktake decision coordinator.
    const finalized = await finalizeWithStocktakeDecision(PurchaseFinalizeService, {
      groups,
      masters,
      companyId: state.companyId,
      activeMethod: current.activeMethod,
      manualSessionId: current.documentId
    });
    if (finalized.cancelled) return;
    const results = finalized.results;
    results.filter(row => row.ok).forEach(({ group, result }) => {
      const documentId = result.purchaseDocumentId || result.document?.purchaseDocumentId || result.central?.changes?.find(row => row.entityType === 'PURCHASE_DOCUMENT')?.entityId || '';
      const commandId = result.commandId || result.central?.commandId || result.central?.result?.commandId || '';
      current.purchaseSubmissions = (current.purchaseSubmissions || []).filter(pointer => pointer.voucherGroupKey !== group.voucherGroupKey);
      current.purchaseSubmissions.push({ purchaseDocumentId: documentId, commandId, state: result.projectionPending ? 'PROJECTION_PENDING' : 'LOCAL_PROJECTED', receiptKey: commandId ? `centralProjection:${commandId}` : '', voucherGroupKey: group.voucherGroupKey, lastErrorCode: '' });
    });
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
    state.voucherActivity.status = 'IDLE';
    saveDraftNow();
    renderMode();
    setAppStatus(`공식 구매전표 ${succeeded.length}건 저장 완료`);
    toast(`구매전표 ${succeeded.length}건을 저장했습니다.`, 'success');
    scheduleOfficialVoucherSync(true);
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
  state.voucherActivity.status = 'IDLE';
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
  current.header.orderDate ||= current.header.voucherDate || contract.businessDate(current.header.recordedAt, state.settings.timezone);
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
    if (!confirmGroupedVoucherCreation('order', groups)) return;
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
    state.voucherActivity.status = 'IDLE';
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
    state.estimateMultiSelectKind = '';
    setEstimateCreation(null);
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
    withTimeout(loadSmartInputData(), 5000, '스마트입력 설정 로딩 시간 초과'),
    withTimeout(loadInputTemplates(state.companyId, state.draft.activeMode), 5000, '입력 양식 로딩 시간 초과')
  ]);
  if (smartDataResult[0].status === 'fulfilled') {
    const data = smartDataResult[0].value;
    state.settings = contract.normalizeSettings(data.settings || {});
    state.linkGroups = data.linkGroups || [];
    state.temporaryCustomers = data.temporaryCustomers || [];
    state.aliasMappings = data.aliasMappings || [];
    state.estimates = normalizeEstimateOrder(data.estimates || []);
    state.inputTemplates = smartDataResult[1].status === 'fulfilled' && Array.isArray(smartDataResult[1].value)
      ? smartDataResult[1].value
      : [];
    state.inputTemplatesStatus = smartDataResult[1].status === 'rejected'
      ? 'ERROR'
      : (state.inputTemplates.length ? 'READY' : 'EMPTY');
    state.inputTemplatesError = smartDataResult[1].status === 'rejected' ? smartDataResult[1].reason : null;
    state.sourceImageRecords = new Map((data.sourceImages || []).map(sourceImage => [sourceImage.documentId, sourceImage]));
    Object.keys(state.sourceImages).forEach(mode => restoreSourceImageForMode(mode));
    restoreCachedReferences(data.referenceCache || {});
    state.customers = normalizedCustomerCandidates(state.customers);
    state.smartDataReady = true;
    restoreInputMappingSession({ applyLatestTemplate: false });
    renderMode();
  } else {
    state.inputTemplates = [];
    state.inputTemplatesStatus = 'ERROR';
    state.inputTemplatesError = smartDataResult[0].reason || new Error('입력 양식 목록 로드 실패');
  }
  try {
    await ensureFieldCatalogSeed();
    const registries = await Promise.all(Object.keys(contract.MODES).map(voucherMode => loadVoucherFieldRegistry({
      companyId: state.companyId,
      voucherMode,
      actor: state.actorId
    })));
    state.fieldRegistries = Object.fromEntries(registries.map(registry => [registry.voucherMode, registry]));
    state.fieldRegistryStatus = 'READY';
    state.fieldRegistryError = null;
  } catch (error) {
    state.fieldRegistryStatus = 'ERROR';
    state.fieldRegistryError = error;
    setAppStatus('전표 필드 등록부를 불러오지 못했습니다. 기본 필드로 계속 입력할 수 있습니다.', 'warn');
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
  scheduleOfficialVoucherSync(false);
}

async function persistFieldRegistryLayout(settings) {
  await Promise.all(Object.keys(contract.MODES).map(async voucherMode => {
    const registry = state.fieldRegistries[voucherMode];
    if (!registry) return;
    const selected = new Set([
      ...(settings.headerFieldsByMode?.[voucherMode] || []),
      ...(settings.voucherColumnsByMode?.[voucherMode] || [])
    ]);
    const definitions = [...registry.coreDefinitions, ...registry.customDefinitions, ...registry.catalog];
    const settingById = new Map(registry.settings.map(row => [row.fieldId, { ...row }]));
    definitions.forEach((definition, index) => {
      const current = settingById.get(definition.fieldId) || {
        schemaVersion: 'ONEAPP_COMPANY_VOUCHER_FIELD_SETTING_V1',
        companyId: state.companyId,
        voucherMode,
        fieldId: definition.fieldId,
        required: definition.systemRequired,
        uiZone: definition.scope === 'HEADER' ? 'HEADER_FORM' : 'LINE_GRID',
        uiOrder: (index + 1) * 10,
        width: 120,
        userLabel: definition.displayLabel,
        settingRevision: 0
      };
      const selectedByProjection = selected.has(definition.fieldId) || selected.has(definition.projectionFieldId);
      current.enabled = definition.systemRequired || selectedByProjection;
      settingById.set(definition.fieldId, current);
    });
    registry.settings = await updateVoucherFieldSettings({
      companyId: state.companyId,
      voucherMode,
      settings: [...settingById.values()],
      actor: state.actorId,
      definitions: registry.catalog
    });
  }));
}

async function refreshAllReferencesFromToolbar() {
  if (state.busy) return;
  const focused = document.activeElement;
  const focusId = focused?.id || '';
  const selectionStart = typeof focused?.selectionStart === 'number' ? focused.selectionStart : null;
  const selectionEnd = typeof focused?.selectionEnd === 'number' ? focused.selectionEnd : null;
  const retainedGridSearch = $('gridSearchInput').value;
  state.busy = true;
  setActiveActivity('기준정보 전체 새로고침');
  renderReferenceControls();
  setAppStatus('상품·거래처·창고·담당자·프로젝트·필드명을 한 번에 새로고침하고 있습니다.');
  try {
    const result = await refreshAllReferenceData({ companyId: state.companyId });
    const rowsByDomain = Object.fromEntries(['product', 'customer', 'warehouse', 'employee', 'project', 'fieldDefinition']
      .map(domain => [domain, result.entities.filter(row => row.domain === domain).map(row => row.value)]));
    ['product', 'customer'].forEach(domain => {
      const metadata = result.generation.domains[domain];
      ingestLatestReference(domain, {
        cacheSchemaVersion: REFERENCE_CACHE_SCHEMA,
        domain,
        status: metadata.status,
        source: 'MANUAL_FULL_REFRESH',
        fallback: false,
        revision: metadata.ownerRevision,
        snapshotId: result.generation.generationId,
        contentHash: metadata.contentHash,
        count: metadata.count,
        checkedAt: result.generation.activatedAt,
        snapshotCreatedAt: result.generation.completedAt,
        rows: rowsByDomain[domain]
      }, { allowCurrent: true });
    });
    state.warehouseCatalog = { warehouses: rowsByDomain.warehouse, aliases: [], revision: result.generation.domains.warehouse.ownerRevision };
    renderWarehouseOptions();
    $('gridSearchInput').value = retainedGridSearch;
    state.gridSearch = retainedGridSearch;
    renderRows({ restoreFocus: false });
    if (focusId) {
      const target = $(focusId);
      target?.focus();
      if (target && selectionStart !== null && typeof target.setSelectionRange === 'function') {
        target.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
      }
    }
    setAppStatus(`기준정보 전체 새로고침 완료 · ${result.generation.generationId}`, 'normal');
    toast('전체 기준정보를 갱신하고 현재 검색어로 다시 검색했습니다.', 'success');
  } catch (error) {
    setAppStatus('전체 새로고침에 실패했습니다. 기존 기준정보와 입력 내용은 그대로 유지됩니다.', 'warn');
    toast(error.message || '전체 기준정보를 새로고침하지 못했습니다.', 'error');
  } finally {
    state.busy = false;
    setActiveActivity('');
    renderReferenceControls();
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

$('allReferenceReload').addEventListener('click', () => { void refreshAllReferencesFromToolbar(); });
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
$('sourceSheetRows').addEventListener('click', event => {
  const button = event.target.closest('[data-use-header-row]');
  const existing = inputMappingSession();
  if (!button || !existing) return;
  const headerRowIndex = Number(button.dataset.useHeaderRow);
  if (!Number.isInteger(headerRowIndex) || headerRowIndex === existing.headerRowIndex) return;
  captureGridPasteUndo();
  let reassigned = reassignHeaderRow(existing, headerRowIndex, state.inputTemplates, inputMappingTargets());
  reassigned.batchId = existing.batchId;
  reassigned.purchaseMetaRows = existing.purchaseMetaRows || null;
  reassigned.salesMetaRows = existing.salesMetaRows || null;
  modeDraft().inputMapping = reassigned;
  state.selectedRowIds.clear();
  projectInputMappingToVoucherRows({ preserveProductEdits: false });
  renderMode();
  saveDraftNow();
  toast(`${headerRowIndex + 1}행을 필드명으로 사용합니다. 원본 행·열·값은 변경하지 않았습니다.`, 'success');
});
$('mappingTableHeaders').addEventListener('click', event => {
  const button = event.target.closest('[data-open-field-mapping]');
  if (button) openFieldMappingDialog(Number(button.dataset.openFieldMapping));
});
$('mappingTableHeaders').addEventListener('change', event => {
  if (event.target.id !== 'mappingSelectAllRows') return;
  const ids = visibleMappingRows().map(row => row.rowId);
  state.selectedRowIds = event.target.checked ? new Set(ids) : new Set();
  renderRows({ restoreFocus: false });
});
$('mappingInputRows').addEventListener('input', event => {
  const input = event.target.closest('[data-mapping-cell]');
  const tr = event.target.closest('[data-mapping-row-id]');
  if (!input || !tr) return;
  invalidateGridPasteUndo();
  if (tr.dataset.mappingDefaultRow === 'true') {
    if (!state.sourceComposing) materializeMappingDefaultRow(input);
    return;
  }
  try {
    modeDraft().inputMapping = updateWorkingCell(inputMappingSession(), tr.dataset.mappingRowId, Number(input.dataset.mappingColumn), input.value);
    modeUi().activeCellId = `${tr.dataset.mappingRowId}|mapping:${input.dataset.mappingColumn}`;
    scheduleMappingProjection();
  } catch (error) {
    toast(error.message || '셀 값을 반영하지 못했습니다.', 'error');
  }
});
$('mappingInputRows').addEventListener('compositionstart', () => { state.sourceComposing = true; });
$('mappingInputRows').addEventListener('compositionend', event => {
  state.sourceComposing = false;
  const input = event.target.closest('[data-mapping-cell]');
  if (input) materializeMappingDefaultRow(input);
});
$('mappingInputRows').addEventListener('change', event => {
  const selector = event.target.closest('[data-mapping-select-row]');
  if (!selector || !selector.dataset.mappingSelectRow) return;
  if (selector.checked) state.selectedRowIds.add(selector.dataset.mappingSelectRow);
  else state.selectedRowIds.delete(selector.dataset.mappingSelectRow);
  $('deleteSelectedRows').disabled = state.selectedRowIds.size === 0;
  const all = $('mappingSelectAllRows');
  const count = visibleMappingRows().length;
  if (all) {
    all.checked = Boolean(count && state.selectedRowIds.size === count);
    all.indeterminate = state.selectedRowIds.size > 0 && state.selectedRowIds.size < count;
  }
});
$('mappingInputRows').addEventListener('keydown', event => {
  const input = event.target.closest('[data-mapping-cell]');
  const tr = event.target.closest('[data-mapping-row-id]');
  if (!input || !tr || event.isComposing || !['Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  if (event.key === 'Tab') {
    const visible = mappingVisibleColumns();
    const atBoundary = event.shiftKey
      ? tr.dataset.mappingRowId === (inputMappingSession()?.workingRows?.[0]?.rowId || MAPPING_DEFAULT_ROW_ID) && Number(input.dataset.mappingColumn) === visible[0]
      : tr.dataset.mappingDefaultRow === 'true' && Number(input.dataset.mappingColumn) === visible.at(-1);
    if (atBoundary) return;
  }
  event.preventDefault();
  const rowId = tr.dataset.mappingRowId;
  const columnIndex = Number(input.dataset.mappingColumn);
  if (tr.dataset.mappingDefaultRow === 'true' && hasEnteredValue(input.value)) {
    const row = materializeMappingDefaultRow(input);
    if (row) moveMappingFocus(row.rowId, columnIndex, event.key, event.shiftKey);
    return;
  }
  moveMappingFocus(rowId, columnIndex, event.key, event.shiftKey);
});
$('mappingInputRows').addEventListener('focusin', event => {
  const input = event.target.closest('[data-mapping-cell]');
  const tr = event.target.closest('[data-mapping-row-id]');
  if (!input || !tr) return;
  modeUi().activeCellId = `${tr.dataset.mappingRowId}|mapping:${input.dataset.mappingColumn}`;
  input.select?.();
  revealGridInput(input);
});
$('mappingInputRows').addEventListener('paste', event => {
  const input = event.target.closest('[data-mapping-cell]');
  const tr = event.target.closest('[data-mapping-row-id]');
  const text = event.clipboardData?.getData('text/plain');
  if (!input || !tr || !text) return;
  event.preventDefault();
  event.stopPropagation();
  applyMappingGridPaste(text, tr.dataset.mappingRowId);
});
$('inputTemplateSaveButton').addEventListener('click', openInputTemplateSaveDialog);
$('inputTemplateReloadButton').addEventListener('click', () => { void reloadInputTemplates({ applyCurrent: true }); });
$('pendingPasteToSourceButton').addEventListener('click', usePendingPasteAsSource);
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
  const mapping = inputMappingSession();
  if (mapping) {
    mapping.hiddenColumns = [];
    mapping.updatedAt = new Date().toISOString();
    renderRows({ restoreFocus: false });
    scheduleSave();
    return;
  }
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
  if (inputMappingSession()) {
    mappingCell(MAPPING_DEFAULT_ROW_ID, mappingVisibleColumns()[0])?.focus();
    return;
  }
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
function officialVoucherDateInputValue(header, value) {
  const entered = String(value || '').trim();
  const monthOf = candidate => String(candidate || '').trim().match(/^(\d{4}-(?:0[1-9]|1[0-2]))(?:-\d{2})?$/)?.[1] || '';
  const monthAnchor = monthOf(entered) || monthOf(header.voucherDateMonthAnchor) || monthOf(header.voucherDate);
  if (!entered && monthAnchor) return `${monthAnchor}-01`;
  return entered;
}

$('deliveryDateInput').addEventListener('input', event => {
  const header = modeDraft().header;
  if (state.draft.activeMode === 'purchase' || state.draft.activeMode === 'sale') {
    const dateValue = officialVoucherDateInputValue(header, event.target.value);
    const monthAnchor = dateValue.match(/^(\d{4}-\d{2})-\d{2}$/)?.[1] || '';
    if (monthAnchor) header.voucherDateMonthAnchor = monthAnchor;
    event.target.value = dateValue;
    header.voucherDate = dateValue;
    header.deliveryDate = dateValue;
  } else if (state.draft.activeMode === 'order') {
    header.orderDate = event.target.value;
    header.voucherDate = event.target.value;
    header.deliveryDate ||= event.target.value;
  } else {
    header.deliveryDate = event.target.value;
  }
  modeDraft().header.manualDeliveryOverride = true;
  updateDeliveryPolicy();
  state.voucherActivity.status = 'IDLE';
  renderVoucherContext();
  scheduleSave();
});
$('warehouseInput').addEventListener('input', applyWarehouseMatch);
$('warehouseInput').addEventListener('change', applyWarehouseMatch);
$('transactionTypeInput').addEventListener('change', event => { modeDraft().header.transactionType = event.target.value; renderVoucherContext(); scheduleSave(); });
$('completeButton').addEventListener('click', completeOrder);
$('saveEstimateAsButton').addEventListener('click', () => openEstimateSaveDialog({ saveAs: true }));
$('restoreAutosaveButton').addEventListener('click', restoreLatestAutosave);
$('estimateNoticeButton').addEventListener('click', shareCurrentVoucher);
$('estimateExcelButton').addEventListener('click', exportCurrentVoucherExcel);
$('selectedEstimateDeleteButton').addEventListener('click', () => {
  void deleteSelectedEstimates();
});
$('estimateRenameButton').addEventListener('click', openSelectedEstimateRenameDialog);
$('estimateCreateButton').addEventListener('click', () => {
  if (estimateCreationActive()) void completeOrder();
});
$('estimateMultiSelectButton').addEventListener('click', () => {
  if (estimateMultiSelectActive()) cancelEstimateMultiSelect();
  else beginEstimateMultiSelect();
});
function selectEstimateLibraryKind(kind) {
  if (!['individual', 'linked'].includes(kind) || estimateMultiSelectActive() || state.estimateLibraryKind === kind) return;
  rememberActiveEstimateWork();
  const returnDraft = state.estimateSelectionReturnDraft;
  state.noticeEstimateIds = [];
  state.estimateSelectionReturnDraft = null;
  if (returnDraft) state.draft.modes.estimate = contract.normalizeModeDraft('estimate', returnDraft);
  state.estimateLibraryKind = kind;
  saveDraftNow();
  renderMode();
}
$('estimateLibraryIndividualButton').addEventListener('click', () => selectEstimateLibraryKind('individual'));
$('estimateLibraryLinkedButton').addEventListener('click', () => selectEstimateLibraryKind('linked'));

function handleEstimateCardSelection(event) {
  if (state.estimateDragSuppressed) return;
  if (event.target.closest('[data-estimate-drag-handle]')) return;
  const card = event.target.closest('.estimate-card[data-estimate-id]');
  if (!card) return;
  const record = state.estimates.find(item => item.estimateId === card.dataset.estimateId);
  if (!record) return;
  const additive = event.ctrlKey || event.metaKey;
  if (additive) event.preventDefault();
  state.estimateSelectionQueue = state.estimateSelectionQueue.then(() => {
      if (additive && !estimateMultiSelectActive()) beginEstimateMultiSelect({ deferPreview: true });
      const creation = estimateCreation();
      if (creation) {
        const selected = new Set(creation.selectedIds);
        if (selected.has(record.estimateId)) selected.delete(record.estimateId);
        else selected.add(record.estimateId);
        creation.selectedIds = individualEstimateRecords().filter(item => selected.has(item.estimateId)).map(item => item.estimateId);
        state.noticeEstimateIds = [...creation.selectedIds];
        previewEstimateCreation();
        return;
      }
      if (state.estimateMultiSelectKind === state.estimateLibraryKind) {
        const selected = new Set(state.noticeEstimateIds);
        if (selected.has(record.estimateId)) selected.delete(record.estimateId);
        else selected.add(record.estimateId);
        state.noticeEstimateIds = estimateRecordsForKind().filter(item => selected.has(item.estimateId)).map(item => item.estimateId);
        renderCatalogControls();
        renderDelivery();
        return;
      }
      rememberActiveEstimateWork();
      state.lastEstimateSave = null;
      state.noticeEstimateIds = [record.estimateId];
      loadCatalogRecord(record, { preserveSelection: true });
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
$('voucherActivityReload').addEventListener('click', () => { void loadVoucherActivity({ force: true }); });
$('voucherActivitySourceMode').addEventListener('change', event => {
  state.voucherActivity.sourceMode = event.target.value;
  state.voucherActivity.status = 'IDLE';
  void loadVoucherActivity({ force: true });
});
$('voucherContextList').addEventListener('click', event => {
  const button = event.target.closest('[data-import-related-voucher]');
  if (button) importRelatedVoucher(button.dataset.importRelatedVoucher);
});
$('voucherActivityOpenAll').addEventListener('click', event => {
  const href = event.currentTarget.dataset.href;
  if (href) window.location.href = href;
});
$('relatedCollapseButton').addEventListener('click', event => {
  setRelatedPanelOpen(!state.draft.ui.relatedOpen);
});
$('relatedPanelToggle').addEventListener('click', () => setRelatedPanelOpen(!state.draft.ui.relatedOpen));
$('relatedPanelCloseButton').addEventListener('click', () => setRelatedPanelOpen(false));
const relatedPanelResizer = $('relatedPanelResizer');
relatedPanelResizer.addEventListener('pointerdown', event => {
  if (window.innerWidth <= 820) return;
  event.preventDefault();
  relatedPanelResizer.setPointerCapture(event.pointerId);
  document.body.classList.add('related-panel-resizing');
});
relatedPanelResizer.addEventListener('pointermove', event => {
  if (!relatedPanelResizer.hasPointerCapture(event.pointerId)) return;
  applyRelatedPanelWidth(window.innerWidth - event.clientX);
});
const finishRelatedPanelResize = event => {
  if (relatedPanelResizer.hasPointerCapture(event.pointerId)) relatedPanelResizer.releasePointerCapture(event.pointerId);
  document.body.classList.remove('related-panel-resizing');
  scheduleSave();
};
relatedPanelResizer.addEventListener('pointerup', finishRelatedPanelResize);
relatedPanelResizer.addEventListener('pointercancel', finishRelatedPanelResize);
relatedPanelResizer.addEventListener('keydown', event => {
  if (window.innerWidth <= 820 || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const step = event.shiftKey ? 40 : 12;
  applyRelatedPanelWidth(Number(state.draft.ui.relatedPaneWidth || 260) + (event.key === 'ArrowLeft' ? step : -step));
  scheduleSave();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !estimateCreationActive() || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  cancelEstimateCreation();
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
    if (row.fieldValues?.[customInput.dataset.customRowField]) {
      row.fieldValues[customInput.dataset.customRowField] = {
        ...row.fieldValues[customInput.dataset.customRowField],
        currentDisplayValue: customInput.value,
        parsedValue: customInput.value,
        edited: true
      };
    }
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
  let row = contract.markProductEdit(modeDraft().rows[index], field, input.value);
  row = markMappedFieldEdited(row, field, input.value);
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
$('applyBulkUnitPriceButton').addEventListener('click', applySelectedRowsUnitPrice);

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
  const pastedText = event.clipboardData?.getData('text/plain') || '';
  if (parserCard.contains(event.target) && clipboardTableMatrix(pastedText)) {
    event.preventDefault();
    useClipboardTableAsSource(pastedText);
    return;
  }
  const image = [...(event.clipboardData?.items || [])]
    .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map(item => item.getAsFile())
    .find(Boolean);
  if (image) {
    event.preventDefault();
    recognizeImage(image);
    return;
  }
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
  window.requestAnimationFrame(() => window.requestAnimationFrame(applyRelatedPanelState));
  window.setTimeout(applyRelatedPanelState, 120);
}, { passive: true });
const appBarResizeObserver = 'ResizeObserver' in window
  ? new ResizeObserver(() => window.requestAnimationFrame(applyRelatedPanelState))
  : null;
if (appBarResizeObserver) {
  appBarResizeObserver.observe(document.querySelector('.app-bar'));
  const globalHeader = document.querySelector('.nexus-ui-header');
  if (globalHeader) appBarResizeObserver.observe(globalHeader);
}

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
