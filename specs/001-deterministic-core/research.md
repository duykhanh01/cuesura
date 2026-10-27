# Research: Lõi điều phối tất định

Phase 0 của [plan.md](plan.md). Stack đã cố định ở SPEC.md §17.2 nên không có mục NEEDS CLARIFICATION về
công nghệ. Các mục dưới giải quyết những lựa chọn thiết kế mà spec để mở.

## R-01 Bố cục package

- **Decision:** một package TypeScript ở gốc repo, chia module theo thư mục `src/{shared,domain,config,
  policy,engine,store,explain}`.
- **Rationale:** feature chỉ có thư viện và bộ kiểm thử. Workspace nhiều package thêm cấu hình build,
  tham chiếu dự án và publish nội bộ mà chưa có nhu cầu (nguyên tắc VIII). Ranh giới thuần/I/O được giữ
  bằng luật ESLint (R-12).
- **Alternatives considered:** pnpm workspace `packages/{core,store,config}`: tách rõ hơn nhưng chưa có
  consumer thứ hai; xét lại khi `cusr-runner` cần build độc lập.

## R-02 Phiên bản dependency

- **Decision:** dùng các major line sau, pin bản chính xác trong `package.json` và commit
  `pnpm-lock.yaml`: `zod` 4, `yaml` 2, `better-sqlite3` 13, `uuid` 14, `fast-check` 4, `vitest` 5.
  Đây là bản mới nhất trên npm registry ngày 2026-10-27; task bootstrap ghi lại bản patch đã cài.
- **Bản đã cài (T002, 2026-10-27):** Node `24.22.1` (`.nvmrc`, `engines.node`), pnpm `12.15.0`
  (`packageManager`); runtime `zod 4.6.7`, `yaml 2.9.1`, `better-sqlite3 13.0.3` (SQLite 3.53.4),
  `uuid 14.0.3`; dev `typescript 6.0.3`, `vitest 5.0.5`, `fast-check 4.10.2`, `eslint 10.13.0`,
  `typescript-eslint 8.72.0`, `@eslint/js 10.0.1`, `prettier 3.9.10`, `@types/better-sqlite3 9.6.0`,
  `@types/node 24.19.2`, `globals 17.13.0`. TypeScript 7 có trên registry nhưng `typescript-eslint` 8
  chỉ hỗ trợ `<6.1`, nên pin 6.0.3. `typescript-eslint 8.72.1` mới phát hành dưới một ngày, bị chặn bởi
  `minimumReleaseAge` của pnpm; dùng 8.72.0 thay vì nới chặn.
- **Rationale:** SPEC.md §17.2 chọn thư viện, không chọn bản. Pin chính xác cùng frozen lockfile cho
  build tái hiện được.
- **Alternatives considered:** `node:sqlite` thay `better-sqlite3`: SPEC.md §13.1 chỉ cho phép sau khi qua
  cùng contract test, không chạy song song trong v1.

## R-03 Chuẩn hoá và hash cấu hình

- **Decision:** hash = SHA-256 (`node:crypto`) của JSON chuẩn hoá: key sắp theo code point, không khoảng
  trắng, số theo `JSON.stringify` của ECMAScript, bỏ khoá có giá trị `undefined`, mảng giữ thứ tự. Tự
  viết khoảng 40 dòng trong `src/shared/canonical-json.ts`, chỉ nhận giá trị JSON (từ chối `NaN`,
  `Infinity`, `bigint`, object có prototype khác `Object`).
- **Rationale:** thoả FR-004 (cấu hình tương đương cho cùng hash). Quy tắc này trùng RFC 8785 (JCS) với
  tập giá trị mà cấu hình dùng. Hash tính trên cấu hình hiệu lực sau khi hợp nhất và chuẩn hoá giá trị
  mặc định, nên khác thứ tự key hay định dạng YAML không đổi hash.
- **Alternatives considered:** package `canonicalize`: thêm dependency cho một hàm nhỏ. Hash trên văn bản
  YAML: đổi định dạng là đổi hash, vi phạm FR-004.

## R-04 Thời điểm và ID đi vào lõi thế nào

- **Decision:** mỗi tín hiệu được bọc trong phong bì `TriggerEnvelope { trigger, now, ids }`:
  - `now` là epoch milliseconds do shell đọc một lần lúc nhận tín hiệu;
  - `ids` là mảng UUIDv7 cấp trước, có trần cố định (8). `decide` lấy ID theo thứ tự; cần nhiều hơn thì
    trả `rejected: id_pool_exhausted`, không tự sinh.

  Phong bì được lưu cùng tín hiệu đã chấp nhận, nên phát lại dùng đúng `now` và `ids` cũ.
- **Rationale:** FR-012 cấm lõi đọc đồng hồ hay sinh ngẫu nhiên; nguyên tắc I yêu cầu ghi nhận những giá
  trị này. Mảng có trần giữ `decide` hữu hạn (nguyên tắc III).
- **Alternatives considered:** ID suy ra từ hash `(task_id, seq, index)`: tất định nhưng không phải
  UUIDv7 như SPEC.md §5.1. Truyền hàm `nextId()` vào lõi: phát lại phải tái tạo trạng thái của hàm, khó
  kiểm chứng hơn mảng dữ liệu.

## R-05 Loader YAML: vị trí, giới hạn và tag

- **Decision:**
  - Kiểm kích thước byte trước khi parse (mặc định 256 KiB mỗi file, cấu hình được).
  - `parseDocument` với `schema: 'core'`, `uniqueKeys: true`, `maxAliasCount` hữu hạn (mặc định 50),
    không `customTags`, kèm `LineCounter`.
  - Mọi `doc.errors` và mọi `doc.warnings` đều là lỗi chặn; tag không có trong core schema bị từ chối.
  - Validate bằng Zod 4; đường dẫn của mỗi issue được ánh xạ về node YAML qua `doc.getIn(path, true)`
    rồi `LineCounter.linePos` để có `file:dòng:cột`. Không tìm được node thì dùng node cha gần nhất.
  - Sáu kiểm tra của FR-003 chạy trên cấu hình đã hợp nhất nhưng giữ bản đồ nguồn (khoá → file + vị trí)
    để lỗi chỉ về đúng file đã khai báo.
- **Rationale:** SPEC.md §8 chọn `yaml` với core schema và lỗi dạng `cusr.yaml:14:7`. Coi cảnh báo là lỗi
  giúp tag lạ không âm thầm thành chuỗi.
- **Cần kiểm chứng khi triển khai:** hành vi chính xác của `yaml` 2 với tag lạ, key trùng và vượt
  `maxAliasCount` được chốt bằng unit test trên fixture, không giả định từ tài liệu.
- **Đã kiểm chứng (T025, `yaml` 2.9.1, 2026-10-27; test/unit/config/loader.test.ts):** key trùng là
  `doc.errors` mã `DUPLICATE_KEY`; tag lạ (`!foo`) chỉ là `doc.warnings` mã `TAG_RESOLVE_FAILED`;
  `!!binary` vẫn được resolve dù dùng core schema nên loader tự lọc tag ngoài core; alias chưa có anchor
  và alias vượt `maxAliasCount` chỉ ném lỗi ở `toJS`, nên loader tự đếm node alias (lỗi tại alias thứ 51)
  và giữ `maxAliasCount` của `toJS` làm chốt chặn cho alias lồng nhau.
- **Alternatives considered:** `js-yaml`: không giữ vị trí node đủ tốt và không phải lựa chọn của SPEC.

## R-06 Một bên ghi ở mức kho

- **Decision:** khi mở kho để ghi, đặt `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`,
  `busy_timeout` hữu hạn, `locking_mode=EXCLUSIVE`, rồi chạy ngay `BEGIN IMMEDIATE; COMMIT` để giữ khoá
  ghi. Tiến trình thứ hai mở cùng file nhận `SQLITE_BUSY` sau busy timeout và được trả lỗi
  `store_locked` (FR-032). OS nhả khoá khi tiến trình chết, nên crash test vẫn mở lại được.
- **Rationale:** không cần file lock riêng hay xử lý PID cũ; đó là việc của `cusrd.lock` ở feature daemon.
  Chế độ EXCLUSIVE trong WAL cũng chặn đọc từ tiến trình khác, phù hợp với nguyên tắc II (mọi truy cập đi
  qua bên ghi duy nhất).
- **Cần kiểm chứng:** integration test hai tiến trình xác nhận bên thứ hai bị từ chối và bên đầu chết thì
  khoá được nhả.
- **Alternatives considered:** file lock: Node không có `flock` sẵn, phải xử lý lock mồ côi. Bảng lease
  trong DB: cần đồng hồ và thời hạn lease, phức tạp hơn nhu cầu của feature.

## R-07 Effect, timer và outbox là projection của nhật ký

- **Decision:** `decide` chỉ trả **sự kiện**. Yêu cầu effect là `EffectRequested`, hẹn giờ là
  `TimerArmed`; vô hiệu hoá, bắt đầu, kết quả, huỷ timer và tiêu thụ timer đều là sự kiện. Bảng `tasks`,
  `effects`, `timers` là projection cập nhật trong cùng transaction với việc append sự kiện.
  - Claim effect (`chờ dispatch → đã bắt đầu`) là thao tác của kho: trong một transaction, kiểm tra effect
    còn `pending`, gọi điều kiện claim thuần của engine (R-16), append `EffectStarted`, cập nhật
    projection. Effect đã `invalidated` thì trả `effect_invalidated` (FR-031).
  - Kết quả effect đi vào như tín hiệu `effect_result` qua `decide`, vì nó có thể đẩy workflow tiến lên.
  - Timer đến hạn được tiêu thụ bằng `fireDueTimers(now)`: mỗi timer tạo tín hiệu có khoá dedup
    `timer:<id>`, và `TimerFired` được ghi cùng transaction (FR-030).
- **Rationale:** một nguồn sự thật duy nhất. `verifyProjections` dựng lại cả ba bảng từ nhật ký (FR-029),
  và `decide` nhìn thấy vòng đời effect trong state để xử lý hủy (FR-018).
- **Alternatives considered:** `decide` trả `{events, effects, timers}` riêng: outbox không dựng lại được
  từ nhật ký, phải đối chiếu thêm một nguồn.

## R-08 Crash injection

- **Decision:** test cha `fork` một tiến trình con chạy `test/support/crash-child.ts` với
  `CUSR_CRASH_AT=<point>` và seed; `CUSR_CRASH_AFTER=<n>` (mặc định 1) chọn lần thứ n đi qua điểm đó để ngắt giữa một chuỗi tín hiệu. Kho đọc biến này một lần khi mở và gọi
  `process.kill(process.pid, 'SIGKILL')` tại điểm tương ứng. Các điểm: `after_dedup`, `after_events`,
  `after_projection`, `after_effects`, `after_timers`, `before_commit`, `after_commit`. Sau mỗi lần ngắt,
  cha mở lại kho, chạy `PRAGMA integrity_check`, kiểm tín hiệu đã commit còn đủ và `verifyProjections`
  khớp.
- **Rationale:** `SIGKILL` không cho chạy handler hay flush nào, gần với mất điện hơn `process.exit`.
  Seed ghi trong output để tái hiện (SC-005).
- **Alternatives considered:** `process.exit(137)` như tài liệu kiến trúc mô tả: vẫn chạy handler `exit`,
  có thể che lỗi. Ngắt bằng timer ngẫu nhiên từ cha: không nhắm được điểm giữa transaction.

## R-09 Chạy 10.000 chuỗi qua kho mà không mạo nhận độ bền

- **Decision:** hai tầng tách nhau:
  - **SC-003 (10.000 chuỗi):** chạy qua `decide`/`evolve` và qua module kho thật trên SQLite in-memory
    với cùng schema, unique constraint và code transaction. Mục đích là kiểm dedup, thứ tự, idempotency,
    ngân sách và bất biến quyết định.
  - **SC-005 (200 lần ngắt):** chạy trên file SQLite thật với WAL và `synchronous=FULL`. Đây là nguồn duy
    nhất cho bằng chứng độ bền.

  Tuỳ chọn mở in-memory chỉ được export từ entry test (`src/store/testing.ts`), không có trong API
  công khai.
- **Rationale:** 10.000 chuỗi × hàng chục transaction với fsync đầy đủ quá chậm cho CI, mà độ bền không
  phụ thuộc số chuỗi. Nguyên tắc VII cấm dùng kiểm thử tầng này làm bằng chứng cho tầng khác; báo cáo ghi
  rõ mỗi bộ chứng minh gì.
- **Alternatives considered:** 10.000 chuỗi trên file với `synchronous=OFF`: dễ bị đọc nhầm là bằng chứng
  độ bền. Giảm số chuỗi: không đạt SC-003.

## R-10 Phạm vi merge ở feature này

- **Decision:** lõi chỉ yêu cầu effect merge khi các tín hiệu đã ghi chứng minh đủ điều kiện SPEC.md §14.2
  cho đúng head/base: approval `merge` của người gắn với head SHA, review approve cho head đó, CI required
  checks đều `success` cho head đó, head chứa base tip đã ghi, và không có yêu cầu hủy.
  - **Tập required checks kỳ vọng** = hợp của `ci.required_checks` trong chính sách đóng băng (khai báo ở
    `cusr.yaml`, có thể rỗng) và tập do nguồn bên ngoài báo trong tín hiệu CI (`required_set.names`, kèm
    `source` và `complete`). Chỉ đạt khi `complete = true` và mọi tên trong tập hợp có kết quả `success`
    cho đúng `head_sha`. Tên có trong tập kỳ vọng nhưng vắng trong tín hiệu được tính là `missing`.
  - **Quan hệ head/base** là bằng chứng `BaseRelationRecorded { head_sha, base_ref, base_sha,
    head_contains_base }`, đến từ kết quả publish hoặc kết quả CI. Merge guard dùng bản ghi mới nhất cho
    head hiện hành.
  - Thiếu check hoặc `complete = false`: WAITING `ci`, hẹn timer để chờ CI tiếp trong giới hạn timeout
    của bước CI. Head chưa chứa base: WAITING `human_input` với `detail.code = base_outdated`. Tự cập
    nhật branch rồi chạy lại gate/review/CI thuộc feature merge.

  Chế độ `auto`
  (yolo) không được mô hình hoá: yolo là quyền hiện hành phải kiểm tra lúc dispatch, mà dispatch thuộc
  feature executor/merge.
- **Rationale:** FR-015 và nguyên tắc V. Mô hình hoá yolo mà không có điểm dispatch sẽ tạo cảm giác đã có
  kiểm tra lại quyền khi thực tế chưa có.
- **Alternatives considered:** nhận cờ `yolo_active` trong tín hiệu: lõi sẽ quyết định merge dựa trên một
  giá trị có thể đã cũ lúc dispatch.

## R-11 Workflow mặc định và cách diễn giải

- **Decision:**
  - Engine diễn giải workflow theo **loại bước**: `triage`, `prepare` (effect `prepare`), `agent`, `gate`,
    `review` (agent có verdict), `action` (`git.publish`, `github.create_pr`, `github.rerun_failed`,
    `github.merge`), `wait` (`github.checks`), `classify` (`ci_rules`, R-21), `approval`, `complete`.
    Mọi bước phát effect đều có loại effect tương ứng trong contracts/signals-events.md; `triage`,
    `classify`, `approval` và `complete` chỉ quyết định, không phát effect.
  - Workflow phát triển phần mềm mặc định là dữ liệu dựng sẵn `software_dev@1` trong
    `src/engine/workflows/`. Người dùng tham chiếu nó và chỉnh tham số (giới hạn lượt, gate, binding,
    `skip_when`).
  - Bộ kiểm tra cấu hình chạy đủ sáu kiểm tra cho **mọi** workflow khai báo.
  - Khi chốt chính sách, hệ thống so `structure_hash` (hash của tập bước, loại bước và cạnh transition, bỏ
    qua tham số) với `software_dev@1`. Khác nhau thì trả `unsupported_workflow` (FR-041).
- **Rationale:** giữ lõi trung lập (nguyên tắc VI): thêm workflow sau này là bỏ chặn, không viết lại
  engine. So cấu trúc thay vì so tên để một workflow đổi tên nhưng giữ cấu trúc vẫn chạy được, còn một
  workflow cùng tên nhưng đổi graph thì bị chặn.
- **Alternatives considered:** viết cứng các bước trong `decide`: nhanh hơn nhưng phải viết lại khi thêm
  workflow. So theo tên: dễ lách bằng cách đặt tên trùng.

## R-12 Ranh giới module và cách chặn I/O trong lõi

- **Decision:** ESLint cấu hình theo thư mục:
  - `src/engine/**`, `src/domain/**`, `src/policy/**`, `src/explain/**`: cấm import `node:*`,
    `better-sqlite3`, `yaml`, `uuid` và module trong `src/store`/`src/config`; cấm global `Date`,
    `performance`, `process`, `setTimeout`; cấm `Math.random`. Ngoại lệ duy nhất: `src/shared/hash.ts`
    được import `node:crypto` (`createHash`, tất định).
  - `src/store/**` không import `src/config/**`.
  - `@typescript-eslint/no-floating-promises` và `no-misused-promises` bật toàn repo.
- **Rationale:** biến FR-012 thành kiểm tra tĩnh chạy ở mọi PR, bổ sung cho property test I01.
- **Alternatives considered:** chỉ dựa vào code review: không kiểm chứng được tự động.

## R-13 Lý do chờ cho các tình huống spec mới thêm

- **Decision:** giữ nguyên tập `wait_reason` của SPEC.md §6.1 và đưa tình huống mới vào `detail`, như
  §6.1 cho phép:

  | Tình huống | Trạng thái | `wait_reason` | `detail.code` |
  |---|---|---|---|
  | Cấu hình không hợp lệ lúc chốt | PENDING | `needs_info` | `config_invalid` |
  | Workflow ngoài phạm vi (FR-041) | PENDING | `needs_info` | `unsupported_workflow` |
  | Chế độ decider chưa hỗ trợ (FR-039) | PENDING | `needs_info` | `unsupported_decision_mode` |
  | Role không còn binding hợp lệ | PENDING | `needs_info` | `no_valid_binding` |
  | Source drift tới ranh giới an toàn | WAITING | `human_input` | `source_drift` |
  | Auth/config, Refused, timeout lần 2 | WAITING | `human_input` | lớp thất bại |
  | Hết thang, lượt, ngân sách, thời hạn | WAITING | `policy` | `ladder_exhausted` … `deadline` |
  | Effect `unknown` chờ đối chiếu | WAITING | `infra` | `effect_unknown` |
  | Nấc `needs_approval` | WAITING | `approval` | `approval_kind: escalation` |
  | Nấc được chọn là `denied` | WAITING | `policy` | `rung_denied` |
  | Required checks thiếu hoặc chưa đầy đủ | WAITING | `ci` | `checks_incomplete` |
  | Head chưa chứa base tip | WAITING | `human_input` | `base_outdated` |
  | Lỗi CI không khớp `ci.rules` nào | WAITING | `human_input` | `ci_unclassified` |

  Yêu cầu hủy đang chờ đối chiếu không là lý do chờ mới: task giữ trạng thái hiện tại kèm
  `cancellation` trong state, và giải thích liệt kê effect còn chờ.
- **Rationale:** không mở rộng hợp đồng trạng thái của SPEC.md khi chưa cần.
- **Đã chốt (2026-10-27, chủ dự án):** lỗi cấu hình lúc chốt chính sách dùng `needs_info` kèm
  `detail.code`. SPEC.md chưa nêu rõ trường hợp này; nếu đổi thì cập nhật SPEC.md §6.1 cùng lúc.

## R-14 Báo cáo bất biến (SC-008)

- **Decision:** file `test/invariants.map.ts` ánh xạ I01–I12 → `{ scope, suites: string[] }` hoặc
  `{ scope: 'out_of_scope' }`. `scripts/report-invariants.ts` đọc kết quả `vitest --reporter=json` của
  cả nhóm thường và nhóm reliability, rồi in bảng. Script thoát lỗi khi một bất biến trong phạm vi có bộ
  kiểm thử thiếu, bị skip hoặc fail.
- **Rationale:** báo cáo được dựng từ kết quả chạy thật, không viết tay (nguyên tắc VII).
- **Alternatives considered:** tag trong tên test và grep: dễ lệch khi đổi tên.

## R-15 Môi trường phát triển

- **Decision:** cổng chất lượng (typecheck, lint, test, build, reliability) chạy trong WSL2/Ubuntu với
  Node 24 và pnpm qua Corepack. Máy dev hiện tại là Windows, Node 22.21.1, chưa có pnpm.
- **Rationale:** SPEC.md §2.1 giới hạn môi trường v1. `better-sqlite3` là native addon, còn tín hiệu
  `SIGKILL` và hành vi khoá file trên Windows khác Linux; chạy crash test trên Windows sẽ không chứng
  minh được gì cho môi trường đích.
- **Alternatives considered:** hỗ trợ cả Windows: ngoài phạm vi v1.

## R-16 Điều kiện claim effect

- **Decision:** `src/engine/claim.ts` export hàm thuần `claimable(state, effect) → ok | blocked(reason)`.
  `Store.claimEffect` gọi nó trong cùng transaction với việc đọc projection và append `EffectStarted`.
  Effect *nghiệp vụ* (`prepare`, `start_agent`, `run_gates`, `publish`, `create_pr`, `await_ci`,
  `rerun_ci`, `merge`) bị chặn
  khi một trong các điều kiện sau đúng:

  | Điều kiện | `reason` |
  |---|---|
  | `effect.revision ≠ state.revision` | `stale_revision` |
  | Source drift chưa có lựa chọn của người dùng | `source_drift` |
  | `now` của lần claim đã tới `deadline_at`, kể cả khi timer `deadline` chưa được xử lý (FR-023) | `deadline` |
  | Task đang hủy | `cancelling` |
  | Task đã kết thúc | `terminal` |
  | Task đang WAITING mà effect không phải effect mà lý do chờ đang đợi | `task_waiting` |

  Effect *phục vụ* (`stop_attempt`, `reconcile`) không bị các điều kiện này chặn. Effect bị chặn vẫn ở
  `pending`, không bị vô hiệu hoá.
- **Xử lý theo lựa chọn source drift** (FR-011):
  - `continue_old`: xoá cờ drift; effect pending claim lại được.
  - `apply_new`: trong cùng `Decision` với `RevisionApplied`, phát `EffectInvalidated` cho mọi effect
    nghiệp vụ pending của revision cũ và `BudgetReleased` cho giữ chỗ tương ứng.
  - `new_task`: invalidate như `apply_new`, rồi task cũ đi theo quy trình hủy (FR-018). Task mới do caller
    tạo bằng `create_task` có liên kết nguồn.
- **Đã chốt (2026-10-27, chủ dự án):** chọn tạo task mới khi có source drift thì task cũ đi theo quy
  trình hủy của FR-018. SPEC.md §5.3 chưa nêu rõ điểm này.
- **Rationale:** `decide` không thể thu hồi effect đã nằm trong outbox, còn executor không được tự quyết
  (nguyên tắc VI). Đặt kiểm tra ở điểm claim, trong cùng transaction, đóng khe giữa enqueue và dispatch.
  Hàm thuần giữ logic trong engine và test được bằng property test.
- **Alternatives considered:** invalidate mọi effect pending ngay khi phát hiện drift: nếu người dùng chọn
  tiếp tục revision cũ thì phải tạo lại effect với khoá mới và giữ chỗ mới. Để executor tự kiểm tra
  trạng thái task: logic nghiệp vụ lọt ra ngoài lõi.

## R-17 Kết quả đối chiếu effect

- **Decision:** tín hiệu `effect_reconciled` dùng cùng schema `data` với `effect_result` cho từng loại
  effect:
  - `finding = executed_succeeded` bắt buộc có `data` hợp lệ theo schema thành công của loại effect.
    Schema kiểm tra ở `decide`; thiếu trường bắt buộc thì từ chối finding đó, ghi
    `ReconcileIncomplete` và giữ effect `unknown` (FR-017).
  - `finding = executed_failed` bắt buộc có `failure_class` (và `signature` nếu lớp là `quality`).
  - `finding = not_executed` trả giữ chỗ. Effect được đưa về hàng đợi bằng effect mới cùng `idem_key` chỉ
    khi loại effect cho phép chạy lại an toàn.
  - `finding = still_unknown` giữ nguyên trạng thái.

  Với `start_agent`, kết quả chuẩn là output agent đã kiểm tra schema, `invoked` và usage có nhãn. Probe
  chỉ có exit code mà không có output hợp lệ thì không phải `executed_succeeded`.
- **Rationale:** SPEC.md §13.2 yêu cầu nhận lại thành công qua probe, tức là phải khôi phục được dữ liệu
  mà bước tiếp theo cần. Dùng chung schema tránh hai đường ghi bằng chứng khác nhau.
- **Alternatives considered:** reconcile chỉ báo trạng thái rồi phát effect "lấy lại kết quả" riêng: thêm
  một vòng effect mà không có lợi ích, vì probe đã phải đọc chính dữ liệu đó.

## R-18 Ánh xạ sàn task sang từng thang role

- **Decision:** sàn task được lưu dưới dạng **mức năng lực** `floor_level = (tier, effort_rank)`, không
  phải số thứ tự nấc. `tier` lấy từ `models.<alias>.tier`; `effort_rank` theo thứ tự `low < medium <
  high` của cấu hình adapter.
  - Khi nâng sàn (`scope: task` hoặc quy tắc `hard`), `floor_level` mới = mức năng lực của binding ở nấc
    vừa đạt; sàn chỉ tăng theo thứ tự từ điển.
  - Lúc chốt chính sách, loader tính sẵn `floor_map[step]`: với mỗi mức năng lực xuất hiện trong chính
    sách, nấc nhỏ nhất trên thang của step có mức ≥ mức đó; không có thì là nấc cuối của thang. Bảng này
    nằm trong FrozenPolicy, nên engine chỉ tra cứu.
  - Nấc mục tiêu = `max(rung[step], floor_map[step][floor_level], nấc_đề_xuất)`. Sau đó mới kiểm tra theo
    thứ tự: vượt độ dài thang → `ladder_exhausted`; nấc `denied` → `rung_denied`; `needs_approval` chưa có
    approval khớp → chờ approval; vượt `max_escalations` hoặc ngân sách → chờ `policy`.
  - Nấc chỉ thêm context (không đổi binding) có cùng mức năng lực với nấc trước.
- **Rationale:** SPEC.md §9.3 yêu cầu ánh xạ sàn sang từng thang role. So sánh theo mức năng lực của model
  là cách duy nhất có ý nghĩa giữa hai thang khác độ dài và khác binding. Tính sẵn ở loader giữ engine đơn
  giản và đưa bảng vào hash chính sách.
- **Đã chốt (2026-10-27, chủ dự án):** đơn vị của sàn task là mức năng lực `(tier, effort_rank)`, ánh
  xạ sang từng thang role qua `floor_map`. SPEC.md §9.3 chưa định nghĩa đơn vị này.
- **Alternatives considered:** sàn là chỉ số nấc dùng chung: sai khi thang khác độ dài (lỗi review gốc).
  Sàn là tên model: không so sánh được giữa harness khác nhau.

## R-19 Danh tính request khi dedup

- **Decision:** `request_hash` = hash chuẩn hoá của `{ task_id, trigger, expected_version, actor }`.
  `actor` lấy từ `authz.actor` khi có. `now` và `ids` không nằm trong hash vì đó là giá trị cấp cho lần
  xử lý; chúng vẫn được lưu trong phong bì để phát lại. Cùng `dedup_key` mà khác `request_hash` →
  `conflict: request_hash_mismatch`, kể cả khi chỉ khác `task_id`.
- **Rationale:** FR-026. Một khoá dedup toàn kho phải gắn với đúng một đối tượng nhận lệnh; nếu không,
  caller có thể tưởng lệnh đã áp cho task B trong khi kho trả kết quả của task A.
- **Alternatives considered:** dedup key theo task (`UNIQUE(task_id, dedup_key)`): che lỗi caller dùng lại
  khoá cho task khác thay vì báo conflict.

## R-20 Lỗi cấu hình và khả năng thực thi chưa hỗ trợ

- **Decision:** `validateConfig` trả `{ config, unsupported: UnsupportedFeature[] }` khi không có lỗi.
  - `Diagnostic` chỉ chứa lỗi làm cấu hình không dùng được, kể cả `decision_mode_forbidden` (FR-006).
  - `UnsupportedFeature` là `{ code: 'decision_mode_unsupported' | 'unsupported_workflow', workflow,
    points?, file, line, col }`. Nó không làm `validateConfig` thất bại.
  - `freeze` chỉ xét workflow và chế độ quyết định mà task thực sự dùng, rồi trả `FreezeError` tương ứng.
- **Rationale:** FR-039 và FR-041 yêu cầu chấp nhận cú pháp và báo rõ là chưa hỗ trợ. Coi đó là lỗi sẽ
  làm một workflow chưa dùng chặn mọi task của cùng cấu hình.
- **Alternatives considered:** thêm `severity: 'warning'` vào `Diagnostic`: trộn hai khái niệm, và
  loader đã quy ước mọi cảnh báo YAML là lỗi (R-05).

## R-21 Phân loại lỗi CI trong lõi

- **Decision:** `ci_rules` trong `cusr.yaml` được chốt vào `FrozenPolicy.ci.rules` dạng danh sách có thứ
  tự `{ match: { job?, check?, log_pattern? }, class: flaky_or_infra | autofix | code }`. `log_pattern`
  là chuỗi con hoặc regex đã được loader kiểm tra cú pháp và giới hạn độ dài. Bước `classify` của
  `software_dev@1` áp rule đầu tiên khớp cho từng check `failure` của head hiện hành:
  - mọi check thất bại cùng một lớp → đi theo outcome lớp đó;
  - nhiều lớp khác nhau → chọn lớp nghiêm nhất theo thứ tự `code` > `autofix` > `flaky_or_infra`;
  - có check không khớp rule nào → WAITING `human_input` `ci_unclassified`.
- **Rationale:** SPEC.md §7 yêu cầu phân loại lỗi CI bằng code trước khi gọi agent; nguyên tắc VI cấm
  adapter quyết định retry. Lõi cần `job` và `log_excerpt` trong tín hiệu CI để tự phân loại.
- **Alternatives considered:** executor gửi sẵn lớp lỗi: đưa quyết định retry ra ngoài lõi. Coi mọi lỗi
  không khớp là `code`: tốn lượt agent cho lỗi hạ tầng chưa biết.

## R-22 Backoff và thời hạn task

- **Decision:**
  - `limits.backoff = { base_ms, factor, max_ms, max_attempts }` theo từng lớp `rate_limit` và `infra`,
    khai báo trong profile, có mặc định (`rate_limit`: 60 000 ms, ×2, 30 phút, 5 lần; `infra`: 5 000 ms,
    ×2, 5 phút, 3 lần). Hết `max_attempts` thì WAITING `policy`. Mọi lượt vẫn tính vào trần lượt agent.
  - Khi đặt `deadline_at` lần đầu, lõi phát `TimerArmed(kind: deadline)`. Timer này đến hạn thì task chưa
    kết thúc chuyển WAITING `policy` `deadline` và không attempt mới nào được yêu cầu. Timer không bị huỷ
    hay dời khi đổi revision.
- **Rationale:** nguyên tắc III yêu cầu mọi retry có trần khai báo được; FR-023 cần phát hiện hết hạn cả
  khi task đang chờ mà không có tín hiệu nào khác.
- **Alternatives considered:** chỉ kiểm hạn khi có tín hiệu đến: task chờ người sẽ không bao giờ được
  đánh dấu hết hạn.
