# Hợp đồng thực thi: runner, harness, worktree và gates

Nguồn: [SPEC §§12–14](../../../SPEC.md), [research R-05–R-08/R-11](../research.md).
Giá trị giới hạn ở research được chụp vào snapshot runtime; không nâng ngầm khi restart.
Host prerequisite AppArmor, outer boundary và mode harness được chọn phải đạt [lát 0](../spike-0.md) trước A theo
[runbook](../../../deploy/README.md). Luôn thử native bật trước; external_verified chỉ hợp lệ theo
ngoại lệ có điều kiện ở ADR-0003, không bỏ permission/approval hoặc capability denial.

## Operation và runner ownership

1. Daemon commit effect/slot/reservation/operation ID, rồi claim qua store. Chỉ sau commit mới gọi
   node:child_process.spawn gọi systemd-run --user tạo transient user service `cusr-op-<operation-id>.service`, không gắn PartOf/Requires
   vào daemon, `Restart=no`. Cùng operation luôn cùng unit; không dùng `--collect` trước khi ingest.
2. Runner khởi chạy dưới util-linux `flock` giữ khóa kernel độc quyền của operation; marker là dữ liệu, không thay khóa kernel.
   Marker/manifest/fsync ghi trước harness spawn. Runner gặp marker cũ phải nhận lại kết quả/process
   hoặc báo unknown/lost; không spawn lại operation đó, kể cả marker tồn tại nhưng không thấy PID.
3. Unit riêng sống khi daemon foreground chết hoặc daemon service stop/restart. Runner ghi identity
   gồm boot_id, unit InvocationID/cgroup, pid/pgid và `/proc` start ticks, launch nonce. Marker env
   `CUSR_ATTEMPT_ID` chỉ hỗ trợ tìm kiếm, không xác thực process.
4. Mỗi operation có wall deadline monotonic và hạn UTC bền; SIGTERM → 10 giây → SIGKILL → xác minh
   tối đa 5 giây. Dừng cả cgroup thuộc operation, không process chung của hệ thống. Output/CPU cây
   process/file change là progress; stdout im lặng không tự là stall.
5. Daemon khôi phục nhận lại unit/receipt trước cấp việc. Nếu process identity sai/remote unknown,
   giữ claim, không spawn thay hoặc trả reservation. Xác nhận không từng spawn mới trả lượt giữ
   chỗ; đã chạy kể cả rate-limit/resume/repair vẫn tính đã dùng.

Git command ngắn và HTTP cũng có effect deadline/receipt, nhưng không cần một harness process.
Prepare/setup/gate/autofix/publish chạy process dài dùng cùng operation supervisor; drain không chỉ
dừng start_agent. Runner không biết task.status, không ghi DB và không quyết định retry/escalation.

## Files và output

```text
DATA_DIR/runs/ATTEMPT_ID/             # default ~/.cusr/runs/<attempt_id>/, đúng SPEC §12.1
├── invocation.json, pid.json        # identity, argv/binding/schema hashes đã redact
├── events.jsonl, stderr.log         # JSONL/output bounded; chỉ ingest record hoàn chỉnh
├── liveness, progress.json          # do runner ghi
├── exit.json                       # outcome/signal/usage/artifact digest, runner ghi nguyên tử
├── out/result.json                 # validated/finalized phía orchestrator
├── launch.json                     # marker bổ sung trước spawn, agent không mount
└── context/, schema/, scratch/, private-home/, spool/ # supplementary files
```

Operation không có attempt (setup/gate/publish) dùng DATA_DIR/operations/OPERATION_ID với cùng file
protocol, không thay layout của attempt. Receipt là projection chuẩn hóa từ exit.json và file
identity, không đổi tên file chuẩn thành manifest.json/receipt.json. Invocation chứa operation/
effect/task/attempt ID, revision, binding/context/schema hash, cwd/argv/env đã redact, deadline và
artifact paths. Không tin ID/path do agent tự khai; cấm traversal/symlink thoát artifact root.

Log record có schema_version, operation_id, generation, seq, at, kind, data, tối đa 256 KiB;
redact trước lưu spool/stderr/diagnostic. Result tối đa 1 MiB; exit/result temp→fsync→rename→fsync
directory. Rotation đổi events.jsonl sang segment có generation trong spool, giữ identity/cursor
đọc tiếp được; chỉ xóa segment sau ACK đã commit. Ingest events + cursor cùng transaction, rồi ACK;
request lặp không lặp event. Cap spool 64 MiB thì dừng operation với artifact_backpressure, không
âm thầm bỏ output chưa ingest. Disk full giữ health lỗi/claim; partial final sau process chết là
invalid output. Retention 30 ngày chỉ cho artifact terminal đã ACK, giữ tombstone; không xóa
worktree có diff/commit chưa bảo toàn theo retention log.

## Harness contract

| Input từ runner | Output adapter chuẩn hóa |
| --- | --- |
| role, frozen model/effort/permissions, context/schema bytes, deadlines, session nullable | final role result, usage reported/estimated/unavailable, refusal/auth/rate-limit/failure facts, session ref, tool/progress records |

- Coder/fixer result đúng schema SPEC §12.3: version, status done/needs_input/needs_context/blocked,
  summary, questions[], blocker nullable. Reviewer: verdict approve/request_changes, summary,
  findings có severity/file/line/message; closed object, trường required, không tin task ID từ model.
- Structured final response là nguồn chính. Result code/schema/provenance/semantic validation đều
  cần đạt; fallback file chỉ có khi capability manifest khai báo và path mới riêng operation.
- Codex build argv `exec --json --output-schema ... --output-last-message ... --sandbox ...`, cwd
  worktree; Claude print/structured-schema/settings tương ứng manifest. Không hardcode model ID từ
  ví dụ docs, không bypass permission. Internal OS sandbox có thể off duy nhất trong mode
  external_verified đã kiểm; outer vẫn bắt buộc. Auth/session home riêng, không load tùy ý config user.
- Resume chỉ cùng harness/session, đúng policy; nếu không còn dùng được thì attempt mới mang Q&A
  có ngân sách. Adapter không quyết định tạo attempt. Refusal không bị retry để vượt quyền.
- Context tối đa 128 KiB, reviewer diff 64 KiB; kèm diff digest/path list, phần cắt phải ghi rõ.
  Không đủ acceptance/diff bắt buộc thì needs_context/chờ, không cắt thông tin rồi approve. Reviewer
  khác vendor với coder/fixer thực tạo diff; vendor được xác định từ manifest, không chỉ tên model.

## Mode isolation và capability manifest

`internal_required` là mặc định. Trusted owner config có thể cho phép `allow_external_verified`
cho từng harness; preflight chỉ chọn mode thực tế `external_verified` nếu native đã thử và outer
proof/permission fixtures còn khớp. Repo/task/worker không được cấp quyền chọn hoặc đổi mode.
Manifest/invocation ghi native_result, selected_inner_mode, outer_proof_hash, permission_policy_hash,
kernel/profile/bwrap/harness/settings/layout hashes; snapshot pin manifest reference này.

Claude candidate là `sandbox.enabled=false` với permission rules/mode không đổi; Codex dùng sandbox
mode hỗ trợ bởi binary pinned. Không suy từ tên mode rằng permission còn giữ: S0.1 kiểm negative
tool denial độc lập OS boundary. Không dùng --dangerously-*, ignore-rules/bypass/accept-all hay đổi
approval policy để pass. Không có cấu hình version đó giữ hai lớp độc lập thì capability_missing.
Settings do runner cấp read-only, validate effective config; managed sandbox requirement không bị
ghi đè. Thay proof/config/version/layout thì manifest mất hiệu lực và chặn attempt mới tới khi kiểm
lại; process đang chạy xử lý theo policy hiện hành, không đổi mode giữa attempt.

## Sandbox và Git boundary

Mount tối thiểu bằng bubblewrap, proc/PID namespace riêng, no-new-privileges và bỏ capabilities.
Profile AppArmor host theo hướng (a): namespace setup của bwrap được cấp, descendants mang
child stack deny capability kể cả gọi lại/copy bwrap. Điều này không có nghĩa mọi userns creation
bị cấm; S0.1 dùng capability-operation/audit fixture và vẫn ghi native sandbox result từng harness.
Nếu native bị chặn bởi nesting, chỉ chọn external_verified khi outer boundary + permission evidence
đạt và owner đã cho phép; giữ deny, không đổi sang unconfined hoặc tự retry ngoài sandbox.
Coder/fixer rw worktree + scratch; reviewer ro worktree và rw scratch riêng; prompt/schema ro.
Git common directory và per-worktree admin metadata ro với agent. Không mount runtime DB/socket,
systemd bus, home chủ dự án, SSH agent socket, GitHub credential, docker socket hoặc host `/proc`.
Mount từng toolchain directory ro; không bind nguyên `/home` để tìm runtime executable.

Selected harness auth là secret cần thiết cho vendor, không phải secret điều phối. Gate/setup không
nhận nó. Network mặc định internet_outbound theo quyết định chủ dự án: share host network,
cho DNS/registry/vendor; không egress allowlist, không hứa chặn LAN/loopback. Network mode ghi
trong runtime snapshot; mạng không cấp thêm credential local. Doctor phải kiểm repo-script không đọc được admin/GitHub secret hoặc gọi socket,
reviewer không sửa repo và agent không push tới remote sandbox; fixture fail thì không chạy thật.

Orchestrator Git dùng argv, env/config allowlist, hooks dir rỗng, credential helper tin cậy;
`safe.directory` không wildcard toàn filesystem. Repo-controlled setup/gate shell chạy trong sandbox
không có token GitHub. Config từ Git objects tại frozen base SHA, không file dirty hoặc symlink ngoài.

## Prepare, gate và publish

- Một worktree/branch `cusr/<task_id>-<slug>` được tạo từ frozen base, owner marker ngoài vùng ghi agent.
  Ref/path đã tồn tại phải đối chiếu ownership/base/checkpoint; mismatch giữ diff và chờ policy.
- Setup/gate/autofix dùng command string snapshot, chạy `/bin/sh -c` chỉ với command đã chốt; mỗi
  command default wall cap 10 phút và cap tổng task còn lại, ghi checkpoint trước thao tác ghi.
  Retry chỉ khi hợp đồng declared safe; unknown của command không-safe phải chờ người.
- Coder/fixer đổi code → invalidate gate/review/CI bị ảnh hưởng; chạy lại gate rồi review trước
  publish. Orchestrator checkpoint/hash tree và commit để evidence gắn đúng SHA; agent không publish.
- Commit intent lưu tree/parent/author/committer timestamps/message/OID dự kiến trước cập nhật ref.
  Recovery nhận lại OID đó, không tạo commit khác; unknown không reset HEAD theo phỏng đoán.
- Push kiểm remote expected old SHA, chỉ fast-forward; remote khác dự kiến chờ head_changed,
  không force-push. Local git ref cập nhật cũng compare-and-swap old OID. Remote push đã gửi có
  thể xong sau merge; drain ghi đúng thực tế, không tạo retry hoặc push local remainder.
- Mọi kết quả publish gồm repo identity, branch, expected-old/new SHA, local checkpoint, request
  receipt; create/recover PR theo [GitHub contract](github.md). Agent không có quyền merge/publish.

## Kiểm chứng bắt buộc

Contract dùng fake child có process con và local bare Git: daemon chết trước/sau unit start, trước
PID receipt, partial file, rotation/ACK, ENOSPC, PID reuse/sleep/UTC jump, silent-progress, descendant
escape, worktree ownership, gate write side effects, push đã xong nhưng receipt chưa ingest.
Có test unit daemon service stop giữ runner unit sống và kill runner dừng cả descendants. Test fake
gồm cố đọc secret/control và sửa repo của reviewer; schema/permission/auth và nesting thật ở lát 0; full workflow smoke ở C.
