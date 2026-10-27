# Contract: Tín hiệu, sự kiện và effect

Danh sách đóng. Mỗi union được xử lý bằng `switch` kết thúc bằng `assertNever` (SPEC.md §17.2). Thêm kind
mới là thay đổi `schema_version`.

## Tín hiệu

Mọi tín hiệu nằm trong `TriggerEnvelope` ([data-model](../data-model.md#tín-hiệu-triggerenvelope)).
Tín hiệu đánh dấu "người" bắt buộc có `authz` và `expected_version`.

| Kind | Payload chính | Nguồn | Ghi chú |
|---|---|---|---|
| `create_task` | `task: CanonicalTask` | người | Dedup theo `(project, source_key)` (FR-007) |
| `confirm_task` | — | người | Task cần xác nhận (SPEC.md §5.2) |
| `source_updated` | `task: CanonicalTask` | người/nguồn | Trước khi chạy: revision mới. Sau khi chạy: source drift (FR-011) |
| `dependency_status` | `depends_on`, `status` | kho/caller | Báo prerequisite đổi trạng thái |
| `start` | `freeze: Result<{policy, context}, FreezeError>` | caller | Kết quả `freeze` được ghi như dữ liệu (FR-037) |
| `effect_result` | `effect_id`, `attempt_id?`, `outcome`, `data` | executor giả | Xem [Kết quả effect](#kết-quả-effect) |
| `effect_reconciled` | `effect_id`, `finding`, `data?`, `failure_class?`, `signature?` | probe giả | Đối chiếu effect `unknown` hoặc `started`; xem [Kết quả đối chiếu](#kết-quả-đối-chiếu) |
| `timer` | `timer_id` | kho | Do `fireDueTimers` tạo, khoá `timer:<id>` |
| `answer` | `question_id`, `answer` | người | Câu hợp lệ đầu tiên thắng |
| `approve`, `reject` | `approval_request_id`, `head_sha?` | người | Merge cần `head_sha` |
| `drift_choice` | `choice: continue_old/apply_new/new_task`, `freeze?` | người | `apply_new` mang kết quả `freeze` của revision mới (FR-040) |
| `stop_attempt` | `attempt_id`, `reason` | người | Hủy ngay attempt, tách khỏi source drift (FR-011) |
| `cancel` | `reason` | người | FR-018 |
| `amend` | `policy: FrozenPolicy`, `diff`, `reason` | người (admin) | FR-036 |

`DecideInput` có thêm `related` do kho đọc trong cùng transaction:
`{ deps: Record<Uuid, TaskStatus | 'missing'>, dependency_cycle: boolean, retry_of?: TaskStatus | 'missing' }`.
Nhờ vậy `decide` kiểm tra dependency và retry mà vẫn thuần.
Với `drift_choice`, `deps` phải gồm cả dependency của revision đang chờ áp (`source_drift.task.depends_on`):
`apply_new` chạy lại Triage trên revision mới và bị từ chối `dependency_invalid` khi dependency không tồn
tại, tạo chu trình hoặc chưa DONE (FR-008, FR-040).

### Kết quả effect

| Effect | `data` khi `outcome = succeeded` | Khi `failed` |
|---|---|---|
| `start_agent` | `schema_checked`, `status: done/needs_input/needs_context/blocked`, `summary`, `questions?`, `usage` | `failure_class`, `signature?`, `usage`, `invoked: boolean` |
| `run_gates` | `results: { gate, passed, signature? }[]` | `failure_class` |
| `review` (start_agent role reviewer) | `schema_checked`, `verdict: approve/request_changes`, `findings`, `head_sha`, `usage` | như `start_agent` |
| `prepare` | `base_sha`, `worktree_ref`, `branch`, `setup: { ran, passed }` | `failure_class` |
| `publish` | `head_sha`, `base_relation` | `failure_class` |
| `rerun_ci` | `head_sha`, `rerun_checks: string[]` | `failure_class` |
| `create_pr` | `pr_ref`, `head_sha` | `failure_class` |
| `await_ci` | `head_sha`, `required_set`, `checks: { name, state, job?, log_excerpt? }[]`, `base_relation?` | `failure_class` |
| `merge` | `merged`, `merge_sha?` | `failure_class` |
| `stop_attempt` | `stopped: boolean` | `failure_class` |

`outcome = unknown` không có `data`; task chờ đối chiếu (FR-017). `invoked` cho biết agent đã thật sự
được gọi hay chưa, quyết định giữ chỗ chuyển thành đã dùng hay được trả (FR-022).

`failure_class` ∈ `rate_limit`, `infra`, `auth_config`, `timeout`, `invalid_output`, `refused`,
`quality`, `unknown` (FR-019). `rate_limit` có thể kèm `reset_at`.

Bằng chứng cho merge guard (FR-015, research R-10):

- `base_relation = { head_sha, base_ref, base_sha, head_contains_base: boolean }`. Chỉ có hiệu lực cho
  đúng `head_sha` đó.
- `required_set = { names: string[], source: 'branch_protection' | 'policy', complete: boolean }`. Tập
  kỳ vọng là hợp của `names` với `ci.required_checks` trong chính sách đóng băng.
- `checks[].state` ∈ `success`, `failure`, `pending`, `cancelled`, `skipped`, `unknown`. Tên trong tập
  kỳ vọng mà không có trong `checks` được tính là `missing`. Chỉ `success` là đạt.
- Với check `failure`, `job` và `log_excerpt` (đã lọc theo `log_digest`, có giới hạn kích thước) là đầu
  vào của bước `classify`. Lõi áp `ci.rules` trong chính sách đóng băng để phân loại thành
  `flaky_or_infra`, `autofix` hoặc `code`; executor không phân loại (nguyên tắc VI, research R-21). Không
  rule nào khớp thì task WAITING `human_input` với `detail.code = ci_unclassified`.

### Kết quả đối chiếu

| `finding` | Trường bắt buộc | Hệ quả |
|---|---|---|
| `executed_succeeded` | `data` hợp lệ theo schema thành công của loại effect (bảng trên) | Ghi bằng chứng, chuyển giữ chỗ thành đã dùng nếu là `start_agent`, đi tiếp workflow |
| `executed_failed` | `failure_class`; `signature` khi lớp là `quality` | Áp FR-019 như một kết quả `failed` |
| `not_executed` | — | Trả giữ chỗ; tạo lại effect cùng `idem_key` chỉ khi loại effect cho phép chạy lại an toàn |
| `still_unknown` | — | Giữ nguyên `unknown`, task tiếp tục chờ |

`executed_succeeded` thiếu trường bắt buộc tạo `ReconcileIncomplete` và effect giữ `unknown` (FR-017,
research R-17). Với `start_agent`, `data` phải là output đã kiểm tra schema, có `invoked` và usage có
nhãn; chỉ có exit code thì chưa đủ.

## Sự kiện

| Nhóm | Loại |
|---|---|
| Task | `TaskCreated`, `TaskRevised`, `TaskConfirmed`, `TaskReady`, `TaskPending`, `TaskWaiting`, `TaskResumed` |
| Chính sách | `PolicyFrozen` (gồm `policy_hash`, `context_hash`, `structure_hash`), `PolicyAmended`, `AmendmentRejected` |
| Bước | `StepEntered`, `StepSkipped`, `StepExhausted` |
| Attempt | `AttemptRequested`, `AttemptFinished`, `FailureClassified` |
| Ngân sách | `BudgetReserved`, `BudgetConsumed`, `BudgetReleased` |
| Escalation | `RungRaised`, `TaskFloorRaised` |
| Bằng chứng | `GateResultRecorded`, `ReviewVerdictRecorded`, `PublishRecorded`, `CiResultRecorded`, `BaseRelationRecorded`, `EvidenceInvalidated` |
| Effect | `EffectRequested`, `EffectStarted`, `EffectCompleted`, `EffectInvalidated`, `EffectReconciled`, `ReconcileIncomplete` |
| Timer | `TimerArmed`, `TimerCancelled`, `TimerFired` |
| Hỏi đáp | `QuestionAsked`, `QuestionAnswered`, `AnswerRejected`, `ApprovalRequested`, `ApprovalGranted`, `ApprovalRejected` |
| Revision | `SourceDriftDetected`, `SafeBoundaryReached`, `RevisionApplied` |
| Hủy | `CancelRequested`, `CancelRecordedLate` |
| Kết thúc | `TaskCompleted`, `TaskFailed`, `TaskCancelled` |
| Khác | `SignalIgnored` (`reason`: `terminal`, `stale_attempt`, `already_answered`, …) |

Luật:

- `EffectStarted` chỉ do `Store.claimEffect` tạo; mọi loại khác do `decide` tạo.
- `PolicyFrozen` chứa cả `FrozenPolicy` và `FrozenExecutionContext`; kho ghi hai bảng snapshot trong cùng
  transaction (FR-037).
- `CancelRequested` đi cùng `EffectInvalidated` cho mọi effect `pending` và `BudgetReleased` tương ứng, trong
  cùng một `Decision` (FR-018, FR-022).
- `RevisionApplied` đi cùng `PolicyFrozen` của revision mới, `EvidenceInvalidated` cho bằng chứng và
  approval của revision cũ, `EffectInvalidated` + `BudgetReleased` cho effect nghiệp vụ còn pending của
  revision cũ, và `StepEntered(triage)` (FR-040, FR-011).
- `drift_choice = new_task` cũng invalidate effect nghiệp vụ pending như trên, rồi phát
  `CancelRequested` cho task cũ (research R-16).
- Trong lúc source drift chưa có lựa chọn, `Store.claimEffect` từ chối effect nghiệp vụ bằng
  `claim_blocked: source_drift`; effect giữ `pending`.

## Effect

| Kind | `logical_id` trong `idem_key` | Ghi chú |
|---|---|---|
| `prepare` | `revision` | Snapshot, tạo worktree/branch, chạy setup theo hợp đồng retry của project |
| `start_agent` | attempt ID | Mang role, binding, rung, `reservation_id` |
| `stop_attempt` | attempt ID | Được phép khi đang hủy |
| `run_gates` | `step` + `visit` | Danh sách gate đã đóng băng |
| `rerun_ci` | `head_sha` + `visit` | Chạy lại check lỗi hạ tầng/flaky, giới hạn bởi `max_visits` của bước |
| `publish` | `revision` + checkpoint | Gộp checkpoint/commit/push ở mức quyết định |
| `create_pr` | `task_id` | Một PR mỗi task |
| `await_ci` | `head_sha` | Chờ required checks của đúng head |
| `merge` | `head_sha` | Chỉ khi merge guard đạt (R-10) |
| `reconcile` | effect ID gốc | Probe; được phép khi đang hủy |

## Mã từ chối của `decide`

`unknown_task`, `task_exists`, `invalid_trigger`, `id_pool_exhausted`, `not_admin`,
`workflow_change_forbidden`, `dependency_invalid`, `question_not_open`, `approval_mismatch`.

Mã từ chối của kho (`conflict`, `write_failed`, `store_locked`, …) nằm ở
[core-api.md](core-api.md#kho-trạng-thái-có-io-đồng-bộ).
