# Tài khoản mặc định là đăng nhập sẵn trên máy, cusr chỉ ghi vào đăng nhập của chính nó

Chủ dự án chốt sau spike của feature 006 ngày 2026-11-04.

Mỗi harness có một **tài khoản mặc định**: credential mà pin đang dùng, tức tài khoản đã đăng nhập sẵn trên máy. Nó được
tạo tự động cả khi nâng cấp lẫn khi cài mới, và được chọn trước tài khoản dự phòng cùng ưu tiên. cusr chỉ đọc credential
này, không ghi về, không xóa và không đăng nhập lại nó. Người dùng gỡ nó thì cusr không tạo lại.

Người dùng thêm **tài khoản dự phòng** bằng `cusr account add`. Lệnh chạy luồng login của chính CLI vendor
(`claude auth login`, `codex login --device-auth`) vào thư mục tạm, kiểm định dạng và danh tính, rồi chuyển vào thư mục
do cusr quản lý. cusr chỉ ghi vào các thư mục này. cusr không dùng chung credential với phiên tương tác hay công cụ khác
như Orca, không nhận đường dẫn tới credential có sẵn, và không nhập tài khoản từ công cụ khác. Vendor cấp cho mỗi lần đăng
nhập một phiên OAuth riêng, nên cusr và các công cụ đó cùng dùng một subscription mà không làm hỏng token của nhau.

Lý do. Người dùng hiểu ngay: tài khoản đang đăng nhập trên máy là tài khoản chính, tài khoản thêm vào là dự phòng; thêm
một tài khoản không đổi tài khoản đang dùng. Ghi vào credential của bên khác buộc cusr phải phối hợp khóa với từng vendor
và từng công cụ, và spike cho thấy có công cụ ghi credential mà không lấy khóa. Không phải người dùng nào cũng có những
công cụ đó.

Hệ quả. Tài khoản mặc định dùng chung credential với phiên tương tác, nên khi harness trong cusr làm mới token, phiên tương
tác hoặc lần chạy sau của cusr vẫn có thể bị đăng xuất như trước feature này. Khác trước ở chỗ task không kẹt: lỗi đăng
nhập của tài khoản mặc định chuyển task sang tài khoản dự phòng. Người dùng đăng nhập lại trên máy rồi chạy
`cusr account check`. Đổi sang tài khoản khác trên máy thì tài khoản mặc định tạm bị loại; `check` nhận danh tính mới.

Phương án bị loại:

- Coi credential của máy là tài khoản kế thừa tạm thời, ưu tiên tài khoản dự phòng và khuyên gỡ nó: ít rủi ro đăng xuất
  hơn nhưng khó hiểu, vì thêm một tài khoản lại đổi tài khoản đang dùng.
- Trỏ tài khoản tới credential của Orca hay của phiên tương tác rồi ghi về đó: phải phối hợp khóa với bên ghi ngoài cusr,
  và vẫn có cửa sổ ghi đè khi bên đó ghi mà không lấy khóa.

Đây là quyết định thiết kế cho feature 006, chưa mô tả tính năng đã triển khai. Nguồn: [FR-001 đến FR-006 trong
spec](https://github.com/duykhanh01/cuesura/blob/2fb370d/specs/006-account-pool/spec.md), [R-08 và R-11 trong research](https://github.com/duykhanh01/cuesura/blob/2fb370d/specs/006-account-pool/research.md) và [spike report](https://github.com/duykhanh01/cuesura/blob/2fb370d/specs/006-account-pool/spike-report.md).
