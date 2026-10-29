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
   - Trước khi chạy, bạn xác nhận harness, model, effort và chế độ: `direct-pr` hoặc `full-review`.
   - Worker chuẩn bị commit message và nội dung PR; daemon tạo branch, commit và publish.
   - `full-review` có reviewer riêng session, chỉ đọc, có thể cùng vendor; `direct-pr` bỏ bước reviewer.
   - Mở PR và chờ CI. Sửa gate/review/CI ưu tiên resume worker đã code, trong giới hạn đã duyệt.
   - Merge an toàn. Mặc định bạn duyệt từng lần merge vào `main`. Chế độ yolo (chỉ bạn bật được, theo từng repo) cho phép code tự merge khi đủ điều kiện cứng. Agent không bao giờ quyết định merge.
4. **Role và model cấu hình được,** đóng băng theo từng task, kèm thang nâng effort/model theo chữ ký lỗi.
5. **Chế độ quyết định:** người quyết, hoặc agent `decider` quyết và ghi lại để có thể lật lại.
6. **Hỏi đáp bất đồng bộ** qua `cusr inbox`, Telegram bot, hoặc comment GitHub.
7. **CLI `--json`** cho AI assistant bên ngoài truy vấn và điều khiển.
8. **Đo lường:** token / task được chấp nhận, số lần chạy lãng phí, time to green, số lần bạn phải can thiệp, tỉ lệ khôi phục thành công.

## Trạng thái

[Hai chế độ và xác nhận cấu hình chạy](specs/002-task-to-green-pr/task-execution-modes.md) là quyết định thiết kế mới, chưa triển khai runtime/schema/CLI.

Đang ở giai đoạn thiết kế. [SPEC.md](SPEC.md) là đặc tả tổng quan của dự án: phạm vi v1, mô hình miền, workflow, hợp đồng vận hành và tiêu chí nghiệm thu. [docs/architecture.md](docs/architecture.md) lưu đánh giá Build vs Buy, lập luận kiến trúc và kế hoạch ban đầu.

Baseline: Node 24 LTS, TypeScript strict, SQLite (`better-sqlite3`), Zod 4, Commander, `yaml`, Vitest và fast-check. Build bằng `tsc`, quản lý package bằng pnpm, lint/format bằng ESLint + typescript-eslint + Prettier. Chạy trên Ubuntu/WSL2; xem [quyết định kỹ thuật](SPEC.md#17-baseline-kỹ-thuật).

## Phát triển

Feature đang làm là lõi điều phối tất định ([specs/001-deterministic-core](specs/001-deterministic-core/spec.md)). Hướng dẫn kiểm chứng đầy đủ, kèm kết quả mong đợi của từng lệnh, ở [quickstart.md](specs/001-deterministic-core/quickstart.md).

Điều kiện môi trường:

- Linux hoặc WSL2/Ubuntu, repo nằm trên filesystem Linux (không phải `/mnt/c`): crash test dựa vào `SIGKILL` và khoá file của Linux.
- Node đúng bản pin trong `.nvmrc` (24.22.1), pnpm qua Corepack.
- `build-essential` và `python3` để build `better-sqlite3` khi không có prebuilt.

```bash
corepack enable
pnpm install --frozen-lockfile
```

Cổng chất lượng, mỗi lệnh là một kiểm tra riêng:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Nhóm reliability chạy riêng vì tốn thời gian (10.000 chuỗi tín hiệu qua kho in-memory, 200 lần `SIGKILL` trên file SQLite thật). Khi fail, output in `seed`; truyền lại để tái hiện:

```bash
pnpm test:reliability
pnpm test:reliability --seed <seed>
```

Báo cáo bất biến I01–I12 dựng từ kết quả của lần `pnpm test` và `pnpm test:reliability` gần nhất; thoát lỗi khi thiếu kết quả hoặc có bộ bị skip/fail:

```bash
pnpm report:invariants
```
