'use strict';

const {SQLite} = require('xcraft-core-book');
const Batcher = require('xcraft-core-utils/lib/batcher.js');

function getQueries(vecFunc, enableVec = false) {
  const queries = {
    immediate: `BEGIN IMMEDIATE TRANSACTION`,
    commit: `COMMIT TRANSACTION`,
    populateFTS: `
      INSERT INTO fts_idx(rowid, data)
      SELECT rowid, json_extract(action, '$.payload.state.meta.index')
      FROM lastPersistedActions
    `,
  };
  if (!enableVec) {
    return queries;
  }

  const queriesVec = {
    populateVec: `
      WITH entity AS (
        SELECT max(rowid) AS rowid, lastPersistedActions.action as action
        FROM actions, lastPersistedActions
        WHERE actions.goblin = lastPersistedActions.goblin
          AND actions.type = 'persist'
        GROUP BY actions.goblin
      )
      INSERT INTO embeddings (locale, scope, documentId, chunkId, chunk, embedding)
      SELECT
        IFNULL(json_extract(entity.action, '$.payload.state.meta.locale'), $defaultLocale),
        json_extract(entity.action, '$.payload.state.meta.scope'),
        json_extract(entity.action, '$.payload.state.id'),
        json_each.key,
        json_extract(json_each.value, '$.chunk'),
        ${vecFunc}(unhex(json_extract(json_each.value, '$.embedding')))
      FROM entity, json_each(json_extract(entity.action, '$.payload.state.meta.vectors'))
    `,
    populateVecIndex: `
      INSERT OR REPLACE INTO embeddingsIndex (documentId, documentRowid)
      SELECT json_extract(lastPersistedActions.action, '$.payload.state.id'),
             max(actions.rowid)
      FROM actions, lastPersistedActions
      WHERE actions.goblin = lastPersistedActions.goblin
        AND actions.type = 'persist'
      GROUP BY actions.goblin
    `,
    deleteEmbed: `
      DELETE FROM embeddings
      WHERE documentId = $documentId
    `,
    deleteEmbedIndex: `
      DELETE FROM embeddingsIndex
      WHERE documentId = $documentId
    `,
    insertEmbed: `
      WITH entity AS (
        SELECT rowid, action
        FROM actions
        WHERE goblin = $goblin
          AND type = 'persist'
        ORDER BY rowid DESC
        LIMIT 1
      )
      INSERT INTO embeddings (locale, scope, documentId, chunkId, chunk, embedding)
      SELECT
        IFNULL(json_extract(entity.action, '$.payload.state.meta.locale'), $defaultLocale),
        json_extract(entity.action, '$.payload.state.meta.scope'),
        json_extract(entity.action, '$.payload.state.id'),
        json_each.key,
        json_extract(json_each.value, '$.chunk'),
        ${vecFunc}(unhex(json_extract(json_each.value, '$.embedding')))
      FROM entity, json_each(json_extract(entity.action, '$.payload.state.meta.vectors'))
    `,
    insertEmbedIndex: `
      INSERT OR REPLACE INTO embeddingsIndex (documentId, documentRowid)
      SELECT $documentId, rowid
      FROM actions
      WHERE goblin = $goblin
        AND type = 'persist'
      ORDER BY rowid DESC
      LIMIT 1
    `,
    outdated: `
      WITH entities AS (
        SELECT max(actions.rowid) AS rowid,
               json_extract(lastPersistedActions.action, '$.payload.state.id') AS documentId,
               lastPersistedActions.goblin as goblin
        FROM actions, lastPersistedActions
        WHERE actions.goblin = lastPersistedActions.goblin
          AND actions.type = 'persist'
        GROUP BY actions.goblin
      )
      SELECT entities.goblin AS goblin
      FROM entities
      LEFT JOIN embeddingsIndex ON embeddingsIndex.documentId = entities.documentId
      WHERE embeddingsIndex.documentId IS NULL
         OR embeddingsIndex.documentRowid != entities.rowid
    `,
  };
  return Object.assign(queries, queriesVec);
}

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
    sqlite.open(db, null, getQueries(vecFunc, enableVEC), () => {
      if (enableVEC) {
        const sqliteVec = require('../sqlite-vec/loader.js');
        sqliteVec.load(sqlite._db[db]);
      }
    });

    if (enableFTS) {
      sqlite.stmts(db).populateFTS.run();
    }
    if (enableVEC) {
      sqlite.stmts(db).immediate.run();
      sqlite.stmts(db).populateVec.run({defaultLocale});
      sqlite.stmts(db).populateVecIndex.run();
      sqlite.stmts(db).commit.run();
    }

    for (const index of indices) {
      sqlite.exec(index);
    }

    sqlite.exec(db, `PRAGMA analysis_limit=1000; ANALYZE;`);
  } catch (ex) {
    console.error(ex.stack || ex.message || ex);
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
    sqlite.open(db, null, getQueries(vecFunc, true), () => {
      const sqliteVec = require('../sqlite-vec/loader.js');
      sqliteVec.load(sqlite._db[db]);
    });

    const documentId = `${goblin.substring(goblin.indexOf('-') + 1)}`;
    await SQLite.wait(() => {
      sqlite.stmts(db).immediate.run();
      sqlite.stmts(db).deleteEmbed.run({documentId});
      sqlite.stmts(db).deleteEmbedIndex.run({documentId});
      sqlite.stmts(db).insertEmbed.run({goblin, defaultLocale});
      sqlite.stmts(db).insertEmbedIndex.run({documentId, goblin});
      sqlite.stmts(db).commit.run();
    });
  } catch (ex) {
    console.error(ex.stack || ex.message || ex);
  } finally {
    sqlite.dispose();
  }
}

async function refreshEmbeddings({
  db,
  location,
  defaultLocale,
  vecFunc = 'vec_f32',
}) {
  let batcher;
  const sqlite = new SQLite(location);
  try {
    sqlite.open(db, null, getQueries(vecFunc, true), () => {
      const sqliteVec = require('../sqlite-vec/loader.js');
      sqliteVec.load(sqlite._db[db]);
    });

    const outdated = sqlite.stmts(db).outdated.all();

    batcher = new Batcher(
      async () => await SQLite.wait(() => sqlite.stmts(db).immediate.run()),
      async () => await SQLite.wait(() => sqlite.stmts(db).commit.run())
    );

    await batcher.start();

    for (const {goblin} of outdated) {
      if (!(await batcher.pump())) {
        break;
      }
      const documentId = `${goblin.substring(goblin.indexOf('-') + 1)}`;
      sqlite.stmts(db).deleteEmbed.run({documentId});
      sqlite.stmts(db).deleteEmbedIndex.run({documentId});
      sqlite.stmts(db).insertEmbed.run({goblin, defaultLocale});
      sqlite.stmts(db).insertEmbedIndex.run({documentId, goblin});
    }
  } catch (ex) {
    console.error(ex.stack || ex.message || ex);
  } finally {
    if (batcher) {
      await batcher.stop();
    }
    sqlite.dispose();
  }
}

module.exports = {
  populate,
  embed,
  refreshEmbeddings,
};
