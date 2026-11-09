-- Every table below except command_ledger is a projection rebuilt from events; raw events, accepted
-- triggers and frozen snapshots of schema 1 are not touched. migrate.ts rebuilds task projections in the
-- same transaction, because TaskState gained runtime fields with replay defaults.

CREATE TABLE runtime_contexts (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  runtime_hash TEXT NOT NULL,
  runtime_json TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
) STRICT;

CREATE TABLE execution_queue (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  grp TEXT NOT NULL CHECK (grp IN ('fresh', 'resumed')),
  priority INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  request_global_seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'granted', 'withdrawn')),
  closed_at INTEGER
) STRICT;

-- One open request per task.
CREATE UNIQUE INDEX execution_queue_open ON execution_queue (task_id) WHERE status = 'queued';
-- Selection order: priority desc, resumed before fresh, request time, commit order (SPEC.md §6.2).
CREATE INDEX execution_queue_order ON execution_queue (status, priority DESC, grp DESC, requested_at, request_global_seq);

-- Daemon-wide singleton: the key makes a second holder a constraint violation.
CREATE TABLE execution_slot (
  key TEXT PRIMARY KEY CHECK (key = 'execution'),
  holder_task_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  claimed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  effect_id TEXT NOT NULL REFERENCES effects (id),
  attempt_id TEXT,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  launch_nonce TEXT NOT NULL UNIQUE,
  unit TEXT NOT NULL,
  holds_slot INTEGER NOT NULL CHECK (holds_slot IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('registered', 'running', 'finished', 'not_launched', 'unknown', 'lost')),
  outcome TEXT,
  receipt_json TEXT NOT NULL
) STRICT;

-- At most one unresolved operation per effect; a requeued effect gets a new operation only after the
-- previous one is proven finished or never launched.
CREATE UNIQUE INDEX operations_open_effect ON operations (effect_id)
  WHERE status IN ('registered', 'running', 'unknown', 'lost');

CREATE TABLE ingest_cursors (
  operation_id TEXT PRIMARY KEY REFERENCES operations (id),
  generation INTEGER NOT NULL,
  segment INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  last_record_seq INTEGER NOT NULL,
  acked_at INTEGER
) STRICT;

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (id),
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  digest TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  redaction_version INTEGER NOT NULL,
  finalized INTEGER NOT NULL CHECK (finalized IN (0, 1)),
  acked INTEGER NOT NULL CHECK (acked IN (0, 1)),
  UNIQUE (operation_id, relative_path)
) STRICT;

CREATE TABLE external_observations (
  observation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  -- Non-null only for the observation that carried a merge proof: one proof per subject.
  proof_key TEXT UNIQUE,
  observation_json TEXT NOT NULL
) STRICT;

-- Source of truth (not a projection): CLI/application mutation ledger. Admission is written before any
-- preflight I/O so a restart finds the same request, server-assigned IDs and first result.
CREATE TABLE command_ledger (
  request_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  task_id TEXT,
  assigned_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('admitted', 'completed')),
  admitted_at INTEGER NOT NULL,
  completed_at INTEGER,
  result_json TEXT
) STRICT;
