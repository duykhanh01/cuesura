---

description: "Task list for feature 001-deterministic-core"
---

# Tasks: Lõi điều phối tất định

**Input**: Design documents from `specs/001-deterministic-core/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Bắt buộc. Spec yêu cầu bằng chứng kiểm thử cho từng bất biến (FR-035, SC-003–SC-008) và hiến
chương nguyên tắc VII quy định tầng bằng chứng. Trong mỗi story, test được viết trước và phải fail trước
khi triển khai.

**Organization**: Task nhóm theo user story. Mã tham chiếu R-xx trỏ tới [research.md](research.md).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: chạy song song được (file khác nhau, không phụ thuộc task chưa xong)
- **[Story]**: user story tương ứng (US1–US5)
- Mọi đường dẫn tính từ gốc repo

## Path Conventions

Một package ở gốc repo: `src/`, `test/`, `scripts/` (plan.md, "Project Structure"). Mọi lệnh chạy trong
WSL2/Ubuntu với Node 24 (R-15).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Khởi tạo package, toolchain và bộ khung thư mục.

- [X] T001 Tạo `package.json` ở gốc repo: `"type": "module"`, `engines.node` pin đúng bản patch Node 24 LTS, `packageManager` pin pnpm, scripts `typecheck` (`tsc --noEmit -p tsconfig.json`), `lint` (`eslint .`), `test` (`vitest run --project default`), `test:reliability` (`vitest run --project reliability`), `build` (`tsc -p tsconfig.build.json`), `report:invariants` (`node scripts/report-invariants.ts`); tạo `.nvmrc` cùng bản Node
- [X] T002 Cài dependency với phiên bản chính xác theo R-02 (`zod` 4, `yaml` 2, `better-sqlite3` 13, `uuid` 14; dev: `typescript`, `vitest` 5, `fast-check` 4, `eslint`, `typescript-eslint`, `prettier`, `@types/better-sqlite3`, `@types/node`), commit `pnpm-lock.yaml`, và ghi bản patch đã cài vào mục R-02 của `specs/001-deterministic-core/research.md`
- [X] T003 [P] Tạo `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`, `noEmitOnError`, `module`/`moduleResolution` `NodeNext`, `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` để `node scripts/report-invariants.ts` chạy bằng type stripping của Node 24 với import tương đối có đuôi `.ts`, gồm `src`, `test`, `scripts`) và `tsconfig.build.json` (chỉ `src`, `outDir: dist`, ESM)
- [X] T004 [P] Tạo `eslint.config.js` (typescript-eslint type-checked, `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`) với ranh giới module của R-12: trong `src/engine/**`, `src/domain/**`, `src/policy/**`, `src/explain/**` cấm import `node:*`, `better-sqlite3`, `yaml`, `uuid`, `src/store/**`, `src/config/**`, cấm global `Date`, `performance`, `process`, `setTimeout` và `Math.random`; chỉ `src/shared/hash.ts` được import `node:crypto`; `src/store/**` không import `src/config/**`; cấm import `src/store/testing.ts` từ `src/**` ngoài `src/store`; kèm `.prettierrc.json`
- [X] T005 [P] Tạo `vitest.config.ts` với hai project: `default` (`test/unit`, `test/scenarios`, `test/property`, `test/integration`) và `reliability` (`test/reliability`), reporter JSON ghi `reports/vitest-<project>.json`; thêm `reports/` vào `.gitignore`
- [X] T006 Tạo khung thư mục theo plan.md (`src/{shared,domain,config,policy,engine,store,explain}`, `test/{unit,scenarios,property,integration,reliability,fixtures,support}`, `scripts/`) và `src/index.ts` rỗng; chạy `pnpm typecheck`, `pnpm lint`, `pnpm build` trong WSL2 và xác nhận cả ba thoát 0

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Kiểu nền, schema miền, workflow dựng sẵn và builder kiểm thử mà mọi story dùng.

**⚠️ CRITICAL**: Không bắt đầu story nào trước khi phase này xong.

- [X] T007 [P] Tạo `src/shared/assert-never.ts` (`assertNever(value: never): never`) và `src/shared/result.ts` (`Result<T, E>` cùng helper `ok`/`err`) theo contracts/core-api.md "Kiểu nền"
- [X] T008 [P] Tạo `src/shared/brand.ts`: brand `Uuid`, `EpochMs` (số nguyên ms), `Hash` dạng `` `sha256:${string}` `` kèm parser Zod
- [X] T009 [P] Tạo `src/shared/canonical-json.ts` theo R-03 ("key sắp theo code point, không khoảng trắng, số theo `JSON.stringify` của ECMAScript, bỏ khoá có giá trị `undefined`, mảng giữ thứ tự"; từ chối `NaN`, `Infinity`, `bigint`, object có prototype khác `Object`) và test `test/unit/shared/canonical-json.test.ts`
- [X] T010 [P] Tạo `src/shared/hash.ts`: `hashCanonical(value) → Hash` bằng SHA-256 của JSON chuẩn hoá, file duy nhất import `node:crypto`; test `test/unit/shared/hash.test.ts` (hai object khác thứ tự key cho cùng hash)
- [X] T011 [P] Tạo `src/shared/duration.ts`: đổi `45s`, `10m`, `6h` sang ms, từ chối đơn vị lạ và số âm; test `test/unit/shared/duration.test.ts`
- [X] T012 Tạo `src/domain/workflow.ts`: schema Zod của graph workflow với loại bước `triage`, `prepare`, `agent`, `gate`, `review`, `action`, `wait`, `classify`, `approval`, `complete` (R-11), tập outcome đóng theo từng loại, `max_visits`, `on_exhausted`, `skip_when`, `when`, và predicate chỉ thuộc `flag`, `size`, `label`, `task_type`, `attempt_gte`, `target_branch`
- [X] T013 Tạo `src/engine/workflows/software-dev.ts`: dữ liệu dựng sẵn `software_dev@1` (Triage → Prepare → Scout tuỳ chọn → Code → Gates → Review → Publish → CI → Merge → Complete, cùng vòng `fix_gates`, `fix_review`, `ci_triage`, `rerun_ci`, `ci_autofix`, `ci_fix` theo docs/architecture.md §5.2; Prepare phát effect `prepare`, `rerun_ci` phát effect `rerun_ci`, `ci_triage` là bước `classify` không phát effect), được kiểm bằng schema của T012 khi load module (phụ thuộc T012)
- [X] T014 [P] Tạo `src/domain/task.ts`: schema `CanonicalTask` gồm `schema_version`, `id`, `title`, `type`, `project`, `base_branch`, `description`, `requirements`, `acceptance`, `constraints`, `out_of_scope`, `attachments` (`{ name, media_type, content_ref }`), `group`, `parent`, `depends_on`, `priority`, `size`, `labels`, `profile`, `requested_by`, `revision`, `source_key`, `retry_of`
- [X] T015 [P] Tạo `src/domain/policy.ts`: schema `FrozenPolicy` theo data-model.md (gồm `steps[step].ladder` là "Danh sách nấc `{ binding, level: (tier, effort_rank), state: auto/needs_approval/denied }`", `steps[step].floor_map`, `ci.required_checks`, `ci.rules`, `limits` (gồm `backoff.{rate_limit,infra}` = `{ base_ms, factor, max_ms, max_attempts }`), `decision_modes`, `config_hashes`, `structure_hash`, `policy_hash`, `policy_version`), `FrozenExecutionContext` (`attachments[]` là `{ name, media_type, content, content_hash }`, `context_hash`) và `AuthzContext` (`{ actor, roles: ('read' | 'operate' | 'admin')[], issued_by, issued_at }`)
- [X] T016 [P] Tạo `src/domain/trigger.ts`: `TriggerEnvelope` (`schema_version`, `task_id`, `dedup_key`, `request_hash`, `expected_version`, `trigger`, `now`, `ids` tối đa 8 phần tử, `authz`), union 15 kind tín hiệu (`create_task`, `confirm_task`, `source_updated`, `dependency_status`, `start`, `effect_result`, `effect_reconciled`, `timer`, `answer`, `approve`, `reject`, `drift_choice`, `stop_attempt`, `cancel`, `amend`), schema `data` theo từng loại effect (gồm `base_relation`, `required_set`, `checks[]` có `job?`, `log_excerpt?` và `state` ∈ `success`, `failure`, `pending`, `cancelled`, `skipped`, `unknown`), `effect_reconciled` với `finding` ∈ `executed_succeeded`, `executed_failed`, `not_executed`, `still_unknown`, và `RelatedFacts` theo contracts/signals-events.md
- [X] T017 [P] Tạo `src/domain/event.ts`: union `DomainEvent` gồm mọi loại ở contracts/signals-events.md "Sự kiện" (kể cả `BaseRelationRecorded`, `ReconcileIncomplete`, `SignalIgnored`) và kiểu `DomainEventDraft` chưa có `seq`/`global_seq`
- [X] T018 [P] Tạo `src/domain/effect.ts`: 10 kind effect (`prepare`, `start_agent`, `stop_attempt`, `run_gates`, `publish`, `create_pr`, `await_ci`, `rerun_ci`, `merge`, `reconcile`), status ∈ `pending`, `started`, `succeeded`, `failed`, `unknown`, `invalidated`, phân loại nghiệp vụ (`prepare`, `start_agent`, `run_gates`, `publish`, `create_pr`, `await_ci`, `rerun_ci`, `merge`) và phục vụ (`stop_attempt`, `reconcile`) theo R-16, và `idemKey()` dựng `<kind>:<project>:<task_id>:r<revision>:<logical_id>` với `logical_id` theo bảng "Effect" của contracts/signals-events.md
- [X] T019 [P] Tạo `src/domain/state.ts`: `TaskState` theo bảng "Task (projection `TaskState`)" của data-model.md, `TaskStatus`, `WaitReason` đúng tập SPEC.md §6.1, `detail.code` theo bảng R-13, `wait` là `{ reason, detail, resume_when, exit_paths }`
- [X] T020 Tạo `src/domain/index.ts` và test `test/unit/domain/schemas.test.ts`: mỗi schema round-trip qua JSON chuẩn hoá; một hàm `switch` mẫu trên union trigger/event/effect kết thúc bằng `assertNever` để typecheck bắt kind thiếu
- [X] T021 Tạo `test/support/builders.ts`: builder cho `CanonicalTask`, `FrozenPolicy` (dựa trên `software_dev@1`, chỉnh được thang, giới hạn, required checks), `FrozenExecutionContext`, `TriggerEnvelope` (`now`/`ids` tất định theo seed) và `AuthzContext`, để US2–US5 chạy mà không cần loader của US1
- [X] T022 Tạo `test/invariants.map.ts`: ánh xạ I01–I12 → `{ scope, suites: string[] }` theo bảng "Bằng chứng theo bất biến" của spec; I05 là `{ scope: 'out_of_scope' }`; `suites` để rỗng, các story điền sau

**Checkpoint**: Nền tảng xong; US1 và US2 bắt đầu được song song.

---

## Phase 3: User Story 1 - Kiểm tra cấu hình và chốt chính sách (Priority: P1) 🎯 MVP

**Goal**: Đọc và kiểm tra cấu hình người dùng + `cusr.yaml`, trả lỗi có `file:dòng:cột`, và chốt
`FrozenPolicy` + `FrozenExecutionContext` có hash.

**Independent Test**: Chạy fixture hợp lệ và không hợp lệ qua `validateConfig`/`freeze`; so lỗi với lỗi
mong đợi và so hash của các cấu hình tương đương (`pnpm test test/scenarios/us1-config.test.ts`).

### Tests for User Story 1 ⚠️

> Viết trước, xác nhận fail trước khi triển khai.

- [X] T023 [P] [US1] Tạo fixture hợp lệ trong `test/fixtures/configs/valid/` (cấu hình người dùng, `cusr.yaml`, cặp cấu hình chỉ khác thứ tự key/định dạng, cấu hình có workflow `human` và workflow `agent`, file 500 dòng `large-500.yaml`) và pack mẫu `test/fixtures/packs/node.yaml`
- [X] T024 [P] [US1] Tạo fixture không hợp lệ trong `test/fixtures/configs/invalid/`: ít nhất một file cho mỗi mã ở contracts/config.md "Mã chẩn đoán"; dòng comment đầu mỗi file liệt kê `code line col` mong đợi
- [X] T025 [P] [US1] Viết `test/unit/config/loader.test.ts`: `yaml_syntax`, `duplicate_key`, `unsupported_tag`, `alias_limit` (vượt 50), `file_too_large` (vượt 256 KiB) với vị trí chính xác; chốt hành vi thực tế của `yaml` 2 mà R-05 ghi "Cần kiểm chứng"
- [X] T026 [P] [US1] Viết `test/unit/config/invalid-fixtures.test.ts`: duyệt mọi fixture invalid, so khớp chính xác `code`, `line`, `col` với comment đầu file (SC-001)
- [X] T027 [P] [US1] Viết `test/unit/config/merge.test.ts`: `forbidden_key` cho mọi khoá chỉ thuộc cấu hình người dùng khi xuất hiện trong `cusr.yaml` (kể cả `yolo`, `permissions`), thứ tự pack trong `extends`, map hợp nhất theo khoá còn mảng bị thay thế, `profile_cycle`, `override_not_allowed`, `override_exceeds_caller`
- [X] T028 [P] [US1] Viết `test/unit/config/checks.test.ts`: mỗi kiểm tra trong sáu kiểm tra của FR-003 có một ca đạt và một ca lỗi đúng mã
- [X] T029 [P] [US1] Viết `test/unit/policy/freeze.test.ts`: cấu hình tương đương cho cùng `policy_hash`; policy và context cùng `task_id`/`revision`/`base_sha`; `content_hash` của attachment; `floor_map` với hai thang khác độ dài và khác binding (R-18); `unsupported_workflow` qua `structure_hash`; `unsupported_decision_mode`; `no_valid_binding` khi allowlist loại hết rule; gate optional bị bỏ được ghi; một trong hai snapshot không chốt được thì `freeze` không trả snapshot nào (FR-038)
- [X] T030 [P] [US1] Viết `test/unit/policy/amendment.test.ts`: `not_admin` khi chỉ có tên actor hoặc chỉ có quyền `operate`; `workflow_change_forbidden`; `policy_version` tăng 1; đầu vào giữ nguyên khi bị từ chối
- [X] T031 [US1] Viết `test/scenarios/us1-config.test.ts`: 11 acceptance scenario của US1, đánh số đúng như spec (scenario 6 kiểm ở mức `proposeAmendment`; phần "không có sự kiện" được kiểm ở T050)
- [X] T032 [P] [US1] Viết `test/unit/config/perf.test.ts`: trung vị 20 lần `validateConfig` trên `large-500.yaml` dưới 1 giây (SC-002)

### Implementation for User Story 1

- [X] T033 [P] [US1] Triển khai `src/config/yaml-loader.ts` theo R-05: kiểm kích thước byte trước khi parse, `parseDocument` với `schema: 'core'`, `uniqueKeys: true`, `maxAliasCount`, không `customTags`, `LineCounter`; mọi `doc.errors` và `doc.warnings` là lỗi chặn
- [X] T034 [P] [US1] Triển khai `src/config/positions.ts`: ánh xạ đường dẫn issue Zod → node qua `doc.getIn(path, true)` → `LineCounter.linePos`, fallback node cha gần nhất; kiểu `Diagnostic` theo contracts/config.md, sắp theo `(file, line, col)`
- [X] T035 [US1] Triển khai `src/config/schema-user.ts` và `src/config/schema-project.ts` (Zod 4) theo bảng "Thẩm quyền theo file" của contracts/config.md, gồm `ci.required_checks` và `ci_rules` (`log_pattern` tối đa 256 ký tự, regex phải biên dịch được) trong schema project, `limits.backoff` trong profile với mặc định của contracts/config.md "Backoff", và `forbidden_key` cho khoá không thuộc thẩm quyền
- [X] T036 [US1] Triển khai `src/config/merge.ts`: bốn bước của contracts/config.md "Thứ tự hợp nhất", giữ bản đồ nguồn khoá → file + vị trí (phụ thuộc T035)
- [X] T037 [US1] Triển khai `src/config/normalize.ts`: điền mặc định và đổi thời lượng sang ms bằng `src/shared/duration.ts` trước khi hash (phụ thuộc T036)
- [X] T038 [US1] Triển khai `src/config/checks.ts`: sáu kiểm tra của FR-003 với các mã ở contracts/config.md, lỗi chỉ về file đã khai báo nhờ bản đồ nguồn (phụ thuộc T036)
- [X] T039 [US1] Triển khai `src/config/capabilities.ts` theo R-20: danh sách `unsupported` (`decision_mode_unsupported`, `unsupported_workflow`) không làm cấu hình lỗi; `decision_mode_forbidden` là lỗi cho các loại quyết định ở FR-006
- [X] T040 [US1] Triển khai `src/config/validate.ts`: `validateConfig` trả `{ config, unsupported }` hoặc `Diagnostic[]`, nhận `limits` (mặc định 256 KiB mỗi file, 50 alias, độ sâu `extends` profile 8), trả đủ lỗi tìm được trừ lỗi cú pháp/kích thước (phụ thuộc T033–T039)
- [X] T041 [P] [US1] Triển khai `src/config/read-files.ts`: `readConfigFiles` là shell I/O duy nhất của config, trả `ConfigSource[]`
- [X] T042 [P] [US1] Triển khai `src/policy/structure-hash.ts`: hash tập bước, loại bước và cạnh transition, bỏ qua tham số; test hằng số cho `software_dev@1` trong `test/unit/policy/structure-hash.test.ts`
- [X] T043 [US1] Triển khai `src/policy/binding.ts`: chọn rule đầu tiên khớp, rule bị `allow_models` loại thì thử rule kế, hết rule thì `no_valid_binding`
- [X] T044 [US1] Triển khai `src/policy/ladder.ts`: mức năng lực `(tier, effort_rank)` cho mỗi nấc, trạng thái nấc từ `auto_up_to_tier`/`above`, và `floor_map[step]` theo R-18 ("nấc nhỏ nhất trên thang của step có mức ≥ mức đó; không có thì là nấc cuối của thang")
- [X] T045 [US1] Triển khai `src/policy/freeze.ts`: `freeze()` trả `FrozenPolicy` + `FrozenExecutionContext` có hash hoặc `FreezeError` theo contracts/core-api.md; chỉ xét workflow và chế độ quyết định mà task dùng (phụ thuộc T040, T042–T044)
- [X] T046 [US1] Triển khai `src/policy/amendment.ts`: `proposeAmendment` đòi `AuthzContext` có `admin`, cấm đổi graph workflow, tăng `policy_version`, tính lại `policy_hash`
- [X] T047 [US1] Export `readConfigFiles`, `validateConfig`, `freeze`, `proposeAmendment` từ `src/index.ts`; điền suite của US1 cho I08 trong `test/invariants.map.ts`

**Checkpoint**: US1 chạy độc lập: `pnpm test test/scenarios/us1-config.test.ts` và `test/unit/config` xanh.

---

## Phase 4: User Story 2 - Tạo task chuẩn và quyết định bước tiếp theo tất định (Priority: P1)

**Goal**: `decide`/`evolve` thuần đưa task qua workflow `software_dev@1`, xử lý hỏi đáp, hủy, source drift,
revision mới, điều kiện claim và merge guard.

**Independent Test**: Phát lại chuỗi tín hiệu ghi sẵn qua harness in-memory; so sự kiện và trạng thái cuối,
phát lại lần hai cho kết quả giống hệt (`pnpm test test/scenarios/us2-decide.test.ts`).

### Tests for User Story 2 ⚠️

- [X] T048 [US2] Tạo `test/support/scenario.ts`: harness `given(events).when(envelope).then(...)` chạy `decide` + `evolve` trong bộ nhớ, tự phát lại hai lần và so JSON chuẩn hoá; helper executor giả tạo phong bì `effect_result`, `effect_reconciled`, `timer`; helper `claim(effectId)` gọi `claimable` rồi áp `EffectStarted` qua `evolve`, trả `claim_blocked` như `Store.claimEffect`
- [X] T049 [P] [US2] Tạo `test/property/arbitraries/signals.ts` và `test/property/arbitraries/policies.ts`: generator fast-check cho chuỗi tín hiệu (gồm tín hiệu trùng, attempt ID cũ, hủy, source drift, kết quả `unknown`, required checks thiếu) và chính sách với giới hạn, thang khác nhau
- [X] T050 [US2] Viết `test/scenarios/us2-decide.test.ts`: 14 acceptance scenario của US2 đánh số như spec, cộng các ca: `amend` thiếu `admin` bị từ chối `not_admin` mà không phát sự kiện nào (US1 scenario 6); `start` mang lỗi `freeze` không phát `PolicyFrozen` (FR-038); timer `deadline` đến hạn khi task đang chờ người chuyển WAITING `policy` `deadline` (FR-023)
- [X] T051 [P] [US2] Viết `test/property/invariants/determinism.test.ts` (I01): cùng input cho cùng `Decision`; `decide` không đọc gì ngoài input
- [X] T052 [P] [US2] Viết `test/property/invariants/transitions.test.ts` (FR-009, I12): chỉ có cạnh hợp lệ của data-model.md "Chuyển trạng thái"; DONE/FAILED/CANCELLED là trạng thái hút; mọi trạng thái chờ có `resume_when` và `exit_paths` (SC-006)
- [X] T053 [P] [US2] Viết `test/property/invariants/evidence.test.ts` (I06, FR-014): không qua bước khi thiếu `schema_checked`, sai attempt hiện hành hoặc gate bắt buộc chưa đạt
- [X] T054 [P] [US2] Viết `test/property/invariants/bounds.test.ts` (I07): `step_visits` ≤ `max_visits`; `used + reserved` ≤ `limit`; không `decide` nào dùng quá 8 ID; sau khi timer `deadline` đã đến hạn không có `AttemptRequested` nào
- [X] T055 [P] [US2] Viết `test/property/invariants/merge-guard.test.ts` (I11, FR-015): không `EffectRequested(merge)` khi thiếu approval gắn head, review approve, required check thành công của tập kỳ vọng, `required_set.complete`, hoặc `head_contains_base`
- [X] T056 [P] [US2] Viết `test/property/invariants/claim.test.ts` (R-16): `claimable` chặn mọi effect nghiệp vụ khi revision cũ, source drift chưa có lựa chọn, đang hủy, đã kết thúc hoặc đang chờ việc khác; không bao giờ chặn `stop_attempt`/`reconcile`
- [X] T057 [P] [US2] Viết `test/property/invariants/idempotency.test.ts` (I04 mức quyết định): không có hai `EffectRequested` cùng `idem_key`; thử lại cùng thao tác giữ khoá, attempt mới có khoá mới
- [X] T058 [P] [US2] Viết `test/property/invariants/revision.test.ts` (I08 mức quyết định): sau `RevisionApplied`, không bằng chứng hay approval của revision cũ được dùng; ngân sách đã dùng, nấc và `deadline_at` không đổi; effect nghiệp vụ pending của revision cũ bị vô hiệu hoá

- [X] T059 [P] [US2] Viết `test/unit/engine/classify.test.ts` (R-21): rule đầu tiên khớp theo `job`, `check`, `log_pattern`; nhiều lớp thì chọn `code` > `autofix` > `flaky_or_infra`; check không khớp rule nào → WAITING `human_input` `ci_unclassified`; chỉ xét check `failure` của head hiện hành

### Implementation for User Story 2

- [X] T060 [US2] Triển khai `src/engine/ids.ts`: lấy ID theo thứ tự từ `envelope.ids`, hết thì trả `rejected: id_pool_exhausted` (R-04)
- [X] T061 [US2] Triển khai `src/engine/evolve.ts`: áp từng loại sự kiện lên `TaskState` bằng `switch` + `assertNever`, tăng `version`, ném lỗi lập trình với cạnh chuyển trạng thái không hợp lệ
- [X] T062 [P] [US2] Triển khai `src/engine/intake.ts`: `create_task` (dedup theo `(project, source_key)`), `confirm_task`, `source_updated` trước khi chạy → `TaskRevised`
- [X] T063 [P] [US2] Triển khai `src/engine/triage.ts`: "`acceptance` có ít nhất một phần tử trước READY", dependency từ `related.deps` (missing, tự tham chiếu, `dependency_cycle` → `dependency_invalid`), xác nhận, `dependency_status`, kiểm tra `retry_of` là task đã kết thúc
- [X] T064 [US2] Triển khai `src/engine/start.ts`: tín hiệu `start` mang lỗi `freeze` → `TaskPending` với `wait_reason: needs_info` và `detail.code` theo R-13; thành công → một `PolicyFrozen` chứa cả policy và context, đặt `deadline_at` lần đầu kèm `TimerArmed(kind: deadline)` không đổi khi đổi revision (R-22)
- [X] T065 [P] [US2] Triển khai `src/engine/effects.ts`: dựng `EffectRequested` với `idemKey()`, bỏ qua khi khoá đã có trong state
- [X] T066 [P] [US2] Triển khai `src/engine/budget.ts` theo data-model.md "Ngân sách": giữ chỗ trước `start_agent`, `held → consumed` khi `invoked`, `held → released` khi effect bị vô hiệu hoá hoặc `not_executed`, giữ nguyên khi `unknown`; "Khả dụng = `limit − used − reserved`"
- [X] T067 [US2] Triển khai `src/engine/interpreter.ts`: diễn giải từng loại bước của `software_dev@1`, chuyển bước theo outcome, áp FR-014, `SignalIgnored(stale_attempt)` cho attempt cũ, `StepExhausted` theo `on_exhausted` (phụ thuộc T065, T066)
- [X] T068 [P] [US2] Triển khai `src/engine/questions.ts`: `needs_input` → `QuestionAsked` + WAITING `human_input`; câu trả lời hợp lệ đầu tiên thắng, câu sau `AnswerRejected`; `approve`/`reject` kiểm khớp approval theo data-model.md
- [X] T069 [P] [US2] Triển khai `src/engine/merge-guard.ts` theo R-10: tập kỳ vọng = hợp `ci.required_checks` và `required_set.names`; thiếu/`complete = false` → WAITING `ci` `checks_incomplete` kèm timer; head chưa chứa base → WAITING `human_input` `base_outdated`
- [X] T070 [P] [US2] Triển khai `src/engine/cancel.ts` theo FR-018: `CancelRequested` + `EffectInvalidated` + `BudgetReleased` cho effect pending trong cùng `Decision`; chỉ cho `stop_attempt`/`reconcile`; CANCELLED khi hết effect `started`/`unknown`; DONE + `CancelRecordedLate` nếu merge đã thành công
- [X] T071 [P] [US2] Triển khai `src/engine/revision.ts`: `SourceDriftDetected`, `SafeBoundaryReached`, `drift_choice` (`continue_old`, `apply_new` theo FR-040 cùng invalidate effect cũ, `new_task` invalidate rồi `CancelRequested`) theo R-16
- [X] T072 [P] [US2] Triển khai `src/engine/claim.ts`: hàm thuần `claimable(state, effect)` với các `reason` của R-16
- [X] T073 [P] [US2] Triển khai `src/engine/reconcile.ts` theo R-17: `executed_succeeded` phải có `data` hợp lệ, không thì `ReconcileIncomplete` và giữ `unknown`; `executed_failed` phải có `failure_class`; `not_executed` trả giữ chỗ
- [X] T074 [P] [US2] Triển khai `src/engine/classify.ts` theo R-21: áp `FrozenPolicy.ci.rules` cho các check thất bại trong `CiResultRecorded`, trả outcome `flaky_or_infra`/`autofix`/`code` cho bước `ci_triage` hoặc WAITING `human_input` `ci_unclassified`
- [X] T075 [US2] Triển khai `src/engine/decide.ts`: định tuyến theo kind tín hiệu bằng `switch` + `assertNever`, task kết thúc → `SignalIgnored(terminal)`, `amend` thiếu `admin` → `not_admin`, mã từ chối theo contracts/signals-events.md (phụ thuộc T060–T074)
- [X] T076 [US2] Export `decide`, `evolve`, `claimable` từ `src/index.ts`; điền suite US2 cho I01, I04, I06, I07, I08, I10, I11, I12 trong `test/invariants.map.ts`

**Checkpoint**: US2 chạy độc lập với builder của Phase 2, không cần US1.

---

## Phase 5: User Story 3 - Ghi nhận tín hiệu bền và đúng một lần (Priority: P2)

**Goal**: Kho SQLite một bên ghi, chấp nhận tín hiệu nguyên tử, dedup, claim, timer, đối chiếu projection.

**Independent Test**: Chạy chuỗi tín hiệu có trùng lặp và ngắt tiến trình trên file SQLite thật; kiểm tra
không ghi một nửa, không sự kiện trùng, projection dựng lại khớp (`pnpm test test/integration/store`).

**Phụ thuộc**: cần `decide`/`evolve` của US2.

### Tests for User Story 3 ⚠️

- [ ] T077 [US3] Tạo `test/support/temp-db.ts` (thư mục tạm trên filesystem Linux, dọn sau test) và `test/support/crash-child.ts` (tiến trình con mở kho với `CUSR_CRASH_AT` và seed, áp danh sách phong bì từ file JSON)
- [ ] T078 [P] [US3] Viết `test/integration/store/accept.test.ts`: chấp nhận nguyên tử; trùng khoá trả kết quả lần đầu (FR-026); `request_hash` gồm `task_id`, `expected_version`, `actor` mà không gồm `now`/`ids` (R-19); `stale_version` → `conflict`; `Decision.rejected` được lưu mà không append sự kiện; `seq`/`global_seq` theo đúng thứ tự `accept`, không phụ thuộc thứ tự ID hay `now` của phong bì (FR-027)
- [ ] T079 [P] [US3] Viết `test/integration/store/projection.test.ts`: `verifyProjections` khớp sau nhật ký nhiều task; phát hiện dòng projection bị sửa tay
- [ ] T080 [P] [US3] Viết `test/integration/store/effects.test.ts`: unique `idem_key`; claim `pending → started`; `effect_invalidated`; `claim_blocked` với từng `reason` (US2 scenario 13 ở mức kho); `stop_attempt`/`reconcile` không bị chặn
- [ ] T081 [P] [US3] Viết `test/integration/store/timers.test.ts`: `fireDueTimers` tạo đúng một tín hiệu logic; chạy lại sau crash ở `after_commit` không tạo tín hiệu thứ hai; gọi với `now` lùi so với lần trước không làm timer nào đến hạn sớm và không lỗi
- [ ] T082 [P] [US3] Viết `test/integration/store/single-writer.test.ts`: tiến trình thứ hai nhận `store_locked`; khoá được nhả sau khi tiến trình đầu bị `SIGKILL` (R-06)
- [ ] T083 [P] [US3] Viết `test/integration/store/write-failure.test.ts`: ép `SQLITE_FULL` bằng `PRAGMA max_page_count` và ép busy → `write_failed`, trạng thái không đổi (FR-033)
- [ ] T084 [P] [US3] Viết `test/integration/crash/crash-points.test.ts`: ngắt một lần ở mỗi điểm `after_dedup`, `after_events`, `after_projection`, `after_effects`, `after_timers`, `before_commit`, `after_commit`; sau đó `integrity_check = ok`, hoặc đủ hoặc không có gì, `verifyProjections` khớp
- [ ] T085 [US3] Viết `test/integration/store/us3-scenarios.test.ts`: 8 acceptance scenario của US3 đánh số như spec (scenario 7 phục hồi publish, create PR, start agent với dữ liệu đối chiếu đủ và thiếu)

### Implementation for User Story 3

- [ ] T086 [US3] Viết `src/store/migrations/001_init.sql` theo bảng "Lưu trữ SQLite" của data-model.md, giữ nguyên ràng buộc: `UNIQUE(task_id, seq)`, `UNIQUE(idem_key)`, `UNIQUE(project, source_key)`, `PRIMARY KEY(task_id, revision, policy_version)`, `PRIMARY KEY(task_id, revision)`, `CHECK(status IN (...))`, index `(status, due_at)`
- [ ] T087 [US3] Triển khai `src/store/migrate.ts`: bảng `schema_meta`, áp migration theo phiên bản, `schema_incompatible` khi DB mới hơn code
- [ ] T088 [US3] Triển khai `src/store/open.ts`: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout` hữu hạn, `locking_mode=EXCLUSIVE` + `BEGIN IMMEDIATE; COMMIT`, `integrity_check`; lỗi `store_locked`, `schema_incompatible`, `integrity_failed`, `io_error` (R-06)
- [ ] T089 [P] [US3] Triển khai `src/store/crash.ts`: đọc `CUSR_CRASH_AT` một lần lúc mở, `process.kill(process.pid, 'SIGKILL')` tại 7 điểm của R-08, không làm gì khi biến không đặt
- [ ] T090 [US3] Triển khai `src/store/projector.ts`: áp sự kiện vào `tasks`, `effects`, `timers`, `frozen_policies`, `frozen_contexts`; dùng chung cho `accept` và `verifyProjections`
- [ ] T091 [US3] Triển khai `src/store/accept.ts`: transaction `BEGIN IMMEDIATE` dedup → đọc state, policy, `RelatedFacts` → `decide` → append (gán `seq`, `global_seq`) → projection → commit; không `await`; ánh xạ lỗi SQLite sang `write_failed` (phụ thuộc T088–T090)
- [ ] T092 [US3] Triển khai `src/store/claim.ts`: đọc projection, gọi `claimable`, append `EffectStarted` trong cùng transaction
- [ ] T093 [P] [US3] Triển khai `src/store/timers.ts`: `dueTimers`, `fireDueTimers` (mỗi timer một transaction, khoá `timer:<id>`, `TimerFired` cùng transaction)
- [ ] T094 [P] [US3] Triển khai `src/store/read.ts` (`readTask`, `readEvents`, `readPolicy`, `readContext`, `pendingEffects`) và `src/store/verify.ts` (`verifyProjections` dựng lại từ nhật ký và so JSON chuẩn hoá)
- [ ] T095 [US3] Tạo `src/store/index.ts` (`openStore`, interface `Store`) và `src/store/testing.ts` (`openMemoryStore` cùng schema theo R-09, hook crash); export `openStore` từ `src/index.ts`; điền suite US3 cho I02, I03, I04, I08, I10, I12 trong `test/invariants.map.ts`

**Checkpoint**: US3 xanh trên file SQLite thật trong WSL2.

---

## Phase 6: User Story 4 - Nâng model và ngân sách theo chính sách đã duyệt (Priority: P2)

**Goal**: Phân loại tám lớp thất bại, chọn nấc theo thang và sàn đã ánh xạ, giữ ngân sách trong giới hạn.

**Independent Test**: Phát lại chuỗi kết quả thất bại dưới các chính sách mẫu; so nấc, lượt đã dùng và lý do
chờ với bảng mong đợi (`pnpm test test/scenarios/us4-escalation.test.ts`).

**Phụ thuộc**: cần lõi quyết định của US2.

### Tests for User Story 4 ⚠️

- [ ] T096 [US4] Viết `test/scenarios/us4-escalation.test.ts`: 13 acceptance scenario của US4 đánh số như spec
- [ ] T097 [P] [US4] Viết `test/property/invariants/escalation.test.ts` (I09): nấc không giảm; luôn nằm trong thang của role với thang khác độ dài và khác binding; không bao giờ `denied`; không `needs_approval` khi chưa có approval khớp; không nâng vì `rate_limit`, `infra`, `auth_config`, `timeout`, `refused`, `unknown`; tối đa 3 lần thử chất lượng mỗi nấc; số lần nâng ≤ `max_escalations`
- [ ] T098 [P] [US4] Viết `test/property/invariants/budget.test.ts` (I09, FR-022): `used + reserved` ≤ `limit`; `unknown` giữ chỗ; vô hiệu hoá trả chỗ; mọi lượt `invoked`, kể cả bị rate limit, được tính
- [ ] T099 [P] [US4] Viết `test/property/invariants/usage.test.ts` (FR-024): usage luôn có `basis`; `unavailable` không bao giờ mang số 0

### Implementation for User Story 4

- [ ] T100 [US4] Triển khai `src/engine/failure.ts`: bảng xử lý tám lớp của FR-019, `class_counters` theo `(step, lớp)`, dừng theo giới hạn nào chạm trước giữa giới hạn lớp, trần lượt agent và `deadline_at`
- [ ] T101 [P] [US4] Triển khai `src/engine/backoff.ts`: rate limit hẹn timer tới `reset_at`, không có thì backoff theo `limits.backoff.rate_limit`; lớp `infra` theo `limits.backoff.infra`; hết `max_attempts` thì WAITING `policy` (R-22); jitter suy tất định từ hash của `idem_key`, không dùng `Math.random` (FR-012)
- [ ] T102 [US4] Triển khai `src/engine/escalation.ts`: `failure_streaks` theo `(step, rung)`, nấc mục tiêu = `max(rung[step], floor_map[step][floor_level], nấc_đề_xuất)` rồi kiểm theo thứ tự của R-18, `RungRaised`/`TaskFloorRaised`, approval theo FR-021 (phụ thuộc T100)
- [ ] T103 [US4] Nối `failure.ts`, `backoff.ts`, `escalation.ts` vào `src/engine/interpreter.ts` và cập nhật `src/engine/budget.ts` để ghi usage có nhãn `reported`/`estimated`/`unavailable`
- [ ] T104 [US4] Điền suite US4 cho I07, I09 trong `test/invariants.map.ts`

**Checkpoint**: US4 xanh; property test của US2 vẫn xanh sau khi nối.

---

## Phase 7: User Story 5 - Giải thích trạng thái từ dữ liệu đã ghi (Priority: P3)

**Goal**: Trả lời "task đang ở đâu, vì sao dừng, đã dùng nấc nào, còn bao nhiêu" chỉ từ dữ liệu đã ghi.

**Independent Test**: Với state và nhật ký từ kịch bản của US2–US4, `explain` khớp nhật ký
(`pnpm test test/scenarios/us5-explain.test.ts`).

### Tests for User Story 5 ⚠️

- [ ] T105 [US5] Viết `test/scenarios/us5-explain.test.ts`: 2 acceptance scenario của US5, cộng kiểm tra mọi task đang chờ trong kịch bản US2 và US4 có `wait.resume_when` và `wait.exit_paths` không rỗng (SC-006)

### Implementation for User Story 5

- [ ] T106 [US5] Triển khai `src/explain/explain.ts` theo kiểu `Explanation` của contracts/core-api.md (vị trí, lý do chờ, binding đã dùng, giới hạn còn lại, lịch sử nâng nấc kèm `event_seq`, effect đang chờ, hủy)
- [ ] T107 [US5] Export `explain` từ `src/index.ts`

**Checkpoint**: Cả năm story xanh độc lập.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Bộ reliability, báo cáo bất biến, kiểm tra ranh giới tĩnh và nghiệm thu.

- [ ] T108 [P] Viết `test/reliability/r4-sequences.test.ts`: 10.000 chuỗi tín hiệu sinh ngẫu nhiên qua `openMemoryStore`, kiểm mọi bất biến trong phạm vi sau mỗi `accept`; gửi lại mỗi tín hiệu 2–5 lần và so số sự kiện, effect, timer (SC-003, SC-007); in `seed` và `path` khi fail
- [ ] T109 [P] Viết `test/reliability/r1-crash.test.ts`: 200 lần `SIGKILL` có seed tại điểm ngẫu nhiên trên file SQLite WAL + `synchronous=FULL`; sau mỗi lần kiểm `integrity_check`, tín hiệu đã commit còn đủ, `verifyProjections` khớp 100% (SC-005)
- [ ] T110 Cho `pnpm test:reliability --seed <seed>` hoạt động: đọc seed qua biến `CUSR_SEED` trong `vitest.config.ts` và truyền vào fast-check và bộ crash ở T108, T109
- [ ] T111 [P] Viết `test/unit/lint/boundaries.test.ts`: chạy ESLint API trên `test/fixtures/lint/engine-violation.ts` (import `node:fs`, dùng `Date.now()`, `Math.random()`) với cấu hình như `src/engine/**`, khẳng định có đủ lỗi tương ứng (bằng chứng tĩnh cho I01)
- [ ] T112 Triển khai `scripts/report-invariants.ts` theo R-14: đọc `reports/vitest-default.json`, `reports/vitest-reliability.json` và `test/invariants.map.ts`, in bảng I01–I12, thoát lỗi khi bất biến trong phạm vi có suite thiếu, skip hoặc fail
- [ ] T113 Hoàn tất `test/invariants.map.ts` với suite của T108, T109, T111 và kiểm không bất biến nào có `suites` rỗng ngoài I05
- [ ] T114 [P] Thêm mục "Phát triển" vào `README.md`: điều kiện môi trường và các lệnh ở quickstart.md, liên kết tới `specs/001-deterministic-core/quickstart.md`
- [ ] T115 Chạy toàn bộ quickstart.md trong WSL2 (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:reliability`, `pnpm report:invariants`) và ghi kết quả thật, kể cả mục chưa đạt, vào `specs/001-deterministic-core/acceptance-report.md`, cùng mục "Hành trình liên quan" nêu S01–S10 nào được feature này phục vụ một phần và phần nào còn thuộc feature sau

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: bắt đầu ngay.
- **Foundational (Phase 2)**: sau Setup; chặn mọi story.
- **US1 (Phase 3)** và **US2 (Phase 4)**: sau Foundational, độc lập nhau.
- **US3 (Phase 5)**: sau US2 (kho gọi `decide`/`evolve`, `claimable`).
- **US4 (Phase 6)**: sau US2; có thể song song với US3.
- **US5 (Phase 7)**: sau US2; scenario dùng kết quả của US4, nên làm sau US4.
- **Polish (Phase 8)**: T108 cần US2–US4 và `openMemoryStore` (T095); T109 cần US3; T112–T115 cần mọi phase trước.

### User Story Dependencies

```text
Foundational ─┬─▶ US1
              └─▶ US2 ─┬─▶ US3 ─┐
                       ├─▶ US4 ─┼─▶ US5 ─▶ Polish
                       └────────┘
```

### Within Each User Story

- Test viết trước và fail trước khi triển khai.
- Schema/kiểu trước, hàm thuần trước shell I/O, module con trước `decide.ts`/`accept.ts`/`validate.ts`.
- Mỗi story kết thúc bằng task export và cập nhật `test/invariants.map.ts`.

### Parallel Opportunities

- Setup: T003, T004, T005 song song.
- Foundational: T007–T011 song song; T014–T019 song song sau T012.
- US1 và US2 song song sau Phase 2.
- US3 và US4 song song sau US2.
- Trong mỗi story, mọi test có [P] chạy song song; module engine T062–T073 có [P] nằm ở file riêng.

---

## Parallel Example: User Story 1

```bash
# Test của US1 cùng lúc:
Task: "Viết test/unit/config/loader.test.ts"
Task: "Viết test/unit/config/merge.test.ts"
Task: "Viết test/unit/config/checks.test.ts"
Task: "Viết test/unit/policy/freeze.test.ts"

# Module nền của loader cùng lúc:
Task: "Triển khai src/config/yaml-loader.ts"
Task: "Triển khai src/config/positions.ts"
Task: "Triển khai src/config/read-files.ts"
Task: "Triển khai src/policy/structure-hash.ts"
```

## Parallel Example: User Story 2

```bash
# Property test cùng lúc:
Task: "Viết test/property/invariants/determinism.test.ts"
Task: "Viết test/property/invariants/merge-guard.test.ts"
Task: "Viết test/property/invariants/claim.test.ts"

# Module engine độc lập cùng lúc:
Task: "Triển khai src/engine/merge-guard.ts"
Task: "Triển khai src/engine/cancel.ts"
Task: "Triển khai src/engine/revision.ts"
Task: "Triển khai src/engine/claim.ts"
Task: "Triển khai src/engine/reconcile.ts"
```

## Parallel Example: User Story 3

```bash
Task: "Viết test/integration/store/accept.test.ts"
Task: "Viết test/integration/store/effects.test.ts"
Task: "Viết test/integration/store/single-writer.test.ts"
Task: "Viết test/integration/crash/crash-points.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 Setup, Phase 2 Foundational.
2. Phase 3 US1: kiểm tra cấu hình và chốt chính sách.
3. **Dừng và kiểm chứng**: `pnpm test test/scenarios/us1-config.test.ts`, `pnpm typecheck`, `pnpm lint`,
   `pnpm build`.

MVP này cho chủ dự án phản hồi lỗi cấu hình có vị trí và chính sách đóng băng có hash, nhưng chưa có lõi
quyết định. Đây chưa phải mốc "Lõi" của SPEC.md §19; mốc đó cần US1–US4 và Phase 8.

### Incremental Delivery

1. Setup + Foundational → nền tảng.
2. US1 → cấu hình và chính sách (MVP).
3. US2 → lõi quyết định thuần, kiểm bằng scenario và property test.
4. US3 → kho bền; US4 song song → escalation và ngân sách.
5. US5 → giải thích.
6. Phase 8 → 10.000 chuỗi, 200 lần ngắt, báo cáo bất biến, nghiệm thu.

### Parallel Team Strategy

1. Cùng làm Setup + Foundational.
2. Người A: US1. Người B: US2.
3. Sau US2: người B làm US3, người A làm US4.
4. US5 và Phase 8 sau cùng.

---

## Notes

- [P] = file khác nhau, không phụ thuộc task chưa xong.
- Một bộ test chưa chạy hoặc chưa đạt phải ghi là chưa đạt trong `acceptance-report.md`; không thay bằng
  kiểm tra mô phỏng (nguyên tắc VII).
- Commit sau mỗi task hoặc nhóm task logic; mỗi commit chạm mã nguồn phải qua typecheck, lint, test, build.
