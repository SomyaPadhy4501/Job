'use strict';

// Checks the configured model against labeled postings before you turn AI
// tagging on. No database involved.
//
//   npm run tags:mina                                   (uses .env: MINA_*)
//   node src/scripts/preview-tags.js test/tag-examples.json out.json --model
//   node src/scripts/preview-tags.js test/tag-examples.json out.json --fixture
//
// --fixture answers with each example's expected label (checks the plumbing
// and validation without a model). Exits non-zero if any posting is
// unreadable or disagrees with its label; writes each verdict to out.json.

const fs = require('node:fs/promises');
const path = require('node:path');
const { classify } = require('../services/ai-tags');
const { stripHtml } = require('../services/normalize');

async function main() {
  const [input, output, mode] = process.argv.slice(2);
  if (!input || !output || !['--fixture', '--model'].includes(mode)) {
    throw new Error('Usage: node src/scripts/preview-tags.js input.json output.json --fixture|--model');
  }
  const examples = JSON.parse(await fs.readFile(input, 'utf8'));
  const fixture = mode === '--fixture';
  // eslint-disable-next-line global-require
  const options = fixture ? { model: 'fixture' } : require('../services/model-options').modelOptions();
  // With several MINA addresses, check each in order and use the first PC
  // that answers, as the collect run does.
  if (!fixture && options.mina) {
    // eslint-disable-next-line global-require
    const { probeEndpoint } = require('../services/ai-tagger');
    let chosen;
    for (const ep of options.endpoints) {
      const state = await probeEndpoint(ep, options.model);
      console.log(`MINA ${ep.label}: ${state}`);
      if (state === 'up') { chosen = ep; break; }
    }
    if (!chosen) throw new Error('No MINA address answered with this key and model.');
    Object.assign(options, { endpoint: chosen.endpoint, key: chosen.key });
  }
  const rows = examples.map((row) => ({ ...row, description: stripHtml(row.description || '') }));
  const byText = new Map(rows.map((row) => [row.description, row.expected]));
  const infer = fixture ? async (posting) => byText.get(posting.description) : undefined;

  const results = [];
  let failures = 0;
  for (const row of rows) {
    const started = Date.now();
    let tag;
    let problem = '';
    try {
      tag = await classify(row, options, infer);
      const e = row.expected;
      if (e && (tag.reason !== e.reason || tag.role_type !== e.role_type || (e.specialty && !tag.specialty))) {
        problem = `expected ${e.role_type} / ${e.reason}`;
      }
    } catch (err) {
      problem = err.message;
    }
    if (problem) failures++;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const got = tag ? `${tag.role_type} · ${tag.specialty || '-'} · ${tag.reason}` : 'no answer';
    console.log(`${problem ? 'FAIL' : 'ok  '} ${seconds.padStart(5)}s  ${row.job_title} → ${got}${problem ? `  (${problem})` : ''}`);
    results.push({ apply_url: row.apply_url, job_title: row.job_title, tag: tag || null, problem });
  }

  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ model: options.model, at: new Date().toISOString(), results }, null, 2));
  if (failures) throw new Error(`${failures} of ${rows.length} postings failed. Details: ${output}`);
  console.log(`Verified ${rows.length} postings with ${options.model}. Details: ${output}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
