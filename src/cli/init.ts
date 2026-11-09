import { spawnSync } from 'node:child_process';
import {
  InitBlockedError,
  InitWriteError,
  PR_TEMPLATE_TARGET,
  initItems,
  installInitItems,
  type InitFile,
  type InitItemId,
} from '../application/init.ts';
import { resolveDataDir } from './client.ts';
import { exitCodeForError } from './errors.ts';
import { ExitCode, errorEnvelope, okEnvelope, renderEnvelope } from './output.ts';
import type { CliCommand, CliIo } from './program.ts';
import { runSelect, type Choice } from './select.ts';
import { badFlag } from './tasks.ts';

export type InitDeps = {
  /** Whether a person can answer on this terminal. */
  readonly interactive: () => boolean;
  /** Shows the checklist; null when the person cancels. */
  readonly select: (title: string, choices: readonly Choice[]) => Promise<readonly string[] | null>;
};

const processDeps: InitDeps = {
  interactive: () => process.stdin.isTTY && process.stdout.isTTY,
  select: (title, choices) => runSelect(title, choices),
};

const QUESTION = 'What should cusr set up in this repo?';

function gitRoot(dir: string): string | null {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Filesystem failures end as one envelope like any other error, with what was installed before them. */
function failed(e: unknown, root: string, json: boolean, io: CliIo): number {
  const write = e instanceof InitWriteError;
  // A file in a state init must not write over is for the person to fix, not a failure of init.
  const code =
    e instanceof InitBlockedError ? 'invalid_arguments' : write ? 'write_failed' : 'init_failed';
  const message = e instanceof Error ? e.message : String(e);
  const files = write ? e.done : [];
  if (json)
    io.stdout(
      renderEnvelope(
        errorEnvelope({
          code,
          message,
          details: { root, files, ...(write ? { failed: e.path } : {}) },
          request_id: null,
        }),
      ),
    );
  else {
    if (files.length > 0) io.stdout(`${root}\n${files.map(describe).join('')}`);
    io.stderr(`cusr: ${message}\n`);
    if (files.length > 0) io.stderr('cusr: the files above stay installed; run cusr init again.\n');
  }
  return exitCodeForError(code);
}

/** What the person runs after init: cusr knows the repo only once the cusrd config names it. */
function nextSteps(root: string): string[] {
  return [
    `declare the repo under projects in the config cusrd starts with: ID: { path: ${root}, base_branch: BRANCH }`,
    'cusr doctor --project ID',
  ];
}

function describe(f: InitFile): string {
  return `  ${f.status.padEnd(9)} ${f.path}${f.reason === undefined ? '' : ` (${f.reason})`}\n`;
}

export function makeInitCommand(deps: InitDeps = processDeps): CliCommand {
  return {
    name: 'init',
    description: 'Set up a repo for cusr: choose the PR template, skills and hooks to install.',
    help: `Shows a checklist, every item checked:
  write-pr  .github/pull_request_template.md and the write-pr skill under .agents/skills and
            .claude/skills. A repo with its own PR template keeps it and gets the skill alone.
  assistant skills/cusr under .agents/skills and .claude/skills, and the hooks that wake the
            assistant, hidden from Git through info/exclude: .claude/settings.local.json, plus
            .codex/hooks.json and .pi/extensions/cusr-assistant.ts when codex or pi is on PATH.
Nothing is committed: cusr reads the template from the base commit, so commit the files for new
tasks to use them. Do not commit the hook files: they hold this machine's data dir.

Examples:
  cusr init
  cusr init --dir ~/code/acme --yes
  cusr init --yes --force
  cusr init --yes --data-dir ~/cuesura-dogfood/data`,
    options: [
      { flags: '--dir <path>', description: 'Repo to set up (default: the current directory)' },
      {
        flags: '--yes',
        description: 'Install every item that can be installed without asking',
      },
      { flags: '--force', description: 'Replace skill files that differ from the shipped copy' },
      {
        flags: '--data-dir <dir>',
        description: 'Data dir the assistant hooks use (default: $CUSR_DATA_DIR or ~/.cusr)',
      },
    ],
    async run(values, json, io) {
      const dir = values['dir'] ?? process.cwd();
      const root = gitRoot(dir);
      if (root === null)
        return badFlag(
          `${dir} is not inside a Git repository; run cusr init inside one, or pass --dir <repo>.`,
          {},
          json,
          io,
        );
      const dataDir = resolveDataDir(values['dataDir']);
      let items;
      try {
        items = initItems(root, { dataDir });
      } catch (e) {
        return failed(e, root, json, io);
      }
      const unavailable = items.flatMap((i) =>
        i.unavailable === null ? [] : [{ id: i.id, reason: i.unavailable }],
      );
      let ids: readonly InitItemId[];
      if (values['yes'] === 'true') {
        ids = items.filter((i) => i.unavailable === null).map((i) => i.id);
        if (ids.length === 0)
          return badFlag(
            `nothing can be installed in this repo: ${unavailable.map((u) => `${u.id}: ${u.reason}`).join('; ')}`,
            { root, unavailable },
            json,
            io,
          );
      } else if (json || !deps.interactive()) {
        return badFlag(
          'cusr init asks what to install: run it in a terminal, or pass --yes.',
          {},
          json,
          io,
        );
      } else {
        let picked: readonly string[] | null;
        try {
          picked = await deps.select(QUESTION, items);
        } catch (e) {
          return failed(e, root, json, io);
        }
        if (picked === null || picked.length === 0) {
          io.stdout('Nothing installed.\n');
          return ExitCode.ok;
        }
        ids = picked as InitItemId[];
      }
      let files: InitFile[];
      try {
        files = installInitItems(root, ids, { force: values['force'] === 'true', dataDir });
      } catch (e) {
        return failed(e, root, json, io);
      }
      const skipped = unavailable.filter((u) => !ids.includes(u.id));
      const next = nextSteps(root);
      if (json) {
        io.stdout(renderEnvelope(okEnvelope({ root, files, unavailable: skipped, next })));
        return ExitCode.ok;
      }
      io.stdout(`${root}\n${files.map(describe).join('')}`);
      for (const u of skipped) io.stdout(`Not installed: ${u.id}: ${u.reason}\n`);
      if (files.some((f) => f.status === 'kept'))
        io.stdout('Pass --force to replace the files kept above.\n');
      const written = files.filter(
        (f) => f.local !== true && (f.status === 'created' || f.status === 'updated'),
      );
      if (written.some((f) => f.path === PR_TEMPLATE_TARGET))
        io.stdout(
          'Commit these files. cusr reads the PR template from the base commit, so new tasks use it once the commit is there.\n',
        );
      else if (written.length > 0) io.stdout('Commit these files.\n');
      io.stdout(`Next:\n${next.map((n) => `  ${n}\n`).join('')}`);
      return ExitCode.ok;
    },
  };
}

export const initCommand = makeInitCommand();
