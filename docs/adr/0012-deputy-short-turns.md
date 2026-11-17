# Deputy chạy theo lượt ngắn, phiên tương tác kết thúc bằng hook

Chủ dự án chốt ngày 2026-11-08 (phiên native) và 2026-11-09 (lượt ngắn thay phiên sống lâu); spike T088 ngày
2026-11-14 xác nhận hook hết lượt trên Claude và Codex. Thay decider bằng deputy (feature 007).

Mỗi sự cố của task (một lần vào wait mà bảng định tuyến giao cho deputy) và mỗi lần goal cần lập hay sửa kế hoạch mở
một **lượt**: một phiên harness mới, context do code dựng theo vùng từ sổ goal, kết thúc bằng bàn giao có cấu trúc
(`cusr deputy handoff`). Giữa các lượt không có process deputy nào chạy. Trong một lượt, khi phải chạy lại (chờ hạn mức,
lỗi hạ tầng, phiên treo), daemon resume đúng phiên của lượt đó. Trí nhớ của deputy là dữ liệu đã ghi trong SQLite
(event, command ledger, bản ghi lượt), không phải transcript.

Lần chạy đầu của lượt là phiên tương tác của harness (TUI) trong terminal backend khi có backend và adapter hỗ trợ, cùng
unit `systemd-run --pty` như [ADR-0006](0006-terminal-view-backend.md); không có backend thì headless. Cuesura cài hook
`Stop` vào private home: Claude trong `settings.json` (bản sao gộp với settings của chủ dự án, nên hook của họ vẫn
chạy), Codex trong `hooks.json` kèm hash trust do runner tính. Hook ghi `turn-ended.json` vào run dir; runner thấy file
thì dừng phiên sau `term_grace_ms` và trả `turn_ended`. Khi role khai `stall_timeout`, không có tín hiệu trong khoảng đó thì runner dừng phiên và
daemon resume cùng phiên ở chế độ headless trong cùng lượt; mọi lần chạy lại sau lần đầu đều headless.

Lý do. Một phiên sống lâu mỗi task có context lớn dần theo mỗi sự cố, phải đọc lại cả transcript khi prompt cache hết
hạn, không thấy task khác và giữ trí nhớ ở chỗ chỉ phiên đó đọc được. Lượt ngắn giữ context cùng cỡ dù goal chạy bao
lâu, phần đầu ổn định của context trúng prompt cache giữa các lượt, và mọi lượt cùng mọi phiên trợ lý đọc chung một sổ.
Phiên tương tác cho chủ dự án mở cửa sổ `deputy: <tiêu đề>` để xem và gõ vào; hook ghi file giữ mọi thứ trong hợp đồng
runner hiện có.

Hệ quả:

- Riêng với deputy, quyết định này đi ngược phương án bị loại ở ADR-0006 (chạy TUI thay vì stream-json): trạng thái
  phiên không đọc từ terminal mà từ file hook ghi và từ stall của process.
- Hook Codex của chủ dự án không được mang vào private home, như với mọi worker Codex: Codex khóa trust theo đường dẫn
  file, nên hook chép sang thành "chưa trust" và TUI dừng ở hộp duyệt (issue #298). Đổi phiên bản Codex có thể đổi cách
  băm trust; khi đó lượt stall rồi chạy tiếp headless.
- Codex không có luật đường dẫn cho tool sửa file, nên luật cấm sửa worktree của task chỉ áp cho Claude. Mọi thay đổi
  của lượt trong worktree của task vẫn bị trả về theo mốc như reviewer.

Phương án bị loại:

- Một phiên deputy sống lâu mỗi task, mỗi ngày hay mỗi nhóm task: context lớn dần, sự cố xếp hàng sau một phiên.
- Phiên trợ lý của chủ dự án kiêm deputy: ý định của người lẫn với quyết định của agent, chết theo terminal.
- Một deputy cộng proxy nén context: thêm dependency và một proxy đứng trên đường credentials.
- `notify` của Codex làm tín hiệu hết lượt: nó cũng chạy cho thread nội bộ sinh tiêu đề.
- `--dangerously-bypass-hook-trust` của Codex: bỏ duyệt mọi hook, không chỉ hook của Cuesura.

Nguồn: [spec feature 007](../../specs/007-deputy/spec.md) (FR-010–FR-018),
[research R-03, R-16 và "Quyết định khi làm lát G"](../../specs/007-deputy/research.md).
