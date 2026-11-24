// Siglum's optional BLAKE3 hashing has a broken browser entry; the engine
// falls back to its own change-detection hash. See vite.config.js.
throw new Error('BLAKE3 acceleration disabled in this build');
export function hash() {}
