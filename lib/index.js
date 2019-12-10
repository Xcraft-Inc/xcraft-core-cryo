'use strict';

const path = require('path');
const fs = require('fs');
const watt = require('gigawatts');
const fasterStringify = require('faster-stable-stringify');
const xConfig = require('xcraft-core-etc')().load('xcraft');
const xFs = require('xcraft-core-fs');
const xHost = require('xcraft-core-host');
const {SQLite} = require('xcraft-core-utils');

const versionPragma = 1;

class Cryo extends SQLite {
  constructor() {
    const location = path.join(xConfig.xcraftRoot, 'var/cryo');

    super(location);

    /* A middleware takes one or more rows and returns zero or more rows.
     * The base middleware is just returning the row as it.
     */
    this._middleware = rows => rows;

    this._cryoDir = location;
    this._version = xHost.appVersion;

    this._tables = `
      CREATE TABLE IF NOT EXISTS actions (
        timestamp TEXT,
        goblin TEXT,
        action JSON,
        version TEXT
      );
      CREATE INDEX IF NOT EXISTS ripley
        ON actions (goblin, timestamp DESC);
      CREATE INDEX IF NOT EXISTS timestamp
        ON actions (timestamp);
    `;

    this._queries = {};

    this._queries.freeze = `
      INSERT INTO actions
      VALUES ($timestamp, $goblin, $action, $version)
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

    this._queries.attach = `ATTACH DATABASE $db AS dump`;
    this._queries.detach = `DETACH DATABASE dump`;

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
        super.exec('PRAGMA case_sensitive_like = true');
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
      }
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
   * @param {Object} row - The row which includes the action.
   * @return {function} a function called for each new rows.
   */
  _runMiddlewares(row) {
    const rows = this._middleware([row]);
    return callback => rows.forEach(row => callback(row));
  }

  /**
   * Add a new middleware which takes rows and returns zero or more rows.
   * The middleware can split a row in multiple rows or even skip the row.
   *
   * @param {function(rows)} newMiddleware - The new middleware function.
   */
  _addMiddleware(newMiddleware) {
    const _prevMiddleware = this._middleware;
    this._middleware = rows => _prevMiddleware(newMiddleware(rows));
  }

  loadMiddleware(resp, msg) {
    const {middlewarePath} = msg.data;
    if (require.cache[middlewarePath]) {
      return;
    }
    const newMiddleware = require(middlewarePath);
    this._addMiddleware(newMiddleware);
  }

  sync(resp) {
    if (!this.tryToUse(resp)) {
      return;
    }
  }

  /**
   * Persist data in the store.
   *
   * @param {Object} resp - Response object provided by busClient.
   * @param {Object} msg - Original bus message.
   */
  freeze(resp, msg) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const {db, action, rules} = msg.data;
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
      this.stmts(db).freeze.run({
        timestamp: this.timestamp(),
        goblin,
        action: fasterStringify(action),
        version: this._version,
      });
      resp.events.send('cryo.updated');
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
   * @param {Object} resp - Response object provided by busClient.
   * @param {Object} msg - Original bus message.
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
      this._runMiddlewares(row)(row => {
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
   * @param {Object} resp - Response object provided by busClient.
   * @param {Object} msg - Original bus message.
   * @return {Object} the number of frozen actions.
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
   * @param {Object} resp - Response object provided by busClient.
   * @param {Object} msg - Original bus message.
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

    resp.events.send('cryo.updated');
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
      resp.events.send('cryo.updated');
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
           goblin TEXT,
           action JSON,
           version TEXT
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
   * @return {Boolean} true if SQLite is available.
   */
  usable() {
    return super.usable();
  }

  /**
   * Extract a list of actions metadata according to a timestamp range.
   *
   * @param {Object} resp - Response object provided by busClient.
   * @param {Object} msg - Original bus message.
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

  getEntityTypeCount(resp, msg) {
    const {db} = msg.data;
    let rows = [];
    if (!db) {
      throw Error('dbName not set in query getEntityTypeCount !');
    }
    rows = this.stmts(db).getEntityTypeCount.all();
    return rows;
  }

  /**
   * Extract the list of all databases and branches.
   *
   * @param {Object} resp - Response object provided by busClient.
   * @return {Array} the list of databases and branches.
   */
  branches(resp) {
    if (!this.tryToUse(resp)) {
      return;
    }

    const list = {};

    try {
      xFs.ls(this._cryoDir, /\.db$/).forEach(file => {
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
}

module.exports = new Cryo();
