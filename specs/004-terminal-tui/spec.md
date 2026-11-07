# Feature Specification: Giao diện tương tác trong terminal cho `cusr`

**Feature Branch**: `004/tui-spec`

**Created**: 2026-10-31

**Status**: Draft

**Input**: User description: "Ứng dụng tương tác ngay trong terminal (TUI) cho Cuesura, theo hướng của
no-mistakes và Bernstein. Gõ `cusr` để vào màn hình chính: thấy project, daemon và các task hiện tại.
Theo dõi trực tiếp: task đang code, review, chờ CI hay chờ người dùng; bước nào lỗi và vì sao. Chọn
task để xem chi tiết: tiến trình workflow, agent/model, log và PR liên quan. Thao tác bằng bàn phím:
tạo task, chọn cấu hình chạy, trả lời câu hỏi, xác nhận hoặc hủy; có menu và gợi ý phím. Được hướng
dẫn khi mới dùng: biết cần cấu hình gì và bước tiếp theo là gì. Trọng tâm: mở terminal lên, nhìn là
hiểu hệ thống đang làm gì và mình có thể làm gì tiếp theo, ít phải nhớ cú pháp lệnh."

## Bối cảnh và phạm vi

Hiện chủ dự án điều khiển Cuesura qua các lệnh con của `cusr`; gõ `cusr` không kèm lệnh chỉ nhận lỗi
"no command given". Muốn biết task đang ở đâu phải ghép `status`, `task list`, `task explain`,
`inbox` và phải nhớ ID, version, request ID, digest. Feature này thêm một giao diện tương tác toàn
màn hình trong terminal, mở bằng `cusr`, để người dùng nhìn là hiểu hệ thống đang làm gì và thao tác
tiếp bằng bàn phím.

Đây là **một mặt giao diện mới trên năng lực sẵn có**, không phải năng lực điều phối mới: mọi trạng
thái vẫn do daemon quyết định và mọi thao tác vẫn đi qua cùng dịch vụ, cùng kiểm tra quyền, version và
chống lặp như CLI. Giao diện không tạo thêm trạng thái task, lối ra hay quyền nào.

**Ngoài phạm vi:**

- Dashboard web; truy cập từ máy khác ngoài những gì terminal/SSH sẵn có; nhiều người dùng.
- Trình thiết lập ghi cấu hình; cài đặt hoặc khởi động/dừng daemon, runner, harness từ giao diện. Giao
  diện chỉ kiểm tra và chỉ bước tiếp theo.
- Gửi merge, bật yolo, duyệt merge, `task retry`, `amend-policy`, group/epic, decider: những gì CLI
  hiện báo chưa hỗ trợ thì giao diện không trình bày như có sẵn.
- Gợi ý cấu hình chạy bằng AI hay bất kỳ lời gọi LLM nào từ giao diện.
- Sửa code hoặc giải quyết diff trong giao diện; thông báo ngoài terminal; tùy biến phím và theme.

**Phạm vi v1:** Giao diện này thuộc v1 theo [SPEC.md §2.1](../../SPEC.md#21-v1), nên không vướng
[hiến chương](../../.specify/memory/constitution.md) nguyên tắc VIII. Dashboard web vẫn ở sau v1.

**Mốc nghiệm thu:** Mốc đầu gồm US1–US5. Có thể làm phần chỉ đọc (US1, US2) trước, nhưng riêng phần đó chưa đạt mốc.
US6 cùng FR-029–FR-031, EC-015 và SC-012 thuộc mốc sau, không phải điều kiện của mốc đầu. Ở mốc đầu, FR-001 vẫn áp
dụng: khi không kết nối được daemon hoặc không đọc được token, giao diện vẫn mở, nêu lý do, cho thử lại và thoát, nhưng
chưa có danh sách kiểm tra từng bước. Danh sách task rỗng dẫn tới form tạo task.

## Clarifications

### Session 2026-11-01

- Q: TUI có thuộc v1 không? → A: Có; SPEC.md và docs/architecture.md được sửa cho nhất quán.
- Q: Bản nghiệm thu đầu gồm gì? → A: US1–US5, có thể triển khai phần chỉ đọc trước; US6 để mốc sau.
- Q: Chữ trên giao diện dùng tiếng gì? → A: Tiếng Anh, thống nhất với CLI; chưa thêm đa ngôn ngữ.
- Q: Mở `cusr` thì thấy project nào? → A: Toàn bộ project trong phạm vi token, không suy từ thư mục đang đứng; bộ lọc
  project luôn nhìn thấy (FR-008).
- Q: Dữ liệu cũ có được dùng để thao tác? → A: Không gửi được thao tác ghi mới khi dữ liệu đang bị đánh dấu cũ; giữ nội
  dung đang nhập, đọc lại trước khi cho gửi và không tự gửi. Đối chiếu request chưa rõ kết quả vẫn chạy (FR-044).
- Q: Log có tự chuyển sang bước mới? → A: Chỉ khi đang theo dõi trực tiếp, và mỗi bước có log riêng, mở đầu bằng dòng nêu
  bước và attempt; đang cuộn, tạm dừng hoặc đọc attempt cũ thì giữ vị trí và báo có hoạt động mới (FR-014).
- Q: Xác nhận có phải cho xem cả nội dung task? → A: Có; phải xem được đầy đủ nội dung của đúng revision, phần dài cuộn
  hoặc mở rộng. Không đọc được thì không cho xác nhận (FR-026).
- Q: Hết lượt tự kết nối lại thì làm gì? → A: Giữ phiên, màn hình mất kết nối và bản nháp, chờ người dùng chọn `Retry
  connection`; không tự bắt đầu vòng thử mới. Số lượt và backoff do plan chốt. Lỗi không tự hết thì dừng tự thử ngay
  (FR-009, FR-039, SC-003).
- Q: Chọn profile lúc nào? → A: Chỉ ở form tạo task, vì profile của task được chốt từ `task.profile` hoặc `cusr.yaml`,
  không theo đề xuất chạy. Sau đó profile chỉ hiển thị; chế độ và binding vẫn chọn được trong phạm vi hợp lệ của task
  (FR-024, FR-025).

### Session 2026-11-04

Dùng thử US1 và US2 cho thấy giao diện khó đọc: chữ trơn cùng một độ đậm, danh sách 18 bước phẳng, log là JSON
của harness. Các câu dưới chốt cách trình bày; không thêm trạng thái, thao tác hay quyền nào.

- Q: Một task trên Home chiếm mấy dòng? → A: Một dòng, theo cột: ký hiệu trạng thái, tiêu đề, project, tám chấm giai
  đoạn, hoạt động hiện tại kèm chế độ và PR, thời gian ở trạng thái. Trạng thái được nêu bằng ký hiệu riêng của nó
  (FR-035), tên trạng thái nằm ở dòng đếm phía trên và màn trợ giúp. Dòng cuối thân màn ghi đủ tên các giai đoạn của
  task đang chọn.
- Q: Tiến trình workflow hiện thế nào? → A: Gộp các bước của `software_dev` thành tám giai đoạn triage, prepare, code,
  gates, review, PR, CI, merge; bước sửa và chạy lại thuộc giai đoạn chúng sửa, giai đoạn chạy nhiều lần ghi `×n`.
  Giai đoạn chế độ bỏ qua ghi `skipped –`, không bao giờ mang dấu `✓` (FR-011). Workflow có bước lạ thì liệt kê từng
  bước như daemon trả.
- Q: Chi tiết task trình bày thế nào? → A: Từng mục có tiêu đề kẻ ngang và cột nhãn–giá trị; mục không có gì để nói
  thì bỏ. ID, version, revision và worktree dồn xuống mục `Reference`. Mã spec không xuất hiện trong chữ hiển thị.
- Q: Log đọc thế nào? → A: Như transcript của chính agent: `•` trước lời agent và lệnh gọi tool, `⎿` cho kết quả, `✻`
  cho ghi chú phiên. Markdown trong lời agent được vẽ (đậm, code, danh sách, bảng). Bản ghi chỉ để đếm hoặc vẽ lại
  (đếm token suy nghĩ, `ui_invalidate`, rate limit còn cho phép) không hiện; bản ghi lạ vẫn hiện dạng JSON gọn, và
  `cusr task logs` vẫn trả nguyên bản ghi (FR-014).
- Q: Log có xem theo bước không? → A: Từ 100 cột, màn Log chia hai cột: trái là các giai đoạn theo chiều dọc, việc
  đang làm, việc đang chờ người dùng và phần log đang xem; phải là log. Hẹp hơn thì các giai đoạn thành một dòng ngang
  ở đầu log. Vạch phân cách ghi tên bước bằng lời; `t` chọn xem riêng một bước.
- Q: Enter trên Home mở gì? → A: Mở task ở màn Log ở trên, vì câu hỏi hay gặp nhất là task tới đâu và agent đang làm
  gì. `d` mở Task detail đè lên màn Log (lý do chờ, việc cần làm, PR, giới hạn, lịch sử); `Esc` hoặc `l` từ đó quay
  lại đúng chỗ đang đọc ở màn Log. `Esc` ở màn Log về Home.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Nhìn một màn hình là hiểu hệ thống (Priority: P1)

Chủ dự án gõ `cusr` và thấy ngay các project, sức khỏe daemon và các task hiện tại, kèm từng task đang
làm gì. Việc cần chính họ xử lý nằm trên cùng. Màn hình tự cập nhật, không cần gõ lại lệnh.

**Why this priority**: Đây là trọng tâm của feature và là phần tự có giá trị ngay cả khi chưa thao tác
được gì: thay việc ghép nhiều lệnh đọc bằng một cái nhìn.

**Independent Test**: Với daemon thật và harness giả lập, tạo các task ở mọi trạng thái bằng CLI, mở
`cusr` trong terminal thật rồi đối chiếu màn hình với kết quả `task list`/`task explain`.

**Acceptance Scenarios**:

1. **Given** daemon khỏe và có task, **When** người dùng gõ `cusr` trong terminal, **Then** màn hình
   chính hiện project, sức khỏe daemon, slot thực thi, hàng đợi và danh sách task mà không cần tham số.
2. **Given** task đang code, gate, review, chờ CI, chờ người, chờ merge, cooldown và đã kết thúc,
   **When** xem danh sách, **Then** mỗi task nêu hoạt động hiện tại bằng lời dễ hiểu, không chỉ tên
   trạng thái thô như `WAITING`.
3. **Given** có câu hỏi, cấu hình chạy chưa xác nhận, escalation chờ duyệt hoặc PR chờ merge thủ công,
   **When** mở màn hình chính, **Then** các task đó nằm trong nhóm "cần bạn xử lý" ở trên cùng, kèm việc
   cần làm.
4. **Given** màn hình đang mở, **When** một task đổi trạng thái do daemon, **Then** màn hình cập nhật
   mà người dùng không phải bấm gì.
5. **Given** daemon báo không khỏe, **When** xem màn hình chính, **Then** thấy rõ lý do và việc mới có
   bị chặn hay không; không có chỉ báo nào gợi ý hệ thống đang ổn.
6. **Given** đang xem thì mất kết nối daemon, **When** dữ liệu không còn cập nhật được, **Then** giao
   diện đánh dấu dữ liệu đã cũ kèm thời điểm cập nhật cuối, tự thử kết nối lại trong giới hạn, và không
   trình bày dữ liệu cũ như hiện tại. Hết lượt thì giao diện giữ phiên và bản nháp, chờ người dùng chọn `Retry
   connection`.
7. **Given** đang trong giao diện, **When** người dùng thoát, **Then** terminal trở lại như trước khi
   mở; task và daemon tiếp tục chạy, không bị ảnh hưởng.
8. **Given** `cusr` chạy không có terminal tương tác hoặc kèm `--json`, **When** lệnh được gọi, **Then**
   kết quả giữ đúng hợp đồng CLI hiện có; giao diện không mở và không có ANSI hay prompt.
9. **Given** có task ở nhiều project trong phạm vi token, **When** gõ `cusr` từ bất kỳ thư mục nào, **Then** thấy task
   của mọi project đó, và bộ lọc project đang áp dụng luôn hiện trên màn hình.
10. **Given** token bị thu hồi, không đọc được hoặc schema của daemon không tương thích, **When** giao diện cập nhật,
    **Then** nó dừng tự thử, nêu lý do và chỉ thử lại khi người dùng yêu cầu.

---

### User Story 2 - Xem vì sao task ở trạng thái đó (Priority: P1)

Từ danh sách, người dùng chọn một task và thấy tiến trình workflow, agent/model đã dùng, log trực tiếp,
PR liên quan; nếu lỗi hoặc đang chờ thì biết vì sao và lối ra là gì.

**Why this priority**: Biết "có gì đó sai" mà không biết vì sao thì vẫn phải quay lại CLI. Cùng US1, đây
là bản theo dõi chỉ đọc đầy đủ, nên làm trước các thao tác nhưng chưa đủ để đạt mốc nghiệm thu đầu.

**Independent Test**: Duyệt qua bộ task mẫu phủ mọi reason/detail của [FR-029 feature
002](../002-task-to-green-pr/spec.md), đối chiếu màn hình chi tiết với `task explain`, `task show`,
`task history` và `task logs`.

**Acceptance Scenarios**:

1. **Given** một task đang chạy, **When** mở chi tiết, **Then** thấy các bước của workflow với bước đã
   qua, đang chạy và còn lại. Bước không chạy theo chế độ đã xác nhận được ghi "không yêu cầu"; ví dụ
   review của `direct-pr` không bao giờ hiện như đã đạt.
2. **Given** task đang chờ hoặc thất bại, **When** mở chi tiết, **Then** thấy bước liên quan, lý do, điều
   kiện tiếp tục và các lối ra, khớp với `task explain` của chính task đó.
3. **Given** task đã có attempt, **When** xem chi tiết, **Then** thấy harness/model/effort từng bước, số
   lượt đã dùng và còn lại, thời hạn còn lại, thời gian chờ slot. Usage không có được ghi là "không có
   dữ liệu", không ghi 0.
4. **Given** agent đang chạy, **When** mở log, **Then** log chạy trực tiếp; người dùng cuộn và tạm dừng
   được mà không mất vị trí. Đoạn log bị mất hiện thành khoảng trống rõ ràng, và phiên theo dõi hết hạn
   thì tự nối lại đúng vị trí.
5. **Given** task có PR, **When** xem chi tiết, **Then** thấy liên kết PR, head đã kiểm, kết quả gate, CI,
   review theo chế độ và tình trạng "PR xanh" gắn với head đó.
6. **Given** PR xanh đang chờ merge, **When** xem chi tiết, **Then** giao diện nói rõ người dùng cần tự
   merge trên GitHub, kèm method và nội dung đề xuất nếu có; không hứa Cuesura sẽ tự merge và không hiện
   task là xong.
7. **Given** task DONE có `merged_head_unverified` hoặc yêu cầu hủy đến quá muộn, **When** xem chi tiết,
   **Then** thấy đúng ý nghĩa đó và hai head liên quan; giao diện không trình bày như merge đã được chứng
   nhận hay như task đã hủy.
8. **Given** task đã kết thúc, **When** xem chi tiết, **Then** vẫn đọc được lịch sử, log, bằng chứng và
   không có thao tác nào làm mở lại task.
9. **Given** đang theo dõi log trực tiếp, **When** workflow chuyển sang bước mới, **Then** log chạy tiếp sang bước đó,
   có dòng phân cách nêu bước và attempt.
10. **Given** đang cuộn, tạm dừng hoặc đọc attempt cũ, **When** workflow chuyển sang bước mới, **Then** vị trí đang đọc
    giữ nguyên và giao diện báo có hoạt động mới.

---

### User Story 3 - Không phải nhớ phím hay cú pháp (Priority: P2)

Mỗi màn hình cho biết những phím dùng được ngay lúc đó và menu thao tác của mục đang chọn. Người dùng
không cần biết ID, version, request ID hay digest.

**Why this priority**: Đây là điều làm giao diện đáng dùng hơn CLI, nhưng chỉ có ý nghĩa khi đã có nội
dung để điều hướng từ US1 và US2.

**Independent Test**: Người chưa đọc tài liệu di chuyển giữa màn hình chính, chi tiết, log, trợ giúp và
thoát ra, chỉ dựa vào gợi ý trên màn hình.

**Acceptance Scenarios**:

1. **Given** đang ở bất kỳ màn hình nào, **When** nhìn vào giao diện, **Then** luôn thấy các phím chính
   đang có hiệu lực, gồm cách quay lại và cách thoát.
2. **Given** đang chọn một task, **When** mở menu thao tác, **Then** thấy đúng các thao tác của task đó ở
   trạng thái hiện tại, mỗi mục có một câu về tác dụng.
3. **Given** đang gõ vào ô nhập liệu, **When** bấm các phím vốn là phím tắt, **Then** chúng được nhập như
   văn bản, không kích hoạt thao tác.
4. **Given** cần xem đầy đủ phím, **When** mở trợ giúp, **Then** thấy toàn bộ phím theo ngữ cảnh và đóng
   lại vẫn đúng vị trí cũ.

---

### User Story 4 - Xử lý việc đang chờ mình (Priority: P2)

Người dùng trả lời câu hỏi của agent, duyệt escalation, yêu cầu kiểm tra lại hoặc hủy task ngay trong
giao diện. Thao tác có hậu quả luôn cho xem trước phạm vi và cần xác nhận rõ ràng.

**Why this priority**: Khép vòng "thấy việc cần làm rồi làm luôn", nhưng cần US1–US3 và phải giữ nguyên
các bảo đảm về quyền và chống lặp nên đứng sau phần chỉ đọc.

**Independent Test**: Với cả ba loại quyền, thực hiện từng thao tác trên task mẫu, đối chiếu lịch sử
event và số attempt/effect với cùng thao tác làm qua CLI.

**Acceptance Scenarios**:

1. **Given** task có câu hỏi, **When** người dùng nhập câu trả lời và gửi, **Then** câu trả lời được ghi
   một lần và task tiếp tục theo trạng thái daemon trả về.
2. **Given** câu hỏi vừa được trả lời từ nơi khác, **When** người dùng gửi, **Then** thấy câu hỏi đã có
   câu trả lời và nội dung của nó; câu trả lời của người dùng không bị coi là đã áp dụng và không mất đi
   trước khi họ đọc được thông báo.
3. **Given** chọn hủy task, **When** tiếp tục, **Then** giao diện yêu cầu lý do và xác nhận rõ ràng; sau
   đó hiện đúng tiến trình dừng/đối chiếu, không báo CANCELLED trước khi daemon xác định. Nếu merge đã
   xảy ra thì hiện DONE kèm "yêu cầu hủy đến quá muộn".
4. **Given** task ở `worktree_changed`, **When** chọn kiểm tra lại, **Then** giao diện cảnh báo thao tác
   này nhận cây thư mục đã quan sát làm mốc của task rồi chạy lại bước, cho xem thay đổi đó (hoặc nói rõ
   không xem được và chỉ vị trí worktree), và chỉ tiếp tục sau xác nhận riêng.
5. **Given** escalation chờ duyệt, **When** người có quyền operate mở thao tác duyệt, **Then** thấy bước,
   nấc, lý do và giới hạn còn lại; duyệt không mở thêm lượt đã hết.
6. **Given** token không đủ quyền cho một thao tác, **When** xem menu, **Then** thao tác hiện là không khả
   dụng kèm lý do; giao diện không dò tìm token khác để vượt qua.
7. **Given** task đã đổi version trong lúc hộp thoại đang mở, **When** gửi, **Then** thao tác bị từ chối
   vì xung đột, giao diện hiện trạng thái mới và không tự gửi lại.
8. **Given** gửi thao tác mà không nhận được kết quả, **When** kết nối hồi phục, **Then** giao diện báo
   "chưa rõ kết quả", đối chiếu lại bằng đúng request đó và không tạo tác dụng thứ hai.
9. **Given** task đang chờ merge hoặc đã kết thúc, **When** mở menu, **Then** không có thao tác merge hay
   retry; nếu người dùng muốn làm lại, gợi ý tạo một task mới độc lập.
10. **Given** dữ liệu đang bị đánh dấu cũ và người dùng đang soạn câu trả lời, **When** gửi, **Then** thao tác bị khóa
    kèm lý do và nội dung vẫn còn. Khi cập nhật lại được, giao diện đọc lại task, hiện thay đổi nếu có và chờ người
    dùng gửi lại.

---

### User Story 5 - Tạo task và chọn cấu hình chạy (Priority: P2)

Người dùng tạo task bằng form, có thể chọn profile ngay lúc đó, rồi chọn chế độ, worker và reviewer từ các lựa
chọn hợp lệ cho task, xem lại toàn bộ và xác nhận. Task do assistant tạo sẵn cũng được xem và xác nhận theo cách đó.

**Why this priority**: Hoàn tất hành trình không cần nhớ cú pháp. Đặt sau US4 vì CLI và assistant vẫn tạo
được task, còn việc xử lý chờ thì xảy ra hằng ngày; đây lại là điểm nhạy cảm nhất về xác nhận.

**Independent Test**: Tạo task chỉ bằng giao diện với cả hai chế độ, chạy tới PR xanh bằng harness giả
lập, rồi kiểm tra bằng chứng xác nhận gắn đúng task, revision và digest của bộ lựa chọn đã hiển thị.

**Acceptance Scenarios**:

1. **Given** mở form tạo task, **When** nhập project, tiêu đề, base branch, mô tả và tiêu chí nghiệm thu,
   **Then** lỗi được báo ngay tại trường tương ứng; nội dung đã nhập không mất khi có lỗi hoặc khi daemon
   từ chối.
2. **Given** task đã tạo, **When** chọn cấu hình chạy, **Then** thấy profile đã xác định của task (không đổi được) và
   chỉ thấy chế độ, binding hợp lệ cho task, kèm chỉ dẫn `when_to_use` nếu có khai báo; không có lựa chọn tự do.
3. **Given** đã chọn đủ, **When** tới màn xem lại, **Then** thấy đầy đủ nội dung task theo FR-026, profile, chế độ, lý
   do, worker, reviewer nếu `full-review`, các lựa chọn dự phòng và nói rõ `direct-pr` không có reviewer.
4. **Given** đang ở màn xem lại, **When** người dùng chưa thực hiện bước xác nhận riêng, **Then** task
   không chuyển sang chạy, kể cả khi đã hết thời gian chờ, lựa chọn đang được đánh dấu sẵn hoặc người dùng
   bấm Enter theo thói quen.
5. **Given** bộ lựa chọn trên daemon đã đổi sau khi hiển thị, **When** xác nhận, **Then** xác nhận bị từ
   chối; giao diện hiện khác biệt và xin xác nhận lại.
6. **Given** task do assistant tạo có sẵn đề xuất, **When** mở task, **Then** thấy rõ đề xuất đến từ đâu,
   lý do và phạm vi đang xác nhận (intake, cấu hình chạy hoặc cả hai); có thể đổi lựa chọn trước khi xác
   nhận.
7. **Given** kết nối bằng token không được phép xác nhận cấu hình chạy, **When** tới bước xác nhận,
   **Then** vẫn đề xuất được, nhưng giao diện nói rõ cần người dùng xác nhận qua kết nối tin cậy và không
   báo task đã được xác nhận.
8. **Given** sau xác nhận cấu hình hoặc năng lực không hợp lệ, **When** task về PENDING, **Then** thấy
   chẩn đoán và việc cần sửa; sau khi sửa có thể chọn kiểm tra lại ngay từ giao diện.
9. **Given** gửi tạo task mà không rõ kết quả, **When** thử lại, **Then** chỉ có một task được tạo.
10. **Given** daemon đã tạo task nhưng phản hồi bị mất và người dùng thoát giao diện, **When** chạy đúng lệnh tra cứu
    đã in khi thoát, **Then** thấy task ID và kết quả ban đầu mà không cần payload cũ; số task không tăng.
11. **Given** không đọc được nội dung task của đúng revision đang xác nhận, **When** tới màn xem lại, **Then** giao diện
    nêu lý do và không cho xác nhận, kể cả khi đã có cấu hình chạy.

---

### User Story 6 - Được dẫn dắt khi mới dùng (Priority: P3)

Người mới gõ `cusr` khi chưa có cấu hình hoặc daemon chưa chạy vẫn vào được giao diện và thấy một danh
sách việc cần làm theo thứ tự, biết bước nào đã đạt và bước tiếp theo là gì.

**Why this priority**: Giá trị cao với lần đầu nhưng ít lặp lại với một người dùng đã cài đặt xong, và
các tình huống lỗi kết nối đã được US1 che phần tối thiểu.

**Independent Test**: Trên máy sạch, lần lượt tạo từng điều kiện thiếu, xác nhận giao diện chỉ đúng bước
tiếp theo; làm theo duy nhất các chỉ dẫn đó cho tới khi tạo được task đầu tiên.

**Acceptance Scenarios**:

1. **Given** chưa có cấu hình, daemon không chạy hoặc token không đọc được, **When** gõ `cusr`, **Then**
   giao diện vẫn mở, nói rõ thiếu gì và bước tiếp theo, không chỉ báo lỗi kết nối rồi thoát.
2. **Given** đã có project, **When** xem bước kiểm tra, **Then** thấy kết quả `doctor` theo từng mục; mục
   lỗi kèm lệnh sửa để người dùng tự chạy, giao diện không tự chạy lệnh đó.
3. **Given** người dùng vừa sửa xong, **When** yêu cầu kiểm tra lại, **Then** danh sách cập nhật ngay
   trong giao diện, không cần thoát ra.
4. **Given** một điều kiện chưa kiểm tra được, **When** hiển thị, **Then** ghi "chưa rõ" kèm lý do, không
   coi là đạt.
5. **Given** mọi điều kiện đã đạt nhưng chưa có task, **When** vào màn hình chính, **Then** trạng thái
   rỗng dẫn thẳng tới việc tạo task đầu tiên.
6. **Given** đã qua lần đầu, **When** cần kiểm tra lại môi trường, **Then** mở lại được danh sách này từ
   màn hình chính.

### Edge Cases

- **EC-001 Nội dung không tin cậy**: Tiêu đề task, câu hỏi, log và nội dung PR có thể chứa ký tự điều
  khiển terminal do agent hoặc repo sinh ra. Các ký tự này MUST bị vô hiệu hóa, không thể giả màn hình xác
  nhận, đổi nội dung đã hiển thị hoặc gửi lệnh tới terminal.
- **EC-002 Terminal nhỏ hoặc đổi kích thước**: Dưới kích thước tối thiểu 80×24 giao diện báo cần mở rộng
  và vẫn cho thoát; đổi kích thước thì dàn lại, không mất vị trí hay nội dung đang nhập.
- **EC-003 Không có màu**: Với `NO_COLOR` hoặc terminal ít màu, mọi trạng thái vẫn phân biệt được bằng chữ
  hoặc ký hiệu.
- **EC-004 Chữ nhiều byte**: Tiếng Việt, CJK và emoji không làm vỡ cột; cắt ngắn đúng theo độ rộng hiển
  thị, luôn xem được nội dung đầy đủ ở màn chi tiết.
- **EC-005 Nhiều task**: Hơn một trang (100) task vẫn duyệt được; số đếm không được suy từ riêng trang đầu.
  Task đã kết thúc mặc định được thu gọn và mở ra được.
- **EC-006 Nhiều người gọi cùng lúc**: Hai phiên giao diện, CLI hoặc assistant thao tác trên cùng task thì
  kết quả theo daemon; bên đến sau thấy xung đột và trạng thái mới.
- **EC-007 Daemon khởi động lại**: Phiên đang mở tự nối lại trong giới hạn của FR-009 và đọc lại trạng thái; log tiếp
  tục từ vị trí đã đọc. Task đang chạy không bị báo mất chỉ vì daemon vừa restart.
- **EC-008 Quyền đổi giữa phiên**: Token bị thu hồi thì các yêu cầu mới báo thiếu quyền; giao diện không
  giữ thao tác đó như còn dùng được và không thử nguồn token khác.
- **EC-009 Token giới hạn project**: Chỉ hiện project và task token được đọc, kèm ghi chú rằng đây là phạm
  vi của token, không phải toàn bộ hệ thống.
- **EC-010 Lệch phiên bản**: Daemon trả dữ liệu thuộc schema không hỗ trợ thì giao diện báo không tương
  thích; không đoán nghĩa rồi hiển thị.
- **EC-011 Log quá nhiều**: Log dồn dập không làm treo phím hoặc tăng bộ nhớ vô hạn; phần cũ rời bộ đệm vẫn
  đọc lại được theo vị trí.
- **EC-012 Thoát đột ngột**: Ctrl-C, SIGTERM, SIGHUP hoặc lỗi nội bộ đều trả terminal về trạng thái ban đầu. Ctrl-C
  không hủy task. Nếu còn thao tác chưa rõ kết quả, kể cả khi thoát thường, giao diện in ra stderr request ID và đúng
  lệnh tra cứu của FR-041 cho từng thao tác, sau khi đã trả terminal để dòng này không mất cùng màn hình toàn phần, và
  kết thúc với exit 3. Khi không còn terminal để in (đứt SSH) hoặc process bị giết, người dùng đối chiếu bằng danh sách
  task và lịch sử task; giao diện không ghi payload ra file để bù (FR-038).
- **EC-013 Task đổi trạng thái khi đang xem**: Mục đang chọn được giữ theo task, không theo vị trí dòng, nên
  việc sắp xếp lại không làm thao tác rơi nhầm task khác. Menu đã mở mà không còn hợp lệ thì được làm mới.
- **EC-014 Worker trong sandbox**: Worker không có token và không thấy data dir nên chỉ gặp lỗi kết nối như
  mọi client khác; giao diện không mở đường đi mới cho worker.
- **EC-015 Chờ `doctor`**: Kiểm tra môi trường chạy lâu không chặn điều hướng hay thoát, có giới hạn thời
  gian và báo rõ khi hết hạn.

## Requirements *(mandatory)*

### Functional Requirements

**Khởi động và tương thích**

- **FR-001**: `cusr` không kèm lệnh con hay tùy chọn, khi đầu vào và đầu ra đều là terminal tương tác, MUST
  mở giao diện tương tác, kể cả khi daemon chưa chạy hoặc chưa có cấu hình. `TERM=dumb` hoặc không đặt `TERM` không được
  coi là terminal tương tác.
- **FR-002**: Mọi cách gọi khác MUST giữ nguyên hợp đồng CLI: lệnh con, `--help`, `--version`, `--json`, đầu vào hoặc
  đầu ra không phải terminal (pipe, script, assistant, `TERM=dumb`). Output, exit code và việc không có ANSI hay prompt
  không đổi; `cusr` không tham số ngoài terminal vẫn trả lỗi như hiện tại.
- **FR-003**: Giao diện MUST xác định kết nối đúng như lệnh con (data dir, file token, biến môi trường).
  Việc có terminal MUST NOT được dùng làm bằng chứng quyền. Nội dung token MUST NOT hiển thị.
- **FR-004**: Thoát giao diện theo mọi đường MUST trả terminal về trạng thái ban đầu và không ảnh hưởng
  task, daemon hay runner.

**Màn hình chính và theo dõi trực tiếp**

- **FR-005**: Màn hình chính MUST hiện các project trong phạm vi token, sức khỏe daemon, slot thực thi, hàng
  đợi và danh sách task.
- **FR-006**: Mỗi task MUST hiện tiêu đề, project, trạng thái, hoạt động hiện tại bằng lời dễ hiểu, thời gian
  ở trạng thái đó, chế độ thực thi nếu đã có và PR nếu đã có.
- **FR-007**: Task cần người dùng xử lý MUST được nhóm riêng ở trên cùng, nêu việc cần làm và số lượng. Task
  chỉ nằm trong nhóm này khi việc tiếp tục phụ thuộc người dùng theo `task explain`. Task đang chờ CI, cooldown
  hoặc slot trong giới hạn MUST NOT nằm trong nhóm chỉ vì người dùng có thể hủy nó. Trong mỗi nhóm, task mới tạo
  nhất MUST nằm trên cùng.
- **FR-008**: Khi mở, giao diện MUST hiện toàn bộ project trong phạm vi token; thư mục đang đứng MUST NOT thu hẹp phạm
  vi này. Người dùng MUST lọc được theo project và trạng thái, và duyệt được toàn bộ task qua phân trang. Bộ lọc project
  đang áp dụng MUST luôn nhìn thấy.
- **FR-009**: Giao diện MUST tự cập nhật theo chu kỳ có giới hạn và hiện thời điểm cập nhật cuối. Khi không cập nhật
  được, dữ liệu MUST được đánh dấu là cũ, và giao diện tự kết nối lại với backoff có trần và số lượt có giới hạn. Hết
  lượt, giao diện MUST giữ phiên, màn hình mất kết nối và nội dung đang nhập, MUST NOT tự bắt đầu vòng thử mới, và chờ
  người dùng chọn `Retry connection`; mỗi lần chọn bắt đầu một vòng thử mới với cùng giới hạn. Lỗi không tự hết (token
  bị thu hồi hoặc không đọc được, schema không tương thích) MUST dừng tự thử ngay, nêu lý do và chỉ thử lại khi người
  dùng yêu cầu.
- **FR-010**: Daemon không khỏe MUST được hiện cùng lý do lấy từ health, kể cả việc mới bị giữ hoặc claim chưa
  rõ; giao diện MUST NOT tự suy ra trạng thái khỏe khác với daemon.

**Chi tiết task**

- **FR-011**: Chi tiết task MUST hiện tiến trình workflow từ dữ liệu đã ghi, theo chế độ đã xác nhận; bước
  không yêu cầu MUST khác biệt với bước đã đạt.
- **FR-012**: Lý do chờ, điều kiện tiếp tục, lối ra, lý do thất bại, blocker và giới hạn còn lại MUST khớp với
  `task explain`. Giao diện MUST NOT có logic riêng suy ra trạng thái hoặc lối ra.
- **FR-013**: Chi tiết MUST hiện harness/model/effort theo bước, lượt yêu cầu và lượt đã gọi, escalation và
  usage. Usage MUST phân biệt `reported`, `estimated`, `unavailable`.
- **FR-014**: Log MUST xem được trực tiếp và theo vị trí, cuộn và tạm dừng được, đọc được theo attempt đã qua, tự nối
  lại phiên theo dõi và hiện khoảng trống dữ liệu; theo dõi log MUST NOT chiếm slot. Khi theo dõi trực tiếp, log MUST
  chuyển sang log riêng của bước mới, mở đầu bằng dòng nêu bước và attempt; bước trước xem lại bằng `←`. Khi đang cuộn, tạm dừng hoặc đọc attempt cũ, vị trí
  MUST giữ nguyên và giao diện báo có hoạt động mới; phần log mới MUST được đọc lại theo cursor, không dồn vào bộ đệm
  ngoài trần của FR-039.
- **FR-015**: Chi tiết MUST hiện lịch sử event theo thứ tự đã commit và bằng chứng PR: liên kết, head, base,
  kết quả gate, CI, review theo chế độ, hiệu lực xanh, method và nội dung merge đề xuất, merge commit và đánh
  dấu merge chưa chứng nhận.
- **FR-015.01**: Chi tiết MUST hiện task yêu cầu gì, đọc từ `task content`: mô tả, requirements và acceptance; ở
  chế độ thông tin kỹ thuật thêm constraints, out_of_scope và base branch. Mô tả dài MAY được cắt ở chế độ thường nếu
  ghi rõ còn bao nhiêu dòng và cách xem đủ. Nội dung đọc lại khi `revision` đổi; đọc lỗi MUST hiện ngay tại phần đó
  và MUST NOT khóa thao tác ghi, vì nội dung này chỉ để xem.

**Thao tác**

- **FR-016**: Thao tác hiện ra MUST dựa trên các thao tác daemon cho phép với task ở trạng thái hiện tại, kèm
  tác dụng. Thao tác không đủ quyền MUST hiện là không khả dụng kèm lý do.
- **FR-017**: Giao diện MUST hỗ trợ: tạo task, đề xuất cấu hình chạy, xác nhận intake, xác nhận cấu hình chạy,
  trả lời câu hỏi, duyệt escalation, kiểm tra lại và hủy, trong phạm vi quyền của token.
- **FR-018**: Mọi thao tác ghi MUST đi qua cùng dịch vụ và cùng kiểm tra quyền, version, chống lặp như CLI;
  người dùng MUST NOT phải nhập ID, version, request ID hay digest.
- **FR-019**: Mỗi thao tác logic MUST giữ một request ID cho các lần gửi lại. Không nhận được kết quả MUST được báo
  "chưa rõ kết quả" và đối chiếu lại; MUST NOT tạo request mới khiến tác dụng có thể lặp. Việc tự đối chiếu và gửi lại
  MUST có trần; hết trần thì dừng, giữ thao tác ở trạng thái chưa rõ và chờ người dùng yêu cầu kiểm tra lại. Thoát khi
  chưa đối chiếu xong thì theo EC-012.
- **FR-020**: Giao diện MUST phân biệt "đã được chấp nhận" với "đã hoàn tất", và luôn hiện trạng thái thật do
  daemon trả về sau thao tác.
- **FR-021**: Việc mở màn hình, làm mới và điều hướng MUST NOT tạo mutation; riêng kiểm tra lại MUST chỉ chạy
  khi người dùng yêu cầu.
- **FR-022**: Hủy task và kiểm tra lại ở `worktree_changed` MUST cần xem trước hậu quả và xác nhận riêng, không
  thực hiện bằng một phím đơn. Hủy MUST ghi lý do.
- **FR-023**: Giao diện MUST NOT có thao tác merge, duyệt merge, yolo, retry hay amend-policy. Khi các việc đó
  liên quan, giao diện MUST chỉ lối ra thực tế: merge thủ công trên GitHub rồi quan sát hoặc kiểm tra lại, hoặc
  tạo task mới độc lập.

**Tạo task và cấu hình chạy**

- **FR-024**: Form tạo task MUST có project, tiêu đề, base branch, mô tả, tiêu chí nghiệm thu; tùy chọn có dependency
  (chọn từ danh sách task, không nhập ID), priority và profile. Lỗi MUST báo theo trường và nội dung đã nhập MUST được
  giữ lại khi bị từ chối. Rời form còn nội dung MUST hỏi lại.
- **FR-025**: Người dùng MUST xem được profile đã xác định của task (chỉ hiển thị) cùng các chế độ và binding hợp lệ cho
  task đó, kèm chỉ dẫn `when_to_use` đã khai báo. Khi không đọc được danh sách, giao diện MUST báo rõ và MUST NOT đoán
  lựa chọn.
- **FR-026**: Trước khi xác nhận intake hoặc cấu hình chạy, màn xem lại MUST hiện đủ nội dung của đúng revision đang
  xác nhận: project, base branch, tiêu đề, mô tả, requirements, acceptance, constraints, out_of_scope; cùng profile, chế
  độ, lý do, worker, reviewer nếu có và lựa chọn dự phòng; và nêu rõ phạm vi đang xác nhận (intake, cấu hình chạy hoặc
  cả hai). Phần dài MUST cuộn hoặc mở rộng được; tóm tắt hoặc cắt ngắn MUST NOT thay thế nội dung đầy đủ. Danh sách rỗng
  MUST ghi là không có, khác với chưa đọc được. Không đọc được nội dung của đúng revision thì MUST NOT cho xác nhận.
- **FR-027**: Xác nhận cấu hình chạy MUST là một hành động riêng, chủ động của người dùng trên màn xem lại, gắn
  với digest của đúng bộ lựa chọn đã hiển thị. MUST NOT xác nhận do hết thời gian, do giá trị đánh dấu sẵn hoặc
  do một phím Enter đang có focus mặc định.
- **FR-028**: Bộ lựa chọn đổi sau khi hiển thị MUST làm xác nhận cũ mất hiệu lực; giao diện MUST hiện khác biệt
  và xin xác nhận mới. Token không được phép xác nhận MUST nhận thông báo rõ ràng, không có đường vòng.

**Hướng dẫn khi mới dùng**

- **FR-029**: Giao diện MUST có danh sách kiểm tra theo thứ tự cho các điều kiện để dùng được: cấu hình, daemon,
  token, project, môi trường theo `doctor`, task đầu tiên; mỗi mục có trạng thái đạt, lỗi hoặc chưa rõ, và nêu
  một bước tiếp theo.
- **FR-030**: Hướng dẫn MUST chỉ đọc, không tự ghi cấu hình, cài đặt hay khởi động gì. Lệnh được gợi ý MUST là
  lệnh có thật trong bản đang chạy hoặc tài liệu vận hành có thật; MUST NOT giới thiệu lệnh chưa có.
- **FR-031**: Danh sách MUST tự xuất hiện khi điều kiện cơ bản chưa đạt, kiểm tra lại được mà không cần thoát và
  mở lại được từ màn hình chính.

**Điều hướng và hiển thị**

- **FR-032**: Mọi chức năng MUST dùng được hoàn toàn bằng bàn phím; chuột không bắt buộc.
- **FR-033**: Mỗi màn hình MUST luôn hiện gợi ý phím đang có hiệu lực, có menu thao tác cho mục đang chọn và màn
  trợ giúp theo ngữ cảnh. Phím quay lại, thoát và trợ giúp MUST nhất quán giữa các màn hình.
- **FR-034**: Khi đang nhập văn bản, phím thường MUST đi vào ô nhập; hộp thoại MUST có cách rời mà không gửi.
- **FR-035**: Trạng thái MUST không chỉ dựa vào màu; giao diện MUST tôn trọng `NO_COLOR`, thích ứng khi đổi kích
  thước, hỗ trợ tối thiểu 80×24 và đo độ rộng đúng với chữ nhiều byte.

**An toàn và giới hạn**

- **FR-036**: Giao diện MUST lấy và ghi dữ liệu nghiệp vụ chỉ qua daemon: không mở kho trạng thái, không gọi LLM,
  GitHub hay harness. Mọi nội dung hiển thị MUST dựng bằng code từ dữ liệu đã ghi. Riêng hướng dẫn khi daemon chưa
  chạy được đọc các file cục bộ cần thiết để chẩn đoán, không đọc nội dung secret ngoài việc kiểm tra file token.
- **FR-037**: Nội dung từ agent, repo hoặc nguồn ngoài MUST được vô hiệu hóa ký tự điều khiển trước khi hiển thị
  (EC-001).
- **FR-038**: Giao diện MUST NOT làm lộ secret: chỉ hiển thị dữ liệu daemon đã che và không tự ghi nội dung nghiệp
  vụ ra file hay log riêng.
- **FR-039**: Tần suất làm mới, số lượt tự kết nối lại, thời gian chờ mỗi yêu cầu và bộ đệm log MUST có trần. Số lượt
  và backoff cụ thể do plan chốt, đủ để đạt SC-003 trong cửa sổ tự thử. Phiên mở lâu MUST NOT làm tăng tải daemon hoặc
  bộ nhớ không giới hạn.
- **FR-040**: Mọi đường đọc mới cần cho feature này (mục Phụ thuộc) MUST chỉ đọc, kiểm quyền và phạm vi project ở
  dịch vụ, và có hợp đồng máy đọc như CLI, để giao diện không có năng lực mà CLI và assistant không kiểm chứng được.

**Tra cứu thao tác sau khi thoát**

- **FR-041**: `cusr request show REQUEST_ID` MUST trả kết quả của một mutation chỉ từ request ID, kể cả khi phiên gửi
  đã thoát và payload không còn. Lệnh MUST chỉ đọc: không nhận payload, không chạy hay tiếp tục thao tác, không tạo
  event. Lệnh có `--json` và theo [hợp đồng CLI](../002-task-to-green-pr/contracts/cli-daemon.md): tìm thấy thì exit 0
  kể cả khi thao tác đã bị từ chối; không tìm thấy thì exit 4.
- **FR-042**: Kết quả MUST nêu loại thao tác và một trong các trạng thái:
  - `completed`: kèm kết quả đầu tiên đã lưu, thành công hoặc bị từ chối.
  - `in_progress`: daemon đang xử lý request này.
  - `interrupted`: daemon đã nhận nhưng không còn xử lý (ví dụ restart giữa chừng) và chưa có kết quả; tác dụng có thể
    đã xảy ra một phần. Lệnh MUST yêu cầu đọc lại task trước khi gửi request mới.
  - Không tìm thấy: daemon không có bản ghi mà token được đọc, tại lúc tra. MUST NOT trình bày là thao tác chắc chắn
    không xảy ra.

  Task ID MUST chỉ xuất hiện khi task đó có thật: ID cấp sẵn lúc nhận `task_add` MUST NOT được trình bày như task đã
  tạo.
- **FR-043**: Tra cứu MUST yêu cầu quyền read và chỉ trả request của đúng actor trong token, với project thuộc phạm vi
  token đang hiệu lực. Actor khác, project ngoài phạm vi hoặc không xác định được project với token giới hạn project
  MUST nhận đúng phản hồi của "không tìm thấy", không lộ request có tồn tại.

**Thao tác khi dữ liệu cũ**

- **FR-044**: Khi dữ liệu đang bị đánh dấu cũ (FR-009), giao diện MUST khóa việc gửi thao tác ghi mới và nêu lý do; nếu
  chỉ dữ liệu của một task bị cũ thì khóa thao tác ghi trên task đó. Điều hướng, đọc dữ liệu đã có, soạn nội dung và
  thoát vẫn dùng được. Đối chiếu request chưa rõ kết quả theo FR-019 MUST NOT bị khóa. Nội dung đang nhập MUST được giữ
  trong phiên, chỉ trong bộ nhớ (FR-038). Khi cập nhật lại được, giao diện MUST đọc lại task trước khi cho gửi; task
  hoặc bộ lựa chọn đã đổi thì MUST hiện thay đổi và yêu cầu xác nhận lại. Giao diện MUST NOT tự gửi phần đang soạn. Khóa
  này không thay kiểm tra version và digest ở daemon.

### Key Entities *(include if feature involves data)*

- **Phiên giao diện**: trạng thái tạm trong một lần mở: kết nối, màn hình, mục đang chọn, bộ lọc, thời điểm cập
  nhật cuối. Không bền, không phải nguồn sự thật.
- **Hoạt động hiện tại của task**: mô tả dễ hiểu dựng từ status, wait, bước và attempt đã ghi; là cách trình bày,
  không phải trạng thái mới.
- **Mục cần xử lý**: task có lối ra cần người dùng (câu hỏi, xác nhận, duyệt, merge thủ công, sửa cấu hình), dẫn
  xuất từ dữ liệu của daemon.
- **Lựa chọn cấu hình chạy**: profile đã xác định của task, chế độ và binding hợp lệ, chỉ dẫn `when_to_use`, digest của
  bộ đã chọn.
- **Thao tác đang gửi**: request ID, payload, version dự kiến và trạng thái (đang gửi, đã chấp nhận, bị từ chối gồm cả
  xung đột, chưa rõ kết quả) trong phiên.
- **Kết quả tra cứu request**: trạng thái theo FR-042, dẫn xuất từ bản ghi chống lặp và việc daemon đang xử lý; không
  phải trạng thái task.
- **Mục kiểm tra khởi đầu**: một điều kiện để dùng được, kết quả đạt/lỗi/chưa rõ, nguồn bằng chứng, bước tiếp theo.

## Success Criteria *(mandatory)*

Mọi tiêu chí MUST được kiểm trong terminal thật hoặc pseudo-terminal với daemon thật; harness có thể giả lập trừ
khi ghi khác. Không dùng kiểm thử dựng màn hình tách rời để tuyên bố đạt.

### Measurable Outcomes

- **SC-001**: Với 100% reason/detail của FR-029 feature 002, từ lúc mở giao diện người dùng thấy task ở đâu, vì sao
  và lối ra là gì mà không chạy lệnh nào khác; nội dung khớp `task explain` ở 100% mẫu.
- **SC-002**: Với hệ thống có 100 task, màn hình chính có dữ liệu trong 2 giây sau khi gõ `cusr`.
- **SC-003**: 95% thay đổi trạng thái task xuất hiện trên màn hình trong 3 giây, không cần bấm phím. Nếu daemon sẵn
  sàng lại khi còn trong cửa sổ tự thử, giao diện có dữ liệu mới trong 10 giây kể từ lúc đó, không cần bấm phím. Nếu đã
  hết lượt, giao diện không tự kết nối lại và có dữ liệu mới trong 10 giây kể từ khi người dùng chọn `Retry connection`
  với daemon đã sẵn sàng. Không lúc nào dữ liệu cũ được hiển thị như hiện tại.
- **SC-004**: Một người đã biết Cuesura đi hết hành trình tạo task, xác nhận cấu hình, trả lời câu hỏi, theo dõi tới
  PR xanh và thấy DONE sau merge thủ công mà không dùng lệnh con của `cusr` nào; tổng thời gian thao tác (không tính
  lúc agent chạy) dưới 3 phút. Có ít nhất một lần chạy với mỗi harness thật ở cả hai chế độ, ghi riêng với lần chạy
  giả lập.
- **SC-005**: Người chưa đọc tài liệu tới được chi tiết task, log, trợ giúp và thoát ra ngay lần thử đầu, chỉ dựa vào
  gợi ý trên màn hình, trong 2 phút.
- **SC-006**: 100% bộ kiểm thử hợp đồng CLI hiện có đạt không sửa; mọi cách gọi không có terminal hoặc có `--json`
  giữ nguyên output và exit code.
- **SC-007**: Với mỗi thao tác ở ba mức quyền, kết quả về quyền, event và số effect giống hệt cùng thao tác qua CLI;
  gửi lại 2–5 lần và mất kết nối sau khi gửi đều cho đúng một tác dụng logic.
- **SC-008**: Trong kiểm thử phím ngẫu nhiên có seed tái hiện (ít nhất 10.000 phím trên từng màn hình), không có lần
  nào xác nhận cấu hình chạy, hủy task hoặc kiểm tra lại `worktree_changed` mà chưa qua màn xem lại và bước xác nhận
  riêng.
- **SC-009**: Một phiên mở trong 1 giờ không thao tác tạo 0 event mới, 0 lượt agent, 0 token LLM và không chiếm slot
  thực thi.
- **SC-010**: 100% mẫu nội dung chứa ký tự điều khiển không làm đổi nội dung màn hình ngoài vùng hiển thị của nó và
  không gửi được lệnh tới terminal.
- **SC-011**: Terminal trở về trạng thái ban đầu ở 100% đường thoát: thoát thường, Ctrl-C, SIGTERM, SIGHUP và lỗi nội
  bộ; task vẫn tiếp tục ở 100% mẫu. Daemon chết không phải đường thoát: ở 100% mẫu, giao diện vẫn mở, giữ nội dung đang
  nhập và hiện màn hình mất kết nối.
- **SC-012**: Trên máy sạch, với từng điều kiện thiếu, giao diện chỉ đúng bước tiếp theo ở 100% mẫu; chỉ làm theo các
  chỉ dẫn đó người dùng tạo được task đầu tiên. 100% lệnh được gợi ý có thật trong bản đang chạy.
- **SC-013**: Phiên mở 8 giờ với log liên tục không treo phím, không tăng bộ nhớ liên tục và độ trễ phản hồi phím vẫn
  dưới 200 ms ở 95% lần bấm.
- **SC-014**: Với các mẫu gây lỗi trên daemon thật (tạo task xong rồi mất phản hồi; thao tác bị từ chối rồi mất phản
  hồi; daemon chết trước và sau khi ghi task nhưng trước khi lưu kết quả; request không tồn tại; actor khác; project
  ngoài phạm vi), người dùng thoát giao diện rồi chạy nguyên văn lệnh đã in hoặc lệnh tra cứu với ID của mẫu: 100% mẫu
  trả đúng trạng thái FR-042, số task, event và attempt không đổi sau khi tra, và hai mẫu về quyền không phân biệt được
  với request không tồn tại.
- **SC-015**: Trong các mẫu mất kết nối và đọc lỗi khi đang soạn, không có request ID mới nào tới daemon trong lúc dữ
  liệu đang cũ hoặc trước lần đọc lại đầu tiên sau khi hồi phục. Ở 100% mẫu, nội dung đang nhập còn nguyên và không
  thao tác nào được gửi nếu người dùng chưa gửi lại.
- **SC-016**: Với mẫu task có nội dung dài ở terminal 80×24, 100% trường của FR-026 xem được đầy đủ và khớp nội dung đã
  ghi của đúng revision. Với mẫu không đọc được nội dung hoặc revision đã đổi, 0 xác nhận được ghi nhận.

## Assumptions

- Người dùng là một chủ dự án trên Linux/Ubuntu hoặc WSL2 theo phạm vi hiến chương; dùng được qua SSH và tmux vì đều
  là terminal thông thường.
- Giao diện chạy với kết nối của chính người gọi. Với process cùng UID có shell đầy đủ, token map không phải ranh giới
  quyền ([deploy/README.md](../../deploy/README.md)); giao diện không cải thiện cũng không làm xấu đi ranh giới này.
  Assistant tiếp tục dùng CLI `--json` và [skill `cusr`](../../skills/cusr/SKILL.md), không điều khiển giao diện.
- Chữ trên giao diện là tiếng Anh, thống nhất với thông báo hiện có của CLI, theo quyết định ở mục Clarifications; đa
  ngôn ngữ nằm ngoài phạm vi.
- no-mistakes và Bernstein chỉ là tham khảo về trải nghiệm (theo dõi trực tiếp pipeline hoặc nhiều agent trong
  terminal), không ràng buộc bố cục hay tính năng. Quyền và xác nhận do hiến chương quyết định.
- Daemon do người vận hành chạy theo [deploy/README.md](../../deploy/README.md). Giao diện không đổi giới hạn feature
  002 (một slot thực thi, merge thủ công, không retry); khi các giới hạn đó được nới ở feature sau, giao diện hiển thị
  theo dữ liệu thật chứ không giả định trước.
- [PR #1 (spec 003, GitHub issue và Telegram)](https://github.com/duykhanh01/cuesura/pull/1) chưa merge và đang giữ số
  003 nên feature này lấy số 004. Feature này không phụ thuộc vào nó; task và câu trả lời từ kênh khác chỉ hiện như
  dữ liệu.
- Chu kỳ làm mới cụ thể, cách cập nhật dữ liệu, thư viện giao diện và bố cục chi tiết do plan quyết định, trong giới
  hạn của SC-002, SC-003 và hiến chương. Thêm dependency cần biện minh theo nguyên tắc VIII.

### Phụ thuộc

Đối chiếu với mã hiện tại trên `main`, các năng lực chỉ đọc sau **chưa có** và cần bổ sung để đáp ứng spec:

| Nhu cầu | Hiện trạng | Yêu cầu liên quan |
| --- | --- | --- |
| Liệt kê project trong phạm vi token | Chưa có lệnh hoặc truy vấn; `doctor` và `task add` phải biết trước tên project | FR-005, FR-024, FR-029 |
| Profile đã xác định, chế độ, binding hợp lệ cho từng task và `when_to_use` | Có trong cấu hình nhưng chưa đọc được qua CLI ([skill `cusr`](../../skills/cusr/SKILL.md) ghi rõ); profile và binding còn phụ thuộc task và `cusr.yaml` | FR-025 |
| Bước hiện tại, chế độ và thời gian ở trạng thái, ở mức danh sách | `task list` chỉ trả status, wait code, version, priority, PR, head; `task show` có bước nhưng phải gọi từng task | FR-006 |
| Danh sách bước workflow của task theo chế độ | `task show` và `task explain` chỉ trả bước hiện tại và các bước đã có attempt | FR-011 |
| Xem thay đổi của `worktree_changed` | Chưa thấy đường đọc diff qua daemon. Mốc đầu không thêm đường đọc này mà dùng phương án US4 số 4 đã cho phép: nói rõ không xem được và chỉ vị trí worktree | FR-022, US4 |
| Tra cứu kết quả mutation theo request ID sau khi client thoát | `command_ledger` có actor, loại, task, trạng thái và kết quả nhưng chưa có lệnh hoặc truy vấn đọc, và chưa lưu project hay payload. Bản ghi `admitted` sau crash chỉ chạy tiếp khi gửi lại đúng payload nên không được coi là đang xử lý. `task show`/`history` cần task ID mà client chưa biết nếu mất phản hồi của `task add` | FR-041, FR-042, FR-043, EC-012, SC-014 |
| Đọc trực tiếp nội dung task theo revision | `task show` chỉ trả `title` trong nội dung task. `task history` đã trả nội dung đầy đủ trong payload của `TaskCreated` và `TaskRevised`, nhưng phải duyệt event, chưa có đường đọc trực tiếp theo revision. Plan quyết định dùng history hay bổ sung query | FR-026, US5, SC-016 |
| Log theo attempt | `task_logs` chỉ lọc theo task; bản ghi có `operation_id` và `step` nhưng chưa có attempt. Lọc ở client còn phải đọc từ đầu log qua các trang tối đa 200 bản ghi. Plan chốt thêm trường, tham số lọc hay giữ lọc ở client | FR-014, US2 |
| Chẩn đoán khi daemon chưa chạy | CLI chỉ báo lỗi kết nối; đường dẫn cấu hình do `cusrd --config` quyết định nên client chưa biết | FR-029 (mốc sau) |

Plan MUST xác minh lại bảng này cùng các hợp đồng [CLI/daemon](../002-task-to-green-pr/contracts/cli-daemon.md),
[chế độ thực thi](../002-task-to-green-pr/task-execution-modes.md) và [thuật ngữ](../../GLOSSARY.md) trước khi thiết kế.
