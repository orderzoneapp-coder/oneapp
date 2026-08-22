import {
  captureTextIntake,
  analyzeSingleOrderDocument,
  rematchExtractedLinesForCustomer
} from '../orderq/intake-engine.js?v=0.12.1';
import { createOrder } from '../orderq/order-intake-engine.js?v=0.15.0';
import { syncAfterLocalMutation } from '../orderq/orderq-sync-engine.js?v=0.8.0';
import { STORE, getAll } from '../orderq/orderq-db.js?v=0.12.1';
import { openCustomerPicker } from '../orderq/customer-picker.js?v=0.12.1';
import { loadProductCatalog, searchProductCatalog } from '../orderq/product-master-search.js?v=0.8.0';
import { loadWarehouseCatalog, matchWarehouseInput, warehouseDisplayName } from '../orderq/warehouse-master.js?v=0.8.0';

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
  warehouseCatalog: { warehouses: [], aliases: [] },
  pendingImageEvidence: null,
  pendingSourceName: '',
  saveTimer: null,
  toastTimer: null,
  recognition: null,
  listening: false,
  busy: false
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

function saveDraftNow() {
  clearTimeout(state.saveTimer);
  state.draft.updatedAt = new Date().toISOString();
  modeDraft().updatedAt = state.draft.updatedAt;
  try {
    localStorage.setItem(contract.DRAFT_STORAGE_KEY, JSON.stringify(state.draft));
    $('saveState').textContent = '초안 저장됨';
  } catch (_) {
    $('saveState').textContent = '초안 저장 실패';
    setAppStatus('초안을 저장하지 못했습니다. 입력 내용은 현재 화면에 유지됩니다.', 'warn');
  }
}

function scheduleSave() {
  $('saveState').textContent = '저장 중…';
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
  sourceTextInput.style.height = 'auto';
  sourceTextInput.style.height = `${Math.min(300, Math.max(84, sourceTextInput.scrollHeight))}px`;
  $('sourceLength').textContent = `${sourceTextInput.value.length.toLocaleString('ko-KR')}자`;
}

function updateMethod(method) {
  const selected = contract.INPUT_METHODS.find(item => item.id === method) || contract.INPUT_METHODS[2];
  modeDraft().activeMethod = selected.id;
  methodButtons.forEach(button => button.classList.toggle('is-active', button.dataset.method === selected.id));
  $('methodStatus').textContent = selected.label;
  scheduleSave();
  return selected;
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

function applyCustomer(customer, { rematch = true } = {}) {
  if (!customer) return;
  if (customer.customerId && !state.customers.some(item => item.customerId === customer.customerId)) state.customers.push(customer);
  const header = modeDraft().header;
  header.customerId = String(customer.customerId || '').trim();
  header.customerName = customerName(customer);
  $('customerInput').value = header.customerName;
  $('customerInput').dataset.customerId = header.customerId;
  $('customerHint').textContent = `${customerCode(customer) || '등록 거래처'} · 마스터 연결됨`;
  scheduleSave();
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

async function chooseCustomer() {
  try {
    const customer = await openCustomerPicker({
      initialName: $('customerInput').value,
      source: 'SMART_INPUT',
      title: '스마트입력 거래처 찾기'
    });
    if (customer) applyCustomer(customer);
  } catch (error) {
    toast(error.message || '거래처 목록을 열지 못했습니다.', 'error');
  }
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
    setAppStatus('거래처 기준 상품 매칭을 갱신했습니다.');
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
  $('orderDateInput').value = header.orderDate || contract.todayLocal();
  $('deliveryDateInput').value = header.deliveryDate;
  $('warehouseInput').value = header.warehouseName;
  $('transactionTypeInput').value = header.transactionType || '기타';
  $('customerHint').textContent = header.customerId ? '등록 거래처 · 마스터 연결됨' : '거래처가 인식되지 않으면 이 입력란으로 이동합니다.';
}

function rowStatusLabel(row) {
  if (row.matchStatus === 'MATCHED') return ['일치', 'match-badge--matched'];
  if (row.matchStatus === 'SIMILAR') return ['유사', 'match-badge--similar'];
  return ['미인식', 'match-badge--failed'];
}

function renderRows() {
  const rows = modeDraft().rows;
  if (!rows.length) {
    inputRows.innerHTML = '<tr class="empty-row"><td colspan="11"><strong>아직 입력된 상품이 없습니다.</strong><span>원문을 분석하거나 빈 행을 추가해 시작하세요.</span></td></tr>';
    updateSummaries();
    return;
  }
  inputRows.innerHTML = rows.map(row => {
    const [status, statusClass] = rowStatusLabel(row);
    const raw = row.rawText || modeDraft().batches.find(batch => batch.batchId === row.batchId)?.rawText || '';
    const amount = Number(row.quantity || 0) * Number(row.unitPrice || 0);
    return `<tr data-row-id="${esc(row.rowId)}" data-status="${esc(row.matchStatus)}" class="${row.duplicatePossible ? 'is-duplicate' : ''}">
      <td class="source-cell"><span class="batch-badge">${Number(row.batchSequence || 0) || '-'}</span></td>
      <td class="source-cell" title="${esc(raw)}">${esc(raw)}</td>
      <td><input data-field="itemCode" value="${esc(row.itemCode)}" aria-label="품목코드"></td>
      <td><input data-field="itemName" value="${esc(row.itemName)}" aria-label="상품명"></td>
      <td><input data-field="specification" value="${esc(row.specification)}" aria-label="규격"></td>
      <td><input data-field="quantity" type="number" step="any" value="${esc(row.quantity ?? '')}" aria-label="수량"></td>
      <td><input data-field="unit" value="${esc(row.unit)}" aria-label="단위"></td>
      <td><input data-field="unitPrice" type="number" step="any" value="${esc(row.unitPrice ?? '')}" aria-label="단가"></td>
      <td><input value="${amount ? amount.toLocaleString('ko-KR') : ''}" aria-label="금액" readonly tabindex="-1"></td>
      <td><button type="button" class="match-badge ${statusClass}" data-match-row="${esc(row.rowId)}" title="상품 후보 선택">${status}${row.duplicatePossible ? ' · 중복' : ''}</button></td>
      <td><button type="button" class="row-remove" data-remove-row="${esc(row.rowId)}" aria-label="행 삭제">×</button></td>
    </tr>`;
  }).join('');
  updateSummaries();
  window.requestAnimationFrame(() => {
    $('tableScroll').scrollTop = Number(modeUi().scrollTop || 0);
    $('tableScroll').scrollLeft = Number(modeUi().scrollLeft || 0);
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
  $('similarCount').textContent = `유사 ${summary.similar.toLocaleString('ko-KR')}`;
  $('failedCount').textContent = `미인식 ${summary.unresolved.toLocaleString('ko-KR')}`;
  $('duplicateCount').textContent = `중복 가능 ${summary.duplicate.toLocaleString('ko-KR')}`;
  $('totalQuantity').textContent = summary.quantity.toLocaleString('ko-KR');
  $('totalAmount').textContent = `${summary.amount.toLocaleString('ko-KR')}원`;
  $('batchCount').textContent = `${modeDraft().batches.length.toLocaleString('ko-KR')}차`;
  $('rowCountRail').textContent = `${contract.MODES[state.draft.activeMode].label}행 ${summary.total.toLocaleString('ko-KR')}개`;
  updateStage(summary);
}

function updateStage(summary = contract.summarizeRows(modeDraft().rows)) {
  let stageIndex = 0;
  if (summary.total) stageIndex = summary.unresolved || summary.similar ? 2 : 3;
  if (modeDraft().delivery.status === 'SAVED') stageIndex = 4;
  state.draft.ui.stage = contract.STAGES[stageIndex];
  document.querySelectorAll('[data-stage]').forEach((item, index) => {
    item.classList.toggle('is-current', index === stageIndex);
    item.classList.toggle('is-complete', index < stageIndex);
    const indexLabel = item.querySelector('button > span');
    if (indexLabel) indexLabel.textContent = index < stageIndex ? '✓' : String(index + 1).padStart(2, '0');
  });
  $('progressText').textContent = `${stageIndex + 1} / ${contract.STAGES.length}`;
}

function renderDelivery() {
  const isOrder = state.draft.activeMode === 'order';
  const delivery = modeDraft().delivery;
  const lastDelivery = isOrder ? state.draft.ui.lastDelivery : null;
  $('deliveryTarget').textContent = isOrder ? '공통 주문서 원장' : `${contract.MODES[state.draft.activeMode].label} 전달 계약 준비 중`;
  $('deliveryDescription').textContent = isOrder
    ? 'ORDER Q vNext 저장소에 먼저 기록합니다.'
    : '확정된 DataOps 연결만 이후 단계에서 활성화합니다.';
  const visibleDelivery = delivery.status === 'SAVED' ? delivery : lastDelivery;
  $('deliveryState').textContent = visibleDelivery
    ? `최근 ${visibleDelivery.orderNo || visibleDelivery.targetRecordId || '저장 완료'}${visibleDelivery.deliveredAt ? ` · ${new Date(visibleDelivery.deliveredAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : ''}`
    : '전달 전';
  document.querySelector('.delivery-state span').style.background = visibleDelivery ? '#5eead4' : '#fbbf24';
  $('completeButton').disabled = !isOrder || state.busy;
  $('completeButton').textContent = '입력 완료';
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
  hydrateHeader();
  sourceTextInput.value = modeDraft().sourceText;
  updateMethod(modeDraft().activeMethod);
  renderRows();
  renderDelivery();
  resizeSource();
  const relatedOpen = Boolean(state.draft.ui.relatedOpen);
  document.querySelector('.related-panel').classList.toggle('is-open', relatedOpen);
  $('relatedCollapseButton').setAttribute('aria-expanded', String(relatedOpen));
  $('relatedCollapseButton').textContent = relatedOpen ? '연결 앱 닫기' : '연결 앱 열기';
  setAppStatus(selected.id === 'order' ? '주문서 입력을 시작할 수 있습니다.' : `${selected.label} 입력 화면입니다. 전달 연결은 준비 중입니다.`);
}

function setMode(mode) {
  if (!contract.MODES[mode] || mode === state.draft.activeMode) return;
  syncSourceText();
  state.draft.activeMode = mode;
  state.pendingImageEvidence = null;
  state.pendingSourceName = '';
  saveDraftNow();
  renderMode();
}

function syncSourceText() {
  modeDraft().sourceText = sourceTextInput.value;
  scheduleSave();
  resizeSource();
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
  current.sourceText = '';
  sourceTextInput.value = '';
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
  return String(rawText || '').replace(/\r\n?/g, '\n').split('\n').map((raw, index) => ({ raw, index }))
    .filter(({ raw }) => raw.trim() && normalizedKey(raw) !== customerKey)
    .map(({ raw, index }) => {
      const cleaned = raw.trim().replace(/^[-•·*]+\s*/, '');
      const match = cleaned.match(/^(.*?)\s+(-?\d+(?:\.\d+)?)\s*([^\d\s]*)$/);
      return {
        rawText: raw,
        productText: match ? match[1].trim() : cleaned,
        itemName: match ? match[1].trim() : cleaned,
        quantity: match ? Number(match[2]) : null,
        unit: match?.[3] || '',
        sourceLineKey: `${batch.batchId}:${index + 1}`,
        matchStatus: 'UNRESOLVED'
      };
    });
}

async function analyzeSource() {
  if (state.busy) return;
  const current = modeDraft();
  const rawText = sourceTextInput.value;
  if (!rawText.trim()) {
    sourceTextInput.focus();
    return toast('분석할 원문을 입력하세요.', 'error');
  }
  const method = contract.INPUT_METHODS.find(item => item.id === current.activeMethod) || contract.INPUT_METHODS[2];
  const batch = contract.createBatch({
    sequence: current.batches.length + 1,
    method: method.id,
    sourceType: method.sourceType,
    sourceName: state.pendingSourceName,
    rawText,
    contentHash: await sha256Text(rawText)
  });
  state.busy = true;
  $('analyzeButton').disabled = true;
  $('parserProgress').hidden = false;
  setAppStatus(`${batch.sequence}차 입력을 분석하고 있습니다.`);
  try {
    let lines = [];
    let analyzedDocument = null;
    const inferred = current.header.customerId ? null : inferCustomer(rawText);
    if (inferred) applyCustomer(inferred, { rematch: false });

    if (state.draft.activeMode === 'order') {
      try {
        const captured = await captureTextIntake({
          sourceType: method.sourceType === 'CLIPBOARD' ? 'GENERAL_TEXT' : method.sourceType,
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
        toast('자동 파서가 인식하지 못한 원문은 직접 확인할 행으로 추가했습니다.', 'error');
      }
    } else {
      lines = fallbackLines(rawText, batch);
    }

    if (!lines.length) throw new Error('상품 행을 인식하지 못했습니다. 상품명과 수량을 확인해 주세요.');
    current.batches.push(batch);
    current.rows = contract.applyParserResults(current.rows, batch, lines);
    current.sourceText = '';
    current.delivery = { status: 'DRAFT', targetId: '', targetRecordId: '', deliveredAt: '' };
    sourceTextInput.value = '';
    state.pendingImageEvidence = null;
    state.pendingSourceName = '';
    resizeSource();
    if (!current.header.customerId && analyzedDocument?.confirmedCustomerId) {
      applyCustomer({ customerId: analyzedDocument.confirmedCustomerId, customerName: analyzedDocument.confirmedCustomerName }, { rematch: false });
    }
    renderRows();
    renderDelivery();
    saveDraftNow();
    const summary = contract.summarizeRows(current.rows);
    setAppStatus(`${batch.sequence}차 분석 완료 · ${lines.length}행 추가 · 일치 ${summary.matched}, 확인 필요 ${summary.similar + summary.unresolved}`);
    if (!current.header.customerId) {
      $('customerHint').textContent = '거래처를 인식하지 못했습니다. 등록 거래처를 선택하세요.';
      $('customerInput').focus();
      toast('거래처를 인식하지 못해 거래처 입력란으로 이동했습니다.', 'error');
    }
  } catch (error) {
    setAppStatus('분석을 완료하지 못했습니다. 원문은 그대로 유지됩니다.', 'error');
    toast(error.message || '자료 분석에 실패했습니다.', 'error');
  } finally {
    state.busy = false;
    $('analyzeButton').disabled = false;
    $('parserProgress').hidden = true;
    renderDelivery();
  }
}

async function handleFile(file) {
  if (!file) return;
  try {
    updateMethod('excel');
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
    setAppStatus(`${file.name}을 원문 입력창에 불러왔습니다.`);
    toast('파일 내용을 확인한 뒤 분석·추가를 누르세요.', 'success');
  } catch (error) {
    toast(error.message || '파일을 읽지 못했습니다.', 'error');
    setAppStatus('파일을 읽지 못했습니다.', 'error');
  } finally {
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
  try {
    if (!window.Tesseract?.recognize) throw new Error('사진 OCR 모듈을 불러오지 못했습니다.');
    state.pendingImageEvidence = await fileToImageEvidence(file);
    state.pendingSourceName = state.pendingImageEvidence.fileName;
    const result = await window.Tesseract.recognize(file, 'kor+eng', {
      logger: progress => {
        if (progress.status === 'recognizing text') {
          $('parserProgress').querySelector('strong').textContent = `사진 문자 추출 ${Math.round(Number(progress.progress || 0) * 100)}%`;
        }
      }
    });
    const text = String(result?.data?.text || '').replace(/\r/g, '');
    if (!text.trim()) throw new Error('사진에서 문자를 찾지 못했습니다.');
    sourceTextInput.value = text;
    syncSourceText();
    setAppStatus('사진 문자 추출이 완료되었습니다. 원문을 확인하세요.');
    toast('추출된 문자를 확인한 뒤 분석·추가를 누르세요.', 'success');
  } catch (error) {
    state.pendingImageEvidence = null;
    toast(error.message || '사진 문자를 추출하지 못했습니다.', 'error');
    setAppStatus('사진 OCR을 완료하지 못했습니다. 직접 입력할 수 있습니다.', 'warn');
  } finally {
    state.busy = false;
    $('photoInput').value = '';
    $('analyzeButton').disabled = false;
    $('parserProgress').hidden = true;
    $('parserProgress').querySelector('strong').textContent = '자료를 분석하고 있습니다.';
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
    $('sourceNotice').textContent = '음성 입력이 종료되었습니다. 내용을 확인하세요.';
    setAppStatus('음성 입력 내용을 확인할 수 있습니다.');
  };
  recognition.start();
}

function exactProduct(query) {
  const key = normalizedKey(query);
  if (!key) return null;
  return state.products.find(product => normalizedKey(product.itemCode) === key || normalizedKey(product.itemName) === key) || null;
}

function priceFromProduct(product) {
  const price = product.priceOptions?.find(option => option.key === 'salePrice')
    || product.priceOptions?.find(option => Number.isFinite(Number(option.value)));
  return price ? Number(price.value) : null;
}

function applyProduct(row, product, force = false) {
  if (!row || !product) return;
  const protect = field => !force && row.editedFields?.[field];
  row.productId = product.productId || '';
  if (!protect('itemCode')) row.itemCode = product.itemCode || '';
  if (!protect('itemName')) row.itemName = product.itemName || '';
  if (!protect('specification')) row.specification = product.specification || '';
  if (!protect('unit')) row.unit = product.finalUnit || product.unit || '';
  if (!protect('unitPrice') && row.unitPrice == null) row.unitPrice = priceFromProduct(product);
  row.matchStatus = row.productId && row.itemCode ? 'MATCHED' : 'UNRESOLVED';
  row.reviewStatus = row.matchStatus === 'MATCHED' ? 'CONFIRMED' : 'PENDING';
  row.productIdentityStatus = row.matchStatus === 'MATCHED' ? 'MASTER_LINKED' : 'UNRESOLVED';
  row.candidateProducts = [];
}

function tryMatchRow(row) {
  const query = row.itemCode || row.itemName;
  const exact = exactProduct(query);
  if (exact) {
    applyProduct(row, exact);
  } else if (query) {
    row.productId = '';
    row.candidateProducts = searchProductCatalog(query, state.products, 5);
    row.matchStatus = row.candidateProducts.length ? 'SIMILAR' : 'UNRESOLVED';
    row.reviewStatus = 'PENDING';
    row.productIdentityStatus = 'UNRESOLVED';
  }
  modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
  renderRows();
  saveDraftNow();
}

function openProductDialog(row) {
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
  search.value = row.itemCode || row.itemName || '';
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
      applyProduct(row, product, true);
      modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
      renderRows();
      saveDraftNow();
    }
    dialog.close();
    dialog.remove();
  };
  const render = () => {
    const found = searchProductCatalog(search.value, state.products, 12);
    results.innerHTML = '';
    message.textContent = found.length ? `${found.length}개 후보를 확인하세요.` : '일치하는 상품 후보가 없습니다.';
    found.forEach(product => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'customer-picker-result';
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
  close.addEventListener('click', () => finish(null));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
  dialog.showModal();
  search.focus();
  render();
}

async function completeOrder() {
  const current = modeDraft();
  if (state.draft.activeMode !== 'order') {
    toast('구매·판매 전달 대상은 확정 후 활성화합니다.', 'error');
    return;
  }
  applyWarehouseMatch();
  const errors = contract.validateOrderDraft(current);
  if (errors.length) {
    const first = errors[0];
    if (first.field === 'customer') $('customerInput').focus();
    else if (first.field === 'orderDate') $('orderDateInput').focus();
    else if (first.field === 'warehouse') $('warehouseInput').focus();
    else if (first.field.startsWith('row:')) {
      const [, index, field] = first.field.split(':');
      inputRows.querySelectorAll('tr')[Number(index)]?.querySelector(`[data-field="${field === 'item' ? 'itemName' : field}"]`)?.focus();
    }
    return toast(first.message, 'error');
  }
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
      sourceType: 'SMART_INPUT',
      sourceId: current.batches[0]?.batchId || state.draft.draftId,
      sourceDocumentKey: `SMART_INPUT:${current.batches[0]?.batchId || state.draft.draftId}:ORDER`,
      rawFingerprint,
      intakeContractVersion: 'SMART_INPUT_V1',
      inputChannel: 'SMART_INPUT',
      actorName: 'SMART INPUT 관리자',
      items: current.rows.map((row, index) => ({
        lineNo: index + 1,
        productId: row.productId || null,
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
        matchStatus: row.productId && row.itemCode ? 'MATCHED' : 'MATCH_FAILED',
        matchSource: row.productId ? 'SMART_INPUT_MASTER' : 'SMART_INPUT_UNRESOLVED',
        intakeLineId: row.intakeLineId,
        sourceLineKey: row.sourceLineKey || `${row.batchId}:${row.sourceLineNo || index + 1}`,
        reviewStatus: row.productId && row.itemCode ? 'CONFIRMED' : 'PENDING',
        productIdentityStatus: row.productId && row.itemCode ? 'MASTER_LINKED' : 'UNRESOLVED'
      }))
    });
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
      customerId: current.header.customerId,
      customerName: current.header.customerName,
      rowCount: current.rows.length
    });
    const next = contract.createDraft({ date: contract.todayLocal() }).modes.order;
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
  const fallback = contract.createDraft({ date: contract.todayLocal() }).modes[state.draft.activeMode];
  fallback.header.warehouseId = current.header.warehouseId;
  fallback.header.warehouseCode = current.header.warehouseCode;
  fallback.header.warehouseName = current.header.warehouseName;
  fallback.header.transactionType = current.header.transactionType;
  state.draft.modes[state.draft.activeMode] = fallback;
  state.pendingImageEvidence = null;
  state.pendingSourceName = '';
  saveDraftNow();
  renderMode();
  sourceTextInput.focus();
  toast('새 입력을 시작합니다.', 'success');
}

async function hydrateReferences() {
  const results = await Promise.allSettled([
    getAll(STORE.CUSTOMERS),
    loadProductCatalog(),
    loadWarehouseCatalog()
  ]);
  if (results[0].status === 'fulfilled') state.customers = results[0].value.filter(customer => (customer.status || 'ACTIVE') === 'ACTIVE');
  if (results[1].status === 'fulfilled') state.products = results[1].value.products;
  if (results[2].status === 'fulfilled') {
    state.warehouseCatalog = results[2].value;
    renderWarehouseOptions();
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
$('fileInput').addEventListener('change', event => handleFile(event.target.files?.[0]));
$('photoInput').addEventListener('change', event => recognizeImage(event.target.files?.[0]));
$('analyzeButton').addEventListener('click', analyzeSource);
$('addRowButton').addEventListener('click', () => { updateMethod('direct'); addDirectRow(); });
$('customerSearchButton').addEventListener('click', chooseCustomer);
$('customerInput').addEventListener('input', event => {
  const header = modeDraft().header;
  if (event.target.value.trim() !== header.customerName) {
    header.customerId = '';
    header.customerName = event.target.value.trim();
    event.target.dataset.customerId = '';
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
$('orderDateInput').addEventListener('input', event => { modeDraft().header.orderDate = event.target.value; scheduleSave(); });
$('deliveryDateInput').addEventListener('input', event => { modeDraft().header.deliveryDate = event.target.value; scheduleSave(); });
$('warehouseInput').addEventListener('input', applyWarehouseMatch);
$('warehouseInput').addEventListener('change', applyWarehouseMatch);
$('transactionTypeInput').addEventListener('change', event => { modeDraft().header.transactionType = event.target.value; scheduleSave(); });
$('completeButton').addEventListener('click', completeOrder);
$('resetDraftButton').addEventListener('click', () => resetCurrentMode(true));
$('relatedCollapseButton').addEventListener('click', event => {
  const panel = document.querySelector('.related-panel');
  const open = panel.classList.toggle('is-open');
  state.draft.ui.relatedOpen = open;
  event.currentTarget.setAttribute('aria-expanded', String(open));
  event.currentTarget.textContent = open ? '연결 앱 닫기' : '연결 앱 열기';
  scheduleSave();
});

inputRows.addEventListener('input', event => {
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr) return;
  const index = modeDraft().rows.findIndex(row => row.rowId === tr.dataset.rowId);
  if (index < 0) return;
  const field = input.dataset.field;
  let row = contract.markUserEdit(modeDraft().rows[index], field, input.value);
  if (field === 'itemCode' || field === 'itemName') {
    row.productId = '';
    row.matchStatus = 'UNRESOLVED';
    row.reviewStatus = 'PENDING';
    row.productIdentityStatus = 'UNRESOLVED';
  }
  modeDraft().rows[index] = row;
  if (field === 'quantity' || field === 'unitPrice') {
    const amount = Number(row.quantity || 0) * Number(row.unitPrice || 0);
    const amountInput = tr.querySelector('td:nth-child(9) input');
    if (amountInput) amountInput.value = amount ? amount.toLocaleString('ko-KR') : '';
  }
  updateSummaries();
  scheduleSave();
});
inputRows.addEventListener('focusin', event => {
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr) return;
  modeUi().activeCellId = `${tr.dataset.rowId}|${input.dataset.field}`;
  state.draft.ui.selectedRowId = tr.dataset.rowId;
  scheduleSave();
});
inputRows.addEventListener('change', event => {
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr || !['itemCode', 'itemName'].includes(input.dataset.field)) return;
  const row = modeDraft().rows.find(item => item.rowId === tr.dataset.rowId);
  if (row) tryMatchRow(row);
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
  const match = event.target.closest('[data-match-row]');
  if (match) {
    const row = modeDraft().rows.find(item => item.rowId === match.dataset.matchRow);
    if (row) openProductDialog(row);
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
  if (event.altKey && ['1', '2', '3'].includes(event.key)) {
    event.preventDefault();
    setMode(['order', 'purchase', 'sale'][Number(event.key) - 1]);
  }
});

$('tableScroll').addEventListener('scroll', event => {
  modeUi().scrollTop = event.currentTarget.scrollTop;
  modeUi().scrollLeft = event.currentTarget.scrollLeft;
  scheduleSave();
}, { passive: true });

window.addEventListener('pagehide', saveDraftNow);
renderMode();
hydrateReferences();
