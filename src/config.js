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
  { source: 'greenhouse', slug: 'apolloio', displayName: 'Apollo.io' }, // YC W16
  { source: 'greenhouse', slug: 'assemblyai', displayName: 'AssemblyAI' }, // YC Summer 2017
  { source: 'greenhouse', slug: 'astranis', displayName: 'Astranis' }, // YC W16
  { source: 'greenhouse', slug: 'attain', displayName: 'Attain' }, // YC Winter 2022
  { source: 'greenhouse', slug: 'axle', displayName: 'Axle' }, // YC Summer 2022
  { source: 'greenhouse', slug: 'billiontoone', displayName: 'BillionToOne' }, // YC Summer 2017
  { source: 'greenhouse', slug: 'bitmovin', displayName: 'Bitmovin' }, // YC S15
  { source: 'greenhouse', slug: 'checkr', displayName: 'Checkr' }, // YC S14
  { source: 'greenhouse', slug: 'coast', displayName: 'Coast' }, // YC Summer 2021
  { source: 'greenhouse', slug: 'daybreakhealth', displayName: 'Daybreak Health' }, // YC S20
  { source: 'greenhouse', slug: 'dots', displayName: 'Dots' }, // YC Summer 2021
  { source: 'greenhouse', slug: 'extend', displayName: 'Extend' }, // YC W23
  { source: 'greenhouse', slug: 'faire', displayName: 'Faire' }, // YC Winter 2017
  { source: 'greenhouse', slug: 'flexport', displayName: 'Flexport' }, // YC Winter 2014
  { source: 'greenhouse', slug: 'foundry', displayName: 'Foundry' }, // YC F24
  { source: 'greenhouse', slug: 'generalproximity', displayName: 'General Proximity' }, // YC Winter 2020
  { source: 'ashby', slug: 'gigs', displayName: 'Gigs' }, // YC Winter 2021; was greenhouse:gigs (404 since at least 2026-11-22)
  { source: 'greenhouse', slug: 'ginkgobioworks', displayName: 'Ginkgo Bioworks' }, // YC S14
  { source: 'greenhouse', slug: 'givecampus', displayName: 'GiveCampus' }, // YC S15
  { source: 'greenhouse', slug: 'gusto', displayName: 'Gusto' }, // YC Winter 2012
  { source: 'greenhouse', slug: 'hackerrank', displayName: 'HackerRank' }, // YC Summer 2011
  { source: 'greenhouse', slug: 'humaninterest', displayName: 'Human Interest' }, // YC S15
  { source: 'greenhouse', slug: 'instawork', displayName: 'Instawork' }, // YC S15
  { source: 'greenhouse', slug: 'kalshi', displayName: 'Kalshi' }, // YC Winter 2019
  { source: 'greenhouse', slug: 'keystone', displayName: 'Keystone' }, // YC Summer 2025
  { source: 'greenhouse', slug: 'lattice', displayName: 'Lattice' }, // YC W16
  { source: 'greenhouse', slug: 'lob', displayName: 'Lob' }, // YC Summer 2013
  { source: 'greenhouse', slug: 'maymobility', displayName: 'May Mobility' }, // YC Summer 2017
  { source: 'greenhouse', slug: 'meruhealth', displayName: 'Meru Health' }, // YC Summer 2018
  { source: 'greenhouse', slug: 'mixpanel', displayName: 'Mixpanel' }, // YC S09
  { source: 'greenhouse', slug: 'modernhealth', displayName: 'Modern Health' }, // YC W18
  { source: 'greenhouse', slug: 'momence', displayName: 'Momence' }, // YC S20
  { source: 'greenhouse', slug: 'nabis', displayName: 'Nabis' }, // YC Winter 2019
  { source: 'greenhouse', slug: 'usenourish', displayName: 'Nourish' }, // YC Winter 2021
  { source: 'greenhouse', slug: 'novacredit', displayName: 'Nova Credit' }, // YC S16
  { source: 'greenhouse', slug: 'odeko', displayName: 'Odeko' }, // YC S19
  { source: 'greenhouse', slug: 'pairteam', displayName: 'Pair Team' }, // YC S19
  { source: 'greenhouse', slug: 'papa', displayName: 'Papa' }, // YC Summer 2018
  { source: 'greenhouse', slug: 'pelago', displayName: 'Pelago' }, // YC W18
  { source: 'greenhouse', slug: 'postscript', displayName: 'Postscript' }, // YC Winter 2019
  { source: 'greenhouse', slug: 'prodigal', displayName: 'Prodigal' }, // YC Summer 2018
  { source: 'greenhouse', slug: 'qventus', displayName: 'Qventus' }, // YC Winter 2015
  { source: 'greenhouse', slug: 'reflex', displayName: 'Reflex' }, // YC Winter 2023
  { source: 'greenhouse', slug: 'regent', displayName: 'REGENT' }, // YC W21
  { source: 'greenhouse', slug: 'sendbird', displayName: 'Sendbird' }, // YC W16
  { source: 'greenhouse', slug: 'smartasset', displayName: 'SmartAsset' }, // YC Summer 2012
  { source: 'greenhouse', slug: 'spaceium', displayName: 'Spaceium Inc' }, // YC S24
  { source: 'greenhouse', slug: 'swayable', displayName: 'Swayable' }, // YC W18
  { source: 'greenhouse', slug: 'tempo', displayName: 'Tempo' }, // YC Winter 2015
  { source: 'greenhouse', slug: 'treasuryprime', displayName: 'Treasury Prime' }, // YC Winter 2018
  { source: 'greenhouse', slug: 'upkeep', displayName: 'UpKeep' }, // YC Winter 2017
  { source: 'greenhouse', slug: 'verse', displayName: 'Verse' }, // YC W22
  { source: 'greenhouse', slug: 'weave', displayName: 'Weave' }, // YC Winter 2025
  { source: 'greenhouse', slug: 'yuma', displayName: 'Yuma AI' }, // YC W23

  // ─── Greenhouse — topstartups.io (discovered by scripts/probe-topstartups.js, verified 2026-04-24) ───
  { source: 'greenhouse', slug: 'airtable', displayName: 'Airtable' },
  { source: 'greenhouse', slug: 'alloy', displayName: 'Alloy' },
  { source: 'greenhouse', slug: 'andurilindustries', displayName: 'Anduril Industries' },
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
  { source: 'greenhouse', slug: 'carta', displayName: 'Carta' },
  { source: 'greenhouse', slug: 'celonis', displayName: 'Celonis' },
  { source: 'greenhouse', slug: 'chainguard', displayName: 'Chainguard' },
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
  { source: 'greenhouse', slug: 'disco', displayName: 'Disco' },
  { source: 'greenhouse', slug: 'dominodatalab', displayName: 'Domino Data Lab' },
  { source: 'greenhouse', slug: 'druva', displayName: 'Druva' },
  { source: 'greenhouse', slug: 'dynotherapeutics', displayName: 'Dyno Therapeutics' },
  { source: 'greenhouse', slug: 'earnin', displayName: 'Earnin' },
  { source: 'greenhouse', slug: 'epicgames', displayName: 'Epic Games' },
  { source: 'greenhouse', slug: 'ethoslife', displayName: 'Ethos Life' },
  { source: 'greenhouse', slug: 'everlaw', displayName: 'Everlaw' },
  { source: 'greenhouse', slug: 'fireblocks', displayName: 'Fireblocks' },
  { source: 'greenhouse', slug: 'fivetran', displayName: 'Fivetran' },
  { source: 'greenhouse', slug: 'flockhomes', displayName: 'Flock Homes' },
  { source: 'greenhouse', slug: 'formationbio', displayName: 'Formation Bio' },
  { source: 'greenhouse', slug: 'forter', displayName: 'Forter' },
  { source: 'greenhouse', slug: 'forwardnetworks', displayName: 'Forward Networks' },
  { source: 'greenhouse', slug: 'freenome', displayName: 'Freenome' },
  { source: 'greenhouse', slug: 'glossier', displayName: 'Glossier' },
  { source: 'greenhouse', slug: 'gongio', displayName: 'Gong.io' },
  { source: 'greenhouse', slug: 'heygen', displayName: 'HeyGen' },
  { source: 'greenhouse', slug: 'honor', displayName: 'Honor' },
  { source: 'greenhouse', slug: 'hudl', displayName: 'Hudl' },
  { source: 'greenhouse', slug: 'imply', displayName: 'Imply' },
  { source: 'greenhouse', slug: 'intercom', displayName: 'Intercom' },
  { source: 'greenhouse', slug: 'juno', displayName: 'Juno' },
  { source: 'greenhouse', slug: 'komodohealth', displayName: 'Komodo Health' },
  { source: 'greenhouse', slug: 'kymeratherapeutics', displayName: 'Kymera Therapeutics' },
  { source: 'greenhouse', slug: 'labelbox', displayName: 'Labelbox' },
  { source: 'greenhouse', slug: 'launchdarkly', displayName: 'LaunchDarkly' },
  { source: 'greenhouse', slug: 'leaflink', displayName: 'LeafLink' },
  { source: 'greenhouse', slug: 'legalist', displayName: 'Legalist' },
  { source: 'greenhouse', slug: 'marqvision', displayName: 'MarqVision' },
  { source: 'greenhouse', slug: 'matik', displayName: 'Matik' },
  { source: 'greenhouse', slug: 'mavenclinic', displayName: 'Maven Clinic' },
  { source: 'greenhouse', slug: 'medium', displayName: 'Medium' },
  { source: 'greenhouse', slug: 'misfitsmarket', displayName: 'Misfits Market' },
  { source: 'greenhouse', slug: 'modernanimal', displayName: 'Modern Animal' },
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
  // Opendoor moved off Greenhouse to Rippling — the slug now 404s. Kept as a
  // comment rather than deleted so the migration is legible if their board
  // moves again. See the `rippling` entries below.
  // { source: 'greenhouse', slug: 'opendoor', displayName: 'Opendoor' },
  { source: 'greenhouse', slug: 'ophelia', displayName: 'Ophelia' },
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
  { source: 'greenhouse', slug: 'shopmonkey', displayName: 'Shopmonkey' },
  { source: 'greenhouse', slug: 'singlestore', displayName: 'SingleStore' },
  { source: 'greenhouse', slug: 'smithrx', displayName: 'SmithRx' },
  { source: 'greenhouse', slug: 'sumologic', displayName: 'Sumo Logic' },
  { source: 'greenhouse', slug: 'syndio', displayName: 'Syndio' },
  { source: 'greenhouse', slug: 'thanx', displayName: 'Thanx' },
  { source: 'greenhouse', slug: 'toast', displayName: 'Toast' },
  { source: 'greenhouse', slug: 'torq', displayName: 'Torq' },
  { source: 'greenhouse', slug: 'turing', displayName: 'Turing' },
  { source: 'greenhouse', slug: 'ujet', displayName: 'UJET' },
  { source: 'greenhouse', slug: 'upstart', displayName: 'Upstart' },
  { source: 'greenhouse', slug: 'vercel', displayName: 'Vercel' },
  { source: 'greenhouse', slug: 'verkada', displayName: 'Verkada' },
  { source: 'greenhouse', slug: 'virtru', displayName: 'Virtru' },
  { source: 'greenhouse', slug: 'vivodyne', displayName: 'Vivodyne' },
  { source: 'greenhouse', slug: 'wonderschool', displayName: 'Wonderschool' },
  { source: 'greenhouse', slug: 'workboard', displayName: 'Workboard' },
  { source: 'greenhouse', slug: 'workstream', displayName: 'Workstream' },
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
  { source: 'lever', slug: 'people-ai', displayName: 'People.ai' }, // YC S16
  { source: 'lever', slug: 'porter', displayName: 'Porter' }, // YC Summer 2020
  { source: 'lever', slug: 'postera', displayName: 'PostEra' }, // YC Winter 2020
  { source: 'lever', slug: 'prosper', displayName: 'Prosper' }, // YC Summer 2023
  { source: 'lever', slug: 'sapling', displayName: 'Sapling.ai' }, // YC Winter 2019
  { source: 'lever', slug: 'skio', displayName: 'Skio' }, // YC Summer 2020
  { source: 'lever', slug: 'skyways', displayName: 'Skyways' }, // YC Summer 2017
  { source: 'lever', slug: 'smartcuts', displayName: 'Smartcuts' }, // YC Winter 2021
  { source: 'lever', slug: 'snappr', displayName: 'Snappr' }, // YC Winter 2017
  { source: 'lever', slug: 'synapticure', displayName: 'Synapticure' }, // YC S20
  { source: 'lever', slug: 'teleo', displayName: 'Teleo' }, // YC Winter 2020
  { source: 'lever', slug: 'thunkable', displayName: 'Thunkable' }, // YC W16
  { source: 'lever', slug: 'tovala', displayName: 'Tovala' }, // YC W16
  { source: 'lever', slug: 'twodots', displayName: 'Two Dots' }, // YC Summer 2022
  { source: 'lever', slug: 'unusual', displayName: 'Unusual' }, // YC Fall 2024
  { source: 'lever', slug: 'voltalabs', displayName: 'Volta Labs' }, // YC Winter 2019
  { source: 'lever', slug: 'getzuma', displayName: 'Zuma' }, // YC Summer 2021

  // ─── Lever — topstartups.io (verified 2026-04-24) ───
  { source: 'lever', slug: 'alluxio', displayName: 'Alluxio' },
  { source: 'lever', slug: 'anchorage', displayName: 'Anchorage' },
  { source: 'lever', slug: 'basis', displayName: 'Basis' },
  { source: 'lever', slug: 'cents', displayName: 'Cents' },
  { source: 'lever', slug: 'cobaltrobotics', displayName: 'Cobalt Robotics' },
  { source: 'lever', slug: 'dollskill', displayName: 'Dolls Kill' },
  { source: 'lever', slug: 'doxel', displayName: 'Doxel' },
  { source: 'lever', slug: 'egenesisbio', displayName: 'eGenesis' },
  { source: 'lever', slug: 'finix', displayName: 'Finix' },
  { source: 'lever', slug: 'h1', displayName: 'H1' },
  { source: 'lever', slug: 'hermeus', displayName: 'Hermeus' },
  { source: 'lever', slug: 'houzz', displayName: 'Houzz' },
  { source: 'lever', slug: 'incorta', displayName: 'InCorta' },
  { source: 'lever', slug: 'tryjeeves', displayName: 'Jeeves' },
  { source: 'lever', slug: 'kariusdx', displayName: 'Karius' },
  { source: 'lever', slug: 'lessen', displayName: 'Lessen' },
  { source: 'lever', slug: 'lightship', displayName: 'Lightship' },
  { source: 'lever', slug: 'luxurypresence', displayName: 'Luxury Presence' },
  { source: 'lever', slug: 'osaro', displayName: 'Osaro' },
  { source: 'lever', slug: 'playbook', displayName: 'Playbook' },
  { source: 'lever', slug: 'pyka', displayName: 'Pyka' },
  { source: 'lever', slug: 'restaurant365', displayName: 'Restaurant365' },
  { source: 'lever', slug: 'rigetti', displayName: 'Rigetti Computing' },
  { source: 'lever', slug: 'secureframe', displayName: 'Secureframe' },
  { source: 'lever', slug: 'shieldai', displayName: 'Shield AI' },
  { source: 'lever', slug: 'snaplogic', displayName: 'SnapLogic' },
  { source: 'lever', slug: 'getsquire', displayName: 'Squire' },
  { source: 'lever', slug: 'supermove', displayName: 'Supermove' },
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
  { source: 'ashby', slug: 'auctor', displayName: 'Auctor' }, // YC Spring 2025
  { source: 'ashby', slug: 'aurelian', displayName: 'Aurelian' }, // YC Summer 2022
  { source: 'ashby', slug: 'authzed', displayName: 'authzed' }, // YC Winter 2021
  { source: 'ashby', slug: 'automat', displayName: 'Automat' }, // YC W23
  { source: 'ashby', slug: 'axle-health', displayName: 'Axle Health' }, // YC Winter 2021
  { source: 'ashby', slug: 'bankjoy', displayName: 'Bankjoy' }, // YC Winter 2015
  { source: 'ashby', slug: 'benepass', displayName: 'Benepass' }, // YC Winter 2020
  { source: 'ashby', slug: 'bild-ai', displayName: 'Bild AI' }, // YC Winter 2025
  { source: 'ashby', slug: 'bland', displayName: 'Bland AI' }, // YC Summer 2023
  { source: 'ashby', slug: 'blee', displayName: 'Blee' }, // YC Summer 2022
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
  { source: 'ashby', slug: 'coperniq', displayName: 'Coperniq' }, // YC W23
  { source: 'ashby', slug: 'corvus-robotics', displayName: 'Corvus Robotics' }, // YC S18
  { source: 'ashby', slug: 'cosine', displayName: 'Cosine' }, // YC W23
  { source: 'ashby', slug: 'credal', displayName: 'Credal.ai' }, // YC W23
  { source: 'ashby', slug: 'ctgt', displayName: 'CTGT' }, // YC Fall 2024
  { source: 'ashby', slug: 'curri', displayName: 'Curri' }, // YC S19
  { source: 'ashby', slug: 'decodahealth', displayName: 'Decoda Health' }, // YC Summer 2023
  { source: 'ashby', slug: 'deepgram', displayName: 'Deepgram' }, // YC W16
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
  { source: 'ashby', slug: 'fieldguide', displayName: 'Fieldguide' }, // YC Summer 2020
  { source: 'ashby', slug: 'finni-health', displayName: 'Finni Health' }, // YC W23
  { source: 'ashby', slug: 'firecrawl', displayName: 'Firecrawl' }, // YC Summer 2022
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
  { source: 'ashby', slug: 'mux', displayName: 'Mux' }, // YC W16
  { source: 'ashby', slug: 'nabla', displayName: 'Nabla Bio' }, // YC S20
  { source: 'ashby', slug: 'nango', displayName: 'Nango' }, // YC W23
  { source: 'ashby', slug: 'nash', displayName: 'Nash' }, // YC Summer 2021
  { source: 'ashby', slug: 'new-story', displayName: 'New Story' }, // YC Summer 2015
  { source: 'ashby', slug: 'notabene', displayName: 'Notabene' }, // YC Summer 2020
  { source: 'ashby', slug: 'novig', displayName: 'Novig' }, // YC Summer 2022
  { source: 'ashby', slug: 'nox-metals', displayName: 'Nox Metals' }, // YC Summer 2025
  { source: 'ashby', slug: 'numeral', displayName: 'Numeral' }, // YC W23
  { source: 'ashby', slug: 'odys-aviation', displayName: 'Odys Aviation' }, // YC Summer 2021
  { source: 'ashby', slug: 'offdeal', displayName: 'OffDeal' }, // YC W24
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
  { source: 'ashby', slug: 'svix', displayName: 'Svix' }, // YC Winter 2021
  { source: 'ashby', slug: 'sweep', displayName: 'Sweep' }, // YC Summer 2023
  { source: 'ashby', slug: 'taktile', displayName: 'Taktile' }, // YC S20
  { source: 'ashby', slug: 'tavus', displayName: 'Tavus' }, // YC Summer 2021
  { source: 'ashby', slug: 'tennr', displayName: 'Tennr' }, // YC W23
  { source: 'ashby', slug: 'thera', displayName: 'Thera' }, // YC Summer 2022
  { source: 'ashby', slug: 'titan', displayName: 'Titan' }, // YC Summer 2018
  { source: 'ashby', slug: 'topline-pro', displayName: 'Topline Pro' }, // YC Winter 2021
  { source: 'ashby', slug: 'trm-labs', displayName: 'TRM Labs' }, // YC S19
  { source: 'ashby', slug: 'turion-space', displayName: 'Turion Space' }, // YC Summer 2021
  { source: 'ashby', slug: 'twenty', displayName: 'Twenty' }, // YC Summer 2023
  { source: 'ashby', slug: 'ultra', displayName: 'Ultra' }, // YC Summer 2024
  { source: 'ashby', slug: 'upflow', displayName: 'Upflow' }, // YC Winter 2020
  { source: 'ashby', slug: 'uplane', displayName: 'Uplane' }, // YC Fall 2025
  { source: 'ashby', slug: 'vanta', displayName: 'Vanta' }, // YC W18
  { source: 'ashby', slug: 'vapi', displayName: 'Vapi' }, // YC Winter 2021
  { source: 'ashby', slug: 'versemedical', displayName: 'Verse Medical' }, // YC Summer 2018
  { source: 'ashby', slug: 'vetcove', displayName: 'Vetcove' }, // YC S16
  { source: 'ashby', slug: 'vitalize', displayName: 'Vitalize Care' }, // YC W23
  { source: 'ashby', slug: 'vooma', displayName: 'Vooma' }, // YC W23
  { source: 'ashby', slug: 'vori', displayName: 'Vori' }, // YC Winter 2020
  { source: 'ashby', slug: 'vorticity', displayName: 'Vorticity' }, // YC S19
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
  { source: 'ashby', slug: 'brightwheel', displayName: 'Brightwheel' },
  { source: 'ashby', slug: 'built-robotics', displayName: 'Built Robotics' },
  { source: 'ashby', slug: 'bunch', displayName: 'Bunch' },
  { source: 'ashby', slug: 'cedar', displayName: 'Cedar' },
  { source: 'ashby', slug: 'centivo', displayName: 'Centivo' },
  { source: 'ashby', slug: 'charthop', displayName: 'ChartHop' },
  { source: 'ashby', slug: 'chief', displayName: 'Chief' },
  { source: 'ashby', slug: 'clickup', displayName: 'ClickUp' },
  { source: 'ashby', slug: 'cocodelivery', displayName: 'Coco' },
  { source: 'ashby', slug: 'coder', displayName: 'Coder' },
  { source: 'ashby', slug: 'cognition', displayName: 'Cognition' },
  { source: 'ashby', slug: 'decagon', displayName: 'Decagon' },
  { source: 'ashby', slug: 'doppler', displayName: 'Doppler' },
  { source: 'ashby', slug: 'ema', displayName: 'Ema' },
  { source: 'ashby', slug: 'envoy', displayName: 'Envoy' },
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
  { source: 'ashby', slug: 'strava', displayName: 'Strava' },
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
  { source: 'workday', slug: 'accenture',  tenant: 'accenture',  wd: '103', site: 'AccentureCareers',       displayName: 'Accenture' },
  { source: 'workday', slug: 'boeing',     tenant: 'boeing',     wd: '1',   site: 'EXTERNAL_CAREERS',       displayName: 'Boeing' },
  { source: 'workday', slug: 'capitalone', tenant: 'capitalone', wd: '12',  site: 'Capital_One',            displayName: 'Capital One' },
  { source: 'workday', slug: 'mastercard', tenant: 'mastercard', wd: '1',   site: 'CorporateCareers',       displayName: 'Mastercard' },
  { source: 'workday', slug: 'redhat',     tenant: 'redhat',     wd: '5',   site: 'Jobs',                   displayName: 'Red Hat' },
  { source: 'workday', slug: 'samsung',    tenant: 'sec',        wd: '3',   site: 'Samsung_Careers',        displayName: 'Samsung Electronics' },
  { source: 'workday', slug: 'morganstanley', tenant: 'ms',      wd: '5',   site: 'External',               displayName: 'Morgan Stanley' },
  { source: 'workday', slug: 'gehealthcare',  tenant: 'gehc',    wd: '5',   site: 'GEHC_ExternalSite',      displayName: 'GE HealthCare' },
  // Added 2026-08-08. eBay is a large H-1B sponsor (952 approvals over the last
  // 2 FY per the USCIS Data Hub) that was missing entirely. tenant/wd/site are
  // not guessable — this came from probing the CxS endpoint directly and
  // confirming it returns jobs. Do the same for any new entry rather than
  // guessing; a wrong site path just 404s silently.
  { source: 'workday', slug: 'ebay',          tenant: 'ebay',       wd: '5',  site: 'apply',                 displayName: 'eBay' },

  // Added 2026-08-08 from a coverage gap analysis against the USCIS FY2023
  // H-1B Data Hub, filtered to the metros this board targets (TX, NJ, Atlanta,
  // SF Bay, NY, Boston). Approval counts below are FY2023 for that metro.
  //
  // These are all large sponsors with no Greenhouse/Lever/Ashby board — of 43
  // top missing sponsors probed, only 4 had one. Enterprise hiring lives on
  // Workday, Eightfold, Phenom, iCIMS and Avature, which is the structural
  // reason coverage skewed toward startups.
  //
  // tenant/wd/site were read off each careers site and then verified against
  // the CxS endpoint. Do the same for any addition — a wrong site path 404s
  // silently and the company just contributes nothing forever.
  { source: 'workday', slug: 'paloaltonetworks', tenant: 'paloaltonetworks', wd: '5', site: 'panwexternalcareers', displayName: 'Palo Alto Networks' }, // SF Bay, 159
  { source: 'workday', slug: 'autodesk',       tenant: 'autodesk',   wd: '1',  site: 'Ext',                   displayName: 'Autodesk' },        // SF Bay, 102
  { source: 'workday', slug: 'hpe',            tenant: 'hpe',        wd: '5',  site: 'Jobsathpe',             displayName: 'HPE' },             // Texas, 162 (also hosts Juniper post-acquisition)
  { source: 'workday', slug: 'statestreet',    tenant: 'statestreet', wd: '1', site: 'Global',                displayName: 'State Street' },    // Boston, 69
  { source: 'workday', slug: 'homedepot',      tenant: 'homedepot',  wd: '5',  site: 'CareerDepot',           displayName: 'Home Depot' },      // Atlanta, 122
  { source: 'workday', slug: 'usaa',           tenant: 'usaa',       wd: '1',  site: 'USAAJOBSWD',            displayName: 'USAA' },            // Texas, 72
  { source: 'workday', slug: 'prudential',     tenant: 'pru',        wd: '5',  site: 'Careers',               displayName: 'Prudential' },      // NJ, 46
  { source: 'workday', slug: 'manhattanassoc', tenant: 'manh',       wd: '5',  site: 'External',              displayName: 'Manhattan Associates' }, // Atlanta, 45

  // ── schema.org JobPosting via sitemap (see src/collectors/jsonld.js) ────────
  // For career sites with no public ATS API. Reads the sitemap the site
  // publishes for crawlers, then the JSON-LD JobPosting block on each detail
  // page. Check robots.txt before adding anyone here — Intuit disallows
  // /search-jobs/ (its internal search API), which is why this route exists
  // instead. 1,063 H-1B approvals over the last 2 FY per the USCIS Data Hub.
  { source: 'jsonld', slug: 'intuit', displayName: 'Intuit',
    sitemapUrl: 'https://jobs.intuit.com/sitemap.xml', jobPath: '/job/' },

  // ── Adzuna aggregator (see src/collectors/adzuna.js) ───────────────────────
  // Discovery-only fallback for employers with no reachable public board.
  // No-ops unless ADZUNA_APP_ID / ADZUNA_APP_KEY are set, so these entries are
  // inert until credentials exist. Adzuna returns only a description snippet,
  // so these rows arrive with an empty description — sponsorship falls back to
  // the USCIS company lookup and `restriction` stays '' until a detail-page
  // enrichment pass fills the text in.
  // Cisco left this list on 2026-11-02: it has a Workday site after all
  // (cisco.wd5 Cisco_Careers, below with the probe-boards.js entries).
  { source: 'adzuna', slug: 'tesla',    displayName: 'Tesla',    company: 'Tesla' },
  { source: 'adzuna', slug: 'qualcomm', displayName: 'Qualcomm', company: 'Qualcomm' },
  { source: 'adzuna', slug: 'ibm',      displayName: 'IBM',      company: 'IBM' },
  // Wayfair and LinkedIn have no other route: wayfair.com/careers sits behind a
  // PerimeterX challenge and LinkedIn posts only on linkedin.com (see HANDOFF).
  { source: 'adzuna', slug: 'wayfair',  displayName: 'Wayfair',  company: 'Wayfair' },
  { source: 'adzuna', slug: 'linkedin', displayName: 'LinkedIn', company: 'LinkedIn' },

  // ─── Oracle HCM / Candidate Experience ───────────────────────────────────
  { source: 'oracle_hcm', slug: 'oracle', displayName: 'Oracle', apiHost: 'eeho.fa.us2.oraclecloud.com', siteNumber: 'CX_45001', uiBaseUrl: 'https://careers.oracle.com/en/sites/jobsearch' },
  { source: 'oracle_hcm', slug: 'jpmorgan-chase', displayName: 'JPMorgan Chase', apiHost: 'jpmc.fa.oraclecloud.com', siteNumber: 'CX_1001', uiBaseUrl: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001' },

  // ─── PCSX (Phenom Cloud) — same API shape as Microsoft ──────────────────
  { source: 'pcsx', slug: 'qualcomm', displayName: 'Qualcomm', apiBase: 'https://careers.qualcomm.com/api/pcsx/search', domain: 'qualcomm.com', applyUrlBase: 'https://careers.qualcomm.com/careers' },

  // Capgemini (src/collectors/capgemini.js) is no longer collected — owner's
  // call, 2026-10-31. See EXCLUDED_EMPLOYERS in clearance.js.

  // ─── Wipro (SAP SuccessFactors-backed in-house API) ─────────────────────
  { source: 'wipro', slug: 'wipro', displayName: 'Wipro' },

  // ─── Goldman Sachs (higher.gs.com GraphQL) ──────────────────────────────
  { source: 'goldman_sachs', slug: 'goldman-sachs', displayName: 'Goldman Sachs' },

  // ─── Single-tenant collectors ────────────────────────────────────────────
  { source: 'amazon',       displayName: 'Amazon' },
  // Apple: plain HTTP against jobs.apple.com's embedded page data
  // (src/collectors/apple.js). Replaces the Playwright target, which got 0 rows.
  { source: 'apple',        displayName: 'Apple' },
  { source: 'uber',         displayName: 'Uber' },
  // Microsoft: their new apply.careers.microsoft.com frontend fetches jobs
  // from a public /api/pcsx/search endpoint. No auth, no TLS workaround
  // needed — the earlier 404s were because we were targeting the wrong path.
  { source: 'microsoft',    displayName: 'Microsoft' },

  // ─── Eightfold AI tenants (see src/collectors/eightfold.js) ──────────────
  // Netflix is also Eightfold (src/collectors/netflix.js) but is no longer
  // collected — owner's call, 2026-10-31. See EXCLUDED_EMPLOYERS in clearance.js.
  //
  // Discovered 2026-08-13 by sweeping `{slug}.eightfold.ai` and vanity career
  // hosts. Most tenants are NOT reachable: Nutanix and Juniper 404, Micron,
  // Dolby and Vodafone return 403 (the tenant disabled anonymous API access — a
  // browser user-agent does not help). Don't re-probe those.
  //
  // Keep this list short on purpose. Eightfold rate-limits by IP across every
  // tenant at once, so each addition raises the odds of a 403 for all of them —
  // see the rate-limit note at the top of src/collectors/eightfold.js.
  //
  // NetApp: 273 H-1B approvals over the last 2 FY per the USCIS Data Hub, and
  // ~47 software candidates per run. Worth its request budget.
  //
  // Bayer was probed and rejected, not overlooked: 626 postings but only one
  // software title in the whole catalogue (it's a pharma/agri employer), so it
  // cost ~63 requests per run for ~1 row. Don't re-add it.
  { source: 'eightfold', slug: 'netapp', displayName: 'NetApp',
    apiBase: 'https://netapp.eightfold.ai/api/apply/v2/jobs', domain: 'netapp.com' },

  // ─── SmartRecruiters (discovered 2026-08-13, see src/collectors/smartrecruiters.js) ───
  // Found by scripts/probe-smartrecruiters.js, which walks the USCIS sponsor
  // list in descending approval order — so every entry here is a confirmed
  // H-1B sponsor, not a guess. Counts are US postings / H-1B approvals over the
  // last 2 FY.
  //
  // Slugs are case-insensitive but otherwise exact, and there is no company
  // search endpoint, so always add via the probe rather than by hand.
  { source: 'smartrecruiters', slug: 'abbvie', displayName: 'AbbVie' },                    // 1057 US, 303 approvals
  { source: 'smartrecruiters', slug: 'intuitive', displayName: 'Intuitive' },              // 384 US, 339 approvals
  { source: 'smartrecruiters', slug: 'servicenow', displayName: 'ServiceNow' },            // 294 US, 849 approvals
  { source: 'smartrecruiters', slug: 'BoschGroup', displayName: 'Bosch Group' },           // 288 US, 188 approvals
  { source: 'smartrecruiters', slug: 'harvarduniversity', displayName: 'Harvard University' }, // 252 US, 291 approvals
  { source: 'smartrecruiters', slug: 'aristanetworks', displayName: 'Arista Networks' },   // 112 US, 182 approvals
  { source: 'smartrecruiters', slug: 'westerndigital', displayName: 'Western Digital' },   // 71 US, 286 approvals
  { source: 'smartrecruiters', slug: 'microchip', displayName: 'Microchip' },              // 7 US, 143 approvals
  //
  // Deliberately NOT added, though the probe found a live board for each — all
  // had 1-3 US postings, i.e. a vestigial or secondary board that isn't where
  // the company actually hires. Re-probe before adding any of them:
  //   uber, wayfair          — already covered by their own collectors
  //   visa (883 approvals)   — resolves HANDOFF's "no confirmed endpoint" note:
  //                            Visa's SmartRecruiters board exists but is
  //                            effectively empty, so it stays uncovered
  //   atos-syntel, natsoftcorporation, nisum, irissoftware, teladochealth
  //   robertbosch            — a near-empty duplicate of BoschGroup above,
  //                            which is the real board (288 US postings)

  // ─── H-1B sponsors found by scripts/discover-sponsors.js (2026-10-31) ─────
  // From the 1,412 USCIS sponsors with >= 50 approvals that the board didn't
  // cover. Workday tenants were found via their robots.txt site list; the
  // rest from the ATS linked on the employer's careers page. Each entry below
  // was collected once and produced at least one kept row. displayName is the
  // USCIS petitioner name on purpose — it is what the sponsorship lookup keys
  // on; a prettier name would turn these rows UNKNOWN.
  { source: 'workday', slug: 'guidehouse-external', tenant: 'guidehouse', wd: '1', site: 'External', displayName: 'Guidehouse' },  // 47 kept on 2026-10-31, 68 H-1B approvals
  { source: 'workday', slug: 'comcast-comcast_careers', tenant: 'comcast', wd: '115', site: 'Comcast_Careers', displayName: 'Comcast Cable Communications' },  // 19 kept on 2026-10-31, 948 H-1B approvals
  { source: 'workday', slug: 'remitly-remitly_careers', tenant: 'remitly', wd: '5', site: 'Remitly_Careers', displayName: 'Remitly' },  // 17 kept on 2026-10-31, 57 H-1B approvals
  { source: 'workday', slug: 'visa-visa', tenant: 'visa', wd: '5', site: 'Visa', displayName: 'Visa' },  // 11 kept on 2026-10-31, 526 H-1B approvals
  { source: 'workday', slug: 'usbank-us_bank_careers', tenant: 'usbank', wd: '1', site: 'US_Bank_Careers', displayName: 'US Bank National Association' },  // 10 kept on 2026-10-31, 1007 H-1B approvals
  { source: 'workday', slug: 'blackrock-blackrock_professional', tenant: 'blackrock', wd: '1', site: 'BlackRock_Professional', displayName: 'Blackrock Financial Management' },  // 9 kept on 2026-10-31, 487 H-1B approvals
  { source: 'workday', slug: 'workday-workday', tenant: 'workday', wd: '5', site: 'Workday', displayName: 'Workday' },  // 15 kept on 2026-10-31, 581 H-1B approvals
  { source: 'workday', slug: 'cigna-cignacareers', tenant: 'cigna', wd: '5', site: 'cignacareers', displayName: 'Express Scripts Services' },  // 7 kept on 2026-10-31, 75 H-1B approvals
  { source: 'workday', slug: 'vizient-vizient_careers', tenant: 'vizient', wd: '1', site: 'Vizient_Careers', displayName: 'Vizient' },  // 6 kept on 2026-10-31, 73 H-1B approvals
  { source: 'workday', slug: 'toyota-tmna', tenant: 'toyota', wd: '503', site: 'TMNA', displayName: 'Toyota' },  // 6 kept on 2026-10-31, 50 H-1B approvals
  { source: 'workday', slug: 'humana-humana_external_career_site', tenant: 'humana', wd: '5', site: 'Humana_External_Career_Site', displayName: 'Humana' },  // 5 kept on 2026-10-31, 336 H-1B approvals
  { source: 'workday', slug: 'fractal-careers', tenant: 'fractal', wd: '1', site: 'Careers', displayName: 'Fractal Analytics' },  // 5 kept on 2026-10-31, 95 H-1B approvals
  { source: 'workday', slug: 'expedia-search', tenant: 'expedia', wd: '108', site: 'search', displayName: 'Expedia' },  // 4 kept on 2026-10-31, 784 H-1B approvals
  { source: 'workday', slug: 'crowdstrike-crowdstrikecareers', tenant: 'crowdstrike', wd: '5', site: 'crowdstrikecareers', displayName: 'Crowdstrike' },  // 4 kept on 2026-10-31, 99 H-1B approvals
  { source: 'workday', slug: 'verily-verily_careers', tenant: 'verily', wd: '1', site: 'Verily_Careers', displayName: 'Verily Life Sciences' },  // 4 kept on 2026-10-31, 97 H-1B approvals
  { source: 'workday', slug: 'rockwellautomation-external_rockwell_automation', tenant: 'rockwellautomation', wd: '1', site: 'External_Rockwell_Automation', displayName: 'Rockwell Automation' },  // 4 kept on 2026-10-31, 90 H-1B approvals
  { source: 'workday', slug: 'novartis-novartis_careers', tenant: 'novartis', wd: '3', site: 'Novartis_Careers', displayName: 'Novartis Pharmaceuticals' },  // 4 kept on 2026-10-31, 84 H-1B approvals
  { source: 'workday', slug: 'genpact-campussite', tenant: 'genpact', wd: '108', site: 'campussite', displayName: 'Genpact' },  // 3 kept on 2026-10-31, 249 H-1B approvals
  { source: 'workday', slug: 'gartner-ext', tenant: 'gartner', wd: '5', site: 'EXT', displayName: 'Gartner' },  // 3 kept on 2026-10-31, 90 H-1B approvals
  { source: 'workday', slug: 'syneoshealth-syneos_health_external_site', tenant: 'syneoshealth', wd: '12', site: 'Syneos_Health_External_Site', displayName: 'Syneos Health' },  // 3 kept on 2026-10-31, 73 H-1B approvals
  { source: 'workday', slug: 'blackstone-blackstone_careers', tenant: 'blackstone', wd: '1', site: 'Blackstone_Careers', displayName: 'Blackstone' },  // 3 kept on 2026-10-31, 68 H-1B approvals
  { source: 'workday', slug: 'tapestry-tapestry_careers', tenant: 'tapestry', wd: '108', site: 'Tapestry_Careers', displayName: 'Tapestry' },  // 3 kept on 2026-10-31, 52 H-1B approvals
  { source: 'workday', slug: 'copart-copart', tenant: 'copart', wd: '12', site: 'Copart', displayName: 'Copart' },  // 2 kept on 2026-10-31, 83 H-1B approvals
  { source: 'greenhouse', slug: 'natera', displayName: 'Natera' },  // 2 kept on 2026-10-31, 81 H-1B approvals
  { source: 'workday', slug: 'ptc-ptc', tenant: 'ptc', wd: '1', site: 'PTC', displayName: 'PTC' },  // 2 kept on 2026-10-31, 80 H-1B approvals
  { source: 'workday', slug: 'costar-costar_campus', tenant: 'costar', wd: '1', site: 'Costar_Campus', displayName: 'Costar Realty Information' },  // 2 kept on 2026-10-31, 73 H-1B approvals
  { source: 'workday', slug: 'servicetitan-servicetitan', tenant: 'servicetitan', wd: '1', site: 'ServiceTitan', displayName: 'Servicetitan' },  // 2 kept on 2026-10-31, 65 H-1B approvals
  { source: 'workday', slug: 'synechron-synechroncareers', tenant: 'synechron', wd: '1', site: 'SynechronCareers', displayName: 'Synechron' },  // 1 kept on 2026-10-31, 755 H-1B approvals
  { source: 'workday', slug: 'elevancehealth-ant', tenant: 'elevancehealth', wd: '1', site: 'ANT', displayName: 'Anthem' },  // 1 kept on 2026-10-31, 660 H-1B approvals
  { source: 'workday', slug: 'teladoc-teladochealth_is_hiring', tenant: 'teladoc', wd: '503', site: 'teladochealth_is_hiring', displayName: 'Teladoc Health' },  // 1 kept on 2026-10-31, 209 H-1B approvals
  { source: 'workday', slug: 'wk-external', tenant: 'wk', wd: '3', site: 'External', displayName: 'Wolters Kluwer United States' },  // 1 kept on 2026-10-31, 167 H-1B approvals
  { source: 'workday', slug: 'quantiphi-careers_at_quantiphi', tenant: 'quantiphi', wd: '1', site: 'Careers_at_Quantiphi', displayName: 'Quantiphi' },  // 1 kept on 2026-10-31, 100 H-1B approvals
  { source: 'workday', slug: 'westernunion-westernunionjobs', tenant: 'westernunion', wd: '5', site: 'WesternUnionJobs', displayName: 'Western Union' },  // 1 kept on 2026-10-31, 99 H-1B approvals
  { source: 'workday', slug: 'capgroup-capitalgroupcareers', tenant: 'capgroup', wd: '1', site: 'capitalgroupcareers', displayName: 'Capital Group Companies Global' },  // 1 kept on 2026-10-31, 98 H-1B approvals
  { source: 'workday', slug: 'smithnephew-external', tenant: 'smithnephew', wd: '5', site: 'External', displayName: 'Smith Nephew' },  // 1 kept on 2026-10-31, 77 H-1B approvals
  { source: 'workday', slug: 'vizient-vizient_careers_insourcing_acquisition', tenant: 'vizient', wd: '1', site: 'vizient_careers_insourcing_acquisition', displayName: 'Vizient' },  // 1 kept on 2026-10-31, 73 H-1B approvals
  { source: 'workday', slug: 'jabil-jabil_careers', tenant: 'jabil', wd: '5', site: 'Jabil_Careers', displayName: 'Jabil' },  // 1 kept on 2026-10-31, 69 H-1B approvals
  { source: 'workday', slug: 'cdk-cdk', tenant: 'cdk', wd: '1', site: 'CDK', displayName: 'CDK Global' },  // 1 kept on 2026-10-31, 59 H-1B approvals
  { source: 'workday', slug: 'micron-external', tenant: 'micron', wd: '1', site: 'External', displayName: 'Micron' },  // 6 kept on 2026-10-31, 489 H-1B approvals
  { source: 'workday', slug: 'kla-annarbor', tenant: 'kla', wd: '1', site: 'AnnArbor', displayName: 'KLA' },  // 5 kept on 2026-10-31, 369 H-1B approvals
  { source: 'workday', slug: 'vanguard-vanguard_external', tenant: 'vanguard', wd: '5', site: 'vanguard_external', displayName: 'Vanguard' },  // 17 kept on 2026-10-31, 369 H-1B approvals
  { source: 'workday', slug: 'nxp-careers', tenant: 'nxp', wd: '3', site: 'careers', displayName: 'NXP' },  // 4 kept on 2026-10-31, 226 H-1B approvals
  { source: 'workday', slug: 'mckesson-external_careers', tenant: 'mckesson', wd: '3', site: 'External_Careers', displayName: 'Mckesson' },  // 10 kept on 2026-10-31, 147 H-1B approvals
  { source: 'workday', slug: 'zebra-zebra_careers', tenant: 'zebra', wd: '501', site: 'Zebra_careers', displayName: 'Zebra' },  // 8 kept on 2026-10-31, 126 H-1B approvals
  { source: 'workday', slug: 'astrazeneca-careers', tenant: 'astrazeneca', wd: '3', site: 'Careers', displayName: 'Astrazeneca Pharmaceuticals' },  // 1 kept on 2026-10-31, 115 H-1B approvals
  { source: 'workday', slug: 'agilent-agilent_careers', tenant: 'agilent', wd: '5', site: 'Agilent_Careers', displayName: 'Agilent' },  // 2 kept on 2026-10-31, 79 H-1B approvals
  { source: 'workday', slug: 'myhrhome-onemaincareers', tenant: 'myhrhome', wd: '1', site: 'OneMainCareers', displayName: 'Onemain General Services' },  // 1 kept on 2026-10-31, 79 H-1B approvals
  { source: 'workday', slug: 'philips-jobs-and-careers', tenant: 'philips', wd: '3', site: 'jobs-and-careers', displayName: 'Philips North' },  // 2 kept on 2026-10-31, 77 H-1B approvals
  { source: 'workday', slug: 'valeo-valeo_jobs', tenant: 'valeo', wd: '3', site: 'valeo_jobs', displayName: 'Valeo North' },  // 1 kept on 2026-10-31, 72 H-1B approvals
  { source: 'workday', slug: 'tempus-tempus_careers', tenant: 'tempus', wd: '5', site: 'Tempus_Careers', displayName: 'Tempus' },  // 5 kept on 2026-10-31, 59 H-1B approvals
  { source: 'workday', slug: 'tempus-ambry_careers', tenant: 'tempus', wd: '5', site: 'Ambry_Careers', displayName: 'Tempus' },  // 1 kept on 2026-10-31, 59 H-1B approvals
  { source: 'greenhouse', slug: 'galaxydigitalservices', displayName: 'Galaxy' },  // 1 kept on 2026-10-31, 56 H-1B approvals
  { source: 'workday', slug: 'sailpoint-sailpoint', tenant: 'sailpoint', wd: '1', site: 'SailPoint', displayName: 'Sailpoint' },  // 1 kept on 2026-10-31, 54 H-1B approvals

  { source: 'workday', slug: 'travelers-external', tenant: 'travelers', wd: '5', site: 'External', displayName: 'Travelers Indemnity' },  // 21 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'generalmotors-careers_gm', tenant: 'generalmotors', wd: '5', site: 'Careers_GM', displayName: 'General Motors' },  // 16 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'northeastern-careers', tenant: 'northeastern', wd: '1', site: 'careers', displayName: 'Northeastern University' },  // 11 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'ncr-ext_us', tenant: 'ncr', wd: '1', site: 'ext_us', displayName: 'NCR' },  // 10 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'abbott-abbottcareers', tenant: 'abbott', wd: '5', site: 'abbottcareers', displayName: 'Abbott Laboratories' },  // 10 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'abbott-abbottcareers2', tenant: 'abbott', wd: '5', site: 'abbottcareers2', displayName: 'Abbott Laboratories' },  // 10 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'trimble-trimblecareers', tenant: 'trimble', wd: '1', site: 'TrimbleCareers', displayName: 'Trimble' },  // 10 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'hitachi-hitachi', tenant: 'hitachi', wd: '1', site: 'hitachi', displayName: 'Hitachi Vantara' },  // 9 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'broadcom-external_career', tenant: 'broadcom', wd: '1', site: 'External_Career', displayName: 'Broadcom' },  // 9 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'allstate-allstate_careers', tenant: 'allstate', wd: '5', site: 'allstate_careers', displayName: 'Allstate Insurance' },  // 7 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'citi-2', tenant: 'citi', wd: '5', site: '2', displayName: 'Citigroup Global Markets' },  // 6 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'dxctechnology-dxcjobs', tenant: 'dxctechnology', wd: '1', site: 'DXCJobs', displayName: 'DXC Technology Services' },  // 6 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'lplfinancial-external', tenant: 'lplfinancial', wd: '1', site: 'External', displayName: 'LPL Financial' },  // 6 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'globalfoundries-external', tenant: 'globalfoundries', wd: '1', site: 'External', displayName: 'Globalfoundries' },  // 5 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'embryriddle-external', tenant: 'embryriddle', wd: '1', site: 'External', displayName: 'Embry Riddle Aeronautical University' },  // 5 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'massgeneralbrigham-mgbexternal', tenant: 'massgeneralbrigham', wd: '1', site: 'MGBExternal', displayName: 'Mass General Brigham Incorporated' },  // 5 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'amgen-careers', tenant: 'amgen', wd: '1', site: 'Careers', displayName: 'Amgen' },  // 4 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'cardinalhealth-ext', tenant: 'cardinalhealth', wd: '1', site: 'EXT', displayName: 'Cardinal Health' },  // 4 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'ntrs-northerntrust', tenant: 'ntrs', wd: '1', site: 'northerntrust', displayName: 'Northern Trust' },  // 4 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'nationwide-nationwide_career', tenant: 'nationwide', wd: '1', site: 'Nationwide_Career', displayName: 'Nationwide Insurance' },  // 4 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'medtronic-medtroniccareers', tenant: 'medtronic', wd: '1', site: 'MedtronicCareers', displayName: 'Medtronic' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'transunion-transunion', tenant: 'transunion', wd: '5', site: 'TransUnion', displayName: 'Transunion' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'zillow-zillow_group_external', tenant: 'zillow', wd: '5', site: 'Zillow_Group_External', displayName: 'Zillow' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'analogdevices-external', tenant: 'analogdevices', wd: '1', site: 'External', displayName: 'Analog Devices' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'jci-jci', tenant: 'jci', wd: '5', site: 'JCI', displayName: 'Johnson Controls' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'highmarkhealth-highmark', tenant: 'highmarkhealth', wd: '1', site: 'highmark', displayName: 'Highmark Health' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'jll-jllcareers', tenant: 'jll', wd: '1', site: 'jllcareers', displayName: 'Jones Lang Lasalle' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'invesco-ivz', tenant: 'invesco', wd: '1', site: 'IVZ', displayName: 'Invesco Group Services' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'brunswick-search', tenant: 'brunswick', wd: '1', site: 'search', displayName: 'Brunswick' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'etsy-etsy_careers', tenant: 'etsy', wd: '5', site: 'Etsy_Careers', displayName: 'Etsy' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'draftkings-draftkings', tenant: 'draftkings', wd: '1', site: 'DraftKings', displayName: 'Draftkings' },  // 3 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'cadence-external_careers', tenant: 'cadence', wd: '1', site: 'External_Careers', displayName: 'Cadence Design' },  // 2 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'cadence-univ_careers', tenant: 'cadence', wd: '1', site: 'Univ_Careers', displayName: 'Cadence Design' },  // 2 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'bristolmyerssquibb-bms', tenant: 'bristolmyerssquibb', wd: '5', site: 'BMS', displayName: 'Bristol Myers Squibb' },  // 2 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'broadridge-careers', tenant: 'broadridge', wd: '5', site: 'Careers', displayName: 'Broadridge Financial' },  // 2 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'modernatx-m_tx', tenant: 'modernatx', wd: '1', site: 'M_tx', displayName: 'Modernatx' },  // 2 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'catalent-external', tenant: 'catalent', wd: '1', site: 'External', displayName: 'Catalent Pharma' },  // 2 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'flextronics-careers', tenant: 'flextronics', wd: '1', site: 'Careers', displayName: 'Flextronics' },  // 2 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'dowjones-dow_jones_career', tenant: 'dowjones', wd: '1', site: 'Dow_Jones_Career', displayName: 'DOW Jones' },  // 2 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'jadeglobal-jade_careers', tenant: 'jadeglobal', wd: '5', site: 'Jade_Careers', displayName: 'Jade Global' },  // 2 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'target-targetcareers', tenant: 'target', wd: '5', site: 'targetcareers', displayName: 'Target Enterprise' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'marvell-marvellcareers', tenant: 'marvell', wd: '1', site: 'MarvellCareers', displayName: 'Marvell Semiconductor' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'ally-ally', tenant: 'ally', wd: '1', site: 'Ally', displayName: 'Ally Bank' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'danaher-danaherjobs', tenant: 'danaher', wd: '1', site: 'DanaherJobs', displayName: 'Cepheid' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'rsm-rsmcareers', tenant: 'rsm', wd: '1', site: 'RSMCareers', displayName: 'RSM' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'raymondjames-raymondjamescareers', tenant: 'raymondjames', wd: '1', site: 'RaymondJamesCareers', displayName: 'Raymond James' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'ameriprise-ameriprise', tenant: 'ameriprise', wd: '5', site: 'Ameriprise', displayName: 'Ameriprise Financial' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'arrow-ac', tenant: 'arrow', wd: '1', site: 'AC', displayName: 'Arrow Electronics' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'stryker-strykercareers', tenant: 'stryker', wd: '1', site: 'StrykerCareers', displayName: 'Stryker' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'zoetis-zoetis', tenant: 'zoetis', wd: '5', site: 'zoetis', displayName: 'Zoetis' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'ochsner-ochsner', tenant: 'ochsner', wd: '1', site: 'Ochsner', displayName: 'Ochsner Clinic Foundation' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'davita-dkc_external', tenant: 'davita', wd: '1', site: 'DKC_External', displayName: 'Davita' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)
  { source: 'workday', slug: 'pitneybowes-pbcareers', tenant: 'pitneybowes', wd: '1', site: 'PBCareers', displayName: 'Pitney Bowes' },  // 1 kept on 2026-10-31 (re-measured after a rate limit)

  // ─── H-1B sponsors, next tier (20-49 approvals; discover-sponsors.js 20 50, 2026-10-31) ───
  // 2,553 uncovered sponsors probed; 287 boards survived filtering and these
  // produced at least one kept row when collected. Same naming rule as above:
  // displayName is the USCIS petitioner name the sponsorship lookup keys on.
  { source: 'workday', slug: 'disney-disneycareer', tenant: 'disney', wd: '5', site: 'disneycareer', displayName: 'Disney Streaming' },  // 11 kept on 2026-10-31, 26 H-1B approvals
  { source: 'workday', slug: 'iheartmedia-external_ihm', tenant: 'iheartmedia', wd: '5', site: 'External_iHM', displayName: 'Iheartmedia Management Services' },  // 8 kept on 2026-10-31, 24 H-1B approvals
  { source: 'workday', slug: 'aveva-aveva_careers', tenant: 'aveva', wd: '3', site: 'AVEVA_careers', displayName: 'Aveva' },  // 7 kept on 2026-10-31, 38 H-1B approvals
  { source: 'workday', slug: 'kcura-external_career_site', tenant: 'kcura', wd: '1', site: 'External_Career_Site', displayName: 'Relativity Oda' },  // 7 kept on 2026-10-31, 35 H-1B approvals
  { source: 'workday', slug: 'thomsonreuters-external_career_site', tenant: 'thomsonreuters', wd: '5', site: 'External_Career_Site', displayName: 'Thomson Reuters' },  // 7 kept on 2026-10-31, 32 H-1B approvals
  { source: 'workday', slug: 'lseg-careers', tenant: 'lseg', wd: '3', site: 'Careers', displayName: 'Refinitiv' },  // 5 kept on 2026-10-31, 46 H-1B approvals
  { source: 'workday', slug: 'kyndryl-kyndrylprofessionalcareers', tenant: 'kyndryl', wd: '5', site: 'KyndrylProfessionalCareers', displayName: 'Kyndryl' },  // 5 kept on 2026-10-31, 40 H-1B approvals
  { source: 'workday', slug: 'aig-aig', tenant: 'aig', wd: '1', site: 'aig', displayName: 'Aig' },  // 5 kept on 2026-10-31, 39 H-1B approvals
  { source: 'workday', slug: 'roche-rog-a2o-gene', tenant: 'roche', wd: '3', site: 'ROG-A2O-GENE', displayName: 'Roche Molecular' },  // 4 kept on 2026-10-31, 45 H-1B approvals
  { source: 'workday', slug: 'aveva-etap_careers', tenant: 'aveva', wd: '3', site: 'ETAP_Careers', displayName: 'Aveva' },  // 4 kept on 2026-10-31, 38 H-1B approvals
  { source: 'workday', slug: 'resmed-resmed_external_careers', tenant: 'resmed', wd: '3', site: 'ResMed_External_Careers', displayName: 'Resmed Digital Health' },  // 4 kept on 2026-10-31, 27 H-1B approvals
  { source: 'workday', slug: 'lighting-jobs-and-careers', tenant: 'lighting', wd: '3', site: 'jobs-and-careers', displayName: 'Signify North' },  // 4 kept on 2026-10-31, 27 H-1B approvals
  { source: 'workday', slug: 'carlyle-carlyle', tenant: 'carlyle', wd: '1', site: 'Carlyle', displayName: 'Carlyle Group Employee' },  // 4 kept on 2026-10-31, 26 H-1B approvals
  { source: 'workday', slug: 'sifive-sifivecareers', tenant: 'sifive', wd: '1', site: 'sifivecareers', displayName: 'Sifive' },  // 4 kept on 2026-10-31, 21 H-1B approvals
  { source: 'workday', slug: 'flywire-flywirecareers', tenant: 'flywire', wd: '108', site: 'flywirecareers', displayName: 'Flywire' },  // 4 kept on 2026-10-31, 20 H-1B approvals
  { source: 'workday', slug: 'cree-ext', tenant: 'cree', wd: '108', site: 'EXT', displayName: 'Wolfspeed' },  // 4 kept on 2026-10-31, 20 H-1B approvals
  { source: 'workday', slug: 'formfactor-ffi-careers', tenant: 'formfactor', wd: '1', site: 'FFI-Careers', displayName: 'Formfactor' },  // 3 kept on 2026-10-31, 38 H-1B approvals
  { source: 'workday', slug: 'relx-elsevierjobs', tenant: 'relx', wd: '3', site: 'ElsevierJobs', displayName: 'Elsevier' },  // 3 kept on 2026-10-31, 26 H-1B approvals
  { source: 'workday', slug: 'cubic-cubic_usa_careers', tenant: 'cubic', wd: '1', site: 'cubic_USA_careers', displayName: 'Cubic' },  // 2 kept on 2026-10-31, 44 H-1B approvals
  { source: 'workday', slug: 'kyndryl-kyndrylearlycareers', tenant: 'kyndryl', wd: '5', site: 'KyndrylEarlyCareers', displayName: 'Kyndryl' },  // 2 kept on 2026-10-31, 40 H-1B approvals
  { source: 'workday', slug: 'healthresearch-hri_careers', tenant: 'healthresearch', wd: '1', site: 'HRI_Careers', displayName: 'Health Research Roswell Park' },  // 2 kept on 2026-10-31, 39 H-1B approvals
  { source: 'workday', slug: 'brandeis-jobs', tenant: 'brandeis', wd: '5', site: 'Jobs', displayName: 'Brandeis University' },  // 2 kept on 2026-10-31, 37 H-1B approvals
  { source: 'workday', slug: 'crowe-external_careers', tenant: 'crowe', wd: '12', site: 'External_Careers', displayName: 'Crowe' },  // 2 kept on 2026-10-31, 37 H-1B approvals
  { source: 'workday', slug: 'td-td_bank_careers', tenant: 'td', wd: '3', site: 'TD_Bank_Careers', displayName: 'Td Bank National Association' },  // 2 kept on 2026-10-31, 37 H-1B approvals
  { source: 'workday', slug: 'goodwinprocter-external_careers', tenant: 'goodwinprocter', wd: '5', site: 'External_Careers', displayName: 'Goodwin Procter' },  // 2 kept on 2026-10-31, 35 H-1B approvals
  { source: 'workday', slug: 'dimensional-dfa_careers', tenant: 'dimensional', wd: '5', site: 'DFA_Careers', displayName: 'Dimensional Fund Advisors' },  // 2 kept on 2026-10-31, 33 H-1B approvals
  { source: 'workday', slug: 'arrowstreetcapital-arrowstreet', tenant: 'arrowstreetcapital', wd: '5', site: 'Arrowstreet', displayName: 'Arrowstreet Capital Limited Partnership' },  // 2 kept on 2026-10-31, 30 H-1B approvals
  { source: 'workday', slug: 'stevens-external', tenant: 'stevens', wd: '5', site: 'External', displayName: 'Stevens Institute' },  // 2 kept on 2026-10-31, 29 H-1B approvals
  { source: 'workday', slug: 'bentleysystems-bentley', tenant: 'bentleysystems', wd: '5', site: 'bentley', displayName: 'Bentley Systems Incorporated' },  // 2 kept on 2026-10-31, 28 H-1B approvals
  { source: 'workable', slug: 'mindex', displayName: 'Mindex' },  // 2 kept on 2026-10-31, 26 H-1B approvals
  { source: 'workday', slug: 'unum-external', tenant: 'unum', wd: '1', site: 'External', displayName: 'Unum' },  // 2 kept on 2026-10-31, 25 H-1B approvals
  { source: 'workday', slug: 'baxter-baxter', tenant: 'baxter', wd: '1', site: 'baxter', displayName: 'Baxter Healthcare' },  // 2 kept on 2026-10-31, 24 H-1B approvals
  { source: 'workday', slug: 'clearwateranalytics-clearwater_analytics_careers', tenant: 'clearwateranalytics', wd: '1', site: 'Clearwater_Analytics_Careers', displayName: 'Clearwater Analytics' },  // 2 kept on 2026-10-31, 22 H-1B approvals
  { source: 'workday', slug: 'gnw-gnw', tenant: 'gnw', wd: '1', site: 'GNW', displayName: 'Genworth North' },  // 2 kept on 2026-10-31, 22 H-1B approvals
  { source: 'workday', slug: 'merceruniversity-external', tenant: 'merceruniversity', wd: '1', site: 'external', displayName: 'Mercer University' },  // 2 kept on 2026-10-31, 21 H-1B approvals
  { source: 'workday', slug: 'alteryx-alteryxcareers', tenant: 'alteryx', wd: '108', site: 'AlteryxCareers', displayName: 'Alteryx' },  // 2 kept on 2026-10-31, 20 H-1B approvals
  { source: 'workday', slug: 'rackspace-external', tenant: 'rackspace', wd: '1', site: 'External', displayName: 'Rackspace' },  // 1 kept on 2026-10-31, 49 H-1B approvals
  { source: 'workday', slug: 'insulet-insuletcareers', tenant: 'insulet', wd: '5', site: 'insuletcareers', displayName: 'Insulet' },  // 1 kept on 2026-10-31, 46 H-1B approvals
  { source: 'workday', slug: 'comscore-external', tenant: 'comscore', wd: '5', site: 'External', displayName: 'Comscore' },  // 1 kept on 2026-10-31, 45 H-1B approvals
  { source: 'workday', slug: 'keybank-external_career_site', tenant: 'keybank', wd: '5', site: 'External_Career_Site', displayName: 'Keybank National Association' },  // 1 kept on 2026-10-31, 45 H-1B approvals
  { source: 'workday', slug: 'momentive-mc', tenant: 'momentive', wd: '1', site: 'MC', displayName: 'Momentive' },  // 1 kept on 2026-10-31, 44 H-1B approvals
  { source: 'workday', slug: 'ciena-careers', tenant: 'ciena', wd: '5', site: 'Careers', displayName: 'Ciena' },  // 1 kept on 2026-10-31, 43 H-1B approvals
  { source: 'workday', slug: 'itron-itron', tenant: 'itron', wd: '5', site: 'Itron', displayName: 'Itron' },  // 1 kept on 2026-10-31, 42 H-1B approvals
  { source: 'workday', slug: 'belk-careers', tenant: 'belk', wd: '1', site: 'Careers', displayName: 'Belk' },  // 1 kept on 2026-10-31, 41 H-1B approvals
  { source: 'workday', slug: 'belk-careers-corporate', tenant: 'belk', wd: '1', site: 'Careers-Corporate', displayName: 'Belk' },  // 1 kept on 2026-10-31, 41 H-1B approvals
  { source: 'greenhouse', slug: 'schonfeld', displayName: 'Schonfeld Strategic Advisors' },  // 1 kept on 2026-10-31, 41 H-1B approvals
  { source: 'workday', slug: 'huron-huroncareers', tenant: 'huron', wd: '1', site: 'huroncareers', displayName: 'Huron Consulting Services' },  // 1 kept on 2026-10-31, 40 H-1B approvals
  { source: 'workday', slug: 'netscout-careers', tenant: 'netscout', wd: '108', site: 'Careers', displayName: 'Netscout' },  // 1 kept on 2026-10-31, 40 H-1B approvals
  { source: 'workday', slug: 'firstnational-fnbocareers', tenant: 'firstnational', wd: '12', site: 'fnbocareers', displayName: 'First National Bank Omaha' },  // 1 kept on 2026-10-31, 39 H-1B approvals
  { source: 'workday', slug: 'rochester-ur_staff', tenant: 'rochester', wd: '5', site: 'UR_Staff', displayName: 'Rochester Institute' },  // 1 kept on 2026-10-31, 37 H-1B approvals
  { source: 'workday', slug: 'super-search', tenant: 'super', wd: '103', site: 'search', displayName: 'Super Micro Computer' },  // 1 kept on 2026-10-31, 37 H-1B approvals
  { source: 'workday', slug: 'ironmountain-iron-mountain-jobs', tenant: 'ironmountain', wd: '5', site: 'iron-mountain-jobs', displayName: 'Iron Mountain Information Management' },  // 1 kept on 2026-10-31, 35 H-1B approvals
  { source: 'workday', slug: 'caresource-caresource', tenant: 'caresource', wd: '1', site: 'CareSource', displayName: 'Caresource Management Services' },  // 1 kept on 2026-10-31, 33 H-1B approvals
  { source: 'greenhouse', slug: 'enova', displayName: 'Enova Financial' },  // 1 kept on 2026-10-31, 32 H-1B approvals
  { source: 'workday', slug: 'simonsfoundation-simonsfoundationcareers', tenant: 'simonsfoundation', wd: '1', site: 'simonsfoundationcareers', displayName: 'Simons Foundation' },  // 1 kept on 2026-10-31, 31 H-1B approvals
  { source: 'workday', slug: 'tysonfoods-tsn', tenant: 'tysonfoods', wd: '5', site: 'TSN', displayName: 'Tyson Foods' },  // 1 kept on 2026-10-31, 31 H-1B approvals
  { source: 'workday', slug: 'arrowstreetcapital-campus_careers', tenant: 'arrowstreetcapital', wd: '5', site: 'Campus_Careers', displayName: 'Arrowstreet Capital Limited Partnership' },  // 1 kept on 2026-10-31, 30 H-1B approvals
  { source: 'ashby', slug: 'Vultr', displayName: 'Constant Contact' },  // 1 kept on 2026-10-31, 30 H-1B approvals
  { source: 'workday', slug: 'bmc-bmc', tenant: 'bmc', wd: '1', site: 'BMC', displayName: 'Bmc' },  // 1 kept on 2026-10-31, 29 H-1B approvals
  { source: 'workday', slug: 'dataminr-dataminr', tenant: 'dataminr', wd: '12', site: 'Dataminr', displayName: 'Dataminr' },  // 1 kept on 2026-10-31, 29 H-1B approvals
  { source: 'workday', slug: 'bakertilly-btcareers', tenant: 'bakertilly', wd: '5', site: 'BTCareers', displayName: 'Moss Adams' },  // 1 kept on 2026-10-31, 29 H-1B approvals
  { source: 'workday', slug: 'chevron-university', tenant: 'chevron', wd: '5', site: 'University', displayName: 'Chevron' },  // 1 kept on 2026-10-31, 28 H-1B approvals
  { source: 'workday', slug: 'unisys-external', tenant: 'unisys', wd: '5', site: 'External', displayName: 'Unisys' },  // 1 kept on 2026-10-31, 28 H-1B approvals
  { source: 'greenhouse', slug: 'gomotive', displayName: 'Keep Truckin' },  // 1 kept on 2026-10-31, 27 H-1B approvals
  { source: 'workday', slug: 'ambarella-ambarella', tenant: 'ambarella', wd: '108', site: 'Ambarella', displayName: 'Ambarella' },  // 1 kept on 2026-10-31, 26 H-1B approvals
  { source: 'workday', slug: 'medimpact-medimpact', tenant: 'medimpact', wd: '5', site: 'MedImpact', displayName: 'Medimpact Healthcare' },  // 1 kept on 2026-10-31, 26 H-1B approvals
  { source: 'workday', slug: 'electrolux-electroluxcareersite', tenant: 'electrolux', wd: '3', site: 'ElectroluxCareerSite', displayName: 'Electrolux Home Products' },  // 1 kept on 2026-10-31, 25 H-1B approvals
  { source: 'workday', slug: 'nextgen-nextgen_careers', tenant: 'nextgen', wd: '5', site: 'NextGen_Careers', displayName: 'Next Gen' },  // 1 kept on 2026-10-31, 25 H-1B approvals
  { source: 'workday', slug: 'newrez-nrz', tenant: 'newrez', wd: '1', site: 'NRZ', displayName: 'Newrez' },  // 1 kept on 2026-10-31, 24 H-1B approvals
  { source: 'greenhouse', slug: 'duolingo', displayName: 'Duolingo' },  // 1 kept on 2026-10-31, 22 H-1B approvals
  { source: 'workday', slug: 'pacificlife-pacificlifecareers', tenant: 'pacificlife', wd: '1', site: 'PacificLifeCareers', displayName: 'Pacific Life Insurance' },  // 1 kept on 2026-10-31, 22 H-1B approvals
  { source: 'workday', slug: 'trendmicro-external', tenant: 'trendmicro', wd: '3', site: 'External', displayName: 'Trend Micro' },  // 1 kept on 2026-10-31, 22 H-1B approvals
  { source: 'workday', slug: 'monolithicpower-mps_careers', tenant: 'monolithicpower', wd: '12', site: 'MPS_Careers', displayName: 'Monolithic Power' },  // 1 kept on 2026-10-31, 20 H-1B approvals

  // ─── Moved boards (scripts/reprobe-dead.js, 2026-10-31) ─────────────────
  // These companies' configured Greenhouse/Lever/Ashby boards started
  // returning 404; this is where they hire now. 27 others had no findable
  // board and were removed, as were 12 now on ATSes without a collector and
  // Walmart (its Workday site 422s; its SmartRecruiters board has no US jobs).
  { source: 'ashby', slug: 'amplitude', displayName: 'Amplitude' },
  { source: 'ashby', slug: 'hightouch', displayName: 'Hightouch' },
  { source: 'ashby', slug: 'mutiny', displayName: 'Mutiny' },
  { source: 'ashby', slug: 'nanonets', displayName: 'NanoNets' },
  { source: 'ashby', slug: 'applied', displayName: 'Applied Intuition' },
  { source: 'ashby', slug: 'clickhouse', displayName: 'ClickHouse' },
  { source: 'ashby', slug: 'harmonic', displayName: 'Harmonic' },
  { source: 'ashby', slug: 'hebbia-ai', displayName: 'Hebbia' },
  { source: 'greenhouse', slug: 'loyal36', displayName: 'Loyal' },
  { source: 'ashby', slug: 'maintainx', displayName: 'MaintainX' },
  { source: 'ashby', slug: 'outschool', displayName: 'Outschool' },
  { source: 'ashby', slug: 'sisense', displayName: 'Sisense' },
  { source: 'ashby', slug: 'snackpass', displayName: 'Snackpass' },
  { source: 'ashby', slug: 'thumbtack', displayName: 'Thumbtack' },
  { source: 'ashby', slug: 'worldlabs', displayName: 'World Labs' },
  { source: 'gem', slug: 'suger-inc', displayName: 'Suger' },
  { source: 'ashby', slug: 'plaid', displayName: 'Plaid' },
  { source: 'gem', slug: 'motion', displayName: 'Motion' },

  // ─── Moved boards, second pass (scripts/reprobe-dead.js + probe-boards.js, 2026-11-02) ───
  // 37 Greenhouse/Lever/Ashby/SmartRecruiters entries returned 0 jobs in the
  // 2026-11-02 08:52 UTC collect run, and lever:anyscale 404'd. These five
  // moved to a board that lists US software roles; each new board's own
  // organization name or website was checked.
  { source: 'ashby', slug: 'spade', displayName: 'Spade' },  // was greenhouse:spade, empty since at least 09-30
  { source: 'ashby', slug: 'webflow', displayName: 'Webflow' },  // was greenhouse:webflow, emptied after 10-12
  { source: 'ashby', slug: 'kiddom', displayName: 'Kiddom' },  // was lever:kiddom
  { source: 'greenhouse', slug: 'atomicindustriesinc', displayName: 'Atomic Industries' },  // was ashby:atomicindustries
  { source: 'ashby', slug: 'anyscale', displayName: 'Anyscale' },  // was lever:anyscale (404)
  // Removed, each empty in every run since at least 09-30 unless noted, with
  // no other board that lists US software roles: Pulley, SFOX, NimbleRx,
  // Tractian, DroneDeploy, Good Eggs, Kapwing, Quartzy, SWORD Health, Anara,
  // Deel, Tenjin, Toma, Electric.ai; SkySafe (its Greenhouse board is empty
  // too); ManyChat, Lucid Bots and BetterCloud (their new Ashby/SmartRecruiters
  // boards carry no US software roles); and the acquired — Clari (Salesloft),
  // Melio (Xero; emptied after 10-28), Confluent (IBM; emptied after 10-12),
  // Stytch (Twilio, already collected).
  // Still configured though empty on 11-02, because each listed postings in
  // October and its board is live: Biofourmis, Culdesac, Living Carbon,
  // Coperniq, Mem0, New Story, Paragon, Rutter, OpenSea, NanoNets. Re-check
  // them with reprobe-dead.js if they stay empty. smartrecruiters:microchip is
  // not dead either: that collector filters titles before counting, and its
  // 9 US postings are all senior or non-software.

  // ─── YC companies newly hiring (scripts/probe-yc-ats.js + verify-yc-ats.js, 2026-10-31) ───
  // Of 32 verified boards only these had a current entry/mid US software opening.
  { source: 'greenhouse', slug: 'morph', displayName: 'Morph' }, // YC Summer 2023
  { source: 'ashby', slug: 'datafold', displayName: 'Datafold' }, // YC Summer 2020
  { source: 'ashby', slug: 'reform', displayName: 'Reform' }, // YC Winter 2024

  // ─── Gem / Pinpoint / Recruitee (scripts/probe-ats.js, verified 2026-10-31) ───
  // Kept only where the board's postings mention the company's own website
  // (from the YC feed), or the slug is the exact multi-word YC name. Rejected:
  // one-word slugs that collide (coast, atlas, legacy…), every big-sponsor hit
  // on these platforms (an "infosys" BambooHR board is not Infosys), and boards
  // for companies already collected elsewhere (Raindrop, Exa, PostHog… on Ashby).
  { source: 'gem', slug: 'retool', displayName: 'Retool' },
  { source: 'gem', slug: 'onesignal', displayName: 'OneSignal' },
  { source: 'gem', slug: 'rootly', displayName: 'Rootly' },
  { source: 'gem', slug: 'letter-ai', displayName: 'Letter AI' },
  { source: 'gem', slug: 'paces', displayName: 'Paces' },
  { source: 'gem', slug: 'gem', displayName: 'Gem' },
  { source: 'gem', slug: 'converge', displayName: 'Converge' },
  { source: 'gem', slug: 'rinsed', displayName: 'Rinsed' },
  { source: 'gem', slug: 'hemut', displayName: 'Hemut' },
  { source: 'gem', slug: 'roe-ai', displayName: 'Roe AI' },
  { source: 'gem', slug: 'better-auth', displayName: 'Better Auth' },
  { source: 'gem', slug: 'rovihealth', displayName: 'Rovi Health' },
  { source: 'gem', slug: 'lunajoy', displayName: 'LunaJoy' },
  { source: 'gem', slug: 'unsiloed-ai', displayName: 'Unsiloed AI' },
  { source: 'gem', slug: 'informed-k12', displayName: 'Informed K12' },
  { source: 'gem', slug: 'thunder-compute', displayName: 'Thunder Compute' },
  { source: 'gem', slug: 'tank-payments', displayName: 'Tank Payments' },
  { source: 'gem', slug: 'growthbook', displayName: 'GrowthBook' },
  { source: 'pinpoint', slug: 'safetywing', displayName: 'SafetyWing' },
  { source: 'recruitee', slug: 'snapmagic', displayName: 'SnapMagic' },

  // ─── Well-known tech, AI, quant and enterprise employers (scripts/probe-boards.js names, 2026-11-02) ───
  // From a hand-written list of ~300 companies the board didn't collect,
  // probed on Greenhouse, Ashby, Lever and Workday. Each board was checked to
  // be that employer's (Greenhouse registered name or apply-link domain, Ashby
  // organization website, Lever page title or logo link) and lists at least
  // one US software posting. Comments give US software postings — or, for
  // Workday, rows a collect kept — on 2026-11-02, and the USCIS approvals the
  // displayName resolves to. As above, displayName is the petitioner name
  // where the brand alone wouldn't resolve ("Lucid USA", "Social Finance").
  // Many show 0 kept today because their US roles are older than the 14-day
  // window or senior; one request per run picks up new postings as they land.
  // Not added: SpaceX, Rocket Lab, Varda, Vannevar Labs and Relativity Space
  // (their kept rows come back EXPORT_CONTROL / CLEARANCE), xAI (in
  // EXCLUDED_EMPLOYERS), GE Vernova and GE Aerospace (1-3 US software postings
  // among 600-2,000, not worth a Workday tenant's requests), boards whose US
  // postings had no software roles (Supabase, Tripadvisor, Miro, Redis…), and
  // employers whose US software postings all refuse sponsorship in so many
  // words — PNC ("will not … participate in STEM OPT"), 3M, BILL, LendingTree,
  // New Relic, Inovalon, Render.
  // Greenhouse
  { source: 'greenhouse', slug: 'lucidmotors', displayName: 'Lucid USA' },  // 14 US software of 449 postings, 457 H-1B approvals
  { source: 'greenhouse', slug: 'waymo', displayName: 'Waymo' },  // 120 US software of 372 postings, 284 H-1B approvals
  { source: 'greenhouse', slug: 'okta', displayName: 'Okta' },  // 35 US software of 392 postings, 229 H-1B approvals
  { source: 'greenhouse', slug: 'hp', displayName: 'HP' },  // 9 US software of 25 postings, 167 H-1B approvals
  { source: 'greenhouse', slug: 'zscaler', displayName: 'Zscaler' },  // 38 US software of 358 postings, 162 H-1B approvals
  { source: 'greenhouse', slug: 'sofi', displayName: 'Social Finance' },  // 12 US software of 62 postings, 141 H-1B approvals
  { source: 'greenhouse', slug: 'nuro', displayName: 'Nuro' },  // 54 US software of 95 postings, 137 H-1B approvals
  { source: 'greenhouse', slug: 'motional', displayName: 'Motional AD' },  // 12 US software of 79 postings, 112 H-1B approvals
  { source: 'greenhouse', slug: 'boxinc', displayName: 'Box' },  // 7 US software of 125 postings, 108 H-1B approvals
  { source: 'greenhouse', slug: 'mongodb', displayName: 'MongoDB' },  // 27 US software of 359 postings, 106 H-1B approvals
  { source: 'greenhouse', slug: 'riotgames', displayName: 'Riot Games' },  // 44 US software of 181 postings, 93 H-1B approvals
  { source: 'greenhouse', slug: 'axon', displayName: 'Axon Enterprise' },  // 31 US software of 473 postings, 72 H-1B approvals
  { source: 'greenhouse', slug: 'smartsheet', displayName: 'Smartsheet' },  // 12 US software of 77 postings, 70 H-1B approvals
  { source: 'greenhouse', slug: 'ripple', displayName: 'Ripple Labs' },  // 15 US software of 112 postings, 61 H-1B approvals
  { source: 'greenhouse', slug: 'tripactions', displayName: 'TripActions' },  // 6 US software of 223 postings, 56 H-1B approvals
  { source: 'greenhouse', slug: 'sambanovasystems', displayName: 'SambaNova Systems' },  // 7 US software of 69 postings, 51 H-1B approvals
  { source: 'greenhouse', slug: 'point72', displayName: 'Point72 LP' },  // 33 US software of 198 postings, 48 H-1B approvals
  { source: 'greenhouse', slug: 'nextdoor', displayName: 'Nextdoor' },  // 6 US software of 20 postings, 47 H-1B approvals
  { source: 'greenhouse', slug: 'gemini', displayName: 'Gemini Trust Company' },  // 12 US software of 28 postings, 44 H-1B approvals
  { source: 'greenhouse', slug: 'janestreet', displayName: 'Jane Street' },  // 19 US software of 217 postings, 44 H-1B approvals
  { source: 'greenhouse', slug: 'squarepointcapital', displayName: 'Squarepoint Ops' },  // 12 US software of 90 postings, 43 H-1B approvals
  { source: 'greenhouse', slug: 'torcrobotics', displayName: 'Torc Robotics' },  // 23 US software of 48 postings, 42 H-1B approvals
  { source: 'greenhouse', slug: 'akunacapital', displayName: 'Akuna Capital' },  // 9 US software of 32 postings, 40 H-1B approvals
  { source: 'greenhouse', slug: 'oscar', displayName: 'Oscar Management Corporation' },  // 26 US software of 207 postings, 39 H-1B approvals
  { source: 'greenhouse', slug: 'towerresearchcapital', displayName: 'Tower Research Capital' },  // 11 US software of 94 postings, 38 H-1B approvals
  { source: 'greenhouse', slug: 'flatironhealth', displayName: 'Flatiron Health' },  // 2 US software of 26 postings, 34 H-1B approvals
  { source: 'greenhouse', slug: 'aqr', displayName: 'AQR Capital Management' },  // 2 US software of 54 postings, 34 H-1B approvals
  { source: 'greenhouse', slug: 'collibra', displayName: 'Collibra' },  // 1 US software of 18 postings, 32 H-1B approvals
  { source: 'greenhouse', slug: 'harnessinc', displayName: 'Harness' },  // 5 US software of 66 postings, 32 H-1B approvals
  { source: 'greenhouse', slug: 'drweng', displayName: 'DRW Holdings' },  // 34 US software of 161 postings, 31 H-1B approvals
  { source: 'greenhouse', slug: 'virtu', displayName: 'Virtu Financial' },  // 9 US software of 48 postings, 31 H-1B approvals
  { source: 'greenhouse', slug: 'worldquant', displayName: 'WorldQuant' },  // 12 US software of 88 postings, 30 H-1B approvals
  { source: 'greenhouse', slug: 'elastic', displayName: 'Elasticsearch' },  // 28 US software of 416 postings, 29 H-1B approvals
  { source: 'greenhouse', slug: 'wehrtyou', displayName: 'Hudson River Trading' },  // 17 US software of 84 postings, 29 H-1B approvals
  { source: 'greenhouse', slug: 'klaviyo', displayName: 'Klaviyo' },  // 31 US software of 157 postings, 28 H-1B approvals
  { source: 'greenhouse', slug: 'pathai', displayName: 'PathAI' },  // 6 US software of 10 postings, 27 H-1B approvals
  { source: 'greenhouse', slug: 'digitalocean98', displayName: 'DigitalOcean' },  // 32 US software of 156 postings, 25 H-1B approvals
  { source: 'greenhouse', slug: 'sigmacomputing', displayName: 'Sigma Computing' },  // 27 US software of 76 postings, 24 H-1B approvals
  { source: 'greenhouse', slug: 'jfrog', displayName: 'JFrog' },  // 3 US software of 75 postings, 22 H-1B approvals
  { source: 'greenhouse', slug: 'braze', displayName: 'Braze' },  // 41 US software of 353 postings, 21 H-1B approvals
  { source: 'greenhouse', slug: 'justworks', displayName: 'Justworks' },  // 14 US software of 105 postings, 19 H-1B approvals
  { source: 'greenhouse', slug: 'sentinellabs', displayName: 'SentinelOne' },  // 10 US software of 289 postings, 19 H-1B approvals
  { source: 'greenhouse', slug: 'tenableinc', displayName: 'Tenable' },  // 3 US software of 38 postings, 15 H-1B approvals
  { source: 'greenhouse', slug: 'planetlabs', displayName: 'Planet Labs' },  // 9 US software of 126 postings, 15 H-1B approvals
  { source: 'greenhouse', slug: 'fastly', displayName: 'Fastly' },  // 10 US software of 51 postings, 14 H-1B approvals
  { source: 'greenhouse', slug: 'pathrobotics', displayName: 'Path Robotics' },  // 11 US software of 63 postings, 13 H-1B approvals
  { source: 'greenhouse', slug: 'tenstorrent', displayName: 'Tenstorrent USA' },  // 3 US software of 125 postings, 12 H-1B approvals
  { source: 'greenhouse', slug: 'tanium', displayName: 'Tanium' },  // 10 US software of 64 postings, 11 H-1B approvals
  { source: 'greenhouse', slug: 'icapitalnetwork', displayName: 'iCapital Network' },  // 14 US software of 209 postings, 11 H-1B approvals
  { source: 'greenhouse', slug: 'spire', displayName: 'Spire' },  // 4 US software of 39 postings, 10 H-1B approvals
  { source: 'greenhouse', slug: 'starburst', displayName: 'Starburst Data' },  // 6 US software of 34 postings, 10 H-1B approvals
  { source: 'greenhouse', slug: 'adyen', displayName: 'Adyen' },  // 7 US software of 240 postings, 9 H-1B approvals
  { source: 'greenhouse', slug: 'fiveringsllc', displayName: 'Five Rings' },  // 4 US software of 17 postings, 7 H-1B approvals
  { source: 'greenhouse', slug: 'agilityrobotics', displayName: 'Agility Robotics' },  // 13 US software of 78 postings, 6 H-1B approvals
  { source: 'greenhouse', slug: 'lightmatter', displayName: 'Lightmatter' },  // 2 US software of 58 postings, 4 H-1B approvals
  { source: 'greenhouse', slug: 'snorkelai', displayName: 'Snorkel AI' },  // 8 US software of 42 postings, 4 H-1B approvals
  { source: 'greenhouse', slug: 'pdtpartners', displayName: 'PDT Partners' },  // 5 US software of 12 postings, 4 H-1B approvals
  { source: 'greenhouse', slug: 'recursionpharmaceuticals', displayName: 'Recursion' },  // 2 US software of 9 postings, 2 H-1B approvals
  { source: 'greenhouse', slug: 'wizinc', displayName: 'Wiz' },  // 2 US software of 115 postings, 2 H-1B approvals
  { source: 'greenhouse', slug: 'apptronik', displayName: 'Apptronik' },  // 9 US software of 88 postings, 1 H-1B approvals
  { source: 'greenhouse', slug: 'inflectionai', displayName: 'Inflection AI' },  // 1 US software of 4 postings, 1 H-1B approvals
  { source: 'greenhouse', slug: 'expel', displayName: 'Expel' },  // 1 US software of 7 postings, 1 H-1B approvals
  { source: 'greenhouse', slug: 'figureai', displayName: 'Figure AI' },  // 17 US software of 99 postings, 1 H-1B approvals
  { source: 'greenhouse', slug: 'tailscale', displayName: 'Tailscale' },  // 8 US software of 58 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'togetherai', displayName: 'Together AI' },  // 16 US software of 88 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'coreweave', displayName: 'CoreWeave' },  // 55 US software of 305 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'typeface', displayName: 'Typeface' },  // 7 US software of 18 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'youcom', displayName: 'You.com' },  // 3 US software of 9 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'grafanalabs', displayName: 'Grafana Labs' },  // 14 US software of 125 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'circleci', displayName: 'CircleCI' },  // 5 US software of 14 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'contentful', displayName: 'Contentful' },  // 1 US software of 29 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'bitwarden', displayName: 'Bitwarden' },  // 3 US software of 31 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'huntress', displayName: 'Huntress Labs' },  // 8 US software of 39 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'jumptrading', displayName: 'Jump Trading' },  // 19 US software of 96 postings, 0 H-1B approvals
  { source: 'greenhouse', slug: 'engineersgate', displayName: 'Engineers Gate' },  // 1 US software of 10 postings, 0 H-1B approvals
  // Ashby
  { source: 'ashby', slug: 'quora', displayName: 'Quora' },  // 7 US software of 9 postings, 26 H-1B approvals
  { source: 'ashby', slug: 'cerebras', displayName: 'Cerebras Systems' },  // 31 US software of 116 postings, 20 H-1B approvals
  { source: 'ashby', slug: 'acorns', displayName: 'Acorns Grow Incorporated' },  // 1 US software of 14 postings, 20 H-1B approvals
  { source: 'ashby', slug: 'iterable', displayName: 'Iterable' },  // 2 US software of 13 postings, 18 H-1B approvals
  { source: 'ashby', slug: 'temporal', displayName: 'Temporal Technologies' },  // 18 US software of 74 postings, 9 H-1B approvals
  { source: 'ashby', slug: 'color-health', displayName: 'Color Health' },  // 2 US software of 18 postings, 9 H-1B approvals
  { source: 'ashby', slug: 'airbyte', displayName: 'Airbyte' },  // 3 US software of 9 postings, 6 H-1B approvals
  { source: 'ashby', slug: 'paxos', displayName: 'Paxos Trust Company' },  // 1 US software of 22 postings, 6 H-1B approvals
  { source: 'ashby', slug: 'd-matrix', displayName: 'Dmatrix Corporation' },  // 12 US software of 40 postings, 5 H-1B approvals
  { source: 'ashby', slug: 'lambda', displayName: 'Lambda' },  // 17 US software of 94 postings, 3 H-1B approvals
  { source: 'ashby', slug: 'wayve', displayName: 'Wayve Technologies' },  // 35 US software of 174 postings, 3 H-1B approvals
  { source: 'ashby', slug: 'montecarlodata', displayName: 'Monte Carlo' },  // 2 US software of 10 postings, 3 H-1B approvals
  { source: 'ashby', slug: 'snyk', displayName: 'Snyk' },  // 1 US software of 37 postings, 1 H-1B approvals
  { source: 'ashby', slug: 'sierra', displayName: 'Sierra' },  // 32 US software of 219 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'etched', displayName: 'Etched' },  // 14 US software of 124 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'pinecone', displayName: 'Pinecone' },  // 3 US software of 6 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'fireworks', displayName: 'Fireworks AI' },  // 3 US software of 90 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'crusoe', displayName: 'Crusoe' },  // 43 US software of 338 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'matx', displayName: 'MatX' },  // 6 US software of 41 postings, 0 H-1B approvals
  { source: 'ashby', slug: '1x', displayName: '1X' },  // 16 US software of 100 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'motherduck', displayName: 'MotherDuck' },  // 1 US software of 7 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'hex', displayName: 'Hex' },  // 9 US software of 40 postings, 0 H-1B approvals
  { source: 'ashby', slug: '1password', displayName: '1Password' },  // 3 US software of 77 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'socket', displayName: 'Socket' },  // 2 US software of 27 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'voleon', displayName: 'The Voleon Group' },  // 20 US software of 63 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'reka', displayName: 'Reka' },  // 1 US software of 9 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'liquid-ai', displayName: 'Liquid AI' },  // 2 US software of 20 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'baseten', displayName: 'Baseten' },  // 32 US software of 103 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'character', displayName: 'Character.AI' },  // 10 US software of 13 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'surge-ai', displayName: 'Surge AI' },  // 6 US software of 33 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'llamaindex', displayName: 'LlamaIndex' },  // 1 US software of 4 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'writer', displayName: 'Writer' },  // 8 US software of 46 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'lumaai', displayName: 'Luma AI' },  // 7 US software of 28 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'suno', displayName: 'Suno' },  // 29 US software of 71 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'synthesia', displayName: 'Synthesia' },  // 2 US software of 33 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'physicalintelligence', displayName: 'Physical Intelligence' },  // 10 US software of 44 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'cobot', displayName: 'Collaborative Robotics' },  // 1 US software of 14 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'sanity', displayName: 'Sanity' },  // 3 US software of 33 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'uniswap', displayName: 'Uniswap Labs' },  // 3 US software of 9 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'kraken.com', displayName: 'Kraken' },  // 2 US software of 88 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'drata', displayName: 'Drata' },  // 3 US software of 27 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'materialsecurity', displayName: 'Material Security' },  // 2 US software of 5 postings, 0 H-1B approvals
  { source: 'ashby', slug: 'hims-and-hers', displayName: 'Hims & Hers' },  // 7 US software of 152 postings, 0 H-1B approvals
  // Lever
  { source: 'lever', slug: 'wealthfront', displayName: 'Wealthfront Corporation' },  // 8 US software of 20 postings, 14 H-1B approvals
  { source: 'lever', slug: 'moonpay', displayName: 'MoonPay USA' },  // 3 US software of 23 postings, 5 H-1B approvals
  { source: 'lever', slug: 'ro', displayName: 'Ro' },  // 13 US software of 53 postings, 0 H-1B approvals
  { source: 'lever', slug: 'belvederetrading', displayName: 'Belvedere Trading' },  // 2 US software of 17 postings, 0 H-1B approvals
  // Workday
  { source: 'workday', slug: 'cisco-cisco_careers', tenant: 'cisco', wd: '5', site: 'Cisco_Careers', displayName: 'Cisco Systems' },  // 19 kept of 1435 postings, 3396 H-1B approvals
  { source: 'workday', slug: 'cvshealth-cvs_health_careers', tenant: 'cvshealth', wd: '1', site: 'CVS_Health_Careers', displayName: 'CVS Pharmacy' },  // 3 kept of 19092 postings, 550 H-1B approvals
  { source: 'workday', slug: 'att-attgeneral', tenant: 'att', wd: '1', site: 'ATTGeneral', displayName: 'AT&T Services' },  // 1 kept of 1121 postings, 480 H-1B approvals
  { source: 'workday', slug: 'att-attcollege', tenant: 'att', wd: '1', site: 'ATTCollege', displayName: 'AT&T Services' },  // 0 kept of 9 postings, 480 H-1B approvals
  { source: 'workday', slug: 'illumina-illumina-careers', tenant: 'illumina', wd: '1', site: 'illumina-careers', displayName: 'Illumina' },  // 0 kept of 168 postings, 233 H-1B approvals
  { source: 'workday', slug: 'motorolasolutions-careers', tenant: 'motorolasolutions', wd: '5', site: 'Careers', displayName: 'Motorola Solutions' },  // 13 kept of 861 postings, 191 H-1B approvals
  { source: 'workday', slug: 'hp-externalcareersite', tenant: 'hp', wd: '5', site: 'ExternalCareerSite', displayName: 'HP' },  // 5 kept of 905 postings, 167 H-1B approvals
  { source: 'workday', slug: 'fanniemae-fanniemaecareers', tenant: 'fanniemae', wd: '1', site: 'FannieMaeCareers', displayName: 'Fannie Mae' },  // 0 kept of 55 postings, 66 H-1B approvals
  { source: 'workday', slug: 'circle-circle', tenant: 'circle', wd: '1', site: 'Circle', displayName: 'Circle Internet Financial' },  // 0 kept of 62 postings, 35 H-1B approvals
  { source: 'workday', slug: 'postman-careers', tenant: 'postman', wd: '108', site: 'careers', displayName: 'Postman' },  // 0 kept of 27 postings, 8 H-1B approvals
  { source: 'workday', slug: 'bloomberg-bloombergindustrygroup_external_career_site', tenant: 'bloomberg', wd: '1', site: 'Bloombergindustrygroup_External_Career_Site', displayName: 'Bloomberg Industry Group' },  // 1 kept of 73 postings, 0 H-1B approvals
  { source: 'workday', slug: 'cityblockhealth-cityblockexternalcareersite', tenant: 'cityblockhealth', wd: '1', site: 'CityblockExternalCareerSite', displayName: 'Cityblock Health' },  // 1 kept of 40 postings, 0 H-1B approvals
  { source: 'workday', slug: 'devoted-devoted', tenant: 'devoted', wd: '1', site: 'Devoted', displayName: 'Devoted Health' },  // 0 kept of 69 postings, 0 H-1B approvals

  // ─── H-1B sponsors on Greenhouse / Ashby / Lever (scripts/probe-boards.js sponsors 20, 2026-11-02) ───
  // discover-sponsors.js only read Workday robots.txt and careers pages, so a
  // sponsor whose careers page didn't link its board was never found. This
  // pass tried slug variants of the 3,791 uncovered sponsors with >= 20
  // approvals directly: 83 boards matched by name, and these list US software
  // roles and survived review. The ones that overlap the list above (Waymo,
  // Okta, Zscaler, Nuro, MongoDB…) are entered once, above.
  // Rejected as a different employer under the sponsor's name: Astera
  // Institute (not Astera Labs), Casa (not Casa Systems), Yotta Labs (not
  // Yotta Systems), maxima.ai (not Maxima Consulting), Squad of Kyiv (not Squad
  // Software), Pivotal the eVTOL maker (not Pivotal Software). Unify is the
  // go-to-market startup, not the Unify Solutions petitioner, so it keeps its
  // own name. Skipped as heavy for the yield: Carvana (3 US software among
  // 1,701 postings), AlixPartners (1 of 121). LendingTree and Inovalon were
  // dropped for refusing sponsorship on every US software posting.
  // Greenhouse
  { source: 'greenhouse', slug: 'roku', displayName: 'Roku' },  // 24 US software of 82 postings, 283 H-1B approvals
  { source: 'greenhouse', slug: 'roblox', displayName: 'Roblox Corporation' },  // 148 US software of 267 postings, 186 H-1B approvals
  { source: 'greenhouse', slug: 'zoominfo', displayName: 'ZoomInfo Technologies' },  // 22 US software of 98 postings, 130 H-1B approvals
  { source: 'greenhouse', slug: 'oportun', displayName: 'Oportun' },  // 3 US software of 28 postings, 102 H-1B approvals
  { source: 'greenhouse', slug: 'faradayfuture', displayName: 'Faraday Future' },  // 2 US software of 82 postings, 82 H-1B approvals
  { source: 'greenhouse', slug: 'onetrust', displayName: 'OneTrust' },  // 9 US software of 82 postings, 82 H-1B approvals
  { source: 'greenhouse', slug: 'anaplan', displayName: 'Anaplan' },  // 1 US software of 156 postings, 78 H-1B approvals
  { source: 'greenhouse', slug: 'zuora', displayName: 'Zuora' },  // 4 US software of 35 postings, 65 H-1B approvals
  { source: 'greenhouse', slug: 'weee', displayName: 'Weee!' },  // 1 US software of 21 postings, 61 H-1B approvals
  { source: 'greenhouse', slug: 'asm', displayName: 'ASM America' },  // 10 US software of 508 postings, 58 H-1B approvals
  { source: 'greenhouse', slug: 'cargurus', displayName: 'CarGurus' },  // 9 US software of 40 postings, 51 H-1B approvals
  { source: 'greenhouse', slug: 'appian', displayName: 'Appian Corporation' },  // 18 US software of 161 postings, 44 H-1B approvals
  { source: 'greenhouse', slug: 'quinstreet', displayName: 'QuinStreet' },  // 1 US software of 32 postings, 43 H-1B approvals
  { source: 'greenhouse', slug: 'applovin', displayName: 'AppLovin Corporation' },  // 5 US software of 43 postings, 40 H-1B approvals
  { source: 'greenhouse', slug: 'williamblair', displayName: 'William Blair' },  // 5 US software of 50 postings, 37 H-1B approvals
  { source: 'greenhouse', slug: 'pubmatic', displayName: 'PubMatic' },  // 4 US software of 77 postings, 34 H-1B approvals
  { source: 'greenhouse', slug: 'upgrade', displayName: 'Upgrade' },  // 1 US software of 32 postings, 34 H-1B approvals
  { source: 'greenhouse', slug: 'veranahealth', displayName: 'Verana Health' },  // 1 US software of 6 postings, 33 H-1B approvals
  { source: 'greenhouse', slug: 'life360', displayName: 'Life360' },  // 9 US software of 25 postings, 30 H-1B approvals
  { source: 'greenhouse', slug: 'happymoney', displayName: 'Happy Money' },  // 1 US software of 6 postings, 29 H-1B approvals
  { source: 'greenhouse', slug: 'squarespace', displayName: 'Squarespace' },  // 6 US software of 26 postings, 28 H-1B approvals
  { source: 'greenhouse', slug: '8451', displayName: '84 51' },  // 4 US software of 14 postings, 27 H-1B approvals
  { source: 'greenhouse', slug: 'five9', displayName: 'Five9' },  // 7 US software of 83 postings, 27 H-1B approvals
  { source: 'greenhouse', slug: 'mindbody', displayName: 'Mindbody' },  // 3 US software of 18 postings, 27 H-1B approvals
  { source: 'greenhouse', slug: 'verisign', displayName: 'Verisign' },  // 5 US software of 16 postings, 26 H-1B approvals
  { source: 'greenhouse', slug: 'credible', displayName: 'Credible Labs' },  // 1 US software of 14 postings, 26 H-1B approvals
  { source: 'greenhouse', slug: 'intersystems', displayName: 'InterSystems Corporation' },  // 4 US software of 101 postings, 25 H-1B approvals
  { source: 'greenhouse', slug: 'ixllearning', displayName: 'IXL Learning' },  // 24 US software of 119 postings, 23 H-1B approvals
  { source: 'greenhouse', slug: 'ziprecruiter', displayName: 'ZipRecruiter' },  // 16 US software of 46 postings, 22 H-1B approvals
  // Ashby
  { source: 'ashby', slug: 'nerdwallet', displayName: 'NerdWallet' },  // 4 US software of 24 postings, 30 H-1B approvals
  { source: 'ashby', slug: 'poshmark', displayName: 'Poshmark' },  // 5 US software of 28 postings, 24 H-1B approvals
  { source: 'ashby', slug: 'patreon', displayName: 'Patreon' },  // 8 US software of 20 postings, 22 H-1B approvals
  { source: 'ashby', slug: 'mapbox', displayName: 'Mapbox' },  // 2 US software of 35 postings, 20 H-1B approvals
  { source: 'ashby', slug: 'unify', displayName: 'Unify' },  // 5 US software of 11 postings, 0 H-1B approvals
  // Lever
  { source: 'lever', slug: 'zoox', displayName: 'Zoox' },  // 72 US software of 226 postings, 280 H-1B approvals
  { source: 'lever', slug: 'saviynt', displayName: 'Saviynt' },  // 10 US software of 66 postings, 94 H-1B approvals
  { source: 'lever', slug: 'egen', displayName: 'Egen Solutions' },  // 7 US software of 23 postings, 75 H-1B approvals
  { source: 'lever', slug: 'aeva', displayName: 'Aeva' },  // 1 US software of 45 postings, 45 H-1B approvals
  { source: 'lever', slug: 'greenlight', displayName: 'Greenlight Financial Technology' },  // 3 US software of 16 postings, 41 H-1B approvals
  { source: 'lever', slug: 'outreach', displayName: 'Outreach Corporation' },  // 2 US software of 20 postings, 35 H-1B approvals
  { source: 'lever', slug: 'ttecdigital', displayName: 'TTEC Digital' },  // 3 US software of 59 postings, 31 H-1B approvals
  { source: 'lever', slug: 'weride', displayName: 'WeRide' },  // 5 US software of 13 postings, 27 H-1B approvals
  { source: 'lever', slug: 'smarsh', displayName: 'Smarsh' },  // 2 US software of 23 postings, 24 H-1B approvals
  { source: 'lever', slug: 'payjoy', displayName: 'PayJoy' },  // 1 US software of 87 postings, 21 H-1B approvals

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

  // Markdown-table lists (src/collectors/mdtable.js). speedyapply links straight
  // to each employer's own ATS; on 2026-10-31 it added ~194 visible rows not
  // already in the DB (Roblox, HelloFresh, Home Depot, KLA, Snap…). Its ~50
  // TikTok rows are 77-106 days old, so retention drops them — expected.
  // jobright-ai's lists were checked and skipped: every link goes through
  // jobright.ai rather than to the employer. Zapply's lists (zapplyjobs/*-2027)
  // link through zapply.jobs the same way. Both are mined for employers instead
  // (the 2026-11-23 block at the end of COMPANIES).
  // speedyapply renamed its repo 2026-SWE-College-Jobs → 2027-SWE-College-Jobs
  // (GitHub redirects the old name). Its AI list has the same layout; on
  // 2026-11-23 it gave 69 kept rows from 48 employers.
  {
    source: 'mdtable',
    slug: 'speedyapply-newgrad-usa',
    displayName: 'speedyapply/2027-SWE-College-Jobs',
    url: 'https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/NEW_GRAD_USA.md',
  },
  {
    source: 'mdtable',
    slug: 'speedyapply-ai-newgrad-usa',
    displayName: 'speedyapply/2027-AI-College-Jobs',
    url: 'https://raw.githubusercontent.com/speedyapply/2027-AI-College-Jobs/main/NEW_GRAD_USA.md',
  },

  // ─── YC startups via HN "Who is hiring?" ─────────────────────────────────
  // Pulls the last 2 monthly threads, parses "Company | Location | … | URL"
  // headers, and keeps only comments whose company matches a US-based YC
  // company currently marked `isHiring` in akshaybhalotia/yc_company_scraper.
  { source: 'hn_hiring', displayName: 'HN Who is hiring (YC US)' },

  // ─── Rippling ATS (verified 2026-08-13, see src/collectors/rippling.js) ──
  // Found by scripts/probe-rippling.js. Rippling is where companies migrate
  // *to*: Opendoor's Greenhouse board 404s now, and its 74 postings were
  // invisible except for the few Getro happened to mirror.
  //
  // Only three of twenty probe hits are here, because slug collisions are the
  // norm on this ATS and every one was verified against the board's own
  // companyName before being added. Rejected as different companies entirely:
  // `wsp` is Waldorf School of the Peninsula (not the 194-approval engineering
  // firm), `ace` is American College of Education, `sas` is Strategic
  // Association Solutions (not SAS Institute), `paramount` is a debt-recovery
  // firm, `archer` is Archer Review. Adding any of those would have put an
  // unrelated employer's jobs on the board under a big sponsor's name.
  // Always check displayName against the USCIS key before merging a probe line.
  //
  // ThoughtSpot was probed and rejected: 56 postings, none of them engineering —
  // its Rippling board carries only sales, marketing and CS roles. Don't re-add.
  { source: 'rippling', slug: 'opendoor',     displayName: 'Opendoor' },     // 74 postings, 35 approvals (as opendoor-labs)
  { source: 'rippling', slug: 'rsa-security', displayName: 'RSA Security' }, // 41 postings, 49 approvals

  // ─── Getro VC portfolio boards (verified 2026-08-13) ─────────────────────
  // Discovered by scripts/probe-getro.js. See src/collectors/getro.js.
  //
  // This is the widest startup-coverage route we have: 63k US rows across these
  // 16 networks, versus ~700 individually-configured Greenhouse/Lever/Ashby
  // companies. It reaches the startups the YC and topstartups probes miss —
  // too small, too new, or simply never on a list we scraped — and every row
  // carries a direct ATS apply URL, a real posting date, and Getro's own
  // seniority label.
  //
  // The row counts below are total US postings on each board, NOT what we
  // ingest. The collector pages newest-first and stops at RETENTION_DAYS, so
  // per-run volume is a function of how fast each network posts, not its size.
  //
  // `networkId` is not guessable — always get it from the probe script. A wrong
  // id fails loudly (Elasticsearch index_not_found_exception), not silently.
  // Portfolios overlap heavily; duplicates collapse on dedupe_key.
  { source: 'getro', slug: 'general-catalyst', networkId: 222, boardHost: 'jobs.generalcatalyst.com', displayName: 'General Catalyst' }, // 12015 US rows
  { source: 'getro', slug: 'accel', networkId: 8672, boardHost: 'jobs.accel.com', displayName: 'Accel' }, // 10944 US rows
  { source: 'getro', slug: 'thrive-capital', networkId: 2105, boardHost: 'jobs.thrivecap.com', displayName: 'Thrive Capital' }, // 8445 US rows
  { source: 'getro', slug: 'khosla-ventures', networkId: 257, boardHost: 'jobs.khoslaventures.com', displayName: 'Khosla Ventures' }, // 7268 US rows
  { source: 'getro', slug: '8vc', networkId: 1005, boardHost: 'jobs.8vc.com', displayName: '8VC' }, // 6921 US rows
  { source: 'getro', slug: 'insight-partners-2', networkId: 246, boardHost: 'jobs.insightpartners.com', displayName: 'Insight Partners' }, // 6097 US rows
  { source: 'getro', slug: 'summit-partners', networkId: 36623, boardHost: 'jobs.summitpartners.com', displayName: 'Summit Partners' }, // 2730 US rows
  { source: 'getro', slug: 'menlo-ventures', networkId: 767, boardHost: 'jobs.menlovc.com', displayName: 'Menlo Ventures' }, // 2613 US rows
  { source: 'getro', slug: 'lead-edge-capital', networkId: 1076, boardHost: 'jobs.leadedge.com', displayName: 'Lead Edge Capital' }, // 1543 US rows
  { source: 'getro', slug: 'sapphire-ventures', networkId: 199, boardHost: 'jobs.sapphireventures.com', displayName: 'Sapphire Ventures' }, // 1490 US rows
  { source: 'getro', slug: 'craft-ventures', networkId: 340, boardHost: 'jobs.craftventures.com', displayName: 'Craft Ventures' }, // 1196 US rows
  { source: 'getro', slug: 'signalfire', networkId: 135, boardHost: 'jobs.signalfire.com', displayName: 'SignalFire' }, // 794 US rows
  { source: 'getro', slug: 'uncork-capital', networkId: 247, boardHost: 'jobs.uncorkcapital.com', displayName: 'Uncork Capital' }, // 511 US rows
  { source: 'getro', slug: 'true-ventures', networkId: 646, boardHost: 'jobs.trueventures.com', displayName: 'True Ventures' }, // 495 US rows
  { source: 'getro', slug: 'scale-venture-partners', networkId: 776, boardHost: 'jobs.scalevp.com', displayName: 'Scale Venture Partners' }, // 428 US rows
  { source: 'getro', slug: 'freestyle', networkId: 108, boardHost: 'jobs.freestyle.vc', displayName: 'Freestyle Capital' }, // 218 US rows

  // ── Security / networking employers (2026-11-23) ────────────────────────────
  // Found by `scripts/probe-boards.js names` for employers in Palo Alto
  // Networks' space that no board covered. None had a posting the filters keep
  // on the day (all senior or 3+ years), so these wait for entry-level openings
  // at one request per board per run. Not added: Teleport, Keeper Security,
  // Dragos and Cato Networks, each with 0-1 H-1B approvals, whose rows would
  // land UNKNOWN and stay out of the default view.
  { source: 'ashby', slug: 'gen-digital', displayName: 'Gen Digital' },  // 6 US software of 89 postings, 108 H-1B approvals
  { source: 'lever', slug: 'extremenetworks', displayName: 'Extreme Networks' },  // 13 US software of 71, 49 approvals
  { source: 'greenhouse', slug: 'cribl', displayName: 'Cribl' },  // 12 US software of 86, 26 approvals
  { source: 'greenhouse', slug: 'coalition', displayName: 'Coalition' },  // 7 US software of 43, 22 approvals
  { source: 'greenhouse', slug: 'pingidentity', displayName: 'Ping Identity' },  // 3 US software of 69, 16 approvals
  { source: 'greenhouse', slug: 'knowbe4', displayName: 'KnowBe4' },  // 2 US software of 57, 8 approvals
  { source: 'greenhouse', slug: 'beyondtrust', displayName: 'BeyondTrust Corporation' },  // 8 US software of 41, 4 approvals; the USCIS key's name
  // ── Employers from the curated new-grad lists (2026-11-23) ─────────────────
  // Mined from SimplifyJobs, vanshb03, speedyapply (SWE + AI), Zapply and
  // jobright-ai: US software postings at H-1B sponsors (3+ approvals) that no
  // board here covered. Universities, hospitals, government, law firms,
  // clearance-bound contractors, xAI and PNC were left out. Non-Workday
  // boards were run through their collector and normalizeJob on the day
  // ("kept" = rows a collect keeps now; most post senior roles between
  // new-grad cycles). Workday tenant / shard / site come from the lists' live
  // posting links and were not probed: Workday was rate-limiting the machine.
  { source: 'oracle_hcm', slug: 'honeywell-aerospace', apiHost: 'icfcjb.fa.ocs.oraclecloud.com', siteNumber: 'Aerospace', uiBaseUrl: 'https://icfcjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Aerospace', displayName: 'Honeywell Aerospace' },  // 6 kept, 18 US software of 500, 14 approvals
  { source: 'oracle_hcm', slug: 'texas-instruments', apiHost: 'edbz.fa.us2.oraclecloud.com', siteNumber: 'CX', uiBaseUrl: 'https://edbz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX', displayName: 'Texas Instruments' },  // 3 kept, 11 US software of 500, 389 approvals
  { source: 'oracle_hcm', slug: 'fortinet', apiHost: 'edel.fa.us2.oraclecloud.com', siteNumber: 'CX_2001', uiBaseUrl: 'https://edel.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001', displayName: 'Fortinet' },  // 3 kept, 20 US software of 500, 282 approvals
  { source: 'oracle_hcm', slug: 'emerson-electric', apiHost: 'hdjq.fa.us2.oraclecloud.com', siteNumber: 'CX_1', uiBaseUrl: 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1', displayName: 'Emerson Electric' },  // 3 kept, 12 US software of 500, 19 approvals
  { source: 'oracle_hcm', slug: 'akamai-technologies', apiHost: 'fa-extu-saasfaprod1.fa.ocs.oraclecloud.com', siteNumber: 'CX_1', uiBaseUrl: 'https://fa-extu-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1', displayName: 'Akamai Technologies' },  // 0 kept, 28 US software of 298, 360 approvals
  { source: 'oracle_hcm', slug: 'eclerx', apiHost: 'fa-ewji-saasfaprod1.fa.ocs.oraclecloud.com', siteNumber: 'CX_1', uiBaseUrl: 'https://fa-ewji-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1', displayName: 'eClerx' },  // 0 kept, 3 US software of 500, 17 approvals
  { source: 'greenhouse', slug: 'lilasciences', displayName: 'Lila Sciences' },  // 5 kept, 34 US software of 113, 36 approvals
  { source: 'greenhouse', slug: 'twitch', displayName: 'Twitch' },  // 3 kept, 14 US software of 50, 67 approvals
  { source: 'greenhouse', slug: 'koddi', displayName: 'Koddi' },  // 3 kept, 3 US software of 16, 8 approvals
  { source: 'greenhouse', slug: 'formlabs', displayName: 'Formlabs' },  // 1 kept, 12 US software of 271, 33 approvals
  { source: 'greenhouse', slug: 'cmt', displayName: 'Cambridge Mobile Telematics' },  // 1 kept, 3 US software of 4, 28 approvals
  { source: 'greenhouse', slug: 'acuitymd', displayName: 'AcuityMD' },  // 1 kept, 3 US software of 10, 8 approvals
  { source: 'greenhouse', slug: 'selffinancial', displayName: 'Self Financial' },  // 1 kept, 8 US software of 10, 4 approvals
  { source: 'greenhouse', slug: 'harbingermotors', displayName: 'Harbinger Motors' },  // 0 kept, 4 US software of 85, 73 approvals
  { source: 'greenhouse', slug: 'thebrattlegroup', displayName: 'The Brattle Group' },  // 0 kept, 2 US software of 44, 46 approvals
  { source: 'greenhouse', slug: 'addepar1', displayName: 'Addepar' },  // 0 kept, 18 US software of 119, 45 approvals
  { source: 'greenhouse', slug: 'clearstreet', displayName: 'Clear Street' },  // 0 kept, 13 US software of 33, 33 approvals
  { source: 'greenhouse', slug: 'scopely', displayName: 'Scopely' },  // 0 kept, 6 US software of 169, 29 approvals
  { source: 'greenhouse', slug: 'truveta', displayName: 'Truveta' },  // 0 kept, 5 US software of 36, 24 approvals
  { source: 'greenhouse', slug: 'teletrackingtechnologiesinc', displayName: 'TeleTracking Technologies' },  // 0 kept, 6 US software of 14, 20 approvals
  { source: 'greenhouse', slug: 'grahamcapitalmanagement', displayName: 'Graham Capital Management' },  // 0 kept, 2 US software of 13, 18 approvals
  { source: 'greenhouse', slug: 'datacor', displayName: 'Datacor' },  // 0 kept, 4 US software of 12, 8 approvals
  { source: 'greenhouse', slug: 'precisionmedicinegroup', displayName: 'Precision Medicine Group' },  // 0 kept, 1 US software of 145, 8 approvals
  { source: 'greenhouse', slug: 'nisc', displayName: 'National Information Solutions Cooperative' },  // 0 kept, 1 US software of 29, 6 approvals
  { source: 'greenhouse', slug: 'perpay', displayName: 'Perpay' },  // 0 kept, 8 US software of 15, 6 approvals
  { source: 'greenhouse', slug: 'nuancelabs', displayName: 'Nuance Labs' },  // 0 kept, 3 US software of 6, 6 approvals
  { source: 'greenhouse', slug: 'garnerhealth', displayName: 'Garner Health' },  // 0 kept, 15 US software of 58, 5 approvals
  { source: 'greenhouse', slug: 'theweathercompany', displayName: 'The Weather Company' },  // 0 kept, 5 US software of 36, 5 approvals
  { source: 'greenhouse', slug: 'evolver', displayName: 'Evolver' },  // 0 kept, 5 US software of 20, 5 approvals
  { source: 'greenhouse', slug: 'instalilyai', displayName: 'InstaLILY' },  // 0 kept, 4 US software of 24, 4 approvals
  { source: 'greenhouse', slug: 'sirenopt', displayName: 'SirenOpt' },  // 0 kept, 1 US software of 2, 3 approvals
  { source: 'ashby', slug: 'Commure', displayName: 'Commure' },  // 2 kept, 25 US software of 74, 66 approvals
  { source: 'ashby', slug: 'graymatter-robotics', displayName: 'GrayMatter Robotics' },  // 1 kept, 2 US software of 15, 17 approvals
  { source: 'ashby', slug: 'rivianvw.tech', displayName: 'Rivian' },  // 0 kept, 43 US software of 179, 68 approvals
  { source: 'ashby', slug: 'marianaminerals', displayName: 'Mariana Minerals' },  // 0 kept, 8 US software of 99, 16 approvals
  { source: 'ashby', slug: 'zefr', displayName: 'Zefr' },  // 0 kept, 2 US software of 7, 9 approvals
  { source: 'ashby', slug: 'ntt-data-aivista', displayName: 'NTT DATA AIVista' },  // 0 kept, 7 US software of 8, 9 approvals
  { source: 'ashby', slug: 'periodic-labs', displayName: 'Periodic Labs' },  // 0 kept, 10 US software of 30, 9 approvals
  { source: 'ashby', slug: 'old-mission-capital', displayName: 'Old Mission' },  // 0 kept, 12 US software of 39, 8 approvals
  { source: 'ashby', slug: 'rhoda-ai', displayName: 'Rhoda AI' },  // 0 kept, 13 US software of 42, 7 approvals
  { source: 'ashby', slug: 'qumulo', displayName: 'Qumulo' },  // 0 kept, 3 US software of 26, 5 approvals
  { source: 'ashby', slug: 'madhive', displayName: 'Madhive' },  // 0 kept, 1 US software of 6, 4 approvals
  { source: 'ashby', slug: 'cylake-inc', displayName: 'Cylake' },  // 0 kept, 6 US software of 15, 3 approvals
  { source: 'lever', slug: 'crosscountry-consulting', displayName: 'CrossCountry Consulting' },  // 3 kept, 5 US software of 99, 13 approvals
  { source: 'lever', slug: 'brillio-2', displayName: 'Brillio' },  // 0 kept, 10 US software of 215, 340 approvals
  { source: 'lever', slug: 'veeva', displayName: 'Veeva Systems' },  // 0 kept, 17 US software of 865, 133 approvals
  { source: 'lever', slug: 'plus-2', displayName: 'PlusAI' },  // 0 kept, 22 US software of 43, 30 approvals
  { source: 'lever', slug: 'glsllc', displayName: 'Global Lending Services' },  // 0 kept, 1 US software of 39, 19 approvals
  { source: 'lever', slug: 'revenueanalytics', displayName: 'Revenue Analytics' },  // 0 kept, 2 US software of 2, 10 approvals
  { source: 'lever', slug: 'genovatech', displayName: 'Genova Technologies' },  // 0 kept, 2 US software of 5, 6 approvals
  { source: 'lever', slug: 'hive', displayName: 'Hive' },  // 0 kept, 21 US software of 73, 5 approvals
  { source: 'lever', slug: 'artera', displayName: 'Artera' },  // 0 kept, 2 US software of 6, 5 approvals
  { source: 'lever', slug: 'kitware', displayName: 'Kitware' },  // 0 kept, 8 US software of 24, 4 approvals
  { source: 'lever', slug: 'datalabusa', displayName: 'DataLab USA' },  // 0 kept, 5 US software of 15, 3 approvals
  { source: 'workable', slug: 'multimediallc', displayName: 'Multi Media' },  // 1 kept, 1 US software of 3, 7 approvals
  { source: 'smartrecruiters', slug: 'Mirantis', displayName: 'Mirantis' },  // 1 kept, 2 US software of 2, 4 approvals
  { source: 'smartrecruiters', slug: 'MarlabsInc1', displayName: 'Marlabs' },  // 0 kept, 2 US software of 2, 136 approvals
  { source: 'workable', slug: 'flexcompute', displayName: 'Flexcompute' },  // 0 kept, 5 US software of 28, 8 approvals
  { source: 'workday', slug: 'walmart-walmartexternal', tenant: 'walmart', wd: '5', site: 'WalmartExternal', displayName: 'Walmart' },  // 1 list link, 5625 approvals
  { source: 'workday', slug: 'ghr-lateral-us', tenant: 'ghr', wd: '1', site: 'lateral-us', displayName: 'Bank of America' },  // 2 list links, 1151 approvals
  { source: 'workday', slug: 'ghr-us-emplsv', tenant: 'ghr', wd: '1', site: 'us-emplsv', displayName: 'Bank of America' },  // 2 list links, 1151 approvals
  { source: 'workday', slug: 'snapchat-snap', tenant: 'snapchat', wd: '1', site: 'snap', displayName: 'Snap' },  // 1 list link, 565 approvals
  { source: 'workday', slug: 'chewy-external', tenant: 'chewy', wd: '5', site: 'external', displayName: 'Chewy' },  // 3 list links, 410 approvals
  { source: 'workday', slug: 'thermofisher-thermofishercareers', tenant: 'thermofisher', wd: '5', site: 'thermofishercareers', displayName: 'Thermo Fisher Scientific' },  // 1 list link, 386 approvals
  { source: 'workday', slug: 'fmr-fidelitycareers', tenant: 'fmr', wd: '1', site: 'fidelitycareers', displayName: 'Fidelity Investments' },  // 5 list links, 299 approvals
  { source: 'workday', slug: 'fmr-targeted', tenant: 'fmr', wd: '1', site: 'targeted', displayName: 'Fidelity Investments' },  // 8 list links, 299 approvals
  { source: 'workday', slug: 'ffive-f5jobs', tenant: 'ffive', wd: '5', site: 'f5jobs', displayName: 'F5' },  // 1 list link, 266 approvals
  { source: 'workday', slug: 'northwesternmutual-corporate-careers', tenant: 'northwesternmutual', wd: '5', site: 'corporate-careers', displayName: 'Northwestern Mutual' },  // 1 list link, 204 approvals
  { source: 'workday', slug: 'mtb-campus', tenant: 'mtb', wd: '5', site: 'Campus', displayName: 'M&T Bank' },  // 5 list links, 166 approvals
  { source: 'workday', slug: 'mtb-mtb', tenant: 'mtb', wd: '5', site: 'mtb', displayName: 'M&T Bank' },  // 1 list link, 166 approvals
  { source: 'workday', slug: 'abb-external_career_page', tenant: 'abb', wd: '3', site: 'external_career_page', displayName: 'ABB' },  // 1 list link, 158 approvals
  { source: 'workday', slug: 'relx-risksolutions', tenant: 'relx', wd: '3', site: 'risksolutions', displayName: 'LexisNexis Risk Solutions' },  // 11 list links, 134 approvals
  { source: 'workday', slug: 'sbdinc-stanley_black_decker_career_site', tenant: 'sbdinc', wd: '1', site: 'Stanley_Black_Decker_Career_Site', displayName: 'Stanley Black & Decker' },  // 2 list links, 121 approvals
  { source: 'workday', slug: 'earlywarning-earlywarningcareers', tenant: 'earlywarning', wd: '5', site: 'earlywarningcareers', displayName: 'Early Warning' },  // 2 list links, 74 approvals
  { source: 'workday', slug: 'choicehotels-external', tenant: 'choicehotels', wd: '5', site: 'external', displayName: 'Choice Hotels' },  // 1 list link, 56 approvals
  { source: 'workday', slug: 'silabs-siliconlabscareers', tenant: 'silabs', wd: '1', site: 'SiliconlabsCareers', displayName: 'Silicon Laboratories' },  // 1 list link, 56 approvals
  { source: 'workday', slug: 'chamberlain-chamberlain_group', tenant: 'chamberlain', wd: '1', site: 'chamberlain_group', displayName: 'Chamberlain Group' },  // 1 list link, 53 approvals
  { source: 'workday', slug: 'globusmedical-gmed_careers', tenant: 'globusmedical', wd: '5', site: 'gmed_careers', displayName: 'Globus Medical' },  // 2 list links, 53 approvals
  { source: 'workday', slug: 'itw-external', tenant: 'itw', wd: '5', site: 'external', displayName: 'Illinois Tool Works' },  // 1 list link, 52 approvals
  { source: 'workday', slug: 'onto-onto_careers', tenant: 'onto', wd: '1', site: 'onto_careers', displayName: 'Onto Innovation' },  // 1 list link, 42 approvals
  { source: 'workday', slug: 'viavisolutions-careers', tenant: 'viavisolutions', wd: '1', site: 'careers', displayName: 'Viavi Solutions' },  // 1 list link, 42 approvals
  { source: 'workday', slug: 'vrtx-vertex_careers', tenant: 'vrtx', wd: '501', site: 'vertex_careers', displayName: 'Vertex' },  // 1 list link, 42 approvals
  { source: 'workday', slug: 'nextracker-nextpower_careers', tenant: 'nextracker', wd: '5', site: 'nextpower_careers', displayName: 'Nextpower' },  // 1 list link, 37 approvals
  { source: 'workday', slug: 'r1rcm-r1rcm', tenant: 'r1rcm', wd: '1', site: 'R1RCM', displayName: 'R1 RCM' },  // 1 list link, 34 approvals
  { source: 'workday', slug: 'ercot-ercot_careers', tenant: 'ercot', wd: '1', site: 'ercot_careers', displayName: 'Electric Reliability Council of Texas' },  // 1 list link, 28 approvals
  { source: 'workday', slug: 'gevernova-vernova_externalsite', tenant: 'gevernova', wd: '5', site: 'vernova_externalsite', displayName: 'GE Vernova' },  // 1 list link, 27 approvals
  { source: 'workday', slug: 'bmo-external', tenant: 'bmo', wd: '3', site: 'external', displayName: 'Bank of Montreal' },  // 1 list link, 20 approvals
  { source: 'workday', slug: 'axos-axos', tenant: 'axos', wd: '5', site: 'axos', displayName: 'Axos Bank' },  // 4 list links, 19 approvals
  { source: 'workday', slug: 'pg-1000', tenant: 'pg', wd: '5', site: '1000', displayName: 'Procter & Gamble' },  // 2 list links, 15 approvals
  { source: 'workday', slug: 'collegeboard-cbcareers', tenant: 'collegeboard', wd: '1', site: 'cbcareers', displayName: 'College Board' },  // 2 list links, 14 approvals
  { source: 'workday', slug: 'tandemdiabetes-tandemdiabetes', tenant: 'tandemdiabetes', wd: '12', site: 'tandemdiabetes', displayName: 'Tandem Diabetes Care' },  // 1 list link, 13 approvals
  { source: 'workday', slug: 'ascensushr-ascensuscareers', tenant: 'ascensushr', wd: '1', site: 'ascensuscareers', displayName: 'Ascensus' },  // 2 list links, 12 approvals
  { source: 'workday', slug: 'rbi-rbi_external_career_site', tenant: 'rbi', wd: '3', site: 'rbi_external_career_site', displayName: 'Restaurant Brands International' },  // 1 list link, 10 approvals
  { source: 'workday', slug: 'simmonsbank-simmonscareers', tenant: 'simmonsbank', wd: '5', site: 'simmonscareers', displayName: 'Simmons Bank' },  // 1 list link, 9 approvals
  { source: 'workday', slug: 'tplink-external', tenant: 'tplink', wd: '503', site: 'External', displayName: 'TP-Link Systems' },  // 1 list link, 8 approvals
  { source: 'workday', slug: 'directsupply-direct-supply-careers', tenant: 'directsupply', wd: '501', site: 'direct-supply-careers', displayName: 'Direct Supply' },  // 2 list links, 6 approvals
  // ── Jibe career sites (src/collectors/jibe.js, 2026-11-23) ────────────────
  // Employers that post only on an iCIMS Jibe site, found by the coverage audit.
  // Dry run on the day: raw postings / US software / kept (sponsorship YES).
  // AMD's kept rows all read NO, correctly: its postings say "This role is not
  // eligible for visa sponsorship". Costco was left out: its keyword searches
  // returned 826 postings and no US software role.
  { source: 'jibe', slug: 'amd', displayName: 'AMD', baseUrl: 'https://careers.amd.com' },  // 1182 / 69 / 11 (0 YES), 1260 approvals
  { source: 'jibe', slug: 'medpace', displayName: 'Medpace', baseUrl: 'https://careers.medpace.com' },  // 779 / 26 / 9 (9 YES), 48 approvals
  { source: 'jibe', slug: 'keysight', displayName: 'Keysight Technologies', baseUrl: 'https://jobs.keysight.com' },  // 810 / 39 / 2 (1 YES), 137 approvals
  { source: 'jibe', slug: 'rivian', displayName: 'Rivian Automotive', baseUrl: 'https://careers.rivian.com' },  // 995 / 63 / 1 (1 YES), 842 approvals
  { source: 'jibe', slug: 'ice', displayName: 'Intercontinental Exchange', baseUrl: 'https://careers.ice.com' },  // 309 / 36 / 1 (1 YES), 261 approvals
  { source: 'jibe', slug: 'sig', displayName: 'Susquehanna International Group', baseUrl: 'https://careers.sig.com' },  // 279 / 27 / 1 (1 YES), 111 approvals
  { source: 'jibe', slug: 'viasat', displayName: 'Viasat', baseUrl: 'https://careers.viasat.com' },  // 264 / 35 / 1 (1 YES), 61 approvals
  { source: 'jibe', slug: 'docusign', displayName: 'DocuSign', baseUrl: 'https://careers.docusign.com' },  // 239 / 28 / 0, 347 approvals
  { source: 'jibe', slug: 'first-citizens', displayName: 'First Citizens Bank', baseUrl: 'https://jobs.firstcitizens.com' },  // 360 / 20 / 0, 274 approvals

  // Pinpoint board named by a new-grad list link (2026-11-23): 2 kept, 2 US software of 14, 8 approvals.
  { source: 'pinpoint', slug: 'confluence', displayName: 'Confluence Technologies' },
  // ── Boards the browser extension used to cover (2026-11-23) ───────────────
  // Collected here instead, so they run in GitHub Actions with the computer off.
  // The Phenom career sites (careers.fiserv.com, careers.truist.com, …) are
  // front ends over Workday: their public /widgets search names each job's
  // Workday apply link, which gives tenant / shard / site. Not probed (Workday
  // was rate-limiting the machine). AmEx and Nokia serve Oracle Candidate
  // Experience on their own domains with the API on an oraclecloud.com host.
  // Still extension-only: Tesla and Wayfair (they block automated clients),
  // Yelp (iCIMS) and Corning (no apply link in its search API).
  { source: 'oracle_hcm', slug: 'american-express', apiHost: 'egug.fa.us2.oraclecloud.com', siteNumber: 'CX_1', uiBaseUrl: 'https://careers.americanexpress.com/en/sites/CX_1', displayName: 'American Express' },  // 5 kept (5 YES), 41 US software of 420, 1321 approvals
  { source: 'oracle_hcm', slug: 'navy-federal', apiHost: 'jobs.navyfederal.org', siteNumber: 'nfcu', uiBaseUrl: 'https://jobs.navyfederal.org/hcmUI/CandidateExperience/en/sites/nfcu', displayName: 'Navy Federal Credit Union' },  // 1 kept, 15 US software of 152, 292 approvals
  { source: 'oracle_hcm', slug: 'nokia', apiHost: 'fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com', siteNumber: 'CX_1', uiBaseUrl: 'https://jobs.nokia.com/en/sites/CX_1', displayName: 'Nokia of America' },  // 1 kept, 9 US software of 500, 549 approvals
  { source: 'workday', slug: 'fiserv-ext', tenant: 'fiserv', wd: '5', site: 'EXT', displayName: 'Fiserv' },  // 781 approvals (alias fiserv-solutions)
  { source: 'workday', slug: 'truist-careers', tenant: 'truist', wd: '1', site: 'Careers', displayName: 'Truist' },  // 545 approvals
  { source: 'workday', slug: 'swa-external', tenant: 'swa', wd: '1', site: 'external', displayName: 'Southwest Airlines' },  // 180 approvals
  { source: 'workday', slug: 'asurion-asurion_careers', tenant: 'asurion', wd: '5', site: 'Asurion_Careers', displayName: 'Asurion' },  // 169 approvals
  { source: 'workday', slug: 'asurion-asurioncareers_us', tenant: 'asurion', wd: '5', site: 'AsurionCareers_US', displayName: 'Asurion' },
  { source: 'workday', slug: 'jda-jda_careers', tenant: 'jda', wd: '5', site: 'JDA_Careers', displayName: 'Blue Yonder' },  // 163 approvals
  { source: 'workday', slug: 'warnerbros-global', tenant: 'warnerbros', wd: '5', site: 'global', displayName: 'Warner Bros. Discovery' },  // 126 approvals (alias warnermedia-services)
  { source: 'workday', slug: 'xboxgaming-blizzard_external_careers', tenant: 'xboxgaming', wd: '1', site: 'Blizzard_External_Careers', displayName: 'Blizzard Entertainment' },  // 100 approvals
  { source: 'workday', slug: 'boseallaboutme-bose_careers', tenant: 'boseallaboutme', wd: '503', site: 'Bose_Careers', displayName: 'Bose' },  // 51 approvals (alias bose-corporation)
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
  // Owner's call, 2026-10-31: delete after 14 days (shown for the first 7 —
  // see visibleDays).
  retentionDays: Number(process.env.RETENTION_DAYS || 14),

  // Display window: the board only SHOWS jobs posted (or, for undated sources,
  // first seen) within the last N days. Owner's call, 2026-10-31: nothing
  // older than a week. Shorter than retentionDays on purpose — undated
  // postings (Workday, Microsoft, the GitHub lists) are stamped with their
  // first-seen date, and deleting one lets the next collect re-insert it as
  // brand new. Kept but hidden in between, a still-open posting resurfaces
  // once per retention cycle rather than every week.
  visibleDays: Number(process.env.VISIBLE_DAYS || 7),

  requestTimeoutMs: 20_000,
  fetchConcurrency: 4, // parallel companies per source per run (default)
  // Per-source overrides; see collectAll(). Workday tenants are separate hosts.
  // Getro and Eightfold rate-limit by IP across all their tenants.
  // Workday rate-limits by IP across all tenants (HTTP 429), so it stays at 6
  // even though each tenant is its own host.
  sourceConcurrency: { workday: 6, getro: 2, eightfold: 1 },

  defaultPageSize: 50,
  maxPageSize: 200,
  cacheTtlMs: 30_000,
};

module.exports = { COMPANIES, CONFIG };
