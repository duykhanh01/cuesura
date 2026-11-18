# Báo cáo nghiệm thu feature 004

Chỉ ghi kết quả đã chạy thật. Tiêu chí chưa có dòng ở đây nghĩa là chưa kiểm chứng.

## Môi trường

| Mục | Giá trị |
| --- | --- |
| Ngày | 2026-11-01 |
| Host | Ubuntu 24.04.5 LTS, Linux 7.0.0-38-generic, x86-64 |
| Node | 24.22.1 |
| pnpm | 12.15.0 |
| `stty` | GNU coreutils 9.4 |

## Lát 0: terminal và PTY (T001–T005)

**Kết quả: đạt.** Checkpoint 0 mở Phase 2.

| Task | Kiểm tra | Kết quả |
| --- | --- | --- |
| T001 | `pnpm install --frozen-lockfile` với `string-width` 8.3.0, `node-pty` 1.1.0, `@xterm/headless` 6.0.0 | Sạch |
| T002 | `test/support/pty.ts` chạy chương trình thật trên PTY của `node-pty`, đọc màn hình theo ô qua `@xterm/headless` | Chạy được, không cần helper Python dự phòng |
| T003, T004 | `pnpm vitest run --project default test/contract/tui/terminal-restore.test.ts` | 13/13 đạt, chạy lại 3 lần liên tiếp đều đạt, mỗi lần khoảng 2,7 giây |

**Build script của `node-pty`:** bản 1.1.0 không có prebuild cho Linux nên phải biên dịch khi cài. pnpm chặn build script của dependency theo
mặc định, nên `pnpm-workspace.yaml` cho phép đúng package này (`allowBuilds: node-pty: true`). Yêu cầu `build-essential` và `python3` đã có
trong [README](../../README.md) vì `better-sqlite3` cũng cần khi không có prebuilt. `node-pty` chỉ là dev dependency, không cài cùng bản chạy.

**Phần terminal của SC-011.** Mỗi đường thoát so `stty -g` đọc trên cùng PTY trước và sau khi chương trình chạy, và so chế độ alternate screen,
con trỏ, bracketed paste, chuột trong xterm headless:

| Đường thoát | Exit | Terminal về trạng thái ban đầu |
| --- | --- | --- |
| Thoát thường (`q`) | 0 | Đạt |
| Ctrl-C ở raw mode | 0 | Đạt |
| `SIGINT` | 130 | Đạt |
| `SIGTERM` | 143 | Đạt |
| `SIGHUP` | 129 | Đạt |
| `uncaughtException`, thông báo lỗi hiện trên màn hình thường | 1 | Đạt |
| `unhandledRejection`, thông báo lỗi hiện trên màn hình thường | 1 | Đạt |
| Lỗi ghi stdout | 1 | Đạt |

`SIGSTOP` rồi `SIGCONT`: vào lại alternate screen, ẩn con trỏ, bật lại bracketed paste và vẽ lại toàn bộ; thoát sau đó vẫn khôi phục đúng. Đổi
kích thước: vẽ lại theo kích thước mới.

**Giới hạn của bằng chứng:**

- Đây là chương trình thử `test/fixtures/tui/terminal-probe.ts` trên lõi terminal, chưa phải `cusr`. SC-011 còn phần "task vẫn tiếp tục" và
  "daemon chết không phải đường thoát", kiểm ở T032.
- `SIGHUP` được gửi trực tiếp tới process vì cần PTY còn sống để đọc `stty`. Khi đứt SSH thật thì không còn terminal để khôi phục; lõi chỉ
  bỏ qua lỗi ghi và thoát.
- Lỗi ghi stdout được giả lập bằng cách làm `Writable` của stdout báo `EIO` để fd 1 vẫn mở và đọc được kết quả khôi phục. Lỗi `EIO` thật khi mất
  terminal không có gì để đối chiếu.

## Lát A: đường đọc (T006–T019)

**SC-006, kết quả tạm thời (T019):** `git diff --stat 5178b0a -- test/contract/cli/unavailable-command.test.ts test/integration/runtime/feature-002-cli.test.ts test/integration/runtime/access-control.test.ts` rỗng: ba file này đạt mà không sửa, kể cả sau khi `task_logs` có thêm `attempt_id`.

Hai test có sẵn ngoài danh sách trên phải sửa vì chúng ghim schema, không phải hợp đồng CLI:

| Test | Thay đổi | Lý do |
| --- | --- | --- |
| `test/integration/runtime/migration.test.ts` | `SCHEMA_VERSION` từ 3 thành 4, thêm test migration 004 | T007 yêu cầu thêm migration |
| `test/integration/runtime/daemon-control.test.ts` | Thêm `DROP COLUMN project` khi tua store về schema 2 | Store schema 2 thật không có cột này; nếu không, migration 004 chạy lại trên cột đã có |

**SC-006, kết quả cuối Phase 2:** cùng lệnh `git diff --stat 5178b0a -- …` vẫn rỗng sau T030.

## Checkpoint A: khung giao diện (T020–T030)

**Kết quả: đạt Checkpoint A.** Đây là khung giao diện, chưa tuyên bố đạt SC nào ở mức người dùng.

| Kiểm tra | Kết quả |
| --- | --- |
| `pnpm typecheck` | Sạch |
| `pnpm lint` (ESLint và Prettier) | Sạch |
| `pnpm test` | 150 file đạt, 1 bỏ qua; 2206 test đạt, 4 bỏ qua |
| `pnpm build` | Đạt; có `dist/tui/main.js` và migration 004 |
| `pnpm test:reliability` | 3 file, 429/429 test đạt, khoảng 18 phút; Phase 2 không thêm test reliability mới, đây là kiểm tra hồi quy |
| `vitest run --project default test/contract/tui test/contract/cli/no-tty.test.ts` | 39/39 đạt, chạy lại 3 lần liên tiếp đều đạt, mỗi lần khoảng 17 giây |
| `dist/cli/cusr.js` trên PTY của `script`, 100×30, không có token | Vào alternate screen, banner `Stopped` kèm lỗi token và `R retry connection`; `q` thoát 0, tắt đủ bracketed paste, hiện lại con trỏ, ra khỏi alternate screen |

**Giới hạn của bằng chứng:**

- Home vẫn là `src/tui/views/placeholder.ts`, chờ T036. Chưa có danh sách task, bộ lọc hay màn chi tiết.
- `state` chưa có mutation và bản nháp; phần đó thuộc US4 và US5.
- Làm mới và kết nối lại mới được kiểm ở mức unit với clock tiêm vào và ở khung PTY. SC-003 đo trên daemon thật thuộc T032 và T034.
- Lần chạy `dist` không có daemon nên chỉ kiểm được nạp động và đường lỗi token, không kiểm dữ liệu thật qua bản build.

## Sửa theo review PR #38 (tại `72d7e23`)

| Phát hiện | Sửa | Test |
| --- | --- | --- |
| Envelope sai cấu trúc làm TUI thoát | `isEnvelope` kiểm cả hai nhánh, ở `callDaemon` và daemon port; thành `protocol`/`incompatible` | `client-deadline.test.ts`, `daemon-port.test.ts` |
| Timeout chỉ tính thời gian không hoạt động | `timeoutMs` của `callDaemon` là deadline tuyệt đối, đóng kết nối khi hết giờ. Áp dụng cho mọi lệnh CLI, không riêng TUI | `client-deadline.test.ts`: server gửi một dấu cách mỗi 10 ms |
| Tải caller chồng nhau | `singleFlight` trong `src/tui/client/refresh.ts` | `refresh.test.ts` |
| Scheduler không hủy request cũ | Hủy bằng `AbortSignal` khi hết giờ và khi `stop()` | `refresh.test.ts`; socket thật qua mốc 2 giây trong `client-deadline.test.ts` |
| `truncated` báo sai ở đúng 64 tổ hợp | Chỉ bật khi có tổ hợp thực sự bị bỏ qua | `run-options.test.ts`: 64 tổ hợp là `false`, 72 tổ hợp là `true` |
| Lỗi nhập không chỉ cách sửa | `task board` tự kiểm cờ trước khi gọi daemon; help liệt kê status | `task-reads.test.ts` |
| Cắt lý do lỗi một dòng | Thanh trạng thái ngắn; lý do xuống dòng trong `notices`, kèm bước tiếp theo | `layout.test.ts`, `width.test.ts` |
| Output mặc định khó đọc | Bảng và tóm tắt ở `src/cli/render.ts` cho board, project, progress, request | `task-reads`, `projects`, `request-show` |

**Giới hạn của bằng chứng:**

- Tắt `controller.abort()` thì test socket thật vẫn đạt, vì deadline của transport cũng đóng kết nối cùng lúc. Việc hủy do test unit trên `signal.aborted` kiểm.
- `task content` và `task options` vẫn in YAML: review chỉ đề xuất bảng cho board, project và tóm tắt cho progress, request.
- Lý do dài hơn nửa vùng giữa hai thanh bị cắt ở giữa, nên phần đầu, nguyên nhân ở cuối (vd `ENOENT`) và bước tiếp theo đều còn. Phần giữa bị cắt chưa xem được trong TUI; `cusr status` in đủ thông báo.

**Kiểm tra sau khi sửa và merge `origin/main` (gồm PR #35, #37):** `pnpm typecheck`, `pnpm lint` sạch; `pnpm test` 152 file đạt, 1 bỏ qua, 2270 test đạt, 4 bỏ qua; `pnpm test:reliability` 3 file, 429/429 đạt; `pnpm build` đạt. Ba file T019 vẫn không đổi so với `origin/main`.

## Sửa theo review lần hai (tại `44ba9a6`)

| Phát hiện | Sửa | Test |
| --- | --- | --- |
| `task progress` gọi bước đã chạy là `done`, kể cả gate thất bại | Hiện `visited`; help đổi thành "visited, current, and remaining" | `test/unit/cli/render.test.ts` |
| Lỗi dài mất nguyên nhân ở cuối | Cắt phần giữa thay vì phần cuối | `layout.test.ts`, `width.test.ts` |
| Lệnh `More` làm mất bộ lọc | Giữ `--project`, `--status`, `--scope`, `--limit`, `--data-dir`, có quote cho shell | `task-reads.test.ts` chạy đúng lệnh được gợi ý trên daemon thật |

**Test PTY không ổn định:** `frame.test.ts` từng fail 2/8 lần với `alternateScreen: true` sau khi thoát. Nguyên nhân ở harness: file `status` có thể xuất hiện khi các byte cuối của chương trình còn nằm trong PTY. Làm chậm dữ liệu PTY 150 ms thì harness cũ fail đúng assertion này, harness mới đạt. `waitForExit` giờ đợi thêm một dấu kết thúc do shell ghi sau chương trình. Lõi terminal không đổi: chuỗi khôi phục vẫn ghi đồng bộ trước khi thoát.

## US1 (T031–T039)

**Kết quả: đạt checkpoint US1 trên Unix socket thật.** Các lần chạy trong bảng dưới chạy trên host Ubuntu, không nạp shim, trên đúng code của commit chứa dòng này; sau các lần chạy đó commit chỉ sửa tài liệu.

| Task | Lệnh | Kết quả |
| --- | --- | --- |
| T031, T032, T033 | `pnpm test` | Đạt, 1 lần chạy: 157 file đạt, 1 bỏ qua; 2455 test đạt, 4 bỏ qua. `us1-home.test.ts` 21/21, `us1-live.test.ts` 16/16, `us1-idle.test.ts` 1/1 |
| T032, phần SC-003 | Test "shows at least 95% of 20 status changes within 3 seconds" trong `us1-live.test.ts` | Đạt: 20 mẫu, ít nhất 95% trong 3 giây |
| T034 | `pnpm vitest run --project reliability test/reliability/tui/reconnect-window.test.ts` | Đạt, 1/1, 426 giây, chạy 1 lần |
| T038 | Không có test riêng; hành vi được kiểm qua T032, T034 và `test/unit/tui/refresh.test.ts` | Đạt theo các test đó |

Trên cùng code: `pnpm typecheck`, `pnpm build` và `pnpm lint` đều sạch.

T035, T036, T037, T039 đạt như đã ghi ở các phần dưới. T036, T037, T039 có test PTY nằm trong `us1-home.test.ts` và `us1-live.test.ts` ở bảng trên.

**Lần chạy qua shim dưới đây là chẩn đoán trong sandbox của worker, không phải bằng chứng nghiệm thu.**

**Shim:** sandbox của worker chặn `socket(AF_UNIX)` với `EPERM`. Một shim chẩn đoán đặt ngoài repo, nạp bằng `NODE_OPTIONS=--import`, đổi đường dẫn socket thành TCP loopback và làm giả `isSocket()` cho `control.sock`. Daemon, store, CLI và PTY vẫn là thật; chỉ lớp vận chuyển khác. Shim không được commit; bảng dưới là lần chạy sau khi sửa kết quả review, bằng một shim viết lại theo cùng cách vì bản cũ không còn. Các lần chạy dùng `TMPDIR=/tmp/cusrt`, vì đường dẫn tạm mặc định của sandbox chứa chữ `claude`, làm một assertion có sẵn của `doctor` thất bại.

| Task | Lệnh | Qua shim | Kết quả |
| --- | --- | --- | --- |
| T031 | `pnpm vitest run --project default test/contract/tui/us1-home.test.ts` | Có | 21/21 đạt, 1 lần chạy riêng và 2 lần trong `pnpm test` |
| T032 | `pnpm vitest run --project default test/contract/tui/us1-live.test.ts` | Có | 16/16 đạt, 1 lần chạy riêng và 2 lần trong `pnpm test` |
| T033 | `pnpm vitest run --project default test/contract/tui/us1-idle.test.ts` | Có | 1/1 đạt, phiên rảnh 30 giây; chỉ là kiểm tra sớm, không tuyên bố đạt SC-009 |
| T034 | `pnpm vitest run --project reliability test/reliability/tui/reconnect-window.test.ts` | Có | 1/1 đạt, 426 giây, chạy 1 lần |
| T035 | `pnpm vitest run --project default test/unit/tui/activity.test.ts` | Không dùng socket | 125/125 đạt |

Hai bảng này chạy trước lần sửa review cuối, nên chỉ có giá trị chẩn đoán.

| Gate | Kết quả |
| --- | --- |
| `pnpm typecheck` | Sạch |
| `pnpm exec eslint .` | Sạch |
| `prettier --check` trên file do Git quản lý | Sạch. `pnpm lint` nguyên lệnh không kết thúc sạch trong sandbox vì `prettier --check .` gặp `EACCES` ở các dotfile do sandbox gắn vào worktree (`.mcp.json`, `.zshrc`, …), không thuộc repo |
| `pnpm test` qua shim | Hai lần liên tiếp: 149 file đạt, 9 bỏ qua; 2406 test đạt, 47 bỏ qua. Các file bỏ qua cần bwrap, systemd hoặc harness thật của host |

**Phát hiện khi đối chiếu với spec và đã sửa:**

| Phát hiện | Sửa | Test |
| --- | --- | --- |
| `forbidden` trên board hoặc health bị coi là lỗi tạm: giao diện thử đủ 30 lượt thay vì dừng, trái FR-009 và EC-008 | Dừng ngay, nêu lý do và bước tiếp theo; đổi bộ lọc rồi `R` là có lại dữ liệu | `us1-live.test.ts` (nhóm "a token that may no longer read this view"), `refresh.test.ts` |
| Việc cần làm ghi "merge if offered", dễ hiểu là giao diện có thao tác merge (FR-023) | Đổi thành "merge on GitHub if offered" | Không có test riêng cho câu chữ; `activity.test.ts` vẫn đạt |
| Test kịch bản 7 chỉ thoát bằng `q`, chưa đủ "mọi đường thoát" của FR-004 | Thêm Ctrl-C, `SIGTERM`, `SIGHUP`; mỗi đường đều so `task list`, watermark và `cusr status` | `us1-live.test.ts` |
| Tên test SC-011 hứa "sends nothing by itself" nhưng không kiểm | Đi qua proxy, kiểm không có `/v1/command` và bộ lọc không đổi | `us1-live.test.ts` |
| Test đổi token ghi đè file không nguyên tử, client có thể đọc đúng lúc file rỗng và ra lý do khác. Đã thấy một lần ở test mới; test thu hồi token dùng cùng cách ghi | Ghi file tạm rồi `rename` | `us1-live.test.ts` |
| `revokedTokenFile` trong fixture không được dùng | Xóa | Không áp dụng |

**Phát hiện từ review và đã sửa:** test mới của hai dòng dưới được chạy cả trên `src/tui` cũ, và thất bại đúng ở hành vi này.

| Phát hiện | Sửa | Test |
| --- | --- | --- |
| Đổi token mà daemon không có event mới: `watermark` cũ vẫn được gửi nên daemon trả `unchanged`, Home tiếp tục hiện task và danh sách project của token cũ như dữ liệu hiện tại (EC-008, EC-009) | `daemon-port.ts` so token ở mỗi lần đọc và bỏ `watermark` khi token đổi. Giao diện đọc lại caller và project, về trang đầu nếu đang ở trang sau, và bỏ kết quả `project_list` đã hỏi dưới token cũ | `us1-live.test.ts` (nhóm "another token with nothing new", cả hai chiều), `daemon-port.test.ts`, `connection.test.ts` |
| Task cần người dùng nằm ngoài 200 mục của `attention` bị xếp thành task thường, mất `Needs you` và dòng `To do` (FR-007) | Gộp các hàng trên trang có `needs_user=true` vào nhóm, loại trùng theo ID. Khi daemon báo `truncated`, tiêu đề ghi `Needs you (n+)` vì `n` chỉ là số đã biết | `us1-home.test.ts` (nhóm "more tasks need the user", qua phân trang và lọc status) |

**Phát hiện từ review lượt 3 và đã sửa:** nếu token đổi giữa lần đọc board và health, kết quả board của token cũ vẫn được áp dụng như thành công, nên task của project không còn quyền xem có thể ở lại trên màn hình. `refresh.ts` giờ bỏ cả lượt đọc đó và đọc lại ngay bằng token mới; `credential_changed` đánh dấu dữ liệu đang hiện là cũ. Test: `test/unit/tui/refresh.test.ts`, nhóm "another token while a round is out". Test này chưa được chạy trên code cũ để xác nhận nó thất bại đúng ở lỗi này.

**Test EC-010 từng thất bại theo log của task trước:** không tái hiện trong mọi lần chạy ở đây, và không có sửa nào nhắm vào nhóm đó. Nguyên nhân cũ không xác định được.

**Giới hạn của bằng chứng:**

- `pnpm test:reliability` đầy đủ chưa chạy; chỉ chạy `reconnect-window.test.ts`, và chỉ 1 lần. `pnpm test` cũng chỉ chạy 1 lần trên host, nên một lần đạt chưa loại trừ test không ổn định.
- Khi token mới không đọc được (bị từ chối hoặc thiếu quyền), dữ liệu đọc bằng token cũ vẫn ở trên màn hình kèm banner `Data may be out of date`, như test thu hồi token có sẵn yêu cầu; nó không được trình bày như dữ liệu hiện tại.
- Về trang đầu khi đổi token mới có test ở mức reducer, chưa có test PTY.
- Thu hồi token được giả lập bằng cách đổi nội dung file token của client; daemon không bị đổi danh sách token trong lúc chạy.
- `limit` nằm trong khóa truy vấn nhưng giao diện chưa có cách đổi, nên phần "đổi `limit` thì bỏ `watermark`" không có test PTY riêng.
- `test/integration/runtime/cancel-drain.test.ts` có test "a running prepare" thất bại 2 lần qua shim ở lượt sửa trước rồi đạt ở các lần sau, đạt trong cả 2 lần `pnpm test` của lượt này, và đạt khi chạy không qua shim. Nhánh này không sửa `src/runner`, `src/daemon`, `src/application`, `src/adapters`, `src/cli` hay `test/integration`. Nguyên nhân chưa xác định. Lần chạy `pnpm test` trên host ở đầu mục này đạt.


## Sửa lỗi `project_list` theo review PR #48

Home từng bỏ qua mọi lỗi đọc `project_list`: schema không tương thích vẫn báo `daemon: ok` và tự thử tiếp; sau reconnect, một lần tải lại project thất bại có thể giữ danh sách cũ mãi.

`project_list` nay tham gia cùng lượt làm mới với board và health, chỉ đọc lại khi cần. Lỗi làm dữ liệu thành cũ; lỗi schema/quyền dừng tự thử, lỗi tạm dùng backoff và trần 30 lượt có sẵn. Caller và project cập nhật cùng kết quả thành công. Request project có deadline 2 giây và được hủy khi timeout hoặc thoát, giữ ngân sách SC-003 của Home.

| Kiểm tra trên host, không shim | Kết quả |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | Đạt |
| `pnpm test` | 158 file đạt, 1 bỏ qua; 2.459 test đạt, 4 bỏ qua |
| `us1-projects.test.ts` | 3/3 đạt; cả ba thất bại đúng hành vi lỗi khi chạy trước bản sửa |
| `refresh.test.ts` | 30/30 đạt; gồm trần retry khi chỉ project lỗi, deadline và bỏ phản hồi đến muộn |
| `pnpm vitest run --project reliability test/reliability/tui/reconnect-window.test.ts` | 1/1 đạt, 426 giây |

Đã kiểm liên kết nội bộ của các tài liệu sửa, bảng Markdown và `git diff --check`. Chưa chạy toàn bộ project `reliability`; chỉ chạy cửa sổ reconnect nêu trên.

## US2 (T040–T048)

**Kết quả: cả chín task đạt test và đạt checkpoint Phase 4, sau khi rebase lên Phase 3 đã nghiệm thu (`ef737d2`); chưa đạt mốc đầu vì chưa có US3–US5.** Mọi lần chạy trong bảng dưới trên host thật, Unix socket thật, không nạp shim, trên code của commit chứa dòng này; sau các lần chạy đó commit chỉ sửa tài liệu.

| Task | Lệnh hoặc nơi kiểm | Kết quả |
| --- | --- | --- |
| T040 | `test/contract/tui/us2-detail.test.ts` | 20/20 đạt |
| T041 | `test/contract/tui/us2-explain-refresh.test.ts` | 5/5 đạt |
| T042 | `test/contract/tui/us2-logs.test.ts` | 11/11 đạt |
| T043 | `test/contract/tui/control-chars.test.ts` | 16/16 đạt |
| T044 | `test/unit/tui/screen-reads.test.ts` 18/18, cùng T041 | Đạt |
| T045, T046 | T040, T043 | Đạt |
| T047 | `test/unit/tui/logs.test.ts` | 23/23 đạt |
| T048 | T042, T043 | Đạt |
| Sửa theo review | `test/unit/tui/screen-sessions.test.ts` | 13/13 đạt |

Test T040–T043 được viết trước. Trước khi triển khai chỉ chạy một mẫu 5 test đại diện cho cả bốn file, cả 5 thất bại vì chưa có màn chi tiết; không chạy toàn bộ test ở bước đó. Test unit T044, T047 được viết cùng lúc với model, không qua bước thấy thất bại.

| Gate | Kết quả |
| --- | --- |
| `pnpm typecheck` | Sạch |
| `pnpm lint` | Sạch |
| `pnpm build` | Đạt |
| `pnpm test` | 164 file đạt, 1 bỏ qua; 2561 test đạt, 4 bỏ qua, chạy 1 lần sau rebase. Các file Phase 4 chạy riêng thêm 1 lần: 7 file, 106/106 đạt |
| `pnpm vitest run --project reliability test/reliability/tui/reconnect-window.test.ts` | 1/1 đạt, 426 giây, chạy 1 lần, vì nhánh này sửa `main.ts` |

**SC-001, phần tự động:** với đủ 46 `DetailCode`, đối chiếu màn chi tiết với `task explain` của chính task đó (lý do, mã, chi tiết, từng `allowed_actions` với `note` và `command`, giới hạn) đều khớp. Cách dựng mẫu: `wait` được ghi thẳng vào projection vì nhiều mã cần chuỗi lỗi dài mới tới được, nên đây là bằng chứng về cách daemon giải thích và giao diện hiển thị, không phải về đường engine tới mã đó. Hai mẫu đi qua engine thật: câu hỏi và escalation. SC-001 còn cần phần "không chạy lệnh nào khác" ở tay người dùng, chưa kiểm.

**SC-010:** 12 mẫu ký tự điều khiển trong tiêu đề, trong log (chuỗi, object, nhiều dòng), trong tiêu đề PR và nội dung merge; kiểm byte ra terminal, chế độ alternate screen và từng ô. Mọi mẫu đạt.

**Phát hiện khi test và đã sửa:**

| Phát hiện | Sửa |
| --- | --- |
| `wrap` bỏ khoảng trắng đầu dòng nên mất thụt lề của bước | Thụt lề được giữ ở `views/task-detail.ts`, không đổi `width.ts` |
| Tám ký tự đầu của attempt ID đều giống nhau với UUIDv7 tạo gần nhau, dòng phân cách không phân biệt được attempt | Dùng tám ký tự cuối |
| `cancellation.late` chỉ đúng sau `CancelRecordedLate`, nên hủy đến trong lúc drain sẽ hiện như còn đang hủy dù merge đã được chứng minh | Có `completion` thì hiện "too late" luôn |
| Câu trả lời đang trên đường cho lần hỏi lúc tạm dừng có thể bật "New activity" hoặc chèn trang cũ sau khi bấm `F` | `followLogs` luôn tăng `generation` |

**Giới hạn của bằng chứng:**

- Đọc log tối đa 200 bản ghi mỗi giây theo R-03, bắt đầu từ đầu log. Task có nhiều log phải chờ khá lâu mới tới phần cuối: 5.300 bản ghi mất khoảng 27 giây.
- **Phép đo dài chưa chạy (T078 bỏ qua theo chỉ đạo người dùng):** SC-009 (phiên rảnh 1 giờ) và SC-013 (phiên log 8 giờ, bộ nhớ, phím dưới 200 ms ở 95%, tải daemon FR-039) chưa có kết quả, chưa đạt. Bằng chứng duy nhất cho SC-009 vẫn là phiên rảnh 30 giây của T033.
- Trần bộ đệm trong PTY được đối chiếu qua số hiển thị `Records: a–b`, không đo bộ nhớ process. Trần 8 MiB chỉ có test unit. SC-013 phiên 8 giờ thuộc T078.
- Thời gian phản hồi phím trong test log dồn dập chỉ kiểm dưới 1 giây ở 8 lần bấm, không phải số 200 ms của SC-013.
- Log đọc dồn dập trong test là log đã có sẵn; chỉ các test nhỏ mới ghi log trong lúc màn hình đang mở.
- `merged_head_unverified` và hủy quá muộn có test PTY. Trạng thái trung gian (hủy trong lúc drain, chưa DONE) chưa có test PTY riêng.
- Phản hồi cũ đến sau khi đổi token chỉ có test ở mức reducer và `ScreenReads`; test PTY đổi token kiểm kết quả trên màn hình, không ép được đúng thời điểm đó.

**Sửa theo review commit Phase 4:** test tái hiện được viết trước, và đã thấy thất bại trên code cũ, trừ phần ghi rõ.

| Phát hiện | Sửa | Test |
| --- | --- | --- |
| Đổi token khi đang đọc chi tiết: phản hồi của token cũ qua được guard theo task ID và điền lại màn hình | Mỗi lần mở màn và mỗi lần đổi token có `screenSession` riêng; phản hồi khác session bị bỏ. `ScreenReads` dùng lại `RefreshCredential` của Phase 3: phản hồi hỏi bằng token đã đổi báo `credential_changed` trước khi tới reducer | `screen-sessions.test.ts`, `screen-reads.test.ts`, test PTY đổi token trong `us2-detail.test.ts` và `us2-logs.test.ts` |
| Đổi token vẫn để lại tiêu đề đọc bằng token cũ, ở cả Task detail và Logs. Phát hiện khi viết test của dòng trên | Tiêu đề thay bằng task ID cho tới khi đọc lại | Như trên |
| Đóng rồi mở lại Logs của cùng task: phản hồi của màn cũ được nhận vì trùng `generation`, nên mất các bản ghi trước đó | Như dòng đầu: session duy nhất qua các lần mở, Task detail cũng vậy | `screen-sessions.test.ts` |
| `F` sau khi đọc attempt, trên log không còn bản ghi mới: màn hình trống và không cuộn được | Đọc lại một cửa sổ lịch sử rồi đọc tiếp từ đúng cursor; `↑` trên buffer rỗng cũng xin phần cũ | `screen-sessions.test.ts`, test PTY trong `us2-logs.test.ts` |
| Paused giữa bản ghi xuống dòng rồi nới rộng terminal: `anchor.row` vượt số dòng mới nên bản ghi bị bỏ qua | Kẹp về dòng cuối của bản ghi đó khi vẽ và khi cuộn; vị trí vì vậy có thể lệch trong bản ghi, không mất bản ghi | `screen-sessions.test.ts`, test PTY trong `us2-logs.test.ts` |
| Chu kỳ `task_explain` tính từ lúc nhận phản hồi, nên phản hồi 1 giây tạo chu kỳ 5,5 giây | Chu kỳ tính từ lúc hỏi; `Read at` vẫn là lúc có phản hồi | `screen-sessions.test.ts` |

Riêng Logs khi đổi token: `forgetLogs` đã tăng `generation` nên phản hồi cũ vốn bị bỏ; trên code cũ test chỉ thất bại ở tiêu đề.

## US3 (T049–T053)

**Kết quả: đạt checkpoint Phase 5 trên Unix socket thật.** Lần làm đầu chạy trong sandbox không bind được Unix socket: mọi test dựng daemon thật dừng ở `listen EPERM`, sau đó ở `listen EINVAL` vì `TMPDIR` của gate làm đường dẫn socket dài hơn 107 byte. Khi host gate đã dùng `TMPDIR` ngắn, `us3-navigation.test.ts` chạy với daemon thật trong PTY. Lần chạy đó phát hiện hai lỗi của test, không phải của giao diện, và cả hai đã được sửa (xem "Sửa sau lần chạy PTY đầu").

| Task | Lệnh hoặc nơi kiểm | Kết quả |
| --- | --- | --- |
| T049 | `pnpm vitest run test/contract/tui/us3-navigation.test.ts`, 10 test, PTY và daemon thật | 10/10 đạt, chạy 3 lần liên tiếp |
| T050 | `test/unit/tui/keymap.test.ts` (keymap, Help, Actions, sanitize) | 24/24 đạt |
| T051 | `test/unit/tui/keymap.test.ts`, mục "Help closes where it was"; T049 US3 số 4 | Đạt: mở Help, cuộn rồi Esc trên Home, Task detail, Logs và bộ lọc cho lại đúng state và đúng frame cũ |
| T052 | `test/unit/tui/keymap.test.ts`, mục "the Actions menu"; T049 US3 số 2 | Đạt |
| T053 | `test/unit/tui/input.test.ts`; T049 US3 số 3 | 31/31 đạt |
| Hồi quy | `pnpm vitest run test/unit/tui` | 15 file, 425/425 đạt |

**Thứ tự test trước:** `input.test.ts` chạy khi chưa có `src/tui/views/input.ts` và thất bại vì không nạp được module; sau khi triển khai, 1 test vẫn thất bại (paste vào ô một dòng giữ khoảng trắng của dấu xuống dòng cuối) và đã sửa code. `us3-navigation.test.ts` được viết trước khi có keymap, Help mới và Actions, nhưng lần chạy đầu chỉ thấy lỗi sandbox (`listen EPERM`), không phải thất bại của giao diện, nên không tính là đã thấy test thất bại đúng lý do. `keymap.test.ts` viết sau khi triển khai, chỉ để hồi quy.

**Sửa sau lần chạy PTY đầu:**

| Thất bại | Nguyên nhân | Sửa |
| --- | --- | --- |
| `us3-navigation.test.ts`, US3 số 2 "lists what `task explain` allows": thiếu `Cancel task` | Test chờ chữ `Answer the question`, nhưng Home đã có chữ đó ở dòng `To do:`, nên test đọc màn hình trước khi menu mở | Chờ tiêu đề `Actions — Asks a question` rồi `Cancel task`; ba chỗ chờ menu khác cũng chờ theo tiêu đề |
| `us1-live.test.ts`, "a daemon that holds connections…": hết 10 giây khi chờ `Ctrl-C       Quit` | Test chờ một dòng của Help cũ; T051 dựng lại Help theo keymap nên cột phím đổi | Chờ `Keys on Home`; điều test kiểm (Help vẫn mở được khi các lần đọc bị treo) giữ nguyên |

| Gate | Kết quả |
| --- | --- |
| `pnpm typecheck` | Sạch |
| `pnpm lint` | Sạch (ESLint và `prettier --check .`) |
| `pnpm test:changed` | 10 file, 195/195 đạt, sau khi thêm hướng dẫn merge vào menu Actions; `us3-navigation.test.ts` chạy lại 10/10 đạt. Trước đó 10 file, 193/193 đạt, sau khi sửa race của `us2-logs.test.ts` (xem dưới); 9 file, 182/182 đạt sau lần sửa theo review thứ bảy (↑/↓ và phần vẽ dùng chung một cách tính hàng/cột); sau lần thứ sáu, 9 file, 182/182; sau lần thứ năm, 9 file, 180/180; sau lần thứ tư, 9 file, 179/179; sau lần thứ ba, 9 file, 178/178; trước đó, sau lần sửa thứ hai, 9 file, 176/176; `pnpm vitest run test/unit/tui test/contract/tui` 25 file, 536/536 đạt (gồm `us3-navigation.test.ts`, PTY và daemon thật) |
| `pnpm test` | Gate của host sau lần sửa theo review thứ bảy: 168 file, 2716/2717; test hỏng là race của `us2-logs.test.ts` (xem dưới), đã sửa. Trước các sửa theo review: 168 file, 2702/2702 |

**Race của test US2 trong gate đầy đủ:** `us2-logs.test.ts`, "reading an old attempt: the place holds and new activity is reported", thất bại một lần trong gate của host vì `coder line 4` hiện ra. Test chọn attempt rồi chỉ chờ `coder line 3`, nhưng lúc đó attempt vẫn đang đọc tới hết (`filling`, dòng tin hiện `Reading…`). Khi máy tải nặng, lượt đọc tiếp theo tới sau khi test đã ghi `coder line 4`, nên bản ghi đó đúng là thuộc phần người dùng đã chọn đọc, không phải hoạt động mới. `logs.ts` và test này không đổi so với `origin/main`, nên đây là race có sẵn của test. Sửa: test chờ `Reading…` biến mất rồi mới ghi nhận vị trí và ghi bản ghi mới; mọi assertion giữ nguyên. Chạy riêng 5/5 đạt, cả file 3/3 đạt, và 6 lần chạy song song khi mọi CPU bận đều đạt.

**Sửa theo review:**

| Lỗi | Sửa | Test (thất bại trên code cũ) |
| --- | --- | --- |
| Gõ `👍🏽` hay chữ có dấu tổ hợp qua `KeyDecoder` thật cho hai phím `char`; con trỏ tăng theo grapheme của phần chèn riêng nên vượt số grapheme của chuỗi, Backspace sau đó không xóa gì | Con trỏ được đếm lại trên chuỗi đã ghép | `input.test.ts`, "keys as the terminal sends them" (2 test) |
| Con trỏ đứng trước dấu xuống dòng ngay sau một hàng đầy có `col` bằng độ rộng, nên ô đảo màu vẽ ra ngoài box | Con trỏ đó sang một hàng riêng như ở cuối văn bản; `col` luôn bị kẹp dưới độ rộng box, kể cả khi một ký tự rộng hơn box | `input.test.ts`, "the cursor before the line feed of a full row stays inside the box" |
| Enter, Backspace, Delete, ←/→, Home/End, ↑/↓ của ô nhập được đọc thẳng trong `editField`, Help không liệt kê | `FIELD_KEYS` khai báo mọi phím của ô nhập kèm lệnh; `editField` chỉ xử lý theo `fieldCommand`; Help đọc cùng bảng | `input.test.ts`, "the field keys come from the keymap"; `keymap.test.ts` kiểm Help có mọi mục của `FIELD_KEYS` |
| Backspace của ô gõ tên project trong bộ lọc được reducer đọc thẳng từ `key.name`, ngoài keymap | Ngữ cảnh `filter_text` có binding Backspace với lệnh `erase`; reducer chỉ xóa qua lệnh này; Help liệt kê nó | `keymap.test.ts`, "Backspace in the project name is a keymap command, listed in Help" |
| Bộ lọc có chữ, Tab → `?` → `q`: `quitArmed` bật nhưng Help không hiện lời hỏi lại, bấm `q` lần nữa là thoát | Màn nào đang mở (trừ bộ lọc, vốn tự hiện) cũng hiện lời hỏi lại ở đầu body (`views/screen-body.ts`) | `keymap.test.ts`, "q on Help over a filter with text asks again on Help itself" |
| `drawField` vẽ ra ngoài box: `漢` trong ô nhiều dòng rộng 1 đè ô bên phải; dấu tổ hợp đứng đầu hàng (`'\u0301abc'`) gắn vào ô bên trái box | Mỗi hàng được vẽ theo từng ô và cắt ở độ rộng box; ký tự rộng hơn phần còn lại vẽ thành khoảng trắng; dấu tổ hợp không có ký tự trước trong hàng thì không vẽ (văn bản vẫn giữ) | `input.test.ts`, "a character wider than the box is not drawn past it", "a mark at the start of a row does not join the cell left of the box" |
| Giới hạn số ký tự của ô nhập tính trước khi ghép grapheme: với `max` 1, gõ `👍🏽` qua `KeyDecoder` chỉ giữ `👍` trong khi paste giữ đủ; gõ `e` rồi dấu tổ hợp mất dấu | Giới hạn tính trên chuỗi sau khi ghép: phần chèn chỉ bị bớt khi chuỗi đã ghép vượt `max` | `input.test.ts`, "a limit counts the joined text, typed or pasted alike" |
| Help ghi `g/G` cho các binding đầu/cuối, dù Home và End cũng làm việc đó ở Home, Task detail, Logs và Help | Các binding này có `helpKeys` `g G Home End` | `keymap.test.ts`, "Help names Home and End wherever they move to the top and end" |
| Paste vượt giới hạn: vòng cắt phân đoạn lại toàn bộ chuỗi sau mỗi grapheme bị bỏ, nên paste 20.000 ký tự vào ô giới hạn 2.000 mất khoảng 28 giây và chặn cả Esc, Ctrl-C | Số grapheme của chuỗi đã ghép không giảm khi lấy thêm phần chèn, nên phần lấy được tìm bằng chia đôi: khoảng 15 lần phân đoạn thay vì một lần cho mỗi ký tự bị bỏ | `input.test.ts`, "a large paste past the limit is cut at once" (32 giây trên code cũ) |
| Đổi token khi menu Actions đang mở: `forgetActions` giữ tiêu đề task đọc bằng token cũ, nên token mới không được đọc project đó vẫn thấy tiêu đề, kể cả sau khi `task_explain` trả `forbidden` (EC-009) | Như `forgetDetail`, `forgetLogs`: tiêu đề được thay bằng task ID | `keymap.test.ts`, "a change of token keeps nothing of the old one, title included" |
| ↑/↓ trong ô nhiều dòng tính cột bằng số grapheme và chỉ đi theo dấu xuống dòng: với `漢abc\n12345`, con trỏ sau `漢` (cột 2) xuống thành sau `1` (cột 1); trong một dòng dài tự xuống hàng, ↑/↓ không đi giữa các hàng | `editField` nhận độ rộng box; ↑/↓ đi theo hàng như ô nhập vẽ ra, tới cùng cột hiển thị hoặc vị trí gần nhất bên trái | `input.test.ts`, "↑ and ↓ keep the display column, not the count of characters", "↑ and ↓ move between the rows a long line wraps into" |
| Phần vẽ và ↑/↓ tính vị trí trước dấu xuống dòng của một hàng đầy khác nhau: với độ rộng 80, `'a'.repeat(80)+'\nx'` và con trỏ ở 80, con trỏ vẽ ở hàng 1 cột 0 nhưng ↑ không đi và ↓ đi ngang | Một hàm `layout` duy nhất tính hàng của văn bản và vị trí của mọi con trỏ; cả `fieldRows` lẫn ↑/↓ đọc nó. Hàng riêng cho con trỏ sau một hàng đầy vẫn chỉ có khi con trỏ đứng đó | `input.test.ts`, "↑ and ↓ move between the rows a long line wraps into" (phần hàng đầy) |
| Mục `merge_manually` của menu Actions chỉ hiện `note`; `explain.merge.method` và `explain.merge.proposed` bị bỏ qua, nên cả menu lẫn Enter đều không cho xem method, tiêu đề và thông điệp merge đề xuất mà [hợp đồng](contracts/tui.md#màn-hình) yêu cầu | Khi mục đang được chọn, dưới nó hiện `Merge method`, `Proposed title` và `Proposed message` (giữ xuống dòng), hoặc nói rõ daemon không đưa method hay đề xuất. Thông điệp dài hơn màn hình đọc tiếp bằng `PgUp/PgDn` (binding `read on` của ngữ cảnh Actions, có trên thanh gợi ý và Help); ↑/↓ sang mục khác thì bắt đầu từ đầu mục. Enter nói không có gì để gửi và chỉ tới phần hướng dẫn | `keymap.test.ts`, "the merge guide gives the method and the proposed title and message, all of it by keyboard", "without a merge proposal the guide says so" |

**Cách làm:**

- `src/tui/model/keymap.ts` khai báo phím theo ngữ cảnh (`home`, `detail`, `logs`, `attempts`, `actions`, `filter_choice`, `filter_text`, `help`) cùng nhóm phím chung. Reducer chỉ đổi phím thành lệnh qua `commandFor`; thanh gợi ý (`hintBar`) và Help đọc cùng bảng; binding có `when` không đúng lúc này thì vừa không tác dụng vừa không hiện. Phím của ô nhập (`FIELD_KEYS`) cũng khai báo ở đây và `views/input.ts` dùng lại.
- Thanh gợi ý không vượt độ rộng terminal: thiếu chỗ thì bỏ dần gợi ý không thiết yếu từ cuối, còn `Esc back`, `? help`, `q quit` (hoặc `Ctrl-C quit` khi đang gõ) và `R retry connection` luôn được giữ. Help vẫn liệt kê những phím bị bỏ. Ở Home, `PgUp/PgDn page` rút thành `PgUp/PgDn` để `a actions` vừa 80 cột.
- Help là một màn trên stack và chỉ có `helpTop` của riêng nó, nên không đổi gì của màn bên dưới. Nó mở được cả trên bộ lọc khi đang ở danh sách status; trong ô gõ, `?` là chữ.
- Menu Actions mở bằng `a` ở Home (task đang chọn) và Task detail. Menu tự đọc `task_explain`, không dùng bản Task detail đang giữ, và đọc lại khi watermark của board đổi. Version đổi thì hiện `The task changed while this menu was open; its actions were read again.` và giữ lựa chọn theo `action`, không theo dòng (EC-013). Quyền theo `caller.roles`: `approve` cần `admin`, các thao tác gửi khác cần `operate`, giống `REQUIRED_ROLE` ở `src/application/commands.ts`; daemon vẫn là nơi quyết định. Mục thiếu quyền bị làm mờ, kèm `Not available: needs the operate role; this token has: read`. `command` chỉ hiện dưới dạng `CLI: …`, không được đọc. Mục `merge_manually` hiện method, tiêu đề và thông điệp merge đề xuất từ `explain.merge` khi được chọn; `PgUp/PgDn` đọc tiếp thông điệp dài. Mục có hộp thoại ghi `dialog in a later version`; Enter trên bất kỳ mục nào chỉ hiện thông báo tại chỗ (`Nothing was sent: …`), không gửi gì.
- Ô nhập `views/input.ts` là hàm thuần: con trỏ theo grapheme; một dòng cuộn ngang quanh con trỏ; nhiều dòng tự xuống dòng theo độ rộng hiển thị và cuộn tới dòng của con trỏ; con trỏ là ô đảo màu vì con trỏ terminal bị ẩn; nội dung qua `sanitize()` khi vẽ. Ở phase này ô nhập chưa có màn nào dùng; bộ lọc chỉ dùng phần xử lý paste một dòng. US4, US5 dùng ô nhập cho hộp thoại và form.

**R-01, cỡ renderer:** cell buffer và diff (`terminal/screen.ts` 143 dòng), đo và cắt theo độ rộng (`terminal/width.ts` 98), `terminal/safe-text.ts` 43, khung và vùng cuộn (`views/layout.ts` 203) và ô nhập (`views/input.ts` 397) tổng cộng 884 dòng sau Prettier. Lúc đầu là 789 dòng; các sửa theo review (đếm lại con trỏ sau khi ghép grapheme, giữ con trỏ trong box, xử lý phím ô nhập theo keymap, cắt phần vẽ của ô nhập trong box, tính giới hạn ký tự trên chuỗi đã ghép, cắt paste lớn bằng chia đôi, ↑/↓ theo hàng và cột hiển thị) đẩy con số qua ngưỡng khoảng 800 dòng. Cách đếm này không tính giải mã phím, terminal và các màn hình. Đánh giá theo R-01: phần tăng thêm là quy tắc của ô nhập (grapheme, độ rộng, phím theo keymap), Ink không có sẵn ô nhập nhiều dòng theo grapheme nên đổi sang Ink cũng vẫn phải tự viết phần này; vì vậy phase này giữ renderer tự viết và không đổi sang Ink. Ô xác nhận của US4 sẽ làm con số tăng tiếp, nên người dùng cần quyết định theo R-01 trước khi làm T061–T063.

**Giới hạn của bằng chứng:**

- Mục Actions bị làm mờ theo vai trò của token, không theo project: menu chỉ mở được trên task mà token đã đọc được.
- SC-005 với người thật thuộc T080.

## T079: SC-004 với harness thật (một phần)

**Trạng thái: một phần.** Bốn tổ hợp harness × chế độ đã chạy thật một lần, nhưng người thao tác là script và merge cũng do script
làm. Bản test hiện tại, có merge thủ công và các guard mới, chưa chạy lại hành trình trả phí. SC-004 với người thật chưa đo.

### Bốn lượt chạy thật (bản test cũ, commit `40c19ac`)

Chạy ngày 2026-11-18 trên bản build của `a4d183b`, host Ubuntu này, kernel 7.0.0-42, Node 24.22.1. Mỗi hành trình gõ phím vào
`dist/cli/cusr.js` không lệnh con trên PTY, với `dist/cli/cusrd.js`, model thật (`claude-haiku-5-5`, `gpt-6-luna`, effort low) và repo
sandbox private thật: tạo task, đề xuất và xác nhận cấu hình chạy, trả lời câu hỏi của agent, xem lối ra `Merge on GitHub`, rồi thấy
`Finished` tăng một sau merge. Bằng chứng máy đọc được: [t079-smoke-ledger.jsonl](evidence/t079-smoke-ledger.jsonl), trong đó trường
`keys_s` là số đo PTY dưới đây.

| Harness worker | Chế độ | Reviewer | Task | PR | Head đã kiểm = head đã merge | Merge commit | PTY | Tổng |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude `claude-haiku-5-5`, low | `direct-pr` | không | `01a1ef3e-e15b-7735-9020-35e72d9a8153` | Node#7 | `bbe0540f9f` | `90807c5d09` | 8,7 s | 198 s |
| Claude `claude-haiku-5-5`, low | `full-review` | Codex `gpt-6-luna`, low | `01a1ef4f-e5ba-7485-a113-7fbf32f0d2f5` | Node#8 | `7dd1e8b5de` | `d836facbec` | 9,8 s | 219 s |
| Codex `gpt-6-luna`, low | `direct-pr` | không | `01a1ef49-6ec9-7762-91c7-84b033de883e` | Python#6 | `f6a1950f88` | `8c8ae81967` | 7,8 s | 209 s |
| Codex `gpt-6-luna`, low | `full-review` | Claude `claude-haiku-5-5`, low | `01a1ef53-3e47-76f0-896e-7e842864c673` | Python#7 | `f0aa71b55c` | `09ff34a958` | 9,2 s | 227 s |

- **Cột PTY** là thời gian các đoạn script tương tác với PTY: tạo task, đề xuất, xác nhận, trả lời, mở menu xem `Merge on GitHub` và
  chờ `Finished` trên Home. Bước merge, việc đọc CI trước merge và thời gian chờ agent, CI hay drain nằm ngoài số đo này. **Cột Tổng**
  là toàn bộ thời gian thực của ca, gồm cả các bước đó.
- Mỗi task có `QuestionAsked`, câu trả lời gửi từ TUI được ghi `by: owner`, rồi lượt coder thứ hai làm xong. Hai PR `full-review`
  có một review "Approved" ở vòng 1 của vendor còn lại. Cả bốn PR có check `build` và `test` thành công trên chính head đó.
- Merge ở lượt này do script chạy `gh pr merge --squash --admin --match-head-commit <head>`, theo phép của lead chỉ cho phiên này.
  Sandbox bắt buộc một review mà tài khoản owner không tự approve được. Bản test hiện tại không còn lệnh merge (xem dưới).
- Usage: 10 lượt agent, gồm Claude 5 (4 coder, 1 reviewer) và Codex 5 (4 coder, 1 reviewer).
- Lượt đầu, hai ca `full-review` hỏng trước khi gọi model: lựa chọn ở Home vẫn nằm trên dòng `Finished (1)` của hành trình trước, nên
  `a` không mở menu của task mới. Hai task dở được hủy bằng CLI, không có lượt agent nào. Sau khi sửa cách chọn dòng, chạy lại một
  lần thì đạt.

- Đọc lại sau khi sửa review (commit `8f79d16`): một bản test tạm khởi động daemon trên hai data dir trên và đọc lại bốn task. Cả
  bốn đều DONE trên head đã kiểm, history đúng binding, PR merged đúng merge commit, `build` và `test` thành công trên head, và TUI ghi
  `Finished` trên đúng dòng của ID: 4/4 đạt. Phần này đã bị bỏ khỏi test (xem dưới), vì khởi động daemon thật trên data dir cũ có thể
  resume task còn dở.

### Bản test hiện tại

`test/smoke/tui-journey.test.ts` có hai phần:

- **Guard trên fixture.** Phần này luôn chạy, không đọc config người dùng, không khởi động daemon và không gọi mạng:
  - `prNumber`: chỉ đọc và thao tác PR của đúng repo đã khai.
  - `sandboxProblem`: chỉ ghi vào repo private có tên sandbox.
  - `configProblem`: config phải tắt `yolo` và chỉ khai đúng project và data dir sandbox của hướng đó.
  - `unfinishedTasks`: đọc store offline để tìm task chưa kết thúc mà daemon sẽ resume.
  - `notGreen`: một head chỉ xanh khi mọi check bắt buộc (`build`, `test` theo `cusr.yaml` của fixture) có run thành công trên chính
    head đó. Rollup rỗng hay thiếu check là chưa xanh.
  - `notVerifiedDone`: DONE chỉ được tính khi `checked_head_sha = merged_head_sha = head`, `unverified: null` và có merge commit.
  - `matrixProblem`: worker là Claude ở Node, Codex ở Python; reviewer là vendor còn lại ở `full-review` và không có ở `direct-pr`;
    mọi lượt coder, fixer và review trong history phải chạy đúng binding đó.

  Ledger bốn lượt thật được kiểm lại bằng các guard này. Kết quả: 8 test đạt, 4 skip.
- **Hành trình trả phí.** Phần này chỉ chạy khi có cả `CUSR_SMOKE_REAL` và `CUSR_SMOKE_T079_JOURNEY=1`. Trước khi khởi động daemon,
  `assertSafeStart()` kiểm offline rằng config tắt `yolo` và chỉ có đúng project sandbox, data dir không còn task chưa kết thúc, và
  GitHub báo repo private có tên sandbox. Sai một điều kiện thì dừng, chưa tốn gì.

  Tiêu đề có hậu tố riêng của lần chạy và task được chọn theo ID. Khi daemon chờ merge, test kiểm `pr_ref` thuộc repo đã khai, PR mở
  trên đúng head và `build`/`test` xanh trên head đó. Sau đó test in URL và head để operator merge thủ công rồi theo dõi tới DONE. Test
  không gọi merge và không ghi gì lên GitHub.

  Thời gian PTY tính mọi đoạn tương tác, kể cả mở menu merge và xem `Finished`. Thời gian chờ agent, chờ merge wait và chờ operator
  merge tới DONE được ghi riêng (`waits_s`); khoảng cuối gộp cả thao tác merge của operator. Bản ghi ledger chỉ được thêm sau khi mọi
  assertion đạt. **Phần này chưa chạy lại trên bản test hiện tại.**

### Chạy đủ bốn tổ hợp trên data dir sạch

1. Tạo cho mỗi hướng một config và một data dir mới, chưa có `cusr.db`:
   - Node: worker Claude, reviewer Codex, project duy nhất là `node-sandbox`.
   - Python: worker Codex, reviewer Claude, project duy nhất là `python-sandbox`.

   Mỗi config khai `runtime.data_dir` bằng data dir của nó, không có `yolo: true`, dùng profile `smoke` và model nhẹ.
2. Chép `harnesses/claude/{pin,manifest}.json` và `harnesses/codex/{pin,manifest}.json` từ data dir có record đã chứng minh vào
   `harnesses/` của từng data dir mới. Credential chỉ là đường dẫn trong `runtime.credential_refs`.
3. Chạy `node dist/cli/cusr-runner.js check-records --config <config> --data-dir <data>` cho từng hướng; cả hai phải báo `ok`.
4. Viết file `CUSR_SMOKE_REAL` theo `RealSmokeSchema` của `test/support/smoke-real.ts`:
   - `node`: repo `<owner>/cuesura-sandbox-node`.
   - `python`: repo `<owner>/cuesura-sandbox-python`.
   - `ledger`: đường dẫn ledger mới.
5. Chạy `pnpm build`, rồi
   `CUSR_SMOKE_REAL=<file> CUSR_SMOKE_T079_JOURNEY=1 pnpm vitest run --project smoke test/smoke/tui-journey.test.ts`.

   Mỗi ca in dòng `merge https://github.com/... at head <sha> by hand`. Operator merge đúng head đó trên GitHub sau khi CI xanh. Ca
   tiếp theo của cùng hướng chỉ bắt đầu khi data dir không còn task dở.

**Cấu hình:** thư mục riêng `~/.local/share/cuesura-t079`, gồm hai config (worker Claude cho Node, worker Codex cho Python; reviewer
là vendor còn lại) và hai data dir riêng. Repo là bản clone của hai sandbox private `duykhanh01/cuesura-sandbox-node`, `-python` có
sẵn từ feature 002; mỗi task chạy trên nhánh `cusr/...` riêng và merge vào `main` của sandbox. Pin và manifest harness chép từ data
dir dogfood; credential chỉ là đường dẫn tham chiếu. Không sửa config, data dir hay daemon dogfood. `cusr doctor` báo mọi kiểm tra
`ok` trước khi chạy.

**Giới hạn:**

- Người thao tác là script; SC-004 với người thật chưa đo.
- Hành trình trả phí chưa chạy lại trên bản test hiện tại. Bằng chứng live là bốn lượt của bản cũ và lượt đọc lại ở `8f79d16`; phần đọc lại đã bỏ khỏi test.
- Pin Codex ghi `codex-cli 0.167.0` cho launcher `codex.js`, trong khi `codex --version` trên host lúc chạy báo `0.169.1`. Doctor vẫn
  báo `manifest:codex ok`.
- Câu hỏi được gợi bằng mô tả task yêu cầu agent hỏi trước khi sửa file, không phải câu hỏi tự phát của agent.
- Phát hiện về UX, chưa sửa: task vừa tạo không được chọn ở Home nên người dùng phải tự di chuyển tới nó trước khi bấm `a`.

## Đối chiếu nghiệm thu T083

**T078, T079, T080 và T083 đã đóng theo quyết định của người dùng.** T078 được bỏ qua đợt này. SC-004 và SC-005 còn phần nghiệm thu người thật. Kịch bản quickstart 2–6 chưa chạy bằng tay. SC-012 thuộc mốc sau.

Bảng ghi mốc chạy từng phép kiểm. "Tự chạy" là lượt đối chiếu T083 trên Ubuntu, Node 24.22.1, pnpm 12.15.0 ngày 2026-11-18. "Báo cáo" dẫn tới bằng chứng đã ghi trong PR tương ứng.

### Bằng chứng

| Nguồn | Mốc | Nội dung |
| --- | --- | --- |
| Tự chạy | `a4d183b6` | typecheck, lint, build sạch; `test/contract/tui` và `test/unit/tui` 897/897; ba file CLI cũ 102/102; `fuzz-confirm` 5/5 (5 màn, 10.000 phím, seed 20261106) |
| Tự chạy | `7914904d` | `--project performance` 4/4 (SC-002, SC-003 20 mẫu, `idle-session` 30 giây); 7 file đối chiếu contract 149/149 |
| Tự chạy | `a4d183b6` | Quickstart kịch bản 1 bước 3 bằng binary build: `cusr \| cat`, `cusr --json`, `TERM=dumb cusr` đều exit 2, không ESC, `--json` trả `not_available` |
| Báo cáo, đã merge | #345 (`7914904d`) | Khôi phục phép đo SC-002/SC-003 của Home; số 649 ms (SC-002) và 892–1031 ms (SC-003, 20/20) là đo local của coder; CI xanh riêng |
| Báo cáo, đã merge | #342 (`52aa46f0`, CI 44340456224) | T076, T077: host 37/37 trên `dca93e2b`; coder 63/63 test mặc định đổi, gồm 5 đường thoát runner và 4/4 smoke khởi động lại |
| Báo cáo, đã merge | #347 (CI 44343711748) | `reconnect-window` 1/1, 425,9 giây trên `4971ad1e` |
| Báo cáo, đã merge | #346 (`f422dd11`, CI 44349972073) | T079: 4 hành trình harness thật (Claude và Codex × 2 chế độ), PTY 7,8–9,8 giây chưa gồm merge, bốn PR sandbox build/test xanh và DONE; test mới chưa chạy lại bản trả phí |
| Báo cáo, đã merge | #343 (`bca9cb90`, CI 44350632668) | 172 test nhắm đích trên `44715ed5`. Đã xác minh actor khác, kết quả bị từ chối và crash qua CLI. Hợp đồng tra cứu dùng actor theo ADR 0011. |

Bộ `pnpm test` đầy đủ đạt trên CI #343 (run 44350632668). Chạy nhắm đích cho performance, reconnect, fuzz và smoke được ghi riêng. Hai phiên đo 1 giờ và 8 giờ được bỏ qua trong đợt này.

**SC-006.** `git diff 5178b0a7..origin/main` cho ba file CLI không rỗng (do #111, #121, #225 và các feature khác); không PR 004 nào đổi chúng và chúng đạt 102/102. "Rỗng" ở Lát A là kết quả lịch sử tại T019 và T030. Hai test khác đã sửa trong #38 (`migration.test.ts`, `daemon-control.test.ts`) vì ghim schema.

### Lượt thử T080 do agent (không thay SC-005)

Agent Sonnet 5.5 medium, `a4d183b6`, PTY 80×24, daemon cục bộ 3 task giả, chỉ dùng gợi ý trên màn hình. Enter tới Logs 3,724 s; `d` tới Task detail 8,609 s; `l` về Logs 12,561 s; `?` mở Help 13,112 s; `q` thoát mã 0 ở 15,976 s; `stty` trước và sau trùng, không gửi thao tác ghi. Điểm vướng: Enter ở Home không nói đích là Logs; log mẫu trống; Help ở 80×24 bị cắt ở dòng `R`; bảng chú thích trạng thái ít nổi bật. Đây là bằng chứng khám phá được, không phải người chưa đọc tài liệu.

### Bảng SC-001–SC-016

| SC | Kết quả | Bằng chứng |
| --- | --- | --- |
| SC-001 | Một phần | `us2-detail` 21/21 (đủ `DetailCode`, đối chiếu `task explain`). Thiếu: "không chạy lệnh nào khác" ở người dùng thật |
| SC-002 | Đạt | Tự chạy trên `7914904d`; #345 (649 ms là số của coder) |
| SC-003 | Đạt | 20 mẫu tự chạy trên `7914904d`; #345 (892–1031 ms); cửa sổ kết nối lại theo #347 (báo cáo) |
| SC-004 | Một phần | Giả lập: `journey` 2/2 tự chạy (T069 ghi 1,7 s và 1,8 s). Harness thật: bốn lượt với Claude/Codex × hai chế độ, xem T079. Chưa đo thao tác của người biết sản phẩm và merge thủ công |
| SC-005 | Chưa xác nhận | Chỉ có lượt thử agent; cần người thật |
| SC-006 | Đạt theo cách đọc ở trên | 102/102; 004 không sửa ba file |
| SC-007 | Đạt (tự động) | `us4-actions` 34/34, `us4-unknown-result` 10/10, `operate` và `admin` qua daemon thật |
| SC-008 | Đạt | `fuzz-confirm` 5/5 |
| SC-009 | Chưa đạt | Chỉ có phiên rảnh 30 giây; T078 bỏ qua |
| SC-010 | Đạt | `control-chars` 5/5 |
| SC-011 | Đạt (tự động) | `terminal-restore` 15/15 tự chạy; T077 theo #342 (báo cáo) |
| SC-012 | Mốc sau | Thuộc US6 |
| SC-013 | Chưa đạt | T078 bỏ qua |
| SC-014 | Đạt (tự động) | #343 kiểm mất phản hồi qua PTY, crash trước và sau khi ghi qua CLI, số task/event/attempt giữ nguyên khi tra, actor khác nhận cùng lỗi như ID không tồn tại. |
| SC-015 | Đạt (tự động) | `us4-stale-lock` đạt, gồm ca #343 lỗi lần đọc task và khóa request mới tới lần đọc thành công. |
| SC-016 | Đạt (tự động) | `us5-review` 14/14 (80×24) |

"Đạt (tự động)" là test tự động đạt; chưa có người dùng thật xác nhận.

### Quickstart

Tự động hóa như bảng trên. Chỉ kịch bản 1 bước 3 được kiểm tay; kịch bản 2–6 chưa chạy bằng tay (không đụng daemon thật). Dòng trạng thái cũ ở đầu `quickstart.md` đã sửa trong PR này.

### Đối chiếu contract và data model (đọc mã, `7914904d`)

Đối chiếu tại mốc trên. #343 sau đó đồng bộ thông báo thoát và hợp đồng tra cứu theo actor.

- `contracts/cli-daemon.md`: bảy lệnh và cờ có trong binary; handler ở `src/application/{projects,run-options,board,progress,requests}.ts`; test tương ứng đạt. Không thấy lệch. Chưa kiểm từng trường JSON và `question_show`.
- `data-model.md`: bảng `needs_user` và `steps` khớp `src/explain/needs-user.ts`, `src/application/progress.ts`, trừ hai lệch: không nêu `cancel_reconcile` (`false`, thành `true` từ lần đọc PR thứ 5); dòng "chưa phải schema đã triển khai" đã cũ.
- `contracts/tui.md` so với `src/tui/model/keymap.ts` và `src/tui`: phím chung khớp. Lệch: Logs có `Tab`/`Shift-Tab` và `[` `]` đọc log gate mà hợp đồng không nêu; `C` chỉ ở Home và Actions, form dùng `Ctrl-S`; hết trần hiện `Result unknown - could not be confirmed … Check again (C)`, không phải `Result still unknown`; ghi chú `Showing projects in this token's scope` không còn trong `src/tui`.

### Phép kiểm chưa thực hiện

- SC-004 và SC-005 chưa nghiệm thu với người thật. Hai phép đo dài của SC-009 và SC-013 được bỏ qua trong đợt này.
- Kịch bản quickstart 2–6 chưa chạy bằng tay.
