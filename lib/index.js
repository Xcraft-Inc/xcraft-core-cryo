'use strict';

const path = require('path');
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
  }

  _onError(resp) {
    resp.log.info('sqlite3 is not supported on this platform');
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

    const dir = path.join(xConfig.xcraftRoot, 'var/cryo');
    xFs.mkdir(dir);
    const dbPath = path.join(dir, `${dbName}.db`);

    const queries = {
      freeze: `INSERT INTO actions VALUES ($timestamp, $goblin, $action)`,
      thaw: `SELECT * FROM actions WHERE timestamp <= $timestamp GROUP BY goblin HAVING max(timestamp)`,
      frozen: `SELECT count(*) AS count FROM (SELECT * FROM actions WHERE timestamp <= $timestamp GROUP BY goblin HAVING max(timestamp))`,
    };

    this._db[dbName] = new this.Database(dbPath);
    this._stmts[dbName] = {};

    this._db[dbName].exec(
      `CREATE TABLE IF NOT EXISTS actions (timestamp TEXT, goblin TEXT, action JSON);
       CREATE INDEX IF NOT EXISTS ripley ON actions (goblin, timestamp DESC);`
    );

    for (const query in queries) {
      this._stmts[dbName][query] = this._db[dbName].prepare(queries[query]);
    }

    return true;
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

  close(resp, msg) {
    this._db.close();
  }

  sync(resp, msg) {
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
      timestamp: msg.timestamp,
      goblin: rules.db,
      action: fasterStringify(action),
    });
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
   * Check if Cryo is usable.
   *
   * @return {Boolean} true if SQLite is available.
   */
  usable() {
    return !!this.Database;
  }
}

module.exports = new Cryo();
