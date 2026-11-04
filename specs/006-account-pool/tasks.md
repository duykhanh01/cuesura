# Tasks: Nhiều tài khoản cho một harness, chuyển tài khoản khi hết hạn mức

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md), [spike-report.md](spike-report.md)

**Trạng thái**: Backlog tạo ngày 2026-11-04. Chưa có task nào được làm.

**Tests**: Bắt buộc. Hiến chương nguyên tắc VII yêu cầu bằng chứng theo tầng:
- chọn tài khoản, vòng thử và gộp cooldown bằng property test;
- luồng event tài khoản, transaction kép và recovery bằng integration test trên SQLite thật, kèm crash injection;
- ghi credential bằng contract test trên filesystem thật với nhiều process;
- hành vi end-to-end bằng scenario với fake harness;
- harness thật ở smoke riêng.

Viết test trước, thấy nó thất bại rồi mới triển khai. Kết quả với fake harness không được ghi là smoke thật.

**Organization**: Theo thứ tự giao của plan, có một chỗ đổi: Story 3 (ghi credential) làm **trước** Story 1. Lý do: Story 1 là
lúc tài khoản dự phòng bắt đầu chạy thật. Nếu khi đó chưa có ghi về, refresh token đã xoay sẽ bị bỏ và tài khoản dự phòng bị
đăng xuất ngay sau lần làm mới đầu tiên. Thứ tự: lát 0 → nền → US2 → US3 → US1 → US4 → hoàn thiện. Theo quy ước repo, mỗi
phase là một PR; task sau commit tiếp vào nhánh của phase đó.

## Format: `[ID] [P?] [Story] Description`

- `[P]`: làm đồng thời được sau prerequisite chung, vì khác file và không phụ thuộc task chưa xong.
- `[USn]`: task thuộc user story, chỉ dùng trong phase story.
- Source tại `src/`, test tại `test/`. Một package Node 24, TypeScript strict, ESM. Không thêm dependency.
- `src/engine/` chỉ import `src/domain/account.ts`, không import adapter; mọi hiểu biết về định dạng credential nằm trong
  `src/adapters/harness/`; mọi transaction nằm trong `src/store/`.
- Nội dung credential không bao giờ vào DB, event, log, output hay thông báo (FR-025); test chỉ in tên khóa hoặc digest.
- Comment chỉ khi cần thiết và viết bằng tiếng Anh ([AGENTS.md](../../AGENTS.md)).
- Mỗi PR có code: `pnpm typecheck`, `pnpm lint`, `pnpm test:changed` sạch; chạy trực tiếp file test liên quan bằng
  `pnpm vitest run <file>`. Test đầy đủ do CI chạy.
- **Số migration:** `main` đang tới `005`. PR 003 (Telegram) cũng dự định dùng `006`. Lúc làm T005, lấy số kế tiếp còn trống
  trên `origin/main`; tasks gọi nó là `NNN_accounts.sql`.

## Phase 1: Setup — lát 0 và công cụ kiểm thử

**Purpose**: Chốt giả định vendor còn mở, và có fake harness cùng builder mà mọi test sau dùng.

- [ ] T001 Chạy spike S1 nếu có tài khoản Claude phụ thứ hai khác danh tính tài khoản chính:
  1. Tạo session bằng tài khoản phụ A.
  2. Resume session đó bằng tài khoản phụ B, đúng cách `src/runner/invocation.ts` gọi resume.
  3. Ghi kết quả vào phần S1 của `specs/006-account-pool/spike-report.md` và R-12 của `research.md`.

  Không dùng `claude-b` hay tài khoản chính. Không có tài khoản thì ghi "chưa chạy, dùng phương án `resume_fallback`" và đi
  tiếp; khi đó T037 bắt buộc có test chuyển tài khoản sẽ bắt đầu session mới.
- [ ] T002 [P] Mở rộng fake harness tại `src/adapters/harness/fake.ts` với các chế độ:
  - trả `rate_limited` kèm hoặc không kèm `reset_at`;
  - trả `overloaded`;
  - trả lỗi `auth`;
  - ghi token mới vào file credential trong private home, một lần hoặc nhiều lần trong lúc chạy;
  - ghi token rỗng (bên thua khi làm mới đồng thời);
  - đổi danh tính trong credential;
  - chạy bình thường.

  Định dạng file giả giống Claude (`.claude/.credentials.json` cộng `.claude.json`) và Codex (`auth.json`) đủ cho
  `validate`/`identityOf`. Test tự kiểm tại `test/unit/adapters/fake-harness.test.ts`.
- [ ] T003 [P] Thêm builder cho tài khoản và trạng thái tại `test/support/accounts.ts`:
  - tạo thư mục tài khoản `managed` giả dưới `<DATA_DIR>/accounts/<id>/home`;
  - tạo credential mặc định giả (`system`) ngoài `DATA_DIR`;
  - tạo luồng event tài khoản mẫu.

  Thêm arbitrary cho fast-check tại `test/property/arbitraries/accounts.ts`: tập tài khoản có `priority`, `source_kind`,
  `declared_seq`, nguyên nhân chặn, cooldown và `now`.

**Checkpoint 0**: T001 có kết quả hoặc ghi rõ dùng phương án dự phòng; T002, T003 đạt.

---

## Phase 2: Foundational — thực thể, luồng event tài khoản, adapter credential, khóa

**Purpose**: Mọi story cần thực thể tài khoản, luồng event riêng với projection, interface `CredentialFormat` và khóa của tài
khoản.

**⚠️ CRITICAL**: Không làm story nào trước khi phase này xong.

- [ ] T004 [P] Tạo `src/domain/account.ts` (export qua `src/domain/index.ts`) với schema Zod theo
  [data model](data-model.md#thực-thể):
  - `Account`: `account_id` UUIDv7; `name` theo `RefNameSchema` và "duy nhất trong harness"; `harness`;
    `source_kind` ∈ `managed`, `system`; `source_path`; `identity_key` "SHA-256 của `vendor:mã danh tính`" hoặc `null`;
    `identity_label`; `priority` integer "mặc định `0`"; `declared_seq`; `removed`.
  - `BlockCause` ∈ `auth_error`, `identity_changed`, `pending_write`, `suspended`.
  - `Cooldown` với `source` ∈ `vendor`, `backoff`, `clamped`, `cleared_at_seq`.
  - Union `AccountEvent` cho mọi event ở [bảng event](data-model.md#luồng-event-tài-khoản).
  - Hàm `cooldownKeyOf(account)`: `identity_key` nếu có, ngược lại `account:` + `account_id`.

  Test schema và `cooldownKeyOf` tại `test/unit/domain/account.test.ts`.
- [ ] T005 Viết test migration trước tại `test/integration/store/migration-accounts.test.ts`: nâng từ migration trước lên
  trên DB có dữ liệu, chạy lại không lỗi, ràng buộc unique hoạt động. Rồi thêm `src/store/migrations/NNN_accounts.sql` và
  đăng ký trong `src/store/migrate.ts`. Bảng `STRICT`:
  - `account_events(account_seq INTEGER PRIMARY KEY AUTOINCREMENT, type, account_id NULL, payload_json, actor, reason,
    cause_task_id NULL, cause_global_seq NULL)`.
  - Projection `accounts` với UNIQUE `(harness, name)` trên tài khoản chưa gỡ.
  - `account_blocks` với khóa `(account_id, cause)`.
  - `account_cooldowns` với khóa `cooldown_key`.
  - `account_episodes` với "một đợt mở tối đa cho mỗi harness" (unique index một phần trên `harness WHERE state = 'open'`).
  - `notices`.

  Không lưu secret nào.
- [ ] T006 [P] Thêm crash point `after_account_events`, `after_account_projection` vào `CRASH_POINTS` tại `src/store/crash.ts`;
  cập nhật test liệt kê tại `test/integration/crash/crash-points.test.ts`.
- [ ] T007 Tạo `src/store/accounts.ts` (export qua `src/store/index.ts`):
  - `appendAccountEvents(tx, events)` cập nhật projection trong cùng transaction;
  - `readAccounts`, `readAccountProjection(harness?)`, `maxAccountSeq`, `accountEventsAfter(seq)`;
  - `replayAccounts()` dựng lại projection hoàn toàn từ `account_events` theo `account_seq`.

  Quy tắc projection:
  - Hai `AccountCooldownSet` cùng khóa thì lấy mốc muộn hơn (FR-016).
  - `reset_at` ở quá khứ không tạo cooldown.
  - `AccountCooldownCleared` ghi `cleared_at_seq`.
  - `AccountRemoved` đánh dấu `removed`, giữ lịch sử.

  Test trên SQLite thật tại `test/integration/store/accounts.test.ts`, gồm replay ra đúng projection sau chuỗi event ngẫu
  nhiên.
- [ ] T008 Thêm hook ở `src/store/accept.ts`: trigger của task được mang theo event tài khoản và ghi chúng trong cùng
  transaction, với `cause_task_id` và `cause_global_seq` trỏ về trigger đó. Thêm đường `acceptAccountCommand` cho lệnh
  `account_*` không gắn task, dùng lại `command_ledger` để chống lặp theo `request_id`. Test tại
  `test/integration/store/accept-accounts.test.ts`:
  - crash ở `after_account_events` thì không còn event task nào lẻ;
  - lặp `request_id` không ghi lần hai.
- [ ] T009 Mở rộng `verifyProjections` tại `src/store/verify.ts`: dựng lại projection tài khoản từ luồng và so với bảng. Test
  tại `test/integration/store/projection.test.ts`: cố ý sửa lệch một hàng thì verify báo lỗi.
- [ ] T010 [P] Thêm interface `CredentialFormat` theo [hợp đồng](contracts/credential-writeback.md#interface-adapter) tại
  `src/adapters/harness/vendor.ts`. Triển khai cho Claude tại `src/adapters/harness/claude.ts`, Codex tại
  `src/adapters/harness/codex.ts` và fake tại `src/adapters/harness/fake.ts`:
  - `readStable(home)`: Codex đọc trong khi giữ `flock` trên `auth.lock`; Claude đọc trực tiếp.
  - `validate(bytes)`: JSON hợp lệ, đủ trường token, "token không rỗng".
  - `identityOf(home)`: Claude lấy `oauthAccount.accountUuid` và `organizationUuid` trong `.claude.json`; Codex lấy
    `tokens.account_id` trong `auth.json`. Không gọi mạng.
  - `authFiles`: danh sách file auth tương đối với home.

  Contract test tại `test/contract/credential-format.test.ts` với file mẫu không chứa token thật, gồm token rỗng bị từ
  chối, thiếu `.claude.json` cho `identity = null`, và file Codex đang ghi dở không đọc được giữa chừng.
- [ ] T011 [P] Tạo khóa của tài khoản tại `src/runner/account-lock.ts` theo [R-13](research.md#r-13--khóa-nguồn-credential):
  - mở `<DATA_DIR>/accounts/<id>/lock.sqlite` (`0600`) bằng `better-sqlite3`, `busy_timeout` 5 giây, `BEGIN EXCLUSIVE`;
  - chạy callback trong khóa, rồi `ROLLBACK` và đóng;
  - hết giờ trả `lock_timeout`.

  Contract test với process thật tại `test/contract/account-lock.test.ts`:
  - nhiều process cùng lấy khóa;
  - giết process đang giữ khóa thì lần lấy sau thành công ngay;
  - hai process cùng chờ khóa của process vừa chết thì chỉ một bên vào được (quickstart 19b, 19b′).
- [ ] T012 [P] Tạo helper đường dẫn tại `src/runner/account-paths.ts`: `accountHome`, `pendingDir`, `stagingDir`, `lockFile` dưới
  `<DATA_DIR>/accounts/`, với quyền `0700` cho thư mục và `0600` cho file. Đi từng thành phần đường dẫn bằng `lstat` và từ chối
  symlink. Test tại `test/unit/runner/account-paths.test.ts`.

**Checkpoint 1**: Luồng event tài khoản ghi được, replay và verify đạt; khóa và `CredentialFormat` có contract test xanh.
Hành vi chạy task chưa đổi.

---

## Phase 3: User Story 2 — Thêm và quản lý tài khoản bằng CLI (Priority: P1)

**Goal**: Có tài khoản mặc định từ credential của pin. Thêm tài khoản dự phòng bằng login của vendor. Xem, tạm ngưng, bật
lại, đổi ưu tiên, `use`, xóa nghỉ, đăng nhập lại và gỡ tài khoản. Mọi thao tác thay đổi cần `admin`. Hành vi chạy chưa đổi.

**Independent Test**: Thêm hai tài khoản bằng login giả lập, chạy `cusr account list`, tạm ngưng một tài khoản; `cusr doctor`
báo trạng thái từng tài khoản không in nội dung credential; token `operate` bị từ chối (quickstart 1, 1d, 2, 3, 10, 18).

### Tests for User Story 2 ⚠️

- [ ] T013 [P] [US2] Contract test CLI tại `test/contract/cli/accounts.test.ts` theo [hợp đồng](contracts/cli-daemon.md):
  - mỗi lệnh `cusr account …` với `--json` trả đúng envelope;
  - mã lỗi và exit code: `login_cancelled`, `login_failed`, `credential_invalid`, `name_taken` (2); `identity_mismatch`,
    `account_system` (2); `superseded` (6); `account_suspended` (6); `forbidden` (5);
  - `warnings: [same_identity]` có thông điệp không tăng hạn mức.
- [ ] T014 [P] [US2] Integration test service tại `test/integration/application/accounts.test.ts`:
  - quyền: mọi kind `account_*` cần `admin`, token `operate` của một project nhận `forbidden`;
  - lọc `account_list` theo [bảng lọc](contracts/cli-daemon.md#query-account_list): khóa `admin` vắng hẳn với token không có
    `admin`; `running_attempts`, `last_used_at`, `tasks` chỉ tính project được đọc;
  - `use` đặt `priority` = cao nhất hiện có + 1 và bị từ chối khi tạm ngưng;
  - `clear-cooldown` chỉ gỡ cooldown đã biết tại lúc nhận lệnh (ghi `cleared_at_seq`);
  - `resume` chỉ gỡ đúng `suspended`;
  - `login` cùng danh tính khi tài khoản đang nghỉ không xóa nghỉ;
  - `remove` tài khoản `managed` xóa thư mục kể cả `pending/`; `remove` tài khoản `system` không đụng file của người dùng;
  - crash giữa commit `AccountAdded` và rename thư mục tạm thì lần khởi động sau rename nốt; thư mục tạm mồ côi cũ hơn
    24 giờ bị xóa;
  - crash giữa thay credential và commit `AccountRelogged` thì gửi lại cùng `request_id` sẽ commit mà không báo
    `superseded` ([R-08](research.md#r-08--đăng-nhập-vào-thư-mục-quản-lý)).
- [ ] T015 [P] [US2] Integration test tài khoản mặc định tại `test/integration/application/default-account.test.ts`:
  - nâng cấp và cài mới đều tạo `default` (`source_kind: system`, `priority: 0`, actor `system`) khi pin trỏ tới credential;
  - không có credential trong pin thì giữ lỗi cấu hình hiện có;
  - gỡ `default` rồi khởi động lại thì không tạo lại;
  - thêm, gỡ hay đổi ưu tiên tài khoản không đổi `environmentHash` của pin và không đòi proof lại (FR-004);
  - test hiện có của task không phải sửa (SC-006).

### Implementation for User Story 2

- [ ] T016 [US2] Thêm kind `account_add`, `account_login`, `account_remove`, `account_suspend`, `account_resume`,
  `account_clear_cooldown`, `account_set_priority`, `account_use`, `account_check`, `account_retry_write` vào
  `COMMAND_PAYLOADS` với `REQUIRED_ROLE: admin`, `project: null` tại `src/application/commands.ts`. Payload theo
  [bảng lệnh](contracts/cli-daemon.md#lệnh). Kiểm quyền trong `admitCommand`, không chỉ ở CLI.
- [ ] T017 [US2] Tạo service tại `src/application/accounts.ts` cho các lệnh `add`, `remove`, `suspend`, `resume`,
  `clear-cooldown`, `priority`, `use` theo [quy tắc từng lệnh](contracts/cli-daemon.md#quy-tắc-từng-lệnh). Mỗi lệnh ghi event
  kèm `actor` và `reason` qua `acceptAccountCommand`. `add` không kèm `--priority` nhận `0`. `add` theo đúng thứ tự của
  [R-08](research.md#r-08--đăng-nhập-vào-thư-mục-quản-lý): kiểm thư mục tạm, commit `AccountAdded` có `staging_id`, rồi
  ngoài transaction mới rename `<DATA_DIR>/accounts/staging/<uuid>/` thành `<DATA_DIR>/accounts/<account_id>/home` và tạo
  `lock.sqlite`. Trả `same_identity` khi trùng `identity_key`. Bước khởi động trong `src/daemon/startup.ts` rename nốt thư
  mục tạm của tài khoản thiếu `home` và xóa thư mục tạm mồ côi cũ hơn 24 giờ. Đăng ký handler trong `src/daemon/main.ts`.
- [ ] T018 [US2] Thêm query `account_list` tại `src/application/accounts.ts`, đăng ký cùng các query khác trong
  `src/application/queries.ts`, lọc theo `projects` và `admin` của token như T014. Trả `episodes` rỗng cho tới US1.
- [ ] T019 [US2] Tạo tài khoản mặc định khi daemon khởi động, ngay sau khi nạp harness record (`loadHarnessRecord` trong
  `src/daemon/production.ts`; daemon chỉ nạp pin lúc này), theo [R-11](research.md#r-11--tài-khoản-mặc-định): harness có
  pin trỏ tới `credential_refs[pin.home_files[].credential].file` mà chưa từng có `AccountAdded` với `source_kind: system`
  thì ghi `AccountAdded` tên `default`.
- [ ] T020 [US2] Thêm `account_login` (đăng nhập lại) tại `src/application/accounts.ts`:
  - danh tính phải trùng tài khoản, nếu không thì `identity_mismatch`;
  - thay credential trong khóa T011 với CAS theo `expected_source_digest`, ngoài transaction, **rồi** mới commit; nguồn
    đã đổi thì `superseded`, trừ khi digest nguồn đã bằng bản trong thư mục tạm (lần gửi lại sau crash) thì coi là đã
    ghi; thư mục tạm chỉ xóa sau khi commit;
  - tài khoản `system` trả `account_system`;
  - thành công thì ghi `AccountRelogged` và gỡ `auth_error` nếu có.
- [ ] T021 [US2] Tạo nhóm lệnh CLI tại `src/cli/accounts.ts` và đăng ký trong `src/cli/program.ts`. `add` và `login` chạy trong
  process CLI có TTY theo [R-08](research.md#r-08--đăng-nhập-vào-thư-mục-quản-lý):
  1. tạo thư mục tạm;
  2. chạy `HOME=<staging> claude auth login` hoặc `CODEX_HOME=<staging> codex login --device-auth`;
  3. kiểm `validate` và `identityOf`;
  4. gửi lệnh.

  Lỗi ở bất kỳ bước nào thì xóa thư mục tạm. Lệnh login lấy từ adapter để test thay bằng login giả lập. `<name>` đổi sang
  `account_id` qua `account_list`. Bảng hiển thị trong `src/cli/render.ts`.
- [ ] T022 [US2] Mở rộng `src/application/doctor.ts`. Với mỗi tài khoản, báo: nguồn tồn tại, file thường, quyền file, định dạng
  vendor, danh tính đọc được hay không, trùng danh tính (ghi rõ không tăng hạn mức), tài khoản `system` dùng chung
  credential với phiên tương tác, và Codex cấu hình lưu credential bằng keyring thì báo không được hỗ trợ. Không in nội
  dung. Test tại `test/unit/application/doctor-accounts.test.ts`.

**Checkpoint 2**: Story 2 kịch bản 1–6, 9 đạt; quickstart 1, 1d, 2, 3, 10, 18 đạt; task vẫn chạy bằng credential của pin như cũ.

---

## Phase 4: User Story 3 — Credential vẫn dùng được sau mỗi lần chạy (Priority: P1)

**Goal**: Token mà harness làm mới trong private home được ghi về thư mục của tài khoản `managed` ngay khi đổi, bằng CAS dưới
khóa. Lỗi I/O thì giữ bản chờ ghi. Recovery xử lý run `finished` và `lost`. Tài khoản `system` không bao giờ được ghi về.

**Independent Test**: Gọi runner trực tiếp với một tài khoản `managed` và fake harness ghi token mới. Nguồn là bản mới
`0600`; 10 attempt đồng thời × 100 lần luôn để nguồn hợp lệ; crash giữa rename và commit không mất token (quickstart 11–15,
19b, 19d).

### Tests for User Story 3 ⚠️

- [ ] T023 [P] [US3] Contract test thủ tục ghi về tại `test/contract/credential-writeback.test.ts`. Mỗi kết quả ở
  [bảng thủ tục](contracts/credential-writeback.md#thủ-tục) có ca riêng:
  - `rejected: not_regular`, `unchanged`, `rejected: format` (gồm token rỗng), `rejected: identity`;
  - `pending: lock_timeout`, `account_missing`, `superseded`, `written`, `pending: io` (thư mục nguồn chỉ đọc).

  Thêm ca: tài khoản `system` không bao giờ qua bước 5; ghi nhiều lần trong một attempt cập nhật `source_digest`.
- [ ] T024 [P] [US3] Contract test đồng thời tại `test/contract/credential-writeback-concurrency.test.ts`: 10 process runner
  cùng tài khoản kết thúc cùng lúc, lặp 100 lần. Nguồn luôn là một bản hợp lệ đầy đủ, mỗi bên ghi sau báo `superseded`
  (SC-004, quickstart 12).
- [ ] T025 [P] [US3] Integration test crash tại `test/integration/crash/credential-writeback.test.ts`:
  - crash giữa rename và ghi outcome thì recovery coi là `written`, không ghi lặp;
  - crash khi bản chờ đã chuyển nhưng event chưa commit thì recovery ghi `AccountWritePending` một lần, dedup theo
    `attempt_id`;
  - run `lost` có token mới trong private home thì được ghi về rồi mới xóa auth.

### Implementation for User Story 3

- [ ] T026 [US3] Mở rộng input của invocation tại `src/runner/invocation.ts` với `account` tùy chọn
  (`account_id`, `source_kind`, `home`). Có `account` thì nguồn của từng `home_files[].credential` lấy từ thư mục tài khoản
  thay cho `credential_refs`. Không có thì giữ hành vi cũ. Ghi `account_id`, `source_digest` và `installed_digest` cho từng
  file auth vào `launch-state.json` tại `src/runner/private-home.ts`. Test tại `test/unit/runner/private-home.test.ts`.
- [ ] T027 [US3] Tạo `src/runner/credential-writeback.ts` theo [hợp đồng](contracts/credential-writeback.md#thủ-tục):
  - bước 1–8 với `CredentialFormat` và khóa T011;
  - ghi tmp `0600` cùng thư mục nguồn, fsync, rename đè nguồn, fsync thư mục;
  - `pending` thì chuyển bản mới vào `<DATA_DIR>/accounts/<id>/pending/`.

  Trả kết quả có kiểu, không kèm nội dung credential.
- [ ] T028 [US3] Gọi ghi về trong suốt attempt tại `src/runner/invocation.ts`: `fs.watch` trên file auth của private home cộng
  quét định kỳ vài giây, một lần nữa trước `removeAuth` ở mọi đường kết thúc, và trong `Invocation.recover` cho run `finished`.
  Kết quả ghi đi vào fact của runner (`credential_write`) và không đổi outcome công việc (FR-022a). Chỉ chạy với
  `source_kind: managed`.
- [ ] T029 [US3] Recovery cho run `lost` tại `src/daemon/reconcile.ts`: chạy thủ tục trên private home còn lại rồi xóa auth,
  thay cho việc để auth nằm lại tới retention. Quét `pending/` khi khởi động để ghi `AccountWritePending` còn thiếu.
- [ ] T030 [US3] Ánh xạ kết quả ghi sang event tài khoản theo [bảng ánh xạ](contracts/credential-writeback.md#ánh-xạ-sang-event-tài-khoản)
  tại `src/daemon/handlers.ts`, ghi cùng transaction với trigger kết quả qua hook T008: `pending` thêm `pending_write`,
  `rejected: identity` thêm `identity_changed`.
- [ ] T031 [US3] Thử lại bản chờ:
  - trong vòng scheduler theo backoff `infra` tại `src/daemon/scheduler.ts`;
  - ngay khi có lệnh `account_retry_write` tại `src/application/accounts.ts`.

  Mỗi lần thử lấy khóa từ đầu và dùng `source_digest` lưu cùng bản chờ. `written` hoặc `superseded` thì xóa bản chờ và gỡ
  `pending_write`. Lệnh CLI `cusr account retry-write` trong `src/cli/accounts.ts`. Test tại
  `test/integration/application/retry-write.test.ts` (quickstart 14, 19b).

**Checkpoint 3**: Story 3 kịch bản 1–4, 6 đạt ở tầng runner; quickstart 11–15, 19b, 19b′ đạt. Production vẫn chưa chạy tài
khoản `managed` cho tới Phase 5.

---

## Phase 5: User Story 1 — Task chạy tiếp bằng tài khoản khác khi hết hạn mức (Priority: P1) 🎯 MVP

**Goal**: Mỗi attempt agent được chọn tài khoản ngay trước khi chạy:
- tài khoản mặc định trước, dự phòng sau;
- hết hạn mức thì tài khoản nghỉ theo danh tính, attempt kế tiếp chạy ngay trên tài khoản khác;
- mọi tài khoản đều nghỉ thì chờ tới mốc sớm nhất, có thông báo theo đợt và đánh thức sớm khi có thay đổi.

**Independent Test**: Với fake harness, A trả `rate_limited` reset sau 3 giờ. Attempt kế tiếp chạy trên B trong 30 giây; A
nghỉ đúng mốc; model, effort và binding giữ nguyên. A và B cùng nghỉ thì task chờ tới mốc sớm nhất, có một thông báo đợt
(quickstart 1b, 4–9, 19a, 19e).

### Tests for User Story 1 ⚠️

- [ ] T032 [P] [US1] Property test tại `test/property/invariants/accounts.test.ts`:
  - `selectAccount` chỉ trả tài khoản chưa gỡ, không có nguyên nhân chặn, không có cooldown hiệu lực tại `now`, không nằm
    trong `tried`;
  - thứ tự theo `priority` giảm dần, rồi `system` trước, rồi `declared_seq`;
  - mỗi tài khoản một lần mỗi vòng;
  - hết vòng mà mọi mốc đã qua thì trả mốc backoff, không vòng nóng;
  - hai báo cooldown gộp lấy mốc muộn hơn;
  - tài khoản cùng `cooldown_key` nghỉ cùng nhau;
  - tài khoản đã gỡ không tính vào `earliest_ready_at`.
- [ ] T033 [P] [US1] Unit test engine tại `test/unit/engine/accounts.test.ts`:
  - `rate_limited` ghi `AccountCooldownSet` và `start_agent` ngay trong vòng cũ;
  - `overloaded` giữ backoff `rate_limit` của task và không làm tài khoản nghỉ;
  - `accounts_unavailable` vào đúng một trong `accounts_cooling`, `accounts_pending_write`, `accounts_blocked` kèm
    `accounts_watermark`;
  - đánh thức mở vòng mới;
  - đổi tài khoản không phải escalation và không đổi model hay effort (FR-015).
- [ ] T034 [P] [US1] Scenario tại `test/scenarios/us1-accounts.test.ts` với daemon thật và fake harness:
  - quickstart 1b, 4, 5, 6, 7, 9, 19a, 19e;
  - Story 1 #6: hai task cùng bị giới hạn trên A thì A có một trạng thái nghỉ và mỗi task chạy lại đúng một lần;
  - Story 1 #7: thêm tài khoản thứ hai không làm tăng số attempt chạy cùng lúc (FR-020);
  - restart khi A đang nghỉ thì A không được chọn trước mốc (SC-008, quickstart 8);
  - replay cho cùng lựa chọn (FR-017).

### Implementation for User Story 1

- [ ] T035 [P] [US1] Mở rộng domain:
  - `src/domain/state.ts`: thêm `account_round` `{step, harness, tried: account_id[]}` hoặc `null` vào `TaskState`; thêm
    `accounts_cooling`, `accounts_pending_write`, `accounts_blocked` vào `DETAIL_CODES`.
  - `src/explain/needs-user.ts`: `NEEDS_USER` lần lượt `false`, `false`, `true`.
  - `src/domain/trigger.ts`: thêm lớp `accounts_unavailable` vào `FAILURE_CLASSES`; thêm `harness_kind`, `account_id`,
    `earliest_ready_at`, `blocked`, `credential_write` vào `FailureData`; thêm trigger `account_ready`.
  - `src/domain/event.ts`: thêm event task `AccountSelected` với `reason` ∈ `first`, `rate_limit`, `auth`, `fresh_token`,
    `woken`.

  Cập nhật `rewriteTaskStates` nếu state cũ cần giá trị mặc định.
- [ ] T036 [US1] Tạo hàm thuần `selectAccount(accounts, harness, round, now)` tại `src/engine/accounts.ts` theo
  [data model](data-model.md#chuyển-trạng-thái-chọn-tài-khoản). Trả tài khoản được chọn, hoặc "không có" kèm lý do chờ,
  `earliest_ready_at` và nguyên nhân chặn từng tài khoản. Không import adapter.
- [ ] T037 [US1] Tại `src/engine/interpreter.ts`, đưa `harness` và `account_round.tried` vào request của effect `start_agent`.
  Tại `src/engine/failure.ts`:
  - xử lý `accounts_unavailable` (nhả slot, hoàn ngân sách vì `invoked: false`, chờ theo bảng lý do của
    [R-05](research.md#r-05--chờ-đánh-thức-và-vòng-thử) với timer `backoff` tới `earliest_ready_at`);
  - `rate_limited` có `account_id` thì retry ngay không timer khi vòng còn tài khoản chưa thử.

  Tại `src/engine/waits.ts`, ghi `accounts_watermark`. Chuyển tài khoản mà resume lỗi thì đi `resume_fallback` như hiện nay
  (T001).
- [ ] T038 [US1] Tại `src/daemon/handlers.ts`, handler `startAgent`:
  - đọc projection tài khoản, gọi `selectAccount` với `now`;
  - có tài khoản thì truyền `account` vào invocation (T026) và ghi `account_id` vào fact khởi chạy;
  - không có thì trả `effect_failed` lớp `accounts_unavailable`, `invoked: false`.

  Tách `overloaded` khỏi `rate_limited` trong `HARNESS_FAILURE_CLASS` bằng `harness_kind`; lớp của task giữ nguyên `rate_limit`
  cho cả hai. `rate_limited` của attempt có tài khoản mang `AccountCooldownSet` (`until` từ `reset_at`, hoặc backoff
  `rate_limit` khi không có; cắt về `backoff.rate_limit.max_ms` kèm `clamped: true`) vào trigger kết quả qua hook T008.
- [ ] T039 [US1] Đánh thức tại `src/daemon/scheduler.ts`, sau `fireTimers`:
  - chỉ xét event tài khoản có `account_seq` > watermark của wait và thuộc loại làm tăng khả dụng theo danh sách ở
    [R-05](research.md#r-05--chờ-đánh-thức-và-vòng-thử), gồm cả `AccountRelogged`;
  - mở rộng event cooldown theo `cooldown_key` qua mọi harness;
  - `submit` trigger `account_ready` với khóa dedup `account_ready:<task>:<wait_seq>:<account_seq>`.

  Test tại `test/unit/daemon/account-wake.test.ts`: không phát `account_ready` khi không có event mới (quickstart 19a);
  `login` hoặc `check` gỡ chặn thì đánh thức task đang chờ `accounts_blocked`.
- [ ] T040 [US1] Đợt hết hạn mức và thông báo theo [R-10](research.md#r-10--thông-báo-và-đợt-hết-hạn-mức) tại
  `src/store/accounts.ts` và `src/daemon/handlers.ts`:
  - mở đợt khi task đầu tiên nhận `accounts_cooling` mà mọi tài khoản không bị chặn vì lý do khác đều nghỉ;
  - tăng `version` khi tập task, mốc hồi hay trạng thái đổi;
  - đóng khi `selectAccount` có kết quả cho harness đó.

  Thêm `episodes` vào `account_list`. Integration test tại `test/integration/store/account-episodes.test.ts`.

**Checkpoint 4 (MVP)**: Story 1 kịch bản 1–9 và Story 2 kịch bản 7 đạt; SC-001, SC-002, SC-008 có bằng chứng; quickstart 1b,
4–9, 19a, 19e đạt.

---

## Phase 6: User Story 4 — Tài khoản lỗi đăng nhập không làm kẹt task (Priority: P2)

**Goal**: Lỗi auth do token vừa bị xoay ở nơi khác thì chạy lại trên cùng tài khoản một lần. Lỗi auth thật thì đánh dấu
tài khoản, chuyển task sang tài khoản khác và báo trong inbox. `account check` kiểm lại và gỡ lỗi. Tài khoản mặc định đổi
danh tính thì `check` nhận danh tính mới.

**Independent Test**: Fake harness trả lỗi auth trên A thì A bị đánh dấu, attempt chạy trên B, inbox có mục cho A. Token bị
xoay ở nơi khác thì A không bị đánh dấu (quickstart 16, 17, 19c, 19d, 1c).

### Tests for User Story 4 ⚠️

- [ ] T041 [P] [US4] Unit test engine tại `test/unit/engine/auth-chains.test.ts`:
  - `auth_chains` độc lập theo tài khoản: lỗi trên A chỉ đọc và ghi mục của A, chuyển sang B không xóa mục của A;
  - attempt không lỗi auth trên chính tài khoản đó thì xóa mục;
  - mỗi chuỗi chỉ được thử token mới một lần (FR-018, quickstart 19c).
- [ ] T042 [P] [US4] Scenario tại `test/scenarios/us4-account-auth.test.ts`:
  - quickstart 16, 17 và 19d (bản của bên thắng đã nằm trong nguồn trước khi xét lỗi của bên thua);
  - Story 2 kịch bản 10: `default` bị đăng xuất thì chạy dự phòng, `check` đạt thì quay lại `default`;
  - quickstart 1c: đổi danh tính của `default` thì bị chặn, `check` nhận danh tính mới;
  - Story 4 #7: tạm ngưng A (hoặc `use` B) trong lúc attempt trên A chạy, attempt lỗi auth và nguồn A có token mới thì lần
    chạy lại dùng B.

### Implementation for User Story 4

- [ ] T043 [US4] Thêm `auth_chains` (map `account_id → {fresh_token_used}`) vào `TaskState` tại `src/domain/state.ts` và xử lý
  lỗi `auth` có `account_id` tại `src/engine/failure.ts`:
  - nguồn đổi và chưa dùng token mới thì `start_agent` ngay, được chọn lại tài khoản đó (`fresh_token`);
  - còn lại thì `AccountAuthFailed` và `start_agent` ngay trong vòng cũ.
- [ ] T044 [US4] Tại `src/daemon/handlers.ts`, khi lỗi `auth` có tài khoản: đọc digest nguồn hiện tại, so với `source_digest`
  trong `launch-state.json` và gửi `source_changed`. Phát hiện đổi danh tính lúc chọn bằng `identityOf` trên nguồn của
  tài khoản `system` và ghi `AccountIdentityChanged`.
- [ ] T045 [US4] Thêm `account_check` như một effect theo [R-09](research.md#r-09--quyền-và-lọc-dữ-liệu):
  - lệnh tại `src/application/accounts.ts` ghi `AccountCheckRequested` với `check_id` = `request_id`;
  - sau commit, daemon chạy probe qua runner (kiểm nguồn như `add`, đọc danh tính, một lần gọi harness ngắn bằng model rẻ
    trong private home tạm, có timeout, có ghi credential về);
  - kết quả quay về bằng trigger dedup theo `check_id`, ghi `AccountCheckCompleted`; đạt thì thêm `AccountAuthRestored`;
    tài khoản `system` có `identity_changed` thì thêm `AccountRelogged` với danh tính mới;
  - restart khi probe chưa xong thì chạy lại probe.

  `cusr account check` tại `src/cli/accounts.ts` chờ kết quả bằng query: thất bại thì `check_failed` (exit 1), hết thời gian
  chờ thì in `pending` (exit 0). Integration test tại `test/integration/application/account-check.test.ts`, gồm crash giữa
  `AccountCheckRequested` và kết quả.
- [ ] T046 [US4] Thêm mục loại `account` vào inbox tại `src/application/inbox.ts` theo
  [R-10](research.md#r-10--thông-báo-và-đợt-hết-hạn-mức): dựng lúc đọc từ `account_blocks`, mỗi tài khoản có `auth_error`,
  `identity_changed` hoặc `pending_write` là một mục không đòi trả lời, kèm lệnh gợi ý (`check`, `login`, `retry-write`). Mục
  chỉ hiện cho token có `admin`, theo FR-007. Test tại `test/integration/application/inbox-accounts.test.ts`.

**Checkpoint 5**: Story 4 kịch bản 1–6, Story 2 kịch bản 8 và 10 đạt; quickstart 1c, 16, 17, 19c, 19d đạt.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Hiển thị, tài liệu, SPEC.md, bằng chứng toàn feature.

- [ ] T047 [P] Bổ sung query hiện có tại `src/application/queries.ts` và `src/application/report.ts`:
  - `task_show` và `task_history` có `account` của mỗi attempt và mỗi lần chuyển kèm lý do (FR-019);
  - `task_show` của task thuộc một đợt hết hạn mức có thông báo của đợt đó, lọc theo quyền (FR-014a);
  - `report` có mục `notices` lọc theo quyền, và tài khoản của attempt trong `running`/`finished`.

  Hiển thị CLI tại `src/cli/report.ts` và `src/cli/tasks.ts`.
- [ ] T048 [P] TUI: tài khoản theo attempt và thông báo đợt của task ở `src/tui/model/detail.ts` và
  `src/tui/views/task-detail.ts`; thông báo đợt ở
  `src/tui/model/home-rows.ts` và `src/tui/views/home.ts`; ba `DetailCode` mới trong `src/tui/model/activity.ts`. Test snapshot
  tại `test/contract/tui/`.
- [ ] T049 [P] Test không lộ secret tại `test/scenarios/accounts-no-secrets.test.ts`: sau các kịch bản 4–17, quét event, log,
  report và output CLI, không có token hay nội dung credential (SC-007, quickstart 19).
- [ ] T050 [P] Sửa `SPEC.md`:
  - §5.1 thêm thực thể Account, gồm tài khoản mặc định và dự phòng;
  - §6.2 đổi "rate limit khóa pool/harness" thành khóa tài khoản;
  - §9.2 tách `overloaded` khỏi cooldown tài khoản;
  - §12.1 và §13.3 thêm ghi credential và recovery của nó;
  - §15.1 thêm nhóm lệnh `cusr account`.
- [ ] T051 [P] Cập nhật tài liệu: `skills/cusr/SKILL.md` (lệnh `cusr account`, lý do chờ mới, chỉ `admin` được đổi tài khoản),
  `deploy/README.md` (thêm tài khoản dự phòng, đăng nhập lại `default`), `docs/architecture.md` (luồng event tài khoản).
- [ ] T052 Thêm suite mới vào `test/invariants.map.ts` cho bất biến liên quan: tất định, idempotent, vòng có giới hạn.
- [ ] T053 Smoke harness thật tại `test/smoke/accounts.test.ts`, chỉ chạy khi có biến môi trường trỏ tới hai tài khoản phụ:
  - SC-003: 50 attempt liên tiếp trên một tài khoản dự phòng (`managed`), sau đó credential vẫn đăng nhập được, và phiên
    đăng nhập riêng của cùng subscription vẫn dùng được;
  - chuyển tài khoản thật nếu quan sát được hạn mức.

  Không dùng tài khoản chính.
- [ ] T054 Chạy [quickstart](quickstart.md) và ghi `specs/006-account-pool/acceptance-report.md`: mỗi SC là đạt, chưa đạt
  hoặc chưa kiểm, kèm bằng chứng. Tiêu chí chỉ kiểm bằng fake harness ghi rõ như vậy.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: không phụ thuộc. T001 chỉ chặn phần resume trong T037.
- **Foundational (Phase 2)**: sau Setup; chặn mọi story.
- **US2 (Phase 3)**: sau Phase 2.
- **US3 (Phase 4)**: sau Phase 2. Phần runner (T023–T028) làm song song với US2 được; T030–T031 cần T016–T017.
- **US1 (Phase 5)**: sau US2 (cần tài khoản và `account_list`) và US3 (tài khoản `managed` chỉ được chạy khi đã có ghi về).
- **US4 (Phase 6)**: sau US1 (cần chọn tài khoản và `launch-state` có `source_digest`).
- **Polish (Phase 7)**: sau các story cần thiết; T050, T051 bắt đầu được sớm.

### Within Each Story

- Test viết trước và thất bại trước khi triển khai.
- Domain → store → engine → daemon/application → CLI/TUI.

### Parallel Opportunities

- Phase 1: T002, T003.
- Phase 2: T004, T006, T010, T011, T012 cùng lúc; T005 → T007 → T008 → T009 nối tiếp.
- US2: T013, T014, T015 cùng lúc.
- US3: T023, T024, T025 cùng lúc; cả phase song song với US2 tới T029.
- US1: T032, T033, T034, T035 cùng lúc.
- US4: T041, T042 cùng lúc.
- Polish: T047–T051.

## Parallel Example: User Story 1

```text
Task: "Property test selectAccount và vòng thử tại test/property/invariants/accounts.test.ts"
Task: "Unit test engine tại test/unit/engine/accounts.test.ts"
Task: "Scenario tại test/scenarios/us1-accounts.test.ts"
Task: "Mở rộng domain tại src/domain/state.ts, src/domain/trigger.ts, src/domain/event.ts"
```

## Implementation Strategy

### MVP

Phase 1 → 2 → US2 → US3 → US1. Dừng ở Checkpoint 4 và kiểm: tài khoản mặc định chạy như cũ; thêm tài khoản dự phòng; hết
hạn mức thì chuyển; token làm mới không bị mất. US2 và US3 riêng lẻ chưa đem lại giá trị cho người dùng cuối nhưng giao
được an toàn: hành vi chạy không đổi cho tới US1.

### Incremental Delivery

| PR | Phase | Giao được gì |
| --- | --- | --- |
| 1 | Setup + Foundational | Nền, chưa đổi hành vi |
| 2 | US2 | Quản lý tài khoản, `doctor`, tài khoản mặc định |
| 3 | US3 | Ghi credential ở runner, recovery |
| 4 | US1 | Chuyển tài khoản khi hết hạn mức (MVP) |
| 5 | US4 | Lỗi auth theo tài khoản |
| 6 | Polish | Report/TUI, SPEC.md, tài liệu, acceptance |

## Notes

- `[P]` = khác file, không phụ thuộc task chưa xong.
- Không bao giờ in giá trị credential trong test hay log; chỉ in tên khóa hoặc digest.
- Smoke và spike không dùng tài khoản chính hay `claude-b`.
