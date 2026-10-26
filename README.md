# Metronome

> Giữ nhịp bằng code. Để AI chơi phần chuyên môn.

Metronome là một **workflow engine tất định, hướng sự kiện, dành cho AI agent**. Tên dự án nói lên cách nó vận hành: máy đếm nhịp giữ tempo chính xác và không bao giờ tự ứng tác, còn nhạc công (các agent) chỉ việc chơi phần của mình.

Use case đầu tiên là quy trình phát triển phần mềm: code → review → PR → CI → merge. Mục tiêu dài hạn là một nền tảng workflow tổng quát. Workflow, role, nguồn task và kênh liên lạc đều là dữ liệu và plugin, không gắn cứng vào việc viết code.

- **Không có Primary AI chạy liên tục.** Một state machine thuần quyết định mọi bước, nên việc điều phối tốn 0 token.
- **Agent là các lần gọi headless một lần cho mỗi bước:** Claude Code, Codex CLI, sau này có Pi.
- **Trạng thái bền vững trong SQLite:** event log, outbox có idempotency key, và khôi phục sau crash mà không lặp lại side effect.

## Công cụ làm gì

1. **Nhận task từ nhiều kênh:** GitHub issue, CLI, AI assistant, sau này có form. Mọi task được chuẩn hoá về một format trong DB.
2. **Triage và lập lịch:** xử lý dependency, chạy song song các task độc lập, tự dừng khi chạm hạn mức subscription.
3. **Workflow cho mỗi task trong worktree riêng:**
   - Code, rồi chạy gate (build/test).
   - Review (agent khác vendor với coder), sửa theo review có giới hạn số vòng.
   - Mở PR và chờ CI. Lỗi CI do code thì để coder tự sửa.
   - Merge an toàn. Có chế độ yolo để tự merge.
4. **Role và model cấu hình được,** đóng băng theo từng task, kèm thang nâng effort/model theo chữ ký lỗi.
5. **Chế độ quyết định:** người quyết, hoặc agent `decider` quyết và ghi lại để có thể lật lại.
6. **Hỏi đáp bất đồng bộ** qua `metro inbox`, Telegram bot, hoặc comment GitHub.
7. **CLI `--json`** cho AI assistant bên ngoài truy vấn và điều khiển.
8. **Đo lường:** token / task được chấp nhận, số lần chạy lãng phí, time to green, số lần bạn phải can thiệp, tỉ lệ khôi phục thành công.

## Trạng thái

Đang ở giai đoạn thiết kế. Xem [docs/architecture.md](docs/architecture.md) để có đánh giá Build vs Buy, kiến trúc, Reliability Gate và kế hoạch v1 (khoảng 4 tuần).

Stack dự kiến: Node 22, TypeScript, SQLite (`better-sqlite3`), `zod`, `vitest`, `fast-check`. Chạy trên Ubuntu/WSL2.
