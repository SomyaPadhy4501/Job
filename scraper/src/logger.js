'use strict';

function ts() { return new Date().toISOString(); }
function line(level, msg, meta) {
  const rendered = meta
    ? `[${ts()}] ${level} scraper ${msg} ${JSON.stringify(meta)}`
    : `[${ts()}] ${level} scraper ${msg}`;
  if (level === 'ERROR') console.error(rendered);
  else console.log(rendered);
}
module.exports = {
  info:  (m, x) => line('INFO ', m, x),
  warn:  (m, x) => line('WARN ', m, x),
  error: (m, x) => line('ERROR', m, x),
  debug: (m, x) => { if (process.env.DEBUG) line('DEBUG', m, x); },
};
