#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch {}
const root = process.cwd();
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const component = read('nexus/common/nexus-company-footer.js');
const auth = read('nexus/common/nexus-auth.js');
const home = read('nexus/home/home.js');
const company = read('nexus/company.js');
const manifest = JSON.parse(read('app-manifest.json'));
const contract = manifest.sharedDataContracts.find(item => item.id === 'company-public-footer');
const expectedFields = ['companyName', 'businessNumber', 'representativeName', 'companyPhone', 'businessAddress', 'homepage', 'revision'];
const forbiddenPublicFields = ['openingDate', 'taxationType', 'businessTypes', 'businessItems', 'homePhone', 'mobile', 'email', 'taxInvoiceEmail', 'accountingPeriods', 'ocr', 'audit'];

assert(contract, 'company-public-footer must be registered');
assert.deepEqual(contract.publicFields, expectedFields);
assert.equal(contract.schemaVersion, 'NEXUS_COMPANY_PUBLIC_FOOTER_V1');
assert.equal(contract.resources.component, 'nexus/common/nexus-company-footer.js');
assert.match(auth, /nexus-company-footer\.js\?v=\$\{COMPANY_FOOTER_VERSION\}/);
assert.match(auth, /const COMPANY_FOOTER_VERSION = '1\.0\.0'/);
assert.match(auth, /if \(PUBLIC_PATH \|\| window\.ONEAPP_COMPANY_PUBLIC/,
  'the common auth bootstrap must install one Footer on every protected NEXUS screen but not the login page');
assert.doesNotMatch(home, /company\.profile_read|ONEAPP_AUTH\.gateway/,
  'home must render the public Snapshot without a direct company server dependency');
assert.match(company, /ONEAPP_COMPANY_PUBLIC\?\.acceptGatewayResult\(result, 'admin-save'\)/,
  'an administrator profile save must update the public Snapshot from the verified response');
assert.match(component, /window\.setTimeout\(\(\) => \{ void revalidate\(\); \}, 0\)/,
  'background verification must start only after the synchronous Footer mount');
assert.match(component, /body\.nexus-company-footer-mounted>#root>\.h-screen/,
  'fixed-height workspaces must reserve Footer height instead of losing bottom controls beneath the Footer');
assert.doesNotMatch(component, /await\s+window\.ONEAPP_AUTH\.ready|await\s+auth\.ready/,
  'Footer initial rendering must never await authentication readiness');

for (const file of contract.consumers) {
  const source = read(file);
  for (const copiedValue of ['380-14-01523', '서울특별시 송파구 양재대로 932', '이무철']) {
    assert(!source.includes(copiedValue), `${file} must not copy public company data`);
  }
}

if (!chromium) {
  console.log('NEXUS public company Footer static contract passed; Playwright browser verification is unavailable in this runtime.');
  process.exit(0);
}

const mime = new Map([['.js', 'text/javascript; charset=utf-8'], ['.html', 'text/html; charset=utf-8']]);
const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/__company_footer_test__') {
    const scenario = url.searchParams.get('scenario') || 'updated';
    const userId = url.searchParams.get('user') || 'USR-1';
    const result = scenario === 'same-revision'
      ? { status: 'READY', snapshot: { revision: 3, companyName: '서버가 바꾸면 안 됨', businessNumber: '3801401523', representativeName: '서버값', companyPhone: '', businessAddress: '서버 주소', homepage: '' } }
      : { status: 'READY', snapshot: { revision: 2, companyName: '원앱 최신', businessNumber: '3801401523', representativeName: '이무철', companyPhone: '', businessAddress: '서울특별시 송파구 양재대로 932, 9층 19호', homepage: '' } };
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><script>
      window.__gatewayCalls = 0;
      window.ONEAPP_AUTH = {
        session: { user: { userId: ${JSON.stringify(userId)}, role: 'VIEWER' } },
        ready: Promise.resolve({ user: { userId: ${JSON.stringify(userId)}, role: 'VIEWER' } }),
        gateway: () => {
          window.__gatewayCalls += 1;
          ${scenario === 'error' ? "return Promise.reject(new Error('OFFLINE'));" : `return new Promise(resolve => setTimeout(() => resolve(${JSON.stringify(result)}), 25));`}
        }
      };
    </script><script src="/nexus/common/nexus-company-footer.js"></script><script>
      document.addEventListener('DOMContentLoaded', () => queueMicrotask(() => {
        const footer = document.querySelector('nexus-company-footer');
        window.__initial = {
          calls: window.__gatewayCalls,
          text: footer?.shadowRoot?.textContent || '',
          revision: footer?.dataset?.revision || '',
          keys: Object.keys(window.ONEAPP_COMPANY_PUBLIC.snapshot)
        };
      }));
    </script></head><body><main>업무 화면</main></body></html>`);
    return;
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const absolute = path.resolve(root, relative);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(rootPrefix) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'content-type': mime.get(path.extname(absolute)) || 'application/octet-stream' });
  fs.createReadStream(absolute).pipe(response);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browserCandidates = [
  process.env.ONEAPP_TEST_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => fs.existsSync(candidate));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

const storageKey = 'oneapp.nexus.company-public.ONEAPP.NEXUS_COMPANY_PUBLIC_FOOTER_V1.USR-1';
try {
  const page = await browser.newPage();
  await page.goto(`${origin}/__company_footer_test__?scenario=updated`);
  await page.waitForFunction(() => window.__initial);
  const initial = await page.evaluate(() => window.__initial);
  assert.equal(initial.calls, 0, 'initial public Footer render must make zero server calls');
  assert.match(initial.text, /원앱/);
  assert.match(initial.text, /380-14-01523/);
  assert.match(initial.text, /이무철/);
  assert.match(initial.text, /서울특별시 송파구 양재대로 932/);
  assert.equal(initial.revision, '1');
  assert.deepEqual(initial.keys.sort(), expectedFields.slice().sort());
  for (const field of forbiddenPublicFields) assert(!initial.keys.includes(field), `${field} must not enter the public Snapshot`);
  await page.waitForFunction(() => document.querySelector('nexus-company-footer')?.dataset.revision === '2');
  const updated = await page.evaluate(() => ({
    calls: window.__gatewayCalls,
    text: document.querySelector('nexus-company-footer').shadowRoot.textContent,
    stored: JSON.parse(localStorage.getItem(window.ONEAPP_COMPANY_PUBLIC.storageKey))
  }));
  assert.equal(updated.calls, 1);
  assert.match(updated.text, /원앱 최신/);
  assert(!updated.text.includes('회사전화'), 'blank companyPhone must be omitted');
  assert(!updated.text.includes('홈페이지'), 'blank homepage must be omitted');
  assert.equal(updated.stored.schemaVersion, 'NEXUS_COMPANY_PUBLIC_FOOTER_V1');
  assert.equal(updated.stored.companyId, 'ONEAPP');
  assert.equal(updated.stored.userScope, 'USR-1');
  assert.equal(updated.stored.snapshot.revision, 2);
  assert.deepEqual(Object.keys(updated.stored.snapshot).sort(), expectedFields.slice().sort());

  const warm = await browser.newPage();
  await warm.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 'NEXUS_COMPANY_PUBLIC_FOOTER_V1', companyId: 'ONEAPP', userScope: 'USR-1', snapshot: {
      revision: 3, companyName: '로컬 정상 Snapshot', businessNumber: '3801401523', representativeName: '이무철',
      companyPhone: '02-1234-5678', businessAddress: '로컬 주소', homepage: 'https://oneapp.example'
    }
  })), { key: storageKey });
  await warm.goto(`${origin}/__company_footer_test__?scenario=same-revision`);
  await warm.waitForFunction(() => window.__initial);
  const warmInitial = await warm.evaluate(() => window.__initial);
  assert.equal(warmInitial.calls, 0);
  assert.equal(warmInitial.revision, '3');
  assert.match(warmInitial.text, /로컬 정상 Snapshot/);
  assert.match(warmInitial.text, /02-1234-5678/);
  assert.match(warmInitial.text, /홈페이지/);
  await warm.waitForTimeout(80);
  const sameRevision = await warm.evaluate(() => document.querySelector('nexus-company-footer').shadowRoot.textContent);
  assert.match(sameRevision, /로컬 정상 Snapshot/);
  assert(!sameRevision.includes('서버가 바꾸면 안 됨'), 'same revision must not replace the atomic local Snapshot');

  const corrupt = await browser.newPage();
  await corrupt.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 'NEXUS_COMPANY_PUBLIC_FOOTER_V1', companyId: 'ONEAPP', userScope: 'USR-1', snapshot: {
      revision: 99, companyName: '오염값', businessNumber: '3801401523', representativeName: '공격자', businessAddress: '오염 주소',
      companyPhone: '', homepage: '', email: 'private@example.com'
    }
  })), { key: storageKey });
  await corrupt.goto(`${origin}/__company_footer_test__?scenario=error`);
  await corrupt.waitForFunction(() => window.__initial);
  const corruptInitial = await corrupt.evaluate(() => window.__initial);
  assert.equal(corruptInitial.calls, 0);
  assert.equal(corruptInitial.revision, '1');
  assert.match(corruptInitial.text, /원앱/);
  assert(!corruptInitial.text.includes('오염값'));

  const retained = await browser.newPage();
  await retained.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 'NEXUS_COMPANY_PUBLIC_FOOTER_V1', companyId: 'ONEAPP', userScope: 'USR-1', snapshot: {
      revision: 4, companyName: '마지막 정상값', businessNumber: '3801401523', representativeName: '이무철',
      companyPhone: '', businessAddress: '정상 주소', homepage: ''
    }
  })), { key: storageKey });
  await retained.goto(`${origin}/__company_footer_test__?scenario=error`);
  await retained.waitForFunction(() => document.querySelector('nexus-company-footer')?.dataset.syncState === 'error');
  const retainedText = await retained.evaluate(() => document.querySelector('nexus-company-footer').shadowRoot.textContent);
  assert.match(retainedText, /마지막 정상값/);
  assert.match(retainedText, /정상 주소/);

  const isolated = await browser.newPage();
  await isolated.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 'NEXUS_COMPANY_PUBLIC_FOOTER_V1', companyId: 'ONEAPP', userScope: 'USR-1', snapshot: {
      revision: 8, companyName: '사용자 1 전용 캐시', businessNumber: '3801401523', representativeName: '이무철',
      companyPhone: '', businessAddress: '사용자 1 주소', homepage: ''
    }
  })), { key: storageKey });
  await isolated.goto(`${origin}/__company_footer_test__?scenario=error&user=USR-2`);
  await isolated.waitForFunction(() => window.__initial);
  const isolatedInitial = await isolated.evaluate(() => window.__initial);
  assert.equal(isolatedInitial.revision, '1');
  assert.match(isolatedInitial.text, /원앱/);
  assert(!isolatedInitial.text.includes('사용자 1 전용 캐시'), 'a different user scope must never hydrate another user cache');

  console.log('NEXUS public company Footer passed (zero-call initial render, exact seven-key Snapshot, user/company/schema scope, revision atomicity, blank omission, error retention).');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
