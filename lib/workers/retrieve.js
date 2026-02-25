const {SQLite} = require('xcraft-core-book');
const {MessagePortWritable} = require('../streamPort.js');
const {ReadableSQL} = require('../streamSQL.js');
const {pipeline} = require('node:stream/promises');

const cteRange = (and) => `
  WITH rowid_limits AS (
    SELECT (
      SELECT rowid
      FROM actions
      WHERE commitId = $fromCommitId
      ORDER BY rowid ASC LIMIT 1
    ) AS min_rowid,
    (
      SELECT rowid
      FROM actions
      WHERE commitId = $toCommitId
      ORDER BY rowid
      DESC LIMIT 1
    ) AS max_rowid
  ),
  range_actions AS (
    SELECT rowid, goblin, action, type, commitId
    FROM actions
    WHERE rowid BETWEEN (
      SELECT min_rowid
      FROM rowid_limits
    ) AND (
      SELECT max_rowid
      FROM rowid_limits
    )
    AND commitId NOT IN (${and})
    AND type = 'persist'
  )
`;

const queries = {
  lastPersist: `
    SELECT max(rowid) AS rowid, timestamp, goblin, action, version, type, commitId
    FROM actions
    GROUP BY goblin
    HAVING type = 'persist'
      AND commitId IS NOT NULL
    ORDER BY rowid
  `,
  lastPersistTo: `
    SELECT max(rowid) AS rowid, goblin, action, commitId
    FROM actions
    GROUP BY goblin
    HAVING type = 'persist'
      AND rowid <= (
        SELECT rowid
        FROM actions
        WHERE commitId = $toCommitId
        ORDER BY rowid DESC
        LIMIT 1
      )
    ORDER BY rowid
  `,
  lastPersistFromRangeToInc: `
    ${cteRange('$fromCommitId')}
    SELECT max(rowid) AS rowid, goblin, action, commitId
    FROM range_actions
    GROUP BY goblin
    ORDER BY rowid
  `,
  lastPersistFromRange: `
    ${cteRange('$fromCommitId, $toCommitId')}
    SELECT max(rowid) AS rowid, goblin, action, commitId
    FROM range_actions
    GROUP BY goblin
    ORDER BY rowid
  `,
};

async function getAllPersist({port, location, db}) {
  const writeStream = new MessagePortWritable(port);
  const sqlite = new SQLite(location);
  try {
    sqlite.open(db, null, queries, null, null, null, {readonly: true});
    const readStream = new ReadableSQL(
      sqlite.stmts(db).lastPersist,
      null,
      SQLite.wait
    );
    await pipeline(readStream, writeStream);
  } catch (ex) {
    port.postMessage(ex);
  } finally {
    sqlite.dispose();
  }
}

async function getPersistFromRange({
  port,
  location,
  db,
  fromCommitId,
  toCommitId,
  toInclusive,
}) {
  const writeStream = new MessagePortWritable(port);
  const sqlite = new SQLite(location);
  try {
    sqlite.open(db, null, queries, null, null, null, {readonly: true});

    let stmt;
    let params;

    if (!fromCommitId) {
      stmt = sqlite.stmts(db).lastPersistTo;
      params = {toCommitId};
    } else {
      stmt = toInclusive
        ? sqlite.stmts(db).lastPersistFromRangeToInc
        : sqlite.stmts(db).lastPersistFromRange;
      params = {fromCommitId, toCommitId};
    }
    const readStream = new ReadableSQL(stmt, params, SQLite.wait);
    await pipeline(readStream, writeStream);
  } catch (ex) {
    port.postMessage(ex);
  } finally {
    sqlite.dispose();
  }
}

module.exports = {
  getAllPersist,
  getPersistFromRange,
};
