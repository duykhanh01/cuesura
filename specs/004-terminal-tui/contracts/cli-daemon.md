# Hợp đồng CLI và daemon bổ sung

Mở rộng [hợp đồng feature 002](../../002-task-to-green-pr/contracts/cli-daemon.md). Các lệnh dưới đây đã có trong bản đang chạy (kiểm bằng `cusr --help`, `cusr task --help`). Giữ nguyên transport, envelope `{schema_version:1,ok,data,error}` và bảng exit code.

Quy tắc chung (FR-040):

- Mọi query đều chỉ đọc, cần quyền `read`, kiểm phạm vi project ở application service và không tạo event.
- Mỗi query có một lệnh CLI với `--json`, nên CLI và assistant kiểm chứng được cùng dữ liệu.
- Output của `task_show`, `task_list`, `task_explain` không đổi. `task_history` và `task_logs` chỉ thêm trường.
- Không trả nội dung token, đường dẫn token, `credential_refs` hay `tool_paths`.

## Lệnh

| Lệnh | Query | Quyền |
| --- | --- | --- |
| `cusr` trong terminal tương tác | Mở giao diện | Theo từng thao tác |
| `cusr project list` | `project_list` | read |
| `cusr task options ID` | `run_options` | read, project của task trong phạm vi |
| `cusr task board [--project P] [--status S] [--scope active\|terminal\|all] [--limit N] [--cursor C]` | `task_board` | read |
| `cusr task content ID` | `task_content` | read, project của task trong phạm vi |
| `cusr task progress ID` | `task_progress` | read, project của task trong phạm vi |
| `cusr task logs ID --attempt ATTEMPT_ID` | `task_logs` | read, project của task trong phạm vi |
| `cusr request show REQUEST_ID` | `request_show` | read, đúng actor, project trong phạm vi |

Không có `--json`, `task board`, `project list`, `task progress` và `request show` in bảng hoặc phần tóm tắt có nhãn cho người đọc; output này có thể đổi, automation dùng `--json`. `request show` nêu rõ kết quả ở dòng đầu, ví dụ `Request completed — operation rejected`, và vẫn exit 0. Cờ sai của `task board` được CLI kiểm trước khi gọi daemon, trả `invalid_arguments`, exit 2.

`cusr` không tham số ngoài terminal, kèm `--json`, khi `TERM=dumb` hoặc không đặt `TERM` vẫn trả `not_available` với exit 2 như hiện tại.

## `project_list`

```json
{
  "caller": {
    "actor": "owner",
    "roles": ["read", "operate", "admin"],
    "trusted_confirmer": true
  },
  "projects": [{ "id": "node-sandbox", "repo": "owner/repo" }],
  "profiles": ["default", "strict"]
}
```

`trusted_confirmer` do daemon tính từ grant (có `operate` là đúng, kể cả assistant), không nhận từ client.
Phạm vi project theo token (`scope`) đã bỏ cùng bearer token. `profiles` là tên profile trong user config, để form tạo task liệt kê; đây là chỗ duy nhất chọn profile.

## `run_options`

Vào: `{ kind, task_id }`. Ra:

```json
{
  "task_id": "...",
  "revision": 1,
  "version": 7,
  "profile": { "id": "default", "source": "task" },
  "modes": [
    {
      "mode": "full-review",
      "when_to_use": "...",
      "reviewers": [{ "harness": "claude", "model": "m", "effort": "high" }],
      "reviewer_fallbacks": [
        {
          "choice": { "harness": "claude", "model": "m", "effort": "high" },
          "fallbacks": [{ "harness": "claude", "model": "m", "effort": "xhigh" }]
        }
      ],
      "workers": [
        {
          "choice": { "harness": "codex", "model": "m", "effort": "high" },
          "fallbacks": [{ "harness": "codex", "model": "m", "effort": "xhigh" }]
        }
      ]
    },
    {
      "mode": "direct-pr",
      "when_to_use": null,
      "reviewers": [],
      "reviewer_fallbacks": [],
      "workers": []
    }
  ],
  "truncated": false
}
```

- `profile.source` là `task` hoặc `project`. Profile chỉ để hiển thị và được gửi nguyên trong đề xuất.
- `reviewer_fallbacks` cho mỗi reviewer trong `reviewers` các nấc ladder reviewer khác nó; đề xuất không có `reviewer_fallbacks` thì daemon điền tối đa 8 nấc thấp nhất (issue #276).
- Danh sách tính bằng `freezePolicy` và `checkSelection` theo task ([R-07](../research.md#r-07--nguồn-của-run_options)), tối đa 64 tổ hợp. `truncated` đúng khi có tổ hợp thực sự bị bỏ qua vì chạm trần (vừa đủ 64 tổ hợp vẫn là `false`), để giao diện không trình bày danh sách là đầy đủ.
- Đọc `cusr.yaml` từ ref base có sẵn ở máy, không `fetch`. Đây vẫn là danh sách để chọn, không phải bằng chứng: lúc bắt đầu daemon đọc base mới nhất và kiểm lại.
- Lỗi, không đoán lựa chọn: config không hợp lệ hoặc không xác định được profile trả `config_invalid`, exit 1; không đọc được base trả `options_unavailable`, exit
  1; task đã bắt đầu trả `conflict`, exit 6; task ngoài phạm vi trả `task_not_found`, exit 4.

## `task_board`

Vào: `{ kind, project?, status?, scope?, limit?, cursor?, order?, if_changed_since? }`; `scope` mặc định `active`, trừ khi có `status` thì mặc định `all` để không che đúng trạng thái đang hỏi; `limit` tối đa 100.

`if_changed_since` chỉ có nghĩa khi các tham số khác giống lần đọc trước. Đổi `project`, `status`, `scope`, `limit`, `cursor` hoặc `order` thì client MUST bỏ
nó, nếu không sẽ nhận `unchanged` cho dữ liệu chưa từng đọc.

Khi `MAX(global_seq)` bằng `if_changed_since`:

```json
{ "unchanged": true, "watermark": 1234 }
```

Khi có thay đổi:

```json
{
  "unchanged": false,
  "watermark": 1240,
  "counts": { "by_status": { "RUNNING": 1, "WAITING": 3, "DONE": 120 } },
  "queue": { "length": 2 },
  "attention": { "items": [], "truncated": false },
  "items": [],
  "next_cursor": null
}
```

- `counts` tính trên toàn bộ phạm vi token và bộ lọc `project`, `status`, không theo trang (EC-005) và không theo `scope`, nên vẫn biết số task đã kết thúc khi đang xem task còn chạy.
- `queue.length` là số request đang chờ slot trong phạm vi token. Slot và health vẫn lấy từ `GET /v1/health`.
- `queue_paused` (`reason`, `by`, `at`, `age_ms`, `command` hoặc null) có ở cả reply `unchanged`, vì tạm dừng hàng
  đợi không đổi watermark.
- `attention.items` gồm mọi task `needs_user` trong phạm vi, tối đa 200. Bộ lọc project áp dụng cả ở đây.
- Mỗi hàng có `task_id`, `project`, `title`, `status`, `wait_code`, `step`, `step_visits`, `mode`, `status_since`, `version`, `priority`, `pr_ref`,
  `needs_user`, `paused` (`reason`, `by`, `at` hoặc null; task tạm dừng mà vẫn chờ CI hay câu trả lời có `wait_code` khác `paused`). `status_since` là `null` khi không xác định được. `step_visits` là số lần vào mỗi bước; TUI dùng nó để thanh stage không lùi khi vòng sửa chạy lại gate.
- `items` và `attention.items` sắp theo task ID như `task_list`: `order` mặc định `oldest`, `newest` xếp task mới tạo lên đầu và
  `cursor` đi dần về task cũ hơn. TUI gửi `newest`; `cusr task board` không gửi nên giữ thứ tự cũ.
- `cusr task board --json` không lặp hàng: task trong `items` chỉ còn `task_id` và `wait_code` ở `attention.items`; `--full` in nguyên reply (xem [Output mặc định gọn](../../002-task-to-green-pr/contracts/cli-daemon.md#output-mặc-định-gọn)).

## `task_content`

Vào: `{ kind, task_id }`. Task ngoài phạm vi trả `task_not_found`. Toàn bộ output đọc trong một lần:

```json
{
  "task_id": "...",
  "project": "...",
  "version": 7,
  "revision": 1,
  "base_branch": "main",
  "title": "...",
  "description": "...",
  "requirements": [],
  "acceptance": ["..."],
  "constraints": [],
  "out_of_scope": [],
  "depends_on": [],
  "priority": 0,
  "intake_pending": true,
  "run_config": null
}
```

`intake_pending` là `needs_confirmation && !confirmed`. `run_config` có cùng dạng với `run_config` của `task_show`, và là `null` khi chưa có
đề xuất.

## `task_progress`

Vào: `{ kind, task_id }`. Ra:

```json
{
  "task_id": "...",
  "version": 7,
  "mode": "direct-pr",
  "steps": [
    { "name": "code", "state": "past", "visits": 1 },
    { "name": "review", "state": "not_required", "visits": 0 }
  ],
  "reason": null,
  "needs_user": false,
  "worktree_path": null
}
```

- `steps` là `null` và `reason` là `not_frozen` khi chưa có policy đóng băng.
- `worktree_path` chỉ khác `null` khi wait là `worktree_changed`, để giao diện chỉ vị trí worktree (US4 số 4).

## `question_show`

Ra thêm `body`, `answer` và `answered_by` của câu hỏi (chỉ thêm trường; `answer` và `answered_by` là `null` khi
câu hỏi còn mở hoặc đã rút). Hộp thoại Answer dùng chúng để hiện câu hỏi đã rời inbox và câu trả lời ở nơi
khác (`Answered elsewhere`). Client cũ bỏ qua các trường này; TUI chấp nhận daemon cũ thiếu chúng.

## `task_logs`

- Vào thêm `attempt_id?`. Khi có, chỉ trả bản ghi của operation thuộc attempt đó; cursor vẫn là cursor chung của task.
- Bản ghi và `gap` thêm `attempt_id`, `null` khi operation không thuộc attempt.
- Giữ `LOG_PAGE_RECORDS = 200` và giới hạn 1 MiB mỗi trang.
- Vào thêm `tail?: boolean`. Khi `true`, bỏ qua `after` và trả những bản ghi cuối (của attempt nếu có `attempt_id`),
  nhiều nhất `limit` bản ghi và 1 MiB, nên trang luôn tới hết log; bản ghi cuối luôn có mặt dù vượt 1 MiB.
  Ra thêm `after`: cursor đứng ngay trước trang đó, để đọc phần trước bằng `after` như thường.
  CLI: `cusr task logs ID --tail`, dùng được cùng `--follow`, không dùng cùng `--after`.
- Ra thêm `more`: `true` khi sau `next_cursor` còn bản ghi mà trang này không chứa hết, để người đang theo dõi đọc tiếp ngay.
- Daemon giữ bản ghi đã đọc của tối đa 16 operation. Mỗi lần đọc, nó chỉ parse phần spool ghi thêm. Spool đổi
  segment đầu, hoặc file của run đổi tên hay kích thước, thì đọc lại từ đầu, nên gap vẫn được báo như cũ.

## `request_show`

Vào: `{ kind, request_id }`, `request_id` phải là UUID. Ra:

```json
{
  "request_id": "...",
  "kind": "task_add",
  "state": "completed",
  "project": "node-sandbox",
  "task_id": "...",
  "admitted_at": 1793491200000,
  "completed_at": 1793491200500,
  "outcome": { "ok": true, "value": {} },
  "next_step": null
}
```

- `state`: `completed`, `in_progress`, `interrupted`.
- `task_id` chỉ khác `null` khi task có thật. ID cấp sẵn của `task_add` chưa tạo task không được trả (FR-042).
- `outcome` chỉ có ở `completed`, gồm cả từ chối; khi đó exit vẫn là 0 vì query đã được xử lý.
- `next_step` với `interrupted` nêu nguyên nhân và việc cần làm: gửi lại đúng lệnh với cùng `--request-id` để handler chạy nốt trên
  những gì lần đầu đã ghi (#267); có task thì đọc task trước. Nguyên nhân là daemon dừng giữa chừng, hoặc handler ném lỗi trong lúc
  daemon vẫn chạy (lệnh khi đó nhận `internal` có `request_id`, ledger giữ hàng `admitted`). Daemon chỉ nhớ lỗi handler đến khi
  khởi động lại; sau đó `next_step` nói daemon đã dừng.
- Không có hàng, actor khác, project ngoài phạm vi, hoặc hàng không xác định được project với token `limited`: lỗi `request_not_found`, exit
  4, cùng message và details (FR-043). Thêm mã này vào danh sách `MISSING` của `errors.ts`.
- Query không chạy handler, không gọi `admitCommand`, không gửi lại kết quả qua đường command.

Vì sao có thể tin kết luận `not_found` ở mức nào: ledger ghi trước preflight nên `not_found` nghĩa là chưa được nhận tại lúc tra. Request vẫn có
thể tới sau đó nếu còn trên đường truyền, nên giao diện và CLI MUST NOT nói là không xảy ra.
