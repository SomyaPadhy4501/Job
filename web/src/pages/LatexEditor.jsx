import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EditorView, basicSetup } from 'codemirror';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { api, useAccount } from '../account.js';
import RequireAuth from '../components/RequireAuth.jsx';
import { acquireCompiler, firstError, lowMemoryDevice, missingFont, releaseCompiler, withLatinModern } from '../latex/engine.js';
import { fromProfile, TEMPLATE } from '../latex/fromProfile.js';

const PdfViewer = lazy(() => import('../components/PdfViewer.jsx'));

// /resumes/latex[?id=<resume>]: write or paste LaTeX, compile it in the
// browser, preview the PDF, save it as a resume. Reached by full page loads
// only: this path alone gets the CSP that lets the compiler run.
export default function LatexEditor() {
  return (
    <RequireAuth reason="Sign in to write your resume in LaTeX and keep it with your other resumes.">
      <Editor />
    </RequireAuth>
  );
}

const resumeIdFromUrl = () => new URLSearchParams(window.location.search).get('id') || '';
const draftKey = (userId, id) => `latex-draft:${userId}:${id || 'new'}`;
function readDraft(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeDraft(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked or full: drafts are only a convenience.
  }
}

function Editor() {
  const qc = useQueryClient();
  const { data: me } = useAccount();
  const userId = me?.user?.id || me?.user?.email || 'me';
  const [resumeId, setResumeId] = useState(resumeIdFromUrl);
  const [resume, setResume] = useState(null);
  const [savedSource, setSavedSource] = useState(null);
  const [source, setSource] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [title, setTitle] = useState('LaTeX resume');
  const [draftOffer, setDraftOffer] = useState(null);

  // Engine and compile state.
  const lowMem = lowMemoryDevice();
  const [engineWanted, setEngineWanted] = useState(!lowMem);
  const [engine, setEngine] = useState({ status: 'idle', detail: '' });
  const [pdf, setPdf] = useState(null);
  const [compiledFor, setCompiledFor] = useState(null);
  const [problem, setProblem] = useState(null);
  const [log, setLog] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [fontNote, setFontNote] = useState(false);
  const [save, setSave] = useState({ status: 'idle', message: '' });
  const compiling = useRef(false);
  const view = useRef(null);
  const editorBox = useRef(null);

  // Load the resume's source, or offer the starting points.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!resumeId) {
        const draft = readDraft(draftKey(userId, ''));
        if (draft) setDraftOffer(draft);
        return;
      }
      try {
        const [{ resume: r }, src] = await Promise.all([
          api(`/api/me/resumes/${resumeId}`),
          api(`/api/me/resumes/${resumeId}/source`),
        ]);
        if (cancelled) return;
        setResume(r);
        setTitle(r.title);
        setSavedSource(src.source);
        const draft = readDraft(draftKey(userId, resumeId));
        if (draft && draft !== src.source) setDraftOffer(draft);
        setSource(src.source);
      } catch (err) {
        if (!cancelled) setLoadError(err.status === 404 ? "This resume wasn't made in the LaTeX editor, or it's gone." : err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resumeId, userId]);

  // CodeMirror, created once the source is known.
  useEffect(() => {
    if (source === null || view.current || !editorBox.current) return undefined;
    view.current = new EditorView({
      doc: source,
      parent: editorBox.current,
      extensions: [
        basicSetup,
        StreamLanguage.define(stex),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setSource(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ 'aria-label': 'LaTeX source' }),
        // Pasting a whole document (with \documentclass) into one that has
        // one already replaces it, instead of nesting the two.
        EditorView.domEventHandlers({
          paste(event, v) {
            const pasted = event.clipboardData?.getData('text/plain') || '';
            const doc = v.state.doc.toString();
            const sel = v.state.selection.main;
            if (!/\\documentclass/.test(pasted) || !/\\documentclass/.test(doc) || (sel.from === 0 && sel.to === doc.length))
              return false;
            event.preventDefault();
            v.dispatch({ changes: { from: 0, to: doc.length, insert: pasted }, selection: { anchor: 0 } });
            return true;
          },
        }),
      ],
    });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // Only on first content: later edits flow from the editor itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source === null]);

  // Drafts: kept while typing, dropped once saved.
  useEffect(() => {
    if (source === null) return undefined;
    const t = setTimeout(() => writeDraft(draftKey(userId, resumeId), source === savedSource ? null : source), 800);
    return () => clearTimeout(t);
  }, [source, savedSource, userId, resumeId]);

  // The engine: loaded on desktop straight away, on phones only when asked.
  useEffect(() => {
    if (!engineWanted) return undefined;
    let alive = true;
    setEngine({ status: 'loading', detail: 'Downloading the LaTeX engine (about 15 MB the first time)…' });
    acquireCompiler((stage, detail) => {
      if (alive && stage === 'download') setEngine({ status: 'loading', detail: `Downloading the LaTeX engine… (${detail})` });
    })
      .then(() => alive && setEngine({ status: 'ready', detail: '' }))
      .catch((err) => alive && setEngine({ status: 'error', detail: err.message }));
    return () => {
      alive = false;
      releaseCompiler();
    };
  }, [engineWanted]);

  const compile = useCallback(async () => {
    if (compiling.current || source === null || engine.status !== 'ready') return;
    compiling.current = true;
    const text = source;
    setProblem(null);
    setSave((s) => (s.status === 'error' ? { status: 'idle', message: '' } : s));
    try {
      const compiler = await acquireCompiler();
      releaseCompiler();
      let result = await compiler.compile(text, { engine: 'pdflatex' });
      // The default fonts' symbols (\textbullet, ...) need cm-super, which
      // the in-browser TeX doesn't carry. Latin Modern looks the same and is
      // there: retry with it, without changing the user's source.
      let usedLatinModern = false;
      const fallback = !result.success && missingFont(result) ? withLatinModern(text) : null;
      if (fallback) {
        const retry = await compiler.compile(fallback, { engine: 'pdflatex' });
        if (retry.success) {
          result = retry;
          usedLatinModern = true;
        }
      }
      setFontNote(usedLatinModern);
      setLog(result.log || '');
      if (result.success && result.pdf) {
        setPdf(new Uint8Array(result.pdf));
        setCompiledFor(text);
      } else {
        const err = firstError(result) || { line: null, message: 'LaTeX stopped with an error.' };
        if (/^LaTeX Error: File `[^']+\.(?:sty|cls)' not found/.test(err.message))
          err.message += ' This package couldn’t be found in TeX Live 2026; check its name.';
        else if (/Font \S+ at \d+ not found/.test(err.message))
          err.message += ' A font is missing: with \\usepackage[T1]{fontenc}, also add \\usepackage{lmodern}.';
        setProblem({ ...err, for: text });
      }
    } catch (err) {
      setProblem({ line: null, message: err.message || "The compiler stopped.", for: text });
    } finally {
      compiling.current = false;
    }
  }, [source, engine.status]);

  // Compile 1.5 s after typing stops (desktop with the engine loaded).
  useEffect(() => {
    if (lowMem || engine.status !== 'ready' || source === null || source === compiledFor) return undefined;
    const t = setTimeout(compile, 1500);
    return () => clearTimeout(t);
  }, [source, engine.status, compiledFor, compile, lowMem]);

  function start(text) {
    setDraftOffer(null);
    setSource(text);
  }

  function jumpTo(line) {
    const v = view.current;
    if (!v || !line) return;
    const pos = v.state.doc.line(Math.min(line, v.state.doc.lines)).from;
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    v.focus();
  }

  async function saveResume() {
    if (!pdf || compiledFor !== source) return;
    setSave({ status: 'saving', message: '' });
    try {
      const form = new FormData();
      form.append('source', source);
      form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'resume.pdf');
      let r;
      if (resumeId) {
        const res = await api(`/api/me/resumes/${resumeId}/latex`, {
          method: 'PUT',
          form,
          headers: resume?.fileSha256 ? { 'If-Match': resume.fileSha256 } : {},
        });
        r = res.resume;
      } else {
        form.append('title', title.trim() || 'LaTeX resume');
        form.append('tags', '[]');
        const res = await api('/api/me/resumes', { method: 'POST', form });
        r = res.resume;
        writeDraft(draftKey(userId, ''), null);
        setResumeId(r.id);
        window.history.replaceState(null, '', `/resumes/latex?id=${r.id}`);
      }
      setResume(r);
      setSavedSource(source);
      writeDraft(draftKey(userId, r.id), null);
      qc.invalidateQueries({ queryKey: ['resumes'] });
      setSave({ status: 'saved', message: resumeId ? 'Saved. Your resume now uses this PDF.' : 'Saved as a new resume.' });
    } catch (err) {
      setSave({ status: 'error', message: err.message });
    }
  }

  async function saveSourceOnly() {
    if (!resumeId || source === null) return;
    setSave({ status: 'saving', message: '' });
    try {
      const res = await api(`/api/me/resumes/${resumeId}/source`, { method: 'PUT', body: { source } });
      setResume(res.resume);
      setSavedSource(source);
      writeDraft(draftKey(userId, resumeId), null);
      qc.invalidateQueries({ queryKey: ['resumes'] });
      setSave({ status: 'saved', message: 'Source saved. Compile and save again to update the PDF.' });
    } catch (err) {
      setSave({ status: 'error', message: err.message });
    }
  }

  async function startFromProfile() {
    try {
      const { profile } = await api('/api/me/profile');
      start(fromProfile(profile || {}));
    } catch (err) {
      setLoadError(err.message);
    }
  }

  const upToDate = pdf && compiledFor === source;
  // An error belongs to the text that produced it; undoing back to a good
  // version hides it.
  const shownProblem = problem && problem.for === source ? problem : null;
  const unsaved = source !== null && source !== savedSource;

  if (loadError) {
    return (
      <div className="card">
        <p className="error">{loadError}</p>
        <a className="btn btn-small btn-ghost" href="/resumes">Back to resumes</a>
      </div>
    );
  }

  return (
    <div className="latex-page">
      <div className="page-head latex-head">
        <h2>{resumeId ? `Edit “${resume?.title || '…'}”` : 'New LaTeX resume'}</h2>
        <a className="btn btn-small btn-ghost" href="/resumes">← Resumes</a>
      </div>

      {draftOffer && (
        <div className="notice">
          You have unsaved changes on this device.{' '}
          <button className="btn btn-small" onClick={() => { if (view.current) view.current.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: draftOffer } }); else start(draftOffer); setDraftOffer(null); }}>
            Restore them
          </button>{' '}
          <button className="btn btn-small btn-ghost" onClick={() => { writeDraft(draftKey(userId, resumeId), null); setDraftOffer(null); }}>
            Discard
          </button>
        </div>
      )}

      {source === null && !resumeId && (
        <div className="card latex-start">
          <h3>Start from</h3>
          <div className="row-actions">
            <button className="btn" onClick={startFromProfile}>My profile</button>
            <button className="btn btn-ghost" onClick={() => start(TEMPLATE)}>A blank template</button>
            <button className="btn btn-ghost" onClick={() => start('')}>Paste my own LaTeX</button>
          </div>
        </div>
      )}

      {source !== null && (
        <>
          <div className="latex-toolbar">
            {!resumeId && (
              <input className="title-input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} aria-label="Resume title" />
            )}
            <button className="btn btn-small" onClick={compile} disabled={engine.status !== 'ready' || compiling.current}>
              Compile
            </button>
            <button className="btn btn-small" onClick={saveResume} disabled={!upToDate || save.status === 'saving'}>
              {resumeId ? 'Save' : 'Save as resume'}
            </button>
            {resumeId && unsaved && (
              <button className="btn btn-small btn-ghost" onClick={saveSourceOnly} disabled={save.status === 'saving'}>
                Save source only
              </button>
            )}
            <span className="muted small" role="status">
              {engine.status === 'loading' && engine.detail}
              {engine.status === 'ready' && (upToDate ? (fontNote ? 'Preview is up to date (compiled with Latin Modern fonts, which look the same as the default ones).' : 'Preview is up to date.') : 'Compiling after you stop typing…')}
              {save.status === 'saving' && ' Saving…'}
            </span>
          </div>
          {save.message && <p className={save.status === 'error' ? 'error' : 'success'}>{save.message}</p>}
          {resume?.sourceStale && !unsaved && <p className="warn small">This resume's PDF is older than its source: compile and save to update it.</p>}

          <div className="latex-split">
            <div className="latex-editor" ref={editorBox} />
            <div className="latex-preview">
              {!engineWanted && (
                <div className="notice">
                  Compiling needs about 0.5 GB of memory, more than most phones have. You can edit and save the source here
                  and compile on a computer.{' '}
                  <button className="btn btn-small btn-ghost" onClick={() => setEngineWanted(true)}>Try anyway</button>
                </div>
              )}
              {engine.status === 'error' && (
                <p className="error">
                  {engine.detail} {resumeId ? 'Use “Save source only” to keep your changes.' : ''}
                </p>
              )}
              {shownProblem && (
                <div className="latex-problem">
                  <p className="error">
                    {shownProblem.line ? (
                      <button className="link-button" onClick={() => jumpTo(shownProblem.line)}>Line {shownProblem.line}</button>
                    ) : null}{' '}
                    {shownProblem.message}
                  </p>
                  <button className="btn btn-small btn-ghost" onClick={() => setShowLog((s) => !s)}>
                    {showLog ? 'Hide the log' : 'Show the log'}
                  </button>
                  {showLog && <pre className="latex-log">{log.slice(-6000)}</pre>}
                </div>
              )}
              {pdf ? (
                <Suspense fallback={<div className="skeleton skeleton-row" />}>
                  <PdfViewer data={pdf} label="Compiled resume" />
                </Suspense>
              ) : (
                engine.status === "ready" && !shownProblem && <p className="muted">The preview appears here after the first compile.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
