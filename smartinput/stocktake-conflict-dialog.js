import { OFFICIAL_STOCKTAKE_DECISION } from '../orderq/stocktake-conflict-v2.js?v=0.1.0';

const text = value => String(value ?? '').trim();

function preservedUiState() {
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = activeElement && 'selectionStart' in activeElement
    ? { start: activeElement.selectionStart, end: activeElement.selectionEnd, direction: activeElement.selectionDirection }
    : null;
  const tableScroll = document.getElementById('tableScroll');
  return {
    activeElement,
    selection,
    windowX: window.scrollX,
    windowY: window.scrollY,
    tableScroll,
    tableTop: tableScroll?.scrollTop || 0,
    tableLeft: tableScroll?.scrollLeft || 0
  };
}

function restoreUiState(saved) {
  window.scrollTo(saved.windowX, saved.windowY);
  if (saved.tableScroll?.isConnected) {
    saved.tableScroll.scrollTop = saved.tableTop;
    saved.tableScroll.scrollLeft = saved.tableLeft;
  }
  if (!saved.activeElement?.isConnected) return;
  saved.activeElement.focus({ preventScroll: true });
  if (saved.selection && typeof saved.activeElement.setSelectionRange === 'function') {
    saved.activeElement.setSelectionRange(saved.selection.start, saved.selection.end, saved.selection.direction || 'none');
  }
}

function conflictLabel(conflict = {}) {
  const product = [text(conflict.productCode), text(conflict.productName)].filter(Boolean).join(' / ') || '상품 정보 없음';
  const warehouse = text(conflict.warehouseName || conflict.warehouseCode || conflict.warehouseId) || '창고 정보 없음';
  const quantity = Number(conflict.quantity);
  return { product, warehouse, quantity: Number.isFinite(quantity) ? String(quantity) : text(conflict.quantity) };
}

export function showStocktakeConflictDialog(conflicts = []) {
  if (!Array.isArray(conflicts) || !conflicts.length) return Promise.resolve(null);
  const saved = preservedUiState();
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'smart-dialog stocktake-conflict-dialog';
    dialog.setAttribute('aria-labelledby', 'stocktakeConflictTitle');
    dialog.setAttribute('aria-describedby', 'stocktakeConflictMessage');
    dialog.innerHTML = `<div class="smart-dialog__shell">
      <header><div><small>Stocktake Conflict</small><h2 id="stocktakeConflictTitle">재고실사 확인</h2></div><button type="button" data-stocktake-cancel aria-label="닫기">×</button></header>
      <p id="stocktakeConflictMessage" class="smart-dialog__message stocktake-conflict-dialog__message">이 전표는 최근 재고실사 이전의 거래입니다.</p>
      <div class="stocktake-conflict-dialog__rows" role="list" aria-label="재고실사 충돌 상품"></div>
      <p class="smart-dialog__message stocktake-conflict-dialog__question">이 수량이 실사 결과에 이미 포함되어 있습니까?</p>
      <footer>
        <button type="button" class="button button--primary" data-stocktake-decision="INCLUDED_IN_CHECKPOINT">실사수량에 포함됨</button>
        <button type="button" class="button button--quiet" data-stocktake-decision="NOT_INCLUDED_IN_CHECKPOINT">실사수량에 포함되지 않음</button>
        <button type="button" class="button button--danger" data-stocktake-cancel>확정 취소</button>
      </footer>
    </div>`;
    const rows = dialog.querySelector('.stocktake-conflict-dialog__rows');
    conflicts.forEach(conflict => {
      const label = conflictLabel(conflict);
      const row = document.createElement('div');
      row.className = 'stocktake-conflict-dialog__row';
      row.setAttribute('role', 'listitem');
      const product = document.createElement('strong');
      product.textContent = label.product;
      const details = document.createElement('span');
      details.textContent = `창고 ${label.warehouse}`;
      const quantity = document.createElement('em');
      quantity.textContent = `수량 ${label.quantity}`;
      row.append(product, details, quantity);
      rows.append(row);
    });
    document.body.append(dialog);
    let settled = false;
    const finish = decisionType => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      window.setTimeout(() => {
        try { restoreUiState(saved); }
        finally { resolve(decisionType); }
      }, 0);
    };
    dialog.querySelectorAll('[data-stocktake-cancel]').forEach(button => button.addEventListener('click', () => finish(null)));
    dialog.querySelectorAll('[data-stocktake-decision]').forEach(button => button.addEventListener('click', () => {
      const decisionType = text(button.dataset.stocktakeDecision);
      finish(decisionType === OFFICIAL_STOCKTAKE_DECISION.INCLUDED
        ? OFFICIAL_STOCKTAKE_DECISION.INCLUDED
        : OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED);
    }));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      finish(null);
    });
    dialog.showModal();
    dialog.querySelector('[data-stocktake-decision="INCLUDED_IN_CHECKPOINT"]')?.focus({ preventScroll: true });
  });
}
