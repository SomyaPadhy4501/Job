// The in-browser LaTeX compiler (Siglum, TeX Live 2026, pdfLaTeX).
//
// The resume never leaves the browser. Only the engine and TeX's own files
// come from Siglum's runtime host, pinned to one release. The engine's code
// (busytex.js and busytex.wasm, plus xzwasm.js) runs on this origin, so it would
// have this site's session: both files are checked against the SHA-256s
// below before they run, and handed to the compiler as blob: URLs. A file
// that doesn't match is never run. Bundles are TeX data, read by the engine.
//
// To move to a new Siglum release: update the npm package, then RELEASE and
// the two hashes from that release's runtime.json (files "wasm/busytex.js"
// and "wasm/busytex.wasm"), and the worker path in vercel.json if needed.
import { SiglumCompiler } from '@siglum/engine';

export const RUNTIME_HOST = 'https://packages.siglum.org';
const RELEASE = 'tl2026-0cc2592f50103429';
const BASE = `${RUNTIME_HOST}/releases/${RELEASE}`;
const PINNED = {
  js: ['wasm/busytex.js', '036ecf65da27d4ac611d2864d60b3422af17d6093f386c260675e53c52c55636', 'text/javascript'],
  wasm: ['wasm/busytex.wasm', '76646057f2178846311c3ed121a0028ccf7e647f01a5df2d1d3b1523446d49f1', 'application/wasm'],
  // Unpacks TeX Live packages (.tar.xz) fetched on demand; runs on this page.
  xz: ['xzwasm.js', 'f71eb30bb46d258e5d67c77033e949e9feff75ff6beaac5e4f8d54fb5aa5e5ff', 'text/javascript'],
};
// Must equal the installed @siglum/engine version (package.json pins it):
// the siglum-worker plugin in vite.config.js copies the worker there.
const ENGINE_VERSION = '0.2.2';
const WORKER_URL = `/siglum/worker-${ENGINE_VERSION}.js`;

async function sha256(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verified([path, expected, type], onProgress) {
  const url = `${BASE}/${path}`;
  let cache = null;
  let bytes = null;
  try {
    cache = await caches.open(`latex-engine-${RELEASE}`);
    const hit = await cache.match(url);
    if (hit) bytes = await hit.arrayBuffer();
  } catch {
    // No Cache Storage (private window): download every time.
  }
  if (!bytes || (await sha256(bytes)) !== expected) {
    onProgress?.('download', path);
    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch {
      throw new Error("Couldn't download the LaTeX engine. Check your connection, or save the source and compile later.");
    }
    if (!res.ok) throw new Error(`Couldn't download the LaTeX engine (HTTP ${res.status}). Save the source and compile later.`);
    bytes = await res.arrayBuffer();
    if ((await sha256(bytes)) !== expected)
      throw new Error("The LaTeX engine's files didn't match their checksum, so they weren't run.");
    try {
      await cache?.put(url, new Response(bytes, { headers: { 'Content-Type': type } }));
    } catch {
      // Cache full or blocked: fine, it downloads again next time.
    }
  }
  return URL.createObjectURL(new Blob([bytes], { type }));
}

// One compiler for the whole page, shared across React's double mounts and
// freed a few seconds after the last user lets go.
let shared = null;
let users = 0;
let unloadTimer = null;

export function acquireCompiler(onProgress) {
  users++;
  clearTimeout(unloadTimer);
  if (!shared) {
    shared = (async () => {
      const [jsUrl, wasmUrl, xzwasmUrl] = await Promise.all([
        verified(PINNED.js, onProgress),
        verified(PINNED.wasm, onProgress),
        verified(PINNED.xz, onProgress),
      ]);
      const compiler = new SiglumCompiler({
        workerUrl: WORKER_URL,
        jsUrl,
        wasmUrl,
        bundlesUrl: `${BASE}/bundles`,
        // Packages that aren't bundled come from the same pinned release as
        // TeX Live archives (data, unpacked by the hash-checked xzwasm.js).
        ctanProxyUrl: BASE,
        xzwasmUrl,
        enableCtan: true,
        maxRetries: 5,
        onProgress: (stage, detail) => onProgress?.(stage, detail),
      });
      onProgress?.('init', '');
      await compiler.init();
      return compiler;
    })().catch((err) => {
      shared = null;
      throw err;
    });
  }
  return shared;
}

export function releaseCompiler() {
  users = Math.max(0, users - 1);
  if (users) return;
  clearTimeout(unloadTimer);
  unloadTimer = setTimeout(async () => {
    if (users || !shared) return;
    const pending = shared;
    shared = null;
    const compiler = await pending.catch(() => null);
    compiler?.unload?.();
  }, 3000);
}

// "/document.tex:8: Undefined control sequence." → { line: 8, message }.
export function firstError(result) {
  const text = result?.error || '';
  const log = result?.log || '';
  const fromError = /:(\d+):\s*(.+)/.exec(text);
  const bang = /^! (.+)$/m.exec(log);
  const at = /^l\.(\d+)/m.exec(log);
  // "Emergency stop" only says TeX gave up; the log's "!" line says why.
  if (bang && (!fromError || /emergency stop|fatal error/i.test(fromError[2])))
    return { line: fromError ? Number(fromError[1]) : at ? Number(at[1]) : null, message: bang[1].trim() };
  if (fromError) return { line: Number(fromError[1]), message: fromError[2].trim() };
  return text ? { line: null, message: text } : null;
}

/** "Font tcrm1000 at 600 not found": a font only cm-super has. */
export function missingFont(result) {
  return /Font \S+ at \d+ not found/.test(`${result?.error || ''}\n${result?.log || ''}`);
}

/** The source with \usepackage{lmodern} after \documentclass, or null when
 * it already loads lmodern or has no \documentclass. */
export function withLatinModern(text) {
  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\blmodern\b[^}]*\}/.test(text)) return null;
  const m = /\\documentclass(?:\[[^\]]*\])?\{[^}]*\}/.exec(text);
  if (!m) return null;
  const at = m.index + m[0].length;
  return `${text.slice(0, at)}\n\\usepackage{lmodern}${text.slice(at)}`;
}

/** Phones and small devices: compiling needs ~0.5 GB of memory. */
export function lowMemoryDevice() {
  const ios = /iP(?:hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios || (navigator.deviceMemory !== undefined && navigator.deviceMemory < 4);
}
