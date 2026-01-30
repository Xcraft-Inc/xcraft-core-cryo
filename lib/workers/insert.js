'use strict';

const {SQLite} = require('xcraft-core-book');

async function populate({
  db,
  location,
  enableFTS,
  enableVEC,
  defaultLocale,
  indices = [],
  vecFunc = 'vec_f32',
}) {
  const sqlite = new SQLite(location);
  try {
    sqlite.open(db);

    if (enableFTS) {
      const sql = `
        INSERT INTO fts_idx(rowid, data)
        SELECT rowid, json_extract(action, '$.payload.state.meta.index')
        FROM lastPersistedActions;
      `;
      sqlite.exec(db, sql);
    }

    if (enableVEC) {
      const sqliteVec = require('../sqlite-vec/loader.js');
      sqliteVec.load(sqlite._db[db]);

      const sql = `
        WITH entity AS (
          SELECT action
          FROM lastPersistedActions
        )
        INSERT INTO embeddings (locale, scope, documentId, chunkId, chunk, embedding)
        SELECT
          IFNULL(json_extract(entity.action, '$.payload.state.meta.locale'), '${defaultLocale}'),
          json_extract(entity.action, '$.payload.state.meta.scope'),
          json_extract(entity.action, '$.payload.state.id'),
          json_each.key,
          json_extract(json_each.value, '$.chunk'),
          ${vecFunc}(unhex(json_extract(json_each.value, '$.embedding')))
        FROM entity, json_each(json_extract(entity.action, '$.payload.state.meta.vectors'));
      `;
      sqlite.exec(db, sql);
    }

    for (const index of indices) {
      sqlite.exec(index);
    }

    sqlite.exec(db, `PRAGMA analysis_limit=1000; ANALYZE;`);
  } finally {
    sqlite.dispose();
  }
}

async function embed({
  db,
  location,
  goblin,
  defaultLocale,
  vecFunc = 'vec_f32',
}) {
  const sqlite = new SQLite(location);
  try {
    sqlite.open(db);

    const sqliteVec = require('../sqlite-vec/loader.js');
    sqliteVec.load(sqlite._db[db]);

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
        ${vecFunc}(unhex(json_extract(json_each.value, '$.embedding')))
      FROM entity, json_each(json_extract(entity.action, '$.payload.state.meta.vectors'));
    `;
    await SQLite.wait(() => sqlite.exec(db, sql));
  } finally {
    sqlite.dispose();
  }
}

module.exports = {
  populate,
  embed,
};
