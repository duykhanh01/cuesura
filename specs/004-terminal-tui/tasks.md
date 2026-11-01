# Tasks: Giao diện tương tác trong terminal cho `cusr`

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Trạng thái**: Backlog tạo ngày 2026-11-01. Phase 1, Phase 2 và Phase 3 (T001–T039) đã xong; checkpoint US1 đạt trên Unix socket thật, kết quả ở [báo cáo nghiệm thu](acceptance-report.md#us1-t031t039). Phase 4 (T040–T048) đã xong và đạt checkpoint trên Unix socket thật, xem [báo cáo nghiệm thu](acceptance-report.md#us2-t040t048). Từ Phase 5 trở đi chưa làm. Phạm vi là mốc nghiệm thu đầu US1–US5; US6 thuộc [mốc sau](#mốc-sau-us6).

**Tests**: Spec yêu cầu mọi tiêu chí được kiểm trong terminal thật hoặc pseudo-terminal với daemon thật, và hiến chương nguyên tắc VII yêu cầu bằng chứng theo tầng, nên test là bắt buộc. Viết test trước, thấy nó thất bại rồi mới triển khai. Test reducer và view thuần chỉ để hồi quy, không dùng để tuyên bố đạt SC.

**Organization**: Theo user story và thứ tự giao trong plan: lát 0 → A → US1 → US2, US3 → US4 → US5 → nghiệm thu. Phần chỉ đọc (US1–US3) giao được trước nhưng chưa đạt mốc đầu. Task đã được chỉnh sau phân tích chéo ngày 2026-11-01 và đánh số lại.

## Format: `[ID] [P?] [Story] Description`

- `[P]`: làm đồng thời được sau prerequisite chung, vì khác file và không phụ thuộc task chưa xong.
- `[USn]`: task thuộc user story, chỉ dùng trong phase story.
- Source tại `src/`, test tại `test/` (không phải `tests/`). Một package Node 24.22.1, TypeScript strict, ESM.
- `src/tui/` không import `src/store`, `src/engine`, `src/daemon`. Không sửa test CLI hiện có (SC-006). Không có thao tác merge, yolo, retry, amend-policy (FR-023).
- Mỗi PR có code chạy `pnpm typecheck`, `pnpm lint`, `pnpm test` và `pnpm build`. Test trong `test/reliability/` chạy riêng bằng `pnpm test:reliability`. Mọi chuỗi trên giao diện là tiếng Anh.

## Phase 1: Setup — lát 0, chứng minh terminal và PTY

**Purpose**: Chứng minh cài được công cụ kiểm thử và khôi phục được terminal trước khi xây giao diện.

- [X] T001 Thêm dependency với phiên bản ghim chính xác vào `package.json` và `pnpm-lock.yaml`: runtime `string-width` 8.3.0; dev `node-pty` 1.1.0 và `@xterm/headless` 6.0.0. Kiểm `pnpm install --frozen-lockfile` sạch trên Node 24.22.1; nếu `node-pty` cần cho phép build script thì cấu hình và ghi lại lý do.
- [X] T002 Tạo PTY harness tại `test/support/pty.ts` theo [R-04](research.md#r-04--kiểm-thử-trong-pseudo-terminal): chạy `src/cli/cusr.ts` qua `node-pty`, đưa output vào `@xterm/headless`; có `screenText()`, `cell(x, y)`, `send(keys)`, `resize(cols, rows)`, `waitFor(predicate, timeoutMs)`, chụp `stty -g`, và sinh phím theo seed. Nếu `node-pty` không chạy được thì đổi sang helper Python `pty`, ghi vào `specs/004-terminal-tui/research.md`.
- [X] T003 Viết test PTY trước tại `test/contract/tui/terminal-restore.test.ts` với chương trình thử `test/fixtures/tui/terminal-probe.ts`: so `stty -g`, alternate screen, con trỏ và bracketed paste trước và sau khi thoát thường, Ctrl-C, SIGTERM, SIGHUP, lỗi nội bộ, lỗi ghi stdout; SIGCONT vẽ lại. Đây là phần terminal của SC-011.
- [X] T004 Triển khai lõi terminal tại `src/tui/terminal/terminal.ts` theo [R-12](research.md#r-12--terminal-và-đường-thoát): raw mode, alternate screen, ẩn con trỏ, bracketed paste, không bật chuột; một hàm khôi phục chạy một lần bằng `fs.writeSync`, gọi từ `SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException`, `unhandledRejection` và lỗi ghi stdout; `SIGCONT` vào lại alternate screen và vẽ lại toàn bộ.
- [X] T005 Tạo `specs/004-terminal-tui/acceptance-report.md`, ghi host, phiên bản, lệnh và kết quả thật của T001–T004. Chỉ qua lát 0 khi test T003 đạt.

**Checkpoint 0**: T005 ghi đạt là điều kiện để làm Phase 2.

---

## Phase 2: Foundational — lát A và khung giao diện

**Purpose**: Các đường đọc của [hợp đồng CLI/daemon](contracts/cli-daemon.md) và khung giao diện mà mọi story cần. Test CLI hiện có phải đạt mà không sửa.

**⚠️ CRITICAL**: Không làm story nào trước khi phase này xong.

### Đường đọc daemon và CLI

- [X] T006 [P] Thêm bảng `Record<DetailCode, boolean>` và hàm `needsUser(state)` tại `src/explain/needs-user.ts` theo [data model](data-model.md#nhóm-cần-bạn-xử-lý); test từng dòng, gồm `READY` chưa xác nhận cấu hình và task đã kết thúc, tại `test/unit/explain/needs-user.test.ts` (FR-007).
- [X] T007 Thêm migration `src/store/migrations/004_command_project.sql` (`command_ledger.project TEXT`, backfill từ `tasks` khi có task, không có thì giữ `NULL`), đăng ký trong `src/store/migrate.ts`; `admitCommand` ở `src/store/commands.ts` và `src/application/commands.ts` ghi `project` ở lần nhận đầu mà không đổi `command_hash`. Test tại `test/integration/runtime/migration.test.ts` và `test/integration/application/commands.test.ts`.
- [X] T008 Viết test trước tại `test/integration/runtime/request-show.test.ts`, rồi triển khai `request_show` tại `src/application/requests.ts`, đăng ký trong `src/daemon/main.ts` để đọc `inFlight`, thêm `request_not_found` vào `MISSING` ở `src/cli/errors.ts` (R-08, FR-041–FR-043). Phủ: `completed` thành công và bị từ chối; `in_progress`; `interrupted`; daemon chết trước khi ghi task (`CUSR_CRASH_AT=before_commit`) và sau khi ghi task nhưng trước khi lưu kết quả (`after_commit`); ID cấp sẵn của `task_add` chưa tạo task không được trả; actor khác, project ngoài phạm vi và hàng không xác định được project với token `limited` phản hồi giống hệt ID không tồn tại; số task, event, attempt không đổi sau khi tra.
- [X] T009 Thêm lệnh `cusr request show REQUEST_ID` tại `src/cli/requests.ts`, đăng ký trong `src/cli/commands.ts`. Test tại `test/contract/cli/request-show.test.ts`: `--json`, exit 0 kể cả khi thao tác bị từ chối, exit 4 khi không tìm thấy, `next_step` của `interrupted`.
- [X] T010 Viết test trước tại `test/integration/runtime/project-list.test.ts`, rồi triển khai `project_list` tại `src/application/projects.ts`, nối trong `src/daemon/task-control.ts` và `src/daemon/production.ts`: trả `caller` (`actor`, `roles`, `scope` là `all` hoặc `limited`, `trusted_confirmer` do daemon tính) project trong phạm vi token, và tên profile trong user config để form tạo task liệt kê; không trả token, đường dẫn token, `credential_refs`, `tool_paths` (FR-005, EC-009).
- [X] T011 Viết test trước tại `test/integration/runtime/run-options.test.ts`, rồi triển khai `run_options` tại `src/application/run-options.ts` và nối trong `src/daemon/production.ts` theo [R-07](research.md#r-07--nguồn-của-run_options): nhận `task_id`; đọc user config và `cusr.yaml` từ ref base có sẵn bằng hàm đọc của preflight, không `fetch`; profile là `task.profile ?? project.profile`; tính tối đa 64 tổ hợp bằng `freezePolicy` và `checkSelection`; lỗi `config_invalid`, `options_unavailable`, `conflict` với task đã bắt đầu. Property test tại `test/property/run-options.test.ts`: mọi lựa chọn trả về đều qua `checkSelection`, kể cả binding có `when` và coder, fixer khác nhau. Sửa comment "cusrd never reads the guidance" ở `src/config/schema-user.ts` (FR-025).
- [X] T012 Thêm lệnh `cusr project list` tại `src/cli/projects.ts`, đăng ký trong `src/cli/commands.ts`. Test tại `test/contract/cli/projects.test.ts`.
- [X] T013 Viết test trước tại `test/integration/runtime/task-board.test.ts`, rồi triển khai `task_board` tại `src/application/board.ts`, thêm truy vấn đếm theo SQL, độ dài hàng đợi và `MAX(global_seq)` vào `src/store/read.ts` và `src/store/index.ts`: `if_changed_since` trả `unchanged`; `scope` mặc định `active`; `limit` tối đa 100; `attention.items` tối đa 200; `counts` không theo trang (EC-005); đếm bằng SQL, chỉ đọc `state_json` của task đã kết thúc khi chúng nằm trong trang đang xem. Test gọi application service trên store thật; đường qua daemon kiểm ở T017 (FR-006, FR-007, FR-008).
- [X] T014 Thêm `status_since` vào `src/application/board.ts` theo [R-06](research.md#r-06--status_since): lấy `now` của trigger từ event mới nhất làm đổi status, nhớ theo `(task_id, version)`, không xác định được thì `null`. Test trong `test/integration/runtime/task-board.test.ts` với daemon restart và task từ log cũ.
- [X] T015 Viết test trước tại `test/integration/runtime/task-progress.test.ts`, gọi application service trên store thật, rồi triển khai `task_progress` tại `src/application/progress.ts` theo [data model](data-model.md#tiến-trình-bước): `past`, `current`, `remaining`, `not_required`; `steps: null` kèm `reason: not_frozen` khi chưa đóng băng; `review` của `direct-pr` là `not_required`; `needs_user`; `worktree_path` chỉ khác `null` khi wait là `worktree_changed` (FR-011, FR-022).
- [X] T016 Viết test trước tại `test/integration/runtime/task-content.test.ts`, gọi application service trên store thật, rồi thêm `task_content` vào `src/application/queries.ts` theo [R-09](research.md#r-09--task_content): đọc một lần, trả `intake_pending` là `needs_confirmation && !confirmed`, `run_config` có thể `null`; task ngoài phạm vi trả `task_not_found` (FR-026).
- [X] T017 Thêm `cusr task board`, `cusr task content`, `cusr task progress`, `cusr task options` vào `src/cli/tasks.ts`, đăng ký trong `src/cli/commands.ts`, nối query trong `src/daemon/task-control.ts`. Test qua daemon thật tại `test/contract/cli/task-reads.test.ts`, gồm exit code của từng lỗi `run_options`.
- [X] T018 [P] Thêm `attempt_id` vào bản ghi và `gap`, thêm tham số lọc `attempt_id` vào `src/application/logs.ts`, cờ `--attempt` vào `src/cli/logs.ts`; cursor giữ là cursor chung, giữ `LOG_PAGE_RECORDS = 200` và giới hạn 1 MiB. Test tại `test/integration/runtime/task-logs-attempt.test.ts` (FR-014).
- [X] T019 Chạy toàn bộ test hiện có, xác nhận không phải sửa test CLI cũ bằng `git diff --stat -- test/contract/cli/unavailable-command.test.ts test/integration/runtime/feature-002-cli.test.ts test/integration/runtime/access-control.test.ts`; ghi kết quả SC-006 tạm thời vào `specs/004-terminal-tui/acceptance-report.md`. Thêm `attempt_id` mà làm test cũ hỏng thì đổi thiết kế, không sửa test (FR-040).

### Khung giao diện

- [X] T020 [P] Tạo proxy socket cho test tại `test/support/control-proxy.ts`: nghe ở `control.sock` của một data dir riêng và chuyển tới daemon thật; có chế độ chuyển thẳng, giữ kết nối không trả lời, và chuyển yêu cầu nhưng bỏ phản hồi. Không thêm hook nào vào mã chạy thật. Test tại `test/unit/support/control-proxy.test.ts`.
- [X] T021 [P] Thêm rule `no-restricted-imports` cho `src/tui/**` tại `eslint.config.js`: cấm `src/store`, `src/engine`, `src/daemon`, `better-sqlite3`, kèm test cấu hình ở `test/unit/tui/import-boundary.test.ts` (FR-036).
- [X] T022 [P] Triển khai `SafeText` và `sanitize()` tại `src/tui/terminal/safe-text.ts` theo [R-13](research.md#r-13--sanitize): thay C0, C1, DEL và `U+202A`–`U+202E`, `U+2066`–`U+2069` bằng ký hiệu nhìn thấy được; giữ ZWJ, ZWNJ và dấu kết hợp; tab thành khoảng trắng. Test tại `test/unit/tui/safe-text.test.ts` (FR-037, EC-001).
- [X] T023 [P] Triển khai đo và cắt theo độ rộng tại `src/tui/terminal/width.ts` bằng `string-width`, cắt theo grapheme với `…`. Test tiếng Việt, CJK, emoji tại `test/unit/tui/width.test.ts` (EC-004).
- [X] T024 [P] Triển khai bộ giải mã phím tại `src/tui/terminal/keys.ts`: phím mũi tên, `PgUp`, `PgDn`, `Shift-Tab`, Esc đứng riêng, Ctrl-S, Ctrl-C, bracketed paste thành một khối văn bản. Fuzz không ném lỗi tại `test/unit/tui/keys.test.ts`.
- [X] T025 [P] Triển khai cell buffer và diff tại `src/tui/terminal/screen.ts`: hàm vẽ chỉ nhận `SafeText`, ghi theo dòng thay đổi, vẽ lại toàn bộ khi đổi kích thước; màu tắt khi có `NO_COLOR`. Test tại `test/unit/tui/screen.test.ts` (FR-035, EC-003).
- [X] T026 Khai báo schema Zod cho mọi phản hồi tại `src/tui/client/schemas.ts` và daemon port tại `src/tui/client/daemon-port.ts`, dùng lại `callDaemon`, `resolveDataDir`, `readClientToken`; schema không khớp thành lỗi `incompatible`, chuỗi từ daemon đi qua `sanitize()`. Test tại `test/unit/tui/daemon-port.test.ts` (FR-003, EC-010).
- [X] T027 Khai báo `state`, `messages`, `effects` và reducer thuần tại `src/tui/model/state.ts`, `src/tui/model/messages.ts`, `src/tui/model/reduce.ts`, gồm `connection` theo [data model](data-model.md#phiên-giao-diện): `connecting`, `online`, `reconnecting{attempt}`, `waiting_retry`, `stopped{reason}`. Test chuyển trạng thái tại `test/unit/tui/connection.test.ts`.
- [X] T028 Triển khai bộ lập lịch tại `src/tui/client/refresh.ts` với clock tiêm vào, theo bảng [R-03](research.md#r-03--làm-mới-và-kết-nối-lại): board và health mỗi 1 giây, timeout đọc 2 giây; các đọc khác timeout 3 giây, `run_options` 5 giây; lượt kết nối lại thành công chỉ tính board và health; backoff "gấp đôi từ 250 ms, trần 5 giây, không có jitter"; 30 lượt mỗi vòng; mỗi lượt là một lần đọc thật, không có probe riêng; lỗi không tự hết thì dừng ngay. Test tại `test/unit/tui/refresh.test.ts` (FR-009, FR-039).
- [X] T029 Triển khai vòng lặp tại `src/tui/main.ts` và thành phần dùng chung tại `src/tui/views/layout.ts`: thanh trạng thái, banner dữ liệu cũ, thanh gợi ý phím, vùng cuộn, màn "cần mở rộng" dưới 80×24. Giữ vị trí khi đổi kích thước (EC-002).
- [X] T030 Rẽ nhánh tại `src/cli/cusr.ts` theo [R-14](research.md#r-14--terminal-không-đủ-khả-năng): chỉ mở giao diện khi `argv` rỗng, stdin và stdout đều là TTY, `TERM` có giá trị và khác `dumb`; nạp `src/tui/main.ts` bằng `import()` động. Test tại `test/contract/cli/no-tty.test.ts`: pipe, `--json`, `--help`, `--version`, `TERM=dumb` giữ nguyên output và exit code, không có ANSI (FR-001, FR-002).

**Checkpoint A**: Đường đọc đạt qua CLI với daemon thật; `cusr` mở khung giao diện trong PTY và thoát sạch.

---

## Phase 3: User Story 1 - Nhìn một màn hình là hiểu hệ thống (Priority: P1)

**Goal**: Gõ `cusr` là thấy project, sức khỏe daemon, slot, hàng đợi, nhóm việc cần xử lý và task, tự cập nhật.

**Independent Test**: Với daemon thật và harness giả lập, tạo task ở mọi trạng thái bằng CLI, mở `cusr` trong PTY, đối chiếu màn hình với `task list` và `task explain`.

### Tests for User Story 1

- [X] T031 [P] [US1] Test PTY tại `test/contract/tui/us1-home.test.ts`: kịch bản US1 số 1, 2, 3, 5, 9; SC-002 với 100 task; đo thời gian đọc board so với timeout 2 giây; EC-005 hơn 100 task, số đếm không theo trang; EC-009 ghi chú phạm vi token; EC-013 giữ lựa chọn theo task khi sắp xếp lại; đổi bộ lọc khi không có event mới vẫn hiện đúng dữ liệu của bộ lọc mới.
- [X] T032 [P] [US1] Test PTY tại `test/contract/tui/us1-live.test.ts`: US1 số 4, 6, 7, 10; SC-003 gồm đổi trạng thái trong 3 giây, daemon sẵn sàng lại trong cửa sổ tự thử, và proxy T020 giữ kết nối không trả lời rồi chuyển sang daemon thật, đo đủ 10 giây; SC-011 phần daemon chết: giao diện vẫn mở, hiện mất kết nối; EC-007, EC-008, EC-010.
- [X] T033 [P] [US1] Test PTY ngắn tại `test/contract/tui/us1-idle.test.ts`: phiên rảnh 30 giây tạo 0 event, 0 command và không chiếm slot; poll trả `unchanged`. Đây là kiểm tra sớm, không tuyên bố đạt SC-009.
- [X] T034 [P] [US1] Test thời gian thật tại `test/reliability/tui/reconnect-window.test.ts`: SC-003 phần hết 30 lượt, không tự kết nối lại, giữ nội dung đang nhập, `Retry connection` có dữ liệu trong 10 giây.

### Implementation for User Story 1

- [X] T035 [P] [US1] Dựng mô tả hoạt động từ `status`, `wait_code`, `step`, `mode` tại `src/tui/model/activity.ts`; mã chưa có trong bảng hiện nguyên mã, không đoán. Test tại `test/unit/tui/activity.test.ts` phủ mọi `DetailCode` (FR-006).
- [X] T036 [US1] Dựng màn Home tại `src/tui/views/home.ts`: thanh daemon, slot, hàng đợi và thời điểm cập nhật cuối; nhóm `Needs you` với việc cần làm và số lượng; danh sách có thời gian ở trạng thái, `status_since` là `null` thì ghi "unavailable"; task đã kết thúc thu gọn và mở ra được (FR-005, FR-006, FR-007, FR-010, EC-005).
- [X] T037 [US1] Thêm lọc project và status cùng phân trang tại `src/tui/model/reduce.ts` và `src/tui/views/filters.ts`: mỗi lần mở bắt đầu không lọc; bộ lọc project đang áp dụng luôn hiện; đổi `project`, `status`, `scope`, `limit` hoặc `cursor` thì bỏ `watermark` (FR-008).
- [X] T038 [US1] Nối làm mới, watermark, dữ liệu cũ, banner `Reconnecting (n/30)`, `Retry connection` và các lỗi dừng tại `src/tui/main.ts` và `src/tui/views/disconnected.ts`; đọc không tạo mutation (FR-009, FR-010, FR-021, EC-007, EC-008).
- [X] T039 [US1] Thêm thông báo cho terminal không có màu, chữ ký hiệu trạng thái và ghi chú token giới hạn tại `src/tui/views/home.ts` và `src/tui/model/activity.ts` (FR-035, EC-003, EC-009).

**Checkpoint**: US1 đạt T031, T032, T033, T034; thoát giao diện không ảnh hưởng task và daemon (FR-004). Chưa đạt, xem dòng Trạng thái đầu file.

---

## Phase 4: User Story 2 - Xem vì sao task ở trạng thái đó (Priority: P1)

**Goal**: Chọn task để thấy tiến trình, lý do chờ, lối ra, attempt, log trực tiếp, PR và bằng chứng.

**Independent Test**: Duyệt bộ task mẫu phủ mọi reason và detail của FR-029 feature 002, đối chiếu màn chi tiết với `task explain`, `task show`, `task history`, `task logs`.

### Tests for User Story 2

- [X] T040 [P] [US2] Test PTY tại `test/contract/tui/us2-detail.test.ts`: US2 số 1, 2, 3, 5, 6, 7, 8; SC-001 đối chiếu `task explain` ở 100% mẫu; `review` của `direct-pr` không hiện như đã đạt; usage thiếu ghi `unavailable`, không ghi 0.
- [X] T041 [P] [US2] Test PTY tại `test/contract/tui/us2-explain-refresh.test.ts`: vị trí hàng đợi đổi và prerequisite hoàn tất trong khi `version` của task đang mở không đổi thì `task_explain` được đọc lại; có thời điểm đọc; phần phụ thuộc thời gian cập nhật trong 5 giây (FR-012).
- [X] T042 [P] [US2] Test PTY tại `test/contract/tui/us2-logs.test.ts`: US2 số 4, 9, 10; khoảng trống hiển thị rõ; phiên theo dõi nối lại đúng vị trí; EC-011 log dồn dập không treo phím; bộ đệm không vượt trần.
- [X] T043 [P] [US2] Test an toàn nội dung tại `test/contract/tui/control-chars.test.ts`: bộ mẫu có ký tự điều khiển và điều khiển hướng chữ trong tiêu đề, log, nội dung PR; đối chiếu từng ô; không gửi được lệnh tới terminal (SC-010, EC-001, FR-037). Kiểm không lộ secret (FR-038). US4 thêm mẫu câu hỏi ở T054.

### Implementation for User Story 2

- [X] T044 [US2] Nối làm mới màn chi tiết tại `src/tui/client/refresh.ts`: `task_show` và `task_progress` đọc lại khi `version` đổi; `task_explain` đọc lại khi `watermark` đổi và ít nhất 5 giây một lần, không tự đếm ngược (FR-012, R-03).
- [X] T045 [US2] Dựng màn Task detail tại `src/tui/views/task-detail.ts`: tiến trình bước; lý do, điều kiện tiếp tục, lối ra, blocker và giới hạn từ `task_explain`, không có logic riêng; harness, model, effort theo bước, lượt, escalation, usage phân biệt `reported`, `estimated`, `unavailable` (FR-011, FR-012, FR-013).
- [X] T046 [US2] Thêm phần PR và bằng chứng vào `src/tui/views/task-detail.ts`: lịch sử event theo thứ tự commit, head, base, gate, CI, review theo chế độ, hiệu lực xanh, method và nội dung merge đề xuất, `merged_head_unverified`, yêu cầu hủy đến quá muộn; không hứa tự merge và không hiện task là xong khi chờ merge (FR-015).
- [X] T047 [US2] Triển khai trạng thái log tại `src/tui/model/logs.ts` theo [data model](data-model.md#trạng-thái-log): `mode` là `live` hoặc `paused`; `buffer` "Tối đa 5.000 bản ghi hoặc 8 MiB"; `paused` hoặc có lọc attempt chỉ đánh dấu `new_activity`, không đưa bản ghi vào bộ đệm. Test tại `test/unit/tui/logs.test.ts` (FR-014, FR-039).
- [X] T048 [US2] Dựng màn Logs tại `src/tui/views/logs.ts`: dòng phân cách khi `(step, attempt_id)` đổi, chọn attempt, khoảng trống từ `gap`, báo có hoạt động mới; chỉ màn đang mở mới poll; theo dõi log không chiếm slot (FR-014, EC-011).

**Checkpoint**: US1 và US2 là bản theo dõi chỉ đọc đầy đủ, nhưng chưa đạt mốc đầu.

---

## Phase 5: User Story 3 - Không phải nhớ phím hay cú pháp (Priority: P2)

**Goal**: Mỗi màn hình cho biết phím dùng được, có menu thao tác và trợ giúp theo ngữ cảnh.

**Independent Test**: Người chưa đọc tài liệu đi giữa Home, Task detail, Logs, Help và thoát ra, chỉ dựa vào gợi ý trên màn hình.

### Tests for User Story 3

- [ ] T049 [P] [US3] Test PTY tại `test/contract/tui/us3-navigation.test.ts`: US3 số 1, 2, 3, 4 theo [bảng phím](contracts/tui.md#phím); phím chính, quay lại và thoát nhất quán; Enter không xác nhận thao tác có hậu quả; dùng được hoàn toàn bằng bàn phím; phần tự động của SC-005 (FR-032, FR-033, FR-034).

### Implementation for User Story 3

- [ ] T050 [US3] Khai báo bảng phím theo ngữ cảnh tại `src/tui/model/keymap.ts`, là nguồn duy nhất cho xử lý phím, thanh gợi ý và Help (FR-033).
- [ ] T051 [P] [US3] Dựng màn Help tại `src/tui/views/help.ts`; đóng lại đúng vị trí cũ (FR-033).
- [ ] T052 [US3] Dựng menu Actions tại `src/tui/views/actions.ts`: đọc `task_explain` lúc mở; ánh xạ `allowed_actions` theo [hợp đồng giao diện](contracts/tui.md#màn-hình), mỗi mục có một câu tác dụng từ `note`; thao tác thiếu quyền làm mờ kèm lý do theo `caller`; không phân tích trường `command`; menu không còn hợp lệ thì làm mới (FR-016, FR-023, EC-013). Ở phase này các mục ghi chưa mở được hộp thoại; US4, US5 nối sau.
- [ ] T053 [P] [US3] Triển khai ô nhập tại `src/tui/views/input.ts`: một dòng và nhiều dòng, độ rộng đúng, paste nguyên khối; phím in được là văn bản; `Tab`, `Shift-Tab`, `Ctrl-S`, `Esc` theo hợp đồng. Test tại `test/unit/tui/input.test.ts` (FR-034).

**Checkpoint**: US1–US3 chỉ đọc hoàn chỉnh, điều hướng không cần tài liệu.

---

## Phase 6: User Story 4 - Xử lý việc đang chờ mình (Priority: P2)

**Goal**: Trả lời, duyệt, kiểm tra lại, hủy trong giao diện với cùng bảo đảm quyền và chống lặp như CLI.

**Independent Test**: Với ba mức quyền, thực hiện từng thao tác trên task mẫu, đối chiếu event và số attempt, effect với cùng thao tác qua CLI.

### Tests for User Story 4

- [ ] T054 [P] [US4] Test PTY tại `test/contract/tui/us4-actions.test.ts`: US4 số 1–7, 9; SC-007 so event và effect với cùng thao tác qua CLI ở ba mức quyền; EC-006; câu trả lời bị trùng không mất nội dung; câu hỏi chứa ký tự điều khiển không đổi nội dung màn hình.
- [ ] T055 [P] [US4] Test PTY và crash injection tại `test/contract/tui/us4-unknown-result.test.ts`: US4 số 8; gửi lại 2–5 lần và mất kết nối sau khi gửi đều cho đúng một tác dụng logic; dùng proxy T020 cho mẫu mất phản hồi; hết trần 60 lần `request_show` hoặc 5 lần gửi lại thì dừng và `Check again` bắt đầu vòng mới; SC-014 gồm thoát rồi chạy nguyên văn lệnh đã in; EC-012 thông báo in sau khi trả terminal, và exit 3 khi còn thao tác chưa rõ.
- [ ] T056 [P] [US4] Test PTY tại `test/contract/tui/us4-stale-lock.test.ts`: US4 số 10; SC-015 không có request ID mới tới daemon khi dữ liệu cũ hoặc trước lần đọc lại đầu tiên; đối chiếu request chưa rõ kết quả vẫn chạy; nội dung đang nhập còn nguyên (FR-044).
- [ ] T057 [P] [US4] Fuzz PTY có seed tại `test/reliability/tui/fuzz-confirm.test.ts`: ít nhất 10.000 phím trên từng màn hình; kiểm trace, mọi command hủy, kiểm tra lại `worktree_changed` đi sau màn xem lại và đúng từ xác nhận. Bổ sung xác nhận cấu hình chạy ở T068. Fuzz nhanh trên reducer ở `test/unit/tui/fuzz-reducer.test.ts` chạy trong `pnpm test` nhưng không dùng để tuyên bố đạt (SC-008).

### Implementation for User Story 4

- [ ] T058 [US4] Triển khai `MutationTracker` tại `src/tui/client/mutations.ts` theo [bảng chuyển trạng thái](data-model.md#thao-tác-đang-gửi): một request ID UUIDv7 cho mỗi thao tác logic; `command` không đổi khi gửi lại; `unknown` gọi `request_show` trước; `completed` dùng kết quả, `in_progress` hỏi lại, `interrupted` hoặc `not_found` gửi lại đúng request; mỗi vòng tối đa 60 lần `request_show` và 5 lần gửi lại, chỉ tính khi đang kết nối; hết trần sang `unresolved`, chờ `Check again`; `unknown` và `unresolved` chặn thao tác ghi mới trên cùng task. Test tại `test/unit/tui/mutations.test.ts` (FR-018, FR-019, FR-020).
- [ ] T059 [US4] Thêm khóa thao tác ghi khi dữ liệu cũ vào `src/tui/model/reduce.ts`: `stale` khóa mọi thao tác ghi, `stale_tasks` khóa thao tác ghi trên task đó; giữ `drafts` chỉ trong bộ nhớ, hồi phục thì đọc lại task, hiện thay đổi và không tự gửi (FR-038, FR-044).
- [ ] T060 [P] [US4] Dựng hộp thoại Answer tại `src/tui/views/answer.ts`: đọc `question_show`, gửi bằng `Ctrl-S`, câu hỏi đã được trả lời nơi khác thì hiện nội dung đó và giữ câu trả lời của người dùng.
- [ ] T061 [P] [US4] Dựng hộp thoại Cancel tại `src/tui/views/cancel.ts`: lý do không rỗng, xem hậu quả, gõ `cancel` rồi Enter theo [quy tắc ô xác nhận](contracts/tui.md#xác-nhận); hiện tiến trình dừng và đối chiếu, không báo CANCELLED trước daemon; DONE kèm "cancel arrived too late" nếu merge đã xảy ra (FR-022).
- [ ] T062 [P] [US4] Dựng hộp thoại Recheck tại `src/tui/views/recheck.ts`: thường thì gửi bằng `Ctrl-S`; `worktree_changed` thì cảnh báo nhận cây thư mục, nói rõ chưa xem được thay đổi, hiện `worktree_path`, gõ `accept` rồi Enter theo quy tắc ô xác nhận (FR-021, FR-022, R-05).
- [ ] T063 [P] [US4] Dựng hộp thoại Approve tại `src/tui/views/approve.ts`: bước, nấc, lý do, giới hạn còn lại; quyền admin; gõ `approve` rồi Enter theo quy tắc ô xác nhận; nói rõ không mở thêm lượt đã hết.
- [ ] T064 [US4] Nối Actions với các hộp thoại ở `src/tui/views/actions.ts`, hiện kết quả và xung đột theo trạng thái daemon trả về, không tự gửi lại; task đã kết thúc hoặc chờ merge chỉ gợi ý tạo task mới hoặc merge thủ công (FR-017, FR-020, FR-023, EC-006).
- [ ] T065 [US4] Thêm in thao tác chưa rõ ra stderr sau khi khôi phục terminal tại `src/tui/main.ts` theo [hợp đồng](contracts/tui.md#thoát-khi-còn-thao-tác-chưa-rõ), exit 3 khi còn thao tác chưa rõ, 1 khi lỗi nội bộ; không ghi payload ra file (EC-012, FR-038).

**Checkpoint**: Vòng "thấy việc rồi xử lý luôn" khép kín, nhưng chưa đạt mốc đầu vì chưa có US5.

---

## Phase 7: User Story 5 - Tạo task và chọn cấu hình chạy (Priority: P2)

**Goal**: Tạo task bằng form, chọn cấu hình từ danh sách được phép, xem lại đầy đủ và xác nhận riêng.

**Independent Test**: Tạo task chỉ bằng giao diện với cả hai chế độ, chạy tới PR xanh bằng harness giả lập, kiểm bằng chứng xác nhận gắn đúng task, revision và digest đã hiển thị.

### Tests for User Story 5

- [ ] T066 [P] [US5] Test PTY tại `test/contract/tui/us5-create.test.ts`: US5 số 1, 2, 9, 10; lỗi theo trường; nội dung không mất khi bị từ chối; rời form còn nội dung thì hỏi lại; chọn profile và dependency không phải nhập ID; task tạo với profile đã chọn có `task.profile` đúng; `config_invalid` báo rõ, không đoán lựa chọn (FR-024, FR-025).
- [ ] T067 [P] [US5] Test PTY tại `test/contract/tui/us5-review.test.ts`: US5 số 3–8, 11; đủ sáu hàng của [bảng phạm vi](data-model.md#phạm-vi-xác-nhận), gồm xác nhận intake khi `run_config` là `null`; SC-016 ở terminal 80×24; 0 xác nhận khi không đọc được nội dung hoặc revision đổi; digest đổi thì hiện khác biệt và xóa từ đã gõ; Run config không đổi được profile và mọi lựa chọn đưa ra đều chạy được tới bước bắt đầu với harness giả lập (FR-025, FR-026, FR-027, FR-028).
- [ ] T068 [US5] Mở rộng `test/reliability/tui/fuzz-confirm.test.ts` cho màn Review và xác nhận cấu hình chạy; hết thời gian chờ, giá trị chọn sẵn, Enter với ô rỗng hoặc sai từ đều không xác nhận (SC-008, FR-027).
- [ ] T069 [P] [US5] Test PTY tại `test/contract/tui/journey.test.ts`: SC-004 với harness giả lập ở cả hai chế độ, từ tạo task đến DONE sau merge thủ công, không dùng lệnh con; đo tổng thời gian thao tác.

### Implementation for User Story 5

- [ ] T070 [US5] Dựng form New task tại `src/tui/views/new-task.ts`: project từ `project_list`, tiêu đề, base branch, mô tả, tiêu chí nghiệm thu; tùy chọn priority, profile từ `project_list.profiles` với mặc định `Project default` ghi vào `task.profile`, và dependency chọn từ danh sách task bằng `task_board` chứ không nhập ID; lỗi tại trường; danh sách rỗng ở Home dẫn tới form này; gửi qua `MutationTracker` (FR-018, FR-024).
- [ ] T071 [US5] Dựng màn Run config tại `src/tui/views/run-config.ts`: đọc `run_options` theo task; profile chỉ hiển thị và gửi nguyên trong đề xuất; chỉ chọn chế độ, worker, reviewer, dự phòng từ danh sách, hiện `when_to_use`, không có nhập tự do; `direct-pr` không có reviewer; ô lý do tùy chọn, "max 2.000 ký tự"; không đọc được danh sách thì báo rõ; đề xuất qua `task_propose_run` (FR-017, FR-025).
- [ ] T072 [US5] Tính phạm vi xác nhận tại `src/tui/model/confirm-scope.ts` theo [bảng trong data model](data-model.md#phạm-vi-xác-nhận): `intake_pending`, cấu hình cần xác nhận, `trusted_confirmer`; chỉ gửi digest khi phạm vi có cấu hình chạy. Test đủ sáu hàng tại `test/unit/tui/confirm-scope.test.ts`.
- [ ] T073 [US5] Dựng màn Review tại `src/tui/views/review.ts`: mọi trường của FR-026 từ một lần đọc `task_content`, cuộn được; danh sách rỗng ghi `None`, khác `Could not read`; nguồn đề xuất và lý do; ô gõ `confirm` theo quy tắc ô xác nhận, rỗng khi mở, không hết giờ; gửi đúng `version` đã đọc (FR-026, FR-027).
- [ ] T074 [US5] Xử lý từ chối do digest đổi và token không được phép tại `src/tui/views/review.ts`: hiện khác biệt, xóa từ đã gõ, xin xác nhận lại; nói rõ cần kênh tin cậy và không báo đã xác nhận; PENDING sau xác nhận hiện chẩn đoán và cho kiểm tra lại (FR-028, US5 số 7, 8).
- [ ] T075 [US5] Nối Actions và trạng thái rỗng với New task, Run config, Review tại `src/tui/views/actions.ts` và `src/tui/views/home.ts`.

**Checkpoint**: Toàn bộ US1–US5 đạt với harness giả lập.

---

## Phase 8: Polish — lát F, nghiệm thu mốc đầu

**Purpose**: Bằng chứng còn lại và tài liệu. Tiêu chí chưa chạy phải ghi là chưa đạt.

- [ ] T076 [P] Test tại `test/contract/tui/terminal-display.test.ts`: EC-002 đổi kích thước không mất vị trí và nội dung đang nhập; EC-003 `NO_COLOR`; EC-004 chữ nhiều byte không vỡ cột; EC-014 token và data dir không dùng được thì chỉ gặp lỗi kết nối như mọi client.
- [ ] T077 Hoàn tất SC-011 tại `test/contract/tui/terminal-restore.test.ts` với giao diện thật và daemon thật: mọi đường thoát trả terminal về trạng thái ban đầu và task tiếp tục; `SIGKILL` được ghi là ngoài phạm vi.
- [ ] T078 Thêm phiên dài tại `test/reliability/tui/idle-session.test.ts` và `test/reliability/tui/long-session.test.ts`: SC-009 phiên 1 giờ tạo 0 event, 0 lượt agent, 0 token và không chiếm slot; SC-013 phiên 8 giờ log liên tục không tăng bộ nhớ liên tục, phản hồi phím dưới 200 ms ở 95% lần bấm; đo tải daemon (FR-039). Chạy và ghi kết quả vào `specs/004-terminal-tui/acceptance-report.md`.
- [ ] T079 Thêm hành trình harness thật tại `test/smoke/tui-journey.test.ts`: SC-004 với mỗi harness thật ở cả hai chế độ, tổng thao tác dưới 3 phút; ghi riêng với lần chạy giả lập vào `specs/004-terminal-tui/acceptance-report.md`.
- [ ] T080 Chạy SC-005 với một người chưa đọc tài liệu; ghi thời gian và chỗ bị vướng vào `specs/004-terminal-tui/acceptance-report.md`; không thay bằng test tự động.
- [ ] T081 [P] Cập nhật `skills/cusr/SKILL.md`: bỏ câu nói CLI không có lệnh liệt kê profile và binding; thêm `cusr project list`, `cusr task options`, `cusr task content`, `cusr request show` và cách tra sau timeout. Chỉ làm sau khi lệnh đã có trong bản đang chạy.
- [ ] T082 [P] Cập nhật hợp đồng và tài liệu: thêm lệnh mới vào `specs/002-task-to-green-pr/contracts/cli-daemon.md` hoặc liên kết sang hợp đồng 004; đối chiếu `SPEC.md` §15.1 với lệnh đã triển khai; `README.md` và `deploy/README.md` nêu cách mở `cusr`, giới hạn đứt SSH và `reset` sau `SIGKILL`; `GLOSSARY.md` nếu có thuật ngữ mới.
- [ ] T083 Chạy toàn bộ [quickstart](quickstart.md), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`; đối chiếu lại `specs/004-terminal-tui/data-model.md` và các contract với mã đã viết; lập bảng SC-001–SC-016 trong `specs/004-terminal-tui/acceptance-report.md` với kết quả thật, SC-012 ghi "mốc sau". SC-006 xác nhận test CLI cũ không bị sửa.

---

## Mốc sau: US6

Không có task trong backlog này. Khi mở mốc sau, chạy lại `speckit-tasks` cho US6, FR-029–FR-031, EC-015, SC-012 và chẩn đoán khi daemon chưa chạy ở bảng Phụ thuộc. Ở mốc đầu, khi không kết nối được daemon hoặc không đọc được token, giao diện chỉ nêu lý do, cho thử lại và thoát (T038).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1**: Không phụ thuộc; T005 là cổng vào Phase 2.
- **Phase 2**: Sau Phase 1; chặn mọi story.
- **US1 (Phase 3)**: Sau Phase 2.
- **US2 (Phase 4)**: Sau US1, vì màn chi tiết mở từ Home.
- **US3 (Phase 5)**: Sau US1 và US2, vì cần nội dung để điều hướng.
- **US4 (Phase 6)**: Sau US3, vì dùng Actions và ô nhập.
- **US5 (Phase 7)**: Sau US4, vì dùng `MutationTracker`; T070–T075 phụ thuộc T058.
- **Phase 8**: Sau US5.

### Trong Phase 2

- T007 → T008 → T009. T010 → T012. T006 → T013, T015. T013 → T014. T011, T013, T015, T016 → T017. T008–T018 → T019.
- T022, T023, T025 → T029. T026, T027 → T028 → T029 → T030.

### Trong mỗi story

Test trước và phải thất bại, rồi model, view, cuối cùng nối vào `main`.

### Truy vết SC

| SC | Task | | SC | Task |
| --- | --- | --- | --- | --- |
| SC-001 | T040 | | SC-009 | T033, T078 |
| SC-002 | T031 | | SC-010 | T043 |
| SC-003 | T032, T034 | | SC-011 | T003, T032, T077 |
| SC-004 | T069, T079 | | SC-012 | Mốc sau |
| SC-005 | T049, T080 | | SC-013 | T078 |
| SC-006 | T019, T030, T083 | | SC-014 | T008, T055 |
| SC-007 | T054, T055 | | SC-015 | T056 |
| SC-008 | T057, T068 | | SC-016 | T067 |

## Parallel Example: User Story 4

```text
Sau khi T058 và T059 xong, làm đồng thời các hộp thoại khác file:
T060 src/tui/views/answer.ts
T061 src/tui/views/cancel.ts
T062 src/tui/views/recheck.ts
T063 src/tui/views/approve.ts
```

## Implementation Strategy

### Bản đầu dùng được nội bộ

Phase 1, Phase 2 và US1 cho một màn hình trạng thái dùng được. Đây chỉ là điểm kiểm tra phát triển: theo quyết định Q2, **mốc nghiệm thu đầu chỉ đạt khi có đủ US1–US5**.

### Giao tăng dần

1. Lát 0 (Phase 1), dừng nếu không đạt T005.
2. Lát A và khung giao diện (Phase 2), giao được độc lập vì chỉ thêm lệnh đọc.
3. US1 → US2 và US3 → US4 → US5, mỗi bước một hoặc vài PR nhỏ.
4. Nghiệm thu ở Phase 8.

Nếu renderer vượt khoảng 800 dòng ở Phase 5 thì dừng và đánh giá lại với Ink theo [R-01](research.md#r-01--renderer).

## Notes

- Task chạm store (T007) phải kèm test migration theo hiến chương.
- Không đánh dấu `[x]` nếu chưa có bằng chứng tương ứng; test giả lập không thay cho harness thật hoặc người thật.
- Trạng thái, lối ra và quyền luôn do daemon quyết định; `src/tui/` không có logic suy ra các thứ đó.
