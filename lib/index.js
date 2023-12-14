'use strict';

const path = require('path');
const fs = require('fs');
const watt = require('gigawatts');
const fasterStringify = require('faster-stable-stringify');
const xFs = require('xcraft-core-fs');
const {SQLite} = require('xcraft-core-book');
const {locks} = require('xcraft-core-utils');

const versionPragma = 8;

class Cryo extends SQLite {
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
    this._inTransaction = {};
    this._triggerNotifs = {};

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

      CREATE TABLE IF NOT EXISTS blobs (
        id        TEXT PRIMARY KEY,
        blob      BLOB,
        meta      JSON
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
      this._tables += `
        CREATE TABLE IF NOT EXISTS lastPersistedActions (
          goblin TEXT PRIMARY KEY,
          action JSON,
          timestamp TEXT
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS fts_idx USING fts5(data, content='lastPersistedActions', content_rowid='rowid');

        CREATE TRIGGER IF NOT EXISTS actions_ai AFTER INSERT ON actions
        WHEN
          new.type = 'persist' AND (
               JSON_EXTRACT(new.action, '$.payload.state.meta.status') != 'trashed'
            OR JSON_EXTRACT(new.action, '$.payload.state.meta.status') IS NULL
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
          JSON_EXTRACT(new.action,'$.payload.state.meta.status') = 'trashed'
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
          INSERT INTO fts_idx(rowid, data) VALUES (NEW.rowid, JSON_EXTRACT(NEW.action,'$.payload.state.meta.index'));
        END;

        CREATE TRIGGER IF NOT EXISTS lastPersistedActions_ad AFTER DELETE ON lastPersistedActions BEGIN
          INSERT INTO fts_idx(fts_idx, rowid, data) VALUES('delete', OLD.rowid, JSON_EXTRACT(OLD.action,'$.payload.state.meta.index'));
        END;

        CREATE TRIGGER IF NOT EXISTS lastPersistedActions_au AFTER UPDATE ON lastPersistedActions BEGIN
          INSERT INTO fts_idx(fts_idx, rowid, data) VALUES('delete', OLD.rowid, JSON_EXTRACT(OLD.action,'$.payload.state.meta.index'));
          INSERT INTO fts_idx(rowid, data) VALUES (NEW.rowid, JSON_EXTRACT(NEW.action,'$.payload.state.meta.index'));
        END;
      `;
    }

    this._indices = `
      CREATE INDEX IF NOT EXISTS ripley
        ON actions (goblin, timestamp DESC);
      CREATE INDEX IF NOT EXISTS timestamp
        ON actions (timestamp);
      CREATE INDEX IF NOT EXISTS type
        ON actions (type);
      CREATE INDEX IF NOT EXISTS commitId
        ON actions (commitId);
    `;

    this._queries = {};

    ///////////////////// RIPLEY /////////////////////

    this._queries.freeze = `
      INSERT INTO actions (timestamp, goblin, action, version, type, commitId)
      VALUES ($timestamp, $goblin, $action, $version, $type, $commitId)
    `;

    this._queries.thaw = `
      SELECT *
      FROM actions
      WHERE timestamp <= $timestamp
      GROUP BY goblin
      HAVING max(timestamp)
    `;

    this._queries.storeBlob = `
      INSERT INTO blobs
      VALUES ($id, $blob, $meta)
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

    this._queries.allStagedActions = `
      SELECT rowid, action
      FROM actions
      WHERE commitId IS NULL
        AND type != 'persist'
    `;

    this._queries.lastCommitId = `
      SELECT commitId
      FROM actions
      WHERE commitId IS NOT NULL
      ORDER BY rowid DESC
      LIMIT 1
    `;

    this._queries.lastPersistFromRange = `
      SELECT max(rowid) AS rowid, goblin, action, type, commitId
      FROM actions
      GROUP BY goblin
      HAVING type = 'persist'
        AND rowid BETWEEN (
          SELECT rowid
          FROM actions
          WHERE commitId = $fromCommitId
          ORDER BY rowid ASC
          LIMIT 1
        ) AND (
          SELECT rowid
          FROM actions
          WHERE commitId = $toCommitId
          ORDER BY rowid DESC
          LIMIT 1
        )
        AND commitId != $fromCommitId
    `;

    this._queries.lastPersist = `
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
    `;

    this._queries.zeroActions = `
      SELECT rowid, goblin
      FROM actions
      WHERE type != 'persist'
        AND commitId = '00000000-0000-0000-0000-000000000000'
    `;

    ///////////////////// UTILS /////////////////////

    this._queries.attach = `ATTACH DATABASE $db AS dump`;
    this._queries.detach = `DETACH DATABASE dump`;
    this._queries.begin = `BEGIN TRANSACTION;`;
    this._queries.exclusive = `BEGIN EXCLUSIVE TRANSACTION;`;
    this._queries.immediate = `BEGIN IMMEDIATE TRANSACTION;`;
    this._queries.commit = `COMMIT TRANSACTION;`;

    watt.wrapAll(this);
  }

  _sendNotifs(resp, on, db, goblin) {
    const [actorType] = goblin.split('-', 1);
    const triggers = this._lastActionTriggers[actorType];
    if (triggers) {
      triggers[on].forEach((topic) => {
        if (this._inTransaction?.[db] === true) {
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
    let version;
    const res = super.open(
      dbName,
      this._tables,
      this._queries,
      /* onOpen */
      () => {
        super.exec(dbName, 'PRAGMA case_sensitive_like = true');
        super.exec(dbName, `PRAGMA journal_mode = ${this._journal}`);
        version = super.pragma(dbName, 'user_version');
        if (!version) {
          super.exec(dbName, `PRAGMA user_version = ${versionPragma};`);
        }

        if (this._cryoConfig?.enableFTS) {
          this.function(dbName, 'onInsertLastAction', (goblin) =>
            this._sendNotifs(resp, 'onInsert', dbName, goblin)
          );

          this.function(dbName, 'onUpdateLastAction', (goblin) =>
            this._sendNotifs(resp, 'onUpdate', dbName, goblin)
          );

          this.function(dbName, 'onDeleteLastAction', (goblin) =>
            this._sendNotifs(resp, 'onDelete', dbName, goblin)
          );
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
             DROP INDEX IF EXISTS uuid;
             ALTER TABLE actions DROP COLUMN hash;
             ALTER TABLE actions DROP COLUMN source;
             ALTER TABLE actions DROP COLUMN uuid;
             ALTER TABLE lastPersistedActions DROP COLUMN hash;
             ALTER TABLE lastPersistedActions DROP COLUMN uuid;
             PRAGMA user_version = ${versionPragma};`
          );
        }
        if (version < 8) {
          super.exec(
            dbName,
            `DROP TRIGGER IF EXISTS actions_ai2;
             PRAGMA user_version = ${versionPragma};`
          );
        }
      },
      this._indices
    );
    if (!res) {
      resp.log.warn('something wrong happens with SQLite');
    }
    return res;
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

  _wait(handler) {
    for (let wait = true; wait; ) {
      try {
        handler();
        wait = false;
      } catch (ex) {
        wait = ex.code === 'SQLITE_BUSY' || ex.code === 'SQLITE_LOCKED';
        if (!wait) {
          throw ex;
        }
      }
    }
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

  migrate(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }
  }

  sync(resp) {
    if (!this.tryToUse(resp)) {
      return;
    }
  }

  begin(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    this.stmts(db).begin.run();
  }

  async immediate(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    await this._syncLock.lock(this._path(db));
    try {
      this._wait(() => this.stmts(db).immediate.run());
      this._inTransaction[db] = true;
    } catch (ex) {
      await this._syncLock.unlock(this._path(db));
      throw ex;
    }
  }

  async exclusive(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    await this._syncLock.lock(this._path(db));
    try {
      this._wait(() => this.stmts(db).exclusive.run());
      this._inTransaction[db] = true;
    } catch (ex) {
      await this._syncLock.unlock(this._path(db));
      throw ex;
    }
  }

  commit(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;

    if (!this._open(db, resp)) {
      return;
    }

    this.stmts(db).commit.run();

    try {
      /* Send all pending events after commit (events coming from the triggers) */
      if (this._triggerNotifs[db]) {
        for (const {topic, goblin} of this._triggerNotifs[db]) {
          resp.events.send(topic, goblin);
        }
        this._inTransaction[db] = false;
        this._triggerNotifs[db].length = 0;
      }
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

  /**
   * Persist data in the store.
   *
   * @param {object} resp - Response object provided by busClient.
   * @param {object} msg - Original bus message.
   * @returns {object|undefined} the whole payload.
   */
  freeze(resp, msg) {
    if (!this.tryToUse(resp)) {
      return null;
    }

    const {db, action, rules, raw = false} = msg.data;
    if (!this._open(db, resp)) {
      return null;
    }

    if (rules.mode !== 'all') {
      resp.log.warn(
        `rules mode (${rules.mode}) different of "all" are not supported`
      );
      return null;
    }

    const {goblin} = rules;

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
      const _action = raw ? action.meta.action : fasterStringify(action);
      const payload = {
        timestamp: this.timestamp(),
        goblin,
        action: _action,
        version: this._version,
        type: action?.type,
        commitId,
      };

      this._wait(() => this.stmts(db).freeze.run(payload));

      // resp.events.send('cryo.updated');
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
   * Store blob file in the store.
   *
   * @param {object} resp - Response object provided by busClient.
   * @param {object} msg - Original bus message.
   * @returns {object|undefined} the whole payload.
   */
  storeBlob(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db, id, filePath, meta} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }
    const size = xFs.fse.statSync(filePath).size;
    if (size > this._cryoConfig?.maxBlobSize) {
      throw new Error(
        `Cryo unable to store this big boy: ${filePath} (${size})`
      );
    }
    const buffer = xFs.fse.readFileSync(filePath);
    try {
      const payload = {
        id,
        blob: buffer,
        meta: fasterStringify(meta),
      };
      this.stmts(db).storeBlob.run(payload);
      return payload;
    } catch (ex) {
      resp.log.err(
        `storeBlob has failed with ${id}: ${ex.stack || ex.message || ex}`
      );
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
    if (!this.tryToUse(resp)) {
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
    if (!this.tryToUse(resp)) {
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
    if (!this.tryToUse(resp)) {
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

    // resp.events.send('cryo.updated');
  }

  *branch(resp, msg, next) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;
    this.close(db);

    const src = this._path(db);
    const dst = this._path(this.getBranchedDbName(db));
    try {
      yield fs.rename(src, dst, next);
      // resp.events.send('cryo.updated');
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
    if (!this.tryToUse(resp)) {
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
    if (!this.tryToUse(resp)) {
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
    if (!this.tryToUse(resp)) {
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
    if (!this.tryToUse(resp)) {
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

  getLastCommitId(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return this.stmts(db).lastCommitId.get();
  }

  getPersistFromRange(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db, fromCommitId, toCommitId} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return fromCommitId
      ? this.stmts(db).lastPersistFromRange.all({fromCommitId, toCommitId})
      : this.stmts(db).lastPersist.all({toCommitId});
  }

  getZeroActions(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return this.stmts(db).zeroActions.all();
  }

  getActionsByIds(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db, goblinIds} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    const actionsStmt = `
      SELECT max(rowid) AS rowid, goblin, action, type, commitId
      FROM actions
      GROUP BY goblin
      HAVING goblin IN (${goblinIds.map((id) => `'${id}'`).join(',')})
         AND type = 'persist'
    `;
    const stmt = super.prepare(db, actionsStmt);
    return stmt.all();
  }

  countCreate(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db, goblin} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return this.stmts(db).countCreate.get({goblin});
  }

  ripleyCommit(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db, newCommitId, goblinIds} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    const commitActionsStmt = `
      UPDATE actions
      SET commitId = '${newCommitId}'
      FROM (
        SELECT rowid
        FROM actions
        GROUP BY goblin
        HAVING goblin IN (${goblinIds.map((id) => `'${id}'`).join(',')})
           AND type = 'persist'
      ) AS aggregate
      WHERE actions.rowid = aggregate.rowid
    `;
    this._wait(() => super.exec(db, commitActionsStmt));
  }

  getAllStagedActions(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    return this.stmts(db).allStagedActions.all();
  }

  getDataForSync(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    // (1)
    const stagedActions = this.stmts(db).allStagedActions.all();
    // (2)
    const lastCommitId = this.stmts(db).lastCommitId.get();

    return {stagedActions, lastCommitId: lastCommitId?.commitId};
  }

  prepareDataForSync(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db, rows, zero} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    const commitId = zero ? `'00000000-0000-0000-0000-000000000000'` : 'NULL';
    const commitActionsStmt = `
      UPDATE actions
      SET commitId = ${commitId}
      WHERE rowid IN (${rows.join(',')})
    `;
    super.exec(db, commitActionsStmt);
  }

  updateActionsAfterSync(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db, serverCommitId, rows} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    const commitActionsStmt = `
      UPDATE actions
      SET commitId = '${serverCommitId}'
      WHERE rowid IN (${rows.join(',')})
    `;
    super.exec(db, commitActionsStmt);
  }
}

module.exports = Cryo;
