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
- Kiểm tra phù hợp với thay đổi:
  - Chỉ sửa tài liệu: chạy `git diff --check` cho diff đang sửa và diff của PR, kiểm tra liên kết nội bộ
    và tính nhất quán; rà thủ công heading, bảng và code fence Markdown. `.prettierignore` bỏ qua
    Markdown nên `pnpm lint`/Prettier không phải bằng chứng định dạng tài liệu. Không chạy
    `pnpm typecheck`, `pnpm lint`, `pnpm test` hoặc `pnpm build` chỉ vì tài liệu thay đổi.
  - Có sửa code, test hoặc cấu hình thực thi: `pnpm typecheck`, `pnpm lint`, `pnpm test` phải sạch;
    chạy thêm các kiểm tra bắt buộc theo phạm vi thay đổi và hướng dẫn của repo.
- PR sửa quy tắc kiểm tra vẫn áp dụng quy tắc đã có trên `main` cho đến khi merge, trừ chỉ dẫn trực
  tiếp của người dùng; không tự dùng quy tắc mới trong PR để miễn kiểm tra cho chính PR đó.
- Làm xong: commit, push nhánh và tạo PR vào `main`. Agent không tự merge PR; người dùng merge.
- Sau khi PR được merge: `git worktree remove ../metronome.worktrees/<nhánh>` và xóa nhánh local.

## Dọn worktree rác

Trước khi tạo worktree mới và khi kết thúc một việc, chạy `git fetch origin --prune` rồi
`git worktree list`, và dọn những worktree không còn dùng:

- **Được dọn ngay**: worktree sạch (`git status --porcelain` rỗng) mà nhánh đã merge vào `origin/main`,
  hoặc chưa có commit nào ngoài `origin/main` (`git rev-list --count origin/main..<nhánh>` bằng 0).
  Dọn bằng `git worktree remove <đường dẫn>` rồi `git branch -d <nhánh>`.
- **Thư mục đã mất**: `git worktree prune` để xoá bản ghi worktree trỏ tới thư mục không còn tồn tại.
- **Không tự dọn, hỏi người dùng trước**: worktree còn thay đổi chưa commit, còn commit chưa push hoặc
  chưa merge, hoặc không do agent tạo. Không dùng `--force` cho `git worktree remove` hay `git branch -D`
  khi chưa được đồng ý.
- Không bao giờ dọn worktree chính của repo.
