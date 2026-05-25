// Google Apps Script: バーコード受信 → スプレッドシート追記
// デプロイ方法: 拡張機能 > Apps Script > デプロイ > 新しいデプロイ
//              種類: ウェブアプリ / アクセス権: 全員

function doPost(e) {
  try {
    const payload  = JSON.parse(e.postData.contents);
    const barcode  = payload.barcode  || '';
    const sheetUrl = payload.sheetUrl || '';

    if (!barcode) {
      return buildResponse({ status: 'error', message: 'バーコードが空です' });
    }

    const ss    = sheetUrl ? SpreadsheetApp.openByUrl(sheetUrl) : SpreadsheetApp.getActiveSpreadsheet();
    const sheet = getLatestSheet(ss);

    if (!sheet) {
      return buildResponse({ status: 'error', message: '管理表シートが見つかりません' });
    }

    const formatted = formatBarcode(barcode);

    // H列(8列目)の最終非空行の次の行に書き込む
    const lastRow = sheet.getLastRow();
    let targetRow = 1;
    if (lastRow > 0) {
      const colH = sheet.getRange(1, 8, lastRow, 1).getValues();
      for (let i = colH.length - 1; i >= 0; i--) {
        if (colH[i][0] !== '') {
          targetRow = i + 2;
          break;
        }
      }
    }

    sheet.getRange(targetRow, 8).setValue(formatted);

    return buildResponse({ status: 'ok', barcode: formatted });

  } catch (err) {
    return buildResponse({ status: 'error', message: err.message });
  }
}

// "管理表　YYYYMM" パターンで最新のシートを返す
function getLatestSheet(ss) {
  const pattern = /^管理表[\s　]+(\d{6})/;
  let latest  = null;
  let latestYM = '';

  for (const sheet of ss.getSheets()) {
    const match = sheet.getName().match(pattern);
    if (match && match[1] > latestYM) {
      latestYM = match[1];
      latest   = sheet;
    }
  }

  return latest;
}

// 桁数に応じてハイフンを挿入
function formatBarcode(barcode) {
  const digits = barcode.replace(/\D/g, '');
  if (digits.length === 12) {
    // レターパックライト/プラス: XXXX-XXXX-XXXX
    return `${digits.slice(0,4)}-${digits.slice(4,8)}-${digits.slice(8,12)}`;
  }
  if (digits.length === 11) {
    // 書留: XXX-XX-XXXXX-X
    return `${digits.slice(0,3)}-${digits.slice(3,5)}-${digits.slice(5,10)}-${digits.slice(10,11)}`;
  }
  // 不明な形式はそのまま返す
  return barcode;
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
