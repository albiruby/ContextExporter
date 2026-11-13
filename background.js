// Service worker: file downloads, cross-origin image fetching (host
// permissions bypass CORS here, unlike content scripts), and handing the
// preview document to preview.html.

(function () {
  'use strict';

  const pending = new Map();

  let wantedName = null;
  let wantedTimer = null;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      // Health check: the content script refuses to run blind if this worker
      // failed to start.
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return;
    }
    if (msg.type === 'download') {
      download(msg).then(
        (r) => sendResponse(r),
        (e) => sendResponse({ ok: false, error: String(e) })
      );
      return true;
    }
    if (msg.type === 'fetchImage') {
      fetchImage(msg).then(
        (r) => sendResponse(r),
        (e) => sendResponse({ ok: false, error: String(e) })
      );
      return true;
    }
    if (msg.type === 'fetchChatgptFile') {
      fetchChatgptFile(msg).then(
        (r) => sendResponse(r),
        (e) => sendResponse({ ok: false, error: String(e) })
      );
      return true;
    }
    if (msg.type === 'preview') {
      openPreview(msg).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e) })
      );
      return true;
    }
    if (msg.type === 'getExport') {
      getExport(msg.id).then((html) => sendResponse({ html: html || null }));
      return true;
    }
  });

  // Some other extension in the browser may register onDeterminingFilename;
  // its mere presence makes Chrome ignore our `filename` option, and data:
  // URLs then fall back to "download" + the mime extension. Suggesting the
  // name ourselves for our own downloads restores it; other downloads get no
  // suggestion from us, so nothing else changes. A registration failure must
  // never take the worker down: the handlers above are already installed.
  try {
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
      if (item.byExtensionId !== chrome.runtime.id || !wantedName) return;
      const name = wantedName;
      wantedName = null;
      clearTimeout(wantedTimer);
      suggest({ filename: name, conflictAction: 'uniquify' });
    });
  } catch (e) {
    void e;
  }

  // The downloads API accepts data: URLs, and service workers cannot create
  // blob URLs, so the document is percent-encoded into one data URL.
  async function download({ filename, mime, data }) {
    const url = `data:${mime};charset=utf-8,${encodeURIComponent(data)}`;
    wantedName = filename || null;
    clearTimeout(wantedTimer);
    wantedTimer = setTimeout(() => { wantedName = null; }, 30000);
    try {
      await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    } catch (e) {
      // Retry with the bare basename if Chrome rejected the full name.
      const base = String(filename || '').split(/[\\/]/).pop();
      if (!base || base === filename) throw e;
      wantedName = base;
      await chrome.downloads.download({ url, filename: base, saveAs: false, conflictAction: 'uniquify' });
    }
    return { ok: true };
  }

  function fetchWithTimeout(url, opts = {}, ms = 20000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(timer));
  }

  // Some CDNs answer with a generic content type; the bytes still tell.
  function sniffImage(buf) {
    const b = new Uint8Array(buf.slice(0, 12));
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
    return '';
  }

  async function fetchImage({ url }) {
    const res = await fetchWithTimeout(url, { credentials: 'include' });
    if (!res.ok) return { ok: false };
    let type = (res.headers.get('content-type') || '').split(';')[0];
    if (!type.startsWith('image/')) {
      const buf = await res.arrayBuffer();
      const sniffed = sniffImage(buf);
      if (!sniffed) return { ok: false };
      return { ok: true, dataUrl: `data:${sniffed};base64,${toBase64(buf)}` };
    }
    const buf = await res.arrayBuffer();
    return { ok: true, dataUrl: `data:${type};base64,${toBase64(buf)}` };
  }

  // Asset pointers ("file-..."/"file_...") resolve through three shapes seen
  // in the 2026 client: a direct byte endpoint, the estuary content route, and
  // the legacy JSON endpoint with a signed URL. Keep the first image response.
  async function fetchChatgptFile({ fileId }) {
    const id = String(fileId || '').trim();
    if (!id) return { ok: false };
    const urls = [
      `https://chatgpt.com/backend-api/files/download/${id}?download_intent=false&inline=true`,
      `https://chatgpt.com/backend-api/estuary/content?id=${encodeURIComponent(id)}`,
      `https://chatgpt.com/backend-api/files/${id}/download`,
    ];
    for (const url of urls) {
      try {
        const res = await fetchWithTimeout(url, { credentials: 'include' });
        if (!res.ok) continue;
        let type = (res.headers.get('content-type') || '').split(';')[0];
        if (type.startsWith('image/')) {
          const buf = await res.arrayBuffer();
          return { ok: true, dataUrl: `data:${type};base64,${toBase64(buf)}` };
        }
        if (type === 'application/octet-stream' || !type) {
          const buf = await res.arrayBuffer();
          const sniffed = sniffImage(buf);
          if (sniffed) return { ok: true, dataUrl: `data:${sniffed};base64,${toBase64(buf)}` };
          continue;
        }
        if (type === 'application/json') {
          const info = await res.json();
          const signed = info && (info.download_url || info.url);
          if (signed) {
            const got = await fetchImage({ url: signed });
            if (got.ok) return got;
          }
        }
      } catch (e) {
        // try the next shape
      }
    }
    return { ok: false };
  }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  // The HTML is held in memory and mirrored to storage.session, so the
  // preview tab still finds it even if the worker restarts first.
  async function openPreview({ html }) {
    const id = Math.random().toString(36).slice(2, 10);
    pending.set(id, html);
    try {
      await chrome.storage.session.set({ ['exp_' + id]: html });
    } catch (e) {
      // Over quota for huge chats: the in-memory copy is the fallback.
      void e;
    }
    await chrome.tabs.create({ url: chrome.runtime.getURL('preview/preview.html?id=' + id) });
    setTimeout(() => pending.delete(id), 5 * 60 * 1000);
  }

  async function getExport(id) {
    let html = pending.get(id);
    if (!html) {
      const o = await chrome.storage.session.get('exp_' + id);
      html = o && o['exp_' + id];
    }
    return html || null;
  }
})();
