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

### Chuẩn bị theo hệ và cách sửa khi preflight báo `capability_missing`

Preflight (T030) kiểm từng điều kiện dưới đây và báo đúng nguyên nhân kèm mã `cause`; nó chỉ in
lệnh sửa, không tự chạy sudo, đổi sysctl hay nạp profile. Không có điều kiện nào được bỏ qua bằng
cách chạy unsandboxed.

| Hệ | Cần làm |
| --- | --- |
| Ubuntu 22.04 (desktop/server), WSL2 | Cài `bubblewrap` nếu thiếu; server headless bật linger |
| Debian 11/12, Fedora, RHEL/Rocky 8–9, Arch | `bubblewrap` từ gói distro; thường chạy ngay |
| Ubuntu 23.10/24.04+ | Như trên, thêm profile AppArmor cho phép userns cho bwrap |
| Host tắt user namespace (hardening, một số container) | Quản trị viên bật lại userns |

| `cause` | Dấu hiệu | Lệnh sửa (người dùng tự chạy) |
| --- | --- | --- |
| `bwrap_missing` | Không tìm thấy `bwrap` | `sudo apt install bubblewrap` (hoặc gói `bubblewrap` của distro) |
| `userns_apparmor_restricted` | `bwrap --unshare-user …` lỗi `setting up uid map: Permission denied` và `kernel.apparmor_restrict_unprivileged_userns = 1` | Nạp profile userns cho bwrap, xem bên dưới |
| `userns_disabled` | `user.max_user_namespaces = 0` hoặc `kernel.unprivileged_userns_clone = 0` | Quản trị viên review chính sách hardening của host rồi mới bật lại; Cuesura không đề xuất giá trị sysctl |
| `systemd_user_unavailable` | Không có user bus / `systemctl --user` lỗi (server headless, phiên SSH đã thoát) | `sudo loginctl enable-linger "$USER"`; WSL2 xem mục systemd và WSL2 |
| `bwrap_probe_failed` | `bwrap --unshare-user …` lỗi nhưng không khớp dấu hiệu nào ở trên; preflight in stderr của bwrap | Chạy các lệnh kiểm ở mục Baseline và review policy host; không chạy unsandboxed |

Profile userns cho Ubuntu 23.10/24.04+: trước khi nạp, kiểm `ls /etc/apparmor.d` xem đã có profile
nào attach `/usr/bin/bwrap` chưa (do distro hoặc gói khác cài, hoặc [cusr-bwrap](apparmor/cusr-bwrap)
ở mục dưới); đã có thì review profile đó thay vì nạp thêm, vì hai profile cùng attach một binary sẽ
xung đột. Profile này chỉ cho bwrap tạo user namespace như trước khi Ubuntu bật hạn chế; mọi
chương trình khác vẫn bị chặn, và mọi user trên máy dùng được bwrap.

```sh
sudo tee /etc/apparmor.d/cusr-bwrap-userns >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile cusr-bwrap-userns /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/cusr-bwrap-userns>
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/cusr-bwrap-userns
bwrap --unshare-user --ro-bind / / /usr/bin/true && echo ok
```

Gỡ: `sudo apparmor_parser -R /etc/apparmor.d/cusr-bwrap-userns && sudo rm /etc/apparmor.d/cusr-bwrap-userns`.

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
doctor kiểm user bus và chạy thử một transient unit tới khi xong rồi thu dọn. Việc runner sống qua lúc dừng
daemon cần dừng chính daemon, nên được kiểm bằng `test/integration/runtime/supervisor-systemd.test.ts`.

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

### Chạy daemon: foreground hoặc service

Một data dir chỉ có một writer: daemon thứ hai trên cùng thư mục thoát với `store_locked`. Chọn một
trong hai cách, cả hai dùng cùng runner unit `cusr-op-*.service` độc lập với daemon.

Foreground, dừng bằng Ctrl-C hoặc SIGTERM:

```sh
cusrd --config ~/.cusr/config.yaml --data-dir ~/.cusr
```

Service: dùng unit mẫu [cusrd.service](systemd/cusrd.service). Repo không tự cài hay nạp unit; người
vận hành sửa `ExecStart` theo nơi cài rồi tự chạy:

```sh
install -D -m 0644 deploy/systemd/cusrd.service ~/.config/systemd/user/cusrd.service
systemctl --user daemon-reload
systemctl --user enable --now cusrd.service
cusr status --json
cusr doctor --project "$PROJECT" --json
```

Yêu cầu version: Node đúng `engines` trong `package.json`, `systemd-run` và `systemctl` tại
`/usr/bin`. Trên WSL2 cần user manager như mục trên; `wsl.exe --shutdown` dừng cả daemon lẫn runner,
restart đối chiếu `lost`. Trên server headless cần `loginctl enable-linger` như bảng `cause`. Đường dẫn
thực tế (data dir, socket `control.sock`, `owner.token`) theo `--data-dir`/`runtime.data_dir`; socket
phải ngắn hơn 108 byte.

`cusr doctor` chỉ đọc: không gọi model, không sudo, không provision. Check nào fail thì exit 1 và in lệnh
sửa để người vận hành tự chạy. Harness chưa có capability manifest thì báo fail, không suy "proven" từ
help/version của binary; manifest có rồi vẫn fail nếu hash sai, thiếu năng lực bắt buộc hoặc binary đã đổi.
Settings, environment và host policy cần pin của vendor nên do preflight và từng attempt kiểm. Unit mẫu đã
qua `systemd-analyze --user verify` (chỉ báo thiếu binary ở `ExecStart` khi chưa cài).

**Hạn chế hiện tại:** `cusrd` production chưa nối effect handler và harness (git/GitHub thật có ở recheck,
cancel, doctor và preflight), và chưa ghi manifest; task dừng ở PENDING `capability_missing`, không tới
PR. Luồng tới PR đang được kiểm bằng fake/fixture; nối production là điều kiện trước smoke lát C.

## Token và quyền

Quyền chỉ lấy từ bearer token map phía server: `read`, `operate`, `admin` kèm danh sách project. Tên
actor/role tự khai trong body không có tác dụng, kiểm quyền chạy trước kiểm schema nên caller tự khai
owner/admin vẫn exit 5.

**Owner bootstrap.** Daemon sinh `DATA_DIR/owner.token` (0600) ở lần khởi động đầu, có đủ ba quyền trên
mọi project. Chỉ owner dùng; không chia sẻ cho assistant. Data dir phải 0700 và thuộc đúng user, nếu
không daemon từ chối chạy.

**Token assistant.** Owner sinh secret 32 byte ngẫu nhiên vào file riêng ngoài worktree và ngoài home
assistant đọc được, không in ra chat/log:

```sh
install -d -m 0700 /srv/cusr-access
(umask 077; head -c 32 /dev/urandom | basenc --base64url | tr -d '=\n' > /srv/cusr-access/assistant-work.token)
```

Khai trong user config (không phải `cusr.yaml`, không qua payload lệnh) với đúng `[read, operate]` và
project tường minh:

```yaml
runtime:
  access_tokens:
    - id: assistant-work
      actor: assistant
      roles: [read, operate]
      projects: [node-sandbox]
      token_file: /srv/cusr-access/assistant-work.token
```

**Cấp và thu hồi.** Thêm/xóa entry rồi restart daemon; không có lệnh quản trị token qua CLI. Startup ghi
audit gồm hash cấu hình và ID/actor/role/project/fingerprint của từng token, không ghi secret. Thu hồi
chặn mọi request mới (exit 5) nhưng không giả vờ lấy lại effect đã gửi; lịch sử đã accepted giữ actor
cũ. Hai entry trỏ cùng secret bị từ chối lúc khởi động.

**Cách cấp cho assistant.** Client/connector đặt `CUSR_TOKEN_FILE` trỏ tới file token operate; token chỉ
nhận qua file, không qua argv. Connector không được thấy home owner hay `owner.token`.

**Ranh giới.** Token map **không** phải ranh giới quyền với process cùng UID có shell đầy đủ: process đó
đọc được `owner.token`. Muốn tách quyền thật, chạy assistant bằng UID khác hoặc trong sandbox chỉ thấy
token operate. Worker coder/fixer/reviewer không nhận token nào, kể cả operate: sandbox từ chối biến
`CUSR_TOKEN*` và không mount data dir.

## Harness thật: pin và manifest

`cusrd` chỉ gọi một harness khi có đủ hai bản ghi của owner tại `<DATA_DIR>/harnesses/<tên harness>/`:

- `pin.json` theo `VendorPinSchema`: binary (realpath, version, sha256), toolchain, env không bí mật,
  `home_files` trỏ tới tên trong `runtime.credential_refs`, settings, `max_turns`, `tools`. Pin mới là thứ
  quyết định binary nào chạy, không phải `harnesses.<tên>.cmd`. Xem mẫu đã kiểm chứng ở
  `test/fixtures/runtime/spike-0/harness/real-20261028/pinned-*.json`.
- `manifest.json`, chỉ ghi bằng lệnh dưới đây, từ evidence của **đúng binary và cấu hình đó**:

```sh
cusr-runner record-manifest --config ~/.cusr/config.yaml --harness claude --evidence <evidence.json>
```

Mỗi vendor trong evidence phải có `binary.sha256` và `attested` gồm `settings_hash`, `environment_hash`
(env, toolchain, `home_files`, `max_turns`, `tools`), `host_policy_hash`, `layout_shapes` của lượt chứng minh.
Lệnh so từng trường với pin và host hiện tại, lệch là từ chối và in giá trị cần có; đổi bất kỳ trường nào của
pin đều cần chứng minh lại (T126), và pin sửa sau khi ghi sẽ chặn request, attempt kế tiếp. Đổi đường dẫn file
credential thì không cần: bằng chứng không phụ thuộc file nằm ở đâu. Evidence T007 không có `attested` nên không dùng được. Lệnh không gọi harness, không tốn usage.

Sau khi ghi, restart `cusrd`. `cusr doctor` báo lý do ở `manifest:<tên>` khi bản ghi thiếu hoặc không còn khớp;
lúc đó task dừng ở `capability_missing`. Đổi `runtime.credential_refs` hoặc `tool_paths` khi daemon đang chạy
cũng chặn việc mới tới khi restart. Task đã bắt đầu vẫn dùng credential reference đã đóng băng của nó.
Mọi credential file mà config hiện tại hoặc bất kỳ task nào trong store từng đóng băng đều không được nằm trong
mount của sandbox, kể cả sau khi đã thay trong config; đụng mount thì gate/agent không chạy (`not_launched`,
`capability_missing`). Danh sách này không tự thu hẹp theo thời gian, nên đừng để credential trong thư mục toolchain
hay repo; `cusr doctor` báo trước ở mục `credential_mounts`.

Push dùng `gh auth git-credential` qua script `<DATA_DIR>/git-credential-gh` do daemon tạo; không mount vào
sandbox. Gate chỉ thấy `/usr` và thư mục của `node` đang chạy daemon, nên công cụ cài ở nơi khác (pnpm toàn
cục ngoài thư mục đó, Python qua pyenv) phải có trong đó hoặc gate sẽ báo không tìm thấy lệnh.

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
