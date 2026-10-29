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
