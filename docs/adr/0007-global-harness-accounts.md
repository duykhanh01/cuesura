# Harness accounts are shared across the daemon; only admin can change them

The project owner settled this in the grill for feature 006 on 2026-11-04: accounts are shared harness resources across
the whole daemon, not owned by one project. Adding, removing, suspending, re-enabling, clearing a cooldown, or changing
priority, including `account use`, all require the `admin` permission. Granting these operations to `operate` per project
would let a caller affect tasks outside its scope. A dedicated permission for assistants to change accounts themselves is
deferred. Each new attempt still picks by current state and priority, while a task's binding and pool cap are kept
unchanged.

Read access is split by content: name, harness, priority and availability are shared metadata; attempt counts, last-use
times and task lists are computed only over projects the caller can read. Vendor identity, credential paths and
filesystem error details are visible to admin only. The same rules apply to list, doctor, report, the TUI and
notifications, so the shared resource does not expose activity from projects outside the caller's read access.

This is a design decision for feature 006; it does not describe a feature that has been implemented. Sources:
[Clarifications, FR-007 and FR-008 in the spec](../../specs/006-account-pool/spec.md)
and R-09 in research (not published).
