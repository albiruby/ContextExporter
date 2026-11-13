// Preview page: receives the generated HTML from the service worker, renders
// the math tokens with the bundled KaTeX, shows it in an iframe, and prints
// the iframe so the toolbar never ends up in the PDF.

(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const printBtn = document.getElementById('printBtn');
  const frame = document.getElementById('frame');

  const id = new URLSearchParams(location.search).get('id');

  chrome.runtime.sendMessage({ type: 'getExport', id }, (res) => {
    if (chrome.runtime.lastError || !res || !res.html) {
      statusEl.textContent = 'Preview expired. Run the export again.';
      return;
    }
    render(res.html);
  });

  function render(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const hasKatex = !!(window.katex && window.katex.renderToString);
    doc.querySelectorAll('.ce-math').forEach((el) => {
      const tex = el.getAttribute('data-tex') || '';
      const display = el.getAttribute('data-display') === '1';
      if (!hasKatex) {
        el.replaceWith(doc.createTextNode(tex));
        return;
      }
      try {
        const holder = doc.createElement(display ? 'div' : 'span');
        holder.className = display ? 'ce-math-display' : '';
        holder.innerHTML = window.katex.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
        });
        el.replaceWith(...holder.childNodes);
      } catch (e) {
        // A malformed formula must not blank the whole preview.
        el.replaceWith(doc.createTextNode(tex));
      }
    });

    if (hasKatex) {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('vendor/katex/katex.min.css');
      doc.head.appendChild(link);
    } else {
      statusEl.textContent = 'Math renderer missing; formulas show as LaTeX source.';
    }

    frame.srcdoc = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  }

  frame.addEventListener('load', () => {
    statusEl.textContent = 'Ready. Pick "Save as PDF" in the print dialog.';
    printBtn.disabled = false;
    autoPrint();
  });

  let printed = false;

  function autoPrint() {
    // One silent auto-print: fonts settle first so math embeds correctly.
    const fontsReady = frame.contentDocument && frame.contentDocument.fonts
      ? frame.contentDocument.fonts.ready
      : Promise.resolve();
    Promise.race([
      fontsReady,
      new Promise((r) => setTimeout(r, 2000)),
    ]).then(() => {
      setTimeout(() => print(), 400);
    });
  }

  function print() {
    if (printed) return;
    printed = true;
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      statusEl.textContent = 'Print failed. Use the button to try again.';
    }
  }

  printBtn.addEventListener('click', () => {
    printed = false;
    print();
  });
})();
