# Feature Specification: Deputy, agent theo task làm thay chủ dự án

**Feature Branch**: `007/deputy`

**Created**: 2026-11-08

**Status**: Draft

**Input**: User description: "Deputy: agent thường trực theo task làm thay owner (nhận việc, gỡ rối, quyết ngân
sách), thay decider hiện tại." Chi tiết lấy từ buổi thảo luận với chủ dự án và buổi chất vấn spec ngày 2026-11-08
(mục Clarifications).

## Bối cảnh và phạm vi

Mục tiêu gốc của Cuesura là chủ dự án quyết định ít nhất có thể: spec đã rõ thì task phải đi tới PR mà không cần
người. Thực tế, khi chạy qua đêm, task vẫn dừng ở nhiều chỗ chờ người: hết lượt thử ở một nấc, review lặp, hết
lượt vào step, cần duyệt nâng model, câu hỏi của worker mà decider đã trả lời một lần. Sáng ra chủ dự án phải gỡ
từng chỗ rồi đợi thêm nửa ngày cho task chạy tiếp. Các chỗ kẹt tất định đang được sửa bằng code ở #245–#249; phần
còn lại là những chỗ cần **phán đoán**, và hiện chỉ người làm được.

Decider hiện có ([SPEC.md §10](../../SPEC.md)) chỉ trả lời ba loại câu hỏi của worker, mỗi step một lần, chỉ đọc,
và chỉ chạy khi bật `autonomous`. Firstmate giải bài này bằng một Primary LLM thường trực xử lý mọi sự kiện trong
một hội thoại dài, và trả giá bằng context lớn ([docs/architecture.md §7.1](../../docs/architecture.md)).

Feature này thay decider bằng **deputy**: một agent làm thay chủ dự án trong suốt vòng đời của **một task**.

1. **Theo task, không thường trực toàn cục.** Mỗi task có tối đa một phiên deputy, tạo vào lần đầu task cần nó và
   kết thúc cùng task. Context chỉ chứa chuyện của task đó, nên không phình theo số task hay theo thời gian.
2. **Gọi ở ranh giới, không làm event handler.** Engine vẫn quyết định mọi chuyển trạng thái bằng code
   ([constitution](../../.specify/memory/constitution.md) I). Engine luôn vào wait như hiện nay; daemon định tuyến
   wait đó tới deputy thay vì tới người. Deputy hành động như một caller của `cusr`: mọi thao tác của nó đi qua cùng
   dịch vụ, cùng kiểm tra quyền, version và chống lặp như trợ lý.
3. **Các giới hạn hiện có là trần thử lại trước khi tới deputy.** `max_visits`, số lần thử mỗi nấc, số lần retry
   timeout, ngân sách agent run, deadline và tier tự động vẫn giữ nguyên. Hết trần thì task tới deputy. Bản thân
   deputy không bị giới hạn số lượt: nó quyết bù lượt, nới ngân sách hay deadline, đổi model, duyệt nâng nấc, hay
   kết thúc task. Khi không khai binding `deputy`, daemon kết thúc wait cạn trần bằng `task fail` với actor
   `system:deputy-absent`, cho cùng kết quả như #247 hiện nay (PR draft nếu có việc chưa publish, rồi FAILED).
4. **Phiên native.** Mỗi lần đánh thức là phiên tương tác của harness, resume đúng phiên deputy của task với sự cố
   làm prompt đầu tiên, chạy trong terminal backend theo cùng vòng đời với worker
   ([ADR-0002](../../docs/adr/0002-systemd-runner-lifetime.md)). Lượt kết thúc khi harness báo hết lượt; daemon dừng
   process sau một khoảng ngắn. Phiên logic sống tới khi task kết thúc, process thì không. Deputy không cần trả kết
   quả có cấu trúc: đầu ra của nó là các lệnh `cusr`, vốn đã có cấu trúc và được daemon kiểm tra.

Deputy không thay đổi gì ở worker: binding, context packet và quyền của coder, fixer, reviewer giữ nguyên.

**Ngoài phạm vi:**

- Quyết định merge, bật yolo, nhận PR có sẵn và mọi quyền `admin` khác. Deputy không merge
  ([constitution](../../.specify/memory/constitution.md) V).
- Chính kênh nhận task từ GitHub issue hay Telegram (feature 005). Feature này chỉ quy định vai trò của deputy khi
  kênh đó có (FR-040).
- Thông báo do deputy viết qua Telegram hay tới phiên trợ lý. Đây là giai đoạn sau. Thông báo trạng thái thông
  thường vẫn do daemon dựng từ event ([constitution](../../.specify/memory/constitution.md) I).
- Lệnh, màn hình hay báo cáo mới dành cho người dùng. Các lệnh và cờ mới của feature (`task add --draft`,
  `task revise`, `--reason`, các tùy chọn mới của `amend-policy`) dành cho caller: trợ lý, deputy, connector.
- Thu gọn context của harness cho worker hay cho deputy.
- Mục 1–2 của #248 (ngân sách leo thang, decider trả lời nhiều lần): feature này thay thế chúng.

## Clarifications

### Session 2026-11-08 (thảo luận với chủ dự án)

- Q: Một phiên chat theo ngày hay nhiều phiên? → A: Mỗi task một phiên, sống tới khi task kết thúc. Một phiên theo
  ngày làm mỗi sự cố phải đọc lại cả ngày, chậm dần, dễ lệch, và các task phải xếp hàng chờ nhau.
- Q: Headless hay phiên native? → A: Native. Chủ dự án xác nhận lại sau khi xem lý do ADR-0006 loại TUI tương tác
  cho worker: deputy không cần hợp đồng stream-json, và phiên treo thì tiếp tục ở chế độ không tương tác.
- Q: Tạo phiên luôn khi task bắt đầu hay khi cần? → A: Khi cần: lần đầu task cần deputy (viết task nháp hoặc sự cố
  đầu tiên). Task trơn tru không tốn lượt nào.
- Q: Deputy có giữ lease của trợ lý không? → A: Không. Deputy do daemon gọi, quyền ngang trợ lý. Khuyến nghị dùng
  model cao vì nó ra quyết định.
- Q: Deputy luôn bật hay chỉ khi bật `autonomous`? → A: Luôn bật với chỗ kẹt về vận hành. Câu hỏi về spec và yêu
  cầu của worker vẫn theo cờ `autonomous`.
- Q: Deputy có trần ngân sách hay số lượt không? → A: Không. Trần hiện có chỉ là trần thử lại trước khi chuyển cho
  deputy; deputy tự quyết ngân sách, kể cả có cần tăng hay không.
- Q: Quyền ghi của deputy? → A: Toàn quyền; giới hạn duy nhất là worktree của task. Muốn đổi code thì giao cho worker.
- Q: Ai viết task? → A: Trợ lý giao task trực tiếp được, không qua deputy. Trợ lý cũng có thể nhờ deputy viết task
  và chọn agent. Task từ kênh ngoài do deputy viết lại. Chủ dự án xem mô tả và agent đã chọn của mọi task trước khi
  chạy; deputy không bao giờ xác nhận task.
- Q: Deputy và trợ lý cùng gỡ một task thì sao? → A: Chủ dự án luôn thắng. Thao tác của chủ dự án làm đổi version
  nên lệnh cũ của deputy bị từ chối; deputy đọc lại và không làm ngược chủ dự án.
- Q: Chủ dự án đọc deputy ở đâu? → A: Ở chỗ đã có: `decisions.md`, `cusr report`, chi tiết task, mô tả PR, và hỏi
  trợ lý qua chat.
- Q: Deputy có thay decider không? → A: Thay hẳn.

### Session 2026-11-08 (chất vấn spec đối chiếu tài liệu và code)

- Q: Wait nào tới deputy? → A: Một bảng tường minh trên mọi mã wait, kiểm tra đủ lúc biên dịch như `NEEDS_USER`
  (FR-001). `boundary_violation` không phải mã wait mà là `effect_failed` có `detail.failure = 'boundary_violation'`.
- Q: Deputy nới ngân sách bằng lệnh nào? → A: `continue` và `amend-policy` được mở rộng cho các wait về ngân sách,
  deadline, backoff và chờ CI; số lượng do deputy chọn (FR-030–FR-033).
- Q: `amend-policy` cho ai? → A: Hạ xuống `operate`; trợ lý cũng được dùng (chủ dự án đồng ý).
- Q: Khi nào chuyển sự cố cho người? → A: Sự cố là một wait cụ thể. Hết lượt mà task vẫn ở đúng wait đó thì chuyển,
  dù deputy có ghi hay không. Dữ liệu theo dõi lượt không làm đổi version của task (FR-020–FR-022).
- Q: Deputy gọi `cusr` thế nào để không bị coi là worker hay trợ lý? → A: Runner gắn dấu hiệu riêng cho deputy; CLI
  luôn ghi actor `deputy` khi có dấu hiệu đó và làm im các hook của trợ lý (FR-050–FR-052).
- Q: Giới hạn ở worktree bằng gì? → A: Dùng lại cơ chế của reviewer: daemon ghi bền mốc worktree của task trước
  lượt và trả worktree về mốc đó sau lượt (FR-053). Không chặn ghi ở tầng hệ điều hành: `ReadOnlyPaths` của unit user
  không có hiệu lực trên Ubuntu (đã thử), còn bubblewrap hay sandbox của harness đòi người dùng cài thêm.
- Q: Lý do của mỗi thao tác lưu ở đâu? → A: Một trường `reason` chung cho mọi lệnh ghi, bắt buộc với deputy (FR-055).
- Q: Viết task nháp bằng gì? → A: `task add --draft`, wait `needs_draft`, lệnh `task revise`; daemon từ chối mọi lệnh
  xác nhận từ deputy (FR-040–FR-043).
- Q: Lượt deputy lỗi thì sao? → A: Hạn mức thì chờ reset; auth, refusal, thiếu capability hay harness thì chuyển
  ngay; lỗi hạ tầng thì retry với backoff, không trần mặc định. Không có wall time mặc định (FR-024).
- Q: Cờ `autonomous` xét lúc nào? → A: Lúc định tuyến câu hỏi. Bật cờ thì các câu hỏi đang chờ được định tuyến lại
  (FR-003).
- Q: Nâng cấp khi decider đang chạy dở? → A: Đóng các lượt decider còn lại bằng trigger hiện có để không giữ mất
  reservation; lịch sử decider vẫn đọc được (FR-072).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Task kẹt về vận hành được gỡ mà không chờ chủ dự án (Priority: P1)

Chủ dự án xếp task rồi đi ngủ. Một task hết lượt thử ở nấc hiện tại, một task bị reviewer bắt lặp cùng finding,
một task hết lượt vào step `ci`. Thay vì nằm chờ tới sáng, mỗi task được deputy của nó xem xét: đọc diễn biến,
log, diff, rồi chọn cách đi tiếp và thực hiện bằng lệnh `cusr`. Sáng ra chủ dự án thấy PR và danh sách quyết định,
không phải danh sách chỗ kẹt.

**Why this priority**: Đây là lý do tồn tại của feature: bỏ điểm dừng chờ người ở những chỗ cần phán đoán.

**Independent Test**: Với harness fake, đưa một task vào từng mã wait mà bảng FR-001 định tuyến tới deputy. Deputy
fake gọi `task continue` hoặc `task approve`; task chạy tiếp mà không có mục attention nào tới chủ dự án.

**Acceptance Scenarios**:

1. **Given** task hết lượt thử ở nấc cuối được tự động (`ladder_exhausted`), **When** engine vào wait, **Then**
   deputy của task được đánh thức kèm nội dung sự cố, và trợ lý không được đánh thức cho sự cố đó.
2. **Given** deputy duyệt nâng nấc trong ladder đã đóng băng, **When** lệnh duyệt hợp lệ, **Then** attempt mới chạy
   ở nấc mới, approval ghi actor `deputy` và lý do.
3. **Given** task ở một wait mà bảng FR-001 loại trừ (ví dụ `merge`, `auth_config`, `refused`, `paused`,
   `effect_failed` do vi phạm ranh giới), **When** engine vào wait, **Then** deputy không được đánh thức và sự cố đi
   tới chủ dự án như hiện nay.
4. **Given** lượt của deputy kết thúc và task vẫn ở đúng wait đã đánh thức nó, **When** daemon nhận tín hiệu hết
   lượt, **Then** sự cố được chuyển tới chủ dự án như hiện nay, kèm tin nhắn cuối của deputy, dù deputy có gọi lệnh
   nào hay không.

---

### User Story 2 - Deputy quyết ngân sách, deadline và model khi trần thử lại cạn (Priority: P1)

Task hết lượt vào step, hết lượt thử ở mọi nấc tự động, hết ngân sách agent run hay quá deadline. Deputy xem task
đang tiến gần đích hay đang lặp vô ích, rồi chọn: bù lượt, nới ngân sách hay deadline, đổi hoặc nâng model cho bước
đang chờ, hay kết thúc task có lý do để giải phóng chỗ cho task khác.

**Why this priority**: Chủ dự án xác định đây là chỗ cần deputy nhất. Trần cố định không phân biệt được task sắp
xong với task vô vọng.

**Independent Test**: Đưa task vào từng wait ở FR-030; deputy fake lần lượt chọn bù lượt, nới ngân sách, nới
deadline, đổi model, kết thúc task. Kiểm tra mỗi lựa chọn tạo đúng event, actor `deputy` và lý do, và lượt của
deputy không bị tính vào bất kỳ trần nào.

**Acceptance Scenarios**:

1. **Given** task ở `loop_exhausted`, **When** deputy chạy `continue`, **Then** task chạy tiếp từ bước đang chờ như
   khi chủ dự án làm.
2. **Given** task ở `agent_runs_exhausted`, **When** deputy nới ngân sách thêm N lượt, **Then** policy được sửa với
   actor `deputy` và lý do, và task chạy tiếp.
3. **Given** task ở `deadline`, **When** deputy dời deadline, **Then** task chạy tiếp tới mốc mới.
4. **Given** task ở `backoff_exhausted` hoặc `ci_wait_exhausted`, **When** deputy chạy `continue`, **Then** một chuỗi
   backoff mới bắt đầu, hoặc một cửa sổ chờ CI mới với độ dài đã đóng băng được mở.
5. **Given** task hết thang, **When** deputy đổi model cho bước đang chờ trong phạm vi `allow_models` của cấu hình
   user, **Then** policy được sửa như `task amend-policy`, kèm actor `deputy` và lý do.
6. **Given** deputy đánh giá task không còn đáng chạy, **When** nó chạy `task fail --reason`, **Then** task về FAILED
   có lý do (PR draft nếu có việc chưa publish), và slot được giải phóng.
7. **Given** deputy đã xử lý nhiều sự cố của cùng task, **When** một sự cố mới tới, **Then** deputy vẫn được đánh
   thức; không có trần số lần gọi deputy.

---

### User Story 3 - Câu hỏi về spec của worker theo cờ `autonomous` (Priority: P2)

Worker dừng vì câu hỏi về yêu cầu hay thiết kế. Khi `autonomous` bật, deputy trả lời theo spec và quy ước của repo,
ghi giả định, và giả định đó xuất hiện trong mô tả PR để chủ dự án xem lúc review. Khi `autonomous` tắt, câu hỏi
tới chủ dự án như hiện nay.

**Why this priority**: Câu hỏi về spec là nơi chủ dự án muốn tự giữ quyền chọn khi cần, nên tách thành cờ riêng.

**Independent Test**: Tạo câu hỏi `agent_question` với `autonomous` tắt, rồi bật cờ; kiểm tra câu hỏi được định
tuyến lại tới deputy, người trả lời, và mục giả định trong mô tả PR.

**Acceptance Scenarios**:

1. **Given** `autonomous` bật, **When** worker hỏi, **Then** deputy trả lời, câu trả lời mang actor `deputy`, và câu
   hỏi tiếp theo ở cùng step cũng tới deputy (không còn quy tắc "một câu mỗi step").
2. **Given** `autonomous` tắt, **When** worker hỏi, **Then** câu hỏi tới chủ dự án; deputy vẫn xử lý các sự cố vận
   hành của cùng task.
3. **Given** câu hỏi đang chờ chủ dự án vì `autonomous` tắt, **When** chủ dự án bật cờ, **Then** câu hỏi được định
   tuyến lại tới deputy.
4. **Given** deputy đã trả lời một câu hỏi về spec, **When** task được publish lần kế tiếp, **Then** mô tả PR có mục
   liệt kê các giả định của deputy cho task.

---

### User Story 4 - Nhờ deputy viết task và chọn agent (Priority: P2)

Chủ dự án bảo trợ lý "giao việc này, để deputy viết". Trợ lý tạo task nháp từ yêu cầu. Deputy viết mô tả và
acceptance, chọn agent và model cho từng vai (trừ khi chủ dự án đã chỉ định). Trợ lý hiện đề xuất cho chủ dự án,
chủ dự án xác nhận hoặc bảo trợ lý sửa. Sau khi xác nhận, task chạy tới cuối. Chủ dự án vẫn có thể bảo trợ lý giao
thẳng, không qua deputy.

**Why this priority**: Giảm việc viết task cho chủ dự án, nhưng không bắt buộc cho luồng gỡ rối.

**Independent Test**: Tạo task bằng `task add --draft`; kiểm tra deputy được đánh thức, task có mô tả và run config
do deputy đề xuất, task chờ xác nhận, và lệnh xác nhận từ deputy bị từ chối.

**Acceptance Scenarios**:

1. **Given** trợ lý tạo task nháp, **When** deputy hoàn thiện bằng `task revise` và `task propose`, **Then** task chờ
   xác nhận với mô tả, acceptance và run config đề xuất; trợ lý đọc được để hiện cho chủ dự án.
2. **Given** chủ dự án đã chỉ định agent, **When** deputy viết task, **Then** run config giữ đúng chỉ định đó.
3. **Given** chủ dự án sửa mô tả hay run config trước khi xác nhận, **When** deputy được đánh thức lần sau, **Then**
   nó nhận được thao tác sửa đó và làm việc trên phiên bản đã sửa.
4. **Given** deputy gọi lệnh xác nhận intake hay run config cho bất kỳ task nào, **When** daemon nhận lệnh, **Then**
   lệnh bị từ chối.

---

### User Story 5 - Chủ dự án và deputy cùng thao tác trên một task (Priority: P2)

Deputy đang xử lý một sự cố thì chủ dự án bảo trợ lý gỡ đúng task đó. Thao tác của chủ dự án thắng, deputy không
ghi đè và không làm ngược lại.

**Why this priority**: Deputy luôn bật, nên chuyện hai bên cùng chạm một task là bình thường, không phải ngoại lệ.

**Independent Test**: Trong lúc deputy fake đang trong lượt, gửi một thao tác của chủ dự án; lệnh tiếp theo của
deputy với version cũ bị từ chối, lệnh của chủ dự án không bị từ chối vì lượt của deputy, và lần đánh thức sau
deputy nhận được thao tác của chủ dự án.

**Acceptance Scenarios**:

1. **Given** deputy đang trong lượt, **When** chủ dự án trả lời câu hỏi hay `continue` task, **Then** lệnh của chủ dự
   án được nhận, và lệnh tiếp theo của deputy dùng version cũ bị từ chối với conflict.
2. **Given** lượt của deputy bắt đầu hay kết thúc, **When** chủ dự án gửi lệnh với version vừa đọc, **Then** lệnh
   không bị từ chối vì việc theo dõi lượt của deputy.
3. **Given** chủ dự án hỏi trợ lý về task deputy đang xử lý, **When** trợ lý đọc chi tiết task, **Then** nó thấy
   deputy đang xử lý sự cố nào từ lúc nào.

---

### User Story 6 - Xem deputy đã làm gì (Priority: P3)

Sáng ra chủ dự án muốn biết đêm qua deputy quyết gì và vì sao, ở những chỗ đã quen dùng.

**Why this priority**: Cần để tin deputy, nhưng dựa hoàn toàn vào dữ liệu đã có.

**Independent Test**: Sau một loạt quyết định của deputy fake, kiểm tra `decisions.md`, `cusr report`, chi tiết task
và mô tả PR đều cho thấy chúng, mỗi quyết định gắn với đúng sự cố.

**Acceptance Scenarios**:

1. **Given** deputy đã thực hiện thao tác trên nhiều task, **When** chủ dự án mở `decisions.md` hoặc chạy
   `cusr report`, **Then** mỗi thao tác có thời điểm, task, sự cố, hành động và lý do.
2. **Given** terminal backend khả dụng, **When** deputy đang trong lượt, **Then** chủ dự án mở được cửa sổ mang tên
   vai trò và tiêu đề task để xem và gõ vào phiên.

### Edge Cases

- **Phiên tương tác treo** ở hộp thoại của harness (tin thư mục, menu khi chạm hạn mức, đăng nhập hết hạn): không có
  tín hiệu hết lượt trong thời gian stall thì daemon dừng process và resume **cùng phiên** ở chế độ không tương tác
  cho cùng sự cố. Lượt không tương tác treo được coi là lỗi process (FR-024).
- **Không có terminal backend** (ví dụ chưa có tmux server): deputy chạy ở chế độ không tương tác ngay từ đầu, cùng
  một phiên, cùng hành vi.
- **Deputy chạm hạn mức, lỗi auth, lỗi hạ tầng**: theo FR-024. Lượt của deputy không tính vào số lỗi của task.
- **Mất phiên hoặc đổi harness giữa task**: binding được đọc lại mỗi lần đánh thức. Cùng harness thì resume; khác
  harness hoặc phiên mất thì mở phiên mới, nạp bản tóm tắt do code dựng từ lịch sử task và các quyết định trước của
  deputy, ghi vào bản ghi lượt, không chuyển cho người.
- **Daemon restart giữa lượt**: lượt đang chạy được nhận lại, không khởi động lượt thứ hai cho cùng sự cố
  ([constitution](../../.specify/memory/constitution.md) II).
- **Hai sự cố liên tiếp của cùng task**: xử lý tuần tự trong cùng phiên; sự cố sau chờ lượt trước xong.
- **Task kết thúc** khi deputy đang trong lượt: lượt được dừng, phiên đóng; lệnh muộn của deputy bị từ chối.
- **Task chờ bên ngoài lâu** (merge, CI, observation): không có process deputy nào chạy; sự cố mới mở lại đúng phiên.
- **Deputy sửa worktree của task mình** bằng bất kỳ cách nào, kể cả shell và `git commit`: sau lượt, worktree và HEAD
  được trả về mốc trước lượt, nên thay đổi không vào task và engine không thấy `worktree_changed` do deputy. Trả về
  thất bại thì xử lý như reviewer: bước worker kế tiếp thấy cây đã đổi và vào `worktree_changed`, wait này tới deputy.
- **Deputy sửa worktree của task khác**: không có lớp chặn ở tầng hệ điều hành; chỉ dẫn vai trò và luật cấm sửa file
  theo đường dẫn của harness là rào chắn (FR-054). Nếu vẫn xảy ra, task kia thấy `worktree_changed` như khi có người
  sửa tay.
- **Bật hay tắt `autonomous` giữa chừng**: câu hỏi đang mở được định tuyến lại theo cờ mới; câu hỏi đang trong lượt
  của deputy thì xử lý xong; sự cố đã chuyển cho người thì vẫn ở với người.
- **Chưa khai binding `deputy`**: mọi chỗ kẹt đi tới chủ dự án như hiện nay; wait cạn trần được daemon kết thúc bằng
  `task fail` (FR-004).
- **Task đang chờ slot, hạn mức, CI hay hòa giải effect**: không đánh thức deputy; task tự chạy tiếp như hiện nay.
  `effect_unknown` kéo dài quá ngưỡng của #249 mới tới deputy, deputy dùng `recheck`.
- **Deputy tạo task mới** (ví dụ tách việc): dùng `task add` trực tiếp, không qua `needs_draft`; task chờ chủ dự án
  xác nhận và chưa có phiên deputy cho tới sự cố đầu tiên của nó.
- **Nâng cấp khi decider đang chạy dở**: theo FR-072.
- **Nội dung không tin cậy** (output của worker, yêu cầu từ kênh ngoài) chứa chỉ thị: deputy coi là dữ liệu. Đây là
  rủi ro chủ dự án chấp nhận (Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

#### Định tuyến tới deputy

- **FR-001**: Hệ thống MUST có một bảng tường minh xếp mỗi mã wait vào đúng một nơi đến, và việc thiếu một mã MUST
  làm build thất bại:
  - **Tự tiếp tục** (không đánh thức ai, như hiện nay): mọi mã mà task tự chạy tiếp được, gồm `dependency_pending`,
    `checks_incomplete`, `effect_unknown`, `infra_backoff`, `rate_limited`, `execution_slot`, `merge_cleanup_pending`,
    `observation_unknown`. Riêng `effect_unknown` chờ quá ngưỡng của #249 thì tới deputy.
  - **Tới chủ dự án:** mọi mã PENDING trừ `needs_draft` và `dependency_pending`; `run_config_unconfirmed` (task READY
    chưa xác nhận run config; ở cấp step engine kết thúc task theo FR-004, không có wait); `paused`;
    `escalation_rejected`; `adopt_approval`; `merge`; `auth_config`; `harness_auth`; `refused`; và `effect_failed` có
    `detail.failure = 'boundary_violation'`.
  - **Câu hỏi của worker** (`agent_question`, `agent_needs_context`, `agent_blocked`): tới deputy khi `autonomous` bật,
    tới chủ dự án khi tắt.
  - **Tới deputy:** mọi mã còn lại.

  Nhóm "tự tiếp tục" MUST trùng đúng tập mã mà phân loại "cần người" hiện có coi là không cần người.
- **FR-002**: Nơi sinh ra vi phạm ranh giới MUST ghi `detail.failure = 'boundary_violation'` có cấu trúc, không chỉ
  trong văn bản câu hỏi.
- **FR-003**: Việc câu hỏi của worker tới deputy hay chủ dự án MUST xét theo cờ `autonomous` tại lúc định tuyến. Khi
  cờ đổi, câu hỏi đang mở MUST được định tuyến lại, trừ câu đang trong lượt của deputy và câu đã chuyển cho người.
- **FR-004**: Engine MUST vào wait như hiện nay, kể cả khi hết thang (`ladder_exhausted`) hay gặp nấc bị từ chối
  (`rung_denied`); hai mã này là **wait cạn trần**. Engine không biết có deputy hay không; việc định tuyến là của
  daemon. Khi không khai binding `deputy`, daemon MUST kết thúc wait cạn trần bằng `task fail` (FR-036) với actor
  `system:deputy-absent`, và attention MUST NOT báo cho người trong khoảng chờ đó. Khi đã khai binding, wait cạn trần
  MUST tới deputy và MUST NOT tự về FAILED, kể cả khi deputy không khởi động được hay chuyển sự cố. `context_budget`
  và `run_config_unconfirmed` ở cấp step vẫn do engine kết thúc theo #247, vì deputy không gỡ được chúng.
- **FR-005**: Trong lúc deputy có thể xử lý một sự cố, hệ thống MUST NOT đánh thức trợ lý cho sự cố đó.

#### Phiên của deputy

- **FR-010**: Mỗi task MUST có tối đa một phiên deputy, tạo vào lần đầu task cần deputy (wait `needs_draft` hoặc sự
  cố đầu tiên). Task không bao giờ cần deputy thì không có phiên.
- **FR-011**: Phiên MUST tồn tại tới khi task kết thúc; mọi sự cố sau của task MUST đi vào đúng phiên đó, trừ trường
  hợp FR-016.
- **FR-012**: Mỗi lần đánh thức MUST chạy phiên tương tác của harness, resume phiên deputy của task với sự cố làm
  prompt đầu tiên, trong terminal backend, cùng vòng đời với worker. Khi không có terminal backend, lượt MUST chạy
  cùng phiên ở chế độ không tương tác.
- **FR-013**: Cuesura MUST thêm hook báo hết lượt vào cấu hình của phiên deputy, gộp với hook của chủ dự án chứ không
  thay. Tín hiệu MUST gắn với phiên deputy và sự cố, không gắn với lease của trợ lý. Nhận tín hiệu thì daemon MUST
  dừng process sau một khoảng ngắn.
- **FR-014**: Không có tín hiệu hết lượt trong thời gian stall đã cấu hình thì daemon MUST dừng process và resume cùng
  phiên ở chế độ không tương tác cho cùng sự cố.
- **FR-015**: Giữa các sự cố, không có process deputy nào chạy và không có lượt gọi model nào.
- **FR-016**: Binding MUST được đọc lại mỗi lần đánh thức. Cùng harness thì resume. Khác harness hoặc phiên không còn
  thì MUST mở phiên mới, nạp bản tóm tắt do code dựng từ lịch sử task và các quyết định trước của deputy, và ghi điều
  đó vào bản ghi lượt; không chuyển sự cố cho người vì lý do này.
- **FR-017**: Mỗi lần đánh thức MUST đưa vào phiên: sự cố (mã wait, chi tiết, bằng chứng) và mọi thao tác ghi trên task
  kể từ lượt trước của bất kỳ actor nào khác deputy của task này (chủ dự án, trợ lý, deputy của task khác, `system:`),
  mỗi thao tác kèm actor và lý do. Deputy MUST đọc được chi tiết task, lịch sử, log, diff và tài liệu của repo.
- **FR-018**: Mỗi task MUST có tối đa một lượt deputy chạy cùng lúc; sự cố mới của task đang có lượt MUST chờ. Deputy
  của các task khác nhau MUST chạy song song được.
- **FR-019**: Khi task kết thúc, hệ thống MUST dừng lượt đang chạy (nếu có) và đóng phiên. Transcript MUST được giữ
  theo retention hiện có.

#### Sự cố, lượt và chuyển cho người

- **FR-020**: Một sự cố MUST là một lần vào wait cụ thể: task, revision, mã wait và sequence của event vào wait đó.
- **FR-021**: Khi lượt kết thúc mà task vẫn ở đúng lần vào wait đó, hệ thống MUST chuyển sự cố cho chủ dự án như hiện
  nay, bất kể deputy có ghi gì, kèm tin nhắn cuối của deputy để câu hỏi deputy để lại tới được người.
- **FR-022**: Bản ghi lượt và việc chuyển sự cố MUST bền qua restart, MUST nằm ngoài event log có version của task, và
  MUST NOT làm đổi version của task.
- **FR-023**: Chi tiết task MUST cho thấy deputy đang xử lý sự cố nào và từ lúc nào, khi có lượt đang chạy.
- **FR-024**: Lỗi của lượt deputy MUST xử lý như sau, và MUST NOT tính vào bộ đếm lỗi hay trần nào của task:
  (a) hạn mức hay quá tải: chờ tới `reset_at`, xoay tài khoản theo account pool, sự cố vẫn thuộc deputy;
  (b) auth, refusal, thiếu capability hay thiếu harness: chuyển sự cố cho chủ dự án ngay, ghi lý do;
  (c) lỗi hạ tầng hay process (kể cả lượt không tương tác bị treo): retry cùng sự cố theo `limits.backoff.infra` đã
  đóng băng của task, không có trần trừ khi `roles.deputy.limits.infra_retries` được khai; chạm trần đã khai thì
  chuyển cho chủ dự án.
  Wall time của lượt là tùy chọn trong limits của role `deputy`, mặc định không có.
- **FR-025**: Lượt của deputy MUST NOT bị tính vào ngân sách agent run, lượt vào step, lượt thử hay bất kỳ trần nào
  của task, và MUST NOT có trần số lần gọi.

#### Hành động của deputy

- **FR-030**: `task continue` và `task amend-policy` MUST nhận thêm các wait `agent_runs_exhausted`,
  `agent_runs_insufficient`, `deadline`, `backoff_exhausted` và `ci_wait_exhausted`, ngoài các wait đang nhận.
- **FR-031**: `task amend-policy` MUST có `--agent-runs +N` và `--deadline <thời điểm|+khoảng>`, với N và thời điểm do
  người gọi chọn, ghi thành `PolicyAmended` kèm actor và lý do (I08). `agent_runs_insufficient` chỉ được gỡ bằng
  `--agent-runs`.
- **FR-032**: `task continue` trên `backoff_exhausted` MUST reset bộ đếm lỗi của lớp đó ở step, để một chuỗi backoff
  mới bắt đầu. Trên `ci_wait_exhausted`, MUST mở một cửa sổ chờ CI mới với độ dài đã đóng băng.
- **FR-033**: Quyền xác nhận `task amend-policy` MUST hạ từ `admin` xuống `operate`. `allow_models`, `above: deny` và
  approval theo tier vẫn ràng buộc như hiện nay.
- **FR-034**: Deputy MUST dùng được mọi thao tác `operate` trên task của nó và trên task khác: trả lời câu hỏi,
  `continue`, `recheck`, duyệt escalation, `amend-policy`, `pause`/`resume`, `cancel`, tạo và sửa task nháp, và kết
  thúc có lý do bằng `task fail` (FR-036).
- **FR-035**: Vai trò của deputy MUST yêu cầu nó không làm ngược thao tác của chủ dự án hay trợ lý trong cùng
  revision.
- **FR-036**: Lệnh `operate` mới `task fail <id> --reason` MUST kết thúc một task đang WAITING theo đúng đường của
  #247: task đã có worktree mà chưa có PR thì mở PR draft chứa phần việc đã có rồi về FAILED; trường hợp khác về
  FAILED ngay. `--reason` bắt buộc với mọi actor và được ghi làm lý do FAILED. Task không ở WAITING thì lệnh bị từ
  chối. Deputy dùng lệnh này để kết thúc có lý do; daemon gửi cùng trigger với actor `system:deputy-absent` (FR-004).

#### Nhận việc

- **FR-040**: Khi có kênh nhận task từ bên ngoài (feature 005), connector MUST tạo task nháp từ yêu cầu thô, và deputy
  viết lại thành task chuẩn. Nội dung yêu cầu MUST được coi là đề bài, không phải chỉ thị cho deputy.
- **FR-041**: `task add --draft` MUST tạo task ở wait PENDING `needs_draft`, mã PENDING duy nhất tới deputy. Trợ lý
  MUST vẫn tạo được task thường, không qua deputy.
- **FR-042**: Lệnh `operate` mới `task revise` MUST sửa được tiêu đề, mô tả và acceptance của task trước khi policy
  đóng băng, dùng lại `TaskRevised`. Deputy hoàn thiện task nháp bằng `task revise` và `task propose`, giữ nguyên agent,
  model hay chế độ chủ dự án đã chỉ định; sau đó task chờ xác nhận intake hoặc run config.
- **FR-043**: Daemon MUST từ chối mọi lệnh xác nhận intake hay run config từ actor `deputy`, trên mọi task. Đề xuất
  MUST đọc được qua trợ lý: mô tả, acceptance, agent và model từng vai. `intake.auto_confirm` MUST NOT áp dụng cho task
  nháp.
- **FR-044**: Phiên tạo cho `needs_draft` MUST là phiên của task từ đó về sau. Task do deputy tạo bằng `task add`
  thường MUST chờ chủ dự án xác nhận và chưa có phiên cho tới sự cố đầu tiên của nó.

#### Danh tính, quyền và ranh giới ghi

- **FR-050**: Runner MUST khởi chạy deputy với dấu hiệu riêng. Khi có dấu hiệu này, CLI MUST cho chạy (không bị chặn
  như worker) và MUST luôn dùng actor `deputy`, bỏ qua `CUSR_ACTOR`. `deputy` MUST được thêm vào danh sách actor tự
  khai, với quyền `read` và `operate`; không có quyền `admin` nào (bật yolo, nhận PR có sẵn, merge).
- **FR-051**: Khi có dấu hiệu deputy, `cusr assistant hook`, `cusr assistant session-start`, `cusr assistant register`
  và `cusr assistant wait` MUST thoát 0 và không làm gì.
- **FR-052**: Task do deputy tạo MUST mang loại người yêu cầu riêng, để quy tắc cần xác nhận áp dụng cho chúng.
  `intake.auto_confirm` MUST NOT áp dụng cho loại này, và config liệt kê `deputy` trong `intake.auto_confirm` MUST bị
  validate từ chối.
- **FR-053**: Deputy MUST chạy với toàn quyền tool của harness và không hỏi quyền. Thay đổi của deputy trong worktree
  của task MUST NOT vào task: trước mỗi lượt daemon MUST ghi bền mốc (HEAD và cây checkpoint) của worktree, và sau lượt,
  kể cả sau khi daemon khởi động lại, MUST trả worktree về mốc đó bằng cùng cơ chế với reviewer (branch về lại nếu
  deputy commit, file sửa hay xóa được lấy lại, file tạo mới bị xóa, file ignored giữ nguyên).
- **FR-054**: Với worktree của task khác, vai trò của deputy MUST yêu cầu nó không sửa, và cấu hình phiên deputy MUST cấm
  tool sửa file của harness trên thư mục worktree khi harness hỗ trợ luật theo đường dẫn. Không có lớp chặn ở tầng hệ
  điều hành, và feature MUST NOT đòi người dùng cài thêm công cụ cho việc này.
- **FR-055**: Mọi lệnh ghi MUST nhận một trường `reason` tùy chọn ở cấp lệnh (CLI `--reason`). Với actor `deputy`, trường
  này MUST bắt buộc. Lý do MUST được lưu cùng event của lệnh.
- **FR-056**: Mọi lệnh ghi của deputy MUST mang expected version, request ID và ID của lượt hiện tại (lấy từ môi trường
  runner). Daemon MUST kiểm tra lượt đang mở và lưu ID lượt cùng bản ghi lệnh và event của nó.

#### Ghi nhận và xem lại

- **FR-060**: Quyết định của deputy MUST hiện ở những chỗ đã có, dựng bằng code từ event: `<data dir>/decisions.md`,
  `cusr report` (thay mục câu trả lời của decider), chi tiết task và lịch sử task, mỗi quyết định gắn với sự cố qua ID
  lượt.
- **FR-061**: Mỗi lần publish, phần thân PR MUST có mục do code dựng liệt kê quyết định của deputy ảnh hưởng tới nội
  dung (câu trả lời cho câu hỏi về spec, đổi model, bù lượt, nới ngân sách). Quyết định sau lần publish cuối chỉ hiện ở
  `decisions.md`, `report` và chi tiết task; không thêm effect riêng để sửa PR.

#### Thay decider, cấu hình và nâng cấp

- **FR-070**: Deputy MUST thay decider. Quy tắc "sau một câu trả lời, câu hỏi tiếp ở cùng step chờ người" và nhãn
  `grill` MUST bị bỏ.
- **FR-071**: Binding của deputy MUST khai qua role `deputy` trong user config. Thiếu role này thì hệ thống chạy như
  khi không có deputy, config vẫn hợp lệ. `autonomous: true` MUST NOT còn đòi role nào. Config cũ có role `decider`
  MUST chạy được không phải sửa: binding đó được dùng làm binding của deputy, kèm cảnh báo đổi tên; nó cần một lần
  `prove-harness`/`record-manifest` trước khi chạy được như deputy, trước đó FR-024(b) áp dụng.
- **FR-072**: Lần khởi động đầu sau nâng cấp, daemon MUST đóng mỗi bản ghi decider còn dở bằng `decider_ran`
  (`apply: false`, lỗi `superseded`), để reservation được dùng hay trả tùy theo `invoked`; câu hỏi sau đó được định
  tuyến theo FR-001. `decider_start`/`decider_ran` chỉ còn được nhận cho việc dọn này. Event `DeciderRan` và câu trả
  lời `agent:decider` cũ MUST vẫn replay được và vẫn hiện trong `decisions.md` và `report`.
- **FR-073**: `cusr doctor` MUST báo deputy có dùng được không: binding, harness, manifest và terminal backend.

### Key Entities

- **Phiên deputy (deputy session)**: thuộc đúng một task; mang harness, binding, tham chiếu phiên của harness, thời
  điểm tạo và trạng thái (đang chạy, nghỉ, đã đóng). Tồn tại tới khi task kết thúc.
- **Lượt deputy (deputy turn)**: một lần đánh thức cho một sự cố; mang ID lượt, sự cố (lần vào wait), thời điểm bắt
  đầu và kết thúc, chế độ (tương tác hay không), có mở phiên mới từ bản tóm tắt hay không, tin nhắn cuối, và kết quả
  (đã thao tác, chuyển cho chủ dự án, bị dừng). Bền qua restart, nằm ngoài event log có version của task.
- **Quyết định của deputy**: một thao tác ghi của actor `deputy`, kèm lý do và ID lượt; là nguồn cho `decisions.md`,
  report và mục quyết định trong mô tả PR.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Trong bộ kiểm thử fake, 100% task đưa vào các mã wait được FR-001 định tuyến tới deputy không tạo mục
  attention cho chủ dự án, trừ khi deputy chuyển sự cố (FR-021, FR-024).
- **SC-002**: Trong một đêm chạy thật với ít nhất 5 task đã xác nhận, chủ dự án không phải thao tác trên task nào tới
  sáng, trừ merge và các mã FR-001 loại trừ.
- **SC-003**: Với phiên tương tác không báo hết lượt, task tiếp tục chậm nhất một phút sau thời gian stall đã cấu
  hình, và không có hai lượt deputy cho cùng sự cố, ở cả hai chế độ.
- **SC-004**: Restart daemon ở mọi điểm trong lượt của deputy (crash injection) không tạo lượt thứ hai và không lặp
  thao tác ghi nào.
- **SC-005**: Trong bộ kiểm thử, sau mọi cách deputy sửa worktree của task mình (tool sửa file, shell, tạo file mới,
  `git commit`), kể cả khi daemon restart giữa lượt, worktree và HEAD của task bằng đúng mốc trước lượt.
- **SC-006**: 100% lệnh ghi của deputy với version cũ sau khi chủ dự án đã thao tác bị từ chối, và 0 lệnh của chủ dự
  án bị từ chối chỉ vì lượt của deputy bắt đầu hay kết thúc.
- **SC-007**: Mỗi quyết định của deputy xuất hiện trong `decisions.md` và `cusr report` với thời điểm, task, sự cố (qua
  ID lượt), hành động và lý do; quyết định ảnh hưởng nội dung xuất hiện trong mô tả PR ở lần publish kế tiếp.
- **SC-008**: Config hiện có (có hoặc không có role `decider`) nạp được sau nâng cấp mà không phải sửa; task đang có
  lượt decider dở không bị giữ mất reservation.

## Assumptions

- Các chỗ kẹt tất định (#245–#249) được xử lý riêng bằng code. Feature này không phụ thuộc vào chúng để chạy đúng,
  chỉ nhận ít sự cố hơn khi chúng xong.
- Harness dùng cho deputy có phiên tương tác báo được hết lượt qua hook và resume được cùng phiên ở chế độ không tương
  tác, như cơ chế trợ lý đang dùng với Claude Code, Codex và pi.
- Deputy chạy cùng vòng đời systemd và terminal backend với worker (sống qua restart daemon, dừng sạch, xem được),
  nhưng khác dấu hiệu và actor. Phiên chạy ở data dir, không ở worktree.
- `allow_models` và trạng thái nấc trong cấu hình user vẫn ràng buộc thao tác đổi model; đó là cấu hình của chủ dự án,
  không phải trần riêng của deputy.
- Rủi ro chủ dự án chấp nhận: deputy có toàn quyền, không hỏi quyền và đọc nội dung không tin cậy.
  Nội dung độc hại có thể khiến nó làm bất cứ gì trên máy trong phạm vi quyền của user. Không thêm cơ chế bảo vệ ngoài
  allowlist nguồn của connector và các quyền daemon vẫn chặn (FR-043, FR-050).
- Tên `deputy` là tên tạm, đổi được trước khi lập plan.

## Tác động lên hiến chương và SPEC

Deputy mâu thuẫn với một số điều khoản hiện hành. Theo [Governance](../../.specify/memory/constitution.md#governance),
chỉ chủ dự án phê duyệt amendment; feature MUST NOT được triển khai trước khi amendment được duyệt. Amendment 10.0.0 đã
được duyệt và merge (PR #254).

| Điều khoản | Hiện tại | Cần đổi |
|---|---|---|
| Nguyên tắc III | Sau một câu trả lời của decider, câu hỏi tiếp ở cùng step chờ người, trừ nhãn `grill` | Bỏ quy tắc này (FR-070) |
| Nguyên tắc V, câu về decider | Decider chỉ trả lời câu hỏi của worker, không cấp approval, chỉ chạy khi người dùng bật | Deputy có quyền `operate`, luôn bật với sự cố vận hành; vẫn không merge, không quyền admin (FR-034, FR-050) |
| Nguyên tắc V, "Agent MUST NOT tự đổi … binding … hay ngân sách" | Không agent nào đổi binding hay ngân sách | Deputy được đổi binding, ngân sách và deadline của worker cho bước đang chờ qua `amend-policy`, ghi actor và lý do (FR-030–FR-033) |
| Nguyên tắc V, "Nâng effort/model/vendor … do code kích hoạt" | Chỉ code nâng model theo thang | Deputy hoặc caller `operate` được đổi model qua `amend-policy` trong `allow_models` |
| Nguyên tắc V, quyền của assistant | `task_amend_policy` là của owner | Hạ xuống `operate`; trợ lý cũng được dùng (FR-033) |
| Trust boundary, "decider MUST giữ sandbox chỉ đọc" | Decider chỉ đọc | Deputy toàn quyền; thay đổi của nó trong worktree của task bị trả về theo mốc như reviewer (FR-053) |
| SPEC I09 | Mọi lần gọi agent thỏa ngân sách; agent không tự đổi giới hạn | Lượt deputy nằm ngoài ngân sách (FR-025); deputy đổi giới hạn của worker qua `amend-policy` |

Nguyên tắc I không cần đổi: engine vẫn vào wait và quyết định chuyển trạng thái bằng code; deputy chỉ được daemon gọi
khi task đã vào wait, và hành động qua cùng dịch vụ với trợ lý.

Cần đồng bộ khi amendment được duyệt:

- SPEC.md: §4 (I09); §9.3 và §15.1 (`amend-policy` thành `operate`, `task revise`, `task add --draft`, `--reason`,
  `continue`/`amend-policy` mở rộng); §10 (câu "không agent nào tự quyết thay" và đoạn Autonomous); §14.1 ("scout và
  decider chỉ đọc"); §15.1 (dòng `cusr report`); §15.2 (actor `deputy`, mốc và trả về worktree như reviewer).
- `deploy/README.md` mục Autonomous: bỏ dòng mỗi lượt giữ một reservation của `budget.agent_runs`, thêm role `deputy`
  và limits của nó.
- ADR-0005 (câu về decider); một ADR mới thay ADR-0006 riêng cho role deputy (phiên tương tác, tín hiệu hết lượt).
- `GLOSSARY.md` (decider → deputy); `docs/architecture.md` (đoạn `cusr report`).
- [specs/003-telegram-channel/spec.md](../003-telegram-channel/spec.md): không push khi deputy đang giữ sự cố thuộc
  FR-001; `/inbox` hiện "deputy đang xử lý"; chuyển sự cố cho người thì push kèm tin nhắn cuối của deputy; các quy tắc
  riêng của decider (lượt lỗi, bật `autonomous` sau khi đã push, FR-021 của 003) thay bằng FR-003 và FR-021 của spec
  này.
- #247 (đã merge, PR #252): engine tự FAILED khi hết thang. Feature này đưa `ladder_exhausted` và `rung_denied` trở
  lại thành wait và chuyển việc kết thúc sang daemon (FR-004); kết quả với người không dùng deputy không đổi.
  Issue #248: mục 1–2 được feature này thay thế.
