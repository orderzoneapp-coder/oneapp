import { unresolvedReviewReadAdapter } from '../orderq/unresolved-review-read-adapter.js?v=0.1.0';

export const ORDEROPS_UNRESOLVED_REVIEW_UI_VERSION = 'ONEAPP_ORDEROPS_UNRESOLVED_REVIEW_UI_V1';
export { unresolvedReviewReadAdapter };

const text = value => String(value ?? '').trim();

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const displayText = value => text(value) || '—';

const displayNumber = value => {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('ko-KR') : '—';
};

const voucherModeLabel = value => text(value).toLowerCase() === 'purchase' ? '구매'
  : text(value).toLowerCase() === 'sale' ? '판매' : '확인 필요';

const integrityLabel = value => text(value).toUpperCase() === 'READY' ? '연결 정상' : '연결 확인 필요';

const safeVoucherDetailHref = value => {
  try {
    const url = new URL(text(value), 'https://oneapp.local/orderops/list.html');
    if (url.origin !== 'https://oneapp.local' || url.pathname !== '/orderq/voucher-query.html') return '';
    if (!['purchase', 'sale'].includes(url.searchParams.get('mode') || '')) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') || !url.searchParams.get('focus')) return '';
    return `../orderq/voucher-query.html?${url.searchParams.toString()}`;
  } catch {
    return '';
  }
};

const candidateBasisLabel = value => {
  const basis = text(value).toUpperCase();
  if (basis === 'EXACT_COMPANY_PRODUCT_CODE') return '정확 상품코드 후보';
  if (basis === 'EXACT_COMPANY_PRODUCT_CODE_AMBIGUOUS') return '상품코드 중복 후보';
  if (basis === 'EXACT_PRODUCT_NAME_REFERENCE_ONLY') return '품명 참고 후보';
  return '검수 참고 후보';
};

export function impactStatusPresentation(value) {
  const status = text(value).toUpperCase();
  if (status === 'APPLY_READY') return { status, label: '적용 가능', detail: '최신 실사 이후 자료입니다.', tone: 'good' };
  if (status === 'DECISION_REQUIRED') return { status, label: '실사 판단 필요', detail: '실사수량 포함 여부를 적용 단계에서 결정해야 합니다.', tone: 'warn' };
  return { status: status || 'REVIEW_REQUIRED', label: '원자료 확인 필요', detail: '연결 또는 필수 근거를 먼저 확인해야 합니다.', tone: 'bad' };
}

const ISSUE_LABELS = Object.freeze({
  REVIEW_LINK_MISSING: '원전표 연결 없음',
  UNRESOLVED_PRODUCT_ID_MISSING: '미매칭 식별자 없음',
  REVIEW_LINK_PENDING_EFFECT_FIELD_MISMATCH: '검수기록과 미반영 기록 불일치',
  REVIEW_LINK_COMPANY_MISMATCH: '회사 범위 불일치',
  PENDING_EFFECT_COMPANY_MISMATCH: '회사 범위 불일치',
  SOURCE_DOCUMENT_COMPANY_MISMATCH: '원전표 회사 범위 불일치',
  SOURCE_LINE_COMPANY_MISMATCH: '원전표 행 회사 범위 불일치',
  VOUCHER_REVISION_COMPANY_MISMATCH: 'Revision 회사 범위 불일치',
  SOURCE_DOCUMENT_MISSING: '원전표 없음',
  SOURCE_LINE_MISSING: '원전표 행 없음',
  VOUCHER_REVISION_MISSING: 'Revision 없음',
  SOURCE_DOCUMENT_NOT_CONFIRMED: '원전표 확정상태 확인 필요',
  VOUCHER_REVISION_NOT_CONFIRMED: 'Revision 확정상태 확인 필요',
  INPUT_QUANTITY_INVALID: '입력수량 확인 필요',
  SIGNED_QUANTITY_INVALID: '구매·판매 부호수량 확인 필요',
  WAREHOUSE_ID_MISSING: '창고 확인 필요',
  BUSINESS_DATE_INVALID: '업무일자 확인 필요',
});

function issueLabels(issues = []) {
  const labels = [...new Set((issues || []).map(issue => ISSUE_LABELS[text(issue?.code)] || '연결 근거 확인 필요'))];
  return labels.length ? labels : ['연결 근거 확인 필요'];
}

export function resolveOrderOpsCompanyId(storage = globalThis.sessionStorage) {
  try {
    const bundle = JSON.parse(storage?.getItem('oneapp.nexus.home.session.v1') || 'null');
    return text(bundle?.session?.companyId || bundle?.session?.user?.companyId) || 'ONEAPP';
  } catch {
    return 'ONEAPP';
  }
}

export function buildUnresolvedListPreview(result = {}) {
  const columns = [
    ['unresolved:product-code', '상품코드', 'productCode', false, 118],
    ['unresolved:product-name', '품명', 'productName', false, 180],
    ['unresolved:specification', '규격', 'specification', false, 92],
    ['unresolved:unit', '단위', 'unit', false, 70],
    ['unresolved:warehouse', '창고', 'warehouse', false, 110],
    ['unresolved:business-date', '업무일자', 'businessDate', false, 108],
    ['unresolved:input-quantity', '입력수량', 'unresolvedInputQuantity', true, 92],
    ['unresolved:signed-quantity', '구매·판매 부호수량', 'unresolvedSignedQuantity', true, 132],
    ['unresolved:official-inventory', '공식재고', 'unresolvedOfficialInventory', false, 104],
    ['unresolved:unapplied-quantity', '미반영 부호수량', 'unresolvedUnappliedQuantity', true, 118],
    ['unresolved:source-count', '원전표', 'sourceCount', true, 82],
    ['unresolved:integrity', '링크 무결성', 'unresolvedIntegrity', false, 122],
    ['unresolved:review', '검수', 'unresolvedReviewAction', false, 126],
  ].map(([key, header, role, numeric, defaultWidth]) => ({ key, header, role, numeric, defaultWidth }));
  const sourceRows = Array.isArray(result.items) ? result.items : [];
  return {
    label: '미매칭 검수',
    columns,
    headers: columns.map(column => column.header),
    numeric: columns.map((column, index) => column.numeric ? index : -1).filter(index => index >= 0),
    inventory: [],
    purchase: -1,
    purchaseEditable: false,
    status: 11,
    sourceRows: sourceRows.map(item => ({
      ...item,
      productCode: item.originalProductCode,
      productName: item.originalProductName,
    })),
    rows: sourceRows.map(item => [
      item.originalProductCode || '',
      item.originalProductName || '',
      item.specification || '',
      item.unit || '',
      (item.aggregate?.warehouseIds || []).join(', '),
      (item.aggregate?.businessDates || []).join(', '),
      item.aggregate?.inputQuantityTotal ?? null,
      item.aggregate?.signedQuantityTotal ?? null,
      item.officialInventory?.label || '미반영',
      item.officialInventory?.unappliedSignedQuantity ?? null,
      item.aggregate?.documentCount ?? 0,
      integrityLabel(item.integrity?.status),
      '원전표·후보 보기',
    ]),
    sortByProductCode: false,
  };
}

export function unresolvedPagePresentation(result = {}) {
  const source = result.page || {};
  const totalItems = Math.max(0, Number(source.totalItems) || 0);
  const limit = Math.min(200, Math.max(1, Number(source.limit) || 200));
  const calculatedPages = totalItems ? Math.ceil(totalItems / limit) : 0;
  const totalPages = Math.max(0, Number(source.totalPages) || calculatedPages);
  const number = totalPages ? Math.min(totalPages, Math.max(1, Number(source.number) || 1)) : 0;
  const returnedItems = Math.max(0, Number(source.returnedItems) || (Array.isArray(result.items) ? result.items.length : 0));
  return {
    number,
    limit,
    totalItems,
    totalPages,
    returnedItems,
    hasPrevious: number > 1,
    hasNext: number > 0 && number < totalPages,
  };
}

export function renderUnresolvedPagination(result = {}, { visibleItems } = {}) {
  const page = unresolvedPagePresentation(result);
  if (!page.totalPages) return '';
  const visible = Math.max(0, Number.isInteger(visibleItems) ? visibleItems : page.returnedItems);
  return `<nav class="unresolved-pagination" aria-label="미매칭 검수 페이지 이동">
    <div class="unresolved-pagination-copy">
      <strong data-unresolved-page-status>${escapeHtml(displayNumber(page.number))}/${escapeHtml(displayNumber(page.totalPages))}페이지</strong>
      <span>현재 페이지 ${escapeHtml(displayNumber(page.returnedItems))}건 · 전체 ${escapeHtml(displayNumber(page.totalItems))}건</span>
      <span>현재 페이지 검색·정렬·열조건 결과 ${escapeHtml(displayNumber(visible))}건</span>
      <small>검색·정렬·열조건은 현재 페이지 자료에만 적용됩니다.</small>
    </div>
    <div class="unresolved-pagination-actions">
      <button class="table-tool-button" type="button" data-unresolved-page="${page.number - 1}" ${page.hasPrevious ? '' : 'disabled'}>이전</button>
      <button class="table-tool-button" type="button" data-unresolved-page="${page.number + 1}" ${page.hasNext ? '' : 'disabled'}>다음</button>
    </div>
  </nav>`;
}

export function renderUnresolvedLoading(page = 1) {
  return `<div class="unresolved-review-state" role="status"><strong>미매칭 ${escapeHtml(displayNumber(page))}페이지 조회 중</strong><span>ORDER Q의 읽기 전용 검수 자료를 확인하고 있습니다.</span></div>`;
}

export function renderUnresolvedEmpty() {
  return '<div class="unresolved-review-state" role="status"><strong>미매칭 자료 없음</strong><span>현재 회사 범위에 검수할 미매칭 자료가 없습니다.</span></div>';
}

export function renderUnresolvedError(page = 1) {
  return `<div class="unresolved-review-state unresolved-review-state--error" role="alert">
    <strong>${escapeHtml(displayNumber(page))}페이지 조회 실패 · 재시도 필요</strong>
    <span>기존 출고·재고 작업은 그대로 사용할 수 있습니다.</span>
    <button class="table-tool-button" type="button" data-unresolved-retry>다시 조회</button>
  </div>`;
}

function sourceRowsMarkup(item) {
  const links = Array.isArray(item?.links) ? item.links : [];
  if (!links.length) return '<tr><td colspan="14" class="empty-table-cell">원전표 연결을 확인할 수 없습니다.</td></tr>';
  return links.map((link, index) => {
    const source = link.sourceVoucher || {};
    const ready = text(link.integrity?.status).toUpperCase() === 'READY';
    const detailHref = safeVoucherDetailHref(source.detailHref);
    return `<tr id="unresolved-trace-${index}" class="${ready ? '' : 'unresolved-review-required-row'}">
      <td>${escapeHtml(link.originalProductCode || '—')}</td>
      <td>${escapeHtml(link.originalProductName || '—')}</td>
      <td>${escapeHtml(link.specification || '—')}</td>
      <td>${escapeHtml(link.unit || '—')}</td>
      <td>${escapeHtml(link.warehouseId || '—')}</td>
      <td>${escapeHtml(link.businessDate || '—')}</td>
      <td class="number">${escapeHtml(displayNumber(link.inputQuantity))}</td>
      <td class="number">${escapeHtml(displayNumber(link.signedQuantity))}</td>
      <td><span class="unresolved-official-null">— · 미반영</span></td>
      <td class="number">${escapeHtml(displayNumber(link.officialInventory?.unappliedSignedQuantity))}</td>
      <td>${escapeHtml(voucherModeLabel(source.voucherMode))}<br><span class="unresolved-id-wrap">${escapeHtml(displayText(source.documentId))}</span></td>
      <td><span class="unresolved-id-wrap">${escapeHtml(displayText(source.lineId))}</span></td>
      <td>r${escapeHtml(displayNumber(source.documentRevision))}<br><span class="unresolved-id-wrap">${escapeHtml(displayText(source.revisionId))}</span></td>
      <td>${detailHref
        ? `<a class="unresolved-inline-link" href="${escapeHtml(detailHref)}" target="_blank" rel="noopener">${escapeHtml(integrityLabel(link.integrity?.status))}</a>`
        : `<a class="unresolved-inline-link" href="#unresolved-trace-${index}">${escapeHtml(integrityLabel(link.integrity?.status))}</a>`}</td>
    </tr>`;
  }).join('');
}

function integrityMarkup(item) {
  if (text(item?.integrity?.status).toUpperCase() === 'READY') {
    return '<span class="unresolved-integrity unresolved-integrity--ready">링크 무결성 정상</span>';
  }
  return `<span class="unresolved-integrity unresolved-integrity--review">링크 확인 필요</span>
    <span class="unresolved-integrity-notes">${issueLabels(item?.integrity?.issues).map(escapeHtml).join(' · ')}</span>`;
}

function candidateRowsMarkup(item, selectedProductId) {
  const candidates = Array.isArray(item?.candidates) ? item.candidates : [];
  if (!candidates.length) return '<tr><td colspan="6" class="empty-table-cell">현재 상품 기준정보에서 검수 후보를 찾지 못했습니다.</td></tr>';
  return candidates.map(candidate => {
    const candidateId = text(candidate.productId);
    const selected = candidateId && candidateId === text(selectedProductId);
    return `<tr>
      <td><label class="unresolved-candidate-choice">
        <input type="radio" name="unresolvedCandidate" data-unresolved-candidate="${escapeHtml(candidateId)}"
          ${selected ? 'checked' : ''} ${candidate.selectable && candidateId ? '' : 'disabled'}>
        <span>${selected ? '선택됨' : '선택'}</span>
      </label></td>
      <td><span class="unresolved-candidate-basis ${candidate.exactCandidate ? 'is-exact' : ''}">${escapeHtml(candidateBasisLabel(candidate.matchBasis))}</span></td>
      <td>${escapeHtml(displayText(candidate.productCode))}</td>
      <td>${escapeHtml(displayText(candidate.productName))}</td>
      <td>${escapeHtml(displayText(candidate.specification))} · ${escapeHtml(displayText(candidate.unit))}</td>
      <td><strong>자동확정 아님</strong></td>
    </tr>`;
  }).join('');
}

function impactMarkup(impactState = {}) {
  if (impactState.loading) {
    return '<div class="unresolved-impact-state" role="status"><strong>재매칭 영향 계산 중</strong><span>공식자료를 변경하지 않고 영향만 확인합니다.</span></div>';
  }
  if (impactState.error) {
    return '<div class="unresolved-impact-state unresolved-review-state--error" role="alert"><strong>영향 미리보기 실패</strong><span>후보를 다시 선택해 재시도하세요. 공식자료는 변경되지 않았습니다.</span></div>';
  }
  const impact = impactState.result;
  if (!impact) {
    return '<div class="unresolved-impact-state"><strong>후보를 선택하면 영향 미리보기를 표시합니다.</strong><span>선택만으로 재매칭이나 재고 반영은 실행되지 않습니다.</span></div>';
  }
  const status = impactStatusPresentation(impact.status);
  const rows = Array.isArray(impact.impacts) ? impact.impacts : [];
  return `<div class="unresolved-impact-heading" data-impact-status="${escapeHtml(status.status)}">
      <strong>${escapeHtml(status.label)} <small>${escapeHtml(status.status)}</small></strong>
      <span>${escapeHtml(status.detail)} · 읽기 전용 미리보기</span>
    </div>
    <div class="unresolved-impact-summary">
      <span>영향 전표 <strong>${escapeHtml(displayNumber(impact.summary?.affectedDocumentCount))}</strong></span>
      <span>영향 행 <strong>${escapeHtml(displayNumber(impact.summary?.affectedLineCount))}</strong></span>
      <span>입력수량 합계 <strong>${escapeHtml(displayNumber(impact.summary?.inputQuantityTotal))}</strong></span>
      <span>부호수량 합계 <strong>${escapeHtml(displayNumber(impact.summary?.signedQuantityTotal))}</strong></span>
      <span>실사 판단 <strong>${escapeHtml(displayNumber(impact.summary?.decisionRequiredCount))}</strong></span>
      <span>원자료 확인 <strong>${escapeHtml(displayNumber(impact.summary?.reviewRequiredCount))}</strong></span>
    </div>
    <table class="unresolved-detail-table unresolved-impact-table">
      <thead><tr><th>영향 상태</th><th>전표 종류·문서</th><th>행 ID</th><th>창고</th><th>업무일자</th><th>입력수량</th><th>부호수량</th><th>최신 실사 checkpoint</th></tr></thead>
      <tbody>${rows.length ? rows.map(row => {
        const rowStatus = impactStatusPresentation(row.status);
        const source = row.sourceVoucher || {};
        const checkpoint = row.checkpoint || null;
        return `<tr>
          <td><span class="unresolved-impact-label" data-tone="${escapeHtml(rowStatus.tone)}">${escapeHtml(rowStatus.label)}<br><small>${escapeHtml(rowStatus.status)}</small></span></td>
          <td>${escapeHtml(voucherModeLabel(source.voucherMode))}<br><span class="unresolved-id-wrap">${escapeHtml(displayText(source.documentId))}</span></td>
          <td><span class="unresolved-id-wrap">${escapeHtml(displayText(source.lineId))}</span></td>
          <td>${escapeHtml(displayText(row.warehouseId))}</td>
          <td>${escapeHtml(displayText(row.businessDate))}</td>
          <td class="number">${escapeHtml(displayNumber(row.inputQuantity))}</td>
          <td class="number">${escapeHtml(displayNumber(row.signedQuantity))}</td>
          <td>${checkpoint ? `${escapeHtml(displayText(checkpoint.effectiveAt || checkpoint.businessDate))}<br><span class="unresolved-id-wrap">${escapeHtml(displayText(checkpoint.checkpointId))}</span>` : '해당 없음'}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="8" class="empty-table-cell">영향 근거를 확인할 수 없습니다.</td></tr>'}</tbody>
    </table>
    <p class="unresolved-readonly-note">이 화면은 검수와 영향 확인만 제공합니다. 재매칭 command·확정·적용·공식재고 쓰기는 실행하지 않습니다.</p>`;
}

export function renderUnresolvedDetail({ item, selectedProductId = '', impactState = {} } = {}) {
  if (!item) return renderUnresolvedError();
  const title = [item.originalProductCode, item.originalProductName].filter(text).join(' · ') || '코드·품명 확인 필요';
  return `<div class="unresolved-detail" data-unresolved-detail-id="${escapeHtml(item.unresolvedProductId)}">
    <div class="unresolved-detail-toolbar">
      <button class="table-tool-button" type="button" data-unresolved-list>← 목록으로</button>
      <div><strong>${escapeHtml(title)}</strong><span>${integrityMarkup(item)}</span></div>
    </div>
    <div class="unresolved-detail-summary">
      <span>규격 <strong>${escapeHtml(displayText(item.specification))}</strong></span>
      <span>단위 <strong>${escapeHtml(displayText(item.unit))}</strong></span>
      <span>원전표 <strong>${escapeHtml(displayNumber(item.aggregate?.documentCount))}</strong></span>
      <span>원전표 행 <strong>${escapeHtml(displayNumber(item.aggregate?.lineCount))}</strong></span>
      <span>공식재고 <strong class="unresolved-official-null">— · 미반영</strong></span>
      <span>미반영 부호수량 <strong>${escapeHtml(displayNumber(item.officialInventory?.unappliedSignedQuantity))}</strong></span>
    </div>
    <h3 class="unresolved-section-title">원전표 추적</h3>
    <div class="unresolved-table-scroll">
      <table class="unresolved-detail-table">
        <thead><tr><th>확정 상품코드</th><th>확정 품명</th><th>규격</th><th>단위</th><th>창고</th><th>업무일자</th><th>입력수량</th><th>구매·판매 부호수량</th><th>공식재고</th><th>미반영 부호수량</th><th>전표 종류·문서 ID</th><th>행 ID</th><th>문서 Revision·Revision ID</th><th>추적 링크</th></tr></thead>
        <tbody>${sourceRowsMarkup(item)}</tbody>
      </table>
    </div>
    <h3 class="unresolved-section-title">재매칭 후보 선택 <span>모두 검수 참고 · 자동확정 아님</span></h3>
    <div class="unresolved-table-scroll">
      <table class="unresolved-detail-table unresolved-candidate-table">
        <thead><tr><th>선택</th><th>후보 구분</th><th>상품코드</th><th>품명</th><th>규격·단위</th><th>확정 상태</th></tr></thead>
        <tbody>${candidateRowsMarkup(item, selectedProductId)}</tbody>
      </table>
    </div>
    <h3 class="unresolved-section-title">재매칭 영향 미리보기</h3>
    <div class="unresolved-impact" id="unresolvedImpactPreview">${impactMarkup(impactState)}</div>
  </div>`;
}
