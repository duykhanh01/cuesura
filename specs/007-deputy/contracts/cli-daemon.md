# Contract: CLI và daemon cho deputy

Bổ sung cho [hợp đồng CLI–daemon của feature 002](../../002-task-to-green-pr/contracts/cli-daemon.md). Mọi output giữ
envelope `schema_version: 1`.

## Danh tính

| Điều kiện | Actor | Quyền |
| --- | --- | --- |
| Có `CUSR_DEPUTY_TURN` | `deputy` (bỏ qua `CUSR_ACTOR`) | `read`, `operate` |
| `CUSR_ACTOR=assistant` | `assistant` | `read`, `operate` |
| Không khai | `owner` | `read`, `operate`, `admin` |

Client gửi header `x-cusr-actor: deputy` và `x-cusr-turn: <turn_id>`. Daemon từ chối actor `deputy` khi `turn_id` không
phải lượt đang `running` (`forbidden`, `reason: 'turn'`, exit 5).

Khi có `CUSR_DEPUTY_TURN`: `cusr assistant hook`, `session-start`, `register`, `wait` thoát 0, không in gì.

## Envelope lệnh ghi

```json
{
  "request_id": "uuid",
  "kind": "task_continue",
  "project": "metronome",
  "task_id": "uuid",
  "expected_version": 42,
  "reason": "CI fail do test chập chờn, cho chạy lại",
  "payload": {}
}
```

- `reason`: chuỗi 1–4096 ký tự hoặc `null`; bắt buộc với actor `deputy` (`invalid_command`, exit 2). CLI: `--reason` trên
  mọi lệnh ghi.
- `turn_id` không nằm trong body: daemon lấy từ header đã kiểm và lưu vào `command_ledger` và `AuthzContext`.
- `command_hash` gồm thêm `reason` và `turn_id`.

## Lệnh thay đổi

| Lệnh | Thay đổi | Quyền |
| --- | --- | --- |
| `task add --draft` | Task vào PENDING `needs_draft`; không chạy preflight | `operate` |
| `task revise <id> [--title] [--description] [--acceptance <file>]` | Mới. Chỉ nhận trước khi policy đóng băng; phát `TaskRevised`; chạy lại triage, không xác nhận | `operate` |
| `task fail <id> --reason <text>` | Mới. Chỉ nhận khi task WAITING; mở PR draft nếu có việc chưa publish rồi FAILED (`failWithDraft`), lý do ghi vào FAILED | `operate` |
| `task confirm` | Từ chối khi actor là `deputy` (`forbidden`, `reason: 'deputy_confirm'`, exit 5) | `operate` |
| `task continue` | Nhận thêm `agent_runs_exhausted`, `deadline`, `backoff_exhausted`, `ci_wait_exhausted` | `operate` |
| `task amend-policy` | Thêm `--agent-runs +N`, `--deadline <ISO\|+duration>`; `--model` tùy chọn khi có một trong hai; `--confirm` hạ xuống `operate` | `read` (xem trước), `operate` (áp dụng) |
| `task show` / `explain` | Thêm `deputy: { turn_id, incident, state, started_at } \| null` khi có lượt đang chạy (FR-023) | `read` |
| `report` | Mục `deputy_decisions` thay `decider_answers`; mỗi mục có `at`, `task_id`, `incident`, `kind`, `reason`, `turn_id`; giữ cả `agent:decider` cũ | `read` |

## Lỗi mới

| Code | Khi nào | Exit |
| --- | --- | --- |
| `forbidden` (`reason: 'turn'`) | Actor `deputy` không có lượt đang mở | 5 |
| `forbidden` (`reason: 'deputy_confirm'`) | Deputy gọi `task confirm` | 5 |
| `invalid_command` (`reason` thiếu) | Actor `deputy` không gửi `reason` | 2 |
| `transition_not_allowed` | `task revise` sau khi policy đóng băng | 6 |
| `invalid_command` (`reason` thiếu) | `task fail` không có `--reason`, với mọi actor | 2 |
| `transition_not_allowed` | `task fail` khi task không ở WAITING | 6 |
