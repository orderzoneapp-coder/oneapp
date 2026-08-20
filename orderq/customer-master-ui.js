import {
  CUSTOMER_IMPORT_STATUS,
  applyCustomerImport,
  canApplyCustomerImport,
  createLiveCustomer,
  ensureCustomerMasterReady,
  getLatestCustomerImportWork,
  listCustomers,
  prepareCustomerImport,
  setCustomerImportDecision,
  updateCustomer
} from './customer-master.js?v=0.13.0';
import { openCustomerPicker } from './customer-picker.js?v=0.12.1';

const ROW_HEIGHT = window.matchMedia('(max-width: 820px)').matches ? 86 : 74;
const BUFFER_ROWS = 8;
const state = { customers: [], filtered: [], importBatch: null, importRecords: [], importIssuesOnly: true, importQuery: '', importLimit: 200 };
const elements = {
  viewport: document.querySelector('#customerViewport'),
  spacer: document.querySelector('#customerSpacer'),
  empty: document.querySelector('#customerEmpty'),
  search: document.querySelector('#customerSearch'),
  filter: document.querySelector('#customerFilter'),
  editor: document.querySelector('#customerEditor'),
  form: document.querySelector('#customerForm'),
  editorTitle: document.querySelector('#editorTitle'),
  importWorkbench: document.querySelector('#importWorkbench'),
  file: document.querySelector('#customerExcelFile'),
  importFileTitle: document.querySelector('#importFileTitle'),
  importSearch: document.querySelector('#importSearch'),
  importIssuesOnly: document.querySelector('#importIssuesOnly'),
  importSummary: document.querySelector('#importSummary'),
  importReview: document.querySelector('#importReview'),
  importGate: document.querySelector('#importGate'),
  applyImport: document.querySelector('#applyImportButton')
};

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function qualityLabel(customer) {
  if (customer.status === 'INACTIVE') return ['거래중단', 'inactive'];
  if (customer.qualityStatus === 'DUPLICATE_CANDIDATE') return ['중복 확인', 'warn'];
  if (customer.qualityStatus === 'UNVERIFIED') return ['정보 보완', 'warn'];
  return ['사용중', ''];
}

function renderWindow() {
  const count = state.filtered.length;
  elements.empty.hidden = count > 0;
  elements.viewport.hidden = count === 0;
  elements.spacer.style.height = `${count * ROW_HEIGHT}px`;
  const start = Math.max(0, Math.floor(elements.viewport.scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
  const visible = Math.ceil(elements.viewport.clientHeight / ROW_HEIGHT) + BUFFER_ROWS * 2;
  const end = Math.min(count, start + visible);
  elements.spacer.innerHTML = state.filtered.slice(start, end).map((customer, offset) => {
    const [label, className] = qualityLabel(customer);
    return `<button class="cm-row" type="button" data-id="${customer.customerId}" style="top:${(start + offset) * ROW_HEIGHT}px">
      <span>${escapeHtml(customer.customerCode || '-')}</span>
      <span><strong>${escapeHtml(customer.customerName)}</strong><small>${escapeHtml(customer.representativeName || customer.contactName || '')}</small></span>
      <span><strong>${escapeHtml(customer.phone || customer.mobile || '-')}</strong><small>${escapeHtml([customer.address, customer.addressDetail].filter(Boolean).join(' '))}</small></span>
      <span>${escapeHtml(customer.groupName || '-')}</span>
      <span class="cm-badge ${className}">${label}</span>
    </button>`;
  }).join('');
  elements.spacer.querySelectorAll('[data-id]').forEach(button => button.addEventListener('click', () => openEditor(state.customers.find(customer => customer.customerId === button.dataset.id))));
}

function applyFilter() {
  const query = elements.search.value.trim().toLocaleLowerCase('ko');
  const filter = elements.filter.value;
  state.filtered = state.customers.filter(customer => {
    const haystack = [customer.customerCode, customer.customerName, customer.phone, customer.mobile, customer.address, customer.contactName].join(' ').toLocaleLowerCase('ko');
    const queryMatch = !query || haystack.includes(query);
    const statusMatch = filter === 'ALL'
      || customer.status === filter
      || customer.qualityStatus === filter;
    return queryMatch && statusMatch;
  });
  elements.viewport.scrollTop = 0;
  renderWindow();
}

function renderStats() {
  document.querySelector('#totalCount').textContent = state.customers.length.toLocaleString();
  document.querySelector('#activeCount').textContent = state.customers.filter(row => row.status === 'ACTIVE').length.toLocaleString();
  document.querySelector('#unverifiedCount').textContent = state.customers.filter(row => row.qualityStatus === 'UNVERIFIED').length.toLocaleString();
  document.querySelector('#duplicateCount').textContent = state.customers.filter(row => row.qualityStatus === 'DUPLICATE_CANDIDATE').length.toLocaleString();
}

async function reload() {
  state.customers = await listCustomers({ includeInactive: true, includeSuperseded: false });
  renderStats();
  applyFilter();
}

function openEditor(customer = null) {
  elements.form.reset();
  elements.editorTitle.textContent = customer ? '거래처 수정' : '거래처 등록';
  const fields = ['customerId', 'revision', 'customerName', 'customerCode', 'representativeName', 'businessNumber', 'phone', 'mobile', 'contactName', 'contactPhone', 'groupName', 'priceGroup', 'status', 'address'];
  fields.forEach(field => {
    const input = elements.form.elements.namedItem(field);
    if (input) input.value = customer?.[field] ?? (field === 'status' ? 'ACTIVE' : '');
  });
  elements.editor.showModal();
}

async function saveEditor(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(elements.form).entries());
  try {
    if (data.customerId) {
      await updateCustomer(data.customerId, data, { expectedRevision: Number(data.revision) });
    } else {
      await createLiveCustomer(data, { source: 'MASTER_MANUAL_CREATE' });
    }
    elements.editor.close();
    await reload();
  } catch (error) {
    if (error.code === 'CUSTOMER_DUPLICATE_CANDIDATE') {
      if (confirm('비슷한 거래처가 있습니다. 그래도 새로 등록하시겠습니까?')) {
        await createLiveCustomer(data, { source: 'MASTER_MANUAL_CREATE', allowDuplicate: true });
        elements.editor.close();
        await reload();
      }
      return;
    }
    alert(error.message);
  }
}

async function sha256(file) {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function importStatusLabel(status) {
  return ({
    SAME: '연결됨', CHANGED: '변경확인', NEW: '신규', REVIEW_REQUIRED: '확인필요',
    APPLIED: '적용완료', FAILED: '실패', EXCLUDED: '제외'
  })[status] || status;
}

const IMPORT_FIELD_LABELS = Object.freeze({
  customerCode: '거래처코드', customerName: '거래처명', representativeName: '대표자', businessNumber: '사업자번호',
  businessType: '업태', businessItem: '종목', phone: '전화', fax: '팩스', mobile: '핸드폰', email: '이메일',
  postalCode: '우편번호', address: '주소', addressDetail: '상세주소', contactName: '담당자',
  contactPhone: '담당자연락처', groupName: '그룹', priceGroup: '단가그룹'
});
const ISSUE_STATUSES = new Set([
  CUSTOMER_IMPORT_STATUS.CHANGED,
  CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED,
  CUSTOMER_IMPORT_STATUS.NEW,
  CUSTOMER_IMPORT_STATUS.FAILED
]);

function importEffectiveStatus(record) {
  return record.status === CUSTOMER_IMPORT_STATUS.FAILED ? record.retryStatus : record.status;
}

function importVisibleRecords() {
  const query = state.importQuery.toLocaleLowerCase('ko');
  return state.importRecords.filter(record => {
    if (state.importIssuesOnly && !ISSUE_STATUSES.has(record.status)) return false;
    const incoming = record.incoming || {};
    const haystack = [incoming.customerCode, incoming.customerName, incoming.phone, incoming.mobile, incoming.address, incoming.contactName].join(' ').toLocaleLowerCase('ko');
    return !query || haystack.includes(query);
  });
}

function importFieldMarkup(record, customer) {
  if (importEffectiveStatus(record) !== CUSTOMER_IMPORT_STATUS.CHANGED) return '';
  return `<div class="cm-change-grid">${(record.changedFields || []).map(field => {
    const decision = record.fieldDecisions?.[field] || '';
    return `<label><span>${escapeHtml(IMPORT_FIELD_LABELS[field] || field)}</span><small>기존 ${escapeHtml(customer?.[field] || '-')} · 파일 ${escapeHtml(record.incoming?.[field] || '-')}</small><select data-field-decision="${record.sourceRecordId}" data-field="${field}"><option value="">선택</option><option value="USE_FILE" ${decision === 'USE_FILE' ? 'selected' : ''}>파일값 사용</option><option value="KEEP_EXISTING" ${decision === 'KEEP_EXISTING' ? 'selected' : ''}>기존값 유지</option></select></label>`;
  }).join('')}</div>`;
}

function importRecordMarkup(record) {
  const incoming = record.incoming || {};
  const effectiveStatus = importEffectiveStatus(record);
  const customer = state.customers.find(candidate => candidate.customerId === record.selectedCustomerId);
  const needsDecision = [CUSTOMER_IMPORT_STATUS.CHANGED, CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED, CUSTOMER_IMPORT_STATUS.FAILED].includes(record.status);
  let actions = '';
  if (effectiveStatus === CUSTOMER_IMPORT_STATUS.CHANGED) {
    actions = `<button class="cm-button mini" data-decide-all="${record.sourceRecordId}" data-choice="USE_FILE">파일값 모두</button><button class="cm-button mini" data-decide-all="${record.sourceRecordId}" data-choice="KEEP_EXISTING">기존값 모두</button>`;
  } else if ([CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED, CUSTOMER_IMPORT_STATUS.FAILED].includes(record.status)) {
    actions = `<button class="cm-button mini" data-resolve="${record.sourceRecordId}">찾기</button>${incoming.customerName ? `<button class="cm-button mini" data-mark-new="${record.sourceRecordId}">신규로 적용</button>` : ''}<button class="cm-button mini" data-exclude="${record.sourceRecordId}">제외</button>`;
  } else if (record.status === CUSTOMER_IMPORT_STATUS.NEW) {
    actions = '<span class="cm-plan-note">Master 적용 시 생성</span>';
  } else if (record.status === CUSTOMER_IMPORT_STATUS.SAME) {
    actions = `<span class="cm-plan-note">${escapeHtml(customer?.customerName || '기존 거래처 연결')}</span>`;
  }
  return `<article class="cm-review-row" data-status="${record.status}">
    <span class="cm-badge ${needsDecision ? 'warn' : ''}">${importStatusLabel(record.status)}</span>
    <div class="cm-review-identity"><strong>${escapeHtml(incoming.customerName || '(거래처명 없음)')}</strong><small>코드 ${escapeHtml(incoming.customerCode || '-')} · 행 ${record.rowNo}</small></div>
    <div class="cm-review-contact"><strong>${escapeHtml(incoming.phone || incoming.mobile || '-')}</strong><small>${escapeHtml([incoming.address, incoming.addressDetail].filter(Boolean).join(' ') || '-')}</small></div>
    <div class="cm-review-actions">${actions}</div>
    ${record.errorMessage ? `<p class="cm-import-error">${escapeHtml(record.errorMessage)}</p>` : ''}
    ${importFieldMarkup(record, customer)}
  </article>`;
}

function renderImport() {
  const counts = state.importRecords.reduce((map, row) => ({ ...map, [row.status]: (map[row.status] || 0) + 1 }), {});
  const statusOrder = [CUSTOMER_IMPORT_STATUS.SAME, CUSTOMER_IMPORT_STATUS.CHANGED, CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED, CUSTOMER_IMPORT_STATUS.NEW, CUSTOMER_IMPORT_STATUS.APPLIED, CUSTOMER_IMPORT_STATUS.FAILED, CUSTOMER_IMPORT_STATUS.EXCLUDED];
  elements.importSummary.innerHTML = `<span>전체 ${state.importRecords.length.toLocaleString()}</span>${statusOrder.filter(status => counts[status]).map(status => `<span>${importStatusLabel(status)} ${counts[status].toLocaleString()}</span>`).join('')}`;
  elements.importFileTitle.textContent = `${state.importBatch?.fileName || 'Excel'} 분석 ${state.importBatch?.status === 'PARTIAL' ? '부분적용' : '완료'}`;
  const unresolved = state.importRecords.filter(record => !canApplyCustomerImport([record])).length;
  elements.importGate.textContent = unresolved ? `확인할 거래처 ${unresolved.toLocaleString()}건을 해결하면 Master에 적용할 수 있습니다.` : `모든 결정이 완료되었습니다. ${state.importRecords.length.toLocaleString()}건을 적용할 수 있습니다.`;
  const visibleRecords = importVisibleRecords();
  const renderedRecords = visibleRecords.slice(0, state.importLimit);
  elements.importReview.innerHTML = renderedRecords.map(importRecordMarkup).join('') || '<div class="cm-import-empty">현재 조건에 맞는 거래처가 없습니다.</div>';
  if (visibleRecords.length > renderedRecords.length) elements.importReview.insertAdjacentHTML('beforeend', `<button class="cm-load-more" type="button" data-load-more>다음 ${Math.min(200, visibleRecords.length - renderedRecords.length).toLocaleString()}건 보기 · 전체 ${visibleRecords.length.toLocaleString()}건</button>`);
  elements.applyImport.disabled = !state.importRecords.length || !canApplyCustomerImport(state.importRecords);
  elements.importReview.querySelectorAll('[data-resolve]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.resolve);
    const customer = await openCustomerPicker({ initialName: record.incoming.customerName, source: 'IMPORT_REVIEW', allowQuickCreate: false });
    if (!customer) return;
    const changedFields = Object.keys(record.incoming).filter(field => record.incoming[field] && String(record.incoming[field]) !== String(customer[field] || ''));
    const updated = await setCustomerImportDecision(record.sourceRecordId, {
      status: changedFields.length ? CUSTOMER_IMPORT_STATUS.CHANGED : CUSTOMER_IMPORT_STATUS.SAME,
      selectedCustomerId: customer.customerId,
      changedFields,
      fieldDecisions: changedFields.length ? null : {}
    });
    Object.assign(record, updated);
    renderImport();
  }));
  elements.importReview.querySelectorAll('[data-mark-new]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.markNew);
    const updated = await setCustomerImportDecision(record.sourceRecordId, { status: CUSTOMER_IMPORT_STATUS.NEW, retryStatus: '', selectedCustomerId: '', candidateCustomerIds: [], changedFields: [], fieldDecisions: {}, errorMessage: '' });
    Object.assign(record, updated);
    renderImport();
  }));
  elements.importReview.querySelectorAll('[data-exclude]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.exclude);
    const updated = await setCustomerImportDecision(record.sourceRecordId, { status: CUSTOMER_IMPORT_STATUS.EXCLUDED, retryStatus: '', errorMessage: '' });
    Object.assign(record, updated);
    renderImport();
  }));
  elements.importReview.querySelectorAll('[data-field-decision]').forEach(select => select.addEventListener('change', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === select.dataset.fieldDecision);
    const fieldDecisions = { ...(record.fieldDecisions || {}) };
    if (select.value) fieldDecisions[select.dataset.field] = select.value;
    else delete fieldDecisions[select.dataset.field];
    const updated = await setCustomerImportDecision(record.sourceRecordId, { fieldDecisions, errorMessage: '' });
    Object.assign(record, updated);
    renderImport();
  }));
  elements.importReview.querySelectorAll('[data-decide-all]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.decideAll);
    const fieldDecisions = Object.fromEntries((record.changedFields || []).map(field => [field, button.dataset.choice]));
    const updated = await setCustomerImportDecision(record.sourceRecordId, { fieldDecisions, errorMessage: '' });
    Object.assign(record, updated);
    renderImport();
  }));
  elements.importReview.querySelector('[data-load-more]')?.addEventListener('click', () => { state.importLimit += 200; renderImport(); });
}

async function readExcel(file) {
  if (!window.XLSX) throw new Error('Excel 모듈을 불러오지 못했습니다.');
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  if (!workbook.SheetNames.length) throw new Error('Excel 시트를 찾을 수 없습니다.');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const headerRow = matrix.findIndex(row => row.some(value => String(value).trim() === '거래처명'));
  if (headerRow < 0) throw new Error('거래처명 열을 찾을 수 없습니다. 거래처정보 Excel 양식을 확인해 주세요.');
  const rows = window.XLSX.utils.sheet_to_json(sheet, { range: headerRow, defval: '', raw: false });
  if (!rows.length) throw new Error('불러올 거래처 데이터가 없습니다.');
  const prepared = await prepareCustomerImport(rows, { fileName: file.name, fileHash: await sha256(file) });
  state.importBatch = prepared.batch;
  state.importRecords = prepared.records;
  state.importLimit = 200;
  renderImport();
}

async function handleExcelSelection() {
  const file = elements.file.files?.[0];
  if (!file) return;
  state.importBatch = null;
  state.importRecords = [];
  elements.applyImport.disabled = true;
  elements.importSummary.innerHTML = `<span>${escapeHtml(file.name)} 분석 중...</span>`;
  elements.importReview.innerHTML = '<div class="cm-review-row"><strong>거래처 정보를 읽고 있습니다.</strong></div>';
  try {
    await readExcel(file);
  } catch (error) {
    console.error('Customer Excel import failed', error);
    elements.importSummary.innerHTML = `<span>불러오기 실패 · ${escapeHtml(file.name)}</span>`;
    elements.importReview.innerHTML = `<div class="cm-review-row"><strong>${escapeHtml(error.message || String(error))}</strong></div>`;
  } finally {
    elements.file.value = '';
  }
}

elements.viewport.addEventListener('scroll', renderWindow, { passive: true });
elements.search.addEventListener('input', applyFilter);
elements.filter.addEventListener('change', applyFilter);
elements.form.querySelectorAll('[data-close-customer-editor]').forEach(button => {
  button.addEventListener('click', () => elements.editor.close());
});
elements.form.addEventListener('submit', saveEditor);
document.querySelector('#newCustomerButton').addEventListener('click', () => openEditor());
document.querySelector('#openImportButton').addEventListener('click', () => { elements.importWorkbench.hidden = false; elements.importWorkbench.scrollIntoView({ behavior: 'smooth' }); });
document.querySelector('#closeImportButton').addEventListener('click', () => { elements.importWorkbench.hidden = true; });
elements.file.addEventListener('change', handleExcelSelection);
elements.importSearch.addEventListener('input', () => { state.importQuery = elements.importSearch.value.trim(); state.importLimit = 200; renderImport(); });
elements.importIssuesOnly.addEventListener('change', () => { state.importIssuesOnly = elements.importIssuesOnly.checked; state.importLimit = 200; renderImport(); });
elements.applyImport.addEventListener('click', async () => {
  elements.applyImport.disabled = true;
  elements.importGate.textContent = 'Master에 적용하고 있습니다...';
  try {
    const results = await applyCustomerImport(state.importBatch.importBatchId);
    results.forEach(result => {
      const record = state.importRecords.find(row => row.sourceRecordId === result.sourceRecordId);
      if (!record || [CUSTOMER_IMPORT_STATUS.SAME, CUSTOMER_IMPORT_STATUS.EXCLUDED].includes(result.status)) return;
      if (result.status === CUSTOMER_IMPORT_STATUS.FAILED) Object.assign(record, { status: result.status, retryStatus: result.retryStatus || record.retryStatus || record.status, errorMessage: result.error || '' });
      else Object.assign(record, { status: result.status, retryStatus: '', appliedCustomerId: result.customerId || record.appliedCustomerId, errorMessage: '' });
    });
    const failed = results.filter(result => result.status === CUSTOMER_IMPORT_STATUS.FAILED);
    state.importBatch.status = failed.length ? 'PARTIAL' : 'APPLIED';
    state.importIssuesOnly = failed.length > 0;
    elements.importIssuesOnly.checked = state.importIssuesOnly;
    renderImport();
    await reload();
  } catch (error) {
    elements.importGate.textContent = `적용 실패: ${error.message || error}`;
    elements.applyImport.disabled = false;
  }
});

async function initializeCustomerMaster() {
  await ensureCustomerMasterReady({ onLoading: message => { elements.empty.hidden = false; elements.empty.textContent = message; } });
  await reload();
  const pending = await getLatestCustomerImportWork();
  if (!pending) return;
  state.importBatch = pending.batch;
  state.importRecords = pending.records;
  elements.importWorkbench.hidden = false;
  renderImport();
}

initializeCustomerMaster().catch(error => { elements.empty.hidden = false; elements.empty.textContent = `거래처 정보를 불러오지 못했습니다: ${error.message}`; });
