# Nghiên cứu thiết kế feature 002

Ngày đối chiếu: 2026-10-28, mã nền tại commit `10f772f`. Đây là quyết định thiết kế và danh sách bằng chứng cần thu khi triển
khai; đọc help/tài liệu không được tính là smoke đã đạt. Các mã dưới đây là quyết định nghiên cứu,
đồng bộ với [spec](spec.md) và quyết định mạng của chủ dự án ngày 2026-10-28.

## R-01 — Nối runtime vào lõi hiện có

- **Decision:** Giữ một package TypeScript, `decide/evolve` thuần và `Store.accept/claimEffect`.
  Thêm application service, daemon, executor và ba entrypoint `cusr`, `cusrd`, `cusr-runner`.
  Commander là dependency baseline còn thiếu, thêm khi triển khai CLI; GitHub giữ gh qua port, I/O process dùng Node/Git/systemd.
- **Evidence:** [accept.ts](../../src/store/accept.ts), [claim.ts](../../src/engine/claim.ts),
  [open.ts](../../src/store/open.ts), [package.json](../../package.json). Store đang giữ khóa SQLite
  EXCLUSIVE suốt phiên; CLI/runner không thể mở cùng DB để đọc hay ghi trong lúc daemon chạy.
- **Rationale:** CLI gọi daemon qua Unix socket; daemon cấp quyền, đọc projection và nhận mutation.
  Không tạo backend khác hoặc worker có quyền ghi DB.
- **Alternatives considered:** HTTP service, broker, ORM và thư viện durable execution không cần cho
  một daemon/một slot; CLI đọc SQLite trực tiếp phá single-writer và khóa hiện có.

## R-02 — Hoàn tất từ bằng chứng bên ngoài

- **Decision:** Thêm chế độ kết thúc generic `external_confirmation` trong snapshot runtime. Ở bước
  merge gate, chế độ này chờ bằng chứng, không gọi `mergeGuard` để đòi head chứa base mới nhất và
  không phát effect merge. Giữ graph `software_dev@1`; preflight chỉ nhận task có predicate skip-review
  không khớp và scout không được yêu cầu. Cấu hình/ngữ cảnh yêu cầu khác bị capability_missing, không
  tự đổi predicate/snapshot để bỏ role hoặc miễn review.
  Các mode cũ của lõi vẫn có kiểm tra hồi quy, nhưng daemon 002 chỉ nhận chế độ manual này và có
  hàng rào executor từ chối mọi effect merge.
- **Evidence:** [workflow](../../src/engine/workflows/software-dev.ts),
  [structure hash](../../src/policy/structure-hash.ts) bỏ qua tham số `skip_when` nhưng giữ topology;
  [support](../../src/policy/support.ts) chỉ hỗ trợ topology mặc định. Đổi graph sẽ bị chặn.
- **Rationale:** `ExternalCompletionObserved` ghi bền bằng chứng và chặn effect mới trong một quyết
  định; drain generic tái dùng cơ chế cancel mà không tạo `CancelRequested` giả. `TaskCompleted` chỉ
  sau khi process/effect đã rõ, rồi mới gửi dependency fact cho các task khác.
- **Alternatives considered:** Giả effect merge thành công, DONE ngay, hoặc cancel-only đều sai
  hợp đồng; xem [ADR-0001](../../docs/adr/0001-observe-manual-merge.md).

## R-03 — Slot là tài nguyên bền vững

- **Decision:** Thêm projection singleton slot và queue, cập nhật cùng transaction với các event
  claim/release. Chọn priority số lớn trước; cùng priority, resumed trước fresh; tiếp theo
  `requested_at`, hòa bằng `request_global_seq`. Giữ claim khi process/effect chưa rõ.
- **Evidence:** [triage](../../src/engine/triage.ts) đã chặn dependency chưa DONE nhưng chưa có global
  queue; [verify](../../src/store/verify.ts) hiện nhóm event theo task để replay.
- **Rationale:** Quyết định chọn slot là hàm thuần trên queue snapshot; store đọc/kiểm tra lại trong
  transaction. Replay projection liên task phải đi theo `global_seq`, không dựa thứ tự duyệt Map task.
  Priority số lớn trước đã ghi vào SPEC §6.2/data model và CLI; không sửa priority của task.
- **Alternatives considered:** Boolean trong RAM mất qua restart; giữ slot toàn vòng đời chặn task mới.

## R-04 — Quan sát hữu hạn, độc lập deadline thực thi

- **Decision:** `observe_external` là effect chỉ đọc, có admission riêng cho terminal, hạn quan sát,
  generation và số lượt; không dùng `await_ci` cũ cho lịch quan sát sau deadline. Chốt mặc định:

  | Giới hạn | Giá trị |
  | --- | --- |
  | Hạn quan sát tổng | 30 ngày từ lần đầu nhận diện PR; không reset bởi thay đổi/đọc/recheck/restart |
  | Poll | 60 giây × 2 sau mỗi lượt, trần 1 giờ; reset cadence khi head/check/PR-state thay đổi, không reset hạn tổng |
  | Trần lượt tự quan sát | 2.000 lượt/PR, chạm trước cũng observation_expired |
  | Một lượt đối chiếu | Tối đa 60 giây, 100 HTTP request, 20 trang mỗi danh sách, 2 MiB/response |
  | Transport | Tối đa 3 lần gửi/request, chờ 1 rồi 2 giây; Retry-After vượt cửa sổ thì trả unknown và hẹn lượt sau trong hạn |
  | CI tự tiếp tục | Timeout của bước CI đóng băng, mặc định 1 giờ/head; tối đa 60 lượt CI/head, không reset khi recheck |
  | Drain sau merge | 5 phút tổng, tối đa 3 lượt tự đối chiếu; TERM 10 giây rồi KILL, xác minh thêm tối đa 5 giây |
  | Recheck drain | Một lượt tối đa 60 giây gồm dừng/xác minh; không khôi phục lượt tự động |

- **Evidence:** `await_ci` đang thuộc `BUSINESS_EFFECTS` trong [effect.ts](../../src/domain/effect.ts),
  bị [claimable](../../src/engine/claim.ts) chặn khi deadline hết. Không thể chỉ nối poll executor.
- **Rationale:** Thời hạn tuyệt đối và trần lượt bảo đảm I07 ngay cả khi remote thay đổi liên tục.
  Timer dùng UTC ghi bền; thời gian của process dùng monotonic, restart tính phần còn lại từ hạn UTC.
  Giới hạn daemon được chụp vào snapshot runtime trước RUNNING, thay config chỉ áp task sau.
- **Alternatives considered:** Poll mãi có trần chu kỳ vẫn vi phạm I07; cửa sổ 30 ngày trượt theo mọi
  thay đổi có thể sống vô hạn. Không dùng thay đổi remote để gia hạn.

## R-05 — Runner độc lập và cửa sổ spawn

- **Decision:** `node:child_process.spawn` gọi `systemd-run --user`, mỗi operation có transient
  service riêng theo ID; `Restart=no`, `KillMode=control-group`, không gắn vòng đời vào daemon.
  Runner claim bằng util-linux flock, ghi launch marker bền trước spawn harness, chỉ một lần spawn
  cho operation. Marker cũ chưa rõ kết quả phải reconcile/lost, không tự spawn lại.
- **Evidence:** Detached process vẫn thuộc cgroup; systemd dừng toàn cgroup mặc định. Xem
  [systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html),
  [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).
- **Rationale:** Foreground daemon cũng dùng backend supervision này. Đây là **điều chỉnh baseline**
  đã ghi tại [SPEC §§12.1/17.2](../../SPEC.md) và
  [ADR-0002](../../docs/adr/0002-systemd-runner-lifetime.md), không được gọi là baseline chưa đổi.
  Doctor kiểm user manager/probe unit; WSL2 kiểm systemd=true và trạng thái thực sau distro restart.
  [Lát 0](spike-0.md) phải chứng minh lifetime/cgroup trước A.
- **Alternatives considered:** Chỉ unref/detached không đủ; KillMode=none của daemon làm ownership
  khó kiểm soát; hai backend foreground/service tăng công bảo trì. Không chọn các hướng đó.

## R-06 — Host AppArmor, sandbox lồng nhau và mạng

- **Decision:** Provision profile riêng gắn `/usr/bin/bwrap` theo
  [runbook](../../deploy/README.md), giữ `kernel.apparmor_restrict_unprivileged_userns=1`.
  Cài profile là thao tác admin tách biệt; doctor chỉ kiểm/chẩn đoán, không tự sudo hoặc sửa sysctl.
  Mount/PID/capability policy outer bwrap vẫn bắt buộc, sandbox nội bộ Claude/Codex vẫn bật.
- **Evidence:** Đã tái hiện host bwrap 0.9.0 fail `setting up uid map: Permission denied`; chủ dự án
  xác nhận không có AppArmor profile bwrap. Ubuntu 24.04 nêu restriction và quyền userns trong
  [release notes](https://documentation.ubuntu.com/release-notes/24.04/); không còn coi lỗi là riêng
  phiên agent. [Bubblewrap](https://github.com/containers/bubblewrap) chỉ là primitive, policy phải
  do caller dựng đúng; profile cấp userns không tự chứng minh confinement/nesting.
- **Rationale:** Chọn AppArmor profile thay vì nới sysctl toàn máy; profile dùng unconfined+userns
  cho đúng executable, ảnh hưởng mọi người có thể chạy executable đó và phải được admin review.
  Sandbox không mount DB/socket/admin/GitHub/SSH credential/home host/systemd bus; reviewer ro repo,
  coder/fixer rw worktree/scratch, metadata Git ro. Selected model auth ở home riêng theo attempt.
- **Network decision (chủ dự án chấp nhận 2026-10-28):** Setup/gate/autofix/agent mặc định
  internet_outbound, share host network, DNS/registry/vendor hoạt động. Không có egress allowlist
  và không hứa chặn LAN/loopback. Giữ filesystem/PID isolation; setup/gate không có model auth,
  mọi agent không có credential điều phối. Network mode đóng băng trong runtime snapshot.
- **Alternatives considered:** Không chọn sysctl=0 toàn máy hoặc silent unsandboxed fallback. OS
  user riêng chỉ được xét lại nếu lát 0 fail, không là backend thứ hai tự động. Tool denylist hoặc
  worktree đơn thuần không thay OS boundary.
- **Verification status:** Host hiện **blocked**, profile chưa cài. Lát 0 trước A kiểm host profile,
  nesting của từng harness với sandbox nội bộ còn bật, auth private home, mạng và quyền thực tế.
  Fail là no-go trước tasks/A, không dời thử nghiệm này sau fake/recovery.

## R-07 — Harness là build-command/parse-output

- **Decision:** Hai adapter không điều phối. Dùng structured final response, Zod validate lại;
  capability manifest pin binary/version/hash và role schema hash. Coder/fixer dùng schema chung,
  reviewer có schema verdict riêng. Không tự fallback vendor/model hoặc bỏ hạn mức không hỗ trợ.
- **Evidence:** Help chỉ đọc đã xác nhận `codex-cli 0.164.0`, Claude Code `2.1.311` trong môi trường
  khảo sát. Codex có `exec --json --output-schema -o --sandbox`; Claude có `-p`, structured JSON,
  schema, permission/settings controls. Tài liệu: [Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode),
  [Claude CLI](https://code.claude.com/docs/en/cli-reference). Help không chứng minh output/auth thực tế.
- **Rationale:** Phiên bản Claude hiện có `--bare` thay đổi cách đọc auth; không mặc định dùng nó cho
  subscription. Chọn `--safe-mode` hoặc settings tường minh theo capability fixture, không dùng
  `--dangerously-*`. Tắt plugin/MCP/hook không được cấp, truyền model/effort từ frozen binding.
- **Alternatives considered:** SDK/cloud agents thay đổi phạm vi; agent tự ghi result.json trong repo
  không đủ provenance; dựa exit=0 không đủ. Resume phải cùng harness/session đã chứng minh, nếu không
  dùng attempt mới mang Q&A trong ngân sách.
- **Verification status:** Schema acceptance/output thật của cả ba role × hai vendor, auth và giới
  hạn thực thi thuộc lát 0 trước A, tối đa 6 invocation schema/role ban đầu theo spike-0.md; chưa chạy
  không có capability proven. Smoke xuyên suốt vẫn ở C sau A/B, khác với spike cô lập ngày 1.

## R-08 — Git/worktree và publish nhận lại được

- **Decision:** Git CLI qua argv cho lệnh orchestrator; shell chỉ dành command setup/gate đã chốt.
  Base/config đọc từ commit đã fetch bằng SHA, không đọc file cusr.yaml bẩn ở working copy. Ref riêng
  `cusr/<task_id>-<slug>`, worktree trong runtime root. Checkpoint tree/parent/diff digest trước ghi; commit
  metadata/commit OID tính xác định và lưu intent trước cập nhật ref. Push fast-forward có expected
  old SHA, không force; PR nhận lại bằng repo + owner/head/base + marker + operation key.
- **Rationale:** Timeout sau commit/push/create PR luôn probe trước retry, kể cả lỗi 422. Không tạo
  commit thứ hai chỉ vì chưa ingest kết quả. Unknown giữ claim, không reset worktree theo HEAD đoán.
- **Alternatives considered:** Mỗi retry tạo commit mới hoặc tìm PR chỉ theo title làm sai idempotency.

## R-09 — GitHub là nguồn fact, không quyết định workflow

- **Decision:** Adapter dùng `gh api` qua port process mỏng có deadline, pagination cap và response validation; API version
  pin `2026-03-10` cho fixture được duyệt. Chỉ allowlist GET quan sát, POST tạo PR/rerun được policy
  cấp; không có phương thức merge. Đọc PR trước và sau bundle checks/rules, nếu head/base/state đổi
  giữa hai lần đọc thì ghi bundle inconsistent/unknown và không báo xanh.
- **Evidence:** [Pull requests](https://docs.github.com/en/rest/pulls/pulls),
  [Branch protection](https://docs.github.com/en/rest/branches/branch-protection),
  [Rules for branch](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch).
- **Rationale:** Ghi riêng head tại merge với merge commit; squash/rebase không cho phép so chúng
  bằng nhau. Pin PR identity và raw-response digest, không suy ra merge từ branch bị xóa hoặc CI pass.
- **Verification status:** API không được giả định là snapshot transaction. Fixture GitHub sandbox
  phải xác nhận `.head.sha` của PR đã merge qua merge/squash/rebase và push vào source branch sau
  merge; nếu không chứng minh head tại merge, normalized fact là unknown, không dùng head remote
  mới thay vào. Fixture head-at-merge thuộc lát 0 trước A; không bỏ FR-040.12 để đạt smoke.
  Dùng gh theo SPEC §17.2, không duy trì fetch backend thứ hai; gh version và auth home host chỉ
  ở orchestrator, không mount vào agent.

## R-10 — Snapshot checks giữ chuỗi, không mở app binding trong 002

- **Decision:** Giữ `ci.required_checks: string[]`, FrozenPolicy schema v1 và các hash hiện có.
  GitHub requirement any-app cùng tên có thể được snapshot bao phủ; GitHub ghim app cụ thể luôn
  required_checks_mismatch dù tên khớp. Raw evidence vẫn ghi App ID để explain chênh lệch; không
  mở schema `{name, app_id}`, không upcast snapshot chỉ vì App ID.
- **Evidence:** [Branch protection](https://docs.github.com/en/rest/branches/branch-protection),
  [Check runs](https://docs.github.com/en/rest/checks/runs) có nguồn phát; core
  [expectedChecks](../../src/engine/merge-guard.ts) đang union tên nên mode 002 cần subset/mismatch
  guard trước evaluator. Cùng tên/nguồn mơ hồ thì policy, không gộp tùy ý.
- **Rationale:** Giữ phần phổ biến any-app/no-protection, chặn bảo thủ với app-pinned. Lối ra là chủ
  dự án chỉnh requirement GitHub thành any-app nếu chấp nhận, manual merge hoặc cancel/task add;
  Cuesura không tự nới rule. `none` cần evidence dương của branch/classic/rules, lỗi đọc vẫn unknown.
- **Alternatives considered:** Typed App ID snapshot/FrozenPolicy v2 bị hoãn theo nguyên tắc VIII;
  equality, union ngầm snapshot và 404→empty vẫn bị loại. Hỗ trợ binding app là feature sau.

## R-11 — File protocol, log và giới hạn dung lượng

- **Decision:** Giữ `DATA_DIR/runs/<attempt_id>/` và các file invocation.json/pid.json/events.jsonl/
  stderr.log/liveness/progress.json/exit.json/out/result.json theo SPEC §12.1. Thêm launch marker
  và rotation segment khi cần; không đổi file chuẩn sang manifest/receipt. Operation không có
  attempt dùng DATA_DIR/operations/<operation_id>/ cùng protocol. Result/exit ghi nguyên tử. DB ingest cursor và event suy ra cùng
  transaction. Giữ segment tới khi daemon ACK đã commit, không xóa output chưa ingest.
- **Rationale:** Giới hạn mặc định: context 128 KiB (review diff 64 KiB), final result 1 MiB, record
  JSONL 256 KiB, segment 8 MiB, spool 64 MiB/operation; 30 ngày retention cho artifact đã ACK của
  task terminal. Chạm spool cap thì runner dừng operation và báo artifact_backpressure; không
  chạy mãi khi daemon chết/disk đầy. Acceptance thiếu vì cap phải hỏi/chờ, không cắt rồi gọi agent.
- **Alternatives considered:** Stream thẳng vào daemon mất output qua restart; rotation không ACK
  có thể xóa phần chưa ingest; lưu raw rồi mới redact làm lộ secret đã ghi.

## R-12 — Tương thích và bằng chứng

- **Decision:** Migration DB 002 vẫn cần cho projection slot/queue/ingest/runtime thật sự mới,
  **không** do App ID. FrozenPolicy và event envelope giữ schema_version=1; thêm event types
  additive và state fields khởi tạo mặc định khi replay event cũ. Không thay payload/type của
  event đã lưu, không dual decoder/upcaster hoặc viết lại policy/hash v1.
- **Rationale:** Schema DB mới chặn binary cũ trước khi thấy event types mới; fixture DB v1 kiểm
  migrate/rebuild projection với fields mới và replay đầy đủ. Task legacy runtime=null không tự
  dispatch. Unknown process không được giả định chết. Property khác process/Git/SQLite/crash thật.
- **Alternatives considered:** Tăng cả event/FrozenPolicy version để thêm app_id bị loại; chỉ bump
  khi có thay đổi encoding không tương thích đã chứng minh, không chuẩn bị sớm. Migration projection
  phục vụ durable runtime vẫn bắt buộc, không xóa để làm nhẹ con số.

## Trạng thái nghiên cứu và gate

Đã chọn hướng deployment và các giới hạn, nhưng **feasibility chưa đạt**: host sandbox đang fail,
chưa có 6 output role/vendor hoặc GitHub head-at-merge fixture. Xem [lát 0](spike-0.md); không tuyên
bố đã sẵn sàng tasks/A từ việc viết docs. Sau A có go/no-go và mốc ngày 10 trong plan. Constitution
không có waiver; điều chỉnh process baseline được ghi SPEC/ADR, gh/file protocol giữ baseline.
