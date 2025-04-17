'use strict';

const path = require('path');
const fs = require('fs');
const watt = require('gigawatts');
const safeStringify = require('safe-stable-stringify');
const xFs = require('xcraft-core-fs');
const {SQLite} = require('xcraft-core-book');
const {locks} = require('xcraft-core-utils');
const {getRoutingKey} = require('xcraft-core-host');
const {ReadableSQL, WritableSQL} = require('./streamSQL.js');
const Streamer = require('xcraft-core-transport/lib/streamer.js');
const SoulSweeper = require('./soulSweeper.js');

const versionPragma = 10;

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Cryo extends SQLite {
  #soulSweeper = {};
  #userIndices = {};
  #boostrapping = false;

  constructor(cryoConfig, appVersion = null, location = null) {
    if (!location) {
      const xConfig = require('xcraft-core-etc')().load('xcraft');
      location = path.join(xConfig.xcraftRoot, 'var/cryo');
    }
    if (!appVersion) {
      try {
        const xHost = require('xcraft-core-host');
        appVersion = xHost.appVersion;
      } catch (ex) {
        if (ex.code !== 'MODULE_NOT_FOUND') {
          throw ex;
        }
        appVersion = 'unknown';
      }
    }

    const goblinConfig = require('xcraft-core-etc')().load(
      'xcraft-core-goblin'
    );

    super(location);

    /* A middleware takes one or more rows and returns zero or more rows.
     * The base middleware is just returning the row as it.
     */
    this._middleware = (rows) => rows;

    this._cryoConfig = cryoConfig || {};
    this._cryoDir = location;
    this._version = appVersion;
    this._journal = this._cryoConfig?.journal || 'WAL';
    this._lastActionTriggers = {};
    this._syncLock = locks.getMutex;
    this._triggerNotifs = {};
    this._ftsTables = '';
    this._vecTables = '';
    this._useSync = !!goblinConfig.actionsSync?.enable;

    this._tables = `
      CREATE TABLE IF NOT EXISTS actions (
        rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        goblin    TEXT,
        action    JSON,
        version   TEXT,
        type      TEXT,
        commitId  TEXT DEFAULT NULL
      );
    `;

    if (this._cryoConfig?.enableTimetable) {
      //inspired by Jeff Clark work:
      //https://gist.github.com/jclark017/84ead375b5d4c7b0193b254e7438a211#file-complexdimension-sql
      this._tables += `
        CREATE TABLE IF NOT EXISTS timetable AS
        -- Initiate the recursive loop
        WITH RECURSIVE
        -- Define a CTE to hold the recursive output
        rDateDimensionMinute (CalendarDateInterval)
        AS
            (
                -- The anchor of the recursion is the start date of the date dimension
                SELECT datetime('2000-01-01 00:00:00')
                UNION ALL
                -- The recursive query increments the time interval by the desired amount
                -- This can be any time increment (monthly, daily, hours, minutes)
                SELECT datetime(CalendarDateInterval, '+24 hour') FROM rDateDimensionMinute
                -- Set the number of recursions
                -- Functionally, this is the number of periods in the date dimension
                LIMIT 64000
            )
        -- Output the result set to the permanent table
        -- +86399 second  =>  near 1 day (0,99998843 day)
        SELECT
            CalendarDateInterval,
            datetime(CalendarDateInterval, '+86399 second') CalendarDateIntervalEnd,
            strftime('%w',CalendarDateInterval)	DayNumber,
            case cast (strftime('%w', CalendarDateInterval) as integer)
            when 0 then 'Sunday'
            when 1 then 'Monday'
            when 2 then 'Tuesday'
            when 3 then 'Wednesday'
            when 4 then 'Thursday'
            when 5 then 'Friday'
            when 6 then 'Saturday' end DayOfWeek,
            cast (strftime('%W', CalendarDateInterval) as integer) WeekNumber,
            substr('SunMonTueWedThuFriSat', 1 + 3*strftime('%w', CalendarDateInterval), 3) DayOfWeekAbbr,
            strftime('%d',CalendarDateInterval)	DayOfMonth,
            case cast (strftime('%w', CalendarDateInterval) as integer)
            when 0 then 1
            when 6 then 1
            else 0 end IsWeekend,
            case cast (strftime('%w', CalendarDateInterval) as integer)
            when 0 then 0
            when 6 then 0
            else 1 end IsWeekday,
            strftime('%m',CalendarDateInterval)	MonthNumber,
            case strftime('%m', date(CalendarDateInterval))
                when '01' then 'January'
                when '02' then 'Febuary'
                when '03' then 'March'
                when '04' then 'April'
                when '05' then 'May'
                when '06' then 'June'
                when '07' then 'July'
                when '08' then 'August'
                when '09' then 'September'
                when '10' then 'October'
                when '11' then 'November'
                when '12' then 'December' else '' end MonthName,
            case strftime('%m', date(CalendarDateInterval))
                when '01' then 'Jan'
                when '02' then 'Feb'
                when '03' then 'Mar'
                when '04' then 'Apr'
                when '05' then 'May'
                when '06' then 'Jun'
                when '07' then 'Jul'
                when '08' then 'Aug'
                when '09' then 'Sep'
                when '10' then 'Oct'
                when '11' then 'Nov'
                when '12' then 'Dec' else '' end MonthAbbr,
            strftime('%Y',CalendarDateInterval)	YearNumber
        FROM rDateDimensionMinute;
      `;
    }

    if (this._cryoConfig?.enableFTS) {
      this._ftsTables = `
        CREATE TABLE IF NOT EXISTS lastPersistedActions (
          goblin TEXT PRIMARY KEY,
          action JSON,
          timestamp TEXT
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS fts_idx USING fts5(data, content='lastPersistedActions', content_rowid='rowid');

        CREATE TRIGGER IF NOT EXISTS actions_ai AFTER INSERT ON actions
        WHEN
          new.type = 'persist' AND (
               json_extract(new.action, '$.payload.state.meta.status') != 'trashed'
            OR json_extract(new.action, '$.payload.state.meta.status') IS NULL
          )
        BEGIN
          INSERT INTO lastPersistedActions(goblin, action, timestamp) VALUES (new.goblin, new.action, new.timestamp)
          ON CONFLICT
          DO UPDATE SET
            action = new.action,
            timestamp = new.timestamp;
        END;

        CREATE TRIGGER IF NOT EXISTS actions_revoker AFTER INSERT ON actions
        WHEN
          new.type = 'persist' AND
          json_extract(new.action,'$.payload.state.meta.status') = 'trashed'
        BEGIN
          DELETE FROM lastPersistedActions WHERE goblin = new.goblin;
        END;

        CREATE TRIGGER IF NOT EXISTS lastPersistedActions_onInsert
        AFTER INSERT ON lastPersistedActions
        BEGIN
          SELECT onInsertLastAction(
            NEW.goblin
          );
        END;

        CREATE TRIGGER IF NOT EXISTS lastPersistedActions_onUpdate
        AFTER UPDATE ON lastPersistedActions
        BEGIN
          SELECT onUpdateLastAction(
            NEW.goblin
          );
        END;

        CREATE TRIGGER IF NOT EXISTS lastPersistedActions_onDelete
        AFTER DELETE ON lastPersistedActions
        BEGIN
          SELECT onDeleteLastAction(
            OLD.goblin
          );
        END;

        CREATE TRIGGER IF NOT EXISTS lastPersistedActions_ai AFTER INSERT ON lastPersistedActions BEGIN
          INSERT INTO fts_idx(rowid, data) VALUES (NEW.rowid, json_extract(NEW.action,'$.payload.state.meta.index'));
        END;

        CREATE TRIGGER IF NOT EXISTS lastPersistedActions_ad AFTER DELETE ON lastPersistedActions BEGIN
          INSERT INTO fts_idx(fts_idx, rowid, data) VALUES('delete', OLD.rowid, json_extract(OLD.action,'$.payload.state.meta.index'));
        END;

        CREATE TRIGGER IF NOT EXISTS lastPersistedActions_au AFTER UPDATE ON lastPersistedActions BEGIN
          INSERT INTO fts_idx(fts_idx, rowid, data) VALUES('delete', OLD.rowid, json_extract(OLD.action,'$.payload.state.meta.index'));
          INSERT INTO fts_idx(rowid, data) VALUES (NEW.rowid, json_extract(NEW.action,'$.payload.state.meta.index'));
        END;

        CREATE INDEX IF NOT EXISTS lastPersistedActions_goblin
          ON lastPersistedActions (goblin);
      `;
    }

    if (this._cryoConfig?.enableVEC && this._cryoConfig?.enableFTS) {
      const defaultLocale = this._cryoConfig?.vec.defaultLocale;
      const dimensions = this._cryoConfig?.vec?.dimensions;
      this._vecTables = `
      CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
            locale TEXT partition key,
            scope TEXT,
            documentId TEXT,
            +chunkId TEXT,
            +chunk TEXT,
            embedding FLOAT[${dimensions}] distance_metric=cosine
      );

      CREATE TRIGGER IF NOT EXISTS lastPersistedActions_ai_vectors AFTER INSERT ON lastPersistedActions BEGIN
          INSERT INTO embeddings (locale, scope, documentId, chunkId, chunk, embedding)
          SELECT
              IFNULL(json_extract(NEW.action,'$.payload.state.meta.locale'),'${defaultLocale}'),
              json_extract(NEW.action,'$.payload.state.meta.scope'),
              json_extract(NEW.action,'$.payload.state.id'),
              json_each.key,
              json_extract(json_each.value, '$.chunk'),
              json_extract(json_each.value, '$.embedding')
          FROM json_each(json_extract(NEW.action,'$.payload.state.meta.vectors'));
        END;

        CREATE TRIGGER IF NOT EXISTS lastPersistedActions_ad_vectors AFTER DELETE ON lastPersistedActions BEGIN
          DELETE FROM embeddings
          WHERE documentId = json_extract(OLD.action,'$.payload.state.id');
        END;

        CREATE TRIGGER IF NOT EXISTS lastPersistedActions_au_vectors AFTER UPDATE ON lastPersistedActions BEGIN
          DELETE FROM embeddings
          WHERE documentId = json_extract(OLD.action,'$.payload.state.id');
          INSERT INTO embeddings (locale, scope, documentId, chunkId, chunk, embedding)
          SELECT
              IFNULL(json_extract(NEW.action,'$.payload.state.meta.locale'),'${defaultLocale}'),
              json_extract(NEW.action,'$.payload.state.meta.scope'),
              json_extract(NEW.action,'$.payload.state.id'),
              json_each.key,
              json_extract(json_each.value, '$.chunk'),
              json_extract(json_each.value, '$.embedding')
          FROM json_each(json_extract(NEW.action,'$.payload.state.meta.vectors'));
        END;
      `;
    }

    this._indices = `
      CREATE INDEX IF NOT EXISTS ripley
        ON actions (goblin, timestamp DESC);
      CREATE INDEX IF NOT EXISTS timestamp
        ON actions (timestamp);
      CREATE INDEX IF NOT EXISTS goblin
        ON actions (goblin);
      CREATE INDEX IF NOT EXISTS type
        ON actions (type);
      CREATE INDEX IF NOT EXISTS commitId
        ON actions (commitId);
    `;

    this._queries = {};

    ///////////////////// RIPLEY /////////////////////

    this._queries.isEmpty = `
      SELECT count(rowid) AS count
      FROM actions
    `;

    this._queries.freeze = `
      INSERT INTO actions (timestamp, goblin, action, version, type, commitId)
      VALUES ($timestamp, $goblin, $action, $version, $type, $commitId)
    `;

    this._queries.deleteHistory = `
      DELETE FROM actions
       WHERE goblin = $goblin
         AND rowid < $rowid
    `;

    this._queries.thaw = `
      SELECT *
      FROM actions
      WHERE timestamp <= $timestamp
      GROUP BY goblin
      HAVING max(timestamp)
    `;

    this._queries.frozen = `
      SELECT count(*) AS count, timestamp
      FROM (${this._queries.thaw} ORDER BY timestamp)
    `;

    this._queries.partialThaw = `
      SELECT *
      FROM actions
      WHERE goblin LIKE $type
        AND timestamp <= $timestamp
      GROUP BY goblin
      HAVING max(timestamp)
      LIMIT $length
      OFFSET $offset
    `;

    this._queries.partialFrozen = `
      SELECT count(*) AS count, timestamp
      FROM (
        SELECT *
        FROM actions
        WHERE goblin LIKE $type
          AND timestamp <= $timestamp
        GROUP BY goblin
        HAVING max(timestamp)
        ORDER BY timestamp
      )`;

    this._queries.getEntityTypeCount = `
      SELECT substr(goblin, 1, pos-1) AS type, COUNT(*) as 'count'
      FROM (
        SELECT goblin,instr(goblin,'-') AS pos
        FROM actions
        GROUP BY goblin
      )
      GROUP BY type
      ORDER BY type;
    `;

    this._queries.actions = `
      SELECT timestamp, goblin
      FROM actions
      WHERE timestamp BETWEEN $from AND $to
      ORDER BY timestamp
    `;

    this._queries.trim = `
      DELETE
      FROM actions
      WHERE timestamp > $timestamp
    `;

    ///////////////////// SYNC /////////////////////

    this._queries.lastType = `
      SELECT type
      FROM actions
      WHERE goblin = $goblin
      ORDER BY rowid DESC
      LIMIT 1
    `;

    this._queries.countCreate = `
      SELECT count(*) AS count
      FROM actions
      WHERE goblin = $goblin
        AND type = 'create'
    `;

    this._queries.hasPersist = `
      SELECT 1 AS exist
      FROM actions
      WHERE goblin = $goblin
        AND type = 'persist'
      LIMIT 1
    `;

    this._queries.allStagedActions = `
      SELECT rowid, action
      FROM actions
      WHERE commitId IS NULL
        AND type != 'persist'
      ORDER BY rowid ASC
    `;

    this._queries.allStagedActionsForBootstrap = `
      SELECT *
      FROM actions
      WHERE rowid >= (
        SELECT rowid
        FROM actions
        WHERE commitId IS NULL
          AND type != 'persist'
        ORDER BY rowid ASC
        LIMIT 1
      )
      ORDER BY rowid ASC
    `;

    this._queries.hasCommitId = `
      SELECT commitId
      FROM actions
      WHERE commitId = $commitId
      ORDER BY rowid DESC
      LIMIT 1
    `;

    this._queries.lastCommitId = `
      SELECT commitId
      FROM actions
      WHERE commitId IS NOT NULL
        AND commitId != '00000000-0000-0000-0000-000000000000'
        AND type = 'persist'
      ORDER BY rowid DESC
      LIMIT 1
    `;

    /* List 5 commitId (or less): the last, the 10th, the 100th, the 200th and the 1000th */
    this._queries.commitIdsList = `
      WITH filtered_actions AS (
        SELECT commitId, rowid
        FROM actions
        WHERE commitId IS NOT NULL
          AND commitId != '00000000-0000-0000-0000-000000000000'
          AND type = 'persist'
        ORDER BY rowid DESC
      )
      SELECT DISTINCT commitId
      FROM filtered_actions
      WHERE rowid = (SELECT rowid FROM filtered_actions LIMIT 1 OFFSET 0)
         OR rowid = (SELECT rowid FROM filtered_actions LIMIT 1 OFFSET 10)
         OR rowid = (SELECT rowid FROM filtered_actions LIMIT 1 OFFSET 100)
         OR rowid = (SELECT rowid FROM filtered_actions LIMIT 1 OFFSET 200)
         OR rowid = (SELECT rowid FROM filtered_actions LIMIT 1 OFFSET 1000);
    `;

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

    this._queries.lastPersistFromRange = `
      ${cteRange('$fromCommitId, $toCommitId')}
      SELECT max(rowid) AS rowid, goblin, action, type, commitId
      FROM range_actions
      GROUP BY goblin
      ORDER BY rowid
    `;

    this._queries.lastPersistFromRangeToInc = `
      ${cteRange('$fromCommitId')}
      SELECT max(rowid) AS rowid, goblin, action, type, commitId
      FROM range_actions
      GROUP BY goblin
      ORDER BY rowid
    `;

    this._queries.lastPersistTo = `
      SELECT max(rowid) AS rowid, goblin, action, type, commitId
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
    `;

    this._queries.lastPersist = `
      SELECT max(rowid) AS rowid, timestamp, goblin, action, version, type, commitId
      FROM actions
      GROUP BY goblin
      HAVING type = 'persist'
         AND commitId IS NOT NULL
      ORDER BY rowid
    `;

    this._queries.zeroActions = `
      SELECT rowid, goblin
      FROM actions
      WHERE type != 'persist'
        AND commitId = '00000000-0000-0000-0000-000000000000'
    `;

    ///////////////////// OTHER /////////////////////

    this._queries.hasGoblin = `
      SELECT 1 AS exist
      FROM actions
      WHERE goblin = $goblin
      LIMIT 1
    `;

    ///////////////////// UTILS /////////////////////

    this._queries.attach = `ATTACH DATABASE $db AS dump`;
    this._queries.detach = `DETACH DATABASE dump`;
    this._queries.begin = `BEGIN TRANSACTION;`;
    this._queries.exclusive = `BEGIN EXCLUSIVE TRANSACTION;`;
    this._queries.immediate = `BEGIN IMMEDIATE TRANSACTION;`;
    this._queries.commit = `COMMIT TRANSACTION;`;
    this._queries.rollback = `ROLLBACK TRANSACTION;`;

    watt.wrapAll(this);
  }

  dispose() {
    for (const db of Object.keys(this._db)) {
      this.exec(
        db,
        `PRAGMA analysis_limit=1000;
         PRAGMA optimize;`
      );
    }
    super.dispose();
  }

  _sendNotifs(resp, on, db, goblin) {
    if (this.#boostrapping) {
      return;
    }

    const [actorType] = goblin.split('-', 1);
    const triggers = this._lastActionTriggers[actorType];
    if (triggers) {
      triggers[on].forEach((topic) => {
        if (this.inTransaction(db) === true) {
          if (!this._triggerNotifs[db]) {
            this._triggerNotifs[db] = [];
          }
          this._triggerNotifs[db].push({topic, goblin});
        } else {
          resp.events.send(topic, goblin);
        }
      });
    }
  }

  _open(dbName, resp) {
    if (this._db[dbName]) {
      return true;
    }

    let version;
    let tables = this._tables;
    let enableFTS = this._cryoConfig?.enableFTS;
    let enableVEC = this._cryoConfig?.enableVEC;

    /* Ignore the first dot because in this case it's a bootstrapped database. */
    let cmpDbName = dbName;
    if (cmpDbName.startsWith('.')) {
      cmpDbName = cmpDbName.substring(1);
    }

    if (
      enableFTS &&
      (!this._cryoConfig?.fts?.list?.length ||
        this._cryoConfig?.fts?.list?.includes(cmpDbName))
    ) {
      tables += this._ftsTables;
      if (
        enableVEC &&
        (!this._cryoConfig?.vec?.list?.length ||
          this._cryoConfig?.vec?.list?.includes(cmpDbName))
      ) {
        tables += this._vecTables;
      } else {
        enableVEC = false;
      }
    } else {
      enableFTS = false;
    }

    let _indices = this._indices;

    if (enableFTS && this.#userIndices[dbName]) {
      for (const index of this.#userIndices[dbName]) {
        _indices += `
          CREATE INDEX IF NOT EXISTS json_${index}
            ON lastPersistedActions (json_extract(action, '$.payload.state.${index}'));
        `;
      }
    }

    let indicesCnt = 0;

    const res = super.open(
      dbName,
      tables,
      this._queries,
      /* onOpen */
      () => {
        super.exec(dbName, 'PRAGMA case_sensitive_like = true');
        super.exec(dbName, `PRAGMA journal_mode = ${this._journal}`);
        if (this._journal === 'WAL') {
          super.exec(dbName, `PRAGMA synchronous = NORMAL`);
        }
        version = super.pragma(dbName, 'user_version');
        if (!version) {
          super.exec(dbName, `PRAGMA user_version = ${versionPragma};`);
        }

        indicesCnt = this._countIndices(dbName, enableFTS);
        if (enableFTS) {
          this.function(
            dbName,
            'onInsertLastAction',
            (goblin) =>
              this._sendNotifs(resp, 'onInsert', dbName, goblin) || null
          );

          this.function(
            dbName,
            'onUpdateLastAction',
            (goblin) =>
              this._sendNotifs(resp, 'onUpdate', dbName, goblin) || null
          );

          this.function(
            dbName,
            'onDeleteLastAction',
            (goblin) =>
              this._sendNotifs(resp, 'onDelete', dbName, goblin) || null
          );

          if (enableVEC) {
            const sqliteVec = require('./sqlite-vec/loader.js');
            sqliteVec.load(this._db[dbName]);
          }
        }
      },
      /* onMigrate */
      () => {
        version = super.pragma(dbName, 'user_version');
        if (!version) {
          super.exec(
            dbName,
            `ALTER TABLE actions ADD COLUMN version TEXT;
             PRAGMA user_version = ${versionPragma};`
          );
        }
        if (version < 3) {
          super.exec(
            dbName,
            `ALTER TABLE actions ADD COLUMN type TEXT;
             PRAGMA user_version = ${versionPragma};`
          );
        }
        if (version < 6) {
          super.exec(
            dbName,
            `ALTER TABLE actions ADD COLUMN commitId TEXT DEFAULT NULL;
             PRAGMA user_version = ${versionPragma};`
          );
        }
        if (version < 7) {
          super.exec(
            dbName,
            `DROP TRIGGER IF EXISTS actions_ai;
             DROP INDEX IF EXISTS hash;
             DROP INDEX IF EXISTS source;
             DROP INDEX IF EXISTS uuid;`
          );

          const drops = [
            'ALTER TABLE actions DROP COLUMN hash;',
            'ALTER TABLE actions DROP COLUMN source;',
            'ALTER TABLE actions DROP COLUMN uuid;',
            'ALTER TABLE lastPersistedActions DROP COLUMN hash;',
            'ALTER TABLE lastPersistedActions DROP COLUMN uuid;',
          ];
          for (const drop of drops) {
            try {
              super.exec(dbName, drop);
            } catch (ex) {
              resp.log.warn(ex.stack || ex.message || ex);
            }
          }

          super.exec(dbName, `PRAGMA user_version = ${versionPragma};`);
        }
        if (version < 8) {
          super.exec(
            dbName,
            `DROP TRIGGER IF EXISTS actions_ai2;
             PRAGMA user_version = ${versionPragma};`
          );
        }
        if (version < 9) {
          super.exec(
            dbName,
            `DROP TABLE IF EXISTS blobs;
             PRAGMA user_version = ${versionPragma};`
          );
        }
        if (version < 10) {
          if (enableFTS && this.#userIndices[dbName]) {
            for (const index of this.#userIndices[dbName]) {
              super.exec(dbName, `DROP INDEX IF EXISTS json_${index};`);
            }
          }
          super.exec(dbName, `PRAGMA user_version = ${versionPragma};`);
        }

        if (enableVEC) {
          const row = super
            .prepare(
              dbName,
              "SELECT sql FROM sqlite_master WHERE tbl_name = 'embeddings'"
            )
            .get();
          if (row && row.sql) {
            resp.log.dbg(`Vector extension enabled, checking dimensions...`);
            // Regex pour extraire la dimension du vecteur (FLOAT[1024])
            const match = row.sql.match(/embedding\s+FLOAT\[(\d+)\]/i);
            if (match && match[1]) {
              const dimensions = this._cryoConfig?.vec?.dimensions;
              const existingDimensions = parseInt(match[1], 10);
              if (existingDimensions !== dimensions) {
                resp.log.warn(`Should drop embeddings table:
                current dimensions: FLOAT[${existingDimensions}]
                new dimensions configured: FLOAT[${dimensions}]`);
                super.exec(dbName, `DROP TABLE embeddings`);
                super.exec(
                  dbName,
                  `CREATE VIRTUAL TABLE  embeddings USING vec0(
                    locale TEXT partition key,
                    scope TEXT,
                    documentId TEXT,
                    +chunkId TEXT,
                    +chunk TEXT,
                    embedding FLOAT[${dimensions}] distance_metric=cosine
                )`
                );
                resp.log.dbg(`New embeddings table created.`);
              } else {
                resp.log.dbg(`Nothing to do.`);
              }
            }
          }
          resp.log.dbg(`Vector extension enabled`);
        }
      },
      _indices
    );
    if (!res) {
      resp.log.warn('something wrong happens with SQLite');
    } else {
      /* Delete garbage (goblin's types that no longer exist) */
      const garbageGoblins = this._cryoConfig.migrations.cleanings?.[dbName];
      if (garbageGoblins) {
        for (const goblin of garbageGoblins) {
          this._deleteGoblins(dbName, 'actions', goblin);
          this._deleteGoblins(dbName, 'lastPersistedActions', goblin);
        }
      }

      const cnt = this._countIndices(dbName, enableFTS);
      if (indicesCnt !== cnt) {
        super.exec(
          dbName,
          `PRAGMA analysis_limit=1000;
           PRAGMA optimize;`
        );
      }
    }

    this._db[dbName].unsafeMode(true);

    this.#soulSweeper[dbName] = new SoulSweeper(
      this._db[dbName],
      dbName,
      this._useSync
    );
    return res;
  }

  _deleteGoblins(db, table, goblin) {
    const query = `DELETE FROM ${table} WHERE goblin GLOB ?;`;
    const stmt = super.prepare(db, query);
    stmt.run(`${goblin}-${goblin}@*`);
  }

  _countIndices(db, enableFTS) {
    const exec = (table) => {
      const query = `PRAGMA index_list(${table});`;
      const stmt = super.prepare(db, query);
      return stmt.all().length;
    };

    let cnt = 0;
    let indices = exec('actions');
    cnt += indices;
    if (enableFTS) {
      indices = exec('lastPersistedActions');
      cnt += indices;
    }
    return cnt;
  }

  _setIndices(db, indices) {
    if (!this.#userIndices[db]) {
      this.#userIndices[db] = [];
    }
    this.#userIndices[db].push(...indices);
  }

  /**
   * Apply the middleswares on the row.
   *
   * The middlewares are used for updating the data according to new models.
   * It's possible to split a row in multiple rows or maybe to skip the row.
   * It depends of middlewares added with _addMiddlewares.
   *
   * @param {object} row - The row which includes the action.
   * @returns {Function} a function called for each new rows.
   */
  _runMiddlewares(row) {
    const rows = this._middleware([row]);
    return (callback) => rows.forEach((row) => callback(row));
  }

  /**
   * Add a new middleware which takes rows and returns zero or more rows.
   * The middleware can split a row in multiple rows or even skip the row.
   *
   * @param {Function} newMiddleware - The new middleware function.
   */
  _addMiddleware(newMiddleware) {
    const _prevMiddleware = this._middleware;
    this._middleware = (rows) => _prevMiddleware(newMiddleware(rows));
  }

  static async wait(handler) {
    let res;
    for (let wait = true; wait; ) {
      try {
        res = handler();
        wait = false;
      } catch (ex) {
        wait =
          ex.code === 'SQLITE_BUSY' ||
          ex.code === 'SQLITE_LOCKED' ||
          // See https://github.com/WiseLibs/better-sqlite3/issues/203
          // 'This database connection is busy executing a query'
          // 'This statement is busy executing a query'
          (ex.message && ex.message.endsWith('is busy executing a query'));
        if (!wait) {
          throw ex;
        }
        await timeout(400);
      }
    }
    return res;
  }

  loadMiddleware(resp, msg) {
    const {middlewarePath} = msg.data;
    if (require.cache[middlewarePath]) {
      return;
    }
    const newMiddleware = require(middlewarePath);
    this._addMiddleware(newMiddleware);
  }

  getLocation() {
    return this._cryoDir;
  }

  isEmpty(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    const dbPath = this._path(db);

    if (!fs.existsSync(dbPath)) {
      return {exists: false, empty: true};
    }

    if (!this._open(db, resp)) {
      throw new Error(
        `It's not possible to open or create the database ${dbPath}`
      );
    }

    const result = this.stmts(db).isEmpty.get();
    const empty = !result || result.count === 0;
    return {exists: true, empty};
  }

  sync(resp) {
    if (!this.tryToUse()) {
      return;
    }
  }

  init(resp, msg) {
    if (!this.tryToUse()) {
      return false;
    }

    const {db} = msg.data;
    return !!this._open(db, resp);
  }

  async begin(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    await this._syncLock.lock(this._path(db));
    try {
      this.stmts(db).begin.run();
    } catch (ex) {
      await this._syncLock.unlock(this._path(db));
      throw ex;
    }
  }

  async immediate(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    await this._syncLock.lock(this._path(db));
    try {
      await Cryo.wait(() => this.stmts(db).immediate.run());
    } catch (ex) {
      this._syncLock.unlock(this._path(db));
      throw ex;
    }
  }

  async exclusive(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    await this._syncLock.lock(this._path(db));
    try {
      await Cryo.wait(() => this.stmts(db).exclusive.run());
    } catch (ex) {
      this._syncLock.unlock(this._path(db));
      throw ex;
    }
  }

  async commit(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;

    if (!this._open(db, resp)) {
      return;
    }

    await Cryo.wait(() => this.stmts(db).commit.run());

    try {
      /* Send all pending events after commit (events coming from the triggers) */
      if (this._triggerNotifs[db]) {
        for (const {topic, goblin} of this._triggerNotifs[db]) {
          resp.events.send(topic, goblin);
        }
        this._triggerNotifs[db].length = 0;
      }
    } finally {
      this._syncLock.unlock(this._path(db));
    }
  }

  async rollback(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    try {
      await Cryo.wait(() => this.stmts(db).rollback.run());
    } finally {
      this._syncLock.unlock(this._path(db));
    }
  }

  registerLastActionTriggers(resp, msg) {
    const {actorType, onInsertTopic, onUpdateTopic, onDeleteTopic} = msg.data;
    if (!this._cryoConfig?.enableFTS) {
      throw new Error('FTS not enabled in config, unable to register triggers');
    }
    if (!this._lastActionTriggers[actorType]) {
      this._lastActionTriggers[actorType] = {
        onInsert: new Set(),
        onUpdate: new Set(),
        onDelete: new Set(),
      };
    }
    const triggers = this._lastActionTriggers[actorType];
    if (onInsertTopic) {
      triggers.onInsert.add(onInsertTopic);
    }
    if (onUpdateTopic) {
      triggers.onUpdate.add(onUpdateTopic);
    }
    if (onDeleteTopic) {
      triggers.onDelete.add(onDeleteTopic);
    }
  }

  unregisterLastActionTriggers(resp, msg) {
    const {actorType, onInsertTopic, onUpdateTopic, onDeleteTopic} = msg.data;
    if (!this._cryoConfig?.enableFTS) {
      throw new Error(
        'FTS not enabled in config, unable to unregister triggers'
      );
    }
    const triggers = this._lastActionTriggers[actorType];
    if (!triggers) {
      return;
    }
    if (onInsertTopic) {
      triggers.onInsert.delete(onInsertTopic);
    }
    if (onUpdateTopic) {
      triggers.onUpdate.delete(onUpdateTopic);
    }
    if (onDeleteTopic) {
      triggers.onDelete.delete(onDeleteTopic);
    }
  }

  /**
   * Persist data in the store.
   *
   * @param {object} resp - Response object provided by busClient.
   * @param {object} msg - Original bus message.
   * @returns {object|undefined} the whole payload.
   */
  async freeze(resp, msg) {
    if (!this.tryToUse()) {
      return null;
    }

    const {db, action, rules, raw = false} = msg.data;
    if (!this._open(db, resp)) {
      return null;
    }

    if (rules.mode !== 'all' && rules.mode !== 'last') {
      resp.log.warn(
        `rules mode (${rules.mode}) different of "all" or "last" are not supported`
      );
      return null;
    }

    const {goblin, mode} = rules;

    try {
      /* Skip this 'persist' if the last action is not a persist.
       * The 'persist' provided in raw comes from the server side.
       * If a the last action is not a persist, it means that a
       * Cryo transaction is open. In this case the persist action
       * provided by the server is too old; then we skip this one
       * for the next time.
       */
      if (raw && action?.type === 'persist') {
        const result = this.stmts(db).lastType.get({goblin});
        if (result && result.type !== 'persist') {
          return null;
        }
      }

      const commitId = action.payload?.commitId || action.meta?.commitId;
      const _action = raw ? action.meta.action : safeStringify(action);
      const payload = {
        timestamp: this.timestamp(),
        goblin,
        action: _action,
        version: this._version,
        type: action?.type,
        commitId,
      };

      await Cryo.wait(() => {
        const {lastInsertRowid} = this.stmts(db).freeze.run(payload);
        /* Keep only the last action (no history) */
        if (mode === 'last' && commitId) {
          this.stmts(db).deleteHistory.run({
            goblin: payload.goblin,
            rowid: lastInsertRowid,
          });
        }
      });
      return payload;
    } catch (ex) {
      resp.log.err(
        `freeze has failed with ${goblin}: ${ex.stack || ex.message || ex}`
      );
      /* Continue because at least this payload must be added to the
       * cache feeders. An error with cryo is not fatal. The entity should
       * be edited again.
       */
      return null;
    }
  }

  /**
   * Retrieve actions from the store.
   *
   * @param {object} resp - Response object provided by busClient.
   * @param {object} msg - Original bus message.
   * @returns {number|undefined} number of sent events
   */
  thaw(resp, msg) {
    if (!this.tryToUse()) {
      return null;
    }

    const {db, timestamp, type, length, offset} = msg.data;
    if (!this._open(db, resp)) {
      return null;
    }

    let stmt = 'thaw';
    const params = {timestamp};

    if (type && length) {
      stmt = 'partialThaw';
      Object.assign(params, {type: `${type}-%`, length, offset});
    }

    //count the number of rows/events sent
    let count = 0;

    for (const row of this.stmts(db)[stmt].iterate(params)) {
      const rows = [];
      ++count;
      this._runMiddlewares(row)((row) => {
        rows.push(row);
      });
      //one action (row) can endup to 0..n actions (rows)
      //but we must keep "one event by action" sent, for
      //batching correctly, consumer know the number of row by type
      resp.events.send(`cryo.thawed.${db}`, rows);
    }

    return count;
  }

  /**
   * Get statistics on actions.
   *
   * @param {object} resp - Response object provided by busClient.
   * @param {object} msg - Original bus message.
   * @returns {object|undefined} the number of frozen actions.
   */
  frozen(resp, msg) {
    if (!this.tryToUse()) {
      return null;
    }

    const {db, timestamp, type} = msg.data;
    if (!this._open(db, resp)) {
      return null;
    }

    let stmt = 'frozen';
    const params = {timestamp};

    if (type) {
      stmt = 'partialFrozen';
      Object.assign(params, {type: `${type}-%`});
    }

    return this.stmts(db)[stmt].get(params);
  }

  /**
   * Restore an action store to a particular timestamp.
   *
   * @param {object} resp - Response object provided by busClient.
   * @param {object} msg - Original bus message.
   */
  restore(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {dbSrc, dbDst, timestamp} = msg.data;

    if (dbSrc !== dbDst) {
      this.close(dbDst);

      const src = this._path(dbSrc);
      const dst = this._path(dbDst);
      xFs.cp(src, dst);
    } else {
      const src = this._path(dbSrc);
      const dst = this._path(this.getBranchedDbName(dbSrc));
      xFs.cp(src, dst);
    }

    if (!this._open(dbDst, resp)) {
      return;
    }

    this.stmts(dbDst).trim.run({
      timestamp,
    });
  }

  branch(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    this.close(db);

    const src = this._path(db);
    const dst = this._path(this.getBranchedDbName(db));
    try {
      fs.renameSync(src, dst);
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }
    }
  }

  getBranchedDbName(db) {
    const timestamp = this.timestamp().replace(/-|:|\./g, '');
    return `${db}_${timestamp}`;
  }

  dump(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {dbName, dbDst, timestamp} = msg.data;

    if (!this._open(dbName, resp)) {
      return;
    }

    try {
      this.stmts(dbName).attach.run({db: dbDst});
      super.exec(
        dbName,
        `CREATE TABLE IF NOT EXISTS dump.actions (
           timestamp TEXT,
           goblin    TEXT,
           action    JSON,
           version   TEXT,
           hash      TEXT,
           type      TEXT,
           source    TEXT
         )`
      );
      super.exec(
        dbName,
        `INSERT INTO dump.actions
         SELECT *
         FROM main.actions
         WHERE timestamp <= "${timestamp}"
         GROUP BY goblin
         HAVING max(timestamp)
        `
      );
    } finally {
      this.stmts(dbName).detach.run({});
    }
  }

  /**
   * Check if Cryo is usable.
   *
   * @returns {boolean} true if SQLite is available.
   */
  usable() {
    return super.usable();
  }

  /**
   * Extract a list of actions metadata according to a timestamp range.
   *
   * @param {object} resp - Response object provided by busClient.
   * @param {object} msg - Original bus message.
   */
  actions(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db, from, to} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    for (const row of this.stmts(db).actions.iterate({from, to})) {
      resp.events.send(`cryo.actions.${db}`, row);
    }
  }

  /**
   * Extract grouped goblin types with aggregated count
   *
   * @param {object} resp - Response object provided by busClient.
   * @param {object} msg - Original bus message.
   * @returns {Array|undefined} item Object with type and count.
   */
  getEntityTypeCount(resp, msg) {
    if (!this.tryToUse()) {
      return null;
    }
    const {db} = msg.data;
    let rows = [];
    if (!db) {
      throw Error('db not set for getEntityTypeCount !');
    }
    if (!this._open(db, resp)) {
      return;
    }
    rows = this.stmts(db).getEntityTypeCount.all();
    return rows;
  }

  /**
   * Extract the list of all databases and branches.
   *
   * @param {object} resp - Response object provided by busClient.
   * @returns {Array|undefined} the list of databases and branches.
   */
  branches(resp) {
    if (!this.tryToUse()) {
      return null;
    }

    const list = {};

    try {
      xFs.ls(this._cryoDir, /\.db$/).forEach((file) => {
        const _file = path.basename(file, '.db').split('_');
        let db;
        let timestamp = null;
        if (_file.length > 1 && !isNaN(Date.parse(_file[_file.length - 1]))) {
          db = _file.slice(0, -1).join('_');
          timestamp = _file[_file.length - 1];
        } else {
          db = _file.join('_');
        }
        if (!list[db]) {
          list[db] = {branches: []};
          resp.log.info(`database: ${db}`);
        }
        if (timestamp) {
          list[db].branches.push(timestamp);
          resp.log.info(`-> ${timestamp}`);
        }
      });
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }
    }

    return list;
  }

  hasCommitId(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db, commitId} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return !!this.stmts(db).hasCommitId.get({commitId});
  }

  getLastCommitId(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return this.stmts(db).lastCommitId.get();
  }

  getSomeCommitIds(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return this.stmts(db)
      .commitIdsList.raw(true)
      .all()
      .map(([commitId]) => commitId);
  }

  getPersistFromRange(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db, fromCommitId, toCommitId, toInclusive} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    if (!fromCommitId) {
      return this.stmts(db).lastPersistTo.all({toCommitId});
    }

    if (toInclusive) {
      return this.stmts(db).lastPersistFromRangeToInc.all({
        fromCommitId,
        toCommitId,
      });
    }

    return this.stmts(db).lastPersistFromRange.all({
      fromCommitId,
      toCommitId,
    });
  }

  getAllPersist(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    const stream = new ReadableSQL(this.stmts(db).lastPersist, Cryo.wait);
    return {xcraftStream: stream, routingKey: getRoutingKey()};
  }

  *bootstrapActions(resp, msg, next) {
    if (!this.tryToUse()) {
      return;
    }

    const {db, streamId, routingKey, rename} = msg.data;
    const dbPath = this._path(db);

    let stagedActions = [];
    if (rename) {
      stagedActions = this.stmts(db).allStagedActionsForBootstrap.all();

      this.close(db);
      xFs.fse.renameSync(dbPath, dbPath + '.old');
    }

    yield this._syncLock.lock(this._path(db));

    const dotdb = '.' + db;
    const dotdbPath = this._path(dotdb);
    this.close(db);
    xFs.fse.removeSync(dotdbPath);

    if (!this._open(dotdb, resp)) {
      return;
    }

    this.#boostrapping = true;
    try {
      const stream = new WritableSQL(
        this.stmts(dotdb).freeze,
        this.stmts(dotdb).begin,
        this.stmts(dotdb).commit,
        Cryo.wait,
        256
      );
      const streamer = new Streamer(streamId);
      yield streamer.receive(routingKey, stream, null, next);
      stream.destroy();

      try {
        this.stmts(dotdb).begin.run();
        for (const action of stagedActions) {
          this.stmts(dotdb).freeze.run(action);
        }
      } finally {
        this.stmts(dotdb).commit.run();
      }

      super.exec(
        dotdb,
        `PRAGMA analysis_limit=1000;
         ANALYZE;`
      );

      this.close(dotdb);
      xFs.fse.moveSync(dotdbPath, dbPath, {overwrite: true});
      this._open(db, resp);
    } catch (ex) {
      resp.log.warn(ex.stack || ex.message || ex);
      resp.log.dbg(`Remove the incomplete database: ${dotdbPath}`);
      this.close(dotdb);
      xFs.fse.removeSync(dotdbPath);
      throw ex;
    } finally {
      this.#boostrapping = false;
      this._syncLock.unlock(this._path(db));
    }
  }

  getZeroActions(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return this.stmts(db).zeroActions.all();
  }

  getActionsByIds(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db, goblinIds} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    const items = goblinIds.map(() => '?').join(',');
    const actionsStmt = `
      SELECT max(rowid) AS rowid, goblin, action, type, commitId
      FROM actions
      GROUP BY goblin
      HAVING goblin IN (${items})
         AND type = 'persist'
    `;
    const stmt = super.prepare(db, actionsStmt);
    return stmt.all(...goblinIds);
  }

  hasActions(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db, goblinIds} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    const goblinsMap = goblinIds.map(() => '?');
    const items = goblinsMap.join(',');
    const actionsStmt = `
      SELECT count(DISTINCT goblin) AS count
      FROM actions
      WHERE goblin IN (${items})
        AND type = 'persist'
    `;
    const stmt = super.prepare(db, actionsStmt);
    const result = stmt.get(...goblinIds);
    return result?.count === goblinsMap.length;
  }

  isAlreadyCreated(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db, goblin} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    /* Where there are persist actions */
    const persisted = this.stmts(db).hasPersist.get({goblin});
    if (persisted?.exist) {
      return true;
    }

    /* The first create is just the new goblin before the persist */
    const countCreate = this.stmts(db).countCreate.get({goblin});
    if (countCreate?.count && parseInt(countCreate.count)) {
      /* It's created if there are 2 create actions (more it's wrong) */
      return parseInt(countCreate.count) > 1;
    }

    return false;
  }

  getAllStagedActions(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return this.stmts(db).allStagedActions.all();
  }

  getDataForSync(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    // (1)
    const stagedActions = this.stmts(db).allStagedActions.all();
    // (2)
    const commitIds = this.stmts(db)
      .commitIdsList.raw(true)
      .all()
      .map(([commitId]) => commitId);

    return {stagedActions, commitIds};
  }

  async prepareDataForSync(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db, rows, zero} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    const items = rows.map(() => '?').join(',');
    const commitId = zero ? '00000000-0000-0000-0000-000000000000' : null;
    const commitActionsStmt = `
      UPDATE actions
      SET commitId = ?
      WHERE rowid IN (${items})
    `;
    const stmt = super.prepare(db, commitActionsStmt);
    await Cryo.wait(() => stmt.run(commitId, ...rows));
  }

  async updateActionsAfterSync(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db, serverCommitId, rows} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    const items = rows.map(() => '?').join(',');
    const commitActionsStmt = `
      UPDATE actions
      SET commitId = ?
      WHERE rowid IN (${items})
    `;
    const stmt = super.prepare(db, commitActionsStmt);
    await Cryo.wait(() => stmt.run(serverCommitId, ...rows));
  }

  hasGoblin(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    const {db, goblin} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return this.stmts(db).hasGoblin.get({goblin});
  }

  sweep(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    let dbs = msg.data?.dbs;
    if (!dbs || !dbs.length) {
      dbs = this.getAllNames();
    }

    const max = msg.data?.max ?? 10;
    const days = msg.data?.days ?? 30;

    const changes = {};

    for (const db of dbs) {
      if (!this._open(db, resp)) {
        continue;
      }

      try {
        changes[db] = this.#soulSweeper[db].sweepForDays(days, max, false);
      } catch (ex) {
        resp.log.warn(ex.stack || ex.message || ex);
      }
    }

    return changes;
  }

  sweepByMaxCount(resp, msg) {
    if (!this.tryToUse()) {
      return;
    }

    let {dbs, max} = msg.data;
    if (!dbs || !dbs.length) {
      dbs = this.getAllNames();
    }

    for (const db of dbs) {
      if (!this._open(db, resp)) {
        continue;
      }

      try {
        this.#soulSweeper[db].sweepByCount(max, false);
      } catch (ex) {
        resp.log.warn(ex.stack || ex.message || ex);
      }
    }
  }
}

module.exports = Cryo;
