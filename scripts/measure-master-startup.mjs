import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)));
const iterations = Math.max(2, Number(process.argv[3] || 8));
assert.ok(existsSync(join(root, 'Master.html')), `Master.html not found under ${root}`);
const profile = mkdtempSync(join(tmpdir(), 'oneapp-master-startup-'));
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml'
};

const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? 'Master.html' : pathname.replace(/^\/+/, '');
    const file = normalize(resolve(root, relative));
    if (file !== root && !file.startsWith(`${root}${sep}`)) return response.writeHead(403).end('Forbidden');
    if (!existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end('Not found');
    response.writeHead(200, {
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream'
    });
    response.end(readFileSync(file));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

const listen = () => new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
});
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
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};
const commandPath = command => {
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
  if (lookup.status !== 0) return '';
  return lookup.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
};
const findBrowser = () => [
  process.env.CHROME_PATH,
  process.platform === 'win32' && process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.platform === 'win32' && process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.platform === 'win32' && process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
  commandPath('google-chrome'), commandPath('chromium'), commandPath('msedge')
].filter(Boolean).find(existsSync) || '';

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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
  close() { if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(); }
}

const evaluate = async (client, expression) => {
  const response = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'evaluation failed');
  return response.result.value;
};
const percentile = (values, ratio) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1];

let browserProcess;
let client;
try {
  const address = await listen();
  const executable = findBrowser();
  assert.ok(executable, 'Chrome, Chromium, or Edge is required');
  browserProcess = spawn(executable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  const portFile = join(profile, 'DevToolsActivePort');
  await waitFor(() => existsSync(portFile), 'browser debugging port');
  const [debugPort] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) return null;
    return (await response.json()).find(item => item.type === 'page');
  }, 'browser target');
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    await client.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/Master.html` });
    const ready = await waitFor(() => evaluate(client, `(() => {
      const header = document.querySelector('[data-nexus-app-header="master-lookup"]');
      const empty = document.body?.innerText.includes('Excel 최초 등록 또는 상품 단건 등록으로 시작하세요');
      if (!header || !empty) return 0;
      return performance.now();
    })()`), 'Master first-work state');
    samples.push(Math.round(ready * 10) / 10);
  }
  const warm = samples.slice(1);
  console.log(JSON.stringify({
    root,
    iterations,
    coldMs: samples[0],
    warmSamplesMs: warm,
    warmMedianMs: percentile(warm, 0.5),
    warmP95Ms: percentile(warm, 0.95)
  }, null, 2));
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
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (_) {
    // Windows may keep Chromium profile handles briefly after the measured process exits.
  }
}
