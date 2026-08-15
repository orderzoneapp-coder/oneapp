import { newId } from './orderq-db.js?v=0.8.0';
import {
  buildPurchaseConfirmationKey,
  buildPurchaseReversalKey
} from './purchase-decision.js?v=0.8.0';
import {
  confirmPurchase,
  listPurchases,
  loadPurchaseAggregate,
  reconcilePurchaseExternal,
  reversePurchase,
  savePurchaseDraft
} from './purchase-decision-repository.js?v=0.8.0';
import { loadProductCatalog } from './product-master-search.js?v=0.8.0';
import {
  PRODUCT_LINE_CONTEXT, applyProductSelection, editProductLine, searchLineProducts
} from './product-line-common.js?v=0.8.0';

const listElement = document.querySelector('#purchaseList');
const detailElement = document.querySelector('#purchaseDetail');
const messageElement = document.querySelector('#message');
const summaryElement = document.querySelector('#summaryText');
const statusFilter = document.querySelector('#statusFilter');
const searchFilter = document.querySelector('#searchFilter');
const params = new URLSearchParams(location.search);
let selectedId = params.get('focus') || '';
let documents = [];
let current = null;
let productCatalog = [];
let busy = false;

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function esc(value) {
  return text(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function number(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function showMessage(message, type = '') {
  messageElement.textContent = message;
  messageElement.className = `purchase-message ${type}`;
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll('button').forEach(button => { button.disabled = value; });
}

function emptyDraft() {
  return {
    document: {
      purchaseDocumentId: '', sourceShortageKey: '', sourceShortageQuantity: 0,
      supplierId: '', supplierName: '', businessDate: new Date().toISOString().slice(0, 10),
      purchaseDate: new Date().toISOString().slice(0, 10), actualTransactionAt: '', backdateReason: '', memo: '',
      status: 'DRAFT', revision: 0
    },
    lines: [{
      purchaseLineId: '', productId: '', productCode: '', productName: '', warehouseId: '', warehouseCode: '', warehouseName: '',
      quantity: 0, unit: 'EA', baseQuantity: 0, baseUnit: 'EA', unitCostWon: 0,
      sourceOrderItemId: '', sourceDispatchId: '', sourceDispatchLineId: ''
    }],
    movements: [], reconciliations: []
  };
}

function renderList() {
  listElement.innerHTML = documents.length ? documents.map(row => `
    <button class="purchase-card ${row.purchaseDocumentId === selectedId ? 'selected' : ''}" type="button" data-select="${esc(row.purchaseDocumentId)}">
      <strong>${esc(row.purchaseDocumentId)} <span class="purchase-status">${esc(row.status)}</span></strong>
      <span>${esc(row.supplierName || '공급처 미지정')} · ${esc(row.businessDate || row.purchaseDate || '-')}</span>
      <span>${esc(row.sourceShortageKey || '수기 구매')} · ${Number(row.amountWon || 0).toLocaleString('ko-KR')}원</span>
    </button>`).join('') : '<div class="empty-state">구매 DRAFT가 없습니다.</div>';
  summaryElement.textContent = `구매 ${documents.length}건`;
}

function lineEditor(line, index, editable) {
  return `<section class="purchase-line" data-line-index="${index}" data-line-id="${esc(line.purchaseLineId)}">
    <div class="purchase-form-grid">
      <label>상품 내부 ID<input class="line-product-id" value="${esc(line.productId)}" ${editable ? '' : 'readonly'}></label>
      <label>상품코드<input class="line-product-code" list="purchaseProductOptions" value="${esc(line.productCode)}" ${editable ? '' : 'readonly'}></label>
      <label>상품명<input class="line-product-name" list="purchaseProductOptions" value="${esc(line.productName)}" ${editable ? '' : 'readonly'}></label>
      <label>입고 재고구분 ID<input class="line-warehouse-id" value="${esc(line.warehouseId)}" ${editable ? '' : 'readonly'}></label>
      <label>재고구분 코드<input class="line-warehouse-code" value="${esc(line.warehouseCode)}" ${editable ? '' : 'readonly'}></label>
      <label>재고구분명<input class="line-warehouse-name" value="${esc(line.warehouseName)}" ${editable ? '' : 'readonly'}></label>
      <label>구매수량<input class="line-quantity" type="number" step="any" value="${esc(line.quantity)}" ${editable ? '' : 'readonly'}></label>
      <label>구매단위<input class="line-unit" value="${esc(line.unit)}" ${editable ? '' : 'readonly'}></label>
      <label>기준수량<input class="line-base-quantity" type="number" step="any" value="${esc(line.baseQuantity)}" ${editable ? '' : 'readonly'}></label>
      <label>기준단위<input class="line-base-unit" value="${esc(line.baseUnit)}" ${editable ? '' : 'readonly'}></label>
      <label>단가<input class="line-unit-cost" type="number" step="1" value="${esc(line.unitCostWon)}" ${editable ? '' : 'readonly'}></label>
      <label>주문행 근거<input class="line-order-item" value="${esc(line.sourceOrderItemId)}" ${editable ? '' : 'readonly'}></label>
      <label>출고결정 근거<input class="line-dispatch-id" value="${esc(line.sourceDispatchId)}" ${editable ? '' : 'readonly'}></label>
      <label>출고행 근거<input class="line-dispatch-line" value="${esc(line.sourceDispatchLineId)}" ${editable ? '' : 'readonly'}></label>
      ${editable ? `<label>행 관리<button class="pq-btn danger" type="button" data-action="remove-line" data-index="${index}">행 삭제</button></label>` : `<label>부분 역분개 수량<input class="line-reverse-quantity" type="number" min="0" max="${esc(Math.abs(number(line.quantity)))}" step="any" value="0"></label>`}
    </div>
    ${line.movementId ? `<p class="purchase-evidence">Movement ${esc(line.movementId)} · 기준수량 ${esc(line.baseQuantity)} ${esc(line.baseUnit)}</p>` : ''}
  </section>`;
}

function renderDetail() {
  if (!current) {
    detailElement.innerHTML = '<div class="empty-state">왼쪽에서 구매 판단을 선택하거나 새 DRAFT를 만드세요.</div>';
    return;
  }
  const documentRow = current.document;
  const editable = documentRow.status === 'DRAFT';
  detailElement.innerHTML = `<form class="purchase-form" id="purchaseForm">
    <h2>${editable ? '구매 DRAFT' : `구매 ${esc(documentRow.status)}`}</h2>
    <div class="purchase-form-grid">
      <label>구매 ID<input id="purchaseDocumentId" value="${esc(documentRow.purchaseDocumentId)}" readonly></label>
      <label>Revision<input id="purchaseRevision" value="${esc(documentRow.revision || 0)}" readonly></label>
      <label>ERP 상태<input value="${esc(documentRow.erpPostingStatus || 'NOT_READY')}" readonly></label>
      <label class="wide">부족근거 Key<input id="sourceShortageKey" value="${esc(documentRow.sourceShortageKey)}" ${editable ? '' : 'readonly'}></label>
      <label>부족수량<input id="sourceShortageQuantity" type="number" step="any" value="${esc(documentRow.sourceShortageQuantity || 0)}" ${editable ? '' : 'readonly'}></label>
      <label>공급처 ID<input id="supplierId" value="${esc(documentRow.supplierId)}" ${editable ? '' : 'readonly'}></label>
      <label>공급처명<input id="supplierName" value="${esc(documentRow.supplierName)}" ${editable ? '' : 'readonly'}></label>
      <label>업무일<input id="businessDate" type="date" value="${esc(documentRow.businessDate || documentRow.purchaseDate)}" ${editable ? '' : 'readonly'}></label>
      <label>실제 거래시각<input id="actualTransactionAt" type="datetime-local" value="${esc(text(documentRow.actualTransactionAt).slice(0, 16))}" ${editable ? '' : 'readonly'}></label>
      <label class="wide">소급 사유<input id="backdateReason" value="${esc(documentRow.backdateReason)}" ${editable ? '' : 'readonly'}></label>
      <label class="wide">메모<textarea id="purchaseMemo" rows="2" ${editable ? '' : 'readonly'}>${esc(documentRow.memo)}</textarea></label>
    </div>
    <h3>구매행</h3>
    <div id="purchaseLines">${current.lines.map((line, index) => lineEditor(line, index, editable)).join('')}</div>
    <div class="purchase-actions">
      ${editable ? '<button class="pq-btn" type="button" data-action="add-line">+ 행 추가</button><button class="pq-btn primary" type="button" data-action="save">DRAFT 저장</button><button class="pq-btn primary" type="button" data-action="confirm">구매확정</button>' : ''}
      ${documentRow.status === 'CONFIRMED' ? '<button class="pq-btn danger" type="button" data-action="reverse-partial">입력수량 부분 역분개</button><button class="pq-btn danger" type="button" data-action="reverse-full">남은 수량 전체 역분개</button>' : ''}
    </div>
    ${documentRow.status === 'CONFIRMED' ? `<section class="purchase-line">
      <h3>ERP 정확식별 대사</h3>
      <div class="purchase-form-grid">
        <label>ERP 전표번호<input id="erpDocumentNo" value="${esc(documentRow.erpDocumentNo || documentRow.externalDocumentNo)}"></label>
        <label>Import Batch<input id="erpImportBatchId" value="${esc(documentRow.importBatchId)}"></label>
        <label>원본 지문<input id="erpSourceFingerprint" value="${esc(documentRow.sourceFingerprint)}"></label>
      </div>
      <button class="pq-btn" type="button" data-action="reconcile">기존 구매와 대사</button>
      <p class="purchase-evidence">정확한 ORDER Q 구매ID·행ID·수량·단가가 모두 같을 때만 연결하며, 유사값은 검토대상으로 남깁니다.</p>
    </section>` : ''}
    <p class="purchase-evidence">출고확정과 구매확정은 독립 명령입니다. 확정자료는 직접 수정하지 않고 역분개합니다.</p>
  </form>`;
}

function collectDraft() {
  const lineRows = [...detailElement.querySelectorAll('.purchase-line[data-line-index]')];
  return {
    document: {
      purchaseDocumentId: text(document.querySelector('#purchaseDocumentId')?.value),
      sourceShortageKey: text(document.querySelector('#sourceShortageKey')?.value),
      sourceShortageQuantity: number(document.querySelector('#sourceShortageQuantity')?.value),
      supplierId: text(document.querySelector('#supplierId')?.value),
      supplierName: text(document.querySelector('#supplierName')?.value),
      businessDate: text(document.querySelector('#businessDate')?.value),
      purchaseDate: text(document.querySelector('#businessDate')?.value),
      actualTransactionAt: text(document.querySelector('#actualTransactionAt')?.value),
      backdateReason: text(document.querySelector('#backdateReason')?.value),
      memo: text(document.querySelector('#purchaseMemo')?.value)
    },
    lines: lineRows.map(row => {
      const currentLine = current.lines.find(line => line.purchaseLineId === row.dataset.lineId) || {};
      const productId = text(row.querySelector('.line-product-id').value);
      const product = productCatalog.find(candidate => candidate.productId === productId) || {
        productId,
        itemCode: text(row.querySelector('.line-product-code').value),
        itemName: text(row.querySelector('.line-product-name').value),
        finalUnit: text(row.querySelector('.line-unit').value)
      };
      const selected = productId
        ? applyProductSelection(PRODUCT_LINE_CONTEXT.PURCHASE, currentLine, product)
        : currentLine;
      return {
        purchaseLineId: text(row.dataset.lineId) || newId('PL'),
        ...editProductLine(PRODUCT_LINE_CONTEXT.PURCHASE, currentLine, {
          ...selected,
          productId,
          productCode: text(row.querySelector('.line-product-code').value),
          productName: text(row.querySelector('.line-product-name').value),
          warehouseId: text(row.querySelector('.line-warehouse-id').value),
          warehouseCode: text(row.querySelector('.line-warehouse-code').value),
          warehouseName: text(row.querySelector('.line-warehouse-name').value),
          quantity: number(row.querySelector('.line-quantity').value),
          unit: text(row.querySelector('.line-unit').value),
          baseQuantity: number(row.querySelector('.line-base-quantity').value),
          baseUnit: text(row.querySelector('.line-base-unit').value),
          unitCostWon: number(row.querySelector('.line-unit-cost').value),
          sourceOrderItemId: text(row.querySelector('.line-order-item').value),
          sourceDispatchId: text(row.querySelector('.line-dispatch-id').value),
          sourceDispatchLineId: text(row.querySelector('.line-dispatch-line').value)
        })
      };
    }),
    expectedRevision: Number(current.document.revision || 0)
  };
}

function renderProductOptions() {
  const options = document.querySelector('#purchaseProductOptions');
  options.innerHTML = productCatalog.map(product => `<option value="${esc(product.itemCode || product.itemName)}">${esc(product.itemName || product.itemCode)}</option>`).join('');
}

function applyPurchaseProduct(row, query) {
  const candidates = searchLineProducts(query, productCatalog, 8);
  const normalizedQuery = text(query).toLowerCase();
  const product = candidates.find(candidate => text(candidate.itemCode).toLowerCase() === normalizedQuery
    || text(candidate.itemName).toLowerCase() === normalizedQuery);
  if (!product) return;
  const selected = applyProductSelection(PRODUCT_LINE_CONTEXT.PURCHASE, {}, product);
  row.querySelector('.line-product-id').value = selected.productId;
  row.querySelector('.line-product-code').value = selected.productCode;
  row.querySelector('.line-product-name').value = selected.productName;
  if (!row.querySelector('.line-unit').value) row.querySelector('.line-unit').value = selected.unit || '';
  if (!row.querySelector('.line-base-unit').value) row.querySelector('.line-base-unit').value = selected.baseUnit || '';
}

async function reload(selectId = selectedId) {
  documents = await listPurchases({ status: statusFilter.value, search: searchFilter.value });
  if (selectId && documents.some(row => row.purchaseDocumentId === selectId)) selectedId = selectId;
  else if (selectedId && !documents.some(row => row.purchaseDocumentId === selectedId)) selectedId = '';
  renderList();
  current = selectedId ? await loadPurchaseAggregate(selectedId) : current?.document?.purchaseDocumentId ? current : null;
  renderDetail();
}

async function execute(action) {
  if (busy) return;
  setBusy(true);
  try {
    await action();
  } catch (error) {
    console.error(error);
    showMessage(error.message || String(error), 'error');
  } finally {
    setBusy(false);
  }
}

listElement.addEventListener('click', event => {
  const button = event.target.closest('[data-select]');
  if (!button) return;
  execute(async () => {
    selectedId = button.dataset.select;
    current = await loadPurchaseAggregate(selectedId);
    renderList();
    renderDetail();
  });
});

detailElement.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  event.preventDefault();
  const action = button.dataset.action;
  if (action === 'add-line') {
    current.lines.push(emptyDraft().lines[0]);
    renderDetail();
    return;
  }
  if (action === 'remove-line') {
    current.lines.splice(Number(button.dataset.index), 1);
    if (!current.lines.length) current.lines.push(emptyDraft().lines[0]);
    renderDetail();
    return;
  }
  execute(async () => {
    if (action === 'save' || action === 'confirm') {
      const saved = await savePurchaseDraft(collectDraft(), 'ADMIN');
      selectedId = saved.document.purchaseDocumentId;
      if (action === 'confirm') {
        await confirmPurchase({
          purchaseDocumentId: selectedId,
          expectedRevision: saved.document.revision,
          idempotencyKey: buildPurchaseConfirmationKey(selectedId, saved.document.revision)
        }, 'ADMIN');
        showMessage('구매확정과 입고 Movement를 저장했습니다.', 'success');
      } else {
        showMessage('구매 DRAFT를 저장했습니다.', 'success');
      }
      await reload(selectedId);
      return;
    }
    if (action === 'reverse-full' || action === 'reverse-partial') {
      const reason = prompt('구매 역분개 사유를 입력하세요.');
      if (!text(reason)) return;
      const lines = action === 'reverse-partial'
        ? [...detailElement.querySelectorAll('.purchase-line[data-line-index]')].map(row => ({
          purchaseLineId: row.dataset.lineId,
          quantity: number(row.querySelector('.line-reverse-quantity').value)
        })).filter(row => row.quantity > 0)
        : [];
      if (action === 'reverse-partial' && !lines.length) throw new Error('부분 역분개 수량을 입력하세요.');
      await reversePurchase({
        purchaseDocumentId: current.document.purchaseDocumentId,
        expectedRevision: current.document.revision,
        idempotencyKey: buildPurchaseReversalKey(current.document.purchaseDocumentId, current.document.revision, `UI-${Date.now()}`),
        reason,
        lines
      }, 'ADMIN');
      showMessage('원 구매를 유지하고 반대 구매·재고 Movement를 추가했습니다.', 'success');
      await reload(selectedId);
      return;
    }
    if (action === 'reconcile') {
      const externalDocumentNo = text(document.querySelector('#erpDocumentNo').value);
      if (!externalDocumentNo) throw new Error('ERP 전표번호를 입력하세요.');
      await reconcilePurchaseExternal({
        idempotencyKey: `ERP_PURCHASE_RECONCILE:${current.document.purchaseDocumentId}:${externalDocumentNo}`,
        originSystem: 'ORDER_Q',
        originTransactionId: current.document.purchaseDocumentId,
        externalDocumentNo,
        importBatchId: text(document.querySelector('#erpImportBatchId').value),
        sourceFingerprint: text(document.querySelector('#erpSourceFingerprint').value),
        lines: current.lines.map((line, index) => ({
          originPurchaseLineId: line.purchaseLineId,
          externalLineNo: line.externalLineNo || String(index + 1),
          sourceLineFingerprint: line.sourceLineFingerprint || '',
          productId: line.productId,
          warehouseId: line.warehouseId,
          quantity: line.quantity,
          baseQuantity: line.baseQuantity,
          unitCostWon: line.unitCostWon
        }))
      }, 'ADMIN');
      showMessage('ERP 자료를 기존 구매와 대사했습니다. 새 구매·재고는 만들지 않았습니다.', 'success');
      await reload(selectedId);
    }
  });
});

document.querySelector('#newDraftBtn').addEventListener('click', () => {
  selectedId = '';
  current = emptyDraft();
  renderList();
  renderDetail();
});
document.querySelector('#refreshBtn').addEventListener('click', () => execute(() => reload()));
statusFilter.addEventListener('change', () => execute(() => reload()));
searchFilter.addEventListener('input', () => execute(() => reload()));
detailElement.addEventListener('change', event => {
  if (!event.target.matches('.line-product-code, .line-product-name')) return;
  applyPurchaseProduct(event.target.closest('.purchase-line'), event.target.value);
});

execute(async () => {
  const catalog = await loadProductCatalog();
  productCatalog = catalog.products;
  renderProductOptions();
  await reload();
  if (selectedId) {
    current = await loadPurchaseAggregate(selectedId);
    renderDetail();
  }
});
