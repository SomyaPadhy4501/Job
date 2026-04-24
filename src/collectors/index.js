'use strict';

const greenhouse = require('./greenhouse');
const lever = require('./lever');
const ashby = require('./ashby');
const workday = require('./workday');
const amazon = require('./amazon');
const microsoft = require('./microsoft');
const newgrad2027 = require('./newgrad2027');

// Registry keyed by source. Adding a new source = drop a module here.
const REGISTRY = {
  [greenhouse.source]: greenhouse,
  [lever.source]: lever,
  [ashby.source]: ashby,
  [workday.source]: workday,
  [amazon.source]: amazon,
  [microsoft.source]: microsoft,
  [newgrad2027.source]: newgrad2027,
};

function getCollector(source) {
  return REGISTRY[source] || null;
}

module.exports = { getCollector, REGISTRY };
