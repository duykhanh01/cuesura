-- Feature 007: goals are a second aggregate in the same event log (R-21), and deputy turns and branch
-- conflicts are daemon records outside it: writing them adds no event and moves no version (FR-025).
ALTER TABLE events ADD COLUMN stream TEXT NOT NULL DEFAULT 'task' CHECK (stream IN ('task', 'goal'));

-- Projection of the goal stream; `task_id` of a goal event holds the goal id.
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planning', 'awaiting_confirm', 'running', 'amendment_pending', 'replan', 'done', 'failed', 'cancelled')),
  implicit INTEGER NOT NULL CHECK (implicit IN (0, 1)),
  version INTEGER NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 0,
  plan_hash TEXT,
  confirmed_plan_version INTEGER,
  branch TEXT,
  final_task_id TEXT,
  state_json TEXT NOT NULL
) STRICT;
CREATE INDEX goals_project ON goals (project, status);

-- At most one unfinished task per unit key is checked by the application: task status lives in `tasks`.
CREATE TABLE goal_tasks (
  goal_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  unit_key TEXT,
  role TEXT NOT NULL CHECK (role IN ('unit', 'final')),
  PRIMARY KEY (goal_id, task_id)
) STRICT;
CREATE INDEX goal_tasks_task ON goal_tasks (task_id);

CREATE TABLE deputy_turns (
  turn_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('incident', 'question', 'plan')),
  incident TEXT,
  signature TEXT,
  harness TEXT NOT NULL,
  session_ref TEXT,
  attempt_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('interactive', 'headless')),
  state TEXT NOT NULL CHECK (state IN ('running', 'retry_wait', 'done', 'handed_off', 'aborted', 'stopped')),
  infra_failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  handoff_json TEXT,
  final_message TEXT,
  handoff_reason TEXT CHECK (handoff_reason IN ('still_waiting', 'auth', 'refused', 'capability', 'no_harness', 'infra_cap', 'handover')),
  context_bytes INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;
-- FR-014: one live turn per task, and one live plan turn per goal.
CREATE UNIQUE INDEX deputy_turns_live_task ON deputy_turns (task_id)
  WHERE task_id IS NOT NULL AND state IN ('running', 'retry_wait');
CREATE UNIQUE INDEX deputy_turns_live_plan ON deputy_turns (goal_id)
  WHERE kind = 'plan' AND state IN ('running', 'retry_wait');
CREATE INDEX deputy_turns_goal ON deputy_turns (goal_id, started_at);

CREATE TABLE branch_conflicts (
  task_id TEXT NOT NULL,
  other_task_id TEXT NOT NULL,
  head TEXT NOT NULL,
  other_head TEXT NOT NULL,
  files_json TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, other_task_id)
) STRICT;

ALTER TABLE command_ledger ADD COLUMN reason TEXT;
ALTER TABLE command_ledger ADD COLUMN turn_id TEXT;
ALTER TABLE command_ledger ADD COLUMN trial_json TEXT;
ALTER TABLE command_ledger ADD COLUMN lease TEXT;
CREATE INDEX command_ledger_turn ON command_ledger (turn_id) WHERE turn_id IS NOT NULL;
