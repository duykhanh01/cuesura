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
// FAKE_VENDOR_INNER_SANDBOX: enforces shell writes with the test harness native sandbox.
// FAKE_VENDOR_PROOF_ALLOW_RULE: deliberately executes the command that the permission rule should deny.
// FAKE_VENDOR_DENY_STDERR: logs a refused exec on stderr the way codex does.
// FAKE_VENDOR_HIDE_REFUSAL: a Codex stream shows nothing for a refused command, as real 0.166 does.
// `sandbox ... -- COMMAND` runs COMMAND the way `codex sandbox` does.
// It never calls a model.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === 'sandbox') {
  const command = argv.slice(argv.indexOf('--') + 1);
  const r = process.env.FAKE_VENDOR_INNER_SANDBOX
    ? spawnSync('/usr/bin/bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', ...command], { stdio: 'inherit' })
    : spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const codex = argv[0] === 'exec';
const modes = (process.env.FAKE_VENDOR_MODE ?? '').split(',');
const has = (m) => modes.includes(m);
const stdin = readFileSync(0, 'utf8');
// Optional role routing lets one pinned binary/settings run both roles, as a real vendor does.
// A decider replays the reviewer's run with its own answer: same read-only boundary, its own schema.
const decider = /^Role: decider$/m.test(stdin);
const DECIDER_ANSWER = { schema_version: 1, answer: 'proceed', reason: 'capability check' };
const reviewer = !!process.env.FAKE_VENDOR_REVIEWER_REPLAY && (decider || /^Role: reviewer$/m.test(stdin));
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
  // The attempt's own home: the config dirs point into it while HOME stays the owner's.
  const text = walk(dirname(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, '.claude'))).join('\n');
  out({ type: 'leak', text });
  process.stderr.write(`leak ${text}\n`);
}
if (has('publish') && !reviewer) {
  // Writes the commit/PR content where the context says, as the sandbox maps /cusr/scratch.
  const m = /as JSON \{[^}]*\} to (\S+\.json)\./.exec(stdin);
  const path = m[1].replace('/cusr/scratch', process.env.FAKE_SANDBOX_SCRATCH ?? '/cusr/scratch');
  writeFileSync(path, JSON.stringify({ commit_message: 'Fix add', pr_title: 'Fix add', pr_body: 'Fixes add.' }));
}
if (has('write_worktree') && (!reviewer || process.env.FAKE_VENDOR_REVIEWER_WRITE))
  writeFileSync(join(process.cwd(), reviewer ? 'reviewer-wrote.txt' : 'agent-wrote.txt'), 'x');
if (reviewer && process.env.FAKE_VENDOR_REVIEWER_PROBE) {
  let landed = true;
  if (process.env.FAKE_VENDOR_INNER_SANDBOX) {
    // Model a native harness enforcing read-only shell tools itself, without an outer wrapper.
    const probe = spawnSync('/usr/bin/bwrap', [
      '--unshare-user', '--ro-bind', '/', '/', '--',
      '/usr/bin/touch', join(process.cwd(), 'reviewer-wrote.txt'),
    ], { encoding: 'utf8' });
    if (probe.status !== 0 && !/Read-only file system|Permission denied/.test(probe.stderr)) process.exit(2);
    landed = probe.status === 0;
  } else {
    try {
      writeFileSync(join(process.cwd(), 'reviewer-wrote.txt'), 'x');
    } catch {
      landed = false;
    }
  }
  if (landed) process.exit(1);
}
const apply = reviewer ? undefined : fixer ? process.env.FAKE_VENDOR_APPLY_FIXER : process.env.FAKE_VENDOR_APPLY_CODER;
if (apply) cpSync(apply, process.cwd(), { recursive: true });
if (process.env.FAKE_VENDOR_HOLD) {
  const scratch = process.env.FAKE_SANDBOX_SCRATCH ?? process.env.TMPDIR ?? '/cusr/scratch';
  writeFileSync(join(scratch, `running-${process.pid}`), '');
  const end = Date.now() + 300_000;
  while (!existsSync(join(scratch, 'release')) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}
const deniedCommand = '/usr/bin/touch permission-denied-by-rule';
if (process.env.FAKE_VENDOR_PROOF_ALLOW_RULE) spawnSync('/bin/sh', ['-c', deniedCommand]);
if (process.env.FAKE_VENDOR_DENY_STDERR) {
  process.stderr.write(`codex_core::tools::router: error=Rejected("\`/usr/bin/zsh -lc '${deniedCommand}'\` rejected: blocked by policy")\n`);
  if (!codex) {
    out({type: 'assistant', message: {content: [{type: 'tool_use', id: 'rule-probe', name: 'Bash', input: {command: deniedCommand}}]}});
    out({type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'rule-probe', message: `Permission to use Bash with command ${deniedCommand} has been denied.`});
  }
}
const nativeCommand = /^2\. Run exactly: (.+)$/m.exec(stdin)?.[1];
if (nativeCommand) {
  const probe = process.env.FAKE_VENDOR_INNER_SANDBOX
    ? spawnSync('/usr/bin/bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/bin/sh', '-c', nativeCommand], {encoding:'utf8'})
    : spawnSync('/bin/sh', ['-c', nativeCommand], {encoding:'utf8'});
  if (codex && process.env.FAKE_VENDOR_HIDE_REFUSAL && probe.status !== 0) {
    // Nothing on stdout: the refusal is visible only to the model.
  } else if (codex) out({type: 'item.completed', item: {type: 'command_execution', command: nativeCommand, exit_code: probe.status, aggregated_output: probe.stdout + probe.stderr}});
  else {
    const text = probe.status === 0 ? probe.stdout : `Exit code ${probe.status}\n${probe.stderr}`;
    out({type: 'assistant', message: {content: [{type: 'tool_use', id: 'native-probe', name: 'Bash', input: {command: nativeCommand}}]}});
    out({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'native-probe', is_error: probe.status !== 0, content: text}]}, tool_use_result: probe.status === 0 ? {stdout: probe.stdout, stderr: probe.stderr} : `Error: ${text}`});
  }
}
if (has('hang')) setInterval(() => {}, 1000);
else {
  const records = readFileSync(join(replay, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'stdout')
    .map((r) => r.data)
    .map((r) => {
      if (!decider) return r;
      if (r.type === 'result') return { ...r, structured_output: DECIDER_ANSWER };
      if (r.type === 'item.completed' && r.item?.type === 'agent_message')
        return { ...r, item: { ...r.item, text: JSON.stringify(DECIDER_ANSWER) } };
      return r;
    });
  // The stand-in reports the model it was asked for, as the real binary does in system/init.
  const model = argv[argv.indexOf('--model') + 1];
  const resumeMode = process.env.FAKE_VENDOR_RESUME;
  if (!codex && resumeMode) {
    const session = records.find((r) => r.type === 'result')?.session_id;
    const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
    const nonce = /Remember this nonce for a later continuation: ([0-9a-f-]+)\./.exec(stdin)?.[1];
    if (nonce && resumeMode !== 'missing') {
      mkdirSync(projects, { recursive: true });
      writeFileSync(join(projects, `${session}.jsonl`), JSON.stringify({ nonce }));
    }
    if (argv.includes('--resume')) {
      const id = argv[argv.indexOf('--resume') + 1];
      const remembered = JSON.parse(readFileSync(join(projects, `${id}.jsonl`), 'utf8')).nonce;
      const final = records.find((r) => r.type === 'result');
      out({ ...final, session_id: id, ...(resumeMode === 'failure'
        ? { is_error: true, subtype: 'resume_fixture_failed', result: 'fixture resume service unavailable', structured_output: undefined }
        : { structured_output: { schema_version: 1, status: 'done', summary: remembered, questions: [], blocker: null } }) });
      process.exit(0);
    }
    if (resumeMode === 'no_session') for (const r of records) delete r.session_id;
  }
  if (codex && resumeMode) {
    // Codex keeps a thread as one dated rollout and `exec ... resume <id> -` finds it by id (0.167.0).
    const sessions = join(process.env.CODEX_HOME ?? join(process.env.HOME, '.codex'), 'sessions');
    const thread = records.find((r) => r.type === 'thread.started')?.thread_id;
    const nonce = /Remember this nonce for a later continuation: ([0-9a-f-]+)\./.exec(stdin)?.[1];
    if (nonce && resumeMode !== 'missing') {
      mkdirSync(join(sessions, '2026/11/08'), { recursive: true });
      writeFileSync(join(sessions, '2026/11/08', `rollout-2026-11-08T00-00-00-${thread}.jsonl`), JSON.stringify({ nonce }));
    }
    const at = argv.indexOf('resume');
    if (at !== -1) {
      const id = argv[at + 1];
      const find = (d) =>
        !existsSync(d) ? null : readdirSync(d).map((n) => join(d, n)).reduce((hit, p) =>
          hit ?? (statSync(p).isDirectory() ? find(p) : p.endsWith(`-${id}.jsonl`) ? p : null), null);
      const rollout = find(sessions);
      if (rollout === null) {
        process.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${id}\n`);
        process.exit(1);
      }
      out({ type: 'thread.started', thread_id: id });
      out({ type: 'turn.started' });
      if (resumeMode === 'failure') {
        out({ type: 'turn.failed', error: { message: 'fixture resume service unavailable' } });
        process.exit(1);
      }
      const remembered = JSON.parse(readFileSync(rollout, 'utf8')).nonce;
      out({ type: 'turn.completed', usage: records.find((r) => r.type === 'turn.completed').usage });
      writeFileSync(argv[argv.indexOf('--output-last-message') + 1], JSON.stringify({ schema_version: 1, status: 'done', summary: remembered, questions: [], blocker: null }));
      process.exit(0);
    }
    if (resumeMode === 'no_session') records.splice(records.findIndex((r) => r.type === 'thread.started'), 1);
  }
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
      const auth = JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(process.env.HOME, '.codex'), 'auth.json'), 'utf8'));
      text = JSON.stringify({ ...JSON.parse(text), summary: `token ${auth.accessToken}` });
    }
    writeFileSync(argv[i + 1], text);
  }
  process.exitCode = has('exit1') ? 1 : 0;
}
