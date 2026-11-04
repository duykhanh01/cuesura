# Quy tắc cho agent

Áp dụng cho mọi agent làm việc trong repo này (Claude Code, Codex, …). `CLAUDE.md` trỏ về file này.

**Worker do Cuesura khởi chạy:** làm theo prompt role và bỏ qua các mục worktree, commit, push và PR dưới đây; daemon
lo những việc đó. Không gọi `cusr`.

**Assistant làm việc tương tác:** quy trình dùng `cusr` để phát triển repo này ở
[docs/dogfooding.md](docs/dogfooding.md). Vướng mắc khi dùng `cusr` phải ghi thành issue theo mục "Vòng tự cải thiện".

## Comment trong code

Áp dụng cho cả worker do Cuesura khởi chạy.

- Chỉ comment khi cần thiết: lý do, ràng buộc hoặc hành vi mà đọc code không thấy. Không comment lặp lại điều code đã nói.
- Comment viết bằng tiếng Anh.

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
    và tính nhất quán; rà thủ công heading, bảng và code fence Markdown. `.oxfmtrc.jsonc` bỏ qua
    Markdown nên `pnpm format:check`/Oxfmt không phải bằng chứng định dạng tài liệu. Không chạy
    `pnpm typecheck`, `pnpm lint`, `pnpm test` hoặc `pnpm build` chỉ vì tài liệu thay đổi.
    CI cũng bỏ qua `build` và `test` khi PR chỉ đổi file Markdown ngoài `src/` và `test/`.
  - Có sửa code, test hoặc cấu hình thực thi: `pnpm typecheck`, `pnpm lint`, `pnpm format:check` và `pnpm test:changed` phải
    sạch; chạy thêm các kiểm tra bắt buộc theo phạm vi thay đổi và hướng dẫn của repo. `pnpm lint` chạy
    ESLint, `pnpm format:check` chạy `oxfmt --check`; sửa định dạng bằng `pnpm format`.
  - `pnpm test:changed` chỉ chạy các test phụ thuộc vào file đã đổi so với `origin/main` (gồm cả thay
    đổi chưa commit); khi đang sửa, chạy trực tiếp file test liên quan bằng `pnpm vitest run <file>`.
    Không chạy `pnpm test` đầy đủ trên máy: CI chạy nó cho mọi PR. Test đầy đủ của CI phải xanh trước
    khi người dùng merge; CI đỏ thì sửa và push lại, test hỏng có sẵn trên `main` thì ghi vào PR.
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
