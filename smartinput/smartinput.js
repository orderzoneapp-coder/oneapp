import {
  captureTextIntake,
  analyzeSingleOrderDocument,
  rematchExtractedLinesForCustomer
} from '../orderq/intake-engine.js?v=0.12.3';
import { extractOrderProductLines } from '../orderq/smartparser/order-text-extractor.js?v=0.1.0';
import { createOrder } from '../orderq/order-intake-engine.js?v=0.15.2';
import { syncAfterLocalMutation } from '../orderq/orderq-sync-engine.js?v=0.8.0';
import { STORE, getAll } from '../orderq/orderq-db.js?v=0.12.1';
import { createLiveCustomer, ensureCustomerMasterReady } from '../orderq/customer-master.js?v=0.12.1';
import { loadProductCatalog, searchProductCatalog } from '../orderq/product-master-search.js?v=0.8.1';
import { loadWarehouseCatalog, matchWarehouseInput, warehouseDisplayName } from '../orderq/warehouse-master.js?v=0.8.0';
import { recognizeOcrDocument, verifiedRowsToParserLines } from './ocr-document-parser.js?v=0.1.0';
import {
  createRecordId,
  loadSmartInputData,
  normalizeAliasName,
  deleteEstimate,
  saveAliasMapping,
  saveEstimate,
  saveLinkGroup,
  saveSettings,
  saveTemporaryCustomer
} from './smartinput-data-store.js?v=0.2.0';

const contract = window.SMART_INPUT_CONTRACT;
if (!contract) throw new Error('SMART_INPUT_CONTRACT_NOT_LOADED');

const $ = id => document.getElementById(id);
const tabs = [...document.querySelectorAll('[data-mode]')];
const methodButtons = [...document.querySelectorAll('[data-method]')];
const sourceTextInput = $('sourceTextInput');
const inputRows = $('inputRows');
const state = {
  draft: loadDraft(),
  customers: [],
  products: [],
  catalogStatus: 'LOADING',
  catalogSummary: { commonCount: 0, orderQCount: 0, errors: [] },
  warehouseCatalog: { warehouses: [], aliases: [] },
  settings: contract.normalizeSettings(),
  linkGroups: [],
  temporaryCustomers: [],
  aliasMappings: [],
  estimates: [],
  smartDataReady: false,
  pendingImageEvidence: null,
  pendingOcrReview: null,
  pendingSourceName: '',
  saveTimer: null,
  draftDirty: false,
  toastTimer: null,
  recognition: null,
  listening: false,
  busy: false,
  activeActivity: '',
  autoAnalyzeTimer: null,
  analysisRequestId: 0,
  sourceComposing: false
};

const ACTIVITY_LABELS = {
  direct: '직접입력',
  excel: 'Excel·파일',
  text: '텍스트',
  paste: 'Ctrl+V',
  photo: '사진 OCR',
  voice: '음성 STT'
};

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

function loadDraftList() {
  try {
    const rows = JSON.parse(localStorage.getItem(contract.DRAFT_LIST_STORAGE_KEY) || '[]');
    return Array.isArray(rows) ? rows.filter(hasMeaningfulDraftContent) : [];
  } catch (_) {
    return [];
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

function saveModeDraftSnapshot() {
  const current = modeDraft();
  if (!current?.documentId) return;
  const previous = loadDraftList();
  if (!hasMeaningfulDraftContent(current)) {
    const next = previous.filter(item => item.documentId !== current.documentId);
    if (next.length !== previous.length) localStorage.setItem(contract.DRAFT_LIST_STORAGE_KEY, JSON.stringify(next));
    return;
  }
  const snapshot = JSON.parse(JSON.stringify({ ...current, mode: state.draft.activeMode, parentDraftId: state.draft.draftId }));
  const next = [snapshot, ...previous.filter(item => item.documentId !== current.documentId)]
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, 30);
  localStorage.setItem(contract.DRAFT_LIST_STORAGE_KEY, JSON.stringify(next));
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
  $('appStatus').querySelector('span:last-child').textContent = message;
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

function saveDraftNow() {
  clearTimeout(state.saveTimer);
  state.draft.updatedAt = new Date().toISOString();
  modeDraft().updatedAt = state.draft.updatedAt;
  try {
    localStorage.setItem(contract.DRAFT_STORAGE_KEY, JSON.stringify(state.draft));
    saveModeDraftSnapshot();
    state.draftDirty = false;
    setSaveState('저장됨', 'saved');
  } catch (_) {
    setSaveState('저장 실패', 'error');
    setAppStatus('초안을 저장하지 못했습니다. 입력 내용은 현재 화면에 유지됩니다.', 'warn');
  }
}

function scheduleSave() {
  state.draftDirty = true;
  setSaveState('저장 중…', 'saving');
  clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(saveDraftNow, 160);
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

function layoutDefinitions(scope, customFields = state.settings.customFields || []) {
  const builtIn = scope === 'header' ? contract.HEADER_FIELD_DEFINITIONS : contract.VOUCHER_COLUMN_DEFINITIONS;
  return [
    ...builtIn,
    ...customFields.filter(field => field.scope === scope).map(field => ({ ...field, custom: true, required: false }))
  ];
}

function renderCustomLayoutFields() {
  document.querySelectorAll('[data-custom-header-field]').forEach(element => element.remove());
  const referenceStatus = $('referenceStatus');
  customFieldsFor('header').forEach(field => {
    const label = document.createElement('label');
    label.className = 'field field--custom';
    label.dataset.headerField = field.id;
    label.dataset.customHeaderField = field.id;
    label.innerHTML = `<span>${esc(field.label)} <em>사용자지정</em></span><input type="text" data-custom-header-input="${esc(field.id)}" value="${esc(modeDraft().header.customValues?.[field.id] || '')}"><small>주문서별 사용자 입력 항목</small>`;
    referenceStatus.before(label);
  });

  const table = document.querySelector('#tableScroll table');
  table.querySelectorAll('[data-custom-column]').forEach(element => element.remove());
  const actionCol = table.querySelector('colgroup col:last-child');
  const actionHead = table.querySelector('thead th:last-child');
  const actionFoot = table.querySelector('tfoot td:last-child');
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
}

function applyFormLayout() {
  renderCustomLayoutFields();
  const headerFields = new Set(state.settings.headerFields || contract.DEFAULT_SETTINGS.headerFields);
  document.querySelectorAll('[data-header-field]').forEach(element => {
    element.hidden = !headerFields.has(element.dataset.headerField);
  });
  const voucherColumns = new Set(state.settings.voucherColumns || contract.DEFAULT_SETTINGS.voucherColumns);
  document.querySelectorAll('[data-column]').forEach(element => {
    element.classList.toggle('is-column-hidden', !voucherColumns.has(element.dataset.column));
  });
  const visibleColumns = layoutDefinitions('voucher').filter(column => voucherColumns.has(column.id)).length;
  const table = document.querySelector('#tableScroll table');
  table?.style.setProperty('--table-min-width', `${Math.max(520, visibleColumns * 94 + 34)}px`);
  inputRows.querySelector('.empty-row td')?.setAttribute('colspan', String(visibleColumns + 1));
}

function updateMethod(method, { persist = true } = {}) {
  const selected = contract.INPUT_METHODS.find(item => item.id === method) || contract.INPUT_METHODS[2];
  const changed = modeDraft().activeMethod !== selected.id;
  modeDraft().activeMethod = selected.id;
  methodButtons.forEach(button => button.classList.toggle('is-active', button.dataset.method === selected.id));
  if (persist && changed) scheduleSave();
  return selected;
}

function activityLabel(method) {
  return ACTIVITY_LABELS[method] || contract.INPUT_METHODS.find(item => item.id === method)?.label || '입력';
}

function renderActivityTrail() {
  const batches = modeDraft().batches || [];
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

function groupForCustomer(customerId) {
  return state.linkGroups.find(group => group.status !== 'INACTIVE' && group.memberCustomerIds?.includes(customerId)) || null;
}

function customerById(customerId) {
  return state.customers.find(customer => customer.customerId === customerId) || null;
}

function applyCustomerRelationship(header = modeDraft().header) {
  const group = groupForCustomer(header.customerId);
  const taxCustomer = group?.taxCustomerId ? customerById(group.taxCustomerId) : null;
  header.customerLinkGroupId = group?.linkGroupId || '';
  header.taxCustomerId = taxCustomer?.customerId || '';
  header.taxCustomerName = customerName(taxCustomer);
  header.isTemporaryCustomer = Boolean(temporaryMeta(header.customerId));
  $('taxCustomerInput').value = header.taxCustomerName;
  $('customerRelationHint').textContent = group
    ? (taxCustomer ? `연결 ${group.memberCustomerIds.length}곳 · 세무 1개 지정` : `연결 ${group.memberCustomerIds.length}곳 · 세무 거래처 지정 필요`)
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
  header.customerName = customerName(customer);
  header.customerMappingSource = mappingSource;
  $('customerInput').value = header.customerName;
  $('customerInput').dataset.customerId = header.customerId;
  $('customerHint').textContent = `${customerCode(customer) || (temporaryMeta(header.customerId) ? '임시 배송처' : '등록 거래처')} · ${mappingSource === 'CONFIRMED_ALIAS' ? '주문자명 자동 지정' : '마스터 연결됨'}`;
  applyCustomerRelationship(header);
  updateDeliveryPolicy();
  scheduleSave();
  if (learnAlias && header.rawOrdererName) {
    void confirmCustomerAlias(header.rawOrdererName, customer, currentSourceType())
      .then(() => { $('customerHint').textContent = `${customerCode(customer) || '등록 거래처'} · 다음 동일 주문자명 자동 지정`; saveDraftNow(); })
      .catch(() => toast('거래처는 선택했지만 주문자명 매핑은 저장하지 못했습니다.', 'error'));
  }
  if (rematch && state.draft.activeMode === 'order' && modeDraft().rows.length) rematchRowsForCustomer(customer);
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

function currentSourceType() {
  const batches = modeDraft().batches;
  return batches[batches.length - 1]?.sourceType
    || contract.INPUT_METHODS.find(method => method.id === modeDraft().activeMethod)?.sourceType
    || 'GENERAL_TEXT';
}

async function refreshCustomers({ syncIfEmpty = true } = {}) {
  let customers = (await withTimeout(getAll(STORE.CUSTOMERS), 3500, '로컬 거래처 목록을 불러오는 데 시간이 걸리고 있습니다.'))
    .filter(customer => (customer.status || 'ACTIVE') === 'ACTIVE');
  if (!customers.length && syncIfEmpty) {
    await withTimeout(ensureCustomerMasterReady(), 7000, '거래처 마스터 동기화가 지연되고 있습니다.');
    customers = (await withTimeout(getAll(STORE.CUSTOMERS), 3500, '동기화된 거래처 목록을 불러오지 못했습니다.'))
      .filter(customer => (customer.status || 'ACTIVE') === 'ACTIVE');
  }
  if (customers.length) state.customers = customers;
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
        const customer = await createLiveCustomer({
          customerName: customerNameValue,
          businessNumber: String(form.get('businessNumber') || '').trim(),
          representativeName: String(form.get('representativeName') || '').trim(),
          address: String(form.get('address') || '').trim(),
          contactPhone: String(form.get('contactPhone') || '').trim(),
          memo: temporary ? `임시 배송처 · ${String(form.get('warehouseName') || '').trim()}` : '세무 거래처'
        }, { source: temporary ? 'SMART_INPUT_TEMPORARY_DELIVERY' : 'SMART_INPUT_TAX_CUSTOMER' });
        if (temporary) {
          const metadata = {
            customerId: customer.customerId,
            warehouseName: String(form.get('warehouseName') || '').trim(),
            address: String(form.get('address') || '').trim(),
            contact: String(form.get('contactPhone') || '').trim(),
            linkGroupId: '',
            status: 'TEMPORARY',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
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
        <div class="smart-dialog__toolbar"><button type="button" class="button button--quiet" data-link-mode>거래처 연결</button><button type="button" class="button button--quiet" data-temp-create>임시 배송처</button></div>
        <label class="smart-dialog__search">거래처명 또는 코드<input type="search" value="${esc($('customerInput').value)}" autocomplete="off"></label>
        <div class="smart-dialog__message">거래처 앞 체크박스를 선택한 뒤 용도를 지정하세요.</div>
        <div class="smart-customer-results"></div>
        <footer class="smart-customer-action-footer"><span data-customer-selection>선택된 거래처가 없습니다.</span><button type="button" class="button button--quiet" data-customer-use>배송 거래처 선택</button><button type="button" class="button button--primary" data-tax-register>세무 거래처 등록</button></footer>
        <footer class="smart-link-footer" hidden><span>연결할 거래처를 2개 이상 체크하세요.</span><button type="button" class="button button--quiet" data-link-cancel>취소</button><button type="button" class="button button--primary" data-link-save>연결 저장</button></footer>
      </div>`;
      document.body.append(dialog);
      const input = dialog.querySelector('input[type="search"]');
      const results = dialog.querySelector('.smart-customer-results');
      const message = dialog.querySelector('.smart-dialog__message');
      const actionFooter = dialog.querySelector('.smart-customer-action-footer');
      const linkFooter = dialog.querySelector('.smart-link-footer');
      const selectionText = dialog.querySelector('[data-customer-selection]');
      const selected = new Set();
      let linkMode = false;
      let customerLoading = !state.customers.length;
      let visibleCustomers = [];
      const finish = value => {
        resolve(value || null);
        dialog.close();
        dialog.remove();
      };
      const render = () => {
        const query = input.value.trim();
        visibleCustomers = [...state.customers]
          .filter(customerItem => !query || normalizedKey(customerSearchText(customerItem)).includes(normalizedKey(query)))
            .sort((left, right) => customerName(left).localeCompare(customerName(right), 'ko'))
            .slice(0, 80);
        results.innerHTML = visibleCustomers.map(customerItem => {
          const group = groupForCustomer(customerItem.customerId);
          const isTax = group?.taxCustomerId === customerItem.customerId;
          const isTemporary = Boolean(temporaryMeta(customerItem.customerId));
          return `<article class="smart-customer-row ${selected.has(customerItem.customerId) ? 'is-selected' : ''}" data-customer-id="${esc(customerItem.customerId)}">
            <label class="smart-customer-check"><input type="checkbox" ${selected.has(customerItem.customerId) ? 'checked' : ''}><span class="sr-only">${esc(customerName(customerItem))} 선택</span></label>
            <div class="smart-customer-select"><strong>${esc(customerName(customerItem))}</strong><span>${esc(customerCode(customerItem) || customerItem.businessNumber || '')}</span><small>${esc(customerItem.address || temporaryMeta(customerItem.customerId)?.warehouseName || '')}</small></div>
            <div class="smart-customer-badges">${isTemporary ? '<span class="is-temp">임시 배송처</span>' : ''}${group ? `<span>연결 ${group.memberCustomerIds.length}</span>` : ''}${isTax ? '<span class="is-tax">세무</span>' : ''}</div>
          </article>`;
        }).join('') || '<div class="smart-dialog__empty">일치하는 거래처가 없습니다.</div>';
        results.querySelectorAll('.smart-customer-row').forEach(row => {
          const customerId = row.dataset.customerId;
          row.querySelector('input[type="checkbox"]')?.addEventListener('change', event => {
            if (!linkMode) selected.clear();
            if (event.target.checked) selected.add(customerId);
            else selected.delete(customerId);
            render();
          });
        });
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
          ? `${selected.size}개 선택 · 연결할 거래처를 2개 이상 체크하세요.`
          : (customerLoading && !visibleCustomers.length
            ? '거래처 목록을 불러오는 중입니다. 창은 그대로 두고 잠시 기다려 주세요.'
            : `${visibleCustomers.length}개 거래처 · 한 곳만 체크할 수 있습니다.`);
      };
      const setLinkMode = value => {
        linkMode = value;
        selected.clear();
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
          ? { ...group, taxCustomerId: customerId, status: 'CONFIRMED', revision: Number(group.revision || 0) + 1, updatedAt: timestamp }
          : {
              linkGroupId: createRecordId('SILINK'),
              memberCustomerIds: [customerId],
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
        if (selected.size < 2) {
          message.textContent = '연결할 거래처를 2개 이상 선택하세요.';
          return;
        }
        const groupIds = [...new Set([...selected].map(id => groupForCustomer(id)?.linkGroupId).filter(Boolean))];
        if (groupIds.length > 1) {
          message.textContent = '서로 다른 연결 그룹은 한 번에 합칠 수 없습니다. 그룹별로 처리하세요.';
          return;
        }
        const existing = groupIds.length ? state.linkGroups.find(group => group.linkGroupId === groupIds[0]) : null;
        const memberCustomerIds = [...new Set([...(existing?.memberCustomerIds || []), ...selected])];
        const timestamp = new Date().toISOString();
        const group = {
          linkGroupId: existing?.linkGroupId || createRecordId('SILINK'),
          memberCustomerIds,
          taxCustomerId: existing?.taxCustomerId && memberCustomerIds.includes(existing.taxCustomerId) ? existing.taxCustomerId : '',
          status: existing?.taxCustomerId ? 'CONFIRMED' : 'PENDING',
          revision: Number(existing?.revision || 0) + 1,
          createdAt: existing?.createdAt || timestamp,
          updatedAt: timestamp,
          updatedBy: 'SMART_INPUT_ADMIN'
        };
        await persistLinkGroup(group);
        selected.clear();
        linkMode = false;
        actionFooter.hidden = false;
        linkFooter.hidden = true;
        await render();
        message.textContent = '연결을 저장했습니다. 연결된 거래처 중 세무 거래처 1개를 체크한 뒤 등록하세요.';
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
      void refreshCustomers({ syncIfEmpty: true })
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

function layoutChecks(name, definitions, selected = []) {
  const selectedSet = new Set(selected);
  return definitions.map(field => `<label class="layout-check"><input type="checkbox" name="${name}" value="${esc(field.id)}" ${selectedSet.has(field.id) || field.required ? 'checked' : ''} ${field.required ? 'disabled' : ''}><span>${esc(field.label)}</span>${field.required ? '<small>필수</small>' : (field.custom ? `<small>${esc(field.category === 'CUSTOM' ? '사용자지정' : field.category)}</small><button type="button" data-remove-custom-field="${esc(field.id)}" aria-label="${esc(field.label)} 삭제">×</button>` : '')}</label>`).join('');
}

function selectedLayoutFields(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value);
}

function openLayoutFieldDialog(scope, onAdd) {
  const isHeader = scope === 'header';
  const fieldDialog = document.createElement('dialog');
  fieldDialog.className = 'smart-dialog smart-field-dialog';
  const definitions = isHeader ? contract.HEADER_FIELD_DEFINITIONS : contract.VOUCHER_COLUMN_DEFINITIONS;
  const categoryDefinitions = isHeader
    ? {
        CUSTOMER: definitions.filter(field => ['customer', 'taxCustomer'].includes(field.id)),
        ORDER: definitions.filter(field => !['customer', 'taxCustomer'].includes(field.id))
      }
    : { PRODUCT: definitions };
  fieldDialog.innerHTML = `<form method="dialog" class="smart-dialog__shell">
    <header><div><small>Form Field Library</small><h2>${isHeader ? '상단 정보열' : '전표 열'} 항목 추가</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-form">
      <label><span>항목 분류</span><select name="category">${isHeader ? '<option value="CUSTOMER">거래처정보</option><option value="ORDER">주문정보</option>' : '<option value="PRODUCT">상품정보</option>'}<option value="CUSTOM">사용자지정</option></select></label>
      <label data-library-field><span>추가할 항목</span><select name="libraryField"></select></label>
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
    onAdd({
      id: `custom-${scope}-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`,
      label,
      scope,
      category: 'CUSTOM',
      sourceField: ''
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
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog smart-settings-dialog';
  dialog.innerHTML = `<form method="dialog" class="smart-dialog__shell">
    <header><div><small>SmartInput Preferences</small><h2>환경설정</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-settings-grid">
      <details class="settings-group" open>
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
        <summary><span><strong>주문서 상단 정보열</strong><small>거래처·배송일·창고 표시 설정</small></span><i aria-hidden="true"></i></summary>
        <div class="settings-group__body settings-group__body--single"><div class="settings-group__actions"><span>거래처정보 또는 사용자지정 항목을 추가할 수 있습니다.</span><button type="button" class="button button--quiet button--small" data-add-layout-field="header">항목 추가</button></div><div class="layout-check-grid" data-layout-fields="header"></div></div>
      </details>
      <details class="settings-group">
        <summary><span><strong>전표 표시 열</strong><small>품목·수량·단가 등 표 열 설정</small></span><i aria-hidden="true"></i></summary>
        <div class="settings-group__body settings-group__body--single"><div class="settings-group__actions"><span>상품정보 또는 사용자지정 열을 추가할 수 있습니다.</span><button type="button" class="button button--quiet button--small" data-add-layout-field="voucher">항목 추가</button></div><div class="layout-check-grid" data-layout-fields="voucher"></div></div>
      </details>
    </div>
    <p class="smart-dialog__message">선택 불가 날짜에는 사유와 다음 배송 가능일을 표시합니다.</p>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-save>설정 저장</button></footer>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const message = dialog.querySelector('.smart-dialog__message');
  const renderLayoutGroup = (scope, selected = null) => {
    const name = scope === 'header' ? 'headerFields' : 'voucherColumns';
    const previous = selected || (form.querySelector(`[data-layout-fields="${scope}"] input`)
      ? selectedLayoutFields(form, name)
      : state.settings[name]);
    form.querySelector(`[data-layout-fields="${scope}"]`).innerHTML = layoutChecks(name, layoutDefinitions(scope, workingCustomFields), previous);
  };
  renderLayoutGroup('header', state.settings.headerFields);
  renderLayoutGroup('voucher', state.settings.voucherColumns);
  dialog.querySelectorAll('[data-add-layout-field]').forEach(button => button.addEventListener('click', () => {
    const scope = button.dataset.addLayoutField;
    openLayoutFieldDialog(scope, field => {
      const name = scope === 'header' ? 'headerFields' : 'voucherColumns';
      const selected = selectedLayoutFields(form, name);
      if (!field.builtIn) workingCustomFields.push(field);
      renderLayoutGroup(scope, [...new Set([...selected, field.id])]);
    });
  }));
  dialog.querySelector('.smart-settings-grid').addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-custom-field]');
    if (!remove) return;
    event.preventDefault();
    const fieldId = remove.dataset.removeCustomField;
    const field = workingCustomFields.find(item => item.id === fieldId);
    if (!field) return;
    const name = field.scope === 'header' ? 'headerFields' : 'voucherColumns';
    const selected = selectedLayoutFields(form, name).filter(id => id !== fieldId);
    workingCustomFields = workingCustomFields.filter(item => item.id !== fieldId);
    renderLayoutGroup(field.scope, selected);
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
    const next = contract.normalizeSettings({
      ...state.settings,
      orderCutoffTime: form.elements.orderCutoffTime.value,
      allowSameDayDelivery: form.elements.allowSameDayDelivery.checked,
      defaultDeliveryWeekdays,
      deliveryCustomerWeekdays,
      holidayWeekdays: selectedWeekdays(form, 'holidayWeekdays'),
      holidayDates,
      headerFields: selectedLayoutFields(form, 'headerFields'),
      voucherColumns: selectedLayoutFields(form, 'voucherColumns'),
      customFields: workingCustomFields
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

function openDraftListDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog smart-draft-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Local Drafts</small><h2>최근 초안</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-dialog__message">최근 30개 초안을 이 기기에 보존합니다.</div>
    <div class="smart-draft-results"></div>
    <footer><button type="button" class="button button--quiet" data-close>닫기</button></footer>
  </div>`;
  document.body.append(dialog);
  const results = dialog.querySelector('.smart-draft-results');
  const render = () => {
    const drafts = loadDraftList();
    results.innerHTML = drafts.length ? drafts.map(item => `<article class="smart-draft-row" data-document-id="${esc(item.documentId)}">
      <button type="button" data-open-draft><strong>${esc(contract.MODES[item.mode]?.label || item.mode)} · ${esc(item.header?.customerName || '거래처 미확정')}</strong><span>${Number(item.rows?.length || 0)}행 · 원본 ${Number(item.batches?.length || 0)}차</span><small>${item.updatedAt ? new Date(item.updatedAt).toLocaleString('ko-KR') : ''}</small></button>
      <button type="button" class="row-remove" data-delete-draft aria-label="초안 삭제">×</button>
    </article>`).join('') : '<div class="smart-dialog__empty">저장된 초안이 없습니다.</div>';
    results.querySelectorAll('[data-document-id]').forEach(row => {
      const documentId = row.dataset.documentId;
      row.querySelector('[data-open-draft]').addEventListener('click', () => {
        const item = loadDraftList().find(draft => draft.documentId === documentId);
        if (!item || !contract.MODES[item.mode]) return;
        syncSourceText();
        state.draft.activeMode = item.mode;
        state.draft.modes[item.mode] = contract.normalizeModeDraft(item.mode, item);
        saveDraftNow();
        renderMode();
        dialog.close();
        dialog.remove();
      });
      row.querySelector('[data-delete-draft]').addEventListener('click', () => {
        const item = loadDraftList().find(draft => draft.documentId === documentId);
        if (!item || !window.confirm(`${item.header?.customerName || '거래처 미확정'} 초안을 삭제하시겠습니까? 원본 ${Number(item.batches?.length || 0)}차가 함께 삭제됩니다.`)) return;
        localStorage.setItem(contract.DRAFT_LIST_STORAGE_KEY, JSON.stringify(loadDraftList().filter(draft => draft.documentId !== documentId)));
        render();
      });
    });
  };
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.showModal();
  render();
}

function estimateTitle(record) {
  return record?.customerName || record?.draft?.header?.customerName || '거래처 미지정 견적';
}

function openEstimateListDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog smart-estimate-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Estimate Catalog</small><h2>견적 목록</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-dialog__message">저장된 견적서를 선택하면 현재 견적 입력화면으로 불러옵니다.</div>
    <div class="smart-estimate-results"></div>
    <footer><button type="button" class="button button--quiet" data-close>닫기</button></footer>
  </div>`;
  document.body.append(dialog);
  const results = dialog.querySelector('.smart-estimate-results');
  const render = () => {
    results.innerHTML = state.estimates.length ? state.estimates.map(item => `<article class="smart-draft-row" data-estimate-id="${esc(item.estimateId)}">
      <button type="button" data-open-estimate><strong>${esc(estimateTitle(item))}</strong><span>${Number(item.rowCount || item.draft?.rows?.length || 0)}품목 · ${Number(item.amount || 0).toLocaleString('ko-KR')}원</span><small>${item.updatedAt ? new Date(item.updatedAt).toLocaleString('ko-KR') : ''}</small></button>
      <button type="button" class="row-remove" data-delete-estimate aria-label="견적 삭제">×</button>
    </article>`).join('') : '<div class="smart-dialog__empty">저장된 견적서가 없습니다.</div>';
    results.querySelectorAll('[data-estimate-id]').forEach(row => {
      const estimateId = row.dataset.estimateId;
      row.querySelector('[data-open-estimate]').addEventListener('click', () => {
        const record = state.estimates.find(item => item.estimateId === estimateId);
        if (!record?.draft) return;
        syncSourceText();
        state.draft.activeMode = 'estimate';
        state.draft.modes.estimate = contract.normalizeModeDraft('estimate', { ...record.draft, catalogRecordId: record.estimateId });
        saveDraftNow();
        renderMode();
        dialog.close();
        dialog.remove();
        toast('견적서를 불러왔습니다.', 'success');
      });
      row.querySelector('[data-delete-estimate]').addEventListener('click', async () => {
        const record = state.estimates.find(item => item.estimateId === estimateId);
        if (!record || !window.confirm(`${estimateTitle(record)} 견적서를 삭제하시겠습니까?`)) return;
        await deleteEstimate(estimateId);
        state.estimates = state.estimates.filter(item => item.estimateId !== estimateId);
        render();
      });
    });
  };
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.showModal();
  render();
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
      return next;
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
  scheduleSave();
}

function hydrateHeader() {
  const header = modeDraft().header;
  $('customerInput').value = header.customerName;
  $('customerInput').dataset.customerId = header.customerId;
  $('deliveryDateInput').value = header.deliveryDate;
  $('warehouseInput').value = header.warehouseName;
  $('transactionTypeInput').value = header.transactionType || '기타';
  $('customerHint').textContent = header.customerId ? '등록 거래처 · 마스터 연결됨' : '거래처가 인식되지 않으면 이 입력란으로 이동합니다.';
  applyCustomerRelationship(header);
  updateDeliveryPolicy();
}

function renderRows({ restoreFocus = true } = {}) {
  const rows = modeDraft().rows;
  if (!rows.length) {
    inputRows.innerHTML = '<tr class="empty-row"><td colspan="11"><strong>아직 입력된 상품이 없습니다.</strong><span>원문을 분석하거나 빈 행을 추가해 시작하세요.</span></td></tr>';
    updateSummaries();
    applyFormLayout();
    renderSourceAnalysis();
    return;
  }
  inputRows.innerHTML = rows.map(row => {
    const amount = Number(row.quantity || 0) * Number(row.unitPrice || 0);
    const customCells = customFieldsFor('voucher').map(field => (
      `<td data-column="${esc(field.id)}"><input data-custom-row-field="${esc(field.id)}" value="${esc(row.customValues?.[field.id] || '')}" aria-label="${esc(field.label)}"></td>`
    )).join('');
    return `<tr data-row-id="${esc(row.rowId)}" data-status="${esc(row.matchStatus)}" class="${row.duplicatePossible ? 'is-duplicate' : ''}">
      <td data-column="itemCode"><input data-field="itemCode" type="search" enterkeyhint="search" value="${esc(row.itemCode)}" aria-label="품목코드" title="입력 후 Enter로 상품 검색"></td>
      <td data-column="itemName"><input data-field="itemName" type="search" enterkeyhint="search" value="${esc(row.itemName)}" aria-label="품목명" title="입력 후 Enter로 상품 검색"></td>
      <td data-column="specification"><input data-field="specification" value="${esc(row.specification)}" aria-label="규격"></td>
      <td data-column="quantity"><input data-field="quantity" type="number" step="any" value="${esc(row.quantity ?? '')}" aria-label="수량"></td>
      <td data-column="unit"><input data-field="unit" value="${esc(row.unit)}" aria-label="단위"></td>
      <td data-column="unitPrice"><input data-field="unitPrice" type="number" step="any" value="${esc(row.unitPrice ?? '')}" aria-label="단가"></td>
      <td data-column="supplyAmount"><input data-supply-amount value="${amount.toLocaleString('ko-KR')}" aria-label="공급가액" readonly tabindex="-1"></td>
      <td data-column="memo"><input data-field="memo" value="${esc(row.memo)}" aria-label="메모"></td>
      <td data-column="description"><input data-field="description" value="${esc(row.description)}" aria-label="적요(직원)"></td>
      <td data-column="noticePrice"><input data-field="noticePrice" type="number" step="any" value="${esc(row.noticePrice ?? 0)}" aria-label="공지단가"></td>
      ${customCells}
      <td><button type="button" class="row-remove" data-remove-row="${esc(row.rowId)}" aria-label="행 삭제">×</button></td>
    </tr>`;
  }).join('');
  updateSummaries();
  applyFormLayout();
  renderSourceAnalysis();
  window.requestAnimationFrame(() => {
    $('tableScroll').scrollTop = Number(modeUi().scrollTop || 0);
    $('tableScroll').scrollLeft = Number(modeUi().scrollLeft || 0);
    if (!restoreFocus) return;
    const active = modeUi().activeCellId;
    if (!active) return;
    const [rowId, field] = active.split('|');
    inputRows.querySelector(`[data-row-id="${CSS.escape(rowId)}"] [data-field="${CSS.escape(field)}"]`)?.focus({ preventScroll: true });
  });
}

function updateSummaries() {
  const summary = contract.summarizeRows(modeDraft().rows);
  $('gridRowCount').textContent = `${summary.total.toLocaleString('ko-KR')}행`;
  $('matchedCount').textContent = `일치 ${summary.matched.toLocaleString('ko-KR')}`;
  $('similarCount').textContent = `확인 ${summary.similar.toLocaleString('ko-KR')}`;
  $('failedCount').textContent = `미인식 ${summary.unresolved.toLocaleString('ko-KR')}`;
  $('duplicateCount').textContent = `중복 가능 ${summary.duplicate.toLocaleString('ko-KR')}`;
  $('totalQuantity').textContent = summary.quantity.toLocaleString('ko-KR');
  $('totalAmount').textContent = `${summary.amount.toLocaleString('ko-KR')}원`;
  renderActivityTrail();
}

function renderDelivery() {
  const isOrder = state.draft.activeMode === 'order';
  const isEstimate = state.draft.activeMode === 'estimate';
  const delivery = modeDraft().delivery;
  const lastDelivery = isOrder ? state.draft.ui.lastDelivery : null;
  $('deliveryTarget').textContent = isOrder ? '공통 주문서 원장' : (isEstimate ? '견적서 카탈로그' : `${contract.MODES[state.draft.activeMode].label} 전달 계약 준비 중`);
  $('deliveryDescription').textContent = isOrder
    ? 'ORDER Q vNext 저장소에 먼저 기록합니다.'
    : (isEstimate ? '견적 목록에 저장하고 다시 불러올 수 있습니다.' : '확정된 DataOps 연결만 이후 단계에서 활성화합니다.');
  const visibleDelivery = delivery.status === 'SAVED' ? delivery : lastDelivery;
  $('deliveryState').textContent = visibleDelivery
    ? `최근 ${visibleDelivery.orderNo || visibleDelivery.targetRecordId || '저장 완료'}${visibleDelivery.deliveredAt ? ` · ${new Date(visibleDelivery.deliveredAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : ''}`
    : '전달 전';
  document.querySelector('.delivery-state span').style.background = visibleDelivery ? '#5eead4' : '#fbbf24';
  $('completeButton').disabled = (!isOrder && !isEstimate) || state.busy;
  $('completeButton').textContent = isEstimate ? '견적서 저장' : '입력 완료';
  if (visibleDelivery?.targetRecordId) {
    document.querySelector('#orderLinks a:first-child').href = `../orderq/index.html?focus=${encodeURIComponent(visibleDelivery.targetRecordId)}&saved=1`;
  } else {
    document.querySelector('#orderLinks a:first-child').href = '../orderq/index.html';
  }
}

function renderMode() {
  const selected = contract.MODES[state.draft.activeMode];
  tabs.forEach(tab => {
    const active = tab.dataset.mode === selected.id;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('relatedModeLabel').textContent = selected.label;
  $('orderLinks').hidden = selected.id !== 'order';
  $('relatedEmpty').hidden = selected.id === 'order';
  $('estimateListButton').hidden = selected.id !== 'estimate';
  hydrateHeader();
  sourceTextInput.value = modeDraft().sourceText;
  updateMethod(modeDraft().activeMethod, { persist: false });
  renderRows();
  renderDelivery();
  resizeSource();
  renderSourceAnalysis();
  applyFormLayout();
  const relatedOpen = Boolean(state.draft.ui.relatedOpen);
  document.querySelector('.related-panel').classList.toggle('is-open', relatedOpen);
  $('relatedCollapseButton').setAttribute('aria-expanded', String(relatedOpen));
  $('relatedCollapseButton').textContent = relatedOpen ? '연결 앱 닫기' : '연결 앱 열기';
  setAppStatus(selected.id === 'order'
    ? '주문서 입력을 시작할 수 있습니다.'
    : (selected.id === 'estimate' ? '견적서를 작성하거나 저장된 견적을 불러올 수 있습니다.' : `${selected.label} 입력 화면입니다. 전달 연결은 준비 중입니다.`));
  if (sourceTextInput.value.trim()) scheduleAutoAnalysis(650);
}

function setMode(mode) {
  if (!contract.MODES[mode] || mode === state.draft.activeMode) return;
  syncSourceText();
  state.draft.activeMode = mode;
  state.activeActivity = '';
  state.pendingImageEvidence = null;
  state.pendingOcrReview = null;
  state.pendingSourceName = '';
  saveDraftNow();
  renderMode();
}

function syncSourceText() {
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

function addDirectRow() {
  const current = modeDraft();
  const batch = contract.createBatch({
    sequence: current.batches.length + 1,
    method: 'direct',
    sourceType: 'MANUAL',
    sourceName: '직접입력'
  });
  current.batches.push(batch);
  current.rows = contract.applyParserResults(current.rows, batch, [{ rawText: '', itemName: '', quantity: null }]);
  renderRows();
  saveDraftNow();
  const last = inputRows.querySelector('tr:last-child input[data-field="itemCode"]');
  last?.focus();
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
  if (state.catalogStatus === 'LOADING') {
    if (automatic) return scheduleAutoAnalysis(700);
    toast('상품 기준자료를 불러오는 중입니다. 잠시 후 다시 분석하세요.', 'error');
    return;
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
  const detectedSourceType = looksLikeKakaoText(rawText)
    ? 'KAKAO_TEXT'
    : (pendingOcr?.status === 'VERIFIED'
      ? 'IMAGE_OCR'
      : (['CLIPBOARD', 'IMAGE_OCR'].includes(method.sourceType) ? 'GENERAL_TEXT' : method.sourceType));
  const batch = contract.createBatch({
    sequence: current.batches.length + 1,
    method: method.id,
    sourceType: detectedSourceType,
    sourceName: state.pendingSourceName,
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
    const rawOrdererName = extractOrdererName(rawText);
    current.header.rawOrdererName = rawOrdererName;
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

    if (pendingOcr?.status === 'VERIFIED') {
      lines = verifiedRowsToParserLines(pendingOcr, batch.batchId);
      if (state.draft.activeMode === 'order') {
        const captured = await captureTextIntake({
          sourceType: batch.sourceType,
          sourceId: 'SMART_INPUT',
          captureOccurrenceId: `${state.draft.draftId}:${state.draft.activeMode}:${batch.sequence}`,
          rawText,
          imageEvidence: state.pendingImageEvidence
        });
        batch.intakeSessionId = captured.session.intakeSessionId;
      }
    } else if (state.draft.activeMode === 'order') {
      try {
        const captured = await captureTextIntake({
          sourceType: batch.sourceType,
          sourceId: 'SMART_INPUT',
          captureOccurrenceId: `${state.draft.draftId}:${state.draft.activeMode}:${batch.sequence}`,
          rawText,
          imageEvidence: state.pendingImageEvidence
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
      row.editedFields = { ...(previous.editedFields || {}) };
    });
    const liveRows = current.rows.filter(row => row.batchId === batch.batchId);
    const otherRows = current.rows.filter(row => row.batchId !== batch.batchId);
    current.rows = [...otherRows.slice(0, insertionIndex), ...liveRows, ...otherRows.slice(insertionIndex)];
    current.rows.forEach(row => enrichRowFromUnifiedCatalog(row));
    current.rows = contract.markDuplicatePossibilities(current.rows);
    current.sourceText = rawText;
    current.delivery = { status: 'DRAFT', targetId: '', targetRecordId: '', deliveredAt: '' };
    state.pendingImageEvidence = null;
    state.pendingOcrReview = null;
    state.pendingSourceName = '';
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
    setAppStatus(`${activityLabel(method.id)} 분석 완료 · ${lines.length}행 · 일치 ${summary.matched} · 확인 ${summary.similar} · 미인식 ${summary.unresolved}`);
    $('sourceNotice').textContent = '노랑: 수집된 상품 · 빨강: 마스터 미확정 · 주문자명/시간: 고정 구분색';
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
    $('analyzeButton').disabled = false;
    $('parserProgress').hidden = true;
    renderDelivery();
    renderSourceAnalysis();
    if (sourceTextInput.value !== rawText) scheduleAutoAnalysis(420);
  }
}

async function handleFile(file) {
  if (!file) return;
  try {
    updateMethod('excel');
    setActiveActivity('Excel·파일 불러오는 중');
    setAppStatus(`${file.name} 파일을 읽고 있습니다.`);
    let rawText = '';
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      if (!window.XLSX) throw new Error('Excel 처리 모듈을 불러오지 못했습니다.');
      const workbook = window.XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: false, cellText: true });
      const sheetName = workbook.SheetNames.find(name => workbook.Sheets[name]?.['!ref']) || workbook.SheetNames[0];
      if (!sheetName) throw new Error('읽을 수 있는 Excel 시트가 없습니다.');
      const matrix = window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: true });
      rawText = matrix.map(row => row.map(cell => String(cell ?? '')).join('\t')).join('\n');
      state.pendingSourceName = `${file.name} · ${sheetName}`;
    } else {
      rawText = await file.text();
      state.pendingSourceName = file.name;
    }
    sourceTextInput.value = rawText;
    syncSourceText();
    setAppStatus(`${file.name}을 불러왔습니다. 자동 분석을 시작합니다.`);
    toast('파일 내용을 불러와 자동 분석합니다.', 'success');
  } catch (error) {
    toast(error.message || '파일을 읽지 못했습니다.', 'error');
    setAppStatus('파일을 읽지 못했습니다.', 'error');
  } finally {
    setActiveActivity('');
    $('fileInput').value = '';
  }
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
    fileName: file.name || '붙여넣은 이미지',
    mimeType: file.type || 'image/png',
    byteLength: file.size || buffer.byteLength,
    contentHash,
    binaryBase64: dataUrl.split(',')[1] || ''
  };
}

async function recognizeImage(file) {
  if (!file || !String(file.type || '').startsWith('image/')) return;
  if (state.busy) return;
  state.busy = true;
  $('analyzeButton').disabled = true;
  $('parserProgress').hidden = false;
  $('parserProgress').querySelector('strong').textContent = '사진에서 문자를 추출하고 있습니다.';
  updateMethod('photo');
  setActiveActivity('사진 OCR 처리 중');
  let shouldAnalyze = false;
  try {
    if (!window.Tesseract?.createWorker && !window.Tesseract?.recognize) throw new Error('사진 OCR 모듈을 불러오지 못했습니다.');
    state.pendingImageEvidence = await fileToImageEvidence(file);
    state.pendingSourceName = state.pendingImageEvidence.fileName;
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
      setAppStatus('OCR 산식·합계 검증이 일치하지 않아 상품행을 생성하지 않았습니다.', 'error');
      toast('OCR 확인이 필요합니다. 원문은 유지되고 상품행은 생성하지 않았습니다.', 'error');
    }
  } catch (error) {
    state.pendingImageEvidence = null;
    state.pendingOcrReview = null;
    toast(error.message || '사진 문자를 추출하지 못했습니다.', 'error');
    setAppStatus('사진 OCR을 완료하지 못했습니다. 직접 입력할 수 있습니다.', 'warn');
  } finally {
    state.busy = false;
    setActiveActivity('');
    $('photoInput').value = '';
    $('analyzeButton').disabled = false;
    $('parserProgress').hidden = true;
    $('parserProgress').querySelector('strong').textContent = '자료를 분석하고 있습니다.';
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
  const key = normalizedKey(query);
  if (!key) return null;
  return state.products.find(product => product.masterProductId && [product.itemCode, product.itemName, product.secondaryName, product.searchInfo]
    .some(value => normalizedKey(value) === key)) || null;
}

function commonMasterProducts() {
  return state.products.filter(product => String(product.masterProductId || '').trim());
}

function hasMasterProductIdentity(row) {
  return Boolean(String(row?.masterProductId || '').trim() && String(row?.productId || '').trim() && String(row?.itemCode || '').trim());
}

function priceFromProduct(product) {
  const price = product.priceOptions?.find(option => option.key === 'salePrice')
    || product.priceOptions?.find(option => Number.isFinite(Number(option.value)));
  return price ? Number(price.value) : null;
}

function applyProduct(row, product, { forceIdentityFields = false, preserveIdentityField = '' } = {}) {
  if (!row || !product) return;
  const protect = field => Boolean(row.editedFields?.[field]);
  const preserveIdentity = field => !forceIdentityFields
    && (preserveIdentityField ? field === preserveIdentityField : protect(field));
  row.masterProductId = String(product.masterProductId || '').trim();
  row.productId = row.masterProductId ? product.productId || '' : '';
  if (!preserveIdentity('itemCode')) row.itemCode = product.itemCode || '';
  if (!preserveIdentity('itemName')) row.itemName = product.itemName || '';
  if (!protect('specification')) row.specification = product.specification || '';
  if (!protect('unit')) row.unit = product.finalUnit || product.unit || '';
  if (!protect('unitPrice') && row.unitPrice == null) row.unitPrice = priceFromProduct(product);
  row.matchStatus = hasMasterProductIdentity(row) ? 'MATCHED' : 'UNRESOLVED';
  row.reviewStatus = row.matchStatus === 'MATCHED' ? 'CONFIRMED' : 'PENDING';
  row.productIdentityStatus = row.matchStatus === 'MATCHED' ? 'MASTER_LINKED' : 'UNRESOLVED';
  row.matchSource = row.matchStatus === 'MATCHED' ? 'SMART_INPUT_COMMON_MASTER' : '';
  row.candidateProducts = [];
}

function enrichRowFromUnifiedCatalog(row) {
  if (!row || row.matchStatus === 'MATCHED') return row;
  const query = row.itemCode || row.itemName || row.rawText;
  if (!query) return row;
  const exact = exactProduct(query);
  if (exact) {
    applyProduct(row, exact);
    row.matchSource = 'SMART_INPUT_COMMON_MASTER';
    return row;
  }
  const candidates = searchProductCatalog(query, commonMasterProducts(), 5);
  if (candidates.length) {
    row.candidateProducts = candidates;
    row.matchStatus = 'SIMILAR';
    row.reviewStatus = 'PENDING';
    row.productIdentityStatus = 'UNRESOLVED';
  }
  return row;
}

function rematchQuery(row, changedField = '') {
  if (changedField === 'itemName') return row.itemName || row.itemCode;
  return row.itemCode || row.itemName;
}

function tryMatchRow(row, changedField = '') {
  const query = rematchQuery(row, changedField);
  row.productId = '';
  row.masterProductId = '';
  row.matchSource = '';
  row.reviewStatus = 'PENDING';
  row.productIdentityStatus = 'UNRESOLVED';
  const exact = exactProduct(query);
  let openCandidates = false;
  if (exact) {
    applyProduct(row, exact, { preserveIdentityField: changedField });
  } else if (query) {
    row.candidateProducts = searchProductCatalog(query, commonMasterProducts(), 5);
    if (row.candidateProducts.length === 1) applyProduct(row, row.candidateProducts[0], { preserveIdentityField: changedField });
    else {
      row.matchStatus = row.candidateProducts.length ? 'SIMILAR' : 'UNRESOLVED';
      openCandidates = row.candidateProducts.length > 1;
    }
  } else {
    row.candidateProducts = [];
    row.matchStatus = 'UNRESOLVED';
  }
  modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
  if (openCandidates) modeUi().activeCellId = '';
  renderRows({ restoreFocus: !openCandidates });
  saveDraftNow();
  if (openCandidates) openProductDialog(row, { query });
}

function openProductDialog(row, { query = '' } = {}) {
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
    if (product) {
      applyProduct(row, product, { forceIdentityFields: true });
      modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
      renderRows();
      saveDraftNow();
    }
    dialog.close();
    dialog.remove();
  };
  let foundProducts = [];
  const render = () => {
    foundProducts = searchProductCatalog(search.value, commonMasterProducts(), 12);
    results.innerHTML = '';
    message.textContent = foundProducts.length ? `${foundProducts.length}개 후보 · 첫 번째 항목이 선택되었습니다. Enter로 확정합니다.` : '일치하는 상품 후보가 없습니다.';
    foundProducts.forEach((product, index) => {
      const button = document.createElement('button');
      button.type = 'button';
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
  };
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 90);
  });
  search.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (foundProducts[0]) finish(foundProducts[0]);
  });
  close.addEventListener('click', () => finish(null));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
  dialog.showModal();
  search.focus();
  render();
}

async function saveEstimateDocument() {
  const current = modeDraft();
  if (!current.rows.length) {
    toast('견적 품목을 1개 이상 입력하세요.', 'error');
    return;
  }
  const invalidIndex = current.rows.findIndex(row => (!row.itemCode && !row.itemName) || row.quantity === null || row.quantity === '');
  if (invalidIndex >= 0) {
    const rowElement = inputRows.querySelectorAll('tr')[invalidIndex];
    rowElement?.querySelector(!current.rows[invalidIndex].itemCode && !current.rows[invalidIndex].itemName ? '[data-field="itemName"]' : '[data-field="quantity"]')?.focus();
    toast(`${invalidIndex + 1}행의 품목과 수량을 확인하세요.`, 'error');
    return;
  }
  state.busy = true;
  renderDelivery();
  setAppStatus('견적서 카탈로그에 저장하고 있습니다.');
  try {
    const timestamp = new Date().toISOString();
    const estimateId = current.catalogRecordId || createRecordId('SIEST');
    current.catalogRecordId = estimateId;
    current.updatedAt = timestamp;
    current.delivery = { status: 'SAVED', targetId: 'smart-input-estimates', targetRecordId: estimateId, deliveredAt: timestamp };
    const summary = contract.summarizeRows(current.rows);
    const existing = state.estimates.find(item => item.estimateId === estimateId);
    const record = {
      estimateId,
      customerId: current.header.customerId,
      customerName: current.header.customerName,
      rowCount: summary.total,
      amount: summary.amount,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      draft: JSON.parse(JSON.stringify(current))
    };
    await saveEstimate(record);
    state.estimates = [record, ...state.estimates.filter(item => item.estimateId !== estimateId)]
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    saveDraftNow();
    renderDelivery();
    setAppStatus(`${estimateTitle(record)} · ${summary.total}품목 견적 저장 완료`);
    toast('견적서를 견적 목록에 저장했습니다.', 'success');
  } catch (error) {
    setAppStatus('견적서를 저장하지 못했습니다. 입력 내용은 유지됩니다.', 'error');
    toast(error.message || '견적서 저장에 실패했습니다.', 'error');
  } finally {
    state.busy = false;
    renderDelivery();
  }
}

async function completeOrder() {
  const current = modeDraft();
  if (state.draft.activeMode === 'estimate') return saveEstimateDocument();
  if (state.draft.activeMode !== 'order') {
    toast('구매·판매 전달 대상은 확정 후 활성화합니다.', 'error');
    return;
  }
  const submittedAt = new Date();
  current.header.recordedAt ||= submittedAt.toISOString();
  current.header.orderDate = contract.businessDate(current.header.recordedAt, state.settings.timezone);
  applyWarehouseMatch();
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
  if (!current.header.taxCustomerId && !window.confirm('세무 거래처가 지정되지 않았습니다. 배송처별 주문은 유지한 채 ORDER Q에 저장하시겠습니까?')) return;
  state.busy = true;
  renderDelivery();
  setAppStatus('공통 주문서 원장에 저장하고 있습니다.');
  try {
    const batchText = current.batches.map(batch => batch.rawText).join('\n\n--- SMART INPUT BATCH ---\n\n');
    const rawFingerprint = await sha256Text(batchText);
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
        headerFields: [...state.settings.headerFields],
        voucherColumns: [...state.settings.voucherColumns]
      },
      sourceType: 'SMART_INPUT',
      sourceId: current.batches[0]?.batchId || state.draft.draftId,
      sourceDocumentKey: `SMART_INPUT:${current.batches[0]?.batchId || state.draft.draftId}:ORDER`,
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

function resetCurrentMode(requireConfirmation = true) {
  const current = modeDraft();
  const hasData = current.rows.length || current.sourceText.trim();
  if (requireConfirmation && hasData && !window.confirm(`${contract.MODES[state.draft.activeMode].label} 입력 내용을 비우고 새로 작성하시겠습니까?`)) return;
  const fallback = contract.createDraft().modes[state.draft.activeMode];
  fallback.header.warehouseId = current.header.warehouseId;
  fallback.header.warehouseCode = current.header.warehouseCode;
  fallback.header.warehouseName = current.header.warehouseName;
  fallback.header.transactionType = current.header.transactionType;
  state.draft.modes[state.draft.activeMode] = fallback;
  state.pendingImageEvidence = null;
  state.pendingOcrReview = null;
  state.pendingSourceName = '';
  saveDraftNow();
  renderMode();
  sourceTextInput.focus();
  toast('새 입력을 시작합니다.', 'success');
}

async function hydrateReferences() {
  state.catalogStatus = 'LOADING';
  $('referenceStatus').dataset.status = 'LOADING';
  $('referenceStatus').querySelector('strong').textContent = '상품·거래처·배송 설정을 불러오고 있습니다.';
  const results = await Promise.allSettled([
    withTimeout(getAll(STORE.CUSTOMERS), 5000, '거래처 기준자료 로딩 시간 초과'),
    withTimeout(loadProductCatalog(), 7000, '상품 기준자료 로딩 시간 초과'),
    withTimeout(loadWarehouseCatalog(), 5000, '창고 기준자료 로딩 시간 초과'),
    withTimeout(loadSmartInputData(), 5000, '스마트입력 설정 로딩 시간 초과')
  ]);
  if (results[0].status === 'fulfilled') state.customers = results[0].value.filter(customer => (customer.status || 'ACTIVE') === 'ACTIVE');
  if (results[1].status === 'fulfilled') {
    state.products = results[1].value.products;
    state.catalogSummary = results[1].value;
    state.catalogStatus = state.products.length ? 'READY' : (results[1].value.errors?.length ? 'ERROR' : 'EMPTY');
  } else {
    state.catalogStatus = 'ERROR';
    state.catalogSummary = { commonCount: 0, orderQCount: 0, errors: [results[1].reason?.message || '상품 카탈로그 오류'] };
  }
  if (results[2].status === 'fulfilled') {
    state.warehouseCatalog = results[2].value;
    renderWarehouseOptions();
  }
  if (results[3].status === 'fulfilled') {
    state.settings = contract.normalizeSettings(results[3].value.settings || {});
    state.linkGroups = results[3].value.linkGroups || [];
    state.temporaryCustomers = results[3].value.temporaryCustomers || [];
    state.aliasMappings = results[3].value.aliasMappings || [];
    state.estimates = results[3].value.estimates || [];
    state.smartDataReady = true;
  }
  $('referenceStatus').dataset.status = state.catalogStatus;
  $('referenceStatus').querySelector('strong').textContent = state.catalogStatus === 'READY'
    ? `상품 준비 · 공통 ${Number(state.catalogSummary.commonCount || 0).toLocaleString('ko-KR')}건 · ORDER Q ${Number(state.catalogSummary.orderQCount || 0).toLocaleString('ko-KR')}건 · 거래처 ${state.customers.length.toLocaleString('ko-KR')}건`
    : (state.catalogStatus === 'EMPTY' ? '상품 기준자료가 없습니다. 직접입력은 계속 사용할 수 있습니다.' : '상품 기준자료 일부를 불러오지 못했습니다. 직접입력은 계속 사용할 수 있습니다.');
  renderMode();
  if (sourceTextInput.value.trim()) scheduleAutoAnalysis(650);
  if (!state.customers.length) {
    void refreshCustomers({ syncIfEmpty: true })
      .then(() => {
        const referenceText = $('referenceStatus').querySelector('strong');
        referenceText.textContent = referenceText.textContent.replace(/거래처 [\d,]+건/, `거래처 ${state.customers.length.toLocaleString('ko-KR')}건`);
      })
      .catch(() => setAppStatus('거래처 마스터 동기화가 지연되고 있습니다. 거래처 찾기 창은 계속 사용할 수 있습니다.', 'warn'));
  }
  if (results.some(result => result.status === 'rejected')) {
    setAppStatus('일부 마스터를 불러오지 못했습니다. 직접입력은 계속 사용할 수 있습니다.', 'warn');
  }
}

tabs.forEach(tab => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
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
$('analyzeButton').addEventListener('click', () => analyzeSource({ automatic: false }));
$('addRowButton').addEventListener('click', () => { updateMethod('direct'); addDirectRow(); });
$('customerSearchButton').addEventListener('click', chooseCustomer);
$('customerInput').addEventListener('input', event => {
  const header = modeDraft().header;
  if (event.target.value.trim() !== header.customerName) {
    header.customerId = '';
    header.customerName = event.target.value.trim();
    header.customerLinkGroupId = '';
    header.taxCustomerId = '';
    header.taxCustomerName = '';
    header.isTemporaryCustomer = false;
    header.customerMappingSource = '';
    event.target.dataset.customerId = '';
    applyCustomerRelationship(header);
    updateDeliveryPolicy();
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
  modeDraft().header.deliveryDate = event.target.value;
  modeDraft().header.manualDeliveryOverride = true;
  updateDeliveryPolicy();
  scheduleSave();
});
$('warehouseInput').addEventListener('input', applyWarehouseMatch);
$('warehouseInput').addEventListener('change', applyWarehouseMatch);
$('transactionTypeInput').addEventListener('change', event => { modeDraft().header.transactionType = event.target.value; scheduleSave(); });
$('completeButton').addEventListener('click', completeOrder);
$('saveDraftButton').addEventListener('click', () => { saveDraftNow(); toast('현재 초안을 저장했습니다.', 'success'); });
$('draftListButton').addEventListener('click', openDraftListDialog);
$('estimateListButton').addEventListener('click', openEstimateListDialog);
$('settingsButton').addEventListener('click', openSettingsDialog);
$('resetDraftButton').addEventListener('click', () => resetCurrentMode(false));
$('relatedCollapseButton').addEventListener('click', event => {
  const panel = document.querySelector('.related-panel');
  const open = panel.classList.toggle('is-open');
  state.draft.ui.relatedOpen = open;
  event.currentTarget.setAttribute('aria-expanded', String(open));
  event.currentTarget.textContent = open ? '연결 앱 닫기' : '연결 앱 열기';
  scheduleSave();
});

document.querySelector('.document-fields').addEventListener('input', event => {
  const input = event.target.closest('[data-custom-header-input]');
  if (!input) return;
  modeDraft().header.customValues ||= {};
  modeDraft().header.customValues[input.dataset.customHeaderInput] = input.value;
  scheduleSave();
});

inputRows.addEventListener('input', event => {
  const customInput = event.target.closest('[data-custom-row-field]');
  if (customInput) {
    const customRow = event.target.closest('[data-row-id]');
    const row = modeDraft().rows.find(item => item.rowId === customRow?.dataset.rowId);
    if (!row) return;
    row.customValues ||= {};
    row.customValues[customInput.dataset.customRowField] = customInput.value;
    scheduleSave();
    return;
  }
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr) return;
  const index = modeDraft().rows.findIndex(row => row.rowId === tr.dataset.rowId);
  if (index < 0) return;
  const field = input.dataset.field;
  const row = contract.markProductEdit(modeDraft().rows[index], field, input.value);
  if (field === 'itemCode' || field === 'itemName') {
    tr.dataset.status = 'SIMILAR';
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
  const input = event.target.closest('[data-field="itemCode"], [data-field="itemName"]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr || event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  const row = modeDraft().rows.find(item => item.rowId === tr.dataset.rowId);
  if (row) tryMatchRow(row, input.dataset.field);
});
inputRows.addEventListener('focusin', event => {
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr) return;
  modeUi().activeCellId = `${tr.dataset.rowId}|${input.dataset.field}`;
  state.draft.ui.selectedRowId = tr.dataset.rowId;
});
inputRows.addEventListener('change', event => {
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr || !['itemCode', 'itemName'].includes(input.dataset.field)) return;
  const row = modeDraft().rows.find(item => item.rowId === tr.dataset.rowId);
  if (row) tryMatchRow(row, input.dataset.field);
});
inputRows.addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-row]');
  if (remove) {
    modeDraft().rows = modeDraft().rows.filter(row => row.rowId !== remove.dataset.removeRow);
    modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
    renderRows();
    saveDraftNow();
    return;
  }
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
  if (event.clipboardData?.getData('text/plain')) {
    updateMethod('paste');
    window.setTimeout(syncSourceText, 0);
  }
});

document.addEventListener('keydown', event => {
  if (event.altKey && ['1', '2', '3', '4'].includes(event.key)) {
    event.preventDefault();
    setMode(['order', 'purchase', 'sale', 'estimate'][Number(event.key) - 1]);
  }
});

$('tableScroll').addEventListener('scroll', event => {
  modeUi().scrollTop = event.currentTarget.scrollTop;
  modeUi().scrollLeft = event.currentTarget.scrollLeft;
}, { passive: true });

window.addEventListener('pagehide', () => {
  if (state.draftDirty) saveDraftNow();
});
renderMode();
hydrateReferences();
