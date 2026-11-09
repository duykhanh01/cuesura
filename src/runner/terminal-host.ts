/**
 * A terminal multiplexer that shows an agent operation (ADR-0006). The host only holds the terminal end: the
 * operation stays a transient systemd service, so its lifetime, stop and recovery do not depend on the host,
 * and another backend only has to implement `TerminalHost`.
 */
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { OperationLaunch } from '../adapters/ports.ts';
import type { AttachedTerminal } from '../config/schema-user.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { CommandExec } from './supervisor.ts';

export type TerminalRequest = {
  /** Shown by the multiplexer; never parsed back. */
  readonly label: string;
  /** The task's project, for a backend that groups terminals by it. */
  readonly project?: string;
  readonly cwd: string;
  /** One shell line, typed into the new terminal's shell. */
  readonly command: string;
};

export type TerminalHandle = {
  /** Best effort: closes the terminal and whatever is still queued in its shell. */
  close(): Promise<void>;
};

export interface TerminalHost {
  readonly name: string;
  open(req: TerminalRequest): Promise<Result<TerminalHandle, string>>;
}

const LABEL_MAX = 40;

/** The run's title, or its worktree when it has none; a multiplexer shows it as typed, controls included. */
export function terminalLabel(spec: Pick<OperationLaunch, 'cwd' | 'view'>): string {
  const text = (spec.view?.title ?? basename(spec.cwd)).replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return [...text].slice(0, LABEL_MAX).join('').trimEnd();
}

/** POSIX single quoting: the line goes through the user's interactive shell. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
}

const WorkspaceListSchema = z.object({
  result: z.object({
    workspaces: z.array(z.object({ workspace_id: z.string(), label: z.string().nullish() })),
  }),
});
const CreatedSchema = z.object({
  result: z.object({
    workspace: z.object({ workspace_id: z.string() }).optional(),
    tab: z.object({ tab_id: z.string() }),
    root_pane: z.object({ pane_id: z.string() }),
  }),
});

export const HERDR_WORKSPACE_LABEL = 'cuesura';
const HERDR_TIMEOUT_MS = 15_000;

export type HerdrTerminalOptions = {
  /** Absolute path of the herdr binary. */
  readonly bin: string;
  /** Named herdr session; the user's default session when absent. */
  readonly session?: string;
  readonly exec: CommandExec;
};

/** One `cuesura` workspace, one background tab per operation; the user's focus is never moved. */
export class HerdrTerminal implements TerminalHost {
  readonly name = 'herdr';
  readonly #bin: string;
  readonly #session: readonly string[];
  readonly #exec: CommandExec;
  /** Two concurrent launches must not both create the workspace. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: HerdrTerminalOptions) {
    this.#bin = opts.bin;
    this.#session = opts.session === undefined ? [] : ['--session', opts.session];
    this.#exec = opts.exec;
  }

  async #cli(args: readonly string[]): Promise<Result<unknown, string>> {
    const r = await this.#exec(this.#bin, [...this.#session, ...args], {
      timeout_ms: HERDR_TIMEOUT_MS,
    });
    const verb = args.slice(0, 2).join(' ');
    if (r.error !== null) return err(`herdr ${verb}: ${r.error}`);
    if (r.timed_out) return err(`herdr ${verb}: timed out`);
    if (r.code !== 0) return err(`herdr ${verb}: exit ${String(r.code)}: ${r.stderr.trim()}`);
    try {
      return ok(r.stdout === '' ? null : (JSON.parse(r.stdout) as unknown));
    } catch {
      return err(`herdr ${verb}: output is not JSON`);
    }
  }

  async #openTab(
    req: TerminalRequest,
  ): Promise<Result<z.infer<typeof CreatedSchema>['result'], string>> {
    const list = await this.#cli(['workspace', 'list']);
    if (!list.ok) return list;
    const workspaces = WorkspaceListSchema.safeParse(list.value);
    if (!workspaces.success) return err('herdr workspace list: unexpected shape');
    const existing = workspaces.data.result.workspaces.find(
      (w) => w.label === HERDR_WORKSPACE_LABEL,
    );
    const created = await this.#cli(
      existing === undefined
        ? ['workspace', 'create', '--cwd', req.cwd, '--label', HERDR_WORKSPACE_LABEL, '--no-focus']
        : [
            'tab',
            'create',
            '--workspace',
            existing.workspace_id,
            '--cwd',
            req.cwd,
            '--label',
            req.label,
            '--no-focus',
          ],
    );
    if (!created.ok) return created;
    const parsed = CreatedSchema.safeParse(created.value);
    return parsed.success ? ok(parsed.data.result) : err('herdr tab create: unexpected shape');
  }

  open(req: TerminalRequest): Promise<Result<TerminalHandle, string>> {
    const opened = this.#queue.then(() => this.#openTab(req));
    this.#queue = opened.catch(() => undefined);
    return opened.then(async (tab) => {
      if (!tab.ok) return tab;
      const { tab_id, pane_id } = {
        tab_id: tab.value.tab.tab_id,
        pane_id: tab.value.root_pane.pane_id,
      };
      const close = async (): Promise<void> => {
        await this.#cli(['tab', 'close', tab_id]);
      };
      if (tab.value.workspace !== undefined) await this.#cli(['tab', 'rename', tab_id, req.label]);
      const run = await this.#cli(['pane', 'run', pane_id, req.command]);
      if (!run.ok) {
        await close();
        return run;
      }
      return ok({ close });
    });
  }
}

const OrcaReplySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
const OrcaCreatedSchema = z.object({
  result: z.object({ terminal: z.object({ handle: z.string() }) }),
});

/** Names the project in Orca's sidebar: Orca titles a project after its directory. */
export const ORCA_PROJECT_DIR = 'cuesura';
const ORCA_TIMEOUT_MS = 15_000;
const ORCA_NO_WORKSPACE = 'selector_not_found';

type OrcaFailure = { readonly code: string | null; readonly message: string };

export type OrcaTerminalOptions = {
  /** Absolute path of the orca command. */
  readonly bin: string;
  /** Orca's CLI only registers git repositories, so the project needs one. */
  readonly git: string | null;
  readonly exec: CommandExec;
};

/**
 * One `cuesura` project, one tab per operation; a tab created without `--focus` does not take the user's focus.
 * Every Orca terminal belongs to a project, and the project is an empty repository of its own so that the shell
 * still never starts in a worktree.
 */
export class OrcaTerminal implements TerminalHost {
  readonly name = 'orca';
  readonly #bin: string;
  readonly #git: string | null;
  readonly #exec: CommandExec;
  /** The first launches arrive together and concurrent `git init`s of one directory can fail; they share one. */
  #registering: Promise<Result<null, string>> | null = null;

  constructor(opts: OrcaTerminalOptions) {
    this.#bin = opts.bin;
    this.#git = opts.git;
    this.#exec = opts.exec;
  }

  async #cli(args: readonly string[]): Promise<Result<unknown, OrcaFailure>> {
    const r = await this.#exec(this.#bin, [...args, '--json'], {
      timeout_ms: ORCA_TIMEOUT_MS,
    });
    const verb = args.slice(0, 2).join(' ');
    const failure = (message: string, code: string | null = null) =>
      err({ code, message: `orca ${verb}: ${message}` });
    if (r.error !== null) return failure(r.error);
    if (r.timed_out) return failure('timed out');
    let reply: unknown;
    try {
      reply = JSON.parse(r.stdout) as unknown;
    } catch {
      return failure(
        r.code === 0 ? 'output is not JSON' : `exit ${String(r.code)}: ${r.stderr.trim()}`,
      );
    }
    if (r.code === 0) return ok(reply);
    // A failed call still answers in JSON, on stdout.
    const parsed = OrcaReplySchema.safeParse(reply);
    const error = parsed.success ? parsed.data.error : undefined;
    return error === undefined
      ? failure(`exit ${String(r.code)}`)
      : failure(error.message, error.code);
  }

  /** Cleared when done: a project removed from Orca later is registered again. */
  #registerOnce(dir: string): Promise<Result<null, string>> {
    this.#registering ??= this.#registerProject(dir).finally(() => {
      this.#registering = null;
    });
    return this.#registering;
  }

  /** Safe to repeat in sequence: `git init` and `repo add` both leave an existing registration as it is. */
  async #registerProject(dir: string): Promise<Result<null, string>> {
    if (this.#git === null) return err('git was not found');
    const init = await this.#exec(this.#git, ['init', '--quiet', '--template=', dir], {
      timeout_ms: ORCA_TIMEOUT_MS,
    });
    if (init.error !== null || init.timed_out || init.code !== 0)
      return err(`git init: ${init.error ?? (init.timed_out ? 'timed out' : init.stderr.trim())}`);
    const added = await this.#cli(['repo', 'add', '--path', dir]);
    return added.ok ? ok(null) : err(added.error.message);
  }

  async open(req: TerminalRequest): Promise<Result<TerminalHandle, string>> {
    const dir = join(req.cwd, ORCA_PROJECT_DIR);
    const create = () =>
      this.#cli([
        'terminal',
        'create',
        '--worktree',
        `path:${dir}`,
        '--title',
        req.label,
        '--command',
        req.command,
      ]);
    let created = await create();
    if (!created.ok && created.error.code === ORCA_NO_WORKSPACE) {
      const registered = await this.#registerOnce(dir);
      if (!registered.ok) return registered;
      created = await create();
    }
    if (!created.ok) return err(created.error.message);
    const parsed = OrcaCreatedSchema.safeParse(created.value);
    if (!parsed.success) return err('orca terminal create: unexpected shape');
    const { handle } = parsed.data.result.terminal;
    return ok({
      close: async () => {
        await this.#cli(['terminal', 'close', '--terminal', handle, '--tab']);
      },
    });
  }
}

const PaseoErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
const PaseoCreatedSchema = z.object({ id: z.string().min(1) });

/** Names the project in Paseo's app: Paseo titles a workspace's project after its directory. */
export const PASEO_WORKSPACE_DIR = 'cuesura';

/**
 * One directory, so one Paseo project, per task project. The prefix keeps it apart from a project of the same
 * name the user opened in Paseo, which Paseo would show under the same title.
 */
export function paseoWorkspaceDir(dataDir: string, project?: string): string {
  if (project === undefined) return join(dataDir, PASEO_WORKSPACE_DIR);
  const name = project.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64);
  return join(dataDir, 'paseo', `${PASEO_WORKSPACE_DIR}-${name}`);
}
const PASEO_TIMEOUT_MS = 15_000;

export type PaseoTerminalOptions = {
  /** The paseo CLI script. */
  readonly bin: string;
  /** Runs the script: its `env node` shebang finds nothing on the minimal PATH of `exec`. */
  readonly node: string;
  readonly exec: CommandExec;
  readonly mkdir?: (dir: string) => Promise<unknown>;
};

/**
 * One terminal per operation in a `cuesura` workspace of the local Paseo daemon, which also shows it in Paseo's
 * apps. The workspace's directory is the data dir's `cuesura`, so the shell never starts in a worktree.
 */
export class PaseoTerminal implements TerminalHost {
  readonly name = 'paseo';
  readonly #bin: string;
  readonly #node: string;
  readonly #exec: CommandExec;
  readonly #mkdir: (dir: string) => Promise<unknown>;
  /** Concurrent creates for one new directory each open a separate workspace. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: PaseoTerminalOptions) {
    this.#bin = opts.bin;
    this.#node = opts.node;
    this.#exec = opts.exec;
    this.#mkdir = opts.mkdir ?? ((dir) => mkdir(dir, { recursive: true, mode: 0o700 }));
  }

  async #cli(args: readonly string[]): Promise<Result<unknown, string>> {
    const r = await this.#exec(this.#node, [this.#bin, ...args, '--json'], {
      timeout_ms: PASEO_TIMEOUT_MS,
    });
    const verb = args.slice(0, 2).join(' ');
    if (r.error !== null) return err(`paseo ${verb}: ${r.error}`);
    if (r.timed_out) return err(`paseo ${verb}: timed out`);
    let reply: unknown;
    try {
      reply = JSON.parse(r.stdout) as unknown;
    } catch {
      return err(
        r.code === 0
          ? `paseo ${verb}: output is not JSON`
          : `paseo ${verb}: exit ${String(r.code)}: ${r.stderr.trim()}`,
      );
    }
    if (r.code === 0) return ok(reply);
    // A failed call still answers in JSON, on stdout.
    const failure = PaseoErrorSchema.safeParse(reply);
    return err(
      failure.success
        ? `paseo ${verb}: ${failure.data.error.message}`
        : `paseo ${verb}: exit ${String(r.code)}`,
    );
  }

  async #create(req: TerminalRequest): Promise<Result<string, string>> {
    const dir = paseoWorkspaceDir(req.cwd, req.project);
    try {
      await this.#mkdir(dir);
    } catch (e) {
      return err(`paseo workspace directory: ${String(e)}`);
    }
    const created = await this.#cli(['terminal', 'create', '--cwd', dir, '--name', req.label]);
    if (!created.ok) return created;
    const parsed = PaseoCreatedSchema.safeParse(created.value);
    return parsed.success ? ok(parsed.data.id) : err('paseo terminal create: unexpected shape');
  }

  open(req: TerminalRequest): Promise<Result<TerminalHandle, string>> {
    const created = this.#queue.then(() => this.#create(req));
    this.#queue = created.catch(() => undefined);
    return created.then(async (id) => {
      if (!id.ok) return id;
      const close = async (): Promise<void> => {
        await this.#cli(['terminal', 'kill', id.value]);
      };
      // The carriage return submits the line, as Enter would.
      const sent = await this.#cli([
        'terminal',
        'send-keys',
        '--literal',
        id.value,
        `${req.command}\r`,
      ]);
      if (!sent.ok) {
        await close();
        return sent;
      }
      return ok({ close });
    });
  }
}

export const TMUX_SESSION = 'cuesura';
const TMUX_TIMEOUT_MS = 15_000;
const TMUX_WINDOW_ID = /^@\d+$/;

export type TmuxTerminalOptions = {
  /** Absolute path of the tmux binary. */
  readonly bin: string;
  readonly exec: CommandExec;
};

/**
 * One detached window per operation in a `cuesura` session of the user's running tmux server; `-d` keeps the
 * user's current window. It never starts a server itself: one started by the daemon would live in the daemon's
 * cgroup and die with every daemon restart, and its shells would inherit the daemon's minimal environment.
 */
export class TmuxTerminal implements TerminalHost {
  readonly name = 'tmux';
  readonly #bin: string;
  readonly #exec: CommandExec;
  /** Two concurrent launches must not both create the session. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(opts: TmuxTerminalOptions) {
    this.#bin = opts.bin;
    this.#exec = opts.exec;
  }

  async #cli(args: readonly string[]): Promise<Result<string, string>> {
    const r = await this.#exec(this.#bin, args, { timeout_ms: TMUX_TIMEOUT_MS });
    const verb = args[0] ?? '';
    if (r.error !== null) return err(`tmux ${verb}: ${r.error}`);
    if (r.timed_out) return err(`tmux ${verb}: timed out`);
    if (r.code !== 0) return err(`tmux ${verb}: exit ${String(r.code)}: ${r.stderr.trim()}`);
    return ok(r.stdout.trim());
  }

  async #openWindow(req: TerminalRequest, retry = true): Promise<Result<string, string>> {
    // Fails when no server runs, unlike `has-session`, which cannot tell that apart from a missing session.
    const sessions = await this.#cli(['list-sessions', '-F', '#{session_name}']);
    if (!sessions.ok) return sessions;
    const exists = sessions.value.split('\n').includes(TMUX_SESSION);
    const window = ['-n', req.label, '-c', req.cwd, '-P', '-F', '#{window_id}'];
    const created = await this.#cli(
      exists
        ? ['new-window', '-d', '-t', `=${TMUX_SESSION}:`, ...window]
        : ['new-session', '-d', '-s', TMUX_SESSION, ...window],
    );
    // tmux drops a session with its last window, so it can vanish after the listing. Listing again
    // instead of creating straight away keeps a server that went with it from being restarted here.
    if (!created.ok && exists && retry) return this.#openWindow(req, false);
    if (!created.ok) return created;
    return TMUX_WINDOW_ID.test(created.value)
      ? ok(created.value)
      : err(`tmux ${exists ? 'new-window' : 'new-session'}: unexpected output`);
  }

  open(req: TerminalRequest): Promise<Result<TerminalHandle, string>> {
    const opened = this.#queue.then(() => this.#openWindow(req));
    this.#queue = opened.catch(() => undefined);
    return opened.then(async (window) => {
      if (!window.ok) return window;
      const close = async (): Promise<void> => {
        await this.#cli(['kill-window', '-t', window.value]);
      };
      const typed = await this.#cli(['send-keys', '-t', window.value, '-l', '--', req.command]);
      const sent = typed.ok ? await this.#cli(['send-keys', '-t', window.value, 'Enter']) : typed;
      if (!sent.ok) {
        await close();
        return sent;
      }
      return ok({ close });
    });
  }
}

/** The only place that knows the backends; the config value picks one, nothing else changes. */
export function terminalHost(
  config: AttachedTerminal,
  deps: {
    readonly bin: string;
    readonly git: string | null;
    readonly exec: CommandExec;
    readonly node?: string;
  },
): TerminalHost {
  switch (config.backend) {
    case 'paseo':
      return new PaseoTerminal({
        bin: deps.bin,
        node: deps.node ?? process.execPath,
        exec: deps.exec,
      });
    case 'orca':
      return new OrcaTerminal(deps);
    case 'herdr':
      return new HerdrTerminal({
        ...deps,
        ...(config.session === undefined ? {} : { session: config.session }),
      });
    case 'tmux':
      return new TmuxTerminal(deps);
  }
}

/** A read-only command that succeeds when the backend's server can take a terminal. */
export function terminalProbeArgs(config: AttachedTerminal): string[] {
  switch (config.backend) {
    case 'paseo':
      return ['workspace', 'ls', '--json'];
    case 'orca':
      return ['repo', 'list', '--json'];
    case 'herdr':
      return [
        ...(config.session === undefined ? [] : ['--session', config.session]),
        'workspace',
        'list',
      ];
    case 'tmux':
      return ['list-sessions'];
  }
}

/** Per-user directories installers use, relative to home; a service's PATH often lacks them. */
const TERMINAL_INSTALL_DIRS: Record<AttachedTerminal['backend'], readonly string[]> = {
  herdr: ['.local/bin'],
  orca: ['.config/orca/cli/bin', '.local/bin'],
  paseo: ['.local/bin'],
  tmux: ['.local/bin'],
};

/** The argv prefix that runs the backend's binary; Paseo's CLI is a Node script without a node on PATH. */
export function terminalArgv(
  config: AttachedTerminal,
  bin: string,
  node: string = process.execPath,
): string[] {
  return config.backend === 'paseo' ? [node, bin] : [bin];
}

/** The backend's binary without configuration: `tool_paths` wins, then PATH, then the install directories. */
export async function findTerminalBin(
  config: AttachedTerminal,
  toolPaths: Partial<Record<AttachedTerminal['backend'], string>>,
  host: {
    findExecutable(name: string, extraDirs?: readonly string[]): Promise<string | null>;
  },
  home: string = homedir(),
): Promise<string | null> {
  return (
    toolPaths[config.backend] ??
    host.findExecutable(
      config.backend,
      TERMINAL_INSTALL_DIRS[config.backend].map((dir) => join(home, dir)),
    )
  );
}
