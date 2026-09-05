import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserProfile = mkdtempSync(join(tmpdir(), 'oneapp-master-consolidation-e2e-'));
const initialCode = 'E2E-INITIAL-001';
const testCode = 'E2E-SINGLE-001';
const originalName = '상품관리 저장 검증 상품';
const editedName = '상품관리 수정 검증 상품';

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = createServer((request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relativePath = requestPath === '/' ? 'Master.html' : requestPath.replace(/^\/+/, '');
    const filePath = normalize(resolve(root, relativePath));
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    response.end(readFileSync(filePath));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

const listen = () => new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
});

const commandPath = command => {
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (lookup.status !== 0) return '';
  return lookup.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
};

const findBrowser = () => {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' && process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    process.platform === 'win32' && process.env['PROGRAMFILES(X86)']
      ? join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    process.platform === 'win32' && process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : '',
    commandPath('google-chrome'),
    commandPath('google-chrome-stable'),
    commandPath('chromium'),
    commandPath('chromium-browser'),
    commandPath('chrome'),
    commandPath('msedge')
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || '';
};

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

const waitFor = async (check, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      const listeners = this.events.get(message.method) || [];
      listeners.forEach(listener => listener(message.params));
    });
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', rejectOpen, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeout = 30_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        this.removeListener(method, listener);
        rejectEvent(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeout);
      const listener = params => {
        clearTimeout(timer);
        this.removeListener(method, listener);
        resolveEvent(params);
      };
      const listeners = this.events.get(method) || [];
      listeners.push(listener);
      this.events.set(method, listeners);
    });
  }

  removeListener(method, listener) {
    const listeners = this.events.get(method) || [];
    this.events.set(method, listeners.filter(candidate => candidate !== listener));
  }

  on(method, listener) {
    const listeners = this.events.get(method) || [];
    listeners.push(listener);
    this.events.set(method, listeners);
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) {
    const details = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || 'Browser evaluation failed';
    throw new Error(details);
  }
  return response.result.value;
};

const waitForExpression = (client, expression, label, timeout = 30_000) => waitFor(
  () => evaluate(client, expression),
  label,
  timeout
);

const setLabeledInput = (client, label, value) => evaluate(client, `(() => {
  const targetLabel = Array.from(document.querySelectorAll('label')).find(label =>
    label.querySelector('span')?.textContent.trim().startsWith(${JSON.stringify(label)})
  );
  const input = targetLabel?.querySelector('input');
  if (!input) throw new Error('Input not found: ' + ${JSON.stringify(label)});
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.value;
})()`);

const clickButton = (client, exactText) => evaluate(client, `(() => {
  const buttons = Array.from(document.querySelectorAll('button')).filter(button =>
    button.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(exactText)}
  );
  const button = buttons.at(-1);
  if (!button) throw new Error('Button not found: ' + ${JSON.stringify(exactText)});
  button.click();
  return true;
})()`);

const clickModalButton = (client, headingText, buttonText) => evaluate(client, `(() => {
  const heading = Array.from(document.querySelectorAll('h2')).find(heading =>
    heading.textContent.trim() === ${JSON.stringify(headingText)}
  );
  const modal = heading?.closest('.fixed');
  const button = Array.from(modal?.querySelectorAll('button') || []).find(button =>
    button.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(buttonText)}
  );
  if (!button) throw new Error('Modal button not found: ' + ${JSON.stringify(buttonText)});
  button.click();
  return true;
})()`);

const readStoredProduct = (client, code) => evaluate(client, `new Promise((resolve, reject) => {
  const request = indexedDB.open('MerchOpsDB', 2);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction(['master_products', 'store'], 'readonly');
    const productRequest = tx.objectStore('master_products').get(${JSON.stringify(code)});
    const revisionRequest = tx.objectStore('store').get('merchMaster_revision_v870');
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => {
      let history = [];
      try { history = JSON.parse(localStorage.getItem('merchHistory_v870') || '[]'); } catch (error) {}
      const result = { product: productRequest.result || null, revision: revisionRequest.result, history };
      db.close();
      resolve(result);
    };
  };
})`);

const uploadWorkbook = (client, rows, fileName) => evaluate(client, `(() => {
  const rows = ${JSON.stringify(rows)};
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '상품');
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const file = new File([bytes], ${JSON.stringify(fileName)}, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const input = Array.from(document.querySelectorAll('input[type="file"]')).find(candidate => candidate.accept.includes('.xlsx'));
  if (!input) throw new Error('Master Excel input not found');
  const transfer = new DataTransfer();
  transfer.items.add(file);
  Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

const seedLegacyProducts = (client, products, revision = 7) => evaluate(client, `new Promise((resolve, reject) => {
  const request = indexedDB.open('oneapp-itemmaster-isolated-v1', 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: '코드' });
    if (!db.objectStoreNames.contains('store')) db.createObjectStore('store');
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction(['products', 'store'], 'readwrite');
    const store = tx.objectStore('products');
    ${JSON.stringify(products)}.forEach(product => store.put(product));
    tx.objectStore('store').put(${JSON.stringify(revision)}, 'itemMasterRevision_v1');
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => reject(tx.error);
  };
})`);

const readLegacyProducts = client => evaluate(client, `new Promise((resolve, reject) => {
  const request = indexedDB.open('oneapp-itemmaster-isolated-v1');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction('products', 'readonly');
    const values = tx.objectStore('products').getAll();
    tx.oncomplete = () => { db.close(); resolve(values.result || []); };
    tx.onerror = () => reject(tx.error);
  };
})`);

let browserProcess;
let client;

try {
  const address = await listen();
  const browserExecutable = findBrowser();
  assert.ok(browserExecutable, 'Chrome, Chromium, or Edge is required for ItemMaster browser E2E');

  browserProcess = spawn(browserExecutable, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--ignore-certificate-errors',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${browserProfile}`,
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  const activePortFile = join(browserProfile, 'DevToolsActivePort');
  await waitFor(() => existsSync(activePortFile), 'browser debugging port');
  const [debugPort] = readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) return null;
    const values = await response.json();
    return values.find(target => target.type === 'page') ? values : null;
  }, 'browser page target');
  const target = targets.find(value => value.type === 'page');

  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  const runtimeErrors = [];
  const consoleErrors = [];
  client.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Runtime exception'));
  client.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') consoleErrors.push(event.args?.map(value => value.value || value.description || '').join(' ') || 'console.error'); });

  let pageLoaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/Master.html` });
  await pageLoaded;
  await waitForExpression(
    client,
    `document.body?.innerText.includes('Excel 최초 등록 또는 상품 단건 등록으로 시작하세요')`,
    'empty official Master application'
  );
  assert.equal(await evaluate(client, `document.querySelector('[data-legacy-itemmaster-notice]') === null`), true);

  await uploadWorkbook(client, [
    ['코드', '품목명', '규격', '단위'],
    ['E2E-DUP', '중복 1', '1EA', 'EA'],
    ['E2E-DUP', '중복 2', '1EA', 'EA']
  ], 'invalid-duplicate.xlsx');
  await waitForExpression(client, `document.body?.innerText.includes('최초 등록 검증 실패')`, 'initial duplicate-code validation');
  assert.equal((await readStoredProduct(client, 'E2E-DUP')).product, null);

  await uploadWorkbook(client, [
    ['코드', '품목명', '규격', '단위', '1코드', '1그룹명', '2코드', '2그룹명', '3코드', '3그룹명'],
    [initialCode, '최초 Excel 상품', '1EA', 'EA', 'E2E-C1', 'E2E 대분류', 'E2E-C2', 'E2E 중분류', 'E2E-C3', 'E2E 소분류']
  ], 'initial-master.xlsx');
  await waitForExpression(client, `document.body?.innerText.includes('상품관리 최초 Excel 등록')`, 'initial Excel confirmation');
  await clickModalButton(client, '상품관리 최초 Excel 등록', '1건 최초 저장');
  const initial = await waitFor(async () => {
    const state = await readStoredProduct(client, initialCode);
    return state.product?.품목명 === '최초 Excel 상품' && state.revision ? state : null;
  }, 'initial product in official IndexedDB');
  assert.ok(initial.history.some(log => log.recordType === 'master_initial_registration_job'));

  await clickButton(client, '상품 등록');
  await waitForExpression(client, `document.body?.innerText.includes('상품 단건 등록')`, 'product registration modal');
  await clickModalButton(client, '상품 단건 등록', '상품 등록');
  await waitForExpression(client, `document.body?.innerText.includes('필수값을 입력하세요')`, 'single-product required validation');
  await setLabeledInput(client, '상품코드', testCode);
  await setLabeledInput(client, '품목명', originalName);
  await setLabeledInput(client, '규격', '1EA');
  await setLabeledInput(client, '단위', 'EA');
  await setLabeledInput(client, '대분류 코드', 'E2E-C1');
  await setLabeledInput(client, '대분류명', 'E2E 대분류');
  await setLabeledInput(client, '중분류 코드', 'E2E-C2');
  await setLabeledInput(client, '중분류명', 'E2E 중분류');
  await setLabeledInput(client, '소분류 코드', 'E2E-C3');
  await setLabeledInput(client, '소분류명', 'E2E 소분류');
  await clickModalButton(client, '상품 단건 등록', '상품 등록');

  const saved = await waitFor(async () => {
    const state = await readStoredProduct(client, testCode);
    return state.product?.품목명 === originalName && state.revision !== initial.revision ? state : null;
  }, 'registered product in official IndexedDB');
  assert.equal(saved.product.코드, testCode);
  assert.ok(saved.history.some(log => log.code === testCode && log.actionType === 'master_create'));

  await clickButton(client, '상품 등록');
  await setLabeledInput(client, '상품코드', testCode);
  await setLabeledInput(client, '품목명', '중복 차단 상품');
  await setLabeledInput(client, '규격', '1EA');
  await setLabeledInput(client, '단위', 'EA');
  await clickModalButton(client, '상품 단건 등록', '상품 등록');
  await waitForExpression(client, `document.body?.innerText.includes('이미 등록된 상품코드입니다')`, 'single-product duplicate validation');
  assert.equal((await readStoredProduct(client, testCode)).revision, saved.revision);
  await clickModalButton(client, '상품 단건 등록', '취소');

  await waitForExpression(client, `document.body?.innerText.includes(${JSON.stringify(testCode)})`, 'registered product row');
  await evaluate(client, `(() => {
    const row = Array.from(document.querySelectorAll('tr')).find(row => row.textContent.includes(${JSON.stringify(testCode)}));
    const button = Array.from(row?.querySelectorAll('button') || []).find(button => button.textContent.includes('수정'));
    if (!button) throw new Error('Edit button not found');
    button.click();
    return true;
  })()`);
  await setLabeledInput(client, '품목명', editedName);
  await clickModalButton(client, '상품 수정', '수정 저장');
  const edited = await waitFor(async () => {
    const state = await readStoredProduct(client, testCode);
    return state.product?.품목명 === editedName && state.revision !== saved.revision ? state : null;
  }, 'edited product in official IndexedDB');
  assert.ok(edited.history.some(log => log.code === testCode && log.field === '품목명' && log.newVal === editedName));

  await evaluate(client, `(() => {
    const row = Array.from(document.querySelectorAll('tr')).find(row => row.textContent.includes(${JSON.stringify(testCode)}));
    Array.from(row?.querySelectorAll('button') || []).find(button => button.textContent.includes('수정')).click();
    return true;
  })()`);
  await setLabeledInput(client, '품목명', '충돌로 저장되지 않을 이름');
  await evaluate(client, `(async () => {
    const state = await ONEAPP.STORAGE.readMasterSnapshotState();
    return ONEAPP.STORAGE.commitMasterStateOrThrow(state.masterMap, { expectedRevision: state.revision });
  })()`);
  await clickModalButton(client, '상품 수정', '수정 저장');
  await waitForExpression(client, `document.body?.innerText.includes('입력 중 master가 변경되어 저장을 중단했습니다')`, 'single-product revision conflict');
  assert.equal((await readStoredProduct(client, testCode)).product?.품목명, editedName);
  await clickModalButton(client, '상품 수정', '취소');

  pageLoaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await pageLoaded;
  await waitForExpression(client, `document.body?.innerText.includes(${JSON.stringify(editedName)})`, 'edited product after reload');
  const reloaded = await readStoredProduct(client, testCode);
  assert.equal(reloaded.product?.품목명, editedName);

  // The duplicate and revision-conflict cases above intentionally exercise
  // visible error paths. Measure console safety from the normal owner/inbox
  // and compatibility flows that follow.
  runtimeErrors.length = 0;
  consoleErrors.length = 0;

  await seedLegacyProducts(client, [
    {
      코드: 'LEGACY-NEW-001', 품목코드: 'LEGACY-NEW-001', 품목명: '레거시 신규 상품', 규격: '1EA', 단위: 'EA',
      '1코드': 'LEGACY-C1', '1그룹명': '레거시', '2코드': 'LEGACY-C2', '2그룹명': '레거시', '3코드': 'LEGACY-C3', '3그룹명': '레거시'
    },
    { ...initial.product, 품목명: '충돌 레거시 이름' },
    reloaded.product
  ]);
  pageLoaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await pageLoaded;
  await waitForExpression(client, `document.body?.innerText.includes('폐기된 ItemMaster 격리 DB 데이터 3건')`, 'legacy data notice');
  assert.equal(await evaluate(client, `document.body.innerText.includes('신규 1건 · 동일 1건 · 충돌 1건')`), true);

  await evaluate(client, `(() => {
    window.__legacyDownload = null;
    HTMLAnchorElement.prototype.click = function () { window.__legacyDownload = { download: this.download, href: this.href }; };
    return true;
  })()`);
  await clickButton(client, 'JSON 백업');
  assert.match((await evaluate(client, `window.__legacyDownload?.download || ''`)), /^ItemMaster-legacy-backup-/);

  await clickButton(client, '정보수정 Excel 검토');
  await waitForExpression(client, `document.body?.innerText.includes('정보수정 Excel 확인요청')`, 'legacy review confirmation');
  assert.equal((await readStoredProduct(client, initialCode)).product?.품목명, '최초 Excel 상품');
  await clickModalButton(client, '정보수정 Excel 확인요청', '이슈 확인 화면으로 이동');
  await waitForExpression(client, `document.body?.innerText.includes('LEGACY-NEW-001')`, 'legacy review candidates');
  await evaluate(client, `(() => {
    const section = Array.from(document.querySelectorAll('section')).find(item => item.textContent.includes('LEGACY-NEW-001'));
    const approve = Array.from(section?.querySelectorAll('button') || []).find(button => button.textContent.includes('상품 전체 승인'));
    if (!approve) throw new Error('Legacy approve button not found');
    approve.click();
    return true;
  })()`);
  await wait(100);
  await evaluate(client, `(() => {
    const section = Array.from(document.querySelectorAll('section')).find(item => item.textContent.includes('LEGACY-NEW-001'));
    const checkbox = section?.querySelector('input[type="checkbox"]');
    if (!checkbox || checkbox.disabled) throw new Error('Legacy admin-complete checkbox unavailable');
    checkbox.click();
    return true;
  })()`);
  await clickButton(client, '승인 범위 저장');
  const imported = await waitFor(async () => {
    const state = await readStoredProduct(client, 'LEGACY-NEW-001');
    return state.product?.품목명 === '레거시 신규 상품' ? state : null;
  }, 'selectively imported legacy product');
  assert.equal((await readStoredProduct(client, initialCode)).product?.품목명, '최초 Excel 상품');
  assert.equal((await readLegacyProducts(client)).length, 3);
  assert.ok(imported.history.some(log => log.code === 'LEGACY-NEW-001'));

  const requestReceipt = await evaluate(client, `(async()=>{
    const module=await import('/reference-data/product-change-request-adapter.js?master-ui=1');
    return module.productMasterChangeRequestAdapter.submitChangeRequest({
      schemaVersion:'ONEAPP_REFERENCE_CHANGE_REQUEST_V1',requestId:'MASTER-UI-REQ-1',idempotencyKey:'MASTER-UI-IDEM-1',
      domain:'PRODUCT',ownerAppId:'master-lookup',entityId:${JSON.stringify(testCode)},operation:'UPDATE',
      baseSnapshotId:'PRODUCT-${edited.revision}',baseRevision:${JSON.stringify(edited.revision)},
      changes:[{field:'품목명',beforeValue:${JSON.stringify(editedName)},proposedValue:'검토 제안 상품명'}],
      reason:'Master inbox browser test',source:{appId:'browser-test'},actor:{actorId:null,actorName:'browser',actorState:'UNVERIFIED_LOCAL'},requestedAt:'2026-08-30T00:00:00.000Z'
    });
  })()`);
  assert.equal(requestReceipt.status, 'PENDING', JSON.stringify(requestReceipt));
  try {
    await waitForExpression(client, `document.querySelector('[data-product-change-request-inbox="READY"]')?.innerText.includes('검토 제안 상품명') && document.body.innerText.includes('관리자가 원본과 반영 예정값을 확인한 뒤 처리합니다.')`, 'product change-request work inbox');
  } catch (error) {
    const diagnostic = await evaluate(client, `({status:document.querySelector('[data-product-change-request-inbox]')?.getAttribute('data-product-change-request-inbox'),text:document.querySelector('[data-product-change-request-inbox]')?.innerText,global:window.ONEAPP_PRODUCT_MASTER_CHANGE_REQUEST_ADAPTER?.version})`);
    throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
  }

  pageLoaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/ItemMaster.html` });
  await pageLoaded;
  assert.equal(await evaluate(client, `document.title`), '상품관리 주소 안내 - NEXUS');
  assert.equal(await evaluate(client, `document.querySelectorAll('script').length`), 0);
  assert.equal(await evaluate(client, `document.querySelector('a[href="Master.html"]')?.textContent.trim()`), '공식 상품관리로 이동');

  pageLoaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/Item_manager.html` });
  await pageLoaded;
  assert.equal(await evaluate(client, `document.title`), 'SKU 관리 - NEXUS');
  assert.equal(await evaluate(client, `document.body.innerText.includes('← 상품관리') && document.body.innerText.includes('상품관리 〉 SKU 관리')`), true);

  assert.deepEqual(runtimeErrors, [], `browser runtime errors: ${runtimeErrors.join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(' | ')}`);

  console.log('PASS Master initial registration, inbox diagnostics, console, legacy safety, and ItemMaster compatibility');
} finally {
  client?.close();
  if (browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
    const exited = new Promise(resolveExit => {
      const timeout = setTimeout(resolveExit, 2_000);
      browserProcess.once('exit', () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
    browserProcess.kill();
    await exited;
  }
  await new Promise(resolveClose => server.close(() => resolveClose()));
  try {
    rmSync(browserProfile, { recursive: true, force: true });
  } catch {
    // Browser profile cleanup failure must not hide the application test result.
  }
}
