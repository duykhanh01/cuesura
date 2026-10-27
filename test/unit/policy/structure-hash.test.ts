import { describe, expect, it } from 'vitest';
import { structureHash } from '../../../src/policy/structure-hash.ts';
import { SOFTWARE_DEV } from '../../../src/engine/workflows/software-dev.ts';
import type { Workflow } from '../../../src/domain/workflow.ts';

// Đổi hằng số này nghĩa là đổi graph của software_dev@1: cần tên phiên bản mới (R-11).
const SOFTWARE_DEV_STRUCTURE = 'sha256:bc4d48ee99b452b6feb8bd0702fd66795501a4d12a9ffe4e06c81e2e0fb0a2e0';

function edit(f: (w: Workflow) => void): Workflow {
  const w = structuredClone(SOFTWARE_DEV);
  f(w);
  return w;
}

describe('structure_hash (R-11)', () => {
  it('hằng số cho software_dev@1', () => {
    expect(structureHash(SOFTWARE_DEV)).toBe(SOFTWARE_DEV_STRUCTURE);
  });

  it('bỏ qua tham số: giới hạn lượt, gate, skip_when, thời lượng, decisions', () => {
    const w = edit((x) => {
      x.steps.code!.max_visits = 3;
      x.steps.gates!.run = ['build'];
      x.steps.review!.skip_when = { size: ['XS', 'S'] };
      x.steps.ci!.poll = 1_000;
      x.decisions = {};
    });
    expect(structureHash(w)).toBe(SOFTWARE_DEV_STRUCTURE);
  });

  it('đổi cạnh transition, loại bước hay thêm bước làm hash khác', () => {
    expect(structureHash(edit((x) => (x.steps.gates!.next.fail = 'code')))).not.toBe(SOFTWARE_DEV_STRUCTURE);
    expect(structureHash(edit((x) => (x.steps.review!.kind = 'agent')))).not.toBe(SOFTWARE_DEV_STRUCTURE);
    expect(structureHash(edit((x) => (x.steps.extra = { kind: 'complete', next: {} })))).not.toBe(SOFTWARE_DEV_STRUCTURE);
  });

  it('không phụ thuộc thứ tự khai báo bước', () => {
    const reversed: Workflow = { ...SOFTWARE_DEV, steps: Object.fromEntries(Object.entries(SOFTWARE_DEV.steps).reverse()) };
    expect(structureHash(reversed)).toBe(SOFTWARE_DEV_STRUCTURE);
  });
});
