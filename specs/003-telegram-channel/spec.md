# Feature Specification: Kênh thông báo hai chiều qua Telegram

**Feature Branch**: `003/telegram-channel`

**Created**: 2026-11-03

**Status**: Draft

> **Cập nhật 2026-11-17 theo feature 007** ([deputy và goal](../007-deputy/spec.md), hiến chương 11.0.0): deputy
> thay decider. Các quy tắc riêng của decider trong Clarifications 2026-11-03 được thay bằng FR-021 viết lại; tin của goal
> thêm ở FR-026. Kênh Telegram chưa được triển khai.

**Input**: User description: "Feature 003: kênh thông báo hai chiều. Thông báo gửi qua outbox
at-least-once; gửi trùng thì giữ cùng question/effect ID. Telegram gửi câu hỏi, yêu cầu duyệt và
report, nhận trả lời và lệnh duyệt; map `chat_id` sang grant; trả lời ở một kênh thì kênh khác được
đánh dấu đã trả lời; kênh lỗi không đổi trạng thái task. Phần GitHub (issue, comment, map user GitHub)
và giao việc qua Telegram thuộc feature 005; báo cáo gộp theo giờ hẹn để sau."

## Bối cảnh và phạm vi

Sau feature 002 và 004, chủ dự án chỉ biết task cần mình khi ngồi trước máy chạy daemon: mở `cusr`,
xem `cusr inbox`, rồi trả lời hoặc duyệt bằng CLI/TUI. Khi vắng mặt, deputy (feature 007) gỡ các chỗ kẹt
về vận hành, và câu hỏi của worker khi `autonomous` bật. Xác nhận task và kế hoạch goal, credentials, merge
và mọi sự cố deputy chuyển cho người vẫn nằm chờ cho tới khi người dùng quay lại máy. `cusr report` cho biết chuyện đã xảy ra nhưng
cũng chỉ đọc được trên máy đó.

Feature này thêm **kênh liên lạc mặc định** theo [docs/architecture.md §8.6b](../../docs/architecture.md):

1. **Thông báo đi ra qua outbox**: mỗi việc cần người dùng biết hoặc làm được ghi bền thành một
   thông báo có khóa logic ổn định, rồi mới gửi. Gửi lại sau lỗi hay restart giữ cùng khóa và cùng mã
   câu hỏi/yêu cầu, nên tin trùng (nếu có) không bao giờ nhân đôi quyết định
   ([SPEC.md §13.2](../../SPEC.md)).
2. **Telegram hai chiều**: câu hỏi, yêu cầu duyệt, yêu cầu xác nhận và thông báo cần chú ý được đẩy
   tới một chat riêng đã liên kết. Người dùng trả lời bằng reply, bấm nút duyệt/xác nhận,
   hoặc xem `/inbox` và `/report` ngay trong chat.
3. **Một nguồn sự thật cho mọi kênh**: thao tác từ Telegram đi qua cùng dịch vụ, cùng kiểm tra quyền,
   revision và chống lặp như CLI. Thao tác hợp lệ đầu tiên thắng; tin nhắn ở kênh khác được cập nhật
   thành "đã xử lý".

Telegram là một **adapter**: chỉ nhận, xác thực, chuẩn hoá, chống lặp và gửi qua outbox. Nó không
quyết định retry, escalation hay trạng thái task, và lỗi của kênh không làm đổi trạng thái task
([constitution](../../.specify/memory/constitution.md) II, VI).

**Ngoài phạm vi:**

- Mọi thứ liên quan GitHub issue: nhận task từ issue, comment hỏi đáp trên issue, lệnh `/cusr`, đồng bộ
  label/trạng thái, ánh xạ tài khoản GitHub sang grant. Phần này thuộc feature 005.
- Giao task mới qua Telegram (SPEC.md §2.2: Telegram v1 không nhận task mới). Feature 005 xử lý sau khi
  SPEC được sửa.
- Báo cáo gộp gửi theo giờ hẹn (vd 7h sáng). Feature này chỉ chuẩn bị khóa thông báo để thêm nguồn đó
  sau mà không sửa outbox (FR-005).
- Quyết định source drift qua kênh: source drift chỉ phát sinh khi nguồn task được sửa, tức từ GitHub
  issue ở feature 005.
- Duyệt merge, bật/tắt yolo, bật/tắt `autonomous`, hủy task, sửa cấu hình chạy, `task retry` qua
  Telegram. Những việc này giữ ở CLI/TUI hoặc cấu hình người dùng như hiện tại.
- Webhook hay endpoint công khai; Slack, Discord, ntfy, email; nhóm chat, nhiều chat hay nhiều người
  dùng; giờ yên lặng và tùy chỉnh mức độ thông báo.
- Gọi LLM để soạn, tóm tắt hay hiểu tin nhắn.

## Clarifications

### Session 2026-11-03

- Q: Tách kênh hai chiều và giao việc thành hai feature hay gộp? → A: Tách. Feature 003 gồm outbox
  thông báo và Telegram hai chiều, nghiệm thu trọn vẹn với task từ CLI/assistant. Toàn bộ phần GitHub
  và giao việc qua Telegram chuyển sang feature 005, dùng lại đường nhận tin và ánh xạ danh tính của
  003.
- Q: Báo cáo gộp theo giờ hẹn có thuộc 003 không? → A: Không. 003 chỉ trả report khi người dùng yêu
  cầu, dựng bằng code như `cusr report`. Khóa thông báo có dạng loại/phạm vi/kỳ để báo cáo theo giờ sau
  này chỉ là một nguồn sinh thông báo mới.
- Q: Khi `autonomous` bật, câu hỏi của worker có được đẩy lên Telegram ngay không? → A: Không. Câu hỏi
  được đẩy khi nó chờ người: decider không chạy cho task đó, decider chạy hỏng, hoặc đã hết lượt decider
  ở bước đó. Câu trả lời của decider xem được qua `/report`. *(Thay bằng FR-021 viết lại theo feature 007.)*
- Q: Telegram có nút từ chối nâng model không? → A: Không. Trong lõi, từ chối escalation để task chờ
  không có đường tiếp tục; muốn chạy lại vẫn phải hủy và tạo task mới, nên nút từ chối không cho gì hơn
  việc không duyệt. Tin duyệt chỉ có nút "Duyệt" và ghi rõ lối ra khi không muốn nâng model. Không thêm
  lệnh `task reject`.
- Q: Kênh hồi phục thì thông báo đã gửi thất bại có tự gửi lại không? → A: Có, chỉ với việc còn cần người
  xử lý (câu hỏi, yêu cầu duyệt/xác nhận còn hiệu lực): gửi lại một đợt có giới hạn mới, cùng khóa và
  cùng mã. Thông báo thông tin (chờ người không thao tác được, task kết thúc) đã thất bại thì không gửi
  lại; xem bằng `/inbox` hoặc `/report` (FR-030).
- Q: Liên kết mới có nhận việc đang tồn đọng không? → A: Có. Liên kết thành công thì gửi các câu hỏi, yêu
  cầu duyệt và xác nhận còn hiệu lực trong phạm vi quyền; không đẩy lại lịch sử task đã kết thúc (FR-031).
- Q: Quyền của chat Telegram có phụ thuộc token CLI đã tạo liên kết không? → A: Không. Liên kết có grant
  riêng do admin quản lý, không vượt quyền của người tạo liên kết lúc tạo; thu hồi token CLI không thu hồi
  liên kết. Thu hồi bằng `cusr telegram unlink`, đổi quyền bằng cách liên kết lại (FR-009, FR-011).
- Q: Inbox gồm những gì? → A: Mọi việc đang cần người xử lý, dùng chung cho CLI và Telegram: câu hỏi, yêu
  cầu duyệt, yêu cầu xác nhận và các lý do chờ người khác. Mỗi mục ghi loại và việc đó thao tác được trên
  Telegram hay phải dùng CLI/TUI. Mục câu hỏi giữ nguyên các trường hiện có (FR-024).
- Q: Nút "Xác nhận" có phải đồng ý trọn gói? → A: Có. Nút chỉ có khi đã có cấu hình chạy đề xuất đầy đủ;
  bấm là xác nhận cả task và đúng cấu hình đã hiển thị. Revision hoặc digest đã đổi thì từ chối toàn bộ,
  không ghi nhận một nửa (FR-016).
- Q: Câu hỏi đã giao cho người thì decider có giành lại sau restart không? → A: Không. Câu hỏi có lần
  decider chạy hỏng đã ghi thì chờ người qua restart; decider chỉ xét câu hỏi tiếp theo theo quy tắc hiện
  hành. Bật `autonomous` sau khi câu hỏi đã gửi chỉ cho decider trả lời câu hỏi chưa có lần chạy hỏng nào
  được ghi, và tin được cập nhật theo FR-022 (FR-021). *(Thay bằng FR-021 viết lại theo feature 007.)*
- Q: Liên kết lại cùng chat có vô hiệu tin cũ không? → A: Có. Mỗi lần liên kết là một ranh giới hiệu lực.
  Reply/nút trên tin của liên kết trước, và tin nhận dưới liên kết trước mà chưa xử lý, bị từ chối là hết
  hiệu lực, không hưởng quyền mới; việc còn chờ được gửi lại theo FR-031. Tin mới gửi sau liên kết dùng
  quyền hiện tại (FR-010).
- Q: Mã liên kết và liên kết đang dùng có vòng đời thế nào? → A: Chat cũ hoạt động tới khi mã mới được dùng
  thành công, rồi liên kết được thay trong một lần ghi. Tạo mã mới hủy mã đang chờ; `unlink` hủy cả mã
  đang chờ. Mã giữ role/phạm vi chốt lúc tạo tới khi hết hạn, được dùng hoặc bị hủy; thu hồi token CLI
  nguồn không hủy mã (FR-009, FR-010).
- Q: Thay token cùng bot khác gì đổi bot? → A: Token mới của cùng bot giữ liên kết, vị trí đọc và tham chiếu
  tin. Bot khác thì thu hồi liên kết và mã cũ, bỏ tin chưa xử lý của bot cũ, bắt đầu vị trí đọc mới và yêu
  cầu liên kết lại; bot mới nhận việc còn chờ theo FR-031 (FR-008).
- Q: `/start` có là ngoại lệ của quy tắc bỏ qua người lạ không? → A: Có, và chỉ nó: `/start <mã>` trong chat
  riêng vào luồng liên kết và nhận phản hồi chung về kết quả. Mọi tin khác từ người chưa liên kết vẫn bị
  bỏ qua (FR-018).
- Q: Bằng chứng nào cho phép mở đợt gửi lại? → A: Chỉ bằng chứng đường gửi đã hoạt động sau khi có thông
  báo thất bại; nhận tin thành công hay restart không tính. Hệ thống tự kiểm tra khả năng gửi với nhịp có
  giới hạn; mỗi lần hồi phục mở tối đa một đợt cho mỗi thông báo thất bại; restart không reset giới hạn.
  Cách kiểm tra và ngưỡng do plan chốt (FR-030).
- Q: Thông báo chưa từng gửi có hết hạn khi daemon tắt không? → A: Thời hạn gửi tính từ lần thử đầu tiên.
  Thông báo chưa thử lần nào vẫn gửi sau restart. Đợt đã bắt đầu thì thời gian daemon tắt vẫn tính vào
  hạn; hết hạn thì áp FR-030 (FR-002).
- Q: Xóa tin gốc rồi lấy nút duyệt ở đâu? → A: Mục thao tác được trên Telegram trong `/inbox` có cách mở
  lại thẻ thao tác hiện hành với đủ phạm vi và nút, không phụ thuộc tin gốc và không tạo yêu cầu nghiệp vụ
  mới (FR-015, FR-024).
- Q: "Không xác nhận một nửa" có tính cả crash và lỗi lưu trữ không? → A: Có. Xác nhận task và cấu hình
  được ghi cả hai hoặc không gì, kể cả khi process chết hay ghi lỗi giữa chừng; plan phải chứng minh ở
  tầng transaction, kiểm tra trước khi ghi là chưa đủ (FR-016).
- Q: Tắt rồi bật lại `autonomous` có cho decider thử lại câu hỏi đã chạy hỏng không? → A: Không. Câu hỏi
  có lần chạy hỏng đã ghi luôn chờ người (FR-021). *(Thay bằng FR-021 viết lại theo feature 007.)*
- Q: Sửa tin thành trạng thái cuối mà thất bại thì có được phục hồi không? → A: Có. Đồng bộ trạng thái cuối
  là nghĩa vụ riêng, được thử lại theo đợt hữu hạn khi kênh hồi phục dù câu hỏi/yêu cầu đã đóng. Đây không
  phải gửi lại thông báo thông tin (FR-022, FR-030).
- Q: Tin đã lưu tham chiếu nhưng bị xóa thì sao? → A: Đích không còn tồn tại hoặc được xác định không thể
  sửa thì ghi kết quả cùng lý do rồi ngừng thử; không tự gửi lại lịch sử. Việc còn chờ vẫn mở thẻ mới qua
  `/inbox`. Nghiệm thu phân biệt lỗi tạm thời với đích không thể cập nhật (FR-022, SC-008).
- Q: `unlink` có chặn được request đã ra mạng không? → A: Commit thu hồi là ranh giới. Thao tác đã commit
  trước đó giữ hiệu lực; thao tác chưa commit bị chặn nếu thu hồi commit trước. Không bắt đầu request gửi
  mới theo liên kết cũ, nhưng request đã phát có thể đến chat muộn (FR-010).
- Q: Có hơn 100 việc thì điện thoại có xem được hết không? → A: Có. `/inbox` phân trang để xem và mở thẻ của
  mọi mục; không chỉ báo bị cắt rồi buộc quay về máy tính. Cách phân trang do plan chốt (FR-024).
- Q: Câu hỏi decider đang xử lý có hiện trong `/inbox` không? → A: Có, ghi rõ "decider đang xử lý", và người
  dùng trả lời được ngay; câu trả lời hợp lệ commit trước thắng. Việc hiện trong inbox không sinh thông báo
  đẩy (FR-021, FR-024). *(Theo feature 007: áp cho mọi mục deputy đang giữ, ghi chú "deputy đang xử lý".)*
- Q: Phản hồi thao tác có phải xếp sau tin cũ đang backoff? → A: Không. Phản hồi cho thao tác của người
  dùng được ưu tiên; tin hết hiệu lực được bỏ qua; thứ tự chỉ giữ giữa các thông báo nghiệp vụ còn hiệu
  lực của cùng task (FR-006).

## User Scenarios & Testing *(mandatory)*

Người dùng chính là **chủ dự án** chạy Cuesura trên máy của mình và muốn trả lời, duyệt từ điện thoại.
**Người lạ** (chat Telegram chưa liên kết, nhóm chat, người dùng Telegram khác) là tác nhân phải bị bỏ
qua.

### User Story 1 - Liên kết Telegram và kiểm tra kênh (Priority: P1)

Chủ dự án tạo bot Telegram, chạy `cusr telegram setup` để nhập token, rồi `cusr telegram link` để lấy
mã liên kết dùng một lần và gửi mã đó cho bot từ chat riêng. Từ đó chat này nhận thông báo và thao
tác được trong phạm vi quyền đã chọn lúc liên kết. `cusr doctor`, `cusr status` và
`cusr telegram status` cho biết kênh đang khỏe hay hỏng, và vì sao.

**Why this priority**: Không liên kết an toàn thì không có kênh nào để dùng. Liên kết cũng là chỗ
quyết định ai được ra lệnh cho hệ thống.

**Independent Test**: Trên Telegram giả lập, chạy setup với token đúng/sai, liên kết bằng mã đúng, mã
hết hạn, mã dùng lại, mã gửi từ nhóm chat; kiểm tra grant, đầu ra `doctor`/`status` và việc chat lạ bị
bỏ qua. Sau đó lặp lại một lần với bot thật.

**Acceptance Scenarios**:

1. **Given** người dùng có quyền `admin`, **When** chạy `cusr telegram setup` và nhập token bot hợp lệ,
   **Then** token được lưu trong thư mục dữ liệu của Cuesura, ngoài mọi worktree, với quyền tệp chỉ chủ
   sở hữu; không được đưa vào context, biến môi trường hay artifact của agent, và không hiện trên màn
   hình, log hay `--json`; lệnh báo tên bot đã kiểm tra được và giới hạn bảo vệ token theo FR-008. Token
   sai thì báo lỗi, không lưu gì.
2. **Given** bot đã setup, **When** người dùng chạy `cusr telegram link` (mặc định quyền `operate`,
   `--role admin` để cho phép duyệt), **Then** CLI in một mã dùng một lần có thời hạn, kèm đường dẫn mở
   bot với sẵn mã, và chờ; gửi `/start <mã>` cho bot từ chat riêng trong thời hạn (hoặc mở đường dẫn rồi
   bấm Start) thì chat được liên kết với grant riêng tương ứng,
   CLI và chat cùng báo thành công, rồi chat nhận các việc đang chờ còn hiệu lực trong phạm vi quyền
   (FR-031).
3. **Given** mã sai, đã hết hạn, đã dùng hoặc đã bị hủy, **When** bot nhận `/start <mã>` từ chat riêng,
   **Then** không liên kết; chat nhận một phản hồi chung "mã không hợp lệ hoặc đã hết hạn", không nói rõ lý
   do. Cùng tin gửi từ nhóm chat, hoặc tin bất kỳ khác từ chat chưa liên kết, không nhận phản hồi nào.
4. **Given** đã có chat liên kết, **When** chạy `cusr telegram unlink`, hoặc một mã mới được dùng thành
   công (chat khác hay chính chat đó), **Then** liên kết cũ bị thay trong một lần ghi; reply và nút trên
   tin của liên kết cũ, cùng tin nhận dưới liên kết cũ chưa xử lý, bị từ chối là hết hiệu lực; thông báo
   chưa gửi không còn gửi theo liên kết cũ. Trước khi mã mới được dùng, chat cũ vẫn hoạt động bình thường.
5. **Given** token bị thu hồi, bot có webhook, hoặc một tiến trình khác cũng đang đọc tin của bot,
   **When** chạy `cusr doctor`, `cusr status` hoặc `cusr telegram status`, **Then** đầu ra nêu kênh
   Telegram không dùng được, lý do, hậu quả (không thông báo, chỉ còn CLI/TUI) và bước sửa; daemon vẫn
   chạy bình thường với CLI.
6. **Given** đã liên kết, **When** chạy lại `cusr telegram setup` với token mới, **Then** token của cùng bot
   giữ nguyên liên kết, vị trí đọc và tin đã gửi; token của bot khác thu hồi liên kết và mã cũ, bỏ tin chưa
   xử lý của bot cũ và báo cần liên kết lại.

---

### User Story 2 - Trả lời câu hỏi của agent từ Telegram (Priority: P1)

Khi worker cần thông tin và câu hỏi chờ người, chủ dự án nhận một tin Telegram ghi project, task, mã
câu hỏi, nội dung và cách trả lời. Họ reply tin đó; task chạy tiếp mà không cần mở máy tính. Nếu đã
trả lời bằng CLI/TUI trước, tin Telegram được cập nhật thành "đã trả lời".

**Why this priority**: Đây là lý do chính để có kênh (SPEC.md S04): task không kẹt chờ người khi người
dùng vắng mặt.

**Independent Test**: Cho harness giả lập trả `needs_input`; kiểm tra tin được gửi, rồi trả lời từ
Telegram, từ CLI, gửi lặp 2–5 lần và trả lời cạnh tranh giữa hai kênh.

**Acceptance Scenarios**:

1. **Given** chat đã liên kết có quyền trên project, **When** một câu hỏi mới chờ người đã được lưu bền,
   **Then** đúng một tin được gửi tới chat với project, tiêu đề task, mã câu hỏi ngắn, nội dung và
   hướng dẫn trả lời; câu hỏi vẫn có trong `cusr inbox`.
2. **Given** tin câu hỏi trên Telegram, **When** người dùng reply bằng văn bản, **Then** câu trả lời được
   ghi cho đúng câu hỏi và revision qua cùng dịch vụ với `cusr answer`, actor là danh tính Telegram;
   task tiếp tục theo feature 002 và bot reply xác nhận đã ghi nhận.
3. **Given** câu hỏi đã được trả lời bằng CLI/TUI hoặc deputy, **When** việc trả lời được ghi, **Then**
   các tin Telegram của câu hỏi đã lưu được tham chiếu được sửa thành "đã trả lời" kèm người trả lời,
   kênh và thời điểm (FR-022). Reply vào bất kỳ bản tin nào của câu hỏi đó sau này, kể cả bản trùng không
   sửa được, nhận phản hồi "đã trả lời", không ghi câu trả lời mới.
4. **Given** hai câu trả lời từ Telegram và CLI đến gần như cùng lúc, **When** xử lý, **Then** câu trả
   lời hợp lệ đầu tiên thắng; bên sau nhận "đã trả lời" kèm thông tin bên thắng; không có attempt thừa.
5. **Given** cùng một reply được nhận lặp (restart, gửi lại), **When** xử lý, **Then** chỉ ghi một câu
   trả lời và chỉ có một tin xác nhận logic.
6. **Given** câu hỏi thuộc revision cũ, hoặc task đã kết thúc, **When** người dùng reply, **Then** câu
   trả lời bị từ chối với lý do hết hiệu lực; không đưa vào context của revision mới.
7. **Given** `autonomous` đang bật, **When** worker hỏi, **Then** không gửi tin nào trong lúc deputy còn
   có thể xử lý câu đó; chỉ khi câu hỏi được chuyển cho người (lượt kết thúc mà task vẫn ở câu đó, bàn giao
   `handover`, hay lỗi không thuộc về deputy) thì tin câu hỏi mới được gửi như kịch bản 1, kèm tóm tắt bàn
   giao. Trong lúc đó, `/inbox` vẫn hiện câu hỏi với ghi chú "deputy đang xử lý" và người dùng trả lời được
   ngay; câu trả lời hợp lệ commit trước thắng.
8. **Given** câu hỏi đã được deputy chuyển cho người, **When** daemon restart, **Then** câu hỏi không
   quay lại deputy; nó tiếp tục chờ người và không gửi tin thứ hai.

---

### User Story 3 - Duyệt và xác nhận từ Telegram (Priority: P1)

Khi task chờ duyệt nâng model hoặc chờ xác nhận chạy, chủ dự án nhận tin có đủ phạm vi và các nút
tương ứng. Bấm một lần là xong; nút cũ không bao giờ áp cho phạm vi mới.

**Why this priority**: Không duyệt được từ xa thì escalation và task mới đều đứng chờ tới khi người
dùng quay lại máy, kể cả khi `autonomous` đang bật.

**Independent Test**: Tạo task chờ duyệt escalation và task chờ xác nhận; bấm từng nút, bấm lặp, bấm
nút đã cũ sau khi revision/nấc/policy/cấu hình chạy đổi, bấm từ chat chỉ có quyền `operate`.

**Acceptance Scenarios**:

1. **Given** task chờ duyệt escalation, **When** gửi thông báo, **Then** tin nêu task, revision, bước,
   nấc và model/effort đề xuất, số lượt/nấc còn lại, kèm nút "Duyệt" gắn đúng phạm vi đó. Tin ghi rõ:
   không duyệt thì task đứng chờ; muốn bỏ thì hủy task bằng `cusr task cancel` và tạo task mới.
2. **Given** chat có quyền `operate`, **When** bấm "Duyệt", **Then** approval được ghi qua cùng dịch vụ với
   `cusr task approve --kind escalation`, gắn task/revision, bước, nấc và policy hash; tin được sửa thành
   "đã duyệt".
3. **Given** chat chỉ có quyền `read`, **When** nhận yêu cầu duyệt, **Then** tin không có nút duyệt
   mà ghi rõ cần quyền `operate` và lệnh CLI tương ứng; lần bấm giả mạo (callback tự dựng) bị từ chối
   vì thiếu quyền, không ghi approval.
4. **Given** nút được gửi cho nấc N, **When** revision, nấc hoặc policy đã đổi trước khi bấm, **Then** lần
   bấm bị từ chối là hết hiệu lực; tin được sửa thành "hết hiệu lực"; không áp approval cho phạm vi mới.
5. **Given** task chờ xác nhận (task do assistant tạo, hoặc cấu hình chạy chưa xác nhận), **When** gửi
   thông báo, **Then** tin nêu task, acceptance tóm tắt và cấu hình chạy đề xuất, kèm nút "Xác nhận" gắn
   với đúng revision và digest cấu hình đó. Bấm thì task và cấu hình đó được xác nhận cùng lúc, một lần,
   như `cusr task confirm` kèm digest; bấm lặp trả kết quả cũ. Revision hoặc digest đã đổi thì từ chối
   toàn bộ, không ghi xác nhận task riêng lẻ. Chưa có cấu hình đề xuất đầy đủ thì tin không có nút mà
   hướng dẫn dùng CLI/TUI; muốn đổi cấu hình cũng vậy.
6. **Given** yêu cầu duyệt đã được xử lý bằng CLI/TUI, **When** việc đó được ghi, **Then** các tin Telegram
   tương ứng đã lưu được tham chiếu được sửa thành trạng thái cuối và bỏ nút; nút trên bản tin không sửa
   được vẫn bị từ chối theo kịch bản 4.

---

### User Story 4 - Thông báo cần chú ý và report theo yêu cầu (Priority: P2)

Chủ dự án được báo khi task cần mình mà không có thao tác nào làm được trên Telegram (vd lỗi cấu hình,
hết vòng lặp, PR chờ merge), và khi task kết thúc. Họ gõ `/inbox` để xem việc đang chờ, `/report 8h` để
xem chuyện đã xảy ra, giống `cusr inbox` và `cusr report`.

**Why this priority**: Câu hỏi và duyệt (US2, US3) gỡ được task kẹt; phần này giúp nắm tình hình mà
không phải đoán, nhưng vẫn có giá trị khi chưa có.

**Independent Test**: Phát chuỗi chuyển trạng thái (chờ người vì nhiều lý do, DONE, FAILED, CANCELLED)
và kiểm tra số tin gửi; gửi `/inbox`, `/report`, `/report 2d`, `/report` sai cú pháp và so nội dung với
đầu ra CLI cùng thời điểm.

**Acceptance Scenarios**:

1. **Given** task chuyển sang chờ người dùng vì lý do không thao tác được trên Telegram, **When** gửi
   thông báo, **Then** tin nêu task, lý do, việc cần làm và lệnh CLI/TUI tương ứng; mỗi lần chuyển sang
   chờ chỉ có một tin.
2. **Given** task kết thúc DONE, FAILED hoặc CANCELLED, **When** gửi thông báo, **Then** đúng một tin nêu
   kết quả, PR liên quan (nếu có) và lý do khi FAILED/CANCELLED.
3. **Given** chat đã liên kết, **When** người dùng gửi `/inbox`, **Then** bot trả mọi việc đang cần
   người xử lý (câu hỏi, duyệt, xác nhận và các lý do chờ người khác) của các project chat được xem,
   cùng nội dung với `cusr inbox` lúc đó; mỗi mục ghi loại và thao tác được ngay trên Telegram hay phải
   dùng CLI/TUI (FR-024). Mục thao tác được trên Telegram có cách mở lại thẻ thao tác hiện hành với đủ
   phạm vi và nút, kể cả khi tin gốc đã bị xóa. Nhiều mục hơn một trang thì xem và mở được mọi mục qua
   phân trang.
4. **Given** chat đã liên kết, **When** gửi `/report` hoặc `/report <khoảng>` (cùng cú pháp `--since` của
   CLI), **Then** bot trả báo cáo theo project được dựng bằng code, cùng nội dung với `cusr report`; báo
   cáo dài được chia thành nhiều tin theo thứ tự, vượt trần thì ghi rõ đã cắt và lệnh CLI để xem đủ.
5. **Given** tin nhắn tự do không reply tin nào và không phải lệnh, **When** nhận, **Then** bot không đoán
   ý, không tạo task, chỉ trả hướng dẫn kèm số việc đang chờ.

---

### User Story 5 - Kênh bền qua restart, lỗi mạng và hạn mức (Priority: P2)

Chủ dự án tin rằng không thông báo hay câu trả lời nào bị mất hoặc xử lý hai lần, kể cả khi daemon
restart, Telegram lỗi tạm thời, bị hạn mức hay bị chặn. Khi kênh hỏng, task vẫn chờ có lý do và CLI/TUI
vẫn thao tác được.

**Why this priority**: Kênh ngoài là nơi dễ lặp/mất nhất; sai ở đây phá vỡ bất biến I03, I04, I10.

**Independent Test**: Ma trận ngắt daemon có seed quanh: ghi thông báo, gửi, ghi kết quả gửi, nhận tin,
lưu tin nhận, tiến vị trí đọc, xử lý thao tác, sửa tin "đã xử lý"; mô phỏng lỗi mạng, hạn mức, bot bị
chặn và tin nhận lặp.

**Acceptance Scenarios**:

1. **Given** daemon dừng sau khi nhận một loạt tin nhưng trước khi lưu bền, **When** khởi động lại,
   **Then** các tin đó được nhận lại và xử lý đúng một lần; vị trí đọc chỉ tiến sau khi tin đã lưu.
2. **Given** tin có thể đã gửi nhưng không có xác nhận, **When** thử lại, **Then** tin có thể trùng nhưng
   mang cùng mã câu hỏi/yêu cầu; thao tác qua tin nào cũng quy về cùng một câu hỏi/yêu cầu và không nhân
   đôi quyết định. Bản trùng mà hệ thống không lưu được tham chiếu có thể giữ nội dung cũ sau khi việc đã
   xử lý, nhưng reply hay nút trên nó vẫn được kiểm hiệu lực lúc xử lý.
3. **Given** Telegram lỗi mạng hoặc trả hạn mức, **When** gửi, **Then** việc gửi lùi theo thời gian chờ
   Telegram yêu cầu hoặc backoff có trần; phản hồi cho thao tác của người dùng không phải chờ sau tin cũ
   đang lùi; thứ tự các thông báo còn hiệu lực trong cùng một task được giữ; task không đổi trạng thái.
4. **Given** Telegram không gửi được quá thời hạn gửi, hoặc bot bị người dùng chặn, **When** hết hạn,
   **Then** thông báo được ghi là gửi thất bại có lý do, hiện trong `cusr status`/`cusr telegram status`;
   câu hỏi và yêu cầu duyệt vẫn trả lời được qua CLI/TUI.
5. **Given** daemon dừng nhiều giờ, **When** khởi động lại, **Then** thông báo đang chờ chỉ được gửi nếu
   còn hiệu lực: câu hỏi/yêu cầu đã được xử lý hoặc hết hiệu lực thì không gửi như đang chờ; thông báo
   kết thúc task chưa thử gửi lần nào vẫn gửi; thông báo đã bắt đầu gửi tính cả thời gian daemon tắt vào
   thời hạn (FR-002).
6. **Given** yêu cầu duyệt đã gửi thất bại vì Telegram lỗi quá thời hạn và task vẫn chờ, **When** có bằng
   chứng đường gửi hoạt động trở lại, **Then** yêu cầu đó được gửi lại một đợt có giới hạn mới với cùng
   khóa và cùng mã; thông báo thông tin đã thất bại không gửi lại. Bot vẫn nhận tin được nhưng không gửi
   được, hoặc daemon restart, không mở đợt mới (FR-030).

### Edge Cases

- **EC-001**: Câu hỏi được trả lời trước khi tin kịp gửi: không gửi như đang chờ. Nếu đã gửi thì sửa
  các bản tin đã lưu tham chiếu thành "đã trả lời" (FR-022).
- **EC-002**: Tin từ chat chưa liên kết, nhóm chat, kênh, hoặc từ người dùng Telegram khác: bỏ qua,
  không phản hồi nội dung, chỉ ghi metadata tối thiểu (loại nguồn, thời điểm, lý do) để chẩn đoán. Nhiều
  tin lạ không làm đầy log hay chậm xử lý tin hợp lệ.
- **EC-003**: Người dùng sửa hoặc xóa tin reply sau khi đã ghi: không ghi lại, không hoàn tác; tin sửa
  nhận phản hồi rằng câu trả lời đã ghi không đổi và cách xử lý tiếp.
- **EC-004**: Reply bằng ảnh, file, giọng nói, sticker: từ chối có hướng dẫn, chỉ nhận văn bản. Câu trả
  lời vượt giới hạn độ dài của `cusr answer`: từ chối có thông báo, không cắt âm thầm.
- **EC-005**: Câu hỏi hoặc yêu cầu dài hơn giới hạn một tin Telegram: gửi bản rút gọn được đánh dấu rõ
  kèm lệnh xem đầy đủ; không bỏ mã câu hỏi, phạm vi duyệt hay nút.
- **EC-006**: Mã câu hỏi ngắn trùng nhau giữa hai câu hỏi đang mở: lệnh trả lời theo mã báo mơ hồ và liệt
  kê các lựa chọn; reply trực tiếp vào tin không bị ảnh hưởng.
- **EC-007**: Nhiều task cùng cần người một lúc (hàng chục tin): tin được gửi tuần tự trong hạn mức, không
  bị mất; thao tác trên tin này không ảnh hưởng tin khác.
- **EC-008**: Chat bị hạ quyền hoặc thu hẹp project sau khi tin đã gửi: thao tác được kiểm quyền lúc xử lý
  theo grant hiện tại, không theo quyền lúc gửi.
- **EC-009**: Hai daemon hoặc công cụ khác cùng đọc tin của một bot: kênh báo xung đột trong health, không
  xử lý tin nửa vời; daemon vẫn giữ khóa độc quyền như hiện tại.
- **EC-010**: Đồng hồ máy nhảy hoặc máy ngủ lâu: lịch nhận tin không chạy dồn, vị trí đọc không lùi, thời
  hạn mã liên kết và thời hạn gửi dùng đồng hồ đơn điệu hoặc được kiểm lại sau khi thức.
- **EC-011**: Telegram chỉ giữ tin chờ trong thời gian giới hạn khi daemon tắt: tin quá hạn bị mất phía
  Telegram. Người dùng nhận biết qua việc không có tin xác nhận; doctor/status ghi lần nhận tin thành
  công cuối.
- **EC-012**: Nội dung câu hỏi hoặc lý do chứa secret: được che trước khi lưu thông báo, như mọi đầu ra
  khác.
- **EC-013**: Người lạ dò mã liên kết: mã đủ dài để không đoán được trong thời hạn, số lần thử sai có giới
  hạn; vượt giới hạn thì mã bị hủy và admin tạo mã mới. Phản hồi không cho biết mã gần đúng hay đã hết hạn.
- **EC-014**: Câu trả lời gửi qua Telegram có nội dung giống secret: không ghi câu trả lời, câu hỏi vẫn mở; phản hồi nói rõ
  lý do và hai cách tiếp tục (gửi lại không kèm giá trị đó, hoặc `cusr answer` trên máy). Không ghi bản đã che vì câu trả lời
  đầu tiên thắng và không sửa lại được.

## Requirements *(mandatory)*

### Functional Requirements

**Outbox thông báo**

- **FR-001**: Mỗi thông báo MUST được tạo trong cùng transaction với sự kiện gây ra nó (câu hỏi chờ
  người, yêu cầu duyệt, yêu cầu xác nhận, task chờ người dùng, task kết thúc, việc đã xử lý cần cập
  nhật tin cũ, phản hồi cho thao tác từ kênh). Không gửi gì trước khi ghi bền.
- **FR-002**: Việc gửi MUST chạy sau commit, at-least-once, có timeout, số lần thử và thời hạn gửi hữu
  hạn, backoff có trần và jitter điều khiển được khi kiểm thử; hạn mức của Telegram MUST được tôn trọng
  theo thời gian chờ nó trả về. Thời hạn gửi MUST tính từ lần thử đầu tiên: thông báo chưa thử lần nào
  vẫn gửi sau restart; đợt đã bắt đầu thì thời gian daemon tắt vẫn tính vào hạn.
- **FR-003**: Gửi không rõ kết quả MUST được coi là `unknown` và gửi lại với cùng khóa; tin trùng có thể
  xảy ra nhưng MUST mang cùng mã câu hỏi/yêu cầu, và mọi thao tác từ tin trùng MUST quy về cùng một đối
  tượng (SPEC.md §13.2).
- **FR-004**: Trước khi gửi hoặc gửi lại, thông báo gắn với câu hỏi/yêu cầu MUST được kiểm còn hiệu lực;
  hết hiệu lực thì không gửi như đang chờ, hoặc nếu đã gửi thì cập nhật tin theo FR-022.
- **FR-005**: Mỗi thông báo MUST có khóa logic ổn định gồm loại, phạm vi và nguyên nhân/kỳ (vd câu hỏi
  theo mã câu hỏi, task kết thúc theo task, phản hồi theo request ID). Cùng nguyên nhân MUST NOT sinh hai
  thông báo logic. Một nguồn thông báo mới (như báo cáo theo giờ hẹn) MUST thêm được chỉ bằng loại và
  khóa mới.
- **FR-006**: Phản hồi cho thao tác của người dùng MUST được gửi trước các thông báo khác đang chờ hoặc
  đang lùi. Thông báo nghiệp vụ còn hiệu lực của cùng một task MUST được gửi theo thứ tự tạo; thông báo
  hết hiệu lực MUST được bỏ qua thay vì giữ chỗ trong thứ tự; thông báo của task khác nhau MUST NOT chặn
  nhau quá thời hạn gửi.
- **FR-007**: Lỗi gửi/nhận của kênh MUST NOT đổi trạng thái task, MUST NOT kích hoạt retry/escalation của
  task và MUST NOT chặn thao tác qua CLI/TUI.

**Liên kết và danh tính**

- **FR-008**: `cusr telegram setup` MUST nhận token bot qua nhập ẩn hoặc stdin, kiểm tra với Telegram
  trước khi lưu, lưu trong thư mục dữ liệu của Cuesura, ngoài mọi worktree, với quyền tệp chỉ chủ sở
  hữu. Token MUST NOT được truyền vào context, biến môi trường hay artifact của agent và MUST được che
  trong mọi log, artifact và đầu ra CLI. Chạy lại setup thay token cũ. Theo
  [ADR-0005](../../docs/adr/0005-native-harness-permissions.md), hệ thống không hứa ngăn process cùng UID,
  kể cả worker chạy với sandbox tắt hoặc full access, đọc tệp token; setup MUST nêu rõ giới hạn này và
  cách thu hồi token khi nghi bị lộ. Token mới của cùng bot MUST giữ liên kết, vị trí đọc và tham chiếu
  tin. Token của bot khác MUST thu hồi liên kết và mã đang chờ, bỏ tin chưa xử lý của bot cũ và bắt đầu
  vị trí đọc mới; người dùng MUST liên kết lại.
- **FR-009**: `cusr telegram link` MUST cần quyền `admin`, tạo mã dùng một lần có thời hạn, chọn role
  (mặc định `operate`, `admin` chỉ khi chỉ rõ) và phạm vi project (mặc định mọi project của người gọi).
  Role và phạm vi MUST NOT vượt grant của người gọi lúc tạo mã và được chốt tới khi mã hết hạn, được dùng
  hoặc bị hủy; thu hồi token CLI nguồn MUST NOT hủy mã. Tạo mã mới hoặc `unlink` MUST hủy mã đang chờ.
  Mã MUST đủ dài để không đoán được trong thời hạn và bị hủy khi vượt số lần thử sai. Liên kết chỉ thành
  công khi mã được gửi từ chat riêng trong thời hạn. Đổi role hay phạm vi MUST đi qua liên kết lại.
- **FR-010**: Một thời điểm chỉ có một chat liên kết. Danh tính kênh MUST gồm chat và người dùng
  Telegram; chỉ tin từ đúng cặp đó mới được xử lý. Liên kết cũ MUST giữ hiệu lực tới khi mã mới được dùng
  thành công, rồi được thay trong cùng một lần ghi; `cusr telegram unlink` MUST thu hồi ngay. Mỗi liên
  kết là một ranh giới hiệu lực: reply/nút trên tin của liên kết trước, và tin nhận dưới liên kết trước
  chưa xử lý, MUST bị từ chối là hết hiệu lực kể cả khi liên kết mới cùng chat, và MUST NOT hưởng quyền
  của liên kết mới. Commit thu hồi hoặc thay liên kết là ranh giới: thao tác đã commit trước đó giữ hiệu
  lực; thao tác chưa commit MUST bị chặn nếu thu hồi commit trước. Sau commit đó MUST NOT bắt đầu request
  gửi mới theo liên kết cũ; request đã phát trước đó có thể đến chat muộn.
- **FR-011**: Chat liên kết MUST được ánh xạ tới một grant riêng (actor, roles, projects), lưu bền và có
  hiệu lực ngay khi liên kết, không cần restart daemon. Grant này độc lập với token CLI đã tạo liên kết:
  thu hồi token đó MUST NOT thu hồi liên kết. Mọi thao tác MUST được kiểm quyền ở application service theo
  grant hiện tại lúc xử lý, như token CLI. Telegram MUST NOT mặc định `admin` và MUST NOT nâng quyền ngoài
  grant.
- **FR-012**: Thông báo MUST chỉ gửi cho chat có quyền `read` trên project của task; nút thao tác MUST chỉ
  hiện khi grant đủ quyền cho thao tác đó.

**Nhận tin và thao tác**

- **FR-013**: Hệ thống MUST nhận tin Telegram bằng cách chủ động hỏi định kỳ, không mở endpoint công
  khai. Mỗi tin/nút MUST được lưu với khóa chống lặp từ danh tính cập nhật của Telegram trước khi xử lý;
  vị trí đọc MUST chỉ tiến cùng lần ghi bền đó.
- **FR-014**: Mỗi thao tác từ Telegram MUST có request ID ổn định từ danh tính cập nhật, đi qua cùng
  admission, dedup và dịch vụ với lệnh CLI tương ứng; lặp lại MUST trả kết quả đầu tiên.
- **FR-015**: Telegram MUST hỗ trợ đúng các thao tác: trả lời câu hỏi (reply tin câu hỏi, hoặc
  `/answer <mã> <nội dung>`), duyệt escalation, xác nhận task theo cấu hình chạy đã đề xuất,
  `/inbox`, mở lại thẻ thao tác hiện hành của một mục inbox, `/report [khoảng]`, `/help`. Mở lại thẻ MUST
  dựng từ trạng thái hiện tại với đủ phạm vi và nút, không phụ thuộc tin gốc và không tạo yêu cầu nghiệp
  vụ mới. Thao tác khác MUST nhận hướng dẫn, không đoán ý.
- **FR-016**: Nút MUST gắn với phạm vi đã hiển thị (câu hỏi; approval request, revision, bước, nấc,
  policy hash; revision và digest cấu hình chạy). Phạm vi đổi thì thao tác MUST bị từ chối là hết hiệu
  lực. Nút xác nhận MUST chỉ có khi đã có cấu hình chạy đề xuất đầy đủ và MUST xác nhận task cùng đúng
  cấu hình đó như một thao tác; revision hoặc digest không còn khớp thì MUST từ chối toàn bộ, không ghi
  xác nhận task riêng lẻ. Cam kết "cả hai hoặc không gì" MUST đứng vững cả khi process chết hay ghi lỗi
  giữa chừng; plan MUST chứng minh ở tầng transaction, kiểm tra trước khi ghi là chưa đủ.
- **FR-017**: Mỗi thao tác từ Telegram MUST nhận đúng một phản hồi logic: đã ghi nhận, đã xử lý trước đó
  (kèm bên thắng), hết hiệu lực, thiếu quyền hoặc lỗi cú pháp, với mã lỗi ổn định giống CLI.
- **FR-018**: Tin nhắn từ chat/người dùng chưa liên kết MUST bị bỏ qua không phản hồi và nội dung MUST NOT
  vào bất kỳ context agent nào. Ngoại lệ duy nhất: `/start <mã>` trong chat riêng vào luồng liên kết và
  nhận một phản hồi chung về kết quả (thành công, hoặc mã không hợp lệ/hết hạn không nói rõ lý do).
- **FR-019**: Telegram MUST NOT có thao tác nào mà CLI không có. Từ chối escalation MUST NOT được đưa ra
  như một thao tác; tin duyệt MUST ghi rõ lối ra khi không muốn nâng model (hủy task rồi tạo task mới).

**Nội dung và định tuyến**

- **FR-020**: Với task từ CLI/assistant, câu hỏi, yêu cầu duyệt/xác nhận và thông báo chờ người MUST đi tới
  chat liên kết; mọi việc cần người vẫn có trong `cusr inbox` dù kênh lỗi hay chưa cấu hình. Định tuyến cho task
  từ GitHub issue thuộc feature 005.
- **FR-021** *(viết lại theo feature 007)*: Sự cố mà bảng định tuyến của feature 007 giao cho deputy, gồm câu hỏi
  của worker khi `autonomous` bật, MUST NOT được đẩy lên Telegram trong lúc deputy còn có thể xử lý nó. Sự cố
  chỉ được thông báo khi chuyển cho người (lượt kết thúc mà task vẫn ở đúng sự cố, bàn giao `handover`, lỗi
  auth/refusal/thiếu capability của lượt, hay chạm `infra_retries`), với tóm tắt bàn giao trong tin. Thao tác
  của deputy MUST NOT sinh thông báo riêng; người dùng xem chúng qua `/report`. Sự cố đã chuyển cho người MUST
  tiếp tục chờ người qua restart và qua việc tắt/bật lại `autonomous`, không quay lại deputy. Mục deputy đang
  giữ vẫn MUST có trong inbox với ghi chú đang được deputy xử lý, và người dùng MUST thao tác được ngay; thao
  tác hợp lệ commit trước thắng và lệnh cũ của deputy bị từ chối theo version. Không có role `deputy` thì mọi
  sự cố tới người như trước feature 007.
- **FR-022**: Khi câu hỏi, yêu cầu duyệt hay xác nhận được xử lý ở bất kỳ kênh nào hoặc hết hiệu lực, mọi
  tin Telegram tương ứng đã lưu được tham chiếu MUST được cập nhật thành trạng thái cuối (đã trả lời/duyệt/
  xác nhận/hết hiệu lực, kèm actor, kênh, thời điểm) và bỏ nút, qua outbox. Bản tin có kết quả gửi
  `unknown` mà không lưu được tham chiếu (Telegram có thể đã nhận) có thể không cập nhật được; reply hay
  nút trên mọi bản tin, kể cả bản đó, MUST vẫn được kiểm hiệu lực lúc xử lý theo FR-016 và nhận phản hồi
  trạng thái cuối theo FR-017. Việc cập nhật này là nghĩa vụ riêng của từng bản tin: hết đợt gửi mà chưa
  xong thì MUST được thử lại theo FR-030 dù câu hỏi/yêu cầu đã đóng. Đích đã bị xóa hoặc được xác định
  không thể sửa MUST được ghi kết quả cùng lý do rồi ngừng thử, không gửi tin thay thế.
- **FR-023**: Mỗi tin MUST tự đủ nghĩa: project, tiêu đề task, mã ngắn của task/câu hỏi, việc cần làm và
  lệnh CLI tương ứng. Nội dung MUST dựng bằng code từ dữ liệu đã ghi, không gọi LLM, và MUST được che
  secret trước khi lưu.
- **FR-024**: Inbox MUST gồm mọi việc đang cần người xử lý của các project người gọi được xem: câu hỏi
  mở, yêu cầu duyệt, yêu cầu xác nhận và task chờ người vì lý do khác. Mỗi mục MUST có loại, task, lý do,
  thao tác tiếp theo và cho biết thao tác đó làm được trên Telegram hay chỉ qua CLI/TUI. Mục câu hỏi MUST
  giữ các trường hiện có của `cusr inbox`. `/inbox` và `/report` MUST dùng cùng dịch vụ và cùng quyền với
  `cusr inbox` và `cusr report`; nội dung MUST khớp đầu ra CLI cùng thời điểm, chỉ khác cách trình bày và
  chia tin. Inbox MUST xem được hết mọi mục qua phân trang, cả trên CLI và Telegram, thay vì chỉ báo bị
  cắt; trên Telegram, mọi mục thao tác được MUST mở được thẻ. Mục deputy đang giữ MUST hiện với ghi chú
  tương ứng; việc hiện trong inbox MUST NOT sinh thông báo đẩy.
- **FR-025**: Tin quá giới hạn độ dài MUST được rút gọn có đánh dấu hoặc chia thành nhiều tin có thứ tự,
  MUST NOT mất mã, phạm vi hay nút.
- **FR-026** *(thêm theo feature 007)*: Việc cần người của goal (goal cần kế hoạch khi không deputy nào lập,
  kế hoạch chờ duyệt, sửa phạm vi chờ duyệt, PR của goal sẵn sàng merge) MUST được thông báo như mọi việc cần
  người, từ cùng nguồn với tin của goal cho phiên assistant giữ lease. Tin MUST tự đủ nghĩa theo FR-023: goal,
  tóm tắt kế hoạch, version và hash khi có, và lệnh CLI tương ứng (`cusr goal show`, `cusr goal confirm
  --plan-hash`). Merge PR đơn vị vào nhánh goal do daemon làm MUST NOT sinh thông báo.

**Vận hành và quan sát**

- **FR-026**: `cusr telegram status`, `cusr status` và `cusr doctor` MUST báo: đã setup chưa, bot nào, chat
  liên kết và role, lần nhận tin thành công cuối, thông báo đang chờ/thất bại kèm lý do, và xung đột nhận
  tin (webhook, tiến trình khác). Mọi lệnh MUST có `--json` và mã thoát theo quy ước CLI hiện có.
- **FR-027**: `cusr inbox` và `cusr task explain` MUST hiển thị trạng thái gửi của câu hỏi/yêu cầu lên
  Telegram và actor/kênh của thao tác đã thắng.
- **FR-028**: Restart MUST tiếp tục nhận từ vị trí đã lưu, đối chiếu thông báo đang dở theo FR-003, không
  tạo chuỗi nhận tin thứ hai và không gửi lại thông báo đã có kết quả thành công.
- **FR-029**: Khi chưa setup hoặc chưa liên kết, hệ thống MUST chạy như trước feature này; không tạo
  thông báo chờ gửi vô hạn cho kênh không tồn tại.
- **FR-030**: Khi có thông báo gửi thất bại, hệ thống MUST tự kiểm tra khả năng gửi với nhịp có giới hạn.
  Chỉ bằng chứng đường gửi đã hoạt động sau thời điểm thất bại mới được coi là kênh hồi phục; nhận tin
  thành công hay restart MUST NOT được coi là hồi phục. Mỗi lần hồi phục MUST mở tối đa một đợt gửi có
  giới hạn mới cho mỗi câu hỏi, yêu cầu duyệt và xác nhận còn hiệu lực đã gửi thất bại, với cùng khóa và
  cùng mã; restart MUST NOT reset giới hạn đợt. Cùng quy tắc đợt áp cho việc sửa tin thành trạng thái cuối
  (FR-022) chưa xong, kể cả khi câu hỏi/yêu cầu đã đóng. Thông báo thông tin đã thất bại MUST NOT được gửi
  lại. Cách kiểm tra và ngưỡng do plan chốt.
- **FR-031**: Liên kết thành công MUST gửi tới chat các câu hỏi, yêu cầu duyệt và xác nhận đang còn hiệu
  lực trong phạm vi grant, mỗi việc một tin theo khóa của nó; MUST NOT gửi lại lịch sử task đã kết thúc.

### Phạm vi bằng chứng và truy vết

| Hành trình trong SPEC.md | Story / yêu cầu | Bằng chứng cần có ở feature 003 |
| --- | --- | --- |
| S02 Thiếu thông tin/xác nhận | US3.5; FR-015, FR-016 | Xác nhận task từ Telegram một lần, nút cũ bị từ chối |
| S04 Agent hỏi giữa chừng | US2; FR-001–005, FR-013–014, FR-021–022 | Trả lời từ Telegram và CLI; lặp, cạnh tranh, cập nhật kênh khác, qua restart |
| S05 Crash | US5; FR-002–004, FR-013, FR-028, FR-030 | Ma trận ngắt quanh gửi/nhận/xử lý không mất, không nhân đôi quyết định |
| S10 Tiến độ/vận hành | US1, US4; FR-024, FR-026–027, FR-031 | Doctor/status/inbox hiển thị kênh; `/report` khớp `cusr report` |

Plan MUST chỉ rõ bằng chứng cho I03, I04, I08, I10 ở tầng outbox/adapter Telegram bằng integration test
trên SQLite thật kèm crash injection, và giữ kiểm tra hồi quy của feature 001, 002, 004.

### Key Entities *(include if feature involves data)*

Thông báo logic, đợt gửi, lượt gửi, bản tin và đồng bộ trạng thái cuối dùng đúng nghĩa trong
[GLOSSARY.md](../../GLOSSARY.md).

- **Notification** (thông báo logic): một việc cần báo; loại, khóa logic (FR-005), project/task liên quan,
  đối tượng gắn (câu hỏi, approval, xác nhận), nội dung đã che secret, trạng thái gửi, đợt gửi hiện tại và
  số lượt gửi trong đợt, lỗi cuối.
- **Message copy** (bản tin): một bản của thông báo trên Telegram; tham chiếu tin (chỉ có khi lượt gửi
  thành công), liên kết đã gửi nó, trạng thái đồng bộ trạng thái cuối (chưa cần, đang chờ, xong, không thể
  cập nhật kèm lý do).
- **ChannelLink**: chat và người dùng Telegram đã liên kết, grant riêng (actor, roles, projects), người tạo
  liên kết, thời điểm liên kết/thu hồi.
- **LinkCode**: mã liên kết dùng một lần, role/phạm vi chốt lúc tạo, hạn dùng, số lần thử sai, trạng thái
  (đang chờ, đã dùng, hết hạn, bị hủy).
- **InboundUpdate**: tin/nút nhận từ Telegram đã che secret, khóa chống lặp, danh tính nguồn, kết quả xử lý
  (thao tác, phản hồi, bỏ qua kèm lý do).
- **ChannelCursor**: vị trí đọc tin của bot; chỉ tiến cùng lần ghi InboundUpdate.
- **Question / Approval / Confirmation**: kế thừa từ lõi, bổ sung actor/kênh của thao tác thắng.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Người dùng mới liên kết được bot với chat riêng trong dưới 5 phút theo quickstart, chỉ dùng
  `cusr telegram setup` và `cusr telegram link`, không phải tự tìm `chat_id`.
- **SC-002**: Trong điều kiện mạng bình thường, câu hỏi/yêu cầu mới đến Telegram trong vòng 1 phút sau khi
  lưu, và thao tác từ Telegram được ghi nhận kèm tin xác nhận trong vòng 1 phút; một task đi từ câu hỏi
  tới lần chạy tiếp chỉ bằng điện thoại.
- **SC-003**: Gửi lặp 2–5 lần mỗi reply, nút bấm và lệnh, cùng mẫu thao tác cạnh tranh Telegram–CLI: số câu
  trả lời, approval, xác nhận và attempt bằng đúng số logic mong đợi (0 bản trùng).
- **SC-004**: Ít nhất 100 lần ngắt daemon có seed tái hiện, phân bố quanh các điểm của US5: 0 thông báo logic
  bị mất, 0 tin nhận bị bỏ sót hay xử lý hai lần, 0 quyết định nhân đôi; tin trùng (nếu có) mang cùng mã.
- **SC-005**: 100% mẫu nút/reply đã cũ (revision, nấc, policy, digest đổi; câu hỏi đã trả lời; task đã kết
  thúc) và mẫu thiếu quyền bị từ chối có lý do; không approval/xác nhận nào được ghi cho phạm vi khác phạm
  vi đã hiển thị, và không mẫu xác nhận nào chỉ ghi được một nửa (task mà không có cấu hình), kể cả mẫu
  ngắt process hoặc lỗi ghi giữa hai phần xác nhận. 100% reply/nút của liên kết trước (kể cả liên kết lại
  cùng chat) bị từ chối là hết hiệu lực.
- **SC-011**: Trên mẫu kênh lỗi rồi hồi phục và mẫu liên kết khi đã có việc chờ: 100% câu hỏi, yêu cầu duyệt
  và xác nhận còn hiệu lực có mặt trên chat sau khi kênh hồi phục hoặc liên kết xong; 0 thông báo thông tin
  đã thất bại bị gửi lại; 0 tin cho task đã kết thúc trước khi liên kết; 0 đợt gửi lại mở chỉ vì nhận tin
  thành công hoặc restart.
- **SC-006**: 100% mẫu tin từ chat lạ, nhóm chat và người dùng khác bị bỏ qua: không phản hồi, không thao
  tác, không có ký tự nào của nội dung đó trong context agent đã lưu. Ngoại lệ duy nhất là `/start <mã>`
  trong chat riêng, chỉ nhận phản hồi chung về kết quả liên kết.
- **SC-007**: Khi Telegram không khả dụng, bị hạn mức hay bị chặn trong mẫu thử, 100% câu hỏi/yêu cầu vẫn
  xử lý được qua CLI/TUI, status báo đúng kênh lỗi và lý do, và không task nào đổi trạng thái vì lỗi kênh.
- **SC-008**: 100% câu hỏi/yêu cầu được xử lý ở kênh khác có mọi bản tin Telegram đã lưu tham chiếu và còn
  sửa được được cập nhật thành trạng thái cuối khi kênh hoạt động, kể cả mẫu kênh lỗi lúc xử lý rồi hồi
  phục sau đó; 100% bản tin đã bị xóa hoặc không sửa được có kết quả ghi kèm lý do, tách khỏi lỗi tạm thời;
  100% reply/nút trên bản tin không cập nhật được (mẫu gửi `unknown` rồi gửi lại) nhận phản hồi trạng thái
  cuối, không ghi thao tác mới; `/inbox` (kể cả mẫu hơn một trang) và `/report` khớp đầu ra CLI trên mọi mẫu
  so sánh.
- **SC-009**: 0 token bot hay secret xuất hiện trong log, artifact, đầu ra CLI (kể cả `--json`) và nội dung
  tin đã lưu trên các mẫu kiểm tra che secret.
- **SC-010**: Báo cáo nghiệm thu phân biệt Telegram giả lập với smoke trên bot và chat thật; không dùng kết
  quả giả lập để tuyên bố đã đạt smoke thật.

## Assumptions

- Feature 001, 002, 004 là nền: inbox/answer, approve escalation, confirm/run config, `cusr report`,
  deputy và goal (feature 007), outbox, recovery và token/grant đã có. Feature 003 thêm kênh và ánh xạ vào các dịch vụ đó,
  không thêm năng lực lõi mới. Thay đổi hành vi mà người dùng thấy trên phần đã có: mở rộng `cusr inbox` thành mọi việc
  cần người (FR-024), xác nhận task và cấu hình như một thao tác (FR-016), và sự cố deputy đã chuyển cho người không
  quay lại deputy (FR-021). Thay đổi nội bộ kèm theo (hook tạo thông báo trong transaction, mẫu che token, health và doctor) được
  liệt kê ở bảng "Thay đổi lên phần đã có" của [data model](data-model.md).
- Một người dùng, một bot, một chat riêng (constitution, SPEC.md §2.1). Feature 005 dùng lại liên kết và
  đường nhận tin này.
- Polling là cách nhận duy nhất; với một người dùng, hạn mức Telegram đủ dư. Webhook để sau v1.
- Nội dung câu hỏi, lý do và report được gửi đầy đủ (đã che secret) lên Telegram; người dùng chấp nhận việc
  nội dung đi qua máy chủ Telegram khi liên kết. Lệnh setup nêu rõ điều này. Chế độ gửi tối thiểu để sau.
- Câu hỏi hiện là văn bản tự do, chưa có danh sách lựa chọn, nên trả lời bằng reply văn bản; nút lựa
  chọn cho câu hỏi để sau khi lõi có câu hỏi dạng lựa chọn.
- Thông báo chỉ cho: câu hỏi chờ người, yêu cầu duyệt/xác nhận, task chuyển sang chờ người dùng, task kết
  thúc, việc cần người của goal (FR-026), và phản hồi thao tác. Không báo tiến độ thường (bắt đầu attempt, gate xanh).
- Chu kỳ nhận tin, thời hạn mã liên kết, thời hạn và số lần gửi, trần backoff, độ dài mã ngắn và trần chia
  tin do plan chốt.
- Cần một bot Telegram thử nghiệm và chat riêng cho smoke; nếu thiếu, tiêu chí thật tương ứng ghi chưa
  kiểm.
