/**
 * ONEAPP MerchOps - Cloud Sync Server
 * [v2.1_OrderQHistoryCollector]
 *
 * - MasterDB/HistoryLogs 분할 전송 유지
 * - AppConfig JSON을 45,000자 이하로 분할 저장해 Google Sheets 셀 제한 회피
 * - config_only / master_only 선택 복원 지원
 * - 기존 AppConfig B1 단일 셀 형식도 자동 호환
 * - DataOps FULL 재고는 A/B staging 검증 후 current pointer를 원자 전환
 * - ORDER Q vNext는 목적별 시트와 revision 기반 증분 동기화를 사용
 * - ORDER Q API 접근토큰과 주문 bundle 복구 transaction log를 사용
 * - 이력수집 원본·판매·구매·재고·주문·출고연결·파서근거를 목적별 시트에 보존
 * - 기준정보 필드·매핑 메타데이터는 Config와 분리된 revision snapshot으로 보존
 */

const SHEET_NAMES = {
  MASTER: 'MasterDB',
  HISTORY: 'HistoryLogs',
  CONFIG: 'AppConfig',
  DATAOPS_A: 'DataOpsSnapshot_A',
  DATAOPS_B: 'DataOpsSnapshot_B',
  SHIPPING_PLAN_INDEX: 'ShippingPlanIndex',
  SHIPPING_PLAN_HISTORY: 'ShippingPlanHistory',
  SHIPPING_PLAN_STAGING: 'ShippingPlanStaging'
};

const CONFIG_FORMAT = 'ONEAPP_CONFIG_V2';
const CONFIG_CHUNK_SIZE = 45000;
const DATAOPS_SNAPSHOT_FORMAT = 'ONEAPP_DATAOPS_SNAPSHOT_V1';
const DATAOPS_SNAPSHOT_COLUMNS = ['단위', '품목코드', '품명', '규격', '재고', '기록', '거래', '구매가', '기본', '적요', '행사가'];
const DATAOPS_SNAPSHOT_CHUNK_SIZE = 45000;
const DATAOPS_SNAPSHOT_MAX_ROWS = 100000;
const DATAOPS_CURRENT_SLOT_PROPERTY = 'ONEAPP_DATAOPS_CURRENT_SLOT';
const FOUNDATION_ACTIVE_SLOT_PROPERTY = 'ONEAPP_NEXUS_FOUNDATION_ACTIVE_SLOT';
const FOUNDATION_LEGACY_STAGING_SLOT_PROPERTY = 'ONEAPP_NEXUS_FOUNDATION_LEGACY_STAGING_SLOT';
const FOUNDATION_SLOT_SHEETS = Object.freeze({
  A: Object.freeze({ MASTER: 'MasterDB', HISTORY: 'HistoryLogs', CONFIG: 'AppConfig' }),
  B: Object.freeze({ MASTER: 'MasterDB_NEXUS_B', HISTORY: 'HistoryLogs_NEXUS_B', CONFIG: 'AppConfig_NEXUS_B' })
});
const SHIPPING_PLAN_FORMAT = 'ONEAPP_SHIPPING_PURCHASE_PLAN_V1';
const SHIPPING_PLAN_WORKSPACE_SCHEMA = 'shipping-workspace/v2';
const SHIPPING_PLAN_CHUNK_SIZE = 45000;
const SHIPPING_PLAN_MAX_ROWS = 300000;
const SHIPPING_PLAN_MAX_CELLS = 5000000;
const SHIPPING_PLAN_ACCESS_TOKEN_PROPERTY = 'ONEAPP_SHIPPING_PLAN_ACCESS_TOKEN';
const ORDERQ_ACCESS_TOKEN_PROPERTY = 'ONEAPP_ORDERQ_ACCESS_TOKEN';
const ONEAPP_NEXUS_GATEWAY_ACTOR = 'NEXUS_GATEWAY';
const ONEAPP_NEXUS_GATEWAY_BINDING_PROPERTIES = Object.freeze({
  FOUNDATION: 'ONEAPP_NEXUS_GATEWAY_FOUNDATION_BINDINGS_JSON',
  DATAOPS: 'ONEAPP_NEXUS_GATEWAY_DATAOPS_BINDINGS_JSON',
  ORDERQ: 'ONEAPP_NEXUS_GATEWAY_ORDERQ_BINDINGS_JSON',
  SHIPPING: 'ONEAPP_NEXUS_GATEWAY_SHIPPING_BINDINGS_JSON'
});
const SHIPPING_PLAN_INDEX_COLUMNS = [
  'format', 'planId', 'revision', 'basisDate', 'savedAt', 'sourceFileName', 'savedBy',
  'productRowCount', 'purchaseUploadRowCount', 'hash', 'rowCount', 'cellCount',
  'historyStartRow', 'chunkCount', 'charCount'
];

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  return sheet;
}

function oneappNexusFoundationActiveSlot() {
  return String(PropertiesService.getScriptProperties().getProperty(FOUNDATION_ACTIVE_SLOT_PROPERTY) || 'A') === 'B' ? 'B' : 'A';
}

function oneappNexusFoundationInactiveSlot() {
  return oneappNexusFoundationActiveSlot() === 'A' ? 'B' : 'A';
}

function oneappNexusFoundationSheet(ss, kind, slot, create) {
  const normalizedSlot = slot === 'B' ? 'B' : 'A';
  const name = FOUNDATION_SLOT_SHEETS[normalizedSlot][kind];
  if (!name) throw new Error('ONEAPP_NEXUS_FOUNDATION_SHEET_KIND_INVALID');
  return create === false ? ss.getSheetByName(name) : getOrCreateSheet(ss, name);
}

function oneappNexusFoundationActivate(slot) {
  const normalizedSlot = slot === 'B' ? 'B' : 'A';
  PropertiesService.getScriptProperties().setProperty(FOUNDATION_ACTIVE_SLOT_PROPERTY, normalizedSlot);
  return normalizedSlot;
}

function oneappNexusFoundationConfig(ss, slot) {
  return loadConfigData(oneappNexusFoundationSheet(ss, 'CONFIG', slot || oneappNexusFoundationActiveSlot(), false));
}

function oneappNexusFoundationLegacyStageState() {
  const properties = PropertiesService.getScriptProperties();
  const raw = String(properties.getProperty(FOUNDATION_LEGACY_STAGING_SLOT_PROPERTY) || '');
  if (!raw) return null;
  let state;
  try { state = JSON.parse(raw); }
  catch (_) { state = { slot: raw, startedAt: '' }; }
  const slot = state && state.slot === 'B' ? 'B' : (state && state.slot === 'A' ? 'A' : '');
  const startedAt = Date.parse(state && state.startedAt || '');
  if (!slot || !Number.isFinite(startedAt) || Date.now() - startedAt > 30 * 60 * 1000) {
    properties.setProperty(FOUNDATION_LEGACY_STAGING_SLOT_PROPERTY, '');
    return null;
  }
  return { slot, startedAt: new Date(startedAt).toISOString() };
}

function oneappNexusFoundationBeginLegacyStage(ss) {
  const slot = oneappNexusFoundationInactiveSlot();
  ['MASTER', 'HISTORY', 'CONFIG'].forEach(kind => oneappNexusFoundationSheet(ss, kind, slot).clearContents());
  PropertiesService.getScriptProperties().setProperty(FOUNDATION_LEGACY_STAGING_SLOT_PROPERTY, JSON.stringify({
    slot,
    startedAt: new Date().toISOString()
  }));
  return slot;
}

function oneappNexusFoundationRequireLegacyStage() {
  const state = oneappNexusFoundationLegacyStageState();
  if (!state) throw new Error('ONEAPP_NEXUS_LEGACY_STAGE_REQUIRED');
  return state.slot;
}

function oneappNexusFoundationFinalizeLegacyStage(ss, configData) {
  const slot = oneappNexusFoundationRequireLegacyStage();
  const masterSheet = oneappNexusFoundationSheet(ss, 'MASTER', slot);
  const historySheet = oneappNexusFoundationSheet(ss, 'HISTORY', slot);
  const configSheet = oneappNexusFoundationSheet(ss, 'CONFIG', slot);
  saveConfigData(configSheet, configData || {});
  const master = readMasterData(ss, slot);
  const history = readHistoryData(ss, slot);
  const masterRowCount = masterSheet.getLastRow();
  const historyRowCount = historySheet.getLastRow();
  oneappNexusFoundationConfig(ss, slot);
  if (Object.keys(master).length !== masterRowCount || history.length !== historyRowCount) throw new Error('ONEAPP_NEXUS_LEGACY_STAGE_VERIFY_FAILED');
  oneappNexusFoundationActivate(slot);
  PropertiesService.getScriptProperties().setProperty(FOUNDATION_LEGACY_STAGING_SLOT_PROPERTY, '');
  return { activeSlot: slot, masterCount: masterRowCount, historyCount: historyRowCount };
}

function splitTextBySize(text, size) {
  const source = String(text || '');
  const chunks = [];
  for (let i = 0; i < source.length; i += size) chunks.push(source.slice(i, i + size));
  return chunks.length ? chunks : ['{}'];
}

function saveConfigData(sheet, configData) {
  const json = JSON.stringify(configData || {});
  const chunks = splitTextBySize(json, CONFIG_CHUNK_SIZE);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 4).setValues([[
    CONFIG_FORMAT,
    new Date().toISOString(),
    chunks.length,
    json.length
  ]]);
  const rows = chunks.map((chunk, index) => [index + 1, chunk]);
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  return { chunkCount: chunks.length, charCount: json.length };
}

function loadConfigData(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return {};

  const marker = String(sheet.getRange(1, 1).getValue() || '');
  if (marker === CONFIG_FORMAT) {
    const storedCount = Number(sheet.getRange(1, 3).getValue()) || Math.max(0, sheet.getLastRow() - 1);
    if (storedCount < 1) return {};
    const rows = sheet.getRange(2, 1, storedCount, 2).getValues();
    rows.sort((a, b) => Number(a[0]) - Number(b[0]));
    const json = rows.map(row => String(row[1] || '')).join('');
    return json ? JSON.parse(json) : {};
  }

  // v1.6 이하: A1=AppConfig, B1=전체 JSON 단일 셀
  const legacyJson = sheet.getRange('B1').getValue();
  return legacyJson ? JSON.parse(String(legacyJson)) : {};
}

function readMasterData(ss, slot) {
  const master = {};
  const sheet = oneappNexusFoundationSheet(ss, 'MASTER', slot || oneappNexusFoundationActiveSlot(), false);
  if (!sheet || sheet.getLastRow() < 1) return master;
  const rows = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  rows.forEach(row => {
    if (!row[0] || !row[1]) return;
    try { master[String(row[0])] = JSON.parse(String(row[1])); } catch (e) {}
  });
  return master;
}

function readHistoryData(ss, slot) {
  const history = [];
  const sheet = oneappNexusFoundationSheet(ss, 'HISTORY', slot || oneappNexusFoundationActiveSlot(), false);
  if (!sheet || sheet.getLastRow() < 1) return history;
  const rows = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  rows.forEach(row => {
    if (!row[0]) return;
    try { history.push(JSON.parse(String(row[0]))); } catch (e) {}
  });
  return history;
}

function normalizeConfigResult(configData) {
  const conf = configData || {};
  return {
    schemaVersion: conf.schemaVersion || '',
    updatedAt: conf.updatedAt || '',
    dict: conf.dict || {},
    rules: conf.rules || [],
    appConfig: conf.appConfig || {},
    settingsKeys: conf.settingsKeys || {},
    pendingShopStatus: conf.pendingShopStatus || []
  };
}

function withScriptLock(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return callback(); }
  finally { lock.releaseLock(); }
}

function splitDataOpsTextBySize(text, size) {
  const source = String(text || '');
  const chunks = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + size);
    if (end < source.length) {
      const previous = source.charCodeAt(end - 1);
      const next = source.charCodeAt(end);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--;
    }
    chunks.push(source.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : ['{}'];
}

function constantTimeTextEquals(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i % Math.max(1, a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1, b.length)) || 0);
  }
  return diff === 0;
}

function sha256Hex(text) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text || ''),
    Utilities.Charset.UTF_8
  );
  return digest.map(value => {
    const byte = value < 0 ? value + 256 : value;
    return byte.toString(16).padStart(2, '0');
  }).join('');
}

function oneappNexusGatewayCanonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(oneappNexusGatewayCanonicalJson).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + oneappNexusGatewayCanonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function oneappNexusGatewayAudit(payload, boundary, access, result, code, credentialId) {
  const request = payload && payload.nexusRequest || {};
  console.info(JSON.stringify({
    event: 'ONEAPP_NEXUS_GATEWAY_AUDIT', protocol: String(request.contractVersion || request.protocol || 'LEGACY_V1'),
    requestId: String(request.requestId || ''), userId: String(request.subjectUserId || ''), loginId: String(request.subjectLoginId || ''),
    appId: String(request.appId || ''), operationId: String(request.operationId || ''), action: String(payload && payload.action || ''),
    actorId: ONEAPP_NEXUS_GATEWAY_ACTOR, boundary, access, credentialId: String(credentialId || ''), result,
    safeError: String(code || '').replace(/[^A-Z0-9_]/g, '').slice(0, 100), at: new Date().toISOString()
  }));
}

function oneappNexusLegacyUsageAudit(payload, boundary, access) {
  const request = payload && payload.nexusRequest || {};
  console.info(JSON.stringify({
    event: 'ONEAPP_NEXUS_GATEWAY_AUDIT', protocol: 'LEGACY_V1', requestId: String(request.requestId || ''),
    userId: String(request.subjectUserId || ''), loginId: String(request.subjectLoginId || ''), appId: '', operationId: '',
    action: String(payload && payload.action || ''), actorId: String(payload && payload.actorId || ''), boundary, access,
    credentialId: 'LEGACY', result: 'SUCCESS', safeError: '', at: new Date().toISOString()
  }));
}

function oneappNexusGatewayRequire(payload, boundary, access) {
  const normalizedBoundary = String(boundary || '').toUpperCase();
  const normalizedAccess = String(access || '').toUpperCase();
  const request = payload && payload.nexusRequest || {};
  const protocol = String(request.contractVersion || request.protocol || '');
  if (protocol !== 'NEXUS_AUTH_V2' && protocol !== 'LEGACY_V1') return null;
  let credentialId = '';
  try {
    if (String(payload && payload.actorId || '') !== ONEAPP_NEXUS_GATEWAY_ACTOR) throw new Error('ONEAPP_NEXUS_GATEWAY_ACTOR_DENIED');
    const propertyName = ONEAPP_NEXUS_GATEWAY_BINDING_PROPERTIES[normalizedBoundary];
    if (!propertyName || !/^(READ|WRITE)$/.test(normalizedAccess)) throw new Error('ONEAPP_NEXUS_GATEWAY_ROUTE_DENIED');
    let bindings;
    try { bindings = JSON.parse(String(PropertiesService.getScriptProperties().getProperty(propertyName) || '[]')); }
    catch (_) { throw new Error('ONEAPP_NEXUS_GATEWAY_BINDINGS_INVALID'); }
    if (!Array.isArray(bindings) || !bindings.length) throw new Error('ONEAPP_NEXUS_GATEWAY_NOT_CONFIGURED');
    const suppliedToken = String(payload && payload.token || '');
    if (!suppliedToken) throw new Error('ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED');
    const suppliedDigest = sha256Hex(suppliedToken);
    const binding = bindings.find(row => row && /^[a-f0-9]{64}$/.test(String(row.tokenDigest || '')) && constantTimeTextEquals(String(row.tokenDigest), suppliedDigest));
    if (!binding) throw new Error('ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED');
    credentialId = String(binding.credentialId || '');
    const requiredFields = ['credentialId', 'version', 'tokenDigest', 'actorId', 'roleIds', 'allowedScope', 'status', 'createdAt', 'activatedAt', 'retiredAt'];
    if (requiredFields.some(key => !Object.prototype.hasOwnProperty.call(binding, key))) throw new Error('ONEAPP_NEXUS_GATEWAY_BINDING_SCHEMA_INVALID');
    const status = String(binding.status || '').toUpperCase();
    if (!credentialId || String(binding.version || '') !== 'V2' || binding.actorId !== ONEAPP_NEXUS_GATEWAY_ACTOR || !['ACTIVE', 'RETIRING', 'RETIRED'].includes(status)) throw new Error('ONEAPP_NEXUS_GATEWAY_BINDING_DENIED');
    const retiringUntil = Date.parse(binding.retiredAt || '');
    if (Number.isNaN(Date.parse(binding.createdAt)) || Number.isNaN(Date.parse(binding.activatedAt))
        || (status !== 'ACTIVE' && Number.isNaN(retiringUntil))) throw new Error('ONEAPP_NEXUS_GATEWAY_BINDING_TIME_INVALID');
    if (status === 'RETIRED' || (status === 'RETIRING' && retiringUntil <= Date.now())) throw new Error('ONEAPP_NEXUS_GATEWAY_BINDING_RETIRED');
    const roles = Array.isArray(binding.roleIds) ? binding.roleIds.map(value => String(value || '').toUpperCase()) : [];
    const requiredRole = `${normalizedBoundary}_${normalizedAccess}`;
    const writeImpliesRead = normalizedAccess === 'READ' && roles.includes(`${normalizedBoundary}_WRITE`);
    if (!roles.includes(requiredRole) && !writeImpliesRead) throw new Error('ONEAPP_NEXUS_GATEWAY_ROLE_DENIED');
    const allowedScope = binding.allowedScope && typeof binding.allowedScope === 'object' ? binding.allowedScope : {};
    const requestedScope = payload && payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
    if (!String(allowedScope.companyId || '') || oneappNexusGatewayCanonicalJson(allowedScope) !== oneappNexusGatewayCanonicalJson(requestedScope)) throw new Error('ONEAPP_NEXUS_GATEWAY_SCOPE_DENIED');
    oneappNexusGatewayAudit(payload, normalizedBoundary, normalizedAccess, 'SUCCESS', '', credentialId);
    return { actorId: ONEAPP_NEXUS_GATEWAY_ACTOR, roleIds: roles, tokenDigest: suppliedDigest, allowedScope,
      scopeDigest: sha256Hex(oneappNexusGatewayCanonicalJson(allowedScope)), deviceId: 'NEXUS_GATEWAY', environment: 'PRODUCTION', credentialId };
  } catch (error) {
    oneappNexusGatewayAudit(payload, normalizedBoundary, normalizedAccess, 'DENIED', error && error.message, credentialId);
    throw error;
  }
}

function requireShippingPlanAccess(payload, access) {
  if (oneappNexusGatewayRequire(payload, 'SHIPPING', access || 'READ')) return;
  const configuredToken = String(PropertiesService.getScriptProperties().getProperty(SHIPPING_PLAN_ACCESS_TOKEN_PROPERTY) || '');
  if (!configuredToken) throw new Error('SHIPPING_PLAN_ACCESS_NOT_CONFIGURED');
  const suppliedToken = String((payload && payload.token) || '');
  if (!suppliedToken || !constantTimeTextEquals(configuredToken, suppliedToken)) {
    throw new Error('SHIPPING_PLAN_ACCESS_DENIED');
  }
  oneappNexusLegacyUsageAudit(payload, 'SHIPPING', access || 'READ');
}

function requireOrderQAccess(payload, access) {
  if (oneappNexusGatewayRequire(payload, 'ORDERQ', access || 'READ')) return;
  const properties = PropertiesService.getScriptProperties();
  const configuredToken = String(
    properties.getProperty(ORDERQ_ACCESS_TOKEN_PROPERTY)
    || properties.getProperty(SHIPPING_PLAN_ACCESS_TOKEN_PROPERTY)
    || ''
  );
  if (!configuredToken) throw new Error('ORDERQ_ACCESS_NOT_CONFIGURED');
  const suppliedToken = String((payload && payload.token) || '');
  if (!suppliedToken || !constantTimeTextEquals(configuredToken, suppliedToken)) {
    throw new Error('ORDERQ_ACCESS_DENIED');
  }
  oneappNexusLegacyUsageAudit(payload, 'ORDERQ', access || 'READ');
}

function buildShippingPlanId(basisDate, sourceFingerprint) {
  const date = String(basisDate || '').replace(/[^0-9]/g, '');
  const fingerprint = String(sourceFingerprint || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (date.length !== 8 || fingerprint.length < 16) throw new Error('SHIPPING_PLAN_ID_SOURCE_INVALID');
  return `SHIPPLAN-${date}-${fingerprint.slice(0, 16)}`;
}

function buildShippingPlanRevision(planId, savedAt, hash) {
  const stamp = String(savedAt || '').replace(/[^0-9]/g, '').slice(0, 17);
  const uuid = String(Utilities.getUuid()).replace(/-/g, '').slice(-12);
  return `SHIPREV-${String(planId || '').slice(-16)}-${stamp}-${String(hash || '').slice(0, 16)}-${uuid}`;
}

function countShippingPlanScalarCells(value) {
  if (value === null || value === undefined) return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countShippingPlanScalarCells(item), 0);
  if (typeof value === 'object') {
    return Object.keys(value).reduce((sum, key) => sum + countShippingPlanScalarCells(value[key]), 0);
  }
  return 1;
}

function countShippingPlanRows(canonical) {
  const workspace = canonical && canonical.workspace;
  if (!workspace || typeof workspace !== 'object') return 0;
  const sourceFiles = workspace.sourceFiles || {};
  return [
    workspace.allocations,
    workspace.productSummaries,
    workspace.purchaseManagement,
    sourceFiles.orders && sourceFiles.orders.matrix,
    sourceFiles.inventory && sourceFiles.inventory.matrix
  ].reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
}

function countShippingPurchaseUploadRows(workspace) {
  return (Array.isArray(workspace && workspace.purchaseManagement) ? workspace.purchaseManagement : []).filter(row => {
    if (!row || row.rowType === 'reference' || row.purchase === '대체' || row.purchase === '소분') return false;
    const hasOverride = typeof row.purchaseQuantityOverride === 'number' &&
      Number.isFinite(row.purchaseQuantityOverride) && row.purchaseQuantityOverride >= 0;
    const purchaseNeed = hasOverride ? row.purchaseQuantityOverride : row.purchaseNeed;
    return (hasOverride || row.inventoryMatched === true) &&
      typeof purchaseNeed === 'number' && Number.isFinite(purchaseNeed) && purchaseNeed > 0;
  }).length;
}

function validateShippingPlanEnvelope(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('SHIPPING_PLAN_REQUIRED');
  if (snapshot.schemaVersion !== SHIPPING_PLAN_FORMAT) throw new Error('SHIPPING_PLAN_SCHEMA_INVALID');
  if (String(snapshot.hashAlgorithm || '').toUpperCase() !== 'SHA-256') throw new Error('SHIPPING_PLAN_HASH_ALGORITHM_INVALID');
  const canonicalJson = String(snapshot.canonicalJson || '');
  if (!canonicalJson) throw new Error('SHIPPING_PLAN_CANONICAL_JSON_REQUIRED');
  const actualHash = sha256Hex(canonicalJson);
  if (!constantTimeTextEquals(actualHash, String(snapshot.hash || '').toLowerCase())) throw new Error('SHIPPING_PLAN_HASH_MISMATCH');

  let canonical;
  try { canonical = JSON.parse(canonicalJson); }
  catch (error) { throw new Error('SHIPPING_PLAN_CANONICAL_JSON_INVALID'); }
  if (!canonical || canonical.schemaVersion !== SHIPPING_PLAN_FORMAT) throw new Error('SHIPPING_PLAN_CANONICAL_SCHEMA_INVALID');
  if (!canonical.workspace || canonical.workspace.schemaVersion !== SHIPPING_PLAN_WORKSPACE_SCHEMA) {
    throw new Error('SHIPPING_PLAN_WORKSPACE_SCHEMA_INVALID');
  }
  const basisDate = String(canonical.basisDate || '');
  const basisTime = new Date(`${basisDate}T00:00:00.000Z`).getTime();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(basisDate) || Number.isNaN(basisTime) || new Date(basisTime).toISOString().slice(0, 10) !== basisDate) {
    throw new Error('SHIPPING_PLAN_BASIS_DATE_INVALID');
  }
  const sourceFingerprint = String(canonical.sourceFingerprint || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) throw new Error('SHIPPING_PLAN_FINGERPRINT_INVALID');
  const expectedPlanId = buildShippingPlanId(basisDate, sourceFingerprint);
  if (canonical.planId !== expectedPlanId || snapshot.planId !== expectedPlanId) throw new Error('SHIPPING_PLAN_ID_MISMATCH');
  if (!canonical.sourceFiles || typeof canonical.sourceFiles !== 'object') throw new Error('SHIPPING_PLAN_SOURCE_FILES_INVALID');
  if (!canonical.purchaseInputs || typeof canonical.purchaseInputs !== 'object' || Array.isArray(canonical.purchaseInputs)) {
    throw new Error('SHIPPING_PLAN_PURCHASE_INPUTS_INVALID');
  }
  if (
    canonical.workspace.sourceFingerprint !== sourceFingerprint ||
    canonical.workspace.planId !== expectedPlanId ||
    canonical.workspace.basisDate !== basisDate ||
    canonical.workspace.basisDateStatus !== 'valid'
  ) {
    throw new Error('SHIPPING_PLAN_WORKSPACE_IDENTITY_MISMATCH');
  }
  ['orders', 'inventory'].forEach(kind => {
    const declared = canonical.sourceFiles[kind];
    const embedded = canonical.workspace.sourceFiles && canonical.workspace.sourceFiles[kind];
    if (!declared || !embedded) throw new Error('SHIPPING_PLAN_SOURCE_FILES_INVALID');
    if (
      String(declared.fileName || '') !== String(embedded.fileName || '') ||
      String(declared.sheetName || '') !== String(embedded.sheetName || '') ||
      Number(declared.rowCount) !== Number(embedded.rowCount) ||
      !/^[a-f0-9]{64}$/.test(String(declared.sha256 || '').toLowerCase()) ||
      String(declared.sha256 || '').toLowerCase() !== String(embedded.sha256 || '').toLowerCase()
    ) {
      throw new Error('SHIPPING_PLAN_SOURCE_FILE_MISMATCH');
    }
  });
  const purchaseRows = (Array.isArray(canonical.workspace.purchaseManagement)
    ? canonical.workspace.purchaseManagement
    : []).filter(row => row && row.rowType !== 'reference');
  const purchaseCodes = purchaseRows.map(row => String(row.productCode || ''));
  if (
    purchaseCodes.some(code => !code || !Object.prototype.hasOwnProperty.call(canonical.purchaseInputs, code)) ||
    Object.keys(canonical.purchaseInputs).length !== new Set(purchaseCodes).size ||
    purchaseRows.some(row => String(canonical.purchaseInputs[row.productCode] || '') !== String(row.purchase || ''))
  ) {
    throw new Error('SHIPPING_PLAN_PURCHASE_INPUT_MISMATCH');
  }

  const rowCount = countShippingPlanRows(canonical);
  const cellCount = countShippingPlanScalarCells(canonical);
  if (rowCount > SHIPPING_PLAN_MAX_ROWS) throw new Error('SHIPPING_PLAN_ROWS_EXCEEDED');
  if (cellCount > SHIPPING_PLAN_MAX_CELLS) throw new Error('SHIPPING_PLAN_CELLS_EXCEEDED');
  if (Number(snapshot.rowCount) !== rowCount) throw new Error('SHIPPING_PLAN_ROW_COUNT_MISMATCH');
  if (Number(snapshot.cellCount) !== cellCount) throw new Error('SHIPPING_PLAN_CELL_COUNT_MISMATCH');
  const productRowCount = Array.isArray(canonical.workspace.productSummaries)
    ? canonical.workspace.productSummaries.length
    : 0;
  const purchaseUploadRowCount = countShippingPurchaseUploadRows(canonical.workspace);
  if (Number(canonical.productRowCount) !== productRowCount) throw new Error('SHIPPING_PLAN_PRODUCT_COUNT_MISMATCH');
  if (Number(canonical.purchaseUploadRowCount) !== purchaseUploadRowCount) throw new Error('SHIPPING_PLAN_UPLOAD_COUNT_MISMATCH');
  return {
    schemaVersion: SHIPPING_PLAN_FORMAT,
    planId: expectedPlanId,
    basisDate,
    sourceFingerprint,
    sourceFileName: String(canonical.sourceFileName || ''),
    savedBy: String(canonical.savedBy || ''),
    productRowCount,
    purchaseUploadRowCount,
    hashAlgorithm: 'SHA-256',
    hash: actualHash,
    rowCount,
    cellCount,
    canonicalJson,
    canonical
  };
}

function writeShippingPlanStaging(sheet, validated) {
  const chunks = splitDataOpsTextBySize(validated.canonicalJson, SHIPPING_PLAN_CHUNK_SIZE);
  const metadata = {
    schemaVersion: validated.schemaVersion,
    planId: validated.planId,
    basisDate: validated.basisDate,
    sourceFingerprint: validated.sourceFingerprint,
    sourceFileName: validated.sourceFileName,
    savedBy: validated.savedBy,
    productRowCount: validated.productRowCount,
    purchaseUploadRowCount: validated.purchaseUploadRowCount,
    hashAlgorithm: validated.hashAlgorithm,
    hash: validated.hash,
    rowCount: validated.rowCount,
    cellCount: validated.cellCount,
    chunkCount: chunks.length,
    charCount: validated.canonicalJson.length
  };
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 2).setValues([[SHIPPING_PLAN_FORMAT, JSON.stringify(metadata)]]);
  sheet.getRange(2, 1, chunks.length, 2).setValues(chunks.map((chunk, index) => [index + 1, chunk]));
  return metadata;
}

function readShippingPlanStaging(sheet) {
  if (!sheet || sheet.getLastRow() < 2) throw new Error('SHIPPING_PLAN_STAGING_EMPTY');
  if (String(sheet.getRange(1, 1).getValue() || '') !== SHIPPING_PLAN_FORMAT) throw new Error('SHIPPING_PLAN_STAGING_FORMAT_INVALID');
  let metadata;
  try { metadata = JSON.parse(String(sheet.getRange(1, 2).getValue() || '{}')); }
  catch (error) { throw new Error('SHIPPING_PLAN_STAGING_METADATA_INVALID'); }
  const chunkCount = Number(metadata.chunkCount);
  if (!Number.isInteger(chunkCount) || chunkCount < 1) throw new Error('SHIPPING_PLAN_STAGING_CHUNK_COUNT_INVALID');
  const rows = sheet.getRange(2, 1, chunkCount, 2).getValues();
  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  const canonicalJson = rows.map(row => String(row[1] || '')).join('');
  if (canonicalJson.length !== Number(metadata.charCount)) throw new Error('SHIPPING_PLAN_STAGING_CHAR_COUNT_MISMATCH');
  return validateShippingPlanEnvelope({ ...metadata, canonicalJson });
}

function ensureShippingPlanIndexHeader(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SHIPPING_PLAN_INDEX_COLUMNS.length).setValues([SHIPPING_PLAN_INDEX_COLUMNS]);
    return;
  }
  const header = sheet.getRange(1, 1, 1, SHIPPING_PLAN_INDEX_COLUMNS.length).getValues()[0];
  if (JSON.stringify(header) !== JSON.stringify(SHIPPING_PLAN_INDEX_COLUMNS)) {
    throw new Error('SHIPPING_PLAN_INDEX_HEADER_INVALID');
  }
}

function shippingPlanIndexRowToMetadata(row) {
  return {
    schemaVersion: row[0],
    planId: String(row[1] || ''),
    revision: String(row[2] || ''),
    basisDate: String(row[3] || ''),
    savedAt: String(row[4] || ''),
    sourceFileName: String(row[5] || ''),
    savedBy: String(row[6] || ''),
    productRowCount: Number(row[7]),
    purchaseUploadRowCount: Number(row[8]),
    hash: String(row[9] || ''),
    rowCount: Number(row[10]),
    cellCount: Number(row[11]),
    historyStartRow: Number(row[12]),
    chunkCount: Number(row[13]),
    charCount: Number(row[14])
  };
}

function appendShippingPlanRevision(ss, validated) {
  const indexSheet = getOrCreateSheet(ss, SHEET_NAMES.SHIPPING_PLAN_INDEX);
  ensureShippingPlanIndexHeader(indexSheet);
  const staging = getOrCreateSheet(ss, SHEET_NAMES.SHIPPING_PLAN_STAGING);
  writeShippingPlanStaging(staging, validated);
  const verifiedStaging = readShippingPlanStaging(staging);
  if (verifiedStaging.hash !== validated.hash || verifiedStaging.rowCount !== validated.rowCount || verifiedStaging.cellCount !== validated.cellCount) {
    throw new Error('SHIPPING_PLAN_STAGING_VERIFY_FAILED');
  }

  const savedAt = new Date().toISOString();
  const revision = buildShippingPlanRevision(validated.planId, savedAt, validated.hash);
  const chunks = splitDataOpsTextBySize(validated.canonicalJson, SHIPPING_PLAN_CHUNK_SIZE);
  const historySheet = getOrCreateSheet(ss, SHEET_NAMES.SHIPPING_PLAN_HISTORY);
  const historyStartRow = historySheet.getLastRow() + 1;
  historySheet.getRange(historyStartRow, 1, chunks.length, 4).setValues(
    chunks.map((chunk, index) => [validated.planId, revision, index + 1, chunk])
  );
  const written = historySheet.getRange(historyStartRow, 1, chunks.length, 4).getValues();
  const historyJson = written.map((row, index) => {
    if (String(row[0]) !== validated.planId || String(row[1]) !== revision || Number(row[2]) !== index + 1) {
      throw new Error('SHIPPING_PLAN_HISTORY_POINTER_INVALID');
    }
    return String(row[3] || '');
  }).join('');
  const verifiedHistory = validateShippingPlanEnvelope({
    schemaVersion: SHIPPING_PLAN_FORMAT,
    planId: validated.planId,
    hashAlgorithm: 'SHA-256',
    hash: validated.hash,
    rowCount: validated.rowCount,
    cellCount: validated.cellCount,
    canonicalJson: historyJson
  });
  if (verifiedHistory.hash !== validated.hash) throw new Error('SHIPPING_PLAN_HISTORY_VERIFY_FAILED');

  const indexRow = [
    SHIPPING_PLAN_FORMAT,
    validated.planId,
    revision,
    validated.basisDate,
    savedAt,
    validated.sourceFileName,
    validated.savedBy,
    validated.productRowCount,
    validated.purchaseUploadRowCount,
    validated.hash,
    validated.rowCount,
    validated.cellCount,
    historyStartRow,
    chunks.length,
    validated.canonicalJson.length
  ];
  indexSheet.getRange(indexSheet.getLastRow() + 1, 1, 1, indexRow.length).setValues([indexRow]);
  return shippingPlanIndexRowToMetadata(indexRow);
}

function listShippingPlanRevisions(ss, filter) {
  const sheet = ss.getSheetByName(SHEET_NAMES.SHIPPING_PLAN_INDEX);
  if (!sheet || sheet.getLastRow() < 2) return [];
  ensureShippingPlanIndexHeader(sheet);
  const planId = String((filter && filter.planId) || '');
  const limit = Math.min(200, Math.max(1, Number(filter && filter.limit) || 50));
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, SHIPPING_PLAN_INDEX_COLUMNS.length)
    .getValues()
    .map(shippingPlanIndexRowToMetadata)
    .filter(metadata => metadata.schemaVersion === SHIPPING_PLAN_FORMAT && (!planId || metadata.planId === planId))
    .reverse()
    .slice(0, limit);
}

function getShippingPlanRevision(ss, request) {
  const planId = String((request && request.planId) || '');
  const revision = String((request && request.revision) || '');
  if (!planId) throw new Error('SHIPPING_PLAN_ID_REQUIRED');
  const indexSheet = ss.getSheetByName(SHEET_NAMES.SHIPPING_PLAN_INDEX);
  if (!indexSheet || indexSheet.getLastRow() < 2) throw new Error('SHIPPING_PLAN_REVISION_NOT_FOUND');
  ensureShippingPlanIndexHeader(indexSheet);
  const candidates = indexSheet
    .getRange(2, 1, indexSheet.getLastRow() - 1, SHIPPING_PLAN_INDEX_COLUMNS.length)
    .getValues()
    .map(shippingPlanIndexRowToMetadata)
    .filter(item => item.schemaVersion === SHIPPING_PLAN_FORMAT && item.planId === planId)
    .reverse();
  const metadata = revision ? candidates.find(item => item.revision === revision) : candidates[0];
  if (!metadata) throw new Error('SHIPPING_PLAN_REVISION_NOT_FOUND');
  const history = ss.getSheetByName(SHEET_NAMES.SHIPPING_PLAN_HISTORY);
  if (!history) throw new Error('SHIPPING_PLAN_HISTORY_MISSING');
  const rows = history.getRange(metadata.historyStartRow, 1, metadata.chunkCount, 4).getValues();
  const canonicalJson = rows.map((row, index) => {
    if (String(row[0]) !== metadata.planId || String(row[1]) !== metadata.revision || Number(row[2]) !== index + 1) {
      throw new Error('SHIPPING_PLAN_HISTORY_POINTER_INVALID');
    }
    return String(row[3] || '');
  }).join('');
  if (canonicalJson.length !== metadata.charCount) throw new Error('SHIPPING_PLAN_HISTORY_CHAR_COUNT_MISMATCH');
  const validated = validateShippingPlanEnvelope({
    schemaVersion: SHIPPING_PLAN_FORMAT,
    planId: metadata.planId,
    hashAlgorithm: 'SHA-256',
    hash: metadata.hash,
    rowCount: metadata.rowCount,
    cellCount: metadata.cellCount,
    canonicalJson
  });
  if (validated.productRowCount !== metadata.productRowCount || validated.purchaseUploadRowCount !== metadata.purchaseUploadRowCount) {
    throw new Error('SHIPPING_PLAN_INDEX_COUNT_MISMATCH');
  }
  return { metadata, plan: validated.canonical };
}

function parseDataOpsPromoCell(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const numberValue = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(numberValue) || numberValue < 0) throw new Error('DATAOPS_PROMO_INVALID');
  return numberValue;
}

function buildDataOpsRevision(basisDate, hash) {
  return `DATAOPS-${String(basisDate || '').replace(/[^0-9]/g, '')}-${String(hash || '').slice(0, 16)}`;
}

function validateDataOpsSnapshotEnvelope(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('DATAOPS_SNAPSHOT_REQUIRED');
  if (snapshot.schemaVersion !== DATAOPS_SNAPSHOT_FORMAT) throw new Error('DATAOPS_SCHEMA_INVALID');
  const basisDate = String(snapshot.basisDate || '');
  const basisTime = new Date(`${basisDate}T00:00:00.000Z`).getTime();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(basisDate) || Number.isNaN(basisTime) || new Date(basisTime).toISOString().slice(0, 10) !== basisDate) {
    throw new Error('DATAOPS_BASIS_DATE_INVALID');
  }
  if (String(snapshot.hashAlgorithm || '').toUpperCase() !== 'SHA-256') throw new Error('DATAOPS_HASH_ALGORITHM_INVALID');
  const canonicalJson = String(snapshot.canonicalJson || '');
  if (!canonicalJson) throw new Error('DATAOPS_CANONICAL_JSON_REQUIRED');
  const actualHash = sha256Hex(canonicalJson);
  if (!constantTimeTextEquals(actualHash, String(snapshot.hash || '').toLowerCase())) throw new Error('DATAOPS_HASH_MISMATCH');
  const expectedRevision = buildDataOpsRevision(snapshot.basisDate, actualHash);

  let canonical;
  try { canonical = JSON.parse(canonicalJson); }
  catch (error) { throw new Error('DATAOPS_CANONICAL_JSON_INVALID'); }
  if (!canonical || canonical.schemaVersion !== DATAOPS_SNAPSHOT_FORMAT) throw new Error('DATAOPS_CANONICAL_SCHEMA_INVALID');
  if (String(canonical.basisDate || '') !== String(snapshot.basisDate || '')) throw new Error('DATAOPS_CANONICAL_BASIS_MISMATCH');
  if (!Array.isArray(canonical.columns) || JSON.stringify(canonical.columns) !== JSON.stringify(DATAOPS_SNAPSHOT_COLUMNS)) {
    throw new Error('DATAOPS_COLUMNS_INVALID');
  }
  if (!Array.isArray(canonical.rows) || canonical.rows.length > DATAOPS_SNAPSHOT_MAX_ROWS) throw new Error('DATAOPS_ROWS_INVALID');

  const promoByCode = {};
  canonical.rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== DATAOPS_SNAPSHOT_COLUMNS.length) throw new Error(`DATAOPS_ROW_WIDTH_INVALID:${rowIndex + 1}`);
    row.forEach((cell, columnIndex) => {
      const type = typeof cell;
      if (!(cell === null || type === 'string' || type === 'number' || type === 'boolean')) {
        throw new Error(`DATAOPS_CELL_TYPE_INVALID:${rowIndex + 1}:${columnIndex + 1}`);
      }
      if (type === 'number' && !Number.isFinite(cell)) throw new Error(`DATAOPS_CELL_NUMBER_INVALID:${rowIndex + 1}:${columnIndex + 1}`);
    });
    const code = String(row[1] === undefined || row[1] === null ? '' : row[1]).replace(/\.0$/, '').trim();
    const promo = parseDataOpsPromoCell(row[10]);
    if (code) {
      if (Object.prototype.hasOwnProperty.call(promoByCode, code) && promoByCode[code] !== promo) {
        throw new Error(`DATAOPS_PROMO_LOT_MISMATCH:${code}`);
      }
      promoByCode[code] = promo;
    }
  });

  const rowCount = canonical.rows.length;
  const cellCount = rowCount * DATAOPS_SNAPSHOT_COLUMNS.length;
  if (Number(snapshot.rowCount) !== rowCount) throw new Error('DATAOPS_ROW_COUNT_MISMATCH');
  if (Number(snapshot.cellCount) !== cellCount) throw new Error('DATAOPS_CELL_COUNT_MISMATCH');
  return {
    schemaVersion: DATAOPS_SNAPSHOT_FORMAT,
    revision: expectedRevision,
    basisDate: snapshot.basisDate,
    savedAt: snapshot.savedAt || '',
    hashAlgorithm: 'SHA-256',
    hash: actualHash,
    rowCount,
    cellCount,
    canonicalJson,
    canonical
  };
}

function oneappNexusRejectDataOpsSnapshotImmutableFields(snapshot) {
  const immutable = new Set(['savedAt', 'revision', '전산잔량', '로스']);
  const inspect = value => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.keys(value).forEach(key => {
      if (immutable.has(key)) throw new Error('IMMUTABLE_FIELD');
      inspect(value[key]);
    });
  };
  inspect(snapshot);
  return true;
}

function writeDataOpsSnapshotSlot(sheet, validated) {
  const chunks = splitDataOpsTextBySize(validated.canonicalJson, DATAOPS_SNAPSHOT_CHUNK_SIZE);
  const metadata = {
    schemaVersion: validated.schemaVersion,
    revision: validated.revision,
    basisDate: validated.basisDate,
    savedAt: validated.savedAt,
    hashAlgorithm: validated.hashAlgorithm,
    hash: validated.hash,
    rowCount: validated.rowCount,
    cellCount: validated.cellCount,
    chunkCount: chunks.length,
    charCount: validated.canonicalJson.length
  };
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 2).setValues([[DATAOPS_SNAPSHOT_FORMAT, JSON.stringify(metadata)]]);
  const rows = chunks.map((chunk, index) => [index + 1, chunk]);
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  return metadata;
}

function readDataOpsSnapshotSlot(sheet) {
  if (!sheet || sheet.getLastRow() < 2) throw new Error('DATAOPS_SLOT_EMPTY');
  if (String(sheet.getRange(1, 1).getValue() || '') !== DATAOPS_SNAPSHOT_FORMAT) throw new Error('DATAOPS_SLOT_FORMAT_INVALID');
  let metadata;
  try { metadata = JSON.parse(String(sheet.getRange(1, 2).getValue() || '{}')); }
  catch (error) { throw new Error('DATAOPS_SLOT_METADATA_INVALID'); }
  const chunkCount = Number(metadata.chunkCount);
  if (!Number.isInteger(chunkCount) || chunkCount < 1) throw new Error('DATAOPS_SLOT_CHUNK_COUNT_INVALID');
  const rows = sheet.getRange(2, 1, chunkCount, 2).getValues();
  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  const canonicalJson = rows.map(row => String(row[1] || '')).join('');
  if (canonicalJson.length !== Number(metadata.charCount)) throw new Error('DATAOPS_SLOT_CHAR_COUNT_MISMATCH');
  return validateDataOpsSnapshotEnvelope({ ...metadata, canonicalJson });
}

function commitDataOpsSnapshot(ss, snapshot) {
  oneappNexusRejectDataOpsSnapshotImmutableFields(snapshot);
  const validated = validateDataOpsSnapshotEnvelope(snapshot);
  // 동일한 로컬 미전송 작업을 재시도해도 원장 포인터를 다시 뒤집거나 새 revision을 만들지 않는다.
  try {
    const current = readCurrentDataOpsSnapshot(ss);
    if (current && current.hash === validated.hash && current.basisDate === validated.basisDate
      && Number(current.rowCount) === validated.rowCount && Number(current.cellCount) === validated.cellCount) {
      return { ...current, duplicate: true };
    }
  } catch (ignored) {
    // 기존 슬롯이 불완전하면 아래 staging 검증 경로로 정상 복구한다.
  }
  // 저장시각은 클라이언트 시각이 아니라 확정 commit을 수행한 서버 시각으로 고정한다.
  validated.savedAt = new Date().toISOString();
  const properties = PropertiesService.getScriptProperties();
  const currentSlot = String(properties.getProperty(DATAOPS_CURRENT_SLOT_PROPERTY) || '');
  const nextSlot = currentSlot === 'A' ? 'B' : 'A';
  const nextSheetName = nextSlot === 'A' ? SHEET_NAMES.DATAOPS_A : SHEET_NAMES.DATAOPS_B;
  const stagingSheet = getOrCreateSheet(ss, nextSheetName);
  writeDataOpsSnapshotSlot(stagingSheet, validated);
  const verified = readDataOpsSnapshotSlot(stagingSheet);
  if (verified.hash !== validated.hash || verified.rowCount !== validated.rowCount || verified.cellCount !== validated.cellCount) {
    throw new Error('DATAOPS_STAGING_VERIFY_FAILED');
  }
  properties.setProperty(DATAOPS_CURRENT_SLOT_PROPERTY, nextSlot);
  return verified;
}

function readCurrentDataOpsSnapshot(ss) {
  const currentSlot = String(PropertiesService.getScriptProperties().getProperty(DATAOPS_CURRENT_SLOT_PROPERTY) || '');
  if (currentSlot !== 'A' && currentSlot !== 'B') return null;
  const sheetName = currentSlot === 'A' ? SHEET_NAMES.DATAOPS_A : SHEET_NAMES.DATAOPS_B;
  const validated = readDataOpsSnapshotSlot(ss.getSheetByName(sheetName));
  return {
    schemaVersion: validated.schemaVersion,
    revision: validated.revision,
    basisDate: validated.basisDate,
    savedAt: validated.savedAt,
    hashAlgorithm: validated.hashAlgorithm,
    hash: validated.hash,
    rowCount: validated.rowCount,
    cellCount: validated.cellCount,
    columns: validated.canonical.columns,
    rows: validated.canonical.rows
  };
}

function oneappNexusSheetSnapshot(sheet) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];
  return sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
}

function oneappNexusRestoreSheet(sheet, values) {
  sheet.clearContents();
  if (Array.isArray(values) && values.length && values[0].length) sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
}

function oneappNexusFoundationReplaceAll(ss, payload) {
  const transactionId = String(payload.transactionId || '');
  if (!/^NXTX-[0-9a-f-]{36}$/i.test(transactionId)) throw new Error('ONEAPP_NEXUS_TRANSACTION_ID_INVALID');
  const masterInput = payload.master && typeof payload.master === 'object' ? payload.master : {};
  const masterRows = (Array.isArray(masterInput) ? masterInput : Object.values(masterInput))
    .filter(item => item && (item.코드 || item.품목코드))
    .map(item => [String(item.코드 || item.품목코드), JSON.stringify(item)]);
  if (new Set(masterRows.map(row => row[0])).size !== masterRows.length) throw new Error('ONEAPP_NEXUS_MASTER_DUPLICATE_CODE');
  const historyRows = (Array.isArray(payload.history) ? payload.history : []).map(item => [JSON.stringify(item)]);
  const activeSlot = oneappNexusFoundationActiveSlot();
  const stagingSlot = activeSlot === 'A' ? 'B' : 'A';
  const masterSheet = oneappNexusFoundationSheet(ss, 'MASTER', stagingSlot);
  const historySheet = oneappNexusFoundationSheet(ss, 'HISTORY', stagingSlot);
  const configSheet = oneappNexusFoundationSheet(ss, 'CONFIG', stagingSlot);
  const activeConfigSheet = oneappNexusFoundationSheet(ss, 'CONFIG', activeSlot, false);
  const configData = Object.prototype.hasOwnProperty.call(payload, 'config')
    ? (payload.config || {}) : loadConfigData(activeConfigSheet);
  try {
    masterSheet.clearContents();
    historySheet.clearContents();
    configSheet.clearContents();
    for (let offset = 0; offset < masterRows.length; offset += 500) {
      const chunk = masterRows.slice(offset, offset + 500);
      if (chunk.length) masterSheet.getRange(offset + 1, 1, chunk.length, 2).setValues(chunk);
    }
    for (let offset = 0; offset < historyRows.length; offset += 500) {
      const chunk = historyRows.slice(offset, offset + 500);
      if (chunk.length) historySheet.getRange(offset + 1, 1, chunk.length, 1).setValues(chunk);
    }
    saveConfigData(configSheet, configData);
    const verifiedMaster = readMasterData(ss, stagingSlot);
    const verifiedHistory = readHistoryData(ss, stagingSlot);
    loadConfigData(configSheet);
    if (Object.keys(verifiedMaster).length !== masterRows.length || verifiedHistory.length !== historyRows.length) throw new Error('ONEAPP_NEXUS_REPLACE_VERIFY_FAILED');
    PropertiesService.getScriptProperties().setProperty(FOUNDATION_LEGACY_STAGING_SLOT_PROPERTY, '');
    oneappNexusFoundationActivate(stagingSlot);
    return { transactionId, status: 'ACTIVATED', activeSlot: stagingSlot, masterCount: masterRows.length, historyCount: historyRows.length, activatedAt: new Date().toISOString() };
  } catch (error) {
    throw new Error(/^ONEAPP_NEXUS_/.test(String(error && error.message || '')) ? error.message : 'ONEAPP_NEXUS_REPLACE_STAGING_FAILED');
  }
}

function oneappNexusFoundationHistory(ss, payload) {
  const limit = Math.max(1, Math.min(5000, Number(payload.limit || 5000)));
  const code = String(payload.code || '');
  const field = String(payload.field || '');
  const cutoff = Date.now() - Math.max(1, Math.min(3650, Number(payload.days || 365))) * 86400000;
  return readHistoryData(ss).filter(item => {
    if (code && String(item.code || item.코드 || item.productCode || item.품목코드 || '') !== code) return false;
    if (field && String(item.field || item.path || item.column || '') !== field) return false;
    const at = Date.parse(item.timestamp || item.at || item.createdAt || '');
    return !at || at >= cutoff;
  }).slice(-limit);
}

// [POST] 클라이언트 데이터 수신
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('POST 데이터가 없습니다.');
    const payload = JSON.parse(e.postData.contents);
    const action = String(payload.action || '');
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (/^(full|master_only|config_only)$/.test(action)) {
      if (!oneappNexusGatewayRequire(payload, 'FOUNDATION', 'READ')) throw new Error('ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED');
      if (action === 'config_only') {
        return jsonResponse({ status: 'success', action, data: normalizeConfigResult(oneappNexusFoundationConfig(ss)) });
      }
      if (action === 'master_only') {
        const master = readMasterData(ss);
        return jsonResponse({ status: 'success', action, data: { master, summary: { masterCount: Object.keys(master).length } } });
      }
      const master = readMasterData(ss);
      const history = readHistoryData(ss);
      return jsonResponse({ status: 'success', action, data: { master, history, ...normalizeConfigResult(oneappNexusFoundationConfig(ss)) } });
    }

    if (action === 'nexus_gateway_foundation_full_get') {
      if (!oneappNexusGatewayRequire(payload, 'FOUNDATION', 'READ')) throw new Error('ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED');
      const config = normalizeConfigResult(oneappNexusFoundationConfig(ss));
      return jsonResponse({ status: 'success', action, data: { master: readMasterData(ss), history: readHistoryData(ss), ...config } });
    }
    if (action === 'nexus_gateway_foundation_master_get') {
      if (!oneappNexusGatewayRequire(payload, 'FOUNDATION', 'READ')) throw new Error('ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED');
      const master = readMasterData(ss);
      return jsonResponse({ status: 'success', action, data: { master, summary: { masterCount: Object.keys(master).length } } });
    }
    if (action === 'nexus_gateway_foundation_config_get') {
      if (!oneappNexusGatewayRequire(payload, 'FOUNDATION', 'READ')) throw new Error('ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED');
      return jsonResponse({ status: 'success', action, data: normalizeConfigResult(oneappNexusFoundationConfig(ss)) });
    }
    if (action === 'nexus_gateway_foundation_history_get') {
      if (!oneappNexusGatewayRequire(payload, 'FOUNDATION', 'READ')) throw new Error('ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED');
      const history = oneappNexusFoundationHistory(ss, payload);
      return jsonResponse({ status: 'success', action, data: { history, summary: { historyCount: history.length } } });
    }
    if (action === 'nexus_gateway_foundation_metadata_get') {
      const foundationAuth = oneappNexusGatewayRequire(payload, 'FOUNDATION', 'READ');
      return withScriptLock(() => jsonResponse({
        status: 'success',
        action,
        data: foundationMetadataRead(ss, payload, foundationAuth)
      }));
    }
    if (action === 'nexus_gateway_foundation_metadata_write') {
      const foundationAuth = oneappNexusGatewayRequire(payload, 'FOUNDATION', 'WRITE');
      return withScriptLock(() => jsonResponse({
        status: 'success',
        action,
        data: foundationMetadataWrite(ss, payload, foundationAuth)
      }));
    }
    if (action === 'nexus_gateway_foundation_config_write') {
      if (!oneappNexusGatewayRequire(payload, 'FOUNDATION', 'WRITE')) throw new Error('ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: saveConfigData(oneappNexusFoundationSheet(ss, 'CONFIG', oneappNexusFoundationActiveSlot()), payload.data || {}) }));
    }
    if (action === 'nexus_gateway_foundation_replace_all') {
      const foundationAuth = oneappNexusGatewayRequire(payload, 'FOUNDATION', 'WRITE');
      if (!foundationAuth || !foundationAuth.roleIds.includes('FOUNDATION_REPLACE')) throw new Error('ONEAPP_NEXUS_GATEWAY_ROLE_DENIED');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: oneappNexusFoundationReplaceAll(ss, payload) }));
    }

    if (action === 'orderq_customer_reset_preview') {
      requireOrderQAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: {
        schemaVersion: ORDERQ_SYNC_SCHEMA,
        spreadsheet: { id: ss.getId(), name: ss.getName() },
        plan: orderQCustomerResetPlan(ss)
      } }));
    }

    if (action === 'orderq_customer_reset_execute') {
      requireOrderQAccess(payload, 'WRITE');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: orderQCustomerMasterReset(ss, payload) }));
    }

    if (action === 'orderq_customer_master_push') {
      requireOrderQAccess(payload, 'WRITE');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: orderQCustomerMasterPush(ss, payload) }));
    }

    if (action === 'orderq_customer_master_pull') {
      requireOrderQAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: orderQCustomerMasterPull(ss, payload) }));
    }

    if (action === 'orderq_sync_push') {
      requireOrderQAccess(payload, 'WRITE');
      return withScriptLock(() => jsonResponse({
        status: 'success', action, data: orderQSyncPush(ss, payload)
      }));
    }

    if (action === 'orderq_sync_pull') {
      requireOrderQAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({
        status: 'success', action, data: orderQSyncPull(ss, payload)
      }));
    }

    if (action === 'orderq_order_head') {
      requireOrderQAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({
        status: 'success', action, data: orderQOrderHead(ss, payload)
      }));
    }

    if (action === 'orderq_m9_ping') {
      requireOrderQAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: orderQM9Ping(ss, payload) }));
    }

    if (action === 'orderq_m9_migrate') {
      requireOrderQAccess(payload, 'WRITE');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: orderQM9Migrate(ss, payload) }));
    }

    if (action === 'orderq_m9_command_prepare') {
      requireOrderQAccess(payload, 'WRITE');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: orderQM9Prepare(ss, payload) }));
    }

    if (action === 'orderq_m9_command_commit') {
      requireOrderQAccess(payload, 'WRITE');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: orderQM9Commit(ss, payload) }));
    }

    if (action === 'orderq_m9_command_abort') {
      requireOrderQAccess(payload, 'WRITE');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: orderQM9Abort(ss, payload) }));
    }

    if (action === 'orderq_m9_pull') {
      requireOrderQAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({ status: 'success', action, data: orderQM9Pull(ss, payload) }));
    }

    if (action === 'situation_orderq_begin') {
      requireOrderQAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({ status:'success', action, data:orderQM9SituationBegin(ss,payload) }));
    }

    if (action === 'situation_orderq_page') {
      requireOrderQAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({ status:'success', action, data:orderQM9SituationPage(ss,payload) }));
    }

    if (action === 'situation_orderq_head') {
      requireOrderQAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({ status:'success', action, data:orderQM9SituationHead(ss,payload) }));
    }

    if (action === 'shipping_plan_save') {
      requireShippingPlanAccess(payload, 'WRITE');
      return withScriptLock(() => {
        const validated = validateShippingPlanEnvelope(payload.snapshot);
        const saved = appendShippingPlanRevision(ss, validated);
        return jsonResponse({ status: 'success', action, data: saved });
      });
    }

    if (action === 'shipping_plan_list') {
      requireShippingPlanAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({
        status: 'success',
        action,
        data: listShippingPlanRevisions(ss, payload)
      }));
    }

    if (action === 'shipping_plan_get') {
      requireShippingPlanAccess(payload, 'READ');
      return withScriptLock(() => jsonResponse({
        status: 'success',
        action,
        data: getShippingPlanRevision(ss, payload)
      }));
    }

    if (payload.nexusRequest && payload.nexusRequest.contractVersion === 'NEXUS_AUTH_V2' && (/^dataops_/.test(action) || /^situation_dataops_/.test(action))) {
      const dataOpsAccess = /(_commit|_publish|_prepare|_write_chunks|_abort)$/.test(action) ? 'WRITE' : 'READ';
      oneappNexusGatewayRequire(payload, 'DATAOPS', dataOpsAccess);
    } else if (/^dataops_/.test(action) || /^situation_dataops_/.test(action)) {
      oneappNexusLegacyUsageAudit(payload, 'DATAOPS', /(_commit|_publish|_prepare|_write_chunks|_abort)$/.test(action) ? 'WRITE' : 'READ');
    }

    if (/^dataops_close_(ping|context|seal|prepare|write_chunks|commit|abort)$/.test(action)) {
      return withScriptLock(() => jsonResponse({ status:'success', action, data:dataOpsCloseHandleAction(ss,action,payload) }));
    }

    if (action === 'dataops_v1_security_ping') {
      return jsonResponse({ status:'success', action, data:dataOpsV1SecurityCapability(PropertiesService.getScriptProperties()) });
    }

    typeof dataOpsV1PreflightAction !== 'undefined'
      && dataOpsV1PreflightAction(action,payload,PropertiesService.getScriptProperties());

    if (/^situation_dataops_(ping|publish|begin|page|head)$/.test(action)) {
      return withScriptLock(() => jsonResponse({
        status: 'success',
        action,
        data: dataOpsSituationHandleAction(ss, action, payload)
      }));
    }

    if (action === 'dataops_snapshot_commit') {
      return withScriptLock(() => {
        const saved = commitDataOpsSnapshot(ss, payload.snapshot);
        return jsonResponse({
          status: 'success',
          action,
          data: {
            schemaVersion: saved.schemaVersion,
            revision: saved.revision,
            basisDate: saved.basisDate,
            savedAt: saved.savedAt,
            hash: saved.hash,
            rowCount: saved.rowCount,
            cellCount: saved.cellCount,
            duplicate: Boolean(saved.duplicate)
          }
        });
      });
    }

    if (action === 'dataops_snapshot_get') {
      return withScriptLock(() => {
        const snapshot = readCurrentDataOpsSnapshot(ss);
        return jsonResponse({ status: 'success', action, data: snapshot });
      });
    }

    if (action === 'initSync') {
      const legacyFoundationAuth = oneappNexusGatewayRequire(payload, 'FOUNDATION', 'WRITE');
      if (!legacyFoundationAuth || !legacyFoundationAuth.roleIds.includes('FOUNDATION_REPLACE')) throw new Error('ONEAPP_NEXUS_GATEWAY_ROLE_DENIED');
      oneappNexusLegacyUsageAudit(payload, 'FOUNDATION', 'WRITE');
      return withScriptLock(() => {
        const stagingSlot = oneappNexusFoundationBeginLegacyStage(ss);
        return jsonResponse({ status: 'success', action, data: { stagingSlot } });
      });
    }

    if (action === 'chunk_master') {
      const legacyFoundationAuth = oneappNexusGatewayRequire(payload, 'FOUNDATION', 'WRITE');
      if (!legacyFoundationAuth || !legacyFoundationAuth.roleIds.includes('FOUNDATION_REPLACE')) throw new Error('ONEAPP_NEXUS_GATEWAY_ROLE_DENIED');
      oneappNexusLegacyUsageAudit(payload, 'FOUNDATION', 'WRITE');
      return withScriptLock(() => {
        const stagingSlot = oneappNexusFoundationRequireLegacyStage();
        const sheet = oneappNexusFoundationSheet(ss, 'MASTER', stagingSlot);
        const data = Array.isArray(payload.data) ? payload.data : [];
        if (data.length > 0) {
          const rows = data
            .filter(item => item && (item.코드 || item.품목코드))
            .map(item => [String(item.코드 || item.품목코드), JSON.stringify(item)]);
          if (rows.length > 0) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
        }
        return jsonResponse({ status: 'success', action, count: data.length });
      });
    }

    if (action === 'chunk_history') {
      const legacyFoundationAuth = oneappNexusGatewayRequire(payload, 'FOUNDATION', 'WRITE');
      if (!legacyFoundationAuth || !legacyFoundationAuth.roleIds.includes('FOUNDATION_REPLACE')) throw new Error('ONEAPP_NEXUS_GATEWAY_ROLE_DENIED');
      oneappNexusLegacyUsageAudit(payload, 'FOUNDATION', 'WRITE');
      return withScriptLock(() => {
        const stagingSlot = oneappNexusFoundationRequireLegacyStage();
        const sheet = oneappNexusFoundationSheet(ss, 'HISTORY', stagingSlot);
        const data = Array.isArray(payload.data) ? payload.data : [];
        if (data.length > 0) {
          const rows = data.map(log => [JSON.stringify(log)]);
          sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 1).setValues(rows);
        }
        return jsonResponse({ status: 'success', action, count: data.length });
      });
    }

    if (action === 'config') {
      if (!oneappNexusGatewayRequire(payload, 'FOUNDATION', 'WRITE')) throw new Error('ONEAPP_NEXUS_GATEWAY_ACCESS_DENIED');
      oneappNexusLegacyUsageAudit(payload, 'FOUNDATION', 'WRITE');
      return withScriptLock(() => {
        const stage = oneappNexusFoundationLegacyStageState();
        if (stage) {
          const summary = oneappNexusFoundationFinalizeLegacyStage(ss, payload.data || {});
          return jsonResponse({ status: 'success', action, summary });
        }
        const sheet = oneappNexusFoundationSheet(ss, 'CONFIG', oneappNexusFoundationActiveSlot());
        const summary = saveConfigData(sheet, payload.data || {});
        return jsonResponse({ status: 'success', action, summary });
      });
    }

    throw new Error('알 수 없는 Action입니다: ' + action);
  } catch (error) {
    const response = { status: 'error', message: String(error && error.message ? error.message : error) };
    if (Number.isFinite(Number(error && error.latestRevision))) response.latestRevision = Number(error.latestRevision);
    return jsonResponse(response);
  }
}

// [GET] 공개 직접 조회는 금지한다. Foundation 조회는 NEXUS Gateway의 인증된 POST 경로만 사용한다.
function doGet() {
  return jsonResponse({ status: 'error', message: 'ONEAPP_NEXUS_GATEWAY_ACCESS_REQUIRED' });
}

// Phase 2 compatibility guard: keep the frozen V1 snapshot implementation byte-identical while
// extending the ONEAPP server boundary with the template-derived expected-balance field.
function oneappNexusRejectDataOpsSnapshotImmutableFields(snapshot) {
  const immutable = new Set(['savedAt', 'revision', '전산잔량', '예상잔량', '로스']);
  const inspect = value => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.keys(value).forEach(key => {
      if (immutable.has(key)) throw new Error('IMMUTABLE_FIELD');
      inspect(value[key]);
    });
  };
  inspect(snapshot);
  return true;
}
