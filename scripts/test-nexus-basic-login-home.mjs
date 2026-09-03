import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('nexus/index.html', 'utf8');
const css = await readFile('nexus/nexus.css', 'utf8');
const runtime = await readFile('nexus/nexus.js', 'utf8');
const sessionBridge = await readFile('nexus/session-bridge.js', 'utf8');
const commonUi = await readFile('nexus/common/nexus-ui.js', 'utf8');

assert.match(html, /<form id="loginForm"/, 'NEXUS home requires the basic login form');
assert.match(html, /<body class="nexus-home-page">/, 'NEXUS home visual changes must stay home-scoped');
assert.match(html, /nexus-ui-theme-init\.js\?v=1\.1\.0" data-nexus-app-id="nexus-home"/, 'NEXUS home must initialize the shared theme before paint');
assert.match(html, /nexus\.css\?v=1\.3\.2/, 'NEXUS home must load the fixed-header ivory theme CSS revision');
assert.match(html, /nexus\.js\?v=1\.3\.2/, 'NEXUS home must load the touch-enabled theme runtime revision');
assert.match(html, /<button class="nexus-home-theme__icon"[^>]+data-home-theme-set="light"[^>]+aria-label="일반모드 적용"[^>]*>☼<\/button>/, 'home light icon must be an accessible direct-action button');
assert.match(html, /<button class="nexus-home-theme__icon"[^>]+data-home-theme-set="dark"[^>]+aria-label="다크모드 적용"[^>]*>☾<\/button>/, 'home dark icon must be an accessible direct-action button');
assert.match(html, /id="homeThemeToggle"[^>]+role="switch"/, 'home must expose an accessible screen-mode switch');
assert.match(html, /id="loginId"[^>]+autocomplete="username"/, 'login id must support password managers');
assert.match(html, /id="password"[^>]+autocomplete="current-password"/, 'password must use current-password autocomplete');
assert.match(html, /id="homePanel"[^>]+hidden/, 'the app home must be hidden before login');
assert.match(html, /id="homeActions"[^>]+hidden/, 'user information must be hidden before login');
assert.match(html, /href="\/nexus\/" aria-label="NEXUS 홈"/, 'the home logo must return to /nexus/');
assert.match(html, /id="userDisplayName"/, 'the NEXUS home must identify the signed-in user');
assert.match(html, /id="userAccountType"/, 'the NEXUS home must show the master/delegated distinction');
assert.match(html, /<footer class="nexus-footer">원앱 \| NEXUS 사내 업무 시스템<\/footer>/, 'fixed ownership Footer must be visible independently from login state');
assert.doesNotMatch(html, /nexus-company-card|companyStatus|companyEditLink|READY|ERROR/, 'home must not retain company-card state or edit controls');

for (const action of [
  'nexus_auth_challenge',
  'nexus_auth_login',
  'nexus_auth_activate',
  'nexus_auth_session',
  'nexus_auth_logout',
]) {
  assert.match(runtime, new RegExp(`['"]${action}['"]`), `basic login requires ${action}`);
}

assert.match(runtime, /script\.google\.com\/macros\/s\//, 'the deployed login service must be configured');
assert.match(runtime, /name: 'PBKDF2'/, 'the password verifier must use PBKDF2');
assert.match(runtime, /hash: 'SHA-256'/, 'the password verifier must use SHA-256');
assert.match(runtime, /sessionStorage\.setItem/, 'each NEXUS tab must retain its own in-memory-lifetime session cache');
assert.doesNotMatch(runtime, /localStorage/, 'the session token must not persist in localStorage');
assert.match(runtime, /navigator\.serviceWorker\.register\(SESSION_BRIDGE_URL/, 'NEXUS home must register the scoped session bridge');
assert.match(runtime, /SESSION_BRIDGE_READY_WAIT_MS\s*=\s*3000/, 'bridge activation must tolerate a delayed first install');
assert.match(runtime, /SESSION_BRIDGE_RESPONSE_WAIT_MS\s*=\s*3000/, 'an active background NEXUS window must have time to answer');
assert.match(runtime, /if \(!ready\) sessionBridgeReadyPromise = null;/, 'a failed first bridge preparation must remain retryable');
assert.match(runtime, /SESSION_BRIDGE_MAX_REQUESTS\s*=\s*2/, 'a new NEXUS window must make one bounded retry');
assert.match(runtime, /isSessionBridgeWorker\(active\)/, 'the active scoped registration must be preferred over an unrelated controller');
assert.match(runtime, /addEventListener\('message', handleSessionBridgeMessage\)[\s\S]*if \(sessionBridgeTarget\(\)\) return Promise\.resolve\(true\);/, 'an already-active worker must not bypass the page message listener');
assert.match(runtime, /NEXUS_SESSION_REQUEST/, 'a new NEXUS tab must request an active peer session');
assert.match(runtime, /NEXUS_SESSION_CLEARED/, 'logout and expiry must propagate to peer NEXUS tabs');
assert.doesNotMatch(sessionBridge, /addEventListener\(['"]fetch|\bcaches\b|localStorage|indexedDB|document\.cookie/, 'the bridge must stay memory-only and must not intercept page traffic');
assert.match(runtime, /showHome\(cached\.session\);[\s\S]*setTimeout\(\(\) => \{[\s\S]*refreshSession\(cached\);/, 'a cached home must render before background session verification');
assert.match(runtime, /role === 'OWNER_MASTER' \? 'MASTER' : '위임 사용자'/, 'roles must be presented as MASTER or delegated user without enforcing app permission');
assert.doesNotMatch(runtime, /canUseApp|hasPermission|appContexts|nexus_proxy|window\.fetch\s*=/, 'basic login must not add app gating or a gateway runtime');
assert.match(runtime, /oneapp\.nexus\.ui\.visibility\.v1/, 'home must publish the non-sensitive UI visibility projection');
assert.match(runtime, /window\.ONEAPP_NEXUS_UI_THEME/, 'home must consume the shared theme controller');
assert.match(runtime, /themeController\.apply\(next, \{ persist: true, emit: true, source \}\)/, 'home theme choice must persist through the shared controller');
assert.match(runtime, /homeThemeButtons\.forEach[\s\S]*button\.addEventListener\('click'/, 'home theme icons must respond to click and touch activation');
assert.match(runtime, /NEXUS_UI_VISIBILITY_V1/, 'home visibility projection must be schema-versioned');
assert.match(runtime, /renderApps\(visibility\.visibleAppIds\)/, 'home cards must follow the UI visibility projection');
assert.doesNotMatch(runtime, /company-transport|callCompanyGateway|company\.profile_read|refreshCompany|COMPANY_SNAPSHOT|revision/i, 'home startup must not call or depend on the company service');
assert.match(commonUi, /logoFrame\.href = asset\('nexus\/'\)/, 'work-app logo must return to the NEXUS home');
assert.doesNotMatch(commonUi, /displayName|loginId|userId|sessionToken|contextToken|nexus[-_ ]auth/i, 'work-app header must not expose user information or auth tokens');
assert.match(css, /min-height:\s*44px/, 'home controls must retain touch-sized interaction');
assert.match(css, /\.nexus-home-theme__icon\s*\{[^}]*width:\s*44px[^}]*height:\s*44px[^}]*touch-action:\s*manipulation/s, 'home theme icons must expose a 44px touch target');
assert.match(css, /body\.nexus-home-page \.nexus-login-card\s*\{[^}]*border:\s*0;/s, 'home login surface must not draw a decorative border');
assert.match(css, /body\.nexus-home-page \.nexus-login-card input\s*\{[^}]*border:\s*0;/s, 'home inputs must use surface depth instead of a resting border');
assert.match(css, /body\.nexus-home-page \.nexus-app-card\s*\{[^}]*border:\s*0;/s, 'home app cards must use quiet surfaces instead of repeated borders');
assert.match(css, /body\.nexus-home-page \.nexus-app-card:focus-visible|\.nexus-app-card:focus-visible/, 'keyboard focus must remain visible after resting borders are removed');
assert.match(css, /--nexus-bg:\s*#f3efe6/, 'home light mode must use the approved ivory page tone');
assert.match(css, /--nexus-panel:\s*#faf7f0/, 'home light panels must use a warm paper surface');
assert.match(css, /data-nexus-ui-theme="dark"[^}]*--nexus-bg:\s*#0f141a/s, 'home dark mode must retain the quiet graphite surface');
assert.match(css, /--nexus-header-bg:\s*#0b1021/, 'home header must stay dark in both screen modes');
assert.match(css, /\.nexus-topbar\s*\{[^}]*background:\s*var\(--nexus-header-bg\)/s, 'home header must use the fixed dark surface');
assert.match(css, /\.nexus-home-logo-image--light\s*\{[^}]*display:\s*none/s, 'home must hide the light-background logo on the fixed dark header');
assert.match(css, /\.nexus-home-logo-image--dark\s*\{[^}]*display:\s*block/s, 'home must keep the dark-header logo visible');
assert.match(css, /\.nexus-footer\s*\{[^}]*border-color:\s*var\(--nexus-divider\)/s, 'home footer divider must remain visible');

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
  assert.match(page, /nexus-ui\.js\?v=1\.4\.2/, `${file}: updated common header runtime is required`);
  assert.doesNotMatch(page, /nexus\/nexus\.js|nexus-auth|userDisplayName|userAccountType/i, `${file}: login and user UI must stay out of the work app`);
}

console.log(`NEXUS basic login/home contracts passed (${appPages.length} work apps).`);
