# Cuesura

> Every call has a cue. Every pause has a purpose.
>
> Mỗi lần gọi đều có tín hiệu. Mỗi khoảng lặng đều có lý do.

Cuesura là một **workflow engine tất định, hướng sự kiện, dành cho AI agent**. Tên ghép từ **Cue** (tín hiệu bắt đầu) và **Caesura** (khoảng ngắt có chủ đích trong âm nhạc hoặc thơ). Agent không hoạt động không có nghĩa hệ thống ngừng vận hành: mỗi lần chờ CI, người duyệt hoặc hạn mức đều có trạng thái, lý do và điều kiện tiếp tục. Biết khi nào không cần dùng AI cũng quan trọng như biết khi nào cần.

**Tên CLI: `cusr`** — rút gọn từ **CUeSuRa**. Ví dụ lệnh dự kiến: `cusr task add`, `cusr status`, `cusr inbox`.

Use case đầu tiên là quy trình phát triển phần mềm: code → review → PR → CI → merge. Mục tiêu dài hạn là một nền tảng workflow tổng quát. Workflow, role, nguồn task và kênh liên lạc đều là dữ liệu và plugin, không gắn cứng vào việc viết code.

- **Không có Primary AI chạy liên tục.** Một state machine thuần quyết định mọi bước, nên việc điều phối tốn 0 token.
- **Agent là các lần gọi headless một lần cho mỗi bước:** Claude Code, Codex CLI, sau này có Pi.
- **Trạng thái bền vững trong SQLite:** event log, outbox có idempotency key, và khôi phục sau crash mà không lặp lại side effect.
- **Dùng cho mọi project, không gắn ngôn ngữ:** gate, lệnh setup, bộ lọc log và tài nguyên riêng đều do từng repo khai báo trong `cusr.yaml`. Có toolchain pack làm preset cho Node, Python, Go, Rust, JVM.

## Công cụ làm gì

1. **Nhận task từ nhiều kênh:** GitHub issue, CLI, AI assistant, sau này có form. Mọi task được chuẩn hoá về một format trong DB.
2. **Triage và lập lịch:** xử lý dependency, chạy song song các task độc lập, tự dừng khi chạm hạn mức subscription.
3. **Workflow cho mỗi task trong worktree riêng:**
   - Code, rồi chạy gate (build/test).
   - Review (agent khác vendor với coder), sửa theo review có giới hạn số vòng.
   - Mở PR và chờ CI. Lỗi CI do code thì để coder tự sửa.
   - Merge an toàn. Mặc định bạn duyệt từng lần merge vào `main`. Chế độ yolo (chỉ bạn bật được, theo từng repo) cho phép code tự merge khi đủ điều kiện cứng. Agent không bao giờ quyết định merge.
4. **Role và model cấu hình được,** đóng băng theo từng task, kèm thang nâng effort/model theo chữ ký lỗi.
5. **Chế độ quyết định:** người quyết, hoặc agent `decider` quyết và ghi lại để có thể lật lại.
6. **Hỏi đáp bất đồng bộ** qua `cusr inbox`, Telegram bot, hoặc comment GitHub.
7. **CLI `--json`** cho AI assistant bên ngoài truy vấn và điều khiển.
8. **Đo lường:** token / task được chấp nhận, số lần chạy lãng phí, time to green, số lần bạn phải can thiệp, tỉ lệ khôi phục thành công.

## Trạng thái

Đang ở giai đoạn thiết kế. [SPEC.md](SPEC.md) là đặc tả tổng quan của dự án: phạm vi v1, mô hình miền, workflow, hợp đồng vận hành và tiêu chí nghiệm thu. [docs/architecture.md](docs/architecture.md) lưu đánh giá Build vs Buy, lập luận kiến trúc và kế hoạch ban đầu.

Baseline: Node 24 LTS, TypeScript strict, SQLite (`better-sqlite3`), Zod 4, Commander, `yaml`, Vitest và fast-check. Build bằng `tsc`, quản lý package bằng pnpm, lint/format bằng ESLint + typescript-eslint + Prettier. Chạy trên Ubuntu/WSL2; xem [quyết định kỹ thuật](SPEC.md#17-baseline-kỹ-thuật).
