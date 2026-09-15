import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const original = readFileSync(join(root, 'orderops/list.html'), 'utf8');
const html = original.replace(
  'initializeLocalRecovery().then(loadOrderQSourceFromRoute)',
  'globalThis.__negativeTabTest = { state, renderPreview, getPreviewDefinitions, captureOrderViewPreset, textFilterValueKey }; initializeLocalRecovery().then(loadOrderQSourceFromRoute)',
).replace('https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js', '/customer-master/vendor/xlsx.full.min.js');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(resolve(root) + sep) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(pathname === '/orderops/list.html' ? html : readFileSync(file));
});

const profile = mkdtempSync(join(tmpdir(), 'orderops-negative-tab-'));
const command = name => {
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : '';
};
const chrome = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  command('google-chrome'),
  command('chromium'),
].filter(Boolean).find(existsSync);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket;
try {
  assert.ok(existsSync(chrome), 'Chrome required for purchase Tab browser test');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port;
  for (let i = 0; i < 250; i++) {
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]; break; }
    catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error; await wait(80); }
  }
  assert.ok(port, 'Chrome DevTools port not ready');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (request) message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result);
    }
    if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const allowed = request.url.startsWith(origin + '/') && ['GET', 'HEAD'].includes(request.method);
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' });
    }
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 250; i++) { if (await evaluate(expression)) return; await wait(80); }
    throw Error(`Timeout: ${label}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const tab = async (shift = false) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });
    await wait(100);
    return evaluate('document.activeElement?.dataset.purchaseCode || ""');
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin + '/orderops/list.html' });
  await until('Boolean(globalThis.__negativeTabTest?.state.db && globalThis.XLSX)', 'OrderOps ready');

  const inventory = [
    ['사용', '품목코드', '단위', '품목명', '규격', '수량', '1창고'],
    ['Yes', 'NEG-001', 'EA', '첫 부족상품', 'EA', 4, 4],
    ['Yes', 'NEG-002', 'EA', '둘째 부족상품', 'EA', 20, 20],
    ['Yes', 'POS-003', 'EA', '충분상품', 'EA', 8, 8],
  ];
  const orders = [
    ['일자-No.', '담당', '창고', '단위', '품목코드', '품목명', '규격', '수량', '재고', '단가', '공급가액', '적요', '적요1', '거래처', '그룹'],
    ['2026/09/16-001', '담당 A', '1창고', 'EA', 'NEG-001', '첫 부족상품', 'EA', 10, 0, 1000, 10000, '', '', '거래처 A', 'A'],
    ['2026/09/16-002', '담당 B', '1창고', 'EA', 'NEG-002', '둘째 부족상품', 'EA', 30, 0, 1000, 30000, '', '', '거래처 B', 'B'],
  ];
  async function upload(kind, matrix) {
    const name = `negative-tab-${kind}.xlsx`;
    await evaluate(`(() => {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(${JSON.stringify(matrix)}), '${kind === 'orders' ? '주문현황' : '창고별재고'}');
      const transfer = new DataTransfer();
      transfer.items.add(new File([XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })], '${name}'));
      const input = document.querySelector('#${kind}Input');
      Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await until(`Boolean([...document.querySelectorAll('#prepareFileList button')].find(button => button.textContent.includes('${name}'))?.querySelector('[data-prepare-state="READY"]'))`, `${name} ready`);
    await click('#prepareApplyButton');
    await until(`Boolean([...document.querySelectorAll('#prepareFileList button')].find(button => button.textContent.includes('${name}'))?.querySelector('[data-prepare-state="APPLIED"]'))`, `${name} applied`);
  }
  await upload('inventory', inventory);
  await upload('orders', orders);
  await click('[data-preview="inventory"]');
  const fixture = await evaluate(`(() => {
    const test = __negativeTabTest;
    const preview = test.getPreviewDefinitions(test.state.workspace).inventory;
    const index = preview.columns.findIndex(column => column.role === 'calculatedQuantity');
    const key = preview.columns[index].key;
    const values = preview.rows.map(row => row[index]);
    const negatives = values.filter(value => typeof value === 'number' && value < 0);
    test.state.columnFilters.inventory = { [key]: { allowedValues: negatives.map(test.textFilterValueKey) } };
    test.state.orderViewPresets = [{ id: 'negative-balance', name: '잔량마이너스', previewId: 'inventory', isDefault: false, view: test.captureOrderViewPreset() }];
    test.renderPreview();
    document.querySelector('#viewPresetSelect').value = 'negative-balance';
    document.querySelector('#viewPresetSelect').dispatchEvent(new Event('change', { bubbles: true }));
    return { values, negatives, preset: document.querySelector('#viewPresetSelect').value, codes: [...document.querySelectorAll('.purchase-input[data-negative-balance="true"]')].map(input => input.dataset.purchaseCode) };
  })()`);
  assert.equal(fixture.preset, 'negative-balance');
  assert.deepEqual(fixture.codes, ['NEG-001', 'NEG-002'], 'saved negative-balance form displays the two actual shortages');

  const draft = await evaluate(`(() => {
    const input = document.querySelector('.purchase-input[data-purchase-code="NEG-001"]');
    input.focus();
    input.value = '재렌더 보존 구매처';
    __negativeTabTest.renderPreview();
    const rendered = document.querySelector('.purchase-input[data-purchase-code="NEG-001"]');
    return { rendered: rendered?.value, stored: ShippingManagementEngine.getPurchaseInputs(__negativeTabTest.state.workspace)['NEG-001'] };
  })()`);
  assert.deepEqual(draft, { rendered: '재렌더 보존 구매처', stored: '재렌더 보존 구매처' }, 'focused purchase text must survive a form/table rerender');
  const liveInput = await evaluate(`(() => {
    const input = document.querySelector('.purchase-input[data-purchase-code="NEG-002"]');
    input.focus();
    input.value = '입력 이벤트 구매처';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    __negativeTabTest.renderPreview();
    return {
      rendered: document.querySelector('.purchase-input[data-purchase-code="NEG-002"]')?.value,
      stored: ShippingManagementEngine.getPurchaseInputs(__negativeTabTest.state.workspace)['NEG-002'],
    };
  })()`);
  assert.deepEqual(liveInput, { rendered: '입력 이벤트 구매처', stored: '입력 이벤트 구매처' }, 'ordinary typed purchase text must survive rerender');

  await evaluate('document.querySelector(".purchase-input[data-purchase-code=NEG-001]").focus(); true');
  assert.equal(await tab(), 'NEG-002', 'Tab jumps to the next visible shortage');
  assert.equal(await tab(), 'NEG-001', 'Tab wraps from the last shortage to the first');
  assert.equal(await tab(true), 'NEG-002', 'Shift+Tab wraps backward through visible shortages');
  const point = await evaluate(`(() => {
    const input = document.querySelector('.purchase-input[data-purchase-code="NEG-002"]');
    const remaining = document.querySelector('td.ledger-negative-cell .inventory-total-frame');
    return { input: getComputedStyle(input).boxShadow, remaining: getComputedStyle(remaining).boxShadow };
  })()`);
  assert.match(point.input, /251, 113, 133/, 'negative purchase editor retains the rose point line');
  assert.match(point.remaining, /251, 113, 133/, 'negative remaining cell retains the rose point line');
  await click('[data-preview="allocations"]');
  await click('[data-preview="inventory"]');
  assert.deepEqual(await evaluate(`(() => {
    const inputs = ShippingManagementEngine.getPurchaseInputs(__negativeTabTest.state.workspace);
    return [inputs['NEG-001'], inputs['NEG-002'], document.querySelector('.purchase-input[data-purchase-code="NEG-001"]')?.value, document.querySelector('.purchase-input[data-purchase-code="NEG-002"]')?.value];
  })()`), ['재렌더 보존 구매처', '입력 이벤트 구매처', '재렌더 보존 구매처', '입력 이벤트 구매처'], 'purchase values survive switching result screens');
  await click('#analyzeButton');
  await until('__negativeTabTest.state.workspace.workspaceMode !== ShippingManagementEngine.PREVIEW_WORKSPACE_MODE', 'analysis complete');
  await click('[data-preview="inventory"]');
  assert.deepEqual(await evaluate(`(() => {
    const inputs = ShippingManagementEngine.getPurchaseInputs(__negativeTabTest.state.workspace);
    return [inputs['NEG-001'], inputs['NEG-002'], document.querySelector('.purchase-input[data-purchase-code="NEG-001"]')?.value, document.querySelector('.purchase-input[data-purchase-code="NEG-002"]')?.value];
  })()`), ['재렌더 보존 구매처', '입력 이벤트 구매처', '재렌더 보존 구매처', '입력 이벤트 구매처'], 'purchase values survive final analysis');
  await evaluate('document.querySelector(".purchase-input[data-purchase-code=NEG-001]").focus(); true');
  assert.equal(await tab(), 'NEG-002', 'analyzed negative-balance form retains purchase Tab navigation');
  await evaluate(`(() => {
    const test = __negativeTabTest;
    const preview = test.getPreviewDefinitions(test.state.workspace).inventory;
    const column = preview.columns.find(candidate => candidate.role === 'calculatedQuantity');
    const index = preview.columns.indexOf(column);
    const firstNegative = preview.rows.map(row => row[index]).find(value => typeof value === 'number' && value < 0);
    test.state.columnFilters.inventory = { [column.key]: { allowedValues: [test.textFilterValueKey(firstNegative)] } };
    test.renderPreview();
    document.querySelector('.purchase-input[data-purchase-code="NEG-001"]').focus();
    return true;
  })()`);
  assert.equal(await tab(), 'NEG-001', 'one visible shortage keeps purchase focus on Tab');
  assert.equal(await tab(true), 'NEG-001', 'one visible shortage keeps purchase focus on Shift+Tab');
  await evaluate('document.documentElement.dataset.nexusUiTheme = "dark"; true');
  const darkPoint = await evaluate(`(() => ({
    input: getComputedStyle(document.querySelector('.purchase-input[data-purchase-code="NEG-001"]')).boxShadow,
    remaining: getComputedStyle(document.querySelector('td.ledger-negative-cell .inventory-total-frame')).boxShadow,
  }))()`);
  assert.match(darkPoint.input, /251, 113, 133/, 'dark purchase editor retains the rose point line');
  assert.match(darkPoint.remaining, /251, 113, 133/, 'dark remaining cell retains the rose point line');
  console.log('PASS saved negative-balance form: purchase text retention, Tab/Shift+Tab wrap, and rose point color', JSON.stringify({ fixture, draft, liveInput, point, darkPoint }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (browser?.pid && process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else browser?.kill();
  server.close();
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), 'test Chrome profile must stay within the temporary directory');
  await wait(150);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
  catch (error) { console.warn(`Temporary Chrome profile cleanup deferred: ${error.code}`); }
}
