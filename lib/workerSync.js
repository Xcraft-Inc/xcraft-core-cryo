const {SQLite} = require('xcraft-core-book');
const {MessagePortWritable} = require('./streamPort.mjs');
const {ReadableSQL} = require('./streamSQL.js');
const {pipeline} = require('node:stream/promises');

async function getAllPersist({port, location, db}) {
  const writeStream = new MessagePortWritable(port);
  const sqlite = new SQLite(location);
  try {
    sqlite.open(db);

    let lastPersist = `
      SELECT max(rowid) AS rowid, timestamp, goblin, action, version, type, commitId
      FROM actions
      GROUP BY goblin
      HAVING type = 'persist'
         AND commitId IS NOT NULL
      ORDER BY rowid
    `;
    lastPersist = sqlite.prepare(db, lastPersist);
    const readStream = new ReadableSQL(lastPersist, null, SQLite.wait);
    await pipeline(readStream, writeStream);
  } finally {
    sqlite.dispose();
  }
}

module.exports = {
  getAllPersist,
};
