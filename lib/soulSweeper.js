'use strict';

class SoulSweeper {
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

  constructor(sqlite) {
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

  #before() {
    this.#analyzeLimit.run();
    this.#analyze.run();
  }

  #after(changes) {
    if (changes > 100_000) {
      this.#vacuum.run();
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

    if (dryrun) {
      ({changes} = this.#sweepByCountDryrun.get({count}));
      return changes;
    }

    try {
      this.#before();
      ({changes} = this.#sweepByCount.run({count}));
      return changes;
    } finally {
      this.#after(changes);
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

    if (dryrun) {
      ({changes} = this.#sweepByDatetimeDryrun.get({datetime}));
      return changes;
    }

    try {
      this.#before();
      ({changes} = this.#sweepByDatetime.run({datetime}));
      return changes;
    } finally {
      this.#after(changes);
    }
  }
}

module.exports = SoulSweeper;
