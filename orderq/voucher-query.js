import { readVoucherActivity } from './voucher-activity-read-adapter.js?v=0.1.0';

const params = new URLSearchParams(location.search);
const modeInput = document.getElementById('modeInput');
const dateInput = document.getElementById('dateInput');
const status = document.getElementById('queryStatus');
const list = document.getElementById('voucherList');
const focusId = params.get('focus') || '';
modeInput.value = ['order', 'purchase', 'sale'].includes(params.get('mode')) ? params.get('mode') : 'order';
dateInput.value = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : new Date().toLocaleDateString('sv-SE');

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const won = value => `${Number(value || 0).toLocaleString('ko-KR')}원`;

function card(row) {
  const items = row.items || [];
  return `<article class="voucher-query-card ${row.id === focusId ? 'is-focused' : ''}" id="voucher-${esc(row.id)}">
    <header><h2>${esc(row.customerName)}</h2><span>${esc(row.voucherNo)} · ${esc(row.status)}</span><strong>${won(row.totalAmount)}</strong></header>
    <div class="table-wrap"><table><thead><tr><th>No.</th><th>품목코드</th><th>품목명</th><th>규격</th><th>수량</th><th>단위</th><th>단가</th><th>금액</th></tr></thead><tbody>${items.map((item, index) => `<tr><td class="center">${index + 1}</td><td>${esc(item.code)}</td><td>${esc(item.name)}</td><td>${esc(item.specification)}</td><td class="num">${esc(item.quantity)}</td><td>${esc(item.unit)}</td><td class="num">${item.unitPrice === '' ? '' : Number(item.unitPrice).toLocaleString('ko-KR')}</td><td class="num">${item.amount === '' ? '' : Number(item.amount).toLocaleString('ko-KR')}</td></tr>`).join('')}</tbody></table></div>
  </article>`;
}

async function load() {
  status.textContent = '불러오는 중…';
  list.innerHTML = '<div class="voucher-query-state">전표를 불러오는 중입니다.</div>';
  const snapshot = await readVoucherActivity({ mode: modeInput.value, date: dateInput.value });
  if (snapshot.status === 'ERROR') {
    status.textContent = 'ERROR';
    list.innerHTML = `<div class="voucher-query-state"><strong>조회 실패</strong><span>${esc(snapshot.error?.message || '')}</span></div>`;
    return;
  }
  status.textContent = `${snapshot.status} · ${snapshot.count}건`;
  list.innerHTML = snapshot.rows.length ? snapshot.rows.map(card).join('') : '<div class="voucher-query-state"><strong>전표 0건</strong><span>조회는 정상 완료되었습니다.</span></div>';
  document.getElementById(`voucher-${focusId}`)?.scrollIntoView({ block: 'center' });
}

function updateQuery() {
  const query = new URLSearchParams({ mode: modeInput.value, date: dateInput.value });
  history.replaceState(null, '', `${location.pathname}?${query}`);
  void load();
}

document.getElementById('reloadButton').addEventListener('click', load);
modeInput.addEventListener('change', updateQuery);
dateInput.addEventListener('change', updateQuery);
void load();
