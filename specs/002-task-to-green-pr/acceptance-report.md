# Báo cáo nghiệm thu baseline US1 (T049)

Ngày chạy: 2026-10-29, nhánh `002/preflight` (PR Phase 3), sau khi đối chiếu với hợp đồng
[hai chế độ và xác nhận cấu hình chạy](task-execution-modes.md) (PR #8–#10). Toàn bộ chạy với fake
harness, fake GitHub và Clock do test điều khiển; Git thật (worktree, commit, bare remote). Không có
tài khoản/model thật, không publish PR thật. Đây là baseline của US1 tại checkpoint Phase 3,
**không** phải nghiệm thu toàn bộ US1.1–11 hay M01–M08/H01–H06.

Lệnh: `pnpm typecheck`, `pnpm lint`, `pnpm test` (default project): sạch.

Kết quả chạy theo spec cũ (trước PR #8–#10) không được dùng làm bằng chứng cho các dòng dưới; mỗi dòng
trỏ tới test đã chạy lại sau đối chiếu.

## Assertion đã chạy

| Kịch bản | Bằng chứng | Kết quả |
| --- | --- | --- |
| US1.1 happy path hai mode tới PR xanh, chờ merge | `test/integration/runtime/feature-002-flow.test.ts` (`describe.each` direct-pr/full-review): xác nhận bộ lựa chọn → worktree → coder (template frozen trong context, nội dung PR ra file ngoài worktree) → gates → checkpoint commit bằng message worker → review (chỉ full-review, đọc base..checkpoint và nội dung PR) → push đúng SHA checkpoint vào bare remote → một PR (title/body worker + một block marker cuối) → CI xanh qua evaluator → WAITING/approval `merge` | Đạt |
| Một worktree/branch/PR, zero merge request | Cùng test, cả hai mode: một branch `cusr/...` trên remote ở đúng SHA checkpoint; một PR; không POST/PUT merge, không effect `merge`, không `ApprovalRequested`; slot đã trả | Đạt |
| US1.6 merge do người dùng → proof → drain → DONE một lần | Cùng test (merged head = checked head, `unverified: null` ở cả hai mode); `drain.test.ts`; property `external-completion.test.ts` chạy trên cả hai mode | Đạt |
| Dependency core chỉ sau DONE | Flow test (con PENDING khi cha chờ merge, READY sau DONE); `drain.test.ts`; property | Đạt |
| US1.2 thiếu acceptance/chưa xác nhận/dependency chưa DONE | `confirm-start.test.ts`, `task-cli.test.ts` | Đạt |
| US1.3/US1.5 cấu hình/năng lực lỗi trước RUNNING → PENDING, chưa worktree | `confirm-start.test.ts`, `preflight.test.ts` (theo mode), `preflight-git.test.ts` | Đạt |
| US1.4 cùng request ID → kết quả cũ; khác nội dung → conflict | `task-cli.test.ts`, `confirm-start.test.ts` | Đạt |
| US1.8 PENDING config sửa xong → request mới đọc base mới nhất | `confirm-start.test.ts`, `preflight-git.test.ts` | Đạt (engine/application) |
| US1.9 merge khi effect còn chạy | `drain.test.ts` | Đạt một phần: dùng effect CI; fixer/push thật chờ T064/T078 |
| US1.10 A merged chưa chứng nhận | `execution-modes.test.ts`: merge sau head drift hoặc head khác → `merged_head_unverified` ở cả hai mode; direct-pr merge đúng checkpoint không bị ghi nhầm | Đạt một phần: explain chờ T106/T120 |
| US1.11 READY chờ slot không tính deadline, xin lại slot có tính | `scheduler.test.ts` | Đạt (engine) |
| Snapshot duy nhất trước RUNNING, một slot | `confirm-start.test.ts`, `scheduler.test.ts`, property `runtime-slot.test.ts` | Đạt |
| Green predicate đúng head; G ⊆ S | `github-checks.test.ts` (thêm green theo mode), property green theo mode, `required-subset.test.ts` | Đạt |

## Hai chế độ và xác nhận (M, bằng chứng fake)

| Mã | Đã kiểm ở baseline | Test | Còn chờ |
| --- | --- | --- | --- |
| M01 | Daemon không chọn mode theo size/rủi ro (graph v2 không skip XS); thiếu xác nhận không xếp hàng/không start; cờ tự khai không tồn tại; token assistant không xác nhận được | `execution-modes`, `scheduler`, `confirm-start`, `task-cli`, `preflight` | Đề xuất bởi agent thật, kênh tin cậy ngoài owner token (spec 003) |
| M02 | Xác nhận gắn digest/task/revision, replay giữ nguyên; đề xuất mới làm xác nhận cũ stale; lệch binding hiệu lực → PENDING `run_config_unconfirmed`; đổi sau start bị từ chối; binding worker ngoài bộ đã duyệt → chờ | như trên | Quota/fallback theo quota; T138 |
| M03 | direct-pr không có bước/lượt reviewer; full-review gắn checkpoint + input digest; dùng lại approve/findings khi input không đổi; nội dung/commit đổi → review lại | `feature-002-flow`, `execution-modes` | Reviewer riêng session thật (T076/T138) |
| M04 | Packet sửa lỗi dựng mới mỗi lần (nguyên nhân, log/findings, SHA/run, checkpoint, worktree, diff, PR); thiếu → `needs_context` | `context.test.ts` | Resume session thật T138, vòng sửa đầy đủ T055/T057/T064 |
| M05 | Template frozen (một file, chọn tường minh, nhiều → chờ), nội dung worker ngoài code, marker giả/ẩn bị từ chối ở cả hai mode, không có writer agent | `feature-002-flow`, `confirm-start`, `publish.test.ts`, `context.test.ts` | Quyết định cập nhật mô tả sau fixer/CI (T055/T057); output harness thật (US4) |
| M06 | Gate đổi tree → chạy lại có trần, không ổn định → chặn; checkpoint của đúng tree; push đúng SHA; worktree/branch/remote đổi → drift, chặn publish | `gates.test.ts`, `execution-modes`, `feature-002-flow`, `publish.test.ts` | Mutation/writer process thật (T073) |
| M07 | Probe chỉ nhận block marker canonical cuối body đúng digest; marker giả/nhân đôi/body sửa → conflict; cập nhật mô tả đọc trước/đọc lại sau, không ghi đè | `publish.test.ts` | Timeout/crash commit/push/PR (T082/T093) |
| M08 | Green/merged-head theo mode; direct-pr không giả approve, `review: not_required`; CI/merge thủ công vẫn bắt buộc | `github-checks`, property green, `execution-modes`, flow | Explain/CLI hiển thị đầy đủ (T106/T120) |

## Head drift khi review đang chạy (H)

| Mã | Bằng chứng | Kết quả |
| --- | --- | --- |
| H01 | `execution-modes.test.ts`: fact B (inject) trong lúc review A, approve A đến muộn được ghi, không gỡ blocker, không publish | Đạt (fact inject) |
| H02 | `execution-modes.test.ts`: publish đã enqueue bị vô hiệu khi biết B, claim bị chặn `head_changed` | Đạt (fact inject) |
| H03 | `feature-002-flow.test.ts`: B push lên branch thật trong lúc reviewer chạy, probe trước publish chặn, remote giữ B, không PR | Đạt (Git thật) |
| H04 | `publish.test.ts`: B chen giữa probe và push, guard expected-old tại update từ chối, không force | Đạt (bare remote thật) |
| H05 | `execution-modes.test.ts`: replay log giữ drift, blocker, review gắn A | Đạt phần replay; crash I/O ở T082/T093 |
| H06 | — | Chưa kiểm ở baseline (T051/T058) |

## Chưa nghiệm thu tại checkpoint này

- US1.7 và đường fixer/deadline đầy đủ, quyết định cập nhật mô tả PR sau sửa: T055/T057/T064/T078.
- Recheck và CLI explain của US1.8/10/11: T106/T120.
- Lịch quan sát PR và H06: T051/T058–T061; hiện drift/merge được thấy khi `await_ci`/publish chạy hoặc
  khi gọi `observeTask`.
- Vòng lặp `cusrd` chưa chạy scheduler/drain/effect handler thật (wiring daemon, runner systemd T073);
  lệnh setup chưa có trong snapshot nên `prepare` báo `setup.ran=false`; `reconcile` luôn
  `still_unknown` tới T090.
- Real harness/resume session (T138), tổng hợp M01–M08/H01–H06 (T139), smoke thật (Phase 10).

# Nghiệm thu Phase 4 — US2 vòng sửa, giới hạn CI và quan sát PR (T064)

Ngày chạy: 2026-10-29, nhánh `claude/hopeful-wozniak-0psgls`. Fake harness (kể cả session port giả),
fake GitHub/`gh api` fixture, Clock do test điều khiển; Git thật ở flow test. Không có tài khoản/model
thật, không publish PR thật. Fake session port không phải bằng chứng resume của harness thật (T138);
M01–M08 được kiểm lại ở T139 sau adapter thật US4.

Lệnh: `pnpm typecheck`, `pnpm lint` sạch. `pnpm test`: mọi test Phase 4 pass; hai test đã đỏ trên
`main` trước thay đổi này trong môi trường chạy (container root, Node 22.22 thay vì 24.22.1) vẫn đỏ, không
liên quan: `test/unit/runner/sandbox.test.ts` “refuses a parent of the host home” (HOME=/root) và
`test/integration/runtime/daemon-control.test.ts` “keeps replaying a success stored by a daemon before the ledger kept outcomes”.

## US2 và các FR

| Kịch bản | Bằng chứng | Kết quả |
| --- | --- | --- |
| US2.1 gate fail → fixer nhận log/acceptance, gate chạy lại trước review, không publish | `feature-002-fixes.test.ts` “US2.1” | Đạt (engine/SQLite) |
| US2.2 request_changes → fixer → gate → checkpoint commit mới → review mới trước publish | `feature-002-fixes.test.ts` “US2.2”; property `runtime-evidence.test.ts` (một lượt reviewer cho mỗi input khác nhau) | Đạt |
| US2.3 CI lỗi code → sửa trên worktree → cùng PR, mô tả cập nhật; CI head cũ không làm head mới xanh | `feature-002-fixes.test.ts` “US2.3”; `feature-002-flow.test.ts` “repair flow” (Git thật, cả hai mode: push fast-forward, một branch/PR, PATCH title/body một lần, merge head mới verified) | Đạt |
| US2.4 infra/flaky rerun trong giới hạn, không nâng model; chưa phân loại → chờ | `feature-002-fixes.test.ts` “US2.4” ×2; `github-observation.test.ts` (rerun POST một lần, mất trả lời → unknown) | Đạt |
| US2.5 hết lượt → không attempt, hiện giới hạn | `feature-002-fixes.test.ts` “US2.5” | Đạt |
| US2.6 G⊆S, mismatch nêu hai phía, unknown → infra, none hợp lệ | `feature-002-fixes.test.ts` “required checks” ×3; property `required-subset.test.ts` (thêm hoán vị); `github-observation.test.ts` (rules 403 → unknown) | Đạt |
| US2.7 head ngoài → head_changed; base tip đơn lẻ (H06) giữ evidence; GitHub thêm check ngoài snapshot → thu hồi, bao phủ lại → xanh | `feature-002-fixes.test.ts` “US2.7” ×3 | Đạt |
| US2.8 check rerun pending/fail thu hồi xanh → CI/vòng sửa; PR đóng → pr_closed, không PR mới; mở lại → đối chiếu lại | `feature-002-fixes.test.ts` “US2.8” ×2 | Đạt |
| US2.9 hết cửa sổ CI theo head → ci_wait_exhausted; CI pass muộn chỉ là bằng chứng; merge vẫn DONE | `feature-002-fixes.test.ts` “US2.9” | Đạt |
| US2.10 hết deadline khi chờ merge → chặn việc mới, quan sát tiếp, merge sau đó DONE | `feature-002-fixes.test.ts` “US2.10” | Đạt |
| US2.11 hết hạn quan sát → observation_expired, ngừng poll; recheck một lượt, không bật lại lịch; merge thấy qua recheck → DONE | `feature-002-fixes.test.ts` “observation window”; `observation-limits.test.ts` (hết hạn không I/O, cả sau restart); property `runtime-limits.test.ts` | Đạt |
| US1.7 PR xanh rồi head/required đổi | như US2.7/US2.8 | Đạt (engine) |
| US1.9 đường fixer/deadline | `feature-002-fixes.test.ts` “US1.9”; recheck drain sau deadline | Đạt (engine) |
| US1.11 deadline thực khi sửa | `scheduler.test.ts` (Phase 3) + “US1.9” | Đạt (engine) |
| SC-003 phân loại/giới hạn: invalid output repair + phiên mới, rate limit tính lượt, auth/refusal chờ người | `feature-002-fixes.test.ts` “SC-003”, “auth and refusal” | Đạt (fake) |
| SC-010 thu hồi xanh và quan sát qua PR đóng/hết CI/deadline | các dòng US2.7–US2.11 | Đạt (fake); explain ở T106/T120 |
| FR-043.05 không chuỗi poll trùng, restart không reset | `feature-002-fixes.test.ts` (generation cũ bị bỏ qua, replay giữ cửa sổ); `observation-limits.test.ts` (gộp lượt đọc cùng task) | Đạt |
| FR-046 recheck: operate, dedup, config/observation/drain, terminal chỉ ghi log | `feature-002-fixes.test.ts` “recheck service” ×3 | Đạt (service + fake ports); route CLI ở T110 |
| FR-026 source drift ở ranh giới runtime | `feature-002-fixes.test.ts` “source drift at the runtime boundary” | Đạt; áp revision mới cho task runtime bị từ chối (cần task mới) |

## Cập nhật M/H

| Mã | Thêm ở Phase 4 | Còn chờ |
| --- | --- | --- |
| M04 | Quyết định resume: chỉ resume session worker cùng binding khi harness chứng minh resume; không thì phiên mới kèm lý do (`no_session`, `binding_changed`, `fresh_session_requested`, `resume_unknown`); packet sửa luôn dựng đủ (flow test hai nhánh) | Resume harness thật T138 |
| M05/M07 | Sau sửa, nội dung worker mới cập nhật title/body của chính PR (đọc trước/PATCH/đọc lại), giữ marker; body bị sửa trên GitHub → chờ người | Output harness thật (US4) |
| M06 | Push fast-forward checkpoint mới sau sửa, head cũ là tổ tiên | Crash I/O T082/T093 |
| H06 | Base tip đổi đơn lẻ không thu hồi review/evidence, không gọi fixer/gate | — |

## Chưa làm ở Phase 4

- Vòng lặp `cusrd` chưa chạy service quan sát/recheck (cùng tình trạng scheduler/drain/handler ở Phase 3);
  route CLI `task recheck` thuộc T110.
- Cache 304 của T061 chưa làm: service không gửi request có điều kiện, nên không có cache để dùng lại.
- Chi tiết chờ hết deadline vẫn dùng mã `deadline` của lõi 001; spec gọi là `task_deadline`.

# Nghiệm thu Phase 5 — US4 agent đúng quyền và bằng chứng (T065–T077, T138)

Ngày chạy: 2026-10-29, nhánh `claude/wizardly-faraday-kf91dl`. Không gọi model, không tài khoản thật,
không publish PR thật. Run thật T007 được phát lại qua adapter production và qua runner lifecycle thật
bằng một binary thay thế (`test/fixtures/runtime/fake-vendor/vendor.js`); đó là phát lại fixture, không
phải smoke xuyên suốt với vendor thật. Container chạy không có `/usr/bin/bwrap` và systemd user, nên các
suite OS thật (`sandbox-bwrap`, `harness-bwrap`, `supervisor-systemd`) bị skip ở đây.

Lệnh: `pnpm typecheck`, `pnpm lint` sạch. `pnpm test`: mọi test Phase 5 pass; hai test đỏ sẵn trên
`main` trong môi trường này (root/HOME=/root, Node 22.22) vẫn đỏ, không liên quan: `sandbox.test.ts`
“refuses a parent of the host home” và `daemon-control.test.ts` “keeps replaying a success stored by a
daemon before the ledger kept outcomes”.

### Suite OS thật trên host (T077)

Ngày chạy: 2026-10-29, `main` tại `c1a8b9e`. Host triển khai Ubuntu 24.04.5 LTS,
kernel 7.0.0-38-generic, bubblewrap 0.9.0, systemd 255 (`systemd --user` chạy được). Node 24.22.1 của host
nằm dưới `~/.nvm`, mà sandbox không bao giờ mount home, nên `harness-bwrap` tự skip; lần chạy dùng bản sao
nguyên vẹn của cùng binary node đặt ngoài home.

| Suite | Kiểm | Kết quả |
| --- | --- | --- |
| `sandbox-bwrap.test.ts` | `BwrapSandboxProvider` dưới bwrap thật: mount theo role, canary ngoài vùng ghi | 3/3 pass |
| `harness-bwrap.test.ts` | `RunnerHarness` dưới bwrap thật: coder ra kết quả hợp lệ; reviewer ghi worktree bị mount từ chối, không đổi gì, auth in ra bị che | 2/2 pass |
| `supervisor-systemd.test.ts` | `SystemdSupervisor` dưới `systemd --user`: một unit mỗi operation dưới kernel lock, từ chối launch thứ hai, dừng cgroup | 1/1 pass |

## US4

| Kịch bản | Bằng chứng | Kết quả |
| --- | --- | --- |
| US4.1 hai harness đã kiểm chứng, mỗi role chuẩn hóa với provenance attempt; usage thiếu = unavailable | `harness.test.ts` sáu run role × vendor; `harness-invocation.test.ts` sáu run qua lifecycle (out/result.json có manifest/inner mode/context digest); flow `feature-002-real-adapters.test.ts` hai mode (BudgetConsumed đúng số run, OutputIngested/ArtifactIngested) | Đạt (fixture replay) |
| US4.2 exit 0 nhưng sai cấu trúc/cắt/ngữ nghĩa/artifact cũ không done/approve | `harness.test.ts` “a final answer is accepted only when every layer holds”; `harness-invocation.test.ts` exit1, thiếu file Codex | Đạt |
| US4.3 quyền hiệu lực theo role; ghi ngoài vùng → dừng đối chiếu; môi trường không chứng minh → chặn | `sandbox-permissions.test.ts`; `harness-invocation.test.ts` (reviewer sửa worktree → `boundary_violation`; binary/settings/env/host đổi, file rules sửa sau khi chốt pin (lệch `sha256`), sandbox plan lỗi, home không rỗng, thiếu credential → `capability_missing`, không launch) | Đạt; mount bwrap thật trên host (bảng trên) |
| US4.4 im lặng còn tiến triển không là stall; hết hạn dừng đúng cây trong hạn | `runner-lifecycle.test.ts` (CPU, process con, file, chỉ ghi stderr, stdout từng phần chưa xuống dòng; stalled; TERM→KILL; `setsid` descendant; UTC nhảy; deadline bền) | Đạt (process thật; supervisor systemd thật ở bảng trên) |
| US4.5 secret che trước lưu, phần cắt báo rõ, output chưa ingest không mất | `runner-lifecycle.test.ts`, `artifacts.test.ts`, `harness-invocation.test.ts` (auth canary in ra stdout/stderr bị che trong mọi file run, nội dung worker sao chép ra đã che; giá trị auth Codex lặp lại trong `summary` bị che ở `out/result.json` và outcome); context cắt có marker (Phase 3) | Đạt |
| US4.6 quyền/trần chi phí cứng chưa có bằng chứng → chặn, không thay bằng ước lượng | `sandbox-permissions.test.ts` (`hard_cap` → `cost`), `harness-invocation.test.ts` (manifest thiếu proven, external_verified không được phép) | Đạt |

## M/H cập nhật

| Mã | Thêm ở Phase 5 | Còn chờ |
| --- | --- | --- |
| M02 | Mỗi attempt kiểm manifest hiện hành bằng `capability_refs` đã chốt; khác → chặn trước launch, trả chỗ | Doctor ghi manifest production |
| M04 | Session thật: chỉ resume khi manifest + adapter có dạng resume; Codex `unsupported`, reviewer không resume; packet sửa luôn mới | Resume thật: T099/T126 (T077 đóng với `unknown`, xem dưới) |
| M05 | Worker sandbox ghi nội dung vào scratch của run, harness sao chép file mới/đã che ra | — |

## Chưa làm ở Phase 5

- Chưa đối chiếu worktree trước mỗi attempt worker để không gán thay đổi dirty của người dùng cho agent (T072).
- Chưa có doctor ghi `CapabilityManifest` production; `cusrd` vẫn chưa nối effect handler/RunnerHarness,
  sweep retention chưa được lên lịch.
- Resume worker thật chưa được chứng minh (manifest T007 `session_resume: unknown`), mọi lượt sửa thật
  đi phiên mới có lý do. Chủ dự án quyết định 2026-10-29 đóng T077 với `unknown`, không chạy proof trả
  phí: coder chạy `--no-session-persistence` và mỗi attempt có private home mới nên resume Claude thật
  chưa thể thành công. Resume thật chuyển sang T099/T126 (FR-038), cần lưu phiên và chuyển transcript
  giữa các home trước.
