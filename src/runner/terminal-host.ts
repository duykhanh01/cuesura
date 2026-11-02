/**
 * A terminal multiplexer that shows an agent operation (ADR-0006). The host only holds the terminal end: the
 * operation stays a transient systemd service, so its lifetime, stop and recovery do not depend on the host,
 * and a second backend (tmux) only has to implement `TerminalHost`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AttachedTerminal } from '../config/schema-user.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { CommandExec } from './supervisor.ts';

export type TerminalRequest = {
  /** Shown by the multiplexer; never parsed back. */
  readonly label: string;
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

/** POSIX single quoting: the line goes through the user's interactive shell. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
}

const WorkspaceListSchema = z.object({
  result: z.object({
    workspaces: z.array(
      z.object({ workspace_id: z.string(), label: z.string().nullish() }),
    ),
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
    this.#session =
      opts.session === undefined ? [] : ['--session', opts.session];
    this.#exec = opts.exec;
  }

  async #cli(args: readonly string[]): Promise<Result<unknown, string>> {
    const r = await this.#exec(this.#bin, [...this.#session, ...args], {
      timeout_ms: HERDR_TIMEOUT_MS,
    });
    const verb = args.slice(0, 2).join(' ');
    if (r.error !== null) return err(`herdr ${verb}: ${r.error}`);
    if (r.timed_out) return err(`herdr ${verb}: timed out`);
    if (r.code !== 0)
      return err(`herdr ${verb}: exit ${String(r.code)}: ${r.stderr.trim()}`);
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
    if (!workspaces.success)
      return err('herdr workspace list: unexpected shape');
    const existing = workspaces.data.result.workspaces.find(
      (w) => w.label === HERDR_WORKSPACE_LABEL,
    );
    const created = await this.#cli(
      existing === undefined
        ? [
            'workspace',
            'create',
            '--cwd',
            req.cwd,
            '--label',
            HERDR_WORKSPACE_LABEL,
            '--no-focus',
          ]
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
    return parsed.success
      ? ok(parsed.data.result)
      : err('herdr tab create: unexpected shape');
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
      if (tab.value.workspace !== undefined)
        await this.#cli(['tab', 'rename', tab_id, req.label]);
      const run = await this.#cli(['pane', 'run', pane_id, req.command]);
      if (!run.ok) {
        await close();
        return run;
      }
      return ok({ close });
    });
  }
}

/** The only place that knows the backends; the config value picks one, nothing else changes. */
export function terminalHost(
  config: AttachedTerminal,
  deps: { readonly bin: string; readonly exec: CommandExec },
): TerminalHost {
  switch (config.backend) {
    case 'herdr':
      return new HerdrTerminal({
        ...deps,
        ...(config.session === undefined ? {} : { session: config.session }),
      });
  }
}

/** A read-only command that succeeds when the backend's server can take a terminal. */
export function terminalProbeArgs(config: AttachedTerminal): string[] {
  switch (config.backend) {
    case 'herdr':
      return [
        ...(config.session === undefined ? [] : ['--session', config.session]),
        'workspace',
        'list',
      ];
  }
}

/**
 * The backend's binary without configuration: `tool_paths` wins, then PATH, then the per-user directory
 * installers use, which a service's PATH often lacks.
 */
export async function findTerminalBin(
  config: AttachedTerminal,
  toolPaths: Partial<Record<AttachedTerminal['backend'], string>>,
  host: {
    findExecutable(
      name: string,
      extraDirs?: readonly string[],
    ): Promise<string | null>;
  },
  home: string = homedir(),
): Promise<string | null> {
  return (
    toolPaths[config.backend] ??
    host.findExecutable(config.backend, [join(home, '.local/bin')])
  );
}
