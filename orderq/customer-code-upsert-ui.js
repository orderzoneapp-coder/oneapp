import {
  buildCustomerHeaderMapping,
  detectCustomerFileType,
  ensureCustomerUserFieldDefinitions,
  getLatestCustomerUpsertWork,
  listCustomerUserFieldDefinitions,
  markCustomerUpsertCloudStatus,
  resumeCustomerCodeUpsert,
  runCustomerCodeUpsert,
  saveCustomerHeaderMapping,
  saveCustomerUserFieldDefinition,
} from './customer-code-upsert.js?v=0.16.0';
import { getByKey, STORE } from './orderq-db.js?v=0.16.0';
import { pushPending } from './orderq-sync-engine.js?v=0.16.0';

const state = {
  sourceSystem: 'ERP',
  fileName: '',
  fileHash: '',
  headers: [],
  rawRows: [],
  headerRowNumber: 1,
  work: null,
  filter: 'SUMMARY',
  busy: false,
  definitions: [],
};

const byId = id => document.getElementById(id);
const clean = value => String(value ?? '').trim();
const escapeHtml = value => clean(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function cloneNodeById(id) {
  const oldNode = byId(id);
  if (!oldNode) return null;
  const node = oldNode.cloneNode(true);
  oldNode.replaceWith(node);
  return node;
}

function takeOverLegacyImportUi() {
  ['importSummary', 'importGate', 'importReview', 'importSearch', 'applyImportButton'].forEach(cloneNodeById);
  byId('importSearch')?.setAttribute('hidden', 'hidden');
  byId('applyImportButton')?.setAttribute('hidden', 'hidden');
}

function showWorkbench() {
  const workbench = byId('importWorkbench');
  if (!workbench) throw new Error('거래처 업로드 결과 영역을 찾지 못했습니다.');
  workbench.hidden = false;
  return workbench;
}

async function hashFile(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function progressView({ processed = 0, total = 0, message = '분석·저장 중입니다.' } = {}) {
  showWorkbench();
  const percent = total ? Math.floor(processed / total * 100) : 0;
  byId('importSummary').innerHTML = `<div class="customer-upsert-progress">
    <strong>${escapeHtml(state.fileName || 'Excel')}</strong>
    <span>${processed.toLocaleString()} / ${total.toLocaleString()} · ${percent}%</span>
    <progress max="${Math.max(total, 1)}" value="${processed}"></progress>
  </div>`;
  byId('importGate').textContent = message;
  byId('importReview').innerHTML = '';
}

function countsFor(work) {
  const records = work?.records || [];
  const count = resultType => records.filter(record => record.resultType === resultType).length;
  return {
    total: records.length,
    created: count('CREATED'),
    updated: count('UPDATED'),
    unchanged: count('UNCHANGED'),
    failed: count('FAILED'),
    empty: count('EMPTY_ROW_EXCLUDED'),
    fieldExcluded: records.reduce((sum, record) => sum + (record.fieldExclusions || []).length, 0),
    unmatched: work?.job?.unmatchedHeaders?.length || 0,
  };
}

const resultLabels = Object.freeze({
  CREATED: '신규', UPDATED: '수정', UNCHANGED: '변경 없음', FAILED: '실패', EMPTY_ROW_EXCLUDED: '빈 행 제외'
});

function fieldChangeList(record) {
  return (record.changedFields || []).map(field => `<li>
    <strong>${escapeHtml(field)}</strong>
    <span>${escapeHtml(record.beforeValues?.[field] ?? '')}</span>
    <i>→</i>
    <span>${escapeHtml(record.afterValues?.[field] ?? '')}</span>
  </li>`).join('');
}

function fieldExclusionList(record) {
  return (record.fieldExclusions || []).map(issue => `<li>
    <strong>${escapeHtml(issue.header || issue.fieldKey)}</strong>
    <span>${escapeHtml(issue.reasonMessage || issue.reasonCode)}</span>
    <code>${escapeHtml(issue.rawValue)}</code>
  </li>`).join('');
}

function resultRow(record) {
  const changes = fieldChangeList(record);
  const exclusions = fieldExclusionList(record);
  const failed = record.resultType === 'FAILED';
  return `<article class="customer-upsert-row customer-upsert-row--${escapeHtml(record.resultType).toLowerCase()}">
    <header>
      <span>행 ${Number(record.excelRowNumber || 0).toLocaleString()}</span>
      <strong>${escapeHtml(record.customerCode || '(코드 없음)')}</strong>
      <b>${escapeHtml(resultLabels[record.resultType] || record.resultType)}</b>
    </header>
    <p>${escapeHtml(record.reasonMessage || record.reasonCode || '정상 처리')}</p>
    ${changes ? `<h4>변경 전 → 변경 후</h4><ul class="customer-upsert-changes">${changes}</ul>` : ''}
    ${exclusions ? `<h4>제외된 필드</h4><ul class="customer-upsert-issues">${exclusions}</ul>` : ''}
    ${failed ? `<details><summary>실패 원문과 근거</summary><pre>${escapeHtml(JSON.stringify({
      reasonCode: record.reasonCode,
      duplicateExcelRows: record.duplicateExcelRows,
      conflictingCustomerIds: record.conflictingCustomerIds,
      sourceLinkKey: record.sourceLinkKey,
      rawRow: record.rawRow
    }, null, 2))}</pre></details>` : ''}
  </article>`;
}

function activeDefinitionOptions() {
  return state.definitions.filter(row => row.enabled && clean(row.displayName)).map(row =>
    `<option value="${escapeHtml(row.fieldKey)}" data-field-type="${escapeHtml(row.fieldType)}">${escapeHtml(row.displayName)} · ${escapeHtml(row.fieldKey)}</option>`
  ).join('');
}

function unmatchedView(work) {
  const unmatched = work?.job?.unmatchedHeaders || [];
  if (!unmatched.length) return '<p class="customer-upsert-empty">미매핑 열이 없습니다.</p>';
  return unmatched.map(row => `<article class="customer-upsert-unmatched">
    <strong>${escapeHtml(row.header)}</strong>
    <span>현재 업로드는 정상 완료되었고 이 열만 Customer 필드에서 제외되었습니다.</span>
    <label>연결
      <select data-map-header="${escapeHtml(row.header)}">
        <option value="">제외 유지</option>
        ${activeDefinitionOptions()}
        <option value="__MANAGE__">+ 빈 슬롯 이름 지정</option>
      </select>
    </label>
  </article>`).join('');
}

function cloudView(work) {
  const job = work?.job || {};
  const synced = job.cloudStatus === 'CLOUD_SYNCED';
  return `<section class="customer-upsert-cloud">
    <strong>로컬 저장</strong><p>완료 · ${Number(job.processedCount || 0).toLocaleString()} / ${Number(job.rowCount || 0).toLocaleString()}</p>
    <strong>Cloud 동기화</strong><p>${synced ? '완료' : '전송 대기'} · 적용 ${Number(job.cloudAppliedCount || 0).toLocaleString()} · 오류 ${Number(job.cloudErrorCount || 0).toLocaleString()}</p>
    ${job.cloudMessage ? `<pre>${escapeHtml(job.cloudMessage)}</pre>` : ''}
  </section>`;
}

function renderWork(work) {
  state.work = work;
  showWorkbench();
  const counts = countsFor(work);
  const job = work.job || {};
  const tabs = [
    ['SUMMARY', '요약', counts.total],
    ['CREATED', '신규', counts.created],
    ['UPDATED', '수정', counts.updated],
    ['UNCHANGED', '변경 없음', counts.unchanged],
    ['FAILED', '실패', counts.failed],
    ['FIELD_EXCLUDED', '필드 제외', counts.fieldExcluded],
    ['UNMATCHED', '미매핑 열', counts.unmatched],
    ['CLOUD', 'Cloud', job.cloudStatus === 'CLOUD_SYNCED' ? '완료' : '대기'],
  ];
  byId('importSummary').innerHTML = `<div class="customer-upsert-complete">
    <strong>${escapeHtml(job.fileName || state.fileName || 'Excel')} · 처리 완료</strong>
    <span>${counts.total.toLocaleString()}행 결과</span>
  </div><nav class="customer-upsert-filters">${tabs.map(([key, label, value]) =>
    `<button type="button" class="${state.filter === key ? 'is-active' : ''}" data-result-filter="${key}">${label} <b>${escapeHtml(value)}</b></button>`
  ).join('')}</nav>`;
  byId('importGate').textContent = counts.failed
    ? `${counts.failed.toLocaleString()}건은 등록되지 않았습니다. 실패 탭에서 코드·행·원문·차단 사유를 확인하세요.`
    : '유효한 모든 행이 Customer Master에 저장되었습니다.';
  const review = byId('importReview');
  if (state.filter === 'SUMMARY') {
    review.innerHTML = `<section class="customer-upsert-summary-grid">
      <div><span>신규</span><strong>${counts.created.toLocaleString()}</strong></div>
      <div><span>수정</span><strong>${counts.updated.toLocaleString()}</strong></div>
      <div><span>변경 없음</span><strong>${counts.unchanged.toLocaleString()}</strong></div>
      <div><span>실패</span><strong>${counts.failed.toLocaleString()}</strong></div>
      <div><span>필드 제외</span><strong>${counts.fieldExcluded.toLocaleString()}</strong></div>
      <div><span>미매핑 열</span><strong>${counts.unmatched.toLocaleString()}</strong></div>
      <div><span>빈 행 제외</span><strong>${counts.empty.toLocaleString()}</strong></div>
      <div><span>Cloud</span><strong>${job.cloudStatus === 'CLOUD_SYNCED' ? '완료' : '대기'}</strong></div>
    </section>`;
  } else if (state.filter === 'UNMATCHED') review.innerHTML = unmatchedView(work);
  else if (state.filter === 'CLOUD') review.innerHTML = cloudView(work);
  else if (state.filter === 'FIELD_EXCLUDED') {
    const records = work.records.filter(record => (record.fieldExclusions || []).length);
    review.innerHTML = records.length ? records.map(resultRow).join('') : '<p class="customer-upsert-empty">제외된 필드가 없습니다.</p>';
  } else {
    const records = work.records.filter(record => record.resultType === state.filter);
    review.innerHTML = records.length ? records.map(resultRow).join('') : '<p class="customer-upsert-empty">해당 결과가 없습니다.</p>';
  }
}

function renderFatal(error, processed = 0, total = 0) {
  showWorkbench();
  byId('importSummary').innerHTML = `<div class="customer-upsert-failed"><strong>전체 처리 실패</strong><span>${escapeHtml(error.code || 'IMPORT_FAILED')}</span></div>`;
  byId('importGate').textContent = `${processed.toLocaleString()} / ${total.toLocaleString()} 처리 후 중단되었습니다.`;
  byId('importReview').innerHTML = `<article class="customer-upsert-error">
    <strong>${escapeHtml(error.message || error)}</strong>
    <pre>${escapeHtml(JSON.stringify({ code: error.code, detectedHeaders: error.detectedHeaders, evidence: error.evidence }, null, 2))}</pre>
    <button class="cm-button" type="button" data-retry-customer-upsert>다시 시도</button>
  </article>`;
}

async function selectHeaderRow(matrix) {
  const candidates = await Promise.all(matrix.slice(0, 30).map(async (row, index) => {
    const headers = (row || []).map(clean);
    const mapping = await buildCustomerHeaderMapping(headers, state.sourceSystem);
    return { index, headers, mapping, score: mapping.matched.length };
  }));
  const valid = candidates.filter(candidate => candidate.mapping.hasCustomerCode)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (valid.length) return valid[0];
  const error = new Error('거래처코드 열을 찾지 못해 등록·수정 0건으로 종료했습니다.');
  error.code = 'CUSTOMER_CODE_COLUMN_NOT_FOUND';
  error.detectedHeaders = candidates.slice(0, 10).map(row => ({ excelRow: row.index + 1, headers: row.headers }));
  throw error;
}

function rowsAfterHeader(matrix, header) {
  return matrix.slice(header.index + 1).map(row => Object.fromEntries(header.headers
    .map((name, index) => [name, row?.[index] ?? ''])
    .filter(([name]) => name)));
}

async function runStoredRows({ resetFilter = true } = {}) {
  if (state.busy) return;
  state.busy = true;
  let processed = 0;
  try {
    progressView({ total: state.rawRows.length, message: '거래처 코드 기준으로 분석·저장 중입니다.' });
    const work = await runCustomerCodeUpsert({
      rawRows: state.rawRows,
      headers: state.headers,
      headerRowNumber: state.headerRowNumber,
      fileName: state.fileName,
      fileHash: state.fileHash,
      sourceSystem: state.sourceSystem,
      onProgress: progress => {
        processed = progress.processed;
        progressView({ ...progress, message: '거래처 코드 기준으로 분석·저장 중입니다.' });
      }
    });
    if (resetFilter) state.filter = 'SUMMARY';
    renderWork(work);
    let syncResult;
    try {
      syncResult = await pushPending();
    } catch (error) {
      syncResult = { online: navigator.onLine, applied: 0, errors: 1, conflicts: 0, message: error.message };
    }
    const updatedJob = await markCustomerUpsertCloudStatus(work.job.importId, syncResult);
    work.job = updatedJob || work.job;
    if (syncResult?.message) work.job.cloudMessage = syncResult.message;
    renderWork(work);
    const refreshKey = `customer-upsert-list-refreshed:${work.job.importId}`;
    if (!sessionStorage.getItem(refreshKey)) {
      sessionStorage.setItem(refreshKey, '1');
      location.reload();
    }
  } catch (error) {
    console.error('[CustomerCodeUpsert]', error);
    renderFatal(error, processed, state.rawRows.length);
  } finally {
    state.busy = false;
  }
}

async function processFile(file, sourceSystem) {
  if (!file || state.busy) return;
  state.sourceSystem = sourceSystem;
  state.fileName = file.name;
  state.fileHash = await hashFile(file);
  progressView({ message: 'Excel 내용을 읽고 있습니다.' });
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false, cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
    const header = await selectHeaderRow(matrix);
    const detection = detectCustomerFileType(header.headers);
    if (detection.suspected) {
      const proceed = confirm(`거래처 파일이 아닌 ${detection.suspectedType} 파일일 가능성이 있습니다.\n\n판정 근거 헤더: ${detection.evidence.join(', ')}\n\n그래도 거래처 등록을 진행하시겠습니까?`);
      if (!proceed) return;
    }
    state.headers = header.headers;
    state.headerRowNumber = header.index + 1;
    state.rawRows = rowsAfterHeader(matrix, header);
    await runStoredRows();
  } catch (error) {
    renderFatal(error, 0, state.rawRows.length);
  }
}

function createFieldManagerDialog() {
  if (byId('customerFieldManagerDialog')) return byId('customerFieldManagerDialog');
  const dialog = document.createElement('dialog');
  dialog.id = 'customerFieldManagerDialog';
  dialog.className = 'customer-field-dialog';
  dialog.innerHTML = `<form method="dialog" class="customer-field-manager">
    <header><div><small>Customer DB</small><h2>사용자 정의 항목</h2></div><button class="cm-button" value="cancel">닫기</button></header>
    <p>문자 10개·숫자 10개 슬롯의 항목명과 Excel 헤더 별칭을 지정합니다. 활성 항목만 거래처 정보에 표시됩니다.</p>
    <div class="customer-field-manager-list" data-field-manager-list></div>
    <footer><span data-field-manager-status></span><button class="cm-button primary" type="button" data-save-field-manager>저장</button></footer>
  </form>`;
  document.body.appendChild(dialog);
  return dialog;
}

async function loadDefinitions() {
  await ensureCustomerUserFieldDefinitions();
  state.definitions = await listCustomerUserFieldDefinitions();
  return state.definitions;
}

async function openFieldManager() {
  const dialog = createFieldManagerDialog();
  const definitions = await loadDefinitions();
  dialog.querySelector('[data-field-manager-list]').innerHTML = definitions.map(row => `<label class="customer-field-manager-row">
    <code>${escapeHtml(row.fieldKey)}</code>
    <strong>${row.fieldType === 'NUMBER' ? '숫자' : '문자'}</strong>
    <input data-field-name="${escapeHtml(row.fieldKey)}" value="${escapeHtml(row.displayName)}" placeholder="항목명">
    <input data-field-aliases="${escapeHtml(row.fieldKey)}" value="${escapeHtml((row.headerAliases || []).join(', '))}" placeholder="Excel 헤더 별칭, 쉼표 구분">
    <span><input type="checkbox" data-field-enabled="${escapeHtml(row.fieldKey)}" ${row.enabled ? 'checked' : ''}> 사용</span>
  </label>`).join('');
  dialog.showModal();
}

async function saveFieldManager(dialog) {
  const status = dialog.querySelector('[data-field-manager-status]');
  status.textContent = '저장 중...';
  for (const definition of state.definitions) {
    const fieldKey = definition.fieldKey;
    const displayName = clean(dialog.querySelector(`[data-field-name="${fieldKey}"]`)?.value);
    const headerAliases = clean(dialog.querySelector(`[data-field-aliases="${fieldKey}"]`)?.value).split(',').map(clean).filter(Boolean);
    const enabled = Boolean(dialog.querySelector(`[data-field-enabled="${fieldKey}"]`)?.checked && displayName);
    await saveCustomerUserFieldDefinition(fieldKey, { displayName, headerAliases, enabled });
  }
  await loadDefinitions();
  await renderCustomerCustomFields();
  try { await pushPending(); } catch (_) {}
  status.textContent = '저장 완료';
  setTimeout(() => dialog.close(), 350);
}

async function renderCustomerCustomFields() {
  const container = document.querySelector('[data-customer-user-fields]');
  const form = byId('customerForm');
  if (!container || !form) return;
  if (!state.definitions.length) await loadDefinitions();
  const customerId = clean(form.elements.namedItem('customerId')?.value);
  const customer = customerId ? await getByKey(STORE.CUSTOMERS, customerId) : null;
  const active = state.definitions.filter(row => row.enabled && clean(row.displayName));
  container.innerHTML = active.length ? active.map(row => `<label>${escapeHtml(row.displayName)}
    <input name="${escapeHtml(row.fieldKey)}" type="${row.fieldType === 'NUMBER' ? 'number' : 'text'}" value="${escapeHtml(customer?.[row.fieldKey] ?? '')}">
  </label>`).join('') : '<small>활성 사용자 정의 항목이 없습니다. 상단 사용자 필드에서 항목명을 지정할 수 있습니다.</small>';
}

async function mapHeader(select) {
  if (select.value === '__MANAGE__') {
    select.value = '';
    await openFieldManager();
    return;
  }
  if (!select.value) return;
  const definition = state.definitions.find(row => row.fieldKey === select.value);
  await saveCustomerHeaderMapping({
    sourceSystem: state.sourceSystem,
    header: select.dataset.mapHeader,
    targetFieldKey: select.value,
    targetType: definition?.fieldType || 'TEXT'
  });
  state.rawRows = state.work.records.map(record => record.rawRow);
  state.headers = state.work.job.detectedHeaders;
  state.headerRowNumber = state.work.job.headerRowNumber;
  state.fileName = state.work.job.fileName;
  state.fileHash = state.work.job.fileHash;
  await runStoredRows({ resetFilter: false });
}

async function restoreWork() {
  try {
    await loadDefinitions();
    const work = await getLatestCustomerUpsertWork();
    if (!work) return;
    state.sourceSystem = work.job.sourceSystem;
    state.fileName = work.job.fileName;
    state.fileHash = work.job.fileHash;
    state.headers = work.job.detectedHeaders || [];
    state.headerRowNumber = work.job.headerRowNumber || 1;
    state.rawRows = work.records.map(record => record.rawRow);
    if (work.job.status === 'PROCESSING') {
      progressView({ processed: work.job.processedCount, total: work.job.rowCount, message: '중단된 저장 작업을 이어서 처리합니다.' });
      const resumed = await resumeCustomerCodeUpsert(work.job.importId, progress => progressView({ ...progress, message: '중단된 저장 작업을 이어서 처리합니다.' }));
      renderWork(resumed);
    } else renderWork(work);
  } catch (error) {
    renderFatal(error);
  }
}

function installFileButtons() {
  const erpInput = cloneNodeById('erpCustomerExcelFile');
  const shopInput = cloneNodeById('shopCustomerExcelFile');
  const erpButton = cloneNodeById('openErpImportButton');
  const shopButton = cloneNodeById('openShopImportButton');
  erpButton?.addEventListener('click', () => erpInput?.click());
  shopButton?.addEventListener('click', () => shopInput?.click());
  erpInput?.addEventListener('change', event => processFile(event.target.files?.[0], 'ERP').finally(() => { event.target.value = ''; }));
  shopInput?.addEventListener('change', event => processFile(event.target.files?.[0], 'SHOP').finally(() => { event.target.value = ''; }));
}

function install() {
  takeOverLegacyImportUi();
  installFileButtons();
  cloneNodeById('manageCustomerUserFieldsButton')?.addEventListener('click', () => openFieldManager().catch(error => alert(error.message)));
  const editor = byId('customerEditor');
  if (editor) new MutationObserver(() => { if (editor.open) renderCustomerCustomFields(); }).observe(editor, { attributes: true, attributeFilter: ['open'] });
  document.addEventListener('click', event => {
    const filter = event.target.closest('[data-result-filter]');
    if (filter && state.work) {
      state.filter = filter.dataset.resultFilter;
      renderWork(state.work);
    }
    if (event.target.closest('[data-retry-customer-upsert]') && state.rawRows.length) runStoredRows();
    if (event.target.closest('[data-save-field-manager]')) saveFieldManager(event.target.closest('dialog')).catch(error => alert(error.message));
  });
  document.addEventListener('change', event => {
    const select = event.target.closest('[data-map-header]');
    if (select) mapHeader(select).catch(error => alert(error.message));
  });
  restoreWork();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
