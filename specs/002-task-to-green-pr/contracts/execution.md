# Hợp đồng thực thi: runner, harness, worktree và gates

Nguồn: [SPEC §§12–14](../../../SPEC.md), [research R-05–R-08/R-11](../research.md).
Giá trị giới hạn ở research được chụp vào snapshot runtime; không nâng ngầm khi restart.
Từ quyết định chủ dự án 2026-11-01, [ADR-0005](../../../docs/adr/0005-native-harness-permissions.md)
thay baseline outer bwrap bằng chạy trực tiếp trong worktree với quyền native của harness.
Systemd vẫn giám sát process; [runbook](../../../deploy/README.md) mô tả cấu hình và chuyển đổi.

## Operation và runner ownership

1. Daemon commit effect/slot/reservation/operation ID, rồi claim qua store. Chỉ sau commit mới gọi
   node:child_process.spawn gọi systemd-run --user tạo transient user service `cusr-op-<operation-id>.service`, không gắn PartOf/Requires
   vào daemon, `Restart=no`. Cùng operation luôn cùng unit; không dùng `--collect` trước khi ingest.
2. Runner khởi chạy dưới util-linux `flock` giữ khóa kernel độc quyền của operation; marker là dữ liệu, không thay khóa kernel.
   Marker/manifest/fsync ghi trước harness spawn. Runner gặp marker cũ phải nhận lại kết quả/process
   hoặc báo unknown/lost; không spawn lại operation đó, kể cả marker tồn tại nhưng không thấy PID.
   Trước khi báo `not_launched`, daemon ghi marker `fence` để runner đến muộn không spawn ([ADR-0006](../../../docs/adr/0006-terminal-view-backend.md)).
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
Process con daemon chạy cho operation của chính nó (git, gh, lệnh repo) có process group riêng nên có
thể sống tiếp sau khi daemon chết; chúng mang env `CUSR_OPERATION_ID` (con cháu kế thừa). Khôi phục quét
`/proc` và dừng process còn sống mang tag (SIGKILL cả group sau khi kiểm start ticks), vì timeout của
chúng đã chết theo daemon; còn sót thì operation là running. Trước khi handler có thể spawn, daemon ghi
bền mốc `DATA_DIR/process-marks/<operation>.json` theo đồng hồ boot (`/proc/uptime`, cùng gốc với start
ticks, không đổi khi chỉnh UTC); process cùng user không đọc được environ và bắt đầu từ mốc đó thì unknown. Cả hai giữ effect, không probe hay thử lại; chỉ khi chứng
minh không còn process nào mới ghi lost. Tag chỉ để tìm, không xác thực.
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
├── out/outcome.json                # outcome đã redact, recovery trả lại khi auth đã rời home
├── launch.json                     # marker bổ sung trước spawn, agent không mount
├── launch-state.json               # trạng thái trước spawn để kết luận run sau restart
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
đọc tiếp được; sau ACK đã commit segment rời spool sang `acked/` của run (không còn tính vào cap spool,
`task logs` vẫn đọc được tới khi retention dọn cả run). Ingest events + cursor cùng transaction, rồi ACK;
request lặp không lặp event. Cap spool 64 MiB thì dừng operation với artifact_backpressure, không
âm thầm bỏ output chưa ingest. Disk full giữ health lỗi/claim; partial final sau process chết là
invalid output. Retention 30 ngày chỉ cho artifact terminal đã ACK, giữ tombstone; không xóa
worktree có diff/commit chưa bảo toàn theo retention log.

### Finalized reviewer proof (T139)

Reviewer result chỉ finalize sau khi kiểm vùng ghi đạt. `out/result.json` ghi nguyên tử cả giá trị
đã validate và metadata `provenance.recovery` (digest input/exit/value), giữ manifest/schema/launch
nonce/session/usage. Instance harness mới có thể đọc lại đúng attempt từ disk trước mọi preflight
cho một lượt mới: phải khớp operation/run/nonce, input và manifest; exit 0/cây process đã rõ;
role schema và semantic vẫn hợp lệ. Không cần credential để nhận kết quả của lượt đã xong,
không launch lại và không tạo usage mới. Đây là additive metadata, không đổi role schema v1.

Thiếu/partial/lệch proof, result legacy chưa có metadata, worker đã launch hoặc reviewer chưa
finalize đều giữ unknown; không tự tạo lượt thay thế. Scan/adopt process/operation tổng quát và
crash I/O rộng vẫn thuộc B; không lấy API đọc finalized review làm bằng chứng startup recovery đầy đủ.

## Harness contract

| Input từ runner | Output adapter chuẩn hóa |
| --- | --- |
| role, frozen model/effort/permissions, context/schema bytes, deadlines, session nullable | final role result, usage reported/estimated/unavailable, refusal/auth/rate-limit/failure facts, session ref, tool/progress records |

- Coder/fixer result đúng schema SPEC §12.3: version, status done/needs_input/needs_context/blocked,
  summary, questions[], blocker nullable. Reviewer: verdict approve/request_changes, summary,
  findings có severity/file/line/message; closed object, trường required, không tin task ID từ model.
- Structured final response là nguồn chính. Result code/schema/provenance/semantic validation đều
  cần đạt; fallback file chỉ có khi capability manifest khai báo và path mới riêng operation.
  Canonical schema giữ nguyên; Claude 2.1.306 từ chối khai báo meta-schema 2020-12 nên wire schema
  bỏ riêng `$schema`, giữ toàn bộ keyword/ràng buộc còn lại. Manifest ghi thêm `wire_digest` bên
  cạnh canonical digest; inline và file phải khớp, không đổi schema v1 hoặc nới semantic validation.
- Codex build argv `exec --json --output-schema ... --output-last-message ... --sandbox ...`, cwd
  worktree; Claude print/structured-schema/settings tương ứng manifest. Không hardcode model ID từ
  ví dụ docs. Quyền auto/full-access theo pin owner và manifest; không tự bypass để sửa một failure. Auth/session home riêng theo attempt; cấu hình agent của owner (skill, plugin, settings, instructions,
  đăng nhập `gh`) được link vào home đó để worker chạy như phiên tương tác.
- Fixer là vai trò sửa của worker đã code: ưu tiên resume session worker cho lỗi gate/review/CI,
  không resume session reviewer. Resume chỉ cùng harness/binding, đúng policy; nếu không còn dùng
  được thì attempt mới có lý do fallback và mang Q&A
  có ngân sách. Mọi lần sửa kể cả resume MUST nhận packet mới có nguyên nhân/log/findings, nguồn/SHA/run
  generation, acceptance, checkpoint/worktree/diff, PR content và Q&A hiện hành; packet stale phải dựng
  lại, thiếu bắt buộc thì needs_context. Adapter không quyết định tạo attempt. Refusal không bị retry để vượt quyền.
- Context tối đa 128 KiB, phần cắt phải ghi rõ. Reviewer không nhận nội dung diff mà đọc bằng `git diff`
  theo range trong context; context giữ range, digest của diff đầy đủ và toàn bộ path list. Diff đưa cho
  fixer cắt ở 64 KiB. Không đủ acceptance/range bắt buộc thì needs_context/chờ, không cắt thông tin rồi approve. Reviewer
  có session riêng trong `full-review`, thay đổi của nó bị daemon trả về; có thể cùng vendor/model. `direct-pr` không gọi reviewer.
- Worker chuẩn bị commit message, PR title/description theo template frozen trong artifact ngoài code;
  sửa code thì cập nhật mô tả khi cần. Hợp đồng output mới phải version hóa/kiểm chứng schema riêng,
  không coi schema/fixture spike hiện có đã bao phủ; xem [M01–M08](../task-execution-modes.md).

## Mode quyền và capability manifest

Luồng mới ghi `isolation_mode=native`, `provider=host`. Không có outer launcher, mount/PID namespace
hoặc outer proof do Cuesura tạo. Pin mặc định `permission_mode=auto`: Claude `defaultMode=auto`,
sandbox worker mặc định tắt khi không có `settings.sandbox.enabled`. Owner chọn độc lập bằng
`write-pin --sandbox on|off`; khi bật thì `failIfUnavailable=true`, không retry ngoài sandbox.
Codex `workspace-write`,
`approval_policy=on-request`, `approvals_reviewer=auto_review`. Scratch/context/schema là đường dẫn thật
trên host. Settings hash chuẩn hóa các đường dẫn thay đổi theo attempt; launch shape vẫn gắn với role.

Owner chọn `full-access` qua pin: worker Claude dùng `bypassPermissions`, giữ lựa chọn sandbox riêng;
worker Codex dùng `danger-full-access` và `approval_policy=never`. Decider vẫn native read-only; reviewer
chạy như fixer và daemon trả worktree về trạng thái trước review.
Mode không tự đổi khi có lỗi và không thay `full-review`/`direct-pr`, gate, run confirmation hoặc merge.

Manifest phải chứng minh đúng binary, settings, environment, host launch policy, layout và role schemas;
permission mode phải khớp pin. Full access được ghi rõ `selected_inner_mode=full_access`, không giả
bằng chứng cưỡng chế quyền. Claude auto không sandbox ghi `selected_inner_mode=permissions_only`,
`native_result=not_tried`, vẫn cần proof permission. Cả auto và full access có sandbox bật đều cần
native probe đạt; sandbox tắt không được nhận proof native. Đổi sandbox làm đổi settings hash và cần
chứng minh lại. Từ chối thực của vendor được lưu từ event Claude hoặc stderr Codex. Không suy bằng chứng từ lời model hoặc help text.
`external_verified` là mode lịch sử cần outer bwrap, không dùng cho lần chạy host mới.

Manifest/snapshot bwrap cũ vẫn đọc được nhưng không được dùng để chạy host dưới một cam kết cũ.
Đang chạy thì xử lý xong bằng release cũ; task mới cần manifest và snapshot native. Không sửa tay
snapshot để đổi mode. `prove-harness` không cần `--outer-proof`; cờ cũ được nhận nhưng không sử dụng.

## Phạm vi quyền trên host

Setup/gate/autofix chạy trực tiếp trên host với PATH của host và toolchain đã khai. Harness nhận home/auth
riêng và kế thừa environment của daemon trừ biến `CUSR_*` và biến của phiên agent bao ngoài; token điều phối
không được kế thừa. Secret trong environment không ghi vào `invocation.json` (file này đã che) mà giao qua
`secret-env.json` mode 0600, runner xóa trước khi spawn; thiếu file thì run báo `spawn_failed`. Không còn lời hứa OS chặn
mọi truy cập home, Git metadata, database hoặc socket host. Quyền native và full access có đúng phạm vi
harness cung cấp. Canary sau chạy vẫn từ chối kết quả khi decider ghi worktree hoặc sửa Git metadata. Trước khi chạy reviewer,
daemon ghi HEAD và cây làm việc vào scratch của task; không đọc được thì reviewer không chạy. Daemon trả
worktree về mốc đó sau lượt review, cả khi đọc lại run đã xong hoặc run bị mất sau restart.

Orchestrator Git giữ argv/env allowlist, hooks rỗng, credential helper tin cậy và chính sách push như cũ.
Build/gate không có token được truyền riêng, nhưng process cùng UID không bị outer filesystem boundary
ngăn đọc file host. Network do host và harness quyết định; không có egress firewall của Cuesura.

## Prepare, gate và publish

- Một worktree/branch `cusr/<task_id>-<slug>` được tạo từ frozen base, owner marker ngoài vùng ghi agent.
  Ref/path đã tồn tại phải đối chiếu ownership/base/checkpoint; mismatch giữ diff và chờ policy.
- Setup/gate/autofix dùng command string snapshot, chạy `/bin/sh -c` chỉ với command đã chốt; mỗi
  command default wall cap 10 phút và cap tổng task còn lại, ghi checkpoint trước thao tác ghi.
  Retry chỉ khi hợp đồng declared safe; unknown của command không-safe phải chờ người.
- Ghi tree/digest trước/sau mỗi gate. Mọi gate bắt buộc phải đạt trên tree code cuối cùng; nếu gate
  hoặc formatter sửa code thì chạy lại tập gate theo policy/retry safety và giới hạn hiện có. Không
  chứng minh cùng tree cuối hoặc writer còn chạy thì chặn commit/publish, không lặp vô hạn.
- Coder/fixer đổi code → invalidate gate/review/CI bị ảnh hưởng (ngoại lệ review mới cho tích hợp base bên dưới). Chạy gates rồi orchestrator commit
  trước review (`full-review`); `direct-pr` đi thẳng publish sau commit. Commit dùng message worker
  chuẩn bị; evidence gắn đúng tree/base SHA/commit SHA. Orchestrator khóa công việc worktree, đối
  chiếu process/ref/tree/worktree trước publish và push đúng SHA đã lưu. Drift chặn publish để
  đối chiếu, không commit thêm sau approval rồi dùng bằng chứng cũ; agent không publish.
- Trước gọi reviewer, đối chiếu evidence theo [điều kiện reuse](../task-execution-modes.md#dùng-lại-kết-quả-review-còn-hiệu-lực):
  cùng task/revision và base/checkpoint/diff, title/body, acceptance/conventions frozen, policy/binding review
  không đổi thì dùng lại approve hoặc findings còn hiệu lực, không gọi lại agent. No-op giữ checkpoint;
  findings cũ dẫn tới xử lý giới hạn sửa, không hỏi lại cùng diff. Reconcile receipt trước retry review.
- Commit intent lưu tree/parent/author/committer timestamps/message/OID dự kiến trước cập nhật ref.
  Với cập nhật base, intent có thêm `merge_parent` optional (base tip), giữ nguyên input/OID cũ.
  Không phụ thuộc yolo: PR chờ merge tụt sau target được tích hợp qua execution slot và `run_gates`/
  resume/retry. `merge-tree --write-tree --name-only -z` lấy tree và file conflict. Không conflict
  thì không gọi fixer/reviewer mới. Conflict lưu `conflict_files` cùng tree trong intent, giữ HEAD
  cũ và chỉ checkout tree để fixer sửa đúng một lượt; không áp dụng/push commit chứa marker.
  Host so tree sau fixer/gate với tree conflict, không rename detection: chỉ file conflict đổi
  (mỗi file phải khác tree conflict ban đầu) và hết marker thì chứng nhận phạm vi theo SPEC.md §14.2, miễn review mới trên đúng head/tree/
  revision đó. File ngoài phạm vi đổi phải review; `direct-pr` thiếu reviewer thì chờ người.
  Fixer lỗi/bị chặn/chưa xong, gate fail hoặc conflict lần hai mở question, không tự lặp fixer.
  Answer `continue` sau sửa tay chạy gate/publish/CI và ghi actor/time xác nhận lựa chọn file; với markerless
  no-op cần xác nhận này. Answer đúng `retry fixer` cấp phép thêm một lượt. Không reset giới hạn.
  Wait refused cũ được task recheck mở question. Quiet grep chỉ tìm marker mở/đóng ở file conflict,
  không đọc diagnostic diff toàn base; scope unreadable là evidence chưa đạt, không throw khỏi effect.
  Gate đạt mới commit hai parent và publish/chờ CI head mới. CAS/checkout không ghi đè thay đổi
  ngoài dự kiến. FrozenPolicy/base snapshot giữ nguyên; recovery nhận lại cùng intent/OID, không
  reset HEAD theo phỏng đoán, không giả approval của reviewer.
- Push kiểm remote expected old SHA, chỉ fast-forward; remote khác dự kiến chờ head_changed,
  không force-push. Local git ref cập nhật cũng compare-and-swap old OID. Remote push đã gửi có
  thể xong sau merge; drain ghi đúng thực tế, không tạo retry hoặc push local remainder.
- Remote branch đổi sang B khi reviewer còn kiểm A: result/receipt A không được gỡ head_changed
  hoặc route publish. Kiểm blocker/identity/remote trước dispatch và giữ expected-old trong update
  remote đồng thời vẫn chỉ fast-forward; probe rồi push không có guard chưa đủ cho race. Unknown
  giữ chờ; không force hoặc đổi expected-old để nhận B. Restart/replay giữ fact/blocker; xem
  [H01–H06](../task-execution-modes.md#remote-đổi-head-khi-review-còn-chạy).
- Mọi kết quả publish gồm repo identity, branch, expected-old/new SHA, local checkpoint, request
  receipt; create/recover PR theo [GitHub contract](github.md). Agent không có quyền merge/publish.

## Kiểm chứng bắt buộc

Contract dùng fake child có process con và local bare Git: daemon chết trước/sau unit start, trước
PID receipt, partial file, rotation/ACK, ENOSPC, PID reuse/sleep/UTC jump, silent-progress, descendant
escape, worktree ownership, gate write side effects, push đã xong nhưng receipt chưa ingest.
Có test unit daemon service stop giữ runner unit sống và kill runner dừng cả descendants. Test fake
gồm kiểm environment, quyền native và canary reviewer/Git metadata; schema/permission/auth phải
được chứng minh trên harness đã pin. Fixture outer bwrap/nesting cũ là lịch sử; không được dùng để
khẳng định native execution che secret/control host. Full workflow smoke ở C.
