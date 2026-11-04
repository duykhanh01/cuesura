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
Setup và kiểm tra native của đúng harness bằng `setup-harness` sau provisioning.

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

### Xem agent trong herdr

Mặc định agent chạy nền (`background`). Muốn xem trực tiếp trong [herdr](https://herdr.dev), thêm vào
`runtime` rồi restart `cusrd`:

```yaml
runtime:
  terminal:
    backend: herdr # background là mặc định
    # session: cusr  # bỏ trống = session herdr mặc định
```

Cuesura tự tìm `herdr` trên PATH của daemon rồi trong `~/.local/bin`. Chỉ cần `tool_paths.herdr` khi cài ở
nơi khác.

Agent hiện ở các tab nền trong workspace `cuesura`, không chiếm focus; tab tự đóng khi xong, log vẫn đọc bằng
`cusr task logs`. Pane chỉ để xem: Ctrl-C, đóng pane hoặc dừng herdr không dừng agent; hủy bằng `cusr`. herdr
không chạy thì agent chạy nền, `cusr doctor` báo check `terminal`. Xem
[ADR-0006](../docs/adr/0006-terminal-view-backend.md).

### Xem agent trong Orca

Tương tự herdr, nhưng dùng [Orca](https://github.com/stablyai/orca):

```yaml
runtime:
  terminal:
    backend: orca
```

Cuesura tự tìm `orca` trên PATH của daemon, rồi trong `~/.config/orca/cli/bin` và `~/.local/bin`; cài ở nơi khác
thì đặt `tool_paths.orca`. Lần đầu có agent chạy, Cuesura tạo repo git rỗng `<data dir>/cuesura` và thêm nó vào
Orca thành project `cuesura`, vì terminal của Orca phải thuộc một project. Agent hiện ở các tab trong project đó,
không chiếm focus, và tab tự đóng khi xong. Gỡ project khỏi Orca thì lần chạy sau nó được thêm lại. Pane chỉ để
xem như với herdr; Orca không chạy thì agent chạy nền và `cusr doctor` báo check `terminal`.

### Xem agent trong Paseo

Tương tự herdr, nhưng dùng [Paseo](https://github.com/getpaseo/paseo); agent hiện cả trong app Paseo trên điện thoại:

```yaml
runtime:
  terminal:
    backend: paseo
```

Cần daemon Paseo đang chạy (`paseo daemon start`) với home mặc định `~/.paseo`. Cuesura tìm `paseo` trên PATH của
daemon rồi trong `~/.local/bin`; cài bằng `npm i -g` qua nvm thì đặt `tool_paths.paseo` tới script CLI, ví dụ
`~/.nvm/versions/node/<bản>/bin/paseo`. Cuesura chạy script đó bằng node của `cusrd`. Mỗi project của task hiện
trong app thành một project `cuesura-<project>` (thư mục `<data dir>/paseo/cuesura-<project>`). Terminal mang tên
vai trò và tiêu đề task, ví dụ `coder: Thêm …`, và tự đóng khi xong. Pane chỉ để xem như với herdr;
daemon Paseo không chạy thì agent chạy nền và `cusr doctor` báo check `terminal`.

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
timeout, không tiêu lượt retry infra. Claude luôn lưu session vào private home của attempt, không dùng
`--no-session-persistence`; chỉ resume khi manifest có `resume: proven`. Reviewer luôn dùng phiên mới.

Các policy/runtime snapshot của task đã chạy giữ nguyên giới hạn đã đóng băng. Sau khi nâng release,
xóa các trần trong user config và tạo lại pin/manifest theo mục bên dưới để task mới dùng cấu hình
không giới hạn; không sửa tay snapshot hoặc manifest của task cũ.

## Autonomous

`autonomous: true` trong user config cho một agent cấp cao trả lời thay khi bạn vắng mặt, ví dụ lúc đi ngủ.
Giống yolo, khóa này không bật được qua `cusr.yaml` và được đọc lại lúc chạy (chậm nhất 30 giây sau khi đổi),
không cần restart. Hai cờ độc lập: decider không merge, yolo không trả lời câu hỏi.

```yaml
autonomous: true
roles:
  decider:
    binding:
      - { model: opus, effort: high }
```

Decider dùng binding đầu tiên của role `decider`, thiếu role này thì config bị từ chối. Nó chạy phiên mới, chỉ
đọc, trong cùng ranh giới với reviewer. Role mới cần một lần `prove-harness` và `record-manifest` (mỗi lần chứng
minh giờ tốn 4 lượt thay vì 3). Manifest cũ vẫn chạy được coder, fixer, reviewer; khi đó decider báo
`capability_missing` trong log và câu hỏi vẫn mở.

- **Trả lời gì:** câu hỏi khiến task dừng ở `agent_question`, `agent_needs_context`, `agent_blocked`. Mọi câu hỏi
  trong một kết quả của worker đi cùng một lượt. Approval, merge và các loại chờ khác vẫn thuộc về người.
- **Không có trần số lần gọi,** nhưng không hỏi qua đáp lại: sau khi decider đã trả lời ở một step của một revision,
  câu hỏi tiếp theo ở step đó chờ người. Task có nhãn `grill` được hỏi đáp nhiều lượt và không có điểm dừng tự động.
- **Ghi lại:** event `DeciderRan` lưu câu trả lời, lý do và usage trong cùng giao dịch với `QuestionAnswered`
  (`by: agent:decider`). `<data dir>/decisions.md` được sinh lại toàn bộ từ event nên không sửa tay; crash hoặc lỗi
  ghi file không để lại mục dở.
- **Usage:** mỗi lượt giữ một reservation của `budget.agent_runs` trước khi khởi chạy. Task cũ có trần hoặc deadline đã
  đóng băng mà hết lượt hoặc quá hạn thì decider không chạy, câu hỏi chờ người. Lượt chạy không vượt quá deadline của task. Lượt đã gọi model được tính, kể cả khi lỗi, và hiện trong
  `decider_runs` của `task explain`. Lượt decider không phải attempt.
- **Tắt cờ:** daemon đọc lại cờ ngay trước khi nhận kết quả. Lượt đang chạy vẫn chạy hết và được tính usage, nhưng
  câu trả lời không được dùng và câu hỏi vẫn mở.
- **Restart:** ID và input của lượt chạy nằm ở `<data dir>/decider/` trước khi khởi chạy. Daemon mới chờ runner cũ kết
  thúc rồi đọc kết quả, không chạy lượt thứ hai cho cùng câu hỏi. Lượt chưa kịp khởi chạy thì bị bỏ, không khởi chạy khi
  cờ đã tắt. Không kết luận được thì log một lần và câu hỏi chờ người.
- **Khi lỗi:** câu hỏi vẫn mở, lý do nằm trong log, không gọi lại câu đó cho tới lần restart daemon. Một lượt không
  khai `wall_timeout` dừng sau 30 phút. Người trả lời trước thì câu của người thắng.
- **Lật lại:** decider không hoàn tác được gì. Xem `decisions.md` rồi revert hoặc tạo task mới. Run directory
  của decider không gắn với operation nào trong store nên retention không dọn.

## Workflow trong user config

Graph workflow cố định trong code (`software_dev@1`). User config chỉ chọn graph đó (`base`, bắt buộc)
và chỉnh tham số của từng bước (`steps`, tùy chọn):

```yaml
workflows:
  impl:
    base: software_dev@1
    steps:
      code: { max_visits: 12, max_rung: 2 }
      gates: { run: [build, unit, lint], required: [build, unit] }
      ci: { poll: 1m, timeout: 1h }
```

Khai bước, `start`, `kind`, `role`, `next`, `on_exhausted`, `uses`, `when`/`skip_when`/`auto_when` hay
`decisions` thì daemon từ chối nạp config với `workflow_key_removed` và đường dẫn khóa cần bỏ. Config chỉ
có `base: software_dev@1` (như config dogfood) không cần sửa. Cách nâng cấp config cũ và danh sách tham
số theo bước: [docs/config-upgrade.md](../docs/config-upgrade.md).

Task cũ giữ graph đã đóng băng trong policy snapshot: chúng vẫn chạy, replay và verify hash như trước,
các kiểm tra store của `cusr doctor` (schema, integrity, replay) vẫn sạch trên DB cũ. Không cần migration.
User config còn khóa cũ thì `cusrd` không khởi động, in từng lỗi dạng
`config.yaml:<dòng>:<cột> workflow_key_removed: ...`, còn `cusr doctor` báo check `config` thất bại;
sửa config theo hướng dẫn rồi khởi động lại daemon.

## Yolo

`yolo: true` trong user config cho daemon tự merge PR của task đang chờ merge. Không bật được qua
`cusr.yaml`. Config được đọc lại trước mỗi lần merge nên sửa về `false` có hiệu lực không cần restart;
không chặn được request đã gửi tới GitHub.

- `full-review` cần reviewer của Cuesura approve, trừ lượt tích hợp base có chứng nhận phạm vi dưới đây; đây không phải review trên GitHub.
- `direct-pr` không có reviewer đọc diff: chỉ gate và CI chặn lỗi.
- Branch protection là tùy chọn, khuyến nghị bật required checks, "up to date" và áp dụng cho admin
  như lớp chặn thêm do GitHub thực thi. Không bật yêu cầu approvals nếu chỉ có một tài khoản.
- Daemon đọc tip mới qua `GET branches/{target}`, không dùng `pull.base.sha` (có thể cũ).
  PR phải `clean`, đúng head/target, và compare `head...target_tip_sha` trả `ahead_by === 0`.
  Compare lấy trang 2, một commit/trang để tránh tải danh sách diff ở trang 1, kể cả khi head tụt sau target. Giữ điều kiện `clean`
  thận trọng: check không bắt buộc đỏ có thể làm GitHub trả `unstable` và chặn yolo.
- Cả CI và observation chờ `ci.required_checks` đóng băng hợp với tên check GitHub đang bắt buộc,
  kể cả check ngoài policy/ghim app; không phụ thuộc cờ yolo và không sửa FrozenPolicy. Tên/app được
  lưu trong evidence. Không đọc đủ luật/check, thiếu quyền hoặc có collision thì chưa đạt.
- Cập nhật base và sửa conflict áp dụng cả khi **tắt yolo**. PR đang chờ merge tụt sau target
  được cập nhật trong execution slot của task, theo policy và giới hạn visit/deadline đã đóng băng.
  Git cần hỗ trợ `merge-tree --write-tree` (2.38 trở lên). Với nhiều PR cùng chờ merge, PR sau tự
  cập nhật khi PR trước làm target tiến lên.
  - Không conflict: không gọi fixer/reviewer mới; chạy gate, publish và chờ CI trên head mới.
  - Conflict lần đầu: gọi fixer đúng một lượt. Host kiểm tra diff so với tree conflict ban đầu;
    mỗi file conflict phải được đổi so với tree ban đầu và qua gate thì publish/chờ CI, không review mới.
    Binary/modify-delete không có marker nhưng fixer không đổi file vẫn bị chặn.
  - Sửa file ngoài danh sách conflict (kể cả file mới/rename): phải review. `full-review` dùng
    reviewer hiện có; `direct-pr` chờ người vì snapshot không có reviewer được xác nhận.
  - Fixer lỗi/bị chặn/chưa xong, còn marker, gate fail hoặc conflict lại: mở question để người quyết định.
    Sửa tay rồi trả lời đúng `continue` để chạy lại gate/publish/CI; với conflict không marker, câu trả lời xác nhận
    lựa chọn giữ nguyên phiên bản file. Trả lời đúng `retry fixer` cho phép thêm một lượt worker.
    Poll không tự gọi thêm fixer; slot/visit/budget/deadline giữ nguyên. Gate flaky sau merge sạch
    dùng lại local commit đã có. Wait refused cũ có thể mở question bằng `cusr task recheck`.
    Trả lời qua lệnh có sẵn: `cusr answer <question-id> --file <answer.txt> --expected-version <version>`.
    `direct-pr` sửa ngoài phạm vi phải hoàn nguyên phần đó hoặc tạo task mới có reviewer.
  - Marker chỉ được tìm trên file conflict bằng phép đọc im lặng; heading Markdown `=======`
    ngoài/ở trong file không tự bị coi là marker. Lỗi đọc scope giữ task chờ có question, không kẹt effect.
  - Branch/worktree đổi ngoài dự kiến cũng dừng để đối chiếu. Durable intent và chứng nhận đúng
    head/tree/revision giữ an toàn khi retry/restart; không push commit còn marker.
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
cusr-runner setup-harness --config ~/.cusr/config.yaml --harness claude --vendor claude \
  --binary "$(command -v claude)" --toolchain /opt/node/bin --auth claude-0:.claude/.credentials.json \
  --settings claude-settings.json --permission-mode auto --sandbox off --tools Bash,Read,Edit,Write,Glob,Grep \
  --model <model-id> --effort <effort> --max-invocations 9 --approval "<ai duyệt, ngày>" \
  --out evidence-claude.json
```

`setup-harness` dùng cùng code của ba lệnh `write-pin`, `prove-harness`, `record-manifest`.
Config được nạp một lần cho cả luồng. Trước khi ghi pin, lệnh bắt buộc có `--model`, kiểm pin dự kiến
qua `planProof` (deny-probe, identity, khả năng resume) và kiểm tổng usage đã tốn + số lượt cần với cap.
Preflight từ chối thì pin/manifest/ledger hiện có vẫn nguyên vẹn, kể cả khi truyền `--force`.
Các tham số pin/proof giữ nguyên tên; `--out` vừa là file evidence xuất ra vừa là đầu vào cho manifest.
Lượt chạy có proof thật bắt buộc có `--approval` (không rỗng) và `--max-invocations` là số nguyên dương;
giới hạn tính cả usage đã ghi trong ledger cho cùng binary, kể cả lượt thất bại. Pin đã tồn tại cần
`--force` để ghi đè. Bước nào lỗi thì dừng ngay, giữ mã lỗi và nêu tên bước (JSON có `error.details.step`);
proof thất bại không được ghi manifest. Pin hoặc evidence đã ghi trước lỗi vẫn được giữ để gỡ lỗi.

Thêm `--dry-run` để xem `invocations_spent` (đã tốn) và `invocations_needed` (cần thêm), không gọi model
và không ghi pin, evidence, manifest hay ledger. Dry-run kiểm pin dự kiến theo cùng quy tắc `write-pin`,
không cần `--force`, approval hoặc cap để xem kế hoạch. Báo cáo có `pin_exists`: nếu là `true`,
lượt chạy thật bắt đầu từ `write-pin` cần `--force` để thay pin; `--from prove-harness` dùng lại pin nên
không cần cờ này. Các probe version/host vẫn chạy.

Preflight là kiểm tra tại thời điểm lập kế hoạch. Proof thật vẫn đọc lại ledger: nếu một proof khác tiêu
usage sau preflight, proof có thể bị từ chối dù pin đã được ghi. Khi đó chạy tiếp bằng
`--from prove-harness` với cap tổng được duyệt lại, không ghi lại pin. Lệnh không tự tăng cap.

Khi một bước thực thi lỗi, chạy tiếp bằng `--from` để dùng pin/evidence đã ghi:

```sh
# Proof lỗi: dùng pin đã ghi, không cần --vendor/--binary/--force.
# Proof chạy lại đủ các role; cap vẫn tính cả các lượt đã tốn.
cusr-runner setup-harness --from prove-harness --config ~/.cusr/config.yaml --harness claude \
  --model <model-id> --effort <effort> --max-invocations <cap-tổng> --approval "<ai duyệt, ngày>" \
  --out evidence-claude.json
# Chỉ manifest lỗi: kiểm evidence khớp pin hiện tại rồi ghi manifest, không gọi model.
# Không cần --model, --approval, --max-invocations hay --force.
cusr-runner setup-harness --from record-manifest --config ~/.cusr/config.yaml --harness claude \
  --out evidence-claude.json
```

`--from record-manifest --dry-run` kiểm evidence/pin/quyền như khi ghi thật, báo `invocations_needed: 0`
và không ghi manifest. Evidence không đạt hoặc không khớp pin vẫn bị từ chối. Nếu đã có evidence hợp lệ,
`record-manifest --evidence <file>` cũng sửa được manifest mà không tốn model; gợi ý của doctor ưu tiên
cách này. Ba lệnh riêng vẫn được giữ để gỡ lỗi:

```sh
cusr-runner write-pin --config ~/.cusr/config.yaml --harness claude --vendor claude \
  --binary "$(command -v claude)" --toolchain /opt/node/bin --auth claude-0:.claude/.credentials.json \
  --settings claude-settings.json --permission-mode auto --sandbox off --tools Bash,Read,Edit,Write,Glob,Grep
cusr-runner prove-harness --config ~/.cusr/config.yaml --harness claude \
  --model <model-id> --effort <effort> --max-invocations 9 --approval "<ai duyệt, ngày>" \
  --out evidence-claude.json
cusr-runner record-manifest --config ~/.cusr/config.yaml --harness claude --evidence evidence-claude.json
```

Để bật resume cho Claude, thêm `--prove-resume` vào `setup-harness` (hoặc lệnh riêng `prove-harness`).
Probe này cần thêm một invocation ngoài các role `coder`, `fixer`, `reviewer`, `decider` trong `PROOF_ROLES`:
hiện là 5 lượt tổng cộng, thay vì 4 (dry-run hiển thị số cần). Probe thử tiếp tục bằng private home mới
và nhớ lại một nonce chỉ có trong hội thoại trước. Chỉ bằng chứng probe đạt mới ghi `session_resume: proven`;
sau setup thành công, restart daemon. Resume chỉ mang transcript/tool data của đúng session,
không mang auth/settings của attempt cũ. Codex hiện chưa có resume được hỗ trợ; daemon ghi lý do và
sử dụng phiên mới cùng context đầy đủ.

Nếu transcript/run cũ đã mất, worker dùng phiên mới với context đầy đủ và ghi `resume_fallback: session_missing`;
không chờ người vận hành chỉ để khôi phục hội thoại. Evidence của `--prove-resume` có `resume_probe` ghi
outcome và nguyên nhân cụ thể, kể cả khi coder thất bại hoặc không trả session nên probe chưa được chạy.

Mỗi vendor trong evidence phải có `binary.sha256` và `attested` gồm `settings_hash`, `environment_hash`
(env, toolchain, `home_files`, `max_turns`, `tools`), `host_policy_hash`, `layout_shapes` của lượt chứng minh.
Lệnh so từng trường với pin và host hiện tại, lệch là từ chối và in giá trị cần có; đổi bất kỳ trường nào của
pin đều cần chứng minh lại (T126), và pin sửa sau khi ghi sẽ chặn request, attempt kế tiếp. Đổi đường dẫn file
credential thì không cần: bằng chứng không phụ thuộc file nằm ở đâu. Evidence T007 không có `attested` nên không dùng được. `record-manifest` không gọi harness, không tốn usage; bước proof của `setup-harness` có gọi model.

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

Với Codex, `prove-harness` chạy thêm `codex sandbox` trực tiếp, không gọi model, vì `exec --json` không có sự
kiện cho lệnh bị sandbox từ chối. Lệnh `/usr/bin/true` phải chạy được, còn lệnh ghi phải bị hệ điều hành từ chối.

Giữ các rule owner khác khi thêm rule này. Lệnh deny dùng đường dẫn tương đối để kiểm marker ngay trong
worktree thật; rule cũ trỏ `/cusr/scratch` không chứng minh hợp đồng host mới. Probe native chỉ đạt khi log
**tool execution** có lỗi OS từ chối ghi và file đích không xuất hiện; trả lời hợp lệ hoặc rule từ chối tool
không đủ. Worker Claude tắt sandbox ghi `native_result=not_tried`; auto dùng mode `permissions_only`,
full access dùng `full_access`. Worker bật sandbox luôn cần `native_result=passed`, kể cả full access.
Reviewer vẫn chạy probe âm native. Đổi sandbox cũng cần tạo lại proof/manifest; không nhận bằng chứng
của lựa chọn cũ.

`prove-harness` trả mã lỗi và nêu lý do khi bằng chứng chưa đủ tạo manifest dùng được, dù vẫn ghi file evidence
để đọc lại. `record-manifest` từ chối evidence đó bằng đúng phép kiểm daemon dùng khi nạp record.
`cusr-runner check-records --config <file> --data-dir <dir>` kiểm config và mọi harness record với release đang chạy
lệnh, không gọi model; nên chạy bằng release mới trước khi đổi sang nó.

Claude cần `TMPDIR` đủ ngắn cho Unix socket của sandbox (đường dẫn tối đa 108 byte), nên mỗi lượt chạy Claude có thư
mục riêng 0700 `/tmp/cusr-<hash>`, xóa khi lượt kết thúc. Với host có `/tmp` là tmpfs nhỏ, việc ghi file tạm lớn trong
lượt chạy agent sẽ chiếm chỗ ở đó. Setup, gate, autofix và Codex vẫn dùng scratch của mình làm `TMPDIR`.

Sau khi nâng release, chạy `setup-harness --force` với các tham số pin/proof đầy đủ,
`--permission-mode auto` hoặc `full-access`, không cần `--outer-proof`, rồi restart daemon. Manifest cũ chứng minh outer bwrap
không dùng được cho native execution. Task đang đóng băng theo outer bwrap phải kết thúc/hủy ở release
cũ rồi tạo task mới; không đổi snapshot đang chạy. Đổi mode pin cũng cần proof/manifest tương ứng.

Push vẫn do daemon gọi qua credential helper tin cậy. Role/model/workflow và merge giữ cùng hợp đồng.

## Network và credentials

Cuesura chạy trên host và không thêm namespace mạng hay egress firewall. Mạng của lệnh do host và
native harness quyết định. Home/auth của harness vẫn riêng, credential được che trước khi lưu log,
và token điều phối/GitHub không tự được đưa vào environment worker hoặc gate. Process cùng UID có
quyền đọc file host theo OS; worktree và canary sau chạy không là ranh giới bảo mật ngăn truy cập đó.

### Phiên đăng nhập harness

Mỗi attempt nhận bản sao file đăng nhập (`--auth`) trong private home. Harness đăng nhập bằng OAuth
(Claude, Codex) tự refresh phiên khi access token hết hạn và nhà cung cấp thường đổi luôn refresh
token; bản sao bị xóa sau attempt nên trước đây refresh token mới mất theo, file gốc giữ token cũ đã bị
thu hồi, và mọi attempt sau báo `Failed to authenticate: OAuth session expired and could not be
refreshed`. Nay trước khi xóa, daemon ghi bản sao đã refresh về file gốc (ghi file tạm rồi rename,
giữ quyền file) khi đủ cả ba điều kiện: bản sao đã đổi, file gốc vẫn đúng nội dung lúc chép, và bản
sao vẫn là JSON cùng cấu trúc khóa với file gốc. File gốc đã đổi (người dùng vừa đăng nhập lại, hoặc
attempt khác ghi trước) thì giữ file gốc. File `--rule` có sha256 trong pin không bao giờ bị ghi lại.
Worker vẫn đọc được token trong home của nó như trước; việc ghi lại chỉ giữ cho phiên còn dùng được.

Khi harness báo lỗi đăng nhập, task không retry mà chờ `WAITING/policy harness_auth` ở đúng bước.
Đăng nhập lại harness trên host, bằng đúng file mà `runtime.credential_refs` trỏ tới (vd
`~/.claude/.credentials.json`; đăng nhập trong một profile Claude khác không đổi file này), rồi chạy
`cusr task recheck <id>`: bước đó chạy lại, giữ worktree, review và gate, và lượt lỗi đăng nhập được
trả lại visit. Đăng nhập vẫn hỏng thì lượt mới lại chờ `harness_auth`.

Task `loop_exhausted` mà các lượt cuối của bước đều lỗi hạ tầng, rate limit hoặc đăng nhập (vd task
chạy trên release cũ, khi lỗi OAuth còn bị xếp `infra`): sửa nguyên nhân rồi `cusr task recheck <id>`
trả lại visit của chuỗi lượt đó và chạy lại bước. Lượt lỗi chất lượng không bao giờ được trả; ngân sách lượt
agent, deadline và thang model giữ nguyên. `task explain` chỉ đưa `recheck` khi điều kiện này đúng.

`cusr doctor` đọc file đăng nhập chỉ để lấy hạn refresh token (`refreshTokenExpiresAt` của Claude),
không in giá trị token: quá hạn thì `credential:*` báo lỗi. Hạn còn không chứng minh nhà cung cấp còn
chấp nhận phiên (token có thể đã bị thu hồi); file không có trường này (Codex, API key) chỉ được kiểm
tra là tồn tại.
