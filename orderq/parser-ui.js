import { analyzeSmartText, summarizeParserResults } from './smartparser/parser-orchestrator.js?v=0.8.0';
import { EVENT_TYPE } from './smartparser/order-event-detector.js?v=0.8.0';
import { updateParseResult, recordProductMapping } from './smartparser/parser-repository.js?v=0.8.0';
import {
  createOrder,
  DuplicateSourceMessageError,
  MATCH_STATUS
} from './order-intake-engine.js?v=0.8.0';
import {
  getDeviceId,
  syncNow,
  syncAfterLocalMutation
} from './orderq-sync-engine.js?v=0.8.0';
import { getCloudUrl } from './orderq-cloud-adapter.js?v=0.8.0';
import { loadWarehouseCatalog, matchWarehouseInput, warehouseDisplayName } from './warehouse-master.js?v=0.8.0';

const EVENT_LABELS = Object.freeze({
  ORDER: '신규 주문',
  ORDER_UPDATE: '주문 변경',
  ORDER_CANCEL: '주문 취소',
  NOTICE: '공지',
  INFORMATION: '정보',
  ACK: '응답',
  UNKNOWN: '판정불가'
});
const EVENT_OPTIONS = Object.keys(EVENT_LABELS);
const state = { results: new Map() };

const resultList = document.getElementById('resultList');
const message = document.getElementById('message');
const analyzeButton = document.getElementById('analyzeBtn');
const parserWarehouseInput = document.getElementById('parserWarehouse');
const parserWarehouseOptions = document.getElementById('parserWarehouseOptions');
let warehouseCatalog = { warehouses: [], aliases: [] };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

function todayLocal() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

async function initializeWarehouseInput() {
  warehouseCatalog = await loadWarehouseCatalog();
  warehouseCatalog.warehouses.forEach(warehouse => {
    const option = document.createElement('option');
    option.value = warehouseDisplayName(warehouse);
    option.label = [warehouse.warehouseCode, warehouse.warehouseName].filter(Boolean).join(' · ');
    parserWarehouseOptions.appendChild(option);
  });
  try {
    const defaults = JSON.parse(localStorage.getItem('oneapp.orderq.manual-defaults.v1') || 'null');
    parserWarehouseInput.value = String(defaults?.warehouseName || defaults?.warehouse || '').trim();
  } catch (_) {}
}

function show(text, type = 'info') {
  message.textContent = text;
  message.className = `message show ${type}`;
  message.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function eventOptions(selected) {
  return EVENT_OPTIONS.map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${EVENT_LABELS[value]}</option>`).join('');
}

function lineCandidateOptions(line) {
  const options = (line.candidateProducts || []).map((candidate, index) => {
    const label = `${candidate.itemName || candidate.itemCode || candidate.productId} · ${Math.round(candidate.score * 100)}% · ${candidate.source}`;
    return `<option value="${index}">${esc(label)}</option>`;
  });
  return `<option value="">후보 선택</option>${options.join('')}`;
}

function lineRow(line, index) {
  const status = line.matchStatus || 'MATCH_FAILED';
  return `<tr data-line-index="${index}">
    <td class="line-raw">${esc(line.rawText)}</td>
    <td>${esc(line.productText || '')}</td>
    <td class="line-candidates"><select data-field="candidate">${lineCandidateOptions(line)}</select><input data-field="productId" type="hidden" value="${esc(line.confirmedProductId || line.productId || '')}"></td>
    <td><input data-field="itemCode" value="${esc(line.itemCode || '')}" placeholder="품목코드"></td>
    <td><input data-field="itemName" value="${esc(line.itemName || '')}" placeholder="확정 품명"></td>
    <td><input data-field="specification" value="${esc(line.specification || line.specText || '')}"></td>
    <td><input class="num" data-field="quantity" type="number" step="any" value="${esc(line.quantity ?? '')}"></td>
    <td><input data-field="rawUnit" value="${esc(line.rawUnit || '')}"></td>
    <td><select data-field="matchStatus">
      <option value="MATCHED" ${status === 'MATCHED' ? 'selected' : ''}>매칭완료</option>
      <option value="MATCH_FAILED" ${status === 'MATCH_FAILED' ? 'selected' : ''}>매칭실패</option>
      <option value="EXCLUDED" ${status === 'EXCLUDED' ? 'selected' : ''}>제외</option>
    </select></td>
    <td class="center"><input type="checkbox" data-field="remember" ${status === 'MATCHED' ? '' : 'disabled'} title="확정 표현을 상품 매핑으로 저장"></td>
  </tr>`;
}

function isIssue(result) {
  if (result.eventType === EVENT_TYPE.UNKNOWN) return true;
  if (![EVENT_TYPE.ORDER, EVENT_TYPE.ORDER_UPDATE].includes(result.eventType)) return false;
  return result.customerStatus !== 'MATCHED' || (result.parsedLines || []).some(line => line.matchStatus === 'MATCH_FAILED');
}

function actionLabel(eventType) {
  if (eventType === EVENT_TYPE.ORDER) return '주문 등록';
  if (eventType === EVENT_TYPE.ORDER_UPDATE) return '주문 수정 반영';
  if (eventType === EVENT_TYPE.ORDER_CANCEL) return '주문 취소 반영';
  return '판정 저장';
}

function renderCard(result) {
  const issue = isIssue(result);
  const cardClass = result.orderId ? 'done' : (result.duplicate ? 'duplicate' : (issue ? 'issue' : ''));
  const candidateNames = [
    result.customerCandidate?.customerName,
    ...(result.customerCandidates || []).map(candidate => candidate.customer?.customerName)
  ].filter(Boolean);
  const customerValue = result.confirmedCustomerName || result.customerCandidate?.customerName || result.senderRaw || '';
  const customerListId = `customers-${result.parseResultId}`;
  const orderLike = [EVENT_TYPE.ORDER, EVENT_TYPE.ORDER_UPDATE].includes(result.eventType);
  const existingLink = result.orderId
    ? `<a class="existing-order" href="./index.html?focus=${encodeURIComponent(result.orderId)}">기존 전표 보기</a>`
    : '';
  const table = orderLike ? `<div class="table-wrap"><table class="line-table">
    <thead><tr><th>원문</th><th>파싱 상품</th><th>후보</th><th>품목코드</th><th>확정 품명</th><th>규격</th><th>수량</th><th>단위</th><th>판정</th><th>매핑저장</th></tr></thead>
    <tbody>${(result.parsedLines || []).map(lineRow).join('') || '<tr><td colspan="10" class="empty">주문상품을 파싱하지 못했습니다.</td></tr>'}</tbody>
  </table></div>` : `<div class="card-note">비주문 메시지는 Order Intake에 등록하지 않습니다. 판정만 수정·저장할 수 있습니다.</div>`;
  return `<article class="parse-card ${cardClass}" data-parse-result-id="${esc(result.parseResultId)}">
    <div class="parse-head">
      <div>
        <div class="message-meta"><span>${esc(result.senderRaw || '발신자 없음')}</span><span>${esc(result.timestampRaw || '시간 없음')}</span><span>${esc(result.sourceMessageKey)}</span></div>
        <div class="raw-message">${esc(result.rawText)}</div>
      </div>
      <div class="parse-fields">
        <div class="field"><label>메시지 판정</label><select class="control" data-role="eventType">${eventOptions(result.eventType)}</select><span class="event-score">신뢰 ${Math.round(Number(result.eventScore || 0) * 100)}% · ${esc((result.eventReasons || []).join(', '))}</span></div>
        <div class="field"><label>거래처 확정</label><input class="control" data-role="customerName" list="${customerListId}" value="${esc(customerValue)}"><input data-role="customerId" type="hidden" value="${esc(result.confirmedCustomerId || '')}"><datalist id="${customerListId}">${candidateNames.map(name => `<option value="${esc(name)}">`).join('')}</datalist></div>
        <div class="field"><label>주문 그룹</label><input class="control" data-role="orderGroup" value="${esc(result.orderGroup || '')}"></div>
        <div class="field target-field" data-role="targetField" ${[EVENT_TYPE.ORDER_UPDATE, EVENT_TYPE.ORDER_CANCEL].includes(result.eventType) ? '' : 'hidden'}><label>대상 주문ID</label><input class="control" data-role="targetOrderId" value="${esc(result.targetOrderId || '')}" placeholder="ORD-..."></div>
      </div>
      <div class="card-actions">
        ${existingLink}
        <button class="btn primary" data-action="process" type="button" ${result.orderId ? 'disabled' : ''}>${result.orderId ? '등록 완료' : actionLabel(result.eventType)}</button>
      </div>
    </div>
    ${table}
  </article>`;
}

function renderResults(results) {
  state.results = new Map(results.map(result => [result.parseResultId, result]));
  const sorted = [...results].sort((a, b) => Number(isIssue(b)) - Number(isIssue(a)) || a.contextIndex - b.contextIndex);
  resultList.innerHTML = sorted.map(renderCard).join('') || '<div class="empty">분석결과가 없습니다.</div>';
  renderSummary(results);
}

function renderSummary(results) {
  const summary = summarizeParserResults(results);
  document.getElementById('summarySection').hidden = false;
  document.getElementById('sumOrders').textContent = summary.orders;
  document.getElementById('sumItems').textContent = summary.items;
  document.getElementById('sumMatched').textContent = summary.matched;
  document.getElementById('sumFailed').textContent = summary.failed;
  document.getElementById('sumExcluded').textContent = summary.excludedMessages;
  document.getElementById('sumDuplicates').textContent = summary.duplicates;
}

function findCard(parseResultId) {
  return [...resultList.querySelectorAll('.parse-card')].find(card => card.dataset.parseResultId === parseResultId);
}

function readCard(result, card) {
  const customerName = card.querySelector('[data-role="customerName"]').value.trim();
  const knownCustomers = [result.customerCandidate, ...(result.customerCandidates || []).map(candidate => candidate.customer)].filter(Boolean);
  const known = knownCustomers.find(customer => customer.customerName === customerName);
  const lines = [...card.querySelectorAll('[data-line-index]')].map(row => {
    const get = field => row.querySelector(`[data-field="${field}"]`)?.value ?? '';
    const original = result.parsedLines[Number(row.dataset.lineIndex)] || {};
    const quantity = get('quantity');
    const productId = get('productId').trim();
    const requestedMatchStatus = get('matchStatus');
    const matchStatus = requestedMatchStatus === MATCH_STATUS.MATCHED && !productId
      ? MATCH_STATUS.MATCH_FAILED
      : requestedMatchStatus;
    return {
      ...original,
      productId: productId || null,
      confirmedProductId: productId,
      itemCode: get('itemCode').trim(),
      itemName: get('itemName').trim(),
      specification: get('specification').trim(),
      quantity: quantity === '' ? null : Number(quantity),
      rawQuantity: quantity === '' ? null : Number(quantity),
      finalQuantity: quantity === '' ? null : Number(quantity),
      rawUnit: get('rawUnit').trim(),
      finalUnit: get('rawUnit').trim(),
      matchStatus,
      rememberMapping: Boolean(row.querySelector('[data-field="remember"]')?.checked)
    };
  });
  return {
    eventType: card.querySelector('[data-role="eventType"]').value,
    confirmedCustomerId: known?.customerId || card.querySelector('[data-role="customerId"]').value,
    confirmedCustomerName: customerName,
    orderGroup: card.querySelector('[data-role="orderGroup"]').value.trim(),
    targetOrderId: card.querySelector('[data-role="targetOrderId"]').value.trim(),
    parsedLines: lines
  };
}

function orderItems(lines) {
  return lines.filter(line => line.rawText || line.itemCode || line.itemName || line.quantity !== null).map((line, index) => ({
    lineNo: index + 1,
    productId: line.productId,
    itemCode: line.itemCode,
    itemName: line.itemName,
    specification: line.specification,
    quantity: line.quantity,
    rawQuantity: line.rawQuantity,
    finalQuantity: line.finalQuantity,
    rawUnit: line.rawUnit,
    finalUnit: line.finalUnit,
    rawText: line.rawText,
    memo: line.attributeText || '',
    matchStatus: line.matchStatus,
    matchSource: line.matchSource || (line.matchStatus === MATCH_STATUS.MATCHED ? 'ADMIN_CONFIRMED' : 'SMARTPARSER')
  }));
}

async function rememberMappings(result, confirmed) {
  for (const line of confirmed.parsedLines.filter(line => line.rememberMapping && line.productId && line.itemCode && line.itemName)) {
    await recordProductMapping({
      customerId: confirmed.confirmedCustomerId,
      sourceId: result.sourceId,
      rawText: line.productText || line.rawText,
      productId: line.productId,
      itemCode: line.itemCode,
      itemName: line.itemName,
      specification: line.specification,
      finalUnit: line.finalUnit
    });
  }
}

async function bestEffortPreSync() {
  if (!getCloudUrl()) return;
  try { await syncNow(); }
  catch (error) { show(`클라우드 선행 동기화 실패 · 로컬 처리는 계속합니다: ${error.message || error}`, 'warn'); }
}

async function processCard(parseResultId) {
  const result = state.results.get(parseResultId);
  const card = findCard(parseResultId);
  if (!result || !card) return;
  const button = card.querySelector('[data-action="process"]');
  const confirmed = readCard(result, card);
  button.disabled = true;
  try {
    await updateParseResult(parseResultId, confirmed);
    if ([EVENT_TYPE.ORDER_UPDATE, EVENT_TYPE.ORDER_CANCEL].includes(confirmed.eventType)) {
      state.results.set(parseResultId, { ...result, ...confirmed, safetyStatus: 'MANUAL_REVIEW_REQUIRED' });
      card.classList.remove('done', 'duplicate');
      card.classList.add('issue');
      button.textContent = '수기 검수 대기';
      button.disabled = true;
      show('변경·취소 메시지는 자동 반영하지 않습니다. 대상 주문 전체를 수기 주문 화면에서 확인한 뒤 수정·취소하세요.', 'warn');
      return;
    }
    if (![EVENT_TYPE.ORDER, EVENT_TYPE.ORDER_UPDATE, EVENT_TYPE.ORDER_CANCEL].includes(confirmed.eventType)) {
      state.results.set(parseResultId, { ...result, ...confirmed });
      card.classList.remove('issue', 'duplicate');
      card.classList.add('done');
      button.disabled = false;
      button.textContent = '판정 저장';
      show('메시지 판정을 저장했습니다. 비주문 메시지는 주문원장에 등록하지 않았습니다.', 'info');
      return;
    }
    if (!confirmed.confirmedCustomerName && confirmed.eventType !== EVENT_TYPE.ORDER_CANCEL) throw new Error('거래처를 확인하거나 입력하세요.');
    const warehouseName = parserWarehouseInput.value.trim();
    if (!warehouseName) throw new Error('출하창고를 입력하세요.');
    const warehouse = matchWarehouseInput(warehouseName, warehouseCatalog.warehouses, warehouseCatalog.aliases);
    let saved;
    if (confirmed.eventType === EVENT_TYPE.ORDER) {
      await bestEffortPreSync();
      saved = await createOrder({
        orderDate: todayLocal(),
        customerId: confirmed.confirmedCustomerId,
        customerName: confirmed.confirmedCustomerName,
        warehouseId: warehouse?.warehouseId || '',
        warehouseCode: warehouse?.warehouseCode || '',
        warehouseName,
        warehouse: warehouseName,
        transactionType: '기타',
        orderMessage: result.rawText,
        sourceType: result.sourceType,
        inputChannel: 'ORDER_IN',
        sourceId: result.sourceId,
        sourceMessageKey: result.sourceMessageKey,
        items: orderItems(confirmed.parsedLines)
      });
    }
    await rememberMappings(result, confirmed);
    await updateParseResult(parseResultId, {
      ...confirmed,
      orderId: saved.order.orderId,
      targetOrderId: confirmed.targetOrderId || saved.order.orderId,
      processedAt: new Date().toISOString()
    });
    let syncMessage = '로컬 주문 등록 완료';
    let finalOrderId = saved.order.orderId;
    try {
      const sync = await syncAfterLocalMutation(saved.order.orderId);
      finalOrderId = sync.canonicalOrderId || finalOrderId;
      syncMessage = sync.sourceDuplicate
        ? '같은 원문으로 먼저 등록된 클라우드 주문을 적용했습니다.'
        : (sync.online ? '주문 등록 및 클라우드 동기화 완료' : '로컬 주문 등록 완료 · 클라우드 동기화 대기');
    } catch (error) {
      syncMessage = `로컬 주문 등록 완료 · 클라우드 확인 필요: ${error.message || error}`;
    }
    await updateParseResult(parseResultId, { orderId: finalOrderId, targetOrderId: confirmed.targetOrderId || finalOrderId });
    const next = { ...result, ...confirmed, orderId: finalOrderId };
    state.results.set(parseResultId, next);
    card.classList.remove('issue', 'duplicate');
    card.classList.add('done');
    button.textContent = '등록 완료';
    const actionBox = card.querySelector('.card-actions');
    actionBox.insertAdjacentHTML('afterbegin', `<a class="existing-order" href="./index.html?focus=${encodeURIComponent(finalOrderId)}&saved=1">주문현황에서 전표 보기</a>`);
    show(syncMessage, syncMessage.includes('완료') && !syncMessage.includes('확인') ? 'info' : 'warn');
  } catch (error) {
    if (error instanceof DuplicateSourceMessageError || error.code === 'ORDER_SOURCE_MESSAGE_DUPLICATE') {
      const orderId = error.existingOrder?.orderId || '';
      show(`이미 처리한 메시지입니다.${orderId ? ` 기존 주문 ${orderId}` : ''}`, 'warn');
      if (orderId) card.querySelector('.card-actions').insertAdjacentHTML('afterbegin', `<a class="existing-order" href="./index.html?focus=${encodeURIComponent(orderId)}">기존 전표 보기</a>`);
    } else {
      show(error.message || String(error), 'error');
    }
    button.disabled = false;
  }
}

analyzeButton.addEventListener('click', async () => {
  const rawText = document.getElementById('rawText').value;
  if (!rawText.trim()) return show('분석할 원문을 붙여넣으세요.', 'error');
  analyzeButton.disabled = true;
  analyzeButton.textContent = '분석 중...';
  try {
    const analysis = await analyzeSmartText({
      sourceType: document.getElementById('sourceType').value,
      sourceId: document.getElementById('sourceId').value.trim(),
      rawText,
      deviceId: getDeviceId(),
      forceReanalyze: document.getElementById('forceReanalyze').checked
    });
    renderResults(analysis.results);
    show(`분석 완료 · 메시지 ${analysis.summary.messages}건 · 신규주문 ${analysis.summary.orders}건 · 매칭실패 ${analysis.summary.failed}건`, analysis.summary.failed ? 'warn' : 'info');
  } catch (error) {
    show(error.message || String(error), 'error');
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = '분석';
  }
});

resultList.addEventListener('change', event => {
  const card = event.target.closest('.parse-card');
  if (!card) return;
  if (event.target.matches('[data-role="eventType"]')) {
    const targetField = card.querySelector('[data-role="targetField"]');
    targetField.hidden = ![EVENT_TYPE.ORDER_UPDATE, EVENT_TYPE.ORDER_CANCEL].includes(event.target.value);
    const button = card.querySelector('[data-action="process"]');
    if (!button.disabled) button.textContent = actionLabel(event.target.value);
    return;
  }
  if (event.target.matches('[data-field="candidate"]')) {
    const row = event.target.closest('[data-line-index]');
    const result = state.results.get(card.dataset.parseResultId);
    const line = result?.parsedLines?.[Number(row.dataset.lineIndex)];
    const candidate = line?.candidateProducts?.[Number(event.target.value)];
    if (!candidate) return;
    row.querySelector('[data-field="productId"]').value = candidate.productId || '';
    row.querySelector('[data-field="itemCode"]').value = candidate.itemCode || '';
    row.querySelector('[data-field="itemName"]').value = candidate.itemName || '';
    if (!row.querySelector('[data-field="specification"]').value) row.querySelector('[data-field="specification"]').value = candidate.specification || '';
    row.querySelector('[data-field="matchStatus"]').value = 'MATCHED';
    row.querySelector('[data-field="remember"]').disabled = false;
  }
  if (event.target.matches('[data-field="matchStatus"]')) {
    const remember = event.target.closest('tr').querySelector('[data-field="remember"]');
    remember.disabled = event.target.value !== 'MATCHED';
    if (remember.disabled) remember.checked = false;
  }
});

resultList.addEventListener('click', event => {
  const button = event.target.closest('[data-action="process"]');
  if (!button) return;
  const card = button.closest('.parse-card');
  processCard(card.dataset.parseResultId);
});

initializeWarehouseInput().catch(error => show(`창고 마스터를 불러오지 못했습니다: ${error.message || error}`, 'warn'));
