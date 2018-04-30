'use strict';

const path = require('path');
const fs = require('fs');
const watt = require('watt');
const fasterStringify = require('faster-stable-stringify');
const xConfig = require('xcraft-core-etc')().load('xcraft');
const xFs = require('xcraft-core-fs');

class Cryo {
  constructor() {
    try {
      this.Database = require('better-sqlite3');
      this._stmts = {};
      this._db = {};
    } catch (ex) {
      this.Database = null;
    }

    /* A middleware takes one or more rows and returns zero or more rows.
     * The base middleware is just returning the row as it.
     */
    this._middleware = rows => rows;

    this._cryoDir = path.join(xConfig.xcraftRoot, 'var/cryo');

    watt.wrapAll(this);
  }

  _onError(resp) {
    resp.log.info('sqlite3 is not supported on this platform');
  }

  static _path(dbName) {
    return path.join(xConfig.xcraftRoot, 'var/cryo', `${dbName}.db`);
  }

  /**
   * Open (and create if necessary) a SQLite database.
   *
   * @param {string} dbName - Database name used for the database file.
   * @return {Boolean} false if SQLite is not available.
   */
  _open(dbName) {
    if (!this.usable()) {
      return false;
    }

    if (this._db[dbName]) {
      return true;
    }

    xFs.mkdir(this._cryoDir);

    const dbPath = Cryo._path(dbName);

    this._queries = {};
    this._queries.freeze = `INSERT INTO actions VALUES ($timestamp, $goblin, $action)`;
    this._queries.thaw = `SELECT * FROM actions WHERE timestamp <= $timestamp GROUP BY goblin HAVING max(timestamp)`;
    this._queries.frozen = `SELECT count(*) AS count, timestamp FROM (${
      this._queries.thaw
    } ORDER BY timestamp)`;
    this._queries.actions = `SELECT timestamp, goblin FROM actions WHERE timestamp BETWEEN $from AND $to ORDER BY timestamp`;
    this._queries.trim = `DELETE FROM actions WHERE timestamp > $timestamp`;

    this._db[dbName] = new this.Database(dbPath);
    this._stmts[dbName] = {};

    this._db[dbName].exec(
      `CREATE TABLE IF NOT EXISTS actions (timestamp TEXT, goblin TEXT, action JSON);
       CREATE INDEX IF NOT EXISTS ripley ON actions (goblin, timestamp DESC);
       CREATE INDEX IF NOT EXISTS timestamp ON actions (timestamp);`
    );

    for (const query in this._queries) {
      this._prepare(dbName, query);
    }

    return true;
  }

  _prepare(dbName, query) {
    this._stmts[dbName][query] = this._db[dbName].prepare(this._queries[query]);
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

  timestamp() {
    return new Date().toISOString();
  }

  close(dbName) {
    if (!this._db[dbName]) {
      return;
    }
    this._db[dbName].close();
    delete this._db[dbName];
  }

  sync(resp) {
    if (!this.usable()) {
      this._onError(resp);
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
    if (!this.usable()) {
      this._onError(resp);
      return;
    }

    const {db, action, rules} = msg.data;
    if (!this._open(db)) {
      this._onError(resp);
      return;
    }

    if (rules.mode !== 'all') {
      resp.log.warn(
        `rules mode (${rules.mode}) different of "all" are not suppored`
      );
      return;
    }

    this._stmts[db].freeze.run({
      timestamp: this.timestamp(),
      goblin: rules.db,
      action: fasterStringify(action),
    });

    resp.events.send('cryo.updated');
  }

  /**
   * Retrieve actions from the store.
   *
   * @param {Object} resp - Response object provided by busClient.
   * @param {Object} msg - Original bus message.
   */
  thaw(resp, msg) {
    if (!this.usable()) {
      this._onError(resp);
      return;
    }

    const {db, timestamp} = msg.data;
    if (!this._open(db)) {
      this._onError(resp);
      return;
    }

    for (const row of this._stmts[db].thaw.iterate({timestamp})) {
      this._runMiddlewares(row)(row =>
        resp.events.send(`cryo.thawed.${db}`, row)
      );
    }
  }

  /**
   * Get statistics on actions.
   *
   * @param {Object} resp - Response object provided by busClient.
   * @param {Object} msg - Original bus message.
   * @return {Object} the number of frozen actions.
   */
  frozen(resp, msg) {
    if (!this.usable()) {
      this._onError(resp);
      return;
    }

    const {db, timestamp} = msg.data;
    if (!this._open(db)) {
      this._onError(resp);
      return;
    }

    return this._stmts[db].frozen.get({
      timestamp,
    });
  }

  /**
   * Restore an action store to a particular timestamp.
   *
   * @param {Object} resp - Response object provided by busClient.
   * @param {Object} msg - Original bus message.
   * @param {function} next - Watt's callback.
   */
  *restore(resp, msg, next) {
    if (!this.usable()) {
      this._onError(resp);
      return;
    }

    const {dbSrc, dbDst, timestamp} = msg.data;
    this.close(dbDst);

    const src = Cryo._path(dbSrc);
    const dst = Cryo._path(dbDst);
    try {
      yield fs.unlink(dst, next);
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }
    }
    yield fs.copyFile(src, dst, next);

    if (!this._open(dbDst)) {
      this._onError(resp);
      return;
    }

    this._stmts[dbDst].trim.run({
      timestamp,
    });
  }

  *branch(resp, msg, next) {
    if (!this.usable()) {
      this._onError(resp);
      return;
    }

    const {db} = msg.data;
    this.close(db);

    const src = Cryo._path(db);
    const dst = Cryo._path(`${db}_${this.timestamp()}`);
    try {
      yield fs.rename(src, dst, next);
      resp.events.send('cryo.updated');
    } catch (ex) {
      if (ex.code !== 'ENOENT') {
        throw ex;
      }
    }
  }

  /**
   * Check if Cryo is usable.
   *
   * @return {Boolean} true if SQLite is available.
   */
  usable() {
    return !!this.Database;
  }

  /**
   * Extract a list of actions metadata according to a timestamp range.
   *
   * @param {Object} resp - Response object provided by busClient.
   * @param {Object} msg - Original bus message.
   */
  actions(resp, msg) {
    if (!this.usable()) {
      this._onError(resp);
      return;
    }

    const {db, from, to} = msg.data;
    if (!this._open(db)) {
      this._onError(resp);
      return;
    }

    for (const row of this._stmts[db].actions.iterate({from, to})) {
      resp.events.send(`cryo.actions.${db}`, row);
    }
  }

  /**
   * Extract the list of all databases and branches.
   *
   * @param {Object} resp - Response object provided by busClient.
   * @return {Array} the list of databases and branches.
   */
  branches(resp) {
    if (!this.usable()) {
      this._onError(resp);
      return;
    }

    const list = {};

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

    return list;
  }
}

module.exports = new Cryo();
