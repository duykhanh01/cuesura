# Tasks: Deputy, agent theo task làm thay chủ dự án

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)

**Trạng thái**: Backlog tạo ngày 2026-11-08. Amendment hiến chương 10.0.0 đã merge (PR #254); chưa có task code nào được
làm.

**Mã nền**: `origin/main` `cee8fea`. Hai thay đổi chạm feature này (#247 qua PR #252, #248 qua PR #255) đã được đưa vào
spec, plan và research trong PR #253 ([R-15](research.md#r-15--hết-thang-trở-lại-thành-wait-task-fail-là-lệnh-kết-thúc)):
hết thang vào lại wait, lệnh `task fail` (FR-036), và `intake.auto_confirm` không áp dụng cho task nháp hay task do deputy
tạo (FR-043, FR-052).

**Tests**: Bắt buộc. Hiến chương nguyên tắc VII yêu cầu bằng chứng theo tầng:

- bảng định tuyến và chuyển trạng thái lượt: property test;
- bản ghi lượt, migration, crash và nâng cấp từ decider: integration test trên SQLite thật;
- trả về worktree, hook hết lượt và CLI: contract test trên git và filesystem thật;
- Story 1–6: scenario với fake harness;
- harness thật: smoke riêng.

Viết test trước, thấy nó thất bại rồi mới triển khai. Kết quả với fake harness không được ghi là smoke thật.

**Organization**: Theo các lát của plan, lát 0 → A → B → C → D → E → F, ánh xạ sang story như sau:

| Lát | Phase |
| --- | --- |
| 0 | Phase 1 |
| A | Phase 2 và Phase 3 (US2) |
| B | Phase 4 (US1, 🎯 MVP), Phase 5 (US5), Phase 6 (US3) |
| D | Phase 7 (US4) |
| C, E | Phase 8 (US6) |
| F | Phase 9 |

Theo quy ước repo, mỗi phase là một PR, trừ khi phase quá nhỏ và gộp được với phase kế tiếp.

## Format: `[ID] [P?] [Story] Description`

- `[P]`: làm đồng thời được sau prerequisite chung, vì khác file và không phụ thuộc task chưa xong.
- `[USn]`: task thuộc user story, chỉ dùng trong phase story.
- Source ở `src/`, test ở `test/`. Một package Node 24, TypeScript strict, ESM. Không thêm dependency. Không đòi người
  dùng cài công cụ nào.
- `src/engine/` thuần (I01): không đọc user config, binding hay bảng `deputy_*`. Mọi thứ về phiên, lượt và harness nằm ở
  `src/daemon/`, `src/runner/`, `src/adapters/`.
- Bảng `deputy_sessions` và `deputy_turns` không bao giờ sinh event của task hay làm đổi `version` (FR-022).
- `final_message` và prompt của lượt đi qua `Redactor` trước khi lưu.
- Comment chỉ khi cần thiết và viết bằng tiếng Anh ([AGENTS.md](../../AGENTS.md)).
- Mỗi PR có code: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:changed` sạch; khi đang sửa thì chạy
  trực tiếp file test liên quan bằng `pnpm vitest run <file>`. Test đầy đủ do CI chạy.
- **Số migration:** `main` đang tới `007_slot_reservations.sql`. Lúc làm T006, lấy số kế tiếp còn trống trên
  `origin/main`; tasks gọi nó là `NNN_deputy.sql`.

---

## Phase 1: Setup — lát 0, đối chiếu mã nền, công cụ kiểm thử

**Purpose**: Chốt các giả định còn mở và đưa spec về khớp `main` hiện tại. Chuẩn bị fake harness và builder mà mọi test
sau dùng.

- [x] T001 Kiểm PR #254 (amendment hiến chương 10.0.0) đã merge vào `main` và Constitution Check của plan ghi "đạt theo
  10.0.0". Đã xong trong PR #253.
- [ ] T002 Chạy spike hook hết lượt trên phiên bản Claude Code và Codex đang pin trong manifest, mỗi harness:
  1. Trong một private home tạm, cài hook Stop (Claude) hoặc `notify` (Codex). Hook ghi stdin của nó ra file.
  2. Chạy phiên tương tác bằng `claude --resume <session> "<prompt>"` và `codex resume <session> "<prompt>"`, tức resume
     có prompt đầu tiên, rồi để agent kết thúc lượt.
  3. Ghi lại: input của hook có trường tin nhắn cuối không, hay chỉ có đường dẫn transcript; hook có chạy khi người gõ
     tiếp vào phiên không; resume tương tác có nhận prompt đầu tiên không.

  Ghi kết luận vào mục R-03 của `specs/007-deputy/research.md`: nguồn của `final_message` và argv tương tác đã kiểm.
  Phiên bản nào không đáp ứng thì ghi rõ để T063 và T066 chỉ dùng headless cho harness đó.
- [x] T003 Đối chiếu spec với `origin/main` sau #247 và #248. Đã xong trong PR #253: FR-001 (nhóm tự tiếp tục), FR-004,
  FR-036, FR-043, FR-052, R-11, R-15 và `contracts/cli-daemon.md`.
- [ ] T004 [P] Mở rộng fake harness `src/adapters/harness/fake.ts` cho role `deputy`. Kịch bản của lượt là một callback
  nhận `{ turn_id, env, prompt }` và có thể:
  - gọi task service với actor `deputy`, header turn và `reason`, giống như CLI trong phiên;
  - ghi vào worktree của task: sửa file, tạo file, `git commit`;
  - trả `turn_ended` có hoặc không có `final_message`;
  - trả `rate_limited` có `reset_at`, `auth`, `refused`, `capability_missing` hoặc lỗi hạ tầng;
  - treo không trả gì để test stall.

  Test tự kiểm ở `test/unit/adapters/fake-harness-deputy.test.ts`.
- [ ] T005 [P] Thêm builder ở `test/support/deputy.ts`:
  - user config có và không có `roles.deputy`, có `roles.decider` cũ, có `autonomous` bật và tắt;
  - task đặt sẵn ở từng `DetailCode`, dùng builder hiện có trong `test/support/builders.ts`;
  - chèn một dòng `deputy_turns` ở trạng thái `running` để giả lập caller deputy (dùng ở US2 trước khi có `deputy.ts`);
  - helper so HEAD và cây worktree với một baseline.

---

## Phase 2: Foundational — danh tính, lý do, bản ghi lượt, bảng định tuyến (lát A)

**Purpose**: Kiểu domain, lưu trữ, danh tính `deputy` và bảng định tuyến mà mọi story dùng.

**⚠️ CRITICAL**: Chưa xong phase này thì không story nào bắt đầu được.

### Tests cho nền ⚠️

- [ ] T006 [P] Viết integration test cho migration `NNN_deputy.sql` ở `test/integration/store/deputy-migration.test.ts`:
  - DB `main` hiện có nâng lên được và giữ nguyên dữ liệu;
  - `command_ledger` có cột `reason TEXT NULL` và `turn_id TEXT NULL`;
  - unique index một phần từ chối dòng `running` hoặc `retry_wait` thứ hai của cùng `task_id` (FR-018);
  - ghi `deputy_sessions` và `deputy_turns` không làm đổi `version` của task, không thêm dòng `events` (FR-022).
- [ ] T007 [P] Viết property test cho bảng định tuyến ở `test/property/deputy/routing.test.ts`:
  - mọi `DetailCode` có đúng một nơi đến;
  - `DEPUTY_ROUTE[c] === 'auto'` khi và chỉ khi `NEEDS_USER[c] === false`, với mọi mã `c`;
  - `effect_unknown` chưa quá ngưỡng của #249 trả `null`, đã quá ngưỡng trả `deputy`;
  - mọi mã PENDING trừ `needs_draft` và `dependency_pending` tới owner;
  - `run_config_unconfirmed`, `paused`, `escalation_rejected`, `adopt_approval`, `merge`, `auth_config`, `harness_auth`,
    `refused` tới owner;
  - `effect_failed` có `detail.failure = 'boundary_violation'` tới owner, `effect_failed` khác tới deputy;
  - `agent_question`, `agent_needs_context`, `agent_blocked` tới deputy khi `autonomous` bật, tới owner khi tắt;
  - mọi mã còn lại tới deputy (FR-001).
- [ ] T008 [P] Viết contract test CLI ở `test/contract/cli/deputy-identity.test.ts`:
  - có `CUSR_DEPUTY_TURN` thì `refuseWorker` cho chạy, actor là `deputy` dù `CUSR_ACTOR=assistant`, client gửi
    `x-cusr-actor: deputy` và `x-cusr-turn` (FR-050);
  - `cusr assistant hook|session-start|register|wait` thoát 0, không in gì (FR-051);
  - lệnh ghi của deputy không có `--reason` bị từ chối `invalid_command`, exit 2 (FR-055);
  - `turn_id` không phải lượt `running` thì `forbidden` với `reason: 'turn'`, exit 5 (FR-056);
  - `--reason` lưu được trên một lệnh ghi bất kỳ của owner.

### Implementation cho nền

- [ ] T009 Thêm migration `src/store/migrations/NNN_deputy.sql` đúng [data-model](data-model.md):
  - `deputy_sessions`: `task_id TEXT PK`, `harness TEXT`, `session_ref TEXT NULL`, `created_at INTEGER`,
    `closed_at INTEGER NULL`;
  - `deputy_turns`: `turn_id TEXT PK`, `task_id`, `incident`, `wait_code`, `attempt_id`, `mode` (`interactive` |
    `headless`), `seeded INTEGER`, `state` (`running` | `retry_wait` | `done` | `handed_off` | `stopped`),
    `infra_failures INTEGER`, `retry_at INTEGER NULL`, `final_message TEXT NULL`, `handoff_reason TEXT NULL` (`still_waiting`,
    `auth`, `refused`, `capability`, `no_harness`, `infra_cap`), `started_at`, `ended_at`;
  - unique index một phần trên `task_id` khi `state IN ('running','retry_wait')`;
  - `command_ledger`: thêm `reason TEXT NULL`, `turn_id TEXT NULL`.
- [ ] T010 Thêm `src/store/deputy.ts` để đọc và ghi hai bảng trên, mỗi thao tác một transaction riêng, không đụng `events`:
  `openSession`, `startTurn`, `finishTurn(state, final_message, handoff_reason)`, `scheduleRetry(retry_at)`, `runningTurn(task_id)`,
  `turnsOf(task_id)`, `closeSession`, `isRunningTurn(turn_id)`.
- [ ] T011 [P] Sửa kiểu domain theo [data-model](data-model.md):
  - `RequesterKind` thêm `deputy` (`src/domain/task.ts`);
  - `DetailCode` thêm `needs_draft` thuộc nhóm PENDING (`src/domain/state.ts`);
  - `Role` thêm `deputy` (`src/domain/policy.ts`); `decider` chỉ còn cho replay;
  - `HarnessOutcome` thêm `{ kind: 'turn_ended', final_message: string | null, session_ref, usage }`
    (`src/adapters/ports.ts`);
  - `CommandKind` thêm `task_revise` và `task_fail`; payload `task_add` có `draft?: true`; payload `task_amend_policy` có
    `agent_runs_delta?` và `deadline?`.

  Thêm `needs_draft` vào `NEEDS_USER` trong `src/explain/needs-user.ts` để build qua.
- [ ] T012 [P] Ghi `detail.failure = 'boundary_violation'` có cấu trúc trên wait `effect_failed` tại nơi sinh vi phạm ranh
  giới (`src/runner/invocation.ts` → `src/daemon/handlers.ts` → engine). Văn bản câu hỏi giữ nguyên (FR-002). Test ở
  `test/integration/runtime/boundary-violation-detail.test.ts`.
- [ ] T013 Thêm `deputy` vào `CALLER_ACTORS` với quyền `read` và `operate`, không có `admin`, trong
  `src/application/authz.ts`. `AuthzContext` mang thêm `reason?` và `turn_id?` để event của lệnh lưu chúng.
- [ ] T014 Sửa `CommandSchema` và `admitCommand` trong `src/application/commands.ts`:
  - `reason: string (1–4096) | null` và `turn_id` ở cấp lệnh, không trong payload;
  - `reason` bắt buộc khi actor là `deputy`;
  - `turn_id` lấy từ header đã kiểm, không lấy từ body;
  - `command_hash` gồm cả `reason` và `turn_id`;
  - ghi `reason` và `turn_id` vào `command_ledger` (`src/store/commands.ts`).

  Phụ thuộc T009, T013.
- [ ] T015 Đọc header `x-cusr-turn` trong `src/daemon/server.ts`. Actor `deputy` không có lượt `running` khớp thì trả
  `forbidden` với `reason: 'turn'` (dùng `isRunningTurn` của T010). Phụ thuộc T010, T014.
- [ ] T016 [P] Thêm `DEPUTY_TURN_ENV = 'CUSR_DEPUTY_TURN'` vào `src/runner/process-tag.ts`. Process deputy mang biến này
  thay cho `CUSR_ATTEMPT_ID`. `src/runner/sandbox.ts` không xóa biến này như các `CUSR_*` khác.
- [ ] T017 Sửa CLI phía client:
  - `src/cli/worker-guard.ts`: `refuseWorker` cho qua khi có `CUSR_DEPUTY_TURN`; `assistant hook|session-start|register|wait`
    thoát 0 và không làm gì;
  - `src/cli/client.ts`: `readClientActor` trả `deputy` khi có biến này, bỏ qua `CUSR_ACTOR`; gửi header `x-cusr-turn`;
  - `src/cli/tasks.ts`, `src/cli/commands.ts`, `src/cli/requests.ts`: mọi lệnh ghi có `--reason`; `cancel` và `pause` dùng
    lại option `--reason` đang có.

  Phụ thuộc T014, T016. T008 phải xanh.
- [ ] T018 Thêm `src/engine/deputy-routing.ts`: `DEPUTY_ROUTE: Record<DetailCode, 'deputy' | 'owner' | 'worker_question' |
  'auto'>` và hàm thuần `routeOf(state, autonomous, now): 'deputy' | 'owner' | null` (FR-001, R-02). `auto` trả `null`,
  trừ `effect_unknown` đã quá ngưỡng (`effectUnknownOverdue`) trả `deputy`. `effect_failed` đọc thêm `detail.failure`.
  T007 phải xanh.
- [ ] T019 Khôi phục wait ở engine theo R-15. Trong `chooseRung` của `src/engine/escalation.ts`, hết thang thì
  `waitPolicy(ctx, 'ladder_exhausted', …)`, nấc bị từ chối thì `waitPolicy(ctx, 'rung_denied', …)`, không gọi
  `failWithDraft` nữa. Cập nhật các test mà #252 đã đổi theo hành vi FAILED:
  - `test/property/invariants/escalation.test.ts`;
  - `test/scenarios/us4-escalation.test.ts`;
  - `test/integration/runtime/execution-modes.test.ts`;
  - `test/scenarios/task-continue.test.ts`.
- [ ] T020 Thêm lệnh `task_fail`. Engine nhận trigger từ lệnh này, đòi quyền `operate` và chỉ nhận khi task đang
  WAITING, rồi gọi `failWithDraft(ctx, reason)` (`src/engine/interpreter.ts`, `src/domain/trigger.ts`). Phía ứng dụng:
  `src/application/commands.ts` khai `REQUIRED_ROLE` là `operate`; CLI `cusr task fail <id> --reason` ở `src/cli/tasks.ts`.
  Contract test ở `test/contract/cli/task-fail.test.ts`, gồm cả thiếu `--reason` (exit 2) và task không ở WAITING
  (exit 6) (FR-036).

**Checkpoint**: Có danh tính `deputy` với lý do và ID lượt; bảng định tuyến đủ mã; engine vào wait khi hết thang; có
lệnh kết thúc có lý do.

---

## Phase 3: User Story 2 — Deputy quyết ngân sách, deadline và model khi trần thử lại cạn (Priority: P1)

**Goal**: Mở rộng `continue` và `amend-policy` để một caller `operate` (deputy hoặc trợ lý) gỡ được mọi wait cạn trần.

**Independent Test**: Dùng caller giả lập deputy (dòng `running` từ T005, env `CUSR_DEPUTY_TURN`). Với task ở từng wait
của FR-030, gọi `continue`, `amend-policy --agent-runs`, `--deadline`, `--model` hoặc `task fail`. Kiểm tra event, actor
`deputy`, `reason` và `turn_id`, và không trần nào của task bị tính thêm.

### Tests for User Story 2 ⚠️

- [ ] T021 [P] [US2] Viết scenario `test/scenarios/deputy/us2.test.ts` cho acceptance 1–7 của US2:
  - `loop_exhausted` → `continue`;
  - `agent_runs_exhausted` → `amend-policy --agent-runs +N`;
  - `deadline` → `amend-policy --deadline`;
  - `backoff_exhausted` → `continue` mở chuỗi backoff mới;
  - `ci_wait_exhausted` → `continue` mở cửa sổ CI mới với độ dài đã đóng băng;
  - `ladder_exhausted` → `amend-policy --model` trong `allow_models`;
  - `task fail` → FAILED có lý do, slot được trả.

  Mỗi thao tác ghi actor `deputy` và lý do.
- [ ] T022 [P] [US2] Viết contract test `test/contract/cli/amend-policy-deputy.test.ts`:
  - `--agent-runs +N`, `--deadline <ISO|+duration>`, `--model` không bắt buộc khi đã có một trong hai;
  - `agent_runs_insufficient` chỉ gỡ được bằng `--agent-runs`;
  - `--confirm` chạy được với `operate`;
  - `allow_models` và `above: deny` vẫn chặn (FR-031, FR-033).

### Implementation for User Story 2

- [ ] T023 [US2] Mở rộng `CONTINUABLE` và `onContinue` trong `src/engine/continue.ts`, thêm `agent_runs_exhausted`,
  `deadline`, `backoff_exhausted`, `ci_wait_exhausted`:
  - `backoff_exhausted`: reset bộ đếm lỗi của lớp đó ở step;
  - `ci_wait_exhausted`: mở cửa sổ chờ CI mới với độ dài đã đóng băng;
  - `agent_runs_exhausted` và `deadline`: chỉ continue được sau khi `amend-policy` đã nới. Nếu chưa nới, từ chối với lý
    do rõ ràng.

  Sửa doc comment của `CONTINUABLE` cho khớp (FR-030, FR-032).
- [ ] T024 [US2] Thêm `--agent-runs +N` và `--deadline <ISO|+duration>` vào `src/application/amend-policy.ts` và
  `src/cli/tasks.ts`. `--model` không bắt buộc khi có một trong hai. Áp dụng ghi `PolicyAmended` kèm actor và lý do (I08).
  Engine (`src/engine/evolve.ts` và phần xử lý `PolicyAmended`) cộng ngân sách hoặc dời timer `deadline`, và gỡ
  `agent_runs_insufficient` chỉ khi có `agent_runs_delta` (FR-031).
- [ ] T025 [US2] Hạ `REQUIRED_ROLE.task_amend_policy` từ `admin` xuống `operate` trong `src/application/commands.ts`.
  Kiểm lại `src/daemon/task-control.ts` không còn đòi `admin` (FR-033).
- [ ] T026 [US2] Cập nhật `allowed_actions` của `cusr task explain` (`src/explain/`) để các wait mới gợi ý `continue`,
  `amend-policy --agent-runs/--deadline` và `task fail`.

**Checkpoint**: Mọi wait cạn trần có lệnh gỡ hoặc kết thúc mà một caller `operate` dùng được. Story 2 chạy với caller giả
lập.

---

## Phase 4: User Story 1 — Task kẹt về vận hành được gỡ mà không chờ chủ dự án (Priority: P1) 🎯 MVP

**Goal**: Component `deputy` của daemon chạy headless và thay decider: định tuyến sự cố, mở phiên, ghi lượt, chạy qua
runner, trả worktree về mốc, chuyển cho người khi cần, xử lý lỗi, nhận lại lượt sau restart.

**Independent Test**: Với fake harness, đưa task vào từng mã wait mà FR-001 định tuyến tới deputy. Deputy fake gọi
`continue` hoặc `approve`, task chạy tiếp và không có attention nào tới chủ dự án. Mã loại trừ thì attention tới chủ dự
án như hiện nay.

### Tests for User Story 1 ⚠️

- [ ] T027 [P] [US1] Viết scenario `test/scenarios/deputy/us1.test.ts` cho acceptance 1–4:
  1. `ladder_exhausted` đánh thức deputy, không đánh thức trợ lý (FR-005);
  2. deputy duyệt nâng nấc, approval ghi actor `deputy` và lý do;
  3. các mã bị loại trừ không đánh thức deputy;
  4. hết lượt mà task vẫn ở đúng wait thì `handed_off` và attention mang `final_message`.

  Thêm hai trường hợp: không có role `deputy` thì `ladder_exhausted` kết thúc bằng `task fail` với actor
  `system:deputy-absent`; có role nhưng deputy không khởi động được thì task không tự FAILED (FR-004).
- [ ] T028 [P] [US1] Viết property test `test/property/deputy/turn-state.test.ts` cho vòng đời lượt trong
  [data-model](data-model.md#vòng-đời-lượt):
  - chỉ có các chuyển trạng thái đã vẽ;
  - mọi chuyển sang `done`, `handed_off` hoặc `stopped` đều restore worktree trước;
  - không bao giờ có hai lượt `running` hoặc `retry_wait` cho cùng task.
- [ ] T029 [P] [US1] Viết contract test `test/contract/deputy/restore.test.ts` trên git thật. Deputy fake sửa file, xóa
  file, tạo file mới, `git commit`, và daemon restart giữa lượt. Sau mọi trường hợp, HEAD và cây worktree bằng đúng mốc;
  file ignored giữ nguyên (FR-053, SC-005).
- [ ] T030 [P] [US1] Viết integration test crash `test/integration/crash/deputy.test.ts`. Crash injection ở mọi điểm:
  trước khi ghi lượt, sau khi ghi lượt và trước spawn, trong lượt, sau `turn_ended` và trước restore, sau restore và
  trước `finishTurn`. Kỳ vọng không có lượt thứ hai cho cùng sự cố và không lặp lệnh ghi nào (SC-004).
- [ ] T031 [P] [US1] Viết integration test `test/integration/runtime/deputy-failures.test.ts` cho FR-024:
  - `rate_limited` chờ tới `reset_at`, sự cố vẫn thuộc deputy;
  - `auth`, `refused`, `capability_missing`, thiếu harness thì `handed_off` ngay, có lý do;
  - lỗi hạ tầng retry theo `limits.backoff.infra` của task, không có trần mặc định, chạm `infra_retries` đã khai thì
    `handed_off`;
  - không bộ đếm nào của task tăng (FR-025).
- [ ] T032 [P] [US1] Viết integration test `test/integration/runtime/deputy-upgrade.test.ts` cho FR-072 và SC-008:
  - bản ghi decider dở trong `recordsDir` được đóng bằng `decider_ran { apply: false, failure: 'superseded', invoked }`;
  - reservation được dùng hoặc trả tùy `invoked`;
  - `decider_start` mới bị từ chối;
  - `DeciderRan` cũ vẫn replay được;
  - config có `roles.decider` nạp được và có cảnh báo đổi tên.

### Implementation for User Story 1

- [ ] T033 [US1] Thêm `roles.deputy { binding, limits: { infra_retries?, wall_ms?, stall_ms? } }` vào
  `src/config/schema-user.ts`. `roles.decider` đọc như alias của `deputy` và có cảnh báo; khai cả hai thì báo lỗi. Bỏ
  ràng buộc "autonomous cần role decider" ở `src/config/checks.ts` (FR-071). Test ở
  `test/unit/config/deputy-role.test.ts`.
- [ ] T034 [US1] Thêm `src/daemon/deputy-prompt.ts`, dựng prompt của lượt bằng code theo thứ tự cố định của
  [hợp đồng lượt](contracts/deputy-turn.md#prompt-của-lượt):
  1. văn bản vai trò cố định (FR-035, FR-054);
  2. thông tin task;
  3. bản tóm tắt khi `seeded`;
  4. thao tác của actor khác kể từ lượt trước (FR-017);
  5. sự cố và `allowed_actions`.

  Prompt đi qua `Redactor`. Test snapshot ở `test/unit/daemon/deputy-prompt.test.ts`.
- [ ] T035 [US1] Thêm `src/daemon/deputy.ts` thay `src/daemon/decider.ts`, cùng khuôn `round()`/`holds()`/`version()`:
  - `round()` quét task WAITING, gọi `routeOf`; không có role `deputy` mà wait là cạn trần thì gửi `task_fail` với actor
    `system:deputy-absent` (R-11);
  - với sự cố tới deputy: mở `deputy_sessions` khi chưa có (FR-010); task đang có lượt thì sự cố mới chờ (FR-018);
  - ghi baseline `deputy-baseline-<turn_id>.json` bằng `WorktreeBaselineSchema` theo khuôn `reviewBaselineFile` trong
    `src/daemon/handlers.ts`, bỏ qua khi task chưa có worktree;
  - `startTurn` trước khi spawn;
  - gọi `HarnessPort.run` với `role: 'deputy'`, `session`, `env.CUSR_DEPUTY_TURN`, cwd là data dir và `view.title` là
    `deputy: <tiêu đề>`;
  - lượt không giữ reservation ngân sách.

  Phụ thuộc T010, T018, T020, T033, T034.
- [ ] T036 [US1] Xử lý sau lượt trong `src/daemon/deputy.ts` theo [hợp đồng lượt](contracts/deputy-turn.md#daemon-sau-lượt):
  1. gọi `restoreWorktree` (`src/adapters/git/restore.ts`);
  2. so `incident` với wait hiện tại: còn nguyên thì `handed_off` với `still_waiting` và `final_message` đã che secret,
     không thì `done`;
  3. ánh xạ lỗi theo R-12 và FR-024, đếm `infra_failures` trong bản ghi lượt;
  4. cập nhật `deputy_sessions.session_ref`.

  Restore thất bại thì ghi log và để bước worker kế tiếp vào `worktree_changed` như reviewer.
- [ ] T037 [US1] Thêm `adopt` và `recover` cho `src/daemon/deputy.ts`. Lúc khởi động, mọi lượt `running` được nhận lại qua
  `RunnerHarness.recover`, không bao giờ spawn lại. Lượt đã xong thì restore worktree rồi kết thúc như T036. Lượt
  `retry_wait` chạy lại khi tới `retry_at` (II, SC-004).
- [ ] T038 [US1] Đọc lại binding mỗi lần đánh thức (FR-016). Cùng harness thì resume `session_ref`. Khác harness hoặc
  phiên mất thì `session: null`, `seeded = 1`, và prompt có bản tóm tắt do code dựng từ lịch sử task và các quyết định
  deputy trước đó. Hàm dựng tóm tắt đặt ở `src/daemon/deputy-prompt.ts`.
- [ ] T039 [US1] Khi task kết thúc, dừng lượt đang chạy (`stopped`), restore worktree và `closeSession` (FR-019). Lệnh muộn
  của deputy bị từ chối vì lượt không còn `running` (T015).
- [ ] T040 [US1] Thay `DeciderWatch` bằng `DeputyWatch` trong `src/application/attention.ts`. Sự cố tới deputy không tạo
  attention, trừ khi lượt của nó là `handed_off`; khi đó attention kèm `final_message`. `version()` đổi khi cờ
  `autonomous` hoặc bản ghi lượt đổi, để attention tính lại (FR-005, R-04). Sửa inbox (`src/application/inbox.ts`) theo cùng
  quy tắc.
- [ ] T041 [US1] Cài settings của private home cho role `deputy` trong `src/runner/private-home.ts`. Harness hỗ trợ luật
  theo đường dẫn thì cấm `Edit`/`Write` trên `<data dir>/worktrees/**`. Chạy toàn quyền tool, không hỏi quyền (FR-053,
  FR-054). Hook của chủ dự án được giữ.
- [ ] T042 [US1] Đổi chỗ nối trong `src/daemon/production.ts` từ `createDecider` sang `createDeputy`. Lúc khởi động đầu tiên,
  đóng bản ghi decider dở theo R-13 rồi xóa `recordsDir`. Trong `src/domain/trigger.ts` và engine, `decider_start` từ
  chối mọi yêu cầu mới, `decider_ran` chỉ nhận cho attempt đã có reservation. `evolve` giữ nhánh `DeciderRan` để replay
  (FR-072). Xóa `src/daemon/decider.ts` sau khi T032 xanh.
- [ ] T043 [US1] Thêm kiểm tra deputy vào `cusr doctor` (`src/application/doctor.ts`): binding, harness, manifest và
  terminal backend, mỗi mục có trạng thái và gợi ý sửa (FR-073). Test ở `test/unit/application/doctor-deputy.test.ts`.

**Checkpoint**: Deputy headless gỡ được mọi sự cố vận hành, chuyển cho người đúng lúc, sống qua restart, không để lại
thay đổi trong worktree. Đây là MVP: lát A và B giao được mà chưa cần lượt tương tác.

---

## Phase 5: User Story 5 — Chủ dự án và deputy cùng thao tác trên một task (Priority: P2)

**Goal**: Thao tác của chủ dự án luôn thắng. Bản ghi lượt không bao giờ làm lệnh của chủ dự án bị từ chối.

**Independent Test**: Trong lúc deputy fake đang trong lượt, chủ dự án gửi một lệnh. Lệnh tiếp theo của deputy với
version cũ bị từ chối. Lệnh của chủ dự án không bị từ chối vì lượt bắt đầu hay kết thúc. Lần đánh thức sau, deputy thấy
thao tác của chủ dự án.

### Tests for User Story 5 ⚠️

- [ ] T044 [P] [US5] Viết scenario `test/scenarios/deputy/us5.test.ts` cho acceptance 1–3 và SC-006:
  - lệnh của deputy với version cũ bị từ chối `conflict`;
  - lệnh của chủ dự án với version vừa đọc không bị từ chối khi lượt bắt đầu hay kết thúc;
  - `task show` thấy `deputy: { turn_id, incident, state, started_at }`.

### Implementation for User Story 5

- [ ] T045 [US5] Thêm trường `deputy: { turn_id, incident, state, started_at } | null` vào view của `task show` và
  `task explain` (`src/application/queries.ts`, `src/explain/`, `src/cli/render.ts`), đọc từ `runningTurn` (FR-023).
- [ ] T046 [US5] Lọc thao tác cho FR-017 trong `src/daemon/deputy-prompt.ts`: lấy mọi event lệnh của task kể từ
  `started_at` của lượt trước, có actor khác deputy của chính task này. Mỗi dòng có thời điểm, actor, lệnh, lý do.
  Thêm trường hợp vào `test/unit/daemon/deputy-prompt.test.ts`.

**Checkpoint**: US1, US2 và US5 cùng chạy. Hai bên chạm cùng một task không làm hỏng nhau.

---

## Phase 6: User Story 3 — Câu hỏi về spec của worker theo cờ `autonomous` (Priority: P2)

**Goal**: Câu hỏi của worker tới deputy khi `autonomous` bật, tới chủ dự án khi tắt. Đổi cờ thì câu hỏi đang mở được
định tuyến lại. Giả định của deputy hiện trong mô tả PR.

**Independent Test**: Tạo `agent_question` khi `autonomous` tắt, rồi bật cờ. Kiểm tra câu hỏi được định tuyến lại tới
deputy, câu trả lời mang actor `deputy`, và mục giả định có trong thân PR ở lần publish kế tiếp.

### Tests for User Story 3 ⚠️

- [ ] T047 [P] [US3] Viết scenario `test/scenarios/deputy/us3.test.ts` cho acceptance 1–4:
  - cờ bật thì nhiều câu hỏi ở cùng step đều tới deputy;
  - cờ tắt thì câu hỏi tới chủ dự án, sự cố vận hành của cùng task vẫn tới deputy;
  - bật cờ giữa chừng thì câu hỏi đang mở được định tuyến lại, trừ câu đang trong lượt và câu đã `handed_off` (FR-003);
  - thân PR có mục giả định.

### Implementation for User Story 3

- [ ] T048 [US3] Bỏ quy tắc "sau một câu trả lời của decider, câu hỏi tiếp ở cùng step chờ người" và nhãn `grill` khỏi
  `src/engine/questions.ts` (FR-070). Xóa `WORKER_WAITS` khỏi đường đi mới; chỉ giữ những gì replay `DeciderRan` cần.
  Cập nhật các test của decider đang dựa vào quy tắc này.
- [ ] T049 [US3] Trong `src/daemon/deputy.ts`, đọc cờ `autonomous` lúc định tuyến (đọc lại mỗi 30 giây như
  `currentUser('autonomous')` trong `src/daemon/production.ts`). Đổi cờ thì định tuyến lại câu hỏi đang mở theo FR-003.
- [ ] T050 [US3] Thêm mục "Quyết định của deputy" vào hàm dựng thân PR trong `src/adapters/github/publish.ts`. Mục do code
  dựng, đặt trước marker block, liệt kê câu trả lời cho câu hỏi về spec, `amend-policy` và `continue` của actor `deputy`
  (FR-061, R-14). Probe so khớp toàn thân vẫn đúng. Contract test ở `test/contract/github/publish-deputy-section.test.ts`.

**Checkpoint**: Deputy trả lời câu hỏi về spec theo cờ; chủ dự án thấy giả định trong PR.

---

## Phase 7: User Story 4 — Nhờ deputy viết task và chọn agent (Priority: P2)

**Goal**: `task add --draft` tạo task chờ deputy viết. Deputy hoàn thiện bằng `task revise` và `task propose`. Chủ dự án
luôn là người xác nhận.

**Independent Test**: Tạo task bằng `task add --draft`. Kiểm tra deputy được đánh thức, task có mô tả và run config do
deputy đề xuất, task chờ xác nhận, và lệnh xác nhận từ deputy bị từ chối.

### Tests for User Story 4 ⚠️

- [ ] T051 [P] [US4] Viết scenario `test/scenarios/deputy/us4.test.ts` cho acceptance 1–4:
  - task nháp tới `needs_draft`, deputy `revise` rồi `propose`, task chờ xác nhận;
  - agent do chủ dự án chỉ định được giữ;
  - chủ dự án sửa trước khi xác nhận thì lần đánh thức sau deputy thấy bản đã sửa;
  - `task confirm` của deputy bị từ chối `forbidden` với `reason: 'deputy_confirm'`, exit 5.

  Thêm hai trường hợp theo FR-043 và FR-052: `intake.auto_confirm` có `assistant` không làm task nháp tự xác nhận; task do deputy tạo
  bằng `task add` thường vẫn chờ xác nhận.
- [ ] T052 [P] [US4] Viết contract test `test/contract/cli/task-revise.test.ts`: `task revise` sửa được tiêu đề, mô tả và
  acceptance trước khi policy đóng băng; sau đó trả `transition_not_allowed`, exit 6.

### Implementation for User Story 4

- [ ] T053 [US4] Hỗ trợ `draft: true` trong `task_add`:
  - triage đưa task vào PENDING `needs_draft`, không chạy preflight (`src/engine/intake.ts`, `src/application/triage.ts`);
  - `src/daemon/pending-preflight.ts` bỏ qua task ở `needs_draft`;
  - `routeOf` đưa `needs_draft` tới deputy, và phiên tạo lúc này là phiên của task về sau (FR-041, FR-044).

  CLI: `cusr task add --draft` ở `src/cli/tasks.ts`.
- [ ] T054 [US4] Thêm lệnh `operate` `task_revise` với payload `{ title?, description?, acceptance? }`, chỉ nhận trước khi
  policy đóng băng. Lệnh phát `TaskRevised` như `source_updated` trong `src/engine/intake.ts`, rồi đưa task qua triage
  như `task confirm` mà không xác nhận (FR-042, R-10). Phía ứng dụng ở `src/application/commands.ts`,
  `src/application/queries.ts`; CLI `cusr task revise` ở `src/cli/tasks.ts`.
- [ ] T055 [US4] `admitCommand` từ chối `task_confirm` và mọi lệnh xác nhận run config khi actor là `deputy`, trên mọi
  task, với `forbidden` và `reason: 'deputy_confirm'` (FR-043).
- [ ] T056 [US4] Đặt requester kind `deputy` cho task deputy tạo (`buildNewTask` trong `src/application/queries.ts`). Áp
  dụng chặn `intake.auto_confirm` theo R-15:
  - `taskAdd` không đặt `intake_auto_confirm` khi `draft: true` hoặc requester kind là `deputy`;
  - `src/config/validate.ts` báo lỗi khi `intake.auto_confirm` có `deputy` (FR-052).

**Checkpoint**: Trợ lý nhờ deputy viết task được. Không đường nào cho task chạy mà chủ dự án chưa xác nhận.

---

## Phase 8: User Story 6 — Xem deputy đã làm gì (Priority: P3)

**Goal**: Quyết định của deputy hiện ở `decisions.md`, `cusr report`, chi tiết task và lịch sử (lát E). Chủ dự án xem
và gõ được vào phiên tương tác của deputy trong terminal backend (lát C, hoàn tất FR-012–FR-014).

**Independent Test**: Sau một loạt quyết định của deputy fake, `decisions.md`, `cusr report` và chi tiết task đều cho
thấy chúng, mỗi quyết định gắn với sự cố qua `turn_id`. Có tmux thì cửa sổ `deputy: <tiêu đề>` xuất hiện và tự đóng khi
hết lượt.

### Tests for User Story 6 ⚠️

- [ ] T057 [P] [US6] Viết scenario `test/scenarios/deputy/us6.test.ts` cho acceptance 1 và SC-007. Mỗi quyết định có
  `at`, `task_id`, `incident`, `kind`, `reason`, `turn_id` trong `report` và `decisions.md`. Câu trả lời `agent:decider`
  cũ vẫn hiện.
- [ ] T058 [P] [US6] Viết contract test `test/contract/deputy/turn-end-hook.test.ts`, dùng script giả lập harness tương
  tác:
  - hook ghi `turn-ended.json` thì runner gửi TERM sau `term_grace_ms` và trả `turn_ended` có `final_message`;
  - `recover` đọc lại file mà không spawn lại;
  - hook của chủ dự án trong settings vẫn chạy.
- [ ] T059 [P] [US6] Viết contract test `test/contract/deputy/stall.test.ts`. Phiên tương tác không ghi `turn-ended.json`
  và không có hoạt động trong `stall_ms` thì process bị dừng, rồi cùng `session_ref` chạy headless cho cùng sự cố, không
  có lượt thứ hai (FR-014, SC-003). Thêm trường hợp không có terminal backend: chạy headless ngay từ đầu.

### Implementation for User Story 6 — ghi nhận (lát E)

- [ ] T060 [US6] Dựng `decisions.md` từ event có actor `deputy` join `deputy_turns` qua `turn_id`. Chuyển logic rewrite
  `decisions.md` từ `src/daemon/decider.ts` sang module dùng chung, ví dụ `src/application/decisions.ts`. Giữ các mục
  `agent:decider` cũ (FR-060).
- [ ] T061 [US6] Thay `decider_answers` bằng `deputy_decisions` trong `src/application/report.ts` và `src/cli/report.ts`,
  vẫn đưa cả `agent:decider` cũ vào (FR-060).
- [ ] T062 [US6] Hiện `reason` và `turn_id` của mỗi lệnh trong lịch sử task (`cusr task show --history`, `src/cli/render.ts`).

### Implementation for User Story 6 — lượt tương tác (lát C)

- [ ] T063 [US6] Thêm `interactiveArgv(input)` vào adapter harness theo kết luận của T002:
  - Claude (`src/adapters/harness/claude.ts`): `claude --resume <session> [--model …] "<prompt>"`, không có `-p`;
  - Codex (`src/adapters/harness/codex.ts`): `codex resume <session> "<prompt>"`.

  Harness không có argv tương tác (pi, fake) trả `null`.
- [ ] T064 [US6] Cài hook hết lượt trong `src/runner/private-home.ts`, gộp với hook của chủ dự án, không thay thế:
  - Claude: hook Stop;
  - Codex: `notify`.

  Hook ghi `<run dir>/turn-ended.json` dạng `{ turn_id, final_message|null }` và lấy tin nhắn cuối từ nguồn đã chốt ở T002
  (FR-013).
- [ ] T065 [US6] Thêm chế độ tương tác trong `src/runner/invocation.ts`:
  - chạy dưới terminal backend (`src/runner/terminal-host.ts`) khi `input.interactive`;
  - theo dõi `turn-ended.json` như file kết quả, gửi TERM sau `term_grace_ms`, finalize run dir, trả `turn_ended`;
  - headless trả `turn_ended` với tin nhắn cuối lấy từ stream;
  - `recover` đọc lại `turn-ended.json`.

  T058 phải xanh.
- [ ] T066 [US6] Chọn chế độ trong `src/daemon/deputy.ts`: `interactive` khi terminal backend khả dụng và adapter có
  `interactiveArgv`, ghi `mode` vào bản ghi lượt. Stall ở chế độ tương tác thì chạy lại cùng sự cố ở chế độ headless với
  cùng `session_ref`. Lượt headless treo được coi là lỗi hạ tầng (FR-024c). T059 phải xanh.

**Checkpoint**: Chủ dự án đọc được mọi quyết định của deputy ở những chỗ quen dùng, và xem được phiên đang chạy.

---

## Phase 9: Polish & Cross-Cutting Concerns — đồng bộ tài liệu và smoke (lát F)

**Purpose**: Đồng bộ tài liệu vận hành với hành vi đã có, kiểm bằng harness thật, và lập acceptance report.

- [ ] T067 [P] Đồng bộ `SPEC.md` theo danh sách ở cuối [spec](spec.md#tác-động-lên-hiến-chương-và-spec):
  - §4 (I09);
  - §9.3 và §15.1: `amend-policy` thành `operate`, `task revise`, `task add --draft`, `task fail`, `--reason`,
    `continue`/`amend-policy` mở rộng, dòng `cusr report`;
  - §10: câu "không agent nào tự quyết thay" và đoạn Autonomous;
  - §14.1: "scout và decider chỉ đọc";
  - §15.2: actor `deputy`, mốc và trả về worktree như reviewer.
- [ ] T068 [P] Sửa mục Autonomous trong `deploy/README.md`: bỏ dòng mỗi lượt giữ một reservation của
  `budget.agent_runs`, thêm role `deputy` cùng limits `infra_retries`, `wall_ms`, `stall_ms`, ghi alias `decider`.
- [ ] T069 [P] Sửa câu về decider trong `docs/adr/0005-native-harness-permissions.md`. Thêm
  `docs/adr/0012-deputy-interactive-turn.md` cho phiên tương tác của role deputy: hook hết lượt, dừng process, stall sang
  headless, mốc và trả về worktree.
- [ ] T070 [P] Đổi decider → deputy trong `GLOSSARY.md`, sửa đoạn `cusr report` trong `docs/architecture.md`.
- [ ] T071 [P] Sửa `specs/003-telegram-channel/spec.md`:
  - không push khi deputy đang giữ sự cố thuộc FR-001;
  - `/inbox` hiện "deputy đang xử lý";
  - chuyển sự cố cho người thì push kèm tin nhắn cuối;
  - thay các quy tắc riêng của decider bằng FR-003 và FR-021 của spec này.
- [ ] T072 [P] Cập nhật skill `skills/cusr/SKILL.md`:
  - `--reason`;
  - `task add --draft`, `task revise`, `task fail`;
  - `amend-policy --agent-runs/--deadline` với quyền `operate`;
  - cách đọc trường `deputy` của `task show`;
  - trợ lý không gỡ sự cố đang có lượt deputy.
- [ ] T073 Thêm smoke `test/smoke/deputy.smoke.test.ts` với harness thật, theo [quickstart](quickstart.md):
  1. task vào `ladder_exhausted`, deputy gỡ;
  2. deputy kết thúc lượt mà không làm gì, sự cố chuyển cho chủ dự án kèm tin nhắn cuối;
  3. tắt tmux, lượt chạy headless;
  4. phiên treo, task tiếp tục chậm nhất 1 phút sau `stall_ms` (SC-003).

  Chỉ chạy tay, tốn usage.
- [ ] T074 Chạy một đêm thật với ít nhất 5 task đã xác nhận để kiểm SC-002. Ghi kết quả vào
  `specs/007-deputy/acceptance-report.md`, cùng bằng chứng cho SC-001–SC-008 theo tầng. SC nào chưa chạy thì ghi "chưa
  đạt".
- [ ] T075 Chạy mọi kịch bản fake trong `specs/007-deputy/quickstart.md`, sửa đường dẫn test trong đó cho khớp với file
  thật, và tick `specs/007-deputy/checklists/requirements.md`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1:**
  - T002 chặn T063–T066;
  - T001 và T003 đã xong trong PR #253.
- **Phase 2:** phụ thuộc Phase 1 và chặn mọi story. Thứ tự trong phase:
  - T009 → T010 → T015;
  - T011 → T018 → T019;
  - T013 → T014 → T015 → T017.
- **Phase 3 (US2):** phụ thuộc Phase 2. Không cần `deputy.ts`; dùng caller giả lập của T005.
- **Phase 4 (US1, MVP):** phụ thuộc Phase 2. T035 cần T020 để đi nhánh `system:deputy-absent`. Scenario T027 cần lệnh
  của Phase 3 để deputy fake gỡ được `ladder_exhausted`.
- **Phase 5 (US5)** và **Phase 6 (US3):** phụ thuộc Phase 4 (`deputy.ts`). Hai phase làm song song được.
- **Phase 7 (US4):** phụ thuộc Phase 4 vì deputy phải được đánh thức ở `needs_draft`. Làm song song được với Phase 5 và
  Phase 6.
- **Phase 8 (US6):** phần ghi nhận (T060–T062) phụ thuộc Phase 4. Phần tương tác (T063–T066) phụ thuộc Phase 4 và T002.
- **Phase 9:** T067–T072 sau khi hành vi tương ứng đã merge. T073–T075 sau mọi phase.

### Within Each Story

- Test viết trước, thấy đỏ rồi mới triển khai.
- Thứ tự: domain/store → engine → application/CLI → daemon → adapter.
- Story xong, checkpoint xanh, rồi mới mở PR của phase.

### Parallel Opportunities

- Phase 1: T004 ‖ T005.
- Phase 2: T006 ‖ T007 ‖ T008 (test); T011 ‖ T012 ‖ T016.
- Phase 3: T021 ‖ T022.
- Phase 4: T027 ‖ T028 ‖ T029 ‖ T030 ‖ T031 ‖ T032; T033 ‖ T034 ‖ T041 ‖ T043.
- Sau Phase 4: Phase 5 ‖ Phase 6 ‖ Phase 7 ‖ phần ghi nhận của Phase 8.
- Phase 9: T067–T072 song song.

## Parallel Example: User Story 1

```text
# Viết test cùng lúc (khác file):
T027 test/scenarios/deputy/us1.test.ts
T028 test/property/deputy/turn-state.test.ts
T029 test/contract/deputy/restore.test.ts
T030 test/integration/crash/deputy.test.ts
T031 test/integration/runtime/deputy-failures.test.ts
T032 test/integration/runtime/deputy-upgrade.test.ts

# Rồi các phần độc lập với deputy.ts:
T033 src/config/schema-user.ts, src/config/checks.ts
T034 src/daemon/deputy-prompt.ts
T041 src/runner/private-home.ts
T043 src/application/doctor.ts
```

## Implementation Strategy

### MVP

Phase 1 → Phase 2 → Phase 3 (US2) → Phase 4 (US1), tức lát 0, A và B ở chế độ headless. Lúc này deputy đã gỡ được mọi
sự cố vận hành qua đêm, đúng lý do tồn tại của feature. Dừng lại kiểm SC-001, SC-004, SC-005, SC-008 rồi mới làm tiếp.

### Incremental Delivery

1. Lát A (Phase 2 và 3): lệnh và danh tính. Trợ lý dùng được ngay các lệnh `continue`/`amend-policy` mở rộng và
   `task fail`, kể cả khi chưa có deputy.
2. Lát B (Phase 4): deputy headless thay decider (MVP).
3. US5 và US3 (Phase 5 và 6): owner thắng, câu hỏi về spec.
4. Lát D (Phase 7): task nháp.
5. Lát C và E (Phase 8): lượt tương tác, ghi nhận.
6. Lát F (Phase 9): tài liệu, smoke, acceptance report.

## Notes

- Không bao giờ đưa bản ghi lượt vào event log của task. Mọi test chạm `deputy_*` phải kiểm thêm rằng `version` không
  đổi.
- Deputy không merge, không bật yolo, không nhận PR có sẵn, không xác nhận task. Daemon chặn những việc này, không chỉ
  văn bản vai trò.
- Tên `deputy` là tên tạm; đổi tên thì đổi trước Phase 2.
