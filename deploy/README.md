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

Claude có sandbox bật trên Linux vẫn dùng bwrap. Trên host mới,
cài `bubblewrap`/`socat` và kiểm tra bằng user chạy daemon:

```sh
bwrap --unshare-user --ro-bind / / /usr/bin/true
sysctl user.max_user_namespaces kernel.unprivileged_userns_clone kernel.apparmor_restrict_unprivileged_userns
```

Lệnh sysctl chỉ đọc; knob nào không tồn tại phụ thuộc kernel/distro. Nếu userns bị tắt hoặc bwrap lỗi
`setting up uid map: Permission denied`, quản trị viên review hardening và profile hiện có. Không suy
`apparmor_restrict_unprivileged_userns=1` thành bwrap chắc chắn bị chặn: profile đã nạp có thể cho phép nó.
Doctor/preflight chỉ kiểm executable và systemd; không còn probe userns toàn cục hay phát các cause
`userns_*`/`bwrap_*`. `setup-harness` kiểm sandbox Codex thật (không qua model) và từ chối khi nó không chạy.

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
| `--permission-mode auto` | Auto review quyền tool, `native_result=not_tried` | Auto review quyền tool và sandbox native (`failIfUnavailable`), `native_result=not_tried` |
| `--permission-mode full-access` | `bypassPermissions`, không sandbox worker | `bypassPermissions` trong sandbox native (`failIfUnavailable`), `native_result=not_tried` |

Khi sandbox native bật, adapter thêm `sandbox.network.allowAllUnixSockets: true` để worker tạo được socket
`AF_UNIX` (trên Linux sandbox chặn mặc định), nhờ đó chạy được test dùng daemon thật. Khai
`sandbox.network.allowAllUnixSockets: false` trong file settings để giữ chặn. Giá trị này nằm trong settings hash,
nên release đổi nó cần ghi lại manifest (`setup-harness --from record-manifest`).

Deputy chạy cùng ranh giới với fixer, và daemon trả worktree của task về sau mỗi lượt ([Deputy](#autonomous)).
Reviewer chạy như fixer: được sửa file, chạy test và commit, xong daemon trả worktree về đúng trạng
thái trước review. Đây là quyền tool,
không phải tự duyệt run config, review code hoặc merge. Khi đã bật sandbox, lỗi không tự chuyển sang
tắt hoặc full access. Codex không nhận flag `--sandbox` này; chế độ sandbox Codex giữ theo permission mode.

<a id="systemd-and-wsl2"></a>

## systemd và WSL2

Daemon gọi `spawn` cho `systemd-run --user`; runner transient service độc lập, `Restart=no`,
`KillMode=control-group`, không dependency vòng đời vào daemon. Không coi PID1 là systemd là đủ:
doctor kiểm user bus và chạy thử một transient unit tới khi xong rồi thu dọn.

Trên WSL2, `/etc/wsl.conf` cần:

```ini
[boot]
systemd=true
```

Sau thay đổi, người dùng chạy `wsl.exe --shutdown` từ Windows rồi mở distro lại; doctor kiểm runtime
thực tế. Xem [Microsoft WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd).
`systemctl --user is-system-running` có thể `degraded` do unit không liên quan; pass/fail dựa vào
probe unit riêng của Cuesura, không chỉ chuỗi trạng thái này.

Thiếu user bus thì `systemctl --user` và `systemd-run --user` báo `Failed to connect to bus: No such
file or directory`, doctor báo check `systemd_unit` thất bại, dù `user@<uid>.service` vẫn chạy. Chạy
daemon foreground cũng không né được vì runner cần `systemd-run --user`. Cài gói để systemd tự bật
user bus, rồi chạy `wsl.exe --shutdown` từ Windows và mở distro lại:

```sh
sudo apt install -y dbus-user-session
```

### Chạy daemon: foreground hoặc service

Một data dir chỉ có một writer: daemon thứ hai trên cùng thư mục thoát với `store_locked`. Chọn một
trong hai cách, cả hai dùng cùng runner unit `cusr-op-*.service` độc lập với daemon.

Lần chạy đầu: chép [config mẫu](config.example.yaml), sửa phần giữ chỗ (project, model, credential)
rồi chạy daemon. `cusrd` tự tạo data dir mode 0700; không có token hay file secret nào phải tạo trước.
`cusr` chưa thấy daemon (`daemon_unreachable`) thì in lại đúng các bước này kèm data dir nó đã thử.

```sh
(umask 077 && mkdir -p ~/.cusr && cp deploy/config.example.yaml ~/.cusr/config.yaml)
```

`umask 077` giữ data dir ở 0700: daemon từ chối chạy khi group hoặc others vào được thư mục này.

Foreground, dừng bằng Ctrl-C hoặc SIGTERM:

```sh
cusrd --config ~/.cusr/config.yaml --data-dir ~/.cusr
```

`cusr` tìm daemon theo `--data-dir` (đặt trước hoặc sau lệnh), rồi `CUSR_DATA_DIR`, rồi `~/.cusr`.

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
`/usr/bin`. Trên WSL2 cần user manager như mục trên. Trên server headless cần `loginctl enable-linger`
như bảng `cause`. Đường dẫn thực tế (data dir, socket `control.sock`) theo
`--data-dir`/`runtime.data_dir`; socket phải ngắn hơn 108 byte.

`cusr doctor` chỉ đọc: không gọi model, không sudo, không provision. Check nào fail thì exit 1 và in lệnh
sửa để người vận hành tự chạy. Harness chưa có capability manifest thì báo fail, không suy "proven" từ
help/version của binary; manifest có rồi vẫn fail nếu hash sai, thiếu năng lực bắt buộc hoặc binary đã đổi.
Settings, environment và host policy cần pin của vendor nên do preflight và từng attempt kiểm. Unit mẫu đã
qua `systemd-analyze --user verify` (chỉ báo thiếu binary ở `ExecStart` khi chưa cài).

**Lưu giữ:** `cusrd` quét retention lúc khởi động và sau khi có task kết thúc; không có timer riêng hay lệnh
dọn tay. Thư mục run chỉ bị xoá khi task đã kết thúc, `exit.json` hoàn chỉnh, mọi artifact đã được store ghi nhận
và đã qua `runtime.limits.terminal_retention_ms` (mặc định 30 ngày). Log lệnh setup, gate và autofix
(`receipts/<effect>/logs/`) của task đã kết thúc bị xoá sau 14 ngày, tính từ file log mới nhất; giá trị này chưa
cấu hình được. Phần xoá để lại tombstone (digest của run, tên file log), nên `cusr task gate-log` và màn gates báo
log đã hết hạn chứ không báo lỗi. Lượt quét có xoá ghi một dòng `retention: removed … freed … bytes`; lỗi xoá ghi
`retention warning` và lượt sau làm lại. Retention không ghi store. Worktree không bị xoá chỉ vì cũ: diff hoặc
commit chưa có trên remote thì giữ lại.

**Recovery:** khi quét process sau restart, một process cùng user không đọc được `environ` (`ssh`, `sudo`) và bắt đầu từ lúc operation chạy
sẽ giữ claim và chặn việc mới cho tới khi process đó kết thúc; daemon tự thử lại mỗi giây.

**Hạn chế hiện tại:** `cusrd` chạy task thật tới PR khi harness có bản ghi hợp lệ (mục [Harness thật](#harness-thật-pin-và-manifest)
bên dưới); thiếu bản ghi thì task dừng ở PENDING `capability_missing`. Còn hở: task có attachment `content_ref`
fail ở freeze vì chưa có nguồn nội dung (`cusr add` luôn tạo task không attachment); `lint` là gate tùy chọn của `software_dev` nên đỏ vẫn publish.

### Restart riêng `cusrd` khi agent đang chạy

Khi chỉ restart `cusrd` (ví dụ `systemctl --user restart cusrd.service`), agent tiếp tục chạy trong
runner unit riêng. Daemon mới mở lại cùng data dir, đối chiếu runner còn sống và nhận lại đúng attempt
đang chạy, không khởi chạy agent lần hai. Nếu runner đã ghi `exit.json` hợp lệ trong lúc daemon dừng,
daemon dùng bản ghi đó để đối chiếu kết quả của attempt. Runner vẫn áp dụng thời hạn của lượt khi
daemon dừng.

Dừng runner unit, tắt hoặc reboot host, chạy `wsl.exe --shutdown` hoặc logout làm user manager dừng
đều có thể kết thúc agent. Khi xác nhận runner đã mất mà thiếu `exit.json`, recovery ghi `lost` và
đối chiếu lượt cũ trước khi engine quyết định bước tiếp theo. Nếu chưa xác định được trạng thái runner,
daemon giữ claim và chờ đối chiếu. Nếu chứng minh được agent chưa từng khởi chạy, recovery ghi
`not_launched` và trả reservation để engine có thể cấp lượt mới.

Gate và các lệnh Git, GitHub đang chạy trong daemon không có runner riêng. Recovery dừng tiến trình
còn sót, ghi operation là `lost` và đối chiếu effect để quyết định bước tiếp theo.

[Test runner adoption](../test/integration/runtime/runner-adoption.test.ts) restart một tiến trình
thay daemon trên systemd user, dùng harness giả và kiểm tra cùng attempt ID, invocation ID, cây tiến
trình và đúng một lần khởi chạy. [Test smoke runner restart](../test/smoke/runner-restart.test.ts)
dùng tiến trình daemon thật với harness giả để kiểm tra attempt ban đầu chạy đến khi hoàn tất sau
`SIGTERM` hoặc `SIGKILL`.

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

## Giao diện terminal qua SSH

Mở bằng `cusr` không kèm lệnh trong terminal tương tác của cùng user với daemon (SSH, tmux, WSL2 đều được); giao diện
đọc cùng socket điều khiển và cùng `CUSR_DATA_DIR`/`--data-dir` như các lệnh khác.

- **Thoát và tín hiệu.** Ctrl-C, `SIGTERM`, `SIGHUP` và lỗi nội bộ đều trả terminal về trạng thái ban đầu. Ctrl-C không hủy task.
- **Đứt SSH.** Khi không còn terminal, giao diện không in được gì và không ghi payload ra file. Thao tác chưa rõ kết quả
  phải đối chiếu bằng `cusr task list`, `cusr task history ID` hoặc `cusr request show REQUEST_ID`. Task đang chạy không bị ảnh hưởng.
  Chạy trong `tmux` để phiên sống qua đứt SSH.
- **Thoát thường mà còn thao tác chưa rõ.** Giao diện in request ID và lệnh `cusr request show` tương ứng ra stderr rồi thoát với exit 3.
- **Sau `SIGKILL`.** Không bắt được tín hiệu này nên terminal có thể còn ở alternate screen hoặc raw mode, không hiện con trỏ
  hay phím gõ. Chạy `reset` (hoặc `stty sane; tput rmcup; tput cnorm`) để khôi phục.

## Người gọi và quyền

Chỉ process cùng UID với daemon mở được socket điều khiển: data dir phải 0700 và thuộc đúng user, socket
`control.sock` là 0600; sai thì daemon từ chối chạy. Không có token hay file secret nào phải tạo.

Người gọi tự khai mình là ai qua biến môi trường `CUSR_ACTOR`:

| `CUSR_ACTOR` | Actor | Quyền |
| --- | --- | --- |
| không đặt hoặc `owner` | `owner` | `read`, `operate`, `admin` |
| `assistant` | `assistant` | `read`, `operate` |

Giá trị khác bị CLI từ chối ngay (exit 2, `actor_invalid`). Actor/role ghi trong body request không có tác
dụng; kiểm quyền chạy trước kiểm schema nên caller khai `actor: owner` trong body vẫn exit 5. Mọi lệnh được
ghi kèm actor, nên lịch sử cho biết owner hay assistant đã xác nhận, hủy hay approve.

Phiên deputy không dùng `CUSR_ACTOR`: runner đặt `CUSR_DEPUTY_TURN` và actor là `deputy` với quyền `read`,
`operate` trong bảng quyền của deputy, chỉ khi lượt đó đang chạy ([Deputy](#autonomous)).

**Assistant.** Skill `cusr` đặt `CUSR_ACTOR=assistant` cho mọi lệnh. Assistant được thêm task, đề xuất và
xác nhận run config, trả lời câu hỏi, duyệt escalation, recheck và hủy; không duyệt nhận PR có sẵn và không
dùng quyền admin. Lệnh ghi lên goal (`cusr goal add/revise/note/propose/amend/confirm/cancel`) còn cần phiên đang giữ
khóa assistant ([Goal](#goal)); thiếu thì `forbidden` với `lease_required`.

**Ranh giới.** `CUSR_ACTOR` là rào chắn cho caller làm đúng quy ước, không phải ranh giới bảo mật: process
cùng UID bỏ biến này là thành owner. Muốn tách quyền thật, chạy assistant bằng UID khác. Worker
coder/fixer/reviewer không gọi `cusr`; environment của worker không kế thừa biến `CUSR_*` của daemon. `cusr`
từ chối chạy (`worker_refused`, exit 5) khi thấy `CUSR_ATTEMPT_ID` hoặc `CUSR_OPERATION_ID`, hai tag daemon gắn
cho lượt harness và cho gate/setup; hook `assistant session-start`/`assistant hook` thì thoát 0 im lặng. Đây
cũng chỉ là rào chắn theo quy ước như `CUSR_ACTOR`. Worker dùng
`gh` bằng đăng nhập của owner ([Network và credentials](#network-và-credentials)). Không còn outer
boundary chặn process cùng UID đọc file host.

**Nâng cấp từ bản có token.** `runtime.access_tokens` trong user config không còn tác dụng; daemon vẫn
khởi động và ghi một dòng log báo khóa này bị bỏ qua. Xóa khóa đó, file token của assistant và
`DATA_DIR/owner.token` khi tiện; thay `CUSR_TOKEN_FILE` bằng `CUSR_ACTOR=assistant` ở chỗ cấu hình
assistant.

### Đánh thức assistant bằng Stop hook

Sau mỗi lượt, `cusr assistant hook` đậu ở nền, hỏi daemon không tốn lượt model và giao tin khi có task cần người
hoặc có task kết thúc.
Phiên vẫn rảnh trong lúc hook đậu nên người dùng hỏi được bình thường. Chỉ cách giao tin khác nhau:

| Harness | Cách chạy nền | Cách giao tin | ID phiên khi `register` | Bản đã kiểm chứng |
| --- | --- | --- | --- | --- |
| Claude Code | Hook `Stop` có `asyncRewake` | Exit 2; stderr thành phản hồi của hook và mở lượt mới | `CLAUDE_CODE_SESSION_ID` | 2.1.319 |
| Codex | Hook `Stop` có `async` | `codex queue --thread` bằng binary của phiên, vì hook async không tự đánh thức được | `CODEX_THREAD_ID` | 0.166.0 |
| pi | Extension giữ process con | Extension gửi bằng `pi.sendUserMessage` khi phiên rảnh và thử lại tới khi thấy tin vào phiên | `PI_SESSION_ID` | 1.5.0 |

Chạy trong repo mà assistant làm việc, data dir theo nơi cài:

```sh
cusr init --data-dir "$HOME/cuesura-dogfood/data"
```

Mục `assistant` cài skill `cusr` và gộp hai hook vào `.claude/settings.local.json` của repo bằng đường dẫn tuyệt đối,
giữ nguyên mọi khóa và hook khác; chạy lại không thêm trùng, đổi data dir thì cập nhật đúng hook đó. File này chứa
đường dẫn trên máy nên không được commit: `init` giấu nó bằng `info/exclude` trong git common dir để mọi worktree
cùng dùng, và dừng với lỗi nếu file đã được track, JSON hỏng hoặc sai kiểu. Commit các file skill.

Khi `codex` hoặc `pi` có trên PATH, `init` cài thêm theo cùng cách `.codex/hooks.json` và
`.pi/extensions/cusr-assistant.ts`. Hai file này cũng ở cấp repo, được giấu và không commit:

- Cài cấp người dùng sẽ gắn data dir của repo này vào mọi repo khác, nên `init` không dùng `~/.codex` hay `~/.pi`.
- File bị ignore không vào worktree sạch của worker, nên worker không thấy hook. `session-start` cũng tự thoát khi
  chạy trong worker.
- Repo đã commit một trong hai file, hoặc `.gitignore` bỏ ignore nó, thì `init` bỏ qua harness đó và báo `skipped`;
  harness đó tiếp tục dùng `cusr assistant wait`. `.pi/extensions/cusr-assistant.ts` không do `cusr` viết cũng được giữ nguyên.
- JSON hỏng trong `.codex/hooks.json` dừng `init` trước khi ghi, như với Claude Code.
- Codex chỉ nạp hook của thư mục đã trust và hỏi "Hooks need review" lần đầu cũng như khi hook đổi. pi hỏi trust
  project lần đầu. Phải đồng ý thì hook mới chạy.

**Codex và sandbox.** Sandbox `workspace-write` chặn `connect()` tới socket của daemon, nên mọi lệnh `cusr` do agent
chạy đều báo `daemon_unreachable` với `EPERM`; hook chạy ngoài sandbox nên không bị. Agent cần được duyệt chạy `cusr`
ngoài sandbox, hoặc bật `network_access` trong `[sandbox_workspace_write]` của Codex. Lựa chọn thứ hai mở mạng cho
mọi lệnh của agent, nên cân nhắc trước khi bật.

Đoạn `init` ghi vào file, để tham khảo:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "CUSR_DATA_DIR=$HOME/cuesura-dogfood/data CUSR_ACTOR=assistant cusr assistant session-start",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "CUSR_DATA_DIR=$HOME/cuesura-dogfood/data CUSR_ACTOR=assistant cusr assistant hook",
            "asyncRewake": true,
            "timeout": 604800
          }
        ]
      }
    ]
  }
}
```

Khóa chỉ đổi khi người dùng bảo agent lấy. Phiên mở ra mà có task đang chờ thì `session-start` nhắc agent hỏi
người dùng, trừ khi phiên giữ khóa đã hỏi daemon trong 10 giây gần nhất và đã được gửi hết các task đó; lời nhắc
chỉ nằm trong context, không mở lượt. Phiên đã đăng ký mà đang chạy một lượt dài (hook chưa đậu lại) thì phiên mới
vẫn được nhắc, vì từ daemon không phân biệt được với phiên đã chết.
Người dùng đồng ý thì agent chạy `cusr assistant register --take`. Output của lệnh này liệt kê việc đang chờ
(`items`) như một lần đánh thức; Stop hook đầu tiên xác nhận chúng thay vì đánh thức lại, rồi đậu và chỉ báo tin
mới. Thư mục hiện tại không có Stop hook thì output có `warnings`. Phiên khác thoát ngay, không gọi daemon. Đăng
ký nằm ở `DATA_DIR/assistant-session.json` nên còn nguyên sau restart daemon.

- Phiên khác lấy khóa (`register --take`, hoặc `assistant wait` sau khi hook im quá 10 giây) thì hook của phiên cũ
  đánh thức nó một lần với dòng `cusr:` báo khóa đã chuyển, kể cả khi lúc đó không có hook nào đậu: daemon giữ danh
  sách phiên bị thay chưa được báo trong `assistant-session.json` (chỉ daemon ghi file này), và Stop kế tiếp của phiên
  đó báo rồi xác nhận với daemon. Daemon chưa nhận xác nhận (đang chết) thì hook ghi nhớ đã báo ở file riêng của
  phiên và các Stop sau chỉ thử xác nhận lại, không đánh thức nữa. `codex queue` lỗi thì hook tiếp tục đậu và thử lại, giãn dần từ 30 giây tới 5 phút.
  Lấy khóa cần quyền `operate`.
- Daemon không trả lời liên tục 5 phút thì hook đánh thức phiên một lần với data dir và gợi ý `cusr status`; chỉ báo
  lại khi daemon đã về rồi mất lần nữa. `codex queue` lỗi thì hook vẫn đậu và thử lại theo cùng nhịp giãn, tới khi
  tin tới hoặc daemon về. Restart ngắn không đánh thức ai. `assistant wait` trả `daemon_unreachable`
  sau cùng ngưỡng đó.
- Lỗi cú pháp trên đường hook (`assistant hook`, `assistant session-start`, lệnh con sai) thoát 1, không phải 2, để
  lệnh hook hỏng không đánh thức phiên ở mọi Stop.

- Chỉ tin thật mới đánh thức phiên. Hết `--timeout` (mặc định 604500 giây, thấp hơn `timeout` của hook) hook thoát
  im lặng; lượt kế tiếp kết thúc bằng một Stop và hook đậu lại, việc chưa báo vẫn còn ở daemon.
- Đóng terminal là kết thúc phiên: hook chết theo và không gửi gì. Mở lại phiên thì đăng ký vẫn còn, tin tới sau
  lượt đầu tiên. Trên Codex và pi, hook tự theo dõi process của harness vì đóng terminal hoặc `kill -9` không kéo nó
  theo. `codex queue` cũng trả exit 0 với phiên đã đóng, nên hook phải tự kiểm tra trước khi gửi.
- Tin chỉ được xác nhận khi đã tới: `codex queue` thành công, hoặc pi hiện tin trong phiên. Trong lúc giao, hook của
  lượt vừa kết thúc chờ kết quả. Giao thất bại thì daemon gửi lại ở lần `Stop` sau; pi đang compact thì tin chờ tới khi
  phiên rảnh. Tin đã vào hàng đợi Codex mà phiên tắt trước khi nhận thì tới lúc resume.
- `/new` đổi ID phiên. Phiên đã đăng ký thôi nhận tin, tin còn nguyên ở daemon và phiên mới được nhắc hỏi khóa; khóa
  không tự chuyển. Ngoại lệ là `codex app-server` (Codex app, extension IDE, Paseo): một process chứa nhiều thread,
  nên thread mới mở không làm thread đã đăng ký thôi nhận tin. `/resume` về phiên cũ thì nhận tin lại. Codex chỉ báo phiên mới ở prompt đầu tiên, nên tin tới
  giữa `/new` và prompt đó vẫn chạy thành lượt của phiên cũ mà người dùng không thấy.
- `register` lấy biến đầu tiên có giá trị theo thứ tự pi, Codex, Claude Code; harness chạy lồng trong harness khác
  thì truyền `--session`.
- `codex exec` thoát sau khi xong nên không nhận tin; hook không ở lại.
- Hook Codex tìm `cusr` theo PATH của login shell. `cusr` ở đó cũ hơn bản đã chạy `init` thì hook báo lỗi `--harness`
  và không đậu, trong khi `session-start` vẫn chạy nên phiên trông như bình thường.
- Tin chỉ có ID task và mã trạng thái: nội dung câu hỏi do worker viết, nên assistant đọc bằng `cusr inbox`.
- Task chuyển sang DONE, FAILED hoặc CANCELLED sau khi phiên giữ khóa cũng là tin, với mã `done`, `failed`,
  `cancelled` trong `items`, cùng cách gửi lại tới khi được xác nhận (issue #257). Mốc đã xác nhận (`ended_after`)
  nằm trong `assistant-session.json`, nên tin chưa xác nhận còn nguyên qua restart daemon và khi khóa chuyển sang
  phiên khác. Mốc bắt đầu ở lần đầu có phiên giữ khóa và bỏ khi `assistant unregister` xong mà không còn phiên
  nào giữ khóa (phiên đang `assistant wait` thì giữ mốc); task kết thúc trước đó không được báo. `attention_peek` và hook SessionStart chỉ đếm task cần người.
- `asyncRewake` không có trong tài liệu `--help` của Claude Code. Đã kiểm trên 2.1.319; bản khác có thể đổi.
- Harness khác dùng `cusr assistant wait`. Lệnh này chờ tới khi có tin và không còn tự trả về sau 1 giờ. Nó thoát khi
  process harness gần nhất (`claude`, `codex` hoặc `pi`) hoặc process do `--owner-pid` chỉ định kết thúc, để khóa hết
  hạn cho phiên sau; shell chạy lệnh nền kết thúc trước thì không sao. Không tìm thấy harness và không có
  `--owner-pid` thì lệnh chờ mãi; khi đó dùng `--timeout`.

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
`--no-session-persistence`; resume trừ khi manifest ghi `resume: unsupported`. Từ vòng review thứ hai, reviewer
resume phiên reviewer của vòng trước (cùng revision, step và binding) với packet dựng mới. Phiên reviewer
không bao giờ trao cho coder/fixer và ngược lại; revision mới hoặc đổi binding thì mở phiên mới.

Các policy/runtime snapshot của task đã chạy giữ nguyên giới hạn đã đóng băng. Sau khi nâng release,
xóa các trần trong user config và tạo lại pin/manifest theo mục bên dưới để task mới dùng cấu hình
không giới hạn; không sửa tay snapshot hoặc manifest của task cũ.

<a id="autonomous"></a>

## Deputy và autonomous

Deputy là agent làm thay bạn khi task kẹt ở chỗ cần phán đoán (hết lượt thử ở mọi nấc, vòng review/sửa không tiến
triển, hết hạn, lỗi chưa phân loại…) và khi một goal cần lập hay sửa kế hoạch ([Goal](#goal)). Nó thay hẳn decider cũ.
Deputy bật khi user config có role `deputy`; cờ `autonomous` chỉ quyết định thêm câu hỏi của worker có tới deputy hay
không. Cả hai không bật được qua `cusr.yaml` và được đọc lại mỗi vòng, không cần restart. Deputy không merge và không
bật yolo; yolo không trả lời câu hỏi.

```yaml
autonomous: true # câu hỏi của worker tới deputy; bỏ hoặc false thì tới bạn
roles:
  deputy:
    binding:
      - { model: opus, effort: high }
    limits:
      max_turns: null # chỉ Claude, như mọi role
      stall_timeout: 10m # không có mặc định: bỏ khóa thì phiên treo không được phát hiện
      wall_timeout: null # mặc định không có trần thời gian cho một lượt
      infra_retries: null # mặc định retry lỗi hạ tầng không trần, theo backoff `infra` của task
      context_bytes: 16384 # ngân sách context do code dựng (mặc định 16384 byte)
```

- Lượt dùng binding đầu tiên của role; `prompt` và `context` của role không được dùng vì văn bản vai trò cố định trong
  code. `infra_retries` và `context_bytes` chỉ có tác dụng ở role `deputy`.
- `autonomous: true` mà không có role `deputy` (hay `decider`) thì config bị từ chối.
- Role `decider` cũ được đọc như `deputy`; daemon ghi log `role 'decider' is read as 'deputy'` một lần và
  `cusr doctor` cũng báo. Đổi tên khi tiện.
- Manifest của harness chạy deputy phải có role `deputy`; các bước ở [Bật deputy](#bat-deputy).
- Phiên tương tác cần `runtime.terminal.backend` khác `background` ([Xem agent trong herdr](#xem-agent-trong-herdr)).

<a id="bat-deputy"></a>

**Bật deputy.** Manifest ghi trước khi có role `deputy` chỉ cần ghi lại, không gọi model:

1. Thêm `roles.deputy` (và `autonomous` nếu muốn) vào user config như trên. Model trong binding phải trỏ tới
   harness đã có pin.
2. Ghi lại manifest từ pin đang có, với `--config` và `--data-dir` của `cusrd` đang chạy (bỏ `--data-dir` thì
   lệnh dùng `runtime.data_dir` hoặc `~/.cusr`, có thể là một bản cài khác). `cusr doctor` in sẵn lệnh này
   với đường dẫn thật.

   ```sh
   cusr-runner setup-harness --from record-manifest --config ~/.cusr/config.yaml \
     --data-dir <DATA_DIR> --harness claude
   ```

3. Restart `cusrd` khi không còn task chạy (`systemctl --user restart cusrd.service`): daemon chỉ đọc manifest
   lúc khởi động.
4. Kiểm tra bằng `cusr doctor`: check `deputy` phải là `ok` và nêu model, harness; manifest trên đĩa mới hơn
   manifest daemon đang giữ thì nó nhắc restart. `cusr-runner check-records --config ~/.cusr/config.yaml
   --data-dir <DATA_DIR>` kiểm cùng store đó mà không cần daemon.

**Định tuyến.** Mỗi mã wait có đúng một nơi đến, theo bảng trong code (`src/engine/deputy-routing.ts`):

| Nơi đến | Mã wait |
| --- | --- |
| Tự tiếp tục, không báo ai | `dependency_pending`, `checks_incomplete`, `effect_unknown`, `infra_backoff`, `rate_limited`, `execution_slot`, `merge_cleanup_pending`, `observation_unknown`, `cancel_reconcile` |
| Bạn | Mọi mã PENDING trừ `dependency_pending`; `run_config_unconfirmed`, `paused`, `escalation_rejected`, `adopt_approval`, `merge`, `auth_config`, `harness_auth`, `refused`, `plan_amendment`; `effect_failed` do vi phạm ranh giới; `cancel_reconcile` đọc mãi không xong |
| Deputy khi `autonomous: true`, bạn khi tắt | `agent_question`, `agent_needs_context`, `agent_blocked` |
| Deputy | Mọi mã còn lại, và `effect_unknown` quá ngưỡng |

Không khai role `deputy`: wait cạn trần `ladder_exhausted`/`rung_denied` được daemon kết thúc bằng `task fail`
(actor `system:deputy-absent`, lý do `ladder_exhausted:<step>` hay `rung_denied:<step>:<nấc>`), mọi sự cố khác tới bạn
như trước. Bật cờ `autonomous` khi câu hỏi đang chờ bạn thì câu đó được định tuyến lại cho deputy.

**Lượt.** Mỗi sự cố mở một lượt: phiên harness mới, cwd là data dir, context do code dựng (vai trò; yêu cầu, chỉ thị và
kế hoạch của goal; lịch sử, tín hiệu vòng lặp, bảng thử và bàn giao trước của task; trạng thái các đơn vị khác và xung
đột nhánh; sự cố và lệnh khả dụng). Phiên đọc thêm log, diff và tài liệu khi cần, hành động bằng `cusr`, rồi kết thúc
bằng `cusr deputy handoff`. Không có process deputy nào giữa các lượt ([ADR-0012](../docs/adr/0012-deputy-short-turns.md)).

- Có terminal backend thì lần chạy đầu là phiên tương tác trong cửa sổ `deputy: <tiêu đề task>` (lượt kế hoạch:
  `deputy: plan <tóm tắt>`); bạn xem và gõ vào được. Hook `Stop` do Cuesura cài báo hết lượt, runner dừng phiên sau
  một khoảng ngắn. Không có tín hiệu trong `stall_timeout` thì phiên bị dừng và lượt chạy tiếp headless trên cùng phiên; không
  khai `stall_timeout` thì không có phát hiện treo, vì vậy hãy khai nó khi dùng terminal backend. Không có
  backend thì headless ngay từ đầu.
- Mỗi task tối đa một lượt cùng lúc, mỗi goal tối đa một lượt kế hoạch; lượt của các task khác nhau chạy song song và
  không làm chậm dispatch của task nào khác.
- Lỗi của lượt không tính vào lượt agent, trần hay ngân sách nào của task: hạn mức hay quá tải thì chờ tới lúc reset hoặc theo backoff; auth,
  refusal, thiếu capability hay harness thì sự cố tới bạn ngay; lỗi hạ tầng thì retry cùng lượt theo backoff `infra`
  của task, có trần khi khai `infra_retries`.
- Lượt kết thúc mà task vẫn ở đúng sự cố đó (hoặc bàn giao `handover`) thì sự cố tới bạn kèm bàn giao và tin nhắn
  cuối. Lượt không có bàn giao được ghi `aborted` kèm danh sách lệnh nó đã chạy. Inbox đánh dấu `deputy: true` cho câu
  hỏi deputy đang giữ và `handed_off` cho sự cố đã chuyển; bạn vẫn trả lời được ngay.
- Daemon restart giữa lượt nhận lại lượt đó, không mở lượt thứ hai; task đã rời sự cố thì lượt được đóng.

**Quyền.** Runner đặt `CUSR_DEPUTY_TURN=<turn_id>` cho phiên; `cusr` trong phiên chạy với actor `deputy`, bỏ qua
`CUSR_ACTOR`, và `cusr assistant hook|session-start|register|wait` thoát 0 không làm gì. Daemon chỉ nhận lệnh của deputy
khi ID lượt đang chạy, task hay goal đích thuộc goal của lượt, và lệnh nằm trong bảng quyền: trả lời câu hỏi,
`continue`, `recheck`, duyệt escalation, `amend-policy`, `message`, `pause`/`resume`, `task fail`, `task waive`,
`goal propose`/`amend`/`note`, `deputy handoff` và mọi lệnh đọc. Ngoài bảng (`task confirm`, `goal confirm`, hủy, adopt,
admin) là `forbidden`. Mọi lệnh ghi của deputy phải có `--reason`; lệnh gia hạn (`continue`, `amend-policy`, `message`,
`task waive`, duyệt escalation) còn phải có `--hypothesis` và `--expect`. Lệnh của bạn và assistant không bao giờ bị từ
chối vì một lượt bắt đầu hay kết thúc; lệnh cũ của deputy bị từ chối theo version.

**Chống lặp.** Không có trần số lượt deputy, nhưng daemon tính chữ ký lỗi của mỗi sự cố và ghi mỗi lệnh gia hạn vào bảng
thử theo đơn vị:

1. Cùng hành động, cùng tham số trên cùng chữ ký lỗi bị từ chối `repeat_without_evidence` khi chưa có bằng chứng mới
   (tiến triển đo được, chỉ thị mới của bạn, hay kế hoạch mới bạn đã xác nhận chạm đơn vị đó).
2. Mỗi loại hành động tự cạn: đổi model chỉ tới model chưa thử trên chữ ký đó và nằm trong `allow_models` của profile;
   nới giới hạn và `message` lần sau cần bằng chứng mới; mỗi finding, gate hay check chỉ được miễn một lần.
3. Mọi loại đã cạn thì chỉ còn `task fail` hay bàn giao `handover`. Lượt kết thúc trên chữ ký đã cạn mà không chọn thì
   daemon kết thúc task (actor `system:loop-guard`, PR draft nếu có việc chưa publish).

**Bản miễn.** `task waive --finding <khóa> | --gate <tên> | --check <tên> --evidence <text|@file>` cho một finding review,
một gate hay một check CI không chặn bước tiếp, chỉ cho đúng chữ ký đã miễn: lỗi khác chặn lại như thường. Bản miễn
được liệt kê trong mô tả PR (daemon cập nhật thân PR và chỉ merge khi thân đã có nó), `report`, `goal show` và chi tiết
task, luôn ghi là `waived` (miễn), không phải đạt. Check của PR vào protected branch không miễn được.

**Worktree.** Deputy chạy cùng ranh giới với fixer theo permission mode của pin. Trước lượt có worktree, daemon ghi bền
mốc (HEAD và cây checkpoint); sau lượt, kể cả sau restart, worktree về đúng mốc như sau review. Trong lúc đó daemon không
chạy việc nào ghi vào worktree của chính task đó; lệnh như `continue` có hiệu lực sau khi trả về xong. Với Claude, cấu
hình phiên cấm `Edit`/`Write` trên `<data dir>/worktrees/**`; Codex không có luật theo đường dẫn nên chỉ có chỉ dẫn vai
trò. Muốn đổi code, deputy giao việc cho worker bằng `message` hay `continue`.

**Ghi lại và xem lại.** Mọi quyết định (lệnh, lý do, giả thuyết, tiêu chí, kết quả đo, sự cố, bàn giao) dựng bằng code
từ command ledger, event và bản ghi lượt, hiện ở `cusr report` (`deputy_decisions`, `waivers`, `goals`), `goal show`,
`task show`/`explain`/`history` và `<data dir>/decisions.md`. Daemon dựng lại `decisions.md` khi dữ liệu đổi, qua
redactor; không sửa tay. Mô tả PR của task có mục quyết định của deputy và giả định deputy đã trả lời, dựng lại mỗi lần
publish. Deputy không hoàn tác được gì: lật lại nghĩa là bạn thao tác tiếp, revert hoặc tạo task mới.

**Nâng cấp từ decider.** Lần khởi động đầu, daemon đóng mỗi lượt decider còn dở bằng `decider_ran` lỗi `superseded`
khi chứng minh được nó đã dừng; không chứng minh được thì task đó chưa có lượt deputy và daemon thử lại mỗi vòng. Câu
trả lời `agent:decider` cũ vẫn hiện trong `decisions.md` và `report`. Quy tắc một câu trả lời mỗi step và nhãn `grill`
không còn.

## Goal

Goal là đơn vị giao việc: một yêu cầu nguyên văn, deputy lập kế hoạch, bạn duyệt một lần theo hash.
`cusr task add` vẫn chạy như trước; task của nó được coi là goal ẩn một đơn vị.

```sh
cusr goal add --project acme --base main --file request.md --json   # goal ở planning, lượt kế hoạch bắt đầu
cusr goal show <id> --json                                            # kế hoạch, nhóm song song, version, hash
cusr goal confirm <id> --expected-version <v> --plan-hash sha256:… --json
```

- Kế hoạch gồm tóm tắt, phạm vi, điều không làm và các đơn vị (khóa, tiêu đề, mô tả, chỉ dẫn, tiêu chí nghiệm thu,
  scope, phụ thuộc theo khóa, run config); hợp đồng ở [contracts/goal.md](../specs/007-deputy/contracts/goal.md).
  Xác nhận là xác nhận intake và run config của mọi đơn vị.
- Không khai role `deputy`: `goal add` vẫn nhận, goal chờ một kế hoạch gửi bằng `cusr goal propose`.
- Sau xác nhận, deputy được tự áp sửa thực thi (thứ tự, phụ thuộc, run config, chỉ dẫn, scope trong phạm vi goal, thay
  đơn vị FAILED chưa cạn lỗi) bằng `goal amend`. Sửa phạm vi (thêm/bỏ đơn vị, tiêu đề, mô tả, tiêu chí, mục tiêu, nới
  phạm vi) chờ bạn `goal confirm` bản sửa; đơn vị bị chạm dừng ở wait `plan_amendment`.
- Đơn vị FAILED đưa goal vào `replan`: lượt kế hoạch sửa thực thi, gửi sửa phạm vi, hay chuyển cho bạn. Đơn vị phụ
  thuộc chờ (`dependency_pending` có `detail.replan`), không bị hủy dây chuyền; đơn vị độc lập chạy tiếp.
- `goal revise` đổi yêu cầu và lập lại kế hoạch; `goal note` ghi chỉ thị cho deputy; `goal cancel` hủy mọi task chưa
  kết thúc của goal (nhánh goal và PR đã merge được giữ).

**Nhánh goal** ([ADR-0013](../docs/adr/0013-goal-integration-branch.md)). Goal từ hai đơn vị có nhánh
`goal/<8 ký tự đầu id>-<slug>` tạo từ đỉnh nhánh gốc. Mỗi đơn vị mở PR vào nhánh goal; khi gate, review theo chế độ,
required check và bản miễn đều đạt và head chứa đỉnh nhánh goal, daemon merge PR bằng merge commit (approver
`policy:goal`), không cần yolo và không chờ bạn. Mỗi nhánh goal có tối đa một merge đang bay; đơn vị tụt sau nhánh goal
được cập nhật base như PR chờ merge. Khi mọi đơn vị DONE, task tổng (workflow `goal_final`, không có bước code) chạy
gate, review toàn bộ diff của goal, CI và mở PR của goal vào nhánh gốc. PR đó merge như mọi PR vào nhánh gốc: bạn merge,
hoặc yolo nếu bạn bật.

- Goal nhiều đơn vị cần `ci.required_checks` khai trong `cusr.yaml` của nhánh gốc (check bắt buộc chỉ khai trên GitHub
  không tính); không có thì kế hoạch bị từ chối `no_required_checks`. `cusr doctor --project` báo check
  `required_checks:<project>`. Tên nhánh goal không được khớp `protected_branches`.
- CI của repo phải chạy cho PR vào nhánh `goal/*`; workflow lọc `pull_request.branches` làm đơn vị đứng ở bước CI.
- Nhánh goal chỉ daemon ghi. Push tay hay merge tay PR đơn vị trên GitHub làm đỉnh lệch khỏi các merge commit daemon đã
  ghi: daemon không merge tiếp và goal vào `replan` với `goal_branch_drift`.

**Assistant và lease.** Mọi phiên đọc được `goal list`, `goal show`, `task show/explain/history`, `report`. Lệnh ghi lên
goal từ assistant (`goal add/revise/note/propose/amend/confirm/cancel`) phải đến từ phiên đang giữ khóa assistant (đăng
ký bằng `cusr assistant register --take`); không thì `forbidden` với `lease_required`. Bạn gọi trực tiếp không cần
lease. Tin của goal (`goal_needs_plan`, `goal_plan_awaiting_confirm`, `goal_amendment_pending`, `goal_pr_ready`) đi qua
attention tới phiên giữ lease, dồn lại khi chưa có phiên nào.

## Auto-confirm intake

Task do assistant tạo mặc định chờ `cusr task confirm` ở bước intake. Liệt kê requester được nhận task
ngay trong user config (không khai được trong `cusr.yaml`):

```yaml
intake:
  auto_confirm: [assistant]
```

Tên là `requested_by.id` của task (`assistant` với token assistant). Daemon đọc lại config mỗi lần tạo task,
không cần restart; task đã tạo không đổi. Task được nhận ngay mang `intake_auto_confirmed: true` trong
event `TaskCreated`. Khóa này chỉ bỏ bước intake: bộ lựa chọn chạy (mode, harness/model/effort, reviewer)
vẫn phải được xác nhận trước lần spawn đầu.

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
- Trước merge, daemon tự yêu cầu check ghim app đạt từ đúng `app_id`; không tin rằng GitHub
  sẽ chặn hộ, vì admin có thể bypass nếu protection không áp dụng cho admin.
- Khuyến nghị khai `ci.required_checks`. Nếu hợp danh sách rỗng, task vẫn vào chờ merge như cũ;
  yolo không merge và log một lần mỗi task trong vòng đời daemon, hướng dẫn khai danh sách này.
  Không dùng mọi check đang thấy trên head làm fallback vì workflow khác có thể chưa kịp tạo check.
  Check bắt buộc đạt khi kết luận là `success`, `skipped` hoặc `neutral`, giống branch protection của
  GitHub; nhờ vậy workflow cố ý bỏ qua job bắt buộc (vd PR chỉ sửa tài liệu) không làm task chờ tới
  `ci_wait_exhausted`. `cancelled`, `timed_out`, `failure`, `action_required`, `startup_failure` và
  `stale` không đạt; check đang chạy hoặc chưa có thì vẫn chờ. Khác GitHub, `skipped`/`neutral` chỉ đạt
  khi không check hiện hành nào của cùng head, kể cả check không bắt buộc, thất bại hay bị hủy: job bị
  skip vì job nó `needs` thất bại cũng là `skipped`, và không được để code chưa build/test lọt qua.
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
quyền thật ([người gọi và quyền](#người-gọi-và-quyền)).

## Harness thật: pin và manifest

`cusrd` chỉ gọi một harness khi có đủ pin và manifest của owner trong `<DATA_DIR>/harnesses/<tên harness>/record.json`.
Hai phần nằm chung một file, thay bằng một lần rename, nên người đọc (daemon, `doctor`, `check-records`) luôn thấy
trọn một thế hệ, không bao giờ trộn. Người ghi lần lượt từng người qua `flock` (util-linux) trên `record.lock`: khóa
gắn với fd tiến trình ghi giữ mở, nhả khi đóng fd hoặc tiến trình chết, và file khóa không bao giờ bị xóa. Chờ quá
10 giây thì lệnh báo khóa đang bị giữ và không ghi gì. Điều kiện ghi được xét lại ngay trong khóa. Không có `--force` thì chỉ ghi được khi chưa có bản ghi.
`record-manifest` và `setup-harness --from record-manifest` chỉ ghi manifest cho đúng pin chúng đã đọc: pin bị một
setup khác thay trong lúc kiểm thì lệnh từ chối (`changed while its manifest was made`), không đặt lại pin cũ. Bản cài từ release
trước còn `pin.json` và `manifest.json`: vẫn đọc được cho tới lần ghi đầu tiên, sau đó bị bỏ qua (không sửa tay).

- Pin theo `VendorPinSchema`: đường dẫn lệnh (`binary.path`, đúng như `--binary`), toolchain, env không
  bí mật, `home_files` trỏ tới tên trong `runtime.credential_refs`, settings, `max_turns`, `tools`. Pin mới là
  thứ quyết định lệnh nào chạy, không phải `harnesses.<tên>.cmd`. Version và sha256 lúc ghi pin chỉ để chẩn đoán:
  mỗi lượt chạy phân giải lại `binary.path`, nên nâng cấp CLI tại chỗ (`claude update`, `npm i -g`) không cần
  ghi lại pin hay manifest; với Codex, sandbox của binary mới được kiểm lại trước lượt đầu của nó (xem dưới).
  Lệnh bị gỡ, mất quyền chạy hoặc trỏ tới thứ không phải file thì lượt đó báo lỗi kèm đường dẫn. Pin ghi trước bản
  này chưa có `binary.path` nên vẫn chạy đúng file realpath cũ, kể cả khi file đó được nâng cấp tại chỗ. Cài đặt
  qua symlink (lệnh trỏ sang thư mục có version) mà file cũ đã bị xóa thì daemon không đoán lệnh nào thay thế:
  lỗi nêu rằng pin có từ trước khi có đường dẫn lệnh, và chạy `setup-harness --force --binary <lệnh>` **một lần**
  để chuyển. Đây là bước chuyển một lần của release này; các lần nâng cấp sau không cần. Tạo bằng `cusr-runner write-pin`, lệnh để `env` rỗng và từ chối đường dẫn không tồn tại ở host này.
- Manifest, chỉ ghi bằng lệnh dưới đây, từ pin của **đúng cấu hình đó**. `write-pin` riêng ghi pin với manifest
  trống: harness chưa chạy được cho tới `record-manifest`.

```sh
cusr-runner setup-harness --config ~/.cusr/config.yaml --harness claude --vendor claude \
  --binary "$(command -v claude)" --toolchain /opt/node/bin --auth claude-0:.claude/.credentials.json \
  --settings claude-settings.json --permission-mode auto --sandbox off
```

`setup-harness` chạy `write-pin` rồi `record-manifest`, nạp config một lần cho cả luồng và **không gọi model**.
Manifest ghi cấu hình của pin (vendor, chế độ quyền, sandbox, schema của mọi role); năng lực chỉ model mới cho
thấy (structured output, quyền tool, đăng nhập từ home riêng, báo usage, resume) ghi `unknown`, không ghi
`proven`. Daemon dùng mọi năng lực không bị ghi `unsupported`. Binary chưa cài thì `write-pin` báo lỗi
(`cannot run <binary> --version`). Pin đã tồn tại cần `--force` để ghi đè. Lệnh dựng và kiểm manifest của pin
mới trước khi thay bản ghi nào: bước nào lỗi thì dừng, giữ mã lỗi, nêu tên bước (JSON có `error.details.step`)
và bản ghi cũ giữ nguyên. Ghi `record.json` lỗi (đầy đĩa, không có quyền) thì lệnh báo bước `commit`, bản ghi trên
đĩa không đổi; crash trước lần rename chỉ để lại một file `.tmp` không ai đọc. `--dry-run` kiểm như thật mà không ghi gì, báo `native_result` và
`pin_exists`. Ghi lại manifest với pin đang có (sau khi đổi release, settings, hay để thêm role):

```sh
cusr-runner setup-harness --from record-manifest --config ~/.cusr/config.yaml --harness claude
```

Hai lệnh riêng `write-pin` và `record-manifest` vẫn dùng được. `record-manifest --evidence <file>` vẫn nhận
evidence cũ của lệnh `prove-harness` đã bỏ, chỉ khi evidence khớp đúng các byte mà đường dẫn lệnh đang trỏ tới:
evidence của bản cũ không được ghi lại cho binary đã nâng cấp. Setup quan sát binary một lần (file thật mà lệnh trỏ
tới và digest của nó), chạy phép kiểm sandbox trên chính file đó, so evidence và ghi manifest theo đúng quan sát ấy,
rồi quan sát lại: lệnh đổi đích hoặc byte đổi trong lúc kiểm thì setup từ chối (`changed while it was checked`).

Lỗi không gọi được harness lộ ra ở lượt agent, không ở bước setup, và không tự thử lại:

- Lệnh bị gỡ, không có quyền chạy hoặc hệ điều hành không chạy được: task chờ `auth_config` kèm đường dẫn và lỗi.
- Đăng nhập hết hạn hoặc bị từ chối, kể cả khi CLI chỉ báo trên stderr rồi thoát: `WAITING/policy harness_auth`.
- Bản ghi pin/manifest không nạp được lúc `cusrd` khởi động: preflight của task mới và handoff của deputy nêu
  đúng lỗi nạp (`harness '<h>' cannot run: ...`), không chỉ "no harness".
- CLI thoát và stderr nói nó không khởi động được (sandbox không khởi tạo được, `bwrap` bị từ chối, binary sai
  định dạng): `capability_missing`, giao owner, không thử lại như lỗi hạ tầng. Lỗi thoát khác vẫn là
  `process_failed`, theo đường lỗi hạ tầng có đếm (`infra_retries`).
- Phiên trong terminal (deputy interactive) giữ nguyên terminal cho stdin, stdout và stderr, nên CLI vẫn thấy TTY.
  Thoát trước Stop hook thì runner tự tìm lý do mà không gọi model: bản ghi lỗi CLI tự ghi vào session của nó trong
  home riêng (Claude: message lỗi API; Codex: sự kiện `error`), và với sandbox Claude, `bwrap` có tạo được namespace ở
  host này không. Đăng nhập bị từ chối thành `auth`, sandbox không khởi động được thành `capability_missing`, kèm lý
  do đã che bí mật, và giao owner ngay, kể cả khi `infra_retries: 0`. Không tìm ra lý do thì là lỗi hạ tầng có đếm.
  Chỉ phiên bị treo (`timeout`) mới chạy tiếp headless ngay, không đếm.

Các wait này thuộc owner, nên assistant đang giữ lease được đánh thức qua Stop hook hoặc `cusr assistant wait`.
Session assistant đã thêm task (`cusr task add` gửi kèm session của nó) cũng được báo lỗi khởi chạy của chính
task đó dù lease đã sang session khác hoặc daemon đã restart: daemon lưu session vào `requested_by.session` của task
lúc nhận lệnh, lấy từ lease header chứ không từ nội dung task. Stop hook hoặc `assistant wait` của session không
giữ lease hỏi `assistant_origin`, chỉ thấy lỗi khởi chạy harness của task do nó thêm: `harness_auth`, `auth_config`
của một bước agent, `capability_missing` lúc preflight do harness hoặc host (không tính lỗi quyền GitHub hay
toolchain của gate), và handoff của deputy vì chính harness của deputy không chạy được (`auth`, `capability`,
`no_harness`). Session xác nhận trên kênh riêng nên không lấy gì khỏi hàng đợi của session giữ lease; xác nhận chỉ
gửi sau khi ghi chú đã tới (hook) hoặc đã in ra (`assistant wait`), và hook thử lại khi đẩy vào hàng đợi Codex lỗi.
Hook chỉ chờ khi session còn task đang chạy. Lỗi preflight PENDING không bị giữ lại cho deputy, vì deputy chỉ nhận
lượt trên task WAITING; sau restart nó vẫn tới cả hai kênh.

Phạm vi theo session dựa trên cùng mô hình tin cậy với lease ([người gọi và quyền](#người-gọi-và-quyền)): socket
0600 chỉ mở cho process cùng UID, và daemon tin session ID trong header mà không xác thực process đứng sau. Nó giữ
các session trung thực khỏi lẫn tin của nhau, không phải ranh giới bảo mật giữa các process cùng UID. Task tạo từ
kế hoạch goal là luồng riêng, không mang session gốc. Ghi chú đánh thức nêu bằng văn bản cố định harness hỏng ra sao và lệnh sửa
(`cusr task recheck <id>` sau khi đăng nhập lại, hoặc `cusr task explain <id>`), không chép chữ của worker.

Resume được dùng trừ khi manifest ghi `resume: unsupported`. Resume chỉ mang dữ liệu của đúng session, không mang
auth/settings của attempt cũ: với Claude là transcript và tool data trong `.claude/projects/`, với Codex là file
rollout `.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` của đúng thread.

Codex resume bằng `codex exec <cờ như phiên mới> resume <thread_id> -`. Subcommand `resume` (0.167.0)
không có `-C`, `--sandbox`, `--add-dir` riêng, nhưng các cờ của `exec` đặt trước `resume` vẫn áp dụng
cho lượt resume, nên cwd, sandbox và hash quyền hiệu lực giữ như phiên mới. Lượt resume phát lại
`thread.started` với cùng `thread_id`.

Nếu transcript/run cũ đã mất, worker dùng phiên mới với context đầy đủ và ghi `resume_fallback: session_missing`;
không chờ người vận hành chỉ để khôi phục hội thoại.

Manifest gắn với cấu hình của pin: settings, environment (env, toolchain, `home_files`, `max_turns`, `tools`),
host policy và layout; không gắn với version hay digest của binary. Kết quả sandbox native thì gắn với byte đã
kiểm: với Codex, mỗi lượt chạy so digest của binary đang cài với digest trong manifest; khác thì chạy lại phép kiểm
`codex sandbox` không gọi model cho đúng profile lượt đó dùng (workspace cho worker, read-only cho reviewer, kể cả
khi worker full access) trước khi khởi chạy. Phép kiểm chạy trên file đã quan sát và chỉ tính khi file đó vẫn đúng
digest sau khi kiểm. Kết quả đạt được nhớ theo file, digest và profile trong runner; không đạt thì lượt đó
`capability_missing` kèm lý do và lần sau kiểm lại. Pin sửa sau khi ghi manifest chặn request và attempt kế tiếp cho đến khi ghi lại
manifest. Đổi đường dẫn file credential thì không cần. `record-manifest` không gọi harness, không tốn usage.

Công cụ harness được tìm trên toolchain của pin cộng PATH daemon. Setup/gate dùng thư mục Node của daemon
cộng PATH daemon; preflight dùng đúng cùng danh sách với lệnh thực thi. Khi chạy daemon bằng systemd, đặt
`Environment=PATH=...` trong service nếu công cụ như pnpm chỉ có ở PATH shell. PATH shell khác daemon
không làm manifest mất hiệu lực; dependency cần thiết phải có ở môi trường thực thi. Reviewer Claude luôn cần dependency native, thường gồm `bwrap` và `socat`,
kể cả khi worker tắt sandbox hoặc dùng full access.
Doctor/preflight kiểm file executable trên host, không tạo outer sandbox để probe.

Worker Claude tắt sandbox ghi `native_result=not_tried`; auto dùng mode `permissions_only`, full access dùng
`full_access`. Sandbox native bật thì `setup-harness` kiểm thật, không qua model: Codex chạy `codex sandbox`, một
lệnh vô hại phải chạy được và lệnh ghi ra ngoài worktree phải bị hệ điều hành từ chối; chỉ khi đạt mới ghi
`native_result=passed`, không đạt thì từ chối và giữ bản ghi cũ. Profile read-only của reviewer cũng được kiểm,
kể cả với pin full access, và phải từ chối cả lệnh ghi bên trong worktree của nó; một read-only ghi được như
workspace-write thì bị từ chối. Sandbox của Claude chỉ thấy được qua một lượt
model, nên pin Claude `--sandbox on` ghi `native_result=not_tried`, không bao giờ `passed`. Việc quan sát dời sang
mỗi lượt chạy: adapter luôn chạy Claude native với `sandbox.failIfUnavailable=true` và
`allowUnsandboxedCommands=false`, nên sandbox không khởi động được thì lượt đó lỗi chứ không chạy ngoài sandbox.
Ranh giới: setup không chứng minh sandbox Claude chặn ghi ra ngoài worktree; điều đó dựa vào sandbox của Claude và
`sandbox.filesystem` trong settings của owner. Không tự chuyển sang tắt sandbox hay full access. Rule deny
`permission-denied-by-rule` trong settings Claude hoặc `.codex/rules/` chỉ phục vụ lệnh `prove-harness` đã bỏ;
giữ hay xóa đều được.

`cusr-runner check-records --config <file> --data-dir <dir>` kiểm config và mọi harness record với release đang chạy
lệnh, không gọi model, gồm cả phép kiểm sandbox Codex với binary đang cài; nên chạy bằng release mới trước khi đổi
sang nó, và sau khi nâng cấp CLI.

Claude cần `TMPDIR` đủ ngắn cho Unix socket của sandbox (đường dẫn tối đa 108 byte), nên mỗi lượt chạy Claude có thư
mục riêng 0700 `/tmp/cusr-<hash>`, xóa khi lượt kết thúc. Với host có `/tmp` là tmpfs nhỏ, việc ghi file tạm lớn trong
lượt chạy agent sẽ chiếm chỗ ở đó. Setup, gate, autofix và Codex vẫn dùng scratch của mình làm `TMPDIR`.

Sau khi nâng release, chạy `setup-harness --force` với các tham số pin đầy đủ,
`--permission-mode auto` hoặc `full-access`, rồi restart daemon. Manifest cũ của outer bwrap
không dùng được cho native execution. Task đang đóng băng theo outer bwrap phải kết thúc/hủy ở release
cũ rồi tạo task mới; không đổi snapshot đang chạy. Đổi mode pin cũng cần ghi lại manifest.

Push vẫn do daemon gọi qua credential helper tin cậy. Role/model/workflow và merge giữ cùng hợp đồng.

## Network và credentials

Cuesura chạy trên host và không thêm namespace mạng hay egress firewall. Mạng của lệnh do host và
native harness quyết định. Mỗi attempt có home riêng giữ file đăng nhập harness và session; credential
được che trước khi lưu log, và token điều phối của cusr không vào environment worker hoặc gate.

Worker chạy như phiên owner tự mở, giống cách Orca chạy agent theo từng tài khoản:

- `HOME` là home thật của owner, nên dotfile, `gh`, `git`, `ssh`, `~/.agents/skills` dùng như thường.
  Chỉ `CLAUDE_CONFIG_DIR` và `CODEX_HOME` trỏ vào home riêng của attempt, nơi giữ file đăng nhập và
  session. Home riêng link tới cấu hình harness của owner: `~/.claude` (`CLAUDE.md`, `settings.json`,
  `skills`, `agents`, `commands`, `plugins`, `output-styles`, `hooks`) và `~/.codex` (`config.toml`,
  `AGENTS.md`, `skills`, `prompts`); MCP server khai ở `~/.claude.json` được chép sang.
- Environment là environment của daemon (PATH thêm toolchain của pin), trừ biến `CUSR_*` và biến của một
  phiên agent bọc ngoài (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX*`). Pin đặt được mọi biến,
  kể cả secret như API key cho MCP server; log vẫn che giá trị secret. Muốn worker có PATH như shell của
  owner thì đặt `Environment=PATH=…` trong unit systemd.
- Claude dùng bộ tool mặc định như phiên tương tác; `--tools` của pin không còn tác dụng. Codex nạp
  `config.toml` của owner và bật mọi tính năng; cờ của cusr đè lên config đó.
- Coder/fixer được commit trong worktree, trên nhánh của task; daemon commit phần còn lại, rồi push
  fast-forward và mở PR. Reviewer được sửa, chạy test và commit; xong lượt review daemon đưa nhánh và file
  về như trước review (file bị gitignore giữ nguyên). Deputy cũng vậy sau mỗi lượt. Không role nào đang chạy còn
  chỉ đọc.

Process cùng UID có quyền đọc file host theo OS; home riêng không phải ranh giới bảo mật.

Nâng cấp lên bản này: argv Codex đổi nên manifest Codex cũ không còn khớp. Ghi lại manifest bằng pin đã có
(`cusr-runner setup-harness … --harness codex --from record-manifest`) rồi restart daemon. Pin Claude có bật
sandbox cũng cần ghi lại; pin Claude tắt sandbox giữ nguyên manifest.

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
