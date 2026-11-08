# Contract: Lượt deputy giữa daemon và runner

## Đầu vào

Daemon gọi `HarnessPort.run(input)` với `input.role = 'deputy'` và:

| Trường | Giá trị |
| --- | --- |
| `attempt_id` | ID attempt mới của runner |
| `operation_id` | ID operation mới |
| `session` | `{ ref: deputy_sessions.session_ref }`, hoặc `null` cho lượt đầu và lượt mở phiên mới |
| `context.text` | Prompt của lượt (bên dưới) |
| `schema` | không dùng (lượt tương tác không trả cấu trúc) |
| `wall_ms` | `roles.deputy.limits.wall_ms` hoặc không có |
| `limits.stall_ms` | `roles.deputy.limits.stall_ms`, mặc định theo runtime |
| `env` thêm | `CUSR_DEPUTY_TURN=<turn_id>`; không có `CUSR_ATTEMPT_ID` |
| `view` | `{ project, title: 'deputy: <tiêu đề task>' }` |
| `interactive` | `true` khi terminal backend khả dụng và adapter có argv tương tác |

Cwd là `<data dir>`, không phải worktree.

## Prompt của lượt

Dựng bằng code, theo thứ tự cố định để phần đầu trúng prompt cache:

1. Vai trò deputy (văn bản cố định của role): làm thay chủ dự án, hành động bằng `cusr` với `--reason`, không sửa worktree
   của task khác, không làm ngược thao tác của chủ dự án, kết thúc lượt khi đã xử lý xong hoặc cần người.
2. Task: id, project, tiêu đề, đường dẫn worktree (chỉ để đọc), lệnh đọc nhanh (`cusr task explain <id> --json`).
3. Khi `seeded`: bản tóm tắt do code dựng từ lịch sử task và các quyết định deputy trước đó.
4. Thao tác của actor khác từ lượt trước (FR-017), mỗi dòng: thời điểm, actor, lệnh, lý do.
5. Sự cố: mã wait, chi tiết, bằng chứng, các lệnh khả dụng (`allowed_actions` của explain).

## Kết thúc lượt

- Hook do Cuesura cài trong private home (Stop của Claude, `notify` của Codex) ghi
  `<run dir>/turn-ended.json`: `{ "turn_id": "...", "final_message": "...|null" }`. Hook của chủ dự án vẫn chạy.
- Runner thấy file thì gửi TERM sau `term_grace_ms`, finalize run dir, và trả
  `{ kind: 'turn_ended', final_message, session_ref, usage }`.
- Chế độ headless: process tự thoát khi hết lượt; runner trả `turn_ended` với tin nhắn cuối từ stream.
- `recover(input)` đọc lại `turn-ended.json` hoặc kết quả đã finalize; không bao giờ spawn lại.

## Daemon sau lượt

1. Trả worktree về `deputy-baseline-<turn_id>.json` (R-08).
2. Đọc wait hiện tại của task: còn đúng `incident` thì `handed_off` (`still_waiting`) kèm `final_message`; không thì
   `done`.
3. Lỗi: theo bảng FR-024 (R-12).
4. Cập nhật `deputy_sessions.session_ref`.

Mọi bước ghi bảng `deputy_*` trong transaction riêng, không đụng `events`.
