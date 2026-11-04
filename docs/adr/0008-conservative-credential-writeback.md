# Ghi credential có điều kiện vào thư mục của tài khoản

Chủ dự án chốt trong vòng grill và sau spike của feature 006 ngày 2026-11-04. Khi harness làm mới token trong private home,
cusr ghi bản mới về thư mục của tài khoản dự phòng ngay khi file đổi, không đợi attempt kết thúc. Mỗi lần ghi chỉ được
thực hiện khi nguồn vẫn đúng là bản mà bên ghi nhận lúc bắt đầu (compare-and-swap theo digest), dưới khóa của tài khoản.
Nguồn đã đổi thì giữ nguồn, bỏ bản của bên ghi và ghi event lý do. Thứ tự attempt kết thúc không chứng minh được thứ tự
token được làm mới, nên cusr không suy bản nào mới hơn.

Ghi sớm là bắt buộc. Spike cho thấy refresh token của cả Claude và Codex đều xoay sau mỗi lần làm mới, và khi hai attempt
của Claude cùng làm mới thì bên thua lỗi auth ngay. Bên thua chỉ được cứu (chạy lại bằng token mới) nếu bản của bên thắng
đã nằm trong nguồn trước khi daemon xét lỗi của nó.

Chỉ cusr ghi vào thư mục của tài khoản dự phòng, nên khóa của cusr là đủ. Khóa là `BEGIN EXCLUSIVE` trên một file SQLite
riêng của tài khoản, do kernel giữ và tự nhả khi process chết. cusr không phối hợp khóa với vendor hay công cụ khác, vì nó
không ghi vào credential của bên nào khác. Tài khoản mặc định không bao giờ được ghi về (ADR 0010).

Lỗi ghi khác với xung đột nguồn. Khi ghi thất bại, bản đã làm mới được giữ tạm trong vùng secret với quyền 0600, và nghĩa
vụ ghi lại bền qua restart. Tài khoản chưa được chọn tiếp, nhưng kết quả công việc của attempt vẫn được lưu. Nghĩa vụ này
không giữ slot, và không chặn task đi tiếp bằng tài khoản khác; nếu chỉ còn tài khoản chờ ghi thì task chờ lỗi vận hành có
backoff. Mỗi lần ghi lại lấy khóa từ đầu và vẫn áp dụng điều kiện nguồn không đổi. Thư mục tài khoản đã bị gỡ thì không tạo
lại. Ghi thành công chỉ gỡ nguyên nhân chờ ghi. Gỡ tài khoản xóa thư mục của nó, kể cả bản chờ ghi.

Đây là quyết định thiết kế cho feature 006, chưa mô tả tính năng đã triển khai. Nguồn: [FR-022 đến FR-024 trong
spec](https://github.com/duykhanh01/cuesura/blob/2fb370d/specs/006-account-pool/spec.md), [R-06 và R-13 trong research](https://github.com/duykhanh01/cuesura/blob/2fb370d/specs/006-account-pool/research.md) và [spike report](https://github.com/duykhanh01/cuesura/blob/2fb370d/specs/006-account-pool/spike-report.md).
