import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';

// Issue #259: `answer` and `task message` read their text from stdin with `--file -`, and the daemon fills
// in the project of a task command that names none, so a mutation needs no `task_show` first.

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

async function asking() {
  const sd = new SeededDaemon();
  live.push(sd);
  const { t, q } = sd.seed((d) => {
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('needs_input', { questions: ['Which encoding?'] }),
    );
    const q = Object.values(d.task(t.id).questions).find((x) => x.status === 'open');
    if (q === undefined) throw new Error('no open question');
    return { t, q };
  });
  await sd.start();
  const store = () => sd.daemon?.store as NonNullable<typeof sd.daemon>['store'];
  const version = () => store().readTask(t.id)?.version ?? -1;
  return { sd, t, q, store, version };
}

const BIN = fileURLToPath(new URL('../../../src/cli/cusr.ts', import.meta.url));

function cusr(
  sd: SeededDaemon,
  args: string[],
  input: string,
): Promise<{ code: number; out: unknown }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args, '--data-dir', sd.dataDir, '--json'],
      { env: { ...process.env, NODE_NO_WARNINGS: '1' } },
      (e, stdout) =>
        resolve({
          code: e === null ? 0 : ((e as { code?: number }).code ?? -1),
          out: JSON.parse(stdout) as unknown,
        }),
    );
    child.stdin?.end(input);
  });
}

describe('a task command without a project', () => {
  it('runs against the task it names', async () => {
    const { sd, t, q, store, version } = await asking();
    const r = await sd.command('assistant', {
      request_id: uuidOf(9_001),
      kind: 'answer',
      project: null,
      task_id: t.id,
      expected_version: version(),
      payload: { question_id: q.id, answer: 'UTF-8' },
    });
    expect(r.code).toBe(ExitCode.ok);
    expect(store().readTask(t.id)?.questions[q.id]?.status).toBe('answered');
  });

  it('is not found for an unknown task, and a wrong project is still refused', async () => {
    const { sd, t, q, version } = await asking();
    const send = (n: number, project: string | null, taskId: string) =>
      sd.command('assistant', {
        request_id: uuidOf(n),
        kind: 'answer',
        project,
        task_id: taskId,
        expected_version: version(),
        payload: { question_id: q.id, answer: 'UTF-8' },
      });
    const unknown = await send(9_101, null, uuidOf(9_999));
    expect(unknown.code).toBe(ExitCode.missing);
    expect(unknown.envelope.error?.code).toBe('task_not_found');
    const wrong = await send(9_102, 'elsewhere', t.id);
    expect(wrong.code).toBe(ExitCode.missing);
  });
});

describe('--file - reads standard input', () => {
  it('answer', async () => {
    const { sd, t, q, store, version } = await asking();
    const r = await cusr(
      sd,
      ['answer', q.id, '--file', '-', '--expected-version', String(version())],
      'UTF-8 from stdin\n',
    );
    expect(r.code).toBe(ExitCode.ok);
    expect(store().readTask(t.id)?.questions[q.id]).toMatchObject({
      status: 'answered',
      answer: 'UTF-8 from stdin',
    });
  });

  it('task message, with no --project', async () => {
    const { sd, t, store, version } = await asking();
    const r = await cusr(
      sd,
      ['task', 'message', t.id, '--file', '-', '--expected-version', String(version())],
      'Use UTF-8.\n',
    );
    expect(r).toMatchObject({ code: ExitCode.ok, out: { ok: true } });
    expect(JSON.stringify(store().readEvents(t.id))).toContain('Use UTF-8.');
  });
});
