# Implementation Plan: Nhiều tài khoản cho một harness, chuyển tài khoản khi hết hạn mức

**Branch**: `006/account-pool` | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

**Input**: Story 1–4, FR-001–FR-025 (gồm FR-005a, FR-008a, FR-014a, FR-014b, FR-022a), Edge Cases, SC-001–SC-008 và mục
Clarifications của spec.

**Mã nền**: đối chiếu tại commit `906d124` (nhánh này sau khi merge `origin/main` `63238b0`).

**Trạng thái:** đã cập nhật theo [spike-report.md](spike-report.md). S2–S5 có kết luận; S1 (resume session trên tài khoản
khác) chưa chạy vì thiếu tài khoản Claude phụ thứ hai, plan dùng phương án dự phòng cho tới khi có kết quả
([R-12](research.md#r-12--spike-trước-khi-code)).

**Nguyên tắc nền:** cusr chỉ dùng tài khoản do chính nó đăng nhập vào thư mục nó quản lý và chỉ ghi vào thư mục đó; không
dùng chung credential với phiên tương tác hay công cụ khác như Orca. Ngoại lệ duy nhất là tài khoản mặc định: tài
khoản đã đăng nhập sẵn trên máy mà pin đang dùng, được dùng trước, chỉ đọc; tài khoản do cusr đăng nhập là dự phòng (R-11).

## Summary

Thêm **tài khoản** là tài nguyên toàn daemon nằm giữa harness và file credential. Trạng thái tài khoản (nghỉ, lỗi đăng
nhập, đổi danh tính, chờ ghi credential, tạm ngưng) là một luồng event riêng không gắn task, được daemon ghi cùng
transaction với trigger gây ra nó. Tài khoản được chọn ngay trước mỗi attempt agent bằng một hàm thuần trên projection
của các tài khoản; lựa chọn đi vào trigger kết quả của effect nên replay cho cùng kết quả mà không tính lại.

Engine không biết vendor: nó chỉ thấy mã tài khoản mờ, danh sách tài khoản đã thử trong vòng hiện tại và các lý do chờ
mới. Phần hiểu file credential (định dạng, danh tính, so sánh) nằm trong adapter harness. Runner ghi token đã làm mới về
thư mục của tài khoản ngay khi nó đổi, bằng compare-and-swap theo digest của nguồn, dưới khóa của cusr.

Pin, manifest và proof hiện có giữ nguyên: tên credential trong pin trở thành chỗ đặt credential của tài khoản được chọn,
không còn quyết định tài khoản nào chạy ([R-03](research.md#r-03--pin-manifest-và-proof)).

Thêm tài khoản luôn qua luồng login của CLI vendor vào thư mục tạm rồi chuyển vào thư mục của tài khoản
([R-08](research.md#r-08--đăng-nhập-vào-thư-mục-quản-lý)).

## Technical Context

| Mục | Thiết kế |
| --- | --- |
| Language/Version | Node 24 LTS, TypeScript strict/ESM, `tsc`; giữ baseline repo |
| Primary Dependencies | Có sẵn: Commander, Zod 4, `better-sqlite3`, uuid. Không thêm dependency |
| Storage | SQLite hiện có. Migration `006_accounts.sql`: bảng khai báo tài khoản, luồng event tài khoản, projection trạng thái, cooldown theo danh tính, thông báo. Secret chỉ nằm trong file, không vào DB |
| Testing | Vitest và fast-check: property test cho chọn tài khoản và vòng thử; integration SQLite thật cho transaction kép task/tài khoản, recovery và crash injection; contract test runner cho ghi credential với Clock và filesystem thật trong thư mục tạm; fake harness mô phỏng hết hạn mức, lỗi auth và làm mới token; smoke harness thật tách riêng |
| Target Platform | Linux/Ubuntu hoặc WSL2, credential là file (`.credentials.json` của Claude, `auth.json` của Codex) |
| Project Type | Một package CLI/daemon/runner; thêm module, không thêm binary hay process |
| Performance Goals | SC-001: attempt kế tiếp bắt đầu trên tài khoản còn lại trong 30 giây khi còn slot; vòng scheduler hiện chạy mỗi 1 giây nên đánh thức (FR-014b) trễ tối đa một vòng |
| Constraints | Không đọc nội dung credential vào DB, event, log hay output; không gọi mạng để xác định danh tính; không đổi `decide`/`evolve` thành có I/O; một slot thực thi toàn daemon giữ nguyên |
| Scale/Scope | Một người dùng; vài tài khoản mỗi harness (dự kiến ≤ 10); hai vendor Claude và Codex |

Không còn câu hỏi nào cần người dùng làm rõ trong spec. Giả định về vendor đã được spike kiểm chứng, trừ S1 có phương án
dự phòng ([R-12](research.md#r-12--spike-trước-khi-code)).

**Về "pool" trong spec:** hiện daemon chỉ có một slot thực thi toàn cục (`execution_slot`); khóa `pools` trong cấu hình
không được dùng lúc chạy. Mọi chỗ spec nói "pool" (FR-014b, FR-020, SC-001) nghĩa là cơ chế slot này. Feature không đổi
nó.

## Constitution Check

Đối chiếu [hiến chương 6.1.0](../../.specify/memory/constitution.md) trước và sau thiết kế: **đạt**, không xin ngoại lệ.

| Nguyên tắc | Cách tuân thủ | Bằng chứng khi triển khai |
| --- | --- | --- |
| I. Lõi tất định | Chọn tài khoản là hàm thuần `selectAccount(accounts, harness, round, now)`; daemon gọi nó lúc xử lý effect `start_agent` và ghi kết quả vào trigger. Engine nhận lựa chọn hoặc lý do không có tài khoản như input đã ghi. Trạng thái tài khoản dựng lại từ luồng event riêng có sequence đã commit | Property test cho `selectAccount`, vòng thử và gộp cooldown; replay test |
| II. Effect sau commit, idempotent | Event tài khoản ghi cùng transaction với trigger gây ra chúng. Ghi credential là CAS theo digest nên chạy lại không đổi kết quả; bản chờ ghi bền qua restart. Recovery xử lý cả run `lost` (lấp khoảng trống hiện tại: auth nằm lại trong private home) | Integration SQLite có crash injection; contract test ghi credential |
| III. Vòng lặp có giới hạn | Mỗi tài khoản một lần trong mỗi vòng thử; hết vòng không có mốc tương lai thì chờ backoff `rate_limit` (FR-016). Mọi lý do chờ mới có điều kiện tiếp tục và đường kết thúc; lần chạy lại tiêu ngân sách như retry hạn mức | Property test không có vòng nóng; bảng `DetailCode` đầy đủ |
| IV. Bằng chứng | Không đổi gate, review, CI | Không có diff ở phần đó |
| V. Người dùng giữ quyền | Mọi thao tác thay đổi tài khoản cần `admin`. Đổi tài khoản không đổi binding, model, effort, không là escalation; hết hạn mức không kích hoạt nâng model. Agent không chọn tài khoản | Contract test quyền; test FR-015 |
| VI. Lõi trung lập | Engine chỉ thấy mã tài khoản và harness; định dạng credential, danh tính và phân loại lỗi nằm trong adapter harness | Review; ESLint giữ engine không import adapter |
| VII. Kiểm chứng trung thực | Giả định vendor nằm ở spike, báo cáo riêng; tiêu chí cần harness thật (SC-003) chạy ở smoke và ghi chưa đạt nếu chưa chạy | [Quickstart](quickstart.md), acceptance report |
| VIII. Đơn giản | Không thêm dependency, process hay framework. Thêm bảng và một luồng event toàn cục được biện minh dưới Complexity Tracking | Complexity Tracking |

Ràng buộc kỹ thuật và bảo mật:

- **Secret:** DB, event, log và output chỉ chứa tên tài khoản, mã danh tính đã băm và digest file; không chứa token. Digest
  dùng SHA-256 của toàn bộ file, đủ entropy để không lộ token. Danh tính vendor và đường dẫn credential chỉ trả cho `admin`
  (FR-007).
- **Trust boundary:** quyền kiểm ở application service (`admitCommand`, query handler), không chỉ trong CLI.
- **Single writer:** file khóa SQLite của nguồn credential (R-13) chỉ dùng để giữ khóa kernel, không chứa trạng thái miền và
  không phải kho trạng thái; daemon vẫn là bên duy nhất ghi DB chính (hiến chương II).
- **SPEC.md phải sửa cùng feature:** §5.1 thêm thực thể Account; §6.2 đổi "rate limit khóa pool/harness" thành khóa tài
  khoản; §9.2 tách `overloaded` khỏi cooldown tài khoản; §12.1 và §13.3 thêm ghi credential và recovery của nó; §15.1 thêm
  nhóm lệnh `cusr account`. Việc sửa SPEC nằm ở lát E.
- **Hành trình S01–S10:** không đổi; hành trình có hết hạn mức được bổ sung kịch bản trong acceptance report.

## Thiết kế chính

```text
cusr account … ──/v1/command (admin)──▶ account service ──▶ accept(account trigger) ──▶ account_events + projection
                                                                        ▲
task trigger (effect kết quả) ──▶ accept(task trigger) ──▶ task events ─┴─ account events cùng transaction
                                        ▲
start_agent effect ──▶ selectAccount(projection, harness, round, now) ──▶ launch với nguồn credential của tài khoản
                                        │ không có tài khoản
                                        ▼
                               effect_failed{accounts_unavailable, earliest_ready_at, blocked} ──▶ engine chờ
runner ──▶ mỗi khi credential trong private home đổi ──▶ CAS về nguồn | giữ bản chờ ghi ──▶ kết quả kèm trạng thái ghi
scheduler pass ──▶ event tăng khả dụng mới hơn watermark ──▶ account_ready (dedup) cho task chờ cùng harness hoặc cùng cooldown_key
```

- **Tài khoản và trạng thái (FR-001–FR-005a, FR-011, FR-017):** khai báo nằm trong DB do daemon ghi, không trong file cấu
  hình, nên thêm tài khoản không đòi restart daemon (khác `credential_refs` hiện bị `hostBound()` khóa). Trạng thái là tập
  nguyên nhân chặn độc lập; cooldown gắn với khóa danh tính (FR-012). Xem [data model](data-model.md).
- **Chọn tài khoản (FR-010, FR-011, FR-016):** engine đưa vào yêu cầu `start_agent` danh sách tài khoản đã thử trong vòng.
  Handler `startAgent` gọi `selectAccount`; có tài khoản thì thay nguồn credential trong lần chạy bằng nguồn của tài khoản
  đó và ghi `account` vào fact khởi chạy. Không có thì trả effect thất bại `accounts_unavailable` với `invoked: false` (ngân
  sách được hoàn) kèm mốc hồi sớm nhất và nguyên nhân chặn từng tài khoản ([R-02](research.md#r-02--điểm-chọn-tài-khoản)).
- **Hết hạn mức (FR-012–FR-016):** chỉ lỗi `rate_limited` của vendor làm tài khoản nghỉ; `overloaded` giữ backoff theo task
  như hiện nay ([R-04](research.md#r-04--phân-loại-lỗi)). Chuyển tài khoản là retry ngay không timer khi vòng còn tài khoản
  chưa thử; hết vòng thì chờ theo FR-014.
- **Chờ và đánh thức (FR-014, FR-014a, FR-014b):** ba lý do chờ mới; timer theo task tới mốc hồi sớm nhất; vòng scheduler
  chỉ phát `account_ready` khi có event làm tăng khả dụng mới hơn watermark ghi lúc task bắt đầu chờ, nên không phá backoff
  của Q18; event cooldown đánh thức mọi task chờ tài khoản cùng `cooldown_key`, kể cả ở harness khác
  ([R-05](research.md#r-05--chờ-đánh-thức-và-vòng-thử)).
- **Lỗi auth (FR-018):** runner ghi digest nguồn lúc cài; khi lỗi auth, handler so với digest nguồn hiện tại và gửi
  `source_changed`. Engine giữ một chuỗi lỗi auth độc lập cho mỗi tài khoản trong task (`auth_chains`), nên chuyển sang B
  không làm mất giới hạn thử token mới của A.
- **Credential (FR-021–FR-025):** runner theo dõi credential trong private home và ghi về ngay khi nó đổi, bằng CAS dưới
  khóa của tài khoản do kernel giữ (tự nhả khi process chết); giữ bản chờ ghi khi lỗi I/O, mỗi lần thử lại lấy khóa từ đầu;
  recovery chạy cùng thủ tục cho run `lost`. Chỉ cusr ghi thư mục tài khoản nên không cần khóa của vendor ở nguồn
  ([R-06](research.md#r-06--ghi-credential-về-nguồn), [R-13](research.md#r-13--khóa-nguồn-credential),
  [hợp đồng](contracts/credential-writeback.md)).
- **Đăng nhập (FR-005, FR-006):** CLI chạy `claude auth login` hoặc `codex login --device-auth` vào thư mục tạm, kiểm định
  dạng và danh tính, rồi daemon chuyển vào thư mục của tài khoản; đăng nhập lại thay credential theo cùng CAS
  ([R-08](research.md#r-08--đăng-nhập-vào-thư-mục-quản-lý)).
- **CLI và quyền (FR-006–FR-009, FR-008a):** nhóm lệnh `cusr account`, mỗi lệnh có kind riêng trong `COMMAND_PAYLOADS` và
  `REQUIRED_ROLE: admin`; query `account_list` lọc theo quyền đọc ([hợp đồng](contracts/cli-daemon.md)).
- **Thông báo (FR-014a):** bảng `notices` theo đợt hết hạn mức, hiện trong report và TUI; feature 003 sẽ đọc bảng này để
  đưa vào outbox ([R-10](research.md#r-10--thông-báo-và-đợt-hết-hạn-mức)).

## Thứ tự giao

| Lát | Nội dung | Điều kiện qua lát |
| --- | --- | --- |
| 0 | Spike S2–S5 (đã xong, [spike-report.md](spike-report.md)); S1 chạy trước lát B khi có tài khoản Claude phụ thứ hai | S1 có kết quả, hoặc chấp nhận phương án dự phòng |
| A | Migration 006, luồng event tài khoản, service và lệnh `cusr account` (add/login qua login của vendor, list, suspend, resume, clear-cooldown, priority, use, remove), tài khoản mặc định, `doctor` | Story 2; SC-005, SC-006 |
| B | Chọn tài khoản lúc khởi chạy, thay nguồn credential, cooldown theo danh tính, vòng thử, ba lý do chờ, timer, đánh thức, thông báo đợt | Story 1; Story 2 kịch bản 7; SC-001, SC-002, SC-008 |
| C | Ghi credential về nguồn: CAS, bản chờ ghi, recovery của run `lost` và khi daemon restart, kiểm tra định dạng và danh tính | Story 3; SC-003 (smoke), SC-004 |
| D | Lỗi auth theo tài khoản, chuỗi thử token mới, đổi danh tính (FR-005a), inbox | Story 4; Story 2 kịch bản 8 |
| E | Report/TUI/chi tiết task, sửa SPEC.md, skill `cusr`, tài liệu vận hành, acceptance report | SC-007; toàn bộ SC |

Lát A giao được độc lập: thêm tài khoản và xem trạng thái, hành vi chạy chưa đổi (vẫn dùng tài khoản mặc định). Lát C
merge **trước** B: B là lúc tài khoản dự phòng bắt đầu chạy thật, và khi đó refresh token đã xoay phải được ghi về, nếu không
tài khoản bị đăng xuất sau lần làm mới đầu tiên. Phần runner của C làm song song với A được ([tasks](tasks.md)).

## Rủi ro

| Rủi ro | Cách xử lý |
| --- | --- |
| Claude không cho resume session do tài khoản khác tạo (S1) | Lần chạy lại trên tài khoản khác bắt đầu session mới với context packet như resume thất bại hiện nay (`resume_fallback`); spec đã cho phép |
| Làm mới đồng thời từ cùng refresh token (S2: Claude cho một bên thua) | Bên thắng ghi về ngay khi token đổi; bên thua lỗi auth thấy nguồn đã đổi nên được chạy lại bằng token mới (FR-018). `validate` từ chối token rỗng mà bên thua để lại |
| `fs.watch` bỏ sót thay đổi | Quét định kỳ vài giây làm dự phòng, và luôn chạy thủ tục một lần trước khi xóa private home |
| Tài khoản mặc định dùng chung credential với phiên tương tác, có thể bị đăng xuất | Giữ hành vi cũ, chỉ đọc; bị đăng xuất thì task chuyển sang tài khoản dự phòng, người dùng đăng nhập lại rồi `account check` (R-11) |
| Khóa nằm lại sau crash hoặc bị thu hồi nhầm | Khóa do kernel giữ qua `BEGIN EXCLUSIVE` trên file SQLite riêng; tự nhả khi process chết, không có bước thu hồi (R-13) |
| Luồng event toàn cục làm phức tạp replay và `verify-projections` | Luồng tài khoản có sequence riêng, replay riêng, và `verify-projections` thêm một bước so sánh; task không đọc trực tiếp luồng này |
| Thay đổi `HARNESS_FAILURE_CLASS` (tách `overloaded`) đổi hành vi task cũ | `overloaded` vẫn đi lớp `rate_limit` của task như cũ; chỉ khác là không làm tài khoản nghỉ |

## Project Structure

### Documentation (this feature)

```text
specs/006-account-pool/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cli-daemon.md
│   └── credential-writeback.md
├── checklists/requirements.md
├── spike-report.md      # lát 0
└── tasks.md             # $speckit-tasks
```

### Source Code (repository root)

```text
src/
├── domain/
│   ├── account.ts            # Account, AccountEvent, BlockCause, identity key; schema Zod
│   ├── state.ts              # DetailCode mới, account_round, auth_chain trong TaskState
│   └── trigger.ts            # FailureData: account, source_changed, earliest_ready_at, blocked
├── engine/
│   ├── accounts.ts           # selectAccount, gộp cooldown, vòng thử (thuần)
│   ├── failure.ts            # accounts_unavailable, rate_limit theo tài khoản, chuỗi auth
│   └── interpreter.ts        # đưa round vào yêu cầu start_agent
├── store/
│   ├── migrations/006_accounts.sql
│   ├── accounts.ts           # append/replay luồng event tài khoản, projection
│   └── accept.ts             # hook ghi event tài khoản cùng transaction
├── application/
│   ├── accounts.ts           # service lệnh account_*, query account_list, lọc quyền
│   ├── commands.ts           # COMMAND_PAYLOADS, REQUIRED_ROLE
│   ├── doctor.ts             # kiểm từng tài khoản
│   └── report.ts             # mục notices
├── daemon/
│   ├── handlers.ts           # startAgent chọn tài khoản; ánh xạ lỗi; source_changed
│   ├── scheduler.ts          # đánh thức account_ready, thử lại ghi chờ
│   └── reconcile.ts          # recovery ghi credential cho run lost
├── adapters/harness/
│   ├── vendor.ts             # CredentialFormat: validate, identity, so sánh
│   ├── claude.ts, codex.ts   # định dạng credential theo vendor
│   └── fake.ts               # mô phỏng hết hạn mức, auth, làm mới token
├── runner/
│   ├── private-home.ts       # digest lúc cài, đọc lại sau run
│   ├── credential-writeback.ts  # CAS, bản chờ ghi
│   └── invocation.ts         # gọi writeback trước removeAuth; recover
├── cli/
│   └── accounts.ts           # cusr account …
└── tui/                      # hiển thị tài khoản theo attempt và thông báo

test/
├── property/accounts/        # selectAccount, vòng thử, gộp cooldown
├── unit/engine/              # failure, chờ, chuỗi auth
├── integration/store/        # migration 006, transaction kép, replay, verify
├── integration/crash/        # crash giữa ghi credential và commit
├── contract/runner/          # writeback trên filesystem thật
├── contract/cli/             # cusr account, quyền, --json
├── scenarios/                # Story 1–4 với fake harness và daemon thật
└── smoke/                    # SC-003 với harness thật
```

**Structure Decision**: Giữ một package. Engine chỉ import `domain/account.ts`; mọi hiểu biết về định dạng credential nằm
trong `adapters/harness/`, và runner gọi qua interface `CredentialFormat` của adapter.

## Complexity Tracking

| Thêm vào baseline | Vì sao cần | Lựa chọn đơn giản hơn bị loại vì |
| --- | --- | --- |
| Luồng event toàn cục `account_events` cạnh luồng task | Trạng thái tài khoản dùng chung mọi task, bền qua restart, có actor và lý do (FR-008, FR-017) | Giữ trong state từng task không chia sẻ được cooldown; bảng trạng thái không có event mất audit và không replay được |
| Bảng `notices` | FR-014a cần thông báo không phải câu hỏi, sửa được theo đợt | Dùng câu hỏi của inbox sẽ đòi trả lời; ghi file như `decisions.md` của decider không lọc được theo quyền đọc |
| Module `credential-writeback.ts` với CAS và bản chờ ghi | FR-022, FR-022a, FR-023 | Chép đè sau run làm mất token mới hơn của nơi khác và có thể hỏng file khi đầy đĩa |
