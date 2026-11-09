-- The execution slot becomes per task (FR-044.01): up to `runtime.concurrency` holders, one row per
-- holder. The cap is enforced when a grant is decided, not here, so a lowered cap never breaks replay.
CREATE TABLE execution_slot_new (
  request_id TEXT PRIMARY KEY,
  holder_task_id TEXT NOT NULL UNIQUE,
  claimed_at INTEGER NOT NULL,
  -- global_seq of the grant: holders in grant order, even when several share one claimed_at.
  claimed_seq INTEGER NOT NULL UNIQUE
) STRICT;
INSERT INTO execution_slot_new (request_id, holder_task_id, claimed_at, claimed_seq)
  SELECT s.request_id, s.holder_task_id, s.claimed_at, e.global_seq
  FROM execution_slot s
  JOIN events e ON e.type = 'ExecutionGranted'
    AND json_extract(e.payload_json, '$.request_id') = s.request_id;
DROP TABLE execution_slot;
ALTER TABLE execution_slot_new RENAME TO execution_slot;
