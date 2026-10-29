import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
import { choicesArb, drive } from '../arbitraries/signals.ts';
import {
  policyArb,
  propertyParams,
  taskOverArb,
} from '../arbitraries/policies.ts';

describe('I01 quyết định tất định', () => {
  it('cùng đầu vào cho cùng Decision; decide không sửa đầu vào; phát lại cho cùng kết quả', () => {
    fc.assert(
      fc.property(
        policyArb,
        taskOverArb,
        choicesArb(),
        (policy, over, choices) => {
          // Ở mỗi bước, `Sim` gọi decide trên đầu vào đóng băng sâu và trên một bản sao, rồi so JSON chuẩn
          // hoá: decide không ghi vào đầu vào và không đọc gì ngoài nó (đồng hồ, ngẫu nhiên đã bị lint chặn).
          const run = drive(policy, over, choices);
          // Phát lại toàn bộ nhật ký đầu vào trên harness mới cho cùng sự kiện, quyết định và state.
          run.sim.replayCheck();
        },
      ),
      propertyParams(),
    );
  });

  it('hai lần chạy cùng chuỗi lựa chọn cho cùng quyết định và trạng thái cuối', () => {
    fc.assert(
      fc.property(
        policyArb,
        taskOverArb,
        choicesArb(40),
        (policy, over, choices) => {
          const a = drive(policy, over, choices);
          const b = drive(policy, over, choices);
          expect(canonicalJson(b.sim.decisions)).toBe(
            canonicalJson(a.sim.decisions),
          );
          expect(canonicalJson(b.sim.state)).toBe(canonicalJson(a.sim.state));
        },
      ),
      propertyParams(30),
    );
  });
});
