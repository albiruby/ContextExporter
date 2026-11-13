// Orchestrator: picks the site adapter, drives one export end to end, and
// answers messages from the toolbar popup.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});
  const state = { adapter: null, busy: false };

  function pickAdapter() {
    return Object.values(CE.adapters || {}).find((a) => a.match && a.match()) || null;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  // ChatGPT file pointers ("file-service://file-...") resolve through the
  // backend download endpoint; everything else is fetched directly.
  async function fetchAsDataUrl(url) {
    try {
      if (url.startsWith('file-service://')) {
        const res = await CE.utils.send({ type: 'fetchChatgptFile', fileId: url.slice('file-service://'.length) });
        if (res && res.ok && res.dataUrl) return res.dataUrl;
        return null;
      }
      if (url.startsWith('blob:')) {
        const res = await fetch(url);
        if (res.ok) return await blobToDataUrl(await res.blob());
      } else {
        const res = await CE.utils.send({ type: 'fetchImage', url });
        if (res && res.ok && res.dataUrl) return res.dataUrl;
        const r2 = await fetch(url, { credentials: 'include' });
        if (r2.ok) return await blobToDataUrl(await r2.blob());
      }
    } catch (e) { /* fall through: keep the original URL */ }
    return null;
  }

  // Link thumbnails arrive as full-size OG images; re-encoding them at
  // reading size keeps the data URL (and the download) an order of magnitude
  // smaller. Any failure keeps the original bytes.
  function shrinkDataUrl(dataUrl, maxW) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          if (img.naturalWidth <= maxW) { resolve(dataUrl); return; }
          const c = document.createElement('canvas');
          c.width = maxW;
          c.height = Math.max(1, Math.round(img.naturalHeight * (maxW / img.naturalWidth)));
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.82));
        } catch (e) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // Returns how many images stayed as external links; favicon icons are
  // left alone on purpose, they are 32px decoration.
  async function embedImages(doc) {
    const targets = [];
    doc.turns.forEach((t) => t.blocks.forEach((b) => {
      if (b.type === 'image' && /^(blob:|https?:)/i.test(b.src)) targets.push({ block: b, url: b.src });
      if (b.type === 'html' || b.type === 'table') {
        const re = /<img[^>]*\ssrc="(blob:[^"]+|https?:\/\/[^"]+)"/g;
        let m;
        while ((m = re.exec(b.html))) targets.push({ block: b, url: m[1] });
      }
    }));

    const uniq = [...new Set(targets.map((t) => t.url))];
    const results = await Promise.all(uniq.map(async (u) => {
      const raw = await fetchAsDataUrl(u);
      return [u, raw ? await shrinkDataUrl(raw, 900) : null];
    }));
    const map = new Map(results);

    targets.forEach(({ block, url }) => {
      const data = map.get(url);
      if (!data) return;
      if (block.src === url) block.src = data;
      else block.html = block.html.split(url).join(data);
    });

    // Anything still pointing at a page-only or app-only scheme would render
    // as a broken image in Word and the PDF; leave a readable marker instead.
    doc.turns.forEach((t) => {
      t.blocks = t.blocks.map((b) => {
        if (b.type !== 'image' || /^(data:|https?:)/i.test(b.src)) return b;
        const label = b.alt ? ': ' + CE.utils.htmlEscape(b.alt) : '';
        return { type: 'html', html: `<p><em>[image${label} could not be downloaded]</em></p>` };
      });
    });

    return uniq.filter((u) => !map.get(u) && !/favicon|s2\/favicons/i.test(u)).length;
  }

  // The buttons send file extensions; exporters register under their own
  // names. pdf matches by luck, the rest need mapping.
  const FORMAT_ALIASES = { md: 'markdown', doc: 'word' };
  const FORMAT_LABEL = { doc: 'Word', pdf: 'PDF', md: 'Markdown' };

  // Toast lines stay short; the full API note lives in the diagnostics dump.
  function shortNote(n) {
    if (!n || n === 'via api') return 'via api';
    if (n === 'via dom scrape') return 'via page scrape';
    const m = n.match(/http (\d{3})/);
    if (m) return 'done (scroll fallback, api http ' + m[1] + ')';
    return 'done (scroll fallback)';
  }

  async function runExport(adapter, format) {
    // Without a living service worker nothing downloads and no preview
    // opens, so fail loudly before doing any work.
    const bg = await CE.utils.send({ type: 'ping' });
    if (!bg || !bg.ok) {
      throw new Error('background service worker not responding; reload the extension and open its Errors');
    }
    CE.ui.overlay('⏳ Exporting: collecting conversation…');
    try {
      const doc = await adapter.gather((n) => CE.ui.overlay(`⏳ Exporting: ${n} items collected…`));
      if (!doc.turns.length) throw new Error('no messages found on this page');

      CE.ui.overlay('⏳ Exporting: embedding images…');
      const kept = await embedImages(doc);
      if (kept) doc.keptImages = kept;

      const key = FORMAT_ALIASES[format] || format;
      const exp = CE.exporters[key];
      if (!exp) throw new Error('unknown format: ' + format);
      const out = exp.build(doc);

      if (key === 'pdf') {
        CE.ui.overlay(null);
        const res = await CE.utils.send({ type: 'preview', html: out, title: doc.title });
        if (!res || !res.ok) throw new Error('preview failed: ' + ((res && res.error) || 'no response'));
      } else {
        CE.ui.overlay(null);
        const filename = `${doc.label} - ${CE.utils.safeFilename(doc.title)} - ${doc.exportedAt}.${exp.ext}`;
        const res = await CE.utils.send({ type: 'download', filename, mime: exp.mime, data: out });
        if (!res || !res.ok) throw new Error('download failed: ' + ((res && res.error) || 'no response'));
      }
      return doc;
    } finally {
      CE.ui.overlay(null);
    }
  }

  CE.app = {
    async export(adapter, format) {
      if (!adapter) return;
      if (state.busy) {
        CE.ui.toast('Another export is already running');
        return;
      }
      state.busy = true;
      const label = FORMAT_LABEL[format] || 'Export';
      try {
        const doc = await runExport(adapter, format);
        let line = '✅ ' + label + ': ' + shortNote(doc && doc.note);
        if (doc && doc.keptImages) line += `, ${doc.keptImages} img kept as link`;
        CE.ui.toast(line);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        CE.ui.toast('❌ ' + label + ' failed: ' + msg.slice(0, 160));
      } finally {
        CE.ui.setBusy('⬇️ Export chat', false);
        state.busy = false;
      }
    },
  };

  // Page-wide scan: the redesign hides conversation markers somewhere in the
  // tree, so we report every data-* attribute whose name mentions messages,
  // turns, roles or conversations, the most frequent class tokens in the
  // text-heaviest scrollable area, and that area's DOM skeleton.
  function diagnose() {
    const interesting = /message|turn|role|author|conv|chat|thread|response|query|gizmo/i;
    let attrInfo = {};
    const truncate = (v) => String(v).slice(0, 40);

    document.querySelectorAll('*').forEach((el) => {
      for (const a of el.attributes) {
        if (!/^data-/i.test(a.name) || !interesting.test(a.name)) continue;
        const info = attrInfo[a.name] || (attrInfo[a.name] = { count: 0, samples: [] });
        info.count++;
        if (a.value && info.samples.length < 3 && !info.samples.includes(truncate(a.value))) {
          info.samples.push(truncate(a.value));
        }
      }
    });
    if (Object.keys(attrInfo).length > 30) {
      const keys = Object.keys(attrInfo).slice(0, 30);
      const trimmed = {};
      keys.forEach((k) => (trimmed[k] = attrInfo[k]));
      attrInfo = trimmed;
    }

    const isScroller = (e) => {
      try {
        return e.scrollHeight - e.clientHeight > 300
          && /(auto|scroll)/.test(getComputedStyle(e).overflowY);
      } catch (err) {
        return false;
      }
    };
    const scrollers = [...document.querySelectorAll('div, main, section')]
      .filter(isScroller)
      .map((e) => ({
        tag: e.tagName,
        cls: typeof e.className === 'string' ? e.className.trim().split(/\s+/).slice(0, 3).join('.') : '',
        textLen: (e.textContent || '').length,
        children: e.children.length,
      }))
      .sort((a, b) => b.textLen - a.textLen)
      .slice(0, 4);

    const conv = [...document.querySelectorAll('div, main, section')]
      .filter(isScroller)
      .sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0];

    let clsTop = null;
    let tagCounts = null;
    let skeleton = 'none';
    if (conv) {
      const cls = {};
      const tags = {};
      conv.querySelectorAll('*').forEach((e) => {
        const t = e.tagName;
        tags[t] = (tags[t] || 0) + 1;
        if (typeof e.className === 'string') {
          e.className.trim().split(/\s+/).forEach((c) => {
            if (c) cls[c] = (cls[c] || 0) + 1;
          });
        }
      });
      clsTop = Object.entries(cls).sort((a, b) => b[1] - a[1]).slice(0, 24);
      tagCounts = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 12);

      const walk = (el, d) => {
        let out = '';
        if (d > 6) return out;
        [...el.children].forEach((c) => {
          if (out.length > 5000) return;
          if (/^(svg|path|defs|style|script)$/i.test(c.tagName)) return;
          const ccls = typeof c.className === 'string' && c.className
            ? '.' + c.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          const attrs = [...c.attributes].slice(0, 6)
            .map((a) => a.name + '=' + String(a.value).slice(0, 20)).join(' ');
          const text = c.children.length === 0
            ? ' «' + (c.textContent || '').trim().slice(0, 30) + '»' : '';
          out += '  '.repeat(d) + c.tagName + ccls + (attrs ? ' [' + attrs + ']' : '') + text + '\n' + walk(c, d + 1);
        });
        return out;
      };
      skeleton = walk(conv, 0);
    }

    // What the page itself requested from the backend: this reveals the real
    // conversation endpoint when ours 404s, plus the raw extraction result per
    // harvested marker so label-only failures are visible in the dump.
    const net = performance.getEntriesByType('resource')
      .filter((e) => /backend-api|conversation/i.test(e.name))
      .slice(-30)
      .map((e) => (e.responseStatus || '?') + ' ' + e.name);

    const preview = [];
    document.querySelectorAll(
      '[data-conversation-role], [data-turn-key], [data-testid="user-message"], '
      + '[data-testid="assistant-message"], .font-claude-message, user-query, model-response'
    ).forEach((el, i) => {
      if (i >= 4) return;
      const kids = [...el.children].slice(0, 6).map((c) => {
        const cls = typeof c.className === 'string' && c.className
          ? '.' + c.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return c.tagName + cls + ' «' + (c.textContent || '').trim().slice(0, 40) + '»';
      });
      let blocks = [];
      try { blocks = CE.extract.extractBlocks(el); } catch (err) { blocks = []; }
      preview.push({
        tag: el.tagName,
        role: el.getAttribute('data-conversation-role') || el.getAttribute('data-testid') || '',
        key: String(el.getAttribute('data-chatgpt-search-unit-key')
          || el.getAttribute('data-turn-key') || '').slice(0, 40),
        children: kids,
        blockCount: blocks.length,
        blocks: blocks.slice(0, 4).map((b) => b.type + ':'
          + String(b.text || b.html || b.src || '').replace(/\s+/g, ' ').slice(0, 60)),
      });
    });

    return JSON.stringify(
      { url: location.href, net, preview, attrInfo, scrollers, clsTop, tagCounts, skeleton },
      null, 1
    );
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      sendResponse({ ok: true, ready: !!(state.adapter && state.adapter.ready()) });
    } else if (msg.type === 'export') {
      sendResponse({ started: true });
      CE.app.export(state.adapter, msg.format);
    } else if (msg.type === 'diagnose') {
      sendResponse({ data: diagnose() });
    }
  });

  function boot() {
    const adapter = pickAdapter();
    if (!adapter) return;
    state.adapter = adapter;
    if (adapter.ready()) CE.ui.mountUI(adapter);
    setInterval(() => {
      if (!document.getElementById('context-exporter-root')) {
        if (adapter.ready()) CE.ui.mountUI(adapter);
      } else {
        CE.ui.syncVisibility(adapter);
      }
    }, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
