import {
  CUSTOMER_IMPORT_STATUS,
  createLiveCustomer,
  ensureCustomerMasterReady,
  getCustomerCloudSyncState,
  listCustomers,
  searchCustomers,
  synchronizeCustomerMaster,
  updateCustomer
} from './customer-master.js?v=0.20.0';
import {
  CUSTOMER_SOURCE_MATCH_METHOD,
  CUSTOMER_SOURCE_MAPPING_VERSION,
  CUSTOMER_SOURCE_SYSTEM,
  applyCustomerSourceImport,
  canApplyCustomerSourceImport,
  getLatestCustomerSourceImportWork,
  listCustomerSourceLinks,
  prepareCustomerSourceImport,
  setCustomerSourceImportDecision
} from './customer-source-import.js?v=0.16.0';
import { openCustomerPicker } from './customer-picker.js?v=0.12.1';
import {
  CUSTOMER_COMPLETENESS_FIELDS,
  customerDisplayStatus,
  missingCustomerFields
} from './customer-completeness.js?v=0.1.0';
import {
  applyCustomerRestore,
  previewCustomerRestore,
  startCustomerFoundationWorker
} from './customer-foundation-backup.js?v=0.1.0';

const rowHeight = 48;
const BUFFER_ROWS = 8;
const state = {
  customers: [], filtered: [], importBatch: null, importRecords: [],
  importStatusFilter: 'ISSUES', importQuery: '', importLimit: 200,
  summaryFilter: 'ACTIVE_ALL', issueDrafts: new Map(), issueErrors: new Map(), issueFocusCustomerId: ''
};
const elements = {
  viewport: document.querySelector('#customerViewport'),
  spacer: document.querySelector('#customerSpacer'),
  empty: document.querySelector('#customerEmpty'),
  search: document.querySelector('#customerSearch'),
  filter: document.querySelector('#customerFilter'),
  group1Filter: document.querySelector('#customerGroup1Filter'),
  group2Filter: document.querySelector('#customerGroup2Filter'),
  managerFilter: document.querySelector('#customerManagerFilter'),
  standardList: document.querySelector('#customerStandardList'),
  issueEditor: document.querySelector('#customerIssueEditor'),
  issueGrid: document.querySelector('#customerIssueGrid'),
  issueChangeCount: document.querySelector('#customerIssueChangeCount'),
  saveIssues: document.querySelector('#saveCustomerIssues'),
  saveIssuesNext: document.querySelector('#saveCustomerIssuesNext'),
  editor: document.querySelector('#customerEditor'),
  form: document.querySelector('#customerForm'),
  editorTitle: document.querySelector('#editorTitle'),
  importWorkbench: document.querySelector('#importWorkbench'),
  erpFile: document.querySelector('#erpCustomerExcelFile'),
  shopFile: document.querySelector('#shopCustomerExcelFile'),
  importSourceLabel: document.querySelector('#importSourceLabel'),
  importFileTitle: document.querySelector('#importFileTitle'),
  importSearch: document.querySelector('#importSearch'),
  importSummary: document.querySelector('#importSummary'),
  importReview: document.querySelector('#importReview'),
  importGate: document.querySelector('#importGate'),
  applyImport: document.querySelector('#applyImportButton'),
  syncState: document.querySelector('#customerCloudSyncState'),
  backupNow: document.querySelector('#customerBackupNow'),
  restore: document.querySelector('#customerRestoreFromServer'),
  promote: document.querySelector('#customerPromoteDevice')
};

const IMPORT_FIELD_LABELS = Object.freeze({
  customerCode: '거래처코드', customerName: '거래처명', representativeName: '대표자', businessNumber: '사업자번호',
  businessType: '업태', businessItem: '종목', phone: '전화', fax: '팩스', mobile: '핸드폰', email: '이메일',
  postalCode: '우편번호', address: '주소', addressDetail: '상세주소', contactName: '담당자',
  contactPhone: '담당자연락처',
  group1Code: '거래처그룹1코드', group1Name: '그룹1',
  group2Code: '거래처그룹2코드', group2Name: '거래처그룹2명',
  priceGroupCode: '단가그룹코드', priceGroup: '단가그룹', paymentDay: '결제일',
  creditLimitAmount: '여신한도금액', creditPeriodDays: '여신기간(일)',
  bankAccountText: '계좌', transferInfo: '이체정보', memo: '적요', searchText: '검색창내용'
});
const ISSUE_STATUSES = new Set([
  CUSTOMER_IMPORT_STATUS.CHANGED, CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED,
  CUSTOMER_IMPORT_STATUS.FAILED
]);
const EVIDENCE_LABELS = Object.freeze({
  NAME_EXACT: '거래처명 일치', ALIAS_EXACT: '별칭 일치', PHONE_EXACT: '전화 일치', NAME_SIMILAR: '이름 유사'
});

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function qualityLabel(customer) {
  if (customer.status === 'INACTIVE') return ['거래중단', 'inactive'];
  if (customer.status === 'DELETED') return ['삭제', 'inactive'];
  const displayStatus = customerDisplayStatus(customer);
  if (displayStatus === 'DUPLICATE_CANDIDATE') return ['중복 확인', 'warn'];
  if (displayStatus === 'INCOMPLETE') return ['정보 보완', 'warn'];
  return ['정보 완료', ''];
}

function renderWindow() {
  const issueMode = state.summaryFilter === 'INCOMPLETE';
  elements.standardList.hidden = issueMode;
  elements.issueEditor.hidden = !issueMode;
  if (issueMode) {
    renderIssueGrid();
    return;
  }
  const count = state.filtered.length;
  elements.empty.hidden = count > 0;
  elements.viewport.hidden = count === 0;
  elements.spacer.style.height = `${count * rowHeight}px`;
  const start = Math.max(0, Math.floor(elements.viewport.scrollTop / rowHeight) - BUFFER_ROWS);
  const visible = Math.ceil(elements.viewport.clientHeight / rowHeight) + BUFFER_ROWS * 2;
  const end = Math.min(count, start + visible);
  elements.spacer.innerHTML = state.filtered.slice(start, end).map((customer, offset) => {
    const [label, className] = qualityLabel(customer);
    return `<button class="cm-row" type="button" data-id="${escapeHtml(customer.customerId)}" style="top:${(start + offset) * rowHeight}px">
      <span>${escapeHtml(customer.customerCode || '-')}</span>
      <span><strong>${escapeHtml(customer.customerName)}</strong><small>${escapeHtml(customer.representativeName || customer.contactName || '')}</small></span>
      <span><strong>${escapeHtml(customer.phone || customer.mobile || '-')}</strong><small>${escapeHtml([customer.address, customer.addressDetail].filter(Boolean).join(' '))}</small></span>
      <span>${escapeHtml(customer.group1Name || customer.groupName || '-')}</span>
      <span>${escapeHtml(customer.group2Name || '-')}</span>
      <span class="cm-badge ${className}">${label}</span>
    </button>`;
  }).join('');
  elements.spacer.querySelectorAll('[data-id]').forEach(button => button.addEventListener('click', () => {
    openEditor(state.customers.find(customer => customer.customerId === button.dataset.id));
  }));
}

const ISSUE_FIELDS = Object.freeze(['customerName', 'address', 'mobile']);

function issueValue(customer, field) {
  return state.issueDrafts.get(customer.customerId)?.[field] ?? customer[field] ?? '';
}

function renderIssueGrid() {
  elements.empty.hidden = state.filtered.length > 0;
  elements.issueEditor.hidden = state.filtered.length === 0;
  elements.issueGrid.innerHTML = state.filtered.map((customer, rowIndex) => {
    const effective = { ...customer, ...(state.issueDrafts.get(customer.customerId) || {}) };
    const missing = new Set(missingCustomerFields(effective).map(([field]) => field));
    const error = state.issueErrors.get(customer.customerId) || '';
    return `<tr data-customer-id="${escapeHtml(customer.customerId)}" class="${error ? 'has-error' : ''}">
    <th scope="row">${rowIndex + 1}</th>${ISSUE_FIELDS.map((field, columnIndex) => {
      const dirty = Object.hasOwn(state.issueDrafts.get(customer.customerId) || {}, field);
      return `<td class="${[dirty ? 'is-dirty' : '', missing.has(field) ? 'is-missing' : ''].filter(Boolean).join(' ')}"><input aria-label="${['상호', '주소', '휴대폰 번호'][columnIndex]} ${rowIndex + 1}행" data-issue-row="${rowIndex}" data-issue-column="${columnIndex}" data-issue-field="${field}" value="${escapeHtml(issueValue(customer, field))}"></td>`;
    }).join('')}<td class="cm-issue-reason">${error ? `<strong>저장 실패</strong><span>${escapeHtml(error)}</span>` : `<span>${missing.size ? [...missing].map(field => `${CUSTOMER_COMPLETENESS_FIELDS.find(([key]) => key === field)?.[1]} 없음`).join(' · ') : '정보 완료'}</span>`}</td></tr>`;
  }).join('');
  renderIssueChangeCount();
  if (state.issueFocusCustomerId) {
    requestAnimationFrame(() => elements.issueGrid.querySelector(`[data-customer-id="${CSS.escape(state.issueFocusCustomerId)}"] input`)?.focus());
    state.issueFocusCustomerId = '';
  }
}

function renderIssueChangeCount() {
  const count = [...state.issueDrafts.values()].reduce((total, patch) => total + Object.keys(patch).length, 0);
  elements.issueChangeCount.textContent = `변경 ${count.toLocaleString()}건`;
  elements.saveIssues.textContent = `변경 ${count.toLocaleString()}건 저장`;
  elements.saveIssues.disabled = count === 0;
  elements.saveIssuesNext.disabled = count === 0;
}

function setIssueValue(input, value) {
  const customer = state.filtered[Number(input.dataset.issueRow)];
  if (!customer) return;
  const field = input.dataset.issueField;
  const next = String(value ?? '');
  const draft = { ...(state.issueDrafts.get(customer.customerId) || {}) };
  if (next === String(customer[field] ?? '')) delete draft[field];
  else draft[field] = next;
  if (Object.keys(draft).length) state.issueDrafts.set(customer.customerId, draft);
  else state.issueDrafts.delete(customer.customerId);
  input.value = next;
  input.closest('td').classList.toggle('is-dirty', Object.hasOwn(draft, field));
  state.issueErrors.delete(customer.customerId);
  const effective = { ...customer, ...draft };
  const missing = new Set(missingCustomerFields(effective).map(([key]) => key));
  const row = input.closest('tr');
  row.classList.remove('has-error');
  row.querySelectorAll('[data-issue-field]').forEach(cell => cell.closest('td').classList.toggle('is-missing', missing.has(cell.dataset.issueField)));
  row.querySelector('.cm-issue-reason').innerHTML = `<span>${missing.size ? [...missing].map(key => `${CUSTOMER_COMPLETENESS_FIELDS.find(([fieldKey]) => fieldKey === key)?.[1]} 없음`).join(' · ') : '정보 완료'}</span>`;
  renderIssueChangeCount();
}

function focusIssueCell(row, column) {
  const boundedRow = Math.max(0, Math.min(state.filtered.length - 1, row));
  const boundedColumn = Math.max(0, Math.min(ISSUE_FIELDS.length - 1, column));
  elements.issueGrid.querySelector(`[data-issue-row="${boundedRow}"][data-issue-column="${boundedColumn}"]`)?.focus();
}

function populateFilter(select, values, label) {
  const selected = select.value;
  select.innerHTML = `<option value="ALL">${label} 전체</option>${[...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko')).map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
  select.value = [...select.options].some(option => option.value === selected) ? selected : 'ALL';
}

async function applyFilter() {
  const query = elements.search.value.trim().toLocaleLowerCase('ko');
  const filter = elements.filter.value;
  const group1 = elements.group1Filter.value;
  const group2 = elements.group2Filter.value;
  const manager = elements.managerFilter.value;
  const matchedIds = query
    ? new Set((await searchCustomers(query, { limit: 10000, includeInactive: true })).map(item => item.customer.customerId))
    : null;
  state.filtered = state.customers.filter(customer => {
    return (!matchedIds || matchedIds.has(customer.customerId))
      && (filter === 'ALL' || customer.status === filter || customerDisplayStatus(customer) === filter)
      && (state.summaryFilter === 'NONE' || (state.summaryFilter === 'ACTIVE_ALL'
        ? customerDisplayStatus(customer) !== 'EXCLUDED'
        : customerDisplayStatus(customer) === state.summaryFilter))
      && (group1 === 'ALL' || (customer.group1Name || customer.groupName || '') === group1)
      && (group2 === 'ALL' || (customer.group2Name || '') === group2)
      && (manager === 'ALL' || (customer.contactName || '') === manager);
  });
  elements.viewport.scrollTop = 0;
  renderWindow();
}

function renderStats() {
  const counts = state.customers.reduce((result, customer) => {
    const status = customerDisplayStatus(customer);
    if (status !== 'EXCLUDED') result.total += 1;
    if (status === 'COMPLETE') result.complete += 1;
    if (status === 'INCOMPLETE') result.incomplete += 1;
    if (status === 'DUPLICATE_CANDIDATE') result.duplicate += 1;
    return result;
  }, { total: 0, complete: 0, incomplete: 0, duplicate: 0 });
  document.querySelector('#totalCount').textContent = counts.total.toLocaleString();
  document.querySelector('#activeCount').textContent = counts.complete.toLocaleString();
  document.querySelector('#unverifiedCount').textContent = counts.incomplete.toLocaleString();
  document.querySelector('#duplicateCount').textContent = counts.duplicate.toLocaleString();
}

async function reload() {
  state.customers = await listCustomers({ includeInactive: true, includeSuperseded: false });
  populateFilter(elements.group1Filter, state.customers.map(customer => customer.group1Name || customer.groupName || ''), '그룹1');
  populateFilter(elements.group2Filter, state.customers.map(customer => customer.group2Name || ''), '그룹2');
  populateFilter(elements.managerFilter, state.customers.map(customer => customer.contactName || ''), '담당자');
  elements.empty.textContent = state.customers.length ? '조건에 맞는 거래처가 없습니다.' : '등록된 거래처가 없습니다.';
  renderStats();
  await applyFilter();
}

function syncErrorText(error) {
  return error?.message || String(error || '');
}

async function renderCloudSyncState(result = null) {
  const sync = await getCustomerCloudSyncState();
  const status = result?.status || sync.status || 'LOCAL_OK_BACKUP_PENDING';
  const labels = {
    LOCAL_OK_BACKUP_OK: '로컬 정상 · 백업 완료',
    LOCAL_OK_BACKUP_PENDING: `로컬 정상 · 변경 ${sync.pending}건 백업 대기`,
    BACKUP_IN_PROGRESS: '백업 진행 중 · 로컬 업무 정상',
    BACKUP_FAILED: '서버 백업 실패 · 로컬 업무 정상',
    DIVERGED: '서버에 더 최신 버전 있음 · 관리자 확인 필요',
    REVISION_AHEAD_INVALID: '서버 또는 계보 이상 · 별도 복구 필요',
    NON_PRIMARY: '조회 전용 · 주 운영 장치가 아님',
    RESTORE_REQUIRED: '로컬 거래처 없음 · 관리자 서버 복구 필요'
  };
  const label = labels[status] || labels.LOCAL_OK_BACKUP_PENDING;
  elements.syncState.dataset.state = ['BACKUP_FAILED'].includes(status) || sync.retry ? 'error'
    : ['DIVERGED', 'REVISION_AHEAD_INVALID', 'NON_PRIMARY', 'RESTORE_REQUIRED'].includes(status) || sync.conflicts ? 'conflict'
      : status === 'BACKUP_IN_PROGRESS' ? 'syncing' : 'online';
  const labelNode = elements.syncState.querySelector('#customerBackupLabel');
  const detailNode = elements.syncState.querySelector('#customerBackupDetail');
  if (labelNode) labelNode.textContent = label;
  if (detailNode) detailNode.textContent = `백업 대기 ${sync.pending} · 재시도 ${sync.retry} · 계보 문제 ${sync.conflicts} · 기존 큐 격리 ${sync.quarantineCount || 0}`;
}

async function syncAndReload() {
  await reload();
  await renderCloudSyncState();
  return { status: 'LOCAL_OK_BACKUP_PENDING' };
}

async function openEditor(customer = null) {
  elements.form.reset();
  elements.editorTitle.textContent = customer ? '거래처 수정' : '거래처 등록';
  const fields = [
    'customerId', 'revision', 'customerName', 'customerCode', 'representativeName',
    'businessNumber', 'businessType', 'businessItem', 'phone', 'fax', 'mobile',
    'email', 'postalCode', 'address', 'addressDetail', 'contactName', 'contactPhone',
    'group1Code', 'group1Name', 'group2Code', 'group2Name', 'priceGroupCode', 'priceGroup',
    'paymentDay', 'creditLimitAmount', 'creditPeriodDays', 'bankAccountText', 'transferInfo',
    'memo', 'searchText', 'status'
  ];
  fields.forEach(field => {
    const input = elements.form.elements.namedItem(field);
    if (input) input.value = customer?.[field] ?? (field === 'status' ? 'ACTIVE' : '');
  });
  const sourceLinkPanel = elements.form.querySelector('[data-customer-source-links]');
  if (sourceLinkPanel) {
    const links = customer ? await listCustomerSourceLinks({ customerId: customer.customerId }) : [];
    sourceLinkPanel.innerHTML = links.length
      ? links.map(link => `<span class="cm-badge">${escapeHtml(link.sourceSystem)} · ${escapeHtml(link.sourceCustomerCode)} · ${escapeHtml(link.sourceCustomerName || '')}</span>`).join('')
      : '<small>연결된 ERP/SHOP 계정이 없습니다.</small>';
  }
  elements.editor.showModal();
}

async function saveEditor(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(elements.form).entries());
  try {
    if (data.customerId) await updateCustomer(data.customerId, data, { expectedRevision: Number(data.revision) });
    else await createLiveCustomer(data, { source: 'MASTER_MANUAL_CREATE' });
    elements.editor.close();
    await reload();
    await syncAndReload();
  } catch (error) {
    if (error.code === 'CUSTOMER_DUPLICATE_CANDIDATE') {
      if (confirm('비슷한 거래처가 있습니다. 그래도 새로 등록하시겠습니까?')) {
        await createLiveCustomer(data, { source: 'MASTER_MANUAL_CREATE', allowDuplicate: true });
        elements.editor.close();
        await reload();
        await syncAndReload();
      }
      return;
    }
    alert(error.message || error);
  }
}

function fallbackFileHash(buffer, file) {
  let hash = 0x811c9dc5;
  for (const value of new Uint8Array(buffer)) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${file.size}`;
}

async function sha256(file) {
  const buffer = await file.arrayBuffer();
  const fallback = fallbackFileHash(buffer, file);
  if (!globalThis.crypto?.subtle) return fallback;
  let timeoutId = null;
  try {
    const hash = await Promise.race([
      crypto.subtle.digest('SHA-256', buffer),
      new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('파일 해시 계산 시간 초과')), 5000); })
    ]);
    return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    console.warn('Customer import uses the deterministic fallback file hash', error);
    return fallback;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function importStatusLabel(status) {
  return ({
    SAME: '연결됨', CHANGED: '변경확인', NEW: '신규', REVIEW_REQUIRED: '확인필요',
    APPLIED: '적용완료', FAILED: '적용실패', EXCLUDED: '제외'
  })[status] || status;
}

function importEffectiveStatus(record) {
  return record.status === CUSTOMER_IMPORT_STATUS.FAILED ? record.retryStatus : record.status;
}

function importVisibleRecords() {
  const query = state.importQuery.toLocaleLowerCase('ko');
  return state.importRecords.filter(record => {
    if (state.importStatusFilter === 'ISSUES' && canApplyCustomerSourceImport([record])) return false;
    if (!['ISSUES', 'ALL'].includes(state.importStatusFilter) && record.status !== state.importStatusFilter) return false;
    const incoming = record.incoming || {};
    const haystack = [record.sourceCustomerCode, record.sourceCustomerName, record.sourceNickname, incoming.phone, incoming.mobile, record.sourceAddress, incoming.contactName].join(' ').toLocaleLowerCase('ko');
    return !query || haystack.includes(query);
  });
}

function changedFieldsFor(record, customer) {
  return Object.keys(IMPORT_FIELD_LABELS).filter(field => {
    const fileValue = String(record.incoming?.[field] ?? '').trim();
    return fileValue && fileValue !== String(customer?.[field] ?? '').trim();
  });
}

function sourceCodeLabel() {
  return state.importBatch?.sourceSystem === CUSTOMER_SOURCE_SYSTEM.SHOP ? '회원 아이디' : 'ERP 코드';
}

function candidateMarkup(record) {
  if (!record.candidateCustomerIds?.length) return '';
  return `<div class="cm-change-grid">${record.candidateCustomerIds.slice(0, 4).map(customerId => {
    const customer = state.customers.find(row => row.customerId === customerId);
    if (!customer) return '';
    const evidence = (record.candidateEvidence || []).find(row => row.customerId === customerId);
    const reasons = (evidence?.reasons || []).map(reason => EVIDENCE_LABELS[reason] || reason).join(' · ');
    return `<label><span>${escapeHtml(customer.customerName)}</span><small>${escapeHtml([customer.businessNumber, customer.phone || customer.mobile, reasons].filter(Boolean).join(' · '))}</small></label>`;
  }).join('')}</div>`;
}

function importFieldMarkup(record, customer) {
  if (importEffectiveStatus(record) !== CUSTOMER_IMPORT_STATUS.CHANGED) return '';
  return `<div class="cm-change-grid">${(record.changedFields || []).map(field => {
    const decision = record.fieldDecisions?.[field] || '';
    return `<label><span>${escapeHtml(IMPORT_FIELD_LABELS[field] || field)}</span><small>기존 ${escapeHtml(customer?.[field] || '-')} · 파일 ${escapeHtml(record.incoming?.[field] || '-')}</small><select data-field-decision="${escapeHtml(record.sourceRecordId)}" data-field="${escapeHtml(field)}"><option value="">선택</option><option value="USE_FILE" ${decision === 'USE_FILE' ? 'selected' : ''}>파일값 사용</option><option value="KEEP_EXISTING" ${decision === 'KEEP_EXISTING' ? 'selected' : ''}>기존값 유지</option></select></label>`;
  }).join('')}</div>`;
}

function importRecordMarkup(record) {
  const incoming = record.incoming || {};
  const effectiveStatus = importEffectiveStatus(record);
  const customer = state.customers.find(candidate => candidate.customerId === record.selectedCustomerId);
  const recommendedId = record.candidateCustomerIds?.[0] || '';
  const recommended = state.customers.find(candidate => candidate.customerId === recommendedId);
  const needsDecision = ISSUE_STATUSES.has(record.status);
  let actions = '';
  if (effectiveStatus === CUSTOMER_IMPORT_STATUS.CHANGED) {
    actions = `<button class="cm-button mini" data-decide-all="${record.sourceRecordId}" data-choice="USE_FILE">파일값 모두</button><button class="cm-button mini" data-decide-all="${record.sourceRecordId}" data-choice="KEEP_EXISTING">기존값 모두</button>`;
  } else if (effectiveStatus === CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED) {
    actions = `${recommended ? `<button class="cm-button mini" data-recommend="${record.sourceRecordId}" data-customer-id="${recommended.customerId}">${escapeHtml(recommended.customerName)} 연결</button>` : ''}<button class="cm-button mini" data-resolve="${record.sourceRecordId}">다른 거래처 찾기</button>${incoming.customerName ? `<button class="cm-button mini" data-mark-new="${record.sourceRecordId}">신규등록</button>` : ''}<button class="cm-button mini" data-exclude="${record.sourceRecordId}">제외</button>`;
  } else if (effectiveStatus === CUSTOMER_IMPORT_STATUS.NEW) {
    actions = record.newDraftConfirmed
      ? '<span class="cm-plan-note">Master 적용 시 신규 생성</span>'
      : `<button class="cm-button mini" data-mark-new="${record.sourceRecordId}">신규등록</button><button class="cm-button mini" data-resolve="${record.sourceRecordId}">기존 거래처 찾기</button><button class="cm-button mini" data-exclude="${record.sourceRecordId}">제외</button>`;
  } else if (record.status === CUSTOMER_IMPORT_STATUS.SAME) {
    actions = `<span class="cm-plan-note">${escapeHtml(customer?.customerName || '대표 거래처 연결')}</span>`;
  }
  return `<article class="cm-review-row" data-status="${escapeHtml(record.status)}">
    <span class="cm-badge ${needsDecision ? 'warn' : ''}">${importStatusLabel(record.status)}</span>
    <div class="cm-review-identity"><strong>${escapeHtml(record.sourceCustomerName || '(거래처명 없음)')}</strong><small>${sourceCodeLabel()} ${escapeHtml(record.sourceCustomerCode || '-')} · 행 ${record.rowNo}</small></div>
    <div class="cm-review-contact"><strong>${escapeHtml(incoming.phone || incoming.mobile || '-')}</strong><small>${escapeHtml(record.sourceAddress || '-')}</small></div>
    <div class="cm-review-actions">${actions}</div>
    ${record.validationError ? `<p class="cm-import-error">${escapeHtml(record.validationError)}</p>` : ''}
    ${record.errorMessage ? `<p class="cm-import-error">${escapeHtml(record.errorMessage)}</p>` : ''}
    ${effectiveStatus === CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED ? candidateMarkup(record) : ''}
    ${importFieldMarkup(record, customer)}
  </article>`;
}

async function chooseCustomer(record, customer) {
  if (!customer) return;
  const changedFields = changedFieldsFor(record, customer);
  const updated = await setCustomerSourceImportDecision(record.sourceRecordId, {
    status: changedFields.length ? CUSTOMER_IMPORT_STATUS.CHANGED : CUSTOMER_IMPORT_STATUS.SAME,
    retryStatus: '', selectedCustomerId: customer.customerId,
    matchMethod: CUSTOMER_SOURCE_MATCH_METHOD.ADMIN_SELECTED,
    changedFields, fieldDecisions: changedFields.length ? null : {},
    newDraftConfirmed: false, validationError: '', errorMessage: ''
  });
  Object.assign(record, updated);
  renderImport();
}

function bindImportActions() {
  elements.importSummary.querySelectorAll('[data-import-status]').forEach(button => button.addEventListener('click', () => {
    state.importStatusFilter = button.dataset.importStatus;
    state.importLimit = 200;
    renderImport();
  }));
  elements.importReview.querySelectorAll('[data-recommend]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.recommend);
    await chooseCustomer(record, state.customers.find(row => row.customerId === button.dataset.customerId));
  }));
  elements.importReview.querySelectorAll('[data-resolve]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.resolve);
    const customer = await openCustomerPicker({ initialName: record.sourceCustomerName, source: `${record.sourceSystem}_IMPORT_REVIEW`, allowQuickCreate: false });
    if (customer) await chooseCustomer(record, customer);
  }));
  elements.importReview.querySelectorAll('[data-mark-new]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.markNew);
    const updated = await setCustomerSourceImportDecision(record.sourceRecordId, {
      status: CUSTOMER_IMPORT_STATUS.NEW, retryStatus: '', selectedCustomerId: '',
      matchMethod: CUSTOMER_SOURCE_MATCH_METHOD.ADMIN_NEW, changedFields: [], fieldDecisions: {},
      newDraftConfirmed: true, validationError: '', errorMessage: ''
    });
    Object.assign(record, updated);
    renderImport();
  }));
  elements.importReview.querySelectorAll('[data-exclude]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.exclude);
    const updated = await setCustomerSourceImportDecision(record.sourceRecordId, { status: CUSTOMER_IMPORT_STATUS.EXCLUDED, retryStatus: '', errorMessage: '' });
    Object.assign(record, updated);
    renderImport();
  }));
  elements.importReview.querySelectorAll('[data-field-decision]').forEach(select => select.addEventListener('change', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === select.dataset.fieldDecision);
    const fieldDecisions = { ...(record.fieldDecisions || {}) };
    if (select.value) fieldDecisions[select.dataset.field] = select.value;
    else delete fieldDecisions[select.dataset.field];
    Object.assign(record, await setCustomerSourceImportDecision(record.sourceRecordId, { fieldDecisions, errorMessage: '' }));
    renderImport();
  }));
  elements.importReview.querySelectorAll('[data-decide-all]').forEach(button => button.addEventListener('click', async () => {
    const record = state.importRecords.find(row => row.sourceRecordId === button.dataset.decideAll);
    const fieldDecisions = Object.fromEntries((record.changedFields || []).map(field => [field, button.dataset.choice]));
    Object.assign(record, await setCustomerSourceImportDecision(record.sourceRecordId, { fieldDecisions, errorMessage: '' }));
    renderImport();
  }));
  elements.importReview.querySelector('[data-load-more]')?.addEventListener('click', () => { state.importLimit += 200; renderImport(); });
}

function renderImport() {
  const counts = state.importRecords.reduce((map, row) => ({ ...map, [row.status]: (map[row.status] || 0) + 1 }), {});
  const unresolved = state.importRecords.filter(record => !canApplyCustomerSourceImport([record])).length;
  const filters = [
    ['ISSUES', '확인할 항목', unresolved],
    ['ALL', '전체', state.importRecords.length],
    [CUSTOMER_IMPORT_STATUS.SAME, '연결됨', counts[CUSTOMER_IMPORT_STATUS.SAME] || 0],
    [CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED, '확인필요', counts[CUSTOMER_IMPORT_STATUS.REVIEW_REQUIRED] || 0],
    [CUSTOMER_IMPORT_STATUS.NEW, '신규', counts[CUSTOMER_IMPORT_STATUS.NEW] || 0],
    [CUSTOMER_IMPORT_STATUS.CHANGED, '변경확인', counts[CUSTOMER_IMPORT_STATUS.CHANGED] || 0],
    [CUSTOMER_IMPORT_STATUS.FAILED, '적용실패', counts[CUSTOMER_IMPORT_STATUS.FAILED] || 0]
  ];
  elements.importSummary.innerHTML = filters
    .filter(([value, , count]) => ![CUSTOMER_IMPORT_STATUS.FAILED].includes(value) || count)
    .map(([value, label, count]) => `<button type="button" data-import-status="${value}" class="cm-summary-filter ${state.importStatusFilter === value ? 'active' : ''}">${label} <strong>${count.toLocaleString()}</strong>${value === CUSTOMER_IMPORT_STATUS.NEW && count ? '<small>일괄 등록 예정</small>' : ''}</button>`)
    .join('');
  const sourceLabel = state.importBatch?.sourceSystem === CUSTOMER_SOURCE_SYSTEM.SHOP ? '쇼핑몰 회원' : 'ERP 거래처';
  elements.importWorkbench.dataset.phase = 'READY';
  elements.importSourceLabel.textContent = `${sourceLabel} 가져오기`;
  elements.importFileTitle.textContent = `${state.importBatch?.fileName || sourceLabel} · ${state.importRecords.length.toLocaleString()}건 분석 ${state.importBatch?.status === 'PARTIAL' ? '부분적용' : '완료'}`;
  elements.importGate.textContent = unresolved
    ? `분석 결과 ${state.importRecords.length.toLocaleString()}건 저장 완료 · ${unresolved.toLocaleString()}건 확인 필요`
    : `분석 결과 ${state.importRecords.length.toLocaleString()}건 저장 완료 · 적용 준비 완료`;
  const visibleRecords = importVisibleRecords();
  const renderedRecords = visibleRecords.slice(0, state.importLimit);
  elements.importReview.innerHTML = renderedRecords.map(importRecordMarkup).join('') || '<div class="cm-import-empty">현재 조건에 맞는 거래처가 없습니다.</div>';
  if (visibleRecords.length > renderedRecords.length) elements.importReview.insertAdjacentHTML('beforeend', `<button class="cm-load-more" type="button" data-load-more>다음 ${Math.min(200, visibleRecords.length - renderedRecords.length).toLocaleString()}건 보기 · 전체 ${visibleRecords.length.toLocaleString()}건</button>`);
  elements.applyImport.disabled = !state.importRecords.length || !canApplyCustomerSourceImport(state.importRecords);
  if (state.importBatch?.sourceSystem === CUSTOMER_SOURCE_SYSTEM.ERP) {
    elements.importGate.textContent = `${CUSTOMER_SOURCE_MAPPING_VERSION} · 17/17열 인식 · 분석결과 ${state.importRecords.length.toLocaleString()}건 저장`;
  }
  bindImportActions();
}

function bindImportRetry(sourceSystem) {
  elements.importSummary.querySelector('[data-retry-import]')?.addEventListener('click', () => {
    openFilePicker(sourceSystem === CUSTOMER_SOURCE_SYSTEM.SHOP ? elements.shopFile : elements.erpFile);
  });
}

function renderImportFailure(error, fileName, sourceSystem) {
  const processed = Number(error?.processedCount || 0);
  const total = Number(error?.totalCount || 0);
  const progress = total ? `${processed.toLocaleString()} / ${total.toLocaleString()} 처리 후 실패` : '분석 실패';
  elements.importWorkbench.dataset.phase = 'ERROR';
  elements.importSourceLabel.textContent = sourceSystem === CUSTOMER_SOURCE_SYSTEM.SHOP ? '쇼핑몰 회원 가져오기' : 'ERP 거래처 가져오기';
  elements.importFileTitle.textContent = fileName || '거래처 파일';
  elements.importSummary.innerHTML = `<div class="cm-progress-copy"><strong>${progress}</strong><button class="cm-button mini" type="button" data-retry-import>다시 시도</button></div>`;
  elements.importReview.innerHTML = '';
  elements.importGate.textContent = `IndexedDB 오류: ${error?.message || error}`;
  bindImportRetry(sourceSystem);
}

function renderPreparingImport(batch, records) {
  const processed = Number(batch.processedCount || records.length || 0);
  const total = Number(batch.rowCount || 0);
  const percent = total ? Math.round((processed / total) * 100) : 0;
  elements.importWorkbench.hidden = false;
  elements.importWorkbench.dataset.phase = 'ERROR';
  elements.importSourceLabel.textContent = batch.sourceSystem === CUSTOMER_SOURCE_SYSTEM.SHOP ? '쇼핑몰 회원 가져오기' : 'ERP 거래처 가져오기';
  elements.importFileTitle.textContent = batch.fileName || '거래처 파일';
  elements.importSummary.innerHTML = `<div class="cm-progress-copy"><strong>${processed.toLocaleString()} / ${total.toLocaleString()} 저장됨 · ${percent}%</strong><button class="cm-button mini" type="button" data-retry-import>같은 파일로 계속</button></div><div class="cm-progress-track"><span style="width:${percent}%"></span></div>`;
  elements.importReview.innerHTML = '';
  elements.importGate.textContent = batch.lastError ? `이전 오류: ${batch.lastError}` : '동일 파일을 다시 선택하면 저장된 다음 행부터 계속합니다.';
  bindImportRetry(batch.sourceSystem);
}

function findHeaderRow(matrix, sourceSystem) {
  return matrix.findIndex(row => {
    const headers = row.map(value => String(value).trim());
    const hasName = headers.includes('거래처명') || headers.includes('이름(거래처명)');
    if (sourceSystem === CUSTOMER_SOURCE_SYSTEM.SHOP) return hasName && headers.includes('아이디');
    const hasCode = ['거래처코드', '코드', '사업자번호 (거래처코드)', '사업자번호(거래처코드)'].some(header => headers.includes(header));
    return hasName && hasCode;
  });
}

async function readExcel(file, sourceSystem) {
  if (!window.XLSX) throw new Error('Excel 모듈을 불러오지 못했습니다.');
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  if (!workbook.SheetNames.length) throw new Error('Excel 시트를 찾을 수 없습니다.');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const headerRow = findHeaderRow(matrix, sourceSystem);
  if (headerRow < 0) throw new Error(sourceSystem === CUSTOMER_SOURCE_SYSTEM.SHOP ? '아이디와 이름(거래처명) 열을 찾을 수 없습니다.' : '거래처코드와 거래처명 열을 찾을 수 없습니다.');
  const rows = window.XLSX.utils.sheet_to_json(sheet, { range: headerRow, defval: '', raw: false });
  if (!rows.length) throw new Error('불러올 거래처 데이터가 없습니다.');
  elements.importSummary.innerHTML = '<div class="cm-progress-copy"><strong>Excel 읽기 완료</strong><span>거래처 비교를 시작합니다.</span></div><div class="cm-progress-track"><span style="width:0%"></span></div>';
  elements.importGate.textContent = '기존 거래처와 비교하고 있습니다.';
  elements.importSummary.innerHTML = `<div class="cm-progress-copy"><strong>파일 식별 중</strong><span>0 / ${rows.length.toLocaleString()}</span></div><div class="cm-progress-track"><span style="width:0%"></span></div>`;
  elements.importGate.textContent = '분석 작업을 준비하고 있습니다.';
  const fileHash = await sha256(file);
  let prepared;
  try {
    prepared = await prepareCustomerSourceImport(rows, {
      sourceSystem,
      fileName: file.name,
      fileHash,
      chunkSize: 50,
      onProgress: ({ processed, total }) => {
        const percent = total ? Math.round((processed / total) * 100) : 0;
        elements.importSummary.innerHTML = `<div class="cm-progress-copy"><strong>분석·저장 중 ${processed.toLocaleString()} / ${total.toLocaleString()}</strong><span>${percent}%</span></div><div class="cm-progress-track"><span style="width:${percent}%"></span></div>`;
        elements.importGate.textContent = `${processed.toLocaleString()}건 저장 완료`;
      }
    });
  } catch (error) {
    if (!error.totalCount) error.totalCount = rows.length;
    throw error;
  }
  state.importBatch = prepared.batch;
  state.importRecords = prepared.records;
  state.importLimit = 200;
  state.importStatusFilter = 'ISSUES';
  state.importQuery = '';
  elements.importSearch.value = '';
  renderImport();
}

async function handleExcelSelection(input, sourceSystem) {
  const file = input.files?.[0];
  if (!file) return;
  state.importBatch = null;
  state.importRecords = [];
  elements.importWorkbench.hidden = false;
  elements.importWorkbench.dataset.phase = 'ANALYZING';
  elements.applyImport.disabled = true;
  elements.importSourceLabel.textContent = sourceSystem === CUSTOMER_SOURCE_SYSTEM.SHOP ? '쇼핑몰 회원 가져오기' : 'ERP 거래처 가져오기';
  elements.importFileTitle.textContent = file.name;
  elements.importSummary.innerHTML = '<div class="cm-progress-copy"><strong>Excel 파일 읽는 중</strong><span>잠시만 기다려 주세요.</span></div><div class="cm-progress-track"><span class="indeterminate"></span></div>';
  elements.importReview.innerHTML = '';
  elements.importGate.textContent = '파일을 확인하고 있습니다.';
  elements.importWorkbench.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    await readExcel(file, sourceSystem);
  } catch (error) {
    console.error('Customer source import failed', error);
    renderImportFailure(error, file.name, sourceSystem);
  } finally {
    input.value = '';
  }
}

function openFilePicker(input) {
  input.value = '';
  input.click();
}

async function saveIssueDrafts(moveToNext = false) {
  const active = document.activeElement?.closest?.('[data-customer-id]')?.dataset.customerId || '';
  const activeIndex = state.filtered.findIndex(customer => customer.customerId === active);
  elements.saveIssues.disabled = true;
  elements.saveIssuesNext.disabled = true;
  state.issueErrors.clear();
  let savedCount = 0;
  for (const [customerId, patch] of [...state.issueDrafts]) {
    try {
      const customer = state.customers.find(row => row.customerId === customerId);
      if (!customer) continue;
      await updateCustomer(customerId, patch, { expectedRevision: Number(customer.revision), source: 'MASTER_ISSUE_GRID_EDIT' });
      state.issueDrafts.delete(customerId);
      savedCount += 1;
    } catch (error) {
      state.issueErrors.set(customerId, error.message || String(error));
    }
  }
  try {
    if (savedCount) await syncAndReload();
    else await reload();
  } catch (error) {
    alert(`로컬 저장 후 화면 갱신 실패: ${error.message || error}`);
    await reload();
  }
  if (moveToNext && state.filtered.length) {
    const remainingActiveIndex = state.filtered.findIndex(customer => customer.customerId === active);
    const nextIndex = remainingActiveIndex >= 0
      ? (remainingActiveIndex + 1) % state.filtered.length
      : Math.min(Math.max(activeIndex, 0), state.filtered.length - 1);
    state.issueFocusCustomerId = state.filtered[nextIndex]?.customerId || '';
  }
  renderIssueGrid();
  if (state.issueErrors.size) {
    const firstFailedId = [...state.issueErrors.keys()][0];
    requestAnimationFrame(() => elements.issueGrid.querySelector(`[data-customer-id="${CSS.escape(firstFailedId)}"] input`)?.focus());
  }
}

document.querySelectorAll('[data-customer-summary-filter]').forEach(button => button.addEventListener('click', async () => {
  state.summaryFilter = button.dataset.customerSummaryFilter;
  elements.filter.value = 'ALL';
  document.querySelectorAll('[data-customer-summary-filter]').forEach(card => card.classList.toggle('is-active', card === button));
  await applyFilter();
}));

elements.issueGrid.addEventListener('input', event => {
  const input = event.target.closest('[data-issue-field]');
  if (input) setIssueValue(input, input.value);
});
elements.issueGrid.addEventListener('keydown', event => {
  const input = event.target.closest('[data-issue-field]');
  if (!input) return;
  const row = Number(input.dataset.issueRow);
  const column = Number(input.dataset.issueColumn);
  const moves = { Enter: [1, 0], ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (!moves[event.key]) return;
  event.preventDefault();
  focusIssueCell(row + moves[event.key][0], column + moves[event.key][1]);
});
elements.issueGrid.addEventListener('paste', event => {
  const input = event.target.closest('[data-issue-field]');
  const text = event.clipboardData?.getData('text/plain');
  if (!input || !text || (!text.includes('\t') && !/[\r\n]/.test(text))) return;
  event.preventDefault();
  const startRow = Number(input.dataset.issueRow);
  const startColumn = Number(input.dataset.issueColumn);
  text.replace(/\r/g, '').split('\n').filter((row, index, rows) => row !== '' || index < rows.length - 1).forEach((line, rowOffset) => {
    line.split('\t').forEach((value, columnOffset) => {
      const target = elements.issueGrid.querySelector(`[data-issue-row="${startRow + rowOffset}"][data-issue-column="${startColumn + columnOffset}"]`);
      if (target) setIssueValue(target, value);
    });
  });
});

elements.viewport.addEventListener('scroll', renderWindow, { passive: true });
elements.search.addEventListener('input', applyFilter);
elements.filter.addEventListener('change', async () => {
  state.summaryFilter = elements.filter.value === 'ALL' ? 'ACTIVE_ALL' : 'NONE';
  document.querySelectorAll('[data-customer-summary-filter]').forEach(card => card.classList.toggle('is-active', elements.filter.value === 'ALL' && card.dataset.customerSummaryFilter === 'ACTIVE_ALL'));
  await applyFilter();
});
elements.group1Filter.addEventListener('change', applyFilter);
elements.group2Filter.addEventListener('change', applyFilter);
elements.managerFilter.addEventListener('change', applyFilter);
elements.saveIssues.addEventListener('click', () => saveIssueDrafts(false));
elements.saveIssuesNext.addEventListener('click', () => saveIssueDrafts(true));
elements.form.querySelectorAll('[data-close-customer-editor]').forEach(button => button.addEventListener('click', () => elements.editor.close()));
elements.form.addEventListener('submit', saveEditor);
document.querySelector('#newCustomerButton').addEventListener('click', () => openEditor());
document.querySelector('#openErpImportButton').addEventListener('click', () => openFilePicker(elements.erpFile));
document.querySelector('#openShopImportButton').addEventListener('click', () => openFilePicker(elements.shopFile));
document.querySelector('#closeImportButton').addEventListener('click', () => { elements.importWorkbench.hidden = true; });
elements.erpFile.addEventListener('change', () => handleExcelSelection(elements.erpFile, CUSTOMER_SOURCE_SYSTEM.ERP));
elements.shopFile.addEventListener('change', () => handleExcelSelection(elements.shopFile, CUSTOMER_SOURCE_SYSTEM.SHOP));
elements.importSearch.addEventListener('input', () => { state.importQuery = elements.importSearch.value.trim(); state.importLimit = 200; renderImport(); });
elements.applyImport.addEventListener('click', async () => {
  elements.applyImport.disabled = true;
  elements.importGate.textContent = 'Master와 외부 거래처 연결을 적용하고 있습니다...';
  try {
    const results = await applyCustomerSourceImport(state.importBatch.importBatchId);
    results.forEach(result => {
      const record = state.importRecords.find(row => row.sourceRecordId === result.sourceRecordId);
      if (!record || result.status === CUSTOMER_IMPORT_STATUS.EXCLUDED) return;
      if (result.status === CUSTOMER_IMPORT_STATUS.FAILED) Object.assign(record, { status: result.status, retryStatus: result.retryStatus || record.retryStatus || record.status, errorMessage: result.error || '' });
      else if (result.status === CUSTOMER_IMPORT_STATUS.APPLIED) Object.assign(record, { status: result.status, retryStatus: '', appliedCustomerId: result.customerId || record.appliedCustomerId, appliedSourceLinkId: result.linkId || record.appliedSourceLinkId, errorMessage: '' });
    });
    const failed = results.filter(result => result.status === CUSTOMER_IMPORT_STATUS.FAILED);
    state.importBatch.status = failed.length ? 'PARTIAL' : 'APPLIED';
    state.importStatusFilter = failed.length ? CUSTOMER_IMPORT_STATUS.FAILED : 'ALL';
    renderImport();
    await reload();
    await syncAndReload();
  } catch (error) {
    elements.importGate.textContent = `적용 실패: ${error.message || error}`;
    elements.applyImport.disabled = false;
  }
});

async function initializeCustomerMaster() {
  await startCustomerFoundationWorker();
  const pending = await getLatestCustomerSourceImportWork();
  if (pending) {
    state.importBatch = pending.batch;
    state.importRecords = pending.records;
    elements.importWorkbench.hidden = false;
    if (pending.batch.status === 'PREPARING') renderPreparingImport(pending.batch, pending.records);
    else renderImport();
  }
  await reload();
  const ready = await ensureCustomerMasterReady({ onLoading: message => { elements.empty.hidden = false; elements.empty.textContent = message; } });
  if (ready.syncPromise) {
    ready.syncPromise.then(async result => { await reload(); await renderCloudSyncState(result); })
      .catch(async error => { console.warn('Customer Master background backup deferred', error); await renderCloudSyncState({ status: 'BACKUP_FAILED', error }); });
  } else {
    await reload();
    await renderCloudSyncState();
  }
}

globalThis.addEventListener('ONEAPP_FOUNDATION_BACKUP_STATE', () => {
  renderCloudSyncState().catch(error => console.warn('Foundation backup state render deferred', error));
});
elements.backupNow?.addEventListener('click', async () => {
  elements.backupNow.disabled = true;
  try {
    elements.syncState.dataset.state = 'syncing';
    elements.syncState.querySelector('#customerBackupLabel').textContent = '백업 진행 중 · 로컬 업무 정상';
    await synchronizeCustomerMaster();
    await renderCloudSyncState();
  } catch (error) {
    console.warn('Customer backup failed; local data retained', error);
    await renderCloudSyncState({ status: 'BACKUP_FAILED' });
  } finally { elements.backupNow.disabled = false; }
});
elements.restore?.addEventListener('click', async () => {
  elements.restore.disabled = true;
  try {
    const preview = await previewCustomerRestore();
    if (!preview.valid) throw new Error(`복구 검증 실패: 중복 코드 ${preview.duplicateCodes.length} · 참조 오류 ${preview.referenceErrors.length}`);
    const summary = `서버 Revision ${preview.serverRevision}\n로컬 ${preview.comparison.localCount}건 → 서버 ${preview.comparison.serverCount}건\n신규 ${preview.comparison.added} · 변경 ${preview.comparison.changed} · 제거 ${preview.comparison.removed}`;
    if (!window.confirm(`${summary}\n\n현재 로컬 안전 Snapshot을 만든 뒤 관리자 복구를 적용할까요?`)) return;
    if (preview.comparison.destructive && !window.confirm('20% 이상 감소 또는 0건 복구입니다. 파괴적 복구 경고를 확인했고 계속하시겠습니까?')) return;
    await applyCustomerRestore(preview, preview.approvalToken);
    await reload();
    await renderCloudSyncState();
  } catch (error) {
    window.alert(`거래처 복구 실패: ${error.message || error}`);
  } finally { elements.restore.disabled = false; }
});
elements.promote?.addEventListener('click', async () => {
  elements.promote.disabled = true;
  try {
    await globalThis.NEXUS_FOUNDATION_BACKUP.registerDevice();
    const status = await globalThis.NEXUS_FOUNDATION_BACKUP.deviceStatus();
    if (!window.confirm(`현재 장치를 회사 Primary로 승격합니다. Primary Epoch ${Number(status?.primary?.primaryEpoch || 0)} → ${Number(status?.primary?.primaryEpoch || 0) + 1}`)) return;
    await globalThis.NEXUS_FOUNDATION_BACKUP.promoteDevice(Number(status?.primary?.primaryEpoch || 0), '거래처 관리자 화면 승인');
    await renderCloudSyncState();
  } catch (error) {
    window.alert(`Primary 승격 실패: ${error.message || error}`);
  } finally { elements.promote.disabled = false; }
});

initializeCustomerMaster().catch(error => {
  elements.empty.hidden = false;
  elements.empty.textContent = `거래처 정보를 불러오지 못했습니다: ${error.message}`;
});
