# Cuesura

Thuật ngữ miền dùng khi mô tả việc điều phối agent, giới hạn lượt chạy và thay đổi yêu cầu của task.

## Language

**Nhận PR (adopt)**:
Việc admin duyệt cho một task làm tiếp trên PR đã mở, gắn với một head SHA cụ thể. Task đẩy commit vào chính head branch của PR, chỉ fast-forward, không mở PR mới và không sửa tiêu đề hay mô tả PR. Head đổi sau khi duyệt thì task dừng ở `head_changed`; PR đang có task sống giữ, PR từ fork hoặc PR khác base thì bị từ chối.
_Avoid_: Takeover, PR xếp chồng, tự nhận PR

**Tài khoản harness**:
Một mục khai báo có tên về danh tính đăng nhập của vendor để một harness dùng khi chạy attempt. Mỗi harness có một tài khoản mặc định và có thể thêm tài khoản dự phòng. Nhiều mục có thể trỏ tới cùng một danh tính; đổi token không làm đổi danh tính đó.
_Avoid_: Token, file credential, subscription độc lập, binding, pool

**Tài khoản mặc định**:
Tài khoản đã đăng nhập sẵn trên máy mà pin của harness đang dùng. Nó được chọn trước tài khoản dự phòng cùng ưu tiên; Cuesura chỉ đọc credential của nó, không ghi hay xóa.
_Avoid_: Tài khoản kế thừa, tài khoản chính của vendor, tài khoản do Cuesura đăng nhập

**Tài khoản dự phòng**:
Tài khoản người dùng thêm bằng cách đăng nhập qua Cuesura vào thư mục riêng do Cuesura quản lý; được dùng khi tài khoản mặc định nghỉ hạn mức hay lỗi đăng nhập. Không dùng chung credential với phiên tương tác hay công cụ khác.
_Avoid_: Tài khoản phụ của vendor, bản sao credential, tài khoản nhập từ công cụ khác

**Nghỉ hạn mức**:
Khoảng thời gian tài khoản không được chọn vì đã chạm hạn mức sử dụng, có mốc được xét lại. Nghỉ hạn mức thuộc danh tính subscription và dùng chung cho các mục khai, harness và task sử dụng danh tính đó; chưa nhận diện được danh tính thì mục đó nghỉ riêng.
_Avoid_: Hỏng đăng nhập, tạm ngưng, giữ slot

**Chờ ghi credential**:
Tình trạng tài khoản dự phòng có thông tin đăng nhập đã làm mới nhưng chưa lưu được về thư mục của tài khoản, nên chưa được chọn cho attempt mới. Tình trạng này không làm mất kết quả công việc đã có của attempt.
_Avoid_: Nghỉ hạn mức, task thất bại, lỗi đăng nhập

**Khả dụng của tài khoản**:
Khả năng một mục tài khoản được chọn cho attempt mới, chỉ có khi không còn nguyên nhân chặn nào. Gỡ một nguyên nhân không đồng nghĩa gỡ các nguyên nhân khác.
_Avoid_: Đã bật là dùng được, hết nghỉ là dùng được

**Đợt hết hạn mức**:
Khoảng chờ của một harness có task cần chạy, có ít nhất một tài khoản chỉ bị chặn bởi hạn mức và không có tài khoản chọn được. Đợt kết thúc khi có tài khoản chọn được, kể cả khi task còn chờ slot.
_Avoid_: Đợt gửi, thời gian task chưa chạy, thời gian chờ slot

**Vòng thử tài khoản**:
Chuỗi lựa chọn tài khoản liên tiếp trước khi task phải chờ điều kiện phục hồi. Task được đánh thức sau khoảng chờ thì mở vòng thử mới.
_Avoid_: Toàn bộ step, toàn bộ task, một attempt

**Chế độ thực thi**:
Lựa chọn cách đưa kết quả task tới PR, do người dùng xác nhận trước khi chạy. Hai chế độ là `direct-pr` và `full-review`.
_Avoid_: Độ khó task, tự động suy chế độ từ kích thước

**Quy tắc dispatch**:
Chỉ dẫn khai trong `dispatch.yaml` cạnh user config, hoặc `cusr.dispatch.yaml` ở gốc repo để thay nguyên file global cho repo đó, để assistant đề xuất profile, chế độ thực thi và binding cho một task. Hai file chỉ được chọn những gì user config đã khai và profile cho phép. Daemon kiểm tra lựa chọn mỗi lần đọc nhưng không đọc điều kiện và không tự chọn; người dùng vẫn xác nhận từng lần chạy.
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
Một trong `runtime.concurrency` suất chạy, cấp cho task chứ không cho từng bước. Task đang chạy giữ slot qua mọi việc tự động (chuẩn bị, agent, gate, publish, tạo PR, review…) và không nhả ở ranh giới bước. Task rời trạng thái chạy để chờ người, CI, merge hoặc cooldown giữ slot thành chỗ giữ (tối đa `runtime.slot_reservation_hours`) và quay lại thì chạy ngay; trong lúc đó một task chưa từng chạy được mượn chỗ. Task chưa từng chạy có phạm vi (file nhánh đã đổi cộng phạm vi khai báo) chung file với task đang giữ slot hoặc chỗ mượn thì không được cấp slot hay mượn chỗ. Task tạm dừng, hết deadline hoặc đang hủy thì nhả slot. Worktree luôn được giữ.
_Avoid_: Slot của một bước, một task chưa kết thúc, nhả slot đồng nghĩa xóa worktree, chỗ mượn được giữ chỗ hay cho mượn tiếp

**Head đã kiểm**:
Head SHA của PR mà Cuesura đã có đủ gate, CI và review nếu được yêu cầu bởi chế độ đã xác nhận cho revision hiện tại. Head này không tự đổi theo push bên ngoài.
_Avoid_: Head hiện tại của PR, head mới nhất trên remote

**Khóa assistant**:
Dấu cho biết phiên assistant nào đang nhận tin về các task và goal cần người để chuyển cho người dùng. Khóa định tuyến tin và là điều kiện để assistant ghi lên goal, để tin của goal về đúng phiên đã ra lệnh; ngoài ra nó không cấp quyền và không điều phối. Mất khóa không mất sự thật nào vì việc cần người được dựng lại từ task và goal.
_Avoid_: Primary, khóa quyền

**Phiên assistant đã đăng ký**:
Phiên giữ khóa assistant và được hook đánh thức khi có task cần người, không phải chạy `cusr assistant wait`. Đăng ký còn nguyên qua restart daemon; như khóa assistant, nó không cấp quyền nào ngoài việc ghi lên goal.
_Avoid_: Assistant chính, phiên điều phối

**Thông báo logic**:
Một việc cần báo cho người dùng, như một câu hỏi chờ người, một task vừa kết thúc hay một đợt hết hạn mức. Thông báo giữ nguyên danh tính qua mọi lần thử lại, cập nhật nội dung, phục hồi và restart, nên cùng một việc không bao giờ thành hai thông báo logic dù có thể hiện thành nhiều bản tin.
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

### Deputy và goal

**Deputy**:
Vai trò agent làm thay chủ dự án khi task kẹt ở chỗ cần phán đoán hoặc khi goal cần lập hay sửa kế hoạch. Deputy chỉ hành động bằng lệnh có lý do, không xác nhận task hay kế hoạch, không merge, và thao tác của người luôn thắng thao tác của nó.
_Avoid_: Decider, primary AI, phiên deputy sống lâu

**Lượt deputy**:
Một phiên harness mới mở cho đúng một sự cố của task hoặc một lần goal cần kế hoạch, kết thúc bằng bàn giao. Không có gì của deputy sống giữa hai lượt; trí nhớ của nó là dữ liệu đã ghi.
_Avoid_: Phiên deputy, lượt agent của task, attempt

**Sự cố**:
Một lần task vào một wait cụ thể, phân biệt theo task, revision, mã wait và thời điểm vào wait. Cùng một lỗi lặp lại sau khi task đi tiếp là sự cố mới.
_Avoid_: Lỗi, câu hỏi, task kẹt

**Wait cạn trần**:
Wait mà task vào khi đã dùng hết lượt thử, thang model hay giới hạn của bước. Đây là điểm đánh giá lại, không phải điểm dừng: deputy chọn cách đi tiếp, không có deputy thì task kết thúc.
_Avoid_: Task thất bại, hết budget

**Bàn giao**:
Lời kết có cấu trúc của một lượt deputy: nguyên nhân, quyết định, các hướng đã loại và lượt sau nên xem gì. Lượt kết thúc không có bàn giao được ghi là bỏ dở.
_Avoid_: Tin nhắn cuối, tóm tắt phiên

**Chuyển cho người**:
Việc đưa một sự cố mà deputy không gỡ được tới chủ dự án, kèm bàn giao và tin nhắn cuối của lượt. Sự cố đã chuyển không quay lại deputy.
_Avoid_: Escalation, nâng model

**Chữ ký lỗi**:
Dấu do code tính từ mã wait, bước và bằng chứng lỗi đã chuẩn hóa của một sự cố, để biết hai sự cố có phải cùng một lỗi. Lời của agent không làm đổi chữ ký.
_Avoid_: Thông báo lỗi, nguyên nhân

**Bằng chứng mới**:
Điều đã xảy ra từ lần thử trước cho phép deputy thử lại cùng hành động trên cùng chữ ký lỗi: tiến triển đo được, chỉ thị mới của chủ dự án, hay kế hoạch mới chủ dự án đã xác nhận có chạm đơn vị đó. Lời văn của deputy và sửa kế hoạch do chính deputy áp không bao giờ là bằng chứng mới.
_Avoid_: Lý do mới, giả thuyết mới

**Bản miễn**:
Quyết định có bằng chứng của deputy cho một finding review, một gate hay một check CI cụ thể của task không chặn bước tiếp, chỉ trong phạm vi chữ ký lỗi đã miễn. Bản miễn luôn được báo là miễn, không bao giờ là đạt, và không áp cho required check của protected branch.
_Avoid_: Bỏ qua, pass, override

**Goal**:
Một yêu cầu của chủ dự án, là đơn vị giao việc: một task nhỏ là goal một đơn vị, một feature nhiều bước là goal nhiều đơn vị có kế hoạch duyệt một lần.
_Avoid_: Epic, group, dự án

**Goal ẩn**:
Cách đọc một task tạo trực tiếp (không qua kế hoạch) như một goal một đơn vị, để mọi task đều thuộc một goal. Goal ẩn không có kế hoạch, nhánh goal hay task tổng.
_Avoid_: Goal mặc định, task không có goal

**Kế hoạch**:
Bản mô tả có version và hash của một goal: mục tiêu, phạm vi, điều không làm và các đơn vị. Chủ dự án xác nhận đúng một version theo hash; xác nhận đó thay cho xác nhận từng đơn vị.
_Avoid_: Spec, danh sách task

**Đơn vị**:
Một phần việc của kế hoạch, mang một khóa không đổi qua các version, có tiêu chí nghiệm thu, phạm vi và phụ thuộc theo khóa. Mỗi lúc một khóa có tối đa một task chưa kết thúc; thay đơn vị thất bại là tạo task mới cùng khóa.
_Avoid_: Task con, subtask, bước

**Sửa thực thi**:
Sửa kế hoạch chỉ đổi cách làm (thứ tự, phụ thuộc, model trong mức cho phép, chỉ dẫn, phạm vi đơn vị trong phạm vi goal, thay đơn vị thất bại chưa cạn lỗi) mà deputy được tự áp có lý do.
_Avoid_: Sửa nhỏ, sửa không cần duyệt

**Sửa phạm vi**:
Sửa kế hoạch đổi điều chủ dự án đã duyệt (thêm hay bỏ đơn vị, đổi tiêu chí nghiệm thu hay mục tiêu, nới phạm vi goal, thay đơn vị đã thất bại vì cạn lỗi) và phải được chủ dự án duyệt lại; đơn vị bị chạm dừng chờ.
_Avoid_: Amendment chung chung, sửa lớn

**Nhánh goal**:
Nhánh tích hợp Cuesura tạo cho một goal nhiều đơn vị, nhận PR của từng đơn vị bằng merge commit và chỉ do daemon ghi. Nhánh gốc chỉ nhận goal hoàn chỉnh qua PR của task tổng.
_Avoid_: Integration branch tự đặt, feature branch, nhánh task

**Task tổng**:
Task của goal nhiều đơn vị chạy sau khi mọi đơn vị đã vào nhánh goal: không viết code mới, chạy gate, review toàn bộ diff của goal, CI và mở PR của goal vào nhánh gốc.
_Avoid_: Task tích hợp, task cuối, đơn vị cuối

**Sổ goal**:
Cách nhìn do code dựng từ những gì đã ghi về một goal và các task của nó (lệnh, lý do, bàn giao, sự kiện), không phải bản lưu thứ hai. Chỉ lệnh tường minh vào sổ; trò chuyện với trợ lý thì không.
_Avoid_: Trí nhớ của agent, transcript, ghi chú

**Chỉ thị**:
Mục trong sổ goal do chủ dự án hoặc trợ lý giữ khóa assistant ghi. Deputy phải theo chỉ thị; quan sát và quyết định của chính deputy không bao giờ được coi là chỉ thị.
_Avoid_: Ghi chú của deputy, đề xuất
