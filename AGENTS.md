# Quy tắc cho agent

Áp dụng cho mọi agent làm việc trong repo này (Claude Code, Codex, …). `CLAUDE.md` trỏ về file này.

## Làm việc trên worktree riêng, xong thì tạo PR

- Mọi thay đổi (code, test, tài liệu) làm trên một git worktree riêng, tạo từ `origin/main` mới nhất.
  Không sửa trực tiếp trên `main` và không làm trên worktree chính của repo.

  ```sh
  git fetch origin
  git worktree add ../metronome.worktrees/<nhánh> -b <nhánh> origin/main
  cd ../metronome.worktrees/<nhánh> && pnpm install
  ```

- Tên nhánh theo phạm vi việc: `<feature>/<mô tả>` (vd `002/preflight`), `fix/<mô tả>`, `docs/<mô tả>`.
- Việc cần code của một PR chưa merge: hỏi người dùng trước, không tự tạo nhánh từ nhánh chưa merge.
- Làm xong: `pnpm typecheck`, `pnpm lint`, `pnpm test` phải sạch; commit, push nhánh và tạo PR vào
  `main`. Agent không tự merge PR; người dùng merge.
- Sau khi PR được merge: `git worktree remove ../metronome.worktrees/<nhánh>` và xóa nhánh local.
