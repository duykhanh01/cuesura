# Quickstart: kiểm chứng deputy và goal

## Điều kiện

- Daemon `cusrd` bản có feature 007, data dir mặc định.
- User config có role deputy và mức model tối đa qua `allow_models`:

  ```yaml
  roles:
    deputy:
      binding:
        - { model: opus, effort: high }
      limits:
        context_bytes: 16384
  ```

- Một lần `cusr prove-harness` / `record-manifest` cho binding đó.
- Project có ít nhất một required check (để dùng goal nhiều đơn vị).
- Tùy chọn: tmux server đang chạy và `runtime.terminal.backend: tmux` để xem lượt tương tác.

## Kịch bản bằng fake harness (CI)

| Kịch bản | Lệnh | Kỳ vọng |
| --- | --- | --- |
| Định tuyến đủ mã | `pnpm vitest run test/property/deputy/routing.test.ts` | Mọi `DetailCode` có nơi đến (FR-001) |
| Gỡ sự cố, bàn giao | `pnpm vitest run test/scenarios/deputy/us1.test.ts` | Không attention; `aborted` khi thiếu bàn giao; lượt mới là phiên mới (US1, SC-001) |
| Chống lặp | `pnpm vitest run test/scenarios/deputy/us2.test.ts test/property/deputy/loop-guard.test.ts` | Lặp không bằng chứng bị từ chối; cạn hết thì loop guard kết thúc task (US2, SC-009) |
| Bản miễn | `pnpm vitest run test/property/deputy/waivers.test.ts` | Miễn đúng chữ ký; không áp cho protected branch |
| Kế hoạch | `pnpm vitest run test/scenarios/deputy/us3-plan.test.ts` | Duyệt bằng hash; hash cũ bị từ chối; sửa phạm vi chờ duyệt |
| Nhánh goal | `pnpm vitest run test/scenarios/deputy/us3-integration.test.ts` | Song song, merge commit từng đơn vị, task tổng mở PR (SC-012) |
| Song song xuyên goal | `pnpm vitest run test/integration/runtime/goal-scheduler.test.ts` | Dispatch không đổi khi có lượt (SC-011) |
| Lease | `pnpm vitest run test/scenarios/deputy/us5.test.ts` | Ghi goal cần lease; đọc không cần |
| Owner thắng, race | `pnpm vitest run test/scenarios/deputy/us6-task.test.ts test/scenarios/deputy/us6-goal.test.ts` | Version, plan version, request ID (SC-006) |
| Context không phình | `pnpm vitest run test/property/deputy/context.test.ts` | Vùng 3–5 trong ngân sách (SC-010) |
| Trả về worktree | `pnpm vitest run test/contract/deputy/restore.test.ts` | HEAD và cây bằng mốc (SC-005) |
| Restart | `pnpm vitest run test/integration/crash/deputy-turn.test.ts test/integration/crash/goal-merge.test.ts` | Không lượt thứ hai, không lặp lệnh, không merge commit thứ hai (SC-004) |
| Nâng cấp | `pnpm vitest run test/integration/runtime/deputy-upgrade.test.ts` | Decider dở được đóng; config cũ nạp được (SC-008) |

## Kịch bản với harness thật (smoke, tốn usage)

1. Trong một phiên trợ lý giữ lease: `cusr goal add --project <p> --file request.md` với yêu cầu cần ít nhất năm đơn vị,
   có phụ thuộc.
2. Chờ tin "kế hoạch chờ duyệt". `cusr goal show <id>`: kiểm mục tiêu, phạm vi, đơn vị, tiêu chí nghiệm thu, phụ thuộc,
   nhóm song song, version, hash.
3. `cusr goal confirm <id> --plan-hash <hash>`, rồi đóng phiên trợ lý.
4. Sáng hôm sau, từ một phiên trợ lý khác: `cusr goal show <id>`. Kỳ vọng:
   - PR của goal ở trạng thái ready, CI xanh;
   - nhánh goal có một merge commit cho mỗi đơn vị;
   - mô tả PR liệt kê đơn vị, bản miễn, quyết định của deputy;
   - `cusr report` có các quyết định với lý do, giả thuyết, tiêu chí, kết quả;
   - không có lệnh nào của người giữa bước 3 và bước 4 (SC-002).
5. Phiên treo: trong một lượt tương tác, mở hộp thoại của harness và để nguyên; lượt tiếp tục ở headless sau `stall_ms`
   (SC-003).
6. Tắt tmux server, đưa một task vào `ladder_exhausted`: lượt chạy headless, kết quả như trên.

SC-002 và SC-003 chỉ kiểm được ở smoke; acceptance report ghi "chưa đạt" nếu chưa chạy.
