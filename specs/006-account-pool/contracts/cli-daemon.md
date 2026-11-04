# Hợp đồng CLI và daemon: `cusr account`

Theo quy ước chung ở [SPEC §15.1](../../../SPEC.md#151-giao-diện-cli): `--json` trả envelope `schema_version`, `ok`, `data`,
`error`; lệnh thay đổi có `request_id` và chống lặp theo `command_ledger`. Mọi lệnh thay đổi cần quyền `admin` (FR-008);
`project` của lệnh là `null`.

## Lệnh

| Lệnh | Kind | Quyền | Payload |
| --- | --- | --- | --- |
| `cusr account add <harness> --name <n> [--priority <p>]` | `account_add` | admin | `harness`, `name`, `staging_id`, `priority?` (mặc định `0`, nên xếp sau tài khoản mặc định); CLI chạy login vào thư mục tạm trước (R-08) |
| `cusr account login <harness> <name>` | `account_login` | admin | `account_id`, `staging_id`, `expected_source_digest`; đăng nhập lại cùng danh tính |
| `cusr account list [--harness <h>]` | query `account_list` | read | `harness?` |
| `cusr account use <harness> <name>` | `account_use` | admin | `account_id` |
| `cusr account priority <harness> <name> <p>` | `account_set_priority` | admin | `account_id`, `priority` |
| `cusr account suspend <harness> <name> [--reason <r>]` | `account_suspend` | admin | `account_id`, `reason?` |
| `cusr account resume <harness> <name>` | `account_resume` | admin | `account_id` |
| `cusr account clear-cooldown <harness> <name>` | `account_clear_cooldown` | admin | `account_id` |
| `cusr account check <harness> <name>` | `account_check` | admin | `account_id`; chạy probe như một effect sau commit (R-09); CLI chờ kết quả. Đạt thì gỡ `auth_error`; với tài khoản mặc định còn nhận danh tính mới và gỡ `identity_changed` |
| `cusr account retry-write <harness> <name>` | `account_retry_write` | admin | `account_id`; thử ghi bản chờ ngay |
| `cusr account remove <harness> <name>` | `account_remove` | admin | `account_id` |

`<name>` được CLI đổi sang `account_id` qua `account_list`; daemon kiểm `account_id` còn tồn tại.

## Quy tắc từng lệnh

| Lệnh | Quy tắc | Lỗi |
| --- | --- | --- |
| `add` | Login hoàn tất; credential trong thư mục tạm là file thường, không rỗng, đúng định dạng vendor của harness; tên chưa dùng trong harness. Daemon commit `AccountAdded` rồi mới chuyển thư mục tạm thành thư mục của tài khoản; crash ở giữa thì lúc khởi động daemon chuyển nốt (R-08). Danh tính trùng tài khoản khác thì vẫn thêm và trả `warnings: [same_identity]`, kèm thông điệp rằng tài khoản này không tăng hạn mức | `login_cancelled`, `login_failed`, `credential_invalid`, `name_taken` (exit 2) |
| `login` | Danh tính mới phải trùng danh tính của tài khoản; thay credential theo khóa + CAS (R-06), tài khoản mặc định không đăng nhập lại được bằng lệnh này (người dùng đăng nhập bằng CLI của vendor rồi `check`). Thành công thì gỡ `auth_error` nếu có | `identity_mismatch`, `account_system` (exit 2), `superseded` (exit 6) |
| `use` | Đặt `priority` = ưu tiên cao nhất hiện có của harness + 1 (FR-008a) | `account_suspended` (exit 6) |
| `clear-cooldown` | Chỉ gỡ cooldown đã biết tại lúc nhận lệnh (Q16); đánh thức task đang chờ (FR-014b) | — |
| `resume`, `check` thành công | Gỡ đúng một nguyên nhân (Q8); đánh thức task nếu tài khoản thành sẵn sàng | `check_failed` (exit 1) cho `check`; hết thời gian chờ thì in `pending` (exit 0) |
| `remove` | Không dừng attempt đang chạy; xóa thư mục của tài khoản `managed` kể cả bản chờ ghi; với tài khoản mặc định chỉ bỏ khai báo, không xóa file của người dùng, và daemon không tạo lại nó | — |

Mọi lệnh thay đổi ghi event kèm `actor` và `reason`. Người gọi thiếu `admin` nhận `forbidden` (exit 5), kể cả token
`operate` của một project.

## Query `account_list`

```json
{
  "schema_version": 1,
  "ok": true,
  "data": {
    "accounts": [
      {
        "account_id": "019a…",
        "name": "work",
        "harness": "claude",
        "priority": 10,
        "available": false,
        "blocks": [{ "cause": "cooldown", "until": "2026-11-04T15:30:00Z", "source": "vendor" }],
        "identity_detectable": true,
        "running_attempts": 1,
        "last_used_at": "2026-11-04T12:00:00Z",
        "tasks": ["019a…"],
        "admin": {
          "source_kind": "managed",
          "identity_label": "k***@example.com",
          "last_write": { "outcome": "written", "at": "2026-11-04T12:05:00Z" },
          "filesystem_error": null
        }
      }
    ],
    "episodes": [{ "episode_id": "019a…", "harness": "claude", "state": "open", "earliest_ready_at": "…", "version": 3 }]
  },
  "error": null
}
```

Lọc theo quyền (FR-007, R-09):

| Trường | Ai thấy |
| --- | --- |
| `name`, `harness`, `priority`, `available`, `blocks`, `identity_detectable` | Mọi token `read` |
| `running_attempts`, `last_used_at`, `tasks` | Chỉ tính trong project token được đọc; token `projects: '*'` thấy toàn bộ |
| `admin` | Chỉ token có `admin`; token khác không có khóa này |

`blocks[].cause`: `cooldown`, `auth_error`, `identity_changed`, `pending_write`, `suspended`.

## Bổ sung cho query hiện có

| Query | Thêm |
| --- | --- |
| `task_show`, `task_history` | `account` (tên, id) của mỗi attempt và mỗi lần chuyển kèm lý do (FR-019) |
| `report` | Mục `notices` theo đợt hết hạn mức, lọc theo quyền; mục `running`/`finished` kèm tài khoản của attempt |
| `doctor` | Mỗi tài khoản: nguồn tồn tại, file thường, quyền file, định dạng vendor, danh tính đọc được hay không, trùng danh tính; không in nội dung (FR-009) |

## Tương thích

Không đổi output của lệnh hiện có ngoài trường bổ sung. Cấu hình `credential_refs` vẫn đọc được; nó dùng để tạo
tài khoản mặc định chỉ đọc (R-11). Không có lệnh nào nhận đường dẫn tới credential có sẵn.
