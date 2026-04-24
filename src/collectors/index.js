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
const amazon = require('./amazon');
const microsoft = require('./microsoft');
const uber = require('./uber');
const netflix = require('./netflix');
const ghlistings = require('./ghlistings');
const hnHiring = require('./hn_hiring');

// Registry keyed by source. Adding a new source = drop a module here.
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
  [amazon.source]: amazon,
  [microsoft.source]: microsoft,
  [uber.source]: uber,
  [netflix.source]: netflix,
  [ghlistings.source]: ghlistings,
  [hnHiring.source]: hnHiring,
};

function getCollector(source) {
  return REGISTRY[source] || null;
}

module.exports = { getCollector, REGISTRY };
