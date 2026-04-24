'use strict';

const greenhouse = require('./greenhouse');
const lever = require('./lever');
const ashby = require('./ashby');
const workday = require('./workday');
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
