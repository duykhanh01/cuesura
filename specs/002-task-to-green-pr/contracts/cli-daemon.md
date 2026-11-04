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
để vượt bước này, token operate không được nâng quyền. Task do assistant tạo mặc định chờ xác nhận intake; auto-confirm intake và hạn mức tạo task theo
client chỉ do người dùng cấu hình. Auto-confirm intake không miễn xác nhận chạy.
Giao diện có thể gộp cùng một lượt xác nhận khi hiển thị task và toàn bộ cấu hình chạy; bằng chứng
phải ghi rõ cả hai phạm vi, không biến auto-confirm intake thành duyệt binding.
Các key/command/proof cụ thể cần triển khai, chưa phải CLI/schema hiện có.

Confirm/recheck không tự chọn lại binding. Cấu hình hiệu lực khác bộ đã xác nhận thì chờ xác nhận
mới trước spawn; retry/resume trong bộ đã duyệt không hỏi lại. Task đã bắt đầu không đổi mode/graph
qua amend-policy của feature 002; tạo task mới nếu cần đổi. Không ràng buộc vendor và không hạ
`full-review` xuống `direct-pr` khi hết quota.

## Lệnh và quyền

| Lệnh | Quyền / hành vi |
| --- | --- |
| `cusrd --config FILE --data-dir DIR` | Owner khởi động daemon foreground; có unit systemd mẫu; một writer |
| `cusr doctor --project NAME`, `cusr status` | read; doctor kiểm capability và health, lỗi health exit 1 |
| `cusr task add --file FILE` | operate; JSON task input, trả task có thể PENDING/READY, không chờ tới PR |
| `cusr task propose ID --profile P --mode M --worker H/M/E` | operate; đề xuất bộ lựa chọn chạy, xác nhận riêng |
| `cusr task show/list/explain/history` | read; list có `--limit` tối đa 100 và cursor; show/explain nhận ID |
| `cusr task logs ID --after CURSOR [--follow]` | read; snapshot hữu hạn hoặc stream JSONL có seq/cursor; một follow session tối đa 1 giờ, có thể nối lại |
| `cusr task confirm/cancel/recheck ID` | operate; version/dedup; recheck chọn cấu hình/PR/drain/worktree theo task, không gọi agent; với `worktree_changed` thì nhận tree đã quan sát làm mốc của task rồi chạy lại bước; với `manifest_changed` thì nhận manifest harness đang hiệu lực rồi chạy lại bước |
| `cusr dispatch --project ID` | read trong phạm vi project; trả `project`, `source` (`project`, `global` hoặc `none`), `modes`, `rules`, `default`. Lấy từ `projects.<id>.dispatch`, không có thì `runtime.dispatch`; đọc config mỗi lần gọi; `use[]` trả về dạng `{worker, reviewer?}` kèm `profile`, `mode` để chép thẳng vào `task propose`; không chứa secret, không chọn thay người dùng |
| `cusr inbox`, `cusr answer QUESTION --file FILE --expected-version N` | read/operate; câu trả lời đầu thắng, ràng buộc revision/version |
| `cusr task approve ID --kind escalation --step STEP --rung N` | admin; task/revision/policy hash đúng, không cấp merge |
| `cusr task retry/amend-policy`, merge approval, yolo | unsupported_feature, exit 2; không tạo mutation nghiệp vụ |

Mọi mutation nhận `--request-id UUID`, `--expected-version N` khi sửa task hiện có; task add không
cần expected-version. Nếu CLI tự sinh request ID phải in lại trong kết quả để người dùng đối chiếu
sau timeout. `--project` tùy chọn với lệnh theo ID: CLI đọc project của task qua `task_show`. Cùng ID+canonical payload trả cùng kết quả; payload khác conflict. New request ID mới
thử lại cấu hình đã sửa; replay request cũ không âm thầm đọc base mới rồi đổi kết quả.

`--json` cho mọi lệnh; output finite đúng một object `{schema_version:1,ok,data,error}`. Error gồm
code/message/details/request_id. Log/chẩn đoán vào stderr, không ANSI/prompt. Exit 0 processed, 1
execution/health failure, 2 syntax/config/unsupported, 3 connection/timeout, 4 missing, 5 forbidden,
6 conflict. Status task không quyết định exit code của lệnh query.

Priority số lớn chạy trước; default 0. Explain gồm deadline chưa bắt đầu/đã hết, thời gian chờ slot
ban đầu/xin lại, PR/head/base, các blocker còn hiệu lực, bằng chứng và allowed_actions từ FR-029.
Prerequisite chưa chứng nhận vẫn hiện sau khi B bắt đầu. Merge đã xác nhận nhưng còn drain phải hiện
merge_cleanup_pending/process/effect chưa rõ, không hiện DONE.

## Transport và application service

- `node:http` qua filesystem UDS `DATA_DIR/control.sock`; directory 0700/socket 0600, không TCP hoặc
  abstract socket. Protocol `/v1/query` và `/v1/command` POST JSON closed schema; health GET `/v1/health`.
  Body tối đa 1 MiB, header timeout 5 giây, command admission 10 giây; effect chạy bất đồng bộ.
- Bearer capability token trong file riêng ngoài sandbox, map server-side sang actor/read/operate/
  admin và project allowlist. Token chỉ nhận qua file cấu hình/`CUSR_TOKEN_FILE`, không argv/log.
  Bootstrap token owner sinh lúc daemon init data dir, quyền 0600. Token map do owner quản lý;
  không lấy role từ sender name/UID tự khai/marker/header actor.
- `task logs` đọc `POST /v1/query` kind `task_logs`; `--follow` là CLI hỏi lại theo cursor rồi in JSONL,
  không có route stream riêng. Cursor đếm record đã commit theo thứ tự event, không đổi qua rotation/restart;
  batch mất file hiện là `gap`, không bị bỏ im lặng.
- `read` không mutation, `operate` không cấp escalation/admin. CLI read cũng gọi daemon vì SQLite
  đang khóa EXCLUSIVE. Daemon disconnected trả exit 3; không fallback mở DB trực tiếp.
- Application kiểm authz/schema/allowlist/version/dedup trước I/O. Ghi command admission/dedup và ID
  đã gán trước preflight; crash giữa preflight và accept nhận lại cùng command. External I/O có
  deadline/cancel; engine/store accept facts trong transaction không I/O/await.
- Cùng PR/timer/recheck coalesce observation đang chạy, mỗi request được ánh xạ về một kết quả;
  không tạo nhiều poll chains. Mutation accepted trả request/task version; show/history cho tra lại.

### Token riêng cho assistant

Owner provisioning **token thứ hai**, độc lập token bootstrap admin: 32 byte ngẫu nhiên, file 0600
ngoài worktree, ID/actor riêng, roles đúng `[read, operate]` và danh sách project tường minh. Cấu
hình trusted user `runtime.access_tokens[]` gồm `{id, actor, roles, projects, token_file}`; không
được đặt ở cusr.yaml hoặc gửi qua command payload. Owner sinh file bằng công cụ random hệ thống,
không in secret vào chat/log; cấp assistant chỉ token operate qua kênh tin cậy. Ví dụ metadata:

```yaml
runtime:
  access_tokens:
    - id: assistant-work
      actor: assistant
      roles: [read, operate]
      projects: [node-sandbox]
      token_file: /srv/cusr-access/assistant-work.token
```

Owner thêm/xóa entry rồi restart daemon để grant/revoke có hiệu lực; startup audit token ID/actor/
scope và config hash, không ghi secret. Mutation mới luôn kiểm token map đang chạy; revocation
không giả vờ thu hồi effect đã gửi. Assistant token không được approve escalation, quản trị token
hoặc tự nâng scope; tests trả exit 5 kể cả caller tự khai actor=owner/admin. Request đã accepted
vẫn có lịch sử gắn actor cũ; rotate không thay kết quả hoặc cấp scope theo payload caller.

Nếu assistant có toàn quyền shell cùng UID và đọc được token owner thì token map không tạo được
ranh giới quyền. Cấu hình được hỗ trợ cấp assistant qua client/connector hoặc sandbox chỉ có token
operate và không thấy token admin/home owner. Coder/fixer/reviewer worker **không** được mount ngay
cả token operate; US6 assistant caller khác với worker agent đang sửa repo.

## Cấu hình mở rộng tối thiểu

Giữ user/project YAML `version: 1`; thêm schema có validation, không để arbitrary record bypass.
Giữ các role/model/profile/gate của hợp đồng 001. Chuẩn hóa `projects.repo` hiện bị bỏ khỏi
NormalizedUser để runtime còn biết allowlisted remote.

| File / key mới | Kiểu và thẩm quyền |
| --- | --- |
| User `projects.<id>.path` | Absolute realpath local repo; kiểm git common dir; bắt buộc cho runtime |
| User `projects.<id>.repo` | `owner/repo` GitHub slug, immutable repo ID lấy ở preflight; khớp remote allowlist |
| User `runtime` | Object closed: data_dir, limits, tool_paths, credential_refs, access_tokens và harness_isolation; chỉ owner sửa |
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

## Confirm/recheck PENDING và health

Confirm/recheck không mở slot hay worktree trước triage. Khi cấu hình/năng lực sai, giữ needs_info
và detail config_invalid/capability_missing; chỉ lệnh mới mới thử lại, không poll base. Khi hợp lệ,
task chờ slot READY; lúc cấp slot đọc/chốt base mới nhất lại trước RUNNING. Không chụp hai FrozenPolicy
cùng task/revision chỉ vì confirm rồi start: kết quả kiểm tra sớm là candidate, snapshot duy nhất
chốt nguyên tử lúc bắt đầu theo FR-002.01.

Health gồm writer/schema/integrity/replay, claims chưa rõ, runner/capabilities và lần observation
cuối/hạn còn lại. Clock/next timer do code; không LLM, không coi health xanh thay gate/test/build.
