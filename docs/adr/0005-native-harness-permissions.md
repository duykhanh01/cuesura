# Chạy trực tiếp trên host, giao quyền thực thi cho harness

Được chủ dự án quyết định ngày 2026-11-01, thay baseline của [ADR-0004](0004-isolated-bwrap-baseline.md):
Cuesura bỏ outer bwrap, chạy Claude/Codex trực tiếp trong worktree riêng và giữ systemd để giám sát,
hủy và khôi phục process. Mặc định harness dùng quyền `auto`: Claude `permissions.defaultMode=auto`
với sandbox worker mặc định tắt như [Claude Code](https://code.claude.com/docs/en/sandboxing#what-the-sandbox-restricts); Codex dùng `workspace-write`,
`approval_policy=on-request`, `approvals_reviewer=auto_review`.

Owner có thể ghi `permission_mode: full-access` trong pin bằng `write-pin --permission-mode full-access`.
Khi đó worker Claude dùng `bypassPermissions`; sandbox Claude được chọn độc lập qua
`write-pin --sandbox on|off` hoặc `settings.sandbox.enabled`, không đổi theo permission mode.
Nếu không khai báo, sandbox worker tắt; nếu bật, không fallback ra ngoài khi lỗi. Codex dùng `danger-full-access`
và `approval_policy=never`. Decider vẫn theo vai trò chỉ đọc; từ hiến chương 8.0.0 reviewer chạy như fixer và daemon trả worktree về. Đổi permission mode cần pin/manifest
khớp nhau; thay sandbox cũng cần proof mới. Task hay worker không tự chọn mode. Auto review/approve này chỉ xử lý quyền tool trong
harness, không thay `full-review`/`direct-pr`, gate, run confirmation hoặc quyền merge của workflow.

Lý do: các lớp sandbox lồng nhau chặn công cụ, socket và test, làm tăng công vận hành trên máy cá nhân
với repo tin cậy. Setup/gate/autofix do Cuesura gọi chạy trên host. Worktree không là ranh giới bảo mật:
Cuesura không còn hứa che toàn bộ home, Git metadata, database, socket hoặc secret khỏi process cùng UID.
Giữ home/auth riêng, lọc credential khỏi environment, kiểm tra pin/hash, kết quả, reviewer và Git metadata;
các kiểm tra sau chạy phát hiện thay đổi, không ngăn mọi truy cập trên host.

Manifest mới ghi `isolation_mode=native`, `provider=host` và mode quyền đã chọn, không cần outer proof.
Bằng chứng bwrap cũ giữ nguyên để đọc lịch sử; không dùng nó cho một lần chạy host mới. Task đã đóng băng
với outer bwrap phải kết thúc/hủy theo release cũ rồi tạo task mới; không ngầm thay snapshot của task đang chạy.

Khi worker Claude tắt sandbox nhưng giữ auto, manifest ghi `selected_inner_mode=permissions_only`
và `native_result=not_tried`; vẫn cần bằng chứng cưỡng chế rule quyền. Khi bật sandbox, cả auto và
full access đều cần probe âm native đạt. Decider giữ sandbox chỉ đọc trong mọi lựa chọn của worker.
