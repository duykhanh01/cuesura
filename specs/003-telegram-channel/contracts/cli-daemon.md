# Hợp đồng CLI và daemon của feature 003

Mở rộng [hợp đồng CLI/daemon của 002](../../002-task-to-green-pr/contracts/cli-daemon.md) và
[của 004](../../004-terminal-tui/contracts/cli-daemon.md). Envelope `--json`, exit code, request ID và transport giữ
nguyên. Lệnh mới đều có `--json` và đi qua daemon; không lệnh nào đọc SQLite trực tiếp.

## Lệnh mới

| Lệnh | Quyền | Daemon | Hành vi |
| --- | --- | --- | --- |
| `cusr telegram setup [--drop-webhook]` | admin | command `telegram_setup` | Đọc token từ stdin (ẩn khi TTY), kiểm `getMe`, ghi `telegram/token.<sha256>`, gửi lệnh chỉ mang băm. In tên bot, việc bot cũ/mới ([R-07](../research.md#r-07--token-bot-và-lệnh-setup)) và giới hạn bảo vệ token theo ADR-0005 |
| `cusr telegram link [--role operate\|admin] [--project ID]... [--no-wait]` | admin | command `telegram_link_code`, query `telegram_status` | In mã, deep link và hạn; mặc định chờ tới khi liên kết hoặc hết hạn |
| `cusr telegram unlink` | admin | command `telegram_unlink` | Thu hồi liên kết đang hoạt động và mã đang chờ; không có liên kết thì trả `ok` kèm `changed: false` |
| `cusr telegram status` | read | query `telegram_status` | Chi tiết `channels.telegram` của health, cộng danh sách thông báo `failed` và bản tin `gone` gần nhất |

Không có token trong argv, biến môi trường hay payload lệnh. Payload của `telegram_setup` là `{fingerprint, drop_webhook}`; daemon
đọc token từ file `telegram/token.<fingerprint>` và kiểm băm.

### `telegram_setup` → data

```json
{ "bot": { "id": 123, "username": "acme_cusr_bot" }, "previous_bot_id": null,
  "bot_changed": false, "links_revoked": 0, "webhook_dropped": false }
```

Lỗi: `telegram_token_invalid` (exit 2), `telegram_token_file_missing` (exit 2, chạy lại setup), `telegram_busy` (exit 6, đang có setup khác), `telegram_webhook_active` (exit 2, `fix` gợi ý `--drop-webhook`),
`telegram_unreachable` (exit 3). Mọi lỗi giữ nguyên cấu hình cũ.

### `telegram_link_code` → data

```json
{ "code": "q3V…", "deep_link": "https://t.me/acme_cusr_bot?start=q3V…", "expires_at": 1793700000000,
  "role": "operate", "projects": ["acme"] }
```

Lỗi: `telegram_not_configured` (exit 2), `forbidden` khi role/project vượt grant người gọi (exit 5).

### `telegram_status` → data

```json
{ "configured": true, "bot": { "id": 123, "username": "acme_cusr_bot" },
  "link": { "link_id": "…", "roles": ["read","operate"], "projects": ["acme"], "since": 1793690000000 },
  "pending_code": { "expires_at": 1793700000000 },
  "receive": { "last_ok_at": 1793699990000, "conflict": null, "error": null },
  "send": { "last_ok_at": 1793699980000, "failing_since": null, "pending": 0, "held": 1, "failed": 0 },
  "recent_failures": [] }
```

`link` là `null` khi chưa liên kết. Không có trường nào chứa token hay mã liên kết.

## Lệnh đổi hành vi

### `cusr inbox`

Query `inbox` nhận thêm `cursor` (chuỗi mờ) và `kinds` (lọc). Kết quả:

```json
{ "items": [ … ], "next_cursor": null, "total": 3 }
```

Mỗi mục:

| Trường | Có ở | Ý nghĩa |
| --- | --- | --- |
| `kind` | mọi mục | `question`, `approval`, `confirmation`, `attention` |
| `item_id` | mọi mục | Question ID, approval ID, hoặc `<task_id>:<wait_code>` |
| `task_id`, `project`, `title`, `revision`, `task_version` | mọi mục | Như hiện nay |
| `reason` | mọi mục | Mã chờ và mô tả ngắn dựng bằng code |
| `actions` | mọi mục | `[{action, command}]` từ `allowedActions` |
| `telegram_actionable` | mọi mục | Thao tác được trên Telegram với grant của liên kết hiện tại |
| `decider` | `question` | `null`, `"pending"` (decider sẽ xét), `"running"` |
| `question_id`, `step`, `attempt_id`, `body`, `blocking`, `wait_code` | `question` | Giữ nguyên như trước feature |

Trường `truncated` cũ được thay bằng `next_cursor`; CLI in trang đầu và dòng hướng dẫn `--cursor <next_cursor>`. CLI thêm
`--cursor` và `--limit` (1–100, mặc định 100). Thứ tự ổn định theo `(project, task_id, kind, item_id)`, nên phân trang không
bỏ sót mục khi không có thay đổi giữa hai trang; mục mới chèn giữa chừng xuất hiện ở lần đọc sau.

### `cusr task confirm ID --run-config DIGEST`

Gửi trigger `confirm_task_with_run_config` thay cho hai trigger riêng: task và cấu hình được xác nhận trong một accept, hoặc
không gì cả. Lỗi `rejected` với `reason` ∈ `revision_changed`, `proposal_missing`, `digest_mismatch`. Không có
`--run-config` thì hành vi như cũ.

### `cusr status`, `cusr doctor`

- Health có thêm `channels.telegram` (cùng shape `telegram_status` trừ `recent_failures`). Lỗi kênh không đổi HTTP 200 thành
  503.
- Doctor thêm check `telegram`: `ok` khi chưa setup (detail "not configured") hoặc khi kênh khỏe; `fail` khi token hỏng,
  webhook bật, xung đột nhận tin, đường gửi đang hỏng hoặc chưa liên kết sau khi đã setup, kèm `fix`.

### `cusr task explain`, `cusr inbox`

Câu hỏi và yêu cầu có thêm `delivery`: `{state, last_error, copies, answered_via}` với `answered_via` ∈ `cli`, `telegram`,
`decider` lấy từ `AuthzContext.issued_by` của event thắng (FR-027).

## Lệnh không đổi

`cusr answer`, `cusr task approve` giữ nguyên hợp đồng; Telegram gọi đúng các command kind này. Không có `task reject`.

## Quyền

| Command/query | Quyền |
| --- | --- |
| `telegram_setup`, `telegram_link_code`, `telegram_unlink` | admin |
| `telegram_status` | read |
| `inbox` | read, lọc theo project của grant |

Caller dựng từ liên kết Telegram dùng cùng `authorize`; `issued_by` là `telegram:<link_id>`.
