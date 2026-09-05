import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [homeHtml, homeRuntime, sessionBridge, commonRuntime, adminHtml, adminRuntime, gateway] = await Promise.all([
  readFile('nexus/index.html', 'utf8'),
  readFile('nexus/nexus.js', 'utf8'),
  readFile('nexus/session-bridge.js', 'utf8'),
  readFile('nexus/common/nexus-ui.js', 'utf8'),
  readFile('nexus/admin/index.html', 'utf8'),
  readFile('nexus/admin/admin.js', 'utf8'),
  readFile('nexus/server/nexus-auth-gateway.gs', 'utf8'),
]);

const officialApps = [
  'master-lookup', 'customer-master', 'merchops', 'smart-input', 'orderops', 'dataops',
  'smart-parser', 'export-center', 'settings', 'item-manager', 'history-viewer', 'orderq-vnext',
];
const commonHeaderApps = officialApps.filter(appId => appId !== 'item-manager');

assert.match(homeHtml, /id="activationForm"[^>]+hidden/, 'first activation form must be opt-in');
assert.match(homeHtml, /id="adminLink"[^>]+href="\/nexus\/admin\/"[^>]+hidden/, 'admin entry must be hidden until OWNER_MASTER is known');
assert.match(homeHtml, /<footer class="nexus-footer">원앱 \| NEXUS 사내 업무 시스템<\/footer>/, 'fixed ownership Footer must be visible before and after login');
assert.doesNotMatch(homeHtml, /nexus-company-card|companyStatus|companyName|companySummary|companyAddress|companyNotice|companyEditLink|READY|ERROR/, 'company-card status DOM must not remain on home');
assert.doesNotMatch(homeRuntime, /company-transport|callCompanyGateway|company\.profile_read|refreshCompany|COMPANY_SNAPSHOT|revision/i, 'home startup must not call or depend on the company service');
assert.match(homeRuntime, /crypto\.getRandomValues/, 'activation must create a fresh client salt');
assert.match(homeRuntime, /name: 'PBKDF2'/, 'activation and login must preserve PBKDF2');
assert.match(homeRuntime, /iterations[^\n]+310000|310000/, 'PBKDF2 iteration strength must not be reduced');
assert.match(homeRuntime, /visibleAppsConfigured/, 'home must consume the server visibility contract');
assert.match(homeRuntime, /schemaVersion:\s*VISIBILITY_SCHEMA/, 'home must emit a schema-versioned projection');
assert.doesNotMatch(homeRuntime, /localStorage/, 'home must not persist auth or visibility in localStorage');
assert.match(homeRuntime, /scope:\s*SESSION_BRIDGE_SCOPE/, 'home must restrict the session bridge to /nexus/');
assert.match(sessionBridge, /url\.pathname\.startsWith\(NEXUS_PATH_PREFIX\)/, 'bridge messages must reject clients outside /nexus/');
assert.doesNotMatch(sessionBridge, /addEventListener\(['"]fetch|\bcaches\b|localStorage|indexedDB|document\.cookie/, 'bridge must not persist tokens or control fetch');

assert.match(adminHtml, /일반 사용자 추가/, 'minimal user creation UI is required');
assert.match(adminHtml, /최근 감사기록/, 'minimal audit UI is required');
assert.doesNotMatch(adminHtml, /삭제|권한 편집|서비스 연결|승인|결재/, 'forbidden administration surfaces must not exist');
for (const action of [
  'nexus_admin_users',
  'nexus_admin_user_create',
  'nexus_admin_user_update',
  'nexus_admin_user_suspend',
  'nexus_admin_user_restore',
  'nexus_admin_activation_reissue',
  'nexus_admin_audit',
]) {
  assert.match(adminRuntime, new RegExp(`['"]${action}['"]`), `admin UI requires ${action}`);
  assert.match(gateway, new RegExp(`['"]${action}['"]`), `server requires ${action}`);
}
assert.doesNotMatch(adminRuntime, /innerHTML|insertAdjacentHTML|document\.write/, 'user and audit values must render with DOM text APIs');
assert.match(adminRuntime, /textContent/, 'admin UI must render user-controlled values as text');
assert.doesNotMatch(adminRuntime, /localStorage/, 'admin Session must remain tab-scoped');
assert.doesNotMatch(adminRuntime, /nexus_admin_(?:delete|permissions|service)/, 'admin UI must not expose deleted scope');

for (const appId of officialApps) {
  assert.match(homeRuntime, new RegExp(`id: '${appId}'`), `home requires official app ${appId}`);
  assert.match(gateway, new RegExp(`'${appId}'`), `server allowlist requires official app ${appId}`);
}
for (const appId of commonHeaderApps) assert.match(commonRuntime, new RegExp(`id: '${appId}'`), `common header requires official app ${appId}`);
assert.doesNotMatch(commonRuntime, /Object\.freeze\(\{ id: 'item-manager', label:/, 'SKU management must not be a separate common-header app');
assert.match(commonRuntime, /sessionStorage\.getItem\(VISIBILITY_STORAGE_KEY\)/, 'header must only read the same-tab UI projection');
assert.doesNotMatch(commonRuntime, /\bfetch\s*\(|XMLHttpRequest|WebSocket|AUTH_ENDPOINT|sessionToken|userId|loginId|displayName/i, 'global header must stay independent from auth and identity');
assert.doesNotMatch(commonRuntime, /sessionStorage\.setItem/, 'global header must never write projection state');

const directPages = [
  'Master.html', 'customer-master/index.html', 'MerchOps.html', 'smartinput/index.html',
  'orderops/list.html', 'DataOps.html', 'SmartParser.html', 'export_center.html',
  'settings.html', 'Item_manager.html', 'history_viewer.html', 'orderq/index.html',
];
for (const page of directPages) {
  const html = await readFile(page, 'utf8');
  assert.match(html, /nexus-ui\.js\?v=1\.5\.0/, `${page}: visibility-only header is required`);
  assert.doesNotMatch(html, /http-equiv=["']refresh|location\.(?:href|replace)[^\n]+\/nexus\//i, `${page}: direct entry must not redirect to login`);
}

for (const forbidden of [
  /nexusAuthPurgeExpiredUsers_\(\);/,
  /nexusAuthAudit_\('PURGE'/,
  /user\.status\s*=\s*'PURGED'/,
  /user\.loginId\s*=\s*'purged-'/,
]) {
  assert.doesNotMatch(gateway, forbidden, `automatic purge mutation is forbidden: ${forbidden}`);
}
assert.match(gateway, /function nexusAuthPurgeExpiredUsers_\(\)\s*\{[\s\S]*?return 0;/, 'legacy purge symbol must be a non-mutating compatibility stub');

console.log('NEXUS auth minimal-control static UI and isolation contracts passed.');
