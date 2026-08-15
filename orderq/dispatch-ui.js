import {
  DISPATCH_DRAFT_BUFFER_STORAGE_KEY,
  DISPATCH_WORKSPACE_STORAGE_KEY,
  WORK_EXCEPTION_CODE,
  normalizeWorkspaceState
} from './dispatch-workbench.js?v=0.8.0';
import {
  getDispatchProposals,
  getDispatchWorkbenchData,
  recallDispatch,
  recordDispatchWorkFact,
  releaseDispatch,
  saveDispatchDraft
} from './dispatch-workbench-repository.js?v=0.8.0';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const qty = value => Number(value || 0).toLocaleString('ko-KR', { maximumFractionDigits: 6 });
const readWorkspace = () => {
  try { return normalizeWorkspaceState(JSON.parse(localStorage.getItem(DISPATCH_WORKSPACE_STORAGE_KEY) || '{}')); }
  catch { return normalizeWorkspaceState(); }
};

let workspace = readWorkspace();
let data = { aggregates: [], warehouses: [], inventoryProjection: { rows: [], totals: {} }, workerViews: { byOrder: [], byLocationProduct: [] } };
let proposals = [];
let busy = false;

const message = $('#message');
const dispatchList = $('#dispatchList');
const proposalList = $('#proposalList');
const detail = $('#dispatchDetail');
const statusFilter = $('#statusFilter');
const searchFilter = $('#searchFilter');

function showMessage(value, type = '') {
  message.textContent = value || '';
  message.className = value ? `dispatch-message show ${type}` : 'dispatch-message';
}

function saveWorkspace(options = {}) {
  const captureScroll = options?.captureScroll !== false;
  workspace = normalizeWorkspaceState({
    ...workspace,
    filters: { status: statusFilter.value, search: searchFilter.value },
    scrollTop: captureScroll ? (detail.scrollTop || document.scrollingElement?.scrollTop || 0) : workspace.scrollTop
  });
  localStorage.setItem(DISPATCH_WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
}

function readDraftBuffer(decision) {
  if (!decision || decision.status !== 'DRAFT') return null;
  try {
    const buffer = JSON.parse(localStorage.getItem(DISPATCH_DRAFT_BUFFER_STORAGE_KEY) || 'null');
    if (buffer?.dispatchId !== decision.dispatchId || Number(buffer?.baseRevision) !== Number(decision.revision || 0)) return null;
    return buffer;
  } catch { return null; }
}

function clearDraftBuffer(dispatchId = '') {
  const current = readDraftBuffer({ dispatchId, revision: selectedAggregate()?.decision?.revision, status: 'DRAFT' });
  if (!dispatchId || current?.dispatchId === dispatchId) localStorage.removeItem(DISPATCH_DRAFT_BUFFER_STORAGE_KEY);
}

function saveDraftBuffer() {
  const aggregate = selectedAggregate();
  if (!aggregate || aggregate.decision.status !== 'DRAFT') return;
  const draft = collectDraft(aggregate);
  const buffer = {
    dispatchId: aggregate.decision.dispatchId,
    baseRevision: aggregate.decision.revision,
    lines: draft.lines.map(row => ({
      dispatchLineId: row.dispatchLineId,
      plannedActualQuantity: row.plannedActualQuantity,
      plannedBaseQuantity: row.plannedBaseQuantity
    })),
    allocations: draft.allocations.map(row => ({
      allocationId: row.allocationId,
      dispatchLineId: row.dispatchLineId,
      warehouseId: row.warehouseId,
      plannedBaseQuantity: row.plannedBaseQuantity
    })),
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(DISPATCH_DRAFT_BUFFER_STORAGE_KEY, JSON.stringify(buffer));
  saveWorkspace();
}

function setMode(mode, options = {}) {
  workspace.mode = mode;
  $('#adminMode').hidden = mode !== 'ADMIN';
  $('#workerMode').hidden = mode !== 'WORKER';
  document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
  saveWorkspace(options);
}

function selectedAggregate() {
  const selectedId = workspace.selectedDispatchIds[0] || '';
  return data.aggregates.find(row => row.decision.dispatchId === selectedId) || null;
}

function filteredAggregates() {
  const status = statusFilter.value;
  const search = searchFilter.value.trim().toLowerCase();
  return data.aggregates.filter(row => {
    if (status && row.decision.status !== status) return false;
    if (!search) return true;
    const haystack = [row.decision.dispatchNo, row.decision.customerName, ...row.lines.flatMap(line => [line.actualProductCode, line.actualProductName])].join(' ').toLowerCase();
    return haystack.includes(search);
  });
}

function renderLists() {
  proposalList.innerHTML = proposals.map((proposal, index) => `
    <button class="proposal-card" type="button" data-action="save-proposal" data-index="${index}">
      <span class="card-top"><span>자동 제안 · ${esc(proposal.decision.customerName || '고객 미지정')}</span><span class="status-pill DRAFT">제안</span></span>
      <span class="card-meta"><span>${proposal.lines.length}행</span><span>관리자 저장 전</span></span>
    </button>`).join('');
  $('#proposalCount').textContent = `새 제안 ${proposals.length}건`;
  const rows = filteredAggregates();
  dispatchList.innerHTML = rows.length ? rows.map(row => {
    const decision = row.decision;
    const selected = workspace.selectedDispatchIds.includes(decision.dispatchId);
    const action = (decision.needsActionCodes || []).filter(code => code !== 'READY');
    return `
      <button class="dispatch-card ${selected ? 'selected' : ''}" type="button" data-action="select" data-id="${esc(decision.dispatchId)}">
        <span class="card-top"><span>${esc(decision.dispatchNo)}</span><span class="status-pill ${esc(decision.status)}">${esc(decision.status)}</span></span>
        <span class="card-meta"><span>${esc(decision.customerName || '고객 미지정')}</span><span>${row.lines.length}행</span><span>r${Number(decision.revision || 0)}</span></span>
        ${action.length ? `<span class="card-meta">${action.map(code => `<span class="action-chip">${esc(code)}</span>`).join('')}</span>` : ''}
      </button>`;
  }).join('') : '<div class="empty-state">조건에 맞는 출고 판단이 없습니다.</div>';
  $('#summaryText').textContent = `DRAFT ${data.aggregates.filter(row => row.decision.status === 'DRAFT').length} · RELEASED ${data.aggregates.filter(row => row.decision.status === 'RELEASED').length} · 현재고 ${qty(data.inventoryProjection.totals.onHandQuantity)} · 가용 ${qty(data.inventoryProjection.totals.availableQuantity)}`;
}

function warehouseOptions(selected) {
  return data.warehouses.map(row => `<option value="${esc(row.warehouseId)}" ${row.warehouseId === selected ? 'selected' : ''}>${esc(row.warehouseCode)} ${esc(row.warehouseName)}</option>`).join('');
}

function renderDetail() {
  const aggregate = selectedAggregate();
  if (!aggregate) {
    detail.innerHTML = '<div class="empty-state">왼쪽에서 출고 판단을 선택하세요.</div>';
    return;
  }
  const { decision, lines, allocations, reservations } = aggregate;
  const editable = decision.status === 'DRAFT';
  const draftBuffer = readDraftBuffer(decision);
  const bufferedLines = new Map((draftBuffer?.lines || []).map(row => [row.dispatchLineId, row]));
  const bufferedAllocations = new Map((draftBuffer?.allocations || []).map(row => [row.allocationId, row]));
  const reservationsByAllocation = new Map(reservations.map(row => [row.allocationId, row]));
  const actionButtons = editable
    ? '<button class="dq-btn primary" type="button" data-action="save-draft">DRAFT 저장</button><button class="dq-btn release" type="button" data-action="release">작업목록 배포</button>'
    : '<button class="dq-btn warn" type="button" data-action="recall">작업목록 회수</button>';
  const lineBody = lines.map(line => {
    const lineAllocations = allocations.filter(row => row.dispatchLineId === line.dispatchLineId);
    const allocationBody = lineAllocations.map(allocation => {
      const buffered = bufferedAllocations.get(allocation.allocationId) || {};
      const reservation = reservationsByAllocation.get(allocation.allocationId);
      const conflict = Number(reservation?.conflictBaseQuantity || 0);
      const reservationText = reservation ? `· ${esc(reservation.status)}` : '';
      const conflictText = conflict > 0 ? `예약충돌 ${qty(conflict)}` : '-';
      return `<tr class="allocation-row" data-allocation-id="${esc(allocation.allocationId)}" data-line-id="${esc(line.dispatchLineId)}">
        <td class="allocation-indent">↳ 재고출처</td>
        <td><select class="allocation-warehouse" ${editable ? '' : 'disabled'}>${warehouseOptions(buffered.warehouseId ?? allocation.warehouseId)}</select></td>
        <td><input class="allocation-qty" type="number" step="any" value="${Number(buffered.plannedBaseQuantity ?? allocation.plannedBaseQuantity ?? 0)}" ${editable ? '' : 'disabled'}> ${esc(line.actualUnit)}</td>
        <td>${esc(allocation.status)} ${reservationText}</td>
        <td class="${conflict > 0 ? 'negative' : ''}">${conflictText}</td>
      </tr>`;
    }).join('');
    const bufferedLine = bufferedLines.get(line.dispatchLineId) || {};
    const plannedQuantity = Number(bufferedLine.plannedBaseQuantity ?? line.plannedBaseQuantity ?? 0);
    const workerResult = line.workerReportedQuantity == null ? '-' : qty(line.workerReportedQuantity);
    return `<tr class="dispatch-line-row" data-line-id="${esc(line.dispatchLineId)}">
      <td>${esc(line.requestedProductCode)} ${esc(line.requestedProductName)}</td>
      <td>${esc(line.actualProductCode)} ${esc(line.actualProductName)}<br><small>${esc(line.fulfillmentType)}</small></td>
      <td><input class="line-qty" type="number" step="any" value="${plannedQuantity}" ${editable ? '' : 'disabled'}> ${esc(line.actualUnit)}</td>
      <td>${esc(line.workStatus || 'PENDING')}</td>
      <td>${workerResult} ${esc(line.workerExceptionCode || '')}</td>
    </tr>${allocationBody}`;
  }).join('');
  const historyText = (decision.history || []).slice(-5)
    .map(row => `${esc(row.eventType)} · ${esc(row.actorId)} · ${esc(row.createdAt)}`)
    .join(' / ') || '없음';
  detail.innerHTML = `
    <div class="detail-header">
      <div><h1>${esc(decision.dispatchNo)}</h1><p>${esc(decision.customerName || '고객 미지정')} · 로컬 작업목록 · revision ${Number(decision.revision || 0)}</p></div>
      <div class="detail-actions">${actionButtons}</div>
    </div>
    <div class="detail-facts">
      <div class="fact-box"><b>상태</b><span>${esc(decision.status)}</span></div>
      <div class="fact-box"><b>출고단계</b><span>${esc(decision.dispatchStageCode || 'UNSPECIFIED')}</span></div>
      <div class="fact-box"><b>예약 만료</b><span>${esc(decision.reservationExpiresAt || '-')}</span></div>
      <div class="fact-box"><b>검토</b><span>${esc((decision.needsActionCodes || []).join(', ') || 'READY')}</span></div>
    </div>
    <table class="dq-table">
      <thead><tr><th>주문상품</th><th>실제 작업상품</th><th>계획수량</th><th>작업상태</th><th>작업결과</th></tr></thead>
      <tbody>${lineBody}</tbody>
    </table>
    <div class="history-strip">최근 이력: ${historyText}</div>`;
  const restoreWorkspacePosition = () => {
    const desiredScrollTop = workspace.scrollTop;
    detail.scrollTop = desiredScrollTop;
    if (workspace.focusedDispatchLineId) {
      detail.querySelector(`[data-line-id="${CSS.escape(workspace.focusedDispatchLineId)}"] input, [data-line-id="${CSS.escape(workspace.focusedDispatchLineId)}"] select`)?.focus({ preventScroll: true });
    }
    detail.scrollTop = desiredScrollTop;
  };
  requestAnimationFrame(() => {
    restoreWorkspacePosition();
    setTimeout(restoreWorkspacePosition, 100);
  });
}

function renderWorker() {
  const aggregateRows = data.workerViews.byLocationProduct;
  const aggregateBody = aggregateRows.map(row => {
    const sources = row.sources.map(source => `<span class="source-link">${esc(source.dispatchLineId)} / ${esc(source.allocationId)} · ${qty(source.plannedBaseQuantity)}</span>`).join('');
    return `<tr><td>${esc(row.warehouseCode)} ${esc(row.warehouseName)}</td><td>${esc(row.productCode)} ${esc(row.productName)}</td><td><b>${qty(row.plannedBaseQuantity)}</b> ${esc(row.actualUnit)}</td><td>${sources}</td></tr>`;
  }).join('');
  $('#aggregatePickList').innerHTML = aggregateRows.length
    ? `<table><thead><tr><th>창고</th><th>상품</th><th>합산수량</th><th>원 출고행</th></tr></thead><tbody>${aggregateBody}</tbody></table>`
    : '<div class="empty-state">배포된 작업목록이 없습니다.</div>';
  const orderBody = data.workerViews.byOrder.map(row => {
    const exceptionOptions = Object.values(WORK_EXCEPTION_CODE).map(code => `<option value="${esc(code)}" ${code === (row.workerExceptionCode || '') ? 'selected' : ''}>${esc(code || '정상')}</option>`).join('');
    return `
    <tr><td>${esc(row.dispatchNo)}<br>${esc(row.customerName)}</td><td>${esc(row.productCode)} ${esc(row.productName)}<br><b>${qty(row.plannedBaseQuantity)}</b> ${esc(row.actualUnit)}</td><td>
      <div class="work-form" data-dispatch-id="${esc(row.dispatchId)}" data-line-id="${esc(row.dispatchLineId)}">
        <input class="reported-qty" type="number" step="any" value="${row.workerReportedQuantity ?? row.plannedBaseQuantity}" aria-label="작업수량">
        <select class="exception-code" aria-label="예외">${exceptionOptions}</select>
        <input class="exception-memo" type="text" value="${esc(row.workerExceptionMemo || '')}" placeholder="예외 사유" aria-label="예외 사유">
        <button class="dq-btn" type="button" data-action="work-fact">작업사실 저장</button>
      </div>
    </td></tr>`;
  }).join('');
  $('#orderPickList').innerHTML = data.workerViews.byOrder.length
    ? `<table><thead><tr><th>출고/고객</th><th>상품·수량</th><th>작업사실 입력</th></tr></thead><tbody>${orderBody}</tbody></table>`
    : '<div class="empty-state">배포된 작업목록이 없습니다.</div>';
}

function collectDraft(aggregate) {
  const lines = aggregate.lines.map(line => {
    const row = detail.querySelector(`[data-line-id="${CSS.escape(line.dispatchLineId)}"].dispatch-line-row`);
    return { ...line, plannedActualQuantity: Number(row.querySelector('.line-qty').value), plannedBaseQuantity: Number(row.querySelector('.line-qty').value) };
  });
  const allocations = aggregate.allocations.map(allocation => {
    const row = detail.querySelector(`[data-allocation-id="${CSS.escape(allocation.allocationId)}"]`);
    return { ...allocation, warehouseId: row.querySelector('.allocation-warehouse').value, plannedBaseQuantity: Number(row.querySelector('.allocation-qty').value) };
  });
  return { decision: aggregate.decision, lines, allocations, expectedRevision: aggregate.decision.revision };
}

async function refresh({ preserveMessage = false } = {}) {
  if (busy) return;
  busy = true;
  try {
    [data, proposals] = await Promise.all([getDispatchWorkbenchData(), getDispatchProposals()]);
    if (workspace.selectedDispatchIds[0] && !data.aggregates.some(row => row.decision.dispatchId === workspace.selectedDispatchIds[0])) workspace.selectedDispatchIds = [];
    if (!workspace.selectedDispatchIds.length && data.aggregates.length) {
      workspace.selectedDispatchIds = [data.aggregates[0].decision.dispatchId];
      workspace.expandedDispatchIds = [...new Set([...workspace.expandedDispatchIds, data.aggregates[0].decision.dispatchId])];
    }
    renderLists(); renderDetail(); renderWorker(); saveWorkspace({ captureScroll: false });
    if (!preserveMessage) showMessage('');
  } catch (error) { showMessage(error.message || String(error), 'error'); }
  finally { busy = false; }
}

async function runAction(action, target) {
  if (busy) return;
  const aggregate = selectedAggregate();
  busy = true;
  try {
    if (action === 'save-proposal') {
      const proposal = proposals[Number(target.dataset.index)];
      const saved = await saveDispatchDraft({ ...proposal, expectedRevision: 0 }, 'ADMIN');
      workspace.selectedDispatchIds = [saved.decision.dispatchId];
      workspace.expandedDispatchIds = [...new Set([...workspace.expandedDispatchIds, saved.decision.dispatchId])];
      showMessage('자동 제안을 DRAFT로 저장했습니다.', 'success');
    } else if (action === 'save-draft') {
      await saveDispatchDraft(collectDraft(aggregate), 'ADMIN');
      clearDraftBuffer(aggregate.decision.dispatchId);
      showMessage('DRAFT를 저장했습니다.', 'success');
    } else if (action === 'release') {
      let revision = aggregate.decision.revision;
      if (readDraftBuffer(aggregate.decision)) {
        const saved = await saveDispatchDraft(collectDraft(aggregate), 'ADMIN');
        revision = saved.decision.revision;
        clearDraftBuffer(aggregate.decision.dispatchId);
      }
      await releaseDispatch(aggregate.decision.dispatchId, revision, 'ADMIN');
      showMessage('동일 PC 작업목록으로 배포했습니다. 판매와 현재고는 확정되지 않았습니다.', 'success');
    } else if (action === 'recall') {
      await recallDispatch(aggregate.decision.dispatchId, aggregate.decision.revision, 'ADMIN');
      showMessage('작업목록을 회수하고 예약을 해제했습니다.', 'success');
    } else if (action === 'work-fact') {
      const form = target.closest('.work-form');
      const current = data.aggregates.find(row => row.decision.dispatchId === form.dataset.dispatchId);
      await recordDispatchWorkFact({
        dispatchId: form.dataset.dispatchId, dispatchLineId: form.dataset.lineId, expectedRevision: current.decision.revision,
        workerReportedQuantity: form.querySelector('.reported-qty').value,
        workerExceptionCode: form.querySelector('.exception-code').value,
        workerExceptionMemo: form.querySelector('.exception-memo').value
      }, 'ADMIN');
      showMessage('작업사실을 저장했습니다. 확정수량에는 반영되지 않았습니다.', 'success');
    }
  } catch (error) { showMessage(error.message || String(error), 'error'); }
  finally { busy = false; await refresh({ preserveMessage: true }); }
}

document.addEventListener('click', event => {
  const modeButton = event.target.closest('[data-mode]');
  if (modeButton) { setMode(modeButton.dataset.mode); return; }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.dataset.action === 'select') {
    workspace.selectedDispatchIds = [target.dataset.id];
    workspace.expandedDispatchIds = [...new Set([...workspace.expandedDispatchIds, target.dataset.id])];
    renderLists(); renderDetail(); saveWorkspace();
    return;
  }
  runAction(target.dataset.action, target);
});
$('#refreshBtn').addEventListener('click', () => refresh());
[statusFilter, searchFilter].forEach(control => control.addEventListener('input', () => { renderLists(); saveWorkspace(); }));
detail.addEventListener('focusin', event => {
  const row = event.target.closest('[data-line-id]');
  if (!row) return;
  workspace.focusedDispatchLineId = row.dataset.lineId || '';
  saveWorkspace();
});
detail.addEventListener('input', event => {
  if (event.target.matches('.line-qty,.allocation-qty,.allocation-warehouse')) saveDraftBuffer();
});
detail.addEventListener('change', event => {
  if (event.target.matches('.line-qty,.allocation-qty,.allocation-warehouse')) saveDraftBuffer();
});
detail.addEventListener('scroll', saveWorkspace, { passive: true });
window.addEventListener('beforeunload', saveWorkspace);

statusFilter.value = workspace.filters.status || '';
searchFilter.value = workspace.filters.search || '';
setMode(workspace.mode, { captureScroll: false });
await refresh();
requestAnimationFrame(() => window.scrollTo(0, workspace.scrollTop));
