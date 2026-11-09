/**
 * Real 2026-10-28 harness runs (T007) replayed through the production adapters. Pins are rebuilt from
 * the spike's pinned configs with the auth paths turned into credential names; the run records are
 * read as archived. Replay proves the adapters parse and validate what the pinned binaries emitted;
 * it is not a new model invocation and never certifies an end-to-end smoke.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { VendorPin, VendorRead } from '../../src/adapters/harness/vendor.ts';
import type { Role } from '../../src/adapters/harness/result-schema.ts';
import { recordedCodexStderr } from './spike-stderr.ts';

export const REAL = fileURLToPath(
  new URL('../fixtures/runtime/spike-0/harness/real-20261028/', import.meta.url),
);

export const readReal = (rel: string): string => readFileSync(`${REAL}${rel}`, 'utf8');
export const readRealJson = <T = unknown>(rel: string): T => JSON.parse(readReal(rel)) as T;

type SpikePin = {
  vendor: 'claude' | 'codex';
  binary: { path: string; sha256: string; expected_version: string };
  model: string;
  effort: string | null;
  argv: string[];
  settings: { content: Record<string, unknown> } | null;
  auth_files: { from: string; to: string }[];
  env: Record<string, string>;
};

export function spikePin(vendor: 'claude' | 'codex'): SpikePin {
  return readRealJson<SpikePin>(`pinned-${vendor}.json`);
}

/** The codex execpolicy rules the spike installed (prepare.mjs.txt); the pin carries their digest. */
export const SPIKE_RULES =
  'prefix_rule(pattern=["/usr/bin/touch", "/cusr/scratch/permission-denied-by-rule"], decision="forbidden")\n' +
  'prefix_rule(pattern=["touch", "/cusr/scratch/permission-denied-by-rule"], decision="forbidden")\n';

/** What a test writes for a home file: the pinned rules for a rule file, `auth` otherwise. */
export function homeFileContent(h: VendorPin['home_files'][number], auth: string): string {
  return h.sha256 === undefined ? auth : SPIKE_RULES;
}

/** The production pin equivalent to the spike's pinned config. */
export function vendorPin(vendor: 'claude' | 'codex'): VendorPin {
  const s = spikePin(vendor);
  const at = (flag: string): string | null => {
    const i = s.argv.indexOf(flag);
    return i < 0 ? null : (s.argv[i + 1] ?? null);
  };
  return {
    schema_version: 1,
    vendor,
    binary: {
      realpath: s.binary.path,
      version: s.binary.expected_version,
      sha256: s.binary.sha256,
    },
    toolchain: [],
    env: s.env,
    home_files: s.auth_files.map((a, i) => ({
      credential: `${vendor}-${i}`,
      to: a.to,
      ...(a.to.endsWith('.rules')
        ? {
            sha256: createHash('sha256').update(SPIKE_RULES).digest('hex'),
          }
        : {}),
    })),
    settings: s.settings?.content ?? null,
    max_turns: vendor === 'claude' ? Number(at('--max-turns')) : null,
    tools: vendor === 'claude' ? (at('--tools') ?? '').split(',') : null,
  };
}

/** The six valid role × vendor runs of T007. */
export const VALID_RUNS: readonly {
  readonly attempt: string;
  readonly vendor: 'claude' | 'codex';
  readonly role: Role;
}[] = [
  { attempt: 's0-claude-coder-1793172185', vendor: 'claude', role: 'coder' },
  { attempt: 's0-claude-fixer-1793173414', vendor: 'claude', role: 'fixer' },
  {
    attempt: 's0-claude-reviewer-1793180331',
    vendor: 'claude',
    role: 'reviewer',
  },
  { attempt: 's0-codex-coder-1793178479', vendor: 'codex', role: 'coder' },
  { attempt: 's0-codex-fixer-1793173505', vendor: 'codex', role: 'fixer' },
  {
    attempt: 's0-codex-reviewer-1793180367',
    vendor: 'codex',
    role: 'reviewer',
  },
];

type Record_ = { kind: string; data: unknown; truncated?: boolean };

export function recordedStdout(attempt: string): unknown[] {
  return readReal(`${attempt}/events.jsonl`)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record_)
    .filter((r) => r.kind === 'stdout')
    .map((r) => r.data);
}

/** stderr as the runner kept it; for Codex only the router lines survive (see spike-stderr.ts). */
export function recordedRead(attempt: string, vendor: 'claude' | 'codex'): VendorRead {
  return {
    stdout: recordedStdout(attempt),
    truncated_records: 0,
    stderr: vendor === 'codex' ? safeCodexStderr(attempt) : '',
  };
}

function safeCodexStderr(attempt: string): string {
  try {
    return recordedCodexStderr(attempt);
  } catch {
    return '';
  }
}

/**
 * What `--output-last-message` wrote: the final agent message. The scratch file itself was not
 * archived, so it is rebuilt from the last `agent_message` item of the same run.
 */
export function codexLastMessage(attempt: string): string {
  const msgs = recordedStdout(attempt).flatMap((d) => {
    const r = d as { type?: string; item?: { type?: string; text?: string } };
    return r.type === 'item.completed' && r.item?.type === 'agent_message'
      ? [r.item.text ?? '']
      : [];
  });
  const last = msgs.at(-1);
  if (last === undefined) throw new Error(`${attempt} has no agent message`);
  return last;
}

/** The value the spike validator accepted for this run. */
export function acceptedValue(attempt: string): unknown {
  return readRealJson<{ value: unknown }>(`${attempt}/out/result.json`).value;
}

/** The harness argv of the archived run (after the bwrap `--`). */
export function recordedHarnessArgv(attempt: string): string[] {
  const inv = readRealJson<{ spec: { command: string[] } }>(`${attempt}/invocation.json`);
  const c = inv.spec.command;
  return c.slice(c.indexOf('--') + 1);
}
