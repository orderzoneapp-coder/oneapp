import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('nexus/index.html', 'utf8');
const css = await readFile('nexus/nexus.css', 'utf8');
const runtime = await readFile('nexus/nexus.js', 'utf8');
const commonUi = await readFile('nexus/common/nexus-ui.js', 'utf8');

assert.match(html, /<form id="loginForm"/, 'NEXUS home requires the basic login form');
assert.match(html, /id="loginId"[^>]+autocomplete="username"/, 'login id must support password managers');
assert.match(html, /id="password"[^>]+autocomplete="current-password"/, 'password must use current-password autocomplete');
assert.match(html, /id="homePanel"[^>]+hidden/, 'the app home must be hidden before login');
assert.match(html, /id="homeActions"[^>]+hidden/, 'user information must be hidden before login');
assert.match(html, /href="\/nexus\/" aria-label="NEXUS 홈"/, 'the home logo must return to /nexus/');
assert.match(html, /id="userDisplayName"/, 'the NEXUS home must identify the signed-in user');
assert.match(html, /id="userAccountType"/, 'the NEXUS home must show the master/delegated distinction');

for (const action of [
  'nexus_auth_challenge',
  'nexus_auth_login',
  'nexus_auth_session',
  'nexus_auth_logout',
]) {
  assert.match(runtime, new RegExp(`['"]${action}['"]`), `basic login requires ${action}`);
}

assert.match(runtime, /script\.google\.com\/macros\/s\//, 'the deployed login service must be configured');
assert.match(runtime, /name: 'PBKDF2'/, 'the password verifier must use PBKDF2');
assert.match(runtime, /hash: 'SHA-256'/, 'the password verifier must use SHA-256');
assert.match(runtime, /sessionStorage\.setItem/, 'the session must be limited to the current browser tab');
assert.doesNotMatch(runtime, /localStorage/, 'the session token must not persist in localStorage');
assert.match(runtime, /showHome\(cached\.session\);[\s\S]*setTimeout\(\(\) => refreshSession\(cached\), 0\)/, 'a cached home must render before background session verification');
assert.match(runtime, /role === 'OWNER_MASTER' \? 'MASTER' : '위임 사용자'/, 'roles must be presented as MASTER or delegated user without enforcing app permission');
assert.doesNotMatch(runtime, /canUseApp|hasPermission|appContexts|nexus_proxy|window\.fetch\s*=/, 'basic login must not add app gating or a gateway runtime');
assert.match(commonUi, /logoFrame\.href = asset\('nexus\/'\)/, 'work-app logo must return to the NEXUS home');
assert.doesNotMatch(commonUi, /displayName|loginId|sessionStorage|nexus[-_ ]auth/i, 'work-app header must not expose user information');
assert.match(css, /min-height:\s*44px/, 'home controls must retain touch-sized interaction');

const appPages = [
  'MerchOps.html',
  'DataOps.html',
  'SmartParser.html',
  'export_center.html',
  'settings.html',
  'Master.html',
  'Item_manager.html',
  'history_viewer.html',
  'orderops/list.html',
  'orderq/index.html',
  'orderq/input.html',
  'orderq/operations.html',
  'orderq/parser.html',
  'orderq/collector.html',
  'orderq/cloud.html',
  'smartinput/index.html',
];

for (const file of appPages) {
  const page = await readFile(file, 'utf8');
  assert.match(page, /nexus-ui\.js\?v=1\.3\.1/, `${file}: updated home-link runtime is required`);
  assert.doesNotMatch(page, /nexus\/nexus\.js|nexus-auth|userDisplayName|userAccountType/i, `${file}: login and user UI must stay out of the work app`);
}

console.log(`NEXUS basic login/home contracts passed (${appPages.length} work apps).`);
