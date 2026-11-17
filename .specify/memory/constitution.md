# Cuesura Constitution

Hiến chương này ràng buộc mọi đặc tả, kế hoạch, task và mã nguồn của Cuesura (`cusr`).
Chi tiết vận hành nằm trong [SPEC.md](../../SPEC.md); khi hai tài liệu mâu thuẫn, hiến chương
thắng và SPEC.md phải được sửa.

## Core Principles

### I. Lõi điều phối tất định

- Mọi chuyển trạng thái và quyết định bước tiếp theo MUST do code thuần thực hiện. Không có
  Primary AI chạy liên tục; LLM không được làm event handler, scheduler hay người quyết định
  trạng thái task.
- `decide` và `evolve` MUST là hàm thuần: cùng state, workflow, policy và input đã ghi nhận thì
  cho cùng events/commands; không I/O, không đọc đồng hồ, không sinh số ngẫu nhiên. `now`, ID và
  jitter được tạo ngoài engine và ghi nhận khi cần tái hiện.
- Thứ tự event MUST lấy từ sequence đã commit, không suy ra từ ID hay thời gian hệ thống.
- Báo cáo trạng thái và usage thông thường MUST dựng bằng code từ dữ liệu đã ghi, không gọi LLM.

**Lý do:** điều phối tốn 0 token, mỗi quyết định giải thích và tái hiện được, và property test
có thể phủ rộng không gian quyết định.

### II. Effect sau commit, idempotent, khôi phục được

- Một daemon (`cusrd`) MUST là bên duy nhất ghi kho trạng thái. CLI, assistant, runner và adapter
  không ghi trực tiếp vào database.
- Một trigger MUST được chấp nhận trong một transaction (dedup, events, projection, outbox,
  timers). Effect bên ngoài chỉ chạy sau commit; transaction không spawn, gọi mạng hay `await`.
- Mọi thao tác logic MUST có idempotency key ổn định. Kết quả không rõ sau timeout/crash MUST được
  probe đối chiếu trước khi thử lại; probe thiếu bằng chứng trả `unknown`, không coi là
  "chưa xảy ra".
- Ngoại lệ duy nhất cho điều trên: gửi hoặc sửa thông báo tới kênh không có idempotency hay probe tin
  cậy (SPEC.md §13.2) MAY được thử lại sau kết quả `unknown`, chấp nhận người dùng thấy bản trùng. Mọi
  bản trùng MUST mang cùng mã thông báo, câu hỏi hoặc yêu cầu, và thao tác qua bất kỳ bản nào MUST quy
  về cùng một đối tượng. Ngoại lệ MUST NOT áp cho quyết định, approval, merge hay effect nào làm đổi
  trạng thái bên ngoài ngoài việc hiển thị tin.
- Khởi động lại MUST nhận lại attempt, PR và effect đang dở thay vì tạo bản thứ hai; không spawn
  thay thế khi chưa chứng minh attempt cũ đã kết thúc; không reset worktree chỉ vì HEAD lệch
  checkpoint.

**Lý do:** crash ở bất kỳ điểm nào không được làm mất trạng thái đã commit hay lặp push, PR,
comment hoặc merge đã thành công.

### III. Vòng lặp có giới hạn, task không có budget

- Vòng lặp giữa các step (`max_visits`) MUST có trần. Các trần của task (lượt vào step, lượt thử mỗi nấc, retry,
  ngân sách và deadline khi có) là trần thử lại trước khi task chờ; khi chạm trần, deputy hoặc người có quyền MAY mở
  lại chúng bằng lệnh có actor và lý do. Lượt gọi deputy không có trần và không tính vào ngân sách hay trần nào của
  task. Lượt agent, wall time và
  budget của task không có trần bắt buộc; retry hạ tầng dùng backoff tăng dần và trần số lần là tùy
  chọn. Task cũ giữ trần đã đóng băng: không bắt đầu attempt khi vượt trần đó. Khi policy yêu cầu approval (nấc
  `needs_approval`), attempt MUST NOT bắt đầu nếu chưa có approval hợp lệ, tức gắn đúng
  task/revision, step, nấc và policy hash. Nấc `auto` không chờ duyệt.
- Không có trần không có nghĩa là được lặp: daemon MUST từ chối lệnh của deputy lặp lại cùng hành động trên cùng chữ ký
  lỗi khi chưa có bằng chứng mới; mỗi loại hành động MUST tự cạn theo quy tắc của code; khi mọi loại đã cạn mà không có
  tiến triển, chỉ còn kết thúc task hoặc chuyển cho người, và lượt không chọn thì code kết thúc task. Chữ ký lỗi, bằng
  chứng mới và tiến triển MUST được tính bằng code từ dữ liệu đã ghi, không từ lời của agent.
- Task đang chờ MUST có lý do, điều kiện tiếp tục và đường kết thúc. Trạng thái kết thúc không tự
  mở lại; retry sau kết thúc tạo task mới có liên kết nguồn.
- Usage MUST phân biệt `reported`, `estimated`, `unavailable`; không ghi 0 thay cho dữ liệu thiếu.
  Không cam kết trần USD cứng với harness chưa kiểm chứng được cơ chế giới hạn chi phí.

**Lý do:** dừng worker giữa việc vì hết budget tốn hơn là để nó làm xong; workflow vẫn kết thúc nhờ
`max_visits`, còn usage vẫn được ghi để người dùng thấy và hủy khi cần.

### IV. Bằng chứng, không phải lời agent

- Exit code thành công hay việc agent nói "xong" MUST NOT đủ để qua bước. Kết quả phải đúng schema,
  đúng attempt và đạt mọi gate bắt buộc theo policy/chế độ đã được xác nhận.
  `full-review` MUST có review; `direct-pr` không yêu cầu review, không giả bằng chứng approve
  và tự nó không miễn gate/CI hay cấp quyền merge.
- Deputy MAY miễn một finding của review, một gate hay một check CI cụ thể của một task khi có bằng chứng, gắn với chữ ký
  lỗi đang gặp. Bản miễn MUST là event có actor, lý do và bằng chứng, MUST được liệt kê trong mô tả PR và báo cáo, và MUST
  NOT được báo là đạt. Lỗi mang chữ ký khác không được bản miễn cũ che. Bản miễn không áp cho required check của
  protected branch: merge vào đó vẫn do người dùng quyết.
- Required checks ở trạng thái pending, cancelled, missing hoặc unknown MUST NOT được coi là pass.
- Reviewer MUST dùng session riêng với coder và chỉ nhận dữ liệu cần thiết (diff có giới hạn kích
  thước). Reviewer MAY sửa và chạy kiểm tra trong worktree; thay đổi của nó MUST NOT vào task: daemon
  MUST ghi bền mốc trước khi chạy và trả worktree về mốc đó, kể cả sau khi daemon khởi động lại. Vendor/model
  có thể giống coder; không mặc định ưu tiên khác vendor.

**Lý do:** agent có thể tự tin mà sai; chỉ tín hiệu kiểm chứng được mới đẩy workflow tiến lên.

### V. Người dùng giữ quyền kiểm soát

- Workflow, policy, role/model binding và input gốc MUST bất biến theo revision. Thay đổi cần
  event, actor, lý do và revision mới. Agent MUST NOT tự đổi role, quyền, binding, approval, pool
  hay ngân sách của mình. Assistant caller tự khai là `assistant` (`CUSR_ACTOR`) và daemon giới hạn nó ở
  `read`/`operate`: được xác nhận run config của task nó điều phối, theo digest và có ghi actor, được duyệt
  escalation trong ladder đã đóng băng (#205), được sửa policy của bước đang chờ (`amend-policy`: model trong
  `allow_models` và trạng thái nấc của profile, ngân sách, deadline), không được duyệt nhận PR có sẵn hay dùng quyền
  admin. Lệnh ghi lên goal từ assistant MUST đến từ phiên đang giữ lease, để tin của goal về đúng phiên đó. Deputy
  (actor `deputy`, do daemon gắn khi khởi chạy nó) có cùng quyền `read`/`operate`, MUST ghi lý do cho mọi thao tác ghi
  và MUST NOT xác nhận intake, run config hay kế hoạch của bất kỳ task hay goal nào. Tên actor không phải bằng chứng
  quyền: lệnh của deputy chỉ được nhận khi mang ID của một lượt đang chạy do daemon cấp, nhắm vào task hoặc goal của
  lượt đó, và thuộc bảng quyền của deputy. Đây là rào chắn cho caller làm đúng quy ước, không phải ranh giới bảo
  mật với process cùng UID. Worker không gọi `cusr`.
- Kế hoạch của một goal được người dùng, hoặc assistant giữ lease, xác nhận một lần theo hash; lần xác nhận đó là xác
  nhận intake và run config của mọi đơn vị trong kế hoạch. Sau đó deputy MAY đổi thứ tự, phụ thuộc, model trong
  `allow_models`, chỉ dẫn và giới hạn của đơn vị, mỗi lần ghi version kế hoạch mới kèm lý do. Thêm hay bỏ đơn vị, đổi
  tiêu chí nghiệm thu, nới phạm vi hay đổi hành vi sản phẩm MUST được duyệt lại.
- Code chỉ nâng effort/model/vendor theo thang đã duyệt trước, kích hoạt theo phân loại lỗi.
  Lỗi hạ tầng hoặc hết hạn mức MUST NOT kích hoạt nâng model; không hạ model ngầm. Ngoài thang, đổi model cho bước
  đang chờ chỉ đi qua `amend-policy` của caller `operate` hoặc owner, có event, actor và lý do.
- Effect merge do Cuesura gửi MUST chỉ do code thực hiện sau khi kiểm tra quyền, head/base SHA,
  gate/CI, review theo chế độ và approval cho thao tác merge. Auto-merge của `full-review` MUST có
  reviewer approve; `direct-pr` auto-merge khi gate và CI xanh, không có reviewer đọc diff. Deputy và agent không quyết định merge. Người dùng
  có thể merge thủ công trên GitHub theo quyền/branch protection; Cuesura MUST đối chiếu bằng chứng
  thao tác bên ngoài đó, không giả approval/review và không đòi merge qua guard của effect nội bộ.
  Mặc định người duyệt từng merge vào protected branch; chế độ yolo
  chỉ người dùng admin bật qua kênh tin cậy, không bao giờ qua `cusr.yaml` của repo, và được kiểm
  tra lại ngay lúc dispatch merge.
- Cuesura MAY merge PR của một đơn vị vào nhánh tích hợp mà nó tạo cho goal có kế hoạch đã xác nhận, bằng merge commit,
  sau cùng các kiểm tra như auto-merge (quyền, head/base SHA, gate, CI, review theo chế độ, bản miễn đã ghi), và chỉ khi
  nhánh đó không thuộc protected branch. PR của goal vào nhánh gốc theo quy tắc merge ở trên: người dùng
  merge, hoặc yolo do người dùng admin bật; goal không mở thêm đường auto-merge nào vào protected branch.
- Deputy làm thay người dùng trên task và goal: daemon chỉ gọi nó khi task đã vào wait mà bảng định tuyến giao cho
  deputy, hoặc khi goal cần lập hay sửa kế hoạch; câu hỏi về spec và yêu cầu của worker chỉ tới deputy khi người dùng bật `autonomous` qua kênh tin cậy. Wait về
  credentials, harness từ chối, vi phạm ranh giới, merge và xác nhận task luôn tới người. Deputy MUST NOT merge, bật
  yolo hay nhận PR có sẵn. Thao tác của người dùng thắng thao tác của deputy. Mỗi thao tác của deputy MUST được ghi lại
  với lý do và giải thích được; lật lại nghĩa là người dùng thao tác tiếp, revert hoặc tạo task mới, và deputy không
  giả vờ hoàn tác side effect bên ngoài.

**Lý do:** policy, chi phí, quyền ghi và merge thuộc về người dùng; kết quả giữa các lần chạy
phải so sánh được.

### VI. Lõi trung lập với domain, ngôn ngữ và vendor

- Engine MUST NOT chứa kiến thức về ngôn ngữ lập trình, build tool, nhà cung cấp model hay kênh
  nhận task. Gate, setup, bộ lọc log và tài nguyên do từng repo khai báo trong `cusr.yaml`;
  harness, nguồn task và kênh liên lạc là adapter có hợp đồng.
- Adapter MUST NOT quyết định retry, escalation hay trạng thái task.
- Mọi task từ mọi nguồn MUST được chuẩn hoá và dedup về một format trước khi vào engine.

**Lý do:** phát triển phần mềm chỉ là use case đầu tiên; thêm workflow, harness hay repo mới
không được đòi sửa engine.

### VII. Kiểm chứng bằng kiểm thử và báo cáo trung thực

- Mỗi bất biến I01–I12 trong SPEC.md MUST có bằng chứng ở tầng thực sự kiểm chứng được nó:
  - Logic quyết định (`decide`/`evolve`, policy, escalation, ngân sách): property test bằng
    fast-check.
  - Store, outbox, timer và recovery (single writer, transaction nguyên tử, idempotency, sequence):
    integration test trên SQLite thật, kèm crash injection.
  - Runner, executor, worktree và merge: contract test với Clock inject, fake ports/harness và
    fixture. Harness thật chạy trong smoke test riêng.
- Property test của engine thuần MUST NOT được dùng làm bằng chứng cho bất biến nằm ở tầng I/O.
- Typecheck, lint, test và build là các kiểm tra riêng; một bên xanh không thay thế bên khác.
- Một gate hoặc tiêu chí nghiệm thu chưa đạt MUST được báo là chưa đạt; gate được deputy miễn MUST được báo là miễn
  kèm lý do. Không thay bằng kiểm tra mô phỏng rồi coi tương đương. Giả định chưa có bằng chứng (spike) MUST NOT được trình bày như
  tính năng đã có.

**Lý do:** độ tin cậy là giá trị cốt lõi của sản phẩm; nó chỉ tồn tại khi được đo và nói thật.

### VIII. Đơn giản, không đầu cơ

- MUST NOT thêm durable-execution framework, message broker, database server, ORM hay DI container
  chỉ để chuẩn bị cho khả năng mở rộng chưa cần.
- Tính năng ngoài phạm vi v1 trong SPEC.md MUST NOT được triển khai sớm; cắt phạm vi phải ghi rõ
  phiên bản thu hẹp và không giảm chuẩn tin cậy của phần còn lại.
- Độ phức tạp vượt baseline MUST được biện minh trong mục Complexity Tracking của plan.

**Lý do:** dự án được xây để thay thế các công cụ có hàng trăm module không nối vào luồng chính;
mỗi thành phần phải được dùng thật.

## Ràng buộc kỹ thuật và bảo mật

- **Stack baseline:** Node 24 LTS, TypeScript strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`, `noEmitOnError`), ESM build bằng
  `tsc`, SQLite qua `better-sqlite3` sau một module store mỏng, Zod 4, Commander, `yaml`, Vitest,
  fast-check, pnpm với lockfile frozen, ESLint + typescript-eslint + Oxfmt. Đổi baseline cần
  amendment của SPEC.md §17.
- **Exhaustiveness:** switch trên domain union kết thúc bằng `assertNever`; không cast sang `never`.
- **SQLite:** WAL, `synchronous=FULL`, foreign keys, busy timeout hữu hạn; unique constraint bảo
  vệ event sequence, source dedup, request ID và effect idempotency key.
- **Môi trường v1:** một người dùng, Linux/Ubuntu hoặc WSL2, worktree và dữ liệu runtime trên
  filesystem Linux cục bộ.
- **Trust boundary:** quyền `read`/`operate`/`admin` MUST được kiểm tra ở application service.
  Theo quyết định chủ dự án ngày 2026-11-01 ([ADR-0005](../../docs/adr/0005-native-harness-permissions.md)),
  Cuesura chạy harness trực tiếp trong worktree riêng, không dùng outer bwrap. Sandbox và quyền tool
  MUST do harness quản lý: mặc định auto review/approve, full access chỉ khi owner chọn rõ trong pin.
  Sandbox worker Claude MAY bật/tắt độc lập với permission mode, mặc định tắt; reviewer dùng ranh giới của fixer.
  Deputy chạy với toàn quyền của harness; thay đổi của nó trong worktree của task MUST NOT vào task: daemon MUST ghi bền mốc trước mỗi lượt và trả
  worktree về mốc đó sau lượt, kể cả sau khi daemon khởi động lại, như với reviewer.
  Không hứa ngăn process cùng UID đọc home/secret hoặc truy cập socket/metadata ngoài worktree.
  Worktree không phải sandbox bảo mật. Các quyền workflow, approval và merge MUST giữ nguyên.
- **Secret:** che trước khi lưu hoặc xuất log. Secret mà lệnh cần để chạy MUST NOT đi qua artifact đã che;
  nó được giao qua file riêng mode 0600 trong run dir, runner xóa trước khi spawn, daemon xóa khi run không
  bắt đầu, và không file nào khác giữ bản rõ. Không force-push mù; không xoá worktree còn dữ liệu
  chưa bảo toàn.

## Quy trình phát triển và cổng chất lượng

- Tính năng đi theo chuỗi Spec Kit: specify → clarify → plan → tasks → implement. Plan MUST có
  "Constitution Check" đối chiếu các nguyên tắc I–VIII trước và sau thiết kế.
- Thay đổi mã nguồn hoặc cấu hình thực thi (package, tsconfig, cấu hình lint/test, schema,
  migration) MUST qua typecheck, lint, test và build. Thay đổi chạm engine, store, outbox,
  recovery hay merge MUST kèm test ở tầng tương ứng theo nguyên tắc VII.
- Thay đổi chỉ gồm tài liệu MUST qua kiểm tra phù hợp với tài liệu: liên kết nội bộ còn đúng, các
  mã I/S/R/§ khớp SPEC.md, không còn placeholder.
- Khi một kiểm tra chưa tồn tại (ví dụ giai đoạn bootstrap chưa có mã nguồn hay script), báo cáo
  MUST ghi kiểm tra đó là "chưa khả dụng" kèm lý do; không được coi là pass.
- Reliability Gate R1–R9 trong SPEC.md §18 là điều kiện bắt buộc để phát hành v1. Nhóm fake chạy
  tự động; smoke với harness thật được tách riêng vì tiêu thụ usage.
- Mỗi hành trình S01–S10 MUST truy vết được tới bằng chứng nghiệm thu.

## Governance

- Hiến chương này đứng trên mọi tài liệu và thói quen khác của dự án. Review spec, plan và PR
  MUST xác nhận tuân thủ; vi phạm MUST được sửa trước khi merge, trừ khi có ngoại lệ hợp lệ.
- Complexity Tracking chỉ dùng để biện minh độ phức tạp vượt baseline (nguyên tắc VIII), ví dụ
  thêm dependency, project hay tầng trừu tượng. Nó MUST NOT được dùng để miễn yêu cầu MUST/MUST
  NOT nào khác.
- Ngoại lệ với một yêu cầu MUST/MUST NOT chỉ hợp lệ khi chủ dự án phê duyệt rõ ràng và được ghi
  trong plan của feature, gồm: nguyên tắc và điều khoản được miễn, phạm vi, lý do, rủi ro, biện
  pháp bù và điều kiện kết thúc. Không ngoại lệ nào được nới yêu cầu về quyền, approval, merge,
  secret hay không lặp side effect (nguyên tắc II, V và trust boundary); muốn đổi những điều đó
  phải amendment hiến chương.
- Amendment cần: mô tả thay đổi, lý do, tác động lên SPEC.md và các template Spec Kit, và Sync
  Impact Report. Chỉ người dùng (chủ dự án) phê duyệt amendment; agent không tự sửa hiến chương.
- Versioning theo SemVer: MAJOR khi bỏ hoặc định nghĩa lại nguyên tắc theo cách không tương thích;
  MINOR khi thêm nguyên tắc/mục hoặc mở rộng đáng kể; PATCH khi làm rõ câu chữ.
- Hướng dẫn vận hành chi tiết nằm trong [SPEC.md](../../SPEC.md) và
  [docs/architecture.md](../../docs/architecture.md).

**Amendment 2026-11-01 (chủ dự án):** 2.0.0 → 3.0.0 vì thay ranh giới truy cập bắt buộc
bằng quyền native của harness, bao gồm lựa chọn full access của owner. Phạm vi là thực thi tool trên
host; không thay nguyên tắc II/V về idempotency, quyền application, review và merge. Đồng bộ SPEC §15.2,
hợp đồng execution và runbook; các template đọc hiến chương hiện hành, không cần đổi cấu trúc.

**Amendment 2026-11-01 (chủ dự án):** 3.0.0 → 4.0.0 vì định nghĩa lại nguyên tắc III và nới xác nhận
run config ở nguyên tắc V: bỏ trần bắt buộc với lượt agent, wall time và budget của task, kể cả trần số
lần của retry hạ tầng đã bỏ ở #47; token `operate` được xác nhận run config. Giữ nguyên: người dùng merge
PR, review và gate theo chế độ, digest của run config, `max_visits`, `task approve` của admin cho nấc
escalation cần duyệt. Đồng bộ SPEC §5.2, §9.4, skill `cusr`, runbook và dogfooding; các template đọc hiến
chương hiện hành, không cần đổi cấu trúc.

**Amendment 2026-11-01 (chủ dự án):** 4.0.0 → 5.0.0 vì cho `direct-pr` auto-merge dưới yolo, không có
reviewer. Cuesura vẫn là code gửi merge sau khi kiểm tra; agent không gọi merge và không quyết định merge.
Đồng bộ SPEC §14.2 và I11, runbook; các template đọc hiến chương hiện hành, không cần đổi cấu trúc.

**Amendment 2026-11-03 (chủ dự án):** 5.0.0 → 6.0.0 vì định nghĩa lại nguyên tắc III và V cho decider: bỏ trần
số lần gọi, thay bằng quy tắc không hỏi qua đáp lại (ngoại lệ nhãn `grill`), và lật lại là revert hoặc tạo task
mới. Giữ nguyên: decider không cấp approval, không merge, không đổi trạng thái task ngoài việc trả lời câu hỏi của worker. Đồng
bộ SPEC §10 và runbook; các template đọc hiến chương hiện hành, không cần đổi cấu trúc.

**Amendment 2026-11-03 (chủ dự án):** 6.0.0 → 6.1.0 vì đưa vào nguyên tắc II ngoại lệ đã có ở SPEC §13.2: thông
báo tới kênh không probe được (Telegram) được gửi lại sau kết quả `unknown` với cùng mã, chấp nhận bản trùng. Giữ
nguyên: mọi thao tác khác vẫn phải probe trước khi thử lại; quyết định, approval và merge không bao giờ được lặp vì tin
trùng. SPEC.md không đổi vì §13.2 đã nêu đúng quy tắc này; plan của feature 003 dẫn điều khoản mới; các template đọc
hiến chương hiện hành, không cần đổi cấu trúc.

**Amendment 2026-11-04 (chủ dự án):** 6.1.0 → 6.1.1 thay Prettier bằng Oxfmt trong
stack baseline để thống nhất formatter và kiểm tra định dạng. SPEC §17 được đồng bộ; các template
Spec Kit không chỉ định formatter và tiếp tục đọc hiến chương hiện hành, nên không cần sửa.
Các gate typecheck, lint, test và build vẫn bắt buộc.

**Sync Impact Report 2026-11-04:** baseline kỹ thuật đổi Prettier → Oxfmt; không đổi nguyên tắc
I–VIII. SPEC §17 và hướng dẫn formatter được cập nhật; template Spec Kit đã kiểm tra, không cần
thay đổi. Không có mục đồng bộ còn chờ.

**Amendment 2026-11-05 (chủ dự án):** 6.1.1 → 7.0.0 vì định nghĩa lại cách nguyên tắc V tách assistant
khỏi owner: bỏ access token. Caller tự khai actor qua `CUSR_ACTOR`; không khai là owner. Quyền truy cập
socket điều khiển chỉ dựa vào file mode (thư mục 0700, socket 0600), như trước đây trên thực tế, vì process
cùng UID vốn đọc được `owner.token`. Bỏ phạm vi project theo token. Giữ nguyên: assistant chỉ có
`read`/`operate`, không approve escalation, không bật yolo; người dùng merge PR. Đồng bộ runbook, skill
`cusr`, dogfooding, hợp đồng CLI–daemon và ADR 0011; các template đọc hiến chương hiện hành, không cần đổi
cấu trúc.

**Sync Impact Report 2026-11-05:** nguyên tắc V đổi cơ chế tách owner/assistant từ token sang actor tự
khai. SPEC §5.2 và §15, `deploy/README.md`, `docs/dogfooding.md`, skill `cusr`, README và
`specs/002-task-to-green-pr/contracts/cli-daemon.md` được cập nhật; template Spec Kit đã kiểm tra, không cần
thay đổi. Không có mục đồng bộ còn chờ.

**Amendment 2026-11-06 (chủ dự án):** 7.0.0 → 8.0.0 vì định nghĩa lại nguyên tắc IV và trust boundary: reviewer
không còn chỉ đọc mà chạy như fixer, được sửa, chạy kiểm tra và commit; daemon ghi bền mốc HEAD/cây làm việc trước
khi chạy và trả worktree về mốc đó, nên thay đổi của reviewer không vào task. Chỉ decider giữ sandbox chỉ đọc.
Làm rõ thêm đường giao secret cho lệnh: không qua artifact đã che, file riêng 0600 bị xóa trước khi spawn. Giữ
nguyên: reviewer dùng session riêng, approval gắn SHA cụ thể, decider và agent không quyết định merge. Đồng bộ
SPEC §7, §9, §14 và §15.2, hợp đồng execution, ADR-0005, runbook; các template đọc hiến chương hiện hành, không cần đổi
cấu trúc.

**Sync Impact Report 2026-11-06:** nguyên tắc IV và trust boundary đổi quyền của reviewer và đường giao secret.
`SPEC.md`, `specs/002-task-to-green-pr/contracts/execution.md`, `docs/adr/0005-native-harness-permissions.md`,
`deploy/README.md` và `docs/architecture.md` được cập nhật; template Spec Kit đã kiểm tra, không cần thay đổi.
Không có mục đồng bộ còn chờ.

**Amendment 2026-11-08 (chủ dự án):** 8.0.0 → 9.0.0 vì định nghĩa lại nguyên tắc V: assistant (`operate`) được
duyệt escalation (`task approve --kind escalation`), không còn là việc riêng của owner. Lý do (#205): nấc được
duyệt đã nằm trong ladder người dùng cấu hình và đóng băng vào policy, còn actor tự khai không phải ranh giới
quyền thật, nên đòi admin chỉ làm task đứng chờ một bước cơ học. Giữ nguyên: engine vẫn kiểm request mở, revision,
step, rung, policy hash và ngân sách; duyệt nhận PR có sẵn, bật yolo và quyền admin vẫn thuộc owner; agent không
merge. Đồng bộ SPEC §5.2 và §15, hợp đồng CLI–daemon, TUI và Telegram, runbook, dogfooding, skill `cusr`, README
và ADR-0011 (PR #225); các template đọc hiến chương hiện hành, không cần đổi cấu trúc.

**Sync Impact Report 2026-11-08:** nguyên tắc V đổi quyền duyệt escalation từ `admin` sang `operate`.
`SPEC.md`, `specs/002-task-to-green-pr/contracts/cli-daemon.md`, `specs/004-terminal-tui/contracts/tui.md`,
`specs/003-telegram-channel/contracts/telegram.md`, `deploy/README.md`, `docs/dogfooding.md`, `README.md`,
skill `cusr` và `docs/adr/0011-declared-actor-instead-of-tokens.md` đã cập nhật trong PR #225; template Spec
Kit đã kiểm tra, không cần thay đổi. Không có mục đồng bộ còn chờ.

**Amendment 2026-11-08 (chủ dự án):** 9.0.0 → 10.0.0 vì định nghĩa lại nguyên tắc III, V và trust boundary cho
deputy (feature 007, spec ở PR #253): deputy thay decider, làm thay người dùng trên một task khi
task vào wait cần người. Nguyên tắc III: các trần của task là trần thử lại trước khi chờ, deputy hoặc người có quyền mở
lại bằng lệnh có actor và lý do; lượt deputy không có trần và nằm ngoài ngân sách; bỏ quy tắc một câu trả lời của
decider mỗi step và nhãn `grill`. Nguyên tắc V: actor `deputy` có `read`/`operate` như assistant, phải ghi lý do, không
xác nhận task; assistant và deputy được `amend-policy` (đổi model trong `allow_models`, ngân sách, deadline của bước đang
chờ); đổi model ngoài thang chỉ qua `amend-policy` có actor và lý do. Trust boundary: deputy toàn quyền, thay đổi trong
worktree của task bị trả về theo mốc như reviewer. Giữ nguyên: engine quyết định mọi chuyển trạng thái (nguyên tắc I),
code là bên duy nhất gửi merge, deputy và agent không merge, không bật yolo, không nhận PR có sẵn, credentials và
refusal luôn tới người. Decider hiện có vẫn tuân thủ vì hẹp hơn deputy, cho tới khi feature 007 thay nó.

**Sync Impact Report 2026-11-08:** nguyên tắc III, V và trust boundary đổi cho deputy. Phần đồng bộ được làm cùng phần
hiện thực ở lát F của feature 007, để tài liệu vận hành không mô tả hành vi chưa có: `SPEC.md` §4 (I09), §9.3, §10,
§14.1, §15.1, §15.2; `deploy/README.md` mục Autonomous; ADR-0005; một ADR mới cho lượt tương tác của deputy (thay
ADR-0006 riêng cho role này); `GLOSSARY.md`; `docs/architecture.md`; `specs/003-telegram-channel/spec.md`; skill `cusr`.
Template Spec Kit đã kiểm tra, không cần thay đổi. Mục đồng bộ còn chờ: các tài liệu vừa nêu.

**Amendment 2026-11-09 (chủ dự án):** 10.0.0 → 11.0.0 vì định nghĩa lại nguyên tắc III, IV, V và VII cho deputy
theo lượt và goal nhiều đơn vị (feature 007 viết lại). Nguyên tắc III: không trần tổng nhưng code chặn lặp (cùng hành
động trên cùng chữ ký lỗi khi không có bằng chứng mới), mỗi loại hành động tự cạn, cạn hết thì chỉ còn kết thúc hoặc
chuyển cho người. Nguyên tắc IV và VII: deputy được miễn một finding, gate hay check CI cụ thể có bằng chứng, ghi thành
event, liệt kê trong PR, báo là miễn chứ không phải đạt, không áp cho required check của protected branch. Nguyên tắc
V: kế hoạch goal xác nhận một lần theo hash thay cho xác nhận từng đơn vị; deputy đổi chi tiết thực thi trong kế hoạch,
đổi phạm vi phải duyệt lại; Cuesura merge PR đơn vị vào nhánh tích hợp của goal bằng merge commit; quyền của deputy dựa
trên ID lượt đang chạy, task/goal của lượt và bảng quyền, không dựa trên tên actor; lệnh ghi goal từ assistant phải từ
phiên giữ lease. Giữ nguyên: engine quyết định mọi chuyển trạng thái, code là bên duy nhất gửi merge, deputy và agent
không merge, goal không thêm đường auto-merge nào vào protected branch ngoài yolo, PR của goal theo quy tắc merge hiện hành, deputy không xác nhận task hay kế
hoạch, credentials và refusal luôn tới người.

**Sync Impact Report 2026-11-09:** nguyên tắc III, IV, V, VII đổi cho deputy theo lượt, bản miễn và goal. Spec, plan,
research, data model, contracts và tasks của feature 007 được viết lại cùng amendment. Phần đồng bộ tài liệu vận hành
gộp với mục còn chờ của amendment 10.0.0 và làm ở lát cuối của feature 007: `SPEC.md` (§4 I09 và I11, §9, §10, §14,
§15), `deploy/README.md`, ADR-0005, một ADR mới cho lượt deputy và một ADR cho nhánh tích hợp của goal, `GLOSSARY.md`,
`docs/architecture.md`, `specs/003-telegram-channel/spec.md`, skill `cusr`. Template Spec Kit đã kiểm tra, không cần thay
đổi. Mục đồng bộ còn chờ: các tài liệu vừa nêu.

**Sync Impact Report 2026-11-17:** phần đồng bộ còn chờ của amendment 10.0.0 và 11.0.0 đã làm ở lát I của feature 007,
sau khi các lát A–H hiện thực deputy và goal, và đối chiếu với code trên `main`: `SPEC.md` (§2, §4 I09 và I11, §5.1,
§5.3, §9, §10, §14.1–§14.3, §15.1, §15.2), `deploy/README.md` (mục Deputy và autonomous, mục Goal, người gọi và quyền,
proof harness), ADR-0005, ADR-0012 cho lượt deputy, ADR-0013 cho nhánh goal, `GLOSSARY.md`, `docs/architecture.md`,
`specs/003-telegram-channel/spec.md` và skill `cusr`. Nguyên tắc I–VIII không đổi, version giữ 11.0.0; template Spec
Kit đã kiểm tra, không cần thay đổi. Không có mục đồng bộ còn chờ.

**Version**: 11.0.0 | **Ratified**: 2026-10-27 | **Last Amended**: 2026-11-09
