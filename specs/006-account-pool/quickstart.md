# Validation guide: feature 006

Hướng dẫn kiểm chứng sau khi triển khai. **Trạng thái 2026-11-04:** chưa có phần nào được triển khai; các bước dưới đây là kế
hoạch, không phải bằng chứng. Tiêu chí chưa chạy phải được ghi là chưa đạt trong acceptance report.

## Chuẩn bị

```sh
pnpm install --frozen-lockfile
pnpm build
```

Chạy daemon theo [deploy/README.md](../../deploy/README.md) với một project sandbox. Mọi lệnh `cusr` dùng cùng
`CUSR_DATA_DIR` và token owner (có `admin`). Kịch bản tự động dùng fake harness có các chế độ: trả `rate_limited` kèm hoặc
không kèm `reset_at`, trả lỗi auth, ghi token mới vào credential trong private home, và chạy bình thường.

## Kiểm tra tự động

```sh
pnpm typecheck
pnpm lint
pnpm test:changed
```

CI chạy `pnpm test` đầy đủ. Các nhóm test mới nằm ở [plan](plan.md#source-code-repository-root).

## Kịch bản

| # | Kịch bản | Bước chính | Kết quả mong đợi | Spec |
| --- | --- | --- | --- | --- |
| 1 | Nâng cấp không đổi hành vi | Khởi động daemon mới trên dữ liệu có một pin, chạy một task; lặp lại với cài mới | `cusr account list` có `default`; task chạy như trước; test hiện có không phải sửa | Story 2 #1, SC-006 |
| 1b | Mặc định trước, dự phòng sau | Có `default`, thêm `work` không kèm `--priority`, chạy task; rồi cho `default` lỗi auth, chạy tiếp; sau đó `check claude default` | Attempt đầu chạy `default`; lỗi auth thì attempt sau chạy `work`; `check` đạt thì attempt kế tiếp quay lại `default` | Story 2 #2, #10; FR-002 |
| 1c | Đổi đăng nhập trên máy | Đổi danh tính trong credential của `default`, rồi `check claude default` | `default` bị chặn `identity_changed`, task chạy `work`; `check` nhận danh tính mới và gỡ chặn | Story 2 #8, FR-005a |
| 1d | Gỡ `default` | `cusr account remove claude default`, restart daemon | `default` không xuất hiện lại; file của người dùng còn nguyên | FR-003, FR-008 |
| 2 | Thêm tài khoản | `cusr account add claude --name work` với luồng login giả lập | Một lệnh, không sửa cấu hình, không tạo lại pin, không restart daemon; `list` thấy `work` sẵn sàng; credential nằm trong thư mục riêng của tài khoản | Story 2, SC-005 |
| 3 | Login hỏng | Hủy login, login lỗi, hoặc login giả lập tạo token rỗng | Exit 2 với mã lỗi cụ thể; không có tài khoản hay thư mục tạm nào còn lại | Story 2 #3, FR-005 |
| 4 | Chuyển khi hết hạn mức | Fake harness trả `rate_limited` reset sau 3 giờ trên A | Attempt kế tiếp chạy trên B trong 30 giây, không timer; A nghỉ đúng mốc; model, effort, binding giữ nguyên | Story 1 #1–3, SC-001, SC-002 |
| 5 | Mọi tài khoản nghỉ | A và B cùng bị giới hạn | Task chờ `accounts_cooling` tới mốc sớm nhất; một thông báo đợt; tới mốc tự chạy lại | Story 1 #4, #8 |
| 6 | Đánh thức sớm | Ở kịch bản 5, `cusr account clear-cooldown claude B` | Task chạy lại trong một vòng scheduler, không chờ mốc cũ; thông báo đợt chuyển `resolved` | Story 1 #9, FR-014b |
| 7 | Không quay vòng nóng | Fake harness trả `reset_at` quá khứ cho mọi tài khoản | Sau một vòng, task chờ backoff `rate_limit` | FR-016, Q18 |
| 8 | Restart khi đang nghỉ | Dừng daemon khi A nghỉ, khởi động lại | A không được chọn trước mốc | SC-008 |
| 9 | `use` và tạm ngưng | `cusr account use claude B` khi có attempt trên A | Attempt đang chạy giữ A; attempt sau dùng B | Story 2 #4, #7 |
| 10 | Quyền | Gọi lệnh thay đổi bằng token `operate` của một project | Exit 5; `list` vẫn chạy, chỉ thấy số liệu project được đọc, không có khóa `admin` | Story 2 #6, FR-007 |
| 11 | Ghi token mới | Fake harness ghi token mới vào private home | Nguồn là bản mới, `0600`; private home không còn auth | Story 3 #1–2 |
| 12 | Ghi đồng thời | 10 attempt cùng tài khoản kết thúc cùng lúc, 100 lần | Nguồn luôn là một bản hợp lệ đầy đủ; attempt ghi sau báo `superseded` | Story 3 #3, SC-004 |
| 13 | Đăng nhập lại khi attempt đang chạy | `cusr account login` trong lúc attempt trên tài khoản đó làm mới token | Bản đăng nhập mới không bị ghi đè; attempt báo `superseded` | Story 3 #4 |
| 14 | Ghi thất bại | Đặt nguồn trong thư mục chỉ đọc | Bản chờ ghi `0600`; tài khoản bị loại; task đi tiếp bằng tài khoản khác; sửa quyền rồi `retry-write` thì gỡ chờ ghi | Story 3 #6, FR-022a |
| 15 | Crash khi ghi | Crash injection giữa rename và commit | Recovery không ghi lặp, không mất token | R-06 |
| 16 | Lỗi auth | Fake harness trả lỗi auth trên A | A lỗi đăng nhập, attempt chạy trên B, inbox có mục cho A | Story 4 #1 |
| 17 | Token bị xoay ở nơi khác | Ghi token mới vào nguồn của A trong lúc attempt chạy, rồi trả lỗi auth | A không bị đánh dấu; chạy lại trên A; lần lỗi auth thứ hai thì đánh dấu | Story 4 #5, #6 |
| 18 | Đăng nhập lại sai danh tính | `cusr account login` với login giả lập ra danh tính khác | Exit 2 `identity_mismatch`; credential cũ giữ nguyên | Story 2 #8, FR-005a |
| 19a | Scheduler không phá backoff | Như kịch bản 7, theo dõi nhiều vòng scheduler trong lúc chờ backoff | Không có `account_ready` khi không có event làm tăng khả dụng; `clear-cooldown` trong lúc đó thì đánh thức | R-05, Q18 |
| 19b | Khóa sau crash | Giết runner khi đang giữ khóa nguồn, rồi chạy recovery và `retry-write` | Lần lấy khóa sau thành công ngay; ghi xong, tài khoản không kẹt `pending_write` | R-13 |
| 19b′ | Hai bên cùng chờ khóa của process vừa chết | Hai process thật chờ khóa của một process bị giết giữa bước ghi, lặp nhiều lần | Mỗi lần chỉ một bên ghi; nguồn luôn hợp lệ; bên còn lại `superseded` hoặc `lock_timeout` | R-13 |
| 19e | Đánh thức qua cooldown chung | A (harness `claude`) và B (harness khác) cùng danh tính; task chờ B; `clear-cooldown` qua A | Task chờ B chạy lại trong một vòng scheduler | R-05, FR-014b |
| 19c | Chuỗi auth theo tài khoản | Lỗi auth do token xoay trên A, chạy lại trên A lỗi tiếp nên chuyển B, B lỗi auth do token xoay, rồi quay lại A | A không được thử token mới lần thứ hai; B vẫn còn lượt thử của mình | FR-018, Q4 |
| 19d | Ghi ngay khi token đổi | Hai attempt cùng tài khoản, fake harness cho một bên làm mới thành công còn bên kia lỗi auth vì token đã bị tiêu | Bản của bên thắng nằm trong nguồn trước khi daemon xét lỗi của bên thua; bên thua chạy lại trên cùng tài khoản, tài khoản không bị đánh dấu lỗi đăng nhập | FR-018, FR-022 |
| 19 | Không lộ secret | Quét event, log, report, output CLI sau kịch bản 4–17 | Không có token hay nội dung credential | SC-007 |

## Harness thật (smoke)

Chạy riêng vì tốn usage, với hai tài khoản thật của cùng vendor:

- **SC-003:** 50 attempt liên tiếp trên một tài khoản; sau đó phiên tương tác dùng cùng nguồn vẫn đăng nhập được.
- Chuyển tài khoản thật khi chạm hạn mức nếu quan sát được; nếu không, ghi rõ là chỉ kiểm bằng fake harness.
- Kết quả spike S1–S4 ghi ở `spike-report.md` và được dẫn trong acceptance report.
