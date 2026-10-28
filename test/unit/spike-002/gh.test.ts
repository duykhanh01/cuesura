import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  API_VERSION,
  GhPort,
  GhPortError,
  compareRequired,
  fixtureExec,
  observePull,
  readRequiredChecks,
  spawnGhExec,
  type FixtureResponse,
  type FixtureScript,
} from '../../../scripts/spike-002/gh.ts';

const FIXTURE = fileURLToPath(new URL('../../fixtures/runtime/spike-0/gh-port/open-green.synthetic.json', import.meta.url));
const GH_TS = fileURLToPath(new URL('../../../scripts/spike-002/gh.ts', import.meta.url));
const green = JSON.parse(readFileSync(FIXTURE, 'utf8')) as FixtureScript;
const R = 'repos/octo-sandbox/cusr-spike';
const SHA = 'a'.repeat(40);
const q = (p: string, page = 1): string => `${p}?per_page=100&page=${page}`;
const pullBody = green.responses[`${R}/pulls/5`]?.[0]?.body as Record<string, unknown>;
const run = (name: string, conclusion: string | null, id: number, status = 'completed'): object => ({ id, name, head_sha: SHA, status, conclusion });

function script(over: Record<string, readonly FixtureResponse[]>): FixtureScript {
  return { source: 'synthetic', responses: { ...green.responses, ...over } };
}

async function observe(over: Record<string, readonly FixtureResponse[]>, snapshot = ['build', 'test']): Promise<ReturnType<typeof observePull> extends Promise<infer T> ? T & { port: GhPort } : never> {
  const port = new GhPort(fixtureExec(script(over)));
  const o = await observePull(port, 'octo-sandbox', 'cusr-spike', 5, snapshot, { repo_id: 420001, pr_id: 770001 });
  return { ...o, port };
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-gh-unit-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('spike-002 gh port boundary', () => {
  it('only issues GET with the pinned API version, through argv, on allowlisted endpoints', async () => {
    const exec = fixtureExec(green);
    const seen: string[][] = [];
    const port = new GhPort((args, opts) => {
      seen.push([...args]);
      return exec(args, opts);
    });
    await observePull(port, 'octo-sandbox', 'cusr-spike', 5, ['build', 'test']);
    expect(seen.length).toBeGreaterThan(0);
    for (const a of seen) {
      expect(a.slice(0, 3)).toEqual(['api', '--method', 'GET']);
      expect(a).toContain(`X-GitHub-Api-Version: ${API_VERSION}`);
    }
    expect(port.ledger.every((r) => r.method === 'GET')).toBe(true);
    expect(exec.calls.every((c) => c.startsWith('GET '))).toBe(true);
  });

  it.each([`${R}/pulls/5/merges`, `${R}/merges`, `${R}/actions/runs/1/rerun`, `${R}/pulls`, `${R}/git/refs/heads/main`, 'user', `${R}/pulls/5/merge/../../x`])(
    'refuses endpoint %s',
    async (path) => {
      await expect(new GhPort(fixtureExec(green)).get(path)).rejects.toThrow(GhPortError);
    },
  );

  it('refuses caller-provided query parameters other than pagination', async () => {
    await expect(new GhPort(fixtureExec(green)).get(`${R}/pulls/5`, { state: 'all' })).rejects.toThrow(GhPortError);
  });

  it('records a ledger entry with a redacted-evidence digest for every send', async () => {
    const leaky = script({ [`${R}/pulls/5`]: [{ status: 200, body: { ...pullBody, body: `token ghp_${'z'.repeat(36)}` } }] });
    const port = new GhPort(fixtureExec(leaky));
    await port.get(`${R}/pulls/5`);
    expect(port.ledger).toHaveLength(1);
    expect(port.ledger[0]?.evidence_digest).toBe(port.evidence[0]?.digest);
    expect(port.evidence[0]?.body_redacted).not.toContain('ghp_');
    expect(port.evidence[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('spike-002 gh port limits', () => {
  it('retries a 5xx GET within max_sends and records each send', async () => {
    const port = new GhPort(fixtureExec(script({ [`${R}/pulls/5`]: [{ status: 502 }, { status: 200, body: pullBody }] })));
    const r = await port.get(`${R}/pulls/5`);
    expect(r.ok).toBe(true);
    expect(port.ledger.map((l) => [l.send, l.status])).toEqual([
      [1, 502],
      [2, 200],
    ]);
  });

  it('gives up after max_sends timeouts and reports unknown, not absent', async () => {
    const port = new GhPort(fixtureExec(script({ [`${R}/pulls/5`]: [{ status: 0, transport: 'timeout' }] })));
    const r = await port.get(`${R}/pulls/5`);
    expect(r).toEqual({ ok: false, reason: 'timeout', status: null });
    expect(port.ledger.map((l) => l.outcome)).toEqual(['timeout', 'timeout', 'timeout']);
  });

  it('does not resend after a response exceeds the byte cap', async () => {
    const port = new GhPort(fixtureExec(script({ [`${R}/pulls/5`]: [{ status: 200, body: { pad: 'x'.repeat(5000) } }] })), { max_response_bytes: 1024 });
    const r = await port.get(`${R}/pulls/5`);
    expect(r).toMatchObject({ ok: false, reason: 'response exceeds byte cap' });
    expect(port.ledger).toHaveLength(1);
  });

  it('does not retry 4xx and does not treat 404 as an empty fact', async () => {
    const port = new GhPort(fixtureExec(script({ [`${R}/pulls/5`]: [{ status: 404, body: { message: 'Not Found' } }] })));
    expect(await port.get(`${R}/pulls/5`)).toEqual({ ok: false, reason: 'HTTP 404', status: 404 });
    expect(port.ledger).toHaveLength(1);
  });

  it('stops at the call cap and the round deadline', async () => {
    const capped = new GhPort(fixtureExec(green), { max_calls: 2 });
    await observePull(capped, 'octo-sandbox', 'cusr-spike', 5, ['build']);
    expect(capped.ledger).toHaveLength(2);

    let t = 0;
    const slow = new GhPort(fixtureExec(green), { round_ms: 1_000 }, () => (t += 400));
    const o = await observePull(slow, 'octo-sandbox', 'cusr-spike', 5, ['build']);
    expect(o.state).toBe('unknown');
    expect(o.green).toBe(false);
  });

  it('does not sleep past the window for a long Retry-After', async () => {
    const port = new GhPort(fixtureExec(script({ [`${R}/pulls/5`]: [{ status: 429, headers: { 'retry-after': '3600' } }] })));
    const r = await port.get(`${R}/pulls/5`);
    expect(r).toMatchObject({ ok: false, status: 429 });
    expect(r.ok === false && r.reason).toMatch(/beyond round window/);
  });

  it('marks pagination beyond max_pages incomplete', async () => {
    const page = Array.from({ length: 100 }, () => ({ type: 'pull_request' }));
    const port = new GhPort(fixtureExec(script({ [q(`${R}/rules/branches/main`)]: [{ status: 200, body: page }], [q(`${R}/rules/branches/main`, 2)]: [{ status: 200, body: page }] })), {
      max_pages: 2,
    });
    const r = await readRequiredChecks(port, 'octo-sandbox', 'cusr-spike', 'main');
    expect(r).toMatchObject({ status: 'unknown', basis: 'branch rules truncated by page cap' });
  });

  it('enforces timeout and byte cap on a real child process without a shell', async () => {
    const env = join(base, 'gh-env');
    writeFileSync(env, `#!${process.execPath}\nconst keys=Object.keys(process.env).sort();process.stdout.write('HTTP/2.0 200 OK\\r\\n\\r\\n'+JSON.stringify({keys,prompt:process.env.GH_PROMPT_DISABLED,argv:process.argv.slice(2)}));\n`);
    const slow = join(base, 'gh-slow');
    writeFileSync(slow, `#!${process.execPath}\nsetTimeout(()=>{},60000);\n`);
    const big = join(base, 'gh-big');
    writeFileSync(big, `#!${process.execPath}\nprocess.stdout.write('HTTP/2.0 200 OK\\r\\n\\r\\n'+'x'.repeat(4*1024*1024));\n`);
    for (const f of [env, slow, big]) chmodSync(f, 0o755);

    const ok = await new GhPort(spawnGhExec(env, { PATH: '/usr/bin:/bin', SECRET_THING: 'nope', SSH_AUTH_SOCK: '/x' })).get(`${R}/pulls/5`);
    expect(ok.ok).toBe(true);
    const body = ok.ok ? (ok.value.body as { keys: string[]; prompt: string; argv: string[] }) : null;
    expect(body?.prompt).toBe('1');
    expect(body?.keys).not.toContain('SECRET_THING');
    expect(body?.keys).not.toContain('SSH_AUTH_SOCK');
    expect(body?.argv.at(-1)).toBe(`${R}/pulls/5`);

    const timed = new GhPort(spawnGhExec(slow), { call_timeout_ms: 300, max_sends: 1 });
    expect(await timed.get(`${R}/pulls/5`)).toMatchObject({ ok: false, reason: 'timeout' });
    const capped = new GhPort(spawnGhExec(big), { max_response_bytes: 64 * 1024 });
    expect(await capped.get(`${R}/pulls/5`)).toMatchObject({ ok: false, reason: 'response exceeds byte cap' });
  });
});

describe('spike-002 gh port observation facts', () => {
  it('open PR is green only when snapshot covers any-app requirements and every check succeeded', async () => {
    const o = await observe({});
    expect(o).toMatchObject({ state: 'open', green: true, identity: { verdict: 'match' }, comparison: { verdict: 'covered', github: ['build', 'test'] } });
  });

  it('snapshot may require more than GitHub, and those extra checks must still pass', async () => {
    const o = await observe({}, ['build', 'test', 'lint']);
    expect(o.comparison?.verdict).toBe('covered');
    expect(o.checks?.states['lint']).toBe('missing');
    expect(o.green).toBe(false);
  });

  it('GitHub requirement missing from the snapshot is required_checks_mismatch', async () => {
    const o = await observe({}, ['build']);
    expect(o.comparison).toEqual({ verdict: 'required_checks_mismatch', missing_from_snapshot: ['test'], app_pinned: [] });
    expect(o.green).toBe(false);
  });

  it('an app-pinned requirement is a mismatch even when the name is in the snapshot', async () => {
    const o = await observe({ [`${R}/branches/main/protection`]: [{ status: 200, body: { required_status_checks: { checks: [{ context: 'build', app_id: 15368 }] } } }] });
    expect(o.comparison).toMatchObject({ verdict: 'required_checks_mismatch', app_pinned: ['build@app:15368'] });
  });

  it('treats app_id -1 and null as any-app', async () => {
    const o = await observe({ [`${R}/branches/main/protection`]: [{ status: 200, body: { required_status_checks: { checks: [{ context: 'build', app_id: -1 }] } } }] });
    expect(o.comparison?.verdict).toBe('covered');
  });

  it('evaluate-mode rulesets are recorded but not enforced', async () => {
    const o = await observe({ [`${R}/rulesets/9`]: [{ status: 200, body: { enforcement: 'evaluate' } }] }, ['build']);
    expect(o.required?.checks.find((c) => c.name === 'test')?.enforcement).toBe('evaluate');
    expect(o.comparison?.verdict).toBe('covered');
  });

  it.each([
    ['protection 403', { [`${R}/branches/main/protection`]: [{ status: 403, body: { message: 'Resource not accessible' } }] }],
    ['rules 404', { [q(`${R}/rules/branches/main`)]: [{ status: 404 }] }],
    ['ruleset unreadable', { [`${R}/rulesets/9`]: [{ status: 403 }] }],
    ['branch read failed', { [`${R}/branches/main`]: [{ status: 500 }] }],
  ])('%s → required checks unknown, never none', async (_name, over) => {
    const o = await observe(over);
    expect(o.required?.status).toBe('unknown');
    expect(o.comparison?.verdict).toBe('unknown');
    expect(o.green).toBe(false);
  });

  it('none only when the branch is confirmed unprotected and rules are fully read and empty', async () => {
    const port = new GhPort(fixtureExec(script({ [`${R}/branches/main`]: [{ status: 200, body: { protected: false } }], [q(`${R}/rules/branches/main`)]: [{ status: 200, body: [] }] })));
    const r = await readRequiredChecks(port, 'octo-sandbox', 'cusr-spike', 'main');
    expect(r.status).toBe('none');
    expect(compareRequired(r, [])).toEqual({ verdict: 'covered', github: [] });
  });

  it('a newer pending rerun is not hidden by an older success', async () => {
    const o = await observe({ [q(`${R}/commits/${SHA}/check-runs`)]: [{ status: 200, body: { check_runs: [run('build', 'success', 101), run('build', null, 150, 'in_progress'), run('test', 'success', 102)] } }] });
    expect(o.checks?.states['build']).toBe('pending');
    expect(o.green).toBe(false);
  });

  it.each([
    ['neutral', 'neutral'],
    ['skipped', 'skipped'],
    ['cancelled', 'cancelled'],
    ['failure', 'failure'],
    ['timed_out', 'failure'],
  ])('check conclusion %s is not a pass', async (conclusion, state) => {
    const o = await observe({ [q(`${R}/commits/${SHA}/check-runs`)]: [{ status: 200, body: { check_runs: [run('build', conclusion, 101), run('test', 'success', 102)] } }] });
    expect(o.checks?.states['build']).toBe(state);
    expect(o.green).toBe(false);
  });

  it('same name from a check run and a commit status is a collision', async () => {
    const o = await observe({ [q(`${R}/commits/${SHA}/statuses`)]: [{ status: 200, body: [{ id: 1, context: 'build', state: 'success' }] }] });
    expect(o.checks?.states['build']).toBe('collision');
    expect(o.green).toBe(false);
  });

  it('head change between the two pull reads is inconsistent, never green', async () => {
    const moved = { ...pullBody, head: { ...(pullBody['head'] as object), sha: 'd'.repeat(40) } };
    const o = await observe({ [`${R}/pulls/5`]: [{ status: 200, body: pullBody }, { status: 200, body: moved }] });
    expect(o).toMatchObject({ state: 'inconsistent', green: false });
  });

  it('merged PR yields an unverified head-at-merge candidate, not a proof', async () => {
    const merged = { ...pullBody, state: 'closed', merged: true, merged_at: '2026-10-28T00:00:00Z' };
    const o = await observe({ [`${R}/pulls/5`]: [{ status: 200, body: merged }], [`${R}/pulls/5/merge`]: [{ status: 204 }] });
    expect(o.state).toBe('merged');
    expect(o.merge_proof).toMatchObject({ head_at_merge_candidate: SHA, head_source: 'pulls.head.sha', proof_status: 'unverified_pending_s0_3', merge_endpoint: 'merged_204', repo_id: 420001, pr_id: 770001 });
    expect(o.port.ledger.every((r) => r.method === 'GET')).toBe(true);
  });

  it('merge seen on the second read switches to the merge-proof branch', async () => {
    const merged = { ...pullBody, state: 'closed', merged: true };
    const o = await observe({ [`${R}/pulls/5`]: [{ status: 200, body: pullBody }, { status: 200, body: merged }], [`${R}/pulls/5/merge`]: [{ status: 204 }] });
    expect(o.state).toBe('merged');
    expect(o.reasons).toContain('merged during observation');
  });

  it('closed but not merged is not a merge', async () => {
    const o = await observe({ [`${R}/pulls/5`]: [{ status: 200, body: { ...pullBody, state: 'closed' } }] });
    expect(o.state).toBe('closed');
    expect(o.merge_proof).toBeNull();
    expect(o.green).toBe(false);
  });

  it.each([
    ['repo id', { [R]: [{ status: 200, body: { id: 999 } }] }],
    ['pr id', { [`${R}/pulls/5`]: [{ status: 200, body: { ...pullBody, id: 1 } }] }],
    ['base repo of the PR', { [`${R}/pulls/5`]: [{ status: 200, body: { ...pullBody, base: { ...(pullBody['base'] as object), repo: { id: 7 } } } }] }],
  ])('immutable identity mismatch (%s) stops before reading checks', async (_name, over) => {
    const o = await observe(over);
    expect(o.identity.verdict).toBe('identity_mismatch');
    expect(o.checks).toBeNull();
  });

  it('CLI observes the committed synthetic fixture locally and requires an explicit mode', () => {
    const ok = spawnSync(process.execPath, [GH_TS, 'observe', '--repo', 'octo-sandbox/cusr-spike', '--pr', '5', '--snapshot', 'build,test', '--expect-repo-id', '420001', '--fixture', FIXTURE], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    const out = JSON.parse(ok.stdout) as { mode: string; observation: { green: boolean } };
    expect(out).toMatchObject({ mode: 'fixture', observation: { green: true } });
    const none = spawnSync(process.execPath, [GH_TS, 'observe', '--repo', 'octo-sandbox/cusr-spike', '--pr', '5'], { encoding: 'utf8' });
    expect(none.status).toBe(2);
  });
});
