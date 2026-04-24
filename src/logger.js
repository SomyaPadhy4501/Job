'use strict';

function ts() {
  return new Date().toISOString();
}

function log(level, msg, meta) {
  const line = meta
    ? `[${ts()}] ${level} ${msg} ${JSON.stringify(meta)}`
    : `[${ts()}] ${level} ${msg}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

module.exports = {
  info: (msg, meta) => log('INFO ', msg, meta),
  warn: (msg, meta) => log('WARN ', msg, meta),
  error: (msg, meta) => log('ERROR', msg, meta),
  debug: (msg, meta) => {
    if (process.env.DEBUG) log('DEBUG', msg, meta);
  },
};
