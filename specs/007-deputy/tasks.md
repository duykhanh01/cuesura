# Tasks: Deputy và goal

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)

**Trạng thái**: Backlog viết lại ngày 2026-11-09, thay backlog 2026-11-08. Lát A, B và C xong. Amendment
11.0.0 nằm cùng PR với bản viết lại; không task code nào bắt đầu trước khi PR đó merge.

**Mã nền**: `origin/main` `62eadbd`.

**Tests**: Bắt buộc, theo tầng của nguyên tắc VII:

- định tuyến, chữ ký lỗi, tín hiệu vòng lặp, bảng thử, loop guard, ngân sách context, kế hoạch: property test;
- migration, aggregate goal, bản ghi lượt, crash và nâng cấp: integration test trên SQLite thật;
- trả về worktree, hook hết lượt, CLI, nhánh goal và merge: contract test trên git, filesystem và remote giả;
- Story 1–8: scenario với fake harness;
- harness thật: smoke riêng.

Viết test trước, thấy nó thất bại rồi mới triển khai. Kết quả với fake harness không được ghi là smoke thật.

**Organization**: mỗi lát của plan là một phase và một PR.

| Lát | Phase | Story |
| --- | --- | --- |
| A | Phase 2 | nền |
| B | Phase 3 | US1, US6 (task), US7 — 🎯 MVP |
| C | Phase 4 | US2 |
| D | Phase 5 | US3 (kế hoạch), US5, US6 (goal) |
| E | Phase 6 | US3 (tích hợp) |
| F | Phase 7 | US4 |
| G | Phase 8 | US8 (lượt tương tác) |
| H | Phase 9 | US8 (ghi nhận) |
| I | Phase 10 | đồng bộ tài liệu, smoke |

## Format: `[ID] [P?] [Story] Description`

- `[P]`: làm đồng thời được sau prerequisite chung, vì khác file và không phụ thuộc task chưa xong.
- `[USn]`: task thuộc user story.
- Source ở `src/`, test ở `test/`. Một package Node 24, TypeScript strict, ESM. Không thêm dependency. Không đòi người
  dùng cài công cụ nào.
- `src/engine/` thuần (I01): không đọc user config, binding, `deputy_turns` hay `branch_conflicts`. Dữ liệu đó được
  daemon đưa vào trigger hay tham số của hàm thuần.
- `deputy_turns` và `branch_conflicts` không bao giờ sinh event hay làm đổi `version` (FR-025).
- Yêu cầu của goal, bằng chứng của bản miễn, bàn giao, `final_message` và context của lượt đi qua `Redactor` trước khi lưu.
- Comment chỉ khi cần thiết, bằng tiếng Anh ([AGENTS.md](../../AGENTS.md)).
- Mỗi PR có code: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:changed` sạch; khi sửa thì chạy trực
  tiếp file test liên quan bằng `pnpm vitest run <file>`. Test đầy đủ do CI chạy.
- **Số migration:** lấy số kế tiếp còn trống trên `origin/main` lúc làm T007; tasks gọi là `NNN_deputy_goal.sql`.

---

## Phase 1: Setup — đối chiếu mã nền, công cụ kiểm thử

- [x] T000 Amendment 11.0.0 và bản viết lại spec, plan, research, data model, contracts, tasks (PR của lát 0).
- [x] T001 Đối chiếu mã nền trên `origin/main` mới nhất và ghi kết quả vào research:
  - mọi chỗ đọc `events` không theo `task_id` (report, `decisions.md`, retention, verify, projector, history) cần lọc
    `stream = 'task'` (R-21);
  - cách phiên trợ lý biết lease hay session id khi gọi `cusr` ngoài `assistant wait` (R-26);
  - `ReviewEvidence` và schema output của reviewer chỗ thêm `key` (R-18);
  - bộ lọc log của gate dùng được cho chữ ký lỗi (R-18);
  - điều kiện bật yolo trong `src/daemon/yolo.ts` và `onYoloMergeApprove` chỗ thêm `policy:goal` (R-23);
  - `start_sha` qua `adoption` trong `src/daemon/handlers.ts` dùng được cho task tổng (R-24).
- [x] T002 [P] (Làm ở lát B, trừ fake reviewer trả `key` dời sang lát C, xem [R-30](research.md#quyết-định-khi-làm-lát-b).) Mở rộng fake harness `src/adapters/harness/fake.ts` cho role `deputy`. Kịch bản lượt là callback nhận
  `{ turn_id, env, context }` và có thể: gọi task service hay goal service với actor `deputy`, header turn, `reason`,
  `trial`; gọi `deputy handoff`; ghi vào worktree (sửa, tạo file, `git commit`); trả `turn_ended` có hay không có
  `final_message`; trả `rate_limited`, `auth`, `refused`, `capability_missing`, lỗi hạ tầng; treo. Fake reviewer trả
  finding có `key`. Test tự kiểm ở `test/unit/adapters/fake-harness-deputy.test.ts`.
- [x] T003 [P] (Một phần ở lát A, xem [R-30](research.md#quyết-định-khi-làm-lát-a).) Builder ở `test/support/deputy.ts`: user config có và không có `roles.deputy`, có `roles.decider` cũ,
  `autonomous` bật và tắt, `allow_models` nhiều model; task ở từng `DetailCode`; lịch sử dựng sẵn cho tín hiệu vòng lặp
  (finding lặp, cây quay lại, cùng chữ ký qua hai model); dòng `deputy_turns` `running` giả lập caller deputy; kế hoạch
  một và nhiều đơn vị; helper so HEAD và cây worktree với baseline.
- [x] T004 [P] Remote git giả cho test nhánh goal ở `test/support/git-remote.ts`: bare repo cục bộ làm `origin`, fake
  GitHub port cho PR vào nhánh bất kỳ, check xanh hay đỏ theo kịch bản, merge bằng merge commit, observation PR đã merge.
  Dùng lại fake GitHub hiện có nếu đủ.

---

## Phase 2: Foundational — lát A

**Purpose**: Danh tính `deputy`, trường cấp lệnh, migration, bảng định tuyến, mở lại giới hạn và `task fail`.

**⚠️ CRITICAL**: chưa xong phase này thì không story nào bắt đầu.

### Tests

- [x] T005 [P] Integration test migration ở `test/integration/store/deputy-goal-migration.test.ts`: DB hiện có nâng lên
  được và giữ dữ liệu; `events.stream` mặc định `task`; các bảng và cột mới đúng [data model](data-model.md); unique
  index một phần từ chối lượt `running`/`retry_wait` thứ hai cùng `task_id`, và lượt `plan` thứ hai cùng `goal_id`;
  ghi `deputy_turns` và `branch_conflicts` không đổi `version`, không thêm `events`.
- [x] T006 [P] Property test định tuyến ở `test/property/deputy/routing.test.ts`: mọi `DetailCode` có đúng một nơi đến;
  `auto` ⇔ `NEEDS_USER = false`; `effect_unknown` theo ngưỡng; mã PENDING trừ `dependency_pending` tới owner; danh sách
  owner của FR-001 kể cả `plan_amendment` và vi phạm ranh giới; câu hỏi của worker theo `autonomous`; còn lại tới deputy.
- [x] T007 [P] Contract test CLI ở `test/contract/cli/deputy-identity.test.ts`: có `CUSR_DEPUTY_TURN` thì `refuseWorker`
  cho chạy, actor `deputy` dù `CUSR_ACTOR=assistant`, header `x-cusr-turn`; `assistant hook|session-start|register|wait`
  thoát 0 không in gì; thiếu `--reason` thì `invalid_command`; `turn_id` không chạy thì `forbidden` `turn`; `--reason` lưu
  được với owner.

### Implementation

- [x] T008 Migration `src/store/migrations/NNN_deputy_goal.sql` đúng data model: `events.stream`, `goals`, `goal_tasks`,
  `deputy_turns`, `branch_conflicts`, cột mới của `command_ledger`, các unique index một phần.
- [x] T009 `src/store/deputy.ts`: `startTurn`, `finishTurn`, `scheduleRetry`, `setHandoff`, `runningTurn(task_id)`,
  `runningPlanTurn(goal_id)`, `turnsOf(task_id|goal_id)`, `isRunningTurn(turn_id)`, `turnGoal(turn_id)`; mỗi thao tác một
  transaction, không đụng `events`.
- [x] T010 [P] Kiểu domain theo data model: `RequesterKind` `deputy`; `TaskInput.goal`; `DetailCode` `plan_amendment`
  (thêm vào `NEEDS_USER`); `Role` `deputy`; `HarnessOutcome` `turn_ended`; `CommandKind` mới; `ReviewEvidence.findings[].key`
  tùy chọn ở lát này.
- [x] T011 [P] Ghi `detail.failure = 'boundary_violation'` có cấu trúc trên `effect_failed` tại nơi sinh vi phạm (FR-002).
  Test ở `test/integration/runtime/boundary-violation-detail.test.ts`.
- [x] T012 Thêm `deputy` vào `CALLER_ACTORS` (`read`, `operate`) trong `src/application/authz.ts`; `AuthzContext` mang
  `reason`, `trial`, `turn_id`, `lease`.
- [x] T013 `CommandSchema` và `admitCommand` (`src/application/commands.ts`): `reason`, `trial` ở cấp lệnh; `reason` bắt
  buộc với `deputy`; `turn_id` từ header; cả ba vào `command_hash` và `command_ledger`. Dời bước tra replay theo
  `request_id`, actor và `command_hash` lên trước mọi guard phụ thuộc trạng thái (R-07, FR-055). Phụ thuộc T008, T012.
- [x] T014 Header `x-cusr-turn` trong `src/daemon/server.ts`: actor `deputy` không có lượt `running` khớp thì `forbidden`
  `turn`. Phụ thuộc T009, T013.
- [x] T015 [P] `CUSR_DEPUTY_TURN` trong `src/runner/process-tag.ts`; `src/runner/sandbox.ts` không xóa biến này.
- [x] T016 CLI phía client: `src/cli/worker-guard.ts` (cho qua, im hook trợ lý), `src/cli/client.ts` (actor `deputy`,
  header turn), mọi lệnh ghi có `--reason`; lệnh gia hạn có `--hypothesis`, `--expect`. T007 phải xanh.
- [x] T017 `src/engine/deputy-routing.ts`: `DEPUTY_ROUTE` và `routeOf(state, autonomous, now)` (FR-001, R-02). T006 phải
  xanh.
- [x] T018 Hết thang thành wait (R-15): `chooseRung` (`src/engine/escalation.ts`) vào `ladder_exhausted`/`rung_denied`
  thay `failWithDraft`; cập nhật các test mà #252 đã đổi (`test/property/invariants/escalation.test.ts`,
  `test/scenarios/us4-escalation.test.ts`, `test/integration/runtime/execution-modes.test.ts`,
  `test/scenarios/task-continue.test.ts`).
- [x] T019 Lệnh `task_fail` (FR-032): trigger chỉ nhận khi WAITING, gọi `failWithDraft(ctx, reason)`; `REQUIRED_ROLE`
  `operate`; CLI `cusr task fail <id> --reason`. Contract test ở `test/contract/cli/task-fail.test.ts` (thiếu `--reason`
  exit 2, không WAITING exit 6).
- [x] T020 Mở rộng `continue` (`src/engine/continue.ts`) cho `agent_runs_exhausted`, `deadline`, `backoff_exhausted`
  (reset bộ đếm lỗi của lớp), `ci_wait_exhausted` (cửa sổ CI mới) (FR-030). Property test ở
  `test/property/deputy/continue.test.ts`.
- [x] T021 Mở rộng `amend-policy` (`src/application/amend-policy.ts`, `src/cli/tasks.ts`): `--agent-runs +N`, `--deadline`,
  `--model` tùy chọn khi có một trong hai; hạ xuống `operate`; `agent_runs_insufficient` chỉ gỡ bằng `--agent-runs`
  (FR-031). Contract test ở `test/contract/cli/amend-policy-limits.test.ts`.
- [x] T022 Wait cạn trần khi không có role `deputy` (R-11): ở daemon gửi `task_fail` actor `system:deputy-absent`;
  attention không báo trong khoảng chờ. Test ở `test/integration/runtime/deputy-absent.test.ts`.

**Checkpoint**: danh tính `deputy` với lý do, thử nghiệm và ID lượt; bảng định tuyến đủ mã; hết thang vào wait; có lệnh
kết thúc và mở lại giới hạn.

---

## Phase 3: Lát B — lượt headless (US1, US6 phần task, US7) 🎯 MVP

**Goal**: Deputy gỡ sự cố của task bằng lượt ngắn headless, bàn giao, chuyển cho người khi cần; thay decider.

**Independent Test**: [quickstart](quickstart.md) kịch bản US1, US6, US7 với fake harness.

### Tests

- [x] T023 [P] [US1] Scenario `test/scenarios/deputy/us1.test.ts`: mỗi mã wait tới deputy mở đúng một lượt, deputy fake gỡ
  và bàn giao, không có attention (SC-001); mã tới owner không mở lượt; lượt hết mà task vẫn ở sự cố thì attention có bàn
  giao và `final_message`; lượt không bàn giao thì `aborted` kèm danh sách lệnh và lượt sau thấy nó; hai sự cố liên tiếp
  thì lượt thứ hai là phiên mới (`session: null`) và thấy bàn giao của lượt trước.
- [x] T024 [P] [US6] Scenario `test/scenarios/deputy/us6-task.test.ts`: lệnh của chủ dự án giữa lượt được nhận, lệnh sau
  của deputy với version cũ bị từ chối (SC-006); lệnh của chủ dự án không bị từ chối vì lượt bắt đầu hay kết thúc; deputy
  gửi lại cùng request ID sau restart, kể cả sau khi lượt đã đóng, thì nhận kết quả cũ; lệnh deputy nhắm task ngoài goal của lượt bị `turn_scope`;
  lệnh ngoài bảng quyền bị `deputy_kind`.
- [x] T025 [P] [US7] Scenario `test/scenarios/deputy/us7.test.ts`: định tuyến câu hỏi theo `autonomous`, định tuyến lại khi
  đổi cờ, câu hỏi tiếp ở cùng step vẫn tới deputy, mục giả định trong mô tả PR.
- [x] T026 [P] Crash injection `test/integration/crash/deputy-turn.test.ts`: restart ở mọi điểm của lượt không tạo lượt thứ
  hai, không lặp lệnh; task đã rời sự cố khi khởi động lại thì lượt được đóng (FR-056, SC-004).
- [x] T027 [P] Contract test trả về worktree `test/contract/deputy/restore.test.ts`: sửa file, tạo file, `git commit`,
  restart giữa lượt; HEAD và cây bằng mốc (SC-005). Thêm: deputy `continue` giữa lượt thì worker chưa được dispatch cho tới
  khi restore xong, nên commit của worker không bị xóa; chặn còn nguyên sau restart (FR-017).
- [x] T028 [P] Integration test nâng cấp `test/integration/runtime/deputy-upgrade.test.ts`: bản ghi decider dở được đóng
  `superseded`, reservation đúng; `DeciderRan` cũ replay được; config có `roles.decider` nạp được kèm cảnh báo (SC-008).

### Implementation

- [x] T029 [US1] `src/daemon/deputy.ts` thay `decider.ts`: `round()` tìm sự cố theo `routeOf`, tôn trọng FR-014, ghi
  baseline và `deputy_turns` trước khi spawn, chạy `RunnerHarness` headless với `CUSR_DEPUTY_TURN`, `adopt` sau restart,
  `holds`/`version` cho attention. Dispatcher bỏ qua effect ghi worktree của task có lượt chưa restore xong (R-08).
  Context ở lát này dựng tạm từ sự cố và lịch sử task (vùng 1, 3, 5); lát D thay bằng
  `deputy-context.ts` đầy đủ.
- [x] T030 [US1] Lệnh `deputy handoff` (`src/application/commands.ts`, `src/cli/`): chỉ actor `deputy` có lượt chạy; ghi
  `handoff_json` qua `setHandoff`, không sinh event; schema ở [contracts/deputy-turn.md](contracts/deputy-turn.md#bàn-giao).
- [x] T031 [US1] Xử lý sau lượt theo [hợp đồng](contracts/deputy-turn.md#daemon-sau-lượt) bước 1–3 và 5: trả worktree,
  `aborted` khi thiếu bàn giao, `handed_off`/`done`, lỗi theo FR-024 (R-12). Bước 4 (loop guard) ở lát C.
- [x] T032 [US1] Attention và inbox (`src/application/attention.ts`, `src/application/inbox.ts`): `Deputy.holds` thay
  `Decider.holds`; sự cố `handed_off` hiện kèm bàn giao và `final_message`.
- [x] T033 [US6] Kiểm phạm vi và bảng quyền trong `admitCommand` (FR-051): `turnGoal(turn_id)` so với goal của task (ở lát
  này goal ẩn = chính task); bảng quyền FR-034.
- [x] T034 [US7] Bỏ đường decider trong `src/engine/questions.ts` cho câu hỏi mới, giữ replay; câu hỏi của worker là sự
  cố loại `question` của deputy; bỏ quy tắc một câu trả lời mỗi step và nhãn `grill` (FR-120).
- [x] T035 [US7] Mục giả định trong mô tả PR (`src/adapters/github/publish.ts`), dựng từ câu trả lời của deputy (R-14).
- [x] T036 Nâng cấp từ decider (R-13) trong `src/daemon/production.ts`; alias config `roles.decider` (FR-121, FR-122).
- [x] T037 `task show`/`explain` có `deputy` khi có lượt chạy (FR-026).
- [x] T038 `cusr doctor` báo binding, harness, manifest của deputy (FR-124).

**Checkpoint**: deputy headless gỡ mọi sự cố của task; decider đã bị thay.

---

## Phase 4: Lát C — vòng lặp, chống lặp và bản miễn (US2)

**Goal**: Trần thành điểm đánh giá lại; code tính tín hiệu, chặn lặp, cho miễn có bằng chứng.

**Independent Test**: quickstart kịch bản US2.

### Tests

- [x] T039 [P] [US2] Property test chữ ký lỗi `test/property/deputy/signature.test.ts`: cùng bằng chứng sau chuẩn hóa cho
  cùng chữ ký; log chỉ khác số dòng, thời gian, đường dẫn tạm cho cùng chữ ký; lỗi khác cho chữ ký khác.
- [x] T040 [P] [US2] Property test tín hiệu `test/property/deputy/loop-signals.test.ts` cho từng tín hiệu của FR-040 trên
  lịch sử dựng từ T003.
- [x] T041 [P] [US2] Property test loop guard `test/property/deputy/loop-guard.test.ts`: ba luật của FR-043; chỉ thị mới và
  plan version mới là bằng chứng mới; SC-009: mọi chuỗi lệnh không có tiến triển dừng sau số lệnh hữu hạn có chặn trên
  tính từ cấu hình, và chỉ còn `task fail`/`handover`; chỉ dẫn khác lời không mở thêm lượt; sửa kế hoạch do deputy áp
  không là bằng chứng mới; task thay thế một khóa đơn vị kế thừa bảng thử (chuỗi fail → thay → fail vẫn hữu hạn).
- [x] T042 [P] [US2] Property test bản miễn `test/property/deputy/waivers.test.ts`: review mà mọi finding chặn đã được miễn
  thì approve; gate được miễn chỉ qua khi đúng chữ ký; check được miễn chỉ qua ở đúng head, tên và nguồn, head mới thì
  không; đánh giá check dùng chung cho engine và guard của yolo; không áp khi `base_branch` thuộc `protected_branches`.
- [x] T043 [P] [US2] Scenario `test/scenarios/deputy/us2.test.ts`: sáu kịch bản của US2.

### Implementation

- [x] T044 [US2] Khóa finding (R-18): schema output reviewer có `key`; context của reviewer có finding còn mở kèm khóa;
  khóa dự phòng từ `file` và hash `msg`. Sửa `src/domain/state.ts`, schema output, template reviewer.
- [x] T045 [US2] `src/engine/failure-signature.ts` (thuần) theo R-18. T039 phải xanh.
- [x] T046 [US2] `src/engine/loop-signals.ts` (thuần) theo FR-040. T040 phải xanh.
- [x] T047 [US2] `src/engine/trials.ts`: bảng thử khóa theo `(goal_id, unit_key, signature)` từ command ledger và chuỗi
  sự cố của mọi task từng giữ khóa đơn vị; `loopGuard` với định nghĩa bằng chứng mới của FR-043. Daemon đọc bảng thử và đưa
  vào `admitCommand` (lệnh của deputy) như dữ liệu. T041 phải xanh.
- [x] T048 [US2] Bắt buộc `trial` với lệnh gia hạn của deputy (FR-042) và áp `loopGuard` trong `admitCommand`, trả lỗi đúng
  [contracts/cli-daemon.md](contracts/cli-daemon.md#danh-tính-và-quyền).
- [x] T049 [US2] Loop guard sau lượt (bước 4 của hợp đồng lượt): `task_fail` actor `system:loop-guard` (FR-044).
- [x] T050 [US2] Lệnh `task_waive` và event `Waived` (FR-045); `src/engine/waivers.ts` áp hiệu lực trên review, gate, CI
  theo phạm vi của R-20; `ReviewWaived`, `GateResult.waived`. Tách hàm đánh giá check dùng chung cho `ciVerdict` và
  `currentChecksProblem` của yolo. T042 phải xanh.
- [x] T050a [US2] Effect `github.update_pr_body` sau `Waived` khi task đã có PR; bước merge chờ tới khi thân PR được đối
  chiếu có bản miễn (FR-046). Contract test ở `test/contract/deputy/waiver-pr-body.test.ts`.
- [x] T051 [US2] Context của lượt có tín hiệu, chữ ký và bảng thử (vùng 3); lệnh khả dụng ghi rõ lệnh sẽ bị loop guard từ
  chối (vùng 5).
- [x] T052 [US2] Vai trò của deputy (văn bản cố định): bảng nguyên nhân → hành động, luật chống lặp, bắt buộc bàn giao.
- [x] T053 [US2] (Làm ở lát H, xem [R-30](research.md#quyết-định-khi-làm-lát-h).) `task explain` có `loop_signals`, `signature`, `waivers`.

**Checkpoint**: deputy không lặp được cùng hành động khi không có tiến triển; bản miễn có hiệu lực và có dấu vết.

---

## Phase 5: Lát D — goal, kế hoạch, lease và sổ goal (US3 phần kế hoạch, US5, US6 phần goal)

**Goal**: Giao việc bằng goal; deputy lập kế hoạch; duyệt một lần; sửa có phân loại; trao đổi từ mọi phiên.

**Independent Test**: quickstart kịch bản US3 (kế hoạch) và US5.

### Tests

- [x] T054 [P] [US3] Property test kế hoạch `test/property/deputy/plan.test.ts`: `validatePlan` theo bảng lỗi của
  [contracts/goal.md](contracts/goal.md#kiểm-tra-validateplan); hash ổn định với thứ tự khóa; `parallelGroups` là tầng
  đúng của DAG; `classifyAmendment` theo bảng; `affectedUnits` bắc cầu.
- [x] T055 [P] [US3] Integration test aggregate goal `test/integration/store/goal-aggregate.test.ts`: lệnh goal qua
  `accept` với request ID và expected version; projection `goals` và `goal_tasks`; replay ra cùng `GoalState`.
- [x] T056 [P] [US3] Scenario `test/scenarios/deputy/us3-plan.test.ts`: kịch bản 1–4, 8, 9 của US3; xác nhận tạo task đã
  xác nhận intake và run config; goal một đơn vị không có nhánh goal; đổi `description` là sửa phạm vi, đổi `instructions`
  là sửa thực thi.
- [x] T057 [P] [US5] Scenario `test/scenarios/deputy/us5.test.ts`: đọc không cần lease; ghi goal không lease bị
  `lease_required`; sau khi lấy lease thì ghi được và tin tới phiên đó; không phiên nào mở thì goal vẫn chạy.
- [x] T058 [P] [US6] Scenario `test/scenarios/deputy/us6-goal.test.ts`: `goal revise` giữa lượt `plan` làm `goal propose` cũ
  bị `plan_version` và mở lượt `plan` mới; hai `goal amend` cùng plan version chỉ một được nhận.
- [x] T059 [P] Property test context `test/property/deputy/context.test.ts` (SC-010): vùng 3–5 trong ngân sách với mọi
  lịch sử; vùng 2 đủ; thứ tự vùng cố định; vùng 2 giống hệt giữa hai lượt khi yêu cầu, chỉ thị và kế hoạch không đổi.

### Implementation

- [x] T060 [US3] `src/domain/goal.ts`: `GoalState`, `PlanSchema`, event của goal. `src/engine/plan.ts` (thuần). T054 phải
  xanh.
- [x] T061 [US3] Aggregate goal: `src/engine/goal/` (decide/evolve), đường `accept` cho `stream = 'goal'`,
  `src/store/goals.ts` (projection). Lọc `stream = 'task'` ở mọi chỗ T001 liệt kê. T055 phải xanh.
- [x] T062 [US3] Lệnh goal (`src/application/commands.ts`, `src/cli/goal.ts`): `add`, `revise`, `note`, `propose`, `amend`,
  `confirm`, `cancel`, `show`, `list` theo [contracts/goal.md](contracts/goal.md); `task add` tạo goal ẩn (FR-070).
- [x] T063 [US3] Xác nhận kế hoạch (FR-074): trong một transaction ghi `PlanConfirmed` và trigger `task_add` nội bộ cho mỗi
  đơn vị với `goal` (gồm `depends_on_units`), run config đã xác nhận theo digest kế hoạch. Lát này dùng `base_branch` là nhánh gốc cho
  mọi đơn vị; lát E đổi sang nhánh goal.
- [x] T064 [US3] Sửa kế hoạch (FR-075): thực thi áp ngay và cập nhật `depends_on`, run config của task đơn vị chưa bắt đầu
  hay đang ở ranh giới step; phạm vi vào `amendment_pending`, đơn vị bị chạm vào wait `plan_amendment` ở ranh giới step kế
  tiếp.
- [x] T065 [US5] Lease cho lệnh goal của trợ lý (FR-101, R-26): `x-cusr-lease`, kiểm ở `admitCommand`; tin của goal qua
  attention (FR-102).
- [x] T066 [US3] `src/application/goal-ledger.ts` và `src/application/deputy-context.ts` theo FR-060–FR-064 và
  [contracts/deputy-turn.md](contracts/deputy-turn.md#context-của-lượt); thay context tạm của T029. T059 phải xanh.
- [x] T067 [US3] Lượt `plan` trong `deputy.ts` (FR-006): mở khi goal `planning` hay `replan`, tối đa một mỗi goal; không có
  role `deputy` thì không mở và tin "goal cần kế hoạch" tới phiên giữ lease.
- [x] T068 [US3] Phạm vi lượt mở rộng tới goal (FR-051): lượt của một đơn vị được thao tác trên mọi task và kế hoạch của
  goal đó; goal ẩn chỉ có một task.
- [x] T069 [US3] `goal show` (FR-073): kế hoạch đầy đủ, nhóm song song, version, hash, tiến độ từng đơn vị, sự cố đang mở,
  lượt đang chạy.
- [x] T070 Task có trước nâng cấp là goal ẩn khi đọc (FR-123). Test ở `test/integration/runtime/legacy-task-goal.test.ts`.

**Checkpoint**: giao goal, duyệt kế hoạch một lần, sửa kế hoạch có phân loại, đọc tiến độ từ mọi phiên; đơn vị vẫn mở PR
vào nhánh gốc.

---

## Phase 6: Lát E — nhánh goal, tích hợp và task tổng (US3 phần tích hợp)

**Goal**: Goal nhiều đơn vị chạy xuyên đêm tới một PR xanh vào nhánh gốc.

**Independent Test**: quickstart kịch bản US3 (tích hợp) trên remote giả.

### Tests

- [x] T071 [P] [US3] Contract test `test/contract/deputy/goal-branch.test.ts` trên remote giả: tạo nhánh goal idempotent
  (gửi lại sau mất kết quả không tạo lần hai; ref trỏ chỗ khác thì `effect_failed`).
- [x] T072 [P] [US3] Scenario `test/scenarios/deputy/us3-integration.test.ts`: goal ba đơn vị (A, B độc lập; C phụ thuộc A,
  B): A và B chạy song song; merge chỉ khi head chứa đỉnh nhánh goal, không thì base update rồi CI lại; C bắt đầu sau khi A
  và B DONE từ đỉnh nhánh goal; first-parent của nhánh goal có đúng ba merge commit (SC-012); task tổng chạy `goal_final`,
  mở PR có mục đơn vị, merge commit, bản miễn, quyết định; không có lệnh của người từ lúc duyệt tới PR ready.
- [x] T073 [P] Crash injection `test/integration/crash/goal-merge.test.ts`: restart giữa tạo nhánh và giữa merge vào
  nhánh goal không tạo merge commit thứ hai (SC-004); push tay vào nhánh goal dừng merge và đưa goal vào `replan`.

### Implementation

- [x] T074 [US3] Effect `git.create_goal_branch` (`src/daemon/goal-branch.ts`) và `GoalBranchCreated`; đơn vị chờ
  `dependency_pending` có `detail.goal_branch` tới khi nhánh có. T071 phải xanh.
- [x] T075 [US3] Đơn vị của goal nhiều đơn vị có `base_branch` = nhánh goal và `merge_method` = `merge` (sửa T063).
- [x] T076 [US3] Merge vào nhánh goal (R-23): `src/daemon/yolo.ts` bật cho đơn vị của goal đã xác nhận nhắm nhánh goal của
  nó; `onYoloMergeApprove` ghi approver `policy:goal`; required check lấy theo nhánh gốc; khóa một effect merge đang bay mỗi
  nhánh goal; kiểm đỉnh nhánh goal bằng merge commit cuối daemon đã ghi, khác thì `goal_branch_drift` và replan (R-23).
  Không đổi hành vi yolo hiện có của task khác.
- [x] T077 [US3] Workflow `goal_final` (`src/engine/workflows/goal-final.ts`) và task tổng (R-24): tạo lúc xác nhận, phụ
  thuộc mọi đơn vị, `start_sha` là đỉnh nhánh goal khi bắt đầu, không qua `adopt_approval`.
- [x] T078 [US3] Context reviewer của task tổng (FR-086): diff nhánh goal so với nhánh gốc theo giới hạn, kế hoạch, tiêu chí
  nghiệm thu, danh sách merge commit.
- [x] T079 [US3] Mô tả PR của goal (FR-087) trong `src/adapters/github/publish.ts`.
- [x] T080 [US3] Goal `done` khi task tổng DONE; `goal cancel` hủy mọi task chưa kết thúc (FR-078).
- [x] T081 `cusr doctor` báo project không có required check (chỉ dùng được goal một đơn vị).

**Checkpoint**: goal nhiều đơn vị đi từ duyệt tới PR ready, CI xanh, không chờ người.

---

## Phase 7: Lát F — điều phối xuyên goal và replan (US4)

### Tests

- [x] T082 [P] [US4] Scheduler test `test/integration/runtime/goal-scheduler.test.ts` (SC-011): hai goal, scope rời chạy
  song song tới hết slot; scope chồng thì chờ theo guard; một lượt deputy đang chạy không đổi kết quả dispatch.
- [x] T083 [P] [US4] Contract test `test/contract/deputy/branch-conflicts.test.ts`: hai nhánh xung đột thật thì có dòng
  `branch_conflicts`; chỉ đổi cùng file mà không xung đột thì không; dòng bị xóa khi một task kết thúc; không task nào chờ vì
  xung đột.
- [x] T084 [P] [US3] Scenario `test/scenarios/deputy/goal-replan.test.ts`: đơn vị FAILED đưa goal vào `replan`; lượt `plan`
  thay đơn vị bằng task mới cùng khóa (thực thi), hoặc gửi sửa phạm vi chờ người, hoặc `handover`; đơn vị độc lập vẫn chạy;
  task phụ thuộc và task tổng không bị hủy dây chuyền, kể cả khi scheduler chạy trước lượt `plan`, và được đánh thức khi
  task thay thế DONE; thay đơn vị đã FAILED vì loop guard là sửa phạm vi.

### Implementation

- [x] T085 [US4] `src/daemon/conflicts.ts`: sau checkpoint, `git merge-tree --write-tree` với task hoạt động có file đã đổi
  chồng nhau; ghi `branch_conflicts` (FR-092). Đưa vào vùng 4 của context, `task explain`, `goal show`.
- [x] T086 [US4] Kiểm scheduler với đơn vị: scope khai báo bắt buộc đã có từ kế hoạch; không thêm luật chờ mới (FR-090,
  FR-091).
- [x] T087 [US3] Replan (FR-076, R-29): đơn vị FAILED thì `GoalReplanNeeded`; `notifyDependents` giải phụ thuộc theo khóa
  đơn vị và không hủy dây chuyền trong goal có kế hoạch chưa kết thúc; lối ra của lượt `plan` theo FR-076; thay đơn vị bằng
  task mới cùng khóa trong `goal_tasks`; goal `failed`/`cancelled` thì hủy task chưa kết thúc.

---

## Phase 8: Lát G — lượt tương tác (US8)

- [ ] T088 Spike hook hết lượt trên phiên bản Claude Code và Codex đang pin: trong private home tạm, cài hook Stop hay
  `notify` ghi stdin ra file; chạy phiên tương tác mới có prompt đầu và resume tương tác; ghi lại input của hook có tin nhắn
  cuối không, hook có chạy khi người gõ tiếp không. Kết luận vào R-03; harness không đáp ứng thì chỉ chạy headless.
- [ ] T089 [P] Contract test hook hết lượt `test/contract/deputy/turn-end.test.ts`: `turn-ended.json` được ghi, runner dừng
  process, `recover` không spawn lại; stall chuyển sang headless cùng phiên trong cùng lượt.
- [ ] T090 Adapter `interactiveArgv` (`src/adapters/harness/claude.ts`, `codex.ts`); hook gộp vào settings của private home
  (`src/runner/private-home.ts`); luật cấm sửa `<data dir>/worktrees/**` (FR-053).
- [ ] T091 Runner chế độ tương tác (`src/runner/invocation.ts`): `--pty` trong terminal backend, theo dõi `turn-ended.json`,
  outcome `turn_ended`, stall (FR-013).
- [ ] T092 [US8] Cửa sổ mang tên `deputy: <tiêu đề>` trong terminal backend khi lượt chạy (US8 kịch bản 2).

---

## Phase 9: Lát H — ghi nhận và xem lại (US8)

- [x] T093 [P] [US8] Scenario `test/scenarios/deputy/us8.test.ts` (SC-007): `decisions.md`, `report`, `goal show`, chi tiết
  task, mô tả PR có mỗi quyết định với goal, task, sự cố, hành động, lý do, giả thuyết, tiêu chí, kết quả; bản miễn hiện là
  "miễn".
- [x] T094 [US8] `decisions.md` và `report` (`src/application/report.ts`): `deputy_decisions` (giữ `agent:decider` cũ),
  `waivers`, `goals`; join command ledger và `deputy_turns` theo `turn_id`; kết quả đo lấy từ bảng thử.
- [x] T095 [US8] Mục quyết định và bản miễn trong mô tả PR đơn vị (FR-111).
- [x] T096 [US8] Lịch sử task hiện actor, lý do, ID lượt, thử nghiệm của mỗi lệnh.

---

## Phase 10: Lát I — đồng bộ tài liệu và smoke

- [ ] T097 Đồng bộ `SPEC.md` theo danh sách cuối [spec](spec.md#tác-động-lên-hiến-chương-và-spec), gồm mục còn chờ của
  amendment 10.0.0.
- [ ] T098 [P] `deploy/README.md`: role `deputy` và limits, mục goal, bỏ decider.
- [ ] T099 [P] ADR-0005 sửa câu về decider; ADR mới cho lượt deputy; ADR mới cho nhánh goal.
- [ ] T100 [P] `GLOSSARY.md` và `docs/architecture.md`.
- [ ] T101 [P] `specs/003-telegram-channel/spec.md` và skill `cusr` (lệnh `goal`, lease, đọc tiến độ).
- [ ] T102 Cập nhật Sync Impact Report của hiến chương: không còn mục đồng bộ chờ.
- [ ] T103 Smoke harness thật theo [quickstart](quickstart.md#kịch-bản-với-harness-thật-smoke-tốn-usage): SC-002 (một
  đêm, goal ít nhất năm đơn vị có phụ thuộc), SC-003 (phiên treo); ghi acceptance report, mục chưa chạy ghi "chưa đạt".

## Dependencies & Execution Order

- Phase 1 → Phase 2 → Phase 3.
- Phase 4 (C) và Phase 5 (D) song song được sau Phase 3; T066 (context đầy đủ) gộp vùng 3 của T051 khi cả hai xong.
- Phase 6 (E) cần Phase 5. Phase 7 (F) cần Phase 6. Phase 9 (H) cần Phase 4 và Phase 6.
- Phase 8 (G) chỉ cần Phase 3.
- Phase 10 cuối cùng.

Trong mỗi phase: test `[P]` viết trước và đỏ; implementation theo thứ tự ghi, task `[P]` song song được.
