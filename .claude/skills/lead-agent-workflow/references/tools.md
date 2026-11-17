# Tool cards

Read the installed tool help before dispatch. These are capability pointers, not a replacement for
current schemas. Higher-priority harness instructions govern calls and permissions; this skill
cannot override them. Preserve allowed provider/model/profile/effort. Missing capability is not
authority to switch backend, create replacement agents or configure the harness.

| Capability | Required record / fallback |
| --- | --- |
| Spawn/workspace | task/role, explicit target settings and actual workspace/base; use supported isolation |
| Resume | Owner ID checked against task/role; if unavailable use an authorized replacement and current report |
| Finish/status | supported completion plus actual state; notices can repeat or be intermediate |
| Wait/PR watch | supported wake recorded before waiting; no untracked background or forbidden polling |
| Ask | harness question tool, preserving prior grants; secrets through its secret facility |

## T3 Code

- Discover `orchestrator_capabilities` before the first `delegate_task`; pass requested settings in
  `target.options`, including permitted profile. Use native children only when current harness
  instructions allow; separate checkouts use the tool's isolation, never shell-created substitutes.
- `delegate_task` owns tracked async work; follow its returned `next`. Do not poll a running child.
  Use `task_cancel` for obsolete delegates, rather than interrupting a child thread underneath it.
- The tool exposes `t3_thread_send` for child continuation, with `childThreadId`; actual use depends
  on current harness restrictions. Some harness versions require every review/re-check to be a new
  `delegate_task`. In that case obey it and provide open findings, settled decisions and fix range
  for a narrow re-check. The same-reviewer policy does not override higher-priority instructions.
  Do not change external T3 configuration as part of running or editing this skill.
- Record the actual child's ID in Owner, not the lead's ID. Check recipient role/task before send.
  A completion may be intermediate; accept only a matching revision/output/head report. Continuation
  and retained reviewer context have not been live-verified by this skill's offline tests.
- Link created/pushed PRs with `link_pull_request`. A lead waiting on GitHub uses
  `watch_pull_request`, then ends its turn; children never watch. Unwatch at handoff. Use pr-ci once
  for a verdict, not `--wait`. Follow runtime rules about when PR watches are required.
- Top-level thread creation is separate from delegation and requires a user request. Workspace
  creation/branch names follow current tool settings; do not assume a child's default cwd matches
  its intended repository. Verify remote and paths before editing.

## Paseo

- Spawn with `create_agent` and a supported workspace; discover provider/model/profile and effort
  from current list tools. `send_agent_prompt` resumes context; `update_agent` changes settings
  only within the grant. Record the actual ID in Owner.
- `notifyOnFinish` supplies completion when supported; an external CLI caller may need `paseo wait`
  via a completion-aware facility. Notices can be duplicated/lost across restarts. Reconcile status
  and recent activity; idle plus dead background work needs a continuation.
- `create_heartbeat` provides timed wakes only where permitted; delete obsolete wakes. Archiving
  a workspace closes its agents; preserve live work first. Resume/import behavior is provider-specific:
  verify current support, and do not assume an archived agent revives on send.

## Claude Code

- Use the current native Agent tool/model list for supported Claude children; its isolation and
  foreground/background settings follow the installed harness. Do not assume all versions offer
  the same modes. Explicitly name the model rather than inheriting an expensive default.
- Resume through the tool's current continuation/message mechanism. Completion events are preferred;
  scheduled wakes or tracked CI waiting are alternatives only if supported and permitted.
- Another model family requires an already authorized cross-provider facility; never silently fall
  back to a CLI or a different provider when the requested one is unavailable.

## Unknown tool or Git host

Read help and verify only the capabilities needed for this run. Do not send test messages to live
workers. A harmless isolated capability probe needs its own authority and scope. Add concise facts
and mark unverified behavior; do not promote a single run's model selection to universal policy.
On another Git host map PR creation, full-head reads, checks, ready and SHA-bound merge to that
host's CLI/API while retaining the same verdicts and gates. Prefer an installed GitHub wrapper when
it supports the operation; scripts use the authenticated `gh` CLI for its stable JSON interface.
