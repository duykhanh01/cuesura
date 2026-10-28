import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
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
  type GhLimits,
  type Observation,
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

  it.each([`${R}/pulls/5/merges`, `${R}/merges`, `${R}/issues/5/comments`, `${R}/issues/events`, `${R}/issues/5/events/1`, `${R}/actions/runs/1/rerun`, `${R}/pulls`, `${R}/git/refs/heads/main`, 'user', `${R}/pulls/5/merge/../../x`])(
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

  it('redacts private download URL tokens in evidence before calculating its digest', async () => {
    const token = 'test-only-download-token';
    const url = 'https://raw.githubusercontent.com/example/private/main/file.txt';
    const body = { download_url: `${url}?token=${token}&raw=1` };
    const port = new GhPort(fixtureExec(script({ [`${R}/pulls/5`]: [{ status: 200, body }] })));
    await port.get(`${R}/pulls/5`);
    const evidence = port.evidence[0];
    const expected = JSON.stringify({ download_url: `${url}?token=[REDACTED]&raw=1` });
    expect(evidence?.body_redacted).toBe(expected);
    expect(JSON.stringify({ ledger: port.ledger, evidence: port.evidence })).not.toContain(token);
    expect(evidence?.digest).toBe(`sha256:${createHash('sha256').update(canonicalJson({ status: 200, headers: {}, body: expected })).digest('hex')}`);
    expect(port.ledger[0]?.evidence_digest).toBe(evidence?.digest);
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

  it('ruleset-only branch: protected=true with protection 404 "Branch not protected" reads rules instead of unknown', async () => {
    const o = await observe({ [`${R}/branches/main/protection`]: [{ status: 404, body: { message: 'Branch not protected', status: '404' } }] }, ['test']);
    expect(o.required).toMatchObject({ status: 'required', checks: [{ name: 'test', source: 'rules', enforcement: 'active' }] });
    expect(o.comparison).toEqual({ verdict: 'covered', github: ['test'] });
  });

  it('a bare protection 404 (no access) stays unknown', async () => {
    const o = await observe({ [`${R}/branches/main/protection`]: [{ status: 404, body: { message: 'Not Found' } }] });
    expect(o.required?.status).toBe('unknown');
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

  it('merged PR keeps the head as a candidate and takes the merge commit from the merged event', async () => {
    const at = '2026-10-28T00:00:00Z';
    const merged = { ...pullBody, state: 'closed', merged: true, merged_at: at };
    const event = { id: 1, event: 'merged', commit_id: 'c'.repeat(40), commit_url: `https://api.github.com/${R}/commits/${'c'.repeat(40)}`, created_at: at };
    const o = await observe({ [`${R}/pulls/5`]: [{ status: 200, body: merged }], [`${R}/pulls/5/merge`]: [{ status: 204 }], [q(`${R}/issues/5/events`)]: [{ status: 200, body: [event] }] });
    expect(o.state).toBe('merged');
    expect(o.merge_proof).toMatchObject({
      head_at_merge_candidate: SHA,
      head_source: 'pulls.head.sha',
      merge_commit_sha: 'c'.repeat(40),
      merge_commit: { status: 'found', source: 'issues.events.merged.commit_id' },
      merge_endpoint: 'merged_204',
      completeness: 'complete',
      gaps: [],
      repo_id: 420001,
      pr_id: 770001,
    });
    expect(o.port.ledger.every((r) => r.method === 'GET')).toBe(true);
  });

  it('merge seen on the second read switches to the merge-proof branch', async () => {
    const merged = { ...pullBody, state: 'closed', merged: true };
    const o = await observe({ [`${R}/pulls/5`]: [{ status: 200, body: pullBody }, { status: 200, body: merged }], [`${R}/pulls/5/merge`]: [{ status: 204 }] });
    expect(o.state).toBe('merged');
    expect(o.reasons).toContain('merged during observation');
    expect(o.merge_proof).toMatchObject({ merged: true, completeness: 'incomplete', merge_commit_sha: null, merge_commit: { status: 'unknown' } });
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

// Real API 2026-03-10 responses saved by S0.3 (T008); hashes are checked against the evidence manifest.
const REAL = fileURLToPath(new URL('../../fixtures/runtime/spike-0/github/real-20261028/', import.meta.url));
const realManifest = JSON.parse(readFileSync(join(REAL, 'manifest.json'), 'utf8')) as { files: Record<string, string> };
const RR = 'repos/duykhanh01/cuesura-spike-002-sandbox';
const REAL_REPO_ID = 1436664345;
const EVENTS_FILE: Readonly<Record<number, string>> = { 1: 'response-03.json', 2: 'response-15.json', 3: 'response-27.json' };

function realFile(name: string): unknown {
  const raw = readFileSync(join(REAL, name));
  expect(createHash('sha256').update(raw).digest('hex')).toBe(realManifest.files[name]);
  return JSON.parse(raw.toString('utf8')) as unknown;
}

function realCase(n: number): { script: FixtureScript; pull: Record<string, unknown>; events: Record<string, unknown>[]; legacySha: string } {
  const port = realFile(`port-pr-${n}-final.json`) as { evidence: { path: string; body_redacted: string }[] };
  const body = (path: string): unknown => JSON.parse(port.evidence.find((e) => e.path === path)?.body_redacted ?? 'null') as unknown;
  const pull = body(`${RR}/pulls/${n}`) as Record<string, unknown>;
  const events = realFile(EVENTS_FILE[n] as string) as Record<string, unknown>[];
  const legacy = (realFile('initial-pulls-default-api.json') as { number: number; merge_commit_sha: string }[]).find((p) => p.number === n);
  return {
    script: {
      source: `real-20261028 PR ${String(n)}`,
      responses: {
        [RR]: [{ status: 200, body: body(RR) }],
        [`${RR}/pulls/${n}`]: [{ status: 200, body: pull }],
        [`${RR}/pulls/${n}/merge`]: [{ status: 204 }],
        [q(`${RR}/issues/${n}/events`)]: [{ status: 200, body: events }],
      },
    },
    pull,
    events,
    legacySha: legacy?.merge_commit_sha ?? '',
  };
}

async function observeReal(n: number, over: Record<string, readonly FixtureResponse[]> = {}, target: string | null = 'master', limits: Partial<GhLimits> = {}): Promise<Observation & { port: GhPort }> {
  const c = realCase(n);
  const port = new GhPort(fixtureExec({ ...c.script, responses: { ...c.script.responses, ...over } }), limits);
  const o = await observePull(port, 'duykhanh01', 'cuesura-spike-002-sandbox', n, [], { repo_id: REAL_REPO_ID, pr_id: c.pull['id'] as number, target });
  return { ...o, port };
}

describe('spike-002 gh port merge proof from real API 2026-03-10 responses', () => {
  it.each([1, 2, 3])('PR %i: no merge_commit_sha, merged event yields the same SHA the default API reported', async (n) => {
    const c = realCase(n);
    expect('merge_commit_sha' in c.pull).toBe(false);
    const o = await observeReal(n);
    expect(o.identity).toEqual({ repo_id: REAL_REPO_ID, pr_id: c.pull['id'], target: 'master', verdict: 'match' });
    expect(o.state).toBe('merged');
    expect(o.merge_proof).toMatchObject({
      merged: true,
      target: 'master',
      merge_commit_sha: c.legacySha,
      merge_commit: { status: 'found', sha: c.legacySha, events: { pages: 1, complete: true } },
      head_at_merge_candidate: (c.pull['head'] as { sha: string }).sha,
      merge_endpoint: 'merged_204',
      completeness: 'complete',
      gaps: [],
    });
    expect(o.merge_proof?.merge_commit_sha).not.toBe((c.pull['head'] as { sha: string }).sha);
    expect(o.port.ledger.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${RR}`,
      `GET ${RR}/pulls/${n}`,
      `GET ${RR}/pulls/${n}/merge`,
      `GET ${q(`${RR}/issues/${n}/events`)}`,
      `GET ${RR}/pulls/${n}`,
    ]);
    expect(o.port.evidence.every((e) => /^sha256:[0-9a-f]{64}$/.test(e.digest))).toBe(true);
  });

  const c1 = (): ReturnType<typeof realCase> => realCase(1);
  const merged = (): Record<string, unknown> => c1().events.find((e) => e['event'] === 'merged') as Record<string, unknown>;
  const withEvents = (events: unknown[]): Record<string, readonly FixtureResponse[]> => ({ [q(`${RR}/issues/1/events`)]: [{ status: 200, body: events }] });
  const head = (): string => (c1().pull['head'] as { sha: string }).sha;
  const baseSha = (): string => (c1().pull['base'] as { sha: string }).sha;

  it.each<[string, () => Record<string, readonly FixtureResponse[]>, string]>([
    ['events 403', () => ({ [q(`${RR}/issues/1/events`)]: [{ status: 403, body: { message: 'Resource not accessible' } }] }), 'unknown'],
    ['events 410', () => ({ [q(`${RR}/issues/1/events`)]: [{ status: 410 }] }), 'unknown'],
    ['events timeout', () => ({ [q(`${RR}/issues/1/events`)]: [{ status: 0, transport: 'timeout' }] }), 'unknown'],
    ['events not a list', () => ({ [q(`${RR}/issues/1/events`)]: [{ status: 200, body: { message: 'x' } }] }), 'unknown'],
    ['no merged event', () => withEvents(c1().events.filter((e) => e['event'] !== 'merged')), 'missing'],
    ['merged event without commit_id', () => withEvents([{ ...merged(), commit_id: null }]), 'missing'],
    ['short commit_id', () => withEvents([{ ...merged(), commit_id: 'd329cc7' }]), 'invalid'],
    ['uppercase commit_id', () => withEvents([{ ...merged(), commit_id: String(merged()['commit_id']).toUpperCase() }]), 'invalid'],
    ['two merged events', () => withEvents([merged(), { ...merged(), id: 2, commit_id: 'e'.repeat(40) }]), 'conflict'],
    ['commit_id is the PR head', () => withEvents([{ ...merged(), commit_id: head(), commit_url: `https://api.github.com/${RR}/commits/${head()}` }]), 'conflict'],
    ['commit_id is the PR base', () => withEvents([{ ...merged(), commit_id: baseSha(), commit_url: `https://api.github.com/${RR}/commits/${baseSha()}` }]), 'conflict'],
    ['commit_url in another repo', () => withEvents([{ ...merged(), commit_url: `https://api.github.com/repos/other/fork/commits/${String(merged()['commit_id'])}` }]), 'conflict'],
    ['event time differs from merged_at', () => withEvents([{ ...merged(), created_at: '2026-10-28T08:40:00Z' }]), 'conflict'],
    ['legacy merge_commit_sha disagrees', () => ({ [`${RR}/pulls/1`]: [{ status: 200, body: { ...c1().pull, merge_commit_sha: 'f'.repeat(40) } }] }), 'conflict'],
  ])('%s → merged fact kept, merge commit %s, proof incomplete', async (_name, over, status) => {
    const o = await observeReal(1, over());
    expect(o.state).toBe('merged');
    expect(o.merge_proof).toMatchObject({ merged: true, merge_commit_sha: null, merge_commit: { status, sha: null }, completeness: 'incomplete' });
    expect(o.merge_proof?.gaps.some((g) => g.startsWith(`merge commit ${status}`))).toBe(true);
    expect(o.port.ledger.every((r) => r.method === 'GET')).toBe(true);
  });

  it('pagination beyond the page cap is unknown, never a missing event', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ id: 10_000 + i, event: 'labeled', created_at: '2026-10-28T08:00:00Z' }));
    const o = await observeReal(1, { [q(`${RR}/issues/1/events`)]: [{ status: 200, body: filler, headers: { link: '<x>; rel="next"' } }] }, 'master', { max_pages: 1 });
    expect(o.merge_proof).toMatchObject({ merge_commit: { status: 'unknown', basis: 'issue events truncated by page cap', events: { complete: false } }, completeness: 'incomplete' });
  });

  it('reads every page before deciding, then finds the single merged event', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ id: 10_000 + i, event: 'labeled', created_at: '2026-10-28T08:00:00Z' }));
    const o = await observeReal(1, { [q(`${RR}/issues/1/events`)]: [{ status: 200, body: filler }], [q(`${RR}/issues/1/events`, 2)]: [{ status: 200, body: c1().events }] });
    expect(o.merge_proof).toMatchObject({ merge_commit: { status: 'found', events: { pages: 2, complete: true } }, merge_commit_sha: c1().legacySha, completeness: 'complete' });
  });

  it('an agreeing legacy merge_commit_sha does not replace the event source', async () => {
    const o = await observeReal(1, { [`${RR}/pulls/1`]: [{ status: 200, body: { ...c1().pull, merge_commit_sha: c1().legacySha } }] });
    expect(o.merge_proof).toMatchObject({ merge_commit: { status: 'found', source: 'issues.events.merged.commit_id' }, completeness: 'complete' });
  });

  it('merge endpoint 404 or a changed re-read keeps merged but leaves the proof incomplete', async () => {
    const notFound = await observeReal(1, { [`${RR}/pulls/1/merge`]: [{ status: 404 }] });
    expect(notFound.merge_proof).toMatchObject({ merged: true, merge_endpoint: 'not_merged_404_unconfirmed', merge_commit: { status: 'found' }, completeness: 'incomplete' });
    const moved = { ...c1().pull, head: { ...(c1().pull['head'] as object), sha: 'e'.repeat(40) } };
    const changed = await observeReal(1, { [`${RR}/pulls/1`]: [{ status: 200, body: c1().pull }, { status: 200, body: moved }] });
    expect(changed.merge_proof?.gaps).toContain('pull changed between merge-proof reads');
    expect(changed.merge_proof?.completeness).toBe('incomplete');
  });

  it('target other than the task is target_mismatch and never a complete proof', async () => {
    const o = await observeReal(1, {}, 'main');
    expect(o.identity.verdict).toBe('target_mismatch');
    expect(o.merge_proof).toMatchObject({ merged: true, completeness: 'incomplete' });
    expect(o.merge_proof?.gaps).toContain('target does not match the task');
  });

  it('repo identity mismatch stops before any merge-proof read', async () => {
    const c = realCase(1);
    const port = new GhPort(fixtureExec(c.script));
    const o = await observePull(port, 'duykhanh01', 'cuesura-spike-002-sandbox', 1, [], { repo_id: 1, pr_id: c.pull['id'] as number, target: 'master' });
    expect(o).toMatchObject({ state: 'unknown', merge_proof: null, identity: { verdict: 'identity_mismatch' } });
    expect(port.ledger).toHaveLength(2);
  });
});
