'use strict';

const greenhouse = require('./greenhouse');
const lever = require('./lever');
const ashby = require('./ashby');
const workday = require('./workday');
const oracleHcm = require('./oracle_hcm');
const pcsx = require('./pcsx');
const capgemini = require('./capgemini');
const wipro = require('./wipro');
const goldmanSachs = require('./goldman_sachs');
const ibm = require('./ibm');
const amazon = require('./amazon');
const apple = require('./apple');
const microsoft = require('./microsoft');
const bytedance = require('./bytedance');
const uber = require('./uber');
const netflix = require('./netflix');
const ghlistings = require('./ghlistings');
const hnHiring = require('./hn_hiring');
const jsonld = require('./jsonld');
const adzuna = require('./adzuna');
const getro = require('./getro');
const eightfold = require('./eightfold');
const smartrecruiters = require('./smartrecruiters');
const rippling = require('./rippling');
const workable = require('./workable');
const recruitee = require('./recruitee');
const pinpoint = require('./pinpoint');
const gem = require('./gem');
const bamboohr = require('./bamboohr');
const mdtable = require('./mdtable');
const jibe = require('./jibe');
const jsearch = require('./jsearch');

// Registry keyed by source. Adding a new source = drop a module here.
//
// `fullListing: true` on a module means one successful answer names every open
// posting of that company, so closed-job detection (src/services/closed.js)
// may delete stored rows it stops listing. Leave it off for anything that
// searches, caps, filters by date or relays other sites: Workday, PCSX,
// Microsoft, jsonld, Getro, the aggregators. Also for a source name the
// scraper or extension ingests under (apple, microsoft, …): those rows share
// the name but not the listing.
const REGISTRY = {
  [greenhouse.source]: greenhouse,
  [lever.source]: lever,
  [ashby.source]: ashby,
  [workday.source]: workday,
  [oracleHcm.source]: oracleHcm,
  [pcsx.source]: pcsx,
  [capgemini.source]: capgemini,
  [wipro.source]: wipro,
  [goldmanSachs.source]: goldmanSachs,
  [ibm.source]: ibm,
  [amazon.source]: amazon,
  [apple.source]: apple,
  [microsoft.source]: microsoft,
  [bytedance.source]: bytedance,
  [uber.source]: uber,
  [netflix.source]: netflix,
  [ghlistings.source]: ghlistings,
  [hnHiring.source]: hnHiring,
  [jsonld.source]: jsonld,
  [adzuna.source]: adzuna,
  [getro.source]: getro,
  [eightfold.source]: eightfold,
  [smartrecruiters.source]: smartrecruiters,
  [rippling.source]: rippling,
  [workable.source]: workable,
  [recruitee.source]: recruitee,
  [pinpoint.source]: pinpoint,
  [gem.source]: gem,
  [bamboohr.source]: bamboohr,
  [mdtable.source]: mdtable,
  [jibe.source]: jibe,
  [jsearch.source]: jsearch,
};

function getCollector(source) {
  return REGISTRY[source] || null;
}

module.exports = { getCollector, REGISTRY };
