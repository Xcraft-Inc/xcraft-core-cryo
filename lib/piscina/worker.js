'use strict';

const {workerData} = require('piscina');
const {SQLite} = require('xcraft-core-book');
// const SoulSweeper = require('../soulSweeper.js');

const {dbName} = workerData;

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SQLiteWorker extends SQLite {
  constructor(location) {
    super(location);

    this._queries = {};
    this._queries.freeze = `
      INSERT INTO actions (timestamp, goblin, action, version, type, commitId)
      VALUES ($timestamp, $goblin, $action, $version, $type, $commitId)
    `;
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

  _open(d) {
    super.open(dbName, '', this._queries, () => {
      this.function(dbName, 'onInsertLastAction', (goblin) => null);
      this.function(dbName, 'onUpdateLastAction', (goblin) => null);
      this.function(dbName, 'onDeleteLastAction', (goblin) => null);
    });
  }

  async freeze(payload) {
    if (!this._open()) {
      return null;
    }

    await SQLiteWorker.wait(() => this.stmts(dbName).freeze.run(payload));
  }
}

const worker = new SQLiteWorker(workerData.location);
// const soulSweeper = new SoulSweeper(this._db[dbName], dbName, this._useSync);

async function freeze({payload}) {
  await worker.freeze(payload);
}

module.exports = {
  freeze,
};
