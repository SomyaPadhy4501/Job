'use strict';

// Start the API without the scheduler — useful during frontend development.
const { getDb } = require('../db');
const { startApi } = require('../api/server');

getDb();
startApi();
