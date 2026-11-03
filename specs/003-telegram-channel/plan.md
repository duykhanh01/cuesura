# Implementation Plan: Kênh thông báo hai chiều qua Telegram

**Branch**: `003/telegram-channel` | **Date**: 2026-11-03 | **Spec**: [spec.md](spec.md)

**Input**: US1–US5, FR-001–FR-031, EC-001–EC-014, SC-001–SC-011 và các quyết định trong mục Clarifications của spec.

## Summary

Daemon có thêm một outbox thông báo không theo task và một adapter Telegram chạy bằng long polling. Thông báo được suy ra
từ cặp state trước/sau ngay trong transaction `accept` của task bằng một hook ở tầng application, nên engine vẫn không
biết có kênh. Vòng gửi và vòng nhận là hai round của daemon: gửi theo đợt có giới hạn với cùng khóa logic, nhận và tiến
offset trong cùng lần ghi bền. Thao tác từ chat được dịch thành đúng các command kind CLI đang có và đi qua `admitCommand`
với grant riêng của liên kết, nên quyền, chống lặp và mã lỗi giống CLI.

Thay đổi lên phần đã có được giữ nhỏ: một trigger gộp xác nhận task và cấu hình chạy, một điều kiện mới cho decider,
inbox nhiều loại có phân trang, mẫu token Telegram trong Redactor, và thông tin kênh trong health/doctor. Không thêm
dependency.

## Technical Context

| Mục | Thiết kế |
| --- | --- |
| Language/Version | Node 24.22.1, TypeScript strict/ESM, `tsc`; giữ baseline repo |
| Primary Dependencies | Có sẵn: Commander, Zod 4, uuid, better-sqlite3. Telegram qua `fetch` của Node ([R-01](research.md#r-01--gọi-telegram-bot-api)); không thêm package |
| Storage | SQLite hiện có; migration 006 thêm 7 bảng nguồn sự thật cho kênh ([data model](data-model.md)) |
| Testing | Vitest, fast-check; Telegram giả lập qua HTTP cục bộ; crash injection bằng child process; smoke với bot thật |
| Target Platform | Linux/Ubuntu hoặc WSL2; máy chạy daemon cần ra được `api.telegram.org` qua HTTPS |
| Project Type | Một package CLI/daemon/runner; thêm module, không thêm binary hay process |
| Performance Goals | SC-002: tin tới chat và phản hồi thao tác trong 1 phút khi mạng bình thường; long poll 25 giây nên nhận gần như ngay |
| Constraints | Không endpoint công khai; không gọi LLM; token không qua argv, socket hay ledger; mọi vòng lặp và đợt gửi có trần; lỗi kênh không đổi trạng thái task |
| Scale/Scope | Một người dùng, một bot, một chat; hàng trăm thông báo mỗi ngày là đủ dư |

Không còn mục NEEDS CLARIFICATION. Giá trị cụ thể ở [R-04](research.md#r-04--gửi-lượt-đợt-thứ-tự),
[R-08](research.md#r-08--liên-kết-mã-và-grant) và [hợp đồng Telegram](contracts/telegram.md).

## Constitution Check

Đối chiếu [hiến chương 6.1.0](../../.specify/memory/constitution.md) trước và sau thiết kế: **đạt**, không xin ngoại lệ. Việc gửi lại thông báo
sau `unknown` dựa vào điều khoản ngoại lệ của nguyên tắc II được thêm ở amendment 6.1.0, không phải ngoại lệ riêng của feature.

| Nguyên tắc | Cách tuân thủ | Bằng chứng khi triển khai |
| --- | --- | --- |
| I. Lõi tất định | Engine chỉ thêm trigger `confirm_task_with_run_config`, vẫn thuần. Thông báo suy bằng hàm thuần từ state; nội dung tin và report dựng bằng code | Property test trigger mới; unit test hàm suy thông báo |
| II. Effect sau commit, idempotent | Thông báo tạo trong transaction của sự kiện; gửi sau commit; mỗi thông báo có khóa UNIQUE; update có khóa `(bot_id, update_id)`; offset tiến cùng lần ghi. Telegram không có probe nên lượt `unknown` gửi lại cùng mã, theo ngoại lệ của nguyên tắc II (hiến chương 6.1.0) và SPEC §13.2; ngoại lệ không áp cho lệnh hay quyết định | Crash matrix ≥100 seed (SC-004); test lặp 2–5 lần (SC-003) |
| III. Vòng lặp có giới hạn | Lượt mỗi đợt, thời hạn đợt, backoff, nhịp probe, long poll, số lần thử mã liên kết đều có trần; đợt mới chỉ mở khi có bằng chứng hồi phục | Unit test lịch lượt; integration kênh lỗi kéo dài |
| IV. Bằng chứng | Kênh không tạo bằng chứng nào; thao tác từ chat đi qua cùng kiểm tra revision/policy hash/digest của engine | SC-005 |
| V. Người dùng giữ quyền | Liên kết do admin tạo, mặc định `operate`, không vượt grant người tạo; duyệt escalation chỉ với `admin`; không có merge, yolo, autonomous, reject qua chat; decider vẫn không cấp approval | SC-005, SC-006; test quyền theo vai trò |
| VI. Lõi trung lập | Engine không biết Telegram hay thông báo; store chỉ chạy hook; adapter không quyết định retry/escalation/trạng thái task | Review; engine chỉ có diff của trigger mới |
| VII. Kiểm chứng trung thực | Store/outbox/recovery bằng integration test SQLite thật kèm crash injection; adapter bằng contract test với Telegram giả lập; bot thật ở smoke riêng, chưa chạy thì ghi chưa kiểm | [Quickstart](quickstart.md), acceptance report |
| VIII. Đơn giản | Không dependency mới, không broker, không process mới; bảng mới được biện minh ở Complexity Tracking | Complexity Tracking |

Ràng buộc kỹ thuật và bảo mật:

- **Trust boundary:** grant của liên kết kiểm ở application service như token CLI; `issued_by` là `telegram:<link_id>`.
- **Secret:** token ở `DATA_DIR/telegram/token.<sha256>` (0600, thư mục 0700); file nào đang dùng do DB quyết định
  ([R-07](research.md#r-07--token-bot-và-lệnh-setup)). Token không vào worktree, env hay context của agent; thêm mẫu token
  Telegram vào `SECRET_PATTERNS`. Theo ADR-0005, không hứa chặn process cùng UID; lệnh setup nói rõ điều này.
- **Migration:** chạm store nên phải qua typecheck, lint, test, build và có test migration 005 → 006.
- **SPEC:** cập nhật SPEC §15.1 (lệnh `cusr telegram`), §15.2 (Telegram là connector qua polling, grant riêng) và §8.6b của
  [architecture](../../docs/architecture.md) nếu chữ lệch với quyết định ở spec; không đổi §17.2.

## Thiết kế chính

```text
accept(task trigger) ── BEGIN IMMEDIATE ─────────────────────────────────────────── COMMIT
   decide → events → project → afterProject hook ─▶ notifications (+ bản tin cần đồng bộ)

daemon rounds (bỏ qua khi store latched/blocked)
   ├─ telegram receive: getUpdates ─▶ [tg_updates + offset] ─▶ xử lý update ─▶ admitCommand ─▶ service ─▶ accept
   │                                                                     └─▶ notification reply
   └─ telegram send: chọn việc theo thứ tự ─▶ [đánh dấu lượt] ─▶ sendMessage/editMessageText ─▶ [kết quả, bản tin]
```

- **Suy thông báo (FR-001, FR-005, FR-021):** `deriveNotifications(before, after)` trả câu hỏi mở mới, yêu cầu duyệt mới,
  chờ xác nhận có đề xuất, chuyển sang chờ người với mã khác, task kết thúc, và đối tượng vừa đóng. Hook chỉ chạy khi có liên
  kết hoạt động và project nằm trong grant của nó (FR-012, FR-029).
- **Gửi (FR-002–FR-006, FR-030):** mỗi vòng lấy việc theo thứ tự phản hồi → đồng bộ trạng thái cuối → nghiệp vụ; kiểm hiệu
  lực trước mỗi lượt; lượt được đánh dấu trước khi gọi mạng để restart biết là `unknown`. Đường gửi hỏng thì dò bằng
  `sendChatAction` ([R-05](research.md#r-05--bằng-chứng-hồi-phục-fr-030)).
- **Nhận (FR-013, FR-018):** lưu lô update và offset trong một transaction rồi mới xử lý; chat lạ chỉ còn metadata.
- **Thao tác (FR-014–FR-017):** thẻ thao tác giữ phạm vi đã hiển thị và `link_id`; reply tra bản tin theo `message_id`. Kiểm
  liên kết và gọi service trong một đoạn đồng bộ nên commit thu hồi là ranh giới (FR-010).
- **Liên kết (FR-008–FR-011, FR-031):** mã băm, hạn 10 phút, 5 lần sai; dùng mã thì thay liên kết và mở đợt cho việc còn chờ
  trong một transaction.
- **Inbox (FR-024):** dịch vụ `inbox` dùng `openQuestions`, `needsUser`, `allowedActions`; cursor ổn định; Telegram trình bày
  8 mục mỗi tin.

## Thứ tự giao

Theo quy ước repo, mỗi phase của `tasks.md` là một PR.

| Lát | Nội dung | Điều kiện qua lát |
| --- | --- | --- |
| 0 | Spike: Telegram giả lập trong `test/support/`; smoke `getMe`/`getUpdates`/`sendMessage`/`editMessageText` với bot thật xác nhận các sự thật ở R-01 | Smoke ghi vào acceptance report hoặc ghi chưa kiểm |
| A | Nền: migration 006, adapter Telegram, mẫu token trong Redactor, `cusr telegram setup/link/unlink/status`, health và doctor (US1). Hai PR: Phase 2 (nền) và Phase 3 (US1) của tasks | US1 đạt trên Telegram giả lập; test migration; SC-001 phần tự động |
| B | Outbox và câu hỏi: hook `afterProject`, suy thông báo, vòng gửi/nhận, reply và `/answer`, đồng bộ trạng thái cuối, decider giữ câu hỏi đã hỏng (US2) | US2 đạt; SC-003 cho reply; crash point mới |
| C | Duyệt và xác nhận: thẻ thao tác, trigger gộp xác nhận, `cusr task confirm --run-config` dùng trigger mới (US3) | US3 đạt; property test trigger; SC-005 |
| D | Inbox nhiều loại và phân trang trên CLI và Telegram, `/show`, `/report`, thông báo `attention`/`finished`, cập nhật `skills/cusr` (US4) | US4 đạt; contract CLI inbox mới; SC-008 phần inbox/report |
| E | Bền vững: bằng chứng hồi phục, đợt mới, liên kết mới gửi lại việc còn chờ, ma trận crash ≥100 seed, kênh lỗi dài (US5) | SC-004, SC-007, SC-011 |
| F | Nghiệm thu: smoke bot thật theo quickstart, cập nhật SPEC §15 và tài liệu vận hành | Toàn bộ SC ghi vào acceptance report |

Lát A–B đã cho một vòng hỏi đáp dùng được trên điện thoại; C–E hoàn thiện các cam kết còn lại.

## Rủi ro

| Rủi ro | Cách xử lý |
| --- | --- |
| Hook trong `accept` làm chậm hoặc làm hỏng transaction của task | Hook thuần, chỉ đọc một dòng liên kết và chèn vài dòng; lỗi của hook làm hỏng cả accept như mọi lỗi projection, nên test bảng phủ mọi loại state; đo thời gian accept trong project `performance` |
| Long poll giữ round lâu, chặn `stop()` | Round nhận dùng `AbortSignal` riêng, `abortRounds` hủy ngay; timeout HTTP 35 giây là trần |
| Telegram đổi chuỗi lỗi của `editMessageText` | Phân loại theo mã HTTP trước; chuỗi chỉ dùng để tách `gone`; lỗi 400 lạ coi là lượt hỏng có trần, không lặp vô hạn |
| Người dùng có nhiều việc cùng lúc, tin dồn | Nhịp 1 tin/giây, thứ tự theo task; `/inbox` vẫn là đường xem đủ |
| Đổi `truncated` thành `next_cursor` làm vỡ client đang đọc inbox | Chỉ có CLI, assistant skill và test dùng; cập nhật cùng lát D, ghi rõ trong hợp đồng |
| Máy ngủ lâu làm đợt hết hạn hàng loạt | Đúng theo Q14; việc thao tác được còn hiệu lực có đợt mới khi đường gửi được chứng minh hoạt động |

## Project Structure

### Documentation (this feature)

```text
specs/003-telegram-channel/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cli-daemon.md
│   └── telegram.md
├── checklists/requirements.md
└── tasks.md                  # do speckit-tasks tạo
```

### Source Code (repository root)

```text
src/
├── adapters/telegram/
│   ├── api.ts                # TelegramPort qua fetch, timeout, phân loại lỗi
│   └── format.ts             # dựng văn bản tin, cắt theo giới hạn, mã ngắn
├── application/
│   ├── notify/
│   │   ├── derive.ts         # hàm thuần: cặp state → thông báo
│   │   └── hook.ts           # afterProject: đọc liên kết, chèn thông báo, đánh dấu bản tin cần đồng bộ
│   ├── telegram/
│   │   ├── token.ts          # đọc và kiểm file token theo fingerprint
│   │   ├── setup.ts          # telegram_setup, telegram_link_code, telegram_unlink, telegram_status
│   │   ├── inbound.ts        # update → lệnh/phản hồi; liên kết bằng /start
│   │   └── cards.ts          # thẻ thao tác, kiểm phạm vi
│   ├── inbox.ts              # nhiều loại, cursor, ghi chú decider
│   └── confirm.ts            # dùng trigger gộp khi có digest
├── daemon/
│   ├── telegram.ts           # round nhận, round gửi, probe hồi phục
│   ├── decider.ts            # bỏ câu hỏi đã có lần chạy hỏng
│   ├── health.ts             # channels.telegram
│   └── production.ts         # nối round và command/query mới
├── engine/                   # trigger confirm_task_with_run_config
├── store/
│   ├── accept.ts             # hook afterProject
│   ├── crash.ts              # crash point mới
│   ├── telegram.ts           # đọc/ghi bảng kênh trong transaction
│   └── migrations/006_telegram_channel.sql
├── runner/redact.ts          # mẫu token Telegram
└── cli/telegram.ts           # cusr telegram setup|link|unlink|status

test/
├── support/fake-telegram.ts
├── unit/application/notify/, unit/adapters/telegram/
├── property/                 # trigger gộp, thứ tự gửi, decider
├── integration/telegram/     # daemon thật + Telegram giả lập
├── integration/crash/        # crash point mới
├── reliability/              # ≥100 seed
├── contract/cli/             # lệnh mới, inbox, confirm
└── smoke/telegram.test.ts    # bot thật khi có CUSR_SMOKE_TELEGRAM_TOKEN
```

**Structure Decision**: Giữ một package. `src/adapters/telegram/` chỉ biết Bot API; `src/application/telegram/` dịch giữa
chat và dịch vụ có sẵn; `src/engine/` không import gì của kênh. Bảng kênh được đọc ghi qua `src/store/telegram.ts` để mọi
transaction nằm trong store như hiện nay.

## Complexity Tracking

| Thêm vào baseline | Vì sao cần | Lựa chọn đơn giản hơn bị loại vì |
| --- | --- | --- |
| 7 bảng nguồn sự thật mới | Thông báo không theo task, trạng thái gửi và bản tin không dựng lại được từ event; cần unique constraint cho khóa thông báo, update và liên kết hoạt động | Dùng `effects`: bắt buộc task, bị verify dựng lại từ event; một bảng JSON: mất ràng buộc chống lặp ([R-02](research.md#r-02--nơi-lưu-thông-báo)) |
| Hook `afterProject` trong `accept` | FR-001 yêu cầu thông báo cùng transaction với sự kiện | Vòng quét định kỳ bỏ lỡ sự kiện ngắn; tạo trong engine vi phạm nguyên tắc VI |
| Trigger `confirm_task_with_run_config` | Q16: "cả hai hoặc không gì" kể cả khi crash | Kiểm trước khi ghi không chặn được crash giữa hai accept |
