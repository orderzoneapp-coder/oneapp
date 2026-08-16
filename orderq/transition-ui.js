import {
  CUTOVER_MODE,
  evaluateCutoverBoundary,
  isOfficialWriteMode,
  readCutoverControl,
  setCutoverMode
} from './cutover-control.js?v=0.10.0';
import { pingCentralAuthority } from './orderq-cloud-adapter.js?v=0.9.0';
import { pullCentralOfficialState } from './central-command-gateway.js?v=0.10.0';
import {
  exportOrderQBackup,
  parseOrderQBackupJson,
  restoreOrderQBackup,
  validateOrderQBackup
} from './orderq-v7-repository.js?v=0.8.0';
import { buildCurrentShadowReport } from './transition-repository.js?v=0.10.0';

const ACTOR_STORAGE_KEY = 'oneapp.orderq.actor-name.v1';
const elements = Object.fromEntries([
  'message', 'localMode', 'centralMode', 'modeSelect', 'reasonCode', 'reasonNote',
  'applyMode', 'rollbackMode', 'pingCentral', 'modeHistory', 'downloadBackup',
  'backupFile', 'restoreBackup', 'backupStatus', 'runShadow', 'shadowSummary', 'shadowRows'
].map(id => [id, document.getElementById(id)]));
let centralMode = 'UNKNOWN';
let selectedBackup = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
}[char]));
const number = value => value === null || value === undefined ? '-' : Number(value).toLocaleString('ko-KR');
const actor = () => String(localStorage.getItem(ACTOR_STORAGE_KEY) || 'ADMIN').trim() || 'ADMIN';

function showMessage(message, type = 'info') {
  elements.message.textContent = message;
  elements.message.className = `message page-message show ${type}`;
}

function renderModes() {
  const control = readCutoverControl();
  const boundary = evaluateCutoverBoundary(control.mode, centralMode);
  elements.localMode.textContent = control.mode;
  elements.localMode.className = isOfficialWriteMode(control.mode) ? 'allowed' : 'blocked';
  elements.centralMode.textContent = centralMode;
  elements.centralMode.className = isOfficialWriteMode(centralMode) ? 'allowed' : 'blocked';
  elements.modeSelect.value = control.mode;
  elements.modeHistory.innerHTML = control.history.length
    ? [...control.history].reverse().map(row => `<li>${esc(row.changedAt)} · ${esc(row.fromMode)} → <b>${esc(row.toMode)}</b> · ${esc(row.actorId)} · ${esc(row.reasonCode)}${row.reasonNote ? ` · ${esc(row.reasonNote)}` : ''}</li>`).join('')
    : '<li>변경이력 없음 · 안전 기본값 SHADOW</li>';
  if (centralMode !== 'UNKNOWN') {
    showMessage(boundary.writeAllowed
      ? `공식 쓰기 허용 · 로컬/중앙 ${boundary.localMode}`
      : `공식 쓰기 차단 · ${boundary.reasonCode} · Pull/조회는 유지됩니다.`,
    boundary.writeAllowed ? 'success' : 'warning');
  }
}

async function ping() {
  elements.pingCentral.disabled = true;
  try {
    const result = await pingCentralAuthority();
    centralMode = String(result.cutoverMode || 'SHADOW').toUpperCase();
    renderModes();
    showMessage(`중앙 확인 완료 · ${centralMode} · cursor ${Number(result.cursor || 0)} · ledger ${Number(result.ledgerSequence || 0)}`, 'success');
    return result;
  } catch (error) {
    centralMode = 'OFFLINE';
    renderModes();
    showMessage(`중앙 미연결 · 공식 쓰기 차단 · ${error.message}`, 'error');
    throw error;
  } finally {
    elements.pingCentral.disabled = false;
  }
}

function applyMode(mode, reasonCode) {
  const current = readCutoverControl();
  const next = setCutoverMode({
    mode,
    actorId: actor(),
    reasonCode,
    reasonNote: elements.reasonNote.value,
    expectedRevision: current.revision
  });
  renderModes();
  showMessage(`이 프로필 모드 변경 완료 · ${current.mode} → ${next.mode}. 중앙 모드는 별도 승인값입니다.`, 'success');
}

function downloadJson(value, fileName) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type:'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function axisCell(axis) {
  return `<div class="axis-values"><small>기존</small><b>${number(axis.legacy)}</b><small>신규</small><b>${number(axis.orderq)}</b></div>`;
}

function renderShadow(result) {
  const report = result.report;
  elements.shadowSummary.textContent = `비교 ${report.summary.total}품목 · 일치 ${report.summary.matched} · 차이 ${report.summary.differences} · 기존 ${result.legacy.basisDate || '기준일 없음'} / 신규 ${result.orderq.basis.basisDate || '기준일 없음'}`;
  elements.shadowRows.innerHTML = report.rows.length ? report.rows.map(row => `
    <tr class="${row.matched ? '' : 'has-difference'}">
      <td><b>${esc(row.productCode || row.productKey)}</b><br><small>${esc(row.productName)}</small></td>
      <td><small>기존 ${esc(row.basis.legacy.join(',') || '-')}</small><br><small>신규 ${esc(row.basis.orderq.join(',') || '-')}</small></td>
      <td>${axisCell(row.axes.snapshot)}</td>
      <td>${axisCell(row.axes.purchase)}</td>
      <td>${axisCell(row.axes.actualSale)}</td>
      <td>${axisCell(row.axes.orderRequestVsReservation)}</td>
      <td>${axisCell(row.axes.onHand)}</td>
      <td>${axisCell(row.axes.available)}</td>
      <td>${row.reasonCodes.map(code => `<span class="reason-code ${code === 'MATCH' ? 'match' : ''}">${esc(code)}</span>`).join('')}
        <div class="evidence">기존: ${esc(row.evidenceIds.legacy.join(', ') || '-')}<br>신규: ${esc(row.evidenceIds.orderq.join(', ') || '-')}</div></td>
    </tr>`).join('') : '<tr><td colspan="9">비교할 상품이 없습니다.</td></tr>';
}

elements.applyMode.addEventListener('click', () => {
  try { applyMode(elements.modeSelect.value, elements.reasonCode.value); }
  catch (error) { showMessage(error.message, 'error'); }
});
elements.rollbackMode.addEventListener('click', () => {
  try { applyMode(CUTOVER_MODE.LEGACY_PRIMARY, 'IMMEDIATE_ROLLBACK'); }
  catch (error) { showMessage(error.message, 'error'); }
});
elements.pingCentral.addEventListener('click', () => ping().catch(() => {}));

elements.downloadBackup.addEventListener('click', async () => {
  elements.downloadBackup.disabled = true;
  try {
    const backup = await exportOrderQBackup({ actorId:actor() });
    validateOrderQBackup(backup);
    downloadJson(backup, `orderq-full-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    elements.backupStatus.textContent = JSON.stringify({ exportedAt:backup.exportedAt, schemaVersion:backup.schemaVersion, counts:backup.counts }, null, 2);
    showMessage('전체 Store 백업 생성·구조 검증 완료', 'success');
  } catch (error) { showMessage(error.message, 'error'); }
  finally { elements.downloadBackup.disabled = false; }
});

elements.backupFile.addEventListener('change', async () => {
  selectedBackup = null;
  elements.restoreBackup.disabled = true;
  try {
    const file = elements.backupFile.files?.[0];
    if (!file) return;
    const backup = parseOrderQBackupJson(await file.text());
    const validation = validateOrderQBackup(backup);
    selectedBackup = backup;
    elements.restoreBackup.disabled = false;
    elements.backupStatus.textContent = JSON.stringify({ fileName:file.name, ...validation }, null, 2);
    showMessage('백업 구조 검증 완료 · 복원은 격리 프로필에서만 실행하십시오.', 'success');
  } catch (error) {
    elements.backupStatus.textContent = error.message;
    showMessage(error.message, 'error');
  }
});

elements.restoreBackup.addEventListener('click', async () => {
  if (!selectedBackup) return;
  if (!confirm('현재 프로필의 ORDER Q 전체 Store를 선택 백업으로 교체합니다. 격리된 복원훈련 프로필이 맞습니까?')) return;
  elements.restoreBackup.disabled = true;
  try {
    const result = await restoreOrderQBackup(selectedBackup, { actorId:actor() });
    elements.backupStatus.textContent = JSON.stringify(result, null, 2);
    showMessage('전체 Store 원자 복원 완료', 'success');
  } catch (error) { showMessage(error.message, 'error'); }
  finally { elements.restoreBackup.disabled = false; }
});

elements.runShadow.addEventListener('click', async () => {
  elements.runShadow.disabled = true;
  try {
    const result = await buildCurrentShadowReport();
    renderShadow(result);
    showMessage(`Shadow 비교 완료 · 차이 ${result.report.summary.differences}건`, result.report.summary.differences ? 'warning' : 'success');
  } catch (error) {
    elements.shadowSummary.textContent = `비교 실패 · ${error.message}`;
    showMessage(error.message, 'error');
  } finally { elements.runShadow.disabled = false; }
});

renderModes();
ping().then(() => pullCentralOfficialState()).catch(() => {});
