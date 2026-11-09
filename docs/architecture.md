# Cuesura — Architecture review and recommendations (first use case: software development workflow)

> Design update 2026-10-29: two modes and confirmation before running
> replace the old examples of skipping review by XS size, mandatory different-vendor review, and committing after review.
> The content below preserves the original architectural reasoning; the runtime for the new decisions is not yet implemented.

*Date: 2026-10-26. Role: Principal Software Architect review.*

> **Implementation spec:** [SPEC.md](../SPEC.md) is the canonical source for the agreed scope, behavior, and technical baseline. This document keeps the original reasoning and initial design examples; examples that are not yet in sync do not replace the contract in SPEC.

**Confidence labels** used throughout this document:

- **[XM-code]**: directly verified in the source code (file path given), commit recorded in section 2.
- **[XM-docs]**: verified from official documentation or README; the corresponding code has not been read.
- **[SL]**: my own inference/experience, not verified.
- **[CKC]**: assumption to verify with a spike before depending on it.

## 0. Executive summary: firm recommendation

**Recommendation: build your own *control plane* in TypeScript + SQLite, reliable from v1. The yardstick is the Reliability Gate (section 9.1), not a line-count limit. Do not fork any of the five candidate tools. Do not use a durable-execution framework in v1. Before coding, write your own `SPEC.md` in the *spec-first* style of OpenAI Symphony.**

The architecture in one sentence:

> *A pure state machine (a predefined graph workflow with bounded loops, statically checked by tests; YAML only tunes parameters) decides every step. Agents are **one-shot headless CLI calls** (`claude -p`, `codex exec`, `pi --mode rpc/json`) that return results as **schema-validated JSON**. Every side effect (push, PR, comment, merge) goes through an **outbox with an idempotency key and a "probe" step before any retry**. State lives in SQLite with an append-only event log.*

**Reasons (based on source code, section 2):**
1. **No candidate has all three things that make your approach different:**
   - Role/model policy frozen per task, **with model escalation allowed only along an escalation ladder approved in advance** (triggered by code; expensive rungs need approval). Bernstein escalates to Opus automatically on every retry. Cezar lets the agent choose models for subtasks. Paperclip has auto-fallback models.
   - An idempotent side-effect ledger for push, PR, comment, and merge. Each tool has only scattered pieces: for example, AO guards merges by SHA, and Cezar reuses an existing PR.
   - Task intake from multiple channels (GitHub, forms, agents, CLI), normalized into **one task format in the DB**, with status synced back to the originating channel. Each tool covers only part of this: Symphony reads trackers but stores nothing; AO reads trackers one-way only; Cezar and Paperclip have issue/chat integrations but are tightly coupled to their own models.
2. **The parts you would have to change are the ones that are hard to separate and change most often.** Forking is hard because of structure, not code size:
   - Cezar's orchestration logic is concentrated in a single `RunManager` class.
   - Bernstein has hundreds of modules that are not wired into the main flow, and its looping workflow feature cannot run from the CLI.
   - Paperclip and AO both have two parallel runtime paths, and the products are changing direction (self-running AI company, desktop/mobile).
   - The repos change versions weekly, and some are maintained by roughly one person.

   Forks would diverge from upstream immediately. That is the maintenance trap you are afraid of.
3. **The repo closest to your philosophy, Symphony, recommends this itself:** "implement your own hardened version based on SPEC.md". Its Elixir version is only a prototype: state in RAM, unlimited retries, Codex only.
4. **The part you most want to learn is the part you must write yourself**: state machine, recovery, idempotency, quality gates. Using an existing runtime would give up that value.

**Trade-offs you accept:**
- Maintaining an adapter for each harness yourself. This is the part most likely to become outdated. Keep each adapter to two jobs (building the command, parsing output) and test it with fixtures recorded from the real CLI.
- No UI.
- Far fewer features than the other tools.
- To reach the reliability bar, v1 needs about **4 weeks**, not 14 days. If 14 days is mandatory, cut scope, not reliability (section 9.2).

**Fallback plan (Plan B):** at the direction checkpoint (day 10), if the runner/adapter is still unstable, keep your own parts (task sources, DAG, policy, SQLite) and use **Cezar as the executor** through its HTTP API. Cezar is the candidate whose workflow engine is closest to this design (section 2.4).

**Three assumptions to verify on day 1:**
1. Agents comply with the `result.json` contract under its schema.
2. `claude -p` can run long and unattended on a subscription, and rate-limit errors can be recognized.
3. The sandbox of `codex exec` lets the project's build tools (npm, pip, cargo, Gradle…) reach the network to download dependencies.

All assumptions are listed in Appendix A.

---

## 1. Evaluation of the idea

### 1.1 Entirely reasonable requirements (keep as they are)

| Requirement | Comment |
|---|---|
| Orchestration by code/state machine, no Primary AI | Right direction and the core value of the project. Most "what next" decisions in a coding workflow are functions of data: exit codes, test results, review verdicts, CI status. No LLM is needed for those decisions. |
| Durable state + recovery + idempotency | This is the area where existing tools are weakest, and also the area with the most lasting learning value. |
| Role/model configurable, policy frozen per task | Reasonable. "Frozen" should be understood as freezing **the whole pre-approved escalation ladder**, not as forbidding escalation: escalation is allowed along rungs declared in advance, triggered by code, and expensive rungs require approval (section 5.4). |
| Minimal context per role | This is the biggest token lever after dropping the Primary. |
| CLI-first, interacting with external AI | Correct: a CLI with `--json` output is the cheapest interface in tokens and works with every harness. |
| Quality gates as shell commands | Mandatory. Gates run by the orchestrator are the source of truth, not the agent's claim that it "finished testing". |

### 1.2 Parts that are over-designed

1. **"Pure" event sourcing.** You do not need to rebuild state from events on every read, and you do not need a CQRS framework. Use *an append-only event log + projections updated in the same transaction* (called "event-sourced lite"). You can still learn event sourcing through a `cusr admin verify-projections` command that rebuilds projections from events and compares them, but the runtime is much simpler. **[SL]**
2. **11 task states.** The current list mixes *task* states with *step* and *attempt* states. `WAITING_REVIEW` is not a state: review is a step. `RETRYING` is an attribute of an attempt. `BLOCKED` due to a dependency is a derived value. Proposal:
   - `task.status ∈ {PENDING, READY, RUNNING, WAITING, DONE, FAILED, CANCELLED}`
   - `task.wait_reason` says why the task has not started or is paused. The shorthand used in this document is `PENDING(<reason>)` / `WAITING(<reason>)`:
     - When `PENDING` (not started, no worktree yet): `confirmation | needs_info | dependency`.
     - When `WAITING` (has run, stopped midway): `human_input | approval | ci | rate_limit | policy | infra`. For `approval`, `approval_kind` states the type of approval (`merge`, `escalation`, …).
   - `task.current_step` + `attempt.status`
   - Raw events from the source channel *before* they become a task are stored in the `source_events` table (section 8.2), not as a task state.

   This is the only set of states used throughout the document.

   Fewer states make the state machine easier to prove correct and easier to test.
3. **`when_use` of the form `condition: insufficient_context`.** Code cannot judge "insufficient context" by itself. Trying to would quietly bring back an LLM router, that is, the Primary you want to remove. Section 5 shows how to split it instead.
4. **Configuring everything when each task is created.** Use *profiles* (presets), and override only when truly needed. With dozens of tasks per feature, configuring each task by hand would become a burden.
5. **Scout as an always-on step.** Modern coding agents survey the repo themselves while they work. A separate scout should only be an opt-in step, used when the Planner flags it or the Coder returns `needs_context`. **[SL]**
6. **Specialized resources (device/emulator, browser E2E), remote workers, a web dashboard** must stay out of v1. You have already recognized this yourself; keep that decision.

### 1.3 Parts that are underrated (real risks)

1. **The size of tasks given by people is not fixed.** Some jobs are tiny, and some requests are too big for one PR. v1 treats **each task as 1 branch and 1 PR**. A large request is marked `type: epic` and split into subtasks through *one* run of `planner`, with your approval (section 8.4). No implicit splitting. **[SL]**
2. **Real parallelism is lower than you think.** In most projects, many tasks touch the same small group of *hotspot files*: dependency manifests and lockfiles (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `build.gradle.kts`…), central registration files (router, DI container, registry, barrel exports), DB migrations, and shared configuration. Running them in parallel creates merge conflicts. You need file-ownership hints (the project declares `hotspots`, section 5.2b), serialization by file area, and a bounded `rebase` step. **[SL]**
3. **The real bottleneck is subscription rate limits, not tokens.** With a Claude/ChatGPT plan, the scarce resource is the usage-window limit. The scheduler must know which harness is rate-limited so it can pause and schedule a retry, instead of marking tasks FAILED en masse. **[SL]**
4. **Agents claim they are done when they are not.** Gates run by the orchestrator, plus schema-validated output (review verdict as JSON), are the line of defense. Never change state based only on the agent's free text.
5. **Permissions and security.** Running unattended agents with high privileges in a worktree is a real risk: secrets, `git push --force`, deleting files outside the worktree. Minimum rules are needed: agents have no right to push or merge (the orchestrator does that), harness sandboxes are enabled where possible, and after v1 agents run under a separate user or in a container.
6. **The base branch moves.** When tasks depend on each other, a clear branch strategy is needed (section 8.5). Without one, most of the time goes to resolving conflicts.

---

## 2. Build vs. Buy vs. Extend

### 2.1 Method
On 2026-10-26 I shallow-cloned 6 repos and analyzed their **source code**, not just the READMEs, using the same set of criteria derived from your 9 requirements. Every claim is tagged [XM-code] / [XM-docs] / [SL]. I **re-checked myself** the claims that most affect the decision (marked ✔ in table 2.3).

| Repo | Commit | Date |
|---|---|---|
| open-mercato/cezar | `f6b910f` | 2026-10-25 |
| chernistry/bernstein | `fbb01b5` | 2026-10-26 |
| paperclipai/paperclip | `1fbbef4` | 2026-10-25 |
| ComposioHQ/agent-orchestrator | `d98dfa0` | 2026-10-26 |
| openai/symphony | `be10a1b` | 2026-09-15 |
| kunchenguid/firstmate (cross-check) | `127f0f3` | 2026-10-25 |

### 2.2 Comparison table by your requirements

| Criterion | Cezar | Bernstein | Paperclip | Agent Orchestrator | Symphony | Firstmate |
|---|---|---|---|---|---|---|
| Language / license | TS / MIT | Python 3.12 / Apache-2.0 | TS / MIT | **Go + Electron** (rewritten, no longer a TS monorepo) / Apache-2.0 | SPEC + Elixir / Apache-2.0 | bash / MIT |
| Ability to separate the part you need | Low: engine sits in one large orchestration class, tightly coupled to server/SPA | Low: tick loop and task store are intertwined; many modules are not wired in | Medium for adapters (depends only on `adapter-utils`), low for the engine | Low: no workflow exists; session manager is the core | High: SPEC is cleanly separated; runner is one module | Low: logic lives in bash and prompts |
| Who decides the next step | **Code** (graph walk). LLM only picks a branch via verdict markers. "Dispatch" (agent creates subtasks itself) is **on by default** | Mostly code. LLM "manager review" lives in the tick loop (off by default). Goal mode uses a manager agent | **LLM** (agent claims work and sets status itself) | **LLM worker** follows the prompt; daemon only "nudges" | One agent does everything per the prompt | **LLM Primary** |
| Declared workflow + bounded loops | **Yes**: graph v2 with `loop{max}`, `github.wait-ci`, `gate.human`, static cycle check ✔ | Has a schema, but agent nodes **break when run from the CLI** ✔. Legacy DSL with condition edges is **not executed** ✔ | Only review/approval stages (`maxReviewRounds`) | No. Reactions are hard-coded in Go | No | No (delegated to an external pipeline) |
| Role/model per step | Per node | Per step | Per agent | worker / reviewer | Global | `when/use` rules matched by an **LLM** |
| Policy frozen; model escalated only along an approved ladder | ✗ (dispatch lets the agent choose models) | ✗ (retry climbs to Opus) | ✗ (has auto-fallback) | ✗ | ✗ | ✗ |
| DAG between tasks | ✗ | ✔ | ✔ (`blocks`) | ✗ | Via tracker blockers | Backlog managed by the LLM |
| Storage | JSON + NDJSON (1s debounce) | JSONL + WAL hash-chain | **Postgres** (embedded) ✔ | **SQLite** | **RAM** ✔ | Files |
| Recovery | Continues at the node, resumes session | Kill, then re-run from scratch | Very strong (pid/pgid, boot-id lease) | Reattaches PTY host; does not relaunch on its own | Rebuilt from tracker | Reconciled with tmux |
| Side-effect idempotency | Reuses existing PR. Comments are **not** guarded | ✗ | ✗ (agent pushes/creates PRs itself) | Merge guard by head SHA. PR created by agent | Agent handles it | Merge script with a guard |
| Claude / Codex / Pi | ✔ stream-json / ✔ app-server / ✔ rpc | ✔ / ✔ exec / weak | ✔ ACP / ✔ ACP / ✔ json | ✔ / ✔ / ✔ (TUI + hook) | ✗ / ✔ / ✗ | ✔ / ✔ / ✔ (TUI) |
| Task sources | Automations from GitHub issue/PR, Jira/Linear, todo inbox | YAML plan files, backlog parser | Internal issues + Slack/Discord/Teams/Telegram/GitHub bot | Tracker intake, read-only, one-way | Trackers (Linear, GitHub, GitLab, Jira, Asana), read-only; agent writes | Markdown backlog managed by the Primary |
| Async HITL | Only inside the cockpit | No WAITING_INPUT | ✔ (Slack/Discord…) | Push notification | Via tracker status | Set of status verbs |
| Interface for external AI | HTTP ~336 routes, no auth, no MCP | MCP 25 tools, HTTP, 214 CLI commands | REST, CLI, MCP ~45 tools | HTTP/OpenAPI, CLI `--json`, SKILL.md | HTTP status | — |
| Bus factor / pace of change | ~1 / very high | 1 / extremely high | ? / extremely high | owner changing / extremely high | OpenAI / low (prototype) | ~1 / extremely high |
| **Conclusion** | Learn the ideas; **Plan B** as executor | Learn the ideas | Learn the ideas | Learn the ideas | **Use SPEC as the reference document** | Learn the ideas |

### 2.3 Verified or inferred: the claims that decide the matter

| Claim | Status |
|---|---|
| `bernstein workflow run` builds `WorkflowRunner` without a spawner, so every agent node reports "requires a configured AgentSpawner" | ✔ `cli/commands/workflow_cmd.py:500,589`, `core/workflows/workflow_runner.py:363,982` |
| Bernstein's `DAGExecutor` is not instantiated outside tests | ✔ grep of `src/` finds nothing |
| Bernstein escalates the model automatically on retry | [XM-code by analysis agent] `task_lifecycle.py:408-496`; I have not read it myself |
| Cezar has a graph workflow with `loop`, `github.wait-ci`, `gate.human`, `ask-user` | ✔ `workflows/graph.ts`. The execution engine lives in the `RunManager` class of `workflows/run.ts` ✔ |
| Cezar enables "dispatch" by default, letting child agents choose runner/model | [XM-code by agent] `run.ts:2700-2825` |
| Agent Orchestrator has been rewritten in Go | ✔ 2,163 `.go` files in `backend/` |
| Paperclip runs only Postgres | ✔ `packages/db/package.json`: `drizzle-orm`, `embedded-postgres` |
| Symphony has no persistence; the Elixir version is "evaluation only" | ✔ grep finds no ets/dets/sqlite/File.write. `elixir/README.md:7-8` |
| Firstmate's Primary handles every "actionable" wake in one long conversation; the bash watcher uses no tokens | [XM-code/docs by agent] `AGENTS.md:270-287`, `bin/fm-watch.sh` |

### 2.4 Assessment of three directions

**B. Fork/customize an existing tool: rejected.**
- **Bernstein**: on paper the closest ("deterministic, no LLM in the loop"). The actual source differs:
  - The looping workflow does not run.
  - Recovery is "kill, then re-run from scratch".
  - No side-effect ledger.
  - Retry escalates the model automatically.
  - Hundreds of modules are not wired into the main flow. The repo itself has an allowlist of 307 modules that are unreachable.

  Fixing these three major gaps would take months.
- **Paperclip**: the opposite philosophy from yours, with an LLM deciding the flow. Runs only Postgres. Two runtime paths (legacy and native) run in parallel almost everywhere, so it is very hard to insert a deterministic step engine.
- **Agent Orchestrator**: no workflow engine. CI and review feedback all pile into *one* ever-longer session, which is exactly the token-waste cause you want to avoid. It has moved to Go and desktop.
- **Cezar**: the graph engine closest to the proposed design. But all execution, recovery, and side effects are concentrated in one `RunManager` class (the repo's own docs admit that two nearly duplicate handlers live inside it), state is debounced JSON, the version changes weekly, and the bus factor is about 1. A fork would diverge from upstream immediately.
- **Symphony**: nothing to fork (prototype, Codex only). The value is in the SPEC.

**C. Thin orchestration layer on top of an existing runtime: two variants assessed.**
- *C1. Durable-execution framework* (Temporal, DBOS, Restate):
  - Temporal needs its own server, and workflow code must be deterministic for replay.
  - The TypeScript DBOS needs Postgres; SQLite is only available in the Go version **[XM-docs]**.
  - Your workflow has few steps, each step is long and is an external process, so a state machine on SQLite + outbox is sufficient and more transparent.

  **Excluded from v1.** Learn their concepts, then re-implement them yourself (section 6).
- *C2. Use Cezar as the executor*: your part handles task sources, DAG, policy, and SQLite, then generates a workflow YAML per task and calls Cezar's `POST /runs`.
  - **Pros**: a ready-made, bounded review/CI loop, adapters for Claude, Codex, and Pi, worktrees, token accounting.
  - **Cons**:
    - State reliability (1s debounced JSON; comments not idempotent) conflicts with your priority 4.
    - Unauthenticated API that changes quickly.
    - Dispatch must be disabled (`CEZ_DISPATCH=0`) to keep policy.
    - Loses the core learning value.

  **Not chosen as the main direction; kept as Plan B.**

**A′. Build a small core yourself, spec-first, borrowing deliberately: chosen.**
Three differentiators of yours are not available in any tool: policy frozen with an approved model-escalation ladder, a side-effect ledger, and a multi-channel task source synced bidirectionally to one format in the DB. The shared parts (calling CLIs, polling `gh`, worktrees) already have good documentation and reference code to learn from.

### 2.5 Map of "deliberate borrowing"

Can be copied (MIT/Apache license), but **copy the ideas and contracts, not whole modules**.

| You need | Learn from | File |
|---|---|---|
| Static check "every cycle must pass through `loop{max}`", port/edge model | Cezar | `packages/cezar/src/workflows/graph.ts` (`advance()`, cycle validation) |
| Argv for Claude/Codex/Pi, stream parsing | Cezar, Paperclip | `core/claude-cli-runner.ts`, `core/pi-runner.ts`, `core/codex-app-server-runner.ts`; `packages/adapters/{claude,codex,pi}-local/src/server/{execute,parse}.ts` |
| Adapter result contract (usage basis, `errorFamily`: quota / transient / config / refusal) | Paperclip | `packages/adapter-utils/src/types.ts` |
| Process group, SIGTERM then SIGKILL, storing pid/pgid | Paperclip | `packages/adapter-utils/src/server-utils.ts` |
| Run ownership by boot-id/lease; "pid still alive but handle lost" is treated as *detached*, not blindly retried | Paperclip | `server/src/services/heartbeat/recovery.ts` |
| Clean up orphan processes with an env marker (`CEZ_TASK_ID` in `/proc/*/environ`) | Cezar | `core/task-processes.ts`. Use `CUSR_ATTEMPT_ID` similarly |
| A failed probe does not mean the process is dead; circuit breaker on mass "deaths" | Agent Orchestrator | `backend/internal/observe/reaper/reaper.go` |
| Merge guard by head SHA, no retry after the remote side has already succeeded | Agent Orchestrator | `backend/internal/service/pr/action_service.go` |
| Reuse an existing PR instead of creating a duplicate | Cezar | `server/forge/github.ts` (`existingPrUrl`) |
| Task-source connector as a "read-only kernel" (`fetch_issues_by_states`, `fetch_issues_by_ids`), with write permissions kept out of the connector | Symphony | `SPEC.md` §11 |
| GitHub/tracker event mapping + label filter into work to run | Cezar | `packages/cezar/src/automations/types.ts` |
| Questions sent over a chat channel as a form; the reply wakes the task | Paperclip | `server/src/services/chat-question-forms.ts` |
| CI log-tail format sent to the fixer; dedup by failing-check signature | Agent Orchestrator | `backend/internal/lifecycle/reactions.go` |
| Detect usage limits, parse reset time, auto-resume | Cezar | `core/usage-limit.ts`, `runs/failure-kind.ts` |
| Guarded FSM transition table; WAL fsync with hash-chain | Bernstein | `core/tasks/lifecycle.py`, `core/persistence/wal.py` |
| "One LLM call drafts a plan → human approves → deterministic compile into a task graph" | Bernstein | `sdd/spec_pipeline/` |
| Reviewer receives only the diff (size-limited), from a different vendor than the coder | Bernstein | `quality/cross_model_verifier.py` |
| Claim/retry/reconcile, stall detection, workspace safety rules, hook semantics, token accounting | Symphony | `SPEC.md` §7, §8.4–8.5, §9.4–9.5, §13.5 |
| Shape of `when/use/default/approval/min_confidence` rules; status verb set; "waiting costs no turns" | Firstmate | `docs/examples/crew-dispatch.json`, `AGENTS.md`, `bin/fm-brief.sh` |
| **Anti-patterns to avoid** | Bernstein (auto-escalates the model on retry), AO (nudges into the same session), Firstmate (LLM as event handler), Symphony (unlimited retries) | — |

**General observations** **[SL]**:
- All five tools have grown very fast thanks to AI-generated code, and all carry a very high cost to understand and maintain.
- 3 of 5 still let an LLM decide the flow.
- The only truly deterministic engine (Cezar) converges on exactly the model proposed here: a declared graph, statically checked bounded loops, CI polled by code. That is evidence the direction is right.
- The field has not converged. A small core that you fully understand is a more durable asset than any fork.

---
## 3. Proposed architecture

### 3.1 Foundational principles

> **Workflow is data, the engine is pure code, and the agent is an expensive "function" with side effects.**

- *Functional core, imperative shell*: all decision logic is a pure function `decide(state, trigger) → (events, commands)`. All I/O (spawning agents, git, gh, shell) lives in the effect executor.
- *Single writer*: a single `cusrd` daemon is the only writer to SQLite. The CLI and assistants send commands through the daemon, or write "command requests" into the DB for the daemon to process.
- *Agent process lives independently of the daemon*: if the daemon dies, the agent keeps running; when the daemon restarts, it reattaches. This is the key to recovery.

### 3.2 Diagram

```text
  External assistants (Claude Code / Codex / Pi / Paseo on iPhone)
        │  `cusr … --json` + SKILL.md     (MCP wrapper: stage 2)
        ▼
┌────────────────────────────── cusrd (daemon, single writer) ────────────────────────────────┐
│ Application Services: TaskManager · Intake (source connectors) · PolicyResolver · Query     │
│        │                                                                                    │
│        ▼                                                                                    │
│ Workflow Engine (pure)  decide(state, trigger) → {events, commands}   evolve(state, event)  │
│        │                                                                                    │
│ Scheduler: ready-queue · DAG · resource pools · rate-limit cooldown · durable timers        │
│        │                                                                                    │
│ Effect Executor (transactional outbox, idempotency key, probe-before-act)                   │
│   ├─ AgentRunner port ─► adapters: claude │ codex │ pi │ fake │ (acp – later)               │
│   ├─ GateRunner (shell)        ├─ Git/Worktree port      ├─ GitHub port (gh CLI)            │
│   └─ Notifier port (Telegram / GitHub comment)                                              │
│ Recovery Manager (reconcile on startup)                                                     │
│ State Store: SQLite WAL — events · projections · effects(outbox) · timers · artifacts       │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
        │ spawn detached (setsid)                         ▲ tail events.jsonl / read exit.json
        ▼                                                 │
  cusr-runner  (1 process/attempt, optionally in tmux) ───┘──► harness CLI running in the worktree
```

### 3.3 Per module

#### Task Manager
- **Entities:** `Task` in the standard format (section 8.2). A task can belong to a `group` or a `parent`, and has a `TaskLink` pointing to the matching item in its source channel (issue, form, agent). `Attempt` is one run of a step. `Effect` is a side effect. There are also `Question` and `Artifact` (review findings, gate log, CI log, diff stat).
- **Responsibilities:** create, edit, cancel tasks. Manage dependencies and check that there are no cycles. Assign profiles. Validate with a schema (zod).
- **Does not do:** decide the flow (that is the job of the Workflow Engine).

#### Workflow Engine (the heart: pure, no I/O)
```ts
type Trigger =
  | { kind: 'start' } | { kind: 'effect_result'; effectId: string; outcome: Outcome; data?: unknown }
  | { kind: 'timer'; timerId: string } | { kind: 'human'; action: 'answer'|'approve'|'reject'|'retry'|'cancel'; payload?: unknown };

type Command =
  | { kind: 'start_agent'; step: string; role: string; binding: ResolvedBinding; contextPacket: string[] }
  | { kind: 'run_gate'; step: string; commands: string[] }
  | { kind: 'git_push' } | { kind: 'create_pr' } | { kind: 'await_ci'; pollEvery: string }
  | { kind: 'request_approval'; gate: string } | { kind: 'merge' } | { kind: 'ask_human'; questionId: string }
  | { kind: 'notify'; message: string };

function decide(task: TaskState, wf: WorkflowDef, policy: FrozenPolicy, t: Trigger): { events: DomainEvent[]; commands: Command[] };
function evolve(task: TaskState, e: DomainEvent): TaskState;
```
- Every invariant lives here: `max_visits` for each step, `max_agent_runs` for each task, deadlines, and the policy guard (every `start_agent` must pass `assertAllowed(policy, binding)`).
- Because it is pure code, it can be tested with scenario tables and property-based tests (section 11).

#### Scheduler
- An event-driven loop. It wakes when an effect completes, when a timer comes due, when a CLI command arrives, or when a dependency finishes. There is no token-consuming polling; the only polling left is CI polling with `gh`, which costs 0 tokens.
- **Resource pools**: each step declares `uses: [claude]` or `uses: [codex, build]`. A pool has a capacity, e.g. `claude: 2, codex: 2, build: 1`. Projects declare extra pools for their own scarce resources (`emulator: 1`, `browser: 2`, `test_db: 1`…). The engine only counts slots and does not need to know what a pool is.
- **Rate-limit cooldown**: when an adapter classifies a result as `rate_limited`, that harness's pool is locked until `reset_at`. The task moves to `WAITING(rate_limit)` and a timer is set. It does not count as a failed retry.
- **Durable timers**: a table `timers(due_at, task_id, kind)`, e.g. the next CI poll or a stall check. Timers survive restarts.

#### Role/Model Policy
- *Role catalog* (global) + *Profile* (preset) + *override at task creation* → **FrozenPolicy** (fully resolved JSON + sha256 + commit hash of the config file), stored immutably in the task.
- Any later change is an event `PolicyAmended{actor: human}`. The engine rejects every binding outside the policy, and the task moves to `WAITING(policy)`.
- **Escalating a model midway** is only allowed along the *escalation ladder* already in FrozenPolicy: automatic rungs, rungs that need approval, or forbidden rungs (section 5.4).
- Details in section 5.

#### Agent Runner Adapters
Adapters are designed to be **pure and small**: they only build argv and parse output lines. Process management belongs to the shared runner shim.
```ts
interface HarnessAdapter {
  id: string;                                          // 'claude' | 'codex' | 'pi' | 'fake'
  build(req: AgentRequest): Invocation;                // argv, env, cwd, stdin
  resume?(sessionId: string, req: AgentRequest): Invocation;
  parseLine(line: string): NormalizedEvent | null;     // → started | text | tool | usage | session | result | error
  classify(exitCode: number | null, tail: NormalizedEvent[]): Outcome; // ok | failed | rate_limited | auth_error | timeout | crashed
}
```
- **Result contract via a file, not free text**: each prompt requires the agent to write `.cusr/out/result.json` according to the role's JSON schema (e.g. reviewer: `{verdict, findings[]}`). The orchestrator validates it with zod; on a wrong schema there is exactly one short "repair" attempt, after which it counts as `failed`. The file contract is independent of the harness. Harnesses that support structured output use it as a second layer of guarantee: Codex `--output-schema` and Claude Code `--json-schema` **[XM-docs]**.
- The adapter does only two things: build the command and parse the output. Process, timeout and retry live in the shared runner. Test adapters with *JSONL fixtures recorded from the real CLI* (section 11).

#### State Store (SQLite, WAL, `better-sqlite3`)
```sql
events    (id INTEGER PRIMARY KEY, task_id TEXT, seq INT, type TEXT, payload JSON, actor TEXT, created_at TEXT,
           UNIQUE(task_id, seq));
tasks     (id TEXT PRIMARY KEY, group_id TEXT, parent_id TEXT, spec JSON, title TEXT, workflow_id TEXT, workflow_hash TEXT,
           policy JSON, policy_hash TEXT, status TEXT, wait_reason TEXT, current_step TEXT,
           step_visits JSON, branch TEXT, worktree TEXT, base_sha TEXT, checkpoint_sha TEXT,
           pr_number INT, version INT);                 -- optimistic concurrency
task_deps (task_id TEXT, depends_on TEXT, PRIMARY KEY(task_id, depends_on));
attempts  (id TEXT PRIMARY KEY, task_id TEXT, step TEXT, n INT, role TEXT, harness TEXT, model TEXT,
           session_id TEXT, pid INT, pid_start_ticks INT, run_dir TEXT, log_offset INT,
           status TEXT, outcome TEXT, started_at TEXT, ended_at TEXT, usage JSON, cost_usd REAL);
effects   (id TEXT PRIMARY KEY, task_id TEXT, attempt_id TEXT, kind TEXT, idem_key TEXT UNIQUE,
           safety TEXT CHECK (safety IN ('pure','probe','unsafe')), status TEXT, request JSON,
           result JSON, tries INT, next_at TEXT);
questions (id TEXT PRIMARY KEY, task_id TEXT, attempt_id TEXT, body TEXT, channel_ref TEXT,
           status TEXT, answer TEXT, answered_by TEXT, answered_at TEXT);
artifacts (id TEXT PRIMARY KEY, task_id TEXT, attempt_id TEXT, kind TEXT, path TEXT, summary JSON);
timers    (id TEXT PRIMARY KEY, task_id TEXT, due_at TEXT, kind TEXT, payload JSON);
-- source_events, task_links, task_messages: see section 8.2
```
**Golden rule:** a trigger is processed in *one* transaction. That transaction appends events, updates the `tasks` projection, inserts the new `effects` (outbox) and timers. The effect executor reads the outbox only *after* the commit.

#### Event Log
- Structured events: `TaskCreated`, `PolicyFrozen`, `StepEntered`, `AttemptStarted`, `AttemptFinished`, `GatePassed/Failed`, `ReviewVerdict`, `QuestionAsked/Answered`, `EffectStarted/Succeeded/Failed`, `PrOpened`, `CiResult`, `ApprovalGranted`, `PolicyAmended`, `TaskCompleted/Failed/Cancelled`.
- Events are the source for `cusr task history T012`, for token reports, and for every "why" question, and reading them requires no LLM.

#### Recovery Manager
Runs every time `cusrd` starts, before the scheduler. The algorithm is in section 6.

#### Worktree Manager: one worktree per task

**Mandatory rules:**
1. **1 task = 1 worktree = 1 branch.**
   - The orchestrator (not the agent) creates it when the task starts, from the frozen `base_sha`.
   - Path: `~/.cusr/worktrees/<repo>/<task_id>`.
   - Branch: `cusr/<task_id>-<slug>`.
2. **All steps of the same task share that worktree and run sequentially:** coder, gate, fixer, reviewer, ci_fix.
   - Locked per worktree. Never two agents *writing* to the same worktree.
   - Reviewer and scout run in read-only mode.
3. **Two different tasks never share a worktree.** Parallelism only happens *between* tasks, each task in its own worktree.
4. **Agents are confined to their worktree:**
   - Check the cwd before spawning.
   - The harness sandbox allows writes only inside the worktree (Codex `workspace-write`; Claude uses deny rules for paths outside the worktree).
   - Compare the source repo's `git status` before and after each attempt. If the source repo changed, the attempt fails and raises an alarm.
5. **Do not use the harness's own worktree feature** (e.g. `claude --worktree`). The orchestrator must manage the worktree lifecycle itself so that recovery knows exactly which worktree belongs to which task.
6. **The `.cusr/` directory** (context, out) lives in the worktree but is excluded via `.git/info/exclude`, so it is never committed.
7. **The group's integration task** (if an integration branch is used, section 8.9) also gets its own worktree.

**Lifecycle and recovery:**
- **Creation is idempotent.** If the worktree already exists on the correct branch, it is reused.
- **On restart**, each worktree in the DB is reconciled against the disk: does it still exist, and does `HEAD` match `checkpoint_sha`? A missing worktree is recreated from the branch or the checkpoint.
- **Cleanup** after the task is DONE and the PR is merged (kept for N days, configurable). **Never delete** a worktree with uncommitted changes or unpushed commits; those are moved into `preserved/`. Run `git worktree prune` periodically.
- **Resources:** build/dependency caches shared across worktrees, depending on the toolchain (`~/.npm`, `~/.cache/pip`, `~/.cargo`, `~/.gradle`…). The project's `setup` command (e.g. `npm ci`) runs once when a worktree is created. The number of concurrent builds is limited by the scheduler's `build` pool. There is a disk-space cap for all worktrees; above the threshold, no new tasks are created.

#### GitHub Integration
- Uses the **`gh` CLI** through a port (`GitHubPort`) instead of Octokit. Reasons: it reuses existing auth, its `--json` output is stable, and it needs less code. It can be swapped for Octokit later without affecting the engine.
- Operations: `pr create` (with a marker), `pr checks`/`run list` (polling with backoff from 30s to 5 min), `run view --log-failed` (fetches failed CI logs for the CI Fixer), `pr merge` (only after an approval bound to the head SHA), and comments carrying the marker `<!-- cusr:<idem_key> -->`.
- Webhooks are postponed (they need a public endpoint, e.g. Tailscale Funnel). Polling CI with code costs no tokens, and for a single user the GitHub API quota is more than enough.

#### External Assistant Interface
- **The contract is the CLI with `--json`** plus a short `SKILL.md`/`AGENTS.md` file describing the commands. Every harness can read that file. It is also cheaper in tokens than MCP, because MCP tool schemas sit in the assistant's context on every turn. **[SL]**
- **MCP server** (stage 2) is a thin shell of about 10 tools that calls the same application services as the CLI.
- Queries return a **pre-computed summary** rather than raw logs: `cusr group status customer-management --json`, `cusr task explain T012 --json` (last error, last 40 lines of gate/CI log, latest review findings). The summary is built by code; no LLM is needed.
- **Three-level permissions** (per token or per channel):
  - `read`: status, logs, history.
  - `operate`: create tasks (tasks created by an agent need confirmation, section 8.3), retry, answer questions, cancel.
  - `admin`: edit policy, approve merge into `main` (when yolo is off), enable/disable yolo. This level must be confirmed by a real person via TTY, a Telegram approve button (matching your `chat_id`), or a GitHub approval.

---

## 4. Agent lifecycle

### 4.1 Comparison of mechanisms

| Mechanism | Pros | Cons | Conclusion |
|---|---|---|---|
| **Headless CLI subprocess** (`claude -p … stream-json`, `codex exec --json`, `pi --mode json/rpc`) | Most stable contract, reuses existing auth/subscription, structured output, a new session per step | Little mid-run control (steer) | **Chosen for v1** |
| tmux + send-keys | Humans can watch directly | Must scrape the terminal to know the state; fragile; hard to parse results | Only as an optional *viewer* |
| ACP (Agent Client Protocol) | General editor↔agent protocol; schema v1 is stable **[XM-docs, secondary source]** | Claude/Codex/Pi need a third-party bridge adapter. Designed for interactive sessions with permission prompts, not batch | Write the adapter later, when really needed |
| In-process SDK (Claude Agent SDK, Codex SDK, Pi's `AgentSession`) | Full hooks, approval and structured output | The agent shares the orchestrator's process, so a crash takes both down. SDKs change versions fast | Not used as the foundation. Can run *inside the runner shim* if specific features are needed |
| Codex app-server (JSON-RPC) | Richest option for Codex (thread, turn, steer, interrupt, approval) **[XM-docs]** | Codex only. Official docs recommend the Codex SDK for automated jobs/CI **[XM-docs]** | Not needed for v1 |

**What the repos chose** [XM-code, per analysis report]:

| Repo | Claude | Codex | Pi |
|---|---|---|---|
| Cezar | `--print`, stream-json in/out | app-server | `--mode rpc` |
| Paperclip | **ACP** by default (via `acpx`, `claude-agent-acp`), CLI as fallback | **ACP** by default (`codex-acp`), CLI as fallback | `--mode json -p` |
| Bernstein | `claude -p` stream-json | `codex exec --json` | |
| Agent Orchestrator, Firstmate | Interactive TUI in a PTY/tmux + hooks to learn the state | | |
| Symphony | | Codex app-server only | |

Conclusion: **headless stream/JSON is the common denominator**. TUI plus hooks is the source of the "wedge/stale wake" that needs LLM checking (Firstmate). ACP has actually been used as the default path in production (Paperclip), so an ACP adapter in a later stage is a well-founded choice, not a gamble.

### 4.2 Proposed design: *decoupled runner shim + file contract*

```text
run_dir = ~/.cusr/runs/<attempt_id>/
  invocation.json   # argv/env with secrets masked, harness, model, policy_hash
  pid               # pid + start_ticks (/proc/<pid>/stat field 22) to guard against PID reuse
  events.jsonl      # raw harness output (stdout), appended
  stderr.log
  liveness          # shim updates it periodically (e.g. every 15s), NOT dependent on agent output
  progress.json     # progress signals: new output, CPU time of the process tree, files changed in the worktree, running child processes
  exit.json         # {exit_code, signal, ended_at} – written by the shim when the harness ends
  out/result.json   # (in the worktree: .cusr/out/result.json) – the agent's schema-validated result
```

- `cusrd` spawns `cusr-runner <attempt_id>` with `detached: true` (`setsid`) and stdio pointing to files. The shim spawns the harness, forwards its output, writes `exit.json` atomically, then exits. The shim does only that job.
- `cusrd` tails `events.jsonl` from the saved `log_offset`, parses it through `adapter.parseLine`, and stores `session_id`/`usage` in `attempts`.
- **Three separate signals.** Missing logs do not mean the process has died: a large build or test suite can run for minutes without printing anything.
  - **Liveness**: the shim is alive and the child process still exists. The shim periodically updates the `liveness` file.
  - **Progress**: there is *any* sign of progress. It can be new output, growing CPU time across the whole process tree, files changing in the worktree, or child processes (compiler, test runner, build daemon) running and using CPU.
  - **Wall timeout**: the maximum total duration of the step.
- **Stall** means *no progress signal at all* within `stall_timeout`. `stall_timeout` is configured per step (e.g. 20 minutes for a step with a long build). On stall or on exceeding `wall_timeout`: `kill(-pgid, SIGTERM)`, wait 10 seconds, then `SIGKILL`. Lost liveness without `exit.json` means the attempt is `lost` (section 6), not a stall.
- **Live view:** `cusr task logs T012 -f` renders `events.jsonl` in a readable form. To watch the agent in a terminal multiplexer, set `runtime.terminal.backend` (`tmux`, `herdr`, `orca` or `paseo`): each `agent` operation is started from a background window of the backend, while the systemd unit still owns the lifecycle ([ADR-0006](adr/0006-terminal-view-backend.md)). With `tmux`, the window sits in the `cuesura` session of the user's running tmux server; view it with `tmux attach -t cuesura`.

### 4.3 Per harness

| Harness | Proposed command | Resume | Tokens | Confidence level |
|---|---|---|---|---|
| Claude Code | `claude -p "<prompt>" --output-format stream-json --verbose --model <alias> --session-id <uuid> --permission-mode acceptEdits\|dontAsk\|bypassPermissions --tools "Bash,Read,Edit,…" --disallowedTools "Bash(git push *)" --max-turns N --max-budget-usd X --json-schema <schema> --append-system-prompt-file role.md` | `--resume <id>` (add `--fork-session` if you want to branch) | usage/cost are in the final `result` message **[CKC: specific fields]** | All flags in the command column **[XM-docs, CLI reference 2026-10]**. `--json-schema` for structured output (print mode only). `--bare` skips hooks, skills, MCP and CLAUDE.md for faster startup and less context. But if you use `--bare` you must supply the conventions yourself, since the repo's CLAUDE.md will be ignored |
| Codex CLI | `codex exec --json --sandbox workspace-write --output-schema <file> -o <file> [model flag] "<prompt>"` | `codex exec resume <SESSION_ID>` | `turn.completed.usage` (input, cached, output, reasoning) | **[XM-docs]**. Note: the documentation currently says `--full-auto` *is no longer supported* and is replaced by `--approve-for-me`. This is a real example of CLI flags changing. The flag for choosing a model does not appear on that page; it needs **[CKC]** |
| Pi | `pi --mode rpc` (JSONL stdin/stdout: `prompt`, `abort`, `get_session_stats`; events `agent_start/agent_end`, `tool_execution_*`) or print/json mode for one-shot | `switch_session <file>`; `--session-dir` | `get_session_stats` has tokens and cost | **[XM-docs, npm mirror `@earendil-works/pi-coding-agent`]**. Lines must be split only on `\n` |

**Decision:** v1 uses adapters for Claude and Codex. Pi is for stage 2. Pi's RPC contract is clear, so its adapter is cheap, but to reach the reliability bar it still needs its own fixtures and fault tests.

### 4.4 Subscription and validity

- Anthropic's support page (updated 2026-10-07) says Pro/Max subscriptions can still use the Agent SDK, `claude -p`, and third-party applications within the plan's limits. Max/Team plans include a monthly API credit. The planned quota-separation change scheduled for 15/06/2026 has been *paused*. According to secondary sources, products or services distributed to other people must use an API key. **[XM-docs + secondary]**
- Codex `exec` reuses the CLI's saved auth by default, including ChatGPT sign-in. **[XM-docs]**
- **Architectural consequence:** personal tooling is valid *at present*, but this policy has changed twice in 2026. Therefore auth is per-harness configuration (`auth: subscription | api_key`), and the scheduler must handle rate limits as a normal state. **[SL]**
### 4.5 Questions from the agent midway
- v1: the agent writes `result.json` with `status: "needs_input"` and `questions: [...]`, then ends its turn. The task moves to `WAITING(human_input)`. When an answer arrives, the next step runs `resume(session_id)` with the prompt "Answer: …". If the harness cannot resume, a new session runs with the context packet plus the added Q&A.
- Stage 2: provide an MCP tool `orch_ask_human` to the agent. When the agent calls it, it receives "recorded, please end the turn", so the mechanism behind it does not change.

### 4.6 Environment
The orchestrator, worktrees and harnesses all run **on Linux** (native or WSL2/Ubuntu). With WSL2, put the repo and worktrees on the ext4 filesystem (`~/work/...`), not under `/mnt/c`, because build tools and git are much slower on `/mnt/c`. Native Windows is not supported: process groups, `setsid` and tmux are all POSIX features. macOS is postponed beyond v1, because there is no `/proc`, so the way pid/start time and env markers are read would have to change. **[SL]**

---

## 5. Workflow configuration and `when_use`

### 5.1 Splitting `when_use` into three clear mechanisms

| Condition type | Your example | Where it is handled | Who decides |
|---|---|---|---|
| Task attribute (data) | `task_type: implementation` | `binding.when` in the role, `when` in the step | Code |
| Workflow event | `event: code_completed`, `event: ci_failed` | **Workflow transition**, not placed in the role | Code |
| Judgment | `insufficient_context`, `complex_repository_analysis` | Turned into a **signal**: (a) the requester or a triage step flags the task, or (b) the running agent returns outcome `needs_context` | LLM, but *within a running step*, with no extra router call |

A text-form `when_use` is kept, but only so that **the AI planner or an external assistant can read it** when proposing a plan. Code never interprets it.

**How Firstmate actually does it** [XM-code/docs]: the equivalent mechanism is `config/crew-dispatch.json` with `rules: [{when, use: [{harness, model, effort}], why, approval, min_confidence}]` and a `default`. `when` is natural language, and **the Primary LLM itself matches** the rule ("shell scripts do not match the natural-language rules"). This is one of the places where tokens are burned. There is an option to send the brief to a cheap classifier (OpenRouter) with a `min_confidence` threshold.

**Keep that shape but move where it runs:**
1. Deterministic matching first, by `task_type`, `size` and `label`.
2. Only when a task is *created* and matches no rule, call a cheap classifier, **once**, with `min_confidence`. Below the threshold, it asks you.
3. The result is recorded in FrozenPolicy. It is never reclassified at each step.

### 5.2 Sample configuration

For readability, the example below merges everything into one file. In practice the configuration is split in two: the user's part in `~/.cusr/config.yaml` (harness, model, role, workflow, profile) and each repo's part in `cusr.yaml` (gates, setup, its own pools…). See section 5.2b.

```yaml
version: 1

harnesses:
  claude: { cmd: claude, auth: subscription, pool: claude }
  codex:  { cmd: codex,  auth: subscription, pool: codex }
  pi:     { cmd: pi,     auth: api_key,      pool: pi }

pools: { claude: 2, codex: 2, pi: 1, build: 1 }

models:              # alias → harness + real id + tier for policy comparison
  haiku:  { harness: claude, id: haiku,  tier: 1 }
  sonnet: { harness: claude, id: sonnet, tier: 2 }
  opus:   { harness: claude, id: opus,   tier: 3 }
  sol:    { harness: codex,  id: "<codex-model-id>", tier: 2 }

roles:
  coder:
    when_use: "Implement a task; bugfix."   # for the AI planner/assistant to read only
    prompt: prompts/coder.md
    context: [task_brief, attachment_excerpts, conventions, file_hints]   # task_brief is built from the standard task record
    output_schema: schemas/coder.json        # {status: done|needs_input|needs_context|blocked, summary, questions?}
    binding:                                  # deterministic selection: first matching rule wins
      - when: { size: [L, XL] }
        model: opus
      - model: sonnet
    limits: { max_turns: 80, stall_timeout: 10m, wall_timeout: 45m }
  reviewer:
    prompt: prompts/reviewer.md
    context: [task_brief, acceptance, diff, conventions]
    output_schema: schemas/review.json       # {verdict: approve|request_changes, findings: [{severity, file, line, msg}]}
    permissions: read_only
    binding: [{ model: sol }]
  fixer:
    prompt: prompts/fixer.md
    context: [findings_or_gate_log, diff_stat, task_brief]
    session: resume_from_step_role_if_same_harness    # reuse the coder's session if it is the same harness
    binding: [{ model: sonnet }]
  # No separate ci_fixer role: the ci_fix step reuses the coder role (resumes its session if same harness).
  # Split out a separate role only when there is a reason, e.g. wanting a cheaper model for lint/format errors.
  scout:
    prompt: prompts/scout.md
    output_schema: schemas/scout.json        # writes .cusr/context/scout.md for later steps to use
    permissions: read_only
    binding: [{ model: sol }]

gates:               # belongs to the project's cusr.yaml (section 5.2b); example for a TypeScript project
  build:      "npm run build"
  unit:       "npm test"
  lint:       "npm run lint"
  format_fix: "npm run format"   # self-fixing gate, used in the ci_autofix step

workflows:
  impl:
    base: software_dev@1
    steps:
      code:      { max_visits: 12, max_rung: 2 }
      fix_gates: { max_visits: 7 }
      gates:     { run: [build, unit, lint], required: [build, unit] }
      ci:        { poll: 60s, timeout: 60m }

profiles:
  standard:
    workflow: impl
    allow_roles: [scout, coder, reviewer, fixer]
    allow_models: [sonnet, sol, haiku]       # opus is not listed here → the size L/XL rule is rejected AT TASK CREATION and falls through to the next rule (sonnet)
    on_policy_violation: wait_human          # or fallback_to_default_binding
  heavy:
    extends: standard
    allow_models: [sonnet, sol, opus]
```

Design notes:
- **The conditional language is deliberately very limited.** It has only fixed predicates (`flag`, `size`, `label`, `task_type`, `attempt_gte`, `target_branch`), and no `eval`. A general expression language is the road to unverifiable workflows.
- **The graph lives in code, not in config.** An early design had users declare the whole graph (steps, `kind`, `next`, `on_exhausted`) in YAML. The daemon can run exactly one graph (any other graph is rejected by `structure_hash`), so the user config only chooses `base: software_dev@1` and tunes the parameters the daemon reads: `max_visits`, `max_rung`, the `run`/`required` lists of gates, and `poll`/`timeout` of CI. Old graph keys are rejected with `workflow_key_removed`; see the [upgrade guide](config-upgrade.md).
- **Outcome is a closed enum** for each `kind`. Code tests check the built-in graphs and each graph per mode: every outcome has a transition, and every loop passes through a step with `max_visits`. Property tests check that every valid set of parameters keeps `structure_hash` unchanged. This is how infinite loops are blocked *statically*. A new workflow is a new preset in code, with that test.
- `escalate` = `WAITING(human_input)` with an automatic summary. `retry` = a new attempt at the same step, with backoff, counted in `max_agent_runs`.

**Check bindings at task creation, not midway through the workflow.** When FrozenPolicy is resolved, every binding of every step is checked against `allow_models`:
- Valid binding: use it.
- Rejected binding: try the next rule in `binding` (the last rule acts as the fallback).
- No valid rule left: the task is **not created**. You are asked immediately (change the profile, allow that model, or choose another binding).

So once a task is READY, it is certain to run the whole workflow under its policy. `WAITING(policy)` midway only happens with escalation rungs that need approval.

### 5.2b Per-project configuration: the engine knows nothing about language or toolchain

Cuesura is used for every project, in any language. The engine, scheduler and policy contain no knowledge of languages or build tools. Everything specific to a repo lives in the `cusr.yaml` file at that repo's root:

| Item | Meaning | Example |
|---|---|---|
| `setup` | Command run when preparing a worktree; must be safe to re-run | `npm ci`, `uv sync`, `go mod download` |
| `tools` | Programs the project needs that gates do not call directly; names only, preflight checks the sandbox has them | `node`, `pnpm` |
| `gates` | Shell commands; exit 0 means pass | build, test, lint, typecheck |
| `autofix` | Gates that fix things themselves, no agent needed | `prettier --write`, `ruff format`, `cargo fmt` |
| `log_digest` | Rules that filter gate/CI logs into an error summary (section 7.1) | Regex keeping error lines, failing tests, the first stacktrace |
| `signature` | How the error signature is computed (section 5.4.1) | Name of the failing test, first error line normalized |
| `ci_rules` | Classify CI errors as `flaky_or_infra`, `autofix` or `code` | By job name, pattern in logs |
| `pools` | Scarce resources specific to the project | `emulator: 1`, `test_db: 1` |
| `hotspots` | Hotspot files that often cause conflicts (section 1.3) | Lockfiles, router, migrations |
| `conventions` | Convention files included in the context packet | `AGENTS.md`, `CONTRIBUTING.md` |

**Toolchain pack.** A preset in data form (YAML, not code) for common ecosystems (`node`, `python`, `go`, `rust`, `jvm`…). A pack supplies default values for `setup`, `log_digest`, `signature` and `ci_rules`. A project declares `extends: [node]` and then overrides whatever it needs. If no suitable pack exists, the generic digest is used: the last N lines of the log, plus lines containing `error`, `fail` or `exception`.

```yaml
# cusr.yaml at repo root
version: 1
extends: [node]                  # toolchain pack, optional
setup: "npm ci"
gates:
  build: "npm run build"
  unit:  "npm test"
  lint:  "npm run lint"
autofix:
  format_fix: "npm run format"
pools: { e2e_browser: 1 }
hotspots: [package.json, package-lock.json, src/routes.ts, "migrations/**"]
conventions: [AGENTS.md, docs/conventions.md]
profile: standard                # default profile for this repo's tasks
```

Rules:
- **Clear separation:** `~/.cusr/config.yaml` holds what belongs to *the user* (harness, model, role, workflow, profile, the harness pools). `cusr.yaml` holds what belongs to *the repo*.
- **Freezing:** `cusr.yaml` is read at `base_sha` when the task starts, and frozen into FrozenPolicy together with `workflow_hash`. An agent editing `cusr.yaml` on the task's branch does not affect the running task. A PR that changes `cusr.yaml` is flagged so that the reviewer and you can see it clearly (for example, a gate changed to `true`).
- **Dispatch rules:** there are two files with the same format (`version: 1`, `profile`, `rules`, `default`). `dispatch.yaml` next to `config.yaml` is shared by every project; `cusr.dispatch.yaml` at the repo root replaces that whole file for this repo, without merging rule by rule. If there is no `dispatch.yaml`, `cusrd` generates one at startup: no rules, a default of Opus 5.5 `medium` for coding and Sol 6.1 `high` for review. Model names and the profile come from the user config, and if the config cannot run these two models, nothing is generated. An existing file is never touched by `cusrd`. `cusr dispatch` reads the repo's file from `origin/<base_branch>` on the machine, without fetching. Both files can only select profiles, models and bindings that the user config has declared and the profile allows; a wrong file reports an error and does not fall back to the other file. `projects.<id>.dispatch` and `runtime.dispatch` are removed: old config still starts, but `cusrd` warns and ignores them. A repo cannot override other `runtime` keys.
- **Missing gate:** the workflow uses logical gate names (`build`, `unit`, `lint`). A gate the project does not declare is skipped, and that is recorded in FrozenPolicy so you know what the task was checked with. A project with no gates must have the profile explicitly allow it (`allow_no_gates: true`), because then only review remains as the line of defense.
- **New repo:** `cusr init` detects the manifest (`package.json` → `node` pack, `pyproject.toml` → `python`…), proposes a `cusr.yaml`, and you confirm before tasks are assigned to that repo. Currently `cusr init` only handles the PR part: a selection list with a `write-pr` item (the cusr PR template with the `write-pr` skill; if the repo already has a template, only the skill is installed). Manifest detection and the `cusr.yaml` proposal are not implemented yet.

### 5.3 Freezing policy and preventing self-modification
1. `cusr task create --profile standard --set roles.reviewer.binding=sol` → resolves to a **FrozenPolicy** containing the expanded workflow, the resolved bindings, `config_sha`, `workflow_hash`, and the `git rev-parse HEAD` of the config file. Writes a `PolicyFrozen` event.
2. The engine reads only the FrozenPolicy and **does not re-read the config file** for a running task. Editing `cusr.yaml` only affects new tasks.
3. Agents have no channel for changing the workflow. They only return an outcome from the enum. Free-form proposals (e.g. "should use Opus") are stored in `suggestions` for viewers; the engine does not execute them. If the policy enables `trust_agent_signal`, the `needs_stronger_model` signal can only trigger **the next rung of the approved ladder** (section 5.4).
4. An external assistant may *propose* a `PolicyAmendment`, but applying it requires `admin` (a person confirms). Every amendment is an event with `actor`, `reason` and `diff`.

### 5.4 Controlled model escalation (escalation ladder)

**"Frozen" applies to the *escalation ladder*, not to a single model.** The orchestrator may escalate, under five conditions:
1. Only along the rungs declared and resolved into FrozenPolicy when the task starts.
2. Only when the trigger is a **quality outcome** determined by code: gate fail, review reject, or the agent's signal if that is allowed.
3. Within the limit on the number of escalations and within the budget.
4. A rung above the tier threshold requires human approval.
5. Each escalation is an event with a reason.

Why it exists: repeated failure at the same step with the same model is usually the same kind of error. Stopping to ask a human every time would destroy automation. **[SL]**

**Escalation directions, from cheapest to most expensive.** The ladder should follow this order:

| Rung | Example | Reasonable when |
|---|---|---|
| 1. Increase effort/reasoning | sonnet medium → sonnet high | Logic errors, repeatedly failing tests |
| 2. Increase context | Add a scout step, include the full section of a reference document | The agent returns `needs_context`, or errors caused by misunderstanding the request |
| 3. Stronger model (same harness) | sonnet → opus | Rungs 1–2 do not help |
| 4. Change vendor ("second opinion") | Claude → Codex | Repeated errors of one kind. A different model has different blind spots |
| 5. Human | `WAITING(human_input)` with the failure dossier | Ladder exhausted |

```yaml
roles:
  coder:
    binding: [{ model: sonnet, effort: medium }]          # rung 0
    escalation:
      ladder:
        - { effort: high }                                 # rung 1: same model
        - { add_context: [scout_report, reference_full] }  # rung 2: raise context
        - { model: opus, effort: high }                    # rung 3: stronger model
      triggers:                                            # ONLY quality outcomes
        - { outcome: gate_failed,     after: 2 }           # 2 failures at the current rung
        - { outcome: review_rejected, after: 2 }
        - { outcome: agent_signal, signal: needs_stronger_model, after: 1 }  # only when trust_agent_signal
      scope: step                    # step: only raise the rung of this step | task: also push the task's floor up to this rung
      handoff: fresh_with_dossier    # fresh_with_dossier | resume (only sensible when only effort is raised)
      workspace: keep                # keep | reset_to_checkpoint

profiles:
  standard:
    allow_models: [haiku, sonnet, sol]
    escalation:
      enabled: true
      auto_up_to_tier: 2             # rung ≤ tier 2: automatic
      above: ask_human               # rung > tier 2 (e.g. opus): wait for approval | deny
      max_escalations_per_task: 2
      reserve_budget_usd: 5          # part of the budget reserved for escalation rungs
      trust_agent_signal: false
  heavy:
    extends: standard
    allow_models: [haiku, sonnet, sol, opus]
    escalation: { auto_up_to_tier: 3 }
```

#### 5.4.1 Default rung-change rule: what to do after how many failures

**Step 1: classify the failure.** Code does this. Only the `quality` and `invalid_output` classes count toward escalation.

| Failure class | Example | Handling | Escalates? |
|---|---|---|---|
| `rate_limited` | Subscription quota exhausted | Lock the harness pool until `reset_at`; the task moves to `WAITING(rate_limit)`. Does not count as an attempt | No |
| `infra` | Crash, network, `gh` 5xx, process killed | Retry at the same rung, exponential backoff, at most 3 times. When out of attempts, wait for a human | No |
| `auth_error` | Login session expired | Wait for a human immediately | No |
| `timeout` / `stall` | Over `wall_timeout`, or no output | Retry at the same rung once. A second occurrence usually means the task is too big, so it becomes a decision point "split the task / allow more time" (section 5.5) | No |
| `invalid_output` | `result.json` fails the schema | One reminder to fix it within the same session, then one run in a new session. Still wrong → escalate one rung | Yes |
| `quality` | Gate fail, review reject, CI fail caused by code | Follow the signature rules below | Yes |

**Step 2: signature rules for the `quality` class.**

Each failure has a *signature* computed by code, for example:
- Name of the failing test.
- First compile error line (normalized).
- File and type of review findings.

Handling by signature:
- **First failure at a rung:** re-run at the same rung, with the filtered error log.
- **Second failure with the same signature:** the agent is repeating the same error; continuing at the same rung is useless. **Escalate 1 rung immediately.**
- **Second failure with a different signature:** the agent is making progress (it fixed the old error and hit a new one). Allow **1 more** attempt at the same rung.
- **Each rung allows at most `quality_tries_per_rung` attempts** (default 5, user-configurable, no hard cap). Beyond that, escalate, even if the signatures differ.
- **Effort was increased but the signature did not change:** **jump directly** to the stronger-model rung, skipping the remaining same-model rungs.

**Step 3: default ladder per role.**

| Role | Rung 0 | Rung 1 | Rung 2 | Rung 3 | Ladder exhausted |
|---|---|---|---|---|---|
| coder / fixer (fix gates, review, CI) | sonnet, effort medium | sonnet, effort high | opus, effort high (*needs approval* in the `standard` profile) | Change vendor: codex, effort high, new session with the failure dossier | Decision point `loop_exhausted` (section 5.5) |
| reviewer | sol, effort medium | sol, effort high (only on `invalid_output`) | — | — | Drop review, wait for a human |
| scout | sol, effort medium | sol, effort high | — | — | Continue without the scout report |

Note: review *reject* is not a reviewer failure. It is a `quality` failure of the coder.

**Step 4: the rung is stored per step and never decreases.**

"No rung decrease within a task" and "a new step starts at rung 0" do not conflict, because the rung is tracked on **a separate ladder per step**, not on one shared rung for the whole task:
- **Each agent step within a task has its own ladder.** State is stored per `(task, step)` pair: `rung` (current rung), `tries_at_rung`, `last_signature`. Two different steps, e.g. `fix_gates` and `fix_review`, do not share a rung.
- **"No rung decrease" means that the `rung` of a `(task, step)` pair only increases or stays the same for the task's whole lifetime.**
  - A step running for the first time starts at the task's floor (default rung 0). This is not a decrease, because it is a different step's ladder.
  - If the workflow returns to a step that has already escalated (e.g. CI fails a second time and returns to `ci_fix`), that step continues at the rung it reached, not back at 0.
- **A `quality` failure is attributed to the agent step that most recently changed code** before the failing check (gate, review or CI). That step is considered "passed" when the next check passes. Then `tries_at_rung` and `last_signature` are reset, while `rung` is kept.
- **The task's floor (`floor`) also only increases.**
  - A task that had to escalate in 2 different steps is flagged `hard`, and the floor rises by 1.
  - With `scope: task`, every escalation at any step pushes the floor up to that rung.
  - Each run, the step uses rung `max(rung, floor)`.
- **Approval is tied to `(task, step, rung)`.** A rung already approved for a step does not need re-approval when returning to that step, but it still passes the budget check in Step 5. If the floor pulls a *different* step up to a rung that needs approval, that step still needs its own approval.
- **The runtime has no rung-decrease operation.** Lowering the default binding for *future* tasks is your job, based on `cusr report escalations` (the escalation rate and the rate of escalations that then pass).

**Step 5: checks before each escalation.**
1. The next rung exists in the frozen ladder.
2. `max_escalations_per_task` still has allowance.
3. The estimated cost of the rung (historical average token use of that step × price) does not exceed the remaining budget. If it does, it becomes an `escalation_approval` decision point.
4. Write event `EscalationApplied{from, to, failure_class, signature, attempt}`.

**Example trajectory of the `fix_gates` step**, with `max_visits: 7`; the loader checks that the total thresholds of the ladder fit within this limit:

```text
#1 sonnet/medium  → fail  test: CustomerRepoTest.search   (sig A)
#2 sonnet/medium  → fail  sig A (repeated)                  → escalate to rung 1
#3 sonnet/high    → fail  sig A                            → effort does not help, jump to rung 2
   opus/high needs approval → decision point escalation_approval (you approve)
#4 opus/high      → fail  compile error in another file (sig B, progressing) → allow 1 more
#5 opus/high      → pass  → fix_gates stays at rung 2: if the workflow returns to fix_gates, it continues at opus/high (already approved)
                            fix_review, ci_fix… use their own ladders, starting at rung 0 (task not flagged hard: only 1 step has had to escalate so far)
```

**Resolution at freeze time.** Each rung is assigned `auto`, `needs_approval` or `denied`, then saved in FrozenPolicy. `cusr task show T012 --policy` displays the resolved ladder, so you know in advance how far this task *can* go.

**Logic inside `decide` (pure):**
```text
each start_agent for step S uses rung max(rung[S], floor)          ← never lower
the check returns outcome o; S = the agent step that last changed code; r = rung S just ran:
  o ∈ {rate_limited, timeout, crashed, auth_error, infra_error}
      → handled as before (cooldown/retry); NOT counted toward the escalation trigger   ← fixed, not configurable
  o is a quality outcome → tries_at_rung[S] += 1, compare signature with last_signature[S]
  o is pass               → reset tries_at_rung[S], last_signature[S]; keep rung[S]
  trigger matches, rung r+1 exists, escalations < max, enough budget:
      r+1 = auto           → event EscalationApplied{from, to, trigger, evidence} → start_agent(binding r+1)
      r+1 = needs_approval → WAITING(approval), approval_kind=escalation + failure dossier + cost estimate
      r+1 = denied         → skip that rung, consider the next; no rungs left → wait for a human
  no match → normal workflow transition (still blocked by max_visits)
```

**Loop prevention.** The ladder is finite, and the number of tries per rung is finite, so the total number of attempts has a computable upper bound as soon as the config is loaded. The loader reports an error if a step's `max_visits` is smaller than the ladder's total threshold, because then the last rung could never be reached. Escalating a model **never implicitly extends** `max_visits`.

**Handoff on escalation.** The default is a new session with a *failure dossier* built by code: a summary of the previous attempts from `result.json`, the filtered gate/CI logs, the review findings, and the current diff. A stronger model sees the problem "clean", is not anchored to the previous wrong direction, and the context is smaller than when resuming. **[SL]**

**Approval and proposals.**
- Approve with `cusr task approve T012 --escalation [--scope task]`, or through the notification channel. Writes event `EscalationApproved{actor: human}`.
- External assistants may only *propose*: `cusr task escalate T012 --to opus --reason …`. A rung that is not `auto` turns the proposal into an approval request.

**Downgrading when a model is unavailable** is different from escalating.
- Default `on_unavailable: wait`: rate-limit cooldown, waiting until the model is available again.
- `fallback` to a lower model only when explicitly declared and within `allow_models`.
- No silent model downgrade (like Bernstein's `--fallback-model` or Paperclip's auto-fallback), because then results across runs can no longer be compared.

**When not to escalate:**
- Vague spec: the agent returns `needs_input` and a human must be asked.
- Flaky tests: re-run the gate before counting it as a failure.
- Merge conflict.
- Infrastructure error.

**Tuning with data.** `cusr report escalations` gives the escalation rate per role, the *rescue rate* (escalated and then passed), and the added cost.
- If a coder must escalate on more than 30% of tasks, change the default binding instead of leaving the runtime to guess forever.
- A low rescue rate usually means the cause is the requirement or the context, not the model. Move the context rung earlier.

**Observed anti-patterns** [XM-code, per analysis report]:
- Bernstein automatically escalates to opus/max on every retry where the model is not pinned, including errors unrelated to quality.
- Cezar lets agents choose models for subtasks.
### 5.5 Decision points

A **decision point** is a moment when the workflow cannot proceed on its own from data. For example:
- The agent asks a question (`needs_input`).
- The task lacks `acceptance` (`PENDING(needs_info)`).
- The requirement is edited while the task is running (`source_drift`).
- Escalating to a higher model rung needs approval.
- The escalation ladder or the round limit is exhausted (`escalate`).
- Merge.

Every decision point waits for you (`WAITING`): you answer through the task's channel, the answer is written to the event log and fed into the context of the next step. No agent decides on its own.

**Guardrails:**
- **Merging into `main` has exactly two modes, and neither lets an agent decide.** Here `main` means every branch in the repo's `protected_branches`, which by default is the default branch.

  | Mode | Who allows the merge | Applies when |
  |---|---|---|
  | `human` (default) | You approve **each PR**; the approval is bound to the head SHA | Yolo is off |
  | `auto` (yolo) | You allow it **in advance, once for the whole repo** by turning on yolo. Each merge is decided by **code** once every hard condition is met | Yolo is on |

  Yolo is **not** "the agent merges by itself": no LLM decides a merge. It is a standing approval that you grant yourself, enforced by deterministic checks. So yolo does not contradict the rules elsewhere that "merging into `main` needs human approval": a person is still the one granting permission, just in advance.
  - **Who turns it on:** only you, per repo, through `cusr repo yolo on <repo>` with a TTY confirmation, or through `~/.cusr/config.yaml`. **It cannot be turned on through `cusr.yaml` in the repo**, because an agent could edit that file on its branch. Agents and the assistant cannot turn it on. Every on/off change is an event with an actor.
  - **Not frozen per task:** yolo is a repo setting, not part of FrozenPolicy, and it is read *at merge time*. Turning yolo off takes effect immediately for every running task.
  - **Hard conditions, even with yolo:**
    - Required checks are green on a head that already contains the latest tip of `main` (the compare `head...target_tip_sha` returns `ahead_by === 0`).
      CI/observation always waits for the checks named by the policy and by the GitHub requirements in effect, including checks outside the policy and pinned apps, regardless of yolo or snapshot edits. The daemon verifies the exact app when it submits the merge. An empty set still goes to waiting for merge; yolo alone does not merge, and it logs guidance to set `ci.required_checks`. The `clean` condition can block yolo when a non-required check is red (SPEC.md §14.2).
      When a PR falls behind its target, the daemon re-queues its execution slot even when yolo is off, to integrate the base, run the gate, then publish and wait for CI on the new head. With no conflict, no new fixer or reviewer is called.
      The tip is read from GET branches/{target}, not from pull.base.sha; the compare uses that same tip SHA.
      A conflict gets exactly one fixer pass: every conflicting file must change; the host confirms that only conflicting files were edited, in which case a new review is not required (a `direct-pr` without a reviewer waits for a human). If the fixer does not finish, the gate fails, or the conflict recurs, open a question. The user fixes it by hand and answers `continue` to resume the gate, or answers exactly `retry fixer` to allow one more pass; the limit and the self-fix poll are not reset.
      A conflict with no markers where no file changed needs a human to confirm the choice. Markers are scanned only in conflicting files, not with `diff --check` across the whole base. The intent, head/tree/revision attestations, and the expected-old guard stay safe across retries and restarts; see SPEC.md §14.2.
    - With `full-review`, the reviewer has approved or there is an attestation of base-integration scope per SPEC.md §14.2; no unaddressed high-severity finding remains; `direct-pr` does not need a reviewer.
    - Merges are serialized.
    - No CI result is in an indeterminate state.
  - **If any condition is missing**, the task moves to `WAITING(approval)`, `approval_kind=merge`, exactly as in `human` mode. A GitHub branch protection rule that requires a human review also blocks self-merge in the same way.
  - Branch protection is optional and recommended as an extra layer enforced by GitHub. Without protection, GitHub does not block a target branch that has received new commits, or checks whose results change between reading and merging; the expected-head `sha` only blocks changes to the PR head.
  - **After merge:** if CI on `main` goes red, automatically create a revert PR and notify you. Never force-push automatically.
- **Merging into unprotected branches** (integration `group/*`, `feature/*`) happens automatically once hard conditions are met, per the `auto_when` of the `merge_gate` step. Yolo is not needed.

---

## 6. Persistence and recovery

### 6.1 Model: state machine in the DB + transactional outbox + probe-before-act

You do not need (and in v1 should not use) a replay-based durable-execution engine such as Temporal:
- Temporal needs its own server, and workflow code must be deterministic to replay. It is very much worth learning, but it is an operational burden for a personal tool. **[SL]**
- The TypeScript build of DBOS Transact stores state in Postgres. SQLite support currently exists only in the Go build. **[XM-docs, DBOS blog]**
- Each step of this workflow lasts minutes to hours, runs as an external process, and there are few steps. A *state table + outbox + reconcile* model is more transparent and sufficient. **[SL]**

To learn: read Temporal's concepts of *activity idempotency, heartbeat, durable timer, saga*, then implement those concepts yourself on SQLite. Keep `Effect` as an interface so it can later map to a Temporal activity or a Restate handler if needed.

### 6.2 Effect classes and duplicate prevention

| Effect | Safety class | Idempotency key | How to check before redoing after a crash |
|---|---|---|---|
| `run_gate` | pure | `task:step:visit` | Safe to re-run freely |
| `start_agent` | resumable | `attempt_id` | If `exit.json` exists, ingest the result. If the PID is alive and `start_ticks` matches, re-attach. Otherwise treat it as *lost* |
| `git_commit` (cusr commit after each step) | probe | trailer `Orch-Effect: <key>` | `git log --grep` on the trailer |
| `git_push` | probe | `branch@sha` | `git ls-remote origin <branch>` == sha |
| `create_pr` | probe | `head_branch` | `gh pr list --head <branch> --state all --json number` |
| `post_comment` | probe | marker `<!-- cusr:<key> -->` | search comments for the marker |
| `merge` | **unsafe + probe** | `pr#@head_sha` | `gh pr view --json state,mergeCommit`. The approval **is bound to the head SHA**: if the SHA changes, the approval is void. When uncertain, move to `WAITING(approval)`; do not guess |
| `delete_worktree/branch` | probe | — | check whether it exists |

**Three-phase protocol for an effect:**
1. Write `effects.status = 'started'` (commit).
2. Perform the external call.
3. Write `succeeded/failed` together with the result, and trigger the engine, in one transaction.

Crash between 1 and 2: the probe sees nothing, so redo. Crash between 2 and 3: the probe sees the result, so write `succeeded`. The system is *at-least-once*, but every harmful effect becomes *effectively-once* thanks to the probe.

### 6.3 Git checkpoints
- Before each agent step, record `checkpoint_sha = HEAD`. After each successful agent step, the **orchestrator** (not the agent) commits: `cusr(T012/code#1): …` with the trailer. Every step boundary is therefore a commit you can return to.
- An attempt is *lost* when the process died and there is no `exit.json`. Policy by role:
  - `coder`/`fixer`: if there is a `session_id`, resume once with the prompt "you were interrupted; check `git status` and continue". If that fails, run `git reset --hard checkpoint && git clean -fd` and run a new attempt.
  - `reviewer`/`scout`: always re-run. The scout is read-only; the reviewer's changes are rolled back to the mark recorded before the run.

### 6.4 Startup algorithm (Recovery Manager)
```text
1. Take the single-instance lock (flock ~/.cusr/cusrd.lock). If it fails, exit: another daemon is running.
2. Open SQLite (WAL). Run migrations. Check integrity (PRAGMA quick_check).
3. For each attempt with status=running:
     exit.json present   → ingest the remaining output from log_offset → create trigger effect_result
     pid alive & ticks match → re-attach (keep tailing)
     otherwise           → outcome=lost → trigger per policy (resume | reset+rerun)
4. For each effect with status=started (not an agent): run the matching probe → succeeded | back to pending
5. For each timer with due_at <= now: emit trigger timer
6. For each task in RUNNING with no open attempt/effect: "orphan step" → re-emit the command of current_step
   (safe because every command goes through the outbox with an idem_key)
7. Write event RecoveryCompleted{summary} → `cusr status` shows what was recovered
```

### 6.5 Three small but decisive details (learned from other repos)
1. **Env marker on every child process**: the runner sets `CUSR_ATTEMPT_ID=<id>` in the harness environment. On startup, it scans `/proc/*/environ` to find orphaned processes even when the `pid` file is lost. Cezar does exactly this with `CEZ_TASK_ID`.
2. **Ownership by boot-id**: each start of `cusrd` generates a `boot_id`, and attempts record `owner_boot_id`. An attempt whose PID is alive but belongs to an old boot is handled as *re-adopt*, not respawned. Paperclip uses a boot-id plus a lease for this.
3. **"Probe failed" does not mean "process is dead"**: if `/proc` cannot be read, or `gh` fails because of a network error, only defer; do not mark the attempt `lost`. Add a circuit breaker: if more than 50% of attempts are judged dead at the same time, stop and notify you. Agent Orchestrator has this mechanism.

### 6.6 Running as a service
A `systemd --user` unit (`cusrd.service`, `Restart=on-failure`) in WSL2. If WSL has systemd enabled, use it; otherwise use `tmux new -d cusrd`. Both are fine, because recovery does not depend on how the daemon was started. **[CKC: systemd in your WSL build]**

### 6.7 Durability details (required for v1)
- **SQLite**:
  - Configuration: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout`, one writer. `synchronous=FULL` keeps commits durable across power loss; writes are infrequent, so the cost is negligible.
  - Run `PRAGMA quick_check` at startup.
  - Back up with the online backup API or `VACUUM INTO`: periodically, and before every migration.
  - Migrations run inside a transaction and are tested first on a copy of the real DB.
- **Runner files**:
  - `exit.json`, `result.json`, and `pid` are written in the order tmp → fsync → rename → fsync the directory.
  - When reading `events.jsonl`, skip an incomplete last line (no `\n`) and re-read it when more data arrives. Save `log_offset` after each ingest.
- **Every external call** has a timeout, bounded retries with jitter, and error classification `transient | permanent | unknown`. An `unknown` error on a dangerous effect moves the task to `WAITING(human_input)`; it is not guessed.
- **Time**:
  - Timeouts and stalls are measured with a monotonic clock.
  - Timer deadlines are stored in system time and must survive clock jumps. WSL2 can drift after the machine sleeps. **[SL]**
- **Resources**:
  - On disk full (`ENOSPC`), stop scheduling and move to `WAITING(infra)`.
  - Cap the log size per attempt and rotate logs.
- **Watchdog**:
  - An internal check loop.
  - `cusr status --health` returns a non-zero exit code when a task is stuck or the daemon has stopped writing heartbeats.
  - systemd `Restart=always`.
- **Safe upgrades**:
  - Running tasks are bound to the frozen `workflow_hash` and `policy_hash`.
  - When upgrading `cusr`, check event-schema compatibility before continuing. If incompatible, refuse to start rather than run incorrectly.
- **Safe defaults**:
  - Agents have no push or merge permission: the harness's deny rules enforce this, and only the orchestrator pushes.
  - Merging into `main` needs per-PR human approval, unless you yourself turn on yolo for that repo (section 5.5). Agents never decide merges.
  - Check that the agent's cwd is inside its worktree.
  - Orchestrator secrets (for example, the GitHub token) are not passed into the agent's environment.

---

## 7. Token optimization

### 7.1 Mechanisms

1. **Zero tokens for orchestration**: every transition is code. This is the biggest saving compared with Firstmate. In Firstmate, each "actionable" wake is a turn in the Primary's long conversation, and the `AGENTS.md` contract (about 7.3k words) plus about 1.1k words of skill descriptions always sit in context. The Primary must also match dispatch rules, check panes for being "wedged", and periodically review the whole team. With Codex, the Primary is woken every 180 seconds to check, even when no event has happened **[XM-code/docs, per the analysis report]**.
2. **A new session for each step** by default. Resume only inside a short fix loop, with the same harness and a `max_visits` limit, to benefit from the prompt cache without unbounded context growth.
3. **Role-based context packets, delivered as *files* rather than stuffed into the prompt**: the orchestrator writes `.cusr/context/*.md` in the worktree, and the prompt only lists the paths and descriptions. The agent reads the parts it needs (lazy loading).

   | Role | Packet contents | Trimmed by code |
   |---|---|---|
   | coder | task brief built from the canonical task record (a few hundred words), excerpts selected by `attachments`, conventions, file hints | Extract sections by anchor; do not include the whole source document |
   | reviewer | brief + acceptance criteria + `git diff base...HEAD` | A diff over N lines: only `--stat` with the file list, and the agent reads files itself |
   | fixer (after review) | findings JSON + diff stat | Drop `severity: nit` findings if the policy allows |
   | fixer (after gate) | one summary of the gate error | The project's `log_digest` or the toolchain pack (section 5.2b): keep only error lines, failing tests, and the first stack trace |
   | ci_fixer | excerpt of the CI error log (`gh run view --log-failed` → filtered) | As above, plus a 200-line limit |
4. **Deterministic preprocessing before calling an LLM**: many CI failures are fixed-pattern errors (format lint, dependency resolution, flaky network). Code rules (`ci_rules` of the project) can fix them automatically through the `autofix` gate (for example, a formatter) or retry them, with no agent needed. **[SL]**
5. **Skip steps by size**: `skip_when: {size: [XS]}` for review, because the gates are already enough for very small tasks.
6. **Stable prompt order**: the role prompt and conventions go first, and the task-specific part goes last, to maximize the harness's prompt cache. **[SL]**
7. **Hard limits**: `max_turns`, `wall_timeout`, `max_agent_runs`, `max_cost_usd` per task.
8. **Token ledger**: store `usage` per attempt, including Claude `result`, Codex `turn.completed.usage` **[XM-docs]**, and Pi `get_session_stats` **[XM-docs]**. Command: `cusr report tokens --feature F003 --by role,model,step`.

### 7.2 Metrics (used to evaluate the project in section 12)
The goal is to optimize the **total cost to finish one accepted task**, not only tokens. All metrics are computed by code from the event log, without an LLM, and exported with `cusr report metrics [--group X] [--since 30d] --json`.

**Units:**
- **Accepted task**: a task whose PR has been merged and is *not reverted or reopened* within 14 days.
- **Group (`group`)**: the sum of the tasks in the group, plus the integration task if there is one.

| Metric | Definition | What it reveals |
|---|---|---|
| **Tokens / accepted task** | Total tokens of all attempts, including failed attempts and the refiner, divided by the number of accepted tasks. Split by role and harness | Actual total consumption |
| **Agent runs / task** | Number of agent invocations per accepted task | The workflow calls agents too often |
| **Wasted runs** | Attempts that contribute nothing to the final result: failed and discarded, reset to a checkpoint, output with the wrong schema, killed for a stall. Counted as a rate and by tokens | Waste; the top reason to fix |
| **Time to green** | From READY until CI first turns green; waiting for humans and waiting for rate limits are reported separately | Speed, and where the bottleneck is |
| **Human interventions / task** | Number of times you must answer, approve, or fix by hand; split by decision-point type | Level of autonomy |
| **First-pass rate** | Share that passes the gate, review, and CI on the first try, per step | Quality of the coder's output |
| **Context size / attempt** | Input tokens of an attempt, p50 and p95 per role, and the trend by attempt number within one task | Context bloat |
| **Recovery success rate** | Share of crashes or restarts where the task recovers correctly with no duplicated side effects | Reliability in real operation; complements the Reliability Gate |
| **Rate-limit wait** | Total time and count of waits for plan quota, per harness | Whether subscription limits are a bottleneck |
| **Escalation / rescue rate** | Share of tasks that had to escalate a rung, and the share that passed after escalating (section 5.4) | Whether the default binding should change |
| **Escaped defects** | Merged tasks that are reverted, reopened, or spawn a related bugfix task within 14 days | Post-merge quality: what CI and review missed |

`coordination tokens` (tokens used for orchestration) are always 0 by design, because there is no Primary. If it is not 0, that is a bug. Tokens you spend when asking the external assistant are measured separately.

**Baseline:** run *the same small group of tasks* with Firstmate and with `cusr`, then compare them using the table above. At minimum, compare tokens / accepted task, agent runs, time to green, and human interventions. Without a baseline, there is no proof that the project saves anything.

---

## 8. Task sources and the standard task format in the database

**Principles:**
- A task is work *that the user assigns*, through any channel: GitHub, a form, an agent/assistant, or the CLI. The orchestrator does not care what tool or method was used to write the task.
- Each channel is a **source connector**. The connector receives the request, **normalizes it into a single task format in SQLite**, and (optionally) syncs status back to that channel.
- The scheduler takes READY tasks from the DB and hands them to agents. An agent receives only a **task brief** built from the DB record. It does not read the source channel and does not know what the source is.

### 8.1 Overall flow

```text
 GitHub issue/comment ─┐
 Form (HTTP)           ├─► source connector ─► source_events (raw inbox, dedup) ─► normalize ─► validate + triage
 Agent / assistant     │     (poll or push)                                                        │
 CLI                  ─┘                                                                           ▼
                                                        tasks (standard format) ──PENDING(needs_info)──► ask again via the same channel
                                                                 │ READY
                                                                 ▼
                                                Scheduler ─► context compiler ─► agent (task_brief.md)
                                                                 │
                                         status, questions, results ─► outbox ─► sync back to the source channel
```

### 8.2 Standard task format: one schema for every source

```yaml
schema_version: 1
id: T-0142                                 # internal orchestrator id
title: "Customer search"
type: implementation                       # implementation | bugfix | refactor | test | docs | research | epic
repo: github.com/you/app
base_branch: main
description: |                             # free-form description from the requester (markdown)
  Users need to view and search customers…
requirements:                              # may be empty on intake; filled in during triage
  - "Return customers matching the keyword, sorted by name"
acceptance:                                # required before READY (section 8.4)
  - "Has tests for: keyword filtering, empty results, data source errors"
constraints: ["Follow the repo's existing conventions"]
out_of_scope: ["Pagination"]
attachments:                               # links or paths to documents/images; only point to them, do not copy
  - { kind: path, value: docs/customer.md, anchor: "#search" }
  - { kind: url,  value: "https://…/design.png" }
group: customer-management                 # optional: group/feature/epic, for progress queries
parent: null                               # parent task, if this is a subtask of an epic
depends_on: [T-0141]
priority: normal
size: M                                    # set by the requester, or estimated by triage
labels: [search]
profile: standard
requested_by: { actor: you, channel: github }
```

Related tables in SQLite:
```sql
source_events (id INTEGER PRIMARY KEY, source TEXT, external_id TEXT, dedup_key TEXT UNIQUE,
               payload JSON, received_at TEXT, processed_at TEXT, result TEXT);   -- raw inbox, kept for traceability
task_links    (task_id TEXT, source TEXT, external_id TEXT, external_url TEXT,
               external_version TEXT, sync_state TEXT, last_synced_at TEXT,
               PRIMARY KEY (source, external_id));                                -- task ↔ item in the source channel
task_messages (id TEXT PRIMARY KEY, task_id TEXT, direction TEXT, channel TEXT, kind TEXT,
               body TEXT, external_ref TEXT, created_at TEXT);                    -- questions/answers, notifications, all channels
```

Rules:
- The standard format has **no source-specific fields**. Source information (issue number, form id, agent name) lives in `task_links` and `requested_by`, and it **never enters** an agent's prompt.
- `attachments` only point to documents *inside the task record*. The actual content is captured when the task starts (see FrozenExecutionContext below).
- **FrozenExecutionContext.** When a task starts running, at the same time as FrozenPolicy, the orchestrator stores these immutable items:
  - A snapshot of the task's request content.
  - A copy (or excerpt) and a hash of each attachment.
  - A hash of the prompt version for each role.
  - The repo's `base_sha`.

  Each attempt also records the actual model, the harness version, and the CLI flags used. **Every attempt of the same revision reads the same input.** So when something fails, you know whether it was the model or the requirement that changed.
- **If the source changes, a new revision is created**, with an audit trail (`TaskRevised{from, to, diff, actor}`). Input is never silently swapped between attempts. A revision change is a decision point (`source_drift`, section 5.5): continue on the old revision, or restart from the checkpoint with the new revision.
### 8.3 Source connector

```ts
interface SourceConnector {
  kind: string;                                        // 'cli' | 'agent' | 'github' | 'form' | …
  mode: 'pull' | 'push';                               // periodic poll or push-in
  poll?(cursor: string | null): Promise<{ events: RawEvent[]; cursor: string }>;
  authorize(e: RawEvent): Trust;                       // who may assign tasks through this channel
  normalize(e: RawEvent): NormalizedRequest | Ignored; // deterministic mapping, no LLM
  syncBack?(task: TaskView, change: StatusChange): Effect; // goes through the outbox, idempotent
}
```

| Source | How it arrives | Mapping to the standard format | Sync back | v1? |
|---|---|---|---|---|
| **CLI** | `cusr task add -f task.yaml`, or command-line flags | Direct, since it is already the standard format | Printed to the terminal | ✔ |
| **Agent / assistant** | The same CLI command with `--json` (later, an MCP tool `task_create`) | Direct. `requested_by.actor` = the agent's name | The assistant queries `cusr task show` itself | ✔ |
| **GitHub** | Poll issues labeled `cusr` with `gh api` (using `since` + ETag). Commands in comments: `/cusr run`, `/cusr answer …`, `/cusr approve`, `/cusr cancel` | Title → `title`. Body → `description`. `## Acceptance` / `## Requirements` sections, if present → the corresponding arrays. Labels `type:*`, `size:*`, `profile:*` → the corresponding fields. "blocked by #12" → `depends_on` | A comment with a marker for each status change. Labels `cusr:running/waiting/done`. A PR with `Closes #N`. The agent's questions are posted as comments | ✔ |
| **Form** | A small form page served by `cusrd` over Tailscale, using the same token-protected endpoint `POST /api/tasks` | Form fields = standard fields | The task's status page; notifications via the chosen channel | Phase 2 (needs an HTTP server) |
| Later | Slack/Telegram, email, Linear/Jira, scheduled jobs, "CI on `main` red → create a bugfix task" | Same interface | Per channel | As needed |

Notes per source:
- **Tasks created by an agent carry a cost risk**, because one agent can create a large batch of work.
  - By default, tasks created by an agent stay in `PENDING(confirmation)` until you run `cusr task confirm`.
  - Intake auto-confirm can be configured per agent: `intake.auto_confirm: [assistant]` in the user config (not per profile). Such a task still needs its run configuration confirmed before spawn.
  - There is a daily limit on the number of tasks each agent may create.
- **GitHub is the natural Q&A channel from your phone.** An agent's question becomes a comment on the issue, and you answer with `/cusr answer …` right in the GitHub app. Tasks created from the CLI or an agent can also be linked to an issue to use this channel.
- **The form is only needed once there is an HTTP API** (phase 2). Until then, from your phone you assign work with a GitHub issue, or ask the assistant in Paseo to run `cusr task add`.

### 8.4 Triage: from raw request to ready task

Triage is determined by code, not by the Primary AI. Raw events live in `source_events`. Once normalized into a task, the task always starts at `PENDING`, and only `wait_reason` changes through the triage steps: `PENDING(confirmation)` (only for agent-created tasks) → `PENDING(needs_info)` ⇄ … → `PENDING(dependency)` → `READY`.

1. **Validate (code).**
   - The schema is valid.
   - `repo` is in the allowed list.
   - The requester is allowed to use that `profile`.
   - `depends_on` entries exist and form no cycle.
2. **Check completeness (code).** The task must have `acceptance` with at least one verifiable criterion. If it is missing:
   - Default: move to `PENDING(needs_info)` and ask the requester **through the same channel** they used (GitHub comment, form notification, CLI).
   - Optional per profile: call the `refiner` role **once** to propose `requirements` and `acceptance` from `description`. The proposal is sent back for the requester to confirm, unless the profile allows `auto_accept`.
3. **Large task (`type: epic`).** The `planner` role runs once and proposes subtasks with `depends_on`. Subtasks are created only after you confirm. Work is never split implicitly.
4. **READY** when the conditions are met and every task in `depends_on` is DONE.

### 8.5 How agents receive tasks
- **Agents do not poll for tasks themselves.** The scheduler (code) picks READY tasks by priority, dependencies, and resource pool, then hands them to the agent through the runner. If agents polled and chose work on their own, the LLM would re-enter the orchestration loop and spend tokens.
- **The agent receives `task_brief.md`**, built from the canonical record: `title`, `description`, `requirements`, `acceptance`, `constraints`, `out_of_scope`, excerpts from `attachments`, and earlier Q&A turns in `task_messages`. The brief contains no issue number, channel name, or source-specific syntax.
- **The reviewer checks against `acceptance`.** The PR description (for example, `Closes #N`) is written by the orchestrator from `task_links`, not by the agent.

### 8.6 Two-way sync without conflicts
- **The DB is the source of truth for execution state.** Source channels are only notified, through an outbox with idempotency keys and markers (the same mechanism as the other effects, section 6).
- **The source channel is the source of truth for request content, but only until the task starts running.**
  - An issue edited before the task runs: update the record.
  - An issue edited after the task has started: the running snapshot does not change. Flag `source_drift` and ask you whether to continue, re-run with the new requirement, or create a new task.
- **Cancellation at the source** (closing the issue) creates a cancel request for the task. A running task stops safely at a step boundary.
- **Dedup.** Each source event has a `dedup_key`, for example `github:issue:123:<updated_at>`. Repeated polls, or a webhook delivered twice, do not create duplicate tasks.
- **Do not trust content from strangers.** Issue content goes straight into the agent's prompt, so someone else's issue is a path for prompt injection. Therefore the GitHub connector accepts issues and comments only from allowed accounts; by default, only you.

### 8.6b Where questions and notifications go

**Principle:** separate *the person who assigns the work* from *the communication channel*.
- The agent that you gave a task to is often **no longer running** when a question arises: its session has ended, and it has no address to receive pushed messages. So the agent is a *client*, not a communication channel.
- Questions are always stored in the DB (`task_messages`), then sent through your communication channel. Answers can be received from **any channel** and are written to the same place.

**Routing:**

| Task came from | Questions are sent to |
|---|---|
| GitHub issue | A comment on that same issue, plus a short push notification through the default channel |
| Agent, CLI, form | **Your default channel** |

In addition, every question appears in `cusr inbox`. When you reopen the agent (for example, in Paseo) and ask "is anything waiting for me?", the agent runs `cusr inbox --json` and helps you answer with `cusr answer`.

To see everything that got done in a day, run `cusr report` (default: the last 24 hours; `--since 8h`, `--project <id>`). By project, the report lists finished tasks with their PR, reason, and usage; tasks waiting on you with open questions; running tasks; and the decider's auto-answered decisions. The report is built by code from the event log, without calling a model.

**Choosing the default channel:**

| Channel | Pros | Cons | Suggestion |
|---|---|---|---|
| **Telegram bot** | True two-way: you *reply* to a message to answer it. Good push notifications on iPhone, buttons to approve/reject, free, easy to set up | Adds an external service. Accepts commands only from your `chat_id` | **Default channel for v1** |
| GitHub comment | Durable, threaded, tied to the code, has a mobile app | Noisy; a public repo exposes the content; tasks without an issue cannot use it | Use for tasks that come from issues |
| ntfy (self-hostable) | Simple, good push notifications | Mostly one-way; hard to answer with free-form text | Only for notifications, not Q&A |
| Slack / Discord | Familiar if you already use them | Heavier for a single user | A later phase |

**Each outgoing question contains:** the question ID, the task, the content, the options (if any), and how to answer. Answers go through dedup and permission checks, like every source event (section 8.6). When a question is answered on one channel, the other channels are updated to "answered", so it is not answered twice.

### 8.7 Branch strategy when tasks depend on each other
- **Independent tasks:** each task gets its own branch cut from `base_branch`, and opens one PR into `base_branch`.
- **Groups of dependent tasks** (the same `group` or the same `parent`): a single **integration branch** `group/<name>` cut from `main` may be used.
  - Each task opens a PR into the integration branch.
  - A dependent task starts only after its parent has merged into the integration branch.
  - Merging into the integration branch is automatic once CI and review are green (`auto_when: target_branch: group/*`).
  - **The PR from the integration branch into `main` follows the rules for merging into `main` (section 5.5):** you approve it, or it merges automatically if the repo has yolo on.
- **Before pushing**, rebase onto the latest base. If there is a conflict, call `fixer` with the list of conflicting files (`max_visits: 1`). If it still conflicts, wait for a human.

### 8.8 Safe merge: never merge on stale CI (required before enabling auto-merge)

**Race condition to prevent:**
1. Task A and task B are both cut from the integration branch at commit X, and both have green CI.
2. A is merged, so the integration branch advances to commit Y.
3. B is merged based on CI results from commit X. So B was never tested together with A's changes.

**Rules:**
1. **Merges are serialized per target branch.** Each target branch has a merge queue in the DB, processing one PR at a time.
2. **Re-check right before merging.** The head SHA must match the SHA that was approved. Green CI must have run on a head *that already contains the current tip of the base*, that is, `git merge-base --is-ancestor <base_tip> <head>`.
3. **Base changed:** update the branch (rebase, or merge the base in), re-run the local gate and CI, and then return to the queue. This reuses the bounded `ci`/`ci_fix` loop.
4. **CI result is indeterminate** (pending past its deadline, cancelled, or a required check missing): do not merge; the task moves to `WAITING`.
5. **Extra guardrail on GitHub:** enable branch protection with required checks and "require branches to be up to date before merging" for `main` and for the integration branches. If the orchestrator has a bug, GitHub still blocks the merge.
6. **v1:** only one PR merges into each target branch at a time. Parallel merges or the GitHub merge queue come later.

### 8.9 Completing a task group (group/epic)

All child tasks being DONE does **not** mean the group works correctly. The data layer, business logic, UI/API, routing, and dependency wiring can each be fine on their own and still break when combined. So a group (`group`/`parent`) has its own **integration task**, which the orchestrator creates when the last child task becomes DONE. The integration task has:
- **Group-level `acceptance`**: taken from the parent task (the epic), or declared by you when the group is created. If it is missing, move to `PENDING(needs_info)`, like any other task.
- **The `integrate` workflow:**
  1. Sync the integration branch with `main`.
  2. Run the project's full gate: build, unit tests, lint, and integration/E2E tests if the project declares them.
  3. **Overall review** of the entire diff `main...group/<name>` against the group-level `acceptance`. For a large diff, the reviewer receives the list of files and reads them itself.
  4. Any failure at these steps creates a new fix task within the group, with limits.
  5. Open a PR from the integration branch into `main`.
  6. Wait for CI per rule 8.8.
  7. **Merge per the rules for merging into `main`** (section 5.5): you approve it, or it merges automatically when the repo has yolo on. It is never decided by an agent.
- **The group is DONE** only when the PR into `main` has merged. Until then, `cusr group status` shows clearly which child tasks are finished and which step the integration task is at.

---

## 9. Version 1: reliable from the start

**No line-count limit.** The v1 yardstick is the **Reliability Gate** (section 9.1), not code size. When needed, what gets adjusted is the *feature scope and time*, never reliability.

A frank note: reliability comes from **thoroughly verified surface area**, not from having more code. Therefore:
- Every feature that goes into v1 must come with its fault test.
- Breadth features are deferred until after v1.

### 9.1 Defining "reliable": Reliability Gate

v1 may be used on a real repo only when it meets **all** of the criteria below. All of them are measured automatically and can be re-run with a single command, for example `pnpm test:reliability`.

| # | Property | Measurable criterion |
|---|---|---|
| R1 | No state loss | Chaos run: `kill -9` cusrd at ≥ 200 random moments. Every task recovers at the correct step. `verify-projections` matches 100% |
| R2 | No repeated side effects | Crash × every effect type matrix (commit, push, PR, comment, merge): 0 duplicates. Fake git/GitHub count the calls |
| R3 | No silent hang | Every task reaches a terminal state, or `WAITING` with a `wait_reason`, within the time limit. The watchdog detects a `RUNNING` task with no heartbeat |
| R4 | No policy violation | Property test over ≥ 10,000 random trigger sequences, 0 violations: a model outside the ladder, exceeding `max_visits`, exceeding the budget, an approval-gated rung running without approval |
| R5 | No process leaks | After every timeout/cancel/crash scenario: 0 processes carrying `CUSR_ATTEMPT_ID` remain alive unintentionally |
| R6 | Tolerates bad input and environment | For: corrupted or truncated harness output, JSON with the wrong schema, a torn last log line, `gh` network errors or rate limits, disk full, SQLite busy, clock jumps. Requirement: correct classification, the daemon does not crash, no wrong state transitions |
| R7 | Durable over time | An 8–12 hour soak with fake agents (≥ 50 tasks, 20% random errors): no memory or file-descriptor leaks, no stuck tasks |
| R8 | Works with real harnesses | Each adapter (Claude, Codex) runs one task end-to-end on a sandbox repo, with one kill of the daemon midway; the result is correct |
| R9 | Operable | Backup/restore test succeeds. Migrations are tested on a copy of the DB. `cusr doctor` detects a harness with the wrong version or wrong flags |

### 9.2 v1 plan: about 4 weeks (20 working days)

The premise is unchanged: 1 developer, with AI assistance, about 6 focused hours per day. **With the standard above, 14 days is not enough if the scope stays the same.** I recommend 4 weeks, with checkpoints:

| Phase | Day | Items | "Done" milestone |
|---|---|---|---|
| **Week 1: foundation** | 1 | Harness spike: record real JSONL fixtures (success, error, rate limit, asking a human, truncated output), and check the `result.json` contract | A verified table of CLI flags. Fixtures exist for R6 |
| | 2 | `SPEC.md` following the Symphony framework (entities, state machine, retry/reconcile semantics, runner contract, effect table) + zod schemas for the standard task / workflow / policy + a static-check loader | A broken workflow is rejected at load time |
| | 3 | Pure `decide`/`evolve` + policy guard + escalation ladder | The state-transition table is covered 100% |
| | 4 | SQLite store: WAL, `synchronous=FULL`, migrations with backup, outbox, timers, single-writer lock | `verify-projections` green. Migration tests exist |
| | 5 | Property-based and model-based tests for the engine | R4 green |
| **Week 2: execution** | 6 | Runner shim: detached, process group, env marker, atomic file writes, heartbeat, timeout | Kill the daemon while a fake agent is running; after the restart, it can still re-attach |
| | 7 | Claude and Codex adapters, contract tests using the day-1 fixtures | Every fixture is classified correctly |
| | 8 | Worktree manager + project `cusr.yaml` loader + gate runner + log digest + context compiler | The gate runs on a sandbox repo in at least 2 ecosystems, and the logs are filtered |
| | 9 | GitHub port through `gh`: push, PR with marker, poll checks, `--log-failed`, merge bound to the SHA. Every call has a timeout | A real PR on a sandbox repo |
| | 10 | **Direction check**: walking skeleton, one task end-to-end on a sandbox repo | If the direction is right, continue. If it is wrong, stop here: only 2 weeks lost instead of months. If the runner is still flaky, switch to Plan B (Cezar as the executor, section 2.4) |
| **Week 3: recovery and full core** | 11 | Full Recovery Manager: attempt reconciliation, probe per effect, boot-id, circuit breaker | Restart in every state behaves correctly |
| | 12 | Fault injection: the crash matrix, disk full, SQLite busy, `gh` errors, clock jumps | R2, R5, R6 green |
| | 13 | Task sources: CLI/agent + GitHub (poll, `/cusr` commands, idempotent sync back) + triage. Scheduler DAG + pools + rate-limit cooldown | Assign a task from a GitHub issue on your phone; tasks run in dependency order; no duplicate tasks are created |
| | 14 | HITL per section 8.6b: `cusr inbox`/`cusr answer`; a Telegram bot as the default channel (two-way, approve/reject buttons, accepts only your `chat_id`); GitHub comments for tasks that come from issues; approvals (merge, model escalation, yolo) | A Telegram reply from your phone, and the task continues. Answering on one channel marks the others as "answered" |
| | 15 | Full CLI `--json` + `explain`/digest + `SKILL.md` for the assistant + watchdog | The assistant can answer "how far along is the feature?" using only the CLI. R3 green |
| **Week 4: proof** | 16–17 | Chaos run + soak; fix every bug found | R1, R7 green |
| | 18 | Backup/restore, `cusr doctor`, systemd unit, operations runbook | R9 green |
| | 19 | Smoke test with the real harness, including a kill midway; then dogfood 3–5 real tasks on at least 2 other projects in different ecosystems | R8 green. Token and PR data recorded |
| | 20 | Reliability Gate review + retrospective | Decide: real use, or keep fixing |

**If the 14-day limit is mandatory:** keep the Reliability Gate unchanged and cut the scope.
- No escalation ladder; the binding is fixed.
- Only one task runs at a time; dependencies are still respected.
- Only the CLI/agent source; the GitHub source comes later.
- No Telegram bot; Q&A only through `cusr inbox`/`cusr answer`.
- You merge yourself with `gh`; `cusr` stops at "CI green, waiting for merge". This way v1 has no most dangerous effect.

### 9.3 Still excluded from v1
This cuts *breadth*, not reliability:
- A web dashboard. An MCP server (use the CLI + `SKILL.md` instead). ACP. The Pi adapter (phase 2).
- Webhooks. Remote workers. Special support for particular resources (device/emulator lifecycle, browser E2E, screenshot diff). A project can still declare any gate through the shell, with a matching pool.
- Task intake through a form (needs an HTTP server), Slack, Telegram, or email. In v1, Telegram is only a *Q&A and approval channel* (section 8.6b); it does not accept new tasks.
- Splitting epics with `planner`. In v1, you split them yourself or ask the assistant to create the subtasks.
- Editing workflows at runtime. Escalating to a model outside the declared ladder. Routing models by cost.
- Multi-user and auth. Temporal, Restate, or DBOS. A terminal UI beyond the scope settled in [spec 004](../specs/004-terminal-tui/spec.md).
- Automatically resolving merge conflicts over multiple rounds. Notification channels other than Telegram and GitHub comments (Slack, Discord, email, ntfy).

**Discipline in place of a line-count limit:**
1. Each module has a narrow responsibility and hard boundaries. The engine does no I/O. Adapters only build commands and parse output.
2. Do not merge any feature that lacks its fault test.
3. Every external call (harness, `git`, `gh`, shell) has a timeout, error classification, and a retry limit.

**Locked stack:** Node 24 LTS, TypeScript strict, `better-sqlite3`, Zod 4, Commander, `yaml`, `uuid`, Vitest and fast-check. The runner uses `node:child_process.spawn`; gate/git/gh may use `execa`. Build with `tsc`, package manager pnpm, lint with ESLint + typescript-eslint, format with Oxfmt. Compiler flags, schema contracts, and module limits are specified in [SPEC §17](../SPEC.md#17-technical-baseline). No workflow framework.

---

## 10. Obsolescence risk: which parts last, which will be replaced

| Layer | Estimated "lifespan" | Strategy |
|---|---|---|
| Domain model, state machine, policy, event log, outbox, probe, recovery | **Long** (years). This is distributed-systems knowledge, not vendor-dependent | Invest heavily and test thoroughly. This is the main learning area |
| Quality gates, context packet compiler, token ledger | Long | Moderate investment |
| Toolchain pack (`log_digest`, `signature`, `ci_rules`) | Medium (toolchain log formats change) | Treat it as data, not code. Test with real log fixtures. A project can always override it |
| CLI contract + SKILL.md for the assistant | Medium to long | Version the `--json` output (`schema_version`) |
| GitHub port (`gh`) | Medium (gh is fairly stable) | A thin port, with a fake |
| **Standard task format in the DB** | **Long** | Versioned (`schema_version`). Every source maps to it |
| Per-source connectors (GitHub, form, Slack…) | Short to medium (channel APIs change; new channels appear) | Thin connectors: receive, normalize, sync back. CLI/agent is always the fallback path |
| **Harness adapter, CLI flags, model names, prompts** | **Short** (measured in months; Codex dropped `--full-auto` this year) | The adapter only builds commands and parses output; test it with fixtures; `cusr doctor` checks the version and flags; pin the harness version |
| "Task → PR" orchestration | Being **commoditized** by the vendors themselves. For example, Claude Code now has `--bg` (a background agent with a supervisor), `claude agents --json` to list background sessions, `--worktree`, and agent teams **[XM-docs, CLI reference]** | Do not compete here. Your value is a **vendor-neutral control plane**: policy, audit, recovery, multi-harness coordination. If vendors do background running well, your adapter can call that feature instead of managing processes itself |

**Rules so the learning project does not become a burden:**
1. **Hard boundary**: the engine imports nothing from any adapter. Adapters only know `AgentRequest` → argv, and line → `NormalizedEvent`.
2. **Maintenance budget**: if adapter fixes take more than 2 hours a week for 4 weeks in a row, reassess (use a community ACP adapter, or move the runner part to another tool).
3. **Feature freeze after v1**: add features only when the metrics in section 7.2 show the need.
4. **Escape hatch**: since tasks, plans, and events all live in SQLite with your own schema, swapping the runtime (for example, using a different runner for execution) loses no data and no process.

---
## 11. Testing strategy

| Tier | Technique | Required scenarios |
|---|---|---|
| **Workflow engine (pure)** | Scenario-table tests: `given(events) when(trigger) then(events, commands)`; fake clock | Happy path; reject → fix → approve; reject ×3 → escalate; gate fail ×3 → escalate; CI fail → fix → pass; policy blocks a model; cancel midway; `needs_input` → answer → resume |
| **Invariants** | Property-based (`fast-check`): generate random trigger sequences | No step exceeds `max_visits`. Terminal states are absorbing (cannot be left). No two effects share the same `idem_key`. No `start_agent` violates policy. Total `agent_runs` ≤ budget. **Model escalation:** never use a rung outside the frozen ladder. Never escalate because of infrastructure outcomes (rate limit, timeout, crash). The same error signature twice in a row always leaves the current rung. Each rung ≤ `quality_tries_per_rung` attempts. The `rung` of each (task, step) pair and the task's floor never decrease; every `start_agent` uses a rung ≥ `max(rung, floor)`. The `needs_approval` rung never runs without an approval event. The number of escalations ≤ `max_escalations_per_task`. **Decisions:** a merge into `main` happens only with an approval event bound to the exact head SHA, or when yolo is on and all hard conditions hold |
| **Config loader** | Unit | Rejects: an outcome missing a transition; a cycle without `max_visits`; a role or model that does not exist; conflicting profiles; a `cusr.yaml` with no gate the profile allows. A toolchain pack is merged and overridden correctly |
| **Adapter** | Contract tests with **JSONL fixtures recorded from the real CLI** (day 1) | Successful parse, errors, rate limit, truncated output, non-JSON lines. `classify` is correct |
| **Runner + lifecycle** | `fake-agent` (a script that takes a scenario: sleep, write a file, emit JSONL, hang, exit code, ask a human, broken JSON) | Stall timeout, wall timeout, killing the whole process group (no orphaned child processes), PID reuse (simulate a different `start_ticks`) |
| **Crash recovery** | **Crash injection points**: `CUSR_CRASH_AT=<effect>:<phase>` calls `process.exit(137)` | Matrix {start_agent, git_push, create_pr, post_comment, merge} × {before phase 1, between 1–2, between 2–3, after 3}. After restart, assert there are no duplicate effects (fake GitHub counts the calls) and the task continues at the correct step |
| **Review loop** | A fake reviewer that returns verdicts from a script | The correct number of rounds. `escalate` comes with a summary |
| **CI integration** | In-memory `FakeGitHub` (a sequence: pending → failure → success), and real log fixtures from several toolchains (Node, Python, Go, JVM) for the log filter | CI timeout. CI green after a fix. The approval is invalidated when the head SHA changes. **Merge race:** two green PRs on the same base; after the first merges, the second is forced to update and re-run CI. Indeterminate CI does not merge |
| **Worktree** | Two tasks run in parallel; the worktree is removed when the daemon stops; a fake agent tries to write outside its worktree | Each task has its own worktree, never shared. Recovery recreates a lost worktree. Writes outside the worktree are detected. A worktree with unpushed work is not deleted |
| **Liveness/progress** | A fake agent that is silent but uses CPU, or a child process that runs long with no output | Not killed by mistake. A stall is declared only when no progress signal exists at all |
| **FrozenExecutionContext** | Edit an attachment between two attempts | The later attempt still reads the old snapshot. It generates `TaskRevised` and a decision point; it never silently changes the input |
| **Task sources** | A shared contract test for all connectors (output must be a valid standard task). A fake GitHub with sequences of issue/comment events | The same event delivered twice creates only one task. Editing an issue before the run updates it; after the run, it flags `source_drift`. Closing an issue cancels safely. An issue from a stranger is ignored. Sync back does not post duplicate comments. A missing `acceptance` moves the task to `PENDING(needs_info)`. Source information does not leak into the prompt |
| **Context packet** | Snapshot tests + an **assertion on the size budget** (for example, a reviewer packet under 8k estimated tokens) | A large diff switches to `--stat` mode |
| **Real E2E** | A toy repo, run manually or nightly; spends real tokens | One end-to-end task with Claude and Codex. Detects harness flag changes |
| **Chaos (R1)** | The runner randomly `kill -9`s the daemon, with fake agents failing at random; the seed is recorded so the run can be reproduced | ≥ 200 kills. Every task recovers correctly. `verify-projections` matches |
| **Environment errors (R6)** | Inject errors through ports: `ENOSPC`, `SQLITE_BUSY`, `gh` timeout / 5xx / rate limit, clock jumping forward or backward, torn JSONL lines | Correct classification. No crash. No wrong state transitions |
| **Soak (R7)** | Run 8–12 hours with ≥ 50 fake tasks; monitor RSS and the file-descriptor count | No leaks, no stuck tasks |
| **Operations (R9)** | Backup → delete the DB → restore. Migration on a copy of the DB. `cusr doctor` with a fake harness of the wrong version | Data matches. The migration runs in both directions or has a rollback path. `doctor` reports the correct error |

---

## 12. Roadmap and go/no-go criteria

### 12.1 Order
| Phase | Time | Content |
|---|---|---|
| 1 | Weeks 1–4 | Reliable v1 (section 9). Direction check on day 10. Use only on real repos after passing the Reliability Gate |
| 2 | Weeks 5–8 (about 4–6 hours a week) | Real use for 2 features on projects from other ecosystems. A thin MCP server. The Pi adapter. A form source (HTTP API + a form page over Tailscale). Splitting epics with `planner`. A "context" rung in the escalation ladder. Toolchain packs for common ecosystems (Node, Python, Go, Rust, JVM), each with real log fixtures. A weekly token report |
| 3 | Weeks 9–12 | Remote workers over SSH (the runner shim runs on another machine; the file contract goes over `ssh`, meaning only the spawn method changes, not the engine). Support for resource lifecycles such as device/emulator and browser, and screenshot tests. A read-only dashboard on SQLite |
| 4 | When needed | An ACP adapter. Webhooks (Tailscale Funnel). An automatic planner. Cost-based routing (still within policy) |

### 12.2 Criteria for continuing after v1 (measured after 2–4 weeks of real use)
**Continue if at least 4 of 5 are met:**
1. ≥ 60% of tasks reach a green PR where you only needed to answer a question or approve, with no manual code intervention.
2. 0 duplicate side effects in the crash-matrix test and in real use.
3. Compared with the Firstmate baseline on the same group of tasks: tokens / accepted task is at least 30% lower, and human interventions do not increase. In addition, wasted runs are under 25%.
4. Adapter maintenance time is under 2 hours a week.
5. You actually choose to use `cusr` for the next feature, rather than going back to the old tool.

**Stop or change direction if:**
- You spend more time on `cusr` than on your own projects.
- An existing tool (see section 2) meets ≥ 80% of your needs after you have tried it seriously.
- The harness changes its headless contract and breaks the adapter more than once a week.

When stopping, what is kept still has value: the domain model, the recovery knowledge, the crash test suite, and the role/workflow configuration. All of it can be carried over to another tool.

---

## Appendix A: Assumptions to verify (in order of risk)

1. **[CKC]** The agent follows the `result.json` contract against the schema ≥ 95% of the time (measured on day 1 and day 6). If not, rely on the harness's structured output plus one repair pass.
2. **[CKC]** `claude -p` runs unattended for 30–45 minutes stably on a subscription. A rate-limit error can be distinguished from other errors through the output or the exit code.
3. **[CKC]** The model-selection and sandbox flags of `codex exec` in the version you have installed. Does the `workspace-write` sandbox let the project's build tools download dependencies (network)?
4. **[CKC]** Most tasks you assign fit in a single reviewable PR (≤ roughly 400 changed lines). If not, the epic mechanism must be built earlier than phase 2.
5. **[CKC]** The practical parallelism reached before conflicts become the main cost (prediction: 2–3 concurrent tasks).
6. **[CKC]** CI is GitHub Actions, and `gh run view --log-failed` provides enough information for the CI Fixer.
7. **[CKC]** A reviewer from a different vendor than the coder catches bugs the gate misses, enough to justify the cost. Measured by the acceptance rate of findings.
8. **[CKC]** Anthropic's and OpenAI's subscription policies for personal use stay the same for the next 6 months. They changed twice in 2026, so keep the API-key option.
9. **[CKC]** systemd works in your WSL2, and the machine does not sleep during overnight runs.
10. **[CKC]** Escalating the model actually "rescues" failing tasks (a significant rescue rate), rather than most failures coming from vague requirements or missing context. Measure with `cusr report escalations` after 2 features.
11. **[CKC]** Tasks submitted through GitHub or an agent often lack `acceptance`. Measure the share of tasks that land in `PENDING(needs_info)` to decide whether to enable `refiner`.
12. **[CKC]** Four weeks is enough to reach the full Reliability Gate with one person plus AI assistance. If by day 15 items R2, R5, and R6 are not green, cut the scope per section 9.2 instead of relaxing the standard.

## Appendix B: Sources used

**Source code** (shallow clone 2026-10-26, commits in section 2.1):
- [open-mercato/cezar](https://github.com/open-mercato/cezar)
- [chernistry/bernstein](https://github.com/chernistry/bernstein)
- [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
- [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
- [openai/symphony](https://github.com/openai/symphony)
- [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate)

**Harness documentation:**
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): `-p`, `stream-json`, `--json-schema`, `--max-turns`, `--max-budget-usd`, `--permission-mode`, `--bare`, `--bg`, `claude agents`
- [Claude Code headless](https://docs.claude.com/en/docs/claude-code/headless)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): `codex exec --json`, `resume`, `--output-schema`, `turn.completed.usage`, and a note that `--full-auto` is no longer supported
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Pi RPC mode (mirror of npm `@earendil-works/pi-coding-agent`)](https://cdn.jsdelivr.net/npm/@earendil-works/pi-coding-agent@0.81.1/docs/rpc.md)
- [ExMCP ACP guide](https://hexdocs.pm/ex_mcp/acp_guide.html) and [changelog](https://hexdocs.pm/ex_mcp/changelog.html): ACP v1 status and adapter (secondary sources)

**Subscription policy:**
- [Use the Claude Agent SDK with your Claude plan, Anthropic Support (updated 2026-10-07)](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- Secondary context: [WinBuzzer 2026-02](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/), [Digital Applied](https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026)

**Durable execution:**
- [DBOS Transact v2 TypeScript](https://dbos.dev/blog/dbos-transact-v2-typescript)
- [What's New in DBOS, June 2026](https://dbos.dev/blog/new-in-dbos-june-2026) (SQLite for the Go build)
