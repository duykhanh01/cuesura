# Quickstart: kiểm chứng deputy

## Điều kiện

- Daemon `cusrd` bản có feature 007, data dir mặc định.
- User config có role deputy:

  ```yaml
  roles:
    deputy:
      binding:
        - { model: opus, effort: high }
  ```

- Một lần `cusr prove-harness` / `record-manifest` cho binding đó.
- Tùy chọn: tmux server đang chạy và `runtime.terminal.backend: tmux` để xem lượt tương tác.

## Kịch bản bằng fake harness (CI)

| Kịch bản | Lệnh | Kỳ vọng |
| --- | --- | --- |
| Định tuyến đủ mã | `pnpm vitest run test/property/deputy/routing.test.ts` | Mọi `DetailCode` có nơi đến; mã loại trừ tới chủ dự án (SC-001) |
| Gỡ `ladder_exhausted` | `pnpm vitest run test/scenarios/deputy/us1.test.ts` | Deputy fake `continue`, không có attention (US1) |
| Nới ngân sách, deadline | `pnpm vitest run test/scenarios/deputy/us2.test.ts` | `PolicyAmended` actor `deputy` có lý do (US2) |
| Chuyển cho người | cùng file US1, kịch bản 4 | Wait còn nguyên sau lượt thì attention có tin nhắn cuối |
| Owner thắng | `pnpm vitest run test/scenarios/deputy/us5.test.ts` | Lệnh deputy version cũ bị từ chối; lệnh owner không bị từ chối vì lượt (SC-006) |
| Trả về worktree | `pnpm vitest run test/contract/deputy/restore.test.ts` | Sau sửa file, tạo file, commit, restart giữa lượt: HEAD và cây bằng mốc (SC-005) |
| Restart giữa lượt | `pnpm vitest run test/integration/crash/deputy.test.ts` | Không có lượt thứ hai, không lặp lệnh (SC-004) |
| Nâng cấp từ decider | `pnpm vitest run test/integration/runtime/deputy-upgrade.test.ts` | Bản ghi decider dở được đóng, reservation được trả (SC-008) |

## Kịch bản với harness thật (smoke, tốn usage)

1. Tạo task có acceptance cố ý khó, đặt `quality_tries_per_rung: 1` trong profile thử.
2. Chờ task vào `ladder_exhausted`.
3. Kỳ vọng:
   - cửa sổ `deputy: <tiêu đề>` hiện trong tmux, phiên tương tác nhận sự cố làm prompt đầu;
   - deputy gọi `cusr task amend-policy … --reason …` hoặc `continue`;
   - cửa sổ tự đóng sau khi hết lượt;
   - `cusr report` có mục quyết định với lý do và sự cố;
   - `cusr inbox` không có mục nào cho task.
4. Gõ vào cửa sổ một câu hỏi rồi để deputy kết thúc lượt mà không làm gì: sự cố chuyển cho chủ dự án, attention có tin
   nhắn cuối.
5. Tắt tmux server, lặp bước 2: lượt chạy headless, kết quả như trên.

SC-002 (một đêm thật, ít nhất 5 task, không thao tác) và SC-003 (phiên treo) chỉ kiểm được ở smoke; acceptance report ghi
"chưa đạt" nếu chưa chạy.
