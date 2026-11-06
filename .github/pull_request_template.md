## Vì sao

<!--
Vấn đề hoặc nhu cầu, 1–3 câu. Dùng thuật ngữ trong GLOSSARY.md.
PR không làm qua cusr: ghi lý do (docs/dogfooding.md).
Xoá các chú thích này khi viết.
-->

## Thay đổi

<!--
Gạch đầu dòng theo hành vi người dùng hoặc hệ thống thấy được, không liệt kê từng file.
PR đổi cấu trúc (luồng gọi, chuyển trạng thái task, bố cục module, luồng giữa CLI, daemon,
worker và GitHub): thêm một phác thảo nhỏ nhất đủ rõ theo .agents/skills/write-pr/SKILL.md.
-->

## Bằng chứng

<!--
Cụ thể, có trước và sau: test nào trước đỏ nay xanh, output CLI, bản render màn hình TUI.
Không chép lại danh sách gate đã chạy; CI và gate đã ghi nhận chúng.
Ghi rõ điều chưa kiểm tra được và test hỏng có sẵn trên main.
-->

## Rủi ro khi merge

**Cửa:** <!-- một chiều | hai chiều -->

<!--
Hai chiều: revert là xong. Một chiều: revert để lại thứ không lùi được, ví dụ event hoặc state đã
ghi vào store theo định dạng mới, cusr.yaml hoặc config người dùng đã theo schema mới, assistant hay
script đã dựa vào contract CLI/daemon mới, dữ liệu đã xoá. Đổi schema hay contract chưa ai dùng thì
vẫn là hai chiều. Cửa một chiều thì nói rollback dừng ở đâu và cách đi qua an toàn.
-->

**Ảnh hưởng:** <!-- một cụm từ: phần nào hỏng nếu PR sai, vd "chỉ màn Logs", "mọi task đang chạy" -->
