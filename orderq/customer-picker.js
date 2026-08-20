import {
  CUSTOMER_STATUS,
  createLiveCustomer,
  ensureCustomerMasterReady,
  searchCustomers
} from './customer-master.js?v=0.12.0';

let readyPromise = null;

function ensureStyles() {
  if (document.querySelector('link[data-customer-picker-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './customer-master.css?v=0.12.0';
  link.dataset.customerPickerStyle = 'true';
  document.head.append(link);
}

export function readyCustomerPicker(options = {}) {
  if (!readyPromise) readyPromise = ensureCustomerMasterReady(options);
  return readyPromise;
}

function resultMarkup(item) {
  const customer = item.customer;
  const flags = [];
  if (customer.status === CUSTOMER_STATUS.INACTIVE) flags.push('거래중단');
  if (item.redirected) flags.push('대표 거래처로 연결');
  return `<button type="button" class="customer-picker-result" data-id="${customer.customerId}">
    <strong>${escapeHtml(customer.customerName)}</strong>
    <span>${escapeHtml(customer.customerCode || customer.erpCustomerCode || '')}</span>
    <small>${escapeHtml(flags.join(' · ') || customer.address || '')}</small>
  </button>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export async function openCustomerPicker({
  initialName = '',
  source = 'LIVE_CREATE',
  title = '거래처 찾기',
  allowQuickCreate = true
} = {}) {
  ensureStyles();
  await readyCustomerPicker();
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'customer-picker-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="customer-picker-shell">
        <header><div><small>Customer Master</small><h2>${escapeHtml(title)}</h2></div><button value="cancel" aria-label="닫기">×</button></header>
        <label class="customer-picker-search">거래처명 또는 코드<input type="search" value="${escapeHtml(initialName)}" autocomplete="off" autofocus></label>
        <div class="customer-picker-message">거래처 정보를 확인하고 있습니다.</div>
        <div class="customer-picker-results"></div>
        <section class="customer-picker-create" ${allowQuickCreate ? '' : 'hidden'}>
          <p>찾는 거래처가 없으면 거래처명만으로 바로 등록할 수 있습니다.</p>
          <button type="button" class="customer-picker-create-button">등록 후 계속</button>
          <button type="button" class="customer-picker-force-button" hidden>그래도 새로 등록</button>
        </section>
      </form>`;
    document.body.append(dialog);
    const input = dialog.querySelector('input');
    const results = dialog.querySelector('.customer-picker-results');
    const message = dialog.querySelector('.customer-picker-message');
    const createButton = dialog.querySelector('.customer-picker-create-button');
    const forceButton = dialog.querySelector('.customer-picker-force-button');
    let candidates = [];

    const finish = customer => {
      resolve(customer || null);
      dialog.close();
      dialog.remove();
    };
    const render = async () => {
      const query = input.value.trim();
      candidates = query ? await searchCustomers(query, { includeInactive: true }) : [];
      results.innerHTML = candidates.map(resultMarkup).join('');
      message.textContent = query
        ? (candidates.length ? '기존 거래처를 선택하세요.' : '일치하는 거래처가 없습니다.')
        : '거래처명 또는 코드를 입력하세요.';
      results.querySelectorAll('[data-id]').forEach(button => {
        button.addEventListener('click', () => {
          const item = candidates.find(candidate => candidate.customer.customerId === button.dataset.id);
          if (!item) return;
          if (item.customer.status !== CUSTOMER_STATUS.ACTIVE) {
            message.textContent = '거래중단 거래처는 자동 선택할 수 없습니다. Master에서 재활성화해 주세요.';
            return;
          }
          finish(item.customer);
        });
      });
    };
    const create = async allowDuplicate => {
      const customerName = input.value.trim();
      if (!customerName) {
        message.textContent = '등록할 거래처명을 입력해 주세요.';
        return;
      }
      try {
        const customer = await createLiveCustomer({ customerName }, { source, allowDuplicate });
        finish(customer);
      } catch (error) {
        if (error.code === 'CUSTOMER_DUPLICATE_CANDIDATE') {
          message.textContent = '비슷한 거래처가 있습니다. 기존 거래처를 선택하거나 새 등록을 확정하세요.';
          forceButton.hidden = false;
          return;
        }
        message.textContent = error.message;
      }
    };
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(render, 100);
      forceButton.hidden = true;
    });
    createButton?.addEventListener('click', () => create(false));
    forceButton?.addEventListener('click', () => create(true));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener('close', () => {
      if (dialog.isConnected) finish(null);
    }, { once: true });
    dialog.showModal();
    render();
  });
}
