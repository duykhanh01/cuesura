# Host prerequisites cho feature 002

Đây là runbook kiểm host và provisioning khi cần; cập nhật tài liệu không tự cài hoặc gỡ policy.
Chứng minh harness native trên đúng binary/settings trước khi chạy task thật. Bằng chứng outer bwrap
ở lát 0 là lịch sử. Doctor báo prerequisite thiếu, không tự chạy sudo hoặc sửa sysctl.

## Baseline: quyền native của harness

Theo [ADR-0005](../docs/adr/0005-native-harness-permissions.md), Cuesura bỏ outer bwrap và chạy
harness trực tiếp trong worktree riêng. Setup/gate/autofix chạy trên host; systemd giám sát runner.
Không cần outer sandbox proof của Cuesura. Sandbox native của Claude vẫn phụ thuộc policy userns/AppArmor
của host; các fixture và ADR outer bwrap cũ là lịch sử.

<a id="host-prerequisites"></a>

### Chuẩn bị theo hệ và cách sửa khi preflight báo `capability_missing`

Cài Node/pnpm và công cụ project trên PATH host. `cusr doctor` kiểm systemd, pin/manifest và công cụ
harness cần. Claude native trên Linux vẫn có thể cần `bwrap`/`socat` cho sandbox của chính Claude;
đây không phải outer bwrap của Cuesura. Codex dùng sandbox native của Codex.

### User namespace và AppArmor của sandbox native

Claude có sandbox bật trên Linux vẫn dùng bwrap; reviewer luôn cần sandbox dù worker chọn tắt hoặc full access. Trên host mới,
cài `bubblewrap`/`socat` và kiểm tra bằng user chạy daemon:

```sh
bwrap --unshare-user --ro-bind / / /usr/bin/true
sysctl user.max_user_namespaces kernel.unprivileged_userns_clone kernel.apparmor_restrict_unprivileged_userns
```

Lệnh sysctl chỉ đọc; knob nào không tồn tại phụ thuộc kernel/distro. Nếu userns bị tắt hoặc bwrap lỗi
`setting up uid map: Permission denied`, quản trị viên review hardening và profile hiện có. Không suy
`apparmor_restrict_unprivileged_userns=1` thành bwrap chắc chắn bị chặn: profile đã nạp có thể cho phép nó.
Doctor/preflight chỉ kiểm executable và systemd; không còn probe userns toàn cục hay phát các cause
`userns_*`/`bwrap_*`. Lượt proof native sẽ fail nếu sandbox của harness không chạy hoặc không chặn probe.

Profile userns cho Ubuntu 23.10/24.04+: trước khi nạp, kiểm `ls /etc/apparmor.d` xem đã có profile
nào attach `/usr/bin/bwrap` chưa (do distro hoặc gói khác cài); đã có thì review profile đó thay vì nạp
thêm, vì hai profile cùng attach một binary sẽ
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

Không tự nạp/gỡ profile hoặc đổi sysctl; các lệnh provisioning trên do người vận hành review rồi chạy.
Các profile/probe outer bwrap cũ đã ngừng bảo trì; xem lịch sử Git khi cần đối chiếu bằng chứng cũ.
Kiểm tra native của đúng harness bằng `prove-harness` sau provisioning.

### Sandbox nội bộ của harness

`write-pin --permission-mode auto` (mặc định) chọn Claude mode `auto`, hoặc Codex `workspace-write`
với automatic approval review. Claude worker có tùy chọn riêng `--sandbox on|off`; flag này ghi
`settings.sandbox.enabled` vào pin, không đổi permission mode. Bỏ flag thì giữ `sandbox.enabled` trong
file settings; nếu không khai báo thì sandbox tắt như mặc định Claude Code.

| Claude worker | Sandbox tắt (mặc định) | Sandbox bật |
| --- | --- | --- |
| `--permission-mode auto` | Auto review quyền tool, `native_result=not_tried` | Auto review quyền tool và sandbox native, cần native proof |
| `--permission-mode full-access` | `bypassPermissions`, không sandbox worker | `bypassPermissions` trong sandbox native, cần native proof |

Reviewer luôn giữ sandbox chỉ đọc. `bwrap`/`socat` vì vậy vẫn cần cho harness Claude. Đây là quyền tool,
không phải tự duyệt run config, review code hoặc merge. Khi đã bật sandbox, lỗi không tự chuyển sang
tắt hoặc full access. Codex không nhận flag `--sandbox` này; chế độ sandbox Codex giữ theo permission mode.

<a id="systemd-and-wsl2"></a>

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

**Lưu giữ:** thư mục run chỉ bị xoá khi task đã kết thúc, `exit.json` hoàn chỉnh, mọi artifact đã được store ghi nhận và đã qua 30 ngày;
phần xoá để lại tombstone chứa digest. Worktree không bị xoá chỉ vì cũ: diff hoặc commit chưa có trên remote thì giữ lại.

**Recovery:** khi quét process sau restart, một process cùng user không đọc được `environ` (`ssh`, `sudo`) và bắt đầu từ lúc operation chạy
sẽ giữ claim và chặn việc mới cho tới khi process đó kết thúc; daemon tự thử lại mỗi giây.

**Hạn chế hiện tại:** `cusrd` chạy task thật tới PR khi harness có bản ghi hợp lệ (mục [Harness thật](#harness-thật-pin-và-manifest)
bên dưới); thiếu bản ghi thì task dừng ở PENDING `capability_missing`. Còn hở: task có attachment `content_ref`
fail ở freeze vì chưa có nguồn nội dung (`cusr add` luôn tạo task không attachment); `lint` là gate tùy chọn của `software_dev` nên đỏ vẫn publish.

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
token operate. Worker coder/fixer/reviewer không được truyền token nào, kể cả operate; environment không kế thừa
`GH_*`, `GITHUB_*` hoặc `CUSR_TOKEN*`. Không còn outer boundary chặn process cùng UID đọc file host.

## Giới hạn thực thi tùy chọn

Task và worker mặc định không có trần số lượt chạy, tổng thời gian, thời gian mỗi worker/lệnh,
số lần retry hạ tầng hoặc số lần nâng model. Bỏ khóa hoặc đặt `null` để chạy không giới hạn:

```yaml
profiles:
  dogfood:
    workflow: impl
    escalation: { max_escalations_per_task: null }
    limits:
      classes: { infra_retries: null }
      backoff:
        infra: { base: 5s, factor: 2, max: 5m, max_attempts: null }
        rate_limit: { base: 1m, factor: 2, max: 30m, max_attempts: null }
roles:
  coder:
    binding: [{ model: sonnet }]
    limits: { wall_timeout: null, stall_timeout: 10m }
runtime:
  limits: { command_wall_ms: null }
```

Profile không còn khóa `budgets`: xóa khóa này khỏi user config trước khi nâng release, nếu không config sẽ bị từ chối khi nạp. Đây là đoạn cấu hình minh họa để ghép vào user config hiện có. Giá trị số/duration khai rõ vẫn được
áp dụng; `null` ở profile con xóa trần thừa kế từ profile cha. Backoff vẫn tăng khoảng nghỉ giữa
các lần retry. `stall_timeout` chỉ dừng worker không có tín hiệu tiến triển; hủy task vẫn hoạt động.
Các giới hạn workflow (`max_visits`, thang model, xử lý lỗi chất lượng), quyền và dung lượng log/context
vẫn theo cấu hình riêng.

Claude không còn bắt buộc `--max-turns` khi tạo pin: bỏ cờ này để `max_turns` trong pin là `null`.
Pin cũ có số turn vẫn giữ trần đã khai; tạo lại pin bằng `write-pin --force` khi muốn bỏ trần.

Với Claude, `roles.<role>.limits.max_turns` được áp dụng cùng trần trong pin: nếu cả hai có số thì dùng
số nhỏ hơn. Bỏ cả hai để không giới hạn. Cap turn này chỉ áp dụng cho Claude;
dùng wall/stall timeout cho binding Codex. Hết turn là `timeout`, dùng cơ chế retry/hỏi người vận hành của
timeout, không tiêu lượt retry infra. Worker host chỉ bật persistence khi manifest có `resume: proven`;
khi chưa chứng minh resume thì dùng `--no-session-persistence`. Reviewer luôn dùng phiên mới và tắt persistence.

Các policy/runtime snapshot của task đã chạy giữ nguyên giới hạn đã đóng băng. Sau khi nâng release,
xóa các trần trong user config và tạo lại pin/manifest theo mục bên dưới để task mới dùng cấu hình
không giới hạn; không sửa tay snapshot hoặc manifest của task cũ.

## Yolo

`yolo: true` trong user config cho daemon tự merge PR của task đang chờ merge. Không bật được qua
`cusr.yaml`. Config được đọc lại trước mỗi lần merge nên sửa về `false` có hiệu lực không cần restart;
không chặn được request đã gửi tới GitHub.

- `full-review` cần reviewer của Cuesura approve; đây không phải review trên GitHub.
- `direct-pr` không có reviewer đọc diff: chỉ gate và CI chặn lỗi.
- Branch protection là tùy chọn, khuyến nghị bật required checks, "up to date" và áp dụng cho admin
  như lớp chặn thêm do GitHub thực thi. Không bật yêu cầu approvals nếu chỉ có một tài khoản.
- Daemon yêu cầu PR `clean`, đúng head/target, và compare `head...target` trả `ahead_by === 0`.
  Khi head chứa tip, chiều compare này có diff rỗng, tránh phản hồi quá lớn. Giữ điều kiện `clean`
  thận trọng: check không bắt buộc đỏ có thể làm GitHub trả `unstable` và chặn yolo.
- Cả CI và observation chờ `ci.required_checks` đóng băng hợp với tên check GitHub đang bắt buộc,
  kể cả check ngoài policy/ghim app; không phụ thuộc cờ yolo và không sửa FrozenPolicy. Tên/app được
  lưu trong evidence. Không đọc đủ luật/check, thiếu quyền hoặc có collision thì chưa đạt.
- Trước merge, daemon tự yêu cầu check ghim app có `success` đúng `app_id`; không tin rằng GitHub
  sẽ chặn hộ, vì admin có thể bypass nếu protection không áp dụng cho admin.
- Khuyến nghị khai `ci.required_checks`. Nếu hợp danh sách rỗng, task vẫn vào chờ merge như cũ;
  yolo không merge và log một lần mỗi task trong vòng đời daemon, hướng dẫn khai danh sách này.
  Không dùng mọi check đang thấy trên head làm fallback vì workflow khác có thể chưa kịp tạo check.
  Job `skipped` chỉ chặn khi thuộc hợp check bắt buộc.
- Lỗi đọc hoặc validate user config được ghi log và coi yolo là tắt; không tác động CI/observation.
- Không có protection, GitHub không chặn race nếu nhánh đích có commit mới hoặc check đổi kết quả giữa
  lúc daemon đọc và lúc merge. `sha` chỉ chặn PR head đổi, không khóa tip nhánh đích hay kết quả check.

Ví dụ protection được khuyến nghị (không bắt buộc):

```sh
gh api -X PUT repos/<owner>/<repo>/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["build","test"]},"enforce_admins":true,"required_pull_request_reviews":null,"restrictions":null}
JSON
```

Cùng UID nên assistant đọc được và sửa được user config: yolo là quy tắc vận hành, không phải ranh giới
quyền thật ([token và quyền](#token-và-quyền)).

## Harness thật: pin và manifest

`cusrd` chỉ gọi một harness khi có đủ hai bản ghi của owner tại `<DATA_DIR>/harnesses/<tên harness>/`:

- `pin.json` theo `VendorPinSchema`: binary (realpath, version, sha256), toolchain, env không bí mật,
  `home_files` trỏ tới tên trong `runtime.credential_refs`, settings, `max_turns`, `tools`. Pin mới là thứ
  quyết định binary nào chạy, không phải `harnesses.<tên>.cmd`. Xem mẫu đã kiểm chứng ở
  `test/fixtures/runtime/spike-0/harness/real-20261028/pinned-*.json`. Tạo bằng `cusr-runner write-pin`, lệnh
  lấy version và sha256 từ binary trên host, để `env` rỗng và từ chối đường dẫn không tồn tại ở host này.
- `manifest.json`, chỉ ghi bằng lệnh dưới đây, từ evidence của **đúng binary và cấu hình đó**:

```sh
cusr-runner write-pin --config ~/.cusr/config.yaml --harness claude --vendor claude \
  --binary "$(command -v claude)" --toolchain /opt/node/bin --auth claude-0:.claude/.credentials.json \
  --settings claude-settings.json --permission-mode auto --sandbox off --tools Bash,Read,Edit,Write,Glob,Grep
cusr-runner record-manifest --config ~/.cusr/config.yaml --harness claude --evidence <evidence.json>
```

Để bật resume cho Claude, thêm `--prove-resume` vào `prove-harness`. Probe này cần thêm một invocation
ngoài ba role (dry-run hiển thị tổng số cần), rồi thử tiếp tục bằng private home mới và nhớ lại một nonce
chỉ có trong hội thoại trước. Chỉ bằng chứng probe đạt mới ghi `session_resume: proven`; sau đó ghi lại
manifest và restart. Resume chỉ mang transcript/tool data của đúng session, không mang auth/settings của
attempt cũ. Codex hiện chưa có resume được hỗ trợ; daemon ghi lý do và dùng phiên mới cùng context đầy đủ.

Nếu transcript/run cũ đã mất, worker dùng phiên mới với context đầy đủ và ghi `resume_fallback: session_missing`;
không chờ người vận hành chỉ để khôi phục hội thoại. Evidence của `--prove-resume` có `resume_probe` ghi
outcome và nguyên nhân cụ thể, kể cả khi coder thất bại hoặc không trả session nên probe chưa được chạy.

Mỗi vendor trong evidence phải có `binary.sha256` và `attested` gồm `settings_hash`, `environment_hash`
(env, toolchain, `home_files`, `max_turns`, `tools`), `host_policy_hash`, `layout_shapes` của lượt chứng minh.
Lệnh so từng trường với pin và host hiện tại, lệch là từ chối và in giá trị cần có; đổi bất kỳ trường nào của
pin đều cần chứng minh lại (T126), và pin sửa sau khi ghi sẽ chặn request, attempt kế tiếp. Đổi đường dẫn file
credential thì không cần: bằng chứng không phụ thuộc file nằm ở đâu. Evidence T007 không có `attested` nên không dùng được. Lệnh không gọi harness, không tốn usage.

Công cụ harness được tìm trên toolchain của pin cộng PATH daemon. Setup/gate dùng thư mục Node của daemon
cộng PATH daemon; preflight dùng đúng cùng danh sách với lệnh thực thi. Khi chạy daemon bằng systemd, đặt
`Environment=PATH=...` trong service nếu công cụ như pnpm chỉ có ở PATH shell. PATH shell khác daemon
không làm manifest mất hiệu lực; dependency cần thiết phải có ở môi trường thực thi. Reviewer Claude luôn cần dependency native, thường gồm `bwrap` và `socat`,
kể cả khi worker tắt sandbox hoặc dùng full access.
Doctor/preflight kiểm file executable trên host, không tạo outer sandbox để probe.

Proof kiểm rule từ chối một lệnh ghi **trong worktree**. Role có sandbox bật còn phải chứng minh
sandbox native chặn lệnh ghi vào đường dẫn host ở ngoài worktree; worker chọn tắt không chạy probe này. Thêm rule deny sau vào settings Claude dùng để ghi pin:

```json
{"permissions":{"deny":["Bash(/usr/bin/touch permission-denied-by-rule)"]}}
```

Với Codex, file `.codex/rules/` đã pin cần rule tương ứng:

```python
prefix_rule(pattern=["/usr/bin/touch", "permission-denied-by-rule"], decision="forbidden")
```

Giữ các rule owner khác khi thêm rule này. Lệnh deny dùng đường dẫn tương đối để kiểm marker ngay trong
worktree thật; rule cũ trỏ `/cusr/scratch` không chứng minh hợp đồng host mới. Probe native chỉ đạt khi log
**tool execution** có lỗi OS từ chối ghi và file đích không xuất hiện; trả lời hợp lệ hoặc rule từ chối tool
không đủ. Worker Claude tắt sandbox ghi `native_result=not_tried`; auto dùng mode `permissions_only`,
full access dùng `full_access`. Worker bật sandbox luôn cần `native_result=passed`, kể cả full access.
Reviewer vẫn chạy probe âm native. Đổi sandbox cũng cần tạo lại proof/manifest; không nhận bằng chứng
của lựa chọn cũ.

Sau khi nâng release, tạo lại pin với `--permission-mode auto` hoặc `full-access`, chạy `prove-harness`
không có `--outer-proof`, rồi `record-manifest` và restart daemon. Manifest cũ chứng minh outer bwrap
không dùng được cho native execution. Task đang đóng băng theo outer bwrap phải kết thúc/hủy ở release
cũ rồi tạo task mới; không đổi snapshot đang chạy. Đổi mode pin cũng cần proof/manifest tương ứng.

Push vẫn do daemon gọi qua credential helper tin cậy. Role/model/workflow và merge giữ cùng hợp đồng.

## Network và credentials

Cuesura chạy trên host và không thêm namespace mạng hay egress firewall. Mạng của lệnh do host và
native harness quyết định. Home/auth của harness vẫn riêng, credential được che trước khi lưu log,
và token điều phối/GitHub không tự được đưa vào environment worker hoặc gate. Process cùng UID có
quyền đọc file host theo OS; worktree và canary sau chạy không là ranh giới bảo mật ngăn truy cập đó.
