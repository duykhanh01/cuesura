# Contract: CLI và daemon cho deputy và goal

Bổ sung cho [hợp đồng CLI–daemon của feature 002](../../002-task-to-green-pr/contracts/cli-daemon.md). Mọi output giữ
envelope `schema_version: 1`. Lệnh goal ở [contracts/goal.md](goal.md).

## Danh tính và quyền

| Điều kiện | Actor | Quyền |
| --- | --- | --- |
| Có `CUSR_DEPUTY_TURN` | `deputy` (bỏ qua `CUSR_ACTOR`) | `read`, `operate` trong bảng quyền của deputy |
| `CUSR_ACTOR=assistant` | `assistant` | `read`, `operate`; lệnh goal cần lease |
| Không khai | `owner` | `read`, `operate`, `admin` |

Client gửi `x-cusr-actor`; với deputy thêm `x-cusr-turn: <turn_id>`; với trợ lý thêm `x-cusr-lease` khi biết (R-26).

Kiểm tra lệnh của actor `deputy` (FR-051), theo thứ tự:

0. Replay: `request_id` đã có trong `command_ledger` với cùng actor và `command_hash` thì trả kết quả cũ, bỏ qua mọi bước
   dưới (FR-055). Áp cho mọi actor, kể cả lease của trợ lý.
1. `turn_id` là lượt `running` → không thì `forbidden`, `reason: 'turn'`.
2. Task hay goal của lệnh thuộc goal của lượt → không thì `forbidden`, `reason: 'turn_scope'`.
3. Loại lệnh nằm trong bảng quyền (FR-034) → không thì `forbidden`, `reason: 'deputy_kind'`.
4. `reason` có; lệnh gia hạn có `trial` → không thì `invalid_command`.
5. Loop guard (R-19) → `conflict` với `reason: 'repeat_without_evidence' | 'action_exhausted' | 'signature_exhausted'` và
   `detail` nêu dòng thử trước đó.

Khi có `CUSR_DEPUTY_TURN`: `cusr assistant hook|session-start|register|wait` thoát 0, không in gì.

## Envelope lệnh ghi

```json
{
  "request_id": "uuid",
  "kind": "task_continue",
  "project": "metronome",
  "task_id": "uuid",
  "expected_version": 42,
  "reason": "CI fail do test chập chờn, cho chạy lại",
  "trial": { "hypothesis": "test X chập chờn do timeout", "expect": "check `test` xanh ở lần chạy lại" },
  "payload": {}
}
```

- `reason`: 1–4096 ký tự hoặc `null`; bắt buộc với `deputy`.
- `trial`: `null` hoặc `{ hypothesis, expect }`, mỗi trường 1–2048 ký tự; bắt buộc với lệnh gia hạn của `deputy`
  (`task_continue`, `task_amend_policy`, `task_message`, `task_waive`, `task_approve` loại escalation).
- `turn_id` và lease lấy từ header đã kiểm, không từ body; lưu vào `command_ledger`.
- `command_hash` gồm `reason`, `trial`, `turn_id`.

## Lệnh thay đổi hoặc mới

| Lệnh | Thay đổi | Quyền |
| --- | --- | --- |
| mọi lệnh ghi | `--reason <text>` | |
| `task continue`, `task amend-policy`, `task message`, `task waive`, `task approve --kind escalation` | `--hypothesis <text>`, `--expect <text>` | |
| `task fail <id> --reason <text>` | Mới. Chỉ khi WAITING; `failWithDraft` | `operate` |
| `task waive <id> (--finding <key> \| --gate <name> \| --check <name>) --evidence <text\|@file>` | Mới. FR-045 | `operate` |
| `task continue` | Nhận thêm `agent_runs_exhausted`, `deadline`, `backoff_exhausted`, `ci_wait_exhausted` | `operate` |
| `task amend-policy` | Thêm `--agent-runs +N`, `--deadline <ISO\|+duration>`; `--confirm` hạ xuống `operate` | `read` (xem trước), `operate` (áp dụng) |
| `task confirm` | Từ chối với `deputy` (`forbidden`, `reason: 'deputy_kind'`) | `operate` |
| `task show` / `explain` | Thêm `goal: { id, unit_key, role } \| null`, `deputy: { turn_id, kind, incident, state, started_at } \| null`, `loop_signals`, `signature`, `waivers`, `conflicts` | `read` |
| `goal add\|revise\|note\|propose\|amend\|confirm\|cancel\|show\|list` | Mới, [contracts/goal.md](goal.md) | |
| `deputy handoff` | Mới, chỉ khi có `CUSR_DEPUTY_TURN`; [contracts/deputy-turn.md](deputy-turn.md#bàn-giao) | `operate` (deputy) |
| `report` | Mục `deputy_decisions` thay `decider_answers` (giữ `agent:decider` cũ); mục `waivers`; mục `goals` | `read` |

## Lỗi mới

| Code | Khi nào | Exit |
| --- | --- | --- |
| `forbidden` (`turn`, `turn_scope`, `deputy_kind`) | FR-051 | 5 |
| `forbidden` (`lease_required`) | Lệnh goal của trợ lý không giữ lease (FR-101) | 5 |
| `invalid_command` (`reason`, `trial` thiếu) | FR-052, FR-042 | 2 |
| `conflict` (`repeat_without_evidence`, `action_exhausted`, `signature_exhausted`) | Loop guard (FR-043) | 6 |
| `conflict` (`plan_version`, `plan_hash`) | Kế hoạch đã đổi (FR-054, FR-074) | 6 |
| `plan_invalid` | [contracts/goal.md](goal.md#kiểm-tra-validateplan) | 2 |
| `transition_not_allowed` | `task fail` khi không WAITING; `goal propose` sai trạng thái | 6 |
