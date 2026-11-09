# CLI, daemon và cấu hình runtime

Hợp đồng cho feature 002, mở rộng [CLI v1](../../../SPEC.md#15-cli-kênh-nguồn-và-quyền-truy-cập).
Bảng lệnh dưới đây đã có trong `cusr`/`cusrd` (T106–T120); `cusrd` production chưa nối effect handler,
xem [T120](../acceptance-report.md#t120--us6-xem-và-điều-khiển-qua-cli). Đầu vào task vẫn theo CanonicalTaskSchema; CLI chuẩn hóa trường tùy chọn,
server gắn task ID/requester đáng tin, không nhận `AuthzContext` do caller tự khai.

## Xác nhận cấu hình trước spawn

Áp dụng [M01–M08](../task-execution-modes.md): agent nhận task đọc chỉ dẫn `when to use` để đề xuất;
daemon chỉ validate lựa chọn tường minh. Trước spawn đầu, người dùng xem task/revision, profile,
mode, worker harness/model/effort và reviewer binding nếu `full-review`, cùng fallback đã cho phép.
Xác nhận từ kênh người dùng đáng tin gắn với digest bộ lựa chọn; assistant không tự khai `confirmed`
để vượt bước này, quyền operate không được nâng lên. Task do assistant tạo mặc định chờ xác nhận intake; auto-confirm intake và hạn mức tạo task theo
client chỉ do người dùng cấu hình. Auto-confirm intake không miễn xác nhận chạy. `task add` từ requester
có trong `intake.auto_confirm` của user config tạo task không chờ intake (`TaskCreated` mang
`intake_auto_confirmed: true`); payload không có trường nào để caller tự khai việc này.
Giao diện có thể gộp cùng một lượt xác nhận khi hiển thị task và toàn bộ cấu hình chạy; bằng chứng
phải ghi rõ cả hai phạm vi, không biến auto-confirm intake thành duyệt binding.
Các key/command/proof cụ thể cần triển khai, chưa phải CLI/schema hiện có.

Confirm/recheck không tự chọn lại binding. Cấu hình hiệu lực khác bộ đã xác nhận thì chờ xác nhận
mới trước spawn; retry/resume trong bộ đã duyệt không hỏi lại. Task đã bắt đầu không đổi mode/graph;
tạo task mới nếu cần đổi. `task amend-policy` (issue #105) chỉ đổi binding của bước đang chờ sau khi
hết thang/lượt, và chính lần xác nhận amendment của owner là xác nhận binding mới cho role đó. Không ràng buộc vendor và không hạ
`full-review` xuống `direct-pr` khi hết quota.

## Lệnh và quyền

| Lệnh | Quyền / hành vi |
| --- | --- |
| `cusrd --config FILE --data-dir DIR` | Owner khởi động daemon foreground; có unit systemd mẫu; một writer |
| `cusr doctor --project NAME`, `cusr status` | read; doctor kiểm capability và health, lỗi health exit 1. Doctor đạt trả `data.checks`; có check hỏng thì exit 1, `error.code` `unhealthy`, `data: null` và các check (check hỏng kèm `fix`) nằm ở `error.details.checks`. Probe unit systemd và terminal đạt được daemon dùng lại 30 giây (detail ghi `checked Ns ago`); probe hỏng chạy lại ở lần sau (issue #260). Xem [Health](#confirmrecheck-pending-và-health) cho `status` |
| `cusr task add --file FILE` | operate; JSON task input, trả task có thể PENDING/READY, không chờ tới PR. `acceptance` rỗng trả `invalid_arguments` (exit 2), không tạo task. `scope` (hoặc `--scope a,b`) khai đường dẫn/thư mục/glob tương đối trong repo task dự kiến đổi (tối đa 100, không `..` hay đường dẫn tuyệt đối; glob chỉ dùng `*`, `**`, `?`, `[...]`, còn brace `{}`, extglob `@(…)`/`!(…)`…, `!` đầu mục và lớp ký tự chứa `/` bị từ chối); không khai thì trường vắng mặt. Kết quả `task add`, `task propose` và `task confirm` có `slot_block` (như `scope.slot_block` của explain) khi phạm vi giao với task đang giữ slot, chỗ giữ hoặc chỗ mượn, `null` khi không (FR-044.08) |
| `cusr task propose ID --profile P --mode M --worker H/M/E` | operate; đề xuất bộ lựa chọn chạy, xác nhận riêng. Daemon đối chiếu đề xuất (của `task propose` và `run_config` của `task add`) với `run_options`: profile, mode, worker, reviewer hay fallback không có trong đó trả `rejected` (`run_config_not_offered`) kèm `details.valid_values`; `task add` khi đó không tạo task. Không đọc được `run_options` thì trả lỗi của nó. Vắng `fallbacks` thì daemon điền các nấc ladder của worker từ `run_options`; `--fallback ''` (`fallbacks: []`) là không có (issue #263) |
| `cusr task show/list/explain/history` | read; mặc định chỉ trả phần cần thiết, `--full` trả nguyên reply của daemon (xem [Output mặc định gọn](#output-mặc-định-gọn)); list mới nhất trước, `--limit` mặc định 20, tối đa 100, có cursor và `--order oldest`; show/explain nhận ID |
| `cusr task logs ID --after CURSOR [--follow]` | read; snapshot hữu hạn (mặc định 20 record) hoặc stream JSONL có seq/cursor; mặc định in bản gọn (xem [Output mặc định gọn](#output-mặc-định-gọn)), `--full` in nguyên record; một follow session tối đa 1 giờ, có thể nối lại |
| `cusr task confirm/cancel/recheck ID` | operate; version/dedup; recheck chọn cấu hình/PR/drain/worktree theo task, không gọi agent; với `worktree_changed` (trước lượt worker, hoặc sau gate có checkpoint commit khác tree) thì nhận tree đã quan sát làm mốc của task rồi chạy lại bước; với `manifest_changed` thì nhận manifest harness đang hiệu lực rồi chạy lại bước; với `harness_auth`, hoặc `loop_exhausted` mà các lượt cuối lỗi infra/rate limit/đăng nhập, thì trả visit của các lượt đó rồi chạy lại bước |
| `cusr task pause ID --reason TEXT [--now]`, `cusr task resume ID` | operate; version/dedup; xem [Tạm dừng task](#tạm-dừng-task) |
| `cusr task message ID --file FILE [--behavior steer\|interrupt\|queue]` | operate; `--file -` đọc stdin; version/dedup; xem [Tin nhắn cho agent](#tin-nhắn-cho-agent) |
| `cusr queue pause --reason TEXT`, `cusr queue resume` | operate; không có project, task hay version; xem [Tạm dừng task](#tạm-dừng-task) |
| `cusr dispatch --project ID` | read trong phạm vi project; trả `project`, `source` (`project`, `global` hoặc `none`), `modes`, `rules`, `default`. Lấy từ `projects.<id>.dispatch`, không có thì `runtime.dispatch`; đọc config mỗi lần gọi; `use[]` trả về dạng `{worker, reviewer?}` kèm `profile`, `mode` để chép thẳng vào `task propose`; không chứa secret, không chọn thay người dùng |
| `cusr inbox`, `cusr answer QUESTION --file FILE --expected-version N` | read/operate; câu trả lời đầu thắng, ràng buộc revision/version; `--file -` đọc stdin. Câu trả lời thua trả `conflict` (`reason: "already_answered"`, `answered_by`), exit 6, như `question_not_open`; event `AnswerRejected` nó ghi không đổi phần task mà version so sánh, nên version bên thua đã đọc vẫn dùng được cho mutation tiếp theo |
| `cusr task approve ID --kind escalation --step STEP --rung N` | operate; task/revision/policy hash đúng, không cấp merge. Engine chỉ xin duyệt nấc còn ngân sách escalation và nằm trong bộ đã xác nhận: hết ngân sách thì chờ `escalations_exhausted`, nấc ngoài bộ thì task kết thúc `run_config_unconfirmed` mà không mở wait `escalation` (issue #263) |
| `cusr task approve ID --kind adopt --head-sha SHA` | admin; task khai `--pr`/`pr_ref`, chưa start; PR mở, cùng repo (không fork), đúng base, head đúng SHA, không task sống nào đang giữ PR |
| `cusr project list`, `cusr task options/content/progress ID`, `cusr task board`, `cusr request show REQUEST_ID` | read; truy vấn chỉ đọc không tạo event, thêm cho giao diện terminal và assistant; hợp đồng đầy đủ ở [feature 004](../../004-terminal-tui/contracts/cli-daemon.md) |
| `cusr task amend-policy ID --model M [--effort E]` | read; xem trước amendment khi task chờ `escalations_exhausted` hoặc `loop_exhausted` do lỗi chất lượng (task cũ còn chờ `ladder_exhausted`/`rung_denied` cũng được; task mới hết nấc thì `FAILED`): trả nấc, binding thêm/thay, trạng thái nấc (`auto`/`needs_approval`), thay đổi `extra_visits`/`max_escalations` và `policy_hash` mới; không tạo event. Model ngoài `allow_models` hoặc bị `above: deny` trả `rejected` (`model_denied`) |
| `cusr task amend-policy ID --model M [--effort E] --reason TEXT --confirm HASH` | admin; version/dedup; dựng lại amendment từ state và cấu hình user hiện tại, hash khác bản xem trước thì `conflict` (`policy_changed`); khớp thì ghi `PolicyAmended` (policy version + 1) và task chạy tiếp từ bước đang chờ |
| `cusr task retry`, merge approval, yolo | unsupported_feature, exit 2; không tạo mutation nghiệp vụ |

Mọi mutation nhận `--request-id UUID`, `--expected-version N` khi sửa task hiện có; task add không
cần expected-version. Nếu CLI tự sinh request ID phải in lại trong kết quả để người dùng đối chiếu
sau timeout. `--project` tùy chọn với lệnh theo ID: CLI gửi `project: null` và daemon điền project của
`task_id` trước admission (issue #259), nên không tốn thêm `task_show`; mỗi handler vẫn kiểm cặp project/task
như trước, task không tồn tại trả `task_not_found`. Daemon cũ trả `project: required` thì CLI đọc project
qua `task_show` rồi gửi lại cùng request ID. Cùng ID+canonical payload trả cùng kết quả; payload khác conflict. New request ID mới
thử lại cấu hình đã sửa; replay request cũ không âm thầm đọc base mới rồi đổi kết quả.

`--expected-version N` của lệnh người dùng (`HUMAN_TRIGGERS`) đi qua `accept` của store vẫn hợp lệ
khi `N` nhỏ hơn version hiện tại mà phần trạng thái thật của task ở version `N` giống hiện tại (#262).
Phần đó là `materialView` (`src/engine/material.ts`): toàn bộ state của task, chỉ trừ những gì công
việc nền làm đổi, gồm version, effect, timer, operation, output đã ingest (`artifacts`), bộ đếm poll CI
(`ci_polls`, `run.ci_wait`), lịch quan sát PR (số vòng, id, thời điểm; vẫn giữ subject, `expired`,
status và head lần đọc cuối) và timer mà wait đang chờ (`wait.detail.timer_id`, `timer(...)` trong
`resume_when`). Mọi field khác, như wait và toàn bộ detail, baseline đã chấp nhận (`run.worktree_tree`,
manifest), attempt, budget đã dùng, câu hỏi, approval, run config, policy, pause, cancel, tin nhắn hay
evidence, đổi thì version trước đó bị `stale_version`. Field chỉ công việc nền làm đổi mới được loại
khỏi view; field nào lệnh dùng để quyết định phải ở lại trong view. Vì vậy vòng poll CI không đổi kết
quả, vòng quan sát PR còn mở, `SignalIgnored` hay lệnh bị từ chối mà không đổi state đều không làm
version cũ bị `stale_version`. Daemon dựng lại state ở `N` (replay log tới `N`) rồi so với state hiện
tại trong cùng transaction. Các trường hợp vẫn so version tuyệt đối:

- `N` lớn hơn version hiện tại, hoặc task chưa tồn tại.
- Trigger nội bộ của daemon, vì chúng quyết định theo cả effect và timer.
- `cusr task propose`: application tự so version trước khi ghi, không qua `accept`.

Còn hai khe hẹp. Trong vài giây một vòng poll CI đang chạy, task ở `RUNNING`, nên lệnh gửi với version
đọc lúc `WAITING` tới đúng khe đó vẫn bị `stale_version`. Lần quan sát PR đầu tiên cũng đổi view một
lần. Gặp hai trường hợp này thì đọc lại rồi gửi lại.

Vòng poll CI đọc lại đúng kết quả đã ghi (cùng head, cùng required set, checks và required) không ghi
thêm `CiResultRecorded`; chuỗi effect của vòng poll vẫn ghi đủ để phục hồi sau crash.

`--json` cho mọi lệnh; output finite đúng một object `{schema_version:1,ok,data,error}`. Error gồm
code/message/details/request_id. Log/chẩn đoán vào stderr, không ANSI/prompt. Exit 0 processed, 1
execution/health failure, 2 syntax/config/unsupported, 3 connection/timeout, 4 missing, 5 forbidden,
6 conflict. Status task không quyết định exit code của lệnh query. Reply của daemon lớn hơn 8 MiB thì
client trả `response_too_large` (exit 1, không phải `daemon_unreachable`) có `details.limit_bytes` và
`details.guidance` gợi ý giảm `--limit` hoặc bỏ `--full`.

### Lỗi của mutation bị engine từ chối

Mọi service mutation (add, propose, confirm, recheck, continue, pause, resume, message, cancel, answer,
approve, amend-policy) ánh xạ quyết định của engine qua cùng một hàm
([engine-verdict.ts](../../../src/application/engine-verdict.ts)), nên mã reject thô của engine không tới
CLI. Lỗi có `details.reason` là mã của engine và `details.detail` là chi tiết engine trả; `message` lấy
`detail.reason` khi có.

| Engine trả | `error.code` | Exit / HTTP |
| --- | --- | --- |
| `invalid_trigger`, `workflow_change_forbidden` (trạng thái task không cho phép) | `rejected` | 6 / 409 |
| `task_exists`, `pr_in_use`, `question_not_open`, `approval_mismatch` | `conflict` | 6 / 409 |
| Trigger bị bỏ qua vì task đã kết thúc (`SignalIgnored{reason: "terminal"}`) | `conflict`, `reason: "task_terminal"` | 6 / 409 |
| `dependency_invalid` | `invalid_arguments`; thiếu task thì `details.missing` liệt kê ID | 2 / 400 |
| `invalid_trigger` với `base_repair_answer_must_be_continue_or_retry_fixer` | `invalid_arguments`, `details.choices` | 2 / 400 |
| `invalid_trigger` với `recheck_not_applicable` | `nothing_to_recheck`, `details.target` là target engine từ chối | 6 / 409 |
| `untrusted_confirmation`, `not_admin` | `forbidden` | 5 / 403 |
| `unknown_task` | `task_not_found` | 4 / 404 |
| `id_pool_exhausted` (daemon gán thiếu ID) | `id_pool_exhausted` | 1 / 422 |

`task cancel` vào task đã kết thúc không bị từ chối: trả `ok` với `ignored: "terminal"`, vì task đã dừng
đúng như lệnh muốn. `task recheck` cũng vậy: trả `ok` với `target: "terminal"`, `performed: false`, chỉ
ghi nhận tín hiệu (FR-046.08). Lệnh bị bỏ qua vẫn ghi `SignalIgnored` vào history.

`task recheck` khi task không có gì để recheck luôn trả `nothing_to_recheck` (exit 6), dù service thấy
trước (`details.target: null`, kèm `status`) hay engine từ chối target (`details.target` là target đó).
`task pause` vào task đang tạm dừng và `task resume` vào task không tạm dừng đều trả `ok` với
`ignored: "already_paused"`/`"not_paused"`, nên gửi lại sau timeout bằng request ID mới không ra exit 6
cho lệnh đã có hiệu lực (issue #260).

Data dir của `cusr` lấy theo thứ tự `--data-dir`, `CUSR_DATA_DIR`, `~/.cusr`. `--data-dir` là option toàn cục:
đặt trước lệnh (`cusr --data-dir DIR status`) hay sau lệnh đều được; cho cả hai chỗ thì giá trị sau lệnh thắng.
Không mở được socket thì lỗi `daemon_unreachable` (exit 3) có `details.data_dir`; khi socket không có
(`ENOENT`) hoặc bị từ chối (`ECONNREFUSED`), thêm `details.guidance`: chép config mẫu
[deploy/config.example.yaml](../../../deploy/config.example.yaml), chạy
`cusrd --config FILE --data-dir DIR` (daemon tự tạo data dir, không có token phải tạo), hoặc trỏ `cusr`
tới data dir của daemon đang chạy. Output cho người đọc in `guidance` thành dòng stderr thứ hai.

`cusr` từ chối chạy khi environment có `CUSR_ATTEMPT_ID` (mọi lượt harness của worker) hoặc
`CUSR_OPERATION_ID` (mọi process daemon chạy cho một operation: gate, setup, Git): lỗi `worker_refused`,
exit 5, trước khi mở socket hay giao diện terminal. Riêng `cusr assistant session-start` và
`cusr assistant hook` thoát 0 không in gì, vì hook trong settings của owner có thể chạy trong worker.
Lỗi cú pháp của lệnh dưới `cusr assistant` mà harness chạy làm hook (`hook`, `session-start`, lệnh con
không tồn tại) thoát 1 thay vì 2: exit 2 của hook có `asyncRewake` đánh thức phiên, nên lệnh hook hỏng
sẽ đánh thức phiên ở mọi Stop (#268). `wait`, `register`, `unregister` do agent chạy vẫn thoát 2.
`cusrd` và `cusr-runner` không kiểm biến này. Giống `CUSR_ACTOR`, đây là rào chắn cho agent làm đúng quy
ước, không phải ranh giới quyền: process cùng UID xóa biến là qua (#185).

Priority số lớn chạy trước; default 0. Explain gồm deadline chưa bắt đầu/đã hết, thời gian chờ slot
ban đầu/xin lại, PR/head/base, các blocker còn hiệu lực, bằng chứng và allowed_actions từ FR-029.
Mỗi `allowed_actions[i]` có `action`, `command`, `note` và `requires` (`operate`, `admin`, hoặc `null`
khi không có lệnh). `command` không chứa `<...>`/`[...]` và không chứa placeholder cho giá trị engine đã
biết (question ID, step/rung của escalation, head SHA adopt đã đọc); thiếu giá trị thì `command: null`
và `note` nói cách lấy. Wait có `answer(<qid>)` trong `resume_when` luôn có `answer` đứng đầu, bất kể mã
wait. Task đã có yêu cầu cancel không được gợi ý `cancel` nữa (trừ `--force` của `cancel_reconcile`) mà
gợi ý `wait`. Explain có `dependents` (`task_id`, `status`, `depends_on`): task còn sống phụ thuộc task
này, trực tiếp hoặc qua task phụ thuộc khác; task kết thúc FAILED/CANCELLED hủy theo cả danh sách đó
(#249), và `note` của `cancel` ghi số lượng. Wait `adopt_approval` có `detail.head_sha` khi daemon đã đọc
head của PR (vòng preflight PENDING, cùng backoff; trigger hệ thống `adopt_head_observed`).
Prerequisite chưa chứng nhận vẫn hiện sau khi B bắt đầu. Merge đã xác nhận nhưng còn drain phải hiện
merge_cleanup_pending/process/effect chưa rõ, không hiện DONE.

### Output mặc định gọn

Lệnh đọc mặc định chỉ trả những gì cần để theo dõi task và quyết định bước tiếp; mọi thứ khác lấy bằng
`--full` (nguyên reply của daemon, như trước) hoặc lệnh chi tiết. Daemon và TUI không đổi: CLI rút gọn reply
trước khi in, cho cả `--json` lẫn output cho người đọc.

- Bản gọn bỏ field `null`, mảng rỗng, object rỗng: field vắng nghĩa là "không có". `details` là lệnh
  `--full` tương ứng. Chuỗi dài hơn 300 ký tự bị cắt, có ghi số ký tự bị bỏ.
- `task explain`: `task_id`, `version`, `status`, `step`, `wait` (`reason`, `detail`), `blockers`,
  `status_since`, `running` (`step`, `binding`, `started_at`, `last_output_at`, `silent_ms` của attempt
  đang chạy; field null bị bỏ), `queue_position`, `pr` (`ref`, `head_sha`), `merge` (`method`, `title`,
  chỉ khi có PR), `failed` (tên gate lỗi, CI check `failure`/`cancelled` của lần đọc CI hợp lệ mới nhất
  đúng revision và head hiện tại, `review: request_changes` của lần gần nhất; không log), `deadline_ms`
  khi deadline đang chạy (task đã kết thúc thì không có), `prerequisites` chưa DONE hoặc chưa xác minh, `dependents`,
  `terminal` (`kind`, `reason`) khi task đã kết thúc, `unverified` (`reason`) khi DONE trên một merge chưa
  được xác minh, `merge_cleanup`, `cancellation`, `paused` (`reason`, `by`, `at`, null khi
  không tạm dừng), `scope` (`overlaps`: task còn sống khác đổi chung file, `base_behind`, `base_conflicts`,
  `unknown`: phần chưa đọc được, `declared`, `unscoped`, `slot_block`; chỉ khi có), `allowed_actions`.
- `task show`: `task_id`, `project`, `title`, `status`, `step`, `version`, `wait`, `blockers`, `pr_ref`,
  `terminal` và `unverified` (như `task explain`, chỉ khi có), `run_config` (`status`, `digest`, `mode`).
  Đủ cho mutation; nội dung task ở `task content`.
- `task list`: mới nhất trước, mặc định 20, tối đa 100. Item chỉ có `task_id`, `project`, `title`, `status`,
  `activity` (wait code hoặc step; vắng khi task đã kết thúc), `pr_ref`, `terminal`, `unverified`, `overlaps`, `base_conflicts` và
  `scope_unknown: true` khi có;
  output cho người đọc in thêm dòng `Overlap:`/`Base conflict:`/`Scope unknown:` dưới bảng, ghi status `DONE (unverified)` khi có `unverified` và lý do kết thúc (cắt ở 60 ký tự) ở cột activity khi task đã kết thúc. Theo `next_cursor` tới khi `null` là thấy mọi task;
  `--order oldest` bắt đầu từ task đầu tiên. CLI gửi `order` trong query `task_list`; daemon vẫn mặc định
  `oldest` cho caller cũ.
- `task history`: mặc định 50 event, mỗi event `seq`, `type`, `revision`, `actor`, `at`; `--full` thêm
  `payload`, `dedup_key`. `--tail` trả trang event mới nhất (không dùng chung với `--after`), `more` là
  `false` và `next_cursor` là `seq` cuối để đọc tiếp event mới hơn. Query `task_history` của daemon có thêm
  `tail` và mỗi event có `at` (ISO 8601, thời điểm trigger gây ra event; `null` khi log không ghi). Daemon
  chỉ đọc event của trang trả về (`LIMIT`, cộng một event để biết `more`), không đọc hết log.
- `task logs`: snapshot mặc định 20 record. Bản gọn giữ nguyên `cursor`, ID, `at`, `kind`, `gap` của record;
  trong `data` bỏ phần sổ sách của harness (`uuid`, `session_id`, `hook_id`, `signature`, `request_id`,
  `parent_tool_use_id`, `timestamp`, `usage`, `rate_limit_info`, bản sao `tool_use_result`,
  `tool_result_meta`, `wire_tool_inputs`, `thinking_display`, `stop_details`, `stop_sequence`, `container`)
  cùng field rỗng, mảng giữ 10 phần tử đầu, chuỗi cắt ở 1000 ký tự; `--full` giữ nguyên.
- `task board --json`: task cần người có trong `items` của trang chỉ còn `task_id` và `wait_code` trong
  `attention.items`; task cần người nằm ngoài trang giữ nguyên hàng. `--full` trả nguyên reply. Output cho
  người đọc vẫn in mỗi task một lần như trước.
- `task_explain` của daemon có thêm `running` (attempt đang chạy: `attempt_id`, `step`, `kind`, `rung`,
  `binding`, `started_at` lúc runner khởi động operation mới nhất của attempt hoặc `null` khi chưa runner
  nào nhận, `last_output_at` thời điểm record log cuối của operation đó kể cả spool chưa ingest hoặc
  `null`, `silent_ms` = bây giờ trừ `last_output_at`, không có thì `started_at`, không có nữa thì
  `status_since`; tăng dần khi attempt treo, issue #264), `status_since` (lúc task vào status hiện tại,
  như `task board`), `terminal` (`kind`, `reason`; `null` khi task còn sống), `completion`
  (`merged_head_sha`, `checked_head_sha`, `merge_commit_sha`, `unverified`; `null` khi chưa merge),
  `deadline.state` là `ended` và `remaining_ms` là `null` khi task đã kết thúc, `blockers` gồm blocker
  không có `until` hoặc `until` còn ở tương lai, và `scope` (FR-027.06): `changed_files`, `base` (`ref`, `tip_sha`, `behind`, `conflicts`) và
  `overlaps` (`task_id`, `status`, `files`) và `unknown` (`changed_files`, `base`, `overlaps`: phần có mà
  chưa đọc được, rỗng khi task chưa có nhánh), `declared` (phạm vi task khai, `null` khi không khai),
  `unscoped` (`true` khi chưa có nhánh và không khai: phạm vi chưa rõ) và `slot_block` (`null` hoặc
  `{ code: "scope_overlap", tasks: [{ task_id, files }] }`: task chưa chạy đang xếp hàng bị scheduler bỏ
  qua vì chung file với task giữ slot, chỗ giữ hoặc chỗ mượn, FR-044.08); `null` cho task terminal. Item `task_list` của daemon có
  `overlaps` (ID task), `base_conflicts`, `scope_unknown`, `terminal` và `unverified`; `task_show` có
  `terminal`. Dữ liệu đọc từ repo cục bộ, không fetch: base
  tip là `refs/remotes/origin/<base>` đã fetch gần nhất; mọi lệnh git của một truy vấn chung hạn 4 giây.
- `status`, `inbox`, `report`, `task board`, `task progress` giữ nguyên: dữ liệu đã có giới hạn
  (`inbox` tối đa 100 câu hỏi, `report` và `board` có `truncated`/cursor) và nội dung câu hỏi cần đủ để
  trả lời. `task content` là lệnh chi tiết cho nội dung task.

## Transport và application service

- `node:http` qua filesystem UDS `DATA_DIR/control.sock`; directory 0700/socket 0600, không TCP hoặc
  abstract socket. Protocol `/v1/query` và `/v1/command` POST JSON closed schema; health GET `/v1/health`.
  Body tối đa 1 MiB, header timeout 5 giây, command admission 10 giây; effect chạy bất đồng bộ.
- Không có token. Quyền mở socket chỉ dựa vào file mode. Caller khai actor qua header `x-cusr-actor`, do
  CLI lấy từ `CUSR_ACTOR`: không có hoặc `owner` là owner (`read`/`operate`/`admin`), `assistant` là
  `read`/`operate`, giá trị khác bị từ chối 401. Không lấy role từ body request. Xem ADR 0011.
- `task gates` đọc kind `task_gates`: mỗi vòng gate và trạng thái log của từng gate (`available`, `expired`,
  `missing`). `task gate-log` đọc kind `task_gate_log` theo byte offset, không dùng cursor của log agent; mặc định
  lấy phần cuối có giới hạn: 4 KiB với gate đã đạt, 64 KiB với gate lỗi (CLI đọc 4 KiB trước, gate lỗi còn
  phần trước đó thì đọc lại 64 KiB của cùng vòng); `--limit` hay `--offset` tự chọn, `--full` đọc hết. Log
  retention đã xóa là trạng thái bình thường, không phải lỗi.
  Tên gate không có trả `gate_not_found` (exit 4) với `details.gates`: các gate đã chạy ở vòng được hỏi,
  hoặc ở mọi vòng khi không có `--round`.
- `task logs` đọc `POST /v1/query` kind `task_logs`; `--follow` là CLI hỏi lại theo cursor rồi in JSONL,
  không có route stream riêng. Cursor đếm record đã commit theo thứ tự event, không đổi qua rotation/restart;
  batch mất file hiện là `gap`, không bị bỏ im lặng.
- `read` không mutation, `operate` không cấp quyền admin (nhận PR có sẵn). CLI read cũng gọi daemon vì SQLite
  đang khóa EXCLUSIVE. Daemon disconnected trả exit 3; không fallback mở DB trực tiếp.
- Application kiểm authz/schema/allowlist/version/dedup trước I/O. Ghi command admission/dedup và ID
  đã gán trước preflight; crash giữa preflight và accept nhận lại cùng command. External I/O có
  deadline/cancel; engine/store accept facts trong transaction không I/O/await.
- Cùng PR/timer/recheck coalesce observation đang chạy, mỗi request được ánh xạ về một kết quả;
  không tạo nhiều poll chains. Mutation accepted trả request/task version; show/history cho tra lại.
- `task_gates` có thêm `running` (`gate`, `role`, `started_at`, `last_output_at`, hoặc `null`) đọc từ `running.state` của effect `run_gates` đang chạy, và `wall_ms` theo từng gate khi event có; event của bản cũ không có trường này.

### Actor của assistant

Assistant gọi với `CUSR_ACTOR=assistant` nên chỉ có `read`/`operate`. Assistant duyệt được escalation
(nấc đã có trong ladder đóng băng, #205) nhưng không duyệt nhận PR có sẵn hay dùng quyền admin; tests
trả exit 5 kể cả khi body request khai actor=owner/admin. Request đã
accepted giữ actor lúc được nhận.

Process cùng UID bỏ `CUSR_ACTOR` là thành owner, nên actor tự khai là rào chắn cho caller làm đúng quy ước,
không phải ranh giới quyền. Tách quyền thật cần chạy assistant bằng UID khác. Coder/fixer/reviewer worker
không gọi `cusr`; US6 assistant caller khác với worker agent đang sửa repo.

Bản trước dùng bearer token (`owner.token`, `runtime.access_tokens`) và phạm vi project theo token; cả hai
đã bỏ. `runtime.access_tokens` còn được chấp nhận để config cũ khởi động được, daemon ghi log rằng khóa này
bị bỏ qua.

## Cấu hình mở rộng tối thiểu

Giữ user/project YAML `version: 1`; thêm schema có validation, không để arbitrary record bypass.
Giữ các role/model/profile/gate của hợp đồng 001. Chuẩn hóa `projects.repo` hiện bị bỏ khỏi
NormalizedUser để runtime còn biết allowlisted remote.

| File / key mới | Kiểu và thẩm quyền |
| --- | --- |
| User `projects.<id>.path` | Absolute realpath local repo; kiểm git common dir; bắt buộc cho runtime |
| User `projects.<id>.repo` | `owner/repo` GitHub slug, immutable repo ID lấy ở preflight; khớp remote allowlist |
| User `runtime` | Object closed: data_dir, concurrency, slot_reservation_hours, limits, tool_paths, credential_refs và harness_isolation (`access_tokens` cũ được chấp nhận nhưng bỏ qua); chỉ owner sửa |
| User `runtime.concurrency` | Số task giữ execution slot cùng lúc (FR-044.01); số nguyên 1–64, mặc định 1; đọc khi cusrd khởi động, đổi thì restart; không thuộc snapshot của task. `GET /v1/health` trả `slots` (mọi slot đang giữ, theo thứ tự cấp, kèm `reserved_at` và `borrower_task_id`), `loans` (chỗ đang cho mượn) và `concurrency` |
| User `runtime.slot_reservation_hours` | Số giờ task chờ CI/merge/người/cooldown giữ chỗ slot (FR-044.02); số nguyên 1–720, mặc định 24; tính từ lúc bắt đầu giữ, đọc khi cusrd khởi động; hết hạn thì slot thành slot trống. `cusr task explain` trả `slot.hold` (`running`, `reserved` hoặc `borrowed`) |
| User `runtime.harness_isolation.<harness>` | internal_required mặc định hoặc allow_external_verified; mode sau chỉ được chọn khi S0.1 proof còn hợp lệ, không nhận từ cusr.yaml/task/agent |
| User `projects.<id>.dispatch`, `runtime.dispatch` | Bản của project thay toàn bộ bản `runtime`, không merge rule. Gồm `profile`, `rules[]` (tùy chọn) và `default` bắt buộc. Mỗi rule có `when`, `why`, `use`, `reviewer?`; `default` có `use`, `reviewer?`, `why?`. `use` là một hoặc một mảng có thứ tự `{harness, model, effort}`, cả ba khóa bắt buộc; `reviewer` cùng dạng. Có `reviewer` là `full-review`, không có là `direct-pr`. Lúc nạp: profile tồn tại và cho phép, mode được phép theo `runtime.modes`, `use` khớp binding của `coder` và `fixer`, `reviewer` khớp binding của `reviewer`. Daemon không đọc `when`, không xếp `use`; không thuộc hash chính sách của task |
| User `runtime.limits` | Các trần có default ở research R-04/R-11; số nguyên dương, hữu hạn; task mới chụp snapshot/hash |
| User `runtime.tool_paths` | git/gh/systemd-run/bwrap/flock absolute executable; hash/version được doctor ghi |
| User `runtime.credential_refs` | File reference cho GitHub/harness, không copy secret vào snapshot |
| User `roles.<role>.prompt` | Đường dẫn tương đối tính từ thư mục user config; không nhận đường dẫn tuyệt đối hoặc `..`; thiếu hoặc quá 1 MiB thì freeze báo config_invalid |
| `<DATA_DIR>/harnesses/<harness>/pin.json`, `manifest.json` | Bản ghi owner, không chứa secret, không mount vào sandbox; phải là file thường của owner, không cho group/other ghi. Thiếu hoặc không còn khớp host thì harness capability_missing. Đọc lúc daemon khởi động, đổi bản ghi cần restart |
| Project `ci.required_checks[]` | Giữ string[] schema v1/hash; hợp tên GitHub ở mỗi lượt đọc, app_id ở evidence và được kiểm trước merge; giữ replay mismatch lịch sử |
| Project `merge.method` | `squash` mặc định, enum `squash`/`merge`/`rebase`; object `merge` closed chỉ có method; resolve từ frozen base và đóng băng theo task, không cấp quyền merge/yolo |

`merge` vắng hoặc object rỗng thì resolve method=`squash`; sai kiểu/enum hoặc key không biết trong
object phải báo config_invalid, không đổi ngầm về default. Giá trị `merge` chọn merge commit;
`rebase` chọn cách merge PR, không cho phép tự rebase worktree đang chạy. Start ghi method đã
resolve vào `FrozenRuntimeContext.merge_method` (trường tuỳ chọn); snapshot cũ không có trường
này giữ nguyên hash và hiển thị method `null`, không gán ngược default mới.
`task_show` trả `merge: { method, proposed: { title, message, digest } | null, observed_method }`
khi task đã start; `observed_method` là `unknown` sau merge vì 002 không đọc bằng chứng method.
Feature 002 chỉ dùng method để hiển thị lựa chọn và message đề xuất khi chờ merge thủ công;
không cần capability gửi merge hoặc method đã bật ở repo để tạo/chạy task, không thêm command merge.
V1 khi có effect merge mới kiểm method đã bật và chặn gửi nếu không đáp ứng, không tự fallback.

Network mode đóng băng là internet_outbound theo quyết định chủ dự án; share host network,
không egress allowlist hoặc cam kết chặn LAN/loopback. Runtime tự động v1 cố định Isolated/provider
bwrap theo [ADR-0004](../../../docs/adr/0004-isolated-bwrap-baseline.md); không thêm key chọn backend
Native-only/Container/VM. `harness_isolation` chỉ chọn lớp nội bộ, outer luôn bắt buộc. Host hạn chế
userns cần admin provisioning phù hợp; AppArmor 4/child stack không bắt buộc, doctor không tự cài
hoặc sửa policy. Completion mode của daemon 002 cố định external_confirmation, không cho cusr.yaml bật merge/yolo.
Workflow giữ các boundary software_dev/human và bổ sung hai chế độ đã xác nhận; role thực chạy chỉ
coder/fixer/reviewer. `direct-pr` không cần reviewer binding/capability/quota; `full-review` cần
reviewer riêng session, có thể cùng vendor. CI snapshot nghiệm thu không rỗng. Graph hiện có
`software_dev@1` còn skip theo XS và chưa có checkpoint trước review; cần sửa/version hóa trước
khi sử dụng. Unsupported role/workflow/permission/cost
cap được báo capability_missing trước RUNNING, không tự đổi binding.

`runtime.limits` cụ thể: observation_max_ms, observation_max_rounds, poll_initial_ms, poll_factor,
poll_max_ms, observation_round_ms, http_max_attempts, http_request_cap, http_page_cap,
http_response_bytes, ci_max_polls_per_head, drain_max_ms, drain_max_rounds, recheck_max_ms,
term_grace_ms, kill_verify_ms, command_wall_ms, context_bytes, review_diff_bytes, result_bytes,
log_record_bytes, log_segment_bytes, spool_bytes, terminal_retention_ms. Cross-field checks bảo đảm
initial ≤ max, segment ≤ spool, TERM+KILL ≤ drain/recheck. Trần CI thời gian kế thừa frozen step.

Doctor chạy probe không tốn model: version/schema availability, Git paths/permissions, cgroup/systemd,
sandbox mount/proc/socket/secret access, storage writability, credential availability (không in secret).
Lát 0 trước A kiểm host rootless bwrap/systemd và outer boundary, sandbox nội bộ bật trước,
nhánh external_verified chỉ sau outer-proof/permission fixtures và owner config theo ADR-0004,
auth home và ba role × hai vendor. Không kiểm pass bằng tên profile AppArmor. Doctor
trên WSL2 kiểm systemd=true cùng user-manager unit probe, không chỉ PID1. Schema output thật/cost/auth
capability chỉ được đánh dấu proven khi có fixture thực nghiệm; chưa
có thì chặn binding cần khả năng đó. Mỗi lần attempt kiểm lại binary hash và manifest còn phù hợp.

## Tạm dừng task

Issue #142. `task pause` khác `task cancel`: task không kết thúc và không mất gì.

Task có PR chỉ CANCELLED sau một lần đọc PR mang token của cancel (FR-025.03). `task cancel` đọc ngay khi cancel còn cần
lần đọc đó, kể cả khi cùng request ID được gửi lại sau crash; lượt đọc khác đang chạy cho task (vòng quan sát, recheck)
không thay được lượt này, cancel chờ nó xong rồi đọc bằng token của mình. Lần đọc lỗi tạm, hoặc PR chỉ được tìm thấy sau
lệnh cancel, thì daemon tự đọc lại trong vòng quan sát với backoff (5 giây, nhân đôi, tối đa 5 phút), không cần `recheck`
(#267). Lượt đọc không sinh được observation (vd chưa biết subject của PR) vẫn được ghi bằng fact
`cancel_read_failed` (event `CancelReadFailed`), nên vẫn được đếm. Wait `cancel_reconcile` có `detail.cancel_reads` là số lần đọc đã ghi; `needs_user` chỉ bật khi đã đọc từ 5 lần
mà vẫn chưa kết thúc được cancel.

`task cancel --force` (#179) là lối thoát cho cancel kẹt ở `cancel_reconcile` vì lần đọc PR không cho `open`
hoặc `closed`. Lệnh vẫn ghi cancel (hoặc giữ cancel đã có) và đọc PR một lần như thường; lần đọc kết thúc được
cancel thì `--force` không làm gì (`force_ignored: "nothing_to_force"`). Còn chờ thì ghi `CancelForced`, task kết
thúc CANCELLED và kết quả có `warning` rằng PR có thể chưa được đọc. Đã thấy merge hoặc bằng chứng merge chưa
đủ thì `--force` bị bỏ qua (`force_ignored: "merge_seen"`), task chờ đối chiếu merge như cũ. Quyền: `operate`.

- Việc đã giao trước khi tạm dừng chạy nốt: lượt agent, gate, publish hay hành động GitHub đang chờ
  hoặc đang chạy. Không bước, retry hay lượt chờ nào được bắt đầu sau đó: task chờ
  `policy/paused` với đúng hành động nó định chạy, và slot được trả lại khi không còn việc giữ slot.
- Task đang chờ thứ khác (CI, câu trả lời, GitHub) vẫn được quan sát; kết quả của lượt chờ đó đi tới
  `paused` thay vì chạy tiếp. Task chưa bắt đầu rời hàng đợi slot và scheduler không xếp lại.
- `task resume` chạy đúng hành động đã giữ: cùng revision, rung, worktree, PR, bằng chứng và lượt ghé
  (bước đã vào không bị đếm lại). Task đã bắt đầu thì xếp lại hàng đợi slot nhóm `resumed`.
- Không tạm dừng được task đã kết thúc, đang hủy hoặc đã có bằng chứng merge; tạm dừng lần hai và
  resume task không tạm dừng bị bỏ qua, trả `ok` với `ignored`. Task tạm dừng vẫn hủy được.
- `--now` dừng thêm các lượt agent đang chạy bằng cơ chế `stop_attempt`; lượt chưa khởi chạy thì bị
  rút. Bước đó chạy lại trong session mới khi resume, kể cả khi resume trước lúc lượt bị dừng kết thúc
  (không hỏi `attempt_stopped`); lượt đã chạy vẫn tính vào budget. Gate và hành
  động GitHub đang chạy vẫn chạy nốt.
- `cusr queue pause` dừng nhận việc mới cho cả daemon: task chưa bắt đầu không được xếp hàng hay cấp
  slot, kể cả request đã xếp trước đó và có priority cao hơn; task đã bắt đầu vẫn chạy và vẫn được cấp
  lại slot. Task đã được cấp slot mà chưa start (crash giữa hai bước) trả slot và được xếp lại sau
  resume. `cusr queue resume` bỏ tạm dừng. Trạng thái nằm ở file `queue-paused.json` trong data dir
  (owner-only, giữ qua restart, không cần migration DB); file hỏng được coi là đang tạm dừng. File ghi
  kèm request ID đã áp dụng, nên lệnh chạy lại sau crash không đổi gì và không lật quyết định mới hơn. Reply
  có `changed`: `false` khi hàng đợi đã ở trạng thái đó (pause lần hai giữ lý do cũ) hoặc request ID đã áp
  dụng. `cusr status` có `queue_paused` (`reason`, `by`, `at`) và không coi đây là lỗi health.

## Tin nhắn cho agent

Issue #154. `task message` đưa chỉ dẫn cho agent đang làm task mà không hủy task hay chờ tới lượt hỏi
đáp. Mô hình theo cách paseo giao prompt cho agent đang bận: `interrupt` hủy lượt đang chạy rồi mở
lượt mới với tin nhắn; `steer` chèn tin nhắn vào lượt đang chạy và lùi về `interrupt` khi provider
không nhận input giữa chừng; mặc định assistant là `steer`, người dùng là `interrupt`.

- Worker chạy dưới runner riêng với stdin là file cố định và `codex exec` không nhận input sau khi chạy,
  nên `steer` luôn lùi về `interrupt` và event ghi `fallback: steer_unsupported`.
- `steer`/`interrupt` dừng các lượt coder/fixer đang chạy của revision hiện tại bằng `stop_attempt` (lượt
  chưa khởi chạy thì bị rút). Khi lượt bị dừng kết thúc, cùng bước chạy lượt `retry` nối tiếp session
  của lượt đó nếu harness đã chứng minh resume; không thì session mới. Không hỏi `attempt_stopped`.
  Lượt bị dừng vẫn tính vào budget. Conflict fixer duy nhất của một lần cập nhật base bị ngắt thì đi qua
  `retry_fixer`: lượt nối tiếp nhận vai conflict fixer đó, không chuyển sang chờ sửa tay.
- Không ngắt reviewer (reviewer luôn dựng packet riêng và chạy nốt); không ngắt gì khi task đang tạm dừng,
  lượt bị dừng kết thúc lúc tạm dừng thì chờ `resume`; `queue` không ngắt. Các trường hợp đó ghi
  `delivery: next_turn`.
- Tin nhắn gửi khi lượt bị dừng chưa kết thúc không dừng thêm lần nữa; lượt kế tiếp mang tất cả.
- Mọi lượt agent sau đó của cùng revision (coder, fixer, reviewer) có mục `messages` trong context, theo thứ
  tự gửi, kèm người gửi và thời điểm; mục này bắt buộc, không bị cắt. Request `start_agent` ghi ID các tin
  nhắn nó mang và context chỉ dựng từ các ID đó, nên tin nhắn tới sau khi khởi chạy không đổi input mà
  recovery dựng lại để nhận kết quả lượt cũ; lượt kế tiếp mới mang nó. Tin nhắn chỉ là chỉ dẫn: context nói rõ không thêm hay đổi tiêu chí nghiệm thu, yêu cầu,
  ràng buộc hay phạm vi loại trừ, phần vượt ra ngoài thì không làm và nêu trong summary.
- Tin nhắn là event `TaskMessageSent` (người gửi, revision, behavior, delivery, lượt bị dừng) nên giữ qua
  restart và replay. Daemon chết giữa lúc dừng và lúc nối tiếp thì kết quả lượt bị dừng, hoặc reconcile
  `not_executed`, vẫn dẫn tới lượt `retry` mang tin nhắn. Lượt bị dừng báo `cancelled` giữ `session_ref`;
  reconcile đọc lại một lượt thất bại thì chuyển nguyên failure data đã validate (session, cây worktree,
  usage) cho engine như kết quả trực tiếp.
- Reply có `message` (`id`, `by`, `at`, `revision`, `behavior`, `delivery`); request chạy lại trả đúng tin
  nhắn lần đầu. Không gửi được cho task đã kết thúc hoặc đang hủy. `task explain --full` có `messages` của
  revision hiện tại.

## Confirm/recheck PENDING và health

Confirm/recheck không mở slot hay worktree trước triage. Khi cấu hình/năng lực sai, giữ needs_info
và detail config_invalid/capability_missing; chỉ lệnh mới mới thử lại, không poll base. Khi hợp lệ,
task chờ slot READY; lúc cấp slot đọc/chốt base mới nhất lại trước RUNNING. Không chụp hai FrozenPolicy
cùng task/revision chỉ vì confirm rồi start: kết quả kiểm tra sớm là candidate, snapshot duy nhất
chốt nguyên tử lúc bắt đầu theo FR-002.01.

Health gồm writer/schema/integrity/replay, claims chưa rõ, runner/capabilities và lần observation
cuối/hạn còn lại. Clock/next timer do code; không LLM, không coi health xanh thay gate/test/build.

`GET /v1/health` (`cusr status`) có `build` (`version`, `commit`, `built_at` của bản daemon đang chạy;
`commit` là `null` khi chạy từ source) và `startup` (`at`, `projections`, `timers`): số đếm lúc daemon
khởi động, không phải hiện tại; `cusr doctor` đếm lại. `writer: "ok"` nghĩa là daemon trả lời đang giữ
writer lock; ghi được hay không xem `store`. `cusr --version --json` trả `version`, `commit`, `built_at`
của CLI; `pnpm build` ghi commit vào `dist/build-info.json` (lấy `CUSR_BUILD_COMMIT`, không có thì
`git rev-parse HEAD`). `commit` của CLI khác của daemon là hai bản build khác nhau (issue #260).
