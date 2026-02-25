'use strict';

const {SQLite} = require('xcraft-core-book');
const SoulSweeper = require('../lib/soulSweeper.js');
const {expect} = require('chai');

const dbName = 'cms'; /* without .db */
const dbLocation = __dirname; /* just the directory */

/* To run these tests
 * 1. extract cms.db.lzma
 * 2. remove 'skip' on describe()
 */

describe.skip('xcraft.cryo.soulSweeper', function () {
  this.timeout(20000);

  it('sweepByCount', function () {
    const sqlite = new SQLite(dbLocation);
    sqlite.open(dbName, '', {});

    try {
      let changes = 0;
      const handle = sqlite.getHandle(dbName)();
      const soulSweeper = new SoulSweeper(handle, dbName);
      changes = soulSweeper.sweepByCount(1, true);
      expect(changes).to.be.equal(228127);
      changes = soulSweeper.sweepByCount(2, true);
      expect(changes).to.be.equal(54032);
      changes = soulSweeper.sweepByCount(3, true);
      expect(changes).to.be.equal(42817);
      changes = soulSweeper.sweepByCount(4, true);
      expect(changes).to.be.equal(34499);
      changes = soulSweeper.sweepByCount(10, true);
      expect(changes).to.be.equal(962);
      changes = soulSweeper.sweepByCount(20, true);
      expect(changes).to.be.equal(168);
      changes = soulSweeper.sweepByCount(30, true);
      expect(changes).to.be.equal(80);
      changes = soulSweeper.sweepByCount(60, true);
      expect(changes).to.be.equal(20);
    } finally {
      sqlite.close(dbName);
    }
  });

  it('sweepByDatetime', function () {
    const sqlite = new SQLite(dbLocation);
    sqlite.open(dbName, '', {});

    try {
      let changes = 0;
      const handle = sqlite.getHandle(dbName)();
      const soulSweeper = new SoulSweeper(handle, dbName);
      changes = soulSweeper.sweepByDatetime('2025-09-25', true);
      expect(changes).to.be.equal(2303);
      changes = soulSweeper.sweepByDatetime('2025-10-01', true);
      expect(changes).to.be.equal(13239);
      changes = soulSweeper.sweepByDatetime('2025-10-10', true);
      expect(changes).to.be.equal(27872);
      changes = soulSweeper.sweepByDatetime('2025-10-20', true);
      expect(changes).to.be.equal(39887);
      changes = soulSweeper.sweepByDatetime('2025-11-01', true);
      expect(changes).to.be.equal(59433);
    } finally {
      sqlite.close(dbName);
    }
  });

  it('likeSweepForDays', function () {
    const fse = require('fs-extra');
    const path = require('node:path');

    const _dbName = dbName + '.test';

    function before() {
      fse.copyFileSync(
        path.join(dbLocation, dbName + '.db'),
        path.join(dbLocation, _dbName + '.db')
      );
      const sqlite = new SQLite(dbLocation);
      sqlite.open(_dbName, '', {});
      return sqlite;
    }

    function after(sqlite) {
      sqlite.close(_dbName);
      fse.removeSync(path.join(dbLocation, _dbName + '.db'));
    }

    const datetimes = [
      ['2025-09-25', 10, 3265],
      ['2025-10-01', 7, 25328],
      ['2025-10-10', 4, 46753],
      ['2025-10-20', 3, 54584],
      ['2025-11-01', 9, 59433],
    ];

    for (const [datetime, max, _changes] of datetimes) {
      const sqlite = before();
      try {
        let changes = 0;
        const handle = sqlite.getHandle(_dbName)();
        const soulSweeper = new SoulSweeper(handle, _dbName);
        changes = soulSweeper.sweepByCount(max, false);
        changes += soulSweeper.sweepByDatetime(datetime, false);
        expect(changes).to.be.equal(_changes);
      } finally {
        after(sqlite);
      }
    }
  });
});

describe('xcraft.cryo.soulSweeper (unit)', function () {
  function createDB() {
    const sqlite = new SQLite(dbLocation);
    sqlite.open(
      ':memory:',
      `
        CREATE TABLE actions (
          rowid INTEGER PRIMARY KEY,
          goblin TEXT,
          type TEXT,
          commitId TEXT,
          timestamp TEXT
        )
      `,
      {
        insert: `
          INSERT INTO actions (goblin, type, commitId, timestamp)
          VALUES ($goblin, $type, $commitId, $timestamp)
       `,
      }
    );
    return sqlite.getHandle(':memory:')();
  }

  function insert(db, rows) {
    const stmt = db.prepare(
      `INSERT INTO actions (goblin, type, commitId, timestamp)
       VALUES ($goblin, $type, $commitId, $timestamp)`
    );
    for (const row of rows) {
      stmt.run(row);
    }
  }

  it('sweepByCount(2) keeps the 2 latest persists per goblin', function () {
    const db = createDB();
    insert(db, [
      {goblin: 'a', type: 'persist', commitId: 'c1', timestamp: '2025-01-01'},
      {goblin: 'a', type: 'create', commitId: 'c2', timestamp: '2025-01-02'},
      {goblin: 'a', type: 'persist', commitId: 'c3', timestamp: '2025-01-03'},
      {goblin: 'a', type: 'persist', commitId: 'c4', timestamp: '2025-01-04'},
      {goblin: 'a', type: 'persist', commitId: 'c5', timestamp: '2025-01-05'},
      {goblin: 'b', type: 'persist', commitId: 'c6', timestamp: '2025-01-01'},
      {goblin: 'b', type: 'persist', commitId: 'c7', timestamp: '2025-01-02'},
    ]);

    const sweeper = new SoulSweeper(db, 'test');
    sweeper.sweepByCount(2, false);

    const remaining = db
      .prepare(
        `SELECT goblin, COUNT(*) as cnt FROM actions
         WHERE type = 'persist' AND commitId IS NOT NULL
         GROUP BY goblin`
      )
      .all();

    for (const {goblin, cnt} of remaining) {
      expect(cnt, `goblin ${goblin} should have at most 2 persists`).to.be.lte(
        2
      );
    }

    /* Goblin 'a' had 4 persists → must have exactly 2 */
    const a = remaining.find((r) => r.goblin === 'a');
    expect(a.cnt).to.equal(2);

    /* Goblin 'b' had 2 persists → keep all */
    const b = remaining.find((r) => r.goblin === 'b');
    expect(b.cnt).to.equal(2);
  });

  it('sweepByCount keeps intermediate actions between retained persists', function () {
    const db = createDB();
    // persist1 → update → update → persist2 (keep) → update (keep) → persist3 (keep)
    insert(db, [
      {goblin: 'a', type: 'persist', commitId: 'c1', timestamp: '2025-01-01'},
      {goblin: 'a', type: 'update', commitId: null, timestamp: '2025-01-02'},
      {goblin: 'a', type: 'update', commitId: null, timestamp: '2025-01-02'},
      {goblin: 'a', type: 'persist', commitId: 'c3', timestamp: '2025-01-03'},
      {goblin: 'a', type: 'update', commitId: null, timestamp: '2025-01-04'},
      {goblin: 'a', type: 'persist', commitId: 'c5', timestamp: '2025-01-05'},
    ]);

    const sweeper = new SoulSweeper(db, 'test');
    sweeper.sweepByCount(2, false);

    const remaining = db
      .prepare(`SELECT type FROM actions ORDER BY rowid`)
      .all();
    /* persist1 and its intermediate updates are removed
     * persist3, update between 2 and 3, persist5 stay here
     */
    const types = remaining.map((r) => r.type);
    expect(types).to.deep.equal(['persist', 'update', 'persist']);
  });

  it('withCommits=false sweeps uncommitted persists too', function () {
    const db = createDB();
    insert(db, [
      {goblin: 'a', type: 'persist', commitId: null, timestamp: '2025-01-01'},
      {goblin: 'a', type: 'persist', commitId: null, timestamp: '2025-01-02'},
      {goblin: 'a', type: 'persist', commitId: 'c3', timestamp: '2025-01-03'},
    ]);

    const sweeperWith = new SoulSweeper(db, 'test', true);
    const sweeperWithout = new SoulSweeper(db, 'test', false);

    /* With withCommits=true: only c3 is "persist+commitId", nothing to sweep for count=2 */
    expect(sweeperWith.sweepByCount(2, true)).to.equal(0);
    /* Without: 3 persists are visible, 1 sweepable for count=2 */
    expect(sweeperWithout.sweepByCount(2, true)).to.equal(1);
  });

  it('sweepByCount throws for count < 1 or > 100', function () {
    const db = createDB();
    const sweeper = new SoulSweeper(db, 'test');
    expect(() => sweeper.sweepByCount(0)).to.throw();
    expect(() => sweeper.sweepByCount(101)).to.throw();
    expect(() => sweeper.sweepByCount(1)).not.to.throw();
    expect(() => sweeper.sweepByCount(100)).not.to.throw();
  });

  it('sweepByCount on empty DB returns 0', function () {
    const db = createDB();
    const sweeper = new SoulSweeper(db, 'test');
    expect(sweeper.sweepByCount(4, false)).to.equal(0);
  });

  it('sweepByCount when goblin has fewer persists than count keeps all', function () {
    const db = createDB();
    insert(db, [
      {goblin: 'a', type: 'persist', commitId: 'c1', timestamp: '2025-01-01'},
    ]);
    const sweeper = new SoulSweeper(db, 'test');
    expect(sweeper.sweepByCount(4, false)).to.equal(0);
    expect(db.prepare(`SELECT COUNT(*) as n FROM actions`).get().n).to.equal(1);
  });
});
