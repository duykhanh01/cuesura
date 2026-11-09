# View agents in a terminal multiplexer; systemd still owns the lifecycle

The default `runtime.terminal.backend` is `background`: the agent runs in the background inside a systemd unit, as in
[ADR-0002](0002-systemd-runner-lifetime.md). Choosing `herdr` starts each `agent` operation from a background tab in
the `cuesura` workspace, using exactly the `systemd-run` command plus `--pty`. Changing the backend only requires
changing the config and restarting `cusrd`. Choosing `orca`, `paseo` or `tmux` works the same way, differing only in
where the tab is shown (see below). Adding a new backend is one schema variant and one `TerminalHost`.

The service is still `cusr-op-<operation>.service`, so inspect, stop, cgroup and recovery are unchanged; the terminal
only holds the pty end. Rejected alternatives: `systemd-run --scope` inside the pane (tried: the scope dies with the
herdr server, violating ADR-0002); `herdr agent start` with an interactive TUI (loses the stream-json contract, so the
state has to be guessed from the terminal, see [architecture §4](../architecture.md)).

The pane has no say over the operation. Tried on systemd 255 and herdr 0.9.5: Ctrl-C in the pane, and stopping the
herdr server entirely, do not stop the agent; `systemctl stop` still stops it cleanly. To achieve that, the unit ignores
`TERM INT HUP` at `flock`, and the runner installs its own handler, because Node resets dispositions at startup. The
runner writes to the terminal through a non-blocking descriptor; a record that cannot be written is dropped. The event
log remains the only record, so a hung terminal does not keep the runner alive.

If the backend is not ready, the agent runs in the background and the daemon logs this without breaking the task: both
paths have the same unit, env and result contract. A command already typed into the pane can run late, even after the
daemon crashes, though the host left no trace of it beforehand. Within one operation, the unit name, the operation lock
and the launch marker prevent double runs. A replacement attempt is a different operation, so before reporting
`not_launched` the daemon claims `launch.json` with a `fence` marker: writing the marker is atomic, and a late runner
finds `marker_exists` and spawns nothing. `cusr doctor` reports when the backend is unreachable. The pane's shell runs
in the data dir, not in the worktree, so the shell's hooks do not run in the worktree. The tab carries the role name and
task title (`coder: …`). This name is for display only and is not part of the input digest, so a run started before it
existed can still be recovered. The tab closes when the operation finishes; review it with `cusr task logs`.

Orca has no free-standing workspace: every terminal belongs to a project, and the CLI can only register a git repo. So
Cuesura creates an empty repo at `<data dir>/cuesura`, registers it when `terminal create` reports that there is no
project, and the shell runs inside that repo. Rejected alternatives: opening the tab in the task's worktree (violates the
rule that the shell is not in the worktree, and Cuesura's worktrees are not managed by Orca); `orca agent launch` (same
reason as `herdr agent start`). Tried on Orca 1.4.246 with a separate runtime: closing the tab, Ctrl-C and stopping the
whole Orca server do not stop the unit.

Paseo also attaches terminals to a workspace, but a workspace can be opened in any directory, needs no git, and the app
names the project after the directory name. Cuesura opens the terminal at `<data dir>/paseo/cuesura-<project>`, so each
task project is a project `cuesura-<project>` in the app. The `cuesura-` prefix keeps it separate from a project of the
same name that the user opens themselves: Paseo distinguishes projects by path but shows the same name. Rejected
alternative: opening in the worktree so the agent appears directly in the real project (violates the rule that the shell
is not in the worktree). Concurrent `terminal create` calls into one new directory create several workspaces, so Cuesura
creates terminals one at a time. The Paseo CLI is a Node script that calls `env node`, but the daemon's external commands
run with a minimal PATH, so Cuesura runs it with the daemon's own node. Rejected alternative: `paseo run` (same reason as
`herdr agent start`; the agent also becomes a child process of the Paseo daemon, losing the systemd unit, pin and harness
proof). Tried on Paseo 0.13.0: killing the terminal and stopping the whole Paseo daemon do not stop the unit.

tmux opens each operation in a window created with `new-window -d` in the `cuesura` session, creating the session with
`new-session -d` when it does not exist, then types the command with `send-keys`; the window the user is viewing does not
change. Cuesura uses only the tmux server the user is already running and never starts one itself: a server started by
the daemon sits in the `cusrd` cgroup, dies on every daemon restart, and its shells get the daemon's minimal env. Without
a server, `list-sessions` fails, the agent runs in the background like any unavailable backend, and `cusr doctor` reports
it using that same command. Rejected alternative: running the shim directly in a dedicated `cusr-<task>` session (the old
approach described in architecture §4.2; it loses the systemd unit, as `systemd-run --scope` does above).
