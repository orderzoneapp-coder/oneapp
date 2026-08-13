import { analyzeExcelFile, analyzeHistoricalText } from './history-collector/collector-importer.js';
import { SOURCE_LABEL } from './history-collector/collector-schema.js';
import {
  commitPreparedImport,
  getCollectorSnapshot,
  rebuildFulfillmentEvidence,
  rollbackImportBatch,
  saveCollectorSettings,
  confirmParserEvidence
} from './history-collector/history-repository.js';
import { syncNow } from './orderq-sync-engine.js';
import { getCloudUrl, getCloudAccessToken } from './orderq-cloud-adapter.js';

const prepared = [];
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const formatTime = value => value ? new Date(value).toLocaleString('ko-KR', { hour12: false }) : '';
const number = value => Number(value || 0).toLocaleString('ko-KR');

function show(text, type = 'info') {
  const element = $('#message');
  element.textContent = text;
  element.className = `message show ${type}`;
}

function renderPrepared() {
  $('#commitBtn').disabled = !prepared.length;
  $('#preparedSummary').textContent = prepared.length ? `${prepared.length}개 자료 · ${number(prepared.reduce((sum, item) => sum + item.rows.length, 0))}행` : '파일을 분석해 주세요.';
  $('#sourceCards').innerHTML = prepared.length ? prepared.map((item, index) => `
    <article class="source-card">
      <header><span class="type">${esc(SOURCE_LABEL[item.sourceType] || item.sourceType)}</span><strong>${esc(item.fileName)}</strong></header>
      <p>시트 ${esc(item.sheetName)} · ${number(item.rows.length)}행 · 판별 ${number(item.confidence)}%</p>
      <p>기준일 ${esc(item.defaultDate || '미확인')} · SHA ${esc(item.fileHash.slice(0, 10))}</p>
      ${(item.warnings || []).map(warning => `<p class="warning">${esc(warning)}</p>`).join('')}
      <button class="btn danger" type="button" data-remove="${index}">제외</button>
    </article>`).join('') : '<div class="empty-card">대기 중인 파일이 없습니다.</div>';
}

async function analyzeFiles(files) {
  for (const file of files) {
    try {
      let result;
      if (/\.txt$/i.test(file.name)) {
        result = await analyzeHistoricalText({ rawText: await file.text(), fileName: file.name, sourceId: file.name, defaultDate: $('#textDate').value });
      } else if (/\.xlsx?$/i.test(file.name)) {
        result = await analyzeExcelFile(file, window.XLSX);
      } else {
        show(`${file.name}: xlsx, xls, txt 파일만 수집할 수 있습니다.`, 'warn');
        continue;
      }
      const existing = prepared.findIndex(item => item.fileHash === result.fileHash && item.sheetName === result.sheetName);
      if (existing >= 0) prepared.splice(existing, 1, result); else prepared.push(result);
    } catch (error) {
      show(error.message || String(error), 'error');
    }
  }
  renderPrepared();
}

function stateBadge(status) {
  return `<span class="link-state ${esc(status)}">${esc(status)}</span>`;
}

async function renderSnapshot() {
  const snapshot = await getCollectorSnapshot();
  const activeBatches = snapshot.batches.filter(row => row.status === 'COMMITTED');
  const summary = {
    batches: activeBatches.length,
    orders: snapshot.orderLines.length,
    sales: snapshot.salesLines.length,
    purchases: snapshot.purchaseLines.length,
    inventory: snapshot.inventoryLines.length,
    linked: snapshot.links.filter(row => ['STRONG','PROBABLE','CONFIRMED'].includes(row.status)).length,
    unlinked: snapshot.links.filter(row => row.status === 'UNLINKED').length
  };
  $('#kpiStrip').innerHTML = [
    ['활성 수집', summary.batches], ['주문행', summary.orders], ['판매행', summary.sales], ['구매행', summary.purchases],
    ['재고행', summary.inventory], ['출고연결', summary.linked], ['미연결 판매', summary.unlinked]
  ].map(([label, value]) => `<div class="kpi"><span>${label}</span><strong>${number(value)}</strong></div>`).join('');

  $('#cutoffTime').value = `${String(snapshot.settings.cutoffHour).padStart(2, '0')}:${String(snapshot.settings.cutoffMinute).padStart(2, '0')}`;
  $('#holidays').value = (snapshot.settings.holidays || []).join(', ');

  const links = snapshot.links.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 300);
  $('#linkRows').innerHTML = links.length ? links.map(link => `
    <tr>
      <td>${stateBadge(link.status)}</td><td>${esc(link.customerName || '')}</td><td class="center">${esc(link.orderDate || '')}</td>
      <td class="center">${esc(link.salesDate || '')}</td><td>${esc(link.productCode || '')}</td><td class="num">${number(link.allocatedQuantity)}</td>
      <td>${esc((link.evidence || []).join(' · '))}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">주문과 판매 이력을 수집하면 연결 결과가 표시됩니다.</td></tr>';

  const evidence = snapshot.evidence.slice().sort((a, b) => b.distinctDateCount - a.distinctDateCount || b.supportCount - a.supportCount);
  $('#evidenceRows').innerHTML = evidence.length ? evidence.map(row => `
    <tr>
      <td>${stateBadge(row.status)}</td><td>${esc(row.customerName || row.customerId)}</td><td>${esc(row.rawExpressions?.join(' / ') || row.normalizedExpression)}</td>
      <td>${esc(row.productCode || (row.conflictingProductCodes || []).join(', '))}</td><td class="center">${number(row.distinctDateCount)}</td><td class="center">${number(row.supportCount)}</td>
      <td class="center">${row.status === 'ADMIN_CONFIRMED' ? '확정됨' : row.status === 'READY_FOR_ADMIN_CONFIRMATION' ? `<button class="btn" data-confirm-evidence="${esc(row.parserEvidenceId)}">관리자 확정</button>` : row.status === 'CONFLICT' ? '검수 필요' : '근거 축적 중'}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">실제 판매와 연결된 주문표현이 아직 없습니다.</td></tr>';

  $('#historyRows').innerHTML = snapshot.batches.length ? snapshot.batches.map(row => `
    <tr>
      <td>${esc(formatTime(row.importedAt))}</td><td>${esc(SOURCE_LABEL[row.sourceType] || row.sourceType)}</td><td>${esc(row.fileName)} / ${esc(row.sheetName)}</td>
      <td class="num">${number(row.insertedRowCount ?? row.rowCount)}</td><td>${stateBadge(row.status)}</td>
      <td class="center">${row.status === 'COMMITTED' ? `<button class="btn danger" data-rollback="${esc(row.importBatchId)}">롤백</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">수집 이력이 없습니다.</td></tr>';
}

async function bestEffortSync() {
  if (!getCloudUrl() || !getCloudAccessToken()) return;
  try { await syncNow(); }
  catch (error) { show(`로컬 수집은 완료됐지만 클라우드 동기화가 남았습니다: ${error.message || error}`, 'warn'); }
}

const dropZone = $('#dropZone');
['dragenter', 'dragover'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.addEventListener('drop', event => analyzeFiles([...event.dataTransfer.files]));
$('#fileInput').addEventListener('change', event => { analyzeFiles([...event.target.files]); event.target.value = ''; });
$('#sourceCards').addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  prepared.splice(Number(button.dataset.remove), 1);
  renderPrepared();
});

$('#analyzeTextBtn').addEventListener('click', async () => {
  try {
    const result = await analyzeHistoricalText({ rawText: $('#historyText').value, sourceId: $('#textSource').value || 'DIRECT_TEXT', fileName: `${$('#textSource').value || '직접입력'}.txt`, defaultDate: $('#textDate').value });
    const existing = prepared.findIndex(item => item.fileHash === result.fileHash);
    if (existing >= 0) prepared.splice(existing, 1, result); else prepared.push(result);
    renderPrepared();
    show(`주문성 메시지 ${number(result.rows.length)}행을 기초이력 수집 대기에 추가했습니다.`, 'info');
  } catch (error) { show(error.message || String(error), 'error'); }
});

$('#commitBtn').addEventListener('click', async () => {
  if (!prepared.length) return;
  const button = $('#commitBtn');
  button.disabled = true;
  try {
    let inserted = 0;
    let skipped = 0;
    for (const item of prepared) {
      const result = await commitPreparedImport(item);
      inserted += result.inserted;
      skipped += result.skipped;
    }
    prepared.splice(0);
    renderPrepared();
    const matching = await rebuildFulfillmentEvidence();
    await renderSnapshot();
    await bestEffortSync();
    show(`수집 완료: ${number(inserted)}행 · 중복제외 ${number(skipped)}행 · 출고연결 ${number(matching.summary.linkedCount)}건`, 'info');
  } catch (error) { show(`수집 실패: ${error.message || error}`, 'error'); }
  finally { button.disabled = !prepared.length; }
});

$('#saveSettingsBtn').addEventListener('click', async () => {
  try {
    const [hour, minute] = $('#cutoffTime').value.split(':').map(Number);
    const holidays = $('#holidays').value.split(',').map(value => value.trim()).filter(Boolean);
    await saveCollectorSettings({ cutoffHour: hour, cutoffMinute: minute, holidays });
    await rebuildFulfillmentEvidence();
    await renderSnapshot();
    await bestEffortSync();
    show('출고 운영 마감과 휴일 기준을 저장하고 연결을 다시 계산했습니다.', 'info');
  } catch (error) { show(error.message || String(error), 'error'); }
});

$('#rebuildBtn').addEventListener('click', async () => {
  try {
    const result = await rebuildFulfillmentEvidence();
    await renderSnapshot();
    show(`연결 계산 완료: 연결 ${number(result.summary.linkedCount)} · 모호 ${number(result.summary.ambiguousCount)} · 미연결 주문 ${number(result.summary.unlinkedOrderCount)}`, 'info');
  } catch (error) { show(error.message || String(error), 'error'); }
});

$('#historyRows').addEventListener('click', async event => {
  const button = event.target.closest('[data-rollback]');
  if (!button || !confirm('이 수집 배치를 비활성화하고 파생 연결·파서근거를 다시 계산할까요? 원본 감사기록은 삭제되지 않습니다.')) return;
  try {
    await rollbackImportBatch(button.dataset.rollback);
    await renderSnapshot();
    await bestEffortSync();
    show('수집 배치를 롤백하고 연결·파서근거를 다시 계산했습니다.', 'info');
  } catch (error) { show(error.message || String(error), 'error'); }
});

$('#evidenceRows').addEventListener('click', async event => {
  const button = event.target.closest('[data-confirm-evidence]');
  if (!button || !confirm('이 주문표현을 해당 거래처의 상품 매핑으로 확정할까요?')) return;
  try {
    await confirmParserEvidence(button.dataset.confirmEvidence);
    await renderSnapshot();
    await bestEffortSync();
    show('파서근거를 고객 범위 매핑으로 확정했습니다.', 'info');
  } catch (error) { show(error.message || String(error), 'error'); }
});

document.querySelector('.collector-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  document.querySelectorAll('.collector-tabs button').forEach(row => row.classList.toggle('active', row === button));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === button.dataset.tab));
});

$('#textDate').value = new Date().toISOString().slice(0, 10);
renderPrepared();
renderSnapshot().catch(error => show(error.message || String(error), 'error'));
