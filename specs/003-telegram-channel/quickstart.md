# Quickstart: kiểm chứng kênh Telegram

Hướng dẫn chạy các kịch bản nghiệm thu của feature 003. Hợp đồng lệnh ở [contracts/cli-daemon.md](contracts/cli-daemon.md),
hành vi trong chat ở [contracts/telegram.md](contracts/telegram.md).

## Kiểm tự động

```bash
pnpm vitest run test/contract/telegram test/integration/telegram
```

```bash
pnpm test:reliability telegram --kills 100
```

| Nhóm | Phủ |
| --- | --- |
| `test/unit/application/notify/` | Hàm suy thông báo từ cặp state, khóa, cắt tin; phân loại lỗi Bot API ở `test/unit/adapters/` |
| `test/property/` | `confirm_task_with_run_config`; thứ tự gửi (FR-006); `deciderQuestion` với lần chạy hỏng |
| `test/integration/telegram/` | Daemon thật + Telegram giả lập: US1–US5, lặp 2–5 lần mỗi update (SC-003), cạnh tranh Telegram–CLI |
| `test/integration/crash/`, `test/reliability/` | Crash point mới trên SQLite thật, ít nhất 100 seed (SC-004, SC-005) |
| `test/contract/cli/` | `cusr telegram *`, `cusr inbox` mới, `task confirm --run-config`, output `--json` và exit code |

Telegram giả lập (`test/support/fake-telegram.ts`) chạy qua `CUSR_TELEGRAM_API_BASE`; kết quả của nó không được ghi là smoke
thật (SC-010).

## Smoke với bot thật

Điều kiện: một bot thử tạo bằng @BotFather, một tài khoản Telegram để chat riêng với bot, daemon chạy trên máy thử.

1. Setup và liên kết (US1, SC-001; bấm giờ từ lúc có token):

   ```bash
   cusr telegram setup < bot.token
   ```

   ```bash
   cusr telegram link --role admin
   ```

   Mở deep link trên điện thoại, bấm Start. Kỳ vọng: CLI báo đã liên kết; bot chào; `cusr telegram status` có `link`.

2. Câu hỏi (US2, SC-002): tạo task mà worker sẽ hỏi (harness giả lập hoặc task thật cần làm rõ). Kỳ vọng: tin câu hỏi đến
   trong 1 phút; reply trên điện thoại; bot xác nhận trong 1 phút; `cusr task explain` thấy task chạy tiếp và
   `answered_via: telegram`.

3. Trả lời bằng CLI trước (US2.3): câu hỏi mới, trả lời bằng `cusr answer`. Kỳ vọng: bản tin trên điện thoại đổi thành "Đã
   trả lời…", mất hướng dẫn trả lời.

4. Duyệt và xác nhận (US3): tạo task chờ duyệt nâng model và task chờ xác nhận. Bấm nút. Liên kết lại với `--role operate`
   rồi thử một thẻ duyệt mới: không có nút. Bấm nút trên bản tin của liên kết cũ: "Hết hiệu lực".

5. Inbox và report (US4): `/inbox`, "Mở" một mục, "Trang sau" khi có hơn 8 mục, `/report 2d`. So với `cusr inbox --json` và
   `cusr report --since 2d`.

6. Kênh lỗi (US5, SC-007): tắt mạng máy chạy daemon khi có câu hỏi mới; trả lời bằng CLI; bật mạng. Kỳ vọng: task không
   đổi trạng thái vì kênh; `cusr status` báo đường gửi hỏng; sau khi có mạng, bản tin được sửa thành "Đã trả lời" và yêu cầu
   duyệt còn chờ được gửi lại một lần.

7. Bảo mật (SC-006, SC-009): nhắn bot từ một tài khoản khác và từ một nhóm; `grep` token trong `DATA_DIR/logs`, output
   `--json` của mọi lệnh và bảng `notifications`, `tg_updates`. Kỳ vọng: không phản hồi, không có token.

Ghi kết quả từng bước vào `acceptance-report.md`; bước nào không chạy được thì ghi chưa kiểm và lý do.
