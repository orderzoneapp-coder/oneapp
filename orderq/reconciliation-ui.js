import {
  adjustDispatchAfterShipment,
  completeDispatchReconciliation,
  createDispatchReconciliationIssue,
  listDispatchReconciliationWorkspace
} from './dispatch-reconciliation-repository.js?v=0.9.0';
import { loadDispatchAggregate } from './dispatch-workbench-repository.js?v=0.9.0';
import { runCentralOfficialCommand } from './central-command-gateway.js?v=0.9.0';
import { disableCentralAuthorityModeForLegacyTest, enableCentralAuthorityMode } from './official-command-policy.js?v=0.9.0';

let parentSearch = '';
try { parentSearch = window.parent?.location?.search || ''; } catch {}
const legacyLocalBrowserTest = ['127.0.0.1', 'localhost'].includes(location.hostname)
  && /[?&]m8-browser=/i.test(`${location.search}&${parentSearch}`);
if (legacyLocalBrowserTest) disableCentralAuthorityModeForLegacyTest();
else enableCentralAuthorityMode();
const runOfficialCommand = (source, operation) => legacyLocalBrowserTest
  ? operation()
  : runCentralOfficialCommand(source, operation);

const state = { workspace: { candidates: [], reconciliations: [] }, selectedType: '', selectedId: '', busy: false };
const candidateList = document.querySelector('#candidateList');
const issueList = document.querySelector('#issueList');
const detailPanel = document.querySelector('#detailPanel');
const message = document.querySelector('#message');
const summaryText = document.querySelector('#summaryText');

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function qty(value) {
  return number(value).toLocaleString('ko-KR', { maximumFractionDigits: 6 });
}

function setMessage(value = '', type = '') {
  message.textContent = value;
  message.className = `reconciliation-message ${type}`;
}

function selectedCandidate() {
  return state.workspace.candidates.find(row => row.decision.dispatchId === state.selectedId) || null;
}

function selectedIssue() {
  return state.workspace.reconciliations.find(row => row.reconciliationId === state.selectedId) || null;
}

function candidateButton(row) {
  const decision = row.decision;
  const issue = state.workspace.reconciliations.find(item => item.dispatchId === decision.dispatchId && item.status === 'REVIEW_REQUIRED');
  return `<button type="button" data-action="select-candidate" data-id="${esc(decision.dispatchId)}" class="${state.selectedType === 'candidate' && state.selectedId === decision.dispatchId ? 'active' : ''}">
    <span class="list-title"><span>${esc(decision.dispatchNo || decision.dispatchId)}</span><span class="status-chip">${esc(row.salesDocument?.erpPostingStatus || 'READY')}</span></span>
    <span class="list-meta">${esc(decision.customerName || '')} · ${esc(decision.businessDate || '')}${issue ? ' · 검토중' : ''}</span>
  </button>`;
}

function issueButton(row) {
  return `<button type="button" data-action="select-issue" data-id="${esc(row.reconciliationId)}" class="${state.selectedType === 'issue' && state.selectedId === row.reconciliationId ? 'active' : ''}">
    <span class="list-title"><span>${esc(row.reconciliationId)}</span><span class="status-chip">${esc(row.status)}</span></span>
    <span class="list-meta">${esc(row.reasonCode)} · ${esc(row.dispatchId)} · rev ${number(row.revision)}</span>
  </button>`;
}

function renderLists() {
  candidateList.innerHTML = state.workspace.candidates.length
    ? state.workspace.candidates.map(candidateButton).join('')
    : '<div class="empty-state">대사 가능한 확정 출고가 없습니다.</div>';
  issueList.innerHTML = state.workspace.reconciliations.length
    ? state.workspace.reconciliations.map(issueButton).join('')
    : '<div class="empty-state">등록된 대사 이슈가 없습니다.</div>';
  summaryText.textContent = `확정 출고 ${state.workspace.candidates.length}건 · 대사 이슈 ${state.workspace.reconciliations.length}건`;
}

function candidateLineRows(candidate) {
  return candidate.lines.map(line => {
    const sales = line.salesLine || {};
    const actual = number(sales.actualQuantity ?? sales.quantity);
    const base = number(sales.actualBaseQuantity ?? actual);
    const recognized = number(sales.recognizedOrderQuantity ?? actual);
    const allocations = line.allocations.map(allocation => {
      const movementBase = Math.abs(number(allocation.movement?.signedBaseQuantity));
      return `<tr class="allocation-row" data-allocation-row="${esc(allocation.allocationId)}" data-line-id="${esc(line.dispatchLineId)}">
        <td colspan="2">↳ 창고 ${esc(allocation.warehouseId)} · Movement ${esc(allocation.movementId || allocation.movement?.movementId || '')}</td>
        <td><input readonly value="${movementBase}" aria-label="확정 창고수량"></td>
        <td><input class="verified-allocation-base" data-allocation-id="${esc(allocation.allocationId)}" type="number" min="0" step="any" value="${movementBase}" aria-label="확인 창고수량"></td>
        <td></td>
      </tr>`;
    }).join('');
    return `<tr data-line-row="${esc(line.dispatchLineId)}">
      <td>${esc(line.actualProductName || sales.productName || line.actualProductId)}<br><small>주문행 ${esc(line.orderItemId)}</small></td>
      <td><input readonly value="${actual}" aria-label="확정 실제수량"></td>
      <td><input readonly value="${base}" aria-label="확정 기준수량"></td>
      <td><input readonly value="${recognized}" aria-label="확정 인정수량"></td>
      <td class="verified-fields">
        <input class="verified-actual" type="number" min="0" step="any" value="${actual}" aria-label="확인 실제수량">
        <input class="verified-base" type="number" min="0" step="any" value="${base}" aria-label="확인 기준수량">
        <input class="verified-recognized" type="number" min="0" step="any" value="${recognized}" aria-label="확인 인정수량">
      </td>
    </tr>${allocations}`;
  }).join('');
}

function renderCandidate(candidate) {
  detailPanel.innerHTML = `<div class="detail-title">
      <div><h2>${esc(candidate.decision.dispatchNo || candidate.decision.dispatchId)}</h2><div>${esc(candidate.decision.customerName || '')} · ERP ${esc(candidate.salesDocument?.erpPostingStatus || '')} ${esc(candidate.salesDocument?.erpDocumentNo || '')}</div></div>
      <div class="readonly-banner">확정 원본 직접수정 금지</div>
    </div>
    <table class="fact-table"><thead><tr><th>상품·주문행</th><th>확정 실제</th><th>확정 기준</th><th>확정 인정</th><th>현장 확인 실제 / 기준 / 인정</th></tr></thead>
      <tbody>${candidateLineRows(candidate)}</tbody>
    </table>
    <div class="reason-grid">
      <select id="reasonCode"><option value="ACTUAL_SHIPMENT_MISMATCH">실제 출고 차이</option><option value="WAREHOUSE_COUNT_MISMATCH">창고 수량 차이</option><option value="DATA_ENTRY_ERROR">입력 오류</option></select>
      <input id="reasonNote" placeholder="차이 확인 근거와 정정 사유" value="현장 출고 결과 대사">
    </div>
    <div class="action-row"><button class="rq-btn primary" data-action="create-issue" type="button">대사 이슈 생성</button></div>`;
}

function renderIssue(issue) {
  const corrected = issue.status === 'CORRECTION_DRAFT_CREATED';
  const history = (issue.history || []).map(row => `<li>${esc(row.createdAt)} · ${esc(row.eventType)} · ${esc(row.actorId)}</li>`).join('');
  detailPanel.innerHTML = `<div class="detail-title">
      <div><h2>대사 이슈 ${esc(issue.reconciliationId)}</h2><div>${esc(issue.dispatchId)} · ${esc(issue.reasonCode)} · revision ${number(issue.revision)}</div></div>
      <span class="status-chip">${esc(issue.status)}</span>
    </div>
    <div class="issue-evidence">
      <div><b>확정 원값</b>${qty(issue.originalValue?.actualQuantity)} / ${qty(issue.originalValue?.actualBaseQuantity)} / ${qty(issue.originalValue?.recognizedOrderQuantity)}</div>
      <div><b>현장 확인값</b>${qty(issue.actualValue?.actualQuantity)} / ${qty(issue.actualValue?.actualBaseQuantity)} / ${qty(issue.actualValue?.recognizedOrderQuantity)}</div>
      <div><b>차이수량</b>${qty(issue.differenceQuantity?.actualQuantity)} / ${qty(issue.differenceQuantity?.actualBaseQuantity)} / ${qty(issue.differenceQuantity?.recognizedOrderQuantity)}</div>
      <div><b>ERP</b>${esc(issue.erpPostingStatus)} · ${esc(issue.originalErpDocumentNo || issue.erpDocumentNo || '미반영')}</div>
    </div>
    <table class="fact-table"><thead><tr><th>원 출고행</th><th>상품</th><th>확정 실제/기준/인정</th><th>확인 실제/기준/인정</th><th>차이 실제/기준/인정</th></tr></thead><tbody>
      ${(issue.lines || []).map(row => `<tr><td>${esc(row.dispatchLineId)}<br><small>${esc(row.orderItemId)}</small></td><td>${esc(row.actualProductId)}</td><td>${qty(row.expectedActualQuantity)} / ${qty(row.expectedBaseQuantity)} / ${qty(row.expectedRecognizedOrderQuantity)}</td><td>${qty(row.actualActualQuantity)} / ${qty(row.actualBaseQuantity)} / ${qty(row.actualRecognizedOrderQuantity)}</td><td>${qty(row.differenceActualQuantity)} / ${qty(row.differenceBaseQuantity)} / ${qty(row.differenceRecognizedOrderQuantity)}</td></tr>`).join('')}
    </tbody></table>
    <p><b>사유:</b> ${esc(issue.reasonNote)}</p>
    ${corrected ? `<p><b>역분개:</b> ${esc(issue.reversalDispatchId)} · <b>수정 DRAFT:</b> ${esc(issue.correctionDispatchId)}</p>` : ''}
    <ul class="history-list">${history}</ul>
    <div class="action-row">
      ${issue.status === 'REVIEW_REQUIRED' ? '<button class="rq-btn primary" data-action="create-correction" type="button">역분개 후 수정 DRAFT 생성</button>' : ''}
      ${corrected ? '<button class="rq-btn" data-action="complete-issue" type="button">재확정 완료 확인</button>' : ''}
    </div>`;
}

function render() {
  renderLists();
  if (state.selectedType === 'candidate') {
    const candidate = selectedCandidate();
    if (candidate) return renderCandidate(candidate);
  }
  if (state.selectedType === 'issue') {
    const issue = selectedIssue();
    if (issue) return renderIssue(issue);
  }
  detailPanel.innerHTML = '<div class="empty-state">왼쪽에서 확정 출고 또는 대사 이슈를 선택하세요.</div>';
}

async function refresh(preserveSelection = true) {
  const previous = preserveSelection ? { type: state.selectedType, id: state.selectedId } : { type: '', id: '' };
  state.workspace = await listDispatchReconciliationWorkspace();
  if (previous.type === 'candidate' && state.workspace.candidates.some(row => row.decision.dispatchId === previous.id)) {
    state.selectedType = previous.type; state.selectedId = previous.id;
  } else if (previous.type === 'issue' && state.workspace.reconciliations.some(row => row.reconciliationId === previous.id)) {
    state.selectedType = previous.type; state.selectedId = previous.id;
  } else {
    state.selectedType = ''; state.selectedId = '';
  }
  render();
}

function collectIssueCommand(candidate) {
  const rows = [...detailPanel.querySelectorAll('[data-line-row]')];
  return {
    dispatchId: candidate.decision.dispatchId,
    expectedRevision: candidate.decision.revision,
    idempotencyKey: `DATAOPS_RECON:${candidate.decision.dispatchId}:${candidate.decision.revision}`,
    reasonCode: document.querySelector('#reasonCode').value,
    reasonNote: document.querySelector('#reasonNote').value,
    lines: rows.map(row => ({
      dispatchLineId: row.dataset.lineRow,
      actualQuantity: row.querySelector('.verified-actual').value,
      actualBaseQuantity: row.querySelector('.verified-base').value,
      recognizedOrderQuantity: row.querySelector('.verified-recognized').value,
      allocations: [...detailPanel.querySelectorAll(`[data-allocation-row][data-line-id="${CSS.escape(row.dataset.lineRow)}"]`)].map(allocationRow => ({
        allocationId: allocationRow.dataset.allocationRow,
        actualBaseQuantity: allocationRow.querySelector('.verified-allocation-base').value
      }))
    }))
  };
}

async function runBusy(action) {
  if (state.busy) return;
  state.busy = true;
  detailPanel.querySelectorAll('button').forEach(button => { button.disabled = true; });
  setMessage('처리 중…');
  try { await action(); }
  catch (error) { setMessage(error?.message || String(error), 'error'); }
  finally { state.busy = false; render(); }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'select-candidate') {
    state.selectedType = 'candidate'; state.selectedId = button.dataset.id; setMessage(); render(); return;
  }
  if (action === 'select-issue') {
    state.selectedType = 'issue'; state.selectedId = button.dataset.id; setMessage(); render(); return;
  }
  if (action === 'create-issue') runBusy(async () => {
    const result = await createDispatchReconciliationIssue(collectIssueCommand(selectedCandidate()), 'ADMIN');
    state.selectedType = 'issue'; state.selectedId = result.reconciliation.reconciliationId;
    await refresh();
    setMessage(result.duplicate ? '같은 대사 이슈를 다시 불러왔습니다.' : '대사 이슈를 생성했습니다.', 'ok');
  });
  if (action === 'create-correction') runBusy(async () => {
    const issue = selectedIssue();
    const adjustmentCommand = {
      reconciliationId: issue.reconciliationId,
      expectedRevision: issue.revision,
      idempotencyKey: `DATAOPS_ADJUST:${issue.reconciliationId}:${issue.revision}`,
      reason: issue.reasonNote
    };
    const result = await runOfficialCommand({
      commandType:'ADJUST_DISPATCH', aggregateId:issue.dispatchId,
      expectedRevision:issue.sourceDispatchRevision, idempotencyKey:adjustmentCommand.idempotencyKey,
      intent:{ reconciliationId:issue.reconciliationId, issueRevision:issue.revision }
    }, () => adjustDispatchAfterShipment(adjustmentCommand, 'ADMIN'));
    state.selectedId = result.reconciliation.reconciliationId;
    await refresh();
    setMessage('원 출고를 역분개하고 수정 DRAFT를 생성했습니다.', 'ok');
  });
  if (action === 'complete-issue') runBusy(async () => {
    const issue = selectedIssue();
    const completionCommand = {
      reconciliationId: issue.reconciliationId,
      expectedRevision: issue.revision,
      idempotencyKey: `DATAOPS_COMPLETE:${issue.reconciliationId}:${issue.revision}`
    };
    const correction = await loadDispatchAggregate(issue.correctionDispatchId);
    const result = await runOfficialCommand({
      commandType:'ADJUST_DISPATCH', aggregateId:issue.correctionDispatchId,
      expectedRevision:correction.decision.revision, idempotencyKey:completionCommand.idempotencyKey,
      intent:{ reconciliationId:issue.reconciliationId, issueRevision:issue.revision, complete:true }
    }, () => completeDispatchReconciliation(completionCommand, 'ADMIN'));
    state.selectedId = result.reconciliation.reconciliationId;
    await refresh();
    setMessage('재확정 결과를 대사 이슈에 연결했습니다.', 'ok');
  });
});

document.querySelector('#refreshBtn').addEventListener('click', () => refresh().catch(error => setMessage(error.message, 'error')));
refresh(false).catch(error => setMessage(error?.message || String(error), 'error'));
