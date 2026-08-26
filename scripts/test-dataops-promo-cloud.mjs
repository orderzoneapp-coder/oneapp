import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { TextEncoder } from 'node:util';

const dataOpsSource = fs.readFileSync('DataOps.html', 'utf8');
const merchSource = fs.readFileSync('MerchOps.html', 'utf8');
const serverSource = fs.readFileSync('code.gs', 'utf8');

const extract = (source, startText, endText) => {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `module markers missing: ${startText}`);
  return source.slice(start, end);
};

const dataOpsContext = {
  console,
  TextEncoder,
  safeNum: value => Number.isFinite(Number(value)) ? Number(value) : 0,
  safeStr: (value, fallback = '') => value === null || value === undefined || String(value).trim() === '' ? fallback : String(value).trim(),
  DATAOPS_CLOUD_MODULE: {
    normalizeUrl: value => String(value || '').trim(),
    getCloudUrl: () => 'https://example.invalid/exec',
    readJsonResponse: async response => response.json()
  },
  DATAOPS_VIEW_LAYER_MODULE: {
    buildCodeSummaryRows: rows => rows
  },
  FILTER_SORT_MODULE: {
    compareByCodeThenName: () => 0
  },
  EXPORT_MODULE: {
    buildNextBaseStockRows: ({ productData }) => productData
  },
  fetch: async () => { throw new Error('unexpected fetch'); }
};
dataOpsContext.window = dataOpsContext;
dataOpsContext.window.crypto = crypto.webcrypto;
vm.createContext(dataOpsContext);
const dataOpsSnapshotModuleSource = extract(dataOpsSource, 'const DATAOPS_MERCH_STOCK_SYNC_MODULE', 'const STORAGE_MODULE');
assert.doesNotMatch(dataOpsSource, /oneapp_dataops_cloud_token_v1|DATAOPS_CLOUD_TOKEN_KEY|getAccessToken|ONEAPP_DATAOPS_ACCESS_TOKEN/, 'DataOps source must not retain an operator-token key, accessor, or server-property instruction');
assert.doesNotMatch(dataOpsSnapshotModuleSource, /window\.prompt|localStorage|\btoken\s*[:,]|getAccessToken/, 'DataOps snapshot module must not prompt, persist, load, or send a token');
vm.runInContext(
  dataOpsSnapshotModuleSource,
  dataOpsContext
);

const rawRows = [{
  단위: 'EA', 품목코드: '100', 품명: '테스트', 규격: '', 재고: 0,
  기록: '', 거래: '거래처', 구매가: 2500, 기본: '', 적요: '', 행사가: 0
}];
const envelope = await dataOpsContext.DATAOPS_MERCH_STOCK_SYNC_MODULE.buildSnapshot({ productData: rawRows, targetDateStr: '2026-08-04' });
const canonical = JSON.parse(envelope.canonicalJson);
assert.deepEqual(Array.from(canonical.columns), ['단위', '품목코드', '품명', '규격', '재고', '기록', '거래', '구매가', '기본', '적요', '행사가']);
assert.equal(canonical.rows[0][3], '', 'blank cell must remain blank');
assert.equal(canonical.rows[0][4], 0, 'numeric zero must remain numeric zero');
assert.equal(canonical.rows[0][6], '거래처', 'raw row ordering/value must remain stable');
assert.equal(envelope.rowCount, 1);
assert.equal(envelope.cellCount, 11);
assert.equal(envelope.hash, crypto.createHash('sha256').update(envelope.canonicalJson).digest('hex'));
assert.match(dataOpsContext.DATAOPS_MERCH_STOCK_SYNC_MODULE.mapCommitError('DATAOPS_HASH_MISMATCH'), /스냅샷 검증 실패/, 'snapshot validation errors must remain explicit');
let dataOpsCommitBody = null;
dataOpsContext.fetch = async (_url, options) => {
  dataOpsCommitBody = JSON.parse(options.body);
  return {
  ok: true,
  status: 200,
  json: async () => ({ status: 'success', data: { revision: 'R1', hash: envelope.hash, rowCount: envelope.rowCount, cellCount: envelope.cellCount, basisDate: envelope.basisDate } })
  };
};
await dataOpsContext.DATAOPS_MERCH_STOCK_SYNC_MODULE.commit({ productData: rawRows, targetDateStr: '2026-08-04' });
assert.equal(dataOpsCommitBody.action, 'dataops_snapshot_commit');
assert.equal(dataOpsCommitBody.snapshot.canonicalJson, envelope.canonicalJson, 'DataOps commit must preserve the canonical 11-column V1 payload');
assert.equal(dataOpsCommitBody.snapshot.hash, envelope.hash);
assert.equal(Object.prototype.hasOwnProperty.call(dataOpsCommitBody, 'token'), false, 'the legacy-compatible producer must not invent a credential field');

let snapshotReadBody = null;
const merchSnapshotContext = {
  console,
  TextEncoder,
  URL,
  Map,
  Set,
  fetch: async () => { throw new Error('legacy anonymous fetch must not run'); },
  prompt: () => { throw new Error('credential prompt must not run for a configured in-memory client'); }
};
merchSnapshotContext.window = merchSnapshotContext;
merchSnapshotContext.window.crypto = crypto.webcrypto;
merchSnapshotContext.window.getOneAppCloudSyncUrl = () => 'https://example.invalid/exec';
merchSnapshotContext.window.DATAOPS_V1_SECURITY_CLIENT = {
  readClient: {
    released: () => true,
    ready: () => true,
    getSnapshot: async request => {
      snapshotReadBody = request;
      return null;
    }
  }
};
vm.createContext(merchSnapshotContext);
const merchSnapshotModuleSource = extract(merchSource, 'window.MERCH_DATAOPS_SNAPSHOT_MODULE = Object.freeze({', '        // [M-NAV-01]');
assert.doesNotMatch(merchSnapshotModuleSource, /localStorage|sessionStorage|getAccessToken/, 'MerchOps must keep the prompted READ credential in memory only');
assert.match(merchSnapshotModuleSource, /readClient\.getSnapshot/, 'MerchOps must delegate the authenticated envelope to the V1 security client');
vm.runInContext(merchSnapshotModuleSource, merchSnapshotContext);
await assert.rejects(
  merchSnapshotContext.window.MERCH_DATAOPS_SNAPSHOT_MODULE.fetchLatest(),
  /확정된 DataOps 클라우드 재고자료가 없습니다/,
  'a successful empty read must be distinguished from connection failures'
);
assert.equal(snapshotReadBody.url, 'https://example.invalid/exec', 'MerchOps must route the read through the authenticated V1 client');
assert.match(merchSnapshotContext.window.MERCH_DATAOPS_SNAPSHOT_MODULE.mapReadError('알 수 없는 Action입니다: dataops_snapshot_get'), /아직 배포되지 않았습니다/);
assert.match(merchSnapshotContext.window.MERCH_DATAOPS_SNAPSHOT_MODULE.mapReadError('DATAOPS_ACCESS_NOT_CONFIGURED'), /쓰기 토큰이 설정되지 않았습니다/);
assert.match(merchSnapshotContext.window.MERCH_DATAOPS_SNAPSHOT_MODULE.mapReadError('DATAOPS_ACCESS_DENIED'), /이전 토큰 인증/);
assert.match(merchSnapshotContext.window.MERCH_DATAOPS_SNAPSHOT_MODULE.mapReadError('', 503), /HTTP 503/);
assert.match(merchSnapshotContext.window.MERCH_DATAOPS_SNAPSHOT_MODULE.mapReadError(''), /응답 형식/);
merchSnapshotContext.window.getOneAppCloudSyncUrl = () => 'invalid-url';
await assert.rejects(merchSnapshotContext.window.MERCH_DATAOPS_SNAPSHOT_MODULE.fetchLatest(), /클라우드 주소가 올바르지 않습니다/);
merchSnapshotContext.window.getOneAppCloudSyncUrl = () => 'https://example.invalid/exec';
merchSnapshotContext.window.DATAOPS_V1_SECURITY_CLIENT.readClient.getSnapshot = async () => { throw new Error('network down'); };
await assert.rejects(merchSnapshotContext.window.MERCH_DATAOPS_SNAPSHOT_MODULE.fetchLatest(), /클라우드 서버에 연결할 수 없습니다/);

const merchContext = {
  console,
  window: null,
  Map,
  Set
};
merchContext.window = merchContext;
merchContext.window.parseNum = value => {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};
merchContext.window.hasMerchSourceObjectData = source => !!source && Object.keys(source).some(key => !key.startsWith('_'));
merchContext.window.computeFinalData = (_master, sources) => ({ fromRole: sources._activeRole || '' });
vm.createContext(merchContext);
vm.runInContext(extract(merchSource, 'window.MERCH_DATAOPS_PROMO_MODULE', '        window.computeFinalData ='), merchContext);

const promoModule = merchContext.window.MERCH_DATAOPS_PROMO_MODULE;
const dataOpsRow = {
  코드: '100',
  sources: { inventory: { _dataOpsRevision: 'R1', 행사가: 2500 } },
  finalData: {}
};
let resolved = promoModule.resolve(dataOpsRow, { 행사가: 3000 });
assert.equal(resolved.price, 2500);
assert.equal(resolved.conflict, true);
assert.equal(resolved.conflictMessage, 'DataOps 행사가 적용 / MerchOps 3,000원 → DataOps 2,500원');
assert.equal(promoModule.resolve({ ...dataOpsRow, sources: { inventory: { _dataOpsRevision: 'R1', 행사가: 3000 } } }, { 행사가: 3000 }).conflict, false);
assert.equal(promoModule.resolve({ ...dataOpsRow, sources: { inventory: { _dataOpsRevision: 'R1', 행사가: 0 } } }, { 행사가: 3000 }).price, 3000, 'DataOps zero must fall back to MerchOps own promo');
assert.equal(promoModule.resolve({ ...dataOpsRow, sources: { inventory: { _dataOpsRevision: 'R1', 행사가: '' }, _merchOwnPromoState: { source: 'estimate', value: 3500 } } }, { 행사가: 3000 }).price, 3500, 'explicit estimate promo must precede master promo');

const f7BaseSources = {
  inventory: { _dataOpsRevision: 'R1', 행사가: 2500 },
  estimate: { 행사가: 2800 }
};
const f7SourcesBefore = JSON.stringify(f7BaseSources);
let f7PromoCommit = promoModule.resolveF7MasterPromoCommit({ sources: f7BaseSources, activeRole: 'estimate', masterPromo: 3000 });
assert.deepEqual({ ...f7PromoCommit }, { handled: true, shouldWrite: true, value: 2800 }, 'F7 must confirm only the explicit positive estimate promo');
f7PromoCommit = promoModule.resolveF7MasterPromoCommit({
  sources: { ...f7BaseSources, _dataOpsPromoState: { revision: 'R1', value: 2700 } },
  activeRole: 'estimate',
  masterPromo: 3000
});
assert.equal(f7PromoCommit.value, 2800, 'F7 estimate commit must ignore the DataOps revision override');
['', 0].forEach(estimatePromo => {
  const result = promoModule.resolveF7MasterPromoCommit({
    sources: { inventory: { _dataOpsRevision: 'R1', 행사가: 2500 }, estimate: { 행사가: estimatePromo } },
    activeRole: 'estimate',
    masterPromo: 3000
  });
  assert.deepEqual({ ...result }, { handled: true, shouldWrite: false, value: 3000 }, 'blank/zero estimate promo must preserve master promo');
});
['inventory', 'purchase'].forEach(activeRole => {
  const result = promoModule.resolveF7MasterPromoCommit({
    sources: { ...f7BaseSources, _dataOpsPromoState: { revision: 'R1', value: 2700 } },
    activeRole,
    masterPromo: 3000
  });
  assert.deepEqual({ ...result }, { handled: true, shouldWrite: false, value: 3000 }, `${activeRole} F7 must preserve master promo`);
});
assert.equal(JSON.stringify(f7BaseSources), f7SourcesBefore, 'F7 promo policy must not mutate separated source state');
assert.equal(promoModule.resolve({ ...dataOpsRow, sources: { inventory: { _dataOpsRevision: 'R1', 행사가: 2500 }, _dataOpsPromoState: { revision: 'R1', value: 2700 } } }, { 행사가: 3000 }).price, 2700, 'F8/F9 effective resolver must keep the current-revision override');

resolved = promoModule.resolve({
  ...dataOpsRow,
  sources: {
    inventory: { _dataOpsRevision: 'R1', 행사가: 2500 },
    _dataOpsPromoState: { revision: 'R1', value: 2700 }
  }
}, { 행사가: 3000 });
assert.equal(resolved.price, 2700);
assert.equal(resolved.hasOverride, true);
assert.equal(resolved.conflict, false);
resolved = promoModule.resolve({
  ...dataOpsRow,
  sources: {
    inventory: { _dataOpsRevision: 'R2', 행사가: 2500 },
    _dataOpsPromoState: { revision: 'R1', value: 2700 }
  }
}, { 행사가: 3000 });
assert.equal(resolved.price, 2500, 'new revision must clear old override effect');
assert.equal(resolved.conflict, true, 'new revision must resurface conflict');

const managedBeforeReplace = {
  '100__INV__1': { 코드: '100', sources: { inventory: { _dataOpsRevision: 'R1', 행사가: 2500 }, _dataOpsPromoState: { revision: 'R1', value: 2700 }, _activeRole: 'inventory' }, finalData: {}, _tags: new Set(['excel:재고업로드']) },
  '100__INV__2': { 코드: '100', sources: { inventory: { _dataOpsRevision: 'R1', 행사가: 2500 }, _activeRole: 'inventory' }, finalData: {}, _tags: new Set(['excel:재고업로드']) },
  '100': { 코드: '100', sources: { estimate: { 행사가: 3000 }, _activeRole: 'estimate' }, finalData: {}, _tags: new Set(['excel:견적업로드']) },
  '200__INV__1': { 코드: '200', sources: { inventory: { _dataOpsRevision: 'R0', 행사가: 2000 }, purchase: { 입고가: 1000 }, _activeRole: 'inventory' }, finalData: {}, _tags: new Set(['excel:재고업로드', 'excel:구매업로드']) }
};
const sameRevisionReplace = promoModule.prepareFullInventoryReplace(managedBeforeReplace, {}, [], 'R1');
assert.equal(sameRevisionReplace.items['100__INV__1'], undefined, 'old pure inventory LOT must be removed');
assert.ok(sameRevisionReplace.items['100'], 'estimate source must be preserved');
assert.ok(sameRevisionReplace.items['200__INV__1'].sources.purchase, 'other source must be preserved');
assert.equal(sameRevisionReplace.items['200__INV__1'].sources.inventory, undefined, 'inventory source must be removed from mixed row');
assert.equal(sameRevisionReplace.retainedPromoStateByCode.get('100').value, 2700, 'same revision override must be retained');
const newRevisionReplace = promoModule.prepareFullInventoryReplace(managedBeforeReplace, {}, [], 'R2');
assert.equal(newRevisionReplace.retainedPromoStateByCode.size, 0, 'new revision must drop override state');

class RangeMock {
  constructor(sheet, row, column, numRows = 1, numColumns = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }
  setValues(values) {
    if (this.sheet.failNextWrite) {
      this.sheet.failNextWrite = false;
      throw new Error('SIMULATED_STAGING_WRITE_FAILURE');
    }
    values.forEach((valuesRow, r) => valuesRow.forEach((value, c) => this.sheet.setCell(this.row + r, this.column + c, value)));
    return this;
  }
  getValues() {
    return Array.from({ length: this.numRows }, (_, r) => Array.from({ length: this.numColumns }, (_, c) => this.sheet.getCell(this.row + r, this.column + c)));
  }
  getValue() { return this.sheet.getCell(this.row, this.column); }
}

class SheetMock {
  constructor(name) { this.name = name; this.cells = new Map(); this.failNextWrite = false; }
  key(row, column) { return `${row}:${column}`; }
  setCell(row, column, value) { this.cells.set(this.key(row, column), value); }
  getCell(row, column) { return this.cells.get(this.key(row, column)) ?? ''; }
  getRange(rowOrA1, column, numRows, numColumns) {
    if (typeof rowOrA1 === 'string') {
      assert.equal(rowOrA1, 'B1');
      return new RangeMock(this, 1, 2, 1, 1);
    }
    return new RangeMock(this, rowOrA1, column, numRows || 1, numColumns || 1);
  }
  clearContents() { this.cells.clear(); }
  getLastRow() {
    let last = 0;
    for (const key of this.cells.keys()) last = Math.max(last, Number(key.split(':')[0]));
    return last;
  }
}

class SpreadsheetMock {
  constructor() { this.sheets = new Map(); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const sheet = new SheetMock(name); this.sheets.set(name, sheet); return sheet; }
}

const spreadsheet = new SpreadsheetMock();
const properties = new Map();
const serverContext = {
  console,
  SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
  PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || '', setProperty: (key, value) => properties.set(key, value) }) },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest: (_algorithm, text) => Array.from(crypto.createHash('sha256').update(String(text)).digest())
  },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: text => ({ text, setMimeType() { return this; } })
  }
};
vm.createContext(serverContext);
vm.runInContext(serverSource, serverContext);
const unicodeChunks = serverContext.splitDataOpsTextBySize(`${'a'.repeat(44999)}😀z`, 45000);
assert.equal(unicodeChunks.join(''), `${'a'.repeat(44999)}😀z`);
assert.notEqual(unicodeChunks[0].charCodeAt(unicodeChunks[0].length - 1), 0xD83D, 'snapshot chunks must not split a surrogate pair');

const post = payload => JSON.parse(serverContext.doPost({ postData: { contents: JSON.stringify(payload) } }).text);
const get = action => JSON.parse(serverContext.doGet({ parameter: { action } }).text);
const canonicalRows = [
  ['BOX', '100', '상품A', '10kg', 3, '2026-08-03', '공급사A', 10000, '1', '', 2500],
  ['EA', '200', '상품B', '', 0, '', '', 0, '', '', 0],
  ['EA', '200', '상품B', '', 1, '', '', 0, '', '', '']
];
const makeSnapshot = (rows, basisDate = '2026-08-04') => {
  const canonicalJson = JSON.stringify({ schemaVersion: 'ONEAPP_DATAOPS_SNAPSHOT_V1', basisDate, columns: ['단위', '품목코드', '품명', '규격', '재고', '기록', '거래', '구매가', '기본', '적요', '행사가'], rows });
  return {
    schemaVersion: 'ONEAPP_DATAOPS_SNAPSHOT_V1', basisDate, savedAt: '2026-08-04T01:00:00.000Z',
    hashAlgorithm: 'SHA-256', hash: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    rowCount: rows.length, cellCount: rows.length * 11, canonicalJson
  };
};

assert.equal(post({ action: 'dataops_snapshot_get' }).status, 'success', 'snapshot read must not require a token');
assert.equal(post({ action: 'dataops_snapshot_get', token: 'wrong' }).status, 'success', 'snapshot read must ignore an optional legacy token');
assert.equal(post({ action: 'dataops_snapshot_get' }).status, 'success', 'snapshot read must work without any DataOps token property');
const badSchemaSnapshot = makeSnapshot(canonicalRows);
badSchemaSnapshot.schemaVersion = 'WRONG_SCHEMA';
assert.equal(post({ action: 'dataops_snapshot_commit', snapshot: badSchemaSnapshot }).status, 'error', 'schema mismatch must be rejected');
const badHashSnapshot = makeSnapshot(canonicalRows);
badHashSnapshot.hash = '0'.repeat(64);
assert.equal(post({ action: 'dataops_snapshot_commit', snapshot: badHashSnapshot }).status, 'error', 'hash mismatch must be rejected');
const badCountSnapshot = makeSnapshot(canonicalRows);
badCountSnapshot.cellCount--;
assert.equal(post({ action: 'dataops_snapshot_commit', snapshot: badCountSnapshot }).status, 'error', 'cell count mismatch must be rejected');
const firstCommit = post({ action: 'dataops_snapshot_commit', snapshot: makeSnapshot(canonicalRows) });
assert.equal(firstCommit.status, 'success');
assert.match(firstCommit.data.revision, /^DATAOPS-20260804-[0-9a-f]{16}$/);
const firstRead = post({ action: 'dataops_snapshot_get' });
assert.deepEqual(firstRead.data.rows, canonicalRows, 'server read must preserve raw rows and ordering');
assert.equal(firstRead.data.revision, firstCommit.data.revision, 'tokenless get must return the committed revision');
assert.equal(firstRead.data.hash, firstCommit.data.hash, 'tokenless get must return the committed hash');
assert.equal(firstRead.data.rowCount, firstCommit.data.rowCount, 'tokenless get must return the committed row count');
assert.equal(firstRead.data.cellCount, firstCommit.data.cellCount, 'tokenless get must return the committed cell count');
assert.equal(firstRead.data.rows[1][10], 0, 'server must preserve explicit numeric promo zero');
assert.equal(firstRead.data.rows[2][10], '', 'server must preserve blank promo independently from equivalent zero semantics');
assert.equal(post({ action: 'initSync' }).status, 'success', 'legacy initSync action must remain available');
assert.equal(post({ action: 'chunk_master', data: [{ 코드: 'M1', 품목명: '기존상품' }] }).status, 'success', 'legacy master action must remain available');
assert.equal(post({ action: 'chunk_history', data: [{ id: 'H1', action: 'legacy' }] }).status, 'success', 'legacy history action must remain available');
const legacyConfig = {
  schemaVersion: 'LEGACY_CONFIG',
  dict: { preserved: true },
  rules: [{ id: 'R1' }],
  appConfig: { cloudUrl: 'https://example.invalid' }
};
assert.equal(post({ action: 'config', data: legacyConfig }).status, 'success', 'legacy config action must remain available');
const legacyMaster = get('master_only');
assert.equal(legacyMaster.data.master.M1.품목명, '기존상품', 'legacy master data must remain readable');
const legacyConfigRead = get('config_only');
assert.deepEqual(legacyConfigRead.data.dict, { preserved: true }, 'legacy config data must remain readable');
const legacyFull = get('full');
assert.equal(legacyFull.data.history[0].id, 'H1', 'legacy history data must remain readable');
assert.equal(legacyFull.data.appConfig.cloudUrl, 'https://example.invalid', 'legacy full response contract must remain readable');
const readAfterLegacySync = post({ action: 'dataops_snapshot_get', token: 'legacy-ignored' });
assert.equal(readAfterLegacySync.data.revision, firstCommit.data.revision, 'legacy initSync must not clear DataOps snapshot slots');
const sameCommit = post({ action: 'dataops_snapshot_commit', token: 'legacy-ignored', snapshot: makeSnapshot(canonicalRows) });
assert.equal(sameCommit.data.revision, firstCommit.data.revision, 'same finalized snapshot must retain immutable revision');

const currentSlot = properties.get('ONEAPP_DATAOPS_CURRENT_SLOT');
const inactiveName = currentSlot === 'A' ? 'DataOpsSnapshot_B' : 'DataOpsSnapshot_A';
const inactiveSheet = spreadsheet.getSheetByName(inactiveName) || spreadsheet.insertSheet(inactiveName);
inactiveSheet.failNextWrite = true;
const failedCommit = post({ action: 'dataops_snapshot_commit', snapshot: makeSnapshot([[...canonicalRows[0].slice(0, 10), 2600]], '2026-08-05') });
assert.equal(failedCommit.status, 'error');
const readAfterFailure = post({ action: 'dataops_snapshot_get' });
assert.equal(readAfterFailure.data.revision, firstCommit.data.revision, 'staging failure must keep previous current snapshot');

const lotMismatchRows = [
  ['BOX', '100', '상품A', '10kg', 1, '', '', 10000, '', '', 2500],
  ['BOX', '100', '상품A', '10kg', 2, '', '', 10000, '', '', 2600]
];
assert.equal(post({ action: 'dataops_snapshot_commit', token: 'legacy-ignored', snapshot: makeSnapshot(lotMismatchRows) }).status, 'error', 'LOT promo mismatch must be rejected even when a legacy token field is present');

assert.match(merchSource, /fetchLatest\(config\.cloudUrl\)[\s\S]*handleFileUpload\([^]*'inventory',[\s\S]*dataOpsSnapshot/);
assert.match(merchSource, /const imported = await handleFileUpload\([^]*'inventory',[\s\S]*dataOpsSnapshot/, 'authenticated cloud inventory must use the existing inventory adapter');
assert.match(merchSource, /dataOpsPromoConflictMessage[\s\S]*"행사가 확인"/, 'conflict chip must remain independent from the primary issue label');
assert.doesNotMatch(merchSource, /dataops_snapshot_get[^\n]*\?/, 'snapshot token/action must not be sent through a query string');
assert.match(merchSource, /DATAOPS_V1_SECURITY_CLIENT[\s\S]*readClient\.getSnapshot/, 'MerchOps must use the authenticated V1 READ client');
assert.doesNotMatch(merchSnapshotModuleSource, /localStorage|sessionStorage/, 'the V1 READ credential must remain memory-only');
assert.match(dataOpsSource, /DATAOPS_V1_SECURITY_CLIENT[\s\S]*commitSnapshot/, 'DataOps save must use the authenticated V1 WRITE client when released');
const f9Source = extract(dataOpsSource, 'const handleCombinedExport = useCallback', 'const handlePrintOutput');
assert.match(f9Source, /a\.click\(\);/, 'F9 must keep the workbook download product path');
assert.doesNotMatch(f9Source, /dataops_snapshot_commit|commitSnapshot|window\.prompt/, 'F9 export must not silently publish or request credentials');

console.log('DataOps promo cloud contract tests passed');
