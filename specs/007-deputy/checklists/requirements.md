# Specification Quality Checklist: Deputy và goal

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-08 | **Viết lại**: 2026-11-09
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Spec dùng tên lệnh `cusr`, mã wait, tên role và tên nhánh như các spec 003, 006: đó là giao diện sản phẩm chủ dự án
  dùng. Một số FR nêu cơ chế (`git merge-tree`, đường yolo) vì chủ dự án yêu cầu dùng lại cơ chế có sẵn; chi tiết hiện
  thực nằm ở research.
- Bản viết lại thay mô hình một phiên deputy sống lâu mỗi task bằng lượt ngắn cộng sổ goal, và đưa goal nhiều đơn vị vào
  feature theo yêu cầu của chủ dự án ngày 2026-11-09. Ba quyết định của chủ dự án trong phiên đó: bản miễn gồm cả gate
  và check; một PR cho goal với merge commit từng đơn vị; lệnh ghi goal của trợ lý cần lease.
- Feature cần amendment 11.0.0 (nguyên tắc III, IV, V, VII), sửa cùng PR; chỉ chủ dự án duyệt.
