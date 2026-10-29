# Cổng lát A — owner chốt NO-GO, B/C giữ đóng

**Review:** 2026-10-30 (Asia/Ho_Chi_Minh) · **Hạn đánh giá:** 2026-11-06 · **Base nghiệm thu T078:** `bc9d84a` + sửa fixture layout bwrap đã merge ở PR #19 (`2105b74`; source hashes ở ledger).
**Host:** Ubuntu 24.04.5. T072 (#16/#18) và T139 (#17) đã merge vào base.

**Chốt kỹ thuật: NO-GO.** T078 đạt 20/20 seeds mới; typecheck/lint/test/build sạch. Điều kiện
S0.1–S0.3 chưa thể xác nhận đầy đủ vì archive thiếu 7 stderr.log gốc và chưa chứng nhận lại
vendor/auth/rules hiện hành. Test xanh không thay proof còn thiếu. B/C giữ đóng.

**T080 đã chốt: owner xác nhận NO-GO**, ghi nhận lúc **2026-10-30 00:36:40 +07:00**
(2026-10-29 17:36:40 UTC), sau khi được báo kết quả T078 và các cách bổ sung evidence.
Phase 6 hoàn tất việc review/quyết định; điều kiện mở B chưa đạt.

## Quyết định owner — T080

| Trường | Giá trị |
| --- | --- |
| Kết luận kỹ thuật | **NO-GO**, sau T078 trên `bc9d84a` |
| Quyết định tường minh của owner | **NO-GO**, giữ B/C đóng |
| Người quyết định | Chủ dự án, qua chỉ đạo trong phiên làm việc này |
| Thời điểm ghi nhận | **2026-10-30 00:36:40 +07:00** (2026-10-29 17:36:40 UTC) |
| Căn cứ xác nhận | Owner nói “thôi chốt t80 đi” sau phần giải thích NO-GO và phương án bổ sung/chạy lại evidence |
| Lý do | T078 đạt nhưng còn thiếu 7 stderr.log spike gốc; vendor/auth/rules hiện hành chưa được chứng nhận lại. Chốt NO-GO theo evidence hiện có |
| Điều kiện mở B | Khép evidence A, review budget/effort, owner ghi **go** tường minh |

Đã ghi quyết định, thời điểm và lý do theo [T080](tasks.md); task được tick hoàn tất.
Lượt này chỉ ghi nhận quyết định, không chạy proof model mới. Không mở B hoặc tự merge PR báo cáo.

## Điều kiện kỹ thuật sau T078

| Điều kiện theo plan | Bằng chứng | Đánh giá |
| --- | --- | --- |
| S0.1–S0.3 có proof đầy đủ còn hiệu lực | [Spike T009](spike-0-report.md#t009--kết-luận-gate-lát-0-2026-10-28), [audit mới](evidence/t078-host.json) | **Chặn go:** 264/271 file khớp hash, 7 stderr.log thiếu, 0 lệch; vendor/auth/rules live chưa được chứng nhận lại |
| US1/US2/US4, M01–M08, ≥20 seeds | [T078](acceptance-report.md#t078--nghiệm-thu-lại-sau-hợp-nhất-t072-và-t139), [ledger mới](evidence/t078-validation.json) | **Đạt core A:** 20/20 seeds 2026102921–2026102940, 14,020 test executions, 0 skip; hai mode, một worktree/branch/PR, zero logical publish duplicate/merge requests |
| Boundary/secret/reviewer ro | Real bwrap/harness/systemd + same-vendor ro trong baseline và từng seed; T072 dirty worktree/layout pin | **Đạt phạm vi A:** không skip OS tests, canary redact, user dirty diff không gán cho worker; không chứng nhận paid smoke |
| Limits/drain/projection + quality gates | [Ledger](evidence/t078-validation.json): typecheck/lint/build exit 0, baseline 106 file/1468 test pass, 0 skip | **Đạt phạm vi A:** Clock limits và SQLite reopen/replay; crash I/O B chưa đến lượt |
| Effort, budget và 117 coverage | [117 FR](phase6-coverage.md), bảng B/C dưới đây | Truy vết đủ 117; effort lịch sử không có timesheet, budget còn lại chưa được owner xác nhận |

S0.1: [host manifest](../../test/fixtures/runtime/spike-0/host/manifest.json),
[isolation record](../../test/fixtures/runtime/spike-0/harness/real-20261028/isolation-record.json).
S0.2: [harness manifest](../../test/fixtures/runtime/spike-0/harness/real-20261028/manifest.json),
[capabilities](../../test/fixtures/runtime/spike-0/harness/real-20261028/capability-manifest.json).
S0.3: [merge-event](../../test/fixtures/runtime/spike-0/github/real-20261028-merge-event/manifest.json),
[rules](../../test/fixtures/runtime/spike-0/github/live-rules/manifest.json),
[T009 recheck](../../test/fixtures/runtime/spike-0/github/t009-recheck/manifest.json).
Đây là evidence lịch sử có provenance; hash archive không chứng minh auth/rules live.
Ubuntu là đích đã chọn; không yêu cầu quay lại WSL2. Không gọi model trả phí ở lượt này.

## Điều kiện để review lại

1. Khôi phục đúng 7 log theo expected digest trong audit, hoặc nghiệm thu lại proof bị ảnh hưởng
   với quyền/budget cụ thể; không dựng log thay thế. Đối chiếu version/auth/boundary/rules theo S0.1–S0.3.
2. Nếu muốn mở B, owner đánh giá lại budget/effort B/C và ghi quyết định **GO mới** cùng thời điểm
   và lý do; giữ bản ghi NO-GO T080 này làm lịch sử.

T072/T139/T078 đã khép trong phạm vi task; không còn là blocker. H05 crash I/O mở rộng T082/T093,
≥200 daemon kills T094, CLI/T111, paid smoke C và resume vendor thật T099/T126 vẫn ở B/C.
Giữ `session_resume`/hard USD cap unknown theo manifest; không kéo paid smoke hoặc crash B ngược về
A. Không giảm 200 crash/quyền/idempotency/smoke để đổi kết luận.

## Effort và budget B/C

Kickoff 2026-10-28; budget v1 khoảng 4 tuần, mốc kế hoạch 2026-11-25. Hạn review 2026-11-06 giữ nguyên.
Lượt T078 đo được 1772.414 giây tổng lệnh quality gates + 20 seeds. Đây là thời gian chạy lệnh,
không phải timesheet. Audit kiểm 271 tham chiếu; không phát sinh model usage hoặc provisioning host.
Tổng effort/chi phí lịch sử toàn phase **chưa có dữ liệu đáng tin**, không suy từ số test/checkbox.

| Phần còn lại | Backlog | Ước lượng kỹ thuật, chưa cam kết |
| --- | --- | --- |
| Điều kiện để đổi kết luận A | Evidence spike + review budget/effort và quyết định GO mới | Chưa ước lượng được thời gian tìm lại bytes gốc; proof trả phí mới cần budget/phạm vi cụ thể |
| B — recovery | T081–T094: 14 task, ≥200 daemon kills/replay | 5–8 ngày công |
| B — tương tác/CLI | T095–T120: 26 task | 4–6 ngày công |
| C — smoke/report | T121–T134: 14 task | 3–5 ngày công, cộng thời gian owner merge/credential/model budget |
| Tổng B/C | 54 task | 12–19 ngày công + thời gian chờ/evidence A; không quy đổi USD khi chưa duyệt binding/budget C |

Ước lượng giữ giả định một người triển khai chính, không đổi spec; không phải measured velocity.
Chưa có căn cứ chắc để xác nhận phần còn lại vừa budget 4 tuần. [Coverage](phase6-coverage.md)
đóng T072 trong A và giữ mọi nghĩa vụ B/C; đủ 117 mã không có nghĩa 117 yêu cầu đã nghiệm thu.

## Trạng thái sau review

- T072/T077/T139/T078: đạt phạm vi A/fixture/property/OS theo report; không chứng nhận paid resume/smoke.
- T079: review cập nhật đủ bằng chứng mới và phần còn chặn.
- T080: **hoàn tất, owner chốt NO-GO** lúc 2026-10-30 00:36:40 +07:00. Phase 6 đã ghi đủ kết quả/quyết định; **B/C giữ đóng**.
