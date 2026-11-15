// Export ranges: presets for trimming a gathered conversation to the last
// few days. Sites that expose message timestamps (ChatGPT, Claude through
// their APIs) get real filtering; DOM-only harvests have no clock, so the
// caller must refuse a range instead of silently exporting everything.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});

  // tag is appended to the download name, so it stays URL-safe.
  const OPTIONS = [
    { id: 'all', label: 'All time', days: 0, tag: '' },
    { id: '1d', label: 'Today', days: 1, tag: 'today' },
    { id: '3d', label: 'Last 3 days', days: 3, tag: 'last-3-days' },
    { id: '5d', label: 'Last 5 days', days: 5, tag: 'last-5-days' },
    { id: '7d', label: 'Last 7 days', days: 7, tag: 'last-7-days' },
    { id: '14d', label: 'Last 2 weeks', days: 14, tag: 'last-2-weeks' },
    { id: '21d', label: 'Last 3 weeks', days: 21, tag: 'last-3-weeks' },
    { id: '30d', label: 'Last 30 days', days: 30, tag: 'last-30-days' },
  ];

  function option(id) {
    return OPTIONS.find((o) => o.id === id) || OPTIONS[0];
  }

  // Calendar days, not a rolling 24h window: "Last 7 days" is today plus the
  // six days before it, starting at local midnight.
  function sinceFor(id, now) {
    const o = option(id);
    if (!o.days) return null;
    const ref = now instanceof Date ? now : new Date();
    const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
    start.setDate(start.getDate() - (o.days - 1));
    return start.getTime();
  }

  function dayLabel(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function describe(id, since) {
    const o = option(id);
    if (!o.days || typeof since !== 'number') return null;
    return `${o.label} (since ${dayLabel(since)})`;
  }

  // A missing timestamp inherits the previous known one, so one gap in the
  // backend payload does not split the range.
  function timeline(turns) {
    let last = null;
    return turns.map((t) => {
      if (t && typeof t.time === 'number' && Number.isFinite(t.time)) last = t.time;
      return last;
    });
  }

  // Returns null when the range cannot be honored (no timestamps at all),
  // otherwise { turns, since, dropped }.
  function apply(turns, id) {
    const since = sinceFor(id);
    if (since === null) return { turns, since: null, dropped: 0 };

    const times = timeline(turns);
    if (!times.some((t) => typeof t === 'number')) return null;

    const first = times.findIndex((t) => typeof t === 'number' && t >= since);
    if (first === -1) return { turns: [], since, dropped: turns.length };

    let start = first;
    // Starting on a reply would export an answer without its question.
    if (turns[start] && turns[start].role === 'assistant'
      && start > 0 && turns[start - 1].role === 'user') {
      start -= 1;
    }
    return { turns: turns.slice(start), since, dropped: start };
  }

  CE.ranges = { OPTIONS, option, sinceFor, describe, apply };
})();
