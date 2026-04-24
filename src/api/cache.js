'use strict';

const { CONFIG } = require('../config');

// Tiny TTL cache for GET /jobs responses.
class TtlCache {
  constructor(ttlMs) {
    this.ttl = ttlMs;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }
  set(key, value) {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttl });
  }
  clear() {
    this.map.clear();
  }
}

const jobsCache = new TtlCache(CONFIG.cacheTtlMs);

module.exports = { jobsCache };
