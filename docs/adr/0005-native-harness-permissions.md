# Run directly on the host, delegate execution permissions to the harness

Decided by the project owner on 2026-11-01, replacing the baseline of [ADR-0004](0004-isolated-bwrap-baseline.md):
Cuesura drops the outer bwrap, runs Claude/Codex directly in a dedicated worktree and keeps systemd to supervise,
cancel and recover processes. By default the harness uses `auto` permissions: Claude `permissions.defaultMode=auto`
with the worker sandbox off by default as in [Claude Code](https://code.claude.com/docs/en/sandboxing#what-the-sandbox-restricts); Codex uses `workspace-write`,
`approval_policy=on-request`, `approvals_reviewer=auto_review`.

The owner can write `permission_mode: full-access` into the pin with `write-pin --permission-mode full-access`.
The Claude worker then uses `bypassPermissions`; the Claude sandbox is chosen independently via
`write-pin --sandbox on|off` or `settings.sandbox.enabled`, and does not change with the permission mode.
If not declared, the worker sandbox is off; if on, there is no fallback to running outside it on error. Codex uses `danger-full-access`
and `approval_policy=never`. The decider stays read-only by role; since constitution 8.0.0 the reviewer runs like the fixer and the daemon restores the worktree. Changing the permission mode requires the pin/manifest
to match; changing the sandbox also requires a new proof. Tasks and workers do not choose the mode themselves. This auto review/approve only handles tool permissions inside the
harness; it does not replace `full-review`/`direct-pr`, gates, run confirmation or the workflow's merge permission.

Rationale: nested sandbox layers block tools, sockets and tests, and add operational work on a personal machine
with trusted repos. Setup/gate/autofix invoked by Cuesura run on the host. A worktree is not a security boundary:
Cuesura no longer promises to hide the whole home, Git metadata, database, sockets or secrets from same-UID processes.
It keeps a separate home/auth, filters credentials out of the environment, and checks the pin/hash, results, reviewer and Git metadata;
post-run checks detect changes, they do not prevent every access on the host.

New manifests record `isolation_mode=native`, `provider=host` and the chosen permission mode, without needing an outer proof.
Old bwrap evidence is kept for reading history; it is not used for a new host run. Tasks frozen
with the outer bwrap must finish/be cancelled under the old release and then a new task created; the snapshot of a running task is not silently replaced.

When the Claude worker has the sandbox off but keeps auto, the manifest records `selected_inner_mode=permissions_only`
and `native_result=not_tried`; evidence that permission rules are enforced is still required. When the sandbox is on, both auto and
full access need a passing native negative probe. The decider keeps a read-only sandbox under every worker choice.
