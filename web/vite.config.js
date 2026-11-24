import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// pdf.js loads character maps and the standard 14 fonts at run time. Copy
// them into public/pdfjs/ (git-ignored) so they're served from this origin,
// which the CSP's connect-src 'self' allows.
function pdfjsAssets() {
  const copy = () => {
    for (const dir of ['cmaps', 'standard_fonts']) {
      const from = fileURLToPath(new URL(`./node_modules/pdfjs-dist/${dir}`, import.meta.url));
      const to = fileURLToPath(new URL(`./public/pdfjs/${dir}`, import.meta.url));
      if (existsSync(from)) cpSync(from, to, { recursive: true });
    }
  };
  return { name: 'pdfjs-assets', buildStart: copy, configureServer: copy };
}

// The LaTeX engine's worker, at a fixed versioned path: vercel.json gives
// /siglum/* its own CSP (it runs the hash-checked engine from a blob: URL).
function siglumWorker() {
  const copy = () => {
    const pkg = JSON.parse(readFileSync(new URL('./node_modules/@siglum/engine/package.json', import.meta.url), 'utf8'));
    const from = fileURLToPath(new URL('./node_modules/@siglum/engine/src/worker.js', import.meta.url));
    const to = fileURLToPath(new URL(`./public/siglum/worker-${pkg.version}.js`, import.meta.url));
    if (existsSync(from)) cpSync(from, to);
  };
  return { name: 'siglum-worker', buildStart: copy, configureServer: copy };
}

// Dev server runs on 5173 and proxies API calls to the Express backend on
// whichever port run-all.sh picked (default 4000). Production build is pure
// static — served by the Express backend out of web/dist/.
//
// /api goes to the Rust dev server (`docker compose up api`, port 4100). It
// keeps the browser's Host header, because the Rust side checks that a
// request's Origin matches the host it was sent to.
//
// BOARD_API points the public read routes (/jobs, /companies, /stats) at
// another backend, e.g. the live site, so the account pages can be worked on
// without a local job database:
//   BOARD_API=https://job-two-xi.vercel.app npm run dev
// /admin always stays on the local backend.
const BOARD = process.env.BOARD_API || 'http://localhost:4000';

// `vite preview` sends the same headers as production (vercel.json), so a
// CSP problem shows up locally instead of only after a deploy. Header rule
// sources are regex-style paths ("/(.*)", "/((?!x/).*)").
function vercelHeaders() {
  const rules = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).headers || [];
  const compiled = rules.map((r) => ({ re: new RegExp(`^${r.source}$`), headers: r.headers }));
  return {
    name: 'vercel-headers',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '/').split('?')[0];
        for (const rule of compiled) {
          if (rule.re.test(path)) for (const h of rule.headers) res.setHeader(h.key, h.value);
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets(), siglumWorker(), vercelHeaders()],
  // Which Vercel environment built this ('production', 'preview', or '' locally).
  define: { __VERCEL_ENV__: JSON.stringify(process.env.VERCEL_ENV || ''), global: 'globalThis' },
  // Siglum (LaTeX engine) setup from its docs: its optional BLAKE3 entry
  // doesn't bundle, and one copy of its filesystem package.
  resolve: {
    alias: { 'blake3-wasm/browser.js': fileURLToPath(new URL('./src/latex/blake3-disabled.js', import.meta.url)) },
    dedupe: ['@siglum/filesystem'],
  },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  // Same /api proxy for `vite preview` (production build + production CSP).
  preview: { port: 4173, proxy: { '/api': { target: 'http://localhost:4100', changeOrigin: false } } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4100', changeOrigin: false },
      '/jobs': { target: BOARD, changeOrigin: true },
      '/stats': { target: BOARD, changeOrigin: true },
      '/companies': { target: BOARD, changeOrigin: true },
      '/health': { target: BOARD, changeOrigin: true },
      '/admin': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: {
    // pdf.js uses top-level await; Siglum is tested with esnext.
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
