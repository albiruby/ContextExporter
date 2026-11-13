// Adapter for gemini.google.com.
// The conversation is built from Angular custom elements: <user-query> and
// <model-response>, with text inside <message-content> / query containers.
// A cascade covers releases where the element names differ. Harvesting runs
// window by window while scrolling, so long chats are not limited to what is
// mounted when the run ends.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});
  CE.adapters = CE.adapters || {};

  const TURN_COMBOS = [
    'user-query, model-response',
    'message-content, query-text, query-content',
  ];

  function dedupe(els) {
    return els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
  }

  CE.adapters.gemini = {
    id: 'gemini',
    label: 'Gemini',

    match() {
      return location.hostname === 'gemini.google.com';
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
      const first = this.turns()[0];
      return CE.scroll.findScroller(first) || document.querySelector('main');
    },

    signature(sc) {
      return this.count() + ':' + (sc.textContent || '').length;
    },

    collectWindow(state, step) {
      const occ = new Map();
      this.turns().forEach((el, idx) => {
        const role = this.roleOf(el);
        const content = this.contentEl(el);
        const text = (content.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        const base = role + '|' + text.slice(0, 180);
        const n = occ.get(base) || 0;
        occ.set(base, n + 1);
        const sig = base + '#' + n;
        if (state.seen.has(sig)) return;
        state.seen.add(sig);
        const blocks = CE.extract.extractBlocks(content);
        if (!blocks.length) return;
        state.items.push({ role, blocks, step, idx });
      });
    },

    docFromWindow(state) {
      const items = state.items.slice().sort((a, b) => (
        b.step !== a.step ? b.step - a.step : a.idx - b.idx
      ));
      const turns = [];
      items.forEach((it) => {
        const prev = turns[turns.length - 1];
        if (prev && prev.role === it.role) prev.blocks.push(...it.blocks);
        else turns.push({ role: it.role, blocks: it.blocks });
      });
      return {
        title: CE.utils.cleanTitle('Gemini'),
        source: this.id,
        label: this.label,
        url: location.href,
        turns,
      };
    },

    async gather(onProgress) {
      const state = { seen: new Set(), items: [] };
      await CE.scroll.loadVirtualized({
        scroller: () => this.scroller(),
        collect: (step) => this.collectWindow(state, step),
        progressCount: () => state.items.length,
        onProgress,
        signature: (sc) => this.signature(sc),
        spanSel: 'user-query, model-response',
        maxJump: 1.6,
        minTicks: 2,
      });
      await CE.scroll.loadFullHistory({ count: () => this.count(), scroller: () => this.scroller() });
      this.collectWindow(state, Number.MAX_SAFE_INTEGER);
      const doc = this.docFromWindow(state);
      doc.note = 'via dom scrape';
      doc.exportedAt = CE.utils.today();
      return doc;
    },

    roleOf(el) {
      const marker = el.closest('user-query, model-response');
      if (marker) return marker.tagName === 'USER-QUERY' ? 'user' : 'assistant';
      return el.tagName === 'USER-QUERY' || /query/i.test(el.tagName) ? 'user' : 'assistant';
    },

    contentEl(turn) {
      return turn.querySelector('message-content, markdown-content, query-text, query-content, .query-text, .query-content') || turn;
    },

    parseTurn(el) {
      const role = this.roleOf(el);
      return { role, blocks: CE.extract.extractBlocks(this.contentEl(el)) };
    },

    doc() {
      return {
        title: CE.utils.cleanTitle('Gemini'),
        source: this.id,
        label: this.label,
        url: location.href,
        turns: this.turns().map((el) => this.parseTurn(el)).filter((t) => t.blocks.length),
      };
    },
  };
})();
