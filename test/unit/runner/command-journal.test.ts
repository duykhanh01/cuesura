/**
 * Command journal (T090, FR-004): `started` is durable before a repo command can spawn and its receipt
 * after it ended; recovery tells "never spawned" from "may have run and written" by reading it back.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SandboxProvider } from '../../../src/adapters/ports.ts';
import {
  CommandJournal,
  runCommand,
  type CommandExecutor,
  type CommandSpec,
} from '../../../src/runner/commands.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { hashText } from '../../../src/shared/hash.ts';
import { ok } from '../../../src/shared/result.ts';

const base = mkdtempSync(join(tmpdir(), 'cusr-journal-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const dir = () => join(base, `op${n++}`);

const clock = { now: () => 1_000 as EpochMs, monotonic: () => 1_000 };
const sandbox: SandboxProvider = {
  provider: 'bwrap',
  plan: (layout, command) =>
    ok({
      isolation_mode: 'isolated',
      provider: 'bwrap',
      role: layout.role,
      argv: [...command],
      cwd: layout.worktree,
      env: {},
      network: 'internet_outbound',
      mount_sources: [],
      layout_digest: hashText(layout.role),
      layout_shape: hashText(layout.role),
      proof_refs: [],
    }),
};
const spec = (name: string, wall_ms = 60_000): CommandSpec => ({
  role: 'autofix',
  name,
  command: `fix ${name}`,
  layout: {
    worktree: base,
    git_dirs: [],
    scratch: base,
    context: null,
    schema: null,
    toolchain: [],
    env: {},
    network: 'internet_outbound',
  },
  wall_ms,
  deadline_at: null,
});

describe('command journal', () => {
  it('an empty or missing journal proves nothing spawned', () => {
    expect(new CommandJournal(dir()).read()).toEqual({
      ok: true,
      commands: [],
    });
  });

  it('records started before the spawn and the receipt after it', async () => {
    const j = new CommandJournal(dir());
    const seen: number[] = [];
    const executor: CommandExecutor = {
      run: () => {
        const r = j.read();
        seen.push(r.ok ? r.commands.length : -1);
        return Promise.resolve({
          kind: 'exited',
          code: 0,
          output: '',
          truncated: false,
        });
      },
    };
    const deps = {
      sandbox,
      executor,
      clock,
      redactor: new Redactor(),
      journal: j,
    };
    await runCommand(deps, spec('a'));
    await runCommand(deps, spec('b'));
    // While each command ran, its own `started` was already on disk.
    expect(seen).toEqual([1, 2]);
    expect(j.read()).toMatchObject({
      ok: true,
      commands: [
        { name: 'a', started: true, receipt: { status: 'passed' } },
        { name: 'b', started: true, receipt: { status: 'passed' } },
      ],
    });
  });

  it('a secret in the command line or the diagnostic never reaches the journal', async () => {
    const d = dir();
    const j = new CommandJournal(d);
    const token = 'tok-9f3a7c1e5b';
    const executor: CommandExecutor = {
      run: () =>
        Promise.resolve({
          kind: 'unknown',
          message: `lost pipe after curl -H ${token}`,
          output: `using ${token}`,
        }),
    };
    const receipt = await runCommand(
      {
        sandbox,
        executor,
        clock,
        redactor: new Redactor({ values: [token] }),
        journal: j,
      },
      { ...spec('push'), command: `deploy --token ${token}` },
    );
    expect(receipt.command).toBe('deploy --token [REDACTED]');
    expect(receipt.detail).toBe('lost pipe after curl -H [REDACTED]');
    // The digest still names the frozen command, so recovery can match it.
    expect(receipt.command_digest).toBe(hashText(`deploy --token ${token}`));
    const files = readdirSync(d, { recursive: true, withFileTypes: true }).filter((f) =>
      f.isFile(),
    );
    for (const f of files)
      expect(readFileSync(join(f.parentPath, f.name), 'utf8')).not.toContain(token);
  });

  it('a command past the deadline never spawns: a receipt without started', async () => {
    const j = new CommandJournal(dir());
    let spawned = 0;
    const executor: CommandExecutor = {
      run: () => (spawned++, Promise.reject(new Error('no spawn'))),
    };
    await runCommand(
      { sandbox, executor, clock, redactor: new Redactor(), journal: j },
      { ...spec('late'), deadline_at: 500 as EpochMs },
    );
    expect(spawned).toBe(0);
    expect(j.read()).toMatchObject({
      ok: true,
      commands: [{ name: 'late', started: false, receipt: { status: 'deadline' } }],
    });
  });

  it('started without a receipt is a command that may have run', () => {
    const d = dir();
    const j = new CommandJournal(d);
    j.append({
      kind: 'started',
      role: 'autofix',
      name: 'fmt',
      command_digest: hashText('fix fmt'),
      at: 1,
    });
    expect(j.read()).toEqual({
      ok: true,
      commands: [{ name: 'fmt', role: 'autofix', started: true, receipt: null }],
    });
    // A crash in the middle of the next write leaves a record that does not parse: unreadable.
    writeFileSync(join(d, '000001.json'), '');
    expect(j.read()).toMatchObject({ ok: false });
  });

  it('no durable started record, no spawn', async () => {
    const d = dir();
    const j = new CommandJournal(d);
    j.append({
      kind: 'started',
      role: 'autofix',
      name: 'x',
      command_digest: hashText('x'),
      at: 1,
    });
    chmodSync(d, 0o500);
    let spawned = 0;
    const executor: CommandExecutor = {
      run: () => (spawned++, Promise.reject(new Error('no spawn'))),
    };
    try {
      const deps = {
        sandbox,
        executor,
        clock,
        redactor: new Redactor(),
        journal: j,
      };
      await expect(runCommand(deps, spec('fmt'))).rejects.toThrow();
      expect(spawned).toBe(0);
    } finally {
      chmodSync(d, 0o700);
    }
    expect(readdirSync(d)).toHaveLength(1);
  });
});
