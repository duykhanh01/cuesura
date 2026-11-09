# Cuesura

> Every call has a cue. Every pause has a purpose.

> [!NOTE]
> **Status: archived experiment, no longer developed.** Cuesura was an attempt to build a deterministic
> control plane for coding agents. It works for the flows described below, but it is not maintained and
> issues or pull requests will not be answered. It is published as a reference in the hope that the ideas,
> specs and lessons help you build or choose your own tooling.

Cuesura is a **deterministic, event-driven workflow engine for AI coding agents**. The name joins **Cue** (the
signal to start) and **Caesura** (a deliberate pause in music or verse): when no agent is running, the system
still knows why it is waiting (CI, a person, a quota) and what lets it continue. Knowing when not to call a
model matters as much as knowing when to call one.

The CLI is `cusr`; the daemon is `cusrd`.

## The idea

- **No primary AI running all the time.** A pure state machine decides every transition, so routine
  orchestration costs zero tokens. Models are called only for the work of a step, or when judgment is needed.
- **Agents are one-shot headless calls per step:** Claude Code and Codex CLI, each in its own git worktree.
- **Durable state in SQLite:** an event log, an outbox with idempotency keys, and crash recovery that never
  repeats a side effect (no duplicate PR, push or comment after a restart).
- **Hard guarantees owned by code, not by the model:** a PR is never opened before the gates (build/test) pass,
  reviewer loops have caps, every decision is recorded with its reason, and agents never merge.

## What it does

1. Takes tasks from the CLI, a GitHub issue or an AI assistant, and normalizes them into one format.
2. Schedules them: dependencies, parallel runs of independent tasks, scope and hotspot conflicts, and pausing
   when a subscription quota runs out.
3. Runs a fixed workflow per task in its own worktree: coder → gates → reviewer → fixer → PR → CI → wait for
   merge. Harness, model and effort are confirmed per task, with an escalation ladder per failure signature.
4. Lets the owner answer questions asynchronously (`cusr inbox`, a Telegram bot, a terminal UI) and lets an
   external assistant drive it through `cusr --json`.
5. Measures tokens per accepted task, wasted runs, time to green and how often a person had to step in.

## What was built

Roughly two weeks of work and about 250 pull requests, most of them written by coding agents: about 70k lines
of TypeScript and 84k lines of tests.

| Feature | Spec |
| --- | --- |
| 001 Deterministic core: engine, event log, outbox, recovery | [spec](specs/001-deterministic-core/spec.md) |
| 002 Task to green PR: worktrees, gates, review, PR, CI, manual merge | [spec](specs/002-task-to-green-pr/spec.md) |
| 003 Telegram channel for questions and approvals | [spec](specs/003-telegram-channel/spec.md) |
| 004 Terminal UI | [spec](specs/004-terminal-tui/spec.md) |
| 006 Account pool: several subscriptions per harness | [spec](specs/006-account-pool/spec.md) |
| 007 Deputy: an agent acting for the owner when a task is stuck | Design only: [design note](docs/deputy-design-note.md) |

The specs reflect the design at the time they were written; the code is the source of truth.

## What we learned

The most useful outcome of this project is the lesson, not the engine.

- **A capable orchestrator agent plus a good prompt went a long way.** On the last night of the project, an
  off-the-shelf orchestrator (one LLM session spawning coder and reviewer agents) closed almost every open issue
  of this repository from a single prompt, and every PR was green under branch protection. Most guarantees we had
  built into the engine were already provided by GitHub (required checks, strict up-to-date branches), the
  repository rules ([AGENTS.md](AGENTS.md)) and a PR-writing skill.
- **Much of the later effort went into the engine's own complexity:** run-config confirmation, ladders, leases,
  waits. A thinner layer would not have needed most of that maintenance.
- **The field is moving towards thin layers.** OpenAI's Symphony is published as a spec rather than a product,
  and harness vendors ship their own orchestration. A heavy deterministic engine is the part most exposed to
  models getting better.
- **What still seems worth keeping:** recording why each decision was made, idempotent side effects for anything
  that touches GitHub, detecting loops by fingerprinting review findings, and short-lived agent sessions that read
  a structured ledger instead of one long session that keeps growing.

[docs/architecture.md](docs/architecture.md) has the original build-vs-buy review and the survey of other
orchestrators; [docs/constitution.md](docs/constitution.md) has the principles the project followed.

## Repository map

| Path | Content |
| --- | --- |
| [SPEC.md](SPEC.md) | Overall specification: v1 scope, domain model, workflow, operating contracts |
| [GLOSSARY.md](GLOSSARY.md) | Domain terms |
| [docs/](docs/) | Architecture review, constitution, ADRs, config upgrade notes, deputy design note |
| [specs/](specs/) | Feature specs |
| [deploy/README.md](deploy/README.md) | Install and operating guide |
| `src/` | Engine, daemon, CLI, runner, adapters, terminal UI |
| `test/` | Unit, contract, property, integration, reliability and smoke tests |
| [skills/cusr](skills/cusr/SKILL.md) | Skill that teaches an assistant (Claude Code, Codex) to drive `cusr` |
| [src/assets/write-pr](src/assets/write-pr/SKILL.md) | Skill and template agents use to write PR descriptions |

## Running it

Requirements:

- Linux or WSL2/Ubuntu. The runner uses `systemd-run` and `bwrap`; macOS is not supported. Keep the repository
  on a Linux filesystem (not `/mnt/c`).
- Node at the version pinned in `.nvmrc` (24.22.1) and pnpm through Corepack.
- `build-essential` and `python3` to build `better-sqlite3` when no prebuilt binary is available.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Quality checks:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Longer suites run separately: `pnpm test:performance`, `pnpm test:reliability` (prints a seed on failure; pass
it back with `--seed <seed>`), and `pnpm report:invariants` for the invariant report built from the latest runs.
The smoke suite (`pnpm test:smoke`) needs the repository to have an `origin/main` remote.

To install the daemon, configure projects and connect an assistant, follow [deploy/README.md](deploy/README.md).
Running `cusr` with no command in an interactive terminal opens the terminal UI.

Most documentation was first written in Vietnamese and translated to English when the project was archived;
code comments were always in English.

## License

[Apache License 2.0](LICENSE).
