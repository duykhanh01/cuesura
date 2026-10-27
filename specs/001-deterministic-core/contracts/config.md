# Contract: Cấu hình và chẩn đoán

Phạm vi: phần cấu hình mà feature 001 đọc và kiểm tra. Ví dụ đầy đủ ở docs/architecture.md §5.2 và
§5.2b; contract này chốt thẩm quyền của từng file, thứ tự hợp nhất và định dạng lỗi.

## Thẩm quyền theo file (FR-001)

| Khoá | `~/.cusr/config.yaml` | `cusr.yaml` | Pack | Override khi tạo task |
|---|---|---|---|---|
| `harnesses`, `models`, `roles`, `workflows`, `profiles` | Có | **Lỗi** | Không | Chỉ khoá profile cho phép |
| `pools` chung | Có | **Lỗi** | Không | Không |
| `projects` (repo được phép, branch, quyền) | Có | **Lỗi** | Không | Không |
| `permissions`, `yolo` | Có | **Lỗi** | Không | Không bao giờ nới quyền |
| `setup`, `gates`, `autofix`, `log_digest`, `signature`, `ci_rules`, `hotspots`, `conventions` | Không | Có | Có | Chỉ khoá profile cho phép |
| `ci.required_checks` | Không | Có | Không | Không |
| `pools` riêng của project | Không | Có | Không | Không |
| `extends` (tên pack) | Không | Có | Không | Không |
| `profile` mặc định của repo | Không | Có (tham chiếu tên) | Không | Có |

"**Lỗi**" nghĩa là chẩn đoán `forbidden_key` tại vị trí khoá đó, không âm thầm bỏ qua.

## Thứ tự hợp nhất

1. Pack theo thứ tự trong `extends` (pack sau ghi đè pack trước).
2. `cusr.yaml` ghi đè pack cho khoá thuộc project. Map được hợp nhất theo khoá; mảng và giá trị vô hướng
   được thay thế, không nối.
3. Profile (có thể `extends` profile khác, không chu trình) quy định khoá override được.
4. Override khi tạo task áp sau cùng, chỉ trên khoá profile cho phép. Override làm tăng quyền vượt
   `AuthzContext` của người gọi → `override_exceeds_caller`.

Cấu hình hiệu lực sau bước 4 được chuẩn hoá (điền mặc định, đổi thời lượng sang ms) rồi mới hash
(research R-03).

## Định dạng chẩn đoán

```ts
type Diagnostic = {
  code: DiagnosticCode;
  severity: 'error';            // feature 001 không có cảnh báo không chặn
  file: string;                 // đường dẫn caller đưa vào, ví dụ "cusr.yaml"
  line: number;                 // bắt đầu từ 1
  col: number;                  // bắt đầu từ 1
  path: (string | number)[];    // đường dẫn khoá trong tài liệu
  message: string;              // tiếng Việt, nêu nguyên nhân và tên liên quan
};
```

Hiển thị chuẩn: `cusr.yaml:14:7 unknown_step: transition 'fail' của bước 'gates' trỏ tới 'fixx'`.
Danh sách lỗi sắp theo `(file, line, col)`; loader trả đủ lỗi tìm được, không dừng ở lỗi đầu tiên,
trừ lỗi cú pháp và lỗi vượt kích thước làm tài liệu không đọc được.

## Mã chẩn đoán

| Nhóm | Mã | Nguồn |
|---|---|---|
| Cú pháp | `yaml_syntax`, `duplicate_key`, `unsupported_tag`, `alias_limit`, `file_too_large` | FR-002 |
| Schema | `schema_invalid`, `forbidden_key`, `unknown_pack` | FR-001, FR-002 |
| Tham chiếu | `unknown_role`, `unknown_model`, `unknown_pool`, `unknown_gate`, `unknown_step`, `unknown_profile` | FR-003 (1) |
| Outcome | `outcome_without_target`, `outcome_not_in_kind` | FR-003 (2) |
| Chu trình | `unbounded_cycle`, `no_task_bound` | FR-003 (3) |
| Thang | `unreachable_rung`, `rung_beyond_role` | FR-003 (4) |
| Binding | `no_initial_binding` | FR-003 (5) |
| Predicate | `unknown_predicate` | FR-003 (6) |
| Chế độ quyết định | `decision_mode_forbidden` | FR-006 |
| Gate | `required_gate_missing`, `no_gates_not_allowed` | SPEC.md §8 |
| Profile | `profile_cycle`, `override_not_allowed`, `override_exceeds_caller` | FR-001 |

## Khả năng chưa hỗ trợ

Không phải chẩn đoán lỗi. `validateConfig` vẫn trả cấu hình hợp lệ, kèm danh sách `unsupported`
(contracts/core-api.md, research R-20):

| Mã | Khi nào | Bị chặn ở đâu |
|---|---|---|
| `decision_mode_unsupported` | Workflow có điểm quyết định dùng `agent`, `agent_if_confident` hoặc `agent_review` | `freeze` cho task dùng workflow đó (FR-039) |
| `unsupported_workflow` | `structure_hash` của workflow khác `software_dev@1` | `freeze` cho task dùng workflow đó (FR-041) |

Một workflow chưa hỗ trợ không làm hỏng các workflow khác trong cùng cấu hình. Ngược lại,
`decision_mode_forbidden` (decider cho loại quyết định bị cấm ở FR-006) luôn là lỗi.

## Predicate cho phép

`flag`, `size`, `label`, `task_type`, `attempt_gte`, `target_branch` (SPEC.md §8, docs/architecture.md
§5.2). Không có `eval` hay biểu thức tự do.

## Backoff (thuộc profile)

`profiles.<name>.limits.backoff.{rate_limit,infra}` = `{ base, factor, max, max_attempts }`; `base`,
`max` là thời lượng. Mặc định khi không khai báo: `rate_limit` = `60s`, ×2, `30m`, 5 lần; `infra` = `5s`,
×2, `5m`, 3 lần (research R-22). `max_attempts` phải ≥ 0 và hữu hạn; thiếu cận trên là `schema_invalid`.

## Rule phân loại CI

`ci_rules` trong `cusr.yaml` là danh sách có thứ tự `{ match: { job?, check?, log_pattern? }, class }`
với `class` ∈ `flaky_or_infra`, `autofix`, `code`. `log_pattern` dài tối đa 256 ký tự; regex không
biên dịch được là `schema_invalid`. Được chốt vào `FrozenPolicy.ci.rules` (research R-21).

## Giới hạn loader

| Giới hạn | Mặc định |
|---|---|
| Kích thước mỗi file | 256 KiB |
| Số alias tối đa | 50 |
| Độ sâu `extends` của profile | 8 |

Giới hạn có thể đặt qua tham số của `validateConfig`, không qua file cấu hình được kiểm tra.
