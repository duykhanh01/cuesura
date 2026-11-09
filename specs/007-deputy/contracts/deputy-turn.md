# Contract: Lượt deputy giữa daemon và runner

## Đầu vào

Daemon gọi `HarnessPort.run(input)` với `input.role = 'deputy'` và:

| Trường | Giá trị |
| --- | --- |
| `attempt_id` | ID attempt mới của runner |
| `operation_id` | ID operation mới |
| `session` | `null` khi mở lượt; `{ ref: deputy_turns.session_ref }` khi chạy lại trong cùng lượt (FR-011) |
| `context.text` | Context của lượt (bên dưới) |
| `schema` | không dùng |
| `wall_ms` | `roles.deputy.limits.wall_ms` hoặc không có |
| `limits.stall_ms` | `roles.deputy.limits.stall_ms`, mặc định theo runtime |
| `env` thêm | `CUSR_DEPUTY_TURN=<turn_id>`; không có `CUSR_ATTEMPT_ID` |
| `view` | `{ project, title: 'deputy: <tiêu đề task hay goal>' }` |
| `interactive` | `true` khi terminal backend khả dụng và adapter có argv tương tác |

Cwd là `<data dir>`, không phải worktree.

## Context của lượt

Dựng bằng `src/application/deputy-context.ts`, thứ tự cố định (FR-061). Mỗi vùng mở đầu bằng một tiêu đề cố định.

1. **Vai trò** (văn bản cố định của role): làm thay chủ dự án; hành động bằng `cusr` với `--reason`, và `--hypothesis`,
   `--expect` cho lệnh gia hạn; bảng nguyên nhân → hành động khuyến nghị; luật chống lặp mà daemon áp; không sửa worktree
   của task khác; không làm ngược thao tác của chủ dự án; luôn kết thúc bằng `cusr deputy handoff`.
2. **Goal (ổn định):** yêu cầu nguyên văn; chỉ thị của chủ dự án theo thứ tự thời gian, mỗi dòng có actor và thời điểm;
   kế hoạch ở version hiện tại (tóm tắt, phạm vi, điều không làm, mỗi đơn vị một khối: khóa, tiêu đề, tiêu chí nghiệm
   thu, scope, phụ thuộc). Goal ẩn: chỉ tiêu đề và mô tả của task.
3. **Task gặp sự cố:** id, worktree (chỉ để đọc), tóm tắt lịch sử do code dựng (step đã qua, số attempt mỗi step, model
   đã dùng); tín hiệu vòng lặp; bảng thử trên chữ ký hiện tại; các bàn giao trước của task (mới nhất đầy đủ, cũ hơn chỉ
   `decision` và `ruled_out`). Lượt `plan`: lý do lập hay sửa kế hoạch và các đơn vị FAILED kèm bàn giao cuối của chúng.
4. **Biến động:** mỗi đơn vị một dòng (khóa, trạng thái, step, wait); sự kiện gần nhất của các đơn vị khác; xung đột nhánh
   (`branch_conflicts`); thao tác ghi của actor khác từ lượt trước của task này, mỗi dòng có actor, lệnh, lý do.
5. **Sự cố:** mã wait, chi tiết, bằng chứng, chữ ký lỗi, lệnh khả dụng (`allowed_actions` của explain) sau khi lọc theo
   bảng quyền và loop guard (lệnh sẽ bị từ chối được ghi rõ là bị từ chối và vì sao).

Ngân sách: `roles.deputy.limits.context_bytes` (mặc định 16384) cho vùng 2–5; vùng 3, 4, 5 lần lượt tối đa 40%, 25%, 20%
của phần còn lại sau vùng 2. Vượt thì gộp mục cũ nhất thành dòng đếm. Vùng 2 không bị cắt.

Lệnh đọc gợi ý trong context: `cusr task explain <id> --json`, `cusr task logs`, `cusr task gate-log`, `cusr goal show <id>`,
`git -C <worktree> diff`.

## Bàn giao

`cusr deputy handoff --cause <cause> --decision <text> [--ruled-out <text>]... [--next <text>]`, hoặc `--file <json>`:

```json
{
  "cause": "model | strategy | review_dispute | process | limit | environment | spec | none",
  "decision": "continue | handover | fail | planned | answered | text tự do ngắn",
  "ruled_out": [{ "hypothesis": "…", "why": "…" }],
  "next_look": "…"
}
```

- `decision: handover` báo daemon chuyển sự cố còn mở cho người khi lượt kết thúc, và là một lối ra hợp lệ trên chữ ký đã
  cạn (FR-043.3), nên loop guard không kết thúc task.
- Gọi nhiều lần trong lượt thì bản cuối thắng. Lệnh này chỉ ghi `deputy_turns.handoff_json`, không sinh event.

## Kết thúc lượt

- Hook do Cuesura cài trong private home (Stop của Claude, `notify` của Codex) ghi `<run dir>/turn-ended.json`:
  `{ "turn_id": "...", "final_message": "...|null" }`. Hook của chủ dự án vẫn chạy.
- Runner thấy file thì gửi TERM sau `term_grace_ms`, finalize run dir, trả
  `{ kind: 'turn_ended', final_message, session_ref, usage }`.
- Headless: process tự thoát; runner trả `turn_ended` với tin nhắn cuối từ stream.
- `recover(input)` đọc lại `turn-ended.json` hoặc kết quả đã finalize; không spawn lại.

## Daemon sau lượt

Trong suốt lượt và tới khi bước 1 xong, dispatcher không chạy effect nào ghi worktree của task này; lệnh của deputy như
`continue` chỉ dẫn tới việc của worker sau đó (FR-017, R-08).

1. Trả worktree về `deputy-baseline-<turn_id>.json` (R-08).
2. Không có bàn giao: ghi `aborted` kèm danh sách lệnh của lượt (command ledger theo `turn_id`).
3. Đọc trạng thái hiện tại:
   - `decision: handover`, hay sự cố còn đúng khóa: `handed_off` kèm bàn giao và `final_message`, trừ bước 4;
   - không thì `done`.
4. Loop guard (R-19): sự cố còn mở và chữ ký đã cạn mà không có `handover` thì gửi `task_fail` với actor
   `system:loop-guard`, lượt ghi `done`.
5. Lỗi: theo FR-024 (R-12).

Mọi bước ghi `deputy_turns` trong transaction riêng, không đụng `events`.
