# Conditional credential writeback into the account's directory

The project owner settled this in the grill and after the spike for feature 006 on 2026-11-04. When the harness refreshes
a token in its private home, cusr writes the new copy back to the spare account's directory as soon as the file changes,
without waiting for the attempt to finish. Each write happens only if the source is still the version the writer recorded
when it started (compare-and-swap by digest), under the account's lock. If the source has changed, the source is kept,
the writer's copy is dropped, and an event records the reason. The order in which attempts finish does not prove the order
in which tokens were refreshed, so cusr does not infer which copy is newer.

Early writeback is required. The spike showed that the refresh tokens of both Claude and Codex rotate after each refresh,
and when two Claude attempts refresh at the same time, the loser fails auth immediately. The loser can only be rescued
(re-run with the new token) if the winner's copy was already in the source before the daemon examined the loser's error.

Only cusr writes to the spare account's directory, so cusr's own lock is sufficient. The lock is `BEGIN EXCLUSIVE` on a
separate SQLite file for the account, held by the kernel and released automatically when the process dies. cusr does not
coordinate locks with the vendor or other tools, because it does not write to anyone else's credentials. The default
account is never written back to (ADR 0010).

A write error differs from a source conflict. When a write fails, the refreshed credential is kept temporarily in the
secret area with mode 0600, and the obligation to write it back survives restarts. The account is not selected again yet,
but the attempt's work results are still saved. This obligation does not hold a slot, and does not block the task from
moving on with another account; if only accounts awaiting a write remain, the task waits on an operational error with
backoff. Each retry takes the lock from the start and still applies the unchanged-source condition. If the account
directory has been removed, it is not recreated. A successful write clears only the pending-writeback cause. Removing an
account deletes its directory, including any pending writeback.

This is a design decision for feature 006; it does not describe a feature that has been implemented. Sources:
[FR-022 to FR-024 in the spec](../../specs/006-account-pool/spec.md),
R-06 and R-13 in research (not published) and
spike report (not published).
