-- Positions `task_logs` has handed out for an operation's records, committed or not: a live tail read before
-- its operation was ingested keeps its positions if the rest of its spool can never be read. `sealed` is the
-- number of places the operation keeps for good once the log went on past it without waiting (its spool gone
-- or corrupt): what it commits beyond them later goes at the end of the log, not under positions already
-- handed out. Not an event, so FR-025 holds.
CREATE TABLE operation_log_published (
  task_id TEXT NOT NULL,
  operation_id TEXT NOT NULL PRIMARY KEY,
  records INTEGER NOT NULL DEFAULT 0,
  sealed INTEGER
) STRICT;
CREATE INDEX operation_log_published_task ON operation_log_published (task_id);
