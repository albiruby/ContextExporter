// Context Exporter shared layer: utilities, floating UI (shadow DOM), and the
// generic message-block extractor used by every site adapter.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});
  // Shared namespaces; the files loaded after this one attach to them.
  CE.exporters = CE.exporters || {};
  CE.adapters = CE.adapters || {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function htmlEscape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Site pages append their own suffix ("... | ChatGPT", "... - Gemini").
  function cleanTitle(siteLabel) {
    let t = document.title || '';
    t = t.replace(new RegExp('\\s*[|\\u00b7\\-]\\s*' + siteLabel + '\\b.*$', 'i'), '');
    t = t.replace(/\s+/g, ' ').trim();
    return t || siteLabel + ' conversation';
  }

  function safeFilename(s) {
    const name = String(s || 'conversation')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return name || 'conversation';
  }

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // runtime.sendMessage wrapped so a dead extension context or a wedged
  // service worker can never hang an export: the call settles within 60s.
  function send(msg) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      timer = setTimeout(() => finish(null), 60000);
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          finish(res || null);
        });
      } catch (e) {
        finish(null);
      }
    });
  }

  CE.utils = { sleep, htmlEscape, cleanTitle, safeFilename, today, send };

  /* ---------- floating UI, isolated in a shadow root ---------- */

  const HOST_ID = 'context-exporter-root';
  let shadow = null;
  let labelEl = null;
  let btnEl = null;
  let menuEl = null;
  let toastEl = null;
  let toastTimer = null;

  function mountUI(adapter) {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .btn { display:flex; align-items:center; gap:8px; padding:10px 16px; border:0;
               border-radius:10px; background:#2563eb; color:#fff;
               font:600 13px/1 system-ui,sans-serif; cursor:pointer;
               box-shadow:0 4px 14px rgba(0,0,0,.25); }
        .btn:hover { background:#1d4ed8; }
        .btn:focus-visible { outline:2px solid #fff; outline-offset:2px; }
        .btn[disabled] { opacity:.75; cursor:default; }
        .menu { position:absolute; right:0; bottom:44px; min-width:200px; padding:6px;
                border-radius:12px; background:#1e293b; display:none;
                box-shadow:0 8px 24px rgba(0,0,0,.35); }
        .menu.open { display:block; }
        .menu button { display:flex; width:100%; gap:8px; align-items:center; padding:9px 10px;
               border:0; border-radius:8px; background:transparent; color:#e2e8f0;
               font:500 13px system-ui,sans-serif; cursor:pointer; text-align:left; }
        .menu button:hover, .menu button:focus-visible { background:#334155; outline:none; }
        .toast { position:fixed; right:20px; bottom:70px; padding:10px 14px; border-radius:10px;
               background:#111827; color:#f9fafb; font:500 13px system-ui,sans-serif;
               box-shadow:0 6px 18px rgba(0,0,0,.3); opacity:0; transform:translateY(6px);
               transition:opacity .25s, transform .25s; pointer-events:none; }
        .toast.show { opacity:1; transform:none; }
      </style>
      <div class="menu" role="menu">
        <button data-format="doc" role="menuitem">📄 Word (.doc)</button>
        <button data-format="pdf" role="menuitem">🖨️ PDF (print dialog)</button>
        <button data-format="md" role="menuitem">📝 Markdown (.md)</button>
      </div>
      <button class="btn" aria-haspopup="menu"><span class="label">⬇️ Export chat</span></button>
      <div class="toast" aria-live="polite"></div>
    `;
    btnEl = shadow.querySelector('.btn');
    labelEl = shadow.querySelector('.label');
    menuEl = shadow.querySelector('.menu');
    toastEl = shadow.querySelector('.toast');
    btnEl.addEventListener('click', () => menuEl.classList.toggle('open'));
    menuEl.querySelectorAll('button[data-format]').forEach((b) => {
      b.addEventListener('click', () => {
        menuEl.classList.remove('open');
        CE.app.export(adapter, b.dataset.format);
      });
    });
    document.documentElement.appendChild(host);
  }

  function setBusy(label, disabled) {
    if (!labelEl || !btnEl) return;
    labelEl.textContent = label;
    btnEl.disabled = !!disabled;
  }

  function toast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 10000);
  }

  function syncVisibility(adapter) {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    host.style.display = adapter.ready() ? '' : 'none';
  }

  // Full-screen export curtain: the DOM fallback drives the site's own
  // scroller, so content visibly moves; covering the page keeps that pass
  // invisible while the progress text stays readable.
  function overlay(text) {
    let root = document.getElementById('context-exporter-overlay');
    if (!text) {
      if (root) root.remove();
      return;
    }
    if (!root) {
      root = document.createElement('div');
      root.id = 'context-exporter-overlay';
      root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;'
        + 'background:rgba(12,14,16,.94);display:flex;align-items:center;'
        + 'justify-content:center;';
      root.innerHTML = `
        <style>
          @keyframes ce-spin { to { transform: rotate(360deg); } }
          #context-exporter-overlay .ring { width:34px; height:34px;
            border:3px solid rgba(255,255,255,.18); border-top-color:#fff;
            border-radius:50%; animation: ce-spin .8s linear infinite; }
          #context-exporter-overlay .row { display:flex; align-items:center;
            gap:14px; color:#fff; font:500 15px system-ui,sans-serif; }
        </style>
        <div class="row"><div class="ring"></div><span class="text"></span></div>`;
      document.documentElement.appendChild(root);
    }
    root.querySelector('.text').textContent = text;
  }

  CE.ui = { mountUI, setBusy, toast, syncVisibility, overlay };

  /* ---------- generic block extraction ---------- */

  // Math is reduced to <span class="ce-math" data-tex="..."> tokens inside the
  // extracted HTML; each exporter renders those tokens its own way.
  const KEEP_ATTRS = new Set(['href', 'src', 'alt', 'colspan', 'rowspan', 'start', 'type', 'data-tex', 'data-display']);
  const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE', 'PRE', 'BLOCKQUOTE', 'HR']);
  const BLOCK_PROBE = 'p,h1,h2,h3,h4,h5,h6,ul,ol,table,pre,blockquote,hr,.katex,math[alttext]';
  const TABLE_PARTS = new Set(['TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'TD', 'TH']);
  const CHROME_SEL = '.sr-only, [aria-hidden="true"], [data-markdown-copy="exclude"], [hidden], .hidden';

  function mathToken(tex, display) {
    const span = document.createElement('span');
    span.className = 'ce-math';
    span.setAttribute('data-tex', tex || '');
    span.setAttribute('data-display', display ? '1' : '0');
    return span;
  }

  function inlineHTML(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,button,noscript,svg,canvas,video,audio,iframe,form,input,textarea,select,link,meta')
      .forEach((n) => n.remove());
    // Screen-reader labels and site chrome must never become export content.
    clone.querySelectorAll('.sr-only, [aria-hidden="true"], [data-markdown-copy="exclude"], [hidden], .hidden')
      .forEach((n) => n.remove());

    clone.querySelectorAll('.katex').forEach((k) => {
      const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() || '';
      k.replaceWith(mathToken(tex, !!k.closest('.katex-display')));
    });
    // MathJax-style MathML fallback (no KaTeX wrapper)
    clone.querySelectorAll('math[alttext]').forEach((m) => {
      m.replaceWith(mathToken(m.getAttribute('alttext'), m.getAttribute('display') === 'block'));
    });

    // Section headings arrive as utility-classed paragraphs instead of h
    // tags; restore their weight before attributes are stripped.
    clone.querySelectorAll('p,div,li').forEach((n) => {
      if (!(n.classList.contains('font-semibold') || n.classList.contains('font-bold'))) return;
      if (n.querySelector('strong,b') || n.closest('strong,b')) return;
      const s = document.createElement('strong');
      while (n.firstChild) s.appendChild(n.firstChild);
      n.appendChild(s);
    });

    clone.querySelectorAll('img').forEach((img) => {
      ['srcset', 'sizes', 'loading', 'class', 'style', 'decoding'].forEach((a) => img.removeAttribute(a));
    });
    clone.querySelectorAll('*').forEach((n) => {
      [...n.attributes].forEach((a) => {
        if (!KEEP_ATTRS.has(a.name)) n.removeAttribute(a.name);
      });
    });

    // Links and sources that the target app cannot resolve (javascript:,
    // file-service:, relative paths) must not leak into Word or print view.
    clone.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!/^(https?:|mailto:|tel:|#|\/)/i.test(href)) a.removeAttribute('href');
    });
    clone.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!/^(data:|https?:|blob:)/i.test(src)) img.remove();
    });
    return clone.innerHTML;
  }

  function langOf(codeEl) {
    if (!codeEl) return '';
    const fromClass = [...codeEl.classList].find((c) => c.startsWith('language-'));
    return (fromClass && fromClass.slice(9)) || codeEl.getAttribute('data-language') || '';
  }

  function texOf(mathEl) {
    return mathEl.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim()
      || (mathEl.tagName === 'MATH' ? mathEl.getAttribute('alttext') : '')
      || '';
  }

  function extractBlocks(container) {
    const out = [];
    if (!container) return out;
    const seenTables = new Set();

    const significantImg = (img) => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 32 && h < 32) return false;
      if (/avatar|profile|logo|favicon/i.test((img.className || '') + ' ' + (img.alt || ''))) return false;
      return true;
    };

    const classify = (el) => {
      if (!el || el.nodeType !== 1) return;
      // Short buttons are UI actions (copy, regenerate); a long button may
      // wrap the message itself and must still be extracted.
      const btn = el.closest('button');
      if (btn && (btn.textContent || '').trim().length < 60) return;
      if (el.matches(CHROME_SEL)) return;
      const tag = el.tagName;

      // Reaching any table part means the wrapper was bypassed; emit the
      // whole table once so cells never leak out as loose paragraphs.
      if (TABLE_PARTS.has(tag)) {
        const t = el.closest('table');
        if (t && !seenTables.has(t)) {
          seenTables.add(t);
          out.push({ type: 'html', html: inlineHTML(t) });
        }
        return;
      }

      if ((el.classList.contains('katex') && !el.parentElement.closest('.katex, .katex-display')) || tag === 'MATH') {
        out.push({ type: 'math', tex: texOf(el), display: true });
        return;
      }
      if (BLOCK_TAGS.has(tag)) {
        if (tag === 'PRE') {
          const code = el.querySelector('code') || el;
          out.push({ type: 'code', lang: langOf(code), text: (code.textContent || '').replace(/\n$/, '') });
        } else {
          out.push({ type: 'html', html: inlineHTML(el) });
        }
        return;
      }
      if (el.querySelector(BLOCK_PROBE)) {
        classifyChildren(el);
        return;
      }
      const imgs = [...el.querySelectorAll('img')].filter(significantImg);
      if (imgs.length) {
        imgs.forEach((img) => {
          const w = Math.min(img.naturalWidth || img.width || 0, 640);
          out.push({ type: 'image', src: img.currentSrc || img.src, alt: img.alt || '', width: w });
        });
        const rest = el.cloneNode(true);
        rest.querySelectorAll('img').forEach((i) => i.remove());
        if (rest.textContent.trim()) out.push({ type: 'html', html: inlineHTML(rest) });
        return;
      }
      if (el.textContent.trim()) out.push({ type: 'html', html: inlineHTML(el) });
    };

    // The 2026 ChatGPT renderer emits text as runs of inline siblings
    // (plain text, emphasis, links) with no wrapper; taken one by one each
    // would become its own paragraph and shatter the message. Consecutive
    // runs are grouped into a single block instead.
    const isInlineRun = (el) => {
      const t = el.tagName;
      if (BLOCK_TAGS.has(t) || TABLE_PARTS.has(t)) return false;
      if (el.matches(CHROME_SEL)) return false;
      if (el.closest('button')) return false;
      if (el.querySelector('img')) return false;
      if (el.querySelector(BLOCK_PROBE)) return false;
      return true;
    };

    const classifyChildren = (parentEl) => {
      let run = [];
      const flush = () => {
        if (run.length) {
          const wrap = document.createElement('div');
          run.forEach((n) => wrap.appendChild(n.cloneNode(true)));
          if (wrap.textContent.trim()) out.push({ type: 'html', html: inlineHTML(wrap) });
          run = [];
        }
      };
      [...parentEl.children].forEach((el) => {
        if (isInlineRun(el)) {
          run.push(el);
          return;
        }
        flush();
        classify(el);
      });
      flush();
    };

    classifyChildren(container);
    return out;
  }

  CE.extract = { extractBlocks };
})();
