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
