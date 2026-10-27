# CLI, daemon và cấu hình runtime

Hợp đồng dự kiến cho feature 002, mở rộng [CLI v1](../../../SPEC.md#15-cli-kênh-nguồn-và-quyền-truy-cập).
Chưa có binary triển khai. Đầu vào task vẫn theo CanonicalTaskSchema; CLI chuẩn hóa trường tùy chọn,
server gắn task ID/requester đáng tin, không nhận `AuthzContext` do caller tự khai.

## Lệnh và quyền

| Lệnh dự kiến | Quyền / hành vi |
| --- | --- |
| `cusrd --config FILE --data-dir DIR` | Owner khởi động daemon foreground; có unit systemd mẫu; một writer |
| `cusr doctor --project NAME`, `cusr status` | read; doctor kiểm capability và health, lỗi health exit 1 |
| `cusr task add --file FILE` | operate; JSON task input, trả task có thể PENDING/READY, không chờ tới PR |
| `cusr task show/list/explain/history` | read; list có `--limit` tối đa 100 và cursor; show/explain nhận ID |
| `cusr task logs ID --after CURSOR [--follow]` | read; snapshot hữu hạn hoặc stream JSONL có seq/cursor; một follow session tối đa 1 giờ, có thể nối lại |
| `cusr task confirm/cancel/recheck ID` | operate; version/dedup; recheck chọn cấu hình/PR/drain theo task, không gọi agent |
| `cusr inbox`, `cusr answer QUESTION --file FILE` | read/operate; câu trả lời đầu thắng, ràng buộc revision/version |
| `cusr task approve ID --kind escalation --step STEP --rung N` | admin; task/revision/policy hash đúng, không cấp merge |
| `cusr task retry/amend-policy`, merge approval, yolo | unsupported_feature, exit 2; không tạo mutation nghiệp vụ |

Mọi mutation nhận `--request-id UUID`, `--expected-version N` khi sửa task hiện có; task add không
cần expected-version. Nếu CLI tự sinh request ID phải in lại trong kết quả để người dùng đối chiếu
sau timeout. Cùng ID+canonical payload trả cùng kết quả; payload khác conflict. New request ID mới
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
| User `runtime` | Object closed: data_dir, limits, tool_paths, credential_refs và access_tokens; chỉ owner sửa |
| User `runtime.limits` | Các trần có default ở research R-04/R-11; số nguyên dương, hữu hạn; task mới chụp snapshot/hash |
| User `runtime.tool_paths` | git/gh/systemd-run/bwrap/flock absolute executable; hash/version được doctor ghi |
| User `runtime.credential_refs` | File reference cho GitHub/harness, không copy secret vào snapshot |
| Project `ci.required_checks[]` | Giữ string[] schema v1; không thêm key app_id; GitHub ghim app cụ thể trả required_checks_mismatch |

Network mode đóng băng là internet_outbound theo quyết định chủ dự án; share host network,
không egress allowlist hoặc cam kết chặn LAN/loopback. Profile host trong deploy phải provisioning
trước capability pass, doctor không tự cài. Completion mode của daemon 002 cố định external_confirmation, không cho cusr.yaml bật merge/yolo.
Workflow phải giữ topology software_dev@1/human; role thực chạy chỉ coder/fixer/reviewer, profile
nghiệm thu không skip review và CI snapshot không rỗng. Unsupported role/workflow/permission/cost
cap được báo capability_missing trước RUNNING, không tự đổi binding.

`runtime.limits` cụ thể: observation_max_ms, observation_max_rounds, poll_initial_ms, poll_factor,
poll_max_ms, observation_round_ms, http_max_attempts, http_request_cap, http_page_cap,
http_response_bytes, ci_max_polls_per_head, drain_max_ms, drain_max_rounds, recheck_max_ms,
term_grace_ms, kill_verify_ms, command_wall_ms, context_bytes, review_diff_bytes, result_bytes,
log_record_bytes, log_segment_bytes, spool_bytes, terminal_retention_ms. Cross-field checks bảo đảm
initial ≤ max, segment ≤ spool, TERM+KILL ≤ drain/recheck. Trần CI thời gian kế thừa frozen step.

Doctor chạy probe không tốn model: version/schema availability, Git paths/permissions, cgroup/systemd,
sandbox mount/proc/socket/secret access, storage writability, credential availability (không in secret).
Lát 0 trước tasks/A kiểm host AppArmor, nested sandbox, auth home và ba role × hai vendor. Doctor
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
