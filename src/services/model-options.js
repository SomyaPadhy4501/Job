'use strict';

// Keep generic provider credentials separate from the project-scoped Mina key.
function modelOptions(env = process.env) {
  if (env.AI_MODEL_URL) {
    if (!env.AI_MODEL) throw new Error('Configure AI_MODEL for AI_MODEL_URL');
    return { endpoint: env.AI_MODEL_URL, model: env.AI_MODEL, key: env.AI_API_KEY };
  }
  // Trimmed: a secret pasted or piped with a trailing newline would otherwise
  // make an invalid Authorization header.
  const key = (env.MINA_API_KEY || '').trim();
  if (!env.MINA_BASE_URL?.trim() || !key) throw new Error('Configure MINA_BASE_URL and MINA_API_KEY');
  const base = new URL(env.MINA_BASE_URL.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) {
    throw new Error('Use HTTPS or a loopback address for Mina');
  }
  if (base.username || base.password || base.search || base.hash) throw new Error('Invalid MINA_BASE_URL');
  base.pathname = base.pathname.replace(/\/+$/, '') + '/chat/completions';
  return { endpoint: base.href, model: env.MINA_MODEL?.trim() || 'qwen3:8b', key,
    mina: true, timeout: 90000, concurrency: 1 };
}

module.exports = { modelOptions };
