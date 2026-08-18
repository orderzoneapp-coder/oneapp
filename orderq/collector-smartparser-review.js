import { analyzeSmartText } from './smartparser/parser-orchestrator.js?v=0.8.0';
import { recordProductMapping } from './smartparser/parser-repository.js?v=0.8.0';
import { getDeviceId } from './orderq-sync-engine.js?v=0.8.0';

const reviewState = { analysis: null, sourceId: '', sourceType: 'GENERAL_TEXT', rawText: '', fileName: '', defaultDate: '', sourceMode: '' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const normalize = value => String(value ?? '').trim();

function reviewSection() { return document.querySelector('#orderParserReview'); }
function reviewRows() { return document.querySelector('#orderParserReviewRows'); }
function reviewSummary() { return document.querySelector('#orderParserReviewSummary'); }
function reviewStatus() { return document.querySelector('#orderParserReviewStatus'); }
function reviewCompleteButton() { return document.querySelector('#orderParserReviewCompleteBtn'); }
function collectorMessage(text, type='info') {
  const el = document.querySelector('#message');
  if (!el) return;
  el.textContent = text;
  el.className = `message show ${type}`;
}

function statusOf(line) {
  if (line.matchStatus === 'MATCHED') return 'AUTO';
  return (line.candidateProducts || []).length ? 'REVIEW' : 'UNMATCHED';
}
function statusLabel(status) {
  if (status === 'AUTO') return '자동매칭';
  if (status === 'REVIEW') return '확인필요';
  return '미매칭';
}
function candidateLabel(candidate) {
  const evidence = candidate.evidenceText ? ` · ${candidate.evidenceText}` : '';
  return `${candidate.itemName || candidate.itemCode || '상품'}${candidate.specification ? ` · ${candidate.specification}` : ''} · ${Math.round(Number(candidate.score || 0) * 100)}%${evidence}`;
}

function allOrderLines() {
  const rows = [];
  (reviewState.analysis?.results || []).forEach((result, resultIndex) => {
    (result.parsedLines || []).forEach((line, lineIndex) => {
      if (line.matchStatus === 'EXCLUDED') return;
      rows.push({ result, resultIndex, line, lineIndex });
    });
  });
  return rows;
}

function renderReview() {
  const section = reviewSection();
  const tbody = reviewRows();
  if (!section || !tbody) return;
  const lines = allOrderLines();
  const counts = lines.reduce((acc, row) => { acc[statusOf(row.line)] += 1; return acc; }, { AUTO:0, REVIEW:0, UNMATCHED:0 });
  section.classList.remove('hidden');
  reviewSummary().innerHTML = `<div><span>전체</span><strong>${lines.length}</strong></div><div><span>자동매칭</span><strong>${counts.AUTO}</strong></div><div class="review"><span>확인필요</span><strong>${counts.REVIEW}</strong></div><div class="unmatched"><span>미매칭</span><strong>${counts.UNMATCHED}</strong></div>`;
  const sorted = [...lines].sort((a,b) => ({UNMATCHED:0,REVIEW:1,AUTO:2}[statusOf(a.line)] - {UNMATCHED:0,REVIEW:1,AUTO:2}[statusOf(b.line)]));
  tbody.innerHTML = sorted.length ? sorted.map(({result,resultIndex,line,lineIndex}) => {
    const status = statusOf(line);
    const candidates = line.candidateProducts || [];
    const selectedId = line.confirmedProductId || line.productId || candidates[0]?.productId || '';
    const options = candidates.map(candidate => `<option value="${esc(candidate.productId || '')}" data-code="${esc(candidate.itemCode || '')}" data-name="${esc(candidate.itemName || '')}" data-spec="${esc(candidate.specification || '')}" data-unit="${esc(candidate.finalUnit || '')}" ${selectedId && candidate.productId === selectedId ? 'selected' : ''}>${esc(candidateLabel(candidate))}</option>`).join('');
    return `<tr data-review-result="${resultIndex}" data-review-line="${lineIndex}" data-review-status="${status}">
      <td><span class="parser-review-state ${status.toLowerCase()}">${statusLabel(status)}</span></td>
      <td>${esc(result.confirmedCustomerName || result.customerCandidate?.customerName || result.senderRaw || '')}</td>
      <td class="parser-raw-expression">${esc(line.rawText || line.productText || '')}</td>
      <td>${esc(line.productText || '')}</td>
      <td class="num">${esc(line.quantity ?? '')}</td>
      <td><select class="control parser-candidate-select" data-review-candidate><option value="">${candidates.length ? '상품 후보 선택' : '후보 없음 · 마스터 검색 필요'}</option>${options}</select></td>
      <td><input class="control" data-review-code value="${esc(line.itemCode || candidates[0]?.itemCode || '')}" placeholder="품목코드"></td>
      <td><input class="control" data-review-name value="${esc(line.itemName || candidates[0]?.itemName || '')}" placeholder="확정 품명"></td>
      <td><input class="control" data-review-spec value="${esc(line.specification || line.specText || candidates[0]?.specification || '')}" placeholder="규격"></td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="empty">주문상품을 찾지 못했습니다.</td></tr>';
  updateReviewReady();
}

function updateReviewReady() {
  const rows = [...(reviewRows()?.querySelectorAll('tr[data-review-result]') || [])];
  const incomplete = rows.filter(row => !normalize(row.querySelector('[data-review-code]')?.value) && !normalize(row.querySelector('[data-review-name]')?.value));
  const button = reviewCompleteButton();
  if (button) button.disabled = !rows.length || incomplete.length > 0;
  if (reviewStatus()) reviewStatus().textContent = incomplete.length
    ? `미매칭 ${incomplete.length}건의 상품을 선택하거나 품목코드·품명을 입력해 주세요.`
    : `검수 대상 ${rows.length}건 · 확인 후 한 번에 주문 후보를 만듭니다.`;
}

function readConfirmedRows() {
  const uiRows = [...reviewRows().querySelectorAll('tr[data-review-result]')];
  return uiRows.map(row => {
    const resultIndex = Number(row.dataset.reviewResult);
    const lineIndex = Number(row.dataset.reviewLine);
    const result = reviewState.analysis.results[resultIndex];
    const original = result.parsedLines[lineIndex];
    const candidateSelect = row.querySelector('[data-review-candidate]');
    const option = candidateSelect?.selectedOptions?.[0];
    const productId = normalize(candidateSelect?.value) || normalize(original.confirmedProductId || original.productId);
    return {
      result,
      original,
      status: row.dataset.reviewStatus,
      productId,
      itemCode: normalize(row.querySelector('[data-review-code]').value) || normalize(option?.dataset.code),
      itemName: normalize(row.querySelector('[data-review-name]').value) || normalize(option?.dataset.name),
      specification: normalize(row.querySelector('[data-review-spec]').value) || normalize(option?.dataset.spec) || normalize(original.specText),
      finalUnit: normalize(option?.dataset.unit) || normalize(original.rawUnit),
      quantity: Number(original.quantity || 0)
    };
  });
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return { bytes, hash:[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('') };
}

async function buildPrepared(rows) {
  const { bytes, hash } = await sha256Text(reviewState.rawText);
  return {
    sourceType: 'KAKAO_HISTORY',
    fileName: reviewState.fileName || `${reviewState.sourceId || '주문텍스트'}.txt`,
    fileSize: bytes.length,
    fileHash: hash,
    sheetName: 'SMARTPARSER_REVIEW',
    headerRowNo: 0,
    confidence: 100,
    defaultDate: reviewState.defaultDate,
    rows: rows.map((row, index) => ({
      rowNo: index + 1,
      rawRecord: { sender:row.result.senderRaw, timestamp:row.result.timestampRaw, message:row.result.rawText, line:row.original.rawText },
      normalizedRecord: {
        orderDate: reviewState.defaultDate,
        orderTime: '',
        customerName: row.result.confirmedCustomerName || row.result.customerCandidate?.customerName || row.result.senderRaw || '',
        sourceMessageKey: row.result.sourceMessageKey,
        documentNo: row.result.sourceMessageKey,
        productCode: row.itemCode,
        productName: row.itemName,
        productId: row.productId,
        rawExpression: row.original.rawText,
        specification: row.specification,
        quantity: row.quantity,
        rawUnit: row.original.rawUnit,
        unit: row.finalUnit || row.original.rawUnit,
        note: row.original.attributeText || ''
      }
    })),
    warnings: [], ignoredSheets: []
  };
}

async function startReview({ rawText, sourceId, sourceType='GENERAL_TEXT', fileName='', defaultDate='', sourceMode='' }) {
  const text = normalize(rawText);
  if (!text) return collectorMessage('파서에 전달할 주문 텍스트가 없습니다.', 'error');
  const button = document.querySelector('#analyzeTextBtn');
  if (button && sourceMode === 'text') { button.disabled = true; button.textContent = '파서 실행 중…'; }
  try {
    const analysis = await analyzeSmartText({ sourceType, sourceId:sourceId || 'COLLECTOR', rawText:text, deviceId:getDeviceId(), forceReanalyze:true });
    reviewState.analysis = analysis;
    reviewState.rawText = text;
    reviewState.sourceId = sourceId || 'COLLECTOR';
    reviewState.sourceType = sourceType;
    reviewState.fileName = fileName || `${sourceId || '주문텍스트'}.txt`;
    reviewState.defaultDate = defaultDate || document.querySelector('#textDate')?.value || '';
    reviewState.sourceMode = sourceMode;
    renderReview();
    collectorMessage(`파서 완료 · 주문상품 ${allOrderLines().length}건 · 상품매칭을 확인해 주세요.`, 'info');
    reviewSection().scrollIntoView({ behavior:'smooth', block:'start' });
  } catch (error) {
    collectorMessage(error.message || String(error), 'error');
  } finally {
    if (button && sourceMode === 'text') { button.disabled = false; button.textContent = '파서 실행'; }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const analyzeText = document.querySelector('#analyzeTextBtn');
  const photoBulk = document.querySelector('#photoBulkCreateBtn');
  const reviewTable = reviewRows();
  const complete = reviewCompleteButton();
  if (!analyzeText || !reviewTable || !complete) return;

  // 기존 Collector의 즉시 prepared 생성보다 먼저 SmartParser 검수 단계로 보낸다.
  analyzeText.addEventListener('click', event => {
    event.preventDefault(); event.stopImmediatePropagation();
    const rawText = document.querySelector('#historyText').value;
    startReview({ rawText, sourceId:document.querySelector('#textSource').value.trim() || 'COLLECTOR_TEXT', sourceType:'GENERAL_TEXT', fileName:`${document.querySelector('#textSource').value.trim() || '직접입력'}.txt`, defaultDate:document.querySelector('#textDate').value, sourceMode:'text' });
  }, true);

  if (photoBulk) photoBulk.addEventListener('click', event => {
    event.preventDefault(); event.stopImmediatePropagation();
    const cards = [...document.querySelectorAll('#photoCandidates .photo-draft')];
    const texts = cards.map(card => card.querySelector('[data-photo-text]')?.value.trim()).filter(Boolean);
    if (!texts.length) return collectorMessage('주문 후보로 만들 사진 OCR 내용이 없습니다.', 'warn');
    startReview({ rawText:texts.join('\n\n'), sourceId:'COLLECTOR_PHOTO', sourceType:'GENERAL_TEXT', fileName:`사진주문_${Date.now()}.txt`, defaultDate:document.querySelector('#textDate').value, sourceMode:'photo' });
  }, true);

  reviewTable.addEventListener('change', event => {
    if (!event.target.matches('[data-review-candidate]')) return;
    const row = event.target.closest('tr');
    const option = event.target.selectedOptions?.[0];
    if (!row || !option || !event.target.value) return;
    row.querySelector('[data-review-code]').value = option.dataset.code || '';
    row.querySelector('[data-review-name]').value = option.dataset.name || '';
    if (!row.querySelector('[data-review-spec]').value) row.querySelector('[data-review-spec]').value = option.dataset.spec || '';
    row.dataset.reviewStatus = row.dataset.reviewStatus === 'AUTO' ? 'AUTO' : 'REVIEW';
    updateReviewReady();
  });
  reviewTable.addEventListener('input', updateReviewReady);

  complete.addEventListener('click', async () => {
    const confirmed = readConfirmedRows();
    if (!confirmed.length) return;
    complete.disabled = true;
    complete.textContent = '주문 후보 생성 중…';
    try {
      // 관리자가 확인필요/미매칭 행에서 상품을 확정한 결과는 별도 체크 없이 표현 매핑으로 누적한다.
      for (const row of confirmed.filter(row => row.productId && row.itemCode && row.itemName && row.status !== 'AUTO')) {
        await recordProductMapping({ customerId:row.result.confirmedCustomerId || row.result.customerCandidate?.customerId || '', sourceId:reviewState.sourceId, rawText:row.original.productText || row.original.rawText, productId:row.productId, itemCode:row.itemCode, itemName:row.itemName, specification:row.specification, finalUnit:row.finalUnit });
      }
      const prepared = await buildPrepared(confirmed);
      window.dispatchEvent(new CustomEvent('orderq:collector-smartparser-prepared', { detail:{ prepared } }));
      reviewSection().classList.add('hidden');
      collectorMessage(`매칭 확인 완료 · ${confirmed.length}건을 주문 후보로 만들었습니다. 아래 주문자료 수집에서 최종 확인하세요.`, 'info');
    } catch (error) {
      collectorMessage(error.message || String(error), 'error');
    } finally {
      complete.disabled = false;
      complete.textContent = '매칭 확인 완료 · 주문 후보 만들기';
    }
  });
});
