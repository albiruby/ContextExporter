// Lazy-history loader: the three chat sites render old messages only when you
// scroll to the top, so we drive the scroller until the turn count settles.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});

  function findScroller(el) {
    let n = el;
    while (n && n !== document.body) {
      if (n instanceof HTMLElement) {
        const s = getComputedStyle(n);
        if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight - n.clientHeight > 120) return n;
      }
      n = n.parentElement;
    }
    return null;
  }

  const LOAD_MORE = /\b(show|load|see)\s+(more|earlier|older|previous)\b|previous\s+messages|earlier\s+(messages|chats)/i;

  // Only short button labels qualify; a "Show more" inside pasted content must not be clicked.
  function clickLoadMore(scope) {
    for (const b of scope.querySelectorAll('button')) {
      const t = (b.textContent || '').trim();
      if (t.length < 40 && LOAD_MORE.test(t) && !b.disabled) {
        b.click();
        return true;
      }
    }
    return false;
  }

  async function loadFullHistory({ count, scroller, onProgress, maxSteps = 150 }) {
    let prev = -1;
    let stable = 0;
    let growing = true;
    for (let step = 1; step <= maxSteps; step++) {
      const sc = scroller();
      if (sc) {
        try { sc.scrollTop = 0; } catch (e) { /* detached node */ }
      }
      clickLoadMore(sc || document.body);
      let c;
      if (growing) {
        // Poll only while batches are still arriving; once it settles, a
        // short wait is enough and the tail pass stays cheap.
        c = count();
        for (let t = 0; t < 12 && c === prev; t++) {
          await CE.utils.sleep(100);
          c = count();
        }
        await CE.utils.sleep(150);
      } else {
        await CE.utils.sleep(250);
      }
      c = count();
      growing = c !== prev;
      if (c === prev) stable++;
      else stable = 0;
      prev = c;
      if (onProgress) onProgress(c, step);
      if (stable >= 3 && (!sc || sc.scrollTop <= 2)) break;
      if (stable >= 5) break;
    }
    return prev;
  }

  // Cheap fingerprint of the turns currently mounted in the scroller. The
  // 2026 ChatGPT DOM keeps a persistent "Loading older messages" status
  // region even while idle, so text polling is unreliable; watching the turn
  // set itself is not.
  function turnSignature(sc) {
    const els = sc.querySelectorAll('[data-conversation-role], [data-turn-key]');
    let s = String(els.length);
    els.forEach((e) => {
      s += '|' + (e.getAttribute('data-turn-key')
        || e.getAttribute('data-chatgpt-search-unit-key') || '');
    });
    return s;
  }

  // Wait until the mounted turn set stops changing, so the harvest never
  // catches a half-swapped virtualization window. `signature` is supplied by
  // adapters with their own markers; `minTicks` gives slow loaders a floor.
  async function settleAfterScroll(sc, signature, minTicks) {
    const sig = signature || turnSignature;
    const min = typeof minTicks === 'number' ? minTicks : 1;
    let prev = sig(sc);
    let stable = 0;
    for (let t = 0; t < 24; t++) {
      await CE.utils.sleep(60);
      const now = sig(sc);
      if (t >= min && now === prev) {
        stable++;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      prev = now;
    }
    await CE.utils.sleep(40);
  }

  // Height of the mounted content band, so a step can be as large as the
  // site's own overscan allows instead of one viewport at a time.
  function bandHeight(sc, selector) {
    if (!selector) return 0;
    const els = sc.querySelectorAll(selector);
    let top = Infinity;
    let bottom = -Infinity;
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height > 0) {
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
    });
    return bottom > top ? bottom - top : 0;
  }

  // Virtualized-thread loader: only a window of turns exists in the DOM at a
  // time, so `count` never grows. Instead we harvest the current window at
  // every scroll step (bottom to top) and let the caller dedupe and order.
  async function loadVirtualized({
    scroller, collect, progressCount, onProgress,
    signature, spanSel, maxJump = 1.2, minTicks = 1, maxSteps = 400,
  }) {
    let sc = scroller();
    const settle = (node) => settleAfterScroll(node, signature, minTicks);
    if (sc) {
      try { sc.scrollTop = sc.scrollHeight; } catch (e) { /* detached */ }
      await settle(sc);
    }
    let stable = 0;
    for (let step = 1; step <= maxSteps; step++) {
      collect(step);
      if (onProgress && progressCount) onProgress(progressCount(), step);
      sc = scroller() || sc;
      if (!sc) break;
      const before = sc.scrollTop;
      const vh = sc.clientHeight || 600;
      let jump = Math.round(vh * 0.9);
      const band = bandHeight(sc, spanSel);
      if (band > vh) jump = Math.round(Math.min(band * 0.55, vh * maxJump));
      jump = Math.max(Math.round(vh * 0.9), jump);
      let moved = true;
      try {
        sc.scrollTop = Math.max(0, before - jump);
        moved = sc.scrollTop !== before;
      } catch (e) { moved = false; }
      if (before <= 0 || !moved) {
        stable++;
        if (stable >= 3) break;
      } else {
        stable = 0;
      }
      await settle(sc);
    }
  }

  CE.scroll = { findScroller, loadFullHistory, loadVirtualized };
})();
