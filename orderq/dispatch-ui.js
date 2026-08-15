import {
  CONVERSION_TYPE,
  CUSTOMER_NOTICE_STATUS,
  DISPATCH_PRICE_SOURCE,
  DISPATCH_DRAFT_BUFFER_STORAGE_KEY,
  DISPATCH_WORKSPACE_STORAGE_KEY,
  FULFILLMENT_TYPE,
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
import { buildDispatchConfirmationKey, buildDispatchReversalKey } from './dispatch-confirmation.js?v=0.8.0';
import { confirmDispatch, confirmDispatchBatch, recordDispatchActual, reverseDispatch } from './dispatch-confirmation-repository.js?v=0.8.0';
import {
  approveOverDispatch,
  approveSubstitution,
  recordCustomerNotice,
  reverseSubstitutionDecision
} from './dispatch-exception-repository.js?v=0.8.0';
import { PRODUCT_LINE_CONTEXT, applyProductSelection, editProductLine } from './product-line-common.js?v=0.8.0';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const qty = value => Number(value || 0).toLocaleString('ko-KR', { maximumFractionDigits: 6 });
const readWorkspace = () => {
  try { return normalizeWorkspaceState(JSON.parse(localStorage.getItem(DISPATCH_WORKSPACE_STORAGE_KEY) || '{}')); }
  catch { return normalizeWorkspaceState(); }
};

let workspace = readWorkspace();
let data = { aggregates: [], warehouses: [], products: [], inventoryProjection: { rows: [], totals: {} }, workerViews: { byOrder: [], byLocationProduct: [] } };
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
      plannedBaseQuantity: row.plannedBaseQuantity,
      plannedRecognizedOrderQuantity: row.plannedRecognizedOrderQuantity,
      actualProductId: row.actualProductId,
      actualProductCode: row.actualProductCode,
      actualProductName: row.actualProductName,
      fulfillmentType: row.fulfillmentType,
      conversionType: row.conversionType,
      conversionRuleId: row.conversionRuleId,
      conversionRuleVersion: row.conversionRuleVersion,
      conversionRuleSnapshot: row.conversionRuleSnapshot,
      measurementRequired: row.measurementRequired,
      priceSource: row.priceSource,
      actualProductUnitPriceWon: row.actualProductUnitPriceWon,
      manualUnitPriceWon: row.manualUnitPriceWon,
      priceChangeReason: row.priceChangeReason,
      customerNoticeRequired: row.customerNoticeRequired,
      customerNoticeStatus: row.customerNoticeStatus
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
  $('#summaryText').textContent = `DRAFT ${data.aggregates.filter(row => row.decision.status === 'DRAFT').length} · RELEASED ${data.aggregates.filter(row => row.decision.status === 'RELEASED').length} · READY ${data.aggregates.filter(row => row.decision.status === 'READY_TO_CONFIRM').length} · CONFIRMED ${data.aggregates.filter(row => row.decision.status === 'CONFIRMED').length} · 현재고 ${qty(data.inventoryProjection.totals.onHandQuantity)} · 가용 ${qty(data.inventoryProjection.totals.availableQuantity)}`;
}

function warehouseOptions(selected) {
  return data.warehouses.map(row => `<option value="${esc(row.warehouseId)}" ${row.warehouseId === selected ? 'selected' : ''}>${esc(row.warehouseCode)} ${esc(row.warehouseName)}</option>`).join('');
}

function productOptions(selected) {
  return data.products.map(row => {
    const code = row.itemCode || row.productCode || '';
    const name = row.itemName || row.productName || '';
    return `<option value="${esc(row.productId)}" ${row.productId === selected ? 'selected' : ''}>${esc(code)} ${esc(name)}</option>`;
  }).join('');
}

function selectOptions(values, selected) {
  return values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`).join('');
}

function inputValue(value) {
  return value === null || value === undefined ? '' : esc(value);
}

function readOptionalNumber(control) {
  return control?.value === '' || control?.value === undefined ? null : Number(control.value);
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
    : decision.status === 'RELEASED'
      ? '<button class="dq-btn warn" type="button" data-action="recall">작업목록 회수</button><button class="dq-btn primary" type="button" data-action="record-actual">실제결과 저장</button>'
      : decision.status === 'READY_TO_CONFIRM'
        ? '<button class="dq-btn warn" type="button" data-action="recall">확정대기 회수</button><button class="dq-btn" type="button" data-action="record-actual">실제결과 수정</button><button class="dq-btn primary" type="button" data-action="confirm">출고확정</button>'
        : decision.status === 'CONFIRMED' && !decision.reversalOf
          ? '<button class="dq-btn warn" type="button" data-action="reverse-full">전체 역분개</button>'
          : '';
  const lineBody = lines.map(line => {
    const lineAllocations = allocations.filter(row => row.dispatchLineId === line.dispatchLineId);
    const allocationBody = lineAllocations.map(allocation => {
      const buffered = bufferedAllocations.get(allocation.allocationId) || {};
      const reservation = reservationsByAllocation.get(allocation.allocationId);
      const conflict = Number(reservation?.conflictBaseQuantity || 0);
      const reservationText = reservation ? `· ${esc(reservation.status)}` : '';
      const conflictText = conflict > 0 ? `예약충돌 ${qty(conflict)}` : '-';
      const actualAllocation = allocation.actualBaseQuantity ?? allocation.plannedBaseQuantity ?? 0;
      const confirmationInput = ['RELEASED', 'READY_TO_CONFIRM'].includes(decision.status)
        ? `<br><label class="confirm-field">실제 <input class="confirm-allocation-qty" type="number" step="any" value="${Number(actualAllocation)}"></label>`
        : decision.status === 'CONFIRMED' ? `<br><small>실제 ${qty(actualAllocation)}</small>` : '';
      return `<tr class="allocation-row" data-allocation-id="${esc(allocation.allocationId)}" data-line-id="${esc(line.dispatchLineId)}">
        <td class="allocation-indent">↳ 재고출처</td>
        <td><select class="allocation-warehouse" ${editable ? '' : 'disabled'}>${warehouseOptions(buffered.warehouseId ?? allocation.warehouseId)}</select></td>
        <td><input class="allocation-qty" type="number" step="any" value="${Number(buffered.plannedBaseQuantity ?? allocation.plannedBaseQuantity ?? 0)}" ${editable ? '' : 'disabled'}> ${esc(line.actualUnit)}${confirmationInput}</td>
        <td>${esc(allocation.status)} ${reservationText}</td>
        <td class="${conflict > 0 ? 'negative' : ''}">${conflictText}</td>
      </tr>`;
    }).join('');
    const bufferedLine = { ...line, ...(bufferedLines.get(line.dispatchLineId) || {}) };
    const plannedActualQuantity = Number(bufferedLine.plannedActualQuantity ?? line.plannedActualQuantity ?? 0);
    const plannedBaseQuantity = Number(bufferedLine.plannedBaseQuantity ?? line.plannedBaseQuantity ?? plannedActualQuantity);
    const plannedRecognizedQuantity = Number(bufferedLine.plannedRecognizedOrderQuantity ?? line.plannedRecognizedOrderQuantity ?? plannedActualQuantity);
    const workerResult = line.workerReportedQuantity == null ? '-' : qty(line.workerReportedQuantity);
    const confirmationQuantity = line.actualQuantity ?? line.workerReportedQuantity ?? plannedActualQuantity;
    const confirmationInput = ['RELEASED', 'READY_TO_CONFIRM'].includes(decision.status)
      ? `<br><label class="confirm-field">실제 <input class="confirm-line-qty" type="number" step="any" value="${Number(confirmationQuantity)}"></label>`
      : decision.status === 'CONFIRMED' ? `<br><small>실제 ${qty(confirmationQuantity)}</small>` : '';
    const recognizedInput = ['RELEASED', 'READY_TO_CONFIRM'].includes(decision.status)
      ? `<br><label class="confirm-field">주문인정 <input class="confirm-recognized-qty" type="number" step="any" value="${Number(line.recognizedOrderQuantity ?? plannedRecognizedQuantity)}"></label>`
      : decision.status === 'CONFIRMED' ? `<br><small>주문인정 ${qty(line.recognizedOrderQuantity)}</small>` : '';
    const productCell = editable
      ? `<select class="line-actual-product">${productOptions(bufferedLine.actualProductId)}</select><br><select class="line-fulfillment-type">${selectOptions(Object.values(FULFILLMENT_TYPE), bufferedLine.fulfillmentType)}</select>`
      : `${esc(line.actualProductCode)} ${esc(line.actualProductName)}<br><small>${esc(line.fulfillmentType)}</small>`;
    const conversion = bufferedLine.conversionRuleSnapshot || {};
    const conversionEditor = editable ? `<div class="m5-grid">
      <label>환산 <select class="line-conversion-type">${selectOptions(Object.values(CONVERSION_TYPE), bufferedLine.conversionType || CONVERSION_TYPE.NONE)}</select></label>
      <label>규칙 <input class="line-conversion-rule-id" value="${inputValue(bufferedLine.conversionRuleId)}"></label>
      <label>버전 <input class="line-conversion-rule-version" value="${inputValue(bufferedLine.conversionRuleVersion)}"></label>
      <label>실제→기준 <input class="line-actual-to-base" type="number" step="any" value="${inputValue(conversion.actualToBaseFactor ?? 1)}"></label>
      <label>실제→인정 <input class="line-actual-to-recognized" type="number" step="any" value="${inputValue(conversion.actualToRecognizedFactor ?? 1)}"></label>
    </div>` : `<small>${esc(line.conversionType || CONVERSION_TYPE.NONE)} ${esc(line.conversionRuleId || '')} v${esc(line.conversionRuleVersion || '-')} / ${esc(line.measurementStatus || '')}</small>`;
    const priceEditor = editable ? `<div class="m5-grid">
      <label>가격 <select class="line-price-source">${selectOptions(Object.values(DISPATCH_PRICE_SOURCE), bufferedLine.priceSource || DISPATCH_PRICE_SOURCE.ORDER_AGREED)}</select></label>
      <label>대체기준가 <input class="line-actual-price" type="number" step="any" value="${inputValue(bufferedLine.actualProductUnitPriceWon)}"></label>
      <label>수정단가 <input class="line-manual-price" type="number" step="any" value="${inputValue(bufferedLine.manualUnitPriceWon)}"></label>
      <label>가격사유 <input class="line-price-reason" value="${inputValue(bufferedLine.priceChangeReason)}"></label>
      <label><input class="line-notice-required" type="checkbox" ${bufferedLine.customerNoticeRequired ? 'checked' : ''}> 고객공지 필요</label>
    </div>` : `<small>${esc(line.priceSource || DISPATCH_PRICE_SOURCE.ORDER_AGREED)} / 적용 ${qty(line.appliedUnitPriceWon)} / 공지 ${esc(line.customerNoticeStatus || CUSTOMER_NOTICE_STATUS.NOT_REQUIRED)}</small>`;
    const lineActions = decision.status === 'READY_TO_CONFIRM'
      ? `${line.fulfillmentType === FULFILLMENT_TYPE.SUBSTITUTE ? `<button class="dq-btn mini" type="button" data-action="approve-substitute" data-line-id="${esc(line.dispatchLineId)}">대체 승인</button>` : ''}
         <button class="dq-btn mini" type="button" data-action="approve-over" data-line-id="${esc(line.dispatchLineId)}">초과 승인</button>
         ${line.customerNoticeRequired ? `<button class="dq-btn mini" type="button" data-action="notice-notified" data-line-id="${esc(line.dispatchLineId)}">고객 공지완료</button><button class="dq-btn mini" type="button" data-action="notice-waived" data-line-id="${esc(line.dispatchLineId)}">공지 면제</button>` : ''}`
      : decision.status === 'CONFIRMED' && line.fulfillmentType === FULFILLMENT_TYPE.SUBSTITUTE
        ? `<button class="dq-btn mini warn" type="button" data-action="reverse-substitute-decision" data-line-id="${esc(line.dispatchLineId)}">대체판단만 역분개</button>`
        : '';
    return `<tr class="dispatch-line-row" data-line-id="${esc(line.dispatchLineId)}" data-conversion-type="${esc(line.conversionType || CONVERSION_TYPE.NONE)}">
      <td>${esc(line.requestedProductCode)} ${esc(line.requestedProductName)}</td>
      <td>${productCell}${conversionEditor}</td>
      <td><label>실제계획 <input class="line-qty" type="number" step="any" value="${plannedActualQuantity}" ${editable ? '' : 'disabled'}></label><br><label>기준계획 <input class="line-base-qty" type="number" step="any" value="${plannedBaseQuantity}" ${editable ? '' : 'disabled'}></label><br><label>인정계획 <input class="line-recognized-qty" type="number" step="any" value="${plannedRecognizedQuantity}" ${editable ? '' : 'disabled'}></label> ${esc(line.actualUnit)}${confirmationInput}${recognizedInput}</td>
      <td>${esc(line.workStatus || 'PENDING')}<br>${priceEditor}</td>
      <td>${workerResult} ${esc(line.workerExceptionCode || '')}<div class="line-actions">${lineActions}</div></td>
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

function collectActual(aggregate) {
  return {
    dispatchId: aggregate.decision.dispatchId,
    expectedRevision: aggregate.decision.revision,
    lines: aggregate.lines.map(line => {
      const row = detail.querySelector(`.dispatch-line-row[data-line-id="${CSS.escape(line.dispatchLineId)}"]`);
      const actualQuantity = Number(row.querySelector('.confirm-line-qty').value);
      return {
        dispatchLineId: line.dispatchLineId,
        actualQuantity,
        recognizedOrderQuantity: (line.conversionType || CONVERSION_TYPE.NONE) === CONVERSION_TYPE.NONE
          ? actualQuantity
          : Number(row.querySelector('.confirm-recognized-qty').value),
        allocations: aggregate.allocations.filter(allocation => allocation.dispatchLineId === line.dispatchLineId).map(allocation => {
          const allocationRow = detail.querySelector(`[data-allocation-id="${CSS.escape(allocation.allocationId)}"]`);
          return { allocationId: allocation.allocationId, actualBaseQuantity: Number(allocationRow.querySelector('.confirm-allocation-qty').value) };
        })
      };
    })
  };
}

function collectConfirmation(aggregate) {
  return {
    dispatchId: aggregate.decision.dispatchId,
    expectedRevision: aggregate.decision.revision,
    idempotencyKey: buildDispatchConfirmationKey(aggregate.decision.dispatchId, aggregate.decision.revision)
  };
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
    const productId = row.querySelector('.line-actual-product').value;
    const product = data.products.find(candidate => candidate.productId === productId) || {};
    const selectedProduct = productId
      ? applyProductSelection(PRODUCT_LINE_CONTEXT.DISPATCH, line, product)
      : editProductLine(PRODUCT_LINE_CONTEXT.DISPATCH, line, {
        actualProductId: '', actualProductCode: '', actualProductName: ''
      });
    const conversionType = row.querySelector('.line-conversion-type').value;
    const conversionRuleId = row.querySelector('.line-conversion-rule-id').value.trim();
    const conversionRuleVersion = row.querySelector('.line-conversion-rule-version').value.trim();
    const conversionRuleSnapshot = conversionType === CONVERSION_TYPE.NONE ? null : {
      conversionRuleId,
      conversionRuleVersion,
      actualToBaseFactor: Number(row.querySelector('.line-actual-to-base').value),
      actualToRecognizedFactor: Number(row.querySelector('.line-actual-to-recognized').value)
    };
    const customerNoticeRequired = row.querySelector('.line-notice-required').checked;
    return editProductLine(PRODUCT_LINE_CONTEXT.DISPATCH, line, {
      ...selectedProduct,
      fulfillmentType: row.querySelector('.line-fulfillment-type').value,
      plannedActualQuantity: Number(row.querySelector('.line-qty').value),
      plannedBaseQuantity: Number(row.querySelector('.line-base-qty').value),
      plannedRecognizedOrderQuantity: Number(row.querySelector('.line-recognized-qty').value),
      conversionType,
      conversionRuleId,
      conversionRuleVersion,
      conversionRuleSnapshot,
      measurementRequired: conversionType === CONVERSION_TYPE.MEASURED,
      priceSource: row.querySelector('.line-price-source').value,
      actualProductUnitPriceWon: readOptionalNumber(row.querySelector('.line-actual-price')),
      manualUnitPriceWon: readOptionalNumber(row.querySelector('.line-manual-price')),
      priceChangeReason: row.querySelector('.line-price-reason').value.trim(),
      customerNoticeRequired,
      customerNoticeStatus: customerNoticeRequired ? CUSTOMER_NOTICE_STATUS.PENDING : CUSTOMER_NOTICE_STATUS.NOT_REQUIRED
    });
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
    } else if (action === 'record-actual') {
      const result = await recordDispatchActual(collectActual(aggregate), 'ADMIN');
      showMessage(`실제결과 저장 완료: ${result.lines.length}행 · 출고확정 대기`, 'success');
    } else if (action === 'approve-substitute') {
      await approveSubstitution({
        dispatchId: aggregate.decision.dispatchId,
        dispatchLineId: target.dataset.lineId,
        expectedRevision: aggregate.decision.revision,
        reason: '관리자 화면 대체상품 승인'
      }, 'ADMIN');
      showMessage('대체상품 판단을 승인하고 근거를 기록했습니다.', 'success');
    } else if (action === 'approve-over') {
      await approveOverDispatch({
        dispatchId: aggregate.decision.dispatchId,
        dispatchLineId: target.dataset.lineId,
        expectedRevision: aggregate.decision.revision,
        reason: '관리자 화면 초과출고 승인'
      }, 'ADMIN');
      showMessage('초과 인정출고를 승인하고 수량 근거를 기록했습니다.', 'success');
    } else if (action === 'notice-notified' || action === 'notice-waived') {
      const noticeStatus = action === 'notice-notified' ? CUSTOMER_NOTICE_STATUS.NOTIFIED : CUSTOMER_NOTICE_STATUS.WAIVED;
      await recordCustomerNotice({
        dispatchId: aggregate.decision.dispatchId,
        dispatchLineId: target.dataset.lineId,
        expectedRevision: aggregate.decision.revision,
        customerNoticeStatus: noticeStatus,
        memo: action === 'notice-notified' ? '관리자 화면 고객 공지 완료' : '관리자 화면 고객 공지 면제'
      }, 'ADMIN');
      showMessage(`고객 공지 상태를 ${noticeStatus}(으)로 기록했습니다.`, 'success');
    } else if (action === 'confirm') {
      const result = await confirmDispatch(collectConfirmation(aggregate), 'ADMIN');
      showMessage(`출고확정 완료: 판매 ${result.salesLines.length}행 · 재고 ${result.movements.length}행 · 경고 ${result.reconciliations.length}건`, 'success');
    } else if (action === 'reverse-full') {
      const reversalCount = data.aggregates.filter(row => row.decision.reversalOf === aggregate.decision.dispatchId).length;
      const result = await reverseDispatch({
        dispatchId: aggregate.decision.dispatchId,
        expectedRevision: aggregate.decision.revision,
        idempotencyKey: buildDispatchReversalKey(aggregate.decision.dispatchId, aggregate.decision.revision, `FULL-${reversalCount + 1}`),
        reason: '관리자 전체 역분개'
      }, 'ADMIN');
      showMessage(`전체 역분개 완료: 판매 ${result.salesLines.length}행 · 재고 ${result.movements.length}행`, 'success');
    } else if (action === 'reverse-substitute-decision') {
      const dispatchLineId = target.dataset.lineId;
      const result = await reverseSubstitutionDecision({
        dispatchId: aggregate.decision.dispatchId,
        dispatchLineId,
        expectedRevision: aggregate.decision.revision,
        idempotencyKey: `SUBSTITUTE_DECISION_REVERSE:${aggregate.decision.dispatchId}:${dispatchLineId}:${aggregate.decision.revision}`,
        reason: '관리자 화면 대체판단 역분개'
      }, 'ADMIN');
      showMessage(`대체판단 역분개 완료: 주문 이벤트 ${result.orderEvents.length}건. 판매·재고는 유지됩니다.`, 'success');
    } else if (action === 'confirm-batch') {
      const targets = filteredAggregates().filter(row => row.decision.status === 'READY_TO_CONFIRM');
      if (!targets.length) throw new Error('확정대기 출고가 없습니다.');
      const result = await confirmDispatchBatch(targets.map(row => ({
        dispatchId: row.decision.dispatchId,
        expectedRevision: row.decision.revision,
        idempotencyKey: buildDispatchConfirmationKey(row.decision.dispatchId, row.decision.revision)
      })), 'ADMIN');
      const failed = result.results.filter(row => !row.ok).map(row => `${row.dispatchId}: ${row.error}`);
      showMessage(`일괄확정 성공 ${result.succeeded}건 · 실패 ${result.failed}건${failed.length ? ` / ${failed.join(' / ')}` : ''}`, result.failed ? 'error' : 'success');
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
  if (event.target.matches('.line-qty')) {
    const row = event.target.closest('.dispatch-line-row');
    if (row?.querySelector('.line-conversion-type')?.value === CONVERSION_TYPE.NONE) {
      row.querySelector('.line-base-qty').value = event.target.value;
      row.querySelector('.line-recognized-qty').value = event.target.value;
    }
  }
  if (event.target.matches('.confirm-line-qty')) {
    const row = event.target.closest('.dispatch-line-row');
    if ((row?.dataset.conversionType || CONVERSION_TYPE.NONE) === CONVERSION_TYPE.NONE) {
      row.querySelector('.confirm-recognized-qty').value = event.target.value;
    }
  }
  if (event.target.matches('.line-qty,.line-base-qty,.line-recognized-qty,.line-actual-product,.line-fulfillment-type,.line-conversion-type,.line-conversion-rule-id,.line-conversion-rule-version,.line-actual-to-base,.line-actual-to-recognized,.line-price-source,.line-actual-price,.line-manual-price,.line-price-reason,.line-notice-required,.allocation-qty,.allocation-warehouse')) saveDraftBuffer();
});
detail.addEventListener('change', event => {
  if (event.target.matches('.line-qty,.line-base-qty,.line-recognized-qty,.line-actual-product,.line-fulfillment-type,.line-conversion-type,.line-conversion-rule-id,.line-conversion-rule-version,.line-actual-to-base,.line-actual-to-recognized,.line-price-source,.line-actual-price,.line-manual-price,.line-price-reason,.line-notice-required,.allocation-qty,.allocation-warehouse')) saveDraftBuffer();
});
detail.addEventListener('scroll', saveWorkspace, { passive: true });
window.addEventListener('beforeunload', saveWorkspace);

statusFilter.value = workspace.filters.status || '';
searchFilter.value = workspace.filters.search || '';
setMode(workspace.mode, { captureScroll: false });
await refresh();
requestAnimationFrame(() => window.scrollTo(0, workspace.scrollTop));
