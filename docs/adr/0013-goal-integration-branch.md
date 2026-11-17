# Goal nhiều đơn vị tích hợp trên nhánh goal do daemon ghi

Chủ dự án chốt ngày 2026-11-09 (feature 007, hiến chương 11.0.0).

Goal có từ hai đơn vị ra **một PR vào nhánh gốc**. Lúc xác nhận kế hoạch, daemon tạo nhánh goal
`goal/<8 ký tự đầu id>-<slug>` từ đỉnh nhánh gốc. Mỗi đơn vị là một task thường có `base_branch` là nhánh goal: worktree,
gate, review theo chế độ, PR vào nhánh goal, CI. Khi PR đơn vị đạt đủ kiểm tra của đường yolo (head chứa đỉnh nhánh goal,
required check của nhánh gốc xanh, review theo chế độ, bản miễn đã liệt kê), code merge nó vào nhánh goal bằng merge
commit với approver `policy:goal`, không chờ người và không đọc cờ yolo. Khi mọi đơn vị DONE, **task tổng** (workflow
`goal_final`, không có bước code) chạy gate, review toàn bộ diff của goal, CI và mở PR của goal vào nhánh gốc. PR đó theo
quy tắc merge hiện hành của nhánh gốc: người merge, hoặc yolo do chủ dự án bật.

Nhánh goal chỉ daemon ghi, từ lúc tạo tới khi task tổng start. Lịch sử first-parent của nó phải đúng bằng các merge commit
daemon đã ghi; mọi đường ghi (merge đơn vị, base update của đơn vị, start task tổng) kiểm điều này ngay trước khi ghi qua
một hàm thuần duy nhất, và mỗi nhánh goal có tối đa một merge đang bay. Đỉnh lệch (ai đó push tay, hay merge tay PR đơn vị
trên GitHub) thì không merge nữa và goal vào `replan` với lý do `goal_branch_drift`.

Lý do. Với N task mở PR thẳng vào nhánh gốc, chuỗi việc qua đêm dừng ở mỗi lần merge của người, và nhánh gốc có thể nhận
nửa feature trước khi phát hiện sai thiết kế. Nhánh goal cho đơn vị phụ thuộc bắt đầu ngay khi đơn vị trước đã merge vào
đó, còn nhánh gốc chỉ nhận goal hoàn chỉnh. Merge commit giữ ranh giới từng đơn vị trên first-parent, nên chủ dự án review
một PR theo từng đơn vị. Gần như không thêm cơ chế: base branch, phụ thuộc, base update, đường merge của yolo và observation
đều đã có. GitHub chỉ ghim head khi merge, không ghim base, nên bảo đảm "head chứa đỉnh nhánh goal lúc merge" dựa vào việc
chỉ daemon ghi nhánh goal và chỉ một merge đang bay, thay cho một lệnh merge có điều kiện mà GitHub không có.

Hệ quả:

- Goal nhiều đơn vị cần project có ít nhất một required check khai trong `cusr.yaml` (`ci.required_checks`): danh sách rỗng
  không bao giờ cho merge, nên kế hoạch như vậy bị từ chối `no_required_checks`. Project không khai chỉ chạy goal một đơn
  vị, đi thẳng vào nhánh gốc như task thường.
- Tên nhánh goal không được khớp `protected_branches` (`protected_goal_branch`). Bản miễn check CI dùng được cho PR vào
  nhánh goal, không dùng được cho PR vào protected branch.
- CI của repo phải chạy cho PR vào nhánh `goal/*`; workflow lọc `pull_request.branches` làm đơn vị đứng ở bước CI.

Phương án bị loại:

- N PR vào nhánh gốc, mỗi đơn vị một PR: dừng ở mỗi lần merge, nhánh gốc nhận nửa feature.
- Merge cục bộ bằng git plumbing rồi push vào nhánh goal: đi vòng qua PR, mất CI và review trên PR của đơn vị.
- Worktree xếp chồng từ HEAD của task cha: rebase dây chuyền khi task cha đổi.
- Auto-merge integration branch theo `auto_when` của `merge_gate` (thiết kế cũ ở architecture §8.7): chưa có ở runtime,
  và không có luật nào giữ nhánh đó chỉ do daemon ghi.

Nguồn: [spec feature 007](../../specs/007-deputy/spec.md) (FR-080–FR-088),
[research R-23, R-24, R-27 và "Quyết định khi làm lát E"](../../specs/007-deputy/research.md).
