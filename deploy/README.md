# Host prerequisites cho feature 002

Đây là runbook provisioning bởi người quản trị, **chưa được cài trên host bởi lượt sửa plan**.
Không chạy tasks triển khai A trước khi [lát 0](../specs/002-task-to-green-pr/spike-0.md) có kết quả
đạt. Doctor báo prerequisite thiếu kèm runbook, không tự chạy sudo hoặc sửa sysctl.

## Ubuntu và AppArmor

Host đã xác nhận `kernel.apparmor_restrict_unprivileged_userns=1`; `bwrap --unshare-user` thất bại
`setting up uid map: Permission denied`. Đây là blocker của môi trường triển khai, không phải chỉ
lỗi phiên agent. Ubuntu mô tả restriction và permission `userns` trong
[release notes 24.04](https://documentation.ubuntu.com/release-notes/24.04/).

Chọn profile riêng gắn **đúng `/usr/bin/bwrap`**, giữ sysctl=1. File
[cusr-bwrap](apparmor/cusr-bwrap) dùng chế độ AppArmor unconfined để cấp userns cho executable này;
nó không tự hạn chế filesystem/network và mọi người có thể thực thi binary đó đều được hưởng
quyền này. Cách ly runtime vẫn do mount/PID/capability arguments của bwrap; không gọi đây là profile
confinement hoàn chỉnh. Đánh đổi được ghi rõ thay vì tắt restriction cho mọi executable bằng sysctl.

Trước cài, quản trị viên kiểm `readlink -f /usr/bin/bwrap` đúng executable package root-owned, không
setuid; kiểm không có profile attachment khác cùng binary bằng AppArmor tools. Nếu đường dẫn khác,
dừng để review profile theo path thật, không dùng wildcard bao phủ mọi binary. Không overwrite profile
bwrap có sẵn; merge/review theo policy host nếu có.

Các lệnh sau dành cho quản trị viên chạy từ root repo sau khi review file:

```sh
apparmor_parser --skip-kernel-load --skip-cache deploy/apparmor/cusr-bwrap
sudo install -o root -g root -m 0644 deploy/apparmor/cusr-bwrap /etc/apparmor.d/cusr-bwrap
sudo apparmor_parser --replace /etc/apparmor.d/cusr-bwrap
```

Rồi từ **user thường**, không sudo, kiểm namespace và giữ sysctl không đổi:

```sh
sysctl kernel.apparmor_restrict_unprivileged_userns
bwrap --unshare-user --ro-bind / / /usr/bin/true
```

Lệnh `ro-bind / /` ở đây chỉ probe kernel, không là sandbox thực thi task. Lát 0 còn phải kiểm mount
allowlist thực, PID/proc, Internet, quyền của hai harness và sandbox lồng nhau. Profile này không
hứa sửa mọi lỗi nesting/landlock; nếu kiểm lồng thất bại thì gate vẫn fail, không bỏ sandbox trong
harness hay dùng `--dangerously-*`. OS user riêng là hướng thiết kế lại cần review nếu lát 0 thất
bại; không âm thầm chuyển backend. Không chọn nới sysctl toàn máy.

Rollback khi không còn runner sử dụng profile: quản trị viên unload profile trước, rồi xóa đúng file
đã cài; không xóa profile khác hoặc sửa `kernel.apparmor_restrict_unprivileged_userns`:

```sh
sudo apparmor_parser --remove /etc/apparmor.d/cusr-bwrap
sudo rm -- /etc/apparmor.d/cusr-bwrap
```

Nếu host/package đã có profile chuẩn phù hợp, dùng profile đó sau kiểm chứng và ghi ref/hash trong
manifest, không cài attachment cạnh tranh chỉ để khớp tên Cuesura.

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
