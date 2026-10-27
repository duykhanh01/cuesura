import type { Uuid } from '../../src/shared/brand.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import { buildTask, freezeOk, uuidOf } from './builders.ts';
import { agentData, gatesData, PREPARE_DATA, publishData, reviewData } from './scenario.ts';
import type { StoreDriver } from './store-driver.ts';

export const WALL = 3_600_000;

export function createAndStart(d: StoreDriver, task: CanonicalTask): void {
  d.must(task.id, { kind: 'create_task', task });
  d.must(task.id, { kind: 'start', freeze: freezeOk(task, { limits: { max_wall_ms: WALL } }) });
}

/** prepare → code → gates → review: dừng khi `publish` đang pending. */
export function toPublish(d: StoreDriver, task: CanonicalTask, head = 'head1'): void {
  d.complete(task.id, d.pendingOne(task.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(task.id, d.pendingOne(task.id, 'start_agent').id, 'succeeded', agentData('done'));
  d.complete(
    task.id,
    d.pendingOne(task.id, 'run_gates').id,
    'succeeded',
    gatesData({ build: true, unit: true }),
  );
  d.complete(
    task.id,
    d.pendingOne(task.id, 'start_agent').id,
    'succeeded',
    reviewData('approve', head),
  );
}

/**
 * Chuỗi nhiều task có tín hiệu trùng, từ chối, conflict, hủy và timer: dùng cho bộ ngắt tiến trình và
 * kiểm tra dựng lại projection.
 */
export function mixedWorkload(d: StoreDriver): CanonicalTask[] {
  const a = buildTask({ id: uuidOf(101), source_key: 'cli:a' });
  const b = buildTask({ id: uuidOf(102), source_key: 'cli:b' });
  const c = buildTask({ id: uuidOf(103), source_key: 'cli:c', depends_on: [a.id] });

  createAndStart(d, a);
  d.must(b.id, { kind: 'create_task', task: b });
  d.must(c.id, { kind: 'create_task', task: c });
  toPublish(d, a);
  // Gửi lại đúng phong bì cuối (trùng khoá) và một lệnh dựa trên version cũ.
  const last = d.ops.findLast((o) => o.op === 'accept');
  if (last?.op === 'accept') d.deliver(last.envelope);
  d.send(b.id, { kind: 'cancel', reason: 'cũ' }, { expected_version: 0 });
  d.complete(a.id, d.pendingOne(a.id, 'publish').id, 'succeeded', publishData('head1'));
  d.must(b.id, { kind: 'start', freeze: freezeOk(b, { limits: { max_wall_ms: WALL } }) });
  d.must(b.id, { kind: 'cancel', reason: 'không cần nữa' });
  d.send(uuidOf(999), { kind: 'confirm_task' });
  d.now += WALL;
  d.fire();
  return [a, b, c];
}

export function asUuid(id: string): Uuid {
  return id as Uuid;
}
