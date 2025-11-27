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
