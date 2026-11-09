# Implementation Plan: Deputy và goal

**Branch**: `docs/007-deputy-goal` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Story 1–8, FR-001–FR-124, Edge Cases, SC-001–SC-012 và hai phiên Clarifications của spec.

**Mã nền**: đối chiếu tại `origin/main` `62eadbd`.

**Trạng thái:** thiết kế xong. Amendment hiến chương 11.0.0 sửa cùng PR với bản viết lại này; feature chỉ được triển khai
sau khi chủ dự án merge PR đó. Một spike về hook hết lượt chạy trước lát G
([R-03](research.md#r-03--lượt-native-hook-hết-lượt-dự-phòng-headless)).

## Summary

Hai thành phần mới, mỗi thành phần dùng lại tối đa cái đã có:

1. **Deputy theo lượt** (`src/daemon/deputy.ts`, thay decider): mỗi sự cố hay mỗi lần goal cần kế hoạch mở một phiên harness
   mới, context do code dựng theo vùng từ sổ goal ([R-16](research.md#r-16--lượt-ngắn-thay-cho-phiên-deputy-theo-task),
   [R-17](research.md#r-17--sổ-goal-là-view-context-theo-vùng)). Lượt hành động bằng `cusr`, kết thúc bằng bàn giao. Code
   tính chữ ký lỗi, tín hiệu vòng lặp và bảng thử, và chặn lặp ở `admitCommand`
   ([R-18](research.md#r-18--chữ-ký-lỗi-khóa-finding-và-tín-hiệu-vòng-lặp), [R-19](research.md#r-19--ba-luật-chống-lặp-và-bảng-thử)).
2. **Goal** (aggregate trong cùng event log, [R-21](research.md#r-21--goal-là-aggregate-thứ-hai-trong-cùng-event-log)):
   kế hoạch có version và hash, duyệt một lần. Goal nhiều đơn vị có nhánh goal: mỗi đơn vị là task thường có `base_branch`
   là nhánh goal, merge vào đó theo đường yolo với approver `policy:goal`; task tổng mở PR của goal vào nhánh gốc
   ([R-23](research.md#r-23--nhánh-goal-và-merge-vào-nhánh-goal), [R-24](research.md#r-24--task-tổng)).

Engine giữ hành vi vào wait; scheduler giữ scope guard (#240). Phần engine mới đều là hàm thuần: bảng định tuyến, chữ ký
lỗi, tín hiệu vòng lặp, bảng thử, loop guard, kiểm và phân loại kế hoạch, hiệu lực của bản miễn.

## Technical Context

| Mục | Thiết kế |
| --- | --- |
| Language/Version | Node 24 LTS, TypeScript strict/ESM, `tsc`; giữ baseline repo |
| Primary Dependencies | Có sẵn: Commander, Zod 4, `better-sqlite3`, uuid. Không thêm dependency; không đòi cài công cụ nào |
| Storage | SQLite hiện có. Một migration: cột `events.stream`, bảng `goals`, `goal_tasks`, `deputy_turns`, `branch_conflicts`, bốn cột mới của `command_ledger` ([data model](data-model.md)) |
| Testing | Vitest và fast-check: property test cho định tuyến, chữ ký lỗi, tín hiệu, loop guard (SC-009), ngân sách context (SC-010), kế hoạch; integration SQLite thật cho migration, aggregate goal, bản ghi lượt, crash injection; contract test cho trả về worktree, hook hết lượt, CLI, tạo nhánh goal và merge trên git thật với remote giả; scenario Story 1–8 với fake harness; smoke harness thật tách riêng |
| Target Platform | Linux/Ubuntu hoặc WSL2; terminal backend tùy chọn |
| Project Type | Một package CLI/daemon/runner; thêm module, không thêm binary hay process thường trực |
| Performance Goals | Sự cố tới deputy trong một vòng scheduler (1 giây); context vùng 2–5 mặc định ≤ 16 KiB; SC-003 tiếp tục chậm nhất 1 phút sau `stall_ms` |
| Constraints | Engine thuần (I01); lượt không giữ reservation; bản ghi lượt và xung đột nhánh không làm đổi version; không thêm sandbox ngoài harness |
| Scale/Scope | Một người dùng; lượt song song bằng số task có sự cố cộng số goal đang lập kế hoạch |

## Constitution Check

Đối chiếu hiến chương 11.0.0 (cùng PR). Không xin ngoại lệ.

| Nguyên tắc | Đánh giá | Cách tuân thủ |
| --- | --- | --- |
| I. Lõi tất định | Đạt | Engine vào wait như hiện nay; định tuyến, chữ ký, tín hiệu, bảng thử, loop guard, kiểm và phân loại kế hoạch là hàm thuần. Dispatch vẫn ở scheduler. Deputy chỉ được gọi ở ranh giới và hành động qua dịch vụ |
| II. Effect sau commit, idempotent | Đạt | Lệnh goal và lệnh deputy qua `accept` (request ID, expected version, plan version). Tạo nhánh goal là effect có probe. Merge vào nhánh goal đi đường yolo đã có probe. Bản ghi lượt ghi trước spawn; `recover` không spawn lại |
| III. Vòng lặp có giới hạn | Đạt theo 11.0.0 | Không trần tổng cho deputy; ba luật chống lặp và loop guard bằng code (R-19); `max_visits` giữ nguyên |
| IV. Bằng chứng | Đạt theo 11.0.0 | Bản miễn là event gắn chữ ký, không áp cho required check của protected branch; review và gate giữ nguyên ngoài bản miễn; merge vào nhánh goal đòi head chứa đỉnh nhánh goal và check xanh |
| V. Người dùng giữ quyền | Đạt theo 11.0.0 | Kế hoạch duyệt một lần theo hash; sửa phạm vi phải duyệt lại; deputy không xác nhận; merge vào nhánh goal do code, PR goal vào nhánh gốc do người (hay yolo của người); quyền deputy theo ID lượt, phạm vi goal và bảng quyền; lệnh goal của trợ lý cần lease |
| VI. Lõi trung lập | Đạt | Engine biết mã wait, actor, kế hoạch dạng dữ liệu; argv tương tác và hook nằm ở adapter; bộ lọc log dùng cho chữ ký là của repo |
| VII. Kiểm chứng trung thực | Đạt theo 11.0.0 | Bằng chứng theo tầng; gate được miễn báo là miễn; SC-002, SC-003 chỉ ở smoke, báo "chưa đạt" nếu chưa chạy |
| VIII. Đơn giản | Đạt, có Complexity Tracking | Không dependency, không process thường trực; goal dùng lại event log, base branch, phụ thuộc, base update, yolo merge, scope guard |
| Trust boundary | Đạt theo 10.0.0 | Deputy toàn quyền; thay đổi trong worktree của task bị trả về theo mốc |

Ràng buộc kỹ thuật và bảo mật:

- **Secret:** yêu cầu của goal, bằng chứng của bản miễn, `final_message`, bàn giao và context của lượt đi qua `Redactor`
  trước khi lưu.
- **Trust boundary:** actor `deputy`, lượt đang chạy, phạm vi goal và lease được kiểm ở `admitCommand`, không chỉ ở CLI.

## Thiết kế chính

```text
                      ┌──────────── goal add (trợ lý giữ lease) ───────────┐
                      ▼                                                    │
  lượt plan ──goal propose──▶ awaiting_confirm ──goal confirm (hash)──▶ running
                                                     │
              ┌──────────────────────────────────────┼────────────────────────────┐
              ▼ một đơn vị                            ▼ nhiều đơn vị                │
        task (base = nhánh gốc)        git.create_goal_branch + đơn vị (base = nhánh goal)
              │                                       │  scheduler: phụ thuộc, slot, scope guard
              ▼                                       ▼
        PR vào nhánh gốc               PR đơn vị → CI → head chứa đỉnh nhánh goal?
                                                      │ không: base update, gate, CI lại
                                                      ▼ có: merge (policy:goal, merge commit)
                                       mọi đơn vị DONE ──▶ task tổng (goal_final) ──▶ PR goal vào nhánh gốc

  engine vào wait ──▶ deputy.round(): routeOf(state, autonomous)
     ├─ auto ──▶ không đánh thức ai
     ├─ owner ──▶ attention như hiện nay
     └─ deputy ──▶ baseline worktree + deputy_turns(running)
                    ──▶ context theo vùng (goal-ledger, trials, loop-signals, branch_conflicts)
                    ──▶ RunnerHarness.run(role deputy, CUSR_DEPUTY_TURN)
                         cusr … --reason [--hypothesis --expect] ──▶ admitCommand(turn, phạm vi goal, bảng quyền, loopGuard)
                         cusr deputy handoff ──▶ deputy_turns.handoff_json
                    ◀── turn_ended | failure
                    restore worktree ──▶ handed_off | done | aborted ──▶ loop guard sau lượt
```

## Thứ tự giao

Mỗi lát là một PR. Lát sau phụ thuộc lát trước trừ khi ghi khác.

| Lát | Nội dung | Điều kiện qua lát |
| --- | --- | --- |
| 0 | Amendment 11.0.0 và bản viết lại spec/plan/tasks (PR này) | Chủ dự án merge |
| A | Nền: migration, danh tính `deputy`, `reason`/`trial`/`turn_id`, bảng định tuyến, hết thang thành wait, `task fail`, mở rộng `continue`/`amend-policy`, `amend-policy` cho `operate` | Contract test CLI; US2 kịch bản giới hạn chạy được với caller giả lập deputy |
| B | Lượt headless: `deputy.ts` thay decider, bản ghi lượt, bàn giao, `aborted`, chuyển cho người, lỗi, trả về worktree, nâng cấp từ decider | US1, US6 (phần task), US7; SC-001, SC-004 (lượt), SC-005, SC-006, SC-008 |
| C | Vòng lặp: khóa finding, chữ ký lỗi, tín hiệu, bảng thử, loop guard, bản miễn | US2; SC-009 |
| D | Goal và kế hoạch: aggregate, `goal` CLI, kiểm và phân loại kế hoạch, lease, goal ẩn, sổ goal và context theo vùng, lượt `plan` | US3 kịch bản 1–4, 8, 9; US5; SC-010 |
| E | Nhánh goal: tạo nhánh, đơn vị nhắm nhánh goal, merge `policy:goal`, task tổng `goal_final`, mô tả PR | US3 kịch bản 5–7; SC-004 (merge), SC-012 |
| F | Điều phối: `branch_conflicts`, kiểm scheduler với goal, replan khi đơn vị FAILED | US4; SC-011; US3 edge cases |
| G | Lượt tương tác: spike, `interactiveArgv`, hook hết lượt, stall sang headless, terminal backend | SC-003 (smoke); US8 kịch bản 2 |
| H | Ghi nhận: `decisions.md`, `report`, `goal show`, chi tiết task, mục trong mô tả PR | US8; SC-007 |
| I | Đồng bộ tài liệu vận hành (gộp mục còn chờ của 10.0.0), smoke đêm thật | SC-002 |

C và D làm song song được sau B. E cần D. F và H cần E. G chỉ cần B.

## Rủi ro

| Rủi ro | Cách xử lý |
| --- | --- |
| Reviewer không giữ khóa finding | Dự phòng khóa theo file và hash `msg` (R-18); tín hiệu `fix_misses_files` không cần khóa |
| Chữ ký gate dao động vì log chứa số ngẫu nhiên | Chuẩn hóa bỏ số dòng, đường dẫn tạm, thời gian; bộ lọc log của repo; property test trên log mẫu |
| Deputy dùng bản miễn để đi tắt | Miễn một lần mỗi mục trên một chữ ký, cần bằng chứng, liệt kê trong PR; không áp cho protected branch; chủ dự án thấy ở PR cuối |
| Tích hợp tuần tự làm chậm goal có nhiều đơn vị song song | Chỉ bước merge tuần tự; code, gate, review vẫn song song; base update chỉ chạy khi nhánh goal đã đi |
| PR của goal quá lớn để review | Merge commit từng đơn vị; mô tả PR liệt kê đơn vị; reviewer task tổng đọc theo merge commit khi diff vượt giới hạn |
| Input hook Stop không có tin nhắn cuối | Đọc từ transcript; spike lát G chọn cách |
| Nội dung không tin cậy điều khiển deputy | Rủi ro đã chấp nhận; daemon vẫn chặn `admin`, xác nhận, merge, và phạm vi goal của lượt |

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
│   ├── deputy-turn.md
│   └── goal.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── domain/
│   ├── state.ts              # DetailCode plan_amendment; finding key; detail.failure
│   ├── task.ts               # RequesterKind deputy; TaskInput.goal
│   ├── goal.ts               # GoalState, PlanSchema (mới)
│   ├── event.ts              # Waived, ReviewWaived, event của goal
│   └── policy.ts             # role deputy
├── engine/
│   ├── deputy-routing.ts     # DEPUTY_ROUTE, routeOf
│   ├── failure-signature.ts  # chữ ký lỗi
│   ├── loop-signals.ts       # tín hiệu vòng lặp
│   ├── trials.ts             # bảng thử, loopGuard
│   ├── waivers.ts            # hiệu lực bản miễn trên review, gate, CI
│   ├── plan.ts               # validatePlan, parallelGroups, classifyAmendment, affectedUnits
│   ├── goal/                 # decide/evolve của aggregate goal
│   ├── escalation.ts         # hết thang vào lại wait
│   ├── continue.ts           # thêm các wait mới
│   └── workflows/goal-final.ts
├── application/
│   ├── authz.ts              # actor deputy, phạm vi goal, bảng quyền, lease
│   ├── commands.ts           # reason, trial, task_fail, task_waive, lệnh goal
│   ├── goal-ledger.ts        # sổ goal (view)
│   ├── deputy-context.ts     # context theo vùng
│   ├── amend-policy.ts       # --agent-runs, --deadline
│   ├── attention.ts          # Deputy.holds; tin của goal
│   └── report.ts             # deputy_decisions, waivers, goals
├── daemon/
│   ├── deputy.ts             # thay decider.ts
│   ├── goal-branch.ts        # effect git.create_goal_branch
│   ├── yolo.ts               # điều kiện policy:goal
│   ├── conflicts.ts          # branch_conflicts sau checkpoint
│   ├── server.ts             # header x-cusr-turn, x-cusr-lease
│   └── production.ts         # nối deputy, goal, nâng cấp từ decider
├── store/
│   ├── migrations/NNN_deputy_goal.sql
│   ├── deputy.ts             # deputy_turns
│   └── goals.ts              # projection goals, goal_tasks
├── adapters/
│   ├── harness/claude.ts, codex.ts  # interactiveArgv, hook hết lượt
│   └── github/publish.ts     # mục quyết định, bản miễn, danh sách đơn vị
├── runner/                   # chế độ tương tác, turn-ended.json, CUSR_DEPUTY_TURN
├── cli/                      # goal, deputy handoff, task fail|waive, --reason, --hypothesis, --expect
└── config/                   # roles.deputy, alias decider

test/
├── property/deputy/          # định tuyến, chữ ký, tín hiệu, loop guard, context, kế hoạch
├── integration/store/        # migration, goal aggregate, bản ghi lượt không đổi version
├── integration/crash/        # restart giữa lượt, giữa tạo nhánh và merge
├── integration/runtime/      # nâng cấp từ decider, task cũ thành goal ẩn
├── contract/deputy/          # trả về worktree, hook hết lượt, CLI, nhánh goal trên git thật
├── scenarios/deputy/         # Story 1–8 với fake harness
└── smoke/                    # SC-002, SC-003 với harness thật
```

**Structure Decision**: Một package. Engine thêm hàm thuần và aggregate goal; phiên, lượt, harness, git và GitHub ở daemon,
runner và adapter.

## Complexity Tracking

| Thêm vào baseline | Vì sao cần | Lựa chọn đơn giản hơn bị loại vì |
| --- | --- | --- |
| Aggregate goal trong event log (`events.stream`, `goals`, `goal_tasks`) | Kế hoạch có version, duyệt một lần, sửa có kiểm, idempotent qua restart (FR-054, FR-074, FR-075) | Không có goal: chuỗi task qua đêm dừng ở mỗi merge; bảng không event: mất idempotency và replay |
| Bảng `deputy_turns` | Bản ghi lượt bền qua restart, truy vấn được, không làm đổi version (FR-025) | Event của task làm lệnh của chủ dự án bị từ chối |
| Bảng `branch_conflicts` | Xung đột thật cho context và `goal show` mà không làm đổi version (FR-092) | Tính lại ở mỗi lần đọc: chạy `merge-tree` trên đường đọc của CLI |
| Chế độ tương tác trong runner | Chủ dự án chọn phiên native | Chỉ headless: trái quyết định của chủ dự án |
| Workflow `goal_final` | PR của goal dùng lại publish, review, CI, merge | Đường publish riêng cho goal: nhân đôi mã đã kiểm chứng |
