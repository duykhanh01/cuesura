#!/usr/bin/env node
// Test-only stand-in for a pinned vendor binary: replays the stdout records of a real T007 run
// (FAKE_VENDOR_REPLAY) and, for Codex, writes the final message where --output-last-message says.
// FAKE_VENDOR_MODE (comma list): publish, write_worktree, print_home, leak_summary, hang, exit1,
// no_output.
// FAKE_VENDOR_ECHO_MODEL: system/init reports the --model it was given.
// FAKE_VENDOR_APPLY_CODER / _FIXER: a directory copied over the worktree when that role runs.
// FAKE_VENDOR_FIXER_REPLAY: the run a fixer replays instead of FAKE_VENDOR_REPLAY.
// FAKE_VENDOR_REVIEWER_PROBE: a reviewer tries to write its worktree and exits 1 if the write lands.
// FAKE_VENDOR_HOLD: writes running-<pid> to the scratch directory, then waits for a release file next to
// it (at most five minutes) before replaying, so a test can stop the daemon while the agent is active.
// FAKE_VENDOR_INNER_SANDBOX: runs a tool in a child PID namespace for two seconds, as a native inner sandbox does.
// FAKE_VENDOR_DENY_STDERR: logs a refused exec on stderr the way codex does.
// It never calls a model.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const codex = argv[0] === 'exec';
const modes = (process.env.FAKE_VENDOR_MODE ?? '').split(',');
const has = (m) => modes.includes(m);
const stdin = readFileSync(0, 'utf8');
// Optional role routing lets one pinned binary/settings run both roles, as a real vendor does.
const reviewer = !!process.env.FAKE_VENDOR_REVIEWER_REPLAY && /^Role: reviewer$/m.test(stdin);
const fixer = /^Role: fixer$/m.test(stdin);
const replay = reviewer
  ? process.env.FAKE_VENDOR_REVIEWER_REPLAY
  : fixer && process.env.FAKE_VENDOR_FIXER_REPLAY
    ? process.env.FAKE_VENDOR_FIXER_REPLAY
    : process.env.FAKE_VENDOR_REPLAY;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

out({ type: 'fake_invocation', argv, stdin_bytes: Buffer.byteLength(stdin), cwd: process.cwd() });
if (has('print_home')) {
  const walk = (d) =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [readFileSync(p, 'utf8')];
    });
  const text = walk(process.env.HOME).join('\n');
  out({ type: 'leak', text });
  process.stderr.write(`leak ${text}\n`);
}
if (has('publish') && !reviewer) {
  // Writes the commit/PR content where the context says, as the sandbox maps /cusr/scratch.
  const m = /as JSON \{[^}]*\} to (\S+\.json)\./.exec(stdin);
  const path = m[1].replace('/cusr/scratch', process.env.FAKE_SANDBOX_SCRATCH ?? '/cusr/scratch');
  writeFileSync(path, JSON.stringify({ commit_message: 'Fix add', pr_title: 'Fix add', pr_body: 'Fixes add.' }));
}
if (has('write_worktree') && (!reviewer || process.env.FAKE_VENDOR_REVIEWER_WRITE)) writeFileSync(join(process.cwd(), 'agent-wrote.txt'), 'x');
if (reviewer && process.env.FAKE_VENDOR_REVIEWER_PROBE) {
  let landed = true;
  try {
    writeFileSync(join(process.cwd(), 'reviewer-wrote.txt'), 'x');
  } catch {
    landed = false;
  }
  if (landed) process.exit(1);
}
const apply = reviewer ? undefined : fixer ? process.env.FAKE_VENDOR_APPLY_FIXER : process.env.FAKE_VENDOR_APPLY_CODER;
if (apply) cpSync(apply, process.cwd(), { recursive: true });
if (process.env.FAKE_VENDOR_HOLD) {
  const scratch = process.env.FAKE_SANDBOX_SCRATCH ?? '/cusr/scratch';
  writeFileSync(join(scratch, `running-${process.pid}`), '');
  const end = Date.now() + 300_000;
  while (!existsSync(join(scratch, 'release')) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}
if (process.env.FAKE_VENDOR_INNER_SANDBOX)
  spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--pid', '--fork', '/usr/bin/sleep', '2']);
if (process.env.FAKE_VENDOR_DENY_STDERR)
  process.stderr.write(
    `codex_core::tools::router: error=Rejected("\`/usr/bin/touch /cusr/scratch/permission-denied-by-rule\` rejected: blocked by policy")\n`,
  );
if (has('hang')) setInterval(() => {}, 1000);
else {
  const records = readFileSync(join(replay, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'stdout')
    .map((r) => r.data);
  // The stand-in reports the model it was asked for, as the real binary does in system/init.
  const model = argv[argv.indexOf('--model') + 1];
  for (const r of records)
    out(r.type === 'system' && r.subtype === 'init' && process.env.FAKE_VENDOR_ECHO_MODEL ? { ...r, model } : r);
  if (codex && !has('no_output')) {
    const i = argv.indexOf('--output-last-message');
    const last = records
      .filter((r) => r.type === 'item.completed' && r.item?.type === 'agent_message')
      .at(-1);
    let text = last.item.text;
    if (has('leak_summary')) {
      // Copies the installed auth token into the answer's summary, as a confused agent might.
      const auth = JSON.parse(readFileSync(join(process.env.HOME, '.codex/auth.json'), 'utf8'));
      text = JSON.stringify({ ...JSON.parse(text), summary: `token ${auth.accessToken}` });
    }
    writeFileSync(argv[i + 1], text);
  }
  process.exitCode = has('exit1') ? 1 : 0;
}
