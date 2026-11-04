# Data model: tài khoản cho harness

Đây là thiết kế, chưa phải schema đã triển khai. Không có secret nào nằm trong DB: chỉ tên, đường dẫn, digest và khóa danh
tính đã băm. Quyết định nền ở [research](research.md).

## Thực thể

### Account (khai báo)

| Trường | Kiểu | Quy tắc |
| --- | --- | --- |
| `account_id` | UUIDv7 | Định danh ổn định; event và attempt tham chiếu theo id, không theo tên |
| `name` | text | Duy nhất trong harness; theo `RefNameSchema` hiện có |
| `harness` | text | Harness đã khai; một tài khoản thuộc đúng một harness (FR-001) |
| `source_kind` | `managed` \| `system` | `managed`: tài khoản dự phòng, đăng nhập qua `cusr account add`, thư mục `<DATA_DIR>/accounts/<account_id>/home`. `system`: tài khoản mặc định, đăng nhập sẵn trên máy, chỉ đọc (R-11) |
| `source_path` | text | Với `managed`: suy ra từ `account_id`, không do người dùng nhập. Với `system`: đường dẫn trong `credential_refs` |
| `identity_key` | text \| null | SHA-256 của `vendor:mã danh tính`; `null` khi vendor không cho đọc (R-07) |
| `identity_label` | text \| null | Nhãn cho `admin` (ví dụ email rút gọn); không bao giờ là token |
| `priority` | integer | Mặc định `0`. Số lớn chọn trước; hòa thì `system` trước, rồi `declared_seq` nhỏ trước (FR-002) |
| `declared_seq` | integer | `account_seq` của event `AccountAdded` |
| `removed` | boolean | Gỡ là đánh dấu, giữ lịch sử cho report |

**Khóa cooldown** của một tài khoản: `identity_key` nếu có, ngược lại `account:` + `account_id`, tức tài khoản nghỉ riêng (FR-012).

### Nguyên nhân chặn (`account_blocks`)

Mỗi nguyên nhân là một hàng độc lập; tài khoản sẵn sàng khi không có hàng nào và khóa cooldown không có cooldown còn hiệu
lực (FR-011, Q8).

| `cause` | Gắn với | Đặt bởi | Gỡ bởi |
| --- | --- | --- | --- |
| `auth_error` | mục khai | lỗi auth không do nguồn đổi (FR-018) | kiểm tra lại đăng nhập thành công |
| `identity_changed` | mục khai | danh tính nguồn khác `identity_key` (FR-005a); chỉ xảy ra với `system` | `account_check` nhận danh tính mới (`AccountRelogged`), hoặc gỡ tài khoản |
| `pending_write` | mục khai | ghi credential thất bại (FR-022a) | ghi xong, hoặc gỡ tài khoản |
| `suspended` | mục khai | `account_suspend` | `account_resume` |

### Cooldown (`account_cooldowns`)

| Trường | Quy tắc |
| --- | --- |
| `cooldown_key` | Khóa cooldown ở trên; mọi mục khai cùng khóa dùng chung, kể cả harness khác |
| `until` | Mốc hồi; hai báo gộp lấy mốc muộn hơn (FR-016) |
| `source` | `vendor` (có `reset_at`) hoặc `backoff` |
| `from_attempt` | Attempt báo gần nhất |
| `cleared_at_seq` | `account_seq` của lần xóa nghỉ gần nhất; báo đến sau mốc này vẫn đặt lại cooldown (Q16) |

`reset_at` ở quá khứ thì không tạo cooldown; vượt trần `backoff.rate_limit.max_ms` thì cắt về trần và ghi `clamped: true`.

### Đợt hết hạn mức (`account_episodes`) và thông báo (`notices`)

| Trường | Quy tắc |
| --- | --- |
| `episode_id` | UUIDv7; cũng là `notice_id` |
| `harness` | Một đợt mở tối đa cho mỗi harness |
| `opened_seq`, `closed_seq` | Mở khi task đầu tiên nhận `accounts_cooling` mà mọi tài khoản không bị chặn vì lý do khác đều nghỉ; đóng khi có tài khoản chọn được (Q11) |
| `version` | Tăng khi tập task, mốc hồi hay trạng thái đổi; kênh dùng để sửa tin (Q15) |
| `state` | `open` \| `resolved` |

Nội dung thông báo (task, mốc hồi, trạng thái từng tài khoản) dựng lúc đọc từ projection và lọc theo quyền (R-09, R-10).

## Luồng event tài khoản

Bảng `account_events(account_seq INTEGER PRIMARY KEY AUTOINCREMENT, type, account_id NULL, payload_json, actor, reason,
cause_task_id NULL, cause_global_seq NULL)`. Event do trigger của task sinh ra ghi cùng transaction và trỏ về `global_seq`
của trigger đó.

| Event | Payload chính | Sinh bởi |
| --- | --- | --- |
| `AccountAdded` | name, harness, source_kind, source_path (chỉ `system`), staging_id (chỉ `managed`), identity_key, identity_label, priority | `account_add`; daemon tạo tài khoản mặc định (R-11) |
| `AccountRelogged` | identity_key, source_digest | `account_login` thay credential cùng danh tính (R-08); `account_check` nhận danh tính mới của tài khoản mặc định (R-07) |
| `AccountRemoved` | — | `account_remove` |
| `AccountPrioritySet` | priority | `account_set_priority`, `account_use` |
| `AccountSuspended` / `AccountResumed` | — | lệnh tương ứng |
| `AccountCooldownSet` | cooldown_key, until, source, clamped, attempt_id | lỗi `rate_limited` |
| `AccountCooldownCleared` | cooldown_key | `account_clear_cooldown` |
| `AccountAuthFailed` / `AccountAuthRestored` | attempt_id | FR-018; kiểm tra lại thành công |
| `AccountIdentityChanged` | observed_key | phát hiện lúc chọn hoặc lúc ghi credential |
| `AccountWritePending` / `AccountWriteSettled` | attempt_id, outcome | kết quả ghi credential (R-06) |
| `AccountCheckRequested` / `AccountCheckCompleted` | check_id, outcome (`ok`, `failed`), problem | `account_check` và kết quả probe (R-09) |
| `AccountEpisodeOpened` / `AccountEpisodeUpdated` / `AccountEpisodeClosed` | harness, task_ids, earliest_ready_at | R-10 |

Replay: projection dựng lại hoàn toàn từ `account_events` theo `account_seq`; `verify-projections` so sánh như với task.

## Thay đổi ở task

### `TaskState`

| Trường | Ý nghĩa |
| --- | --- |
| `account_round` | `{step, harness, tried: account_id[]}` hoặc `null`; quy tắc mở vòng ở [R-05](research.md#r-05--chờ-đánh-thức-và-vòng-thử) |
| `auth_chains` | Map `account_id → {fresh_token_used: boolean}`, mỗi tài khoản một chuỗi độc lập trong task. Lỗi auth trên A chỉ đọc/ghi mục của A; chuyển sang B không xóa mục của A. Mục của một tài khoản bị xóa khi một attempt trên chính tài khoản đó không lỗi auth (FR-018, Q4) |

### Event task mới

| Event | Payload | Ghi chú |
| --- | --- | --- |
| `AccountSelected` | attempt_id, account_id, reason (`first`, `rate_limit`, `auth`, `fresh_token`, `woken`) | Từ fact khởi chạy; nguồn cho FR-019 và replay (FR-017) |

### `FailureData` thêm trường

| Trường | Khi nào |
| --- | --- |
| `harness_kind` | Mọi lỗi harness; phân biệt `rate_limited` với `overloaded` (R-04) |
| `account_id` | Attempt đã có tài khoản |
| `source_changed` | Lỗi `auth` có tài khoản |
| `earliest_ready_at`, `blocked` | Lớp mới `accounts_unavailable` |
| `credential_write` | Kết quả ghi credential (R-06); không làm attempt thất bại |

### `DetailCode` mới

`accounts_cooling`, `accounts_pending_write`, `accounts_blocked`; bảng `NEEDS_USER` lần lượt `false`, `false`, `true` (R-05).
Event làm tăng khả dụng (đánh thức task) liệt kê ở [R-05](research.md#r-05--chờ-đánh-thức-và-vòng-thử), gồm cả
`AccountRelogged`. Detail của ba mã này có `accounts_watermark`: `account_seq` lớn nhất đã thấy khi `selectAccount` trả "không có"; chỉ event
làm tăng khả dụng có `account_seq` lớn hơn mới đánh thức task (R-05). Event cooldown ảnh hưởng mọi tài khoản cùng
`cooldown_key` ở mọi harness, nên đánh thức cả task chờ tài khoản khác chung subscription.

## Chuyển trạng thái chọn tài khoản

```text
start_agent ─▶ selectAccount ─┬─ có tài khoản ─▶ AccountSelected ─▶ chạy
                              └─ không có ─┬─ có tài khoản đang nghỉ ─────────▶ WAITING accounts_cooling (timer mốc hồi)
                                           ├─ chỉ còn tài khoản chờ ghi ─────▶ WAITING accounts_pending_write (backoff)
                                           └─ còn lại ──────────────────────▶ WAITING accounts_blocked (cần admin)
WAITING accounts_* ─ timer, hoặc account_ready từ event mới hơn watermark ─▶ mở vòng mới ─▶ start_agent
kết quả attempt ─┬─ rate_limited ─▶ AccountCooldownSet ─▶ start_agent ngay (vòng cũ)
                 ├─ auth, nguồn đổi, chưa dùng token mới ─▶ start_agent ngay, được chọn lại tài khoản đó
                 ├─ auth, còn lại ─▶ AccountAuthFailed + inbox ─▶ start_agent ngay (vòng cũ)
                 └─ khác ─▶ xử lý như hiện nay; xóa auth_chains[tài khoản đó]
```

`selectAccount` là hàm thuần: lọc tài khoản của harness, chưa gỡ, không có nguyên nhân chặn, không có cooldown hiệu lực
tại `now`, không nằm trong `tried` (trừ trường hợp token mới của FR-018); sắp theo `priority` giảm dần, rồi `system` trước, rồi `declared_seq`.

## Mục inbox tài khoản

Không có bảng. Query `inbox` dựng mục loại `account` từ `account_blocks` cho mỗi tài khoản có `auth_error`,
`identity_changed` hoặc `pending_write`; chỉ token có `admin` thấy ([R-10](research.md#r-10--thông-báo-và-đợt-hết-hạn-mức)).

## Lưu trữ file

| Đường dẫn | Quyền | Nội dung |
| --- | --- | --- |
| `<DATA_DIR>/accounts/<account_id>/home/` | `0700` | Thư mục cấu hình của tài khoản `managed` (`.claude/.credentials.json` và `.claude.json`, hoặc `auth.json`); xóa khi gỡ tài khoản |
| `<DATA_DIR>/accounts/staging/<uuid>/` | `0700` | Thư mục login tạm của `add`/`login`; xóa khi thành công hoặc thất bại (R-08) |
| `<DATA_DIR>/accounts/<account_id>/pending/` | `0700`, file `0600` | Bản chờ ghi (FR-022a); xóa khi ghi xong hoặc gỡ tài khoản |
| `<DATA_DIR>/accounts/<account_id>/lock.sqlite` | `0600` | File khóa cố định của tài khoản; bên ghi giữ `BEGIN EXCLUSIVE` trong lúc kiểm digest và ghi, kernel nhả khi process chết. Không chứa trạng thái (R-13) |
| `<run dir>/launch-state.json` | như hiện nay | Thêm `account_id`, `source_digest` (cập nhật sau mỗi lần ghi về), `installed_digest` cho từng file auth |
