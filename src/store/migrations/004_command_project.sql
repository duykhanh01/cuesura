-- The project a request was admitted for, so `request_show` can check the caller's scope (feature 004
-- R-08) even for a rejected request that never produced a task. A row older than this migration takes
-- the project of its task; without a task it stays NULL and only an unrestricted token can read it.
ALTER TABLE command_ledger ADD COLUMN project TEXT;
UPDATE command_ledger
SET project = (SELECT project FROM tasks WHERE tasks.id = command_ledger.task_id)
WHERE task_id IS NOT NULL;
