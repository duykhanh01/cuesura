# Quickstart: kiểm chứng lõi điều phối tất định

Hướng dẫn chạy để chứng minh feature 001 hoạt động. Hợp đồng chi tiết ở [contracts/](contracts/) và
[data-model.md](data-model.md); file này chỉ nêu lệnh và kết quả mong đợi.

## Điều kiện

- WSL2/Ubuntu hoặc Linux, repo nằm trên filesystem Linux (không phải `/mnt/c`). Lý do ở
  [research R-15](research.md#r-15-môi-trường-phát-triển).
- Node 24 LTS đúng bản pin trong `.nvmrc`; pnpm qua Corepack.
- Toolchain để build `better-sqlite3` khi không có prebuilt: `build-essential`, `python3`.

```bash
corepack enable
```

```bash
pnpm install --frozen-lockfile
```

## Cổng chất lượng

Bốn kiểm tra riêng; một bên xanh không thay bên khác (nguyên tắc VII).

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm test
```

```bash
pnpm build
```

Mong đợi: cả bốn thoát mã 0. `pnpm lint` thất bại nếu `src/engine` import `node:*` hoặc dùng `Date`
(research R-12). `pnpm test` chạy nhóm unit, scenario, property (số lần chạy mặc định) và integration,
không gồm nhóm reliability.

## Kịch bản theo user story

Mỗi user story có một file scenario dạng given/when/then; số scenario trong file khớp số thứ tự trong
spec.

| Story | Lệnh | Mong đợi |
|---|---|---|
| US1 cấu hình và chốt chính sách | `pnpm test test/scenarios/us1-config.test.ts` | 11 scenario đạt; lỗi in dạng `file:dòng:cột code`; khả năng chưa hỗ trợ không làm cấu hình lỗi |
| US2 quyết định tất định | `pnpm test test/scenarios/us2-decide.test.ts` | 14 scenario đạt; mỗi scenario phát lại hai lần cho cùng kết quả |
| US3 tín hiệu bền, đúng một lần | `pnpm test test/integration/store` | 8 scenario đạt trên file SQLite tạm |
| US4 nâng nấc và ngân sách | `pnpm test test/scenarios/us4-escalation.test.ts` | 13 scenario đạt |
| US5 giải thích | `pnpm test test/scenarios/us5-explain.test.ts` | 2 scenario đạt; không có lời gọi mạng |

Property test của tầng quyết định (`test/property/invariants`) phải gồm, ngoài các bất biến I01–I12:

- thang có độ dài và binding khác nhau giữa các role: nấc được chọn luôn nằm trong thang của role, không
  bao giờ giảm, và không bao giờ là `denied` hay `needs_approval` khi chưa có approval (FR-020, R-18);
- không effect nghiệp vụ nào được claim khi task có source drift chưa giải quyết, đang hủy hoặc revision
  của effect đã cũ (FR-011, R-16);
- không effect merge nào được yêu cầu khi tập required checks chưa đầy đủ hoặc head chưa chứa base
  (FR-015, R-10).

Fixture cấu hình nằm ở `test/fixtures/configs/{valid,invalid}`. Mỗi file invalid ghi lỗi mong đợi trong
comment đầu file, và test so khớp chính xác `code`, `line`, `col`.

## Nhóm reliability

Chạy riêng vì tốn thời gian. Đây là bằng chứng cho SC-003, SC-005 và SC-007.

```bash
pnpm test:reliability
```

Mong đợi:

- `r4-sequences`: 10.000 chuỗi tín hiệu ngẫu nhiên qua `decide`/`evolve` và kho in-memory, không vi phạm
  bất biến nào; gửi lại mỗi tín hiệu 2–5 lần không đổi số sự kiện, effect hay timer.
- `r1-crash`: 200 lần `SIGKILL` tại các điểm ghi trên file SQLite thật (WAL, `synchronous=FULL`); sau mỗi
  lần, `integrity_check` = `ok`, tín hiệu đã commit còn đủ, `verifyProjections` khớp 100%.
- Khi có lỗi, output in `seed` và `path` của fast-check, hoặc `seed` và `CUSR_CRASH_AT` của lần ngắt.

Tái hiện một lỗi:

```bash
pnpm test:reliability --seed <seed>
```

## Báo cáo bất biến (SC-008)

```bash
pnpm report:invariants
```

Mong đợi: bảng đủ I01–I12. I05 ghi "chưa thuộc phạm vi". Mọi bất biến khác ghi "có bằng chứng" kèm tên
bộ kiểm thử đã chạy và đạt ở lần `pnpm test` và `pnpm test:reliability` gần nhất. Script thoát lỗi khi
thiếu kết quả của một trong hai nhóm hoặc có bộ bị skip/fail.

## Đo SC-002

```bash
pnpm test test/unit/config/perf.test.ts
```

Mong đợi: kiểm tra cấu hình mẫu 500 dòng xong dưới 1 giây (trung vị của 20 lần chạy).
