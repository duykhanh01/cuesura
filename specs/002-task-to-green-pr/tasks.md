# Tasks: Task tới PR xanh và ghi nhận merge thủ công

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md), [hiến chương](../../.specify/memory/constitution.md).

**Bổ sung 2026-10-29**: [Hai chế độ và xác nhận cấu hình chạy](task-execution-modes.md) được chốt,
chưa triển khai. T135–T139 dưới đây bổ sung coverage M01–M08 và là prerequisite nghiệm thu mới;
các task chưa làm phải dùng mode đã xác nhận thay skip theo XS, commit trước review và không
ràng buộc vendor. Không đánh dấu lại task đã xong hoặc sửa bằng chứng spike để coi hợp đồng mới đã đạt.

**Trạng thái**: Backlog được tạo theo yêu cầu ngày 2026-10-28. **Gate lát 0 đạt (T009, 2026-10-28)**: Phase 2 trở đi được bắt đầu theo thứ tự phụ thuộc; các ghi chú BLOCKED bên dưới là lịch sử trước T009. Theo [ADR-0004](../../docs/adr/0004-isolated-bwrap-baseline.md), baseline là Isolated rootless bwrap, không bắt buộc AppArmor 4. [Spike-0-report.md](spike-0-report.md) vẫn chặn A vì S0.1–S0.3 chưa đủ bằng chứng. Chỉ bắt đầu Phase 2 sau bằng chứng pass cả ba gate; cập nhật thiết kế không tự mở lát A. Giữ ID, trạng thái T003–T005 và coverage; T002/T006 được sửa theo tiêu chí mới. Không coi yêu cầu cập nhật tài liệu là quyền provisioning host, tiêu usage hoặc publish PR thử.

**Tests**: Spec/hiến chương yêu cầu property, contract, SQLite/Git/process integration, crash injection và smoke thật. Viết kiểm thử cho hành vi mới và xác nhận thất bại trước triển khai; giữ regression 001. Fake, I/O thật và tài khoản/model thật có bằng chứng riêng. Các đường dẫn module/test mới bên dưới là đích triển khai, chưa phải file sẵn có.

**Organization**: Theo user story và thứ tự giao 0 → A (US1, US2, US4) → go/no-go → B (US3, US5, US6) → C. Cả US1–US4 đều P1; US4 đi trước US3 theo thứ tự bắt buộc của spec. Phase nền chứa boundary an toàn dùng ngay từ US1; Phase US4 hoàn thiện adapter và bằng chứng. Một story được kiểm riêng bằng fixture sau các prerequisite nêu dưới đây, không có nghĩa các story độc lập về triển khai.

## Format: `[ID] [P?] [Story] Description`

- Mọi task chưa thực hiện bắt đầu bằng `- [ ] Tnnn`; `[USn]` chỉ dùng trong phase story.
- `[P]` chỉ các task khác file có thể làm đồng thời **sau prerequisite chung**; không bỏ qua gate hoặc phụ thuộc nêu trong mô tả.
- Source tại `src/`, test tại `test/` (không phải `tests/`), một package Node 24.22.1/TypeScript strict/ESM; dùng store/engine hiện có.
- Không thêm ORM, broker, durable framework, DI container, GitHub fetch backend hoặc supervision backend thứ hai. Không triển khai merge/yolo, retry terminal, amend-policy hay nhận head mới.

## Phase 1: Setup — mở khóa lát 0

**Purpose**: Chứng minh feasibility trước runtime; không bootstrap lại lõi 001 đã có.

- [x] T001 Ghi nhận prerequisite và đầu vào spike trong `specs/002-task-to-green-pr/spike-0-report.md`: host, model/auth, repo sandbox và owner merge thủ công. Baseline 6 invocation × 5 phút; owner đã duyệt thêm đúng 2 fixer, trần lượt chạy này là 8, giữ nguyên ledger gốc và hai failure đầu. Inputs/approval/usage ledger có evidence, không tự mở gate A.
- [x] T002 Xác nhận host rootless bwrap/systemd theo `deploy/README.md` và ADR-0004, lưu OS/kernel/Node/bwrap/version/hash, policy/label nếu có, exit probe userns và user-unit vào `specs/002-task-to-green-pr/spike-0-report.md`; đồng bộ scope/comment/report của prototype `scripts/spike-002/sandbox.ts` để child stack chỉ là hardening tùy chọn, không đổi canary hoặc tự báo S0.1 pass. Chỉ cần admin provisioning nếu policy host chặn, không tự sudo/đổi sysctl; không bắt buộc AppArmor 4/Ubuntu 24.04. Đây là task local, không gọi model/GitHub.
- [x] T003 Tạo role schemas Zod closed và exporter tại `scripts/spike-002/role-schema.ts`, `scripts/spike-002/export-role-schemas.ts` cho coder/fixer/reviewer theo SPEC §12.3, xuất JSON Schema/digest vào `test/fixtures/runtime/spike-0/schema/`; kiểm cấu trúc/required/null bằng fixture local không gọi model, không import runtime A; T013 promote/reuse schema đã chứng minh và kiểm hash tương đương thay vì viết bản khác âm thầm.
- [x] T004 Tạo prototype cô lập tại `scripts/spike-002/sandbox.ts`, `scripts/spike-002/runner.ts`, `scripts/spike-002/harness.ts` và hướng dẫn argv/lệnh tại `specs/002-task-to-green-pr/spike-0.md`: mount/private-home/PID/AppArmor canaries, systemd-run/flock/lifetime, native/conditional external_verified, role schema T003 và budget ledger chung T001; mặc định chỉ kiểm local không tốn model, paid invocation chỉ từ T006/T007 khi được cấp quyền, không cần daemon/store/entrypoints A; giữ layout/settings/argv/hash để T018/T020/T068/T069 tái sử dụng và đối chiếu.
- [x] T005 Tạo gh-port prototype tại `scripts/spike-002/gh.ts` và lệnh chạy trong `specs/002-task-to-green-pr/spike-0.md` cho timeout/byte/page/request cap, immutable repo/PR identity, required-check bundle/head-at-merge/raw-redacted evidence và request ledger; dùng fixture local để kiểm parser trước T008, chỉ T008 được dùng sandbox đã cấp, không endpoint merge; T040/T044 promote/reuse phần đã chứng minh và giữ fixture/hash truy vết.
- [x] T006 Bổ sung và chạy proof Isolated theo S0.1 trong `specs/002-task-to-green-pr/spike-0.md` từ prototype T004/schema T003 sau T002; lưu fixture vào `test/fixtures/runtime/spike-0/host/`: mount/PID/secret/control/FD/socket thật, reviewer/Git metadata ro, mọi vùng rw, mount-race/re-exec/copy/raw-userns/remount/unmount, systemd foreground/service lifetime và kill descendants. Dùng lại `scripts/spike-002/reassess-sandbox.ts` cùng evidence 360 checks như đầu vào, không coi là full proof; không yêu cầu child stack/capability-denial audit trên host không chọn hardening đó. Kiểm native sandbox thật từng vendor và permission denial trên đường outer cho phép, dùng chung ledger/budget T001 với T007; external_verified chỉ theo ADR-0004, không bypass quyền.
- [x] T007 Chạy prototype T004 với schema T003 theo S0.2 tại `specs/002-task-to-green-pr/spike-0.md`, lưu fixture redact vào `test/fixtures/runtime/spike-0/harness/`: private-home auth, mạng pnpm/pip/vendor và coder/fixer/reviewer × Claude/Codex, schema/semantic/usage/model/effort/permission/session evidence; tất cả lần gọi model tính chung trần T001, không đủ bằng chứng khi hết budget thì báo blocked.
- [x] T008 Chạy S0.3 bằng prototype gh port T005 trên sandbox theo `specs/002-task-to-green-pr/spike-0.md`, lưu fixture vào `test/fixtures/runtime/spike-0/github/`: merge/squash/rebase do người dùng merge, source push sau merge/source delete, head-at-merge proof, classic/rules/none/unknown/app-pinned, immutable repo ID và request ledger; không dùng repo sản phẩm hoặc gửi merge.
- [x] T009 Đối chiếu S0.1–S0.3 và cập nhật kết luận thật trong `specs/002-task-to-green-pr/spike-0-report.md`; chỉ ghi pass khi đủ command/exit/fixture/hash và manifest prototype, nếu fail giữ BLOCKED và yêu cầu review thiết kế trước Phase 2, không dùng help/fake/quality gates thay proof.

**Checkpoint 0**: T009 pass là prerequisite Phase 2–10; **đã đạt ngày 2026-10-28** ([kết luận](spike-0-report.md#t009--kết-luận-gate-lát-0-2026-10-28)).

**Quyết định chủ dự án 2026-10-28 (mở gate một phần):** cho phép bắt đầu trước T009 các task nền
không phụ thuộc kết quả spike: T010–T012, T014–T017, T019, T021–T025. T013, T018, T020, T026 và mọi
phase sau vẫn đợi T009 pass. Nếu S0.1–S0.3 buộc đổi thiết kế, phần đã làm trước phải sửa theo; quyết
định này không đổi trạng thái BLOCKED của lát 0 hay điều kiện go/no-go.

Kết quả lượt mở gate một phần (branch `002/phase2-foundation`): typecheck/lint/build exit 0, default
60 file/726 test pass hai lần liên tiếp, không skip; reliability seed 20261028: 202/202 pass (gồm crash
`after_runtime`). Ba property test nặng CPU có hạn riêng 180 giây vì crash-point sinh thêm tiến trình con. Phạm vi và hạn chế cần story sau xử lý tiếp:

- T014: trigger observation/completion/drain/recheck đã có schema, event và evolve; `decide` còn từ
  chối `not_supported_yet` tới T044–T046/T062/T102. Effect `observe_external` là service effect.
- T015: `blockers[]` lưu trong state; `allowed_actions` vẫn dựng bởi code ở explain/CLI (T111).
- T016: test viết cùng lúc với implementation, không chạy trước để xác nhận fail. DB v1 thật ở
  `test/fixtures/runtime/db/v1.sqlite` (sinh bởi store schema 1 tại `af5df8d`).
- T024: verify dựng lại mọi bảng runtime theo global_seq; việc chặn dispatch khi lệch thuộc startup T026.
- T025: claim 002 đăng ký operation cùng `EffectStarted`; `require_runtime` chặn task legacy. Slot
  chỉ nhả khi mọi operation giữ slot đã rõ; task kết thúc khi còn operation chưa rõ vẫn giữ slot.
- T019: stderr bị cắt cưỡng bức giữ lại phần đuôi để secret đã biết không bị tách qua hai record;
  token pattern dài hơn cửa sổ 8 KiB chỉ được che theo best-effort. Tasks trong phase này mô tả việc cần làm, không xác nhận đã được cấp credential/usage hay quyền quản trị.

T003–T005 giữ trạng thái hoàn thành theo phạm vi prototype đã bàn giao. Các nhắc AppArmor trong
T004 là lịch sử; T002 đã cập nhật thông điệp/proof scope và kiểm host theo ADR-0004, T006 kiểm boundary mới.
Trong mọi task, “native sandbox” là lớp nội bộ của harness bên trong Isolated; không có backend
Native-only trong v1. T006 đã có proof local và native shell/auth hai vendor; Codex có log runtime
rejection trên stderr ở cả ba role (không có event `--json`), kể cả khi chạy candidate tắt apps/plugins
ở coder/fixer/reviewer; đã có fixture lifetime và bản ghi native result/permission hash.
Owner chốt host triển khai là worker WSL2 này; TOCTOU mount-source và reviewer thử ghi đã chạy.
T006 đã đóng ngày 2026-10-28 với hai giới hạn owner chấp nhận: kiểm inode trước exec chuyển thành yêu cầu T020;
scratch read-only của Codex reviewer chưa có proof runtime, không ghi là proven.
T007 đã đóng ngày 2026-10-28 (capability manifest tại `test/fixtures/runtime/spike-0/harness/real-20261028/capability-manifest.json`; cost_limit và session_resume giữ unknown theo owner); có 6 output role/vendor hợp lệ, pnpm và pip network (pip chạy lại 2/2 exit 0, hash khớp PyPI); không thay unknown
permission/session/cost capability bằng proven. T001 đã hoàn tất, dùng hết 12/12 lượt đã duyệt (session resume không duyệt, giữ unknown);
không gọi thêm model nếu chưa được tăng budget. T008 đã đóng ngày 2026-10-28 (live classic/rules/none/unknown/app-pinned tại `test/fixtures/runtime/spike-0/github/live-rules/manifest.json`; `evaluate` chỉ fixture local). Trước đó: ba PR đã merged, push/delete source giữ
nguyên head trước merge; live port xác nhận identity/target/merged và required=none. API
2026-03-10 bỏ merge_commit_sha; port lấy merge commit từ merged event, proof complete cả ba PR.
Evidence trước đó tại
`test/fixtures/runtime/spike-0/github/real-20261028/manifest.json` và
`test/fixtures/runtime/spike-0/github/real-20261028-merge-event/manifest.json`.

## Phase 2: Foundational — nền runtime dùng chung (lát A)

**Purpose**: Mở rộng domain/store và boundary, giữ `decide/evolve` thuần, effect sau commit, single writer. Không chạy story trước khi nền đạt.

- [x] T010 Thêm Commander theo baseline và ba bin `cusr`, `cusrd`, `cusr-runner` vào `package.json`, `pnpm-lock.yaml`, `tsconfig.build.json`, tạo entrypoint `src/cli/cusr.ts`, `src/cli/cusrd.ts`, `src/cli/cusr-runner.ts`; giữ một package/tsc ESM và chưa công bố lệnh chưa implement là khả dụng.
- [x] T011 [P] Thêm `test/contract/**/*.test.ts` vào default project và project smoke opt-in trong `vitest.config.ts`; giữ reliability riêng và seed qua `scripts/test-reliability.ts`, không để test mới nằm ngoài lệnh chuẩn.
- [x] T012 Tạo closed runtime schemas tại `src/domain/runtime.ts` và mở `src/domain/state.ts`: RuntimeContext, WorktreeCheckpoint, ExecutionRequest/Slot, OperationReceipt, IngestCursor, Artifact, CapabilityManifest theo data-model; quote constraints: “Không đổi input/revision/deadline do recheck hoặc remote push”, “Agent/setup/gate/publish đều có receipt; một process identity không chỉ là PID”, “Runtime root riêng; không tin path từ agent; không expose secret hoặc file chưa finalize”.
- [x] T013 [P] Định nghĩa port harness/process/Git/GitHub/Clock và `SandboxProvider` nhỏ tại `src/adapters/ports.ts` theo execution contract; provider trả launch plan/argv/layout digest/proof refs, runner giữ spawn/timeout/cgroup, không registry hoặc backend Native/Container. Tạo closed role-result Zod và JSON Schema export tại `src/adapters/harness/result-schema.ts`, cùng harness giả lập tại `src/adapters/harness/fake.ts`; promote/reuse schema/exporter T003 đã chứng minh, kiểm digest/semantic tương đương và giữ fixtures lịch sử; metadata được orchestrator gắn, schema coder/fixer và reviewer riêng đúng SPEC §12.3, fake không có năng lực proven của vendor thật.
  - Kết quả T013: schema canonical giữ nguyên digest T003 (`ROLE_SCHEMA_DIGESTS`); file wire có/không `$schema` khớp byte với 4 hash `wire_schema_file_sha256` đã gửi vendor ở T007; validate trả kết quả y hệt prototype trên 20 mẫu synthetic. Prototype `scripts/spike-002/role-schema.ts` và fixtures giữ nguyên làm lịch sử. Fake harness có manifest vendor `fake`, mọi capability `unknown`.
- [x] T014 Thêm additive trigger/event/effect của runtime tại `src/domain/trigger.ts`, `src/domain/event.ts`, `src/domain/effect.ts` và export tại `src/domain/index.ts`: queue/grant/release, operation, cursor, observation, completion/drain/recheck; “Event envelope giữ schema_version=1”, không sửa payload/type sự kiện cũ, mọi switch exhaustiveness dùng assertNever.
- [x] T015 Mở `src/engine/evolve.ts` cho runtime fields mặc định null/empty khi replay event v1 cũ và event T014 mới; lưu provenance/head/generation, blockers/allowed actions, completion/slot/cursor dưới dạng state tất định, không I/O/clock/random.
- [x] T016 Viết kiểm thử nền và xác nhận fail trước implementation tại `test/integration/runtime/migration.test.ts`, `test/integration/runtime/atomic-claims.test.ts`, `test/unit/domain/runtime.test.ts`: migrate DB v1/replay/hash nguyên vẹn, unique grants/cursors/operations, rollback projection/outbox/timer, legacy runtime=null chỉ đọc và không dispatch; kiểm crash ở transaction boundaries mới; chạy lại sau T017/T024/T025 và yêu cầu pass trước T026.
- [x] T017 Tạo `src/store/migrations/002_runtime.sql`, sửa `src/store/migrate.ts` và `src/store/projector.ts` cho runtime_contexts/execution_queue/execution_slot/operations/ingest_cursors/artifacts/external_observations; “Unique slot key, một active queue/task, unique operation/effect, unique cursor/segment sequence và proof/observation key ngăn trùng”; migration/rebuild projection trong transaction, raw event/hash cũ nguyên vẹn, DB schema mới chặn binary cũ.
- [x] T018 [P] Xây `src/runner/supervisor.ts`, `src/runner/operation-lock.ts`, `src/runner/identity.ts` theo execution contract: spawn systemd-run --user unit ID ổn định, Restart=no/KillMode=control-group, không PartOf/Requires daemon/collect sớm; flock kernel lock, launch marker fsync trước harness, identity boot_id/InvocationID/cgroup/start ticks/nonce; marker cũ không spawn lại.
  - Kết quả T018: `SystemdSupervisor` cài `ProcessPort` (launch/inspect/stop/collect) qua `systemd-run --user` + `flock`; launch từ chối (`marker_exists`) khi đã có launch marker hoặc unit còn nạp, `unknown` khi không chứng minh được chưa chạy. `observeLaunch` dựng lại trạng thái running/lost/unknown/finished từ marker, pid.json (boot_id/start ticks/nonce) và khóa kernel, không bao giờ cho spawn lại. Integration với systemd user thật pass; vòng exec của runner (spawn harness, pid.json, exit.json) thuộc T073.
- [x] T019 [P] Xây protocol/redaction chung tại `src/runner/files.ts`, `src/runner/redact.ts`: layout chuẩn runs/attempt và operations/operation, invocation/pid/events/stderr/liveness/progress/exit/out/result; temp→fsync→rename→fsync directory, path/symlink guard, redact trước ghi; record 256 KiB/result 1 MiB/segment 8 MiB/spool 64 MiB theo snapshot.
- [x] T020 [P] Xây implementation duy nhất rootless bwrap của port SandboxProvider T013 và private home tại `src/runner/sandbox.ts`, `src/runner/private-home.ts` từ proof T006/T007; Isolated bắt buộc cho harness/setup/gate/autofix, không gate theo tên AppArmor profile. Coder/fixer rw worktree/scratch, reviewer ro repo, Git metadata ro, prompt/schema ro, toolchain mount riêng; không mount host home/proc, DB/socket/bus/GitHub/SSH/docker/admin/operate token; gate/setup không có model auth, network internet_outbound ghi rõ. Theo giới hạn owner chấp nhận khi đóng T006: ghi (dev, ino) từng nguồn mount lúc plan và kiểm lại ngay trước/trong khi exec bwrap (hoặc mount qua fd), lệch thì fail closed; tái dùng `scripts/spike-002/probe-mount-toctou.ts` làm regression.
  - Kết quả T020: `BwrapSandboxProvider` + `private-home.ts` đã có, launcher `src/runner/sandbox-exec.py` (bản đã chứng minh ở S0.1) mở lại nguồn mount bằng O_PATH, so (dev, ino)/realpath rồi bind theo FD, lệch thì exit 125. Unit test policy/private home pass; `test/integration/runtime/sandbox-bwrap.test.ts` (ghi/đọc theo role, PID/CapEff, race TOCTOU) pass 3/3 ngày 2026-10-29 trên host Ubuntu 24.04+ (bwrap 0.9.0) sau khi owner nạp profile AppArmor userns cho bwrap (xem `deploy/README.md`); toàn suite 977/977, không còn test sandbox/spike bị skip. Sửa test: đếm PID bằng glob của shell vì pipeline `ls | wc` tự thêm hai process (bên trong chỉ có bwrap PID 1 và sh), và kiểm PID 1 là bwrap. Sửa kèm: `RunDir.resolve` trả đủ đường dẫn khi nhiều thành phần cuối chưa tồn tại.
- [x] T021 [P] Xây `src/application/authz.ts`, `src/application/access-tokens.ts` kiểm server-side actor/read/operate/admin/project allowlist từ token file trusted; owner token 0600 tách assistant [read,operate], không tin actor/role caller, grant/revoke qua config+restart, audit ID/hash không secret.
- [x] T022 Mở `src/config/schema-user.ts`, `src/config/normalize.ts`, `src/config/capabilities.ts`, `src/config/freeze.ts` cho projects.path/repo và runtime closed config/credential refs/isolation/manifest/limits theo CLI contract; “Giữ user/project YAML version: 1”, “Không thêm app_id; giữ nguyên schema/hash lịch sử, app-pinned GitHub bị mismatch”, “chỉ reference credential, không secret; không thay hash snapshot lịch sử”; trần số nguyên dương hữu hạn, initial≤max, segment≤spool, TERM+KILL≤drain/recheck.
- [x] T023 Mở ledger mutation tại `src/application/commands.ts` và `src/store/accept.ts`: authz/schema/allowlist/version/dedup trước I/O, ghi canonical command hash/server IDs/admission trước preflight, request giống trả kết quả cũ/payload khác conflict, restart nhận lại command; accept facts không await/I/O trong transaction.
- [x] T024 Mở `src/store/projector.ts`, `src/store/verify.ts`, `src/store/read.ts` cho tất cả runtime tables và MemorySink; replay liên task theo global_seq, giữ task seq riêng, không tạo event log thứ hai; mismatch chặn dispatch.
- [x] T025 Mở `src/store/claim.ts`, `src/store/accept.ts`, `src/engine/claim.ts` để đọc/kiểm queue và cấp slot/claim/reservation nguyên tử trong BEGIN IMMEDIATE, completion gate kiểm lại trước dispatch, operation/effect identity được commit trước spawn; unresolved claim không được nhả slot/hoàn reservation.
- [x] T026 Nối tối thiểu `src/daemon/server.ts`, `src/daemon/dispatch.ts`, `src/daemon/main.ts`, `src/cli/client.ts` và entrypoints T010 với application/store/ports T013: filesystem UDS, một writer, dispatch sau commit, inject Clock/IDs/fakes; runner không import DB writer, executor từ chối merge/legacy task thiếu runtime snapshot.

  - Kết quả T026: `cusrd --config FILE [--data-dir DIR]` mở store khóa EXCLUSIVE (daemon thứ hai nhận `store_locked`), kiểm projection lúc khởi động và chặn dispatch nếu lệch, nghe `DATA_DIR/control.sock` (dir 0700/socket 0600, body ≤1 MiB, header 5 giây). `Dispatcher` chỉ gọi handler sau khi `EffectStarted` commit với `require_runtime`, không bao giờ claim `merge`, kind chưa có handler giữ `pending`. Command có kind hợp lệ nhưng chưa có handler bị từ chối trước admission (không để lại dòng ledger); `cusr status` là lệnh client duy nhất, daemon không chạy → exit 3. ESLint cấm `src/runner`/`src/adapters` import store/daemon/SQLite. Handler nghiệp vụ add/show/confirm thuộc T047/T048.
**Checkpoint**: Shared schemas/store/runner/sandbox/authz và ports khả dụng; story chỉ thêm nghiệp vụ. Boundary T018–T021 không chờ US4/US6 mới áp dụng.

## Phase 3: User Story 1 — Giao task và nhận PR đủ bằng chứng (P1, lát A)

**Goal**: Intake → freeze → Code → Gates → Review → Publish → CI → chờ merge; merge được chứng minh → drain → DONE một lần.

**Independent Test**: Fake harness/GitHub, Clock inject, Git worktree và bare remote thật; một task tạo đúng một branch/worktree/PR, PR xanh chưa DONE, zero merge request. Kiểm riêng intake lỗi, slot/dependency, merge khi push/fixer còn chạy, head chưa chứng nhận và late result.

### Tests for User Story 1

- [x] T027 [P] [US1] Thêm property regression tại `test/property/invariants/runtime-slot.test.ts`, `test/property/invariants/external-completion.test.ts` và `test/property/invariants/required-subset.test.ts` cho selector, dependency sau DONE, completion-before-deadline/drift, terminal không mở lại, G⊆S/none-vs-unknown/app-pinned và green predicate đúng head; bao phủ FR-001.02/03, FR-040.01–15 và FR-044.01–07 bằng assertions riêng.
  - Kết quả T027: `runtime-slot.test.ts` (selector, total order, không preempt), `required-subset.test.ts` (G⊆S, none≠unknown, app-pinned) và `external-completion.test.ts`: chuỗi ngẫu nhiên merge/drain/cancel/kết quả muộn/timer trên task có hoặc không có việc dở → `TaskCompleted` tối đa một lần, DONE chỉ khi không còn gì pending, terminal không mở lại, không CANCELLED sau proof, không effect nghiệp vụ pending sau proof; dependency chỉ READY khi prerequisite DONE (kể cả khi đang drain); green predicate khớp oracle độc lập (một check success cho mỗi tên snapshot, đúng head, covered, đọc đủ, gate và review).
  - Đối chiếu 2026-10-29 (PR #8–#10): oracle green trong `external-completion.test.ts` nay sinh cả `mode` (legacy/direct-pr/full-review): direct-pr xanh không cần approve và verdict ghi `review: not_required`, full-review cần approve ghi cho đúng commit, gate phải đạt trên checkpoint của head đó, bản ghi approve kiểu cũ không làm task có mode xanh. Property completion chạy trên cả hai mode, direct-pr không bao giờ có `ReviewVerdictRecorded`.
- [x] T028 [P] [US1] Viết suite `test/integration/runtime/feature-002-flow.test.ts` với bare Git/fake harness/HTTP/Clock: baseline US1.1–6, US1.8 qua confirm mới, US1.9–10 qua facts operation/merge có provenance và dependency core, US1.11 qua initial/resumed slot facts; request dedup/conflict, PENDING không thực thi, snapshot duy nhất trước RUNNING, một slot, PR xanh/chờ merge, merge drain/dependency; ghi seed/request/effect ledger. T049 chạy baseline, T064/T078 bổ sung US1.7 và đường fixer/deadline đầy đủ; recheck và CLI explain assertions US1.8/10/11 phải được T106/T120 kiểm sau service/UI tương ứng, không bỏ scenario khỏi nghiệm thu cuối.
  - Kết quả T028: `test/integration/runtime/feature-002-flow.test.ts` chạy baseline đầu-cuối (Git thật + bare remote, fake harness/GitHub, Clock): một worktree/branch/PR, CI xanh qua evaluator, chờ merge, zero merge request, proof → drain → DONE một lần, dependency sau DONE. Các assertion còn lại của danh sách nằm ở suite riêng thay vì một file: dedup/conflict (`task-cli`, `confirm-start`), PENDING không thực thi và snapshot duy nhất trước RUNNING (`confirm-start`), một slot/initial-resumed (`scheduler`), merge khi effect còn chạy và drain (`drain`, `external-completion`). Bảng ánh xạ ở `acceptance-report.md`.
  - Đối chiếu 2026-10-29: `feature-002-flow.test.ts` chạy `describe.each` hai mode trên Git thật: xác nhận bộ lựa chọn trước start, template frozen vào context worker, checkpoint commit dùng message worker, publish đúng SHA checkpoint, PR mang title/body worker và đúng một block marker cuối body, direct-pr không gọi reviewer; nội dung có marker (kể cả ẩn bằng zero-width/entity) hoặc thiếu nội dung không tới commit/PR; H03 (B bị push lên branch trong lúc review A, probe trước publish chặn, giữ B, không PR). Engine/SQLite: `test/integration/runtime/execution-modes.test.ts`.
- [x] T029 [P] [US1] Viết contract tại `test/contract/git-worktree.test.ts`, `test/contract/publish.test.ts`, `test/contract/context-gates.test.ts`, `test/contract/github-checks.test.ts`: known/none/unknown, current run/status SHA/generation, positive gate/review+check evidence và non-success không xanh; ownership/path/ref collision, deterministic commit receipt, FF push expected SHA, PR all-state probe/422/unknown, checkpoint và frozen command, context thiếu/oversize. Bổ sung H04 bằng bare Git thật: external B chen giữa probe và push, guard expected-old từ chối update dù local vẫn giữ đúng checkpoint; không force/đổi expected-old để nhận B.
  - Kết quả T029: `test/contract/github-checks.test.ts` (known/none/unknown, generation đúng SHA, non-success không xanh), `test/contract/publish.test.ts` (FF push expected SHA, PR mọi state/422/unknown), `test/contract/gh-port.test.ts`, `test/contract/github-observe.test.ts`. Phần Git/context nằm ở suite đã có, không nhân đôi: ownership/path/ref collision và checkpoint `test/integration/runtime/git-worktree.test.ts`, commit receipt tất định `git-commit.test.ts`, frozen command/checkpoint trước ghi `gates.test.ts`, context thiếu/oversize `test/unit/adapters/context.test.ts`.
  - Đối chiếu 2026-10-29: H04 bằng bare remote thật trong `test/contract/publish.test.ts` (B chen giữa probe và push, update bị từ chối nhờ guard expected-old tại push, remote giữ B, checkpoint local nguyên); probe chỉ nhận block marker canonical cuối body đúng nội dung đã gửi (marker giả/nhân đôi/body bị sửa → conflict), nội dung worker có marker bị từ chối trước mọi call; cập nhật mô tả PR đọc trước/đọc lại sau, không ghi đè body người dùng sửa; `github-checks.test.ts` thêm green theo mode.

### Implementation for User Story 1

- [x] T030 [US1] Tạo `src/application/preflight.ts` đọc base/config từ Git objects mới nhất với ports, kiểm project realpath/common dir/remote immutable identity, workflow software_dev@1/human/roles/review/CI/budget/capability; lỗi trước RUNNING PENDING config_invalid/capability_missing, lỗi sau RUNNING WAITING/policy, không bỏ role hoặc đổi binding. Khi nối schema bổ sung ở T135: resolve project merge.method với default squash/enum merge/rebase, sai kiểu/enum/key lạ → config_invalid; 002 không kiểm method được GitHub bật như capability admission (FR-002.01–05, M02).
  - Bổ sung T030 (owner duyệt 2026-10-29): kiểm prerequisite host của Isolated trước khi cho task RUNNING và báo `capability_missing` kèm `cause` riêng: `bwrap_missing`, `userns_apparmor_restricted` (uid map bị từ chối và `kernel.apparmor_restrict_unprivileged_userns=1`, Ubuntu 23.10/24.04+), `userns_disabled` (`user.max_user_namespaces=0` hoặc `kernel.unprivileged_userns_clone=0`), `systemd_user_unavailable` (không có user bus, vd server headless chưa `loginctl enable-linger`). Mỗi cause trỏ tới mục tương ứng trong `deploy/README.md` và in lệnh sửa; không tự sudo/đổi sysctl/nạp profile, không fallback unsandboxed. Probe qua port (process/fs) để test được bằng fake; unit test cho từng cause và cho host đạt.
  - Kết quả T030: `preflight(ports, input)` trả candidate (base SHA, config đã kiểm, realpath/common dir, repo ID bất biến, `capability_refs`) hoặc `config_invalid`/`capability_missing` kèm danh sách problem (check, cause, lệnh sửa, runbook), hoặc `infra_unavailable` khi không xác lập được dữ kiện (fetch/GitHub unknown), không phán cấu hình. Thứ tự: user config → host (`checkHost`, port `HostProbePort` mới, adapter thật `src/runner/host-probe.ts`) → repo root/remote GitHub allowlist → `fetch` base rồi đọc `cusr.yaml` là blob thường của commit base (không đọc working tree) → kiểm toàn bộ cấu hình → `checkSupport` thuần (software_dev@1, quyết định human, không skip review/không cần scout, allow_roles đủ role, `ci.required_checks` không rỗng, manifest từng harness, cost cap cần `cost_reporting=reported`) → `GET repos/{repo}` lấy ID, repo đổi tên/chuyển là mismatch. Không đổi binding hay bỏ role; `preflightWait` ánh xạ trước RUNNING → PENDING/needs_info, sau RUNNING → WAITING/policy. Thêm cause `bwrap_probe_failed` (fail closed khi bwrap lỗi không khớp dấu hiệu nào đã biết). Capability `unknown` của manifest không chặn (fake harness), chỉ `unsupported` chặn. Unit `test/unit/application/preflight.test.ts`, integration Git thật `test/integration/runtime/preflight-git.test.ts` (base mới nhất trên origin, probe host thật pass). Nối vào confirm/start thuộc T031/T032.
  - Đối chiếu 2026-10-29: `checkSupport` nhận `mode` và kiểm trên graph `software_dev@2:<mode>`: direct-pr (và trước khi có đề xuất) không đòi role/manifest/binding reviewer; full-review vẫn đòi. Bỏ kiểm "review bị skip theo size" vì graph v2 không còn skip XS; mode ngoài `runtime.modes` → `config_invalid:mode`. Test `preflight.test.ts`.
  - Kết quả merge.method (2026-10-29): `merge` trong `src/config/schema-project.ts` là object closed chỉ có `method` (squash/merge/rebase), chỉ thuộc `cusr.yaml`; sai kiểu/enum/key lạ → `schema_invalid` nên preflight/start báo `config_invalid`; không kiểm method GitHub đã bật (`test/unit/config/runtime.test.ts`).
- [x] T031 [US1] Tạo `src/application/triage.ts`, `src/application/confirm.ts` nối intake/acceptance/dependency/quyền hiện có; confirm sớm chỉ candidate, chỉ request mới thử lại base/capability, không poll base, request cũ không đổi snapshot/kết quả (FR-001.01, FR-002.02/03).
  - Kết quả T031: `confirmTask` (`src/application/confirm.ts`) kiểm task thuộc đúng project của lệnh, nộp `confirm_task` (dedup theo request ID, expected_version, authz từ token) để triage lõi chạy trước; chỉ khi triage đạt (READY, hoặc PENDING vì config/capability) mới đọc base mới nhất và chạy preflight một lần, rồi ghi kết quả bằng trigger mới `config_checked` (non-human, additive): đạt → READY, lỗi → PENDING/needs_info `config_invalid`/`capability_missing` kèm problems (cause/fix/runbook), không slot/worktree/snapshot. Lỗi hạ tầng không ghi fact. Phát lại request cũ không đổi kết quả (dedup `cmd:<id>:config`, hash khác → giữ kết quả đầu); thử lại cần request mới. Helper dùng chung ở `src/application/triage.ts`. `FreezeErrorSchema` thêm biến thể `capability_missing` và `problems` tuỳ chọn cho `config_invalid` (additive). Nối `task_recheck` (FR-046.02) dùng lại `recordConfigCheck`, thuộc T102.
  - Đối chiếu 2026-10-29: `confirmTask` giữ xác nhận intake mặc định và nhận thêm `run_config_digest` để xác nhận bộ lựa chọn trong cùng một lượt; preflight của confirm dùng mode của đề xuất. Trigger `confirm_run_config` chỉ được engine nhận từ kênh owner (`token:owner`), token assistant (kể cả có operate) bị `untrusted_confirmation`.
- [x] T032 [US1] Nối `src/engine/start.ts`, `src/policy/freeze.ts`, `src/application/start.ts` chốt PolicyFrozen/context/runtime cùng accept trước RUNNING rồi worktree; “Ghi cùng PolicyFrozen/context trước RUNNING; chỉ reference credential, không secret; không thay hash snapshot lịch sử”; stale candidate/version/base conflict, không hai snapshot cùng task/revision. Snapshot thêm merge.method đã resolve từ frozen base cho task mới, config đổi không thay task đang chạy; không gán default ngược hoặc rewrite hash snapshot cũ (M02).
  - Kết quả T032: `startTask` (`src/application/start.ts`) chỉ chạy khi task READY, chưa có snapshot và đang giữ slot; chạy lại preflight (kết quả confirm chỉ là candidate), `freeze` + `freezeRuntimeContext` từ cùng một kết quả, conventions đọc từ commit base, rồi nộp một `start` với expected_version đọc trước I/O và dedup `start:<task>:r<revision>:<grant>`; task đổi giữa chừng → conflict, không snapshot. `onStart` từ chối start có runtime khi không giữ slot (`slot_not_held`) và nhả slot (`freeze_failed`) khi freeze lỗi; `capability_missing` vào nhóm lỗi chờ được thử lại. Lỗi hạ tầng lúc start nhả slot qua `release_execution`, task giữ READY; xếp hàng lại thuộc scheduler T034. Prompts/attachments qua port `StartDocsPort` (adapter thật nối ở T047/T048). Test `test/integration/runtime/confirm-start.test.ts`; hai test cũ start có runtime nay xin slot trước.
  - Đối chiếu 2026-10-29: `startTask` không start khi bộ lựa chọn chưa được xác nhận cho đúng revision/digest (trả slot, `run_config_unconfirmed`); freeze theo mode (`software_dev@2:<mode>`), kiểm bộ lựa chọn khớp binding hiệu lực (profile, worker cho mọi bước coder/fixer, reviewer khi full-review, fallback thuộc ladder), lệch → PENDING `run_config_unconfirmed`, không tự đổi binding; đọc PR template từ base (một file, hoặc `pr_template` trong cusr.yaml, nhiều mà không chọn → `config_invalid:pr_template`). Snapshot runtime thêm `run_config` (mode, selection, digest, confirmation) và `pr_template` (additive). Engine `onStart` từ chối start không có/không khớp xác nhận hoặc graph khác mode.
  - Kết quả merge.method (2026-10-29): `startTask` ghi `resolveMergeMethod(config.project)` (default squash) vào `FrozenRuntimeContext.merge_method`; trường tuỳ chọn nên snapshot cũ giữ nguyên hash, không gán ngược default (`test/integration/runtime/confirm-start.test.ts`).
- [x] T033 [US1] Tạo selector thuần `src/engine/execution-slot.ts` và nối `src/engine/decide.ts`: “Priority số lớn trước, default 0 theo SPEC §6.2; một yêu cầu đang chờ/task; grant/withdraw đóng đoạn chờ, không dùng created_at thay requested_at”, resumed trước fresh cùng priority, hòa requested_at rồi request_global_seq; “Singleton toàn daemon; một holder, có thể nhiều operation phục vụ dừng/đối chiếu cùng task”, không preempt.
  - Kết quả T033: `compareRequests`/`orderQueue`/`selectNext` thuần tại `src/engine/execution-slot.ts` là nguồn thứ tự duy nhất; `readQueue` và `grantNext` của store dùng selector (không còn ORDER BY riêng). Slot đang giữ luôn trả `busy`, không preempt. Hàng chờ một-request/task và đóng đoạn chờ khi grant/withdraw đã có từ T025.
- [x] T034 [US1] Tạo `src/daemon/scheduler.ts`, `src/application/dependency.ts`: fresh giữ READY chưa deadline, resumed WAITING/execution_slot tính deadline cũ, trả slot khi process/effect rõ dù còn CI/merge/human/cooldown; dependency chỉ sau DONE, kể cả unverified, lưu provenance để explain và kiểm lại điều kiện riêng (FR-001.02/03, FR-044.01–07).
  - Kết quả T034: engine tự chặn bước cần slot (`SLOT_EFFECTS`: prepare, attempt agent, gates/autofix, publish) của task runtime khi không giữ slot: WAITING/policy `execution_slot` kèm resume và xếp hàng `resumed`; grant resumed chạy tiếp đúng bước (RUNNING), deadline vẫn chạy. Cuối mỗi quyết định `settleSlot` rút request task không còn đủ điều kiện và trả slot khi task đã start không còn việc thuộc slot (chờ CI/merge/người/cooldown), claim chưa rõ vẫn giữ slot; dispatcher chỉ đánh dấu `holds_slot` cho các effect này. `src/daemon/scheduler.ts` mỗi lượt: gửi dependency → xếp hàng `fresh` task READY chưa start (giữ READY, chưa deadline) → cấp slot → start task fresh đang giữ slot (T032); start lỗi hạ tầng chờ `START_RETRY_MS` rồi mới xếp lại. `src/application/dependency.ts` suy thông báo từ trạng thái đã commit (không mất khi crash), chỉ khi prerequisite đã ghi DONE/FAILED/CANCELLED, kèm `provenance` (version, `unverified_reason`) trong trigger `dependency_status` (additive). `grantNext` nhận thêm ID cho bước resumed. Test `test/integration/runtime/scheduler.test.ts`. Scheduler chưa nối vào vòng lặp daemon (cần Git port thật T035, nối ở T047).
- [x] T035 [P] [US1] Tạo Git argv port tại `src/adapters/git/command.ts`: env/config allowlist, empty hooks, trusted credential helper, safe.directory cụ thể, deadline/output cap, không shell cho lệnh Git orchestrator và không tin executable/config từ repo.
  - Kết quả T035: `GitCommandRunner` (`src/adapters/git/command.ts`) cài `GitPort`: chạy git tin cậy (đường dẫn tuyệt đối) bằng argv, không shell, env dựng từ allowlist (bỏ global/system config, `GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL` mặc định `https:ssh`, `passEnv` tường minh và không nhận `GIT_*`). Config ghim bằng `-c` (ưu tiên hơn config repo): hooksPath trỏ thư mục rỗng, fsmonitor/pager/editor/askPass/sshCommand cố định, tắt ký, chặn `ext::`, reset credential helper rồi chỉ dùng helper tin cậy, `safe.directory` chỉ đường dẫn cụ thể (từ chối `*`, `/`, tương đối). Trước mỗi lệnh đọc (không thực thi) config repo; key chạy chương trình hoặc chuyển hướng remote mà `-c` không vô hiệu được (filter/diff/merge driver, insteadOf, include, proxy, credential theo URL, pager.*, …) thì trả `refused`. Subcommand theo allowlist, `config` chỉ được đọc. Deadline giết cả process group, stdout cắt theo `max_output_bytes` với cờ `truncated`. `GitResult` thêm `refused`; preflight coi `refused` là `config_invalid`. Test git thật `test/integration/runtime/git-command.test.ts` (có đối chứng hook/fsmonitor chạy khi dùng git thường) và một case preflight với runner thật.
- [x] T036 [US1] Tạo `src/adapters/git/worktree.ts`, `src/adapters/git/checkpoint.ts` cho branch cusr/task-slug, marker ngoài agent rw, checkpoint tree/parent/diff digest; “Không nhận lại theo tên path đơn thuần; SHA/tree/ownership phải đối chiếu”, mismatch/missing giữ diff/chờ, không reset/xóa repo gốc (FR-003).
  - Kết quả T036: `ensureWorktree` (`src/adapters/git/worktree.ts`) tạo branch `cusr/<task_id>-<slug>` (slug ASCII) và worktree `<worktrees_root>/<task_id>` từ base đã chốt, sau khi ghi owner marker O_EXCL + fsync trong `markers_dir` (ngoài vùng agent ghi). Nhận lại chỉ khi marker, branch, đăng ký worktree, common dir và base là tổ tiên của HEAD cùng khớp; crash sau khi ghi marker thì tạo tiếp. Branch/path có sẵn mà không có marker → `not_owned`; worktree mất → `worktree_missing`; đổi branch → `branch_mismatch`; lịch sử không chứa base → `base_not_ancestor`; Git không trả lời → `unknown`. Không xóa/reset/force gì. `takeCheckpoint` (`src/adapters/git/checkpoint.ts`) stage mọi thay đổi vào index của worktree, `write-tree`, parent = HEAD, `diff_digest` = hash của `diff-tree --raw` parent→tree; không commit. `compareCheckpoint` so theo giá trị (tree/parent/digest/common dir/marker). Test git thật `test/integration/runtime/git-worktree.test.ts`; helper `test/support/git-repo.ts`.
- [x] T037 [US1] Tạo `src/adapters/context.ts` từ acceptance/revision bất biến, frozen binding và bước hiện tại, lỗi fixer/diff reviewer; cap 128 KiB/context, 64 KiB/diff, digest/path list/truncation marker, strip secret/control syntax; thiếu acceptance/diff bắt buộc thì facts needs_context, không gọi agent (FR-005).
  - Kết quả T037: `buildRoleContext` (`src/adapters/context.ts`, hàm thuần) dựng context từ `FrozenExecutionContext` đúng revision, binding đã chốt và bước hiện tại; fixer nhận lỗi liên quan, reviewer nhận diff kèm digest và đủ danh sách path. Phần bắt buộc (header, title, acceptance, lỗi của fixer, diff của reviewer) không bị cắt; thiếu hoặc vượt ngân sách → `needs_context` (`acceptance`, `failures`, `diff`, `context_revision`, `prompt:<name>`, `context_budget`). Diff cắt ở `review_diff_bytes` (64 KiB), toàn bộ ở `context_bytes` (128 KiB); phần tuỳ chọn bị cắt có marker kept/original bytes + digest bản đầy đủ. Mọi phần qua `Redactor`, bỏ ký tự điều khiển/ANSI/bidi, dòng lệnh kênh (`/cmd`, `cusr ... approve|answer|cancel|...`) bị đánh dấu `[quoted]`. Unit `test/unit/adapters/context.test.ts`.
  - Đối chiếu 2026-10-29: context worker có mục `publish_content` (template frozen nguyên văn hoặc ghi rõ không có template, file JSON ngoài worktree để ghi commit message/PR title/body, nội dung hiện hành, cấm marker). Mọi lần sửa (fixer hoặc coder ở bước sửa CI) bắt buộc có `failures` (gate: signature + log tail; review: findings; CI: check) kèm SHA/run generation và `repair_state` dựng mới từ state đã đối chiếu (nguyên nhân, base, checkpoint, head đã publish, PR, `git status`, diff base..worktree); thiếu → `needs_context`. Reviewer full-review bắt buộc có `pr_content`. Resume thật thuộc T138; Phase 3 không có session nên mỗi lần gọi đều dựng packet mới.
- [x] T038 [US1] Tạo `src/runner/commands.ts`, `src/adapters/gates.ts` chạy snapshot setup/gate/autofix bằng /bin/sh -c trong sandbox, default 10 phút và deadline còn lại, checkpoint trước ghi, receipt + declared retry safety; unknown lệnh không-safe chờ người. Ghi tree/digest trước/sau gate; nếu formatter/gate đổi code thì kiểm lại tập gate bắt buộc trên tree cuối theo retry safety/trần hiện có, không chứng minh được thì chặn commit/publish (FR-004, M06).
  - Kết quả T038: `runCommand` (`src/runner/commands.ts`) chạy đúng command đã chốt bằng `/bin/sh -c` qua `SandboxProvider` (role setup/gate/autofix, không private home), wall = min(`command_wall_ms`, deadline còn lại); hết hạn trước khi chạy → `deadline`, plan bị từ chối → `not_launched`. Receipt gồm digest command/layout, status passed/failed/timeout/deadline/not_launched/unknown, exit code, thời điểm, output đã redact (digest, tail 4 KiB, cờ cắt) và `retry` theo `RETRY_SAFETY` khai báo: setup/gate `safe`, autofix `unsafe` (unknown thì chờ người). `SpawnExecutor` chạy plan trong process group riêng, giết cả group khi quá wall. `src/adapters/gates.ts`: `runGates`/`runSetup`/`runAutofix` checkpoint worktree trước rồi chạy theo thứ tự (setup/autofix dừng ở lỗi đầu), trả data đúng `GateDataSchema`/`setup` của `PrepareDataSchema` với signature ổn định không chứa output thô; receipt unknown → `unknown` kèm `retry_allowed`. Runner systemd (T073) sẽ thay `SpawnExecutor`. Test `test/integration/runtime/gates.test.ts`, gồm một case trong bwrap thật.
  - Đối chiếu 2026-10-29: `runGates` ghi tree trước/sau từng gate; gate/formatter đổi tree thì chạy lại cả tập trên tree mới (tối đa `GATE_TREE_PASSES` = 3, chỉ khi mọi lệnh khai báo `safe`), vẫn đổi → `stable: false`, engine chờ `gate_tree_unstable`, không commit/publish. Gate data thêm `tree`, `stable`, `log_excerpt` (đã redact).
- [x] T039 [US1] Tạo `src/adapters/git/commit.ts` lưu commit intent tree/parent/author/committer time/message/OID trước CAS ref; sau gates tạo checkpoint commit bằng message worker, trước review trong `full-review`, trước publish trong `direct-pr`. Worker no-op giữ checkpoint SHA, không tạo commit chỉ vì step chạy xong. Mọi gate bắt buộc phải cùng đạt trên tree cuối; reviewer sau đó gắn base/commit SHA này. Probe nhận lại đúng OID sau timeout, không commit thứ hai sau approval hoặc reset HEAD đoán (FR-017/018, M06).
  - Kết quả T039: `commitCheckpoint` (`src/adapters/git/commit.ts`) commit đúng tree của checkpoint (đã qua gate/review) lên branch task: kiểm branch đang ở parent, `commit-tree` với author/committer/thời gian cố định (OID tái lập được), lưu intent (tree/parent/identity/time/message/OID) bằng `FileCommitIntentStore` O_EXCL + fsync, rồi `update-ref` CAS từ parent. Ref đã ở OID → `recovered`; timeout/thua race → đọc lại ref: ở OID → `committed`, ở parent → `unknown` (gọi lại cùng key), khác → `head_changed`, không reset. Cùng key mà input khác → `intent_conflict`, không commit thứ hai. `probeCommit` chỉ đọc. `GitCommand.env` mới chỉ nhận 6 biến `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, biến khác bị `refused`. Test git thật `test/integration/runtime/git-commit.test.ts`.
  - Đối chiếu 2026-10-29: checkpoint commit nay là bước cuối của effect gates (khi mọi gate bắt buộc đạt trên một tree ổn định) với message worker đã kiểm, trước review (full-review) hoặc publish (direct-pr); tree trùng HEAD thì giữ SHA, không commit mới (`committed: false`). Reviewer không còn tự commit. Engine ghi `CheckpointRecorded` (sha/tree/base/diff digest/content digest).
- [x] T040 [P] [US1] Tạo `src/adapters/github/gh-port.ts` từ spike gh fixture: pinned binary/API 2026-03-10, argv allowlist GET/POST PR/rerun, không merge method, GH_PROMPT_DISABLED=1/pager off, timeout/bytes/pages/calls/retry cap, credential chỉ ở orchestrator, raw evidence redact/digest (FR-017/018/021).
  - Kết quả T040: `GhPort` (`src/adapters/github/gh-port.ts`) cài `GitHubPort` từ prototype spike: `gh api` bằng argv qua đường dẫn tuyệt đối, header API `2026-03-10`, env chỉ gồm biến gh cần (`GH_PROMPT_DISABLED=1`, pager/màu/update notifier tắt, token từ env orchestrator). Allowlist GET (repo, PR, list PR, merge 204, issue events, branch/protection/rules/ruleset, check-runs/statuses, workflow run) và chỉ hai POST: tạo PR, `rerun-failed-jobs`; không có merge. Query key theo allowlist. GET gửi lại tối đa `max_sends` khi timeout/5xx/429 trong cửa sổ vòng; POST gửi đúng một lần, mất câu trả lời → `unknown` (có thể đã áp dụng). Cap call/round/byte trả `unknown`, không bao giờ thành rỗng. Evidence giữ header chọn lọc, body đã redact và digest, có hook `onEvidence`. `listAll` phân trang theo số trang, `complete` chỉ khi trang cuối ngắn và không còn `rel="next"`. Contract test `test/contract/gh-port.test.ts` với fixture `test/support/gh-fixture.ts`.
  - Đối chiếu 2026-10-29: allowlist thêm đúng một ghi `PATCH repos/{r}/pulls/{n}` chỉ đổi `title`/`body` (sửa mô tả PR sau fixer, M05/M07), gửi một lần, mất câu trả lời là unknown; không mở merge/state/base.
- [x] T041 [US1] Tạo `src/adapters/git/push.ts`, `src/adapters/github/publish.ts`: repo/head/base/operation key ổn định, FF expected-old/new SHA với guard expected-old tại update remote, không chỉ probe trước push (H04), probe remote/PR mọi state trước retry kể cả 422; nhiều PR/identity mismatch/remote diverged giữ unknown/head_changed, không force hoặc PR thay thế (FR-017/018).
  - Kết quả T041: `pushBranch` (`src/adapters/git/push.ts`) đẩy tới URL remote từ runtime snapshot (không đọc remote của repo): probe `ls-remote` trước; remote đã ở SHA mới → `already_pushed`, khác SHA cũ dự kiến → `head_changed` (không ghi đè); kiểm SHA mới là con cháu SHA cũ (không thì `not_fast_forward`), rồi push với `--force-with-lease=<ref>:<old>` tường minh, không `+`/`--force`. Lỗi/timeout → probe lại: ở SHA mới → `pushed`, ở SHA cũ → `not_pushed`, khác → `head_changed`, không đọc được → `unknown`. `createOrRecoverPr` (`src/adapters/github/publish.ts`) liệt kê PR mọi state theo head/base trước khi tạo; chỉ nhận PR khi repo ID (head và base), branch, base và marker `cusr:task/revision/op` cùng khớp; một PR không marker → `not_ours`, nhiều PR → `multiple`, đã đóng/merge → `closed`, head khác SHA đã push → `head_changed`; danh sách thiếu trang → `unknown`. Sau 422/mất câu trả lời luôn probe lại trước khi kết luận; không tạo PR thay thế. Contract test `test/contract/publish.test.ts` (bare remote thật + fixture gh).
  - Đối chiếu 2026-10-29: publish đẩy đúng SHA checkpoint trong request (không lấy HEAD), trước push kiểm HEAD/branch/tree worktree vẫn là checkpoint (khác → fact `head_drift` nguồn `worktree`); guard expected-old nằm ở lệnh push (`--force-with-lease=<ref>:<old>`, remote kiểm old khi cập nhật), probe thấy remote khác → fact `head_drift` nguồn `publish_probe`, không retry. `createOrRecoverPr` dùng title/body worker, từ chối marker trong nội dung worker, chỉ thêm một block canonical cuối body, trả `body_digest`; `updatePrDescription` mới (đọc trước, PATCH, đọc lại sau; body bị sửa → `body_changed`).
- [x] T042 [US1] Tạo evaluator thuần `src/engine/required-checks.ts` và normalizer `src/adapters/github/requirements.ts`: known/none/unknown, đọc đủ classic+active rules, any-app absent/null/-1 theo pinned schema, app cụ thể luôn mismatch, G⊆S không sửa snapshot, nguồn/tên mơ hồ không gộp; “none có evidence dương đầy đủ; unknown không được chuẩn hóa thành mảng rỗng” (FR-042.01–09).
  - Kết quả T042: `RequiredEvidenceSchema` (known/none/unknown) tại `src/domain/runtime.ts`: known cần ≥1 identity ràng buộc, none không được có, unknown chỉ mang `partial` để explain. `evaluateRequired` tại `src/engine/required-checks.ts` trả covered/required_checks_mismatch/unknown, liệt kê `missing_from_snapshot`, `app_pinned` (không gộp classic/rules) và `snapshot_only`; không sửa snapshot. `normalizeRequirements` tại `src/adapters/github/requirements.ts` là hàm thuần trên response đã đọc (gọi API thuộc T040/T044); replay 7 case live S0.3 khớp kết quả prototype. Khác prototype (owner duyệt 2026-10-29): protection 200 thiếu hẳn `required_status_checks` là không bật status check, chỉ khi `url` của body đúng protection của repo/branch đích (provenance `read_no_status_checks`); rules vẫn phải đọc đủ. Hành vi này theo schema GitHub, chưa có fixture live; thêm case "protection chỉ có review" ở đợt live tiếp theo.
- [x] T043 [US1] Sau T137, tạo `src/adapters/github/checks.ts`, `src/engine/head-evidence.ts` chọn current run/status generation đúng SHA; mọi check snapshot success và gate cùng checkpoint còn hiệu lực mới xanh. `full-review` thêm reviewer approve đúng base/commit SHA và nội dung PR; `direct-pr` ghi mode không yêu cầu review, không giả approve. Neutral/skipped/pending/cancelled/missing/unknown không pass, collision policy; expected/checked head và CI budget không đổi bởi head bên ngoài (FR-019/041.06/042.08, M08).
  - Kết quả T043: `readHeadChecks` (`src/adapters/github/checks.ts`) đọc đủ check-runs và statuses của đúng SHA qua `listAll` (lỗi đọc → failure, thiếu trang → `complete=false`, không bao giờ thành rỗng); `selectCurrent` chọn generation hiện hành (check run ID lớn nhất theo tên+app, status mới nhất theo context, bỏ run của SHA khác), cùng tên từ hai nguồn/hai app → collision. Ánh xạ: chỉ `success` là đạt, neutral/skipped/stale → skipped, cancelled/pending/unknown giữ nguyên. `headVerdict` (`src/engine/head-evidence.ts`, thuần) chỉ trả `green` khi head quan sát đúng head đã kiểm, required verdict `covered`, đọc đủ, không collision, mọi check của snapshot `success`, gate cuối của revision pass và review approve còn hiệu lực cho đúng head; head khác → `head_changed` (không nhận head mới, không đổi ngân sách CI). Contract test `test/contract/github-checks.test.ts`.
  - Đối chiếu 2026-10-29: `headVerdict` theo mode: gate phải đạt trên checkpoint của head (`gate: other_tree` nếu không), full-review cần verdict cuối cho commit đó là approve (bản ghi review có input digest), direct-pr không cần review và verdict green ghi `review: not_required`; legacy giữ quy tắc cũ.
- [x] T044 [US1] Tạo `src/adapters/github/observe.ts`, `src/adapters/github/merge-proof.ts` đọc PR→rules/checks/status→PR, validate identity/completeness/head/generation và merge proof riêng với quality completeness; proof đúng target/repo/head-at-merge/merge commit theo fixture T008, thiếu proof trả unknown, không suy từ closed/missing branch/squash OID (FR-040.10/12/14, FR-041.01/03/08).
  - Kết quả T044: `observePull` (`src/adapters/github/observe.ts`) đọc PR → (merge evidence | requirements + checks của head quan sát) → PR lần hai; identity (repo ID bất biến của base, số PR, PR ID) phải khớp trước mọi thứ khác (`identity_mismatch`), PR đổi head/base/state giữa hai lần đọc → `inconsistent` (không trộn evidence hai head), merge ở lần đọc thứ hai chuyển sang nhánh merge, PR đóng chưa merge là `closed`. `readRequirements` đọc branch → protection → mọi trang rules → từng ruleset rồi gọi `normalizeRequirements` (T042); `GitHubFailure` có thêm `body` để nhận 404 "Branch not protected". `src/adapters/github/merge-proof.ts`: merge commit = `commit_id` của đúng một event `merged` trên danh sách đầy đủ (SHA 40 hex, khác head/base, `commit_url` thuộc repo, `created_at` = `merged_at`), `complete` chỉ khi thêm 204 của merge endpoint, target khớp và PR đọc lại không đổi; thiếu thì giữ fact merged với `gaps`. `toMergeProof` chỉ dựng `MergeProof` từ evidence complete đúng subject, còn lại `null` (unknown). Replay evidence live T008 (merge/squash/rebase) cho proof complete khớp manifest; 7 case live S0.3 qua `readRequirements` khớp prototype. Contract test `test/contract/github-observe.test.ts`.
- [x] T045 [US1] Tạo `src/engine/external-completion.ts`, nối `src/engine/interpreter.ts`, `src/engine/merge-guard.ts`: external_confirmation chờ merge, không giả approval/merge effect hoặc đòi head chứa base mới nhất; merge fact bền invalidate pending business/timers, lưu merged/checked head/unverified disclaimer, completion ưu tiên drift/deadline, không mở terminal. Merge thủ công khác/unknown method không cản proof/drain/DONE hoặc tự gây merged_head_unverified; method thực tế chỉ ghi khi có evidence, unknown không là proof gap. Giữ riêng checked head, head-at-merge và merge commit (FR-021, FR-040.01–03/10–15, M08).
  - Kết quả T045: `src/engine/external-completion.ts`. Task runtime (có `runtime_ref`, completion_mode cố định external_confirmation) tới merge gate (hoặc action `github.merge`) thì WAITING/approval `merge` chờ người merge trên GitHub: không ApprovalRequested, không auto approval, không effect merge, không mergeGuard đòi head chứa base mới nhất; slot đã trả. `observation_result` ghi `ExternalStateObserved` (lần đầu mở lịch quan sát theo trần mặc định 30 ngày/2.000 lượt; budget/cadence thật thuộc T059), kiểm target và subject. `external_completion` chỉ nhận khi có PR, đúng target và observation `merged` đã ghi cùng ID; ghi `ExternalCompletionObserved` một lần (cùng proof → `completion_recorded`, khác → `completion_conflict`), gắn `checked_head_sha` = head đã kiểm, tự tính `merged_head_unverified` khi head merge không phải head đã publish + review approve + CI pass; vô hiệu effect nghiệp vụ pending, huỷ mọi timer, rút request slot, rồi WAITING/policy `merge_cleanup_pending` (phát trực tiếp, vượt source drift). Task terminal không mở lại. Drain/DONE thuộc T046. Test `test/integration/runtime/external-completion.test.ts`; `gitSandbox` ghim thời gian commit để OID tất định.
  - Đối chiếu 2026-10-29: `verifiedHead` theo mode: head merge phải là head đã publish, là checkpoint của revision, không có head drift đã ghi, CI pass; full-review cần approve cho commit đó, direct-pr không cần — merge hợp lệ của direct-pr không còn bị ghi `merged_head_unverified`. Test `execution-modes.test.ts`.
  - Kết quả merge.method (2026-10-29): completion không đọc method; `mergeView` báo `observed_method: unknown` sau merge, task vẫn DONE và head đã kiểm không thành unverified vì method (`feature-002-flow.test.ts`).
- [x] T046 [US1] Tạo `src/engine/drain.ts`, `src/daemon/drain.ts`: sau merge chỉ stop/reconcile process/effect đã gửi, giữ claim khi unknown, nhận late push không proceed/retry, giữ local_remainder; “Chỉ ghi cùng TaskCompleted sau predicate drain hoàn tất”; cap 5 phút/3 vòng, TERM 10 giây/KILL verify 5 giây, paused merge_cleanup_pending có recheck, TaskCompleted/release/dependency đúng một lần (FR-040.04–09/13).
  - Kết quả T046: `src/engine/drain.ts`. Ghi proof xong thì `startDrain`: attempt agent đang chạy nhận `stop_attempt`, effect `unknown` nhận `reconcile`, `DrainStarted` (5 phút, 3 vòng theo trần mặc định runtime) trong lúc task WAITING/policy `merge_cleanup_pending` (blocker). `settleCompletion` chạy sau mỗi quyết định: chỉ khi không còn effect started/unknown và không còn operation chưa rõ mới ghi `DrainFinished` + `closeOut` (huỷ timer/effect pending, trả slot) + `TaskCompleted` đúng một lần (`external_confirmation` hoặc `external_confirmation_unverified`); không còn việc dở lúc merge thì DONE ngay trong cùng quyết định. Dependency được giải phóng qua trạng thái DONE (T034). `drain_result` tăng vòng, quá 3 vòng → `DrainPaused round_limit`, quá hạn → `deadline`, vòng khi đang paused bị bỏ qua (chờ recheck T062). Sau merge: `proceed` không chạy bước mới; kết quả effect/đối chiếu đến muộn (vd push vẫn thành công, CI đỏ) chỉ được ghi, không route/retry/requeue; cancel sau merge không thành CANCELLED mà DONE kèm `CancelRecordedLate`. `src/daemon/drain.ts`: `drainingTasks` + `drainRound` kiểm từng operation chưa rõ, unit còn chạy thì stop (TERM 10 giây/KILL verify 5 giây), báo `drain_result`; operation chỉ hết pending khi receipt về. Test `test/integration/runtime/drain.test.ts`.
- [x] T047 [US1] Sau T135–T137, nối fake harness/gates/checkpoint/review theo mode/publish/observation/drain và ingest nguyên tử vào `src/daemon/dispatch.ts`, `src/daemon/ingest.ts`; claim kiểm confirmation digest/completion/version trước effect. Fake worker session đủ cho baseline US1, chưa phụ thuộc real harness/session của T138; source-drift không dispatch bước mới, normalized facts qua engine/store, adapter không chọn task status (FR-006/010/014/026, M01/M03/M06).
  - Kết quả T047: `src/daemon/handlers.ts` (`buildHandlers`) cho prepare (worktree T036), start_agent (context T037 + harness; reviewer nhận commit của checkpoint T039 và diff base..commit, review/approve đúng SHA đó), run_gates/ci_autofix (T038), publish (từ chối worktree đổi sau commit đã review, push FF CAS T041 tới URL remote của snapshot), create_pr (T041), await_ci (`observeTask`: PR → requirements/checks T043/T044; merged thì phát `observation_result` + `external_completion` khi proof complete), stop_attempt (abort handler đang chạy qua `Dispatcher.abort`), reconcile; không có handler merge. `src/daemon/ingest.ts`: mỗi effect sinh receipt `operation_result` rồi các fact phụ rồi `effect_result`, đều qua store (claim/version/completion kiểm lại trong transaction); adapter không chọn status. `Store.readRuntimeContext` mới. Còn thiếu, ghi rõ: lệnh setup chưa có trong snapshot đã chốt nên prepare báo `setup.ran=false`; reconcile luôn `still_unknown` cho tới T090; scheduler/drain/handler chưa nối vào vòng lặp `cusrd` (cần wiring daemon thật). Test luồng `test/integration/runtime/feature-002-flow.test.ts` (Git thật + bare remote, fake harness/GitHub `test/support/fake-github.ts`): một worktree/branch/PR, CI xanh, chờ merge, không có merge request, merge proof → drain → DONE một lần, dependency được giải phóng.
  - Đối chiếu 2026-10-29: handlers theo mode: gates → checkpoint commit; reviewer đọc diff base..checkpoint cố định cùng nội dung PR, trả `input_digest`; engine chỉ nhận review khớp checkpoint và input hiện hành, dùng lại verdict khi input không đổi (`ReviewReused`, không gọi reviewer, không ghi usage), findings không đổi quay lại fixer theo cùng signature; worker phải nộp nội dung hợp lệ (file mới cho từng operation) mới được coi là `done`. Claim của task runtime cần digest đã xác nhận khớp snapshot (`run_config_unconfirmed`) và bị chặn khi có head drift (`head_changed`); fact `head_drift` vô hiệu effect nghiệp vụ pending (kể cả publish đã enqueue), kết quả đến muộn (approve A) chỉ ghi lịch sử. Worker binding ngoài bộ đã duyệt → chờ `run_config_unconfirmed`. Await CI thấy head PR khác head đã push → fact drift. Vòng lặp `cusrd` vẫn chưa chạy handler (như ghi chú cũ).
- [x] T048 [US1] Sau T135/T047, nối add/show/confirm tại `src/cli/cusr.ts`, `src/application/queries.ts`, `src/daemon/server.ts` qua UDS/application authz/dedup: giữ xác nhận intake mặc định của assistant, thêm xác nhận bộ harness/model/effort/mode trước spawn, không tin cờ tự khai. Chạy flow fake có version/request ID/PR/head; không truy cập DB trực tiếp, giao diện đầy đủ ở US6 (M01/M02).
  - Kết quả T048: `cusr add` (`--project --title --base --acceptance` … `--request-id`), `cusr show --task`, `cusr confirm --project --task --task-version` (`src/cli/tasks.ts`) gọi `/v1/command`/`/v1/query` qua UDS với token; không mở DB. Daemon: `src/application/queries.ts` (`taskAdd` dựng `CanonicalTask` với ID/requester/source key do server gán và gửi `create_task` qua ledger/dedup; `taskConfirm` dùng T031; `taskShow` ẩn task ngoài project của caller như không tồn tại), `src/daemon/task-control.ts`, `startDaemon({ control })` để dựng handler sau khi mở store; `cusrd` đăng ký bằng `src/daemon/production.ts` với git/gh/host thật, đọc lại config mỗi request (chưa có manifest từ doctor nên confirm thật báo `capability_missing`, fail-closed). Cùng request ID trả kết quả cũ, nội dung khác → conflict (exit 6); token read không thêm được task (exit 5). Test `test/integration/runtime/task-cli.test.ts`.
  - Đối chiếu 2026-10-29: `cusr add` nhận bộ lựa chọn (`--profile --mode --worker h/m/e [--reviewer h/m/e] [--fallback ...] [--reason]`), lệnh mới `cusr propose` (đề xuất lại trước start), `cusr confirm --run-config <digest>` (chỉ token owner), `cusr show` hiện `run_config` (status proposed/confirmed/stale, digest, mode, selection, người đề xuất/xác nhận, review theo mode). Không có cờ "confirmed" do caller tự khai. Test `task-cli.test.ts`.
- [x] T049 [US1] Chạy baseline T027–T029 sau T042/T043/T135–T137, không chờ T138, ghi `specs/002-task-to-green-pr/acceptance-report.md`: fake flow cả hai mode qua confirmation → gates → commit → review nếu full → publish → PR xanh/chờ merge → proof/drain/DONE; một worktree/branch/PR, dependency chỉ sau DONE, zero merge requests. Ghi M01/M03/M05/M06/M08 bằng chứng fake; session sửa bằng fake được kiểm tiếp ở T064, real resume ở T138/T139 sau US4. Không ghi US1.1–11 hoặc M01–M08 đạt toàn bộ; phần fixer/deadline ở T064/T078, CLI recheck/explain ở T106/T120 vẫn phải đạt.
  - Kết quả T049: `specs/002-task-to-green-pr/acceptance-report.md` ghi assertion đã chạy và phần còn chờ (US1.7/fixer/deadline → T064/T078; recheck/explain → T106/T120; lịch quan sát → T058–T061; wiring `cusrd`/runner systemd, setup trong snapshot, reconcile thật → các task sau).
  - Đối chiếu 2026-10-29: chạy lại baseline cho cả hai mode và cập nhật `acceptance-report.md` theo M/H; kết quả theo spec cũ không dùng làm bằng chứng cho yêu cầu mới.

**Checkpoint**: US1 có happy path xanh qua evaluator và completion an toàn với fake; scenario tích hợp vòng sửa/deadline được kiểm tiếp tại T064/T078, recheck/CLI explain tại T106/T120. Vòng sửa US2 và bằng chứng quyền/harness US4 vẫn bắt buộc trước gate A; không coi baseline là nghiệm thu toàn bộ US1.

## Phase 4: User Story 2 — Sửa gate/review/CI trong giới hạn (P1, lát A)

**Goal**: Chỉ xanh theo đúng head với gate/review/checks hợp lệ; sửa/rerun hữu hạn, quan sát độc lập deadline thực thi.

**Independent Test**: Script fake gây gate fail/review changes/CI code/infra/flaky/rate-limit/auth/refusal/invalid/unknown, rồi tiến Clock qua CI/task/observation limits; assertions không vượt lượt, không reuse evidence cũ, không gọi agent trong observation.

### Tests for User Story 2

- [x] T050 [P] [US2] Viết/mở rộng property tại `test/property/invariants/runtime-evidence.test.ts`, `test/property/invariants/required-subset.test.ts` cho gate/CI cùng checkpoint SHA, review cùng base/commit/body khi `full-review`, `direct-pr` không cần review và không giả approve; reviewer cùng vendor hợp lệ nhưng phải riêng session/chỉ đọc. Trong cùng task/revision, đầu vào không đổi và evidence còn hiệu lực thì dùng lại approve/findings, kiểm không phát start_agent reviewer; code/body/acceptance/policy thay đổi không được reuse, no-op không tạo commit, packet sửa phải mới. H01/H02: approve A đến trước/sau fact remote B không được gỡ head_changed/duyệt B hoặc dispatch publish; replay vẫn giữ blocker. G⊆S, none khác unknown, app-pinned mismatch, không union snapshot; mở rộng T027 cho permutations/races, giữ legacy merge-guard regression (FR-014/019, FR-042.01–09, M03/M06/M08).
  - Kết quả T050: `test/property/invariants/runtime-evidence.test.ts`: với chuỗi worker/reviewer ngẫu nhiên ở full-review, reviewer chạy đúng một lần cho mỗi input review khác nhau (commit + nội dung PR), input không đổi dùng lại verdict không gọi reviewer, publish đẩy đúng checkpoint mà approve cuối gắn vào; head drift chèn ở vị trí ngẫu nhiên chặn mọi effect nghiệp vụ, kể cả publish đã enqueue (H01/H02). `required-subset.test.ts` thêm property hoán vị (thứ tự GitHub/snapshot không đổi verdict). Regression merge-guard giữ nguyên.
- [x] T051 [P] [US2] Viết `test/contract/github-observation.test.ts` với fake HTTP/gh port: classic+active/inherited rules/enforcement/pagination, 401/403/404/5xx/timeouts, app identity/collision, PR read-before/after race, rerun pending che success cũ và all check non-success states; H03 remote B được probe thấy trước publish dù chưa có poll mới, H06 chỉ base tip đổi không thu hồi review theo frozen base (FR-041.01–08, FR-042.01–09).
  - Kết quả T051: `test/contract/github-observation.test.ts` qua `GhPort` thật với fixture `gh api`: none là bằng chứng dương, rerun pending che success cũ, 401/403/404/5xx/timeout khi đọc PR → unknown, rules 403 → requirement unknown (không none), head đổi giữa hai lần đọc → inconsistent, identity khác → từ chối, PR đóng, collision hai app; rerun POST một lần mỗi run, mất trả lời → unknown và không gửi tiếp, 4xx → failed, check ngoài Actions/đã pass/run của head khác không rerun. H03 Git thật có từ Phase 3; H06 ở `feature-002-fixes.test.ts` (engine).
- [x] T052 [P] [US2] Viết `test/property/invariants/runtime-limits.test.ts` và `test/integration/runtime/observation-limits.test.ts`: deadline/count/backoff/generation/restart/recheck, CI pass muộn, PR closed/reopen/head/base change, observation sau task deadline và drain không bị giới hạn khác chặn (FR-043.01–13).
  - Kết quả T052: property `runtime-limits.test.ts` (cadence trong [initial, max] và không giảm; cửa sổ cố định từ lượt đầu, số lượt ≤ trần, lịch kế không vượt hạn, recheck/lượt generation cũ không tính, hết hạn là cuối, replay khớp) và `test/integration/runtime/observation-limits.test.ts` (service daemon: lượt đến hạn, không chạy khi CI wait đang poll, gộp lượt đọc, hết hạn không I/O kể cả sau restart, merge/terminal dừng lịch, lượt bị chặn theo thời gian vòng).
- [x] T053 [P] [US2] Viết `test/integration/runtime/feature-002-fixes.test.ts` cho US2.1–11 và SC-003, thêm US1.7/US1.9/US1.11 với đường sửa/deadline thực; recheck gọi service T062 trực tiếp, approval dùng scoped engine facts (application approval/admin-denial kiểm ở T096/T107), ledger repair/resume/rerun/approval/reservations, policy invalid-output/timeout/infra caps, auth/refusal không né quyền, head cũ không làm xanh head mới. Kiểm H01–H03: review A đang chạy, B chen, callback/observation hai thứ tự, pending publish bị chặn hoặc probe chặn trước gửi, late result/receipt không mở lại publish hay duyệt B; H05 replay/SQLite phần A, không chờ crash suite B.
  - Kết quả T053: `test/integration/runtime/feature-002-fixes.test.ts` (28 test) cho US2.1–11, SC-003, US1.7/US1.9, auth/refusal, recheck service (operate, dedup, observation, drain sau deadline, terminal chỉ ghi log) và ranh giới source drift; facts được nộp như handler/service daemon nộp.

### Implementation for User Story 2

- [x] T054 [US2] Mở evidence invalidation tại `src/engine/effects.ts`, `src/engine/context.ts`, `src/engine/evolve.ts`: code/tree/head/revision thay đổi vô hiệu gate/review/CI liên quan; `full-review` dùng reviewer session riêng, chỉ đọc, có thể cùng vendor/model, approval gắn base/commit SHA. Không vô hiệu evidence chỉ vì worker chạy: so tree/diff/body cuối với checkpoint. Trước reviewer, kiểm toàn bộ đầu vào review (task/revision, base/checkpoint/diff, title/body, acceptance/conventions frozen, policy/binding); dùng lại approve/findings còn hiệu lực nếu khớp, ghi provenance reuse, không ghi agent run giả; receipt unknown thì reconcile. `direct-pr` không giả approve; thiếu binding hợp lệ chờ người (FR-014, M03/M06/M08).
  - Kết quả T054: phần lớn đã có từ lõi 001 + Phase 3 (vô hiệu evidence theo revision, review gắn checkpoint + input digest, `ReviewReused`); Phase 4 kiểm bằng property T050 và US2.2/US2.3, không cần sửa engine thêm.
- [x] T055 [US2] Nối gate fail/review changes vào `src/engine/interpreter.ts`, `src/adapters/context.ts`: worker sửa nhận log/findings/acceptance đúng revision có cap; sửa → gates trên tree cuối → commit mới chỉ khi code đổi → xét review ở `full-review` → publish đúng SHA. Đầu vào review không đổi thì dùng lại approve; nếu findings vẫn nguyên và worker no-op thì xử lý failure signature/budget, không gọi reviewer hỏi lại. `direct-pr` sau gates/commit đi thẳng publish. Ưu tiên resume session worker cũ qua session port giả trong US2, cả resume lẫn fallback phải có packet nguyên nhân/log/findings và trạng thái checkpoint/worktree/diff/PR/Q&A mới nhất, thiếu/stale không spawn; fallback thêm lý do, cập nhật nội dung PR khi cần; giữ PR/worktree hiện có. Real harness/session nối ở T138, không là prerequisite của T064 (FR-004/005/014/020, M04/M05/M06).
  - Kết quả T055: engine chọn `resume` cho lượt sửa của worker (attempt worker cuối cùng của revision có `session_ref`, cùng binding; `fresh_session` thì không) và ghi `resume_reason`; handler chỉ truyền session khi manifest harness có `resume: proven`, không thì phiên mới kèm `resume_fallback`; packet sửa luôn dựng đủ. `AttemptFinished` thêm `session_ref` (additive). `FakeHarness` nhận `{ resume: 'proven' }` làm session port giả. Sau sửa, bước PR cập nhật title/body của chính PR khi nội dung worker đổi (`create_pr` với `update: true` → `updatePrDescription`), giữ marker; body bị sửa trên GitHub → chờ người. Real harness ở T138.
- [x] T056 [US2] Nối facts runner/harness với `src/engine/classify.ts`, `src/engine/failure.ts`, `src/engine/budget.ts`, `src/engine/escalation.ts`: infra≤3 retry, timeout/stall≤1 retry, invalid≤1 repair+1 session mới/nấc, auth/refusal chờ, unknown probe; rate-limit/infra không nâng model, total wall/attempt cap ưu tiên, repair/resume/rate-limited call đã chạy đều tiêu lượt (FR-010/015).
  - Kết quả T056: bảng giới hạn theo lớp lỗi đã có ở lõi 001 (`failure.ts`/`escalation.ts`); handler ánh xạ lỗi harness sang lớp (Phase 3). Phase 4 kiểm lại bằng SC-003 (invalid output repair + phiên mới, rate limit tính lượt, không nâng nấc) và auth/refusal chờ người.
- [x] T057 [US2] Tạo `src/adapters/github/rerun.ts` và nối CI fix tại `src/engine/interpreter.ts`: worker sửa bằng session port fake với packet nguyên nhân/CI SHA/run generation và trạng thái mới nhất → gates tree cuối → commit nếu code đổi → review nếu `full-review` và chưa có evidence hợp lệ cho đúng đầu vào → push đúng SHA/cập nhật cùng PR và description khi cần; `direct-pr` bỏ review tường minh. Infra/flaky rerun chỉ có phân loại+policy/budget+run generation cụ thể; POST unknown không gửi lại khi chưa chứng minh chưa xảy ra. Real resume kiểm ở T138 (FR-018/020, M04/M05/M06).
  - Kết quả T057: `src/adapters/github/rerun.ts` (check thất bại → workflow run qua `details_url`, đọc lại run để xác nhận đúng head/attempt, POST `rerun-failed-jobs` một lần mỗi run, mất trả lời → unknown) và handler `rerun_ci`. Vòng sửa CI bằng worker đi qua gates → checkpoint → review (full-review) → push FF → cùng PR (mô tả cập nhật khi cần), kiểm bằng flow Git thật.
- [x] T058 [US2] Tạo `src/engine/observation.ts` cho head_changed/target_mismatch/required_checks_mismatch/pr_closed/reopen/read unknown: thu hồi xanh đúng nguyên nhân, không PR thay thế/chấp nhận head mới/rebase, base tip đơn lẻ chỉ ghi thông tin; target branch khác snapshot→WAITING/policy target_mismatch, read unknown→WAITING/infra, preserve blockers và freshness. H01–H03: giữ fact expected/observed head với provenance, chặn claim/dispatch publish pending; late review A hoặc receipt chỉ ghi đúng operation/lịch sử A, không gỡ blocker/đổi expected head/route business. Chỉ đối chiếu/lối ra FR-029 được giải quyết blocker; H06 base tip đổi không kích hoạt nhánh này (FR-041.01–08).
  - Kết quả T058: `src/engine/observation.ts`: PR đóng → WAITING/policy `pr_closed` (và `proceed` không chạy việc nghiệp vụ khi PR đang đóng), mở lại → đối chiếu CI lại trong giới hạn thực thi; đọc lỗi → WAITING/infra `observation_unknown` giữ lần quan sát cuối, lượt đọc được tiếp theo khôi phục; PR xanh mà check pending/fail hoặc yêu cầu GitHub không còn được bao phủ → thu hồi xanh qua xử lý CI; `required_checks_mismatch` từ dữ liệu `await_ci` (trường `required` additive). Head đổi vẫn là fact `head_drift` riêng; base tip đổi không làm gì. Mã chi tiết mới: `pr_closed`, `observation_unknown`.
- [x] T059 [US2] Thêm observation budget vào `src/engine/observation.ts`, `src/engine/backoff.ts`, `src/store/timers.ts`: 30 ngày từ PR nhận diện đầu/2.000 lượt, poll 60 giây×2 tới 1 giờ, remote đổi chỉ reset cadence; generation chống chain trùng, exhausted hủy timer, terminal/merge dừng poll, restart/recheck không reset (FR-043.01–07/12/13).
  - Kết quả T059: cửa sổ mở ở lượt quan sát đầu theo giới hạn snapshot (`run.limits`), lượt tự động phải mang generation hiện hành rồi tăng; cadence 60 giây×2 tới 1 giờ, digest remote đổi chỉ reset cadence; chạm trần lượt/hạn → `ObservationExpired` + WAITING/policy `observation_expired`; trigger `observation_due` hết hạn mà không cần I/O. Recheck không tính lượt, không dời lịch. Lịch không có timer riêng: service đọc `next_due_at`.
- [x] T060 [US2] Mở `src/engine/budget.ts`, `src/engine/claim.ts`, `src/engine/waits.ts` cho CI per-head 1 giờ/60 poll hoặc frozen step timeout, task deadline chỉ từ lần chạy đầu và tiếp tục khi xin lại slot; exhausted không mở agent/rerun dù CI pass muộn, observation còn hạn tiếp tục, stop/reconcile sau merge có hạn riêng (FR-043.08–11/13).
  - Kết quả T060: ngân sách CI theo head (`run.ci_wait`: lượt đầu và số lượt, không reset khi recheck/rerun/vào lại bước) = timeout bước (mặc định 1 giờ) và tối đa `ci_max_polls_per_head`; hết → WAITING/ci `ci_wait_exhausted`, không sửa/rerun/gia hạn; CI pass muộn chỉ ghi bằng chứng. Deadline task giữ ngữ nghĩa lõi (mã chi tiết `deadline`); quan sát vẫn chạy sau deadline.
- [x] T061 [US2] Tạo `src/daemon/observation.ts` coalesce timer/recheck/recovery/cancel cùng PR/generation, 60 giây/100 calls mỗi round, ≤20 trang×100 records/list, ≤2 MiB/response, ≤3 sends/request chờ 1/2 giây; Retry-After vượt cap trả unknown/hẹn sau trong hạn, 304 chỉ reuse cache provenance đầy đủ; không giữ slot hoặc gọi agent (FR-043.01–06).
  - Kết quả T061: `src/daemon/observation.ts`: `observationDue`/`dueTasks`/`observationRound` chọn task đến hạn, bỏ qua task có CI wait đang poll hoặc PR đã merge vào branch khác, gửi `observation_due` khi quá hạn/trần, giới hạn thời gian vòng và số task; `ObservationCoordinator` gộp lượt đọc cùng task (timer/recheck). Trần request/trang/byte/lần gửi và Retry-After nằm ở `GhPort` (T040). Chưa làm cache 304; chưa nối vào vòng lặp `cusrd` (cùng tình trạng scheduler/drain).
- [x] T062 [US2] Tạo service recheck dùng chung tại `src/application/recheck.ts`, nối `src/engine/decide.ts`, `src/daemon/observation.ts`, `src/daemon/drain.ts` sau T030/T031/T032/T046/T059/T060/T061 và command ledger T023: operate/project/version/request dedup, PENDING chỉ triage/preflight base mới qua điều kiện cũ, PR một lượt observe, merge_cleanup một lượt stop/probe≤60 giây kể cả hết hạn; coalesce cùng observation, giữ timer/budgets, expired không bật poll và terminal không business effect. Không agent/merge/nhận head mới/reset hạn; T052/T053 kiểm trực tiếp service và fake ports trước T064, T096 tái sử dụng trước T105. Service chỉ enqueue fact/control effect, resume công việc do scheduler xét riêng; UI/route CLI recheck để T110 (FR-046.01–08).
  - Kết quả T062: engine `recheck` (`src/engine/recheck.ts`, cần operate, kiểm mục tiêu hợp trạng thái, ghi `RecheckRequested`; recheck drain mở lại một vòng khi drain đang dừng) và service `src/application/recheck.ts` chọn mục tiêu từ state đã commit: config → preflight như confirm, PR → một lượt quan sát nguồn `recheck`, drain → một vòng; cùng request ID trả kết quả cũ, không đọc lại; task terminal chỉ ghi log. Không gọi agent/merge, không reset hạn. Route CLI ở T110.
- [x] T063 [US2] Nối runtime boundary vào `src/engine/revision.ts`, `src/daemon/dispatch.ts`: source drift ghi ngay, attempt hiện tại hoàn tất, bước kế tiếp chặn tại boundary; revision không reset lượt/nấc/deadline hoặc reuse evidence cũ, không thêm kênh intake mới (FR-026).
  - Kết quả T063: task runtime giữ ngữ nghĩa drift của lõi (ghi ngay, attempt chạy xong, bước kế chặn ở ranh giới); vì snapshot runtime và bộ lựa chọn chỉ chốt cho một revision và feature 002 không có kênh chốt lại, `drift_choice(apply_new)` cho task runtime bị từ chối (`runtime_revision_unsupported`), lối ra là `continue_old`, `new_task` hoặc cancel. Lượt/nấc/deadline không đổi.
- [x] T064 [US2] Chạy T050–T053 sau T062, không chờ US4/T138; bổ sung US1.7/9/11 vào `test/integration/runtime/feature-002-flow.test.ts`, ghi US2.1–11/FR-041–043/SC-003/010 trong acceptance-report. Dùng fake session port kiểm quyết định resume/fallback, hai mode, gates → commit → review nếu full → publish cùng PR; không lấy fake làm bằng chứng harness resume thật. Giữ assertions G⊆S, none/unknown, head/base/rerun/expiry/late merge; T139 kiểm lại M01–M08 sau real adapter US4.
  - Kết quả T064: chạy T050–T053 và thêm “repair flow” vào `feature-002-flow.test.ts` (Git thật, hai mode × resume proven/không): CI đỏ trên head đầu → sửa cùng worktree → commit mới FF → cùng PR được cập nhật title/body → xanh trên head mới → merge verified. Bảng US2.1–11/FR-041–043/SC-003/010 ở `acceptance-report.md`.

**Checkpoint**: Vòng sửa, observation và service recheck đạt với fake/I/O fixture qua T062; chưa yêu cầu CLI recheck T110. US1.7 và đường fixer/deadline US1.9/11 đã được kiểm bổ sung, chưa mở B hoặc C.

## Phase 5: User Story 4 — Agent đúng quyền và bằng chứng (P1, lát A)

**Goal**: Hoàn thiện hai adapter thật trên proof lát 0, validation/provenance, quyền, progress và artifact/usage. Luồng xuyên suốt thật vẫn đợi lát C.

**Independent Test**: Cùng contract corpus cho fake/Claude/Codex từ fixture redact thật T007; real OS boundary tests cho ba role, invalid/truncated/stale result, canary secret, silent progress, process timeout và unsupported capability. Không gọi model để chạy default tests.

### Tests for User Story 4

- [x] T065 [P] [US4] Viết `test/contract/sandbox-permissions.test.ts` kiểm reviewer ro, coder vùng rw, Git metadata ro, host/admin/operate/GitHub/socket/proc denial, selected auth chỉ agent và không push; kiểm native/fallback proof/settings hash/permission rule độc lập outer theo T006 (FR-013/032/033).
  - Kết quả T065: `test/contract/sandbox-permissions.test.ts`: mount từng role (reviewer ro, coder/fixer/setup/gate/autofix rw worktree, `.git`/common dir ro, scratch rw, private home chỉ cho agent), `--unshare-pid`/`--cap-drop ALL`/`--new-session`/`--clearenv`, không mount host home/gh/ssh/auth của owner/DB/socket/token/docker/`/proc` của host, env GH/GitHub/SSH/DBUS/XDG/CUSR admin/API key bị từ chối, agent không có đường push; fresh home chỉ nhận auth đã chọn; canary vùng ghi (`snapshotWriteZone`); phía proof: native passed, denial do vendor ghi (claude_event/codex_stderr), settings hash pinned của Claude bằng đúng hash manifest T007, external_verified chỉ đổi công tắc inner, manifest giả external_verified và hard USD cap bị từ chối. Chạy bwrap thật ở `sandbox-bwrap.test.ts`/`harness-bwrap.test.ts` (skip khi host không có bwrap).
- [x] T066 [P] [US4] Viết shared suite `test/contract/harness.test.ts` và fixture T007 cho coder/fixer/reviewer × hai vendor: argv/model/effort/schema/auth/session, structured final, invalid/truncated/semantic/stale/fallback provenance, usage missing/refusal/auth/rate-limit (FR-011/012/016).
  - Kết quả T066: `test/contract/harness.test.ts` + `test/support/harness-fixtures.ts`: argv/settings/schema của sáu run T007 (claude/codex × coder/fixer/reviewer) khớp archive; model/effort chỉ từ binding; reviewer Claude không Edit/Write; phát lại record thật qua adapter + validator ra đúng giá trị spike đã chấp nhận, usage reported (Claude có cost, Codex chỉ token), session ref, provenance của orchestrator; fake harness cùng hợp đồng (usage unavailable). Âm: sai schema/semantic, stream cắt, file stale/cũ/không JSON, thiếu file Codex không fallback sang agent message, exit≠0/timeout/stalled/cancelled/backpressure/signaled, >1 MiB, model khác binding, usage thiếu → unavailable, exit của launch khác → lỗi provenance; refusal/auth/rate-limit (synthetic) giữ usage và reset time.
- [x] T067 [P] [US4] Viết `test/contract/runner-lifecycle.test.ts`, `test/contract/artifacts.test.ts` cho silent CPU/child/file progress, stall/timeout TERM/KILL, PID reuse/boot/sleep/UTC jump, secret trước persistence, traversal/symlink/oversize, retention chỉ terminal+ACK (FR-008/009/016/030).
  - Kết quả T067: `test/contract/runner-lifecycle.test.ts` (process thật, không systemd): CPU im lặng, CPU của process con, file đổi trong thư mục watch đều là tiến triển; cây im lặng thật → stalled, TERM và cây rỗng đã xác minh; wall timeout TERM rồi KILL với process bỏ qua TERM trong hạn; descendant `setsid` bị dừng sau khi leader thoát; deadline bền đã qua → không spawn; UTC nhảy tới kết thúc sớm, nhảy lùi không gia hạn; marker cũ không spawn lại (cả qua `cusr-runner exec` thật); stop signal → cancelled; stdin prompt, record JSON, dòng quá cap được đếm; canary secret không vào file nào; PID reuse/khác boot không là cùng process. `test/contract/artifacts.test.ts`: redact trước lưu, symlink/oversize/traversal bị từ chối, retention chỉ terminal+finalized+ACK digest+30 ngày, giữ tombstone, worktree chưa bảo toàn không xóa.

### Implementation for User Story 4

- [x] T068 [P] [US4] Tạo `src/adapters/harness/claude.ts` build argv/settings và parse output theo pinned manifest/fixtures T007, private home chỉ selected auth/settings, disable hook/plugin/MCP không cấp; permission/approval không đổi, sandbox mode theo trusted proof, không hardcode model hoặc dùng dangerously/bypass (FR-011/012/033).
  - Kết quả T068: `src/adapters/harness/claude.ts` (+ `vendor.ts` dùng chung): argv đúng dạng pinned 2.1.306 (stream-json, schema inline bỏ `$schema`, `--setting-sources ''`, `--safe-mode`, MCP rỗng, `--no-session-persistence` hoặc `--resume` khi có session), settings từ pin giữ nguyên permission, chỉ đổi `sandbox.enabled` theo mode của manifest, từ chối mode tự duyệt/bypass/`allowUnsandboxedCommands`; đọc denial (event + result), rate limit (resetsAt), refusal, lỗi auth/vendor, usage/cost, session, model báo cáo, final `structured_output` của record cuối.
- [x] T069 [P] [US4] Tạo `src/adapters/harness/codex.ts` cho exec --json/output-schema/output-last-message/sandbox và session theo manifest T007; pin cwd/model/effort/effective permissions/private home, validate structured final, không fallback nguồn/path/session hoặc quyền ngoài manifest; lưu stderr để ghi denial vì `--json` không phát event cho lệnh bị rule hoặc sandbox chặn (evidence T006/T007) (FR-011/012/033).
  - Kết quả T069: `src/adapters/harness/codex.ts`: `exec --json --output-schema --output-last-message`, tắt apps/plugins/MCP install, `approval_policy="never"`, `--ignore-user-config --ephemeral -C <worktree>`, workspace-write+scratch cho coder/fixer, read-only cho reviewer, `danger-full-access` chỉ ở external_verified; settings hash không phụ thuộc role; usage = tổng `turn.completed` (không cost); denial chỉ từ dòng `Rejected` trên stderr; không có dạng resume pinned nên session bị từ chối (`resume_unsupported`), harness báo `resume: unsupported` để handler fallback có lý do.
- [x] T070 [US4] Tạo `src/application/capabilities.ts` verify CapabilityManifest và nối preflight/mỗi attempt: “Help khác fixture thực nghiệm; mode external_verified chỉ sau outer/permission proof và owner cho phép; hash/version/layout đổi chặn trước attempt mới”; pin native result/outer proof/permission/settings/environment/schema/auth/cost/resume support, unsupported hard USD cap là capability_missing, không thay bằng estimate (FR-011/033).
  - Kết quả T070: `src/application/capabilities.ts`: `verifyManifest` (toàn vẹn hash, realpath/version/digest binary, settings/environment/host policy hash, schema role hiện hành, structured_output/permission/private home phải proven, external_verified cần native failed + hai proof + owner cho phép, `hard_cap` luôn capability_missing, cost reported khi cần), `observeHarness` (digest binary trên đĩa so với pin), `manifestFromEvidence` (chỉ từ fixture: proven cần evidence, còn lại unknown). Kiểm trước mỗi attempt trong `RunnerHarness`; preflight vẫn dùng kiểm tra riêng của T030 vì chưa có doctor ghi manifest (production chưa có manifest → capability_missing).
- [x] T071 [US4] Nối role/binding/permissions/approval/policy hash/slot/budget/manifest vào `src/runner/invocation.ts`, `src/daemon/dispatch.ts` trước spawn; commit reservation và chỉ chuyển used khi chứng minh đã gọi, không trả reservation khi launch unknown, agent không đổi model/vendor/mode giữa attempt (FR-010/016).
  - Kết quả T071: handler `start_agent` so manifest hiện hành với `capability_refs` đã chốt lúc xác nhận (khác → auth_config, `invoked: false`, giữ chỗ được trả, không launch), truyền workspace (worktree + git dirs) cho harness sandbox, giữ `invoked`/`usage`/`reset_at` trên failure; launch/kết thúc không chứng minh được (`InvocationUnknown`) → effect unknown, giữ chỗ không trả. Model báo cáo khác binding → invalid_output; không đổi vendor/mode giữa attempt. Flow daemon hai mode với adapter thật: `test/integration/runtime/feature-002-real-adapters.test.ts`.
- [x] T072 [US4] Hoàn thiện `src/runner/sandbox.ts`, `src/runner/private-home.ts` với executable/settings/layout pinned, no-new-privileges/cap drop/PID namespace và canary proof; so vùng ghi/checkpoint, vi phạm dừng/reconcile, không gán user dirty diff cho agent; lỗi boundary chặn runtime, không tự downgrade (FR-013/032/033).
  - Kết quả một phần T072: binary pinned (realpath + sha256) kiểm mỗi attempt, settings hash/inner mode/layout digest ghi trong provenance, home phải rỗng trước khi cài auth (`assertFreshHome`), canary vùng ghi (`snapshotWriteZone`/`writeZoneViolations`: reviewer sửa worktree hoặc bất kỳ run nào sửa git metadata → `boundary_violation`, chờ người), lỗi plan sandbox chặn attempt, không chạy ngoài sandbox hay hạ mode. Còn lại: chưa đối chiếu worktree với trạng thái đã biết trước mỗi attempt worker để không gán thay đổi dirty của người dùng cho agent; layout digest chưa được pin trong manifest; bằng chứng bwrap thật của RunnerHarness (`harness-bwrap.test.ts`) đã chạy pass trên host Ubuntu 24.04 (xem T077).
  - Cập nhật 2026-10-29 (layout pin): `SandboxLaunchPlan.layout_shape` là layout bỏ đường dẫn riêng của attempt (cờ namespace, bảng mount theo thứ tự, mount của attempt theo mục đích, tên env, network, launcher); manifest pin `layout_shapes` theo role (`probeLayoutShapes`, cùng toolchain/env của attempt qua `attemptLayoutInputs`), `verifyLayout` chặn trước launch nếu khác → `capability_missing`.
  - Cập nhật 2026-10-29 (worktree ngoài task): state ghi `run.worktree_tree`, là tree task để lại sau prepare, sau mỗi attempt worker (kể cả attempt lỗi) và sau gate ổn định khớp checkpoint. Trước attempt worker, handler chụp worktree; khác tree đó thì không gọi agent và task chờ `worktree_changed` (known/observed). `task recheck` (target `worktree`) ghi `WorktreeChangeAccepted` (thay đổi của người dùng) rồi chạy lại bước, theo quyết định của chủ dự án ngày 2026-10-29. Có test engine và flow Git thật. Hai phần "Còn lại" ở trên (đối chiếu worktree, pin layout) đã xong; T072 hoàn tất.
- [x] T073 [US4] Hoàn thiện `src/runner/lifecycle.ts`, `src/runner/progress.ts`: liveness khác progress qua CPU/process tree/output/file changes, wall monotonic+UTC bền, TERM 10 giây/KILL+verify≤5 giây đúng operation cgroup; không nhận process theo PID/env marker đơn lẻ, sleep/restart/clock jump không gia hạn (FR-007/009).
  - Kết quả T073: `src/runner/lifecycle.ts` (`execOperation`, entrypoint `cusr-runner exec`) và `src/runner/progress.ts`: marker một lần, không chạy quá deadline bền, pid.json theo boot/start ticks, records redact qua event log, tiến triển = CPU cây process/số process/output/file, ngân sách = min(monotonic, UTC), TERM `term_grace_ms` → KILL → xác minh ≤ `kill_verify_ms`, chỉ signal nhóm/descendant khớp start ticks và cgroup khi đúng unit của operation; exit.json nguyên tử với outcome/termination/progress.
- [x] T074 [US4] Hoàn thiện `src/runner/redact.ts`, `src/runner/artifacts.ts`, `src/daemon/retention.ts` cho binding/version/time/outcome, usage reported/estimated/unavailable không ghi 0, cap log/context, artifact digest/finalized/acked; retention 30 ngày chỉ terminal+ACK giữ tombstone và local remainder/worktree chưa bảo toàn (FR-016).
  - Kết quả T074: `src/runner/artifacts.ts` (index artifact: file thường trong run dir, không symlink/traversal, trong cap, digest, finalized theo exit.json, acked=false) và `src/daemon/retention.ts` (`planRetention`, `tombstoneRun`, `taskRunEntries`, `sweepRetention`: chỉ terminal + finalized + store đã commit đúng digest + quá 30 ngày; tombstone giữ digest; worktree chưa bảo toàn giữ lại). Kết quả agent kèm `ingest_record` (cursor, số record, artifact) commit cùng kết quả — đó là ACK. Usage thiếu là unavailable. Chưa lên lịch sweep trong vòng lặp `cusrd` (cùng tình trạng handler production).
- [x] T075 [US4] Tạo `src/adapters/harness/validate-result.ts` và nối `src/daemon/ingest.ts`: closed schema+semantic+operation/attempt/revision/binding/context/schema provenance, current finalized source, cap 1 MiB, không tin ID/path agent; partial final/stale artifact/exit=0 không đủ, fallback chỉ manifest khai báo và file mới riêng operation (FR-008/012/030).
  - Kết quả T075: `src/adapters/harness/validate-result.ts`: thứ tự lớp process → vendor → nguồn khai báo (stream record hoặc file mới của operation qua `readFreshFile`: không symlink, không có trước launch, mtime ≥ launch, ≤ 1 MiB) → cap → model → schema đóng + semantic; provenance (operation/attempt/revision/binding/context/schema/wire digest/nonce/binary) từ orchestrator; không fallback nguồn/đường dẫn/session. `RunnerHarness` ghi `out/result.json` kèm manifest/inner mode/settings/layout.
- [x] T076 [US4] Hoàn thiện `src/adapters/context.ts` và reviewer input trong `src/runner/invocation.ts`: bất biến acceptance/provenance, role data/log/diff bounded và marker cắt; thiếu bắt buộc→needs_context/chờ, secret/control syntax strip trước file/prompt; reviewer session riêng đọc diff base/commit cố định và nội dung PR, không ràng buộc vendor (FR-005/014/016, M03/M05/M06).
  - Kết quả T076: context builder giữ các bất biến Phase 3 (acceptance bắt buộc, cắt có marker, redact + bỏ control trước khi đếm); thêm: worker sandbox ghi nội dung commit/PR vào scratch của chính run (`agent_paths`), harness chỉ sao chép file mới/thường/≤ cap, đã redact (kể cả giá trị auth), không ghi đè; reviewer không bao giờ resume session; reviewer đọc diff base..checkpoint cố định và nội dung PR như cũ, cùng hoặc khác vendor.
- [x] T077 [US4] Sau T138, chạy T065–T067 và session resume integration cho adapter fixture/OS thực, ghi matrix US4.1–6 tại `specs/002-task-to-green-pr/acceptance-report.md`; kiểm zero canary secret, denied reviewer writes, six role/vendor fixtures, missing usage=unavailable, resume worker hợp lệ và fallback có lý do. Không dùng fixture replay để chứng nhận smoke xuyên suốt thật; hoàn tất T077/T064 rồi mới T139 (M04).
  - Kết quả một phần T077: đã chạy T065–T067, `harness-invocation.test.ts` và flow daemon `feature-002-real-adapters.test.ts` (hai mode) trên container không có bwrap/systemd user: matrix US4.1–6 ở `acceptance-report.md`. Còn lại: chạy `sandbox-bwrap.test.ts`, `harness-bwrap.test.ts`, `supervisor-systemd.test.ts` trên host triển khai (WSL2 có bwrap/systemd) để có bằng chứng OS thật; resume worker thật vẫn chưa được chứng minh (manifest T007 `session_resume: unknown`), nên mọi lượt sửa thật đi phiên mới có lý do.
  - Cập nhật 2026-10-29: ba suite OS thật (`sandbox-bwrap`, `harness-bwrap`, `supervisor-systemd`) đã chạy
    6/6 pass trên host triển khai Ubuntu 24.04.5 (bwrap 0.9.0, systemd 255) tại `main` `c1a8b9e`; ghi ở
    `acceptance-report.md`.
  - Đóng T077 2026-10-29 theo quyết định chủ dự án: giữ `session_resume: unknown`, không chạy proof resume
    trả phí. Lý do: kiến trúc hiện tại chưa thể resume Claude thật — coder chạy `--no-session-persistence`
    và mỗi attempt có private home mới, rỗng, nên `--resume <id>` không tìm thấy phiên. Phần T077 kiểm
    được là fallback có lý do: mọi lượt sửa thật đi phiên mới với `resume_unknown` (Codex
    `resume_unsupported`), reviewer không resume, packet sửa luôn dựng mới (`harness-invocation.test.ts`,
    `feature-002-real-adapters.test.ts`). Resume thật chuyển sang T099/T126 (FR-038), kèm điều kiện ở T099.
  - Kết quả cập nhật 2026-10-29 trên `002/phase6-gate`: chạy độc lập fixture/lifecycle và ba suite OS trên Ubuntu theo lựa chọn mới của owner; bằng chứng ở [báo cáo Phase 6](acceptance-report.md#nghiệm-thu-phase-6--cổng-lát-a). Cùng binary Node 24.22.1 được sao ra `/tmp` (hash nguyên vẹn) để sandbox không cần mount host home. `sandbox-bwrap` 3/3, `harness-bwrap` 2/2, `supervisor-systemd` 1/1 pass. Không lấy code hoặc commit từ PR #15 chưa merge. Resume vendor thật vẫn `unknown`, giữ fallback phiên mới có lý do; fixture/protocol không được coi là paid smoke. T072 vẫn mở riêng.

**Checkpoint**: Fake A và adapter/permission contracts đạt; bằng chứng thật lát 0 vẫn phải còn đúng hashes/version.

## Phase 6: Cổng giao lát A — go/no-go trước B

**Purpose**: Review tính khả thi và effort ngay khi A xong hoặc chậm nhất **2026-11-06**, không reset mốc.

- [x] T078 Sau T139, chạy lại baseline và toàn bộ assertions core US1/US2/US4 của lát A (gồm phần US1.7/9/11 bổ sung tại T064, service recheck T062 và M01–M08) ít nhất 20 seeds qua `test/integration/runtime/feature-002-flow.test.ts`, `test/integration/runtime/feature-002-fixes.test.ts` và contract suites; lưu ledger trong `specs/002-task-to-green-pr/acceptance-report.md`: một worktree/branch/PR mỗi task, zero duplicate logical publish/merge requests, drain/limits/projection và boundary âm đều đúng.
  - Hoàn tất 2026-10-30 (Asia/Ho_Chi_Minh) trên base `bc9d84a` + sửa fixture layout bwrap trong PR này, sau khi T072/T139 đã merge: baseline 1468/1468, 20/20 seeds mới 2026102921–2026102940, 14,020 lượt test, 0 skip; typecheck/lint/build sạch. [Report T078](acceptance-report.md#t078--nghiệm-thu-lại-sau-hợp-nhất-t072-và-t139), [ledger mới](evidence/t078-validation.json), [audit](evidence/t078-host.json). Giữ ledger chẩn đoán cũ; đổi seed fast-check/thứ tự Vitest không phải 20 workflow ngẫu nhiên độc lập.
- [x] T079 Chuẩn bị review A tại `specs/002-task-to-green-pr/go-no-go.md`: liên kết S0.1–S0.3 thật còn hiệu lực, T078, pnpm typecheck/lint/test/build, effort thực tế/budget B/C, 117 mục coverage và phần chưa đạt; không đề nghị go chỉ từ test count.
  - Bản review: [go-no-go.md](go-no-go.md), coverage đủ [117 FR](phase6-coverage.md). Chốt kỹ thuật no-go do evidence spike thiếu 7 log gốc và chưa chứng nhận lại vendor/auth/rules live; T072/T139/T078 đã đạt phạm vi A; owner đã xác nhận NO-GO tại T080.
- [x] T080 Ghi quyết định tường minh của chủ dự án, thời điểm và lý do tại `specs/002-task-to-green-pr/go-no-go.md` ngay khi A kết thúc hoặc chậm nhất 2026-11-06; chưa có go/no-go/no-go thì không mở B, không suy từ im lặng, cắt phạm vi phải sửa spec công khai và không giảm 200 crash/quyền/idempotency/smoke.
  - Hoàn tất: owner chốt **NO-GO** qua chỉ đạo “thôi chốt t80 đi”, ghi nhận **2026-10-30 00:36:40 +07:00** (2026-10-29 17:36:40 UTC). Lý do: T078 đạt nhưng thiếu 7 log spike gốc và chưa chứng nhận lại vendor/auth/rules live. Quyết định/thời điểm/lý do ở [go-no-go.md](go-no-go.md#quyết-định-owner--t080). Phase 6 đã ghi đủ kết quả; B/C giữ đóng, không chạy proof model mới ở lượt này.

## Phase 7: User Story 3 — Tiếp tục an toàn sau daemon dừng (P1, lát B)

**Prerequisites**: T080 có go. Protocol/receipt/probe cơ bản đã dùng trong A; phase này hoàn thiện recovery và chứng minh bằng fault injection, không trì hoãn invariant an toàn đến B.

**Goal**: Nhận lại runner/output/Git/PR/drain, giữ state bền và không nhân đôi logical operation.

**Independent Test**: Daemon process/SQLite file/Git/bare remote/fake HTTP thật; kill ở spawn/output/commit/push/PR/merge-drain, restart đối chiếu trước dispatch. Ít nhất 200 daemon kills, replay mọi projection sau từng lần, zero duplicate attempt/commit/PR.

### Tests for User Story 3

- [x] T081 [P] [US3] Viết `test/integration/runtime/runner-adoption.test.ts` cho daemon foreground kill và systemd daemon stop/restart, trước/sau unit start/PID receipt/marker, runner unit vẫn sống, operation lock ngăn double spawn, kill runner dừng descendants, PID reuse/reboot không giết nhầm (FR-007/034.01/035).
  - Hoàn tất 2026-10-30: 6 test trên systemd user manager, `cusr-runner exec`, flock kernel và /proc thật
    (bỏ qua khi host không có user manager). Daemon stand-in `test/support/runner-adoption-child.ts` bị
    SIGKILL sau claim (not_launched, trả reservation, không spawn), sau khi unit chạy nhưng trước marker
    (nhận lại running, supervisor `marker_exists`, runner thứ hai thoát 75 vì lock, đúng một spawn, stop
    unit dừng cả cây kể cả con setsid, exit muộn → finished + effect unknown), sau marker/pid (nhận lại theo
    identity; SIGKILL runner → cgroup dừng hết, lost giữ claim/reservation/slot). Unit daemon riêng bị
    restart rồi stop: unit operation giữ nguyên InvocationID, daemon khởi động lại nhận lại và không launch
    lần hai. PID bị dùng lại hoặc của boot khác → lost, tiến trình lạ vẫn sống, stop không tìm thấy unit.
- [x] T082 [P] [US3] Viết `test/integration/runtime/publish-recovery.test.ts` bằng Git/fake HTTP thật, ngắt sau commit/ref CAS/push/PR success trước receipt, remote diverged/duplicate marker/422/network unknown, setup non-safe unknown và local remainder sau late push; mở rộng H05: restart khi reviewer A chưa ingest nhưng drift B đã ghi, giữ fact/blocker/receipt và không lặp reviewer/commit/PR hoặc route publish từ result A (FR-003/004/017/018, FR-041.03).
  - Hoàn tất 2026-10-30: 9 test chạy handler thật của daemon trên SQLite file, worktree/bare remote Git
    thật và FakeGitHub có trạng thái (port, không qua HTTP; transport `gh` đã có contract riêng). Daemon chết
    trước/sau `update-ref` của checkpoint commit, sau `push`, sau 201 của create PR, trước receipt; restart
    thấy operation lost, effect unknown + reconcile, vài vòng dispatch không gửi lại gì. Probe trên bằng
    chứng còn lại: intent commit nhận lại đúng một OID, remote đã có SHA → `already_pushed` không push lần
    hai, remote bị người khác publish → `head_changed` không ghi đè, PR có marker → `recovered` không POST
    lần hai, marker nhân đôi → `conflict multiple`, 422 với PR đã tạo → handler ghi đúng PR đó, answer mất
    khi GitHub không đọc được → unknown qua restart rồi probe thấy một PR. H05: reviewer A đã xong trên đĩa
    chưa ingest, drift B đã ghi, restart giữ drift/blocker/review, A → unknown; kết quả A đến qua reconcile
    không mở publish/PR/gates hay reviewer thứ hai. Gọi các probe này trong effect `reconcile` của daemon
    thuộc T089/T090; setup không declared safe retry thuộc T090, local remainder sau late push thuộc T091.
- [x] T083 [P] [US3] Viết `test/integration/runtime/spool-recovery.test.ts` cho partial record/result, rotation, cursor/event atomicity, crash trước/sau ACK, ENOSPC/BUSY/64 MiB backpressure, cursor generation/seq và retention không xóa chưa ACK (FR-008/023/030/031).
  - Hoàn tất 2026-10-30 cùng T087: 20 test trên SQLite file và spool thật. SIGKILL tiến trình con tại 6 điểm của transaction ingest (`after_dedup`…`after_commit`), restart ingest phần còn lại đúng một lần; SQLITE_FULL/IOERR/BUSY không commit, không ACK; backpressure ở cap giữ đủ record; retention giữ run chưa ACK; daemon startup ingest trước khi dispatch. Result partial/invalid vẫn do `test/unit/runner/files.test.ts` kiểm.
- [x] T084 [P] [US3] Viết `test/integration/runtime/feature-002-recovery.test.ts` cho startup single-writer/integrity/schema/replay mismatch, queue global_seq, timer/deadline giữ nguyên, merge recorded trước drain crash, late fixer/push và unknown drain không DONE/nhả claim (FR-022/034.01–03/036).
  - Hoàn tất 2026-10-30 cùng T085/T086: 13 test trên SQLite file và run directory thật. Startup đúng thứ tự,
    report ghi trước dispatch, writer thứ hai `store_locked`, schema mới hơn bị từ chối nguyên vẹn, projection
    lệch chặn trước reconcile/ingest và health 503; slot/queue theo global_seq/timer/deadline đọc lại nguyên
    vẹn kể cả quá hạn. Reconcile: not_launched trả reservation, runner sống được nhận lại không spawn lại,
    exit muộn → finished + effect unknown, mất identity → lost giữ claim, PID bị dùng lại vẫn lost, identity
    không đọc được → hold tới khi lượt sau chứng minh, operation trong daemon chết → lost + reconcile, flock
    kernel thật giữ trước marker → running rồi lost. Merge ghi trước crash: CI đỏ đến muộn không mở fixer,
    drain pause, không DONE, dependent không được nhả. Systemd/lock/proc được giả lập trừ flock; daemon kill
    hàng loạt thuộc T093.

### Implementation for User Story 3

- [x] T085 [US3] Tạo `src/daemon/startup.ts` theo thứ tự writer lock→schema/integrity→verify mọi projection→reconcile operations/slot/timers→ingest→schedule; legacy runtime=null chỉ đọc, mismatch/unresolved claim chặn cấp việc và health có lý do (FR-022/036).
  - `recoverStore` chạy lock/schema/integrity (`openStore`) → verify → `reconcileOperations` → `ingestAllSpools`,
    ghi `DATA_DIR/startup-report.json` (temp→fsync→rename→fsync dir) trước lần dispatch đầu; không ghi được
    report thì chặn. Projection lệch hoặc lỗi ghi chặn dispatch; claim unknown chỉ `hold` effect nghiệp vụ, effect
    phục vụ (reconcile/stop/observe) vẫn chạy để gỡ; cả hai làm health 503 có lý do. Daemon lặp lại reconcile
    cho operation không handler nào giữ (runner được nhận lại, probe chưa đọc được) và nhả hold khi hết unknown.
    Task thiếu runtime snapshot được liệt kê read-only. Timer không bị bắn/gia hạn lại ở startup.
- [x] T086 [US3] Tạo `src/daemon/reconcile.ts` nhận lại systemd unit/flock/launch/pid/exit bằng identity đầy đủ, process chết có proof nhưng thiếu result→lost, unknown giữ claim/reservation; same-vendor session resume tối đa một lần khi policy/session cho phép, chỉ là facts cho engine xét budget, không spawn thay attempt cũ (FR-034.01/035).
  - Operation agent (effect `start_agent`) đối chiếu unit systemd, flock, `launch.json`, `pid.json`, `exit.json`
    và identity (boot/pid/start ticks/nonce): không marker + unit không chạy + lock trống → not_launched và
    `effect_reconciled not_executed`; sống → running (không đổi effect); exit hợp lệ → finished, effect
    `unknown`; chết có proof → lost, effect `unknown`, giữ claim/reservation; còn lại → unknown. Operation chạy
    trong daemon (Git/GitHub/gate) không còn process để nhận lại → lost, effect `unknown` cho reconcile theo
    loại (T089/T090). Đọc kết quả của run đã finished thuộc T090; quyết định resume session cho attempt lost
    thuộc T099 — reconcile chỉ báo facts attempt (step/binding/kind/reservation).
  - Sửa sau review PR #21: process con của operation trong daemon (git, `gh`, lệnh repo) mang env
    `CUSR_OPERATION_ID` (`src/runner/process-tag.ts`, gắn theo handler qua `AsyncLocalStorage` của
    dispatcher) và sống sót khi daemon bị SIGKILL vì chạy process group riêng. Reconcile quét `/proc`:
    process còn sống mang tag bị dừng (SIGKILL cả group sau khi kiểm start ticks — timeout của chúng đã
    chết theo daemon), rồi quét lại tối đa 2 giây; còn sót → `running` (ghi identity). Dispatcher ghi bền
    `process-marks/<operation>.json` (boot_id + tick theo `/proc/uptime`) trước khi handler có thể spawn
    và xóa khi fact đã ghi; ghi không được thì không chạy handler (latch). Process cùng user không đọc được
    environ (non-dumpable) và có start ticks từ mốc đó trở đi → `unknown`; process của user khác, bắt đầu
    trước mốc, mốc của boot khác hoặc không có mốc (chưa từng spawn) không thể thuộc operation. Mốc và
    start ticks cùng đồng hồ boot nên chỉnh giờ/UTC không làm lệch. Cả `running` lẫn `unknown` giữ effect
    `started`, không probe/thử lại; chỉ khi chứng minh không còn process nào mới `lost`. Test: ca giả
    lập trong `feature-002-recovery.test.ts`, `/proc` thật (kể cả process non-dumpable) ở
    `test/unit/runner/process-tag.test.ts`.
- [x] T087 [US3] Hoàn thiện `src/daemon/ingest.ts`, `src/store/accept.ts` cho event+cursor cùng transaction, “Chỉ nhảy sau record đầy đủ; thay đổi cùng transaction với event suy ra”, ACK sau commit, duplicate seq không duplicate event, operation/generation/segment/digest được kiểm (FR-031).
  - `ingestOperationSpool`/`ingestAllSpools` đọc từ cursor đã commit, mỗi batch là một `ingest_record` (event + cursor cùng transaction của `accept`, không cần sửa `accept.ts`). ACK chỉ theo cursor trong store và chỉ khi operation lẫn effect đã resolved, vì harness đang recover còn đọc lại từ record đầu. Artifact chỉ đính kèm khi `exit.json` đã final; artifact còn lại (log đã ingest hết lúc runner còn chạy, hoặc quá 16 mục mỗi trigger) được gửi tiếp ở đúng cursor đã commit với `records: 0`, engine ghi `ArtifactIngested` mà không đổi cursor. Còn artifact final chưa commit thì không ACK. `startDaemon` ingest trước dispatch; lỗi ghi thì chặn dispatch. Thứ tự startup đầy đủ vẫn thuộc T085.
  - Sửa sau review PR #21: run không ghi record nào (im lặng hoặc chỉ stderr) vẫn commit artifact final:
    `ingest_record` nhận `cursor: null` khi operation chưa có cursor, chỉ cho lượt `records: 0`; engine
    ghi `ArtifactIngested`, không có `OutputIngested`/cursor. Test ở `spool-recovery.test.ts`.
- [x] T088 [US3] Hoàn thiện `src/runner/spool.ts`, `src/runner/files.ts` rotation 8 MiB/segment giữ unacked, cap spool 64 MiB→artifact_backpressure và stop operation, disk full giữ receipts/claim/health; terminal partial final invalid output, không âm thầm bỏ output (FR-008/023/030/031).
  - Hoàn tất 2026-10-30: spool vẫn nằm trong `src/runner/files.ts` (rotation 8 MiB, cap 64 MiB, chỉ xóa sau
    ACK đã có từ T087), không tách `spool.ts`. Runner (`lifecycle.ts`): lỗi ghi event log hoặc PID receipt
    (ENOSPC/EIO) không làm runner chết nữa mà dừng cả cây với `artifact_backpressure`, nguyên nhân ghi vào
    `exit.json.error`; output nhận được nhưng không lưu (sau cap/lỗi ghi, stderr còn treo) đếm ở
    `artifacts.dropped_bytes` (tùy chọn, exit cũ vẫn đọc được). `readRecords(..., { final: true })` báo
    dòng cuối rách của segment cuối là torn khi `exit.json` đã final; ingest và harness dùng chế độ này,
    harness cộng torn vào `truncated_records` nên kết quả bị cắt cụt là invalid output thay vì chờ mãi.
    Test: `test/integration/runtime/runner-storage.test.ts` (process thật, cap nhỏ; ENOSPC tiêm tại
    `writeSync`), thêm ca torn final ở `spool-recovery.test.ts`.
- [x] T089 [US3] Hoàn thiện probe/re-adopt tại `src/adapters/git/reconcile.ts`, `src/adapters/github/reconcile.ts` trước retry commit/push/create PR/rerun: exact OID/remote/identity/all states/operation key, unknown/multiple giữ chờ; request retry count tách logical external effects (FR-017/018/034.01).
  - Hoàn tất 2026-10-30: probe chỉ đọc. Git: `probeCommit` (chuyển từ `commit.ts`) theo intent đã lưu →
    committed (đúng OID)/not_applied/no_intent/head_changed/unknown; `probePush` theo remote ref với
    expected-old/new (`classifyRemote` dùng chung với `pushBranch`). GitHub: `probePr` (tuple + marker mọi
    state qua `findTaskPr` của `publish.ts`, `absent` chỉ sau listing đầy đủ, nhiều PR → conflict),
    `probeDescription` theo body digest, `probeRerun` chỉ nhận rerun khi mọi workflow run của head có
    attempt mới bắt đầu sau lúc claim, còn lại unknown (POST không idempotent). Số request probe dùng ghi ở
    `effect_reconciled.requests` (trường tùy chọn) và kết quả effect `reconcile`, tách khỏi effect logic.
    Test: `test/contract/reconcile-probes.test.ts` (Git thật + bare remote, FakeGitHub; probe không ghi).
- [x] T090 [US3] Nối recovery setup/gate/autofix/publish vào `src/daemon/reconcile.ts`, `src/runner/commands.ts`: mọi long operation có receipt, declared safe retry mới cho phép, checkpoint giữ nguyên khi HEAD lệch, filesystem write proof trước nhả claim (FR-003/004/034.01).
  - Hoàn tất 2026-10-30: probe theo loại effect nằm trong handler `reconcile` của
    `src/daemon/handlers.ts` (`reconcileEffect`, cần helper nội bộ của handler; `daemon/reconcile.ts` vẫn
    lo operation/runner). Prepare và gate (declared safe) chạy lại; commit checkpoint đã có intent dùng lại
    thời điểm của intent nên ra đúng OID cũ; nhánh bị người khác dời → giữ unknown, không reset. Autofix
    (unsafe) chỉ dựa vào journal: chưa spawn lệnh nào → not_executed (về hàng đợi cùng key), mọi lệnh đã
    có receipt → dựng kết quả từ receipt, còn lại giữ unknown chờ người. Publish/create PR/mô tả/rerun/
    await_ci dùng probe T089; remote lệch → executed_failed + `head_drift` (trừ khi đã merge). Có kết
    luận chắc chắn thì operation lost/unknown của effect được đóng `finished` cùng lúc (nhả claim/slot);
    còn đang chạy trong daemon thì không chạm. `start_agent` vẫn unknown (đọc kết quả/resume thuộc T099).
    `CommandJournal` (`runner/commands.ts`): `started` fsync trước spawn (không ghi được thì không spawn),
    receipt sau khi xong, mỗi effect một thư mục `paths.receipts/<effect>`. Giới hạn: kết luận
    `still_unknown` không tự đối chiếu lại, chờ recheck/người như trước. Test: `publish-recovery.test.ts`
    viết lại theo reconcile thật của daemon (commit/push/PR/marker trùng/remote lệch) và thêm 4 ca
    gate/autofix bị giết giữa chừng; `test/unit/runner/command-journal.test.ts`.
  - Sửa sau review PR #21: receipt che `command` và `detail` bằng redactor trước khi ghi journal và trả
    về (`command_digest` vẫn là digest lệnh đã freeze). Reconcile `start_agent` có operation `finished`
    dựng lại đúng input của handler (hạn của run lấy từ `registered_at` khi task không có deadline) và
    đọc kết quả qua `HarnessPort.recover`, không bao giờ launch, thành `executed_succeeded`. Runner thật
    ghi `launch-state.json` trước spawn (digest input, nonce, nguồn kết quả, snapshot write zone, file có
    sẵn, home auth), nên mọi role — kể cả run kết thúc khi không có daemon — được kết luận từ đĩa bằng
    cùng pipeline với `run`; `result.json` đã finalize được giữ nguyên (đã có thể là artifact), reviewer
    đã finalize vẫn phải khớp proof. Outcome đã redact được lưu ở `out/outcome.json` trước khi auth rời
    home; recovery trả bản đó, và chỉ kết luận từ output thô khi mọi file auth còn nguyên để redact (không
    thì `still_unknown`, không bao giờ trả output thô). Records đã được startup ingest thì handler gửi
    riêng artifact mới tại cursor đã commit (không bị bỏ vì stale cursor). Input/launch lệch, write zone
    đổi sau exit (không quy được cho run) thì giữ `still_unknown`. Operation lost/unknown vẫn cho T099. Test: `harness-invocation.test.ts`,
    `feature-002-flow.test.ts` (coder và reviewer xong khi daemon chết → reconcile → đúng một run, đi
    tiếp tới PR).
- [x] T091 [US3] Hoàn thiện `src/daemon/drain.ts`, `src/engine/reconcile.ts` sau restart: merge proof ưu tiên, giữ hạn/count/unknown claim, invalidate business chưa gửi, nhận late results đúng thực tế không resume/publish, preserve local_remainder, không dependency sớm (FR-034.02/03, FR-040.02–09/13).
  - Hoàn tất 2026-10-30: `onReconciled` không route kết quả muộn khi đã có head drift (như `effect_result`,
    H01/H05) và không đưa not_executed về hàng đợi khi drift/merge. Vòng drain nhận `local` (probe chỉ đọc
    `probeLocalRemainder`: HEAD worktree, dirty kể cả untracked, commit remote chưa có, remote head) và
    ghi vào `completion.local_remainder` qua `DrainProgressed` (trường tùy chọn, projection cũ vẫn khớp);
    không reset/xoá/push. Test tích hợp: merge đã ghi khi daemon chết lúc đọc CI, restart → vòng drain
    giữ claim và ghi remainder (commit local + file chưa commit) → reconcile đọc lại PR chỉ ghi bằng chứng
    → DONE đúng một lần, rồi dependent mới READY; thêm 3 ca engine ở `feature-002-recovery.test.ts`.
    Drain/reconcile vẫn chưa nối vào vòng lặp `cusrd` (wiring daemon thật, như T047).
- [x] T092 [US3] Nối store failure latch vào `src/daemon/dispatch.ts`, `src/daemon/health.ts`: không phát effect khi SQLite/FS không ghi được, không trả accepted thành công giả; runner spool chờ ingest, recovery không xóa dữ liệu để giải phóng disk, writer thứ hai bị từ chối (FR-006/022/023).
  - Hoàn tất 2026-10-30: `Dispatcher.latch` giữ lý do đầu tiên khi claim/result bị store từ chối
    (`write_failed`) hoặc handler lỗi ENOSPC/EDQUOT/EIO/EROFS/SQLITE ghi; từ đó không claim effect nào, kể
    cả service effect, `block`/`hold` không gỡ được, chỉ restart (startup recovery kiểm lại store) mới gỡ.
    Fact sau fact bị từ chối của cùng effect không được ghi; effect giữ `started` cho reconcile. Daemon
    (`main.ts`): admission/complete command lỗi ghi cũng latch; khi đã latch, command mới trả 503
    `store_unwritable` trước admission (không ghi ledger), `recover()` không reconcile/ingest/ACK nên spool
    chờ trên đĩa; lỗi ghi lúc recovery chuyển từ `block` sang latch. `src/daemon/health.ts` tách từ
    `main.ts`: health có `store.writable/failure`, 503 khi latch/block/hold. Retention không đổi (chỉ xóa run
    đã ACK). Test: unit `dispatch.test.ts` (3 ca latch) và `test/integration/runtime/store-failure.test.ts`
    (daemon thật: health 503, command 503 không vào ledger, recover không accept, writer thứ hai
    `store_locked`, restart sạch latch).
- [x] T093 [US3] Thêm crash driver `test/reliability/runtime-crash.test.ts`, hỗ trợ tại `test/support/runtime-crash.ts` và nối `scripts/test-reliability.ts`: ít nhất 40 kills mỗi nhóm spawn/adoption, output/ACK, commit/push, PR create/recover, merge/drain; mỗi nhóm gồm trước effect/sau external success/trước durable ingest, seed+point+request/effect ledger và replay mọi bảng sau từng restart; gồm H05 quanh fact head_changed/result review và publish đang dở, không gỡ blocker hoặc lặp effect do callback A (FR-036, FR-041.03, SC-004).
  - Hoàn tất 2026-10-30: mỗi đời daemon là tiến trình riêng (`runtime-crash-child.ts`) chạy
    `recoverStore` rồi handler/dispatcher thật trên SQLite file, Git worktree/bare remote thật, GitHub
    giả lưu ở file, systemd/`cusr-runner` thật cho spawn. Mọi request ngoài và mọi lần ghi store qua
    điểm ngắt có ghi ledger, tự `SIGKILL` tại `(key, occurrence)` chọn từ seed. Có 6 nhóm:
    spawn_adoption, output_ack, commit_push, pr_create, merge_drain và h05 (drift B ghi khi daemon chết).
    Mỗi kill đều kiểm integrity, `verifyProjections` và nhật ký là tiền tố. Đời cuối kiểm đúng một
    spawn/commit/push/PR/DONE. Driver tìm ra 4 lỗi recovery, đã sửa kèm test hồi quy: effect `started`
    mồ côi khi receipt commit mà result chưa (`settleOrphans`, `orphaned` trong startup report),
    reconcile bị giết thì không ai đối chiếu (giờ `not_executed` và chạy lại cùng key), effect về hàng
    đợi rồi mất lần hai không có reconcile mới (`requestReconcile` lấy key kế), reconcile `await_ci`
    bỏ fact merge. `scripts/test-reliability.ts` nhận thêm `--kills`.
  - Sửa sau review PR #21: khóa dedup của `settleOrphans` gắn operation mới nhất của effect
    (`recover:<effect>:<operation>:…`), lấy theo thứ tự `OperationRegistered` đã commit chứ không theo
    đồng hồ; effect chạy lại sau reconcile rồi mồ côi lần hai (kể cả khi đồng hồ lùi) không còn nhận câu
    trả lời cache của lần đầu và kẹt `started`. Test ở `feature-002-recovery.test.ts`.
- [x] T094 [US3] Chạy T081–T084 và ≥200 kills T093 bằng `pnpm test:reliability --seed 20261028`, ghi ledger/replay digest/operation counts tại `specs/002-task-to-green-pr/acceptance-report.md`; 100% committed state/projection khớp, zero duplicate attempt/commit/PR, không lấy crash 001/fake PID thay evidence runtime (SC-004/005/006).
  - Hoàn tất 2026-10-30 trên WSL2 Ubuntu 22.04 (systemd user manager), chưa chạy trên host Ubuntu
    của Phase 6: `pnpm test:reliability --seed 20261028 --no-file-parallelism` đạt 429/429. Runtime
    crash có 220 lượt, 252 SIGKILL daemon; R1 có 200 kill; r4 có 10.000 chuỗi. T081–T084 pass trong
    `pnpm test` (1.546 pass, 4 skip host-gated). 100% store khớp, không lặp attempt/commit/push/PR.
    Ledger ở `evidence/t094-runtime-crash.json`, chi tiết ở acceptance-report.md. Lượt song song đầu
    tiên fail vì thiếu RAM (giữ là failed). SC-005 với vendor thật vẫn chờ C.

**Checkpoint**: Recovery I/O thật đạt; SC-005 vendor thật vẫn đợi C. Hoàn thiện interaction/CLI B trước C.

## Phase 8: User Story 5 — Trả lời và hủy có kiểm soát (P2, lát B)

**Goal**: Inbox/Q&A bền, escalation đúng quyền, cancel/drain bảo toàn thay đổi và merge precedence.

**Independent Test**: needs_input kết thúc agent, restart còn inbox; answer lặp 2–5 lần/đua revision/version chỉ một kết quả; cancel cây process và publish unknown, thấy merge thì drain→DONE, terminal không mở lại.

### Tests for User Story 5

- [x] T095 [P] [US5] Viết `test/integration/runtime/questions.test.ts` cho US5.1/2/7: question bền/restart, answer đầu thắng, replay request 2–5 lần, competing/stale revision, resume session chết và needs_context/blocked trong budget (FR-024/037/038/039).
  - Hoàn tất 2026-10-30: `test/integration/runtime/questions.test.ts` (16 test) chạy trên SQLite file thật
    (mở lại store để kiểm restart) và daemon thật qua UDS (`test/support/daemon-task.ts`): inbox sau restart
    daemon, replay 2/3/5 lần một request, 5 answer đua nhau đúng một thắng, competing/stale/withdrawn
    là conflict, scope project/role, resume/fallback và needs_context/blocked trong ngân sách.
- [x] T096 [P] [US5] Viết `test/integration/runtime/cancel-drain.test.ts` và `test/property/invariants/runtime-cancel.test.ts` cho FR-025.01–05: pending invalidation, process kill, publish unknown/PR preservation, cancel thấy merge, terminal rồi mới merged, merge cleanup exhausted/recheck qua service T062 đã có từ A (không đợi CLI T110); gate approval/rate-limit/auth/refusal đúng policy (US5.3–6).
  - Hoàn tất phần cancel 2026-10-30: `cancel-drain.test.ts` (10 test, SQLite file thật; runner adopt bị dừng
    như process group thật và kiểm `/proc`; service trên Git worktree/bare remote thật + FakeGitHub) và
    property `runtime-cancel.test.ts` (FR-025.01–05 trên chuỗi cancel/đọc PR/merge/drain/timer ngẫu nhiên).
    Phần gate approval/rate-limit/auth/refusal (US5.5) kiểm cùng T104.

### Implementation for User Story 5

- [x] T097 [US5] Nối `src/engine/questions.ts`, `src/application/inbox.ts` để needs_input kết thúc attempt, question/revision/provenance được commit, WAITING/human_input nhả slot sau effect rõ, inbox query sống qua restart, không giữ agent chờ người (FR-024).
  - Hoàn tất: `src/application/inbox.ts` + query `inbox` (read, lọc theo project của token, chỉ câu hỏi
    open của revision hiện tại). needs_input đã kết thúc attempt và nhả slot trong engine; test khóa lại.
- [x] T098 [US5] Tạo `src/application/answer.ts` với operate/project/version/revision/question scope và command dedup; QuestionAnswered+answer context nguyên tử, câu trả lời hợp lệ đầu thắng, request lặp cùng kết quả/competing conflict, không cấp thêm attempt từ request lặp (FR-037).
  - Hoàn tất: `src/application/answer.ts` + command `answer` trong `src/daemon/task-control.ts`; dedup
    `cmd:<request_id>:answer` trước kiểm version nên replay sau crash vẫn trả kết quả đầu; AnswerRejected,
    `question_not_open` và stale version đều là `conflict`, `question_not_found` là exit 4.
- [x] T099 [US5] Nối `src/engine/questions.ts`, `src/engine/claim.ts`, `src/runner/invocation.ts` resume tối đa một lần cho attempt lost khi policy/session cho phép, chỉ cùng harness/session đã proven; session không dùng được thì engine xét attempt mới mang Q&A, đủ slot/quyền/approval/budget, mọi call thật tính lượt, adapter không tự retry (FR-038).
  - Điều kiện từ T077 (2026-10-29): trước proof resume Claude thật, worker phải lưu phiên (bỏ
    `--no-session-persistence` khi có thể được resume) và runner chuyển đúng transcript phiên đó
    (`.claude/projects/<cwd>/<id>.jsonl`, kiểm hash, đã bỏ auth) từ home attempt trước sang home mới; thay
    đổi biên private home này cần cập nhật `contracts/execution.md` trước khi code.
  - Hoàn tất phần engine (fake session port): tiếp tục sau answer resume đúng session của attempt đã hỏi
    (`resumePlan`), `AttemptRequested.resumed_from` (additive) giới hạn mỗi session resume tối đa một lần;
    resume hỏng/lost thì attempt mới `session_unusable` vẫn mang Q&A và tính lượt. Điều kiện T077 cho proof
    Claude thật (lưu phiên, chuyển transcript, sửa `contracts/execution.md`) **chưa làm**, thuộc C.
- [x] T100 [US5] Nối needs_context/blocked vào `src/engine/waits.ts`, `src/adapters/context.ts`: lưu phần thiếu/blocker và allowed exit, không role ngoài phạm vi hoặc vòng hỏi vô hạn, attempt mới chỉ khi context bắt buộc đầy đủ và còn giới hạn (FR-039).
  - Hoàn tất: task runtime có worker needs_context/blocked (đã gọi) chờ người với detail
    `agent_needs_context`/`agent_blocked` + `reported` (blocker được handler giữ lại, `AgentData.blocker`
    additive), không tự retry/escalate hay gọi role khác; answer chạy một attempt `retry` mang Q&A, qua
    slot/ngân sách (hết lượt → chờ policy). Task 001 không runtime giữ routing cũ.
- [x] T101 [US5] Mở `src/engine/cancel.ts`, `src/application/cancel.ts` và `src/daemon/drain.ts`: ghi cancel intent/invalidate business pending, TERM/KILL/xác minh mọi operation task, giữ slot/claim tới effect rõ, giữ diff/commit/branch/PR; không tự đóng/xóa/rollback bên ngoài (FR-025.01/02/05).
  - Hoàn tất: `src/application/cancel.ts` + command `task_cancel`. Engine giữ nguyên invalidation/stop/
    reconcile của 001; handler `stop_attempt` giờ dừng runner không còn handler (adopt sau restart) qua
    `ProcessPort` với TERM/KILL/verify của drain, stop không xác minh được là `unknown`; `StopData` thêm
    `aborted`/`stops` (additive). Slot/claim giữ tới receipt và kết quả attempt; không đóng PR/xóa branch.
- [x] T102 [US5] Nối cancel observation/probe vào `src/engine/cancel.ts`, `src/daemon/observation.ts`: đối chiếu PR mới nhất ngay cả observation hết hạn, unknown không CANCELLED; merge trước terminal→DONE sau drain với “yêu cầu hủy đến quá muộn”/unverified, merged sau CANCELLED chỉ history, không mở lại (FR-025.03/04, FR-040.15, FR-043.07).
  - Hoàn tất: task runtime có PR chỉ CANCELLED sau một lần đọc PR **sau** thời điểm hủy cho open/closed
    (`cancelNeedsPrRead`, chờ `policy/cancel_reconcile`); service đọc ngay kể cả observation đã hết hạn,
    đọc lỗi thì chờ tới recheck. Merge có proof → drain → DONE + `CancelRecordedLate`; merge sau CANCELLED chỉ
    là lịch sử. Test cũ `external-completion` kỳ vọng CANCELLED ngay khi có PR được sửa theo FR-025.03.
- [x] T103 [US5] Tạo `src/application/approve.ts` cho escalation admin gắn task/revision/step/rung/policy hash hiện hành, expected-version/dedup; operate/read/worker không tự duyệt, merge/yolo luôn unsupported và không tạo approval (FR-010/028).
  - Hoàn tất: `src/application/approve.ts` + command `approve_escalation` (admin ở admission); chọn đúng
    request escalation mở của step/rung/revision hiện hành, engine kiểm policy hash; không bao giờ cấp
    approval loại khác; replay trả kết quả cũ, request khác là conflict, không có request là exit 4.
- [x] T104 [US5] Nối quota/cooldown/auth/refusal vào `src/engine/failure.ts`, `src/store/timers.ts`, `src/engine/waits.ts`: rate-limit có lịch hữu hạn nhả slot khi operation rõ, auth/refusal chờ người không escalation né quyền, unknown probe giữ claim (FR-015, US5.5).
  - Hoàn tất bằng test: engine 001 đã xử lý đủ (rate limit tính lượt, nhả slot, timer hữu hạn theo
    `reset_at`/backoff rồi `backoff_exhausted`; auth/refusal chờ người, không retry/nâng nấc/approval;
    unknown giữ claim tới reconcile). `cancel-drain.test.ts` khóa lại trên task runtime; handler đã
    chuyển `reset_at` của harness. Không cần sửa `failure.ts`/`timers.ts`/`waits.ts`.
- [x] T105 [US5] Chạy T095/T096 với service recheck T062 đã được kiểm từ A, rồi ghi US5.1–7 tại `specs/002-task-to-green-pr/acceptance-report.md`, bao gồm answer/cancel replay 2–5 lần, actual process descendants, PR đã tạo không xóa, cancel unknown/merged/terminal và session fallback không vượt lượt (SC-006/007/012).
  - Hoàn tất 2026-10-30 trên PR #22: [mục T105](acceptance-report.md#t105--us5-trả-lời-và-hủy-có-kiểm-soát)
    ghi US5.1–7, replay 2–5 lần, process thật, PR giữ nguyên, cancel unknown/merged/terminal, fallback
    session và năm lượt sửa sau review. Container chạy root: 3 test môi trường fail cả trên `main`;
    reliability pass nhưng `spawn_adoption` bị skip vì thiếu systemd user manager. Proof resume Claude
    thật (điều kiện T077) và kiểm lại ≥ 200 kill trên host có systemd còn mở (C/T120).

## Phase 9: User Story 6 — Xem và điều khiển qua CLI (P2, lát B)

**Goal**: CLI hữu hạn/JSON, logs nối lại, authz chuẩn, explain đúng mọi wait detail và recheck một lượt không mở lại workflow.

**Independent Test**: Dùng CLI process qua UDS tới daemon thật/SQLite và fake ports; human/JSON output, status/exits 0–6, request/version conflict, authz/revoke/project scope, disconnected không mở DB, recheck expired/drain/PENDING/terminal không gọi agent/merge/reset hạn.

### Tests for User Story 6

- [x] T106 [P] [US6] Viết `test/integration/runtime/feature-002-cli.test.ts` cho US6.1–7 và phần CLI/recheck/explain còn lại của US1.8/10/11: toàn bộ commands/exits/envelope/log cursor/follow, allowed-actions mọi dòng FR-029, slot/dependency/drain explain, PENDING/PR/expired/drain/terminal recheck và unsupported no-mutation (FR-027.01–05/029/045.01–02/046.01–08).
  - `feature-002-cli.test.ts` (45 test): `runCli` với mọi lệnh thật qua UDS tới daemon thật/SQLite; một test chạy process `cusr` thật.
- [x] T107 [P] [US6] Viết `test/integration/runtime/access-control.test.ts` với token owner/admin, read, assistant read+operate scoped và revoked: actor spoofing/escalation/token management/project khác bị từ chối exit 5, assistant không thấy owner token/worker không thấy mọi token, restart revocation không thay accepted audit (FR-028/032).
  - `access-control.test.ts` (9 test) và mục token trong `sandbox-permissions.test.ts`. Đọc theo ID ở project khác là exit 4 để không lộ ID; lệnh nêu project khác là exit 5.

### Implementation for User Story 6

- [x] T108 [US6] Hoàn thiện `src/application/queries.ts`, `src/cli/cusr.ts` cho task list/show/explain/history, inbox/status/doctor qua UDS; list limit≤100+cursor, query từ projection không LLM/DB fallback, PR/head/usage/reservation/artifact có provenance và authz project scope (FR-027.01/02).
  - `task_list/show/history/explain` trong `queries.ts`; show thêm `provenance`. Query đều closed schema.
- [x] T109 [US6] Hoàn thiện routes add/confirm/cancel/answer/approve tại `src/daemon/server.ts`, `src/cli/cusr.ts` qua application T023/T031/T098/T101/T103; mutation có request UUID và expected-version khi sửa task, CLI tự sinh ID phải in lại, lỗi syntax/schema trước mutation, effect bất đồng bộ (FR-027.01/028).
  - Mọi lệnh trong `src/cli/tasks.ts`, danh sách ở `src/cli/commands.ts`; flat command T048 chuyển thành `cusr task …`.
- [x] T110 [US6] Nối service recheck T062 đã có từ US2 vào routes `src/daemon/server.ts` và command `src/cli/cusr.ts`; hoàn thiện `src/application/recheck.ts` chỉ cho integration/adoption ports thực đã có từ US3, giữ nguyên state semantics/limits/dedup. Dùng T106/T107 kiểm end-to-end UDS: operate/version/dedup, PENDING config/capability đọc base mới qua triage, PR một lượt observe, merge_cleanup một lượt stop/probe≤60 giây; coalesce, giữ lịch/budgets, expired không bật poll, terminal không business effect, không agent/merge/chấp nhận head mới (FR-027.01, FR-046.01–08).
  - Command `task_recheck`; production nối `observeTaskPr` qua `ObservationCoordinator` và `drainRound`. Build thiếu hai port đó trả `not_available`.
- [x] T111 [US6] Mở `src/explain/explain.ts`, `src/explain/allowed-actions.ts` cho từng detail/lối ra FR-029, blockers còn hiệu lực/freshness/observation deadlines, slot initial/resumed wait/deadline, prerequisite DONE unverified+link sau dependent start, merge_cleanup proof/pending operations/drain limit/recheck; hiển thị method frozen mặc định squash cùng message worker đề xuất khi chờ merge thủ công; actual method có evidence hoặc unknown, mismatch chỉ audit; không gợi ý gia hạn/amend-policy/verify head mới (FR-027.03–05/029/041.05/042.09/043.12).
  - `src/explain/allowed-actions.ts` phủ mọi `DetailCode` bằng kiểu; `explainRuntime` thêm hạn, slot, prerequisite, merge_cleanup, merge.
- [x] T112 [US6] Tạo `src/application/doctor.ts`, hoàn thiện `src/daemon/health.ts`: writer/schema/integrity/replay, unresolved claims/slot/cursor, systemd unit/WSL2 thực, sandbox canaries, path/storage/credential presence và manifest hashes; doctor không model/sudo/provision hoặc tuyên proven từ help, health lỗi chặn thực thi tương ứng (FR-027.02/032/033).
  - `src/application/doctor.ts`, gồm chạy thử một transient unit và đối chiếu manifest với binary. Settings/environment/host policy của manifest do preflight kiểm: xem [T120](acceptance-report.md#chưa-đạt--ngoài-phạm-vi).
- [x] T113 [US6] Tạo `src/cli/output.ts`, `src/cli/errors.ts` và HTTP error mapping: finite --json đúng một `{schema_version:1,ok,data,error}`, details/request_id ổn định, log stderr/no ANSI/prompt; exit 0 processed/1 health-execution/2 syntax-config-unsupported/3 connection-timeout/4 missing/5 forbidden/6 conflict, task status không đổi query exit (FR-028).
  - `src/cli/errors.ts` gom exit và HTTP status; lỗi transport của mutation vẫn in request ID.
- [x] T114 [US6] Tạo `src/application/logs.ts`, `src/cli/logs.ts` cho --after cursor finite và --follow JSONL seq/cursor, mỗi session≤1 giờ nối lại được, data chỉ finalized/redacted/authorized, không lặp hoặc mất record đã ACK qua rotation/restart (FR-027.01/028/031).
  - Cursor đếm record đã commit; `--follow` hỏi lại theo chu kỳ; segment sau ACK chuyển sang `acked/`; batch mất file hiện là `gap`.
- [x] T115 [US6] Từ chối task retry/amend-policy, merge approval/yolo tại `src/cli/cusr.ts`, `src/application/commands.ts`: unsupported_feature/exit 2 và zero business mutation/merge dispatch, hướng dẫn task add độc lập hoặc merge GitHub rồi recheck, không liên kết retry hay mở terminal (FR-021/045.01/02).
  - Từ chối ở CLI và ở admission, kèm `details.guidance`.
- [x] T116 [US6] Hoàn thiện UDS boundary tại `src/daemon/server.ts`, `src/cli/client.ts`: data dir0700/socket0600/token0600, POST /v1/query và /v1/command closed JSON, GET /v1/health, body≤1 MiB/header≤5 giây/admission≤10 giây, bearer từ file không argv/log, không TCP/abstract socket, daemon disconnected exit3 không đọc DB (FR-028/032).
  - Thêm `connectionsCheckingInterval` để giới hạn header 5 giây có hiệu lực đúng hạn (mặc định Node chỉ kiểm mỗi 30 giây); test đo thời gian thật.
- [x] T117 [US6] Hoàn thiện trusted access-token loading/audit tại `src/application/access-tokens.ts` và runbook `deploy/README.md`: owner bootstrap riêng, assistant 32-byte token [read,operate]/project allowlist, grant/revoke config+restart, connector không thấy owner home/token, worker không thấy operate, không coi same-UID full shell là ranh giới quyền (FR-028/032).
  - Thêm config hash vào audit startup; runbook ở `deploy/README.md`.
- [x] T118 [US6] Thêm unit mẫu `deploy/systemd/cusrd.service` và hướng dẫn `deploy/README.md` cho một daemon writer, runner unit độc lập cùng foreground/service backend, WSL2 user manager/provisioning/version/paths; không tự cài/nạp unit host trong task tài liệu này (FR-007/027.02).
  - `deploy/systemd/cusrd.service` và mục chạy daemon trong `deploy/README.md`. Đã qua `systemd-analyze --user verify`; đúng phạm vi task, chưa cài hay nạp unit trên host.
- [x] T119 [US6] Hoàn thiện recovery dependency notifications/queue view tại `src/application/dependency.ts`, `src/daemon/scheduler.ts`: quét projection khi startup để nhận notification mất sau DONE commit, idempotent ready transition/priority order/slot wait accumulation, unverified prerequisite link bền qua dependent start/restart (FR-001.02/03, FR-027.03/04, FR-044.06/07).
  - `DaemonOptions.control` nhận `schedule`; pass đầu chạy lúc startup, không chạy khi hold/block/latch. Queue view là `slot.queued.position` trong explain.
- [x] T120 [US6] Chạy T106/T107, flow/fixes và integration B sau T110/T111/T119; đối chiếu đủ từng US1.1–11 gồm recheck/CLI explain đã hoãn tại T049/T064, rồi ghi matrix mỗi wait detail/exit/authz/recheck và US6.1–7 tại `specs/002-task-to-green-pr/acceptance-report.md`; xác nhận T094≥200 kills/replay vẫn đạt sau integration, thiếu evidence thì giữ C đóng (SC-007/009/011/012).
  - Hoàn tất 2026-10-31: [báo cáo T120](acceptance-report.md#t120--us6-xem-và-điều-khiển-qua-cli). 259 daemon kills, 429/429, `spawn_adoption` không skip. Vẫn là fake; C còn chặn bởi T140.

**Checkpoint B**: US3/5/6 và recovery ≥200 kills đạt, owner go còn hiệu lực, permission fixtures pass; khi đó mới chạy C với usage/GitHub được cấp.

## Phase 10: Smoke thật, polish và nghiệm thu xuyên story (lát C)

**Purpose**: Chứng minh SC thật, hoàn thiện báo cáo trung thực. Không coi MVP fake là toàn feature hoặc phát hành v1.

- [x] T140 Nối `src/daemon/production.ts` đủ để `cusrd` chạy task thật: effect handlers (`buildHandlers`), harness theo config, `BwrapSandboxProvider`, executor, paths, committer, remote URL, vòng observation/drain và nguồn capability manifest thay cho `manifests: {}`; prompts/attachments thật cho start. Phát hiện ở T120, là điều kiện trước T121–T130; cần owner review vì đây là bước đầu tiên `cusrd` có thể gọi agent thật.
  - Kết quả T140 (2026-10-31, chờ owner review ở PR): `productionControl` nối đủ handler trên `SystemdSupervisor`, `BwrapSandboxProvider`, `SpawnExecutor`; harness chỉ chạy khi có `pin.json` + `manifest.json` của owner tại `<DATA_DIR>/harnesses/<tên>/` còn khớp host (`src/runner/harness-records.ts`), ghi bằng `cusr-runner record-manifest` từ evidence nêu rõ binary và cấu hình đã chứng minh (`attested`), lệch là từ chối; fixture T007 không có `attested` nên không dùng được. `attested` phủ mọi trường pin, gồm `max_turns` và `tools`. Attempt lấy credential reference, trần dừng và `stall_timeout` từ snapshot đã đóng băng; sandbox từ chối mount đụng credential của config hiện tại hoặc của bất kỳ task nào đã đóng băng, kiểm ở mỗi lần lập sandbox nên đường dẫn credential không nằm trong policy hash; doctor báo trước ở `credential_mounts`. Thêm vòng timer (trước đó daemon không bắn timer đến hạn, nên `ci_poll` và backoff đứng im), observation và drain giãn đều theo `drain_max_ms/drain_max_rounds`. Prompt đọc cạnh user config. Bằng chứng: `test/integration/runtime/production-runtime.test.ts` chạy task tới PR xanh rồi DONE qua unit systemd và bwrap thật, vendor là replay T007, GitHub giả, không gọi model. Chưa có smoke thật: thuộc T121–T130. Còn hở: attachment chưa có nguồn (`cusr add` luôn tạo rỗng, task có `content_ref` fail ở freeze); setup commands vẫn chưa vào snapshot. Setup commands đã vào snapshot và chạy ở `prepare` từ sau PR `002/project-setup`.

- [x] T121 Tạo fixture task/gate pass-fail cho Node và Python tại `test/fixtures/runtime/projects/node/`, `test/fixtures/runtime/projects/python/`, suite `test/smoke/task-to-green-pr.test.ts`; cấu hình hai repo GitHub sandbox được cấp với nonempty snapshot CI/review bắt buộc, trường hợp no-protection có evidence dương, credential references không secret trong repo (SC-001/002).
  - Fixture ở `test/fixtures/runtime/projects/`, suite và driver `test/support/smoke.ts`. Hai repo sandbox private `duykhanh01/cuesura-sandbox-node`, `-python` có required checks `build`/`test` và một review bắt buộc (2026-10-31).
- [x] T122 [P] Tạo `test/smoke/harness-roles.test.ts` sau fixture/config T121, dùng schema và manifest T007/T070, lập ma trận 3 role × 2 vendor với assertion output/auth/permission/usage/provenance và secret canary. Kiểm local fixture/setup trước invocation trả phí; invocation thật opt-in trong T126 khi đủ quyền/budget, không dùng fixture replay thay SC-008.
  - Kiểm local bằng replay T007 qua task thật: ma trận 3 role × 2 vendor, reviewer không ghi được worktree, vendor in private home mà canary không còn trong data dir. Invocation thật để `it.todo` cho T126, gồm cả việc sinh evidence `attested` chưa có công cụ.
- [x] T123 [P] Tạo `test/smoke/runner-restart.test.ts` sau fixture/config T121, chuẩn bị hook chờ real agent active, foreground kill/service stop/restart và đối chiếu cùng attempt/unit/descendants tới PR xanh cho từng vendor; kiểm driver local trước T128, real scenario opt-in và có ledger riêng, không fake PID thay SC-005.
  - Driver chạy thử SIGKILL và SIGTERM × hai vendor, cùng attempt/unit, không gọi thay thế. Phát hiện và sửa lỗi: dừng daemon êm từng dừng luôn agent (xem báo cáo). Kịch bản thật opt-in chưa chạy.
- [x] T124 [P] Tạo `test/smoke/gates.test.ts` sau fixture/config T121, assertions command/checkpoint/exit cho Node/Python pass-fail, fail chặn publish tới khi fix+gate lại; kiểm fixture commands local trước T129, real PR workflow chỉ opt-in, evidence phân biệt local gate với harness/GitHub thật (SC-002).
  - Lệnh gate fixture đúng pass/fail ở cả hai hệ sinh thái; chạy thử gate đỏ → fixer → gate xanh → một PR. Kịch bản thật opt-in chưa chạy.
- [x] T125 [P] Tạo `test/smoke/manual-merge.test.ts` sau fixture/config T121, checkpoint chờ người dùng merge, observer/drain/DONE-once/zero merge requests, checked/merged head/merge commit và proof fixtures T008 cho merge/squash/rebase/source push/delete; kiểm observer bằng fixtures local trước T130, harness không gửi merge và không suy pass khi chưa có manual merge (SC-001/012).
  - Chạy thử observer/drain trên GitHub giả: chờ khi chưa merge, DONE một lần qua restart, source push/delete sau merge; replay T008 merge/squash/rebase qua proof production. Kịch bản thật opt-in chưa chạy.
- [x] T126 Sau khi T122 đã tạo và kiểm setup suite, đối chiếu manifest T007 với binaries/settings/layout hiện tại và chạy hoặc tái xác nhận smoke coder/fixer/reviewer × hai vendor tại `test/smoke/harness-roles.test.ts`, lưu output/auth/schema/permission/usage evidence thật trong `specs/002-task-to-green-pr/acceptance-report.md`; hash đổi phải chạy lại spike phần bị ảnh hưởng trước use, không tăng budget ngầm hoặc thay fixture replay cho invocation thật (SC-008).
  - Công cụ xong, **task chưa xong**: `cusr-runner prove-harness` chạy ba role một lượt qua `RunnerHarness`, unit và sandbox production trên repo dùng một lần, ghi evidence có `attested` cho `record-manifest`. Cần `--approval` và `--max-invocations`, ghi ledger trước mỗi spawn, kể cả lượt fail; capability chỉ `proven` khi lượt chạy cho thấy. Kiểm bằng vendor giả tại `test/integration/runtime/harness-proof.test.ts`.
  - Lượt thật 2026-10-31 trên host Linux hiện tại, **không phải host WSL2 đã chốt**: Codex 0.165.0 và Claude 2.1.316 đạt ba role, evidence tại `test/fixtures/runtime/spike-0/harness/proof-20261031/`. Xem [báo cáo](acceptance-report.md#t126--chứng-minh-harness-trên-host-hiện-tại).
- [x] T127 Chạy `test/smoke/task-to-green-pr.test.ts` qua CLI với Claude coder/Codex reviewer trên một sandbox và đổi vai trên sandbox còn lại: không sửa tay code, đúng một PR xanh/head mỗi task, gate/review/CI evidence, chờ người merge chưa DONE và zero merge request; lưu URLs/SHA/config/version/request ledger vào `specs/002-task-to-green-pr/acceptance-report.md` (SC-001).
  - Hai chiều đạt trên host Linux hiện tại, không có sửa tay: Node#1 (Claude coder, Codex reviewer), Python#1 (đổi vai). Mỗi task một PR xanh, chờ người merge, chưa DONE; ledger tại `test/fixtures/runtime/spike-0/harness/proof-20261031/smoke-ledger.jsonl`. Phần chờ merge kết thúc ở T130.
- [x] T128 Sau khi T123 đã tạo và kiểm driver suite, chạy `test/smoke/runner-restart.test.ts` cho mỗi vendor lúc agent còn chạy, daemon foreground kill và service stop/restart; nhận đúng attempt/runner, không gọi thay thế, tiếp tục tới PR xanh; ghi unit identity/progress/receipt thật tại `specs/002-task-to-green-pr/acceptance-report.md` (SC-005).
  - Đạt đủ trên host Ubuntu ngày 2026-10-31, kết quả tại [báo cáo chạy lại](acceptance-report.md#chạy-lại-t128t129-sau-pr-28).
  - Lượt trước PR #28: 3/4 ca đạt. Claude SIGKILL chưa đạt vì coder dừng ở `agent_blocked` trước PR. Xem [báo cáo](acceptance-report.md#t127t129--chạy-thật-trên-sandbox).
- [x] T129 Sau khi T124 đã tạo và kiểm fixture suite, chạy gate pass và fail thật cho cả Node/Python qua `test/smoke/gates.test.ts`, chứng minh fail chặn publish tới khi sửa/kiểm lại; không dựa mỗi fake gate fixture, lưu commands/exit/checkpoint/PR head tại `specs/002-task-to-green-pr/acceptance-report.md` (SC-002).
  - Đạt pass và fail thật cho Node/Python, gate đỏ dùng `task-red-gate.json`; kết quả tại [báo cáo chạy lại](acceptance-report.md#chạy-lại-t128t129-sau-pr-28).
  - Lượt trước PR #28: Python đạt, Node dừng ở `agent_blocked`; đường gate đỏ thật chưa chạy.
- [x] T130 Sau khi T125 đã tạo và kiểm observer suite, chạy `test/smoke/manual-merge.test.ts` khi chủ dự án merge thủ công hai PR nghiệm thu, đối chiếu thêm merge/squash/rebase/source-push/delete proof T008 trên sandbox; lưu checked/merged head/merge commit/proof hash, drain→DONE một lần/zero system merge request, recheck expired/cleanup chỉ case thật đã chạy; không gọi merge trong suite (SC-001/012).
  - Đạt với hai merge squash thật qua admin (Node#6, Python#5): DONE một lần, không request merge từ hệ thống. Merge commit, rebase, source push/delete đối chiếu qua record T008; recheck hết hạn và cleanup chưa có case thật. Xem [báo cáo](acceptance-report.md#t130--merge-thủ-công-thật).
- [ ] T131 Hoàn thiện từng dòng FR trong `specs/002-task-to-green-pr/contracts/acceptance-map.md` và `specs/002-task-to-green-pr/acceptance-report.md` bằng task ID/test assertion/fixture/receipt/evidence thật hoặc chưa đạt/chưa kiểm; đủ 117 nghĩa vụ/12 SC, tách fake, real I/O, real vendor và không chứng nhận head unverified.
- [ ] T132 Mở `test/invariants.map.ts`, `scripts/report-invariants.ts` và report `specs/002-task-to-green-pr/acceptance-report.md` cho I01–I12/S01–S10/R1–R9; giữ baseline 001, chỉ chứng minh I11 không dispatch merge, R7 soak/R9 vận hành đầy đủ chưa nghiệm thu toàn bộ; fixture/help không thay smoke (SC-009).
- [ ] T133 Chạy `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, reliability seeded và `pnpm report:invariants` cho mã cuối, smoke opt-in khi đủ prerequisite; ghi command/exit/duration/seed/crash distribution/request-vs-effects/full projection diff vào `specs/002-task-to-green-pr/acceptance-report.md`, lỗi/chưa khả dụng phải ghi thật và sửa trong scope trước đánh dấu xong.
- [ ] T134 Kiểm hành trình/lệnh/liên kết tại `specs/002-task-to-green-pr/quickstart.md`, cập nhật `README.md`, `docs/architecture.md`, `deploy/README.md` theo binary/config thực đã kiểm; ghi hạn chế/khả năng chưa đạt và worktree/artifact retention, xác nhận không placeholder/broken doc links, không thêm feature ngoài scope để làm xanh báo cáo.

## Dependencies & Execution Order

### Phase Dependencies

```text
T001–T009: S0.1 + S0.2 + S0.3 pass (đạt 2026-10-28)
    → T010–T026: nền runtime
    → US1 (T027–T049 + T135/T136/T137; fake harness/session)
        T030/T031 → T135 → T032
        T037/T039/T040/T041 + T135 → T136 → T137 → T043/T047/T048/T049
    → US2 (T050–T064; quyết định resume/fallback qua fake session port)
    → US4 (T065–T077; T068–T071 → T138 → T077)
    → T139: kiểm tổng hợp M01–M08 sau T064/T077/T135–T138
    → T078–T080: go của chủ dự án, hạn đánh giá 2026-11-06
    → US3 (T081–T094)
    → US5 (T095–T105)
    → US6 (T106–T120)
    → T140: nối runtime production
    → T121–T130: smoke thật, A/B pass + quyền dùng sandbox/usage
    → T131–T134: báo cáo/quality gates/tài liệu cuối
```

- Phase 1: T001 cấp đầu vào/budget; T003/T004/T005 đã có prototype độc lập A. T002 kiểm host và cập nhật scope prototype là prerequisite T006; không còn provisioning AppArmor bắt buộc. T006 local có thể chạy khi chờ T001; phần vendor của T006 và T007 cần đầu vào/quyền/budget T001, dùng T003/T004 và mode proof S0.1. T008 cần T001/T005; T009 chỉ tổng kết proof thật. Phase 1 không hoàn tất chỉ vì đã có tasks.md. Sau gate, T010/T011 độc lập. T012/T013 độc lập; T014 cần cả hai, sau T015 thì viết tests T016 trước T017. Nhánh store: T017→T024→T025. T018/T019/T020/T021 có thể chuẩn bị các boundary khác file sau schemas/ports; T020 vẫn đợi proof thật T006/T007. T022→T023 dùng domain/authz; T016 được chạy lại để kiểm tất cả nền trước T026; T026 nối sau nền.
- US1: tests T027–T029 trước implementation. T030→T031→T135→T032; T033→T034; T035→T036→T038/T039, T037→T038/context usage; T040→T041→T042→T043→T044. T041 còn cần T039; T045 cần normalized proof T044, T046 cần T045/T018/T019; T136 sau T135/T037/T039/T040/T041; T137 sau T136/T036/T038/T039, trước T043/T047. T047→T048→T049 sau các nhánh nền và evaluator T042/T043; fake session, không đợi T138. T049 chỉ baseline; T064/T078 kiểm phần fixer/slot/deadline, T106/T120 kiểm recheck/CLI explain còn lại của US1.
- US2 cần flow/head/proof US1. T050–T053 là test files độc lập; T054→T055/T056→T057, T042/T043 đã hoàn tất trong US1; T058→T059/T060→T061→T062; T063→T064 sau các integration tương ứng. T064 gọi service T062, kiểm session port fake của T055/T057; không chờ T138 hoặc CLI T110. Các task chạm cùng engine/dispatch file phải tuần tự.
- US4 cần sandbox/protocol T018–T020, manifest proof lát 0 và role contract T013. T065–T067 độc lập; T068/T069 song song sau test contract, T070→T071→T072→T073→T074→T075→T076; T138 sau T068–T071, rồi T076/T138→T077. T139 sau T064/T077, trước T078. Chỉ hoàn thiện adapter từ fixtures ở A; không chạy full real workflow trước C.
- US3 cần go T080; T081–T084 khác file có thể viết song song, implementation T085→T086→T087→T088→T089→T090→T091→T092→T093→T094. Recovery gồm process/Git/spool thực; không thay 200 kills bằng 200 pure-engine events.
- US5 cần receipt/probe/recovery US3; T095/T096 song song, T097→T098→T099/T100; T101→T102 dùng drain/probe và service recheck T062 đã có từ A; T103/T104 và tests hoàn tất trước T105.
- US6 dựa application commands/query tối thiểu US1 và inbox/cancel/approve US5. T106/T107 song song; T108→T109→T110 (nối service T062 đã có)→T111→T112→T113→T114→T115→T116→T117, T118 khác file có thể song song implementation, T119→T120 sau queue/CLI integration.
- C chỉ mở sau T094/T105/T120 pass và quyền dùng tài khoản/sandbox cụ thể. T121 tạo shared fixtures; T122/T123/T124/T125 tạo các suite khác file, chỉ dùng fixture ổn định T121 và có thể viết song song; T126/T128/T129/T130 chỉ chạy sau task tạo suite tương ứng. T126 kiểm manifest trước T127; T128 tích hợp vào real attempts để không gọi thay không cần thiết. T130 đợi người dùng thực merge, không suy phê duyệt từ im lặng; thiếu auth/repo/merge thì ghi chưa kiểm, không thay bằng fake.

### Parallel Examples per User Story

Các ví dụ là cơ hội cho người triển khai; không yêu cầu tự spawn agent hoặc chạy đồng thời hai task runtime. Runtime luôn chỉ một slot.

| Story | Nhóm có thể song song | Điều kiện |
| --- | --- | --- |
| US1 | T027 slot/completion property; T028 flow integration; T029 Git/context/publish contract | Nền Phase 2 đạt; file test khác nhau |
| US1 | T035 Git command port; T040 gh port | Ports/schema/proof đã có, trước các adapter phụ thuộc |
| US2 | T050 evidence/subset property; T051 GitHub contract; T052 limits; T053 fix integration | US1 đạt, dùng helper đã ổn định, không cùng sửa shared fixture |
| US4 | T065 sandbox; T066 harness; T067 lifecycle/artifacts | US2 và boundary nền đạt |
| US4 | T068 Claude adapter; T069 Codex adapter | T066 contract và manifests T007 đã có, không cùng sửa result schema |
| US3 | T081 adoption; T082 publish; T083 spool; T084 replay/drain | T080 có go, fixtures nền ổn định |
| US5 | T095 question/answer integration; T096 cancellation/property | US3 đạt |
| US6 | T106 CLI behavior; T107 authz/revoke integration | US5 đạt, daemon fixtures ổn định |
| US6 | T106 CLI behavior; T118 unit mẫu | Sau US5, không cùng sửa shared helper/runbook với T117 |
| C | T122 harness roles; T123 restart; T124 gates; T125 manual merge | T121 và fixture/schema/ports ổn định; không gọi model/remote đồng thời, real workflow vẫn một slot |

## Implementation Strategy

### MVP First

1. Mở gate 0 bằng proof Isolated theo ADR-0004; không tự nới policy host/permission/model budget, không dùng Native-only để vượt gate.
2. Hoàn thành nền và **US1 với fake** để demo một task → PR xanh/chờ merge → external proof/drain/DONE; đây là MVP kỹ thuật, chưa đủ gate A hoặc toàn feature.
3. Hoàn thành US2 và US4 để có lát A nghiệm thu được, 20 seeds và review effort. Chủ dự án ghi go trước B; chậm nhất đánh giá 2026-11-06.

### Incremental Delivery

1. US3 chứng minh recovery bằng ≥200 daemon kills/replay đầy đủ trước real workflow.
2. US5 thêm interaction/cancel; US6 hoàn thiện CLI/explain/recheck/health và quyền assistant riêng.
3. C chứng minh hai chiều vendor/hai hệ sinh thái/restart/manual merge thật. Chưa đạt một tiêu chí thì báo rõ, không ghi full feature hoặc v1 done.
4. Mỗi task chỉ đánh dấu xong sau artifact/source/test/evidence tương ứng tồn tại và kiểm chứng đúng tầng. Request count khác logical effect count; không dùng một test đại diện cả FR đã tách.

## Truy vết từng nghĩa vụ nghiệm thu

Bảng dưới ánh xạ **từng** mã trong [acceptance-map.md](contracts/acceptance-map.md) tới task triển khai và kiểm chứng. Task test phải có assertion phân biệt nghĩa vụ; bảng là kế hoạch coverage, chưa phải bằng chứng pass. Các task test liệt kê trước implementation trong story; báo cáo cuối bổ sung test ID/receipt thực tế tại T131.

| Nghĩa vụ | Triển khai | Kiểm chứng / evidence |
| --- | --- | --- |
| FR-001.01 | T021, T023, T030, T031 | T028, T106, T107 |
| FR-001.02 | T034, T119 | T027, T028, T084, T106 |
| FR-001.03 | T034, T046, T119 | T027, T028, T084, T094 |
| FR-002.01 | T030, T032 | T028, T016 |
| FR-002.02 | T030, T031 | T028, T106 |
| FR-002.03 | T031, T062, T110 | T028, T106 |
| FR-002.04 | T030, T070 | T028, T066 |
| FR-002.05 | T030, T070, T071 | T028, T066, T077 |
| FR-003 | T035, T036, T090 | T029, T082 |
| FR-004 | T038, T055, T090 | T029, T053, T082, T124, T129 |
| FR-005 | T037, T055, T076 | T029, T066, T067 |
| FR-006 | T023, T025, T026, T047, T092 | T016, T084, T094 |
| FR-007 | T004, T018, T073, T086, T118 | T006, T067, T081, T123, T128 |
| FR-008 | T019, T074, T075, T087, T088 | T067, T083, T094 |
| FR-009 | T073, T101 | T067, T081, T096 |
| FR-010 | T025, T056, T071, T099, T103 | T016, T053, T095, T096 |
| FR-011 | T003, T013, T068, T069, T070 | T007, T066, T077, T122, T126, T127 |
| FR-012 | T003, T013, T068, T069, T075 | T007, T066, T077, T122, T126 |
| FR-013 | T004, T020, T072 | T006, T065, T077, T126 |
| FR-014 | T054, T055, T043, T076 | T050, T053, T077, T127 |
| FR-015 | T056, T057, T104 | T053, T066, T096, T105 |
| FR-016 | T019, T071, T074 | T066, T067, T077, T126 |
| FR-017 | T005, T039, T040, T041, T089 | T029, T082, T094, T127 |
| FR-018 | T041, T057, T089 | T029, T051, T082, T094 |
| FR-019 | T042, T043, T058, T060 | T050, T051, T052, T127 |
| FR-020 | T054, T055, T057, T060 | T053, T064, T082 |
| FR-021 | T026, T040, T045, T115 | T028, T106, T127, T130 |
| FR-022 | T024, T085, T092 | T016, T084, T094 |
| FR-023 | T088, T092 | T083, T084, T094 |
| FR-024 | T097 | T095, T105, T106 |
| FR-025.01 | T101 | T096, T105 |
| FR-025.02 | T073, T101 | T067, T096, T105 |
| FR-025.03 | T102 | T096, T105 |
| FR-025.04 | T045, T046, T102 | T096, T105 |
| FR-025.05 | T036, T101 | T082, T096, T105 |
| FR-026 | T047, T063 | T027, T053, T084 |
| FR-027.01 | T048, T108, T109, T062, T110, T114 | T106, T107, T120 |
| FR-027.02 | T108, T112, T118 | T106, T120 |
| FR-027.03 | T033, T034, T111, T119 | T028, T084, T106 |
| FR-027.04 | T034, T111, T119 | T028, T106 |
| FR-027.05 | T046, T111 | T084, T106 |
| FR-028 | T021, T023, T103, T109, T113, T116, T117 | T028, T106, T107, T120 |
| FR-029 | T058, T100, T111 | T106, T120 |
| FR-030 | T018, T019, T075, T088 | T067, T081, T083, T094 |
| FR-031 | T087, T088, T114 | T083, T094, T106 |
| FR-032 | T004, T020, T021, T072, T112, T116, T117 | T006, T065, T107, T120 |
| FR-033 | T004, T020, T022, T070, T072, T112 | T006, T007, T065, T077, T126 |
| FR-034.01 | T085, T086, T089, T090 | T081, T082, T094, T123, T128 |
| FR-034.02 | T091 | T084, T094 |
| FR-034.03 | T060, T091 | T084, T094 |
| FR-035 | T086, T099 | T081, T084, T095 |
| FR-036 | T024, T085, T093 | T084, T094 |
| FR-037 | T098 | T095, T105, T106 |
| FR-038 | T068, T069, T099 | T007, T066, T095, T126 |
| FR-039 | T100 | T095, T105, T106 |
| FR-040.01 | T044, T045 | T027, T028, T125, T130 |
| FR-040.02 | T045, T046, T073 | T027, T028, T084, T094 |
| FR-040.03 | T046, T089, T091 | T027, T028, T084, T094 |
| FR-040.04 | T046 | T027, T028, T084, T094, T125, T130 |
| FR-040.05 | T046, T091 | T028, T082, T084 |
| FR-040.06 | T046, T091 | T028, T082, T084, T094 |
| FR-040.07 | T046, T073 | T027, T067, T084 |
| FR-040.08 | T046, T062, T110 | T027, T084, T106 |
| FR-040.09 | T091 | T084, T094 |
| FR-040.10 | T044, T045 | T008, T027, T028, T125, T130 |
| FR-040.11 | T045, T111 | T027, T028, T106, T125, T130 |
| FR-040.12 | T005, T044 | T008, T029, T051, T125, T130 |
| FR-040.13 | T045, T046, T060, T091 | T027, T052, T084, T094 |
| FR-040.14 | T044, T045 | T008, T027, T028, T096, T125, T130 |
| FR-040.15 | T045, T102, T062, T110 | T027, T096, T106 |
| FR-041.01 | T044, T058, T059 | T051, T052, T064 |
| FR-041.02 | T043, T058 | T027, T051, T064 |
| FR-041.03 | T058 | T008, T029, T051 |
| FR-041.04 | T058 | T051, T052, T064 |
| FR-041.05 | T044, T058, T111 | T051, T106 |
| FR-041.06 | T043, T058 | T050, T051, T064 |
| FR-041.07 | T058, T059 | T051, T052, T064 |
| FR-041.08 | T044, T058, T111 | T051, T082, T106 |
| FR-042.01 | T022, T030, T032, T042 | T008, T050, T051 |
| FR-042.02 | T042 | T050, T051, T064 |
| FR-042.03 | T042 | T008, T051, T064 |
| FR-042.04 | T042, T058 | T050, T051 |
| FR-042.05 | T042 | T008, T050, T051 |
| FR-042.06 | T042, T058 | T050, T051 |
| FR-042.07 | T042, T043 | T050, T051 |
| FR-042.08 | T043 | T050, T051, T064 |
| FR-042.09 | T022, T042, T111 | T051, T106 |
| FR-043.01 | T059, T061 | T052, T064 |
| FR-043.02 | T040, T061 | T051, T052 |
| FR-043.03 | T059, T061 | T027, T052, T064 |
| FR-043.04 | T059 | T052, T064 |
| FR-043.05 | T059, T085, T062, T110 | T052, T084, T106 |
| FR-043.06 | T059, T062, T110 | T052, T106 |
| FR-043.07 | T102 | T096, T105 |
| FR-043.08 | T057, T060 | T052, T053, T064 |
| FR-043.09 | T032, T033, T034, T060 | T027, T028, T052, T084 |
| FR-043.10 | T060 | T027, T052, T084 |
| FR-043.11 | T045, T058, T060 | T052, T064 |
| FR-043.12 | T059, T111 | T052, T106 |
| FR-043.13 | T045, T046, T059, T091 | T027, T052, T084 |
| FR-044.01 | T025, T033 | T016, T027, T028, T094 |
| FR-044.02 | T034, T046 | T027, T028, T084, T094 |
| FR-044.03 | T033 | T027, T028, T084 |
| FR-044.04 | T033, T034 | T027, T028 |
| FR-044.05 | T033, T034 | T027, T028 |
| FR-044.06 | T024, T085, T119 | T084, T094, T106 |
| FR-044.07 | T033, T034, T111, T119 | T028, T084, T106 |
| FR-045.01 | T115 | T106, T120 |
| FR-045.02 | T031, T115 | T028, T106, T120 |
| FR-046.01 | T021, T023, T062, T110 | T052, T106, T107 |
| FR-046.02 | T030, T031, T032, T062, T110 | T052, T028, T106 |
| FR-046.03 | T061, T062, T110 | T052, T051, T106 |
| FR-046.04 | T062, T110 | T052, T106, T120 |
| FR-046.05 | T059, T061, T062, T110 | T052, T106 |
| FR-046.06 | T059, T062, T110 | T052, T106 |
| FR-046.07 | T046, T091, T062, T110 | T052, T084, T106 |
| FR-046.08 | T045, T062, T110 | T052, T027, T106 |

## Notes

- Backlog ban đầu có 134 task; bổ sung T135–T139 đưa tổng số lên 139, giữ 117 mã nghĩa vụ FR và thêm coverage M/H trong hợp đồng chế độ. Trạng thái thực tế nằm ở từng checkbox và bằng chứng tương ứng; cập nhật tài liệu không tự đánh dấu triển khai hoặc nghiệm thu xong.
- Giữ trọn scope gộp hai mốc của feature 002; không tự giảm crash/smoke hoặc thêm retry/amend/merge để né blocker.
- S0.1–S0.3 và go/no-go là các gate cần bằng chứng/quyết định thật. Không tự đánh dấu checkbox từ việc đọc tài liệu, viết test chưa chạy hoặc owner chưa trả lời.
- Worktree/diff/local commit chưa bảo toàn không bị xóa vì log retention hoặc task DONE. Snapshot/FrozenPolicy/event v1 và raw hash lịch sử giữ nguyên.
- Sau thay đổi mã/cấu hình phải qua bốn quality gates riêng; lượt tạo tasks.md chỉ kiểm tài liệu, không tuyên bố runtime/test/smoke đã đạt.

## Đối chiếu Phase 3 đã làm theo backlog cũ

PR #8 và #9 đã bổ sung hợp đồng sau khi Phase 3 có thể đã được triển khai theo bản trước.
Khi đồng bộ branch, giữ thay đổi đang làm và bằng chứng cũ; không ghi đè toàn bộ tasks.md bằng
một phía hoặc coi checkbox cũ là bằng chứng cho yêu cầu mới. Lập bảng delta theo task/yêu cầu,
đánh dấu phần chưa kiểm/thiếu, sửa triển khai rồi kiểm lại đúng phạm vi trước khi tick bổ sung.
Không tự reset trạng thái mọi task hoặc đánh dấu T135–T139 xong từ kết quả baseline cũ.

| Phạm vi | Nội dung cần đối chiếu | Bằng chứng cần bổ sung |
| --- | --- | --- |
| T030–T032, T048 / T135 | Hai mode, giữ xác nhận intake mặc định, xác nhận binding/effort/mode trước spawn rồi freeze đúng bộ lựa chọn và merge.method dự kiến | Direct không cần reviewer capability; thiếu/stale/giả xác nhận không spawn; replay không đổi xác nhận; method mặc định/override/invalid/freeze đúng, không chặn admission chỉ vì method GitHub tắt |
| T037, T040–T041 / T136 | Template frozen, worker message/title/body, schema artifact và marker do orchestrator quản lý | Đọc đúng template, body mới sau sửa, chặn marker giả cả hai mode, probe/recovery đúng identity |
| T038–T039 / T137 | Gates cùng đạt tree cuối, commit trước review, no-op giữ checkpoint | Gate sửa code phải kiểm lại có giới hạn; mutation/drift chặn publish; không commit chỉ vì step chạy |
| T043, T047 / T137 | Green theo mode, reuse evidence hợp lệ và tôn trọng blocker khi callback A đến muộn | Không giả approve cho direct; không review thừa; H01/H02 inject fact ở baseline, H03/H04 tại boundary publish |
| T045, T111 | Method merge thủ công đề xuất và kết quả thực tế | Khác/unknown method không chặn proof/drain/DONE hoặc tự gây unverified; audit có provenance, không đoán method hoặc gửi merge |
| T027–T029, T049 | Oracle/suite và báo cáo baseline theo yêu cầu mới | Cả hai mode, xác nhận, artifact, final-tree/exact-SHA push; ghi M/H đã kiểm ở baseline và phần còn chờ US2/US4/B theo ánh xạ, không lấy test review luôn bắt buộc làm oracle cho direct |

Không cần làm lại toàn bộ Phase 3: giữ phần vẫn đúng và test còn giá trị. T138 vẫn thuộc US4,
không là prerequisite ngược của T049/T064. T139 kiểm tổng hợp sau T064/T077; H05 crash I/O ở
T082/T093 thuộc B không được kéo lên chặn A. Bảng này là hướng dẫn đồng bộ, không khẳng định
worker hoặc runtime đã sửa/kiểm xong và không thay đổi thứ tự phụ thuộc hiện có.

Trạng thái đối chiếu (2026-10-29, nhánh `002/preflight`): các dòng trên đã được sửa và kiểm lại trong
Phase 3; ghi chú "Đối chiếu 2026-10-29" ở từng task nêu phần đổi và test. T135–T137 tick với phần chưa
nối ghi rõ (cập nhật mô tả PR sau sửa ở T055/T057, H06/observer ở T051/T058, crash H05 ở T082/T093,
real harness/resume ở T138). Báo cáo baseline: [acceptance-report.md](acceptance-report.md).

## Bổ sung 2026-10-29 — hai chế độ và xác nhận trước spawn

Các task này chưa làm. Chúng bổ sung cho các phase cũ, không phải công việc chỉ cần thực hiện sau
T134: US1 nối T135 sau T030/T031 trước T032, T136 sau nền context/Git, T137 trước T043/T047/T049.
US1/US2 dùng fake harness/session để kiểm flow và quyết định resume, không đợi T138. T138 thuộc
US4 sau T068–T071, trước T077. T139 sau T064/T077 và T135–T138, trước T078/go-no-go và báo cáo
T131/T133. Giữ điều kiện gate/go-no-go của feature.

- [x] T135 Định nghĩa schema/config và confirmation contract tại `src/domain/`, `src/config/`, `src/application/confirm.ts`, `src/policy/freeze.ts`, `src/cli/cusr.ts`: hai mode tường minh; project merge là object closed chỉ có method enum squash/merge/rebase, default squash nếu thiếu object/key, sai kiểu/enum/key lạ báo lỗi; freeze method cho task mới, không rewrite snapshot/hash cũ và không mở quyền merge/yolo; chỉ dẫn `when to use` cho agent nhận task, đề xuất harness/model/effort và reviewer nếu cần; bằng chứng xác nhận từ kênh người dùng đáng tin gắn task/revision/digest, không tin cờ assistant tự khai, không nâng scope operate. Thiếu/stale xác nhận không spawn; config hiệu lực đổi hỏi lại, replay/restart không mất xác nhận; auto-confirm intake không miễn xác nhận chạy. Daemon không tự chọn theo size/rủi ro hoặc quota; fallback/escalation chỉ trong bộ đã duyệt, quyền admin giữ nguyên (M01/M02).
  - Kết quả T135: `src/domain/run-config.ts` (mode, `RunSelection` gắn task/revision/profile/mode/worker/reviewer/fallback/lý do, digest, xác nhận có actor/kênh/thời điểm, kênh tin cậy chỉ `token:owner`); trigger `propose_run_config`/`confirm_run_config`, event `RunConfigProposed`/`RunConfigConfirmed` (ghi bền, replay giữ nguyên); `runtime.modes.<mode>.when_to_use` trong user config (chỉ dẫn cho agent, daemon không đọc; khai báo thì là allowlist mode). Engine từ chối xác nhận sai digest/không tin cậy/sau start, đề xuất sau start (`run_config_frozen`, đổi mode cần task mới). Scheduler chỉ xếp hàng task đã xác nhận; start kiểm lại khớp binding hiệu lực; attempt dùng binding worker ngoài bộ đã duyệt thì chờ. Auto-confirm intake chưa có (intake assistant vẫn cần xác nhận) và không miễn xác nhận chạy. Test `execution-modes.test.ts`, `confirm-start.test.ts`, `scheduler.test.ts`, `task-cli.test.ts`, `preflight.test.ts`. Chưa có: kênh tin cậy khác owner token (spec 003), đề xuất theo quota.
  - Kết quả merge.method (2026-10-29): `src/domain/merge-method.ts` (`MERGE_METHODS`, default squash, `resolveMergeMethod`), normalized project chỉ có `merge_method` khi khai báo; không mở quyền merge/yolo.
- [x] T136 Sau T135 và nền context/commit/GitHub T037/T039/T040/T041 của US1, bổ sung template/output artifact tại `src/adapters/context.ts`, `src/adapters/harness/result-schema.ts`, `src/adapters/git/commit.ts`, `src/adapters/github/publish.ts`: template frozen, nhiều template chọn tường minh, không có template vẫn viết description; worker chuẩn bị message/title/body ngoài code, message artifact hiện hành được cung cấp cho người squash thủ công (không gửi merge trong 002), cập nhật sau fixer/CI, orchestrator validate/publish không hiểu heading. Từ chối namespace marker điều khiển trong title/body worker theo cùng chuẩn hóa parser, chỉ orchestrator gắn một block canonical; intent lưu digest body cuối, probe không nhận marker từ worker. Version hóa schema/capability khi cần, giữ fixture/event cũ; update body cùng PR có receipt/probe, không ghi đè drift. Fake contract kiểm tại US1, real output nối ở US4 (M05/M07).
  - Kết quả T136: worker ghi `{commit_message, pr_title, pr_body}` vào file JSON riêng từng operation ngoài worktree; `src/adapters/publish-content.ts` kiểm schema/kích thước, chuẩn hóa (NFKC, bỏ ký tự ẩn, entity) và từ chối namespace `<!-- cusr:`, lưu theo digest ngoài code (`FileContentStore`); không đổi role result schema nên fixture/manifest cũ giữ nguyên. Template frozen ở snapshot runtime. `publish.ts`: chỉ orchestrator thêm block marker canonical cuối body, probe chỉ nhận block đó với body đúng digest đã gửi, `updatePrDescription` có đọc trước/đọc lại sau. Engine nhận nội dung qua `PublishContentRecorded`. Chưa nối: quyết định gọi cập nhật mô tả sau fixer/CI thuộc đường sửa T055/T057 (adapter và allowlist đã có); output harness thật ở US4.
  - Kết quả merge.method (2026-10-29): `cusr show` (`task_show`) trả `merge.method` frozen cùng PR title/commit message hiện hành của worker (đọc theo digest) để người merge thủ công dùng; 002 không gửi merge.
- [x] T137 Sau T135/T136 và nền T036/T038/T039, trước T043/T047/T049 trong US1, sửa/version hóa graph `src/engine/workflows/software-dev.ts`, evidence/Git adapters: gates → checkpoint commit → review chỉ `full-review` → publish đúng SHA; loại skip XS/ràng buộc vendor. Evidence gắn base/commit/tree/body; khóa công việc, process writer rõ, kiểm ref/tree/worktree trước push, drift giữ dữ liệu/chặn publish, code mới chạy gates trên tree cuối/commit/review theo mode. Chỉ step worker chạy không tự tạo commit hoặc vô hiệu evidence; no-op giữ checkpoint, review dùng lại approve/findings hợp lệ theo toàn bộ đầu vào, không gọi reviewer cho retry publish/poll/rerun CI/restart khi đầu vào không đổi; findings không đổi xử lý giới hạn sửa. `direct-pr` không gọi reviewer/giả approve; green/explain theo mode. Known blocker head_changed phải chặn cả callback/reuse approve A và publish đang pending (H01/H02); baseline US1 có thể inject normalized fact, không đợi observer T058 của US2. Guard chỉ cho effect merge nội bộ; merge thủ công là external observation. Baseline dùng fake harness/session, không phụ thuộc T138 (M03/M06/M08).
  - Kết quả T137: graph `software_dev@2:<mode>` dẫn xuất từ graph đã cấu hình (`modeGraph`): không skip XS, direct-pr không có bước review, autofix quay lại gates; FrozenPolicy ghi `workflow_name` theo mode, snapshot cũ không bị viết lại. Checkpoint commit cuối effect gates, review gắn checkpoint và input digest (`src/engine/review-evidence.ts`: task/revision, base, sha/tree/diff, nội dung PR không marker, context frozen, binding/ladder review, structure), dùng lại approve/findings khi input không đổi, nội dung hoặc commit đổi thì review lại; publish đúng SHA; fact `head_drift` (observation/publish_probe/worktree) chặn mọi effect nghiệp vụ và routing, approve A muộn chỉ là lịch sử; green và merged-head theo mode. Baseline dùng fact inject (H01/H02), probe publish thật (H03), Git thật (H04), replay log (phần replay của H05). H06 và observer đầy đủ thuộc T051/T058; crash I/O H05 thuộc T082/T093.
- [x] T138 Trong US4, sau T135 và T068–T071, trước T077; không phải prerequisite T049/T064. Nối session port fake đã dùng ở US2 sang real harness tại `src/runner/invocation.ts` và session context: mỗi lần sửa, kể cả resume, dựng packet mới có nguyên nhân/log/findings/SHA/run generation, acceptance/checkpoint/worktree/diff, PR content và Q&A, ghi digest/provenance; packet stale dựng lại, thiếu bắt buộc chờ needs_context. Ưu tiên resume worker đã code với binding hợp lệ, fallback có lý do/context, reviewer riêng session, không giữ process sống khi chờ hoặc hai writer. Retry trong bộ đã duyệt không hỏi lại; thay ngoài bộ cần xác nhận mới, quota không hạ mode. Kiểm real adapter bằng fixture/protocol/OS hiện có; paid invocation vẫn theo quyền/budget riêng (M02/M04).
  - Kết quả T138: `RunnerHarness` (`src/runner/invocation.ts`) là session port thật: handler chỉ truyền session khi manifest chứng minh resume và adapter có dạng resume pinned (Claude `--resume`; Codex không có → `resume: unsupported`, phiên mới với lý do); reviewer không resume; packet sửa luôn dựng mới bởi handler; không giữ process sống khi chờ. Kiểm bằng fixture/protocol/process thật (`harness-invocation.test.ts`, `feature-002-real-adapters.test.ts`); manifest T007 vẫn `session_resume: unknown` nên resume thật chưa được dùng, paid invocation vẫn cần quyền/budget riêng.
- [x] T139 Sau T064/T077 và T135–T138, trước T078/go-no-go, kiểm tổng hợp M01–M08 bằng property/admission, SQLite confirmation/dedup/restart và Git/process/HTTP contract: forged/stale confirmation, direct không reviewer capability, full cùng vendor riêng session, template/fixer output, marker giả/nhân đôi ở title/body direct lẫn full, probe không nhận PR giả, mutation gate/review/push, exact-SHA publish, gate/formatter đổi tree sau gate trước (kiểm lại tập gate, có trần), body drift/timeout/crash, mode-aware green/manual merge. Kiểm resume nhận packet mới sau Q&A/CI/fixer và packet stale bị chặn; no-op giữ SHA/reuse approve, request_changes không đổi giữ findings không gọi reviewer, đầu vào code/body/acceptance/policy đổi bắt review; restart nhận lại finalized review trước gọi lại và không tạo usage giả. Ghi bằng chứng H01–H06 riêng: hai thứ tự callback/observation, pending publish/probe chặn, bare Git conditional update sau probe, replay/SQLite giữ drift và đối chứng chỉ base tip đổi; crash I/O mở rộng H05 ở T082/T093, không là prerequisite của gate A. Kiểm merge.method default/ba enum/invalid/key lạ, freeze/config đổi và replay cũ; repo không bật squash không chặn admission 002; manual merge khác/unknown method vẫn DONE theo proof/drain, method mismatch không tự gây unverified và không có merge request. Cập nhật acceptance map/report/quickstart; fixture không thay real output proof, invocation thật cần quyền/budget. Không đánh dấu feature hoàn tất khi M chưa đạt.

  - Rà T139 trong Phase 6 (2026-10-29): thêm `feature-002-gate.test.ts` (5 test) cho confirmation/dedup qua đóng-mở SQLite thật, hai thứ tự callback/drift sau reopen, projection và không tính usage lại; review input đổi context/acceptance, base hoặc policy không reuse. M01–M08/H01–H06 có matrix trong `acceptance-report.md`. Audit lượt đầu còn thiếu coverage tổng hợp same-vendor reviewer riêng session, Q&A/resume/stale packet ngay trước spawn, nhận lại finalized review từ file trước gọi lại và toàn bộ ma trận merge.method freeze/replay. Crash I/O rộng H05 vẫn thuộc B (T082/T093), không kéo ngược thành điều kiện A.

  - Hoàn tất T139 (2026-10-29, sau `5bda3ee`): bổ sung 31 cases, full default **106 file/1.462 test, 0 skip**, seed 20261029; typecheck/lint/build exit 0. [Matrix M01–M08/H01–H06](acceptance-report.md#t139--kiểm-tổng-hợp-m01m08-và-h01h06), [ledger/hash](evidence/t139-validation.json). Cùng vendor/model chạy dưới bwrap với reviewer ro/session riêng; Q&A hiện hành qua CI/resume, packet stale rebuild tối đa một lần rồi chờ người; finalized review + proof ghi nguyên tử sau boundary và được nhận lại từ disk, không spawn/usage trùng; method/template/marker/replay đủ ma trận local. Legacy thiếu proof giữ unknown; không nâng capability vendor thật hoặc chứng nhận paid smoke/≥200 crash B. T072/T078/T080 còn riêng, B chưa mở.
