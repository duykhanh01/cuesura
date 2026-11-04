# Tài khoản harness dùng chung toàn daemon, chỉ admin được thay đổi

Chủ dự án chốt trong vòng grill feature 006 ngày 2026-11-04: tài khoản là tài nguyên dùng chung của harness trên toàn daemon, không thuộc một project. Thêm, gỡ, tạm ngưng, bật lại, xóa nghỉ hay đổi ưu tiên, kể cả `account use`, đều cần quyền `admin`: cấp các thao tác này cho `operate` theo project sẽ cho phép người gọi tác động tới task ngoài phạm vi của mình. Quyền riêng cho assistant tự thay đổi tài khoản được để sau; mỗi attempt mới vẫn chọn theo trạng thái và ưu tiên hiện hành, trong khi binding và trần pool của task được giữ nguyên.

Quyền đọc được chia theo nội dung: tên, harness, ưu tiên và tình trạng khả dụng là metadata chung; số attempt, lần dùng gần nhất và danh sách task chỉ tính trên project người gọi được đọc. Danh tính vendor, đường dẫn credential và chi tiết lỗi filesystem chỉ admin thấy. Cùng quy tắc áp dụng cho list, doctor, report, TUI và thông báo để tài nguyên chung không làm lộ hoạt động của project ngoài quyền đọc.

Đây là quyết định thiết kế cho feature 006, chưa mô tả tính năng đã triển khai. Nguồn: [Clarifications, FR-007 và FR-008 trong spec](https://github.com/duykhanh01/cuesura/blob/2fb370d/specs/006-account-pool/spec.md) và [R-09 trong research](https://github.com/duykhanh01/cuesura/blob/2fb370d/specs/006-account-pool/research.md).
