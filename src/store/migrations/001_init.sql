-- Source of truth: events, accepted_triggers, frozen_policies, and frozen_contexts.
-- All other tables are projections that can be rebuilt from events.

CREATE TABLE schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
) STRICT;

-- Includes accepted triggers whose decisions were rejected.
CREATE TABLE accepted_triggers (
  dedup_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  task_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  global_seq_from INTEGER,
  global_seq_to INTEGER
) STRICT;

-- accepted_triggers is written last, so check its foreign key at commit.
CREATE TABLE events (
  global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  dedup_key TEXT REFERENCES accepted_triggers (dedup_key) DEFERRABLE INITIALLY DEFERRED,
  claim TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE (task_id, seq)
) STRICT;

CREATE TABLE frozen_policies (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  policy_hash TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  PRIMARY KEY (task_id, revision, policy_version)
) STRICT;

CREATE TABLE frozen_contexts (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  context_hash TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  context_json TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  source_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'READY', 'RUNNING', 'WAITING', 'DONE', 'FAILED', 'CANCELLED')),
  wait_reason TEXT,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  UNIQUE (project, source_key)
) STRICT;

CREATE TABLE task_deps (
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
) STRICT;

CREATE TABLE effects (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'started', 'succeeded', 'failed', 'unknown', 'invalidated')),
  request_json TEXT NOT NULL,
  result_json TEXT,
  reservation_id TEXT,
  -- EffectRequested.global_seq defines deterministic pendingEffects order.
  created_seq INTEGER NOT NULL,
  UNIQUE (idem_key)
) STRICT;

CREATE INDEX effects_status ON effects (status, created_seq);

CREATE TABLE timers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('armed', 'fired', 'cancelled')),
  payload_json TEXT NOT NULL
) STRICT;

CREATE INDEX timers_due ON timers (status, due_at);
