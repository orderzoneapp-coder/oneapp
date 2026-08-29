import {
  CUSTOMER_FIELDS,
  CUSTOMER_QUALITY,
  CUSTOMER_STATUS,
  FIELD_LABELS,
  IMPORT_FIELD_LABELS,
  analyzeImportRows,
  clean,
  customerDisplayStatus,
  defaultHeaderMapping,
  detectImportSourceSystem,
  missingCustomerFields,
  resolveCanonicalCustomerId,
  searchCustomerRows,
  sha256Hex,
} from './core.js';
import { ACTIVE_DB_NAME, STORE, count, initializeDb } from './db.js';
import {
  applyImportBatch,
  customerDetails,
  latestIncompleteImport,
  listCustomerData,
  listEvents,
  listHeaderMappings,
  listUserFields,
  mapCustomerToCanonical,
  prepareImportBatch,
  releaseCustomerCanonicalMapping,
  resolveImportRecord,
  saveCustomer,
  saveHeaderMapping,
  saveUserField,
  updateCustomerStatus,
} from './repository.js';
import { parseCustomerFile, parseXlsxBuffer } from './xlsx.js';
import { createSnapshot, downloadSnapshot, readSnapshotFile, restoreSnapshot } from './backup.js';
import { inspectLegacyCustomerData, migrateLegacyCustomerData } from './legacy-migration.js';
import { customerReadAdapter } from './read-adapter.js';

const state = {
  data: { customers: [], aliases: [], sourceLinks: [] },
  summaryFilter: 'ALL',
  issueChanges: new Map(),
  workbook: null,
  file: null,
  fileHash: '',
  detectedSourceSystem: '',
  mapping: [],
  importWork: null,
  legacyInspection: null,
  restoreSnapshot: null,
  changeRequestInbox: { status: 'IDLE', requests: [], error: null },
  toastTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]));

const resultLabels = Object.freeze({
  READY_CREATE: '신규 등록', READY_UPDATE: '기존 거래처 수정', CREATED: '신규', UPDATED: '수정',
  READY_LINK: '기존 거래처 연결', LINKED: '연결 완료', LINK_REVIEW: '연결 확인 필요',
  UNCHANGED: '변경 없음', FAILED: '실패', EMPTY_ROW_EXCLUDED: '빈 행 제외', SYSTEM_ROW_EXCLUDED: '시스템 행 제외',
});

const reasonLabels = Object.freeze({
  SOURCE_CODE_MISSING: '원본 코드 없음', DUPLICATE_SOURCE_CODE_IN_IMPORT: '파일 내부 중복 원본 코드',
  DUPLICATE_LEGACY_CODE_IN_DB: '기존 DB에 같은 ERP 코드가 여러 건 존재', SOURCE_LINK_CUSTOMER_MISSING: '외부코드 연결 대상 거래처 없음',
  NAME_ONLY_MATCH_REQUIRES_REVIEW: '이름만 일치하여 자동 연결하지 않음', NUMBER_FIELD_PARSE_FAILED: '숫자 항목 변환 실패',
  STATUS_FIELD_PARSE_FAILED: '사용 상태 값 변환 실패',
});

const sourceCodeLabel = (sourceSystem = $('#importSourceSystem')?.value || 'OTHER') => ({
  ERP: 'ERP 거래처코드', SHOP: 'SHOP 회원 아이디', OTHER: '원본 거래처코드',
}[clean(sourceSystem).toUpperCase()] || '원본 거래처코드');

const operationalCustomers = () => state.data.customers.filter((customer) =>
  customer.status !== CUSTOMER_STATUS.DELETED && customer.qualityStatus !== CUSTOMER_QUALITY.SUPERSEDED);

const importFieldLabel = (fieldKey, sourceSystem) => fieldKey === 'sourceCustomerCode'
  ? sourceCodeLabel(sourceSystem)
  : (IMPORT_FIELD_LABELS[fieldKey] || FIELD_LABELS[fieldKey] || fieldKey);

function setStatus(message, type = 'ready') {
  $('#appStatus').dataset.state = type;
  $('#appStatusText').textContent = message;
}

function toast(message, tone = 'info') {
  const element = $('#toast');
  element.textContent = message;
  element.dataset.tone = tone;
  element.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { element.hidden = true; }, tone === 'error' ? 6500 : 3500);
}

async function withBusy(message, task) {
  setStatus(message, 'busy');
  try {
    const result = await task();
    setStatus(`로컬 DB · 거래처 ${operationalCustomers().length.toLocaleString()}건`, 'ready');
    return result;
  } catch (error) {
    console.error(error);
    setStatus('작업 오류', 'error');
    toast(String(error?.message || error), 'error');
    throw error;
  }
}

function activateTab(tabName) {
  $$('.cm-tab').forEach((button) => button.classList.toggle('is-active', button.dataset.tab === tabName));
  $$('.cm-view').forEach((view) => {
    const active = view.dataset.view === tabName;
    view.classList.toggle('is-active', active);
    view.hidden = !active;
  });
  if (tabName === 'history') renderHistory();
  if (tabName === 'requests') renderChangeRequests();
  if (tabName === 'mapping') renderMappingManagement();
  if (tabName === 'data') refreshStorageState();
}

function visibleCustomers() {
  const query = $('#customerSearch').value;
  const status = $('#statusFilter').value;
  const group1 = $('#group1Filter').value;
  const group2 = $('#group2Filter').value;
  const manager = $('#managerFilter').value;
  const searched = searchCustomerRows(
    state.data.customers.filter((customer) => customer.status !== CUSTOMER_STATUS.DELETED),
    state.data.aliases,
    state.data.sourceLinks,
    query,
    500,
  );
  return searched
    .filter((customer) => status === 'ALL' || customer.status === status)
    .filter((customer) => group1 === 'ALL' || clean(customer.group1Name) === group1)
    .filter((customer) => group2 === 'ALL' || clean(customer.group2Name) === group2)
    .filter((customer) => manager === 'ALL' || clean(customer.contactName) === manager)
    .filter((customer) => state.summaryFilter === 'ALL' || customerDisplayStatus(customer) === state.summaryFilter);
}

function renderFilterOptions() {
  const fill = (selector, label, values) => {
    const select = $(selector);
    const current = select.value || 'ALL';
    select.innerHTML = `<option value="ALL">${escapeHtml(label)} 전체</option>${[...new Set(values.map(clean).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, 'ko')).map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
    select.value = [...select.options].some((option) => option.value === current) ? current : 'ALL';
  };
  const customers = operationalCustomers();
  fill('#group1Filter', '그룹1', customers.map((row) => row.group1Name));
  fill('#group2Filter', '그룹2', customers.map((row) => row.group2Name));
  fill('#managerFilter', '담당자', customers.map((row) => row.contactName));
}

function renderStats() {
  const customers = operationalCustomers();
  $('#totalCount').textContent = customers.length.toLocaleString();
  $('#completeCount').textContent = customers.filter((row) => customerDisplayStatus(row) === 'COMPLETE').length.toLocaleString();
  $('#incompleteCount').textContent = customers.filter((row) => customerDisplayStatus(row) === 'INCOMPLETE').length.toLocaleString();
  $('#duplicateCount').textContent = customers.filter((row) => customerDisplayStatus(row) === 'DUPLICATE_CANDIDATE').length.toLocaleString();
  $$('.cm-stat').forEach((button) => button.classList.toggle('is-active', button.dataset.summaryFilter === state.summaryFilter));
}

function statusBadge(customer) {
  if (customer.status === CUSTOMER_STATUS.INACTIVE) return '<span class="cm-badge" data-tone="warning">거래중단</span>';
  const display = customerDisplayStatus(customer);
  if (display === 'DUPLICATE_CANDIDATE') return '<span class="cm-badge" data-tone="danger">중복 확인</span>';
  if (display === 'INCOMPLETE') return '<span class="cm-badge" data-tone="warning">정보 보완</span>';
  return '<span class="cm-badge" data-tone="success">정보 완료</span>';
}

function renderCustomerList() {
  const rows = visibleCustomers();
  $('#customerTableBody').innerHTML = rows.map((customer) => {
    const address = [customer.address, customer.addressDetail].map(clean).filter(Boolean).join(' ');
    const contact = [customer.mobile || customer.phone, address].map(clean).filter(Boolean).join(' · ');
    return `<tr data-customer-id="${escapeHtml(customer.customerId)}">
      <td>${escapeHtml(customer.customerId || '-')}</td>
      <td><strong>${escapeHtml(customer.customerName || '(상호 미입력)')}</strong><small>Rev.${Number(customer.revision || 1)}</small></td>
      <td>${escapeHtml(contact || '-')}</td><td>${escapeHtml(customer.group1Name || '-')}</td><td>${escapeHtml(customer.group2Name || '-')}</td>
      <td>${escapeHtml(customer.contactName || '-')}</td><td>${statusBadge(customer)}</td>
      <td><div class="cm-row-actions"><button type="button" class="cm-row-button" data-edit-customer="${escapeHtml(customer.customerId)}">수정</button><button type="button" class="cm-row-button" data-toggle-status="${escapeHtml(customer.customerId)}">${customer.status === CUSTOMER_STATUS.ACTIVE ? '거래중단' : '사용재개'}</button></div></td>
    </tr>`;
  }).join('');
  $('#customerEmpty').hidden = rows.length !== 0;
  $('#customerListNote').textContent = rows.length >= 500 ? '검색 결과가 많아 상위 500건만 표시합니다.' : `${rows.length.toLocaleString()}건 표시`;
}

function renderCompleteness() {
  const customers = state.data.customers.filter((customer) => customerDisplayStatus(customer) === 'INCOMPLETE')
    .sort((left, right) => clean(left.customerName).localeCompare(clean(right.customerName), 'ko'));
  $('#completenessBody').innerHTML = customers.map((customer, rowIndex) => {
    const missing = missingCustomerFields(customer).map(([, label]) => label).join(', ');
    return `<tr data-customer-id="${escapeHtml(customer.customerId)}"><td>${rowIndex + 1}</td><td>${escapeHtml(customer.customerId || '-')}</td>
      ${['customerName', 'address', 'mobile'].map((field, columnIndex) => `<td><input data-grid-input data-row="${rowIndex}" data-column="${columnIndex}" data-customer-id="${escapeHtml(customer.customerId)}" data-field="${field}" value="${escapeHtml(customer[field] || '')}" aria-label="${escapeHtml(FIELD_LABELS[field])}"></td>`).join('')}
      <td data-issue-label="${escapeHtml(customer.customerId)}">${escapeHtml(missing)}</td></tr>`;
  }).join('');
  $('#completenessEmpty').hidden = customers.length !== 0;
  renderIssueChangeCount();
}

function renderIssueChangeCount() {
  const fieldCount = [...state.issueChanges.values()].reduce((total, fields) => total + Object.keys(fields).length, 0);
  $('#issueChangeCount').textContent = `변경 ${fieldCount.toLocaleString()}건`;
  $('#saveCompletenessButton').disabled = fieldCount === 0;
}

function fieldOptions(selected = '') {
  const sourceSystem = $('#importSourceSystem').value;
  const special = ['sourceCustomerCode', 'sourceNickname', 'sourceSearchText'];
  const standard = [...CUSTOMER_FIELDS.filter((field) => field !== 'customerCode' && !/^user(?:Text|Number)/.test(field)), 'status'];
  const userFields = state.userFields?.filter((row) => row.enabled && clean(row.displayName)) || [];
  return `<option value="">저장하지 않음</option>${special.map((field) => `<option value="${field}"${selected === field ? ' selected' : ''}>${escapeHtml(importFieldLabel(field, sourceSystem))}</option>`).join('')}${standard.map((field) => `<option value="${field}"${selected === field ? ' selected' : ''}>${escapeHtml(importFieldLabel(field, sourceSystem))}</option>`).join('')}${userFields.map((field) => `<option value="${field.fieldKey}"${selected === field.fieldKey ? ' selected' : ''}>${escapeHtml(field.displayName)}</option>`).join('')}`;
}

function renderMappingSummary() {
  const mapped = state.mapping.filter((entry) => entry.targetFieldKey).length;
  const skipped = state.mapping.length - mapped;
  const codeMapped = state.mapping.some((entry) => entry.targetFieldKey === 'sourceCustomerCode');
  $('#mappingSummary').textContent = `${mapped.toLocaleString()}개 자동 연결 · ${skipped.toLocaleString()}개 저장하지 않음${codeMapped ? '' : ` · ${sourceCodeLabel()}를 지정해야 분석할 수 있습니다.`}`;
}

async function renderMappingPreview() {
  const sourceLabels = { STANDARD: '자동 연결', SOURCE: '원본코드 연결', SAVED: '저장된 연결', USER: '사용자 필드', MANUAL: '직접 선택' };
  $('#mappingPreviewBody').innerHTML = state.mapping.map((entry, index) => `<tr><td>${escapeHtml(entry.header)}</td><td><select data-mapping-index="${index}">${fieldOptions(entry.targetFieldKey)}</select></td><td>${entry.source === 'UNMATCHED' ? '<span class="cm-badge" data-tone="warning">저장하지 않음</span>' : `<span class="cm-badge" data-tone="success">${escapeHtml(sourceLabels[entry.source] || entry.source)}</span>`}</td></tr>`).join('');
  renderMappingSummary();
}

function importSummary(records) {
  const counts = records.reduce((result, row) => {
    result[row.resultType] = (result[row.resultType] || 0) + 1;
    result.fieldExcluded += (row.fieldExclusions || []).length;
    result.unmatched += Object.keys(row.unmatchedValues || {}).length;
    return result;
  }, { fieldExcluded: 0, unmatched: 0 });
  return Object.entries(counts).filter(([, countValue]) => countValue > 0).map(([key, countValue]) => `<span class="cm-badge" data-tone="${key === 'FAILED' ? 'danger' : key.includes('READY') || ['CREATED', 'UPDATED'].includes(key) ? 'success' : 'warning'}">${escapeHtml(resultLabels[key] || key)} ${countValue.toLocaleString()}</span>`).join('');
}

function renderImportWork() {
  const records = state.importWork?.records || [];
  const previewRecords = [
    ...records.filter((record) => record.resultType === 'LINK_REVIEW'),
    ...records.filter((record) => record.resultType !== 'LINK_REVIEW'),
  ].slice(0, 500);
  $('#importResult').hidden = false;
  $('#importSummary').innerHTML = importSummary(records);
  $('#importPreviewBody').innerHTML = previewRecords.map((record) => {
    const reason = reasonLabels[record.reasonCode] || record.errorMessage || '';
    const fieldIssues = (record.fieldExclusions || []).map((row) => `${row.header}: ${reasonLabels[row.reasonCode] || row.reasonCode}`).join(', ');
    const unmatched = Object.keys(record.unmatchedValues || {}).length ? `미매핑 열 ${Object.keys(record.unmatchedValues).join(', ')}` : '';
    const candidates = (record.candidateCustomerIds || []).map((customerId) => state.data.customers.find((customer) => customer.customerId === customerId)).filter(Boolean);
    const reviewControls = record.resultType === 'LINK_REVIEW' ? `<div class="cm-review-actions">
      <select data-review-customer aria-label="연결할 NEXUS 거래처">${candidates.map((customer) => `<option value="${escapeHtml(customer.customerId)}">${escapeHtml(customer.customerName || '(상호 미입력)')} · ${escapeHtml(customer.customerId)}</option>`).join('')}</select>
      <button type="button" class="cm-row-button" data-resolve-review="LINK">기존 거래처 연결</button>
      <button type="button" class="cm-row-button" data-resolve-review="CREATE">신규 생성</button>
    </div>` : '';
    return `<tr data-source-record-id="${escapeHtml(record.sourceRecordId || '')}"><td>${record.rowNo}</td><td>${escapeHtml(record.sourceValues?.sourceCustomerCode || '')}</td><td>${escapeHtml(record.sourceValues?.sourceCustomerName || record.values?.customerName || '')}</td><td>${escapeHtml(resultLabels[record.resultType] || record.resultType)}${reviewControls}</td><td>${escapeHtml([reason, fieldIssues, unmatched].filter(Boolean).join(' · '))}</td></tr>`;
  }).join('');
  $('#applyImportButton').disabled = !records.some((row) =>
    ['READY_CREATE', 'READY_UPDATE', 'READY_LINK'].includes(row.resultType === 'FAILED' ? row.retryResultType : row.resultType));
}

async function resolveReviewAction(button) {
  const row = button.closest('[data-source-record-id]');
  const sourceRecordId = row?.dataset.sourceRecordId;
  const mode = button.dataset.resolveReview;
  if (!sourceRecordId || !['LINK', 'CREATE'].includes(mode)) return;
  const customerId = mode === 'LINK' ? $('[data-review-customer]', row)?.value : '';
  await withBusy(mode === 'LINK' ? '기존 거래처 연결 준비 중' : '신규 거래처 생성 준비 중', async () => {
    const updated = await resolveImportRecord(sourceRecordId, { mode, customerId });
    state.importWork.records = state.importWork.records.map((record) => record.sourceRecordId === sourceRecordId ? updated : record);
    renderImportWork();
    toast(mode === 'LINK' ? '선택한 NEXUS 거래처에 연결하도록 지정했습니다.' : '새 NEXUS 거래처로 생성하도록 지정했습니다.');
  });
}

function directSourceCodes(customerId) {
  return state.data.sourceLinks.filter((link) => link.customerId === customerId && link.active !== false)
    .map((link) => `${link.sourceSystem} ${link.sourceCustomerCode}`);
}

function customerForReference(reference, { canonical = false } = {}) {
  const value = clean(reference);
  const normalized = value.toLocaleLowerCase('ko');
  if (!value) throw new Error('거래처 코드 또는 거래처명을 입력해 주세요.');
  let candidates = state.data.customers.filter((customer) => clean(customer.customerId).toLocaleLowerCase('ko') === normalized);
  if (!candidates.length) {
    const linkedIds = new Set(state.data.sourceLinks.filter((link) => link.active !== false
      && clean(link.sourceCustomerCode).toLocaleLowerCase('ko') === normalized).map((link) => link.customerId));
    candidates = state.data.customers.filter((customer) => linkedIds.has(customer.customerId));
  }
  if (!candidates.length) candidates = state.data.customers.filter((customer) => clean(customer.customerName).toLocaleLowerCase('ko') === normalized);
  if (candidates.length !== 1) throw new Error(candidates.length ? '같은 값에 해당하는 거래처가 여러 건입니다. NEXUS 거래처코드를 입력해 주세요.' : '입력한 거래처를 찾을 수 없습니다.');
  if (!canonical) return candidates[0];
  const canonicalId = resolveCanonicalCustomerId(candidates[0].customerId, state.data.customers);
  return state.data.customers.find((customer) => customer.customerId === canonicalId) || candidates[0];
}

function renderCustomerReferenceOptions() {
  const options = [];
  state.data.customers.filter((customer) => customer.status !== CUSTOMER_STATUS.DELETED).forEach((customer) => {
    const label = `${customer.customerName || '(상호 미입력)'} · ${customer.customerId}`;
    options.push(`<option value="${escapeHtml(customer.customerId)}">${escapeHtml(label)}</option>`);
    directSourceCodes(customer.customerId).forEach((sourceCode) => {
      const code = sourceCode.replace(/^\S+\s+/, '');
      options.push(`<option value="${escapeHtml(code)}">${escapeHtml(`${sourceCode} · ${label}`)}</option>`);
    });
  });
  $('#customerReferenceOptions').innerHTML = options.join('');
}

function renderCanonicalMappings() {
  const mapped = state.data.customers.filter((customer) => customer.status !== CUSTOMER_STATUS.DELETED
    && customer.qualityStatus === CUSTOMER_QUALITY.SUPERSEDED && clean(customer.canonicalCustomerId));
  $('#canonicalMappingsBody').innerHTML = mapped.map((source) => {
    const canonicalId = resolveCanonicalCustomerId(source.customerId, state.data.customers);
    const target = state.data.customers.find((customer) => customer.customerId === canonicalId);
    return `<tr><td>${escapeHtml(source.customerId)}</td><td>${escapeHtml(source.customerName || '(상호 미입력)')}</td>
      <td>${escapeHtml(directSourceCodes(source.customerId).join(' · ') || '-')}</td>
      <td><strong>${escapeHtml(target?.customerId || canonicalId)}</strong><br>${escapeHtml(target?.customerName || '(대표 거래처 없음)')}</td>
      <td><button type="button" class="cm-row-button" data-release-customer-mapping="${escapeHtml(source.customerId)}">연결 해제</button></td></tr>`;
  }).join('');
  $('#canonicalMappingsEmpty').hidden = mapped.length !== 0;
}

async function applyManualCustomerMapping() {
  const source = customerForReference($('#mappingSourceReference').value);
  const target = customerForReference($('#mappingTargetReference').value, { canonical: true });
  if (source.customerId === target.customerId) throw new Error('분리된 거래처와 대표 거래처가 같습니다.');
  if (!confirm(`${source.customerName || source.customerId}의 ERP·SHOP 코드를 ${target.customerName || target.customerId}의 NEXUS 코드로 연결할까요?`)) return;
  await withBusy('NEXUS 거래처 연결 중', async () => {
    await mapCustomerToCanonical(source.customerId, target.customerId);
    $('#mappingSourceReference').value = '';
    $('#mappingTargetReference').value = '';
    await refreshAll();
    await renderMappingManagement();
    toast('분산 거래처를 대표 NEXUS 거래처에 연결했습니다.');
  });
}

async function releaseManualCustomerMapping(customerId) {
  const source = state.data.customers.find((customer) => customer.customerId === customerId);
  if (!source) throw new Error('해제할 거래처를 찾을 수 없습니다.');
  if (!confirm(`${source.customerName || source.customerId}의 대표 거래처 연결을 해제할까요? 원래 NEXUS 거래처로 다시 표시됩니다.`)) return;
  await withBusy('NEXUS 거래처 연결 해제 중', async () => {
    await releaseCustomerCanonicalMapping(source.customerId);
    await refreshAll();
    await renderMappingManagement();
    toast('대표 거래처 연결을 해제했습니다.');
  });
}

async function renderMappingManagement() {
  const [mappings, userFields] = await Promise.all([listHeaderMappings(), listUserFields()]);
  state.userFields = userFields;
  renderCustomerReferenceOptions();
  renderCanonicalMappings();
  $('#savedMappingsBody').innerHTML = mappings.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).map((row) => {
    const targetLabel = row.targetFieldKey === 'sourceCustomerCode' ? sourceCodeLabel(row.sourceSystem)
      : IMPORT_FIELD_LABELS[row.targetFieldKey] || FIELD_LABELS[row.targetFieldKey]
        || userFields.find((field) => field.fieldKey === row.targetFieldKey)?.displayName || row.targetFieldKey;
    return `<tr><td>${escapeHtml(row.sourceSystem)}</td><td>${escapeHtml(row.originalHeader)}</td><td>${escapeHtml(targetLabel)}</td><td>${escapeHtml(String(row.updatedAt || '').replace('T', ' ').slice(0, 16))}</td></tr>`;
  }).join('');
  $('#savedMappingsEmpty').hidden = mappings.length !== 0;
  $('#userFieldsBody').innerHTML = userFields.sort((left, right) => left.fieldType.localeCompare(right.fieldType) || left.displayOrder - right.displayOrder).map((row) => `<tr data-user-field="${row.fieldKey}"><td><input type="checkbox" data-user-enabled${row.enabled ? ' checked' : ''}></td><td>${row.fieldType === 'NUMBER' ? '숫자' : '텍스트'}</td><td><input data-user-name value="${escapeHtml(row.displayName || '')}" placeholder="표시명"></td><td><input data-user-aliases value="${escapeHtml((row.headerAliases || []).join(', '))}" placeholder="쉼표로 구분"></td></tr>`).join('');
}

async function renderHistory() {
  const events = await listEvents();
  const names = new Map(state.data.customers.map((row) => [row.customerId, row.customerName || row.customerCode || row.customerId]));
  $('#historyBody').innerHTML = events.map((event) => `<tr><td>${escapeHtml(String(event.occurredAt || '').replace('T', ' ').slice(0, 19))}</td><td>${escapeHtml(names.get(event.customerId) || event.customerId)}</td><td>${escapeHtml(event.eventType)}</td><td>${Number(event.entityRevision || 0)}</td><td>${escapeHtml(event.actorName || event.actorId || '확인되지 않음')}</td><td>${escapeHtml(event.actorState || 'UNVERIFIED_LOCAL')}</td></tr>`).join('');
  $('#historyEmpty').hidden = events.length !== 0;
}

async function renderChangeRequests() {
  const stateElement = $('#changeRequestInboxState');
  stateElement.textContent = '변경요청 Inbox 확인 중';
  try {
    const { customerMasterChangeRequestAdapter } = await import('./change-request-adapter.js');
    const result = await customerMasterChangeRequestAdapter.listChangeRequests({ limit: 200 });
    state.changeRequestInbox = result;
    const rows = result.requests || [];
    $('#changeRequestInboxBody').innerHTML = rows.map((entry) => {
      const request = entry.request || {};
      return `<tr><td>${escapeHtml(String(entry.receivedAt || '').replace('T', ' ').slice(0, 19))}</td><td>${escapeHtml(request.requestId || '-')}</td><td>${escapeHtml(request.entityId || '-')}</td><td>${escapeHtml(request.operation || '-')}</td><td>${escapeHtml(request.source?.appId || '-')}</td><td><span class="cm-badge" data-tone="warning">${escapeHtml(entry.status || 'PENDING')}</span></td></tr>`;
    }).join('');
    $('#changeRequestInboxEmpty').hidden = rows.length !== 0;
    stateElement.textContent = result.status === 'ERROR'
      ? `Inbox 조회 오류: ${result.error?.code || 'UNKNOWN'}`
      : `접수 ${rows.length.toLocaleString()}건 · 자동 승인·자동 반영 없음`;
  } catch (error) {
    state.changeRequestInbox = { status: 'ERROR', requests: [], error: { code: String(error?.message || error) } };
    $('#changeRequestInboxBody').innerHTML = '';
    $('#changeRequestInboxEmpty').hidden = true;
    stateElement.textContent = `Inbox Adapter를 사용할 수 없습니다: ${String(error?.message || error)}`;
  }
}

async function refreshAll() {
  state.data = await listCustomerData();
  renderFilterOptions();
  renderStats();
  renderCustomerList();
  renderCompleteness();
  setStatus(`로컬 DB · 거래처 ${operationalCustomers().length.toLocaleString()}건`);
}

async function openCustomerDialog(customerId = '') {
  const form = $('#customerForm');
  form.reset();
  $('#customerSourceLinksList').textContent = '연결된 외부코드가 없습니다.';
  $$('[name]', form).forEach((field) => { if (field.type !== 'select-one') field.value = ''; });
  form.elements.status.value = CUSTOMER_STATUS.ACTIVE;
  $('#customerDialogTitle').textContent = customerId ? '거래처 수정' : '거래처 등록';
  if (customerId) {
    const details = await customerDetails(customerId);
    if (!details.customer) throw new Error('거래처를 찾을 수 없습니다.');
    CUSTOMER_FIELDS.forEach((field) => { if (form.elements[field]) form.elements[field].value = details.customer[field] ?? ''; });
    form.elements.customerId.value = details.customer.customerId;
    form.elements.revision.value = details.customer.revision;
    form.elements.status.value = details.customer.status;
    form.elements.aliases.value = details.aliases.map((row) => row.alias || row.rawText).filter(Boolean).join(', ');
    $('#customerSourceLinksList').innerHTML = details.sourceLinks.length
      ? details.sourceLinks.sort((left, right) => left.sourceSystem.localeCompare(right.sourceSystem) || left.sourceCustomerCode.localeCompare(right.sourceCustomerCode))
        .map((link) => `<span class="cm-badge" data-tone="success"><strong>${escapeHtml(link.sourceSystem)}</strong> ${escapeHtml(link.sourceCustomerCode)}</span>`).join('')
      : '연결된 외부코드가 없습니다.';
  }
  form.elements.nexusCode.value = customerId || '저장 시 자동 생성';
  $('#customerDialog').showModal();
  setTimeout(() => form.elements.customerName.focus(), 0);
}

async function submitCustomer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const customer = Object.fromEntries(CUSTOMER_FIELDS.map((field) => [field, formData.get(field) ?? '']));
  customer.customerId = clean(formData.get('customerId')) || undefined;
  customer.status = clean(formData.get('status')) || CUSTOMER_STATUS.ACTIVE;
  customer.aliases = String(formData.get('aliases') || '').split(/[,\n]/).map(clean).filter(Boolean);
  customer.sourceLinks = [
    { sourceSystem: 'ERP', sourceCustomerCode: formData.get('erpCode'), sourceCustomerName: formData.get('erpName') },
    { sourceSystem: 'SHOP', sourceCustomerCode: formData.get('shopCode'), sourceCustomerName: formData.get('shopName') },
  ];
  await withBusy('거래처 저장 중', async () => {
    await saveCustomer(customer, { expectedRevision: customer.customerId ? Number(formData.get('revision')) : undefined });
    $('#customerDialog').close();
    await refreshAll();
    toast(customer.customerId ? '거래처 정보를 수정했습니다.' : '거래처를 등록했습니다.');
  });
}

async function toggleCustomerStatus(customerId) {
  const customer = state.data.customers.find((row) => row.customerId === customerId);
  if (!customer) return;
  const next = customer.status === CUSTOMER_STATUS.ACTIVE ? CUSTOMER_STATUS.INACTIVE : CUSTOMER_STATUS.ACTIVE;
  await withBusy('거래 상태 저장 중', async () => {
    await updateCustomerStatus(customerId, next, customer.revision);
    await refreshAll();
    toast(next === CUSTOMER_STATUS.ACTIVE ? '거래를 재개했습니다.' : '거래중단 상태로 변경했습니다.');
  });
}

function handleCompletenessInput(event) {
  const input = event.target.closest('[data-grid-input]');
  if (!input) return;
  const customer = state.data.customers.find((row) => row.customerId === input.dataset.customerId);
  if (!customer) return;
  const changes = { ...(state.issueChanges.get(customer.customerId) || {}) };
  if (String(customer[input.dataset.field] || '') === input.value) delete changes[input.dataset.field];
  else changes[input.dataset.field] = input.value;
  if (Object.keys(changes).length) state.issueChanges.set(customer.customerId, changes);
  else state.issueChanges.delete(customer.customerId);
  renderIssueChangeCount();
}

function moveGridFocus(input, rowDelta, columnDelta) {
  const target = $(`[data-grid-input][data-row="${Number(input.dataset.row) + rowDelta}"][data-column="${Number(input.dataset.column) + columnDelta}"]`);
  if (target) { target.focus(); target.select(); }
}

function handleGridKeydown(event) {
  const input = event.target.closest('[data-grid-input]');
  if (!input) return;
  const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Enter: [1, 0] };
  const move = moves[event.key];
  if (!move) return;
  if (['ArrowLeft', 'ArrowRight'].includes(event.key) && (input.selectionStart !== input.selectionEnd || (event.key === 'ArrowLeft' && input.selectionStart > 0) || (event.key === 'ArrowRight' && input.selectionStart < input.value.length))) return;
  event.preventDefault();
  moveGridFocus(input, move[0], move[1]);
}

function handleGridPaste(event) {
  const input = event.target.closest('[data-grid-input]');
  if (!input) return;
  const matrix = event.clipboardData.getData('text').replace(/\r/g, '').split('\n').filter((row, index, rows) => row || index < rows.length - 1).map((row) => row.split('\t'));
  if (matrix.length === 1 && matrix[0].length === 1) return;
  event.preventDefault();
  matrix.forEach((row, rowOffset) => row.forEach((value, columnOffset) => {
    const target = $(`[data-grid-input][data-row="${Number(input.dataset.row) + rowOffset}"][data-column="${Number(input.dataset.column) + columnOffset}"]`);
    if (!target) return;
    target.value = value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }));
}

async function saveCompleteness() {
  if (!state.issueChanges.size) return;
  await withBusy('정보 보완 저장 중', async () => {
    const failures = [];
    for (const [customerId, patch] of state.issueChanges) {
      const customer = state.data.customers.find((row) => row.customerId === customerId);
      try { await saveCustomer({ ...customer, ...patch }, { expectedRevision: customer.revision, source: 'COMPLETENESS_GRID' }); }
      catch (error) { failures.push(`${customer.customerName || customer.customerCode}: ${error.message}`); }
    }
    state.issueChanges.clear();
    await refreshAll();
    if (failures.length) toast(`저장하지 못한 거래처가 있습니다: ${failures.join(' / ')}`, 'error');
    else toast('정보 보완 내용을 저장했습니다.');
  });
}

async function fileHash(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function selectCustomerFile(file) {
  if (!file) return;
  await withBusy('Excel 파일 분석 준비 중', async () => {
    const [workbook, hash, storedMappings, userFields] = await Promise.all([
      parseCustomerFile(file), fileHash(file), listHeaderMappings(), listUserFields(),
    ]);
    state.file = file; state.fileHash = hash; state.workbook = workbook; state.userFields = userFields;
    state.detectedSourceSystem = detectImportSourceSystem(workbook.headers);
    if (state.detectedSourceSystem) $('#importSourceSystem').value = state.detectedSourceSystem;
    state.mapping = defaultHeaderMapping(workbook.headers, storedMappings, userFields, $('#importSourceSystem').value);
    const detectedLabel = state.detectedSourceSystem ? ` · ${state.detectedSourceSystem} 원본 자동 판별` : '';
    $('#selectedFileName').textContent = `${file.name} · ${workbook.sheetName} · 헤더 ${Number(workbook.headerRowNumber || 1).toLocaleString()}행 자동 인식 · 데이터 ${workbook.rows.length.toLocaleString()}행${detectedLabel}`;
    $('#importSourceCodeHeading').textContent = sourceCodeLabel();
    $('#mappingWorkbench').hidden = false;
    $('#importResult').hidden = true;
    await renderMappingPreview();
  });
}

async function saveCurrentMappings() {
  const sourceSystem = $('#importSourceSystem').value;
  const mapped = state.mapping.filter((row) => row.targetFieldKey);
  await withBusy('헤더 매핑 저장 중', async () => {
    for (const row of mapped) await saveHeaderMapping({
      sourceSystem, header: row.header, targetFieldKey: row.targetFieldKey,
      targetType: state.userFields?.find((field) => field.fieldKey === row.targetFieldKey)?.fieldType || 'TEXT',
    });
    toast(`${mapped.length.toLocaleString()}개 헤더 매핑을 저장했습니다.`);
    await renderMappingManagement();
  });
}

async function analyzeSelectedImport() {
  if (!state.workbook) throw new Error('먼저 Excel 파일을 선택해 주세요.');
  if (state.detectedSourceSystem && state.detectedSourceSystem !== $('#importSourceSystem').value) {
    throw new Error(`선택한 파일은 ${state.detectedSourceSystem} 원본으로 판별되었습니다. 원본 종류를 확인해 주세요.`);
  }
  if (!state.mapping.some((row) => row.targetFieldKey === 'sourceCustomerCode')) throw new Error(`${sourceCodeLabel()} 열을 반드시 연결해야 합니다.`);
  await withBusy('업로드 행 분석 중', async () => {
    const sourceSystem = $('#importSourceSystem').value;
    const records = analyzeImportRows(state.workbook.rows, state.mapping, state.data.customers, {
      sourceSystem, sourceLinks: state.data.sourceLinks, rowNumbers: state.workbook.rowNumbers,
    });
    state.importWork = await prepareImportBatch({
      fileName: state.file.name, fileHash: state.fileHash, sourceSystem,
      mapping: state.mapping, records,
    });
    renderImportWork();
    toast(state.importWork.resumed ? '같은 파일의 중단 작업을 불러왔습니다.' : '업로드 분석을 완료했습니다.');
  });
}

async function executeImport() {
  if (!state.importWork?.batch) return;
  const button = $('#applyImportButton');
  button.disabled = true;
  await withBusy('Excel 등록·수정 실행 중', async () => {
    const records = await applyImportBatch(state.importWork.batch.importBatchId, (processed, total) => {
      $('#importProgress').textContent = `${processed.toLocaleString()} / ${total.toLocaleString()}행 처리`;
    });
    state.importWork.records = records;
    renderImportWork();
    await refreshAll();
    const failed = records.filter((row) => row.resultType === 'FAILED').length;
    const pendingReview = records.filter((row) => row.resultType === 'LINK_REVIEW').length;
    toast(failed || pendingReview
      ? `실패 ${failed.toLocaleString()}건 · 연결 확인 ${pendingReview.toLocaleString()}건이 남았습니다.`
      : 'Excel 등록·연결을 완료했습니다.', failed ? 'error' : 'info');
  });
}

async function resumeImport() {
  const work = await latestIncompleteImport();
  if (!work) { toast('이어갈 중단 작업이 없습니다.'); return; }
  state.importWork = work;
  $('#importResult').hidden = false;
  $('#mappingWorkbench').hidden = true;
  $('#selectedFileName').textContent = `${work.batch.fileName} · 중단 작업`;
  renderImportWork();
  activateTab('excel');
}

async function saveUserFields() {
  const rows = $$('[data-user-field]');
  await withBusy('사용자 필드 저장 중', async () => {
    for (const row of rows) await saveUserField(row.dataset.userField, {
      enabled: $('[data-user-enabled]', row).checked,
      displayName: $('[data-user-name]', row).value,
      headerAliases: $('[data-user-aliases]', row).value,
    });
    await renderMappingManagement();
    toast('사용자 정의 필드를 저장했습니다.');
  });
}

async function refreshStorageState() {
  const [customerCount, estimate] = await Promise.all([count(STORE.CUSTOMERS), navigator.storage?.estimate?.() || {}]);
  let persisted = false;
  try { persisted = Boolean(await navigator.storage?.persisted?.()); } catch {}
  const usageMb = Number(estimate.usage || 0) / 1024 / 1024;
  const quotaMb = Number(estimate.quota || 0) / 1024 / 1024;
  $('#storageState').textContent = `${ACTIVE_DB_NAME}\n거래처 ${customerCount.toLocaleString()}건 · 사용 ${usageMb.toFixed(1)}MB / ${quotaMb.toFixed(1)}MB · 영구 저장 ${persisted ? '허용됨' : '미확정'}`;
}

async function inspectLegacy() {
  await withBusy('기존 v17 데이터 확인 중', async () => {
    state.legacyInspection = await inspectLegacyCustomerData();
    const inspection = state.legacyInspection;
    if (!inspection.found) {
      $('#legacyState').textContent = '이 브라우저에서 oneapp-orderq-vnext DB를 찾지 못했습니다.\n기존 원본은 변경하지 않았습니다.';
      $('#migrateLegacyButton').hidden = true;
      return;
    }
    $('#legacyState').textContent = `원본 DB 버전 ${inspection.version}\n거래처 ${Number(inspection.counts?.customers || 0).toLocaleString()}건 · 별칭 ${Number(inspection.counts?.customerAliases || 0).toLocaleString()}건 · 외부 연결 ${Number(inspection.counts?.customerSourceLinks || 0).toLocaleString()}건\n해시 ${inspection.contentHash || '-'}\n${inspection.compatible ? 'v17 읽기 전용 복사 준비 완료' : inspection.reason || '지원하지 않는 버전'}`;
    $('#migrateLegacyButton').hidden = !inspection.compatible;
  });
}

async function migrateLegacy() {
  if (!state.legacyInspection?.compatible) return;
  if (!confirm('기존 v17 데이터는 수정하지 않고 새 거래처관리 DB로 복사합니다. 계속할까요?')) return;
  await withBusy('v17 거래처 데이터 복사·검증 중', async () => {
    const result = await migrateLegacyCustomerData(state.legacyInspection);
    $('#legacyState').textContent += `\n복사 완료 · 원본/복사본 해시 일치 ${result.destinationHash}`;
    $('#migrateLegacyButton').hidden = true;
    await refreshAll();
    toast('v17 거래처 데이터를 새 DB로 복사하고 동등성을 확인했습니다.');
  });
}

async function exportSnapshot() {
  await withBusy('Snapshot 생성 중', async () => {
    const snapshot = await createSnapshot();
    downloadSnapshot(snapshot);
    toast(`Snapshot을 저장했습니다. 해시 ${snapshot.contentHash.slice(0, 12)}`);
  });
}

async function previewRestore(file) {
  await withBusy('Snapshot 검증 중', async () => {
    const snapshot = await readSnapshotFile(file);
    state.restoreSnapshot = snapshot;
    $('#restorePreview').hidden = false;
    $('#restorePreview').textContent = `${file.name}\n생성 ${snapshot.snapshotCreatedAt}\n거래처 ${Number(snapshot.counts.customers || 0).toLocaleString()}건\n해시 ${snapshot.contentHash}`;
    $('#restoreSnapshotButton').hidden = false;
    toast('Snapshot 해시와 건수를 확인했습니다.');
  });
}

async function executeRestore() {
  if (!state.restoreSnapshot) return;
  if (!confirm('현재 데이터는 자동 안전 Snapshot으로 보존한 뒤 선택한 Snapshot으로 교체합니다. 계속할까요?')) return;
  await withBusy('Snapshot 복원·검증 중', async () => {
    const result = await restoreSnapshot(state.restoreSnapshot);
    state.restoreSnapshot = null;
    $('#restorePreview').hidden = true;
    $('#restoreSnapshotButton').hidden = true;
    await refreshAll();
    toast(`Snapshot 복원을 완료했습니다. 복원 전 백업 ${result.backupSnapshotId}`);
  });
}

function bindEvents() {
  $$('.cm-tab').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.tab)));
  $$('.cm-stat').forEach((button) => button.addEventListener('click', () => { state.summaryFilter = button.dataset.summaryFilter; renderStats(); renderCustomerList(); }));
  ['customerSearch', 'statusFilter', 'group1Filter', 'group2Filter', 'managerFilter'].forEach((id) => $(`#${id}`).addEventListener(id === 'customerSearch' ? 'input' : 'change', renderCustomerList));
  $('#newCustomerButton').addEventListener('click', () => openCustomerDialog().catch((error) => toast(error.message, 'error')));
  $('#customerTableBody').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-customer]');
    const status = event.target.closest('[data-toggle-status]');
    if (edit) openCustomerDialog(edit.dataset.editCustomer).catch((error) => toast(error.message, 'error'));
    if (status) toggleCustomerStatus(status.dataset.toggleStatus).catch(() => {});
  });
  $('#customerForm').addEventListener('submit', (event) => submitCustomer(event).catch(() => {}));
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $('#customerDialog').close()));
  $('#completenessBody').addEventListener('input', handleCompletenessInput);
  $('#completenessBody').addEventListener('keydown', handleGridKeydown);
  $('#completenessBody').addEventListener('paste', handleGridPaste);
  $('#saveCompletenessButton').addEventListener('click', () => saveCompleteness().catch(() => {}));
  $('#customerFileInput').addEventListener('change', (event) => selectCustomerFile(event.target.files[0]).catch(() => {}));
  $('#importSourceSystem').addEventListener('change', () => state.file && selectCustomerFile(state.file).catch(() => {}));
  $('#mappingPreviewBody').addEventListener('change', (event) => {
    const select = event.target.closest('[data-mapping-index]');
    if (!select) return;
    const index = Number(select.dataset.mappingIndex);
    state.mapping[index] = { ...state.mapping[index], targetFieldKey: select.value, source: select.value ? 'MANUAL' : 'UNMATCHED' };
    renderMappingSummary();
  });
  $('#saveMappingsButton').addEventListener('click', () => saveCurrentMappings().catch(() => {}));
  $('#analyzeImportButton').addEventListener('click', () => analyzeSelectedImport().catch((error) => toast(error.message, 'error')));
  $('#applyImportButton').addEventListener('click', () => executeImport().catch(() => {}));
  $('#importPreviewBody').addEventListener('click', (event) => {
    const button = event.target.closest('[data-resolve-review]');
    if (button) resolveReviewAction(button).catch(() => {});
  });
  $('#resumeImportButton').addEventListener('click', () => resumeImport().catch(() => {}));
  $('#saveUserFieldsButton').addEventListener('click', () => saveUserFields().catch(() => {}));
  $('#mapCustomerButton').addEventListener('click', () => applyManualCustomerMapping().catch(() => {}));
  $('#canonicalMappingsBody').addEventListener('click', (event) => {
    const button = event.target.closest('[data-release-customer-mapping]');
    if (button) releaseManualCustomerMapping(button.dataset.releaseCustomerMapping).catch(() => {});
  });
  $('#refreshHistoryButton').addEventListener('click', () => renderHistory().catch((error) => toast(error.message, 'error')));
  $('#refreshChangeRequestsButton').addEventListener('click', () => renderChangeRequests());
  $('#inspectLegacyButton').addEventListener('click', () => inspectLegacy().catch(() => {}));
  $('#migrateLegacyButton').addEventListener('click', () => migrateLegacy().catch(() => {}));
  $('#exportSnapshotButton').addEventListener('click', () => exportSnapshot().catch(() => {}));
  $('#snapshotFileInput').addEventListener('change', (event) => previewRestore(event.target.files[0]).catch(() => {}));
  $('#restoreSnapshotButton').addEventListener('click', () => executeRestore().catch(() => {}));
}

async function initialize() {
  bindEvents();
  await withBusy('거래처관리 로컬 DB 준비 중', async () => {
    await initializeDb();
    try { await navigator.storage?.persist?.(); } catch {}
    await refreshAll();
    const incomplete = await latestIncompleteImport();
    $('#resumeImportButton').hidden = !incomplete;
    await refreshStorageState();
  });
  globalThis.__CUSTOMER_MASTER_DEBUG__ = Object.freeze({
    state,
    refreshAll,
    parseCustomerFile,
    parseXlsxBuffer,
    createSnapshot,
    inspectLegacyCustomerData,
    customerReadAdapter,
    renderChangeRequests,
  });
  document.documentElement.dataset.customerMasterReady = 'true';
}

initialize().catch((error) => {
  console.error(error);
  setStatus('거래처관리 시작 실패', 'error');
  toast(`거래처관리 시작에 실패했습니다: ${error.message}`, 'error');
});
