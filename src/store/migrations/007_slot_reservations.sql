-- A holder waiting outside keeps its slot as a reservation another task may borrow (FR-044.02).
-- A loan is a row of its own, tagged with the lender and the reservation it borrows (`lent_reserved_at`);
-- it does not count toward `runtime.concurrency`.
ALTER TABLE execution_slot ADD COLUMN reserved_at INTEGER;
ALTER TABLE execution_slot ADD COLUMN lender_task_id TEXT;
ALTER TABLE execution_slot ADD COLUMN lent_reserved_at INTEGER;
CREATE UNIQUE INDEX execution_slot_lender ON execution_slot (lender_task_id)
  WHERE lender_task_id IS NOT NULL;
