# Implementation Plan: Task tới PR xanh và ghi nhận merge thủ công

**Branch**: `002-task-to-green-pr` | **Date**: 2026-10-28 | **Spec**: [spec.md](spec.md)

**Input**: 46 nhóm FR, 117 mục nghiệm thu; SC-001–SC-012, Q1–Q19.

**Readiness: BLOCKED trước lát A.** Backlog đã tạo theo yêu cầu chủ dự án; [lát 0](spike-0.md) chưa đạt. Theo [ADR-0004](../../docs/adr/0004-isolated-bwrap-baseline.md), Isolated rootless bwrap là baseline cần kiểm chứng, không còn gate AppArmor 4 phổ quát. Canary local đã đạt nhưng chưa thay proof đầy đủ, smoke harness hoặc GitHub thật.

## Điều chỉnh thiết kế 2026-10-29

Áp dụng [chế độ thực thi và xác nhận](task-execution-modes.md), coverage M01–M08 và backlog
T135–T139. Thay skip theo XS bằng mode được người dùng xác nhận; không bắt buộc khác vendor.
Commit sau gates, trước review; publish đúng SHA. Worker chuẩn bị message/title/body từ template
frozen và tiếp tục sửa qua resume khi hợp lệ. Agent nhận task đề xuất từ `when to use`, daemon
không suy rủi ro hoặc tự chọn lại binding. Bổ sung xác nhận bền từ kênh người dùng đáng tin trước
spawn, không thay authority admin hiện có.

Amendment hiến chương 1.1.0 → 2.0.0 được chủ dự án yêu cầu khi review PR #8: nguyên tắc IV
thay ưu tiên khác vendor bằng reviewer riêng session/chỉ đọc và review theo mode; nguyên tắc V
giới hạn merge guard cho effect do Cuesura gửi, tách merge thủ công ngoài hệ thống. Đây là MAJOR
vì định nghĩa lại hợp đồng review và phạm vi bất biến merge. Không thêm/bỏ section hoặc placeholder;
không sửa template (workflow đọc hiến chương khi chạy). SPEC I11/§5.2/§7/§14.2, contracts, tasks,
glossary và README được đồng bộ trong PR. Gate review bắt buộc với `full-review`; `direct-pr`
không tạo approve giả và không cấp quyền auto-merge. Xác nhận intake mặc định vẫn giữ nguyên.
Bằng chứng hai vendor của spike/SC-001 vẫn là coverage adapter, không là điều kiện admission.
Plan/schema/graph cũ phải được nối qua T135–T139; tài liệu không thay bằng chứng runtime.

Thứ tự bổ sung: US1 thực hiện T135–T137 và kiểm bằng fake; US2 kiểm quyết định resume/fallback
qua session port fake. US4 mới nối real session tại T138 sau T068–T071, rồi T077. T139 kiểm tổng
hợp sau T064/T077, trước T078/go-no-go. Không đặt T138 làm prerequisite ngược của US1/US2.

Bổ sung review workflow: P0 snapshot yêu cầu toàn bộ gates cùng đạt trên tree code cuối; P1 resume
luôn có packet nguyên nhân/trạng thái mới nhất; P1 review cost dùng lại approve/findings hợp lệ
khi toàn bộ đầu vào không đổi và giữ checkpoint nếu worker no-op. Nối vào T038/T039/T050/T054–T057
và T137–T139/M03/M04/M06; không thêm task hoặc đổi thứ tự phụ thuộc. Recovery và CI attribution
giữ hợp đồng idempotency/receipt/probe và SHA/generation hiện có, cần chứng minh khi triển khai.

Bổ sung race [H01–H06](task-execution-modes.md#remote-đổi-head-khi-review-còn-chạy): remote đổi
head trong lúc review, callback đến trước/sau observation, update có guard sau probe, restart và
đối chứng chỉ base tip đổi. Nối vào T029/T041/T050–T053/T058/T137/T139; H05 có replay/SQLite
ở A và crash I/O tại T082/T093 ở B, không kéo recovery B thành prerequisite ngược cho A.
Triển khai Phase 3 theo backlog cũ cần đối chiếu [phạm vi rà lại](tasks.md#đối-chiếu-phase-3-đã-làm-theo-backlog-cũ), giữ bằng chứng cũ và đánh giá lại theo từng yêu cầu mới.

Bổ sung `merge.method` theo [SPEC §14.2](../../SPEC.md#142-merge): object closed, enum
squash/merge/rebase, default squash khi thiếu object/key, giá trị sai báo config_invalid. Resolve
từ frozen base và chụp cùng policy/context của task mới; không sửa task đang chạy hoặc hash
snapshot cũ. Feature 002 chỉ hiển thị preference/message, không kiểm method đã bật như capability
để chặn admission và không gửi merge. Method thực tế khác/unknown không chặn proof/drain/DONE
hoặc tự đánh dấu merged_head_unverified; audit chỉ ghi khi có evidence. V1 có merge effect sau
này phải dùng method frozen, message artifact đã validate và không fallback khi repo không cho
phép. Nối T030/T032/T045/T111/T135/T136/T139, giữ thứ tự phụ thuộc và scope 002.

## Summary

Nối lõi 001 vào một daemon ghi SQLite, runner độc lập, Git/worktree và hai harness CLI. Giao theo lát 0 kiểm chứng thật → A fake tới PR xanh → go/no-go → B recovery/tương tác với ≥200 crash → C smoke xuyên suốt thật hai chiều vendor. Khi xác nhận merge, ghi bền bằng chứng và chặn nghiệp vụ; chỉ DONE sau khi dừng process/đối chiếu effect, kể cả head chưa chứng nhận. Xem [ADR-0001](../../docs/adr/0001-observe-manual-merge.md).

## Technical Context

| Mục | Thiết kế |
| --- | --- |
| Language/Version | Node 24.22.1, TypeScript strict/ESM, tsc; giữ baseline repo |
| Primary Dependencies | better-sqlite3, Zod 4, yaml, uuid có sẵn; thêm Commander đúng baseline; GitHub qua gh port, không fetch backend |
| Storage | SQLite WAL/FULL qua store hiện có; event/projection/outbox/timer; artifact trên filesystem Linux |
| Testing | Vitest/fast-check; contract trong default project, reliability và smoke riêng |
| Target Platform | Ubuntu/WSL2 có systemd user manager, bubblewrap/namespaces đã kiểm chứng; Git và util-linux flock |
| Project Type | Một package CLI/daemon/runner; Unix socket cục bộ |
| Performance Goals | Một slot thực thi; observation không giữ slot; giới hạn I/O/poll/spool/drain tại research R-04/R-11 |
| Constraints | Snapshot trước RUNNING; không merge/yolo/amend/retry terminal; Isolated rootless bwrap và outer boundary/permission phải đạt, không bắt buộc AppArmor 4; sandbox nội bộ thử trước, external_verified có điều kiện; Internet outbound đã chốt, không egress allowlist |
| Scale/Scope | Một người dùng; nhiều task queued/chờ, một task thực thi; một worktree/branch/PR mỗi task |

## Constitution Check

Đối chiếu [hiến chương 2.0.0](../../.specify/memory/constitution.md), gồm amendment ngày 2026-10-29,
cho thiết kế cập nhật; bằng chứng Phase 0/1 cũ vẫn giữ provenance của phiên bản đã kiểm:

| Nguyên tắc | Trước nghiên cứu | Sau thiết kế / bằng chứng |
| --- | --- | --- |
| I — Tất định | Đạt về hướng tiếp cận | Slot/completion/drain/timer là hàm thuần; now/ID/facts từ application service |
| II — Commit/idempotency | Đạt | accept nguyên tử; receipt/probe trước retry; replay slot theo global_seq |
| III — Hữu hạn | Đạt, cần chốt giá trị | R-04 chốt CI/observation/drain; R-11 chốt context/spool; unknown có đường recheck/cancel |
| IV — Bằng chứng | Đạt về thiết kế, cần M01–M08 | Validate response; gates/CI và review theo mode đúng SHA; reviewer riêng session/chỉ đọc, không ưu tiên vendor; DONE chưa chứng nhận ghi rõ |
| V — Quyền kiểm soát | Đạt về thiết kế, cần bằng chứng xác nhận | Giữ xác nhận intake và cấu hình chạy riêng; snapshot/binding bất biến; chỉ quan sát merge ngoài hệ thống; secret ngoài sandbox |
| VI — Trung lập domain/vendor | Đạt | Core nhận fact/command typed generic; GitHub/harness/toolchain ở adapter |
| VII — Kiểm chứng trung thực | Cần bằng chứng spike | Gate feasibility hiện BLOCKED; phải chạy lát 0 trước A, không lấy docs/help/fake thay kết quả thật |
| VIII — Đơn giản | Đạt về thiết kế | Snapshot/event envelope v1 giữ nguyên; app-pinned lưu evidence và kiểm app trước merge; port SandboxProvider nhỏ, duy nhất backend bwrap, không registry/Native/Container trong v1 |

Không cần miễn MUST. Merge thủ công trên GitHub là hành động ngoài Cuesura; agent/decider vẫn không được thực thi merge. I11 ở đây chỉ chứng minh không gửi merge, không chứng nhận thao tác người dùng. Giữ regression lõi cũ; daemon 002 không dispatch task legacy thiếu snapshot runtime. Điều chỉnh supervision đã ghi SPEC §§12.1/17.2 và [ADR-0002](../../docs/adr/0002-systemd-runner-lifetime.md); gh/file protocol giữ baseline. Gate feasibility chưa đạt nên không tuyên bố plan ready-to-implement.

## Project Structure

### Documentation (this feature)

```text
specs/002-task-to-green-pr/
├── spec.md, checklists/requirements.md   # đầu vào
├── plan.md, research.md                 # thiết kế, bằng chứng khảo sát
├── data-model.md                        # entity/event/projection/migration
├── spike-0.md                           # gate thực nghiệm trước runtime A
├── quickstart.md                        # validation sau triển khai
└── contracts/
    ├── cli-daemon.md                    # lệnh, quyền, JSON/UDS, config
    ├── execution.md                     # runner/sandbox/output/Git/gates
    ├── github.md                        # PR/check identity/publish
    └── acceptance-map.md                # từng FR → lát giao / tầng kiểm chứng
```

`tasks.md` đã được tạo theo yêu cầu chủ dự án, giữ BLOCKED trước runtime A; việc có backlog không
thay bằng chứng feasibility của lát 0.

### Source Code (repository root)

```text
src/
├── domain/, config/, policy/    # mở schema/version/admission
├── engine/, store/, explain/    # completion/drain/queue/service effects/projection
├── application/                # thêm authz, command/query service, preflight/freeze
├── daemon/                     # thêm UDS server, dispatch/reconcile/ingestion/health
├── runner/                     # thêm operation claim, systemd/bwrap/spool/process identity
├── adapters/                   # thêm git/github/context/harness/{fake,claude,codex}
└── cli/                        # thêm cusr.ts, cusrd.ts, cusr-runner.ts
test/
├── unit/, property/, scenarios/ # giữ; thêm regression 002
├── contract/                   # thêm vào Vitest default project
├── integration/                # thêm SQLite/Git/process/application thật
├── reliability/                # thêm ≥200 I/O crash + full replay
└── smoke/                      # thêm project opt-in; hai vendor/hai hệ sinh thái
deploy/README.md, deploy/apparmor/ # runbook host; profile AppArmor chỉ hardening tùy chọn
deploy/systemd/                 # unit mẫu dự kiến, hướng dẫn runner độc lập
scripts/                        # validation/report, giữ script nền 001
```

**Structure Decision:** Một package; runner là entrypoint cùng build, không là DB writer. Interface chỉ đặt tại boundary có fake/implementation thật cần contract test; không registry động.

## Điểm sửa nền 001

| Điểm hiện có | Thay đổi dự kiến | Truy vết |
| --- | --- | --- |
| engine/interpreter, merge-guard | External-confirmation mode chờ tại merge gate; PR xanh không đòi base tip mới; không giả approval/effect merge | FR-040.01–15, FR-041.02/04 |
| engine/cancel, claim | Drain generic gồm agent/setup/gate/publish; chặn pending/claim nghiệp vụ, cho stop/reconcile sau hạn | FR-025.01–05, FR-040.02–09 |
| domain/effect, engine/proceed | Observation service có gate riêng, thay business await_ci sau deadline; kết quả muộn không resume | FR-034.03, FR-043.01–13 |
| merge-guard.expectedChecks | Hợp tên snapshot/GitHub ở mỗi lượt đọc, độc lập yolo; app cụ thể lưu evidence và kiểm trước merge; giữ replay mismatch lịch sử | FR-042.01–09 |
| config/freeze, engine/start | Đọc base commit mới nhất; freeze policy/context/runtime cùng lúc; retry PENDING không bỏ triage | FR-002.01–05, FR-046.02 |
| store/accept, claim, projector, verify | Slot/queue/cursor/runtime projection, claim cùng transaction; replay liên task theo global_seq | FR-006, FR-036, FR-044.01–07 |
| explain, relatedFacts | Prerequisite chưa chứng nhận, thời gian chờ slot/drain; dependency dựa DONE | FR-001.02/03, FR-027.03–05 |

Entity ở [data-model](data-model.md), giới hạn/lựa chọn ở [research](research.md), boundary ở [CLI](contracts/cli-daemon.md), [execution](contracts/execution.md), [GitHub](contracts/github.md).

## Thứ tự giao và cổng kiểm chứng

| Lát | Nội dung | Điều kiện sang lát tiếp |
| --- | --- | --- |
| 0 — Spike ngày 1 | Host rootless bwrap/systemd, outer boundary và sandbox nội bộ hai harness bật trước; external_verified có điều kiện; private-home auth/network; 3 role × 2 vendor; lifetime và gh head-at-merge | [S0.1–S0.3](spike-0.md) có fixture thật đạt trước A. Hiện BLOCKED: thiếu proof đầy đủ và các lượt model/GitHub, không do thiếu child stack AppArmor |
| A — Luồng fake | Domain/store, admission/snapshot, runtime đã chứng minh ở 0, worktree/gates, fake harness/GitHub, vòng sửa/chờ merge; CLI nhỏ đủ thử | US1/2/4 qua fake; gate go/no-go dưới đây; không dùng A/B để thay feasibility spike |
| B — Recovery/tương tác | Re-adopt/spool/probe, inbox/answer/cancel/recheck, health/explain, queue/dependency; Git/process thật | US3/5/6; ≥200 daemon kills quanh spawn/commit/push/PR/drain; replay 100%, không duplicate effects |
| C — Smoke xuyên suốt thật | Adapter đã có fixture từ 0; hai chiều coder/reviewer trên Node/Python, restart/manual merge | SC-001/002/005/008 đạt thật; SC còn lại có matrix/report; mọi FR có evidence hoặc ghi chưa đạt |

Lát 0 có 6 invocation schema/role trả phí được giới hạn theo spike guide, hoàn toàn tách full
workflow task-to-PR. C vẫn đợi A/B; không cấm spike sớm vì chưa qua recovery. Spike thất bại phải
review/sửa thiết kế trước A, không xây A/B trên giả định auth/sandbox/proof chưa kiểm.

## Go/no-go sau A và mốc ngày 10

Chủ dự án đánh giá **ngay khi A kết thúc, hoặc chậm nhất 2026-11-06** (ngày 10 tính từ kickoff
feature 002 ngày 2026-10-28), lấy mốc đến trước; không reset ngày đánh giá khi replan. Mốc này không
gia hạn một mốc review v1 sớm hơn nếu đã được ghi nhận. B chưa được mở trước kết quả go được ghi.

Điều kiện kỹ thuật để đề nghị **go**:

1. S0.1–S0.3 đạt trên host triển khai với manifest/version/auth/boundary thực. Có native result
   từng vendor; native nội bộ pass hoặc external_verified đáp ứng ADR-0004 sau outer/permission proof,
   owner config tường minh. Không bypass permission, mở capability hoặc nới sysctl; prototype/schema/
   gh proof dùng được trong adapter A. Native fail không bị ghi lại thành native pass.
2. US1/2/4 luồng fake và vòng sửa pass; chạy lại ít nhất 20 lần theo seeds ghi nhận, mỗi task đúng
   một worktree/branch/PR, zero merge requests và zero logical publish duplicate; DONE đợi drain.
3. Permission/secret negative fixtures đều chặn đúng; không token điều phối lọt log/prompt/sandbox,
   reviewer không ghi repo. Testcheck gate/review/CI gắn đúng head, unknown không thành xanh.
4. Trần lượt/deadline/observation/drain hoạt động bằng Clock inject; không gọi thêm agent sau trần.
   Default typecheck/lint/test/build đạt; projection runtime được replay khớp trong integration A.
5. Báo cáo effort thực tế, phần B/C còn lại, chi phí adapter/host provisioning và 117 mục coverage;
   chủ dự án thấy phần còn lại còn phù hợp budget v1 khoảng 4 tuần, không chỉ dựa số test xanh.

Nếu chưa đạt/không rõ hoặc đã đến ngày 10 mà A chưa xong: **no-go/tạm dừng mở B**, giữ core/data/test,
đánh giá lại executor/phạm vi với chủ dự án. Cắt phạm vi phải sửa spec công khai; không giảm 200
crash, smoke thật, quyền hoặc idempotency để làm cho cột go thành xanh. Không tự suy go từ im lặng.

## Validation và điều kiện hoàn thành

- [Acceptance map](contracts/acceptance-map.md) bao phủ từng mục con/FR chưa tách. Tasks/báo cáo dùng mã con khi có; không đánh dấu cả FR-040 đạt bằng một test.
- Thay đổi mã/cấu hình chạy typecheck, lint, default tests, build. Reliability riêng có seed/crash ledger; pure tests không thay I/O. B dùng bare Git + fake HTTP GitHub; C dùng harness/GitHub thật và fixture đã redact, version/schema hash, PR/SHA/merge receipt.
- Report đủ I01–I12/S01–S10/R1–R9, phạm vi từng mục. R7 soak/R9 full operations chưa nghiệm thu toàn bộ; I05 có worktree/slot mới, I11 chỉ hàng rào không gửi merge.
- [Quickstart](quickstart.md) ghi rõ binary/suite mới chưa khả dụng trước implement. Lượt plan chỉ kiểm tra tài liệu, không coi việc đọc docs là runtime đã đạt.

## Rủi ro cần chặn trước khi chạy thật

| Rủi ro | Cổng / kết quả khi chưa đạt |
| --- | --- |
| Host rootless bwrap/systemd hoặc nesting chưa đạt proof | Chạy S0.1/S0.2 trên host triển khai; chỉ provisioning nếu policy host cần, doctor không tự sudo/đổi mode; external_verified chỉ sau outer/permission proof và owner config |
| Head-at-merge qua squash/rebase/push sau merge chưa chứng minh | Fixture GitHub bắt buộc; thiếu bằng chứng trả unknown, không DONE phỏng đoán |
| Không đọc đủ classic protection/rules/app identity | unknown/policy, không PR xanh |
| Spawn/spool crash, ENOSPC, PID reuse | Operation lock/marker, atomic receipt, backpressure/reconcile; giữ claim |
| Hash/event/projection v1 đổi khi migrate | Giữ event/FrozenPolicy v1, raw event/hash; migration projection + full replay trước cấp việc |

## Complexity Tracking và đối chiếu baseline

| Lựa chọn | Quan hệ với SPEC / xử lý |
| --- | --- |
| Runner transient systemd service kể cả foreground | Điều chỉnh baseline process, đã sửa SPEC §§12.1/17.2 và ghi ADR-0002; spawn vẫn là primitive để gọi systemd-run, không gọi là baseline chưa đổi |
| GitHub qua gh port | Giữ §17.2; bỏ fetch backend khỏi thiết kế, gh version/argv/deadline có fixture |
| Files agent tại runs/<attempt_id> | Giữ §12.1 và các file invocation/pid/events/stderr/liveness/progress/exit/out/result; supplementary file không thay protocol |
| Isolated rootless bwrap | Theo ADR-0004: port SandboxProvider nhỏ, một backend bwrap; outer boundary/re-exec/copy/raw-userns/FD/socket/lifetime và permission phải đạt S0.1; AppArmor 4/child stack không bắt buộc, policy host giữ nguyên; gate 0 BLOCKED |
| Policy/event version | Giữ v1 và snapshot check strings; không upcaster/dual decoder vì app_id. DB migration riêng cho durable runtime vẫn cần |

Ngoại lệ ADR-0004 chỉ thay lớp OS sandbox nội bộ khi outer boundary đã proven, không miễn quyền/
approval/secret của hiến chương. Một package, Commander theo baseline, Node/Git/gh/systemd/bwrap/flock;
không thêm durable framework, ORM, DB server, broker, DI container hoặc backend supervision thứ hai.
Owner token/assistant operate token cấu hình riêng, không thêm bộ lệnh quản trị token vượt phạm vi.
