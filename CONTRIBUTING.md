# Contributing to Context Exporter

Thanks for helping. This document covers the two things contributors actually need: the intermediate document format that everything flows through, and how to fix or add a site adapter.

## Project structure

No build step, no dependencies to install. Plain JavaScript, loaded in the order declared in `manifest.json`.

```
manifest.json          MV3 manifest: permissions, content script wiring
background.js          Service worker: downloads, image fetching, preview handoff
content/
  common.js            Utilities, floating button UI, generic block extractor
  scroll.js            Lazy-history loader (scrolls to top until stable)
  main.js              Orchestrator: export flow, image embedding, popup messages
  adapter-*.js         One adapter per site (chatgpt.com, claude.ai, gemini.google.com)
exporters/
  markdown.js          Document -> markdown string
  html-doc.js          Document -> styled HTML (shared by Word and PDF paths)
  word.js              Word HTML + LaTeX approximator
  pdf.js               Thin wrapper; the PDF comes from Chrome's print dialog
preview/               Preview page that renders math with bundled KaTeX and prints
popup/                 Toolbar popup with the same three export options
vendor/katex/          Bundled KaTeX 0.19 (css, js, fonts) for the PDF path
```

## The intermediate document format

Every adapter produces this shape, and every exporter consumes it. Keeping this stable is what makes the system easy to maintain.

```js
{
  title: "Conversation title",       // cleaned of the site suffix
  source: "chatgpt",                 // adapter id
  label: "ChatGPT",                  // display name
  url: "https://chatgpt.com/...",    // conversation URL
  exportedAt: "2026-11-13",
  turns: [
    {
      role: "user" | "assistant",
      blocks: [
        { type: "html",  html: "<p>...</p>" },        // p, headings, lists, quotes, inline math tokens
        { type: "code",  lang: "python", text: "..." },
        { type: "table", html: "<table>...</table>" },
        { type: "image", src: "data:...|https:...", alt: "...", width: 640 },
        { type: "math",  tex: "x^2", display: true }, // standalone display math
      ]
    }
  ]
}
```

Inline math inside any `html` block is stored as `<span class="ce-math" data-tex="..." data-display="0|1"></span>`. Each exporter renders those tokens its own way: Markdown emits `$...$`/`$$...$$`, Word uses the approximator in `word.js`, and the PDF preview hydrates them with KaTeX.

## Patching an adapter when a site changes its DOM

This is the most common breakage and the easiest fix. Symptoms: zero messages exported, or only user messages, or empty output after a site redesign.

1. Open the site with DevTools and find:
   - the element that wraps one message/turn
   - how user and assistant turns differ (attribute, class, or tag)
   - which descendant holds the actual content (exclude headers, buttons, avatars)
2. Update only the relevant `adapter-*.js` file. The contract to satisfy:
   - `match()`: hostname check
   - `ready()`: truthy when a conversation is on the page
   - `turns()`: all turn elements in document order
   - `scroller()`: the scrollable ancestor that loads older messages
   - `parseTurn(el)`: `{ role, blocks }` using `CE.extract.extractBlocks(...)`
   - `doc()`: the intermediate document
3. Test: reload the extension at `chrome://extensions`, run all three export formats on a conversation that has code, a table, an image, and math if possible.
4. Keep the fix minimal. If the site now needs extra handling (for example new lazy-load buttons), put it in `scroll.js` only if all three sites benefit; otherwise keep it inside the adapter.

## Adding support for another site

Copy an existing adapter, follow the contract above, add a `content_scripts` entry in `manifest.json` with the same shared `js` list, and add host permissions for the site and its image CDN. Then add the site to the README table and the popup copy.

## Code style

- One comment only where the code cannot say why; no narration or banners.
- Keep everything defensive: a broken site must degrade to a warning toast, never an uncaught error.
- `vendor/` stays untouched; it is the bundled KaTeX release.

## Testing locally

`chrome://extensions` > Developer mode > Load unpacked > select this folder. After any change, click the reload icon on the extension card and refresh the chat tab. Check `node --check <file>` for syntax after editing, since there is no bundler to catch it for you.

Screenshots for the README: crop the browser chrome and blur profile avatars before committing, so tab titles, URLs, account chips, and installed extensions stay out of the repo.
