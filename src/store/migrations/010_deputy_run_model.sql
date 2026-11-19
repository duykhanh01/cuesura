-- The model and effort a deputy run was launched with, so its log can say which model wrote it. NULL for runs
-- recorded before this column: their model was not kept and is never guessed.
ALTER TABLE deputy_turn_runs ADD COLUMN model_id TEXT;
ALTER TABLE deputy_turn_runs ADD COLUMN effort TEXT;
