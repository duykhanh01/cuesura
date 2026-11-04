# Hợp đồng ghi credential về nguồn

Áp dụng cho runner trong suốt attempt agent và cho recovery của daemon, với tài khoản `managed`. Tài khoản mặc định
(`system`) không bao giờ được ghi về. Quyết định nền ở [R-06](../research.md#r-06--ghi-credential-về-nguồn) và
[R-13](../research.md#r-13--khóa-nguồn-credential). Nội dung credential không bao giờ rời khỏi file: không vào log, event,
output hay thông báo (FR-025).

## Interface adapter

Mỗi harness có `CredentialFormat` trong `src/adapters/harness/`:

| Hàm | Hợp đồng |
| --- | --- |
| `readStable(home) → bytes` | Đọc credential trong một thư mục cấu hình mà không gặp file ghi dở: Codex đọc trong khi giữ `flock` trên `auth.lock` của thư mục đó; Claude đọc trực tiếp vì CLI thay file bằng `rename` |
| `validate(bytes) → ok \| {problem}` | JSON hợp lệ, đủ trường token bắt buộc, token không rỗng (bên thua khi làm mới đồng thời của Claude để lại token rỗng) |
| `identityOf(home) → {key, label} \| null` | Claude: `.claude.json`; Codex: `auth.json`; không gọi mạng (R-07) |

Runner và daemon chỉ gọi qua interface này; engine không thấy nó.

## Khi nào chạy

- Mỗi khi file credential trong private home đổi (`fs.watch`, cộng quét định kỳ vài giây làm dự phòng), để bản của bên
  thắng nằm trong nguồn trước khi daemon xét lỗi auth của bên thua (FR-018, FR-022).
- Một lần nữa trước khi xóa private home, ở mọi đường kết thúc.
- Trong recovery của daemon cho run `finished` và `lost`.

## Thủ tục

Đầu vào: `launch-state.json` của attempt (`account_id`, `source_digest`, `installed_digest` cho mỗi file auth) và bản trong
private home.

| Bước | Hành động | Kết quả nếu dừng ở đây |
| --- | --- | --- |
| 1 | Đi từng thành phần đường dẫn trong private home bằng `lstat`; không phải file thường thì dừng | `rejected: not_regular` |
| 2 | `readStable`; digest bằng digest đã ghi gần nhất (`installed_digest` hoặc lần ghi về trước) | `unchanged` |
| 3 | `validate` thất bại | `rejected: format` |
| 4 | `identityOf` khác `identity_key` của tài khoản | `rejected: identity` |
| 5 | Lấy khóa của tài khoản: `BEGIN EXCLUSIVE` trên `<DATA_DIR>/accounts/<account_id>/lock.sqlite`, chờ tối đa 5 giây. Giữ khóa tới hết bước 8 | `pending: lock_timeout` |
| 6 | Thư mục tài khoản không còn (tài khoản đã bị gỡ) | `account_missing` (bỏ bản của attempt, không tạo lại) |
| 7 | Digest nguồn khác `source_digest` | `superseded` (bỏ bản của attempt) |
| 8 | Ghi tmp `0600` cùng thư mục nguồn, fsync, rename đè nguồn, fsync thư mục, nhả khóa; cập nhật `source_digest` trong `launch-state.json` | `written` |
| 8′ | Lỗi I/O ở bước 8 | `pending: io` |

Với `pending`, bản mới được chuyển vào `<DATA_DIR>/accounts/<account_id>/pending/` trước khi private home bị xóa. Bản
trong private home luôn bị xóa sau lần chạy cuối, như hiện nay.

## Ánh xạ sang event tài khoản

| Kết quả | Event | Tài khoản |
| --- | --- | --- |
| `unchanged`, `written` | — / `AccountWriteSettled` | Không đổi |
| `superseded` | `AccountWriteSettled{superseded}` | Không đổi; event ghi lý do |
| `rejected: identity` | `AccountIdentityChanged` | Thêm nguyên nhân `identity_changed` |
| `rejected: not_regular \| format` | `AccountWriteSettled{rejected}` | Không đổi; `doctor` và `list` (admin) thấy lỗi |
| `pending` | `AccountWritePending` | Thêm nguyên nhân `pending_write` |
| `account_missing` | — | Không đổi; event của attempt ghi lý do |

Kết quả ghi không đổi outcome công việc của attempt (FR-022a, Q12).

## Thử lại bản chờ

Daemon thử lại trong vòng scheduler theo backoff lớp `infra`, hoặc ngay khi có `account_retry_write`. Mỗi lần thử chạy lại
bước 5–8, **bắt đầu bằng lấy khóa** như lần đầu, với `source_digest` đã lưu cùng bản chờ; không bao giờ ghi khi chưa giữ khóa. `written` hoặc `superseded` thì xóa bản chờ và gỡ `pending_write`.

## Recovery

| Trường hợp | Hành vi |
| --- | --- |
| Run `finished` khi daemon khởi động lại | `Invocation.recover` chạy thủ tục trước `removeAuth` |
| Run `lost` | Daemon chạy thủ tục trên private home còn lại rồi xóa auth; hiện tại auth nằm lại tới retention |
| Crash giữa rename (bước 8) và ghi outcome | Lần recovery sau thấy digest nguồn bằng digest bản trong home: coi là `written` |
| Crash khi bản chờ đã chuyển nhưng event chưa commit | Recovery quét `pending/` và ghi `AccountWritePending` một lần (dedup theo `attempt_id`) |
| Crash khi đang giữ khóa | Kernel nhả khóa khi process chết; lần lấy khóa sau thành công bình thường, không có bước thu hồi; tài khoản không kẹt `pending_write` |
| Nhiều bên cùng chờ khóa của process vừa chết | Kernel trao khóa cho đúng một bên; bên kia chờ hoặc hết `busy_timeout` |
