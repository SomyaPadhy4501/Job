'use strict';

const microsoft = require('./microsoft');
const apple = require('./apple');
const meta = require('./meta');
const google = require('./google');

const REGISTRY = {
  [microsoft.source]: microsoft,
  [apple.source]: apple,
  [meta.source]: meta,
  [google.source]: google,
};

function getTarget(slug) {
  return REGISTRY[slug] || null;
}

module.exports = { REGISTRY, getTarget };
