'use strict';

// Sample companies. Shape depends on source:
//   greenhouse / lever / ashby:  { source, slug, displayName }
//   workday:                     { source, slug, tenant, wd, site, displayName }
//   oracle_hcm:                  { source, slug, apiHost, siteNumber, uiBaseUrl, displayName }
//   amazon / microsoft:          { source, displayName }  (single-tenant scrapers)
//
// Unknown/invalid entries just log a warning and are skipped — safe to over-include.
const COMPANIES = [
  // ─── Greenhouse ──────────────────────────────────────────────────────────
  { source: 'greenhouse', slug: 'stripe',      displayName: 'Stripe' },
  { source: 'greenhouse', slug: 'airbnb',      displayName: 'Airbnb' },
  { source: 'greenhouse', slug: 'robinhood',   displayName: 'Robinhood' },
  { source: 'greenhouse', slug: 'coinbase',    displayName: 'Coinbase' },
  { source: 'greenhouse', slug: 'figma',       displayName: 'Figma' },
  { source: 'greenhouse', slug: 'discord',     displayName: 'Discord' },
  { source: 'greenhouse', slug: 'instacart',   displayName: 'Instacart' },
  { source: 'greenhouse', slug: 'dropbox',     displayName: 'Dropbox' },
  { source: 'greenhouse', slug: 'anthropic',   displayName: 'Anthropic' },
  { source: 'greenhouse', slug: 'databricks',  displayName: 'Databricks' },
  { source: 'greenhouse', slug: 'cloudflare',  displayName: 'Cloudflare' },
  { source: 'greenhouse', slug: 'reddit',      displayName: 'Reddit' },
  { source: 'greenhouse', slug: 'pinterest',   displayName: 'Pinterest' },
  { source: 'greenhouse', slug: 'lyft',        displayName: 'Lyft' },
  { source: 'greenhouse', slug: 'datadog',     displayName: 'Datadog' },
  { source: 'greenhouse', slug: 'twilio',      displayName: 'Twilio' },
  { source: 'greenhouse', slug: 'asana',       displayName: 'Asana' },
  { source: 'greenhouse', slug: 'brex',        displayName: 'Brex' },
  { source: 'greenhouse', slug: 'mercury',     displayName: 'Mercury' },
  { source: 'greenhouse', slug: 'gitlab',      displayName: 'GitLab' },
  { source: 'greenhouse', slug: 'block',       displayName: 'Block (Square)' },
  { source: 'greenhouse', slug: 'affirm',      displayName: 'Affirm' },
  { source: 'greenhouse', slug: 'chime',       displayName: 'Chime' },
  { source: 'greenhouse', slug: 'scaleai',     displayName: 'Scale AI' },

  // ─── Greenhouse — big-company additions (verified 2026-04-24) ───────────
  { source: 'greenhouse', slug: 'doordashusa', displayName: 'DoorDash' },
  { source: 'greenhouse', slug: 'hubspotjobs', displayName: 'HubSpot' },

  // ─── Greenhouse — YC US-hiring (discovered by scripts/probe-yc-ats.js, verified 2026-04-24) ───
  { source: 'greenhouse', slug: 'algolia', displayName: 'Algolia' }, // YC Winter 2014
  { source: 'greenhouse', slug: 'alpaca', displayName: 'Alpaca' }, // YC Winter 2019
  { source: 'greenhouse', slug: 'amplitude', displayName: 'Amplitude' }, // YC Winter 2012
  { source: 'greenhouse', slug: 'apolloio', displayName: 'Apollo.io' }, // YC W16
  { source: 'greenhouse', slug: 'assemblyai', displayName: 'AssemblyAI' }, // YC Summer 2017
  { source: 'greenhouse', slug: 'astranis', displayName: 'Astranis' }, // YC W16
  { source: 'greenhouse', slug: 'attain', displayName: 'Attain' }, // YC Winter 2022
  { source: 'greenhouse', slug: 'attune', displayName: 'Attune' }, // YC Spring 2025
  { source: 'greenhouse', slug: 'axle', displayName: 'Axle' }, // YC Summer 2022
  { source: 'greenhouse', slug: 'billiontoone', displayName: 'BillionToOne' }, // YC Summer 2017
  { source: 'greenhouse', slug: 'bitmovin', displayName: 'Bitmovin' }, // YC S15
  { source: 'greenhouse', slug: 'checkr', displayName: 'Checkr' }, // YC S14
  { source: 'greenhouse', slug: 'coast', displayName: 'Coast' }, // YC Summer 2021
  { source: 'greenhouse', slug: 'daybreakhealth', displayName: 'Daybreak Health' }, // YC S20
  { source: 'greenhouse', slug: 'dots', displayName: 'Dots' }, // YC Summer 2021
  { source: 'greenhouse', slug: 'embrace', displayName: 'Embrace' }, // YC S19
  { source: 'greenhouse', slug: 'extend', displayName: 'Extend' }, // YC W23
  { source: 'greenhouse', slug: 'faire', displayName: 'Faire' }, // YC Winter 2017
  { source: 'greenhouse', slug: 'flexport', displayName: 'Flexport' }, // YC Winter 2014
  { source: 'greenhouse', slug: 'foundry', displayName: 'Foundry' }, // YC F24
  { source: 'greenhouse', slug: 'generalproximity', displayName: 'General Proximity' }, // YC Winter 2020
  { source: 'greenhouse', slug: 'gigs', displayName: 'Gigs' }, // YC Winter 2021
  { source: 'greenhouse', slug: 'ginkgobioworks', displayName: 'Ginkgo Bioworks' }, // YC S14
  { source: 'greenhouse', slug: 'givecampus', displayName: 'GiveCampus' }, // YC S15
  { source: 'greenhouse', slug: 'goldbelly', displayName: 'Goldbelly' }, // YC W13
  { source: 'greenhouse', slug: 'gusto', displayName: 'Gusto' }, // YC Winter 2012
  { source: 'greenhouse', slug: 'hackerrank', displayName: 'HackerRank' }, // YC Summer 2011
  { source: 'greenhouse', slug: 'hightouch', displayName: 'Hightouch' }, // YC S19
  { source: 'greenhouse', slug: 'humaninterest', displayName: 'Human Interest' }, // YC S15
  { source: 'greenhouse', slug: 'instawork', displayName: 'Instawork' }, // YC S15
  { source: 'greenhouse', slug: 'kalshi', displayName: 'Kalshi' }, // YC Winter 2019
  { source: 'greenhouse', slug: 'keystone', displayName: 'Keystone' }, // YC Summer 2025
  { source: 'greenhouse', slug: 'lattice', displayName: 'Lattice' }, // YC W16
  { source: 'greenhouse', slug: 'lob', displayName: 'Lob' }, // YC Summer 2013
  { source: 'greenhouse', slug: 'lucidbots', displayName: 'Lucid Bots' }, // YC Summer 2019
  { source: 'greenhouse', slug: 'maymobility', displayName: 'May Mobility' }, // YC Summer 2017
  { source: 'greenhouse', slug: 'meruhealth', displayName: 'Meru Health' }, // YC Summer 2018
  { source: 'greenhouse', slug: 'mixpanel', displayName: 'Mixpanel' }, // YC S09
  { source: 'greenhouse', slug: 'modernhealth', displayName: 'Modern Health' }, // YC W18
  { source: 'greenhouse', slug: 'momence', displayName: 'Momence' }, // YC S20
  { source: 'greenhouse', slug: 'mutiny', displayName: 'Mutiny' }, // YC Summer 2018
  { source: 'greenhouse', slug: 'nabis', displayName: 'Nabis' }, // YC Winter 2019
  { source: 'greenhouse', slug: 'nanonets', displayName: 'NanoNets' }, // YC Winter 2017
  { source: 'greenhouse', slug: 'navierai', displayName: 'Navier AI' }, // YC Winter 2024
  { source: 'greenhouse', slug: 'usenourish', displayName: 'Nourish' }, // YC Winter 2021
  { source: 'greenhouse', slug: 'novacredit', displayName: 'Nova Credit' }, // YC S16
  { source: 'greenhouse', slug: 'odeko', displayName: 'Odeko' }, // YC S19
  { source: 'greenhouse', slug: 'pairteam', displayName: 'Pair Team' }, // YC S19
  { source: 'greenhouse', slug: 'papa', displayName: 'Papa' }, // YC Summer 2018
  { source: 'greenhouse', slug: 'pelago', displayName: 'Pelago' }, // YC W18
  { source: 'greenhouse', slug: 'postscript', displayName: 'Postscript' }, // YC Winter 2019
  { source: 'greenhouse', slug: 'prodigal', displayName: 'Prodigal' }, // YC Summer 2018
  { source: 'greenhouse', slug: 'pulley', displayName: 'Pulley' }, // YC Winter 2020
  { source: 'greenhouse', slug: 'qventus', displayName: 'Qventus' }, // YC Winter 2015
  { source: 'greenhouse', slug: 'reflex', displayName: 'Reflex' }, // YC Winter 2023
  { source: 'greenhouse', slug: 'regent', displayName: 'REGENT' }, // YC W21
  { source: 'greenhouse', slug: 'seam', displayName: 'Seam' }, // YC Summer 2020
  { source: 'greenhouse', slug: 'sendbird', displayName: 'Sendbird' }, // YC W16
  { source: 'greenhouse', slug: 'smartasset', displayName: 'SmartAsset' }, // YC Summer 2012
  { source: 'greenhouse', slug: 'spaceium', displayName: 'Spaceium Inc' }, // YC S24
  { source: 'greenhouse', slug: 'spade', displayName: 'Spade' }, // YC Winter 2022
  { source: 'greenhouse', slug: 'swayable', displayName: 'Swayable' }, // YC W18
  { source: 'greenhouse', slug: 'tempo', displayName: 'Tempo' }, // YC Winter 2015
  { source: 'greenhouse', slug: 'treasuryprime', displayName: 'Treasury Prime' }, // YC Winter 2018
  { source: 'greenhouse', slug: 'upkeep', displayName: 'UpKeep' }, // YC Winter 2017
  { source: 'greenhouse', slug: 'verse', displayName: 'Verse' }, // YC W22
  { source: 'greenhouse', slug: 'vitablehealth', displayName: 'Vitable Health' }, // YC Summer 2020
  { source: 'greenhouse', slug: 'weave', displayName: 'Weave' }, // YC Winter 2025
  { source: 'greenhouse', slug: 'webflow', displayName: 'Webflow' }, // YC Summer 2013
  { source: 'greenhouse', slug: 'yuma', displayName: 'Yuma AI' }, // YC W23

  // ─── Greenhouse — topstartups.io (discovered by scripts/probe-topstartups.js, verified 2026-04-24) ───
  { source: 'greenhouse', slug: 'airtable', displayName: 'Airtable' },
  { source: 'greenhouse', slug: 'alloy', displayName: 'Alloy' },
  { source: 'greenhouse', slug: 'andurilindustries', displayName: 'Anduril Industries' },
  { source: 'greenhouse', slug: 'appliedintuition', displayName: 'Applied Intuition' },
  { source: 'greenhouse', slug: 'attentive', displayName: 'Attentive' },
  { source: 'greenhouse', slug: 'axonius', displayName: 'Axonius' },
  { source: 'greenhouse', slug: 'betterment', displayName: 'Betterment' },
  { source: 'greenhouse', slug: 'bigid', displayName: 'BigID' },
  { source: 'greenhouse', slug: 'biofourmis', displayName: 'Biofourmis' },
  { source: 'greenhouse', slug: 'blend', displayName: 'Blend' },
  { source: 'greenhouse', slug: 'branch', displayName: 'Branch' },
  { source: 'greenhouse', slug: 'cameo', displayName: 'Cameo' },
  { source: 'greenhouse', slug: 'candid', displayName: 'Candid' },
  { source: 'greenhouse', slug: 'capitolis', displayName: 'Capitolis' },
  { source: 'greenhouse', slug: 'carbon', displayName: 'Carbon' },
  { source: 'greenhouse', slug: 'carta', displayName: 'Carta' },
  { source: 'greenhouse', slug: 'celonis', displayName: 'Celonis' },
  { source: 'greenhouse', slug: 'chainguard', displayName: 'Chainguard' },
  { source: 'greenhouse', slug: 'clickhouse', displayName: 'ClickHouse' },
  { source: 'greenhouse', slug: 'cloverhealth', displayName: 'Clover Health' },
  { source: 'greenhouse', slug: 'cockroachlabs', displayName: 'Cockroach Labs' },
  { source: 'greenhouse', slug: 'collectivehealth', displayName: 'Collective Health' },
  { source: 'greenhouse', slug: 'cortex', displayName: 'Cortex' },
  { source: 'greenhouse', slug: 'coursera', displayName: 'Coursera' },
  { source: 'greenhouse', slug: 'cresta', displayName: 'Cresta' },
  { source: 'greenhouse', slug: 'dashlane', displayName: 'Dashlane' },
  { source: 'greenhouse', slug: 'descript', displayName: 'Descript' },
  { source: 'greenhouse', slug: 'devrev', displayName: 'DevRev' },
  { source: 'greenhouse', slug: 'dialpad', displayName: 'Dialpad' },
  { source: 'greenhouse', slug: 'digitalai', displayName: 'Digital.ai' },
  { source: 'greenhouse', slug: 'disco', displayName: 'Disco' },
  { source: 'greenhouse', slug: 'dominodatalab', displayName: 'Domino Data Lab' },
  { source: 'greenhouse', slug: 'druva', displayName: 'Druva' },
  { source: 'greenhouse', slug: 'dynotherapeutics', displayName: 'Dyno Therapeutics' },
  { source: 'greenhouse', slug: 'earnin', displayName: 'Earnin' },
  { source: 'greenhouse', slug: 'epicgames', displayName: 'Epic Games' },
  { source: 'greenhouse', slug: 'ethoslife', displayName: 'Ethos Life' },
  { source: 'greenhouse', slug: 'everlaw', displayName: 'Everlaw' },
  { source: 'greenhouse', slug: 'fireblocks', displayName: 'Fireblocks' },
  { source: 'greenhouse', slug: 'fireworksai', displayName: 'Fireworks AI' },
  { source: 'greenhouse', slug: 'fivetran', displayName: 'Fivetran' },
  { source: 'greenhouse', slug: 'flockhomes', displayName: 'Flock Homes' },
  { source: 'greenhouse', slug: 'formationbio', displayName: 'Formation Bio' },
  { source: 'greenhouse', slug: 'forter', displayName: 'Forter' },
  { source: 'greenhouse', slug: 'forwardnetworks', displayName: 'Forward Networks' },
  { source: 'greenhouse', slug: 'freenome', displayName: 'Freenome' },
  { source: 'greenhouse', slug: 'glossgenius', displayName: 'GlossGenius' },
  { source: 'greenhouse', slug: 'glossier', displayName: 'Glossier' },
  { source: 'greenhouse', slug: 'gongio', displayName: 'Gong.io' },
  { source: 'greenhouse', slug: 'harmonic', displayName: 'Harmonic' },
  { source: 'greenhouse', slug: 'hebbia', displayName: 'Hebbia' },
  { source: 'greenhouse', slug: 'heygen', displayName: 'HeyGen' },
  { source: 'greenhouse', slug: 'honor', displayName: 'Honor' },
  { source: 'greenhouse', slug: 'hudl', displayName: 'Hudl' },
  { source: 'greenhouse', slug: 'imply', displayName: 'Imply' },
  { source: 'greenhouse', slug: 'instabase', displayName: 'Instabase' },
  { source: 'greenhouse', slug: 'intercom', displayName: 'Intercom' },
  { source: 'greenhouse', slug: 'invoca', displayName: 'Invoca' },
  { source: 'greenhouse', slug: 'juno', displayName: 'Juno' },
  { source: 'greenhouse', slug: 'komodohealth', displayName: 'Komodo Health' },
  { source: 'greenhouse', slug: 'kymeratherapeutics', displayName: 'Kymera Therapeutics' },
  { source: 'greenhouse', slug: 'labelbox', displayName: 'Labelbox' },
  { source: 'greenhouse', slug: 'launchdarkly', displayName: 'LaunchDarkly' },
  { source: 'greenhouse', slug: 'leaflink', displayName: 'LeafLink' },
  { source: 'greenhouse', slug: 'legalist', displayName: 'Legalist' },
  { source: 'greenhouse', slug: 'loyal', displayName: 'Loyal' },
  { source: 'greenhouse', slug: 'maintainx', displayName: 'MaintainX' },
  { source: 'greenhouse', slug: 'manychat', displayName: 'ManyChat' },
  { source: 'greenhouse', slug: 'marqvision', displayName: 'MarqVision' },
  { source: 'greenhouse', slug: 'matik', displayName: 'Matik' },
  { source: 'greenhouse', slug: 'mavenclinic', displayName: 'Maven Clinic' },
  { source: 'greenhouse', slug: 'medium', displayName: 'Medium' },
  { source: 'greenhouse', slug: 'melio', displayName: 'Melio' },
  { source: 'greenhouse', slug: 'misfitsmarket', displayName: 'Misfits Market' },
  { source: 'greenhouse', slug: 'modernanimal', displayName: 'Modern Animal' },
  { source: 'greenhouse', slug: 'moveworks', displayName: 'Moveworks' },
  { source: 'greenhouse', slug: 'narvar', displayName: 'Narvar' },
  { source: 'greenhouse', slug: 'netlify', displayName: 'Netlify' },
  { source: 'greenhouse', slug: 'netskope', displayName: 'Netskope' },
  { source: 'greenhouse', slug: 'neuralink', displayName: 'Neuralink' },
  { source: 'greenhouse', slug: 'newlimit', displayName: 'NewLimit' },
  { source: 'greenhouse', slug: 'nooks', displayName: 'Nooks' },
  { source: 'greenhouse', slug: 'observeai', displayName: 'Observe.AI' },
  { source: 'greenhouse', slug: 'octantbio', displayName: 'Octant Bio' },
  { source: 'greenhouse', slug: 'offerup', displayName: 'OfferUp' },
  { source: 'greenhouse', slug: 'onxmaps', displayName: 'onX' },
  { source: 'greenhouse', slug: 'opendoor', displayName: 'Opendoor' },
  { source: 'greenhouse', slug: 'ophelia', displayName: 'Ophelia' },
  { source: 'greenhouse', slug: 'outschool', displayName: 'Outschool' },
  { source: 'greenhouse', slug: 'pagerduty', displayName: 'PagerDuty' },
  { source: 'greenhouse', slug: 'patch', displayName: 'Patch' },
  { source: 'greenhouse', slug: 'peloton', displayName: 'Peloton' },
  { source: 'greenhouse', slug: 'peptilogics', displayName: 'Peptilogics' },
  { source: 'greenhouse', slug: 'picsart', displayName: 'PicsArt' },
  { source: 'greenhouse', slug: 'planetscale', displayName: 'PlanetScale' },
  { source: 'greenhouse', slug: 'qualtrics', displayName: 'Qualtrics' },
  { source: 'greenhouse', slug: 'quince', displayName: 'Quince' },
  { source: 'greenhouse', slug: 'ritual', displayName: 'Ritual' },
  { source: 'greenhouse', slug: 'roofr', displayName: 'Roofr' },
  { source: 'greenhouse', slug: 'roofstock', displayName: 'Roofstock' },
  { source: 'greenhouse', slug: 'rubrik', displayName: 'Rubrik' },
  { source: 'greenhouse', slug: 'saltsecurity', displayName: 'Salt Security' },
  { source: 'greenhouse', slug: 'samsara', displayName: 'Samsara' },
  { source: 'greenhouse', slug: 'seatgeek', displayName: 'SeatGeek' },
  { source: 'greenhouse', slug: 'securityscorecard', displayName: 'SecurityScorecard' },
  { source: 'greenhouse', slug: 'sfox', displayName: 'SFOX' },
  { source: 'greenhouse', slug: 'shopmonkey', displayName: 'Shopmonkey' },
  { source: 'greenhouse', slug: 'singlestore', displayName: 'SingleStore' },
  { source: 'greenhouse', slug: 'singularity6', displayName: 'Singularity 6' },
  { source: 'greenhouse', slug: 'sisense', displayName: 'Sisense' },
  { source: 'greenhouse', slug: 'smithrx', displayName: 'SmithRx' },
  { source: 'greenhouse', slug: 'snackpass', displayName: 'Snackpass' },
  { source: 'greenhouse', slug: 'sumologic', displayName: 'Sumo Logic' },
  { source: 'greenhouse', slug: 'syndio', displayName: 'Syndio' },
  { source: 'greenhouse', slug: 'thanx', displayName: 'Thanx' },
  { source: 'greenhouse', slug: 'thumbtack', displayName: 'Thumbtack' },
  { source: 'greenhouse', slug: 'toast', displayName: 'Toast' },
  { source: 'greenhouse', slug: 'torq', displayName: 'Torq' },
  { source: 'greenhouse', slug: 'truework', displayName: 'Truework' },
  { source: 'greenhouse', slug: 'turing', displayName: 'Turing' },
  { source: 'greenhouse', slug: 'ujet', displayName: 'UJET' },
  { source: 'greenhouse', slug: 'upstart', displayName: 'Upstart' },
  { source: 'greenhouse', slug: 'vercel', displayName: 'Vercel' },
  { source: 'greenhouse', slug: 'verkada', displayName: 'Verkada' },
  { source: 'greenhouse', slug: 'vicarioussurgical', displayName: 'Vicarious Surgical' },
  { source: 'greenhouse', slug: 'virtru', displayName: 'Virtru' },
  { source: 'greenhouse', slug: 'vivodyne', displayName: 'Vivodyne' },
  { source: 'greenhouse', slug: 'wonderschool', displayName: 'Wonderschool' },
  { source: 'greenhouse', slug: 'workboard', displayName: 'Workboard' },
  { source: 'greenhouse', slug: 'workstream', displayName: 'Workstream' },
  { source: 'greenhouse', slug: 'worldlabs', displayName: 'World Labs' },
  { source: 'greenhouse', slug: 'xai', displayName: 'xAI' },
  { source: 'greenhouse', slug: 'yotpo', displayName: 'Yotpo' },
  { source: 'greenhouse', slug: 'zenbusiness', displayName: 'ZenBusiness' },
  { source: 'greenhouse', slug: 'zenoti', displayName: 'Zenoti' },
  { source: 'greenhouse', slug: 'flyzipline', displayName: 'Zipline' },

  // ─── Lever ───────────────────────────────────────────────────────────────
  { source: 'lever', slug: 'palantir',  displayName: 'Palantir' },
  { source: 'lever', slug: 'spotify',   displayName: 'Spotify' },

  // ─── Lever — YC US-hiring (verified 2026-04-24) ───
  { source: 'lever', slug: 'aleph', displayName: 'Aleph' }, // YC Summer 2021
  { source: 'lever', slug: 'canarytechnologies', displayName: 'Canary Technologies' }, // YC Summer 2018
  { source: 'lever', slug: 'captivateiq', displayName: 'CaptivateIQ' }, // YC W18
  { source: 'lever', slug: 'culdesac', displayName: 'Culdesac' }, // YC Summer 2018
  { source: 'lever', slug: 'distro', displayName: 'Distro' }, // YC S24
  { source: 'lever', slug: 'doola', displayName: 'doola' }, // YC Summer 2020
  { source: 'lever', slug: 'epsilon3', displayName: 'Epsilon3' }, // YC S21
  { source: 'lever', slug: 'finch', displayName: 'Finch' }, // YC Summer 2020
  { source: 'lever', slug: 'fleetzero', displayName: 'Fleetzero' }, // YC W22
  { source: 'lever', slug: 'gridware', displayName: 'Gridware' }, // YC Winter 2021
  { source: 'lever', slug: 'handoff', displayName: 'Handoff' }, // YC Winter 2020
  { source: 'lever', slug: 'layup', displayName: 'Layup' }, // YC W23
  { source: 'lever', slug: 'livingcarbon', displayName: 'Living Carbon' }, // YC Winter 2020
  { source: 'lever', slug: 'mashgin', displayName: 'Mashgin' }, // YC Winter 2015
  { source: 'lever', slug: 'maverickx', displayName: 'MaverickX' }, // YC Summer 2022
  { source: 'lever', slug: 'multiplylabs', displayName: 'Multiply Labs' }, // YC S16
  { source: 'lever', slug: 'netomi', displayName: 'Netomi' }, // YC W16
  { source: 'lever', slug: 'nimblerx', displayName: 'NimbleRx' }, // YC Winter 2015
  { source: 'lever', slug: 'people-ai', displayName: 'People.ai' }, // YC S16
  { source: 'lever', slug: 'porter', displayName: 'Porter' }, // YC Summer 2020
  { source: 'lever', slug: 'postera', displayName: 'PostEra' }, // YC Winter 2020
  { source: 'lever', slug: 'prosper', displayName: 'Prosper' }, // YC Summer 2023
  { source: 'lever', slug: 'sapling', displayName: 'Sapling.ai' }, // YC Winter 2019
  { source: 'lever', slug: 'skio', displayName: 'Skio' }, // YC Summer 2020
  { source: 'lever', slug: 'skyways', displayName: 'Skyways' }, // YC Summer 2017
  { source: 'lever', slug: 'smartcuts', displayName: 'Smartcuts' }, // YC Winter 2021
  { source: 'lever', slug: 'snappr', displayName: 'Snappr' }, // YC Winter 2017
  { source: 'lever', slug: 'suger', displayName: 'Suger' }, // YC W23
  { source: 'lever', slug: 'synapticure', displayName: 'Synapticure' }, // YC S20
  { source: 'lever', slug: 'teleo', displayName: 'Teleo' }, // YC Winter 2020
  { source: 'lever', slug: 'thunkable', displayName: 'Thunkable' }, // YC W16
  { source: 'lever', slug: 'tovala', displayName: 'Tovala' }, // YC W16
  { source: 'lever', slug: 'tractian', displayName: 'Tractian' }, // YC Winter 2021
  { source: 'lever', slug: 'twodots', displayName: 'Two Dots' }, // YC Summer 2022
  { source: 'lever', slug: 'unusual', displayName: 'Unusual' }, // YC Fall 2024
  { source: 'lever', slug: 'voltalabs', displayName: 'Volta Labs' }, // YC Winter 2019
  { source: 'lever', slug: 'getzuma', displayName: 'Zuma' }, // YC Summer 2021

  // ─── Lever — topstartups.io (verified 2026-04-24) ───
  { source: 'lever', slug: 'alluxio', displayName: 'Alluxio' },
  { source: 'lever', slug: 'anchorage', displayName: 'Anchorage' },
  { source: 'lever', slug: 'anyscale', displayName: 'Anyscale' },
  { source: 'lever', slug: 'basis', displayName: 'Basis' },
  { source: 'lever', slug: 'belong', displayName: 'Belong' },
  { source: 'lever', slug: 'cents', displayName: 'Cents' },
  { source: 'lever', slug: 'clari', displayName: 'Clari' },
  { source: 'lever', slug: 'cobaltrobotics', displayName: 'Cobalt Robotics' },
  { source: 'lever', slug: 'conduktor', displayName: 'Conduktor' },
  { source: 'lever', slug: 'dollskill', displayName: 'Dolls Kill' },
  { source: 'lever', slug: 'doxel', displayName: 'Doxel' },
  { source: 'lever', slug: 'dronedeploy', displayName: 'DroneDeploy' },
  { source: 'lever', slug: 'egenesisbio', displayName: 'eGenesis' },
  { source: 'lever', slug: 'finix', displayName: 'Finix' },
  { source: 'lever', slug: 'goodeggs', displayName: 'Good Eggs' },
  { source: 'lever', slug: 'h1', displayName: 'H1' },
  { source: 'lever', slug: 'hermeus', displayName: 'Hermeus' },
  { source: 'lever', slug: 'houzz', displayName: 'Houzz' },
  { source: 'lever', slug: 'incorta', displayName: 'InCorta' },
  { source: 'lever', slug: 'tryjeeves', displayName: 'Jeeves' },
  { source: 'lever', slug: 'kapwing', displayName: 'Kapwing' },
  { source: 'lever', slug: 'kariusdx', displayName: 'Karius' },
  { source: 'lever', slug: 'kiddom', displayName: 'Kiddom' },
  { source: 'lever', slug: 'lessen', displayName: 'Lessen' },
  { source: 'lever', slug: 'lightship', displayName: 'Lightship' },
  { source: 'lever', slug: 'luxurypresence', displayName: 'Luxury Presence' },
  { source: 'lever', slug: 'osaro', displayName: 'Osaro' },
  { source: 'lever', slug: 'plaid', displayName: 'Plaid' },
  { source: 'lever', slug: 'playbook', displayName: 'Playbook' },
  { source: 'lever', slug: 'pyka', displayName: 'Pyka' },
  { source: 'lever', slug: 'quantumcircuits', displayName: 'Quantum Circuits' },
  { source: 'lever', slug: 'quartzy', displayName: 'Quartzy' },
  { source: 'lever', slug: 'restaurant365', displayName: 'Restaurant365' },
  { source: 'lever', slug: 'rigetti', displayName: 'Rigetti Computing' },
  { source: 'lever', slug: 'secureframe', displayName: 'Secureframe' },
  { source: 'lever', slug: 'shieldai', displayName: 'Shield AI' },
  { source: 'lever', slug: 'skysafe', displayName: 'SkySafe' },
  { source: 'lever', slug: 'snaplogic', displayName: 'SnapLogic' },
  { source: 'lever', slug: 'getsquire', displayName: 'Squire' },
  { source: 'lever', slug: 'supermove', displayName: 'Supermove' },
  { source: 'lever', slug: 'swordhealth', displayName: 'SWORD Health' },
  { source: 'lever', slug: 'synthego', displayName: 'Synthego' },
  { source: 'lever', slug: 'sysdig', displayName: 'Sysdig' },
  { source: 'lever', slug: 'tala', displayName: 'Tala' },
  { source: 'lever', slug: 'unitq', displayName: 'unitQ' },
  { source: 'lever', slug: 'velo3d', displayName: 'VELO3D' },
  { source: 'lever', slug: 'vergesense', displayName: 'VergeSense' },
  { source: 'lever', slug: 'verygoodsecurity', displayName: 'Very Good Security' },
  { source: 'lever', slug: 'viome', displayName: 'Viome' },
  { source: 'lever', slug: 'ridezum', displayName: 'Zum' },
  { source: 'lever', slug: 'zushealth', displayName: 'Zus Health' },

  // ─── Ashby ───────────────────────────────────────────────────────────────
  { source: 'ashby', slug: 'posthog',      displayName: 'PostHog' },
  { source: 'ashby', slug: 'ramp',         displayName: 'Ramp' },
  { source: 'ashby', slug: 'linear',       displayName: 'Linear' },
  { source: 'ashby', slug: 'perplexity',   displayName: 'Perplexity' },
  { source: 'ashby', slug: 'elevenlabs',   displayName: 'ElevenLabs' },
  { source: 'ashby', slug: 'notion',       displayName: 'Notion' },
  { source: 'ashby', slug: 'openai',       displayName: 'OpenAI' },
  { source: 'ashby', slug: 'cursor',       displayName: 'Cursor' },

  // ─── Ashby — YC US-hiring (verified 2026-04-24) ───
  { source: 'ashby', slug: 'abacum', displayName: 'Abacum' }, // YC Winter 2021
  { source: 'ashby', slug: 'accord', displayName: 'Accord' }, // YC Winter 2020
  { source: 'ashby', slug: 'afterquery', displayName: 'AfterQuery' }, // YC Winter 2025
  { source: 'ashby', slug: 'agave', displayName: 'Agave' }, // YC Winter 2022
  { source: 'ashby', slug: 'agentmail', displayName: 'AgentMail' }, // YC Summer 2025
  { source: 'ashby', slug: 'aiprise', displayName: 'AiPrise' }, // YC Summer 2022
  { source: 'ashby', slug: 'airgoods', displayName: 'Airgoods' }, // YC Summer 2023
  { source: 'ashby', slug: 'anara', displayName: 'Anara' }, // YC Summer 2024
  { source: 'ashby', slug: 'apolink', displayName: 'Apolink' }, // YC Fall 2024
  { source: 'ashby', slug: 'archil', displayName: 'Archil' }, // YC Fall 2024
  { source: 'ashby', slug: 'arini', displayName: 'Arini' }, // YC W24
  { source: 'ashby', slug: 'arketa', displayName: 'Arketa' }, // YC Summer 2020
  { source: 'ashby', slug: 'artie', displayName: 'Artie' }, // YC Summer 2023
  { source: 'ashby', slug: 'artisan', displayName: 'Artisan' }, // YC W24
  { source: 'ashby', slug: 'ashby', displayName: 'Ashby' }, // YC Winter 2019
  { source: 'ashby', slug: 'assembly', displayName: 'Assembly' }, // YC Winter 2024
  { source: 'ashby', slug: 'astro-mechanica', displayName: 'Astro Mechanica' }, // YC Winter 2024
  { source: 'ashby', slug: 'atlas', displayName: 'Atlas' }, // YC Winter 2019
  { source: 'ashby', slug: 'atob', displayName: 'AtoB' }, // YC Summer 2020
  { source: 'ashby', slug: 'atomic', displayName: 'Atomic' }, // YC Summer 2020
  { source: 'ashby', slug: 'atomicindustries', displayName: 'Atomic Industries' }, // YC Winter 2021
  { source: 'ashby', slug: 'auctor', displayName: 'Auctor' }, // YC Spring 2025
  { source: 'ashby', slug: 'aurelian', displayName: 'Aurelian' }, // YC Summer 2022
  { source: 'ashby', slug: 'authzed', displayName: 'authzed' }, // YC Winter 2021
  { source: 'ashby', slug: 'automat', displayName: 'Automat' }, // YC W23
  { source: 'ashby', slug: 'aviator', displayName: 'Aviator' }, // YC Summer 2021
  { source: 'ashby', slug: 'axle-health', displayName: 'Axle Health' }, // YC Winter 2021
  { source: 'ashby', slug: 'bankjoy', displayName: 'Bankjoy' }, // YC Winter 2015
  { source: 'ashby', slug: 'benepass', displayName: 'Benepass' }, // YC Winter 2020
  { source: 'ashby', slug: 'bild-ai', displayName: 'Bild AI' }, // YC Winter 2025
  { source: 'ashby', slug: 'bland', displayName: 'Bland AI' }, // YC Summer 2023
  { source: 'ashby', slug: 'blaxel', displayName: 'Blaxel' }, // YC Spring 2025
  { source: 'ashby', slug: 'blee', displayName: 'Blee' }, // YC Summer 2022
  { source: 'ashby', slug: 'blink', displayName: 'Blink' }, // YC Winter 2022
  { source: 'ashby', slug: 'blissway', displayName: 'Blissway' }, // YC Summer 2020
  { source: 'ashby', slug: 'blueberrypediatrics', displayName: 'Blueberry Pediatrics' }, // YC W18
  { source: 'ashby', slug: 'boostly', displayName: 'Boostly' }, // YC S22
  { source: 'ashby', slug: 'bootloop', displayName: 'BootLoop' }, // YC Summer 2025
  { source: 'ashby', slug: 'brainbaselabs', displayName: 'Brainbase Labs' }, // YC Winter 2024
  { source: 'ashby', slug: 'broccoli', displayName: 'Broccoli AI' }, // YC Winter 2022
  { source: 'ashby', slug: 'bunkerhillhealth', displayName: 'Bunkerhill Health' }, // YC Winter 2019
  { source: 'ashby', slug: 'camber', displayName: 'Camber' }, // YC Winter 2021
  { source: 'ashby', slug: 'cambio', displayName: 'Cambio' }, // YC Summer 2022
  { source: 'ashby', slug: 'cambly', displayName: 'Cambly' }, // YC Winter 2014
  { source: 'ashby', slug: 'campfire', displayName: 'Campfire' }, // YC W22
  { source: 'ashby', slug: 'candidhealth', displayName: 'Candid Health' }, // YC Winter 2020
  { source: 'ashby', slug: 'capy', displayName: 'Capy' }, // YC Fall 2024
  { source: 'ashby', slug: 'casca', displayName: 'Casca' }, // YC Summer 2023
  { source: 'ashby', slug: 'castle', displayName: 'Castle' }, // YC W16
  { source: 'ashby', slug: 'centralhq', displayName: 'Central' }, // YC Summer 2024
  { source: 'ashby', slug: 'charge-robotics', displayName: 'Charge Robotics' }, // YC Summer 2021
  { source: 'ashby', slug: 'chestnut', displayName: 'Chestnut' }, // YC Spring 2025
  { source: 'ashby', slug: 'cinder', displayName: 'Cinder' }, // YC Winter 2022
  { source: 'ashby', slug: 'clarion', displayName: 'Clarion' }, // YC W24
  { source: 'ashby', slug: 'classdojo', displayName: 'ClassDojo' }, // YC Summer 2012
  { source: 'ashby', slug: 'clipboard', displayName: 'Clipboard' }, // YC Winter 2017
  { source: 'ashby', slug: 'codes-health', displayName: 'Codes Health' }, // YC S24
  { source: 'ashby', slug: 'complete', displayName: 'Complete' }, // YC Winter 2022
  { source: 'ashby', slug: 'concourse', displayName: 'Concourse' }, // YC W23
  { source: 'ashby', slug: 'conductor', displayName: 'Conductor' }, // YC Summer 2024
  { source: 'ashby', slug: 'conduit', displayName: 'Conduit' }, // YC Winter 2024
  { source: 'ashby', slug: 'confido', displayName: 'Confido' }, // YC Summer 2021
  { source: 'ashby', slug: 'continue', displayName: 'Continue' }, // YC Summer 2023
  { source: 'ashby', slug: 'coperniq', displayName: 'Coperniq' }, // YC W23
  { source: 'ashby', slug: 'corgi', displayName: 'Corgi' }, // YC S24
  { source: 'ashby', slug: 'corvus-robotics', displayName: 'Corvus Robotics' }, // YC S18
  { source: 'ashby', slug: 'cosine', displayName: 'Cosine' }, // YC W23
  { source: 'ashby', slug: 'credal', displayName: 'Credal.ai' }, // YC W23
  { source: 'ashby', slug: 'ctgt', displayName: 'CTGT' }, // YC Fall 2024
  { source: 'ashby', slug: 'curri', displayName: 'Curri' }, // YC S19
  { source: 'ashby', slug: 'decodahealth', displayName: 'Decoda Health' }, // YC Summer 2023
  { source: 'ashby', slug: 'deel', displayName: 'Deel' }, // YC Winter 2019
  { source: 'ashby', slug: 'deepgram', displayName: 'Deepgram' }, // YC W16
  { source: 'ashby', slug: 'delve', displayName: 'Delve' }, // YC W24
  { source: 'ashby', slug: 'dex', displayName: 'Dex' }, // YC S19
  { source: 'ashby', slug: 'diligencesquared', displayName: 'DiligenceSquared' }, // YC Fall 2025
  { source: 'ashby', slug: 'ditto', displayName: 'Ditto' }, // YC Winter 2020
  { source: 'ashby', slug: 'dyneti', displayName: 'Dyneti Technologies' }, // YC Winter 2019
  { source: 'ashby', slug: 'eightsleep', displayName: 'Eight Sleep' }, // YC S15
  { source: 'ashby', slug: 'ekho', displayName: 'Ekho' }, // YC Summer 2022
  { source: 'ashby', slug: 'ello', displayName: 'Ello' }, // YC Winter 2020
  { source: 'ashby', slug: 'eloquentai', displayName: 'Eloquent AI' }, // YC Spring 2025
  { source: 'ashby', slug: 'empirical', displayName: 'Empirical Health' }, // YC Summer 2023
  { source: 'ashby', slug: 'eventual', displayName: 'Eventual' }, // YC Winter 2022
  { source: 'ashby', slug: 'exa', displayName: 'Exa' }, // YC Summer 2021
  { source: 'ashby', slug: 'fathom', displayName: 'Fathom' }, // YC Winter 2021
  { source: 'ashby', slug: 'buildwithfern', displayName: 'Fern' }, // YC W23
  { source: 'ashby', slug: 'fieldguide', displayName: 'Fieldguide' }, // YC Summer 2020
  { source: 'ashby', slug: 'finni-health', displayName: 'Finni Health' }, // YC W23
  { source: 'ashby', slug: 'finvest', displayName: 'Finvest' }, // YC Winter 2023
  { source: 'ashby', slug: 'firecrawl', displayName: 'Firecrawl' }, // YC Summer 2022
  { source: 'ashby', slug: 'firstbaseio', displayName: 'Firstbase.io' }, // YC Winter 2021
  { source: 'ashby', slug: 'fleek', displayName: 'Fleek' }, // YC W22
  { source: 'ashby', slug: 'fleetline', displayName: 'Fleetline' }, // YC Summer 2025
  { source: 'ashby', slug: 'fleetworks', displayName: 'FleetWorks' }, // YC Summer 2023
  { source: 'ashby', slug: 'flint', displayName: 'Flint' }, // YC Summer 2020
  { source: 'ashby', slug: 'flowtel', displayName: 'Flowtel' }, // YC Winter 2025
  { source: 'ashby', slug: 'flutterflow', displayName: 'FlutterFlow' }, // YC Winter 2021
  { source: 'ashby', slug: 'fortuna-health', displayName: 'Fortuna Health' }, // YC Summer 2023
  { source: 'ashby', slug: 'freshpaint', displayName: 'Freshpaint' }, // YC S19
  { source: 'ashby', slug: 'furtherai', displayName: 'FurtherAI' }, // YC Winter 2024
  { source: 'ashby', slug: 'garage', displayName: 'Garage' }, // YC Winter 2024
  { source: 'ashby', slug: 'gecko-robotics', displayName: 'Gecko Robotics' }, // YC W16
  { source: 'ashby', slug: 'gigaml', displayName: 'Giga ML' }, // YC S23
  { source: 'ashby', slug: 'glimpse', displayName: 'Glimpse' }, // YC Summer 2020
  { source: 'ashby', slug: 'golinks', displayName: 'GoLinks' }, // YC Winter 2019
  { source: 'ashby', slug: 'govdash', displayName: 'GovDash' }, // YC Winter 2022
  { source: 'ashby', slug: 'goveagle', displayName: 'GovEagle' }, // YC Winter 2023
  { source: 'ashby', slug: 'greenboard', displayName: 'Greenboard' }, // YC Winter 2024
  { source: 'ashby', slug: 'greptile', displayName: 'Greptile' }, // YC W24
  { source: 'ashby', slug: 'harperinsure', displayName: 'Harper' }, // YC Winter 2025
  { source: 'ashby', slug: 'hatch', displayName: 'Hatch' }, // YC Winter 2019
  { source: 'ashby', slug: 'herondata', displayName: 'Heron Data' }, // YC Summer 2020
  { source: 'ashby', slug: 'hockeystack', displayName: 'HockeyStack' }, // YC Summer 2023
  { source: 'ashby', slug: 'hotplate', displayName: 'Hotplate' }, // YC Summer 2020
  { source: 'ashby', slug: 'hud', displayName: 'hud' }, // YC Winter 2025
  { source: 'ashby', slug: 'hudu', displayName: 'Hudu' }, // YC Winter 2021
  { source: 'ashby', slug: 'hyperbound', displayName: 'Hyperbound' }, // YC Summer 2023
  { source: 'ashby', slug: 'infinite', displayName: 'Infinite' }, // YC Winter 2025
  { source: 'ashby', slug: 'infisical', displayName: 'Infisical' }, // YC W23
  { source: 'ashby', slug: 'influxdata', displayName: 'InfluxData' }, // YC W13
  { source: 'ashby', slug: 'inkeep', displayName: 'Inkeep' }, // YC W23
  { source: 'ashby', slug: 'invert', displayName: 'Invert' }, // YC Winter 2022
  { source: 'ashby', slug: 'juicebox', displayName: 'Juicebox' }, // YC Summer 2022
  { source: 'ashby', slug: 'julius', displayName: 'Julius' }, // YC Summer 2022
  { source: 'ashby', slug: 'kingdom', displayName: 'Kingdom' }, // YC Summer 2020
  { source: 'ashby', slug: 'knowtex', displayName: 'Knowtex' }, // YC Summer 2022
  { source: 'ashby', slug: 'kodex', displayName: 'Kodex' }, // YC Summer 2021
  { source: 'ashby', slug: 'latent', displayName: 'Latent' }, // YC W23
  { source: 'ashby', slug: 'legionhealth', displayName: 'Legion Health' }, // YC Summer 2021
  { source: 'ashby', slug: 'liveflow', displayName: 'LiveFlow' }, // YC Winter 2021
  { source: 'ashby', slug: 'loula', displayName: 'Loula' }, // YC W23
  { source: 'ashby', slug: 'luminai', displayName: 'Luminai' }, // YC Summer 2020
  { source: 'ashby', slug: 'mach9', displayName: 'Mach9' }, // YC Summer 2021
  { source: 'ashby', slug: 'magicpatterns', displayName: 'Magic Patterns' }, // YC Winter 2023
  { source: 'ashby', slug: 'meadow', displayName: 'Meadow' }, // YC W15
  { source: 'ashby', slug: 'mednet', displayName: 'Mednet' }, // YC Winter 2017
  { source: 'ashby', slug: 'mem0', displayName: 'Mem0' }, // YC Summer 2024
  { source: 'ashby', slug: 'metriport', displayName: 'Metriport' }, // YC Summer 2022
  { source: 'ashby', slug: 'middesk', displayName: 'Middesk' }, // YC Winter 2019
  { source: 'ashby', slug: 'mintlify', displayName: 'Mintlify' }, // YC Winter 2022
  { source: 'ashby', slug: 'moderntreasury', displayName: 'Modern Treasury' }, // YC Summer 2018
  { source: 'ashby', slug: 'mosaic', displayName: 'Mosaic' }, // YC Winter 2025
  { source: 'ashby', slug: 'motion', displayName: 'Motion' }, // YC Winter 2020
  { source: 'ashby', slug: 'mux', displayName: 'Mux' }, // YC W16
  { source: 'ashby', slug: 'nabla', displayName: 'Nabla Bio' }, // YC S20
  { source: 'ashby', slug: 'nango', displayName: 'Nango' }, // YC W23
  { source: 'ashby', slug: 'nash', displayName: 'Nash' }, // YC Summer 2021
  { source: 'ashby', slug: 'new-story', displayName: 'New Story' }, // YC Summer 2015
  { source: 'ashby', slug: 'newfront', displayName: 'Newfront' }, // YC W18
  { source: 'ashby', slug: 'notabene', displayName: 'Notabene' }, // YC Summer 2020
  { source: 'ashby', slug: 'novig', displayName: 'Novig' }, // YC Summer 2022
  { source: 'ashby', slug: 'nox-metals', displayName: 'Nox Metals' }, // YC Summer 2025
  { source: 'ashby', slug: 'numeral', displayName: 'Numeral' }, // YC W23
  { source: 'ashby', slug: 'odys-aviation', displayName: 'Odys Aviation' }, // YC Summer 2021
  { source: 'ashby', slug: 'offdeal', displayName: 'OffDeal' }, // YC W24
  { source: 'ashby', slug: 'olive', displayName: 'Olive' }, // YC Winter 2025
  { source: 'ashby', slug: 'oneschema', displayName: 'OneSchema' }, // YC Summer 2021
  { source: 'ashby', slug: 'onyx', displayName: 'Onyx' }, // YC W24
  { source: 'ashby', slug: 'output', displayName: 'Output Biosciences' }, // YC Summer 2021
  { source: 'ashby', slug: 'outrival', displayName: 'OutRival' }, // YC W19
  { source: 'ashby', slug: 'outset', displayName: 'Outset' }, // YC Summer 2023
  { source: 'ashby', slug: 'overview', displayName: 'Overview' }, // YC Winter 2019
  { source: 'ashby', slug: 'padlet', displayName: 'Padlet' }, // YC W13
  { source: 'ashby', slug: 'paragon', displayName: 'Paragon AI' }, // YC Summer 2022
  { source: 'ashby', slug: 'parker', displayName: 'Parker' }, // YC Winter 2019
  { source: 'ashby', slug: 'pax-historia', displayName: 'Pax Historia' }, // YC Winter 2026
  { source: 'ashby', slug: 'permitflow', displayName: 'PermitFlow' }, // YC Winter 2022
  { source: 'ashby', slug: 'pharos', displayName: 'Pharos' }, // YC Summer 2024
  { source: 'ashby', slug: 'pirros', displayName: 'Pirros' }, // YC W23
  { source: 'ashby', slug: 'pivotrobotics', displayName: 'Pivot Robotics' }, // YC W24
  { source: 'ashby', slug: 'playground', displayName: 'Playground' }, // YC S19
  { source: 'ashby', slug: 'pointone', displayName: 'PointOne' }, // YC Winter 2024
  { source: 'ashby', slug: 'popl', displayName: 'Popl' }, // YC Winter 2021
  { source: 'ashby', slug: 'posh', displayName: 'Posh' }, // YC Winter 2022
  { source: 'ashby', slug: 'prelim', displayName: 'Prelim' }, // YC Summer 2017
  { source: 'ashby', slug: 'probablygenetic', displayName: 'Probably Genetic' }, // YC Winter 2019
  { source: 'ashby', slug: 'promise', displayName: 'Promise' }, // YC W18
  { source: 'ashby', slug: 'pure', displayName: 'Pure' }, // YC Summer 2023
  { source: 'ashby', slug: 'pylon', displayName: 'Pylon' }, // YC W23
  { source: 'ashby', slug: 'quicknode', displayName: 'Quicknode' }, // YC Winter 2021
  { source: 'ashby', slug: 'quindar', displayName: 'Quindar' }, // YC Summer 2022
  { source: 'ashby', slug: 'raindrop', displayName: 'Raindrop' }, // YC Winter 2024
  { source: 'ashby', slug: 'rallyuxr', displayName: 'Rally UXR' }, // YC Winter 2022
  { source: 'ashby', slug: 'reacher', displayName: 'Reacher' }, // YC Summer 2025
  { source: 'ashby', slug: 'ready', displayName: 'Ready' }, // YC Summer 2020
  { source: 'ashby', slug: 'realitydefender', displayName: 'Reality Defender' }, // YC Winter 2022
  { source: 'ashby', slug: 'reducto', displayName: 'Reducto' }, // YC Winter 2024
  { source: 'ashby', slug: 'replit', displayName: 'Replit' }, // YC W18
  { source: 'ashby', slug: 'replo', displayName: 'Replo' }, // YC Summer 2021
  { source: 'ashby', slug: 'rescale', displayName: 'Rescale' }, // YC Winter 2012
  { source: 'ashby', slug: 'revenuecat', displayName: 'RevenueCat' }, // YC Summer 2018
  { source: 'ashby', slug: 'roboflow', displayName: 'Roboflow' }, // YC Summer 2020
  { source: 'ashby', slug: 'rollstack', displayName: 'Rollstack' }, // YC W23
  { source: 'ashby', slug: 'runway', displayName: 'Runway' }, // YC Winter 2021
  { source: 'ashby', slug: 'rutter', displayName: 'Rutter' }, // YC S19
  { source: 'ashby', slug: 'ryvn', displayName: 'Ryvn' }, // YC Fall 2024
  { source: 'ashby', slug: 'safetykit', displayName: 'SafetyKit' }, // YC Summer 2023
  { source: 'ashby', slug: 'salespatriot', displayName: 'SalesPatriot' }, // YC Winter 2025
  { source: 'ashby', slug: 'salient', displayName: 'Salient' }, // YC W23
  { source: 'ashby', slug: 'shepherd', displayName: 'Shepherd' }, // YC Winter 2021
  { source: 'ashby', slug: 'shortstory', displayName: 'Short Story' }, // YC S19
  { source: 'ashby', slug: 'sieve', displayName: 'Sieve' }, // YC Winter 2022
  { source: 'ashby', slug: 'sift', displayName: 'Sift' }, // YC S11
  { source: 'ashby', slug: 'signoz', displayName: 'SigNoz' }, // YC Winter 2021
  { source: 'ashby', slug: 'simple-ai', displayName: 'Simple AI' }, // YC Summer 2024
  { source: 'ashby', slug: 'simplify', displayName: 'Simplify' }, // YC W21
  { source: 'ashby', slug: 'skylink', displayName: 'SkyLink' }, // YC Winter 2022
  { source: 'ashby', slug: 'slope', displayName: 'Slope' }, // YC Summer 2021
  { source: 'ashby', slug: 'sola', displayName: 'Sola' }, // YC Summer 2023
  { source: 'ashby', slug: 'solidroad', displayName: 'Solidroad' }, // YC Winter 2025
  { source: 'ashby', slug: 'speak', displayName: 'Speak' }, // YC Winter 2017
  { source: 'ashby', slug: 'spellbrush', displayName: 'Spellbrush' }, // YC W18
  { source: 'ashby', slug: 'sphere', displayName: 'Sphere' }, // YC Winter 2022
  { source: 'ashby', slug: 'spruceid', displayName: 'SpruceID' }, // YC Winter 2021
  { source: 'ashby', slug: 'stable', displayName: 'Stable' }, // YC Winter 2020
  { source: 'ashby', slug: 'stack-ai', displayName: 'Stack AI' }, // YC W23
  { source: 'ashby', slug: 'stepful', displayName: 'Stepful' }, // YC Summer 2021
  { source: 'ashby', slug: 'stream', displayName: 'Stream' }, // YC Summer 2022
  { source: 'ashby', slug: 'substack', displayName: 'Substack' }, // YC W18
  { source: 'ashby', slug: 'sully-ai', displayName: 'Sully.ai' }, // YC Summer 2021
  { source: 'ashby', slug: 'svix', displayName: 'Svix' }, // YC Winter 2021
  { source: 'ashby', slug: 'sweep', displayName: 'Sweep' }, // YC Summer 2023
  { source: 'ashby', slug: 'taktile', displayName: 'Taktile' }, // YC S20
  { source: 'ashby', slug: 'tandem', displayName: 'Tandem' }, // YC S24
  { source: 'ashby', slug: 'tavus', displayName: 'Tavus' }, // YC Summer 2021
  { source: 'ashby', slug: 'tenjin', displayName: 'Tenjin' }, // YC Summer 2014
  { source: 'ashby', slug: 'tennr', displayName: 'Tennr' }, // YC W23
  { source: 'ashby', slug: 'thera', displayName: 'Thera' }, // YC Summer 2022
  { source: 'ashby', slug: 'titan', displayName: 'Titan' }, // YC Summer 2018
  { source: 'ashby', slug: 'toma', displayName: 'Toma' }, // YC W24
  { source: 'ashby', slug: 'topline-pro', displayName: 'Topline Pro' }, // YC Winter 2021
  { source: 'ashby', slug: 'trm-labs', displayName: 'TRM Labs' }, // YC S19
  { source: 'ashby', slug: 'truthsystems', displayName: 'truthsystems' }, // YC Summer 2025
  { source: 'ashby', slug: 'tuesday-lab', displayName: 'Tuesday Lab' }, // YC Winter 2024
  { source: 'ashby', slug: 'turion-space', displayName: 'Turion Space' }, // YC Summer 2021
  { source: 'ashby', slug: 'twenty', displayName: 'Twenty' }, // YC Summer 2023
  { source: 'ashby', slug: 'ultra', displayName: 'Ultra' }, // YC Summer 2024
  { source: 'ashby', slug: 'upflow', displayName: 'Upflow' }, // YC Winter 2020
  { source: 'ashby', slug: 'uplane', displayName: 'Uplane' }, // YC Fall 2025
  { source: 'ashby', slug: 'vanta', displayName: 'Vanta' }, // YC W18
  { source: 'ashby', slug: 'vapi', displayName: 'Vapi' }, // YC Winter 2021
  { source: 'ashby', slug: 'vellum', displayName: 'Vellum' }, // YC Winter 2023
  { source: 'ashby', slug: 'versemedical', displayName: 'Verse Medical' }, // YC Summer 2018
  { source: 'ashby', slug: 'vetcove', displayName: 'Vetcove' }, // YC S16
  { source: 'ashby', slug: 'vitalize', displayName: 'Vitalize Care' }, // YC W23
  { source: 'ashby', slug: 'vooma', displayName: 'Vooma' }, // YC W23
  { source: 'ashby', slug: 'vori', displayName: 'Vori' }, // YC Winter 2020
  { source: 'ashby', slug: 'vorticity', displayName: 'Vorticity' }, // YC S19
  { source: 'ashby', slug: 'whatnot', displayName: 'Whatnot' }, // YC Winter 2020
  { source: 'ashby', slug: 'zapier', displayName: 'Zapier' }, // YC Summer 2012
  { source: 'ashby', slug: 'zip', displayName: 'Zip' }, // YC Summer 2020

  // ─── Ashby — topstartups.io (verified 2026-04-24) ───
  { source: 'ashby', slug: 'abridge', displayName: 'Abridge' },
  { source: 'ashby', slug: 'akasa', displayName: 'AKASA' },
  { source: 'ashby', slug: 'alchemy', displayName: 'Alchemy' },
  { source: 'ashby', slug: 'allium', displayName: 'Allium' },
  { source: 'ashby', slug: 'ambiencehealthcare', displayName: 'Ambience Healthcare' },
  { source: 'ashby', slug: 'armory', displayName: 'Armory' },
  { source: 'ashby', slug: 'asimov', displayName: 'Asimov' },
  { source: 'ashby', slug: 'avoca', displayName: 'Avoca' },
  { source: 'ashby', slug: 'base-power', displayName: 'Base Power' },
  { source: 'ashby', slug: 'benchling', displayName: 'Benchling' },
  { source: 'ashby', slug: 'bettercloud', displayName: 'BetterCloud' },
  { source: 'ashby', slug: 'brightwheel', displayName: 'Brightwheel' },
  { source: 'ashby', slug: 'built-robotics', displayName: 'Built Robotics' },
  { source: 'ashby', slug: 'bunch', displayName: 'Bunch' },
  { source: 'ashby', slug: 'cedar', displayName: 'Cedar' },
  { source: 'ashby', slug: 'centivo', displayName: 'Centivo' },
  { source: 'ashby', slug: 'charthop', displayName: 'ChartHop' },
  { source: 'ashby', slug: 'chief', displayName: 'Chief' },
  { source: 'ashby', slug: 'clickup', displayName: 'ClickUp' },
  { source: 'ashby', slug: 'cloudtrucks', displayName: 'CloudTrucks' },
  { source: 'ashby', slug: 'cocodelivery', displayName: 'Coco' },
  { source: 'ashby', slug: 'coder', displayName: 'Coder' },
  { source: 'ashby', slug: 'cognition', displayName: 'Cognition' },
  { source: 'ashby', slug: 'confluent', displayName: 'Confluent' },
  { source: 'ashby', slug: 'decagon', displayName: 'Decagon' },
  { source: 'ashby', slug: 'doppler', displayName: 'Doppler' },
  { source: 'ashby', slug: 'electric', displayName: 'Electric.ai' },
  { source: 'ashby', slug: 'ema', displayName: 'Ema' },
  { source: 'ashby', slug: 'envoy', displayName: 'Envoy' },
  { source: 'ashby', slug: 'foursquare', displayName: 'Foursquare' },
  { source: 'ashby', slug: 'fullstory', displayName: 'FullStory' },
  { source: 'ashby', slug: 'graphite', displayName: 'Graphite' },
  { source: 'ashby', slug: 'handshake', displayName: 'Handshake' },
  { source: 'ashby', slug: 'harvey', displayName: 'Harvey' },
  { source: 'ashby', slug: 'hinge-health', displayName: 'Hinge Health' },
  { source: 'ashby', slug: 'homebase', displayName: 'Homebase' },
  { source: 'ashby', slug: 'homebound', displayName: 'Homebound' },
  { source: 'ashby', slug: 'hyperscience', displayName: 'HyperScience' },
  { source: 'ashby', slug: 'illumio', displayName: 'Illumio' },
  { source: 'ashby', slug: 'infinite-machine', displayName: 'Infinite Machine' },
  { source: 'ashby', slug: 'infinitus', displayName: 'Infinitus' },
  { source: 'ashby', slug: 'insitro', displayName: 'insitro' },
  { source: 'ashby', slug: 'kernel', displayName: 'Kernel' },
  { source: 'ashby', slug: 'knoetic', displayName: 'Knoetic' },
  { source: 'ashby', slug: 'kong', displayName: 'Kong' },
  { source: 'ashby', slug: 'langchain', displayName: 'LangChain' },
  { source: 'ashby', slug: 'lemonade', displayName: 'Lemonade' },
  { source: 'ashby', slug: 'level', displayName: 'Level' },
  { source: 'ashby', slug: 'listenlabs', displayName: 'Listen Labs' },
  { source: 'ashby', slug: 'modal', displayName: 'Modal' },
  { source: 'ashby', slug: 'nuna', displayName: 'Nuna' },
  { source: 'ashby', slug: 'opensea', displayName: 'OpenSea' },
  { source: 'ashby', slug: 'orum', displayName: 'Orum' },
  { source: 'ashby', slug: 'passport', displayName: 'Passport' },
  { source: 'ashby', slug: 'persona', displayName: 'Persona' },
  { source: 'ashby', slug: 'phantom', displayName: 'Phantom' },
  { source: 'ashby', slug: 'pika', displayName: 'Pika' },
  { source: 'ashby', slug: 'prefect', displayName: 'Prefect' },
  { source: 'ashby', slug: 'primer', displayName: 'Primer' },
  { source: 'ashby', slug: 'propel', displayName: 'Propel' },
  { source: 'ashby', slug: 'radiant', displayName: 'Radiant' },
  { source: 'ashby', slug: 'reflect-orbital', displayName: 'Reflect Orbital' },
  { source: 'ashby', slug: 'socure', displayName: 'Socure' },
  { source: 'ashby', slug: 'saronic', displayName: 'Saronic' },
  { source: 'ashby', slug: 'semgrep', displayName: 'Semgrep' },
  { source: 'ashby', slug: 'sentilink', displayName: 'SentiLink' },
  { source: 'ashby', slug: 'sentry', displayName: 'Sentry' },
  { source: 'ashby', slug: 'shift', displayName: 'Shift' },
  { source: 'ashby', slug: 'skydio', displayName: 'Skydio' },
  { source: 'ashby', slug: 'sleeper', displayName: 'Sleeper' },
  { source: 'ashby', slug: 'slingshotai', displayName: 'Slingshot AI' },
  { source: 'ashby', slug: 'snapdocs', displayName: 'Snapdocs' },
  { source: 'ashby', slug: 'spoton', displayName: 'SpotOn' },
  { source: 'ashby', slug: 'sprig', displayName: 'Sprig' },
  { source: 'ashby', slug: 'sprinter-health', displayName: 'Sprinter Health' },
  { source: 'ashby', slug: 'stainlessapi', displayName: 'Stainless' },
  { source: 'ashby', slug: 'statsig', displayName: 'Statsig' },
  { source: 'ashby', slug: 'strava', displayName: 'Strava' },
  { source: 'ashby', slug: 'stytch', displayName: 'Stytch' },
  { source: 'ashby', slug: 'terminal', displayName: 'Terminal' },
  { source: 'ashby', slug: 'traba', displayName: 'Traba' },
  { source: 'ashby', slug: 'turquoise-health', displayName: 'Turquoise Health' },
  { source: 'ashby', slug: 'uipath', displayName: 'UiPath' },
  { source: 'ashby', slug: 'unit', displayName: 'Unit' },
  { source: 'ashby', slug: 'vesta', displayName: 'Vesta' },
  { source: 'ashby', slug: 'virtahealth', displayName: 'Virta Health' },
  { source: 'ashby', slug: 'vivun', displayName: 'Vivun' },
  { source: 'ashby', slug: 'workwhilejobs', displayName: 'WorkWhile' },
  { source: 'ashby', slug: 'wrapbook', displayName: 'Wrapbook' },

  // ─── Ashby — big-company additions (verified 2026-04-24) ────────────────
  { source: 'ashby', slug: 'cohere', displayName: 'Cohere' },
  { source: 'ashby', slug: 'snowflake', displayName: 'Snowflake' },

  // ─── Workday (big tech + enterprise) ─────────────────────────────────────
  { source: 'workday', slug: 'nvidia',     tenant: 'nvidia',     wd: '5',  site: 'NVIDIAExternalCareerSite', displayName: 'Nvidia' },
  { source: 'workday', slug: 'adobe',      tenant: 'adobe',      wd: '5',  site: 'external_experienced',    displayName: 'Adobe' },
  { source: 'workday', slug: 'paypal',     tenant: 'paypal',     wd: '1',  site: 'jobs',                    displayName: 'PayPal' },
  { source: 'workday', slug: 'salesforce', tenant: 'salesforce', wd: '12', site: 'External_Career_Site',    displayName: 'Salesforce' },
  { source: 'workday', slug: 'intel',      tenant: 'intel',      wd: '1',  site: 'External',                displayName: 'Intel' },
  { source: 'workday', slug: 'walmart',    tenant: 'walmart',    wd: '5',  site: 'WalmartExternal',         displayName: 'Walmart' },
  { source: 'workday', slug: 'accenture',  tenant: 'accenture',  wd: '103', site: 'AccentureCareers',       displayName: 'Accenture' },
  { source: 'workday', slug: 'boeing',     tenant: 'boeing',     wd: '1',   site: 'EXTERNAL_CAREERS',       displayName: 'Boeing' },
  { source: 'workday', slug: 'capitalone', tenant: 'capitalone', wd: '12',  site: 'Capital_One',            displayName: 'Capital One' },
  { source: 'workday', slug: 'mastercard', tenant: 'mastercard', wd: '1',   site: 'CorporateCareers',       displayName: 'Mastercard' },
  { source: 'workday', slug: 'redhat',     tenant: 'redhat',     wd: '5',   site: 'Jobs',                   displayName: 'Red Hat' },
  { source: 'workday', slug: 'samsung',    tenant: 'sec',        wd: '3',   site: 'Samsung_Careers',        displayName: 'Samsung Electronics' },
  { source: 'workday', slug: 'morganstanley', tenant: 'ms',      wd: '5',   site: 'External',               displayName: 'Morgan Stanley' },
  { source: 'workday', slug: 'gehealthcare',  tenant: 'gehc',    wd: '5',   site: 'GEHC_ExternalSite',      displayName: 'GE HealthCare' },

  // ─── Oracle HCM / Candidate Experience ───────────────────────────────────
  { source: 'oracle_hcm', slug: 'oracle', displayName: 'Oracle', apiHost: 'eeho.fa.us2.oraclecloud.com', siteNumber: 'CX_45001', uiBaseUrl: 'https://careers.oracle.com/en/sites/jobsearch' },
  { source: 'oracle_hcm', slug: 'jpmorgan-chase', displayName: 'JPMorgan Chase', apiHost: 'jpmc.fa.oraclecloud.com', siteNumber: 'CX_1001', uiBaseUrl: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001' },

  // ─── PCSX (Phenom Cloud) — same API shape as Microsoft ──────────────────
  { source: 'pcsx', slug: 'qualcomm', displayName: 'Qualcomm', apiBase: 'https://careers.qualcomm.com/api/pcsx/search', domain: 'qualcomm.com', applyUrlBase: 'https://careers.qualcomm.com/careers' },

  // ─── Capgemini (standalone job-stream API) ──────────────────────────────
  { source: 'capgemini', slug: 'capgemini', displayName: 'Capgemini' },

  // ─── Wipro (SAP SuccessFactors-backed in-house API) ─────────────────────
  { source: 'wipro', slug: 'wipro', displayName: 'Wipro' },

  // ─── Goldman Sachs (higher.gs.com GraphQL) ──────────────────────────────
  { source: 'goldman_sachs', slug: 'goldman-sachs', displayName: 'Goldman Sachs' },

  // ─── Single-tenant collectors ────────────────────────────────────────────
  { source: 'amazon',       displayName: 'Amazon' },
  { source: 'uber',         displayName: 'Uber' },
  { source: 'netflix',      displayName: 'Netflix' },
  // Microsoft: their new apply.careers.microsoft.com frontend fetches jobs
  // from a public /api/pcsx/search endpoint. No auth, no TLS workaround
  // needed — the earlier 404s were because we were targeting the wrong path.
  { source: 'microsoft',    displayName: 'Microsoft' },

  // ─── Community-curated GitHub new-grad lists ─────────────────────────────
  // These give us broad FAANG + enterprise coverage (Google, Apple, Meta,
  // Microsoft, Goldman Sachs, JP Morgan, SpaceX, Boeing, Lockheed, …) that
  // we can't reach through the companies' own career-site APIs.
  //
  // Same schema across both repos. Add more lists by dropping another entry.
  {
    source: 'ghlistings',
    slug: 'vanshb03-newgrad2027',
    displayName: 'vanshb03/New-Grad-2027',
    url: 'https://raw.githubusercontent.com/vanshb03/New-Grad-2027/dev/.github/scripts/listings.json',
  },
  {
    source: 'ghlistings',
    slug: 'simplify-newgrad',
    displayName: 'SimplifyJobs/New-Grad-Positions',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
  },

  // ─── YC startups via HN "Who is hiring?" ─────────────────────────────────
  // Pulls the last 2 monthly threads, parses "Company | Location | … | URL"
  // headers, and keeps only comments whose company matches a US-based YC
  // company currently marked `isHiring` in akshaybhalotia/yc_company_scraper.
  { source: 'hn_hiring', displayName: 'HN Who is hiring (YC US)' },
];

const CONFIG = {
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || './data/jobs.db',

  // Cron: every 2 hours at minute 0.
  collectCron: process.env.COLLECT_CRON || '0 */2 * * *',
  runOnStart: process.env.RUN_ON_START !== 'false',

  // Filters applied during collection. Toggle via env for quick iteration.
  filterUSOnly: process.env.FILTER_US !== 'false',
  filterSoftwareOnly: process.env.FILTER_SOFTWARE !== 'false',

  // Entry-level filter mode:
  //   'off'        – keep everything
  //   'permissive' – drop explicit senior/staff/principal/manager/II+ roles (DEFAULT)
  //   'strict'     – require an explicit entry-level signal (intern, new grad, I, associate…)
  entryLevelMode: process.env.ENTRY_LEVEL_MODE || 'permissive',

  // Retention: only keep jobs posted (or last seen) within the last N days.
  // Enforced at normalize time (dated rows older than window are rejected)
  // and again at the end of each collect run (post-upsert sweep).
  retentionDays: Number(process.env.RETENTION_DAYS || 30),

  requestTimeoutMs: 20_000,
  fetchConcurrency: 4, // parallel companies per run

  defaultPageSize: 50,
  maxPageSize: 200,
  cacheTtlMs: 30_000,
};

module.exports = { COMPANIES, CONFIG };
