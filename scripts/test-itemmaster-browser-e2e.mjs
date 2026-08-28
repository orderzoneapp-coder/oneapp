import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserProfile = mkdtempSync(join(tmpdir(), 'oneapp-itemmaster-e2e-'));
const testCode = 'E2E-ITEM-001';
const originalName = 'ItemMaster 저장 검증 상품';
const editedName = 'ItemMaster 수정 검증 상품';

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
    const relativePath = requestPath === '/' ? 'ItemMaster.html' : requestPath.replace(/^\/+/, '');
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
  const request = indexedDB.open('oneapp-itemmaster-isolated-v1', 1);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction(['products', 'store'], 'readonly');
    const productRequest = tx.objectStore('products').get(${JSON.stringify(code)});
    const revisionRequest = tx.objectStore('store').get('itemMasterRevision_v1');
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => {
      const result = { product: productRequest.result || null, revision: revisionRequest.result };
      db.close();
      resolve(result);
    };
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

  let pageLoaded = client.once('Page.loadEventFired');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/ItemMaster.html` });
  await pageLoaded;
  await waitForExpression(
    client,
    `document.body?.innerText.includes('Excel 최초 등록 또는 단건 등록으로 시작하세요')`,
    'empty ItemMaster application'
  );

  await clickButton(client, '상품 등록');
  await waitForExpression(client, `document.body?.innerText.includes('상품 단건 등록')`, 'product registration modal');
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
    return state.product?.품목명 === originalName && state.revision === 1 ? state : null;
  }, 'registered product in IndexedDB');
  assert.equal(saved.product.코드, testCode);
  assert.equal(saved.revision, 1);

  await waitForExpression(client, `document.body?.innerText.includes(${JSON.stringify(testCode)})`, 'registered product row');
  await evaluate(client, `(() => {
    const row = Array.from(document.querySelectorAll('tr')).find(row => row.textContent.includes(${JSON.stringify(testCode)}));
    const button = Array.from(row?.querySelectorAll('button') || []).find(button => button.textContent.includes('수정'));
    if (!button) throw new Error('Edit button not found');
    button.click();
    return true;
  })()`);
  await waitForExpression(client, `document.body?.innerText.includes('상품 수정')`, 'product edit modal');
  await setLabeledInput(client, '품목명', editedName);
  await clickModalButton(client, '상품 수정', '수정 저장');

  const edited = await waitFor(async () => {
    const state = await readStoredProduct(client, testCode);
    return state.product?.품목명 === editedName && state.revision === 2 ? state : null;
  }, 'edited product in IndexedDB');
  assert.equal(edited.revision, 2);

  pageLoaded = client.once('Page.loadEventFired');
  await client.send('Page.reload', { ignoreCache: true });
  await pageLoaded;
  await waitForExpression(client, `document.body?.innerText.includes(${JSON.stringify(editedName)})`, 'edited product after reload');
  const reloaded = await readStoredProduct(client, testCode);
  assert.equal(reloaded.product?.품목명, editedName);
  assert.equal(reloaded.revision, 2);

  console.log('PASS ItemMaster browser registration, edit, and reload persistence');
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
