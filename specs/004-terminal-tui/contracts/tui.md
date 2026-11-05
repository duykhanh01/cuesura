# Hợp đồng giao diện terminal

Mô tả hành vi người dùng thấy và kiểm được qua PTY. Đây là hợp đồng cần triển khai. Chữ trên giao diện là tiếng Anh. Bố cục chi
tiết có thể đổi khi triển khai miễn giữ các quy tắc dưới đây; từ khóa và phím trong bảng là hợp đồng để kiểm thử.

## Màn hình

| Màn hình | Nội dung | Vào từ |
| --- | --- | --- |
| Home | Thanh trạng thái (daemon, slot, hàng đợi, cập nhật cuối, bộ lọc project), nhóm `Needs you`, danh sách task | Mở `cusr` |
| Task detail | Hoạt động, tiến trình bước, lý do chờ, lối ra, attempt, PR, bằng chứng, lịch sử | Enter trên một task |
| Logs | Log trực tiếp hoặc theo attempt | `l` trong Task detail |
| Actions | Menu thao tác của task | `a` trên một task |
| New task | Form tạo task; profile là tùy chọn, mặc định `Project default`; dependency chọn từ danh sách task, không nhập ID | `n` ở Home |
| Run config | Hiện profile của task; chọn chế độ, worker, reviewer, dự phòng; nhập lý do, tối đa 2.000 ký tự | `Propose run` trong Actions |
| Review | Toàn bộ nội dung theo FR-026, bước xác nhận riêng | `Confirm` trong Actions |
| Answer, Cancel, Recheck, Approve | Hộp thoại của từng thao tác | Actions |
| Help | Toàn bộ phím theo ngữ cảnh | `?` |
| Disconnected | Lý do, thời điểm cập nhật cuối, trạng thái thử lại, `Retry connection` | Banner trên mọi màn hình khi dữ liệu cũ |

Danh sách thao tác của Actions lấy từ `allowed_actions` của `task_explain` đọc tại lúc mở. Ánh xạ:

| `action` | Trên giao diện |
| --- | --- |
| `answer`, `confirm`, `propose`, `approve`, `cancel`, `recheck` | Hộp thoại tương ứng; làm mờ kèm lý do nếu token không đủ quyền |
| `merge_manually` | Hướng dẫn merge trên GitHub, method và nội dung đề xuất; không có thao tác gửi |
| `fix_external`, `wait` | Dòng thông tin từ `note` |
| `task_add` | Mở New task, là task độc lập |

Trường `command` chỉ để hiển thị, giao diện không phân tích chuỗi này.

## Phím

Luôn có hiệu lực ngoài ô nhập, và luôn được hiện ở thanh gợi ý (FR-033):

| Phím | Tác dụng |
| --- | --- |
| `↑`, `↓`, `k`, `j` | Di chuyển |
| `PgUp`, `PgDn`, `g`, `G` | Cuộn trang, đầu, cuối |
| `Enter` | Mở mục đang chọn. Ngoài ô xác nhận, không bao giờ xác nhận thao tác có hậu quả |
| `Esc` | Quay lại; rời hộp thoại mà không gửi |
| `a` | Mở Actions |
| `f` | Bộ lọc project và status |
| `?` | Help |
| `R` | `Retry connection` khi đang chờ người dùng |
| `C` | `Check again` với thao tác chưa rõ đã hết lượt tự đối chiếu |
| `q` | Thoát; hỏi lại nếu còn nội dung đang nhập |
| `Ctrl-C` | Thoát, không hủy task; hỏi lại nếu còn nội dung đang nhập, lần thứ hai thì thoát |

Trong Logs thêm: `Space` tạm dừng hoặc tiếp tục; `F` về theo dõi trực tiếp; `t` chọn attempt. Log của task đã kết thúc
ghi `Finished` thay cho `Live`/`Paused` và không có `Space`; `F` chỉ còn tác dụng khi đang đọc một attempt.
Danh sách chọn attempt gom theo giai đoạn: Build, mỗi lượt review mở một `Round N` cùng các lượt fix
nó yêu cầu, rồi CI và merge, theo thứ tự attempt bắt đầu; một step chạy liền nhiều lần gộp thành một dòng
`×N`. Dòng vòng thu gọn chỉ nêu điểm khác một lượt review và một lượt fix thông thường; `Whole log` cách
các vòng một dòng trống. Lần đầu mở, con trỏ ở dòng đầu và chỉ vòng mới nhất mở ra; đang đọc một attempt thì danh sách mở trên
attempt đó. `←`/`→` (`h`/`l`) thu gọn hoặc mở một vòng; `Enter` đọc attempt, trên dòng vòng thì thu gọn hoặc
mở. `Esc` đi ngược: từ một attempt về danh sách, từ danh sách về toàn bộ log, từ toàn bộ log về Home.

Trong ô nhập, mọi phím in được đều là văn bản (FR-034): `Tab` sang trường kế, `Shift-Tab` về trường trước, `Ctrl-S` gửi, `Esc` rời
không gửi. `Enter` xuống dòng ở ô nhiều dòng và sang trường kế ở ô một dòng. Bracketed paste đưa nguyên khối vào ô như văn bản; xuống
dòng trong đó không kích hoạt gửi.

## Xác nhận

| Thao tác | Cần trước khi gửi | Từ phải gõ |
| --- | --- | --- |
| Xác nhận intake, cấu hình chạy hoặc cả hai | Màn Review với nội dung đọc thành công; phạm vi theo [data model](../data-model.md#phạm-vi-xác-nhận) | `confirm` |
| Hủy task | Lý do không rỗng, xem hậu quả | `cancel` |
| Kiểm tra lại `worktree_changed` | Cảnh báo nhận cây thư mục, vị trí worktree | `accept` |
| Duyệt escalation | Bước, nấc, lý do, giới hạn còn lại; quyền admin | `approve` |
| Trả lời, đề xuất cấu hình, tạo task, kiểm tra lại thường | Xem lại nội dung | Không; dùng `Ctrl-S` |

Trong ô xác nhận, `Enter` chỉ gửi khi nội dung đúng bằng từ yêu cầu; sai thì giữ nguyên và báo lỗi tại chỗ, không sang trường khác. `Ctrl-S` không có tác dụng ở
đây. Ô xác nhận rỗng khi mở, không nhận paste, không có hết giờ. Mở lại Review sau khi bộ lựa chọn đổi thì hiện khác biệt và xóa từ đã gõ
(FR-028).

## Dữ liệu cũ và mất kết nối

- Banner luôn hiện: `Data may be out of date — last updated HH:MM:SS`, kèm `Reconnecting (n/30)` hoặc `Retry connection (R)`.
- Daemon chết không làm giao diện thoát (SC-011).
- Khi dữ liệu cũ: lệnh gửi trả lời bằng thông báo tại chỗ; nội dung còn nguyên; điều hướng và thoát vẫn dùng được.
- Khi hồi phục: đọc lại task trước khi mở khóa. Task hoặc bộ lựa chọn đã đổi thì hiện thay đổi và yêu cầu người dùng gửi lại.
- Chỉ dữ liệu của một task đọc lỗi: đánh dấu phần đó là cũ và khóa thao tác ghi trên task đó; phần còn lại vẫn dùng được.

## Thao tác chưa rõ kết quả

- Hiện `Result unknown — checking` và request ID trong khi tự đối chiếu, tối đa 60 lần `request_show` và 5 lần gửi lại.
- Hết trần thì hiện `Result still unknown` với `Check again (C)`, không tự thử nữa; thao tác ghi mới trên task đó vẫn bị khóa.

## Thoát khi còn thao tác chưa rõ

Sau khi trả terminal, in ra stderr cho từng thao tác:

```text
cusr: request 019a0000-0000-7000-8000-000000000001 (task_add): result unknown
cusr: check it with: cusr request show 019a0000-0000-7000-8000-000000000001
```

Exit code của lần thoát này là 3 nếu còn thao tác chưa rõ, ngược lại là 0. Lỗi nội bộ của giao diện là 1.

## Hiển thị

- Tối thiểu 80×24; nhỏ hơn thì chỉ hiện thông báo cần mở rộng và phím thoát.
- Mọi trạng thái có ký hiệu chữ, không chỉ dựa vào màu; `NO_COLOR` tắt toàn bộ màu.
- Cắt ngắn theo độ rộng hiển thị với `…`; màn chi tiết luôn có nội dung đầy đủ.
- Token giới hạn project có ghi chú `Showing projects in this token's scope`.
- Usage không có dữ liệu ghi `unavailable`, không ghi 0.
