# Coverage 117 FR tại cổng lát A

Ngày đối chiếu: 2026-10-29, `002/phase6-gate` từ `c1a8b9e`.

Đủ **117/117 mã**, khớp [acceptance map](contracts/acceptance-map.md) và [bảng tasks](tasks.md).
Đây là kiểm tra truy vết và phần còn mở, **không phải 117/117 yêu cầu đã nghiệm thu**.
Checkbox task chỉ là đầu mối; bằng chứng và giới hạn của A nằm ở [acceptance report](acceptance-report.md#nghiệm-thu-phase-6--cổng-lát-a).
`A có evidence` nghĩa là xem matrix US1/US2/US4 cùng M/H của report; chưa thay coverage B/C.
`A còn mở` nêu task nền/story A chưa hoàn tất. M01–M08 có [matrix T139](acceptance-report.md#t139--kiểm-tổng-hợp-m01m08-và-h01h06) local đã đạt; giới hạn B/C áp dụng cho
mọi dòng liên quan, kể cả khi cột task gốc không liệt kê T139. H05 crash I/O rộng, ≥200 daemon kills,
CLI đầy đủ và paid smoke thuộc B/C; các mục này được giữ nguyên.

| FR | Lát | Task triển khai | Task kiểm chứng | Task còn mở | Trạng thái đối chiếu |
| --- | --- | --- | --- | --- | --- |
| FR-001.01 | A/B | T021, T023, T030, T031 | T028, T106, T107 | T106, T107 | A có evidence; B/C còn mở |
| FR-001.02 | A/B | T034, T119 | T027, T028, T084, T106 | T084, T106, T119 | A có evidence; B/C còn mở |
| FR-001.03 | A/B | T034, T046, T119 | T027, T028, T084, T094 | T084, T094, T119 | A có evidence; B/C còn mở |
| FR-002.01 | A/B | T030, T032 | T028, T016 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-002.02 | A/B | T030, T031 | T028, T106 | T106 | A có evidence; B/C còn mở |
| FR-002.03 | A/B | T031, T062, T110 | T028, T106 | T106, T110 | A có evidence; B/C còn mở |
| FR-002.04 | A/B | T030, T070 | T028, T066 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-002.05 | A/B | T030, T070, T071 | T028, T066, T077 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-003 | A/B | T035, T036, T090 | T029, T082 | T082, T090 | A có evidence; B/C còn mở |
| FR-004 | A/B | T038, T055, T090 | T029, T053, T082, T124, T129 | T082, T090, T124, T129 | A có evidence; B/C còn mở |
| FR-005 | A | T037, T055, T076 | T029, T066, T067 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-006 | A/B | T023, T025, T026, T047, T092 | T016, T084, T094 | T084, T092, T094 | A có evidence; B/C còn mở |
| FR-007 | 0/A/B | T004, T018, T073, T086, T118 | T006, T067, T081, T123, T128 | T081, T086, T118, T123, T128 | A có evidence; B/C còn mở |
| FR-008 | A/B/C | T019, T074, T075, T087, T088 | T067, T083, T094 | T083, T087, T088, T094 | A có evidence; B/C còn mở |
| FR-009 | A/B | T073, T101 | T067, T081, T096 | T081, T096, T101 | A có evidence; B/C còn mở |
| FR-010 | A/B | T025, T056, T071, T099, T103 | T016, T053, T095, T096 | T095, T096, T099, T103 | A có evidence; B/C còn mở |
| FR-011 | 0/A/C | T003, T013, T068, T069, T070 | T007, T066, T077, T122, T126, T127 | T122, T126, T127 | A có evidence; B/C còn mở |
| FR-012 | 0/A/C | T003, T013, T068, T069, T075 | T007, T066, T077, T122, T126 | T122, T126 | A có evidence; B/C còn mở |
| FR-013 | 0/A/C | T004, T020, T072 | T006, T065, T077, T126 | T072, T126 | A còn mở: T072 |
| FR-014 | A/C | T054, T055, T043, T076 | T050, T053, T077, T127 | T127 | A có evidence; B/C còn mở |
| FR-015 | A/B | T056, T057, T104 | T053, T066, T096, T105 | T096, T104, T105 | A có evidence; B/C còn mở |
| FR-016 | A/B/C | T019, T071, T074 | T066, T067, T077, T126 | T126 | A có evidence; B/C còn mở |
| FR-017 | A/B/C | T005, T039, T040, T041, T089 | T029, T082, T094, T127 | T082, T089, T094, T127 | A có evidence; B/C còn mở |
| FR-018 | A/B | T041, T057, T089 | T029, T051, T082, T094 | T082, T089, T094 | A có evidence; B/C còn mở |
| FR-019 | A/C | T042, T043, T058, T060 | T050, T051, T052, T127 | T127 | A có evidence; B/C còn mở |
| FR-020 | A/B | T054, T055, T057, T060 | T053, T064, T082 | T082 | A có evidence; B/C còn mở |
| FR-021 | A/B/C | T026, T040, T045, T115 | T028, T106, T127, T130 | T106, T115, T127, T130 | A có evidence; B/C còn mở |
| FR-022 | B | T024, T085, T092 | T016, T084, T094 | T084, T085, T092, T094 | Chờ B/C |
| FR-023 | B | T088, T092 | T083, T084, T094 | T083, T084, T088, T092, T094 | Chờ B/C |
| FR-024 | B | T097 | T095, T105, T106 | T095, T097, T105, T106 | Chờ B/C |
| FR-025.01 | B | T101 | T096, T105 | T096, T101, T105 | Chờ B/C |
| FR-025.02 | B | T073, T101 | T067, T096, T105 | T096, T101, T105 | Chờ B/C |
| FR-025.03 | B | T102 | T096, T105 | T096, T102, T105 | Chờ B/C |
| FR-025.04 | B | T045, T046, T102 | T096, T105 | T096, T102, T105 | Chờ B/C |
| FR-025.05 | B | T036, T101 | T082, T096, T105 | T082, T096, T101, T105 | Chờ B/C |
| FR-026 | A/B | T047, T063 | T027, T053, T084 | T084 | A có evidence; B/C còn mở |
| FR-027.01 | B | T048, T108, T109, T062, T110, T114 | T106, T107, T120 | T106, T107, T108, T109, T110, T114, T120 | Chờ B/C |
| FR-027.02 | B | T108, T112, T118 | T106, T120 | T106, T108, T112, T118, T120 | Chờ B/C |
| FR-027.03 | B | T033, T034, T111, T119 | T028, T084, T106 | T084, T106, T111, T119 | Chờ B/C |
| FR-027.04 | B | T034, T111, T119 | T028, T106 | T106, T111, T119 | Chờ B/C |
| FR-027.05 | B | T046, T111 | T084, T106 | T084, T106, T111 | Chờ B/C |
| FR-028 | B | T021, T023, T103, T109, T113, T116, T117 | T028, T106, T107, T120 | T103, T106, T107, T109, T113, T116, T117, T120 | Chờ B/C |
| FR-029 | B | T058, T100, T111 | T106, T120 | T100, T106, T111, T120 | Chờ B/C |
| FR-030 | A/B | T018, T019, T075, T088 | T067, T081, T083, T094 | T081, T083, T088, T094 | A có evidence; B/C còn mở |
| FR-031 | B | T087, T088, T114 | T083, T094, T106 | T083, T087, T088, T094, T106, T114 | Chờ B/C |
| FR-032 | 0/A/B | T004, T020, T021, T072, T112, T116, T117 | T006, T065, T107, T120 | T072, T107, T112, T116, T117, T120 | A còn mở: T072 |
| FR-033 | 0/A/C | T004, T020, T022, T070, T072, T112 | T006, T007, T065, T077, T126 | T072, T112, T126 | A còn mở: T072 |
| FR-034.01 | B | T085, T086, T089, T090 | T081, T082, T094, T123, T128 | T081, T082, T085, T086, T089, T090, T094, T123, T128 | Chờ B/C |
| FR-034.02 | B | T091 | T084, T094 | T084, T091, T094 | Chờ B/C |
| FR-034.03 | B | T060, T091 | T084, T094 | T084, T091, T094 | Chờ B/C |
| FR-035 | B | T086, T099 | T081, T084, T095 | T081, T084, T086, T095, T099 | Chờ B/C |
| FR-036 | B | T024, T085, T093 | T084, T094 | T084, T085, T093, T094 | Chờ B/C |
| FR-037 | B | T098 | T095, T105, T106 | T095, T098, T105, T106 | Chờ B/C |
| FR-038 | 0/B/C | T068, T069, T099 | T007, T066, T095, T126 | T095, T099, T126 | Chờ B/C |
| FR-039 | B | T100 | T095, T105, T106 | T095, T100, T105, T106 | Chờ B/C |
| FR-040.01 | A/B/C | T044, T045 | T027, T028, T125, T130 | T125, T130 | A có evidence; B/C còn mở |
| FR-040.02 | A/B/C | T045, T046, T073 | T027, T028, T084, T094 | T084, T094 | A có evidence; B/C còn mở |
| FR-040.03 | A/B/C | T046, T089, T091 | T027, T028, T084, T094 | T084, T089, T091, T094 | A có evidence; B/C còn mở |
| FR-040.04 | A/B/C | T046 | T027, T028, T084, T094, T125, T130 | T084, T094, T125, T130 | A có evidence; B/C còn mở |
| FR-040.05 | A/B/C | T046, T091 | T028, T082, T084 | T082, T084, T091 | A có evidence; B/C còn mở |
| FR-040.06 | A/B/C | T046, T091 | T028, T082, T084, T094 | T082, T084, T091, T094 | A có evidence; B/C còn mở |
| FR-040.07 | A/B/C | T046, T073 | T027, T067, T084 | T084 | A có evidence; B/C còn mở |
| FR-040.08 | A/B/C | T046, T062, T110 | T027, T084, T106 | T084, T106, T110 | A có evidence; B/C còn mở |
| FR-040.09 | A/B/C | T091 | T084, T094 | T084, T091, T094 | A có evidence; B/C còn mở |
| FR-040.10 | 0/A/B/C | T044, T045 | T008, T027, T028, T125, T130 | T125, T130 | A có evidence; B/C còn mở |
| FR-040.11 | A/B/C | T045, T111 | T027, T028, T106, T125, T130 | T106, T111, T125, T130 | A có evidence; B/C còn mở |
| FR-040.12 | 0/A/B/C | T005, T044 | T008, T029, T051, T125, T130 | T125, T130 | A có evidence; B/C còn mở |
| FR-040.13 | A/B/C | T045, T046, T060, T091 | T027, T052, T084, T094 | T084, T091, T094 | A có evidence; B/C còn mở |
| FR-040.14 | 0/A/B/C | T044, T045 | T008, T027, T028, T096, T125, T130 | T096, T125, T130 | A có evidence; B/C còn mở |
| FR-040.15 | A/B/C | T045, T102, T062, T110 | T027, T096, T106 | T096, T102, T106, T110 | A có evidence; B/C còn mở |
| FR-041.01 | 0/A/B/C | T044, T058, T059 | T051, T052, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-041.02 | 0/A/B/C | T043, T058 | T027, T051, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-041.03 | 0/A/B/C | T058 | T008, T029, T051 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-041.04 | 0/A/B/C | T058 | T051, T052, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-041.05 | 0/A/B/C | T044, T058, T111 | T051, T106 | T106, T111 | A có evidence; B/C còn mở |
| FR-041.06 | 0/A/B/C | T043, T058 | T050, T051, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-041.07 | 0/A/B/C | T058, T059 | T051, T052, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-041.08 | 0/A/B/C | T044, T058, T111 | T051, T082, T106 | T082, T106, T111 | A có evidence; B/C còn mở |
| FR-042.01 | 0/A/C | T022, T030, T032, T042 | T008, T050, T051 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-042.02 | 0/A/C | T042 | T050, T051, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-042.03 | 0/A/C | T042 | T008, T051, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-042.04 | 0/A/C | T042, T058 | T050, T051 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-042.05 | 0/A/C | T042 | T008, T050, T051 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-042.06 | 0/A/C | T042, T058 | T050, T051 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-042.07 | 0/A/C | T042, T043 | T050, T051 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-042.08 | 0/A/C | T043 | T050, T051, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-042.09 | 0/A/C | T022, T042, T111 | T051, T106 | T106, T111 | A có evidence; B/C còn mở |
| FR-043.01 | A/B | T059, T061 | T052, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-043.02 | A/B | T040, T061 | T051, T052 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-043.03 | A/B | T059, T061 | T027, T052, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-043.04 | A/B | T059 | T052, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-043.05 | A/B | T059, T085, T062, T110 | T052, T084, T106 | T084, T085, T106, T110 | A có evidence; B/C còn mở |
| FR-043.06 | A/B | T059, T062, T110 | T052, T106 | T106, T110 | A có evidence; B/C còn mở |
| FR-043.07 | A/B | T102 | T096, T105 | T096, T102, T105 | A có evidence; B/C còn mở |
| FR-043.08 | A/B | T057, T060 | T052, T053, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-043.09 | A/B | T032, T033, T034, T060 | T027, T028, T052, T084 | T084 | A có evidence; B/C còn mở |
| FR-043.10 | A/B | T060 | T027, T052, T084 | T084 | A có evidence; B/C còn mở |
| FR-043.11 | A/B | T045, T058, T060 | T052, T064 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-043.12 | A/B | T059, T111 | T052, T106 | T106, T111 | A có evidence; B/C còn mở |
| FR-043.13 | A/B | T045, T046, T059, T091 | T027, T052, T084 | T084, T091 | A có evidence; B/C còn mở |
| FR-044.01 | A/B | T025, T033 | T016, T027, T028, T094 | T094 | A có evidence; B/C còn mở |
| FR-044.02 | A/B | T034, T046 | T027, T028, T084, T094 | T084, T094 | A có evidence; B/C còn mở |
| FR-044.03 | A/B | T033 | T027, T028, T084 | T084 | A có evidence; B/C còn mở |
| FR-044.04 | A/B | T033, T034 | T027, T028 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-044.05 | A/B | T033, T034 | T027, T028 | — | Task gốc đã tick; xem giới hạn A/M/H |
| FR-044.06 | A/B | T024, T085, T119 | T084, T094, T106 | T084, T085, T094, T106, T119 | A có evidence; B/C còn mở |
| FR-044.07 | A/B | T033, T034, T111, T119 | T028, T084, T106 | T084, T106, T111, T119 | A có evidence; B/C còn mở |
| FR-045.01 | B | T115 | T106, T120 | T106, T115, T120 | Chờ B/C |
| FR-045.02 | B | T031, T115 | T028, T106, T120 | T106, T115, T120 | Chờ B/C |
| FR-046.01 | B | T021, T023, T062, T110 | T052, T106, T107 | T106, T107, T110 | Chờ B/C |
| FR-046.02 | B | T030, T031, T032, T062, T110 | T052, T028, T106 | T106, T110 | Chờ B/C |
| FR-046.03 | B | T061, T062, T110 | T052, T051, T106 | T106, T110 | Chờ B/C |
| FR-046.04 | B | T062, T110 | T052, T106, T120 | T106, T110, T120 | Chờ B/C |
| FR-046.05 | B | T059, T061, T062, T110 | T052, T106 | T106, T110 | Chờ B/C |
| FR-046.06 | B | T059, T062, T110 | T052, T106 | T106, T110 | Chờ B/C |
| FR-046.07 | B | T046, T091, T062, T110 | T052, T084, T106 | T084, T091, T106, T110 | Chờ B/C |
| FR-046.08 | B | T045, T062, T110 | T052, T027, T106 | T106, T110 | Chờ B/C |
