// PDF exporter. The actual PDF is produced by Chrome's print dialog inside
// preview/preview.html; this file only builds the document to preview.

(function () {
  'use strict';

  const CE = (globalThis.CE = globalThis.CE || {});

  CE.exporters.pdf = {
    ext: 'pdf',
    mime: 'text/html',
    build(doc) {
      return CE.exporters.htmlDoc.build(doc, { word: false });
    },
  };
})();
