'use strict';

const microsoft = require('./microsoft');
const apple = require('./apple');
const meta = require('./meta');
const google = require('./google');
const deloitte = require('./deloitte');
const phenom = require('./phenom');
const builtin = require('./builtin');

const REGISTRY = {
  [microsoft.source]: microsoft,
  [apple.source]: apple,
  [meta.source]: meta,
  [google.source]: google,
  [deloitte.source]: deloitte,
  [phenom.source]: phenom,
  [builtin.source]: builtin,
};

function getTarget(slug) {
  return REGISTRY[slug] || null;
}

module.exports = { REGISTRY, getTarget };
