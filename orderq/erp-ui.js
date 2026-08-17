import { createErpWorkbookBuffer } from './erp-exchange.js?v=0.9.0';
import {
  loadErpExchangeWorkspace,
  markErpDocumentsExported,
  reconcileErpRows,
  transitionErpDocuments
} from './erp-exchange-repository.js?v=0.9.0';
import { runCentralOfficialCommand } from './central-command-gateway.js?v=0.9.0';
import { enableCentralAuthorityMode } from './official-command-policy.js?v=0.9.0';
import { erpStatusLabel } from './workflow-language.js?v=0.11.0';

enableCentralAuthorityMode();

const summary = document.querySelector('#summary');
const message = document.querySelector('#message');
const results = document.querySelector('#results');
let workspace = null;

function text(value) { return value === undefined || value === null ? '' : String(value); }
function esc(value) { return text(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function show(value, type = '') { message.textContent = value; message.className = `message ${value ? 'show' : ''} ${type}`; }

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function reload() {
  workspace = await loadErpExchangeWorkspace();
  const all = [...workspace.salesDocuments, ...workspace.purchaseDocuments];
  const count = status => all.filter(row => row.erpPostingStatus === status).length;
  summary.innerHTML = ['READY','EXPORTED','POSTED','RECONCILED','CORRECTION_REQUIRED']
    .map(status => `<span>${erpStatusLabel(status)} ${count(status)}</span>`).join('');
}

function reconciliationStatusLabel(status) {
  return ({
    EXACT: '정확히 연결됨',
    CONTENT_CONFLICT: '내용이 다름',
    REVIEW_REQUIRED: '관리자 확인 필요',
    MISSING: '연결 자료 없음',
    DUPLICATE: '중복 확인 필요'
  })[status] || status || '확인 필요';
}

function download(buffer, fileName) {
  const url = URL.createObjectURL(new Blob([buffer], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.querySelector('#exportBtn').addEventListener('click', async () => {
  try {
    await reload();
    const rows = workspace.rows;
    const documentIds = [...new Set([...rows.sales, ...rows.purchases].map(row => row.orderqDocumentId))];
    if (!documentIds.length) throw new Error('ERP 자료 준비가 끝난 구매·판매 기록이 없습니다.');
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const batchId = `ERP-EXPORT-${stamp}`;
    const buffer = createErpWorkbookBuffer(rows, window.XLSX);
    download(buffer, `ORDERQ_ERP_INPUT_${stamp}.xlsx`);
    await runCentralOfficialCommand({
      commandType:'ERP_TRANSITION', aggregateId:batchId, expectedRevision:1,
      idempotencyKey:`M9:ERP:EXPORT:${batchId}`, intent:{ documentIds }
    }, () => markErpDocumentsExported({ documentIds, erpExportBatchId:batchId }, 'ADMIN'));
    show(`ERP 입력파일을 만들고 ${documentIds.length}건을 '파일 생성 완료'로 표시했습니다.`, 'success');
    await reload();
  } catch (error) { show(error.message || String(error), 'error'); }
});

document.querySelector('#reconcileBtn').addEventListener('click', async () => {
  try {
    const file = document.querySelector('#importFile').files[0];
    if (!file) throw new Error('ERP 결과 XLSX를 선택하세요.');
    const workbook = window.XLSX.read(await file.arrayBuffer(), { type:'array', cellDates:false, raw:true });
    const imported = workbook.SheetNames.flatMap(name => window.XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval:'', raw:true }));
    const reconciliation = await reconcileErpRows(imported);
    const reconciled = reconciliation.rows;
    results.innerHTML = `<table class="erp-table"><thead><tr><th>행</th><th>판정</th><th>ERP 전표</th><th>ORDER Q</th><th>후보</th></tr></thead><tbody>${reconciled.map(row => `
      <tr><td>${row.importIndex + 1}</td><td class="erp-status ${esc(row.status)}">${esc(reconciliationStatusLabel(row.status))}</td><td>${esc(row.imported.externalDocumentNo)} / ${esc(row.imported.externalLineNo)}</td><td>${esc(row.imported.orderqDocumentId)} / ${esc(row.imported.orderqLineId)}</td><td>${row.candidates.length}</td></tr>`).join('')}</tbody></table>`;
    const exactByDocument = new Map(reconciliation.documents.filter(row => row.status === 'EXACT').map(row => [row.key, row]));
    if (exactByDocument.size) {
      const postedTransitions = [];
      exactByDocument.forEach(document => {
        if (document.currentStatus === 'EXPORTED') postedTransitions.push({
          documentType:document.documentType, documentId:document.orderqDocumentId,
          nextStatus:'POSTED', erpDocumentNo:document.erpDocumentNo
        });
      });
      const key = `M9:ERP:RECONCILE:${[...exactByDocument.keys()].sort().join('|')}:${file.name}`;
      const importFingerprint = await sha256Hex([...exactByDocument.values()]
        .flatMap(row => row.exactRows.map(match => match.imported))
        .sort((left, right) => `${left.orderqDocumentId}:${left.orderqLineId}`.localeCompare(`${right.orderqDocumentId}:${right.orderqLineId}`)));
      if (postedTransitions.length) await runCentralOfficialCommand({
          commandType:'ERP_TRANSITION', aggregateId:file.name, expectedRevision:1,
          idempotencyKey:`${key}:POSTED`, intent:{ exactDocuments:postedTransitions.map(row => `${row.documentType}:${row.documentId}`), nextStatus:'POSTED', importFingerprint }
        }, () => transitionErpDocuments({ transitions:postedTransitions }, 'ADMIN'));
      const reconciledTransitions = [...exactByDocument.values()].map(document => ({
        documentType:document.documentType, documentId:document.orderqDocumentId,
        nextStatus:'RECONCILED', erpDocumentNo:document.erpDocumentNo
      }));
      await runCentralOfficialCommand({
        commandType:'ERP_TRANSITION', aggregateId:file.name, expectedRevision:1,
        idempotencyKey:`${key}:RECONCILED`, intent:{ exactDocuments:[...exactByDocument.keys()], nextStatus:'RECONCILED', importFingerprint }
      }, () => transitionErpDocuments({ transitions:reconciledTransitions }, 'ADMIN'));
    }
    const reviewCount = reconciliation.documents.filter(row => row.status !== 'EXACT').length
      + reconciled.filter(row => row.status !== 'EXACT' && !row.candidates.length).length;
    show(`정확히 연결 ${exactByDocument.size}건 · 확인 필요 ${reviewCount}건. 애매한 자료는 자동으로 연결하지 않았습니다.`, reviewCount ? 'warn' : 'success');
    await reload();
  } catch (error) { show(error.message || String(error), 'error'); }
});

reload().catch(error => show(error.message || String(error), 'error'));
