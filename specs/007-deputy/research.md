# Research: Deputy

Đối chiếu mã nền tại `origin/main` `36fed98`. Mỗi mục ghi quyết định, lý do và phương án đã loại.

## R-01 — Deputy là một component của daemon, theo khuôn của decider

**Quyết định:** thay `src/daemon/decider.ts` bằng `src/daemon/deputy.ts` cùng khuôn: một vòng `round()` của daemon tìm
sự cố cần deputy, ghi bản ghi lượt trước khi spawn, gọi `HarnessPort.run` qua `RunnerHarness`, và kết thúc lượt bằng
một trigger. Khác decider ở ba chỗ: lượt không giữ reservation ngân sách (FR-025); bản ghi lượt nằm trong bảng SQLite
do daemon ghi, không trong file JSON (R-05); kết quả lượt không phải câu trả lời có cấu trúc mà là "đã hết lượt" kèm tin
nhắn cuối (R-03).

**Lý do:** decider đã giải các bài khó của một agent do daemon gọi: chạy qua runner (systemd, terminal backend, private
home), nhận lại lượt sau restart (`adopt`), không spawn hai lần (`started`, `recover`), và báo cho attention biết nó còn
giữ câu hỏi (`holds`/`version`). Viết lại từ đầu sẽ mất những bảo đảm đó.

**Đã loại:** đưa deputy vào engine như một step của workflow. Vi phạm nguyên tắc I (LLM quyết trạng thái) và buộc mọi
workflow biết về deputy.

## R-02 — Định tuyến: bảng trên `DetailCode`

**Quyết định:** thêm `src/engine/deputy-routing.ts` với `DEPUTY_ROUTE: Record<DetailCode, 'deputy' | 'owner' |
'worker_question' | 'auto'>`, kiểu `Record` nên thiếu mã thì không biên dịch được (như `NEEDS_USER` ở
`src/explain/needs-user.ts`). `auto` là các mã task tự chạy tiếp, trùng đúng các mã `NEEDS_USER = false`; property test
giữ hai bảng khớp nhau. Hàm thuần `routeOf(state, autonomous, now)` trả nơi đến của sự cố hiện tại, `null` cho `auto`,
trừ `effect_unknown` đã quá ngưỡng (`effectUnknownOverdue`) thì trả `deputy`. `effect_failed` đọc thêm
`detail.failure`. `needs_draft` là mã PENDING mới duy nhất tới deputy.

**Lý do:** FR-001; hai người hiện thực không vẽ ranh giới khác nhau, mã mới buộc phải được xếp loại.

**Đã loại:** danh sách loại trừ trong code của daemon. Mã mới sẽ mặc định đi đâu đó mà không ai quyết.

## R-03 — Phiên native: lượt tương tác, hook hết lượt, dự phòng không tương tác

**Quyết định:**

- Adapter harness thêm `interactiveArgv(input)` cạnh argv headless hiện có. Claude: `claude --resume <session> [--model …]
  "<prompt>"` không có `-p`; Codex: `codex resume <session> "<prompt>"`. Harness không có argv tương tác (pi, fake) chỉ
  chạy không tương tác.
- Runner chọn chế độ: có terminal backend và harness có argv tương tác thì chạy tương tác dưới `systemd-run --pty` trong
  cửa sổ của backend (đường đã có ở `src/runner/terminal-host.ts`); không thì headless như decider.
- Hết lượt: Cuesura thêm một hook Stop (Claude) hoặc `notify` (Codex) vào settings của private home, gộp với hook của
  chủ dự án. Hook ghi `turn-ended.json` vào run dir của attempt, kèm tin nhắn cuối lấy từ input của hook (đường dẫn
  transcript hoặc trường tin nhắn cuối). Runner theo dõi file này như đang theo dõi file kết quả, rồi dừng process sau
  `term_grace_ms` và trả `HarnessOutcome` loại mới `turn_ended { final_message }`.
- Stall: không có `turn-ended.json` và không có hoạt động của phiên trong `stall_ms` thì runner dừng process; deputy
  chạy lại cùng `session_ref` ở chế độ headless cho cùng sự cố.

**Lý do:** chủ dự án chọn native (Clarifications). Hook ghi file trong run dir giữ mọi thứ trong hợp đồng runner hiện
có (run dir, finalize, recover) và không cần lệnh daemon mới. Dừng process sau lượt bỏ được vòng đời "phiên đỗ nhiều
ngày" (FR-015).

**Đã loại:** để phiên đỗ chờ như trợ lý (`cusr assistant wait`). Một process sống mỗi task, và phải phân biệt Stop do
chủ dự án gõ với Stop hết lượt. Headless mọi lượt: chủ dự án đã chọn native.

**Cần spike trước lát B:** trường tin nhắn cuối trong input hook Stop của Claude và `notify` của Codex trên phiên bản
đang pin; resume tương tác với prompt đầu tiên trên cả hai.

## R-04 — Sự cố, chuyển cho người và không làm đổi version

**Quyết định:** sự cố là khóa `task:revision:code:enteredSeq`, cùng định dạng khóa attention đang dùng
(`src/application/attention.ts`). Khi lượt kết thúc, daemon đọc wait hiện tại: còn đúng khóa đó thì ghi `handed_off` vào
bản ghi lượt. `needsUser` cho attention và inbox coi sự cố "tới deputy" là không cần người, trừ khi bản ghi lượt của nó
là `handed_off`. Thay cho `Decider.holds`, attention hỏi `Deputy.holds(s)`.

**Lý do:** FR-020–FR-022. Mọi event làm tăng `version` (`src/engine/evolve.ts`) và lệnh đòi khớp version
(`src/store/accept.ts`); ghi bản ghi lượt thành event của task sẽ làm lệnh của chủ dự án bị từ chối, đảo ngược US5.

**Đã loại:** "chuyển cho người khi lượt không ghi gì". Lệnh bị từ chối, `recheck` không đổi wait, hay lệnh trên task khác
đều làm task kẹt mà không ai xem.

## R-05 — Lưu bản ghi phiên và lượt

**Quyết định:** migration `008_deputy.sql` thêm `deputy_sessions` và `deputy_turns` (data-model). Daemon là bên duy nhất
ghi (nguyên tắc II). Ghi bản ghi lượt trước khi spawn, cập nhật kết quả sau khi lượt kết thúc, trong transaction riêng
không đụng `events`. `decisions.md` và `report` đọc bảng này cùng event.

**Lý do:** bền qua restart, truy vấn được cho chi tiết task (FR-023), join với lệnh qua `turn_id`. File JSON như decider
không truy vấn được và phải quét thư mục.

**Đã loại:** JSON trong `recordsDir`. Chỉ hợp cho một bản ghi mỗi câu hỏi; deputy cần lịch sử lượt theo task.

## R-06 — Danh tính `deputy` và CLI trong phiên

**Quyết định:**

- Runner đặt `CUSR_DEPUTY_TURN=<turn_id>` cho process deputy thay vì `CUSR_ATTEMPT_ID` (`src/runner/process-tag.ts`).
  Biến này không bị `sandbox.ts` xóa như các `CUSR_*` khác.
- `refuseWorker` cho qua khi có `CUSR_DEPUTY_TURN`; khi đó `assistant hook|session-start|register|wait` thoát 0.
- `readClientActor` trả `deputy` khi có biến này, bỏ qua `CUSR_ACTOR`; client gửi thêm header `x-cusr-turn`.
- `CALLER_ACTORS` thêm `deputy` với `read`, `operate`. Daemon kiểm `x-cusr-turn` là lượt đang mở của actor `deputy`, từ
  chối nếu không.
- `RequesterKind` thêm `deputy`; `needsConfirmation` đã đúng vì mọi requester khác `human` đều cần xác nhận.

**Lý do:** FR-050–FR-052, FR-056. Không có dấu hiệu riêng thì skill `cusr` trong private home đặt
`CUSR_ACTOR=assistant` và deputy bị ghi nhầm actor.

## R-07 — Lý do và ID lượt trên mọi lệnh ghi

**Quyết định:** `CommandSchema` thêm `reason: string | null` và `turn_id: uuid | null` ở cấp lệnh (không trong payload).
`admitCommand` bắt buộc `reason` khi actor là `deputy`, lấy `turn_id` từ header đã kiểm, và đưa cả hai vào
`command_hash`. `command_ledger` thêm cột `reason`, `turn_id`. `AuthzContext` mang thêm `reason` và `turn_id` để event
của lệnh lưu chúng. CLI thêm `--reason` cho mọi lệnh ghi; các lệnh đang có `--reason` (`cancel`, `pause`) dùng lại giá trị
đó.

**Lý do:** FR-055, FR-056 và SC-007 với một thay đổi ở một chỗ.

**Đã loại:** thêm `reason` vào từng payload. Tám schema phải sửa, và lệnh tương lai dễ quên.

## R-08 — Mốc và trả về worktree theo cơ chế reviewer

**Quyết định:** trước khi spawn một lượt, daemon ghi `deputy-baseline-<turn_id>.json` vào scratch của task bằng
`WorktreeBaselineSchema` (HEAD và cây checkpoint), như `reviewBaselineFile`. Sau lượt, và khi nhận lại lượt sau restart,
daemon gọi `restoreWorktree` (`src/adapters/git/restore.ts`). Task chưa có worktree (`needs_draft`, PENDING) thì bỏ qua.
Settings của phiên deputy cấm `Edit`/`Write` trên `<data dir>/worktrees/**` khi harness hỗ trợ luật theo đường dẫn.

**Lý do:** chủ dự án chọn cơ chế đã có. Không đòi cài thêm công cụ; chạy với mọi harness; trả về cả commit và file mới.

**Đã loại (đã thử trên Ubuntu 24.04, systemd 255):** `ReadOnlyPaths=` của unit user bị bỏ qua mà không báo lỗi vì
`kernel.apparmor_restrict_unprivileged_userns=1`; bubblewrap chạy được nhưng phải cài; sandbox của Claude trên Linux cũng
dựa vào bubblewrap; Landlock chỉ có danh sách cho phép, không biểu diễn được "ghi mọi nơi trừ worktree".

## R-09 — Mở lại giới hạn

**Quyết định:**

- `continue` nhận thêm `agent_runs_exhausted`, `deadline`, `backoff_exhausted`, `ci_wait_exhausted`
  (`src/engine/continue.ts`). Với `backoff_exhausted`: reset bộ đếm lỗi của lớp đó ở step. Với `ci_wait_exhausted`: mở
  cửa sổ chờ CI mới độ dài đã đóng băng.
- `amend-policy` có thêm `--agent-runs +N` và `--deadline <ISO|+duration>`; `--model` trở thành tùy chọn khi có một trong
  hai. Áp dụng ghi `PolicyAmended` như hiện nay, kèm actor và lý do. `agent_runs_insufficient` chỉ gỡ bằng
  `--agent-runs`.
- `task_amend_policy` hạ `REQUIRED_ROLE` xuống `operate`.

**Lý do:** FR-030–FR-033; không có các lệnh này, deputy chỉ còn cách cancel.

## R-10 — Task nháp

**Quyết định:** `task_add` nhận `draft: true`; triage cho task nháp vào PENDING `needs_draft` thay vì chạy preflight.
Lệnh mới `task_revise` (`operate`) với payload `{ title?, description?, acceptance? }`, chỉ nhận trước khi policy đóng
băng, phát `TaskRevised` như `source_updated` (`src/engine/intake.ts`), rồi đưa task qua triage như `task confirm` đang làm
(không xác nhận). `admitCommand` từ chối `task_confirm` khi actor là `deputy`.

**Lý do:** FR-040–FR-044; tái dùng đường sửa task trước khi đóng băng đã có.

## R-11 — Wait cạn trần khi không có deputy

**Quyết định:** engine vào wait `ladder_exhausted`/`rung_denied` thay vì gọi `failWithDraft` (R-15). Ở vòng của deputy,
daemon thấy wait cạn trần mà user config không có role `deputy` thì gửi trigger `task_fail` nội bộ với actor
`system:deputy-absent` (FR-036). `Deputy.holds` giữ wait này cho tới khi trigger được nhận, để attention không báo cho
người. Có role `deputy` thì không bao giờ tự kết thúc, kể cả khi deputy không khởi động được (FR-004).

**Lý do:** binding là cấu hình sống, không nằm trong snapshot đóng băng; để engine rẽ nhánh theo nó sẽ phá I01.

## R-12 — Lỗi của lượt deputy

**Quyết định:** ánh xạ `HarnessFailure` của lượt theo FR-024: `rate_limited`/`overloaded` thì timer tới `reset_at` (account
pool chọn tài khoản như worker); `auth`, `refused`, `capability_missing`, thiếu harness thì `handed_off` ngay; còn lại retry
theo `limits.backoff.infra` đã đóng băng của task, đếm trong bản ghi lượt, không trong task. Trần tùy chọn
`roles.deputy.limits.infra_retries`. Wall time tùy chọn `roles.deputy.limits.wall_ms`, mặc định không có.

## R-13 — Nâng cấp từ decider

**Quyết định:** lần khởi động đầu, daemon đọc `recordsDir` của decider; mỗi bản ghi còn lại được kết thúc bằng
`decider_ran { apply: false, failure: 'superseded', invoked }` (`invoked` lấy từ `harness.started`). Sau đó xóa thư mục.
`decider_start` từ chối mọi yêu cầu mới; `decider_ran` chỉ nhận cho attempt đã có reservation. `evolve` giữ nhánh
`DeciderRan` để replay. Config: role `decider` được đọc như `deputy` kèm cảnh báo.

## R-14 — Mục quyết định trong mô tả PR

**Quyết định:** hàm dựng thân PR (`src/adapters/github/publish.ts`) nhận danh sách quyết định của deputy ảnh hưởng nội dung
(câu trả lời cho câu hỏi về spec, `amend-policy`, `continue`) và thêm một mục cố định trước marker block. Mục là một
phần của thân mà publish gửi, nên probe so khớp toàn thân vẫn đúng. Không thêm effect sửa PR riêng.

## R-15 — Hết thang trở lại thành wait, `task fail` là lệnh kết thúc

**Bối cảnh:** #247 (PR #252, đã merge) cho engine gọi thẳng `failWithDraft` khi hết thang (`ladder_exhausted`) hay gặp nấc
bị từ chối (`rung_denied`), nên hai sự cố này không còn là wait. `context_budget` và `run_config_unconfirmed` ở cấp step
cũng kết thúc như vậy. Chưa có lệnh nào gọi `failWithDraft`.

**Quyết định:**

- `chooseRung` (`src/engine/escalation.ts`) vào lại wait `ladder_exhausted`/`rung_denied` qua `waitPolicy`, không gọi
  `failWithDraft`. Engine vẫn không biết có deputy hay không (I01); daemon quyết theo R-11.
- `context_budget` và `run_config_unconfirmed` ở cấp step giữ nguyên hành vi của #247: deputy không xác nhận được run
  config và không đổi được context bắt buộc.
- Thêm lệnh `operate` `task fail <id> --reason` (`task_fail`) gọi `failWithDraft` trên task WAITING (FR-036). Deputy dùng
  nó để kết thúc có lý do; daemon dùng nó với actor `system:deputy-absent`.
- `intake.auto_confirm` (#248) không áp dụng cho task nháp và task có requester kind `deputy`; config liệt kê `deputy`
  trong `intake.auto_confirm` thì validate báo lỗi (FR-043, FR-052).

**Lý do:** deputy phải thấy sự cố hết thang mới quyết được bù lượt hay đổi model (US2). Với người không khai deputy, kết
quả giống #247 hiện nay, chỉ trễ tối đa một vòng scheduler.

**Đã loại:** giữ engine tự FAILED. Deputy không bao giờ gỡ được hết thang, trái mục tiêu của US2. Cho engine đọc binding
deputy để rẽ nhánh: phá I01, vì binding là cấu hình sống, không nằm trong snapshot đóng băng.
