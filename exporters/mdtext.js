// Minimal markdown parser used by the ChatGPT API path, where messages
// arrive as markdown strings. Produces the same block shape the DOM
// extractors emit, including ce-math tokens for $...$ / $$...$$.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});

  function esc(s) {
    return CE.utils.htmlEscape(s);
  }

  // tex arrives already HTML-escaped from inlineMd, so it is inserted as-is;
  // escaping twice would corrupt symbols like < and &.
  function token(tex, display) {
    return `<span class="ce-math" data-tex="${tex}" data-display="${display ? '1' : '0'}"></span>`;
  }

  // Inline markdown to HTML. Escapes first, then rebuilds formatting.
  function inlineMd(s) {
    let t = esc(s);
    // display tokens first so their $ pairs are not eaten by the inline rule
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => token(tex, true));
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => (
      /^(https?:|data:)/i.test(src) ? `<img src="${src}" alt="${alt}">` : alt
    ));
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => (
      /^(https?:|mailto:|#)/i.test(href) ? `<a href="${href}">${label}</a>` : label
    ));
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    t = t.replace(/__([^_\n]+)__/g, '<b>$1</b>');
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');
    t = t.replace(/\$([^$\n]+)\$/g, (_, tex) => token(tex, false));
    return t;
  }

  function pipeTable(lines) {
    const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    const body = rows.filter((r, i) => i !== 1 || !/^:?-{2,}:?$/.test(r[0]));
    const header = rows[0];
    const cells = (r) => r.map((c) => `<td>${inlineMd(c)}</td>`).join('');
    return '<table><tr>' + header.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr>'
      + body.slice(1).map((r) => `<tr>${cells(r)}</tr>`).join('') + '</table>';
  }

  function listHtml(items) {
    let i = 0;
    const build = (indent) => {
      const ordered = items[i].ordered;
      let html = ordered ? '<ol>' : '<ul>';
      while (i < items.length && items[i].indent >= indent) {
        if (items[i].indent > indent) {
          const sub = build(items[i].indent);
          html = html.replace(/<\/li>$/, sub + '</li>');
        } else {
          html += '<li>' + inlineMd(items[i].text) + '</li>';
          i++;
        }
      }
      return html + (ordered ? '</ol>' : '</ul>');
    };
    return build(items[0].indent);
  }

  function textToBlocks(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    let para = [];
    const flush = () => {
      const p = para.join('\n').trim();
      if (p) blocks.push({ type: 'html', html: `<p>${inlineMd(p)}</p>` });
      para = [];
    };

    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^\s*```([\w+#-]*)\s*$/);
      if (fence) {
        flush();
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++;
        blocks.push({ type: 'code', lang: fence[1], text: body.join('\n') });
        continue;
      }

      if (/^\s*\$\$/.test(line)) {
        flush();
        let buf = [line.replace(/^\s*\$\$/, '')];
        i++;
        while (i < lines.length && !/\$\$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) {
          buf.push(lines[i].replace(/\$\$\s*$/, ''));
          i++;
        }
        const tex = buf.join('\n').trim();
        if (tex) blocks.push({ type: 'math', tex, display: true });
        continue;
      }

      if (!line.trim()) {
        flush();
        i++;
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flush();
        blocks.push({ type: 'html', html: `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>` });
        i++;
        continue;
      }

      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        flush();
        blocks.push({ type: 'html', html: '<hr>' });
        i++;
        continue;
      }

      if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
        flush();
        const tbl = [];
        while (i < lines.length && /\|/.test(lines[i])) {
          tbl.push(lines[i]);
          i++;
        }
        blocks.push({ type: 'table', html: pipeTable(tbl) });
        continue;
      }

      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flush();
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (m) {
            items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
            i++;
          } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
            items[items.length - 1].text += ' ' + lines[i].trim();
            i++;
          } else {
            break;
          }
        }
        blocks.push({ type: 'html', html: listHtml(items) });
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flush();
        const q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        blocks.push({ type: 'html', html: `<blockquote>${inlineMd(q.join(' '))}</blockquote>` });
        continue;
      }

      para.push(line);
      i++;
    }
    flush();
    return blocks;
  }

  // One backend message -> block list, covering the content types that carry
  // visible conversation text.
  function messageToBlocks(msg) {
    const c = msg.content || {};
    const out = [];
    // GPT custom instructions and error banners are site state, not chat.
    if (c.content_type === 'user_editable_context' || c.content_type === 'system_error') return out;
    if (c.content_type === 'text' && Array.isArray(c.parts)) {
      const md = c.parts.filter((p) => typeof p === 'string' && p.trim()).join('\n\n');
      if (md.trim()) out.push(...textToBlocks(md));
    } else if (c.content_type === 'code') {
      out.push({ type: 'code', lang: c.language || (c.metadata && c.metadata.language) || '', text: c.text || '' });
    } else if (c.content_type === 'execution_output') {
      if ((c.text || '').trim()) out.push({ type: 'code', lang: 'output', text: c.text });
    } else if (c.content_type === 'multimodal_text' && Array.isArray(c.parts)) {
      let txt = '';
      for (const p of c.parts) {
        if (typeof p === 'string') {
          txt += (txt ? '\n\n' : '') + p;
        } else if (p && p.content_type === 'image_asset_pointer' && p.asset_pointer) {
          // Pointers arrive as file-service://, sediment:// or bare ids;
          // normalise so the downloader gets a file id it recognises.
          const fid = String(p.asset_pointer).match(/(file[-_][\w-]+)\s*$/);
          out.push({
            type: 'image',
            src: fid ? 'file-service://' + fid[1] : String(p.asset_pointer),
            alt: 'image',
            width: Math.min(p.width || 0, 640),
          });
        } else if (p && p.content_type === 'audio_transcript' && p.text) {
          txt += (txt ? '\n\n' : '') + p.text;
        }
      }
      if (txt.trim()) out.push(...textToBlocks(txt));
    } else if (typeof c.text === 'string' && c.text.trim()) {
      // Unknown content types often still carry plain text; keep it rather
      // than dropping the message silently.
      out.push(...textToBlocks(c.text));
    }
    return out;
  }

  CE.mdtext = { textToBlocks, messageToBlocks };
})();
