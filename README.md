# Cuesura

> Every call has a cue. Every pause has a purpose.
>
> Mỗi lần gọi đều có tín hiệu. Mỗi khoảng lặng đều có lý do.

Cuesura là một **workflow engine tất định, hướng sự kiện, dành cho AI agent**. Tên ghép từ **Cue** (tín hiệu bắt đầu) và **Caesura** (khoảng ngắt có chủ đích trong âm nhạc hoặc thơ). Agent không hoạt động không có nghĩa hệ thống ngừng vận hành: mỗi lần chờ CI, người duyệt hoặc hạn mức đều có trạng thái, lý do và điều kiện tiếp tục. Biết khi nào không cần dùng AI cũng quan trọng như biết khi nào cần.

**Tên CLI: `cusr`** — rút gọn từ **CUeSuRa**. Ví dụ lệnh dự kiến: `cusr task add`, `cusr status`, `cusr inbox`.

Use case đầu tiên là quy trình phát triển phần mềm: code → review → PR → CI → merge. Mục tiêu dài hạn là một nền tảng workflow tổng quát. Graph workflow là preset trong code (v1 có `software_dev@1`), người dùng chỉ chỉnh tham số như số lượt tối đa của từng bước; role, nguồn task và kênh liên lạc là dữ liệu và adapter, không gắn cứng vào việc viết code. Nâng cấp config cũ: [docs/config-upgrade.md](docs/config-upgrade.md).

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
   - Worker chuẩn bị commit message và nội dung PR theo PR template của repo, hoặc template mặc định của cusr; daemon tạo branch, commit và publish.
   - `full-review` có reviewer riêng session, chỉ đọc, có thể cùng vendor; `direct-pr` bỏ bước reviewer.
   - `full-review` mở PR dạng draft, daemon đăng từng lượt review lên PR (format đổi được bằng `review_template` trong `cusr.yaml`), approve thì chuyển PR ready rồi mới chờ CI. `direct-pr` mở PR ready và chờ CI ngay.
   - Sửa gate/review/CI ưu tiên resume worker đã code, trong giới hạn đã duyệt.
   - Method mặc định là squash merge, đổi được bằng `merge.method` trong `cusr.yaml`; không bật yolo thì method chỉ là đề xuất cho người merge thủ công (`cusr show`).
   - Merge an toàn. Mặc định bạn duyệt từng lần merge vào `main`. Chế độ yolo (chỉ bạn bật được, theo từng repo) cho phép code tự merge khi đủ điều kiện cứng. Agent không bao giờ quyết định merge.
4. **Role và model cấu hình được,** đóng băng theo từng task, kèm thang nâng effort/model theo chữ ký lỗi.
5. **Người quyết định:** task chờ khi cần bạn trả lời, và mọi câu trả lời đều được ghi lại.
6. **Hỏi đáp bất đồng bộ** qua `cusr inbox`, Telegram bot, hoặc comment GitHub.
7. **CLI `--json`** cho AI assistant bên ngoài truy vấn và điều khiển.
8. **Đo lường:** token / task được chấp nhận, số lần chạy lãng phí, time to green, số lần bạn phải can thiệp, tỉ lệ khôi phục thành công.

## Trạng thái

Feature 002 (task tới PR xanh, người dùng tự merge) đã chạy thật trên repo sandbox với Claude và Codex, gồm restart daemon, gate đỏ và merge thủ công; xem [nghiệm thu cuối](specs/002-task-to-green-pr/acceptance-report.md#nghiệm-thu-cuối-feature-002-t131t134). Giới hạn: một task chạy tại một thời điểm, giao task qua CLI, chưa soak test, chưa nghiệm thu backup/restore, và mới kiểm trên repo sandbox nhỏ với model nhẹ.

[SPEC.md](SPEC.md) là đặc tả tổng quan của dự án: phạm vi v1, mô hình miền, workflow, hợp đồng vận hành và tiêu chí nghiệm thu. [docs/architecture.md](docs/architecture.md) lưu đánh giá Build vs Buy, lập luận kiến trúc và kế hoạch ban đầu.

Baseline: Node 24 LTS, TypeScript strict, SQLite (`better-sqlite3`), Zod 4, Commander, `yaml`, Vitest và fast-check. Build bằng `tsc`, quản lý package bằng pnpm, lint bằng ESLint + typescript-eslint, format bằng Oxfmt. Chạy trên Ubuntu/WSL2; xem [quyết định kỹ thuật](SPEC.md#17-baseline-kỹ-thuật).

## Agent sử dụng Cuesura

[Gói skill `cusr`](skills/cusr/SKILL.md) hướng dẫn lệnh và điều kiện sử dụng CLI `cusr`.
Cài toàn bộ `skills/cusr` vào thư mục skill cá nhân của **assistant caller** (Codex hoặc Claude Code),
ngoài repo mà Cuesura giao cho worker. Không commit skill điều khiển này vào repo đích hoặc cấp token
điều khiển cho worker; worker không được dùng skill kể cả khi vô tình đọc thấy nó.
Gói chỉ gồm file thường, không cần symlink hay source/spec của Cuesura. CLI đã cài và thông tin kết nối
được người vận hành cung cấp riêng; agent dùng token `read/operate`, người dùng tự xác nhận run/approve.

Repo này cũng tự phát triển bằng Cuesura: xem [quy trình dogfood](docs/dogfooding.md).

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

Khi đang phát triển, `pnpm test:changed` chỉ chạy các test phụ thuộc vào file đã đổi so với `origin/main`; `pnpm test` đầy đủ do CI chạy cho mọi PR.

Các phép đo thời gian thực chạy riêng để không kéo dài lượt test thường. Trước khi merge PR chạm TUI hoặc cấu hình, và trước mỗi release, chạy:

```bash
pnpm test:performance
```

Lệnh này giữ phép đo median cấu hình 500 dòng, màn hình 100 task, 20 mẫu cập nhật trạng thái và phiên idle 30 giây; chạy từng file tuần tự.

Nhóm reliability chạy riêng vì tốn thời gian (10.000 chuỗi tín hiệu qua kho in-memory, 200 lần `SIGKILL` trên file SQLite thật). Khi fail, output in `seed`; truyền lại để tái hiện:

```bash
pnpm test:reliability
pnpm test:reliability --seed <seed>
```

Báo cáo bất biến I01–I12 dựng từ kết quả của lần `pnpm test` và `pnpm test:reliability` gần nhất; thoát lỗi khi thiếu kết quả hoặc có bộ bị skip/fail:

```bash
pnpm report:invariants
```
