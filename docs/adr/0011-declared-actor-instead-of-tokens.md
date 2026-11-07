# Bỏ access token, caller tự khai actor

Chủ dự án chốt ngày 2026-11-05.

Daemon không còn dùng bearer token. Không còn `owner.token`, không còn `runtime.access_tokens` và không còn phạm vi
project theo token. Chỉ process cùng UID mở được socket điều khiển (thư mục 0700, socket 0600). Caller tự khai actor
qua `CUSR_ACTOR`, gửi lên daemon bằng header `x-cusr-actor`:

- Không khai hoặc khai `owner`: `owner`, quyền `read`, `operate`, `admin`.
- Khai `assistant`: `assistant`, quyền `read`, `operate`.
- Giá trị khác: CLI từ chối ngay, daemon trả 401.

Skill `cusr` đặt `CUSR_ACTOR=assistant` cho mọi lệnh. Mọi lệnh vẫn được ghi kèm actor.

Lý do. Token không tạo được ranh giới nào trên máy một người dùng. Người lạ đã bị chặn bởi file mode của socket. Worker
và assistant chạy cùng UID nên đọc được `owner.token`, hoặc sửa user config để tự cấp `admin`. Trước đây, thứ thật sự
giữ assistant lại là quy ước trong skill. Thứ token còn mang lại là ghi được ai đã làm gì và chặn assistant làm đúng
quy ước lỡ gọi `approve`. Actor tự khai cho đúng hai điều đó mà không cần tạo file secret, khai config hay restart
daemon. Bước cấp token cho assistant là chỗ người mới bị kẹt khi bắt đầu dùng.

Hệ quả. Assistant vẫn không approve escalation và không bật yolo (sửa đổi sau: từ #205 assistant duyệt được escalation
bằng quyền `operate`), nhưng đó là quy ước có daemon cưỡng chế với caller
khai đúng, không phải ranh giới bảo mật: process cùng UID bỏ `CUSR_ACTOR` là thành owner. Phạm vi project theo caller
không còn; mọi caller thấy mọi project trong config. Event cũ có `issued_by: token:<id>` vẫn đọc được; lệnh mới ghi
`issued_by: socket:<actor>`. Config cũ còn `runtime.access_tokens` vẫn khởi động được, daemon ghi một dòng log báo
khóa này bị bỏ qua.

Phương án bị loại:

- Giữ token và thêm lệnh `cusr access grant` để tự sinh token cho assistant: bớt ma sát lúc cài đặt nhưng giữ nguyên
  một cơ chế không bảo vệ được gì trên máy một người dùng.
- Phân biệt caller bằng UID của peer (`SO_PEERCRED`): chỉ có ý nghĩa khi assistant chạy bằng UID khác, điều chưa có
  trong v1.

Khi cần ranh giới thật, ví dụ kênh mạng như form hay HTTP qua Tailscale hoặc assistant chạy bằng UID khác, sẽ thêm xác
thực cho kênh đó. Nguồn: [hiến chương 7.0.0](../../.specify/memory/constitution.md), mục "Người gọi và quyền" trong
[deploy/README.md](../../deploy/README.md#người-gọi-và-quyền).
