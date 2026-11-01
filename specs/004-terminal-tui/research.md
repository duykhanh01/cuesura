# Nghiên cứu thiết kế feature 004

Ngày đối chiếu: 2026-11-01, mã nền tại commit `0a33b84`. Thông tin package lấy từ npm registry cùng ngày. Đây là quyết
định thiết kế và danh sách bằng chứng cần thu khi triển khai; chưa có phần nào của giao diện được chạy thật.

## R-01 — Renderer

- **Decision:** Tự viết renderer nhỏ: cell buffer, diff từng dòng, layout theo cột và hàng, ô nhập văn bản, vùng cuộn. Chỉ
  thêm `string-width` 8.3 để đo độ rộng.
- **Rationale:** Giao diện có khoảng 10 màn hình dạng danh sách, chi tiết, log và form, không cần flexbox đầy đủ. Các yêu
  cầu khó nhất đều cần kiểm soát ở mức ô và phím: một điểm duy nhất nhận chuỗi đã sanitize (EC-001, SC-010), không có focus
  mặc định dẫn tới xác nhận (FR-027, SC-008), log dài với phản hồi dưới 200 ms (SC-013), khôi phục terminal đồng bộ theo
  mọi đường thoát (SC-011). Reducer và view thuần hợp với fuzz có seed. `string-width` chỉ kéo theo `strip-ansi` và
  `get-east-asian-width`.
- **Alternatives considered:**
  - **Ink 8 và React 19:** 23 dependency trực tiếp, gồm `react-reconciler` và `yoga-layout`; đổi lại có layout và kiểu
    component quen thuộc. Vẫn phải tự làm vùng cuộn, ô nhập và lớp sanitize, nên phần khó không giảm mà dependency tăng
    nhiều. Đây là lựa chọn nên xem lại nếu số màn hình tăng mạnh sau v1.
  - **`blessed`, `neo-blessed`:** registry ghi lần cập nhật cuối là 2024 và 2022; không đủ tin cậy để đưa vào baseline.
  - **Thuần Node, tự đo độ rộng:** ít hơn một dependency nhưng phải giữ bảng Unicode.
- **Bằng chứng cần thu:** lát 0 chạy thật; nếu renderer vượt khoảng 800 dòng ở lát C thì dừng và đánh giá lại với Ink.

## R-02 — Mô hình cập nhật dữ liệu

- **Decision:** Poll qua `POST /v1/query`, không thêm route stream. `task_board` nhận `if_changed_since` và trả
  `{ unchanged: true, watermark }` khi `MAX(global_seq)` chưa đổi.
- **Rationale:** [Hợp đồng hiện có](../002-task-to-green-pr/contracts/cli-daemon.md) quy định `--follow` chỉ là hỏi lại theo
  cursor và không có route stream; server chỉ có request/response. Mỗi request một kết nối nên daemon restart không để lại
  socket cũ. Watermark làm phiên rảnh gần như không tốn gì, nên giữ được SC-009 và FR-039.
- **Alternatives considered:** Server-sent events hoặc long poll cần sửa tầng transport, thêm giới hạn số kết nối và xử lý
  kết nối treo, trong khi SC-003 cho phép 3 giây. Watermark không lộ dữ liệu ngoài phạm vi token vì chỉ là một số thứ tự.

## R-03 — Làm mới và kết nối lại

- **Decision:**

  | Việc | Giá trị |
  | --- | --- |
  | Làm mới board và health | Mỗi 1 giây, tối đa một request đang chờ cho mỗi loại |
  | `project_list` của Home | Lần đầu, khi kết nối lại, đổi truy vấn Home hoặc token thay đổi; dùng lại dữ liệu đã đọc trong các lượt thường |
  | `task_show`, `task_progress` của task đang mở | Khi `version` của task đổi |
  | `task_explain` của task đang mở | Khi `watermark` đổi, và ít nhất 5 giây một lần |
  | Log khi theo dõi trực tiếp | Mỗi 1 giây, mỗi lần tối đa 200 bản ghi; chỉ màn log đang mở mới poll |
  | Timeout đọc board, health và `project_list` | 2 giây |
  | Timeout các đọc khác | 3 giây; `run_options` 5 giây vì đọc Git cục bộ |
  | Tự đối chiếu thao tác chưa rõ | Tối đa 60 lần `request_show` và 5 lần gửi lại mỗi vòng, chỉ tính khi đang kết nối |
  | Timeout ghi | 15 giây, bằng `DEFAULT_CLIENT_TIMEOUT_MS` |
  | Backoff kết nối lại | Gấp đôi từ 250 ms, trần 5 giây, không có jitter |
  | Số lượt tự thử mỗi vòng | 30, tương đương khoảng 2 phút khi socket từ chối ngay |

  Board, health và `project_list` khi cần đọc quyết định trạng thái kết nối: lần đầu thất bại vì kết nối hoặc timeout thì đánh dấu dữ liệu cũ. Đọc khác
  thất bại chỉ đánh dấu phần đó; nếu là dữ liệu của một task thì thao tác ghi trên task đó bị khóa theo FR-044. Mỗi lượt kết nối lại là
  một lần đọc thật, không có probe riêng: `task_board` không kèm `if_changed_since`, `GET /v1/health` và `project_list` chạy song song. Lượt thành công cần
  cả ba request; dữ liệu chi tiết task đang mở đọc đồng thời với timeout riêng và không giữ lượt lại. Hết 30 lượt thì dừng, chờ `Retry connection`; mỗi
  lần chọn bắt đầu một vòng 30 lượt mới. Lỗi `unauthenticated`, không đọc được token hoặc schema không tương thích thì dừng ngay.

- **Ngân sách SC-003:** tính từ lúc daemon sẵn sàng, tức `GET /v1/health` trả lời được, trong trường hợp xấu nhất:

  | Phần | Trần |
  | --- | --- |
  | Request của lượt trước đang treo đúng lúc daemon sẵn sàng | 2 giây |
  | Chờ backoff | 5 giây |
  | Lượt đọc thành công: board, health và `project_list` song song | 2 giây |
  | Dựng và ghi frame | 0,2 giây |
  | **Tổng** | **9,2 giây, dư 0,8 giây** |

  Sau `Retry connection`, không có hai phần đầu nên trần là 2,2 giây. Nếu lần đọc vượt 2 giây thì lượt đó thất bại và SC-003 được
  báo là chưa đạt, không nới timeout để che. Con số 2 giây phải được đo ở lát B với 100 task; nếu sát ngưỡng thì giảm dữ liệu trả về.
  SC-002 có ngân sách riêng: 2 giây tính từ lúc gõ `cusr`, gồm cả khởi động process, nên timeout đọc không phải là ngân sách của nó.

- **Rationale:** Không có jitter để giữ đúng trần: chỉ có một client nên không có đám đông kết nối lại. Giới hạn số lượt đúng nguyên
  tắc III của hiến chương và quyết định Q8. `task_explain` còn phụ thuộc hàng đợi chung, task prerequisite và thời gian hiện tại, nên
  `version` của task đứng yên vẫn có thể sai vị trí hàng đợi, trạng thái prerequisite và giới hạn còn lại. Hàng đợi và prerequisite đổi
  đều sinh event nên `watermark` bắt được ngay; chu kỳ 5 giây dành cho phần phụ thuộc thời gian, và giao diện hiện thời điểm đọc thay
  vì tự đếm ngược để không tự suy số liệu (FR-012).

- **Alternatives considered:** Tự thử không giới hạn đã bị loại ở Q8. Probe riêng trước khi đọc làm tăng ngân sách thêm một timeout.
  Đọc `task_explain` mỗi giây cho kết quả tươi hơn nhưng phải đọc toàn bộ event của task kể cả khi không có gì đổi.

- **Bằng chứng cần thu:** test PTY với server giữ kết nối không trả lời rồi chuyển sang daemon thật, đo đủ 10 giây; test đổi vị trí
  hàng đợi và hoàn tất prerequisite trong khi `version` của task đang mở không đổi.

## R-04 — Kiểm thử trong pseudo-terminal

- **Decision:** `test/support/pty.ts` chạy `cusr` thật qua `node-pty` và đưa output vào `@xterm/headless` để đọc màn hình theo
  ô, gửi phím và đổi kích thước, với daemon thật từ `test/support/daemon-task.ts` và harness giả lập. Harness chạy trong
  project `default` nếu đủ nhanh.
- **Rationale:** Spec cấm tuyên bố đạt bằng kiểm thử dựng màn hình tách rời. Xterm headless cho biết chính xác ký tự ở ô
  nào, nên kiểm được SC-010 và EC-002. Project `default` có `testTimeout` 60 giây, nên test phải chờ thời gian thật như cửa sổ kết nối lại và
  fuzz 10.000 phím nằm ở project `reliability`; phần logic tương ứng có test nhanh với clock tiêm vào.
- **Alternatives considered:** `script` của util-linux không đổi kích thước được qua pipe. Helper Python `pty` là phương án
  dự phòng nếu `node-pty` không cài được trên Node 24.22.1 trong lát 0. So chuỗi ANSI thô không chứng minh vị trí.
- **Phân tầng bằng chứng:**

  | Tầng | Dùng cho | Không dùng để |
  | --- | --- | --- |
  | Reducer và view thuần | Hồi quy nhanh, fuzz rộng | Tuyên bố đạt SC |
  | PTY với daemon thật, harness giả | Phần lớn SC-001 đến SC-016 | Thay harness thật ở SC-004 |
  | Project `reliability` | SC-008, SC-009, SC-013, cửa sổ kết nối lại của SC-003 | Chạy trong `pnpm test` |
  | Harness thật, người thật | SC-004, SC-005 | Tự động hóa rồi coi tương đương |

## R-05 — Đối chiếu bảng Phụ thuộc

Spec yêu cầu xác minh lại bảng Phụ thuộc trước khi thiết kế. Kết quả:

| Nhu cầu | Bằng chứng trong mã | Quyết định |
| --- | --- | --- |
| Liệt kê project | [`task-control.ts`](../../src/daemon/task-control.ts) không có query project; config có `projects` | `project_list`, lấy từ config đang chạy và lọc theo token |
| Profile, chế độ, binding | [`freezePolicy`](../../src/policy/freeze.ts) lấy profile từ `task.profile` hoặc `cusr.yaml`, chọn binding theo `when` trên task; [`checkSelection`](../../src/application/run-config.ts) yêu cầu lựa chọn khớp policy | `run_options` theo từng task; xem R-07 |
| Hàng danh sách | [`taskList`](../../src/application/queries.ts) chỉ trả status, wait code, version, priority, PR, head | `task_board`; không đổi `task_list` |
| Thời gian ở trạng thái | Bảng `events` không có cột thời gian; `accepted_triggers.envelope_json` có `now` | Xem R-06 |
| Danh sách bước | `FrozenPolicy.workflow` có `start`, `steps`, `next`; [`software-dev.ts`](../../src/engine/workflows/software-dev.ts) dựng graph theo chế độ | `task_progress`; xem [data model](data-model.md#tiến-trình-bước) |
| Diff `worktree_changed` | Query chỉ đọc projection và event, không có I/O ngoài; `worktree_path` nằm trong context đóng băng | Không thêm git I/O vào query ở mốc đầu; `task_progress` trả `worktree_path` |
| Tra request | [`command_ledger`](../../src/store/commands.ts) có actor, loại, task, trạng thái, kết quả; `inFlight` nằm trong [`main.ts`](../../src/daemon/main.ts); `pendingCommands` không có caller ở production | `request_show`; xem R-08 |
| Nội dung task | `taskView` chỉ trả `title`; `task_history` có nội dung trong `TaskCreated`, `TaskRevised` | `task_content`; xem R-09 |
| Log theo attempt | `LogEntry` có `operation_id`, `step`; `operations[id].attempt_id` có trong state | Thêm `attempt_id` và tham số lọc |
| Quyền của token | `trustedConfirmer` dựa trên `issued_by`, chỉ daemon biết | `project_list` trả `roles`, `trusted_confirmer`, phạm vi |

## R-06 — `status_since`

- **Decision:** Tìm event mới nhất làm đổi status của task, lấy `causation.dedup_key`, đọc `now` trong `envelope_json` của
  `accepted_triggers`. Kết quả được nhớ trong process theo cặp `(task_id, version)`. Không xác định được thì trả `null`, và
  giao diện ghi "không có dữ liệu", không đoán.
- **Rationale:** Không thêm cột vào `events`, không sửa `evolve`, không đụng hash. Bộ nhớ đệm mất khi restart chỉ làm lần đọc
  đầu chậm hơn, và không phải nguồn sự thật.
- **Alternatives considered:** Thêm `status_since` vào `TaskState` phải sửa `evolve` và ảnh hưởng replay của log cũ. Dùng
  thời điểm client thấy đổi status là sai sau khi mở lại giao diện.
- **Bằng chứng cần thu:** test với task đã restart daemon và task từ log cũ.

## R-07 — Nguồn của `run_options`

- **Decision:** `run_options` nhận `task_id` và chạy đúng code sẽ chạy lúc bắt đầu task, không tự suy từ config:
  1. Đọc user config bằng loader của preflight, và đọc `cusr.yaml` từ ref base đã có ở máy, bằng hàm đọc của preflight, không `fetch`
     và có timeout. Base không đọc được thì trả `options_unavailable`.
  2. Xác định profile bằng `task.profile ?? project.profile`. Không có thì trả `config_invalid` với hướng dẫn đặt profile.
  3. Với mỗi chế độ được phép và mỗi binding khai báo của role worker và reviewer, tối đa 64 tổ hợp, gọi `freezePolicy` với task đó rồi
     `checkSelection`. Chỉ trả tổ hợp qua được, kèm các nấc ladder dùng làm dự phòng.

  Profile chỉ chọn ở form tạo task qua `task.profile`; `project_list` trả tên các profile để form liệt kê. Sau đó profile chỉ hiển thị.
- **Rationale:** `freezePolicy` lấy profile từ `task.profile` hoặc `cusr.yaml` chứ không từ đề xuất, nên đề xuất profile khác sẽ bị
  `checkSelection` từ chối lúc bắt đầu. Binding còn phụ thuộc `when` trên nhãn, size và loại task, và coder với fixer phải cùng một lựa
  chọn, nên danh sách chỉ đúng khi tính theo từng task. Dùng lại code thật thì danh sách không thể lệch quy tắc.
- **Alternatives considered:**
  - Danh sách theo project chỉ từ user config: đơn giản nhưng đưa ra lựa chọn chắc chắn bị từ chối.
  - Cho đổi `task.profile` lúc đề xuất: cần thêm mutation sửa task và đổi mô hình revision, ngoài phạm vi feature.
  - `fetch` trước khi đọc: tốn mạng và có thể chậm. Ref cũ chỉ làm danh sách lệch tạm thời; lúc bắt đầu daemon đọc base mới nhất và
    `checkSelection` vẫn chặn, task về PENDING có chẩn đoán (US5 số 8).
- **Bằng chứng cần thu:** property test: với config và task mẫu, mọi lựa chọn được trả đều qua `checkSelection` và không có tổ hợp hợp lệ
  nào bị bỏ sót trong giới hạn. Comment trong `schema-user.ts` nói `cusrd` không đọc chỉ dẫn cần được sửa: daemon chuyển nguyên văn chứ
  không dùng để quyết định.

## R-08 — `request_show`

- **Decision:**
  - Migration 004 thêm `command_ledger.project TEXT`; backfill theo `tasks` với hàng có task. `admitCommand` ghi `project` ở
    lần đầu. Hàng cũ không xác định được project thì chỉ token phạm vi `*` đọc được.
  - Query được đăng ký trong `startDaemon` vì cần `inFlight`. `completed` khi đã có kết quả; `in_progress` khi có trong
    `inFlight`; còn lại là `interrupted`.
  - Task ID chỉ trả khi `store.readTask` có task đó. Actor khác hoặc project ngoài phạm vi trả đúng `request_not_found`.
- **Rationale:** Ledger không lưu payload nên daemon không thể tự chạy tiếp một request dở; `interrupted` là trạng thái thật.
  Project cần cho cả thao tác bị từ chối, khi chưa có task để suy ra.
- **Alternatives considered:** Cho daemon tự chạy lại `pendingCommands` khi khởi động là không thể vì không có payload, và lưu
  payload sẽ làm ledger giữ nội dung nghiệp vụ. Suy project từ task, không migration, thì mất project của thao tác bị từ chối.
- **Phiên đang mở:** Khi chưa rõ kết quả, `MutationTracker` gọi `request_show` trước: `completed` thì dùng kết quả;
  `in_progress` thì chờ; `not_found` hoặc `interrupted` thì gửi lại đúng request ID và payload. Theo nguyên tắc III, mỗi vòng có tối đa
  60 lần `request_show` và 5 lần gửi lại (khớp "2–5 lần" của SC-007); hết trần thì chuyển sang `unresolved`, dừng tự động và chờ người
  dùng chọn `Check again` để bắt đầu một vòng mới với cùng trần. Lúc mất kết nối không tính lượt, vì đã có giới hạn của R-03.
- **Điểm gây lỗi cho test:** không thêm crash point. `CUSR_CRASH_AT=before_commit` cho daemon chết trước khi ghi task, `after_commit` cho
  daemon chết sau khi ghi task nhưng trước `completeCommand`. "Xong rồi mất phản hồi" dùng proxy socket trong test, không có hook trong mã
  chạy thật.

## R-09 — `task_content`

- **Decision:** Query mới trả nội dung task, `version`, `revision`, `intake_pending` và `run_config` trong một lần đọc state. Phạm vi
  xác nhận theo [bảng trong data model](data-model.md#phạm-vi-xác-nhận): selection và digest chỉ được kiểm khi phạm vi có cấu hình
  chạy; xác nhận intake riêng dùng được khi `run_config` là `null` (FR-017). Lệnh xác nhận gửi đúng `version` đã đọc.
- **Rationale:** Một lần đọc bảo đảm nội dung, cấu hình và version cùng thuộc một trạng thái; daemon từ chối nếu task đổi sau
  đó, đúng FR-026 và SC-016. `intake_pending` là `needs_confirmation && !confirmed`, vì `needs_confirmation` trong state vẫn đúng
  sau khi đã xác nhận. Token không phải kênh tin cậy mà gửi digest sẽ bị engine từ chối, nên phạm vi phải tính cả `trusted_confirmer`.
- **Alternatives considered:** `task_history` phải đọc qua các trang tối đa 500 event để tìm `TaskRevised` mới nhất, rồi vẫn cần
  `task_show` riêng cho version, nên có cửa sổ lệch. Thêm trường vào `task_show` có thể làm test CLI cũ phải sửa.

## R-10 — Cần người dùng xử lý (FR-007)

- **Decision:** Thêm bảng `Record<DetailCode, boolean>` ở `src/explain/needs-user.ts`, không suy từ `allowed_actions`. Xem
  [data model](data-model.md#nhóm-cần-bạn-xử-lý).
- **Rationale:** `allowed_actions` không đủ phân biệt: `checks_incomplete` có `merge_manually`, còn `rate_limited` có
  `fix_external`, nhưng cả hai đều đang chờ trong giới hạn nên FR-007 không cho vào nhóm. `Record` buộc mọi mã mới phải được
  phân loại, nếu không sẽ lỗi biên dịch.

## R-11 — Xác nhận không thể do phím ngẫu nhiên

- **Decision:** Xác nhận cấu hình chạy, hủy và kiểm tra lại `worktree_changed` đòi gõ đúng một từ (`confirm`, `cancel`,
  `accept`) vào ô riêng rỗng rồi bấm Enter. Trong ô này, Enter chỉ gửi khi nội dung đúng bằng từ đó; sai thì giữ nguyên và báo lỗi tại
  chỗ, không sang trường khác. Không nhận paste; từ không được điền sẵn; `Ctrl-S` không có tác dụng.
- **Rationale:** Đáp ứng FR-022, FR-027 mà không cần focus đặc biệt. SC-008 kiểm bằng cách đối chiếu trace: mọi command thuộc
  ba loại này phải đi sau màn xem lại và đúng chuỗi xác nhận. Xác suất phím ngẫu nhiên gõ trúng từ là rất thấp nhưng không phải
  bằng 0, nên test kiểm trace chứ không kiểm "không bao giờ gửi".
- **Alternatives considered:** Tổ hợp phím như Ctrl+Y dễ trúng khi fuzz và khó nhớ; một phím `y` vi phạm FR-022.

## R-12 — Terminal và đường thoát

- **Decision:** Vào: raw mode, alternate screen, ẩn con trỏ, bracketed paste; không bật chuột. `SIGINT`, `SIGTERM`, `SIGHUP`,
  `uncaughtException`, `unhandledRejection` và lỗi ghi stdout đều gọi một hàm khôi phục chạy một lần bằng `fs.writeSync`. Ctrl-C
  trong raw mode đi vào như phím: thoát ngay, trừ khi form còn nội dung thì hỏi lại và lần Ctrl-C thứ hai thoát. `SIGCONT` thì
  vào lại alternate screen và vẽ lại toàn bộ.
- **Rationale:** Ghi đồng bộ để chuỗi khôi phục không mất khi process kết thúc. `SIGKILL` không bắt được nên không nằm trong
  SC-011; người dùng cần `reset`, được ghi trong tài liệu vận hành.
- **Bằng chứng cần thu:** so `stty -g` và chế độ alternate screen trước và sau ở mỗi đường thoát trong lát 0.

## R-13 — Sanitize

- **Decision:** Thay C0, C1, DEL và ký tự điều khiển hướng chữ Unicode (`U+202A`–`U+202E`, `U+2066`–`U+2069`) bằng ký hiệu nhìn
  thấy được. Giữ ZWJ, ZWNJ và dấu kết hợp vì chúng cần cho tiếng Việt và emoji. Tab thành khoảng trắng; xuống dòng chỉ giữ
  trong vùng nhiều dòng. Thực hiện ở biên `client`, cho cả log, câu hỏi, tiêu đề và thông báo lỗi.
- **Rationale:** Ký tự điều khiển hướng chữ có thể làm đảo nội dung trên màn xác nhận dù không phải chuỗi ANSI.
- **Bằng chứng cần thu:** bộ mẫu của SC-010 chạy qua PTY và đối chiếu từng ô.

## R-14 — Terminal không đủ khả năng

- **Decision:** `TERM=dumb` hoặc không đặt `TERM` được coi là không phải terminal tương tác: giữ hành vi CLI hiện tại. Dưới 80×24
  thì giao diện báo cần mở rộng và vẫn cho thoát (EC-002). `NO_COLOR` hoặc terminal ít màu không dùng màu; mọi trạng thái luôn có
  ký hiệu chữ nên giao diện không phụ thuộc màu (FR-035).
- **Rationale:** Terminal `dumb` không có alternate screen; mở giao diện ở đó sẽ làm hỏng output.
