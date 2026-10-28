# Data model và chuyển trạng thái runtime

Các entity/event dưới đây là bổ sung dự kiến, chưa phải schema đã triển khai. Giữ bảy task status
của lõi 001; drain, slot và observation là dữ liệu/chi tiết chờ, không thêm task status.

## Snapshot và entity

| Entity | Trường chính | Quy tắc |
| --- | --- | --- |
| Task | TaskState hiện có + runtime_ref, execution_request, observation, completion, ingest | Không đổi input/revision/deadline do recheck hoặc remote push |
| FrozenRuntimeContext v1 | task_id, revision, base_sha, completion_mode=external_confirmation, network_mode=internet_outbound, limits, capability_refs, project_path, target identity, runtime_hash | Ghi cùng PolicyFrozen/context trước RUNNING; chỉ reference credential, không secret; không thay hash snapshot lịch sử |
| FrozenPolicy v1 | required_checks: string[] giữ nguyên | Không thêm app_id; giữ nguyên schema/hash lịch sử, app-pinned GitHub bị mismatch |
| WorktreeCheckpoint | task/revision, project realpath, common_git_dir, worktree path, branch, base_sha, tree_oid, parent_oid, diff_digest, owner_marker | Không nhận lại theo tên path đơn thuần; SHA/tree/ownership phải đối chiếu |
| ExecutionRequest | task_id, request_id, requested_at, request_global_seq, group=fresh/resumed, priority, resume_action, accumulated_wait_ms | Priority số lớn trước, default 0 theo SPEC §6.2; một yêu cầu đang chờ/task; grant/withdraw đóng đoạn chờ, không dùng created_at thay requested_at |
| ExecutionSlot | key=execution, holder_task_id, request_id, claimed_at, active_operation_ids | Singleton toàn daemon; một holder, có thể nhiều operation phục vụ dừng/đối chiếu cùng task |
| OperationReceipt | operation_id, effect_id, attempt_id hoặc null, revision, binding_hash, launch_nonce, supervisor/unit identity, process identities, started/finished_at, outcome, artifact refs | Agent/setup/gate/publish đều có receipt; một process identity không chỉ là PID |
| IngestCursor | operation_id, generation, segment, byte_offset, last_record_seq, acked_at | Chỉ nhảy sau record đầy đủ; thay đổi cùng transaction với event suy ra |
| Artifact | artifact_id, operation_id, kind, relative_path, digest, bytes, redaction_version, finalized, acked | Runtime root riêng; không tin path từ agent; không expose secret hoặc file chưa finalize |
| CapabilityManifest | binary realpath/version/digest, vendor, role schemas, isolation_mode=isolated, provider=bwrap, permission/auth/cost/resume support, native_result, selected_inner_mode, outer_proof_hash, permission_policy_hash, environment/settings/host-policy hashes, fixture refs, checked_at, manifest_hash | Help khác fixture thực nghiệm; external_verified chỉ thay lớp nội bộ sau native failure/outer/permission proof và owner cho phép theo ADR-0004; hash/version/layout đổi chặn trước attempt mới; AppArmor label/profile là dữ liệu host nếu có, không là prerequisite phổ quát |

`FrozenRuntimeContext` chứa tất cả trần nghiên cứu R-04/R-11; runtime capabilities là bằng chứng
môi trường, không quyền cho agent tự đổi model/permission. Project path và credential reference chỉ
đọc từ cấu hình người dùng đáng tin; cusr.yaml không khai báo các quyền này.

## Caller access grant

Token assistant tách token bootstrap owner: metadata id/actor/roles=[read,operate]/project allowlist/
token_file từ trusted user config, không snapshot secret vào task/event. Grant/revoke do owner sửa
config rồi restart daemon, scope kiểm server-side mỗi request; worker agent không thấy token nào.
Client/connector của assistant không có quyền đọc file owner admin; cùng-UID shell đọc được admin
file không được coi là caller bị giới hạn chỉ nhờ token operate. Xem CLI contract cho provisioning.

## Observation và required checks

| Cấu trúc | Trường / biến thể |
| --- | --- |
| ExternalSubject | provider, immutable_repo_id, subject_id (PR number/node ID), target_ref, head_ref |
| Observation | observation_id, source=timer/recheck/recovery/cancel, requested_at, observed_at, generation, subject, status=open/closed/merged/unknown, raw_evidence_ref, completeness |
| HeadEvidence | expected_published_head, observed_head, checked_head (nullable), revision, gate/review/CI evidence IDs và validity |
| CheckIdentity / snapshot | Tên check dạng string; GitHub source/app ID chỉ ở observation evidence, không trong FrozenPolicy |
| RequiredEvidence | kind=known/none/unknown, identities, classic/rules provenance, complete, observed_at, mismatch/mapping details |
| CheckResult | identity, head_sha, run/status ID, generation, state=success/failure/pending/cancelled/missing/unknown, timestamps, evidence_ref |
| ObservationBudget | started_at, deadline_at, count, max_count, next_due_at, cadence_index, generation, last_remote_digest, exhausted |
| CiBudget | head_sha, started_at, deadline_at, poll_count, exhausted; giữ bản ghi theo từng head |

`none` có evidence dương đầy đủ; `unknown` không được chuẩn hóa thành mảng rỗng. Core so quan hệ
subset theo tên và yêu cầu success của mọi check snapshot khi GitHub dùng any-app; App ID cụ thể
trả required_checks_mismatch, nguồn/tên mơ hồ không được gộp. Head remote do người ngoài đổi không thay expected/checked
head hoặc CiBudget cũ. Không dùng event đến muộn của generation/head cũ làm xanh head mới.

Trong một lượt quan sát, fact merge có thể đủ dù rules/CI không đọc được: merge proof và chứng nhận
chất lượng là hai phần completeness riêng. Thiếu merge proof thì không tạo completion fact.

## Completion và drain

`completion` là null hoặc:

| Trường | Ý nghĩa |
| --- | --- |
| proof | subject/repo/target_ref, merged_at, merged_head_sha, checked_head_sha nullable, merge_commit_sha, observation_id/evidence ref |
| unverified | merged_head_unverified + lý do head khác/chưa có head đã kiểm; giữ validity chứng cứ chất lượng riêng |
| recorded_at | Lúc commit fact; có thể muộn hơn merged_at |
| drain_started_at/deadline_at | Hạn riêng, không đổi bởi task/observation deadline |
| drain_count, max_auto_rounds, auto_exhausted | Giới hạn dừng/đối chiếu tự động |
| pending_operations | Các process/effect đã claim chưa chứng minh kết quả; giữ slot nếu thuộc slot |
| local_remainder | worktree/head/diff/commit/artifact refs chưa publish; tồn tại sau DONE nếu cần bảo toàn |
| finalized_at | Chỉ ghi cùng TaskCompleted sau predicate drain hoàn tất |

Predicate hoàn tất: merge proof hợp lệ đúng subject/target + mọi process thuộc task đã dừng + mọi
effect đã gửi có kết quả rõ. Pending effect chưa gửi đã invalidated; observation/control effect của
lần khác được hủy hoặc ingest đúng provenance. Failed nhưng rõ là kết quả hợp lệ cho drain; unknown
không đủ. Kết quả publish đến muộn chỉ cập nhật receipt, không gọi `proceed`.

## Trigger và event mới

Tên dưới đây là hợp đồng dự kiến; khi viết Zod giữ closed union/exhaustiveness. Event envelope giữ
schema_version=1; bổ sung event types additive, giữ nguyên payload các event hiện có như
EffectRequested/Completed, TimerArmed/Cancelled, TaskCompleted, QuestionAnswered.

| Trigger (application tạo fact) | Event / tác dụng thuần |
| --- | --- |
| start có runtime snapshot mới | RuntimeConfigured cùng PolicyFrozen trong một lần accept; chưa commit thì không RUNNING/dispatch |
| request_execution(action, now) | ExecutionQueued, hoặc cập nhật intent cùng request hiện tại; fresh giữ READY, resumed WAITING/execution_slot |
| grant_execution(queue snapshot, now) | ExecutionGranted sau kiểm tra holder/priority/facts trong transaction; resumed RUNNING, fresh mới chốt start/deadline |
| operation_started/operation_result | OperationRegistered/Observed, EffectStarted/Completed; budget reservation → used khi xác nhận thực chạy |
| release_execution(receipts) | ExecutionReleased sau chứng minh công việc thuộc slot kết thúc/rõ; chờ CI/human không giữ slot |
| observation_result(bundle) | ExternalStateObserved, EvidenceInvalidated/Recorded; chỉ tạo ExternalCompletionObserved nếu proof đầy đủ |
| external_completion(proof) | ExternalCompletionObserved + invalidation nghiệp vụ/timers + DrainStarted; không giả CancelRequested |
| drain_result(facts) | DrainProgressed; nếu predicate đạt: DrainFinished, ExecutionReleased nếu có, TaskCompleted đúng một lần |
| drain_deadline/round_limit | DrainPaused, WAITING/policy merge_cleanup_pending; không retry tự động |
| recheck(request) | RecheckRequested, một effect observe hoặc drain; dedup cùng command ledger, không sửa ngân sách |
| ingest_record(operation, cursor, normalized) | ArtifactIngested/OutputAccepted + cursor; commit chung, rồi ACK file |
| observation_due/deadline | ObservationScheduled/Expired; CI/deadline task giữ blocker riêng, không ghi đè drain |

Các fact I/O đều có observation time, provenance và digest; `now`/ID được tạo ngoài engine. Adapter
không chọn WAITING/DONE/retry/escalation. Runtime xử lý completion trước source-drift/deadline trong
`proceed/claimable`, vì stop/reconcile là thao tác phục vụ bắt buộc.

## State transitions quan trọng

| Tình huống | Kết quả |
| --- | --- |
| READY, slot chưa có | Chưa start, chưa deadline, chưa worktree |
| Có slot, freeze không đạt | PENDING/needs_info; trả reservation slot đã xác nhận chưa spawn; config_invalid/capability_missing |
| PENDING lỗi và confirm/recheck mới | Đọc base mới nhất bên ngoài transaction; triage/freeze lại; dedup trả kết quả lần trước nếu cùng request |
| CI fail và slot bận | WAITING/policy execution_slot, deadline tiếp tục chạy |
| PR xanh | WAITING/approval merge; nhả slot khi rõ process/effect, giữ worktree |
| Head ngoài dự kiến | WAITING/policy head_changed, thu hồi xanh, không nhận head mới |
| Hết hạn/thang/lượt | Giữ blocker, không thêm thực thi; observation vẫn chạy trong hạn riêng |
| Hết hạn quan sát | WAITING/policy observation_expired, hủy lịch, recheck hữu hạn |
| Merge proof đủ khi task chưa terminal | WAITING/policy merge_cleanup_pending cho tới drain xong; không giải phóng dependency sớm |
| Drain hoàn tất, kể cả chưa chứng nhận | DONE; giải phóng dependency qua event DONE, không thêm approval |
| Cancel khi merge đã xác nhận | Tiếp tục drain rồi DONE + dấu yêu cầu hủy đến quá muộn, không CANCELLED |
| Merge sau CANCELLED đã commit | Không mở terminal; chỉ lịch sử đối chiếu, không giải phóng dependency |

Wait gồm reason/detail hiện hành + `blockers[]` có provenance/hạn và `allowed_actions[]` dựng bởi
code. Merge cleanup ưu tiên hiển thị khi đã có proof; observation_expired không che mất task_deadline,
ci_wait_exhausted hoặc source drift trong explain. Bảng lối ra FR-029 vẫn là nguồn chuẩn.

## Projection, transaction và migration

- Migration `002_runtime.sql` thêm `runtime_contexts`, `execution_queue`, `execution_slot`,
  `operations`, `ingest_cursors`, `artifacts`, `external_observations`; phần đối chiếu/drain còn lại
  nằm trong TaskState và task JSON. Unique slot key, một active queue/task, unique operation/effect,
  unique cursor/segment sequence và proof/observation key ngăn trùng.
- Tất cả là projection từ event được commit, không để runner ghi SQLite. Mở rộng ProjectionSink/
  MemorySink và verification report cho mọi bảng mới. Slot replay theo global_seq; task seq vẫn liên
  tục riêng từng task. Không tạo một hệ event log thứ hai.
- Store lấy queue/facts và xác thực grant/claim trong cùng BEGIN IMMEDIATE với append/projection/
  outbox/timer. I/O fetch/freeze ngoài transaction; engine kiểm version/base candidate/task conditions
  lại trước commit, stale input trả conflict. Claim pending trước dispatch vẫn qua completion gate.
- FrozenPolicy/event envelope giữ version 1; replay khởi tạo runtime=null và fields mới xác định
  từ event types additive, không dual decoder/upcaster hoặc rewrite hash/payload/policy cũ. Migration
  DB dựng lại projection mới trong transaction, raw log giữ nguyên; database schema mới từ chối
  binary cũ. Fixture DB v1 kiểm migrate/replay; task thiếu runtime snapshot không auto-run và health
  chỉ rõ read-only legacy task. App ID không là lý do thêm version/migration.
- Startup: khóa writer → schema/integrity → verify tất cả projection → reconcile open operations/
  slot/timers → nhận output → cấp việc. Claim chưa rõ hoặc projection lệch thì chặn cấp việc.
- CLI mutation ledger mở rộng ledger dedup hiện có bằng canonical command hash trước I/O; giữ
  server-assigned IDs và kết quả lần đầu. Cursor ingest, Q&A và dependent notification cũng dedup;
  mất notification sau commit được startup quét dependency theo projection, không mất việc.

## Bằng chứng dữ liệu

Property test bao phủ selector, completion/drain precedence, no reopening, subset/check generation,
deadline/slot và approval/budget kế thừa. Integration test dùng SQLite file thật cho unique grant,
ingest atomicity, migration v1 và replay global order; crash tại từng commit boundary. Contract test
kiểm receipt của process/Git thật, missing artifact, partial record, ENOSPC và late result. Chi tiết
truy vết ở [acceptance map](contracts/acceptance-map.md).
