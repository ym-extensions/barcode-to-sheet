(() => {
  'use strict';

  // ---- 定数 ----
  const STORAGE_KEY_URL    = 'gas_url';
  const STORAGE_KEY_SHEET  = 'sheet_url';
  const STORAGE_KEY_QUEUE  = 'offline_queue';
  const COOLDOWN_MS        = 2000;  // 同一バーコードの連続読み取り防止
  const BARCODE_READERS    = [
    'code_128_reader',
    'code_39_reader',
    'ean_reader',
    'ean_8_reader',
    'i2of5_reader',
    '2of5_reader',
    'codabar_reader',
  ];

  // ---- 状態 ----
  let scanner       = null;
  let isScanning    = false;
  let lastCode      = '';
  let lastScanTime  = 0;
  let totalCount    = 0;

  // ---- DOM ----
  const gasUrlInput      = document.getElementById('gas-url');
  const sheetUrlInput    = document.getElementById('sheet-url');
  const saveSettingsBtn  = document.getElementById('save-settings-btn');
  const editSettingsBtn  = document.getElementById('edit-settings-btn');
  const setupSection   = document.getElementById('setup-section');
  const startBtn       = document.getElementById('start-btn');
  const stopBtn        = document.getElementById('stop-btn');
  const statusBadge    = document.getElementById('status-badge');
  const lastScanSection= document.getElementById('last-scan-section');
  const lastBarcodeEl  = document.getElementById('last-barcode');
  const sendStatusEl   = document.getElementById('send-status');
  const historyList    = document.getElementById('history-list');
  const scanCountEl    = document.getElementById('scan-count');
  const emptyHistory   = document.getElementById('empty-history');

  // ---- 初期化 ----
  function init() {
    const savedUrl   = localStorage.getItem(STORAGE_KEY_URL)   || '';
    const savedSheet = localStorage.getItem(STORAGE_KEY_SHEET) || '';
    if (savedUrl) {
      gasUrlInput.value   = savedUrl;
      sheetUrlInput.value = savedSheet;
      setupSection.classList.add('hidden');
    }

    saveSettingsBtn.addEventListener('click', saveSettings);
    editSettingsBtn.addEventListener('click', openSettings);
    startBtn.addEventListener('click', startScanning);
    stopBtn.addEventListener('click', stopScanning);

    // オンライン復帰時にキュー再送
    window.addEventListener('online', flushOfflineQueue);
  }

  function openSettings() {
    gasUrlInput.value   = localStorage.getItem(STORAGE_KEY_URL)   || '';
    sheetUrlInput.value = localStorage.getItem(STORAGE_KEY_SHEET) || '';
    setupSection.classList.remove('hidden');
    gasUrlInput.focus();
  }

  function saveSettings() {
    const url      = gasUrlInput.value.trim();
    const sheetUrl = sheetUrlInput.value.trim();
    if (!url.startsWith('https://script.google.com/macros/s/') && !url.startsWith('https://script.google.com/a/macros/')) {
      alert('GASのWebアプリURLを正しく入力してください。\n（https://script.google.com/ で始まるURLです）');
      return;
    }
    if (sheetUrl && !sheetUrl.startsWith('https://docs.google.com/spreadsheets/d/')) {
      alert('スプレッドシートURLを正しく入力してください。\n（https://docs.google.com/spreadsheets/d/ で始まるURLです）');
      return;
    }
    localStorage.setItem(STORAGE_KEY_URL, url);
    localStorage.setItem(STORAGE_KEY_SHEET, sheetUrl);
    setupSection.classList.add('hidden');
    showToast('設定を保存しました');
    flushOfflineQueue();
  }

  // ---- スキャン開始 / 停止 ----
  function startScanning() {
    const gasUrl = localStorage.getItem(STORAGE_KEY_URL);
    if (!gasUrl) {
      setupSection.classList.remove('hidden');
      gasUrlInput.focus();
      showToast('先にGAS URLを設定してください');
      return;
    }

    try {
      if (typeof Quagga === 'undefined') {
        alert('ライブラリ読み込み失敗。ページを再読み込みしてください。');
        return;
      }
      Quagga.init({
        inputStream: {
          type: 'LiveStream',
          target: document.querySelector('#reader'),
          constraints: {
            facingMode: 'environment',
            width:  { ideal: 1920 },
            height: { ideal: 1080 },
          },
        },
        decoder: {
          readers: BARCODE_READERS,
        },
        locator: {
          // レターパックのような細い一次元コードの線を潰さず解析する。
          halfSample: false,
          patchSize: 'medium',
        },
        locate: true,
        frequency: 10,
      }, (err) => {
        if (err) {
          alert('カメラ起動失敗: ' + err.message);
          return;
        }
        Quagga.start();
        scanner = Quagga;
        isScanning = true;
        startBtn.disabled = true;
        stopBtn.disabled  = false;
        setStatus('active', 'スキャン中');
      });

      Quagga.offDetected();
      Quagga.onDetected((data) => {
        if (data && data.codeResult && data.codeResult.code) {
          onScanSuccess(data.codeResult.code);
        }
      });
    } catch (err) {
      alert('エラー: ' + err.message);
    }
  }

  function stopScanning() {
    if (scanner && isScanning) {
      Quagga.stop();
      Quagga.offDetected();
      scanner    = null;
      isScanning = false;
      startBtn.disabled = false;
      stopBtn.disabled  = true;
      setStatus('idle', '待機中');
    }
  }

  // ---- スキャン成功時 ----
  function onScanSuccess(code) {
    const now = Date.now();
    // 同一コードのクールダウン
    if (code === lastCode && now - lastScanTime < COOLDOWN_MS) return;

    lastCode     = code;
    lastScanTime = now;

    beep();
    showLastScan(code);
    addHistory(code, 'sending');
    sendToGas(code);
  }

  // ---- GASに送信 ----
  async function sendToGas(code) {
    const gasUrl = localStorage.getItem(STORAGE_KEY_URL);
    if (!gasUrl) return;

    const sheetUrl = localStorage.getItem(STORAGE_KEY_SHEET) || '';
    const payload  = { barcode: code, timestamp: new Date().toISOString(), ...(sheetUrl && { sheetUrl }) };

    if (!navigator.onLine) {
      enqueueOffline(payload);
      updateLastStatus('オフライン：後で自動送信します', 'status-wait');
      updateHistoryStatus(code, 'offline');
      return;
    }

    try {
      setStatus('sending', '送信中…');
      await postToGas(gasUrl, payload);

      updateLastStatus('✓ スプレッドシートに記録しました', 'status-ok');
      updateHistoryStatus(code, 'ok');
    } catch (err) {
      console.error('送信失敗:', err);
      enqueueOffline(payload);
      if (err.isApplicationError) {
        updateLastStatus(`記録失敗：${err.message}（設定修正後に再送します）`, 'status-err');
      } else {
        updateLastStatus('送信失敗：後で自動再送します', 'status-err');
      }
      updateHistoryStatus(code, 'err');
    } finally {
      if (isScanning) setStatus('active', 'スキャン中');
    }
  }

  async function postToGas(gasUrl, payload) {
    const res = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const result = await res.json();
    if (result.status !== 'ok') {
      const err = new Error(result.message || 'GASで記録できませんでした');
      err.isApplicationError = true;
      throw err;
    }

    return result;
  }

  // ---- オフラインキュー ----
  function enqueueOffline(payload) {
    const queue = JSON.parse(localStorage.getItem(STORAGE_KEY_QUEUE) || '[]');
    queue.push(payload);
    localStorage.setItem(STORAGE_KEY_QUEUE, JSON.stringify(queue));
  }

  async function flushOfflineQueue() {
    const gasUrl = localStorage.getItem(STORAGE_KEY_URL);
    if (!gasUrl) return;

    const queue = JSON.parse(localStorage.getItem(STORAGE_KEY_QUEUE) || '[]');
    if (queue.length === 0) return;

    const failed = [];
    let rejectedCount = 0;
    let sentCount = 0;
    for (const payload of queue) {
      try {
        await postToGas(gasUrl, payload);
        sentCount++;
      } catch (err) {
        failed.push(payload);
        if (err.isApplicationError) {
          rejectedCount++;
        }
      }
    }

    localStorage.setItem(STORAGE_KEY_QUEUE, JSON.stringify(failed));
    if (sentCount) {
      showToast(`保留中の${sentCount}件を再送しました`);
    }
    if (rejectedCount) {
      showToast(`${rejectedCount}件は設定修正後に再送します`);
    }
  }

  // ---- UI更新 ----
  function setStatus(type, label) {
    statusBadge.className = `badge badge-${type}`;
    statusBadge.textContent = label;
  }

  function showLastScan(code) {
    lastScanSection.classList.remove('hidden');
    lastBarcodeEl.textContent = code;
    sendStatusEl.textContent  = '送信中…';
    sendStatusEl.className    = 'status-wait';
  }

  function updateLastStatus(msg, cls) {
    sendStatusEl.textContent = msg;
    sendStatusEl.className   = cls;
  }

  function addHistory(code, statusType) {
    totalCount++;
    scanCountEl.textContent = `${totalCount}件`;
    emptyHistory.classList.add('hidden');

    const now  = new Date();
    const time = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;

    const li = document.createElement('li');
    li.dataset.code = code;
    li.innerHTML = `
      <span class="icon" data-status="${statusType}">⏳</span>
      <span class="barcode">${escHtml(code)}</span>
      <span class="time">${time}</span>
    `;
    historyList.insertBefore(li, historyList.firstChild);
  }

  function updateHistoryStatus(code, status) {
    // 同じコードが複数ある場合は最新（先頭）を更新
    const items = historyList.querySelectorAll(`li[data-code="${CSS.escape(code)}"]`);
    if (items.length === 0) return;
    const icon = items[0].querySelector('.icon');
    const map  = { ok: '✅', err: '❌', offline: '⚡', sending: '⏳' };
    icon.textContent = map[status] || '⏳';
    icon.dataset.status = status;
  }

  // ---- 効果音（Web Audio API） ----
  function beep() {
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type            = 'sine';
      osc.frequency.value = 1200;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch { /* 音声非対応環境では無視 */ }
  }

  // ---- トースト通知 ----
  function showToast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:#323232; color:#fff; padding:10px 18px; border-radius:8px;
      font-size:0.85rem; z-index:9999; white-space:nowrap;
      animation: fadeIn 0.2s ease;
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  // ---- XSS対策 ----
  function escHtml(str) {
    return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---- 起動 ----
  init();
})();
