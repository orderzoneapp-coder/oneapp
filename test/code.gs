/**
 * ONEAPP MerchOps - Cloud Sync Server (Chunked Transfer Supported)
 * [v1.6] 대용량 데이터 분할 전송 및 품절 대기열(Pending) 동기화 모듈
 */

const SHEET_NAMES = {
  MASTER: 'MasterDB',
  HISTORY: 'HistoryLogs',
  CONFIG: 'AppConfig'
};

function getOrCreateSheet(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  return sheet;
}

// [POST] 클라이언트로부터 데이터 수신 (업로드 백업)
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (action === 'initSync') {
      const masterSheet = getOrCreateSheet(ss, SHEET_NAMES.MASTER);
      const historySheet = getOrCreateSheet(ss, SHEET_NAMES.HISTORY);
      masterSheet.clear();
      historySheet.clear();
      return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'chunk_master') {
      const sheet = getOrCreateSheet(ss, SHEET_NAMES.MASTER);
      const data = payload.data || [];
      if (data.length > 0) {
        const rows = data.map(item => [item.코드, JSON.stringify(item)]);
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
      }
      return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'chunk_history') {
      const sheet = getOrCreateSheet(ss, SHEET_NAMES.HISTORY);
      const data = payload.data || [];
      if (data.length > 0) {
        const rows = data.map(log => [JSON.stringify(log)]);
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 1).setValues(rows);
      }
      return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
    }

    // 🚨 품절 대기열(pendingShopStatus)을 포함한 앱 설정 통째로 저장
    if (action === 'config') {
      const sheet = getOrCreateSheet(ss, SHEET_NAMES.CONFIG);
      sheet.clear();
      sheet.getRange("A1:B1").setValues([['AppConfig', JSON.stringify(payload.data)]]);
      return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
    }

    throw new Error("알 수 없는 Action입니다.");

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: error.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

// [GET] 클라이언트로 데이터 전송 (다운로드 복구)
function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const result = { status: 'success', data: { master: {}, history: [], dict: {}, rules: [], appConfig: {}, pendingShopStatus: [] } };

    const masterSheet = ss.getSheetByName(SHEET_NAMES.MASTER);
    if (masterSheet && masterSheet.getLastRow() > 0) {
      const mData = masterSheet.getRange(1, 1, masterSheet.getLastRow(), 2).getValues();
      mData.forEach(row => {
        if (row[0] && row[1]) {
          try { result.data.master[row[0]] = JSON.parse(row[1]); } catch(e){}
        }
      });
    }

    const historySheet = ss.getSheetByName(SHEET_NAMES.HISTORY);
    if (historySheet && historySheet.getLastRow() > 0) {
      const hData = historySheet.getRange(1, 1, historySheet.getLastRow(), 1).getValues();
      hData.forEach(row => {
        if (row[0]) {
          try { result.data.history.push(JSON.parse(row[0])); } catch(e){}
        }
      });
    }

    const configSheet = ss.getSheetByName(SHEET_NAMES.CONFIG);
    if (configSheet && configSheet.getLastRow() > 0) {
      const configStr = configSheet.getRange("B1").getValue();
      if (configStr) {
        const confData = JSON.parse(configStr);
        result.data.dict = confData.dict || {};
        result.data.rules = confData.rules || [];
        result.data.appConfig = confData.appConfig || {};
        // 🚨 클라우드에 백업된 품절 대기열 창고 추출
        result.data.pendingShopStatus = confData.pendingShopStatus || []; 
      }
    }

    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: error.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}
