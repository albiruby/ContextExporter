// Shared document builder used by both the Word (.doc) exporter and the PDF
// preview. When word:true, math tokens are rendered by the Word approximator;
// otherwise they stay as ce-math tokens for the preview page to hydrate.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});

  // Word maps screen CSS onto .doc HTML, so everything here must be plain
  // block styling: no flex, no grid, no custom properties.
  const CSS = `
    body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1a1a1a;
           line-height: 1.55; margin: 0; padding: 24px 36px; }
    h1 { font-size: 20pt; margin: 0 0 6px; }
    .meta { color: #6b7280; font-size: 9.5pt; margin-bottom: 24px; }
    .turn { margin-bottom: 14px; }
    .role { font-weight: bold; font-size: 12pt; margin: 22px 0 6px; }
    .user > .role { color: #2563eb; }
    .assistant > .role { color: #7c3aed; }
    pre { background: #f5f5f4; border: 1px solid #e5e5e5; padding: 10px 12px;
          font-family: Consolas, 'Courier New', monospace; font-size: 9.5pt;
          white-space: pre-wrap; word-wrap: break-word; }
    code { font-family: Consolas, 'Courier New', monospace; background: #f5f5f4; }
    pre code { background: transparent; }
    table { border-collapse: collapse; margin: 8px 0; }
    th, td { border: 1px solid #d4d4d4; padding: 5px 9px; font-size: 10pt; }
    th { background: #f3f4f6; }
    blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid #cbd5e1; color: #475569; }
    img { max-width: 640px; height: auto; }
    .lang { color: #6b7280; font-size: 8.5pt; }
    .ce-math-display { text-align: center; margin: 10px 0; }
    .footer { color: #9ca3af; font-size: 8.5pt; margin-top: 32px;
              border-top: 1px solid #e5e7eb; padding-top: 8px; }
  `;

  function processMath(html, forWord) {
    if (!forWord) return html;
    const root = document.createElement('div');
    root.innerHTML = html;
    root.querySelectorAll('.ce-math').forEach((s) => {
      const tex = s.getAttribute('data-tex') || '';
      const display = s.getAttribute('data-display') === '1';
      const holder = document.createElement(display ? 'div' : 'span');
      holder.innerHTML = CE.exporters.word.mathToHtml(tex, display);
      s.replaceWith(...holder.childNodes);
    });
    return root.innerHTML;
  }

  function renderBlocks(blocks, forWord) {
    return blocks.map((b) => {
      if (b.type === 'html') return `<div>${processMath(b.html, forWord)}</div>`;
      if (b.type === 'math') {
        return forWord
          ? CE.exporters.word.mathToHtml(b.tex, true)
          : `<div class="ce-math" data-tex="${CE.utils.htmlEscape(b.tex)}" data-display="1"></div>`;
      }
      if (b.type === 'code') {
        const lang = b.lang ? `<div class="lang">${CE.utils.htmlEscape(b.lang)}</div>` : '';
        return `${lang}<pre><code>${CE.utils.htmlEscape(b.text)}</code></pre>`;
      }
      if (b.type === 'image') {
        const w = b.width ? ` width="${b.width}"` : '';
        return `<p><img src="${CE.utils.htmlEscape(b.src)}" alt="${CE.utils.htmlEscape(b.alt)}"${w}></p>`;
      }
      if (b.type === 'table') {
        let t = processMath(b.html, forWord);
        if (forWord) t = t.replace(/<table/gi, '<table border="1" cellspacing="0" cellpadding="6"');
        return t;
      }
      return '';
    }).join('\n');
  }

  CE.exporters.htmlDoc = {
    build(doc, opts = {}) {
      const forWord = !!opts.word;
      const esc = CE.utils.htmlEscape;
      const title = esc(doc.title);
      const head = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>`;
      const meta = `<h1>${title}</h1><div class="meta">${esc(doc.label)} • ${esc(doc.exportedAt)} • <a href="${esc(doc.url)}">${esc(doc.url)}</a></div>`;
      const body = doc.turns.map((t) =>
        `<div class="turn ${t.role}"><div class="role">${t.role === 'user' ? 'You' : esc(doc.label)}</div>`
        + `${renderBlocks(t.blocks, forWord)}</div>`
      ).join('\n');
      const footer = '<div class="footer">Exported with Context Exporter (open source)</div>';
      return `${head}${meta}${body}${footer}</body></html>`;
    },
  };
})();
