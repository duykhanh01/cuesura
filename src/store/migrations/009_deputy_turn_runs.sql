-- Each run of a deputy turn (its first, and one per resume), so `task_logs` can place the run's spool in the
-- task's log. `after_seq` is the task's last event when the run was recorded: the run's records come after
-- the output of every operation registered by then and before that of any registered later. Not an
-- event, so FR-025 holds.
CREATE TABLE deputy_turn_runs (
  turn_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  task_id TEXT,
  operation_id TEXT,
  after_seq INTEGER NOT NULL,
  PRIMARY KEY (turn_id, attempt_id)
) STRICT;
CREATE INDEX deputy_turn_runs_task ON deputy_turn_runs (task_id, after_seq);

-- Turns recorded before this table keep only their latest run; their place is the log as it stands now.
INSERT INTO deputy_turn_runs (turn_id, attempt_id, task_id, operation_id, after_seq)
SELECT t.turn_id, t.attempt_id, t.task_id, NULL,
       COALESCE((SELECT MAX(e.seq) FROM events e WHERE e.task_id = t.task_id AND e.stream = 'task'), 0)
FROM deputy_turns t
ORDER BY t.started_at, t.turn_id;
