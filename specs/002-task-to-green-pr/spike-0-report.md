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
| S0.1 | Host fail; cần admin provisioning, rồi probe unprivileged + layout/nested sandbox hai harness và systemd lifetime |
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
