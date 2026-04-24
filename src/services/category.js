'use strict';

// Very simple classifier: either a job is from a startup (YC or HN hiring)
// or it isn't. We return 'STARTUP' or null — no Big Tech / Mid / Small
// buckets, since size-only distinctions didn't add much signal and the
// hand-curated lists were impossible to keep current.
//
// STARTUP criteria (any one triggers it):
//   1. Source is `hn_hiring` — the collector already filters to YC US-hiring
//      companies via the akshaybhalotia/yc_company_scraper feed.
//   2. Company name matches a slug in STARTUP_SLUGS below — the list is
//      auto-extracted from `src/config.js` sections that came from the
//      YC ATS probe (scripts/probe-yc-ats.js) and the topstartups.io probe
//      (scripts/probe-topstartups.js). Regenerate via:
//        node scripts/extract-startup-slugs.js  (see HANDOFF.md)

function normSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|pbc|gmbh|plc|bv|ag)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Auto-generated from YC + topstartups config sections. 635 companies.
const STARTUP_SLUGS = new Set([
  'abacum', 'abridge', 'accord', 'afterquery',
  'agave', 'agentmail', 'aiprise', 'airgoods',
  'airtable', 'akasa', 'alchemy', 'aleph',
  'algolia', 'allium', 'alloy', 'alluxio',
  'alpaca', 'ambience-healthcare', 'amplitude', 'anara',
  'anchorage', 'anduril-industries', 'anyscale', 'apolink',
  'apollo-io', 'applied-intuition', 'archil', 'arini',
  'arketa', 'armory', 'artie', 'artisan',
  'ashby', 'asimov', 'assembly', 'assemblyai',
  'astranis', 'astro-mechanica', 'atlas', 'atob',
  'atomic', 'atomic-industries', 'attain', 'attentive',
  'attune', 'auctor', 'aurelian', 'authzed',
  'automat', 'aviator', 'avoca', 'axle',
  'axle-health', 'axonius', 'bankjoy', 'base-power',
  'basis', 'belong', 'benchling', 'benepass',
  'bettercloud', 'betterment', 'bigid', 'bild-ai',
  'billiontoone', 'biofourmis', 'bitmovin', 'bland-ai',
  'blaxel', 'blee', 'blend', 'blink',
  'blissway', 'blueberry-pediatrics', 'boostly', 'bootloop',
  'brainbase-labs', 'branch', 'brightwheel', 'broccoli-ai',
  'built-robotics', 'bunch', 'bunkerhill-health', 'camber',
  'cambio', 'cambly', 'cameo', 'campfire',
  'canary-technologies', 'candid', 'candid-health', 'capitolis',
  'captivateiq', 'capy', 'carbon', 'carta',
  'casca', 'castle', 'cedar', 'celonis',
  'centivo', 'central', 'cents', 'chainguard',
  'charge-robotics', 'charthop', 'checkr', 'chestnut',
  'chief', 'cinder', 'clari', 'clarion',
  'classdojo', 'clickhouse', 'clickup', 'clipboard',
  'cloudtrucks', 'clover-health', 'coast', 'cobalt-robotics',
  'cockroach-labs', 'coco', 'coder', 'codes-health',
  'cognition', 'collective-health', 'complete', 'concourse',
  'conductor', 'conduit', 'conduktor', 'confido',
  'confluent', 'continue', 'coperniq', 'corgi',
  'cortex', 'corvus-robotics', 'cosine', 'coursera',
  'credal-ai', 'cresta', 'ctgt', 'culdesac',
  'curri', 'dashlane', 'daybreak-health', 'decagon',
  'decoda-health', 'deel', 'deepgram', 'delve',
  'descript', 'devrev', 'dex', 'dialpad',
  'digital-ai', 'diligencesquared', 'disco', 'distro',
  'ditto', 'dolls-kill', 'domino-data-lab', 'doola',
  'doppler', 'dots', 'doxel', 'dronedeploy',
  'druva', 'dyneti-technologies', 'dyno-therapeutics', 'earnin',
  'egenesis', 'eight-sleep', 'ekho', 'electric-ai',
  'ello', 'eloquent-ai', 'ema', 'embrace',
  'empirical-health', 'envoy', 'epic-games', 'epsilon3',
  'ethos-life', 'eventual', 'everlaw', 'exa',
  'extend', 'faire', 'fathom', 'fern',
  'fieldguide', 'finch', 'finix', 'finni-health',
  'finvest', 'fireblocks', 'firecrawl', 'fireworks-ai',
  'firstbase-io', 'fivetran', 'fleek', 'fleetline',
  'fleetworks', 'fleetzero', 'flexport', 'flint',
  'flock-homes', 'flowtel', 'flutterflow', 'formation-bio',
  'forter', 'fortuna-health', 'forward-networks', 'foundry',
  'foursquare', 'freenome', 'freshpaint', 'fullstory',
  'furtherai', 'garage', 'gecko-robotics', 'general-proximity',
  'giga-ml', 'gigs', 'ginkgo-bioworks', 'givecampus',
  'glimpse', 'glossgenius', 'glossier', 'goldbelly',
  'golinks', 'gong-io', 'good-eggs', 'govdash',
  'goveagle', 'graphite', 'greenboard', 'greptile',
  'gridware', 'gusto', 'h1', 'hackerrank',
  'handoff', 'handshake', 'harmonic', 'harper',
  'harvey', 'hatch', 'hebbia', 'hermeus',
  'heron-data', 'heygen', 'hightouch', 'hinge-health',
  'hockeystack', 'homebase', 'homebound', 'honor',
  'hotplate', 'houzz', 'hud', 'hudl',
  'hudu', 'human-interest', 'hyperbound', 'hyperscience',
  'illumio', 'imply', 'incorta', 'infinite',
  'infinite-machine', 'infinitus', 'infisical', 'influxdata',
  'inkeep', 'insitro', 'instabase', 'instawork',
  'intercom', 'invert', 'invoca', 'jeeves',
  'juicebox', 'julius', 'juno', 'kalshi',
  'kapwing', 'karius', 'kernel', 'keystone',
  'kiddom', 'kingdom', 'knoetic', 'knowtex',
  'kodex', 'komodo-health', 'kong', 'kymera-therapeutics',
  'labelbox', 'langchain', 'latent', 'lattice',
  'launchdarkly', 'layup', 'leaflink', 'legalist',
  'legion-health', 'lemonade', 'lessen', 'level',
  'lightship', 'listen-labs', 'liveflow', 'living-carbon',
  'lob', 'loula', 'loyal', 'lucid-bots',
  'luminai', 'luxury-presence', 'mach9', 'magic-patterns',
  'maintainx', 'manychat', 'marqvision', 'mashgin',
  'matik', 'maven-clinic', 'maverickx', 'may-mobility',
  'meadow', 'medium', 'mednet', 'melio',
  'mem0', 'meru-health', 'metriport', 'middesk',
  'mintlify', 'misfits-market', 'mixpanel', 'modal',
  'modern-animal', 'modern-health', 'modern-treasury', 'momence',
  'mosaic', 'motion', 'moveworks', 'multiply-labs',
  'mutiny', 'mux', 'nabis', 'nabla-bio',
  'nango', 'nanonets', 'narvar', 'nash',
  'navier-ai', 'netlify', 'netomi', 'netskope',
  'neuralink', 'new-story', 'newfront', 'newlimit',
  'nimblerx', 'nooks', 'notabene', 'nourish',
  'nova-credit', 'novig', 'nox-metals', 'numeral',
  'nuna', 'observe-ai', 'octant-bio', 'odeko',
  'odys-aviation', 'offdeal', 'offerup', 'olive',
  'oneschema', 'onx', 'onyx', 'opendoor',
  'opensea', 'ophelia', 'orum', 'osaro',
  'output-biosciences', 'outrival', 'outschool', 'outset',
  'overview', 'padlet', 'pagerduty', 'pair-team',
  'papa', 'paragon-ai', 'parker', 'passport',
  'patch', 'pax-historia', 'pelago', 'peloton',
  'people-ai', 'peptilogics', 'permitflow', 'persona',
  'phantom', 'pharos', 'picsart', 'pika',
  'pirros', 'pivot-robotics', 'plaid', 'planetscale',
  'playbook', 'playground', 'pointone', 'popl',
  'porter', 'posh', 'postera', 'postscript',
  'prefect', 'prelim', 'primer', 'probably-genetic',
  'prodigal', 'promise', 'propel', 'prosper',
  'pulley', 'pure', 'pyka', 'pylon',
  'qualtrics', 'quantum-circuits', 'quartzy', 'quicknode',
  'quince', 'quindar', 'qventus', 'radiant',
  'raindrop', 'rally-uxr', 'reacher', 'ready',
  'reality-defender', 'reducto', 'reflect-orbital', 'reflex',
  'regent', 'replit', 'replo', 'rescale',
  'restaurant365', 'revenuecat', 'rigetti-computing', 'ritual',
  'roboflow', 'rollstack', 'roofr', 'roofstock',
  'rubrik', 'runway', 'rutter', 'ryvn',
  'safetykit', 'salespatriot', 'salient', 'salt-security',
  'samsara', 'sapling-ai', 'saronic', 'seam',
  'seatgeek', 'secureframe', 'securityscorecard', 'semgrep',
  'sendbird', 'sentilink', 'sentry', 'sfox',
  'shepherd', 'shield-ai', 'shift', 'shopmonkey',
  'short-story', 'sieve', 'sift', 'signoz',
  'simple-ai', 'simplify', 'singlestore', 'singularity-6',
  'sisense', 'skio', 'skydio', 'skylink',
  'skysafe', 'skyways', 'sleeper', 'slingshot-ai',
  'slope', 'smartasset', 'smartcuts', 'smithrx',
  'snackpass', 'snapdocs', 'snaplogic', 'snappr',
  'socure', 'sola', 'solidroad', 'spaceium',
  'spade', 'speak', 'spellbrush', 'sphere',
  'spoton', 'sprig', 'sprinter-health', 'spruceid',
  'squire', 'stable', 'stack-ai', 'stainless',
  'statsig', 'stepful', 'strava', 'stream',
  'stytch', 'substack', 'suger', 'sully-ai',
  'sumo-logic', 'supermove', 'svix', 'swayable',
  'sweep', 'sword-health', 'synapticure', 'syndio',
  'synthego', 'sysdig', 'taktile', 'tala',
  'tandem', 'tavus', 'teleo', 'tempo',
  'tenjin', 'tennr', 'terminal', 'thanx',
  'thera', 'thumbtack', 'thunkable', 'titan',
  'toast', 'toma', 'topline-pro', 'torq',
  'tovala', 'traba', 'tractian', 'treasury-prime',
  'trm-labs', 'truework', 'truthsystems', 'tuesday-lab',
  'turing', 'turion-space', 'turquoise-health', 'twenty',
  'two-dots', 'uipath', 'ujet', 'ultra',
  'unit', 'unitq', 'unusual', 'upflow',
  'upkeep', 'uplane', 'upstart', 'vanta',
  'vapi', 'vellum', 'velo3d', 'vercel',
  'vergesense', 'verkada', 'verse', 'verse-medical',
  'very-good-security', 'vesta', 'vetcove', 'vicarious-surgical',
  'viome', 'virta-health', 'virtru', 'vitable-health',
  'vitalize-care', 'vivodyne', 'vivun', 'volta-labs',
  'vooma', 'vori', 'vorticity', 'weave',
  'webflow', 'whatnot', 'wonderschool', 'workboard',
  'workstream', 'workwhile', 'world-labs', 'wrapbook',
  'xai', 'yotpo', 'yuma-ai', 'zapier',
  'zenbusiness', 'zenoti', 'zip', 'zipline',
  'zum', 'zuma', 'zus-health',
]);

// Returns 'STARTUP' for YC / HN-hiring companies, empty string otherwise.
// Empty string (not null) keeps the DB schema simple — the column is NOT NULL
// and the frontend treats anything falsy as "no pill".
function classifyCategory(companyName, source) {
  if (source === 'hn_hiring') return 'STARTUP';
  const slug = normSlug(companyName);
  if (STARTUP_SLUGS.has(slug)) return 'STARTUP';
  return '';
}

module.exports = { classifyCategory, normSlug, STARTUP_SLUGS };
