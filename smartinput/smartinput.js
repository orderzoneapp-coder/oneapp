import {
  captureTextIntake,
  analyzeSingleOrderDocument,
  rematchExtractedLinesForCustomer
} from '../orderq/intake-engine.js?v=0.12.1';
import { createOrder } from '../orderq/order-intake-engine.js?v=0.15.0';
import { syncAfterLocalMutation } from '../orderq/orderq-sync-engine.js?v=0.8.0';
import { STORE, getAll } from '../orderq/orderq-db.js?v=0.12.1';
import { createLiveCustomer, ensureCustomerMasterReady, searchCustomers } from '../orderq/customer-master.js?v=0.12.1';
import { loadProductCatalog, searchProductCatalog } from '../orderq/product-master-search.js?v=0.8.0';
import { loadWarehouseCatalog, matchWarehouseInput, warehouseDisplayName } from '../orderq/warehouse-master.js?v=0.8.0';
import {
  createRecordId,
  loadSmartInputData,
  normalizeAliasName,
  saveAliasMapping,
  saveLinkGroup,
  saveSettings,
  saveTemporaryCustomer
} from './smartinput-data-store.js?v=0.1.0';

const contract = window.SMART_INPUT_CONTRACT;
if (!contract) throw new Error('SMART_INPUT_CONTRACT_NOT_LOADED');

const $ = id => document.getElementById(id);
const tabs = [...document.querySelectorAll('[data-mode]')];
const methodButtons = [...document.querySelectorAll('[data-method]')];
const sourceTextInput = $('sourceTextInput');
const inputRows = $('inputRows');
const state = {
  draft: loadDraft(),
  customers: [],
  products: [],
  catalogStatus: 'LOADING',
  catalogSummary: { commonCount: 0, orderQCount: 0, errors: [] },
  warehouseCatalog: { warehouses: [], aliases: [] },
  settings: contract.normalizeSettings(),
  linkGroups: [],
  temporaryCustomers: [],
  aliasMappings: [],
  smartDataReady: false,
  pendingImageEvidence: null,
  pendingSourceName: '',
  saveTimer: null,
  toastTimer: null,
  recognition: null,
  listening: false,
  busy: false
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function loadDraft() {
  try {
    return contract.normalizeDraft(JSON.parse(localStorage.getItem(contract.DRAFT_STORAGE_KEY) || 'null'));
  } catch (_) {
    return contract.createDraft();
  }
}

function loadDraftList() {
  try {
    const rows = JSON.parse(localStorage.getItem(contract.DRAFT_LIST_STORAGE_KEY) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
}

function saveModeDraftSnapshot() {
  const current = modeDraft();
  if (!current?.documentId) return;
  const previous = loadDraftList();
  const snapshot = JSON.parse(JSON.stringify({ ...current, mode: state.draft.activeMode, parentDraftId: state.draft.draftId }));
  const next = [snapshot, ...previous.filter(item => item.documentId !== current.documentId)]
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, 30);
  localStorage.setItem(contract.DRAFT_LIST_STORAGE_KEY, JSON.stringify(next));
}

function modeDraft() {
  return state.draft.modes[state.draft.activeMode];
}

function modeUi() {
  state.draft.ui.modes ||= {};
  state.draft.ui.modes[state.draft.activeMode] ||= { scrollTop: 0, scrollLeft: 0, activeCellId: '' };
  return state.draft.ui.modes[state.draft.activeMode];
}

function setAppStatus(message, tone = 'normal') {
  $('appStatus').dataset.tone = tone;
  $('appStatus').querySelector('span:last-child').textContent = message;
}

function toast(message, tone = 'normal') {
  const element = $('toast');
  element.textContent = message;
  element.dataset.tone = tone;
  element.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => { element.hidden = true; }, 3800);
}

function saveDraftNow() {
  clearTimeout(state.saveTimer);
  state.draft.updatedAt = new Date().toISOString();
  modeDraft().updatedAt = state.draft.updatedAt;
  try {
    localStorage.setItem(contract.DRAFT_STORAGE_KEY, JSON.stringify(state.draft));
    saveModeDraftSnapshot();
    $('saveState').textContent = '초안 저장됨';
  } catch (_) {
    $('saveState').textContent = '초안 저장 실패';
    setAppStatus('초안을 저장하지 못했습니다. 입력 내용은 현재 화면에 유지됩니다.', 'warn');
  }
}

function scheduleSave() {
  $('saveState').textContent = '저장 중…';
  clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(saveDraftNow, 160);
}

function appendDeliveryHistory(record) {
  try {
    const previous = JSON.parse(localStorage.getItem(contract.DELIVERY_HISTORY_KEY) || '[]');
    const history = Array.isArray(previous) ? previous : [];
    const withoutDuplicate = history.filter(item => item.targetRecordId !== record.targetRecordId);
    localStorage.setItem(contract.DELIVERY_HISTORY_KEY, JSON.stringify([record, ...withoutDuplicate].slice(0, 30)));
  } catch (_) {}
}

function resizeSource() {
  sourceTextInput.style.height = 'auto';
  sourceTextInput.style.height = `${Math.min(300, Math.max(84, sourceTextInput.scrollHeight))}px`;
  $('sourceLength').textContent = `${sourceTextInput.value.length.toLocaleString('ko-KR')}자`;
}

function updateMethod(method) {
  const selected = contract.INPUT_METHODS.find(item => item.id === method) || contract.INPUT_METHODS[2];
  modeDraft().activeMethod = selected.id;
  methodButtons.forEach(button => button.classList.toggle('is-active', button.dataset.method === selected.id));
  $('methodStatus').textContent = selected.label;
  scheduleSave();
  return selected;
}

function customerName(customer) {
  return String(customer?.customerName || customer?.name || '').trim();
}

function customerCode(customer) {
  return String(customer?.customerCode || customer?.erpCustomerCode || '').trim();
}

function normalizedKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s()[\]{}<>,.:;·_-]+/g, '');
}

function extractOrdererName(rawText) {
  const lines = String(rawText || '').replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/^[-•·*]+\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const bracketed = lines.map(line => line.match(/^\[([^\]]+)\]/)?.[1]?.trim()).find(Boolean);
  if (bracketed) return bracketed;
  return lines.find(line => !/\d+(?:\.\d+)?\s*(개|박스|box|kg|g|판|봉|팩|ea|세트)?\s*$/i.test(line)) || lines[0] || '';
}

function aliasContextKey(sourceType = '') {
  return `SMART_INPUT|${String(sourceType || 'GENERAL_TEXT').toUpperCase()}`;
}

function temporaryMeta(customerId) {
  return state.temporaryCustomers.find(item => item.customerId === customerId && item.status !== 'INACTIVE') || null;
}

function groupForCustomer(customerId) {
  return state.linkGroups.find(group => group.status !== 'INACTIVE' && group.memberCustomerIds?.includes(customerId)) || null;
}

function customerById(customerId) {
  return state.customers.find(customer => customer.customerId === customerId) || null;
}

function applyCustomerRelationship(header = modeDraft().header) {
  const group = groupForCustomer(header.customerId);
  const taxCustomer = group?.taxCustomerId ? customerById(group.taxCustomerId) : null;
  header.customerLinkGroupId = group?.linkGroupId || '';
  header.taxCustomerId = taxCustomer?.customerId || '';
  header.taxCustomerName = customerName(taxCustomer);
  header.isTemporaryCustomer = Boolean(temporaryMeta(header.customerId));
  $('taxCustomerInput').value = header.taxCustomerName;
  $('customerRelationHint').textContent = group
    ? (taxCustomer ? `연결 ${group.memberCustomerIds.length}곳 · 세무 1개 지정` : `연결 ${group.memberCustomerIds.length}곳 · 세무 거래처 지정 필요`)
    : '연결되지 않은 배송 거래처입니다.';
  $('customerRelationHint').dataset.tone = group && !taxCustomer ? 'warn' : '';
}

function effectiveAliasMappings(rawOrdererName, sourceType) {
  const normalizedName = normalizeAliasName(rawOrdererName);
  if (!normalizedName) return [];
  const confirmed = state.aliasMappings.filter(mapping => mapping.status === 'CONFIRMED' && mapping.normalizedName === normalizedName);
  const exactContext = confirmed.filter(mapping => mapping.contextKey === aliasContextKey(sourceType));
  return exactContext.length ? exactContext : confirmed;
}

function resolveAliasCustomer(rawOrdererName, sourceType) {
  const mappings = effectiveAliasMappings(rawOrdererName, sourceType);
  const customerIds = [...new Set(mappings.map(mapping => mapping.deliveryCustomerId).filter(Boolean))];
  if (customerIds.length !== 1) return null;
  const customer = customerById(customerIds[0]);
  if (!customer) return null;
  return { customer, mapping: mappings.find(item => item.deliveryCustomerId === customer.customerId) };
}

async function confirmCustomerAlias(rawOrdererName, customer, sourceType = 'GENERAL_TEXT') {
  const normalizedName = normalizeAliasName(rawOrdererName);
  if (!normalizedName || !customer?.customerId) return null;
  const contextKey = aliasContextKey(sourceType);
  const timestamp = new Date().toISOString();
  const existing = state.aliasMappings.find(mapping => mapping.normalizedName === normalizedName && mapping.contextKey === contextKey);
  const mapping = {
    aliasMappingId: existing?.aliasMappingId || createRecordId('SIALIAS'),
    rawOrdererName: String(rawOrdererName).trim(),
    normalizedName,
    sourceType,
    contextKey,
    deliveryCustomerId: customer.customerId,
    status: 'CONFIRMED',
    confirmedBy: 'SMART_INPUT_ADMIN',
    confirmedAt: existing?.confirmedAt || timestamp,
    useCount: Number(existing?.useCount || 0) + 1,
    lastUsedAt: timestamp,
    updatedAt: timestamp
  };
  await saveAliasMapping(mapping);
  const index = state.aliasMappings.findIndex(item => item.aliasMappingId === mapping.aliasMappingId);
  if (index >= 0) state.aliasMappings[index] = mapping;
  else state.aliasMappings.push(mapping);
  modeDraft().header.aliasMappingId = mapping.aliasMappingId;
  modeDraft().header.customerMappingSource = 'MANUAL_CONFIRMED_ALIAS';
  return mapping;
}

function updateDeliveryPolicy({ force = false } = {}) {
  const header = modeDraft().header;
  if (!header.orderDate) return;
  if (force || !header.manualDeliveryOverride || !header.deliveryDate) {
    const next = contract.nextDeliveryDate({
      orderDate: header.orderDate,
      customerId: header.customerId,
      settings: state.settings
    });
    if (next.date) header.deliveryDate = next.date;
  }
  $('deliveryDateInput').value = header.deliveryDate;
  const decision = contract.validateDeliveryDate({
    deliveryDate: header.deliveryDate,
    orderDate: header.orderDate,
    customerId: header.customerId,
    settings: state.settings
  });
  const weekdays = contract.deliveryWeekdayLabel(state.settings, header.customerId);
  const cutoff = state.settings.orderCutoffTime ? ` · 당일 마감 ${state.settings.orderCutoffTime}` : '';
  const nextAvailable = decision.valid ? null : contract.nextDeliveryDate({
    orderDate: header.orderDate,
    customerId: header.customerId,
    settings: state.settings
  });
  const nextMessage = nextAvailable?.date ? ` 다음 가능일은 ${nextAvailable.date}입니다.` : ' 다음 가능일을 찾지 못했습니다.';
  $('deliveryPolicyHint').textContent = decision.valid ? `배송 ${weekdays}요일${cutoff}` : `${decision.message}${nextMessage}`;
  $('deliveryPolicyHint').dataset.tone = decision.valid ? '' : 'error';
  header.deliveryPolicySnapshot = {
    orderCutoffTime: state.settings.orderCutoffTime,
    allowSameDayDelivery: state.settings.allowSameDayDelivery,
    deliveryWeekdays: contract.effectiveDeliveryWeekdays(state.settings, header.customerId),
    holidayWeekdays: [...state.settings.holidayWeekdays],
    holidayDates: [...state.settings.holidayDates],
    timezone: state.settings.timezone,
    evaluatedAt: new Date().toISOString(),
    validationCode: decision.code
  };
  return decision;
}

function applyCustomer(customer, { rematch = true, mappingSource = 'MANUAL', learnAlias = true } = {}) {
  if (!customer) return;
  if (customer.customerId && !state.customers.some(item => item.customerId === customer.customerId)) state.customers.push(customer);
  const header = modeDraft().header;
  header.customerId = String(customer.customerId || '').trim();
  header.customerName = customerName(customer);
  header.customerMappingSource = mappingSource;
  $('customerInput').value = header.customerName;
  $('customerInput').dataset.customerId = header.customerId;
  $('customerHint').textContent = `${customerCode(customer) || (temporaryMeta(header.customerId) ? '임시 배송처' : '등록 거래처')} · ${mappingSource === 'CONFIRMED_ALIAS' ? '주문자명 자동 지정' : '마스터 연결됨'}`;
  applyCustomerRelationship(header);
  updateDeliveryPolicy();
  scheduleSave();
  if (learnAlias && header.rawOrdererName) {
    void confirmCustomerAlias(header.rawOrdererName, customer, currentSourceType())
      .then(() => { $('customerHint').textContent = `${customerCode(customer) || '등록 거래처'} · 다음 동일 주문자명 자동 지정`; saveDraftNow(); })
      .catch(() => toast('거래처는 선택했지만 주문자명 매핑은 저장하지 못했습니다.', 'error'));
  }
  if (rematch && state.draft.activeMode === 'order' && modeDraft().rows.length) rematchRowsForCustomer(customer);
}

function inferCustomer(rawText) {
  const candidates = String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/^[-•·*]+\s*/, '').replace(/^\[([^\]]+)\].*$/, '$1').trim())
    .filter(Boolean)
    .slice(0, 6);
  for (const candidate of candidates) {
    const key = normalizedKey(candidate);
    const found = state.customers.find(customer => normalizedKey(customerName(customer)) === key
      || (customerCode(customer) && normalizedKey(customerCode(customer)) === key));
    if (found) return found;
  }
  return null;
}

function currentSourceType() {
  return contract.INPUT_METHODS.find(method => method.id === modeDraft().activeMethod)?.sourceType || 'GENERAL_TEXT';
}

async function refreshCustomers() {
  await ensureCustomerMasterReady();
  state.customers = (await getAll(STORE.CUSTOMERS)).filter(customer => (customer.status || 'ACTIVE') === 'ACTIVE');
}

function customerSearchText(customer) {
  return [customerName(customer), customerCode(customer), customer.address, customer.businessNumber, customer.searchText]
    .filter(Boolean).join(' ');
}

async function registerCustomerProfile({ temporary = false } = {}) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'smart-dialog smart-dialog--compact';
    dialog.innerHTML = `<form method="dialog" class="smart-dialog__shell">
      <header><div><small>${temporary ? 'Temporary Delivery' : 'Tax Customer'}</small><h2>${temporary ? '임시 배송처 등록' : '세무 거래처 등록'}</h2></div><button type="button" data-cancel aria-label="닫기">×</button></header>
      <div class="smart-form">
        <label><span>거래처명 <em>필수</em></span><input name="customerName" autocomplete="organization"></label>
        ${temporary ? '<label><span>창고·지점명</span><input name="warehouseName"></label>' : '<label><span>사업자등록번호</span><input name="businessNumber" inputmode="numeric"></label><label><span>대표자명</span><input name="representativeName"></label>'}
        <label class="smart-form--wide"><span>주소</span><input name="address" autocomplete="street-address"></label>
        <label><span>연락처</span><input name="contactPhone" inputmode="tel"></label>
      </div>
      <p class="smart-dialog__message">${temporary ? '주문·배송에만 사용하며 세무 거래처로 지정할 수 없습니다.' : '결제·세금계산서를 관리할 공식 거래처만 등록하세요.'}</p>
      <footer><button type="button" class="button button--quiet" data-cancel>취소</button><button type="button" class="button button--primary" data-save>${temporary ? '임시 등록' : '세무 등록'}</button></footer>
    </form>`;
    document.body.append(dialog);
    const message = dialog.querySelector('.smart-dialog__message');
    const finish = customer => {
      resolve(customer || null);
      dialog.close();
      dialog.remove();
    };
    dialog.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', () => finish(null)));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.querySelector('[data-save]').addEventListener('click', async () => {
      const form = new FormData(dialog.querySelector('form'));
      const customerNameValue = String(form.get('customerName') || '').trim();
      if (!customerNameValue) {
        message.textContent = '거래처명을 입력하세요.';
        return;
      }
      try {
        const customer = await createLiveCustomer({
          customerName: customerNameValue,
          businessNumber: String(form.get('businessNumber') || '').trim(),
          representativeName: String(form.get('representativeName') || '').trim(),
          address: String(form.get('address') || '').trim(),
          contactPhone: String(form.get('contactPhone') || '').trim(),
          memo: temporary ? `임시 배송처 · ${String(form.get('warehouseName') || '').trim()}` : '세무 거래처'
        }, { source: temporary ? 'SMART_INPUT_TEMPORARY_DELIVERY' : 'SMART_INPUT_TAX_CUSTOMER' });
        if (temporary) {
          const metadata = {
            customerId: customer.customerId,
            warehouseName: String(form.get('warehouseName') || '').trim(),
            address: String(form.get('address') || '').trim(),
            contact: String(form.get('contactPhone') || '').trim(),
            linkGroupId: '',
            status: 'TEMPORARY',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          await saveTemporaryCustomer(metadata);
          state.temporaryCustomers.push(metadata);
        }
        state.customers.push(customer);
        finish(customer);
      } catch (error) {
        message.textContent = error.code === 'CUSTOMER_DUPLICATE_CANDIDATE'
          ? '유사하거나 같은 거래처가 있습니다. 신규 등록 대신 기존 거래처를 선택하세요.'
          : (error.message || '거래처를 등록하지 못했습니다.');
      }
    });
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      dialog.querySelector('[data-save]').click();
    });
    dialog.showModal();
    dialog.querySelector('[name="customerName"]').focus();
  });
}

async function persistLinkGroup(group) {
  await saveLinkGroup(group);
  const index = state.linkGroups.findIndex(item => item.linkGroupId === group.linkGroupId);
  if (index >= 0) state.linkGroups[index] = group;
  else state.linkGroups.push(group);
  for (const customerId of group.memberCustomerIds) {
    const metadata = temporaryMeta(customerId);
    if (!metadata || metadata.linkGroupId === group.linkGroupId) continue;
    const next = { ...metadata, linkGroupId: group.linkGroupId, updatedAt: new Date().toISOString() };
    await saveTemporaryCustomer(next);
    state.temporaryCustomers[state.temporaryCustomers.findIndex(item => item.customerId === customerId)] = next;
  }
  applyCustomerRelationship();
  saveDraftNow();
}

async function chooseCustomer() {
  try {
    await refreshCustomers();
    const customer = await new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'smart-dialog smart-customer-dialog';
      dialog.innerHTML = `<div class="smart-dialog__shell">
        <header><div><small>Customer Master</small><h2>스마트입력 거래처 찾기</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
        <div class="smart-dialog__toolbar"><button type="button" class="button button--quiet" data-link-mode>연결</button><button type="button" class="button button--quiet" data-temp-create>임시 배송처</button><button type="button" class="button button--quiet" data-tax-create>세무 거래처 등록</button></div>
        <label class="smart-dialog__search">거래처명 또는 코드<input type="search" value="${esc($('customerInput').value)}" autocomplete="off"></label>
        <div class="smart-dialog__message">거래처를 선택하세요.</div>
        <div class="smart-customer-results"></div>
        <footer class="smart-link-footer" hidden><span>연결할 거래처를 2개 이상 체크하세요.</span><button type="button" class="button button--quiet" data-link-cancel>취소</button><button type="button" class="button button--primary" data-link-save>연결 저장</button></footer>
      </div>`;
      document.body.append(dialog);
      const input = dialog.querySelector('input[type="search"]');
      const results = dialog.querySelector('.smart-customer-results');
      const message = dialog.querySelector('.smart-dialog__message');
      const footer = dialog.querySelector('.smart-link-footer');
      const selected = new Set();
      let linkMode = false;
      let visibleCustomers = [];
      const finish = value => {
        resolve(value || null);
        dialog.close();
        dialog.remove();
      };
      const render = async () => {
        const query = input.value.trim();
        if (query) {
          const matched = await searchCustomers(query, { includeInactive: false });
          visibleCustomers = matched.map(item => item.customer);
        } else {
          visibleCustomers = [...state.customers]
            .sort((left, right) => customerName(left).localeCompare(customerName(right), 'ko'))
            .slice(0, 80);
        }
        results.innerHTML = visibleCustomers.map(customerItem => {
          const group = groupForCustomer(customerItem.customerId);
          const isTax = group?.taxCustomerId === customerItem.customerId;
          const isTemporary = Boolean(temporaryMeta(customerItem.customerId));
          return `<article class="smart-customer-row" data-customer-id="${esc(customerItem.customerId)}">
            <label class="smart-customer-check" ${linkMode ? '' : 'hidden'}><input type="checkbox" ${selected.has(customerItem.customerId) ? 'checked' : ''}><span class="sr-only">${esc(customerName(customerItem))} 연결 선택</span></label>
            <button type="button" class="smart-customer-select" ${linkMode ? 'disabled' : ''}><strong>${esc(customerName(customerItem))}</strong><span>${esc(customerCode(customerItem) || customerItem.businessNumber || '')}</span><small>${esc(customerItem.address || temporaryMeta(customerItem.customerId)?.warehouseName || '')}</small></button>
            <div class="smart-customer-badges">${isTemporary ? '<span class="is-temp">임시 배송처</span>' : ''}${group ? `<span>연결 ${group.memberCustomerIds.length}</span>` : ''}${isTax ? '<span class="is-tax">세무</span>' : ''}</div>
            ${group && !isTemporary ? `<button type="button" class="button button--small ${isTax ? 'button--primary' : 'button--quiet'}" data-tax-customer="${esc(customerItem.customerId)}">${isTax ? '세무 지정됨' : '세무 지정'}</button>` : ''}
          </article>`;
        }).join('') || '<div class="smart-dialog__empty">일치하는 거래처가 없습니다.</div>';
        results.querySelectorAll('.smart-customer-row').forEach(row => {
          const customerId = row.dataset.customerId;
          row.querySelector('.smart-customer-select')?.addEventListener('click', () => finish(customerById(customerId)));
          row.querySelector('input[type="checkbox"]')?.addEventListener('change', event => {
            if (event.target.checked) selected.add(customerId); else selected.delete(customerId);
          });
          row.querySelector('[data-tax-customer]')?.addEventListener('click', async () => {
            const group = groupForCustomer(customerId);
            if (!group) return;
            const next = { ...group, taxCustomerId: customerId, status: 'CONFIRMED', revision: Number(group.revision || 0) + 1, updatedAt: new Date().toISOString() };
            await persistLinkGroup(next);
            message.textContent = `${customerName(customerById(customerId))}을 세무 거래처로 지정했습니다.`;
            render();
          });
        });
        message.textContent = linkMode ? `${selected.size}개 선택 · 연결 후 세무 거래처 1개를 지정하세요.` : `${visibleCustomers.length}개 거래처를 확인하세요.`;
      };
      const setLinkMode = value => {
        linkMode = value;
        selected.clear();
        footer.hidden = !linkMode;
        dialog.querySelector('[data-link-mode]').classList.toggle('button--primary', linkMode);
        render();
      };
      dialog.querySelector('[data-close]').addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      dialog.querySelector('[data-link-mode]').addEventListener('click', () => setLinkMode(!linkMode));
      dialog.querySelector('[data-link-cancel]').addEventListener('click', () => setLinkMode(false));
      dialog.querySelector('[data-link-save]').addEventListener('click', async () => {
        if (selected.size < 2) {
          message.textContent = '연결할 거래처를 2개 이상 선택하세요.';
          return;
        }
        const groupIds = [...new Set([...selected].map(id => groupForCustomer(id)?.linkGroupId).filter(Boolean))];
        if (groupIds.length > 1) {
          message.textContent = '서로 다른 연결 그룹은 한 번에 합칠 수 없습니다. 그룹별로 처리하세요.';
          return;
        }
        const existing = groupIds.length ? state.linkGroups.find(group => group.linkGroupId === groupIds[0]) : null;
        const memberCustomerIds = [...new Set([...(existing?.memberCustomerIds || []), ...selected])];
        const timestamp = new Date().toISOString();
        const group = {
          linkGroupId: existing?.linkGroupId || createRecordId('SILINK'),
          memberCustomerIds,
          taxCustomerId: existing?.taxCustomerId && memberCustomerIds.includes(existing.taxCustomerId) ? existing.taxCustomerId : '',
          status: existing?.taxCustomerId ? 'CONFIRMED' : 'PENDING',
          revision: Number(existing?.revision || 0) + 1,
          createdAt: existing?.createdAt || timestamp,
          updatedAt: timestamp,
          updatedBy: 'SMART_INPUT_ADMIN'
        };
        await persistLinkGroup(group);
        selected.clear();
        linkMode = false;
        footer.hidden = true;
        message.textContent = '연결을 저장했습니다. 연결된 거래처 중 세무 거래처 1개를 지정하세요.';
        render();
      });
      dialog.querySelector('[data-temp-create]').addEventListener('click', async () => {
        const created = await registerCustomerProfile({ temporary: true });
        if (!created) return;
        if (linkMode) selected.add(created.customerId);
        input.value = created.customerName;
        render();
      });
      dialog.querySelector('[data-tax-create]').addEventListener('click', async () => {
        const created = await registerCustomerProfile({ temporary: false });
        if (!created) return;
        if (linkMode) selected.add(created.customerId);
        input.value = created.customerName;
        render();
      });
      let timer = null;
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 100); });
      dialog.showModal();
      input.focus();
      render();
    });
    if (customer) applyCustomer(customer);
  } catch (error) {
    toast(error.message || '거래처 목록을 열지 못했습니다.', 'error');
  }
}

function weekdayChecks(name, selected = []) {
  return contract.WEEKDAY_LABELS.map((label, day) => `<label class="weekday-check"><input type="checkbox" name="${name}" value="${day}" ${selected.includes(day) ? 'checked' : ''}><span>${label}</span></label>`).join('');
}

function selectedWeekdays(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(input => Number(input.value)).sort((a, b) => a - b);
}

async function openSettingsDialog() {
  const customerId = modeDraft().header.customerId;
  const hasCustomerOverride = customerId && Object.prototype.hasOwnProperty.call(state.settings.deliveryCustomerWeekdays, customerId);
  const customerWeekdays = hasCustomerOverride
    ? state.settings.deliveryCustomerWeekdays[customerId]
    : state.settings.defaultDeliveryWeekdays;
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog smart-settings-dialog';
  dialog.innerHTML = `<form method="dialog" class="smart-dialog__shell">
    <header><div><small>SmartInput Settings</small><h2>배송·입력 설정</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-settings-grid">
      <label><span>당일 주문 마감시간</span><input type="time" name="orderCutoffTime" value="${esc(state.settings.orderCutoffTime)}"><small>미설정이면 마감 제한을 적용하지 않습니다.</small></label>
      <label class="toggle-setting"><input type="checkbox" name="allowSameDayDelivery" ${state.settings.allowSameDayDelivery ? 'checked' : ''}><span>마감시간 전 당일 배송 선택 허용</span></label>
      <fieldset><legend>앱 기본 배송 가능 요일</legend><div class="weekday-grid">${weekdayChecks('defaultDeliveryWeekdays', state.settings.defaultDeliveryWeekdays)}</div></fieldset>
      <fieldset><legend>반복 휴무 요일</legend><div class="weekday-grid">${weekdayChecks('holidayWeekdays', state.settings.holidayWeekdays)}</div></fieldset>
      <label class="smart-settings--wide"><span>지정 휴무일</span><textarea name="holidayDates" rows="3" placeholder="2026-08-24&#10;2026-09-01">${esc(state.settings.holidayDates.join('\n'))}</textarea><small>날짜를 줄바꿈·쉼표로 구분합니다.</small></label>
      <fieldset class="smart-settings--wide" ${customerId ? '' : 'disabled'}><legend>현재 배송처 요일 · ${esc(modeDraft().header.customerName || '거래처 미선택')}</legend>
        <label class="toggle-setting"><input type="checkbox" name="useDefaultCustomerWeekdays" ${hasCustomerOverride ? '' : 'checked'}><span>앱 기본 배송 요일 사용</span></label>
        <div class="weekday-grid" data-customer-weekdays>${weekdayChecks('customerDeliveryWeekdays', customerWeekdays)}</div>
      </fieldset>
    </div>
    <p class="smart-dialog__message">선택 불가 날짜에는 사유와 다음 배송 가능일을 표시합니다.</p>
    <footer><button type="button" class="button button--quiet" data-close>취소</button><button type="button" class="button button--primary" data-save>설정 저장</button></footer>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const message = dialog.querySelector('.smart-dialog__message');
  const defaultToggle = form.elements.useDefaultCustomerWeekdays;
  const customerWeekdaysElement = dialog.querySelector('[data-customer-weekdays]');
  const syncCustomerWeekdaysState = () => {
    customerWeekdaysElement?.querySelectorAll('input').forEach(input => { input.disabled = !customerId || defaultToggle.checked; });
    customerWeekdaysElement?.classList.toggle('is-disabled', !customerId || defaultToggle.checked);
  };
  defaultToggle?.addEventListener('change', syncCustomerWeekdaysState);
  syncCustomerWeekdaysState();
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.querySelector('[data-save]').addEventListener('click', async () => {
    const defaultDeliveryWeekdays = selectedWeekdays(form, 'defaultDeliveryWeekdays');
    if (!defaultDeliveryWeekdays.length) {
      message.textContent = '앱 기본 배송 가능 요일을 1개 이상 선택하세요.';
      return;
    }
    const deliveryCustomerWeekdays = { ...state.settings.deliveryCustomerWeekdays };
    if (customerId) {
      if (defaultToggle.checked) delete deliveryCustomerWeekdays[customerId];
      else {
        const customerDays = selectedWeekdays(form, 'customerDeliveryWeekdays');
        if (!customerDays.length) {
          message.textContent = '현재 배송처의 배송 가능 요일을 1개 이상 선택하세요.';
          return;
        }
        deliveryCustomerWeekdays[customerId] = customerDays;
      }
    }
    const holidayDates = String(form.elements.holidayDates.value || '').split(/[\s,;]+/).map(value => value.trim()).filter(Boolean);
    const next = contract.normalizeSettings({
      ...state.settings,
      orderCutoffTime: form.elements.orderCutoffTime.value,
      allowSameDayDelivery: form.elements.allowSameDayDelivery.checked,
      defaultDeliveryWeekdays,
      deliveryCustomerWeekdays,
      holidayWeekdays: selectedWeekdays(form, 'holidayWeekdays'),
      holidayDates
    });
    if (holidayDates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
      message.textContent = '지정 휴무일은 YYYY-MM-DD 형식으로 입력하세요.';
      return;
    }
    try {
      await saveSettings(next);
      state.settings = next;
      updateDeliveryPolicy();
      saveDraftNow();
      finish();
      toast('배송 설정을 저장했습니다.', 'success');
    } catch (error) {
      message.textContent = error.message || '설정을 저장하지 못했습니다.';
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    dialog.querySelector('[data-save]').click();
  });
  dialog.showModal();
}

function openDraftListDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'smart-dialog smart-draft-dialog';
  dialog.innerHTML = `<div class="smart-dialog__shell">
    <header><div><small>Local Drafts</small><h2>최근 초안</h2></div><button type="button" data-close aria-label="닫기">×</button></header>
    <div class="smart-dialog__message">최근 30개 초안을 이 기기에 보존합니다.</div>
    <div class="smart-draft-results"></div>
    <footer><button type="button" class="button button--quiet" data-close>닫기</button></footer>
  </div>`;
  document.body.append(dialog);
  const results = dialog.querySelector('.smart-draft-results');
  const render = () => {
    const drafts = loadDraftList();
    results.innerHTML = drafts.length ? drafts.map(item => `<article class="smart-draft-row" data-document-id="${esc(item.documentId)}">
      <button type="button" data-open-draft><strong>${esc(contract.MODES[item.mode]?.label || item.mode)} · ${esc(item.header?.customerName || '거래처 미확정')}</strong><span>${Number(item.rows?.length || 0)}행 · 원본 ${Number(item.batches?.length || 0)}차</span><small>${item.updatedAt ? new Date(item.updatedAt).toLocaleString('ko-KR') : ''}</small></button>
      <button type="button" class="row-remove" data-delete-draft aria-label="초안 삭제">×</button>
    </article>`).join('') : '<div class="smart-dialog__empty">저장된 초안이 없습니다.</div>';
    results.querySelectorAll('[data-document-id]').forEach(row => {
      const documentId = row.dataset.documentId;
      row.querySelector('[data-open-draft]').addEventListener('click', () => {
        const item = loadDraftList().find(draft => draft.documentId === documentId);
        if (!item || !contract.MODES[item.mode]) return;
        syncSourceText();
        state.draft.activeMode = item.mode;
        state.draft.modes[item.mode] = contract.normalizeModeDraft(item.mode, item);
        saveDraftNow();
        renderMode();
        dialog.close();
        dialog.remove();
      });
      row.querySelector('[data-delete-draft]').addEventListener('click', () => {
        const item = loadDraftList().find(draft => draft.documentId === documentId);
        if (!item || !window.confirm(`${item.header?.customerName || '거래처 미확정'} 초안을 삭제하시겠습니까? 원본 ${Number(item.batches?.length || 0)}차가 함께 삭제됩니다.`)) return;
        localStorage.setItem(contract.DRAFT_LIST_STORAGE_KEY, JSON.stringify(loadDraftList().filter(draft => draft.documentId !== documentId)));
        render();
      });
    });
  };
  const finish = () => { dialog.close(); dialog.remove(); };
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', finish));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.showModal();
  render();
}

async function rematchRowsForCustomer(customer) {
  const current = modeDraft();
  const before = current.rows.map(row => ({ ...row, editedFields: { ...(row.editedFields || {}) } }));
  try {
    setAppStatus(`${customerName(customer)} 기준으로 상품을 다시 매칭하고 있습니다.`);
    const matched = await rematchExtractedLinesForCustomer(before, customer, 'SMART_INPUT');
    current.rows = matched.map((line, index) => {
      const previous = before[index];
      const next = contract.normalizeRow({ ...previous, ...line, rowId: previous.rowId, editedFields: previous.editedFields });
      contract.ROW_FIELDS.forEach(field => {
        if (previous.editedFields?.[field]) next[field] = previous[field];
      });
      return next;
    });
    current.rows = contract.markDuplicatePossibilities(current.rows);
    renderRows();
    saveDraftNow();
    setAppStatus('거래처 기준 상품 매칭을 갱신했습니다.');
  } catch (error) {
    setAppStatus('상품 재매칭을 완료하지 못했습니다. 현재 수정값은 유지됩니다.', 'warn');
    toast(error.message || '상품 재매칭에 실패했습니다.', 'error');
  }
}

function renderWarehouseOptions() {
  $('warehouseOptions').innerHTML = state.warehouseCatalog.warehouses.map(warehouse => {
    const label = [warehouse.warehouseCode, warehouse.warehouseName].filter(Boolean).join(' · ');
    return `<option value="${esc(warehouseDisplayName(warehouse))}" label="${esc(label)}"></option>`;
  }).join('');
}

function applyWarehouseMatch() {
  const value = $('warehouseInput').value;
  const match = matchWarehouseInput({ warehouse: value }, state.warehouseCatalog.warehouses, state.warehouseCatalog.aliases);
  const header = modeDraft().header;
  header.warehouseId = match?.warehouseId || '';
  header.warehouseCode = match?.warehouseCode || '';
  header.warehouseName = match ? warehouseDisplayName(match) : value.trim();
  scheduleSave();
}

function hydrateHeader() {
  const header = modeDraft().header;
  $('customerInput').value = header.customerName;
  $('customerInput').dataset.customerId = header.customerId;
  $('orderDateInput').value = header.orderDate || contract.todayLocal();
  $('deliveryDateInput').value = header.deliveryDate;
  $('warehouseInput').value = header.warehouseName;
  $('transactionTypeInput').value = header.transactionType || '기타';
  $('customerHint').textContent = header.customerId ? '등록 거래처 · 마스터 연결됨' : '거래처가 인식되지 않으면 이 입력란으로 이동합니다.';
  applyCustomerRelationship(header);
  updateDeliveryPolicy();
}

function rowStatusLabel(row) {
  if (row.matchStatus === 'MATCHED') return ['일치', 'match-badge--matched'];
  if (row.matchStatus === 'SIMILAR') return ['유사', 'match-badge--similar'];
  return ['미인식', 'match-badge--failed'];
}

function renderRows() {
  const rows = modeDraft().rows;
  if (!rows.length) {
    inputRows.innerHTML = '<tr class="empty-row"><td colspan="11"><strong>아직 입력된 상품이 없습니다.</strong><span>원문을 분석하거나 빈 행을 추가해 시작하세요.</span></td></tr>';
    updateSummaries();
    return;
  }
  inputRows.innerHTML = rows.map(row => {
    const [status, statusClass] = rowStatusLabel(row);
    const raw = row.rawText || modeDraft().batches.find(batch => batch.batchId === row.batchId)?.rawText || '';
    const amount = Number(row.quantity || 0) * Number(row.unitPrice || 0);
    return `<tr data-row-id="${esc(row.rowId)}" data-status="${esc(row.matchStatus)}" class="${row.duplicatePossible ? 'is-duplicate' : ''}">
      <td class="source-cell"><span class="batch-badge">${Number(row.batchSequence || 0) || '-'}</span></td>
      <td class="source-cell" title="${esc(raw)}">${esc(raw)}</td>
      <td><input data-field="itemCode" value="${esc(row.itemCode)}" aria-label="품목코드"></td>
      <td><input data-field="itemName" value="${esc(row.itemName)}" aria-label="상품명"></td>
      <td><input data-field="specification" value="${esc(row.specification)}" aria-label="규격"></td>
      <td><input data-field="quantity" type="number" step="any" value="${esc(row.quantity ?? '')}" aria-label="수량"></td>
      <td><input data-field="unit" value="${esc(row.unit)}" aria-label="단위"></td>
      <td><input data-field="unitPrice" type="number" step="any" value="${esc(row.unitPrice ?? '')}" aria-label="단가"></td>
      <td><input value="${amount ? amount.toLocaleString('ko-KR') : ''}" aria-label="금액" readonly tabindex="-1"></td>
      <td><button type="button" class="match-badge ${statusClass}" data-match-row="${esc(row.rowId)}" title="상품 후보 선택">${status}${row.duplicatePossible ? ' · 중복' : ''}</button></td>
      <td><button type="button" class="row-remove" data-remove-row="${esc(row.rowId)}" aria-label="행 삭제">×</button></td>
    </tr>`;
  }).join('');
  updateSummaries();
  window.requestAnimationFrame(() => {
    $('tableScroll').scrollTop = Number(modeUi().scrollTop || 0);
    $('tableScroll').scrollLeft = Number(modeUi().scrollLeft || 0);
    const active = modeUi().activeCellId;
    if (!active) return;
    const [rowId, field] = active.split('|');
    inputRows.querySelector(`[data-row-id="${CSS.escape(rowId)}"] [data-field="${CSS.escape(field)}"]`)?.focus({ preventScroll: true });
  });
}

function updateSummaries() {
  const summary = contract.summarizeRows(modeDraft().rows);
  $('gridRowCount').textContent = `${summary.total.toLocaleString('ko-KR')}행`;
  $('matchedCount').textContent = `일치 ${summary.matched.toLocaleString('ko-KR')}`;
  $('similarCount').textContent = `유사 ${summary.similar.toLocaleString('ko-KR')}`;
  $('failedCount').textContent = `미인식 ${summary.unresolved.toLocaleString('ko-KR')}`;
  $('duplicateCount').textContent = `중복 가능 ${summary.duplicate.toLocaleString('ko-KR')}`;
  $('totalQuantity').textContent = summary.quantity.toLocaleString('ko-KR');
  $('totalAmount').textContent = `${summary.amount.toLocaleString('ko-KR')}원`;
  $('batchCount').textContent = `${modeDraft().batches.length.toLocaleString('ko-KR')}차`;
  $('rowCountRail').textContent = `${contract.MODES[state.draft.activeMode].label}행 ${summary.total.toLocaleString('ko-KR')}개`;
  updateStage(summary);
}

function updateStage(summary = contract.summarizeRows(modeDraft().rows)) {
  let stageIndex = 0;
  if (summary.total) stageIndex = summary.unresolved || summary.similar ? 2 : 3;
  if (modeDraft().delivery.status === 'SAVED') stageIndex = 4;
  state.draft.ui.stage = contract.STAGES[stageIndex];
  document.querySelectorAll('[data-stage]').forEach((item, index) => {
    item.classList.toggle('is-current', index === stageIndex);
    item.classList.toggle('is-complete', index < stageIndex);
    const indexLabel = item.querySelector('button > span');
    if (indexLabel) indexLabel.textContent = index < stageIndex ? '✓' : String(index + 1).padStart(2, '0');
  });
  $('progressText').textContent = `${stageIndex + 1} / ${contract.STAGES.length}`;
}

function renderDelivery() {
  const isOrder = state.draft.activeMode === 'order';
  const delivery = modeDraft().delivery;
  const lastDelivery = isOrder ? state.draft.ui.lastDelivery : null;
  $('deliveryTarget').textContent = isOrder ? '공통 주문서 원장' : `${contract.MODES[state.draft.activeMode].label} 전달 계약 준비 중`;
  $('deliveryDescription').textContent = isOrder
    ? 'ORDER Q vNext 저장소에 먼저 기록합니다.'
    : '확정된 DataOps 연결만 이후 단계에서 활성화합니다.';
  const visibleDelivery = delivery.status === 'SAVED' ? delivery : lastDelivery;
  $('deliveryState').textContent = visibleDelivery
    ? `최근 ${visibleDelivery.orderNo || visibleDelivery.targetRecordId || '저장 완료'}${visibleDelivery.deliveredAt ? ` · ${new Date(visibleDelivery.deliveredAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : ''}`
    : '전달 전';
  document.querySelector('.delivery-state span').style.background = visibleDelivery ? '#5eead4' : '#fbbf24';
  $('completeButton').disabled = !isOrder || state.busy;
  $('completeButton').textContent = '입력 완료';
  if (visibleDelivery?.targetRecordId) {
    document.querySelector('#orderLinks a:first-child').href = `../orderq/index.html?focus=${encodeURIComponent(visibleDelivery.targetRecordId)}&saved=1`;
  } else {
    document.querySelector('#orderLinks a:first-child').href = '../orderq/index.html';
  }
}

function renderMode() {
  const selected = contract.MODES[state.draft.activeMode];
  tabs.forEach(tab => {
    const active = tab.dataset.mode === selected.id;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('relatedModeLabel').textContent = selected.label;
  $('orderLinks').hidden = selected.id !== 'order';
  $('relatedEmpty').hidden = selected.id === 'order';
  hydrateHeader();
  sourceTextInput.value = modeDraft().sourceText;
  updateMethod(modeDraft().activeMethod);
  renderRows();
  renderDelivery();
  resizeSource();
  const relatedOpen = Boolean(state.draft.ui.relatedOpen);
  document.querySelector('.related-panel').classList.toggle('is-open', relatedOpen);
  $('relatedCollapseButton').setAttribute('aria-expanded', String(relatedOpen));
  $('relatedCollapseButton').textContent = relatedOpen ? '연결 앱 닫기' : '연결 앱 열기';
  setAppStatus(selected.id === 'order' ? '주문서 입력을 시작할 수 있습니다.' : `${selected.label} 입력 화면입니다. 전달 연결은 준비 중입니다.`);
}

function setMode(mode) {
  if (!contract.MODES[mode] || mode === state.draft.activeMode) return;
  syncSourceText();
  state.draft.activeMode = mode;
  state.pendingImageEvidence = null;
  state.pendingSourceName = '';
  saveDraftNow();
  renderMode();
}

function syncSourceText() {
  modeDraft().sourceText = sourceTextInput.value;
  scheduleSave();
  resizeSource();
}

function addDirectRow() {
  const current = modeDraft();
  const batch = contract.createBatch({
    sequence: current.batches.length + 1,
    method: 'direct',
    sourceType: 'MANUAL',
    sourceName: '직접입력'
  });
  current.batches.push(batch);
  current.rows = contract.applyParserResults(current.rows, batch, [{ rawText: '', itemName: '', quantity: null }]);
  current.sourceText = '';
  sourceTextInput.value = '';
  renderRows();
  saveDraftNow();
  const last = inputRows.querySelector('tr:last-child input[data-field="itemCode"]');
  last?.focus();
}

async function sha256Text(value) {
  if (!crypto?.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value ?? '')));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function fallbackLines(rawText, batch) {
  const customerKey = normalizedKey(modeDraft().header.customerName);
  return String(rawText || '').replace(/\r\n?/g, '\n').split('\n').map((raw, index) => ({ raw, index }))
    .filter(({ raw }) => raw.trim() && normalizedKey(raw) !== customerKey)
    .map(({ raw, index }) => {
      const cleaned = raw.trim().replace(/^[-•·*]+\s*/, '');
      const match = cleaned.match(/^(.*?)\s+(-?\d+(?:\.\d+)?)\s*([^\d\s]*)$/);
      return {
        rawText: raw,
        productText: match ? match[1].trim() : cleaned,
        itemName: match ? match[1].trim() : cleaned,
        quantity: match ? Number(match[2]) : null,
        unit: match?.[3] || '',
        sourceLineKey: `${batch.batchId}:${index + 1}`,
        matchStatus: 'UNRESOLVED'
      };
    });
}

async function analyzeSource() {
  if (state.busy) return;
  const current = modeDraft();
  const rawText = sourceTextInput.value;
  if (!rawText.trim()) {
    sourceTextInput.focus();
    return toast('분석할 원문을 입력하세요.', 'error');
  }
  if (state.catalogStatus === 'LOADING') {
    toast('상품 기준자료를 불러오는 중입니다. 잠시 후 다시 분석하세요.', 'error');
    return;
  }
  const method = contract.INPUT_METHODS.find(item => item.id === current.activeMethod) || contract.INPUT_METHODS[2];
  const batch = contract.createBatch({
    sequence: current.batches.length + 1,
    method: method.id,
    sourceType: method.sourceType,
    sourceName: state.pendingSourceName,
    rawText,
    contentHash: await sha256Text(rawText)
  });
  state.busy = true;
  $('analyzeButton').disabled = true;
  $('parserProgress').hidden = false;
  setAppStatus(`${batch.sequence}차 입력을 분석하고 있습니다.`);
  try {
    let lines = [];
    let analyzedDocument = null;
    const rawOrdererName = extractOrdererName(rawText);
    current.header.rawOrdererName = rawOrdererName;
    const aliasResolution = resolveAliasCustomer(rawOrdererName, batch.sourceType);
    if (current.header.customerId && aliasResolution?.customer?.customerId && aliasResolution.customer.customerId !== current.header.customerId) {
      throw new Error(`현재 배송처와 다른 주문자명입니다. 주문을 합치지 않고 새로 작성으로 분리하세요: ${customerName(aliasResolution.customer)}`);
    }
    if (!current.header.customerId && aliasResolution) {
      current.header.aliasMappingId = aliasResolution.mapping.aliasMappingId;
      applyCustomer(aliasResolution.customer, { rematch: false, mappingSource: 'CONFIRMED_ALIAS', learnAlias: false });
    } else if (!current.header.customerId) {
      const inferred = inferCustomer(rawText);
      if (inferred) applyCustomer(inferred, { rematch: false, mappingSource: 'MASTER_EXACT', learnAlias: false });
    }

    if (state.draft.activeMode === 'order') {
      try {
        const captured = await captureTextIntake({
          sourceType: method.sourceType === 'CLIPBOARD' ? 'GENERAL_TEXT' : method.sourceType,
          sourceId: 'SMART_INPUT',
          captureOccurrenceId: `${state.draft.draftId}:${state.draft.activeMode}:${batch.sequence}`,
          rawText,
          imageEvidence: state.pendingImageEvidence
        });
        const selectedCustomer = current.header.customerId && current.header.customerName
          ? { customerId: current.header.customerId, customerName: current.header.customerName }
          : null;
        const analyzed = await analyzeSingleOrderDocument({
          session: captured.session,
          sourcePart: captured.sourcePart,
          rawText,
          customerOverride: selectedCustomer,
          headerDraft: {
            orderDate: current.header.orderDate,
            deliveryExpectedDate: current.header.deliveryDate,
            warehouseName: current.header.warehouseName
          }
        });
        batch.intakeSessionId = captured.session.intakeSessionId;
        batch.intakeDocumentId = analyzed.document.intakeDocumentId;
        analyzedDocument = analyzed.document;
        lines = analyzed.lines;
      } catch (error) {
        lines = fallbackLines(rawText, batch);
        if (!lines.length) throw error;
        toast('자동 파서가 인식하지 못한 원문은 직접 확인할 행으로 추가했습니다.', 'error');
      }
    } else {
      lines = fallbackLines(rawText, batch);
    }

    if (!lines.length) throw new Error('상품 행을 인식하지 못했습니다. 상품명과 수량을 확인해 주세요.');
    current.batches.push(batch);
    current.rows = contract.applyParserResults(current.rows, batch, lines);
    current.rows.forEach(row => enrichRowFromUnifiedCatalog(row));
    current.rows = contract.markDuplicatePossibilities(current.rows);
    current.sourceText = '';
    current.delivery = { status: 'DRAFT', targetId: '', targetRecordId: '', deliveredAt: '' };
    sourceTextInput.value = '';
    state.pendingImageEvidence = null;
    state.pendingSourceName = '';
    resizeSource();
    if (!current.header.customerId && analyzedDocument?.confirmedCustomerId) {
      applyCustomer(
        { customerId: analyzedDocument.confirmedCustomerId, customerName: analyzedDocument.confirmedCustomerName },
        { rematch: false, mappingSource: 'PARSER_CONFIRMED', learnAlias: false }
      );
    }
    renderRows();
    renderDelivery();
    saveDraftNow();
    const summary = contract.summarizeRows(current.rows);
    setAppStatus(`${batch.sequence}차 분석 완료 · ${lines.length}행 추가 · 일치 ${summary.matched}, 확인 필요 ${summary.similar + summary.unresolved}`);
    if (!current.header.customerId) {
      $('customerHint').textContent = '거래처를 인식하지 못했습니다. 등록 거래처를 선택하세요.';
      $('customerInput').focus();
      toast('거래처를 인식하지 못해 거래처 입력란으로 이동했습니다.', 'error');
    }
  } catch (error) {
    setAppStatus('분석을 완료하지 못했습니다. 원문은 그대로 유지됩니다.', 'error');
    toast(error.message || '자료 분석에 실패했습니다.', 'error');
  } finally {
    state.busy = false;
    $('analyzeButton').disabled = false;
    $('parserProgress').hidden = true;
    renderDelivery();
  }
}

async function handleFile(file) {
  if (!file) return;
  try {
    updateMethod('excel');
    setAppStatus(`${file.name} 파일을 읽고 있습니다.`);
    let rawText = '';
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      if (!window.XLSX) throw new Error('Excel 처리 모듈을 불러오지 못했습니다.');
      const workbook = window.XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: false, cellText: true });
      const sheetName = workbook.SheetNames.find(name => workbook.Sheets[name]?.['!ref']) || workbook.SheetNames[0];
      if (!sheetName) throw new Error('읽을 수 있는 Excel 시트가 없습니다.');
      const matrix = window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: true });
      rawText = matrix.map(row => row.map(cell => String(cell ?? '')).join('\t')).join('\n');
      state.pendingSourceName = `${file.name} · ${sheetName}`;
    } else {
      rawText = await file.text();
      state.pendingSourceName = file.name;
    }
    sourceTextInput.value = rawText;
    syncSourceText();
    setAppStatus(`${file.name}을 원문 입력창에 불러왔습니다.`);
    toast('파일 내용을 확인한 뒤 분석·추가를 누르세요.', 'success');
  } catch (error) {
    toast(error.message || '파일을 읽지 못했습니다.', 'error');
    setAppStatus('파일을 읽지 못했습니다.', 'error');
  } finally {
    $('fileInput').value = '';
  }
}

async function fileToImageEvidence(file) {
  const buffer = await file.arrayBuffer();
  const digest = crypto?.subtle ? await crypto.subtle.digest('SHA-256', buffer) : null;
  const contentHash = digest ? [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') : '';
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
    binaryBase64: dataUrl.split(',')[1] || ''
  };
}

async function recognizeImage(file) {
  if (!file || !String(file.type || '').startsWith('image/')) return;
  if (state.busy) return;
  state.busy = true;
  $('analyzeButton').disabled = true;
  $('parserProgress').hidden = false;
  $('parserProgress').querySelector('strong').textContent = '사진에서 문자를 추출하고 있습니다.';
  updateMethod('photo');
  try {
    if (!window.Tesseract?.recognize) throw new Error('사진 OCR 모듈을 불러오지 못했습니다.');
    state.pendingImageEvidence = await fileToImageEvidence(file);
    state.pendingSourceName = state.pendingImageEvidence.fileName;
    const result = await window.Tesseract.recognize(file, 'kor+eng', {
      logger: progress => {
        if (progress.status === 'recognizing text') {
          $('parserProgress').querySelector('strong').textContent = `사진 문자 추출 ${Math.round(Number(progress.progress || 0) * 100)}%`;
        }
      }
    });
    const text = String(result?.data?.text || '').replace(/\r/g, '');
    if (!text.trim()) throw new Error('사진에서 문자를 찾지 못했습니다.');
    sourceTextInput.value = text;
    syncSourceText();
    setAppStatus('사진 문자 추출이 완료되었습니다. 원문을 확인하세요.');
    toast('추출된 문자를 확인한 뒤 분석·추가를 누르세요.', 'success');
  } catch (error) {
    state.pendingImageEvidence = null;
    toast(error.message || '사진 문자를 추출하지 못했습니다.', 'error');
    setAppStatus('사진 OCR을 완료하지 못했습니다. 직접 입력할 수 있습니다.', 'warn');
  } finally {
    state.busy = false;
    $('photoInput').value = '';
    $('analyzeButton').disabled = false;
    $('parserProgress').hidden = true;
    $('parserProgress').querySelector('strong').textContent = '자료를 분석하고 있습니다.';
  }
}

function toggleVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    toast('이 브라우저는 음성 입력을 지원하지 않습니다.', 'error');
    return;
  }
  if (state.listening && state.recognition) {
    state.recognition.stop();
    return;
  }
  const recognition = new Recognition();
  recognition.lang = 'ko-KR';
  recognition.continuous = true;
  recognition.interimResults = true;
  state.recognition = recognition;
  recognition.onstart = () => {
    state.listening = true;
    updateMethod('voice');
    $('sourceNotice').textContent = '음성을 듣고 있습니다. 다시 누르면 종료됩니다.';
    setAppStatus('음성 입력 중입니다.');
  };
  recognition.onresult = event => {
    let finalText = '';
    let interimText = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || '';
      if (event.results[index].isFinal) finalText += transcript;
      else interimText += transcript;
    }
    if (finalText.trim()) {
      sourceTextInput.value += `${sourceTextInput.value && !sourceTextInput.value.endsWith('\n') ? '\n' : ''}${finalText.trim()}`;
      syncSourceText();
    }
    $('sourceNotice').textContent = interimText ? `인식 중: ${interimText}` : '음성을 듣고 있습니다.';
  };
  recognition.onerror = event => {
    toast(event.error === 'not-allowed' ? '마이크 사용 권한이 필요합니다.' : '음성 인식을 완료하지 못했습니다.', 'error');
  };
  recognition.onend = () => {
    state.listening = false;
    state.recognition = null;
    $('sourceNotice').textContent = '음성 입력이 종료되었습니다. 내용을 확인하세요.';
    setAppStatus('음성 입력 내용을 확인할 수 있습니다.');
  };
  recognition.start();
}

function exactProduct(query) {
  const key = normalizedKey(query);
  if (!key) return null;
  return state.products.find(product => [product.itemCode, product.itemName, product.secondaryName, product.searchInfo]
    .some(value => normalizedKey(value) === key)) || null;
}

function priceFromProduct(product) {
  const price = product.priceOptions?.find(option => option.key === 'salePrice')
    || product.priceOptions?.find(option => Number.isFinite(Number(option.value)));
  return price ? Number(price.value) : null;
}

function applyProduct(row, product, force = false) {
  if (!row || !product) return;
  const protect = field => !force && row.editedFields?.[field];
  row.productId = product.productId || '';
  if (!protect('itemCode')) row.itemCode = product.itemCode || '';
  if (!protect('itemName')) row.itemName = product.itemName || '';
  if (!protect('specification')) row.specification = product.specification || '';
  if (!protect('unit')) row.unit = product.finalUnit || product.unit || '';
  if (!protect('unitPrice') && row.unitPrice == null) row.unitPrice = priceFromProduct(product);
  row.matchStatus = row.productId && row.itemCode ? 'MATCHED' : 'UNRESOLVED';
  row.reviewStatus = row.matchStatus === 'MATCHED' ? 'CONFIRMED' : 'PENDING';
  row.productIdentityStatus = row.matchStatus === 'MATCHED' ? 'MASTER_LINKED' : 'UNRESOLVED';
  row.candidateProducts = [];
}

function enrichRowFromUnifiedCatalog(row) {
  if (!row || row.matchStatus === 'MATCHED') return row;
  const query = row.itemCode || row.itemName || row.rawText;
  if (!query) return row;
  const exact = exactProduct(query);
  if (exact) {
    applyProduct(row, exact);
    row.matchSource = 'SMART_INPUT_UNIFIED_CATALOG';
    return row;
  }
  const candidates = searchProductCatalog(query, state.products, 5);
  if (candidates.length) {
    row.candidateProducts = candidates;
    row.matchStatus = 'SIMILAR';
    row.reviewStatus = 'PENDING';
    row.productIdentityStatus = 'UNRESOLVED';
  }
  return row;
}

function tryMatchRow(row) {
  const query = row.itemCode || row.itemName;
  const exact = exactProduct(query);
  if (exact) {
    applyProduct(row, exact);
  } else if (query) {
    row.productId = '';
    row.candidateProducts = searchProductCatalog(query, state.products, 5);
    row.matchStatus = row.candidateProducts.length ? 'SIMILAR' : 'UNRESOLVED';
    row.reviewStatus = 'PENDING';
    row.productIdentityStatus = 'UNRESOLVED';
  }
  modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
  renderRows();
  saveDraftNow();
}

function openProductDialog(row) {
  const dialog = document.createElement('dialog');
  dialog.className = 'customer-picker-dialog';
  const shell = document.createElement('div');
  shell.className = 'customer-picker-shell';
  const header = document.createElement('header');
  const heading = document.createElement('div');
  const small = document.createElement('small');
  small.textContent = 'Product Master';
  const title = document.createElement('h2');
  title.textContent = '상품 후보 선택';
  heading.append(small, title);
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', '닫기');
  close.textContent = '×';
  header.append(heading, close);
  const label = document.createElement('label');
  label.className = 'customer-picker-search';
  label.append('상품명 또는 코드');
  const search = document.createElement('input');
  search.type = 'search';
  search.value = row.itemCode || row.itemName || '';
  label.append(search);
  const message = document.createElement('div');
  message.className = 'customer-picker-message';
  const results = document.createElement('div');
  results.className = 'customer-picker-results';
  shell.append(header, label, message, results);
  dialog.append(shell);
  document.body.append(dialog);

  const finish = product => {
    if (product) {
      applyProduct(row, product, true);
      modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
      renderRows();
      saveDraftNow();
    }
    dialog.close();
    dialog.remove();
  };
  const render = () => {
    const found = searchProductCatalog(search.value, state.products, 12);
    results.innerHTML = '';
    message.textContent = found.length ? `${found.length}개 후보를 확인하세요.` : '일치하는 상품 후보가 없습니다.';
    found.forEach(product => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'customer-picker-result';
      const strong = document.createElement('strong');
      strong.textContent = product.itemName || '상품명 없음';
      const code = document.createElement('span');
      code.textContent = product.itemCode || '코드 없음';
      const detail = document.createElement('small');
      detail.textContent = [product.specification, product.finalUnit].filter(Boolean).join(' · ') || '추가 정보 없음';
      button.append(strong, code, detail);
      button.addEventListener('click', () => finish(product));
      results.append(button);
    });
  };
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 90);
  });
  close.addEventListener('click', () => finish(null));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
  dialog.showModal();
  search.focus();
  render();
}

async function completeOrder() {
  const current = modeDraft();
  if (state.draft.activeMode !== 'order') {
    toast('구매·판매 전달 대상은 확정 후 활성화합니다.', 'error');
    return;
  }
  applyWarehouseMatch();
  const deliveryDecision = updateDeliveryPolicy();
  if (!deliveryDecision?.valid) {
    $('deliveryDateInput').focus();
    return toast(deliveryDecision?.message || '배송일을 확인하세요.', 'error');
  }
  const errors = contract.validateOrderDraft(current);
  if (errors.length) {
    const first = errors[0];
    if (first.field === 'customer') $('customerInput').focus();
    else if (first.field === 'orderDate') $('orderDateInput').focus();
    else if (first.field === 'warehouse') $('warehouseInput').focus();
    else if (first.field.startsWith('row:')) {
      const [, index, field] = first.field.split(':');
      inputRows.querySelectorAll('tr')[Number(index)]?.querySelector(`[data-field="${field === 'item' ? 'itemName' : field}"]`)?.focus();
    }
    return toast(first.message, 'error');
  }
  if (!current.header.taxCustomerId && !window.confirm('세무 거래처가 지정되지 않았습니다. 배송처별 주문은 유지한 채 ORDER Q에 저장하시겠습니까?')) return;
  state.busy = true;
  renderDelivery();
  setAppStatus('공통 주문서 원장에 저장하고 있습니다.');
  try {
    const batchText = current.batches.map(batch => batch.rawText).join('\n\n--- SMART INPUT BATCH ---\n\n');
    const rawFingerprint = await sha256Text(batchText);
    const result = await createOrder({
      orderDate: current.header.orderDate,
      deliveryExpectedDate: current.header.deliveryDate,
      customerId: current.header.customerId,
      customerName: current.header.customerName,
      warehouseId: current.header.warehouseId,
      warehouseCode: current.header.warehouseCode,
      warehouseName: current.header.warehouseName,
      transactionType: current.header.transactionType,
      sourceType: 'SMART_INPUT',
      sourceId: current.batches[0]?.batchId || state.draft.draftId,
      sourceDocumentKey: `SMART_INPUT:${current.batches[0]?.batchId || state.draft.draftId}:ORDER`,
      rawFingerprint,
      intakeContractVersion: 'SMART_INPUT_V1',
      inputChannel: 'SMART_INPUT',
      actorName: 'SMART INPUT 관리자',
      items: current.rows.map((row, index) => ({
        lineNo: index + 1,
        productId: row.productId || null,
        itemCode: row.itemCode,
        itemName: row.itemName,
        specification: row.specification,
        rawText: row.rawText,
        rawQuantity: row.quantity,
        rawUnit: row.unit,
        finalQuantity: row.quantity,
        finalUnit: row.unit,
        price: row.unitPrice,
        supplyAmount: Number(row.quantity || 0) * Number(row.unitPrice || 0),
        memo: row.memo,
        matchStatus: row.productId && row.itemCode ? 'MATCHED' : 'MATCH_FAILED',
        matchSource: row.productId ? 'SMART_INPUT_MASTER' : 'SMART_INPUT_UNRESOLVED',
        intakeLineId: row.intakeLineId,
        sourceLineKey: row.sourceLineKey || `${row.batchId}:${row.sourceLineNo || index + 1}`,
        reviewStatus: row.productId && row.itemCode ? 'CONFIRMED' : 'PENDING',
        productIdentityStatus: row.productId && row.itemCode ? 'MASTER_LINKED' : 'UNRESOLVED'
      }))
    });
    let online = false;
    try {
      const sync = await syncAfterLocalMutation(result.order.orderId);
      online = Boolean(sync?.online);
    } catch (_) {}
    const delivery = {
      status: 'SAVED',
      targetId: 'orderq-vnext',
      targetRecordId: result.order.orderId,
      deliveredAt: new Date().toISOString(),
      online
    };
    state.draft.ui.lastDelivery = { ...delivery, orderNo: result.order.orderNo };
    appendDeliveryHistory({
      ...delivery,
      orderNo: result.order.orderNo,
      draftId: state.draft.draftId,
      sourceBatchIds: current.batches.map(batch => batch.batchId),
      customerId: current.header.customerId,
      customerName: current.header.customerName,
      customerLinkGroupId: current.header.customerLinkGroupId,
      taxCustomerId: current.header.taxCustomerId,
      taxCustomerName: current.header.taxCustomerName,
      deliveryPolicySnapshot: current.header.deliveryPolicySnapshot,
      rowCount: current.rows.length
    });
    const next = contract.createDraft({ date: contract.todayLocal() }).modes.order;
    next.header.warehouseId = current.header.warehouseId;
    next.header.warehouseCode = current.header.warehouseCode;
    next.header.warehouseName = current.header.warehouseName;
    next.header.transactionType = current.header.transactionType;
    state.draft.modes.order = next;
    saveDraftNow();
    renderMode();
    setAppStatus(online ? `주문 ${result.order.orderNo} 저장·중앙 반영 완료` : `주문 ${result.order.orderNo} 로컬 저장 완료 · 중앙 반영 대기`, online ? 'normal' : 'warn');
    toast(`주문 ${result.order.orderNo}을 공통 주문서 원장에 저장했습니다.`, 'success');
  } catch (error) {
    setAppStatus('주문 저장을 완료하지 못했습니다. 입력 내용은 유지됩니다.', 'error');
    toast(error.message || '주문 저장에 실패했습니다.', 'error');
  } finally {
    state.busy = false;
    renderDelivery();
  }
}

function resetCurrentMode(requireConfirmation = true) {
  const current = modeDraft();
  const hasData = current.rows.length || current.sourceText.trim();
  if (requireConfirmation && hasData && !window.confirm(`${contract.MODES[state.draft.activeMode].label} 입력 내용을 비우고 새로 작성하시겠습니까?`)) return;
  const fallback = contract.createDraft({ date: contract.todayLocal() }).modes[state.draft.activeMode];
  fallback.header.warehouseId = current.header.warehouseId;
  fallback.header.warehouseCode = current.header.warehouseCode;
  fallback.header.warehouseName = current.header.warehouseName;
  fallback.header.transactionType = current.header.transactionType;
  state.draft.modes[state.draft.activeMode] = fallback;
  state.pendingImageEvidence = null;
  state.pendingSourceName = '';
  saveDraftNow();
  renderMode();
  sourceTextInput.focus();
  toast('새 입력을 시작합니다.', 'success');
}

async function hydrateReferences() {
  state.catalogStatus = 'LOADING';
  $('referenceStatus').dataset.status = 'LOADING';
  $('referenceStatus').querySelector('strong').textContent = '상품·거래처·배송 설정을 불러오고 있습니다.';
  const results = await Promise.allSettled([
    ensureCustomerMasterReady().then(() => getAll(STORE.CUSTOMERS)),
    loadProductCatalog(),
    loadWarehouseCatalog(),
    loadSmartInputData()
  ]);
  if (results[0].status === 'fulfilled') state.customers = results[0].value.filter(customer => (customer.status || 'ACTIVE') === 'ACTIVE');
  if (results[1].status === 'fulfilled') {
    state.products = results[1].value.products;
    state.catalogSummary = results[1].value;
    state.catalogStatus = state.products.length ? 'READY' : (results[1].value.errors?.length ? 'ERROR' : 'EMPTY');
  } else {
    state.catalogStatus = 'ERROR';
    state.catalogSummary = { commonCount: 0, orderQCount: 0, errors: [results[1].reason?.message || '상품 카탈로그 오류'] };
  }
  if (results[2].status === 'fulfilled') {
    state.warehouseCatalog = results[2].value;
    renderWarehouseOptions();
  }
  if (results[3].status === 'fulfilled') {
    state.settings = contract.normalizeSettings(results[3].value.settings || {});
    state.linkGroups = results[3].value.linkGroups || [];
    state.temporaryCustomers = results[3].value.temporaryCustomers || [];
    state.aliasMappings = results[3].value.aliasMappings || [];
    state.smartDataReady = true;
  }
  $('referenceStatus').dataset.status = state.catalogStatus;
  $('referenceStatus').querySelector('strong').textContent = state.catalogStatus === 'READY'
    ? `상품 준비 · 공통 ${Number(state.catalogSummary.commonCount || 0).toLocaleString('ko-KR')}건 · ORDER Q ${Number(state.catalogSummary.orderQCount || 0).toLocaleString('ko-KR')}건 · 거래처 ${state.customers.length.toLocaleString('ko-KR')}건`
    : (state.catalogStatus === 'EMPTY' ? '상품 기준자료가 없습니다. 직접입력은 계속 사용할 수 있습니다.' : '상품 기준자료 일부를 불러오지 못했습니다. 직접입력은 계속 사용할 수 있습니다.');
  renderMode();
  if (results.some(result => result.status === 'rejected')) {
    setAppStatus('일부 마스터를 불러오지 못했습니다. 직접입력은 계속 사용할 수 있습니다.', 'warn');
  }
}

tabs.forEach(tab => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
methodButtons.forEach(button => button.addEventListener('click', () => {
  const method = updateMethod(button.dataset.method);
  if (method.id === 'direct') addDirectRow();
  else if (method.id === 'excel') $('fileInput').click();
  else if (method.id === 'photo') $('photoInput').click();
  else if (method.id === 'voice') toggleVoice();
  else {
    sourceTextInput.focus();
    $('sourceNotice').textContent = method.id === 'paste'
      ? '텍스트 또는 이미지를 Ctrl+V로 붙여넣으세요.'
      : '공백과 줄바꿈을 유지해 입력합니다.';
  }
}));

sourceTextInput.addEventListener('input', syncSourceText);
$('fileInput').addEventListener('change', event => handleFile(event.target.files?.[0]));
$('photoInput').addEventListener('change', event => recognizeImage(event.target.files?.[0]));
$('analyzeButton').addEventListener('click', analyzeSource);
$('addRowButton').addEventListener('click', () => { updateMethod('direct'); addDirectRow(); });
$('customerSearchButton').addEventListener('click', chooseCustomer);
$('customerInput').addEventListener('input', event => {
  const header = modeDraft().header;
  if (event.target.value.trim() !== header.customerName) {
    header.customerId = '';
    header.customerName = event.target.value.trim();
    header.customerLinkGroupId = '';
    header.taxCustomerId = '';
    header.taxCustomerName = '';
    header.isTemporaryCustomer = false;
    header.customerMappingSource = '';
    event.target.dataset.customerId = '';
    applyCustomerRelationship(header);
    updateDeliveryPolicy();
    $('customerHint').textContent = '등록 거래처를 선택해야 주문서 원장에 저장할 수 있습니다.';
    scheduleSave();
  }
});
$('customerInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    chooseCustomer();
  }
});
$('orderDateInput').addEventListener('input', event => {
  modeDraft().header.orderDate = event.target.value;
  if (!modeDraft().header.manualDeliveryOverride) updateDeliveryPolicy({ force: true });
  else updateDeliveryPolicy();
  scheduleSave();
});
$('deliveryDateInput').addEventListener('input', event => {
  modeDraft().header.deliveryDate = event.target.value;
  modeDraft().header.manualDeliveryOverride = true;
  updateDeliveryPolicy();
  scheduleSave();
});
$('warehouseInput').addEventListener('input', applyWarehouseMatch);
$('warehouseInput').addEventListener('change', applyWarehouseMatch);
$('transactionTypeInput').addEventListener('change', event => { modeDraft().header.transactionType = event.target.value; scheduleSave(); });
$('completeButton').addEventListener('click', completeOrder);
$('saveDraftButton').addEventListener('click', () => { saveDraftNow(); toast('현재 초안을 저장했습니다.', 'success'); });
$('draftListButton').addEventListener('click', openDraftListDialog);
$('settingsButton').addEventListener('click', openSettingsDialog);
$('resetDraftButton').addEventListener('click', () => resetCurrentMode(true));
$('relatedCollapseButton').addEventListener('click', event => {
  const panel = document.querySelector('.related-panel');
  const open = panel.classList.toggle('is-open');
  state.draft.ui.relatedOpen = open;
  event.currentTarget.setAttribute('aria-expanded', String(open));
  event.currentTarget.textContent = open ? '연결 앱 닫기' : '연결 앱 열기';
  scheduleSave();
});

inputRows.addEventListener('input', event => {
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr) return;
  const index = modeDraft().rows.findIndex(row => row.rowId === tr.dataset.rowId);
  if (index < 0) return;
  const field = input.dataset.field;
  let row = contract.markUserEdit(modeDraft().rows[index], field, input.value);
  if (field === 'itemCode' || field === 'itemName') {
    row.productId = '';
    row.matchStatus = 'UNRESOLVED';
    row.reviewStatus = 'PENDING';
    row.productIdentityStatus = 'UNRESOLVED';
  }
  modeDraft().rows[index] = row;
  if (field === 'quantity' || field === 'unitPrice') {
    const amount = Number(row.quantity || 0) * Number(row.unitPrice || 0);
    const amountInput = tr.querySelector('td:nth-child(9) input');
    if (amountInput) amountInput.value = amount ? amount.toLocaleString('ko-KR') : '';
  }
  updateSummaries();
  scheduleSave();
});
inputRows.addEventListener('focusin', event => {
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr) return;
  modeUi().activeCellId = `${tr.dataset.rowId}|${input.dataset.field}`;
  state.draft.ui.selectedRowId = tr.dataset.rowId;
  scheduleSave();
});
inputRows.addEventListener('change', event => {
  const input = event.target.closest('[data-field]');
  const tr = event.target.closest('[data-row-id]');
  if (!input || !tr || !['itemCode', 'itemName'].includes(input.dataset.field)) return;
  const row = modeDraft().rows.find(item => item.rowId === tr.dataset.rowId);
  if (row) tryMatchRow(row);
});
inputRows.addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-row]');
  if (remove) {
    modeDraft().rows = modeDraft().rows.filter(row => row.rowId !== remove.dataset.removeRow);
    modeDraft().rows = contract.markDuplicatePossibilities(modeDraft().rows);
    renderRows();
    saveDraftNow();
    return;
  }
  const match = event.target.closest('[data-match-row]');
  if (match) {
    const row = modeDraft().rows.find(item => item.rowId === match.dataset.matchRow);
    if (row) openProductDialog(row);
  }
});

document.addEventListener('paste', event => {
  const image = [...(event.clipboardData?.items || [])]
    .filter(item => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map(item => item.getAsFile())
    .find(Boolean);
  if (image) {
    event.preventDefault();
    recognizeImage(image);
    return;
  }
  if (event.clipboardData?.getData('text/plain')) {
    updateMethod('paste');
    window.setTimeout(syncSourceText, 0);
  }
});

document.addEventListener('keydown', event => {
  if (event.altKey && ['1', '2', '3'].includes(event.key)) {
    event.preventDefault();
    setMode(['order', 'purchase', 'sale'][Number(event.key) - 1]);
  }
});

$('tableScroll').addEventListener('scroll', event => {
  modeUi().scrollTop = event.currentTarget.scrollTop;
  modeUi().scrollLeft = event.currentTarget.scrollLeft;
  scheduleSave();
}, { passive: true });

window.addEventListener('pagehide', saveDraftNow);
renderMode();
hydrateReferences();
