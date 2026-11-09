# Contract: Goal, kế hoạch và nhánh goal

## Kế hoạch (`PlanSchema`)

```json
{
  "schema_version": 1,
  "summary": "Thêm lệnh export báo cáo dạng CSV",
  "scope": ["src/application/report.ts", "src/cli/report.ts", "test/**/report*"],
  "non_goals": ["Không đổi định dạng JSON hiện có"],
  "units": [
    {
      "key": "model",
      "title": "Dựng bảng dữ liệu export",
      "description": "…",
      "instructions": "…",
      "acceptance": ["…"],
      "scope": ["src/application/report.ts", "test/unit/report.test.ts"],
      "depends_on": [],
      "run_config": { "mode": "full-review", "bindings": { "coder": "…", "reviewer": "…", "fixer": "…" } }
    }
  ]
}
```

- `key`: `^[a-z0-9][a-z0-9-]{0,31}$`, duy nhất trong kế hoạch, không đổi qua các version.
- `scope` của goal và của đơn vị: mục theo luật của `normalizeScopeEntry` (`src/application/scope-match.ts`), tối đa
  `SCOPE_ENTRIES_MAX`. Với từ hai đơn vị: mọi đơn vị MUST có `scope`, và mỗi mục của nó MUST nằm trong `scope` của goal.
- `depends_on`: khóa của đơn vị khác trong kế hoạch; DAG không vòng.
- `description`: đơn vị làm gì cho người dùng; đóng băng sau khi duyệt. `instructions`: cách làm; deputy sửa được.
- `run_config`: cùng schema với `task propose`; model trong `allow_models`.
- Hash: SHA-256 của JSON chuẩn hóa (khóa sắp xếp, không khoảng trắng), hex.

## Kiểm tra (`validatePlan`)

| Lỗi | Khi nào |
| --- | --- |
| `plan_invalid` (`duplicate_key`, `unknown_dependency`, `cycle`) | Khóa trùng, phụ thuộc không tồn tại, vòng |
| `plan_invalid` (`scope_missing`, `scope_outside_goal`) | Goal nhiều đơn vị thiếu scope, hay scope đơn vị ra ngoài scope goal |
| `plan_invalid` (`run_config`) | Run config sai schema, model ngoài `allow_models` |
| `plan_invalid` (`protected_goal_branch`) | Tên nhánh goal khớp `protected_branches` |
| `plan_invalid` (`no_required_checks`) | Goal nhiều đơn vị mà project không có required check (R-23) |

Engine trả kèm `parallel_groups`: mảng các tầng, mỗi tầng là các khóa chạy song song được.

## Phân loại sửa đổi (`classifyAmendment`)

| Khác biệt giữa hai kế hoạch | Loại |
| --- | --- |
| Thêm hay bỏ khóa đơn vị | phạm vi |
| `acceptance` của một đơn vị đổi | phạm vi |
| `scope` của goal rộng ra; `summary` hay `non_goals` đổi | phạm vi |
| `scope` của đơn vị đổi nhưng vẫn trong `scope` của goal | thực thi |
| `depends_on` đổi (DAG vẫn hợp lệ) | thực thi |
| `run_config` đổi (vẫn hợp lệ) | thực thi |
| `title` hay `description` của đơn vị đổi | phạm vi |
| `instructions` của đơn vị đổi | thực thi |
| Thay task FAILED của một khóa, khi task đó không FAILED vì loop guard hay chữ ký đã cạn | thực thi |
| Thay task FAILED của một khóa vì loop guard hay chữ ký đã cạn | phạm vi |

Một sửa đổi có bất kỳ khác biệt loại phạm vi nào là loại phạm vi. `affectedUnits` là các khóa có khác biệt cộng các đơn vị
phụ thuộc (bắc cầu) vào chúng.

## Lệnh

Mọi lệnh goal dùng envelope lệnh ghi của feature 002, có `expected_version` là version của goal.

| Lệnh | Payload chính | Quyền | Ghi chú |
| --- | --- | --- | --- |
| `goal add` | `{ project, request, hints? }` | `operate` | Trợ lý cần lease. Không có role `deputy` thì không mở lượt `plan`; goal chờ `goal propose` của trợ lý và tin "goal cần kế hoạch" tới phiên giữ lease |
| `goal revise <id>` | `{ request }` | `operate`, không cho deputy | FR-058, FR-077 |
| `goal note <id>` | `{ text }` | `operate` | Loại suy ra từ actor (FR-063) |
| `goal propose <id>` | `{ plan, plan_version }` | `operate` | Chỉ ở `planning`, `awaiting_confirm`; `plan_version` là version người gửi đã đọc |
| `goal amend <id>` | `{ plan, plan_version }` | `operate` | Ở `running`, `replan`; thực thi thì áp ngay, phạm vi thì `amendment_pending` |
| `goal confirm <id>` | `{ plan_hash }` | `operate`, không cho deputy | Duyệt kế hoạch hay bản sửa đang chờ; hash khác thì `conflict` kèm hash hiện hành |
| `goal cancel <id>` | `{}` | `operate`, không cho deputy | Hủy mọi task chưa kết thúc của goal |
| `goal show <id>` / `goal list` | | `read` | FR-073, FR-100 |

## Khi xác nhận

Trong một transaction:

1. `PlanConfirmed { plan_version, plan_hash, by }`.
2. Mỗi đơn vị: trigger `task_add` nội bộ với `goal: { id, unit_key, role: 'unit', depends_on_units }`, `base_branch` (nhánh
   goal hay nhánh gốc với goal một đơn vị), phụ thuộc theo khóa đơn vị (R-29), run config đã xác nhận theo digest của kế hoạch, `merge_method: 'merge'`
   khi nhắm nhánh goal. Task bỏ qua bước chờ xác nhận intake và run config.
3. Goal nhiều đơn vị: outbox effect `git.create_goal_branch { branch, base_sha }` và trigger `task_add` cho task tổng
   (`role: 'final'`, workflow `goal_final`, `depends_on` mọi đơn vị). Đơn vị chỉ dispatch khi `GoalBranchCreated` đã ghi
   (wait tự tiếp tục `dependency_pending` với `detail.goal_branch`).

## Nhánh goal

- Tên: `goal/<8 ký tự đầu của id>-<slug từ summary, tối đa 40 ký tự>`.
- Effect `git.create_goal_branch`: push `base_sha:refs/heads/<branch>`; probe bằng `ls-remote`: ref tồn tại và trỏ đúng
  `base_sha` là đã xong; trỏ chỗ khác là `effect_failed` (tới deputy).
- Merge PR đơn vị: theo yolo (`src/daemon/yolo.ts`) với điều kiện bật là "đơn vị của goal đã xác nhận, `base_branch` là
  nhánh goal của nó", approver `policy:goal`, method `merge`.
- Mỗi nhánh goal tối đa một effect merge đang bay. Trước khi gửi, daemon kiểm đỉnh nhánh goal bằng merge commit cuối nó đã
  ghi (hay `base_sha` lúc tạo); khác thì không gửi, goal vào `replan` với lý do `goal_branch_drift` (R-23).
- Task tổng: R-24.
