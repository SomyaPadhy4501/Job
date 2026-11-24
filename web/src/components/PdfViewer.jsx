import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Draws a PDF to canvases, page by page, at the container's width. pdf.js
// runs in a same-origin worker and never evaluates code from the file
// (isEvalSupported: false), so it works under the site's strict CSP, and on
// phones, where PDFs in iframes usually download instead of showing.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSETS = {
  // Copied into /pdfjs/ by the pdfjs-assets plugin in vite.config.js.
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  isEvalSupported: false,
};
const MAX_PAGES = 10;

/**
 * @param {{ data: Blob | ArrayBuffer | Uint8Array | null, label?: string }} props
 * `data` is the PDF's bytes. A new value re-renders and frees the old document.
 */
export default function PdfViewer({ data, label = 'Resume preview' }) {
  const box = useRef(null);
  const [state, setState] = useState({ status: 'loading', pages: 0, error: '' });

  useEffect(() => {
    if (!data) return undefined;
    let cancelled = false;
    let doc = null;
    let task = null;
    const host = box.current;
    (async () => {
      setState({ status: 'loading', pages: 0, error: '' });
      try {
        const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
        task = pdfjs.getDocument({ data: bytes, ...ASSETS });
        doc = await task.promise;
        if (cancelled) return;
        const width = Math.max(240, host.clientWidth || 600);
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const canvases = [];
        const count = Math.min(doc.numPages, MAX_PAGES);
        for (let n = 1; n <= count; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
          canvas.className = 'pdf-page';
          canvas.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`);
          canvas.setAttribute('role', 'img');
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          if (cancelled) return;
          canvases.push(canvas);
        }
        host.replaceChildren(...canvases);
        setState({ status: 'ready', pages: doc.numPages, error: '' });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', pages: 0, error: err?.message || 'Could not show this PDF.' });
      }
    })();
    return () => {
      cancelled = true;
      host?.replaceChildren();
      task?.destroy();
      doc?.destroy();
    };
  }, [data]);

  return (
    <div className="pdf-viewer" aria-label={label} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' && <div className="skeleton skeleton-row" />}
      {state.status === 'error' && <p className="error">Couldn't show this PDF: {state.error}</p>}
      <div ref={box} className="pdf-pages" />
      {state.pages > MAX_PAGES && (
        <p className="muted small">Showing the first {MAX_PAGES} of {state.pages} pages. Download the file to see the rest.</p>
      )}
    </div>
  );
}
