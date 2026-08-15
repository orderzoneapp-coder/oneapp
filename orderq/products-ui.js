import { loadProductCatalog } from './product-master-search.js?v=0.8.0';
import { searchLineProducts } from './product-line-common.js?v=0.8.0-m7';
import {
  createQuickProduct,
  linkQuickProductToMaster,
  listQuickProducts,
  loadQuickProduct,
  unlinkQuickProductFromMaster
} from './quick-product-repository.js?v=0.8.0-m7';
import { isTemporaryProductId } from './quick-product.js?v=0.8.0-m7';

const ACTOR = 'ADMIN';
const listElement = document.querySelector('#quickProductList');
const detailElement = document.querySelector('#quickProductDetail');
const messageElement = document.querySelector('#message');
const summaryElement = document.querySelector('#summaryText');

let rows = [];
let selectedProductId = '';
let selectedMaster = null;
let masterCatalog = [];

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function setMessage(value = '', type = '') {
  messageElement.textContent = value;
  messageElement.className = `product-message ${type}`.trim();
}

function eventLabel(value) {
  return ({
    QUICK_PRODUCT_CREATED: '임시상품 등록',
    QUICK_PRODUCT_MASTER_LINKED: '정식 마스터 연결',
    QUICK_PRODUCT_MASTER_UNLINKED: '정식 마스터 연결 해제'
  })[value] || value;
}

function renderList() {
  summaryElement.textContent = `${rows.length}건`;
  listElement.innerHTML = rows.length ? rows.map(product => `
    <button class="product-card ${product.productId === selectedProductId ? 'selected' : ''}" type="button" data-product-id="${esc(product.productId)}">
      <strong>${esc(product.itemName)} <span class="product-status ${product.registrationStatus === 'LINKED' ? 'linked' : ''}">${esc(product.registrationStatus)}</span></strong>
      <small>${esc(product.itemCode || '코드 없음')} · ${esc(product.productId)} · rev.${Number(product.revision || 0)}</small>
      ${product.masterProductId ? `<small>연결: ${esc(product.masterItemName || product.masterProductId)}</small>` : ''}
    </button>`).join('') : '<div class="empty-state">등록된 임시상품이 없습니다.</div>';
}

function renderMasterResults(query = '') {
  const element = detailElement.querySelector('#masterResults');
  if (!element) return;
  const source = text(query)
    ? searchLineProducts(query, masterCatalog, 8)
    : masterCatalog.slice(0, 8);
  element.innerHTML = source.length ? source.map(product => `
    <button class="master-result ${selectedMaster?.productId === product.productId ? 'selected' : ''}" type="button" data-master-id="${esc(product.productId)}">
      <strong>${esc(product.itemName || product.itemCode)}</strong><br>
      <small>${esc(product.itemCode)} · ${esc(product.productId)} · ${esc(product.specification)}</small>
    </button>`).join('') : '<div class="empty-state">연결 가능한 정식 상품이 없습니다.</div>';
}

function renderDetail(record) {
  const { product, events } = record;
  const linked = product.registrationStatus === 'LINKED';
  detailElement.innerHTML = `
    <div class="product-form" data-testid="quick-product-detail" data-product-id="${esc(product.productId)}" data-revision="${Number(product.revision || 0)}">
      <div class="product-title">
        <div><h2>${esc(product.itemName)}</h2><p>${esc(product.itemCode || '코드 없음')} · ${esc(product.productId)}</p></div>
        <span class="product-status ${linked ? 'linked' : ''}">${esc(product.registrationStatus)}</span>
      </div>
      <div class="product-summary">
        <div><small>규격</small><strong>${esc(product.specification || '-')}</strong></div>
        <div><small>단위 / 입수</small><strong>${esc(product.finalUnit || '-')} / ${product.boxQuantity ?? '-'}</strong></div>
        <div><small>현재 연결</small><strong>${esc(product.masterItemName || product.masterProductId || '미연결')}</strong></div>
      </div>
      ${linked ? `
        <section>
          <h3>마스터 연결 해제</h3>
          <label>해제 사유<input id="unlinkReason" autocomplete="off" placeholder="필수"></label>
          <div class="product-actions"><button class="product-btn danger" data-action="unlink" type="button">연결 해제</button></div>
        </section>` : `
        <section>
          <h3>정식 상품 마스터 연결</h3>
          <label>상품 검색<input id="masterQuery" type="search" autocomplete="off" placeholder="상품코드 또는 상품명"></label>
          <div id="masterResults" class="master-results"></div>
          <label>연결 사유<input id="linkReason" autocomplete="off" placeholder="필수"></label>
          <div class="product-actions"><button class="product-btn primary" data-action="link" type="button">선택 마스터 연결</button></div>
        </section>`}
      <section>
        <h3>변경 이력</h3>
        <ol class="history-list" data-testid="quick-product-history">${events.map(event => `
          <li data-event-type="${esc(event.eventType)}">
            <strong>${esc(eventLabel(event.eventType))} · rev.${Number(event.revision || 0)}</strong>
            <span>${esc(event.actorId)} · ${esc(event.createdAt)} · ${esc(event.reason)}</span>
            ${event.masterProductId ? `<span>마스터: ${esc(event.masterProductId)}</span>` : ''}
          </li>`).join('')}</ol>
      </section>
    </div>`;
  if (!linked) renderMasterResults('');
}

async function refresh(preferredId = selectedProductId) {
  const [quickProducts, catalogResult] = await Promise.all([listQuickProducts(), loadProductCatalog()]);
  rows = quickProducts;
  masterCatalog = catalogResult.products.filter(product => !isTemporaryProductId(product.productId)
    && product.productIdentityType !== 'TEMPORARY');
  selectedProductId = rows.some(row => row.productId === preferredId) ? preferredId : (rows[0]?.productId || '');
  selectedMaster = null;
  renderList();
  if (selectedProductId) renderDetail(await loadQuickProduct(selectedProductId));
  else detailElement.innerHTML = '<div class="empty-state">임시상품을 등록하거나 왼쪽 목록에서 선택하세요.</div>';
}

document.querySelector('#createForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setMessage('');
  try {
    const result = await createQuickProduct({
      itemName: document.querySelector('#quickItemName').value,
      itemCode: document.querySelector('#quickItemCode').value,
      specification: document.querySelector('#quickSpecification').value,
      finalUnit: document.querySelector('#quickUnit').value,
      boxQuantity: document.querySelector('#quickBoxQuantity').value,
      memo: document.querySelector('#quickMemo').value,
      reason: 'QUICK_PRODUCT_CREATED_BY_UI'
    }, ACTOR);
    form.reset();
    await refresh(result.product.productId);
    setMessage(`${result.product.itemName} 임시상품을 등록했습니다.`, 'success');
  } catch (error) {
    setMessage(error.message || String(error), 'error');
  }
});

listElement.addEventListener('click', async event => {
  const button = event.target.closest('[data-product-id]');
  if (!button) return;
  selectedProductId = button.dataset.productId;
  selectedMaster = null;
  renderList();
  renderDetail(await loadQuickProduct(selectedProductId));
});

detailElement.addEventListener('input', event => {
  if (event.target.id !== 'masterQuery') return;
  selectedMaster = null;
  renderMasterResults(event.target.value);
});

detailElement.addEventListener('click', async event => {
  const masterButton = event.target.closest('[data-master-id]');
  if (masterButton) {
    selectedMaster = masterCatalog.find(product => product.productId === masterButton.dataset.masterId) || null;
    renderMasterResults(detailElement.querySelector('#masterQuery')?.value || '');
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  setMessage('');
  try {
    const record = await loadQuickProduct(selectedProductId);
    if (action === 'link') {
      if (!selectedMaster) throw new Error('연결할 정식 상품을 선택하세요.');
      await linkQuickProductToMaster({
        quickProductId: selectedProductId,
        expectedRevision: record.product.revision,
        masterProduct: selectedMaster,
        reason: detailElement.querySelector('#linkReason')?.value
      }, ACTOR);
      await refresh(selectedProductId);
      setMessage('정식 상품 마스터를 연결했습니다. 기존 거래의 상품 ID는 변경하지 않았습니다.', 'success');
    }
    if (action === 'unlink') {
      await unlinkQuickProductFromMaster({
        quickProductId: selectedProductId,
        expectedRevision: record.product.revision,
        reason: detailElement.querySelector('#unlinkReason')?.value
      }, ACTOR);
      await refresh(selectedProductId);
      setMessage('마스터 연결을 해제했습니다. 변경 이력은 유지됩니다.', 'success');
    }
  } catch (error) {
    setMessage(error.message || String(error), 'error');
  }
});

document.querySelector('#refreshBtn').addEventListener('click', () => refresh().catch(error => setMessage(error.message || String(error), 'error')));

refresh().catch(error => setMessage(error.message || String(error), 'error'));
