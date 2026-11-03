# Cuesura

Thuật ngữ miền dùng khi mô tả việc điều phối agent, giới hạn lượt chạy và thay đổi yêu cầu của task.

## Language

**Chế độ thực thi**:
Lựa chọn cách đưa kết quả task tới PR, do người dùng xác nhận trước khi chạy. Hai chế độ là `direct-pr` và `full-review`.
_Avoid_: Độ khó task, tự động suy chế độ từ kích thước

**Quy tắc dispatch**:
Chỉ dẫn do người dùng khai trong `projects.<id>.dispatch` (hoặc `runtime.dispatch` cho project không khai riêng) để assistant đề xuất profile, chế độ thực thi và binding cho một task. Daemon kiểm tra lựa chọn lúc nạp cấu hình nhưng không đọc điều kiện và không tự chọn; người dùng vẫn xác nhận từng lần chạy.
_Avoid_: Định tuyến tự động, chọn model theo kích thước

**Direct PR (`direct-pr`)**:
Chế độ đưa thay đổi qua gate và công bố PR mà không gọi reviewer; các kiểm tra CI và quyền merge vẫn áp dụng.
_Avoid_: Bỏ kiểm tra, tự merge

**Full review (`full-review`)**:
Chế độ yêu cầu reviewer độc lập kiểm tra thay đổi trước khi công bố PR; độc lập không đòi hỏi khác vendor.
_Avoid_: Bắt buộc hai vendor, tự review trong lượt code

**Effort**:
Mức suy luận được chọn cho model trong một lần chạy, trong phạm vi harness hỗ trợ.
_Avoid_: Thinking (tên khác cho cùng trường)

**Xác nhận cấu hình chạy**:
Sự đồng ý của người dùng cho một task với harness, model, effort và chế độ cụ thể, gồm reviewer khi cần.
_Avoid_: Đề xuất của agent, cờ xác nhận do agent tự khai

**Lượt agent giữ chỗ**:
Một phần hạn mức đã dành cho lần gọi agent dự kiến, chưa được xác nhận là đã thực sự gọi. Phần này không còn khả dụng cho lần gọi khác; chỉ được trả lại khi chắc chắn agent chưa chạy.
_Avoid_: Lượt agent đã dùng, lượt miễn phí khi chưa rõ kết quả

**Lượt agent đã dùng**:
Một lần gọi agent được xác nhận đã thực sự xảy ra, kể cả repair, resume hoặc lần bị rate limit. Một lượt giữ chỗ chuyển thành đã dùng khi có xác nhận này.
_Avoid_: Lượt giữ chỗ, chỉ tính lượt thành công

**Source drift**:
Sự thay đổi của yêu cầu nguồn sau khi task đã bắt đầu thực thi, đang cần người dùng quyết định cách áp dụng. Thay đổi này không tự thay thế revision mà task đang thực hiện.
_Avoid_: Tự cập nhật yêu cầu đang chạy

**Ranh giới an toàn cho revision**:
Điểm task không còn attempt đang chạy và mọi effect liên quan đã rõ kết quả, cho phép người dùng quyết định tiếp tục revision cũ, áp revision mới hoặc tạo task mới.
_Avoid_: Ngay khi phát hiện source drift, chỉ cần agent ngừng xuất log

**Áp revision mới**:
Lựa chọn thay yêu cầu đang thực hiện của cùng task tại ranh giới an toàn, giữ diff hiện có, ngân sách đã dùng, nấc model và thời hạn. Task được triage và thực hiện lại từ Code; bằng chứng của revision cũ không được dùng để duyệt revision mới.
_Avoid_: Tạo task mới, tiếp tục revision cũ, reset task

**Yêu cầu hủy đến quá muộn**:
Yêu cầu hủy mà việc đối chiếu xác nhận merge của task đã thành công; task được ghi nhận DONE cùng lịch sử yêu cầu hủy. Yêu cầu này không hoàn tác merge; đảo thay đổi là một quy trình revert riêng.
_Avoid_: Task đã hủy nhưng vẫn merge, hủy đồng nghĩa revert

**PR xanh**:
PR có gate và các kiểm tra CI bắt buộc đã đạt cho một head SHA cụ thể, cùng review nếu chế độ là `full-review`, với danh sách kiểm tra đã được đối chiếu đầy đủ. Bằng chứng ghi rõ chế độ; không phải quyền merge, trạng thái DONE hay bảo đảm branch đã cập nhật theo base mới nhất.
_Avoid_: Task đã xong, được phép tự merge, xanh vĩnh viễn cho mọi thay đổi của PR

**Slot thực thi**:
Quyền chiếm một suất để task chạy attempt agent hoặc bước chuẩn bị, setup, gate hay publish; khác với việc task còn chưa kết thúc. Task chỉ chờ người, CI, merge hoặc cooldown nhả slot khi công việc đang chạy đã kết thúc và được đối chiếu rõ, nhưng vẫn giữ worktree.
_Avoid_: Một task chưa kết thúc, giữ slot suốt vòng đời task, nhả slot đồng nghĩa xóa worktree

**Head đã kiểm**:
Head SHA của PR mà Cuesura đã có đủ gate, CI và review nếu được yêu cầu bởi chế độ đã xác nhận cho revision hiện tại. Head này không tự đổi theo push bên ngoài.
_Avoid_: Head hiện tại của PR, head mới nhất trên remote

**Thông báo logic**:
Một việc cần báo cho người dùng, như một câu hỏi chờ người hay một task vừa kết thúc. Thông báo giữ nguyên danh tính qua mọi lần thử lại, phục hồi và restart, nên cùng một việc không bao giờ thành hai thông báo.
_Avoid_: Tin nhắn, mỗi lần gửi là một thông báo

**Đợt gửi**:
Nhóm các lượt gửi của một thông báo logic dùng chung một giới hạn số lần thử và một thời hạn. Hết đợt mà chưa gửi được thì thông báo được ghi là thất bại; chỉ khi kênh hồi phục mới mở đợt mới.
_Avoid_: Một lần thử, thử lại không giới hạn

**Lượt gửi**:
Một lần thử chuyển nội dung của một thông báo logic tới kênh. Lượt gửi có thể thành công, thất bại hoặc không rõ kết quả.
_Avoid_: Đợt gửi, bản tin

**Bản tin**:
Một bản cụ thể của thông báo logic đang hiện trên kênh, ví dụ một tin Telegram. Lượt gửi không rõ kết quả rồi gửi lại có thể tạo nhiều bản tin cho cùng một thông báo; mọi bản tin đều quy về cùng câu hỏi hay yêu cầu.
_Avoid_: Thông báo logic, mỗi bản tin là một việc riêng

**Đồng bộ trạng thái cuối**:
Nghĩa vụ sửa các bản tin đã hiện trên kênh cho khớp kết quả xử lý (đã trả lời, đã duyệt, hết hiệu lực), kể cả khi câu hỏi hay yêu cầu đã đóng. Nghĩa vụ này độc lập với việc gửi thông báo mới.
_Avoid_: Gửi lại thông báo, thông báo kết quả

**Merge chưa chứng nhận**:
Merge thủ công được xác nhận ở một head khác head đã kiểm, hoặc khi chưa có head đã kiểm. Task vẫn DONE vì merge đã xảy ra, nhưng Cuesura không chứng nhận chất lượng của head đã merge.
_Avoid_: Merge lỗi, task thất bại, PR xanh
