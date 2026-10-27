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
- Khởi động lại MUST nhận lại attempt, PR và effect đang dở thay vì tạo bản thứ hai; không spawn
  thay thế khi chưa chứng minh attempt cũ đã kết thúc; không reset worktree chỉ vì HEAD lệch
  checkpoint.

**Lý do:** crash ở bất kỳ điểm nào không được làm mất trạng thái đã commit hay lặp push, PR,
comment hoặc merge đã thành công.

### III. Mọi thứ đều có giới hạn

- Mọi vòng lặp, retry, lời gọi bên ngoài, lượt agent, wall time và lượt gọi decider MUST có trần.
  Không bắt đầu attempt khi không đủ ngân sách. Khi policy yêu cầu approval (nấc
  `needs_approval`), attempt MUST NOT bắt đầu nếu chưa có approval hợp lệ, tức gắn đúng
  task/revision, step, nấc và policy hash. Nấc `auto` không chờ duyệt.
- Task đang chờ MUST có lý do, điều kiện tiếp tục và đường kết thúc. Trạng thái kết thúc không tự
  mở lại; retry sau kết thúc tạo task mới có liên kết nguồn.
- Usage MUST phân biệt `reported`, `estimated`, `unavailable`; không ghi 0 thay cho dữ liệu thiếu.
  Không cam kết trần USD cứng với harness chưa kiểm chứng được cơ chế giới hạn chi phí.

**Lý do:** chi phí và thời gian phải dự đoán được; không task nào kẹt vô hạn hay đốt token âm thầm.

### IV. Bằng chứng, không phải lời agent

- Exit code thành công hay việc agent nói "xong" MUST NOT đủ để qua bước. Kết quả phải đúng schema,
  đúng attempt và đạt mọi gate bắt buộc (build, test, review, CI).
- Required checks ở trạng thái pending, cancelled, missing hoặc unknown MUST NOT được coi là pass.
- Reviewer SHOULD khác vendor với coder và chỉ nhận dữ liệu cần thiết (diff có giới hạn kích thước).

**Lý do:** agent có thể tự tin mà sai; chỉ tín hiệu kiểm chứng được mới đẩy workflow tiến lên.

### V. Người dùng giữ quyền kiểm soát

- Workflow, policy, role/model binding và input gốc MUST bất biến theo revision. Thay đổi cần
  event, actor, lý do và revision mới. Agent MUST NOT tự đổi role, quyền, binding, approval, pool
  hay ngân sách của mình.
- Nâng effort/model/vendor MUST đi theo thang đã duyệt trước, do code kích hoạt theo phân loại lỗi.
  Lỗi hạ tầng hoặc hết hạn mức MUST NOT kích hoạt nâng model; không hạ model ngầm.
- Merge MUST chỉ do code thực hiện sau khi kiểm tra quyền, head/base SHA, review và CI. Decider và
  agent không quyết định merge. Mặc định người duyệt từng merge vào protected branch; chế độ yolo
  chỉ người dùng admin bật qua kênh tin cậy, không bao giờ qua `cusr.yaml` của repo, và được kiểm
  tra lại ngay lúc dispatch merge.
- Quyết định của decider MUST được ghi lại, giải thích được và lật lại được trong phạm vi còn đảo
  ngược; không giả vờ hoàn tác side effect bên ngoài.

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
  fast-check, pnpm với lockfile frozen, ESLint + typescript-eslint + Prettier. Đổi baseline cần
  amendment của SPEC.md §17.
- **Exhaustiveness:** switch trên domain union kết thúc bằng `assertNever`; không cast sang `never`.
- **SQLite:** WAL, `synchronous=FULL`, foreign keys, busy timeout hữu hạn; unique constraint bảo
  vệ event sequence, source dedup, request ID và effect idempotency key.
- **Môi trường v1:** một người dùng, Linux/Ubuntu hoặc WSL2, worktree và dữ liệu runtime trên
  filesystem Linux cục bộ.
- **Trust boundary:** quyền `read`/`operate`/`admin` kiểm tra ở application service. Quyền admin
  và secret điều phối nằm ngoài tầm truy cập của agent. Worktree không phải sandbox bảo mật; khi
  không chứng minh được giới hạn truy cập, `doctor` phải báo và chặn chế độ tự động cần quyền đó.
- **Secret:** che trước khi lưu hoặc xuất log. Không force-push mù; không xoá worktree còn dữ liệu
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

**Version**: 1.1.0 | **Ratified**: 2026-10-27 | **Last Amended**: 2026-10-27
