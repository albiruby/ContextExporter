// Markdown exporter. Blocks are stored as cleaned HTML, so conversion walks
// the DOM: inline nodes map to markdown spans, tables become pipe tables.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});

  const isMathToken = (el) => String(el.className || '').includes('ce-math');

  function inlineToMd(node) {
    let out = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) {
        out += n.textContent.replace(/\s+/g, ' ');
        return;
      }
      if (n.nodeType !== 1) return;
      if (isMathToken(n)) {
        const tex = n.getAttribute('data-tex') || '';
        out += n.getAttribute('data-display') === '1' ? ` $$${tex}$$ ` : ` $${tex}$ `;
        return;
      }
      const tag = n.tagName;
      if (tag === 'BR') {
        out += '  \n';
      } else if (tag === 'STRONG' || tag === 'B') {
        out += `**${inlineToMd(n).trim()}**`;
      } else if (tag === 'EM' || tag === 'I') {
        out += `*${inlineToMd(n).trim()}*`;
      } else if (tag === 'DEL' || tag === 'S') {
        out += `~~${inlineToMd(n).trim()}~~`;
      } else if (tag === 'CODE') {
        out += '`' + n.textContent + '`';
      } else if (tag === 'A') {
        out += `[${inlineToMd(n).trim()}](${n.getAttribute('href') || ''})`;
      } else if (tag === 'IMG') {
        out += `![${n.getAttribute('alt') || ''}](${n.getAttribute('src') || ''})`;
      } else {
        out += inlineToMd(n);
      }
    });
    return out;
  }

  // Inline siblings (text, emphasis, links) belong to one paragraph; only
  // block-level children start their own. The ChatGPT DOM hands us fragments
  // shaped like "text <strong>run</strong> text" all the way down.
  const MD_BLOCK = /^(P|DIV|PRE|H[1-6]|UL|OL|TABLE|BLOCKQUOTE|HR)$/;

  function blockChildren(el) {
    const parts = [];
    let inline = '';
    const flush = () => {
      const t = inline.trim();
      if (t) parts.push(t);
      inline = '';
    };
    [...el.childNodes].forEach((n) => {
      if (n.nodeType === 3) {
        inline += n.textContent.replace(/\s+/g, ' ');
        return;
      }
      if (n.nodeType !== 1 || n.tagName === 'BUTTON') return;
      if (MD_BLOCK.test(n.tagName)) {
        flush();
        parts.push(blockToMd(n));
      } else {
        inline += inlineToMd(n);
      }
    });
    flush();
    return parts.filter(Boolean);
  }

  function listToMd(list, depth) {
    const ordered = list.tagName === 'OL';
    let i = parseInt(list.getAttribute('start') || '1', 10);
    const lines = [];
    [...list.children].forEach((li) => {
      if (li.tagName !== 'LI') return;
      const marker = ordered ? `${i++}.` : '-';
      const nested = [...li.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
      const clone = li.cloneNode(true);
      clone.querySelectorAll('ul,ol').forEach((n) => n.remove());
      const head = inlineToMd(clone).trim();
      const tail = nested.map((n) => '\n' + listToMd(n, depth + 1)).join('');
      lines.push('  '.repeat(depth) + marker + ' ' + head + tail);
    });
    return lines.join('\n');
  }

  function tableToMd(table) {
    const rows = [...table.querySelectorAll('tr')];
    if (!rows.length) return null;
    const cellText = (c) => inlineToMd(c).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' ');
    const rowCells = rows.map(
      (r) => [...r.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
    );
    let cols = 0;
    rowCells.forEach((cells) => {
      cols = Math.max(cols, cells.reduce((w, c) => w + (c.colSpan || 1), 0));
    });
    if (!cols || cols > 24) return null;
    // Occupancy grid: colspan/rowspan cells pad with empty strings instead of
    // aborting the table (the old check fell back to raw HTML).
    const grid = rowCells.map(() => []);
    rowCells.forEach((cells, ri) => {
      let ci = 0;
      cells.forEach((c) => {
        while (ci < cols && grid[ri][ci] !== undefined) ci++;
        if (ci >= cols) return;
        const cspan = Math.min(c.colSpan || 1, cols - ci);
        const rspan = c.rowSpan || 1;
        for (let dr = 0; dr < rspan && ri + dr < grid.length; dr++) {
          for (let dc = 0; dc < cspan; dc++) {
            grid[ri + dr][ci + dc] = dr === 0 && dc === 0 ? cellText(c) : '';
          }
        }
        ci += cspan;
      });
      for (let k = 0; k < cols; k++) if (grid[ri][k] === undefined) grid[ri][k] = '';
    });
    if (!grid.length || !grid[0].length) return null;
    const out = [];
    out.push('| ' + grid[0].join(' | ') + ' |');
    out.push('|' + grid[0].map(() => ' --- ').join('|') + '|');
    grid.slice(1).forEach((line) => out.push('| ' + line.join(' | ') + ' |'));
    return out.join('\n');
  }

  function blockToMd(el) {
    const tag = el.tagName;
    if (isMathToken(el)) {
      const tex = el.getAttribute('data-tex') || '';
      return el.getAttribute('data-display') === '1' ? `$$${tex}$$` : `$${tex}$`;
    }
    if (tag === 'P' || tag === 'DIV') return inlineToMd(el).trim();
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
      return '#'.repeat(Number(tag[1])) + ' ' + inlineToMd(el).trim();
    }
    if (tag === 'UL' || tag === 'OL') return listToMd(el, 0);
    if (tag === 'BLOCKQUOTE') {
      return blockChildren(el).map((p) => p.split('\n').map((l) => '> ' + l).join('\n')).join('\n\n');
    }
    if (tag === 'PRE') return '```\n' + el.textContent + '\n```';
    if (tag === 'TABLE') return tableToMd(el) || el.outerHTML;
    if (tag === 'HR') return '---';
    if (tag === 'IMG') return `![${el.getAttribute('alt') || ''}](${el.getAttribute('src') || ''})`;
    return inlineToMd(el).trim();
  }

  function htmlToMd(html) {
    const root = document.createElement('div');
    root.innerHTML = html;
    return blockChildren(root).join('\n\n');
  }

  function tableBlockToMd(html) {
    const root = document.createElement('div');
    root.innerHTML = html;
    const table = root.querySelector('table');
    return (table && tableToMd(table)) || html;
  }

  CE.exporters.markdown = {
    ext: 'md',
    mime: 'text/markdown',

    build(doc) {
      const L = [`# ${doc.title}`, '', `> Exported from ${doc.label} on ${doc.exportedAt}`, ''];
      doc.turns.forEach((t) => {
        L.push('', '---', '', `## ${t.role === 'user' ? '👤 You' : '🤖 ' + doc.label}`, '');
        t.blocks.forEach((b) => {
          if (b.type === 'code') {
            const fence = b.text.includes('```') ? '````' : '```';
            L.push(fence + (b.lang || ''), b.text, fence, '');
          } else if (b.type === 'image') {
            L.push(`![${b.alt || ''}](${b.src})`, '');
          } else if (b.type === 'math') {
            L.push(`$$${b.tex}$$`, '');
          } else if (b.type === 'html') {
            const md = htmlToMd(b.html);
            if (md.trim()) L.push(md, '');
          } else if (b.type === 'table') {
            L.push(tableBlockToMd(b.html), '');
          }
        });
      });
      L.push('', '---', '', 'Exported with Context Exporter (open source)');
      return L.join('\n');
    },
  };
})();
