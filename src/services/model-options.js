'use strict';

// Which model the AI tagger talks to.
//
// MINA (the default): MINA_BASE_URL is one address, or an ordered list of
// addresses (one per PC, each exposed with Tailscale Funnel), separated by
// commas or whitespace:
//   MINA_BASE_URL=https://devarshi-pc.tailefc5e0.ts.net/v1,https://grafton-pc.tailefc5e0.ts.net/v1
// The tagger uses the first one that answers and moves down the list when a
// PC goes offline (src/services/ai-tagger.js). Keys: MINA_API_KEY is shared
// by every address; MINA_API_KEYS (same order, same count) gives each PC its own.
//
// Generic provider: AI_MODEL_URL (full chat-completions URL) + AI_MODEL +
// optional AI_API_KEY. Setting AI_MODEL_URL selects it; it is one endpoint.

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const list = (value) => String(value || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

function minaEndpoint(raw) {
  let base;
  try {
    base = new URL(raw);
  } catch {
    throw new Error(`Invalid MINA_BASE_URL entry: ${raw}`);
  }
  if (base.protocol !== 'https:' && !(LOOPBACK.includes(base.hostname) && base.protocol === 'http:')) {
    throw new Error(`Use HTTPS or a loopback address for Mina: ${base.host}`);
  }
  if (base.username || base.password || base.search || base.hash) throw new Error(`Invalid MINA_BASE_URL entry: ${base.host}`);
  const root = base.pathname.replace(/\/+$/, '');
  return {
    endpoint: `${base.origin}${root}/chat/completions`,
    models: `${base.origin}${root}/models`,
    label: base.hostname.split('.')[0],
  };
}

function modelOptions(env = process.env) {
  if (env.AI_MODEL_URL) {
    if (!env.AI_MODEL) throw new Error('Configure AI_MODEL for AI_MODEL_URL');
    const endpoint = env.AI_MODEL_URL.trim();
    const key = env.AI_API_KEY?.trim() || undefined;
    return { endpoint, model: env.AI_MODEL.trim(), key,
      endpoints: [{ endpoint, key, label: new URL(endpoint).hostname.split('.')[0] }] };
  }
  const urls = list(env.MINA_BASE_URL);
  // Trimmed: a secret pasted or piped with a trailing newline would otherwise
  // make an invalid Authorization header.
  const shared = (env.MINA_API_KEY || '').trim();
  const perUrl = list(env.MINA_API_KEYS);
  if (!urls.length || (!shared && !perUrl.length)) throw new Error('Configure MINA_BASE_URL and MINA_API_KEY');
  if (perUrl.length && perUrl.length !== urls.length) {
    throw new Error(`MINA_API_KEYS has ${perUrl.length} keys for ${urls.length} MINA_BASE_URL addresses; give one key per address, in the same order`);
  }
  const endpoints = urls.map((url, i) => ({ ...minaEndpoint(url), key: perUrl[i] || shared }));
  const labels = new Set();
  for (const e of endpoints) {
    if (labels.has(e.endpoint)) throw new Error(`MINA_BASE_URL lists ${e.label} twice`);
    labels.add(e.endpoint);
  }
  // endpoint/key mirror the first address, for callers that use a single one
  // (src/scripts/preview-tags.js and older code paths).
  return { endpoint: endpoints[0].endpoint, key: endpoints[0].key, endpoints,
    model: env.MINA_MODEL?.trim() || 'qwen3:8b', mina: true, timeout: 90000, concurrency: 1 };
}

module.exports = { modelOptions };
