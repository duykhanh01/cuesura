# Host prerequisites for feature 002

This is the runbook for host checks and provisioning when needed; documentation updates do not install or remove policy on their own.
Prove the native harness on the exact binary/settings before running real tasks. The outer bwrap evidence
from slice 0 is historical. Doctor reports missing prerequisites; it does not run sudo or change sysctl on its own.

## Baseline: native harness permissions

Per [ADR-0005](../docs/adr/0005-native-harness-permissions.md), Cuesura dropped the outer bwrap and runs the
harness directly in a dedicated worktree. Setup/gate/autofix run on the host; systemd supervises the runner.
No Cuesura outer sandbox proof is needed. Claude's native sandbox still depends on the host's userns/AppArmor
policy; the old outer bwrap fixtures and ADRs are historical.

<a id="host-prerequisites"></a>

### Per-system preparation and fixes when preflight reports `capability_missing`

Install Node/pnpm and the project tools on the host PATH. `cusr doctor` checks systemd, pin/manifest and the tools
the harness needs. Native Claude on Linux may still need `bwrap`/`socat` for Claude's own sandbox;
this is not Cuesura's outer bwrap. Codex uses Codex's native sandbox.

### User namespaces and AppArmor for the native sandbox

Claude with the sandbox enabled on Linux still uses bwrap; the decider always needs the sandbox even when the worker chooses off or full access. On a new host,
install `bubblewrap`/`socat` and check as the user that runs the daemon:

```sh
bwrap --unshare-user --ro-bind / / /usr/bin/true
sysctl user.max_user_namespaces kernel.unprivileged_userns_clone kernel.apparmor_restrict_unprivileged_userns
```

The sysctl command is read-only; which knobs exist depends on the kernel/distro. If userns is disabled or bwrap fails with
`setting up uid map: Permission denied`, an administrator reviews the existing hardening and profiles. Do not infer
from `apparmor_restrict_unprivileged_userns=1` that bwrap is definitely blocked: a loaded profile may allow it.
Doctor/preflight only check executables and systemd; they no longer probe global userns or emit
`userns_*`/`bwrap_*` causes. A native proof run fails if the harness sandbox does not run or does not block the probe.

Userns profile for Ubuntu 23.10/24.04+: before loading, check `ls /etc/apparmor.d` for an existing profile
that attaches `/usr/bin/bwrap` (installed by the distro or another package); if there is one, review that profile instead of loading
another, because two profiles attaching the same binary
conflict. This profile only lets bwrap create user namespaces as it could before Ubuntu enabled the restriction; every
other program is still blocked, and every user on the machine can use bwrap.

```sh
sudo tee /etc/apparmor.d/cusr-bwrap-userns >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile cusr-bwrap-userns /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/cusr-bwrap-userns>
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/cusr-bwrap-userns
bwrap --unshare-user --ro-bind / / /usr/bin/true && echo ok
```

Remove: `sudo apparmor_parser -R /etc/apparmor.d/cusr-bwrap-userns && sudo rm /etc/apparmor.d/cusr-bwrap-userns`.

Do not load/remove profiles or change sysctl automatically; the operator reviews and runs the provisioning commands above.
The old outer bwrap profiles/probes are no longer maintained; see Git history when you need to compare old evidence.
Set up and check the native mode of the exact harness with `setup-harness` after provisioning.

### Harness internal sandbox

`write-pin --permission-mode auto` (the default) selects Claude mode `auto`, or Codex `workspace-write`
with automatic approval review. Claude workers have a separate option `--sandbox on|off`; this flag writes
`settings.sandbox.enabled` into the pin and does not change the permission mode. Omitting the flag keeps `sandbox.enabled` from the
settings file; if it is not declared, the sandbox is off, as in Claude Code's default.

| Claude worker | Sandbox off (default) | Sandbox on |
| --- | --- | --- |
| `--permission-mode auto` | Auto review of tool permissions, `native_result=not_tried` | Auto review of tool permissions and native sandbox, native proof required |
| `--permission-mode full-access` | `bypassPermissions`, no worker sandbox | `bypassPermissions` inside the native sandbox, native proof required |

When the native sandbox is on, the adapter adds `sandbox.network.allowAllUnixSockets: true` so the worker can create
`AF_UNIX` sockets (the Linux sandbox blocks them by default), which lets it run tests that use a real daemon. Declare
`sandbox.network.allowAllUnixSockets: false` in the settings file to keep them blocked. This value is part of the settings hash,
so a release that changes it requires proving the harness again.

The decider (answers questions on the owner's behalf) always keeps a read-only sandbox. `bwrap`/`socat` are therefore still needed for the
Claude harness. The reviewer runs like the fixer: it may edit files, run tests and commit, and afterwards the daemon returns the worktree to exactly the state
it was in before the review. This is a tool permission,
not self-approval of run config, code review or merge. Once the sandbox is on, failures do not fall back automatically to
off or full access. Codex does not accept this `--sandbox` flag; the Codex sandbox mode follows the permission mode.

<a id="systemd-and-wsl2"></a>

## systemd and WSL2

The daemon calls `spawn` for `systemd-run --user`; the runner is an independent transient service, `Restart=no`,
`KillMode=control-group`, with no lifecycle dependency on the daemon. PID1 being systemd is not enough:
doctor checks the user bus and runs a trial transient unit to completion, then cleans it up. Runner survival across a daemon stop
requires stopping the daemon itself, so it is checked by `test/integration/runtime/supervisor-systemd.test.ts`.

On WSL2, `/etc/wsl.conf` needs:

```ini
[boot]
systemd=true
```

After the change, the user runs `wsl.exe --shutdown` from Windows and reopens the distro; doctor checks the actual
runtime. See [Microsoft WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd).
`systemctl --user is-system-running` may report `degraded` because of unrelated units; pass/fail is based on
Cuesura's own probe unit, not just this status string. Logout/distro shutdown is not equivalent
to a daemon restart; runners are not guaranteed to survive a machine/WSL shutdown, and recovery must reconcile lost.

Without a user bus, `systemctl --user` and `systemd-run --user` report `Failed to connect to bus: No such
file or directory`, and doctor reports the `systemd_unit` check as failed, even though `user@<uid>.service` is still running. Running
the daemon in the foreground does not avoid this, because the runner needs `systemd-run --user`. Install the package so systemd enables the
user bus automatically, then run `wsl.exe --shutdown` from Windows and reopen the distro:

```sh
sudo apt install -y dbus-user-session
```

### Running the daemon: foreground or service

A data dir has only one writer: a second daemon on the same directory exits with `store_locked`. Choose one
of the two ways; both use the same runner unit `cusr-op-*.service`, independent of the daemon.

First run: copy the [sample config](config.example.yaml), edit the placeholders (project, model, credential)
and run the daemon. `cusrd` creates the data dir with mode 0700 itself; there is no token or secret file to create beforehand.
When `cusr` cannot see the daemon (`daemon_unreachable`), it prints these same steps along with the data dir it tried.

```sh
(umask 077 && mkdir -p ~/.cusr && cp deploy/config.example.yaml ~/.cusr/config.yaml)
```

`umask 077` keeps the data dir at 0700: the daemon refuses to run when group or others can access this directory.

Foreground, stop with Ctrl-C or SIGTERM:

```sh
cusrd --config ~/.cusr/config.yaml --data-dir ~/.cusr
```

`cusr` finds the daemon by `--data-dir` (placed before or after the command), then `CUSR_DATA_DIR`, then `~/.cusr`.

Service: use the sample unit [cusrd.service](systemd/cusrd.service). The repo does not install or load the unit; the
operator edits `ExecStart` to match the install location and runs:

```sh
install -D -m 0644 deploy/systemd/cusrd.service ~/.config/systemd/user/cusrd.service
systemctl --user daemon-reload
systemctl --user enable --now cusrd.service
cusr status --json
cusr doctor --project "$PROJECT" --json
```

Version requirements: Node matching `engines` in `package.json`, `systemd-run` and `systemctl` in
`/usr/bin`. On WSL2 a user manager is required as in the section above; `wsl.exe --shutdown` stops both the daemon and the runners,
and restart reconciles `lost`. On a headless server, `loginctl enable-linger` is required as in the `cause` table. The actual
paths (data dir, socket `control.sock`) follow `--data-dir`/`runtime.data_dir`; the socket path
must be shorter than 108 bytes.

`cusr doctor` is read-only: it does not call a model, use sudo or provision. Any failing check exits 1 and prints the fix
command for the operator to run. A harness without a capability manifest is reported as failed; "proven" is not inferred from
the binary's help/version; even with a manifest it still fails if the hash is wrong, a required capability is missing, or the binary has changed.
Settings, environment and host policy need the vendor pin, so preflight and each attempt check them. The sample unit has
passed `systemd-analyze --user verify` (it only reports the missing `ExecStart` binary when not yet installed).

**Retention:** `cusrd` runs a retention sweep at startup and after a task ends; there is no separate timer or manual cleanup
command. A run directory is deleted only when the task has ended, `exit.json` is complete, every artifact has been recorded by the store,
and `runtime.limits.terminal_retention_ms` (default 30 days) has passed. Setup, gate and autofix command logs
(`receipts/<effect>/logs/`) of ended tasks are deleted after 14 days, counted from the newest log file; this value is not yet
configurable. Deletion leaves a tombstone (run digest, log file names), so `cusr task gate-log` and the gates screen report
that the log has expired rather than an error. A sweep that deletes something logs a line `retention: removed … freed … bytes`; deletion errors log
`retention warning` and the next sweep retries. Retention does not write to the store. A worktree is not deleted just because it is old: a diff or
commit not yet on the remote keeps it.

**Recovery:** when scanning processes after a restart, a same-user process whose `environ` cannot be read (`ssh`, `sudo`) and that started after the operation began
keeps the claim and blocks new work until that process ends; the daemon retries every second.

**Current limitations:** `cusrd` runs real tasks through to a PR when the harness has valid records (see [Real harness](#real-harness-pin-and-manifest)
below); without records the task stops at PENDING `capability_missing`. Still open: tasks with a `content_ref` attachment
fail at freeze because there is no content source yet (`cusr add` always creates tasks without attachments); `lint` is an optional gate of `software_dev`, so a red lint still publishes.

### Watching agents in herdr

By default agents run in the background (`background`). To watch them live in [herdr](https://herdr.dev), add to
`runtime` and restart `cusrd`:

```yaml
runtime:
  terminal:
    backend: herdr # background is the default
    # session: cusr  # empty = default herdr session
```

Cuesura looks for `herdr` on the daemon's PATH, then in `~/.local/bin`. `tool_paths.herdr` is only needed when it is installed
elsewhere.

Agents appear in background tabs in the `cuesura` workspace without taking focus; a tab closes itself when done, and logs remain readable with
`cusr task logs`. The pane is view-only: Ctrl-C, closing the pane or stopping herdr does not stop the agent; cancel with `cusr`. If herdr
is not running, agents run in the background and `cusr doctor` reports the `terminal` check. See
[ADR-0006](../docs/adr/0006-terminal-view-backend.md).

### Watching agents in Orca

Like herdr, but using [Orca](https://github.com/stablyai/orca):

```yaml
runtime:
  terminal:
    backend: orca
```

Cuesura looks for `orca` on the daemon's PATH, then in `~/.config/orca/cli/bin` and `~/.local/bin`; if it is installed elsewhere,
set `tool_paths.orca`. The first time an agent runs, Cuesura creates an empty git repo `<data dir>/cuesura` and adds it to
Orca as project `cuesura`, because an Orca terminal must belong to a project. Agents appear in tabs in that project
without taking focus, and a tab closes itself when done. If you remove the project from Orca, it is added back on the next run. The pane is
view-only as with herdr; if Orca is not running, agents run in the background and `cusr doctor` reports the `terminal` check.

### Watching agents in Paseo

Like herdr, but using [Paseo](https://github.com/getpaseo/paseo); agents also appear in the Paseo phone app:

```yaml
runtime:
  terminal:
    backend: paseo
```

A running Paseo daemon (`paseo daemon start`) with the default home `~/.paseo` is required. Cuesura looks for `paseo` on the
daemon's PATH, then in `~/.local/bin`; if installed with `npm i -g` via nvm, set `tool_paths.paseo` to the CLI script, for example
`~/.nvm/versions/node/<version>/bin/paseo`. Cuesura runs that script with `cusrd`'s node. Each task project appears
in the app as a project `cuesura-<project>` (directory `<data dir>/paseo/cuesura-<project>`). Terminals are named after the
role and the task title, for example `coder: Add …`, and close themselves when done. The pane is view-only as with herdr;
if the Paseo daemon is not running, agents run in the background and `cusr doctor` reports the `terminal` check.

## Terminal UI over SSH

Open it with `cusr` with no command in an interactive terminal of the same user as the daemon (SSH, tmux, WSL2 all work); the UI
reads the same control socket and the same `CUSR_DATA_DIR`/`--data-dir` as other commands.

- **Exit and signals.** Ctrl-C, `SIGTERM`, `SIGHUP` and internal errors all restore the terminal to its original state. Ctrl-C does not cancel tasks.
- **SSH drop.** With no terminal left, the UI cannot print anything and does not write payloads to a file. Actions with an unknown outcome
  must be reconciled with `cusr task list`, `cusr task history ID` or `cusr request show REQUEST_ID`. Running tasks are not affected.
  Run inside `tmux` so the session survives an SSH drop.
- **Normal exit with actions of unknown outcome.** The UI prints the request IDs and the corresponding `cusr request show` commands to stderr and exits with code 3.
- **After `SIGKILL`.** This signal cannot be caught, so the terminal may remain in the alternate screen or raw mode, with no cursor
  or echoed keystrokes. Run `reset` (or `stty sane; tput rmcup; tput cnorm`) to restore it.

## Callers and permissions

Only processes with the same UID as the daemon can open the control socket: the data dir must be 0700 and owned by the right user, and the socket
`control.sock` is 0600; otherwise the daemon refuses to run. There is no token or secret file to create.

Callers declare who they are through the `CUSR_ACTOR` environment variable:

| `CUSR_ACTOR` | Actor | Permissions |
| --- | --- | --- |
| unset or `owner` | `owner` | `read`, `operate`, `admin` |
| `assistant` | `assistant` | `read`, `operate` |

Other values are rejected immediately by the CLI (exit 2, `actor_invalid`). An actor/role written in the request body has no
effect; the permission check runs before the schema check, so a caller declaring `actor: owner` in the body still exits 5. Every command is
recorded with its actor, so the history shows whether the owner or the assistant confirmed, cancelled or approved.

**Assistant.** The `cusr` skill sets `CUSR_ACTOR=assistant` for every command. The assistant may add tasks, propose and
confirm run config, answer questions, approve escalations, recheck and cancel; it may not approve adopting an existing PR and may not
use admin permission.

**Boundary.** `CUSR_ACTOR` is a guardrail for callers that follow the convention, not a security boundary: a process
with the same UID that drops this variable becomes owner. For real permission separation, run the assistant under a different UID. Workers
(coder/fixer/reviewer) do not call `cusr`; the worker environment does not inherit the daemon's `CUSR_*` variables. `cusr`
refuses to run (`worker_refused`, exit 5) when it sees `CUSR_ATTEMPT_ID` or `CUSR_OPERATION_ID`, the two tags the daemon attaches
to harness runs and to gate/setup; the `assistant session-start`/`assistant hook` hooks exit 0 silently instead. This
is also only a convention-based guardrail, like `CUSR_ACTOR`. Workers use
`gh` with the owner's login ([Network and credentials](#network-and-credentials)). There is no longer an outer
boundary preventing same-UID processes from reading host files.

**Upgrading from a token-based release.** `runtime.access_tokens` in the user config no longer has any effect; the daemon still
starts and logs a line saying this key is ignored. Remove that key, the assistant's token file and
`DATA_DIR/owner.token` when convenient; replace `CUSR_TOKEN_FILE` with `CUSR_ACTOR=assistant` where the
assistant is configured.

### Waking the assistant with a Stop hook

After each turn, `cusr assistant hook` parks in the background, polls the daemon without spending model turns, and delivers a message when a task needs a human
or a task has ended.
The session stays idle while the hook is parked, so the user can ask questions as usual. Only the delivery mechanism differs:

| Harness | How it runs in the background | How it delivers | Session ID at `register` | Verified version |
| --- | --- | --- | --- | --- |
| Claude Code | `Stop` hook with `asyncRewake` | Exit 2; stderr becomes the hook's feedback and opens a new turn | `CLAUDE_CODE_SESSION_ID` | 2.1.319 |
| Codex | `Stop` hook with `async` | `codex queue --thread` using the session's binary, because an async hook cannot wake the session by itself | `CODEX_THREAD_ID` | 0.166.0 |
| pi | Extension holding a child process | The extension sends via `pi.sendUserMessage` when the session is idle and retries until it sees the message in the session | `PI_SESSION_ID` | 1.5.0 |

Run in the repo where the assistant works, with the data dir matching the installation:

```sh
cusr init --data-dir "$HOME/cuesura-dogfood/data"
```

The `assistant` section installs the `cusr` skill and merges two hooks into the repo's `.claude/settings.local.json` using absolute paths,
keeping every other key and hook; rerunning does not add duplicates, and changing the data dir updates exactly that hook. This file contains
machine-specific paths, so it must not be committed: `init` hides it via `info/exclude` in the git common dir so all worktrees
share it, and stops with an error if the file is already tracked, has broken JSON or the wrong type. Commit the skill files.

When `codex` or `pi` is on PATH, `init` also installs `.codex/hooks.json` and
`.pi/extensions/cusr-assistant.ts` the same way. These two files are also repo-level, hidden and not committed:

- A user-level install would bind this repo's data dir to every other repo, so `init` does not use `~/.codex` or `~/.pi`.
- Ignored files do not enter the worker's clean worktree, so the worker does not see the hooks. `session-start` also exits by itself when
  running inside a worker.
- If the repo has committed one of these files, or `.gitignore` un-ignores it, `init` skips that harness and reports `skipped`;
  that harness keeps using `cusr assistant wait`. A `.pi/extensions/cusr-assistant.ts` not written by `cusr` is also left untouched.
- Broken JSON in `.codex/hooks.json` stops `init` before writing, as with Claude Code.
- Codex only loads hooks from trusted directories and asks "Hooks need review" the first time and whenever a hook changes. pi asks to trust
  the project the first time. You must agree for the hooks to run.

**Codex and the sandbox.** The `workspace-write` sandbox blocks `connect()` to the daemon's socket, so every `cusr` command run by the agent
reports `daemon_unreachable` with `EPERM`; hooks run outside the sandbox so they are not affected. The agent needs approval to run `cusr`
outside the sandbox, or `network_access` enabled in Codex's `[sandbox_workspace_write]`. The second option opens the network to
every agent command, so consider it before enabling.

The snippet `init` writes to the file, for reference:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "CUSR_DATA_DIR=$HOME/cuesura-dogfood/data CUSR_ACTOR=assistant cusr assistant session-start",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "CUSR_DATA_DIR=$HOME/cuesura-dogfood/data CUSR_ACTOR=assistant cusr assistant hook",
            "asyncRewake": true,
            "timeout": 604800
          }
        ]
      }
    ]
  }
}
```

The lease only changes when the user tells the agent to take it. When a session opens while tasks are waiting, `session-start` reminds the agent to ask
the user, unless the lease-holding session has polled the daemon within the last 10 seconds and has been sent all those tasks; the reminder
lives only in context and does not open a turn. If the registered session is running a long turn (its hook has not parked again), a new session
is still reminded, because from the daemon's side it is indistinguishable from a dead session.
If the user agrees, the agent runs `cusr assistant register --take`. This command's output lists pending work
(`items`) as a wake-up would; the first Stop hook confirms them instead of waking again, then parks and only reports new
messages. If the current directory has no Stop hook, the output contains `warnings`. Other sessions exit immediately without calling the daemon. The
registration lives in `DATA_DIR/assistant-session.json`, so it survives a daemon restart.

- When another session takes the lease (`register --take`, or `assistant wait` after the hook has been silent for more than 10 seconds), the old session's hook
  wakes it once with a `cusr:` line saying the lease has moved, even if no hook is parked at that moment: the daemon keeps a list
  of replaced sessions not yet notified in `assistant-session.json` (only the daemon writes this file), and that session's next Stop
  reports it and then confirms with the daemon. If the daemon has not received the confirmation (it is down), the hook records that it has reported in the session's
  own file, and later Stops only retry the confirmation without waking again. If `codex queue` fails, the hook keeps parking and retries, backing off from 30 seconds to 5 minutes.
  Taking the lease requires the `operate` permission.
- If the daemon does not respond for 5 minutes straight, the hook wakes the session once with the data dir and a `cusr status` hint; it only reports
  again after the daemon has come back and then been lost again. If `codex queue` fails, the hook still parks and retries with the same backoff until
  the message arrives or the daemon comes back. A short restart wakes no one. `assistant wait` returns `daemon_unreachable`
  after the same threshold.
- Syntax errors on the hook path (`assistant hook`, `assistant session-start`, a wrong subcommand) exit 1, not 2, so
  a broken hook command does not wake the session on every Stop.

- Only real messages wake the session. When `--timeout` runs out (default 604500 seconds, lower than the hook's `timeout`), the hook exits
  silently; the next turn ends with a Stop and the hook parks again, and unreported work remains in the daemon.
- Closing the terminal ends the session: the hook dies with it and sends nothing. When you reopen the session the registration is still there, and messages arrive after
  the first turn. On Codex and pi, the hook watches the harness process itself because closing the terminal or `kill -9` does not take it
  down. `codex queue` also returns exit 0 for a closed session, so the hook must check before sending.
- A message is only confirmed once it has arrived: `codex queue` succeeded, or pi shows the message in the session. During delivery, the hook of
  the turn that just ended waits for the result. If delivery fails, the daemon resends on the next `Stop`; if pi is compacting, the message waits until
  the session is idle. A message already in the Codex queue when the session closes before receiving it arrives on resume.
- `/new` changes the session ID. The registered session stops receiving messages, the messages remain in the daemon and the new session is reminded to ask for the lease; the lease
  does not move by itself. The exception is `codex app-server` (Codex app, IDE extension, Paseo): one process holds many threads,
  so opening a new thread does not stop the registered thread from receiving messages. `/resume` back to the old session receives messages again. Codex only reports the new session at the first prompt, so a message arriving
  between `/new` and that prompt still runs as a turn of the old session that the user does not see.
- `register` takes the first variable that has a value in the order pi, Codex, Claude Code; when a harness runs nested inside another harness,
  pass `--session`.
- `codex exec` exits when done, so it does not receive messages; the hook does not stay.
- The Codex hook finds `cusr` via the login shell's PATH. If the `cusr` there is older than the release that ran `init`, the hook reports a `--harness` error
  and does not park, while `session-start` still runs, so the session looks normal.
- Messages contain only the task ID and status code: the question content is written by the worker, so the assistant reads it with `cusr inbox`.
- A task moving to DONE, FAILED or CANCELLED after a session holds the lease is also a message, with codes `done`, `failed`,
  `cancelled` in `items`, resent the same way until confirmed (issue 257). The confirmed watermark (`ended_after`)
  lives in `assistant-session.json`, so unconfirmed messages survive a daemon restart and the lease moving to
  another session. The watermark starts the first time a session holds the lease and is dropped when `assistant unregister` finishes with no session
  holding the lease (a session in `assistant wait` keeps the watermark); tasks that ended before that are not reported. `attention_peek` and the SessionStart hook only count tasks that need a human.
- `asyncRewake` is not documented in Claude Code's `--help`. Verified on 2.1.319; other versions may change it.
- Other harnesses use `cusr assistant wait`. This command waits until there is a message and no longer returns by itself after 1 hour. It exits when
  the nearest harness process (`claude`, `codex` or `pi`) or the process given by `--owner-pid` ends, so the lease expires
  for the next session; it does not matter if the shell running the background command ends first. If no harness is found and there is no
  `--owner-pid`, the command waits forever; use `--timeout` in that case.

## Optional execution limits

By default, tasks and workers have no cap on the number of runs, total time, time per worker/command,
number of infrastructure retries or number of model escalations. Omit the key or set `null` to run without limits:

```yaml
profiles:
  dogfood:
    workflow: impl
    escalation: { max_escalations_per_task: null }
    limits:
      classes: { infra_retries: null }
      backoff:
        infra: { base: 5s, factor: 2, max: 5m, max_attempts: null }
        rate_limit: { base: 1m, factor: 2, max: 30m, max_attempts: null }
roles:
  coder:
    binding: [{ model: sonnet }]
    limits: { wall_timeout: null, stall_timeout: 10m }
runtime:
  limits: { command_wall_ms: null }
```

Profiles no longer have a `budgets` key: remove this key from the user config before upgrading the release, otherwise the config is rejected on load. This is an illustrative snippet to merge into an existing user config. Explicitly declared numeric/duration values are still
applied; `null` in a child profile clears a cap inherited from the parent profile. Backoff still grows the delay between
retries. `stall_timeout` only stops workers with no progress signal; task cancellation still works.
Workflow limits (`max_visits`, the model ladder, quality-failure handling), permissions and log/context sizes
still follow their own configuration.

Claude no longer requires `--max-turns` when creating a pin: omit this flag so that `max_turns` in the pin is `null`.
Old pins with a turn count keep the declared cap; recreate the pin with `write-pin --force` to remove the cap.

For Claude, `roles.<role>.limits.max_turns` applies together with the cap in the pin: if both are numbers, the
smaller one is used. Omit both for no limit. This turn cap only applies to Claude;
use wall/stall timeouts for Codex bindings. Running out of turns is a `timeout`, using the timeout's retry/ask-the-operator
mechanism, and does not consume infra retries. Claude always saves the session in the attempt's private home and does not use
`--no-session-persistence`; it only resumes when the manifest has `resume: proven`. From the second review round, the reviewer
resumes the previous round's reviewer session (same revision, step and binding) with a freshly built packet. A reviewer session
is never handed to coder/fixer or vice versa; a new revision or a binding change opens a new session.

Policy/runtime snapshots of tasks that have already run keep their frozen limits. After upgrading the release,
remove the caps from the user config and recreate the pin/manifest per the section below so new tasks use the
unlimited configuration; do not hand-edit snapshots or manifests of old tasks.

## Autonomous

`autonomous: true` in the user config lets a high-level agent answer on your behalf while you are away, for example while you sleep.
Like yolo, this key cannot be enabled via `cusr.yaml` and is reread at runtime (at most 30 seconds after a change),
with no restart needed. The two flags are independent: the decider does not merge, yolo does not answer questions.

```yaml
autonomous: true
roles:
  decider:
    binding:
      - { model: opus, effort: high }
```

The decider uses the first binding of the `decider` role; if this role is missing, the config is rejected. It runs a new, read-only
session within its own read-only boundary (all other workers can write). The new role needs one `prove-harness` and `record-manifest` run (each proof
now costs 4 runs instead of 3). An old manifest can still run coder, fixer, reviewer; in that case the decider reports
`capability_missing` in the log and the question stays open.

- **What it answers:** questions that stop the task at `agent_question`, `agent_needs_context`, `agent_blocked`. All questions
  in one worker result go in a single run. Approvals, merges and other kinds of waits still belong to a human.
- **No cap on the number of calls,** but no back-and-forth: after the decider has answered at a step of a revision,
  the next question at that step waits for a human. Tasks labeled `grill` get multi-turn Q&A with no automatic stopping point.
- **Recording:** the `DeciderRan` event stores the answer, rationale and usage in the same transaction as `QuestionAnswered`
  (`by: agent:decider`). `<data dir>/decisions.md` is fully regenerated from events, so do not edit it by hand; a crash or a file write
  error does not leave a partial entry.
- **Usage:** each run holds a reservation of `budget.agent_runs` before starting. The decider only runs when the task has at least
  2 runs left: one for the decider, one for the resumed worker. If a capped task has fewer than 2 runs left, or the frozen deadline
  has passed, the decider does not run (`no_agent_runs_left`, `task_deadline_passed` in the log) and the question waits for a human. A run does not exceed the task's deadline. Runs that called the model are counted, even on error, and appear in
  `decider_runs` of `task explain`. Exception: a run during which a human answered, cancelled or paused the task is stopped
  immediately and the run is refunded; usage is still recorded in `decider_runs`. The same applies to runs left by a previous daemon: the new daemon
  stops the runner by operation and then reads the result; a runner that stopped without a result is recorded as `cancelled`. A decider run is not an attempt.
- **Turning the flag off:** the daemon rereads the flag right before accepting the result. A run in progress still runs to completion and its usage is counted, but
  the answer is not used and the question stays open.
- **Restart:** the run's ID and input are in `<data dir>/decider/` before it starts. The new daemon waits for the old runner to
  finish and then reads the result, without starting a second run for the same question. A run that had not yet started is dropped, and is not started once
  the flag is off. If no conclusion can be reached, it logs once and the question waits for a human.
- **On error:** the question stays open, the reason is in the log, and that question is not retried until the daemon restarts. A run without
  a declared `wall_timeout` stops after 30 minutes. If a human answers first, the human's answer wins.
- **Pause:** the decider does not run on a paused task. Pausing while the decider is running stops that run, and the question
  waits for a human.
- **Inbox:** questions the decider is answering or about to answer have `decider: true` in `cusr inbox --json`. A human can still answer
  them right away.
- **Waking the assistant:** while the flag is on, questions the decider is about to answer or is answering do not wake the assistant. The assistant
  is only notified when the decider drops the question: the run failed, the answer was not used, it could not start, or no conclusion could be reached
  after a restart. During the short window from daemon startup until the first decider round reads the flag, questions also wait.
- **Reverting:** the decider cannot undo anything. Review `decisions.md`, then revert or create a new task. The decider's run directory
  is not tied to any operation in the store, so retention does not clean it up.

## Auto-confirm intake

Tasks created by the assistant wait for `cusr task confirm` at the intake step by default. List the requesters whose tasks are accepted
immediately in the user config (cannot be declared in `cusr.yaml`):

```yaml
intake:
  auto_confirm: [assistant]
```

The name is the task's `requested_by.id` (`assistant` with the assistant token). The daemon rereads the config each time it creates a task,
with no restart needed; tasks already created do not change. Tasks accepted immediately carry `intake_auto_confirmed: true` in the
`TaskCreated` event. This key only skips the intake step: the run selection (mode, harness/model/effort, reviewer)
must still be confirmed before the first spawn.

## Workflow in the user config

The workflow graph is fixed in code (`software_dev@1`). The user config only selects that graph (`base`, required)
and tunes per-step parameters (`steps`, optional):

```yaml
workflows:
  impl:
    base: software_dev@1
    steps:
      code: { max_visits: 12, max_rung: 2 }
      gates: { run: [build, unit, lint], required: [build, unit] }
      ci: { poll: 1m, timeout: 1h }
```

Declaring steps, `start`, `kind`, `role`, `next`, `on_exhausted`, `uses`, `when`/`skip_when`/`auto_when` or
`decisions` makes the daemon refuse to load the config with `workflow_key_removed` and the path of the key to remove. A config that only
has `base: software_dev@1` (like the dogfood config) needs no changes. How to upgrade an old config and the list of per-step
parameters: [docs/config-upgrade.md](../docs/config-upgrade.md).

Old tasks keep the graph frozen in their policy snapshot: they still run, replay and verify hashes as before,
and the store checks of `cusr doctor` (schema, integrity, replay) remain clean on an old DB. No migration is needed.
If the user config still has old keys, `cusrd` does not start and prints each error in the form
`config.yaml:<line>:<column> workflow_key_removed: ...`, and `cusr doctor` reports the `config` check as failed;
fix the config per the guide and restart the daemon.

## Yolo

`yolo: true` in the user config lets the daemon merge the PR of a task that is waiting for merge on its own. It cannot be enabled via
`cusr.yaml`. The config is reread before each merge, so setting it back to `false` takes effect without a restart;
it cannot stop a request already sent to GitHub.

- `full-review` requires the Cuesura reviewer to approve, except for base integration runs with the scope certification below; this is not a GitHub review.
- `direct-pr` has no reviewer reading the diff: only gates and CI catch errors.
- Branch protection is optional; enabling required checks, "up to date" and applying it to admins is recommended
  as an extra layer enforced by GitHub. Do not require approvals if there is only one account.
- The daemon reads the new tip via `GET branches/{target}`, not `pull.base.sha` (which may be stale).
  The PR must be `clean`, have the right head/target, and the compare `head...target_tip_sha` must return `ahead_by === 0`.
  The compare fetches page 2 with one commit per page to avoid downloading the diff list on page 1, even when head is behind target. The `clean` condition is kept
  conservative: a red non-required check can make GitHub return `unstable` and block yolo.
- Both CI and observation wait for the union of the frozen `ci.required_checks` and the check names GitHub currently requires,
  including checks outside the policy/app pinning; this does not depend on the yolo flag and does not modify FrozenPolicy. Names/apps are
  stored in evidence. If the rules/checks cannot be fully read, permissions are missing, or there is a collision, the condition is not met.
- Base updates and conflict fixes apply even with **yolo off**. A PR waiting for merge that is behind target
  is updated in the task's execution slot, according to the frozen policy and visit/deadline limits.
  Git must support `merge-tree --write-tree` (2.38 or later). With several PRs waiting for merge, later PRs update
  themselves when an earlier PR advances the target.
  - No conflict: no new fixer/reviewer call; run gates, publish and wait for CI on the new head.
  - First conflict: call the fixer exactly once. The host checks the diff against the initial conflict tree;
    every conflicted file must be changed from the initial tree and pass the gates to publish/wait for CI, with no new review.
    Binary/modify-delete conflicts have no markers, but a fixer that does not change the file is still blocked.
  - Changes to files outside the conflict list (including new/renamed files): require review. `full-review` uses
    the existing reviewer; `direct-pr` waits for a human because the snapshot has no confirmed reviewer.
  - Fixer errored/blocked/unfinished, markers remain, gates fail or a conflict recurs: open a question for a human to decide.
    Fix by hand and then answer exactly `continue` to rerun gate/publish/CI; for conflicts without markers, the answer confirms
    the choice to keep the file version as is. Answering exactly `retry fixer` allows one more worker run.
    Polling does not call another fixer by itself; slot/visit/budget/deadline stay unchanged. A flaky gate after a clean merge
    reuses the existing local commit. An old refused wait can open a question with `cusr task recheck`.
    Answer with the existing command: `cusr answer <question-id> --file <answer.txt> --expected-version <version>`.
    With `direct-pr`, out-of-scope changes must be reverted or moved to a new task that has a reviewer.
  - Markers are only searched for in conflicted files, using a silent read; a Markdown heading `=======`
    outside/inside a file is not treated as a marker by itself. A scope read error keeps the task waiting with a question rather than stuck in an effect.
  - Unexpected branch/worktree changes also stop for reconciliation. Durable intent and a certification of the exact
    head/tree/revision keep retries/restarts safe; commits that still have markers are never pushed.
- Before merging, the daemon itself requires the app-pinned checks to pass from the exact `app_id`; it does not trust GitHub
  to block on its behalf, because admins can bypass protection that does not apply to admins.
- Declaring `ci.required_checks` is recommended. If the union is empty, the task still enters waiting for merge as before;
  yolo does not merge and logs once per task per daemon lifetime, instructing you to declare this list.
  All checks currently visible on the head are not used as a fallback, because other workflows may not have created their checks yet.
  A required check passes when its conclusion is `success`, `skipped` or `neutral`, like GitHub branch
  protection; this way a workflow that deliberately skips a required job (e.g. a docs-only PR) does not leave the task waiting until
  `ci_wait_exhausted`. `cancelled`, `timed_out`, `failure`, `action_required`, `startup_failure` and
  `stale` do not pass; a check that is running or not yet present is still waited on. Unlike GitHub, `skipped`/`neutral` only pass
  when no current check of the same head, including non-required checks, has failed or been cancelled: a job
  skipped because a job it `needs` failed is also `skipped`, and code that has not been built/tested must not slip through.
- Errors reading or validating the user config are logged and yolo is treated as off; CI/observation are unaffected.
- Without protection, GitHub does not block the race if the target branch gets a new commit or a check changes its result between
  the daemon's read and the merge. `sha` only guards against the PR head changing; it does not lock the target branch tip or check results.

Example of recommended protection (optional):

```sh
gh api -X PUT repos/<owner>/<repo>/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["build","test"]},"enforce_admins":true,"required_pull_request_reviews":null,"restrictions":null}
JSON
```

Because it has the same UID, the assistant can read and edit the user config: yolo is an operating rule, not a real permission
boundary ([callers and permissions](#callers-and-permissions)).

## Real harness: pin and manifest

`cusrd` only invokes a harness when both owner records exist in `<DATA_DIR>/harnesses/<harness name>/`:

- `pin.json` per `VendorPinSchema`: binary (realpath, version, sha256), toolchain, non-secret env,
  `home_files` pointing to names in `runtime.credential_refs`, settings, `max_turns`, `tools`. The pin is what
  decides which binary runs, not `harnesses.<name>.cmd`. See the verified samples at
  `test/fixtures/runtime/spike-0/harness/real-20261028/pinned-*.json`. Create it with `cusr-runner write-pin`; the command
  takes the version and sha256 from the binary on the host, leaves `env` empty and rejects paths that do not exist on this host.
- `manifest.json`, written only by the command below, from evidence of **exactly that binary and configuration**:

```sh
cusr-runner setup-harness --config ~/.cusr/config.yaml --harness claude --vendor claude \
  --binary "$(command -v claude)" --toolchain /opt/node/bin --auth claude-0:.claude/.credentials.json \
  --settings claude-settings.json --permission-mode auto --sandbox off \
  --model <model-id> --effort <effort> --out evidence-claude.json
```

`setup-harness` uses the same code as the three commands `write-pin`, `prove-harness`, `record-manifest`.
The config is loaded once for the whole flow. Before writing the pin, the command requires `--model`, checks the planned pin
via `planProof` (deny-probe, identity, resume capability) and, if there is a cap, checks total usage spent + runs needed against the cap.
If preflight refuses, the existing pin/manifest/ledger stay intact, even when `--force` is passed.
The pin/proof parameters keep their names; `--out` is both the evidence output file and the input for the manifest.
The owner runs the command, so `--approval` and `--max-invocations` are optional: `--approval` is only recorded in the ledger
(default `owner command`); `--max-invocations` is a positive integer that includes usage already recorded in the ledger for
the same binary, including failed runs; if omitted there is no cap. An existing pin requires
`--force` to overwrite. Any failing step stops immediately, keeps the error code and names the step (JSON has `error.details.step`);
a failed proof does not write a manifest. A pin or evidence written before the failure is kept for debugging.

Add `--dry-run` to see `invocations_spent` (already spent) and `invocations_needed` (still needed), without calling the model
and without writing the pin, evidence, manifest or ledger. Dry-run checks the planned pin by the same rules as `write-pin`,
and needs no `--force`, approval or cap to view the plan. The report has `pin_exists`: if it is `true`,
a real run starting from `write-pin` needs `--force` to replace the pin; `--from prove-harness` reuses the pin so
it does not need this flag. The version/host probes still run.

Preflight is a check at planning time. The real proof still rereads the ledger: if another proof spends
usage after preflight, the proof may be refused even though the pin has been written. In that case continue with
`--from prove-harness` with a re-approved total cap, without rewriting the pin. The command does not raise the cap by itself.

When an execution step fails, continue with `--from` to reuse the pin/evidence already written:

```sh
# Proof failed: reuse the written pin, no --vendor/--binary/--force needed.
# The proof reruns all roles; the cap still counts runs already spent.
cusr-runner setup-harness --from prove-harness --config ~/.cusr/config.yaml --harness claude \
  --model <model-id> --effort <effort> --max-invocations <total-cap> --approval "<approver, date>" \
  --out evidence-claude.json
# Only the manifest failed: check that the evidence matches the current pin, then write the manifest, without calling the model.
# No --model, --approval, --max-invocations or --force needed.
cusr-runner setup-harness --from record-manifest --config ~/.cusr/config.yaml --harness claude \
  --out evidence-claude.json
```

`--from record-manifest --dry-run` checks evidence/pin/permissions as a real write would, reports `invocations_needed: 0`
and does not write the manifest. Evidence that does not pass or does not match the pin is still rejected. If valid evidence already exists,
`record-manifest --evidence <file>` can also fix the manifest without spending model usage; doctor's hints prefer
this. The three separate commands are kept for debugging:

```sh
cusr-runner write-pin --config ~/.cusr/config.yaml --harness claude --vendor claude \
  --binary "$(command -v claude)" --toolchain /opt/node/bin --auth claude-0:.claude/.credentials.json \
  --settings claude-settings.json --permission-mode auto --sandbox off
cusr-runner prove-harness --config ~/.cusr/config.yaml --harness claude \
  --model <model-id> --effort <effort> --out evidence-claude.json
cusr-runner record-manifest --config ~/.cusr/config.yaml --harness claude --evidence evidence-claude.json
```

To enable resume for Claude or Codex, add `--prove-resume` to `setup-harness` (or to the separate `prove-harness` command).
This probe needs one more invocation beyond the roles `coder`, `fixer`, `reviewer`, `decider` in `PROOF_ROLES`:
currently 5 runs in total instead of 4 (dry-run shows the number needed). The probe tries to continue with a new private home
and recall a nonce that exists only in the previous conversation. Only passing probe evidence writes `session_resume: proven`;
after a successful setup, restart the daemon. Resume carries only the exact session's data, not the auth/settings
of the old attempt: for Claude that is the transcript and tool data in `.claude/projects/`, for Codex the rollout file
`.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` of the exact thread. If the harness has not proven resume,
the daemon records the reason and uses a new session with full context, for both workers and reviewers.

Codex resumes with `codex exec <same flags as a new session> resume <thread_id> -`. The `resume` subcommand (0.167.0)
has no separate `-C`, `--sandbox`, `--add-dir`, but `exec` flags placed before `resume` still apply
to the resume run, so cwd, sandbox and the effective permission hash stay the same as a new session. A resume run re-emits
`thread.started` with the same `thread_id`. Codex manifests written before this change have no `session_resume`,
so they keep running new sessions until `setup-harness --prove-resume` is run again.

If the old transcript/run is gone, the worker uses a new session with full context and records `resume_fallback: session_missing`;
it does not wait for the operator just to restore the conversation. `--prove-resume` evidence has `resume_probe` recording
the outcome and the specific cause, even when the coder failed or did not return a session so the probe was not run.

Each vendor in the evidence must have `binary.sha256` and `attested` containing `settings_hash`, `environment_hash`
(env, toolchain, `home_files`, `max_turns`, `tools`), `host_policy_hash`, and `layout_shapes` of the proof run.
The command compares each field with the pin and the current host, rejects any mismatch and prints the expected value; changing any field of the
pin requires proving again, and a pin edited after it was written blocks requests and the next attempt. Changing the
credential file path does not: the evidence does not depend on where the file is. Evidence recorded before attestation existed has no `attested` so it cannot be used. `record-manifest` does not call the harness and spends no usage; the proof step of `setup-harness` does call the model.

Harness tools are looked up on the pin's toolchain plus the daemon PATH. Setup/gate use the daemon's Node directory
plus the daemon PATH; preflight uses exactly the same list as the executing command. When running the daemon with systemd, set
`Environment=PATH=...` in the service if tools like pnpm are only on the shell PATH. A shell PATH that differs from the daemon's
does not invalidate the manifest; required dependencies must be present in the execution environment. The Claude reviewer always needs native dependencies, usually including `bwrap` and `socat`,
even when the worker turns the sandbox off or uses full access.
Doctor/preflight check executable files on the host and do not create an outer sandbox to probe.

The proof checks a rule that denies a write command **inside the worktree**. Roles with the sandbox on must also prove
that the native sandbox blocks a write command to a host path outside the worktree; workers that choose off do not run this probe. Add the following deny rule to the Claude settings used to write the pin:

```json
{"permissions":{"deny":["Bash(/usr/bin/touch permission-denied-by-rule)"]}}
```

For Codex, the pinned `.codex/rules/` file needs the corresponding rule:

```python
prefix_rule(pattern=["/usr/bin/touch", "permission-denied-by-rule"], decision="forbidden")
```

For Codex, `prove-harness` additionally runs `codex sandbox` directly, without calling the model, because `exec --json` has no
event for commands refused by the sandbox. The `/usr/bin/true` command must run, and the write command must be refused by the operating system.

Keep other owner rules when adding this rule. The deny command uses a relative path to check the marker right inside the
real worktree; old rules pointing to `/cusr/scratch` do not prove the new host contract. The native probe only passes when the
**tool execution** log has an OS error refusing the write and the target file does not appear; a valid answer or a rule refusing the tool
is not enough. A Claude worker with the sandbox off records `native_result=not_tried`; auto uses mode `permissions_only`,
full access uses `full_access`. A worker with the sandbox on always needs `native_result=passed`, including full access.
The reviewer still runs the native negative probe. Changing the sandbox also requires recreating the proof/manifest; evidence
of the old choice is not accepted.

`prove-harness` returns an error code and states the reason when the evidence is not enough to create a usable manifest, while still writing the evidence file
for later reading. `record-manifest` rejects that evidence with exactly the check the daemon uses when loading records.
`cusr-runner check-records --config <file> --data-dir <dir>` checks the config and every harness record against the release running
the command, without calling the model; run it with the new release before switching to it.

Claude needs a `TMPDIR` short enough for the sandbox's Unix socket (paths up to 108 bytes), so each Claude run gets its own
0700 directory `/tmp/cusr-<hash>`, deleted when the run ends. On hosts where `/tmp` is a small tmpfs, writing large temporary files during
an agent run will take space there. Setup, gate, autofix and Codex still use their own scratch as `TMPDIR`.

After upgrading the release, run `setup-harness --force` with the full pin/proof parameters,
`--permission-mode auto` or `full-access`, without `--outer-proof`, then restart the daemon. Old manifests proving outer bwrap
cannot be used for native execution. Tasks frozen under outer bwrap must finish/be cancelled on the old
release and new tasks created; do not change a running snapshot. Changing the pin mode also requires a corresponding proof/manifest.

Push is still done by the daemon via a trusted credential helper. Role/model/workflow and merge keep the same contract.

## Network and credentials

Cuesura runs on the host and adds no network namespace or egress firewall. Command networking is decided by the host and the
native harness. Each attempt has its own home holding the harness login files and session; credentials
are masked before logs are stored, and cusr's orchestration token does not enter the worker or gate environment.

Workers run like a session the owner opened themselves, similar to how Orca runs agents per account:

- `HOME` is the owner's real home, so dotfiles, `gh`, `git`, `ssh`, `~/.agents/skills` work as usual.
  Only `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point into the attempt's private home, which holds the login files and
  session. The private home links to the owner's harness configuration: `~/.claude` (`CLAUDE.md`, `settings.json`,
  `skills`, `agents`, `commands`, `plugins`, `output-styles`, `hooks`) and `~/.codex` (`config.toml`,
  `AGENTS.md`, `skills`, `prompts`); MCP servers declared in `~/.claude.json` are copied over.
- The environment is the daemon's environment (PATH plus the pin's toolchain), except `CUSR_*` variables and variables of a
  wrapping agent session (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX*`). The pin can set any variable,
  including secrets such as API keys for MCP servers; logs still mask secret values. To give workers the same PATH as the
  owner's shell, set `Environment=PATH=…` in the systemd unit.
- Claude uses the default tool set as in an interactive session; the pin's `--tools` no longer has any effect. Codex loads the
  owner's `config.toml` and enables all features; cusr's flags override that config.
- Coder/fixer may commit in the worktree, on the task's branch; the daemon commits the rest, then pushes
  fast-forward and opens the PR. The reviewer may edit, run tests and commit; after the review run the daemon returns the branch and files
  to their pre-review state (gitignored files are kept). Only the decider remains read-only.

Same-UID processes can read host files as the OS permits; the private home is not a security boundary.

Upgrading to this release: the Codex argv changed, so old Codex manifests no longer match. Rerun the proof with the existing pin
(`cusr-runner setup-harness … --harness codex --from prove-harness`) and restart the daemon. Claude pins with the
sandbox on also need a new proof; Claude pins with the sandbox off keep their manifest.

### Harness login sessions

Each attempt gets a copy of the login file (`--auth`) in its private home. Harnesses that log in with OAuth
(Claude, Codex) refresh the session themselves when the access token expires, and the provider usually rotates the refresh
token as well; the copy is deleted after the attempt, so previously the new refresh token was lost with it, the original file kept the old, already
revoked token, and every later attempt reported `Failed to authenticate: OAuth session expired and could not be
refreshed`. Now, before deleting, the daemon writes the refreshed copy back to the original file (write a temp file then rename,
preserving file permissions) when all three conditions hold: the copy has changed, the original file still has the content it had when copied, and the
copy is still JSON with the same key structure as the original. If the original file has changed (the user just logged in again, or
another attempt wrote first), the original is kept. A `--rule` file with a sha256 in the pin is never written back.
Workers can still read the token in their home as before; the write-back only keeps the session usable.

When the harness reports a login error, the task does not retry but waits at `WAITING/policy harness_auth` on that exact step.
Log in to the harness again on the host, using exactly the file that `runtime.credential_refs` points to (e.g.
`~/.claude/.credentials.json`; logging in under a different Claude profile does not change this file), then run
`cusr task recheck <id>`: that step reruns, keeping the worktree, review and gates, and the run that failed to log in is
refunded its visit. If login is still broken, the new run waits at `harness_auth` again.

A `loop_exhausted` task whose last runs of a step all failed due to infrastructure, rate limits or login (e.g. a task
running on an old release, when OAuth errors were still classified as `infra`): fix the cause, then `cusr task recheck <id>`
refunds the visits of that run sequence and reruns the step. Quality-failure runs are never refunded; the agent run
budget, deadline and model ladder stay unchanged. `task explain` only offers `recheck` when this condition holds.

`cusr doctor` reads the login file only to get the refresh token expiry (Claude's `refreshTokenExpiresAt`),
without printing the token value: if expired, `credential:*` reports an error. An unexpired date does not prove the provider still
accepts the session (the token may have been revoked); files without this field (Codex, API keys) are only checked
for existence.
