# Research: Deputy và goal

Đối chiếu mã nền tại `origin/main` `62eadbd`. Mỗi mục ghi quyết định, lý do và phương án đã loại. Các mục R-01–R-15 kế
thừa bản 2026-11-08, đã sửa theo thiết kế lượt ngắn; R-10 (task nháp) bị thay bằng goal (R-21). R-16 trở đi là mới.

## R-01 — Deputy là một component của daemon, theo khuôn của decider

**Quyết định:** thay `src/daemon/decider.ts` bằng `src/daemon/deputy.ts` cùng khuôn: một vòng `round()` tìm sự cố và goal
cần deputy, ghi bản ghi lượt trước khi spawn, chạy qua `RunnerHarness` (systemd, terminal backend, private home), nhận
lại lượt sau restart. Khác decider: lượt không giữ reservation ngân sách; bản ghi lượt nằm trong bảng SQLite; kết quả lượt
là bàn giao và các lệnh `cusr`, không phải một câu trả lời có cấu trúc.

**Lý do:** decider đã giải các bài khó của một agent do daemon gọi (chạy qua runner, `adopt` sau restart, không spawn hai
lần, `holds`/`version` cho attention).

**Đã loại:** đưa deputy vào engine như một step của workflow (vi phạm nguyên tắc I).

## R-02 — Định tuyến: bảng trên `DetailCode`

**Quyết định:** `src/engine/deputy-routing.ts` với `DEPUTY_ROUTE: Record<DetailCode, 'deputy' | 'owner' |
'worker_question' | 'auto'>`; thiếu mã thì không biên dịch được. `auto` trùng đúng các mã `NEEDS_USER = false`; property
test giữ hai bảng khớp. Hàm thuần `routeOf(state, autonomous, now)` trả `deputy`, `owner` hay `null`; `effect_unknown` quá
ngưỡng (`effectUnknownOverdue`) trả `deputy`; `effect_failed` đọc `detail.failure`. Mã mới `plan_amendment` tới owner.
`needs_draft` của bản trước bị bỏ.

**Lý do:** FR-001; mã mới buộc phải được xếp loại.

## R-03 — Lượt native, hook hết lượt, dự phòng headless

**Quyết định:**

- Adapter harness thêm `interactiveArgv(input)`: Claude `claude [--resume <session>] [--model …] "<prompt>"` không có
  `-p`; Codex `codex [resume <session>] "<prompt>"`. Harness không có argv tương tác (pi, fake) chạy headless.
- Lượt đầu mở phiên mới (không `--resume`); chạy lại trong cùng lượt (FR-011) resume `session_ref` của lượt.
- Runner chạy tương tác dưới `systemd-run --pty` trong terminal backend khi có (`src/runner/terminal-host.ts`), không thì
  headless.
- Hết lượt: Cuesura thêm hook Stop (Claude) hoặc `notify` (Codex) vào settings của private home, gộp với hook của chủ dự
  án; hook ghi `turn-ended.json` vào run dir. Runner thấy file thì dừng process sau `term_grace_ms`, trả outcome
  `turn_ended { final_message, session_ref }`.
- Stall: không có `turn-ended.json` và không hoạt động trong `stall_ms` thì dừng và resume cùng phiên ở headless.

**Lý do:** chủ dự án chọn native. Hook ghi file giữ mọi thứ trong hợp đồng runner hiện có.

**Cần spike trước lát G:** trường tin nhắn cuối trong input hook của Claude và Codex trên phiên bản đang pin; mở phiên
tương tác mới và resume tương tác có prompt đầu tiên.

## R-04 — Sự cố, chuyển cho người và không làm đổi version

**Quyết định:** sự cố là khóa `task:revision:code:enteredSeq`, cùng định dạng khóa attention (`src/application/attention.ts`).
Lượt kết thúc mà wait hiện tại còn đúng khóa đó thì ghi `handed_off`. `needsUser` coi sự cố tới deputy là không cần người
trừ khi lượt của nó `handed_off`. Attention hỏi `Deputy.holds(s)` thay `Decider.holds`.

**Lý do:** mọi event làm tăng `version` (`src/engine/evolve.ts`) và lệnh đòi khớp version (`src/store/accept.ts`); ghi bản
ghi lượt thành event sẽ làm lệnh của chủ dự án bị từ chối.

**Đã loại:** "chuyển cho người khi lượt không ghi gì": lệnh bị từ chối hay lệnh trên task khác làm task kẹt mà không ai xem.

## R-05 — Lưu bản ghi lượt

**Quyết định:** migration `NNN_deputy.sql` thêm `deputy_turns` (data-model). Không có bảng phiên: mỗi lượt mang
`session_ref` của chính nó. Daemon là bên duy nhất ghi; ghi trước khi spawn; cập nhật trong transaction riêng, không đụng
`events`.

**Lý do:** bền qua restart, truy vấn được theo task và goal, join với lệnh qua `turn_id`.

## R-06 — Danh tính `deputy` và CLI trong phiên

**Quyết định:**

- Runner đặt `CUSR_DEPUTY_TURN=<turn_id>` thay `CUSR_ATTEMPT_ID` (`src/runner/process-tag.ts`); `sandbox.ts` không xóa biến
  này.
- `refuseWorker` cho qua khi có biến này; khi đó `assistant hook|session-start|register|wait` thoát 0.
- `readClientActor` trả `deputy` khi có biến này, bỏ qua `CUSR_ACTOR`; client gửi header `x-cusr-turn`.
- `CALLER_ACTORS` thêm `deputy` với `read`, `operate`.

## R-07 — Lý do, ID lượt, giả thuyết và tiêu chí trên lệnh ghi

**Quyết định:** `CommandSchema` thêm ở cấp lệnh `reason: string | null`, và `trial: { hypothesis, expect } | null` cho lệnh
gia hạn của deputy. `turn_id` lấy từ header đã kiểm, không từ body. `admitCommand` bắt buộc `reason` với actor `deputy`, và
`trial` với lệnh gia hạn của deputy (FR-042). Cả ba vào `command_hash`, `command_ledger` (cột mới) và `AuthzContext` để
event lưu chúng. CLI thêm `--reason` cho mọi lệnh ghi, `--hypothesis` và `--expect` cho lệnh gia hạn.

Thứ tự trong daemon: nhận diện replay theo `request_id`, actor và `command_hash` trên `command_ledger` chạy **trước** các
kiểm tra phụ thuộc trạng thái hiện tại (lượt còn chạy, lease, loop guard). Hiện nay replay chỉ được nhận ra sau
`admitCommand` (`src/daemon/main.ts`); lát A dời bước tra ledger lên trước các guard mới, nên lệnh đã thành công gửi lại
sau mất kết quả, kể cả sau khi lượt đã đóng, nhận kết quả cũ (FR-055).

**Đã loại:** thêm trường vào từng payload (tám schema, lệnh tương lai dễ quên).

## R-08 — Mốc và trả về worktree theo cơ chế reviewer

**Quyết định:** trước lượt có worktree, daemon ghi `deputy-baseline-<turn_id>.json` (HEAD và cây checkpoint) bằng
`WorktreeBaselineSchema`, như `reviewBaselineFile`; sau lượt và khi nhận lại lượt sau restart thì `restoreWorktree`
(`src/adapters/git/restore.ts`). Settings của phiên cấm `Edit`/`Write` trên `<data dir>/worktrees/**` khi harness hỗ trợ.

Lệnh thành công hiện kích dispatcher ngay (`src/daemon/main.ts`), nên một `continue` hay câu trả lời của deputy có thể cho
worker chạy và commit trước khi lượt kết thúc, rồi bị restore xóa. Vì vậy dispatcher bỏ qua mọi effect ghi worktree của
task đang có lượt `running`/`retry_wait` hay đang chờ restore; điều kiện đọc từ `deputy_turns`, nên còn sau restart. Restore
xong thì lượt sang trạng thái cuối và dispatcher chạy lại cho task đó (FR-017).

**Đã loại (đã thử trên Ubuntu 24.04):** `ReadOnlyPaths=` của unit user bị bỏ qua; bubblewrap phải cài; Landlock không
biểu diễn được "ghi mọi nơi trừ worktree".

## R-09 — Mở lại giới hạn

**Quyết định:** `continue` nhận thêm `agent_runs_exhausted`, `deadline`, `backoff_exhausted`, `ci_wait_exhausted`
(`src/engine/continue.ts`); `amend-policy` có `--agent-runs +N`, `--deadline`; `--model` tùy chọn khi có một trong hai;
`task_amend_policy` hạ xuống `operate`.

## R-11 — Wait cạn trần khi không có deputy

**Quyết định:** daemon thấy wait cạn trần mà không có role `deputy` thì gửi `task_fail` nội bộ với actor
`system:deputy-absent`. `Deputy.holds` giữ wait này tới khi trigger được nhận.

**Lý do:** binding là cấu hình sống, không trong snapshot đóng băng; để engine rẽ nhánh theo nó phá I01.

## R-12 — Lỗi của lượt deputy

**Quyết định:** `rate_limited`/`overloaded` thì timer tới `reset_at`; `auth`, `refused`, `capability_missing`, thiếu harness
thì `handed_off` ngay; còn lại retry trong cùng lượt theo `limits.backoff.infra` của task, đếm trong bản ghi lượt. Trần
tùy chọn `roles.deputy.limits.infra_retries`; wall time tùy chọn `wall_ms`.

## R-13 — Nâng cấp từ decider

**Quyết định:** lần khởi động đầu, mỗi bản ghi decider còn lại được kết thúc bằng `decider_ran { apply: false, failure:
'superseded', invoked }`, rồi xóa thư mục. `evolve` giữ nhánh `DeciderRan` để replay. Role `decider` đọc như `deputy` kèm
cảnh báo.

## R-14 — Mục quyết định và bản miễn trong mô tả PR

**Quyết định:** hàm dựng thân PR (`src/adapters/github/publish.ts`) nhận danh sách quyết định của deputy ảnh hưởng nội dung
và bản miễn, thêm một mục cố định trước marker block. Mục là một phần của thân mà publish gửi, nên probe so khớp toàn thân
vẫn đúng. Task tổng thêm danh sách đơn vị và merge commit (R-24).

## R-15 — Hết thang trở lại thành wait, `task fail` là lệnh kết thúc

**Quyết định:** `chooseRung` (`src/engine/escalation.ts`) vào lại wait `ladder_exhausted`/`rung_denied` thay vì gọi
`failWithDraft` (#247). `context_budget` và `run_config_unconfirmed` ở cấp step giữ hành vi của #247. Lệnh `operate`
`task fail <id> --reason` gọi `failWithDraft` trên task WAITING. Daemon dùng nó với actor `system:deputy-absent` (R-11) và
`system:loop-guard` (R-19).

## R-16 — Lượt ngắn thay cho phiên deputy theo task

**Bối cảnh:** bản 2026-11-08 cho mỗi task một phiên sống tới khi task kết thúc. Sáu phương án đã được so:

| Phương án | Vì sao loại hoặc đổi |
| --- | --- |
| Một phiên sống lâu mỗi task (bản đầu) | Context lớn dần theo mỗi sự cố; resume sau khi prompt cache hết hạn đọc lại cả transcript; không thấy task khác; chỉ phiên đó đọc được trí nhớ |
| Một phiên mỗi ngày | Task xếp hàng sau một phiên; context trộn nhiều task; ranh giới ngày tùy tiện |
| Phiên trợ lý của chủ dự án kiêm deputy | Ý định của người lẫn với quyết định của agent; quyền mờ; chết theo terminal; chat làm nhiễu trí nhớ |
| Một deputy sống lâu cho mỗi nhóm task | Vẫn lớn dần; sự cố trong nhóm xếp hàng |
| Một deputy cộng proxy nén context | Chỉ giải kích thước; thêm dependency và một proxy không xác thực trên đường credentials |
| **Lượt ngắn cộng sổ goal** | **Chọn** |

**Quyết định:** mỗi sự cố một phiên harness mới (FR-010); trong cùng lượt thì resume (FR-011). Context do code dựng (R-17).

**Lý do:** context không lớn theo thời gian; phần đầu ổn định của context dùng chung prompt cache giữa các lượt trong cùng
goal; mọi lượt và mọi phiên trợ lý đọc cùng một sổ. Lượt mới tốn thêm vài lệnh đọc đầu lượt, đổi lại không bị neo vào
giả định sai của transcript dài.

**Đã loại thêm:** "phiên mới luôn tốt hơn resume". Trong một lượt, resume giữ được điều tra đang dở (chờ rate limit, lỗi
hạ tầng), nên vẫn resume.

## R-17 — Sổ goal là view; context theo vùng

**Quyết định:**

- `src/application/goal-ledger.ts` dựng sổ từ event của goal và task, `command_ledger` (reason, turn_id, trial) và
  `deputy_turns` (bàn giao). Không có bảng sổ.
- `src/application/deputy-context.ts` dựng context theo năm vùng của FR-061. Vùng 1 là văn bản cố định của role; vùng 2
  chỉ đổi khi yêu cầu, chỉ thị hay kế hoạch đổi; trạng thái đơn vị (đổi ở mọi transition) nằm ở vùng 4 để không làm hỏng
  prompt cache của vùng 2.
- Ngân sách tính bằng byte của văn bản (UTF-8), cấu hình `roles.deputy.limits.context_bytes`, mặc định 16 KiB cho vùng 2–5
  (khoảng 4k token). Mỗi vùng 3–5 có phần ngân sách cố định; mục cũ nhất được gộp thành dòng đếm ("12 sự kiện cũ hơn của
  đơn vị B"). Vùng 2 không bị cắt; nếu riêng vùng 2 vượt ngân sách thì vẫn đưa đủ và ghi cảnh báo vào bản ghi lượt.

**Lý do:** FR-060–FR-064. Byte đo được bằng code, không phụ thuộc tokenizer của vendor. Thứ tự ổn định trước, biến động sau
để trúng prompt cache.

**Đã loại:** cắt theo kiểu giữ mới bỏ cũ trên một dòng thời gian chung (mất quyết định kiến trúc ở đầu goal); trần cứng
4k token cho cả lượt (quyết định phức tạp cần đọc thêm; deputy tự đọc qua `cusr`).

## R-18 — Chữ ký lỗi, khóa finding và tín hiệu vòng lặp

**Quyết định:**

- **Khóa finding:** schema output của reviewer thêm `key` cho mỗi finding. Reviewer nhận các finding còn mở của vòng trước
  kèm khóa, và phải giữ đúng khóa cho vấn đề vẫn còn, khóa mới cho vấn đề mới. Khóa thiếu hay sai định dạng thì code gán
  khóa từ `file` cộng hash của `msg` đã chuẩn hóa.
- **Chữ ký lỗi** (`src/engine/failure-signature.ts`, thuần): SHA-256 của mã wait, step và bằng chứng chuẩn hóa: với gate,
  tên gate và các dòng lỗi đã qua bộ lọc log của repo, bỏ số dòng, đường dẫn tạm và thời gian; với CI, tập tên check lỗi;
  với review, tập khóa finding chặn còn mở.
- **Tín hiệu vòng lặp** (`src/engine/loop-signals.ts`, thuần) theo FR-040: `finding_repeat`, `fix_misses_files` (diff của
  fixer không chạm file mà finding nêu), `tree_revisit` (cây checkpoint trùng một cây trước trong cùng revision),
  `signature_repeat` (cùng chữ ký qua ít nhất hai attempt với cây khác nhau), `cross_model_repeat` (cùng chữ ký qua hai
  model), `unreachable_cause` (mã wait thuộc nhóm worker không gỡ được, ví dụ xung đột base khi bước hiện tại không được
  sửa), `environment`.

**Lý do:** tín hiệu tính được mà không cần model, nên rẻ và tái hiện được. Khóa finding do reviewer giữ là cách duy nhất
nhận ra "cùng vấn đề, lời khác"; dự phòng theo file vẫn bắt được trường hợp reviewer không giữ khóa.

**Đã loại:** so lời văn finding bằng model (tốn token, không tất định).

## R-19 — Ba luật chống lặp và bảng thử

**Quyết định:**

- **Bảng thử** (`src/engine/trials.ts`, thuần): dựng từ lệnh gia hạn của deputy (command ledger có `trial`) và chuỗi sự cố
  của task. Mỗi dòng: chữ ký lỗi lúc lệnh được nhận, loại hành động (`extend`, `model`, `instruct`, `waive`,
  `approve_rung`), tham số chuẩn hóa, giả thuyết, tiêu chí, và kết quả đo ở sự cố kế tiếp: `signature_changed`,
  `errors_delta` (số dòng lỗi gate, số check lỗi hay số finding chặn), `tree_changed`.
- **Kiểm ở `admitCommand`** qua hàm thuần `loopGuard(state, trials, goalFacts, command)` cho actor `deputy`:
  1. trùng loại và tham số trên cùng chữ ký mà chưa có bằng chứng mới (FR-043.1) → `repeat_without_evidence`;
  2. loại đã cạn (FR-043.2) → `action_exhausted`;
  3. chữ ký đã cạn mọi loại (FR-043.3) → chỉ nhận `task fail` hay `handover`, còn lại `signature_exhausted`.

  Bằng chứng mới gồm: dòng thử gần nhất có `tree_changed` và (`signature_changed` hoặc `errors_delta < 0`); một chỉ thị
  của chủ dự án sau lệnh trước; một version kế hoạch do chủ dự án xác nhận sau lệnh trước mà `affectedUnits` có đơn vị
  này. Sửa kế hoạch do deputy tự áp không tính, vì deputy tạo được nó tùy ý.
- Bảng thử khóa theo `(goal_id, unit_key, signature)`, dựng từ mọi task từng giữ khóa đơn vị đó, nên thay task không đặt
  lại luật chống lặp.
- **Loop guard sau lượt** (FR-044): daemon tính lại `loopGuard` cho sự cố còn mở; chữ ký đã cạn mà lượt không kết thúc task
  thì gửi `task_fail` với actor `system:loop-guard`.
- Cận trên của SC-009 trên một chữ ký khi không có bằng chứng mới: số model trong `allow_models` cộng một `instruct`
  cộng một `extend` cộng số finding, gate và check có thể miễn trên chữ ký đó. Chỉ dẫn khác lời không mở thêm lượt.
  Thay đơn vị đã cạn là sửa phạm vi (FR-075), nên chuỗi qua nhiều task cũng hữu hạn nếu người không thêm bằng chứng.

**Lý do:** chủ dự án không muốn trần tổng, nhưng muốn deputy phá vòng lặp. Luật đặt ở `admitCommand` nên áp cho mọi lượt,
không phụ thuộc trí nhớ của deputy; đó là cơ chế chống trường hợp chính deputy lặp quyết định sai.

**Đã loại:** trần cố định "hai lần can thiệp mỗi loại sự cố" (Gemini): trái yêu cầu, và không phân biệt task đang tiến
với task đứng yên.

## R-20 — Bản miễn

**Quyết định:**

- Lệnh `task_waive` (`operate`, payload `{ target: { kind: 'finding' | 'gate' | 'check', key }, evidence }`) phát event
  `Waived` với chữ ký lỗi hiện tại, bằng chứng (văn bản hay tham chiếu artifact đã che secret), actor, lý do, ID lượt.
- Chữ ký để nhận ra vòng lặp (R-18) và phạm vi của bản miễn là hai thứ khác nhau. Bản miễn finding khớp theo khóa và chữ
  ký review; bản miễn gate khớp theo chữ ký gate, vốn gồm các dòng lỗi đã lọc; bản miễn check CI khớp theo head SHA, tên
  check và nguồn (app identity) của đúng lần chạy, vì tên check một mình không phân biệt được lỗi flaky với regression.
- Engine dùng bản miễn ở ba chỗ, đều thuần: verdict review `request_changes` mà mọi finding chặn có bản miễn khớp thì
  route `approve` và ghi `ReviewWaived`; gate bắt buộc lỗi có bản miễn khớp thì route `pass` kèm cờ `waived`; check CI lỗi
  có bản miễn khớp thì không làm `ciVerdict` thành `fail`.
- Guard merge của yolo (`currentChecksProblem` trong `src/daemon/yolo.ts`) hiện kiểm check theo trạng thái pass trước khi gọi
  `ciVerdict`. Lát C tách một hàm đánh giá check chung, có xét bản miễn và vẫn kiểm tên, nguồn, app identity, cho cả engine
  và yolo.
- `Waived` ghi khi task đã có PR sinh effect `github.update_pr_body` (idempotent, probe so toàn thân như publish). Bước
  merge chờ tới khi thân PR đã được đối chiếu có bản miễn (FR-046).
- Required check của PR vào protected branch không bao giờ được miễn: `ciVerdict` bỏ qua bản miễn khi `base_branch` khớp
  `protected_branches`.

**Lý do:** chủ dự án chọn miễn được cả gate. Gắn chữ ký làm bản miễn không che lỗi mới.

## R-21 — Goal là aggregate thứ hai trong cùng event log

**Quyết định:** goal có stream event riêng trong bảng `events` hiện có, `task_id` (tên cột cũ) mang id của goal, thêm cột
`stream TEXT NOT NULL DEFAULT 'task'` để mọi chỗ quét `events` lọc được. Projection mới `goals` (data-model). Lệnh goal đi
qua đúng đường `accept` (dedup, request ID, expected version là version của goal) và `command_ledger`. Task mang
`goal: { id, unit_key, role: 'unit' | 'final' } | null` trong input đã đóng băng; bảng chỉ mục `goal_tasks`.

**Lý do:** dùng lại idempotency, version, single writer và crash recovery của nguyên tắc II thay vì viết lại. Sổ goal
không phải nguồn sự thật thứ hai.

**Đã loại:** bảng `goals` ghi trực tiếp không event (mất replay và idempotency); bảng `goal_events` riêng (nhân đôi đường
accept và projector).

**Cần đối chiếu ở T001:** mọi chỗ đọc `events` không theo `task_id` (report, decisions, retention, verify) phải lọc
`stream = 'task'` hoặc xử lý goal.

## R-22 — Kế hoạch: schema, hash, nhóm song song, phân loại sửa đổi

**Quyết định:**

- `PlanSchema` (Zod) theo [contracts/goal.md](contracts/goal.md). Hash là SHA-256 của JSON chuẩn hóa (khóa sắp xếp, không
  khoảng trắng).
- `src/engine/plan.ts` (thuần): `validatePlan`, `parallelGroups` (tầng của DAG theo phụ thuộc), `classifyAmendment(old,
  new) → 'execution' | 'scope'` đúng bảng FR-075, và `affectedUnits(old, new)`.
- Đơn vị tách `description` (yêu cầu, đóng băng sau khi duyệt: đổi là sửa phạm vi) khỏi `instructions` (cách làm, deputy
  sửa được). Không thì đổi mô tả từ "xuất CSV" sang "xuất JSON" mà giữ tiêu chí chung chung sẽ lọt qua như sửa thực thi.
- Xác nhận tạo task cho mỗi đơn vị bằng các trigger nội bộ của cùng transaction: `task_add` với `goal`, run config đã xác
  nhận theo digest của kế hoạch, `depends_on` theo task id của đơn vị.

**Lý do:** một lần duyệt nhưng mỗi đơn vị vẫn là task thường với policy đóng băng riêng.

## R-23 — Nhánh goal và merge vào nhánh goal

**Bối cảnh mã nền:** mỗi task có `base_branch` riêng; worktree tạo từ `base_sha` của nhánh đó; task phụ thuộc chỉ được
đánh thức khi task trước DONE (`notifyDependents`). Yolo (`src/daemon/yolo.ts`, `onYoloMergeApprove`) đã merge bằng code
khi head chứa đỉnh nhánh đích mới nhất và check GitHub thỏa required list (rỗng thì không merge). `merge_gate` của
`software_dev@1` có `auto_when: { target_branch: ['feature/*', 'group/*'] }` nhưng task runtime (002) chờ merge bên ngoài.

**Quyết định:**

- Effect `git.create_goal_branch` tạo `goal/<id8>-<slug>` từ `base_sha` lúc xác nhận; probe bằng `ls-remote`; tên được kiểm
  không khớp `protected_branches` ở `validatePlan`.
- Đơn vị có `base_branch` = nhánh goal, `merge_method` = `merge` (đóng băng như hiện nay).
- Merge vào nhánh goal đi đúng đường yolo, với điều kiện bật là "task là đơn vị của goal đã xác nhận và `base_branch` là
  nhánh goal của nó" thay cho `yolo: true`. Engine ghi approval `policy:goal`. Điều kiện head chứa đỉnh nhánh đích của yolo
  chính là FR-083; khi chưa chứa, cơ chế base update hiện có (`src/engine/base-update.ts`) cập nhật nhánh đơn vị rồi chạy
  lại gate, review theo chế độ và CI.
- `sendMerge` (`src/adapters/github/merge.ts`) chỉ pin head SHA, không pin base, và mã nguồn đã ghi nhận race này. Với
  nhánh goal, bảo đảm "head chứa base lúc merge" dựa vào hai điều kiện thay vì một lệnh merge có điều kiện mà GitHub không
  có: nhánh goal chỉ daemon ghi, và mỗi nhánh goal tối đa một effect merge đang bay (khóa theo nhánh trong outbox). Trước
  khi gửi merge, daemon kiểm đỉnh nhánh goal bằng merge commit cuối nó đã ghi (hay `base_sha` lúc tạo); khác là có người
  push tay, goal vào `replan` với lý do `goal_branch_drift` và không merge nữa.
- Đơn vị DONE khi observation thấy PR đã merge vào nhánh goal, như hiện nay; đơn vị phụ thuộc được đánh thức theo R-29 và
  tạo worktree từ đỉnh nhánh goal.

**Lý do:** gần như không thêm cơ chế: base branch, phụ thuộc, base update, yolo merge, observation đều đã có. Merge commit
giữ ranh giới từng đơn vị trên first-parent của nhánh goal.

**Đã loại:** merge cục bộ bằng git plumbing rồi push (đi vòng qua PR, mất CI và review trên PR của đơn vị); worktree xếp
chồng từ HEAD của task cha (rebase dây chuyền khi task cha đổi, đau với squash merge).

## R-24 — Task tổng

**Quyết định:**

- Workflow `goal_final` dựng từ `modeGraph` của chế độ đã xác nhận, bỏ `scout` và `code`; bắt đầu ở `gates`. Không có bước
  coder; fixer vẫn có.
- Task tổng có `branch` = nhánh goal (đã có), `base_branch` = nhánh gốc, `start_sha` = đỉnh nhánh goal lúc nó bắt đầu (cùng
  đường với `adoption.head_sha` ở `src/daemon/handlers.ts`), không qua `adopt_approval` vì kế hoạch đã được xác nhận.
- Context của reviewer: diff nhánh goal so với nhánh gốc theo giới hạn hiện có, kế hoạch, tiêu chí nghiệm thu, danh sách đơn
  vị. Khi diff vượt giới hạn, reviewer nhận danh sách merge commit và đọc diff từng đơn vị.
- Merge gate theo quy tắc hiện hành của nhánh gốc: người merge trên GitHub, hoặc yolo nếu chủ dự án bật (hiến chương V giữ
  ngoại lệ yolo; goal không thêm đường auto-merge nào khác). Khác với đơn vị, điều kiện `policy:goal` không áp cho task tổng.

**Lý do:** PR của goal dùng lại nguyên đường publish, review, CI, merge hiện có.

## R-25 — Điều phối xuyên goal

**Quyết định:**

- Scheduler giữ scope guard hiện có (#240, `src/application/scope-match.ts`): một task chưa bắt đầu chờ khi scope của nó
  (file đã đổi cộng đường dẫn khai báo) chồng với task giữ slot. Đơn vị của goal nhiều đơn vị bắt buộc khai scope (FR-071),
  nên guard luôn có dữ liệu.
- Xung đột thật (FR-092): sau mỗi checkpoint, daemon chạy `git merge-tree --write-tree` giữa head của task và head của các
  task đang hoạt động trong project có file đã đổi chồng nhau, lưu kết quả vào bảng `branch_conflicts` (không phải event,
  không đổi version). Dùng cho context, `task explain` và `goal show`.

**Lý do:** không cho task nào chờ vì xung đột: chờ không xóa xung đột mà chỉ tuần tự hóa và giảm song song; xung đột thật
được giải ở base update trước merge (FR-083). Biết sớm giúp deputy và task tổng.

**Đã loại:** gate "dynamic scope guard" bằng `git diff --name-only` chặn task khi diff vượt scope (Gemini): chồng file
không có nghĩa là xung đột (lockfile, file cấu hình chung), nên sẽ chặn nhầm nhiều; một luật cố định chọn task nào chờ
khi `merge-tree` báo xung đột (bản design note trước): như trên, giảm song song mà không bớt việc giải xung đột.

## R-26 — Lease cho lệnh goal

**Quyết định:** client gửi `x-cusr-lease` khi có (lease mà `cusr assistant wait` in ra, hoặc từ phiên đã `assistant
register`). `admitCommand` cho lệnh goal của actor `assistant` chỉ khi lease khớp holder hiện tại của attention
(`src/application/attention.ts`); không thì `forbidden`, `reason: 'lease_required'`.

**Cần đối chiếu ở T001:** cách phiên trợ lý biết lease hay session id của mình khi gọi `cusr` ngoài `assistant wait`
(biến môi trường do hook đặt, hay file `assistant-session.json`). Chọn cách không đòi trợ lý nhớ thêm cờ.

## R-27 — Một PR cho goal hay N PR

| | N task, mỗi task một PR vào nhánh gốc | Một goal, PR đơn vị vào nhánh goal, một PR vào nhánh gốc |
| --- | --- | --- |
| Chạy qua đêm | Dừng ở mỗi lần merge của người | Không dừng; chỉ dừng ở PR cuối |
| Worktree, gate, review | Đủ cho từng task | Đủ cho từng đơn vị, thêm gate, review và CI cho toàn goal |
| Xung đột ngữ nghĩa | Bắt khi task sau rebase lên nhánh gốc | Bắt trước mỗi merge vào nhánh goal và ở task tổng |
| Review của người | N PR nhỏ | Một PR, đọc theo merge commit của từng đơn vị |
| Nửa vời trên nhánh gốc | Có thể (đã merge 4/9 rồi phát hiện sai thiết kế) | Không: nhánh gốc chỉ nhận goal hoàn chỉnh |
| Thay đổi mã | Không | Nhánh goal, task tổng, merge của code vào nhánh goal |

**Quyết định:** một PR cho goal nhiều đơn vị; goal một đơn vị giữ PR thẳng vào nhánh gốc. Chủ dự án vẫn có thể chia việc
thành nhiều goal nhỏ nếu muốn review từng phần trên nhánh gốc.

## R-28 — Các đề xuất khác đã loại

| Đề xuất | Lý do loại |
| --- | --- |
| Gom sự cố theo goal, debounce 10–15 giây | Một lượt cho cả goal thành nút cổ chai; debounce không chặn race; version của task và plan version giải race tất định |
| Tách hai pha (task đơn trước, goal sau) | Chủ dự án yêu cầu làm trọn; schema goal làm từ đầu nên task đơn là goal một đơn vị, không có hai đường |
| Hợp nhất decider vào sổ như một cơ chế riêng | Không cần: decider bị thay; câu hỏi của worker là một loại sự cố của deputy |
| Auto-merge vào nhánh gốc khi CI xanh và review đạt | Trái nguyên tắc V; nhánh goal giải được bài chờ merge mà không cần |
| Một lệnh "đóng lượt" bắt buộc thay cho các lệnh khác | Bàn giao là lệnh cuối của lượt; thiếu thì `aborted` có danh sách lệnh, đủ cho lượt sau |

## R-29 — Phụ thuộc theo khóa đơn vị và không hủy dây chuyền khi replan

**Bối cảnh mã nền:** `notifyDependents` (`src/application/dependency.ts`) gửi trạng thái kết thúc của task tiên quyết, và
engine hủy task phụ thuộc khi task tiên quyết FAILED hay CANCELLED (`src/engine/intake.ts`). Task đã hủy không mở lại được
(nguyên tắc III).

**Quyết định:**

- Task của một goal có kế hoạch lưu phụ thuộc theo khóa đơn vị (`TaskInput.goal.depends_on_units`), không theo task id.
  `notifyDependents` giải khóa thành task hiện hành của khóa đó qua `goal_tasks`.
- Task hiện hành của khóa FAILED khi goal chưa kết thúc: task phụ thuộc (gồm task tổng) nhận `dependency_status` với cờ
  `replan`, engine giữ chúng ở `dependency_pending` có `detail.replan`, không hủy. Task thay thế DONE thì chúng được đánh
  thức như thường.
- Goal `failed` hay `cancelled`: daemon gửi `task cancel` cho mọi task chưa kết thúc của goal.
- Task không thuộc goal có kế hoạch (kể cả goal ẩn) giữ nguyên luật cũ.

**Lý do:** replan chỉ có nghĩa nếu phần sau của goal còn sống; giải phụ thuộc theo khóa tránh phải sửa task đã đóng băng.

**Đã loại:** hồi sinh task đã CANCELLED (trái nguyên tắc III); tạo lại mọi task phụ thuộc khi thay một đơn vị (mất lịch sử,
nhân đôi task tổng).

## R-30 — Đối chiếu mã nền (T001)

Đối chiếu tại `origin/main` `baf9cf4` ngày 2026-11-09.

| Mục | Kết quả trên code | Hệ quả |
| --- | --- | --- |
| Đọc `events` không theo `task_id` (R-21) | Bốn chỗ: `rewriteTaskStates` (`src/store/migrate.ts`) và `verifyProjections` (`src/store/verify.ts`) quét cả bảng rồi `replay` theo `task_id`; `terminalEventsAfter` lọc theo `type`; `lastGlobalSeq` lấy `MAX(global_seq)`. `report`, retention, `task_history` và projector đọc theo `task_id` hoặc projection `tasks`; `decisions.md` do decider ghi, không quét `events`. | Lát A thêm cột `stream` và cho ba chỗ đầu lọc `stream = 'task'`. `lastGlobalSeq` để nguyên: event của goal cũng là thay đổi mà attention và board cần thấy. |
| Lease ngoài `assistant wait` (R-26) | Lease có dạng `<holder id>.<batch>`; holder id là session id khi phiên `assistant register` (lấy từ `PI_SESSION_ID`, `CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`), là UUID mới khi `assistant wait` chạy không có `--lease`. `assistant-hook.json` lưu `{ session, lease }` của phiên đã register. | Client gửi `x-cusr-lease` = session id từ các biến trên khi có, nên phiên đã register không phải nhớ cờ nào. Phiên chỉ dùng `assistant wait` thì lease là UUID mà lệnh khác không biết; lát D nên cho `assistant wait` dùng session id làm holder id khi biến có mặt. Daemon chỉ so phần holder id. |
| `ReviewEvidence` và output reviewer (R-18) | Finding có ba lớp: output harness `FindingSchema` (`src/adapters/harness/result-schema.ts`, trường `message`), trigger `ReviewDataSchema.findings` (`.strict()`, trường `msg`) và `ReviewEvidence.findings` (`src/domain/state.ts`). | `key` phải thêm ở cả ba; lát A chỉ thêm `key?` tùy chọn vào trigger và domain. |
| Bộ lọc log gate (R-18) | **Không có.** Repo chỉ khai `log_pattern` cho luật phân loại CI (`CiRuleInputSchema`). Gate lưu `log_excerpt` (đầu và đuôi đã che secret) và log đầy đủ dưới `COMMAND_LOG_DIR`. | Chữ ký gate ở lát C cần quyết định nguồn dòng lỗi: chuẩn hóa `log_excerpt`, hoặc thêm khóa lọc mới trong `cusr.yaml`. Không ảnh hưởng lát A. |
| Yolo và `policy:goal` (R-23) | `advanceTaskPr` hỏi `deps.enabled()` (đọc user config) cho mọi task; trigger `yolo_merge_approve` khiến engine ghi approval `granted_by = YOLO_APPROVER`. Base update chạy độc lập với yolo. | Lát E: `enabled` nhận task (goal unit thì bật), trigger mang approver `policy:goal`. Khả thi. |
| `start_sha` cho task tổng (R-24) | `prepare` (`src/daemon/handlers.ts`) truyền `start_sha` từ `s.adoption.head_sha`; `Adoption` bắt buộc `pr_ref` và chỉ sinh qua `adopt_pr` của admin. | Task tổng chưa có PR nên không đi được qua `adoption`; lát E cần nguồn `start_sha` riêng (ví dụ trong `TaskInput.goal`) cho cùng tham số `ensureWorktree`. |
| Vi phạm ranh giới (FR-002) | Runner trả `failure: 'boundary_violation'` (`src/runner/invocation.ts`); `HARNESS_FAILURE_CLASS` đổi nó thành lớp `unknown`, nên engine ghi `effect_failed` mà mất dấu. | T011 mang `failure` qua `FailureData` tới `detail.failure` của wait. |
| Bảng định tuyến (FR-001) | `NEEDS_USER` coi `cancel_reconcile` là không cần người, nhưng danh sách "tự tiếp tục" của FR-001 không nêu nó. `cancel_reconcile` quá `CANCEL_READS_BEFORE_ATTENTION` thì `needsUser` là true. | `cancel_reconcile` là `auto` (giữ tương đương với `NEEDS_USER`); khi kẹt thì tới owner, vì người đã yêu cầu hủy. |
| Kiểm `x-cusr-turn` (T014) | Server chỉ dựng caller từ header; replay theo `request_id` nằm trong `store.admitCommand`, không có guard trạng thái nào chạy trước nó. | Server chỉ đọc header vào caller; kiểm lượt `running` nằm trong `admitCommand` sau bước tra ledger (thứ tự 0 → 1 của contracts/cli-daemon.md), để replay sau khi lượt đóng vẫn trả kết quả cũ. Query của deputy kiểm lượt ở handler query. |
| Biến môi trường của runner (T015) | `CUSR_ATTEMPT_ID` khai ở `src/runner/process-env.ts` (để worker guard đọc mà không kéo zod), đặt ở `attemptLayoutInputs`; `sandbox.ts` chỉ lọc biến kế thừa, không lọc biến runner tự đặt. | `CUSR_DEPUTY_TURN` khai cạnh nó trong `process-env.ts`. |

### Quyết định khi làm lát A

- **`Role` `deputy`, outcome `turn_ended` và fake harness (T010 một phần, T002) dời sang lát B.** `Role` khóa vào
  `ROLE_SCHEMAS`, digest schema đã chứng minh trong manifest và role của sandbox; deputy không có schema kết quả, nên
  thêm nó là quyết định của runner cho lượt deputy (T029). Lát A chỉ thêm `CommandKind` `task_fail`; `task_waive`,
  `goal_*`, `deputy_handoff` vào cùng lát có handler của chúng, để không có kind nào trả `not_available`.
- **T003 một phần:** `test/support/deputy.ts` có user config có hay không `roles.deputy`/`roles.decider`/`autonomous`,
  task ở một mã wait bất kỳ, bản ghi lượt `running` và mốc worktree. Kế hoạch và lịch sử cho tín hiệu vòng lặp thêm
  cùng lát C và D, khi các kiểu đó có.
- **Kiểm lệnh của deputy (T013, T014):** server chỉ đọc `x-cusr-turn` vào caller. `admitCommand` tính `command_hash`
  (gồm `reason`, `trial`, `turn_id` khi có, nên lệnh cũ giữ nguyên hash), tra ledger theo `request_id`, rồi mới kiểm
  lượt `running` (`forbidden` `turn`), bảng quyền FR-034 (`forbidden` `deputy_kind`) và `reason`/`trial`
  (`invalid_command`). Bảng quyền làm sớm từ T033 vì rẻ và chặn deputy hủy hay xác nhận task; `turn_scope` vẫn ở lát B.
  Query của deputy cũng cần lượt `running`. `reason`, `trial`, `turn_id` vào `command_ledger` và `AuthzContext` của
  envelope.
- **`task fail` khi task không WAITING** trả `rejected` với `reason: fail_not_waiting` (exit 6) theo quy ước #261, không
  thêm mã `transition_not_allowed`.
- **`continue` trên giới hạn (T020):** `backoff_exhausted` xóa bộ đếm của lớp ở step; `ci_wait_exhausted` mở cửa sổ CI
  mới cùng độ dài (`CiWait.window_from` giữ số poll trước cửa sổ, nên ID logic của poll không trùng);
  `agent_runs_exhausted` và `deadline` chỉ nhận khi giới hạn đã được nới (`agent_runs_still_exhausted`,
  `deadline_still_passed`), vì đi tiếp dưới giới hạn cũ chỉ mở lại cùng wait. `agent_runs_insufficient` không
  `continue` được, chỉ `amend-policy --agent-runs` (theo T021, chặt hơn FR-030).
- **`amend-policy` giới hạn (T021):** `--agent-runs +N` cộng vào `max_agent_runs`; `--deadline <ISO>` đặt hạn,
  `--deadline +2h` dời hạn hiện tại muộn hơn 2 giờ. Dời theo hạn hiện tại thay vì theo lúc gõ lệnh, để bản xem trước
  và lệnh xác nhận cho cùng hash. Engine nhận trigger `amend` từ `operate`; `proposeAmendment` vẫn chỉ cho admin, và
  ứng dụng dựng policy sau khi đã kiểm theo profile (`allow_models`, `above: deny`). Sửa đổi vào một wait `policy` vẫn
  cho task đi tiếp như trước. Nới giới hạn cũng nhận ở `backoff_exhausted` và `ci_wait_exhausted` (FR-030). Ở
  `backoff_exhausted`, sửa đổi cho step chạy lại ngay một lần nhưng giữ bộ đếm của lớp, nên lỗi kế tiếp lại vào wait;
  chỉ `continue` xóa bộ đếm để mở một vòng backoff đầy đủ. Cửa sổ CI mới cũng chỉ do `continue` mở.
- **`task fail` khi có source drift** kết thúc ngay với `(no draft PR: source drift)`: drift chặn mọi claim tới khi
  chọn revision, nên salvage không bao giờ chạy. Task đã kết thúc thì `task fail` bị từ chối `fail_not_waiting`.
- **Wait cạn trần khi không có deputy (T022):** `src/daemon/deputy-absent.ts` coi deputy là có khi user config có
  `roles.deputy`. Alias `roles.decider` (FR-121) thêm ở lát B cùng deputy thật; thêm sớm hơn thì task của người đang
  dùng decider sẽ đứng ở wait mà không ai gỡ. Lý do fail giữ dạng của #247 (`ladder_exhausted:<step>`,
  `rung_denied:<step>:<rung>`).
- **Lease:** caller mang `lease` từ header `x-cusr-lease`; client chưa gửi header này, lát D chọn nguồn (R-30).

### Quyết định khi làm lát B

Đối chiếu tại `origin/main` `ef57b16` ngày 2026-11-09.

- **Role `deputy` có schema kết quả tối thiểu.** Hợp đồng ghi "`schema` không dùng", nhưng runner khóa mọi bước
  (argv có schema, proof, manifest, `recover`) vào `ROLE_SCHEMAS`. Lát B thêm `cusr.role.deputy.v1`
  `{ schema_version: 1, final_message }`; `RunnerHarness` đổi `result` của role `deputy` thành outcome `turn_ended`. Đường
  structured output, proof và `recover` giữ nguyên. Hệ quả: `PROOF_ROLES` thêm `deputy` (proof tốn thêm một lần gọi
  model), và harness đã prove trước lát B phải prove lại hay `record-manifest` từ evidence mới, đúng FR-121. Lát G thêm
  đường tương tác trả `turn_ended` qua hook.
- **Biên và cwd.** Deputy chạy biên `fixer` (ghi được, như reviewer), cwd là `<data dir>` đúng hợp đồng: lượt không cần
  worktree của task tồn tại (sự cố ở `prepare` xảy ra trước khi có worktree). Context ghi đường dẫn worktree để đọc khi có.
  Runner đặt `CUSR_DEPUTY_TURN` thay `CUSR_ATTEMPT_ID`, và `CUSR_DATA_DIR` là data dir của daemon, nên `cusr` trong lượt
  gọi đúng daemon dù daemon chạy với `--data-dir` khác mặc định. Luật cấm `Edit`/`Write` trên `<data dir>/worktrees/**`
  (FR-053) cần sửa settings của phiên, để lát G cùng settings tương tác.
- **Trả worktree thất bại** thì lượt vẫn sống (giữ mốc và chặn dispatch), daemon thử trả lại sau; lượt chỉ sang trạng
  thái cuối khi trả xong. Sửa của deputy không bao giờ lọt vào task.
- **Vòng không chờ harness.** `round()` khởi động lượt và trả về ngay; lượt chạy song song, nên vòng sau vẫn dừng được
  lượt của task đã kết thúc (FR-018) và mở lượt cho task khác (FR-014). Không dựng được lượt (ví dụ không đọc được mốc)
  thì sự cố về người tới khi daemon khởi động lại.
- **Bàn giao** đi qua `Redactor` trước khi lưu.
- **Mốc cũ.** Lấy mốc phải chờ Git trước khi có dòng lượt chặn dispatch; sau đó daemon đọc lại task, và nếu version, sự
  cố, pause hay cancel đã đổi (ví dụ chủ dự án `continue` và worker đã chạy) thì bỏ mốc, không mở lượt.
- **Dừng daemon** chờ mọi việc lượt đã khởi động (chạy, nhận lại, trả worktree) xong trước khi đóng store
  (`abortRounds` được await), để việc trả worktree muộn của daemon cũ không xóa commit của worker dưới daemon mới.
- **Bản ghi trên đĩa.** Một file `<data dir>/deputy/<turn_id>.json` giữ input của runner và mốc worktree, ghi trước dòng
  `deputy_turns`, thay cho `deputy-baseline-<turn_id>.json` riêng. File không có dòng là lượt chưa spawn và bị bỏ; dòng
  sống mà daemon này không chạy thì được nhận lại (FR-056).
- **Chặn dispatch (R-08).** Dispatcher bỏ qua `prepare`, `start_agent`, `run_gates`, `publish` của task có lượt
  `running`/`retry_wait` (lý do `deputy_turn`), đọc từ `deputy_turns`. Lượt chỉ sang trạng thái cuối sau khi trả worktree.
- **Lệnh của người không dừng lượt.** `recheck` của decider (dừng run khi người trả lời) bị bỏ: người thắng bằng version
  (FR-057), lượt chỉ bị dừng khi task kết thúc (FR-018).
- **`deputy handoff`** là lệnh không có project, task hay version như lệnh hàng đợi; không cần `--reason` (bàn giao là lời
  giải thích của lượt); actor khác `deputy` bị `forbidden` `turn`. CLI nhận một `--ruled-out "<giả thuyết>: <lý do>"`;
  nhiều mục đi qua `--file`.
- **`turn_scope`:** goal của task là `task.goal.id`, không có thì chính task (goal ẩn, FR-123).
- **Cấu hình `roles.deputy.limits`:** dùng khóa sẵn có `max_turns`, `stall_timeout`, `wall_timeout`, thêm `infra_retries`
  và `context_bytes` (data model viết `wall_ms`, `stall_ms`). `autonomous: true` cần role `deputy` hoặc `decider`. Role
  `decider` được đọc như `deputy`; daemon ghi cảnh báo đổi tên một lần, `cusr doctor` cũng báo.
- **Context tạm** gồm vùng 1, 3, 5: vai trò, task (lịch sử theo step do code dựng, bàn giao trước: mới nhất đầy đủ, cũ hơn
  `decision` và `ruled_out`, lượt `aborted` kèm lệnh của nó), sự cố (mã, chi tiết, câu hỏi, lệnh khả dụng). Vùng 3 và 5
  cắt theo 60%/40% của `context_bytes`. Lát D thay bằng `deputy-context.ts`. Lượt luôn `headless` tới lát G; `signature`
  để null tới lát C.
- **Attention và inbox:** `holds` đúng khi sự cố tới deputy, task không pause và chưa có lượt nào kết thúc ở đúng sự cố
  đó. Mục inbox đánh dấu `deputy: true` (thay `decider: true`) và có `handed_off`; mục attention có `deputy` khi lượt đã
  chuyển sự cố cho người.
- **Nâng cấp (R-13):** run decider chỉ được đóng (`decider_ran superseded`) khi chứng minh được đã dừng: chưa launch, hoặc
  `stop` trả khác `unknown`. Không chứng minh được thì giữ bản ghi, task đó không có lượt deputy, và mỗi vòng thử lại
  (nguyên tắc II). Run đã launch rồi bị dừng tính là đã tiêu lượt agent. Engine giữ `decider_start`/`decider_ran` cho replay và bước này; không còn ai gửi
  `decider_start`. Quy tắc một câu trả lời mỗi step và nhãn `grill` nằm ở `decider.ts` nên bị bỏ cùng file.
- **Mục giả định trong PR (R-14)** được thêm vào `pr_body` lúc nhận content của worker, từ câu trả lời của actor `deputy`
  trong revision hiện tại, nên content đã lưu và probe thấy cùng một thân.
- **Dời sang lát C:** fake reviewer trả finding có `key` (T002) và bước 4 loop guard của hợp đồng sau lượt.
