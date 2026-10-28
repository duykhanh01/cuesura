import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { summarizeStream, type StreamVendor } from '../../../scripts/spike-002/harness-stream.ts';
import { recordedCodexStderr } from '../../support/spike-stderr.ts';

const fixture = (rel: string): string => fileURLToPath(new URL(`../../fixtures/runtime/spike-0/${rel}`, import.meta.url));
const real = (attempt: string, name: string): string => readFileSync(fixture(`harness/real-20261028/${attempt}/${name}`), 'utf8');

type Case = {
  name: string;
  vendor: StreamVendor;
  events: unknown[];
  truncated_tail?: boolean;
  stderr: string;
  expect: { failure: string | null; usage: string; denials: number; rate_limit_status?: string; truncated_records?: number };
};
const synthetic = JSON.parse(readFileSync(fixture('harness-stream/cases.synthetic.json'), 'utf8')) as { cases: Case[] };

function runnerLines(events: readonly unknown[], truncatedTail: boolean): string {
  const lines = events.map((data, seq) => JSON.stringify({ schema_version: 1, operation_id: 'op-synthetic', generation: 0, seq, kind: 'stdout', data }));
  if (truncatedTail) lines.push(JSON.stringify({ schema_version: 1, operation_id: 'op-synthetic', generation: 0, seq: events.length, kind: 'stdout', truncated: true }));
  return `${lines.join('\n')}\n`;
}

describe('spike-002 harness stream summary (synthetic negative cases)', () => {
  it.each(synthetic.cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const s = summarizeStream(c.vendor, runnerLines(c.events, c.truncated_tail === true), c.stderr);
    expect(s.failure?.kind ?? null).toBe(c.expect.failure);
    expect(s.usage.status).toBe(c.expect.usage);
    expect(s.permission_denials).toHaveLength(c.expect.denials);
    if (c.expect.rate_limit_status !== undefined) expect(s.rate_limit?.status).toBe(c.expect.rate_limit_status);
    expect(s.truncated_records).toBe(c.expect.truncated_records ?? 0);
  });

  it('skips unparseable lines as truncated instead of throwing', () => {
    expect(summarizeStream('codex', '{"data":\n', '').truncated_records).toBe(1);
  });

  it('fixture vendor never reports usage', () => {
    expect(summarizeStream('fixture', runnerLines([{ type: 'result', usage: { input_tokens: 1 } }], false), '').usage.status).toBe('unavailable');
  });

  it.each(['claude', 'codex'] as const)('%s distinguishes missing usage counters from reported zero', (vendor) => {
    const type = vendor === 'claude' ? 'result' : 'turn.completed';
    for (const usage of [{}, { input_tokens: 1 }, { input_tokens: '0', output_tokens: 0 }, { input_tokens: -1, output_tokens: 0 }, { input_tokens: 0, output_tokens: null }, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: '0', cached_input_tokens: '0' }]) {
      expect(summarizeStream(vendor, runnerLines([{ type, usage }], false), '').usage.status).toBe('unavailable');
    }
    expect(summarizeStream(vendor, runnerLines([{ type, usage: { input_tokens: 0, output_tokens: 0 } }], false), '').usage).toMatchObject({ status: 'reported', input_tokens: 0, output_tokens: 0 });
  });

  it('Codex incomplete turn usage does not become a reported partial total', () => {
    const events = [{ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }, { type: 'turn.completed', usage: {} }];
    expect(summarizeStream('codex', runnerLines(events, false), '').usage.status).toBe('unavailable');
  });

  it('Codex preserves stderr permission denials when the rejected command contains backticks', () => {
    const stderr = recordedCodexStderr('s0-codex-fixer-1793173505');
    const command = '/usr/bin/touch `echo /cusr/scratch/permission-denied-by-rule`';
    const changed = stderr.replace('/usr/bin/touch /cusr/scratch/permission-denied-by-rule', command);
    expect(changed).not.toBe(stderr);
    expect(summarizeStream('codex', '', changed).permission_denials).toEqual(expect.arrayContaining([expect.objectContaining({ command: `/usr/bin/zsh -lc '${command}'`, source: 'codex_stderr' })]));
  });
});

describe('spike-002 harness stream summary (real 2026-10-28 captures)', () => {
  it('Claude fixer: usage, cost, one rule denial deduplicated, rate limit allowed', () => {
    const a = 's0-claude-fixer-1793173414';
    const s = summarizeStream('claude', real(a, 'events.jsonl'), '');
    expect(s.usage).toEqual({ status: 'reported', source: 'claude result.usage', input_tokens: 8, cached_input_tokens: 41560, cache_write_input_tokens: 5134, output_tokens: 1402, cost_usd: 0.0021442 });
    expect(s.permission_denials).toHaveLength(1);
    expect(s.permission_denials[0]).toMatchObject({ tool: 'Bash', source: 'claude_event' });
    expect(s.permission_denials[0]?.command).toContain('/usr/bin/touch /cusr/scratch/permission-denied-by-rule');
    expect(s.rate_limit).toMatchObject({ status: 'allowed', type: 'five_hour' });
    expect(s.failure).toBeNull();
  });

  it.each(['s0-codex-coder-1793178479', 's0-codex-reviewer-1793178514', 's0-codex-fixer-1793173505'])('%s: token usage and stderr rejection', (a) => {
    const s = summarizeStream('codex', real(a, 'events.jsonl'), recordedCodexStderr(a));
    const summary = JSON.parse(real(a, 'summary.json')) as { reported_usage: { input_tokens: number; output_tokens: number } };
    expect(s.usage).toMatchObject({ status: 'reported', input_tokens: summary.reported_usage.input_tokens, output_tokens: summary.reported_usage.output_tokens, cost_usd: null });
    expect(s.permission_denials).toEqual([{ tool: 'exec_command', command: "/usr/bin/zsh -lc '/usr/bin/touch /cusr/scratch/permission-denied-by-rule'", source: 'codex_stderr' }]);
    expect(s.failure).toBeNull();
  });

  it('Codex missing code-mode host: item error is a warning, not a failure, and no denial', () => {
    const a = 's0-codex-coder-1793172285';
    const s = summarizeStream('codex', real(a, 'events.jsonl'), recordedCodexStderr(a));
    expect(s.warnings).toEqual([expect.stringContaining('Code Mode is unavailable')]);
    expect(s.failure).toBeNull();
    expect(s.permission_denials).toEqual([]);
  });
});
