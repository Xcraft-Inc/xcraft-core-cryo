# The Garbage Collector for Cryo store

Two strategies will be implemented. The firts one keeps only the X latest
persist (and intermediate) actions. The second strategy will you the timestamp
(not implemented).

## Keep only the latest actions

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
SELECT rowid, goblin, type
FROM actions
LEFT JOIN (
  -- Select only the latest actions to collect
  SELECT max(rowid) AS max, goblinId
  FROM (
    -- Select all persist actions to collect
    SELECT rowid, goblin AS goblinId
    FROM actions
    WHERE type = 'persist'
      AND commitId IS NOT NULL
      AND rowid BETWEEN (
        -- Select the first action to remove
        SELECT rowid
        FROM actions
        WHERE type = 'persist'
          AND goblin = goblinId
          AND commitId IS NOT NULL
        ORDER BY rowid ASC
        LIMIT 1
      ) AND (
        -- Select the X'th older action to remove (we keep at least X actions)
        SELECT rowid
        FROM (
          SELECT rowid
          FROM actions
          WHERE type = 'persist'
            AND goblin = goblinId
            AND commitId IS NOT NULL
          UNION ALL
          SELECT NULL as rowid
          FROM (
            VALUES (0), (0), (0), (0), (0), (0), (0), (0), (0), (0) -- LIMIT X to 10 (max)
          )
          ORDER BY rowid DESC
          LIMIT 4 -- Use 10 to keep 10 latest actions, etc.
        )
        ORDER BY rowid ASC
        LIMIT 1
      )
    ORDER BY goblin, rowid ASC
  )
  GROUP BY goblinId
) AS removeList
WHERE actions.goblin = removeList.goblinId
  AND actions.rowid < removeList.max
```
