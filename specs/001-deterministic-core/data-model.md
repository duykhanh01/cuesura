# Data Model: Lõi điều phối tất định

Phase 1 của [plan.md](plan.md). Kiểu dữ liệu được định nghĩa bằng Zod 4 trong `src/domain`; bảng dưới
mô tả trường và luật, không phải mã nguồn. Tên trường theo `snake_case` như SPEC.md §5.2.

## Quy ước chung

- `Uuid`: UUIDv7 dạng chuỗi, do shell cấp (research R-04). ID là định danh, không phải khoá chống lặp.
- `EpochMs`: số nguyên milliseconds. Thời lượng trong cấu hình (`10m`, `6h`) được loader đổi sang ms.
- `Hash`: `sha256:<hex>` của JSON chuẩn hoá (R-03).
- `schema_version`: số nguyên có trên task chuẩn, chính sách, ngữ cảnh, sự kiện và phong bì tín hiệu.
- `Revision`: số nguyên bắt đầu từ 1, chỉ tăng.

## Thực thể

### Project

| Trường | Kiểu | Luật |
|---|---|---|
| `id` | chuỗi slug | Duy nhất trong cấu hình người dùng |
| `base_branch` | chuỗi | Bắt buộc |
| `protected_branches` | chuỗi[] | Mặc định chứa `base_branch` (SPEC.md §14.2) |
| `project_config` | ProjectConfig | Nội dung `cusr.yaml` đã hợp nhất với pack, tại `base_sha` do caller cấp |

### Task chuẩn (CanonicalTask)

Trường theo SPEC.md §5.2: `schema_version`, `id`, `title`, `type`, `project`, `base_branch`,
`description`, `requirements`, `acceptance`, `constraints`, `out_of_scope`, `attachments`, `group`,
`parent`, `depends_on`, `priority`, `size`, `labels`, `profile`, `requested_by`, `revision`, thêm
`source_key` (khoá dedup nguồn, FR-007) và `retry_of` (task nguồn khi retry, FR-010).

- `acceptance` có ít nhất một phần tử trước READY (FR-008).
- `depends_on` trỏ tới task tồn tại, không tự tham chiếu, không tạo chu trình (FR-008).
- `attachments[]`: `{ name, media_type, content_ref }`; nội dung thật chỉ có trong ngữ cảnh đóng băng.
- Cùng `source_key` mà nội dung giống → trả task đã có; nội dung khác trước khi chạy → revision mới; sau
  khi chạy → source drift (FR-011).

### Task (projection `TaskState`)

| Trường | Ý nghĩa |
|---|---|
| `id`, `project`, `revision`, `version` | `version` tăng mỗi sự kiện; dùng cho optimistic check (FR-028) |
| `status` | `PENDING`, `READY`, `RUNNING`, `WAITING`, `DONE`, `FAILED`, `CANCELLED` |
| `wait` | `{ reason, detail, resume_when, exit_paths }` khi PENDING có lý do hoặc WAITING |
| `policy_ref`, `context_ref` | `{ revision, hash }` của chính sách và ngữ cảnh đang hiệu lực |
| `current_step`, `step_visits` | Bước hiện tại; số lần vào mỗi bước, không reset khi quay vòng |
| `attempts` | Attempt theo bước; chỉ attempt mới nhất của bước là hiện hành |
| `rungs` | `rung[step]` (chỉ số trên thang của step) và `floor_level` (mức năng lực), cả hai chỉ tăng (FR-020, R-18) |
| `failure_streaks` | Theo `(step, rung)`: chữ ký gần nhất, số lần liên tiếp, số lần thử chất lượng |
| `class_counters` | Theo `(step, lớp)`: số retry đã dùng của lớp (FR-019) |
| `budget` | Xem [Ngân sách](#ngân-sách) |
| `effects` | Gương vòng đời effect của task (id, kind, idem_key, status), phục vụ hủy và đối chiếu |
| `questions`, `approvals` | Xem [Câu hỏi, quyết định, approval](#câu-hỏi-quyết-định-approval) |
| `evidence` | Kết quả gate/review/CI đã ghi, mỗi mục gắn `revision` và `head_sha`; gồm `required_set` và `base_relation` cho merge guard (R-10) |
| `source_drift` | `null` hoặc `{ pending_revision, detected_at, safe_boundary_reached }` |
| `cancellation` | `null` hoặc `{ requested_at, by, late: boolean }` |
| `deadline_at` | Đặt lần đầu workflow chạy, kèm timer `deadline`; không đổi khi đổi revision hay restart (SPEC.md §9.4, R-22) |
| `terminal` | `{ kind, reason }` khi DONE/FAILED/CANCELLED |

### FrozenPolicy

| Trường | Ý nghĩa |
|---|---|
| `schema_version`, `task_id`, `revision`, `base_sha` | Gắn cố định với một revision |
| `workflow` | Graph đã mở rộng: bước, loại, transition, `max_visits`, `on_exhausted`, `skip_when` |
| `structure_hash` | Hash của bước, loại và cạnh transition (R-11) |
| `steps[step].binding` | Binding khởi đầu đã resolve: harness, model, effort, quyền, giới hạn |
| `steps[step].ladder` | Danh sách nấc `{ binding, level: (tier, effort_rank), state: auto/needs_approval/denied }` |
| `steps[step].floor_map` | Mức năng lực → chỉ số nấc trên thang của step, tính sẵn lúc chốt (R-18) |
| `ci.required_checks` | Tên required checks khai báo trong `cusr.yaml`, có thể rỗng (R-10) |
| `ci.rules` | Rule phân loại lỗi CI có thứ tự `{ match: { job?, check?, log_pattern? }, class }` (R-21) |
| `gates` | Gate thực tế; gate optional bị bỏ được ghi rõ (SPEC.md §8) |
| `limits` | `max_agent_runs`, `max_decider_calls`, `max_wall_ms`, `max_escalations`, giới hạn từng lớp, `backoff.{rate_limit,infra}` = `{ base_ms, factor, max_ms, max_attempts }` (R-22), `extra_visits[step]` (lượt cộng vào `max_visits`, chỉ đặt qua amendment) |
| `decision_modes` | Chỉ `human` được chốt ở feature này (FR-039) |
| `permissions` | Quyền ghi/đọc theo role |
| `config_hashes` | Hash của cấu hình người dùng, project, pack và cấu hình hiệu lực |
| `policy_hash` | Hash của toàn bộ object trên |
| `policy_version` | 1, tăng mỗi amendment |

Luật: bất biến sau khi ghi; chỉ đổi qua `PolicyAmended` có `AuthzContext` admin (FR-005, FR-036). V1
không đổi `workflow` của task đang chạy.

### FrozenExecutionContext

| Trường | Ý nghĩa |
|---|---|
| `task_id`, `revision`, `base_sha` | Trùng với FrozenPolicy cùng revision (FR-037) |
| `request` | `title`, `description`, `requirements`, `constraints`, `out_of_scope` |
| `acceptance` | Danh sách tiêu chí |
| `attachments[]` | `{ name, media_type, content, content_hash }` do caller cung cấp |
| `prompt_refs`, `conventions` | Nội dung prompt/conventions đã chụp kèm hash |
| `context_hash` | Hash của object |

Luật: tạo trong cùng sự kiện với FrozenPolicy; không chốt được một trong hai thì không ghi gì và task ở
PENDING (FR-038). Output bước trước, diff, Q&A là context tăng thêm, lưu ở `evidence`/`questions` với
provenance.

### AuthzContext

`{ actor, roles: ('read' | 'operate' | 'admin')[], issued_by, issued_at }`. Do tầng dịch vụ đã xác
thực cấp; lõi nhận như dữ liệu. Amendment chỉ hợp lệ khi `roles` chứa `admin`; `requested_by` hay tên
actor tự khai không thay được ngữ cảnh này (FR-036).

### Attempt

| Trường | Ý nghĩa |
|---|---|
| `id`, `step`, `n` | `n` đếm trong bước |
| `binding`, `rung` | Binding thực tế và nấc |
| `kind` | `initial`, `retry`, `repair`, `fresh_session` |
| `effect_id`, `reservation_id` | Effect khởi chạy và phần ngân sách giữ chỗ |
| `outcome` | `null` hoặc `{ class, signature?, status? }` |
| `usage` | `{ basis: reported/estimated/unavailable, tokens?, cost? }` (FR-024) |

Tín hiệu kết quả mang `attempt_id` khác attempt hiện hành của bước bị bỏ qua có ghi nhận
(`SignalIgnored`), không làm qua bước.

### Ngân sách

| Trường | Ý nghĩa |
|---|---|
| `agent_runs.limit` | Từ FrozenPolicy |
| `agent_runs.used` | Lượt đã xác nhận gọi agent, kể cả repair, resume, decider, lượt bị rate limit |
| `agent_runs.reserved` | Tổng giữ chỗ đang mở |
| `reservations[id]` | `{ effect_id, units, status: held/consumed/released }` |
| `decider_calls` | Cùng cấu trúc; luôn 0 ở feature này vì chỉ có chế độ `human` |
| `escalations.used` | Số lần nâng nấc |

Khả dụng = `limit − used − reserved`. Attempt chỉ được yêu cầu khi khả dụng ≥ 1 (FR-021).

### Câu hỏi, quyết định, approval

- **Question:** `{ id, attempt_id?, body, status: open/answered/withdrawn, answer?, answered_by? }`. Câu
  trả lời hợp lệ đầu tiên thắng; câu sau nhận `conflict`.
- **Approval:** `{ id, kind: escalation/merge, task_id, revision, step?, rung?, head_sha?, policy_hash,
  granted_by, revoked: boolean }`.
  - Approval escalation chỉ dùng được khi khớp task/revision, step, rung và `policy_hash` (FR-021).
  - Approval merge chỉ dùng được khi khớp `head_sha` (R-10).
  - Đổi revision làm mọi approval của revision cũ hết hiệu lực (FR-040).

### Tín hiệu (TriggerEnvelope)

| Trường | Ý nghĩa |
|---|---|
| `schema_version`, `task_id` | |
| `dedup_key` | Duy nhất toàn kho; trùng → trả kết quả cũ (FR-026) |
| `request_hash` | Hash của `{ task_id, trigger, expected_version, actor }`, không gồm `now`/`ids`; cùng `dedup_key` khác hash → `conflict` (R-19) |
| `expected_version` | Tuỳ chọn; lệnh của người phải có; lệch → `conflict` (FR-028) |
| `trigger` | Một kind trong [contracts/signals-events.md](contracts/signals-events.md#tín-hiệu) |
| `now`, `ids` | R-04 |
| `authz` | AuthzContext khi tín hiệu là lệnh của người |

### Sự kiện miền (DomainEvent)

`{ global_seq, task_id, seq, schema_version, revision, type, actor, causation: { dedup_key }, payload }`.
`seq` tăng liên tục theo task từ 1; `global_seq` theo thứ tự commit toàn kho (FR-027). Danh sách loại ở
[contracts/signals-events.md](contracts/signals-events.md#sự-kiện).

### Effect

`{ id, task_id, revision, kind, idem_key, status, request, result?, reservation_id? }`.

- `idem_key` = `<kind>:<project>:<task_id>:r<revision>:<logical_id>`. `logical_id` là danh tính thao tác:
  attempt ID cho khởi chạy agent, `head_sha` cho merge, `step` + số lần vào bước cho gate. Thử lại cùng
  thao tác dùng lại khoá; attempt nghiệp vụ mới có attempt ID mới nên có khoá mới (FR-016).
- Kho có unique constraint trên `idem_key`. `decide` gặp khoá đã có thì không phát `EffectRequested` thứ
  hai.

### Timer

`{ id, task_id, due_at, kind, payload, status: armed/fired/cancelled }`. Chỉ timer `armed` có
`due_at ≤ now` mới được tiêu thụ; mỗi timer tạo tối đa một tín hiệu `timer:<id>` (FR-030).

## Chuyển trạng thái

### Task

```text
PENDING ──triage ok──▶ READY ──start──▶ RUNNING ⇄ WAITING
   ▲                     │                │  │
   └──điều kiện mất──────┘                │  └──▶ DONE (xác nhận kết quả cuối)
mọi trạng thái chưa kết thúc ──căn cứ──▶ FAILED | CANCELLED
```

- Chỉ các cạnh trên được phép (FR-009, SPEC.md §6.1). `evolve` từ chối sự kiện tạo cạnh khác bằng lỗi
  lập trình, và property test kiểm tra điều này.
- DONE, FAILED, CANCELLED là trạng thái hút: mọi tín hiệu sau đó tạo `SignalIgnored` (FR-010).
- Hủy: chuyển CANCELLED chỉ khi không còn effect `started` hay `unknown` chưa đối chiếu. Merge đối chiếu
  thành công → DONE với `cancellation.late = true` (FR-018).

### Effect

```text
pending ──claim──▶ started ──result──▶ succeeded | failed | unknown
   │                                                   │
   └──hủy (cùng transaction)──▶ invalidated            └──đối chiếu──▶ succeeded | failed
```

`invalidated` và `succeeded`/`failed` là kết thúc. Claim kiểm tra `pending` và điều kiện claim của task
(`claimable`, R-16) trong cùng transaction (FR-031, FR-011). Effect bị chặn vẫn ở `pending`. Đối chiếu
`unknown → succeeded` chỉ xảy ra khi có đủ kết quả chuẩn của loại effect (FR-017, R-17).

### Giữ chỗ ngân sách

```text
held ──xác nhận agent đã chạy──▶ consumed
held ──chắc chắn chưa chạy (effect invalidated)──▶ released
held ──effect unknown──▶ held (giữ nguyên tới khi đối chiếu)
```

### Nấc model

Nấc mục tiêu = `max(rung[step], floor_map[step][floor_level], nấc_đề_xuất)`, trong đó `floor_map` ánh
xạ mức năng lực của sàn sang chỉ số trên thang của chính step đó (R-18). Không có sự kiện nào làm giảm
`rung[step]` hay `floor_level` (FR-020). Sau khi có nấc mục tiêu, lõi kiểm tra theo thứ tự: còn trong
thang, không `denied`, có approval khớp nếu `needs_approval`, còn giới hạn escalation và ngân sách. Không
đạt điều kiện nào thì task chờ theo bảng ở [R-13](research.md#r-13-lý-do-chờ-cho-các-tình-huống-spec-mới-thêm).

## Lý do chờ và chi tiết

Tập `wait_reason` giữ nguyên SPEC.md §6.1. Mọi trạng thái chờ có:

- `resume_when`: điều kiện tiếp tục (ví dụ `answer(question_id)`, `timer(id)`, `approval(id)`);
- `exit_paths`: đường kết thúc (ví dụ `cancel`, `fail`, `new_task`).

Bảng ánh xạ tình huống → `wait_reason` + `detail.code` nằm ở
[research R-13](research.md#r-13-lý-do-chờ-cho-các-tình-huống-spec-mới-thêm).

## Lưu trữ SQLite

Migration `001_init.sql`. Mọi bảng trừ `events`, `accepted_triggers`, `frozen_policies`,
`frozen_contexts` là projection dựng lại được.

| Bảng | Cột chính | Ràng buộc |
|---|---|---|
| `schema_meta` | `version` | Một dòng |
| `accepted_triggers` | `dedup_key` PK, `request_hash`, `task_id`, `envelope_json`, `outcome_json`, `global_seq_from`, `global_seq_to` | PK chặn trùng |
| `events` | `global_seq` INTEGER PK AUTOINCREMENT, `task_id`, `seq`, `type`, `revision`, `schema_version`, `actor`, `dedup_key`, `payload_json` | `UNIQUE(task_id, seq)`; FK `dedup_key` |
| `frozen_policies` | `task_id`, `revision`, `policy_version`, `policy_hash`, `policy_json` | `PRIMARY KEY(task_id, revision, policy_version)` |
| `frozen_contexts` | `task_id`, `revision`, `context_hash`, `base_sha`, `context_json` | `PRIMARY KEY(task_id, revision)` |
| `tasks` | `id` PK, `project`, `source_key`, `status`, `wait_reason`, `version`, `state_json` | `UNIQUE(project, source_key)` |
| `task_deps` | `task_id`, `depends_on` | PK hai cột |
| `effects` | `id` PK, `task_id`, `revision`, `kind`, `idem_key`, `status`, `request_json`, `result_json` | `UNIQUE(idem_key)`; `CHECK(status IN (...))` |
| `timers` | `id` PK, `task_id`, `due_at`, `kind`, `status`, `payload_json` | Index `(status, due_at)` |

`frozen_policies` và `frozen_contexts` được ghi trong cùng transaction với sự kiện `PolicyFrozen` hoặc
`PolicyAmended`, và có thể kiểm chứng lại bằng hash trong payload sự kiện.
