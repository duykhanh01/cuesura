# Feature Specification: Deputy và goal, từ yêu cầu tới PR xanh không cần người giữa chừng

**Feature Branch**: `007/deputy`

**Created**: 2026-11-08 | **Viết lại**: 2026-11-09

**Status**: Draft

**Input**: User description: "Deputy: agent làm thay owner (nhận việc, gỡ rối, quyết ngân sách), thay decider hiện tại."
Bản 2026-11-08 cho mỗi task một phiên deputy sống lâu. Bản này viết lại theo phản biện độc lập (Gemini, ChatGPT) và
quyết định của chủ dự án ngày 2026-11-09 (mục Clarifications): deputy là một vai trò với các lượt ngắn, trí nhớ nằm
trong SQLite, và feature gồm cả goal nhiều task.

## Bối cảnh và phạm vi

Mục tiêu gốc của Cuesura là chủ dự án quyết định ít nhất có thể: spec đã rõ thì task phải đi tới PR mà không cần người.
Thực tế, khi chạy qua đêm, task vẫn dừng ở những chỗ cần **phán đoán**: hết lượt thử ở mọi nấc, reviewer và fixer đẩy
qua lại cùng một finding, hết ngân sách hay deadline, worker hỏi về spec. Một feature nhiều bước còn dừng ở mỗi lần
merge, vì task sau chỉ bắt đầu khi task trước đã merge vào nhánh gốc. Sáng ra chủ dự án phải gỡ từng chỗ.

Feature này giải ba mục tiêu cùng lúc:

1. **Context và token:** không phình theo thời gian hay số task, không điều tra lại thứ đã điều tra.
2. **Hiệu quả:** song song tối đa khi an toàn, tự phát hiện và phá vòng lặp vô ích, biết khi nào nâng model, nới giới
   hạn hay dừng.
3. **Trải nghiệm:** giao một task nhỏ hoặc cả feature, duyệt kế hoạch một lần, trao đổi qua bất kỳ phiên trợ lý nào.

Năm quyết định nền:

1. **Engine vẫn tất định.** Mọi chuyển trạng thái và dispatch do code quyết
   ([constitution](../../.specify/memory/constitution.md) I). Deputy chỉ được gọi ở ranh giới (task vào wait, goal cần
   kế hoạch) và chỉ hành động qua lệnh `cusr`, cùng kiểm tra quyền, version và chống lặp như trợ lý.
2. **Deputy là vai trò, không phải phiên.** Mỗi sự cố mở một **lượt** ngắn: phiên harness mới, bắt đầu từ context nhỏ
   do code dựng từ **sổ goal**, đọc thêm log hay diff khi cần, và kết thúc bằng **bàn giao** có cấu trúc. Không có
   process hay phiên nào sống giữa các lượt.
3. **Sổ goal là view, không phải nguồn sự thật thứ hai.** Nó được dựng từ event, command ledger, aggregate goal và bản
   ghi lượt đã có. Chỉ lệnh tường minh ghi vào đó; trò chuyện với trợ lý thì không.
4. **Trần là điểm đánh giá lại, không phải điểm dừng.** Hết trần thì deputy chẩn đoán và chọn hành động; code chặn
   việc lặp lại cùng hành động khi không có bằng chứng mới, nên chính deputy cũng không lặp được.
5. **Goal là đơn vị giao việc.** Một task nhỏ là goal một đơn vị, chạy đúng như task hôm nay. Feature nhiều bước là goal
   nhiều đơn vị: kế hoạch duyệt một lần, mỗi đơn vị là một task thường với worktree, gate và review riêng, PR của nó
   merge vào **nhánh goal**, và cả goal ra một PR vào nhánh gốc cho chủ dự án merge.

**Ngoài phạm vi:**

- Đường auto-merge mới vào nhánh gốc hay protected branch (yolo do chủ dự án bật giữ nguyên). Deputy không merge; code merge PR đơn vị vào nhánh goal
  ([constitution](../../.specify/memory/constitution.md) V).
- Bật yolo, nhận PR có sẵn và mọi quyền `admin` khác cho deputy.
- Kênh nhận việc từ GitHub issue hay Telegram (feature 005). Feature này chỉ quy định kênh đó tạo goal (FR-079).
- Thông báo do deputy tự viết qua Telegram. Tin trạng thái vẫn do daemon dựng từ event.
- Thu gọn context của harness cho worker.
- Proxy nén context hay bất kỳ dependency, process thường trực hay công cụ cài thêm nào.

## Clarifications

### Session 2026-11-08 (thảo luận với chủ dự án, còn hiệu lực)

- Q: Headless hay phiên native? → A: Native: lượt chạy phiên tương tác trong terminal backend khi có, không có thì
  headless; phiên treo thì tiếp tục headless.
- Q: Deputy luôn bật hay chỉ khi bật `autonomous`? → A: Luôn bật với chỗ kẹt về vận hành. Câu hỏi về spec của worker
  theo cờ `autonomous`.
- Q: Quyền ghi của deputy? → A: Toàn quyền của harness; thay đổi trong worktree của task bị trả về sau lượt như reviewer.
  Muốn đổi code thì giao cho worker.
- Q: Deputy và người cùng gỡ một task? → A: Người luôn thắng; lệnh cũ của deputy bị từ chối theo version.
- Q: Deputy có thay decider không? → A: Thay hẳn.
- Q: Bảng định tuyến, `task fail`, mở rộng `continue`/`amend-policy`, `amend-policy` cho `operate`, `reason` trên mọi
  lệnh ghi, mốc và trả về worktree, lỗi của lượt: giữ như phiên chất vấn ngày 2026-11-08.

### Session 2026-11-09 (phản biện độc lập và quyết định của chủ dự án)

- Q: Một phiên deputy sống lâu cho mỗi task? → A: Không. Context của phiên đó lớn dần theo mỗi sự cố, resume sau khi
  prompt cache hết hạn phải đọc lại cả transcript, không thấy các task khác, và chỉ phiên đó đọc được trí nhớ của nó.
  Thay bằng lượt ngắn cho mỗi sự cố cộng sổ goal trong SQLite. Trong một lượt (chờ hết rate limit, lỗi hạ tầng, phiên
  treo) thì resume cùng phiên harness.
- Q: Goal nhiều task làm trong feature này hay tách sau? → A: Làm trọn trong feature này. Có thể chia lát nội bộ, nhưng
  không giảm phạm vi.
- Q: Gom sự cố theo goal, chờ 10–15 giây cho đủ mẻ? → A: Không. Lượt theo task, chạy song song. Race giải bằng version
  của task và version kế hoạch, không bằng debounce.
- Q: Trần cứng số lần deputy can thiệp? → A: Không có trần tổng. Code áp ba luật chống lặp (FR-042–FR-044).
- Q: Deputy được miễn đến đâu? → A: Một finding review, một gate hoặc một check CI cụ thể, kèm bằng chứng, gắn chữ ký
  lỗi, liệt kê trong PR, báo là miễn chứ không phải đạt. Không áp cho required check của protected branch.
- Q: Goal nhiều task ra PR thế nào? → A: Một PR cho cả goal vào nhánh gốc. PR của từng đơn vị merge vào nhánh goal bằng
  merge commit, để chủ dự án review được theo từng đơn vị. Không thêm đường auto-merge nào vào nhánh gốc; yolo do chủ dự án bật vẫn áp như hiện nay.
- Q: Task sau có chờ task trước merge vào nhánh gốc không? → A: Không. Task sau bắt đầu khi task trước đã merge vào
  nhánh goal. Hiện nay worktree của task phụ thuộc tạo từ đỉnh `base_branch` sau khi task trước DONE
  (`src/application/dependency.ts`, `src/adapters/git/worktree.ts`); đặt `base_branch` của đơn vị là nhánh goal là đủ.
- Q: Duyệt kế hoạch một lần có trái tinh thần "chủ dự án xem mọi task" không? → A: Không, nếu kế hoạch hiện đủ mục
  tiêu, phạm vi, đơn vị, phụ thuộc, tiêu chí nghiệm thu và phần chạy song song, có version và hash. Đổi phạm vi phải
  duyệt lại.
- Q: Chỉ thị từ nhiều phiên trợ lý có cần lease không? → A: Cần. Lease cho biết tin của goal gửi về đâu, nên lệnh ghi
  lên goal từ trợ lý phải đến từ phiên đang giữ lease.
- Q: Phối hợp giữa các goal? → A: Engine lo, không gọi LLM: phụ thuộc, slot, scope guard toàn project đã có (#240),
  scope bắt buộc với đơn vị của goal nhiều đơn vị, và kiểm xung đột thật bằng `git merge-tree`. Deputy chỉ tham gia khi
  chính kế hoạch phải đổi.
- Q: Deputy và decider quyết mâu thuẫn? → A: Không còn decider. Câu hỏi của worker là một loại sự cố của deputy; câu
  trả lời là quan sát của deputy trong sổ, không phải chỉ thị của người.
- Q: Context của lượt có trần cứng 4k không? → A: Không. Phần do code dựng nhắm 2–4k token theo vùng cố định; deputy
  tự đọc thêm khi quyết định phức tạp.
- Q: Ai viết task từ yêu cầu thô? → A: `goal add` với yêu cầu nguyên văn; deputy lập kế hoạch (một hay nhiều đơn vị),
  người duyệt một lần. Trợ lý vẫn giao task trực tiếp bằng `task add` như hiện nay. `task add --draft` của bản trước bị
  bỏ.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Task kẹt được gỡ mà không chờ chủ dự án (Priority: P1)

Chủ dự án xếp việc rồi đi ngủ. Một task hết lượt thử ở nấc cuối, một task hết lượt vào step `ci`, một task gặp
`effect_unknown` kéo dài. Mỗi sự cố mở một lượt deputy: nó đọc context do code dựng, đọc thêm log hay diff khi cần,
chọn cách đi tiếp, thực hiện bằng `cusr`, rồi để lại bàn giao. Sáng ra chủ dự án thấy PR và danh sách quyết định, không
phải danh sách chỗ kẹt.

**Why this priority**: Lý do tồn tại của feature.

**Independent Test**: Với harness fake, đưa task vào từng mã wait mà FR-001 giao cho deputy; deputy fake gọi lệnh gỡ và
`deputy handoff`; task chạy tiếp mà không có mục attention nào tới chủ dự án.

**Acceptance Scenarios**:

1. **Given** task vào một wait mà FR-001 giao cho deputy, **When** engine vào wait, **Then** một lượt deputy mới bắt đầu
   với sự cố đó và trợ lý không được đánh thức cho sự cố đó.
2. **Given** task ở wait mà FR-001 giao cho người (`merge`, `auth_config`, `refused`, vi phạm ranh giới…), **When** engine
   vào wait, **Then** không có lượt deputy và sự cố tới chủ dự án như hiện nay.
3. **Given** lượt kết thúc mà task vẫn ở đúng wait đó, **When** daemon thấy lượt hết, **Then** sự cố chuyển cho chủ dự
   án kèm bàn giao và tin nhắn cuối của deputy.
4. **Given** lượt kết thúc không có bàn giao, **When** daemon ghi kết quả lượt, **Then** lượt được ghi `aborted` kèm danh
   sách lệnh nó đã chạy, và lượt sau thấy bản ghi đó trong context.
5. **Given** task đã qua nhiều lượt deputy, **When** sự cố mới tới, **Then** context của lượt mới có kích thước cùng cỡ
   với lượt đầu (FR-061).

---

### User Story 2 - Trần là điểm đánh giá lại; deputy phá vòng lặp thay vì retry thêm (Priority: P1)

Task hết lượt fixer vì reviewer và fixer đẩy qua lại cùng một finding. Code đã tính sẵn tín hiệu vòng lặp: finding lặp
qua các vòng review, bản sửa không chạm file mà finding nêu. Deputy xác định nguyên nhân: model không đủ sức, chiến thuật
sai, reviewer sai hay hai bên bất đồng, quy trình Cuesura gây kẹt, giới hạn quá thấp trong khi vẫn có tiến triển, môi
trường ngoài tầm, hay spec không rõ. Rồi nó chọn đúng hành động: nâng model trong mức tối đa chủ dự án cấu hình, đổi chỉ
dẫn, miễn finding có bằng chứng, kích hoạt cơ chế đúng của Cuesura, nới giới hạn, chuyển cho người, hay kết thúc task.
Mỗi lần gia hạn là một thử nghiệm có giả thuyết và tiêu chí. Nếu lần trước không có tiến triển, code không cho lặp lại.

**Why this priority**: Chủ dự án xác định đây là yêu cầu quan trọng nhất: deputy phải phát hiện và phá vòng lặp vô
nghĩa, không chỉ là agent cho retry thêm.

**Independent Test**: Đưa task vào từng wait cạn trần với lịch sử dựng sẵn (finding lặp, cây quay về trạng thái cũ, cùng
chữ ký lỗi qua hai model). Deputy fake thử lần lượt các hành động; kiểm tra lệnh lặp không có bằng chứng mới bị từ chối,
mỗi loại tự cạn, và cạn hết thì chỉ còn `task fail` hay `handover`.

**Acceptance Scenarios**:

1. **Given** task ở `loop_exhausted` với tín hiệu "finding lặp", **When** deputy mở lượt, **Then** context có bảng tín
   hiệu vòng lặp và bảng các lần thử trên chữ ký lỗi hiện tại.
2. **Given** deputy đã `continue` một lần trên chữ ký S và sau đó chữ ký vẫn là S, không có tiến triển đo được, **When**
   deputy `continue` lần nữa, **Then** lệnh bị từ chối `repeat_without_evidence`.
3. **Given** model đang chạy đã là model cao nhất trong `allow_models`, **When** deputy nâng model, **Then** lệnh bị từ
   chối; nó vẫn hạ hay đổi sang model khác chưa thử trên chữ ký đó được.
4. **Given** deputy miễn finding F có bằng chứng, **When** mọi finding chặn còn lại đều đã được miễn, **Then** review được
   coi là approve kèm bản miễn, PR liệt kê bản miễn, và report ghi "miễn", không ghi "đạt".
5. **Given** mọi loại hành động đã cạn trên chữ ký S, **When** lượt kết thúc mà deputy không `task fail` hay `handover`,
   **Then** code kết thúc task (PR draft nếu có việc chưa publish) với actor `system:loop-guard`.
6. **Given** chủ dự án thêm chỉ thị cho goal sau lần thử cuối, **When** deputy thử lại cùng hành động, **Then** lệnh được
   nhận vì chỉ thị mới là bằng chứng mới.

---

### User Story 3 - Giao cả feature nhiều bước, duyệt một lần, chạy tới PR xanh (Priority: P1)

Chủ dự án bảo trợ lý "làm feature X" rồi đóng phiên. Deputy lập kế hoạch: mục tiêu, phạm vi, các đơn vị với tiêu chí
nghiệm thu và scope, phụ thuộc, run config. Trợ lý hiện kế hoạch kèm các nhóm chạy song song do engine tính. Chủ dự án
duyệt một lần. Engine tạo nhánh goal, chạy các đơn vị độc lập song song, mỗi đơn vị qua đủ coder, gate, review, fixer,
PR vào nhánh goal, CI, rồi code merge vào nhánh goal. Đơn vị phụ thuộc bắt đầu ngay sau khi đơn vị trước vào nhánh goal.
Khi mọi đơn vị xong, task tổng chạy gate, review toàn bộ diff, CI, và mở PR của goal vào nhánh gốc. Sáng ra chủ dự án
thấy một PR xanh, review theo từng merge commit, rồi merge.

**Why this priority**: Không có phần này, chuỗi task qua đêm dừng ở mỗi lần merge, và chủ dự án phải ngồi giao từng
bước.

**Independent Test**: Với harness fake và remote git giả, tạo goal ba đơn vị (A, B độc lập; C phụ thuộc A, B), duyệt kế
hoạch; kiểm tra A và B chạy song song, C bắt đầu sau khi A và B vào nhánh goal, nhánh goal có đúng ba merge commit trên
first-parent, task tổng mở PR vào nhánh gốc, và không có lệnh nào của người giữa lúc duyệt và lúc PR sẵn sàng.

**Acceptance Scenarios**:

1. **Given** trợ lý giữ lease gọi `goal add` với yêu cầu nguyên văn, **When** daemon nhận lệnh, **Then** goal ở trạng thái
   `planning`, một lượt deputy loại `plan` bắt đầu, và yêu cầu được lưu nguyên văn.
2. **Given** deputy gửi kế hoạch hợp lệ, **When** kế hoạch được ghi, **Then** goal ở `awaiting_confirm`, `goal show` hiện
   mục tiêu, phạm vi, đơn vị, phụ thuộc, tiêu chí nghiệm thu, các nhóm song song, version và hash, và tin "kế hoạch chờ
   duyệt" tới phiên giữ lease.
3. **Given** chủ dự án duyệt bằng đúng hash, **When** daemon nhận lệnh, **Then** mọi đơn vị thành task đã xác nhận intake
   và run config, nhánh goal được tạo từ đỉnh nhánh gốc, và task tổng được tạo phụ thuộc vào mọi đơn vị.
4. **Given** kế hoạch đã đổi sau khi chủ dự án đọc, **When** chủ dự án duyệt bằng hash cũ, **Then** lệnh bị từ chối với
   conflict và hash hiện hành.
5. **Given** PR của một đơn vị đạt gate, review theo chế độ, CI, và đã chứa đỉnh hiện tại của nhánh goal, **When** tới
   bước merge, **Then** code merge PR vào nhánh goal bằng merge commit, không chờ người.
6. **Given** nhánh goal vừa có đơn vị khác merge vào, **When** đơn vị đang mở PR tới bước merge, **Then** nó cập nhật
   base theo cơ chế hiện có, chạy lại gate và CI trên kết quả, rồi mới merge.
7. **Given** mọi đơn vị đã DONE, **When** task tổng chạy, **Then** reviewer nhận toàn bộ diff của nhánh goal so với nhánh
   gốc cùng kế hoạch và tiêu chí nghiệm thu, PR của goal liệt kê các đơn vị, merge commit, bản miễn và quyết định của
   deputy, và merge vẫn do người.
8. **Given** goal chỉ có một đơn vị, **When** kế hoạch được duyệt, **Then** không có nhánh goal hay task tổng, và đơn vị
   chạy, mở PR vào nhánh gốc như task hôm nay.
9. **Given** deputy muốn thêm đơn vị hay đổi tiêu chí nghiệm thu, **When** nó gửi sửa kế hoạch, **Then** sửa đổi chờ chủ
   dự án duyệt; đơn vị không bị sửa đổi chạm tới vẫn chạy tiếp.

---

### User Story 4 - Song song tối đa khi an toàn, xuyên goal (Priority: P2)

Chủ dự án có hai goal chạy cùng đêm. Đơn vị độc lập của cả hai chạy song song tới hết slot. Đơn vị có scope chồng với
task đang chạy ở goal khác thì chờ. Hai nhánh đang chạy xung đột thật thì engine thấy và đưa vào context của deputy khi
có sự cố, không cần LLM điều phối. Một lượt deputy ở goal này không làm đơn vị nào của goal khác chờ.

**Why this priority**: Hiệu quả qua đêm phụ thuộc vào song song, nhưng nền scheduler đã có (#240).

**Independent Test**: Scheduler test với hai goal, scope rời và scope chồng; kiểm tra thứ tự dispatch, và một lượt
deputy đang chạy không đổi kết quả dispatch.

**Acceptance Scenarios**:

1. **Given** hai đơn vị không phụ thuộc, scope rời, còn slot, **When** scheduler chạy, **Then** cả hai bắt đầu trong cùng
   vòng.
2. **Given** đơn vị U của goal G2 có scope chồng với file đã đổi của task đang chạy ở goal G1, **When** scheduler chạy,
   **Then** U chờ theo scope guard hiện có, và tự bắt đầu khi task kia rời slot.
3. **Given** một đơn vị đang có lượt deputy, **When** scheduler chạy, **Then** các đơn vị khác của cùng goal và goal khác
   vẫn được dispatch như khi không có lượt.
4. **Given** checkpoint của hai nhánh đang chạy trong cùng project xung đột theo `git merge-tree`, **When** một trong hai
   có sự cố, **Then** context của lượt có thông tin xung đột đó, và `goal show` hiện nó.

---

### User Story 5 - Trao đổi từ bất kỳ phiên trợ lý nào (Priority: P2)

Chủ dự án giao goal trong Claude Code, tối đó hỏi tiến độ trong Codex, hôm sau bổ sung chỉ thị trong Pi. Mọi phiên đọc
được trạng thái chung. Phiên muốn ghi lên goal thì lấy lease, và tin của goal sau đó về phiên đó. Đóng phiên thì hệ
thống vẫn chạy. Chuyện trò linh tinh trong phiên không vào sổ goal.

**Why this priority**: Trải nghiệm là một trong ba mục tiêu, và tận dụng cơ chế lease đã có.

**Independent Test**: Hai phiên trợ lý giả: phiên không giữ lease đọc `goal show` được nhưng `goal note` bị từ chối kèm
hướng dẫn lấy lease; sau `assistant register --take`, ghi được và tin "kế hoạch chờ duyệt" tới phiên đó.

**Acceptance Scenarios**:

1. **Given** phiên không giữ lease, **When** gọi `goal show`, `goal list`, `task show`, `report`, **Then** đọc được.
2. **Given** phiên không giữ lease, **When** gọi `goal add`, `goal note`, `goal confirm`, `goal revise` hay `goal cancel`,
   **Then** bị từ chối `lease_required` kèm lệnh lấy lease.
3. **Given** phiên giữ lease ghi chỉ thị, **When** lượt deputy sau của goal bắt đầu, **Then** chỉ thị nằm trong vùng ổn
   định của context, được đánh dấu là chỉ thị của chủ dự án.
4. **Given** mọi phiên trợ lý đã đóng, **When** goal chạy tiếp, **Then** không có gì chờ phiên trợ lý; tin dồn lại cho
   phiên lấy lease sau.

---

### User Story 6 - Chủ dự án và deputy cùng thao tác; race, crash và khôi phục (Priority: P2)

Deputy đang suy luận thì chủ dự án đổi yêu cầu hay gỡ đúng task đó. Hai lượt của hai đơn vị cùng muốn sửa phụ thuộc.
Daemon crash giữa lượt. Thao tác của người luôn thắng, chỉ một trong hai sửa kế hoạch được nhận, và không lệnh nào bị
lặp sau restart.

**Why this priority**: Deputy luôn bật, nên hai bên cùng chạm một task hay một kế hoạch là bình thường.

**Independent Test**: Crash injection và lệnh xen kẽ trên harness fake; kiểm tra version, plan version, request ID và
việc mở lại sự cố sau restart.

**Acceptance Scenarios**:

1. **Given** deputy đang trong lượt, **When** chủ dự án trả lời câu hỏi hay `continue` task, **Then** lệnh của chủ dự án
   được nhận, lệnh tiếp theo của deputy với version cũ bị từ chối với conflict.
2. **Given** chủ dự án `goal revise` trong lúc lượt `plan` đang chạy, **When** deputy gửi kế hoạch với plan version cũ,
   **Then** lệnh bị từ chối và một lượt `plan` mới bắt đầu với yêu cầu đã sửa.
3. **Given** hai lượt cùng gửi sửa kế hoạch với cùng plan version, **When** daemon nhận lần lượt, **Then** chỉ lệnh đầu
   được nhận.
4. **Given** daemon crash sau khi lệnh của deputy được nhận nhưng trước khi lượt kết thúc, **When** daemon khởi động lại
   và deputy gửi lại cùng request ID, **Then** kết quả cũ được trả lại, không có event mới.
5. **Given** daemon khởi động lại khi một lượt đang chạy, **When** sự cố vẫn ở đúng wait đó, **Then** lượt được nhận lại,
   không có lượt thứ hai; nếu task đã rời wait đó thì lượt được đóng, không mở lại sự cố.

---

### User Story 7 - Câu hỏi về spec của worker theo cờ `autonomous` (Priority: P2)

Worker dừng vì câu hỏi về yêu cầu hay thiết kế. Khi `autonomous` bật, deputy trả lời theo spec, kế hoạch và quy ước của
repo, ghi giả định; giả định hiện trong mô tả PR. Khi tắt, câu hỏi tới chủ dự án như hiện nay.

**Why this priority**: Chủ dự án muốn tự giữ quyền chọn ở chỗ này khi cần, nên tách thành cờ riêng.

**Independent Test**: Tạo `agent_question` với `autonomous` tắt rồi bật; kiểm tra câu hỏi được định tuyến lại, deputy
trả lời, và mục giả định trong mô tả PR.

**Acceptance Scenarios**:

1. **Given** `autonomous` bật, **When** worker hỏi, **Then** deputy trả lời với actor `deputy`, câu hỏi tiếp ở cùng step
   cũng tới deputy, và câu trả lời là quan sát của deputy trong sổ goal.
2. **Given** `autonomous` tắt, **When** worker hỏi, **Then** câu hỏi tới chủ dự án; sự cố vận hành của cùng task vẫn tới
   deputy.
3. **Given** câu hỏi đang chờ người vì `autonomous` tắt, **When** chủ dự án bật cờ, **Then** câu hỏi được định tuyến lại.
4. **Given** deputy đã trả lời câu hỏi về spec, **When** task publish lần kế tiếp, **Then** mô tả PR có mục giả định của
   deputy.

---

### User Story 8 - Xem deputy đã làm gì (Priority: P3)

Sáng ra chủ dự án muốn biết đêm qua deputy quyết gì, vì sao, dựa trên bằng chứng nào, kết quả ra sao, ở những chỗ đã
quen dùng.

**Why this priority**: Cần để tin deputy, nhưng dựng hoàn toàn từ dữ liệu đã có.

**Independent Test**: Sau một loạt quyết định của deputy fake, kiểm tra `decisions.md`, `cusr report`, `goal show`, chi
tiết task và mô tả PR.

**Acceptance Scenarios**:

1. **Given** deputy đã thao tác trên nhiều task, **When** chủ dự án mở `decisions.md`, `cusr report` hay `goal show`,
   **Then** mỗi quyết định có thời điểm, goal, task, sự cố, hành động, lý do, bằng chứng và kết quả.
2. **Given** terminal backend khả dụng, **When** deputy đang trong lượt, **Then** chủ dự án mở được cửa sổ mang tên vai trò
   và tiêu đề task để xem và gõ vào phiên.

### Edge Cases

- **Phiên tương tác treo** ở hộp thoại của harness: hết `stall_ms` không có tín hiệu hết lượt thì daemon dừng process và
  resume cùng phiên ở chế độ headless cho cùng sự cố, trong cùng lượt.
- **Không có terminal backend**: lượt chạy headless ngay từ đầu.
- **Deputy chạm hạn mức, lỗi auth, lỗi hạ tầng**: theo FR-024. Lượt không tính vào số lỗi hay trần nào của task.
- **Daemon restart giữa lượt**: theo FR-056.
- **Hai sự cố liên tiếp của cùng task**: sự cố sau chờ lượt trước kết thúc rồi mở lượt mới; lượt mới thấy bàn giao của
  lượt trước.
- **Task kết thúc** khi deputy đang trong lượt: lượt bị dừng; lệnh muộn bị từ chối vì lượt không còn chạy.
- **Deputy sửa worktree của task**: sau lượt, worktree và HEAD về mốc trước lượt. Trả về thất bại thì xử lý như reviewer.
- **Deputy sửa worktree của task khác**: chỉ có chỉ dẫn vai trò và luật đường dẫn của harness chặn (FR-053). Nếu vẫn xảy
  ra, task kia thấy `worktree_changed`.
- **Đơn vị thất bại** (deputy `task fail`, hay loop guard kết thúc nó): goal vào `replan`; lượt `plan` chỉ có thể sửa chi
  tiết thực thi (ví dụ thử lại đơn vị bằng task mới cùng khóa đơn vị), gửi sửa phạm vi chờ người duyệt, hay chuyển goal
  cho người. Đơn vị phụ thuộc vào nó chờ; đơn vị độc lập vẫn chạy.
- **Nhánh gốc đi tiếp trong lúc goal chạy**: đơn vị không bị ảnh hưởng vì nhắm nhánh goal; task tổng cập nhật base theo
  cơ chế hiện có khi tới bước của nó.
- **Ai đó push tay vào nhánh goal**: nhánh goal chỉ daemon ghi. Đỉnh nhánh goal khác merge commit cuối daemon đã ghi thì
  việc merge vào nhánh goal dừng và goal vào `replan` với lý do `goal_branch_drift`; các đơn vị đang mở PR vẫn chạy tới bước
  merge rồi chờ.
- **Nhánh goal khớp `protected_branches`**: duyệt kế hoạch bị từ chối; tên nhánh goal được chọn để không trùng.
- **Chủ dự án hủy goal**: mọi đơn vị và task tổng bị hủy theo `task cancel`; nhánh goal và PR đơn vị đã merge được giữ.
- **Goal cũ không có kế hoạch** (task tạo trước nâng cấp): mỗi task được coi là goal ẩn một đơn vị.
- **Chưa khai role `deputy`**: mọi chỗ kẹt tới chủ dự án; wait cạn trần được daemon kết thúc bằng `task fail`
  (FR-004); `goal add` vẫn nhận nhưng không mở lượt `plan`, goal chờ trợ lý tự gửi `goal propose`.
- **Nội dung không tin cậy** (output của worker, yêu cầu từ kênh ngoài) chứa chỉ thị: deputy coi là dữ liệu; đây là rủi
  ro chủ dự án chấp nhận.

## Requirements *(mandatory)*

### Functional Requirements

#### Định tuyến tới deputy

- **FR-001**: Hệ thống MUST có một bảng tường minh xếp mỗi mã wait vào đúng một nơi đến, và thiếu một mã MUST làm build
  thất bại:
  - **Tự tiếp tục** (không đánh thức ai): đúng tập mã mà phân loại "cần người" hiện có coi là không cần người
    (`dependency_pending`, `checks_incomplete`, `effect_unknown`, `infra_backoff`, `rate_limited`, `execution_slot`,
    `merge_cleanup_pending`, `observation_unknown`). Riêng `effect_unknown` quá ngưỡng của #249 thì tới deputy.
  - **Tới chủ dự án:** mọi mã PENDING trừ `dependency_pending`; `run_config_unconfirmed`; `paused`;
    `escalation_rejected`; `adopt_approval`; `merge`; `auth_config`; `harness_auth`; `refused`; `plan_amendment`; và
    `effect_failed` có `detail.failure = 'boundary_violation'`.
  - **Câu hỏi của worker** (`agent_question`, `agent_needs_context`, `agent_blocked`): tới deputy khi `autonomous` bật,
    tới chủ dự án khi tắt.
  - **Tới deputy:** mọi mã còn lại.
- **FR-002**: Nơi sinh vi phạm ranh giới MUST ghi `detail.failure = 'boundary_violation'` có cấu trúc.
- **FR-003**: Câu hỏi của worker MUST được định tuyến theo cờ `autonomous` tại lúc định tuyến. Cờ đổi thì câu hỏi đang mở
  MUST được định tuyến lại, trừ câu đang trong lượt và câu đã chuyển cho người.
- **FR-004**: Engine MUST vào wait như hiện nay, kể cả khi hết thang (`ladder_exhausted`) hay gặp nấc bị từ chối
  (`rung_denied`) (**wait cạn trần**). Engine không biết có deputy hay không. Khi không khai role `deputy`, daemon MUST
  kết thúc wait cạn trần bằng `task fail` với actor `system:deputy-absent`, và attention MUST NOT báo cho người trong
  khoảng chờ đó. Khi đã khai, wait cạn trần MUST tới deputy và MUST NOT tự về FAILED trừ theo FR-044. `context_budget` và
  `run_config_unconfirmed` ở cấp step vẫn do engine kết thúc theo #247.
- **FR-005**: Trong lúc deputy có thể xử lý một sự cố, hệ thống MUST NOT đánh thức trợ lý cho sự cố đó.
- **FR-006**: Ngoài sự cố của task, daemon MUST mở lượt deputy loại `plan` khi goal ở `planning` (sau `goal add` hay
  `goal revise`) hoặc `replan` (FR-076).

#### Lượt deputy

- **FR-010**: Mỗi lượt MUST là một phiên harness mới cho đúng một sự cố của task hoặc một sự kiện `plan` của goal. Không
  có phiên deputy sống qua nhiều lượt.
- **FR-011**: Trong một lượt, khi phải chạy lại (chờ hạn mức, lỗi hạ tầng, phiên tương tác treo), daemon MUST resume cùng
  phiên harness của lượt đó cho cùng sự cố.
- **FR-012**: Giữa các lượt MUST NOT có process deputy nào chạy hay lượt gọi model nào.
- **FR-013**: Lượt MUST chạy phiên tương tác của harness trong terminal backend khi có và adapter hỗ trợ, cùng vòng đời
  với worker; không thì headless. Cuesura MUST thêm hook báo hết lượt vào cấu hình phiên, gộp với hook của chủ dự án;
  nhận tín hiệu thì daemon dừng process sau một khoảng ngắn. Hết `stall_ms` không có tín hiệu thì theo FR-011 ở chế độ
  headless.
- **FR-014**: Mỗi task MUST có tối đa một lượt chạy cùng lúc; mỗi goal tối đa một lượt `plan` cùng lúc. Lượt của các
  task khác nhau, cùng goal hay khác goal, MUST chạy song song được.
- **FR-015**: Binding MUST được đọc lại mỗi lượt từ role `deputy`. Model của lượt MUST nằm trong `allow_models`.
- **FR-016**: Lượt MUST đọc được chi tiết task và goal, lịch sử, log, diff, gate log và tài liệu repo qua `cusr` và
  filesystem.
- **FR-017**: Trước mỗi lượt có worktree, daemon MUST ghi bền mốc (HEAD và cây checkpoint) của worktree, và sau lượt, kể cả
  sau restart, MUST trả worktree về mốc đó bằng cơ chế của reviewer. Trong lúc lượt chạy và cho tới khi trả về xong,
  scheduler MUST NOT dispatch effect nào ghi vào worktree của chính task đó (lệnh `continue` hay câu trả lời của deputy
  chỉ có hiệu lực sau khi trả về); điều kiện chặn đọc từ `deputy_turns` nên còn nguyên sau restart. Task khác không bị
  chặn.
- **FR-018**: Lượt kết thúc khi harness báo hết lượt, process thoát, hoặc task kết thúc. Task kết thúc giữa lượt thì
  daemon dừng lượt; lệnh muộn bị từ chối theo FR-051.

#### Sự cố, bàn giao và chuyển cho người

- **FR-020**: Một sự cố MUST là một lần vào wait cụ thể: task, revision, mã wait và sequence của event vào wait đó.
- **FR-021**: Mỗi lượt MUST kết thúc bằng một bàn giao có cấu trúc (`cusr deputy handoff`): `cause` (một giá trị của bảng
  nguyên nhân FR-041), `decision`, `ruled_out` (các giả thuyết hay hướng đã loại và lý do), `next_look` (lượt sau nên xem
  gì nếu việc này vẫn hỏng). Chỉ bàn giao cuối của lượt có hiệu lực.
- **FR-022**: Lượt kết thúc không có bàn giao MUST được ghi `aborted` kèm danh sách lệnh nó đã chạy (từ command ledger
  theo ID lượt) và tin nhắn cuối; lượt sau thấy bản ghi đó như một bàn giao.
- **FR-023**: Khi lượt kết thúc mà task vẫn ở đúng sự cố đó, hệ thống MUST chuyển sự cố cho chủ dự án như hiện nay, kèm
  bàn giao (hoặc bản ghi `aborted`) và tin nhắn cuối, trừ khi FR-044 kết thúc task.
- **FR-024**: Lỗi của lượt MUST xử lý như sau và MUST NOT tính vào bộ đếm lỗi hay trần nào của task: (a) hạn mức hay quá
  tải: chờ `reset_at`, xoay tài khoản theo account pool, sự cố vẫn thuộc deputy; (b) auth, refusal, thiếu capability
  hay harness: chuyển cho chủ dự án ngay, ghi lý do; (c) lỗi hạ tầng hay process: retry cùng lượt theo
  `limits.backoff.infra` đã đóng băng của task, không trần trừ khi `roles.deputy.limits.infra_retries` được khai. Wall
  time của lượt là tùy chọn, mặc định không có.
- **FR-025**: Bản ghi lượt và việc chuyển cho người MUST bền qua restart, MUST nằm ngoài event log có version của task, và
  MUST NOT làm đổi version của task hay goal.
- **FR-026**: Chi tiết task và goal MUST cho thấy lượt đang chạy: sự cố, loại, từ lúc nào.

#### Hành động của deputy

- **FR-030**: `task continue` và `task amend-policy` MUST nhận thêm các wait `agent_runs_exhausted`,
  `agent_runs_insufficient`, `deadline`, `backoff_exhausted`, `ci_wait_exhausted`. `continue` trên `backoff_exhausted`
  reset bộ đếm lỗi của lớp đó ở step; trên `ci_wait_exhausted` mở một cửa sổ chờ CI mới với độ dài đã đóng băng.
- **FR-031**: `task amend-policy` MUST có `--agent-runs +N` và `--deadline <thời điểm|+khoảng>`, ghi `PolicyAmended` kèm
  actor và lý do. Quyền áp dụng MUST hạ từ `admin` xuống `operate`. `allow_models`, `above: deny` và approval theo tier
  vẫn ràng buộc.
- **FR-032**: Lệnh `operate` mới `task fail <id> --reason` MUST kết thúc task WAITING theo đường của #247 (PR draft nếu có
  việc chưa publish, rồi FAILED). `--reason` bắt buộc với mọi actor.
- **FR-033**: Lệnh `operate` mới `task waive` MUST ghi một bản miễn theo FR-045.
- **FR-034**: Bảng quyền của deputy MUST liệt kê đúng các lệnh nó được dùng: trả lời câu hỏi, `continue`, `recheck`, duyệt
  escalation, `amend-policy`, `message`, `pause`/`resume`, `task fail`, `task waive`, `goal propose`, `goal amend`,
  `goal note`, `deputy handoff`, và mọi lệnh đọc. Mọi lệnh khác của actor `deputy` MUST bị từ chối, kể cả `task confirm`,
  `goal confirm`, `task cancel`, `goal cancel`, merge, yolo, adopt và quyền `admin`.
- **FR-035**: Vai trò của deputy MUST yêu cầu nó không làm ngược thao tác của chủ dự án hay trợ lý trong cùng revision.

#### Vòng lặp, chống lặp và bản miễn

- **FR-040**: Code MUST tính **tín hiệu vòng lặp** của task từ dữ liệu đã ghi, không gọi model: finding lặp qua các vòng
  review (cùng khóa finding còn mở sau ít nhất hai vòng sửa); bản sửa không chạm file mà finding nêu; cây checkpoint quay
  về một cây đã có; cùng chữ ký lỗi gate hay CI qua các attempt với cây khác nhau; cùng chữ ký lỗi qua các model khác
  nhau; nguyên nhân worker không với tới (ví dụ xung đột base mà bước hiện tại không được sửa); lỗi giới hạn hay môi
  trường. Tín hiệu MUST nằm trong context của lượt và trong `task explain`.
- **FR-041**: **Chữ ký lỗi** của một sự cố MUST được tính bằng code từ mã wait, step và bằng chứng chuẩn hóa: tên gate cùng
  danh sách lỗi đã lọc của gate log, tên check CI lỗi, tập khóa finding còn mở. Bảng nguyên nhân MUST gồm: `model`,
  `strategy`, `review_dispute`, `process`, `limit`, `environment`, `spec`. Bảng nguyên nhân → hành động khuyến nghị nằm
  trong vai trò của deputy, không bị code ép.
- **FR-042**: Mọi lệnh gia hạn của deputy (`continue`, `amend-policy`, `message`, `task waive`, duyệt escalation) MUST mang
  `--hypothesis` và `--expect` (tiêu chí đánh giá kết quả). Daemon MUST ghi mỗi lệnh như vậy vào **bảng thử** theo
  chữ ký lỗi hiện tại: loại hành động, tham số chuẩn hóa, giả thuyết, tiêu chí, thời điểm, và kết quả đo ở sự cố kế tiếp
  (chữ ký đổi hay không, số finding hay test lỗi tăng hay giảm). Bảng thử gắn với `(goal, khóa đơn vị)`, không với task:
  task thay thế một đơn vị FAILED kế thừa toàn bộ bảng thử và trạng thái cạn của đơn vị đó.
- **FR-043**: Daemon MUST áp ba luật chống lặp cho lệnh của deputy:
  1. Cùng loại hành động với cùng tham số chuẩn hóa trên cùng chữ ký lỗi MUST bị từ chối `repeat_without_evidence` nếu
     từ lần trước chưa có **bằng chứng mới**. Bằng chứng mới chỉ gồm: tiến triển đo được (cây checkpoint khác kèm chữ ký
     khác hoặc số lỗi giảm), chỉ thị mới của chủ dự án, hay một version kế hoạch do chủ dự án xác nhận có chạm đơn vị
     này. Lời văn của deputy và sửa kế hoạch do chính deputy áp không bao giờ là bằng chứng mới.
  2. Mỗi loại tự cạn: đổi model chỉ tới model chưa thử trên chữ ký đó và nằm trong `allow_models`; `message` và nới giới
     hạn (`continue`, `--agent-runs`, `--deadline`) lần đầu trên một chữ ký luôn được, lần sau của cùng loại chỉ khi có
     bằng chứng mới từ lần trước của loại đó, dù nội dung chỉ dẫn hay tham số khác; mỗi finding, gate hay check chỉ được
     miễn một lần trên một chữ ký.
  3. Khi mọi loại đã cạn trên chữ ký hiện tại, daemon MUST chỉ nhận `task fail` hoặc `deputy handoff` có
     `decision: handover`.
- **FR-044**: Khi lượt kết thúc trên một chữ ký đã cạn mà deputy không `task fail` hay `handover`, daemon MUST kết thúc
  task bằng `task fail` với actor `system:loop-guard`. Với đơn vị của goal nhiều đơn vị, goal vào `replan` (FR-076).
- **FR-045**: Bản miễn MUST nhắm đúng một khóa finding, một tên gate hay một check CI của task, kèm `--evidence` (văn bản
  hay file) và lý do. Bản miễn là event của task. Phạm vi hiệu lực: finding theo khóa và chữ ký review; gate theo chữ ký
  lỗi của gate (gồm các dòng lỗi đã lọc); check CI theo head SHA, tên check và nguồn (app identity) của đúng lần chạy được
  miễn, nên head mới hay lần chạy mới cần bản miễn mới. Hiệu lực: review mà mọi finding chặn đều đã được miễn được coi là
  approve kèm bản miễn; gate hay check được miễn không chặn bước tiếp. Lỗi ngoài phạm vi đó MUST chặn như thường, kể cả ở
  guard merge của đường yolo. Bản miễn MUST NOT áp cho required check của PR vào protected branch.
- **FR-046**: Bản miễn MUST được liệt kê trong mô tả PR (của đơn vị và của goal), `report`, `goal show` và chi tiết task, và
  MUST hiện là "miễn", không bao giờ là "đạt". Bản miễn ghi sau khi PR đã mở MUST sinh effect cập nhật thân PR idempotent;
  merge của task MUST chờ tới khi thân PR đã được đối chiếu có bản miễn đó.

#### Danh tính, quyền, race và khôi phục

- **FR-050**: Runner MUST khởi chạy deputy với `CUSR_DEPUTY_TURN=<turn_id>`. Khi có biến này, CLI MUST cho chạy (không bị
  chặn như worker), MUST dùng actor `deputy` bỏ qua `CUSR_ACTOR`, MUST gửi ID lượt theo mọi lệnh, và `cusr assistant
  hook|session-start|register|wait` MUST thoát 0 và không làm gì.
- **FR-051**: Daemon MUST chỉ nhận lệnh của actor `deputy` khi cả ba điều kiện đúng: ID lượt là một lượt đang chạy; task
  hoặc goal mà lệnh nhắm tới thuộc goal của lượt đó; loại lệnh nằm trong bảng quyền FR-034. Sai điều kiện nào thì
  `forbidden` với lý do tương ứng.
- **FR-052**: Mọi lệnh ghi MUST nhận trường `reason` ở cấp lệnh (CLI `--reason`); với actor `deputy` nó MUST bắt buộc.
  `reason`, ID lượt và (với lệnh của deputy) giả thuyết và tiêu chí MUST được lưu cùng bản ghi lệnh và event.
- **FR-053**: Deputy chạy với toàn quyền tool của harness. Cấu hình phiên MUST cấm tool sửa file của harness trên thư mục
  worktree khi harness hỗ trợ luật theo đường dẫn. Không có lớp chặn ở tầng hệ điều hành và MUST NOT đòi cài thêm công cụ.
- **FR-054**: Lệnh trên task MUST mang expected version của task. Lệnh đổi kế hoạch (`goal propose`, `goal amend`) MUST mang
  plan version; hai lệnh cùng plan version thì chỉ lệnh đầu được nhận.
- **FR-055**: Mọi lệnh ghi MUST idempotent theo request ID: gửi lại cùng request ID, actor và command hash trả kết quả cũ,
  không sinh event mới. Nhận diện replay MUST chạy trước mọi kiểm tra phụ thuộc trạng thái hiện tại (lượt còn chạy, lease,
  loop guard), để lệnh đã thành công không bị từ chối khi gửi lại sau mất kết quả.
- **FR-056**: Daemon khởi động lại MUST nhận lại lượt đang chạy, không mở lượt thứ hai cho cùng sự cố. Sự cố chỉ được mở
  lại sau restart khi task còn ở đúng sự cố đó; không thì lượt được đóng.
- **FR-057**: Lệnh của chủ dự án và trợ lý MUST NOT bị từ chối vì một lượt bắt đầu hay kết thúc.
- **FR-058**: `goal revise` của chủ dự án MUST tăng plan version, khiến mọi lệnh đổi kế hoạch còn mang version cũ bị từ
  chối, và mở lượt `plan` mới với yêu cầu đã sửa.

#### Sổ goal và context

- **FR-060**: Sổ goal MUST là view dựng bằng code từ: event của goal và các task của nó, command ledger (lý do, ID lượt,
  giả thuyết, tiêu chí), bản ghi lượt (bàn giao). MUST NOT có bảng nào giữ bản sao trạng thái task hay goal.
- **FR-061**: Context của lượt MUST được code dựng theo thứ tự cố định, mỗi vùng có ngân sách byte riêng, phần đầu ổn định
  để trúng prompt cache:
  1. vai trò deputy (văn bản cố định);
  2. vùng ổn định của goal: yêu cầu nguyên văn, chỉ thị của chủ dự án, kế hoạch ở version hiện tại;
  3. vùng của task gặp sự cố: tóm tắt lịch sử, tín hiệu vòng lặp, bảng thử trên chữ ký hiện tại, các bàn giao trước;
  4. vùng biến động: một dòng trạng thái mỗi đơn vị, sự kiện gần nhất của các đơn vị khác, xung đột nhánh, thao tác ghi
     của actor khác từ lượt trước của task này;
  5. sự cố: mã wait, chi tiết, bằng chứng, lệnh khả dụng.

  Vùng 2 MUST NOT bị cắt; nó chỉ lớn theo yêu cầu, chỉ thị và kế hoạch, không theo thời gian hay số sự cố. Vùng 3–5 MUST
  nằm trong ngân sách cấu hình (mặc định tổng vùng 2–5 tương đương khoảng 4k token), bất kể goal đã chạy bao lâu hay có
  bao nhiêu sự cố; khi vượt, mục cũ nhất được gộp thành dòng đếm, không bị bỏ im lặng.
- **FR-062**: Chỉ lệnh tường minh MUST ghi vào sổ: `goal add/revise/note/propose/amend/confirm/cancel`, các lệnh ghi trên
  task, `deputy handoff`. Trò chuyện với trợ lý MUST NOT ghi gì.
- **FR-063**: Loại của một mục MUST suy ra từ actor, không do người gọi khai: chủ dự án hay trợ lý giữ lease thì là **chỉ
  thị**; deputy thì là **quan sát** hay **quyết định**; `system:` thì là **sự kiện**. Quan sát của deputy MUST NOT được
  hiện hay dùng như chỉ thị.
- **FR-064**: Bảng thử, tín hiệu vòng lặp và chữ ký lỗi MUST là hàm thuần trên dữ liệu đã ghi, tính lại được bất cứ lúc
  nào.

#### Goal và kế hoạch

- **FR-070**: `cusr goal add` MUST tạo goal từ yêu cầu nguyên văn (file hoặc stdin), lưu nguyên văn, ở trạng thái
  `planning`, kèm gợi ý tùy chọn của người (agent, model, chế độ, "một task"). `cusr task add` MUST tiếp tục chạy như hiện
  nay và tạo một goal ẩn một đơn vị cho task đó, không qua kế hoạch.
- **FR-071**: Kế hoạch MUST gồm: tóm tắt mục tiêu, phạm vi (tập đường dẫn), điều không làm, và các đơn vị. Mỗi đơn vị có
  khóa, tiêu đề, mô tả yêu cầu, chỉ dẫn thực thi, tiêu chí nghiệm thu, scope khai báo, phụ thuộc (theo khóa) và run config
  đề xuất. Mô tả yêu cầu nói đơn vị làm gì cho người dùng; chỉ dẫn thực thi nói nên làm thế nào. Với goal từ hai
  đơn vị trở lên, scope của mỗi đơn vị MUST có và MUST nằm trong phạm vi của goal.
- **FR-072**: `goal propose` MUST được code kiểm: khóa duy nhất, phụ thuộc không vòng, scope hợp lệ, run config hợp lệ với
  `allow_models` và chế độ, tên nhánh goal không khớp `protected_branches`. Kế hoạch hợp lệ có version tăng một và hash
  (SHA-256 của dạng chuẩn hóa). Engine MUST tính các nhóm chạy song song (tầng của DAG).
- **FR-073**: `goal show` MUST hiện kế hoạch đầy đủ: mục tiêu, phạm vi, điều không làm, đơn vị, tiêu chí nghiệm thu, phụ
  thuộc, các nhóm song song, run config, version và hash; cùng tiến độ và quyết định khi goal đang chạy.
- **FR-074**: `goal confirm <id> --plan-hash <hash>` từ chủ dự án hay trợ lý giữ lease MUST: từ chối khi hash khác hash hiện
  hành; tạo mỗi đơn vị thành task đã xác nhận intake và run config theo digest của kế hoạch; với goal nhiều đơn vị, tạo
  nhánh goal và task tổng (FR-080, FR-085). Deputy MUST NOT xác nhận.
- **FR-075**: Sau khi xác nhận, sửa kế hoạch MUST chia hai loại, do code phân loại từ diff của kế hoạch:
  - **Thực thi** (deputy được tự áp, version mới, có lý do): đổi thứ tự, thêm hay bỏ phụ thuộc giữa các đơn vị hiện có
    (DAG vẫn không vòng), đổi run config trong `allow_models`, thu hẹp scope của đơn vị, hay đổi scope trong phạm vi goal,
    đổi chỉ dẫn thực thi, thay một đơn vị FAILED bằng task mới cùng khóa, cùng mô tả yêu cầu và tiêu chí nghiệm thu, khi
    đơn vị đó chưa FAILED vì loop guard hay vì chữ ký đã cạn.
  - **Phạm vi** (chờ duyệt): thêm hay bỏ đơn vị, đổi tiêu đề, mô tả yêu cầu hay tiêu chí nghiệm thu, nới phạm vi goal, đổi
    mục tiêu hay điều không làm, thay một đơn vị đã FAILED vì loop guard hay chữ ký đã cạn. Sửa đổi vào `amendment_pending`; đơn vị bị nó chạm tới dừng ở ranh giới step kế tiếp với wait `plan_amendment`
    (tới người); đơn vị khác chạy tiếp. Duyệt bằng `goal confirm --plan-hash` của bản sửa.
- **FR-076**: Goal MUST vào `replan` khi một đơn vị FAILED (do deputy, loop guard hay lỗi không gỡ được) mà goal chưa kết
  thúc. Lượt `plan` khi đó chỉ có ba lối ra: sửa thực thi, gửi sửa phạm vi chờ người, hay `handover` để goal chờ người.
  Trong goal có kế hoạch, đơn vị FAILED MUST NOT kéo theo hủy dây chuyền các task phụ thuộc vào nó (gồm task tổng): chúng
  ở wait `dependency_pending` có `detail.replan`. Phụ thuộc giữa các task của goal được giải theo khóa đơn vị qua
  `goal_tasks`, nên task thay thế mở khóa chúng mà không phải sửa task nào. Chỉ khi goal `failed` hay `cancelled` thì các
  task chưa kết thúc mới bị hủy.
- **FR-077**: `goal note` MUST ghi một mục vào sổ, loại theo FR-063. `goal revise` (chủ dự án hay trợ lý giữ lease) MUST đổi
  yêu cầu, theo FR-058; đơn vị chưa bắt đầu MUST chờ kế hoạch mới được xác nhận, đơn vị đang chạy tiếp tục trừ khi kế hoạch
  mới bỏ hay đổi nó.
- **FR-078**: Trạng thái goal: `planning` → `awaiting_confirm` → `running` → `done` | `failed` | `cancelled`, cộng
  `amendment_pending` và `replan` khi đang chạy. Goal `done` khi task tổng DONE (goal nhiều đơn vị) hoặc đơn vị duy nhất
  DONE. Goal `failed` khi task tổng FAILED, hoặc khi task của goal ẩn FAILED; đơn vị FAILED của goal có kế hoạch đưa goal
  vào `replan` (FR-076), và goal mà lượt `plan` đã `handover` chờ chủ dự án sửa kế hoạch hay hủy. `goal cancel` (chủ dự án
  hay trợ lý giữ lease) MUST hủy mọi task chưa kết thúc của goal theo `task cancel`.
- **FR-079**: Kênh nhận việc bên ngoài (feature 005), khi có, MUST tạo goal bằng `goal add`; nội dung yêu cầu là đề bài,
  không phải chỉ thị cho deputy.

#### Nhánh goal và tích hợp

- **FR-080**: Khi xác nhận kế hoạch có từ hai đơn vị, daemon MUST tạo **nhánh goal** từ đỉnh nhánh gốc của project bằng một
  effect idempotent (probe bằng ref trên remote), tên `goal/<8 ký tự đầu id>-<slug>`.
- **FR-081**: Mỗi đơn vị MUST là một task thường có `base_branch` là nhánh goal, chạy workflow theo chế độ đã xác nhận
  không đổi: worktree từ đỉnh nhánh goal, gate, review, PR vào nhánh goal, CI.
- **FR-082**: Ở bước merge, PR của đơn vị vào nhánh goal MUST được code merge bằng merge commit, không chờ người, sau cùng
  kiểm tra như merge của yolo (quyền, head/base SHA, gate, required check, review theo chế độ, bản miễn đã ghi), với
  approver `policy:goal` thay cho cờ yolo. Required check của nhánh goal là required check của nhánh gốc (policy cộng tên
  check của binding, như yolo). Danh sách rỗng không bao giờ cho merge, nên `goal propose` cho goal nhiều đơn vị MUST bị
  từ chối khi project không có required check nào.
- **FR-083**: Merge vào nhánh goal MUST chỉ xảy ra khi head của PR đã chứa đỉnh hiện tại của nhánh goal. Nếu chưa, đơn vị
  MUST cập nhật base theo cơ chế hiện có (merge đỉnh nhánh goal vào nhánh đơn vị, xung đột thì fixer giải), rồi chạy lại
  gate, review theo chế độ và CI. Mỗi nhánh goal MUST có tối đa một effect merge đang bay, và trước khi gửi merge daemon
  MUST kiểm đỉnh nhánh goal vẫn là merge commit cuối nó đã ghi (nhánh goal chỉ daemon ghi). Vì vậy các lần merge vào một
  nhánh goal tuần tự và kết quả tích hợp luôn được kiểm trước khi merge; push tay vào nhánh goal theo Edge Cases.
- **FR-084**: Đơn vị phụ thuộc MUST bắt đầu khi task hiện hành của mọi khóa đơn vị nó phụ thuộc đã DONE, tức đã merge vào
  nhánh goal; worktree của nó tạo từ đỉnh nhánh goal lúc đó.
- **FR-085**: Goal nhiều đơn vị MUST có một **task tổng**, tạo lúc xác nhận, phụ thuộc mọi đơn vị, nhánh là nhánh goal,
  `base_branch` là nhánh gốc. Nó chạy workflow `goal_final`: không có bước code; gate → publish → PR draft → review →
  fixer khi cần → ready → CI → merge gate theo quy tắc hiện hành của nhánh gốc. Intake và run config của nó được xác nhận
  cùng kế hoạch; không cần duyệt nhận PR có sẵn.
- **FR-086**: Reviewer của task tổng MUST nhận toàn bộ diff của nhánh goal so với nhánh gốc (theo giới hạn kích thước hiện
  có), kế hoạch và tiêu chí nghiệm thu của mọi đơn vị, và được yêu cầu tập trung vào chỗ giao giữa các đơn vị và tiêu chí
  nghiệm thu của goal.
- **FR-087**: Mô tả PR của goal MUST có các mục do code dựng: tóm tắt yêu cầu, danh sách đơn vị kèm PR đơn vị và merge
  commit, bản miễn, quyết định của deputy và giả định đã trả lời.
- **FR-088**: Goal một đơn vị MUST NOT có nhánh goal hay task tổng; đơn vị có `base_branch` là nhánh gốc và chạy như task
  hôm nay.

#### Điều phối và song song

- **FR-090**: Dispatch MUST do scheduler quyết bằng code, không gọi model: phụ thuộc, slot, và scope guard toàn project hiện
  có (file đã đổi cộng đường dẫn khai báo, #240) áp cho mọi task của mọi goal.
- **FR-091**: Một lượt deputy MUST NOT làm chậm dispatch của task nào khác.
- **FR-092**: Daemon MUST tính, ở mỗi checkpoint của một task, xung đột thật giữa nhánh của nó và nhánh của các task đang
  hoạt động khác trong cùng project bằng `git merge-tree`, chỉ cho các cặp có file đã đổi chồng nhau. Kết quả là thông tin
  cho context của lượt, `task explain` và `goal show`; nó MUST NOT tự làm task nào chờ.
- **FR-093**: Xung đột ngữ nghĩa giữa các đơn vị MUST được bắt bằng FR-083 (gate và CI trên kết quả đã tích hợp trước mỗi
  merge) và task tổng (gate, review toàn bộ, CI).

#### Giao tiếp với trợ lý

- **FR-100**: Mọi phiên MUST đọc được `goal list`, `goal show`, `task show/explain/history`, `report` mà không cần lease.
- **FR-101**: Lệnh ghi lên goal từ actor `assistant` (`goal add/revise/note/confirm/cancel`, và `goal propose` khi trợ lý tự
  lập kế hoạch) MUST đến từ phiên đang giữ lease; thiếu thì `forbidden` với `reason: 'lease_required'` và hướng dẫn
  `cusr assistant register --take`. Chủ dự án gọi trực tiếp (actor owner) không cần lease.
- **FR-102**: Tin của goal (kế hoạch chờ duyệt, sửa phạm vi chờ duyệt, sự cố chuyển cho người, goal xong và PR sẵn sàng,
  goal thất bại) MUST đi qua attention hiện có tới phiên giữ lease.
- **FR-103**: Không có phiên trợ lý nào mở thì goal MUST chạy tiếp; tin dồn lại theo cơ chế attention hiện có.

#### Ghi nhận và xem lại

- **FR-110**: Quyết định của deputy MUST hiện ở `decisions.md`, `cusr report`, `goal show`, chi tiết và lịch sử task, dựng
  bằng code từ event, command ledger và bản ghi lượt; mỗi quyết định có goal, task, sự cố (qua ID lượt), hành động, lý do,
  giả thuyết, tiêu chí và kết quả đo được.
- **FR-111**: Mỗi lần publish, mô tả PR của đơn vị MUST có mục do code dựng liệt kê quyết định của deputy ảnh hưởng tới nội
  dung và bản miễn. Quyết định sau lần publish cuối chỉ hiện ở các chỗ của FR-110.

#### Thay decider, cấu hình và nâng cấp

- **FR-120**: Deputy MUST thay decider. Quy tắc "sau một câu trả lời, câu hỏi tiếp ở cùng step chờ người" và nhãn `grill`
  MUST bị bỏ.
- **FR-121**: Binding của deputy MUST khai qua role `deputy` trong user config, kèm `limits` tùy chọn (`infra_retries`,
  `wall_ms`, `stall_ms`, `context_bytes`). Thiếu role thì hệ thống chạy như khi không có deputy. Role `decider` cũ MUST được
  đọc như `deputy` kèm cảnh báo đổi tên, và cần một lần `prove-harness`/`record-manifest` trước khi chạy được.
- **FR-122**: Lần khởi động đầu sau nâng cấp, daemon MUST đóng mỗi bản ghi decider còn dở bằng `decider_ran` (`apply:
  false`, lỗi `superseded`). Event `DeciderRan` và câu trả lời `agent:decider` cũ MUST vẫn replay được và vẫn hiện trong
  `decisions.md` và `report`.
- **FR-123**: Task có trước nâng cấp MUST được coi là goal ẩn một đơn vị; không cần migrate dữ liệu của task.
- **FR-124**: `cusr doctor` MUST báo deputy có dùng được không: binding, harness, manifest, terminal backend.

### Key Entities

- **Goal**: yêu cầu của chủ dự án. Aggregate có event riêng: id, project, yêu cầu nguyên văn, trạng thái, kế hoạch hiện
  hành (version, hash), nhánh goal, task tổng. Goal ẩn của `task add` không có kế hoạch.
- **Kế hoạch**: mục tiêu, phạm vi, điều không làm, đơn vị; mỗi version bất biến, có hash.
- **Đơn vị**: một task thường gắn goal và khóa đơn vị. Thay một đơn vị FAILED tạo task mới cùng khóa; bảng thử và phụ thuộc
  đi theo khóa.
- **Task tổng**: task của goal nhiều đơn vị, nhánh là nhánh goal, PR vào nhánh gốc.
- **Lượt deputy**: một phiên harness cho một sự cố hay một sự kiện `plan`; mang ID lượt, goal, task, sự cố, chữ ký lỗi, chế
  độ, trạng thái, bàn giao, tin nhắn cuối. Bền qua restart, ngoài event log có version.
- **Bàn giao**: `cause`, `decision`, `ruled_out`, `next_look`; lưu trong bản ghi lượt.
- **Chữ ký lỗi, tín hiệu vòng lặp, bảng thử**: hàm thuần trên dữ liệu đã ghi.
- **Bản miễn**: event của task: loại (finding, gate, check), khóa hay tên, chữ ký lỗi, bằng chứng, lý do, actor, ID lượt.
- **Sổ goal**: view dựng từ các thực thể trên.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Trong bộ kiểm thử fake, 100% task đưa vào các mã wait FR-001 giao cho deputy không tạo mục attention cho chủ
  dự án, trừ khi lượt chuyển sự cố (FR-023, FR-024).
- **SC-002**: Trong một đêm chạy thật, một goal có ít nhất năm đơn vị, có phụ thuộc, đi từ lúc duyệt kế hoạch tới PR của
  goal ở trạng thái ready với CI xanh mà chủ dự án không thao tác gì, trừ các mã FR-001 loại trừ.
- **SC-003**: Với phiên tương tác không báo hết lượt, task tiếp tục chậm nhất một phút sau `stall_ms`, không có hai lượt
  cho cùng sự cố.
- **SC-004**: Restart daemon ở mọi điểm trong lượt và trong việc tạo nhánh goal hay merge vào nhánh goal (crash injection)
  không tạo lượt thứ hai, không lặp lệnh ghi, không tạo merge commit thứ hai.
- **SC-005**: Sau mọi cách deputy sửa worktree của task mình, kể cả khi restart giữa lượt, worktree và HEAD bằng đúng mốc.
- **SC-006**: 100% lệnh của deputy mang version hay plan version cũ bị từ chối; 0 lệnh của chủ dự án bị từ chối chỉ vì
  một lượt bắt đầu hay kết thúc.
- **SC-007**: Mỗi quyết định và bản miễn của deputy xuất hiện ở các chỗ của FR-110 và FR-046; bản miễn không bao giờ hiện là
  "đạt".
- **SC-008**: Config có hoặc không có role `decider` nạp được sau nâng cấp mà không phải sửa; task có trước nâng cấp chạy
  tiếp như goal ẩn.
- **SC-009**: Property test: với mọi chuỗi lệnh của deputy trên một task mà không có tiến triển đo được, số lệnh được nhận
  trên một chữ ký lỗi là hữu hạn, có chặn trên tính từ cấu hình, và chuỗi kết thúc ở `task fail` hay chuyển cho người.
- **SC-010**: Property test: vùng 3–5 của context một lượt nằm trong ngân sách cấu hình với mọi độ dài lịch sử, số sự cố
  và số đơn vị, và vùng 2 luôn có đủ yêu cầu nguyên văn, mọi chỉ thị và kế hoạch hiện hành.
- **SC-011**: Trong scenario fake, đơn vị độc lập của cùng goal và của hai goal có scope rời chạy đồng thời tới hết slot;
  một lượt deputy đang chạy không đổi kết quả dispatch.
- **SC-012**: Với goal N đơn vị, first-parent của nhánh goal có đúng N merge commit, mỗi commit ứng với một đơn vị; mỗi
  merge chỉ xảy ra khi head của PR chứa đỉnh nhánh goal lúc đó và check đã xanh trên head đó.

## Assumptions

- Các chỗ kẹt tất định (#245–#249) được xử lý riêng bằng code; feature này chỉ nhận ít sự cố hơn khi chúng xong.
- Harness dùng cho deputy có phiên tương tác báo được hết lượt qua hook và resume được ở chế độ headless (Claude Code,
  Codex); harness khác chạy headless.
- CI của repo chạy cho PR vào mọi nhánh, nên PR của đơn vị vào nhánh goal có CI (CI của repo này dùng `pull_request`
  không lọc nhánh). Repo không có required check thì chỉ dùng được goal một đơn vị; `cusr doctor` báo trường hợp này.
- `allow_models` trong cấu hình user là mức model tối đa chủ dự án cho deputy dùng, cho cả lượt của deputy và cho việc
  đổi model của worker.
- Rủi ro chủ dự án chấp nhận: deputy có toàn quyền, không hỏi quyền và đọc nội dung không tin cậy. Daemon vẫn chặn quyền
  `admin`, xác nhận và merge.

## Tác động lên hiến chương và SPEC

Amendment 10.0.0 (PR #254) đã cho deputy quyền `operate`, mở lại trần có lý do và toàn quyền với mốc worktree. Thiết kế
này cần thêm amendment 11.0.0, sửa cùng PR với spec này; feature MUST NOT được triển khai trước khi amendment được chủ
dự án duyệt (merge PR).

| Điều khoản | Hiện tại (10.0.0) | Đổi ở 11.0.0 |
|---|---|---|
| Nguyên tắc III | Lượt deputy không có trần | Không trần tổng, nhưng code chặn lặp không có bằng chứng mới, mỗi loại hành động tự cạn, cạn hết thì chỉ còn kết thúc hay chuyển người (FR-043, FR-044) |
| Nguyên tắc IV | `direct-pr` không miễn gate/CI; không nói tới miễn | Deputy miễn một finding, gate hay check cụ thể có bằng chứng, ghi event, liệt kê trong PR, báo là miễn; không áp cho required check của protected branch (FR-045, FR-046) |
| Nguyên tắc V, xác nhận | Assistant xác nhận run config từng task; deputy không xác nhận task | Kế hoạch goal xác nhận một lần theo hash là xác nhận mọi đơn vị; deputy sửa chi tiết thực thi, sửa phạm vi phải duyệt lại; deputy không xác nhận kế hoạch (FR-074, FR-075) |
| Nguyên tắc V, merge | Code gửi merge sau kiểm tra; người duyệt merge vào protected branch | Thêm: code merge PR đơn vị vào nhánh goal bằng merge commit sau cùng kiểm tra như auto-merge; nhánh goal không thuộc protected branch (FR-082) |
| Nguyên tắc V, quyền deputy | Actor `deputy` do daemon gắn | Quyền dựa trên ID lượt đang chạy, task/goal của lượt và bảng quyền (FR-051) |
| Nguyên tắc V, assistant | Lease chỉ định tuyến tin | Lệnh ghi goal từ assistant phải từ phiên giữ lease (FR-101) |
| Nguyên tắc VII | Gate chưa đạt báo chưa đạt | Thêm: gate được miễn báo là miễn kèm lý do |

Nguyên tắc I không đổi: engine quyết định chuyển trạng thái và dispatch; deputy chỉ được gọi ở ranh giới và hành động qua
dịch vụ.

Cần đồng bộ khi amendment được duyệt, làm ở lát cuối (gộp với mục còn chờ của 10.0.0):

- `SPEC.md`: §4 (I09; I11 cho merge vào nhánh goal); §9 (`continue`, `amend-policy` mở rộng, `task fail`, `task waive`);
  §10 (bỏ decider, thêm deputy và goal); §14 (merge vào nhánh goal, workflow `goal_final`); §15.1 (lệnh `goal`, `deputy
  handoff`, `--reason`); §15.2 (actor `deputy`, ID lượt, lease cho lệnh goal).
- `deploy/README.md`: role `deputy` và limits, bỏ mục decider, mục goal.
- ADR-0005 (câu về decider); ADR mới cho lượt deputy (phiên tương tác ngắn, hook hết lượt); ADR mới cho nhánh goal.
- `GLOSSARY.md` (decider → deputy; goal, đơn vị, task tổng, nhánh goal, lượt, bàn giao, chữ ký lỗi, bản miễn);
  `docs/architecture.md`.
- [specs/003-telegram-channel/spec.md](../003-telegram-channel/spec.md): không push khi deputy giữ sự cố; tin của goal;
  bỏ quy tắc riêng của decider.
- Skill `cusr`: lệnh `goal`, lease cho lệnh goal, đọc tiến độ.
- #247 (PR #252): `ladder_exhausted` và `rung_denied` trở lại thành wait (FR-004). Issue #248 mục 1–2 được feature này
  thay thế.
