import {
  CUSTOMER_IMPORT_STATUS,
  applyCustomerImport,
  canApplyCustomerImport,
  createLiveCustomer,
  ensureCustomerMasterReady,
  listCustomers,
  prepareCustomerImport,
  setCustomerImportDecision,
  updateCustomer
} from './customer-master.js?v=0.12.1';
import { openCustomerPicker } from './customer-picker.js?v=0.12.1';

const ROW_HEIGHT = window.matchMedia('(max-width: 820px)').matches ? 86 : 74;
const BUFFER_ROWS = 8;
const state = { customers: [], filtered: [], importBatch: null, importRecords: [] };
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
  importSummary: document.querySelector('#importSummary'),
  importReview: document.querySelector('#importReview'),
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

function renderImport() {
  const counts = state.importRecords.reduce((map, row) => ({ ...map, [row.status]: (map[row.status] || 0) + 1 }), {});
  elements.importSummary.innerHTML = Object.entries(counts).map(([status, count]) => `<span>${importStatusLabel(status)} ${count.toLocaleString()}</span>`).join('');
  elements.importReview.innerHTML = state.importRecords.map(record => {
    const needsDecision = record.status === CUSTOMER_IMPORT_STATUS.CHANGED || record.status === CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED;
    const action = record.status === CUSTOMER_IMPORT_STATUS.CHANGED
      ? `<button class="cm-button" data-use-file="${record.sourceRecordId}">파일 변경 적용</button>`
      : record.status === CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED
        ? `<button class="cm-button" data-resolve="${record.sourceRecordId}">거래처 찾기</button>`
        : '';
    return `<div class="cm-review-row">
      <span class="cm-badge ${needsDecision ? 'warn' : ''}">${importStatusLabel(record.status)}</span>
      <strong>${escapeHtml(record.incoming.customerName || '(거래처명 없음)')}</strong>
      <small>${escapeHtml((record.changedFields || []).join(', '))}</small>${action}
    </div>`;
  }).join('');
  elements.applyImport.disabled = !canApplyCustomerImport(state.importRecords);
  elements.importReview.querySelectorAll('[data-use-file]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.useFile);
    const fieldDecisions = Object.fromEntries((record.changedFields || []).map(field => [field, 'USE_FILE']));
    const updated = await setCustomerImportDecision(record.sourceRecordId, { fieldDecisions });
    Object.assign(record, updated);
    renderImport();
  }));
  elements.importReview.querySelectorAll('[data-resolve]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.resolve);
    const customer = await openCustomerPicker({ initialName: record.incoming.customerName, source: 'IMPORT_REVIEW' });
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
}

async function readExcel(file) {
  if (!window.XLSX) throw new Error('Excel 모듈을 불러오지 못했습니다.');
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = window.XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const prepared = await prepareCustomerImport(rows, { fileName: file.name, fileHash: await sha256(file) });
  state.importBatch = prepared.batch;
  state.importRecords = prepared.records;
  renderImport();
}

elements.viewport.addEventListener('scroll', renderWindow, { passive: true });
elements.search.addEventListener('input', applyFilter);
elements.filter.addEventListener('change', applyFilter);
elements.form.addEventListener('submit', saveEditor);
document.querySelector('#newCustomerButton').addEventListener('click', () => openEditor());
document.querySelector('#openImportButton').addEventListener('click', () => { elements.importWorkbench.hidden = false; elements.importWorkbench.scrollIntoView({ behavior: 'smooth' }); });
document.querySelector('#closeImportButton').addEventListener('click', () => { elements.importWorkbench.hidden = true; });
elements.importWorkbench.querySelector('.cm-drop').addEventListener('click', () => elements.file.click());
elements.file.addEventListener('change', () => elements.file.files[0] && readExcel(elements.file.files[0]).catch(error => alert(error.message)));
elements.applyImport.addEventListener('click', async () => {
  elements.applyImport.disabled = true;
  const results = await applyCustomerImport(state.importBatch.importBatchId);
  const failed = results.filter(result => result.status === CUSTOMER_IMPORT_STATUS.FAILED);
  alert(failed.length ? `${results.length - failed.length}건 적용, ${failed.length}건 실패` : `${results.length}건 적용 완료`);
  await reload();
});

ensureCustomerMasterReady({ onLoading: message => { elements.empty.hidden = false; elements.empty.textContent = message; } })
  .then(reload)
  .catch(error => { elements.empty.hidden = false; elements.empty.textContent = `거래처 정보를 불러오지 못했습니다: ${error.message}`; });
