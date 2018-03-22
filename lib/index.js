'use strict';

const path = require('path');
const fasterStringify = require('faster-stable-stringify');
const xConfig = require('xcraft-core-etc')().load('xcraft');

class Cryo {
  constructor() {
    try {
      this.Database = require('better-sqlite3');
      this._dataPath = path.join(xConfig.xcraftRoot, 'var/cryo.db');
      this._stmts = {};
    } catch (ex) {
      this.Database = null;
    }
  }

  _onError(resp) {
    resp.log.info('sqlite3 is not supported on this platform');
  }

  create(resp, msg) {
    if (!this.usable()) {
      this._onError(resp);
      return;
    }

    if (this._db) {
      return;
    }

    this._db = new this.Database(this._dataPath);
    this._stmts.create = this._db
      .prepare(`CREATE TABLE IF NOT EXISTS actions (action JSON, rules JSON)`)
      .run();

    this._stmts.freeze = this._db.prepare(
      `INSERT INTO actions VALUES ($action, $rules)`
    );
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
    // TODO: use db for retrieving the SQLite database file
    this._stmts.freeze.run({
      action: fasterStringify(action),
      rules: fasterStringify(rules),
    });
  }

  thaw(resp, msg) {
    if (!this.usable()) {
      this._onError(resp);
      return;
    }
  }

  usable() {
    return !!this.Database;
  }
}

module.exports = new Cryo();
