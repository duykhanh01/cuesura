# Tasks: Kênh thông báo hai chiều qua Telegram

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Trạng thái**: Backlog tạo ngày 2026-11-03. Chưa có task nào được làm.

**Tests**: Bắt buộc. Hiến chương nguyên tắc VII yêu cầu bằng chứng theo tầng: store, outbox và recovery bằng integration test trên
SQLite thật kèm crash injection; logic quyết định bằng property test; adapter bằng contract test với Telegram giả lập; bot thật ở
smoke riêng. Viết test trước, thấy nó thất bại rồi mới triển khai. Kết quả với Telegram giả lập không được ghi là smoke thật
(SC-010).

**Organization**: Theo user story và thứ tự giao của plan: lát 0 → nền → US1 → US2 → US3 → US4 → US5 → nghiệm thu. Theo quy ước
repo, mỗi phase là một PR; task sau commit tiếp vào nhánh của phase đó.

## Format: `[ID] [P?] [Story] Description`

- `[P]`: làm đồng thời được sau prerequisite chung, vì khác file và không phụ thuộc task chưa xong.
- `[USn]`: task thuộc user story, chỉ dùng trong phase story.
- Source tại `src/`, test tại `test/`. Một package Node 24.22.1, TypeScript strict, ESM. Không thêm dependency.
- `src/engine/` không import gì của kênh; `src/adapters/telegram/` chỉ biết Bot API; mọi transaction nằm trong `src/store/`.
- Comment chỉ khi cần thiết và viết bằng tiếng Anh ([AGENTS.md](../../AGENTS.md)). Chuỗi trong tin Telegram và output CLI viết
  theo mẫu ở [contracts/telegram.md](contracts/telegram.md).
- Mỗi PR có code: `pnpm typecheck`, `pnpm lint`, `pnpm test:changed` sạch; chạy trực tiếp file test liên quan bằng
  `pnpm vitest run <file>`; test trong `test/reliability/` chạy bằng `pnpm test:reliability`. Test đầy đủ do CI chạy.

## Phase 1: Setup — lát 0, Telegram giả lập và kiểm sự thật Bot API

**Purpose**: Có Telegram giả lập để mọi test sau dùng, và xác nhận các sự thật Bot API mà thiết kế dựa vào.

- [ ] T001 Viết Telegram giả lập tại `test/support/fake-telegram.ts`: server HTTP cục bộ trả lời `getMe`, `getWebhookInfo`,
  `deleteWebhook`, `getUpdates` (offset xác nhận update có ID nhỏ hơn; long poll có timeout), `sendMessage` (cấp `message_id` tăng
  dần theo từng bot và chat), `editMessageText`, `answerCallbackQuery`, `sendChatAction`. Có API cho test: đẩy update (tin, reply,
  callback, tin sửa, từ chat lạ, từ nhóm), chèn lỗi theo lần gọi (mất kết nối trước phản hồi, timeout sau khi đã nhận tin, 409, 429
  kèm `retry_after`, 403, 5xx, `message to edit not found`, `message is not modified`), xóa tin, đọc lại mọi tin đã gửi theo chat.
  Test tự kiểm tại `test/unit/support/fake-telegram.test.ts`.
- [ ] T002 Viết smoke tại `test/smoke/telegram-api.test.ts`, chỉ chạy khi có `CUSR_SMOKE_TELEGRAM_TOKEN` và
  `CUSR_SMOKE_TELEGRAM_CHAT`: `getMe`; `sendMessage`; `editMessageText` thành công; sửa lại cùng nội dung trả `message is not
  modified`; sửa tin đã xóa trả lỗi `message to edit not found`; hai long poll đồng thời cho 409; deep link payload 22 ký tự
  base64url tới bot dạng `/start <payload>`. Ghi kết quả hoặc "chưa kiểm" vào `specs/003-telegram-channel/acceptance-report.md` (tạo
  mới). Chuỗi lỗi khác với [R-01](research.md#r-01--gọi-telegram-bot-api) thì sửa research trước khi làm Phase 2.

**Checkpoint 0**: T001 đạt; T002 đã chạy hoặc ghi rõ chưa kiểm.

---

## Phase 2: Foundational — lưu trữ, adapter và hạ tầng chung

**Purpose**: Bảng kênh, adapter Telegram, crash point, hook trong `accept` và vòng của daemon mà mọi story cần.

**⚠️ CRITICAL**: Không làm story nào trước khi phase này xong.

- [ ] T003 Viết test migration trước tại `test/integration/store/migration-006.test.ts` (005 → 006 trên DB có dữ liệu, chạy lại không
  lỗi, unique constraint hoạt động), rồi thêm `src/store/migrations/006_telegram_channel.sql` và đăng ký trong `src/store/migrate.ts`.
  Bảng `STRICT` theo [data model](data-model.md):
  - `tg_channel` một dòng `id = 1`; `token_fingerprint` là "SHA-256 đầy đủ của token"; `token_state` ∈ `ok`, `token_missing`,
    `token_mismatch`; `update_offset` "chỉ tăng"; `recovery_epoch` "không reset khi restart".
  - `tg_links` với `revoke_reason` ∈ `unlink`, `relinked`, `bot_changed` và "unique index một phần trên biểu thức hằng
    `((1)) WHERE revoked_at IS NULL`".
  - `tg_link_codes` với `code_hash` khóa chính, `state` ∈ `pending`, `used`, `expired`, `cancelled`.
  - `notifications` với `key` UNIQUE, `kind` ∈ `question`, `approval`, `confirmation`, `attention`, `finished`, `reply`, `report`;
    `priority` ∈ `reply`, `business`, `info`; `state` ∈ `held`, `pending`, `sent`, `failed`, `stale`.
  - `message_copies` với UNIQUE `(bot_id, chat_id, message_id)`; `sync_state` ∈ `none`, `pending`, `done`, `gone`.
  - `action_cards` với `card_id` khóa chính; `kind` ∈ `answer`, `approve`, `confirm`, `open`, `page`.
  - `tg_updates` khóa chính `(bot_id, update_id)`; `kind` ∈ `message`, `edited_message`, `callback_query`, `pairing`, `other`;
    `state` ∈ `pending`, `done`, `ignored`; `ignored_count` gộp tin lạ cùng `(chat_id, kind)` trong 10 phút.
  Bảng mới không nằm trong `verifyProjections` (`src/store/verify.ts`); test khẳng định verify vẫn đạt khi các bảng có dữ liệu.
- [ ] T004 Thêm crash point `after_notifications`, `after_try_mark`, `after_copy`, `after_updates`, `after_command_saved`,
  `after_setup_commit` vào `CRASH_POINTS` tại `src/store/crash.ts`; test liệt kê tại `test/unit/store/crash-points.test.ts`.
- [ ] T005 Tạo module store `src/store/telegram.ts` (export qua `src/store/index.ts`) với các hàm đọc/ghi bảng kênh, mỗi hàm ghi là
  một `BEGIN IMMEDIATE` gọi crash hook tương ứng: đọc/ghi `tg_channel`; tạo/thu hồi liên kết; tạo/hủy/dùng mã; chèn lô update cùng
  offset; ghi `command_json`; đánh dấu update xong; chèn thông báo `ON CONFLICT(key) DO NOTHING`; đánh dấu lượt; ghi kết quả lượt;
  tạo bản tin; ghi kết quả đồng bộ; tạo thẻ. Test trên SQLite thật tại `test/integration/store/telegram-store.test.ts`, gồm: offset
  không lùi; chỉ một liên kết hoạt động; `INSERT` trùng khóa không tạo dòng thứ hai.
- [ ] T006 [P] Thêm mẫu `\b\d{6,12}:[A-Za-z0-9_-]{30,}\b` vào `SECRET_PATTERNS` tại `src/runner/redact.ts`; test token Telegram bị che
  trong `text()` và `value()`, và chuỗi số bình thường (giờ `12:30`, `id:123`) không bị che, tại `test/unit/runner/redact.test.ts`.
- [ ] T007 [P] Viết contract test trước tại `test/contract/telegram-api.test.ts` với Telegram giả lập, rồi triển khai `TelegramPort`
  tại `src/adapters/telegram/api.ts` theo [R-01](research.md#r-01--gọi-telegram-bot-api) và bảng phân loại lỗi ở
  [contracts/telegram.md](contracts/telegram.md#dùng-bot-api): gọi qua `fetch` với `AbortSignal`; timeout 10 giây cho gửi/sửa, 35 giây
  cho `getUpdates` với `timeout=25`; gốc URL lấy từ `CUSR_TELEGRAM_API_BASE` nếu có. Kết quả là union có kiểu: `ok`, `unknown` (lỗi
  trước khi có phản hồi), `rate_limited{retry_after}`, `token_invalid`, `blocked`, `gone`, `not_modified`, `conflict`, `failed`. Token
  không bao giờ xuất hiện trong lỗi, log hay message của exception.
- [ ] T008 [P] Viết test trước tại `test/unit/adapters/telegram/format.test.ts`, rồi triển khai `src/adapters/telegram/format.ts`:
  dựng văn bản thuần không `parse_mode` cho từng mẫu ở [contracts/telegram.md](contracts/telegram.md#mẫu-tin); cắt ở ranh giới dòng
  để vừa 4096 ký tự mà giữ dòng đầu, mã, việc cần làm, lệnh CLI và dòng `ref` cuối; mã ngắn 6 ký tự base32 băm từ ID; chia report
  tối đa 5 tin. Test với nội dung dài, tiếng Việt, emoji và nội dung giả dòng `ref` ở giữa.
- [ ] T009 Viết test trước tại `test/integration/store/accept-hook.test.ts`, rồi thêm tham số tùy chọn `afterProject(tx, before,
  after, events)` vào `accept()` tại `src/store/accept.ts` theo
  [R-03](research.md#r-03--tạo-thông-báo-trong-cùng-transaction-với-sự-kiện): chạy sau projection, trước khi ghi
  `accepted_triggers`, trong cùng transaction; gọi crash point `after_notifications`; lỗi của hook làm rollback cả accept. Hook được
  gắn khi mở store (tùy chọn của `openStore` tại `src/store/index.ts`) để mọi đường gọi `accept`, gồm `src/store/index.ts`,
  `src/store/grant.ts` và `src/store/timers.ts`, đều chạy nó; test phủ cả ba đường. Không có hook thì hành vi không đổi; test hiện
  có của `accept` không sửa.
- [ ] T010 Cho phép round của daemon khai báo cổng riêng tại `src/daemon/main.ts`: round kênh chỉ bỏ qua khi store `latched` hoặc
  `blocked`, không bỏ qua khi `held` ([R-06](research.md#r-06--nhận-tin)); `abortRounds` hủy được round đang chờ mạng. Test tại
  `test/unit/daemon/rounds.test.ts`: round kênh chạy khi `held`, dừng khi `latched`, `stop()` không chờ hết long poll.
- [ ] T011 Viết test trước tại `test/integration/telegram/token-file.test.ts`, rồi triển khai đọc token tại
  `src/application/telegram/token.ts`: đường dẫn `DATA_DIR/telegram/token.<fp>`; thư mục `telegram/` 0700; file 0600, không symlink,
  đúng chủ sở hữu, đúng băm; trả `ok`, `token_missing` hoặc lỗi quyền. Thêm bước dọn lúc khởi động tại `src/daemon/startup.ts`, chạy
  trước khi server điều khiển nhận lệnh và trước mọi round: xóa mọi `token.*` không phải `fp` trong DB, và chỉ ở bước này
  ([R-07](research.md#r-07--token-bot-và-lệnh-setup)).

**Checkpoint nền**: migration, store kênh, adapter, hook và cổng round đạt test; test hiện có không phải sửa.

---

## Phase 3: User Story 1 - Liên kết Telegram và kiểm tra kênh (Priority: P1) 🎯 MVP

**Goal**: Setup token, liên kết chat bằng mã dùng một lần, gỡ liên kết, và thấy tình trạng kênh qua `status`, `doctor`,
`telegram status`.

**Independent Test**: Với daemon thật và Telegram giả lập: setup token đúng/sai/bot khác; liên kết bằng mã đúng, hết hạn, đã dùng,
gửi từ nhóm, sai 5 lần; liên kết lại cùng chat và chat khác; unlink; đối chiếu `cusr telegram status --json`, `cusr status`,
`cusr doctor` và việc chat lạ không nhận phản hồi.

### Tests for User Story 1

- [ ] T012 [P] [US1] Viết contract test CLI tại `test/contract/cli/telegram-commands.test.ts` cho `cusr telegram
  setup|link|unlink|status` theo [contracts/cli-daemon.md](contracts/cli-daemon.md#lệnh-mới): `--json` đúng một envelope; exit code
  của `telegram_token_invalid`, `telegram_token_file_missing`, `telegram_busy`, `telegram_webhook_active`, `telegram_unreachable`,
  `telegram_not_configured`, `forbidden`; token không có trong argv, stdout, stderr và `command_ledger`.
- [ ] T013 [P] [US1] Viết integration test tại `test/integration/telegram/setup.test.ts`: cùng bot thì giữ liên kết, offset, bản
  tin; bot khác thì thu hồi liên kết với `bot_changed`, hủy mã, update `pending` của bot cũ thành `ignored`, `update_offset = 0`;
  webhook bật thì từ chối trừ `--drop-webhook`; hai setup đồng thời thì cái sau nhận `telegram_busy`; daemon restart giữa lúc CLI
  ghi file và gửi lệnh thì setup trả `telegram_token_file_missing` và DB không đổi.
- [ ] T014 [P] [US1] Viết integration test tại `test/integration/telegram/linking.test.ts`: mã hạn 10 phút (clock giả); mã dùng một
  lần; 5 lần `/start` sai thì mã bị hủy; role/project vượt grant người gọi bị `forbidden`; tạo mã mới hủy mã cũ; liên kết cũ hoạt động
  tới khi mã mới được dùng; liên kết lại cùng chat tạo `link_id` mới và thẻ/reply của liên kết cũ trả hết hiệu lực; `unlink` thu hồi
  ngay và hủy mã đang chờ; phản hồi cho mã sai, hết hạn, đã dùng, đã hủy giống hệt nhau; `/start` từ nhóm, `/start` không mã và tin
  bất kỳ từ chat chưa liên kết không nhận phản hồi (EC-013, SC-006); chuỗi đánh dấu trong tin lạ không xuất hiện trong bất kỳ artifact
  context nào của task đang chạy (SC-006); 1000 tin lạ liên tiếp không tạo quá trần dòng `ignored` của T019 và không làm chậm tin của
  liên kết đang chờ phía sau (EC-002).

### Implementation for User Story 1

- [ ] T015 [US1] Triển khai `telegram_setup` tại `src/application/telegram/setup.ts` theo đủ bốn bước của
  [R-07](research.md#r-07--token-bot-và-lệnh-setup): khóa trong process cho một setup mỗi lúc; đọc lại file và kiểm băm ngay trước
  transaction trong cùng đoạn đồng bộ; `getMe` và `getWebhookInfo`; một transaction đổi (bot, token) và xử lý bot khác; sau commit chỉ
  xóa file `token.<fp_cũ>`. Gọi crash point `after_setup_commit` giữa commit và xóa file.
- [ ] T016 [US1] Triển khai `telegram_link_code`, `telegram_unlink`, `telegram_status` tại `src/application/telegram/setup.ts` theo
  [R-08](research.md#r-08--liên-kết-mã-và-grant): mã 16 byte base64url, lưu SHA-256, hạn 10 phút, role mặc định `operate`, project
  mặc định bằng phạm vi người gọi, kiểm tập con của grant người gọi; `telegram_status` trả đúng shape ở hợp đồng, không có token hay
  mã.
- [ ] T017 [US1] Đăng ký command `telegram_setup`, `telegram_link_code`, `telegram_unlink` (admin) và query `telegram_status` (read)
  trong `COMMAND_PAYLOADS` và `REQUIRED_ROLE` tại `src/application/commands.ts`, nối handler tại `src/daemon/task-control.ts` và
  `src/daemon/production.ts`; thêm mã lỗi mới vào `src/cli/errors.ts`.
- [ ] T018 [US1] Triển khai `cusr telegram setup|link|unlink|status` tại `src/cli/telegram.ts`, đăng ký trong `src/cli/commands.ts`:
  `setup` đọc token từ stdin, ẩn ký tự khi TTY, tự gọi `getMe`, ghi `telegram/token.<fp>` (0600, ghi tạm, fsync, đổi tên), gửi lệnh
  chỉ mang băm, in giới hạn bảo vệ token theo ADR-0005; `link` in mã, deep link, hạn và chờ bằng `telegram_status` (`--no-wait` trả
  ngay); `--role`, `--project` lặp được.
- [ ] T019 [US1] Triển khai vòng nhận tại `src/daemon/telegram.ts` và phân loại tại `src/application/telegram/inbound.ts` theo
  [R-06](research.md#r-06--nhận-tin): `getUpdates` với `allowed_updates` cố định; phân loại trước khi lưu theo thứ tự liên kết →
  `pairing` (chỉ lưu `code_hash`) → `ignored` (chỉ metadata); che secret trước khi lưu; tin lạ chỉ giữ tối đa một dòng `ignored` cho
  mỗi `(chat_id, kind)` trong mỗi 10 phút (các tin còn lại chỉ tăng bộ đếm của dòng đó) và không ghi log từng tin (EC-002); lô
  update và offset trong một transaction (crash point `after_updates`); đối chiếu token trước mỗi vòng, dừng khi `token_state` khác
  `ok`; 409 hoặc webhook thì ghi `receive_conflict` và backoff.
- [ ] T020 [US1] Xử lý update `pairing` tại `src/application/telegram/inbound.ts`: một transaction thu hồi liên kết cũ (`relinked`),
  tạo liên kết mới với grant đã chốt, đánh dấu mã `used`; mã sai thì tăng `failed_attempts` của mã `pending` duy nhất nếu có, đạt 5
  thì hủy mã đó (EC-013 chấp nhận việc người lạ làm hủy mã); gửi phản hồi chung qua thông báo `reply` (khóa
  `reply:<bot>:<update_id>`). Kiểm liên kết rồi xử lý trong một đoạn đồng bộ, không `await` ở giữa (FR-010).
- [ ] T021 [US1] Thêm `channels.telegram` vào `GET /v1/health` tại `src/daemon/health.ts` (thêm điểm tiêm từ `src/daemon/main.ts`)
  theo [R-14](research.md#r-14--health-status-doctor): lỗi kênh không đổi 200 thành 503. Thêm check `telegram` vào
  `src/application/doctor.ts` và nối tại `src/daemon/production.ts`: chưa setup là `ok` kèm "not configured"; `token_missing`,
  `token_mismatch`, webhook, xung đột, đường gửi hỏng, đã setup mà chưa liên kết là `fail` kèm `fix`. Test tại
  `test/integration/telegram/health-doctor.test.ts`.

**Checkpoint US1**: T012–T014 đạt; SC-001 phần tự động (setup và link chỉ bằng hai lệnh) ghi vào acceptance report.

---

## Phase 4: User Story 2 - Trả lời câu hỏi của agent từ Telegram (Priority: P1)

**Goal**: Câu hỏi chờ người được đẩy tới chat; reply hoặc `/answer` ghi câu trả lời qua cùng dịch vụ với `cusr answer`; câu hỏi xử
lý ở kênh khác thì bản tin được sửa thành "đã trả lời".

**Independent Test**: Daemon thật, harness giả lập trả `needs_input`, Telegram giả lập: kiểm tin được gửi; trả lời từ Telegram và CLI;
lặp mỗi update 2–5 lần; trả lời cạnh tranh; câu trả lời chứa secret; câu hỏi revision cũ; `autonomous` bật với decider thành công và
hỏng; restart giữa các bước.

### Tests for User Story 2

- [ ] T022 [P] [US2] Viết unit test trước tại `test/unit/application/notify/derive.test.ts` cho `deriveNotifications(before,
  after)`: câu hỏi mở mới sinh `question:<question_id>`; chuyển trạng thái đến từ timer (`fireDueTimers`) và grant cũng sinh thông
  báo (FR-001); câu hỏi đóng (trả lời, rút, task kết thúc) sinh đánh dấu đồng bộ; không có liên kết hoặc project ngoài grant thì
  không sinh gì; một accept sinh nhiều event vẫn ra đúng một thông báo cho mỗi khóa.
- [ ] T023 [P] [US2] Viết property test trước tại `test/property/notify-order.test.ts`: với chuỗi thông báo và kết quả lượt ngẫu
  nhiên, thứ tự gửi luôn là phản hồi → đồng bộ trạng thái cuối → nghiệp vụ theo `created_seq` trong từng task; thông báo hết hiệu
  lực không giữ chỗ; mỗi đợt không quá 6 lượt; lịch lượt theo backoff 2 giây nhân đôi, trần 5 phút, jitter ±20% từ `try_seed`
  (FR-006).
- [ ] T024 [P] [US2] Viết integration test tại `test/integration/telegram/questions.test.ts` cho US2.1–US2.8 và EC-001, EC-003,
  EC-004, EC-006, EC-014: một tin cho mỗi câu hỏi; reply ghi đúng câu hỏi với `issued_by = telegram:<link_id>`; reply vào bản tin
  không có trong `message_copies` định tuyến bằng dòng `ref <card_id>`; trả lời bằng CLI làm bản tin được sửa; trả lời cạnh tranh
  Telegram–CLI chỉ một bên thắng; câu trả lời có nội dung giống secret bị từ chối với `answer_contains_secret` và câu hỏi vẫn mở;
  ảnh, sticker và tin sửa nhận hướng dẫn; mã ngắn trùng báo mơ hồ. Đo với clock thật: từ lúc lưu câu hỏi tới lúc Telegram giả lập
  nhận tin, và từ reply tới tin xác nhận, mỗi chiều dưới 5 giây, để bắt hồi quy; SC-002 vẫn chỉ được chốt bằng smoke ở T059.
- [ ] T025 [P] [US2] Viết integration test tại `test/integration/telegram/replay.test.ts` (SC-003 cho reply): mỗi update reply và
  `/answer` lặp 2–5 lần, kể cả sau restart, chỉ ghi một câu trả lời, một attempt tiếp theo và một phản hồi logic; ca mutation đã
  commit trước crash vẫn trả kết quả đầu tiên nhờ `command_json`, không bị `command_mismatch` (FR-014).
- [ ] T026 [P] [US2] Viết test tại `test/property/decider-failure.test.ts` và `test/integration/runtime/decider.test.ts`:
  `deciderQuestion` không trả câu hỏi đã có `decider_runs[*]` cùng `question_id` và `failure !== null`, kể cả sau restart và tắt/bật
  `autonomous` (FR-021, Q17).

### Implementation for User Story 2

- [ ] T027 [US2] Triển khai `deriveNotifications` tại `src/application/notify/derive.ts` (hàm thuần, phần câu hỏi) và hook tại
  `src/application/notify/hook.ts`: đọc liên kết đang hoạt động trong transaction; chèn thông báo `question` với `state = held` hay
  `pending` tùy decider; đặt `sync_state = pending` cho mọi bản tin của đối tượng vừa đóng. Đăng ký hook qua tùy chọn của
  `openStore` ở `src/daemon/production.ts` (T009), không truyền riêng ở từng chỗ gọi `accept`.
- [ ] T028 [US2] Sửa `deciderQuestion` tại `src/daemon/decider.ts` để loại câu hỏi có lần chạy hỏng đã ghi; cập nhật comment đầu file
  cho đúng hành vi mới (FR-021).
- [ ] T029 [US2] Triển khai vòng gửi tại `src/daemon/telegram.ts` theo [R-04](research.md#r-04--gửi-lượt-đợt-thứ-tự): chọn việc theo
  thứ tự đã kiểm ở T023; kiểm hiệu lực trước mỗi lượt (FR-004) và chuyển `stale`; đọc cài đặt `autonomous` (nhớ đệm 30 giây) để giữ
  hoặc thả câu hỏi `held`; đánh dấu lượt trước khi gọi mạng (crash point `after_try_mark`); ghi kết quả; thời hạn đợt 2 giờ tính từ
  lượt đầu, 15 phút cho `reply`; nhịp 1 tin/giây; `retry_after` dừng mọi lượt; lượt đã đánh dấu mà chưa có kết quả sau restart là
  `unknown`.
- [ ] T030 [US2] Khi ghi bản tin thành công (crash point `after_copy`) tại `src/store/telegram.ts`, đọc lại state của task trong cùng
  transaction và đặt `sync_state = pending` nếu đối tượng đã đóng hoặc hết hiệu lực (FR-022, SC-008).
- [ ] T031 [US2] Tạo thẻ `answer` một lần cho mỗi cặp (thông báo, liên kết) trước lượt gửi đầu tại
  `src/application/telegram/cards.ts`; dòng cuối mọi tin câu hỏi là `ref <card_id>`.
- [ ] T032 [US2] Triển khai đồng bộ trạng thái cuối trong vòng gửi tại `src/daemon/telegram.ts`: `editMessageText` bỏ nút, thêm dòng
  trạng thái ngay trên dòng `ref`; `not_modified` là xong; `gone` ghi lý do và ngừng; hết đợt thì giữ `pending` chờ `recovery_epoch`
  mới (Q18, Q19).
- [ ] T033 [US2] Xử lý reply và `/answer` tại `src/application/telegram/inbound.ts` theo
  [R-09](research.md#r-09--thao-tác-từ-telegram-đi-qua-đường-lệnh-có-sẵn): định tuyến reply qua `message_copies(bot_id, chat_id,
  message_id)` rồi dòng `ref` của tin gốc chỉ khi `from.id` là bot; từ chối câu trả lời khi che secret làm đổi nội dung (EC-014);
  dựng envelope `answer_question` với `request_id` dẫn xuất từ `tg:<bot_id>:<update_id>` và `expected_version` hiện tại, ghi
  `command_json` (crash point `after_command_saved`) trước khi gọi `admitCommand`; dùng lại `command_json` hoặc kết quả ledger khi
  xử lý lại; tạo đúng một thông báo `reply` cho mỗi update theo bảng phản hồi ở
  [contracts/telegram.md](contracts/telegram.md#phản-hồi-thao-tác).
- [ ] T034 [US2] Xử lý tin sửa, ảnh, file, giọng nói, sticker và văn bản tự do tại `src/application/telegram/inbound.ts`: một phản hồi
  hướng dẫn kèm số việc đang chờ; tin sửa của reply đã ghi nhận nhận phản hồi rằng câu trả lời không đổi (EC-003, EC-004).

**Checkpoint US2**: T022–T026 đạt; một câu hỏi đi từ worker tới chat và quay lại task chỉ bằng Telegram giả lập.

---

## Phase 5: User Story 3 - Duyệt và xác nhận từ Telegram (Priority: P1)

**Goal**: Yêu cầu duyệt escalation và xác nhận task tới chat kèm nút gắn đúng phạm vi; bấm một lần là xong; nút cũ bị từ chối.

**Independent Test**: Task chờ duyệt và task chờ xác nhận; bấm từng nút, bấm lặp, bấm nút cũ sau khi revision/nấc/policy/digest đổi,
bấm từ chat chỉ có `operate`, callback tự dựng; crash giữa hai phần xác nhận.

### Tests for User Story 3

- [ ] T035 [P] [US3] Viết property test trước tại `test/property/confirm-with-run-config.test.ts` cho trigger
  `confirm_task_with_run_config { revision, digest }`: mọi tổ hợp revision đúng/sai, có/không có đề xuất, digest khớp/lệch, task
  đã/chưa xác nhận intake; chấp nhận thì phát `TaskConfirmed` khi intake chưa xác nhận và luôn phát `RunConfigConfirmed`, từ chối
  thì không phát gì, với `reason` ∈ `revision_changed`, `proposal_missing`, `digest_mismatch`.
- [ ] T036 [P] [US3] Viết crash test tại `test/integration/crash/confirm-atomic.test.ts`: `cusr task confirm --run-config` và nút
  xác nhận bị ngắt ở mọi crash point của `accept`; sau restart task luôn ở trạng thái "cả hai" hoặc "không gì" (SC-005, Q16).
- [ ] T037 [P] [US3] Viết integration test tại `test/integration/telegram/approvals.test.ts` cho US3.1–US3.6: tin duyệt có phạm vi đầy
  đủ, chỉ nút "Duyệt" và dòng lối ra khi không muốn nâng model; chat `operate` không có nút và callback tự dựng bị `forbidden`; nút cũ
  khi revision, nấc hoặc policy đổi trả hết hiệu lực và bản tin được sửa; nút xác nhận chỉ có khi đề xuất đầy đủ; bấm lặp trả kết quả
  cũ; duyệt bằng CLI làm bản tin được sửa; nút trên bản tin không sửa được vẫn bị từ chối.

### Implementation for User Story 3

- [ ] T038 [US3] Thêm trigger `confirm_task_with_run_config` vào `src/domain/trigger.ts`, xử lý trong `src/engine/decide.ts` dùng lại
  `src/engine/intake.ts` và `src/engine/run-config.ts` để phát cả hai event trong một accept; sửa comment cũ "owner-only" tại
  `src/engine/run-config.ts` cho đúng `trustedConfirmer` hiện hành.
- [ ] T039 [US3] Đổi `confirmTask` tại `src/application/confirm.ts` dùng trigger mới khi có `run_config_digest` (dedup key mới
  `cmd:<rid>:confirm_run`); preflight `config_checked` vẫn chạy sau. Request đã chạy nửa đường hai bước cũ trước khi nâng cấp (đã có
  `TaskConfirmed`, chưa có `RunConfigConfirmed`) được gửi lại thì trigger mới chỉ xác nhận cấu hình, nên kết thúc đúng mà không cần
  giữ đường cũ; test ca này. Test hiện có của `task confirm` không đổi kỳ vọng ngoài việc không còn trạng thái một nửa; contract
  `--json` ở `test/contract/cli/` thêm mã `rejected` mới.
- [ ] T040 [US3] Mở rộng `deriveNotifications` và hook cho `approval:<approval_id>` (yêu cầu escalation mới) và
  `confirm:<task>:r<rev>:<digest>` (chờ xác nhận có đề xuất) tại `src/application/notify/derive.ts`; đóng đối tượng khi approval được
  cấp, rút, hoặc revision/policy/digest đổi.
- [ ] T041 [US3] Tạo thẻ `approve` (approval ID, bước, nấc, policy hash) và `confirm` (revision, digest) tại
  `src/application/telegram/cards.ts`; nút chỉ có khi grant của liên kết đủ quyền (FR-012); `callback_data` là `c:<card_id>`.
- [ ] T042 [US3] Xử lý `callback_query` tại `src/application/telegram/inbound.ts`: `answerCallbackQuery` ngay; thẻ không thuộc liên
  kết đang hoạt động thì hết hiệu lực; dịch thành `approve_escalation` hoặc `task_confirm` kèm `run_config_digest`, đi qua cùng
  đường `command_json` → `admitCommand` như T033; phản hồi theo bảng ở hợp đồng.

**Checkpoint US3**: T035–T037 đạt.

---

## Phase 6: User Story 4 - Thông báo cần chú ý và report theo yêu cầu (Priority: P2)

**Goal**: Báo khi task chờ người vì lý do khác và khi task kết thúc; `/inbox` phân trang, mở lại thẻ, `/report`, `/help`; inbox nhiều loại
dùng chung cho CLI và Telegram.

**Independent Test**: Phát chuỗi chuyển trạng thái (nhiều mã chờ người, DONE, FAILED, CANCELLED) và đếm tin; tạo hơn 100 mục chờ; gửi
`/inbox`, "Trang sau", "Mở", `/show`, `/report`, `/report 2d`, `/report` sai cú pháp; so với `cusr inbox --json` và `cusr report --json`.

### Tests for User Story 4

- [ ] T043 [P] [US4] Viết integration test trước tại `test/integration/runtime/inbox.test.ts` cho inbox mới theo
  [contracts/cli-daemon.md](contracts/cli-daemon.md#cusr-inbox): bốn `kind`; mục câu hỏi giữ mọi trường cũ; `actions` khớp
  `allowedActions`; `decider` là `null`, `"pending"` hoặc `"running"`; thứ tự `(project, task_id, kind, item_id)`; phân trang qua
  hơn 100 mục không sót, không lặp; project ngoài grant không xuất hiện. Sửa test inbox cũ ở
  `test/integration/runtime/questions.test.ts`, `test/integration/runtime/access-control.test.ts`,
  `test/integration/runtime/feature-002-cli.test.ts` chỉ ở chỗ đọc `truncated`.
- [ ] T044 [P] [US4] Viết integration test tại `test/integration/telegram/attention-report.test.ts`: mỗi lần chuyển sang chờ người
  vì mã không thao tác được trên Telegram có một tin; mỗi task kết thúc có một tin kèm PR và lý do; `/inbox` 8 mục mỗi tin với nút
  "Mở" và "Trang sau"; mở lại thẻ khi tin gốc đã xóa có đủ phạm vi và nút; `/report` mặc định `24h` khớp `cusr report`; report dài
  chia tối đa 5 tin rồi ghi đã cắt.

### Implementation for User Story 4

- [ ] T045 [US4] Mở rộng `inbox` tại `src/application/inbox.ts` dùng `openQuestions`, `needsUser` (`src/explain/needs-user.ts`) và
  `allowedActions` (`src/explain/allowed-actions.ts`); cursor mờ; `next_cursor` thay `truncated`; `telegram_actionable` tính theo
  grant của liên kết hiện tại; thêm `delivery` cho câu hỏi và yêu cầu (FR-027). Thêm `--cursor`, `--limit` vào lệnh `inbox` tại
  `src/cli/tasks.ts`.
- [ ] T046 [US4] Thêm `delivery` (`state`, `last_error`, `copies`, `answered_via`) vào kết quả `task explain` tại
  `src/application/queries.ts`; `answered_via` lấy từ `AuthzContext.issued_by` của event thắng (FR-027).
- [ ] T047 [US4] Mở rộng `deriveNotifications` cho `attention:<task>:v<version>:<code>` (chờ người với mã không thuộc câu hỏi,
  duyệt, xác nhận) và `finished:<task>` tại `src/application/notify/derive.ts`; `failed` của hai loại này là cuối.
- [ ] T048 [US4] Xử lý `/inbox`, `/show <mã>`, nút "Mở", nút "Trang sau", `/report [khoảng]`, `/help` tại
  `src/application/telegram/inbound.ts`: thẻ `open` và `page`; dùng cùng dịch vụ và quyền với `cusr inbox` và `cusr report`
  (`src/application/report.ts`, cú pháp khoảng như `src/cli/report.ts`); nội dung `reply`/`report` lưu trong `body_json` đã che
  secret.
- [ ] T049 [US4] Cập nhật `skills/cusr/SKILL.md` theo hợp đồng inbox mới (`kind`, `next_cursor`, `actions`) và mô tả lệnh
  `cusr telegram`.

**Checkpoint US4**: T043–T044 đạt; SC-008 phần inbox/report.

---

## Phase 7: User Story 5 - Kênh bền qua restart, lỗi mạng và hạn mức (Priority: P2)

**Goal**: Không mất thông báo hay câu trả lời, không xử lý hai lần qua restart, lỗi mạng, hạn mức, bot bị chặn; đợt gửi mới chỉ mở khi
có bằng chứng; liên kết mới nhận việc còn chờ.

**Independent Test**: Ma trận ngắt daemon có seed quanh mọi crash point của kênh; mô phỏng mất mạng dài, 429, 403, bot bị chặn rồi bỏ
chặn; liên kết khi đã có việc chờ; máy ngủ lâu (clock nhảy).

### Tests for User Story 5

- [ ] T050 [P] [US5] Viết reliability test tại `test/reliability/telegram-crash.test.ts` đọc `CUSR_SEED` và `CUSR_RUNTIME_KILLS`
  (mặc định 100) do `pnpm test:reliability` đặt, với child process (`test/support/child.ts`, `CUSR_CRASH_AT`, `CUSR_CRASH_AFTER`),
  ít nhất 100 seed tái hiện, phân bố quanh `after_notifications`, `after_try_mark`, `after_copy`, `after_updates`,
  `after_command_saved`, `after_setup_commit` và các crash point của `accept`; bắt buộc có các ca: giữa lưu envelope và admit, giữa
  admit và hoàn tất lệnh, giữa ghi file token và commit setup, giữa commit setup và dọn file cũ. Kiểm: 0 thông báo logic mất, 0
  update bỏ sót hay xử lý hai lần, 0 quyết định nhân đôi, tin trùng cùng mã, DB không bao giờ trỏ tới file token đã xóa (SC-004).
- [ ] T051 [P] [US5] Viết integration test tại `test/integration/telegram/recovery.test.ts` cho US5.1–US5.6 và Q13, Q14, Q18, Q20:
  đợt hết hạn sau 2 giờ tính từ lượt đầu kể cả thời gian daemon tắt; thông báo chưa thử lần nào vẫn gửi sau restart; bot nhận được
  tin mà không gửi được, hoặc restart, không mở đợt mới; `sendChatAction` thành công mở đúng một đợt cho mỗi việc thao tác được còn
  hiệu lực và mỗi bản tin còn nợ đồng bộ; thông báo thông tin đã thất bại không gửi lại; 429 dừng mọi lượt tới `retry_after`;
  `unlink` trong lúc request đang bay thì không bắt đầu request mới; task không đổi trạng thái vì lỗi kênh (SC-007, SC-011).
- [ ] T052 [P] [US5] Viết integration test tại `test/integration/telegram/relink-backlog.test.ts`: liên kết khi đã có câu hỏi, yêu cầu
  duyệt và xác nhận đang chờ thì chat nhận đủ, mỗi việc một tin; không có tin cho task đã kết thúc trước khi liên kết; liên kết lại
  chuyển việc còn chờ sang liên kết mới với đợt mới (FR-031, SC-011).

### Implementation for User Story 5

- [ ] T053 [US5] Triển khai bằng chứng hồi phục tại `src/daemon/telegram.ts` theo
  [R-05](research.md#r-05--bằng-chứng-hồi-phục-fr-030): đặt `send_failing_since` khi một đợt hết hạn, hoặc khi 3 lượt gửi/sửa liên
  tiếp (của bất kỳ thông báo nào) trả `unknown`, lỗi mạng hoặc 5xx, 429 không tính; `sendChatAction(chat, "typing")` với nhịp 1 phút
  nhân đôi tới trần 15 phút; mọi gửi/sửa thành công sau thời điểm thất bại cũng là bằng chứng; tăng `recovery_epoch` và mở đúng một
  đợt cho việc có `epoch_used < recovery_epoch` (FR-030).
- [ ] T054 [US5] Trong transaction liên kết thành công tại `src/application/telegram/inbound.ts`, chuyển mọi `question`, `approval`,
  `confirmation` còn hiệu lực sang `link_id` mới, `pending`, đợt mới; tạo thẻ mới theo liên kết mới (FR-031).
- [ ] T055 [US5] Bảo đảm vòng nhận/gửi chịu được clock nhảy và máy ngủ tại `src/daemon/telegram.ts`: không chạy dồn, offset không lùi,
  hạn mã và hạn đợt kiểm lại theo `Clock` sau khi thức (EC-010); thêm ca vào T051.

**Checkpoint US5**: T050–T052 đạt; SC-004, SC-007, SC-011 ghi vào acceptance report.

---

## Phase 8: Polish & nghiệm thu

**Purpose**: Tài liệu, SPEC, smoke với bot thật và báo cáo nghiệm thu.

- [ ] T056 [P] Cập nhật [SPEC.md](../../SPEC.md) §15.1 (lệnh `cusr telegram`, inbox mới, `task confirm --run-config` một accept) và
  §15.2 (Telegram là connector qua polling, grant riêng theo liên kết); đối chiếu §8.6b của
  [architecture](../../docs/architecture.md) và sửa chỗ lệch với spec.
- [ ] T057 [P] Viết hướng dẫn vận hành kênh tại `docs/telegram.md`: tạo bot bằng @BotFather, setup, liên kết, đổi quyền, đổi bot,
  thu hồi token khi nghi lộ, đọc `cusr telegram status` và doctor; liên kết từ `README.md`.
- [ ] T058 [P] Kiểm che secret (SC-009) tại `test/integration/telegram/secrets.test.ts`: token bot và chuỗi giống secret không có
  trong log, artifact, output CLI kể cả `--json`, `notifications.body_json`, `tg_updates.payload_json`, `tg_updates.command_json`.
- [ ] T059 Chạy smoke với bot thật theo [quickstart](quickstart.md#smoke-với-bot-thật), bước 1–7, bấm giờ SC-001 và SC-002; ghi kết
  quả từng bước hoặc "chưa kiểm" kèm lý do vào `specs/003-telegram-channel/acceptance-report.md`.
- [ ] T060 Ánh xạ test mới vào bất biến I03, I04, I08, I10 trong `test/invariants.map.ts` theo tầng hiến chương VII yêu cầu
  (store/outbox bằng integration SQLite thật kèm crash injection, không dùng property test của engine); chạy `pnpm
  report:invariants` và ghi kết quả.
- [ ] T061 Hoàn thiện `specs/003-telegram-channel/acceptance-report.md`: bảng SC-001–SC-011 với bằng chứng, phân biệt Telegram giả
  lập với bot thật (SC-010); hồi quy feature 001, 002, 004 qua CI.

---

## Truy vết yêu cầu

| Yêu cầu | Task |
| --- | --- |
| FR-001 | T009, T022, T027, T040, T047 |
| FR-002, FR-003 | T029, T050, T051 |
| FR-004 | T029 |
| FR-005 | T027, T040, T047 |
| FR-006 | T023, T029 |
| FR-007 | T051 |
| FR-008 | T011, T013, T015, T018 |
| FR-009, FR-010, FR-011 | T014, T016, T020 |
| FR-012 | T022, T041 |
| FR-013 | T019, T050 |
| FR-014 | T025, T033 |
| FR-015, FR-016, FR-017 | T033, T037, T041, T042, T048 |
| FR-018 | T014, T019 |
| FR-019 | T037 |
| FR-020, FR-021 | T026, T027, T028 |
| FR-022 | T030, T032 |
| FR-023, FR-025 | T008, T048 |
| FR-024 | T043, T045, T048 |
| FR-026 | T012, T021 |
| FR-027 | T045, T046 |
| FR-028 | T019, T029, T050 |
| FR-029 | T021, T022 |
| FR-030 | T051, T053 |
| FR-031 | T052, T054 |
| SC-001, SC-002 | T012, T024, T059 |
| SC-003 | T025, T037 |
| SC-004 | T050, T060 |
| SC-005 | T035, T036, T037 |
| SC-006 | T014, T058 |
| SC-007, SC-011 | T051, T052 |
| SC-008 | T024, T044 |
| SC-009 | T058 |
| SC-010 | T002, T059, T061 |

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** không phụ thuộc gì. **Phase 2** cần Phase 1 (T001) và chặn mọi story.
- **US1 (Phase 3)** cần Phase 2. **US2 (Phase 4)** cần US1, vì thông báo chỉ sinh khi có liên kết.
- **US3 (Phase 5)** cần US2 (vòng gửi, đường `command_json`, thẻ). **US4 (Phase 6)** cần US2; độc lập với US3 ngoài file
  `derive.ts` và `inbound.ts` dùng chung.
- **US5 (Phase 7)** cần US2; nên làm sau US3 và US4 để ma trận crash phủ mọi loại thông báo.
- **Phase 8** cần mọi story.

### Within Each Story

- Test viết trước và phải thất bại trước khi triển khai.
- `derive.ts` → hook → vòng gửi; phân loại update → xử lý update; thẻ → xử lý callback.

### Parallel Opportunities

- Phase 2: T006, T007, T008 song song sau T003–T005.
- Mỗi story: các task test `[P]` song song với nhau.
- Phase 8: T056, T057, T058 song song.

## Parallel Example: User Story 2

```text
T022 test/unit/application/notify/derive.test.ts
T023 test/property/notify-order.test.ts
T024 test/integration/telegram/questions.test.ts
T025 test/integration/telegram/replay.test.ts
T026 test/property/decider-failure.test.ts + test/integration/runtime/decider.test.ts
```

## Implementation Strategy

### MVP

Phase 1 → Phase 2 → US1 → US2: một vòng hỏi đáp dùng được trên điện thoại. Dừng và kiểm US2 với bot thật trước khi đi tiếp.

### Incremental Delivery

Mỗi phase một PR theo thứ tự trên. US3 gỡ duyệt và xác nhận; US4 cho bức tranh đủ trên điện thoại; US5 khóa các cam kết bền vững; Phase
8 nghiệm thu với bot thật.
