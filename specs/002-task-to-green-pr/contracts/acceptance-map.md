# Ánh xạ triển khai và kiểm chứng từng FR

Đây là 117 mục nghiệm thu dự kiến, gồm 83 mã con và 34 FR chưa tách. Nguồn scenario/SC là
[checklist](../checklists/requirements.md); nội dung yêu cầu là [spec](../spec.md).
0/A/B/C là các lát trong [plan](../plan.md), không phải nhiệm vụ đã hoàn thành.
[Lát 0](../spike-0.md) là gate trước runtime A; các dòng có 0 cần prototype/fixture thật trước runtime. Mỗi dòng cần task và
bằng chứng riêng; cùng suite được dùng chung khi có assertion phân biệt từng nghĩa vụ.

Bổ sung [M01–M08](../task-execution-modes.md) được truy vết qua T135–T139; 117 dòng FR dưới đây
giữ ID để bảo toàn coverage. FR-014/017/019 được hiểu theo hai mode đã xác nhận; smoke hai
vendor kiểm adapter, không bắt mọi task dùng hai vendor. Các M chưa được nghiệm thu toàn bộ; [matrix Phase 6](../acceptance-report.md#nghiệm-thu-phase-6--cổng-lát-a) nêu assertion đã chạy và phần còn thiếu, T139 được khép trong [matrix kiểm tổng hợp](../acceptance-report.md#t139--kiểm-tổng-hợp-m01m08-và-h01h06); paid smoke/recovery B vẫn tách riêng.

`merge.method` bổ sung M02/M05/M08 qua T030/T032/T045/T111/T135/T136/T139: default squash,
override merge/rebase, config sai, freeze/replay cũ, message đề xuất và manual merge khác/unknown
method không chặn proof/drain/DONE. Không có endpoint merge trong 002; method mismatch không tự
làm head unverified. Đã triển khai ở T030/T032/T045/T135/T136 (loader, freeze, `cusr show`); T111 còn mở; T139 đã kiểm fixture/property/SQLite/OS; paid smoke C chưa nghiệm thu, không thêm mã FR mới.

Bổ sung [H01–H06](../task-execution-modes.md#remote-đổi-head-khi-review-còn-chạy) làm rõ
FR-041.03/M06/M07: H01–H03/H06 tại T050/T051/T053/T058/T139, H04 tại T029/T041/T139,
H05 replay/SQLite tại T139 và crash I/O tại T082/T093. Bằng chứng H01–H06 và giới hạn SQLite/file/crash ở [report Phase 6](../acceptance-report.md#h01h06);
không dùng test drift của PR đã xanh thay race reviewer còn chạy.

Các module trong bảng là vị trí dự kiến, chưa phải file đã được tạo. Property/unit chạy trong
`test/property`/`test/unit`; contract trong `test/contract`; integration trong `test/integration/runtime`;
crash trong `test/reliability`; thực nghiệm trả phí trong `test/smoke`. `quickstart.md` nêu các suite
và cổng trước smoke. Report implementation phải bổ sung test ID/fixture/PR/receipt thật cho từng dòng,
không lấy nội dung bảng này làm bằng chứng đã đạt.

**Kết quả nghiệm thu từng dòng:** [T131 trong acceptance report](../acceptance-report.md#t131--117-nghĩa-vụ). Bảng dưới là kế hoạch, không phải bằng chứng.

| FR | Lát | Module/điểm nối | Tầng bằng chứng | Scenario | SC |
| --- | --- | --- | --- | --- | --- |
| FR-001.01 | A/B | application/triage, dependency | property + SQLite/CLI integration | US1.2, US1.4, US6.3 | SC-001, SC-007 |
| FR-001.02 | A/B | application/triage, dependency | property + SQLite/CLI integration | US1.10 | SC-012 |
| FR-001.03 | A/B | application/triage, dependency | property + SQLite/CLI integration | US1.10 | SC-012 |
| FR-002.01 | A/B | application/preflight, config/freeze | config unit + Git/SQLite/CLI integration | US1.3, US1.5 | SC-001, SC-007 |
| FR-002.02 | A/B | application/preflight, config/freeze | config unit + Git/SQLite/CLI integration | US1.3, US1.5 | SC-007 |
| FR-002.03 | A/B | application/preflight, config/freeze | config unit + Git/SQLite/CLI integration | US1.8 | SC-007 |
| FR-002.04 | A/B | application/preflight, config/freeze | config unit + Git/SQLite/CLI integration | US1.3, US1.5 | SC-007 |
| FR-002.05 | A/B | application/preflight, config/freeze | config unit + Git/SQLite/CLI integration | US1.5 | SC-001, SC-007 |
| FR-003 | A/B | adapters/git, checkpoints | local Git/filesystem contract + crash | US1.1, EC-002 | SC-001, SC-004 |
| FR-004 | A/B | runner command/gates | process/Git contract + crash | US2.1, EC-003 | SC-002, SC-004 |
| FR-005 | A | adapters/context | schema/context contract + secret/size fixtures | US2.1, US4.5 | SC-003, SC-008 |
| FR-006 | A/B | daemon/store | SQLite transaction + process integration | US3.3, US3.5 | SC-004 |
| FR-007 | 0/A/B | runner/supervisor | real process contract + systemd/recovery | US3.1 | SC-004, SC-005 |
| FR-008 | A/B/C | runner/ingestion | file/process contract + harness smoke | US3.2, US3.4, US4.1, EC-005 | SC-004, SC-008 |
| FR-009 | A/B | runner/process lifecycle | silent progress/kill contract + crash | US4.4, US5.3, EC-005 | SC-006 |
| FR-010 | A/B | engine/budget, claim | property + SQLite claim/runner integration | US2.5, US3.1, US5.5 | SC-003, SC-007 |
| FR-011 | 0/A/C | adapters/harness | common fake contract + 3 roles × 2 vendor smoke | US4.1, US4.6 | SC-001, SC-008 |
| FR-012 | 0/A/C | harness result validation | schema/semantic contract + real-output fixtures | US4.2 | SC-003, SC-008 |
| FR-013 | 0/A/C | runner/sandbox | OS write-boundary/secret contract + real vendor smoke | US4.3, EC-002 | SC-008 |
| FR-014 | A/C | engine evidence, gate/review | property + fake flow + real two-vendor smoke | US2.1, US2.2, US2.3 | SC-001, SC-003 |
| FR-015 | A/B | engine/failure, adapter facts | property + transport/process failure fixtures | US2.4, US2.5, US5.5 | SC-003 |
| FR-016 | A/B/C | runner/artifacts, usage | redaction/usage/retention contract + smoke | US4.1, US4.5 | SC-008 |
| FR-017 | A/B/C | adapters/git/github publish | Git/fake HTTP contract + crash + real PR smoke | US1.1, US3.3, US6.3 | SC-001, SC-004 |
| FR-018 | A/B | adapters/reconcile | Git/fake HTTP unknown/probe + crash | US3.3, US3.4, EC-007 | SC-004, SC-010 |
| FR-019 | A/C | engine/check evaluator | property + GitHub contract + smoke | US2.3, US2.6, EC-006 | SC-003, SC-010 |
| FR-020 | A/B | engine CI loops, adapters | property + HTTP/Git rerun/fix contract | US2.3, US2.4 | SC-003 |
| FR-021 | A/B/C | manual completion mode | fake flow + executor zero-merge assertion + smoke | US1.1, US6.4 | SC-001, SC-012 |
| FR-022 | B | daemon/startup, store | real DB lock/integrity/replay integration | US3.5, US3.6 | SC-004, SC-009 |
| FR-023 | B | daemon/store/spool health | ENOSPC/BUSY/crash integration | US3.5, EC-004 | SC-004, SC-009 |
| FR-024 | B | application/inbox | SQLite/CLI/restart integration | US5.1 | SC-007 |
| FR-025.01 | B | engine/drain, operation supervisor | property + real process/Git cancellation + crash | US5.3 | SC-006 |
| FR-025.02 | B | engine/drain, operation supervisor | property + real process/Git cancellation + crash | US5.3 | SC-006 |
| FR-025.03 | B | engine/drain, operation supervisor | property + real process/Git cancellation + crash | US5.4, US5.6 | SC-012 |
| FR-025.04 | B | engine/drain, operation supervisor | property + real process/Git cancellation + crash | US5.6 | SC-012 |
| FR-025.05 | B | engine/drain, operation supervisor | property + real process/Git cancellation + crash | US5.3, US5.4 | SC-006, SC-012 |
| FR-026 | A/B | engine/revision | property regression + safe-boundary integration | EC-009 | SC-003, SC-007 |
| FR-027.01 | B | cli/application/explain | CLI JSON/health/read-only integration + assistant operate/admin-denial + revoke tests | US6.2, US6.6 | SC-007, SC-012 |
| FR-027.02 | B | cli/application/explain | CLI JSON/health/read-only integration | US6.1, US6.2 | SC-007, SC-009 |
| FR-027.03 | B | cli/application/explain | CLI JSON/health/read-only integration | US1.11, US6.1 | SC-011 |
| FR-027.04 | B | cli/application/explain | CLI JSON/health/read-only integration | US1.10, US6.1 | SC-012 |
| FR-027.05 | B | cli/application/explain | CLI JSON/health/read-only integration | US3.7, US6.1 | SC-007, SC-012 |
| FR-028 | B | application/authz/dedup | permission/version/request replay integration + assistant operate/admin-denial + revoke tests | US1.4, US6.2, US6.3 | SC-007, SC-008 |
| FR-029 | B | explain/allowed-actions | scenario matrix per wait detail + CLI integration | US2.8–11, US3.7, US6.4, US6.7, EC-002, EC-010 | SC-007, SC-010, SC-012 |
| FR-030 | A/B | runner/atomic receipt | filesystem/process crash contract | US3.2, US4.2, EC-004 | SC-004, SC-008 |
| FR-031 | B | daemon/ingest cursors | SQLite/spool atomic ACK/rotation/crash integration | US3.2, EC-004 | SC-004, SC-008 |
| FR-032 | 0/A/B | runner/sandbox + application/authz | OS secret/control denial + CLI privilege tests | US4.3, US6.3 | SC-008 |
| FR-033 | 0/A/C | application/capability admission | negative OS capability fixtures + vendor smoke | US4.3, US4.6 | SC-008 |
| FR-034.01 | B | daemon/reconcile, engine/drain | real process/Git recovery + crash | US3.1, US3.2, US3.3, US3.4 | SC-004, SC-005 |
| FR-034.02 | B | daemon/reconcile, engine/drain | real process/Git recovery + crash | US3.7 | SC-004, SC-012 |
| FR-034.03 | B | daemon/reconcile, engine/drain | real process/Git recovery + crash | US3.7 | SC-004, SC-012 |
| FR-035 | B | engine/lost/resume | property + receipt/session-loss integration | US3.4, EC-005 | SC-003, SC-004 |
| FR-036 | B | store/verify, daemon/startup | global-seq replay + 200 runtime crash ledger | US3.6, EC-001, EC-005 | SC-004, SC-011 |
| FR-037 | B | application/answer | SQLite revision/dedup/racing-answer integration | US5.2 | SC-007 |
| FR-038 | 0/B/C | engine/answer + harness session | property/session contract + resume smoke | US5.2, US5.7 | SC-003, SC-007 |
| FR-039 | B | engine/question, explain | needs_context/blocked scenario + CLI integration | US5.7 | SC-007 |
| FR-040.01 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US1.6, US1.9 | SC-001, SC-012 |
| FR-040.02 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US1.9, US5.6 | SC-006, SC-012 |
| FR-040.03 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US1.9, US3.7, EC-010 | SC-004, SC-012 |
| FR-040.04 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US1.6, US1.9, US1.10, US3.7 | SC-006, SC-012 |
| FR-040.05 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US1.9, US3.7 | SC-012 |
| FR-040.06 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US1.9, EC-010 | SC-012 |
| FR-040.07 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US3.7 | SC-006, SC-012 |
| FR-040.08 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US3.7, US6.6 | SC-012 |
| FR-040.09 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US3.7 | SC-004, SC-012 |
| FR-040.10 | 0/A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US1.6, EC-007 | SC-012 |
| FR-040.11 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US1.6, US1.10 | SC-012 |
| FR-040.12 | 0/A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US1.6, EC-007 | SC-012 |
| FR-040.13 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US2.10, US3.7 | SC-010, SC-012 |
| FR-040.14 | 0/A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | US1.6, US5.6, US6.6 | SC-001, SC-012 |
| FR-040.15 | A/B/C | engine/external completion + drain | property + late process/push/crash contract + manual merge smoke | EC-008, US6.6 | SC-012 |
| FR-041.01 | 0/A/B/C | engine/observation evidence | fake HTTP/Clock contract + real PR behavior fixture | US2.8, US2.9, US2.10, US2.11 | SC-010 |
| FR-041.02 | 0/A/B/C | engine/observation evidence | fake HTTP/Clock contract + real PR behavior fixture | US2.7 | SC-010 |
| FR-041.03 | 0/A/B/C | engine/observation evidence | fake HTTP/Clock contract + real PR behavior fixture | US2.7, EC-007 | SC-010 |
| FR-041.04 | 0/A/B/C | engine/observation evidence | fake HTTP/Clock contract + real PR behavior fixture | US2.7 | SC-010 |
| FR-041.05 | 0/A/B/C | engine/observation evidence | fake HTTP/Clock contract + real PR behavior fixture | US6.7 | SC-007, SC-012 |
| FR-041.06 | 0/A/B/C | engine/observation evidence | fake HTTP/Clock contract + real PR behavior fixture | US2.7, US2.8 | SC-010 |
| FR-041.07 | 0/A/B/C | engine/observation evidence | fake HTTP/Clock contract + real PR behavior fixture | US2.8 | SC-010 |
| FR-041.08 | 0/A/B/C | engine/observation evidence | fake HTTP/Clock contract + real PR behavior fixture | US3.4, US2.11 | SC-010 |
| FR-042.01 | 0/A/C | engine/required-checks + github normalization | union-name property + gh-port fixtures; app evidence/merge identity; legacy mismatch replay | US2.6, EC-006 | SC-010 |
| FR-042.02 | 0/A/C | engine/required-checks + github normalization | union-name property + gh-port fixtures; app evidence/merge identity; legacy mismatch replay | US2.6, US2.7 | SC-010 |
| FR-042.03 | 0/A/C | engine/required-checks + github normalization | union-name property + gh-port fixtures; app evidence/merge identity; legacy mismatch replay | US2.6 | SC-010 |
| FR-042.04 | 0/A/C | engine/required-checks + github normalization | union-name property + gh-port fixtures; app evidence/merge identity; legacy mismatch replay | US2.6, US2.7 | SC-010 |
| FR-042.05 | 0/A/C | engine/required-checks + github normalization | union-name property + gh-port fixtures; app evidence/merge identity; legacy mismatch replay | US2.6, EC-006 | SC-010 |
| FR-042.06 | 0/A/C | engine/required-checks + github normalization | union-name property + gh-port fixtures; app evidence/merge identity; legacy mismatch replay | US2.6, EC-006 | SC-010 |
| FR-042.07 | 0/A/C | engine/required-checks + github normalization | union-name property + gh-port fixtures; app evidence/merge identity; legacy mismatch replay | EC-006 | SC-010 |
| FR-042.08 | 0/A/C | engine/required-checks + github normalization | union-name property + gh-port fixtures; app evidence/merge identity; legacy mismatch replay | US2.6, EC-006 | SC-003, SC-010 |
| FR-042.09 | 0/A/C | engine/required-checks + github normalization | union-name property + gh-port fixtures; app evidence/merge identity; legacy mismatch replay | US6.7 | SC-007, SC-010 |
| FR-043.01 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US2.9, US2.10 | SC-010 |
| FR-043.02 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US2.11, US3.4 | SC-010 |
| FR-043.03 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US2.9, US2.11 | SC-010, SC-011 |
| FR-043.04 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US2.11 | SC-010 |
| FR-043.05 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US2.11, US6.6 | SC-010, SC-012 |
| FR-043.06 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US2.11, US6.6 | SC-010, SC-012 |
| FR-043.07 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US5.6 | SC-012 |
| FR-043.08 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US2.9 | SC-010 |
| FR-043.09 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US1.11 | SC-011 |
| FR-043.10 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US1.11, US2.10, US3.7 | SC-011, SC-012 |
| FR-043.11 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US2.9, US2.10 | SC-010, SC-012 |
| FR-043.12 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US2.10, US6.1 | SC-007, SC-010 |
| FR-043.13 | A/B | engine timers, observation limits | Clock property + restart/SQLite integration | US2.11, US3.7 | SC-010, SC-012 |
| FR-044.01 | A/B | engine selector + store slot | queue property + two-task/process/replay integration | US1.7, EC-001 | SC-011 |
| FR-044.02 | A/B | engine selector + store slot | queue property + two-task/process/replay integration | US1.7, US1.9, EC-010 | SC-011, SC-012 |
| FR-044.03 | A/B | engine selector + store slot | queue property + two-task/process/replay integration | US1.7 | SC-011 |
| FR-044.04 | A/B | engine selector + store slot | queue property + two-task/process/replay integration | US1.7, US1.11 | SC-011 |
| FR-044.05 | A/B | engine selector + store slot | queue property + two-task/process/replay integration | US1.7, EC-001 | SC-011 |
| FR-044.06 | A/B | engine selector + store slot | queue property + two-task/process/replay integration | EC-001, US3.6 | SC-004, SC-011 |
| FR-044.07 | A/B | engine selector + store slot | queue property + two-task/process/replay integration | US1.11, US6.1 | SC-011 |
| FR-045.01 | B | cli/application unsupported commands | CLI no-mutation contract | US6.5 | SC-012 |
| FR-045.02 | B | cli/application unsupported commands | CLI no-mutation contract | US6.5 | SC-012 |
| FR-046.01 | B | application/recheck, service effects | CLI/SQLite dedup + finite HTTP/drain integration + assistant operate/admin-denial + revoke tests | US6.3, US6.6 | SC-007, SC-012 |
| FR-046.02 | B | application/recheck, service effects | CLI/SQLite dedup + finite HTTP/drain integration | US1.8, US6.6 | SC-007 |
| FR-046.03 | B | application/recheck, service effects | CLI/SQLite dedup + finite HTTP/drain integration | US6.6 | SC-010, SC-012 |
| FR-046.04 | B | application/recheck, service effects | CLI/SQLite dedup + finite HTTP/drain integration | US6.6, US6.7 | SC-007, SC-012 |
| FR-046.05 | B | application/recheck, service effects | CLI/SQLite dedup + finite HTTP/drain integration | US6.6 | SC-010, SC-012 |
| FR-046.06 | B | application/recheck, service effects | CLI/SQLite dedup + finite HTTP/drain integration | US2.11, US6.6 | SC-010, SC-012 |
| FR-046.07 | B | application/recheck, service effects | CLI/SQLite dedup + finite HTTP/drain integration | US3.7, US6.6 | SC-012 |
| FR-046.08 | B | application/recheck, service effects | CLI/SQLite dedup + finite HTTP/drain integration | US6.6, EC-008 | SC-012 |

## Đối chiếu tại cổng Phase 6

[Coverage 117 FR](../phase6-coverage.md) ghi đúng 117 mã cùng task triển khai/kiểm chứng và task còn mở;
không đổi ID hoặc đánh dấu cả nhóm từ một test. [Go/no-go](../go-no-go.md) ghi **owner chốt NO-GO tại T080**
ngày 2026-10-30, giữ B/C đóng. T077 được kiểm độc lập trên Ubuntu; T072/T139 đã merge, T078 đạt 20 seeds mới trên base `bc9d84a` + fixture fix của PR #19.
[Ledger T078](../evidence/t078-validation.json) kiểm lại core A; không thay proof spike còn thiếu hoặc smoke C.
