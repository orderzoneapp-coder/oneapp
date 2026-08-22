import { createOrderDraftEditor } from './order-draft-editor.js?v=0.1.0';
import { STORE, getAll, normalizeText } from './orderq-db.js?v=0.12.1';
import { openCustomerPicker } from './customer-picker.js?v=0.12.1';
import {
  captureTextIntake,
  analyzeSingleOrderDocument,
  parseStructuredOrderText,
  rematchExtractedLinesForCustomer,
  confirmExtraction,
  confirmMatching,
  reopenIntakeStage,
  commitIntakeOrder
} from './intake-engine.js?v=0.12.3';

const $ = id => document.getElementById(id);
const state = {
  document: null,
  lines: [],
  editor: null,
  currentStep: 0,
  captured: false,
  customers: [],
  activeCustomer: null,
  imageEvidence: null,
  imageFile: null,
  ocrRunning: false
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const panels = [...document.querySelectorAll('[data-panel]')];
const railSteps = [...document.querySelectorAll('[data-rail-step]')];
const sourcePanel = $('sourcePanel');
const KAKAO_HEADER = /^\s*\[([^\]]+)\]\s*\[([^\]]+)\]/m;

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

function msg(message = '', tone = 'info') {
  const element = $('intakeMessage');
  element.textContent = message;
  element.dataset.tone = tone;
}

function friendlyError(error) {
  const value = String(error?.message || error || '');
  if (value.includes('ORDERQ_INTAKE_CUSTOMER_REQUIRED')) return '거래처를 선택하세요. 거래처가 지정되어야 거래처별 상품 매칭을 적용할 수 있습니다.';
  if (value.includes('ORDERQ_INTAKE_MULTIPLE_DOCUMENTS_REQUIRES_STAGE4')) return '여러 주문이 포함되어 있습니다. 현재 화면에서는 주문 한 건씩 분석해 주세요.';
  if (value.includes('ORDERQ_INTAKE_REVIEW_INCOMPLETE')) return '주문 항목을 인식하지 못했습니다. 거래처와 상품·수량 표현을 확인해 주세요.';
  if (value.includes('ORDERQ_INTAKE_SOURCE_EMPTY')) return '분석할 주문내용을 입력하세요.';
  return value || '처리 중 오류가 발생했습니다.';
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

function customerName(customer) {
  return String(customer?.customerName || customer?.name || '').trim();
}

function customerCode(customer) {
  return String(customer?.erpCustomerCode || customer?.customerCode || '').trim();
}

function findCustomer(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return state.customers.find(customer => normalizeText(customerName(customer)) === normalized)
    || state.customers.find(customer => customerCode(customer) && normalizeText(customerCode(customer)) === normalized)
    || null;
}

function inferCustomerFromRaw(rawText, sourceType) {
  const textValue = String(rawText || '').replace(/\r\n?/g, '\n');
  if (sourceType === 'KAKAO_TEXT') {
    const sender = textValue.match(KAKAO_HEADER)?.[1] || '';
    return findCustomer(sender);
  }
  const lines = textValue.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 5);
  for (const line of lines) {
    const direct = findCustomer(line.replace(/^[-•·*]+\s*/, ''));
    if (direct) return direct;
  }
  return null;
}

function detectInput(rawText) {
  if (state.imageEvidence) return { sourceType: 'IMAGE_OCR', label: '사진 OCR' };
  const structured = parseStructuredOrderText(rawText);
  if (structured.detected) return { sourceType: 'GENERAL_TEXT', label: `쇼핑몰 표형 주문 · ${structured.rows.length}개 상품` };
  if (KAKAO_HEADER.test(String(rawText || ''))) return { sourceType: 'KAKAO_TEXT', label: '카카오 대화' };
  return { sourceType: 'GENERAL_TEXT', label: '일반 텍스트' };
}

function updateDetectionNote() {
  const rawText = $('rawText').value;
  if (!rawText.trim() && !state.imageEvidence) {
    $('inputDetectionNote').textContent = '입력 종류는 자동으로 판단합니다.';
    return;
  }
  const detected = detectInput(rawText);
  $('inputDetectionNote').textContent = `${detected.label}로 인식`;
}

async function loadCustomers() {
  try {
    state.customers = (await getAll(STORE.CUSTOMERS)).filter(customer => (customer.status || 'ACTIVE') !== 'INACTIVE');
    $('customerOptions').innerHTML = state.customers
      .map(customer => `<option value="${esc(customerName(customer))}" label="${esc(customerCode(customer))}"></option>`)
      .join('');
  } catch (error) {
    state.customers = [];
    msg('거래처 목록을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.', 'error');
  }
}

function updatePresetCustomer() {
  const customer = findCustomer($('customerPreset').value);
  state.activeCustomer = customer;
  $('customerPresetId').value = customer?.customerId || '';
  return customer;
}

async function fileToEvidence(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const contentHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('이미지를 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
  return {
    fileName: file.name || '붙여넣은 이미지',
    mimeType: file.type || 'image/png',
    byteLength: file.size || buffer.byteLength,
    contentHash,
    binaryBase64: dataUrl.split(',')[1] || '',
    dataUrl
  };
}

async function recognizeImage(file) {
  if (!file || !String(file.type || '').startsWith('image/')) return;
  if (state.ocrRunning) return;
  state.ocrRunning = true;
  state.imageFile = file;
  $('captureBtn').disabled = true;
  $('imagePreview').hidden = false;
  $('imagePreviewName').textContent = file.name || '붙여넣은 주문사진';
  $('imageOcrStatus').textContent = '사진 준비 중…';
  $('imageStatus').textContent = '사진에서 주문문자를 추출하고 있습니다.';
  try {
    const evidence = await fileToEvidence(file);
    state.imageEvidence = evidence;
    $('imagePreviewImg').src = evidence.dataUrl;
    if (!window.Tesseract?.recognize) throw new Error('OCR 엔진을 불러오지 못했습니다.');
    const result = await window.Tesseract.recognize(file, 'kor+eng', {
      logger: progress => {
        if (progress.status === 'recognizing text') {
          const percent = Math.round(Number(progress.progress || 0) * 100);
          $('imageOcrStatus').textContent = `문자 추출 ${percent}%`;
        }
      }
    });
    const extracted = String(result?.data?.text || '').replace(/\r/g, '').trim();
    if (!extracted) throw new Error('사진에서 주문문자를 찾지 못했습니다.');
    $('rawText').value = extracted;
    $('imageOcrStatus').textContent = '문자 추출 완료';
    $('imageStatus').textContent = '추출된 내용을 확인한 뒤 분석 실행을 누르세요.';
    updateDetectionNote();
    msg('사진 문자를 추출했습니다. 거래처와 추출 내용을 확인한 뒤 분석 실행을 누르세요.', 'success');
  } catch (error) {
    $('imageOcrStatus').textContent = '문자 추출 실패';
    $('imageStatus').textContent = '사진은 유지했습니다. 주문내용을 직접 입력해도 됩니다.';
    msg(`${friendlyError(error)} 주문내용을 직접 입력할 수도 있습니다.`, 'error');
  } finally {
    state.ocrRunning = false;
    $('captureBtn').disabled = false;
  }
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
    msg(friendlyError(error), 'error');
  }
}

railSteps.forEach((button, index) => {
  button.addEventListener('click', () => goBackTo(index));
});

$('customerPreset').addEventListener('input', updatePresetCustomer);
$('rawText').addEventListener('input', updateDetectionNote);
$('customerExpression').readOnly = true;

$('imageInput').addEventListener('change', event => {
  const file = [...(event.target.files || [])].find(item => String(item.type || '').startsWith('image/'));
  if (file) recognizeImage(file);
  event.target.value = '';
});

document.addEventListener('paste', event => {
  const file = [...(event.clipboardData?.items || [])]
    .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map(item => item.getAsFile())
    .find(Boolean);
  if (!file) return;
  event.preventDefault();
  recognizeImage(file);
});

$('rawEntryField').addEventListener('dragover', event => {
  const hasImage = [...(event.dataTransfer?.items || [])].some(item => item.kind === 'file' && String(item.type || '').startsWith('image/'));
  if (hasImage) event.preventDefault();
});

$('rawEntryField').addEventListener('drop', event => {
  const file = [...(event.dataTransfer?.files || [])].find(item => String(item.type || '').startsWith('image/'));
  if (!file) return;
  event.preventDefault();
  recognizeImage(file);
});

$('captureBtn').onclick = async () => {
  const button = $('captureBtn');
  try {
    if (state.ocrRunning) {
      msg('사진 문자 추출이 끝난 뒤 분석할 수 있습니다.', 'warn');
      return;
    }
    const rawText = $('rawText').value.trim();
    if (!rawText) {
      msg('분석할 주문내용을 입력하세요.', 'error');
      $('rawText').focus();
      return;
    }

    const detected = detectInput(rawText);
    const presetValue = $('customerPreset').value.trim();
    const presetCustomer = presetValue ? findCustomer(presetValue) : null;
    const inferredCustomer = inferCustomerFromRaw(rawText, detected.sourceType);
    const customer = presetCustomer || inferredCustomer;
    state.activeCustomer = customer;
    if (customer) {
      $('customerPreset').value = customerName(customer);
      $('customerPresetId').value = customer.customerId || '';
    }
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = '분석 중…';
    msg(customer ? `${customerName(customer)} 기준으로 주문을 분석하고 있습니다…` : '주문 상품과 수량을 먼저 추출하고 있습니다…', 'info');

    const captured = await captureTextIntake({
      sourceType: detected.sourceType,
      sourceId: 'ORDER_IN',
      rawText,
      imageEvidence: state.imageEvidence
    });
    const analyzed = await analyzeSingleOrderDocument({
      session: captured.session,
      sourcePart: captured.sourcePart,
      rawText,
      customerOverride: customer ? {
        customerId: customer.customerId,
        customerName: customerName(customer)
      } : null,
      headerDraft: { warehouseName: $('warehouse').value }
    });
    state.document = analyzed.document;
    state.lines = analyzed.lines;
    state.captured = true;
    $('rawPreview').textContent = rawText;
    $('customerExpression').value = analyzed.document.confirmedCustomerName || (customer ? customerName(customer) : presetValue);
    rows();
    step(0);
    const label = analyzed.detectedInputType === 'SHOP_TABLE' ? '쇼핑몰 표형 주문을 인식했습니다.' : `${detectInput(rawText).label} 분석이 완료되었습니다.`;
    msg(`${label} 추출한 내용을 확인하세요.`, 'success');
  } catch (error) {
    msg(friendlyError(error), 'error');
  } finally {
    button.disabled = false;
    button.textContent = button.dataset.originalText || '분석 실행 →';
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
    if (!state.activeCustomer) {
      const customer = await openCustomerPicker({
        initialName: state.document?.confirmedCustomerName || $('customerExpression').value || $('customerPreset').value,
        source: 'ORDER_IN_QUICK_CREATE',
        title: '거래처 선택 후 상품매칭'
      });
      if (!customer) {
        msg('상품매칭을 계속하려면 거래처를 선택하거나 등록해 주세요.', 'warn');
        return;
      }
      state.activeCustomer = customer;
      if (!state.customers.some(row => row.customerId === customer.customerId)) state.customers.push(customer);
      $('customerPreset').value = customerName(customer);
      $('customerPresetId').value = customer.customerId;
      $('customerExpression').value = customerName(customer);
      state.lines = await rematchExtractedLinesForCustomer(state.lines, {
        customerId: customer.customerId,
        customerName: customerName(customer)
      });
      state.document = {
        ...state.document,
        confirmedCustomerId: customer.customerId,
        confirmedCustomerName: customerName(customer),
        customerResolutionStatus: 'CONFIRMED'
      };
      state.lines = state.lines.map(line => ({ ...line, customerId: customer.customerId, customerName: customerName(customer) }));
    }
    const result = await confirmExtraction({ document: state.document, lines: state.lines });
    state.document = result.document;
    state.lines = result.lines;
    editor();
    step(1);
    msg(`${state.activeCustomer ? customerName(state.activeCustomer) : '거래처'} 기준 상품 매칭을 확인하세요.`, 'success');
  } catch (error) {
    msg(friendlyError(error), 'error');
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
    state.lines.forEach(line => {
      if (line.reviewStatus === 'EXCLUDED') return;
      if (line.productIdentityStatus === 'MASTER_LINKED') line.reviewStatus = 'CONFIRMED';
    });
    const result = await confirmMatching({ document: state.document, lines: state.lines });
    state.document = result.document;
    state.lines = result.lines;
    $('completionEditor').innerHTML = $('draftEditor').innerHTML;
    step(2);
    msg('상품 확인이 끝났습니다. 최종 주문 내용을 확인하세요.', 'success');
  } catch (error) {
    msg(friendlyError(error), 'error');
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
        customerId: state.activeCustomer?.customerId || state.document.confirmedCustomerId || '',
        customerName: state.activeCustomer ? customerName(state.activeCustomer) : state.document.confirmedCustomerName,
        warehouseName: $('warehouse').value,
        transactionType: '기타',
        orderStatus: 'ORDER',
        adminStatus: 'UNCHECKED'
      }
    });
    location.href = `./index.html?orderId=${encodeURIComponent(result.order.orderId)}`;
  } catch (error) {
    msg(friendlyError(error), 'error');
  }
};

renderRail(0);
loadCustomers();
updateDetectionNote();
