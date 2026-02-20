'use strict';

const {SQLite} = require('xcraft-core-book');

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
    deleteOutdatedEmbeds: `
      DELETE FROM embeddings
      WHERE documentId IN (
        WITH entities AS (
          SELECT max(actions.rowid) AS rowid,
                 json_extract(lastPersistedActions.action, '$.payload.state.id') AS documentId
          FROM actions, lastPersistedActions
          WHERE actions.goblin = lastPersistedActions.goblin
            AND actions.type = 'persist'
          GROUP BY actions.goblin
        )
        SELECT entities.documentId
        FROM entities
        LEFT JOIN embeddingsIndex ON embeddingsIndex.documentId = entities.documentId
        WHERE embeddingsIndex.documentId IS NULL
           OR embeddingsIndex.documentRowid != entities.rowid
      )
    `,
    deleteOutdatedEmbedIndex: `
      DELETE FROM embeddingsIndex
      WHERE documentId IN (
        WITH entities AS (
          SELECT max(actions.rowid) AS rowid,
                 json_extract(lastPersistedActions.action, '$.payload.state.id') AS documentId
          FROM actions, lastPersistedActions
          WHERE actions.goblin = lastPersistedActions.goblin
            AND actions.type = 'persist'
          GROUP BY actions.goblin
        )
        SELECT entities.documentId
        FROM entities
        LEFT JOIN embeddingsIndex ON embeddingsIndex.documentId = entities.documentId
        WHERE embeddingsIndex.documentId IS NULL
           OR embeddingsIndex.documentRowid != entities.rowid
      )
    `,
    insertOutdatedEmbeds: `
      WITH entities AS (
        SELECT max(actions.rowid) AS rowid,
               lastPersistedActions.action AS action,
               lastPersistedActions.goblin AS goblin
        FROM actions, lastPersistedActions
        WHERE actions.goblin = lastPersistedActions.goblin
          AND actions.type = 'persist'
        GROUP BY actions.goblin
      ),
      outdated AS (
        SELECT entities.*,
               json_extract(entities.action, '$.payload.state.id') AS documentId
        FROM entities
        LEFT JOIN embeddingsIndex ON embeddingsIndex.documentId = json_extract(entities.action, '$.payload.state.id')
        WHERE embeddingsIndex.documentId IS NULL
           OR embeddingsIndex.documentRowid != entities.rowid
      )
      INSERT INTO embeddings (locale, scope, documentId, chunkId, chunk, embedding)
      SELECT
        IFNULL(json_extract(outdated.action, '$.payload.state.meta.locale'), $defaultLocale),
        json_extract(outdated.action, '$.payload.state.meta.scope'),
        outdated.documentId,
        json_each.key,
        json_extract(json_each.value, '$.chunk'),
        ${vecFunc}(unhex(json_extract(json_each.value, '$.embedding')))
      FROM outdated, json_each(json_extract(outdated.action, '$.payload.state.meta.vectors'))
    `,
    insertOutdatedEmbedIndex: `
      WITH entities AS (
        SELECT max(actions.rowid) AS rowid,
               lastPersistedActions.action AS action,
               lastPersistedActions.goblin AS goblin
        FROM actions, lastPersistedActions
        WHERE actions.goblin = lastPersistedActions.goblin
          AND actions.type = 'persist'
        GROUP BY actions.goblin
      )
      INSERT OR REPLACE INTO embeddingsIndex (documentId, documentRowid)
      SELECT json_extract(entities.action, '$.payload.state.id'),
             entities.rowid
      FROM entities
      LEFT JOIN embeddingsIndex ON embeddingsIndex.documentId = json_extract(entities.action, '$.payload.state.id')
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
  const sqlite = new SQLite(location);
  try {
    sqlite.open(db, null, getQueries(vecFunc, true), () => {
      const sqliteVec = require('../sqlite-vec/loader.js');
      sqliteVec.load(sqlite._db[db]);
    });

    await SQLite.wait(() => {
      sqlite.stmts(db).immediate.run();
      sqlite.stmts(db).deleteOutdatedEmbeds.run();
      sqlite.stmts(db).deleteOutdatedEmbedIndex.run();
      sqlite.stmts(db).insertOutdatedEmbeds.run({defaultLocale});
      sqlite.stmts(db).insertOutdatedEmbedIndex.run();
      sqlite.stmts(db).commit.run();
    });
  } catch (ex) {
    console.error(ex.stack || ex.message || ex);
  } finally {
    sqlite.dispose();
  }
}

module.exports = {
  populate,
  embed,
  refreshEmbeddings,
};
