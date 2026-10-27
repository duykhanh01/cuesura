# Implementation Plan: Lõi điều phối tất định

**Branch**: `001-deterministic-core` | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-deterministic-core/spec.md`

## Summary

Feature này dựng ba năng lực nền của Cuesura, chưa có I/O ra ngoài máy:

1. **Cấu hình → chính sách đóng băng.** Loader đọc `~/.cusr/config.yaml` và `cusr.yaml` (nội dung do
   caller cung cấp), kiểm tra cú pháp có vị trí dòng/cột, hợp nhất theo hai quy tắc của FR-001, chạy
   sáu kiểm tra tĩnh, rồi chốt `FrozenPolicy` và `FrozenExecutionContext` có hash chuẩn hoá.
2. **Lõi quyết định thuần.** `decide(input) → events` và `evolve(state, event) → state` diễn giải
   workflow theo loại bước. Effect và timer là sự kiện (`EffectRequested`, `TimerArmed`), nên outbox
   và bảng timer là projection của nhật ký. Thời điểm và ID đi vào qua phong bì tín hiệu đã ghi nhận.
3. **Kho SQLite một bên ghi.** Mỗi tín hiệu được chấp nhận trong một transaction đồng bộ của
   `better-sqlite3`: dedup → `decide` → append events → cập nhật projection (task, effect, timer).
   Nhật ký dựng lại được toàn bộ projection; có hàm đối chiếu.

Bằng chứng: property test bằng fast-check cho tầng quyết định; integration test trên SQLite file thật
(WAL, `synchronous=FULL`) kèm crash injection bằng tiến trình con bị `SIGKILL` cho tầng kho. Một script
báo cáo gắn mỗi bất biến I01–I12 với bộ kiểm thử đã chạy hoặc "chưa thuộc phạm vi".

## Technical Context

**Language/Version**: TypeScript strict trên Node 24 LTS (SPEC.md §17.2). Pin bản patch trong
`package.json#engines`, `.nvmrc` và CI.

**Primary Dependencies**: `zod` 4, `yaml` 2 (eemeli), `better-sqlite3`, `uuid` (UUIDv7, chỉ dùng ở
shell). Dev: `typescript`, `vitest`, `fast-check`, `eslint` + `typescript-eslint`, `prettier`. Không
dùng Commander ở feature này vì chưa có CLI.

**Storage**: SQLite file qua `better-sqlite3`, WAL, `synchronous=FULL`, `foreign_keys=ON`, busy timeout
hữu hạn, `locking_mode=EXCLUSIVE` để từ chối bên ghi thứ hai. Migration SQL có phiên bản.

**Testing**: Vitest + fast-check. Bốn nhóm: unit (loader, policy), scenario (bảng given/when/then cho
US1–US5), property (bất biến tầng quyết định), integration (kho thật, crash injection). Nhóm reliability
(10.000 chuỗi, 200 lần ngắt) chạy bằng script riêng.

**Target Platform**: Linux/Ubuntu hoặc WSL2, filesystem Linux cục bộ (SPEC.md §2.1). Máy dev hiện tại
là Windows với Node 22 và chưa có pnpm, nên cổng chất lượng phải chạy trong WSL2 (xem quickstart).

**Project Type**: Thư viện TypeScript nội bộ (một package), dùng qua giao diện lập trình; chưa có CLI
hay daemon.

**Performance Goals**: Kiểm tra cấu hình dưới 500 dòng trong dưới 1 giây (SC-002). Bộ 10.000 chuỗi
tín hiệu chạy xong trong thời gian hợp lý cho CI (mục tiêu dưới 10 phút; không phải tiêu chí nghiệm
thu).

**Constraints**: `decide`/`evolve` không I/O, không đồng hồ, không ngẫu nhiên (FR-012); transaction
không `await` (FR-025); không ghi 0 thay usage thiếu (FR-024); không framework workflow, ORM hay DI
container (nguyên tắc VIII).

**Scale/Scope**: Một người dùng, một bên ghi. Ước tính cỡ chục project và vài trăm task trong kho
kiểm thử. Workflow duy nhất được chạy là workflow phát triển phần mềm mặc định (FR-041).

Không còn mục NEEDS CLARIFICATION về công nghệ: stack đã cố định ở SPEC.md §17.2; các lựa chọn thiết kế
được giải quyết trong [research.md](research.md). Ba điểm SPEC.md chưa nói rõ đã được chủ dự án
chốt ngày 2026-10-27: lỗi cấu hình dùng `needs_info` (R-13), đơn vị của sàn task là `(tier, effort_rank)`
(R-18), và chọn tạo task mới thì hủy task cũ (R-16).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Nguyên tắc | Trước thiết kế | Sau thiết kế (Phase 1) |
|---|---|---|
| I. Lõi tất định | Đạt: FR-012, FR-027, FR-034 yêu cầu hàm thuần, thứ tự từ sequence, giải thích không LLM | Đạt: `now`/`ids` nằm trong phong bì tín hiệu ([R-04](research.md#r-04-thời-điểm-và-id-đi-vào-lõi-thế-nào)); ESLint chặn `node:*`, `Date`, `Math.random` trong `src/engine`, `src/domain` ([R-12](research.md#r-12-ranh-giới-module-và-cách-chặn-io-trong-lõi)) |
| II. Effect sau commit, idempotent | Đạt: FR-016, FR-025, FR-031. Feature không có executor; "một daemon ghi" được thay ở mức kho bằng FR-032 | Đạt: effect là sự kiện, outbox là projection ([R-07](research.md#r-07-effect-timer-và-outbox-là-projection-của-nhật-ký)); claim kiểm tra vô hiệu hoá, source drift và revision trong cùng transaction ([R-16](research.md#r-16-điều-kiện-claim-effect)); đối chiếu thiếu dữ liệu giữ `unknown` ([R-17](research.md#r-17-kết-quả-đối-chiếu-effect)); khoá độc quyền SQLite ([R-06](research.md#r-06-một-bên-ghi-ở-mức-kho)) |
| III. Mọi thứ có giới hạn | Đạt: FR-019–FR-023 (thang, lượt, ngân sách giữ chỗ/đã dùng, deadline), FR-003 (chu trình có bộ đếm) | Đạt: số ID trong phong bì có trần; mọi lý do chờ có điều kiện tiếp tục ([data-model](data-model.md#lý-do-chờ-và-chi-tiết)) |
| IV. Bằng chứng, không phải lời agent | Đạt: FR-014, FR-015 | Đạt: kết quả agent chỉ qua bước khi tín hiệu mang `schema_checked: true` và đúng attempt hiện hành |
| V. Người dùng giữ quyền | Đạt: FR-005, FR-036 (admin), FR-021 (approval), FR-006/FR-039 | Đạt: amendment đòi `AuthzContext` có `admin`; merge chỉ khi có approval gắn head SHA ([R-10](research.md#r-10-phạm-vi-merge-ở-feature-này)) |
| VI. Lõi trung lập | Đạt: engine diễn giải workflow theo loại bước; gate là tên logic từ `cusr.yaml` | Đạt: không có tên vendor/ngôn ngữ trong `src/engine`; harness/model chỉ là chuỗi từ cấu hình |
| VII. Kiểm chứng và báo cáo trung thực | Đạt: FR-035 và bảng bằng chứng theo bất biến tách đúng tầng | Đạt: bộ 10.000 chuỗi qua kho dùng SQLite in-memory cùng schema, còn độ bền chỉ lấy từ crash test trên file thật ([R-09](research.md#r-09-chạy-10000-chuỗi-qua-kho-mà-không-mạo-nhận-độ-bền)); I05 ghi "chưa thuộc phạm vi" |
| VIII. Đơn giản | Đạt: một package, không daemon/CLI sớm | Đạt: một package, module theo thư mục, không ORM/DI; chỉ thêm dependency có trong baseline |

**Ngoại lệ:** không có. **Complexity Tracking:** không cần.

**Cổng chất lượng của thay đổi này:** plan và artifact Phase 1 chỉ là tài liệu, nên áp kiểm tra tài
liệu (liên kết nội bộ, mã I/S/R/§/FR khớp, không còn placeholder). Typecheck, lint, test, build: "chưa
khả dụng" vì repo chưa có mã nguồn hay `package.json`.

## Project Structure

### Documentation (this feature)

```text
specs/001-deterministic-core/
├── spec.md
├── plan.md              # File này
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/           # Phase 1
│   ├── config.md        # Định dạng cấu hình và chẩn đoán
│   ├── core-api.md      # Giao diện lập trình công khai
│   └── signals-events.md# Tín hiệu, sự kiện, effect, mã lỗi
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 ($speckit-tasks), chưa tạo
```

### Source Code (repository root)

```text
package.json             # pnpm, engines.node pin Node 24, scripts typecheck/lint/test/build
pnpm-lock.yaml
tsconfig.json            # strict + các cờ của SPEC.md §17.2
tsconfig.build.json      # tsc → dist/ (ESM), noEmitOnError
eslint.config.js         # typescript-eslint, no-floating-promises, ranh giới module
vitest.config.ts

src/
├── shared/              # assertNever, Result, canonical JSON + sha256, duration, Uuid/EpochMs brand
├── domain/              # Zod schema: task chuẩn, trigger, event, effect, wait reason, policy types
├── config/              # loader YAML có vị trí, schema user/project, hợp nhất pack→project, 6 kiểm tra
│                        # (pack do caller truyền vào; pack mẫu nằm ở test/fixtures/packs/)
├── policy/              # freeze FrozenPolicy + FrozenExecutionContext, binding, thang, amendment
├── engine/              # decide, evolve, diễn giải theo loại bước, escalation, budget, cancel,
│                        # revision/source drift, merge guard, phân loại CI, claimable
├── store/               # mở SQLite, pragma, khoá; migrations/*.sql; accept, claim, timers, verify
├── explain/             # giải thích trạng thái từ projection + nhật ký
└── index.ts             # API công khai (contracts/core-api.md)

test/
├── unit/                # config/, policy/, shared/
├── scenarios/           # us1-config, us2-decide, us4-escalation, us5-explain (given/when/then);
│                        # scenario của US3 nằm ở integration/store/us3-scenarios.test.ts
├── property/            # arbitraries/, invariants/*.test.ts (I01, I04, I06–I12 ở mức quyết định)
├── integration/         # store/*.test.ts, crash/*.test.ts (SQLite file thật)
├── reliability/         # r4-sequences.test.ts (10.000), r1-crash.test.ts (200) — chạy riêng
├── fixtures/            # configs/{valid,invalid}/, signals/*.json
└── support/             # simulator (fake executor), crash-child.ts, temp DB helpers

scripts/
└── report-invariants.ts # đọc kết quả Vitest JSON + bảng ánh xạ, in báo cáo SC-008
```

**Structure Decision**: Một package ở gốc repo. Ranh giới giữa `engine`/`domain` (thuần) và
`store`/`config` loader (có I/O) được giữ bằng thư mục và luật ESLint, không bằng nhiều package.
Feature sau (runner, daemon, CLI) thêm thư mục `src/runner`, `src/daemon`, `src/cli`; khi đó mới xét
tách workspace nếu cần build riêng `cusr-runner`.

## Complexity Tracking

Không có vi phạm cần biện minh.
