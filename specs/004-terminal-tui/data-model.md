# Data model: giao diện terminal

Giao diện không có dữ liệu bền. Các entity dưới đây là trạng thái tạm trong một phiên, kiểu dữ liệu đọc từ daemon và một
cột mới trong `command_ledger`. Không thêm task status, event type hay lối ra. Đây là thiết kế, chưa phải schema đã triển khai.

## Thay đổi lưu trữ

| Bảng | Thay đổi | Quy tắc |
| --- | --- | --- |
| `command_ledger` | Thêm `project TEXT` qua migration 004 | Ghi ở lần nhận đầu tiên; không đổi `command_hash`. Hàng cũ backfill từ `tasks` khi có task; không có thì giữ `NULL` |

## Dữ liệu trong phiên

### Phiên giao diện

| Trường | Ý nghĩa |
| --- | --- |
| `connection` | `connecting`, `online`, `reconnecting{attempt}`, `waiting_retry`, `stopped{reason}` |
| `last_updated_at` | Thời điểm cập nhật thành công cuối |
| `stale` | Đúng khi lần làm mới board hoặc health gần nhất thất bại; khóa mọi thao tác ghi mới (FR-044) |
| `stale_tasks` | Task có đọc chi tiết gần nhất thất bại; khóa thao tác ghi mới trên task đó (FR-044) |
| `caller` | Actor, vai trò, phạm vi, `trusted_confirmer` từ `project_list` |
| `screen_stack` | Màn hình đang mở, gồm các hộp thoại |
| `selected_task_id` | Giữ theo task ID, không theo dòng (EC-013) |
| `filters` | Project và status. Mỗi lần mở đều bắt đầu không lọc (FR-008) |
| `board` | Dữ liệu `task_board` mới nhất và `watermark`. Đổi `project`, `status`, `scope`, `limit` hoặc `cursor` thì bỏ `watermark` |
| `mutations` | Danh sách thao tác đang gửi |
| `drafts` | Nội dung đang nhập, chỉ trong bộ nhớ (FR-038) |

Chuyển trạng thái kết nối:

```text
connecting ──ok──▶ online ──đọc lỗi──▶ reconnecting{1}
reconnecting{n} ──ok──▶ online (đọc lại rồi mới mở khóa ghi)
reconnecting{n<30} ──lỗi──▶ reconnecting{n+1}
reconnecting{30} ──lỗi──▶ waiting_retry ──Retry connection──▶ reconnecting{1}
mọi trạng thái ──lỗi không tự hết──▶ stopped ──người dùng yêu cầu──▶ connecting
```

### Thao tác đang gửi

| Trường | Ý nghĩa |
| --- | --- |
| `request_id` | UUIDv7 sinh một lần cho mỗi thao tác logic |
| `command` | Toàn bộ body gửi đi: `kind`, `project`, `task_id`, `expected_version`, `payload`; không đổi khi gửi lại |
| `state` | Xem bảng dưới |
| `result` | Kết quả daemon trả về |
| `checks`, `resends` | Số lần `request_show` và số lần gửi lại trong vòng hiện tại; tối đa 60 và 5 |

| Từ trạng thái | Sự kiện | Sang trạng thái |
| --- | --- | --- |
| `sending` | Phản hồi `ok` | `accepted`; sau đó hiện trạng thái thật theo daemon (FR-020) |
| `sending` | Bị từ chối (quyền, xung đột version, dữ liệu) | `rejected`; không gửi lại |
| `sending` | Lỗi kết nối hoặc timeout | `unknown` |
| `unknown` | `request_show` trả `completed` | Theo kết quả đã lưu |
| `unknown` | `request_show` trả `in_progress` | Giữ `unknown`, hỏi lại theo chu kỳ làm mới |
| `unknown` | `request_show` trả `interrupted` hoặc `not_found` | `sending` với đúng request ID và command |
| `unknown` | Hết trần `checks` hoặc `resends` | `unresolved`; dừng tự động (FR-019) |
| `unresolved` | Người dùng chọn `Check again` | `unknown` với `checks` và `resends` về 0 |
| `unknown`, `unresolved` | Người dùng thoát | In request ID và lệnh tra cứu ra stderr, exit 3 (EC-012) |

Quy tắc: thao tác `unknown` hoặc `unresolved` chặn gửi thao tác ghi mới trên cùng task. Một thao tác logic chỉ có một request ID
(FR-019). Lúc mất kết nối không tính `checks` và `resends`, vì đã có giới hạn lượt kết nối lại.

### Trạng thái log

| Trường | Ý nghĩa |
| --- | --- |
| `mode` | `live` hoặc `paused`; cuộn lên chuyển sang `paused` |
| `attempt_filter` | `null` hoặc một attempt ID |
| `next_cursor` | Vị trí đọc tiếp, không đổi qua rotation hay restart |
| `buffer` | Tối đa 5.000 bản ghi hoặc 8 MiB, bản ghi cũ bị bỏ và đọc lại theo cursor |
| `new_activity` | Đúng khi có bản ghi mới mà người dùng chưa xem |

`live` theo tiếp bước mới và chèn dòng phân cách khi `(step, attempt_id)` đổi. `paused` hoặc có lọc attempt thì chỉ đánh dấu
`new_activity`, không đưa bản ghi vào bộ đệm.

## Dữ liệu đọc từ daemon

Hợp đồng đầy đủ ở [cli-daemon.md](contracts/cli-daemon.md).

### Hàng task

Từ `task_board.items`: `task_id`, `project`, `title`, `status`, `wait_code`, `step`, `mode`, `status_since`, `version`, `priority`,
`pr_ref`, `needs_user`.

Hoạt động hiện tại (FR-006) được giao diện dựng từ các trường này qua bảng trong `src/tui/model/activity.ts`. Mã chưa có trong bảng
hiện nguyên mã, không đoán. Đây chỉ là cách trình bày, không phải trạng thái mới.

### Nhóm cần bạn xử lý

`needs_user` do `needsUser(state)` ở daemon tính, dùng chung cho `task_board` và `task_progress`:

| Điều kiện | `needs_user` |
| --- | --- |
| Task đã kết thúc | `false` |
| `READY` và chưa xác nhận cấu hình chạy | `true` |
| `READY` đã xác nhận, hoặc đang chạy không có wait | `false` |
| Wait `dependency_pending`, `execution_slot`, `checks_incomplete`, `infra_backoff`, `rate_limited`, `effect_unknown`, `observation_unknown`, `merge_cleanup_pending` | `false`: đang chờ trong giới hạn |
| Mọi `DetailCode` còn lại | `true` |

Bảng có kiểu `Record<DetailCode, boolean>`, nên mã mới phải được phân loại mới biên dịch được. Test kiểm từng dòng với task mẫu của
FR-029 feature 002.

### Tiến trình bước

`task_progress.steps` đi theo graph trong `FrozenPolicy.workflow` từ `start`, thứ tự duyệt ổn định:

| Trạng thái | Điều kiện |
| --- | --- |
| `current` | Bước bằng `current_step` |
| `past` | Có `step_visits` và không phải bước hiện tại |
| `remaining` | Có trong graph, chưa chạy |
| `not_required` | Có trong graph `full-review` nhưng không có trong graph của chế độ đã chốt, ví dụ `review` của `direct-pr` |

Chưa có policy đóng băng thì `steps` là `null` kèm `reason`. `past` không có nghĩa là đạt: kết quả lấy từ attempt và bằng chứng.

### Kết quả tra cứu request

| Trạng thái | Điều kiện | Exit code |
| --- | --- | --- |
| `completed` | Ledger có kết quả; `outcome` là kết quả đầu tiên đã lưu, thành công hoặc bị từ chối | 0 |
| `in_progress` | Ledger `admitted` và đang có trong `inFlight` | 0 |
| `interrupted` | Ledger `admitted` và không có trong `inFlight` | 0 |
| `request_not_found` | Không có hàng, hoặc không được đọc theo FR-043 | 4 |

### Nội dung xem lại

Từ `task_content`, đọc trong một lần: `version`, `revision`, `project`, `base_branch`, `title`, `description`, `requirements`,
`acceptance`, `constraints`, `out_of_scope`, `intake_pending`, `run_config`.

Cho xác nhận chỉ khi đọc thành công và dữ liệu không cũ. Danh sách rỗng hiển thị "None", khác với "Could not read".

### Phạm vi xác nhận

`intake_pending` là `needs_confirmation && !confirmed`. Cấu hình chạy "cần xác nhận" khi `run_config` khác `null`, `run_config.status`
khác `confirmed` và `run_config.selection.revision` bằng `revision`.

| `intake_pending` | Cấu hình cần xác nhận | `trusted_confirmer` | Phạm vi | Lệnh `task_confirm` |
| --- | --- | --- | --- | --- |
| Có | Không | Bất kỳ | Intake | Không gửi digest |
| Có | Có | Có | Cả hai | Gửi digest |
| Có | Có | Không | Intake; ghi rõ cấu hình chạy cần kênh tin cậy | Không gửi digest |
| Không | Có | Có | Cấu hình chạy | Gửi digest |
| Không | Có | Không | Không xác nhận được; ghi rõ cần kênh tin cậy (US5 số 7) | Không gửi |
| Không | Không | Bất kỳ | Không có gì để xác nhận | Không gửi |

Cấu hình thuộc revision khác không bao giờ được gửi digest; giao diện hiện nó là đã cũ và cho đề xuất lại.
