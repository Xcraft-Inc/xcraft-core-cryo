const {SQLite} = require('xcraft-core-book');
const SoulSweeper = require('../lib/soulSweeper.js');

const dbName = 'my_database'; /* without .db */
const dbLocation = '/mnt/somewhere'; /* just the directory */

const sqlite = new SQLite(dbLocation);
sqlite.open(dbName, '', {});

const soulSweeper = new SoulSweeper(sqlite.getHandle(dbName), dbName);
soulSweeper.sweepForWeeks(30, false);
