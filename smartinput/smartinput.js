import { parseStructuredSheet } from './structured-sheet-parser.js?v=0.1.1';
import { buildGridPastePlan, parseClipboardMatrix } from './grid-clipboard.js?v=0.1.0';
import {
  buildOrderGroupPayload,
  decorateStructuredRows,
  groupVoucherRows,
  structuredFieldsForMode
} from './multivoucher-stage1.js?v=0.1.0';
import { buildCatalogPriceSnapshot } from './estimate-output.js?v=0.1.4';
import {
  createRecordId,
  loadSmartInputData,
  saveEstimate,
  saveSourceImage
} from './smartinput-data-store.js?v=0.3.1';
import {
  finalizePurchase,
  finalizeSale,
  loadCustomerReferences,
  loadProductReferences,
  loadWarehouseReferences,
  saveOrderLocal,
  syncOrderInBackground
} from './integration-adapter.js?v=1.0.0';
import { deliveryState, executeVoucherGroups, rowsForFailedGroups } from './workflow-core.js?v=1.0.0';

const contract = globalThis.SMART_INPUT_CONTRACT;
if (!contract) throw new Error('SMART_INPUT_CONTRACT_NOT_LOADED');

const $ = id => document.getElementById(id);
const MODE_COPY = Object.freeze({
  order: { header: '주문서 기본 정보', customer: '거래처명', date: '배송일자', warehouse: '출하창고', kind: 'BACKGROUND_SYNC', title: 'ORDER Q 로컬 저장', description: '로컬 원장 저장을 먼저 완료하고 동기화는 이후 시도합니다.', action: '주문 저장' },
  purchase: { header: '구매 기본 정보', customer: '구매처명', date: '구매일자', warehouse: '입고창고', kind: 'SERVER_FINALIZE', title: '공식 구매전표 확정', description: '인증·권한·revision을 서버에서 확인합니다. 실패해도 현재 초안은 유지됩니다.', action: '구매 확정' },
  sale: { header: '판매 기본 정보', customer: '판매처명', date: '판매일자', warehouse: '출하창고', kind: 'SERVER_FINALIZE', title: '공식 판매전표 확정', description: '인증·권한·revision을 서버에서 확인합니다. 실패해도 현재 초안은 유지됩니다.', action: '판매 확정' },
  estimate: { header: '견적서 기본 정보', customer: '거래처명', date: '견적일자', warehouse: '출하창고', kind: 'LOCAL_OPERATION', title: '견적서 로컬 저장', description: 'IndexedDB에 저장합니다. 같은 이름은 수정하고 다른 이름은 복사본으로 만듭니다.', action: '견적 저장' }
});
const TABLE_FIELDS = Object.freeze([
  { id: 'itemCode', label: '품목코드' },
  { id: 'itemName', label: '품목명' },
  { id: 'specification', label: '규격' },
  { id: 'quantity', label: '수량', numeric: true },
  { id: 'unit', label: '단위' },
  { id: 'unitPrice', label: '단가', numeric: true },
  { id: 'memo', label: '메모' }
]);
const MIN_VISIBLE_WORK_ROWS = 3;

function loadDraft() {
  try {
    return contract.normalizeDraft(JSON.parse(localStorage.getItem(contract.DRAFT_STORAGE_KEY) || 'null'));
  } catch (_) {
    return contract.createDraft();
  }
}

function loadDraftList() {
  try {
    const value = JSON.parse(localStorage.getItem(contract.DRAFT_LIST_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

const state = {
  draft: loadDraft(),
  draftList: loadDraftList(),
  estimates: [],
  sourceImages: [],
  selectedEstimateName: '',
  dirty: false,
  saveTimer: 0,
  toastTimer: 0,
  photoFile: null,
  photoDataUrl: '',
  voiceRecognition: null,
  references: {
    customer: { state: 'loading', rows: [], error: null },
    product: { state: 'loading', rows: [], error: null },
    warehouse: { state: 'loading', rows: [], error: null }
  }
};

function current() { return state.draft.modes[state.draft.activeMode]; }
function nowIso() { return new Date().toISOString(); }
function text(value) { return String(value ?? '').trim(); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function setSaveState(message, status = 'idle') {
  $('saveState').textContent = message;
  $('saveState').dataset.state = status;
}

function setDeliveryMessage(message = '', status = '') {
  $('deliveryMessage').textContent = message;
  if (status) $('deliveryMessage').dataset.state = status;
  else delete $('deliveryMessage').dataset.state;
}

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { element.hidden = true; }, 3200);
}

function meaningful(modeDraft) {
  return Boolean(text(modeDraft.sourceText) || modeDraft.rows.length || text(modeDraft.header.customerName) || text(modeDraft.header.warehouseName));
}

function persistDraft({ archive = false } = {}) {
  clearTimeout(state.saveTimer);
  state.draft.updatedAt = nowIso();
  current().updatedAt = state.draft.updatedAt;
  try {
    localStorage.setItem(contract.DRAFT_STORAGE_KEY, JSON.stringify(state.draft));
    if (archive && meaningful(current())) {
      const snapshot = JSON.parse(JSON.stringify({ ...current(), parentDraftId: state.draft.draftId, updatedAt: nowIso() }));
      state.draftList = [snapshot, ...state.draftList.filter(item => item.documentId !== snapshot.documentId)].slice(0, 40);
      localStorage.setItem(contract.DRAFT_LIST_STORAGE_KEY, JSON.stringify(state.draftList));
    }
    state.dirty = false;
    setSaveState('로컬 저장됨', 'saved');
    renderDraftCount();
    return true;
  } catch (error) {
    state.dirty = true;
    setSaveState('저장 실패 · 작업 유지', 'error');
    setDeliveryMessage(`LOCAL_STORAGE_ERROR · ${error.message}`, 'error');
    return false;
  }
}

function scheduleSave() {
  state.dirty = true;
  setSaveState('저장 중…', 'idle');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => persistDraft(), 180);
}

function setMode(mode) {
  if (!contract.MODES[mode] || mode === state.draft.activeMode) return;
  persistDraft();
  state.draft.activeMode = mode;
  renderAll();
  scheduleSave();
}

function setMethod(method, { persist = true } = {}) {
  if (!contract.INPUT_METHODS.some(item => item.id === method)) return;
  current().activeMethod = method;
  document.querySelectorAll('[data-method]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.method === method)));
  document.querySelectorAll('[data-pane]').forEach(pane => { pane.hidden = pane.dataset.pane !== method; });
  $('sourceStatus').textContent = contract.INPUT_METHODS.find(item => item.id === method)?.label || method;
  if (persist) scheduleSave();
}

function renderReferenceArea(area) {
  const value = state.references[area];
  const element = document.querySelector(`[data-reference="${area}"]`);
  element.dataset.state = value.state;
  const label = value.state === 'ready' ? `${value.rows.length}건` : value.state === 'error' ? '조회 실패' : '확인 중';
  element.querySelector('strong').textContent = label;
  const errorTitle = value.error?.code || value.error?.message || '';
  element.title = errorTitle;
}

async function refreshReference(area) {
  const target = state.references[area];
  target.state = 'loading';
  target.error = null;
  renderReferenceArea(area);
  try {
    const result = area === 'customer'
      ? await loadCustomerReferences()
      : area === 'product'
        ? await loadProductReferences()
        : await loadWarehouseReferences();
    target.rows = area === 'product' ? result.products : area === 'warehouse' ? result.warehouses : result;
    target.state = 'ready';
  } catch (error) {
    target.state = 'error';
    target.error = error;
  }
  renderReferenceArea(area);
}

function refreshReferences() {
  ['customer', 'product', 'warehouse'].forEach(area => { void refreshReference(area); });
}

async function loadLocalData() {
  try {
    const data = await loadSmartInputData();
    state.estimates = data.estimates || [];
    state.sourceImages = data.sourceImages || [];
    setSaveState('로컬 준비', 'saved');
  } catch (error) {
    setSaveState('로컬 자료 조회 오류', 'error');
    setDeliveryMessage(`LOCAL_DATA_READ_ERROR · 기존 작업본을 유지합니다. ${error.message}`, 'error');
  }
}

function syncHeaderFromInputs() {
  const header = current().header;
  header.customerName = text($('customerInput').value);
  header.voucherDate = $('voucherDateInput').value;
  header.deliveryDate = $('voucherDateInput').value;
  header.warehouseName = text($('warehouseInput').value);
}

function renderHeader() {
  const copy = MODE_COPY[state.draft.activeMode];
  const header = current().header;
  $('voucherHeaderTitle').textContent = copy.header;
  $('customerLabel').textContent = copy.customer;
  $('dateLabel').textContent = copy.date;
  $('warehouseLabel').textContent = copy.warehouse;
  $('customerInput').value = header.customerName || '';
  $('voucherDateInput').value = header.deliveryDate || header.voucherDate || contract.todayLocal();
  $('warehouseInput').value = header.warehouseName || '';
  $('estimateNameField').hidden = state.draft.activeMode !== 'estimate';
  $('estimateNameInput').value = state.selectedEstimateName;
}

function renderDelivery() {
  const copy = MODE_COPY[state.draft.activeMode];
  $('deliveryKind').textContent = copy.kind;
  $('deliveryTitle').textContent = copy.title;
  $('deliveryDescription').textContent = copy.description;
  $('completeButton').textContent = copy.action;
}

function renderModes() {
  document.querySelectorAll('[data-mode]').forEach(button => {
    const selected = button.dataset.mode === state.draft.activeMode;
    button.setAttribute('aria-selected', String(selected));
  });
}

function renderDraftCount() { $('draftCount').textContent = String(state.draftList.length); }

function renderSource() {
  $('sourcePreview').textContent = current().sourceText || '아직 원본이 없습니다.';
  $('sourceTextInput').value = current().sourceText || '';
  setMethod(current().activeMethod || 'direct', { persist: false });
}

function renderWorkRow(row, index, { virtual = false } = {}) {
  const rowNumber = index + 1;
  const rowAttribute = virtual ? ' data-virtual-row="true"' : ` data-row-id="${escapeHtml(row.rowId)}"`;
  return `
    <tr${rowAttribute}>
      <td>${rowNumber}</td>
      ${TABLE_FIELDS.map(field => `<td><input aria-label="${rowNumber}행 ${field.label}" data-field="${field.id}" value="${virtual ? '' : escapeHtml(row[field.id] ?? '')}"${field.numeric ? ' inputmode="decimal"' : ''}></td>`).join('')}
      <td>${virtual ? '' : `<button type="button" class="si-row-delete" data-delete-row aria-label="${rowNumber}행 삭제">×</button>`}</td>
    </tr>`;
}

function renderRowSummary(rows = current().rows) {
  const summary = contract.summarizeRows(rows);
  $('rowSummary').textContent = `${summary.total}행 · 수량 ${summary.quantity.toLocaleString('ko-KR')} · 금액 ${summary.amount.toLocaleString('ko-KR')}`;
}

function renderRows() {
  const rows = current().rows;
  const virtualRowCount = Math.max(0, MIN_VISIBLE_WORK_ROWS - rows.length);
  const actualRows = rows.map((row, index) => renderWorkRow(row, index));
  const virtualRows = Array.from({ length: virtualRowCount }, (_, index) => renderWorkRow({}, rows.length + index, { virtual: true }));
  $('workTableBody').innerHTML = [...actualRows, ...virtualRows].join('');
  $('tableEmpty').hidden = rows.length + virtualRowCount > 0;
  renderRowSummary(rows);
}

function materializeVirtualRow(rowElement) {
  if (rowElement?.dataset.virtualRow !== 'true') return -1;
  const row = contract.normalizeRow({ rowId: contract.createId('SIROW') });
  current().rows.push(row);
  rowElement.dataset.rowId = row.rowId;
  delete rowElement.dataset.virtualRow;
  return current().rows.length - 1;
}

function renderAll() {
  renderModes();
  renderHeader();
  renderDelivery();
  renderSource();
  renderRows();
  renderDraftCount();
  setDeliveryMessage('');
}

function addBlankRow(seed = {}) {
  const row = contract.normalizeRow({ rowId: contract.createId('SIROW'), ...seed });
  current().rows = contract.markDuplicatePossibilities([...current().rows, row]);
  renderRows();
  scheduleSave();
  requestAnimationFrame(() => [...$('workTableBody').querySelectorAll('tr[data-row-id]')]
    .find(element => element.dataset.rowId === row.rowId)
    ?.querySelector('input[data-field="itemCode"]')
    ?.focus());
}

function parseDelimitedCsv(source) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell === '') quoted = true;
    else if (character === ',') { row.push(cell); cell = ''; }
    else if (character === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (character !== '\r') cell += character;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter(candidate => candidate.some(value => text(value)));
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle) return `LOCAL-${Date.now().toString(36)}`;
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function simpleTextLines(source) {
  return String(source || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const tokens = line.split(/\s+/);
    const numericIndexes = tokens.map((token, tokenIndex) => ({ tokenIndex, value: contract.numberOrNull(token) })).filter(item => item.value !== null);
    const quantityToken = numericIndexes.at(-2) || numericIndexes.at(-1);
    const priceToken = numericIndexes.length > 1 ? numericIndexes.at(-1) : null;
    let code = '';
    if (/^[A-Za-z0-9_-]{2,}$/.test(tokens[0]) && contract.numberOrNull(tokens[0]) === null) code = tokens.shift();
    const quantityIndex = quantityToken?.tokenIndex - (code ? 1 : 0);
    const itemTokens = Number.isFinite(quantityIndex) ? tokens.slice(0, Math.max(1, quantityIndex)) : tokens;
    return {
      rawText: line,
      sourceLineNo: index + 1,
      sourceLineKey: `TEXT:${index + 1}:${line}`,
      itemCode: code,
      itemName: itemTokens.join(' ') || line,
      quantity: quantityToken?.value ?? 1,
      unit: Number.isFinite(quantityIndex) ? text(tokens[quantityIndex + 1]).replace(/[\d,.]/g, '') : '',
      unitPrice: priceToken && priceToken !== quantityToken ? priceToken.value : null,
      matchStatus: 'UNRESOLVED'
    };
  });
}

async function applyMatrix(matrix, { method, sourceName = '', sheetName = '' } = {}) {
  const mode = state.draft.activeMode;
  const parsed = parseStructuredSheet(matrix, {
    fieldDefinitions: structuredFieldsForMode(mode, contract.PRODUCT_FIELD_DEFINITIONS),
    numberParser: contract.numberOrNull,
    sheetName
  });
  const rawText = parsed.rawText || matrix.map(row => row.join('\t')).join('\n');
  const batch = contract.createBatch({
    sequence: current().batches.length + 1,
    method,
    sourceType: method === 'excel' ? 'FILE' : 'CLIPBOARD',
    sourceName,
    sourceSheetName: sheetName,
    rawText,
    contentHash: await sha256(rawText)
  });
  const parsedRows = parsed.structured
    ? decorateStructuredRows(parsed.rows, { sourceBatchId: batch.batchId, sourceSheetName: sheetName, sourceFingerprint: batch.contentHash })
    : simpleTextLines(rawText);
  current().batches.push(batch);
  current().sourceText = rawText;
  current().rows = contract.applyParserResults(current().rows, batch, parsedRows);
  renderSource();
  renderRows();
  scheduleSave();
  toast(`${parsedRows.length}개 행을 작업테이블에 반영했습니다.`);
}

async function analyzeText(source, method = 'text') {
  const raw = String(source || '');
  if (!text(raw)) return toast('분석할 원본을 입력하세요.');
  const matrix = raw.includes('\t') ? parseClipboardMatrix(raw) : [];
  if (matrix.length && matrix.some(row => row.length > 1)) return applyMatrix(matrix, { method });
  const batch = contract.createBatch({ sequence: current().batches.length + 1, method, sourceType: method === 'paste' ? 'CLIPBOARD' : 'GENERAL_TEXT', rawText: raw, contentHash: await sha256(raw) });
  const lines = simpleTextLines(raw);
  current().batches.push(batch);
  current().sourceText = raw;
  current().rows = contract.applyParserResults(current().rows, batch, lines);
  renderSource();
  renderRows();
  scheduleSave();
  toast(`${lines.length}개 행을 작업테이블에 반영했습니다.`);
}

function loadScript(src, globalName, code) {
  if (globalThis[globalName]) return Promise.resolve(globalThis[globalName]);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-smartinput-library="${globalName}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(globalThis[globalName]), { once: true });
      existing.addEventListener('error', () => reject(Object.assign(new Error(code), { code })), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.smartinputLibrary = globalName;
    script.onload = () => globalThis[globalName] ? resolve(globalThis[globalName]) : reject(Object.assign(new Error(code), { code }));
    script.onerror = () => reject(Object.assign(new Error(code), { code }));
    document.head.append(script);
  });
}

async function importSheetFile(file) {
  if (!file) return;
  setDeliveryMessage(`파일을 읽는 중 · ${file.name}`);
  try {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith('.csv') || lowerName.endsWith('.tsv')) {
      const raw = await file.text();
      const matrix = lowerName.endsWith('.tsv') ? parseClipboardMatrix(raw) : parseDelimitedCsv(raw);
      await applyMatrix(matrix, { method: 'excel', sourceName: file.name, sheetName: file.name });
    } else {
      const XLSX = globalThis.__SMARTINPUT_EXTERNALS__?.XLSX || await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'XLSX', 'EXCEL_LIBRARY_UNAVAILABLE');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
      for (const sheetName of workbook.SheetNames) {
        const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
        if (matrix.some(row => row.some(value => text(value)))) await applyMatrix(matrix, { method: 'excel', sourceName: file.name, sheetName });
      }
    }
    setDeliveryMessage('파일 반영 완료', 'success');
  } catch (error) {
    setDeliveryMessage(`${error.code || 'FILE_IMPORT_ERROR'} · 파일 기능만 사용할 수 없습니다. 기존 작업행은 유지됩니다.`, 'error');
  } finally {
    $('sheetFileInput').value = '';
  }
}

function handlePhoto(file) {
  if (!file) return;
  state.photoFile = file;
  const reader = new FileReader();
  reader.onload = () => {
    state.photoDataUrl = String(reader.result || '');
    $('photoImage').src = state.photoDataUrl;
    $('photoImage').hidden = false;
    $('photoPreview').querySelector('span')?.remove();
    $('ocrButton').disabled = false;
    $('sourcePreview').textContent = `${file.name} · 이미지가 먼저 준비되었습니다.`;
    const record = { documentId: current().documentId, mode: state.draft.activeMode, fileName: file.name, mimeType: file.type, dataUrl: state.photoDataUrl, updatedAt: nowIso() };
    saveSourceImage(record).then(() => {
      state.sourceImages = [record, ...state.sourceImages.filter(item => item.documentId !== record.documentId)];
    }).catch(error => {
      $('ocrMessage').textContent = `원본 저장 오류 · ${error.message}`;
      $('ocrMessage').dataset.state = 'error';
    });
  };
  reader.onerror = () => {
    $('ocrMessage').textContent = '이미지를 읽지 못했습니다.';
    $('ocrMessage').dataset.state = 'error';
  };
  reader.readAsDataURL(file);
}

async function runOcr() {
  if (!state.photoFile) return;
  $('ocrButton').disabled = true;
  $('ocrMessage').textContent = 'OCR 라이브러리를 준비하고 분석하고 있습니다.';
  delete $('ocrMessage').dataset.state;
  try {
    const { recognizeOcrDocument, verifiedRowsToParserLines } = await import('./ocr-document-parser.js?v=0.1.1');
    const Tesseract = globalThis.__SMARTINPUT_EXTERNALS__?.Tesseract || await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js', 'Tesseract', 'OCR_LIBRARY_UNAVAILABLE');
    const analysis = await recognizeOcrDocument(state.photoFile, {
      Tesseract,
      onProgress: progress => { if (progress?.status) $('ocrMessage').textContent = `OCR 분석 중 · ${progress.status} ${Math.round(Number(progress.progress || 0) * 100)}%`; }
    });
    const batch = contract.createBatch({ sequence: current().batches.length + 1, method: 'photo', sourceType: 'IMAGE_OCR', sourceName: state.photoFile.name, rawText: analysis.text, contentHash: await sha256(state.photoDataUrl), sourceImageId: current().documentId, ocrStatus: analysis.status, ocrConfidence: analysis.confidence });
    const lines = verifiedRowsToParserLines(analysis, batch.batchId);
    current().batches.push(batch);
    current().sourceText = analysis.text || '';
    if (lines.length) current().rows = contract.applyParserResults(current().rows, batch, lines);
    renderSource();
    renderRows();
    scheduleSave();
    $('ocrMessage').textContent = lines.length ? `${lines.length}개 검증 행을 반영했습니다.` : '검증이 필요한 결과입니다. 기존 작업행은 변경하지 않았습니다.';
    $('ocrMessage').dataset.state = lines.length ? 'success' : 'error';
  } catch (error) {
    $('ocrMessage').textContent = `${error.code || 'OCR_ERROR'} · 사진 기능만 사용할 수 없습니다. 기존 작업행은 유지됩니다.`;
    $('ocrMessage').dataset.state = 'error';
  } finally {
    $('ocrButton').disabled = false;
  }
}

function toggleVoice() {
  if (state.voiceRecognition) {
    state.voiceRecognition.stop();
    return;
  }
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Recognition) {
    $('voiceMessage').textContent = 'VOICE_UNAVAILABLE · 이 브라우저에서는 음성 기능만 사용할 수 없습니다.';
    $('voiceMessage').dataset.state = 'error';
    return;
  }
  const recognition = new Recognition();
  state.voiceRecognition = recognition;
  recognition.lang = 'ko-KR';
  recognition.interimResults = false;
  $('voiceButton').textContent = '음성 입력 중지';
  $('voiceMessage').textContent = '듣고 있습니다.';
  recognition.onresult = event => {
    const transcript = [...event.results].map(result => result[0]?.transcript || '').join(' ');
    void analyzeText(transcript, 'voice');
  };
  recognition.onerror = event => {
    $('voiceMessage').textContent = `VOICE_ERROR · ${event.error || '음성 입력 실패'}`;
    $('voiceMessage').dataset.state = 'error';
  };
  recognition.onend = () => {
    state.voiceRecognition = null;
    $('voiceButton').textContent = '음성 입력 시작';
  };
  recognition.start();
}

function applyGridPaste(event) {
  const input = event.target.closest('input[data-field]');
  if (!input) return;
  const raw = event.clipboardData?.getData('text/plain') || '';
  if (!raw.includes('\t') && !raw.includes('\n')) return;
  event.preventDefault();
  const rowElement = input.closest('tr');
  const startRow = rowElement.dataset.virtualRow === 'true'
    ? current().rows.length
    : current().rows.findIndex(row => row.rowId === rowElement.dataset.rowId);
  if (startRow < 0) return;
  const plan = buildGridPastePlan(raw, {
    fieldDefinitions: contract.PRODUCT_FIELD_DEFINITIONS,
    visibleFieldIds: TABLE_FIELDS.map(field => field.id),
    startFieldId: input.dataset.field,
    numberParser: contract.numberOrNull
  });
  if (!plan.valid) return toast('붙여넣을 표 구조를 확인하세요.');
  plan.rows.forEach((sourceRow, offset) => {
    const rowIndex = startRow + offset;
    if (!current().rows[rowIndex]) current().rows.push(contract.normalizeRow());
    let next = current().rows[rowIndex];
    sourceRow.cells.forEach(cell => { next = contract.markUserEdit(next, cell.fieldId, cell.value); });
    current().rows[rowIndex] = next;
  });
  current().rows = contract.markDuplicatePossibilities(current().rows);
  renderRows();
  scheduleSave();
}

function validationErrors(mode, rows, header) {
  const errors = [];
  if (mode !== 'estimate' && !text(header.customerName)) errors.push('거래처명을 입력하세요.');
  if (!text(header.deliveryDate || header.voucherDate)) errors.push('전표 일자를 입력하세요.');
  if (mode !== 'estimate' && !text(header.warehouseName)) errors.push('창고를 입력하세요.');
  if (!rows.length) errors.push('상품을 1개 이상 입력하세요.');
  rows.forEach((row, index) => {
    if (!text(row.itemCode || row.itemName)) errors.push(`${index + 1}행 상품을 입력하세요.`);
    if (contract.numberOrNull(row.quantity) === null) errors.push(`${index + 1}행 수량을 입력하세요.`);
  });
  return errors;
}

function failedRowsOnly(results) {
  current().rows = rowsForFailedGroups(current().rows, results);
  current().voucherGroups = results.filter(result => !result.ok).map(result => ({ ...result.group, rows: undefined }));
}

async function completeOrder() {
  syncHeaderFromInputs();
  persistDraft();
  const mode = state.draft.activeMode;
  const modeDraft = current();
  const errors = validationErrors(mode, modeDraft.rows, modeDraft.header);
  if (errors.length) {
    setDeliveryMessage(errors[0], 'error');
    return;
  }
  if (mode === 'estimate') return saveEstimateDocument();
  const groups = groupVoucherRows(mode, modeDraft.rows, modeDraft.header);
  const results = [];
  $('completeButton').disabled = true;
  setDeliveryMessage(mode === 'order' ? 'ORDER Q 로컬 원장에 저장하고 있습니다.' : '서버 최종 확정을 요청하고 있습니다.');
  try {
    const completed = await executeVoucherGroups(groups, async group => {
        let result;
        if (mode === 'order') {
          const payload = buildOrderGroupPayload(group, {
            orderDate: modeDraft.header.voucherDate || modeDraft.header.deliveryDate,
            deliveryDate: modeDraft.header.deliveryDate,
            warehouseName: modeDraft.header.warehouseName,
            sourceType: 'SMART_INPUT',
            sourceId: modeDraft.documentId,
            sourceMessageKey: group.idempotencyKey,
            orderMessage: modeDraft.sourceText
          });
          payload.items = payload.items.map((row, index) => ({ ...row, lineNo: index + 1, finalQuantity: row.quantity, finalUnit: row.unit, price: row.unitPrice, rawQuantity: row.quantity, rawUnit: row.unit }));
          result = await saveOrderLocal(payload);
        } else {
          result = mode === 'purchase' ? await finalizePurchase(group) : await finalizeSale(group);
        }
        return result;
    });
    results.push(...completed);
    const succeeded = results.filter(result => result.ok);
    const failed = results.filter(result => !result.ok);
    if (mode === 'order') {
      for (const success of succeeded) {
        const orderId = success.result?.order?.orderId || success.result?.orderId;
        if (orderId) void syncOrderInBackground(orderId).then(
          () => setDeliveryMessage('로컬 저장 완료 · 백그라운드 동기화 완료', 'success'),
          error => setDeliveryMessage(`로컬 저장 완료 · ${error.code || '동기화 실패'} (로컬 성공 유지)`, 'error')
        );
      }
    }
    failedRowsOnly(results);
    modeDraft.delivery = {
      status: deliveryState(results),
      targetId: mode === 'order' ? 'orderq-local' : `official-${mode}`,
      targetRecordId: succeeded[0]?.result?.order?.orderId || '',
      deliveredAt: succeeded.length ? nowIso() : ''
    };
    persistDraft();
    renderRows();
    if (failed.length) {
      const code = failed[0].error?.code || failed[0].error?.message || 'FINALIZE_FAILED';
      setDeliveryMessage(`${code} · 실패한 ${failed.length}개 전표의 원본과 수정값을 유지했습니다.`, 'error');
    } else {
      setDeliveryMessage(`${succeeded.length}개 전표 저장 완료`, 'success');
    }
  } finally {
    $('completeButton').disabled = false;
  }
}

async function saveEstimateDocument() {
  const name = text($('estimateNameInput').value);
  if (!name) {
    setDeliveryMessage('견적서 이름을 입력하세요.', 'error');
    return;
  }
  const modeDraft = current();
  const timestamp = nowIso();
  const loaded = state.estimates.find(record => record.estimateId === modeDraft.catalogRecordId);
  const sameName = loaded && text(loaded.catalogName) === name;
  const estimateId = sameName ? loaded.estimateId : createRecordId('SIEST');
  const record = {
    estimateId,
    catalogName: name,
    customerId: modeDraft.header.customerId,
    customerName: modeDraft.header.customerName,
    rowCount: modeDraft.rows.length,
    amount: contract.summarizeRows(modeDraft.rows).amount,
    previousPrices: sameName ? buildCatalogPriceSnapshot(loaded.draft?.rows || []) : {},
    sortOrder: sameName ? Number(loaded.sortOrder || 1) : state.estimates.length + 1,
    createdAt: sameName ? loaded.createdAt : timestamp,
    updatedAt: timestamp,
    draft: JSON.parse(JSON.stringify({ ...modeDraft, catalogRecordId: estimateId }))
  };
  try {
    await saveEstimate(record);
    modeDraft.catalogRecordId = estimateId;
    modeDraft.catalogPreviousPrices = record.previousPrices;
    modeDraft.catalogBaselinePrices = buildCatalogPriceSnapshot(modeDraft.rows);
    modeDraft.delivery = { status: 'SAVED', targetId: 'smart-input-estimates', targetRecordId: estimateId, deliveredAt: timestamp };
    state.estimates = [record, ...state.estimates.filter(item => item.estimateId !== estimateId)];
    state.selectedEstimateName = name;
    persistDraft();
    setDeliveryMessage(sameName ? '같은 이름의 견적서를 수정했습니다.' : '새 견적서 복사본을 저장했습니다.', 'success');
  } catch (error) {
    setDeliveryMessage(`ESTIMATE_LOCAL_SAVE_ERROR · ${error.message} · 현재 작업은 유지됩니다.`, 'error');
  }
}

function openDraftDialog() {
  $('draftList').innerHTML = state.draftList.length ? state.draftList.map(item => `
    <div class="si-draft-row"><div><strong>${escapeHtml(MODE_COPY[item.mode]?.header || item.mode)}</strong><br><small>${escapeHtml(item.updatedAt || '')} · ${item.rows?.length || 0}행</small></div><button type="button" data-load-draft="${escapeHtml(item.documentId)}">불러오기</button></div>`).join('') : '<p>저장된 최근 초안이 없습니다.</p>';
  $('draftDialog').showModal();
}

function loadArchivedDraft(documentId) {
  const archived = state.draftList.find(item => item.documentId === documentId);
  if (!archived || !contract.MODES[archived.mode]) return;
  state.draft.modes[archived.mode] = contract.normalizeModeDraft(archived.mode, JSON.parse(JSON.stringify(archived)));
  state.draft.activeMode = archived.mode;
  persistDraft();
  renderAll();
  $('draftDialog').close();
}

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
document.querySelectorAll('[data-method]').forEach(button => button.addEventListener('click', () => setMethod(button.dataset.method)));
document.querySelectorAll('[data-reference]').forEach(element => element.querySelector('button').addEventListener('click', () => void refreshReference(element.dataset.reference)));

['customerInput', 'voucherDateInput', 'warehouseInput'].forEach(id => $(id).addEventListener('input', () => { syncHeaderFromInputs(); scheduleSave(); }));
$('estimateNameInput').addEventListener('input', event => { state.selectedEstimateName = event.target.value; });
$('directAddButton').addEventListener('click', () => addBlankRow());
$('addRowButton').addEventListener('click', () => addBlankRow());
$('analyzeTextButton').addEventListener('click', () => void analyzeText($('sourceTextInput').value, 'text'));
$('analyzePasteButton').addEventListener('click', () => void analyzeText($('pasteInput').value, 'paste'));
$('sheetChooseButton').addEventListener('click', () => $('sheetFileInput').click());
$('sheetFileInput').addEventListener('change', event => void importSheetFile(event.target.files?.[0]));
$('photoFileInput').addEventListener('change', event => handlePhoto(event.target.files?.[0]));
$('ocrButton').addEventListener('click', () => void runOcr());
$('voiceButton').addEventListener('click', toggleVoice);
$('saveDraftButton').addEventListener('click', () => {
  syncHeaderFromInputs();
  if (persistDraft({ archive: true })) toast('현재 전표를 최근 초안에 저장했습니다.');
});
$('completeButton').addEventListener('click', () => void completeOrder());
$('draftListButton').addEventListener('click', openDraftDialog);
$('draftList').addEventListener('click', event => { const button = event.target.closest('[data-load-draft]'); if (button) loadArchivedDraft(button.dataset.loadDraft); });

$('workTableBody').addEventListener('input', event => {
  const input = event.target.closest('input[data-field]');
  if (!input) return;
  const rowElement = input.closest('tr');
  let index = current().rows.findIndex(row => row.rowId === rowElement.dataset.rowId);
  if (index < 0 && text(input.value)) {
    index = materializeVirtualRow(rowElement);
    renderRowSummary();
  }
  if (index < 0) return;
  const field = input.dataset.field;
  const value = TABLE_FIELDS.find(item => item.id === field)?.numeric ? contract.numberOrNull(input.value) : input.value;
  current().rows[index] = ['itemCode', 'itemName'].includes(field)
    ? contract.markProductEdit(current().rows[index], field, value)
    : contract.markUserEdit(current().rows[index], field, value);
  scheduleSave();
});
$('workTableBody').addEventListener('change', renderRows);
$('workTableBody').addEventListener('paste', applyGridPaste);
$('workTableBody').addEventListener('click', event => {
  const button = event.target.closest('[data-delete-row]');
  if (!button) return;
  const rowId = button.closest('tr').dataset.rowId;
  current().rows = current().rows.filter(row => row.rowId !== rowId);
  renderRows();
  scheduleSave();
});

window.addEventListener('pagehide', () => { if (state.dirty) persistDraft(); });

globalThis.__SMARTINPUT_DEBUG__ = Object.freeze({
  getState: () => JSON.parse(JSON.stringify({ draft: state.draft, references: state.references, estimates: state.estimates })),
  persistDraft,
  setMode,
  refreshReference
});

renderAll();
globalThis.performance?.mark?.('smartinput-ready');
void loadLocalData();
refreshReferences();
