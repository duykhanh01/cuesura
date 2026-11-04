# Nghiên cứu thiết kế feature 006

Ngày đối chiếu: 2026-11-04, mã nền tại commit `906d124`. Đây là quyết định thiết kế và danh sách bằng chứng cần thu; chưa
có phần nào của feature được chạy thật. Giả định về vendor đã được spike kiểm chứng ở [spike-report.md](spike-report.md),
trừ S1 (xem [R-12](#r-12--spike-trước-khi-code)).

**Nguyên tắc nền (chốt sau spike):** cusr chỉ dùng tài khoản do chính nó đăng nhập vào thư mục nó quản lý và chỉ ghi vào
thư mục đó; không dùng chung credential với phiên tương tác hay công cụ khác như Orca. Ngoại lệ duy nhất là tài khoản kế
thừa khi nâng cấp, chỉ đọc (R-11).

## Hiện trạng liên quan

| Chủ đề | Mã hiện tại |
| --- | --- |
| Credential | `runtime.credential_refs` trong user config ánh xạ tên → đường dẫn tuyệt đối (`src/config/schema-user.ts:365`), đóng băng vào snapshot (`src/config/freeze.ts:144`); đổi giá trị đòi restart daemon (`hostBound()`, `src/daemon/production.ts:102`) |
| Pin | `home_files: [{credential, to}]` không có digest vì auth tự xoay (`src/runner/harness-records.ts:373`); `environmentHash` gồm tên credential và `to`, không gồm nội dung (`src/application/capabilities.ts:242`) |
| Private home | `installAuth` từ chối symlink, chép `COPYFILE_EXCL` rồi `chmod 0600`; `removeAuth` xóa sau khi artifact đã ghi (`src/runner/private-home.ts:103-187`, `src/runner/invocation.ts:557`). Không có gì được chép ngược về nguồn |
| Recovery | Run `finished` gọi `Invocation.recover` rồi `removeAuth`; run `lost` không gọi, auth nằm lại tới khi retention xóa thư mục run (30 ngày) |
| Phân loại lỗi | `rate_limited` và `overloaded` cùng ánh xạ sang lớp `rate_limit`; `auth` sang `auth_config` (`src/daemon/handlers.ts:659`). Claude cho `reset_at` từ `rate_limit_event`; Codex luôn `null` |
| Chờ hạn mức | Mỗi task tự đặt timer `backoff` (`src/engine/failure.ts:246`); không có khóa toàn daemon dù SPEC §6.2 nói có |
| Slot | Một slot thực thi toàn daemon; task chờ cooldown nhả slot (`src/engine/runtime.ts:218`) |
| Event | Mọi event gắn task (`events.task_id NOT NULL`); trạng thái không gắn task duy nhất là `command_ledger` |
| Quyền | `REQUIRED_ROLE` theo kind lệnh (`src/application/commands.ts:37`); token có `roles` và `projects` (`src/application/access-tokens.ts`) |
| Danh tính vendor | Không có; chỉ có regex che `access_token`, `refresh_token`, `id_token` |
| Thông báo | Inbox chỉ liệt kê câu hỏi; report theo task; chưa có outbox hay thông báo không phải câu hỏi |

## R-01 — Nơi lưu tài khoản và trạng thái

- **Decision:** Khai báo tài khoản và trạng thái nằm trong SQLite do daemon ghi. Thêm luồng event toàn cục
  `account_events` với `account_seq` riêng; projection `accounts`, `account_blocks`, `account_cooldowns` dựng từ luồng này.
  Trigger của task có thể sinh event tài khoản trong cùng transaction `accept` qua một hook ở tầng store; lệnh `cusr
  account …` đi đường `accept` riêng không gắn task.
- **Rationale:** Trạng thái phải dùng chung mọi task, bền qua restart, có actor và lý do (FR-008, FR-017), và chỉ daemon
  được ghi (hiến chương II). Luồng event cho replay và `verify-projections` giống task. Để trong DB thay vì file cấu hình
  thì thêm tài khoản không cần restart daemon (SC-005).
- **Alternatives considered:**
  - **Giữ trong `credential_refs` của user config:** đổi cấu hình phải restart daemon và không lưu được trạng thái nghỉ.
  - **Bảng trạng thái không có event:** mất audit, không replay được, khó chứng minh FR-016 (hai báo gộp thành một).
  - **Gắn vào state từng task:** không chia sẻ được cooldown giữa task.

## R-02 — Điểm chọn tài khoản

- **Decision:** Chọn trong handler effect `start_agent` (`src/daemon/handlers.ts`), sau khi task đã có slot. Engine đưa vào
  request của effect `harness` và `round.tried` (tài khoản đã thử trong vòng). Handler gọi hàm thuần `selectAccount` trên
  projection hiện tại và `now`:
  - Có tài khoản: chạy với nguồn credential của nó và ghi `account_id` vào fact khởi chạy; engine ghi `AccountSelected`.
  - Không có: trả `effect_failed` lớp `accounts_unavailable`, `invoked: false`, kèm `earliest_ready_at` (nếu có tài khoản
    tự hồi được) và danh sách nguyên nhân chặn theo tài khoản. Engine nhả slot và chờ theo FR-014.
- **Rationale:** Đây là điểm muộn nhất trước khi spawn nên thao tác của người dùng luôn thắng (FR-010, Q5). Lựa chọn nằm
  trong trigger đã ghi nên replay không tính lại (FR-017). Không phải sửa thuật toán cấp slot.
- **Alternatives considered:**
  - **Chọn lúc cấp slot (`grantNext`):** phải gắn harness vào hàng đợi slot và tách việc từ chối slot khỏi chờ tài khoản;
    phức tạp hơn mà không có lợi vì task không có tài khoản sẽ nhả slot ngay.
  - **Engine tự chọn:** engine phải đọc projection toàn cục, vi phạm tính thuần trừ khi đưa cả projection vào input.

## R-03 — Pin, manifest và proof

- **Decision:** Không đổi định dạng pin. Mục `home_files[].credential` của pin chỉ còn là chỗ đặt credential: lúc chạy,
  nguồn của mục đó được thay bằng nguồn của tài khoản được chọn. Tài khoản mặc định khi nâng cấp chính là `credential_refs`
  mà pin đang trỏ (FR-003). `environmentHash` giữ nguyên nên manifest và proof hiện có vẫn hợp lệ.
- **Rationale:** Proof `private_home_auth` kiểm việc cài và xóa auth, không phụ thuộc tài khoản cụ thể. Đổi định dạng pin
  sẽ đòi proof lại mọi harness, trái FR-003 và FR-004.
- **Alternatives considered:** Đổi pin thành `{account_slot: true, to}`: rõ nghĩa hơn nhưng đổi `environmentHash`, buộc
  proof lại. Có thể làm sau khi pin có version mới vì lý do khác.

## R-04 — Phân loại lỗi

- **Decision:**
  - Giữ `kind` của lỗi harness trong `FailureData` (thêm trường `harness_kind`). Chỉ `rate_limited` làm tài khoản nghỉ;
    `overloaded` vẫn đi lớp `rate_limit` của task với backoff hiện tại, không đổi tài khoản.
  - `auth` vẫn ánh xạ `auth_config`, nhưng khi attempt có `account_id` thì xử lý theo FR-018: handler đọc digest nguồn hiện
    tại, so với digest lúc cài trong `launch-state.json` và gửi `source_changed`.
  - `capability_missing` giữ nguyên hành vi `auth_config` hiện tại, không gắn tài khoản.
- **Rationale:** 529/5xx là quá tải phía vendor, không thuộc subscription nào; làm tài khoản nghỉ vì nó sẽ khóa nhầm mọi
  task. Digest so sánh được mà không đưa nội dung ra khỏi runner.
- **Alternatives considered:** Coi `overloaded` như hết hạn mức của tài khoản: đơn giản hơn nhưng sai nghĩa và làm chuyển
  tài khoản vô ích hàng loạt khi vendor quá tải.

## R-05 — Chờ, đánh thức và vòng thử

- **Decision:**
  - **Vòng thử:** `TaskState.account_round = {step, harness, tried[]}`. Mỗi `AccountSelected` thêm tài khoản vào `tried`;
    vòng mở mới (xóa `tried`) khi task được đánh thức sau chờ, khi đổi bước, hoặc khi attempt chạy không lỗi hạn mức/auth.
  - **Lý do chờ mới:**

    | `DetailCode` | `WaitReason` | Cần người | Khi nào | Điều kiện tiếp tục |
    | --- | --- | --- | --- | --- |
    | `accounts_cooling` | `rate_limit` | Không | Còn tài khoản tự hồi được vì nghỉ | Timer tới `earliest_ready_at`, hoặc `account_ready` |
    | `accounts_pending_write` | `infra` | Không | Chỉ còn tài khoản chờ ghi credential | Timer backoff `infra`, hoặc `account_ready` |
    | `accounts_blocked` | `human_input` | Có | Mọi tài khoản lỗi đăng nhập, đổi danh tính, tạm ngưng hoặc không còn | `account_ready` sau thao tác của `admin` |

    Hết vòng mà mọi mốc hồi đã qua thì dùng `planBackoff` của lớp `rate_limit` làm mốc chờ (FR-016, Q18).
  - **Timer:** tái dùng kind `backoff` với payload `{step, resume}` như hiện nay; `due_at` là mốc hồi sớm nhất.
  - **Đánh thức chỉ theo thay đổi mới:** khi task vào một trong ba lý do chờ, wait ghi `accounts_watermark` = `account_seq`
    lớn nhất đã thấy lúc `selectAccount` trả "không có". Mỗi vòng scheduler, sau `fireTimers`, chỉ xét event tài khoản có
    `account_seq` > watermark và thuộc loại làm tăng khả dụng: `AccountAdded`, `AccountResumed`, `AccountCooldownCleared`,
    `AccountAuthRestored`, `AccountRelogged` (đăng nhập lại gỡ `auth_error`; `check` nhận danh tính mới gỡ
    `identity_changed`), `AccountWriteSettled` gỡ `pending_write`, `AccountPrioritySet` từ `use`. Mỗi event được mở rộng
    thành **tập tài khoản bị ảnh hưởng**: event cooldown (`AccountCooldownCleared`) ảnh hưởng mọi tài khoản cùng
    `cooldown_key`, ở mọi harness (FR-012, Q9); các event khác chỉ ảnh hưởng chính tài khoản đó. Với mỗi task đang chờ, nếu
    tập đó có tài khoản thuộc harness của task và chọn được ở vòng mới thì `submit` trigger `account_ready` với khóa dedup
    `account_ready:<task>:<wait_seq>:<account_seq>`. Ví dụ xóa nghỉ qua A (harness `claude`) cũng đánh thức task đang chờ B
    (harness `claude-opus`) khi A và B cùng subscription. Cooldown tự hết hạn không phải event, nên chỉ timer của task đánh thức
    nó. Nhờ vậy trường hợp Q18 (mọi `reset_at` đã qua, tài khoản "sẵn sàng" nhưng vừa thử hết) không bị scheduler mở vòng
    ngay mà chờ hết backoff.
- **Rationale:** Dùng lại timer và mẫu trigger dedup có sẵn; lý do chờ có điều kiện tiếp tục rõ (hiến chương III). Watermark
  phân biệt "có thay đổi khả dụng mới" với "tài khoản đã sẵn sàng nhưng vừa thử hết" mà không cần đọc đồng hồ trong engine.
- **Alternatives considered:** Timer toàn cục theo tài khoản phát cho mọi task: cần thêm kind timer không gắn task, trong khi
  bảng `timers` đang khóa theo `task_id`.

## R-06 — Ghi credential về nguồn

- **Decision:** Runner theo dõi file credential trong private home suốt attempt (`fs.watch` cộng quét định kỳ vài giây làm
  dự phòng) và chạy thủ tục dưới đây **mỗi khi file đổi**, rồi chạy thêm một lần trước `removeAuth` ở mọi đường kết thúc và
  trong recovery:
  1. Lúc cài, ghi `source_digest` (SHA-256 nguồn) và `installed_digest` vào `launch-state.json`; sau mỗi lần ghi về
     thành công, `source_digest` được cập nhật thành digest vừa ghi.
  2. Đọc bản trong private home. Với Codex, đọc trong khi giữ `flock` trên `auth.lock` của private home vì Codex ghi đè
     tại chỗ; với Claude, file được thay bằng `rename` nên đọc trực tiếp là nguyên vẹn (spike, Phần 2b).
  3. Không phải file thường, rỗng, sai định dạng vendor, hoặc khác danh tính tài khoản thì không chép và báo `rejected`
     (FR-024). Spike cho thấy bên thua khi làm mới đồng thời của Claude để lại token rỗng; trường hợp này rơi vào đây.
  4. Digest bằng digest đã ghi gần nhất thì không làm gì (Story 3 kịch bản 2).
  5. Lấy khóa của cusr cho tài khoản (R-13); đọc digest nguồn. Khác `source_digest` thì bỏ bản của attempt, báo
     `superseded` (FR-023).
  6. Ghi tmp `0600` cùng thư mục nguồn, fsync, rename đè nguồn, fsync thư mục, rồi nhả khóa. Lỗi I/O thì chuyển bản mới
     vào `<DATA_DIR>/accounts/<id>/pending/` (`0600`, thư mục `0700`) và báo `pending` (FR-022a).
  7. Kết quả (`unchanged`, `written`, `superseded`, `rejected`, `pending`, `account_missing`) đi qua fact của runner;
     daemon ghi event tài khoản tương ứng.

  Daemon thử lại bản chờ ghi trong vòng scheduler với backoff `infra`, chạy lại bước 5–6 từ đầu (lấy khóa trước). Thư mục
  tài khoản đã bị xóa thì không tạo lại (`account_missing`). Tài khoản mặc định không bao giờ chạy bước 5–6.
- **Rationale:** Ghi ngay khi đổi là bắt buộc cho FR-018: với Claude, bên thua lỗi auth ngay lúc làm mới, nên bản của bên
  thắng phải nằm trong nguồn trước khi daemon xét `source_changed`. Rename nguyên tử không bao giờ để file hỏng (SC-004).
  CAS theo digest không cần biết bản nào mới hơn (FR-023). Chỉ cusr ghi vào thư mục tài khoản nên khóa của cusr là đủ.
- **Alternatives considered:**
  - **Chỉ ghi lúc attempt kết thúc:** đánh dấu nhầm lỗi đăng nhập ở trường hợp làm mới đồng thời của Claude (spike).
  - **Ghi vào file của công cụ khác (Orca, `~/.claude`):** phải phối hợp với khóa của từng vendor và vẫn còn cửa sổ ghi đè
    khi Orca tự thay `auth.json` không lấy khóa (spike, Phần 2c). Bị loại theo nguyên tắc nền.

## R-07 — Danh tính vendor

- **Decision:** Adapter cung cấp `identityOf(account dir) → {key, label}`, không gọi mạng:
  - **Claude:** `oauthAccount.accountUuid` và `organizationUuid` trong `.claude.json` của thư mục cấu hình tài khoản
    (`.credentials.json` không chứa danh tính, spike S3). Khóa danh tính gồm cả tổ chức, vì cùng một người có thể dùng
    subscription của hai tổ chức với hạn mức khác nhau.
  - **Codex:** `tokens.account_id` trong `auth.json`.

  `key` lưu dạng SHA-256 của `vendor:id`, `label` (email rút gọn, tên tổ chức) chỉ trả cho `admin`. Vì tài khoản được đăng
  nhập vào thư mục riêng của cusr, danh tính luôn đọc được; `null` chỉ xảy ra với tài khoản mặc định thiếu `.claude.json`,
  khi đó tài khoản nghỉ riêng (FR-012).

  Tài khoản mặc định đi theo đăng nhập trên máy: danh tính đọc được khác `identity_key` thì nó bị chặn `identity_changed`,
  và `account_check` trên nó ghi `AccountRelogged` với danh tính mới rồi gỡ chặn (FR-005a). Tài khoản dự phòng không bao
  giờ đổi danh tính vì chỉ cusr ghi vào thư mục của nó.
- **Rationale:** Đọc file cục bộ nhanh, không tốn quota, không đưa token ra khỏi runner. Băm tránh lưu mã tài khoản thô.
- **Alternatives considered:** Gọi API profile của vendor: tốn mạng và có thể làm mới token ngoài tầm kiểm soát.

## R-08 — Đăng nhập vào thư mục quản lý

- **Decision:** `cusr account add <harness> --name <n>` và `cusr account login <harness> <n>` chạy trong process CLI có
  TTY:
  1. Tạo thư mục tạm `<DATA_DIR>/accounts/staging/<uuid>/` (`0700`).
  2. Chạy luồng login của vendor vào đó: `HOME=<staging> claude auth login` hoặc
     `CODEX_HOME=<staging> codex login --device-auth` (spike S4).
  3. Kiểm credential sinh ra (`validate`, `identityOf`).
  4. `add`: gửi `account_add` kèm `staging_id`. Daemon kiểm thư mục tạm, commit `AccountAdded` (payload có
     `staging_id`), **rồi** rename thư mục tạm thành `<DATA_DIR>/accounts/<account_id>/home` và tạo `lock.sqlite`. I/O
     file nằm ngoài transaction `accept` (hiến chương II). Crash giữa commit và rename: lúc khởi động, daemon thấy tài
     khoản `managed` thiếu `home` mà thư mục tạm có `staging_id` đó còn thì rename nốt. Thư mục tạm không được event nào
     tham chiếu và cũ hơn 24 giờ thì bị xóa.
     `login`: danh tính phải trùng tài khoản. Daemon thay credential theo cùng thủ tục khóa + CAS của R-06, với
     `source_digest` là digest đọc được khi lệnh bắt đầu, **rồi** mới commit `AccountRelogged`. Crash giữa hai bước:
     CLI gửi lại cùng `request_id`, daemon thấy digest nguồn đã bằng digest bản trong thư mục tạm thì coi là đã ghi
     (như recovery của R-06) và commit. Thư mục tạm chỉ bị xóa sau khi commit.
  5. Thất bại ở bất kỳ bước nào thì xóa thư mục tạm, không có tài khoản hay credential nào bị đổi.
- **Rationale:** cusr không tự làm OAuth; luồng login cần terminal của người dùng nên chạy trong CLI. Đăng nhập vào thư mục
  tạm rồi mới thay nên một lần login hỏng không bao giờ phá tài khoản đang chạy (cách Orca làm với đăng nhập lại Codex).
- **Alternatives considered:** Daemon chạy login: daemon không có TTY.

## R-09 — Quyền và lọc dữ liệu

- **Decision:** Kind mới `account_add`, `account_login`, `account_remove`, `account_suspend`, `account_resume`, `account_clear_cooldown`,
  `account_set_priority`, `account_use`, `account_check`, `account_retry_write` đều `REQUIRED_ROLE: admin`, `project:
  null`. `account_check` là "kiểm tra lại" của FR-018 và là một effect như mọi effect khác (hiến chương II):
  1. Lệnh được nhận trong transaction và ghi `AccountCheckRequested` với `check_id` = `request_id`.
  2. Sau commit, daemon chạy probe qua runner: kiểm nguồn như `add`, đọc danh tính, rồi gọi harness một lần ngắn
     bằng model rẻ trong private home tạm, như proof hiện dùng. Probe có timeout và đi qua ghi credential về (R-06)
     như một attempt.
  3. Kết quả quay về bằng trigger, dedup theo `check_id`, và ghi `AccountCheckCompleted{ok | failed, problem}`. Đạt thì
     ghi thêm `AccountAuthRestored`; với tài khoản `system` có `identity_changed` thì ghi `AccountRelogged` với danh tính
     mới.
  4. Restart khi probe chưa có kết quả thì chạy lại probe. Probe chỉ đọc nguồn, và ghi về nếu có thì dùng CAS, nên chạy
     lại an toàn.

  CLI chờ kết quả bằng query tới khi có `AccountCheckCompleted` hoặc hết thời gian chờ; hết giờ thì in `pending` và
  exit 0, `admin` xem lại bằng `account list`. Query
  `account_list` cần `read`; handler lọc số attempt, lần dùng gần nhất và task theo `projects` của token; danh tính, đường dẫn
  nguồn và lỗi filesystem chỉ khi token có `admin`. Cùng bộ lọc dùng cho report, TUI và thông báo.
- **Rationale:** Tài khoản ảnh hưởng mọi project (Q3); thông tin dùng của project khác không được lộ (Q10).

## R-10 — Thông báo và đợt hết hạn mức

- **Decision:** Projection `account_episodes` theo harness: mở khi một task nhận `accounts_cooling` lần đầu trong lúc mọi
  tài khoản không bị chặn vì lý do khác đều nghỉ; đóng khi `selectAccount` có kết quả cho harness đó. Bảng `notices` có một
  hàng mỗi đợt (`notice_id` = id đợt), nội dung dựng từ projection mỗi lần đọc, `version` tăng khi tập task hay mốc hồi đổi,
  `state` = `open|resolved`. Report thêm mục `notices`; TUI hiện ở màn chính. Feature 003 sẽ đọc `notices` theo `version` để
  sửa tin đã gửi; đợt đóng trước khi gửi thì 003 bỏ qua (Q15).
- **Mục tài khoản trong inbox (FR-018):** query `inbox` thêm loại mục `account`, dựng lúc đọc từ `account_blocks`, mỗi
  tài khoản có `auth_error`, `identity_changed` hoặc `pending_write` một mục, kèm lệnh gợi ý (`check`, `login`,
  `retry-write`). Mục không đòi trả lời, tự biến mất khi nguyên nhân được gỡ, và chỉ hiện cho token có `admin` vì nó nêu
  danh tính và lỗi filesystem (FR-007). Không có bảng mới.
- **Rationale:** Dựng nội dung lúc đọc giúp lọc theo quyền và luôn mới nhất mà không phải lưu văn bản. Thông báo đợt không
  vào inbox vì nó không đòi ai làm gì; mục tài khoản thì có, vì cần `admin` sửa.

## R-11 — Tài khoản mặc định

- **Decision:** Khi daemon khởi động (daemon chỉ nạp pin lúc này, `src/daemon/production.ts`), với mỗi harness có pin trỏ tới credential mà
  chưa từng có tài khoản mặc định (không có `AccountAdded` với `source_kind: system` cho harness đó, kể cả đã gỡ): tạo tài
  khoản **mặc định** `default` (actor `system`, `source_kind: system`, `priority: 0`) trỏ tới
  `credential_refs[pin.home_files[].credential].file`. Áp dụng cả khi nâng cấp lẫn khi cài mới. Tài khoản mặc định chạy
  giống hệt trước (SC-006): chỉ đọc, không ghi về, không xóa khi gỡ, không `account_login` được. Ưu tiên bằng nhau thì nó
  đứng trước tài khoản dự phòng (FR-002), nên thêm tài khoản dự phòng không đổi tài khoản đang dùng. Nó bị đăng xuất
  (lỗi auth không do nguồn đổi) thì bị chặn `auth_error` và task chuyển sang dự phòng; người dùng đăng nhập lại trên máy
  rồi `account check`. `doctor` ghi chú rằng nó dùng chung credential với phiên tương tác. Không có credential trong pin
  thì không tạo và giữ lỗi cấu hình hiện có.
- **Rationale:** Người dùng hiểu ngay: tài khoản đang đăng nhập trên máy là tài khoản chính, tài khoản thêm vào là dự
  phòng. Không phải sửa cấu hình hay tạo lại pin, và cusr không bắt đầu ghi vào file của người dùng. Rủi ro đăng xuất
  phiên tương tác vẫn như trước feature này, nhưng task không còn kẹt vì đã có dự phòng.
- **Alternatives considered:**
  - **Coi nó là tài khoản kế thừa tạm thời, ưu tiên tài khoản dự phòng trước, khuyên gỡ:** ít rủi ro đăng xuất hơn nhưng
    khó hiểu (thêm một tài khoản lại đổi tài khoản đang dùng); chủ dự án chọn đơn giản.
  - **Ghi về `~/.claude/.credentials.json` để sửa luôn lỗi đăng xuất:** vi phạm nguyên tắc nền và phải phối hợp khóa với
    phiên tương tác.
  - **Chỉ tạo khi nâng cấp:** cài mới sau 006 sẽ có hành vi khác người nâng cấp.

## R-12 — Spike trước khi code

Kết quả chi tiết ở [spike-report.md](spike-report.md).

| Spike | Câu hỏi | Kết quả | Quyết định |
| --- | --- | --- | --- |
| S1 | Claude resume được session do tài khoản khác tạo? | **Chưa chạy** (thiếu tài khoản Claude phụ thứ hai) | Giữ dự phòng: chuyển tài khoản bắt đầu session mới qua `resume_fallback` nếu resume lỗi; chạy S1 trước lát B |
| S2 | Làm mới token trong lúc chạy và làm mới đồng thời | Cả hai vendor xoay refresh token. Claude: đồng thời thì một bên thua và để lại token rỗng; dùng lại token đã tiêu bị từ chối, không thu hồi cả họ. Codex: mọi lần đều thành công trong khoảng đã thử | Ghi về ngay khi đổi (R-06); `validate` từ chối token rỗng; giữ FR-020 (không xếp nối tiếp attempt cùng tài khoản) |
| S3 | Danh tính | Claude: `accountUuid`/`organizationUuid` trong `.claude.json`; Codex: `tokens.account_id`. Phân biệt được tài khoản, phát hiện được trùng | R-07 |
| S4 | Login vào thư mục chỉ định | Đạt với `claude auth login` và `codex login --device-auth` | R-08 |
| S5 | Cách vendor và Orca ghi credential | Claude: rename dưới thư mục khóa `.storage-write.lock`; Codex: ghi đè tại chỗ dưới `flock auth.lock`; Orca tự ghi `auth.json` không lấy khóa | Không còn quyết định thiết kế nào phụ thuộc S5 vì cusr không ghi file của bên khác; chỉ dùng `flock` của Codex khi đọc private home (R-06) |

## R-13 — Khóa nguồn credential

- **Decision:** Chỉ cusr ghi vào thư mục tài khoản (runner ghi về, daemon thử lại bản chờ, `cusr account login`), nên một
  khóa của cusr là đủ. Mỗi tài khoản có file khóa cố định `<DATA_DIR>/accounts/<account_id>/lock.sqlite`, tạo một lần, không
  bao giờ bị xóa hay đổi tên khi tài khoản còn. Bên ghi mở bằng `better-sqlite3` (có sẵn trong baseline), đặt `busy_timeout`
  5 giây và `BEGIN EXCLUSIVE`; SQLite giữ khóa bằng khóa bản ghi `fcntl` của kernel. Giữ transaction suốt bước kiểm digest
  và ghi, rồi `ROLLBACK` và đóng. Process chết thì kernel tự nhả khóa nên không có thủ tục thu hồi. Hết `busy_timeout` thì
  trả `pending: lock_timeout`; lần thử lại lấy khóa từ đầu. File khóa không chứa trạng thái miền và không phải kho trạng
  thái của daemon.
- **Rationale:** Khóa tự nhả khi process chết đáp ứng yêu cầu khôi phục của hiến chương II và không để tài khoản kẹt
  `pending_write` (III), mà không thêm dependency.
- **Alternatives considered:**
  - **File khóa `O_EXCL`/`link()` có danh tính chủ và thu hồi bằng rename:** thu hồi đồng thời có thể di chuyển khóa mới
    của bên khác (review lần 2).
  - **Khóa của vendor (`.storage-write.lock`, `flock auth.lock`) ở nguồn:** chỉ cần khi có writer ngoài cusr; không còn
    trường hợp đó.
- **Bằng chứng cần thu:** contract test với nhiều process thật cùng lấy khóa, giết process đang giữ khóa giữa bước ghi, và
  hai process cùng chờ khóa của process vừa chết; mỗi lần chỉ một bên ghi.
