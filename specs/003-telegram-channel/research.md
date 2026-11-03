# Nghiên cứu thiết kế feature 003

Ngày đối chiếu: 2026-11-03, mã nền tại commit `bf59cdc` của `main`. Hành vi Telegram lấy từ
[Bot API](https://core.telegram.org/bots/api) và [Bot features](https://core.telegram.org/bots/features) cùng ngày. Đây là
quyết định thiết kế và bằng chứng cần thu khi triển khai; chưa có phần nào của kênh được chạy thật.

## R-01 — Gọi Telegram Bot API

- **Decision:** Một adapter nhỏ `src/adapters/telegram/` gọi Bot API qua HTTPS bằng `fetch` có sẵn của Node 24, sau port
  `TelegramPort` gồm `getMe`, `getWebhookInfo`, `deleteWebhook`, `getUpdates`, `sendMessage`, `editMessageText`,
  `answerCallbackQuery`, `sendChatAction`. Mỗi lời gọi có `AbortSignal` với timeout riêng. Gốc URL đổi được bằng biến môi
  trường nội bộ `CUSR_TELEGRAM_API_BASE`, chỉ để test trỏ vào server giả lập.
- **Rationale:** Cần khoảng tám method, đều là POST JSON. Thư viện bot (grammY, Telegraf) mang theo vòng lặp, middleware và
  session riêng, trong khi vòng lặp, chống lặp và lưu bền ở đây phải do daemon giữ để đáp ứng FR-013 và FR-028. Không thêm
  dependency nên không phải sửa baseline SPEC §17.2.
- **Alternatives considered:** grammY (vòng lặp riêng, khó chèn ghi bền giữa nhận và tiến offset); Telegraf (như trên,
  nặng hơn); `node-telegram-bot-api` (dựa vào `request` cũ, polling tự tiến offset).
- **Sự thật về Bot API dùng trong thiết kế:**
  - `getUpdates(offset)` xác nhận mọi update có ID nhỏ hơn `offset`; Telegram giữ update chưa nhận tối đa 24 giờ.
    `update_id` tăng dần; không có update trong một tuần thì ID kế tiếp có thể ngẫu nhiên.
  - `getUpdates` không chạy khi bot có webhook; hai tiến trình cùng long poll một bot thì một bên nhận lỗi 409.
  - Mỗi update chứa tối đa một trong `message`, `edited_message`, `callback_query`, ...
  - Tin nhắn tối đa 4096 ký tự; `callback_data` tối đa 64 byte; lỗi hạn mức trả `parameters.retry_after`.
  - Deep link `https://t.me/<bot>?start=<payload>` gửi `/start <payload>`; payload chỉ gồm `A-Z a-z 0-9 _ -`, tối đa
    64 ký tự.
  - Telegram không có API tra tin bot đã gửi, nên lượt gửi không rõ kết quả không probe được (SPEC.md §13.2, hàng
    Comment/sync/notify).
- **Bằng chứng cần thu:** smoke với bot thật xác nhận 409 khi hai poller, mã lỗi của `editMessageText` khi tin đã xóa
  (`message to edit not found`) và khi không đổi (`message is not modified`).

## R-02 — Nơi lưu thông báo

- **Decision:** Thông báo không phải effect. Thêm bảng nguồn sự thật riêng (migration 006): `tg_channel`, `tg_links`,
  `tg_link_codes`, `notifications`, `message_copies`, `action_cards`, `tg_updates`. Chi tiết ở [data model](data-model.md).
- **Rationale:** Bảng `effects` và `timers` chỉ là projection của event theo task: `task_id` bắt buộc, `projectEffects` lỗi
  khi state thiếu effect, và `verifyProjections` dựng lại hai bảng từ event log rồi chặn dispatch nếu lệch. Thông báo report,
  phản hồi thao tác và trạng thái gửi lại không thuộc task nào, và trạng thái gửi (lượt, đợt, bản tin) không dựng lại được
  từ event. `command_ledger` là tiền lệ có sẵn cho bảng nguồn sự thật không theo task và nằm ngoài verify.
- **Alternatives considered:**
  - Effect `notify` theo task: không chứa được report và phản hồi; mỗi lần gửi lại hay đồng bộ trạng thái cuối phải thành
    event của task, làm log task phình theo tình trạng mạng.
  - Một bảng chung lưu JSON: ít migration hơn nhưng mất unique constraint cho khóa thông báo, `update_id` và liên kết đang
    hoạt động, là những chỗ hiến chương yêu cầu chống lặp bằng ràng buộc SQLite.

## R-03 — Tạo thông báo trong cùng transaction với sự kiện

- **Decision:** `accept()` nhận thêm một hook tùy chọn `afterProject(tx, before, after, events)` chạy sau projection và
  trước khi ghi `accepted_triggers`, trong cùng `BEGIN IMMEDIATE`. Hook do tầng application cung cấp
  (`src/application/notify/derive.ts`): hàm thuần tính danh sách thông báo từ cặp state trước/sau, rồi chèn bằng
  `INSERT ... ON CONFLICT(key) DO NOTHING`. Hook đọc liên kết đang hoạt động ngay trong transaction; không có liên kết thì
  không tạo gì (FR-029). Thêm crash point `after_notifications`.
- **Loại thông báo** suy từ state, không từ tên event: `question` (câu hỏi mở mới), `approval` (yêu cầu duyệt escalation
  mới), `confirmation` (task chờ xác nhận có đề xuất cấu hình), `attention` (task chuyển sang chờ người vì mã chờ khác),
  `finished` (task vào DONE/FAILED/CANCELLED), và `resolve` (đối tượng của một thông báo đã đóng: đánh dấu các bản tin cần
  đồng bộ trạng thái cuối). Khóa: `question:<question_id>`, `approval:<approval_id>`,
  `confirm:<task>:r<rev>:<digest>`, `attention:<task>:v<version>:<code>`, `finished:<task>`, `reply:<bot>:<update_id>`,
  `report:<bot>:<update_id>:<part>`. Báo cáo theo giờ hẹn sau này chỉ cần `digest:<project>:<date>` (FR-005).
- **Rationale:** FR-001 bắt buộc cùng transaction. Hook giữ engine trung lập (constitution VI): engine không biết có thông
  báo, store không biết loại thông báo, chỉ application biết. So state trước/sau đúng cả khi một accept sinh nhiều event.
- **Alternatives considered:** vòng quét định kỳ so trạng thái (trễ, mất sự kiện ngắn như câu hỏi được trả lời ngay); tạo
  trong engine (vi phạm VI); trigger SQLite (logic phân nhánh khó test, khó đọc).

## R-04 — Gửi: lượt, đợt, thứ tự

- **Decision:**

  | Việc | Giá trị |
  | --- | --- |
  | Lượt gửi mỗi đợt | Tối đa 6 |
  | Backoff giữa các lượt | 2 giây nhân đôi, trần 5 phút, jitter ±20% từ seed lưu trong dòng |
  | Thời hạn đợt | 2 giờ tính từ lượt đầu (Q14); thời gian daemon tắt vẫn tính |
  | Thời hạn đợt của phản hồi thao tác | 15 phút; quá hạn thì bỏ vì người dùng đã thôi chờ |
  | Nhịp gửi | Tối đa 1 tin mỗi giây tới chat; `retry_after` dừng mọi lượt gửi tới hết thời gian chờ |
  | Timeout HTTP | 10 giây cho gửi/sửa; 35 giây cho `getUpdates` với long poll 25 giây |

- **Thứ tự mỗi vòng (FR-006):** phản hồi thao tác trước, rồi đồng bộ trạng thái cuối, rồi thông báo nghiệp vụ theo thứ tự tạo
  trong từng task; trước mỗi lượt kiểm hiệu lực (FR-004), thông báo hết hiệu lực chuyển `stale` và nhường chỗ ngay.
- **Giao thức một lượt:** ghi `tries+1`, `round_started_at` nếu chưa có và `next_try_at` trong một transaction (crash
  point `after_try_mark`), rồi gọi Telegram, rồi ghi kết quả: thành công thì tạo bản tin với `message_id`; lỗi xác định thì
  hẹn lượt sau; timeout hoặc mất kết nối giữa chừng thì ghi `unknown` và lượt sau gửi lại cùng nội dung, chấp nhận bản trùng.
  Restart thấy lượt đã đánh dấu mà chưa có kết quả thì coi như `unknown`.
- **Ghi bản tin khi đối tượng đã đóng trong lúc gửi:** transaction ghi kết quả gửi thành công đọc lại state của task ngay
  trong transaction đó. Nếu câu hỏi/yêu cầu đã đóng hoặc hết hiệu lực trong lúc `sendMessage` đang chờ, bản tin được ghi với
  `sync_state = pending` thay vì `none`, nên vòng đồng bộ trạng thái cuối sửa nó như mọi bản tin khác (FR-022, SC-008). Hook
  đóng đối tượng và transaction ghi bản tin cùng chạy trên một writer, nên một trong hai luôn thấy bên kia.
- **Rationale:** Không có probe nên at-least-once với cùng mã là mức cao nhất đạt được; điều này dựa vào ngoại lệ của nguyên tắc II trong hiến chương 6.1.0 và SPEC.md §13.2. Hai giờ đủ phủ sự cố
  mạng ngắn; sự cố dài do FR-030 xử lý bằng đợt mới. Nhịp 1 tin/giây theo khuyến nghị chung của Telegram cho một chat.

## R-05 — Bằng chứng hồi phục (FR-030)

- **Decision:** `tg_channel.send_failing_since` được đặt khi một đợt hết hạn, hoặc khi 3 lượt gửi/sửa liên tiếp (của bất kỳ
  thông báo nào) trả `unknown`, lỗi mạng hoặc 5xx; 429 không tính. Khi cờ này bật, vòng gửi gọi `sendChatAction(chat, "typing")` với nhịp 1 phút nhân đôi tới trần 15 phút. Lời gọi đó, hoặc bất kỳ
  `sendMessage`/`editMessageText` nào thành công sau thời điểm thất bại, là bằng chứng hồi phục: tăng `recovery_epoch`, xóa
  cờ. Thông báo thao tác được còn hiệu lực ở trạng thái `failed` và bản tin còn nợ đồng bộ trạng thái cuối có
  `epoch_used < recovery_epoch` được mở đúng một đợt mới. `getUpdates` thành công hay restart không đổi `recovery_epoch`.
- **Rationale:** `sendChatAction` đi đúng đường gửi tới chat nhưng không để lại tin. Lưu epoch trong DB nên restart không
  reset giới hạn (Q13).

## R-06 — Nhận tin

- **Decision:** Vòng nhận gọi `getUpdates(offset, timeout=25, allowed_updates=[message, edited_message, callback_query])`.
  Mỗi lô được ghi vào `tg_updates` (khóa `(bot_id, update_id)`) cùng offset mới trong một transaction (crash point
  `after_updates`); chỉ sau đó mới xử lý từng update theo thứ tự `update_id`. Mỗi update được phân loại **trước** khi lưu,
  theo đúng thứ tự của FR-018:
  1. Chat và người gửi khớp liên kết đang hoạt động: lưu nội dung **đã che secret** với `link_id` đó, trạng thái `pending`.
  2. Không khớp, nhưng là `message` trong chat riêng có văn bản đúng dạng `/start <mã>` (mã theo bảng ký tự của deep link):
     lưu `kind = pairing` với chat, người gửi và **băm** của mã, không lưu mã gốc, trạng thái `pending`. Đây là đường duy nhất
     cho lần liên kết đầu tiên và cho liên kết lại từ chat khác.
  3. Mọi update còn lại: chỉ lưu metadata tối thiểu (loại nguồn, thời điểm, lý do), trạng thái `ignored`. Tin lạ cùng
     `(chat_id, kind)` trong 10 phút gộp vào một dòng, chỉ tăng `ignored_count`, và không ghi log từng tin (EC-002).

  Che secret xảy ra **trước** khi ghi `tg_updates`, nên mọi thứ lưu từ update sau đó đều đã được che (SC-009). Nội dung gốc
  chỉ tồn tại trong bộ nhớ của vòng nhận.
- **Câu trả lời chứa giá trị giống secret bị từ chối, không ghi bản đã che:** nếu việc che làm thay đổi nội dung của một câu
  trả lời (reply hoặc `/answer`), update được đánh dấu `done` với kết quả `answer_contains_secret` và **không** dựng lệnh. Câu
  hỏi vẫn mở, nên cả hai đường còn dùng được: gửi lại câu trả lời không kèm giá trị đó, hoặc trả lời trên máy bằng
  `cusr answer`. Ghi bản đã che rồi cho task chạy tiếp thì worker nhận một câu trả lời hỏng mà không đường nào sửa được, vì
  câu trả lời hợp lệ đầu tiên thắng (US2.4). Che nhầm một chuỗi không phải secret chỉ làm người dùng phải diễn đạt lại. 409 hoặc webhook đang bật thì ghi `receive_conflict` vào health và lùi
  theo backoff.
- **Vòng của daemon:** vòng nhận và vòng gửi chạy trong `control().rounds`, nhưng được bỏ qua chỉ khi store `latched` hoặc
  `blocked`, không bỏ qua khi `held`, vì `held` chỉ chặn việc mới của task. `abortRounds` hủy long poll để `stop()` không phải
  chờ 25 giây.
- **Rationale:** offset là cursor duy nhất Telegram hiểu; tiến nó cùng lần ghi bền là điều kiện để không mất update (FR-013,
  SC-004).

## R-07 — Token bot và lệnh `setup`

- **Decision:** `cusr telegram setup` đọc token từ stdin (ẩn ký tự khi stdin là TTY), không bao giờ qua argv. Token được lưu
  theo **địa chỉ nội dung**, và dòng `tg_channel` trong SQLite là điểm commit duy nhất:
  1. CLI gọi `getMe` để kiểm token, tính `fp = sha256(token)`, ghi `DATA_DIR/telegram/token.<fp>` (0600, ghi tạm, fsync,
     đổi tên). Tên file khác với file đang dùng nên không ghi đè gì.
  2. CLI gửi lệnh `telegram_setup { fingerprint: fp, drop_webhook }`. Daemon đọc `token.<fp>`, kiểm băm khớp `fp`, gọi lại
     `getMe` và `getWebhookInfo`.
  3. Một transaction: ghi `bot_id`, `bot_username`, `token_fingerprint = fp`; nếu `bot_id` khác bot đang lưu thì thu hồi liên
     kết (`bot_changed`), hủy mã đang chờ, đánh dấu update `pending` của bot cũ là `ignored`, đặt `update_offset = 0`. Cùng bot
     thì giữ liên kết, offset và bản tin.
  4. Sau commit: xóa file `token.<fp_cũ>` vừa được thay, và chỉ file đó.
- **Đối chiếu trước mỗi vòng nhận/gửi:** đọc `token_fingerprint` từ DB, đọc `token.<fp>` và kiểm băm. Thiếu file hoặc băm
  lệch thì kênh ở `token_missing`: không nhận, không gửi, doctor báo `fail` kèm bước chạy lại setup. Khi khởi động còn gọi
  `getMe` một lần; `bot_id` khác DB thì kênh ở `token_mismatch`, cũng dừng. Vòng nhận/gửi **không bao giờ xóa file**.
- **Ai được xóa file token:** chỉ hai chỗ, và không chỗ nào chạy song song với một setup đang dở:
  - Bước 4 của chính setup vừa commit, chỉ xóa file nó vừa thay.
  - Bước dọn lúc khởi động daemon, chạy trước khi server điều khiển nhận lệnh và trước mọi round: xóa mọi `token.*` không
    phải `fp` trong DB. Lúc đó chưa có setup nào đang chạy trong daemon.
  - Handler `telegram_setup` giữ một khóa trong process: setup thứ hai đến khi setup đầu chưa xong nhận lỗi `busy`. Bước 2–3
    đọc lại file ngay trước transaction trong cùng một đoạn đồng bộ, nên nếu file của CLI đã bị dọn lúc khởi động (daemon
    restart giữa lúc CLI ghi file và gửi lệnh), setup báo `telegram_token_file_missing` và không commit gì; người dùng chạy
    lại lệnh.
- **Crash ở mọi bước đều phục hồi được:** trước bước 3, DB vẫn trỏ `fp` cũ mà file cũ còn nguyên; file mới thành mồ côi và chỉ
  bị dọn ở lần khởi động sau. Sau bước 3, DB trỏ `fp` mới mà file mới đã có từ bước 1. Không có lúc nào metadata của bot mới đi
  cùng token cũ, và không có lúc nào DB trỏ tới file đã bị xóa, vì file được DB tham chiếu không bao giờ là đích của bước dọn.
  Crash point `after_setup_commit` phủ bước 4.
- Bot có webhook thì từ chối ở bước 2 với hướng dẫn, trừ khi có `--drop-webhook`. Lỗi ở bước 1–3 giữ nguyên cấu hình cũ.
- Thêm mẫu token Telegram `\b\d{6,12}:[A-Za-z0-9_-]{30,}\b` vào `SECRET_PATTERNS` của `src/runner/redact.ts`, nên mọi
  Redactor đã có đều che token mà không cần dựng lại.
- **Rationale:** token không đi qua socket hay `command_ledger` (lệnh chỉ mang băm), chỉ nằm trong thư mục dữ liệu 0700 của
  daemon, không vào worktree hay biến môi trường của agent (FR-008). Giới hạn cùng UID theo ADR-0005 được in ra ở cuối lệnh.
  Không cần bảng "thao tác setup" riêng: DB là bên quyết định file nào đang dùng, nên đối chiếu chỉ là đọc một dòng.
- **Alternatives considered:** khai `token_file` trong cấu hình người dùng như `access_tokens` (phải sửa YAML của người
  dùng và restart daemon; không kiểm được bot trước khi lưu); gửi token trong payload lệnh (token nằm trong body và trong
  hash của ledger).

## R-08 — Liên kết, mã và grant

- **Decision:** `telegram_link_code` (admin) tạo mã 16 byte ngẫu nhiên dạng base64url (22 ký tự), chỉ lưu SHA-256, hạn 10
  phút, hủy sau 5 lần `/start` sai, role mặc định `operate`, project mặc định bằng phạm vi người gọi; role và project phải
  là tập con của grant người gọi. Tạo mã mới hoặc `unlink` hủy mã đang chờ. CLI in mã, deep link và chờ bằng query
  `telegram_status` tới khi liên kết xong hoặc mã hết hạn (`--no-wait` để trả ngay).
- Khi nhận `/start <mã>` hợp lệ từ chat riêng: một transaction thu hồi liên kết cũ, tạo liên kết mới với grant đã chốt, đánh
  dấu mã đã dùng, và tạo lại đợt gửi cho việc còn chờ (FR-031). Grant của liên kết nằm trong DB và được đọc lúc xử lý từng
  update, độc lập với `TokenMap` chỉ nạp lúc khởi động (FR-011). `AuthzContext.issued_by` là `telegram:<link_id>`, actor
  là `telegram:<user_id>`.
- **Ranh giới liên kết (FR-010, Q20):** bản tin, thẻ thao tác và update đều mang `link_id`. Xử lý một update kiểm liên kết
  còn hoạt động rồi gọi service trong cùng một đoạn đồng bộ, không có `await` ở giữa; vì daemon là bên ghi duy nhất và
  `better-sqlite3` chạy đồng bộ, lệnh `unlink` không chen được vào giữa. Bên nào commit trước thắng.

## R-09 — Thao tác từ Telegram đi qua đường lệnh có sẵn

- **Decision:** Update hợp lệ được dịch thành đúng loại lệnh CLI (`answer_question`, `approve_escalation`, `task_confirm`)
  và đi qua `admitCommand` với caller dựng từ grant của liên kết. `request_id` là UUID dẫn xuất xác định từ
  `tg:<bot_id>:<update_id>`. Phạm vi được giữ bởi thẻ thao tác (question ID, approval ID cùng bước, nấc và policy hash,
  revision và digest); `expected_version` là version hiện tại **ở lần dựng đầu tiên**.
- **Phát lại sau crash (FR-014):** command hash gồm `expected_version`, nên dựng lại lệnh từ state mới sẽ ra hash khác và bị
  `command_mismatch`. Vì vậy envelope đầy đủ (`request_id`, kind, project, task_id, `expected_version`, payload) được ghi vào
  `tg_updates.command_json` trong một transaction **trước** khi gọi `admitCommand`. Xử lý một update luôn theo thứ tự: có
  `command_json` thì dùng lại nguyên văn; ledger đã `completed` cho `request_id` đó thì lấy kết quả đã lưu để dựng phản hồi;
  chưa có gì thì dựng mới, ghi, rồi mới admit. Crash ở bất kỳ điểm nào đều cho cùng một lệnh và cùng một kết quả đầu tiên.
- **Thẻ thao tác:** `callback_data` là `c:<card_id>` (10 ký tự base64url ngẫu nhiên); thẻ lưu loại, task, phạm vi và
  `link_id`. Mỗi lần bấm luôn được `answerCallbackQuery` ngay để tắt vòng chờ trên điện thoại, rồi mới xử lý.
- **Trả lời:** `/answer <mã> <nội dung>` dùng mã ngắn 6 ký tự base32 băm từ question ID (không dùng tiền tố UUIDv7 vì phần
  đầu là thời gian, dễ trùng). Mã trùng giữa hai câu hỏi mở thì báo mơ hồ (EC-006). Reply vào bản tin câu hỏi được định tuyến
  theo hai bước:
  1. Tra `message_copies(bot_id, chat_id, message_id)` của `reply_to_message`.
  2. Không có dòng (bản tin của lượt gửi `unknown`): đọc dòng tham chiếu cuối của chính tin gốc trong `reply_to_message.text`,
     dạng `ref a8Kq2ZxP0d`, với điều kiện `reply_to_message.from.id` là bot. Giá trị là `card_id` của một thẻ `answer` trong
     `action_cards`: khóa chính 10 ký tự ngẫu nhiên, ánh xạ tới đúng `question_id` đầy đủ và `link_id` đã gửi tin. Thẻ được tạo
     một lần cho mỗi cặp (thông báo, liên kết) trước lượt gửi đầu, và mọi lượt gửi lại theo liên kết đó dùng cùng thẻ.
     `link_id` của thẻ khác liên kết đang hoạt động thì trả "hết hiệu lực" như FR-010; câu hỏi được kiểm hiệu lực như mọi
     đường trả lời khác.

  Tham chiếu là khóa chính nên không trùng giữa hai câu hỏi hay hai liên kết, khác với mã ngắn của `/answer` vốn có thể mơ hồ
  (EC-006). Bản trùng không có trong bảng vẫn định tuyến được về đúng câu hỏi và đúng lần liên kết (FR-003, FR-022). Nội dung
  tin là văn bản bot tự dựng; parser chỉ đọc dòng cuối có đúng định dạng, nên nội dung câu hỏi phía trên không giả được tham
  chiếu.
- **Rationale:** dùng lại admission, dedup, kiểm quyền và mã lỗi của CLI nên Telegram không có đường riêng để vượt quyền và
  không có thao tác CLI không có (FR-019).

## R-10 — Xác nhận task và cấu hình như một thao tác

- **Decision:** Thêm trigger `confirm_task_with_run_config { revision, digest }`. `decide` kiểm revision, đề xuất hiện hành và
  digest, rồi phát cả `TaskConfirmed` lẫn `RunConfigConfirmed` trong cùng một accept; lệch bất kỳ điều kiện nào thì từ chối
  cả hai. `confirmTask` dùng trigger này khi có `run_config_digest`, nên `cusr task confirm --run-config` cũng hết trạng thái
  một nửa. Preflight `config_checked` vẫn chạy sau như hiện nay vì nó cần I/O.
- **Rationale:** hai accept riêng có thể bị crash chen giữa (Q16); kiểm trước khi ghi không đủ. Một trigger là cách duy nhất
  để có "cả hai hoặc không gì" trong mô hình một trigger một transaction. Hợp đồng
  [cli-daemon của 002](../002-task-to-green-pr/contracts/cli-daemon.md) đã cho phép gộp một lượt xác nhận khi hiển thị đủ cả
  task và cấu hình chạy.
- **Bằng chứng cần thu:** property test của `decide` cho mọi tổ hợp revision/đề xuất/digest; crash test tại mọi crash point
  của accept cho trigger mới.

## R-11 — Decider không giành lại câu hỏi đã chạy hỏng

- **Decision:** `deciderQuestion(s)` loại câu hỏi đã có `decider_runs[*]` với cùng `question_id` và `failure !== null`. Điều
  kiện này đọc từ state đã ghi, nên đúng qua restart và qua việc tắt/bật `autonomous` (FR-021, Q17). Tập `tried` trong bộ nhớ
  giữ nguyên để không chạy song song trong một process.
- **Giữ thông báo câu hỏi khi decider còn xử lý:** thông báo `question` được tạo ngay nhưng ở trạng thái `held` khi
  `autonomous` bật và `deciderQuestion(s)` trả câu hỏi đó; vòng gửi đọc lại cài đặt (nhớ đệm 30 giây như decider) mỗi vòng.
  Decider trả lời xong thì thông báo thành `stale` và không gửi; decider hỏng thì thông báo được gửi.

## R-12 — Inbox mở rộng và phân trang

- **Decision:** `inbox` trả mục có `kind` thuộc `question | approval | confirmation | attention`, tính bằng `openQuestions`,
  `needsUser` và `allowedActions` có sẵn. Mục câu hỏi giữ nguyên mọi trường cũ; mọi mục có thêm `kind`, `item_id`, `reason`,
  `actions` (lệnh CLI tương ứng), `telegram_actionable` và `decider` (`null`, `"pending"` hoặc `"running"`). Thứ tự ổn định
  theo `(project, task_id, kind, item_id)`; phân trang bằng `cursor`/`next_cursor` mờ, trang tối đa 100 (CLI) và 8 mục mỗi
  tin trên Telegram, có nút "Trang sau" và nút "Mở" cho từng mục thao tác được.
- **Rationale:** dùng đúng các hàm đang nuôi `task explain`, board và report nên ba bề mặt không lệch nhau. Không có hợp
  đồng JSON nào của inbox ngoài một dòng bảng và ví dụ trong `skills/cusr/SKILL.md`, nên hợp đồng mới được ghi đủ ở
  [contracts/cli-daemon.md](contracts/cli-daemon.md) và skill được cập nhật cùng lát.

## R-13 — Trình bày tin

- **Decision:** Gửi văn bản thuần, không `parse_mode`, để nội dung câu hỏi không thể chèn định dạng hay liên kết. Mỗi tin có
  dòng đầu `[<project>] <tiêu đề task>`, mã ngắn, nội dung, việc cần làm và lệnh CLI tương ứng; mọi chuỗi qua Redactor trước
  khi lưu. Nội dung dài được cắt ở ranh giới dòng, giữ phần đầu và phần cuối gồm mã và nút. Report dài chia tối đa 5 tin,
  quá thì ghi đã cắt và lệnh `cusr report` để xem đủ.
- **Rationale:** an toàn hơn HTML/MarkdownV2 vốn đòi escape đúng mọi ký tự; giao diện điện thoại đọc được.

## R-14 — Health, status, doctor

- **Decision:** `GET /v1/health` thêm `channels.telegram` gồm `configured`, `bot`, `link` (role, projects, since),
  `receive` (`last_ok_at`, `conflict`, `error`), `send` (`failing_since`, `pending`, `failed`, `last_ok_at`). Lỗi kênh không
  làm health 503 vì task không bị ảnh hưởng (FR-007). Doctor thêm check `telegram`: chưa setup là `ok` kèm ghi chú; đã setup
  mà token hỏng, webhook, xung đột hay không gửi được là `fail` kèm bước sửa. `cusr telegram status` là bản chi tiết của cùng
  dữ liệu.

## R-15 — Kiểm thử

- **Decision:** server Telegram giả lập trong `test/support/fake-telegram.ts` (HTTP cục bộ, chạy các method của R-01, chèn
  được lỗi mạng, 409, 429 với `retry_after`, timeout sau khi đã nhận, tin bị xóa). Ma trận crash dùng child process với
  `CUSR_CRASH_AT` và các crash point mới (`after_notifications`, `after_try_mark`, `after_copy`, `after_updates`,
  `after_command_saved`, `after_setup_commit`), ít nhất 100 seed (SC-004). Ma trận phải có các ca: crash giữa lưu envelope và
  admit, giữa admit và hoàn tất lệnh, giữa ghi file token và commit setup, giữa commit setup và dọn file cũ. Smoke với bot thật ở project `smoke`, chạy khi có `CUSR_SMOKE_TELEGRAM_TOKEN` và chat thử; thiếu thì
  ghi chưa kiểm (SC-010).
