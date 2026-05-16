/**
 * ONEAPP MerchOps - Cloud Sync Server (Chunked Transfer Supported)
 * 대용량 데이터 분할 전송 및 자동 시트 생성 모듈
 */

const SHEET_NAMES = {
  MASTER: 'MasterDB',
  HISTORY: 'HistoryLogs',
  CONFIG: 'AppConfig'
};

// 1. 필수 시트 자동 생성 및 초기화
function getOrCreateSheet(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  return sheet;
}

// 2. [POST] 클라이언트로부터 데이터 수신 (업로드)
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // [1단계] 초기화: 업로드 시작 전 기존 시트를 싹 비웁니다.
    if (action === 'initSync') {
      const masterSheet = getOrCreateSheet(ss, SHEET_NAMES.MASTER);
      const historySheet = getOrCreateSheet(ss, SHEET_NAMES.HISTORY);
      masterSheet.clear();
      historySheet.clear();
      return ContentService.createTextOutput(JSON.stringify({ status: 'success', message: 'Sheets initialized' })).setMimeType(ContentService.MimeType.JSON);
    }

    // [2단계] 마스터 데이터 분할 저장 (확장성 극대화를 위해 A열: 코드, B열: JSON 통데이터로 저장)
    if (action === 'chunk_master') {
      const sheet = getOrCreateSheet(ss, SHEET_NAMES.MASTER);
      const data = payload.data || [];
      if (data.length > 0) {
        const rows = data.map(item => [item.코드, JSON.stringify(item)]);
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
      }
      return ContentService.createTextOutput(JSON.stringify({ status: 'success', received: data.length })).setMimeType(ContentService.MimeType.JSON);
    }

    // [3단계] 히스토리 데이터 분할 저장
    if (action === 'chunk_history') {
      const sheet = getOrCreateSheet(ss, SHEET_NAMES.HISTORY);
      const data = payload.data || [];
      if (data.length > 0) {
        const rows = data.map(log => [JSON.stringify(log)]);
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 1).setValues(rows);
      }
      return ContentService.createTextOutput(JSON.stringify({ status: 'success', received: data.length })).setMimeType(ContentService.MimeType.JSON);
    }

    // [4단계] 환경설정, 매핑 룰, 파서 사전 통째로 저장 (용량이 작으므로 한 번에 처리)
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

// 3. [GET] 클라이언트로 데이터 전송 (다운로드)
function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const result = { status: 'success', data: { master: {}, history: [], dict: {}, rules: [], appConfig: {} } };

    // 마스터 데이터 읽기
    const masterSheet = ss.getSheetByName(SHEET_NAMES.MASTER);
    if (masterSheet && masterSheet.getLastRow() > 0) {
      const mData = masterSheet.getRange(1, 1, masterSheet.getLastRow(), 2).getValues();
      mData.forEach(row => {
        if (row[0] && row[1]) {
          try { result.data.master[row[0]] = JSON.parse(row[1]); } catch(e){}
        }
      });
    }

    // 히스토리 읽기
    const historySheet = ss.getSheetByName(SHEET_NAMES.HISTORY);
    if (historySheet && historySheet.getLastRow() > 0) {
      const hData = historySheet.getRange(1, 1, historySheet.getLastRow(), 1).getValues();
      hData.forEach(row => {
        if (row[0]) {
          try { result.data.history.push(JSON.parse(row[0])); } catch(e){}
        }
      });
    }

    // 설정 데이터 읽기 (config, dict, rules 분배)
    const configSheet = ss.getSheetByName(SHEET_NAMES.CONFIG);
    if (configSheet && configSheet.getLastRow() > 0) {
      const configStr = configSheet.getRange("B1").getValue();
      if (configStr) {
        const confData = JSON.parse(configStr);
        result.data.dict = confData.dict || {};
        result.data.rules = confData.rules || [];
        result.data.appConfig = confData.appConfig || {};
      }
    }

    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: error.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}
