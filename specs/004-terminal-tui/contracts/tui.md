# Hợp đồng giao diện terminal

Mô tả hành vi người dùng thấy và kiểm được qua PTY. Đây là hợp đồng cần triển khai. Chữ trên giao diện là tiếng Anh. Bố cục chi
tiết có thể đổi khi triển khai miễn giữ các quy tắc dưới đây; từ khóa và phím trong bảng là hợp đồng để kiểm thử.

## Màn hình

| Màn hình | Nội dung | Vào từ |
| --- | --- | --- |
| Home | Thanh trạng thái (daemon, slot, hàng đợi, cập nhật cuối, bộ lọc project), dòng `Queue paused` khi hàng đợi tạm dừng, nhóm `Needs you`, danh sách task | Mở `cusr` |
| Task detail | Hoạt động, tiến trình bước, lối ra, PR, kết quả kiểm tra. `i` mở phần kỹ thuật: mã lý do chờ, blocker, commit, attempt, rung, giới hạn đầy đủ, lịch sử event | `d` trong Logs |
| Logs | Log của bước mới nhất, trực tiếp, hoặc của một attempt đã qua | `l` trong Task detail |
| Actions | Menu thao tác của task | `a` trên một task |
| New task | Form tạo task; profile là tùy chọn, mặc định `Project default`; dependency chọn từ danh sách task, không nhập ID | `n` ở Home |
| Run config | Hiện profile của task; chọn chế độ, worker, reviewer, dự phòng; nhập lý do, tối đa 2.000 ký tự | `Propose run` trong Actions |
| Review | Toàn bộ nội dung theo FR-026, bước xác nhận riêng | `Confirm` trong Actions |
| Answer, Cancel, Recheck, Approve | Hộp thoại của từng thao tác | Actions |
| Pause, Resume, Continue | Hộp thoại tạm dừng (lý do, `--now`), tiếp tục, cho chạy tiếp; xem [Tạm dừng và tiếp tục](#tạm-dừng-và-tiếp-tục) | Actions |
| Pause the queue, Resume the queue | Hộp thoại tạm dừng (lý do) hoặc tiếp tục hàng đợi | `p` ở Home |
| Help | Toàn bộ phím theo ngữ cảnh | `?` |
| Disconnected | Lý do, thời điểm cập nhật cuối, trạng thái thử lại, `Retry connection` | Banner trên mọi màn hình khi dữ liệu cũ |

Danh sách thao tác của Actions lấy từ `allowed_actions` của `task_explain` đọc tại lúc mở. Ánh xạ:

| `action` | Trên giao diện |
| --- | --- |
| `answer`, `confirm`, `propose`, `approve`, `cancel`, `recheck`, `pause`, `resume`, `continue` | Hộp thoại tương ứng; làm mờ kèm lý do nếu token không đủ quyền |
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
| `p` | Ở Home: tạm dừng hàng đợi, hoặc tiếp tục khi hàng đợi đang tạm dừng; mở hộp thoại, không gửi ngay |
| `f` | Bộ lọc project và status |
| `?` | Help |
| `R` | `Retry connection` khi đang chờ người dùng |
| `C` | `Check again` với thao tác chưa rõ đã hết lượt tự đối chiếu |
| `Ctrl-L` | Vẽ lại toàn bộ màn hình, kể cả trong ô nhập; không đổi trạng thái nào |
| `q` | Thoát; hỏi lại nếu còn nội dung đang nhập |
| `Ctrl-C` | Thoát, không hủy task; hỏi lại nếu còn nội dung đang nhập, lần thứ hai thì thoát |

Trong Logs thêm: `Space` tạm dừng, bấm lại thì về theo dõi trực tiếp từ bất kỳ đâu (đang cuộn, đang đọc một attempt); `t` chọn attempt. Log của task đã kết thúc
ghi `Finished` thay cho `Live`/`Scrolled up`/`Paused` và `Space` chỉ còn tác dụng khi đang đọc một attempt.
Lời gọi tool, kết quả và ghi chú phiên mặc định gọn một dòng, kèm số dòng bị ẩn; `Ctrl-O` hiện đầy đủ. Lời agent, lỗi, cảnh
báo và output thường luôn đầy đủ; dòng lỗi có dấu `✗` ở lề trái. Task đang chạy mà im từ 1 phút ghi `last output … ago`,
từ 5 phút báo `No output for …: it may be stuck`.

Logs hiện từng bước một: mặc định là bước mới nhất, nhãn `latest step`. Toàn bộ log của task đọc bằng `cusr task logs`.
`←` và `→` sang attempt liền kề; `→` tới attempt cuối là quay về bước mới nhất. Đang theo dõi ở cuối log thì sang bước mới
ngay khi bước đó có bản ghi. Giao diện không tự chuyển bước khi người dùng đang đọc: cuộn lên thì giữ chỗ, cuộn về cuối mới
sang bước mới.

Cuộn lên hoặc `g` giữ nguyên chỗ đang đọc và ghi `Scrolled up`; có bản ghi mới thì dòng trống dưới vùng log báo
`↓ New messages · G to jump to the end`. Cuộn về cuối hoặc `G` thì tự theo dõi tiếp. Tạm dừng bằng `Space` ghi `Paused`;
tạm dừng hay đang đọc một attempt thì giữ nguyên cho tới khi bấm `Space` và báo hoạt động mới ở dòng đầu màn hình.

Giao diện không bắt chuột, nên bôi đen và copy vẫn do terminal xử lý. `p` ẩn hoặc hiện cột tiến trình để log chiếm hết chiều
rộng, vì bôi đen của terminal đi xuyên các cột. Con lăn đi qua chế độ alternate scroll (DECSET 1007):
terminal hỗ trợ sẽ gửi phím mũi tên.
Danh sách chọn attempt gom theo giai đoạn: Build, mỗi lượt review mở một `Round N` cùng các lượt fix
nó yêu cầu, rồi CI và merge, theo thứ tự attempt bắt đầu; một step chạy liền nhiều lần gộp thành một dòng
`×N`. Dòng vòng thu gọn chỉ nêu điểm khác một lượt review và một lượt fix thông thường; `Latest step` cách
các vòng một dòng trống. Lần đầu mở, con trỏ ở dòng đầu và chỉ vòng mới nhất mở ra; đang đọc một attempt thì danh sách mở trên
attempt đó. `←`/`→` (`h`/`l`) thu gọn hoặc mở một vòng; `Enter` đọc attempt, trên dòng vòng thì thu gọn hoặc
mở. `Esc` đi ngược: từ một attempt về danh sách, từ danh sách về bước mới nhất, từ bước mới nhất về Home.

Trong ô nhập, mọi phím in được đều là văn bản (FR-034): `Tab` sang trường kế, `Shift-Tab` về trường trước, `Ctrl-S` gửi, `Esc` rời
không gửi. `Enter` xuống dòng ở ô nhiều dòng và sang trường kế ở ô một dòng. Bracketed paste đưa nguyên khối vào ô như văn bản; xuống
dòng trong đó không kích hoạt gửi.

## Xác nhận

| Thao tác | Cần trước khi gửi | Từ phải gõ |
| --- | --- | --- |
| Xác nhận intake, cấu hình chạy hoặc cả hai | Màn Review với nội dung đọc thành công; phạm vi theo [data model](../data-model.md#phạm-vi-xác-nhận) | `confirm` |
| Hủy task | Lý do không rỗng, xem hậu quả | Không gõ từ; một phím `Y` (xem bên dưới) |
| Kiểm tra lại `worktree_changed` | Cảnh báo nhận cây thư mục, vị trí worktree | `accept` |
| Duyệt escalation | Bước, nấc, lý do, giới hạn còn lại; quyền operate (nhận PR có sẵn: admin) | `approve` |
| Trả lời, đề xuất cấu hình, tạo task, kiểm tra lại thường | Xem lại nội dung | Không; dùng `Ctrl-S` |
| Tạm dừng task hoặc hàng đợi | Lý do không rỗng | Không; dùng `Ctrl-S` |
| Tiếp tục task, cho task chạy tiếp, tiếp tục hàng đợi | Hộp thoại nêu `note` của action | Không; dùng `Ctrl-S` |

Trong ô xác nhận, `Enter` chỉ gửi khi nội dung đúng bằng từ yêu cầu; sai thì giữ nguyên và báo lỗi tại chỗ, không sang trường khác. `Ctrl-S` không gửi
ở đây, kể cả từ ô văn bản của hộp thoại có từ xác nhận; hộp thoại báo tại chỗ cách xác nhận. Ô xác nhận rỗng khi mở, không nhận paste, không có
hết giờ. Mở lại Review sau khi bộ lựa chọn đổi thì hiện khác biệt và xóa từ đã gõ (FR-028).

Hủy task (#307) chỉ có hai thao tác: nhập lý do, rồi `Y`. Lý do là ô một dòng. Rời ô lý do sang ô xác nhận bằng `Enter`,
`Ctrl-S` hoặc `Tab`: `Enter` và `Ctrl-S` không sang khi lý do rỗng và báo tại chỗ, còn `Tab` vẫn sang được ô xác nhận khi lý do
rỗng, nhưng ở đó `Y` không gửi và báo cần lý do cho đến khi lý do không rỗng. Ô xác nhận hỏi một câu nêu việc sẽ làm và phím:
`Y = yes, cancel it`, `N or Esc = no, go back (nothing is sent)`. Một phím `Y` hoặc `y` gửi ngay, không cần Enter. `N`, `n` hoặc
`Esc` rời hộp thoại không gửi và giữ lý do làm bản nháp. Enter, `Ctrl-S`, phím khác và paste không gửi, chỉ báo tại chỗ. Daemon
nhận thì menu Actions nói kết quả theo trả lời của daemon: `Cancelled` khi task đã CANCELLED, `Nothing changed` khi cancel đã có
từ trước (`already_cancelling`), hoặc PR chưa đọc được và task còn chờ. Các quy tắc về từ phải gõ ở đoạn trên áp dụng cho những
hộp thoại còn lại.

Task có cancel đang chờ đọc PR (`cancel_reconcile`) thì daemon chỉ còn mời `cancel --force`; cancel thường bị bỏ qua
(`already_cancelling`). Menu Actions gọi mục đó là `Force cancel (PR unread)`, hộp thoại `Force cancel task` nêu hậu quả (đọc PR
thêm một lần; không đọc được thì task CANCELLED mà không có lần đọc đó, PR có thể còn mở hoặc được merge sau, không gì trên GitHub
bị đổi; nên Recheck nếu GitHub có thể trả lời lại) và gửi `task_cancel` với `force: true`, cùng hai bước lý do rồi `Y`.

Mọi hộp thoại (Answer, Cancel, Recheck, Approve, tạm dừng, tiếp tục, hàng đợi) dùng chung một khung và một quy ước:

- Đầu hộp thoại: tên thao tác và task; hộp thoại của task ghi version sẽ gửi kèm (`Sent with version N`), hoặc báo
  task đã đổi version kể từ lúc mở thì sẽ không gửi. Hộp thoại của task chỉ mở khi `task_explain` và `task_show`
  của menu Actions cùng một version; version đó là `expected_version` của lệnh.
- Phần mô tả ở trên cuộn bằng `PgUp`/`PgDn` khi không vừa màn hình (kể cả 80×24); ô nhập, ô xác nhận, lỗi và dòng
  phím luôn hiện.
- `Tab`/`Shift-Tab` đổi giữa ô văn bản và ô xác nhận, hoặc giữa lý do và `--now` khi tạm dừng task. `Esc` rời hộp
  thoại không gửi; còn chữ đã gõ thì thoát hỏi lại.
- Gửi xong, hộp thoại hiện `Sending…` và không nhận phím, kể cả `Esc`, đến khi daemon trả lời. Ngoại lệ:
  `Ctrl-C` vẫn thoát như SIGTERM (exit 3, request ID ra stderr), và stderr in thêm nội dung đã gõ của hộp thoại
  đang gửi để không mất bản nháp. Daemon nhận, hoặc kết quả chưa rõ,
  thì hộp thoại đóng và màn bên dưới (Actions, hoặc Home với hàng đợi) hiện kết quả. Daemon từ chối thì hộp thoại
  giữ nguyên nội dung đã gõ và báo lý do tại chỗ; không gửi lại. Conflict của Answer vì câu hỏi đã được trả lời
  hoặc rút ở nơi khác thì đọc `question_show` và hiện `Answered elsewhere` kèm câu trả lời và người trả lời.
- Approve của task chờ `adopt_approval` (cần admin) hiện PR và head SHA daemon đọc gần nhất (`wait.detail.head_sha`),
  gõ `approve` rồi gửi `approve_adopt` với head đó, như `cusr task approve --kind adopt --head-sha`. Daemon chưa đọc
  head thì không gửi và chỉ sang dòng CLI trong Actions.
- Answer ghim câu hỏi task đang chờ lúc mở hộp thoại (hoặc câu đầu tiên inbox còn mở), không đổi sang câu hỏi
  khác task hỏi sau.

## Tạm dừng và tiếp tục

- Hộp thoại `pause` có ô lý do một dòng (tối đa 4.096 ký tự, bắt buộc) và lựa chọn `--now` (dừng cả lượt agent
  đang chạy), mặc định tắt; `Tab` đổi giữa hai ô, `Space` bật tắt `--now`. `resume` và `continue` chỉ nêu
  `note` của action. Cả ba gửi `task_pause`/`task_resume`/`task_continue` với `expected_version` là version của
  `task_show` lúc mở hộp thoại, như `recheck`; hộp thoại ghi version đó. Task đổi version trong lúc hộp thoại mở
  thì không gửi và báo tại chỗ; daemon từ chối thì hộp thoại báo tại chỗ, và menu Actions hiện
  `Rejected: <code>: <message>` sau khi rời hộp thoại.
- Thiếu quyền operate: mục trong Actions mờ kèm lý do và `Enter` không mở hộp thoại. Hộp thoại hàng đợi vẫn mở
  để đọc nhưng `Ctrl-S` báo lý do không gửi.
- Home hiện `‖ Queue paused: <lý do> · by <ai> at HH:MM:SS · p to resume` khi `queue_paused` của `task_board`
  khác null (đọc từ mọi reply, kể cả `unchanged`). `p` mở hộp thoại `queue_pause` (lý do) hoặc `queue_resume`;
  lệnh hàng đợi không có project, task hay version. Kết quả chưa xong hoặc bị từ chối hiện ở dòng
  `Queue (<kind>): …` trên Home.
- Task đang tạm dừng: Home thêm `Paused · ` trước cột `Now` khi task còn chờ thứ khác, footer của task đang chọn
  có dòng `Paused  by <ai> at HH:MM:SS: <lý do>`; Task detail có dòng `‖ Paused by …` dưới trạng thái, lấy từ
  `paused` của `task_explain`.

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

Exit code của lần thoát này là 3 nếu còn thao tác chưa rõ, ngược lại là 0; thoát vì Ctrl-C, SIGTERM hay SIGHUP khi còn thao
tác chưa rõ cũng là 3. Lỗi nội bộ của giao diện luôn là 1, kể cả khi còn thao tác chưa rõ: terminal vẫn được trả trước, rồi
stderr in lỗi và các dòng trên.

## Hiển thị

- Tối thiểu 80×24; nhỏ hơn thì chỉ hiện thông báo cần mở rộng và phím thoát.
- Mọi trạng thái có ký hiệu chữ, không chỉ dựa vào màu; `NO_COLOR` tắt toàn bộ màu.
- Cắt ngắn theo độ rộng hiển thị với `…`; màn chi tiết luôn có nội dung đầy đủ.
- Token giới hạn project có ghi chú `Showing projects in this token's scope`.
- Usage không có dữ liệu ghi `unavailable`, không ghi 0.
