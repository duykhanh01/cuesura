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

- Vòng lặp giữa các step (`max_visits`) MUST có trần. Lượt gọi decider không có trần; thay vào đó, sau một
  câu trả lời của decider, câu hỏi tiếp theo ở cùng step và revision MUST chờ người, trừ task có nhãn `grill`. Lượt agent, wall time và
  budget của task không có trần bắt buộc; retry hạ tầng dùng backoff tăng dần và trần số lần là tùy
  chọn. Task cũ giữ trần đã đóng băng: không bắt đầu attempt khi vượt trần đó. Khi policy yêu cầu approval (nấc
  `needs_approval`), attempt MUST NOT bắt đầu nếu chưa có approval hợp lệ, tức gắn đúng
  task/revision, step, nấc và policy hash. Nấc `auto` không chờ duyệt.
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
  và không miễn gate/CI hoặc cấp quyền merge.
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
  escalation trong ladder đã đóng băng (#205), không được duyệt nhận PR có sẵn hay dùng quyền admin. Đây là rào chắn cho caller làm đúng quy ước, không phải ranh giới bảo
  mật với process cùng UID. Worker không gọi `cusr`.
- Nâng effort/model/vendor MUST đi theo thang đã duyệt trước, do code kích hoạt theo phân loại lỗi.
  Lỗi hạ tầng hoặc hết hạn mức MUST NOT kích hoạt nâng model; không hạ model ngầm.
- Effect merge do Cuesura gửi MUST chỉ do code thực hiện sau khi kiểm tra quyền, head/base SHA,
  gate/CI, review theo chế độ và approval cho thao tác merge. Auto-merge của `full-review` MUST có
  reviewer approve; `direct-pr` auto-merge khi gate và CI xanh, không có reviewer đọc diff. Decider và agent không quyết định merge. Người dùng
  có thể merge thủ công trên GitHub theo quyền/branch protection; Cuesura MUST đối chiếu bằng chứng
  thao tác bên ngoài đó, không giả approval/review và không đòi merge qua guard của effect nội bộ.
  Mặc định người duyệt từng merge vào protected branch; chế độ yolo
  chỉ người dùng admin bật qua kênh tin cậy, không bao giờ qua `cusr.yaml` của repo, và được kiểm
  tra lại ngay lúc dispatch merge.
- Quyết định của decider MUST được ghi lại và giải thích được. Lật lại nghĩa là người dùng revert hoặc tạo task
  mới; decider không tự hoàn tác và không giả vờ hoàn tác side effect bên ngoài. Decider chỉ trả lời câu hỏi của
  worker, MUST NOT cấp approval hay quyết định merge, và chỉ chạy khi người dùng bật qua kênh tin cậy.

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
- Một gate hoặc tiêu chí nghiệm thu chưa đạt MUST được báo là chưa đạt; không thay bằng kiểm tra
  mô phỏng rồi coi tương đương. Giả định chưa có bằng chứng (spike) MUST NOT được trình bày như
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
  Sandbox worker Claude MAY bật/tắt độc lập với permission mode, mặc định tắt; decider MUST giữ sandbox chỉ đọc, reviewer dùng ranh giới của fixer.
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

**Version**: 8.0.0 | **Ratified**: 2026-10-27 | **Last Amended**: 2026-11-06
