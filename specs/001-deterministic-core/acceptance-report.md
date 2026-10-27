# Báo cáo nghiệm thu: 001 lõi điều phối tất định

Kết quả thật của lần chạy [quickstart.md](quickstart.md) ngày 2026-10-27, trên cây làm việc dựa trên commit
`79c924a` cộng các thay đổi của Phase 8 (T108–T115). Báo cáo này ghi lại kết quả của các lệnh đã chạy,
không thay chúng bằng kiểm tra mô phỏng (nguyên tắc VII).

## Môi trường

| Mục | Giá trị |
|---|---|
| Hệ điều hành | Ubuntu 24.04.5 LTS, Linux gốc (kernel 7.0.0-38-generic), **không phải WSL2** |
| Filesystem | ext4 trên NVMe; repo và thư mục tạm của crash test (`/tmp`) đều trên filesystem Linux |
| Node | 24.22.1 (khớp `.nvmrc`) |
| pnpm | 12.15.0 |

T115 yêu cầu chạy trong WSL2. Lần chạy này dùng Linux gốc; quickstart.md và research R-15 chấp nhận
Linux, vì thứ cần kiểm là `SIGKILL` và khoá file của Linux. **Chưa có lần chạy nào trong WSL2.**

## Cổng chất lượng

| Lệnh | Kết quả | Ghi chú |
|---|---|---|
| `pnpm typecheck` | đạt (exit 0) | |
| `pnpm lint` | đạt (exit 0) | gồm luật ranh giới R-12 |
| `pnpm test` | đạt (exit 0) | 40 file, 324 test, 29,3 s |
| `pnpm build` | đạt (exit 0) | |
| `pnpm test:reliability` | đạt (exit 0) | 2 file, 202 test, 800 s |
| `pnpm report:invariants` | đạt (exit 0) | 11 bất biến "có bằng chứng", I05 "chưa thuộc phạm vi" |

## Kịch bản theo user story

Số scenario trong mỗi file khớp số acceptance scenario của spec. Tất cả đều đạt trong lần `pnpm test` ở trên.

| Story | File | Scenario | Kết quả |
|---|---|---|---|
| US1 | `test/scenarios/us1-config.test.ts` | 11 | đạt |
| US2 | `test/scenarios/us2-decide.test.ts` | 14 (26 test) | đạt |
| US3 | `test/integration/store/us3-scenarios.test.ts` | 8 (11 test) | đạt |
| US4 | `test/scenarios/us4-escalation.test.ts` | 13 (19 test) | đạt |
| US5 | `test/scenarios/us5-explain.test.ts` | 2 (8 test) | đạt |

Quickstart nói US5 "không có lời gọi mạng". Không có test nào chặn mạng lúc chạy. Bằng chứng duy nhất là
bằng chứng tĩnh: `src/explain/**` nằm trong ranh giới lõi thuần, không được import `node:*`.

## Tiêu chí thành công

| SC | Bằng chứng | Kết quả |
|---|---|---|
| SC-001 | `test/unit/config/invalid-fixtures.test.ts`, `us1-config` | đạt |
| SC-002 | `test/unit/config/perf.test.ts` (trung vị 20 lần, cấu hình 500 dòng < 1 s) | đạt |
| SC-003 | `test/reliability/r4-sequences.test.ts`: 10.000 chuỗi qua `decide`/`evolve` và `openMemoryStore`. Sau mỗi `accept`/claim kiểm: quyết định của kho trùng lõi thuần, seq/global_seq, cạnh trạng thái, trạng thái kết thúc là hút, revision không giảm, khoá idempotency duy nhất, ≤ 8 ID mỗi quyết định, lượt vào bước và ngân sách, projection `tasks` khớp nhật ký, chính sách đã chốt không đổi, điều kiện merge (oracle độc lập), attempt chỉ trên nấc của thang, đúng binding, không nấc `denied`, nấc `needs_approval` có approval | đạt (787 s) |
| SC-004 | `determinism.test.ts` (`replayCheck`), `us2-decide` | đạt |
| SC-005 | `test/reliability/r1-crash.test.ts`: 200 lần `SIGKILL` tại điểm và lần đi qua chọn theo seed 20261027, trên 8 workload hai task xen kẽ; WAL + `synchronous=FULL`. Mỗi lần: `integrity_check = ok`, nhật ký bằng đúng tiền tố mong đợi (thao tác đã commit còn đủ, chưa commit không để lại gì), `verifyProjections` không lệch, chạy tiếp cho kết quả cuối giống chuỗi không bị ngắt. Bảy điểm R-08 đều được chọn | đạt (172 s) |
| SC-006 | `transitions.test.ts`, `us5-explain`, kiểm tra trong `Sim` và r4 | đạt |
| SC-007 | r4: gửi mỗi tín hiệu 2–5 lần, rồi gửi lại cả chuỗi một lượt nữa; số sự kiện, effect, timer và tín hiệu đã chấp nhận, cùng nội dung ba bảng, đều bằng lần gửi một lần | đạt |
| SC-008 | `pnpm report:invariants` (bảng dưới) | đạt |

Giới hạn của bằng chứng:

- `SIGKILL` không làm mất buffer của hệ điều hành. r1 chứng minh tính nguyên tử và khả năng phục hồi khi
  tiến trình chết, nhưng không chứng minh độ bền khi mất điện. Đột biến `synchronous=OFF` sẽ không bị r1
  phát hiện.
- Chuỗi trong r4 dùng bộ sinh của property test (`choicesArb()`). Phần lớn chuỗi ngắn: trung vị khoảng 10
  thao tác, dài nhất khoảng 24. Chuỗi sâu hơn (tới merge, nâng nhiều nấc) được phủ ở property test riêng
  với `choicesArb(160, 60)`, không nằm trong con số 10.000.
- Để kiểm chứng rằng hai bộ reliability phát hiện được lỗi, đã chạy thử với đột biến tạm (không commit):
  bỏ dedup trong `accept` làm r4 fail và in `seed`/`path`; tách transaction của claim làm r1 fail ở
  15/60 lần ngắt.

## Bất biến (SC-008)

Đầu ra của `pnpm report:invariants` ở lần chạy này (rút gọn cột bộ kiểm thử):

| Bất biến | Phạm vi | Trạng thái | Bộ reliability/lint mới |
|---|---|---|---|
| I01 Quyết định tất định | đầy đủ | có bằng chứng | `boundaries`, `r4-sequences` |
| I02 Một bên ghi | một phần | có bằng chứng | — |
| I03 Ghi nguyên tử, effect sau commit | một phần | có bằng chứng | `r1-crash` |
| I04 Khoá idempotency | một phần | có bằng chứng | `r4-sequences` |
| I05 Worktree riêng, tuần tự | ngoài phạm vi | chưa thuộc phạm vi | — |
| I06 Bằng chứng, không phải lời agent | một phần | có bằng chứng | — |
| I07 Mọi thứ có giới hạn | một phần | có bằng chứng | `r4-sequences` |
| I08 Bất biến theo revision | một phần | có bằng chứng | `r4-sequences` |
| I09 Role, binding, approval, ngân sách | một phần | có bằng chứng | `r4-sequences` |
| I10 Thứ tự sự kiện, trigger lặp | đầy đủ | có bằng chứng | `r4-sequences`, `r1-crash` |
| I11 Điều kiện merge | một phần | có bằng chứng | `r4-sequences` |
| I12 Kết thúc không mở lại | đầy đủ | có bằng chứng | `r4-sequences` |

Danh sách đầy đủ bộ kiểm thử của từng bất biến nằm ở `test/invariants.map.ts` và được in lại mỗi lần
chạy script. Đã kiểm rằng script thoát mã 1 khi thiếu `reports/vitest-reliability.json`.

## Chưa đạt hoặc chưa kiểm

- Chưa chạy trong WSL2 (xem Môi trường).
- US5 "không có lời gọi mạng" chỉ có bằng chứng tĩnh.
- I05 ngoài phạm vi feature này.

## Hành trình liên quan

Feature này chỉ là lõi: không có daemon, CLI, agent thật, git hay GitHub. Lõi phục vụ một phần các hành
trình của SPEC.md như sau.

| Hành trình | Feature này phục vụ | Còn thuộc feature sau |
|---|---|---|
| S01 Giao task có acceptance | Task chuẩn, dedup theo `(project, source_key)`, workflow code → review → PR → CI → merge ở mức quyết định, chỉ kết thúc khi merge được xác nhận | Nhận task qua CLI/GitHub, chạy agent, tạo PR và merge thật |
| S02 Task thiếu thông tin | PENDING `confirmation`/`needs_info`, chưa yêu cầu effect nào trước khi xác nhận | Kênh hỏi và xác nhận cho người dùng |
| S03 Gate/review/CI phát hiện lỗi | Vòng sửa có giới hạn, phân loại lỗi, backoff, nâng nấc theo thang đóng băng, truy vết bằng nhật ký và `explain` | Chạy gate, đọc log CI, gọi agent thật |
| S04 Agent hỏi giữa chừng | Câu hỏi, trả lời một lần làm task tiếp tục, dedup tín hiệu trả lời | Inbox, Telegram, comment GitHub |
| S05 Daemon dừng giữa chừng | Ghi nguyên tử, khôi phục sau `SIGKILL`, effect `unknown` và đối chiếu, không yêu cầu effect hai lần | Daemon, probe effect thật, danh tính tiến trình |
| S06 Hết hạn mức, hạ tầng lỗi | WAITING có lý do và timer kiểm tra lại; lỗi hạ tầng không nâng model | Đo hạn mức subscription, pool |
| S07 Task độc lập hoặc phụ thuộc | Chờ dependency, phát hiện chu trình | Pool, chạy song song, worktree riêng (I05) |
| S08 Base đổi, tắt yolo | Điều kiện merge gắn head/base, CI và approval cũ hết hiệu lực khi đổi revision | Theo dõi base thật, quyền yolo theo repo |
| S09 Sửa yêu cầu, lật quyết định | Source drift, revision mới tại ranh giới an toàn, amendment chính sách, nhật ký đầy đủ | Lật quyết định của decider, hoàn tác side effect ngoài hệ thống |
| S10 Hỏi tiến độ, backup, nâng phiên bản | `explain` từ dữ liệu đã ghi, `verifyProjections`, `schema_version` của sự kiện | CLI `--json`, backup/restore, kiểm tương thích phiên bản |
