'use strict';

const {hrtime} = require('node:process');
const xLog = require('xcraft-core-log')('sweeper');

class SoulSweeper {
  #name;
  #sqlite;

  #analyzeLimit;
  #analyzeLimitSQL = `
    PRAGMA analysis_limit = 1000;
  `;
  #analyze;
  #analyzeSQL = `
    ANALYZE;
  `;

  #vacuum;
  #vacuumSQL = `
    VACUUM;
  `;

  #sweepByDatetime;
  #sweepByDatetimeDryrun;
  #sweepByDatetimeBaseSQL = `
    WITH ranked AS (
      SELECT rowid, goblin,
             ROW_NUMBER() OVER (
               PARTITION BY goblin ORDER BY rowid DESC
             ) AS row_number
      FROM actions
      WHERE type = 'persist'
        AND commitId IS NOT NULL
        AND timestamp < $datetime -- PARAMETER
    ),
    thresholds AS (
      SELECT goblin, MAX(rowid) AS max_rowid
      FROM (
        SELECT goblin, rowid
        FROM ranked
        WHERE row_number = 2  -- Keep 2 latest persist actions
      )
      GROUP BY goblin
    )
    SELECT actions.rowid
    FROM actions
    INNER JOIN thresholds ON actions.goblin = thresholds.goblin
    WHERE actions.rowid <= thresholds.max_rowid
  `;
  #sweepByDatetimeSQL = `
    DELETE FROM actions
    WHERE rowid IN (
      ${this.#sweepByDatetimeBaseSQL}
    )
  `;
  #sweepByDatetimeDryrunSQL = `
    SELECT count(*) AS changes
    FROM (
      ${this.#sweepByDatetimeBaseSQL}
    )
  `;

  #sweepByCount;
  #sweepByCountDryrun;
  #sweepByCountBaseSQL = `
    WITH ranked AS (
      SELECT rowid, goblin,
             ROW_NUMBER() OVER (
               PARTITION BY goblin ORDER BY rowid DESC
             ) AS row_number
      FROM actions
      WHERE type = 'persist'
        AND commitId IS NOT NULL
    ),
    thresholds AS (
      SELECT goblin, rowid
      FROM ranked
      WHERE row_number = $count  -- Keep X latest
    )
    SELECT actions.rowid
    FROM actions
    INNER JOIN thresholds ON actions.goblin = thresholds.goblin
    WHERE actions.rowid < thresholds.rowid
  `;
  #sweepByCountSQL = `
    DELETE FROM actions
    WHERE rowid IN (
      ${this.#sweepByCountBaseSQL}
    )
  `;
  #sweepByCountDryrunSQL = `
    SELECT count(*) AS changes
    FROM (
      ${this.#sweepByCountBaseSQL}
    )
  `;

  constructor(sqlite, name, withCommits = true) {
    this.#name = name;
    this.#sqlite = sqlite;

    this.#analyzeLimit = this.#sqlite.prepare(this.#analyzeLimitSQL);
    this.#analyze = this.#sqlite.prepare(this.#analyzeSQL);
    this.#vacuum = this.#sqlite.prepare(this.#vacuumSQL);

    const patch = (query) =>
      withCommits ? query : query.replaceAll('AND commitId IS NOT NULL', '');

    this.#sweepByCount = this.#sqlite.prepare(
      patch(this.#sweepByCountSQL) //
    );
    this.#sweepByCountDryrun = this.#sqlite.prepare(
      patch(this.#sweepByCountDryrunSQL)
    );

    this.#sweepByDatetime = this.#sqlite.prepare(
      patch(this.#sweepByDatetimeSQL)
    );
    this.#sweepByDatetimeDryrun = this.#sqlite.prepare(
      patch(this.#sweepByDatetimeDryrunSQL)
    );
  }

  #time(time) {
    return Number(hrtime.bigint() / 1_000_000n - time / 1_000_000n) / 1000;
  }

  #log(dryrun, ...args) {
    xLog.dbg(`[${this.#name}${dryrun ? ':dryrun' : ''}]`, ...args);
  }

  #before(dryrun) {
    if (dryrun) {
      return;
    }

    this.#analyzeLimit.run();
    this.#analyze.run();
  }

  #after(dryrun, changes) {
    if (dryrun || changes < 100_000) {
      return;
    }

    const time = hrtime.bigint();
    try {
      this.#log(false, `begin VACUUM after ${changes} changes`);
      this.#vacuum.run();
    } finally {
      this.#log(false, `end VACUUM after ${this.#time(time)}s`);
    }
  }

  /**
   * Run the sweeper to keep 'count' persist actions (slow)
   *
   * It keeps all intermediate actions between the persist actions.
   * All other actions are deleted and the database is shrinked.
   *
   * @param {number} [count] between >=1 and <=100 (default 4)
   * @param {boolean} [dryrun] if true, reports and nothing is deleted
   * @returns {number} the number of deleted rows
   */
  sweepByCount(count = 4, dryrun = true) {
    if (count > 100 || count < 1) {
      throw new Error(`'count' must be between 1 and 100`);
    }

    let changes;

    this.#log(dryrun, `begin sweepByCount count=${count}`);

    const time = hrtime.bigint();
    try {
      this.#before(dryrun);

      if (dryrun) {
        ({changes} = this.#sweepByCountDryrun.get({count}));
        this.#log(
          dryrun,
          `→ ${changes} can be sweeped out in order to keep ${count} persists by id`
        );
        return changes;
      }

      ({changes} = this.#sweepByCount.run({count}));
      this.#log(dryrun, `→ ${changes} are sweeped out`);
      return changes;
    } finally {
      this.#log(dryrun, `end sweepByCount after ${this.#time(time)}s`);
      this.#after(dryrun, changes);
    }
  }

  /**
   * Run the sweeper to keep persist actions from 'datetime' (slow)
   *
   * It keeps all intermediate actions between the persist actions.
   * All other actions are deleted and the database is shrinked.
   *
   * @param {number} [datetime] Date ISO String (default now)
   * @param {boolean} [dryrun] if true, reports and nothing is deleted
   * @returns {number} the number of deleted rows
   */
  sweepByDatetime(datetime = this.#sqlite.timestamp(), dryrun = true) {
    let changes;

    this.#log(dryrun, `begin sweepByDatetime datetime=${datetime}`);

    const time = hrtime.bigint();
    try {
      this.#before(dryrun);

      if (dryrun) {
        ({changes} = this.#sweepByDatetimeDryrun.get({datetime}));
        this.#log(dryrun, `→ ${changes} can be sweeped out`);
        return changes;
      }

      ({changes} = this.#sweepByDatetime.run({datetime}));
      this.#log(dryrun, `→ ${changes} are sweeped out`);
      return changes;
    } finally {
      this.#log(dryrun, `end sweepByDatetime after ${this.#time(time)}s`);
      this.#after(dryrun, changes);
    }
  }

  /**
   * Run the sweeper for N days strategy
   *
   * It keeps MAX persists and all intermediate persists for N days
   * and only one persist if older.
   *
   * @param {number} [days] number of days
   * @param {number} [max] max persists
   * @param {boolean} [dryrun] if true, reports and nothing is deleted
   * @returns {number} number of sweeped actions
   */
  sweepForDays(days = 30, max = 10, dryrun = true) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    const datetime = date.toISOString();

    let changes = 0;
    /* Keep max persists by goblin */
    changes += this.sweepByCount(max, dryrun);
    /* Keep 1 persist when older than 1 month */
    changes += this.sweepByDatetime(datetime, dryrun);
    return changes;
  }
}

module.exports = SoulSweeper;
