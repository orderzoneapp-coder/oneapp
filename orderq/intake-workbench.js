import { createOrderDraftEditor } from './order-draft-editor.js?v=0.1.0';
import {
  captureTextIntake,
  analyzeSingleOrderDocument,
  confirmExtraction,
  confirmMatching,
  reopenIntakeStage,
  commitIntakeOrder
} from './intake-engine.js?v=0.1.0';

const $ = id => document.getElementById(id);
const state = {
  document: null,
  lines: [],
  editor: null,
  currentStep: 0,
  captured: false
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const panels = [...document.querySelectorAll('[data-panel]')];
const railSteps = [...document.querySelectorAll('[data-rail-step]')];
const sourcePanel = $('sourcePanel');

function renderRail(stepIndex) {
  railSteps.forEach((button, index) => {
    const isPast = index < stepIndex;
    const isCurrent = index === stepIndex;
    button.hidden = index > stepIndex;
    button.disabled = isCurrent;
    button.classList.toggle('active', isCurrent);
    button.classList.toggle('completed', isPast);
    const indexLabel = button.querySelector('.rail-index');
    if (indexLabel) indexLabel.textContent = isPast ? '✓' : String(index + 1).padStart(2, '0');
  });
}

function step(stepIndex) {
  state.currentStep = stepIndex;
  renderRail(stepIndex);
  sourcePanel.hidden = stepIndex !== 0 || state.captured;
  panels.forEach((panel, index) => {
    panel.hidden = index !== stepIndex || (index === 0 && !state.captured);
  });
  requestAnimationFrame(() => {
    document.querySelector('.intake-workspace .stage-heading:not([hidden])')?.scrollIntoView({ block: 'nearest' });
  });
}

function msg(text = '', tone = 'info') {
  const element = $('intakeMessage');
  element.textContent = text;
  element.dataset.tone = tone;
}

function rows() {
  $('extractionRows').innerHTML = state.lines.map((line, index) => `
    <div class="intake-line-grid" data-i="${index}">
      <input data-k="productText" value="${esc(line.productText || '')}" aria-label="상품내용 ${index + 1}">
      <input data-k="specification" value="${esc(line.specification || '')}" aria-label="규격 ${index + 1}">
      <input data-k="quantity" type="number" step="any" value="${esc(line.quantity ?? '')}" aria-label="수량 ${index + 1}">
      <input data-k="unit" value="${esc(line.unit || '')}" aria-label="단위 ${index + 1}">
      <label><input data-k="excluded" type="checkbox" ${line.reviewStatus === 'EXCLUDED' ? 'checked' : ''}>제외</label>
    </div>
  `).join('');
}

function identityAction(line) {
  if (line.productIdentityStatus === 'MASTER_LINKED') {
    return '<span class="identity-ok">Master 연결</span>';
  }
  if (line.productIdentityStatus === 'TEMPORARY_CONFIRMED') {
    return '<span class="identity-ok identity-temporary">확인 완료 · Master 미연결</span>';
  }
  return '<button data-temp type="button">임시상품 확인</button>';
}

function editor() {
  $('draftEditor').innerHTML = `
    <div class="draft-grid-head" aria-hidden="true">
      <span>품목코드</span><span>상품명</span><span>수량</span><span>상품상태</span>
    </div>
    <table><tbody>${state.lines.map((line, index) => `
      <tr data-i="${index}">
        <td data-label="품목코드">${esc(line.itemCode || '')}</td>
        <td data-label="상품명"><input data-name value="${esc(line.itemName || line.productText || '')}" aria-label="상품명 ${index + 1}"></td>
        <td data-label="수량" class="draft-quantity">${esc(line.quantity ?? '')}</td>
        <td data-label="상품상태" class="draft-identity">${identityAction(line)}</td>
      </tr>
    `).join('')}</tbody></table>`;

  state.editor = createOrderDraftEditor({
    root: $('draftEditor'),
    initialDraft: { lines: state.lines }
  });
}

async function goBackTo(targetStep) {
  if (!state.document || targetStep >= state.currentStep) return;
  try {
    if (targetStep === 0) {
      const result = await reopenIntakeStage({ document: state.document, lines: state.lines }, 'EXTRACTION_REVIEW');
      state.document = result.document;
      state.lines = result.lines;
      rows();
      step(0);
      msg('추출 내용을 다시 확인할 수 있습니다.', 'info');
      return;
    }
    if (targetStep === 1) {
      const result = await reopenIntakeStage({ document: state.document, lines: state.lines }, 'MATCH_REVIEW');
      state.document = result.document;
      state.lines = result.lines;
      editor();
      step(1);
      msg('상품 매칭을 다시 확인할 수 있습니다.', 'info');
    }
  } catch (error) {
    msg(error.message || String(error), 'error');
  }
}

railSteps.forEach((button, index) => {
  button.addEventListener('click', () => goBackTo(index));
});

$('captureBtn').onclick = async () => {
  try {
    const rawText = $('rawText').value;
    const captured = await captureTextIntake({
      sourceType: $('sourceType').value,
      sourceId: $('sourceId').value,
      rawText
    });
    const analyzed = await analyzeSingleOrderDocument({
      session: captured.session,
      sourcePart: captured.sourcePart,
      rawText,
      headerDraft: { warehouseName: $('warehouse').value }
    });
    state.document = analyzed.document;
    state.lines = analyzed.lines;
    state.captured = true;
    $('rawPreview').textContent = rawText;
    $('customerExpression').value = analyzed.document.confirmedCustomerName || '';
    rows();
    step(0);
    msg('추출한 내용을 확인하고 필요한 부분만 수정하세요.', 'success');
  } catch (error) {
    msg(error.message || String(error), 'error');
  }
};

$('extractionRows').oninput = event => {
  const row = event.target.closest('[data-i]');
  if (!row) return;
  const line = state.lines[Number(row.dataset.i)];
  const key = event.target.dataset.k;
  if (!line || !key) return;
  if (key === 'excluded') {
    line.reviewStatus = event.target.checked ? 'EXCLUDED' : 'PENDING';
    line.matchStatus = event.target.checked ? 'EXCLUDED' : 'MATCH_FAILED';
  } else {
    line[key] = key === 'quantity' ? +event.target.value : event.target.value;
  }
};

$('confirmExtractionBtn').onclick = async () => {
  try {
    const result = await confirmExtraction({ document: state.document, lines: state.lines });
    state.document = result.document;
    state.lines = result.lines;
    editor();
    step(1);
    msg('추출 확인이 끝났습니다. 실제 상품을 확인하세요.', 'success');
  } catch (error) {
    msg(error.message || String(error), 'error');
  }
};

$('draftEditor').oninput = event => {
  const input = event.target.closest('[data-name]');
  const row = event.target.closest('tr[data-i]');
  if (!input || !row) return;
  const line = state.lines[Number(row.dataset.i)];
  if (line) line.itemName = input.value;
};

$('draftEditor').onclick = event => {
  const button = event.target.closest('[data-temp]');
  if (!button) return;
  const row = button.closest('tr[data-i]');
  const line = state.lines[Number(row.dataset.i)];
  if (!line) return;
  const nameInput = row.querySelector('[data-name]');
  Object.assign(line, {
    itemName: nameInput?.value.trim() || line.itemName || line.productText,
    productId: null,
    itemCode: '',
    reviewStatus: 'CONFIRMED',
    productIdentityStatus: 'TEMPORARY_CONFIRMED',
    matchStatus: 'MATCH_FAILED'
  });
  const status = document.createElement('span');
  status.className = 'identity-ok identity-temporary';
  status.textContent = '확인 완료 · Master 미연결';
  button.replaceWith(status);
};

$('confirmMatchingBtn').onclick = async () => {
  try {
    const result = await confirmMatching({ document: state.document, lines: state.lines });
    state.document = result.document;
    state.lines = result.lines;
    $('completionEditor').innerHTML = $('draftEditor').innerHTML;
    step(2);
    msg('상품 확인이 끝났습니다. 최종 주문 내용을 확인하세요.', 'success');
  } catch (error) {
    msg(error.message || String(error), 'error');
  }
};

$('editExtractionBtn').onclick = () => goBackTo(0);
$('editMatchingBtn').onclick = () => goBackTo(1);

$('commitBtn').onclick = async () => {
  try {
    const result = await commitIntakeOrder({
      document: state.document,
      orderDraft: {
        orderDate: new Date().toISOString().slice(0, 10),
        customerName: state.document.confirmedCustomerName || $('customerExpression').value,
        warehouseName: $('warehouse').value,
        transactionType: '기타',
        orderStatus: 'ORDER',
        adminStatus: 'UNCHECKED'
      }
    });
    location.href = `./index.html?orderId=${encodeURIComponent(result.order.orderId)}`;
  } catch (error) {
    msg(error.message || String(error), 'error');
  }
};

renderRail(0);
