// Adapter for chatgpt.com (and legacy chat.openai.com).
//
// The 2026 redesign virtualizes the thread (only the visible window of turns
// exists in the DOM), so the primary source is the backend conversation API
// identified by the /c/<uuid> in the URL. If the API is unavailable, we fall
// back to scraping the virtualized DOM: scroll bottom-to-top, harvesting
// [data-conversation-role] / [data-turn-key] nodes at every step and deduping
// them by key. Every API bail point is recorded in _apiNote so the toast can
// say which path ran and why.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});
  CE.adapters = CE.adapters || {};

  const TURN_COMBOS = [
    '[data-conversation-role]',
    '[data-turn-key]',
    'article[data-testid^="conversation-turn"]',
    '[data-message-author-role]',
    '[data-message-id]',
    'main article',
  ];

  // Screen-reader leftovers ("You said:" / "ChatGPT said:") are site chrome.
  const LABEL_ONLY = /^(you said:?|chatgpt said:?|you|chatgpt)\s*[.:]?\s*$/i;

  function dedupe(els) {
    return els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
  }

  CE.adapters.chatgpt = {
    id: 'chatgpt',
    label: 'ChatGPT',

    match() {
      return /(^|\.)chatgpt\.com$/.test(location.hostname)
        || /(^|\.)chat\.openai\.com$/.test(location.hostname);
    },

    ready() {
      return this.count() > 0;
    },

    turns() {
      for (const sel of TURN_COMBOS) {
        const els = dedupe([...document.querySelectorAll(sel)]);
        if (els.length) return els;
      }
      return [];
    },

    count() {
      for (const sel of TURN_COMBOS) {
        const els = dedupe([...document.querySelectorAll(sel)]);
        if (els.length) return els.length;
      }
      return 0;
    },

    scroller() {
      return document.querySelector('[class*="thread-scroll-container"]')
        || (this.turns()[0] && CE.scroll.findScroller(this.turns()[0]))
        || document.querySelector('main');
    },

    /* ---------- primary: backend API ---------- */

    conversationId() {
      const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
      return m ? m[1] : null;
    },

    // The backend echoes the browser's device cookie on most calls; sending
    // it mirrors what the site's own client does.
    deviceId() {
      const m = document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    },

    apiHeaders(token) {
      const h = { Accept: 'application/json' };
      const did = this.deviceId();
      if (did) h['Oai-Device-Id'] = did;
      if (token) h.Authorization = 'Bearer ' + token;
      return h;
    },

    async authToken() {
      if (this._token !== undefined) return this._token;
      this._token = null;
      try {
        const s = await fetch('/api/auth/session', { credentials: 'include' });
        if (s.ok) this._token = (await s.json()).accessToken || null;
      } catch (e) { /* treated as no token */ }
      return this._token;
    },

    async fetchApi(url, token) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      try {
        return await fetch(url, {
          credentials: 'include',
          headers: this.apiHeaders(token || undefined),
          signal: ctl.signal,
        });
      } catch (e) {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    // One authenticated GET: the conversation endpoints answer 404 "Log in"
    // without the Bearer token even when cookies go out, so the session token
    // is resolved up front. One 401 retry with a fresh token, one 429 cooldown
    // retry. Failures record status plus a body snippet in _apiNote.
    async apiGet(url) {
      let token = await this.authToken();
      let res = await this.fetchApi(url, token);
      if (!res) {
        this._apiNote = 'fetch failed';
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        this._token = undefined;
        token = await this.authToken();
        res = await this.fetchApi(url, token);
        if (!res) {
          this._apiNote = 'fetch failed on auth retry';
          return null;
        }
      }
      if (res.status === 429) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 5, 10);
        await CE.utils.sleep(wait * 1000);
        res = await this.fetchApi(url, token);
        if (!res) {
          this._apiNote = 'fetch failed after cooldown';
          return null;
        }
      }
      if (!res.ok) {
        let body = '';
        try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 120); } catch (e) { /* ignore */ }
        this._apiNote = 'http ' + res.status + (body ? ' ' + body : '');
        return null;
      }
      try {
        return await res.json();
      } catch (e) {
        this._apiNote = 'invalid json';
        return null;
      }
    },

    // Message objects are identical across both endpoint generations, so one
    // converter serves the flat list and the old mapping chain.
    turnsFromMessageList(msgs) {
      const sorted = msgs.slice().sort(
        (a, b) => ((a && a.create_time) || 0) - ((b && b.create_time) || 0)
      );
      const turns = [];
      for (const msg of sorted) {
        if (!msg || !msg.author) continue;
        const role = msg.author.role;
        if (role !== 'user' && role !== 'assistant') continue;
        if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
        const blocks = CE.mdtext.messageToBlocks(msg);
        if (blocks.length) turns.push({ role, blocks });
      }
      return turns;
    },

    // Current endpoint (Aug 2026): flat, paginated messages[] with page_info.
    // The first page carries the latest turns; older ones are pulled with
    // /messages?before=<start_cursor> until has_previous_page clears.
    async gatherFromMessages(id) {
      const pages = [];
      let before = null;
      for (let p = 0; p < 60; p++) {
        const base = p === 0
          ? `/backend-api/conversations/${id}`
          : `/backend-api/conversations/${id}/messages`;
        const url = `${base}?num_turns=100&include_has_versions=true`
          + (before ? '&before=' + encodeURIComponent(before) : '');
        const data = await this.apiGet(url);
        if (!data) return null;
        pages.push(data);
        const pi = data.page_info;
        if (!pi || pi.has_previous_page !== true || !pi.start_cursor || pi.start_cursor === before) break;
        before = pi.start_cursor;
      }
      const msgs = [];
      pages.forEach((pg) => {
        if (Array.isArray(pg.messages)) msgs.push(...pg.messages);
      });
      if (!msgs.length) {
        this._apiNote = 'messages endpoint returned empty messages[]';
        return null;
      }
      return { turns: this.turnsFromMessageList(msgs), title: pages[0].title || '' };
    },

    // Previous endpoint: mapping tree, still live on accounts that have not
    // received the rollout.
    async gatherFromMapping(id) {
      const data = await this.apiGet(`/backend-api/conversation/${id}`);
      if (!data) return null;
      if (!data.mapping || !data.current_node) {
        const keys = Object.keys(data).slice(0, 10).join(',');
        this._apiNote = 'mapping payload keys: ' + (keys || 'none');
        return null;
      }
      const chain = [];
      let cur = data.current_node;
      while (cur && data.mapping[cur]) {
        chain.push(data.mapping[cur]);
        cur = data.mapping[cur].parent;
      }
      chain.reverse();
      const turns = this.turnsFromMessageList(chain.map((n) => n.message).filter(Boolean));
      if (!turns.length) {
        this._apiNote = 'mapping: 0 turns from ' + chain.length + ' nodes';
        return null;
      }
      return { turns, title: data.title || '' };
    },

    async gatherFromApi() {
      const id = this.conversationId();
      if (!id) {
        this._apiNote = 'no conversation id in url';
        return null;
      }
      const notes = [];
      const attempts = [
        () => this.gatherFromMessages(id),
        () => this.gatherFromMapping(id),
      ];
      for (const fn of attempts) {
        let r = null;
        try {
          r = await fn();
        } catch (e) {
          notes.push((e && e.message ? e.message : e));
          continue;
        }
        if (r && r.turns.length) {
          return {
            title: r.title || CE.utils.cleanTitle('ChatGPT'),
            source: this.id,
            label: this.label,
            url: location.href,
            note: 'via api',
            turns: r.turns,
          };
        }
        notes.push(this._apiNote || 'no turns');
      }
      this._apiNote = notes.join(' | ');
      return null;
    },

    /* ---------- fallback: virtualized DOM ---------- */

    keyFor(el) {
      const unit = el.closest('[data-chatgpt-search-unit-key]');
      if (unit) return unit.getAttribute('data-chatgpt-search-unit-key');
      const turn = el.closest('[data-turn-key]');
      if (turn) return turn.getAttribute('data-turn-key');
      return 'text:' + (el.textContent || '').trim().slice(0, 80);
    },

    sortIdxOf(key) {
      const m = String(key).match(/turn-(\d+):(\d+)/);
      return m ? Number(m[1]) * 100 + Number(m[2]) : undefined;
    },

    // An item must carry real content: text that is not just a screen-reader
    // label, or at least one image.
    itemIsContent(blocks) {
      if (!blocks.length) return false;
      const hasImage = blocks.some((b) => b.type === 'image' || /<img/i.test(b.html || ''));
      if (hasImage) return true;
      const text = blocks.map((b) => {
        if (b.type === 'html' || b.type === 'table') {
          const d = document.createElement('div');
          d.innerHTML = b.html || '';
          return d.textContent || '';
        }
        return b.text || b.tex || b.alt || '';
      }).join(' ').replace(/\s+/g, ' ').trim();
      return text.length > 0 && !LABEL_ONLY.test(text);
    },

    // Each marker's content runs from the marker to the next marker (or the
    // end of its turn). The 2026 DOM keeps the screen-reader label and the
    // message body as siblings, so extracting only the marker subtree yields
    // labels alone; the range captures both.
    pushItem(state, keyEl, role, source) {
      const key = this.keyFor(keyEl);
      const text = (source.textContent || '').replace(/\s+/g, ' ').trim();
      const sig = 'text:' + text.slice(0, 120);
      if (state.seen.has(key) || (sig.length > 10 && state.seen.has(sig))) return;
      state.seen.add(key);
      if (sig.length > 10) state.seen.add(sig);
      const blocks = CE.extract.extractBlocks(source);
      if (!this.itemIsContent(blocks)) return;
      state.items.push({ role, sortIdx: this.sortIdxOf(key), blocks });
    },

    collectWindow(state) {
      const sc = this.scroller() || document;
      const turns = dedupe([...sc.querySelectorAll('[data-turn-key]')]);
      const sources = turns.length ? turns : [sc];
      sources.forEach((src) => {
        const markers = [...src.querySelectorAll('[data-conversation-role]')];
        if (!markers.length) {
          this.pushItem(state, src, this.roleOf(src), src);
          return;
        }
        markers.forEach((m, i) => {
          const range = document.createRange();
          range.setStartBefore(m);
          if (markers[i + 1]) {
            range.setEndBefore(markers[i + 1]);
          } else {
            range.setEndAfter(src.lastChild || src);
          }
          this.pushItem(state, m, this.roleOf(m), range.cloneContents());
        });
      });
    },

    docFromWindow(state) {
      const items = state.items.slice();
      const indexed = items.every((it) => typeof it.sortIdx === 'number');
      if (indexed) items.sort((a, b) => a.sortIdx - b.sortIdx);
      else items.reverse(); // harvested bottom-to-top

      const turns = [];
      items.forEach((it) => {
        if (!it.blocks.length) return;
        const prev = turns[turns.length - 1];
        if (prev && prev.role === it.role) prev.blocks.push(...it.blocks);
        else turns.push({ role: it.role, blocks: it.blocks });
      });
      if (!turns.length) return null;
      return {
        title: CE.utils.cleanTitle('ChatGPT'),
        source: this.id,
        label: this.label,
        url: location.href,
        turns,
      };
    },

    async gather(onProgress) {
      this._seen = new Set();
      this._apiNote = null;
      this._token = undefined;
      let doc = null;
      try {
        doc = await this.gatherFromApi();
      } catch (e) {
        this._apiNote = 'error: ' + (e && e.message ? e.message : e);
      }
      if (doc) {
        doc.exportedAt = CE.utils.today();
        return doc;
      }

      // The DOM path is visible by nature: the site only mounts a turn when
      // its own scroller actually moves, so there is no way to harvest it
      // without scrolling. This pass is kept as short as possible.
      const state = { seen: this._seen, items: [] };
      await CE.scroll.loadVirtualized({
        scroller: () => this.scroller(),
        collect: () => this.collectWindow(state),
        progressCount: () => state.items.length,
        onProgress,
        spanSel: '[data-turn-key]',
        maxJump: 2.2,
      });
      const fb = this.docFromWindow(state);
      if (!fb) {
        throw new Error('no messages found (api: ' + (this._apiNote || 'not attempted') + ')');
      }
      fb.note = 'via dom fallback (api: ' + (this._apiNote || 'unknown') + ')';
      fb.exportedAt = CE.utils.today();
      return fb;
    },

    /* ---------- shared helpers kept for the DOM path ---------- */

    roleOf(el) {
      const marker = el.closest('[data-conversation-role]');
      if (marker) return marker.getAttribute('data-conversation-role');
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n instanceof HTMLElement) {
          for (const v of Object.values(n.dataset)) {
            if (v === 'user' || v === 'assistant') return v;
          }
        }
      }
      const inner = el.querySelector && el.querySelector(
        '[data-message-author-role], [data-user-message-bubble="true"]'
      );
      if (inner) {
        if (inner.hasAttribute('data-user-message-bubble')) return 'user';
        return inner.getAttribute('data-message-author-role') || 'assistant';
      }
      return 'assistant';
    },

    contentEl(turn, role) {
      if (role === 'user') return turn.querySelector('[data-user-message-bubble="true"]') || turn;
      return turn;
    },

    parseTurn(el) {
      const role = this.roleOf(el);
      return { role, blocks: CE.extract.extractBlocks(this.contentEl(el, role)) };
    },

    doc() {
      return {
        title: CE.utils.cleanTitle('ChatGPT'),
        source: this.id,
        label: this.label,
        url: location.href,
        turns: this.turns().map((a) => this.parseTurn(a)).filter((t) => t.blocks.length),
      };
    },
  };
})();
