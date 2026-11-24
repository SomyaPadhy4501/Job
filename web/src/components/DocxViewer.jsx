import { useEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';

// Renders a Word resume as HTML inside a shadow root, so its styles can't
// leak into the page. Images become data: URLs (the CSP allows data: images,
// not blob:), and no script in the file can run (the CSP has no inline scripts).
export default function DocxViewer({ data }) {
  const host = useRef(null);
  const [state, setState] = useState({ status: 'loading', error: '' });

  useEffect(() => {
    if (!data) return undefined;
    let cancelled = false;
    const el = host.current;
    const root = el.shadowRoot || el.attachShadow({ mode: 'open' });
    root.replaceChildren();
    setState({ status: 'loading', error: '' });
    const style = document.createElement('div');
    const body = document.createElement('div');
    const base = document.createElement('style');
    // Fit the page to the panel instead of a fixed paper width.
    base.textContent =
      ':host{display:block}.docx-wrapper{background:#f3f4f6!important;padding:12px!important}' +
      '.docx-wrapper>section.docx{width:100%!important;max-width:100%!important;min-height:0!important;' +
      'padding:24px!important;box-sizing:border-box;margin:0 0 12px!important;box-shadow:0 1px 3px rgba(0,0,0,.12)}';
    root.append(base, style, body);
    renderAsync(data, body, style, {
      inWrapper: true,
      ignoreWidth: true,
      ignoreHeight: true,
      useBase64URL: true,
      renderAltChunks: false,
      experimental: false,
    })
      .then(() => !cancelled && setState({ status: 'ready', error: '' }))
      .catch((err) => !cancelled && setState({ status: 'error', error: err?.message || 'Could not show this file.' }));
    return () => {
      cancelled = true;
      root.replaceChildren();
    };
  }, [data]);

  return (
    <div className="docx-viewer" aria-busy={state.status === 'loading'}>
      {state.status === 'loading' && <div className="skeleton skeleton-row" />}
      {state.status === 'error' && <p className="error">Couldn't show this file: {state.error}</p>}
      <div ref={host} aria-label="Resume preview" />
    </div>
  );
}
