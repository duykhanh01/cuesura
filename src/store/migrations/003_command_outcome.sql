-- The command ledger now stores the handler's outcome, `{"ok":true,"value":...}` or
-- `{"ok":false,"error":...}`, so a rejection is replayed like a success. Rows completed before this
-- migration hold the bare value of a successful handler: wrap them, so the same request keeps
-- replaying the same success. `admitted` rows have no result and are left alone.
UPDATE command_ledger
SET result_json = json_object('ok', json('true'), 'value', json(result_json))
WHERE status = 'completed';
