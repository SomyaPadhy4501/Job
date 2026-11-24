import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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

export default defineConfig({
  plugins: [react()],
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
    outDir: 'dist',
    emptyOutDir: true,
  },
});
