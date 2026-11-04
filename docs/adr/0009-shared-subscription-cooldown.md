# Các mục cùng subscription dùng chung trạng thái nghỉ

Chủ dự án chốt trong vòng grill feature 006 ngày 2026-11-04. Các mục tài khoản có cùng danh tính vendor nhận diện được dùng
chung trạng thái nghỉ hạn mức, kể cả khi thuộc các harness khác nhau:

- Claude: tài khoản và tổ chức trong `.claude.json`.
- Codex: `tokens.account_id` trong `auth.json`.

Nếu chỉ gắn nghỉ với tên khai báo, đổi sang alias có thể thử lại chính subscription đã hết hạn mức mà không tạo thêm khả
năng chạy. Mục chưa đọc được danh tính thì nghỉ riêng. Thêm một mục trùng danh tính vẫn được phép, kèm cảnh báo rằng nó
không tăng hạn mức.

Tạm ngưng, lỗi đăng nhập, đổi danh tính và chờ ghi credential vẫn thuộc từng mục khai. Các nguyên nhân chặn độc lập với
nhau, nên thao tác khôi phục chỉ gỡ nguyên nhân của nó; tài khoản chỉ được chọn khi không còn nguyên nhân chặn nào. Chia
sẻ trạng thái nghỉ không tăng số attempt chạy cùng lúc và không thay đổi binding.

Xóa nghỉ chỉ gỡ trạng thái đã biết lúc admin thực hiện thao tác. Báo hạn mức ghi nhận sau đó, kể cả từ attempt khởi chạy
trước thao tác, vẫn áp lại trạng thái nghỉ và ghi rõ lý do. Muốn chắc chắn một mục không được chọn tiếp thì tạm ngưng nó.

Đây là quyết định thiết kế cho feature 006, chưa mô tả tính năng đã triển khai. Nguồn: [FR-008, FR-011 và FR-012 trong
spec](https://github.com/duykhanh01/cuesura/blob/2fb370d/specs/006-account-pool/spec.md) và [R-07 trong research](https://github.com/duykhanh01/cuesura/blob/2fb370d/specs/006-account-pool/research.md).
