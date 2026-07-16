/**
 * ONEAPP MerchOps - Cloud Sync Server
 * [v1.7_CloudConfigChunkFix]
 *
 * - MasterDB/HistoryLogs 분할 전송 유지
 * - AppConfig JSON을 45,000자 이하로 분할 저장해 Google Sheets 셀 제한 회피
 * - config_only / master_only 선택 복원 지원
 * - 기존 AppConfig B1 단일 셀 형식도 자동 호환
 */

const SHEET_NAMES = {
  MASTER: 'MasterDB',
  HISTORY: 'HistoryLogs',
  CONFIG: 'AppConfig'
};

const CONFIG_FORMAT = 'ONEAPP_CONFIG_V2';
const CONFIG_CHUNK_SIZE = 45000;

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

// [POST] 클라이언트 데이터 수신
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('POST 데이터가 없습니다.');
    const payload = JSON.parse(e.postData.contents);
    const action = String(payload.action || '');
    const ss = SpreadsheetApp.getActiveSpreadsheet();

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
