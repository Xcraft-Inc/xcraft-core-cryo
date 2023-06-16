'use strict';

const path = require('path');
const fs = require('fs');
const watt = require('gigawatts');
const fasterStringify = require('faster-stable-stringify');
const xFs = require('xcraft-core-fs');
const {SQLite} = require('xcraft-core-book');
const {crypto} = require('xcraft-core-utils');

const versionPragma = 4;

class Cryo extends SQLite {
  constructor(journal = 'WAL', appVersion = null, location = null) {
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

    this._cryoDir = location;
    this._version = appVersion;
    this._journal = journal;

    this._tables = `
      CREATE TABLE IF NOT EXISTS actions (
        timestamp TEXT,
        goblin    TEXT,
        action    JSON,
        version   TEXT,
        hash      TEXT,
        type      TEXT,
        source    TEXT
      );
      CREATE TABLE IF NOT EXISTS hashes (
        type      TEXT PRIMARY KEY,
        remote    TEXT,
        local     TEXT
      );
    `;

    this._indices = `
      CREATE INDEX IF NOT EXISTS ripley
        ON actions (goblin, timestamp DESC);
      CREATE INDEX IF NOT EXISTS timestamp
        ON actions (timestamp);
      CREATE INDEX IF NOT EXISTS hash
        ON actions (hash);
      CREATE INDEX IF NOT EXISTS type
        ON actions (type);
      CREATE INDEX IF NOT EXISTS source
        ON actions (source);
    `;

    this._queries = {};

    ///////////////////// RIPLEY /////////////////////

    this._queries.freeze = `
      INSERT INTO actions
      VALUES ($timestamp, $goblin, $action, $version, $hash, $type, $source)
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

    ///////////////////// HASH /////////////////////

    this._queries.allHashesByType = `
      SELECT hash
      FROM actions
      WHERE TYPE = $type
      ORDER BY timestamp DESC
    `;

    this._queries.lastHashByType = `
      SELECT hash
      FROM actions
      WHERE type = $type
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    this._queries.lastTimestampByHash = `
      SELECT timestamp
      FROM actions
      WHERE hash = $hash
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    this._queries.countByHash = `
      SELECT count(hash) as count
      FROM actions
      WHERE hash = $hash
    `;

    this._queries.rowidByHash = `
      SELECT rowid
      FROM actions
      WHERE hash = $hash
    `;

    this._queries.afterRowidExceptOneType = `
      SELECT *
      FROM actions
      WHERE rowid > $rowid
        AND type != $type
    `;

    this._queries.allExceptOneType = `
      SELECT *
      FROM actions
      WHERE type != $type
    `;

    ///////////////////// UTILS /////////////////////

    this._queries.attach = `ATTACH DATABASE $db AS dump`;
    this._queries.detach = `DETACH DATABASE dump`;
    this._queries.begin = `BEGIN TRANSACTION;`;
    this._queries.commit = `COMMIT TRANSACTION;`;

    watt.wrapAll(this);
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
        if (version < 2) {
          super.exec(
            dbName,
            `ALTER TABLE actions ADD COLUMN hash TEXT;
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
        if (version < 4) {
          super.exec(
            dbName,
            `ALTER TABLE actions ADD COLUMN source TEXT;
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

  commit(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    this.stmts(db).commit.run();
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
      return;
    }

    const {db, action, rules, source = 'local'} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    if (rules.mode !== 'all') {
      resp.log.warn(
        `rules mode (${rules.mode}) different of "all" are not supported`
      );
      return;
    }

    const goblin = rules.db;

    try {
      const _action = fasterStringify(action);
      const payload = {
        timestamp: this.timestamp(),
        goblin,
        action: _action,
        version: this._version,
        hash: crypto.sha256(_action),
        type: action?.type,
        source,
      };
      this.stmts(db).freeze.run(payload);
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
      return;
    }

    const {db, timestamp, type, length, offset} = msg.data;
    if (!this._open(db, resp)) {
      return;
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
      return;
    }

    const {db, timestamp, type} = msg.data;
    if (!this._open(db, resp)) {
      return;
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
      return;
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
      return;
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

  getLastCommonHash(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db, hashes} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    for (const {hash} of Object.values(hashes)) {
      const {count} = this.stmts(db).countByHash.get({hash});
      if (count >= 1) {
        return {hash};
      }
    }
  }

  *actionsSync(resp, msg, next) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db, desktopId} = msg.data;
    if (!this._open(db, resp)) {
      return;
    }

    // FIXME: lock state updates if the last action is not a 'persist' known by the server

    const hashes = this.stmts(db).allHashesByType.all({
      type: 'persist',
    });
    const {data = {}} = yield resp.command.send(
      `cryo.getLastCommonHash`,
      {
        _xcraftRPC: true,
        db,
        hashes,
      },
      next
    );

    resp.log.dbg(`@@@ LAST COMMON HASH: ${data.hash}`);
    const {hash} = data;

    let rowid;
    if (hash) {
      ({rowid} = this.stmts(db).rowidByHash.get({hash}));
    }

    const list = rowid
      ? this.stmts(db).afterRowidExceptOneType.all({rowid, type: 'persist'})
      : this.stmts(db).allExceptOneType.all({rowid, type: 'persist'});

    resp.log.dbg(`@@@ ACTIONS: ${list.length}`);

    const actions = list.map((a) => a.action);
    yield resp.command.send('goblin.ripley', {actions, desktopId});
  }
}

module.exports = Cryo;
