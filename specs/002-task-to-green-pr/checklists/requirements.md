# Specification Quality Checklist: Luồng thực thi từ task tới PR xanh

**Purpose**: Validate specification completeness and quality before proceeding to planning

**Created**: 2026-10-27

**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [ ] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [ ] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [ ] No implementation details leak into specification

## Applicability and validation notes

- Phạm vi đối chiếu hiện tại: **46 nhóm FR-001–FR-046**, gồm **117 mục nghiệm thu** sau khi
  tách 12 nhóm dài thành 83 mục con; **12 tiêu chí SC-001–SC-012**, 6 user story và
  10 edge case EC-001–EC-010. Bảng truy vết bao phủ mọi mục FR độc lập và mọi SC.
- **12/16 tiêu chí tổng quát đạt; 4 tiêu chí chưa đánh dấu được giải thích dưới đây.** Không tuyên bố
  spec hoàn toàn phi kỹ thuật hoặc dành cho người không có kiến thức vận hành.
- Hai tiêu chí “No implementation details” không đạt theo nghĩa tuyệt đối: FR-008 mô tả danh tính
  process/PID reuse, FR-018 dùng SHA/force-push và FR-042 chỉ định nguồn GitHub/project. Đây là hợp đồng
  vận hành của sản phẩm và ranh giới đúng/sai cần kiểm chứng; spec không chọn thư viện, cờ harness,
  cấu trúc mã nguồn hay cơ chế giao tiếp mới.
- “Written for non-technical stakeholders” không đạt theo nghĩa tuyệt đối: đối tượng chính là chủ
  repo/người vận hành hiểu PR, CI, head/base, worktree và process. Các story mô tả giá trị và kết quả,
  nhưng yêu cầu reliability vẫn cần thuật ngữ kỹ thuật chính xác.
- “Success criteria are technology-agnostic” không đạt tuyệt đối: SC-001/005/008 chỉ đích danh hai
  harness phải hỗ trợ và môi trường service manager; SC-004 kiểm tra projection replay. Bỏ các tên
  này sẽ làm mất điều kiện nghiệm thu sản phẩm, nên giữ và công khai giới hạn của checklist mẫu.
- Review chấp nhận mức kỹ thuật cần thiết cho sản phẩm; bốn mục này là khác biệt có chủ đích với
  checklist tổng quát, không phải quyết định nghiệp vụ còn thiếu. Spec sẵn sàng cho `$speckit-plan`
  với các giới hạn đó được ghi rõ; không báo “16/16 đạt”.
- Mục “Feature meets measurable outcomes” đánh giá việc tài liệu định nghĩa kết quả kiểm chứng được,
  không xác nhận feature đã triển khai. Toàn bộ SC-001–SC-012 vẫn phải được chạy khi nghiệm thu.
- Phạm vi A giữ nguyên, đồng thời nói rõ lớn hơn mốc Luồng xuyên suốt: gồm phần recovery/tương tác và
  smoke thật. Thực thi merge ngoài phạm vi; xác nhận merge thủ công vào branch đích để DONE thuộc
  phạm vi, kể cả khác head đã kiểm với merged_head_unverified và tuyên bố không chứng nhận chất lượng.
- Đã bổ sung kiểm tra trước RUNNING, slot thực thi độc lập với trạng thái chờ, nguồn required checks,
  thu hồi xanh, timeout/recheck và hủy đến quá muộn. SC-004 có replay projection khớp 100%.
- Q1–Q19 đã ghi trong Clarifications: quan sát merge ngoài hệ thống để DONE; quan sát PR có hạn tổng;
  chỉ base tip đổi không kích hoạt xử lý; chờ nhả slot; snapshot trước RUNNING; danh sách checks đóng
  băng phải bao phủ tập yêu cầu GitHub (none khác unknown); giữ feature gộp với thứ tự giao bắt buộc; replay khớp 100%; task retry ngoài
  phạm vi, dùng task add độc lập.
- Thời hạn chờ CI/thực thi tách khỏi hạn quan sát tổng. Poll có backoff tới trần, timeout/retry hữu
  hạn; hết hạn quan sát là observation_expired và ngừng poll. Recheck đối chiếu một lần, thấy merge
  vẫn DONE, không bật lại lịch hoặc reset hạn. Cancel vẫn đối chiếu bắt buộc theo FR-025.
- FR-029 liệt kê lối ra từng detail và yêu cầu explain in đúng; không amend-policy/kiểm lại head mới.
  Cùng priority ưu tiên task đang dở, cùng nhóm theo lúc xin slot. Lỗi config_invalid/capability_missing
  ở PENDING chỉ được thử lại bằng confirm/recheck có dedup, đọc base mới nhất.
- Plan đã chốt hạn quan sát/backoff/drain. Readiness trước A hiện BLOCKED bởi lát 0, không
  đồng nghĩa spec thiếu quyết định nghiệp vụ: host rootless bwrap/systemd, outer boundary,
  nesting/auth/schema/network và gh proof phải có kết quả thật trước xây A. Backlog đã có để mở khóa.
- Review 2026-10-28: Internet outbound mặc định (Q19), snapshot checks giữ string[]/policy+event v1;
  GitHub ghim app cụ thể là mismatch. Giữ gh port và file attempt chuẩn; systemd supervision được
  ghi ADR-0002 và sửa SPEC. Có go/no-go sau A/ngày 10 và token operate riêng cho assistant.
- ADR-0004 thay baseline AppArmor của ADR-0003 bằng Isolated rootless bwrap; không bắt buộc
  AppArmor 4/child stack, không giảm trust boundary. S0.1 kiểm FD/socket, re-exec/copy/raw-userns,
  mount/PID/secret/ro/rw và lifetime thật; thử sandbox nội bộ bật trước. External_verified chỉ sau
  native failure, outer/permission proof và owner config, không bypass quyền hoặc silent fallback.
  V1 chỉ có port SandboxProvider nhỏ và backend bwrap; Native-only/Container/VM chưa triển khai.
- Q15 yêu cầu ghi bền merge và chặn nghiệp vụ, dừng process/đối chiếu effect rồi mới DONE; push đã
  gửi có thể thành công muộn, không hứa thu hồi request. Giữ diff/commit local, claim và bằng chứng
  qua restart; dừng/đối chiếu có giới hạn riêng do plan chốt, hết hạn chờ merge_cleanup_pending và
  recheck hữu hạn, không ghi yêu cầu hủy giả hoặc retry publish.
- Q16 giải phóng dependency chỉ sau DONE, kể cả merged_head_unverified; explain của task phụ thuộc
  hiển thị dấu này cùng bằng chứng. Q17 giữ mốc deadline từ lần workflow chạy đầu: READY chờ slot
  lần đầu chưa tính, xin lại slot sau khi đã chạy có tính; explain tách thời gian chờ slot.
- Q18 được ghi trong [ADR-0001](../../../docs/adr/0001-observe-manual-merge.md): quan sát merge cho
  feature 002, tự merge hoãn sang feature sau, loại cancel-only; một đoạn gồm bối cảnh/quyết định/lý do.
- Đã đối chiếu lõi 001: workflow hiện đi qua approval → effect merge → complete. FR-040 yêu cầu bổ
  sung đường nhận bằng chứng merge ngoài hệ thống; đây là công việc của feature 002, chưa triển khai.
- [Glossary](../../../GLOSSARY.md) đã định nghĩa PR xanh gắn head SHA và slot thực thi; spec phân biệt
  PR xanh với việc đủ điều kiện merge/cập nhật base.
- Các mã FR-001–FR-046 được giữ ổn định để truy vết sang plan/tasks. Story được sắp P1 trước P2:
  US4 là quyền/bằng chứng, US5 là hỏi đáp/hủy.

## Traceability by requirement

Ký hiệu `US1.3` là acceptance scenario 3 của User Story 1; `EC-001` là edge case tương ứng trong spec.
Bảng có 117 hàng; nhóm đã tách được truy vết bằng từng mã con (ví dụ FR-040.01), nhóm còn
nguyên dùng mã FR gốc. Plan/tasks và bằng chứng nghiệm thu phải dùng mã con khi có; không đánh dấu
đạt cả nhóm bằng một bằng chứng chung. Nội dung yêu cầu nằm trong spec, bảng chỉ ánh xạ tới scenario/SC.

| Requirement | Scenario / edge case | Success criteria |
| --- | --- | --- |
| FR-001.01 | US1.2, US1.4, US6.3 | SC-001, SC-007 |
| FR-001.02 | US1.10 | SC-012 |
| FR-001.03 | US1.10 | SC-012 |
| FR-002.01 | US1.3, US1.5 | SC-001, SC-007 |
| FR-002.02 | US1.3, US1.5 | SC-007 |
| FR-002.03 | US1.8 | SC-007 |
| FR-002.04 | US1.3, US1.5 | SC-007 |
| FR-002.05 | US1.5 | SC-001, SC-007 |
| FR-003 | US1.1, EC-002 | SC-001, SC-004 |
| FR-004 | US2.1, EC-003 | SC-002, SC-004 |
| FR-005 | US2.1, US4.5 | SC-003, SC-008 |
| FR-006 | US3.3, US3.5 | SC-004 |
| FR-007 | US3.1 | SC-004, SC-005 |
| FR-008 | US3.2, US3.4, US4.1, EC-005 | SC-004, SC-008 |
| FR-009 | US4.4, US5.3, EC-005 | SC-006 |
| FR-010 | US2.5, US3.1, US5.5 | SC-003, SC-007 |
| FR-011 | US4.1, US4.6 | SC-001, SC-008 |
| FR-012 | US4.2 | SC-003, SC-008 |
| FR-013 | US4.3, EC-002 | SC-008 |
| FR-014 | US2.1, US2.2, US2.3 | SC-001, SC-003 |
| FR-015 | US2.4, US2.5, US5.5 | SC-003 |
| FR-016 | US4.1, US4.5 | SC-008 |
| FR-017 | US1.1, US3.3, US6.3 | SC-001, SC-004 |
| FR-018 | US3.3, US3.4, EC-007 | SC-004, SC-010 |
| FR-019 | US2.3, US2.6, EC-006 | SC-003, SC-010 |
| FR-020 | US2.3, US2.4 | SC-003 |
| FR-021 | US1.1, US6.4 | SC-001, SC-012 |
| FR-022 | US3.5, US3.6 | SC-004, SC-009 |
| FR-023 | US3.5, EC-004 | SC-004, SC-009 |
| FR-024 | US5.1 | SC-007 |
| FR-025.01 | US5.3 | SC-006 |
| FR-025.02 | US5.3 | SC-006 |
| FR-025.03 | US5.4, US5.6 | SC-012 |
| FR-025.04 | US5.6 | SC-012 |
| FR-025.05 | US5.3, US5.4 | SC-006, SC-012 |
| FR-026 | EC-009 | SC-003, SC-007 |
| FR-027.01 | US6.2, US6.6 | SC-007, SC-012 |
| FR-027.02 | US6.1, US6.2 | SC-007, SC-009 |
| FR-027.03 | US1.11, US6.1 | SC-011 |
| FR-027.04 | US1.10, US6.1 | SC-012 |
| FR-027.05 | US3.7, US6.1 | SC-007, SC-012 |
| FR-028 | US1.4, US6.2, US6.3 | SC-007, SC-008 |
| FR-029 | US2.8–11, US3.7, US6.4, US6.7, EC-002, EC-010 | SC-007, SC-010, SC-012 |
| FR-030 | US3.2, US4.2, EC-004 | SC-004, SC-008 |
| FR-031 | US3.2, EC-004 | SC-004, SC-008 |
| FR-032 | US4.3, US6.3 | SC-008 |
| FR-033 | US4.3, US4.6 | SC-008 |
| FR-034.01 | US3.1, US3.2, US3.3, US3.4 | SC-004, SC-005 |
| FR-034.02 | US3.7 | SC-004, SC-012 |
| FR-034.03 | US3.7 | SC-004, SC-012 |
| FR-035 | US3.4, EC-005 | SC-003, SC-004 |
| FR-036 | US3.6, EC-001, EC-005 | SC-004, SC-011 |
| FR-037 | US5.2 | SC-007 |
| FR-038 | US5.2, US5.7 | SC-003, SC-007 |
| FR-039 | US5.7 | SC-007 |
| FR-040.01 | US1.6, US1.9 | SC-001, SC-012 |
| FR-040.02 | US1.9, US5.6 | SC-006, SC-012 |
| FR-040.03 | US1.9, US3.7, EC-010 | SC-004, SC-012 |
| FR-040.04 | US1.6, US1.9, US1.10, US3.7 | SC-006, SC-012 |
| FR-040.05 | US1.9, US3.7 | SC-012 |
| FR-040.06 | US1.9, EC-010 | SC-012 |
| FR-040.07 | US3.7 | SC-006, SC-012 |
| FR-040.08 | US3.7, US6.6 | SC-012 |
| FR-040.09 | US3.7 | SC-004, SC-012 |
| FR-040.10 | US1.6, EC-007 | SC-012 |
| FR-040.11 | US1.6, US1.10 | SC-012 |
| FR-040.12 | US1.6, EC-007 | SC-012 |
| FR-040.13 | US2.10, US3.7 | SC-010, SC-012 |
| FR-040.14 | US1.6, US5.6, US6.6 | SC-001, SC-012 |
| FR-040.15 | EC-008, US6.6 | SC-012 |
| FR-041.01 | US2.8, US2.9, US2.10, US2.11 | SC-010 |
| FR-041.02 | US2.7 | SC-010 |
| FR-041.03 | US2.7, EC-007 | SC-010 |
| FR-041.04 | US2.7 | SC-010 |
| FR-041.05 | US6.7 | SC-007, SC-012 |
| FR-041.06 | US2.7, US2.8 | SC-010 |
| FR-041.07 | US2.8 | SC-010 |
| FR-041.08 | US3.4, US2.11 | SC-010 |
| FR-042.01 | US2.6, EC-006 | SC-010 |
| FR-042.02 | US2.6, US2.7 | SC-010 |
| FR-042.03 | US2.6 | SC-010 |
| FR-042.04 | US2.6, US2.7 | SC-010 |
| FR-042.05 | US2.6, EC-006 | SC-010 |
| FR-042.06 | US2.6, EC-006 | SC-010 |
| FR-042.07 | EC-006 | SC-010 |
| FR-042.08 | US2.6, EC-006 | SC-003, SC-010 |
| FR-042.09 | US6.7 | SC-007, SC-010 |
| FR-043.01 | US2.9, US2.10 | SC-010 |
| FR-043.02 | US2.11, US3.4 | SC-010 |
| FR-043.03 | US2.9, US2.11 | SC-010, SC-011 |
| FR-043.04 | US2.11 | SC-010 |
| FR-043.05 | US2.11, US6.6 | SC-010, SC-012 |
| FR-043.06 | US2.11, US6.6 | SC-010, SC-012 |
| FR-043.07 | US5.6 | SC-012 |
| FR-043.08 | US2.9 | SC-010 |
| FR-043.09 | US1.11 | SC-011 |
| FR-043.10 | US1.11, US2.10, US3.7 | SC-011, SC-012 |
| FR-043.11 | US2.9, US2.10 | SC-010, SC-012 |
| FR-043.12 | US2.10, US6.1 | SC-007, SC-010 |
| FR-043.13 | US2.11, US3.7 | SC-010, SC-012 |
| FR-044.01 | US1.7, EC-001 | SC-011 |
| FR-044.02 | US1.7, US1.9, EC-010 | SC-011, SC-012 |
| FR-044.03 | US1.7 | SC-011 |
| FR-044.04 | US1.7, US1.11 | SC-011 |
| FR-044.05 | US1.7, EC-001 | SC-011 |
| FR-044.06 | EC-001, US3.6 | SC-004, SC-011 |
| FR-044.07 | US1.11, US6.1 | SC-011 |
| FR-045.01 | US6.5 | SC-012 |
| FR-045.02 | US6.5 | SC-012 |
| FR-046.01 | US6.3, US6.6 | SC-007, SC-012 |
| FR-046.02 | US1.8, US6.6 | SC-007 |
| FR-046.03 | US6.6 | SC-010, SC-012 |
| FR-046.04 | US6.6, US6.7 | SC-007, SC-012 |
| FR-046.05 | US6.6 | SC-010, SC-012 |
| FR-046.06 | US2.11, US6.6 | SC-010, SC-012 |
| FR-046.07 | US3.7, US6.6 | SC-012 |
| FR-046.08 | US6.6, EC-008 | SC-012 |
