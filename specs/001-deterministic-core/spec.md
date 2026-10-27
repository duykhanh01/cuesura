# Feature Specification: Lõi điều phối tất định

**Feature Branch**: `001-deterministic-core`

**Created**: 2026-10-27

**Status**: Draft

**Input**: User description: "Lõi điều phối tất định của Cuesura (mốc "Lõi" trong SPEC.md §19): schema miền
và task chuẩn, loader cusr.yaml thành snapshot/revision bất biến, decide/evolve thuần, store với event
log/projection/outbox/timer và dedup trigger, FrozenPolicy với role binding, thang nâng cấp và ngân sách,
kèm bằng chứng kiểm thử cho các bất biến thuộc tầng quyết định và tầng store. Chưa gọi agent thật, chưa
runner/worktree/GitHub."

## Bối cảnh và phạm vi

Đây là feature đầu tiên của Cuesura, tương ứng mốc "Lõi" trong [SPEC.md §19](../../SPEC.md). Mọi
feature sau (runner, worktree, GitHub, recovery, CLI) đều dựa trên ba năng lực mà feature này cung cấp:

1. Biến cấu hình người dùng và repo thành **chính sách đóng băng** đã kiểm tra, có hash, không đổi trong
   suốt một revision của task.
2. **Lõi quyết định** chọn bước tiếp theo, lý do chờ, nấc model và yêu cầu effect chỉ từ dữ liệu đã ghi
   nhận, không gọi LLM.
3. **Kho trạng thái bền** chấp nhận mỗi tín hiệu (trigger) đúng một lần về mặt logic và ghi sự kiện,
   trạng thái dẫn xuất, effect cần làm và timer trong cùng một lần ghi nguyên tử.

Feature này **không** chạy agent thật, không tạo runner, worktree, commit/push/PR/merge, không có daemon,
CLI hay kênh Telegram/GitHub. Kết quả của agent, gate, CI và effect bên ngoài được đưa vào như các tín
hiệu đã ghi sẵn (fixture) để kiểm chứng hành vi của lõi.

## Clarifications

### Session 2026-10-27

- Q: Lượt agent đã được yêu cầu nhưng chưa chạy thì có bị trừ ngân sách không? → A: Phân biệt ngân sách
  giữ chỗ và đã dùng. Chắc chắn chưa chạy thì trả giữ chỗ; xác nhận đã gọi agent thì tính là đã dùng;
  chưa rõ thì giữ chỗ cho tới khi đối chiếu xong (FR-022).
- Q: Người dùng sửa yêu cầu khi coder đang chạy thì áp revision mới ở đâu? → A: Ghi nhận ngay, cho
  attempt hiện tại kết thúc, chặn bước nghiệp vụ tiếp theo. "Ranh giới an toàn" là lúc attempt đã kết
  thúc và các effect liên quan đã rõ kết quả; khi đó người dùng chọn một trong ba hướng của SPEC.md §5.3.
  Hủy ngay attempt là thao tác riêng (FR-011).
- Q: Yêu cầu hủy đến khi request merge đã gửi, đối chiếu cho thấy PR đã merge thì task ở trạng thái nào?
  → A: DONE, kèm ghi nhận yêu cầu hủy đến quá muộn. Đảo thay đổi là quy trình revert riêng (FR-018).
- Q: Feature 001 có thực thi các chế độ decider không? → A: Không. Feature 001 chỉ thực thi chế độ
  `human`; các chế độ `agent`, `agent_if_confident`, `agent_review` bị từ chối rõ ràng khi chốt chính
  sách. Decider là một feature riêng (FR-039).

## User Scenarios & Testing *(mandatory)*

Người dùng chính là **chủ dự án** (người vận hành Cuesura trên máy của mình) và **người phát triển các
feature kế tiếp**, những người cần một lõi đã được chứng minh đúng trước khi nối vào agent và hệ thống
bên ngoài.

### User Story 1 - Kiểm tra cấu hình và chốt chính sách (Priority: P1)

Chủ dự án viết cấu hình người dùng và `cusr.yaml` của repo (role, binding model, workflow, profile, pool,
gate, thang nâng cấp, ngân sách). Hệ thống đọc, chuẩn hoá và kiểm tra cấu hình. Nếu sai, chủ dự án nhận
danh sách lỗi chỉ đúng file, dòng, cột và nguyên nhân. Nếu đúng, hệ thống tạo một chính sách đóng băng
có hash, đủ để mọi bước sau quyết định mà không cần đọc lại cấu hình.

**Why this priority**: Không có chính sách đã kiểm tra thì lõi quyết định không có đầu vào hợp lệ. Lỗi
cấu hình phát hiện sớm rẻ hơn nhiều so với lỗi phát hiện giữa lúc agent đang chạy.

**Independent Test**: Chạy bộ cấu hình mẫu hợp lệ và không hợp lệ qua bộ kiểm tra cấu hình; so sánh lỗi
trả về với lỗi mong đợi và so sánh hash của các cấu hình tương đương.

**Acceptance Scenarios**:

1. **Given** cấu hình có workflow mà một transition trỏ tới bước không tồn tại, **When** chủ dự án kiểm
   tra cấu hình, **Then** hệ thống từ chối và báo vị trí file:dòng:cột của transition đó cùng tên bước
   bị thiếu.
2. **Given** workflow có vòng lặp review → fix không có giới hạn đếm, **When** kiểm tra, **Then** hệ
   thống từ chối và chỉ ra chu trình chưa có giới hạn.
3. **Given** hai cấu hình chỉ khác nhau về thứ tự key và định dạng, **When** chốt chính sách, **Then**
   hai chính sách đóng băng có cùng hash.
4. **Given** một cấu hình hợp lệ, **When** chủ dự án sửa file cấu hình sau khi đã chốt chính sách cho
   một task, **Then** chính sách của task đó không đổi; chỉ task mới hoặc amendment được duyệt mới dùng
   cấu hình mới.
5. **Given** thang nâng cấp có một nấc không thể đạt được trong giới hạn lượt của workflow, **When** kiểm
   tra, **Then** hệ thống báo lỗi nấc không thể đạt.
6. **Given** một yêu cầu amendment chỉ ghi tên actor, hoặc có ngữ cảnh quyền `operate` mà không có
   `admin`, **When** yêu cầu được xử lý, **Then** hệ thống từ chối vì thiếu quyền; chính sách, revision và
   ngân sách của task giữ nguyên, và không có sự kiện amendment nào được ghi.
7. **Given** cùng một khoá được khai báo ở toolchain pack, ở `cusr.yaml` và trong override khi tạo task,
   **When** hợp nhất cấu hình, **Then** giá trị cuối tuân theo FR-001: project thắng pack; override task
   chỉ được áp khi profile cho phép khoá đó và không nới quyền vượt người gọi; khoá mà repo không có thẩm
   quyền (role, model, policy, quyền) trong `cusr.yaml` bị báo lỗi thay vì âm thầm áp dụng.
8. **Given** task đã chốt ngữ cảnh thực thi, **When** nội dung yêu cầu hoặc một attachment gốc thay đổi
   sau đó, **Then** ngữ cảnh đã chốt vẫn giữ nguyên nội dung và hash; thay đổi chỉ đi vào qua source drift
   và revision mới.
9. **Given** workflow khai báo chế độ quyết định `agent_review` cho một điểm quyết định, **When** kiểm
   tra cấu hình, **Then** hệ thống báo chế độ này chưa được hỗ trợ; **When** chốt chính sách cho task dùng
   workflow đó, **Then** task ở PENDING kèm lý do và không có điểm quyết định nào được chuyển sang
   `human`.

---

### User Story 2 - Tạo task chuẩn và quyết định bước tiếp theo một cách tất định (Priority: P1)

Chủ dự án (qua giao diện lập trình hoặc bộ mô phỏng của feature này) đưa vào một yêu cầu task. Hệ thống
chuẩn hoá thành task chuẩn, kiểm tra acceptance và dependency, rồi đưa task qua các trạng thái PENDING,
READY, RUNNING, WAITING và kết thúc theo workflow phát triển phần mềm mặc định. Ở mỗi tín hiệu (kết quả
agent giả lập, gate, review, CI, câu trả lời của người dùng, timer), lõi quyết định trả về sự kiện mới
và các effect cần làm. Cùng dữ liệu đầu vào luôn cho cùng kết quả.

**Why this priority**: Đây là giá trị cốt lõi của sản phẩm: điều phối bằng code, giải thích và tái hiện
được, không tốn token. Mọi feature sau chỉ thực thi những gì lõi đã quyết định.

**Independent Test**: Phát lại một chuỗi tín hiệu ghi sẵn cho một task; kiểm tra chuỗi sự kiện, effect
và trạng thái cuối khớp kết quả mong đợi, và phát lại lần hai cho kết quả giống hệt từng byte.

**Acceptance Scenarios**:

1. **Given** yêu cầu task không có tiêu chí acceptance, **When** tạo task, **Then** task ở PENDING với
   lý do `needs_info` và không có effect khởi chạy agent nào.
2. **Given** task phụ thuộc task khác đang chạy, **When** task được tạo, **Then** task ở PENDING với lý
   do `dependency`; khi prerequisite DONE, task chuyển READY; khi prerequisite FAILED, task vẫn chờ kèm
   giải thích.
3. **Given** task đang ở bước code, **When** nhận kết quả agent hợp lệ với `status: done` nhưng gate bắt
   buộc fail, **Then** task không qua bước; lõi yêu cầu bước sửa tiếp theo trong giới hạn lượt.
4. **Given** kết quả agent báo `needs_input`, **When** tín hiệu được xử lý, **Then** task chuyển WAITING
   với lý do `human_input`, có câu hỏi được ghi lại; câu trả lời hợp lệ đầu tiên làm task tiếp tục.
5. **Given** cùng trạng thái, chính sách và chuỗi tín hiệu, **When** chạy lõi quyết định hai lần, **Then**
   hai lần tạo cùng sự kiện, cùng effect và cùng trạng thái cuối.
6. **Given** task đã ở DONE, FAILED hoặc CANCELLED, **When** có tín hiệu mới hoặc yêu cầu retry, **Then**
   task cũ không mở lại; retry tạo task mới có liên kết tới task nguồn.
7. **Given** outbox của task còn một effect khởi chạy agent chưa được nhận để thực thi, **When** yêu cầu
   hủy được xử lý, **Then** effect đó bị vô hiệu hoá trong cùng lần ghi, mọi lần nhận việc sau đó không
   bắt đầu được nó, và không có effect nghiệp vụ mới nào được tạo.
8. **Given** task có một effect đã bắt đầu và một effect có kết quả `unknown`, **When** yêu cầu hủy được
   xử lý, **Then** task chưa thành CANCELLED; hệ thống chỉ tạo effect dừng attempt và đối chiếu, và task
   thành CANCELLED sau khi cả hai effect có kết quả đối chiếu.
9. **Given** request merge đã gửi khi yêu cầu hủy đến, **When** đối chiếu xác nhận PR đã merge, **Then**
   task thành DONE và lịch sử ghi rõ yêu cầu hủy đến quá muộn; không có effect revert nào được tạo tự
   động.
10. **Given** coder đang chạy theo revision 1, **When** người dùng sửa yêu cầu, **Then** source drift được
    ghi ngay; attempt hiện tại được kết thúc; sau khi effect liên quan rõ kết quả, task chờ người dùng
    chọn, và không có attempt, publish hay merge nào dựa trên revision 1 được bắt đầu trong lúc đó.

---

### User Story 3 - Ghi nhận tín hiệu bền và đúng một lần (Priority: P2)

Mỗi tín hiệu đưa vào hệ thống (kể cả tín hiệu gửi trùng hoặc gửi lại sau khi tiến trình chết) được ghi
nhận nguyên tử: kiểm tra trùng, ghi sự kiện, cập nhật trạng thái dẫn xuất, ghi effect cần làm và timer
cùng thành công hoặc cùng không xảy ra. Trạng thái dẫn xuất luôn dựng lại được từ nhật ký sự kiện.

**Why this priority**: Đây là nền cho khôi phục sau crash và chống lặp side effect ở các feature sau. Nó
đứng sau P1 vì lõi quyết định có thể được kiểm chứng trước ở dạng thuần.

**Independent Test**: Chạy một chuỗi tín hiệu có tín hiệu trùng và có ngắt tiến trình tại các điểm ngẫu
nhiên trong lúc ghi; sau mỗi lần ngắt, mở lại kho, kiểm tra không có ghi một nửa, không có sự kiện trùng,
và trạng thái dựng lại từ nhật ký khớp trạng thái đã lưu.

**Acceptance Scenarios**:

1. **Given** một tín hiệu đã được chấp nhận, **When** cùng tín hiệu (cùng khoá trùng) được gửi lại,
   **Then** không có sự kiện, effect hay timer mới; hệ thống trả lại kết quả của lần chấp nhận đầu.
2. **Given** tiến trình bị ngắt giữa lúc ghi một tín hiệu, **When** mở lại kho, **Then** hoặc toàn bộ
   tín hiệu đã được ghi, hoặc không có phần nào được ghi.
3. **Given** một lệnh dựa trên phiên bản trạng thái cũ, **When** lệnh được gửi sau khi trạng thái đã đổi,
   **Then** lệnh bị từ chối như conflict và không thay đổi gì.
4. **Given** kho có nhật ký sự kiện của nhiều task, **When** dựng lại toàn bộ trạng thái dẫn xuất từ
   nhật ký, **Then** kết quả khớp 100% với trạng thái đang lưu.
5. **Given** một effect đã được ghi cho một thao tác logic, **When** lõi yêu cầu lại cùng thao tác đó,
   **Then** effect dùng lại cùng khoá idempotency và không tạo effect thứ hai.
6. **Given** timer đến hạn, **When** timer được tiêu thụ, **Then** nó chỉ tạo một tín hiệu về mặt logic,
   kể cả khi bị xử lý lại sau khi tiến trình chết.

---

### User Story 4 - Nâng model và ngân sách theo chính sách đã duyệt (Priority: P2)

Khi bước code, review hoặc sửa lỗi thất bại, lõi phân loại thất bại và quyết định thử lại, chờ hay nâng
nấc theo thang trong chính sách đóng băng. Mọi lượt gọi agent và lượt gọi người quyết định tự động
(decider) đều trừ vào ngân sách. Hết thang, hết lượt hoặc hết thời hạn thì task chờ người dùng quyết định.

**Why this priority**: Đây là cơ chế giữ chi phí dự đoán được và giữ quyền kiểm soát ở người dùng. Nó cần
lõi quyết định của Story 2 trước.

**Independent Test**: Phát lại chuỗi kết quả thất bại có chữ ký lỗi khác nhau dưới các chính sách mẫu;
kiểm tra nấc được chọn, số lượt đã dùng và lý do chờ khớp bảng mong đợi.

**Acceptance Scenarios**:

1. **Given** hai thất bại chất lượng liên tiếp cùng chữ ký ở cùng nấc, và nấc kế tiếp là `auto`, **When**
   tín hiệu thất bại thứ hai được xử lý, **Then** lõi chọn nấc kế tiếp mà không chờ duyệt.
2. **Given** nấc kế tiếp là `needs_approval` và chưa có approval hợp lệ, **When** cần nâng, **Then** task
   chuyển WAITING với lý do `approval` và không bắt đầu attempt mới.
3. **Given** thất bại do rate limit hoặc lỗi hạ tầng, **When** xử lý, **Then** không tăng bộ đếm thất bại
   chất lượng và không nâng model; task chờ theo timer hoặc retry cùng nấc trong giới hạn.
4. **Given** task đã dùng hết lượt agent cho phép, **When** cần một attempt mới, **Then** không có attempt
   mới; task chờ quyết định của người dùng với lý do rõ ràng.
5. **Given** task quay lại một bước đã chạy ở nấc cao, **When** bước đó chạy lại, **Then** nấc không hạ;
   và một bước chưa chạy bắt đầu từ sàn của chính bước đó.
6. **Given** usage của một lượt không đo được, **When** ghi nhận, **Then** usage được đánh dấu
   `unavailable`, không ghi thành 0.
7. **Given** attempt thất bại với lớp Auth/config hoặc Refused, **When** xử lý, **Then** task chuyển
   WAITING chờ người, không có attempt mới, không nâng nấc, kể cả khi còn ngân sách.
8. **Given** attempt bị timeout lần thứ hai liên tiếp ở cùng bước, **When** xử lý, **Then** không có
   retry thứ ba; task chờ người quyết định về phạm vi hoặc thời gian.
9. **Given** kết quả Invalid output đã qua một lượt repair và một lượt session mới mà vẫn sai, **When**
   xử lý, **Then** lõi xét nấc tiếp theo theo thang; không có thêm lượt repair ở nấc cũ.
10. **Given** lỗi Infra/transient lặp lại và trần lượt agent chỉ còn 1, **When** xử lý, **Then** lõi dừng
    theo trần lượt agent dù giới hạn 3 lần retry của lớp chưa hết, và mọi lượt retry đã chạy đều được
    tính vào trần lượt agent.
11. **Given** task còn đúng một lượt agent và lõi đã ghi giữ chỗ cho effect khởi chạy, **When** task bị
    hủy trước khi effect được dispatch, **Then** giữ chỗ được trả lại và lượt đó không bị tính là đã dùng.
12. **Given** effect khởi chạy agent có kết quả `unknown` sau crash, **When** tính ngân sách còn lại,
    **Then** lượt đó vẫn ở trạng thái giữ chỗ, không khả dụng cho attempt khác, cho tới khi đối chiếu
    xác nhận đã chạy (thành đã dùng) hoặc chưa chạy (được trả lại).

---

### User Story 5 - Giải thích trạng thái từ dữ liệu đã ghi (Priority: P3)

Chủ dự án hỏi "task này đang ở đâu, vì sao dừng, đã dùng nấc nào, còn bao nhiêu lượt". Hệ thống trả lời
hoàn toàn từ dữ liệu đã ghi, không gọi LLM, và mọi task đang chờ đều có lý do cùng điều kiện tiếp tục.

**Why this priority**: Giải thích được là một giá trị cam kết của sản phẩm, nhưng có thể dựng sau khi dữ
liệu đúng đã có.

**Independent Test**: Với một kho đã chạy các kịch bản ở Story 2–4, truy vấn giải thích cho từng task và
đối chiếu với nhật ký sự kiện.

**Acceptance Scenarios**:

1. **Given** task đang WAITING, **When** chủ dự án yêu cầu giải thích, **Then** câu trả lời có lý do chờ,
   điều kiện để tiếp tục, đường kết thúc và giới hạn còn lại.
2. **Given** task đã nâng nấc, **When** yêu cầu giải thích, **Then** câu trả lời liệt kê mỗi lần nâng cùng
   chữ ký thất bại và sự kiện đã kích hoạt nó.

---

### Edge Cases

- Cấu hình có key trùng, tag YAML không hỗ trợ, alias lồng quá giới hạn hoặc file vượt kích thước cho
  phép: từ chối với vị trí lỗi, không đọc một phần.
- Dependency tự tham chiếu hoặc tạo chu trình: từ chối khi tạo task.
- Một role không còn binding hợp lệ nào sau khi áp allowlist: task không được READY và có lý do.
- Cấu hình trở nên không hợp lệ giữa lúc task được tạo và lúc chốt chính sách: task ở PENDING, không âm
  thầm dùng chính sách khác.
- Hai câu trả lời cạnh tranh cho cùng một câu hỏi: câu hợp lệ đầu tiên thắng, câu sau nhận conflict.
- Hai tín hiệu đến cùng lúc cho cùng task: thứ tự được quyết định bởi thứ tự ghi nhận, không theo ID hay
  đồng hồ hệ thống.
- Đồng hồ hệ thống nhảy lùi hoặc nhảy tới: lõi quyết định không đọc đồng hồ; thời điểm hiện tại là dữ
  liệu đầu vào đã ghi nhận.
- Tín hiệu kết quả mang ID attempt cũ hoặc không khớp attempt hiện hành: bị bỏ qua có ghi nhận, không làm
  qua bước.
- Kho không ghi được (đầy đĩa, bận quá thời gian chờ): tín hiệu bị từ chối rõ ràng; hệ thống không báo đã
  lưu khi thực tế chưa lưu.
- Kết quả effect là `unknown`: không được coi là "chưa xảy ra"; task chờ đối chiếu.
- Yêu cầu hủy task khi còn effect chưa rõ kết quả: task chưa thành CANCELLED cho tới khi effect được đối
  chiếu.

## Requirements *(mandatory)*

### Functional Requirements

**Cấu hình và chính sách đóng băng**

- **FR-001**: Hệ thống MUST áp dụng hai quy tắc hợp nhất riêng biệt (SPEC.md §8):
  - **Toolchain pack → cấu hình project:** pack là dữ liệu preset; `cusr.yaml` của repo ghi đè pack cho
    các khoá thuộc thẩm quyền project (setup, gate, autofix, log digest, failure signature, CI rules, pool
    riêng, hotspot, conventions).
  - **Profile → override khi tạo task:** profile quy định khoá nào được override; override chỉ áp cho các
    khoá đó và MUST NOT nới quyền vượt quyền của người gọi.

  Role, model alias, binding, harness, workflow, profile, pool chung và quyền chỉ đến từ cấu hình người
  dùng; `cusr.yaml` khai báo các khoá này MUST bị báo lỗi. Quyền yolo không bao giờ đến từ `cusr.yaml`.
- **FR-002**: Hệ thống MUST từ chối cấu hình có key trùng, tag không hỗ trợ, tham chiếu không hợp lệ hoặc
  vượt giới hạn kích thước/alias, và báo mỗi lỗi kèm file, dòng, cột.
- **FR-003**: Hệ thống MUST thực hiện đủ sáu kiểm tra trước thực thi của SPEC.md §8: tham chiếu tồn tại;
  outcome hữu hạn và có đích; mọi chu trình có bộ đếm không reset; thang nâng cấp đạt được; mỗi bước có
  binding khởi đầu hợp lệ; predicate chỉ thuộc tập định nghĩa trước.
- **FR-004**: Hệ thống MUST tạo chính sách đóng băng gồm workflow đã mở rộng, binding và thang từng bước,
  quyền, gate thực tế, giới hạn, chế độ quyết định, schema version và hash của cấu hình hiệu lực đã chuẩn
  hoá; cấu hình tương đương về ngữ nghĩa MUST cho cùng hash.
- **FR-005**: Chính sách đóng băng MUST bất biến theo revision của task. Thay đổi chỉ qua amendment có
  actor, lý do, diff và phiên bản mới; v1 không đổi graph workflow của task đang chạy.
- **FR-036**: Amendment MUST chỉ được chấp nhận khi đi kèm một ngữ cảnh quyền đáng tin cậy chứng minh
  actor có quyền `admin`. Ngữ cảnh này do tầng dịch vụ đã xác thực cấp; lõi coi đây là tiền điều kiện
  bắt buộc và MUST từ chối amendment khi thiếu ngữ cảnh hoặc chỉ có tên actor/`requested_by` tự khai.
  Amendment bị từ chối MUST NOT đổi chính sách, revision hay ngân sách của task. Việc xác thực người gọi
  thuộc feature daemon/CLI.
- **FR-037**: Khi task bắt đầu thực thi, hệ thống MUST tạo đồng thời, trong cùng một lần ghi, chính sách
  đóng băng và ngữ cảnh thực thi đóng băng gắn cùng task/revision và cùng `base_sha`. Ngữ cảnh gồm nội
  dung yêu cầu, acceptance, bản chụp nội dung attachments (kèm hash), prompt/conventions và `base_sha`.
  Ở feature này, `base_sha` và nội dung attachment do caller cung cấp như dữ liệu; lõi không đọc git hay
  mạng.
- **FR-038**: Ngữ cảnh thực thi đóng băng MUST bất biến: thay đổi của yêu cầu hoặc attachment gốc sau khi
  chốt MUST NOT làm đổi nội dung hay hash của nó. Output bước trước, diff và Q&A là context tăng thêm có
  provenance, không ghi đè ngữ cảnh gốc. Nếu không chốt được một trong hai snapshot, task ở PENDING và
  không snapshot nào được ghi.
- **FR-039**: Feature này chỉ thực thi chế độ quyết định `human`. Bộ kiểm tra cấu hình MUST chấp nhận cú
  pháp của `agent`, `agent_if_confident` và `agent_review` nhưng báo rõ là chưa được hỗ trợ; khi chốt
  chính sách cho một task dùng các chế độ này, hệ thống MUST từ chối, giữ task ở PENDING kèm lý do, và
  MUST NOT âm thầm chuyển sang `human`.
- **FR-006**: Hệ thống MUST từ chối chế độ quyết định tự động (decider) cho các loại quyết định bị cấm ở
  SPEC.md §10: sửa policy/thang, tăng ngân sách, xử lý secret, xoá dữ liệu và merge vào protected branch.

**Task chuẩn và trạng thái**

- **FR-007**: Hệ thống MUST chuẩn hoá mọi yêu cầu task về một định dạng duy nhất có schema version và
  revision (các trường ở SPEC.md §5.2), và dedup yêu cầu trùng theo khoá nguồn.
- **FR-008**: Task MUST NOT tới READY khi chưa có ít nhất một tiêu chí acceptance, khi dependency không
  tồn tại, tự tham chiếu hoặc tạo chu trình, hoặc khi chưa xác nhận đối với task cần xác nhận.
- **FR-009**: Hệ thống MUST chỉ cho phép các chuyển trạng thái của SPEC.md §6.1; mọi trạng thái chờ MUST
  có lý do thuộc tập định nghĩa trước và điều kiện tiếp tục hoặc kết thúc.
- **FR-010**: Trạng thái kết thúc (DONE, FAILED, CANCELLED) MUST NOT mở lại; retry sau kết thúc tạo task
  mới có liên kết nguồn và giữ nguyên lịch sử task cũ.
- **FR-011**: Thay đổi yêu cầu sau khi task đã chạy MUST được ghi nhận ngay là source drift. Attempt đang
  chạy được phép kết thúc, nhưng lõi MUST NOT bắt đầu bước nghiệp vụ tiếp theo (attempt mới, publish,
  merge) dựa trên revision cũ. Ranh giới an toàn là khi không còn attempt đang chạy và mọi effect liên
  quan đã có kết quả đối chiếu; tại đó task chờ người dùng chọn tiếp tục revision cũ, áp revision mới
  hoặc tạo task mới. Hủy ngay attempt đang chạy là một thao tác riêng, không tự xảy ra do source drift.
  Đổi revision MUST vô hiệu hoá kết quả và approval không còn phù hợp, nhưng không reset ngân sách, số
  lượt đã dùng hay lịch sử.

**Lõi quyết định**

- **FR-012**: Lõi quyết định MUST là hàm của (trạng thái, chính sách đóng băng, tín hiệu đã ghi nhận) và
  MUST NOT đọc đồng hồ, sinh số ngẫu nhiên, gọi mạng, đọc file hay gọi LLM. Thời điểm hiện tại, ID và
  jitter MUST được cấp từ ngoài như dữ liệu.
- **FR-013**: Lõi quyết định MUST mô hình hoá workflow phát triển phần mềm mặc định (Triage → Prepare →
  Scout tuỳ chọn → Code → Gates → Review → Publish → CI → Merge → Complete) ở mức quyết định, trả về yêu
  cầu effect thay vì tự thực hiện.
- **FR-014**: Lõi MUST NOT cho qua bước chỉ vì exit thành công hoặc agent báo "xong": kết quả phải được
  đánh dấu đã kiểm tra schema, khớp attempt hiện hành và mọi gate bắt buộc đạt.
- **FR-015**: Lõi MUST NOT yêu cầu effect merge trừ khi các điều kiện của SPEC.md §14.2 đã được ghi nhận
  là đạt cho đúng head/base; check ở trạng thái pending, cancelled, missing hoặc unknown không tính là
  đạt. Decider không bao giờ là bên quyết định merge.
- **FR-016**: Mỗi yêu cầu effect MUST có khoá idempotency ổn định suy ra từ danh tính thao tác logic
  (namespace theo project/task/revision khi phù hợp); thử lại cùng thao tác dùng lại cùng khoá, attempt
  nghiệp vụ mới có khoá mới.
- **FR-017**: Lõi MUST xử lý kết quả effect `unknown` như chưa rõ: chờ đối chiếu, không phát lại thao tác
  nguy hiểm theo phỏng đoán.
- **FR-018**: Trong cùng lần ghi xử lý yêu cầu hủy, hệ thống MUST:
  - chặn mọi effect nghiệp vụ mới của task;
  - vô hiệu hoá mọi effect nghiệp vụ đã nằm trong outbox nhưng chưa được nhận để thực thi (chưa
    dispatch), để chúng không bao giờ được thực thi sau đó;
  - giữ nguyên effect đã bắt đầu hoặc có kết quả `unknown` để đối chiếu, không coi là đã huỷ;
  - chỉ cho phép tạo các effect phục vụ việc hủy: dừng attempt thuộc task và đối chiếu kết quả.

  Sau khi mọi effect đã bắt đầu hoặc `unknown` được đối chiếu, task MUST nhận trạng thái phản ánh kết
  quả thực tế: CANCELLED nếu workflow chưa đạt điều kiện kết thúc thành công; DONE nếu đối chiếu xác nhận
  merge đã thành công, kèm ghi nhận yêu cầu hủy đến quá muộn. Hủy không hoàn tác một merge đã thành công;
  đảo thay đổi là quy trình revert riêng.

**Escalation và ngân sách**

- **FR-019**: Hệ thống MUST phân loại thất bại theo tám lớp của SPEC.md §9.2, chỉ tính lớp Quality và
  Invalid output vào escalation chất lượng, và MUST áp dụng đúng cách xử lý của từng lớp. Giới hạn riêng
  của mỗi lớp áp dụng đồng thời với trần lượt agent và thời hạn task; chạm giới hạn nào trước thì dừng
  theo giới hạn đó.

  | Lớp | Hành động bắt buộc | Giới hạn riêng | Escalation chất lượng |
  |---|---|---|---|
  | Rate limit | Cooldown đến `reset_at` qua timer; không biết reset thì backoff hữu hạn | Theo backoff đã khai báo | Không |
  | Infra/transient | Retry cùng nấc có backoff | Tối đa 3 lần retry | Không |
  | Auth/config | Chờ người (WAITING), không retry tự động | 0 lần retry | Không |
  | Timeout/stall | Retry một lần; còn lỗi thì chờ người về phạm vi/thời gian | Tối đa 1 lần retry | Không |
  | Invalid output | Một lượt repair ngắn, rồi tối đa một lượt session mới; vẫn sai thì xét nấc tiếp | 1 repair + 1 session mới mỗi nấc | Có |
  | Refused | Ghi lý do và chờ người; không retry, không escalate để vượt từ chối | 0 lần retry | Không |
  | Quality | Tính chữ ký lỗi; sửa theo vòng hữu hạn và thang ở FR-020 | Theo FR-020 | Có |
  | Unknown | Chờ đối chiếu; không phát lại effect nguy hiểm theo phỏng đoán | 0 lần phát lại mù | Không |
- **FR-020**: Hệ thống MUST áp dụng thang nâng cấp của SPEC.md §9.3: xét nâng sau hai thất bại liên tiếp
  cùng chữ ký ở cùng nấc; tối đa 3 lần thử chất lượng mỗi nấc; nấc theo (task, step) chỉ tăng hoặc giữ;
  sàn task chỉ tăng và không vượt nấc cuối của role.
- **FR-021**: Attempt MUST NOT bắt đầu khi không đủ ngân sách. Ở nấc `needs_approval`, attempt MUST NOT bắt
  đầu khi chưa có approval hợp lệ gắn đúng task/revision, step, nấc và policy hash; nấc `auto` không chờ
  duyệt; nấc `denied` không dùng được kể cả khi có approval thường.
- **FR-022**: Ngân sách MUST phân biệt phần **giữ chỗ** và phần **đã dùng**:
  - Phần cấp cho một attempt MUST được ghi là giữ chỗ trước khi yêu cầu khởi chạy, và tính vào phần
    không còn khả dụng.
  - Khi xác nhận agent đã thật sự được gọi (kể cả repair, resume, decider và lượt bị rate limit), giữ chỗ
    chuyển thành đã dùng và tính vào trần lượt agent.
  - Khi chắc chắn agent chưa chạy (ví dụ effect khởi chạy bị vô hiệu hoá trước khi dispatch), giữ chỗ
    MUST được trả lại.
  - Khi chưa rõ agent đã chạy hay chưa (kết quả `unknown`), giữ chỗ MUST được giữ nguyên cho tới khi đối
    chiếu xong; không trả lại theo phỏng đoán.
- **FR-023**: Hết thang, hết lượt, hết ngân sách hoặc hết thời hạn task MUST chuyển task sang chờ quyết
  định của người dùng; hệ thống không tự gia hạn.
- **FR-024**: Usage MUST mang nhãn `reported`, `estimated` hoặc `unavailable`; không ghi 0 thay cho dữ
  liệu thiếu.

**Kho trạng thái**

- **FR-025**: Mỗi tín hiệu MUST được chấp nhận trong một lần ghi nguyên tử gồm kiểm tra trùng, sự kiện,
  trạng thái dẫn xuất, effect và timer; lần ghi không chứa thao tác chờ I/O bên ngoài.
- **FR-026**: Tín hiệu trùng (cùng khoá dedup hoặc cùng request ID và cùng nội dung) MUST NOT tạo thêm hiệu
  ứng logic; cùng request ID với nội dung khác MUST bị từ chối như conflict.
- **FR-027**: Thứ tự sự kiện MUST lấy từ thứ tự ghi nhận đã commit (tăng theo task và có thứ tự toàn cục),
  không suy ra từ ID hay đồng hồ.
- **FR-028**: Lệnh dựa trên phiên bản trạng thái cũ MUST bị từ chối như conflict.
- **FR-029**: Trạng thái dẫn xuất MUST dựng lại được hoàn toàn từ nhật ký sự kiện, và hệ thống MUST cung
  cấp cách đối chiếu trạng thái đang lưu với trạng thái dựng lại.
- **FR-030**: Timer MUST bền, có ID, thời điểm đến hạn và payload; huỷ hoặc tiêu thụ trong cùng lần ghi
  với tín hiệu liên quan và tạo tối đa một tín hiệu logic.
- **FR-031**: Effect MUST có vòng đời ghi được (chờ dispatch, đã bắt đầu, thành công, thất bại, unknown,
  đã vô hiệu hoá) để các feature thực thi sau dùng giao thức "ghi bắt đầu → làm I/O → ghi kết quả".
  Việc chuyển từ "chờ dispatch" sang "đã bắt đầu" MUST kiểm tra effect chưa bị vô hiệu hoá trong cùng
  lần ghi, để một effect bị hủy không thể bắt đầu do tranh chấp thời điểm.
- **FR-032**: Kho MUST chỉ có một bên ghi tại một thời điểm và từ chối bên ghi thứ hai.
- **FR-033**: Khi không ghi được, hệ thống MUST trả lỗi rõ ràng và MUST NOT báo đã lưu trạng thái mới.

**Giải thích và bằng chứng**

- **FR-034**: Hệ thống MUST trả lời giải thích trạng thái task (vị trí, lý do chờ, điều kiện tiếp tục,
  nấc/binding đã dùng, giới hạn còn lại, lịch sử nâng nấc) chỉ từ dữ liệu đã ghi, không gọi LLM.
- **FR-035**: Mỗi bất biến I01–I12 thuộc phạm vi feature này MUST có bằng chứng kiểm thử ở tầng thực sự
  kiểm chứng được nó (xem bảng dưới); bất biến chưa thuộc phạm vi MUST được ghi là chưa có bằng chứng,
  không được báo là đạt.

### Bằng chứng theo bất biến

| Bất biến | Phạm vi trong feature này | Tầng bằng chứng |
|---|---|---|
| I01 Quyết định tất định | Đầy đủ | Kiểm thử thuộc tính trên lõi quyết định |
| I02 Một bên ghi | Ở mức kho | Kiểm thử tích hợp trên kho thật |
| I03 Ghi nguyên tử, effect sau commit | Phần ghi nguyên tử | Kiểm thử tích hợp có ngắt tiến trình |
| I04 Khoá idempotency | Sinh khoá và chặn trùng | Thuộc tính + tích hợp kho; probe để feature sau |
| I05 Worktree riêng, tuần tự | Ngoài phạm vi | Chưa có bằng chứng |
| I06 Bằng chứng, không phải lời agent | Ở mức quyết định | Kiểm thử thuộc tính |
| I07 Mọi thứ có giới hạn | Ở mức quyết định | Kiểm thử thuộc tính |
| I08 Bất biến theo revision | Chính sách và ngữ cảnh thực thi đóng băng, amendment | Thuộc tính + tích hợp kho |
| I09 Role, binding, approval, ngân sách | Ở mức quyết định | Kiểm thử thuộc tính |
| I10 Thứ tự sự kiện, trigger lặp | Đầy đủ | Thuộc tính + tích hợp kho |
| I11 Điều kiện merge | Ở mức quyết định | Kiểm thử thuộc tính; thực thi để feature sau |
| I12 Kết thúc không mở lại | Đầy đủ | Thuộc tính + tích hợp kho |

### Key Entities *(include if feature involves data)*

- **Project**: repo được cho phép, branch base/protected, cấu hình gate/setup đã khai báo.
- **Task**: yêu cầu chuẩn, revision, trạng thái, lý do chờ, dependency, liên kết tới chính sách đóng băng
  và task nguồn (khi retry).
- **Chính sách đóng băng (FrozenPolicy)**: workflow đã mở rộng, binding và thang theo bước, quyền, gate,
  giới hạn, chế độ quyết định, hash; bất biến theo revision.
- **Ngữ cảnh thực thi đóng băng (FrozenExecutionContext)**: yêu cầu, acceptance, bản chụp nội dung đính
  kèm kèm hash, prompt/conventions, `base_sha`; tạo cùng lần ghi với chính sách đóng băng, cùng revision.
- **Ngữ cảnh quyền**: actor và quyền (`read`/`operate`/`admin`) đã được tầng dịch vụ xác thực; tiền điều
  kiện cho amendment và các thao tác quản trị.
- **Step / Attempt**: bước trong workflow và một lần thực thi bước đó với binding, nấc, kết quả, usage.
- **Sự kiện miền**: bất biến, có schema version, task/revision, thứ tự, actor, nguyên nhân, payload.
- **Tín hiệu (Trigger)**: đầu vào làm lõi quyết định chạy, có khoá dedup.
- **Effect**: yêu cầu I/O bền với khoá idempotency và vòng đời trạng thái.
- **Timer**: điều kiện đánh thức bền với thời điểm đến hạn.
- **Câu hỏi / Quyết định / Approval**: nội dung, người quyết, phạm vi hiệu lực, trạng thái thu hồi.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% cấu hình trong bộ mẫu không hợp lệ (bao phủ mỗi kiểm tra ở FR-002 và FR-003 ít nhất
  một lần) bị từ chối với vị trí lỗi đúng file, dòng và cột.
- **SC-002**: Kiểm tra một cấu hình cỡ thông thường (dưới 500 dòng) cho kết quả trong dưới 1 giây.
- **SC-003**: Ít nhất 10.000 chuỗi tín hiệu sinh ngẫu nhiên chạy qua lõi quyết định và kho mà không vi
  phạm bất biến nào trong phạm vi (bảng bằng chứng), không vượt lượt, không dùng binding ngoài chính sách
  và không bỏ qua approval; mọi lỗi tìm được có seed để tái hiện.
- **SC-004**: Phát lại cùng chuỗi tín hiệu cho kết quả giống hệt nhau ở 100% lần chạy.
- **SC-005**: Ít nhất 200 lần ngắt tiến trình tại điểm ngẫu nhiên trong lúc ghi; sau mỗi lần, 100% tín
  hiệu đã commit được giữ, không có ghi một nửa, và trạng thái dựng lại từ nhật ký khớp 100%.
- **SC-006**: 100% task đang chờ trong mọi kịch bản kiểm thử có lý do, điều kiện tiếp tục và đường kết
  thúc truy vấn được.
- **SC-007**: Gửi lại mỗi tín hiệu từ 2 đến 5 lần không làm thay đổi số sự kiện, effect hay timer so với
  gửi một lần.
- **SC-008**: Báo cáo nghiệm thu của feature liệt kê đủ 12 bất biến, mỗi bất biến được gắn "có bằng
  chứng" kèm tên bộ kiểm thử, hoặc "chưa thuộc phạm vi"; không bất biến nào bị bỏ trống.

## Assumptions

- Feature này không có daemon, socket hay lệnh CLI cho người dùng cuối; năng lực được dùng qua giao diện
  lập trình và một bộ mô phỏng/phát lại tín hiệu phục vụ kiểm thử. CLI và daemon thuộc các feature sau.
- Kết quả của agent, gate, review, CI và effect bên ngoài được cung cấp dưới dạng tín hiệu ghi sẵn; việc
  kiểm tra schema thật của output agent và probe hệ thống bên ngoài thuộc feature runner và recovery.
- Decider (các chế độ `agent`, `agent_if_confident`, `agent_review`: khi nào gọi, khi nào chấp nhận,
  khi nào chờ người, cách lật lại quyết định) là một feature riêng có kịch bản nghiệm thu đầy đủ.
- Chỉ có workflow phát triển phần mềm mặc định được mô hình hoá; workflow khác có thể khai báo nhưng chỉ
  được kiểm chứng qua bộ kiểm tra cấu hình.
- Nhóm task/epic, task tích hợp, scheduler với resource pool và hàng đợi merge được ghi nhận ở mức dữ liệu
  khi cần cho quyết định, nhưng lập lịch thực tế thuộc feature sau.
- Môi trường là một người dùng trên Linux/Ubuntu hoặc WSL2 với dữ liệu trên filesystem Linux cục bộ, như
  SPEC.md §2.1.
- Stack kỹ thuật theo baseline của SPEC.md §17 và hiến chương; spec này không chọn lại công nghệ.
- Ngưỡng 10.000 chuỗi và 200 lần ngắt lấy từ Reliability Gate R4 và R1 của SPEC.md §18.1, áp ở tầng lõi
  và kho. Đạt các ngưỡng này ở đây chưa phải là đạt R1/R4 cho v1, vì R1 yêu cầu kill daemon thật.
