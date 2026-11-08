# Implementation Plan: Deputy, agent theo task làm thay chủ dự án

**Branch**: `007/deputy-spec` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Story 1–6, FR-001–FR-073, Edge Cases, SC-001–SC-008 và hai phiên Clarifications của spec.

**Mã nền**: thiết kế đối chiếu tại `origin/main` `36fed98`; đồng bộ lại với `cee8fea` (sau #247, #248 và amendment
10.0.0) ở [R-15](research.md#r-15--hết-thang-trở-lại-thành-wait-task-fail-là-lệnh-kết-thúc).

**Trạng thái:** thiết kế xong. Amendment hiến chương 10.0.0 đã merge (PR #254). Một spike nhỏ về hook hết lượt cần chạy
trước lát C ([R-03](research.md#r-03--phiên-native-lượt-tương-tác-hook-hết-lượt-dự-phòng-không-tương-tác)).

## Summary

Thay decider bằng component `deputy` của daemon, cùng khuôn với decider: vòng `round()` tìm sự cố cần deputy, ghi bản ghi
lượt trước khi spawn, chạy qua `RunnerHarness` (systemd, terminal backend, private home), nhận lại lượt sau restart.

Ba thay đổi lớn so với decider:

1. **Định tuyến** bằng bảng trên mọi `DetailCode`, thay cho danh sách ba câu hỏi của worker ([R-02](research.md#r-02--định-tuyến-bảng-trên-detailcode)).
2. **Lượt native:** chạy phiên tương tác, resume đúng phiên của task; hook do Cuesura cài báo hết lượt bằng một file trong
   run dir, runner dừng process. Không có terminal backend hoặc phiên treo thì chạy headless cùng phiên ([R-03](research.md#r-03--phiên-native-lượt-tương-tác-hook-hết-lượt-dự-phòng-không-tương-tác)).
3. **Deputy hành động bằng lệnh `cusr`** như trợ lý, với actor `deputy`, `--reason` và ID lượt. Bản ghi phiên và lượt nằm
   ở bảng riêng, không làm đổi version của task ([R-04](research.md#r-04--sự-cố-chuyển-cho-người-và-không-làm-đổi-version), [R-06](research.md#r-06--danh-tính-deputy-và-cli-trong-phiên), [R-07](research.md#r-07--lý-do-và-id-lượt-trên-mọi-lệnh-ghi)).

Engine giữ nguyên hành vi vào wait. Các lệnh `continue`/`amend-policy` được mở rộng để deputy nới ngân sách, deadline,
backoff và cửa sổ CI ([R-09](research.md#r-09--mở-lại-giới-hạn)). Worktree của task được ghi mốc trước lượt và trả về sau
lượt theo cơ chế reviewer ([R-08](research.md#r-08--mốc-và-trả-về-worktree-theo-cơ-chế-reviewer)).

## Technical Context

| Mục | Thiết kế |
| --- | --- |
| Language/Version | Node 24 LTS, TypeScript strict/ESM, `tsc`; giữ baseline repo |
| Primary Dependencies | Có sẵn: Commander, Zod 4, `better-sqlite3`, uuid. Không thêm dependency; không đòi người dùng cài công cụ nào |
| Storage | SQLite hiện có. Migration `008_deputy.sql`: `deputy_sessions`, `deputy_turns`, hai cột mới của `command_ledger` ([data model](data-model.md)) |
| Testing | Vitest và fast-check: property test cho bảng định tuyến và chuyển trạng thái lượt; integration SQLite thật cho bản ghi lượt, nâng cấp từ decider, crash injection; contract test runner cho hook hết lượt và trả về worktree trên git thật; scenario Story 1–6 với fake harness; smoke harness thật tách riêng |
| Target Platform | Linux/Ubuntu hoặc WSL2; terminal backend tùy chọn |
| Project Type | Một package CLI/daemon/runner; thêm module, không thêm binary hay process thường trực |
| Performance Goals | Sự cố tới deputy trong một vòng scheduler (1 giây); SC-003: tiếp tục chậm nhất 1 phút sau `stall_ms` |
| Constraints | Engine thuần (I01); lượt deputy không giữ reservation; bản ghi lượt không làm đổi `version`; không thêm sandbox ngoài harness |
| Scale/Scope | Một người dùng; số lượt deputy chạy song song bằng số task đang có sự cố |

Không còn câu hỏi cần chủ dự án làm rõ. Một spike kỹ thuật (trường tin nhắn cuối trong input hook của Claude và Codex)
chạy trước lát C.

## Constitution Check

Đối chiếu hiến chương 10.0.0 trên `main` (PR #254 đã merge). Các dòng "Đạt theo 10.0.0" là những điều khoản
amendment đã đổi cho deputy. SPEC I09 sửa cùng phần hiện thực ở lát F. Không xin ngoại lệ.

| Nguyên tắc | Đánh giá | Cách tuân thủ / điều cần amendment |
| --- | --- | --- |
| I. Lõi tất định | Đạt | Engine luôn vào wait như hiện nay; định tuyến là hàm thuần trên state và cờ `autonomous` đọc ở daemon; deputy là caller qua dịch vụ. Wait cạn trần khi không có deputy được daemon kết thúc bằng lệnh (R-11) |
| II. Effect sau commit, idempotent | Đạt | Bản ghi lượt ghi trước spawn; `recover` không spawn lại; lệnh của deputy có request ID và expected version; baseline worktree ghi bền trước lượt |
| III. Vòng lặp có giới hạn | **Đạt theo 10.0.0** | Bỏ quy tắc "một câu trả lời của decider mỗi step" và nhãn `grill` (FR-070). `max_visits` và các trần khác giữ nguyên; deputy mở lại chúng bằng lệnh có actor và lý do |
| IV. Bằng chứng | Đạt | Không đổi gate, review, CI; thay đổi của deputy trong worktree bị trả về như reviewer |
| V. Người dùng giữ quyền | **Đạt theo 10.0.0** | (a) Câu về decider: deputy có `operate`, luôn bật. (b) "Agent MUST NOT tự đổi binding/ngân sách": deputy đổi binding, ngân sách, deadline của worker qua `amend-policy`. (c) "Nâng model do code kích hoạt": cho phép đổi model qua `amend-policy` trong `allow_models`. (d) `task_amend_policy` hạ xuống `operate`. Giữ nguyên: không merge, không yolo, không nhận PR có sẵn, deputy không xác nhận task |
| VI. Lõi trung lập | Đạt | Engine chỉ biết mã wait và actor; argv tương tác và hook hết lượt nằm trong adapter harness |
| VII. Kiểm chứng trung thực | Đạt | Property, integration, contract và scenario theo tầng; SC-002, SC-003 chỉ ở smoke, báo "chưa đạt" nếu chưa chạy |
| VIII. Đơn giản | Đạt, có Complexity Tracking | Không dependency, không process thường trực; hai bảng mới được biện minh |
| Trust boundary | **Đạt theo 10.0.0** | "Decider MUST giữ sandbox chỉ đọc" thành: deputy toàn quyền, thay đổi trong worktree của task bị trả về theo mốc như reviewer |
| SPEC I09 | **Đồng bộ ở lát F** | Lượt deputy ngoài ngân sách; deputy đổi giới hạn của worker qua `amend-policy` |

Ràng buộc kỹ thuật và bảo mật:

- **Secret:** `final_message` và prompt của lượt đi qua `Redactor` trước khi lưu, như output của agent.
- **Trust boundary:** actor `deputy` và lượt đang mở được kiểm ở `admitCommand`, không chỉ ở CLI.
- **SPEC.md và tài liệu sửa cùng feature** (sau amendment): danh sách đồng bộ ở cuối [spec](spec.md#tác-động-lên-hiến-chương-và-spec).
  Việc sửa nằm ở lát F.

## Thiết kế chính

```text
engine vào wait ──▶ deputy.round()
                     │ routeOf(state, autonomous) = deputy ?
                     ├─ auto ──▶ không đánh thức ai, task tự chạy tiếp
                     ├─ không có role deputy + wait cạn trần ──▶ task fail (system:deputy-absent)
                     ├─ owner ──▶ attention như hiện nay
                     └─ deputy ──▶ ghi baseline worktree + deputy_turns(running)
                                   ──▶ RunnerHarness.run(role deputy, interactive?, CUSR_DEPUTY_TURN)
                                        phiên deputy ──cusr … --reason──▶ admitCommand(actor deputy, turn_id)
                                        hook hết lượt ──▶ turn-ended.json ──▶ runner dừng process
                                   ◀── turn_ended{final_message} | failure
                     restore worktree ──▶ còn đúng wait? handed_off : done ──▶ attention nếu handed_off
```

- **Định tuyến và attention (FR-001–FR-005):** `deputy-routing.ts` thay `WORKER_WAITS`; attention gọi `Deputy.holds(s)`
  thay `Decider.holds`. Cờ `autonomous` đọc lại như hiện nay (30 giây); đổi cờ làm `version()` của deputy đổi, attention
  tính lại (FR-003).
- **Phiên và lượt (FR-010–FR-019):** `deputy_sessions` một dòng mỗi task. Mỗi sự cố một `deputy_turns`. Unique index một
  phần bảo đảm tối đa một lượt đang chạy mỗi task. Binding đọc lại mỗi lượt; khác harness hoặc phiên mất thì
  `session: null` và prompt có bản tóm tắt (FR-016).
- **Chạy lượt (FR-012–FR-014):** adapter có `interactiveArgv`; runner chạy `--pty` trong terminal backend khi có, đọc
  `turn-ended.json` để biết hết lượt ([hợp đồng lượt](contracts/deputy-turn.md)).
- **Chuyển cho người và lỗi (FR-020–FR-025):** sau mỗi lượt so khóa sự cố với wait hiện tại; lỗi ánh xạ theo R-12.
- **Lệnh (FR-030–FR-044, FR-055):** mở rộng `continue`, `amend-policy`; thêm `task revise`, `task add --draft`; `reason`
  ở cấp lệnh; từ chối `task_confirm` của deputy ([hợp đồng CLI](contracts/cli-daemon.md)).
- **Danh tính (FR-050–FR-052, FR-056):** `CUSR_DEPUTY_TURN`, worker guard, actor bắt buộc, header `x-cusr-turn`.
- **Worktree (FR-053, FR-054):** baseline và restore của reviewer; settings phiên cấm `Edit`/`Write` trên thư mục
  worktree.
- **Ghi nhận (FR-060, FR-061):** `decisions.md` và `report` dựng từ event có actor `deputy` join `deputy_turns`; thân PR
  có mục quyết định.
- **Nâng cấp (FR-070–FR-072):** đóng bản ghi decider dở, alias config, giữ replay `DeciderRan`.

## Thứ tự giao

| Lát | Nội dung | Điều kiện qua lát |
| --- | --- | --- |
| 0 | Spike hook hết lượt Claude và Codex (amendment 10.0.0 đã merge, PR #254) | Kết luận spike ghi vào research, trước lát C |
| A | Danh tính `deputy`, `CUSR_DEPUTY_TURN`, worker guard, `reason`/`turn_id` ở cấp lệnh, migration 008, `task_amend_policy` → `operate`, mở rộng `continue`/`amend-policy` | Contract test CLI; Story 2 chạy được với caller giả lập deputy |
| B | `deputy.ts` thay decider ở chế độ headless: định tuyến, bản ghi lượt, chuyển cho người, lỗi, baseline/restore, nâng cấp từ decider | Story 1, 3, 5; SC-001, SC-004, SC-005, SC-006, SC-008 |
| C | Lượt tương tác: `interactiveArgv`, hook hết lượt, stall sang headless, terminal backend | SC-003 (smoke); Story 6 kịch bản 2 |
| D | Task nháp: `task add --draft`, `needs_draft`, `task revise`, từ chối confirm của deputy | Story 4 |
| E | Ghi nhận: `decisions.md`, `report`, chi tiết task, mục trong thân PR | Story 6; SC-007 |
| F | Đồng bộ SPEC, deploy, ADR (mới cho lượt tương tác, sửa 0005), GLOSSARY, spec 003, skill `cusr`; acceptance report | SC-002 (smoke) |

Lát B giao được trước C: deputy headless đã gỡ được mọi sự cố; C chỉ thêm khả năng xem và gõ vào phiên.

## Rủi ro

| Rủi ro | Cách xử lý |
| --- | --- |
| Input của hook Stop không mang tin nhắn cuối ở phiên bản đang pin | Đọc tin nhắn cuối từ transcript của phiên (adapter đã biết định dạng để resume); spike lát 0 chọn cách |
| Phiên tương tác treo ở hộp thoại | Stall sang headless cùng phiên (FR-014) |
| Deputy sửa worktree của task khác bằng shell | Chấp nhận như rào chắn tự khai; task kia thấy `worktree_changed` và wait đó tới deputy của nó |
| Restore thất bại | Như reviewer: bước worker kế tiếp vào `worktree_changed`, tới deputy, deputy `recheck worktree` |
| Deputy lặp vô ích, tốn quota | Chủ dự án chấp nhận không có trần; hết quota thì chờ `reset_at` (#245, account pool) |
| Nội dung không tin cậy điều khiển deputy | Rủi ro đã chấp nhận (Assumptions của spec); daemon vẫn chặn quyền `admin` và confirm |

## Project Structure

### Documentation (this feature)

```text
specs/007-deputy/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cli-daemon.md
│   └── deputy-turn.md
├── checklists/requirements.md
└── tasks.md             # $speckit-tasks
```

### Source Code (repository root)

```text
src/
├── domain/
│   ├── state.ts              # DetailCode needs_draft; detail.failure có cấu trúc
│   ├── task.ts               # RequesterKind deputy
│   └── policy.ts             # role deputy
├── engine/
│   ├── deputy-routing.ts     # DEPUTY_ROUTE, routeOf (thuần, có nhóm auto)
│   ├── escalation.ts         # hết thang vào lại wait (R-15)
│   ├── continue.ts           # thêm các wait mới
│   ├── intake.ts             # draft → needs_draft; task_revise
│   └── questions.ts          # bỏ WORKER_WAITS/decider cho lượt mới, giữ replay
├── application/
│   ├── authz.ts              # actor deputy
│   ├── commands.ts           # reason, task_revise, amend → operate, từ chối confirm của deputy
│   ├── amend-policy.ts       # --agent-runs, --deadline
│   ├── attention.ts          # Deputy.holds
│   └── report.ts             # deputy_decisions
├── daemon/
│   ├── deputy.ts             # thay decider.ts
│   ├── server.ts             # header x-cusr-turn
│   └── production.ts         # nối deputy, nâng cấp từ decider
├── store/
│   ├── migrations/008_deputy.sql
│   └── deputy.ts             # đọc/ghi deputy_sessions, deputy_turns
├── adapters/
│   ├── harness/claude.ts, codex.ts  # interactiveArgv, hook hết lượt
│   └── github/publish.ts     # mục quyết định trong thân PR
├── runner/
│   ├── invocation.ts         # chế độ tương tác, turn-ended.json, outcome turn_ended
│   ├── process-tag.ts        # CUSR_DEPUTY_TURN
│   ├── private-home.ts       # gộp hook hết lượt, luật cấm sửa worktree
│   └── sandbox.ts            # giữ CUSR_DEPUTY_TURN
├── cli/
│   ├── worker-guard.ts       # cho qua deputy, im hook trợ lý
│   ├── client.ts             # actor deputy, header turn
│   └── tasks.ts              # --reason, task revise, --draft, amend mới
└── config/                   # roles.deputy, alias decider

test/
├── property/deputy/          # bảng định tuyến, chuyển trạng thái lượt
├── integration/store/        # migration 008, bản ghi lượt không đổi version
├── integration/crash/        # restart giữa lượt
├── integration/runtime/      # nâng cấp từ decider
├── contract/deputy/          # restore worktree, hook hết lượt, CLI
├── scenarios/deputy/         # Story 1–6 với fake harness
└── smoke/                    # SC-002, SC-003 với harness thật
```

**Structure Decision**: Giữ một package. Engine chỉ thêm bảng định tuyến thuần và mở rộng `continue`; mọi thứ về phiên,
lượt và harness nằm ở daemon, runner và adapter.

## Complexity Tracking

| Thêm vào baseline | Vì sao cần | Lựa chọn đơn giản hơn bị loại vì |
| --- | --- | --- |
| Bảng `deputy_sessions`, `deputy_turns` | Bản ghi lượt bền qua restart, truy vấn được, không làm đổi version của task (FR-022, FR-023) | Event của task làm lệnh của chủ dự án bị từ chối; file JSON như decider không truy vấn được theo task |
| Chế độ tương tác trong runner | Chủ dự án chọn phiên native | Chỉ headless: trái quyết định của chủ dự án |
