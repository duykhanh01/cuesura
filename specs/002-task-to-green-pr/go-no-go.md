# Cổng lát A — đề nghị no-go, chờ owner quyết định

**Review:** 2026-10-29 · **Hạn đánh giá giữ nguyên:** 2026-11-06 · **Base:** `c1a8b9e`.
**Host owner chọn:** Ubuntu; không yêu cầu WSL2. **B/C chưa được mở.**

Đề nghị **no-go** vì T072 chưa hợp nhất, T078 chưa nghiệm thu lại trên mã sau T139; bộ evidence spike
còn thiếu 7 file gốc. Baseline xanh và 20 seeds kiểm repeatability là thông tin hỗ trợ, không chứng
minh các phần chưa kiểm. Không cắt ≥200 crash, permission/idempotency hay smoke để đổi kết luận.

## Quyết định owner — T080

| Trường | Giá trị |
| --- | --- |
| Quyết định | **Chưa có**; đề nghị kỹ thuật ở trên không phải quyết định owner |
| Người quyết định | Chủ dự án, chờ trả lời tường minh |
| Thời điểm quyết định | Chưa có |
| Lý do được owner chốt | Chưa có |
| Điều kiện mở B | Chỉ sau khi xử lý các điều kiện A còn thiếu, review lại và ghi **go** tường minh |

Trong lượt này, owner đã cho tiếp tục với 4 mục checklist giữ nguyên và chọn Ubuntu.
Hai xác nhận đó không phải go cho B. T080 sẽ chỉ được tick sau khi ghi câu trả lời, thời điểm và
lý do cụ thể của owner. Không suy go hoặc no-go từ im lặng.

## Điều kiện kỹ thuật

| Điều kiện theo plan | Bằng chứng | Đánh giá |
| --- | --- | --- |
| S0.1–S0.3 có bằng chứng truy vết | [Spike T009](spike-0-report.md#t009--kết-luận-gate-lát-0-2026-10-28), [host/hash audit](evidence/phase6-host.json) | Lịch sử còn truy vết; 261/268 file khớp hash, 7 stderr.log thiếu; không xác nhận toàn bộ evidence còn đầy đủ |
| US1/US2/US4 + M01–M08, ít nhất 20 seeds | [Report](acceptance-report.md#nghiệm-thu-phase-6--cổng-lát-a), [ledger](evidence/phase6-seeds.json) | T139 đã khép local, xem [matrix mới](acceptance-report.md#t139--kiểm-tổng-hợp-m01m08-và-h01h06); 20 seeds cũ không thay T078 sau hợp nhất T072 |
| Boundary/secret/reviewer ro | OS Ubuntu: sandbox 3/3, harness 2/2, supervisor 1/1; negative contracts/lifecycle pass | T077 đã kiểm lại độc lập. T072 còn thiếu kiểm boundary/user dirty diff trước worker; không nhận code từ worktree T072 chưa merge |
| Limits/drain/projection + quality gates | Clock tests, SQLite reopen/projection, typecheck/lint/test/build | Baseline lượt đầu 1.431 test; kết quả T139 mới ở [ledger](evidence/t139-validation.json), không thay crash I/O B |
| Effort, budget và 117 coverage | [117 FR](phase6-coverage.md), bảng B/C bên dưới | Truy vết đủ 117, chưa phải 117 pass; effort lịch sử không có timesheet nên không bịa tổng giờ |

Các binary/hash/probe hiện hành trong host ledger là của Ubuntu. Fixture lịch sử của WSL2 giữ provenance
cũ; không dùng tên OS làm blocker và không yêu cầu quay lại WSL2. Khi triển khai vendor thật phải pin
binary/settings/permission hiện hành; không dùng fixture replay để tạo capability proven cho production.
Không gọi model hoặc tiêu usage mới trong lượt này.

## Việc cần khép trước review lại A

| Đầu mối | Phần còn thiếu | Điều kiện đủ để đóng |
| --- | --- | --- |
| T072 | So vùng ghi/checkpoint trước worker, bảo vệ dirty diff người dùng và boundary | Runtime + negative tests pass; merge PR riêng rồi kiểm lại trên main mới |
| T139 | **Đã khép local.** Same-vendor/ro; Q&A/stale/rebuild có trần; finalized-review proof; method freeze/config/replay; M/H đầy đủ | [Report T139](acceptance-report.md#t139--kiểm-tổng-hợp-m01m08-và-h01h06), quality gates/default suite; paid smoke và crash B tách riêng |
| Bằng chứng lát 0 | 7 stderr.log tham chiếu nhưng thiếu ở checkout sạch | Tìm lại đúng bytes khớp digest hoặc nghiệm thu lại phần proof bị ảnh hưởng theo quyền/budget riêng; không dựng log thay thế |
| T078 | Chưa chạy lại sau T139 và hợp nhất T072 | T139 đã đóng; hợp nhất T072 rồi chạy bộ assertions hoàn chỉnh ít nhất 20 seeds, lưu ledger mới; giữ ledger chẩn đoán hiện tại |

H05 crash I/O mở rộng vẫn là T082/T093 của B. ≥200 daemon kills T094, CLI/T111, smoke C và proof
resume vendor thật chưa được duyệt usage không được kéo ngược thành điều kiện giả cho A; giữ đúng
phạm vi task gốc và báo unknown khi chưa có proof. T139 đã có matrix local theo yêu cầu trước T078; không thêm cổng trả phí vào A.

## Effort và budget B/C

Kickoff feature 002: 2026-10-28; budget v1 khoảng 4 tuần, tương ứng mốc kế hoạch 2026-11-25.
Ngày review là ngày 2; mốc go/no-go vẫn 2026-11-06, không reset sau PR hoặc đổi host.

Effort đo được: lượt đầu thêm 5 tests, T139 bổ sung 31 cases; kiểm 117/117 mã, audit 268 file tham chiếu,
chạy baseline/OS và ledger 20 seeds có duration theo từng lượt. Không gọi model; không publish PR thử,
không provisioning host. Đây là số phép kiểm và thời gian lệnh, không phải tổng công phát triển.
Git history ghi các PR nền/US1/US2/US4 đã merge; không có timesheet hoặc usage ledger toàn phase
để suy tổng giờ/chi phí lịch sử. Tổng effort đó hiện **không có dữ liệu đáng tin**.

| Phần còn lại | Backlog | Ước lượng để owner đánh giá, chưa cam kết |
| --- | --- | --- |
| Khép A | T072, T078 sau hợp nhất và evidence | 2–4 ngày công tùy mức sửa boundary/context/file recovery; tìm lại log có thể cần đầu vào bên ngoài |
| B — recovery | T081–T094: 14 task, ≥200 daemon kills/replay | 5–8 ngày công; trọng tâm spawn/commit/push/PR/drain unknown, unit/spool re-adopt |
| B — tương tác/CLI | T095–T120: 26 task | 4–6 ngày công; một phần code đã có, vẫn cần kiểm quyền/CLI/inbox/recheck/cancel/restart |
| C — smoke/report | T121–T134: 14 task | 3–5 ngày công, cộng thời gian owner merge/credential/model budget và host/vendor proof |
| Tổng còn lại | 54 task B/C + khép A | Khoảng 14–23 ngày công; không quy đổi thành USD khi chưa có binding/budget C được duyệt |

Đây là ước lượng kỹ thuật với giả định một người triển khai chính, dependency hiện tại giữ ổn định,
không đổi spec; không phải measured velocity. Vì chưa có tổng effort lịch sử và các điểm nối
runtime chưa đủ, chưa có căn cứ chắc rằng phần còn lại vừa budget 4 tuần. Owner cần chốt lại sau
khi A đủ bằng chứng; không đề nghị go chỉ vì số test xanh hoặc số checkbox.

## Trạng thái tasks của lượt review

- T077: hoàn tất trong phạm vi fixture/protocol/OS Ubuntu; không chứng nhận paid resume/smoke.
- T079: bản review và 117 coverage sẵn sàng để owner quyết định.
- T139: khép phạm vi local theo matrix/report mới. T072/T078 còn mở, giữ lý do và bằng chứng trong tasks/report.
- T080: chờ quyết định owner, chưa tick. B/C giữ đóng.
