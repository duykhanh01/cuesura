# Host prerequisites cho feature 002

Đây là runbook provisioning bởi người quản trị, **chưa được cài trên host bởi lượt sửa plan**.
Không chạy tasks triển khai A trước khi [lát 0](../specs/002-task-to-green-pr/spike-0.md) có kết quả
đạt. Doctor báo prerequisite thiếu kèm runbook, không tự chạy sudo hoặc sửa sysctl.

## Ubuntu và AppArmor

Host đã xác nhận `kernel.apparmor_restrict_unprivileged_userns=1`; `bwrap --unshare-user` thất bại
`setting up uid map: Permission denied`. Đây là blocker của môi trường triển khai, không phải chỉ
lỗi phiên agent. Ubuntu mô tả restriction và permission `userns` trong
[release notes 24.04](https://documentation.ubuntu.com/release-notes/24.04/).

Chọn **hướng (a)**: profile gắn đúng `/usr/bin/bwrap`, giữ sysctl=1, theo cơ chế của
[AppArmor v4.0.2 bwrap-userns-restrict](https://gitlab.com/apparmor/apparmor/-/raw/v4.0.2/profiles/apparmor/profiles/extras/bwrap-userns-restrict).
[cusr-bwrap](apparmor/cusr-bwrap) cho bwrap dùng capability để dựng namespace, rồi exec process con
với stack chứa `cusr-bwrap-child`, có `audit deny capability,`. Các lần exec kế tiếp giữ stack
deny đó, kể cả gọi `/usr/bin/bwrap` lần nữa hoặc chạy một bản copy trong scratch. Không dùng
`flags=(unconfined)` hoặc local override trả CAP_SYS_ADMIN cho descendants.

Quyền gọi bwrap có cả trong agent sandbox vì `/usr` mount ro vẫn cho exec; profile cũ cấp userns
không hạn chế process con vì vậy đã bị thay, **không phải rủi ro đã được chủ dự án chấp nhận**.
Profile mới vẫn cho phép `userns` như mẫu upstream; không hứa chặn mọi lần tạo userns hoặc loại bỏ
mọi bề mặt kernel. Cơ chế là AppArmor chặn sử dụng capability trong descendants, không xóa bit
CapEff ở `/proc/self/status`. Mount/PID/filesystem policy của bwrap vẫn cần, profile này không
thay filesystem confinement. Mẫu nguồn dùng ABI 4.0, đã đổi tên và bỏ local override; license
GPL-2.0-only của profile nằm ở [COPYING](apparmor/COPYING), không thay license file khác của repo.

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

Kiểm hai profile names với `apparmor_parser --names`, rồi dùng
[fixture capability](apparmor/probe-child.py) **sau khi** admin provisioning, từ root repo:

```sh
bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --tmpfs /tmp --dev /dev /usr/bin/python3 deploy/apparmor/probe-child.py
```

Fixture yêu cầu nhãn process có child stack ở enforce mode; thử thao tác mount namespace cần
CAP_SYS_ADMIN phải EPERM, cả trước/sau thử tạo userns trong process con. Nó kiểm descendant,
re-exec `/usr/bin/bwrap` và bản copy: nếu nested setup thành công, command bên trong vẫn phải qua
denial probe; nếu setup bị từ chối, ghi errno/output để đối chiếu audit. Thu audit host đúng cửa
sổ probe, profile name và capability denial; một exit khác 0 hoặc userns không tạo được một mình
không đủ chứng minh policy đúng. Fixture tự chạy ngoài child profile phải fail trước mọi probe.

Lệnh `ro-bind / /` chỉ phục vụ probe, không là sandbox task. S0.1 còn kiểm layout thực, quyền và
**harness nested sandbox còn bật** cho cả Claude/Codex. Capability denial có thể làm nesting fail;
đó là no-go phải ghi thật, không xóa deny, thêm priority capability override, dùng unconfined hoặc
`--dangerously-*` để cho pass. OS user riêng cần thiết kế/review lại nếu không tương thích. Không
nới sysctl toàn máy và không nạp profile chỉ dựa trên parser exit 0.

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
