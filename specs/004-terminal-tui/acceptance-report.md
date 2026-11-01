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
