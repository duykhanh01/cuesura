# Cuesura — Đánh giá kiến trúc và khuyến nghị (use case đầu tiên: workflow phát triển phần mềm)

*Ngày: 2026-10-26. Vai trò: Principal Software Architect review.*

> **Đặc tả triển khai:** [SPEC.md](../SPEC.md) là nguồn chuẩn cho phạm vi, hành vi và baseline kỹ thuật đã thống nhất. Tài liệu này giữ lại lập luận và các ví dụ thiết kế ban đầu; những ví dụ chưa đồng bộ không thay thế hợp đồng trong SPEC.

**Quy ước độ tin cậy** dùng xuyên suốt tài liệu:

- **[XM-code]**: đã xác minh trực tiếp trong mã nguồn (có đường dẫn file), commit được ghi ở mục 2.
- **[XM-docs]**: đã xác minh từ tài liệu chính thức hoặc README, chưa đọc code tương ứng.
- **[SL]**: suy luận/kinh nghiệm của tôi, chưa kiểm chứng.
- **[CKC]**: giả định cần kiểm chứng bằng spike trước khi phụ thuộc vào nó.

## 0. Tóm tắt điều hành: khuyến nghị dứt khoát

**Khuyến nghị: tự xây một *control plane* bằng TypeScript + SQLite, đáng tin cậy ngay từ v1. Thước đo là Reliability Gate (mục 9.1), không giới hạn số dòng code. Không fork công cụ nào trong năm ứng viên. Không dùng durable-execution framework trong v1.** Trước khi code, viết `SPEC.md` của riêng bạn theo phong cách *spec-first* của OpenAI Symphony.

Kiến trúc tóm gọn trong một câu:

> *Một state machine thuần (workflow là dữ liệu YAML có vòng lặp giới hạn, kiểm tra tĩnh) quyết định mọi bước. Agent là các lần gọi **headless CLI một lần** (`claude -p`, `codex exec`, `pi --mode rpc/json`), trả kết quả qua **JSON có schema**. Mọi side effect (push, PR, comment, merge) đi qua **outbox có idempotency key và bước "probe" trước khi làm lại**. Trạng thái nằm trong SQLite với event log append-only.*

**Lý do (dựa trên mã nguồn, mục 2):**
1. **Không ứng viên nào có đủ ba thứ làm nên khác biệt của bạn:**
   - Policy role/model đóng băng theo task, **chỉ được nâng model theo một thang đã duyệt trước** (trigger bằng code, nấc đắt cần duyệt). Bernstein thì tự nâng lên Opus ở mọi lần retry. Cezar cho agent tự chọn model cho task con. Paperclip có auto-fallback model.
   - Sổ cái side effect idempotent cho push, PR, comment và merge. Mỗi công cụ chỉ có mảnh rời, ví dụ AO guard merge theo SHA, Cezar nhận lại PR đã tồn tại.
   - Nhận task từ nhiều kênh (GitHub, form, agent, CLI), chuẩn hoá về **một format task trong DB**, và đồng bộ trạng thái ngược về đúng kênh. Mỗi công cụ chỉ có một phần: Symphony đọc tracker nhưng không lưu gì; AO chỉ đọc tracker một chiều; Cezar và Paperclip có tích hợp issue/chat nhưng gắn chặt với mô hình riêng của chúng.
2. **Phần bạn sẽ phải sửa nằm ở những chỗ khó tách và hay đổi nhất.** Việc fork khó vì cấu trúc, không vì kích thước code:
   - Logic điều phối của Cezar dồn vào một class `RunManager` duy nhất.
   - Bernstein có hàng trăm module không được nối vào luồng chính, và tính năng workflow có vòng lặp không chạy được từ CLI.
   - Paperclip và AO đều có hai đường runtime song song, và sản phẩm đang chuyển hướng (công ty AI tự vận hành, desktop/mobile).
   - Các repo đổi phiên bản theo tuần, và một số chỉ có khoảng một người duy trì.

   Fork sẽ phân kỳ khỏi upstream ngay lập tức. Đó là bẫy bảo trì, đúng điều bạn sợ.
3. **Repo gần triết lý của bạn nhất, Symphony, tự khuyên** "implement your own hardened version based on SPEC.md". Bản Elixir của họ chỉ là prototype: state trong RAM, retry không giới hạn, chỉ chạy Codex.
4. **Phần bạn muốn học chính là phần bạn phải tự viết**: state machine, recovery, idempotency, quality gates. Dùng runtime có sẵn sẽ mất phần giá trị đó.

**Đánh đổi bạn chấp nhận:**
- Tự bảo trì adapter cho từng harness. Đây là phần dễ lỗi thời nhất. Giữ adapter chỉ làm hai việc (dựng lệnh, parse output) và test bằng fixture ghi từ CLI thật.
- Không có UI.
- Ít tính năng hơn hẳn các công cụ kia.
- Để đạt chuẩn tin cậy, v1 cần khoảng **4 tuần** chứ không phải 14 ngày. Nếu bắt buộc giữ 14 ngày thì cắt phạm vi, không cắt độ tin cậy (mục 9.2).

**Phương án dự phòng (Plan B):** tại mốc kiểm tra hướng đi (ngày 10), nếu runner/adapter vẫn chưa ổn định thì giữ phần của bạn (nguồn task, DAG, policy, SQLite) và dùng **Cezar làm executor** qua HTTP API của nó. Cezar là ứng viên có engine workflow gần thiết kế này nhất (mục 2.4).

**Ba giả định phải kiểm chứng ngay ngày 1:**
1. Agent tuân thủ hợp đồng `result.json` theo schema.
2. `claude -p` chạy dài không giám sát bằng subscription, và lỗi rate limit nhận diện được.
3. Sandbox của `codex exec` cho build tool của project (npm, pip, cargo, Gradle…) truy cập mạng để tải dependency.

Toàn bộ giả định nằm ở Phụ lục A.

---

## 1. Đánh giá ý tưởng

### 1.1 Những yêu cầu hoàn toàn hợp lý (giữ nguyên)

| Yêu cầu | Nhận xét |
|---|---|
| Điều phối bằng code/state machine, không có Primary AI | Đúng hướng và là giá trị cốt lõi của dự án. Phần lớn quyết định "bước tiếp theo" trong workflow coding là hàm của dữ liệu: exit code, kết quả test, verdict review, trạng thái CI. Không cần LLM cho những quyết định đó. |
| Trạng thái bền vững + recovery + idempotency | Đây là phần các công cụ hiện có làm yếu nhất và cũng là phần có giá trị học tập lâu dài nhất. |
| Role/model cấu hình được, chính sách đóng băng theo task | Hợp lý. Nên hiểu "đóng băng" là đóng băng **cả thang nâng cấp đã duyệt**, không phải cấm nâng: được nâng theo nấc khai báo trước, trigger bằng code, nấc đắt thì cần duyệt (mục 5.4). |
| Context tối thiểu theo role | Đây là đòn bẩy token lớn nhất sau việc bỏ Primary. |
| CLI-first, tương tác với AI bên ngoài | Đúng: CLI có output `--json` là giao diện rẻ token nhất và hợp với mọi harness. |
| Quality gates bằng shell command | Bắt buộc. Gate do orchestrator chạy là nguồn sự thật, không tin lời agent "đã test xong". |

### 1.2 Những chỗ đang thiết kế quá phức tạp

1. **Event sourcing "thuần".** Bạn không cần rebuild state từ event mỗi lần đọc, cũng không cần CQRS framework. Dùng *event log append-only + projection cập nhật trong cùng transaction* (gọi là "event-sourced lite"). Bạn vẫn học được event sourcing bằng một lệnh `cusr admin verify-projections` rebuild projection từ event và so sánh, nhưng runtime đơn giản hơn nhiều. **[SL]**
2. **11 trạng thái task.** Danh sách hiện tại trộn trạng thái *task* với trạng thái *bước* và *attempt*. `WAITING_REVIEW` không phải trạng thái: review là một bước. `RETRYING` là thuộc tính của attempt. `BLOCKED` do dependency là giá trị suy ra. Đề xuất:
   - `task.status ∈ {PENDING, READY, RUNNING, WAITING, DONE, FAILED, CANCELLED}`
   - `task.wait_reason` cho biết vì sao task chưa chạy hoặc đang dừng. Tài liệu viết gọn là `PENDING(<lý do>)` / `WAITING(<lý do>)`:
     - Khi `PENDING` (chưa bắt đầu, chưa có worktree): `confirmation | needs_info | dependency`.
     - Khi `WAITING` (đã chạy, dừng giữa chừng): `human_input | approval | ci | rate_limit | policy | infra`. Với `approval`, trường `approval_kind` ghi rõ loại duyệt (`merge`, `escalation`, …).
   - `task.current_step` + `attempt.status`
   - Sự kiện thô từ kênh nguồn *trước khi* thành task nằm trong bảng `source_events` (mục 8.2), không phải một trạng thái task.

   Đây là bộ trạng thái duy nhất dùng trong toàn tài liệu.
   
   Ít trạng thái hơn thì state machine dễ chứng minh đúng hơn và dễ test hơn.
3. **`when_use` kiểu `condition: insufficient_context`.** Code không thể tự đánh giá "thiếu context". Nếu cố làm, bạn sẽ lặng lẽ đưa một LLM router trở lại, tức chính Primary mà bạn muốn bỏ. Cách tách lại ở mục 5.
4. **Cấu hình mọi thứ khi tạo từng task.** Nên dùng *profile* (preset), và chỉ override khi thật sự cần. Với hàng chục task mỗi feature, cấu hình từng task sẽ thành gánh nặng.
5. **Scout là một bước thường trực.** Coding agent hiện đại tự khảo sát repo trong lúc code. Scout riêng chỉ nên là bước opt-in, khi Planner đánh dấu hoặc Coder trả về `needs_context`. **[SL]**
6. **Tài nguyên đặc thù (device/emulator, browser E2E), remote worker, dashboard** phải nằm ngoài v1. Bạn đã tự nhận ra điều này, giữ nguyên quyết định đó.

### 1.3 Những chỗ đang bị đánh giá thấp (rủi ro thật)

1. **Kích thước task do người giao không cố định.** Có việc rất nhỏ, có yêu cầu quá to cho một PR. v1 coi **mỗi task là 1 branch và 1 PR**. Yêu cầu lớn được đánh dấu `type: epic` và tách thành task con qua *một* lần chạy `planner`, có bạn duyệt (mục 8.4). Không tách ngầm. **[SL]**
2. **Mức song song thực tế thấp hơn bạn nghĩ.** Ở hầu hết project, nhiều task cùng chạm một nhóm nhỏ *file điểm nóng*: manifest và lockfile phụ thuộc (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `build.gradle.kts`…), file đăng ký trung tâm (router, DI container, registry, barrel export), migration DB và cấu hình chung. Chạy song song sẽ tạo merge conflict. Cần có file-ownership hint (project khai báo `hotspots`, mục 5.2b), tuần tự hóa theo vùng file, và một bước `rebase` có giới hạn. **[SL]**
3. **Nút thắt thật là rate limit của subscription, không phải token.** Khi dùng gói Claude/ChatGPT, thứ khan hiếm là cửa sổ giới hạn sử dụng. Scheduler phải biết từng harness đang bị limit để tạm dừng và hẹn giờ thử lại, thay vì đánh FAILED hàng loạt. **[SL]**
4. **Agent tuyên bố xong nhưng chưa làm đúng.** Gate do orchestrator chạy, cùng output có schema (verdict review dạng JSON), là tuyến phòng thủ. Không bao giờ chuyển trạng thái chỉ dựa trên văn bản tự do của agent.
5. **Quyền hạn và bảo mật.** Chạy agent không người giám sát với quyền cao trong worktree là rủi ro thật: secrets, `git push --force`, xoá file ngoài worktree. Cần quy định tối thiểu: agent không có quyền push hay merge (orchestrator làm), sandbox của harness bật khi có thể, và sau v1 thì chạy dưới user riêng hoặc container.
6. **Base branch di chuyển.** Khi task phụ thuộc nhau, cần chiến lược branch rõ ràng (mục 8.5). Nếu không, phần lớn thời gian sẽ đi vào xử lý conflict.

---

## 2. Build vs Buy vs Extend

### 2.1 Phương pháp
Ngày 2026-10-26 tôi shallow-clone 6 repo và phân tích **mã nguồn**, không chỉ README, theo cùng một bộ tiêu chí lấy từ 9 yêu cầu của bạn. Mọi khẳng định được gắn nhãn [XM-code] / [XM-docs] / [SL]. Tôi đã **tự kiểm tra lại** các khẳng định ảnh hưởng nhiều nhất đến quyết định (đánh dấu ✔ trong bảng 2.3).

| Repo | Commit | Ngày |
|---|---|---|
| open-mercato/cezar | `f6b910f` | 2026-10-25 |
| chernistry/bernstein | `fbb01b5` | 2026-10-26 |
| paperclipai/paperclip | `1fbbef4` | 2026-10-25 |
| ComposioHQ/agent-orchestrator | `d98dfa0` | 2026-10-26 |
| openai/symphony | `be10a1b` | 2026-09-15 |
| kunchenguid/firstmate (đối chiếu) | `127f0f3` | 2026-10-25 |

### 2.2 Bảng so sánh theo yêu cầu của bạn

| Tiêu chí | Cezar | Bernstein | Paperclip | Agent Orchestrator | Symphony | Firstmate |
|---|---|---|---|---|---|---|
| Ngôn ngữ / license | TS / MIT | Python 3.12 / Apache-2.0 | TS / MIT | **Go + Electron** (đã viết lại, không còn là TS monorepo) / Apache-2.0 | SPEC + Elixir / Apache-2.0 | bash / MIT |
| Khả năng tách phần bạn cần | Thấp: engine nằm trong một class điều phối lớn, gắn chặt với server/SPA | Thấp: tick loop và task store đan xen, nhiều module không được nối | Trung bình cho adapter (chỉ phụ thuộc `adapter-utils`), thấp cho engine | Thấp: workflow không tồn tại, session manager là lõi | Cao: SPEC tách bạch, runner là một module | Thấp: logic nằm trong bash và prompt |
| Ai quyết định bước tiếp theo | **Code** (graph walk). LLM chỉ chọn nhánh qua marker verdict. "Dispatch" (agent tự tạo task con) **bật mặc định** | Chủ yếu code. LLM "manager review" nằm trong tick loop (mặc định tắt). Goal mode dùng manager agent | **LLM** (agent tự nhận việc và tự đặt trạng thái) | **LLM worker** tự làm theo prompt; daemon chỉ "nudge" | Một agent làm tất cả theo prompt | **LLM Primary** |
| Workflow khai báo + vòng lặp có giới hạn | **Có**: graph v2 với `loop{max}`, `github.wait-ci`, `gate.human`, kiểm tra tĩnh chu trình ✔ | Có schema, nhưng agent node **hỏng khi chạy từ CLI** ✔. DSL cũ có condition edge thì **không được thực thi** ✔ | Chỉ có stage review/approval (`maxReviewRounds`) | Không có. Reaction viết cứng trong Go | Không | Không (giao cho pipeline ngoài) |
| Role/model theo bước | Theo node | Theo step | Theo agent | worker / reviewer | Toàn cục | Rule `when/use` do **LLM** so khớp |
| Policy đóng băng; chỉ nâng model theo thang đã duyệt | ✗ (dispatch cho agent chọn model) | ✗ (retry tự leo lên Opus) | ✗ (có auto-fallback) | ✗ | ✗ | ✗ |
| DAG giữa các task | ✗ | ✔ | ✔ (`blocks`) | ✗ | Qua blocker của tracker | Backlog do LLM quản |
| Lưu trữ | JSON + NDJSON (debounce 1s) | JSONL + WAL hash-chain | **Postgres** (embedded) ✔ | **SQLite** | **RAM** ✔ | File |
| Recovery | Tiếp tục tại node, resume session | Kill rồi chạy lại từ đầu | Rất mạnh (pid/pgid, boot-id lease) | Gắn lại PTY host, không tự relaunch | Dựng lại từ tracker | Đối chiếu với tmux |
| Idempotency side effect | Nhận lại PR đã có. Comment **không** guard | ✗ | ✗ (agent tự push/PR) | Merge guard theo head SHA. PR do agent tạo | Agent tự lo | Script merge có guard |
| Claude / Codex / Pi | ✔ stream-json / ✔ app-server / ✔ rpc | ✔ / ✔ exec / yếu | ✔ ACP / ✔ ACP / ✔ json | ✔ / ✔ / ✔ (TUI + hook) | ✗ / ✔ / ✗ | ✔ / ✔ / ✔ (TUI) |
| Nguồn task | Automation từ GitHub issue/PR, Jira/Linear, hộp todo | File plan YAML, parser backlog | Issue nội bộ + Slack/Discord/Teams/Telegram/GitHub bot | Tracker intake, chỉ đọc một chiều | Tracker (Linear, GitHub, GitLab, Jira, Asana), chỉ đọc; agent tự ghi | Backlog markdown do Primary quản |
| HITL bất đồng bộ | Chỉ trong cockpit | Không có WAITING_INPUT | ✔ (Slack/Discord…) | Push notification | Qua trạng thái tracker | Bộ status verb |
| Giao diện cho AI bên ngoài | HTTP ~336 route, không auth, không MCP | MCP 25 tool, HTTP, 214 lệnh CLI | REST, CLI, MCP ~45 tool | HTTP/OpenAPI, CLI `--json`, SKILL.md | HTTP status | — |
| Bus factor / tốc độ thay đổi | ~1 / rất cao | 1 / cực cao | ? / cực cao | đang đổi chủ / cực cao | OpenAI / thấp (prototype) | ~1 / cực cao |
| **Kết luận** | Học ý tưởng; **Plan B** làm executor | Học ý tưởng | Học ý tưởng | Học ý tưởng | **Dùng SPEC làm tài liệu tham chiếu** | Học ý tưởng |

### 2.3 Đã xác minh hay suy luận: những khẳng định quyết định

| Khẳng định | Trạng thái |
|---|---|
| `bernstein workflow run` dựng `WorkflowRunner` không có spawner, nên mọi agent node báo "requires a configured AgentSpawner" | ✔ `cli/commands/workflow_cmd.py:500,589`, `core/workflows/workflow_runner.py:363,982` |
| `DAGExecutor` của Bernstein không được khởi tạo ngoài test | ✔ grep `src/` không thấy |
| Bernstein tự leo thang model khi retry | [XM-code bởi tác tử phân tích] `task_lifecycle.py:408-496`, tôi chưa tự đọc |
| Cezar có graph workflow với `loop`, `github.wait-ci`, `gate.human`, `ask-user` | ✔ `workflows/graph.ts`. Engine thực thi nằm trong class `RunManager` của `workflows/run.ts` ✔ |
| Cezar bật "dispatch" mặc định, cho agent chọn runner/model con | [XM-code bởi tác tử] `run.ts:2700-2825` |
| Agent Orchestrator đã viết lại bằng Go | ✔ 2.163 file `.go` trong `backend/` |
| Paperclip chỉ chạy Postgres | ✔ `packages/db/package.json`: `drizzle-orm`, `embedded-postgres` |
| Symphony không có persistence, bản Elixir "evaluation only" | ✔ grep không thấy ets/dets/sqlite/File.write. `elixir/README.md:7-8` |
| Firstmate Primary xử lý mọi wake "actionable" trong một hội thoại dài; watcher bash không tốn token | [XM-code/docs bởi tác tử] `AGENTS.md:270-287`, `bin/fm-watch.sh` |

### 2.4 Đánh giá ba hướng

**B. Fork/custom một công cụ có sẵn: loại.**
- **Bernstein**: trên giấy tờ gần nhất ("deterministic, no LLM in the loop"). Mã nguồn thực tế thì khác:
  - Workflow có vòng lặp không chạy được.
  - Recovery là "kill rồi chạy lại từ đầu".
  - Không có ledger side effect.
  - Retry tự leo thang model.
  - Hàng trăm module không được nối vào luồng chính. Chính repo có allowlist 307 module không tới được.

  Sửa ba lỗ hổng lớn cần tính bằng tháng.
- **Paperclip**: triết lý ngược với bạn, LLM quyết định luồng. Chỉ chạy Postgres. Hai đường runtime (legacy và native) chạy song song gần như ở mọi nơi, nên rất khó chèn một step engine xác định vào.
- **Agent Orchestrator**: không có workflow engine. Phản hồi CI/review đều dồn vào *một* session ngày càng dài, đúng nguyên nhân tốn token mà bạn muốn tránh. Đã chuyển sang Go và desktop.
- **Cezar**: engine graph gần thiết kế đề xuất nhất. Nhưng toàn bộ thực thi, recovery và side effect dồn vào một class `RunManager` (chính tài liệu của repo thừa nhận có hai handler gần trùng nhau trong đó), state là JSON ghi debounce, phiên bản thay đổi theo tuần, và bus factor khoảng 1. Fork sẽ phân kỳ khỏi upstream ngay lập tức.
- **Symphony**: không có gì để fork (prototype, chỉ Codex). Giá trị nằm ở SPEC.

**C. Lớp điều phối mỏng trên runtime có sẵn: đánh giá hai biến thể.**
- *C1. Durable-execution framework* (Temporal, DBOS, Restate):
  - Temporal cần server riêng và code workflow phải deterministic để replay.
  - DBOS bản TypeScript cần Postgres; SQLite mới chỉ có ở bản Go **[XM-docs]**.
  - Workflow của bạn có ít bước, mỗi bước dài và là process bên ngoài, nên state machine trên SQLite + outbox đủ dùng và minh bạch hơn.
  
  **Loại khỏi v1.** Học khái niệm của chúng, rồi tự cài lại (mục 6).
- *C2. Dùng Cezar làm executor*: phần của bạn lo nguồn task, DAG, policy và SQLite, rồi sinh workflow YAML cho mỗi task và gọi `POST /runs` của Cezar.
  - **Ưu**: có ngay vòng review/CI có giới hạn, adapter cho Claude, Codex và Pi, worktree, ghi nhận token.
  - **Nhược**:
    - Độ tin cậy state (JSON debounce 1s; comment không idempotent) mâu thuẫn với ưu tiên #4 của bạn.
    - API không auth và thay đổi nhanh.
    - Phải tắt dispatch (`CEZ_DISPATCH=0`) để giữ policy.
    - Mất phần học tập cốt lõi.
  
  **Không chọn làm hướng chính, giữ làm Plan B.**

**A′. Tự xây lõi nhỏ, spec-first, mượn có chủ đích: chọn.**
Ba điểm khác biệt của bạn không công cụ nào có: policy đóng băng kèm thang nâng model đã duyệt, ledger side effect, và nguồn task đa kênh đồng bộ hai chiều về một format trong DB. Phần chung (gọi CLI, poll `gh`, worktree) thì đã có tài liệu và mã tham chiếu tốt để học theo.

### 2.5 Bản đồ "mượn có chủ đích"

Copy được (license MIT/Apache), nhưng **copy ý tưởng và hợp đồng, không copy cả module**.

| Bạn cần | Học từ | File |
|---|---|---|
| Kiểm tra tĩnh "mọi chu trình phải đi qua `loop{max}`", mô hình port/edge | Cezar | `packages/cezar/src/workflows/graph.ts` (`advance()`, cycle validation) |
| Argv cho Claude/Codex/Pi, parse stream | Cezar, Paperclip | `core/claude-cli-runner.ts`, `core/pi-runner.ts`, `core/codex-app-server-runner.ts`; `packages/adapters/{claude,codex,pi}-local/src/server/{execute,parse}.ts` |
| Hợp đồng kết quả adapter (usage basis, `errorFamily`: quota / transient / config / refusal) | Paperclip | `packages/adapter-utils/src/types.ts` |
| Process group, SIGTERM rồi SIGKILL, lưu pid/pgid | Paperclip | `packages/adapter-utils/src/server-utils.ts` |
| Quyền sở hữu run theo boot-id/lease; "pid còn sống nhưng mất handle" thì xử lý là *detached*, không retry mù | Paperclip | `server/src/services/heartbeat/recovery.ts` |
| Dọn process mồ côi bằng env marker (`CEZ_TASK_ID` trong `/proc/*/environ`) | Cezar | `core/task-processes.ts`. Dùng `CUSR_ATTEMPT_ID` tương tự |
| Probe thất bại không có nghĩa là process đã chết; circuit breaker khi "chết hàng loạt" | Agent Orchestrator | `backend/internal/observe/reaper/reaper.go` |
| Merge guard theo head SHA, không retry sau khi phía remote đã thành công | Agent Orchestrator | `backend/internal/service/pr/action_service.go` |
| Nhận lại PR đã tồn tại thay vì tạo trùng | Cezar | `server/forge/github.ts` (`existingPrUrl`) |
| Connector nguồn task dạng "kernel chỉ đọc" (`fetch_issues_by_states`, `fetch_issues_by_ids`) và tách quyền ghi khỏi connector | Symphony | `SPEC.md` §11 |
| Ánh xạ sự kiện GitHub/tracker + bộ lọc label thành việc cần chạy | Cezar | `packages/cezar/src/automations/types.ts` |
| Câu hỏi gửi qua kênh chat dưới dạng form, trả lời đánh thức lại task | Paperclip | `server/src/services/chat-question-forms.ts` |
| Định dạng log-tail CI gửi cho fixer; dedup theo chữ ký check lỗi | Agent Orchestrator | `backend/internal/lifecycle/reactions.go` |
| Nhận diện usage limit, parse thời điểm reset, tự resume | Cezar | `core/usage-limit.ts`, `runs/failure-kind.ts` |
| Bảng chuyển trạng thái FSM có guard; WAL fsync có hash-chain | Bernstein | `core/tasks/lifecycle.py`, `core/persistence/wal.py` |
| "Một lần LLM soạn plan → người duyệt → compile deterministic thành task graph" | Bernstein | `sdd/spec_pipeline/` |
| Reviewer chỉ nhận diff (có giới hạn kích thước), khác vendor với coder | Bernstein | `quality/cross_model_verifier.py` |
| Claim/retry/reconcile, stall detection, quy tắc an toàn workspace, ngữ nghĩa hook, cách tính token | Symphony | `SPEC.md` §7, §8.4–8.5, §9.4–9.5, §13.5 |
| Hình dạng rule `when/use/default/approval/min_confidence`; bộ status verb; "chờ thì không tốn lượt" | Firstmate | `docs/examples/crew-dispatch.json`, `AGENTS.md`, `bin/fm-brief.sh` |
| **Phản mẫu cần tránh** | Bernstein (tự leo thang model khi retry), AO (nudge vào cùng một session), Firstmate (LLM làm event handler), Symphony (retry không giới hạn) | — |

**Nhận xét tổng quát** **[SL]**:
- Cả năm công cụ đều lớn lên rất nhanh nhờ AI sinh code, và đều mang chi phí hiểu và bảo trì rất cao.
- 3 trong 5 vẫn để LLM quyết định luồng.
- Engine thật sự deterministic duy nhất (Cezar) lại hội tụ về đúng mô hình đề xuất ở đây: graph khai báo, vòng lặp có giới hạn được kiểm tra tĩnh, poll CI bằng code. Đó là bằng chứng hướng đi đúng.
- Lĩnh vực chưa hội tụ. Một lõi nhỏ mà bạn hiểu trọn vẹn là tài sản bền hơn bất kỳ fork nào.

---

## 3. Kiến trúc đề xuất

### 3.1 Nguyên tắc nền

> **Workflow là dữ liệu, engine là code thuần, agent là một "hàm" đắt tiền có side effect.**

- *Functional core, imperative shell*: toàn bộ logic quyết định là hàm thuần `decide(state, trigger) → (events, commands)`. Mọi I/O (spawn agent, git, gh, shell) nằm ở effect executor.
- *Single writer*: một daemon `cusrd` duy nhất ghi SQLite. CLI và các assistant gửi lệnh qua daemon, hoặc ghi "command request" vào DB để daemon xử lý.
- *Agent process sống độc lập với daemon*: daemon chết thì agent vẫn chạy tiếp, daemon khởi động lại thì gắn vào lại. Đây là chìa khoá của recovery.

### 3.2 Sơ đồ

```text
  External assistants (Claude Code / Codex / Pi / Paseo trên iPhone)
        │  `cusr … --json` + SKILL.md     (MCP wrapper: giai đoạn 2)
        ▼
┌────────────────────────────── cusrd (daemon, single writer) ────────────────────────────────┐
│ Application Services: TaskManager · Intake (source connectors) · PolicyResolver · Query    │
│        │                                                                                    │
│        ▼                                                                                    │
│ Workflow Engine (pure)  decide(state, trigger) → {events, commands}   evolve(state, event)  │
│        │                                                                                    │
│ Scheduler: ready-queue · DAG · resource pools · rate-limit cooldown · durable timers        │
│        │                                                                                    │
│ Effect Executor (transactional outbox, idempotency key, probe-before-act)                   │
│   ├─ AgentRunner port ─► adapters: claude │ codex │ pi │ fake │ (acp – sau)                 │
│   ├─ GateRunner (shell)        ├─ Git/Worktree port      ├─ GitHub port (gh CLI)            │
│   └─ Notifier port (Telegram / GitHub comment)                                              │
│ Recovery Manager (reconcile khi khởi động)                                                  │
│ State Store: SQLite WAL — events · projections · effects(outbox) · timers · artifacts       │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
        │ spawn detached (setsid)                         ▲ tail events.jsonl / đọc exit.json
        ▼                                                 │
  cusr-runner  (1 process/attempt, tuỳ chọn trong tmux) ───┘──► harness CLI chạy trong worktree
```

### 3.3 Từng module

#### Task Manager
- **Thực thể:** `Task` theo format chuẩn (mục 8.2). Một task có thể thuộc một `group` hoặc `parent`, và có `TaskLink` trỏ tới mục tương ứng ở kênh nguồn (issue, form, agent). `Attempt` là một lần chạy một bước. `Effect` là một side effect. Ngoài ra có `Question` và `Artifact` (review findings, gate log, CI log, diff stat).
- **Trách nhiệm:** tạo, sửa, huỷ task. Quản lý dependency và kiểm tra không có chu trình. Gán profile. Validate bằng schema (zod).
- **Không làm:** quyết định luồng (việc của Workflow Engine).

#### Workflow Engine (trái tim, thuần, không I/O)
```ts
type Trigger =
  | { kind: 'start' } | { kind: 'effect_result'; effectId: string; outcome: Outcome; data?: unknown }
  | { kind: 'timer'; timerId: string } | { kind: 'human'; action: 'answer'|'approve'|'reject'|'retry'|'cancel'; payload?: unknown };

type Command =
  | { kind: 'start_agent'; step: string; role: string; binding: ResolvedBinding; contextPacket: string[] }
  | { kind: 'run_gate'; step: string; commands: string[] }
  | { kind: 'git_push' } | { kind: 'create_pr' } | { kind: 'await_ci'; pollEvery: string }
  | { kind: 'request_approval'; gate: string } | { kind: 'merge' } | { kind: 'ask_human'; questionId: string }
  | { kind: 'notify'; message: string };

function decide(task: TaskState, wf: WorkflowDef, policy: FrozenPolicy, t: Trigger): { events: DomainEvent[]; commands: Command[] };
function evolve(task: TaskState, e: DomainEvent): TaskState;
```
- Mọi bất biến nằm ở đây: `max_visits` cho từng bước, `max_agent_runs` cho từng task, deadline, policy guard (mọi `start_agent` đều phải qua `assertAllowed(policy, binding)`).
- Vì là code thuần, có thể test bằng bảng kịch bản và property-based test (mục 11).

#### Scheduler
- Vòng lặp hướng sự kiện. Nó thức dậy khi effect hoàn tất, khi timer đến hạn, khi có lệnh CLI, hoặc khi một dependency xong. Không có polling tốn token; chỉ còn polling CI bằng `gh`, và việc đó tốn 0 token.
- **Resource pools**: mỗi bước khai báo `uses: [claude]` hoặc `uses: [codex, build]`. Pool có sức chứa, ví dụ `claude: 2, codex: 2, build: 1`. Project tự khai báo thêm pool cho tài nguyên khan hiếm của nó (`emulator: 1`, `browser: 2`, `test_db: 1`…). Engine chỉ đếm slot, không cần biết pool đó là gì.
- **Rate-limit cooldown**: khi adapter phân loại kết quả là `rate_limited`, pool của harness đó bị khoá đến `reset_at`. Task chuyển `WAITING(rate_limit)` và được hẹn timer. Không tính là một lần retry thất bại.
- **Durable timers**: bảng `timers(due_at, task_id, kind)`, ví dụ lần poll CI kế tiếp hay stall check. Timer sống qua restart.

#### Role/Model Policy
- *Role catalog* (toàn cục) + *Profile* (preset) + *override khi tạo task* → **FrozenPolicy** (JSON đã resolve đầy đủ + sha256 + commit hash của file cấu hình), lưu bất biến trong task.
- Mọi thay đổi sau đó là event `PolicyAmended{actor: human}`. Engine từ chối mọi binding nằm ngoài policy, và task chuyển `WAITING(policy)`.
- **Nâng model giữa chừng** chỉ đi theo *escalation ladder* đã nằm trong FrozenPolicy: nấc tự động, nấc cần duyệt, hoặc nấc bị cấm (mục 5.4).
- Chi tiết ở mục 5.

#### Agent Runner Adapters
Adapter được thiết kế **thuần và nhỏ**: chỉ dựng argv và parse dòng output. Quản lý process thuộc về runner shim dùng chung.
```ts
interface HarnessAdapter {
  id: string;                                          // 'claude' | 'codex' | 'pi' | 'fake'
  build(req: AgentRequest): Invocation;                // argv, env, cwd, stdin
  resume?(sessionId: string, req: AgentRequest): Invocation;
  parseLine(line: string): NormalizedEvent | null;     // → started | text | tool | usage | session | result | error
  classify(exitCode: number | null, tail: NormalizedEvent[]): Outcome; // ok | failed | rate_limited | auth_error | timeout | crashed
}
```
- **Hợp đồng kết quả qua file, không qua văn bản tự do**: mỗi prompt yêu cầu agent ghi `.cusr/out/result.json` theo JSON schema của role (ví dụ reviewer: `{verdict, findings[]}`). Orchestrator validate bằng zod; sai schema thì có đúng 1 lần "repair" ngắn, sau đó tính là `failed`. Hợp đồng file độc lập với harness. Harness nào có structured output thì dùng thêm làm lớp bảo đảm thứ hai: Codex `--output-schema` và Claude Code `--json-schema` **[XM-docs]**.
- Adapter chỉ làm hai việc: dựng lệnh và parse output. Process, timeout và retry nằm ở runner dùng chung. Test adapter bằng *fixture JSONL ghi lại từ CLI thật* (mục 11).

#### State Store (SQLite, WAL, `better-sqlite3`)
```sql
events    (id INTEGER PRIMARY KEY, task_id TEXT, seq INT, type TEXT, payload JSON, actor TEXT, created_at TEXT,
           UNIQUE(task_id, seq));
tasks     (id TEXT PRIMARY KEY, group_id TEXT, parent_id TEXT, spec JSON, title TEXT, workflow_id TEXT, workflow_hash TEXT,
           policy JSON, policy_hash TEXT, status TEXT, wait_reason TEXT, current_step TEXT,
           step_visits JSON, branch TEXT, worktree TEXT, base_sha TEXT, checkpoint_sha TEXT,
           pr_number INT, version INT);                 -- optimistic concurrency
task_deps (task_id TEXT, depends_on TEXT, PRIMARY KEY(task_id, depends_on));
attempts  (id TEXT PRIMARY KEY, task_id TEXT, step TEXT, n INT, role TEXT, harness TEXT, model TEXT,
           session_id TEXT, pid INT, pid_start_ticks INT, run_dir TEXT, log_offset INT,
           status TEXT, outcome TEXT, started_at TEXT, ended_at TEXT, usage JSON, cost_usd REAL);
effects   (id TEXT PRIMARY KEY, task_id TEXT, attempt_id TEXT, kind TEXT, idem_key TEXT UNIQUE,
           safety TEXT CHECK (safety IN ('pure','probe','unsafe')), status TEXT, request JSON,
           result JSON, tries INT, next_at TEXT);
questions (id TEXT PRIMARY KEY, task_id TEXT, attempt_id TEXT, body TEXT, channel_ref TEXT,
           status TEXT, answer TEXT, answered_by TEXT, answered_at TEXT);
artifacts (id TEXT PRIMARY KEY, task_id TEXT, attempt_id TEXT, kind TEXT, path TEXT, summary JSON);
timers    (id TEXT PRIMARY KEY, task_id TEXT, due_at TEXT, kind TEXT, payload JSON);
-- source_events, task_links, task_messages: xem mục 8.2
```
**Quy tắc vàng:** một trigger được xử lý trong *một* transaction. Transaction đó append events, cập nhật projection `tasks`, chèn các `effects` mới (outbox) và timers. Effect executor chỉ đọc outbox *sau khi* commit.

#### Event Log
- Event có cấu trúc: `TaskCreated`, `PolicyFrozen`, `StepEntered`, `AttemptStarted`, `AttemptFinished`, `GatePassed/Failed`, `ReviewVerdict`, `QuestionAsked/Answered`, `EffectStarted/Succeeded/Failed`, `PrOpened`, `CiResult`, `ApprovalGranted`, `PolicyAmended`, `TaskCompleted/Failed/Cancelled`.
- Event là nguồn cho `cusr task history T012`, cho báo cáo token và cho mọi câu hỏi "vì sao", và việc đọc nó không cần LLM.

#### Recovery Manager
Chạy mỗi lần `cusrd` khởi động, trước scheduler. Thuật toán ở mục 6.

#### Worktree Manager: mỗi task một worktree riêng

**Quy tắc bắt buộc:**
1. **1 task = 1 worktree = 1 branch.**
   - Orchestrator tạo (không phải agent) khi task bắt đầu, từ `base_sha` đã đóng băng.
   - Đường dẫn: `~/.cusr/worktrees/<repo>/<task_id>`.
   - Branch: `cusr/<task_id>-<slug>`.
2. **Mọi bước của cùng một task dùng chung worktree đó, và chạy tuần tự:** coder, gate, fixer, reviewer, ci_fix, decider.
   - Có khoá theo worktree. Không bao giờ có hai agent cùng *ghi* vào một worktree.
   - Reviewer, scout và decider chạy ở chế độ chỉ đọc.
3. **Hai task khác nhau không bao giờ dùng chung worktree.** Song song chỉ xảy ra *giữa* các task, mỗi task trong worktree của nó.
4. **Agent bị giới hạn trong worktree:**
   - Kiểm tra cwd trước khi spawn.
   - Sandbox của harness chỉ cho ghi trong worktree (Codex `workspace-write`; Claude dùng deny rules cho đường dẫn ngoài worktree).
   - Đối chiếu `git status` của repo gốc trước và sau mỗi attempt. Repo gốc bị thay đổi thì attempt fail và báo động.
5. **Không dùng tính năng worktree riêng của harness** (ví dụ `claude --worktree`). Orchestrator phải tự quản vòng đời worktree để recovery biết chính xác worktree nào thuộc task nào.
6. **Thư mục `.cusr/`** (context, out) nằm trong worktree nhưng được loại trừ qua `.git/info/exclude`, nên không bao giờ bị commit.
7. **Task tích hợp của nhóm** (nếu dùng integration branch, mục 8.9) cũng có worktree riêng.

**Vòng đời và recovery:**
- **Tạo là thao tác idempotent.** Nếu worktree đã tồn tại và đúng branch thì dùng lại.
- **Khi khởi động lại**, đối chiếu từng worktree trong DB với đĩa: còn tồn tại không, `HEAD` có khớp `checkpoint_sha` không. Worktree bị mất thì tạo lại từ branch hoặc checkpoint.
- **Dọn dẹp** sau khi task DONE và PR đã merge (giữ lại N ngày, cấu hình được). **Không bao giờ xoá** worktree còn thay đổi chưa commit hoặc commit chưa push; những worktree đó được chuyển vào `preserved/`. Chạy `git worktree prune` định kỳ.
- **Tài nguyên:** cache build/dependency dùng chung giữa các worktree, tuỳ toolchain (`~/.npm`, `~/.cache/pip`, `~/.cargo`, `~/.gradle`…). Lệnh `setup` của project (ví dụ `npm ci`) chạy một lần khi tạo worktree. Số build chạy đồng thời bị giới hạn bằng pool `build` của scheduler. Có giới hạn dung lượng đĩa cho toàn bộ worktree; vượt ngưỡng thì ngừng tạo task mới.

#### GitHub Integration
- Dùng **`gh` CLI** qua một port (`GitHubPort`) thay vì Octokit. Lý do: tận dụng auth sẵn có, output `--json` ổn định, ít code. Có thể đổi sang Octokit sau mà không ảnh hưởng engine.
- Thao tác: `pr create` (có marker), `pr checks`/`run list` (poll có backoff 30s → 5 phút), `run view --log-failed` (lấy log lỗi CI cho CI Fixer), `pr merge` (chỉ sau approval gắn với head SHA), comment có marker `<!-- cusr:<idem_key> -->`.
- Webhook để sau (cần endpoint công khai, ví dụ Tailscale Funnel). Polling CI bằng code không tốn token, và với một người dùng thì quota API của GitHub dư sức.

#### External Assistant Interface
- **Hợp đồng chính là CLI có `--json`** + một file `SKILL.md`/`AGENTS.md` ngắn mô tả lệnh. Mọi harness đọc được file này. Nó cũng rẻ token hơn MCP, vì schema của tool MCP nằm trong context của assistant ở mọi lượt. **[SL]**
- **MCP server** (giai đoạn 2) là lớp vỏ mỏng, khoảng 10 tool, gọi chung application service với CLI.
- Truy vấn trả **bản tóm tắt tính sẵn** chứ không phải log thô: `cusr group status customer-management --json`, `cusr task explain T012 --json` (lỗi cuối, 40 dòng cuối của gate/CI log, findings review gần nhất). Bản tóm tắt được dựng bằng code, không cần LLM.
- **Phân quyền 3 mức** (theo token hoặc theo kênh):
  - `read`: status, logs, history.
  - `operate`: tạo task (task do agent tạo cần xác nhận, mục 8.3), retry, trả lời câu hỏi, huỷ.
  - `admin`: sửa policy, duyệt merge vào `main` (khi yolo tắt), bật/tắt yolo. Mức này phải do người thật xác nhận qua TTY, nút duyệt Telegram (đúng `chat_id` của bạn) hoặc GitHub approval.

---

## 4. Agent lifecycle

### 4.1 So sánh cơ chế

| Cơ chế | Ưu | Nhược | Kết luận |
|---|---|---|---|
| **Headless CLI subprocess** (`claude -p … stream-json`, `codex exec --json`, `pi --mode json/rpc`) | Hợp đồng ổn định nhất, dùng auth/subscription có sẵn, output có cấu trúc, mỗi bước một session mới | Ít điều khiển giữa chừng (steer) | **Chọn cho v1** |
| tmux + send-keys | Người xem trực tiếp được | Phải scrape terminal để biết trạng thái, dễ vỡ, khó parse kết quả | Chỉ dùng làm *viewer* tuỳ chọn |
| ACP (Agent Client Protocol) | Giao thức chung editor↔agent, schema v1 đã ổn định **[XM-docs, nguồn thứ cấp]** | Claude/Codex/Pi cần adapter cầu nối bên thứ ba. Thiết kế cho phiên tương tác có hỏi quyền, không cho batch | Viết adapter sau, khi thật cần |
| SDK in-process (Claude Agent SDK, Codex SDK, `AgentSession` của Pi) | Hook, approval và structured output đầy đủ | Agent sống chung process với orchestrator nên crash kéo theo nhau. SDK đổi phiên bản nhanh | Không dùng làm nền. Có thể chạy *bên trong runner shim* nếu cần tính năng riêng |
| Codex app-server (JSON-RPC) | Phong phú nhất cho Codex (thread, turn, steer, interrupt, approval) **[XM-docs]** | Chỉ cho Codex. Tài liệu chính thức khuyên dùng Codex SDK cho job tự động/CI **[XM-docs]** | Không cần cho v1 |

**Các repo đã chọn gì** [XM-code, theo báo cáo phân tích]:

| Repo | Claude | Codex | Pi |
|---|---|---|---|
| Cezar | `--print`, stream-json vào/ra | app-server | `--mode rpc` |
| Paperclip | **ACP** mặc định (qua `acpx`, `claude-agent-acp`), CLI làm fallback | **ACP** mặc định (`codex-acp`), CLI làm fallback | `--mode json -p` |
| Bernstein | `claude -p` stream-json | `codex exec --json` | |
| Agent Orchestrator, Firstmate | TUI tương tác trong PTY/tmux + hook để biết trạng thái | | |
| Symphony | | Chỉ Codex app-server | |

Kết luận: **headless stream/JSON là mẫu số chung**. TUI cộng hook là nguồn gốc của "wedge/stale wake" cần LLM kiểm tra (Firstmate). ACP đã được dùng thật làm đường mặc định (Paperclip), nên adapter ACP ở giai đoạn sau là lựa chọn có cơ sở chứ không phải đặt cược.

### 4.2 Thiết kế đề xuất: *runner shim tách rời + hợp đồng file*

```text
run_dir = ~/.cusr/runs/<attempt_id>/
  invocation.json   # argv/env đã che secrets, harness, model, policy_hash
  pid               # pid + start_ticks (/proc/<pid>/stat trường 22) để chống tái sử dụng PID
  events.jsonl      # output gốc của harness (stdout), append
  stderr.log
  liveness          # shim tự cập nhật định kỳ (vd. 15s), KHÔNG phụ thuộc output của agent
  progress.json     # tín hiệu tiến triển: output mới, CPU time của cây process, file đổi trong worktree, process con đang chạy
  exit.json         # {exit_code, signal, ended_at} – ghi bởi shim khi harness kết thúc
  out/result.json   # (trong worktree: .cusr/out/result.json) – kết quả có schema của agent
```

- `cusrd` spawn `cusr-runner <attempt_id>` với `detached: true` (`setsid`) và stdio trỏ vào file. Shim spawn harness, chuyển tiếp output, ghi `exit.json` theo cách nguyên tử, rồi thoát. Shim chỉ làm đúng việc đó.
- `cusrd` tail `events.jsonl` từ `log_offset` đã lưu, parse qua `adapter.parseLine`, và lưu `session_id`/`usage` vào `attempts`.
- **Ba tín hiệu tách biệt.** Thiếu log không có nghĩa là process đã chết: một lệnh build hoặc một test suite lớn có thể chạy nhiều phút mà không in gì.
  - **Liveness**: shim còn sống và process con còn tồn tại. Shim tự cập nhật file `liveness` theo chu kỳ.
  - **Progress**: có *bất kỳ* dấu hiệu tiến triển nào. Đó có thể là output mới, CPU time của cả cây process tăng, file trong worktree thay đổi, hoặc có process con (compiler, test runner, build daemon) đang chạy và dùng CPU.
  - **Wall timeout**: tổng thời gian tối đa của bước.
- **Stall** nghĩa là *không có tín hiệu progress nào* trong `stall_timeout`. `stall_timeout` cấu hình riêng theo bước (ví dụ bước có build dài thì 20 phút). Khi stall hoặc quá `wall_timeout`: `kill(-pgid, SIGTERM)`, chờ 10 giây, rồi `SIGKILL`. Liveness mất mà không có `exit.json` thì attempt là `lost` (mục 6), không phải stall.
- **Xem trực tiếp:** `cusr task logs T012 -f` render `events.jsonl` dạng dễ đọc. Tuỳ chọn `runner.tmux: true` chạy shim trong `tmux new-session -d -s cusr-T012-code-1` để `cusr task attach T012`.

### 4.3 Từng harness

| Harness | Lệnh đề xuất | Resume | Token | Mức tin cậy |
|---|---|---|---|---|
| Claude Code | `claude -p "<prompt>" --output-format stream-json --verbose --model <alias> --session-id <uuid> --permission-mode acceptEdits\|dontAsk\|bypassPermissions --tools "Bash,Read,Edit,…" --disallowedTools "Bash(git push *)" --max-turns N --max-budget-usd X --json-schema <schema> --append-system-prompt-file role.md` | `--resume <id>` (thêm `--fork-session` nếu muốn tách nhánh) | thông điệp `result` cuối có usage/cost **[CKC: trường cụ thể]** | Tất cả cờ trong cột lệnh **[XM-docs, CLI reference 2026-10]**. `--json-schema` cho structured output (chỉ ở print mode). `--bare` bỏ qua hook, skill, MCP và CLAUDE.md để khởi động nhanh và ít context. Nhưng nếu dùng `--bare` bạn phải tự đưa conventions vào, vì CLAUDE.md của repo sẽ bị bỏ qua |
| Codex CLI | `codex exec --json --sandbox workspace-write --output-schema <file> -o <file> [model flag] "<prompt>"` | `codex exec resume <SESSION_ID>` | `turn.completed.usage` (input, cached, output, reasoning) | **[XM-docs]**. Lưu ý tài liệu hiện ghi `--full-auto` *không còn được hỗ trợ*, thay bằng `--approve-for-me`. Đây là ví dụ thực tế cho việc cờ CLI thay đổi. Cờ chọn model không có trên trang đó, cần **[CKC]** |
| Pi | `pi --mode rpc` (JSONL stdin/stdout: `prompt`, `abort`, `get_session_stats`; event `agent_start/agent_end`, `tool_execution_*`) hoặc chế độ print/json cho one-shot | `switch_session <file>`; `--session-dir` | `get_session_stats` có token và cost | **[XM-docs, bản mirror npm `@earendil-works/pi-coding-agent`]**. Phải tách dòng chỉ theo `\n` |

**Quyết định:** v1 dùng adapter cho Claude và Codex. Pi để giai đoạn 2. Hợp đồng RPC của Pi rõ ràng nên adapter rẻ, nhưng để đạt chuẩn tin cậy, nó vẫn cần fixture và fault test riêng.

### 4.4 Subscription và tính hợp lệ

- Trang hỗ trợ của Anthropic (cập nhật 2026-10-07) nói thuê bao Pro/Max vẫn dùng được Agent SDK, `claude -p` và ứng dụng bên thứ ba trong giới hạn của gói. Gói Max/Team có thêm credit API hằng tháng. Thay đổi tách quota dự kiến ngày 15/06/2026 đã bị *tạm dừng*. Theo các nguồn thứ cấp, sản phẩm hay dịch vụ phân phối cho người khác thì phải dùng API key. **[XM-docs + thứ cấp]**
- Codex `exec` mặc định dùng lại auth đã lưu của CLI, bao gồm đăng nhập ChatGPT. **[XM-docs]**
- **Hệ quả kiến trúc:** công cụ dùng cá nhân thì hợp lệ *hiện tại*, nhưng chính sách này đã thay đổi 2 lần trong năm 2026. Vì vậy auth là cấu hình của từng harness (`auth: subscription | api_key`), và scheduler phải xử lý rate limit như một trạng thái bình thường. **[SL]**

### 4.5 Câu hỏi từ agent giữa chừng
- v1: agent ghi `result.json` với `status: "needs_input"` và `questions: [...]`, rồi kết thúc lượt. Task chuyển `WAITING(human_input)`. Khi có câu trả lời, bước tiếp theo chạy `resume(session_id)` với prompt "Câu trả lời: …". Nếu harness không resume được thì chạy session mới với context packet cộng thêm Q&A.
- Giai đoạn 2: cung cấp tool MCP `orch_ask_human` cho agent. Agent gọi thì nhận về "đã ghi nhận, hãy kết thúc lượt", nên cơ chế phía sau không đổi.

### 4.6 Môi trường
Orchestrator, worktree và harness đều chạy **trên Linux** (native hoặc WSL2/Ubuntu). Với WSL2, đặt repo và worktree trên filesystem ext4 (`~/work/...`), không đặt ở `/mnt/c`, vì build tool và git trên `/mnt/c` chậm hơn nhiều. Không hỗ trợ Windows native: process group, `setsid` và tmux đều là tính năng POSIX. macOS để sau v1, vì không có `/proc` nên phải thay cách đọc pid/start time và env marker. **[SL]**

---

## 5. Workflow configuration và `when_use`

### 5.1 Tách `when_use` thành ba cơ chế rõ ràng

| Loại điều kiện | Ví dụ của bạn | Nơi xử lý | Ai quyết định |
|---|---|---|---|
| Thuộc tính task (dữ liệu) | `task_type: implementation` | `binding.when` trong role, `when` trong step | Code |
| Sự kiện workflow | `event: code_completed`, `event: ci_failed` | **Transition của workflow**, không đặt trong role | Code |
| Phán đoán | `insufficient_context`, `complex_repository_analysis` | Biến thành **tín hiệu**: (a) người giao hoặc bước triage gắn flag cho task, hoặc (b) agent đang chạy trả outcome `needs_context` | LLM, nhưng *trong một bước đang chạy*, không tốn thêm lời gọi router |

`when_use` dạng văn bản vẫn được giữ, nhưng chỉ để **AI planner hoặc assistant bên ngoài đọc** khi đề xuất plan. Code không bao giờ diễn giải nó.

**Firstmate thực ra làm thế nào** [XM-code/docs]: cơ chế tương đương là `config/crew-dispatch.json` với `rules: [{when, use: [{harness, model, effort}], why, approval, min_confidence}]` và `default`. `when` là ngôn ngữ tự nhiên, và **chính Primary LLM so khớp** rule ("shell scripts do not match the natural-language rules"). Đây là một trong những chỗ tiêu tốn token. Có tuỳ chọn gửi brief cho một classifier rẻ (OpenRouter) với ngưỡng `min_confidence`.

**Giữ hình dạng đó nhưng đổi chỗ chạy:**
1. So khớp deterministic trước, theo `task_type`, `size` và `label`.
2. Chỉ khi task được *tạo* mà không khớp rule nào mới gọi một classifier rẻ, **một lần**, có `min_confidence`. Dưới ngưỡng thì hỏi bạn.
3. Kết quả được ghi vào FrozenPolicy. Không bao giờ phân loại lại ở từng bước.

### 5.2 Cấu hình mẫu

Để dễ đọc, ví dụ dưới gộp chung một file. Thực tế cấu hình tách làm hai: phần của người dùng ở `~/.cusr/config.yaml` (harness, model, role, workflow, profile) và phần của từng repo ở `cusr.yaml` (gate, setup, pool riêng…), xem mục 5.2b.

```yaml
version: 1

harnesses:
  claude: { cmd: claude, auth: subscription, pool: claude }
  codex:  { cmd: codex,  auth: subscription, pool: codex }
  pi:     { cmd: pi,     auth: api_key,      pool: pi }

pools: { claude: 2, codex: 2, pi: 1, build: 1 }

models:              # alias → harness + id thật + tier để policy so sánh
  haiku:  { harness: claude, id: haiku,  tier: 1 }
  sonnet: { harness: claude, id: sonnet, tier: 2 }
  opus:   { harness: claude, id: opus,   tier: 3 }
  sol:    { harness: codex,  id: "<codex-model-id>", tier: 2 }

roles:
  coder:
    when_use: "Implement một task; bugfix."   # chỉ cho AI planner/assistant đọc
    prompt: prompts/coder.md
    context: [task_brief, attachment_excerpts, conventions, file_hints]   # task_brief dựng từ bản ghi task chuẩn
    output_schema: schemas/coder.json        # {status: done|needs_input|needs_context|blocked, summary, questions?}
    binding:                                  # chọn deterministic: rule đầu tiên khớp
      - when: { size: [L, XL] }
        model: opus
      - model: sonnet
    limits: { max_turns: 80, stall_timeout: 10m, wall_timeout: 45m }
  reviewer:
    prompt: prompts/reviewer.md
    context: [task_brief, acceptance, diff, conventions]
    output_schema: schemas/review.json       # {verdict: approve|request_changes, findings: [{severity, file, line, msg}]}
    permissions: read_only
    binding: [{ model: sol }]
  fixer:
    prompt: prompts/fixer.md
    context: [findings_or_gate_log, diff_stat, task_brief]
    session: resume_from_step_role_if_same_harness    # tận dụng session của coder nếu cùng harness
    binding: [{ model: sonnet }]
  # Không có role ci_fixer riêng: bước ci_fix dùng lại role coder (resume session nếu cùng harness).
  # Chỉ tách role riêng khi có lý do, ví dụ muốn dùng model rẻ hơn cho lỗi lint/format.
  scout:
    prompt: prompts/scout.md
    output_schema: schemas/scout.json        # ghi .cusr/context/scout.md để bước sau dùng
    permissions: read_only
    binding: [{ model: sol }]

gates:               # thuộc cusr.yaml của project (mục 5.2b); ví dụ cho một project TypeScript
  build:      "npm run build"
  unit:       "npm test"
  lint:       "npm run lint"
  format_fix: "npm run format"   # gate tự sửa, dùng ở bước ci_autofix

workflows:
  impl:
    start: scout
    steps:
      scout:      { kind: agent, role: scout, when: { flag: needs_scout }, max_visits: 1, next: { ok: code } }
      code:       { kind: agent, role: coder, uses: [claude],
                    next: { done: gates, needs_input: ask, needs_context: scout, failed: retry } }
      gates:      { kind: gate, run: [build, unit, lint], uses: [build],
                    next: { pass: review, fail: fix_gates } }
      fix_gates:  { kind: agent, role: fixer, max_visits: 3, on_exhausted: escalate, next: { done: gates } }
      review:     { kind: agent, role: reviewer, skip_when: { size: [XS] },
                    next: { approve: push, request_changes: fix_review } }
      fix_review: { kind: agent, role: fixer, max_visits: 2, on_exhausted: escalate, next: { done: gates } }
      push:       { kind: action, action: git.push, next: { ok: pr } }
      pr:         { kind: action, action: github.create_pr, next: { ok: ci } }
      ci:         { kind: wait, for: github.checks, poll: 60s, timeout: 60m,
                    next: { pass: merge_gate, fail: ci_triage, timeout: escalate } }
      rerun_ci:   { kind: action, action: github.rerun_failed, max_visits: 2, next: { ok: ci } }
      ci_triage:  { kind: classify, rules: ci_rules,           # code: phân loại lỗi CI trước khi gọi agent
                    next: { flaky_or_infra: rerun_ci, autofix: ci_autofix, code: ci_fix } }
      ci_autofix: { kind: gate, run: [format_fix], next: { pass: push, fail: ci_fix } }   # formatter của project
      ci_fix:     { kind: agent, role: coder, session: resume_coder_if_same_harness,      # chính agent code tự sửa
                    context: [ci_failure_excerpt, diff_stat], max_visits: 3, on_exhausted: escalate,
                    next: { done: gates } }                    # sửa xong chạy lại gate local rồi mới push
      merge_gate: { kind: approval, auto_when: { target_branch: "feature/*" },   # merge vào feature branch: tự động
                    next: { approved: merge, rejected: cancel } }
      merge:      { kind: action, action: github.merge, next: { ok: done } }

profiles:
  standard:
    workflow: impl
    allow_roles: [scout, coder, reviewer, fixer]
    allow_models: [sonnet, sol, haiku]       # opus không nằm trong đây → rule size L/XL bị loại NGAY LÚC TẠO TASK, rơi xuống rule kế tiếp (sonnet)
    budgets: { max_agent_runs: 12, max_wall: 6h, max_cost_usd: 20 }
    on_policy_violation: wait_human          # hoặc fallback_to_default_binding
  heavy:
    extends: standard
    allow_models: [sonnet, sol, opus]
```

Ghi chú thiết kế:
- **Ngôn ngữ điều kiện có chủ đích rất hạn chế.** Chỉ có các predicate cố định (`flag`, `size`, `label`, `task_type`, `attempt_gte`, `target_branch`), không có `eval`. Ngôn ngữ biểu thức tổng quát là con đường dẫn đến workflow không kiểm chứng được.
- **Outcome là enum đóng** theo từng `kind`. Engine kiểm tra lúc load rằng mọi outcome đều có transition và mọi vòng lặp đều có `max_visits`. Workflow có chu trình mà không có giới hạn sẽ bị từ chối lúc load. Đây là cách chặn vòng lặp vô hạn *một cách tĩnh*.
- `escalate` = `WAITING(human_input)` kèm bản tóm tắt tự động. `retry` = attempt mới cùng bước, có backoff, tính vào `max_agent_runs`.

**Kiểm tra binding ngay lúc tạo task, không đợi tới giữa workflow.** Khi resolve FrozenPolicy, mọi binding của mọi bước được đối chiếu với `allow_models`:
- Binding hợp lệ: dùng binding đó.
- Binding bị loại: thử rule kế tiếp trong `binding` (rule cuối cùng đóng vai trò fallback).
- Không còn rule hợp lệ nào: task **không được tạo**. Bạn được hỏi ngay (đổi profile, cho phép model đó, hoặc chọn binding khác).

Vì vậy một task đã READY thì chắc chắn chạy được toàn bộ workflow với policy của nó. `WAITING(policy)` giữa chừng chỉ còn xảy ra với nấc nâng model cần duyệt.

### 5.2b Cấu hình theo project: engine không biết ngôn ngữ hay toolchain

Cuesura dùng cho mọi project, ở bất kỳ ngôn ngữ nào. Engine, scheduler và policy không chứa kiến thức gì về ngôn ngữ hay build tool. Mọi thứ đặc thù của một repo nằm trong file `cusr.yaml` ở gốc repo đó:

| Mục | Ý nghĩa | Ví dụ |
|---|---|---|
| `setup` | Lệnh chạy một lần khi tạo worktree | `npm ci`, `uv sync`, `go mod download` |
| `gates` | Lệnh shell, exit 0 là pass | build, test, lint, typecheck |
| `autofix` | Gate tự sửa, không cần agent | `prettier --write`, `ruff format`, `cargo fmt` |
| `log_digest` | Rule lọc log gate/CI thành bản tóm tắt lỗi (mục 7.1) | Regex giữ dòng lỗi, test fail, stacktrace đầu tiên |
| `signature` | Cách tính chữ ký lỗi (mục 5.4.1) | Tên test fail, dòng lỗi đầu tiên đã chuẩn hoá |
| `ci_rules` | Phân loại lỗi CI thành `flaky_or_infra`, `autofix` hoặc `code` | Theo tên job, pattern trong log |
| `pools` | Tài nguyên khan hiếm riêng của project | `emulator: 1`, `test_db: 1` |
| `hotspots` | File điểm nóng hay gây conflict (mục 1.3) | Lockfile, router, migration |
| `conventions` | File conventions đưa vào context packet | `AGENTS.md`, `CONTRIBUTING.md` |

**Toolchain pack.** Là preset dạng dữ liệu YAML, không phải code, cho các hệ sinh thái phổ biến (`node`, `python`, `go`, `rust`, `jvm`…). Pack cung cấp giá trị mặc định cho `setup`, `log_digest`, `signature` và `ci_rules`. Project khai báo `extends: [node]` rồi override những gì cần. Không có pack phù hợp thì dùng digest chung: N dòng cuối của log, cộng các dòng chứa `error`, `fail` hoặc `exception`.

```yaml
# cusr.yaml ở gốc repo
version: 1
extends: [node]                  # toolchain pack, tuỳ chọn
setup: "npm ci"
gates:
  build: "npm run build"
  unit:  "npm test"
  lint:  "npm run lint"
autofix:
  format_fix: "npm run format"
pools: { e2e_browser: 1 }
hotspots: [package.json, package-lock.json, src/routes.ts, "migrations/**"]
conventions: [AGENTS.md, docs/conventions.md]
profile: standard                # profile mặc định cho task của repo này
```

Quy tắc:
- **Phân chia rõ:** `~/.cusr/config.yaml` giữ những gì thuộc về *người dùng* (harness, model, role, workflow, profile, pool của harness). `cusr.yaml` giữ những gì thuộc về *repo*.
- **Đóng băng:** `cusr.yaml` được đọc tại `base_sha` lúc task bắt đầu, và đóng băng vào FrozenPolicy cùng `workflow_hash`. Agent sửa `cusr.yaml` trong branch của task không ảnh hưởng task đang chạy. PR có thay đổi `cusr.yaml` được gắn cờ để reviewer và bạn thấy rõ (ví dụ một gate bị đổi thành `true`).
- **Gate thiếu:** workflow dùng tên gate logic (`build`, `unit`, `lint`). Gate nào project không khai báo thì bị bỏ qua, và việc đó được ghi vào FrozenPolicy để biết task đã được kiểm tra bằng những gì. Project không có gate nào thì profile phải cho phép rõ ràng (`allow_no_gates: true`), vì khi đó chỉ còn review làm tuyến phòng thủ.
- **Repo mới:** `cusr init` phát hiện manifest (`package.json` → pack `node`, `pyproject.toml` → `python`…), đề xuất `cusr.yaml`, và bạn xác nhận trước khi giao task cho repo đó.

### 5.3 Đóng băng policy và chống tự thay đổi
1. `cusr task create --profile standard --set roles.reviewer.binding=sol` → resolve ra **FrozenPolicy** gồm workflow đã expand, binding đã resolve, budgets, `config_sha`, `workflow_hash` và `git rev-parse HEAD` của file cấu hình. Ghi event `PolicyFrozen`.
2. Engine chỉ đọc FrozenPolicy, **không đọc lại file cấu hình** cho task đang chạy. Sửa `cusr.yaml` chỉ ảnh hưởng task mới.
3. Agent không có kênh nào để đổi workflow. Nó chỉ trả outcome trong enum. Đề xuất tự do (ví dụ "nên dùng Opus") được lưu vào `suggestions` để người xem, engine không thực thi. Nếu policy bật `trust_agent_signal`, tín hiệu `needs_stronger_model` chỉ có thể kích hoạt **nấc kế tiếp trong thang đã duyệt** (mục 5.4).
4. Assistant bên ngoài có thể *đề xuất* `PolicyAmendment`, nhưng áp dụng thì cần `admin` (người xác nhận). Mọi amendment là event có `actor`, `reason`, `diff`.

### 5.4 Nâng model có kiểm soát (escalation ladder)

**"Đóng băng" áp dụng cho *thang nâng cấp*, không phải cho một model duy nhất.** Orchestrator được phép nâng, với năm điều kiện:
1. Chỉ theo các nấc đã khai báo và đã resolve vào FrozenPolicy lúc task bắt đầu.
2. Chỉ khi trigger là **outcome về chất lượng** xác định bằng code: gate fail, review reject, hoặc tín hiệu của agent nếu được phép.
3. Trong giới hạn số lần nâng và ngân sách.
4. Nấc vượt ngưỡng tier phải có người duyệt.
5. Mỗi lần nâng là một event có lý do.

Vì sao nên có: thất bại lặp ở cùng một bước với cùng model thường là cùng một kiểu lỗi. Lần nào cũng dừng để hỏi người thì mất tính tự động. **[SL]**

**Các hướng nâng, từ rẻ đến đắt.** Thang nên đi theo thứ tự này:

| Nấc | Ví dụ | Hợp lý khi |
|---|---|---|
| 1. Tăng effort/reasoning | sonnet medium → sonnet high | Lỗi logic, test fail lặp lại |
| 2. Tăng context | Thêm bước scout, đưa nguyên section tài liệu tham chiếu | Agent trả `needs_context`, hoặc lỗi do hiểu sai yêu cầu |
| 3. Model mạnh hơn (cùng harness) | sonnet → opus | Nấc 1–2 không giúp |
| 4. Đổi vendor ("ý kiến thứ hai") | Claude → Codex | Lỗi lặp cùng một kiểu. Model khác có điểm mù khác |
| 5. Người | `WAITING(human_input)` kèm hồ sơ thất bại | Hết thang |

```yaml
roles:
  coder:
    binding: [{ model: sonnet, effort: medium }]          # nấc 0
    escalation:
      ladder:
        - { effort: high }                                 # nấc 1: cùng model
        - { add_context: [scout_report, reference_full] }  # nấc 2: nâng context
        - { model: opus, effort: high }                    # nấc 3: model mạnh hơn
      triggers:                                            # CHỈ outcome chất lượng
        - { outcome: gate_failed,     after: 2 }           # 2 lần thất bại ở nấc hiện tại
        - { outcome: review_rejected, after: 2 }
        - { outcome: agent_signal, signal: needs_stronger_model, after: 1 }  # chỉ khi trust_agent_signal
      scope: step                    # step: chỉ nâng nấc của bước này | task: đồng thời đẩy sàn của task lên nấc này
      handoff: fresh_with_dossier    # fresh_with_dossier | resume (chỉ hợp lý khi chỉ tăng effort)
      workspace: keep                # keep | reset_to_checkpoint

profiles:
  standard:
    allow_models: [haiku, sonnet, sol]
    escalation:
      enabled: true
      auto_up_to_tier: 2             # nấc ≤ tier 2: tự động
      above: ask_human               # nấc > tier 2 (vd. opus): chờ duyệt | deny
      max_escalations_per_task: 2
      reserve_budget_usd: 5          # phần ngân sách dành riêng cho nấc nâng
      trust_agent_signal: false
  heavy:
    extends: standard
    allow_models: [haiku, sonnet, sol, opus]
    escalation: { auto_up_to_tier: 3 }
```

#### 5.4.1 Quy tắc chuyển nấc mặc định: thất bại bao nhiêu lần thì làm gì

**Bước 1: phân loại thất bại.** Việc này do code làm. Chỉ lớp `quality` và `invalid_output` mới được tính vào việc nâng nấc.

| Lớp thất bại | Ví dụ | Xử lý | Có nâng nấc không |
|---|---|---|---|
| `rate_limited` | Hết quota subscription | Khoá pool harness tới `reset_at`, task chuyển `WAITING(rate_limit)`. Không tính là lần thử | Không |
| `infra` | Crash, mạng, `gh` 5xx, process bị kill | Retry cùng nấc, backoff mũ, tối đa 3 lần. Hết lượt thì chờ người | Không |
| `auth_error` | Phiên đăng nhập hết hạn | Chờ người ngay | Không |
| `timeout` / `stall` | Quá `wall_timeout`, hoặc không có output | Retry cùng nấc 1 lần. Lần 2 thường nghĩa là task quá to, nên chuyển thành điểm quyết định "tách task / cho thêm thời gian" (mục 5.5) | Không |
| `invalid_output` | `result.json` sai schema | 1 lần nhắc sửa trong cùng session, rồi 1 lần chạy session mới. Vẫn sai thì nâng 1 nấc | Có |
| `quality` | Gate fail, review reject, CI fail do code | Theo quy tắc chữ ký lỗi bên dưới | Có |

**Bước 2: quy tắc chữ ký lỗi cho lớp `quality`.**

Mỗi thất bại có một *chữ ký* do code tính, ví dụ:
- Tên test fail.
- Dòng lỗi biên dịch đầu tiên (đã chuẩn hoá).
- File và loại của findings review.

Xử lý theo chữ ký:
- **Lần fail đầu tiên ở một nấc:** chạy lại cùng nấc, kèm log lỗi đã lọc.
- **Lần fail thứ hai cùng chữ ký:** agent đang lặp lại cùng một lỗi, chạy tiếp cùng nấc vô ích. **Nâng ngay 1 nấc.**
- **Lần fail thứ hai khác chữ ký:** agent đang tiến triển (sửa xong lỗi cũ, gặp lỗi mới). Cho thêm **1 lần** ở cùng nấc.
- **Mỗi nấc tối đa 3 lần thử.** Quá số đó thì nâng nấc, dù chữ ký có khác.
- **Đã tăng effort mà chữ ký không đổi:** **nhảy thẳng** sang nấc model mạnh hơn, bỏ qua các nấc cùng model còn lại.

**Bước 3: thang mặc định theo role.**

| Role | Nấc 0 | Nấc 1 | Nấc 2 | Nấc 3 | Hết thang |
|---|---|---|---|---|---|
| coder / fixer (sửa gate, review, CI) | sonnet, effort medium | sonnet, effort high | opus, effort high (*cần duyệt* ở profile `standard`) | Đổi vendor: codex, effort high, session mới kèm hồ sơ thất bại | Điểm quyết định `loop_exhausted` (mục 5.5) |
| reviewer | sol, effort medium | sol, effort high (chỉ khi `invalid_output`) | — | — | Bỏ review, chờ người |
| scout | sol, effort medium | sol, effort high | — | — | Chạy tiếp mà không có báo cáo scout |
| decider | opus, effort high | — | — | — | Chờ người |

Lưu ý: review *reject* không phải thất bại của reviewer. Đó là thất bại `quality` của coder.

**Bước 4: nấc lưu theo từng bước và không bao giờ giảm.**

"Không hạ nấc trong task" và "bước mới bắt đầu từ nấc 0" không mâu thuẫn, vì nấc được tính trên **thang riêng của từng bước**, không phải một nấc chung cho cả task:
- **Mỗi bước agent trong một task có thang riêng.** Trạng thái lưu theo cặp `(task, step)`: `rung` (nấc hiện tại), `tries_at_rung`, `last_signature`. Hai bước khác nhau, ví dụ `fix_gates` và `fix_review`, không dùng chung nấc.
- **"Không hạ nấc" nghĩa là `rung` của một cặp `(task, step)` chỉ tăng hoặc giữ nguyên trong suốt đời task.**
  - Bước chạy lần đầu bắt đầu ở sàn của task (mặc định nấc 0). Đây không phải hạ nấc, vì đó là thang của một bước khác.
  - Workflow quay lại một bước đã từng nâng (ví dụ CI fail lần hai, quay lại `ci_fix`) thì bước đó chạy tiếp ở nấc đã đạt, không về 0.
- **Thất bại `quality` được tính cho bước agent sửa code gần nhất** trước lần kiểm tra fail (gate, review hoặc CI). Bước đó được coi là "qua" khi lần kiểm tra kế tiếp pass. Khi đó `tries_at_rung` và `last_signature` được reset, còn `rung` giữ nguyên.
- **Sàn của task (`floor`) cũng chỉ tăng.**
  - Task đã phải nâng ở 2 bước khác nhau thì được gắn cờ `hard`, và sàn lên 1.
  - Với `scope: task`, mỗi lần nâng ở bất kỳ bước nào cũng đẩy sàn lên nấc đó.
  - Mỗi lần chạy, bước dùng nấc `max(rung, floor)`.
- **Duyệt gắn với `(task, step, rung)`.** Nấc đã được duyệt cho một bước thì quay lại bước đó không phải duyệt lại, nhưng vẫn qua kiểm tra ngân sách ở Bước 5. Nếu sàn kéo một bước *khác* lên nấc cần duyệt, bước đó vẫn phải được duyệt riêng.
- **Runtime không có thao tác hạ nấc.** Hạ binding mặc định cho task *sau* là việc của bạn, dựa trên `cusr report escalations` (tỉ lệ nâng và tỉ lệ nâng xong thì qua).

**Bước 5: kiểm tra trước mỗi lần nâng.**
1. Nấc kế tiếp có trong thang đã đóng băng không.
2. `max_escalations_per_task` còn lượt không.
3. Ước tính chi phí của nấc (trung bình token của bước đó trong lịch sử × giá) có vượt ngân sách còn lại không. Vượt thì chuyển thành điểm quyết định `escalation_approval`.
4. Ghi event `EscalationApplied{from, to, failure_class, signature, attempt}`.

**Ví dụ hành trình của bước `fix_gates`**, với `max_visits: 7`, loader kiểm tra tổng ngưỡng của thang nằm trong giới hạn này:

```text
#1 sonnet/medium  → fail  test: CustomerRepoTest.search   (sig A)
#2 sonnet/medium  → fail  sig A (lặp lại)                  → nâng nấc 1
#3 sonnet/high    → fail  sig A                            → effort không giúp, nhảy sang nấc 2
   opus/high cần duyệt → điểm quyết định escalation_approval (mode agent_if_confident → decider đồng ý, conf 0.8)
#4 opus/high      → fail  compile error ở file khác (sig B, đang tiến triển) → cho thêm 1 lần
#5 opus/high      → pass  → fix_gates giữ nấc 2: nếu workflow quay lại fix_gates, nó chạy tiếp ở opus/high (đã duyệt)
                            fix_review, ci_fix… dùng thang riêng, bắt đầu từ nấc 0 (task chưa bị gắn cờ hard: mới có 1 bước phải nâng)
```

**Resolve lúc đóng băng.** Mỗi nấc được gán `auto`, `needs_approval` hoặc `denied`, rồi lưu vào FrozenPolicy. `cusr task show T012 --policy` hiển thị thang đã resolve, nên bạn biết trước task này *có thể* đi tới đâu.

**Logic trong `decide` (thuần):**
```text
mỗi start_agent cho bước S dùng nấc max(rung[S], floor)          ← không bao giờ thấp hơn
lần kiểm tra trả outcome o; S = bước agent sửa code gần nhất; r = nấc S vừa chạy:
  o ∈ {rate_limited, timeout, crashed, auth_error, infra_error}
      → xử lý như cũ (cooldown/retry); KHÔNG tính vào trigger nâng   ← cố định, không cấu hình được
  o là outcome chất lượng → tries_at_rung[S] += 1, so chữ ký với last_signature[S]
  o là pass               → reset tries_at_rung[S], last_signature[S]; giữ rung[S]
  khớp trigger, còn nấc r+1, escalations < max, đủ ngân sách:
      r+1 = auto           → event EscalationApplied{from, to, trigger, evidence} → start_agent(binding r+1)
      r+1 = needs_approval → WAITING(approval), approval_kind=escalation + hồ sơ thất bại + ước tính chi phí
      r+1 = denied         → bỏ qua nấc đó, xét nấc kế; hết nấc → chờ người
  không khớp → transition bình thường của workflow (vẫn bị chặn bởi max_visits)
```

**Chống vòng lặp.** Thang hữu hạn và số lần thử ở mỗi nấc hữu hạn, nên tổng số attempt có cận trên tính được ngay lúc load. Loader báo lỗi nếu `max_visits` của bước nhỏ hơn tổng ngưỡng của thang, vì khi đó nấc cuối không bao giờ tới được. Nâng model **không bao giờ ngầm kéo dài** `max_visits`.

**Handoff khi nâng.** Mặc định là session mới kèm *hồ sơ thất bại* do code dựng: tóm tắt các attempt trước từ `result.json`, log gate/CI đã lọc, findings của review, và diff hiện tại. Model mạnh hơn nhìn vấn đề "sạch", không bị neo vào hướng đi sai của lần trước, và context cũng nhỏ hơn so với resume. **[SL]**

**Duyệt và đề xuất.**
- Duyệt bằng `cusr task approve T012 --escalation [--scope task]`, hoặc qua kênh thông báo. Ghi event `EscalationApproved{actor: human}`.
- Assistant bên ngoài chỉ được *đề xuất*: `cusr task escalate T012 --to opus --reason …`. Nấc không phải `auto` thì đề xuất luôn thành yêu cầu duyệt.

**Hạ cấp khi model không khả dụng** là chuyện khác với nâng.
- Mặc định `on_unavailable: wait`: cooldown theo rate limit, chờ đến khi model dùng lại được.
- `fallback` sang model thấp hơn chỉ khi khai báo rõ và nằm trong `allow_models`.
- Không hạ model ngầm (như Bernstein `--fallback-model`, Paperclip auto-fallback), vì khi đó kết quả giữa các lần chạy không còn so sánh được.

**Khi nào không nên nâng:**
- Spec mơ hồ: agent trả `needs_input`, phải hỏi người.
- Test flaky: chạy lại gate trước khi tính là thất bại.
- Merge conflict.
- Lỗi hạ tầng.

**Tinh chỉnh bằng dữ liệu.** `cusr report escalations` cho tỉ lệ nâng theo role, *rescue rate* (nâng xong thì qua) và chi phí tăng thêm.
- Coder phải nâng ở hơn 30% task: đổi binding mặc định, thay vì để runtime đoán mãi.
- Rescue rate thấp: nguyên nhân thường là yêu cầu hoặc context chứ không phải model. Đưa nấc context lên trước.

**Phản mẫu đã thấy** [XM-code, theo báo cáo phân tích]:
- Bernstein tự nâng lên opus/max ở mọi retry chưa pin model, kể cả lỗi không liên quan đến chất lượng.
- Cezar cho agent tự chọn model cho task con.

### 5.5 Chế độ quyết định: người quyết hay agent quyết

**Điểm quyết định** là lúc workflow không tự đi tiếp được bằng dữ liệu. Ví dụ:
- Agent hỏi (`needs_input`).
- Task thiếu `acceptance` (`PENDING(needs_info)`).
- Yêu cầu bị sửa khi task đang chạy (`source_drift`).
- Nấc nâng model cần duyệt.
- Hết thang hoặc hết số vòng (`escalate`).
- Merge.

Mỗi *loại* điểm quyết định có một chế độ, cấu hình theo profile và đóng băng cùng FrozenPolicy:

| Chế độ | Hành vi |
|---|---|
| `human` | Task chờ (`WAITING`). Bạn trả lời qua kênh của task |
| `agent` | Role `decider` (model cao) quyết định ngay, ghi lại, task chạy tiếp |
| `agent_review` | Agent quyết định và task chạy tiếp, nhưng quyết định được đăng để bạn xem. Bạn có thể **lật lại** trong một khoảng thời gian; khi đó task quay về checkpoint trước quyết định |
| `agent_if_confident` | Agent quyết định khi `confidence ≥ ngưỡng`, ngược lại chuyển sang `human` |

```yaml
roles:
  decider:
    prompt: prompts/decider.md
    binding: [{ model: opus, effort: high }]     # model cao, gọi hiếm nên chi phí thấp
    permissions: read_only                       # chỉ đọc repo, không sửa code
    output_schema: schemas/decision.json

profiles:
  standard:
    decisions:
      agent_question:   agent_if_confident       # ngưỡng 0.7
      missing_acceptance: agent_review
      source_drift:     human
      escalation_approval: agent_if_confident    # vẫn trong ngân sách của task
      loop_exhausted:   human
      merge_to_main:    human                    # human | auto; auto chỉ có hiệu lực khi repo đang bật yolo (xem dưới)
    decider: { confidence_threshold: 0.7, max_calls_per_task: 3, review_window: 24h }
```

**Decider chạy như thế nào.** Decider không phải Primary AI: code gọi nó **một lần cho mỗi điểm quyết định**, rồi nó kết thúc. Nó nhận một *gói quyết định* do code dựng:
- Câu hỏi và các lựa chọn.
- Yêu cầu task (`acceptance`, `constraints`).
- Bằng chứng liên quan: diff, log đã lọc, findings của review.
- Các quyết định trước đó của cùng task.

Đầu ra theo schema:
```json
{ "choice": "B", "rationale": "…", "confidence": 0.82,
  "assumptions": ["…"], "reversible": true, "follow_up": null }
```

**Ghi lại ở đâu:**
- **SQLite là nơi lưu chính.** Bảng `decisions` gồm `id`, `task_id`, `point_type`, `question`, `options`, `choice`, `rationale`, `confidence`, `decided_by` (`human` hoặc `agent:decider/<model>`), `mode`, `evidence_refs`, `checkpoint_sha`, `status` (`active`, `overturned`), `created_at`. Mỗi quyết định cũng tạo event `DecisionMade` trong event log.
- **Đăng lại vào kênh của task** (ví dụ comment GitHub có marker). Bạn thấy ngay trên điện thoại và trả lời `/cusr overturn D-17 "…"` để lật lại.
- **Đưa vào context của bước sau** qua `task_messages`, để agent làm tiếp theo đúng quyết định.
- Tuỳ chọn: tóm tắt các quyết định vào mô tả PR, để reviewer và bạn thấy *vì sao* code như vậy.
- `cusr decisions list --by agent --since 7d` để rà lại. Báo cáo cho biết tỉ lệ quyết định bị bạn lật lại theo từng loại. Tỉ lệ cao thì chuyển loại đó về `human`.

**Rào chắn:**
- **Không ủy quyền được cho agent**, bất kể cấu hình: sửa policy hoặc thang nâng model, vượt ngân sách task, xoá dữ liệu, thao tác liên quan đến secrets, **merge vào `main`**. Loader từ chối cấu hình đặt các loại này sang `agent`, `agent_review` hoặc `agent_if_confident`.
- **Merge vào `main` có đúng hai chế độ, và không chế độ nào để agent quyết.** Ở đây `main` nghĩa là mọi nhánh trong `protected_branches` của repo, mặc định là nhánh mặc định.

  | Chế độ | Ai cho phép merge | Áp dụng khi |
  |---|---|---|
  | `human` (mặc định) | Bạn duyệt **từng PR**, approval gắn với head SHA | Yolo tắt |
  | `auto` (yolo) | Bạn cho phép **trước, một lần cho cả repo** bằng việc bật yolo. Từng lần merge do **code** quyết khi đủ mọi điều kiện cứng | Yolo đang bật |

  Yolo **không** phải "agent tự merge": decider không tham gia, và không LLM nào quyết định merge. Đó là một approval thường trực do chính bạn cấp, được thực thi bằng kiểm tra tất định. Vì vậy yolo không mâu thuẫn với các quy tắc "merge vào `main` cần người duyệt" ở chỗ khác: người vẫn là bên cho phép, chỉ khác là cho phép trước.
  - **Ai bật:** chỉ bạn, theo từng repo, qua `cusr repo yolo on <repo>` có xác nhận TTY, hoặc qua `~/.cusr/config.yaml`. **Không bật được qua `cusr.yaml` trong repo**, vì agent có thể sửa file đó trong branch. Agent và assistant không bật được. Mọi lần bật/tắt là một event có actor.
  - **Không đóng băng theo task:** yolo là thiết lập của repo, không nằm trong FrozenPolicy, và được đọc *tại thời điểm merge*. Tắt yolo có hiệu lực ngay với mọi task đang chạy.
  - **Điều kiện cứng, kể cả khi yolo:**
    - Required checks xanh trên head đã chứa tip mới nhất của `main` (mục 8.8).
    - Reviewer đã approve, không còn finding mức cao chưa xử lý.
    - Merge được tuần tự hoá.
    - Không có kết quả CI nào ở trạng thái không xác định.
  - **Thiếu bất kỳ điều kiện nào** thì task chuyển `WAITING(approval)`, `approval_kind=merge`, đúng như chế độ `human`. Branch protection trên GitHub yêu cầu review của người thì cũng chặn tự merge theo cách tương tự.
  - **Sau merge:** nếu CI trên `main` đỏ, tự tạo PR revert và báo bạn. Không tự force-push.
- **Merge vào nhánh không được bảo vệ** (integration `group/*`, `feature/*`) tự động khi đủ điều kiện cứng, theo `auto_when` của bước `merge_gate`. Không cần yolo.
- **Decider độc lập với agent đang hỏi:** session mới, chỉ đọc. Nên dùng model hoặc vendor khác với coder.
- **Giới hạn số lần gọi** decider mỗi task. Quyết định có `reversible: false` luôn chuyển sang `human`.
- **Lật lại là thao tác an toàn:** task quay về `checkpoint_sha` của quyết định đó, qua cùng cơ chế recovery và idempotency (mục 6).

---

## 6. Persistence và recovery

### 6.1 Mô hình: state machine trong DB + transactional outbox + probe-before-act

Bạn không cần (và không nên dùng ở v1) một durable-execution engine kiểu replay như Temporal:
- Temporal cần server riêng, và code workflow phải deterministic để replay được. Đây là kiến thức rất đáng học, nhưng là gánh nặng vận hành cho một công cụ cá nhân. **[SL]**
- DBOS Transact bản TypeScript lưu state trong Postgres. Hỗ trợ SQLite hiện mới có ở bản Go. **[XM-docs, blog DBOS]**
- Mỗi bước của workflow này dài hàng phút đến hàng giờ, là process bên ngoài, và số bước ít. Mô hình *bảng trạng thái + outbox + reconcile* minh bạch hơn và đủ dùng. **[SL]**

Để học: đọc khái niệm *activity idempotency, heartbeat, durable timer, saga* của Temporal, rồi tự cài các khái niệm đó trên SQLite. Giữ `Effect` là interface để sau này có thể ánh xạ sang Temporal activity hoặc Restate handler nếu cần.

### 6.2 Phân loại effect và cách chống lặp

| Effect | Lớp an toàn | Idempotency key | Cách kiểm tra trước khi làm lại sau crash |
|---|---|---|---|
| `run_gate` | pure | `task:step:visit` | Chạy lại thoải mái |
| `start_agent` | resumable | `attempt_id` | Có `exit.json` thì ingest kết quả. PID còn sống và `start_ticks` khớp thì gắn lại. Còn lại xem là *lost* |
| `git_commit` (cusr commit sau mỗi bước) | probe | trailer `Orch-Effect: <key>` | `git log --grep` trailer |
| `git_push` | probe | `branch@sha` | `git ls-remote origin <branch>` == sha |
| `create_pr` | probe | `head_branch` | `gh pr list --head <branch> --state all --json number` |
| `post_comment` | probe | marker `<!-- cusr:<key> -->` | tìm marker trong comment |
| `merge` | **unsafe + probe** | `pr#@head_sha` | `gh pr view --json state,mergeCommit`. Approval **gắn với head SHA**: SHA đổi thì approval mất hiệu lực. Không chắc chắn thì chuyển `WAITING(approval)`, không đoán |
| `delete_worktree/branch` | probe | — | kiểm tra tồn tại |

**Giao thức 3 pha cho effect:**
1. Ghi `effects.status = 'started'` (commit).
2. Thực hiện lời gọi bên ngoài.
3. Ghi `succeeded/failed` cùng kết quả, và trigger engine trong một transaction.

Crash giữa 1 và 2: probe không thấy gì, làm lại. Crash giữa 2 và 3: probe thấy kết quả, ghi `succeeded`. Hệ thống là *at-least-once*, nhưng mọi effect có hại đều trở thành *effectively-once* nhờ probe.

### 6.3 Checkpoint bằng git
- Trước mỗi bước agent, ghi `checkpoint_sha = HEAD`. Sau mỗi bước agent thành công, **orchestrator** (không phải agent) commit: `cusr(T012/code#1): …` kèm trailer. Mỗi ranh giới bước vì thế là một commit có thể quay về.
- Attempt *lost* (process chết, không có `exit.json`). Policy theo role:
  - `coder`/`fixer`: nếu có `session_id` thì resume một lần với lời nhắc "bạn bị gián đoạn, kiểm tra `git status` và tiếp tục". Thất bại thì `git reset --hard checkpoint && git clean -fd` và chạy lại attempt mới.
  - `reviewer`/`scout`: luôn chạy lại, vì các bước này chỉ đọc.

### 6.4 Thuật toán khởi động (Recovery Manager)
```text
1. Lấy lock đơn thể hiện (flock ~/.cusr/cusrd.lock). Thất bại thì thoát: đã có daemon khác chạy.
2. Mở SQLite (WAL). Chạy migration. Kiểm tra tính toàn vẹn (PRAGMA quick_check).
3. Với mỗi attempt status=running:
     exit.json có      → ingest output còn lại từ log_offset → tạo trigger effect_result
     pid sống & ticks khớp → re-attach (tail tiếp)
     ngược lại         → outcome=lost → trigger theo policy (resume | reset+rerun)
4. Với mỗi effect status=started (không phải agent): chạy probe tương ứng → succeeded | pending lại
5. Với mỗi timer due_at <= now: phát trigger timer
6. Với task RUNNING mà không có attempt/effect mở: "orphan step" → phát lại command của current_step
   (an toàn vì mọi command đều đi qua outbox có idem_key)
7. Ghi event RecoveryCompleted{summary} → `cusr status` hiển thị những gì đã khôi phục
```

### 6.5 Ba chi tiết nhỏ nhưng quyết định (học từ các repo)
1. **Env marker cho mọi process con**: runner đặt `CUSR_ATTEMPT_ID=<id>` vào env của harness. Khi khởi động, quét `/proc/*/environ` để tìm process mồ côi kể cả khi file `pid` bị mất. Cezar làm đúng như vậy với `CEZ_TASK_ID`.
2. **Quyền sở hữu theo boot-id**: mỗi lần `cusrd` khởi động sinh một `boot_id`, và attempt ghi `owner_boot_id`. Attempt có PID còn sống nhưng thuộc boot cũ thì xử lý là *re-adopt*, không spawn lại. Paperclip dùng boot-id cộng lease cho việc này.
3. **"Probe thất bại" không có nghĩa là "process đã chết"**: không đọc được `/proc` hay `gh` lỗi mạng thì chỉ hoãn, không đánh dấu `lost`. Thêm circuit breaker: nếu hơn 50% attempt cùng lúc bị coi là chết thì dừng lại và báo bạn. Agent Orchestrator có cơ chế này.

### 6.6 Chạy như service
`systemd --user` unit (`cusrd.service`, `Restart=on-failure`) trong WSL2. WSL đã bật systemd thì dùng được, nếu không thì dùng `tmux new -d cusrd`. Cả hai đều ổn vì recovery không phụ thuộc vào cách daemon được khởi động. **[CKC: systemd trong bản WSL của bạn]**

### 6.7 Chi tiết độ bền (bắt buộc cho v1)
- **SQLite**:
  - Cấu hình: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout`, một writer duy nhất. `synchronous=FULL` giữ commit bền kể cả khi mất điện; số lần ghi ít nên chi phí không đáng kể.
  - Chạy `PRAGMA quick_check` lúc khởi động.
  - Backup bằng online backup API hoặc `VACUUM INTO`: định kỳ, và trước mỗi migration.
  - Migration chạy trong transaction và được thử trên bản sao DB thật trước.
- **File của runner**:
  - `exit.json`, `result.json`, `pid` được ghi theo trình tự tmp → fsync → rename → fsync thư mục.
  - Khi đọc `events.jsonl`, bỏ qua dòng cuối chưa trọn (chưa có `\n`) và đọc lại khi có thêm dữ liệu. Lưu `log_offset` sau mỗi lần ingest.
- **Mọi lời gọi ra ngoài** có timeout, retry giới hạn có jitter, và phân loại lỗi `transient | permanent | unknown`. Lỗi `unknown` trên effect nguy hiểm thì chuyển `WAITING(human_input)`, không đoán.
- **Thời gian**:
  - Timeout và stall đo bằng đồng hồ monotonic.
  - Mốc hẹn giờ lưu bằng giờ hệ thống, và phải chịu được đồng hồ nhảy. WSL2 có thể lệch giờ sau khi máy ngủ. **[SL]**
- **Tài nguyên**:
  - Phát hiện đĩa đầy (`ENOSPC`) thì ngừng lập lịch và chuyển `WAITING(infra)`.
  - Giới hạn kích thước log mỗi attempt và xoay vòng log.
- **Watchdog**:
  - Vòng kiểm tra nội bộ.
  - `cusr status --health` trả mã lỗi khác 0 khi có task kẹt hoặc daemon ngừng ghi heartbeat.
  - systemd `Restart=always`.
- **Nâng cấp an toàn**:
  - Task đang chạy gắn với `workflow_hash` và `policy_hash` đã đóng băng.
  - Khi nâng phiên bản `cusr`, kiểm tra tương thích schema event trước khi chạy tiếp. Không tương thích thì từ chối khởi động, thay vì chạy sai.
- **Mặc định an toàn**:
  - Agent không có quyền push hay merge: dùng deny rules của harness, và chỉ orchestrator mới push.
  - Merge vào `main` cần người duyệt từng PR, trừ khi chính bạn bật yolo cho repo đó (mục 5.5). Agent không bao giờ quyết định merge.
  - Kiểm tra cwd của agent nằm trong worktree.
  - Secrets của orchestrator (ví dụ token GitHub) không truyền vào env của agent.

---

## 7. Tối ưu token

### 7.1 Cơ chế

1. **0 token cho điều phối**: mọi transition đều là code. Đây là khoản tiết kiệm lớn nhất so với Firstmate. Ở Firstmate, mỗi wake "actionable" là một lượt trong hội thoại dài của Primary; contract `AGENTS.md` khoảng 7.3k từ cộng khoảng 1.1k từ mô tả skill luôn nằm trong context. Primary còn phải so khớp dispatch rule, kiểm tra pane bị "wedge" và review toàn đội định kỳ. Với Codex, cứ mỗi 180 giây Primary được đánh thức để kiểm tra dù không có sự kiện nào **[XM-code/docs, theo báo cáo phân tích]**.
2. **Session mới cho mỗi bước** theo mặc định. Chỉ resume trong vòng fix ngắn, cùng harness, có `max_visits`, để tận dụng prompt cache mà không làm context phình vô hạn.
3. **Context packet theo role, giao bằng *file* thay vì nhồi vào prompt**: orchestrator ghi `.cusr/context/*.md` trong worktree, prompt chỉ liệt kê đường dẫn và mô tả. Agent tự đọc phần nó cần (lazy loading).

   | Role | Nội dung packet | Cắt giảm bằng code |
   |---|---|---|
   | coder | task brief dựng từ bản ghi task chuẩn (vài trăm từ), trích đoạn theo `attachments`, conventions, file hints | Trích section theo anchor, không đưa toàn bộ tài liệu nguồn |
   | reviewer | brief + acceptance criteria + `git diff base...HEAD` | Diff quá N dòng: chỉ đưa `--stat` kèm danh sách file, agent tự đọc |
   | fixer (sau review) | findings JSON + diff stat | Bỏ findings `severity: nit` nếu policy cho phép |
   | fixer (sau gate) | 1 bản tóm tắt lỗi gate | `log_digest` của project hoặc toolchain pack (mục 5.2b): chỉ giữ dòng lỗi, test fail, stacktrace đầu tiên |
   | ci_fixer | đoạn log lỗi CI (`gh run view --log-failed` → lọc) | Như trên + giới hạn 200 dòng |
4. **Tiền xử lý xác định trước khi gọi LLM**: rất nhiều lỗi CI là lỗi cố định (lint format, dependency resolution, mạng không ổn định). Rule bằng code (`ci_rules` của project) có thể tự sửa bằng gate `autofix` (ví dụ formatter) hoặc tự retry, không cần agent. **[SL]**
5. **Bỏ qua bước theo kích thước**: `skip_when: {size: [XS]}` cho review, vì gates đã đủ cho task rất nhỏ.
6. **Thứ tự prompt ổn định**: role prompt và conventions đặt trước, phần riêng của task đặt cuối, để tối đa hoá prompt cache của harness. **[SL]**
7. **Giới hạn cứng**: `max_turns`, `wall_timeout`, `max_agent_runs`, `max_cost_usd` theo task.
8. **Sổ cái token**: lưu `usage` theo attempt, gồm Claude `result`, Codex `turn.completed.usage` **[XM-docs]** và Pi `get_session_stats` **[XM-docs]**. Lệnh `cusr report tokens --feature F003 --by role,model,step`.

### 7.2 Thước đo (dùng để đánh giá dự án ở mục 12)
Mục tiêu là tối ưu **tổng chi phí để hoàn thành một task được chấp nhận**, không chỉ token. Tất cả chỉ số đều tính bằng code từ event log, không cần LLM, và xuất bằng `cusr report metrics [--group X] [--since 30d] --json`.

**Đơn vị đo:**
- **Task được chấp nhận**: task có PR đã merge và *không bị revert hay mở lại* trong 14 ngày.
- **Nhóm (`group`)**: tổng của các task trong nhóm, cộng task tích hợp nếu có.

| Chỉ số | Định nghĩa | Phát hiện điều gì |
|---|---|---|
| **Token / task được chấp nhận** | Tổng token của mọi attempt, kể cả attempt thất bại, decider và refiner, chia cho số task được chấp nhận. Tách theo role và harness | Tổng tiêu thụ thật |
| **Agent runs / task** | Số lần gọi agent cho mỗi task được chấp nhận | Workflow gọi agent quá nhiều |
| **Wasted runs** | Attempt không đóng góp vào kết quả cuối: fail rồi bị bỏ, bị reset về checkpoint, output sai schema, bị kill vì stall. Tính theo tỉ lệ và theo token | Lãng phí, lý do hàng đầu cần sửa |
| **Time to green** | Từ READY đến lúc CI xanh lần đầu; tách riêng thời gian chờ người và chờ rate limit | Tốc độ, và nút thắt nằm ở đâu |
| **Human interventions / task** | Số lần bạn phải trả lời, duyệt hoặc sửa tay; tách theo loại điểm quyết định | Mức độ tự chủ |
| **First-pass rate** | Tỉ lệ qua gate, review và CI ngay lần đầu, theo từng bước | Chất lượng output của coder |
| **Context size / attempt** | Token input của attempt, phân vị p50 và p95 theo role, cùng xu hướng theo số attempt trong một task | Context phình |
| **Recovery success rate** | Tỉ lệ crash hoặc restart mà task khôi phục đúng, không có side effect trùng | Độ tin cậy trong vận hành thật, bổ sung cho Reliability Gate |
| **Rate-limit wait** | Tổng thời gian và số lần chờ hạn mức gói, theo harness | Hạn mức subscription có phải nút thắt không |
| **Escalation / rescue rate** | Tỉ lệ phải nâng nấc, và tỉ lệ nâng xong thì qua (mục 5.4) | Có nên đổi binding mặc định |
| **Decision overturn rate** | Tỉ lệ quyết định của agent bị bạn lật lại, theo loại (mục 5.5) | Loại quyết định nào nên trả về `human` |
| **Escaped defects** | Task đã merge nhưng bị revert, mở lại, hoặc sinh task bugfix liên quan trong 14 ngày | Chất lượng sau merge, thứ CI và review không bắt được |

`coordination tokens` (token dùng cho việc điều phối) luôn bằng 0 theo thiết kế, vì không có Primary. Nếu khác 0 thì đó là bug. Token mà bạn tiêu khi hỏi assistant bên ngoài được đo riêng.

**Baseline:** chạy *cùng một nhóm task nhỏ* bằng Firstmate và bằng `cusr`, rồi so sánh theo bảng trên. Ít nhất so token / task được chấp nhận, agent runs, time to green và human interventions. Thiếu baseline thì không chứng minh được dự án có tiết kiệm.

---

## 8. Nguồn task và định dạng task chuẩn trong database

**Nguyên tắc:**
- Task là việc *người dùng giao*, qua bất kỳ kênh nào: GitHub, form, agent/assistant, CLI. Orchestrator không quan tâm task được soạn bằng công cụ hay phương pháp gì.
- Mỗi kênh là một **source connector**. Connector nhận yêu cầu, **chuẩn hoá về một format task duy nhất trong SQLite**, và (tuỳ chọn) đồng bộ trạng thái ngược về kênh đó.
- Scheduler lấy task READY từ DB và giao cho agent. Agent chỉ nhận **task brief** dựng từ bản ghi trong DB. Nó không đọc kênh nguồn và không biết nguồn là gì.

### 8.1 Luồng tổng quát

```text
 GitHub issue/comment ─┐
 Form (HTTP)           ├─► source connector ─► source_events (inbox thô, dedup) ─► normalize ─► validate + triage
 Agent / assistant     │     (poll hoặc push)                                                      │
 CLI                  ─┘                                                                            ▼
                                                        tasks (format chuẩn) ──PENDING(needs_info)──► hỏi lại qua đúng kênh
                                                                 │ READY
                                                                 ▼
                                                Scheduler ─► context compiler ─► agent (task_brief.md)
                                                                 │
                                         trạng thái, câu hỏi, kết quả ─► outbox ─► đồng bộ ngược về kênh nguồn
```

### 8.2 Format task chuẩn: một schema cho mọi nguồn

```yaml
schema_version: 1
id: T-0142                                 # id nội bộ của orchestrator
title: "Tìm kiếm khách hàng"
type: implementation                       # implementation | bugfix | refactor | test | docs | research | epic
repo: github.com/you/app
base_branch: main
description: |                             # mô tả tự do của người giao (markdown)
  Người dùng cần xem và tìm kiếm khách hàng…
requirements:                              # có thể rỗng lúc nhận; điền ở bước triage
  - "Trả danh sách khách hàng khớp từ khoá, sắp xếp theo tên"
acceptance:                                # bắt buộc trước khi READY (mục 8.4)
  - "Có test cho: lọc theo từ khoá, kết quả rỗng, lỗi nguồn dữ liệu"
constraints: ["Theo conventions hiện có của repo"]
out_of_scope: ["Phân trang"]
attachments:                               # link hoặc đường dẫn tài liệu/ảnh; chỉ trỏ, không chép
  - { kind: path, value: docs/customer.md, anchor: "#search" }
  - { kind: url,  value: "https://…/design.png" }
group: customer-management                 # tuỳ chọn: nhóm/feature/epic, để truy vấn tiến độ
parent: null                               # task cha, nếu là task con của một epic
depends_on: [T-0141]
priority: normal
size: M                                    # người giao đặt, hoặc triage ước lượng
labels: [search]
profile: standard
requested_by: { actor: you, channel: github }
```

Các bảng liên quan trong SQLite:
```sql
source_events (id INTEGER PRIMARY KEY, source TEXT, external_id TEXT, dedup_key TEXT UNIQUE,
               payload JSON, received_at TEXT, processed_at TEXT, result TEXT);   -- inbox thô, giữ để truy vết
task_links    (task_id TEXT, source TEXT, external_id TEXT, external_url TEXT,
               external_version TEXT, sync_state TEXT, last_synced_at TEXT,
               PRIMARY KEY (source, external_id));                                -- task ↔ mục ở kênh nguồn
task_messages (id TEXT PRIMARY KEY, task_id TEXT, direction TEXT, channel TEXT, kind TEXT,
               body TEXT, external_ref TEXT, created_at TEXT);                    -- hỏi/đáp, thông báo, mọi kênh
```

Quy tắc:
- Format chuẩn **không có trường riêng của nguồn nào**. Thông tin nguồn (số issue, id form, tên agent) nằm ở `task_links` và `requested_by`, và **không bao giờ vào prompt** của agent.
- `attachments` chỉ trỏ tới tài liệu *trong bản ghi task*. Nội dung thật được chụp lại lúc task bắt đầu (xem FrozenExecutionContext dưới).
- **FrozenExecutionContext.** Khi task bắt đầu chạy, cùng lúc với FrozenPolicy, orchestrator lưu bất biến:
  - Snapshot nội dung yêu cầu của task.
  - Bản sao (hoặc trích đoạn) và hash của từng attachment.
  - Hash phiên bản prompt của từng role.
  - `base_sha` của repo.

  Mỗi attempt ghi thêm model thực tế, phiên bản harness và các cờ CLI đã dùng. **Mọi attempt của cùng một revision đọc cùng một input.** Nhờ vậy khi fail, bạn biết đó là do model hay do yêu cầu đã đổi.
- **Nguồn đổi thì tạo revision mới**, có audit trail (`TaskRevised{from, to, diff, actor}`). Không âm thầm thay input giữa các attempt. Đổi revision là một điểm quyết định (`source_drift`, mục 5.5): chạy tiếp revision cũ, hay bắt đầu lại từ checkpoint với revision mới.

### 8.3 Source connector

```ts
interface SourceConnector {
  kind: string;                                        // 'cli' | 'agent' | 'github' | 'form' | …
  mode: 'pull' | 'push';                               // poll định kỳ hay nhận đẩy vào
  poll?(cursor: string | null): Promise<{ events: RawEvent[]; cursor: string }>;
  authorize(e: RawEvent): Trust;                       // ai được giao task qua kênh này
  normalize(e: RawEvent): NormalizedRequest | Ignored; // ánh xạ xác định, không dùng LLM
  syncBack?(task: TaskView, change: StatusChange): Effect; // đi qua outbox, idempotent
}
```

| Nguồn | Cách nhận | Ánh xạ sang format chuẩn | Đồng bộ ngược | v1? |
|---|---|---|---|---|
| **CLI** | `cusr task add -f task.yaml`, hoặc cờ dòng lệnh | Trực tiếp, vì đã là format chuẩn | In ra terminal | ✔ |
| **Agent / assistant** | Cùng lệnh CLI có `--json` (sau này thêm tool MCP `task_create`) | Trực tiếp. `requested_by.actor` = tên agent | Assistant tự truy vấn `cusr task show` | ✔ |
| **GitHub** | Poll issue có label `cusr` bằng `gh api` (dùng `since` + ETag). Lệnh trong comment: `/cusr run`, `/cusr answer …`, `/cusr approve`, `/cusr cancel` | Title → `title`. Body → `description`. Section `## Acceptance`/`## Requirements` nếu có → mảng tương ứng. Label `type:*`, `size:*`, `profile:*` → trường tương ứng. "blocked by #12" → `depends_on` | Comment có marker cho mỗi lần đổi trạng thái. Label `cusr:running/waiting/done`. PR có `Closes #N`. Câu hỏi của agent đăng thành comment | ✔ |
| **Form** | Trang form nhỏ do `cusrd` phục vụ qua Tailscale, cùng endpoint `POST /api/tasks` có token | Trường form = trường chuẩn | Trang trạng thái của task, thông báo qua kênh đã chọn | Giai đoạn 2 (cần HTTP server) |
| Về sau | Slack/Telegram, email, Linear/Jira, lịch định kỳ, "CI trên `main` đỏ → tạo task bugfix" | Cùng interface | Theo kênh | Khi cần |

Ghi chú theo nguồn:
- **Task do agent tạo có rủi ro chi phí**, vì một agent có thể tạo hàng loạt việc.
  - Mặc định task do agent tạo ở trạng thái `PENDING(confirmation)` cho tới khi bạn chạy `cusr task confirm`.
  - Có thể cấu hình `auto_confirm` theo từng agent và profile.
  - Có giới hạn số task mỗi agent được tạo trong một ngày.
- **GitHub là kênh hỏi đáp tự nhiên từ điện thoại.** Câu hỏi của agent thành comment trên issue, và bạn trả lời bằng `/cusr answer …` ngay trong app GitHub. Task tạo từ CLI hay agent cũng có thể gắn với một issue để dùng kênh này.
- **Form chỉ cần khi đã có HTTP API** (giai đoạn 2). Trước đó, từ điện thoại bạn giao việc bằng GitHub issue, hoặc nhờ assistant trong Paseo chạy `cusr task add`.

### 8.4 Triage: từ yêu cầu thô tới task sẵn sàng

Triage do code xác định, không phải Primary AI. Sự kiện thô nằm trong `source_events`; khi đã chuẩn hoá thành task, task luôn bắt đầu ở `PENDING` và chỉ `wait_reason` thay đổi theo từng bước triage: `PENDING(confirmation)` (chỉ với task do agent tạo) → `PENDING(needs_info)` ⇄ … → `PENDING(dependency)` → `READY`.

1. **Validate (code).**
   - Schema hợp lệ.
   - `repo` nằm trong danh sách cho phép.
   - Người giao có quyền dùng `profile` đó.
   - `depends_on` tồn tại và không tạo chu trình.
2. **Kiểm tra đủ thông tin (code).** Task phải có `acceptance` với ít nhất 1 tiêu chí kiểm chứng được. Nếu thiếu:
   - Mặc định: chuyển `PENDING(needs_info)` và hỏi lại người giao **qua đúng kênh** họ đã dùng (comment GitHub, thông báo form, CLI).
   - Tuỳ chọn theo profile: gọi role `refiner` **một lần** để đề xuất `requirements` và `acceptance` từ `description`. Đề xuất được gửi lại để người giao xác nhận, trừ khi profile cho phép `auto_accept`.
3. **Task lớn (`type: epic`).** Role `planner` chạy một lần, đề xuất các task con kèm `depends_on`. Task con chỉ được tạo sau khi bạn xác nhận. Không bao giờ tách việc ngầm.
4. **READY** khi đã đủ điều kiện và mọi task trong `depends_on` đã DONE.

### 8.5 Agent nhận task như thế nào
- **Agent không tự đi lấy (poll) task.** Scheduler (code) chọn task READY theo ưu tiên, dependency và resource pool, rồi giao cho agent qua runner. Nếu agent tự poll và tự chọn việc, LLM lại quay vào vòng điều phối và tốn token.
- **Agent nhận `task_brief.md`** dựng từ bản ghi chuẩn: `title`, `description`, `requirements`, `acceptance`, `constraints`, `out_of_scope`, trích đoạn từ `attachments`, và các lượt hỏi đáp trước đó trong `task_messages`. Brief không có số issue, tên kênh hay cú pháp riêng của nguồn nào.
- **Reviewer đối chiếu với `acceptance`.** Mô tả PR (ví dụ `Closes #N`) do orchestrator viết từ `task_links`, không phải agent viết.

### 8.6 Đồng bộ hai chiều mà không mâu thuẫn
- **DB là nguồn sự thật cho trạng thái thực thi.** Kênh nguồn chỉ được thông báo, qua outbox có idempotency key và marker (cùng cơ chế với các effect khác, mục 6).
- **Kênh nguồn là nguồn sự thật cho nội dung yêu cầu, nhưng chỉ cho tới khi task bắt đầu chạy.**
  - Issue bị sửa khi task chưa chạy: cập nhật bản ghi.
  - Issue bị sửa sau khi task đã chạy: không đổi snapshot đang chạy. Gắn cờ `source_drift` và hỏi bạn chọn tiếp tục, chạy lại với yêu cầu mới, hay tạo task mới.
- **Huỷ ở nguồn** (đóng issue) tạo yêu cầu huỷ task. Task đang chạy được dừng an toàn tại ranh giới bước.
- **Dedup.** Mỗi sự kiện nguồn có `dedup_key`, ví dụ `github:issue:123:<updated_at>`. Poll lặp lại hay webhook gửi hai lần không tạo task trùng.
- **Không tin nội dung từ người lạ.** Nội dung issue đi thẳng vào prompt của agent, nên issue của người khác là đường prompt injection. Vì vậy GitHub connector chỉ nhận issue và comment từ tài khoản được cho phép; mặc định chỉ có bạn.

### 8.6b Câu hỏi và thông báo đi đâu

**Nguyên tắc:** tách *người giao việc* khỏi *kênh liên lạc*.
- Agent đã giao task cho bạn thường **không còn chạy** khi câu hỏi phát sinh: session đã kết thúc, và nó không có địa chỉ nào để nhận tin đẩy tới. Vì vậy agent là một *client*, không phải kênh liên lạc.
- Câu hỏi luôn được lưu trong DB (`task_messages`), rồi được gửi qua kênh liên lạc của bạn. Câu trả lời được nhận từ **bất kỳ kênh nào** và ghi về cùng một chỗ.

**Định tuyến:**

| Task đến từ | Câu hỏi gửi tới |
|---|---|
| GitHub issue | Comment trên chính issue đó, kèm một thông báo đẩy ngắn qua kênh mặc định |
| Agent, CLI, form | **Kênh mặc định của bạn** |

Ngoài ra, mọi câu hỏi đều nằm trong `cusr inbox`. Khi bạn mở lại agent (ví dụ trong Paseo) và hỏi "có gì đang chờ tôi không?", agent chạy `cusr inbox --json` rồi giúp bạn trả lời bằng `cusr answer`.

**Chọn kênh mặc định:**

| Kênh | Ưu | Nhược | Gợi ý |
|---|---|---|---|
| **Telegram bot** | Hai chiều thật: bạn *reply* tin nhắn là trả lời được. Push tốt trên iPhone, có nút bấm cho duyệt/từ chối, miễn phí, dễ làm | Thêm một dịch vụ bên ngoài. Chỉ nhận lệnh từ `chat_id` của bạn | **Kênh mặc định cho v1** |
| GitHub comment | Bền, có luồng, gắn với code, có app di động | Ồn; repo public thì lộ nội dung; task không có issue thì không dùng được | Dùng cho task đến từ issue |
| ntfy (tự host được) | Đơn giản, push tốt | Chủ yếu một chiều, khó trả lời bằng văn bản tự do | Chỉ để báo, không để hỏi đáp |
| Slack / Discord | Quen thuộc nếu bạn đã dùng | Nặng hơn cho một người dùng | Giai đoạn sau |

**Mỗi câu hỏi gửi đi gồm:** mã câu hỏi, task, nội dung, các lựa chọn (nếu có), và cách trả lời. Câu trả lời đi qua dedup và kiểm tra quyền giống mọi sự kiện nguồn (mục 8.6). Câu hỏi đã được trả lời ở một kênh thì các kênh khác được cập nhật là "đã trả lời", để không bị trả lời hai lần.

### 8.7 Chiến lược branch khi task phụ thuộc nhau
- **Task độc lập:** mỗi task một branch tách từ `base_branch`, mở một PR vào `base_branch`.
- **Nhóm task phụ thuộc nhau** (cùng `group` hoặc cùng `parent`): có thể dùng một **integration branch** `group/<tên>` tách từ `main`.
  - Mỗi task mở PR vào integration branch.
  - Task phụ thuộc chỉ bắt đầu khi task cha đã merge vào integration branch.
  - Merge vào integration branch tự động khi CI và review đều xanh (`auto_when: target_branch: group/*`).
  - **PR từ integration branch vào `main` theo quy tắc merge vào `main` (mục 5.5):** bạn duyệt, hoặc tự merge nếu repo đang bật yolo.
- **Trước khi push**, rebase lên base mới nhất. Nếu conflict, gọi `fixer` với danh sách file conflict (`max_visits: 1`). Vẫn conflict thì chờ người.

### 8.8 Merge an toàn: không merge dựa trên CI đã cũ (bắt buộc trước khi bật auto-merge)

**Race condition cần chặn:**
1. Task A và task B cùng tách từ integration branch tại commit X, và CI của cả hai đều xanh.
2. A được merge, nên integration branch tiến lên commit Y.
3. B được merge dựa trên kết quả CI chạy trên X. Như vậy B chưa từng được kiểm tra cùng với thay đổi của A.

**Quy tắc:**
1. **Merge được tuần tự hoá theo từng branch đích.** Mỗi branch đích có một merge queue trong DB, mỗi lúc chỉ xử lý một PR.
2. **Kiểm tra lại ngay trước khi merge.** Head SHA phải trùng với SHA đã được duyệt. CI xanh phải được chạy trên một head *đã chứa tip hiện tại của base*, tức `git merge-base --is-ancestor <base_tip> <head>`.
3. **Base đã đổi:** cập nhật branch (rebase hoặc merge base vào), chạy lại gate local và CI, rồi mới quay lại hàng đợi. Phần này dùng chung vòng `ci`/`ci_fix` có giới hạn.
4. **CI có kết quả không xác định** (pending quá hạn, bị huỷ, thiếu check bắt buộc): không merge, task chuyển `WAITING`.
5. **Hàng rào bổ sung trên GitHub:** bật branch protection với required checks và "require branches to be up to date before merging" cho `main` và cho các integration branch. Orchestrator có lỗi thì GitHub vẫn chặn.
6. **v1:** mỗi lúc chỉ merge một PR vào mỗi branch đích. Merge song song hoặc GitHub merge queue để sau.

### 8.9 Hoàn tất cả nhóm task (group/epic)

Tất cả task con DONE **chưa** có nghĩa là cả nhóm chạy đúng: tầng dữ liệu, business logic, UI/API, routing và wiring dependency có thể từng phần đều ổn nhưng hỏng khi ghép lại. Vì vậy nhóm (`group`/`parent`) có **task tích hợp** riêng, do orchestrator tự tạo khi task con cuối cùng DONE. Task tích hợp có:
- **`acceptance` cấp nhóm**: lấy từ task cha (epic) hoặc do bạn khai báo khi tạo nhóm. Thiếu thì chuyển `PENDING(needs_info)`, như mọi task khác.
- **Workflow `integrate`:**
  1. Đồng bộ integration branch với `main`.
  2. Chạy gate đầy đủ của project: build, unit test, lint, và integration test/E2E nếu project khai báo.
  3. **Review tổng thể** toàn bộ diff `main...group/<tên>` theo `acceptance` cấp nhóm. Diff lớn thì reviewer nhận danh sách file và tự đọc.
  4. Lỗi ở bước nào thì tạo task sửa mới trong nhóm, có giới hạn.
  5. Mở PR từ integration branch vào `main`.
  6. Chờ CI theo quy tắc 8.8.
  7. **Merge theo quy tắc merge vào `main`** (mục 5.5): bạn duyệt, hoặc tự merge khi repo đang bật yolo. Không bao giờ do agent quyết.
- **Nhóm DONE** chỉ khi PR vào `main` đã merge. Trước đó, `cusr group status` hiển thị rõ: các task con đã xong, task tích hợp đang ở bước nào.

---

## 9. Phiên bản 1: đáng tin cậy ngay từ đầu

**Không giới hạn số dòng code.** Thước đo của v1 là **Reliability Gate** (mục 9.1), không phải kích thước code. Khi cần, thứ được điều chỉnh là *phạm vi tính năng và thời gian*, không bao giờ là độ tin cậy.

Một lưu ý thẳng thắn: độ tin cậy đến từ **bề mặt được kiểm chứng kỹ**, không đến từ việc có nhiều code. Vì vậy:
- Mọi tính năng vào v1 đều phải kèm fault test của nó.
- Các tính năng mở rộng (breadth) vẫn để sau v1.

### 9.1 Định nghĩa "đáng tin cậy": Reliability Gate

v1 chỉ được dùng trên repo thật khi đạt **toàn bộ** các tiêu chí dưới đây. Tất cả đo tự động và chạy lại được bằng một lệnh, ví dụ `pnpm test:reliability`.

| # | Thuộc tính | Tiêu chí đo được |
|---|---|---|
| R1 | Không mất trạng thái | Chaos run `kill -9` cusrd tại ≥ 200 thời điểm ngẫu nhiên. Mọi task khôi phục đúng bước. `verify-projections` khớp 100% |
| R2 | Không lặp side effect | Ma trận crash × mọi loại effect (commit, push, PR, comment, merge): 0 lần trùng. Fake git/GitHub đếm số lần gọi |
| R3 | Không kẹt im lặng | Mọi task tới trạng thái kết thúc, hoặc `WAITING` có `wait_reason`, trong thời gian giới hạn. Watchdog phát hiện được task `RUNNING` không có heartbeat |
| R4 | Không vượt policy | Property test ≥ 10.000 chuỗi trigger ngẫu nhiên, 0 vi phạm: model ngoài thang, vượt `max_visits`, vượt ngân sách, nấc chờ duyệt chạy khi chưa được duyệt |
| R5 | Không rò process | Sau mọi kịch bản timeout/cancel/crash: 0 process mang `CUSR_ATTEMPT_ID` còn sống ngoài ý muốn |
| R6 | Chịu lỗi đầu vào và môi trường | Với các lỗi: output harness hỏng hoặc bị cắt, JSON sai schema, dòng log cuối bị rách, `gh` lỗi mạng hoặc rate limit, đĩa đầy, SQLite busy, đồng hồ nhảy. Yêu cầu: phân loại đúng, daemon không crash, không chuyển sai trạng thái |
| R7 | Bền theo thời gian | Soak 8–12 giờ với fake agent (≥ 50 task, 20% lỗi ngẫu nhiên): không rò bộ nhớ hay file descriptor, không task nào kẹt |
| R8 | Hoạt động với harness thật | Mỗi adapter (Claude, Codex) chạy một task end-to-end trên repo sandbox, có một lần kill daemon giữa chừng, kết quả đúng |
| R9 | Vận hành được | Backup/restore thử thành công. Migration được chạy thử trên bản sao DB. `cusr doctor` phát hiện harness sai phiên bản hoặc sai cờ |

### 9.2 Kế hoạch v1: khoảng 4 tuần (20 ngày làm việc)

Tiền đề không đổi: 1 developer, có AI hỗ trợ, khoảng 6 giờ tập trung mỗi ngày. **Với chuẩn trên, 14 ngày không đủ nếu giữ nguyên phạm vi.** Tôi khuyến nghị 4 tuần, có các mốc kiểm tra:

| Giai đoạn | Ngày | Hạng mục | Mốc "xong" |
|---|---|---|---|
| **Tuần 1: nền tảng** | 1 | Spike harness: ghi fixture JSONL thật (thành công, lỗi, rate limit, hỏi người, output bị cắt), kiểm tra hợp đồng `result.json` | Bảng cờ CLI đã kiểm chứng. Có fixture cho R6 |
| | 2 | `SPEC.md` theo khung Symphony (entity, state machine, ngữ nghĩa retry/reconcile, hợp đồng runner, bảng effect) + schema task chuẩn/workflow/policy (zod) + loader kiểm tra tĩnh | Workflow lỗi bị từ chối lúc load |
| | 3 | `decide`/`evolve` thuần + policy guard + escalation ladder | Bảng chuyển trạng thái được phủ 100% |
| | 4 | SQLite store: WAL, `synchronous=FULL`, migration có backup, outbox, timers, khoá single-writer | `verify-projections` xanh. Có test migration |
| | 5 | Property-based test và model-based test cho engine | R4 xanh |
| **Tuần 2: thực thi** | 6 | Runner shim: detached, process group, env marker, ghi file nguyên tử, heartbeat, timeout | Kill daemon khi fake agent đang chạy, restart xong vẫn gắn lại được |
| | 7 | Adapter Claude + Codex, contract test bằng fixture của ngày 1 | Phân loại đúng mọi fixture |
| | 8 | Worktree manager + loader `cusr.yaml` của project + gate runner + log digest + context compiler | Gate chạy được trên repo sandbox ở ít nhất 2 hệ sinh thái, log được lọc |
| | 9 | GitHub port qua `gh`: push, PR có marker, poll checks, `--log-failed`, merge gắn SHA. Mọi lời gọi có timeout | PR thật trên repo sandbox |
| | 10 | **Kiểm tra hướng đi**: walking skeleton, một task end-to-end trên repo sandbox | Hướng đúng thì tiếp tục. Hướng sai thì dừng tại đây, mới mất 2 tuần chứ không phải nhiều tháng. Runner còn chập chờn thì chuyển sang Plan B (Cezar làm executor, mục 2.4) |
| **Tuần 3: phục hồi và lõi đầy đủ** | 11 | Recovery Manager đầy đủ: reconcile attempt, probe từng effect, boot-id, circuit breaker | Restart ở mọi trạng thái đều đúng |
| | 12 | Fault injection: ma trận crash, đĩa đầy, SQLite busy, `gh` lỗi, đồng hồ nhảy | R2, R5, R6 xanh |
| | 13 | Nguồn task: CLI/agent + GitHub (poll, lệnh `/cusr`, đồng bộ ngược idempotent) + triage. Scheduler DAG + pools + rate-limit cooldown | Giao task bằng GitHub issue từ điện thoại; task chạy đúng thứ tự phụ thuộc; không tạo task trùng |
| | 14 | HITL theo mục 8.6b: `cusr inbox`/`cusr answer`, Telegram bot làm kênh mặc định (hai chiều, nút duyệt/từ chối, chỉ nhận từ `chat_id` của bạn), comment GitHub cho task đến từ issue; approval (merge, nâng model, yolo) | Reply Telegram từ điện thoại và task chạy tiếp. Trả lời ở một kênh thì các kênh khác được đánh dấu "đã trả lời" |
| | 15 | CLI `--json` đầy đủ + `explain`/digest + `SKILL.md` cho assistant + watchdog | Assistant trả lời được "feature tới đâu rồi" chỉ bằng CLI. R3 xanh |
| **Tuần 4: chứng minh** | 16–17 | Chaos run + soak, sửa mọi lỗi tìm được | R1, R7 xanh |
| | 18 | Backup/restore, `cusr doctor`, systemd unit, runbook vận hành | R9 xanh |
| | 19 | Smoke test với harness thật có kill giữa chừng, rồi dogfood 3–5 task thật trên ít nhất 2 project khác hệ sinh thái | R8 xanh. Có số liệu token/PR |
| | 20 | Review Reliability Gate + retrospective | Quyết định dùng thật hay sửa tiếp |

**Nếu bắt buộc giữ 14 ngày:** giữ nguyên Reliability Gate và cắt phạm vi.
- Không có escalation ladder; binding cố định.
- Mỗi lúc chỉ chạy một task; dependency vẫn được tôn trọng.
- Chỉ có nguồn CLI/agent; nguồn GitHub để sau.
- Không có Telegram bot; hỏi đáp chỉ qua `cusr inbox`/`cusr answer`.
- Bạn tự merge bằng `gh`; `cusr` dừng ở trạng thái "CI xanh, chờ merge". Như vậy v1 không có effect nguy hiểm nhất.

### 9.3 Vẫn loại khỏi v1
Đây là cắt *bề rộng*, không cắt độ tin cậy:
- Dashboard web. MCP server (dùng CLI + `SKILL.md` thay thế). ACP. Adapter Pi (giai đoạn 2).
- Webhook. Worker từ xa. Hỗ trợ riêng cho tài nguyên đặc thù (vòng đời device/emulator, browser E2E, screenshot diff). Project vẫn khai báo được gate bất kỳ bằng shell kèm pool tương ứng.
- Nguồn task qua form (cần HTTP server), Slack, Telegram hoặc email. Trong v1, Telegram chỉ là *kênh hỏi đáp và duyệt* (mục 8.6b), không nhận task mới.
- Tách epic bằng `planner`. Trong v1, bạn tự tách hoặc nhờ assistant tạo task con.
- Sửa workflow lúc runtime. Nâng model ngoài thang đã khai báo. Định tuyến model theo chi phí.
- Multi-user và auth. Temporal, Restate hay DBOS. TUI phức tạp.
- Tự giải merge conflict nhiều vòng. Kênh thông báo ngoài Telegram và comment GitHub (Slack, Discord, email, ntfy).

**Kỷ luật thay cho giới hạn số dòng code:**
1. Mỗi module có trách nhiệm hẹp và ranh giới cứng. Engine không làm I/O. Adapter chỉ dựng lệnh và parse output.
2. Không merge tính năng nào thiếu fault test tương ứng.
3. Mọi lời gọi ra ngoài (harness, `git`, `gh`, shell) đều có timeout, phân loại lỗi và giới hạn retry.

**Stack đã chốt:** Node 24 LTS, TypeScript strict, `better-sqlite3`, Zod 4, Commander, `yaml`, `uuid`, Vitest và fast-check. Runner dùng `node:child_process.spawn`; gate/git/gh có thể dùng `execa`. Build bằng `tsc`, package manager pnpm, lint/format bằng ESLint + typescript-eslint + Prettier. Các cờ compiler, hợp đồng schema và giới hạn module được quy định tại [SPEC §17](../SPEC.md#17-baseline-kỹ-thuật). Không dùng framework workflow.

---

## 10. Rủi ro lỗi thời: phần nào sống lâu, phần nào sẽ thay

| Lớp | "Tuổi thọ" ước tính | Chiến lược |
|---|---|---|
| Domain model, state machine, policy, event log, outbox, probe, recovery | **Dài** (nhiều năm). Đây là kiến thức hệ thống phân tán, không phụ thuộc vendor | Đầu tư kỹ, test kỹ. Đây là phần học tập chính |
| Quality gates, context packet compiler, token ledger | Dài | Đầu tư vừa phải |
| Toolchain pack (`log_digest`, `signature`, `ci_rules`) | Trung bình (format log của toolchain thay đổi) | Là dữ liệu, không phải code. Test bằng fixture log thật. Project luôn override được |
| CLI contract + SKILL.md cho assistant | Trung bình–dài | Version hoá output `--json` (`schema_version`) |
| GitHub port (`gh`) | Trung bình (gh khá ổn định) | Port mỏng, có fake |
| **Format task chuẩn trong DB** | **Dài** | Version hoá (`schema_version`). Mọi nguồn đều quy về đây |
| Connector từng nguồn (GitHub, form, Slack…) | Ngắn đến trung bình (API của kênh đổi, kênh mới xuất hiện) | Connector mỏng: nhận, chuẩn hoá, đồng bộ ngược. CLI/agent luôn là đường dự phòng |
| **Harness adapter, cờ CLI, tên model, prompt** | **Ngắn** (tính bằng tháng; Codex đã bỏ `--full-auto` trong năm nay) | Adapter chỉ dựng lệnh và parse output, test bằng fixture, `cusr doctor` kiểm tra phiên bản và cờ, pin phiên bản harness |
| Việc "điều phối 1 task → PR" | Đang bị **thương mại hoá** bởi chính các vendor. Ví dụ, Claude Code hiện đã có `--bg` (background agent có supervisor), `claude agents --json` để liệt kê session nền, `--worktree` và agent teams **[XM-docs, CLI reference]** | Đừng cạnh tranh ở đây. Giá trị của bạn là **control plane trung lập vendor**: policy, audit, recovery, phối hợp đa harness. Nếu vendor làm tốt phần chạy nền, adapter của bạn có thể gọi tính năng đó thay vì tự quản process |

**Quy tắc để dự án học tập không thành gánh nặng:**
1. **Ranh giới cứng**: engine không import bất cứ gì từ adapter. Adapter chỉ biết `AgentRequest` → argv và dòng → `NormalizedEvent`.
2. **Ngân sách bảo trì**: nếu sửa adapter mất hơn 2 giờ/tuần trong 4 tuần liên tiếp, đánh giá lại (dùng ACP adapter cộng đồng, hoặc chuyển phần runner sang công cụ khác).
3. **Đóng băng tính năng sau v1**: chỉ thêm tính năng khi số liệu ở mục 7.2 cho thấy cần.
4. **Thoát hiểm**: vì task, plan và event đều nằm trong SQLite với schema của bạn, đổi runtime (ví dụ dùng một runner khác cho phần thực thi) không mất dữ liệu hay quy trình.

---

## 11. Chiến lược kiểm thử

| Tầng | Kỹ thuật | Kịch bản bắt buộc |
|---|---|---|
| **Workflow engine (thuần)** | Test bảng kịch bản: `given(events) when(trigger) then(events, commands)`; đồng hồ giả | Happy path; reject → fix → approve; reject ×3 → escalate; gate fail ×3 → escalate; CI fail → fix → pass; policy chặn model; huỷ giữa chừng; `needs_input` → answer → resume |
| **Bất biến** | Property-based (`fast-check`): sinh chuỗi trigger ngẫu nhiên | Không bước nào vượt `max_visits`. Trạng thái kết thúc là hút (không thoát ra được). Không có 2 effect cùng `idem_key`. Không `start_agent` nào vi phạm policy. Tổng `agent_runs` ≤ budget. **Nâng model:** không bao giờ dùng nấc ngoài thang đã đóng băng. Không bao giờ nâng vì outcome hạ tầng (rate limit, timeout, crash). Cùng chữ ký lỗi hai lần liên tiếp thì luôn rời nấc hiện tại. Mỗi nấc ≤ 3 lần thử. `rung` của mỗi cặp (task, bước) và sàn của task không bao giờ giảm; mọi `start_agent` dùng nấc ≥ `max(rung, floor)`. Nấc `needs_approval` không bao giờ chạy khi chưa có event duyệt. Số lần nâng ≤ `max_escalations_per_task`. **Quyết định:** loại không ủy quyền được không bao giờ được quyết bởi agent. Merge vào `main` chỉ xảy ra khi có event duyệt gắn với đúng head SHA, hoặc khi yolo đang bật và mọi điều kiện cứng thỏa; không bao giờ qua decider. Quyết định `agent_if_confident` dưới ngưỡng luôn chờ người. Số lần gọi decider ≤ giới hạn |
| **Loader cấu hình** | Unit | Từ chối: outcome thiếu transition, chu trình không có `max_visits`, role hoặc model không tồn tại, profile mâu thuẫn, `cusr.yaml` không có gate nào mà profile không cho phép. Toolchain pack được merge và override đúng |
| **Adapter** | Contract test với **fixture JSONL ghi từ CLI thật** (ngày 1) | Parse thành công, lỗi, rate limit, output bị cắt cụt, dòng không phải JSON. `classify` đúng |
| **Runner + lifecycle** | `fake-agent` (script nhận kịch bản: ngủ, ghi file, phát JSONL, treo, exit code, hỏi người, JSON hỏng) | Stall timeout, wall timeout, kill cả process group (không để process con mồ côi), tái sử dụng PID (giả lập `start_ticks` khác) |
| **Crash recovery** | **Điểm tiêm crash**: `CUSR_CRASH_AT=<effect>:<phase>` gọi `process.exit(137)` | Ma trận {start_agent, git_push, create_pr, post_comment, merge} × {trước pha 1, giữa 1–2, giữa 2–3, sau 3}. Restart xong khẳng định không có effect trùng (fake GitHub đếm số lần gọi) và task tiếp tục đúng bước |
| **Review loop** | Fake reviewer trả verdict theo kịch bản | Đúng số vòng. `escalate` có kèm bản tóm tắt |
| **CI integration** | `FakeGitHub` in-memory (chuỗi trạng thái pending → failure → success), fixture log thật của nhiều toolchain (Node, Python, Go, JVM) cho bộ lọc log | Timeout CI. CI xanh sau fix. Approval mất hiệu lực khi head SHA đổi. **Race merge:** hai PR xanh trên cùng base, merge PR đầu thì PR sau bị buộc cập nhật và chạy lại CI. CI không xác định thì không merge |
| **Worktree** | Hai task chạy song song; xoá worktree khi daemon tắt; agent giả cố ghi ra ngoài worktree | Mỗi task một worktree, không bao giờ dùng chung. Recovery tạo lại worktree bị mất. Ghi ra ngoài worktree bị phát hiện. Worktree còn việc chưa push không bị xoá |
| **Liveness/progress** | Fake agent im lặng nhưng tốn CPU, hoặc chạy process con lâu không in gì | Không bị kill nhầm. Chỉ stall khi không có tín hiệu progress nào |
| **FrozenExecutionContext** | Sửa attachment giữa hai attempt | Attempt sau vẫn đọc snapshot cũ. Sinh `TaskRevised` và điểm quyết định, không âm thầm đổi input |
| **Nguồn task** | Contract test dùng chung cho mọi connector (output phải là task chuẩn hợp lệ). Fake GitHub với chuỗi sự kiện issue/comment | Cùng sự kiện đến hai lần chỉ tạo một task. Sửa issue trước khi chạy thì cập nhật, sau khi chạy thì gắn `source_drift`. Đóng issue thì huỷ an toàn. Người lạ tạo issue thì bị bỏ qua. Đồng bộ ngược không đăng comment trùng. Thiếu `acceptance` thì chuyển `PENDING(needs_info)`. Thông tin nguồn không lọt vào prompt |
| **Context packet** | Snapshot test + **assert ngân sách kích thước** (ví dụ packet reviewer dưới 8k token ước tính) | Diff lớn chuyển sang chế độ `--stat` |
| **E2E thật** | Repo đồ chơi, chạy thủ công hoặc hằng đêm, tốn token thật | 1 task end-to-end với Claude và Codex. Phát hiện harness đổi cờ |
| **Chaos** (R1) | Runner ngẫu nhiên `kill -9` daemon, cùng fake agent lỗi ngẫu nhiên; seed được ghi lại để tái hiện | ≥ 200 lần kill. Mọi task khôi phục đúng. `verify-projections` khớp |
| **Lỗi môi trường** (R6) | Tiêm lỗi qua port: `ENOSPC`, `SQLITE_BUSY`, `gh` timeout/5xx/rate limit, đồng hồ nhảy tới hoặc lùi, dòng JSONL bị rách | Phân loại đúng. Không crash. Không chuyển sai trạng thái |
| **Soak** (R7) | Chạy 8–12 giờ, ≥ 50 task fake, theo dõi RSS và số file descriptor | Không rò rỉ, không task kẹt |
| **Vận hành** (R9) | Backup → xoá DB → restore. Migration trên bản sao DB. `cusr doctor` với harness giả sai phiên bản | Dữ liệu khớp. Migration chạy được hai chiều hoặc có đường lui. `doctor` báo đúng lỗi |

---

## 12. Roadmap và tiêu chí go/no-go

### 12.1 Thứ tự
| Giai đoạn | Thời gian | Nội dung |
|---|---|---|
| 1 | Tuần 1–4 | v1 đáng tin cậy (mục 9). Mốc kiểm tra hướng đi ở ngày 10. Chỉ dùng trên repo thật sau khi qua Reliability Gate |
| 2 | Tuần 5–8 (khoảng 4–6 giờ/tuần) | Dùng thật cho 2 feature trên các project khác hệ sinh thái. MCP server mỏng. Adapter Pi. Nguồn form (HTTP API + trang form qua Tailscale). Tách epic bằng `planner`. Nấc "context" trong escalation ladder. Toolchain pack cho các hệ sinh thái phổ biến (Node, Python, Go, Rust, JVM), mỗi pack có fixture log thật. Báo cáo token hằng tuần |
| 3 | Tuần 9–12 | Worker từ xa qua SSH (runner shim chạy trên máy khác, hợp đồng file qua `ssh`, tức đổi cách spawn chứ không đổi engine). Hỗ trợ vòng đời tài nguyên đặc thù (device/emulator, browser) và screenshot test. Dashboard chỉ-đọc trên SQLite |
| 4 | Khi cần | Adapter ACP. Webhook (Tailscale Funnel). Planner tự động. Định tuyến theo chi phí (vẫn nằm trong policy) |

### 12.2 Tiêu chí tiếp tục sau v1 (đo sau 2–4 tuần dùng thật)
**Tiếp tục nếu đạt ít nhất 4/5:**
1. ≥ 60% task đi tới PR xanh mà bạn chỉ cần trả lời câu hỏi hoặc approve, không phải can thiệp tay vào code.
2. 0 side effect trùng trong ma trận crash test và trong sử dụng thật.
3. So với baseline Firstmate trên cùng nhóm task: token / task được chấp nhận thấp hơn ít nhất 30%, và human interventions không tăng. Ngoài ra wasted runs dưới 25%.
4. Thời gian bảo trì adapter dưới 2 giờ/tuần.
5. Bạn thật sự chọn dùng `cusr` cho feature kế tiếp, không quay lại công cụ cũ.

**Dừng hoặc đổi hướng nếu:**
- Bạn dành thời gian cho `cusr` nhiều hơn cho chính các project của mình.
- Một công cụ có sẵn (xem mục 2) đáp ứng ≥ 80% nhu cầu sau khi bạn thử nó nghiêm túc.
- Harness đổi hợp đồng headless làm vỡ adapter hơn 1 lần/tuần.

Khi dừng, phần giữ lại vẫn có giá trị: domain model, kiến thức recovery, bộ test crash và cấu hình role/workflow, tất cả có thể mang sang công cụ khác.

---

## Phụ lục A: Giả định cần kiểm chứng (theo thứ tự rủi ro)

1. **[CKC]** Agent tuân thủ hợp đồng `result.json` theo schema ≥ 95% số lần (đo ở ngày 1 và ngày 6). Nếu không đạt, cần dựa vào structured output của harness và một vòng repair.
2. **[CKC]** `claude -p` chạy không giám sát 30–45 phút ổn định với subscription. Lỗi rate limit phân biệt được với lỗi khác qua output hoặc exit code.
3. **[CKC]** Cờ chọn model và sandbox của `codex exec` ở phiên bản bạn cài. Sandbox `workspace-write` có cho build tool của project tải dependency (mạng) không.
4. **[CKC]** Phần lớn task bạn giao vừa với một PR review được (≤ khoảng 400 dòng thay đổi). Nếu không, cơ chế epic cần được làm sớm hơn giai đoạn 2.
5. **[CKC]** Mức song song thực tế đạt được trước khi conflict trở thành chi phí chính (dự đoán: 2–3 task đồng thời).
6. **[CKC]** CI là GitHub Actions, và `gh run view --log-failed` đủ thông tin cho CI Fixer.
7. **[CKC]** Reviewer khác vendor với coder bắt được lỗi mà gate bỏ sót, đủ để bù chi phí. Đo bằng tỉ lệ finding được chấp nhận.
8. **[CKC]** Chính sách subscription của Anthropic và OpenAI cho dùng cá nhân giữ nguyên trong 6 tháng tới. Đã thay đổi 2 lần trong 2026, nên giữ phương án API key.
9. **[CKC]** systemd hoạt động trong WSL2 của bạn, và máy không sleep khi đang chạy đêm.
10. **[CKC]** Nâng model thật sự "cứu" được task thất bại (rescue rate đáng kể), chứ không phải phần lớn thất bại do yêu cầu mơ hồ hoặc thiếu context. Đo bằng `cusr report escalations` sau 2 feature.
11. **[CKC]** Task giao qua GitHub hoặc agent thường thiếu `acceptance`. Đo tỉ lệ task rơi vào `PENDING(needs_info)` để quyết định có nên bật `refiner` không.
12. **[CKC]** 4 tuần đủ để đạt toàn bộ Reliability Gate với một người có AI hỗ trợ. Nếu đến ngày 15 các mục R2, R5, R6 chưa xanh, cắt phạm vi theo mục 9.2 thay vì nới chuẩn.

## Phụ lục B: Nguồn đã dùng

**Mã nguồn** (shallow clone 2026-10-26, commit ở mục 2.1):
- [open-mercato/cezar](https://github.com/open-mercato/cezar)
- [chernistry/bernstein](https://github.com/chernistry/bernstein)
- [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
- [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
- [openai/symphony](https://github.com/openai/symphony)
- [kunchenguid/firstmate](https://github.com/kunchenguid/firstmate)

**Tài liệu harness:**
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): `-p`, `stream-json`, `--json-schema`, `--max-turns`, `--max-budget-usd`, `--permission-mode`, `--bare`, `--bg`, `claude agents`
- [Claude Code headless](https://docs.claude.com/en/docs/claude-code/headless)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): `codex exec --json`, `resume`, `--output-schema`, `turn.completed.usage`, ghi chú `--full-auto` không còn hỗ trợ
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Pi RPC mode (mirror npm `@earendil-works/pi-coding-agent`)](https://cdn.jsdelivr.net/npm/@earendil-works/pi-coding-agent@0.81.1/docs/rpc.md)
- [ExMCP ACP guide](https://hexdocs.pm/ex_mcp/acp_guide.html) và [changelog](https://hexdocs.pm/ex_mcp/changelog.html): trạng thái ACP v1 và adapter (nguồn thứ cấp)

**Chính sách subscription:**
- [Use the Claude Agent SDK with your Claude plan, Anthropic Support (cập nhật 2026-10-07)](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- Bối cảnh thứ cấp: [WinBuzzer 2026-02](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/), [Digital Applied](https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026)

**Durable execution:**
- [DBOS Transact v2 TypeScript](https://dbos.dev/blog/dbos-transact-v2-typescript)
- [What's New in DBOS, June 2026](https://dbos.dev/blog/new-in-dbos-june-2026) (SQLite cho bản Go)
