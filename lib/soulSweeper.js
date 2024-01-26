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
    -- Select all actions to delete
    SELECT rowid
    FROM actions
    LEFT JOIN (
      -- Select only the latest actions to collect
      SELECT max(rowid) AS max, goblinId
      FROM (
        -- Select all persist actions to collect
        SELECT rowid, goblin AS goblinId
        FROM actions
        WHERE rowid BETWEEN (
            -- Select the first action to remove
            SELECT rowid
            FROM actions
            WHERE goblin = goblinId
              AND type = 'persist'
              AND commitId IS NOT NULL
            ORDER BY rowid ASC
            LIMIT 1
          ) AND (
            -- Select the X'th older action to remove (we keep at least the latest actions)
            SELECT rowid
            FROM (
              SELECT rowid
              FROM actions
              WHERE goblin = goblinId
                AND type = 'persist'
                AND commitId IS NOT NULL
                AND timestamp < $datetime -- PARAMETER
              UNION ALL
              SELECT NULL as rowid
              ORDER BY rowid DESC
              LIMIT 2
            )
            ORDER BY rowid ASC
            LIMIT 1
          )
          AND type = 'persist'
          AND commitId IS NOT NULL
        ORDER BY goblin, rowid ASC
      )
      GROUP BY goblinId
    ) AS removeList
    WHERE actions.goblin = removeList.goblinId
      AND actions.rowid <= removeList.max -- Here max is in the collectable list
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
    -- Select all actions to delete
    SELECT rowid
    FROM actions
    LEFT JOIN (
      -- Select only the latest actions to collect
      SELECT max(rowid) AS max, goblinId
      FROM (
        -- Select all persist actions to collect
        SELECT rowid, goblin AS goblinId
        FROM actions
        WHERE rowid BETWEEN (
            -- Select the first action to remove
            SELECT rowid
            FROM actions
            WHERE goblin = goblinId
              AND type = 'persist'
              AND commitId IS NOT NULL
            ORDER BY rowid ASC
            LIMIT 1
          ) AND (
            -- Select the X'th older action to keep (we keep at least X actions)
            SELECT rowid
            FROM (
              SELECT rowid
              FROM actions
              WHERE goblin = goblinId
                AND type = 'persist'
                AND commitId IS NOT NULL
              UNION ALL
              SELECT NULL as rowid
              FROM (
                VALUES (0), (0), (0), (0), (0), (0), (0), (0), (0), (0) -- LIMIT X to 10 (max)
              )
              ORDER BY rowid DESC
              LIMIT $count -- PARAMETER -- Use 10 to keep 10 latest persist actions, etc.
            )
            ORDER BY rowid ASC
            LIMIT 1
          )
          AND type = 'persist'
          AND commitId IS NOT NULL
        ORDER BY goblin, rowid ASC
      )
      GROUP BY goblinId
    ) AS removeList
    WHERE actions.goblin = removeList.goblinId
      AND actions.rowid < removeList.max -- Here max is not in the collectable list
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

  constructor(sqlite, name) {
    this.#name = name;
    this.#sqlite = sqlite;

    this.#analyzeLimit = this.#sqlite.prepare(this.#analyzeLimitSQL);
    this.#analyze = this.#sqlite.prepare(this.#analyzeSQL);
    this.#vacuum = this.#sqlite.prepare(this.#vacuumSQL);

    this.#sweepByCount = this.#sqlite.prepare(this.#sweepByCountSQL);
    this.#sweepByCountDryrun = this.#sqlite.prepare(
      this.#sweepByCountDryrunSQL
    );

    this.#sweepByDatetime = this.#sqlite.prepare(this.#sweepByDatetimeSQL);
    this.#sweepByDatetimeDryrun = this.#sqlite.prepare(
      this.#sweepByDatetimeDryrunSQL
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
   * @param {number} [count] between >=1 and <=10 (default 4)
   * @param {boolean} [dryrun] if true, reports and nothing is deleted
   * @returns {number} the number of deleted rows
   */
  sweepByCount(count = 4, dryrun = true) {
    if (count > 10 || count < 1) {
      throw new Error(`'count' must be between 1 and 10`);
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
   * It keeps 10 persists and all intermediate persists for N days
   * and only one persist if older.
   *
   * @param {number} days number of days to keep 10 persists
   * @param {boolean} dryrun if true, reports and nothing is deleted
   */
  sweepForDays(days = 30, dryrun = true) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    const datetime = date.toISOString();

    /* Keep 10 persists by goblin */
    this.sweepByCount(10, dryrun);
    /* Keep 1 persist when older than 1 month */
    this.sweepByDatetime(datetime, dryrun);
  }
}

module.exports = SoulSweeper;
