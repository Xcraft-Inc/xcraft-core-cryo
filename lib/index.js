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
  }

  _onError(resp) {
    resp.log.info('sqlite3 is not supported on this platform');
  }

  _create(dbName) {
    if (!this._open(dbName)) {
      return false;
    }

    this._stmts[dbName].create.run();
    return true;
  }

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

    this._db[dbName] = new this.Database(dbPath);
    this._stmts[dbName] = {};
    this._stmts[dbName].create = this._db[dbName].prepare(
      `CREATE TABLE IF NOT EXISTS actions (timestamp TEXT, goblin TEXT, action JSON)`
    );
    this._stmts[dbName].freeze = this._db[dbName].prepare(
      `INSERT INTO actions VALUES ($timestamp, $goblin, $action)`
    );
    this._stmts[dbName].select = this._db[dbName].prepare(
      `SELECT * FROM actions`
    );

    return true;
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

  freeze(resp, msg) {
    if (!this.usable()) {
      this._onError(resp);
      return;
    }

    const {db, action, rules} = msg.data;
    if (!this._create(db)) {
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

  thaw(resp, msg) {
    if (!this.usable()) {
      this._onError(resp);
      return;
    }

    const {db} = msg.data;
    if (!this._open(db)) {
      this._onError(resp);
      return;
    }

    for (const row of this._stmts[db].select.iterate()) {
      resp.events.send(`cryo.thawed.${db}`, row);
    }
  }

  usable() {
    return !!this.Database;
  }
}

module.exports = new Cryo();
