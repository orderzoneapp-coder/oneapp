/**
 * ONEAPP MerchOps - Cloud Sync Server
 * [v1.8_DataOpsAtomicSnapshot]
 *
 * - MasterDB/HistoryLogs 분할 전송 유지
 * - AppConfig JSON을 45,000자 이하로 분할 저장해 Google Sheets 셀 제한 회피
 * - config_only / master_only 선택 복원 지원
 * - 기존 AppConfig B1 단일 셀 형식도 자동 호환
 * - DataOps FULL 재고는 A/B staging 검증 후 current pointer를 원자 전환
 */

const SHEET_NAMES = {
  MASTER: 'MasterDB',
  HISTORY: 'HistoryLogs',
  CONFIG: 'AppConfig',
  DATAOPS_A: 'DataOpsSnapshot_A',
  DATAOPS_B: 'DataOpsSnapshot_B'
};

const CONFIG_FORMAT = 'ONEAPP_CONFIG_V2';
const CONFIG_CHUNK_SIZE = 45000;
const DATAOPS_SNAPSHOT_FORMAT = 'ONEAPP_DATAOPS_SNAPSHOT_V1';
const DATAOPS_SNAPSHOT_COLUMNS = ['단위', '품목코드', '품명', '규격', '재고', '기록', '거래', '구매가', '기본', '적요', '행사가'];
const DATAOPS_SNAPSHOT_CHUNK_SIZE = 45000;
const DATAOPS_SNAPSHOT_MAX_ROWS = 100000;
const DATAOPS_CURRENT_SLOT_PROPERTY = 'ONEAPP_DATAOPS_CURRENT_SLOT';
const DATAOPS_ACCESS_TOKEN_PROPERTY = 'ONEAPP_DATAOPS_ACCESS_TOKEN';

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

function readMasterData(ss) {
  const master = {};
  const sheet = ss.getSheetByName(SHEET_NAMES.MASTER);
  if (!sheet || sheet.getLastRow() < 1) return master;
  const rows = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  rows.forEach(row => {
    if (!row[0] || !row[1]) return;
    try { master[String(row[0])] = JSON.parse(String(row[1])); } catch (e) {}
  });
  return master;
}

function readHistoryData(ss) {
  const history = [];
  const sheet = ss.getSheetByName(SHEET_NAMES.HISTORY);
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

function requireDataOpsAccess(payload) {
  const configuredToken = String(PropertiesService.getScriptProperties().getProperty(DATAOPS_ACCESS_TOKEN_PROPERTY) || '');
  if (!configuredToken) throw new Error('DATAOPS_ACCESS_NOT_CONFIGURED');
  const suppliedToken = String((payload && payload.token) || '');
  if (!suppliedToken || !constantTimeTextEquals(configuredToken, suppliedToken)) {
    throw new Error('DATAOPS_ACCESS_DENIED');
  }
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
  if (!snapshot.savedAt || Number.isNaN(new Date(snapshot.savedAt).getTime())) throw new Error('DATAOPS_SAVED_AT_INVALID');
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
    savedAt: snapshot.savedAt,
    hashAlgorithm: 'SHA-256',
    hash: actualHash,
    rowCount,
    cellCount,
    canonicalJson,
    canonical
  };
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
  const validated = validateDataOpsSnapshotEnvelope(snapshot);
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

// [POST] 클라이언트 데이터 수신
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('POST 데이터가 없습니다.');
    const payload = JSON.parse(e.postData.contents);
    const action = String(payload.action || '');
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (action === 'dataops_snapshot_commit') {
      requireDataOpsAccess(payload);
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
            cellCount: saved.cellCount
          }
        });
      });
    }

    if (action === 'dataops_snapshot_get') {
      requireDataOpsAccess(payload);
      return withScriptLock(() => {
        const snapshot = readCurrentDataOpsSnapshot(ss);
        return jsonResponse({ status: 'success', action, data: snapshot });
      });
    }

    if (action === 'initSync') {
      return withScriptLock(() => {
        getOrCreateSheet(ss, SHEET_NAMES.MASTER).clearContents();
        getOrCreateSheet(ss, SHEET_NAMES.HISTORY).clearContents();
        return jsonResponse({ status: 'success', action });
      });
    }

    if (action === 'chunk_master') {
      return withScriptLock(() => {
        const sheet = getOrCreateSheet(ss, SHEET_NAMES.MASTER);
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
      return withScriptLock(() => {
        const sheet = getOrCreateSheet(ss, SHEET_NAMES.HISTORY);
        const data = Array.isArray(payload.data) ? payload.data : [];
        if (data.length > 0) {
          const rows = data.map(log => [JSON.stringify(log)]);
          sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 1).setValues(rows);
        }
        return jsonResponse({ status: 'success', action, count: data.length });
      });
    }

    if (action === 'config') {
      return withScriptLock(() => {
        const sheet = getOrCreateSheet(ss, SHEET_NAMES.CONFIG);
        const summary = saveConfigData(sheet, payload.data || {});
        return jsonResponse({ status: 'success', action, summary });
      });
    }

    throw new Error('알 수 없는 Action입니다: ' + action);
  } catch (error) {
    return jsonResponse({ status: 'error', message: String(error && error.message ? error.message : error) });
  }
}

// [GET] 클라이언트 데이터 전송
function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || 'full');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const configSheet = ss.getSheetByName(SHEET_NAMES.CONFIG);
    const configData = normalizeConfigResult(loadConfigData(configSheet));

    if (action === 'config_only') {
      return jsonResponse({ status: 'success', data: configData });
    }

    if (action === 'master_only') {
      const master = readMasterData(ss);
      return jsonResponse({
        status: 'success',
        data: {
          master,
          summary: { masterCount: Object.keys(master).length }
        }
      });
    }

    const master = readMasterData(ss);
    const history = readHistoryData(ss);
    return jsonResponse({
      status: 'success',
      data: {
        master,
        history,
        ...configData
      }
    });
  } catch (error) {
    return jsonResponse({ status: 'error', message: String(error && error.message ? error.message : error) });
  }
}
