# Tasks: Task tới PR xanh và ghi nhận merge thủ công

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md), [hiến chương](../../.specify/memory/constitution.md).

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
- [ ] T020 [P] Xây implementation duy nhất rootless bwrap của port SandboxProvider T013 và private home tại `src/runner/sandbox.ts`, `src/runner/private-home.ts` từ proof T006/T007; Isolated bắt buộc cho harness/setup/gate/autofix, không gate theo tên AppArmor profile. Coder/fixer rw worktree/scratch, reviewer ro repo, Git metadata ro, prompt/schema ro, toolchain mount riêng; không mount host home/proc, DB/socket/bus/GitHub/SSH/docker/admin/operate token; gate/setup không có model auth, network internet_outbound ghi rõ. Theo giới hạn owner chấp nhận khi đóng T006: ghi (dev, ino) từng nguồn mount lúc plan và kiểm lại ngay trước/trong khi exec bwrap (hoặc mount qua fd), lệch thì fail closed; tái dùng `scripts/spike-002/probe-mount-toctou.ts` làm regression.
  - Tiến độ T020 (chưa tick): `BwrapSandboxProvider` + `private-home.ts` đã có, launcher `src/runner/sandbox-exec.py` (bản đã chứng minh ở S0.1) mở lại nguồn mount bằng O_PATH, so (dev, ino)/realpath rồi bind theo FD, lệch thì exit 125. Unit test policy/private home pass; `test/integration/runtime/sandbox-bwrap.test.ts` (ghi/đọc theo role, PID/CapEff, race TOCTOU) còn chờ chạy trên host có user namespace, vì sandbox của phiên agent chặn uid map. Sửa kèm: `RunDir.resolve` trả đủ đường dẫn khi nhiều thành phần cuối chưa tồn tại.
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

- [ ] T027 [P] [US1] Thêm property regression tại `test/property/invariants/runtime-slot.test.ts`, `test/property/invariants/external-completion.test.ts` và `test/property/invariants/required-subset.test.ts` cho selector, dependency sau DONE, completion-before-deadline/drift, terminal không mở lại, G⊆S/none-vs-unknown/app-pinned và green predicate đúng head; bao phủ FR-001.02/03, FR-040.01–15 và FR-044.01–07 bằng assertions riêng.
  - Tiến độ T027 (chưa tick): `test/property/invariants/runtime-slot.test.ts` đã có (oracle selector, total order, không preempt, grant/release qua store). Còn `external-completion.test.ts` (chờ T045) và `required-subset.test.ts` (chờ T042).
- [ ] T028 [P] [US1] Viết suite `test/integration/runtime/feature-002-flow.test.ts` với bare Git/fake harness/HTTP/Clock: baseline US1.1–6, US1.8 qua confirm mới, US1.9–10 qua facts operation/merge có provenance và dependency core, US1.11 qua initial/resumed slot facts; request dedup/conflict, PENDING không thực thi, snapshot duy nhất trước RUNNING, một slot, PR xanh/chờ merge, merge drain/dependency; ghi seed/request/effect ledger. T049 chạy baseline, T064/T078 bổ sung US1.7 và đường fixer/deadline đầy đủ; recheck và CLI explain assertions US1.8/10/11 phải được T106/T120 kiểm sau service/UI tương ứng, không bỏ scenario khỏi nghiệm thu cuối.
- [ ] T029 [P] [US1] Viết contract tại `test/contract/git-worktree.test.ts`, `test/contract/publish.test.ts`, `test/contract/context-gates.test.ts`, `test/contract/github-checks.test.ts`: known/none/unknown, current run/status SHA/generation, positive gate/review+check evidence và non-success không xanh; ownership/path/ref collision, deterministic commit receipt, FF push expected SHA, PR all-state probe/422/unknown, checkpoint và frozen command, context thiếu/oversize.

### Implementation for User Story 1

- [ ] T030 [US1] Tạo `src/application/preflight.ts` đọc base/config từ Git objects mới nhất với ports, kiểm project realpath/common dir/remote immutable identity, workflow software_dev@1/human/roles/review/CI/budget/capability; lỗi trước RUNNING PENDING config_invalid/capability_missing, lỗi sau RUNNING WAITING/policy, không bỏ role hoặc đổi binding (FR-002.01–05).
- [ ] T031 [US1] Tạo `src/application/triage.ts`, `src/application/confirm.ts` nối intake/acceptance/dependency/quyền hiện có; confirm sớm chỉ candidate, chỉ request mới thử lại base/capability, không poll base, request cũ không đổi snapshot/kết quả (FR-001.01, FR-002.02/03).
- [ ] T032 [US1] Nối `src/engine/start.ts`, `src/policy/freeze.ts`, `src/application/start.ts` chốt PolicyFrozen/context/runtime cùng accept trước RUNNING rồi worktree; “Ghi cùng PolicyFrozen/context trước RUNNING; chỉ reference credential, không secret; không thay hash snapshot lịch sử”; stale candidate/version/base conflict, không hai snapshot cùng task/revision.
- [x] T033 [US1] Tạo selector thuần `src/engine/execution-slot.ts` và nối `src/engine/decide.ts`: “Priority số lớn trước, default 0 theo SPEC §6.2; một yêu cầu đang chờ/task; grant/withdraw đóng đoạn chờ, không dùng created_at thay requested_at”, resumed trước fresh cùng priority, hòa requested_at rồi request_global_seq; “Singleton toàn daemon; một holder, có thể nhiều operation phục vụ dừng/đối chiếu cùng task”, không preempt.
  - Kết quả T033: `compareRequests`/`orderQueue`/`selectNext` thuần tại `src/engine/execution-slot.ts` là nguồn thứ tự duy nhất; `readQueue` và `grantNext` của store dùng selector (không còn ORDER BY riêng). Slot đang giữ luôn trả `busy`, không preempt. Hàng chờ một-request/task và đóng đoạn chờ khi grant/withdraw đã có từ T025.
- [ ] T034 [US1] Tạo `src/daemon/scheduler.ts`, `src/application/dependency.ts`: fresh giữ READY chưa deadline, resumed WAITING/execution_slot tính deadline cũ, trả slot khi process/effect rõ dù còn CI/merge/human/cooldown; dependency chỉ sau DONE, kể cả unverified, lưu provenance để explain và kiểm lại điều kiện riêng (FR-001.02/03, FR-044.01–07).
- [ ] T035 [P] [US1] Tạo Git argv port tại `src/adapters/git/command.ts`: env/config allowlist, empty hooks, trusted credential helper, safe.directory cụ thể, deadline/output cap, không shell cho lệnh Git orchestrator và không tin executable/config từ repo.
- [ ] T036 [US1] Tạo `src/adapters/git/worktree.ts`, `src/adapters/git/checkpoint.ts` cho branch cusr/task-slug, marker ngoài agent rw, checkpoint tree/parent/diff digest; “Không nhận lại theo tên path đơn thuần; SHA/tree/ownership phải đối chiếu”, mismatch/missing giữ diff/chờ, không reset/xóa repo gốc (FR-003).
- [ ] T037 [US1] Tạo `src/adapters/context.ts` từ acceptance/revision bất biến, frozen binding và bước hiện tại, lỗi fixer/diff reviewer; cap 128 KiB/context, 64 KiB/diff, digest/path list/truncation marker, strip secret/control syntax; thiếu acceptance/diff bắt buộc thì facts needs_context, không gọi agent (FR-005).
- [ ] T038 [US1] Tạo `src/runner/commands.ts`, `src/adapters/gates.ts` chạy snapshot setup/gate/autofix bằng /bin/sh -c trong sandbox, default 10 phút và deadline còn lại, checkpoint trước ghi, receipt + declared retry safety; unknown lệnh không-safe chờ người (FR-004).
- [ ] T039 [US1] Tạo `src/adapters/git/commit.ts` lưu commit intent tree/parent/author/committer time/message/OID trước CAS ref; tạo head gắn gate/review đúng tree/SHA, probe nhận lại đúng OID sau timeout, không commit thứ hai hoặc reset HEAD đoán (FR-017/018).
- [ ] T040 [P] [US1] Tạo `src/adapters/github/gh-port.ts` từ spike gh fixture: pinned binary/API 2026-03-10, argv allowlist GET/POST PR/rerun, không merge method, GH_PROMPT_DISABLED=1/pager off, timeout/bytes/pages/calls/retry cap, credential chỉ ở orchestrator, raw evidence redact/digest (FR-017/018/021).
- [ ] T041 [US1] Tạo `src/adapters/git/push.ts`, `src/adapters/github/publish.ts`: repo/head/base/operation key ổn định, FF expected-old/new SHA, probe remote/PR mọi state trước retry kể cả 422; nhiều PR/identity mismatch/remote diverged giữ unknown/head_changed, không force hoặc PR thay thế (FR-017/018).
- [ ] T042 [US1] Tạo evaluator thuần `src/engine/required-checks.ts` và normalizer `src/adapters/github/requirements.ts`: known/none/unknown, đọc đủ classic+active rules, any-app absent/null/-1 theo pinned schema, app cụ thể luôn mismatch, G⊆S không sửa snapshot, nguồn/tên mơ hồ không gộp; “none có evidence dương đầy đủ; unknown không được chuẩn hóa thành mảng rỗng” (FR-042.01–09).
- [ ] T043 [US1] Tạo `src/adapters/github/checks.ts`, `src/engine/head-evidence.ts` chọn current run/status generation đúng SHA; chỉ success mọi check snapshot cùng gate/review còn hiệu lực mới xanh, neutral/skipped/pending/cancelled/missing/unknown không pass, collision policy; expected/checked head và CI budget không đổi bởi head bên ngoài (FR-019/041.06/042.08).
- [ ] T044 [US1] Tạo `src/adapters/github/observe.ts`, `src/adapters/github/merge-proof.ts` đọc PR→rules/checks/status→PR, validate identity/completeness/head/generation và merge proof riêng với quality completeness; proof đúng target/repo/head-at-merge/merge commit theo fixture T008, thiếu proof trả unknown, không suy từ closed/missing branch/squash OID (FR-040.10/12/14, FR-041.01/03/08).
- [ ] T045 [US1] Tạo `src/engine/external-completion.ts`, nối `src/engine/interpreter.ts`, `src/engine/merge-guard.ts`: external_confirmation chờ merge, không giả approval/merge effect hoặc đòi head chứa base mới nhất; merge fact bền invalidate pending business/timers, lưu merged/checked head/unverified disclaimer, completion ưu tiên drift/deadline, không mở terminal (FR-021, FR-040.01–03/10–15).
- [ ] T046 [US1] Tạo `src/engine/drain.ts`, `src/daemon/drain.ts`: sau merge chỉ stop/reconcile process/effect đã gửi, giữ claim khi unknown, nhận late push không proceed/retry, giữ local_remainder; “Chỉ ghi cùng TaskCompleted sau predicate drain hoàn tất”; cap 5 phút/3 vòng, TERM 10 giây/KILL verify 5 giây, paused merge_cleanup_pending có recheck, TaskCompleted/release/dependency đúng một lần (FR-040.04–09/13).
- [ ] T047 [US1] Nối fake harness/gates/publish/observation/drain và ingest kết quả nguyên tử vào `src/daemon/dispatch.ts`, `src/daemon/ingest.ts`; claim lại completion/version trước effect, source-drift không dispatch bước mới, normalized facts đi qua engine/store, adapters không chọn task status (FR-006/010/014/026).
- [ ] T048 [US1] Nối lệnh tối thiểu add/show/confirm tại `src/cli/cusr.ts`, `src/application/queries.ts`, `src/daemon/server.ts` qua UDS/application authz/dedup để chạy flow fake có version/request ID/PR/head; không truy cập DB trực tiếp; giao diện đầy đủ ở US6.
- [ ] T049 [US1] Chạy baseline T027–T029 sau T042/T043 và ghi kết quả tại `specs/002-task-to-green-pr/acceptance-report.md`: happy path thật qua evaluator tới PR xanh/chờ merge rồi proof/drain/DONE, một worktree/branch/PR, dependency core chỉ sau DONE, zero merge requests. Ghi riêng assertion đã chạy và phần chờ US2/T064/T078 (US1.7, fixer/deadline đầy đủ), US6/T106/T120 (recheck/CLI explain của US1.8/10/11); không ghi US1.1–11 đã đạt toàn bộ tại checkpoint này.

**Checkpoint**: US1 có happy path xanh qua evaluator và completion an toàn với fake; scenario tích hợp vòng sửa/deadline được kiểm tiếp tại T064/T078, recheck/CLI explain tại T106/T120. Vòng sửa US2 và bằng chứng quyền/harness US4 vẫn bắt buộc trước gate A; không coi baseline là nghiệm thu toàn bộ US1.

## Phase 4: User Story 2 — Sửa gate/review/CI trong giới hạn (P1, lát A)

**Goal**: Chỉ xanh theo đúng head với gate/review/checks hợp lệ; sửa/rerun hữu hạn, quan sát độc lập deadline thực thi.

**Independent Test**: Script fake gây gate fail/review changes/CI code/infra/flaky/rate-limit/auth/refusal/invalid/unknown, rồi tiến Clock qua CI/task/observation limits; assertions không vượt lượt, không reuse evidence cũ, không gọi agent trong observation.

### Tests for User Story 2

- [ ] T050 [P] [US2] Viết/mở rộng property tại `test/property/invariants/runtime-evidence.test.ts`, `test/property/invariants/required-subset.test.ts` cho gate/review/CI cùng SHA, actual diff vendor, G⊆S, none khác unknown, app-pinned mismatch và không union snapshot; mở rộng required-subset suite đã viết tại T027 cho các permutations/races, giữ legacy merge-guard regression (FR-014/019, FR-042.01–09).
- [ ] T051 [P] [US2] Viết `test/contract/github-observation.test.ts` với fake HTTP/gh port: classic+active/inherited rules/enforcement/pagination, 401/403/404/5xx/timeouts, app identity/collision, PR read-before/after race, rerun pending che success cũ và all check non-success states (FR-041.01–08, FR-042.01–09).
- [ ] T052 [P] [US2] Viết `test/property/invariants/runtime-limits.test.ts` và `test/integration/runtime/observation-limits.test.ts`: deadline/count/backoff/generation/restart/recheck, CI pass muộn, PR closed/reopen/head/base change, observation sau task deadline và drain không bị giới hạn khác chặn (FR-043.01–13).
- [ ] T053 [P] [US2] Viết `test/integration/runtime/feature-002-fixes.test.ts` cho US2.1–11 và SC-003, thêm US1.7/US1.9/US1.11 với đường sửa/deadline thực; recheck gọi service T062 trực tiếp, approval dùng scoped engine facts (application approval/admin-denial kiểm ở T096/T107), ledger repair/resume/rerun/approval/reservations, policy invalid-output/timeout/infra caps, auth/refusal không né quyền, head cũ không làm xanh head mới.

### Implementation for User Story 2

- [ ] T054 [US2] Mở evidence invalidation tại `src/engine/effects.ts`, `src/engine/context.ts`, `src/engine/evolve.ts`: code/tree/head/revision thay đổi vô hiệu gate/review/CI liên quan, reviewer khác vendor coder/fixer thực tạo diff lấy từ manifest+FrozenPolicy, thiếu binding hợp lệ chờ người (FR-014).
- [ ] T055 [US2] Nối vòng gate fail/review changes vào `src/engine/interpreter.ts`, `src/adapters/context.ts`: fixer nhận log/acceptance đúng revision có cap, sửa lại gate rồi review trước publish, giữ PR/worktree hiện có (FR-004/005/014/020).
- [ ] T056 [US2] Nối facts runner/harness với `src/engine/classify.ts`, `src/engine/failure.ts`, `src/engine/budget.ts`, `src/engine/escalation.ts`: infra≤3 retry, timeout/stall≤1 retry, invalid≤1 repair+1 session mới/nấc, auth/refusal chờ, unknown probe; rate-limit/infra không nâng model, total wall/attempt cap ưu tiên, repair/resume/rate-limited call đã chạy đều tiêu lượt (FR-010/015).
- [ ] T057 [US2] Tạo `src/adapters/github/rerun.ts` và nối CI fix tại `src/engine/interpreter.ts`: code fix→gate/review→cùng PR/head mới; infra/flaky rerun chỉ có fact phân loại+policy/budget+run generation cụ thể, POST unknown không gửi lại khi chưa chứng minh chưa xảy ra (FR-018/020).
- [ ] T058 [US2] Tạo `src/engine/observation.ts` cho head_changed/target_mismatch/required_checks_mismatch/pr_closed/reopen/read unknown: thu hồi xanh đúng nguyên nhân, không PR thay thế/chấp nhận head mới/rebase, base tip đơn lẻ chỉ ghi thông tin; target branch khác snapshot→WAITING/policy target_mismatch, read unknown→WAITING/infra, preserve blockers và freshness (FR-041.01–08).
- [ ] T059 [US2] Thêm observation budget vào `src/engine/observation.ts`, `src/engine/backoff.ts`, `src/store/timers.ts`: 30 ngày từ PR nhận diện đầu/2.000 lượt, poll 60 giây×2 tới 1 giờ, remote đổi chỉ reset cadence; generation chống chain trùng, exhausted hủy timer, terminal/merge dừng poll, restart/recheck không reset (FR-043.01–07/12/13).
- [ ] T060 [US2] Mở `src/engine/budget.ts`, `src/engine/claim.ts`, `src/engine/waits.ts` cho CI per-head 1 giờ/60 poll hoặc frozen step timeout, task deadline chỉ từ lần chạy đầu và tiếp tục khi xin lại slot; exhausted không mở agent/rerun dù CI pass muộn, observation còn hạn tiếp tục, stop/reconcile sau merge có hạn riêng (FR-043.08–11/13).
- [ ] T061 [US2] Tạo `src/daemon/observation.ts` coalesce timer/recheck/recovery/cancel cùng PR/generation, 60 giây/100 calls mỗi round, ≤20 trang×100 records/list, ≤2 MiB/response, ≤3 sends/request chờ 1/2 giây; Retry-After vượt cap trả unknown/hẹn sau trong hạn, 304 chỉ reuse cache provenance đầy đủ; không giữ slot hoặc gọi agent (FR-043.01–06).
- [ ] T062 [US2] Tạo service recheck dùng chung tại `src/application/recheck.ts`, nối `src/engine/decide.ts`, `src/daemon/observation.ts`, `src/daemon/drain.ts` sau T030/T031/T032/T046/T059/T060/T061 và command ledger T023: operate/project/version/request dedup, PENDING chỉ triage/preflight base mới qua điều kiện cũ, PR một lượt observe, merge_cleanup một lượt stop/probe≤60 giây kể cả hết hạn; coalesce cùng observation, giữ timer/budgets, expired không bật poll và terminal không business effect. Không agent/merge/nhận head mới/reset hạn; T052/T053 kiểm trực tiếp service và fake ports trước T064, T096 tái sử dụng trước T105. Service chỉ enqueue fact/control effect, resume công việc do scheduler xét riêng; UI/route CLI recheck để T110 (FR-046.01–08).
- [ ] T063 [US2] Nối runtime boundary vào `src/engine/revision.ts`, `src/daemon/dispatch.ts`: source drift ghi ngay, attempt hiện tại hoàn tất, bước kế tiếp chặn tại boundary; revision không reset lượt/nấc/deadline hoặc reuse evidence cũ, không thêm kênh intake mới (FR-026).
- [ ] T064 [US2] Chạy T050–T053 sau T062, bổ sung assertions US1.7/9/11 về fixer/slot/deadline vào `test/integration/runtime/feature-002-flow.test.ts`, và ghi từng case US2.1–11/FR-041–043 cùng SC-003/010 vào `specs/002-task-to-green-pr/acceptance-report.md`; assertion riêng cho subset A/B so B/C, GitHub none/unknown, head/base/rerun/expiry/late merge, không đánh dấu đạt từ số lượng test đơn thuần.

**Checkpoint**: Vòng sửa, observation và service recheck đạt với fake/I/O fixture qua T062; chưa yêu cầu CLI recheck T110. US1.7 và đường fixer/deadline US1.9/11 đã được kiểm bổ sung, chưa mở B hoặc C.

## Phase 5: User Story 4 — Agent đúng quyền và bằng chứng (P1, lát A)

**Goal**: Hoàn thiện hai adapter thật trên proof lát 0, validation/provenance, quyền, progress và artifact/usage. Luồng xuyên suốt thật vẫn đợi lát C.

**Independent Test**: Cùng contract corpus cho fake/Claude/Codex từ fixture redact thật T007; real OS boundary tests cho ba role, invalid/truncated/stale result, canary secret, silent progress, process timeout và unsupported capability. Không gọi model để chạy default tests.

### Tests for User Story 4

- [ ] T065 [P] [US4] Viết `test/contract/sandbox-permissions.test.ts` kiểm reviewer ro, coder vùng rw, Git metadata ro, host/admin/operate/GitHub/socket/proc denial, selected auth chỉ agent và không push; kiểm native/fallback proof/settings hash/permission rule độc lập outer theo T006 (FR-013/032/033).
- [ ] T066 [P] [US4] Viết shared suite `test/contract/harness.test.ts` và fixture T007 cho coder/fixer/reviewer × hai vendor: argv/model/effort/schema/auth/session, structured final, invalid/truncated/semantic/stale/fallback provenance, usage missing/refusal/auth/rate-limit (FR-011/012/016).
- [ ] T067 [P] [US4] Viết `test/contract/runner-lifecycle.test.ts`, `test/contract/artifacts.test.ts` cho silent CPU/child/file progress, stall/timeout TERM/KILL, PID reuse/boot/sleep/UTC jump, secret trước persistence, traversal/symlink/oversize, retention chỉ terminal+ACK (FR-008/009/016/030).

### Implementation for User Story 4

- [ ] T068 [P] [US4] Tạo `src/adapters/harness/claude.ts` build argv/settings và parse output theo pinned manifest/fixtures T007, private home chỉ selected auth/settings, disable hook/plugin/MCP không cấp; permission/approval không đổi, sandbox mode theo trusted proof, không hardcode model hoặc dùng dangerously/bypass (FR-011/012/033).
- [ ] T069 [P] [US4] Tạo `src/adapters/harness/codex.ts` cho exec --json/output-schema/output-last-message/sandbox và session theo manifest T007; pin cwd/model/effort/effective permissions/private home, validate structured final, không fallback nguồn/path/session hoặc quyền ngoài manifest; lưu stderr để ghi denial vì `--json` không phát event cho lệnh bị rule hoặc sandbox chặn (evidence T006/T007) (FR-011/012/033).
- [ ] T070 [US4] Tạo `src/application/capabilities.ts` verify CapabilityManifest và nối preflight/mỗi attempt: “Help khác fixture thực nghiệm; mode external_verified chỉ sau outer/permission proof và owner cho phép; hash/version/layout đổi chặn trước attempt mới”; pin native result/outer proof/permission/settings/environment/schema/auth/cost/resume support, unsupported hard USD cap là capability_missing, không thay bằng estimate (FR-011/033).
- [ ] T071 [US4] Nối role/binding/permissions/approval/policy hash/slot/budget/manifest vào `src/runner/invocation.ts`, `src/daemon/dispatch.ts` trước spawn; commit reservation và chỉ chuyển used khi chứng minh đã gọi, không trả reservation khi launch unknown, agent không đổi model/vendor/mode giữa attempt (FR-010/016).
- [ ] T072 [US4] Hoàn thiện `src/runner/sandbox.ts`, `src/runner/private-home.ts` với executable/settings/layout pinned, no-new-privileges/cap drop/PID namespace và canary proof; so vùng ghi/checkpoint, vi phạm dừng/reconcile, không gán user dirty diff cho agent; lỗi boundary chặn runtime, không tự downgrade (FR-013/032/033).
- [ ] T073 [US4] Hoàn thiện `src/runner/lifecycle.ts`, `src/runner/progress.ts`: liveness khác progress qua CPU/process tree/output/file changes, wall monotonic+UTC bền, TERM 10 giây/KILL+verify≤5 giây đúng operation cgroup; không nhận process theo PID/env marker đơn lẻ, sleep/restart/clock jump không gia hạn (FR-007/009).
- [ ] T074 [US4] Hoàn thiện `src/runner/redact.ts`, `src/runner/artifacts.ts`, `src/daemon/retention.ts` cho binding/version/time/outcome, usage reported/estimated/unavailable không ghi 0, cap log/context, artifact digest/finalized/acked; retention 30 ngày chỉ terminal+ACK giữ tombstone và local remainder/worktree chưa bảo toàn (FR-016).
- [ ] T075 [US4] Tạo `src/adapters/harness/validate-result.ts` và nối `src/daemon/ingest.ts`: closed schema+semantic+operation/attempt/revision/binding/context/schema provenance, current finalized source, cap 1 MiB, không tin ID/path agent; partial final/stale artifact/exit=0 không đủ, fallback chỉ manifest khai báo và file mới riêng operation (FR-008/012/030).
- [ ] T076 [US4] Hoàn thiện `src/adapters/context.ts` và reviewer input trong `src/runner/invocation.ts`: bất biến acceptance/provenance, role data/log/diff bounded và marker cắt; thiếu bắt buộc→needs_context/chờ, secret/control syntax strip trước file/prompt; reviewer vendor từ actual diff creator (FR-005/014/016).
- [ ] T077 [US4] Chạy T065–T067 cho adapter fixture và OS thực, ghi matrix US4.1–6 tại `specs/002-task-to-green-pr/acceptance-report.md`; kiểm zero canary secret, denied reviewer writes, six role/vendor fixtures và missing usage=unavailable; không dùng replay fixture để chứng nhận smoke xuyên suốt thật.

**Checkpoint**: Fake A và adapter/permission contracts đạt; bằng chứng thật lát 0 vẫn phải còn đúng hashes/version.

## Phase 6: Cổng giao lát A — go/no-go trước B

**Purpose**: Review tính khả thi và effort ngay khi A xong hoặc chậm nhất **2026-11-06**, không reset mốc.

- [ ] T078 Chạy lại baseline và toàn bộ assertions core US1/US2/US4 của lát A (gồm phần US1.7/9/11 bổ sung tại T064 và service recheck T062) ít nhất 20 seeds qua `test/integration/runtime/feature-002-flow.test.ts`, `test/integration/runtime/feature-002-fixes.test.ts` và contract suites; lưu ledger trong `specs/002-task-to-green-pr/acceptance-report.md`: một worktree/branch/PR mỗi task, zero duplicate logical publish/merge requests, drain/limits/projection và boundary âm đều đúng.
- [ ] T079 Chuẩn bị review A tại `specs/002-task-to-green-pr/go-no-go.md`: liên kết S0.1–S0.3 thật còn hiệu lực, T078, pnpm typecheck/lint/test/build, effort thực tế/budget B/C, 117 mục coverage và phần chưa đạt; không đề nghị go chỉ từ test count.
- [ ] T080 Ghi quyết định tường minh của chủ dự án, thời điểm và lý do tại `specs/002-task-to-green-pr/go-no-go.md` ngay khi A kết thúc hoặc chậm nhất 2026-11-06; chưa có go/no-go/no-go thì không mở B, không suy từ im lặng, cắt phạm vi phải sửa spec công khai và không giảm 200 crash/quyền/idempotency/smoke.

## Phase 7: User Story 3 — Tiếp tục an toàn sau daemon dừng (P1, lát B)

**Prerequisites**: T080 có go. Protocol/receipt/probe cơ bản đã dùng trong A; phase này hoàn thiện recovery và chứng minh bằng fault injection, không trì hoãn invariant an toàn đến B.

**Goal**: Nhận lại runner/output/Git/PR/drain, giữ state bền và không nhân đôi logical operation.

**Independent Test**: Daemon process/SQLite file/Git/bare remote/fake HTTP thật; kill ở spawn/output/commit/push/PR/merge-drain, restart đối chiếu trước dispatch. Ít nhất 200 daemon kills, replay mọi projection sau từng lần, zero duplicate attempt/commit/PR.

### Tests for User Story 3

- [ ] T081 [P] [US3] Viết `test/integration/runtime/runner-adoption.test.ts` cho daemon foreground kill và systemd daemon stop/restart, trước/sau unit start/PID receipt/marker, runner unit vẫn sống, operation lock ngăn double spawn, kill runner dừng descendants, PID reuse/reboot không giết nhầm (FR-007/034.01/035).
- [ ] T082 [P] [US3] Viết `test/integration/runtime/publish-recovery.test.ts` bằng Git/fake HTTP thật, ngắt sau commit/ref CAS/push/PR success trước receipt, remote diverged/duplicate marker/422/network unknown, setup non-safe unknown và local remainder sau late push (FR-003/004/017/018).
- [ ] T083 [P] [US3] Viết `test/integration/runtime/spool-recovery.test.ts` cho partial record/result, rotation, cursor/event atomicity, crash trước/sau ACK, ENOSPC/BUSY/64 MiB backpressure, cursor generation/seq và retention không xóa chưa ACK (FR-008/023/030/031).
- [ ] T084 [P] [US3] Viết `test/integration/runtime/feature-002-recovery.test.ts` cho startup single-writer/integrity/schema/replay mismatch, queue global_seq, timer/deadline giữ nguyên, merge recorded trước drain crash, late fixer/push và unknown drain không DONE/nhả claim (FR-022/034.01–03/036).

### Implementation for User Story 3

- [ ] T085 [US3] Tạo `src/daemon/startup.ts` theo thứ tự writer lock→schema/integrity→verify mọi projection→reconcile operations/slot/timers→ingest→schedule; legacy runtime=null chỉ đọc, mismatch/unresolved claim chặn cấp việc và health có lý do (FR-022/036).
- [ ] T086 [US3] Tạo `src/daemon/reconcile.ts` nhận lại systemd unit/flock/launch/pid/exit bằng identity đầy đủ, process chết có proof nhưng thiếu result→lost, unknown giữ claim/reservation; same-vendor session resume tối đa một lần khi policy/session cho phép, chỉ là facts cho engine xét budget, không spawn thay attempt cũ (FR-034.01/035).
- [ ] T087 [US3] Hoàn thiện `src/daemon/ingest.ts`, `src/store/accept.ts` cho event+cursor cùng transaction, “Chỉ nhảy sau record đầy đủ; thay đổi cùng transaction với event suy ra”, ACK sau commit, duplicate seq không duplicate event, operation/generation/segment/digest được kiểm (FR-031).
- [ ] T088 [US3] Hoàn thiện `src/runner/spool.ts`, `src/runner/files.ts` rotation 8 MiB/segment giữ unacked, cap spool 64 MiB→artifact_backpressure và stop operation, disk full giữ receipts/claim/health; terminal partial final invalid output, không âm thầm bỏ output (FR-008/023/030/031).
- [ ] T089 [US3] Hoàn thiện probe/re-adopt tại `src/adapters/git/reconcile.ts`, `src/adapters/github/reconcile.ts` trước retry commit/push/create PR/rerun: exact OID/remote/identity/all states/operation key, unknown/multiple giữ chờ; request retry count tách logical external effects (FR-017/018/034.01).
- [ ] T090 [US3] Nối recovery setup/gate/autofix/publish vào `src/daemon/reconcile.ts`, `src/runner/commands.ts`: mọi long operation có receipt, declared safe retry mới cho phép, checkpoint giữ nguyên khi HEAD lệch, filesystem write proof trước nhả claim (FR-003/004/034.01).
- [ ] T091 [US3] Hoàn thiện `src/daemon/drain.ts`, `src/engine/reconcile.ts` sau restart: merge proof ưu tiên, giữ hạn/count/unknown claim, invalidate business chưa gửi, nhận late results đúng thực tế không resume/publish, preserve local_remainder, không dependency sớm (FR-034.02/03, FR-040.02–09/13).
- [ ] T092 [US3] Nối store failure latch vào `src/daemon/dispatch.ts`, `src/daemon/health.ts`: không phát effect khi SQLite/FS không ghi được, không trả accepted thành công giả; runner spool chờ ingest, recovery không xóa dữ liệu để giải phóng disk, writer thứ hai bị từ chối (FR-006/022/023).
- [ ] T093 [US3] Thêm crash driver `test/reliability/runtime-crash.test.ts`, hỗ trợ tại `test/support/runtime-crash.ts` và nối `scripts/test-reliability.ts`: ít nhất 40 kills mỗi nhóm spawn/adoption, output/ACK, commit/push, PR create/recover, merge/drain; mỗi nhóm gồm trước effect/sau external success/trước durable ingest, seed+point+request/effect ledger và replay mọi bảng sau từng restart (FR-036, SC-004).
- [ ] T094 [US3] Chạy T081–T084 và ≥200 kills T093 bằng `pnpm test:reliability --seed 20261028`, ghi ledger/replay digest/operation counts tại `specs/002-task-to-green-pr/acceptance-report.md`; 100% committed state/projection khớp, zero duplicate attempt/commit/PR, không lấy crash 001/fake PID thay evidence runtime (SC-004/005/006).

**Checkpoint**: Recovery I/O thật đạt; SC-005 vendor thật vẫn đợi C. Hoàn thiện interaction/CLI B trước C.

## Phase 8: User Story 5 — Trả lời và hủy có kiểm soát (P2, lát B)

**Goal**: Inbox/Q&A bền, escalation đúng quyền, cancel/drain bảo toàn thay đổi và merge precedence.

**Independent Test**: needs_input kết thúc agent, restart còn inbox; answer lặp 2–5 lần/đua revision/version chỉ một kết quả; cancel cây process và publish unknown, thấy merge thì drain→DONE, terminal không mở lại.

### Tests for User Story 5

- [ ] T095 [P] [US5] Viết `test/integration/runtime/questions.test.ts` cho US5.1/2/7: question bền/restart, answer đầu thắng, replay request 2–5 lần, competing/stale revision, resume session chết và needs_context/blocked trong budget (FR-024/037/038/039).
- [ ] T096 [P] [US5] Viết `test/integration/runtime/cancel-drain.test.ts` và `test/property/invariants/runtime-cancel.test.ts` cho FR-025.01–05: pending invalidation, process kill, publish unknown/PR preservation, cancel thấy merge, terminal rồi mới merged, merge cleanup exhausted/recheck qua service T062 đã có từ A (không đợi CLI T110); gate approval/rate-limit/auth/refusal đúng policy (US5.3–6).

### Implementation for User Story 5

- [ ] T097 [US5] Nối `src/engine/questions.ts`, `src/application/inbox.ts` để needs_input kết thúc attempt, question/revision/provenance được commit, WAITING/human_input nhả slot sau effect rõ, inbox query sống qua restart, không giữ agent chờ người (FR-024).
- [ ] T098 [US5] Tạo `src/application/answer.ts` với operate/project/version/revision/question scope và command dedup; QuestionAnswered+answer context nguyên tử, câu trả lời hợp lệ đầu thắng, request lặp cùng kết quả/competing conflict, không cấp thêm attempt từ request lặp (FR-037).
- [ ] T099 [US5] Nối `src/engine/questions.ts`, `src/engine/claim.ts`, `src/runner/invocation.ts` resume tối đa một lần cho attempt lost khi policy/session cho phép, chỉ cùng harness/session đã proven; session không dùng được thì engine xét attempt mới mang Q&A, đủ slot/quyền/approval/budget, mọi call thật tính lượt, adapter không tự retry (FR-038).
- [ ] T100 [US5] Nối needs_context/blocked vào `src/engine/waits.ts`, `src/adapters/context.ts`: lưu phần thiếu/blocker và allowed exit, không role ngoài phạm vi hoặc vòng hỏi vô hạn, attempt mới chỉ khi context bắt buộc đầy đủ và còn giới hạn (FR-039).
- [ ] T101 [US5] Mở `src/engine/cancel.ts`, `src/application/cancel.ts` và `src/daemon/drain.ts`: ghi cancel intent/invalidate business pending, TERM/KILL/xác minh mọi operation task, giữ slot/claim tới effect rõ, giữ diff/commit/branch/PR; không tự đóng/xóa/rollback bên ngoài (FR-025.01/02/05).
- [ ] T102 [US5] Nối cancel observation/probe vào `src/engine/cancel.ts`, `src/daemon/observation.ts`: đối chiếu PR mới nhất ngay cả observation hết hạn, unknown không CANCELLED; merge trước terminal→DONE sau drain với “yêu cầu hủy đến quá muộn”/unverified, merged sau CANCELLED chỉ history, không mở lại (FR-025.03/04, FR-040.15, FR-043.07).
- [ ] T103 [US5] Tạo `src/application/approve.ts` cho escalation admin gắn task/revision/step/rung/policy hash hiện hành, expected-version/dedup; operate/read/worker không tự duyệt, merge/yolo luôn unsupported và không tạo approval (FR-010/028).
- [ ] T104 [US5] Nối quota/cooldown/auth/refusal vào `src/engine/failure.ts`, `src/store/timers.ts`, `src/engine/waits.ts`: rate-limit có lịch hữu hạn nhả slot khi operation rõ, auth/refusal chờ người không escalation né quyền, unknown probe giữ claim (FR-015, US5.5).
- [ ] T105 [US5] Chạy T095/T096 với service recheck T062 đã được kiểm từ A, rồi ghi US5.1–7 tại `specs/002-task-to-green-pr/acceptance-report.md`, bao gồm answer/cancel replay 2–5 lần, actual process descendants, PR đã tạo không xóa, cancel unknown/merged/terminal và session fallback không vượt lượt (SC-006/007/012).

## Phase 9: User Story 6 — Xem và điều khiển qua CLI (P2, lát B)

**Goal**: CLI hữu hạn/JSON, logs nối lại, authz chuẩn, explain đúng mọi wait detail và recheck một lượt không mở lại workflow.

**Independent Test**: Dùng CLI process qua UDS tới daemon thật/SQLite và fake ports; human/JSON output, status/exits 0–6, request/version conflict, authz/revoke/project scope, disconnected không mở DB, recheck expired/drain/PENDING/terminal không gọi agent/merge/reset hạn.

### Tests for User Story 6

- [ ] T106 [P] [US6] Viết `test/integration/runtime/feature-002-cli.test.ts` cho US6.1–7 và phần CLI/recheck/explain còn lại của US1.8/10/11: toàn bộ commands/exits/envelope/log cursor/follow, allowed-actions mọi dòng FR-029, slot/dependency/drain explain, PENDING/PR/expired/drain/terminal recheck và unsupported no-mutation (FR-027.01–05/029/045.01–02/046.01–08).
- [ ] T107 [P] [US6] Viết `test/integration/runtime/access-control.test.ts` với token owner/admin, read, assistant read+operate scoped và revoked: actor spoofing/escalation/token management/project khác bị từ chối exit 5, assistant không thấy owner token/worker không thấy mọi token, restart revocation không thay accepted audit (FR-028/032).

### Implementation for User Story 6

- [ ] T108 [US6] Hoàn thiện `src/application/queries.ts`, `src/cli/cusr.ts` cho task list/show/explain/history, inbox/status/doctor qua UDS; list limit≤100+cursor, query từ projection không LLM/DB fallback, PR/head/usage/reservation/artifact có provenance và authz project scope (FR-027.01/02).
- [ ] T109 [US6] Hoàn thiện routes add/confirm/cancel/answer/approve tại `src/daemon/server.ts`, `src/cli/cusr.ts` qua application T023/T031/T098/T101/T103; mutation có request UUID và expected-version khi sửa task, CLI tự sinh ID phải in lại, lỗi syntax/schema trước mutation, effect bất đồng bộ (FR-027.01/028).
- [ ] T110 [US6] Nối service recheck T062 đã có từ US2 vào routes `src/daemon/server.ts` và command `src/cli/cusr.ts`; hoàn thiện `src/application/recheck.ts` chỉ cho integration/adoption ports thực đã có từ US3, giữ nguyên state semantics/limits/dedup. Dùng T106/T107 kiểm end-to-end UDS: operate/version/dedup, PENDING config/capability đọc base mới qua triage, PR một lượt observe, merge_cleanup một lượt stop/probe≤60 giây; coalesce, giữ lịch/budgets, expired không bật poll, terminal không business effect, không agent/merge/chấp nhận head mới (FR-027.01, FR-046.01–08).
- [ ] T111 [US6] Mở `src/explain/explain.ts`, `src/explain/allowed-actions.ts` cho từng detail/lối ra FR-029, blockers còn hiệu lực/freshness/observation deadlines, slot initial/resumed wait/deadline, prerequisite DONE unverified+link sau dependent start, merge_cleanup proof/pending operations/drain limit/recheck; không gợi ý gia hạn/amend-policy/verify head mới (FR-027.03–05/029/041.05/042.09/043.12).
- [ ] T112 [US6] Tạo `src/application/doctor.ts`, hoàn thiện `src/daemon/health.ts`: writer/schema/integrity/replay, unresolved claims/slot/cursor, systemd unit/WSL2 thực, sandbox canaries, path/storage/credential presence và manifest hashes; doctor không model/sudo/provision hoặc tuyên proven từ help, health lỗi chặn thực thi tương ứng (FR-027.02/032/033).
- [ ] T113 [US6] Tạo `src/cli/output.ts`, `src/cli/errors.ts` và HTTP error mapping: finite --json đúng một `{schema_version:1,ok,data,error}`, details/request_id ổn định, log stderr/no ANSI/prompt; exit 0 processed/1 health-execution/2 syntax-config-unsupported/3 connection-timeout/4 missing/5 forbidden/6 conflict, task status không đổi query exit (FR-028).
- [ ] T114 [US6] Tạo `src/application/logs.ts`, `src/cli/logs.ts` cho --after cursor finite và --follow JSONL seq/cursor, mỗi session≤1 giờ nối lại được, data chỉ finalized/redacted/authorized, không lặp hoặc mất record đã ACK qua rotation/restart (FR-027.01/028/031).
- [ ] T115 [US6] Từ chối task retry/amend-policy, merge approval/yolo tại `src/cli/cusr.ts`, `src/application/commands.ts`: unsupported_feature/exit 2 và zero business mutation/merge dispatch, hướng dẫn task add độc lập hoặc merge GitHub rồi recheck, không liên kết retry hay mở terminal (FR-021/045.01/02).
- [ ] T116 [US6] Hoàn thiện UDS boundary tại `src/daemon/server.ts`, `src/cli/client.ts`: data dir0700/socket0600/token0600, POST /v1/query và /v1/command closed JSON, GET /v1/health, body≤1 MiB/header≤5 giây/admission≤10 giây, bearer từ file không argv/log, không TCP/abstract socket, daemon disconnected exit3 không đọc DB (FR-028/032).
- [ ] T117 [US6] Hoàn thiện trusted access-token loading/audit tại `src/application/access-tokens.ts` và runbook `deploy/README.md`: owner bootstrap riêng, assistant 32-byte token [read,operate]/project allowlist, grant/revoke config+restart, connector không thấy owner home/token, worker không thấy operate, không coi same-UID full shell là ranh giới quyền (FR-028/032).
- [ ] T118 [US6] Thêm unit mẫu `deploy/systemd/cusrd.service` và hướng dẫn `deploy/README.md` cho một daemon writer, runner unit độc lập cùng foreground/service backend, WSL2 user manager/provisioning/version/paths; không tự cài/nạp unit host trong task tài liệu này (FR-007/027.02).
- [ ] T119 [US6] Hoàn thiện recovery dependency notifications/queue view tại `src/application/dependency.ts`, `src/daemon/scheduler.ts`: quét projection khi startup để nhận notification mất sau DONE commit, idempotent ready transition/priority order/slot wait accumulation, unverified prerequisite link bền qua dependent start/restart (FR-001.02/03, FR-027.03/04, FR-044.06/07).
- [ ] T120 [US6] Chạy T106/T107, flow/fixes và integration B sau T110/T111/T119; đối chiếu đủ từng US1.1–11 gồm recheck/CLI explain đã hoãn tại T049/T064, rồi ghi matrix mỗi wait detail/exit/authz/recheck và US6.1–7 tại `specs/002-task-to-green-pr/acceptance-report.md`; xác nhận T094≥200 kills/replay vẫn đạt sau integration, thiếu evidence thì giữ C đóng (SC-007/009/011/012).

**Checkpoint B**: US3/5/6 và recovery ≥200 kills đạt, owner go còn hiệu lực, permission fixtures pass; khi đó mới chạy C với usage/GitHub được cấp.

## Phase 10: Smoke thật, polish và nghiệm thu xuyên story (lát C)

**Purpose**: Chứng minh SC thật, hoàn thiện báo cáo trung thực. Không coi MVP fake là toàn feature hoặc phát hành v1.

- [ ] T121 Tạo fixture task/gate pass-fail cho Node và Python tại `test/fixtures/runtime/projects/node/`, `test/fixtures/runtime/projects/python/`, suite `test/smoke/task-to-green-pr.test.ts`; cấu hình hai repo GitHub sandbox được cấp với nonempty snapshot CI/review bắt buộc, trường hợp no-protection có evidence dương, credential references không secret trong repo (SC-001/002).
- [ ] T122 [P] Tạo `test/smoke/harness-roles.test.ts` sau fixture/config T121, dùng schema và manifest T007/T070, lập ma trận 3 role × 2 vendor với assertion output/auth/permission/usage/provenance và secret canary. Kiểm local fixture/setup trước invocation trả phí; invocation thật opt-in trong T126 khi đủ quyền/budget, không dùng fixture replay thay SC-008.
- [ ] T123 [P] Tạo `test/smoke/runner-restart.test.ts` sau fixture/config T121, chuẩn bị hook chờ real agent active, foreground kill/service stop/restart và đối chiếu cùng attempt/unit/descendants tới PR xanh cho từng vendor; kiểm driver local trước T128, real scenario opt-in và có ledger riêng, không fake PID thay SC-005.
- [ ] T124 [P] Tạo `test/smoke/gates.test.ts` sau fixture/config T121, assertions command/checkpoint/exit cho Node/Python pass-fail, fail chặn publish tới khi fix+gate lại; kiểm fixture commands local trước T129, real PR workflow chỉ opt-in, evidence phân biệt local gate với harness/GitHub thật (SC-002).
- [ ] T125 [P] Tạo `test/smoke/manual-merge.test.ts` sau fixture/config T121, checkpoint chờ người dùng merge, observer/drain/DONE-once/zero merge requests, checked/merged head/merge commit và proof fixtures T008 cho merge/squash/rebase/source push/delete; kiểm observer bằng fixtures local trước T130, harness không gửi merge và không suy pass khi chưa có manual merge (SC-001/012).
- [ ] T126 Sau khi T122 đã tạo và kiểm setup suite, đối chiếu manifest T007 với binaries/settings/layout hiện tại và chạy hoặc tái xác nhận smoke coder/fixer/reviewer × hai vendor tại `test/smoke/harness-roles.test.ts`, lưu output/auth/schema/permission/usage evidence thật trong `specs/002-task-to-green-pr/acceptance-report.md`; hash đổi phải chạy lại spike phần bị ảnh hưởng trước use, không tăng budget ngầm hoặc thay fixture replay cho invocation thật (SC-008).
- [ ] T127 Chạy `test/smoke/task-to-green-pr.test.ts` qua CLI với Claude coder/Codex reviewer trên một sandbox và đổi vai trên sandbox còn lại: không sửa tay code, đúng một PR xanh/head mỗi task, gate/review/CI evidence, chờ người merge chưa DONE và zero merge request; lưu URLs/SHA/config/version/request ledger vào `specs/002-task-to-green-pr/acceptance-report.md` (SC-001).
- [ ] T128 Sau khi T123 đã tạo và kiểm driver suite, chạy `test/smoke/runner-restart.test.ts` cho mỗi vendor lúc agent còn chạy, daemon foreground kill và service stop/restart; nhận đúng attempt/runner, không gọi thay thế, tiếp tục tới PR xanh; ghi unit identity/progress/receipt thật tại `specs/002-task-to-green-pr/acceptance-report.md` (SC-005).
- [ ] T129 Sau khi T124 đã tạo và kiểm fixture suite, chạy gate pass và fail thật cho cả Node/Python qua `test/smoke/gates.test.ts`, chứng minh fail chặn publish tới khi sửa/kiểm lại; không dựa mỗi fake gate fixture, lưu commands/exit/checkpoint/PR head tại `specs/002-task-to-green-pr/acceptance-report.md` (SC-002).
- [ ] T130 Sau khi T125 đã tạo và kiểm observer suite, chạy `test/smoke/manual-merge.test.ts` khi chủ dự án merge thủ công hai PR nghiệm thu, đối chiếu thêm merge/squash/rebase/source-push/delete proof T008 trên sandbox; lưu checked/merged head/merge commit/proof hash, drain→DONE một lần/zero system merge request, recheck expired/cleanup chỉ case thật đã chạy; không gọi merge trong suite (SC-001/012).
- [ ] T131 Hoàn thiện từng dòng FR trong `specs/002-task-to-green-pr/contracts/acceptance-map.md` và `specs/002-task-to-green-pr/acceptance-report.md` bằng task ID/test assertion/fixture/receipt/evidence thật hoặc chưa đạt/chưa kiểm; đủ 117 nghĩa vụ/12 SC, tách fake, real I/O, real vendor và không chứng nhận head unverified.
- [ ] T132 Mở `test/invariants.map.ts`, `scripts/report-invariants.ts` và report `specs/002-task-to-green-pr/acceptance-report.md` cho I01–I12/S01–S10/R1–R9; giữ baseline 001, chỉ chứng minh I11 không dispatch merge, R7 soak/R9 vận hành đầy đủ chưa nghiệm thu toàn bộ; fixture/help không thay smoke (SC-009).
- [ ] T133 Chạy `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, reliability seeded và `pnpm report:invariants` cho mã cuối, smoke opt-in khi đủ prerequisite; ghi command/exit/duration/seed/crash distribution/request-vs-effects/full projection diff vào `specs/002-task-to-green-pr/acceptance-report.md`, lỗi/chưa khả dụng phải ghi thật và sửa trong scope trước đánh dấu xong.
- [ ] T134 Kiểm hành trình/lệnh/liên kết tại `specs/002-task-to-green-pr/quickstart.md`, cập nhật `README.md`, `docs/architecture.md`, `deploy/README.md` theo binary/config thực đã kiểm; ghi hạn chế/khả năng chưa đạt và worktree/artifact retention, xác nhận không placeholder/broken doc links, không thêm feature ngoài scope để làm xanh báo cáo.

## Dependencies & Execution Order

### Phase Dependencies

```text
T001–T009: S0.1 + S0.2 + S0.3 pass (đạt 2026-10-28)
    → T010–T026: nền runtime
    → US1 (T027–T049)
    → US2 (T050–T064)
    → US4 (T065–T077)
    → T078–T080: go của chủ dự án, hạn đánh giá 2026-11-06
    → US3 (T081–T094)
    → US5 (T095–T105)
    → US6 (T106–T120)
    → T121–T130: smoke thật, A/B pass + quyền dùng sandbox/usage
    → T131–T134: báo cáo/quality gates/tài liệu cuối
```

- Phase 1: T001 cấp đầu vào/budget; T003/T004/T005 đã có prototype độc lập A. T002 kiểm host và cập nhật scope prototype là prerequisite T006; không còn provisioning AppArmor bắt buộc. T006 local có thể chạy khi chờ T001; phần vendor của T006 và T007 cần đầu vào/quyền/budget T001, dùng T003/T004 và mode proof S0.1. T008 cần T001/T005; T009 chỉ tổng kết proof thật. Phase 1 không hoàn tất chỉ vì đã có tasks.md. Sau gate, T010/T011 độc lập. T012/T013 độc lập; T014 cần cả hai, sau T015 thì viết tests T016 trước T017. Nhánh store: T017→T024→T025. T018/T019/T020/T021 có thể chuẩn bị các boundary khác file sau schemas/ports; T020 vẫn đợi proof thật T006/T007. T022→T023 dùng domain/authz; T016 được chạy lại để kiểm tất cả nền trước T026; T026 nối sau nền.
- US1: tests T027–T029 trước implementation. T030→T031→T032; T033→T034; T035→T036→T038/T039, T037→T038/context usage; T040→T041→T042→T043→T044. T041 còn cần T039; T045 cần normalized proof T044, T046 cần T045/T018/T019; T047→T048→T049 sau các nhánh nền và evaluator T042/T043. T049 chỉ baseline; T064/T078 kiểm phần fixer/slot/deadline, T106/T120 kiểm recheck/CLI explain còn lại của US1.
- US2 cần flow/head/proof US1. T050–T053 là test files độc lập; T054→T055/T056→T057, T042/T043 đã hoàn tất trong US1; T058→T059/T060→T061→T062; T063→T064 sau các integration tương ứng. T064 gọi service T062, không chờ CLI T110. Các task chạm cùng engine/dispatch file phải tuần tự.
- US4 cần sandbox/protocol T018–T020, manifest proof lát 0 và role contract T013. T065–T067 độc lập; T068/T069 song song sau test contract, T070→T071→T072→T073→T074→T075→T076→T077. Chỉ hoàn thiện adapter từ fixtures ở A; không chạy full real workflow trước C.
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

- Tổng cộng 134 task: US1=23, US2=15, US3=14, US4=13, US5=11, US6=15; 43 task nền/gate/nghiệm thu, 32 task có `[P]`, 117/117 nghĩa vụ có ánh xạ triển khai và kiểm chứng. Tất cả checkbox đang chưa hoàn thành.
- Giữ trọn scope gộp hai mốc của feature 002; không tự giảm crash/smoke hoặc thêm retry/amend/merge để né blocker.
- S0.1–S0.3 và go/no-go là các gate cần bằng chứng/quyết định thật. Không tự đánh dấu checkbox từ việc đọc tài liệu, viết test chưa chạy hoặc owner chưa trả lời.
- Worktree/diff/local commit chưa bảo toàn không bị xóa vì log retention hoặc task DONE. Snapshot/FrozenPolicy/event v1 và raw hash lịch sử giữ nguyên.
- Sau thay đổi mã/cấu hình phải qua bốn quality gates riêng; lượt tạo tasks.md chỉ kiểm tài liệu, không tuyên bố runtime/test/smoke đã đạt.
