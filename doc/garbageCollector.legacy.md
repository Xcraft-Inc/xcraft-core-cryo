# The Garbage Collector for Cryo store

Two strategies are implemented. The first one keeps only the X latest persist
(and intermediate) actions. The second strategy drop to old actions according to
a timestamp.

Note that the count query is a bit faster that the datetime query. If you want
to combine both strategies, it's better to begin with the count query (for
example with a count of 4), and to continue with the datetime query. In this
case, it will use less time because the datetime query will work on less
actions.

## Fast queries

These queries needs an optimized query plan. It's necessary to optimize the
database.

On close:

```sql
PRAGMA analysis_limit = 1000;
PRAGMA optimize;
```

Before the use of the GC:

```sql
PRAGMA analysis_limit = 1000;
ANALYZE;
```

## Keep only X latest actions

This query selects too old actions. You can change the parameter in order to
keep only the X latest actions based on the number of 'persist' actions that you
want. For example, if you want to keep all actions that are used for the last
six persist actions, you must set the LIMIT from 4 (see under) to 6.

The timestamp is not used here. This strategy is especially useful in order to
see what happens and to provide older values in the case where a user wants to
cancel a change. But it can be a bit problematic if you try to directly use old
'persist' actions because it's possible to have inconsistency between different
goblins at different time.

```sql
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
            VALUES (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                   (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                   (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                   (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                   (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                   (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                   (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                   (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                   (0), (0), (0), (0), (0), (0), (0), (0), (0), (0),
                   (0), (0), (0), (0), (0), (0), (0), (0), (0), (0) -- LIMIT X to 100 (max)
          )
          ORDER BY rowid DESC
          LIMIT 4 -- PARAMETER -- Use 100 to keep 100 latest persist actions, etc.
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
```

## Keep only the latest actions according to a datetime

This query selects too old actions. You can change the parameter in order to
keep only the latest actions according to a datetime. For example, if you want
to keep all actions that are used for the last week, you must set the datetime
to `now - one week`.

```sql
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
            AND timestamp < '2024-01-24T14:30:00' -- PARAMETER
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
```
