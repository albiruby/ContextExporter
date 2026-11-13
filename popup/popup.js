(function () {
  'use strict';

  document.getElementById('ver').textContent =
    'v' + chrome.runtime.getManifest().version + ' · 100% local';

  const statusEl = document.getElementById('siteStatus');
  const noteEl = document.getElementById('status');
  const buttons = [...document.querySelectorAll('.actions button')];

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab || !tab.id) {
      statusEl.textContent = 'No active tab';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'ping' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        statusEl.textContent = 'Open ChatGPT, Claude or Gemini first';
        return;
      }
      if (res.ready) {
        statusEl.textContent = 'Conversation detected on this page';
        buttons.forEach((b) => (b.disabled = false));
      } else {
        statusEl.textContent = 'No conversation detected. If this page shows a chat, use Copy diagnostics.';
      }
    });
  });

  buttons.forEach((b) => {
    b.addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab || !tab.id) return;
        chrome.tabs.sendMessage(tab.id, { type: 'export', format: b.dataset.format }, (res) => {
          if (chrome.runtime.lastError || !res) {
            noteEl.textContent = 'Could not reach the page. Reload it and try again.';
          } else {
            noteEl.textContent = 'Export started, progress shows on the page.';
            setTimeout(() => window.close(), 900);
          }
        });
      });
    });
  });

  document.getElementById('diagnoseBtn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab || !tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'diagnose' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.data) {
          noteEl.textContent = 'Diagnostics unavailable: reload the page first.';
          return;
        }
        navigator.clipboard.writeText(res.data).then(
          () => { noteEl.textContent = 'Diagnostics copied to clipboard.'; },
          () => { noteEl.textContent = 'Clipboard blocked by the browser.'; }
        );
      });
    });
  });
})();
