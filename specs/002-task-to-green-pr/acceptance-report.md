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

- ~~Chưa đối chiếu worktree trước mỗi attempt worker (T072)~~: đã xong 2026-10-29 — worktree khác tree
  task để lại thì chờ `worktree_changed`, `task recheck` nhận thay đổi của người dùng; layout sandbox pin theo role.
- Chưa có doctor ghi `CapabilityManifest` production; `cusrd` vẫn chưa nối effect handler/RunnerHarness,
  sweep retention chưa được lên lịch.
- Resume worker thật chưa được chứng minh (manifest T007 `session_resume: unknown`), mọi lượt sửa thật
  đi phiên mới có lý do. Chủ dự án quyết định 2026-10-29 đóng T077 với `unknown`, không chạy proof trả
  phí: coder chạy `--no-session-persistence` và mỗi attempt có private home mới nên resume Claude thật
  chưa thể thành công. Resume thật chuyển sang T099/T126 (FR-038), cần lưu phiên và chuyển transcript
  giữa các home trước.

# Nghiệm thu Phase 6 — cổng lát A

**Snapshot lượt đầu tại `5bda3ee`.** Các giới hạn T139 ở phần này là kết quả audit trước khi sửa;
xem [kết quả T139 tiếp theo](#t139--kiểm-tổng-hợp-m01m08-và-h01h06) cho trạng thái hiện hành.

Ngày: 2026-10-29. Nhánh `002/phase6-gate`, base `c1a8b9e` (`origin/main` sau Phase 5).
Owner cho tiếp tục với 4/16 mục checklist chưa tick; giữ nguyên checklist. Owner chọn **Ubuntu**
làm host nghiệm thu, không yêu cầu WSL2. Không lấy code từ PR #15 hoặc worktree T072 đang làm riêng.

**Kết luận kỹ thuật: đề nghị no-go, chưa mở B.** T072/T139 còn mở; T078 chưa đủ prerequisite.
T079 có bản review tại [go-no-go.md](go-no-go.md), T080 chờ quyết định tường minh của owner.
Một lượt chạy xanh không đóng được các nghĩa vụ chưa có assertion/bằng chứng.

## Lệnh và môi trường

[Baseline ledger](evidence/phase6-baseline.json) ghi từng file/kết quả và hash log/report.
[Host ledger](evidence/phase6-host.json) ghi OS/kernel, version/hash binary, userns và systemd user
probe thật. Node 24.22.1 được sao nguyên vẹn ra `/tmp/cusr-phase6-node/bin/node`, hash
`e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb` giống binary host.
Sandbox vẫn không mount home. Không sudo, đổi sysctl hoặc provisioning host.

| Kiểm | Kết quả |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` (ESLint và Prettier) | exit 0 |
| `pnpm test` với env dưới đây | 106 file / 1.431 test pass, 0 skip, exit 0 |
| `pnpm build` | exit 0 |
| `sandbox-bwrap.test.ts` / `harness-bwrap.test.ts` / `supervisor-systemd.test.ts` | 3/3 + 2/2 + 1/1 pass trên Ubuntu thật |
| `feature-002-gate.test.ts` bổ sung | 5/5 pass; SQLite file thật, đóng/mở lại |
| 20 seeds `2026102901`–`2026102920` | 20/20 pass, mỗi seed 347/347, tổng 6.940 lượt test, 0 skip; chẩn đoán trước khi đóng T139 |

```sh
# Dùng bản sao cùng binary bên ngoài home để không tự skip harness-bwrap.
mkdir -p /tmp/cusr-phase6-node/bin
cp "$(command -v node)" /tmp/cusr-phase6-node/bin/node
# Test CLI cố ý FORCE_COLOR=1; bỏ NO_COLOR kế thừa để Node không phát warning về hai biến mâu thuẫn.
env -u NO_COLOR -u FORCE_COLOR PATH="/tmp/cusr-phase6-node/bin:$PATH" pnpm test
```

Hai lượt đầu được giữ là failed: Node dưới host home làm skip `harness-bwrap` ở lượt đầu;
3 test `--version` cùng đỏ do warning `NO_COLOR`/`FORCE_COLOR`, kể cả khi chỉ bỏ `FORCE_COLOR`
vì test tự đặt lại biến này. Targeted CLI 10/10 pass sau khi bỏ cả hai biến kế thừa, rồi chạy lại
full suite như bảng trên. Không tắt warning, không lọc stderr hoặc nới assertion để làm xanh.

## Ledger 20 seeds

[phase6-seeds.json](evidence/phase6-seeds.json) lưu command filters, source hashes, mỗi seed/exit,
số passed/failed/pending theo file và hash report/log. `CUSR_SEED` điều khiển fast-check;
`--sequence.shuffle --sequence.seed=<seed>` đổi thứ tự suite/test Vitest. Các scenario integration
cố định được chạy lặp với thứ tự khác, không được gọi là 20 task ngẫu nhiên end-to-end.

Dùng `filters` trong ledger cho từng seed:

```sh
env -u NO_COLOR -u FORCE_COLOR PATH="/tmp/cusr-phase6-node/bin:$PATH" CUSR_SEED=2026102901 \
  node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const { filters } = JSON.parse(readFileSync('specs/002-task-to-green-pr/evidence/phase6-seeds.json', 'utf8'));
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'default', ...filters,
  '--sequence.shuffle', `--sequence.seed=${process.env.CUSR_SEED}`], { stdio: 'inherit' });
process.exit(result.status ?? 1);
JS
```

Nhóm test gồm US1/US2 hai mode, adapter lifecycle phát lại fixture, confirmation/admission,
checkpoint/gates, drain, service recheck (trong fixes), observation limits, context, required-subset
và toàn bộ contracts. Clock inject cho deadlines/limits. `feature-002-flow` assert một
worktree/branch/PR cho mỗi task, một create PR, zero merge requests, push SHA đã kiểm, mô tả cập nhật
trên cùng PR. Fixes/drain assert DONE sau receipts rõ và giới hạn dừng/poll; test mới assert
projection không lệch sau reopen. Các assertion đó giữ nguyên, không suy từ test count.

| Seed | Passed / total | Skip | Exit | Giây |
| --- | --- | --- | --- | --- |
| 2026102901 | 347/347 | 0 | 0 | 48.335 |
| 2026102902 | 347/347 | 0 | 0 | 42.847 |
| 2026102903 | 347/347 | 0 | 0 | 52.37 |
| 2026102904 | 347/347 | 0 | 0 | 57.24 |
| 2026102905 | 347/347 | 0 | 0 | 46.811 |
| 2026102906 | 347/347 | 0 | 0 | 41.003 |
| 2026102907 | 347/347 | 0 | 0 | 42.805 |
| 2026102908 | 347/347 | 0 | 0 | 48.003 |
| 2026102909 | 347/347 | 0 | 0 | 42.777 |
| 2026102910 | 347/347 | 0 | 0 | 41.94 |
| 2026102911 | 347/347 | 0 | 0 | 52.543 |
| 2026102912 | 347/347 | 0 | 0 | 59.736 |
| 2026102913 | 347/347 | 0 | 0 | 46.382 |
| 2026102914 | 347/347 | 0 | 0 | 41.538 |
| 2026102915 | 347/347 | 0 | 0 | 48.563 |
| 2026102916 | 347/347 | 0 | 0 | 50.057 |
| 2026102917 | 347/347 | 0 | 0 | 39.428 |
| 2026102918 | 347/347 | 0 | 0 | 36.663 |
| 2026102919 | 347/347 | 0 | 0 | 35.455 |
| 2026102920 | 347/347 | 0 | 0 | 38.744 |

## M01–M08 sau T139 audit

| Mã | Bằng chứng đã chạy | Phần chưa đủ để nghiệm thu toàn M |
| --- | --- | --- |
| M01 | `execution-modes`, `confirm-start`, `scheduler`: forged/stale/unconfirmed bị chặn, direct không cần reviewer capability | Luồng intake/confirmation production chưa nối trọn; không chứng nhận từ fixture |
| M02 | `feature-002-gate`: confirmation, dedup và projection qua đóng/mở SQLite; `confirm-start`: kiểm binding hiệu lực; `harness-invocation`: pin/capability đổi không launch | Ma trận merge.method config đổi sau freeze + replay snapshot cũ chưa tổng hợp ở T139; không tự đọc quota/chuyển mode |
| M03 | `execution-modes`, property `runtime-evidence`: direct không reviewer; no-op giữ SHA/reuse approve, findings không đổi dùng lại; body/commit đổi review mới. Test mới: đổi context/acceptance/base/policy không reuse | Chưa có flow cùng vendor/model worker/reviewer với session riêng và quyền ro qua real adapter; không lấy khác vendor đang test làm bằng chứng |
| M04 | `feature-002-flow` hai mode: CI → fixer nhận packet SHA/log mới, resume/fallback có lý do; `context`: thiếu failures/state/revision → needs_context; `harness-invocation`: session chỉ khi proven, reviewer không resume | Chưa có integration Q&A mới + resume/fixer và đổi state trong lúc dựng packet/trước spawn. Vendor resume thực vẫn unknown; không gọi thêm model trong lượt này |
| M05 | `confirm-start` template frozen/multiple-template chưa chọn; `flow` content mới sau CI; `publish` và flow cả hai mode chặn marker giả/canonical, worker content ra ngoài Git | Chưa kiểm nguyên flow template + fixer bằng vendor thật; fixture replay là tầng bằng chứng hiện có |
| M06 | `gates`: formatter đổi tree chạy lại toàn tập, trần 3 passes; `execution-modes`: mutation chặn commit/publish; real Git conditional push ở `publish`, drift ở `flow`; H01–H04 bên dưới | T072 chưa hoàn tất kiểm user dirty diff/boundary trước worker; không gán dữ liệu ngoài dự kiến cho agent |
| M07 | `git-commit`, `publish`: lost reply/probe/OID/body conflict; test mới giữ drift và callback qua SQLite reopen, redelivery không thêm BudgetConsumed/attempt | Chưa có nhận lại finalized review từ runner files trước gọi lại; callback test đã normalize không thay file recovery. H05 crash I/O rộng nằm ở B |
| M08 | `execution-modes`, `flow`, `external-completion`, `drain`: green/verified theo mode; direct không approve giả; manual merge method unknown vẫn verified/DONE; không gửi merge | Chưa chứng nhận CLI explain đầy đủ (T111), smoke thật và mọi biến thể method trong cùng flow |

Các phần B/C đã có task riêng không tự trở thành prerequisite A. Những mục T139 đòi trước A
(same-vendor/session, stale packet/Q&A và tổng hợp method/finalized-result) vẫn chưa được đánh dấu đạt.

## H01–H06

| Mã | Assertion / tầng đã chạy | Giới hạn |
| --- | --- | --- |
| H01 | `execution-modes`: drift B trước callback approve A giữ head_changed, receipt A thành lịch sử; property runtime-evidence | Fact drift inject tại engine/SQLite |
| H02 | `execution-modes`: approve enqueue publish rồi drift làm effect invalidated, claim bị từ chối | Không gửi request publish |
| H03 | `feature-002-flow`: B push trong lúc reviewer đọc A; probe publish chặn, B giữ nguyên, không PR | Real Git/bare remote, fake harness/GitHub |
| H04 | `publish`: B chen giữa probe và update remote, guard expected-old từ chối; không force | Real Git/bare remote |
| H05 | `feature-002-gate`: hai thứ tự callback/drift qua close/reopen SQLite, redelivery không thêm usage/reviewer; `execution-modes` replay | Callback normalized, chưa phải finalized runner-file recovery. Crash I/O rộng T082/T093 ở B |
| H06 | `feature-002-fixes` US2.7: chỉ base tip đổi không thu hồi evidence/green hoặc gọi fixer/gates | Engine/observation fixture; không suy rằng base dùng tính diff đã đổi |

## Kiểm tra bằng chứng lát 0

Manifest gốc giữ nguyên; không đổi fixture để giả rằng đã có proof mới.
Đối chiếu byte tại [host ledger](evidence/phase6-host.json): **268 file được tham chiếu, 261 có mặt
và khớp hash, 7 thiếu, 0 file có mặt bị lệch**. Cả 7 nằm trong `harness/real-20261028/*/stderr.log`,
không có ở worktree chính hoặc worktree PR #15; hash trong manifest đều là file không rỗng.
Không dựng log thay thế hoặc coi summary là log gốc. Danh sách cụ thể nằm trong ledger.

- S0.1: [host manifest](../../test/fixtures/runtime/spike-0/host/manifest.json) và
  [isolation record](../../test/fixtures/runtime/spike-0/harness/real-20261028/isolation-record.json)
  là lịch sử; ba OS suites của adapter hiện tại được kiểm lại trên Ubuntu ở lượt này.
- S0.2: [harness manifest](../../test/fixtures/runtime/spike-0/harness/real-20261028/manifest.json),
  [capabilities](../../test/fixtures/runtime/spike-0/harness/real-20261028/capability-manifest.json)
  và six-role fixture replay vẫn dùng được trong tests. Không đủ byte gốc để xác nhận lại toàn bộ
  bộ evidence; cost_limit/session_resume vẫn unknown, không ghi proven.
- S0.3: [merge-event manifest](../../test/fixtures/runtime/spike-0/github/real-20261028-merge-event/manifest.json),
  [rules manifest](../../test/fixtures/runtime/spike-0/github/live-rules/manifest.json) có file khớp hash;
  [T009 recheck](../../test/fixtures/runtime/spike-0/github/t009-recheck/manifest.json) là GET lịch sử,
  không tuyên rules/auth hiện hành đã được đọc lại. Không gửi merge hoặc tạo PR thử.

Đây là thiếu độ đầy đủ/freshness evidence, không phải yêu cầu quay lại WSL2. Ubuntu là đích đã chọn.
[Coverage 117 FR](phase6-coverage.md) phân biệt nhiệm vụ A còn mở và nhiệm vụ B/C chưa đến lượt.


# T139 — Kiểm tổng hợp M01–M08 và H01–H06

Ngày 2026-10-29, tiếp tục trên `002/phase6-gate` sau `5bda3ee`, theo yêu cầu owner làm T139.
Ubuntu là host nghiệm thu. Không lấy code từ worktree/PR T072 chưa merge. **T139 đạt trong phạm vi
fixture/property/SQLite/Git/process/OS của task; T072 và T078/T080 vẫn cần khép riêng trước mở B.**
Kết quả cuối: **106 file / 1.462 test pass, 0 skip**; typecheck/lint/build exit 0.
Ledger cuối: [t139-validation.json](evidence/t139-validation.json). Ledger 20 seeds cũ giữ nguyên;
không gắn kết quả 20 seeds ở mã cũ vào implementation T139 mới.

## Những lỗi được test tái hiện trước khi sửa

- Q&A ở bước code mất khi chuyển sang `ci_fix`: handler dùng answers của effect cũ/khác bước.
  Handler đọc mọi câu hỏi đã trả lời của đúng revision từ state hiện hành, gồm câu hỏi và câu trả lời.
  Q&A là phần bắt buộc trong context budget; không đủ chỗ thì `needs_context` thay vì cắt âm thầm.
- Drift/answer có thể chen vào các lần đọc Git async trong lúc dựng packet. Ngay trước harness,
  handler kiểm lại version và claimability; thay đổi còn hợp lệ thì dựng lại tối đa một lần,
  còn lệch/blocked thì không launch. `needs_context` do orchestrator từ chối **trước launch** chờ
  người (`human_input/agent_question`), nhả reservation và không tiêu BudgetConsumed; output
  needs_context từ agent đã thực sự chạy vẫn theo retry policy cũ. Property test kiểm cả hai mode.
- Review thiếu diff chưa gọi harness nhưng bị tính một agent run. Failure nay ghi `invoked:false`;
  negative flow assert worker dùng đúng một lượt, reviewer dùng 0 và không PR.
- `out/result.json` được ghi trước kiểm boundary nên có thể để lại approve không dùng được; một
  instance harness mới cũng luôn trả unknown cho review đã finalize. Nay kiểm boundary trước finalize,
  ghi nguyên tử review và recovery proof (input/exit/value digest + provenance/manifest) vào cùng
  `out/result.json`. Instance mới chỉ đọc lại khi role/schema/semantics, launch nonce/operation/run,
  input và manifest khớp, exit 0 và cây process đã rõ. Thiếu/lệch/legacy chưa có proof giữ unknown,
  không spawn lại. Usage/records của lượt cũ được giữ nguyên, không tạo usage ước lượng hoặc 0 giả.

Không đổi closed role schemas/digest đã chứng minh ở T003/T007; metadata orchestrator là bổ sung
trong result file, không sửa fixtures lịch sử hoặc FrozenPolicy/runtime hash cũ. Recovery ở đây là
đọc một finalized reviewer result đã có; startup scan/re-adopt mọi loại operation và crash I/O rộng
vẫn là T082/T093 của B. Worker đã launch hoặc review chưa finalize vẫn unknown, không tự chạy thay.

## Matrix nghiệm thu T139

| Mã | Assertion và bằng chứng |
| --- | --- |
| M01 | `execution-modes`, `confirm-start`, `scheduler`: thiếu/forged/stale confirmation không spawn; `direct-pr` không cần reviewer capability; admission giữ mode/binding đã duyệt |
| M02 | `feature-002-gate`: confirmation/dedup, old snapshot hash và projection qua SQLite reopen; `confirm-start` thêm squash/merge/rebase với config đổi sau freeze/reopen, GitHub `allow_squash_merge:false` vẫn admission; config/runtime unit phủ default/invalid/key lạ |
| M03 | `feature-002-real-adapters`: cùng vendor/model, worker/reviewer dùng run/home riêng, reviewer không --resume, bwrap ro thật từ chối ghi; `flow` thiếu reviewer diff không gọi/không tính lượt; `execution-modes` và property `runtime-evidence` phủ no-op/reuse approve/findings, đổi SHA/body/context/acceptance/base/policy buộc review mới |
| M04 | `flow` cả hai mode: Q&A bước code đi qua CI repair/resume, packet/digest mới; drift khi dựng packet chặn launch; state đổi một lần rebuild, đổi hai lần chờ người; unit context giữ Q&A trong cap bắt buộc; property không spend/retry pre-launch needs_context; `harness-invocation` kiểm adapter resume nhận đúng prompt Q&A/checkpoint mới |
| M05 | `confirm-start`: một template, nhiều template chưa chọn bị chặn, chọn tường minh freeze đúng blob; `flow`: content mới sau fixer/CI, marker giả/ẩn/entity/nhân đôi trong cả title lẫn body đều bị chặn ở hai mode; worker content nằm ngoài Git |
| M06 | `gates`: toàn tập gate đạt tree cuối sau formatter, trần 3 passes; `execution-modes` chặn tree/commit lệch; `flow` publish đúng SHA; H01–H04 và reviewer write denial không có publish trái phép |
| M07 | `git-commit`/`publish`: commit/push/create/update lost reply đều probe, không nhận PR marker giả, body drift không ghi đè; `harness-invocation`: fresh instance đọc finalized review từ disk, giữ usage/ingest, không launch lần hai kể cả khi thiếu credential/đã abort; input/result/exit/proof lệch thì unknown; `feature-002-gate` redelivery qua SQLite không tính BudgetConsumed lại |
| M08 | `flow` cả hai mode × squash/merge/rebase: preference frozen, manual method unknown vẫn verified/DONE theo checked head/proof/drain; `github-observe` phát lại cả ba PR merge/squash/rebase của T008, không dùng method preference để chặn proof; `execution-modes` direct không fake approve, head drift/unverified đúng; zero merge requests |

| H | Tầng và assertion |
| --- | --- |
| H01 | `execution-modes` + property: B được quan sát trước approve A, receipt A thành lịch sử, giữ blocker, không publish |
| H02 | `execution-modes` + property: approve A enqueue publish rồi B được biết, pending invalidated/claim bị từ chối |
| H03 | `flow`: remote B push lúc review A, probe trước publish chặn dù chưa có poll mới; bare Git giữ B |
| H04 | `publish`: B chen sau probe và trước update, expected-old guard từ chối; không force-push/nhận B |
| H05 | `feature-002-gate`: hai thứ tự callback/drift qua SQLite close/reopen/dedup, giữ SHA/blocker và không tính usage lại; `harness-invocation` nhận finalized review từ disk qua instance mới; crash I/O rộng T082/T093 chưa chạy, không phải prerequisite của A |
| H06 | `feature-002-fixes` US2.7: chỉ base tip đổi không thu hồi approval/green hoặc gọi fixer/gates |

Chạy các file trên trong default suite cùng toàn bộ regression 001/002; seed fast-check là
`20261029`. Targeted tests dùng `-t` có các test khác bị lọc (Vitest hiển thị skipped); ledger nghiệm
thu dùng **full default suite không lọc**, ghi số skip thật của lượt cuối. Lệnh:

```sh
pnpm typecheck
pnpm lint
env -u NO_COLOR -u FORCE_COLOR PATH="/tmp/cusr-phase6-node/bin:$PATH" CUSR_SEED=20261029 \
  pnpm test --outputFile.json=/tmp/t139-final-vitest.json
pnpm build
```

Các lượt trước sửa có test đỏ cho Q&A, stale packet, Q&A bị cắt, reviewer thiếu context bị tính lượt,
review recovery và result finalize trước boundary. Sau sửa, targeted tests và regression được chạy
lại; ledger lưu hash log trước/sau, source hashes và số liệu full suite cuối. Fixture vendor bổ sung
routing theo role để cùng binary/settings phục vụ worker và reviewer, và dùng đúng scratch path khi
chạy bwrap thật. Đó là binary giả phát lại T007, không phải model invocation mới.

## Phần vẫn giữ ngoài nghiệm thu T139

- T072 đã merge (PR #16 pin layout, PR #18 đối chiếu worktree) và đã hợp nhất vào nhánh này; còn chạy
  T078 với ít nhất 20 seeds mới trên mã đã hợp nhất.
- 7 stderr.log spike gốc vẫn thiếu; không dựng log thay thế. Hash audit cũ giữ nguyên và cần xử lý
  ở cổng A. Việc này không được biến fixture/protocol thành proof vendor thật.
- `session_resume` và hard USD cap của vendor thật vẫn unknown theo manifest T007; production
  không được nâng capability từ manifest test-only. Không gọi model hoặc tiêu usage mới ở lượt này.
- Doctor/CLI đầy đủ, daemon startup recovery và ≥200 crash B, rồi paid smoke C vẫn chưa nghiệm thu.
  Owner chưa chốt T080; không mở B hoặc tự merge PR.


# T078 — Nghiệm thu lại sau hợp nhất T072 và T139

Ngày 2026-10-30 (Asia/Ho_Chi_Minh), base `bc9d84a6eba1cbf1c41c48c30ea56c45e2fd7f3f`, nhánh `002/t078-gate`.
Có một sửa fixture adapter trong PR này; source hashes và diff digest ghi đúng mã đã kiểm.
`main` đã pull fast-forward; T072 layout pin (#16), worktree ownership (#18) và T139 (#17) đều
có trong base. **T078 đạt trong phạm vi core A. Kết luận kỹ thuật cổng A: NO-GO** do evidence lát 0
chưa đầy đủ; B/C giữ đóng. Tại lượt T078, quyết định owner T080 còn chờ; sau đó đã được chốt
ở [bản ghi T080](#t080--owner-chốt-no-go). Xem [review cập nhật](go-no-go.md).

## Baseline và host

[Ledger T078](evidence/t078-validation.json) ghi commit, hash toàn bộ `src`/`test`, config/lockfile,
command, seed, thời gian, kết quả từng file và hash log/report. [Host audit mới](evidence/t078-host.json)
ghi Ubuntu 24.04.5, Node 24.22.1, pnpm 12.15.0, bwrap 0.9.0, systemd 255, binary hashes và probes.
`systemctl --user is-system-running` trả `degraded` (exit 1); suite supervisor thật vẫn chạy đạt.

| Kiểm | Kết quả |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| Full `pnpm test`, CUSR_SEED=2026102921 | 106 file, 1468/1468 pass, 0 skip, exit 0 |
| `pnpm build` | exit 0 |
| 20 seeds mới 2026102921–2026102940 | 20/20 pass, 14,020 lượt test, 0 skip |
| bwrap/harness/systemd và same-vendor reviewer ro | Chạy thật trong baseline và từng seed, không skip |

Node được sao nguyên vẹn ra `/tmp/cusr-t078-node/bin/node`, SHA-256
`e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb` giống binary host; không mount host home.
Bỏ `NO_COLOR`/`FORCE_COLOR` kế thừa, giữ `CUSR_RUNS` unset để dùng trần property mặc định từng test.
Không gọi model trả phí, sửa host policy, chạy smoke C hoặc ≥200 crash B. GitHub trong tests là fake;
PR chứa báo cáo nghiệm thu là thao tác repository riêng.

## Ledger 20 seeds sau T139

Mỗi seed chạy **toàn bộ `test/integration/runtime` + `test/contract`**, các property runtime
evidence/limits/slot/required-subset, unit context/config/domain runtime/sandbox. Khác ledger chẩn
đoán trước T139, lượt này bao gồm `harness-invocation` (fresh packet/review recovery), T072 và ba
OS suites trong từng seed. `CUSR_SEED` đổi fast-check; `--sequence.shuffle --sequence.seed` đổi thứ
tự test Vitest. Scenario integration cố định được chạy lại, không coi là 20 workflow end-to-end
ngẫu nhiên độc lập. Ledger cũ giữ nguyên để bảo toàn lịch sử.

| Seed | Pass / total | Skip | Exit | Giây |
| --- | --- | --- | --- | --- |
| 2026102921 | 701/701 | 0 | 0 | 97.324 |
| 2026102922 | 701/701 | 0 | 0 | 87.177 |
| 2026102923 | 701/701 | 0 | 0 | 65.261 |
| 2026102924 | 701/701 | 0 | 0 | 66.063 |
| 2026102925 | 701/701 | 0 | 0 | 77.229 |
| 2026102926 | 701/701 | 0 | 0 | 77.832 |
| 2026102927 | 701/701 | 0 | 0 | 97.29 |
| 2026102928 | 701/701 | 0 | 0 | 76.917 |
| 2026102929 | 701/701 | 0 | 0 | 80.412 |
| 2026102930 | 701/701 | 0 | 0 | 71.029 |
| 2026102931 | 701/701 | 0 | 0 | 78.137 |
| 2026102932 | 701/701 | 0 | 0 | 91.006 |
| 2026102933 | 701/701 | 0 | 0 | 95.968 |
| 2026102934 | 701/701 | 0 | 0 | 78.653 |
| 2026102935 | 701/701 | 0 | 0 | 82.516 |
| 2026102936 | 701/701 | 0 | 0 | 70.776 |
| 2026102937 | 701/701 | 0 | 0 | 97.35 |
| 2026102938 | 701/701 | 0 | 0 | 95.727 |
| 2026102939 | 701/701 | 0 | 0 | 69.759 |
| 2026102940 | 701/701 | 0 | 0 | 66.677 |

Tái hiện một seed bằng filter nguyên văn trong ledger (sao cùng binary Node ra `/tmp` trước):

```sh
env -u NO_COLOR -u FORCE_COLOR PATH="/tmp/cusr-t078-node/bin:$PATH" CUSR_SEED=2026102921 \
  node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const { filters } = JSON.parse(readFileSync('specs/002-task-to-green-pr/evidence/t078-validation.json', 'utf8'));
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'default', ...filters,
  '--sequence.shuffle', `--sequence.seed=${process.env.CUSR_SEED}`], { stdio: 'inherit' });
process.exit(result.status ?? 1);
JS
```

## Assertions quyết định kết quả

| Nghĩa vụ | Bằng chứng chạy trong cả 20 seeds |
| --- | --- |
| US1, US1.7/9/11, một worktree/branch/PR | `feature-002-flow`, `confirm-start`, `scheduler`, `atomic-claims`: hai mode, dependency chỉ READY sau DONE; fixer dùng cùng worktree/branch/PR; một POST create PR, một PATCH mỗi nội dung mới, publish đúng checkpoint SHA; không merge request |
| US2 + T062 | `feature-002-fixes`, `gates`, `observation-limits`, `drain`: gate/review/CI sửa rồi kiểm lại, deadline/poll/run caps giữ nguyên; service recheck có quyền và dedup, drain xong mới DONE |
| US4, T072/T077 | `harness-invocation`, `feature-002-real-adapters`, `harness-bwrap`, `sandbox-bwrap`, `supervisor-systemd`, toàn bộ contracts: six-role fixtures, canary redact, reviewer ro, layout pin, dirty worktree chặn worker, recheck ghi thay đổi của người dùng, không downgrade boundary |
| M01/M02 | confirmation/admission forged/stale/direct; merge.method default/ba enum/invalid/key lạ, freeze/config đổi/replay và repo không squash không chặn admission |
| M03/M04 | same-vendor/model nhưng khác home/session, reviewer không resume; no-op reuse và input đổi buộc review; Q&A qua CI fixer, packet stale không launch, rebuild có trần; thiếu context trước launch không tính usage |
| M05/M06 | frozen template và content fixer; marker giả/nhân đôi title/body hai mode bị chặn; formatter đổi tree chạy lại toàn tập có trần; review/publish exact SHA; H01–H04 chặn cả hai thứ tự callback/drift và conditional push bare Git |
| M07/M08 | commit/push/PR lost reply được probe, body drift không ghi đè; finalized review đọc lại từ disk không launch/usage lần hai; green và manual merge proof theo mode, unknown method vẫn DONE khi proof/drain hợp lệ; zero merge requests |
| Projection/H05/H06 | `feature-002-gate` SQLite file thật close/reopen, dedup và replay giữ projection/drift, không cộng usage lại; base-tip-only không gọi fixer/review. Crash I/O rộng ở B, chưa nghiệm thu |

Đây là kiểm lại [matrix T139](#t139--kiểm-tổng-hợp-m01m08-và-h01h06) và T072 trên commit đã hợp nhất,
không suy từ tổng test count. Ledger ghi mọi file pass/failed/pending. Lượt baseline đầu **2 failed /
1.466 passed / 0 skip** được giữ ở [ledger ban đầu](evidence/t078-initial-validation.json): fixture
same-vendor bwrap còn pin layout pass-through nên runtime từ chối trước launch (`auth_config`).
Sửa fixture dùng `probeLayoutShapes` + `attemptLayoutInputs` trên đúng bwrap provider, cùng pattern
với `harness-bwrap.test.ts`; không nới layout check production. Suite adapter sau sửa đạt 5/5 trước
khi chạy lại gates và chuỗi 20 seeds ở trên. Log/report thô ở `/tmp/cusr-t078-evidence/` là artifact local, hash lưu trong
ledger; chúng không được coi là evidence spike vendor thật.

## Điều kiện A còn chặn go

Audit lại **271 tham chiếu: 264 file khớp hash, 7 thiếu, 0 lệch**. So audit 268 trước đây, thêm 3
file của manifest T009 recheck. Cả 7 vẫn là `stderr.log` harness spike; ledger mới liệt kê path và
expected digest. Đã tìm ở `/tmp`, `/home/khanhnd/projects`, `/home/khanhnd/.local/state`,
`/home/khanhnd/.local/share` và `/home/khanhnd/.cache`, chưa tìm được bytes gốc. Không tạo file thay thế hay nâng fixture replay thành proof production. Auth/rules/vendor
hiện hành chưa được chứng nhận lại; hashes lịch sử chỉ xác nhận archive.

Effort đo được của lượt này: 1772.414 giây tổng thời gian lệnh quality gates + 20 seeds (chạy
tuần tự, không phải giờ công phát triển). Không phát sinh model usage. Coverage vẫn đủ 117 mã;
T072/T078 đã đóng trong phạm vi A, các task B/C vẫn mở. Không có timesheet/usage toàn phase để
kết luận budget v1 còn đủ; phần ước lượng B/C giữ riêng trong go/no-go.

# T080 — Owner chốt NO-GO

Ghi nhận **2026-10-30 00:36:40 +07:00** (2026-10-29 17:36:40 UTC), sau PR #19 đã merge
ở `2105b74`. Chủ dự án chỉ đạo “thôi chốt t80 đi” sau khi được báo NO-GO, phần evidence thiếu
và phương án bổ sung/chạy lại. **Quyết định: NO-GO, giữ B/C đóng.**

Lý do: T078 đạt 20/20 seeds nhưng còn thiếu 7 stderr.log spike gốc; vendor/auth/rules hiện hành
chưa được chứng nhận lại. [Go/no-go](go-no-go.md#quyết-định-owner--t080) đã ghi người quyết định,
thời điểm và lý do; T080 hoàn tất. Phase 6 đã hoàn tất review/quyết định, chưa mở Phase 7.
Lượt này chỉ cập nhật tài liệu quyết định; không chạy proof model mới hoặc thay đổi kết quả T078.

# T093/T094 — Daemon bị giết trên runtime thật

Ngày: 2026-10-30. Nhánh `002/us3-recovery` (PR #21), base code `e44e55e` cộng thay đổi của lượt này.
Host chạy: WSL2 `6.18.54.1-microsoft-standard-WSL2`, Ubuntu 22.04.5, Node 24.22.1, git 2.34.1,
systemd 249 với user manager (`degraded`), 12 CPU, 7 GB RAM. Đây không phải host Ubuntu owner chọn
cho Phase 6; lượt trên host đó chưa chạy.

## Crash driver (T093)

`test/reliability/runtime-crash.test.ts` dùng `test/support/runtime-crash.ts` và tiến trình con
`test/support/runtime-crash-child.ts`. Mỗi lượt chạy bắt đầu từ một template (file SQLite thật,
project Git và bare remote thật, GitHub giả lưu ở file nên sống qua tiến trình, run directory thật).
Một “đời daemon” là một tiến trình riêng: `recoverStore` như cusrd (writer lock, schema, verify
projection, reconcile operation, ingest spool), rồi chạy chính handler/dispatcher của daemon. Mọi
request ra ngoài và mọi lần ghi store đi qua một điểm ngắt. Điểm được ghi vào ledger rồi tiến trình
tự `SIGKILL` khi gặp đúng `(key, occurrence)` đã chọn. Điểm chọn từ seed và ledger của một lượt chạy
mẫu không ngắt, nên `--seed` tái hiện đúng lần kill.

| Nhóm | Chạy thật | Điểm ngắt |
| --- | --- | --- |
| spawn_adoption | systemd user manager, `cusr-runner`, flock kernel, /proc | claim, trước/sau start unit, sau pid/exit receipt, trước/sau ghi `operation_result`/ingest |
| output_ack | spool xoay vòng do writer của runner ghi, ingest lô 4 record | trước/sau mỗi lô commit, trước/sau xóa từng segment (ACK); runner xong trước hoặc trong lúc daemon chết |
| commit_push | gates thật, checkpoint commit, push lên bare remote | claim, trước/sau `update-ref`/`push`/lệnh gate, trước/sau ghi receipt |
| pr_create | tạo hoặc nhận lại PR | trước/sau `POST pulls` và các probe đọc, trước/sau receipt |
| merge_drain | user đã merge; đọc CI, merge proof, drain, DONE, dependent | đọc PR/events, receipt, vòng drain, `TaskCompleted` |
| h05 | full-review: reviewer A đang chạy hoặc publish dở; drift B ghi khi daemon chết | quanh reviewer, push và receipt |

Một phần ba số lượt chạy giết thêm đời daemon đang phục hồi (kể cả lúc đang probe). Sau mỗi kill,
store được mở đúng như daemon chết để lại: `integrity_check`, `verifyProjections` dựng lại mọi bảng
projection từ nhật ký, và nhật ký đã commit phải còn nguyên là tiền tố của mọi đời sau. Đời cuối phải
tới đích của nhóm, với đúng một spawn, một commit, một push, một PR, một DONE. Drift và blocker của
H05 phải còn nguyên.

## Lỗi recovery driver tìm ra và đã sửa

Lượt đầu (4–8 kill mỗi nhóm) làm task kẹt vĩnh viễn ở các trường hợp sau, đều tái hiện lại được bằng seed:

1. **Receipt đã commit nhưng effect result chưa.** Dispatcher ghi `operation_result`, rồi các fact
   phụ, rồi `effect_result`, mỗi bước một transaction. Daemon chết giữa các bước này để lại
   operation `finished` và effect `started`. Startup không reconcile được vì operation đã resolved.
   Cửa sổ tương tự có giữa hai fact mà `commit` của reconcile ghi, và ở latch T092. Sửa:
   `settleOrphans` trong `src/daemon/reconcile.ts`. Effect `started` không có handler giữ và mọi
   operation đã `finished`/`not_launched`/`lost` sẽ thành `unknown`, rồi đi reconcile. Agent chưa
   từng spawn thì thành `not_executed`. Báo cáo startup có thêm trường `orphaned`.
2. **Reconcile tự bị giết.** Reconcile của một reconcile trả `still_unknown`, nên effect gốc kẹt.
   Sửa: handler trả `not_executed` cho target loại `reconcile`; engine đưa probe về hàng đợi cùng
   key, kể cả sau merge, khi có drift hoặc khi cancel. Lý do: reconcile chỉ probe và lặp lại việc đã
   khai báo an toàn.
3. **Effect về hàng đợi rồi lại mất.** `requestReconcile` khóa theo ID effect gốc. Probe đầu đã
   xong thì lần mất sau không có reconcile mới. Sửa (`src/engine/effects.ts`): probe còn mở thì dùng
   lại; mọi probe trước đã xong thì lấy key kế tiếp.
4. **Reconcile của `await_ci` bỏ mất fact merge.** Probe chỉ lấy outcome của `observeTask` mà bỏ
   `observation_result`/`external_completion`, nên task chờ CI mãi dù PR đã merge. Sửa: probe mang
   theo các fact đó.

Test hồi quy thêm ở suite mặc định: `feature-002-recovery.test.ts` (receipt không result, agent
`not_launched` mồ côi, reconcile bị ngắt chạy lại dưới drift, effect mất lần hai có reconcile mới),
`publish-recovery.test.ts` (reconcile của lần đọc CI bị mất ghi được merge, rồi DONE đúng một lần).

## Lượt T094

```sh
pnpm test:reliability --seed 20261028 --no-file-parallelism
```

`--no-file-parallelism` được dùng vì lượt đầu chạy song song trên host 7 GB bị thiếu RAM. Lượt đó
r4-sequences dùng 6 GB và timeout ở 30 phút, 4 lần R1 timeout 60 giây ở tiến trình con, nên được
giữ là failed. Lượt đó cũng lộ thêm lỗi 3 ở trên và một race trong driver: điểm `spawn:exit:after`
có thể bị bỏ qua khi pass reconcile đọc exit trước. Driver giờ chỉ chạy pass khi đã thấy exit hoặc
unit đã dừng. Kết quả lượt cuối, sau mọi sửa:

| Kiểm | Kết quả |
| --- | --- |
| `pnpm typecheck`, `pnpm lint` | exit 0 |
| `pnpm test` | 113 file / 1.546 pass, 4 skip (bwrap/real-adapter cần host, như trước) |
| `pnpm test:reliability --seed 20261028 --no-file-parallelism` | 3 file / 429 test pass, exit 0, 1.536 giây |
| `runtime-crash` | 227/227, 220 lượt chạy, **252 lần SIGKILL daemon** |
| `r1-crash` (R-08, store) | 201/201, 200 SIGKILL trong transaction |
| `r4-sequences` | 1/1 (10.000 chuỗi) |
| T081–T084 | `runner-adoption` (6, systemd thật), `publish-recovery` (15), `spool-recovery` (20), `feature-002-recovery` (17) pass trong `pnpm test` |

Ledger từng lượt (nhóm, variant, điểm kill, đời, số event, replay digest, counts) ở
[t094-runtime-crash.json](evidence/t094-runtime-crash.json), sha256
`32b6fd4ab68a0f19f689a89c719dc061ca3719a5aea1cf7d38dcb1ed71b747fb`. Log lượt chạy có sha256
`327885bb4b8a662a1d7dc4f96e62200283f0714f92c52bb4de93e24690cfe5b4` (không lưu vào repo).

| Nhóm | Lượt | Kill | Trước effect | Sau external | Trước ingest | Sau ingest | Điểm khác nhau |
| --- | --- | --- | --- | --- | --- | --- | --- |
| spawn_adoption | 40 | 44 | 13 | 10 | 10 | 11 | 12 |
| output_ack | 40 | 49 | 7 | 5 | 17 | 20 | 25 |
| commit_push | 40 | 44 | 10 | 11 | 10 | 10 | 20 |
| pr_create | 40 | 51 | 12 | 12 | 10 | 16 | 10 |
| merge_drain | 40 | 44 | 10 | 10 | 12 | 12 | 16 |
| h05 | 20 | 20 | 6 | 6 | 4 | 4 | 10 |

Kết quả theo yêu cầu SC-004/005/006:

- 100% store sau mỗi kill có `integrity_check = ok` và projection khớp nhật ký. Nhật ký đã commit
  không mất hay đổi ở đời sau.
- Không có attempt, commit, push hay PR nào bị lặp:
  - spawn_adoption: đúng 1 spawn và 1 run có launch marker mỗi lượt. Lượt bị giết trước khi launch
    có tới 2 operation `not_launched`, không lượt nào spawn lần hai. Output của runner được ingest
    đúng 20 record.
  - commit_push / pr_create: 1 commit, 1 push (reflog remote), 1 POST, 1 PR.
  - merge_drain: 1 `TaskCompleted`, dependent READY sau DONE.
  - output_ack: 40/40 record, cursor 40, chỉ còn segment cuối sau ACK.
  - h05: reviewer chạy ≤ 1 lần, push ≤ 1 lần, 0 PR, blocker `head_changed` và drift B giữ nguyên.
- Mọi operation đều được resolve ở đời cuối của các nhóm flow.

Không lấy crash của 001 hay PID giả thay bằng chứng runtime. Agent ở các nhóm flow là harness giả
trong tiến trình. Spawn agent thật được phủ ở spawn_adoption qua systemd. SC-005 với vendor thật
vẫn chờ C.

# T105 — US5 trả lời và hủy có kiểm soát

Ngày: 2026-10-30. Nhánh `claude/wonderful-hamilton-abwvdz` (PR #22), base `90b8beb` (Phase 7 đã merge)
cộng ba commit Phase 8 và chín lượt sửa sau review (`e63b165`, `df7c4c9`, `399a025`, `27be750`, `b4f12c5`, `07680aa`, `04ff0ba`, `4dc8cfb` và lượt thứ chín). Host chạy: container cloud Ubuntu 24.04.5, kernel `6.18.44-fc-v185`, Node v22.22.0
(`engines` yêu cầu 24.22.1), git 2.43.0, **chạy bằng root**, không có systemd user manager
(`systemctl --user` = `offline`). Không phải host owner chọn; không có tài khoản/model/GitHub thật.

## Lệnh

| Kiểm | Kết quả |
| --- | --- |
| `pnpm typecheck`, `pnpm lint` | exit 0 |
| `pnpm test` | 118 file: 107 pass, 8 skip, **3 fail**; 1.597 test pass, 40 skip, 3 fail; 119 giây |
| 3 test fail | `command-journal` (“no durable started record, no spawn”), `process-tag` (“a process of this user it cannot read…”), `sandbox` (“refuses a parent of the host home”). Cả ba cũng fail trên `main` `90b8beb` trong cùng container trước khi sửa gì (baseline: 4 fail, thêm một test `daemon-control` keep-alive nay đã pass nhờ client mở một kết nối mỗi request). Nguyên nhân: tiến trình chạy bằng root, HOME `/root`. Không phải lỗi của Phase 8; chưa chạy lại trên host thường. |
| `questions.test.ts` | 17/17 |
| `cancel-drain.test.ts` | 41/41 |
| property `runtime-cancel.test.ts` | 200 chuỗi ngẫu nhiên (đồng hồ tiến, đứng yên hoặc lùi), đạt cả CANCELLED lẫn DONE-trễ, cộng regression cùng millisecond |
| `feature-002-recovery.test.ts` | 24/24 (thêm runner resume bị mất, và crash sau từng fact của reconcile) |

## Matrix US5.1–7

| Kịch bản | Bằng chứng | Kết quả |
| --- | --- | --- |
| US5.1 needs_input kết thúc attempt, câu hỏi bền, inbox sau restart | `questions.test.ts`: attempt `finished`, không effect in-flight, slot `null`, WAITING `human_input/agent_question`; mở lại file SQLite và **restart daemon thật** qua UDS, `inbox` vẫn trả câu hỏi; token project khác không thấy, project không được đọc bị từ chối | Đạt (fake harness) |
| US5.2 câu trả lời đầu thắng, replay, cạnh tranh, sai revision | Cùng file, qua daemon thật: một request gửi **2, 3 và 5 lần** (tuần tự và đồng thời) → một `QuestionAnswered`, mọi lần sau `replayed: true` cùng kết quả, không thêm attempt; 5 request khác ID đua nhau → đúng 1 thắng, 4 `conflict` (exit 6); competing ở version hiện tại → `conflict already_answered`, chỉ ghi `AnswerRejected`; stale version → conflict trước khi ghi; câu hỏi bị revision mới rút → `conflict question_not_open`; token project khác exit 5/4, token read exit 5, câu hỏi không có exit 4 | Đạt |
| US5.3 hủy khi attempt chạy và effect chưa dispatch | `cancel-drain.test.ts`: effect chưa dispatch bị `invalidated`, attempt `not_started`, slot trả, CANCELLED ngay. Runner đã adopt (không còn handler) là **process group thật** (`sh` + 2 `sleep`): `stop_attempt` dừng qua `ProcessPort` (TERM rồi KILL), `/proc` xác nhận cả 3 PID đã chết; slot và claim giữ tới receipt của operation và kết quả attempt, rồi mới CANCELLED; không effect nghiệp vụ mới. `prepare` đang chạy một cây process thật có tag operation: cancel yêu cầu stop, process bị giết theo tag và `/proc` xác nhận đã hết, CANCELLED sau receipt và kết quả của setup. Gate đang chạy lúc hủy (flow Git thật): lệnh đang chạy nhận SIGTERM và trap cleanup chạy, `unit`/`lint` không được spawn, không checkpoint, stop chỉ xong sau khi handler gate trả về. Dừng theo tag: SIGTERM, chờ grace, rồi SIGKILL và xác minh; process bỏ qua TERM bị KILL sau grace. Executor gate: con bỏ qua TERM và không giữ pipe vẫn bị KILL sau grace, lệnh chỉ kết thúc khi cả process group đã hết; không spawn sau abort. `prepare` không chạy lệnh git nào sau abort. Handler bị abort không trả về trong thời hạn (hoặc không chờ được) → stop là `unknown`, task không CANCELLED. Reconcile sau cancel/merge không chạy lại setup/gate: chỉ ghi `failed` (`stopped`) khi process theo tag được thấy đã hết, không thì giữ `unknown`; zero lệnh git/gate. Leader bỏ qua TERM bị KILL sau grace (lịch KILL đặt ngay lúc abort). Cancel ghi trong lúc reconcile đang chạy lại gate: guard đọc lại task trước mỗi lệnh và mỗi 200 ms, lệnh đang chạy nhận TERM, không gate nào khác, không commit. Dừng không xác minh được nhóm process (fault injection) giữ `unknown`, không thành `failed`; khi đó chính effect và operation của lượt reconcile cũng giữ `unknown`, nên task không CANCELLED/DONE trước khi process của lượt đó được đối chiếu. Shutdown giữa lúc reconcile chạy lại gate: abort của dispatcher tới guard, guard ngừng đọc store, đóng SQLite không gây exception. Process mark chỉ bị xóa khi operation đã giải quyết; operation `unknown` giữ mark. Mọi reconcile, kể cả reconcile của một reconcile, kiểm và dừng theo tag các operation local `unknown` của effect đích trước khi probe hay đóng: chưa thấy hết thì `still_unknown`, slot và cancel giữ nguyên. Đường đối chiếu không đứt: khi operation của một effect `unknown` đổi trạng thái (recovery ghi `lost`, receipt tới) mà không còn probe mở, engine tạo probe mới. Regression đi hết chuỗi bằng SQLite, dispatcher, handler và `reconcileOperations` thật: `unknown` → probe không xác minh được (kẹt, không effect pending, slot giữ) → process chết → recovery ghi `lost` → probe mới → CANCELLED, slot được trả; và cùng chuỗi khi `lost` được ghi **trong lúc** probe đang kiểm process: một probe kế tiếp được xếp, chỉ claim sau khi probe đang chạy kết thúc (`probe_running`, không hai probe của cùng effect chạy song song), rồi kết thúc CANCELLED. Probe kế tiếp cũng bị chặn khi probe trước còn `unknown` (có thể còn gate chạy lại đang sống); probe của chính probe đó đối chiếu nó trước. Probe của việc giữ slot (setup/agent/gate/publish, và probe của probe ấy) tự giữ slot (FR-044.01). Regression: xếp R2 → R1 thành `unknown` với process gate chạy lại còn sống → R2 vẫn bị chặn, slot giữ → recovery dừng process của R1 theo tag → CANCELLED, slot trả; tắt riêng từng phần bản sửa thì test tương ứng fail | Đạt; systemd thật không có trên host này (supervisor thật đã kiểm ở T081) |
| US5.4 hủy khi publish chưa rõ, PR đã tạo | Store: `create_pr` unknown → cancel không CANCELLED, reconcile thấy PR → `pr_ref` được ghi, chờ `cancel_reconcile`. Git thật + FakeGitHub: cancel ở PR xanh đọc PR một lượt rồi CANCELLED; chỉ có request `GET`, PR vẫn `open`, branch remote và HEAD worktree vẫn ở SHA checkpoint | Đạt |
| US5.5 hạn mức, auth, refusal | Rate limit: lượt gọi được tính, slot trả, timer hữu hạn (≥ `reset_at`, ≤ trần backoff), retry giữ nấc; hết `max_attempts` → `policy/backoff_exhausted`. `auth_config`/`refused`: chờ người, không retry kể cả sau 1 giờ, không `RungRaised`/`ApprovalRequested`. Outcome unknown giữ claim và slot, chờ reconcile | Đạt (engine 001 đã có; test khóa lại trên task runtime) |
| US5.6 hủy khi PR đã merge | Merge trước khi cancel kết thúc → DONE với merge commit, `CancelRecordedLate`, không `TaskCancelled`, zero merge request. Drain đã cạn lượt rồi mới cancel → recheck drain (service T062) chạy đúng 1 vòng, kết quả cuối → DONE đúng 1 lần. GitHub không đọc được → giữ `cancel_reconcile`, recheck sau đó → CANCELLED. Merge thấy sau CANCELLED chỉ là lịch sử. Lần đọc được gắn với cancel bằng `read_token` cấp trong cùng accept: observation ghi trước cancel cùng millisecond, hoặc vòng tự động sau đó, không kết thúc được cancel. Một lần đọc bất kỳ thấy `merged` (kể cả thiếu proof, kể cả ngay trước cancel) được giữ lại vĩnh viễn trong cancel: lần đọc open/closed đến sau, kể cả câu trả lời muộn của chính lần đọc mang token, không kết thúc được cancel; blocker `merge_evidence_incomplete` cũng giữ cancel chờ; proof đến sau vẫn kết thúc DONE. Property (có bước merged thiếu proof): CANCELLED chỉ khi lần đọc mang token cho open/closed và được ghi **sau** `CancelRequested` theo seq, không merge proof, không effect in-flight | Đạt |
| US5.7 needs_context/blocked, session cũ không dùng được | needs_context/blocked chờ người với phần thiếu (`reported`), không retry/escalate tự động, không gọi role khác; answer chạy đúng 1 attempt `retry` mang Q&A qua slot/ngân sách; hết `max_agent_runs` → chờ policy, không attempt. Resume đúng session đã hỏi; resume hỏng không có session riêng → attempt sau `session_unusable`, vẫn mang Q&A, mỗi lần gọi đều tính lượt (3 attempt cho 3 lần gọi). Runner resume chết thật thiếu `exit.json`: recovery ghi `lost`, reconcile handler thật ghi lượt thất bại (`infra`/`agent_lost`, tính lượt, đóng operation), retry sau backoff mở session mới mang Q&A; engine đóng run `lost` trong cùng accept với lượt thất bại, test crash sau từng fact vẫn tới đúng kết quả; projection khớp nhật ký | Đạt với fake session port |

Approval escalation (T103, FR-010/FR-028), qua daemon thật: token assistant `[read, operate]` và token
read bị từ chối (exit 5), sai rung exit 4, `merge_approve`/`yolo` exit 2 và không tạo approval; owner duyệt
đúng request mở của step/rung/revision hiện hành, replay cùng request trả kết quả cũ, request khác cho
cùng rung là conflict; chỉ có approval loại escalation.

Inbox: task đã CANCELLED/DONE không còn câu hỏi trong inbox, kể cả khi hỏi theo `task_id`.

## Thay đổi hành vi cần biết

- Task runtime có PR không còn CANCELLED ngay khi hủy: phải có một lần đọc PR **sau** thời điểm hủy cho
  open/closed (FR-025.03). Test cũ `external-completion.test.ts` (“a cancelled task is not reopened…”)
  kỳ vọng CANCELLED ngay đã được sửa theo FR-025.03. Task 001 không runtime giữ hành vi cũ.
- Cancel dừng cả `prepare`/`run_gates` đang chạy (process theo tag operation). Push, tạo PR và rerun
  đã gửi được để chạy hết trong giới hạn riêng: dừng giữa chừng chỉ làm kết quả bên ngoài thành unknown.
- Reconcile của attempt agent mà mọi run đều `lost` giờ là lượt thất bại `infra` (`agent_lost`) thay vì
  `still_unknown` mãi.
- needs_context/blocked của worker đã gọi trên task runtime không còn đi theo route `retry`/`escalate`
  của workflow mà chờ người (FR-039). Task 001 giữ route cũ.
- Tiếp tục sau answer ở bước `code` giờ resume session của attempt đã hỏi nếu harness đã chứng minh
  resume (trước đây luôn session mới).

## Chưa đạt / ngoài phạm vi lượt này

- Proof resume Claude **thật** (điều kiện T077: lưu phiên, chuyển transcript sang home mới, sửa
  `contracts/execution.md`) chưa làm; mọi resume ở đây là fake session port. Thuộc C.
- `productionControl` chưa truyền `observe`/`ProcessPort`/effect handlers vào daemon production; command
  `task_cancel` ở production ghi intent và chờ recheck đọc PR. Nối route production thuộc T109/T110.
- CLI `cusr inbox/answer/task cancel/task approve` chưa có (T109); test đi thẳng qua UDS `/v1/command`.
- Không chạy được trên host có systemd user manager: nhóm `spawn_adoption` của crash driver bị skip ở
  đây (xem dưới).

## Reliability sau Phase 8

```sh
pnpm test:reliability --seed 20261028 --no-file-parallelism
```

Chạy trên `b4f12c5` (code cuối của PR), cùng container: exit 0, 1.544 giây.

| File | Kết quả |
| --- | --- |
| `runtime-crash` | 185 pass, **42 skip**: nhóm `spawn_adoption` cần systemd user manager, host này `offline`. `output_ack`, `commit_push`, `pr_create`, `merge_drain` (40 lượt mỗi nhóm) và `h05` (20) đều pass |
| `r1-crash` (R-08, store) | 201/201 |
| `r4-sequences` | 1/1 |

Lượt trên chạy trước lượt sửa thứ sáu. Sau lượt sửa thứ sáu, crash driver dùng process mark và dừng theo
tag như daemon production; chạy lại đầy đủ trên `07680aa`: exit 0, 1.649 giây, `runtime-crash` 185 pass/42
skip (`spawn_adoption`), `r1-crash` 201/201, `r4-sequences` 1/1. Sau lượt sửa thứ bảy, chạy lại trên
`04ff0ba`: exit 0, 1.618 giây, cùng kết quả (185 pass/42 skip, 201/201, 1/1). Code cuối sau lượt sửa
thứ chín (`22b856c`): exit 0, 1.614 giây, cùng kết quả.

Lượt này không ghi lại ledger `evidence/t094-runtime-crash.json` và không đếm lại số SIGKILL; bằng chứng
≥ 200 kill của T094 (có `spawn_adoption` trên systemd thật) vẫn là lượt T094. Kiểm lại trên host có
systemd sau Phase 8 thuộc T120.

# T120 — US6 xem và điều khiển qua CLI

Ngày: 2026-10-31. Nhánh `002/phase9-cli`, base `7b6b841`; các lệnh chạy trên code cuối của nhánh, riêng reliability chạy trên bản trước hai lượt sửa doctor/explain (xem dòng reliability). Host: Linux `7.0.0-38-generic`,
Node v24.22.1, user thường (uid 1000), `systemctl --user` = `degraded` nhưng user manager chạy được, bwrap có.
Fake harness/GitHub; không tài khoản/model/GitHub thật, không publish PR.

## Lệnh

| Kiểm | Kết quả |
| --- | --- |
| `pnpm typecheck`, `pnpm lint` | exit 0 |
| `pnpm test` | 121 file: 120 pass, 1 skip; 1.793 test pass, 4 skip, 0 fail. Một lần chạy khác fail 1 test flake có sẵn, xem dòng dưới |
| Flake `cancel-drain.test.ts` (“recovery records it lost after the probe runs”) | Chạy nguyên file 20 lần: `origin/main` fail 5/20, nhánh này fail 3/20. Chạy riêng test đó: 0/15 ở cả hai. Có từ trước PR, chưa sửa |
| 4 test skip | `harness-bwrap` (2) và `feature-002-real-adapters` (2): các test này tự skip trên host này; chưa kiểm lại ở lượt này |
| `pnpm test:reliability --seed 20261030 --no-file-parallelism` | exit 0, 429/429, 1.549 giây, trên bản trước hai lượt sửa doctor/explain. Từ bản đó tới code cuối, trong `src` chỉ `doctor.ts`, `cli/tasks.ts` và `explain/allowed-actions.ts` đổi (crash driver không dùng), nên không chạy lại. Commit của lần chạy đã được gộp khi viết lại lịch sử nhánh |
| `dist/cli/cusrd.js` + `dist/cli/cusr.js` thật | status exit 0; doctor exit 1 chỉ vì thiếu `manifest:claude`, `manifest:codex` (`host`, `systemd_unit`, `sandbox_canary` đạt); add/list/explain/logs exit 0; retry, `approve --kind merge`, yolo exit 2; stale version và không có gì để recheck exit 6; daemon đã dừng exit 3 |

Crash ledger (`reports/runtime-crash-20261030.json`, không commit): **259 daemon kills**: `spawn_adoption` 43, `output_ack` 49, `commit_push` 44, `pr_create` 54, `merge_drain` 49, `h05` 20.
`spawn_adoption` chạy thật với systemd user manager, không skip như ở T105. Sau integration T094 (≥ 200 kills,
replay projection) vẫn đạt. `r1-crash` 201/201.

## Matrix US6.1–7

| Kịch bản | Bằng chứng | Kết quả |
| --- | --- | --- |
| US6.1 show/explain không LLM: bước, lý do, PR/head, lượt, bằng chứng, chờ slot tách riêng, prerequisite chưa chứng nhận, merge_cleanup | `feature-002-cli.test.ts` khối explain: chờ lần đầu 90 giây không tính deadline; prerequisite `merged_head_unverified` còn hiện sau restart; drain tạm dừng hiện effect chưa rõ, status khác DONE. Query chỉ đọc projection và event log | Đạt (fake) |
| US6.2 một kết quả có version, mã lỗi ổn định; log nối lại | Mọi lệnh finite trong test đi qua kiểm “đúng một dòng envelope `schema_version: 1`”; logs: chỉ record đã commit, đã redact; nối lại từ cursor không lặp; rotation + ACK + restart giữ đủ 30 record; `--follow` JSONL có seq/cursor | Đạt |
| US6.3 read/tự khai owner bị từ chối | `access-control.test.ts`: token read exit 5 mọi mutation; assistant tự khai `actor`/`roles`/`authz` khi approve vẫn exit 5, zero event; revoke qua restart thì exit 5, lịch sử giữ actor cũ | Đạt |
| US6.4 merge approval/yolo | CLI và raw command: `unsupported_feature`, exit 2, hướng dẫn merge trên GitHub, zero event, không ledger row | Đạt |
| US6.5 task retry/amend-policy | Như trên, hướng dẫn `task add` | Đạt |
| US6.6 recheck | Khối recheck: một lần đọc, replay không đọc lại; deadline/budget/`next_due_at`/generation giữ nguyên; expired không bật poll, merge sau đó qua drain tới DONE, không effect merge; drain một lượt không đọc PR; terminal không đọc, không effect; PENDING đọc config một lần rồi READY, không effect; read exit 5, stale exit 6 | Đạt với PR read/drain fake qua `ObservationCoordinator` thật |
| US6.7 lối ra từng detail | `test/unit/explain/allowed-actions.test.ts`: mọi `DETAIL_CODES` có lối ra và không nhắc amend/yolo/gia hạn; từng dòng FR-029 đúng thứ tự thao tác; không có PR thì chỉ cancel và task add; recheck không hiện khi service sẽ từ chối; lệnh approve explain in ra chạy được với owner, exit 5 với assistant | Đạt |

## Matrix exit, authz, recheck

| Exit | Trường hợp đã kiểm |
| --- | --- |
| 0 | Query task CANCELLED vẫn exit 0: status task không quyết định exit |
| 1 | doctor fail (`unhealthy`); health lỗi (test sẵn có ở `daemon-control.test.ts`) |
| 2 | Thiếu đối số, cờ lạ (`--actor`), đối số thừa, file không đọc được, request ID sai, thiếu `--expected-version`, query body thừa khóa, body > 1 MiB, unsupported, token file thiếu |
| 3 | Daemon dừng, tiến trình `cusr` thật; thư mục data không đổi; mutation mất trả lời vẫn in request ID; `--follow` in cursor để nối lại |
| 4 | Task/câu hỏi/approval không có; task project khác khi đọc |
| 5 | Vai trò thiếu, project khác khi lệnh nêu đúng project đó, token không biết/đã thu hồi |
| 6 | Stale version, payload khác cùng request ID, không có gì để recheck |

| Target recheck | Hành vi đã kiểm |
| --- | --- |
| `config` | Đọc cấu hình mới qua triage |
| `observation` | Một lần đọc, giữ lịch, sau expired giữ `observation_expired` |
| `drain` | Một lượt dừng/đối chiếu sau khi drain đã dừng |
| `worktree` | Service T062/T072 (`feature-002-fixes`), chưa có test riêng qua CLI |
| `terminal` | Không đọc, không effect, không mở lại |

## Đối chiếu US1.1–11

US1.1–7 và US1.9 giữ bằng chứng ở các mục trên, các suite đó chạy lại trong `pnpm test` ở trên. Phần đã hoãn sang
đây: US1.8 recheck PENDING qua CLI; US1.10 explain prerequisite; US1.11 explain chờ slot: đều Đạt (fake) theo
matrix US6. Tất cả là fake harness/GitHub; smoke thật thuộc C.

## Thay đổi hành vi cần biết

- CLI tối thiểu T048 đổi tên: `cusr add/show/confirm/propose` thành `cusr task …`, `--task ID` thành đối số,
  `--task-version` thành `--expected-version`. Test `task-cli.test.ts` đã đổi theo.
- Authz chạy trước schema. Token read gửi body có `actor` nay exit 5 thay vì 2, theo hợp đồng; test cũ trong
  `daemon-control.test.ts` kỳ vọng exit 2 đã đổi.
- Segment sau ACK chuyển sang `acked/` thay vì bị xóa, vì DB chỉ giữ số lượng và digest. Disk của run chỉ giảm khi
  retention dọn. Kill point ACK của crash driver chuyển từ `unlink` sang `rename`; lần chạy đầu fail đúng vì lý do này.
- Đọc task theo ID ở project khác trả exit 4, không phải 5 như câu chữ T107, để không lộ ID; giữ hành vi đã có từ T048.

## Sửa sau review

- **Doctor mất chẩn đoán khi systemd treo:** probe unit được 15 giây, bằng timeout của client, nên CLI exit 3 và mất
  báo cáo. Nay mọi probe host dùng chung ngân sách 30 giây, client chờ 45 giây; hết ngân sách thì probe sau báo
  `timeout` mà không chạy. Test treo thật hơn 15 giây: exit 1 kèm cách sửa; đổi client về 15 giây thì test thấy exit 3.
  Ngân sách không bao gồm phần đọc store (`verifyProjections`) chạy đồng bộ; store rất lớn vẫn có thể vượt 45 giây.
- **Explain bảo chờ khi task không thể xếp hàng:** READY chưa có lựa chọn được xác nhận nay hiện propose/confirm.
  Lệnh confirm kèm `--run-config DIGEST`; test chạy đúng lệnh explain in ra và task vào hàng chờ. Task đã start gặp
  `run_config_unconfirmed` chỉ còn cancel và task add, vì engine từ chối propose và confirm sau start.

## Chưa đạt / ngoài phạm vi

- **`cusrd` production chưa chạy được task tới PR:** chưa nối effect handler/harness/sandbox và chưa ghi manifest,
  nên task dừng ở `capability_missing`. Không có task nào trong Phase 9 phủ việc này; đã thêm T140, chặn T121–T130.
- Observe/drain của recheck và scheduler trong production đã nối nhưng chưa chạy với GitHub thật hay task có PR thật.
- Doctor chưa đối chiếu settings, environment và host policy của manifest vì cần pin của vendor; preflight và
  từng attempt làm việc này. Sandbox canary dùng một lệnh bwrap riêng, không phải layout đầy đủ của role.
- Unit `cusrd.service` mới qua `systemd-analyze --user verify`, chưa cài và chưa chạy thử trên host.
- GitGuardian incident 39322897 là false positive: chuỗi canary tự viết trong test. Đã thay bằng giá trị sinh lúc
  chạy và gộp commit để chuỗi không còn trong lịch sử nhánh; incident cũ trên dashboard vẫn cần owner đóng nếu còn mở.
- `--follow` hỏi lại theo chu kỳ, không phải stream từ daemon; mất kết nối thì thoát 3, người gọi tự nối lại.
- Điều kiện T077 (proof resume Claude thật) và các thiếu sót go-no-go vẫn như cũ.

## T121–T125 — suite smoke và chạy thử local

**Đây không phải bằng chứng SC.** Mọi kết quả dưới đây dùng vendor replay T007 và GitHub giả; không gọi model, không
ghi lên GitHub. SC-001/002/005/008/012 vẫn **chưa kiểm** tới khi T126–T130 chạy thật.

`pnpm test:smoke`: 32 pass, 10 skip (kịch bản thật, cần `CUSR_SMOKE_REAL`), 1 todo (T126). Chạy thử đi qua CLI thật,
preflight thật, unit systemd, bwrap, Git và gate thật; đây là lần đầu luồng `task add` → DONE đi qua preflight trên
wiring production (#25 seed task ở bước start).

| Task | Suite | Kiểm local | Còn lại |
| --- | --- | --- | --- |
| T121 | `task-to-green-pr.test.ts` | Fixture validate, required checks khớp job CI, không có secret; hai chiều vendor full-review tới PR xanh rồi DONE; đọc rule source trả "không có protection", ghi duy nhất là tạo PR | Hai repo sandbox; T127 |
| T122 | `harness-roles.test.ts` | Sáu cặp role × vendor qua task thật; reviewer ghi worktree bị chặn; vendor in private home mọi lượt, canary không có trong data dir | Invocation thật và evidence `attested`: T126 |
| T123 | `runner-restart.test.ts` | SIGKILL/SIGTERM × hai vendor khi unit agent còn active: cùng attempt, unit, InvocationID và process qua lần dừng; attempt kết thúc `done` sau lần dừng, một lượt budget, không gọi thay thế | T128 |
| T124 | `gates.test.ts` | Lệnh gate đúng pass/fail ở Node/Python; gate đỏ không có checkpoint, fixer sửa, gate xanh rồi mới publish | T129 |
| T125 | `manual-merge.test.ts` | Chờ khi chưa merge; DONE một lần qua restart; source push/delete sau merge giữ head đã kiểm; T008 merge/squash/rebase qua proof production; không có request merge | T130 |

GitHub giả không phân biệt kiểu merge; ba kiểu chỉ được kiểm qua record T008. Driver thật (`test/support/smoke-real.ts`)
mới chạy `cusrd`/`cusr` đã build tới `doctor`, chưa từng chạy một task thật.

### Lỗi phát hiện: dừng daemon êm đốt mất attempt

`Dispatcher.stop` abort mọi handler bằng cùng tín hiệu với hủy việc, nên `RunnerHarness` dừng luôn unit của agent. Sau
`systemctl stop`/restart, attempt cũ tính hết một lượt budget và attempt thay thế được gọi, trái `contracts/execution.md`
§3 và SC-005; với agent thật là tốn tiền và làm lại việc. SIGKILL không bị, và `runner-adoption.test.ts` không bắt được
vì child của nó không đi qua harness. Nay `stop` abort với lý do `DaemonStopping`: harness để nguyên unit và auth, effect
giữ `started`, daemon sau nhận lại. Hủy việc vẫn dừng unit như cũ. Test: `dispatch.test.ts`, `harness-invocation.test.ts`,
và `runner-restart.test.ts` (bỏ bản sửa thì hai ca SIGTERM fail: unit đã `not_found` ngay sau khi dừng, và riêng phần
đọc log cũng fail vì attempt cũ không kết thúc `done`).

### T126 — chứng minh harness trên host hiện tại

Chạy `cusr-runner prove-harness` ngày 2026-10-31 trên host Linux không phải WSL2, với outer proof chạy lại tại
`test/fixtures/runtime/spike-0/host-linux-20261031/` (chỉ năm probe local, không phải toàn bộ cổng T006). Host này khác host
WSL2 mà owner chốt là host triển khai v1 ngày 2026-10-28; bằng chứng dưới đây chỉ có giá trị cho host này.

| Vendor | Binary | Kết quả | Lượt gọi |
| --- | --- | --- | --- |
| Codex | 0.165.0, cùng sha với T007 | Đạt: ba role có kết quả hợp lệ, lệnh probe bị từ chối, tool chạy trong PID namespace con, auth đã gỡ, `record-manifest` nhận | 9, trần tăng dần 3→6→9 |
| Claude | 2.1.316, khác T007 (2.1.306) | Đạt: như Codex, usage có cost | 9: 3 lượt dừng trước model (0 turn, $0), 3 lượt reviewer `invalid_output`, 3 lượt đạt; trần 3→6→9 |

Pin sau cùng có thêm `node`, nên hai vendor được chứng minh lại, tổng 12 lượt mỗi vendor trong ledger. Host không có `socat` mà inner sandbox Claude bắt buộc; phiên làm việc không có sudo nên `socat` 1.8.0.0 của Ubuntu được giải nén
vào thư mục riêng và khai trong `toolchain` của pin. Cài bằng gói hệ thống thì đổi pin, phải chứng minh lại.

Hai vòng Codex đầu chưa đạt vì fixer trả `blocked` mà không gọi tool nào; argv của fixer giống coder trừ đường dẫn attempt.
Vòng ba nói rõ model có shell tool và phải dùng thì đạt, nên đây nhiều khả năng là hành vi model ở effort thấp, chưa được
chứng minh. Công cụ giữ `permission_denial_kept` ở `unknown` trong cả hai vòng đó. `session_resume` và `cost_limit` vẫn `unknown`.

Vòng reviewer `invalid_output` của Claude là do prompt yêu cầu approve khi lệnh ghi bị từ chối: model từ chối báo vậy và trả
một finding có đường dẫn không tương đối, validator từ chối đúng. Sửa prompt, không sửa validator.

SC-008 đạt trên host này cho hai vendor, ba role, model và effort đã ghi. Chưa nói gì về host WSL2. `socat` là điều kiện cài
đặt của inner sandbox Claude mà `cusr doctor` chưa báo.

### T127–T129 — chạy thật trên sandbox

Host Linux hiện tại, effort low, `claude-haiku-5-5` và `gpt-6-luna`. Ledger:
`test/fixtures/runtime/spike-0/harness/proof-20261031/smoke-ledger.jsonl`.

| Task | Node (Claude coder, Codex reviewer) | Python (Codex coder, Claude reviewer) |
| --- | --- | --- |
| T127 | Đạt: PR#1 | Đạt: PR#1 |
| T128 SIGKILL | **Chưa đạt**: coder `agent_blocked` | Đạt: PR#3, cùng attempt, 5/5 process còn sau khi dừng |
| T128 SIGTERM | Đạt: PR#2, cùng attempt, 6/6 process | Đạt: PR#4, cùng attempt, 5/5 process |
| T129 gate xanh | **Chưa đạt**: coder `agent_blocked` | Đạt: PR#2 |

Đường gate đỏ thật của T129 chưa chạy. Các PR đều xanh `build`/`test`, `REVIEW_REQUIRED`, chưa merge, không có request merge từ hệ thống.

### Lỗi phát hiện ở lượt thật

- `src/daemon/handlers.ts:845` gán cứng `prompt: null`: prompt role đã đóng băng không tới agent ở lượt nào. Hai lượt Claude coder
  chạy `git commit`, gặp `.git` read-only rồi báo `blocked`, trong khi `coder.md` ghi "Do not commit". Chưa kiểm rằng sửa dòng này
  hết `blocked`.
- Sandbox agent chỉ có `toolchain` của pin: Node qua nvm không có trong sandbox, coder báo `blocked` sau khi đã tốn lượt. Lượt thật
  dùng bản `node` chép vào thư mục riêng trong pin. Không có khai báo toolchain theo project hay kiểm trước khi chạy.
- `cusr doctor` không báo thiếu `socat`, điều kiện của inner sandbox Claude.
- Nhiều binding trong một role: chỉ binding đầu được dùng, nên đổi chiều vendor phải sửa config dù `--worker`/`--reviewer` đã chọn.

### Điều kiện trước T126–T130

- Hai repo sandbox Node/Python đã có, nội dung từ `repo/` của fixture, required checks `build`/`test`, review bắt buộc. Repo
  spike `cuesura-spike-002-sandbox` không có protection nên chỉ phủ trường hợp no-protection.
- Budget: owner duyệt ngày 2026-10-31, trần ghi trong ledger từng lượt.
- Công cụ sinh evidence có `attested`: `cusr-runner prove-harness`, đã chạy thật với hai vendor.
- Outer proof T006 thuộc host WSL2 (`/home/khanhnd1`), không mô tả host Linux hiện tại, nên phải chạy lại probe trên host này
  thay vì dùng lại hash trong fixture T007.
- Bindings là toàn cục trong một config, nên mỗi chiều vendor cần config và data dir riêng (`CUSR_SMOKE_REAL` đã tách).
