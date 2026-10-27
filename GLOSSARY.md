# Cuesura

Thuật ngữ miền dùng khi mô tả việc điều phối agent, giới hạn lượt chạy và thay đổi yêu cầu của task.

## Language

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
PR có gate, review và các kiểm tra CI bắt buộc đã đạt cho một head SHA cụ thể, với danh sách kiểm tra đã được đối chiếu đầy đủ. Đây là bằng chứng cho head đó, không phải quyền merge, trạng thái DONE hay bảo đảm branch đã cập nhật theo base mới nhất.
_Avoid_: Task đã xong, được phép tự merge, xanh vĩnh viễn cho mọi thay đổi của PR

**Slot thực thi**:
Quyền chiếm một suất để task chạy attempt agent hoặc bước chuẩn bị, setup, gate hay publish; khác với việc task còn chưa kết thúc. Task chỉ chờ người, CI, merge hoặc cooldown nhả slot khi công việc đang chạy đã kết thúc và được đối chiếu rõ, nhưng vẫn giữ worktree.
_Avoid_: Một task chưa kết thúc, giữ slot suốt vòng đời task, nhả slot đồng nghĩa xóa worktree

**Head đã kiểm**:
Head SHA của PR mà Cuesura đã có đủ gate, review và CI bắt buộc cho revision hiện tại. Head này không tự đổi theo push bên ngoài.
_Avoid_: Head hiện tại của PR, head mới nhất trên remote

**Merge chưa chứng nhận**:
Merge thủ công được xác nhận ở một head khác head đã kiểm, hoặc khi chưa có head đã kiểm. Task vẫn DONE vì merge đã xảy ra, nhưng Cuesura không chứng nhận chất lượng của head đã merge.
_Avoid_: Merge lỗi, task thất bại, PR xanh
