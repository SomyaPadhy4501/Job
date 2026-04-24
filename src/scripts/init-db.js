'use strict';

const { getDb } = require('../db');

const db = getDb();
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);

console.log('DB initialized. Tables:', tables.join(', '));
