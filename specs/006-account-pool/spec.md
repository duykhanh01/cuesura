# Feature Specification: Nhiều tài khoản cho một harness, chuyển tài khoản khi hết hạn mức

**Feature Branch**: `006/account-pool`

**Created**: 2026-11-04

**Status**: Draft

**Input**: User description: "Feature 006: quản lý nhiều tài khoản Claude/Codex (subscription) cho harness, chuyển
tài khoản khi hết hạn mức." (Số 005 đã dành cho kênh GitHub theo spec 003.)

## Bối cảnh và phạm vi

Hiện mỗi harness chạy bằng đúng một tài khoản. Pin của harness ghi tên một credential (vd `claude-0`), và
mỗi attempt chép file credential đó vào private home rồi xóa đi khi xong. Khi tài khoản chạm hạn mức,
engine đặt timer chờ tới `reset_at` (Claude) hoặc backoff hữu hạn (Codex) rồi chạy lại **cùng tài khoản**.
Người dùng có nhiều subscription vẫn phải ngồi chờ, hoặc tự sửa `credential_refs` rồi tạo task mới.

Các công cụ khác giải bài này theo hai cách: tráo file auth (đơn giản, không chạy song song được), hoặc mỗi
tài khoản một thư mục cấu hình riêng (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) như Orca. cusr đã có private home
cho từng attempt, nên chỉ thiếu khái niệm **tài khoản** nằm giữa harness và credential.

Mỗi harness có một **tài khoản mặc định**: tài khoản đã đăng nhập sẵn trên máy mà pin đang dùng, như hiện nay.
Tài khoản mặc định được dùng trước; cusr chỉ đọc credential của nó, không ghi hay xóa. Người dùng thêm **tài khoản
dự phòng** bằng `cusr account add`: mỗi tài khoản dự phòng là một lần đăng nhập riêng vào thư mục do cusr quản lý,
không dùng chung credential với phiên tương tác hay công cụ khác (Orca…), và cusr chỉ ghi vào thư mục của chính
nó. Vendor cho mỗi lần đăng nhập một phiên OAuth riêng, nên cusr và công cụ khác cùng dùng một subscription mà
không làm hỏng token của nhau ([spike](spike-report.md)). Tài khoản mặc định hết hạn mức hay bị đăng xuất thì
task chuyển sang tài khoản dự phòng.

Feature này thêm:

1. **Tài khoản là thực thể được đặt tên** thuộc một harness. Tài khoản mặc định có sẵn; người dùng thêm tài
   khoản dự phòng bằng cách đăng nhập qua `cusr account add`, rồi liệt kê, tạm ngưng hay gỡ bằng CLI.
2. **Chuyển tài khoản khi hết hạn mức**: attempt bị giới hạn thì tài khoản đó nghỉ tới lúc hết hạn mức, và
   attempt được chạy lại ngay bằng tài khoản khác của cùng harness. Chỉ khi mọi tài khoản đều đang nghỉ mới
   tự chờ tới mốc hồi như hiện nay, kèm một thông báo để người dùng biết. Người dùng cũng đổi được tài khoản
   dùng từ attempt sau bằng `cusr account use`.
3. **Credential không bị hỏng sau khi dùng**: token mà harness làm mới trong lúc chạy phải được giữ lại trong
   thư mục của tài khoản, vì refresh token chỉ dùng được một lần; nếu không, lần chạy sau của cusr sẽ bị đăng
   xuất.

Đổi tài khoản **không** phải nâng hay hạ model: cùng harness, cùng model, cùng effort, cùng binding đã đóng
băng. Nó cũng không do agent quyết định; code chọn theo quy tắc cố định và ghi lại
([constitution](../../.specify/memory/constitution.md) V).

Feature này sửa một quy tắc của [SPEC.md §6.2](../../SPEC.md): "Rate limit khóa pool/harness liên quan tới
`reset_at`" thành khóa **tài khoản** liên quan; harness chỉ bị coi là hết hạn mức khi mọi tài khoản của nó
đều đang nghỉ. Plan phải kèm sửa SPEC.md tương ứng.

**Ngoài phạm vi:**

- Tài khoản dạng API key và định tuyến theo chi phí (SPEC.md §2.2 để sau v1).
- Hiển thị mức đã dùng của hạn mức 5 giờ/7 ngày, dự báo sắp hết hạn mức, hay chủ động đổi tài khoản trước
  khi bị giới hạn.
- Sức chứa riêng của từng tài khoản và chia đều worker giữa các tài khoản. Mức song song vẫn chỉ do pool
  quyết định (FR-020); việc chia tải để feature sau.
- Cân bằng tải giữa các tài khoản theo mức dùng; thứ tự chọn chỉ theo ưu tiên người dùng đặt (FR-002).
- Chuyển sang harness, vendor hoặc model khác khi hết hạn mức (vẫn theo thang escalation đã duyệt).
- Chế độ chờ người duyệt trước khi chạy tiếp khi tài khoản hồi; muốn giữ task lại thì tạm ngưng tài khoản.
  Để sau nếu thực tế cần.
- Dùng chung credential với phiên tương tác của người dùng hay công cụ khác (Orca…): trỏ tài khoản tới file
  credential có sẵn, đọc hay ghi vào thư mục của công cụ khác, nhập hoặc đồng bộ tài khoản từ chúng. Ngoại lệ
  duy nhất là tài khoản mặc định (FR-003), chỉ đọc.
- macOS Keychain; v1 chạy trên Linux nơi credential là file (SPEC.md §2.1).
- Nhiều người dùng chia sẻ một tài khoản.

## Clarifications

### Session 2026-11-04

**Tài khoản và credential**

- Q: Tài khoản nào được dùng trước? → A: Tài khoản mặc định, tức tài khoản đã đăng nhập sẵn trên máy mà pin
  đang dùng. Tài khoản thêm bằng `cusr account add` là dự phòng, dùng khi tài khoản mặc định nghỉ hay lỗi
  (FR-002, FR-003).
- Q: cusr có ghi vào credential đăng nhập sẵn trên máy không? → A: Không; chỉ đọc, như hiện nay. Phiên tương tác
  vì thế vẫn có thể bị đăng xuất như trước; khi đó task chuyển sang tài khoản dự phòng (FR-003).
- Q: Tài khoản dự phòng có dùng chung credential với Orca hay phiên tương tác không? → A: Không. Mỗi tài khoản
  dự phòng là một lần đăng nhập riêng vào thư mục do cusr quản lý; cusr chỉ ghi vào thư mục của mình (FR-006).
- Q: Token làm mới trong lúc chạy được giữ ở đâu? → A: Trong thư mục của tài khoản, ghi về ngay khi đổi
  (FR-022).
- Q: Hai bản token khác nhau thì giữ bản nào? → A: Bản đang nằm trong nguồn; bản của attempt chỉ được ghi khi
  nguồn chưa đổi kể từ lúc attempt bắt đầu (FR-023).
- Q: Đăng nhập lại mà ra danh tính khác thì sao? → A: Không thay credential; muốn đổi danh tính thì gỡ rồi thêm
  tài khoản mới (FR-005a). Riêng tài khoản mặc định đi theo máy: người dùng đăng nhập tài khoản khác trên máy
  thì cusr tạm loại nó, `cusr account check` nhận danh tính mới (FR-005a).
- Q: Ghi credential thất bại thì sao? → A: Giữ bản mới trong vùng secret, tạm loại tài khoản và báo lỗi vận
  hành tới khi ghi được (FR-022a).
- Q: Gỡ tài khoản có xóa credential? → A: Có với tài khoản dự phòng; tài khoản mặc định chỉ bỏ khai báo, không
  đụng file của người dùng (FR-008).

**Quyền**

- Q: Ai được thay đổi tài khoản? → A: Chỉ `admin`, vì tài khoản dùng chung cho mọi project (FR-008).
- Q: Người chỉ đọc một project thấy gì? → A: Tên, harness, ưu tiên, khả dụng; số liệu dùng chỉ trong project
  được đọc; danh tính và đường dẫn chỉ `admin` thấy (FR-007).

**Chọn tài khoản và chờ**

- Q: Pool có tăng theo số tài khoản không? → A: Không. Pool vẫn là trần song song do người dùng đặt (FR-020).
- Q: Thao tác của người dùng có thắng retry tự động không? → A: Có; mỗi attempt chọn theo trạng thái lúc đó
  (FR-010).
- Q: Một tài khoản bị chặn vì nhiều nguyên nhân thì sao? → A: Mỗi nguyên nhân gỡ riêng; hết hẳn mới được chọn
  (FR-011).
- Q: Hai tài khoản cùng subscription có là dự phòng của nhau? → A: Không; chúng dùng chung trạng thái nghỉ
  (FR-012). Thêm tài khoản trùng danh tính vẫn được, kèm cảnh báo không tăng hạn mức.
- Q: Mỗi tài khoản được thử bao nhiêu lần? → A: Một lần mỗi vòng thử; được đánh thức thì mở vòng mới (FR-016).
- Q: Cả vòng thất bại mà mọi mốc hồi đã qua thì chờ gì? → A: Backoff của lớp `rate_limit` (FR-016).
- Q: Xóa nghỉ có chặn báo hết hạn mức đến sau? → A: Không; muốn chặn thì tạm ngưng (FR-008).
- Q: "Chạy lại ngay" có vượt pool không? → A: Không; task chỉ trở lại hàng đợi (FR-014b).
- Q: Chờ ghi credential có chặn task? → A: Không; task dùng tài khoản khác (FR-014, FR-022a).

**Lỗi auth**

- Q: Thử lại bằng token mới mấy lần? → A: Một lần cho mỗi chuỗi lỗi auth liên tiếp của tài khoản trong task
  (FR-018).

**Thông báo**

- Q: Đợt hết hạn mức kết thúc khi nào? → A: Khi có tài khoản chọn được (FR-014a).
- Q: Thông báo có cập nhật khi đợt thay đổi? → A: Có; sửa thông báo cũ, không gửi thêm tin (FR-014a).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Task chạy tiếp bằng tài khoản khác khi hết hạn mức (Priority: P1)

Người dùng khai hai tài khoản Claude cho harness `claude`. Một worker đang chạy thì tài khoản thứ nhất chạm
hạn mức. cusr đánh dấu tài khoản đó nghỉ tới thời điểm hết hạn mức và chạy lại attempt ngay bằng tài khoản
thứ hai, tiếp tục session cũ nếu có. Người dùng không phải làm gì; `cusr report` và chi tiết task cho thấy
attempt nào chạy bằng tài khoản nào và vì sao đổi.

**Why this priority**: Đây là giá trị chính: subscription thứ hai chỉ có ích khi task không phải ngồi chờ
tài khoản thứ nhất hồi lại.

**Independent Test**: Dùng harness giả trả về "hết hạn mức, reset sau 3 giờ" cho tài khoản A; kiểm tra
attempt kế tiếp chạy bằng tài khoản B trong cùng task, không có timer chờ, và A được ghi nghỉ tới đúng mốc.

**Acceptance Scenarios**:

1. **Given** harness có tài khoản A và B đều sẵn sàng, **When** attempt trên A báo hết hạn mức kèm thời điểm
   reset, **Then** A được ghi nghỉ tới mốc đó và attempt mới bắt đầu trên B mà không chờ timer.
2. **Given** attempt trên A có session đã lưu, **When** chuyển sang B, **Then** attempt trên B tiếp tục
   session đó; lượt chạy lại được tính như một lần retry do hạn mức, không phải escalation.
3. **Given** A đang nghỉ, **When** một task khác cần harness đó, **Then** task đó được cấp B ngay, không
   thử A trước.
4. **Given** A và B đều đang nghỉ, **When** attempt cần chạy, **Then** task chờ với lý do hết hạn mức tới mốc
   reset sớm nhất trong các tài khoản, như hành vi hiện nay.
5. **Given** vendor không cho biết thời điểm reset (vd Codex), **When** A bị giới hạn, **Then** A nghỉ theo
   backoff hữu hạn đã cấu hình và attempt chuyển sang B ngay.
6. **Given** hai task cùng chạy trên A và cùng bị giới hạn, **When** cả hai báo về, **Then** A chỉ có một
   trạng thái nghỉ (mốc muộn hơn thắng) và mỗi task được chạy lại đúng một lần trên tài khoản khác.
7. **Given** pool của harness là 1, hai task sẵn sàng không khai phụ thuộc và người dùng vừa thêm tài khoản
   thứ hai, **When** scheduler cấp việc, **Then** vẫn chỉ một attempt chạy; task kia chờ slot như trước.
8. **Given** A và B đều đang nghỉ, **When** task bắt đầu chờ hạn mức, **Then** có một thông báo để biết
   nêu task bị ảnh hưởng, mốc tự chạy tiếp và trạng thái A, B; tới mốc, attempt tự chạy lại trên tài khoản
   vừa hồi mà không cần người trả lời.
9. **Given** task đang chờ tới mốc hồi của A và B, **When** người dùng xóa nghỉ của B, **Then** task chạy
   lại ngay trên B, không chờ tới mốc cũ.

---

### User Story 2 - Thêm và quản lý tài khoản bằng CLI (Priority: P1)

Tài khoản đã đăng nhập sẵn trên máy là tài khoản mặc định, không cần làm gì. Người dùng thêm tài khoản dự
phòng bằng `cusr account add` cho một harness: cusr chạy luồng login của chính vendor vào một thư mục cusr quản
lý. Tài khoản đã đăng nhập ở Orca vẫn phải đăng nhập lại một lần cho cusr nếu muốn dùng làm dự phòng. `cusr account list` cho biết từng tài khoản đang sẵn sàng, đang nghỉ tới lúc nào, tạm ngưng, hay lỗi
đăng nhập. Người dùng có thể tạm ngưng, bật lại, xóa nghỉ thủ công, đổi thứ tự ưu tiên, đăng nhập lại và gỡ
tài khoản.

**Why this priority**: Không có cách thêm và xem tài khoản thì Story 1 không dùng được; cùng mức P1 vì hai
story phải ra cùng nhau.

**Independent Test**: Thêm hai tài khoản bằng login (luồng login giả lập trong kiểm thử), chạy `cusr account list`,
tạm ngưng một tài khoản và kiểm tra attempt kế tiếp không dùng nó; `cusr doctor` báo trạng thái từng tài
khoản mà không in nội dung credential.

**Acceptance Scenarios**:

1. **Given** pin của harness dùng credential đăng nhập sẵn trên máy và chưa có tài khoản nào được khai,
   **When** người dùng nâng cấp hoặc cài mới cusr, **Then** credential đó trở thành tài khoản mặc định `default`
   chỉ đọc của harness, và hành vi chạy không đổi.
2. **Given** người dùng chạy `cusr account add claude --name work`, **When** luồng login của vendor hoàn tất,
   **Then** tài khoản `work` xuất hiện trong `list` ở trạng thái sẵn sàng, với credential nằm trong thư mục
   riêng của nó, xếp sau `default`; attempt kế tiếp vẫn chạy bằng `default` nếu nó sẵn sàng.
3. **Given** luồng login bị hủy, thất bại, hoặc tạo ra credential không đúng định dạng của harness, **When**
   thêm tài khoản, **Then** lệnh bị từ chối với lý do cụ thể, không có tài khoản nào được thêm và thư mục tạm
   bị dọn.
4. **Given** tài khoản `work` đang dùng cho một attempt, **When** người dùng tạm ngưng hoặc gỡ nó, **Then**
   attempt đang chạy chạy tới hết; từ attempt sau `work` không được chọn.
5. **Given** tài khoản đang nghỉ vì hạn mức, **When** người dùng xóa nghỉ thủ công, **Then** tài khoản được
   chọn lại ở attempt kế tiếp, và thao tác được ghi kèm actor.
6. **Given** người gọi chỉ có quyền `read` hoặc `operate` (kể cả assistant vận hành một project), **When**
   gọi lệnh thêm/sửa/gỡ/`use` tài khoản, **Then** lệnh bị từ chối; `list` vẫn xem được.
7. **Given** harness có A (ưu tiên cao nhất) và B, một attempt đang chạy trên A, **When** người dùng chạy
   `cusr account use claude B`, **Then** attempt đang chạy vẫn dùng A tới hết, còn attempt kế tiếp của mọi
   task chạy bằng B; thao tác được ghi kèm actor.
8. **Given** người dùng đăng nhập lại A (`cusr account login`) nhưng chọn nhầm danh tính khác, **When** luồng
   login hoàn tất, **Then** cusr từ chối thay credential của A, giữ nguyên credential cũ và báo đổi danh tính;
   muốn đổi danh tính thì gỡ A rồi thêm tài khoản mới. Với tài khoản mặc định, người dùng đăng nhập danh tính
   khác trên máy thì `default` bị loại khỏi lựa chọn với lý do đổi danh tính và có mục inbox; `cusr account
   check claude default` nhận danh tính mới và đưa nó trở lại.
9. **Given** người dùng thêm một tài khoản cùng danh tính với tài khoản đã có, **When** login hoàn tất,
   **Then** tài khoản vẫn được thêm kèm cảnh báo trùng danh tính, nói rõ nó không tăng hạn mức, và hai mục
   dùng chung trạng thái nghỉ (FR-012).
10. **Given** `default` bị đăng xuất (lỗi auth không do nguồn đổi), **When** task cần chạy attempt kế tiếp,
    **Then** attempt chạy bằng tài khoản dự phòng, inbox có mục cho `default`; người dùng đăng nhập lại trên
    máy rồi chạy `cusr account check claude default` thì `default` được dùng trước như cũ.

---

### User Story 3 - Credential vẫn dùng được sau mỗi lần chạy (Priority: P1)

Harness làm mới token đăng nhập trong lúc chạy, và refresh token cũ hết dùng được. cusr ghi bản mới về thư mục
của tài khoản ngay khi nó đổi, nên lần chạy sau và các attempt khác trên cùng tài khoản không bị đăng xuất.

**Why this priority**: Nếu credential hỏng dần sau mỗi lần dùng thì càng nhiều tài khoản càng nhiều chỗ hỏng,
và tài khoản tưởng sẵn sàng lại thất bại đúng lúc cần chuyển sang.

**Independent Test**: Dùng harness giả ghi một token mới vào credential trong private home; credential của
tài khoản thành bản mới, file vẫn 0600, và sau attempt private home không còn bản auth nào.

**Acceptance Scenarios**:

1. **Given** harness đã làm mới credential trong lúc chạy, **When** file trong private home đổi, **Then** bản
   mới được ghi về thư mục tài khoản ngay, không đợi attempt kết thúc; attempt kết thúc thế nào (thành công,
   lỗi, bị hủy, hết giờ) thì bản mới cũng được giữ trước khi private home bị xóa.
2. **Given** credential không đổi trong lúc chạy, **When** attempt kết thúc, **Then** credential của tài khoản
   không bị ghi lại.
3. **Given** hai attempt chạy song song trên cùng tài khoản và cùng làm mới token, **When** cả hai ghi về,
   **Then** chỉ bản ghi trước được giữ; bên sau thấy nguồn đã đổi so với lúc bắt đầu nên bỏ bản của mình, và
   nguồn luôn là một bản hợp lệ, đầy đủ, không bao giờ là file hỏng hoặc ghép nửa.
4. **Given** người dùng đăng nhập lại tài khoản qua `cusr account login` sau khi attempt bắt đầu, **When**
   attempt ghi về, **Then** cusr không ghi đè bản đăng nhập mới bằng bản của attempt.
5. **Given** bản credential trong private home rỗng, sai định dạng của vendor hoặc đã bị thay bằng symlink
   (vd harness thua khi làm mới đồng thời và xóa token của nó), **When** cusr xét ghi về, **Then** cusr không
   chép nó về và ghi lý do cho tài khoản.
6. **Given** harness đã làm mới token nhưng ghi về thất bại (đầy đĩa, thiếu quyền), **When** attempt kết thúc,
   **Then** bản mới được giữ trong vùng secret của cusr thay vì bị xóa, tài khoản bị loại khỏi lựa chọn và có
   lỗi vận hành; kết quả công việc của attempt vẫn được lưu và task đi tiếp bằng tài khoản khác; ghi lại thành
   công thì gỡ nguyên nhân chờ ghi và xóa bản giữ tạm. Nếu trong lúc đó tài khoản bị tạm ngưng thì nó vẫn tạm
   ngưng.

---

### User Story 4 - Tài khoản lỗi đăng nhập không làm kẹt task (Priority: P2)

Một tài khoản bị thu hồi hoặc hết phiên đăng nhập. Attempt trên tài khoản đó thất bại vì auth; cusr đánh dấu
tài khoản lỗi đăng nhập, chạy lại attempt trên tài khoản khác, và đưa việc "đăng nhập lại tài khoản X" vào
inbox. Khi không còn tài khoản sẵn sàng, task chờ theo FR-014: chờ tài khoản đang nghỉ hồi lại nếu còn, chỉ
chờ người như lỗi `auth_config` hiện nay khi không còn tài khoản nào tự hồi được.

**Why this priority**: Có nhiều tài khoản thì lỗi auth của một tài khoản không nên chặn task, nhưng thiếu
story này Story 1 vẫn có giá trị.

**Independent Test**: Harness giả báo lỗi auth trên A; kiểm tra attempt sau chạy trên B, A ở trạng thái lỗi
đăng nhập và không được chọn lại cho tới khi người dùng sửa.

**Acceptance Scenarios**:

1. **Given** A và B sẵn sàng, **When** attempt trên A thất bại vì auth, **Then** A bị đánh dấu lỗi đăng nhập,
   attempt chạy lại trên B, và inbox có một mục cho A.
2. **Given** A đang lỗi đăng nhập, **When** người dùng đăng nhập lại A bằng `cusr account login` (cùng danh
   tính) hoặc `cusr account check` thành công, **Then** A trở lại sẵn sàng.
3. **Given** mọi tài khoản đều lỗi đăng nhập hoặc tạm ngưng, **When** attempt cần chạy, **Then** task chờ
   người với lý do nêu tên từng tài khoản và cách sửa.
4. **Given** B đang nghỉ thêm 5 phút, **When** attempt trên A thất bại vì auth, **Then** A bị đánh dấu lỗi
   đăng nhập, inbox có một mục cho A, và task chờ hết hạn mức tới khi B hồi rồi chạy lại trên B, không chờ
   người.
5. **Given** attempt trên A bắt đầu với token cũ và trong lúc chạy một attempt khác đã ghi token mới của A
   về nguồn, **When** attempt đầu thất bại vì auth, **Then** A không bị đánh dấu lỗi đăng nhập, không có mục
   inbox, và attempt được chạy lại trên A bằng token mới.
6. **Given** lần chạy lại trên A bằng token mới ở kịch bản 5 lại thất bại vì auth, kể cả khi nguồn lại vừa
   đổi, **When** hệ thống xử lý lỗi, **Then** A bị đánh dấu lỗi đăng nhập và attempt chuyển sang tài khoản
   khác theo FR-014; không có lần thử token mới thứ hai.
7. **Given** attempt đang chạy trên A và người dùng vừa tạm ngưng A (hoặc `use` B), **When** attempt thất
   bại vì auth và nguồn của A có token mới, **Then** lần chạy lại dùng B, không dùng A.

### Edge Cases

- `reset_at` đã ở quá khứ hoặc xa bất thường: mốc quá khứ coi như sẵn sàng; mốc xa hơn trần cấu hình bị cắt
  về trần và ghi rõ. Nếu cả vòng thử đều thất bại với mốc quá khứ, task chờ backoff trước vòng mới (FR-016).
- Người dùng xóa nghỉ trong khi một attempt cũ trên tài khoản đó còn chạy rồi báo hết hạn mức: tài khoản
  nghỉ lại theo báo mới (FR-008).
- Daemon restart khi tài khoản đang nghỉ: trạng thái nghỉ và timer hồi lại được khôi phục, không coi tài
  khoản là sẵn sàng sớm.
- Tài khoản bị gỡ khỏi cấu hình khi đang nghỉ hoặc đang có attempt: attempt chạy hết; nghỉ của tài khoản đã
  gỡ không còn tính vào mốc chờ của harness.
- Người dùng đăng nhập cùng một tài khoản vendor cho hai tên: khi nhận ra được (cùng danh tính),
  `add` và `doctor` cảnh báo; hai mục dùng chung trạng thái nghỉ (FR-012) nên không được thử như tài khoản
  dự phòng của nhau.
- Hạn mức là hạn mức chung của tổ chức hay của model chứ không của tài khoản: chuyển tài khoản có thể không
  giúp gì; mỗi lần chuyển vẫn được ghi, và trong một vòng thử mỗi tài khoản chỉ được thử một lần (FR-016),
  nên không quay vòng tức thời.
- Attempt bị giới hạn sau khi đã sửa file trong worktree: chạy lại trên tài khoản khác giữ nguyên worktree
  như một retry do hạn mức hiện nay.
- Reviewer và worker trong cùng task dùng hai tài khoản khác nhau: được phép; tách session reviewer với
  worker vẫn như cũ.
- Người dùng đăng nhập lại tài khoản khi nó đang nghỉ: đổi token cùng danh tính không xóa nghỉ, vì hạn mức
  thuộc tài khoản chứ không thuộc token; người dùng xóa nghỉ thủ công nếu cần.
- Token của attempt bị vô hiệu vì attempt khác đã làm mới token của cùng tài khoản (spike: Claude cho đúng
  một bên thắng khi hai bên cùng làm mới): lỗi auth này không phải tài khoản hỏng; attempt chạy lại bằng bản
  nguồn mới (FR-018).
- Daemon restart khi attempt đang chạy: nếu private home của attempt còn credential đã làm mới, khi khôi
  phục hệ thống ghi nó về nguồn theo FR-022 đến FR-024 trước khi xóa private home.
- Tài khoản bị gỡ khi attempt còn chạy: thư mục tài khoản đã bị xóa nên bản làm mới trong private home bị
  bỏ, không tạo lại thư mục.
- Harness không có tài khoản nào khai và không có credential trong pin: cusr báo lỗi cấu hình như hiện nay,
  không tự tìm credential trong home của người dùng.
- Tài khoản mặc định (FR-003) trỏ tới credential mà phiên tương tác của người dùng cũng dùng: cusr chỉ đọc nó
  và không ghi về, nên khi harness trong cusr làm mới token, phiên tương tác hoặc lần chạy sau của cusr có thể
  bị đăng xuất như trước khi có feature này. Khác trước ở chỗ task không kẹt: lỗi auth của `default` chuyển task
  sang tài khoản dự phòng (FR-018).
- Người dùng gỡ `default`: cusr không tạo lại nó ở lần khởi động sau dù pin vẫn trỏ tới credential.

## Requirements *(mandatory)*

### Functional Requirements

**Tài khoản và cấu hình**

- **FR-001**: Hệ thống MUST cho người dùng có nhiều tài khoản có tên cho mỗi harness; mỗi tài khoản thuộc
  đúng một harness. Ngoài tài khoản mặc định (FR-003), mỗi tài khoản có thư mục credential riêng do cusr quản
  lý, không dùng chung với tài khoản khác hay công cụ khác.
- **FR-002**: Mỗi tài khoản MUST có thứ tự ưu tiên do người dùng đặt, mặc định `0`; hệ thống chọn tài khoản
  sẵn sàng có ưu tiên cao nhất; hòa thì tài khoản mặc định trước, sau đó theo thứ tự khai. Vì vậy thêm tài
  khoản dự phòng không đổi tài khoản đang được dùng.
- **FR-003**: Khi pin của harness trỏ tới một credential và harness chưa từng có tài khoản mặc định, hệ thống
  MUST tạo **tài khoản mặc định** `default` trỏ tới credential đó, cả khi nâng cấp lẫn khi cài mới, mà không cần
  người dùng sửa cấu hình hay tạo lại pin; hành vi chạy không đổi. Tài khoản mặc định là ngoại lệ duy nhất trỏ
  tới file ngoài thư mục của cusr: cusr chỉ đọc, MUST NOT ghi về hay xóa file đó, và không đăng nhập lại nó
  được bằng `cusr account login` (người dùng đăng nhập bằng CLI của vendor như thường). Gỡ `default` thì cusr
  MUST NOT tạo lại nó.
- **FR-004**: Pin của harness MUST không còn gắn với một tài khoản cụ thể: thêm, gỡ hay đổi tài khoản không
  đòi tạo lại pin hay proof của harness.
- **FR-005**: Hệ thống MUST từ chối thêm tài khoản khi luồng login bị hủy, thất bại, hoặc tạo ra credential
  không phải file thường, rỗng, hay không đúng định dạng vendor của harness, với lý do cụ thể; không để lại
  tài khoản hay thư mục dở dang.
- **FR-005a**: Mỗi tài khoản MUST gắn với danh tính vendor ghi nhận lúc thêm (Claude: tài khoản và tổ chức
  trong `.claude.json`; Codex: `account_id` trong `auth.json`). Token đổi mà danh tính giữ nguyên thì vẫn là
  tài khoản đó. Đăng nhập lại ra danh tính khác thì cusr MUST NOT thay credential của tài khoản; muốn đổi danh
  tính thì gỡ rồi thêm tài khoản mới. Danh tính trong nguồn khác danh tính đã ghi (chỉ có thể xảy ra với tài
  khoản mặc định, khi người dùng đăng nhập tài khoản khác trên máy) thì tài khoản MUST bị loại khỏi lựa chọn với
  lý do đổi danh tính và có mục inbox; trạng thái nghỉ và lịch sử không chuyển sang danh tính mới. Với tài khoản
  mặc định, `cusr account check` MUST nhận danh tính mới và gỡ lý do này.

**CLI**

- **FR-006**: `cusr account add <harness> --name <tên>` MUST chạy luồng login của chính CLI vendor vào một thư
  mục mới do cusr quản lý. `cusr account login <harness> <tên>` MUST đăng nhập lại một tài khoản có sẵn: login
  vào thư mục tạm, kiểm danh tính, rồi mới thay credential của tài khoản theo FR-023. cusr MUST NOT nhận đường
  dẫn tới credential có sẵn hay nhập tài khoản từ công cụ khác.
- **FR-007**: `cusr account list` MUST hiện cho từng tài khoản: harness, ưu tiên, trạng thái (sẵn sàng, đang
  nghỉ tới mốc nào và vì sao, lỗi đăng nhập, tạm ngưng), số attempt đang chạy, lần dùng gần nhất. Không bao
  giờ in nội dung credential. Vì tài khoản dùng chung toàn daemon: tên, harness, ưu tiên và trạng thái khả
  dụng hiện cho mọi người gọi có quyền `read`; số attempt, lần dùng gần nhất và danh sách task MUST chỉ tính
  trong các project người gọi được đọc; danh tính vendor, đường dẫn credential và chi tiết lỗi filesystem
  MUST chỉ hiện cho `admin`. Cùng quy tắc áp dụng cho `doctor`, report, TUI và thông báo ở FR-014a.
- **FR-008**: Tài khoản là tài nguyên toàn daemon, dùng chung cho mọi project. Người gọi có quyền `admin`
  MUST thêm, tạm ngưng, bật lại, xóa nghỉ, đổi ưu tiên, `use` và gỡ được tài khoản; mỗi thao tác ghi thành
  event kèm actor và lý do. Quyền `operate` theo project MUST NOT đủ cho các thao tác này, vì chúng ảnh hưởng
  task của project khác; quyền `read` chỉ được xem. Quyền riêng để assistant tự chuyển tài khoản để sau.
  Xóa nghỉ chỉ gỡ trạng thái nghỉ đã biết lúc thao tác; báo hết hạn mức đến sau đó (kể cả từ attempt bắt đầu
  trước thao tác) vẫn đặt lại nghỉ, và event nêu rõ lý do. Muốn chắc chắn không chọn tài khoản thì tạm ngưng.
  Gỡ tài khoản MUST xóa thư mục của chính tài khoản đó (kể cả bản chờ ghi); với tài khoản mặc định thì chỉ
  bỏ khai báo, MUST NOT xóa file của người dùng.
- **FR-008a**: `cusr account use <harness> <tên>` MUST đưa tài khoản đó lên ưu tiên cao nhất của harness, để
  từ attempt kế tiếp của mọi task, harness dùng tài khoản này. Lệnh chỉ là cách gọi tắt của đổi ưu tiên
  (FR-002, FR-008): không dừng attempt đang chạy, không gắn tài khoản vào task, và khi tài khoản này nghỉ
  hay lỗi thì vẫn chuyển sang tài khoản khác theo ưu tiên. Lệnh bị từ chối nếu tài khoản đang tạm ngưng.
- **FR-009**: `cusr doctor` MUST kiểm tra từng tài khoản (có credential, đúng loại, quyền file) mà không đọc
  nội dung ra output, cảnh báo khi hai tài khoản có cùng danh tính vendor (không tăng hạn mức), và ghi chú
  rằng tài khoản mặc định dùng chung credential với phiên tương tác (FR-003).

**Chọn tài khoản và chuyển khi hết hạn mức**

- **FR-010**: Mỗi attempt agent MUST chạy bằng đúng một tài khoản do code chọn ngay trước khi khởi chạy; lựa
  chọn được ghi thành event cùng attempt. Agent không chọn hay đổi được tài khoản. Mọi attempt, kể cả lần
  chạy lại tự động, MUST chọn theo trạng thái và ưu tiên tại lúc khởi chạy, nên thao tác của người dùng
  (tạm ngưng, gỡ, `use`) luôn thắng lựa chọn của attempt trước.
- **FR-011**: Hệ thống MUST chỉ chọn tài khoản đang sẵn sàng: không nghỉ, không lỗi đăng nhập, không đổi
  danh tính (FR-005a), không chờ ghi credential (FR-022a), không tạm ngưng và còn trong cấu hình hiện hành.
  Các nguyên nhân chặn MUST tồn tại độc lập và chỉ thao tác tương ứng gỡ được nó: hết nghỉ hay xóa nghỉ gỡ
  nghỉ, kiểm tra lại đăng nhập thành công gỡ lỗi đăng nhập, ghi xong gỡ chờ ghi, bật lại gỡ tạm ngưng. Gỡ
  một nguyên nhân không làm tài khoản sẵn sàng khi còn nguyên nhân khác.
- **FR-012**: Khi attempt thất bại vì hạn mức, hệ thống MUST đánh dấu tài khoản đó nghỉ tới `reset_at` nếu
  vendor cho biết, hoặc theo backoff hữu hạn của lớp `rate_limit` nếu không; trạng thái nghỉ dùng chung cho
  mọi task. Vì hạn mức thuộc subscription, mọi mục khai có cùng danh tính vendor nhận ra được (kể cả thuộc
  harness khác) MUST dùng chung trạng thái nghỉ; mục chưa đọc được danh tính thì nghỉ riêng. Tạm ngưng, lỗi đăng nhập và chờ ghi vẫn thuộc từng mục khai.
- **FR-013**: Sau khi đánh dấu nghỉ, nếu còn tài khoản sẵn sàng của cùng harness, hệ thống MUST chạy lại
  attempt ngay trên tài khoản đó, theo cùng cách retry do hạn mức hiện nay (giữ worktree, tiếp tục session
  khi có), không đặt timer chờ.
- **FR-014**: Khi cần chạy lại attempt (vì hạn mức hay auth), hệ thống MUST xét theo thứ tự: (1) còn tài
  khoản sẵn sàng thì chạy ngay trên đó; (2) không còn nhưng có tài khoản chỉ bị chặn bởi nghỉ hạn mức thì task chờ
  với lý do hết hạn mức và mốc chờ là thời điểm sớm nhất một tài khoản hồi lại, tới mốc thì chạy lại trên
  tài khoản vừa hồi, tiếp tục session cũ khi có, không cần người; (3) chỉ khi mọi tài khoản đều lỗi đăng
  nhập, đổi danh tính, tạm ngưng hoặc không còn trong cấu hình thì task chờ người như `auth_config` hiện nay, với lý do nêu
  tên từng tài khoản và cách sửa. Người dùng muốn giữ task lại thay vì tự chạy tiếp thì tạm ngưng tài khoản.
  Tài khoản chờ ghi credential (FR-022a) cũng tự hồi được: nếu chỉ còn tài khoản loại này, task chờ với lý
  do lỗi vận hành và backoff, không chờ người, và được xét chạy lại khi ghi xong. Nếu còn cả
  tài khoản chỉ nghỉ và tài khoản chờ ghi, hệ thống theo dõi cả mốc hồi lẫn kết quả ghi; một tài khoản
  có nhiều nguyên nhân chặn chỉ sẵn sàng khi tất cả đã được gỡ theo FR-011.
- **FR-014a**: Khi task bắt đầu chờ ở bước (2) của FR-014, hệ thống MUST ghi một thông báo để biết: harness,
  task bị ảnh hưởng, mốc tự chạy tiếp và trạng thái từng tài khoản. Thông báo không phải câu hỏi và không
  đòi trả lời; nó hiện trong `cusr report`, TUI và chi tiết task, và đi qua outbox khi có feature 003. Nhiều
  task cùng chờ một harness trong cùng đợt hết hạn mức MUST gộp thành một thông báo. Một đợt bắt đầu khi có
  task cần harness, có ít nhất một tài khoản chỉ bị chặn bởi nghỉ hạn mức và không có tài khoản chọn được;
  đợt kết thúc khi có tài khoản
  chọn được; task còn chờ slot sau đó là trạng thái chờ slot thông thường, không thuộc đợt. Đợt có định
  danh bền qua restart để không gửi lặp. Thông báo MUST phản ánh trạng thái mới nhất của đợt: thay đổi (thêm
  task, đổi mốc hồi) cập nhật thông báo hiện có theo định danh đợt thay vì tạo thông báo logic mới; đợt kết thúc thì sửa
  thông báo thành "đã có tài khoản khả dụng, task trở lại hàng đợi", không tạo thông báo logic hồi phục riêng. Đợt kết
  thúc trước khi thông báo đầu tiên được gửi thì bỏ thông báo đó; lịch sử vẫn có trong report và TUI. Bản tin không sửa được thì ghi lý do, ngừng thử và không gửi tin thay thế, như
  outbox 003. Một thông báo logic vẫn có thể có bản tin trùng khi gửi không rõ kết quả (`unknown`);
  việc sửa áp dụng cho các bản tin lưu được tham chiếu, theo feature 003.
- **FR-014b**: Khi một tài khoản của harness trở lại sẵn sàng trước mốc chờ (xóa nghỉ, thêm tài khoản, bật
  lại, `cusr account use`, kiểm tra lại đăng nhập thành công, hoặc gỡ nguyên nhân chờ ghi theo
  FR-022a/FR-023), các task đang chờ tài khoản của harness đó
  MUST được chạy lại ngay theo FR-014, không chờ tới mốc cũ. "Ngay" nghĩa là bỏ chờ hạn mức và trở lại hàng
  đợi thực thi: vẫn trong giới hạn pool (FR-020), không ngắt task đang chạy.
- **FR-015**: Chuyển tài khoản, hay chạy lại trên cùng tài khoản bằng token mới (FR-018), MUST NOT đổi
  harness, model, effort hay binding, MUST NOT tính là một nấc escalation, và MUST tiêu ngân sách lượt chạy
  như một retry do hạn mức hiện nay, dù lý do là hạn mức hay auth.
- **FR-016**: Hai báo hết hạn mức của cùng tài khoản từ hai attempt MUST hợp thành một trạng thái nghỉ (mốc
  muộn hơn thắng); mỗi attempt bị giới hạn chỉ sinh đúng một lần chạy lại. Trong một vòng thử liên tiếp của
  task, mỗi tài khoản MUST được thử nhiều nhất một lần, trừ lần thử token mới duy nhất theo FR-018;
  hết tài khoản thì chờ theo FR-014, và khi được đánh thức (FR-014b hoặc tới mốc hồi) thì mở vòng mới. Giới hạn này chặn quay vòng tức thời nhưng không chặn
  task đi qua nhiều đợt hết hạn mức trong cùng một bước; mọi lần chạy lại tuân thủ trần đã đóng băng nếu task có trần, như FR-015; task không có trần thì
  không có giới hạn tổng số lần bắt buộc.
  Vòng thử hết tài khoản mà không có mốc hồi nào ở tương lai (vd mọi `reset_at` đã qua) thì task MUST chờ
  theo backoff của lớp `rate_limit` trước khi mở vòng mới, không mở vòng ngay; đánh thức theo FR-014b vẫn áp
  dụng.
- **FR-017**: Trạng thái tài khoản (mọi nguyên nhân chặn ở FR-011) MUST bền qua restart và được khôi phục
  trước khi cấp việc mới. Replay MUST khôi phục lựa chọn tài khoản đã ghi ở FR-010 chứ không tính lại, vì
  lựa chọn phụ thuộc thời điểm chọn và tập tài khoản lúc đó.
- **FR-018**: Khi attempt thất bại vì auth mà credential nguồn đã đổi kể từ lúc attempt bắt đầu (token bị
  làm mới ở attempt khác, hoặc người dùng đăng nhập lại qua `cusr account login`), hệ thống MUST NOT đánh dấu tài khoản lỗi đăng
  nhập mà cho phép tài khoản được chọn lại bằng bản nguồn mới. Việc này chỉ được một lần trong mỗi chuỗi lỗi
  auth liên tiếp của tài khoản đó trong task; chuỗi kết thúc khi một attempt trên tài khoản chạy không lỗi
  auth. Lần chạy lại vẫn chọn tài khoản theo FR-010, nên tài khoản đã bị tạm ngưng, gỡ hay xếp sau tài khoản
  khác do `use` thì không được dùng lại; token mới không xóa nghỉ hay tạm ngưng. Các trường hợp còn lại, hệ
  thống MUST đánh dấu tài khoản lỗi đăng nhập, không chọn lại nó cho tới khi được kiểm tra lại thành công,
  tạo một mục inbox cho tài khoản đó, rồi chạy lại attempt theo thứ tự ở FR-014 (tài khoản sẵn sàng, rồi chờ
  tài khoản đang nghỉ, cuối cùng mới chờ người).
- **FR-019**: `cusr report`, chi tiết task và TUI MUST cho thấy tài khoản của từng attempt và mỗi lần chuyển
  tài khoản kèm lý do.

**Song song**

- **FR-020**: Số attempt chạy cùng lúc MUST vẫn chỉ do pool giới hạn như hiện nay. Thêm, bật lại hay xóa
  nghỉ tài khoản MUST NOT làm tăng số attempt chạy cùng lúc; tài khoản chỉ quyết định attempt chạy bằng
  subscription nào. Khi pool cho phép nhiều attempt, chúng có thể dùng chung một tài khoản theo thứ tự ưu
  tiên ở FR-002.

**Credential**

- **FR-021**: Mỗi attempt MUST vẫn chạy trong private home sạch; credential của tài khoản được đưa vào
  0600 và bị xóa sau khi artifact được lưu, như hiện nay.
- **FR-022**: Khi harness làm mới credential trong private home, hệ thống MUST ghi bản mới về thư mục của tài
  khoản ngay khi phát hiện file đổi, không đợi attempt kết thúc, và kiểm lại lần cuối trước khi xóa private
  home, bất kể attempt kết thúc thế nào, kể cả khi daemon restart giữa chừng. Ghi sớm là bắt buộc: spike cho
  thấy khi hai attempt cùng làm mới, bên thua lỗi auth ngay, và FR-018 chỉ cứu được nó nếu bản của bên thắng đã
  nằm trong nguồn. Tài khoản mặc định (FR-003) không được ghi về. Ngoài bản giữ tạm ở FR-022a, cusr không giữ
  bản credential nào khác của tài khoản.
- **FR-022a**: Khi ghi về thất bại (vd đầy đĩa, thiếu quyền), hệ thống MUST NOT xóa bản credential đã làm mới:
  bản đó được giữ ở vùng secret của cusr với quyền 0600, nghĩa vụ ghi lại bền qua restart, tài khoản bị loại
  khỏi lựa chọn và có lỗi vận hành riêng. Kết quả công việc của attempt vẫn được lưu như thường, và task đi
  tiếp các bước sau (gate, reviewer…) bằng tài khoản khác; tài khoản chờ ghi không giữ slot. Ghi lại thành công
  (tự thử lại hoặc `admin` yêu cầu) chỉ gỡ nguyên nhân chờ ghi (FR-011) và xóa bản giữ tạm. Lúc ghi lại, nguồn
  đã đổi thì theo FR-023; thư mục tài khoản đã biến mất thì MUST NOT tạo lại mà báo `admin`. Bản giữ tạm bị
  xóa khi `admin` gỡ tài khoản.
- **FR-023**: Mọi lần thay credential của tài khoản (ghi về từ attempt, đăng nhập lại) MUST nguyên tử, có khóa
  và không bao giờ để lại file hỏng. Hệ thống MUST chỉ ghi khi nguồn vẫn đúng là bản mà bên ghi đã nhận lúc
  bắt đầu; nguồn đã đổi thì giữ nguồn, bỏ bản của bên ghi và ghi event lý do, không suy bản nào mới hơn từ
  thời điểm attempt kết thúc. Vì chỉ cusr ghi vào thư mục của tài khoản, khóa của cusr đủ để bảo đảm điều này.
- **FR-024**: Hệ thống MUST NOT chép về credential trong private home nếu nó không còn là file thường, rỗng,
  không đúng định dạng vendor, hoặc thuộc danh tính khác tài khoản; trường hợp đó ghi lý do cho tài khoản.
- **FR-025**: Nội dung credential MUST NOT xuất hiện trong event, log, report, output CLI hay thông báo.

### Key Entities

- **Tài khoản (Account)**: một lần đăng nhập vào một danh tính vendor, dùng cho một harness: đăng nhập sẵn trên
  máy (tài khoản mặc định) hoặc do cusr đăng nhập (tài khoản dự phòng). Thuộc tính: tên, harness, thư mục
  credential do cusr quản lý (hoặc file của người dùng với tài khoản mặc định), danh
  tính vendor ghi nhận lúc thêm, ưu tiên, trạng thái tạm ngưng do người dùng đặt. Là tài nguyên toàn daemon,
  không thuộc project.
- **Trạng thái tài khoản**: tập các nguyên nhân chặn độc lập (đang nghỉ tới mốc nào, vì attempt nào, mốc từ
  vendor hay từ backoff; lỗi đăng nhập từ attempt nào; đổi danh tính; chờ ghi credential; tạm ngưng); rỗng
  nghĩa là sẵn sàng. Trạng thái nghỉ thuộc danh tính vendor, các nguyên nhân khác thuộc từng mục khai. Dùng
  chung cho mọi task, bền qua restart.
- **Đợt hết hạn mức**: khoảng thời gian mọi tài khoản dùng được của một harness đều đang nghỉ; có định danh
  bền, dùng để gộp thông báo ở FR-014a.
- **Lựa chọn tài khoản của attempt**: attempt nào chạy bằng tài khoản nào, chọn lúc nào, và là lần chạy đầu
  hay chuyển từ tài khoản khác vì lý do gì.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Với hai tài khoản và một tài khoản bị giới hạn, attempt kế tiếp bắt đầu trên tài khoản còn lại
  trong vòng 30 giây kể từ lúc lỗi hạn mức được ghi, không qua timer chờ hạn mức, khi pool còn slot và các
  điều kiện khởi chạy khác đã đủ.
- **SC-002**: Trong bộ kiểm thử fake, 100% lần chuyển tài khoản giữ nguyên model, effort và binding, và
  không lần nào được tính là escalation.
- **SC-003**: Sau 50 attempt liên tiếp trên một tài khoản dự phòng mà mỗi attempt làm mới credential, tài khoản
  vẫn đăng nhập được; phiên tương tác và Orca của người dùng trên cùng subscription (đăng nhập riêng) không bị
  đăng xuất. Tài khoản mặc định không thuộc tiêu chí này: nó dùng chung credential với phiên tương tác nên giữ
  hành vi như trước feature (FR-003).
- **SC-004**: Với 10 attempt cùng tài khoản kết thúc đồng thời, credential của tài khoản luôn là một bản hợp
  lệ, đầy đủ (0 lần file hỏng trong 100 lần chạy kiểm thử).
- **SC-005**: Người dùng thêm một tài khoản bằng một lệnh login và thấy nó sẵn sàng trong `cusr account list`,
  không cần sửa file cấu hình, tạo lại pin hay restart daemon.
- **SC-006**: Cấu hình một tài khoản hiện có chạy được sau nâng cấp mà không phải sửa gì, và cho cùng kết
  quả với bộ kiểm thử hiện có.
- **SC-007**: Kiểm tra event, log, report và output CLI sau một lượt chạy có chuyển tài khoản không tìm thấy
  token hay nội dung credential nào.
- **SC-008**: Restart daemon khi một tài khoản đang nghỉ không làm tài khoản đó được chọn trước mốc hồi.

## Assumptions

- Hạn mức subscription gắn với tài khoản đăng nhập: khi tài khoản A bị giới hạn, tài khoản B của vendor đó
  thường vẫn chạy được. Nếu thực tế không như vậy (vd giới hạn theo tổ chức), FR-016 và edge case về số lần
  chuyển giữ cho hành vi không tệ hơn hiện nay.
- Tập tài khoản là tài nguyên lúc chạy, không phải policy: nó không bị đóng băng vào task. Thêm tài khoản
  có hiệu lực từ attempt kế tiếp của mọi task, gỡ hoặc tạm ngưng thì không chọn nữa. Điều này khớp với việc
  pin hiện không ghi digest cho auth vì auth tự thay đổi. Binding, model và pool vẫn bất biến theo revision.
- Claude cho biết `reset_at` qua `rate_limit_event`; Codex hiện không, nên tài khoản Codex nghỉ theo backoff
  hữu hạn của lớp `rate_limit`. Đọc được mốc reset của Codex là cải tiến sau, không chặn feature.
- Tiếp tục session trên tài khoản khác dựa trên việc session được chép giữa các private home mà không chép
  auth; giả định vendor chấp nhận resume session do tài khoản khác tạo. Chưa kiểm chứng (spike S1); vendor nào
  không cho thì lần chạy lại trên tài khoản khác bắt đầu session mới.
- Credential là file trên Linux (`.credentials.json` của Claude, `auth.json` của Codex với file store).
  Codex cấu hình lưu credential bằng keyring thì không được hỗ trợ và `doctor` báo rõ.
- Đăng nhập dùng luồng login của chính CLI vendor (`claude auth login`, `codex login --device-auth`), chạy
  tương tác trong terminal của người dùng; cusr không tự làm OAuth. Vendor cho nhiều lần đăng nhập cùng lúc
  vào một tài khoản, mỗi lần một refresh token riêng (spike S3, S4).
- Hành vi làm mới token đã được spike kiểm chứng: refresh token của Claude và Codex được xoay sau mỗi lần làm
  mới; Claude chỉ cho một bên thắng khi hai bên cùng làm mới từ một refresh token, Codex chấp nhận cả hai
  trong khoảng đã thử ([spike-report.md](spike-report.md)).
- Feature này không phụ thuộc feature 003. Mục inbox ở FR-018 là mục tài khoản trong inbox hiện có, chỉ hiện cho
  `admin`; khi 003 có thì mục đó và thông báo ở FR-014a đi qua outbox như mọi việc cần người khác.
