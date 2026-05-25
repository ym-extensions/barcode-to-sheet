// Google Apps Script: バーコード受信 → スプレッドシート追記
// デプロイ方法: 拡張機能 > Apps Script > デプロイ > 新しいデプロイ
//              種類: ウェブアプリ / アクセス権: 全員

const SHEET_NAME = 'スキャン記録';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const barcode = payload.barcode || '';

    if (!barcode) {
      return buildResponse({ status: 'error', message: 'バーコードが空です' });
    }

    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    let   sheet = ss.getSheetByName(SHEET_NAME);

    // シートが存在しない場合は自動作成
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.getRange(1, 1).setValue('バーコード番号');
      sheet.getRange(1, 1).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    // 末尾行に追記
    sheet.appendRow([barcode]);

    return buildResponse({ status: 'ok', barcode: barcode });

  } catch (err) {
    return buildResponse({ status: 'error', message: err.message });
  }
}

// GETリクエストで動作確認できるようにしておく
function doGet() {
  return buildResponse({ status: 'ok', message: 'バーコード受信サーバー稼働中' });
}

function buildResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
