'use strict';

const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require('node:worker_threads');
const xLog = require('xcraft-core-log')('worker');

if (isMainThread) {
  module.exports = (defaultLocale, dbName, location) => {
    return new Worker(__filename, {
      workerData: {defaultLocale, dbName, location},
    });
  };
  return;
}

const {SQLite} = require('xcraft-core-book');

const {defaultLocale, dbName, location} = workerData;
const sqlite = new SQLite(location);
sqlite.open(dbName);

const sqliteVec = require('./loader.js');
sqliteVec.load(sqlite._db[dbName]);

function dispose() {
  sqlite.dispose();
  parentPort.close();
  process.exit(0);
}

function embed(goblin) {
  const documentId = `${goblin.substring(goblin.indexOf('-') + 1)}`;
  const sql = `
    DELETE FROM embeddings
    WHERE documentId = '${documentId}';
    WITH entity AS (
      SELECT action
      FROM actions
      WHERE goblin = '${goblin}'
      ORDER BY rowId DESC
      LIMIT 1
    )
    INSERT INTO embeddings (locale, scope, documentId, chunkId, chunk, embedding)
    SELECT
      IFNULL(json_extract(entity.action, '$.payload.state.meta.locale'), '${defaultLocale}'),
      json_extract(entity.action, '$.payload.state.meta.scope'),
      json_extract(entity.action, '$.payload.state.id'),
      json_each.key,
      json_extract(json_each.value, '$.chunk'),
      vec_f32(unhex(json_extract(json_each.value, '$.embedding')))
    FROM entity, json_each(json_extract(entity.action, '$.payload.state.meta.vectors'));
  `;
  SQLite.wait(() => sqlite.exec(dbName, sql));
}

parentPort.on('message', ({cmd, goblin}) => {
  if (cmd === 'dispose') {
    dispose();
  } else {
    try {
      embed(goblin);
    } catch (ex) {
      xLog.err(ex.stack || ex.message || ex);
    }
  }
});

process.on('SIGTERM', () => dispose());
