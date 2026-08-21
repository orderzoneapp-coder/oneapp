import { openCustomerPicker, readyCustomerPicker } from './customer-picker.js?v=0.12.1';

function findNameInput() {
  return document.querySelector('[data-customer-picker], #customerPreset, #customerName, [name="customerName"]');
}

function setSelectedCustomer(input, customer) {
  input.value = customer.customerName;
  input.dataset.customerId = customer.customerId;
  const idField = document.querySelector('#customerId, [name="customerId"]');
  if (idField) idField.value = customer.customerId;
  input.dispatchEvent(new CustomEvent('customer:selected', { bubbles: true, detail: { customer } }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function addPickerButton(input) {
  if (!input || input.dataset.customerPickerBound === 'true') return;
  input.dataset.customerPickerBound = 'true';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'customer-picker-trigger';
  button.textContent = '찾기 / 간편등록';
  button.addEventListener('click', async () => {
    const customer = await openCustomerPicker({ initialName: input.value, source: 'LIVE_CREATE' });
    if (customer) setSelectedCustomer(input, customer);
  });
  input.insertAdjacentElement('afterend', button);
}

function addMasterLauncher() {
  if (location.pathname.endsWith('/partner_db.html') || document.querySelector('.customer-master-launcher')) return;
  const launcher = document.createElement('a');
  launcher.className = 'customer-master-launcher';
  launcher.href = '../partner_db.html';
  launcher.textContent = '거래처 Master';
  launcher.title = '거래처 Master 열기';
  document.body.append(launcher);
}

async function boot() {
  addMasterLauncher();
  addPickerButton(findNameInput());
  await readyCustomerPicker({
    onLoading: message => {
      const input = findNameInput();
      if (input && !input.value) input.placeholder = message;
    }
  });
}

boot().catch(error => console.warn('Customer picker bootstrap failed', error));
