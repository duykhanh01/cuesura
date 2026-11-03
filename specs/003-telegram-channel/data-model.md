# Data model: kênh thông báo Telegram

Thuật ngữ thông báo logic, đợt gửi, lượt gửi, bản tin và đồng bộ trạng thái cuối theo [GLOSSARY.md](../../GLOSSARY.md).
Mọi bảng dưới đây là **nguồn sự thật** thêm ở migration `006_telegram_channel.sql`, không phải projection: chúng không
dựng lại được từ event log nên nằm ngoài `verifyProjections`, giống `command_ledger` ([R-02](research.md#r-02--nơi-lưu-thông-báo)).
Mọi bảng `STRICT`; thời điểm là epoch ms từ `Clock` được inject.

## Kênh: `tg_channel`

Một dòng duy nhất (`id = 1`).

| Cột | Ý nghĩa |
| --- | --- |
| `bot_id`, `bot_username` | Bot đang dùng, đọc từ `getMe` lúc setup |
| `token_fingerprint` | SHA-256 đầy đủ của token; chọn file `telegram/token.<fingerprint>` đang dùng. Hiển thị chỉ 8 ký tự đầu. Đổi cùng `bot_id` trong một transaction ([R-07](research.md#r-07--token-bot-và-lệnh-setup)) |
| `token_state` | `ok`, `token_missing`, `token_mismatch`; khác `ok` thì không nhận, không gửi |
| `update_offset` | Offset kế tiếp cho `getUpdates`; chỉ tăng, tiến cùng transaction ghi `tg_updates` |
| `receive_last_ok_at`, `receive_error`, `receive_conflict` | Sức khỏe vòng nhận |
| `send_last_ok_at`, `send_failing_since`, `probe_next_at` | Sức khỏe đường gửi ([R-05](research.md#r-05--bằng-chứng-hồi-phục-fr-030)) |
| `recovery_epoch` | Tăng một mỗi lần có bằng chứng hồi phục; không reset khi restart |
| `paused_until` | Hết hạn của `retry_after` gần nhất |

Không có dòng nghĩa là chưa setup; daemon chạy như trước feature (FR-029).

## Liên kết: `tg_links`

| Cột | Ý nghĩa |
| --- | --- |
| `link_id` | ID liên kết (UUID) |
| `bot_id`, `chat_id`, `user_id` | Danh tính kênh; chat riêng nên `chat_id = user_id` |
| `actor` | `telegram:<user_id>` |
| `roles_json`, `projects_json` | Grant riêng, chốt từ mã liên kết |
| `created_by` | Actor của token đã tạo mã |
| `created_at`, `revoked_at`, `revoke_reason` | `revoke_reason` ∈ `unlink`, `relinked`, `bot_changed` |

Ràng buộc: unique index một phần trên biểu thức hằng `((1)) WHERE revoked_at IS NULL`, nên chỉ có một liên kết hoạt động
(FR-010).

Chuyển trạng thái: `active → revoked`; không quay lại. Liên kết lại cùng chat tạo `link_id` mới.

## Mã liên kết: `tg_link_codes`

| Cột | Ý nghĩa |
| --- | --- |
| `code_hash` | SHA-256 của mã; mã gốc không lưu |
| `roles_json`, `projects_json`, `created_by` | Grant sẽ cấp, đã kiểm là tập con của grant người tạo |
| `created_at`, `expires_at` | Hạn 10 phút |
| `failed_attempts` | Số `/start` mang mã sai nhận được trong lúc mã này là mã `pending` duy nhất; đạt 5 thì hủy |
| `state` | `pending`, `used`, `expired`, `cancelled` |
| `link_id` | Liên kết tạo ra khi `used` |

Chỉ một mã `pending` tại một thời điểm: tạo mã mới hoặc `unlink` chuyển mã cũ sang `cancelled`. Thu hồi token CLI của người
tạo không đổi mã (Q10).

## Thông báo logic: `notifications`

| Cột | Ý nghĩa |
| --- | --- |
| `id` | ID nội bộ |
| `key` | Khóa logic, UNIQUE ([R-03](research.md#r-03--tạo-thông-báo-trong-cùng-transaction-với-sự-kiện)) |
| `kind` | `question`, `approval`, `confirmation`, `attention`, `finished`, `reply` (phản hồi thao tác, trang inbox, thẻ mở lại), `report` |
| `priority` | `reply` (phản hồi thao tác), `business`, `info` |
| `project`, `task_id` | Có thể null với `reply`/`report` |
| `subject_json` | Đối tượng gắn: `question_id`; `approval_id`, `step`, `rung`, `policy_hash`; `revision`, `digest` |
| `body_json` | Chỉ cho `reply`/`report`: nội dung đã che secret. Các loại khác dựng lúc gửi từ state hiện tại |
| `link_id` | Liên kết đích hiện tại |
| `state` | Xem chuyển trạng thái dưới |
| `round`, `round_started_at`, `round_deadline` | Đợt gửi hiện tại; thời hạn tính từ lượt đầu (Q14) |
| `tries`, `next_try_at`, `try_seed` | Lượt trong đợt và lịch lượt sau; jitter từ seed |
| `epoch_used` | `recovery_epoch` đã dùng để mở đợt gần nhất |
| `last_error` | Lỗi cuối đã che secret |
| `created_seq`, `created_at` | Thứ tự tạo dùng cho FR-006 |

Chuyển trạng thái:

```text
held ──decider xong hoặc hỏng──▶ pending ──lượt thành công──▶ sent
  │                               │ ▲
  │                               │ └─đợt mới (FR-030, FR-031)── failed
  │                               └─hết đợt──▶ failed
  └──────── hết hiệu lực (FR-004) ──────────▶ stale
pending/failed ── hết hiệu lực ──▶ stale
```

- `held` chỉ dành cho `question` khi decider còn có thể trả lời ([R-11](research.md#r-11--decider-không-giành-lại-câu-hỏi-đã-chạy-hỏng)).
- `failed` của `attention`, `finished`, `reply`, `report` là cuối; không mở đợt mới (FR-030).
- `sent` là cuối với chính thông báo; việc sửa bản tin sau đó thuộc `message_copies`.
- Liên kết mới (FR-031): mọi `question`, `approval`, `confirmation` còn hiệu lực đổi `link_id`, sang `pending`, đợt mới.

## Bản tin: `message_copies`

| Cột | Ý nghĩa |
| --- | --- |
| `id`, `notification_id`, `link_id` | Một bản tin của một thông báo, gửi theo một liên kết |
| `bot_id`, `chat_id`, `message_id` | Tham chiếu tin; UNIQUE `(bot_id, chat_id, message_id)`, vì mỗi bot có dãy message ID riêng trong cùng một chat. Chỉ có khi lượt gửi thành công |
| `card_id` | Thẻ thao tác gắn nút của bản tin, nếu có |
| `sent_at` | |
| `sync_state` | `none`, `pending`, `done`, `gone` |
| `sync_round`, `sync_tries`, `sync_next_at`, `sync_epoch_used`, `sync_error` | Đợt và lượt của đồng bộ trạng thái cuối |
| `final_text_hash` | Nội dung cuối đã đặt, để bỏ lỗi `message is not modified` |

Đồng bộ trạng thái cuối (FR-022): khi đối tượng đóng, hook đặt `sync_state = pending` cho mọi bản tin của nó. Bản tin được
ghi sau khi đối tượng đã đóng (câu trả lời CLI đến lúc `sendMessage` đang chờ) nhận `sync_state = pending` ngay khi ghi, vì
transaction ghi bản tin đọc lại state của task ([R-04](research.md#r-04--gửi-lượt-đợt-thứ-tự)). Lượt sửa thành
công thì `done`; Telegram báo không còn tin hay không sửa được thì `gone` kèm lý do và ngừng; hết đợt thì giữ `pending` chờ
`recovery_epoch` mới (Q18, Q19). Bản tin của lượt gửi `unknown` không có dòng ở đây; nút trên nó vẫn tra được qua thẻ, còn
reply được định tuyến bằng dòng tham chiếu `ref <card_id>` ở cuối tin gốc, trỏ tới thẻ `answer` của câu hỏi
([R-09](research.md#r-09--thao-tác-từ-telegram-đi-qua-đường-lệnh-có-sẵn)).

## Thẻ thao tác: `action_cards`

| Cột | Ý nghĩa |
| --- | --- |
| `card_id` | 10 ký tự base64url ngẫu nhiên, nằm trong `callback_data` |
| `link_id` | Liên kết đã gửi thẻ; khác liên kết đang hoạt động thì thẻ hết hiệu lực |
| `kind` | `answer` (tham chiếu của tin câu hỏi, một thẻ cho mỗi cặp thông báo và liên kết), `approve`, `confirm`, `open` (mở lại thẻ từ inbox), `page` (trang inbox kế) |
| `task_id`, `scope_json` | Phạm vi đã hiển thị: approval ID, bước, nấc, policy hash; hoặc revision và digest; hoặc cursor |
| `created_at` | |

Thẻ không bao giờ bị sửa; phạm vi đổi thì tạo thẻ mới.

## Update nhận: `tg_updates`

| Cột | Ý nghĩa |
| --- | --- |
| `bot_id`, `update_id` | Khóa chính |
| `link_id` | Liên kết khớp lúc nhận; null với `pairing` và chat lạ |
| `kind` | `message`, `edited_message`, `callback_query`, `pairing`, `other` |
| `chat_id`, `user_id` | Nguồn; với chat lạ chỉ giữ để chẩn đoán |
| `payload_json` | Update khớp liên kết: nội dung đã che secret trước khi ghi. `pairing`: chỉ `code_hash`. Chat lạ: null |
| `received_at` | |
| `state` | `pending`, `done`, `ignored` |
| `command_json` | Envelope lệnh đầy đủ đã dựng lần đầu, gồm `request_id` và `expected_version`; dùng lại nguyên văn khi xử lý lại |
| `outcome_json` | Kết quả tóm tắt: thao tác, mã lỗi, hoặc lý do bỏ qua |
| `ignored_count` | Chỉ với `ignored`: số tin lạ cùng `(chat_id, kind)` gộp vào dòng này trong cửa sổ 10 phút (EC-002) |

Phân loại `link`/`pairing`/`ignored` xảy ra trước khi lưu ([R-06](research.md#r-06--nhận-tin)). Lô update và
`tg_channel.update_offset` được ghi cùng transaction. Update `pending` được xử lý lại sau restart: `command_json` đã có thì
dùng lại, nên `admitCommand` thấy đúng request và trả kết quả đầu tiên (FR-014, FR-028).

## Thay đổi lên phần đã có

| Chỗ | Thay đổi |
| --- | --- |
| `src/domain/trigger.ts`, `src/engine/` | Trigger `confirm_task_with_run_config { revision, digest }` phát `TaskConfirmed` và `RunConfigConfirmed` trong một accept ([R-10](research.md#r-10--xác-nhận-task-và-cấu-hình-như-một-thao-tác)) |
| `src/store/accept.ts`, `src/store/crash.ts` | Hook `afterProject` và crash point `after_notifications`; thêm `after_try_mark`, `after_copy`, `after_updates`, `after_command_saved`, `after_setup_commit` cho bảng kênh |
| `src/daemon/decider.ts` | `deciderQuestion` loại câu hỏi có lần chạy hỏng đã ghi |
| `src/application/inbox.ts` | Mục nhiều loại, cursor, ghi chú decider ([R-12](research.md#r-12--inbox-mở-rộng-và-phân-trang)) |
| `src/runner/redact.ts` | Mẫu token bot Telegram |
| `src/daemon/health.ts`, `src/application/doctor.ts` | `channels.telegram` và check `telegram` |

Không có cột mới cho bảng hiện có; `TaskState` không đổi.
