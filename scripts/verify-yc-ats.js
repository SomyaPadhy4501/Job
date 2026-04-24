#!/usr/bin/env node
'use strict';

// Verifies the output of probe-yc-ats.js before we add those entries to
// src/config.js::COMPANIES. The probe matches loose slug variants (name-dashed,
// flat, domain stem) and emits anything that returns jobs — but slugs like
// `beam`, `14`, `agency`, `apollo` collide with unrelated Greenhouse boards.
// Verification catches those collisions so the config stays clean.
//
// Strategy (per ATS):
//   greenhouse  Fetch /boards/{slug} → compare .name to displayName (normalized).
//               This is the highest-collision ATS; strict match required.
//   lever       Fetch /postings/{slug}?limit=5 → require the slug to be derivable
//               from the YC company name or website domain stem (which the probe
//               already tried). If yes + jobs exist, accept.
//   ashby       Same heuristic as lever. Ashby boards rarely collide.
//
// Writes two files:
//   scripts/yc-ats-verified.txt  — config-ready, can be pasted into src/config.js
//   scripts/yc-ats-rejected.txt  — with a short reason per rejection
//
// Usage:
//   node scripts/verify-yc-ats.js

const fs = require('fs');
const path = require('path');
const { loadUsHiringCompanies } = require('../src/collectors/yc_companies');
const { runWithConcurrency } = require('../src/collectors/http');

const INPUT = path.join(__dirname, 'yc-ats-discovered.txt');
const OUT_OK = path.join(__dirname, 'yc-ats-verified.txt');
const OUT_BAD = path.join(__dirname, 'yc-ats-rejected.txt');
const CONCURRENCY = 8;
const TIMEOUT_MS = 10_000;

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|corp|co|the|ai|io|app)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function slugVariantsFor(company) {
  const out = new Set();
  const add = (s) => {
    if (!s) return;
    const v = String(s).toLowerCase().trim();
    if (!/^[a-z0-9\-]+$/.test(v)) return;
    if (v.length < 2 || v.length > 40) return;
    out.add(v);
  };
  if (company.slug) add(company.slug);
  const nameDash = (company.name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (nameDash) add(nameDash);
  const nameFlat = nameDash.replace(/-/g, '');
  if (nameFlat) add(nameFlat);
  if (company.website) {
    try {
      const host = new URL(company.website).hostname.replace(/^www\./, '');
      const stem = host.split('.')[0];
      add(stem);
    } catch {}
  }
  return out;
}

async function quickJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'job-aggregator-verify/1.0', accept: 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(t);
    return null;
  }
}

function parseInput() {
  const raw = fs.readFileSync(INPUT, 'utf8');
  const entries = [];
  const re = /\{\s*source:\s*'([^']+)',\s*slug:\s*'([^']+)',\s*displayName:\s*'([^']+)'\s*\},?\s*(?:\/\/\s*(.*))?/g;
  let m;
  while ((m = re.exec(raw))) {
    entries.push({
      source: m[1],
      slug: m[2],
      displayName: m[3],
      comment: (m[4] || '').trim(),
    });
  }
  return entries;
}

async function verifyGreenhouse(entry, ycCompany) {
  // Authoritative: /boards/{slug}.name is the board owner's canonical name.
  const meta = await quickJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(entry.slug)}`
  );
  if (!meta || !meta.name) return { ok: false, reason: 'no-meta' };
  const boardNorm = normName(meta.name);
  const ycNorm = normName(ycCompany?.name || entry.displayName);
  if (boardNorm === ycNorm) return { ok: true, boardName: meta.name };
  // Also accept "<YC Name> Careers" / "Jobs" / etc. — boards that suffix a
  // generic HR word. Strict: the remainder must be purely generic, so
  // "Apollo Education Systems" stays rejected while "HackerRank Careers" passes.
  const GENERIC_SUFFIX = /^(careers?|jobs?|hiring|team|recruiting|hr|board)$/i;
  const tokens = meta.name.trim().split(/\s+/);
  if (tokens.length >= 2) {
    const firstNorm = normName(tokens[0]);
    const restAllGeneric = tokens.slice(1).every((t) => GENERIC_SUFFIX.test(t));
    if (restAllGeneric && firstNorm === ycNorm) return { ok: true, boardName: meta.name };
  }
  return { ok: false, reason: `name-mismatch: board="${meta.name}" yc="${entry.displayName}"` };
}

// Lever/Ashby don't expose owner metadata via public API. Fall back to
// provenance: if the slug is derivable from the YC company name or website
// (same variants the probe uses), trust it. If the slug is an arbitrary word
// not derivable from the YC entity, we can't confirm ownership — reject.
function verifyByProvenance(entry, ycCompany) {
  if (!ycCompany) return { ok: false, reason: 'no-yc-match' };
  const variants = slugVariantsFor(ycCompany);
  if (variants.has(entry.slug.toLowerCase())) return { ok: true };
  return {
    ok: false,
    reason: `slug "${entry.slug}" not derivable from YC name/website "${ycCompany.name}" / "${ycCompany.website || ''}"`,
  };
}

async function verifyLever(entry, ycCompany) {
  // Cheap existence sanity check + provenance check.
  const prov = verifyByProvenance(entry, ycCompany);
  if (!prov.ok) return prov;
  const data = await quickJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(entry.slug)}?mode=json&limit=1`
  );
  if (!Array.isArray(data) || data.length === 0) return { ok: false, reason: 'no-postings' };
  return { ok: true };
}

async function verifyAshby(entry, ycCompany) {
  const prov = verifyByProvenance(entry, ycCompany);
  if (!prov.ok) return prov;
  const data = await quickJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(entry.slug)}`
  );
  if (!data || !Array.isArray(data.jobs) || data.jobs.length === 0) {
    return { ok: false, reason: 'no-postings' };
  }
  return { ok: true };
}

async function main() {
  const entries = parseInput();
  process.stderr.write(`loaded ${entries.length} candidate entries\n`);

  const { byName } = await loadUsHiringCompanies();
  // Build a more permissive name index: normalize displayName with normName
  // (strips AI/IO/Inc etc) and look for any YC company that normalizes the same.
  const ycByNorm = new Map();
  for (const [, yc] of byName) {
    const key = normName(yc.name);
    if (key && !ycByNorm.has(key)) ycByNorm.set(key, yc);
  }

  function findYc(displayName) {
    const n = normName(displayName);
    return ycByNorm.get(n) || null;
  }

  const started = Date.now();
  const results = await runWithConcurrency(entries, CONCURRENCY, async (entry) => {
    const yc = findYc(entry.displayName);
    try {
      if (entry.source === 'greenhouse') return { entry, yc, ...(await verifyGreenhouse(entry, yc)) };
      if (entry.source === 'lever') return { entry, yc, ...(await verifyLever(entry, yc)) };
      if (entry.source === 'ashby') return { entry, yc, ...(await verifyAshby(entry, yc)) };
      return { entry, yc, ok: false, reason: 'unknown-source' };
    } catch (e) {
      return { entry, yc, ok: false, reason: `err:${e.message}` };
    }
  });

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  process.stderr.write(
    `verified in ${Math.round((Date.now() - started) / 1000)}s — pass:${ok.length} fail:${bad.length}\n`
  );

  // Emit config-ready verified block grouped by source.
  const lines = [];
  for (const src of ['greenhouse', 'lever', 'ashby']) {
    const list = ok
      .filter((r) => r.entry.source === src)
      .sort((a, b) => a.entry.displayName.localeCompare(b.entry.displayName));
    lines.push(`\n// ─── ${src} (${list.length} verified YC companies) ───`);
    for (const r of list) {
      const name = r.entry.displayName.replace(/'/g, "\\'");
      lines.push(
        `  { source: '${src}', slug: '${r.entry.slug}', displayName: '${name}' }, // ${r.entry.comment}`
      );
    }
  }
  fs.writeFileSync(OUT_OK, lines.join('\n') + '\n');

  const badLines = bad
    .sort((a, b) => a.entry.source.localeCompare(b.entry.source) || a.entry.slug.localeCompare(b.entry.slug))
    .map((r) => `[${r.entry.source}] ${r.entry.slug} (${r.entry.displayName}) — ${r.reason}`);
  fs.writeFileSync(OUT_BAD, badLines.join('\n') + '\n');

  process.stderr.write(
    `\nverified -> ${path.relative(process.cwd(), OUT_OK)}\n` +
      `rejected -> ${path.relative(process.cwd(), OUT_BAD)}\n`
  );
}

main().catch((e) => {
  console.error('verify failed:', e);
  process.exit(1);
});
