# Xem agent trong terminal multiplexer, systemd vẫn giữ vòng đời

Mặc định `runtime.terminal.backend` là `background`: agent chạy nền trong unit systemd như
[ADR-0002](0002-systemd-runner-lifetime.md). Chọn `herdr` thì mỗi operation `agent` được khởi động từ một
tab nền trong workspace `cuesura`, bằng đúng lệnh `systemd-run` cộng thêm `--pty`. Đổi backend chỉ cần đổi
config và restart `cusrd`. Chọn `orca` hoặc `paseo` cũng vậy, chỉ khác nơi hiện tab (xem dưới). Thêm backend mới
(tmux) là một biến thể schema và một `TerminalHost`.

Vẫn là service `cusr-op-<operation>.service` nên inspect, stop, cgroup và recovery không đổi; terminal chỉ giữ
đầu pty. Phương án bị loại: `systemd-run --scope` trong pane (đã thử: scope chết cùng herdr server, vi phạm
ADR-0002); `herdr agent start` với TUI tương tác (mất hợp đồng stream-json, phải đoán trạng thái qua terminal,
xem [architecture §4](../architecture.md)).

Pane không có quyền quyết định gì về operation. Đã thử trên systemd 255 và herdr 0.9.5: Ctrl-C trong pane và
dừng hẳn herdr server không dừng agent, `systemctl stop` vẫn dừng sạch. Muốn vậy, unit bỏ qua `TERM INT HUP` ở
`flock` và runner tự cài handler, vì Node reset disposition lúc khởi động. Runner ghi ra terminal bằng descriptor
non-blocking, bản ghi không ghi được thì bỏ: event log vẫn là bản ghi duy nhất, nên terminal treo không giữ
runner lại.

Backend không sẵn sàng thì agent chạy nền và daemon ghi log, không làm hỏng task: hai đường có cùng unit, env
và hợp đồng kết quả. Lệnh đã gõ vào pane có thể chạy muộn, kể cả sau khi daemon crash, mà trước đó host không
có dấu vết gì. Trong cùng operation, tên unit, operation lock và launch marker chặn chạy trùng. Attempt thay
thế là operation khác, nên trước khi báo `not_launched` daemon chiếm `launch.json` bằng marker `fence`: ghi
marker là thao tác nguyên tử, runner đến muộn gặp `marker_exists` và không spawn gì. `cusr doctor` báo backend không tới được. Shell của pane chạy ở data dir, không ở worktree, để hook
của shell không chạy trong worktree. Tab tự đóng khi operation xong; xem lại bằng `cusr task logs`.

Orca không có workspace tự do: terminal nào cũng thuộc một project, và CLI chỉ đăng ký được repo git. Vì vậy
Cuesura tạo repo rỗng `<data dir>/cuesura`, đăng ký nó khi `terminal create` báo chưa có project, và shell chạy
trong repo đó. Phương án bị loại: mở tab trong worktree của task (vi phạm quy tắc shell không ở worktree, và
worktree của Cuesura không do Orca quản lý); `orca agent launch` (cùng lý do với `herdr agent start`). Đã thử trên
Orca 1.4.246 với runtime tách riêng: đóng tab, Ctrl-C và dừng hẳn server Orca không dừng unit.

Paseo cũng gắn terminal với một workspace, nhưng workspace mở được ở thư mục bất kỳ, không cần git: Cuesura tạo
`<data dir>/cuesura` và mở terminal ở đó, app Paseo hiện nó trong project `cuesura`. Các lệnh `terminal create`
đồng thời vào một thư mục mới tạo ra nhiều workspace, nên Cuesura tạo lần lượt từng terminal. CLI của Paseo là
script Node gọi `env node`, mà lệnh ngoài của daemon chạy với PATH tối giản, nên Cuesura chạy nó bằng chính node
của daemon. Phương án bị loại: `paseo run` (cùng lý do với `herdr agent start`; agent còn thành process con của
daemon Paseo, mất unit systemd, pin và proof của harness). Đã thử trên Paseo 0.13.0: kill terminal và dừng hẳn
daemon Paseo không dừng unit.
