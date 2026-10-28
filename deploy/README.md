# Host prerequisites cho feature 002

Đây là runbook kiểm host và provisioning khi cần; cập nhật tài liệu không tự cài hoặc gỡ policy.
Không chạy runtime A trước khi [lát 0](../specs/002-task-to-green-pr/spike-0.md) có kết quả
đạt. Doctor báo prerequisite thiếu kèm runbook, không tự chạy sudo hoặc sửa sysctl.

## Baseline Isolated: rootless bwrap

Theo [ADR-0004](../docs/adr/0004-isolated-bwrap-baseline.md), luồng tự động v1 dùng rootless
bwrap bọc toàn bộ harness và repo-controlled setup/gate/autofix, runner thuộc systemd user unit.
Không bắt buộc Ubuntu 24.04, AppArmor 4 hoặc child stack Cuesura. V1 chỉ có backend bwrap qua
port SandboxProvider nhỏ; Native-only và Container/VM chưa triển khai.

Từ root repo, kiểm bằng user thường; các lệnh dưới đây không nạp profile hoặc đổi sysctl:

```sh
node --version
bwrap --version
bwrap --unshare-user --ro-bind / / /usr/bin/true
systemctl --user is-system-running
node scripts/spike-002/sandbox.ts probe --all
node scripts/spike-002/reassess-sandbox.ts
```

Probe `ro-bind / /` chỉ kiểm namespace khởi động, không là sandbox task. Hai script dùng fixture
tạm, kiểm mount/PID/env/secret/control và re-exec/copy/raw-userns trên layout tối thiểu. Kết quả
local không thay full S0.1: vẫn cần FD/socket thật, mọi vùng rw/path-race, lifetime cgroup và native
nội bộ/permission/auth của từng vendor/version/role. Ghi command/exit/version/hash và nguồn host
vào [report](../specs/002-task-to-green-pr/spike-0-report.md). T002 đã cập nhật thông điệp prototype
theo ADR-0004; thông điệp cũ yêu cầu child stack không phải tiêu chí pass hiện tại.

Nếu host từ chối userns, doctor chặn và báo policy/prerequisite cụ thể. Quản trị viên review
kernel/package/profile hiện có để provisioning phù hợp; không tự sudo, đổi sysctl, ghi đè profile
managed hoặc chạy unsandboxed. Không suy failure ở host bwrap 0.9.0 trong báo cáo lịch sử thành
failure của mọi host Ubuntu/WSL2.

### AppArmor: policy host và hardening tùy chọn

Giữ nguyên policy host. Profile [cusr-bwrap](apparmor/cusr-bwrap) theo ABI 4.0 từ
[quyết định cũ](../docs/adr/0003-bwrap-child-capabilities.md) được giữ như artifact hardening tùy
chọn, không là dependency hay lệnh cài mặc định. Quản trị viên phải review attachment đúng binary,
profile hiện có, tương thích nesting và ảnh hưởng đến mọi ứng dụng dùng `/usr/bin/bwrap` trước khi
nạp/gỡ; lượt cập nhật này không thay policy đã cài. License profile ở [COPYING](apparmor/COPYING).

Nếu chủ động chọn hardening child stack, kiểm compile/load/enforce và
[probe-child.py](apparmor/probe-child.py) cùng audit capability denial trên host đó; đây là evidence
bổ sung, không thay layout proof và không ép host khác phải có cùng nhãn. Không có child stack
không tự là fail baseline; ít hardening kernel hơn không được báo tương đương về mọi threat.

### Sandbox nội bộ của harness

Trong Isolated, mặc định `internal_required`: sandbox nội bộ bật và phải thực sự dùng khi tool
chạy, không silent retry ngoài sandbox. Chỉ xét `external_verified` theo ADR-0004 khi native đã
thử và fail, outer boundary được chứng minh, permission/approval negative fixtures đạt, owner cho
phép trong trusted config và hashes/version/layout còn khớp. Managed policy bắt buộc native thì
không override; không dùng dangerously/bypass/accept-all hoặc đổi mode theo lỗi từng tool call.
Nếu binary không tách được OS sandbox khỏi quyền/approval, binding vẫn blocked.

## systemd và WSL2

Daemon gọi `spawn` cho `systemd-run --user`; runner transient service độc lập, `Restart=no`,
`KillMode=control-group`, không dependency vòng đời vào daemon. Không coi PID1 là systemd là đủ:
doctor kiểm user bus, unit create/query/stop và fixture stop daemon không dừng runner unit.

Trên WSL2, `/etc/wsl.conf` cần:

```ini
[boot]
systemd=true
```

Sau thay đổi, người dùng chạy `wsl.exe --shutdown` từ Windows rồi mở distro lại; doctor kiểm runtime
thực tế. Xem [Microsoft WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd).
`systemctl --user is-system-running` có thể `degraded` do unit không liên quan; pass/fail dựa vào
probe unit riêng của Cuesura, không chỉ chuỗi trạng thái này. Logout/distro shutdown không tương
đương daemon restart; không cam kết runner sống qua việc tắt máy/WSL, recovery phải đối chiếu lost.

## Network và credentials

Theo quyết định chủ dự án 2026-10-28, mặc định `internet_outbound`: setup/gate/autofix và agent có
DNS/Internet để tải package và gọi vendor. Feature 002 dùng network namespace host (không
`--unshare-net`), không có domain allowlist/egress firewall; vì vậy cũng **không** hứa chặn LAN,
loopback hoặc dịch vụ mạng host. Các fixture lát 0 kiểm thực tế pnpm/pip/vendor hoạt động. Đây là
đánh đổi chức năng được chấp nhận; máy có dịch vụ nội bộ nhạy cảm cần policy mạng khác được review.

Không đưa GitHub/SSH/admin token, socket điều phối, docker socket, toàn home host vào sandbox.
Quyền đọc filesystem/PID vẫn giới hạn; mạng không tự cấp quyền GitHub. Selected model auth chỉ có
trong home harness riêng; setup/gate không nhận model auth. Không mount credential helper hoặc
agent-forwarding socket để làm cho git push của repo script hoạt động.
