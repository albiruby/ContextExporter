// Adapter for claude.ai.
//
// The 2026 client virtualizes the transcript: rows carry data-testid
// "transcript-row" and data-rs-index, and only a window of them exists in the
// DOM at a time. The page itself loads the full conversation through its own
// API, so that endpoint is the primary source. When it is unavailable, the
// adapter harvests whatever rows are mounted at every scroll step, keyed by
// data-turn-key and ordered by data-rs-index.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});
  CE.adapters = CE.adapters || {};

  const ROW_SEL = '[data-testid="transcript-row"]';
  const MSG_SEL = '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-message';

  const TURN_COMBOS = [
    MSG_SEL,
    '[data-testid="user-message"], [data-testid="assistant-message"]',
    'div[data-testid="user-message"], [class*="claude-message" i]',
  ];

  function dedupe(els) {
    return els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
  }

  CE.adapters.claude = {
    id: 'claude',
    label: 'Claude',

    match() {
      return /(^|\.)claude\.ai$/.test(location.hostname);
    },

    ready() {
      return this.count() > 0;
    },

    messageNodes() {
      const rows = [...document.querySelectorAll(ROW_SEL)];
      if (rows.length) return rows;
      for (const sel of TURN_COMBOS) {
        const els = dedupe([...document.querySelectorAll(sel)]);
        if (els.length) return els;
      }
      return [];
    },

    turns() {
      return this.messageNodes();
    },

    count() {
      return this.messageNodes().length;
    },

    scroller() {
      const first = this.turns()[0];
      return CE.scroll.findScroller(first) || document.querySelector('main');
    },

    signature(sc) {
      return this.count() + ':' + (sc.textContent || '').length;
    },

    /* ---------- primary: the site's own conversation API ---------- */

    conversationId() {
      const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
      return m ? m[1] : null;
    },

    async orgId() {
      if (this._org !== undefined) return this._org;
      this._org = null;
      try {
        const raw = localStorage.getItem('lastActiveOrg');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (typeof parsed === 'string') this._org = parsed;
        }
      } catch (e) { /* plain string or absent */ }
      if (this._org) return this._org;
      try {
        const res = await fetch('https://claude.ai/api/organizations', { credentials: 'include' });
        if (res.ok) {
          const list = await res.json();
          const first = Array.isArray(list) ? list[0] : null;
          this._org = (first && (first.uuid || first.id)) || null;
        }
      } catch (e) { /* no org */ }
      return this._org;
    },

    async gatherFromApi() {
      const id = this.conversationId();
      if (!id) {
        this._apiNote = 'no conversation id in url';
        return null;
      }
      if (!CE.mdtext) {
        this._apiNote = 'markdown parser missing';
        return null;
      }
      const org = await this.orgId();
      if (!org) {
        this._apiNote = 'organization id unavailable';
        return null;
      }
      const url = `https://claude.ai/api/organizations/${org}/chat_conversations/${id}`
        + '?tree=True&rendering_mode=messages&render_all_tools=true'
        + '&include_inline_comparison=true&renders_source_card=true&consistency=strong';
      let data = null;
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
          this._apiNote = 'http ' + res.status;
          return null;
        }
        data = await res.json();
      } catch (e) {
        this._apiNote = 'fetch failed: ' + (e && e.message ? e.message : e);
        return null;
      }

      const msgs = data && Array.isArray(data.chat_messages) ? data.chat_messages : null;
      if (!msgs || !msgs.length) {
        this._apiNote = 'no chat_messages in response';
        return null;
      }

      const turns = [];
      for (const msg of msgs) {
        if (!msg) continue;
        const role = msg.sender === 'human' ? 'user' : 'assistant';
        const blocks = [];
        const text = this.messageText(msg);
        if (text.trim()) blocks.push(...CE.mdtext.textToBlocks(text));
        const names = this.attachmentNames(msg);
        if (names.length) {
          blocks.push({
            type: 'html',
            html: '<p><em>Attachment: ' + names.map((n) => CE.utils.htmlEscape(n)).join(', ') + '</em></p>',
          });
        }
        if (blocks.length) turns.push({ role, blocks });
      }
      if (!turns.length) {
        this._apiNote = 'api ok but 0 usable messages';
        return null;
      }
      return { title: data.name || '', turns };
    },

    messageText(msg) {
      if (Array.isArray(msg.content)) {
        const parts = msg.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
          .map((b) => b.text);
        if (parts.length) return parts.join('\n\n');
      }
      return typeof msg.text === 'string' ? msg.text : '';
    },

    attachmentNames(msg) {
      const out = [];
      const add = (list) => {
        if (!Array.isArray(list)) return;
        list.forEach((a) => {
          if (a && (a.file_name || a.filename)) out.push(a.file_name || a.filename);
        });
      };
      add(msg.attachments);
      add(msg.files);
      return [...new Set(out)];
    },

    /* ---------- fallback: virtualized DOM ---------- */

    rowContentEl(row, role) {
      const sel = role === 'user'
        ? '[data-testid="user-message"]'
        : '[data-testid="assistant-message"]';
      return row.querySelector(sel) || row;
    },

    collectWindow(state, step) {
      const rows = [...document.querySelectorAll(ROW_SEL)];
      const usingRows = rows.length > 0;
      const els = usingRows ? rows : this.turns();
      els.forEach((el, idx) => {
        let role;
        let pos = null;
        let key;
        if (usingRows) {
          if (el.getAttribute('data-perf-row-streaming') === 'true') return;
          const kind = el.getAttribute('data-perf-row');
          if (!kind) return;
          role = kind === 'human' ? 'user' : 'assistant';
          const rs = Number(el.getAttribute('data-rs-index'));
          pos = Number.isFinite(rs) ? rs : null;
          key = el.getAttribute('data-turn-key') || (pos === null ? null : 'row:' + pos);
          if (pos !== null) {
            if (!state.rowsSeen) state.rowsSeen = new Set();
            state.rowsSeen.add(pos);
            const tail = Number(el.getAttribute('data-perf-row-from-tail'));
            if (Number.isFinite(tail)) state.maxRow = Math.max(state.maxRow || 0, pos + tail + 1);
          }
        } else {
          role = this.roleOf(el);
          const head = (this.contentEl(el).textContent || '').replace(/\s+/g, ' ').trim();
          key = role + '|' + head.slice(0, 180);
        }
        if (!key || state.seen.has(key)) return;

        const content = usingRows ? this.rowContentEl(el, role) : this.contentEl(el);
        const blocks = CE.extract.extractBlocks(content);
        // Attachments (screenshots, files) sit beside the bubble, not in it.
        if (usingRows && role === 'user') {
          const seenSrc = new Set();
          [...el.querySelectorAll('img')].forEach((img) => {
            if (content.contains(img)) return;
            const src = img.currentSrc || img.src;
            if (!src || seenSrc.has(src)) return;
            const w = img.naturalWidth || img.width || 0;
            if (w < 48) return;
            seenSrc.add(src);
            blocks.push({ type: 'image', src, alt: img.alt || '', width: Math.min(w, 900) });
          });
        }
        if (!blocks.length) return;
        state.seen.add(key);
        state.items.push({ role, blocks, step, idx, pos });
      });
    },

    docFromWindow(state) {
      const items = state.items.slice();
      const indexed = items.every((it) => typeof it.pos === 'number');
      if (indexed) {
        items.sort((a, b) => a.pos - b.pos);
      } else {
        items.sort((a, b) => (b.step !== a.step ? b.step - a.step : a.idx - b.idx));
      }
      const turns = [];
      items.forEach((it) => {
        const prev = turns[turns.length - 1];
        if (prev && prev.role === it.role) prev.blocks.push(...it.blocks);
        else turns.push({ role: it.role, blocks: it.blocks });
      });
      return {
        title: CE.utils.cleanTitle('Claude'),
        source: this.id,
        label: this.label,
        url: location.href,
        turns,
      };
    },

    async gather(onProgress) {
      this._org = undefined;
      this._apiNote = null;
      try {
        const apiDoc = await this.gatherFromApi();
        if (apiDoc) {
          const doc = {
            title: apiDoc.title || CE.utils.cleanTitle('Claude'),
            source: this.id,
            label: this.label,
            url: location.href,
            note: 'via api',
            turns: apiDoc.turns,
          };
          doc.exportedAt = CE.utils.today();
          return doc;
        }
      } catch (e) {
        this._apiNote = 'error: ' + (e && e.message ? e.message : e);
      }

      const state = { seen: new Set(), items: [] };
      await CE.scroll.loadVirtualized({
        scroller: () => this.scroller(),
        collect: (step) => this.collectWindow(state, step),
        progressCount: () => state.items.length,
        onProgress,
        signature: (sc) => this.signature(sc),
        spanSel: ROW_SEL,
        maxJump: 1.4,
        minTicks: 2,
      });
      await CE.scroll.loadFullHistory({ count: () => this.count(), scroller: () => this.scroller() });
      this.collectWindow(state, Number.MAX_SAFE_INTEGER);
      // data-rs-index plus data-perf-row-from-tail reveal how many rows exist;
      // a short harvest gets one conservative second sweep instead of holes.
      if (state.maxRow && state.rowsSeen && state.rowsSeen.size < state.maxRow) {
        await CE.scroll.loadVirtualized({
          scroller: () => this.scroller(),
          collect: (step) => this.collectWindow(state, step),
          progressCount: () => state.items.length,
          onProgress,
          signature: (sc) => this.signature(sc),
          minTicks: 2,
          maxSteps: 600,
        });
        await CE.scroll.loadFullHistory({ count: () => this.count(), scroller: () => this.scroller() });
        this.collectWindow(state, Number.MAX_SAFE_INTEGER);
      }
      const doc = this.docFromWindow(state);
      doc.note = 'via dom fallback (api: ' + (this._apiNote || 'unknown') + ')';
      doc.exportedAt = CE.utils.today();
      return doc;
    },

    /* ---------- helpers kept for the DOM path ---------- */

    roleOf(el) {
      const marker = el.closest('[data-testid="user-message"], [data-testid="assistant-message"]');
      if (marker) return marker.matches('[data-testid="user-message"]') ? 'user' : 'assistant';
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n instanceof HTMLElement) {
          for (const v of Object.values(n.dataset)) {
            if (v === 'user' || v === 'assistant') return v;
          }
        }
      }
      return 'assistant';
    },

    contentEl(turn) {
      const md = turn.querySelector('.markdown, .markdown-body, [class*="markdown" i]');
      if (md && md.textContent.trim()) return md;
      const inner = turn.querySelector('[data-testid="assistant-message"], [data-testid="user-message"]');
      return inner || turn;
    },

    parseTurn(el) {
      const role = this.roleOf(el);
      return { role, blocks: CE.extract.extractBlocks(this.contentEl(el)) };
    },

    doc() {
      return {
        title: CE.utils.cleanTitle('Claude'),
        source: this.id,
        label: this.label,
        url: location.href,
        turns: this.turns().map((el) => this.parseTurn(el)).filter((t) => t.blocks.length),
      };
    },
  };
})();
