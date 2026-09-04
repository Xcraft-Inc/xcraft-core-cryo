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
    SELECT a.rowid, a.timestamp, a.goblin, a.action, a.version, a.type, a.commitId
    FROM actions a
    WHERE a.type = 'persist'
      AND a.commitId IS NOT NULL
      AND a.rowid = (
        SELECT MAX(b.rowid)
        FROM actions b
        WHERE b.goblin = a.goblin
          AND b.type = 'persist'
          AND b.commitId IS NOT NULL
      )
    ORDER BY a.rowid
  `,
  lastPersistTo: `
    WITH to_commit AS (
      SELECT rowid
      FROM actions
      WHERE commitId = $toCommitId
      ORDER BY rowid DESC
      LIMIT 1
    )
    SELECT a.rowid, a.goblin, a.action, a.commitId
    FROM actions a
    WHERE a.type = 'persist'
      AND a.rowid <= (SELECT rowid FROM to_commit)
      AND a.rowid = (
        SELECT MAX(b.rowid)
        FROM actions b
        WHERE b.goblin = a.goblin
          AND b.type = 'persist'
          AND b.rowid <= (SELECT rowid FROM to_commit)
      )
    ORDER BY a.rowid
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
  let readStream;
  const writeStream = new MessagePortWritable(port);
  const sqlite = new SQLite(location);
  try {
    sqlite.open(db, null, queries, null, null, null, {readonly: true});
    sqlite._db[db].unsafeMode(true);

    readStream = new ReadableSQL(
      sqlite.stmts(db).lastPersist,
      null,
      SQLite.wait
    );
    await pipeline(readStream, writeStream);
  } catch (ex) {
    port.postMessage(ex);
  } finally {
    if (readStream) {
      readStream.abort();
    }
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
  let readStream;
  const writeStream = new MessagePortWritable(port);
  const sqlite = new SQLite(location);
  try {
    sqlite.open(db, null, queries, null, null, null, {readonly: true});
    sqlite._db[db].unsafeMode(true);

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
    readStream = new ReadableSQL(stmt, params, SQLite.wait);
    await pipeline(readStream, writeStream);
  } catch (ex) {
    port.postMessage(ex);
  } finally {
    if (readStream) {
      readStream.abort();
    }
    sqlite.dispose();
  }
}

module.exports = {
  getAllPersist,
  getPersistFromRange,
};
