# Implementation Plan: Giao diện tương tác trong terminal cho `cusr`

**Branch**: `004/tui-spec` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)

**Input**: US1–US6, FR-001–FR-044, EC-001–EC-015, SC-001–SC-016 và các quyết định trong mục Clarifications của spec.

**Phạm vi plan:** mốc nghiệm thu đầu US1–US5. US6 cùng FR-029–FR-031, EC-015 và SC-012 thuộc mốc sau; plan chỉ giữ chỗ
để thêm chúng mà không phải đổi kiến trúc.

## Summary

Thêm module `src/tui/` chạy trong process `cusr`, mở khi gọi `cusr` không tham số trong terminal tương tác. Giao diện là
một client của daemon: đọc bằng `POST /v1/query` theo chu kỳ có trần và ghi bằng `POST /v1/command` với cùng hợp đồng
quyền, version và chống lặp như CLI. Trạng thái giao diện theo mô hình reducer thuần: `(state, message) → (state,
effects)` và `view(state, size) → frame`, nên kiểm thử phím ngẫu nhiên và kiểm thử dựng màn hình không cần terminal; mọi
tiêu chí nghiệm thu vẫn chạy qua pseudo-terminal với daemon thật.

Giao diện dùng một renderer nhỏ tự viết thay vì framework ([R-01](research.md#r-01--renderer)). Phía daemon thêm các
đường đọc còn thiếu, mỗi đường có lệnh CLI `--json` tương ứng (FR-040), và không đổi output của query hiện có ngoài trường
bổ sung `attempt_id` trong log. Thay đổi lưu trữ duy nhất là cột `project` của `command_ledger` cho `cusr request show`.

## Technical Context

| Mục | Thiết kế |
| --- | --- |
| Language/Version | Node 24.22.1, TypeScript strict/ESM, `tsc`; giữ baseline repo |
| Primary Dependencies | Có sẵn: Commander, Zod 4, uuid. Thêm `string-width` đo độ rộng chữ. Dev: `node-pty`, `@xterm/headless` cho kiểm thử PTY |
| Storage | Không có storage riêng của giao diện. Thêm migration 004: cột `command_ledger.project` |
| Testing | Vitest và fast-check; contract CLI và PTY trong project `default`; phiên dài, cửa sổ kết nối lại và fuzz phím ở project `reliability`; harness thật ở `smoke` |
| Target Platform | Linux/Ubuntu hoặc WSL2, qua SSH và tmux; terminal hỗ trợ alternate screen và UTF-8 |
| Project Type | Một package CLI/daemon/runner; thêm một module trong `cusr`, không thêm binary hay process |
| Performance Goals | SC-002 có dữ liệu trong 2 giây với 100 task; SC-003 hiện thay đổi trong 3 giây ở 95% lần; SC-013 phản hồi phím dưới 200 ms ở 95% lần |
| Constraints | Không mở SQLite, không gọi LLM, GitHub hay harness; không tạo mutation khi đọc; một phiên không chiếm slot; mọi vòng lặp có trần |
| Scale/Scope | Một người dùng; ít nhất 100 task; khoảng 10 màn hình; phiên mở ít nhất 8 giờ |

Không còn mục NEEDS CLARIFICATION. Các giá trị cụ thể ở [R-03](research.md#r-03--làm-mới-và-kết-nối-lại) và
[hợp đồng giao diện](contracts/tui.md).

## Constitution Check

Đối chiếu [hiến chương 2.0.0](../../.specify/memory/constitution.md) trước và sau thiết kế: **đạt**, không xin ngoại lệ.

| Nguyên tắc | Cách tuân thủ | Bằng chứng khi triển khai |
| --- | --- | --- |
| I. Lõi tất định | Không sửa `decide`/`evolve`. `needs_user`, tiến trình bước và mô tả hoạt động do code dựng từ dữ liệu đã ghi | Test bảng phủ mọi `DetailCode` |
| II. Effect sau commit, idempotent | Giao diện không ghi store. Mỗi thao tác logic giữ một request ID; kết quả chưa rõ được đối chiếu bằng `request_show` rồi gửi lại đúng request. `not_found` không bị coi là "chưa xảy ra" | SC-007, SC-014, integration với crash injection |
| III. Mọi thứ có giới hạn | Làm mới, số lượt kết nối lại, số lần tự đối chiếu và gửi lại thao tác, timeout, bộ đệm log và số bản ghi mỗi trang đều có trần. Hết lượt thì dừng, chờ người dùng | SC-003, SC-009, SC-013 |
| IV. Bằng chứng | Chỉ hiển thị bằng chứng daemon trả về; bước không yêu cầu khác với bước đã qua; không suy "PR xanh" hay DONE | SC-001, đối chiếu với `task explain` |
| V. Người dùng giữ quyền | Xác nhận là bước riêng trên màn xem lại, gắn với digest; không có merge, yolo, retry, amend-policy; token không đủ quyền không có đường vòng | SC-007, SC-008, SC-016 |
| VI. Lõi trung lập | Từ ngữ giao diện nằm trong `src/tui/`. Tiến trình bước đọc từ workflow đã đóng băng, không mã hóa tên bước vào engine | Review; engine không có diff |
| VII. Kiểm chứng trung thực | Tiêu chí chạy qua PTY với daemon thật. Tiêu chí cần người hoặc harness thật ghi riêng; chưa chạy thì báo chưa đạt | [Quickstart](quickstart.md), acceptance report |
| VIII. Đơn giản | Thuộc v1 theo [SPEC §2.1](../../SPEC.md#21-v1). Không dùng framework giao diện, không thêm process hay route stream. Dependency mới được biện minh bên dưới | Complexity Tracking |

Ràng buộc kỹ thuật và bảo mật:

- **Stack:** thêm `string-width` (hàng "Giao diện terminal"), `node-pty` và `@xterm/headless` (hàng "Kiểm thử") vào
  [SPEC §17.2](../../SPEC.md#172-stack), theo yêu cầu "đổi baseline cần sửa SPEC §17".
- **Trust boundary:** quyền vẫn kiểm ở application service. Việc giao diện làm mờ thao tác chỉ là trình bày.
- **Secret:** `project_list` và `run_options` không trả `credential_refs`, `tool_paths`, `access_tokens` hay đường dẫn token.
- **Migration:** chạm store nên phải qua typecheck, lint, test, build và có test migration.
- **Hành trình S01–S10:** không thêm mã mới; các hành trình cũ vẫn truy vết qua CLI như trước.

## Thiết kế chính

```text
cusr.ts ── TTY và không tham số ──▶ src/tui/main.ts ──▶ runtime (terminal, timers, daemon port)
   │                                                    │ messages        ▲ effects
   └─ còn lại ──▶ runCli (không đổi)                    ▼                 │
                                                   reducer thuần ──▶ view thuần ──▶ frame ──▶ diff ANSI
```

- **Vào giao diện (FR-001, FR-002):** `cusr.ts` chỉ rẽ nhánh khi `argv` rỗng, stdin và stdout đều là TTY và `TERM` không
  phải `dumb`; module giao diện được nạp bằng `import()` động để lệnh con không tốn thêm thời gian khởi động và không đổi
  hành vi. Các trường hợp khác đi thẳng vào `runCli`.
- **Client:** dùng lại `callDaemon`, `resolveDataDir` và `readClientToken` nên kết nối giống hệt lệnh con (FR-003). Mọi
  phản hồi đi qua schema Zod ở `src/tui/client/`; schema không khớp thành "không tương thích" (EC-010), không đoán nghĩa.
- **An toàn hiển thị (EC-001):** chuỗi từ daemon qua `sanitize()` để thành kiểu `SafeText`; hàm vẽ chỉ nhận `SafeText`, nên
  quên sanitize là lỗi biên dịch. Chữ cố định của giao diện dùng constructor riêng.
- **Thao tác ghi:** `MutationTracker` giữ request ID, payload, `expected_version` và trạng thái; xem
  [data model](data-model.md#thao-tác-đang-gửi). Dữ liệu cũ khóa thao tác mới nhưng không khóa đối chiếu (FR-044).
- **Thoát:** đường khôi phục terminal ghi đồng bộ và chạy một lần, dùng chung cho thoát thường, tín hiệu và lỗi nội bộ.
  Thao tác chưa rõ kết quả được in ra stderr sau khi rời màn hình toàn phần (EC-012).
- **Đọc mới phía daemon:** `project_list`, `run_options`, `task_board`, `task_content`, `task_progress`, `request_show`,
  cùng tham số `attempt_id` của `task_logs`. Chi tiết ở [hợp đồng CLI/daemon](contracts/cli-daemon.md).

## Đối chiếu bảng Phụ thuộc của spec

Đã đối chiếu với mã tại commit `0a33b84`; chi tiết và quyết định ở [R-05](research.md#r-05--đối-chiếu-bảng-phụ-thuộc).

| Nhu cầu | Quyết định |
| --- | --- |
| Liệt kê project | Query `project_list`, trả kèm vai trò và phạm vi của token |
| Profile, chế độ, binding | Query `run_options` theo từng task, tính bằng `freezePolicy` và `checkSelection`; profile chỉ chọn ở form tạo task |
| Bước, chế độ, thời gian ở trạng thái ở mức danh sách | Query `task_board`. Event không có cột thời gian nên `status_since` lấy từ trigger đã nhận |
| Danh sách bước theo chế độ | Query `task_progress`, đọc workflow đã đóng băng; chưa đóng băng thì trả `steps: null` |
| Thay đổi của `worktree_changed` | Mốc đầu không xem diff: dùng đường US4 số 4 đã cho phép, nói rõ và chỉ vị trí worktree |
| Tra request sau khi thoát | Query `request_show`, migration cột `project`, trạng thái `in_progress` lấy từ map `inFlight` của daemon |
| Đọc nội dung task theo revision | Query `task_content` trả nội dung, version và cấu hình chạy trong một lần đọc; không dùng `task history` |
| Log theo attempt | Thêm `attempt_id` vào bản ghi và tham số lọc của `task_logs`; cursor giữ nguyên |
| Chẩn đoán khi daemon chưa chạy | Mốc sau (US6). Mốc đầu chỉ báo lỗi kết nối, thử lại và thoát |

## Thứ tự giao

| Lát | Nội dung | Điều kiện qua lát |
| --- | --- | --- |
| 0 | Spike: PTY harness (`node-pty`, `@xterm/headless`) cài được bằng pnpm trên host; lõi terminal vào/ra alternate screen và khôi phục theo mọi đường thoát | Một test PTY thật đạt phần terminal của SC-011 |
| A | Đường đọc daemon và CLI: `project_list`, `task_board`, `task_progress`, `task_content`, `run_options`, `request_show`, migration 004, lọc log theo attempt | Test contract và integration đạt; test CLI cũ không sửa vẫn đạt |
| B | US1: màn hình chính, làm mới, dữ liệu cũ, kết nối lại | SC-002, SC-003, kiểm tra ngắn của SC-009 |
| C | US2 và US3: chi tiết, log, trợ giúp, gợi ý phím | SC-001, SC-005 (phần tự động), SC-010 |
| D | US4: `MutationTracker`, menu, trả lời, hủy, kiểm tra lại, duyệt; thoát khi còn thao tác chưa rõ | SC-007, SC-008, SC-014, SC-015 |
| E | US5: form tạo task, chọn cấu hình, màn xem lại, xác nhận | SC-004 (giả lập), SC-016 |
| F | Nghiệm thu mốc đầu: phiên dài, harness thật, người dùng mới, cập nhật skill `cusr` và tài liệu vận hành | Toàn bộ SC của mốc đầu, ghi vào acceptance report |

Lát A và B giao được độc lập nhưng phần chỉ đọc chưa đạt mốc đầu. Mỗi lát một hoặc vài PR nhỏ.

## Rủi ro

| Rủi ro | Cách xử lý |
| --- | --- |
| Poll làm daemon bận vì `better-sqlite3` chạy đồng bộ | `task_board` trả `unchanged` theo watermark; đọc state chỉ của task còn sống; đo trong SC-009 và SC-013 |
| Daemon restart lâu hơn cửa sổ tự thử (khoảng 2 phút) | Theo quyết định Q8: giữ phiên và bản nháp, chờ `Retry connection`; SC-003 ghi rõ cả hai trường hợp |
| Độ rộng emoji khác nhau giữa các terminal | Đo bằng `string-width`, kiểm trên tmux và terminal mục tiêu; sau mỗi lần đổi kích thước vẽ lại toàn bộ để không lưu lỗi lệch |
| `run_options` lệch vì ref base ở máy cũ hơn remote | Không `fetch` để giữ query nhanh; lúc bắt đầu daemon đọc base mới nhất, `checkSelection` vẫn chặn và task về PENDING có chẩn đoán (US5 số 8) |
| `node-pty` là native dependency | Chỉ dùng cho dev; kiểm ở lát 0, không đạt thì đổi sang helper Python `pty` theo [R-04](research.md#r-04--kiểm-thử-trong-pseudo-terminal) |
| `task_board` chậm dần khi có nhiều task đã kết thúc | Đếm theo SQL; chỉ đọc `state_json` của task đã kết thúc khi chúng nằm trong trang đang xem |

## Project Structure

### Documentation (this feature)

```text
specs/004-terminal-tui/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cli-daemon.md
│   └── tui.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── cli/
│   ├── cusr.ts          # rẽ nhánh vào giao diện
│   ├── projects.ts      # cusr project list
│   ├── requests.ts      # cusr request show
│   └── tasks.ts         # thêm task board, task content, task progress, task options
├── application/
│   ├── board.ts         # task_board, status_since
│   ├── progress.ts      # task_progress
│   ├── projects.ts      # project_list
│   ├── run-options.ts   # run_options
│   └── requests.ts      # request_show
├── explain/
│   └── needs-user.ts    # bảng DetailCode → cần người dùng (FR-007)
├── store/
│   └── migrations/004_command_project.sql
└── tui/
    ├── main.ts          # dựng runtime, chạy vòng lặp, thoát
    ├── terminal/        # alternate screen, raw mode, khôi phục, phím, cell buffer, diff, sanitize, độ rộng
    ├── client/          # daemon port, schema phản hồi, bộ lập lịch làm mới, kết nối lại, MutationTracker
    ├── model/           # state, message, reducer thuần, activity text
    └── views/           # home, task detail, logs, help, form, run config, review, answer, cancel, recheck, approve

test/
├── unit/tui/            # reducer, view, phím, sanitize, độ rộng; fuzz bằng fast-check
├── integration/runtime/ # query mới với daemon thật; migration; request_show khi crash
├── contract/cli/        # lệnh mới, output --json và exit code; cusr ngoài TTY
├── contract/tui/        # PTY + daemon thật + harness giả lập
├── reliability/tui/     # phiên 1 giờ và 8 giờ, cửa sổ kết nối lại, fuzz phím
├── smoke/               # hành trình với harness thật
└── support/             # pty.ts: PTY harness, phím có seed; control-proxy.ts: giữ hoặc bỏ phản hồi của daemon
```

**Structure Decision**: Giữ một package. `src/tui/` chỉ phụ thuộc `src/cli/client.ts`, `src/cli/output.ts` và kiểu dữ liệu
thuần; không import `src/store`, `src/engine` hay `src/daemon`. Quy tắc này được kiểm bằng ESLint `no-restricted-imports`
để giữ FR-036.

## Complexity Tracking

| Thêm vào baseline | Vì sao cần | Lựa chọn đơn giản hơn bị loại vì |
| --- | --- | --- |
| Runtime `string-width` | EC-004 cần đo đúng tiếng Việt, CJK và emoji theo grapheme | Tự viết bảng độ rộng phải cập nhật theo Unicode; `readline.getStringWidth` là API nội bộ của Node |
| Dev `node-pty` | Spec bắt buộc kiểm trong PTY thật, gồm đổi kích thước (EC-002) | `script` của util-linux không chuyển được đổi kích thước qua pipe; helper Python chỉ là phương án dự phòng |
| Dev `@xterm/headless` | Đối chiếu nội dung màn hình theo ô, gồm SC-010 | So chuỗi ANSI thô không chứng minh được ký tự nằm ở đâu trên màn hình |
| Module `src/tui/` với renderer riêng khoảng vài trăm dòng | FR-027, SC-008, SC-010 và SC-013 cần kiểm soát từng ô và phím | Ink kéo theo React và 23 dependency trực tiếp chỉ để có layout; xem [R-01](research.md#r-01--renderer) |
| Query mới thay vì dùng lại query cũ | SC-006 không cho sửa test CLI hiện có; `task_content` cần đọc nguyên tử | `task history` phải duyệt event và không gắn được với version trong một lần đọc |
