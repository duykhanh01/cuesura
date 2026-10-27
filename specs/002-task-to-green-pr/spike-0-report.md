# Lát 0 — Báo cáo hiện trạng ngày 2026-10-28

**Kết quả tổng: BLOCKED, chưa cho mở `/speckit-tasks` hoặc A.** Đây là kết quả đã chạy thật của
phần chẩn đoán host và kiểm cú pháp, không phải báo cáo thành công của toàn spike.

| Kiểm tra thực tế | Kết quả | Phạm vi bằng chứng |
| --- | --- | --- |
| `sysctl kernel.apparmor_restrict_unprivileged_userns` | `1` | Restriction host đang bật |
| `bwrap --version` | `bubblewrap 0.9.0` | Version executable được probe |
| `bwrap --unshare-user --ro-bind / / /usr/bin/true` | Exit 1, `setting up uid map: Permission denied` | Host namespace không chạy được; phải provisioning, không chỉ lỗi phiên agent |
| `apparmor_parser --version` | `4.0.1` | Parser host |
| `apparmor_parser --skip-kernel-load --skip-cache deploy/apparmor/cusr-bwrap` | Exit 0 | Profile parse/compile được; không nạp kernel, không chứng minh userns đã hoạt động |
| `systemctl --user is-system-running` | `degraded` | Manager có phản hồi; chưa thử tạo/dừng unit hoặc chứng minh runner lifetime |

Chủ dự án đã kiểm tra không có AppArmor profile cho bwrap. Lượt này không nạp profile, đổi sysctl,
chạy sudo install, gọi model trả phí, tạo PR hoặc gửi merge request. File provisioning và lệnh
quản trị review được tại [deploy](../../deploy/README.md).

| Gate | Trạng thái / việc còn lại |
| --- | --- |
| S0.1 | Host fail; profile mới hai lớp chỉ compile; cần outer proof/lifetime, native result và permission evidence cho mode được chọn |
| S0.2 | Chưa chạy 6 role/vendor outputs, auth home riêng, quyền và registry/vendor network |
| S0.3 | Chưa có repo sandbox/fixture merge/squash/rebase + push/delete source; không dùng repo sản phẩm để thử |

Giới hạn kế hoạch của thử model là 6 invocation đầu, mỗi invocation tối đa 5 phút. Chưa dùng usage
hoặc xác nhận quyền chạy model/GitHub từ việc viết kế hoạch. Sau provisioning và được cấp đầu vào
spike, cập nhật từng dòng bằng command/exit code/fixture hash thật theo [spike guide](spike-0.md).
Không đổi BLOCKED thành pass chỉ vì typecheck/lint/test/build của lõi xanh.

Kiểm tra hồi quy sau khi sửa docs và thêm profile: `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm build` đều exit 0; default tests có 40 file/324 test đạt (33,12 giây). Kiểm tài liệu đủ
117 mục FR truy vết/12 SC, liên kết nội bộ và ADR một đoạn đạt. Các kết quả này không kiểm việc
nạp AppArmor, nested sandbox hoặc schema/auth/output model thật của S0.1–S0.3.

## Sửa profile sau review capability

Profile unconfined trong commit `113faef` đã bị thay bằng hướng (a), theo mẫu AppArmor v4.0.2 ABI
4.0 và [ADR-0003](../../docs/adr/0003-bwrap-child-capabilities.md). Không ghi nhận hướng (b) là
rủi ro đã chấp nhận. Parser 4.0.1 compile profile mới exit 0 và liệt kê hai profile `cusr-bwrap`,
`cusr-bwrap-child`; không nạp vào kernel. Fixture Python parse đạt và khi chạy ngoài child stack
enforce đã exit 1 trước probe, đúng yêu cầu guard. Chưa chạy fixture dưới policy đã nạp, chưa có
audit capability denial, re-exec/copy hoặc nested harness evidence; S0.1 vẫn **BLOCKED**.

Sau bản sửa capability, đã chạy lại typecheck/lint/test/build: tất cả exit 0, 40 file/324 test
đạt trong 33,55 giây. Đây là hồi quy của codebase, không thay bằng chứng S0.1 còn thiếu.

## Điều kiện pass được điều chỉnh sau review nesting

ADR-0003 cho phép external_verified có điều kiện sau khi outer boundary được chứng minh và tool
+permission/approval vẫn được kiểm độc lập; S0.1 vẫn phải thử native sandbox đang bật và giữ kết
+quả native riêng. Hiện **chưa có outer proof hoặc mode fallback proven**, nên ngoại lệ chưa được
+kích hoạt, native/fallback đều chưa được báo pass; trạng thái BLOCKED giữ nguyên.
